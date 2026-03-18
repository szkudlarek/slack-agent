import express from "express";
import { WebClient } from "@slack/web-api";
import Anthropic from "@anthropic-ai/sdk";
import crypto from "crypto";

const app = express();
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MY_SLACK_USER_ID = process.env.MY_SLACK_USER_ID;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;

// ── Verify requests are genuinely from Slack ─────────────────────────────────
function verifySlack(req) {
  const ts = req.headers["x-slack-request-timestamp"];
  const sig = req.headers["x-slack-signature"];
  if (Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const base = `v0:${ts}:${JSON.stringify(req.body)}`;
  const hash = "v0=" + crypto.createHmac("sha256", SLACK_SIGNING_SECRET).update(base).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(sig));
}

// ── Draft a reply with Claude ────────────────────────────────────────────────
async function draftReply(text, user, channel) {
  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 300,
    messages: [{
      role: "user",
      content: `You are helping me draft a reply to a Slack message where I was mentioned.

Channel ID: ${channel}
From user ID: ${user}
Message: "${text}"

Write a concise, professional reply I could send back. Keep it 1–3 sentences.
Reply with just the reply text — no preamble.`
    }]
  });
  return msg.content[0].text.trim();
}

// ── DM me the draft ──────────────────────────────────────────────────────────
async function dmDraft(event, draft) {
  await slack.chat.postMessage({
    channel: MY_SLACK_USER_ID,
    text: `📬 New mention from <@${event.user}>`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `📬 *New mention* from <@${event.user}> in <#${event.channel}>\n\n*They said:*\n> ${event.text}`
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*✏️ Draft reply:*\n\`\`\`${draft}\`\`\``
        }
      },
      {
        type: "context",
        elements: [{
          type: "mrkdwn",
          text: "Copy the draft, edit if needed, then reply in the original thread."
        }]
      }
    ]
  });
}

// ── Raw body needed for Slack signature verification ─────────────────────────
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));

// ── Main webhook endpoint ────────────────────────────────────────────────────
app.post("/slack/events", async (req, res) => {
  const body = req.body;

  // Slack sends a one-time URL verification challenge
  if (body.type === "url_verification") {
    return res.json({ challenge: body.challenge });
  }

  // Verify the request came from Slack
  if (!verifySlack(req)) {
    return res.status(401).send("Unauthorized");
  }

  res.sendStatus(200); // always ack immediately

  const event = body.event;
  if (event?.type === "app_mention") {
    try {
      console.log(`Mention from ${event.user}: "${event.text}"`);
      const draft = await draftReply(event.text, event.user, event.channel);
      await dmDraft(event, draft);
      console.log("Draft sent via DM ✓");
    } catch (err) {
      console.error("Error handling mention:", err.message);
    }
  }
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/", (_req, res) => res.send("Slack mention agent is running ✓"));

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));

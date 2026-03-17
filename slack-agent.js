import express from "express";
import { WebClient } from "@slack/web-api";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
app.use(express.json());

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MY_SLACK_USER_ID = process.env.MY_SLACK_USER_ID; // e.g. "U012AB3CD"
const POLL_INTERVAL_MS = 60_000; // check every 60 seconds

// Remember the last timestamp we processed so we don't re-process mentions
let lastChecked = (Date.now() / 1000).toFixed(6);

// ── Core: fetch new mentions ────────────────────────────────────────────────
async function fetchNewMentions() {
  const res = await slack.search.messages({
    query: `<@${MY_SLACK_USER_ID}>`,
    sort: "timestamp",
    sort_dir: "desc",
    count: 10,
  });

  const messages = res.messages?.matches ?? [];
  return messages.filter((m) => parseFloat(m.ts) > parseFloat(lastChecked));
}

// ── Core: draft a reply with Claude ─────────────────────────────────────────
async function draftReply(mention) {
  const prompt = `You are helping me (a professional) draft a reply to a Slack message where I was mentioned.

Channel: #${mention.channel?.name ?? "unknown"}
From: ${mention.username ?? "someone"}
Message: "${mention.text}"

Write a concise, professional reply I could send. Keep it 1–3 sentences. 
Don't include any preamble like "Here's a draft:" — just the reply text itself.`;

  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 300,
    messages: [{ role: "user", content: prompt }],
  });

  return msg.content[0].text.trim();
}

// ── Core: DM me the draft ────────────────────────────────────────────────────
async function dmDraft(mention, draft) {
  const channelLink = mention.permalink
    ? `<${mention.permalink}|View message>`
    : `in #${mention.channel?.name ?? "unknown"}`;

  await slack.chat.postMessage({
    channel: MY_SLACK_USER_ID, // DM to yourself
    text: `📬 *New mention* ${channelLink}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `📬 *New mention* ${channelLink}\n\n*They said:*\n> ${mention.text}`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*✏️ Draft reply:*\n\`\`\`${draft}\`\`\``,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Copy the draft above, edit if needed, then reply in the original thread.`,
          },
        ],
      },
    ],
  });
}

// ── Polling loop ─────────────────────────────────────────────────────────────
async function poll() {
  try {
    console.log(`[${new Date().toISOString()}] Checking for new mentions...`);
    const mentions = await fetchNewMentions();

    if (mentions.length === 0) {
      console.log("  No new mentions.");
    }

    for (const mention of mentions) {
      console.log(`  New mention from ${mention.username}: "${mention.text.slice(0, 60)}..."`);
      const draft = await draftReply(mention);
      await dmDraft(mention, draft);
      console.log("  Draft sent via DM ✓");
      // Advance the cursor so we don't re-process this one
      if (parseFloat(mention.ts) > parseFloat(lastChecked)) {
        lastChecked = mention.ts;
      }
    }
  } catch (err) {
    console.error("Poll error:", err.message);
  }
}

// ── Health check endpoint (required by Render/Railway) ───────────────────────
app.get("/", (_req, res) => res.send("Slack mention agent is running ✓"));

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  poll(); // run immediately on start
  setInterval(poll, POLL_INTERVAL_MS);
});

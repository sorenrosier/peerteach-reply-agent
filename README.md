# PeerTeach Reply Agent

AI-powered cold email reply agent for PeerTeach. Receives Instantly.ai webhooks, classifies prospect replies with Claude, and routes them: auto-handles soft/hard nos and OOO, posts human-in-the-loop drafts to Slack for interested replies, and escalates anything ambiguous.

## Architecture

- `api/webhook.ts` — Instantly webhook receiver (`POST /api/webhook`)
- `api/slack-action.ts` — Slack interactive button handler (`POST /api/slack-action`)
- `src/classifier.ts` — Claude-powered classifier (`claude-sonnet-4-20250514`)
- `src/replyGenerator.ts` — Claude-powered reply writer
- `src/router.ts` — Routing logic
- `src/instantly.ts` — Instantly v2 API client (with retries)
- `src/slack.ts` — Slack Block Kit notifications + interactive actions
- `src/ghl.ts` — GoHighLevel client (DORMANT, gated by `AUTO_BOOK_ENABLED`)

## Setup

### 1. Install

```bash
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in:

- `INSTANTLY_API_KEY` — from Instantly settings → integrations
- `ANTHROPIC_API_KEY` — from console.anthropic.com
- `SLACK_BOT_TOKEN` — `xoxb-...` token from your Slack app, with `chat:write` scope
- `SLACK_SIGNING_SECRET` — Slack app "Basic Information" page
- `SLACK_CHANNEL_ID` — channel ID where escalations/approvals get posted (right-click channel → View channel details)
- `WEBHOOK_SECRET` — optional shared secret. If set, Instantly must include header `x-webhook-secret: <value>`
- `AUTO_BOOK_ENABLED` — leave as `false` until ready to enable GHL auto-booking

### 3. Deploy to Vercel

```bash
npm install -g vercel
vercel
```

Set the same environment variables in Vercel's project settings (Settings → Environment Variables). Redeploy after adding them.

### 4. Configure Instantly webhook

In Instantly: Settings → Integrations → Webhooks. Add a webhook:
- URL: `https://YOUR-DEPLOYMENT.vercel.app/api/webhook`
- Event: `reply_received` (and optionally `auto_reply_received` — they are silently skipped)
- If you set `WEBHOOK_SECRET`, configure Instantly to send the header `x-webhook-secret`

### 5. Configure Slack app

Create a Slack app at https://api.slack.com/apps:
1. **OAuth & Permissions** → add scope `chat:write`. Install to workspace; copy the Bot Token (`xoxb-...`) into `SLACK_BOT_TOKEN`.
2. **Basic Information** → copy the Signing Secret into `SLACK_SIGNING_SECRET`.
3. **Interactivity & Shortcuts** → enable interactivity. Set Request URL to `https://YOUR-DEPLOYMENT.vercel.app/api/slack-action`.
4. (Optional) **Incoming Webhooks** → create one and put it in `SLACK_WEBHOOK_URL` as a fallback if `chat.postMessage` ever fails.
5. Invite the bot user to your `SLACK_CHANNEL_ID` channel.

### 6. Smoke test

```bash
# locally with env vars exported
npx ts-node scripts/testWebhook.ts scheduling
npx ts-node scripts/testWebhook.ts soft_no
npx ts-node scripts/testWebhook.ts hard_no
npx ts-node scripts/testWebhook.ts escalate
```

Or POST a sample to your deployed webhook:

```bash
curl -X POST https://YOUR-DEPLOYMENT.vercel.app/api/webhook \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: YOUR_SECRET" \
  -d @sample-payload.json
```

## Routing logic

| Classification | Action |
|---|---|
| `OOO` | Log only — Instantly handles natively |
| `HARD_NO` | Mark `not_interested` in Instantly + Slack notification |
| `SOFT_NO` | Mark `not_interested` + auto-send polite farewell + Slack log |
| `ESCALATE` | Slack alert with full context — no auto-action |
| `SCHEDULING`, `SOFT_YES`, `REFERRED`, `WRONG_PERSON` | Generate draft reply, post to Slack with Send/Edit/Skip buttons |

If `AUTO_BOOK_ENABLED=true` and classification is `SCHEDULING`, the dormant GHL branch attempts to auto-book a Zoom and reply with the booked time. On any failure, escalates to human.

## Enabling auto-booking (later)

When ready to ship auto-booking:

1. Set GHL env vars: `GHL_API_KEY`, `GHL_CALENDAR_ID`, `GHL_LOCATION_ID`
2. Set `AUTO_BOOK_ENABLED=true` in Vercel
3. Redeploy

The GHL flow:
1. Reads proposed times from classifier
2. Fetches free slots from GHL calendar (next 7 days)
3. Picks the slot closest to a proposed time, or first available
4. Upserts contact, books appointment (Zoom), sends confirmation reply
5. Marks lead as interested in Instantly
6. Posts confirmation to Slack

## Operational notes

- All Instantly calls retry on 429/5xx with exponential backoff (3 attempts).
- All errors are caught and surfaced to Slack with the prospect's Unibox link, so a human always has a path forward.
- Classifier confidence < 0.6 → automatic escalation.
- Slack signature verification rejects requests >5 minutes old (replay protection).
- Slack action `value` JSON is truncated to fit the 2000-char limit if drafts run long.
- Reply generator strips em dashes defensively (voice rule).

## TypeScript

```bash
npm run typecheck
```

Strict mode is on.

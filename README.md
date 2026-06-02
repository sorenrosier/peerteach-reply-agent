# PeerTeach Reply Agent

An AI agent that reads cold email replies from school administrators, understands the full conversation, and drafts responses for human approval before anything is sent. When a prospect wants to schedule a meeting, it checks real calendar availability and can book directly into Calendly.

**Nothing sends without a human clicking "Send" in Slack first.**

---

## What it does

1. A prospect replies to a cold email in Instantly
2. Instantly fires a webhook to this system
3. The agent fetches the full email thread, reads all context, and decides what to do
4. For scheduling: checks real Calendly availability, proposes two specific times (or books directly if the prospect confirmed a time)
5. A draft reply is posted to Slack with **Send / Edit & Send / Skip** buttons
6. A human reviews and clicks Send — only then does the reply go out

---

## How the agent thinks

The agent uses Claude (claude-sonnet-4-6) with tool use. It reads the full email thread and can call:

- **`get_available_times`** — hits Calendly to fetch open slots for any date range
- **`book_meeting`** — creates a Calendly booking when the prospect confirms a time
- **`no_reply`** — signals no response is needed (OOO, "Thanks!", post-booking acknowledgments)
- **`hard_no`** — signals the prospect asked to unsubscribe
- **`escalate`** — signals a human needs to handle it (referrals with direct emails, legal language, etc.)

The agent reasons dynamically. If a prospect says "2 weeks from now," it fetches availability for that window. If they confirm a specific time, it books it. It handles multi-turn conversations by reading the entire thread on every reply.

---

## Routing logic

| What the prospect said | What happens |
|---|---|
| "Yes, happy to chat" / "When are you free?" | Fetch real slots, draft reply with 2 specific times, post to Slack for approval |
| "Thursday at 2pm works for me" | Check if available, book it, draft confirmation, post to Slack for approval |
| "Thanks!" after booking | No reply sent — conversation is done |
| "Not interested" / "Too busy this year" | Draft a warm farewell, post to Slack for approval |
| "Remove me" / "Unsubscribe" | Slack notification — no reply drafted |
| OOO auto-reply | Ignored silently |
| Wrong person | Draft asking who handles curriculum, post to Slack for approval |
| Referred to someone (name only) | Draft asking for their email, post to Slack for approval |
| Referred with direct email given | Escalate to Slack — human makes the intro |
| Angry / legal / too complex | Escalate to Slack — human handles it |

---

## Prerequisites

You need accounts on all of these (all have free tiers):

- [Instantly.ai](https://instantly.ai) — your cold email platform
- [Anthropic](https://console.anthropic.com) — Claude API
- [Slack](https://slack.com) — where approvals happen
- [Calendly](https://calendly.com) — calendar and booking
- [Vercel](https://vercel.com) — hosting (free hobby tier works)
- [Node.js](https://nodejs.org) 18+ and npm — for local development
- [Git](https://git-scm.com) — for version control

---

## Setup — step by step

### Step 1: Clone and install

```bash
git clone https://github.com/LohithD/peerteach-reply-agent.git
cd peerteach-reply-agent
npm install
```

### Step 2: Create your `.env` file

```bash
cp .env.example .env
```

Open `.env` and fill in each value. Instructions for each key are below.

---

### Step 3: Instantly API key

1. Go to [app.instantly.ai](https://app.instantly.ai) → Settings → Integrations → API
2. Click **Generate API Key**
3. Copy it into `.env` as `INSTANTLY_API_KEY`

---

### Step 4: Anthropic API key

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Click **API Keys** → **Create Key**
3. Copy it into `.env` as `ANTHROPIC_API_KEY`

---

### Step 5: Slack app setup

You need to create a Slack app that can post messages and receive button clicks.

**Create the app:**
1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. Name it (e.g. "PeerTeach Agent") and pick your workspace

**Add permissions:**
1. In the left sidebar → **OAuth & Permissions**
2. Under **Bot Token Scopes**, click **Add an OAuth Scope** and add: `chat:write`
3. Scroll up and click **Install to Workspace** → Allow
4. Copy the **Bot User OAuth Token** (starts with `xoxb-`) → paste as `SLACK_BOT_TOKEN`

**Get the signing secret:**
1. In the left sidebar → **Basic Information**
2. Under **App Credentials**, copy **Signing Secret** → paste as `SLACK_SIGNING_SECRET`

**Get the channel ID:**
1. In Slack, right-click the channel where you want notifications → **View channel details**
2. Scroll to the bottom — you'll see the Channel ID (e.g. `C0123456789`) → paste as `SLACK_CHANNEL_ID`
3. Invite the bot to that channel: type `/invite @PeerTeach Agent` in the channel

**Interactivity (for the Send/Skip buttons):**

You'll set this up after deploying to Vercel (Step 8).

---

### Step 6: Calendly setup

**Get your API key:**
1. Go to [calendly.com/integrations/api_webhooks](https://calendly.com/integrations/api_webhooks)
2. Click **Generate New Token** — copy it as `CALENDLY_API_KEY`

**Get your event type URI:**

This is the specific meeting type prospects will be booked into (e.g. your 30-min intro call).

1. Deploy to Vercel first (Step 7)
2. After deploying, visit: `https://your-deployment.vercel.app/api/test-autobook`
3. It will return a list of your event types with their URIs
4. Copy the URI for the right event type (e.g. `https://api.calendly.com/event_types/XXXXXXXX`)
5. Paste it as `CALENDLY_EVENT_TYPE_URI`

**Get your Zoom link:**

1. Open the Calendly event type you're using
2. In the **Location** settings, copy the Zoom URL (e.g. `https://us06web.zoom.us/j/...`)
3. Paste it as `CALENDLY_LOCATION_URL`

---

### Step 7: Deploy to Vercel

**Install Vercel CLI:**
```bash
npm install -g vercel
```

**Deploy:**
```bash
vercel
```

Follow the prompts. When asked about settings, the defaults work. This creates your deployment URL (e.g. `https://peerteach-reply-agent.vercel.app`).

**Add environment variables:**

In the Vercel dashboard → your project → **Settings** → **Environment Variables**, add all keys from your `.env` file. Or use the CLI:

```bash
vercel env add INSTANTLY_API_KEY production
vercel env add ANTHROPIC_API_KEY production
vercel env add SLACK_BOT_TOKEN production
vercel env add SLACK_SIGNING_SECRET production
vercel env add SLACK_CHANNEL_ID production
vercel env add CALENDLY_API_KEY production
vercel env add CALENDLY_EVENT_TYPE_URI production
vercel env add CALENDLY_LOCATION_URL production
```

**Redeploy after adding env vars:**
```bash
vercel --prod
```

---

### Step 8: Configure Slack interactivity

Now that you have a deployment URL, go back to your Slack app:

1. [api.slack.com/apps](https://api.slack.com/apps) → your app → **Interactivity & Shortcuts**
2. Toggle **Interactivity** on
3. Set **Request URL** to: `https://your-deployment.vercel.app/api/slack-action`
4. Save

---

### Step 9: Configure Instantly webhook

1. In Instantly → **Settings** → **Integrations** → **Webhooks**
2. Click **Add Webhook**
3. Set the URL to: `https://your-deployment.vercel.app/api/webhook`
4. Select event: `reply_received`
5. Save

---

### Step 10: Test it

**Verify Calendly is working:**
```
GET https://your-deployment.vercel.app/api/test-autobook
```
Open that URL in your browser. If it returns `"ok": true` with a booking object, Calendly is fully wired up. You'll see a test appointment in your Calendly — safe to delete.

**Send a test webhook:**
```bash
curl -X POST https://your-deployment.vercel.app/api/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "event_type": "reply_received",
    "email_id": "test-123",
    "lead_email": "test@school.edu",
    "email_account": "katie@peerteach.com",
    "campaign_id": "test",
    "campaign_name": "Test Campaign",
    "reply_subject": "Re: PeerTeach",
    "reply_text": "Yes happy to chat! When are you free?",
    "email_text": "Hi, I wanted to share PeerTeach with you...",
    "unibox_url": "https://app.instantly.ai/app/inbox",
    "firstName": "Jane",
    "lastName": "Smith",
    "Role": "Principal",
    "School": "Lincoln Elementary, Brooklyn NY"
  }'
```

You should see a Slack notification within ~10 seconds with a draft reply and real Calendly time slots.

---

## Pausing and unpausing

To pause the system (all webhooks silently ignored, no errors):

```bash
vercel env add PAUSED production  # enter "true" when prompted
vercel --prod
```

To unpause:

```bash
vercel env rm PAUSED production --yes
vercel --prod
```

---

## Running tests locally

Tests use real Claude API calls but mock Calendly — no bookings created:

```bash
npx ts-node scripts/testScenarios.ts
```

Results are written to `scripts/test-results.md`. Covers 15 scenarios including scheduling, booking, soft no, wrong person, referrals, timezones, and multi-turn conversations.

---

## Checking logs

Vercel keeps logs for 1 hour on the free plan.

1. Go to [vercel.com](https://vercel.com) → your project → **Logs**
2. Click **Reset Filters** if nothing shows
3. Look for lines like `[agent]`, `[router]`, `[calendly]` to trace what happened

Every webhook invocation logs:
- What the agent decided
- Which tools it called and with what parameters
- How many Calendly slots were found
- Whether a booking was created

---

## Modifying the agent behavior

All agent behavior is controlled in `src/agent.ts`:

- **System prompt** — in `buildSystemPrompt()`. Edit here to change tone, voice rules, what to do in specific situations, product knowledge.
- **Tool definitions** — the `TOOLS` array. Add new tools here if you want the agent to do new things (e.g. update a CRM, send a follow-up sequence).
- **Sender identity** — in `getSenderIdentity()`. Add new senders by checking `email_account`.
- **Max iterations** — `MAX_ITERATIONS = 6`. This is how many back-and-forth Claude API calls can happen per webhook. 6 is enough for the most complex booking flows.

---

## File structure

```
api/
  webhook.ts          Entry point — receives Instantly webhooks
  slack-action.ts     Handles Slack button clicks (Send/Edit/Skip)
  test-autobook.ts    Test endpoint for Calendly integration

src/
  agent.ts            The AI agent — Claude tool-use loop, system prompt, tools
  calendly.ts         Calendly API client (get slots, book meetings, list event types)
  instantly.ts        Instantly API client (reply to email, fetch thread, mark leads)
  slack.ts            Slack Block Kit notifications and interactive messages
  router.ts           Routes agent results to the right Slack notification
  env.ts              Environment variable validation
  types.ts            TypeScript types shared across the codebase

scripts/
  testScenarios.ts    15-scenario test suite (mocked Calendly, real Claude)
  test-results.md     Output from the last test run
```

---

## Environment variables reference

| Variable | Required | Where to get it |
|---|---|---|
| `INSTANTLY_API_KEY` | Yes | Instantly → Settings → Integrations → API |
| `ANTHROPIC_API_KEY` | Yes | console.anthropic.com → API Keys |
| `SLACK_BOT_TOKEN` | Yes | api.slack.com → your app → OAuth & Permissions |
| `SLACK_SIGNING_SECRET` | Yes | api.slack.com → your app → Basic Information |
| `SLACK_CHANNEL_ID` | Yes | Right-click channel in Slack → View channel details |
| `CALENDLY_API_KEY` | Yes | calendly.com/integrations/api_webhooks |
| `CALENDLY_EVENT_TYPE_URI` | Yes | Visit `/api/test-autobook` after deploying |
| `CALENDLY_LOCATION_URL` | Yes | Your Calendly event type → Location → copy Zoom URL |
| `SLACK_WEBHOOK_URL` | No | Fallback if Bot Token fails. Slack app → Incoming Webhooks |
| `WEBHOOK_SECRET` | No | Any string. If set, Instantly must send it as `x-webhook-secret` header |
| `PAUSED` | No | Set to `true` to stop all processing without taking down the deployment |

---

## How the Slack approval flow works

When a draft is ready, you'll see a message in Slack like this:

```
📝 Draft reply — needs approval
Jane Smith — Principal @ Lincoln Elementary
jane@school.edu · Campaign: Spring 2026 Outreach

Draft reply (from katie@peerteach.com):
> Hi Jane,
> Next week works great! Here are a couple of options:
> - Monday, June 8 at 1:00 PM CDT
> - Tuesday, June 9 at 1:00 PM CDT
> Do either of those work for you?
> -Katie.

Their reply:
> "Sure, happy to chat. Can we do next week?"

[✅ Send Reply]  [✏️ Edit & Send]  [❌ Skip]  [Open in Unibox]
```

- **Send Reply** — sends exactly as drafted via Instantly
- **Edit & Send** — opens Unibox so you can edit manually before sending
- **Skip** — dismisses without sending anything

---

## Troubleshooting

**Nothing appears in Slack after a reply comes in:**
- Check Vercel Logs immediately (they expire in 1 hour)
- Verify the webhook URL in Instantly matches your deployment URL
- Make sure `PAUSED` is not set to `true`

**"Send Reply" button does nothing / spins:**
- Check the Interactivity URL in your Slack app settings
- Make sure it points to `/api/slack-action` on your current deployment URL
- Check Vercel Logs for `[slack-action]` errors

**Calendly booking fails:**
- Visit `/api/test-autobook` in your browser to diagnose
- Verify `CALENDLY_EVENT_TYPE_URI` matches an active event type
- Verify `CALENDLY_LOCATION_URL` matches the location configured on that event type

**Agent proposes wrong timezone:**
- The agent infers timezone from the school name/location in the Instantly lead data
- Make sure your Instantly leads have accurate school/district names with state info

**Draft is too long or sounds off:**
- Edit the system prompt in `src/agent.ts` → `buildSystemPrompt()`
- Re-run `npx ts-node scripts/testScenarios.ts` to verify changes before deploying

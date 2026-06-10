# Handoff prompt

Paste everything in the code block below into **Claude Code** (CLI or the editor extension) on the new owner's machine. It will fork the repo, set it up locally, deploy it to the new owner's own Vercel account, push every environment variable, and walk through the few steps that have to be done by hand.

Before you start, have these ready:
- A **GitHub** account (with `gh` CLI, or Claude will install it)
- A **Vercel** account (free)
- The new owner's **own Anthropic API key** (from console.anthropic.com → API Keys)
- The **7 shared values** from the current owner: `INSTANTLY_API_KEY`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_CHANNEL_ID`, `CALENDLY_API_KEY`, `CALENDLY_EVENT_TYPE_URI`, `CALENDLY_LOCATION_URL`

---

````text
You are setting me up as the new owner of an existing project called the PeerTeach Reply Agent. It is a TypeScript app that deploys as serverless functions on Vercel. The source lives at the public GitHub repo `LohithD/peerteach-reply-agent`. Your job is to get a fully working copy running on MY own GitHub + Vercel + Anthropic key, reusing the existing (shared) Slack, Calendly, and Instantly credentials I will provide.

Work through these steps in order. Before any step that needs a secret or an interactive login, stop and ask me for it — do not invent values. Tell me clearly at the end which manual dashboard steps remain.

PREP — check tooling
1. Check that `git`, `node` (v18+), `npm`, `gh` (GitHub CLI), and `vercel` are installed. Install whatever is missing (`gh` via the official instructions for my OS; `vercel` via `npm i -g vercel`).
2. Run `gh auth status`. If I'm not logged in, run `gh auth login` and wait for me to finish the browser flow.

FORK + LOCAL SETUP
3. Fork the repo to my account and clone it: `gh repo fork LohithD/peerteach-reply-agent --clone=true`, then `cd peerteach-reply-agent`.
4. Run `npm install`.
5. Run `cp .env.example .env`.
6. Ask me for these 8 values one message at a time (or as a block), then write them into `.env` (this file is gitignored — never commit it):
   - ANTHROPIC_API_KEY        (MY own key)
   - INSTANTLY_API_KEY        (shared — from previous owner)
   - SLACK_BOT_TOKEN          (shared)
   - SLACK_SIGNING_SECRET     (shared)
   - SLACK_CHANNEL_ID         (shared)
   - CALENDLY_API_KEY         (shared)
   - CALENDLY_EVENT_TYPE_URI  (shared)
   - CALENDLY_LOCATION_URL    (shared)
7. Verify the build compiles: `npx tsc --noEmit`. Then run the two offline tests (no API cost): `npx ts-node scripts/verifyNaturalTime.ts` and `npx ts-node scripts/verifyGuests.ts`. Both should report all passing.

DEPLOY TO VERCEL
8. Run `vercel login` and wait for me to complete the browser auth.
9. Link/create a Vercel project for this repo: `vercel link` (accept creating a new project; default settings are fine).
10. Push every variable from my `.env` into Vercel's Production environment. For each line in `.env`, run: `printf '%s' "<value>" | vercel env add <NAME> production`. Do all 8.
11. Deploy: `vercel --prod`. Capture the resulting production URL (looks like `https://<something>.vercel.app`) and show it to me.
12. Confirm Calendly works on the new deployment by asking me to open `https://<my-deployment>.vercel.app/api/test-autobook` in a browser — it should return `"ok": true`. (It creates one test booking I can delete.)

MANUAL CUTOVER — these have no API; give me exact click-by-click instructions and then stop
13. Tell me to update the **Slack** app's interactivity URL:
    - Go to api.slack.com/apps → open the PeerTeach app → Interactivity & Shortcuts → set Request URL to `https://<my-deployment>.vercel.app/api/slack-action` → Save Changes.
14. Tell me to update the **Instantly** webhook:
    - Instantly → Settings → Integrations → Webhooks → change the existing webhook URL to `https://<my-deployment>.vercel.app/api/webhook` (event: `reply_received`) → Save.
15. Warn me clearly: steps 13 and 14 switch the LIVE system from the previous owner's deployment to mine, so I should coordinate timing with the previous owner. Once both URLs point to my deployment, all new replies run on my Anthropic key.

VERIFY
16. Give me a `curl` command to send a test `reply_received` webhook to my deployment (use the example payload from the repo README's "Send a test webhook" section, pointed at my URL). A draft should appear in the shared Slack channel within ~10 seconds.
17. Summarize: my GitHub fork URL, my Vercel production URL, which env vars are set, and a checklist of anything still pending.

Notes:
- Nothing sends to a prospect without a human clicking "Send" in Slack — this is safe to test.
- The README in the repo has full detail on every key and the architecture if you need it.
- If `gh repo fork` says the fork already exists, just clone my existing fork instead.
````

---

## What this does and doesn't automate

**Automated by Claude Code:** installing tooling, forking, cloning, `npm install`, writing `.env`, type-check + offline tests, linking the Vercel project, pushing all 8 environment variables, deploying to production.

**Still needs a human (no scriptable API):**
- Completing the `gh auth login` and `vercel login` browser prompts
- Changing the **Slack** interactivity Request URL (Slack dashboard)
- Changing the **Instantly** webhook URL (Instantly dashboard)

Those last two are the actual cutover — once they point at the new deployment, the live system runs on the new owner's infrastructure and Anthropic key.

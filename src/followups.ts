import { hasRealBookingForLead } from './googleCalendar';
import Anthropic from '@anthropic-ai/sdk';
import { env } from './env';
import { listLeadEmails, findLeadByEmailAnyCampaign, replyToEmail, listRecentEmails, isAgentSendAt, setLeadVariablesById, RecentEmail } from './instantly';
import { getSenderIdentity } from './agent';
import { CALENDLY_SCHEDULING_URL, isAutoSendEnabled } from './env';
import { postProactiveApproval, postInfoNote, replySubject } from './slack';
import { renderLinks } from './linkFormat';
import { isTeacherPersona } from './teacherAgent';

// When a follow-up is due, counted from when we sent the Calendly link:
//  - 24 hours when the lead said nothing about timing;
//  - 3 days when they said they would be back in touch but gave no date ("I'll discuss it with my
//    team", "will get back to you");
//  - the day after the date they named ("sharing it at a meeting tomorrow" -> the day after that).
// A date is never waited on past MAX_WAIT_DAYS.
const FOLLOWUP_AFTER_HOURS = 24;
const OPEN_ENDED_AFTER_HOURS = 72;
const MAX_WAIT_DAYS = 7;
const FOLLOWUP_WINDOW_END_HOURS = (MAX_WAIT_DAYS + 1) * 24;
// 16:00 UTC is 11am Eastern / 8am Pacific: a normal working hour across the US.
const DUE_HOUR_UTC = 16;
// A follow-up that is more than this long past due is dropped rather than sent late (a nudge that
// arrives days after the moment it was meant for reads as tone-deaf).
const GRACE_HOURS = 48;
// Instantly allows about 20 requests a minute across everything (the live reply agent shares it), so
// candidates are checked one at a time with a pause, and a run stops early rather than overrun its
// time limit (the rest are picked up the next hour).
const PACE_MS = 2500;
const RUN_BUDGET_MS = 100_000;
// The decision for one Calendly email, kept on the lead so the language model is asked once:
// "<offer epoch>:<kind>:<due epoch>".
const DUE_VAR = 'followup_due';
const CLASSIFY_MODEL = 'claude-haiku-5-5';
// What marks an email as one that shared Katie's Calendly page.
const CALENDLY_MARKER = 'calendly.com/katie-peerteach';
// Fixed phrases from the follow-up wording above. A follow-up itself contains the Calendly link, so
// without this it would count as a fresh "offer" a day later and get followed up in turn.
const FOLLOWUP_MARKERS = ['so I wanted to check in and see if', 'in case my last note got buried', 'A quick nudge on this one'];
export function isFollowUpText(html: string): boolean {
  return FOLLOWUP_MARKERS.some((m) => html.includes(m));
}

const VARIANTS = [
  (n: string, link: string, sign: string) =>
    `Hi ${n},\n\nYou mentioned you were interested in PeerTeach, so I wanted to check in and see if you'd still like a quick 30-minute chat. I'd love to find a time that works for you. Here's [my Calendly](${link}) if you'd like to grab one.\n\n${sign}`,
  (n: string, link: string, sign: string) =>
    `Hi ${n},\n\nWanted to circle back in case my last note got buried. If you're still interested in a quick 30-minute chat, feel free to pick whatever time works best on [my Calendly](${link}), or just tell me what's easiest and I'll make it work.\n\n${sign}`,
  (n: string, link: string, sign: string) =>
    `Hi ${n},\n\nA quick nudge on this one. I'd still love to set up a short 30-minute call whenever it suits you. Here's [my Calendly](${link}) if you'd like to grab a time, and happy to work around your schedule if another day is better.\n\n${sign}`,
];

// Deterministic per lead, so a retry never produces a different message than the card showed.
export function buildFollowUpText(firstName: string, signOff: string, seed: string): string {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return VARIANTS[h % VARIANTS.length](firstName || 'there', CALENDLY_SCHEDULING_URL, signOff.replace(/\.$/, ''));
}

export type WaitKind = 'none' | 'open_ended' | 'dated' | 'skip';

// Reads the lead's reply (the one our Calendly email answered) and says whether they signaled they
// are handling it on their side. Returns null if the model call fails.
export async function classifyWait(
  messageText: string,
  messageEpoch: number,
): Promise<{ kind: 'none' | 'open_ended' | 'dated' | 'stop'; resumeDate: string | null } | null> {
  try {
    const client = new Anthropic({ apiKey: env('ANTHROPIC_API_KEY') });
    const sent = new Date(messageEpoch * 1000);
    const day = sent.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/New_York' });
    const res = await client.messages.create({
      model: CLASSIFY_MODEL,
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content:
`A school contact replied to our cold outreach about PeerTeach. The message was written on ${day}. Decide whether they said they will take some time or discuss it on their side before responding further.

Answer with ONLY JSON: {"kind": "none" | "open_ended" | "dated" | "stop", "resume_date": "YYYY-MM-DD" | null}

- "stop": a nudge would be inappropriate. They asked to postpone, cancel, or reschedule; mentioned a death, illness, emergency, or other hardship; declined or said it is not a fit; asked us to stop; or sounded upset.

- "none": they simply showed interest, asked a question, or said yes, with no sign they are waiting on something before getting back to us.
- "dated": they gave a specific time they'll be back in touch or something happens (a meeting, a decision, returning from leave): a date, "tomorrow", "next week", "Monday", "after the board meeting on the 18th". resume_date is the calendar date of that moment, resolved from the message date above. For a vague span like "next week" use the last weekday of that week; "end of the month" is the last day of the month.
- "open_ended": they said they'll share it, discuss it with a team or colleague, think about it, or get back to us, but gave no timing ("I'll discuss with my team", "let me run this by our principal").

Message:
"""
${messageText.slice(0, 1500)}
"""`,
      }],
    });
    const raw = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]);
    if (j.kind === 'stop') return { kind: 'stop', resumeDate: null };
    if (j.kind === 'dated' && /^\d{4}-\d{2}-\d{2}$/.test(String(j.resume_date))) return { kind: 'dated', resumeDate: j.resume_date };
    if (j.kind === 'dated' || j.kind === 'open_ended') return { kind: 'open_ended', resumeDate: null };
    return { kind: 'none', resumeDate: null };
  } catch (err) {
    console.warn('[followups] wait classification failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

// Pure: when the follow-up for an offer sent at `offerEpoch` is due, given the classification.
export function computeDue(
  offerEpoch: number,
  c: { kind: 'none' | 'open_ended' | 'dated' | 'stop'; resumeDate: string | null },
): { kind: WaitKind; due: number } {
  const base = offerEpoch + FOLLOWUP_AFTER_HOURS * 3600;
  if (c.kind === 'stop') return { kind: 'skip', due: base };
  if (c.kind === 'none') return { kind: 'none', due: base };
  if (c.kind === 'open_ended') return { kind: 'open_ended', due: offerEpoch + OPEN_ENDED_AFTER_HOURS * 3600 };
  const [y, mo, d] = (c.resumeDate as string).split('-').map(Number);
  let dayAfter = Date.UTC(y, mo - 1, d + 1, DUE_HOUR_UTC, 0, 0) / 1000;
  const dow = new Date(dayAfter * 1000).getUTCDay();
  if (dow === 6) dayAfter += 2 * 86400; // not on a weekend
  else if (dow === 0) dayAfter += 86400;
  const due = Math.max(dayAfter, base);
  if (due > offerEpoch + MAX_WAIT_DAYS * 86400) return { kind: 'skip', due };
  return { kind: 'dated', due };
}

export interface FollowUpResult {
  checked: number;
  queued: number;
  sent: number;
  skipped: number;
  waiting: number;
  // Only filled in a dry run: what would have been posted, and why others were skipped.
  preview?: string[];
}

// One follow-up per Calendly-link email, once it is due (see the timing note at the top). Katie's
// emails only. Candidates come straight from Instantly (agent-sent replies up to MAX_WAIT_DAYS old
// whose body links Katie's Calendly page, newest per lead), so this works however the email was
// worded and needs no calendar hold. Each candidate is re-checked: nothing sent or received since
// (which also stops a follow-up from being followed up), the email really was the agent's and not a
// teammate's, the lead is still open, and nothing is booked. The follow-up is sent automatically
// (the team confirmed these work); a short note in Slack records each one. It follows the same
// AUTO_SEND_ENABLED kill switch as ordinary replies, so turning auto-send off sends follow-ups to
// Slack for approval again.
export async function runFollowUps(opts: { dryRun?: boolean } = {}): Promise<FollowUpResult> {
  const result: FollowUpResult = { checked: 0, queued: 0, sent: 0, skipped: 0, waiting: 0, ...(opts.dryRun ? { preview: [] } : {}) };
  const nowSec = Date.now() / 1000;
  const all = await listRecentEmails(new Date((nowSec - (FOLLOWUP_WINDOW_END_HOURS + 6) * 3600) * 1000).toISOString());

  // The latest Calendly-link email per lead inside the window.
  const latest = new Map<string, RecentEmail>();
  for (const e of all) {
    if (e.ue !== 3 || !e.lead || !e.html.includes(CALENDLY_MARKER) || isFollowUpText(e.html)) continue;
    if (e.t > nowSec - FOLLOWUP_AFTER_HOURS * 3600 || e.t < nowSec - FOLLOWUP_WINDOW_END_HOURS * 3600) continue;
    if (getSenderIdentity(e.eaccount).firstName !== 'Katie') continue;
    const cur = latest.get(e.lead);
    if (!cur || e.t > cur.t) latest.set(e.lead, e);
  }

  const started = Date.now();
  for (const offer of latest.values()) {
    if (Date.now() - started > RUN_BUDGET_MS) { console.warn('[followups] time budget reached, the rest wait for the next run'); break; }
    // Cheap pre-check from what we already fetched: anything after the offer means it moved on.
    if (all.some((e) => e.lead === offer.lead && e.t > offer.t + 5)) { result.skipped++; continue; }
    result.checked++;
    await new Promise((r) => setTimeout(r, PACE_MS));
    try {
      const outcome = await followUpFor(offer, all, nowSec, opts.dryRun ? result.preview : undefined);
      if (opts.dryRun) {
        result.preview!.push(`${offer.lead}: ${outcome}`);
        if (outcome === 'queued') result.queued++; else if (outcome === 'not-yet') result.waiting++; else result.skipped++;
        continue;
      }
      if (outcome === 'sent') result.sent++;
      else if (outcome === 'queued') result.queued++;
      else if (outcome === 'not-yet') result.waiting++;
      else result.skipped++;
    } catch (err) {
      console.warn(`[followups] ${offer.lead} failed (will retry next tick):`, err instanceof Error ? err.message : String(err));
    }
  }
  console.log(`[followups] emails=${all.length} candidates=${latest.size} queued=${result.queued} sent=${result.sent} waiting=${result.waiting} skipped=${result.skipped}`);
  return result;
}

// previewSink: in a dry run, receives the draft that would have been posted instead of sending
// or posting anything (and nothing is stored on the lead).
async function followUpFor(
  offer: RecentEmail,
  all: RecentEmail[],
  nowSec: number,
  previewSink?: string[],
): Promise<'sent' | 'queued' | 'skipped' | 'not-yet'> {
  const lead = await findLeadByEmailAnyCampaign(offer.lead);
  if (!lead) return 'skipped';
  // Teachers have their own follow-ups (the demo nudge and the post-Remy check-in, which links
  // Katie's Calendly). This admin-style nudge on top of those was a duplicate.
  if (isTeacherPersona(lead.payload as any) || String(lead.payload.demo_link || '').trim()) return 'skipped';
  if (lead.interestStatus < 0 || lead.interestStatus >= 2) return 'skipped'; // not interested / already booked / closed
  // Only the agent's own emails. Something Katie wrote by hand that happens to link her Calendly is
  // her conversation, not ours to nudge.
  if (!isAgentSendAt(lead.agentSendStamps, offer.t)) return 'skipped';

  // When is this one due? Decided once per offer (the language model reads their reply), then kept
  // on the lead.
  let kind: WaitKind;
  let due: number;
  const stored = String(lead.payload[DUE_VAR] ?? '').split(':');
  if (stored.length === 3 && Math.abs(Number(stored[0]) - offer.t) <= 5 && Number.isFinite(Number(stored[2]))) {
    kind = stored[1] as WaitKind;
    due = Number(stored[2]);
  } else {
    const reply = all.filter((e) => e.ue === 2 && e.lead === offer.lead && e.t < offer.t).sort((a, b) => b.t - a.t)[0];
    const c = reply ? await classifyWait(reply.text, reply.t) : { kind: 'none' as const, resumeDate: null };
    // If the model call failed, wait the longer open-ended time rather than risk a badly timed nudge;
    // not stored, so the next hour asks again.
    const decided = c ? computeDue(offer.t, c) : { kind: 'open_ended' as WaitKind, due: offer.t + OPEN_ENDED_AFTER_HOURS * 3600 };
    kind = decided.kind;
    due = decided.due;
    if (c && !previewSink) {
      try { await setLeadVariablesById(lead.id, { [DUE_VAR]: `${Math.round(offer.t)}:${kind}:${Math.round(due)}` }); }
      catch (err) { console.warn('[followups] could not store due time:', err instanceof Error ? err.message : String(err)); }
    }
    if (previewSink) previewSink.push(`  ${offer.lead}: wait=${kind}, due ${new Date(due * 1000).toISOString()}${reply ? ` | their reply: "${reply.text.replace(/\s+/g, ' ').slice(0, 110)}"` : ''}`);
  }
  if (kind === 'skip') return 'skipped';
  if (nowSec < due) return 'not-yet';
  if (nowSec > due + GRACE_HOURS * 3600) return 'skipped'; // missed its moment

  // Final check right before sending, straight from the lead's thread.
  const emails = await listLeadEmails(offer.lead);
  const after = emails.filter((e) => e.t > offer.t + 5);
  if (after.some((e) => e.ue === 2 || e.ue === 3)) return 'skipped';
  if (await hasRealBookingForLead(offer.lead)) return 'skipped';

  const inbound = emails.filter((e) => e.ue === 2 && e.from === offer.lead).sort((a, b) => b.t - a.t)[0];
  if (!inbound) return 'skipped';
  const identity = getSenderIdentity(inbound.eaccount);
  if (identity.firstName !== 'Katie') return 'skipped';

  const first = (lead.firstName || '').trim().split(/\s+/)[0] || 'there';
  const leadName = [lead.firstName, lead.lastName].filter(Boolean).join(' ') || offer.lead;
  const campaignId = offer.campaignId || lead.campaignId;
  const draft = buildFollowUpText(first, identity.signOff, offer.lead);
  const subject = replySubject(inbound.subject);

  if (previewSink) {
    previewSink.push(`--- would post for ${offer.lead} (Calendly link sent ${Math.round((nowSec - offer.t) / 3600)}h ago):\n${draft}`);
    return 'queued';
  }

  if (isAutoSendEnabled()) {
    const rendered = renderLinks(draft);
    await replyToEmail({
      reply_to_uuid: inbound.id,
      eaccount: inbound.eaccount,
      subject,
      body: { text: rendered.plainText, html: rendered.html },
      stamp: { campaignId, leadEmail: offer.lead },
    });
    await postInfoNote(`:envelope: Sent a follow-up to ${leadName} (<mailto:${offer.lead}|${offer.lead}>):\n>${rendered.slackMrkdwn.replace(/\n/g, '\n>')}`);
    return 'sent';
  }
  await postProactiveApproval({
    header: ':hourglass_flowing_sand: Follow-up — needs approval',
    why: `Katie's Calendly link was shared ${Math.round((nowSec - offer.t) / 3600)} hours ago with no reply or booking yet.${kind === 'none' ? '' : ' They said they would be in touch, so this waited longer than the usual 24 hours.'} This is a gentle nudge with the calendar link.`,
    name: leadName,
    leadEmail: offer.lead,
    campaignId,
    eaccount: inbound.eaccount,
    emailId: inbound.id,
    subject,
    draftText: draft,
  });
  return 'queued';
}

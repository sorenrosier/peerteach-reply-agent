import axios from 'axios';
import { listLeadEmails, findLeadByEmailAnyCampaign, replyToEmail, listRecentSentEmails, isAgentSendAt, getAccountFirstName, SentEmail } from './instantly';
import { getSenderIdentity } from './agent';
import { envOptional, PEERTEACH_API_URL_DEFAULT } from './env';
import { postProactiveApproval, postInfoNote, replySubject } from './slack';
import { renderLinks } from './linkFormat';

// One nudge per teacher whose personal demo link sits unused. About two days after the agent
// emailed the link, if the link has never started a demo and nothing has happened in the thread
// since, Katie's inbox sends a short check-in. Same shape as the admin side's 24-hour follow-ups
// (followups.ts): candidates come straight from Instantly's sent mail, then each is re-checked.
//
// Waits for school hours (weekdays, 8am to 3pm in the teacher's state), so a link sent on Friday
// gets its nudge Monday morning rather than on Sunday.
//
// Sends automatically (Soren's call, 2026-11-10). TEACHER_NUDGE_AUTO_SEND=false sends them to
// Slack for approval instead.

// 24 hours since 2026-11-19 (Soren); was 48.
const NUDGE_AFTER_HOURS = 24;
// Long enough to carry a weekend (Friday's link reaches Monday 8am at about 68 hours).
const NUDGE_WINDOW_END_HOURS = 120;
const DEMO_LINK_MARKER = '/ai-agents/demo?link=';
// A fresh link has 5 uses (LINK_MAX_USES in the backend). Starting a demo uses one.
const UNUSED_USES_LEFT = 5;
// Fixed phrase from the nudge itself, so it never counts as a link email.
const NUDGE_MARKER = 'did you have a chance to check out the demo';
const SCHOOL_DAY_START = 8;
const SCHOOL_DAY_END = 15;

export function buildNudgeText(firstName: string, senderFirst: string): string {
  return `Hey ${firstName || 'there'}, did you have a chance to check out the demo? In case you've been too busy, your link is still active, so you can jump in whenever. Lmk if it gives you any trouble!\n\n-${senderFirst}`;
}

const PACIFIC = ['CA', 'OR', 'WA', 'NV'];
const MOUNTAIN = ['AZ', 'CO', 'ID', 'MT', 'NM', 'UT', 'WY'];
const CENTRAL = ['AL', 'AR', 'IL', 'IA', 'KS', 'LA', 'MN', 'MS', 'MO', 'NE', 'ND', 'OK', 'SD', 'TN', 'TX', 'WI'];
const STATE_NAMES: Record<string, string> = {
  california: 'CA', oregon: 'OR', washington: 'WA', nevada: 'NV', arizona: 'AZ', colorado: 'CO', idaho: 'ID', montana: 'MT',
  'new mexico': 'NM', utah: 'UT', wyoming: 'WY', alabama: 'AL', arkansas: 'AR', illinois: 'IL', iowa: 'IA', kansas: 'KS',
  louisiana: 'LA', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', nebraska: 'NE', 'north dakota': 'ND', oklahoma: 'OK',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', wisconsin: 'WI', alaska: 'AK', hawaii: 'HI',
};

// Good enough for "is it school hours": the state's main zone (a few states straddle two).
export function stateTimeZone(state: string): string {
  const s = String(state || '').trim();
  const code = s.length === 2 ? s.toUpperCase() : STATE_NAMES[s.toLowerCase()] || '';
  if (code === 'AZ') return 'America/Phoenix';
  if (code === 'AK') return 'America/Anchorage';
  if (code === 'HI') return 'Pacific/Honolulu';
  if (PACIFIC.includes(code)) return 'America/Los_Angeles';
  if (MOUNTAIN.includes(code)) return 'America/Denver';
  if (CENTRAL.includes(code)) return 'America/Chicago';
  if (!code) return 'America/Chicago'; // unknown: middle of the country
  return 'America/New_York';
}

export function isSchoolHours(state: string, now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: stateTimeZone(state), weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(now);
  const day = parts.find((p) => p.type === 'weekday')?.value || '';
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  return !['Sat', 'Sun'].includes(day) && hour >= SCHOOL_DAY_START && hour < SCHOOL_DAY_END;
}

function linkToken(html: string): string | null {
  const m = html.match(/\/ai-agents\/demo\?link=([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

// Uses left on the link, from the backend's public lookup (looking doesn't use it). null if the
// link can't be read or no longer works.
async function usesLeft(token: string): Promise<number | null> {
  const base = (envOptional('PEERTEACH_API_URL') || PEERTEACH_API_URL_DEFAULT).replace(/\/$/, '');
  const res = await axios.get(`${base}/ai-agents/demo/links/${encodeURIComponent(token)}`, { timeout: 8000, validateStatus: () => true });
  return res.data?.success ? Number(res.data.usesLeft) : null;
}

export interface NudgeResult {
  checked: number;
  sent: number;
  queued: number;
  // Due, but outside school hours in their state; picked up on a later hourly run.
  waiting: number;
  skipped: number;
  preview?: string[];
}

export async function runTeacherNudges(opts: { dryRun?: boolean } = {}): Promise<NudgeResult> {
  const result: NudgeResult = { checked: 0, sent: 0, queued: 0, waiting: 0, skipped: 0, ...(opts.dryRun ? { preview: [] } : {}) };
  const nowSec = Date.now() / 1000;
  const sent = await listRecentSentEmails(new Date((nowSec - (NUDGE_WINDOW_END_HOURS + 4) * 3600) * 1000).toISOString());

  // The latest demo-link email per lead, 24 to 120 hours old.
  const latest = new Map<string, SentEmail>();
  for (const e of sent) {
    if (!e.lead || !e.html.includes(DEMO_LINK_MARKER) || e.html.includes(NUDGE_MARKER)) continue;
    if (e.t > nowSec - NUDGE_AFTER_HOURS * 3600 || e.t < nowSec - NUDGE_WINDOW_END_HOURS * 3600) continue;
    const cur = latest.get(e.lead);
    if (!cur || e.t > cur.t) latest.set(e.lead, e);
  }

  for (const linkEmail of latest.values()) {
    result.checked++;
    try {
      const outcome = await nudgeFor(linkEmail, opts.dryRun ? result.preview : undefined);
      if (outcome === 'sent') result.sent++;
      else if (outcome === 'queued') result.queued++;
      else if (outcome.startsWith('waiting')) result.waiting++;
      else result.skipped++;
      if (opts.dryRun) result.preview!.push(`${linkEmail.lead}: ${outcome}`);
    } catch (err) {
      console.warn(`[teacherNudges] ${linkEmail.lead} failed (will retry next tick):`, err instanceof Error ? err.message : String(err));
    }
  }
  console.log(`[teacherNudges] sent-emails=${sent.length} candidates=${latest.size} sent=${result.sent} queued=${result.queued} waiting=${result.waiting} skipped=${result.skipped}`);
  return result;
}

// previewSink: in a dry run, receives the nudge that would have gone out, and nothing is sent.
async function nudgeFor(linkEmail: SentEmail, previewSink?: string[]): Promise<string> {
  const nowSec = Date.now() / 1000;
  const token = linkToken(linkEmail.html);
  if (!token) return 'skipped: no link in the email';

  // Anything since the link email (a reply, a teammate's note, an earlier nudge) means the
  // conversation has moved on.
  const emails = await listLeadEmails(linkEmail.lead);
  if (emails.some((e) => e.t > linkEmail.t + 5 && (e.ue === 2 || e.ue === 3))) return 'skipped: thread moved on';

  const lead = await findLeadByEmailAnyCampaign(linkEmail.lead);
  if (!lead) return 'skipped: lead not found';
  if (lead.interestStatus < 0 || lead.interestStatus >= 2) return 'skipped: not interested, booked or closed';
  // Only links the agent sent (auto or approved in Slack). A link a teammate sent by hand is theirs.
  if (!isAgentSendAt(lead.agentSendStamps, linkEmail.t)) return 'skipped: link email not sent by the agent';

  const left = await usesLeft(token);
  if (left === null) return 'skipped: link no longer works';
  if (left < UNUSED_USES_LEFT) return 'skipped: demo already started';

  if (!isSchoolHours(String(lead.payload.state || lead.payload.State || ''))) return 'waiting: outside school hours';

  const inbound = emails.filter((e) => e.ue === 2 && e.from === linkEmail.lead).sort((a, b) => b.t - a.t)[0];
  if (!inbound) return 'skipped: no message from them to reply to';
  const senderFirst = (await getAccountFirstName(inbound.eaccount)) || getSenderIdentity(inbound.eaccount).firstName;
  const first = String(lead.payload.demo_name || lead.firstName || '').trim().split(/\s+/)[0];
  const draft = buildNudgeText(first, senderFirst);
  const leadName = [lead.firstName, lead.lastName].filter(Boolean).join(' ') || linkEmail.lead;
  const campaignId = linkEmail.campaignId || lead.campaignId;
  const subject = replySubject(inbound.subject);
  const hours = Math.round((nowSec - linkEmail.t) / 3600);

  if (previewSink) {
    previewSink.push(`--- would send to ${linkEmail.lead} (link sent ${hours}h ago, unused):\n${draft}`);
    return 'queued';
  }

  if (envOptional('TEACHER_NUDGE_AUTO_SEND') !== 'false') {
    const rendered = renderLinks(draft);
    await replyToEmail({
      reply_to_uuid: inbound.id,
      eaccount: inbound.eaccount,
      subject,
      body: { text: rendered.plainText, html: rendered.html },
      stamp: { campaignId, leadEmail: linkEmail.lead },
    });
    await postInfoNote(`:bell: Sent a demo-link nudge to ${leadName} (<mailto:${linkEmail.lead}|${linkEmail.lead}>), whose link has gone unused for ${hours} hours:\n>${rendered.slackMrkdwn.replace(/\n/g, '\n>')}`);
    return 'sent';
  }
  await postProactiveApproval({
    header: ':bell: Demo-link nudge — needs approval',
    why: `Their personal demo link was sent ${hours} hours ago and hasn't been used. This is a short check-in.`,
    name: leadName,
    leadEmail: linkEmail.lead,
    campaignId,
    eaccount: inbound.eaccount,
    emailId: inbound.id,
    subject,
    draftText: draft,
  });
  return 'queued';
}

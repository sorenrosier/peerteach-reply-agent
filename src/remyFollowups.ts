import axios from 'axios';
import { listLeadEmails, findLeadByEmailAnyCampaign, replyToEmail, getAccountFirstName, setLeadVariablesById } from './instantly';
import { getSenderIdentity } from './agent';
import { envOptional, PEERTEACH_API_URL_DEFAULT, TEACHER_CALENDLY_URL } from './env';
import { postProactiveApproval, postInfoNote, replySubject } from './slack';
import { renderLinks } from './linkFormat';
import { isSchoolHours } from './teacherNudges';

// One follow-up per teacher, about a day after they talked with Remy (Soren, 2026-11-19), in
// the same thread as the email that sent their demo link:
// - Remy saved that they'd email their principal, or they chose to share the demo with their
//   team: a check-in that names who they were checking with, plus Katie's onboarding link.
// - Remy saved that they wanted to book with Katie (but they haven't): the same check-in,
//   worded for that.
// - Anything else (not now, not a fit, materials only, or they didn't finish): a request for
//   feedback on the Remy experience.
//
// The demo outcomes come from the backend's admin call list (peer-teach/peerteach-match,
// GET /admin/ai-agents/calls), read with the admin token the agent already uses to make
// demo links (PEERTEACH_ADMIN_TOKEN, see demoLinks.ts).
//
// Only teachers whose lead carries a demo link we made (demo_link) are followed up, so a
// colleague who came through a shared link, with no thread of ours, is skipped. Nothing is
// sent if they booked, are marked not interested, or anything has happened in the thread
// since the demo (they wrote to us, or a teammate did). The remy_followup lead variable
// records the follow-up, so each teacher gets at most one.
//
// Sends automatically (Soren's call, 2026-11-19); REMY_FOLLOWUP_AUTO_SEND=false sends them to
// Slack for approval instead. Waits for school hours in
// the teacher's state, like the demo-link nudge; the cron only runs on weekdays from 12:45 to
// 22:45 UTC (school hours somewhere in the US), to spare Instantly's rate limit.

const FOLLOW_UP_AFTER_HOURS = 24;
// Long enough to carry a weekend (a Friday demo reaches Monday 8am at about 68 hours).
const FOLLOW_UP_WINDOW_END_HOURS = 120;
// Calls this far back count toward a teacher's outcome (an earlier call they resumed).
const LOOKBACK_DAYS = 8;
const STAMP_VAR = 'remy_followup';
// Instantly allows about 20 requests a minute on some endpoints, shared with the live reply
// handling, and each teacher takes two or three. So: a pause between teachers, and a cap per
// run (the rest are picked up an hour later, most overdue first).
const PAUSE_BETWEEN_TEACHERS_MS = 4000;
const MAX_TEACHERS_PER_RUN = 20; // 20 x 4s stays well inside the 120s limit
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Remy's save_needs next_step values (demo_agent/__init__.py NEXT_STEPS) and the next-step card
// clicks (controllers/ai_agents.py), as the admin call list reports them.
export interface CallSummary {
  id: number;
  createdAt: string; // UTC, no zone suffix
  connected: boolean;
  minutes: number | null;
  visitorEmail: string | null;
  nextStep: string | null; // pilot | share | materials | call | booked | later
  remyNextStep: string | null; // email_principal | booking_onboarding | talk_to_katie | share_with_team | not_now | not_a_fit
}

export type FollowUpKind =
  | { kind: 'check_in'; principal: boolean; team: boolean }
  | { kind: 'feedback' };

function utcMs(iso: string): number {
  return Date.parse(/Z|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z');
}

function callEndMs(c: CallSummary): number {
  return utcMs(c.createdAt) + (c.minutes || 0) * 60000;
}

// From a teacher's calls, oldest first: the latest call where they or Remy picked a next step
// decides. No next step anywhere means they didn't finish.
export function classify(calls: CallSummary[]): FollowUpKind {
  const decided = [...calls].reverse().find((c) => c.nextStep || c.remyNextStep);
  if (!decided) return { kind: 'feedback' };
  const steps = [decided.nextStep, decided.remyNextStep];
  const principal = steps.includes('pilot') || steps.includes('email_principal');
  const team = steps.includes('share') || steps.includes('share_with_team');
  const booking = ['call', 'booked', 'booking_onboarding', 'talk_to_katie'].some((s) => steps.includes(s));
  if (principal || team || booking) return { kind: 'check_in', principal, team };
  return { kind: 'feedback' };
}

export function buildFollowUpText(kind: FollowUpKind, firstName: string, senderFirst: string): string {
  const hey = `Hey ${firstName || 'there'}`;
  if (kind.kind === 'feedback') {
    return `${hey}, thanks for trying the demo with Remy! We actually just built this system with Remy to help folks get a glimpse of PeerTeach before scheduling a call with us. We would be SOOOO grateful if you have any feedback on the Remy experience or what you're looking for that might be different from what you saw… maybe we can build it for you! :)\n\n-${senderFirst}`;
  }
  const book = `If you're ready, you can snag a time to onboard with me at this link: ${TEACHER_CALENDLY_URL}`;
  if (!kind.principal && !kind.team) {
    return `${hey}, Remy told me you were thinking about grabbing a time to get set up with PeerTeach. How's it going? ${book}\n\n-${senderFirst}`;
  }
  const who = kind.principal && kind.team ? 'your principal and your team' : kind.principal ? 'your principal' : 'your team';
  return `${hey}, Remy told me you were planning to check in with ${who} to see if you could launch a PeerTeach pilot. How'd it go? ${book}\n\n-${senderFirst}`;
}

// Connected demo calls since `sinceMs`, newest first, a page (50) at a time.
async function recentCalls(sinceMs: number): Promise<CallSummary[]> {
  const token = envOptional('PEERTEACH_ADMIN_TOKEN');
  if (!token) throw new Error('PEERTEACH_ADMIN_TOKEN is not set');
  const base = (envOptional('PEERTEACH_API_URL') || PEERTEACH_API_URL_DEFAULT).replace(/\/$/, '');
  const out: CallSummary[] = [];
  for (let offset = 0; offset < 2000; ) {
    const res = await axios.get(`${base}/admin/ai-agents/calls`, {
      params: { offset, agent: 'demo' },
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
      validateStatus: () => true,
    });
    if (res.status !== 200 || !res.data?.success) throw new Error(`call list failed: HTTP ${res.status}`);
    const page: CallSummary[] = res.data.calls || [];
    const fresh = page.filter((c) => utcMs(c.createdAt) >= sinceMs);
    out.push(...fresh.filter((c) => c.connected && c.visitorEmail));
    if (fresh.length < page.length || page.length === 0) break;
    offset += Number(res.data.pageSize) || page.length;
  }
  return out;
}

export interface RemyFollowUpResult {
  teachers: number;
  sent: number;
  queued: number;
  waiting: number;
  skipped: number;
  preview?: string[];
}

export async function runRemyFollowUps(opts: { dryRun?: boolean } = {}): Promise<RemyFollowUpResult> {
  const result: RemyFollowUpResult = { teachers: 0, sent: 0, queued: 0, waiting: 0, skipped: 0, ...(opts.dryRun ? { preview: [] } : {}) };
  const now = Date.now();
  const calls = await recentCalls(now - LOOKBACK_DAYS * 86400000);

  const byTeacher = new Map<string, CallSummary[]>();
  for (const c of calls) {
    const email = c.visitorEmail!.trim().toLowerCase();
    byTeacher.set(email, [...(byTeacher.get(email) || []), c]);
  }

  const due: Array<{ email: string; theirs: CallSummary[]; hoursSince: number }> = [];
  for (const [email, theirs] of byTeacher) {
    theirs.sort((a, b) => utcMs(a.createdAt) - utcMs(b.createdAt));
    const hoursSince = (now - callEndMs(theirs[theirs.length - 1])) / 3600000;
    // Their last call, 24 to 120 hours ago. Someone still mid-way through gets more time.
    if (hoursSince >= FOLLOW_UP_AFTER_HOURS && hoursSince <= FOLLOW_UP_WINDOW_END_HOURS) due.push({ email, theirs, hoursSince });
  }
  due.sort((a, b) => b.hoursSince - a.hoursSince);

  for (const { email, theirs, hoursSince } of due.slice(0, MAX_TEACHERS_PER_RUN)) {
    if (result.teachers > 0) await sleep(PAUSE_BETWEEN_TEACHERS_MS);
    result.teachers++;
    try {
      const outcome = await followUpFor(email, theirs, hoursSince, opts.dryRun ? result.preview : undefined);
      if (outcome === 'sent') result.sent++;
      else if (outcome === 'queued') result.queued++;
      else if (outcome.startsWith('waiting')) result.waiting++;
      else result.skipped++;
      if (opts.dryRun) result.preview!.push(`${email}: ${outcome}`);
    } catch (err) {
      console.warn(`[remyFollowups] ${email} failed (will retry next tick):`, err instanceof Error ? err.message : String(err));
    }
  }
  console.log(`[remyFollowups] calls=${calls.length} teachers=${result.teachers} sent=${result.sent} queued=${result.queued} waiting=${result.waiting} skipped=${result.skipped}`);
  return result;
}

// previewSink: in a dry run, receives the email that would have gone out, and nothing is sent
// or recorded.
async function followUpFor(email: string, calls: CallSummary[], hoursSince: number, previewSink?: string[]): Promise<string> {
  const lead = await findLeadByEmailAnyCampaign(email);
  if (!lead) return 'skipped: not an Instantly lead (e.g. came through a shared link)';
  if (!String(lead.payload.demo_link || '').trim()) return 'skipped: no demo link of ours on the lead';
  if (String(lead.payload[STAMP_VAR] || '').trim()) return 'skipped: already followed up';
  if (lead.interestStatus < 0 || lead.interestStatus >= 2) return 'skipped: booked, not interested or closed';

  // Anything in the thread since the demo started (they wrote, or one of us did) means the
  // conversation has moved on.
  const firstCallSec = utcMs(calls[0].createdAt) / 1000;
  const emails = await listLeadEmails(email);
  if (emails.some((e) => e.t > firstCallSec && (e.ue === 2 || e.ue === 3))) return 'skipped: thread moved on since the demo';

  const schoolHours = isSchoolHours(String(lead.payload.state || lead.payload.State || ''));
  if (!schoolHours && !previewSink) return 'waiting: outside school hours';

  const inbound = emails.filter((e) => e.ue === 2 && e.from === email).sort((a, b) => b.t - a.t)[0];
  if (!inbound) return 'skipped: no message from them to reply to';

  const kind = classify(calls);
  const senderFirst = (await getAccountFirstName(inbound.eaccount)) || getSenderIdentity(inbound.eaccount).firstName;
  const first = String(lead.payload.demo_name || lead.firstName || '').trim().split(/\s+/)[0];
  const draft = buildFollowUpText(kind, first, senderFirst);
  const leadName = [lead.firstName, lead.lastName].filter(Boolean).join(' ') || email;
  const subject = replySubject(inbound.subject);
  const hours = Math.round(hoursSince);
  const outcomeLine = calls
    .map((c) => `call ${c.id}: ${c.minutes ?? 0} min, card ${c.nextStep || 'none'}, Remy saved ${c.remyNextStep || 'none'}`)
    .join('; ');
  const why = `They talked with Remy ${hours} hours ago (${outcomeLine}). This is the ${kind.kind === 'feedback' ? 'feedback request' : 'check-in with the onboarding link'}.`;

  if (previewSink) {
    const when = schoolHours ? '' : ' (once it is school hours there)';
    previewSink.push(`--- would ${envOptional('REMY_FOLLOWUP_AUTO_SEND') !== 'false' ? 'send' : 'queue for approval'}${when} to ${email}. ${why}\n${draft}`);
    return 'queued';
  }

  // Recorded first, so a failure later in this run can't lead to a second email.
  await setLeadVariablesById(lead.id, { [STAMP_VAR]: `${new Date().toISOString()} call ${calls[calls.length - 1].id} ${kind.kind}` });

  if (envOptional('REMY_FOLLOWUP_AUTO_SEND') !== 'false') {
    const rendered = renderLinks(draft);
    await replyToEmail({
      reply_to_uuid: inbound.id,
      eaccount: inbound.eaccount,
      subject,
      body: { text: rendered.plainText, html: rendered.html },
      stamp: { campaignId: lead.campaignId, leadEmail: email },
    });
    await postInfoNote(`:speech_balloon: Sent a post-Remy follow-up to ${leadName} (<mailto:${email}|${email}>). ${why}\n>${rendered.slackMrkdwn.replace(/\n/g, '\n>')}`);
    return 'sent';
  }
  await postProactiveApproval({
    header: ':speech_balloon: Post-Remy follow-up — needs approval',
    why,
    name: leadName,
    leadEmail: email,
    campaignId: lead.campaignId,
    eaccount: inbound.eaccount,
    emailId: inbound.id,
    subject,
    draftText: draft,
  });
  return 'queued';
}

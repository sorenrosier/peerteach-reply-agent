import axios from 'axios';
import { envOptional } from './env';
import { postBlocks, postInfoNote } from './slack';
import { CloseEmailRow, CloseLeadRow, closeErrorText, closeLeadUrl, customFieldIds, listActiveOpportunityLeadIds, listLeadEmailsSince, listLeads } from './closeCrm';
import { LEADS_QUERY, salesOpsBase, teachersOf, toHealthLead } from './usageHealth';
import { HealthLead, addDays, chooseSchoolLeads, isDate, isFeedStale, normNces, pacificDate, parseExcludedIds, schoolYearStart } from './usageHealthRules';
import {
  MIN_PAIRS,
  MIN_SESSIONS,
  NudgeAction,
  NudgeKind,
  NudgeMode,
  NudgeTeacher,
  RECENT_CONTACT_DAYS,
  SCHOOL_CARDS_PER_WEEK,
  buildEmail,
  cardBlocks,
  cardData,
  contactedSince,
  heldOutLogged,
  isHeldOut,
  lastBefore,
  longestLapsedFirst,
  noRunReason,
  parseMode,
  parseTeacher,
  repliedSince,
  schoolCardsThisWeek,
  summaryLine,
  verdict,
} from './lapseNudgeRules';

// Check-in emails to teachers who built the habit and then stopped (Soren, 2026-11-26). Tuesday
// to Thursday mornings this job asks the Sales Ops app who has lapsed, applies the rules in
// src/lapseNudgeRules.ts, and posts one card per teacher in the health channel with the email it
// suggests. A person clicks Approve, Edit, Skip or Never (src/lapseNudgeActions.ts). The job
// itself never sends anything, and its only writes are rows in the Sales Ops nudge log, which is
// also its only memory.
//
// Close is read (never written) to decide who is left alone: a school with no lead or no active
// deal, and a teacher someone has emailed, or who has emailed us, in the last 14 days.
//
// LAPSE_NUDGE_MODE: unset or 'preview' posts cards with no Approve button; 'draft' makes Approve
// save a draft in the sender's Close mailbox; 'live' makes Approve send.

// Time budget: stop looking teachers up in Close after this. Whoever is left is picked up by the
// next run.
const RUN_BUDGET_MS = 90_000;

export const nudgeMode = (): NudgeMode => parseMode(envOptional('LAPSE_NUDGE_MODE'));
export const senderEmail = () => (envOptional('NUDGE_SENDER_EMAIL') || 'katie@peerteach.org').trim().toLowerCase();
export const senderName = () => (envOptional('NUDGE_SENDER_NAME') || 'Katie').trim();
export const senderLabel = () => `${senderName()} (${senderEmail()})`;

// One row of the nudge log: something that happened to one teacher's check-in.
export interface NudgeRecord {
  teacher_id: string;
  nces_school_id: string;
  kind: NudgeKind;
  action: NudgeAction;
  lapse_started_on: string;
  slack_ts?: string;
  actor?: string;
  note?: string;
}

interface CandidateQuery { since: string; last_before: string }

// Everything that touches the network, so scripts/checkLapseNudges.ts can run the job on fakes.
export interface LapseNudgeDeps {
  fetchCandidates(q: CandidateQuery): Promise<any>;
  recordNudge(row: NudgeRecord): Promise<void>;
  leadFieldIds(): Promise<Map<string, string>>; // lower-cased field name -> id
  listLeads(query: string, customFieldIdList: string[]): Promise<CloseLeadRow[]>;
  activeDealLeadIds(): Promise<Set<string>>;
  leadEmailsSince(leadId: string, sinceIso: string): Promise<CloseEmailRow[]>;
  postCard(blocks: any[], text: string): Promise<string | undefined>; // the health channel; returns the card's ts
  postNote(text: string): Promise<void>; // warnings and errors: the main channel
  postReport(text: string): Promise<void>; // the run's summary: the health channel
}

function usageSecret(): string {
  const secret = envOptional('PEERTEACH_USAGE_SECRET');
  if (!secret) throw new Error('PEERTEACH_USAGE_SECRET is not set');
  return secret;
}

async function fetchCandidates(q: CandidateQuery): Promise<any> {
  const res = await axios.get(`${salesOpsBase()}/api/public/peerteach/nudge-candidates`, {
    headers: { 'x-peerteach-usage-secret': usageSecret() },
    params: { ...q, min_sessions: MIN_SESSIONS, min_pairs: MIN_PAIRS },
    timeout: 30000,
  });
  return res.data;
}

export async function recordNudge(row: NudgeRecord): Promise<void> {
  const res = await axios.post(`${salesOpsBase()}/api/public/peerteach/nudges`, row, { headers: { 'x-peerteach-usage-secret': usageSecret() }, timeout: 15000 });
  if (res.data && typeof res.data === 'object' && res.data.ok === false) throw new Error(`nudge log refused the row: ${JSON.stringify(res.data).slice(0, 200)}`);
}

const healthChannel = () => envOptional('USAGE_HEALTH_SLACK_CHANNEL') || undefined;
const realDeps: LapseNudgeDeps = { fetchCandidates, recordNudge, leadFieldIds: () => customFieldIds('lead'), listLeads,
  activeDealLeadIds: listActiveOpportunityLeadIds, leadEmailsSince: listLeadEmailsSince,
  postCard: (blocks, text) => postBlocks(blocks, text, healthChannel()),
  postNote: (text) => postInfoNote(text),
  postReport: (text) => postInfoNote(text, healthChannel()),
};

export interface LapseNudgeResult {
  ok: boolean;
  mode: NudgeMode;
  dryRun: boolean;
  today: string;
  notToday?: string; // why the job did nothing (weekday, holiday, summer)
  lastBefore?: string;
  latestUsageDate?: string;
  stale?: boolean;
  error?: string;
  teachers: number; // in the feed
  cards: number; // posted (or, in a dry run, that would be)
  first: number;
  second: number;
  heldOut: number; // newly recorded for the comparison group
  waitingContact: number; // someone was in touch in the last 14 days
  waitingSchoolLimit: number; // the school already has 2 cards this week
  deferred: number; // out of time
  leftAlone: Record<string, number>; // reason -> teachers
}


function holdoutUntil(): string | null {
  const v = (envOptional('NUDGE_HOLDOUT_UNTIL') ?? '').trim();
  if (!v) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !isDate(v)) throw new Error(`NUDGE_HOLDOUT_UNTIL is not a YYYY-MM-DD date: ${v}`);
  return v;
}

// Never throws: a failure is logged, posted to the main channel and returned as { ok: false }.
// A dry run reads the feed and Close and logs what it would do; it posts and records nothing.
export async function runLapseNudges(opts: { dryRun?: boolean; now?: Date } = {}, deps: LapseNudgeDeps = realDeps): Promise<LapseNudgeResult> {
  const dryRun = !!opts.dryRun;
  const now = opts.now ?? new Date();
  const today = pacificDate(now);
  const mode = nudgeMode();
  const result: LapseNudgeResult = { ok: true, mode, dryRun, today, teachers: 0, cards: 0, first: 0, second: 0, heldOut: 0, waitingContact: 0, waitingSchoolLimit: 0, deferred: 0, leftAlone: {} };
  const post = async (text: string, how: (text: string) => Promise<void>) => {
    if (dryRun) return;
    try { await how(text); } catch (err) { console.warn('[lapseNudges] Slack post failed:', closeErrorText(err)); }
  };
  const leaveAlone = (t: NudgeTeacher, reason: string) => {
    result.leftAlone[reason] = (result.leftAlone[reason] ?? 0) + 1;
    console.log(`[lapseNudges] teacher ${t.teacherId}: left alone (${reason})`);
  };
  const finish = () => { console.log(`[lapseNudges] ${JSON.stringify(result)}`); return result; };
  try {
    const t0 = Date.now();
    // A dry run may be asked for on any weekday; holidays and summer still stop it.
    const notToday = noRunReason(today, { anyWeekday: dryRun });
    if (notToday) { result.notToday = notToday; return finish(); }
    const until = holdoutUntil();
    const cutoff = lastBefore(today);
    result.lastBefore = cutoff;

    const body = await deps.fetchCandidates({ since: schoolYearStart(today), last_before: cutoff });
    const raw = teachersOf(body);
    result.latestUsageDate = String(body.latest_usage_date ?? '');
    if (isFeedStale(body.latest_usage_date, today)) {
      result.stale = true;
      console.warn(`[lapseNudges] stale feed: latest_usage_date=${result.latestUsageDate || '(none)'}, today=${today}; no cards`);
      await post(`:warning: *Teacher check-ins: the usage feed looks stale, so no cards were made.* Its newest usage is ${result.latestUsageDate || 'missing'} and today is ${today} (more than 4 days old counts as broken, not counting holiday weeks).`, deps.postNote);
      return finish();
    }
    const teachers = raw.map(parseTeacher).filter((t): t is NudgeTeacher => !!t);
    result.teachers = teachers.length;

    // The rules that need nothing from Close come first, so a quiet day makes no Close calls.
    const ctx = { today, mode, excludedTeacherIds: parseExcludedIds(envOptional('HEALTH_EXCLUDED_TEACHER_IDS')) };
    const due: Array<{ t: NudgeTeacher; kind: NudgeKind; firstSentAt?: string }> = [];
    for (const t of [...teachers].sort(longestLapsedFirst)) {
      const v = verdict(t, ctx);
      if ('skip' in v) leaveAlone(t, v.skip); else due.push({ t, ...v });
    }
    if (!due.length) return finish();

    // Close: every lead with an NCES ID (matched as the health job matches them) and the leads
    // with an active deal, each in one paginated listing.
    const ids = await deps.leadFieldIds();
    const wanted = ['School NCES', 'District NCES'].map((f) => ids.get(f.toLowerCase())).filter((id): id is string => !!id);
    if (wanted.length < 2) throw new Error('Close has no "School NCES" / "District NCES" lead field');
    const leads = (await deps.listLeads(LEADS_QUERY, wanted)).map((row) => toHealthLead(row, ids));
    if (!leads.some((l) => l.schoolNces)) throw new Error(`Close returned ${leads.length} leads and none has a School NCES`);
    const { byKey } = chooseSchoolLeads(leads);
    const districtLeads = new Map<string, HealthLead[]>();
    for (const l of leads) {
      const key = normNces(l.districtNces);
      if (key && !normNces(l.schoolNces)) districtLeads.set(key, [...(districtLeads.get(key) ?? []), l]);
    }
    const active = await deps.activeDealLeadIds();

    const schoolCards = schoolCardsThisWeek(teachers, today);
    const recentIso = `${addDays(today, -RECENT_CONTACT_DAYS)}T00:00:00Z`;
    const record = async (t: NudgeTeacher, kind: NudgeKind, action: NudgeAction, extra: Partial<NudgeRecord> = {}) => {
      try {
        await deps.recordNudge({ teacher_id: t.teacherId, nces_school_id: t.ncesSchoolId, kind, action, lapse_started_on: t.lastSessionDate, ...extra });
      } catch (err) {
        // Without the log the job has no memory: stop rather than post cards it will post again.
        throw new Error(`the nudge log could not be written, so the run stopped ("${action}" for teacher ${t.teacherId} is not recorded): ${closeErrorText(err)}`);
      }
    };

    for (const { t, kind, firstSentAt } of due) {
      const lead = byKey.get(t.schoolKey);
      if (!lead) { leaveAlone(t, 'school has no Close lead'); continue; }
      const district = districtLeads.get(normNces(lead.districtNces) || t.districtKey) ?? [];
      if (![lead, ...district].some((l) => active.has(l.id))) { leaveAlone(t, 'no active deal'); continue; }
      if (isHeldOut(t.teacherId, today, until)) {
        if (heldOutLogged(t)) { leaveAlone(t, 'held out (already recorded)'); continue; }
        if (!dryRun) await record(t, kind, 'held_out', { actor: 'job' });
        result.heldOut++;
        console.log(`[lapseNudges] teacher ${t.teacherId}: held out for the comparison group`);
        continue;
      }
      if ((schoolCards.get(t.schoolKey) ?? 0) >= SCHOOL_CARDS_PER_WEEK) { result.waitingSchoolLimit++; continue; }
      if (Date.now() - t0 > RUN_BUDGET_MS) { result.deferred++; continue; }

      // Only now the per-teacher Close calls: emails on the school lead and its district lead(s).
      const sinceIso = firstSentAt && Date.parse(firstSentAt) < Date.parse(recentIso) ? firstSentAt : recentIso;
      const emails: CloseEmailRow[] = [];
      for (const l of [lead, ...district.slice(0, 2)]) emails.push(...(await deps.leadEmailsSince(l.id, sinceIso)));
      if (kind === 'second' && firstSentAt && repliedSince(emails, t.email, firstSentAt)) {
        // Recorded, so the same lookup isn't repeated on every run for the rest of the lapse.
        if (!dryRun) await record(t, 'second', 'skipped', { actor: 'job', note: 'teacher replied' });
        leaveAlone(t, 'replied to the first check-in');
        continue;
      }
      if (contactedSince(emails, t.email, recentIso)) { result.waitingContact++; console.log(`[lapseNudges] teacher ${t.teacherId}: waiting (in touch in the last ${RECENT_CONTACT_DAYS} days)`); continue; }

      const email = buildEmail(kind, t, today, { senderName: senderName(), calendarUrl: (envOptional('NUDGE_CALENDAR_URL') ?? '').trim() });
      const data = cardData(t, kind, lead.id, today);
      if (dryRun) {
        console.log(`[lapseNudges] would post a ${kind} check-in card for teacher ${t.teacherId} at ${data.school} (last session ${t.lastSessionDate}, lead ${lead.id})`);
      } else {
        const ts = await deps.postCard(cardBlocks(data, email, { mode, sender: senderLabel(), leadUrl: closeLeadUrl(lead.id) }), `Check-in for ${data.name} at ${data.school}`);
        if (!ts) throw new Error(`Slack did not accept the card for teacher ${t.teacherId}, so the run stopped`);
        await record(t, kind, mode === 'preview' ? 'previewed' : 'drafted', { slack_ts: ts, actor: 'job' });
      }
      schoolCards.set(t.schoolKey, (schoolCards.get(t.schoolKey) ?? 0) + 1);
      result.cards++;
      result[kind]++;
    }

    const summary = summaryLine({ mode, senderName: senderName(), cards: result.cards, heldOut: result.heldOut, waiting: result.waitingContact + result.waitingSchoolLimit + result.deferred });
    if (summary) await post(summary, deps.postReport);
    return finish();
  } catch (err) {
    const msg = closeErrorText(err);
    console.error('[lapseNudges] failed:', msg);
    await post(`:warning: *Teacher check-in job failed* (${mode}): \`${msg.slice(0, 500)}\``, deps.postNote);
    result.ok = false;
    result.error = msg;
    return finish();
  }
}

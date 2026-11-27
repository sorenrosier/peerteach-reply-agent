// The rules behind the check-in emails to teachers who stopped running sessions
// (src/lapseNudges.ts). Pure: no network, no env, no clock; everything is passed in, so
// scripts/checkLapseNudges.ts can assert all of it.
//
// Decided with Soren (2026-11-26), who does not want these to be annoying:
// - Lapsed: 3+ sessions this school year and none in the last 21 days, stretched by a week for
//   each holiday week those days touch (the same holiday weeks as the usage health job).
// - At most two emails per lapse (a first, and a second 21 days later if they haven't replied),
//   two per teacher per semester, and two new cards per school per week.
// - Every email is a card in Slack that a person approves. Nothing sends on its own.
// - The nudge log in the Sales Ops app is the only memory: one row per thing that happened.

import { addDays, holidayWeeksTouching, inHolidayWeek, isDate, isExcludedTeacher, isSummerPause, normNces, weekStart } from './usageHealthRules';

export const LAPSE_DAYS = 21;
export const MIN_SESSIONS = 3;
export const MIN_PAIRS = 2; // a real session has at least two pairs
export const SECOND_AFTER_DAYS = 21;
export const WAITING_CARD_DAYS = 14; // an unanswered card older than this may be posted again
export const RECENT_CONTACT_DAYS = 14;
export const SCHOOL_CARDS_PER_WEEK = 2;
export const SENT_PER_SEMESTER = 2;
export const SUBJECT = 'Checking in on PeerTeach';

export type NudgeKind = 'first' | 'second';
export type NudgeAction = 'previewed' | 'drafted' | 'sent' | 'skipped' | 'held_out' | 'opted_out' | 'failed';
export type NudgeMode = 'preview' | 'draft' | 'live';
const KINDS: readonly string[] = ['first', 'second'];
const ACTIONS: readonly string[] = ['previewed', 'drafted', 'sent', 'skipped', 'held_out', 'opted_out', 'failed'];

export function parseMode(v: string | undefined): NudgeMode {
  const mode = String(v ?? '').trim().toLowerCase();
  return mode === 'live' || mode === 'draft' ? mode : 'preview';
}

// ---- dates ----

const dayNumber = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86400000);
export const daysBetween = (from: string, to: string) => dayNumber(to) - dayNumber(from);

// How many quiet days count: `base`, plus 7 for each holiday week the last `base` days touch.
export function quietDays(today: string, base: number): number {
  return base + 7 * holidayWeeksTouching(addDays(today, -(base - 1)), today);
}

// A teacher is lapsed when their last session is on or before this day.
export function lastBefore(today: string): string {
  return addDays(today, -quietDays(today, LAPSE_DAYS));
}

// Why the job does nothing today, or null on a day it runs: only Tuesday to Thursday, never in a
// holiday week or the week after one (teachers are digging out), never in the summer pause.
// `today` is the Pacific date.
export function noRunReason(today: string, opts: { anyWeekday?: boolean } = {}): string | null {
  if (isSummerPause(today)) return 'summer pause';
  if (inHolidayWeek(today)) return 'holiday week';
  if (inHolidayWeek(addDays(today, -7))) return 'first week after a holiday week';
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  if (!opts.anyWeekday && (dow < 2 || dow > 4)) return 'not a Tuesday, Wednesday or Thursday';
  return null;
}

// Aug-Dec and Jan-Jun (July belongs to the spring, and is inside the summer pause anyway).
export function semesterStart(today: string): string {
  const [y, m] = today.split('-').map(Number);
  return `${y}-${m >= 8 ? '08' : '01'}-01`;
}

// ---- the feed ----

export interface NudgeRow { kind: NudgeKind; action: NudgeAction; lapse: string; createdAt: string; day: string }
export interface NudgeClass { name: string; sessions: number }

// One teacher from the nudge-candidates feed, tidied. Every field of the feed may be missing.
export interface NudgeTeacher {
  teacherId: string;
  firstName: string;
  lastName: string;
  email: string; // lower-cased; '' when missing or not an address
  schoolKey: string; // normalised nces_school_id
  ncesSchoolId: string; // as the feed sent it
  districtKey: string;
  schoolName: string;
  state: string; // two-letter code when the feed gives a usable one, else ''
  sessionsYear: number;
  firstSessionDate: string;
  lastSessionDate: string;
  classes: NudgeClass[];
  optedOut: boolean;
  nudges: NudgeRow[]; // oldest first
}

const text = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/\s+/g, ' ').trim() : '');
const count = (v: unknown): number => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);
const day = (v: unknown): string => (isDate(v) ? v.slice(0, 10) : '');
const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[a-z]{2,}$/i;

// Null for an entry with no teacher_id (junk); anything else missing becomes blank and is then
// turned away by the rules.
export function parseTeacher(raw: unknown): NudgeTeacher | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const teacherId = text(r.teacher_id);
  if (!teacherId) return null;
  const email = text(r.email).toLowerCase();
  const nudges: NudgeRow[] = [];
  for (const n of (Array.isArray(r.nudges) ? r.nudges : []) as Array<Record<string, unknown>>) {
    if (!n || typeof n !== 'object' || !KINDS.includes(String(n.kind)) || !ACTIONS.includes(String(n.action))) continue;
    const createdAt = isDate(n.created_at) && Number.isFinite(Date.parse(String(n.created_at))) ? String(n.created_at) : '';
    if (!createdAt) continue;
    nudges.push({ kind: n.kind as NudgeKind, action: n.action as NudgeAction, lapse: day(n.lapse_started_on), createdAt, day: createdAt.slice(0, 10) });
  }
  nudges.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const classes: NudgeClass[] = [];
  for (const c of (Array.isArray(r.classes) ? r.classes : []) as Array<Record<string, unknown>>) {
    if (c && typeof c === 'object' && count(c.sessions) > 0) classes.push({ name: text(c.class_name), sessions: count(c.sessions) });
  }
  return {
    teacherId, firstName: text(r.first_name), lastName: text(r.last_name),
    email: EMAIL_RE.test(email) ? email : '',
    schoolKey: normNces(r.nces_school_id), ncesSchoolId: text(r.nces_school_id), districtKey: normNces(r.nces_district_id),
    schoolName: text(r.school_name), state: stateCode(r.state), sessionsYear: count(r.sessions_year),
    firstSessionDate: day(r.first_session_date), lastSessionDate: day(r.last_session_date),
    classes, optedOut: r.opted_out === true || r.opted_out === 'true', nudges,
  };
}

// ---- where the teacher is (for the hours an email may go out) ----

// State FIPS codes: the first two digits of a 12-digit NCES school ID.
const FIPS_STATE: Record<string, string> = {
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT', '10': 'DE', '11': 'DC', '12': 'FL', '13': 'GA', '15': 'HI', '16': 'ID',
  '17': 'IL', '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME', '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN', '28': 'MS', '29': 'MO',
  '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH', '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA',
  '44': 'RI', '45': 'SC', '46': 'SD', '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA', '54': 'WV', '55': 'WI', '56': 'WY',
};
const STATE_CODES: readonly string[] = Object.values(FIPS_STATE);

// A two-letter state code we know, or ''.
export function stateCode(v: unknown): string {
  const code = text(v).toUpperCase();
  return STATE_CODES.includes(code) ? code : '';
}

// The state a public school's 12-digit NCES ID starts with, or '' (private schools' IDs are
// shorter and carry no state).
export function stateFromNces(ncesSchoolId: unknown): string {
  const id = text(ncesSchoolId);
  return /^\d{12}$/.test(id) ? FIPS_STATE[id.slice(0, 2)] ?? '' : '';
}

export const SEND_FROM_HOUR = 7;
export const SEND_UNTIL_HOUR = 18;

// Null when an email may go out now, else what time it is for the teacher ("9:40pm",
// "Saturday 10:15am"). Weekdays 7am to 6pm in `timeZone`.
export function outsideSendHours(now: Date, timeZone: string): string | null {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long', hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const hour = Number(get('hour')) % 24;
  const weekend = ['Saturday', 'Sunday'].includes(get('weekday'));
  if (!weekend && hour >= SEND_FROM_HOUR && hour < SEND_UNTIL_HOUR) return null;
  const clock = `${hour % 12 || 12}:${get('minute')}${hour < 12 ? 'am' : 'pm'}`;
  return weekend ? `${get('weekday')} ${clock}` : clock;
}

// ---- who gets a card ----

export interface RuleContext {
  today: string;
  mode: NudgeMode;
  excludedTeacherIds: ReadonlySet<string>;
}

// `firstSentAt` (second check-ins only) is when the first one went out: a reply after it means
// no second one.
export type Verdict = { kind: NudgeKind; firstSentAt?: string } | { skip: string };

// What the rules say about one teacher, before anything is looked up in Close.
export function verdict(t: NudgeTeacher, ctx: RuleContext): Verdict {
  if (t.optedOut || t.nudges.some((n) => n.action === 'opted_out')) return { skip: 'opted out' };
  if (isExcludedTeacher({ teacher_id: t.teacherId, email_domain: t.email.split('@')[1] ?? '' }, ctx.excludedTeacherIds)) return { skip: 'internal or partner' };
  if (!t.email) return { skip: 'no usable email' };
  if (!t.schoolKey) return { skip: 'no school ID' };
  if (t.sessionsYear < MIN_SESSIONS) return { skip: 'fewer than 3 sessions' };
  if (!t.lastSessionDate || t.lastSessionDate > lastBefore(ctx.today)) return { skip: 'not lapsed' };
  if (t.nudges.filter((n) => n.action === 'sent' && n.day >= semesterStart(ctx.today)).length >= SENT_PER_SEMESTER) return { skip: 'two already sent this semester' };

  const lapse = t.nudges.filter((n) => n.lapse === t.lastSessionDate);
  const has = (kind: NudgeKind, action: NudgeAction) => lapse.some((n) => n.kind === kind && n.action === action);
  if (has('second', 'sent')) return { skip: 'both check-ins sent' };
  const firstSent = lapse.find((n) => n.kind === 'first' && n.action === 'sent');
  const kind: NudgeKind = firstSent ? 'second' : 'first';
  if (firstSent && firstSent.day > addDays(ctx.today, -quietDays(ctx.today, SECOND_AFTER_DAYS))) return { skip: 'second check-in not due yet' };
  if (has(kind, 'skipped')) return { skip: 'skipped by a person' };
  // A preview is not a card anyone can send from, so it only holds a teacher back while the job
  // is still in preview mode.
  if (ctx.mode === 'preview' && has(kind, 'previewed')) return { skip: 'already previewed' };
  const drafted = lapse.filter((n) => n.kind === kind && n.action === 'drafted').pop();
  if (drafted && daysBetween(drafted.day, ctx.today) < WAITING_CARD_DAYS) return { skip: 'card already waiting' };
  return firstSent ? { kind, firstSentAt: firstSent.createdAt } : { kind };
}

// FNV-1a: the same teacher always lands on the same side, on every run and every machine.
export function stableHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// Until (and on) NUDGE_HOLDOUT_UNTIL, teachers whose ID hashes odd get no card, so there is a
// group to compare against. No date = no holdout.
export function isHeldOut(teacherId: string, today: string, holdoutUntil: string | null): boolean {
  return !!holdoutUntil && today <= holdoutUntil && stableHash(teacherId) % 2 === 1;
}

export const heldOutLogged = (t: NudgeTeacher) => t.nudges.some((n) => n.action === 'held_out' && n.lapse === t.lastSessionDate);

// Cards already made this Mon-Sun week, per school (normalised NCES). A card that was drafted and
// then sent has two rows and counts once. Only teachers the feed returned can be counted.
export function schoolCardsThisWeek(teachers: NudgeTeacher[], today: string): Map<string, number> {
  const monday = weekStart(today);
  const out = new Map<string, number>();
  for (const t of teachers) {
    const cards = new Set(t.nudges.filter((n) => n.day >= monday && ['drafted', 'sent', 'previewed'].includes(n.action)).map((n) => `${n.kind}|${n.lapse}`));
    if (cards.size) out.set(t.schoolKey, (out.get(t.schoolKey) ?? 0) + cards.size);
  }
  return out;
}

// Lapsed longest first, so when a school is over its weekly limit the newest lapses wait.
export function longestLapsedFirst(a: NudgeTeacher, b: NudgeTeacher): number {
  return a.lastSessionDate.localeCompare(b.lastSessionDate) || a.teacherId.localeCompare(b.teacherId);
}

// ---- Close email activity ----

// One email on a Close lead, as the rules need it (addresses lower-cased).
export interface LeadEmail { direction: 'incoming' | 'outgoing'; date: string; from: string; to: string[] }

const involves = (e: LeadEmail, address: string) => e.from === address || e.to.includes(address);
const after = (e: LeadEmail, sinceIso: string) => Date.parse(e.date) > Date.parse(sinceIso);

// Someone on the team and this teacher have been in touch since `sinceIso`: wait.
export function contactedSince(emails: LeadEmail[], address: string, sinceIso: string): boolean {
  return emails.some((e) => involves(e, address) && after(e, sinceIso));
}

// The teacher wrote back after the first check-in: no second one.
export function repliedSince(emails: LeadEmail[], address: string, sinceIso: string): boolean {
  return emails.some((e) => e.direction === 'incoming' && e.from === address && after(e, sinceIso));
}

// ---- the emails (templates; a person can edit before sending) ----

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// Nothing from the feed may bring an em or en dash (or its relatives) into an email.
const DASH = /[\u2012-\u2015\u2212]/;
const noDashes = (s: string) => s.replace(new RegExp(DASH.source, 'g'), '-');

// "your Period 3 class", or "your class" when the name can't be dropped into a sentence.
export function classPhrase(classes: NudgeClass[]): string {
  if (classes.length >= 2) return 'your classes';
  const name = classes[0]?.name ?? '';
  const looksLikeAnId = !/[a-z]{2}/i.test(name) || /^[0-9a-f]{8}-?[0-9a-f]{4}/i.test(name) || /^\S*\d{4,}\S*$/.test(name);
  if (!name || name.length > 40 || /class/i.test(name) || looksLikeAnId || DASH.test(name) || /[<>{}|\\]/.test(name)) return 'your class';
  return `your ${name} class`;
}

// Only ever a season that is true of both the first session and today; otherwise the vague one.
export function whenPhrase(firstSessionDate: string, today: string): string {
  if (!firstSessionDate || firstSessionDate > today) return 'earlier this year';
  const [fy, fm] = firstSessionDate.split('-').map(Number);
  const [ty, tm] = today.split('-').map(Number);
  if (fm >= 8 && fm <= 11 && tm >= 8 && fy === ty) return 'earlier this fall';
  const winterYear = (y: number, m: number) => (m === 12 ? y + 1 : y); // December belongs to the winter that ends next year
  if ((fm === 12 || fm <= 2) && (tm === 12 || tm <= 3) && winterYear(fy, fm) === winterYear(ty, tm)) return 'this winter';
  if (fm >= 3 && fm <= 6 && tm >= 3 && tm <= 6 && fy === ty) return 'this spring';
  return 'earlier this year';
}

export const lastDatePhrase = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;

export interface NudgeEmail { subject: string; body: string }
export interface EmailSettings { senderName: string; calendarUrl: string }

export function buildEmail(kind: NudgeKind, t: NudgeTeacher, today: string, s: EmailSettings): NudgeEmail {
  const hi = `Hi ${noDashes(t.firstName) || 'there'},`;
  const sender = noDashes(s.senderName) || 'Katie';
  if (kind === 'second') {
    return { subject: SUBJECT, body: `${hi}\n\nJust floating this back up in case it got buried. If PeerTeach isn't a fit for your class right now, no worries at all: just reply and I won't nudge again. If you'd like to get going again, I can help you set up the next session in a few minutes.\n\n${sender}` };
  }
  // One class: its own count. Several, or none listed: the year's count.
  const n = t.classes.length === 1 ? t.classes[0].sessions : t.sessionsYear;
  const call = s.calendarUrl ? ` or hop on a quick call: ${s.calendarUrl}` : '';
  return {
    subject: SUBJECT,
    body: `${hi}\n\nI noticed ${classPhrase(t.classes)} ran ${n} PeerTeach ${n === 1 ? 'session' : 'sessions'} ${whenPhrase(t.firstSessionDate, today)}, and it's been quiet since ${lastDatePhrase(t.lastSessionDate)}. Totally understand if the calendar got away from you!\n\nIs there anything that got in the way? If it's finding the time, I'm happy to help you pick a slot that fits your week${call}.\n\n${sender}`,
  };
}

// ---- Slack cards ----
//
// A button's value is capped at 2,000 characters, so it carries only who the card is about
// (CardData). The email itself lives in two plain-text blocks of the card and is read back from
// there when someone clicks Approve, so what is sent is exactly what the card shows.

export const ACTION_PREFIX = 'lapse_nudge_';
export const ACTION = { approve: 'lapse_nudge_approve', edit: 'lapse_nudge_edit', skip: 'lapse_nudge_skip', never: 'lapse_nudge_never' } as const;
export const EDIT_MODAL = 'lapse_nudge_edit_modal';
const SUBJECT_BLOCK = 'lapse_nudge_subject';
const BODY_BLOCK = 'lapse_nudge_body';
const ACTIONS_BLOCK = 'lapse_nudge_actions';
export const MAX_BODY = 2900; // a Slack section holds 3,000 characters

// Who a card is about. Short keys: this is the button value.
export interface CardData {
  t: string; // teacher_id
  s: string; // nces_school_id, as the feed sent it
  k: NudgeKind;
  l: string; // lapse_started_on (the teacher's last session date)
  lead: string; // the school's Close lead
  to: string; // the teacher's email
  name: string;
  school: string;
  n: number; // sessions this year
  days: number; // days since the last session, when the card was made
  st?: string; // the teacher's state, when the feed gave one
}

export function cardData(t: NudgeTeacher, kind: NudgeKind, leadId: string, today: string): CardData {
  return {
    t: t.teacherId, s: t.ncesSchoolId, k: kind, l: t.lastSessionDate, lead: leadId, to: t.email,
    name: ([t.firstName, t.lastName].filter(Boolean).join(' ') || '(no name)').slice(0, 80),
    school: (t.schoolName || '(no school name)').slice(0, 80), n: t.sessionsYear, days: daysBetween(t.lastSessionDate, today),
    ...(t.state ? { st: t.state } : {}),
  };
}

export function parseCardData(value: unknown): CardData | null {
  try {
    const d = JSON.parse(String(value));
    const ok = d && typeof d === 'object' && text(d.t) && KINDS.includes(d.k) && isDate(d.l) && text(d.lead) && EMAIL_RE.test(String(d.to));
    return ok ? { t: String(d.t), s: text(d.s), k: d.k, l: d.l.slice(0, 10), lead: String(d.lead), to: String(d.to).toLowerCase(), name: text(d.name), school: text(d.school), n: count(d.n), days: count(d.days), ...(stateCode(d.st) ? { st: stateCode(d.st) } : {}) } : null;
  } catch {
    return null;
  }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const button = (label: string, action_id: string, value: string, extra: Record<string, any> = {}) => ({ type: 'button', text: { type: 'plain_text', text: label, emoji: true }, action_id, value, ...extra });
const whoLine = (d: CardData) => `*${esc(d.name)}* (${esc(d.to)}) at ${esc(d.school)}`;

export interface CardOptions {
  mode: NudgeMode;
  sender: string; // e.g. "Katie (katie@peerteach.org)"
  leadUrl: string;
  note?: string; // a line under the email, e.g. who edited it or what went wrong
}

export function cardBlocks(d: CardData, email: NudgeEmail, o: CardOptions): any[] {
  const value = JSON.stringify(d);
  const preview = o.mode === 'preview';
  const approve = o.mode === 'draft' ? ':white_check_mark: Approve & save draft' : ':white_check_mark: Approve & send';
  return [
    { type: 'header', text: { type: 'plain_text', text: d.k === 'second' ? 'Second check-in' : 'Check-in for a teacher who stopped', emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: `*Why:* ${esc(d.school)}: ${d.n} session${d.n === 1 ? '' : 's'} this year, last session ${d.l}, ${d.days} days ago. <${o.leadUrl}|Open the school in Close>` } },
    { type: 'section', text: { type: 'mrkdwn', text: `*To:* ${esc(d.name)} (${esc(d.to)})\n*From:* ${esc(o.sender)}, through Close` } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: '*Subject*' }] },
    { type: 'section', block_id: SUBJECT_BLOCK, text: { type: 'plain_text', text: email.subject, emoji: false } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: '*Message*' }] },
    { type: 'section', block_id: BODY_BLOCK, text: { type: 'plain_text', text: email.body, emoji: false } },
    ...(preview ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: ':eyes: Preview only: sending is switched off' }] }] : []),
    ...(o.note ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: o.note }] }] : []),
    {
      type: 'actions',
      block_id: ACTIONS_BLOCK,
      elements: [
        ...(preview ? [] : [button(approve, ACTION.approve, value, { style: 'primary' }), button(':pencil2: Edit', ACTION.edit, value)]),
        button(':x: Skip', ACTION.skip, value),
        button(':no_entry_sign: Never nudge this teacher', ACTION.never, value, {
          style: 'danger',
          confirm: { title: { type: 'plain_text', text: 'Never nudge this teacher?' }, text: { type: 'plain_text', text: `${d.name} will get no more check-in emails from this job.` }, confirm: { type: 'plain_text', text: 'Never nudge' }, deny: { type: 'plain_text', text: 'Cancel' } },
        }),
      ],
    },
  ];
}

// The email as the card shows it now (after any edit), or null when the card no longer holds one.
export function readCardEmail(blocks: unknown): NudgeEmail | null {
  const find = (id: string) => {
    const b = (Array.isArray(blocks) ? blocks : []).find((x: any) => x?.block_id === id);
    return typeof b?.text?.text === 'string' ? unesc(b.text.text) : '';
  };
  const subject = find(SUBJECT_BLOCK).trim();
  const body = find(BODY_BLOCK).trim();
  return subject && body ? { subject, body } : null;
}

// Whether the card still has its buttons. A card someone already acted on has none, which is how
// a second click (from a Slack window still showing the old card) is told apart.
export function cardIsOpen(blocks: unknown): boolean {
  return (Array.isArray(blocks) ? blocks : []).some((b: any) => b?.type === 'actions' && (b.elements ?? []).some((e: any) => String(e?.action_id ?? '').startsWith(ACTION_PREFIX)));
}

// What a card becomes once someone has dealt with it: one line, who it was for, and (when an
// email went out) the email. No buttons.
export function doneBlocks(headline: string, d: CardData, email?: NudgeEmail): any[] {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `${headline}\n${whoLine(d)}, last session ${d.l}` } },
    ...(email ? [{ type: 'section', text: { type: 'plain_text', text: `${email.subject}\n\n${email.body}`.slice(0, 3000), emoji: false } }] : []),
  ];
}

export function editModal(d: CardData, email: NudgeEmail, where: { channel: string; ts: string }): any {
  return {
    type: 'modal',
    callback_id: EDIT_MODAL,
    private_metadata: JSON.stringify({ channel: where.channel, ts: where.ts, d }),
    title: { type: 'plain_text', text: 'Edit the check-in' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `To ${whoLine(d)}. Saving changes the card; nothing is sent until someone clicks Approve.` } },
      { type: 'input', block_id: 'subject', label: { type: 'plain_text', text: 'Subject' }, element: { type: 'plain_text_input', action_id: 'value', initial_value: email.subject.slice(0, 150), max_length: 150 } },
      { type: 'input', block_id: 'body', label: { type: 'plain_text', text: 'Message' }, element: { type: 'plain_text_input', action_id: 'value', multiline: true, initial_value: email.body.slice(0, MAX_BODY), max_length: MAX_BODY } },
    ],
  };
}

// What a submitted edit modal holds, or null when it isn't one of ours.
export function readEditModal(view: any): { channel: string; ts: string; d: CardData; email: NudgeEmail } | null {
  try {
    const meta = JSON.parse(String(view?.private_metadata ?? ''));
    const d = parseCardData(JSON.stringify(meta.d));
    const subject = String(view?.state?.values?.subject?.value?.value ?? '').trim();
    const body = String(view?.state?.values?.body?.value?.value ?? '').trim();
    if (!d || !text(meta.channel) || !text(meta.ts)) return null;
    return { channel: String(meta.channel), ts: String(meta.ts), d, email: { subject, body } };
  } catch {
    return null;
  }
}

// ---- the run's one-line summary ----

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// Null when the run made no cards and held nobody out: a quiet run says nothing.
export function summaryLine(r: { mode: NudgeMode; cards: number; heldOut: number; waiting: number; senderName?: string }): string | null {
  if (!r.cards && !r.heldOut) return null;
  const parts: string[] = [];
  if (r.cards) parts.push(r.mode === 'preview' ? `${plural(r.cards, 'check-in preview', 'check-in previews')} posted (sending is switched off)` : `${plural(r.cards, 'check-in draft', 'check-in drafts')} posted${r.mode === 'draft' ? ` (approving saves a draft for ${r.senderName || 'Katie'} in Close)` : ''}`);
  if (r.heldOut) parts.push(`${r.heldOut} held out for the comparison group`);
  if (r.waiting) parts.push(`${r.waiting} waiting: recent contact or weekly school limit`);
  return `:wave: ${parts.join(', ')}`;
}

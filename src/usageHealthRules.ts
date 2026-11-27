// The rules behind the nightly usage health job (src/usageHealth.ts). Pure: no network, no env,
// no clock; everything is passed in, so scripts/checkUsageHealth.ts can assert all of it.
//
// Decided with Soren (2026-11-26):
// - The school year starts August 1.
// - "Recent" is the last 28 days, stretched back a week for each holiday week it touches, so a
//   school isn't marked down for Thanksgiving or winter break.
// - Internal and partner teachers count for nothing.
// - On track: some teacher ran 3+ sessions in the window. Light: sessions, but no teacher with 3.
//   Stalled: none in the window, 3+ earlier this year. Silent: none in the window, fewer than 3.

export const EXCLUDED_EMAIL_DOMAINS = ['peerteach.org', 'leanlabeducation.org'];
export const WINDOW_DAYS = 28;
export const ON_TRACK_TEACHER_SESSIONS = 3;
export const STALLED_MIN_YEAR_SESSIONS = 3;
export const STALE_AFTER_DAYS = 4;

// Best to worst; "slipped" means moving right.
export const HEALTH_LABELS = ['On track', 'Light', 'Stalled', 'Silent'] as const;
export type HealthLabel = (typeof HEALTH_LABELS)[number];

// The Close lead custom fields the job writes (all text).
export const FIELD = {
  health: 'PT Health',
  sessions: 'PT Sessions (28d)',
  activeTeachers: 'PT Active Teachers (28d)',
  teachersEver: 'PT Teachers Ever',
  lastSession: 'PT Last Session',
  updated: 'PT Health Updated',
  schoolsHealth: 'PT Schools Health', // district leads only
} as const;
export const SCHOOL_FIELDS = [FIELD.health, FIELD.sessions, FIELD.activeTeachers, FIELD.teachersEver, FIELD.lastSession, FIELD.updated];
export const ALL_FIELDS = [...SCHOOL_FIELDS, FIELD.schoolsHealth];

// ---- dates (YYYY-MM-DD strings, UTC) ----

const DAY_MS = 86400000;
const toMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const fromMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => fromMs(toMs(d) + n * DAY_MS);
export const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) && Number.isFinite(toMs(v.slice(0, 10)));

export function schoolYearStart(today: string): string {
  const [y, m] = today.split('-').map(Number);
  return `${m >= 8 ? y : y - 1}-08-01`;
}

// The Monday of the Mon-Sun week containing d.
function weekStart(d: string): string {
  const dow = new Date(toMs(d)).getUTCDay(); // 0 = Sunday
  return addDays(d, -((dow + 6) % 7));
}

export function thanksgiving(year: number): string {
  const nov1Dow = new Date(Date.UTC(year, 10, 1)).getUTCDay();
  const firstThursday = 1 + ((4 - nov1Dow + 7) % 7);
  return `${year}-11-${String(firstThursday + 21).padStart(2, '0')}`;
}

// The 28 days ending today, plus 7 more days back for each holiday week (Thanksgiving, Dec 25,
// Jan 1) those 28 days touch. Holidays are checked against the plain 28 days only, so the
// extension itself never pulls in another holiday.
export function recentWindow(today: string): { from: string; to: string; holidayWeeks: number } {
  const baseFrom = addDays(today, -(WINDOW_DAYS - 1));
  const year = Number(today.slice(0, 4));
  let holidayWeeks = 0;
  for (const y of [year - 1, year]) {
    for (const holiday of [thanksgiving(y), `${y}-12-25`, `${y + 1}-01-01`]) {
      const start = weekStart(holiday);
      if (start <= today && addDays(start, 6) >= baseFrom) holidayWeeks++;
    }
  }
  return { from: addDays(baseFrom, -7 * holidayWeeks), to: today, holidayWeeks };
}

// A feed whose newest usage is more than 4 days old is broken (or missing its date): acting on
// it would mark every school stalled.
export function isFeedStale(latestUsageDate: unknown, today: string): boolean {
  if (!isDate(latestUsageDate)) return true;
  return toMs(today) - toMs(latestUsageDate.slice(0, 10)) > STALE_AFTER_DAYS * DAY_MS;
}

// ---- usage -> schools ----

// NCES IDs compare with leading zeros ignored: Close holds 61674002130, 421641 and 01160686
// where the usage feed holds 12 zero-padded digits.
export function normNces(id: unknown): string {
  return String(id ?? '').replace(/\D/g, '').replace(/^0+/, '');
}

// One entry of the Sales Ops health feed: a teacher at a school. Every field may be missing.
export interface UsageTeacher {
  teacher_id?: string | number | null;
  nces_school_id?: string | number | null;
  nces_district_id?: string | number | null;
  school_name?: string | null;
  district_name?: string | null;
  sessions_window?: number | null;
  sessions_year?: number | null;
  first_session_date?: string | null;
  last_session_date?: string | null;
  email_domain?: string | null;
}

export function isExcludedTeacher(t: UsageTeacher, excludedTeacherIds: ReadonlySet<string>): boolean {
  const domain = String(t.email_domain ?? '').trim().toLowerCase().replace(/^@/, '');
  if (domain && EXCLUDED_EMAIL_DOMAINS.includes(domain)) return true;
  const id = String(t.teacher_id ?? '').trim();
  return !!id && excludedTeacherIds.has(id);
}

export function parseExcludedIds(csv: string | undefined): Set<string> {
  return new Set((csv ?? '').split(',').map((s) => s.trim()).filter(Boolean));
}

export interface SchoolUsage {
  key: string; // normalised nces_school_id
  ncesSchoolId: string; // as the feed sent it
  districtKey: string;
  schoolName: string;
  districtName: string;
  sessionsWindow: number;
  activeTeachers: number;
  teachersEver: number;
  sessionsYear: number;
  lastSessionDate: string;
  maxTeacherSessionsWindow: number;
}

const count = (v: unknown): number => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);

// Schools with at least one session this school year, keyed by normalised NCES school ID.
export function aggregateSchools(teachers: unknown, excludedTeacherIds: ReadonlySet<string>): Map<string, SchoolUsage> {
  const out = new Map<string, SchoolUsage>();
  for (const t of (Array.isArray(teachers) ? teachers : []) as UsageTeacher[]) {
    if (!t || typeof t !== 'object' || isExcludedTeacher(t, excludedTeacherIds)) continue;
    const key = normNces(t.nces_school_id);
    if (!key) continue;
    const win = count(t.sessions_window);
    // A session in the window is a session this year, whatever the feed's year count says.
    const year = Math.max(count(t.sessions_year), win);
    if (!year) continue;
    let s = out.get(key);
    if (!s) {
      s = { key, ncesSchoolId: String(t.nces_school_id), districtKey: '', schoolName: '', districtName: '', sessionsWindow: 0, activeTeachers: 0, teachersEver: 0, sessionsYear: 0, lastSessionDate: '', maxTeacherSessionsWindow: 0 };
      out.set(key, s);
    }
    s.districtKey = s.districtKey || normNces(t.nces_district_id);
    s.schoolName = s.schoolName || String(t.school_name ?? '').trim();
    s.districtName = s.districtName || String(t.district_name ?? '').trim();
    s.sessionsWindow += win;
    s.sessionsYear += year;
    s.teachersEver += 1;
    if (win >= 1) s.activeTeachers += 1;
    s.maxTeacherSessionsWindow = Math.max(s.maxTeacherSessionsWindow, win);
    if (isDate(t.last_session_date) && t.last_session_date.slice(0, 10) > s.lastSessionDate) s.lastSessionDate = t.last_session_date.slice(0, 10);
  }
  return out;
}

export function healthLabel(s: Pick<SchoolUsage, 'sessionsWindow' | 'sessionsYear' | 'maxTeacherSessionsWindow'>): HealthLabel {
  if (s.maxTeacherSessionsWindow >= ON_TRACK_TEACHER_SESSIONS) return 'On track';
  if (s.sessionsWindow >= 1) return 'Light';
  return s.sessionsYear >= STALLED_MIN_YEAR_SESSIONS ? 'Stalled' : 'Silent';
}

const rank = (label: string): number => HEALTH_LABELS.indexOf(label as HealthLabel);
export function isWorse(newLabel: string, oldLabel: string): boolean {
  return rank(oldLabel) >= 0 && rank(newLabel) > rank(oldLabel);
}

// e.g. "6 schools: 3 on track, 2 light, 1 stalled" (zero counts left out).
export function rollupLine(labels: HealthLabel[]): string {
  const parts = HEALTH_LABELS.map((l) => ({ l, n: labels.filter((x) => x === l).length })).filter((p) => p.n > 0);
  return `${labels.length} ${labels.length === 1 ? 'school' : 'schools'}: ${parts.map((p) => `${p.n} ${p.l.toLowerCase()}`).join(', ')}`;
}

// ---- schools -> Close leads ----

// A Close lead as the rules need it. `name` is the lead's own name (blank on the unnamed leads an
// old per-teacher import created); `current` is what it holds in the PT fields, by field name.
export interface HealthLead {
  id: string;
  name: string;
  dateCreated: string;
  schoolNces: string;
  districtNces: string;
  current: Record<string, string>;
}

export interface DuplicateReport { nces: string; chosen: { id: string; name: string }; ignored: Array<{ id: string; name: string }> }

const named = (l: HealthLead) => l.name.trim() !== '';
// Named before unnamed, then oldest first (no creation date sorts last).
function preferLead(a: HealthLead, b: HealthLead): number {
  if (named(a) !== named(b)) return named(a) ? -1 : 1;
  return (a.dateCreated || '9999').localeCompare(b.dateCreated || '9999') || a.id.localeCompare(b.id);
}

// The one lead to write to for each School NCES, and every NCES that more than one lead shares.
export function chooseSchoolLeads(leads: HealthLead[]): { byKey: Map<string, HealthLead>; duplicates: DuplicateReport[] } {
  const groups = new Map<string, HealthLead[]>();
  for (const l of leads) {
    const key = normNces(l.schoolNces);
    if (key) groups.set(key, [...(groups.get(key) ?? []), l]);
  }
  const byKey = new Map<string, HealthLead>();
  const duplicates: DuplicateReport[] = [];
  for (const [key, group] of groups) {
    const [chosen, ...rest] = [...group].sort(preferLead);
    byKey.set(key, chosen);
    if (rest.length) duplicates.push({ nces: chosen.schoolNces, chosen: { id: chosen.id, name: chosen.name }, ignored: rest.map((r) => ({ id: r.id, name: r.name })) });
  }
  return { byKey, duplicates };
}

export interface LeadUpdate { leadId: string; leadName: string; fields: Record<string, string> }
export interface MatchedSchool { key: string; leadId: string; leadName: string; schoolName: string; label: HealthLabel; lastSessionDate: string }
export interface UnmatchedSchool { schoolName: string; ncesSchoolId: string; sessionsWindow: number; sessionsYear: number }

export interface HealthPlan {
  labelCounts: Record<HealthLabel, number>; // every school with usage this year, matched or not
  matched: MatchedSchool[];
  unmatched: UnmatchedSchool[]; // most sessions first
  duplicates: DuplicateReport[];
  schoolUpdates: LeadUpdate[]; // only leads whose values change
  schoolsUnchanged: number;
  wentSilent: number; // leads labelled on an earlier run that are no longer in the usage data
  districtRollups: Array<{ leadId: string; leadName: string; line: string; changed: boolean }>;
  districtUpdates: LeadUpdate[];
}

// The fields to send for a lead, or null when it already holds them all. PT Health Updated is
// left out of the comparison, so an unchanged school isn't rewritten every night.
export function changedFields(current: Record<string, string>, desired: Record<string, string>): Record<string, string> | null {
  const same = Object.entries(desired).every(([k, v]) => k === FIELD.updated || String(current[k] ?? '') === v);
  return same ? null : desired;
}

export function planHealth(schools: Map<string, SchoolUsage>, leads: HealthLead[], today: string): HealthPlan {
  const { byKey, duplicates } = chooseSchoolLeads(leads);
  const plan: HealthPlan = {
    labelCounts: { 'On track': 0, Light: 0, Stalled: 0, Silent: 0 },
    matched: [], unmatched: [], duplicates, schoolUpdates: [], schoolsUnchanged: 0, wentSilent: 0, districtRollups: [], districtUpdates: [],
  };
  // District key -> labels of the school leads written this run.
  const byDistrict = new Map<string, HealthLabel[]>();
  const addToDistrict = (districtKey: string, label: HealthLabel) => {
    if (districtKey) byDistrict.set(districtKey, [...(byDistrict.get(districtKey) ?? []), label]);
  };
  const queue = (lead: HealthLead, desired: Record<string, string>) => {
    const fields = changedFields(lead.current, desired);
    if (fields) plan.schoolUpdates.push({ leadId: lead.id, leadName: lead.name, fields }); else plan.schoolsUnchanged++;
  };

  for (const s of schools.values()) {
    const label = healthLabel(s);
    plan.labelCounts[label]++;
    const lead = byKey.get(s.key);
    if (!lead) {
      plan.unmatched.push({ schoolName: s.schoolName, ncesSchoolId: s.ncesSchoolId, sessionsWindow: s.sessionsWindow, sessionsYear: s.sessionsYear });
      continue;
    }
    plan.matched.push({ key: s.key, leadId: lead.id, leadName: lead.name, schoolName: s.schoolName || lead.name, label, lastSessionDate: s.lastSessionDate });
    addToDistrict(normNces(lead.districtNces) || s.districtKey, label);
    queue(lead, {
      [FIELD.health]: label,
      [FIELD.sessions]: String(s.sessionsWindow),
      [FIELD.activeTeachers]: String(s.activeTeachers),
      [FIELD.teachersEver]: String(s.teachersEver),
      [FIELD.lastSession]: s.lastSessionDate,
      [FIELD.updated]: today,
    });
  }
  plan.unmatched.sort((a, b) => b.sessionsWindow - a.sessionsWindow || b.sessionsYear - a.sessionsYear || a.schoolName.localeCompare(b.schoolName));

  // A lead labelled on an earlier run whose school has dropped out of the usage data (a new
  // school year, or its only teacher is now excluded) must not keep a stale "On track". Its last
  // session date is left as it was. Leads that never had usage get nothing.
  for (const [key, lead] of byKey) {
    if (schools.has(key) || !String(lead.current[FIELD.health] ?? '').trim()) continue;
    plan.wentSilent++;
    addToDistrict(normNces(lead.districtNces), 'Silent');
    queue(lead, { [FIELD.health]: 'Silent', [FIELD.sessions]: '0', [FIELD.activeTeachers]: '0', [FIELD.teachersEver]: '0', [FIELD.updated]: today });
  }

  // District leads (District NCES set, School NCES blank) get only the roll-up line.
  for (const lead of leads) {
    const districtKey = normNces(lead.districtNces);
    if (!districtKey || normNces(lead.schoolNces)) continue;
    const labels = byDistrict.get(districtKey);
    if (!labels?.length) continue;
    const line = rollupLine(labels);
    const changed = String(lead.current[FIELD.schoolsHealth] ?? '') !== line;
    plan.districtRollups.push({ leadId: lead.id, leadName: lead.name, line, changed });
    if (changed) plan.districtUpdates.push({ leadId: lead.id, leadName: lead.name, fields: { [FIELD.schoolsHealth]: line } });
  }
  return plan;
}

// ---- Slack wording (school and lead names only; never a teacher's name or email) ----

export const UNMATCHED_ALERT_MIN_SESSIONS = 5;

const unmatchedLine = (u: UnmatchedSchool) => `• ${u.schoolName || '(no name)'} (${u.ncesSchoolId}): ${u.sessionsWindow} in the window, ${u.sessionsYear} this year`;
const countsLine = (c: Record<HealthLabel, number>) => HEALTH_LABELS.map((l) => `${l} ${c[l]}`).join(', ');

export function dryRunSummary(plan: HealthPlan, ctx: { from: string; to: string; latestUsageDate: string }): string {
  const total = plan.matched.length + plan.unmatched.length;
  const lines = [
    `:bar_chart: *Usage health, DRY RUN (nothing written to Close).* Window ${ctx.from} to ${ctx.to}, usage through ${ctx.latestUsageDate}.`,
    `Schools with sessions this year: ${total} (${countsLine(plan.labelCounts)}); ${plan.matched.length} matched to a Close lead, ${plan.unmatched.length} unmatched.`,
    `Would update ${plan.schoolUpdates.length} school lead${plan.schoolUpdates.length === 1 ? '' : 's'} (${plan.schoolsUnchanged} already up to date${plan.wentSilent ? `, ${plan.wentSilent} no longer in the usage data and going Silent` : ''}) and ${plan.districtUpdates.length} district lead${plan.districtUpdates.length === 1 ? '' : 's'}.`,
  ];
  if (plan.districtRollups.length) {
    lines.push(`*District roll-ups (${plan.districtRollups.length}):*`, ...plan.districtRollups.slice(0, 10).map((d) => `• ${d.leadName || d.leadId}: ${d.line}`));
    if (plan.districtRollups.length > 10) lines.push(`…and ${plan.districtRollups.length - 10} more`);
  }
  if (plan.unmatched.length) {
    lines.push(`*Schools with no Close lead (${plan.unmatched.length > 10 ? `top 10 of ${plan.unmatched.length}` : plan.unmatched.length}, by sessions):*`, ...plan.unmatched.slice(0, 10).map(unmatchedLine));
  }
  if (plan.duplicates.length) {
    lines.push(`*School NCES shared by more than one lead (${plan.duplicates.length}):*`, ...plan.duplicates.slice(0, 10).map((d) => `• ${d.nces}: using ${d.chosen.name.trim() ? `"${d.chosen.name}"` : 'an unnamed lead'}, ignoring ${d.ignored.length} other${d.ignored.length === 1 ? '' : 's'}`));
    if (plan.duplicates.length > 10) lines.push(`…and ${plan.duplicates.length - 10} more`);
  }
  return lines.join('\n');
}

// Live runs: busy schools the job couldn't put anywhere. Null when there are none.
export function unmatchedAlert(plan: HealthPlan): string | null {
  const busy = plan.unmatched.filter((u) => u.sessionsWindow >= UNMATCHED_ALERT_MIN_SESSIONS);
  if (!busy.length) return null;
  return [`:mag: *Usage health: ${busy.length} active school${busy.length === 1 ? ' has' : 's have'} no Close lead* (${UNMATCHED_ALERT_MIN_SESSIONS}+ sessions in the window, nothing was created):`, ...busy.slice(0, 20).map(unmatchedLine), ...(busy.length > 20 ? [`…and ${busy.length - 20} more`] : [])].join('\n');
}

export interface SlippedSchool { schoolName: string; from: HealthLabel; to: HealthLabel; lastSessionDate: string; leadUrl: string }

// Matched schools whose label is worse now than it was (`before`: normalised NCES -> label).
export function slippedSchools(matched: MatchedSchool[], before: Map<string, HealthLabel>, leadUrl: (leadId: string) => string): SlippedSchool[] {
  return matched
    .filter((m) => isWorse(m.label, before.get(m.key) ?? ''))
    .map((m) => ({ schoolName: m.schoolName, from: before.get(m.key)!, to: m.label, lastSessionDate: m.lastSessionDate, leadUrl: leadUrl(m.leadId) }))
    .sort((a, b) => rank(b.to) - rank(a.to) || a.schoolName.localeCompare(b.schoolName));
}

export function slippedMessage(slipped: SlippedSchool[]): string | null {
  if (!slipped.length) return null;
  return [`:chart_with_downwards_trend: *Schools that slipped this week (${slipped.length}):*`, ...slipped.map((s) => `• ${s.schoolName}: ${s.from} → ${s.to}, last session ${s.lastSessionDate || 'unknown'} (<${s.leadUrl}|open in Close>)`)].join('\n');
}

// Slack caps a section at 3,000 characters: long lists go out as several messages, split on lines.
export function chunkLines(text: string, max = 2800): string[] {
  const out: string[] = [];
  let cur = '';
  for (const line of text.split('\n')) {
    const piece = line.slice(0, max);
    if (cur && cur.length + 1 + piece.length > max) { out.push(cur); cur = piece; } else cur = cur ? `${cur}\n${piece}` : piece;
  }
  if (cur) out.push(cur);
  return out;
}

import assert from 'assert';
import { chunkSections,
  FIELD,
  HealthLead,
  aggregateSchools,
  changedFields,
  chooseSchoolLeads,
  healthLabel,
  isExcludedTeacher,
  isFeedStale,
  isSummerPause,
  normNces,
  parseExcludedIds,
  planHealth,
  recentWindow,
  rollupLine,
  schoolYearStart,
  thanksgiving,
} from '../src/usageHealthRules';
import type { SchoolUsage } from '../src/usageHealthRules';
import { buildDigest, digestSections, digestSkipReason, displayName, isSlowing, pacePhrase, schoolPaces, schoolWeeks, shortDate } from '../src/healthDigestRules';
import { runUsageHealth, UsageHealthDeps } from '../src/usageHealth';
import type { ActiveOpportunity, CloseLeadRow } from '../src/closeCrm';

// Offline check of the usage health job (src/usageHealthRules.ts and src/usageHealth.ts): the
// rules with plain asserts, then whole runs on fake Close / Slack / feed. No network.
//   npx ts-node scripts/checkUsageHealth.ts

let passed = 0;
const failures: string[] = [];
function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`PASS | ${label}`); })
    .catch((err) => { failures.push(label); console.log(`FAIL | ${label}\n       ${err instanceof Error ? err.message : err}`); });
}

const lead = (o: Partial<HealthLead> & { id: string }): HealthLead => ({ name: '', dateCreated: '', schoolNces: '', districtNces: '', current: {}, ...o });
const usage = (win: number, year: number, max = win) => ({ sessionsWindow: win, sessionsYear: year, maxTeacherSessionsWindow: max });

// ---- fakes for whole runs ----

const IDS: Array<[string, string]> = [
  ['school nces', 'cf_school'], ['district nces', 'cf_district'],
  ...Object.values(FIELD).map((f): [string, string] => [f.toLowerCase(), `cf_${f}`]),
];
const cf = (name: string) => `custom.cf_${name}`;
const row = (id: string, name: string, dateCreated: string, custom: Record<string, string>): CloseLeadRow => ({ id, name, displayName: name || 'Some Contact', dateCreated, custom });

function closeLeads(): CloseLeadRow[] {
  return [
    // Close holds 11 digits; the feed holds 12.
    row('lead_bollinger', 'Bollinger Canyon Elementary', '2025-03-01T00:00:00Z', { cf_school: '63513007356', cf_district: '635130' }),
    // Older, but unnamed: never written.
    row('lead_bollinger_unnamed', '', '2024-01-01T00:00:00Z', { cf_school: '063513007356', cf_district: '635130' }),
    row('lead_private', 'Private Academy', '2025-05-01T00:00:00Z', { cf_school: '01160686' }),
    // Labelled on an earlier run, no longer in the feed.
    row('lead_gone', 'Quiet School', '2025-05-02T00:00:00Z', { cf_school: '421641', [`cf_${FIELD.health}`]: 'On track', [`cf_${FIELD.sessions}`]: '9', [`cf_${FIELD.lastSession}`]: '2026-09-09' }),
    // A prospect with no usage: left alone.
    row('lead_prospect', 'Prospect School', '2025-05-03T00:00:00Z', { cf_school: '999999', cf_district: '635130' }),
    // Already holds exactly what this run computes (only the run date is older).
    row('lead_same', 'Unchanged School', '2025-05-04T00:00:00Z', {
      cf_school: '55555', cf_district: '635130',
      [`cf_${FIELD.health}`]: 'Light', [`cf_${FIELD.sessions}`]: '2', [`cf_${FIELD.activeTeachers}`]: '1', [`cf_${FIELD.teachersEver}`]: '1', [`cf_${FIELD.lastSession}`]: '2026-11-10', [`cf_${FIELD.updated}`]: '2026-12-01',
    }),
    row('lead_district', 'San Ramon Valley Unified', '2025-01-01T00:00:00Z', { cf_district: '0635130' }),
  ];
}

const teacher = (teacher_id: string, nces_school_id: string, school_name: string, sessions_window: number, sessions_year: number, last_session_date: string, email_domain = 'srvusd.net') =>
  ({ teacher_id, nces_school_id, nces_district_id: '0635130', school_name, district_name: 'San Ramon Valley Unified', sessions_window, sessions_year, first_session_date: '2026-09-01', last_session_date, email_domain });

function feed(latest = '2026-12-01', sameSchoolWindow = 2) {
  return {
    ok: true, latest_usage_date: latest,
    teachers: [
      teacher('1', '063513007356', 'Bollinger Canyon Elementary', 3, 7, '2026-11-16'),
      teacher('2', '063513007356', 'Bollinger Canyon Elementary', 1, 2, '2026-11-20'),
      teacher('3', '063513007356', 'Bollinger Canyon Elementary', 9, 9, '2026-12-01', 'peerteach.org'), // internal
      teacher('999', '063513007356', 'Bollinger Canyon Elementary', 5, 5, '2026-12-01'), // excluded by ID
      { ...teacher('4', '000001160686', 'Private Academy', 0, 4, '2026-10-01'), nces_district_id: null, district_name: null }, // private: no district
      teacher('5', '000000000777', 'No Lead Elementary', 6, 6, '2026-11-30'),
      teacher('6', '000000055555', 'Unchanged School', sameSchoolWindow, Math.max(2, sameSchoolWindow), '2026-11-10'),
      { teacher_id: '7' }, // junk entry: ignored
    ],
  };
}

interface Fake { deps: UsageHealthDeps; updates: Array<{ id: string; body: Record<string, any> }>; notes: string[]; warnings: string[]; reports: string[]; fetches: any[]; ensured: string[]; listed: number; oppReads: number }
function fake(over: Partial<UsageHealthDeps> = {}): Fake {
  const f: Fake = { updates: [], notes: [], warnings: [], reports: [], fetches: [], ensured: [], listed: 0, oppReads: 0, deps: null as any };
  f.deps = {
    fetchUsage: async (q) => { f.fetches.push(q); return feed(); },
    leadFieldIds: async () => new Map(IDS),
    ensureLeadTextField: async (name) => { f.ensured.push(name); return `cf_${name}`; },
    listLeads: async () => { f.listed++; return closeLeads(); },
    activeOpportunities: async () => { f.oppReads++; return [{ leadId: 'lead_district', statusLabel: 'Pilot Launched', dateUpdated: '2026-11-01T00:00:00Z' }]; },
    updateLead: async (id, body) => { f.updates.push({ id, body }); },
    // `notes` is everything posted, in order; `warnings` and `reports` say which channel got it.
    postNote: async (text) => { f.notes.push(text); f.warnings.push(text); },
    postReport: async (text) => { f.notes.push(text); f.reports.push(text); },
    ...over,
  };
  return f;
}

const WED = new Date('2026-12-02T12:30:00Z');
const MON = new Date('2026-12-07T12:30:00Z'); // 4:30am Monday Pacific
const EXPECTED_UPDATES = [
  { id: 'lead_bollinger', body: { [cf(FIELD.health)]: 'On track', [cf(FIELD.sessions)]: '4', [cf(FIELD.activeTeachers)]: '2', [cf(FIELD.teachersEver)]: '2', [cf(FIELD.lastSession)]: '2026-11-20', [cf(FIELD.updated)]: '2026-12-02' } },
  { id: 'lead_private', body: { [cf(FIELD.health)]: 'Stalled', [cf(FIELD.sessions)]: '0', [cf(FIELD.activeTeachers)]: '0', [cf(FIELD.teachersEver)]: '1', [cf(FIELD.lastSession)]: '2026-10-01', [cf(FIELD.updated)]: '2026-12-02' } },
  { id: 'lead_gone', body: { [cf(FIELD.health)]: 'Silent', [cf(FIELD.sessions)]: '0', [cf(FIELD.activeTeachers)]: '0', [cf(FIELD.teachersEver)]: '0', [cf(FIELD.updated)]: '2026-12-02' } },
  { id: 'lead_district', body: { [cf(FIELD.schoolsHealth)]: '2 schools: 1 on track, 1 light' } },
];

async function main() {
  process.env.HEALTH_EXCLUDED_TEACHER_IDS = '999, 1000';

  // ---- NCES ----
  await check('NCES: 11 digits in Close matches 12 in the feed', () => assert.strictEqual(normNces('61674002130'), normNces('061674002130')));
  await check('NCES: private-school short IDs', () => {
    assert.strictEqual(normNces('421641'), normNces('000000421641'));
    assert.strictEqual(normNces('01160686'), normNces('000001160686'));
    assert.strictEqual(normNces('01160686'), '1160686');
  });
  await check('NCES: numbers, spaces, blanks; different IDs stay different', () => {
    assert.strictEqual(normNces(63513007356), '63513007356');
    assert.strictEqual(normNces(' 0635-130 '), '635130');
    assert.strictEqual(normNces(null), '');
    assert.strictEqual(normNces('000'), '');
    assert.notStrictEqual(normNces('421641'), normNces('4216410'));
  });

  // ---- which lead gets written ----
  await check('leads: named beats an older unnamed duplicate, and the duplicate is reported', () => {
    const { byKey, duplicates } = chooseSchoolLeads([
      lead({ id: 'unnamed', name: ' ', dateCreated: '2020-01-01', schoolNces: '061674002130' }),
      lead({ id: 'named', name: 'Lincoln', dateCreated: '2025-01-01', schoolNces: '61674002130' }),
    ]);
    assert.strictEqual(byKey.get('61674002130')!.id, 'named');
    assert.deepStrictEqual(duplicates, [{ nces: '61674002130', chosen: { id: 'named', name: 'Lincoln' }, ignored: [{ id: 'unnamed', name: ' ' }] }]);
  });
  await check('leads: among named leads the oldest wins', () => {
    const { byKey, duplicates } = chooseSchoolLeads([
      lead({ id: 'newer', name: 'Lincoln ES', dateCreated: '2025-06-01', schoolNces: '421641' }),
      lead({ id: 'older', name: 'Lincoln', dateCreated: '2024-06-01', schoolNces: '421641' }),
      lead({ id: 'other', name: 'Elsewhere', dateCreated: '2020-01-01', schoolNces: '421642' }),
    ]);
    assert.strictEqual(byKey.get('421641')!.id, 'older');
    assert.strictEqual(duplicates.length, 1);
    assert.strictEqual(byKey.get('421642')!.id, 'other');
  });

  // ---- labels ----
  await check('label: On track needs one teacher with 3 (3 yes; 2+2 across teachers no)', () => {
    assert.strictEqual(healthLabel(usage(3, 3)), 'On track');
    assert.strictEqual(healthLabel(usage(4, 9, 2)), 'Light');
    assert.strictEqual(healthLabel(usage(2, 2)), 'Light');
    assert.strictEqual(healthLabel(usage(1, 50)), 'Light');
  });
  await check('label: Stalled at 3 earlier sessions, Silent at 2', () => {
    assert.strictEqual(healthLabel(usage(0, 3)), 'Stalled');
    assert.strictEqual(healthLabel(usage(0, 2)), 'Silent');
    assert.strictEqual(healthLabel(usage(0, 0)), 'Silent');
  });

  // ---- window ----
  await check('window: mid-October is the plain 28 days', () => assert.deepStrictEqual(recentWindow('2026-10-14'), { from: '2026-09-17', to: '2026-10-14', holidayWeeks: 0 }));
  await check('window: the week after Thanksgiving 2026 extends by 7', () => {
    assert.strictEqual(thanksgiving(2026), '2026-11-26');
    assert.deepStrictEqual(recentWindow('2026-12-02'), { from: '2026-10-29', to: '2026-12-02', holidayWeeks: 1 });
  });
  await check('window: early January extends by 14 (Dec 25 and Jan 1 weeks), not by Thanksgiving too', () => {
    assert.deepStrictEqual(recentWindow('2027-01-06'), { from: '2026-11-26', to: '2027-01-06', holidayWeeks: 2 });
  });
  await check('window: edges of the Thanksgiving week (Mon Nov 23 in, Sun Nov 22 out; Dec 20 still in, Dec 27 no longer)', () => {
    assert.strictEqual(recentWindow('2026-11-22').holidayWeeks, 0);
    assert.strictEqual(recentWindow('2026-11-23').holidayWeeks, 1);
    assert.strictEqual(recentWindow('2026-12-20').holidayWeeks, 1); // base window starts Nov 23
    assert.strictEqual(recentWindow('2026-12-27').holidayWeeks, 1); // Thanksgiving out, Dec 25 week in
    assert.strictEqual(thanksgiving(2027), '2027-11-25');
    assert.strictEqual(thanksgiving(2023), '2023-11-23');
  });
  await check('school year starts August 1', () => {
    assert.strictEqual(schoolYearStart('2026-11-26'), '2026-08-01');
    assert.strictEqual(schoolYearStart('2026-08-01'), '2026-08-01');
    assert.strictEqual(schoolYearStart('2026-07-31'), '2025-08-01');
    assert.strictEqual(schoolYearStart('2027-01-06'), '2026-08-01');
  });

  // ---- exclusions and aggregation ----
  await check('exclusions: internal and partner domains, and listed teacher IDs', () => {
    const ids = parseExcludedIds(' 21775 ,300,, ');
    assert.ok(isExcludedTeacher({ teacher_id: '1', email_domain: 'PeerTeach.org' }, ids));
    assert.ok(isExcludedTeacher({ teacher_id: '1', email_domain: 'leanlabeducation.org' }, ids));
    assert.ok(isExcludedTeacher({ teacher_id: 21775, email_domain: 'srvusd.net' }, ids));
    assert.ok(!isExcludedTeacher({ teacher_id: '2177', email_domain: 'srvusd.net' }, ids));
    assert.ok(!isExcludedTeacher({ teacher_id: null, email_domain: null }, ids));
    assert.strictEqual(parseExcludedIds(undefined).size, 0);
  });
  await check('aggregation: sums per school, excluded teachers count for nothing, junk is ignored', () => {
    const schools = aggregateSchools(feed().teachers, parseExcludedIds('999'));
    assert.deepStrictEqual(schools.get('63513007356'), {
      key: '63513007356', ncesSchoolId: '063513007356', districtKey: '635130', schoolName: 'Bollinger Canyon Elementary', districtName: 'San Ramon Valley Unified',
      sessionsWindow: 4, activeTeachers: 2, teachersEver: 2, sessionsYear: 9, firstSessionDate: '2026-09-01', lastSessionDate: '2026-11-20', maxTeacherSessionsWindow: 3,
    });
    assert.strictEqual(schools.size, 4);
    assert.strictEqual(aggregateSchools(null, new Set()).size, 0);
    assert.strictEqual(aggregateSchools([null, 'x', { nces_school_id: '5', sessions_window: null, sessions_year: 'abc' }], new Set()).size, 0);
  });

  // ---- roll-up wording ----
  await check('roll-up: wording, zero counts left out, singular', () => {
    assert.strictEqual(rollupLine(['On track', 'Light', 'On track', 'Stalled', 'On track', 'Light']), '6 schools: 3 on track, 2 light, 1 stalled');
    assert.strictEqual(rollupLine(['Silent']), '1 school: 1 silent');
    assert.strictEqual(rollupLine(['Silent', 'On track']), '2 schools: 1 on track, 1 silent');
  });

  // ---- change detection ----
  await check('changes: nothing to send when only the run date differs', () => {
    const cur = { [FIELD.health]: 'Light', [FIELD.sessions]: '2', [FIELD.updated]: '2026-11-01' };
    assert.strictEqual(changedFields(cur, { [FIELD.health]: 'Light', [FIELD.sessions]: '2', [FIELD.updated]: '2026-12-02' }), null);
    assert.deepStrictEqual(changedFields(cur, { [FIELD.health]: 'Light', [FIELD.sessions]: '3', [FIELD.updated]: '2026-12-02' }), { [FIELD.health]: 'Light', [FIELD.sessions]: '3', [FIELD.updated]: '2026-12-02' });
    assert.ok(changedFields({}, { [FIELD.health]: 'Silent', [FIELD.updated]: '2026-12-02' }));
  });

  // ---- stale feed ----
  await check('stale feed: 4 days old is fine, 5 is stale, a missing date is stale', () => {
    assert.strictEqual(isFeedStale('2026-10-16', '2026-10-20'), false);
    assert.strictEqual(isFeedStale('2026-10-15', '2026-10-20'), true);
    // Holiday weeks don't count. Last usage the Friday before Thanksgiving: the weekend is 2
    // days, the holiday week 0, so Tuesday Dec 1 is day 4 and Wednesday Dec 2 is day 5.
    assert.strictEqual(isFeedStale('2026-11-20', '2026-11-27'), false);
    assert.strictEqual(isFeedStale('2026-11-20', '2026-12-01'), false);
    assert.strictEqual(isFeedStale('2026-11-20', '2026-12-02'), true);
    // Winter break: last usage Friday Dec 18, two holiday weeks, school back Monday Jan 4.
    assert.strictEqual(isFeedStale('2026-12-18', '2027-01-05'), false);
    assert.strictEqual(isFeedStale('2026-12-18', '2027-01-06'), true);
    assert.strictEqual(isSummerPause('2027-06-14'), false);
    assert.strictEqual(isSummerPause('2027-07-04'), true);
    assert.strictEqual(isSummerPause('2027-08-20'), true);
    assert.strictEqual(isSummerPause('2027-08-21'), false);
    assert.strictEqual(isFeedStale('2026-12-02T03:00:00Z', '2026-12-02'), false);
    assert.strictEqual(isFeedStale(undefined, '2026-12-02'), true);
    assert.strictEqual(isFeedStale('not a date', '2026-12-02'), true);
  });

  // ---- plan ----
  await check('plan: a labelled lead no longer in the usage data goes Silent with zeros; an unlabelled one gets nothing', () => {
    const plan = planHealth(new Map(), [
      lead({ id: 'was', name: 'Was Active', schoolNces: '421641', districtNces: '12345', current: { [FIELD.health]: 'On track', [FIELD.sessions]: '8' } }),
      lead({ id: 'never', name: 'Prospect', schoolNces: '421642' }),
      lead({ id: 'already', name: 'Already Silent', schoolNces: '421643', current: { [FIELD.health]: 'Silent', [FIELD.sessions]: '0', [FIELD.activeTeachers]: '0', [FIELD.teachersEver]: '0' } }),
      lead({ id: 'district', name: 'District', districtNces: '0012345' }),
    ], '2026-12-02');
    assert.deepStrictEqual(plan.schoolUpdates, [{ leadId: 'was', leadName: 'Was Active', fields: { [FIELD.health]: 'Silent', [FIELD.sessions]: '0', [FIELD.activeTeachers]: '0', [FIELD.teachersEver]: '0', [FIELD.updated]: '2026-12-02' } }]);
    assert.strictEqual(plan.schoolsUnchanged, 1);
    assert.deepStrictEqual(plan.districtUpdates, [{ leadId: 'district', leadName: 'District', fields: { [FIELD.schoolsHealth]: '1 school: 1 silent' } }]);
  });
  await check('plan: unmatched schools are reported most sessions first, district leads get only the roll-up', () => {
    const schools = aggregateSchools([
      teacher('1', '000000000111', 'Small', 1, 1, '2026-11-01'),
      teacher('2', '000000000222', 'Big', 7, 9, '2026-11-02'),
      teacher('3', '000000000333', 'Matched', 3, 3, '2026-11-03'),
    ], new Set());
    const plan = planHealth(schools, [lead({ id: 'm', name: 'Matched', schoolNces: '333' }), lead({ id: 'd', name: 'District', districtNces: '635130' })], '2026-12-02');
    assert.deepStrictEqual(plan.unmatched.map((u) => u.schoolName), ['Big', 'Small']);
    assert.deepStrictEqual(plan.labelCounts, { 'On track': 2, Light: 1, Stalled: 0, Silent: 0 });
    // The matched lead has no District NCES of its own: the feed's district ID is used.
    assert.deepStrictEqual(plan.districtUpdates, [{ leadId: 'd', leadName: 'District', fields: { [FIELD.schoolsHealth]: '1 school: 1 on track' } }]);
    assert.deepStrictEqual(Object.keys(plan.districtUpdates[0].fields), [FIELD.schoolsHealth]);
  });

  // ---- weekly digest: paces ----
  await check('digest: school weeks are Monday weeks overlapping the span, holiday weeks out, at least 1', () => {
    assert.strictEqual(schoolWeeks('2026-10-14', '2026-10-20'), 2); // Wed to Tue: two Monday weeks
    assert.strictEqual(schoolWeeks('2026-11-16', '2026-12-06'), 2); // Thanksgiving week is out
    assert.strictEqual(schoolWeeks('2026-10-27', '2026-11-30'), 5); // the window for Mon Nov 30
    assert.strictEqual(schoolWeeks('2026-11-24', '2026-11-25'), 1); // all holiday: still 1
    assert.strictEqual(schoolWeeks('2026-12-14', '2027-01-10'), 2); // Dec 21 and Dec 28 weeks out
  });
  await check('digest: usual and recent pace', () => {
    const w = recentWindow('2026-11-30');
    assert.deepStrictEqual(w, { from: '2026-10-27', to: '2026-11-30', holidayWeeks: 1 });
    // First session Tue Sep 1: Aug 31 .. Oct 26 is 9 school weeks.
    const p = schoolPaces({ sessionsWindow: 5, sessionsYear: 40, firstSessionDate: '2026-09-01' }, w);
    assert.deepStrictEqual(p, { before: 35, beforeWeeks: 9, usual: 35 / 9, recent: 1, recentWeeks: 5 });
    // Started inside the window: no usual pace.
    assert.strictEqual(schoolPaces({ sessionsWindow: 3, sessionsYear: 3, firstSessionDate: '2026-11-02' }, w).beforeWeeks, 0);
    assert.strictEqual(schoolPaces({ sessionsWindow: 3, sessionsYear: 9, firstSessionDate: '' }, w).beforeWeeks, 0);
  });
  await check('digest: pace phrasing never prints a decimal', () => {
    assert.strictEqual(pacePhrase(9.4), 'about 9');
    assert.strictEqual(pacePhrase(1.5), 'about 2');
    assert.strictEqual(pacePhrase(1.49), 'about 1');
    assert.strictEqual(pacePhrase(0.75), 'about 1');
    assert.strictEqual(pacePhrase(0.74), 'under 1');
    assert.strictEqual(pacePhrase(0), 'under 1');
  });
  await check('digest: slowing down needs 8 before over 3 school weeks, and under half the usual pace', () => {
    const w = recentWindow('2026-11-30'); // 5 school weeks in the window
    const slow = (win: number, year: number, first: string) => isSlowing({ sessionsWindow: win }, schoolPaces({ sessionsWindow: win, sessionsYear: year, firstSessionDate: first }, w));
    // 10 before over 5 weeks (from Sep 28) is 2 a week; half is 1 a week = 5 in the window.
    assert.strictEqual(slow(5, 15, '2026-09-28'), false); // exactly half: not slowing
    assert.strictEqual(slow(4, 14, '2026-09-28'), true);
    assert.strictEqual(slow(0, 10, '2026-09-28'), false); // none in the window: that is Stopped
    // 7 before vs 8 before, over plenty of weeks, 1 in the window.
    assert.strictEqual(slow(1, 8, '2026-10-12'), false);
    assert.strictEqual(slow(1, 9, '2026-10-12'), true);
    // 8 before over 2 weeks (from Oct 19) vs 3 weeks (from Oct 12).
    assert.strictEqual(slow(1, 9, '2026-10-19'), false);
    assert.strictEqual(slow(1, 9, '2026-10-12'), true);
    // A school that only ever ran about 1 a week is not "slowing": 10 before over 9 weeks
    // (from Aug 24) is 1.1 a week, under the 1.5 floor, even with 0.2 a week now.
    assert.strictEqual(slow(1, 11, '2026-08-24'), false);
    // 16 before over the same 9 weeks is 1.8 a week: a drop to 0.2 is news.
    assert.strictEqual(slow(1, 17, '2026-08-24'), true);
  });

  // ---- weekly digest: names ----
  await check('digest: all-caps feed names are title-cased, abbreviations and short consonant tokens kept', () => {
    assert.strictEqual(displayName('SCOTT VALLEY JR HIGH'), 'Scott Valley JR High');
    assert.strictEqual(displayName('CORONADO EL'), 'Coronado El');
    assert.strictEqual(displayName('G R HAMPTON ELEMENTARY SCHOOL'), 'G R Hampton Elementary School');
    assert.strictEqual(displayName('LINCOLN K-8'), 'Lincoln K-8');
    assert.strictEqual(displayName('KIPP DC PCS'), 'Kipp DC PCS');
    assert.strictEqual(displayName('AMARILLO ISD'), 'Amarillo ISD');
    assert.strictEqual(displayName("ST. MARY'S ACADEMY"), "St. Mary's Academy");
    assert.strictEqual(displayName('Los Tules Middle'), 'Los Tules Middle'); // mixed case: untouched
    assert.strictEqual(displayName('  '), '');
    assert.strictEqual(shortDate('2026-09-22'), 'Sep 22');
  });

  // ---- weekly digest: sections ----
  const TODAY = '2026-11-30'; // window Oct 27 .. Nov 30, 5 school weeks
  const sch = (key: string, o: Partial<SchoolUsage>): SchoolUsage => ({
    key, ncesSchoolId: key, districtKey: '', schoolName: `SCHOOL ${key}`, districtName: '', sessionsWindow: 0, activeTeachers: 0, teachersEver: 1, sessionsYear: 0, firstSessionDate: '2026-09-01', lastSessionDate: '2026-10-01', maxTeacherSessionsWindow: 0, ...o,
  });
  const schoolMap = (...list: SchoolUsage[]) => new Map(list.map((x) => [x.key, x]));
  const url = (id: string) => `https://app.close.com/lead/${id}/`;
  const opp = (leadId: string, statusLabel: string, dateUpdated: string): ActiveOpportunity => ({ leadId, statusLabel, dateUpdated });

  await check('chunkSections: whole sections per message, lines only for an oversized one', () => {
    const a = 'A\n' + 'x'.repeat(50), b = 'B\n' + 'y'.repeat(50), c = 'C\n' + 'z'.repeat(50);
    assert.deepStrictEqual(chunkSections([a, b, c].join('\n\n'), 120), [`${a}\n\n${b}`, c]);
    const big = Array.from({ length: 6 }, (_, i) => `line ${i} ${'q'.repeat(30)}`).join('\n');
    const parts = chunkSections(`${a}\n\n${big}`, 120);
    assert.strictEqual(parts[0], a);
    assert.ok(parts.slice(1).every((p) => p.length <= 120) && parts.slice(1).join('\n') === big);
  });
  await check('digest: section membership (an On track school can be slowing down; new, top 3, never)', () => {
    const s = digestSections({
      today: TODAY, leads: [], opportunities: [],
      schools: schoolMap(
        sch('1', { sessionsWindow: 0, sessionsYear: 3 }), // Stalled -> stopped
        sch('2', { sessionsWindow: 0, sessionsYear: 2 }), // Silent -> never
        sch('3', { sessionsWindow: 30, sessionsYear: 210, maxTeacherSessionsWindow: 10, activeTeachers: 5, teachersEver: 8 }), // On track, 6 vs 20 a week
        sch('4', { sessionsWindow: 20, sessionsYear: 30, maxTeacherSessionsWindow: 8 }),
        sch('5', { sessionsWindow: 12, sessionsYear: 20, maxTeacherSessionsWindow: 6 }),
        sch('6', { sessionsWindow: 10, sessionsYear: 15, maxTeacherSessionsWindow: 4 }),
        sch('7', { sessionsWindow: 9, sessionsYear: 9, firstSessionDate: '2026-10-27', maxTeacherSessionsWindow: 9 }), // new, but 4th busiest
        sch('8', { sessionsWindow: 2, sessionsYear: 2, firstSessionDate: '2026-11-10' }), // new
        sch('9', { sessionsWindow: 1, sessionsYear: 1, firstSessionDate: '2026-11-10' }), // too few to be new
        sch('10', { sessionsWindow: 3, sessionsYear: 3, firstSessionDate: '2026-10-26', maxTeacherSessionsWindow: 3 }), // started the day before the window
      ),
    });
    const keys = (l: Array<{ usage: SchoolUsage }>) => l.map((d) => d.usage.key);
    assert.deepStrictEqual(keys(s.stopped), ['1']);
    assert.deepStrictEqual(keys(s.never), ['2']);
    assert.deepStrictEqual(keys(s.slowing), ['3']);
    assert.strictEqual(s.slowing[0].label, 'On track');
    assert.deepStrictEqual(keys(s.top), ['4', '5', '6']); // the slowing school is not "going well"
    assert.deepStrictEqual(keys(s.fresh), ['7', '8']);
    assert.strictEqual(s.onTrack, 6);
    assert.deepStrictEqual([s.recentWeeks, s.quietWeeks], [5, 5]);
  });
  await check('digest: deal stage from the school lead, else the most recently updated on its district lead', () => {
    const leads = [
      lead({ id: 'a', name: 'Alpha Middle', schoolNces: '1', districtNces: '0077' }),
      lead({ id: 'b', name: 'Beta Middle', schoolNces: '2', districtNces: '77' }),
      lead({ id: 'c', name: 'Gamma Middle', schoolNces: '3' }), // no District NCES: the feed's district is used
      lead({ id: 'dl', name: 'Seventy Seven USD', districtNces: '77' }),
      lead({ id: 'dl2', name: '', districtNces: '077' }),
    ];
    const s = digestSections({
      today: TODAY, leads,
      opportunities: [opp('a', 'Negotiating', '2026-11-01'), opp('dl', 'Pilot Launched', '2026-10-01T00:00:00Z'), opp('dl2', 'Pilot Successful, Awaiting Budget', '2026-11-20T00:00:00Z'), opp('dl', 'Old', '2026-09-01')],
      schools: schoolMap(sch('1', { sessionsYear: 5, districtKey: '77' }), sch('2', { sessionsYear: 4, districtKey: '77' }), sch('3', { sessionsYear: 3, districtKey: '77' })),
    });
    const stage = Object.fromEntries(s.stopped.map((d) => [d.usage.key, d.stage]));
    assert.deepStrictEqual(stage, { 1: 'Negotiating', 2: 'Pilot Successful, Awaiting Budget', 3: 'Pilot Successful, Awaiting Budget' });
    // Alpha and Beta share District NCES 77, so both show the district (the named district lead).
    const district = Object.fromEntries(s.stopped.map((d) => [d.usage.key, d.district]));
    assert.deepStrictEqual(district, { 1: 'Seventy Seven USD', 2: 'Seventy Seven USD', 3: '' });
    // Lead names win over feed names.
    assert.deepStrictEqual(s.stopped.map((d) => d.name), ['Beta Middle', 'Gamma Middle', 'Alpha Middle']);
  });
  await check('digest: ordering is Pilot/Awaiting Budget deals, then other deals, then by sessions this year', () => {
    const leads = ['1', '2', '3', '4'].map((k) => lead({ id: `l${k}`, name: `School ${k}`, schoolNces: k }));
    const s = digestSections({
      today: TODAY, leads,
      opportunities: [opp('l2', 'Negotiating', '2026-11-01'), opp('l3', 'pilot launched', '2026-11-01'), opp('l4', 'Proposal', '2026-11-01')],
      schools: schoolMap(sch('1', { sessionsYear: 50 }), sch('2', { sessionsYear: 10 }), sch('3', { sessionsYear: 5 }), sch('4', { sessionsYear: 20 })),
    });
    assert.deepStrictEqual(s.stopped.map((d) => d.usage.key), ['3', '4', '2', '1']);
  });
  await check('digest: the whole text (lines, links, no-lead note, district, new, footer)', () => {
    const leads = [
      lead({ id: 'l1', name: 'Scott Valley Junior High', schoolNces: '1' }),
      lead({ id: 'l2', name: 'Coronado El', schoolNces: '2', districtNces: '48' }),
      lead({ id: 'l3', name: 'Bivins El', schoolNces: '3', districtNces: '48' }),
      lead({ id: 'ld', name: 'Amarillo ISD', districtNces: '48' }),
      lead({ id: 'l4', name: 'Los Tules Middle', schoolNces: '4' }),
    ];
    const text = buildDigest({
      today: TODAY, weekOf: '2026-11-30', leadUrl: url, leads,
      opportunities: [opp('l1', 'Pilot: kickoff completed', '2026-11-01'), opp('ld', 'Pilot Launched', '2026-11-02'), opp('l4', 'Pilot Successful, Awaiting Budget', '2026-11-03')],
      schools: schoolMap(
        sch('1', { sessionsYear: 11, lastSessionDate: '2026-10-14' }),
        sch('2', { sessionsYear: 5, lastSessionDate: '2026-09-22', teachersEver: 2 }),
        sch('3', { sessionsWindow: 20, sessionsYear: 25, maxTeacherSessionsWindow: 10, activeTeachers: 3, teachersEver: 4 }),
        sch('4', { sessionsWindow: 2, sessionsYear: 52, activeTeachers: 2, teachersEver: 2, maxTeacherSessionsWindow: 1 }),
        sch('5', { schoolName: 'MAYVILLE MIDDLE HIGH', sessionsYear: 7, lastSessionDate: '2026-10-23' }),
        sch('6', { schoolName: 'NORTHEAST MIDDLE', sessionsWindow: 6, sessionsYear: 6, firstSessionDate: '2026-11-02', maxTeacherSessionsWindow: 6, activeTeachers: 1 }),
        sch('7', { schoolName: 'G R HAMPTON', sessionsWindow: 4, sessionsYear: 4, firstSessionDate: '2026-11-09', maxTeacherSessionsWindow: 4, activeTeachers: 1 }),
        sch('8', { schoolName: 'NEW TWO', sessionsWindow: 4, sessionsYear: 4, firstSessionDate: '2026-11-09', maxTeacherSessionsWindow: 4, activeTeachers: 1 }),
        sch('9', { schoolName: 'NEW THREE', sessionsWindow: 2, sessionsYear: 2, firstSessionDate: '2026-11-16', maxTeacherSessionsWindow: 2, activeTeachers: 1 }),
        sch('10', { schoolName: 'UPTON MIDDLE', sessionsYear: 1 }),
        sch('11', { schoolName: 'Tradewind El', sessionsYear: 2 }),
      ),
    });
    assert.strictEqual(text, [
      '*School health, week of Nov 30*',
      '',
      '*Stopped:* a real start, then nothing for 5+ weeks',
      '• *Scott Valley Junior High*: 11 sessions, none since Oct 14. 1 teacher. Pilot: kickoff completed. <https://app.close.com/lead/l1/|Open in Close>',
      '• *Coronado El* (Amarillo ISD): 5 sessions, none since Sep 22. 2 teachers. Pilot Launched. <https://app.close.com/lead/l2/|Open in Close>',
      '• *Mayville Middle High*: 7 sessions, none since Oct 23. 1 teacher. (no Close lead)',
      '',
      '*Slowing down:* well below their own usual pace',
      '• *Los Tules Middle*: under 1 a week, was about 6. 2 of 2 teachers active. Pilot Successful, Awaiting Budget. <https://app.close.com/lead/l4/|Open in Close>',
      '',
      '*Going well*',
      '• *Bivins El* (Amarillo ISD): 20 sessions in 5 weeks, 3 of 4 teachers active.',
      '• *Northeast Middle*: 6 sessions, 1 of 1 teacher active.',
      '• *G R Hampton*: 4 sessions, 1 of 1 teacher active.',
      '• New: *New Two* and *New Three* ran 4 and 2 in their first weeks.',
      '• 4 schools on track overall.',
      '',
      '*Never got going* (1 or 2 sessions): Tradewind El and Upton Middle.',
      '',
      'Not in Close yet: Northeast Middle. Create a lead so they show up here.',
    ].join('\n'));
  });
  await check('digest: "each ran N" when equal, one new school reads "ran N in its first weeks"', () => {
    const many = sch('9', { sessionsWindow: 50, sessionsYear: 50, maxTeacherSessionsWindow: 50 });
    const mk = (...extra: SchoolUsage[]) => buildDigest({ today: TODAY, weekOf: '2026-11-30', leadUrl: url, leads: [], opportunities: [], schools: schoolMap(many, sch('8', { sessionsWindow: 40, sessionsYear: 40 }), sch('7', { sessionsWindow: 30, sessionsYear: 30 }), ...extra) })!;
    const fresh = (k: string, n: number) => sch(k, { schoolName: `NEW ${k.toUpperCase()}`, sessionsWindow: n, sessionsYear: n, firstSessionDate: '2026-11-02' });
    assert.ok(mk(fresh('a', 4), fresh('b', 4)).includes('• New: *New A* and *New B* each ran 4 in their first weeks.'));
    assert.ok(mk(fresh('a', 3)).includes('• New: *New A* ran 3 in its first weeks.'));
    assert.ok(mk(fresh('a', 5), fresh('b', 4), fresh('c', 3), fresh('d', 2), fresh('e', 2)).includes('• New: *New A*, *New B*, *New C* and *New D* ran 5, 4, 3 and 2 in their first weeks, plus 1 more.'));
  });
  await check('digest: Stopped and Slowing down cap at 10, Never got going at 10 names', () => {
    const list: SchoolUsage[] = [];
    for (let i = 10; i < 22; i++) list.push(sch(String(i), { sessionsYear: 3 }));
    for (let i = 30; i < 42; i++) list.push(sch(String(i), { sessionsYear: 1 }));
    for (let i = 50; i < 62; i++) list.push(sch(String(i), { sessionsWindow: 1, sessionsYear: 30 }));
    const text = buildDigest({ today: TODAY, weekOf: '2026-11-30', leadUrl: url, leads: [], opportunities: [], schools: schoolMap(...list) })!;
    const lines = text.split('\n');
    assert.strictEqual(lines.filter((l) => l.startsWith('• ') && l.includes('none since')).length, 10);
    assert.strictEqual(lines.filter((l) => l.startsWith('• ') && l.includes(', was ')).length, 10);
    assert.strictEqual(lines.filter((l) => l === '…and 2 more (see Close: PT Health)').length, 2);
    assert.ok(text.includes('School 39 and 2 more.'), text);
  });
  await check('digest: footer only for unmatched schools with 5+ in the window', () => {
    const mk = (n: number) => buildDigest({ today: TODAY, weekOf: '2026-11-30', leadUrl: url, leads: [], opportunities: [], schools: schoolMap(sch('1', { schoolName: 'NO LEAD', sessionsWindow: n, sessionsYear: 20, maxTeacherSessionsWindow: n })) })!;
    assert.ok(mk(5).endsWith('Not in Close yet: No Lead. Create a lead so they show up here.'));
    assert.ok(!mk(4).includes('Not in Close yet'));
  });
  await check('digest: nothing at all -> no post', () => {
    assert.strictEqual(buildDigest({ today: TODAY, weekOf: '2026-11-30', leadUrl: url, leads: [], opportunities: [], schools: new Map() }), null);
  });
  await check('digest: Mondays only, never in a holiday week, any day when forced', () => {
    assert.strictEqual(digestSkipReason('2026-12-07'), null);
    assert.strictEqual(digestSkipReason('2026-12-02'), 'not a Monday');
    assert.strictEqual(digestSkipReason('2026-11-23'), 'holiday week');
    assert.strictEqual(digestSkipReason('2026-12-28'), 'holiday week');
    assert.strictEqual(digestSkipReason('2026-12-02', true), null);
    assert.strictEqual(digestSkipReason('2026-11-23', true), null);
  });

  // ---- whole runs on fakes ----
  await check('run, dry (a Wednesday): computes everything, writes nothing, creates no fields, posts nothing', async () => {
    delete process.env.USAGE_HEALTH_MODE;
    const f = fake();
    const r = await runUsageHealth({ now: WED }, f.deps);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.mode, 'dry');
    assert.deepStrictEqual(f.fetches, [{ since: '2026-08-01', from: '2026-10-29', to: '2026-12-02' }]);
    assert.deepStrictEqual(f.updates, []);
    assert.deepStrictEqual(f.ensured, []);
    assert.deepStrictEqual([r.schools, r.matched, r.unmatched, r.duplicates, r.districtRollups, r.leadsToUpdate, r.updated], [4, 3, 1, 1, 1, 4, 0]);
    assert.deepStrictEqual(r.labelCounts, { 'On track': 2, Light: 1, Stalled: 1, Silent: 0 });
    assert.deepStrictEqual([f.notes.length, f.oppReads], [0, 0]);
    assert.strictEqual(r.digest, 'not a Monday');
  });
  await check('run, dry: ?dry_run=1 wins over USAGE_HEALTH_MODE=live', async () => {
    process.env.USAGE_HEALTH_MODE = 'live';
    const f = fake();
    const r = await runUsageHealth({ now: WED, forceDry: true }, f.deps);
    assert.strictEqual(r.mode, 'dry');
    assert.deepStrictEqual([f.updates.length, f.ensured.length, f.notes.length], [0, 0, 0]);
  });
  await check('run, dry: fields that do not exist yet are reported, not created', async () => {
    delete process.env.USAGE_HEALTH_MODE;
    const f = fake({ leadFieldIds: async () => new Map(IDS.slice(0, 2)) });
    const r = await runUsageHealth({ now: WED }, f.deps);
    assert.strictEqual(r.ok, true);
    // Without the PT fields nothing is stored yet: the unchanged school and the roll-up both count as updates, and no lead can "go Silent".
    assert.strictEqual(r.leadsToUpdate, 4);
    assert.deepStrictEqual([f.updates.length, f.ensured.length], [0, 0]);
  });
  await check('run, live (a Wednesday): exactly the changed leads get exactly these fields; nothing is posted', async () => {
    process.env.USAGE_HEALTH_MODE = 'live';
    const f = fake();
    const r = await runUsageHealth({ now: WED }, f.deps);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.mode, 'live');
    assert.deepStrictEqual(f.updates, EXPECTED_UPDATES);
    assert.ok(!f.updates.some((u) => ['lead_bollinger_unnamed', 'lead_prospect', 'lead_same'].includes(u.id)));
    assert.deepStrictEqual([r.updated, r.failed, r.deferred], [4, 0, 0]);
    assert.strictEqual(f.ensured.length, 7);
    assert.strictEqual(f.fetches.length, 1);
    assert.deepStrictEqual(f.notes, []);
  });
  const MON_DIGEST = [
    '*School health, week of Dec 7*',
    '',
    '*Stopped:* a real start, then nothing for 5+ weeks',
    '• *Private Academy*: 4 sessions, none since Oct 1. 1 teacher. <https://app.close.com/lead/lead_private/|Open in Close>',
    '',
    '*Going well*',
    '• *No Lead Elementary*: 6 sessions in 5 weeks, 1 of 1 teacher active.',
    '• *Bollinger Canyon Elementary* (San Ramon Valley Unified): 4 sessions, 2 of 2 teachers active.',
    '• *Unchanged School* (San Ramon Valley Unified): 2 sessions, 1 of 1 teacher active.',
    '• 2 schools on track overall.',
    '',
    'Not in Close yet: No Lead Elementary. Create a lead so they show up here.',
  ].join('\n');
  await check('run (a Monday, dry and live): one digest to the health channel, one feed read, Close writes only when live', async () => {
    for (const mode of ['dry', 'live']) {
      process.env.USAGE_HEALTH_MODE = mode;
      const f = fake({ fetchUsage: async (q) => { f.fetches.push(q); return feed('2026-12-06'); } });
      const r = await runUsageHealth({ now: MON }, f.deps);
      assert.strictEqual(r.ok, true);
      assert.deepStrictEqual(f.fetches, [{ since: '2026-08-01', from: '2026-11-03', to: '2026-12-07' }]);
      assert.deepStrictEqual([f.reports.length, f.warnings.length, f.oppReads], [1, 0, 1]);
      assert.strictEqual(f.reports[0], MON_DIGEST, `${mode}:\n${f.reports[0]}`);
      assert.strictEqual(r.digest, 'posted');
      assert.strictEqual(f.updates.length, mode === 'live' ? 4 : 0);
    }
  });
  await check('run: ?digest=1 posts the digest on a Wednesday (dry run respected)', async () => {
    process.env.USAGE_HEALTH_MODE = 'live';
    const f = fake();
    const r = await runUsageHealth({ now: WED, forceDry: true, forceDigest: true }, f.deps);
    assert.deepStrictEqual([r.mode, r.digest, f.updates.length, f.reports.length], ['dry', 'posted', 0, 1]);
    assert.ok(f.reports[0].startsWith('*School health, week of Nov 30*'), f.reports[0]);
  });
  await check('run: a Monday in a holiday week posts nothing', async () => {
    process.env.USAGE_HEALTH_MODE = 'live';
    const f = fake({ fetchUsage: async () => feed('2026-12-24') });
    const r = await runUsageHealth({ now: new Date('2026-12-28T12:30:00Z') }, f.deps);
    assert.deepStrictEqual([r.ok, r.digest, f.notes.length, f.oppReads], [true, 'holiday week', 0, 0]);
  });
  await check('run, live (a Monday): if the deals cannot be read, Close is still written and a warning says why', async () => {
    process.env.USAGE_HEALTH_MODE = 'live';
    const f = fake({ fetchUsage: async () => feed('2026-12-06'), activeOpportunities: async () => { throw new Error('close 503'); } });
    const r = await runUsageHealth({ now: MON }, f.deps);
    assert.deepStrictEqual([r.ok, r.digest, f.updates.length, f.reports.length, f.warnings.length], [true, 'failed', 4, 0, 1]);
    assert.ok(f.warnings[0].includes('digest could not be built') && f.warnings[0].includes('close 503'), f.warnings[0]);
  });
  await check('run: a stale feed writes nothing to Close and posts a warning (live and dry)', async () => {
    for (const mode of ['live', 'dry']) {
      process.env.USAGE_HEALTH_MODE = mode;
      const f = fake({ fetchUsage: async () => feed('2026-11-18') });
      const r = await runUsageHealth({ now: WED }, f.deps);
      assert.strictEqual(r.stale, true);
      assert.deepStrictEqual([f.updates.length, f.ensured.length, f.listed], [0, 0, 0]);
      assert.strictEqual(f.notes.length, 1);
      assert.ok(f.notes[0].includes('stale') && f.notes[0].includes('2026-11-18'));
      assert.deepStrictEqual([f.warnings.length, f.reports.length], [1, 0]); // a warning: main channel
    }
  });
  await check('run: in summer nothing is read, written or posted', async () => {
    process.env.USAGE_HEALTH_MODE = 'live';
    const f = fake();
    const r = await runUsageHealth({ now: new Date('2027-07-06T12:30:00Z') }, f.deps);
    assert.strictEqual(r.paused, true);
    assert.deepStrictEqual([f.updates.length, f.ensured.length, f.listed, f.notes.length], [0, 0, 0, 0]);
  });
  await check('run, live: one failing lead is counted and reported, the rest still update', async () => {
    process.env.USAGE_HEALTH_MODE = 'live';
    const f = fake();
    f.deps.updateLead = async (id, body) => { if (id === 'lead_private') throw new Error('boom'); f.updates.push({ id, body }); };
    const r = await runUsageHealth({ now: WED }, f.deps);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual([r.updated, r.failed], [3, 1]);
    assert.deepStrictEqual(f.updates.map((u) => u.id), ['lead_bollinger', 'lead_gone', 'lead_district']);
    assert.ok(f.notes.some((n) => n.includes('3 leads updated in Close, 1 failed')));
  });
  await check('run: never throws; a broken feed, ok:false, or a Close listing with no NCES is reported and nothing is written', async () => {
    process.env.USAGE_HEALTH_MODE = 'live';
    const cases: Array<Partial<UsageHealthDeps>> = [
      { fetchUsage: async () => { throw new Error('Request failed with status code 500'); } },
      { fetchUsage: async () => ({ ok: false, error: 'bad secret' }) },
      { fetchUsage: async () => '<html>' },
      { fetchUsage: async () => ({ ok: true }) },
      { listLeads: async () => [] },
      { listLeads: async () => closeLeads().map((l) => ({ ...l, custom: {} })) },
      { leadFieldIds: async () => new Map<string, string>() },
      { postNote: async () => { throw new Error('slack down'); }, listLeads: async () => { throw new Error('close down'); } },
    ];
    for (const over of cases) {
      const f = fake(over);
      const r = await runUsageHealth({ now: WED }, f.deps);
      assert.strictEqual(r.ok, false);
      assert.ok(r.error);
      assert.deepStrictEqual(f.updates, []);
      if (!over.postNote) assert.ok(f.notes.length === 1 && f.notes[0].includes('Usage health job failed'), JSON.stringify(f.notes));
    }
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main();

import assert from 'assert';
import {
  FIELD,
  HealthLead,
  aggregateSchools,
  changedFields,
  chooseSchoolLeads,
  healthLabel,
  isExcludedTeacher,
  isFeedStale,
  isSummerPause,
  isWorse,
  normNces,
  parseExcludedIds,
  planHealth,
  recentWindow,
  rollupLine,
  schoolYearStart,
  thanksgiving,
} from '../src/usageHealthRules';
import { runUsageHealth, UsageHealthDeps } from '../src/usageHealth';
import type { CloseLeadRow } from '../src/closeCrm';

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

interface Fake { deps: UsageHealthDeps; updates: Array<{ id: string; body: Record<string, any> }>; notes: string[]; warnings: string[]; reports: string[]; fetches: any[]; ensured: string[]; listed: number }
function fake(over: Partial<UsageHealthDeps> = {}): Fake {
  const f: Fake = { updates: [], notes: [], warnings: [], reports: [], fetches: [], ensured: [], listed: 0, deps: null as any };
  f.deps = {
    fetchUsage: async (q) => { f.fetches.push(q); return feed(); },
    leadFieldIds: async () => new Map(IDS),
    ensureLeadTextField: async (name) => { f.ensured.push(name); return `cf_${name}`; },
    listLeads: async () => { f.listed++; return closeLeads(); },
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
  await check('label: order On track > Light > Stalled > Silent', () => {
    assert.ok(isWorse('Light', 'On track') && isWorse('Stalled', 'Light') && isWorse('Silent', 'Stalled'));
    assert.ok(!isWorse('On track', 'Light') && !isWorse('Light', 'Light') && !isWorse('Silent', '') && !isWorse('Silent', 'something else'));
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
      sessionsWindow: 4, activeTeachers: 2, teachersEver: 2, sessionsYear: 9, lastSessionDate: '2026-11-20', maxTeacherSessionsWindow: 3,
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

  // ---- whole runs on fakes ----
  await check('run, dry: computes everything, writes nothing, creates no fields, posts one summary', async () => {
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
    assert.strictEqual(f.notes.length, 1);
    assert.deepStrictEqual([f.reports.length, f.warnings.length], [1, 0]); // the summary is a report
    const note = f.notes[0];
    for (const want of ['DRY RUN', 'On track 2, Light 1, Stalled 1, Silent 0', 'Would update 3 school leads (1 already up to date, 1 no longer in the usage data and going Silent) and 1 district lead', 'San Ramon Valley Unified: 2 schools: 1 on track, 1 light', 'No Lead Elementary (000000000777): 6 in the window, 6 this year', '63513007356: using "Bollinger Canyon Elementary", ignoring 1 other']) {
      assert.ok(note.includes(want), `summary is missing: ${want}\n${note}`);
    }
    assert.ok(!/srvusd|peerteach\.org|@/.test(note), 'summary must not carry teacher emails or domains');
  });
  await check('run, dry: ?dry_run=1 wins over USAGE_HEALTH_MODE=live', async () => {
    process.env.USAGE_HEALTH_MODE = 'live';
    const f = fake();
    const r = await runUsageHealth({ now: WED, forceDry: true }, f.deps);
    assert.strictEqual(r.mode, 'dry');
    assert.deepStrictEqual([f.updates.length, f.ensured.length, f.notes.length], [0, 0, 1]);
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
  await check('run, live (a Wednesday): exactly the changed leads get exactly these fields; only the unmatched alert is posted', async () => {
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
    assert.strictEqual(f.notes.length, 1);
    assert.ok(f.notes[0].includes('1 active school has no Close lead') && f.notes[0].includes('No Lead Elementary (000000000777)'), f.notes[0]);
  });
  await check('run, live: a quiet day posts nothing', async () => {
    process.env.USAGE_HEALTH_MODE = 'live';
    const quiet = feed();
    quiet.teachers = quiet.teachers.filter((t) => t.teacher_id !== '5');
    const f = fake({ fetchUsage: async () => quiet });
    await runUsageHealth({ now: WED }, f.deps);
    assert.deepStrictEqual(f.notes, []);
  });
  await check('run, live (a Monday): schools that slipped over the week are listed with their Close link', async () => {
    process.env.USAGE_HEALTH_MODE = 'live';
    const f = fake();
    // Last week's window had "Unchanged School" at 3 sessions (On track); it is Light now.
    f.deps.fetchUsage = async (q) => { f.fetches.push(q); return f.fetches.length === 1 ? feed('2026-12-06') : feed('2026-12-06', 3); };
    const r = await runUsageHealth({ now: MON }, f.deps);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(f.fetches, [{ since: '2026-08-01', from: '2026-11-03', to: '2026-12-07' }, { since: '2026-08-01', from: '2026-10-27', to: '2026-11-30' }]);
    assert.strictEqual(r.slipped, 1);
    const slipped = f.notes.find((n) => n.includes('slipped'));
    assert.ok(slipped && slipped.includes('• Unchanged School: On track → Light, last session 2026-11-10 (<https://app.close.com/lead/lead_same/|open in Close>)'), String(slipped));
    assert.ok(!slipped!.includes('Bollinger'));
    assert.strictEqual(f.notes.length, 2); // the unmatched alert and the slipped list
    assert.deepStrictEqual([f.reports.length, f.warnings.length], [2, 0]); // both are reports
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

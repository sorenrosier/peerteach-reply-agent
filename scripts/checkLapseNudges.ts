import assert from 'assert';
import {
  ACTION,
  CardData,
  NudgeMode,
  NudgeTeacher,
  SUBJECT,
  buildEmail,
  cardBlocks,
  cardData,
  cardIsOpen,
  classPhrase,
  contactedSince,
  doneBlocks,
  isHeldOut,
  lastBefore,
  noRunReason,
  parseCardData,
  parseMode,
  parseTeacher,
  quietDays,
  readCardEmail,
  repliedSince,
  schoolCardsThisWeek,
  semesterStart,
  stableHash,
  summaryLine,
  verdict,
  whenPhrase,
} from '../src/lapseNudgeRules';
import { LapseNudgeDeps, NudgeRecord, runLapseNudges } from '../src/lapseNudges';
import { NudgeActionDeps, applyLapseNudgeEdit, handleLapseNudgeAction, isLapseNudgeAction, isLapseNudgeModal, lapseNudgeEditErrors } from '../src/lapseNudgeActions';
import { salesOpsBase } from '../src/usageHealth';
import { addressesIn } from '../src/closeCrm';
import type { CloseEmailRow, CloseLeadRow } from '../src/closeCrm';

// Offline check of the check-in emails to teachers who stopped (src/lapseNudgeRules.ts,
// src/lapseNudges.ts, src/lapseNudgeActions.ts): the rules with plain asserts, then whole runs
// and button clicks on fake feed / nudge log / Close / Slack. No network.
//   npx ts-node scripts/checkLapseNudges.ts

let passed = 0;
const failures: string[] = [];
function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`PASS | ${label}`); })
    .catch((err) => { failures.push(label); console.log(`FAIL | ${label}\n       ${err instanceof Error ? err.message : err}`); });
}

const WED = new Date('2026-12-09T16:00:00Z'); // 8am Pacific, the second week after Thanksgiving
const TODAY = '2026-12-09';
const DASH = /[‒-―−]/;

// ---- the feed ----

const nudge = (kind: string, action: string, created_at: string, lapse_started_on = '2026-10-28') => ({ id: `n_${kind}_${action}_${created_at}`, kind, action, lapse_started_on, created_at });
const raw = (over: Record<string, any> = {}) => ({
  teacher_id: '100', first_name: 'Melissa', last_name: 'Wright', email: 'mwright@srvusd.net',
  nces_school_id: '063513007356', nces_district_id: '0635130', school_name: 'Bollinger Canyon Elementary', district_name: 'San Ramon Valley Unified', state: null,
  sessions_year: 7, first_session_date: '2026-09-30', last_session_date: '2026-10-28',
  classes: [{ class_id: '123', class_name: 'Period 3', sessions: 4, last_session_date: '2026-10-28' }],
  opted_out: false, nudges: [] as any[], ...over,
});
const teacher = (over: Record<string, any> = {}): NudgeTeacher => parseTeacher(raw(over))!;
const rule = (over: Record<string, any> = {}, today = TODAY, mode: NudgeMode = 'live') => verdict(teacher(over), { today, mode, excludedTeacherIds: new Set(['999']) });
const feed = (teachers: any[], latest = '2026-12-08') => ({ ok: true, latest_usage_date: latest, teachers });

// Teacher IDs on each side of the holdout.
const numbered = Array.from({ length: 40 }, (_, i) => String(200 + i));
const EVEN = numbered.filter((id) => stableHash(id) % 2 === 0);
const ODD = numbered.filter((id) => stableHash(id) % 2 === 1);

// ---- fakes for whole runs ----

const IDS: Array<[string, string]> = [['school nces', 'cf_school'], ['district nces', 'cf_district']];
const row = (id: string, name: string, dateCreated: string, custom: Record<string, string>): CloseLeadRow => ({ id, name, displayName: name || 'Some Contact', dateCreated, custom });
const closeLeads = (): CloseLeadRow[] => [
  // Close holds 11 digits; the feed holds 12. The deal is on the district lead.
  row('lead_bollinger', 'Bollinger Canyon Elementary', '2025-03-01T00:00:00Z', { cf_school: '63513007356', cf_district: '635130' }),
  row('lead_bollinger_unnamed', '', '2024-01-01T00:00:00Z', { cf_school: '063513007356', cf_district: '635130' }),
  row('lead_district', 'San Ramon Valley Unified', '2025-01-01T00:00:00Z', { cf_district: '0635130' }),
  row('lead_own_deal', 'Own Deal School', '2025-02-01T00:00:00Z', { cf_school: '888' }),
  row('lead_no_deal', 'No Deal School', '2025-02-02T00:00:00Z', { cf_school: '777', cf_district: '555' }),
];

interface Fake { deps: LapseNudgeDeps; cards: Array<{ blocks: any[]; text: string }>; rows: NudgeRecord[]; warnings: string[]; reports: string[]; fetches: any[]; emailCalls: Array<{ leadId: string; since: string }>; listed: number }
function fake(teachers: any[], over: Partial<LapseNudgeDeps> = {}, emails: Record<string, CloseEmailRow[]> = {}): Fake {
  const f: Fake = { cards: [], rows: [], warnings: [], reports: [], fetches: [], emailCalls: [], listed: 0, deps: null as any };
  f.deps = {
    fetchCandidates: async (q) => { f.fetches.push(q); return feed(teachers); },
    recordNudge: async (r) => { f.rows.push(r); },
    leadFieldIds: async () => new Map(IDS),
    listLeads: async () => { f.listed++; return closeLeads(); },
    activeDealLeadIds: async () => new Set(['lead_district', 'lead_own_deal']),
    leadEmailsSince: async (leadId, since) => { f.emailCalls.push({ leadId, since }); return emails[leadId] ?? []; },
    postCard: async (blocks, text) => { f.cards.push({ blocks, text }); return `17000000${f.cards.length}.000100`; },
    postNote: async (text) => { f.warnings.push(text); },
    postReport: async (text) => { f.reports.push(text); },
    ...over,
  };
  return f;
}
const header = (blocks: any[]) => blocks[0].text.text as string;
const actionIds = (blocks: any[]) => (blocks.find((b) => b.type === 'actions')?.elements ?? []).map((e: any) => e.action_id);
const allText = (blocks: any[]) => JSON.stringify(blocks);

// ---- fakes for clicks ----

const KATIE = { id: 'user_katie', email: 'katie@peerteach.org', name: 'Katie Example' };
const CARD: CardData = { t: '100', s: '063513007356', k: 'first', l: '2026-10-28', lead: 'lead_bollinger', to: 'mwright@srvusd.net', name: 'Melissa Wright', school: 'Bollinger Canyon Elementary', n: 7, days: 42 };
const EMAIL = { subject: SUBJECT, body: "Hi Melissa,\n\nIt's been quiet & I wondered <why>.\n\nKatie" };
const CARD_TS = '1796832000.000100'; // 2026-12-09T16:00:00Z
const liveCard = (mode: NudgeMode = 'live') => cardBlocks(CARD, EMAIL, { mode, sender: 'Katie (katie@peerteach.org)', leadUrl: 'https://app.close.com/lead/lead_bollinger/' });

interface ClickFake { deps: NudgeActionDeps; rows: NudgeRecord[]; created: any[]; cardUpdates: Array<{ text: string; blocks: any[] }>; told: string[]; modals: any[]; messageUpdates: any[]; notes: string[]; emailChecks: Array<{ leadId: string; since: string }> }
function clickFake(over: Partial<NudgeActionDeps> = {}, leadEmails: CloseEmailRow[] = []): ClickFake {
  const f: ClickFake = { rows: [], created: [], cardUpdates: [], told: [], modals: [], messageUpdates: [], notes: [], emailChecks: [], deps: null as any };
  f.deps = {
    recordNudge: async (r) => { f.rows.push(r); },
    leadEmailsSince: async (leadId, since) => { f.emailChecks.push({ leadId, since }); return leadEmails; },
    findSender: async (email) => (email === KATIE.email ? KATIE : null),
    createEmail: async (p) => { f.created.push(p); return 'acti_1'; },
    updateCard: async (_url, text, blocks) => { f.cardUpdates.push({ text, blocks }); },
    tellClicker: async (_url, text) => { f.told.push(text); },
    openModal: async (triggerId, view) => { f.modals.push({ triggerId, view }); },
    updateMessage: async (channel, ts, text, blocks) => { f.messageUpdates.push({ channel, ts, text, blocks }); },
    postNote: async (text) => { f.notes.push(text); },
    ...over,
  };
  return f;
}
const click = (actionId: string, blocks: any[] = liveCard()) => {
  const value = JSON.stringify(CARD);
  return { action: { action_id: actionId, value }, payload: { type: 'block_actions', actions: [{ action_id: actionId, value }], message: { ts: CARD_TS, blocks }, response_url: 'https://hooks.slack.test/x', channel: { id: 'C_HEALTH' }, user: { id: 'U1', name: 'soren' }, trigger_id: 'trig_1' } };
};
const lastCard = (f: ClickFake) => f.cardUpdates[f.cardUpdates.length - 1];

async function main() {
  for (const k of ['LAPSE_NUDGE_MODE', 'NUDGE_HOLDOUT_UNTIL', 'NUDGE_CALENDAR_URL', 'NUDGE_SENDER_NAME', 'NUDGE_SENDER_EMAIL', 'SALES_OPS_BASE_URL', 'SALES_OPS_HEALTH_URL', 'USAGE_HEALTH_SLACK_CHANNEL']) delete process.env[k];
  process.env.HEALTH_EXCLUDED_TEACHER_IDS = '999';

  // ---- the lapse window ----
  await check('window: 21 quiet days in mid-October', () => {
    assert.strictEqual(quietDays('2026-10-14', 21), 21);
    assert.strictEqual(lastBefore('2026-10-14'), '2026-09-23');
  });
  await check('window: 28 days when the 21 touch Thanksgiving week, 35 across both winter-break weeks', () => {
    assert.strictEqual(lastBefore(TODAY), '2026-11-11'); // Nov 19 to Dec 9 touches Nov 23-29
    assert.strictEqual(quietDays('2026-12-22', 21), 28); // Dec 2-22 touches the Dec 25 week only, no longer Thanksgiving
    assert.strictEqual(quietDays('2027-01-12', 21), 35);
    assert.strictEqual(lastBefore('2027-01-12'), '2026-12-08');
    assert.strictEqual(quietDays('2027-02-10', 21), 21);
  });
  await check('lapsed: last session on the cut-off day counts, the day after does not; 3 sessions needed', () => {
    assert.deepStrictEqual(rule({ last_session_date: '2026-11-11' }), { kind: 'first' });
    assert.deepStrictEqual(rule({ last_session_date: '2026-11-12' }), { skip: 'not lapsed' });
    assert.deepStrictEqual(rule({ last_session_date: null }), { skip: 'not lapsed' });
    assert.deepStrictEqual(rule({ sessions_year: 2 }), { skip: 'fewer than 3 sessions' });
    assert.deepStrictEqual(rule({ sessions_year: 3 }), { kind: 'first' });
  });

  // ---- who is never nudged ----
  await check('never: opted out (the flag, or an opted_out row from any lapse)', () => {
    assert.deepStrictEqual(rule({ opted_out: true }), { skip: 'opted out' });
    assert.deepStrictEqual(rule({ nudges: [nudge('first', 'opted_out', '2026-09-20T16:00:00Z', '2026-08-30')] }), { skip: 'opted out' });
  });
  await check('never: internal and partner domains, excluded IDs, missing or broken emails', () => {
    assert.deepStrictEqual(rule({ email: 'Someone@PeerTeach.org' }), { skip: 'internal or partner' });
    assert.deepStrictEqual(rule({ email: 'x@leanlabeducation.org' }), { skip: 'internal or partner' });
    assert.deepStrictEqual(rule({ teacher_id: '999' }), { skip: 'internal or partner' });
    for (const email of [null, '', 'not an email', 'a@b', 'two@x.org, three@x.org', 'Name <a@b.org>']) assert.deepStrictEqual(rule({ email }), { skip: 'no usable email' }, String(email));
    assert.deepStrictEqual(rule({ nces_school_id: null }), { skip: 'no school ID' });
  });
  await check('feed: junk entries are dropped, junk nudge rows ignored', () => {
    for (const junk of [null, 'x', 5, {}, { first_name: 'No ID' }]) assert.strictEqual(parseTeacher(junk), null);
    const t = teacher({ teacher_id: 21775, nudges: [null, { kind: 'third', action: 'sent', created_at: '2026-11-01T00:00:00Z' }, { kind: 'first', action: 'sent' }, nudge('first', 'drafted', '2026-11-01T16:00:00Z')], classes: 'nope' });
    assert.strictEqual(t.teacherId, '21775');
    assert.strictEqual(t.nudges.length, 1);
    assert.deepStrictEqual(t.classes, []);
  });

  // ---- first, second, and what stops them ----
  await check('first: no rows for this lapse', () => assert.deepStrictEqual(rule(), { kind: 'first' }));
  await check('second: 21 days after the first was sent, stretched by holiday weeks like the lapse', () => {
    // Today Dec 9: the last 21 days touch Thanksgiving week, so the first must be 28 days old.
    assert.deepStrictEqual(rule({ nudges: [nudge('first', 'drafted', '2026-11-10T16:00:00Z'), nudge('first', 'sent', '2026-11-10T17:30:00Z')] }), { kind: 'second', firstSentAt: '2026-11-10T17:30:00Z' });
    assert.deepStrictEqual(rule({ nudges: [nudge('first', 'sent', '2026-11-12T17:30:00Z')] }), { skip: 'second check-in not due yet' });
    // No holidays near Feb 10: 21 days.
    const feb = (sent: string) => rule({ first_session_date: '2026-10-01', last_session_date: '2027-01-05', nudges: [nudge('first', 'sent', sent, '2027-01-05')] }, '2027-02-10');
    assert.deepStrictEqual(feb('2027-01-20T16:00:00Z'), { kind: 'second', firstSentAt: '2027-01-20T16:00:00Z' });
    assert.deepStrictEqual(feb('2027-01-21T16:00:00Z'), { skip: 'second check-in not due yet' });
  });
  await check('second sent: nothing more for this lapse', () => {
    const t = rule({ last_session_date: '2026-09-01', first_session_date: '2026-08-10', nudges: [nudge('first', 'sent', '2026-07-01T16:00:00Z', '2026-09-01'), nudge('second', 'sent', '2026-07-25T16:00:00Z', '2026-09-01')] });
    assert.deepStrictEqual(t, { skip: 'both check-ins sent' }); // (rows dated before August, so the semester limit isn't what stops it)
  });
  await check('skipped: that kind is not drafted again for this lapse', () => {
    assert.deepStrictEqual(rule({ nudges: [nudge('first', 'drafted', '2026-11-18T16:00:00Z'), nudge('first', 'skipped', '2026-11-18T18:00:00Z')] }), { skip: 'skipped by a person' });
    assert.deepStrictEqual(rule({ nudges: [nudge('first', 'sent', '2026-11-03T16:00:00Z'), nudge('second', 'skipped', '2026-12-02T16:00:00Z')] }), { skip: 'skipped by a person' });
    // A skip in an earlier lapse doesn't carry over.
    assert.deepStrictEqual(rule({ nudges: [nudge('first', 'skipped', '2026-10-01T16:00:00Z', '2026-09-08')] }), { kind: 'first' });
  });
  await check('waiting card: under 14 days no second card, at 14 days it may be drafted again', () => {
    assert.deepStrictEqual(rule({ nudges: [nudge('first', 'drafted', '2026-11-26T16:00:00Z')] }), { skip: 'card already waiting' }); // 13 days
    assert.deepStrictEqual(rule({ nudges: [nudge('first', 'drafted', '2026-11-25T16:00:00Z')] }), { kind: 'first' }); // 14 days
    // A failed send leaves the card clickable: still waiting.
    assert.deepStrictEqual(rule({ nudges: [nudge('first', 'drafted', '2026-12-02T16:00:00Z'), nudge('first', 'failed', '2026-12-02T17:00:00Z')] }), { skip: 'card already waiting' });
    // The same for a second check-in's card.
    assert.deepStrictEqual(rule({ nudges: [nudge('first', 'sent', '2026-11-03T16:00:00Z'), nudge('second', 'drafted', '2026-12-08T16:00:00Z')] }), { skip: 'card already waiting' });
  });
  await check('previewed: not previewed twice; once the mode is draft or live a real card is made', () => {
    const nudges = [nudge('first', 'previewed', '2026-12-01T16:00:00Z')];
    assert.deepStrictEqual(rule({ nudges }, TODAY, 'preview'), { skip: 'already previewed' });
    assert.deepStrictEqual(rule({ nudges }, TODAY, 'draft'), { kind: 'first' });
    assert.deepStrictEqual(rule({ nudges }, TODAY, 'live'), { kind: 'first' });
  });
  await check('new lapse: starts over with a first check-in', () => {
    const earlier = [nudge('first', 'sent', '2026-09-22T16:00:00Z', '2026-08-28'), nudge('second', 'skipped', '2026-10-13T16:00:00Z', '2026-08-28')];
    assert.deepStrictEqual(rule({ first_session_date: '2026-08-12', nudges: earlier }), { kind: 'first' });
  });
  await check('semester limit: two sent this semester (across lapses) and no more; January starts a new count', () => {
    assert.strictEqual(semesterStart('2026-12-09'), '2026-08-01');
    assert.strictEqual(semesterStart('2027-02-10'), '2027-01-01');
    const two = [nudge('first', 'sent', '2026-09-08T16:00:00Z', '2026-08-14'), nudge('second', 'sent', '2026-09-30T16:00:00Z', '2026-08-14')];
    assert.deepStrictEqual(rule({ first_session_date: '2026-08-10', nudges: two }), { skip: 'two already sent this semester' });
    // A Close draft counts: it is recorded as sent.
    assert.deepStrictEqual(rule({ first_session_date: '2026-08-10', nudges: [nudge('first', 'sent', '2026-09-08T16:00:00Z', '2026-08-14'), nudge('first', 'sent', '2026-10-13T16:00:00Z', '2026-09-20')] }), { skip: 'two already sent this semester' });
    assert.deepStrictEqual(rule({ first_session_date: '2026-08-10', last_session_date: '2027-01-15', nudges: [...two, nudge('first', 'sent', '2027-01-05T16:00:00Z', '2026-12-10')] }, '2027-02-10'), { kind: 'first' });
  });

  // ---- school weekly limit ----
  await check('school limit: a card drafted and then sent counts once; last week does not count', () => {
    const a = teacher({ teacher_id: 'a', nudges: [nudge('first', 'drafted', '2026-12-08T16:00:00Z'), nudge('first', 'sent', '2026-12-08T18:00:00Z')] });
    const b = teacher({ teacher_id: 'b', nudges: [nudge('first', 'drafted', '2026-12-06T16:00:00Z'), nudge('first', 'skipped', '2026-12-08T16:00:00Z')] }); // drafted on Sunday: last week
    const c = teacher({ teacher_id: 'c', nces_school_id: '888', nudges: [nudge('first', 'previewed', '2026-12-07T16:00:00Z')] });
    assert.deepStrictEqual([...schoolCardsThisWeek([a, b, c], TODAY)], [['63513007356', 1], ['888', 1]]);
  });
  await check('run: at most 2 cards per school per week, longest lapsed first, the rest wait', async () => {
    process.env.LAPSE_NUDGE_MODE = 'live';
    const f = fake([
      raw({ teacher_id: 'newest', last_session_date: '2026-11-05', email: 'n@srvusd.net' }),
      raw({ teacher_id: 'oldest', last_session_date: '2026-10-01', email: 'o@srvusd.net' }),
      raw({ teacher_id: 'middle', last_session_date: '2026-10-20', email: 'm@srvusd.net' }),
      raw({ teacher_id: 'other', nces_school_id: '000000000888', last_session_date: '2026-11-10', email: 'x@other.org' }),
    ]);
    const r = await runLapseNudges({ now: WED }, f.deps);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(f.rows.map((x) => [x.teacher_id, x.action]), [['oldest', 'drafted'], ['middle', 'drafted'], ['other', 'drafted']]);
    assert.deepStrictEqual([r.cards, r.waitingSchoolLimit], [3, 1]);
    assert.deepStrictEqual(f.reports, [':wave: 3 check-in drafts posted, 1 waiting: recent contact or weekly school limit']);
  });
  await check('run: a card already made at the school this week leaves room for one more', async () => {
    const f = fake([
      raw({ teacher_id: 'has_card', nudges: [nudge('first', 'drafted', '2026-12-08T16:00:00Z')] }),
      raw({ teacher_id: 'oldest', last_session_date: '2026-10-01', email: 'o@srvusd.net' }),
      raw({ teacher_id: 'middle', last_session_date: '2026-10-20', email: 'm@srvusd.net' }),
    ]);
    const r = await runLapseNudges({ now: WED }, f.deps);
    assert.deepStrictEqual(f.rows.map((x) => x.teacher_id), ['oldest']);
    assert.deepStrictEqual([r.cards, r.waitingSchoolLimit, r.leftAlone['card already waiting']], [1, 1, 1]);
  });

  // ---- holdout ----
  await check('holdout: the hash is stable (FNV-1a) and splits teachers by ID', () => {
    assert.strictEqual(stableHash(''), 0x811c9dc5);
    assert.strictEqual(stableHash('a'), 0xe40c292c);
    assert.strictEqual(stableHash('21775'), stableHash('21775'));
    assert.ok(EVEN.length >= 10 && ODD.length >= 10, `lopsided split: ${EVEN.length} even, ${ODD.length} odd`);
  });
  await check('holdout: odd IDs are held out up to and on the date, nobody after it or with no date', () => {
    assert.strictEqual(isHeldOut(ODD[0], '2026-12-09', '2027-01-31'), true);
    assert.strictEqual(isHeldOut(ODD[0], '2027-01-31', '2027-01-31'), true);
    assert.strictEqual(isHeldOut(ODD[0], '2027-02-01', '2027-01-31'), false);
    assert.strictEqual(isHeldOut(ODD[0], '2026-12-09', null), false);
    assert.strictEqual(isHeldOut(EVEN[0], '2026-12-09', '2027-01-31'), false);
  });
  await check('run: a held-out teacher gets no card and one held_out row per lapse; after the date, a card', async () => {
    process.env.LAPSE_NUDGE_MODE = 'live';
    process.env.NUDGE_HOLDOUT_UNTIL = '2027-01-31';
    const teachers = [raw({ teacher_id: ODD[0], email: 'odd@srvusd.net' }), raw({ teacher_id: EVEN[0], email: 'even@srvusd.net' })];
    const f = fake(teachers);
    const r = await runLapseNudges({ now: WED }, f.deps);
    assert.deepStrictEqual(f.rows.map((x) => [x.teacher_id, x.kind, x.action, x.lapse_started_on]), [[ODD[0], 'first', 'held_out', '2026-10-28'], [EVEN[0], 'first', 'drafted', '2026-10-28']]);
    assert.strictEqual(f.cards.length, 1);
    assert.deepStrictEqual(f.reports, [':wave: 1 check-in draft posted, 1 held out for the comparison group']);
    assert.strictEqual(f.emailCalls.filter((c) => c.leadId === 'lead_bollinger').length, 1); // Close was only asked about the teacher who got a card

    // Already recorded for this lapse: no second row, and a run with nothing new says nothing.
    const again = fake([raw({ teacher_id: ODD[0], email: 'odd@srvusd.net', nudges: [nudge('first', 'held_out', '2026-12-09T16:00:00Z')] })]);
    const r2 = await runLapseNudges({ now: WED }, again.deps);
    assert.deepStrictEqual([again.rows.length, again.cards.length, again.reports.length, r2.heldOut], [0, 0, 0, 0]);

    // After the date they are eligible like anyone else (the held_out row doesn't block).
    process.env.NUDGE_HOLDOUT_UNTIL = '2026-12-08';
    const after = fake([raw({ teacher_id: ODD[0], email: 'odd@srvusd.net', nudges: [nudge('first', 'held_out', '2026-12-02T16:00:00Z')] })]);
    await runLapseNudges({ now: WED }, after.deps);
    assert.deepStrictEqual(after.rows.map((x) => x.action), ['drafted']);
    assert.strictEqual(r.heldOut, 1);

    // A date that isn't one stops the run instead of guessing.
    process.env.NUDGE_HOLDOUT_UNTIL = 'January';
    const bad = fake(teachers);
    const r3 = await runLapseNudges({ now: WED }, bad.deps);
    assert.deepStrictEqual([r3.ok, bad.cards.length, bad.rows.length, bad.warnings.length], [false, 0, 0, 1]);
    delete process.env.NUDGE_HOLDOUT_UNTIL;
  });

  // ---- when the job runs ----
  await check('run days: Tuesday to Thursday only', () => {
    assert.deepStrictEqual(['2026-12-07', '2026-12-08', '2026-12-09', '2026-12-10', '2026-12-11', '2026-12-12', '2026-12-13'].map((d) => noRunReason(d)),
      ['not a Tuesday, Wednesday or Thursday', null, null, null, 'not a Tuesday, Wednesday or Thursday', 'not a Tuesday, Wednesday or Thursday', 'not a Tuesday, Wednesday or Thursday']);
    assert.strictEqual(noRunReason('2026-12-11', { anyWeekday: true }), null);
  });
  await check('run days: never in a holiday week, the week after one, or the summer pause', () => {
    assert.strictEqual(noRunReason('2026-11-24'), 'holiday week'); // Thanksgiving week
    assert.strictEqual(noRunReason('2026-12-01'), 'first week after a holiday week');
    assert.strictEqual(noRunReason('2026-11-18'), null);
    assert.strictEqual(noRunReason('2026-12-23'), 'holiday week');
    assert.strictEqual(noRunReason('2026-12-30'), 'holiday week'); // Jan 1 week
    assert.strictEqual(noRunReason('2027-01-06'), 'first week after a holiday week');
    assert.strictEqual(noRunReason('2027-01-12'), null);
    assert.strictEqual(noRunReason('2027-07-06'), 'summer pause');
    assert.strictEqual(noRunReason('2027-07-06', { anyWeekday: true }), 'summer pause');
    assert.strictEqual(noRunReason('2026-11-24', { anyWeekday: true }), 'holiday week');
  });
  await check('run: on a day it does not run, nothing is read, posted or recorded', async () => {
    process.env.LAPSE_NUDGE_MODE = 'live';
    for (const [now, why] of [['2026-12-07T16:00:00Z', 'not a Tuesday, Wednesday or Thursday'], ['2026-11-24T16:00:00Z', 'holiday week'], ['2026-12-02T16:00:00Z', 'first week after a holiday week'], ['2027-07-07T16:00:00Z', 'summer pause']]) {
      const f = fake([raw()]);
      const r = await runLapseNudges({ now: new Date(now) }, f.deps);
      assert.deepStrictEqual([r.ok, r.notToday], [true, why]);
      assert.deepStrictEqual([f.fetches.length, f.listed, f.cards.length, f.rows.length, f.warnings.length, f.reports.length], [0, 0, 0, 0, 0, 0]);
    }
    // The day is the Pacific one: 03:00 UTC on Friday is still Thursday evening in California.
    const f = fake([raw()]);
    assert.strictEqual((await runLapseNudges({ now: new Date('2026-12-11T03:00:00Z') }, f.deps)).today, '2026-12-10');
    assert.strictEqual(f.cards.length, 1);
  });
  await check('run: a stale feed makes no cards and posts one warning to the main channel', async () => {
    const f = fake([raw()], { fetchCandidates: async () => feed([raw()], '2026-11-30') });
    const r = await runLapseNudges({ now: WED }, f.deps);
    assert.strictEqual(r.stale, true);
    assert.deepStrictEqual([f.cards.length, f.rows.length, f.listed, f.reports.length, f.warnings.length], [0, 0, 0, 0, 1]);
    assert.ok(f.warnings[0].includes('stale') && f.warnings[0].includes('2026-11-30'));
  });
  await check('run: asks the feed for this school year and the holiday-stretched cut-off', async () => {
    const f = fake([]);
    const r = await runLapseNudges({ now: WED }, f.deps);
    assert.deepStrictEqual(f.fetches, [{ since: '2026-08-01', last_before: '2026-11-11' }]);
    assert.deepStrictEqual([r.ok, r.teachers, f.listed, f.reports.length], [true, 0, 0, 0]); // nobody lapsed: Close isn't even read
  });

  // ---- Close ----
  await check('run: a school with no Close lead, or no active deal on it or its district, gets nothing', async () => {
    const f = fake([
      raw({ teacher_id: 'nolead', nces_school_id: '000000000111', email: 'a@x.org' }),
      raw({ teacher_id: 'nodeal', nces_school_id: '000000000777', nces_district_id: '0000555', email: 'b@x.org' }),
    ]);
    const r = await runLapseNudges({ now: WED }, f.deps);
    assert.deepStrictEqual(r.leftAlone, { 'school has no Close lead': 1, 'no active deal': 1 });
    assert.deepStrictEqual([f.cards.length, f.rows.length, f.emailCalls.length, f.reports.length], [0, 0, 0, 0]);
  });
  await check('run: the deal may be on the school lead itself or on its district lead; the named lead is the one used', async () => {
    const f = fake([raw(), raw({ teacher_id: 'own', nces_school_id: '000000000888', nces_district_id: null, email: 'own@x.org' })]);
    await runLapseNudges({ now: WED }, f.deps);
    assert.deepStrictEqual(f.cards.map((c) => parseCardData(actionIdsValue(c.blocks))!.lead), ['lead_bollinger', 'lead_own_deal']);
    // Emails are looked up on the school lead and its district lead, for the last 14 days.
    assert.deepStrictEqual(f.emailCalls, [{ leadId: 'lead_bollinger', since: '2026-11-25T00:00:00Z' }, { leadId: 'lead_district', since: '2026-11-25T00:00:00Z' }, { leadId: 'lead_own_deal', since: '2026-11-25T00:00:00Z' }]);
  });
  await check('run: in touch in the last 14 days (either direction, school or district lead) waits and records nothing', async () => {
    const cases: Array<Record<string, CloseEmailRow[]>> = [
      { lead_bollinger: [{ direction: 'outgoing', date: '2026-12-01T18:00:00Z', from: 'katie@peerteach.org', to: ['mwright@srvusd.net'] }] },
      { lead_district: [{ direction: 'incoming', date: '2026-11-30T18:00:00Z', from: 'mwright@srvusd.net', to: ['soren@peerteach.org'] }] },
    ];
    for (const emails of cases) {
      const f = fake([raw()], {}, emails);
      const r = await runLapseNudges({ now: WED }, f.deps);
      assert.deepStrictEqual([r.waitingContact, f.cards.length, f.rows.length, f.reports.length], [1, 0, 0, 0]);
    }
    // Mail with someone else at the school doesn't hold this teacher back.
    const f = fake([raw()], {}, { lead_bollinger: [{ direction: 'outgoing', date: '2026-12-01T18:00:00Z', from: 'katie@peerteach.org', to: ['principal@srvusd.net'] }] });
    await runLapseNudges({ now: WED }, f.deps);
    assert.strictEqual(f.cards.length, 1);
  });
  await check('contact rules: who and when', () => {
    const emails: CloseEmailRow[] = [{ direction: 'outgoing', date: '2026-11-10T17:30:00Z', from: 'katie@peerteach.org', to: ['t@d.org'] }, { direction: 'incoming', date: '2026-11-15T09:00:00Z', from: 't@d.org', to: ['katie@peerteach.org'] }];
    assert.strictEqual(contactedSince(emails, 't@d.org', '2026-11-20T00:00:00Z'), false);
    assert.strictEqual(contactedSince(emails, 't@d.org', '2026-11-12T00:00:00Z'), true);
    assert.strictEqual(repliedSince(emails, 't@d.org', '2026-11-10T17:30:00Z'), true);
    assert.strictEqual(repliedSince(emails.slice(0, 1), 't@d.org', '2026-11-01T00:00:00Z'), false); // our own email is not a reply
    assert.strictEqual(repliedSince(emails, 't@d.org', '2026-11-16T00:00:00Z'), false);
    assert.deepStrictEqual(addressesIn(['Melissa Wright <MWright@SRVUSD.net>', { email: 'o\'brien@x.org' }]), ['mwright@srvusd.net', "o'brien@x.org"]);
  });
  const firstSent = [nudge('first', 'drafted', '2026-11-10T16:00:00Z'), nudge('first', 'sent', '2026-11-10T17:30:00Z')];
  await check('run: second check-in when the first went unanswered', async () => {
    const f = fake([raw({ nudges: firstSent })]);
    const r = await runLapseNudges({ now: WED }, f.deps);
    assert.deepStrictEqual([r.cards, r.second], [1, 1]);
    assert.strictEqual(header(f.cards[0].blocks), 'Second check-in');
    assert.deepStrictEqual(f.rows.map((x) => [x.kind, x.action]), [['second', 'drafted']]);
    assert.strictEqual(f.emailCalls[0].since, '2026-11-10T17:30:00Z'); // Close is read back to when the first went out
  });
  await check('run: a reply after the first check-in means no second one', async () => {
    const f = fake([raw({ nudges: firstSent })], {}, { lead_bollinger: [{ direction: 'incoming', date: '2026-11-12T09:00:00Z', from: 'mwright@srvusd.net', to: ['katie@peerteach.org'] }] });
    const r = await runLapseNudges({ now: WED }, f.deps);
    assert.deepStrictEqual([r.cards, f.cards.length, r.leftAlone['replied to the first check-in']], [0, 0, 1]);
    assert.deepStrictEqual(f.rows.map((x) => [x.kind, x.action, x.note]), [['second', 'skipped', 'teacher replied']]);
  });

  // ---- the emails ----
  const melissa = teacher();
  await check('first email: the exact text, with and without a calendar link', () => {
    const e = buildEmail('first', melissa, TODAY, { senderName: 'Katie', calendarUrl: '' });
    assert.strictEqual(e.subject, 'Checking in on PeerTeach');
    assert.strictEqual(e.body, "Hi Melissa,\n\nI noticed your Period 3 class ran 4 PeerTeach sessions earlier this fall, and it's been quiet since October 28. Totally understand if the calendar got away from you!\n\nIs there anything that got in the way? If it's finding the time, I'm happy to help you pick a slot that fits your week.\n\nKatie");
    const withCall = buildEmail('first', melissa, TODAY, { senderName: 'Katie', calendarUrl: 'https://calendly.com/katie-peerteach/quick' });
    assert.ok(withCall.body.includes("pick a slot that fits your week or hop on a quick call: https://calendly.com/katie-peerteach/quick.\n\nKatie"), withCall.body);
  });
  await check('second email: the exact text', () => {
    const e = buildEmail('second', melissa, TODAY, { senderName: 'Katie', calendarUrl: 'https://calendly.com/x' });
    assert.strictEqual(e.subject, 'Checking in on PeerTeach');
    assert.strictEqual(e.body, "Hi Melissa,\n\nJust floating this back up in case it got buried. If PeerTeach isn't a fit for your class right now, no worries at all: just reply and I won't nudge again. If you'd like to get going again, I can help you set up the next session in a few minutes.\n\nKatie");
  });
  await check('class phrase: named, already says class, blank, too long, an ID, several classes', () => {
    const c = (name: string, sessions = 4) => ({ name, sessions });
    assert.strictEqual(classPhrase([c('Period 3')]), 'your Period 3 class');
    assert.strictEqual(classPhrase([c('6th Grade Math')]), 'your 6th Grade Math class');
    assert.strictEqual(classPhrase([c('Math Class B')]), 'your class');
    assert.strictEqual(classPhrase([c('')]), 'your class');
    assert.strictEqual(classPhrase([]), 'your class');
    assert.strictEqual(classPhrase([c('A very long class-free name that goes on and on and on')]), 'your class');
    for (const id of ['123456', '9f8b2c1d-77aa-4c11-9d2e-000000000000', 'SEC00412', '3B', 'Math – Period 3', 'Math — P3']) assert.strictEqual(classPhrase([c(id)]), 'your class', id);
    assert.strictEqual(classPhrase([c('Period 3'), c('Period 5', 3)]), 'your classes');
  });
  await check('first email: several classes use the year count; one session is singular; no first name', () => {
    const several = buildEmail('first', teacher({ classes: [{ class_name: 'Period 3', sessions: 4 }, { class_name: 'Period 5', sessions: 3 }, { class_name: 'Unused', sessions: 0 }] }), TODAY, { senderName: 'Katie', calendarUrl: '' });
    assert.ok(several.body.includes('I noticed your classes ran 7 PeerTeach sessions earlier this fall'), several.body);
    const none = buildEmail('first', teacher({ classes: null, first_name: ' ' }), TODAY, { senderName: 'Katie', calendarUrl: '' });
    assert.ok(none.body.startsWith('Hi there,\n\nI noticed your class ran 7 PeerTeach sessions'), none.body);
    const one = buildEmail('first', teacher({ classes: [{ class_name: 'Period 3', sessions: 1 }] }), TODAY, { senderName: 'Katie', calendarUrl: '' });
    assert.ok(one.body.includes('ran 1 PeerTeach session earlier'), one.body);
    assert.ok(buildEmail('first', melissa, TODAY, { senderName: 'Jo', calendarUrl: '' }).body.endsWith('\n\nJo'));
  });
  await check('when phrase: a season only when it is true of the first session and of today', () => {
    assert.strictEqual(whenPhrase('2026-09-30', '2026-12-09'), 'earlier this fall');
    assert.strictEqual(whenPhrase('2026-09-30', '2027-02-10'), 'earlier this year'); // "this fall" would be wrong in February
    assert.strictEqual(whenPhrase('2026-12-03', '2027-01-20'), 'this winter');
    assert.strictEqual(whenPhrase('2027-01-11', '2027-03-02'), 'this winter');
    assert.strictEqual(whenPhrase('2027-01-11', '2027-05-04'), 'earlier this year');
    assert.strictEqual(whenPhrase('2027-03-09', '2027-05-04'), 'this spring');
    assert.strictEqual(whenPhrase('', '2027-05-04'), 'earlier this year');
    assert.strictEqual(whenPhrase('2027-06-01', '2027-05-04'), 'earlier this year');
  });
  await check('no em or en dashes in any email, whatever the feed sends', () => {
    const dashy = teacher({ first_name: 'Anne–Marie', classes: [{ class_name: 'Math — Period 3', sessions: 5 }] });
    for (const kind of ['first', 'second'] as const) {
      for (const t of [melissa, dashy]) {
        const e = buildEmail(kind, t, TODAY, { senderName: 'Katie', calendarUrl: 'https://calendly.com/katie-peerteach/quick' });
        assert.ok(!DASH.test(e.subject + e.body), e.body);
      }
    }
    assert.ok(buildEmail('second', dashy, TODAY, { senderName: 'Katie', calendarUrl: '' }).body.startsWith('Hi Anne-Marie,'));
  });

  // ---- cards ----
  await check('card: header, why, recipient, the whole email, four buttons; the email is not in a button value', () => {
    const blocks = liveCard();
    assert.strictEqual(header(blocks), 'Check-in for a teacher who stopped');
    const all = allText(blocks);
    for (const want of ['Bollinger Canyon Elementary: 7 sessions this year, last session 2026-10-28, 42 days ago', 'Melissa Wright (mwright@srvusd.net)', 'Katie (katie@peerteach.org), through Close', 'Checking in on PeerTeach']) assert.ok(all.includes(want), `card is missing: ${want}`);
    assert.deepStrictEqual(actionIds(blocks), [ACTION.approve, ACTION.edit, ACTION.skip, ACTION.never]);
    assert.deepStrictEqual(readCardEmail(blocks), EMAIL);
    for (const el of blocks.find((b: any) => b.type === 'actions').elements) {
      assert.ok(el.value.length < 2000 && !el.value.includes('quiet'), el.value);
      assert.deepStrictEqual(parseCardData(el.value), CARD);
    }
    assert.strictEqual(header(cardBlocks({ ...CARD, k: 'second' }, EMAIL, { mode: 'live', sender: 'Katie', leadUrl: 'x' })), 'Second check-in');
    // Long names can't push the value over Slack's limit.
    const long = cardData(teacher({ school_name: 'S'.repeat(5000), first_name: 'F'.repeat(5000) }), 'first', 'lead_x', TODAY);
    assert.ok(JSON.stringify(long).length < 600);
  });
  await check('card: Slack hands text back escaped; the email read from the card is the original', () => {
    const escaped = JSON.parse(JSON.stringify(liveCard()).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
    assert.deepStrictEqual(readCardEmail(escaped), EMAIL);
    assert.strictEqual(readCardEmail(doneBlocks('done', CARD, EMAIL)), null);
    assert.strictEqual(parseCardData('{"t":"1"}'), null);
    assert.strictEqual(parseCardData('not json'), null);
  });
  await check('card, preview mode: no Approve and no Edit, only Skip and Never, and it says why', () => {
    const blocks = liveCard('preview');
    assert.deepStrictEqual(actionIds(blocks), [ACTION.skip, ACTION.never]);
    assert.ok(allText(blocks).includes('Preview only: sending is switched off'));
    assert.ok(!allText(liveCard('live')).includes('Preview only'));
    assert.strictEqual(parseMode(undefined), 'preview');
    assert.strictEqual(parseMode('LIVE'), 'live');
    assert.strictEqual(parseMode('draft'), 'draft');
    assert.strictEqual(parseMode('on'), 'preview');
  });
  await check('summary line: only when there is something to say', () => {
    assert.strictEqual(summaryLine({ mode: 'live', cards: 3, heldOut: 2, waiting: 4 }), ':wave: 3 check-in drafts posted, 2 held out for the comparison group, 4 waiting: recent contact or weekly school limit');
    assert.strictEqual(summaryLine({ mode: 'preview', cards: 1, heldOut: 0, waiting: 0 }), ':wave: 1 check-in preview posted (sending is switched off)');
    assert.strictEqual(summaryLine({ mode: 'live', cards: 0, heldOut: 0, waiting: 9 }), null);
  });

  // ---- whole runs: modes ----
  await check('run, preview (the default): a card with no Approve, a previewed row, and not posted twice', async () => {
    delete process.env.LAPSE_NUDGE_MODE;
    const f = fake([raw()]);
    const r = await runLapseNudges({ now: WED }, f.deps);
    assert.deepStrictEqual([r.ok, r.mode, r.cards], [true, 'preview', 1]);
    assert.deepStrictEqual(actionIds(f.cards[0].blocks), [ACTION.skip, ACTION.never]);
    assert.deepStrictEqual(f.rows, [{ teacher_id: '100', nces_school_id: '063513007356', kind: 'first', action: 'previewed', lapse_started_on: '2026-10-28', slack_ts: '170000001.000100', actor: 'job' }]);
    assert.deepStrictEqual(f.reports, [':wave: 1 check-in preview posted (sending is switched off)']);
    const again = fake([raw({ nudges: [nudge('first', 'previewed', '2026-12-08T16:00:00Z')] })]);
    await runLapseNudges({ now: WED }, again.deps);
    assert.deepStrictEqual([again.cards.length, again.rows.length, again.listed], [0, 0, 0]);
  });
  await check('run, draft and live: a card with Approve and a drafted row; the card carries the email', async () => {
    for (const mode of ['draft', 'live']) {
      process.env.LAPSE_NUDGE_MODE = mode;
      const f = fake([raw()]);
      const r = await runLapseNudges({ now: WED }, f.deps);
      assert.strictEqual(r.mode, mode);
      assert.deepStrictEqual(actionIds(f.cards[0].blocks), [ACTION.approve, ACTION.edit, ACTION.skip, ACTION.never]);
      assert.deepStrictEqual(f.rows.map((x) => [x.action, x.slack_ts]), [['drafted', '170000001.000100']]);
      assert.ok(readCardEmail(f.cards[0].blocks)!.body.startsWith('Hi Melissa,\n\nI noticed your Period 3 class ran 4 PeerTeach sessions earlier this fall'));
    }
  });
  await check('run, dry: works out the cards (on any weekday) but posts nothing and records nothing', async () => {
    process.env.LAPSE_NUDGE_MODE = 'live';
    process.env.NUDGE_HOLDOUT_UNTIL = '2027-01-31';
    for (const now of [WED, new Date('2026-12-11T16:00:00Z')]) {
      const f = fake([raw({ teacher_id: EVEN[0] }), raw({ teacher_id: ODD[0], email: 'odd@srvusd.net' })]);
      const r = await runLapseNudges({ now, dryRun: true }, f.deps);
      assert.deepStrictEqual([r.ok, r.dryRun, r.cards, r.heldOut], [true, true, 1, 1]);
      assert.deepStrictEqual([f.cards.length, f.rows.length, f.warnings.length, f.reports.length], [0, 0, 0, 0]);
    }
    delete process.env.NUDGE_HOLDOUT_UNTIL;
    // Even an error stays out of Slack in a dry run.
    const f = fake([raw()], { listLeads: async () => { throw new Error('close down'); } });
    const r = await runLapseNudges({ now: WED, dryRun: true }, f.deps);
    assert.deepStrictEqual([r.ok, f.warnings.length], [false, 0]);
  });
  await check('run: never throws; a broken feed or Close is reported to the main channel and no card is made', async () => {
    process.env.LAPSE_NUDGE_MODE = 'live';
    const cases: Array<Partial<LapseNudgeDeps>> = [
      { fetchCandidates: async () => { throw new Error('Request failed with status code 500'); } },
      { fetchCandidates: async () => ({ ok: false, error: 'bad secret' }) },
      { fetchCandidates: async () => '<html>' },
      { listLeads: async () => [] },
      { leadFieldIds: async () => new Map<string, string>() },
      { activeDealLeadIds: async () => { throw new Error('close down'); } },
      { leadEmailsSince: async () => { throw new Error('429'); } },
      { postNote: async () => { throw new Error('slack down'); }, listLeads: async () => { throw new Error('close down'); } },
    ];
    for (const over of cases) {
      const f = fake([raw()], over);
      const r = await runLapseNudges({ now: WED }, f.deps);
      assert.strictEqual(r.ok, false);
      assert.ok(r.error);
      assert.deepStrictEqual([f.cards.length, f.rows.length, f.reports.length], [0, 0, 0]);
      if (!over.postNote) assert.ok(f.warnings.length === 1 && f.warnings[0].includes('Teacher check-in job failed'), JSON.stringify(f.warnings));
    }
  });
  await check('run: if the nudge log or Slack stops taking writes, the run stops instead of posting more cards', async () => {
    const two = [raw(), raw({ teacher_id: 'own', nces_school_id: '000000000888', email: 'own@x.org' })];
    const f = fake(two, { recordNudge: async () => { throw new Error('503'); } });
    const r = await runLapseNudges({ now: WED }, f.deps);
    assert.deepStrictEqual([r.ok, f.cards.length], [false, 1]);
    assert.ok(f.warnings[0].includes('nudge log could not be written'));
    const g = fake(two, { postCard: async () => undefined });
    const r2 = await runLapseNudges({ now: WED }, g.deps);
    assert.deepStrictEqual([r2.ok, g.rows.length], [false, 0]);
  });

  // ---- clicks ----
  await check('routing: only check-in buttons and the check-in edit window are ours', () => {
    for (const id of Object.values(ACTION)) assert.ok(isLapseNudgeAction(id));
    for (const id of ['send_reply', 'edit_send', 'skip', 'open_unibox', '', undefined]) assert.ok(!isLapseNudgeAction(id), String(id));
    assert.ok(!isLapseNudgeModal({ type: 'block_actions' }) && !isLapseNudgeModal({ type: 'view_submission', view: { callback_id: 'something_else' } }) && !isLapseNudgeModal(null));
  });
  await check('click, preview mode: Approve (even a forged one) creates nothing in Close and records nothing', async () => {
    for (const blocks of [liveCard('preview'), liveCard('live')]) {
      const f = clickFake();
      const c = click(ACTION.approve, blocks);
      await handleLapseNudgeAction(c.action, c.payload, f.deps, 'preview');
      assert.deepStrictEqual([f.created.length, f.rows.length, f.cardUpdates.length, f.emailChecks.length], [0, 0, 0, 0]);
      assert.ok(f.told[0].includes('Preview only: sending is switched off'));
    }
    const f = clickFake();
    const c = click(ACTION.edit, liveCard('preview'));
    await handleLapseNudgeAction(c.action, c.payload, f.deps, 'preview');
    assert.deepStrictEqual([f.modals.length, f.created.length], [0, 0]);
  });
  await check('click, live: Approve creates the Close email in the outbox from Katie, records sent, and the card says who', async () => {
    const f = clickFake();
    const c = click(ACTION.approve);
    await handleLapseNudgeAction(c.action, c.payload, f.deps, 'live');
    assert.deepStrictEqual(f.created, [{ leadId: 'lead_bollinger', to: 'mwright@srvusd.net', subject: SUBJECT, bodyText: EMAIL.body, status: 'outbox', user: KATIE }]);
    assert.deepStrictEqual(f.rows, [{ teacher_id: '100', nces_school_id: '063513007356', kind: 'first', action: 'sent', lapse_started_on: '2026-10-28', slack_ts: CARD_TS, actor: 'soren' }]);
    assert.deepStrictEqual(f.emailChecks, [{ leadId: 'lead_bollinger', since: '2026-12-09T16:00:00.000Z' }]);
    assert.ok(allText(lastCard(f).blocks).includes(':white_check_mark: *Sent* by <@U1>'));
    assert.ok(!cardIsOpen(lastCard(f).blocks)); // no buttons left
    assert.ok(allText(lastCard(f).blocks).includes('wondered <why>')); // the sent email stays on the card
  });
  await check('click, draft: Approve creates a Close draft, recorded as sent with the note "close draft"', async () => {
    const f = clickFake();
    const c = click(ACTION.approve, liveCard('draft'));
    await handleLapseNudgeAction(c.action, c.payload, f.deps, 'draft');
    assert.deepStrictEqual(f.created.map((p) => [p.status, p.leadId, p.to, p.user.id]), [['draft', 'lead_bollinger', 'mwright@srvusd.net', 'user_katie']]);
    assert.deepStrictEqual(f.rows.map((x) => [x.action, x.note, x.actor]), [['sent', 'close draft', 'soren']]);
    const done = allText(lastCard(f).blocks);
    assert.ok(done.includes(':memo: *Saved as a draft for Katie* by <@U1>') && !done.includes('*Sent*'), done);
  });
  await check('click: a Close failure records failed, says so, keeps the buttons, and never says sent', async () => {
    for (const over of [{ createEmail: async () => { throw new Error('400 sender is not a connected account'); } }, { findSender: async () => null }] as Array<Partial<NudgeActionDeps>>) {
      const f = clickFake(over);
      const c = click(ACTION.approve);
      await handleLapseNudgeAction(c.action, c.payload, f.deps, 'live');
      assert.deepStrictEqual(f.rows.map((x) => x.action), ['failed']);
      assert.ok(f.rows[0].note);
      const card = lastCard(f);
      assert.ok(cardIsOpen(card.blocks) && actionIds(card.blocks).includes(ACTION.approve));
      assert.ok(allText(card.blocks).includes('Close could not create the email') && allText(card.blocks).includes('nothing was sent'));
      assert.ok(!f.cardUpdates.some((u) => /\*Sent\*|Saved as a draft/.test(allText(u.blocks) + u.text)));
      assert.deepStrictEqual(readCardEmail(card.blocks), EMAIL); // a retry sends the same email
    }
  });
  await check('click: a second click on a card already dealt with does nothing', async () => {
    const first = clickFake();
    const c1 = click(ACTION.approve);
    await handleLapseNudgeAction(c1.action, c1.payload, first.deps, 'live');
    // Slack now shows the "Sent" card; a window still showing the old buttons clicks each of them.
    for (const id of Object.values(ACTION)) {
      const f = clickFake();
      const c = click(id, lastCard(first).blocks);
      await handleLapseNudgeAction(c.action, c.payload, f.deps, 'live');
      assert.deepStrictEqual([f.created.length, f.rows.length, f.cardUpdates.length, f.modals.length], [0, 0, 0, 0], id);
      assert.ok(f.told[0].includes('already dealt with'));
    }
  });
  await check('click: even with the buttons still showing, Approve sends nothing if Close already has an email with the teacher since the card', async () => {
    const f = clickFake({}, [{ direction: 'outgoing', date: '2026-12-09T16:05:00Z', from: 'katie@peerteach.org', to: ['mwright@srvusd.net'] }]);
    const c = click(ACTION.approve);
    await handleLapseNudgeAction(c.action, c.payload, f.deps, 'live');
    assert.deepStrictEqual([f.created.length, f.rows.length, f.cardUpdates.length], [0, 0, 0]);
    assert.ok(f.told[0].includes('Nothing was sent'));
    // If Close can't be asked, nothing is sent either.
    const g = clickFake({ leadEmailsSince: async () => { throw new Error('timeout'); } });
    await handleLapseNudgeAction(c.action, c.payload, g.deps, 'live');
    assert.deepStrictEqual([g.created.length, g.rows.length], [0, 0]);
  });
  await check('click: two Approve clicks at the same moment create one email', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const f = clickFake();
    const slow = f.deps.createEmail;
    f.deps.createEmail = async (p) => { await gate; return slow(p); };
    const c = click(ACTION.approve);
    const a = handleLapseNudgeAction(c.action, c.payload, f.deps, 'live');
    const b = handleLapseNudgeAction(c.action, c.payload, f.deps, 'live');
    await b;
    release();
    await a;
    assert.deepStrictEqual([f.created.length, f.rows.map((x) => x.action)], [1, ['sent']]);
  });
  await check('click: sent but the log is down: the card still says sent, with a warning, and the main channel is told', async () => {
    const f = clickFake({ recordNudge: async () => { throw new Error('503'); } });
    const c = click(ACTION.approve);
    await handleLapseNudgeAction(c.action, c.payload, f.deps, 'live');
    assert.strictEqual(f.created.length, 1);
    assert.ok(allText(lastCard(f).blocks).includes('*Sent* by <@U1>') && allText(lastCard(f).blocks).includes('could not be recorded'));
    assert.strictEqual(f.notes.length, 1);
  });
  await check('click: Skip and Never record who clicked and close the card; nothing goes to Close', async () => {
    for (const [id, action, words] of [[ACTION.skip, 'skipped', '*Skipped* by <@U1>'], [ACTION.never, 'opted_out', '*Never nudge this teacher*, set by <@U1>']]) {
      for (const mode of ['preview', 'live'] as const) {
        const f = clickFake();
        const c = click(id, liveCard(mode));
        await handleLapseNudgeAction(c.action, c.payload, f.deps, mode);
        assert.deepStrictEqual(f.rows, [{ teacher_id: '100', nces_school_id: '063513007356', kind: 'first', action, lapse_started_on: '2026-10-28', slack_ts: CARD_TS, actor: 'soren' }]);
        assert.ok(allText(lastCard(f).blocks).includes(words) && !cardIsOpen(lastCard(f).blocks));
        assert.deepStrictEqual([f.created.length, f.emailChecks.length], [0, 0]);
      }
    }
    // The log is down: the card is left as it was, so the click can be repeated.
    const f = clickFake({ recordNudge: async () => { throw new Error('503'); } });
    const c = click(ACTION.skip);
    await handleLapseNudgeAction(c.action, c.payload, f.deps, 'live');
    assert.deepStrictEqual([f.cardUpdates.length, f.told.length], [0, 1]);
  });
  await check('click: Edit opens a window with the email; saving puts the new text on the card, and Approve then sends exactly that', async () => {
    const f = clickFake();
    const c = click(ACTION.edit);
    await handleLapseNudgeAction(c.action, c.payload, f.deps, 'live');
    assert.deepStrictEqual([f.modals.length, f.rows.length, f.created.length], [1, 0, 0]);
    const view = f.modals[0].view;
    assert.strictEqual(f.modals[0].triggerId, 'trig_1');
    assert.strictEqual(view.blocks[2].element.initial_value, EMAIL.body);
    assert.ok(view.private_metadata.length < 3000);

    const submit = (subject: string, body: string) => ({ type: 'view_submission', user: { id: 'U2', name: 'katie' }, view: { callback_id: view.callback_id, private_metadata: view.private_metadata, state: { values: { subject: { value: { value: subject } }, body: { value: { value: body } } } } } });
    assert.ok(isLapseNudgeModal(submit('s', 'b')));
    assert.deepStrictEqual(lapseNudgeEditErrors(submit('Hello', '   ')), { body: 'The email needs a message.' });
    assert.deepStrictEqual(lapseNudgeEditErrors(submit('', 'Hi')), { subject: 'The email needs a subject.' });
    const edited = submit('A quick hello', 'Hi Melissa,\n\nShorter.\n\nKatie');
    assert.strictEqual(lapseNudgeEditErrors(edited), null);
    await applyLapseNudgeEdit(edited, f.deps, 'live');
    assert.deepStrictEqual([f.messageUpdates[0].channel, f.messageUpdates[0].ts], ['C_HEALTH', CARD_TS]);
    const card = f.messageUpdates[0].blocks;
    assert.ok(cardIsOpen(card) && allText(card).includes('Edited by <@U2>'));
    assert.deepStrictEqual([f.rows.length, f.created.length], [0, 0]); // saving an edit sends nothing

    const c2 = click(ACTION.approve, card);
    await handleLapseNudgeAction(c2.action, c2.payload, f.deps, 'live');
    assert.deepStrictEqual(f.created.map((p) => [p.subject, p.bodyText, p.status]), [['A quick hello', 'Hi Melissa,\n\nShorter.\n\nKatie', 'outbox']]);
  });

  // ---- shared with the health job ----
  await check('Sales Ops address: SALES_OPS_BASE_URL, else where SALES_OPS_HEALTH_URL points, else the default', () => {
    assert.strictEqual(salesOpsBase(), 'https://peerteach-email.lovable.app');
    process.env.SALES_OPS_HEALTH_URL = 'https://staging.example.test/api/public/peerteach/health';
    assert.strictEqual(salesOpsBase(), 'https://staging.example.test');
    process.env.SALES_OPS_BASE_URL = 'https://other.example.test/';
    assert.strictEqual(salesOpsBase(), 'https://other.example.test');
    delete process.env.SALES_OPS_HEALTH_URL;
    delete process.env.SALES_OPS_BASE_URL;
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

// The value of a card's first button (every button on a card carries the same one).
function actionIdsValue(blocks: any[]): string {
  return blocks.find((b) => b.type === 'actions').elements[0].value;
}

main();

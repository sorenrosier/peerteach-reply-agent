import axios from 'axios';
import { envOptional } from './env';
import { postInfoNote } from './slack';
import { CloseLeadRow, closeErrorText, closeLeadUrl, customFieldIds, ensureLeadTextField, listLeads, updateLead } from './closeCrm';
import {
  ALL_FIELDS,
  FIELD,
  HealthLabel,
  HealthLead,
  HealthPlan,
  LeadUpdate,
  addDays,
  aggregateSchools,
  chunkLines,
  dryRunSummary,
  healthLabel,
  isFeedStale,
  isSummerPause,
  parseExcludedIds,
  planHealth,
  recentWindow,
  schoolYearStart,
  slippedMessage,
  slippedSchools,
  unmatchedAlert,
} from './usageHealthRules';

// Nightly usage health: reads per-teacher usage from the Sales Ops app and writes each school's
// health onto its Close lead (PT Health, sessions, teachers, last session), plus a one-line
// roll-up on district leads, so the team can see which schools are thriving (Soren, 2026-11-26).
// The rules live in src/usageHealthRules.ts; this file only does the reading, writing and Slack.
//
// Schools are matched to leads by School NCES with leading zeros ignored. All leads that carry an
// NCES ID are read in one paginated listing and matched in memory. Nothing is ever created: a
// school with no lead is reported. A lead is only written when one of its values changes.
//
// If the feed's newest usage is more than 4 school days old (holiday weeks don't count) the feed
// is broken: nothing is written and Slack gets a warning, so a stale feed can't mark schools as
// stalled. From mid-June to mid-August the job does nothing at all.
//
// USAGE_HEALTH_MODE=live writes to Close. Anything else (the default) is a dry run: it reads the
// feed and Close, posts what it would do, and writes nothing and creates no fields.

const SALES_OPS_BASE_DEFAULT = 'https://peerteach-email.lovable.app';
// The Sales Ops app's address, without a trailing slash: SALES_OPS_BASE_URL, else wherever
// SALES_OPS_HEALTH_URL points, else the default. The check-in job (src/lapseNudges.ts) uses it too.
export function salesOpsBase(): string {
  const base = envOptional('SALES_OPS_BASE_URL');
  if (base) return base.replace(/\/+$/, '');
  try {
    const health = envOptional('SALES_OPS_HEALTH_URL');
    if (health) return new URL(health).origin;
  } catch { /* not a URL: use the default */ }
  return SALES_OPS_BASE_DEFAULT;
}
const MIN_PAIRS = 2; // a real session has at least two pairs
export const LEADS_QUERY = '"custom.School NCES":* or "custom.District NCES":*';
// Time budget: stop writing after this, so the run finishes inside its limit. Whatever is left
// still differs from Close tomorrow night, so the next run picks it up.
const RUN_BUDGET_MS = 90_000;

export const isLive = () => envOptional('USAGE_HEALTH_MODE') === 'live';

interface UsageQuery { since: string; from: string; to: string }

// Everything that touches the network, so scripts/checkUsageHealth.ts can run the job on fakes.
export interface UsageHealthDeps {
  fetchUsage(q: UsageQuery): Promise<any>;
  leadFieldIds(): Promise<Map<string, string>>; // lower-cased field name -> id
  ensureLeadTextField(name: string): Promise<string>;
  listLeads(query: string, customFieldIdList: string[]): Promise<CloseLeadRow[]>;
  updateLead(leadId: string, body: Record<string, any>): Promise<void>;
  postNote(text: string): Promise<void>; // warnings and errors: the main channel, where they get seen
  postReport(text: string): Promise<void>; // summaries and the Monday list: the health channel
}

async function fetchUsage(q: UsageQuery): Promise<any> {
  const secret = envOptional('PEERTEACH_USAGE_SECRET');
  if (!secret) throw new Error('PEERTEACH_USAGE_SECRET is not set');
  const res = await axios.get(envOptional('SALES_OPS_HEALTH_URL') || `${salesOpsBase()}/api/public/peerteach/health`, {
    headers: { 'x-peerteach-usage-secret': secret },
    params: { ...q, min_pairs: MIN_PAIRS },
    timeout: 30000,
  });
  return res.data;
}

const realDeps: UsageHealthDeps = { fetchUsage, leadFieldIds: () => customFieldIds('lead'), ensureLeadTextField, listLeads, updateLead,
  postNote: (text) => postInfoNote(text),
  // USAGE_HEALTH_SLACK_CHANNEL keeps the nightly summaries out of the channel where drafts wait
  // for a decision. Unset, or if the bot can't post there, they go to the main channel.
  postReport: (text) => postInfoNote(text, envOptional('USAGE_HEALTH_SLACK_CHANNEL') || undefined),
};

export interface UsageHealthResult {
  ok: boolean;
  mode: 'live' | 'dry';
  today: string;
  window?: { from: string; to: string; holidayWeeks: number };
  latestUsageDate?: string;
  stale?: boolean;
  paused?: boolean; // summer: the job did nothing
  error?: string;
  schools: number;
  labelCounts?: Record<HealthLabel, number>;
  matched: number;
  unmatched: number;
  duplicates: number;
  districtRollups: number;
  leadsToUpdate: number;
  updated: number;
  failed: number;
  deferred: number;
  slipped: number;
}

// The feed's teachers, or a thrown error when the response isn't a usable one.
export function teachersOf(body: any): any[] {
  if (!body || typeof body !== 'object' || body.ok !== true || !Array.isArray(body.teachers)) {
    throw new Error(`usage feed returned no usable data: ${JSON.stringify(body ?? null).slice(0, 200)}`);
  }
  return body.teachers;
}

export function toHealthLead(row: CloseLeadRow, ids: Map<string, string>): HealthLead {
  const val = (fieldName: string) => {
    const id = ids.get(fieldName.toLowerCase());
    return id ? String(row.custom[id] ?? '').trim() : '';
  };
  const current: Record<string, string> = {};
  for (const f of ALL_FIELDS) current[f] = val(f);
  return { id: row.id, name: row.name || '', dateCreated: row.dateCreated || '', schoolNces: val('School NCES'), districtNces: val('District NCES'), current };
}

// Never throws: a failure is logged, posted to Slack and returned as { ok: false }.
export async function runUsageHealth(opts: { forceDry?: boolean; now?: Date } = {}, deps: UsageHealthDeps = realDeps): Promise<UsageHealthResult> {
  const live = isLive() && !opts.forceDry;
  const now = opts.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const result: UsageHealthResult = { ok: true, mode: live ? 'live' : 'dry', today, schools: 0, matched: 0, unmatched: 0, duplicates: 0, districtRollups: 0, leadsToUpdate: 0, updated: 0, failed: 0, deferred: 0, slipped: 0 };
  const send = async (text: string, how: (part: string) => Promise<void>) => {
    for (const part of chunkLines(text)) {
      try { await how(part); } catch (err) { console.warn('[usageHealth] Slack post failed:', closeErrorText(err)); }
    }
  };
  const post = (text: string) => send(text, (part) => deps.postNote(part));
  const report = (text: string) => send(text, (part) => deps.postReport(part));
  try {
    const t0 = Date.now();
    if (isSummerPause(today)) {
      console.log(`[usageHealth] summer pause (${today}): nothing read or written`);
      return { ...result, paused: true };
    }
    const since = schoolYearStart(today);
    const window = recentWindow(today);
    result.window = window;
    const excluded = parseExcludedIds(envOptional('HEALTH_EXCLUDED_TEACHER_IDS'));

    const body = await deps.fetchUsage({ since, from: window.from, to: window.to });
    const teachers = teachersOf(body);
    result.latestUsageDate = String(body.latest_usage_date ?? '');
    if (isFeedStale(body.latest_usage_date, today)) {
      result.stale = true;
      console.warn(`[usageHealth] stale feed: latest_usage_date=${result.latestUsageDate || '(none)'}, today=${today}; nothing written`);
      await post(`:warning: *Usage health: the usage feed looks stale, so nothing was written to Close.* Its newest usage is ${result.latestUsageDate || 'missing'} and today is ${today} (more than 4 days old counts as broken, not counting holiday weeks).`);
      return result;
    }
    const schools = aggregateSchools(teachers, excluded);
    result.schools = schools.size;

    // Field IDs. A live run creates the PT fields on first use; a dry run creates nothing and
    // reports fields that don't exist yet as "(new field) <name>", the way the Close sync does.
    const ids = new Map(await deps.leadFieldIds());
    if (!ids.get('school nces') || !ids.get('district nces')) throw new Error('Close has no "School NCES" / "District NCES" lead field');
    if (live) for (const f of ALL_FIELDS) ids.set(f.toLowerCase(), await deps.ensureLeadTextField(f));
    const fieldKey = (name: string) => `custom.${ids.get(name.toLowerCase()) || `(new field) ${name}`}`;
    const wanted = ['School NCES', 'District NCES', ...ALL_FIELDS].map((f) => ids.get(f.toLowerCase())).filter((id): id is string => !!id);

    const leads = (await deps.listLeads(LEADS_QUERY, wanted)).map((row) => toHealthLead(row, ids));
    // An empty or field-less listing means the query or the field selection broke, not that Close
    // has no schools; stop before reporting every school as unmatched.
    if (!leads.some((l) => l.schoolNces)) throw new Error(`Close returned ${leads.length} leads and none has a School NCES`);

    const plan = planHealth(schools, leads, today);
    const updates: LeadUpdate[] = [...plan.schoolUpdates, ...plan.districtUpdates];
    Object.assign(result, { labelCounts: plan.labelCounts, matched: plan.matched.length, unmatched: plan.unmatched.length, duplicates: plan.duplicates.length, districtRollups: plan.districtRollups.length, leadsToUpdate: updates.length });

    for (const u of updates) {
      const fields = Object.fromEntries(Object.entries(u.fields).map(([name, v]) => [fieldKey(name), v]));
      if (!live) { console.log(`[usageHealth] would update ${u.leadId} ${u.leadName || '(unnamed)'} :: ${JSON.stringify(fields)}`); continue; }
      if (Date.now() - t0 > RUN_BUDGET_MS) { result.deferred++; continue; }
      try {
        await deps.updateLead(u.leadId, fields);
        result.updated++;
      } catch (err) {
        result.failed++;
        console.error(`[usageHealth] update failed for ${u.leadId}:`, closeErrorText(err));
      }
    }
    for (const d of plan.duplicates) console.log(`[usageHealth] duplicate School NCES ${d.nces}: using ${d.chosen.id}, ignoring ${d.ignored.map((i) => i.id).join(', ')}`);
    for (const u of plan.unmatched) console.log(`[usageHealth] no Close lead for ${u.schoolName || '(no name)'} ${u.ncesSchoolId}: ${u.sessionsWindow} in window, ${u.sessionsYear} this year`);

    if (!live) {
      await report(dryRunSummary(plan, { from: window.from, to: window.to, latestUsageDate: result.latestUsageDate }));
    } else {
      if (result.failed || result.deferred) await post(`:warning: *Usage health:* ${result.updated} lead${result.updated === 1 ? '' : 's'} updated in Close, ${result.failed} failed, ${result.deferred} left for the next run (out of time). Details are in the function logs.`);
      const alert = unmatchedAlert(plan);
      if (alert) await report(alert);
      if (isMondayPacific(now)) result.slipped = await postSlipped(plan, { since, today, excluded }, deps, post, report);
    }
    console.log(`[usageHealth] ${JSON.stringify(result)}`);
    return result;
  } catch (err) {
    const msg = closeErrorText(err);
    console.error('[usageHealth] failed:', msg);
    await post(`:warning: *Usage health job failed* (${result.mode === 'live' ? 'live' : 'dry run'}): \`${msg.slice(0, 500)}\``);
    return { ...result, ok: false, error: msg };
  }
}

function isMondayPacific(now: Date): boolean {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short' }).format(now) === 'Mon';
}

// Monday's "schools that slipped" list. The job rewrites PT Health every night, so by Monday the
// value stored in Close is only a day old and can't show a week's change. Instead the feed is
// asked for the window as it stood 7 days ago and the same rules give last week's labels.
async function postSlipped(
  plan: HealthPlan,
  ctx: { since: string; today: string; excluded: Set<string> },
  deps: UsageHealthDeps,
  post: (text: string) => Promise<void>,
  report: (text: string) => Promise<void>,
): Promise<number> {
  try {
    const then = recentWindow(addDays(ctx.today, -7));
    const body = await deps.fetchUsage({ since: ctx.since, from: then.from, to: then.to });
    const before = new Map<string, HealthLabel>();
    for (const [key, s] of aggregateSchools(teachersOf(body), ctx.excluded)) before.set(key, healthLabel(s));
    const slipped = slippedSchools(plan.matched, before, closeLeadUrl);
    const text = slippedMessage(slipped);
    if (text) await report(text);
    return slipped.length;
  } catch (err) {
    console.error('[usageHealth] slipped list failed:', closeErrorText(err));
    await post(`:warning: *Usage health:* Close was updated, but the weekly "schools that slipped" list could not be built: \`${closeErrorText(err).slice(0, 300)}\``);
    return 0;
  }
}

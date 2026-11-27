import axios from 'axios';
import { envOptional } from './env';
import { postInfoNote } from './slack';
import { ActiveOpportunity, CloseLeadRow, closeErrorText, closeLeadUrl, customFieldIds, ensureLeadTextField, listActiveOpportunities, listLeads, updateLead } from './closeCrm';
import { buildDigest, digestSkipReason } from './healthDigestRules';
import {
  ALL_FIELDS,
  HealthLabel,
  HealthLead,
  LeadUpdate,
  aggregateSchools,
  chunkLines,
  chunkSections,
  isFeedStale,
  isSummerPause,
  pacificDate,
  parseExcludedIds,
  planHealth,
  recentWindow,
  schoolYearStart,
  weekStart,
} from './usageHealthRules';

// Nightly usage health: reads per-teacher usage from the Sales Ops app and writes each school's
// health onto its Close lead (PT Health, sessions, teachers, last session), plus a one-line
// roll-up on district leads, so the team can see which schools are thriving (Soren, 2026-11-26).
// The rules live in src/usageHealthRules.ts and the Monday digest's in src/healthDigestRules.ts;
// this file only does the reading, writing and Slack.
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
// feed and Close, logs what it would write, and writes nothing and creates no fields.
//
// On Mondays (Pacific), in both modes, the health channel gets one digest naming the schools that
// stopped, are slowing down, are going well or never got going (Soren, 2026-11-27). Nothing else
// is posted there; the technical counts go to the function logs. No digest in a holiday week.

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
  activeOpportunities(): Promise<ActiveOpportunity[]>; // only read when the digest goes out
  updateLead(leadId: string, body: Record<string, any>): Promise<void>;
  postNote(text: string): Promise<void>; // warnings and errors: the main channel, where they get seen
  postReport(text: string): Promise<void>; // the Monday digest: the health channel
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

const realDeps: UsageHealthDeps = { fetchUsage, leadFieldIds: () => customFieldIds('lead'), ensureLeadTextField, listLeads, updateLead, activeOpportunities: listActiveOpportunities,
  postNote: (text) => postInfoNote(text),
  // USAGE_HEALTH_SLACK_CHANNEL keeps the digest out of the channel where drafts wait
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
  digest?: string; // 'posted', 'empty', 'failed', or why it wasn't due
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
// `forceDigest` (?digest=1) posts the digest on any day.
export async function runUsageHealth(opts: { forceDry?: boolean; forceDigest?: boolean; now?: Date } = {}, deps: UsageHealthDeps = realDeps): Promise<UsageHealthResult> {
  const live = isLive() && !opts.forceDry;
  const now = opts.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const result: UsageHealthResult = { ok: true, mode: live ? 'live' : 'dry', today, schools: 0, matched: 0, unmatched: 0, duplicates: 0, districtRollups: 0, leadsToUpdate: 0, updated: 0, failed: 0, deferred: 0 };
  const send = async (text: string, how: (part: string) => Promise<void>, split = chunkLines) => {
    for (const part of split(text)) {
      try { await how(part); } catch (err) { console.warn('[usageHealth] Slack post failed:', closeErrorText(err)); }
    }
  };
  const post = (text: string) => send(text, (part) => deps.postNote(part));
  const report = (text: string) => send(text, (part) => deps.postReport(part), chunkSections);
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

    console.log(`[usageHealth] ${plan.matched.length} matched, ${plan.unmatched.length} unmatched, ${plan.duplicates.length} duplicate NCES, ${plan.schoolUpdates.length} school leads to update (${plan.schoolsUnchanged} unchanged, ${plan.wentSilent} going Silent), ${plan.districtRollups.length} district roll-ups (${plan.districtUpdates.length} changed)`);
    for (const d of plan.districtRollups) console.log(`[usageHealth] district ${d.leadId} ${d.leadName || '(unnamed)'}: ${d.line}`);
    if (live && (result.failed || result.deferred)) await post(`:warning: *Usage health:* ${result.updated} lead${result.updated === 1 ? '' : 's'} updated in Close, ${result.failed} failed, ${result.deferred} left for the next run (out of time). Details are in the function logs.`);

    const day = pacificDate(now);
    const skip = digestSkipReason(day, opts.forceDigest);
    if (skip) result.digest = skip;
    else {
      try {
        const text = buildDigest({ schools, leads, opportunities: await deps.activeOpportunities(), today, weekOf: weekStart(day), leadUrl: closeLeadUrl });
        result.digest = text ? 'posted' : 'empty';
        if (text) await report(text);
      } catch (err) {
        result.digest = 'failed';
        console.error('[usageHealth] digest failed:', closeErrorText(err));
        await post(`:warning: *Usage health:* ${live ? 'Close was updated, but ' : ''}the weekly school health digest could not be built: \`${closeErrorText(err).slice(0, 300)}\``);
      }
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

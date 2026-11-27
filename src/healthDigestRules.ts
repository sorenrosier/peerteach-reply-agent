// The weekly school health digest the usage health job (src/usageHealth.ts) posts on Mondays.
// Pure: no network, no env, no clock; scripts/checkUsageHealth.ts asserts all of it and
// scripts/previewDigest.ts prints it from a saved feed.
//
// Decided with Soren (2026-11-27), after the nightly technical summary turned out to be something
// he "wouldn't know what to do with": one message a week that names schools and says why each is
// listed, with a link to its Close lead.
// - Stopped: Stalled (3+ sessions this year, none in the window).
// - Slowing down: sessions in the window, but under half the school's own usual pace (8+ sessions
//   before the window over 3+ school weeks, at a usual pace of at least 1.5 a week, so a school
//   that only ever ran one a week is not flagged). On track schools can be slowing down too.
// - Going well: the 3 busiest schools, new schools with 2+ sessions, and the On track count.
// - Never got going: Silent (1 or 2 sessions this year, none in the window).
// Matched schools carry the stage of the active deal on their lead, else on their district lead.

import type { ActiveOpportunity } from './closeCrm';
import { lastDatePhrase } from './lapseNudgeRules';
import { HealthLabel, HealthLead, SchoolUsage, addDays, chooseSchoolLeads, healthLabel, inHolidayWeek, normNces, recentWindow, weekStart } from './usageHealthRules';

export const SLOWING_MIN_BEFORE_SESSIONS = 8;
export const SLOWING_MIN_BEFORE_WEEKS = 3;
export const SLOWING_RATIO = 0.5; // slowing down: recent pace under half the usual pace
// A usual pace this low is already "about 1 a week": a drop from it is not news.
export const SLOWING_MIN_USUAL_PACE = 1.5;
export const TOP_SCHOOLS = 3;
export const NEW_MIN_SESSIONS = 2;
export const NEW_NAMED = 4;
export const SECTION_CAP = 10;
export const NEVER_CAP = 10;
export const NOT_IN_CLOSE_MIN_SESSIONS = 5; // in the window

// ---- when it posts ----

// Why no digest goes out today (`today` is the Pacific date), or null when it does: Mondays only,
// and not in a holiday week. `force` (?digest=1) sends it on any day, holiday weeks included.
export function digestSkipReason(today: string, force = false): string | null {
  if (force) return null;
  if (new Date(`${today}T00:00:00Z`).getUTCDay() !== 1) return 'not a Monday';
  if (inHolidayWeek(today)) return 'holiday week';
  return null;
}

// ---- paces ----

// Monday-start weeks that overlap from..to, holiday weeks left out; never less than 1.
export function schoolWeeks(from: string, to: string): number {
  let n = 0;
  for (let w = weekStart(from); w <= to; w = addDays(w, 7)) if (!inHolidayWeek(w)) n++;
  return Math.max(1, n);
}

export interface Paces { before: number; beforeWeeks: number; usual: number; recent: number; recentWeeks: number }

// Sessions a week before the window (from the school's first session to the day before the window)
// and in it. `beforeWeeks` is 0 when the school started inside the window: it has no usual pace.
export function schoolPaces(s: Pick<SchoolUsage, 'sessionsWindow' | 'sessionsYear' | 'firstSessionDate'>, window: { from: string; to: string }): Paces {
  const before = Math.max(0, s.sessionsYear - s.sessionsWindow);
  const recentWeeks = schoolWeeks(window.from, window.to);
  const dayBefore = addDays(window.from, -1);
  const beforeWeeks = s.firstSessionDate && s.firstSessionDate <= dayBefore ? schoolWeeks(s.firstSessionDate, dayBefore) : 0;
  return { before, beforeWeeks, usual: beforeWeeks ? before / beforeWeeks : 0, recent: s.sessionsWindow / recentWeeks, recentWeeks };
}

export function isSlowing(s: Pick<SchoolUsage, 'sessionsWindow'>, p: Paces): boolean {
  return s.sessionsWindow > 0 && p.before >= SLOWING_MIN_BEFORE_SESSIONS && p.beforeWeeks >= SLOWING_MIN_BEFORE_WEEKS && p.usual >= SLOWING_MIN_USUAL_PACE && p.recent < p.usual * SLOWING_RATIO;
}

// "about 5", "about 1" or "under 1" (add " a week" where it reads well). Never a decimal.
export function pacePhrase(perWeek: number): string {
  if (perWeek >= 1.5) return `about ${Math.round(perWeek)}`;
  if (perWeek >= 0.75) return 'about 1';
  return 'under 1';
}

// ---- names ----

const KEEP_UPPER = ['PCS', 'ISD', 'K-8'];

// Feed names that are all capitals, title-cased: "SCOTT VALLEY JR HIGH" -> "Scott Valley JR High".
// Short all-consonant tokens (JR, MS, G) and known abbreviations stay as they are. Anything with a
// lower-case letter is left alone. A token ending in a period is a word (ST. -> St.).
export function displayName(name: string): string {
  const n = name.trim();
  if (!/[A-Z]/.test(n) || n !== n.toUpperCase()) return n;
  return n.split(/\s+/).map((w) => {
    const letters = w.replace(/[^A-Z]/g, '');
    if (KEEP_UPPER.includes(w) || (letters.length > 0 && letters.length <= 3 && /^[B-DF-HJ-NP-TV-Z]+$/.test(letters) && !w.endsWith('.'))) return w;
    return w.charAt(0) + w.slice(1).toLowerCase();
  }).join(' ');
}

// Slack mrkdwn: &, < and > must be escaped in anything taken from the feed or Close.
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// "Oct 14".
export const shortDate = (d: string) => lastDatePhrase(d).replace(/^(\w{3})\w*/, '$1');
const listOf = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

// ---- schools -> sections ----

export interface DigestSchool {
  usage: SchoolUsage;
  label: HealthLabel;
  name: string; // the Close lead's name when it has one, else the feed's (title-cased)
  district: string; // shown in parentheses; blank unless another matched school shares the lead's District NCES
  lead: HealthLead | null;
  stage: string; // status label of the active deal on the lead or its district lead; blank if none
  paces: Paces;
}

export interface DigestSections {
  stopped: DigestSchool[];
  slowing: DigestSchool[];
  top: DigestSchool[];
  fresh: DigestSchool[]; // new this window
  onTrack: number;
  never: DigestSchool[];
  notInClose: DigestSchool[];
  recentWeeks: number;
  quietWeeks: number; // calendar weeks in the window, for "nothing for N+ weeks"
}

export interface DigestInput {
  schools: Map<string, SchoolUsage>;
  leads: HealthLead[];
  opportunities: ActiveOpportunity[];
  today: string; // the date the window ends on, as the job uses it
}

// The most recently updated active deal per lead.
function latestDeals(opps: ActiveOpportunity[]): Map<string, ActiveOpportunity> {
  const out = new Map<string, ActiveOpportunity>();
  for (const o of opps) {
    if (!o.leadId || !o.statusLabel.trim()) continue;
    const cur = out.get(o.leadId);
    if (!cur || o.dateUpdated > cur.dateUpdated) out.set(o.leadId, o);
  }
  return out;
}

// The stage of the active deal on the school lead, else the most recent one across its district
// leads (same District NCES, blank School NCES); blank when there is none.
export function dealStage(lead: HealthLead, feedDistrictKey: string, districtLeads: Map<string, HealthLead[]>, deals: Map<string, ActiveOpportunity>): string {
  const own = deals.get(lead.id);
  if (own) return own.statusLabel.trim();
  const district = (districtLeads.get(normNces(lead.districtNces) || feedDistrictKey) ?? []).map((l) => deals.get(l.id)).filter((o): o is ActiveOpportunity => !!o);
  district.sort((a, b) => b.dateUpdated.localeCompare(a.dateUpdated));
  return district[0]?.statusLabel.trim() ?? '';
}

// A label with "Awaiting Budget" or "Pilot" first, then any other active deal, then none.
const stageRank = (stage: string) => (!stage ? 2 : /awaiting budget|pilot/i.test(stage) ? 0 : 1);
const dealsFirst = (a: DigestSchool, b: DigestSchool) =>
  stageRank(a.stage) - stageRank(b.stage) || b.usage.sessionsYear - a.usage.sessionsYear || a.name.localeCompare(b.name);
const busiestFirst = (a: DigestSchool, b: DigestSchool) =>
  b.usage.sessionsWindow - a.usage.sessionsWindow || b.usage.sessionsYear - a.usage.sessionsYear || a.name.localeCompare(b.name);

export function digestSections(input: DigestInput): DigestSections {
  const window = recentWindow(input.today);
  const { byKey } = chooseSchoolLeads(input.leads);
  const districtLeads = new Map<string, HealthLead[]>();
  for (const l of input.leads) {
    const key = normNces(l.districtNces);
    if (key && !normNces(l.schoolNces)) districtLeads.set(key, [...(districtLeads.get(key) ?? []), l]);
  }
  const deals = latestDeals(input.opportunities);
  // District NCES -> how many matched schools' leads carry it.
  const matchedPerDistrict = new Map<string, number>();
  for (const s of input.schools.values()) {
    const d = normNces(byKey.get(s.key)?.districtNces);
    if (d) matchedPerDistrict.set(d, (matchedPerDistrict.get(d) ?? 0) + 1);
  }

  const all: DigestSchool[] = [...input.schools.values()].map((s) => {
    const lead = byKey.get(s.key) ?? null;
    const d = normNces(lead?.districtNces);
    const districtName = (districtLeads.get(d) ?? []).find((l) => l.name.trim())?.name.trim() || displayName(s.districtName);
    return {
      usage: s,
      label: healthLabel(s),
      name: lead?.name.trim() || displayName(s.schoolName) || '(no name)',
      district: d && (matchedPerDistrict.get(d) ?? 0) > 1 ? districtName : '',
      lead,
      stage: lead ? dealStage(lead, s.districtKey, districtLeads, deals) : '',
      paces: schoolPaces(s, window),
    };
  });

  const slowing = all.filter((d) => isSlowing(d.usage, d.paces)).sort(dealsFirst);
  const slow = new Set(slowing);
  const top = all.filter((d) => d.usage.sessionsWindow > 0 && !slow.has(d)).sort(busiestFirst).slice(0, TOP_SCHOOLS);
  const inTop = new Set(top);
  const days = Math.round((Date.parse(`${window.to}T00:00:00Z`) - Date.parse(`${window.from}T00:00:00Z`)) / 86400000) + 1;
  return {
    stopped: all.filter((d) => d.label === 'Stalled').sort(dealsFirst),
    slowing,
    top,
    fresh: all.filter((d) => !!d.usage.firstSessionDate && d.usage.firstSessionDate >= window.from && d.usage.sessionsYear >= NEW_MIN_SESSIONS && !inTop.has(d) && !slow.has(d)).sort(busiestFirst),
    onTrack: all.filter((d) => d.label === 'On track').length,
    never: all.filter((d) => d.label === 'Silent').sort((a, b) => a.name.localeCompare(b.name)),
    notInClose: all.filter((d) => !d.lead && d.usage.sessionsWindow >= NOT_IN_CLOSE_MIN_SESSIONS).sort(busiestFirst),
    recentWeeks: schoolWeeks(window.from, window.to),
    quietWeeks: Math.floor(days / 7),
  };
}

// ---- sections -> text ----

const bold = (d: DigestSchool) => `*${esc(d.name)}*${d.district ? ` (${esc(d.district)})` : ''}`;
const stageText = (d: DigestSchool) => (d.stage ? ` ${esc(d.stage)}${/[.!?]$/.test(d.stage) ? '' : '.'}` : '');
const ending = (d: DigestSchool, leadUrl: (id: string) => string) => (d.lead ? ` <${leadUrl(d.lead.id)}|Open in Close>` : ' (no Close lead)');
const teachersActive = (u: SchoolUsage) => `${u.activeTeachers} of ${plural(u.teachersEver, 'teacher')} active`;

export function stoppedLine(d: DigestSchool, leadUrl: (id: string) => string): string {
  const u = d.usage;
  const since = u.lastSessionDate ? `none since ${shortDate(u.lastSessionDate)}` : 'none recently';
  return `• ${bold(d)}: ${plural(u.sessionsYear, 'session')}, ${since}. ${plural(u.teachersEver, 'teacher')}.${stageText(d)}${ending(d, leadUrl)}`;
}

export function slowingLine(d: DigestSchool, leadUrl: (id: string) => string): string {
  return `• ${bold(d)}: ${pacePhrase(d.paces.recent)} a week, was ${pacePhrase(d.paces.usual)}. ${teachersActive(d.usage)}.${stageText(d)}${ending(d, leadUrl)}`;
}

function capped(lines: string[]): string[] {
  return lines.length > SECTION_CAP ? [...lines.slice(0, SECTION_CAP), `…and ${lines.length - SECTION_CAP} more (see Close: PT Health)`] : lines;
}

function names(list: DigestSchool[], max: number): string {
  const shown = list.slice(0, max).map((d) => esc(d.name));
  return list.length > max ? `${shown.join(', ')} and ${list.length - max} more` : listOf(shown);
}

// The digest as posted, or null when every section is empty. `weekOf` is this Monday.
export function buildDigest(input: DigestInput & { weekOf: string; leadUrl: (leadId: string) => string }): string | null {
  const s = digestSections(input);
  const blocks: string[][] = [];
  if (s.stopped.length) blocks.push([`*Stopped:* a real start, then nothing for ${s.quietWeeks}+ weeks`, ...capped(s.stopped.map((d) => stoppedLine(d, input.leadUrl)))]);
  if (s.slowing.length) blocks.push(['*Slowing down:* well below their own usual pace', ...capped(s.slowing.map((d) => slowingLine(d, input.leadUrl)))]);

  const well: string[] = [];
  const [first, ...rest] = s.top;
  if (first) well.push(`• ${bold(first)}: ${plural(first.usage.sessionsWindow, 'session')} in ${plural(s.recentWeeks, 'week')}, ${teachersActive(first.usage)}.`);
  for (const d of rest) well.push(`• ${bold(d)}: ${plural(d.usage.sessionsWindow, 'session')}, ${teachersActive(d.usage)}.`);
  if (s.fresh.length) {
    const shown = s.fresh.slice(0, NEW_NAMED);
    const counts = shown.map((d) => d.usage.sessionsYear);
    const ran = shown.length === 1 ? `ran ${counts[0]} in its first weeks` : counts.every((c) => c === counts[0]) ? `each ran ${counts[0]} in their first weeks` : `ran ${listOf(counts.map(String))} in their first weeks`;
    const more = s.fresh.length > NEW_NAMED ? `, plus ${s.fresh.length - NEW_NAMED} more` : '';
    well.push(`• New: ${listOf(shown.map(bold))} ${ran}${more}.`);
  }
  if (s.onTrack) well.push(`• ${plural(s.onTrack, 'school')} on track overall.`);
  if (well.length) blocks.push(['*Going well*', ...well]);

  if (s.never.length) blocks.push([`*Never got going* (1 or 2 sessions): ${names(s.never, NEVER_CAP)}.`]);
  if (s.notInClose.length) blocks.push([`Not in Close yet: ${names(s.notInClose, SECTION_CAP)}. Create a lead so they show up here.`]);

  if (!blocks.length) return null;
  return [`*School health, week of ${shortDate(input.weekOf)}*`, ...blocks.map((b) => b.join('\n'))].join('\n\n');
}

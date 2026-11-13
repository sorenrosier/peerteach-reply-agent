import axios from 'axios';

// Public school statistics from the Urban Institute's Education Data API (free, no key), which
// republishes NCES's Common Core of Data (CCD) and the Civil Rights Data Collection (CRDC).
// https://educationdata.urban.org/documentation/
//
// - Address, enrollment, free/reduced lunch, enrollment by grade and by race: CCD, latest year.
// - English learners: CRDC, which is collected every other year and lags (2021 is the latest
//   published), so EL % is a few years older than the rest.
//
// Two quirks, both seen live on 2026-11-12:
// - Cloudflare answers 403 (an HTML page) to Node's default fetch user agent; any explicit
//   User-Agent works.
// - Requests sometimes hang for 25+ seconds, then succeed on retry. Short timeouts + retries.

const BASE = 'https://educationdata.urban.org/api/v1/';
const CCD_YEARS = [2024, 2023]; // newest first; fall back if a year isn't published for this school
const CRDC_YEAR = 2021;
const GRADES = [3, 4, 5, 6, 7, 8, 9];
export const PRICE_PER_STUDENT = 20;

const http = axios.create({ baseURL: BASE, timeout: 9000, headers: { 'User-Agent': 'peerteach-reply-agent/1.0', Accept: 'application/json' } });

async function getAll(path: string): Promise<any[]> {
  const out: any[] = [];
  let url: string | null = path;
  for (let page = 0; url && page < 10; page++) {
    let data: any = null;
    for (let attempt = 1; attempt <= 3 && !data; attempt++) {
      try {
        const res = await http.get(url);
        if (typeof res.data === 'object' && res.data) data = res.data;
      } catch (err) {
        if (attempt === 3) throw err;
      }
    }
    if (!data) throw new Error(`no data from ${path}`);
    out.push(...(data.results ?? []));
    url = data.next ? String(data.next).replace(BASE, '') : null;
  }
  return out;
}

// CCD uses negative numbers for missing (-1), not applicable (-2) and suppressed (-3).
const num = (v: any): number | null => (typeof v === 'number' && v >= 0 ? v : null);
const pct = (part: number | null, whole: number | null): string | undefined =>
  part !== null && whole ? `${Math.round((part / whole) * 100)}%` : undefined;
const dollars = (n: number) => `$${n.toLocaleString('en-US')}`;

// Runs fn over items, at most `limit` at a time.
async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

export function padNces(id: string | number | undefined | null, length: 7 | 12): string {
  const s = String(id ?? '').replace(/\D/g, '');
  return s ? s.padStart(length, '0') : '';
}

export interface SchoolStats {
  year: number;
  schoolName?: string;
  districtName?: string;
  address?: { street: string; city: string; state: string; zip: string };
  phone?: string;
  schoolEnrollment?: number;
  schoolGrades3to9?: number;
  districtGrades3to9?: number;
  // Formatted for Close's text fields, e.g. "55%" and "$861".
  schoolFrlPct?: string;
  districtFrlPct?: string;
  schoolHispanicPct?: string;
  districtHispanicPct?: string;
  schoolElPct?: string;
  districtElPct?: string;
  schoolOpportunity?: string;
  districtOpportunity?: string;
  // What couldn't be fetched (the rest is still usable).
  missing: string[];
}

async function totalByGrade(kind: 'schools' | 'school-districts', year: number, idParam: string): Promise<number | null> {
  const rows = await pool(GRADES, 4, async (g) => {
    const r = await getAll(`${kind}/ccd/enrollment/${year}/grade-${g}/?${idParam}`);
    // A grade the school doesn't offer comes back with no rows: 0 students.
    const total = r.find((x) => x.race === 99 && x.sex === 99) ?? r[0];
    return num(total?.enrollment) ?? 0;
  });
  return rows.reduce((a, b) => a + b, 0);
}

async function hispanicShare(kind: 'schools' | 'school-districts', year: number, idParam: string): Promise<string | undefined> {
  const r = await getAll(`${kind}/ccd/enrollment/${year}/grade-99/race/?${idParam}`);
  const all = num(r.find((x) => x.race === 99 && x.sex === 99)?.enrollment);
  const hisp = num(r.find((x) => x.race === 3 && x.sex === 99)?.enrollment);
  return pct(hisp, all);
}

// English learners from CRDC, summed over the rows returned (one school, or every school in a district).
async function elShare(idParam: string): Promise<string | undefined> {
  const r = await getAll(`schools/crdc/enrollment/${CRDC_YEAR}/lep/sex/?${idParam}&sex=99`);
  const rows = r.filter((x) => x.race === 99 && x.disability === 99);
  // Dedupe (the API sometimes repeats a row) by school + lep.
  const seen = new Map<string, any>();
  for (const x of rows) seen.set(`${x.ncessch}|${x.lep}`, x);
  let el = 0, all = 0;
  for (const x of seen.values()) {
    const n = num(x.enrollment_crdc);
    if (n === null) continue;
    if (x.lep === 1) el += n;
    else if (x.lep === 99) all += n;
  }
  return all ? pct(el, all) : undefined;
}

// Everything we can learn about a school and its district. Never throws: whatever failed is
// listed in `missing`.
export async function getSchoolStats(schoolNces: string, districtNces: string): Promise<SchoolStats> {
  const s = padNces(schoolNces, 12);
  const l = padNces(districtNces, 7) || (s ? s.slice(0, 7) : '');
  const stats: SchoolStats = { year: CCD_YEARS[0], missing: [] };
  const attempt = async (label: string, fn: () => Promise<void>) => {
    try { await fn(); } catch { stats.missing.push(label); }
  };

  // The newest CCD year that has this school (or district, for a district-level lead).
  let year = CCD_YEARS[0];
  let dir: any = null;
  await attempt('school directory', async () => {
    for (const y of CCD_YEARS) {
      const r = s ? await getAll(`schools/ccd/directory/${y}/?ncessch=${s}`) : [];
      if (r.length) { dir = r[0]; year = y; return; }
    }
    if (s) throw new Error('not found');
  });
  stats.year = year;
  if (dir) {
    stats.schoolName = dir.school_name;
    stats.districtName = dir.lea_name;
    stats.address = { street: dir.street_location || '', city: dir.city_location || '', state: dir.state_location || '', zip: dir.zip_location || '' };
    stats.phone = dir.phone || undefined;
    stats.schoolEnrollment = num(dir.enrollment) ?? undefined;
    stats.schoolFrlPct = pct(num(dir.free_or_reduced_price_lunch), num(dir.enrollment));
  }

  await Promise.all([
    s && attempt('school grades 3-9', async () => {
      const n = await totalByGrade('schools', year, `ncessch=${s}`);
      if (n !== null) { stats.schoolGrades3to9 = n; stats.schoolOpportunity = dollars(n * PRICE_PER_STUDENT); }
    }),
    s && attempt('school Hispanic %', async () => { stats.schoolHispanicPct = await hispanicShare('schools', year, `ncessch=${s}`); }),
    s && attempt('school EL %', async () => { stats.schoolElPct = await elShare(`ncessch=${s}`); }),
    l && attempt('district grades 3-9', async () => {
      const n = await totalByGrade('school-districts', year, `leaid=${l}`);
      if (n !== null) { stats.districtGrades3to9 = n; stats.districtOpportunity = dollars(n * PRICE_PER_STUDENT); }
    }),
    l && attempt('district Hispanic %', async () => { stats.districtHispanicPct = await hispanicShare('school-districts', year, `leaid=${l}`); }),
    l && attempt('district EL %', async () => { stats.districtElPct = await elShare(`leaid=${l}`); }),
    l && attempt('district FRL %', async () => {
      // CCD's district file has no lunch counts; sum the district's schools.
      const schools = await getAll(`schools/ccd/directory/${year}/?leaid=${l}`);
      let frl = 0, enr = 0;
      for (const x of schools) {
        const f = num(x.free_or_reduced_price_lunch), e = num(x.enrollment);
        if (f !== null && e !== null) { frl += f; enr += e; }
      }
      stats.districtFrlPct = pct(frl, enr);
      if (!stats.districtName && schools[0]) stats.districtName = schools[0].lea_name;
    }),
  ]);
  return stats;
}

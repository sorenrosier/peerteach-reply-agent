import fs from 'fs';
import { closeLeadUrl } from '../src/closeCrm';
import { buildDigest, digestSections } from '../src/healthDigestRules';
import { HealthLead, aggregateSchools, chunkLines, parseExcludedIds, recentWindow, weekStart } from '../src/usageHealthRules';

// Prints the Monday school health digest exactly as the job would post it, from a saved feed. No
// network. Each Slack message is printed in turn (a long digest is split on lines).
//   npx ts-node scripts/previewDigest.ts path/to/fixture.json
//
// The file is the health feed's response plus, optionally, Close data and the day:
//   {
//     "ok": true, "latest_usage_date": "2026-11-24",
//     "teachers": [ { "teacher_id": "1", "nces_school_id": "063513007356", "nces_district_id": "0635130",
//                     "school_name": "...", "district_name": "...", "sessions_window": 4, "sessions_year": 9,
//                     "first_session_date": "2026-09-01", "last_session_date": "2026-11-20", "email_domain": "srvusd.net" } ],
//     "leads": [ { "id": "lead_x", "name": "...", "school_nces": "63513007356", "district_nces": "635130", "date_created": "2025-03-01" } ],
//     "opportunities": [ { "lead_id": "lead_x", "status_label": "Pilot Launched", "date_updated": "2026-11-20T00:00:00Z" } ],
//     "today": "2026-11-30",
//     "week_of": "2026-11-30"
//   }
// `today` defaults to the current date and `week_of` to the Monday of `today`'s week.
// HEALTH_EXCLUDED_TEACHER_IDS is honoured as in the job.

const path = process.argv[2];
if (!path) {
  console.error('usage: npx ts-node scripts/previewDigest.ts <fixture.json>');
  process.exit(2);
}
const data = JSON.parse(fs.readFileSync(path, 'utf8'));
if (!Array.isArray(data?.teachers)) {
  console.error('the file has no "teachers" array');
  process.exit(2);
}
const str = (v: unknown) => String(v ?? '').trim();
const today = str(data.today) || new Date().toISOString().slice(0, 10);
const weekOf = str(data.week_of) || weekStart(today);
const leads: HealthLead[] = (data.leads ?? []).map((l: any) => ({
  id: str(l.id), name: str(l.name), dateCreated: str(l.date_created), schoolNces: str(l.school_nces), districtNces: str(l.district_nces), current: {},
}));
const opportunities = (data.opportunities ?? []).map((o: any) => ({ leadId: str(o.lead_id), statusLabel: str(o.status_label), dateUpdated: str(o.date_updated) }));
const schools = aggregateSchools(data.teachers, parseExcludedIds(process.env.HEALTH_EXCLUDED_TEACHER_IDS));

const w = recentWindow(today);
const s = digestSections({ schools, leads, opportunities, today });
console.error(`[preview] today ${today}, week of ${weekOf}, window ${w.from}..${w.to}; ${schools.size} schools, ${leads.length} leads, ${opportunities.length} active opportunities; stopped ${s.stopped.length}, slowing ${s.slowing.length}, new ${s.fresh.length}, on track ${s.onTrack}, never ${s.never.length}, not in Close ${s.notInClose.length}`);

const text = buildDigest({ schools, leads, opportunities, today, weekOf, leadUrl: closeLeadUrl });
if (!text) {
  console.error('[preview] every section is empty: nothing would be posted');
} else {
  const parts = chunkLines(text);
  parts.forEach((p, i) => {
    if (parts.length > 1) console.log(`----- message ${i + 1} of ${parts.length} -----`);
    console.log(p);
  });
}

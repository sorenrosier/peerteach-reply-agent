import { naturalTimePhrase } from '../src/agent';

// Verifies the natural day reference is accurate relative to "now",
// including timezone-boundary cases where UTC date != local date.
let pass = 0;
let fail = 0;

function check(label: string, iso: string, now: string, tz: string, expectedDayPart: string) {
  const out = naturalTimePhrase(iso, new Date(now), tz);
  const ok = out.startsWith(expectedDayPart);
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${label}\n       got: "${out}"  expected day: "${expectedDayPart}"`);
  ok ? pass++ : fail++;
}

// Anchor "now" = Tuesday, June 9 2026, 9:00 AM Eastern (13:00 UTC)
const nowET = '2026-06-09T13:00:00Z';

// Eastern-timezone prospect
check('today (same day, ET)',        '2026-06-09T18:00:00Z', nowET, 'America/New_York', 'today');        // 2pm ET Tue
check('tomorrow (Wed, ET)',          '2026-06-10T18:00:00Z', nowET, 'America/New_York', 'tomorrow');     // 2pm ET Wed
check('this Thursday (+2d, ET)',     '2026-06-11T18:00:00Z', nowET, 'America/New_York', 'this Thursday');
check('this Friday (+3d, ET)',       '2026-06-12T18:00:00Z', nowET, 'America/New_York', 'this Friday');
check('next Tuesday (+7d, ET)',      '2026-06-16T18:00:00Z', nowET, 'America/New_York', 'next Tuesday');
check('next Friday (+10d, ET)',      '2026-06-19T18:00:00Z', nowET, 'America/New_York', 'next Friday');
check('far out -> date (+21d, ET)',  '2026-06-30T18:00:00Z', nowET, 'America/New_York', 'Tuesday, June 30');

// Timezone-boundary case: a slot at 2026-06-10T01:00:00Z is
//   - June 9, 6:00 PM Pacific (still "today" for a CA prospect)
//   - June 9, 9:00 PM Eastern (still "today" ET)
// but its UTC date is June 10. Confirms we compute the day in the prospect's tz, not UTC.
check('late-night Pacific stays today', '2026-06-10T01:00:00Z', nowET, 'America/Los_Angeles', 'today'); // 6pm PDT Tue
check('late-night Eastern stays today', '2026-06-10T01:00:00Z', nowET, 'America/New_York', 'today');    // 9pm EDT Tue

// Reverse boundary: a slot at 2026-06-10T05:00:00Z is
//   - June 9, 10:00 PM Pacific ("today" PT)
//   - June 10, 1:00 AM Eastern ("tomorrow" ET)
// Same instant, different day label depending on tz — proves tz-correctness.
check('boundary: today in PT',  '2026-06-10T05:00:00Z', nowET, 'America/Los_Angeles', 'today');     // 10pm PDT Tue
check('boundary: tomorrow in ET','2026-06-10T05:00:00Z', nowET, 'America/New_York', 'tomorrow');     // 1am EDT Wed

// Arizona (no DST) sanity: should read MST and correct day
check('Arizona today (MST)', '2026-06-09T19:00:00Z', nowET, 'America/Phoenix', 'today'); // 12pm MST Tue

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

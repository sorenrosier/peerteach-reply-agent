import { computeGuestEmails, ThreadEmail } from '../src/agent';
import { InstantlyWebhookPayload } from '../src/types';

// Deterministic offline test for the auto-guest logic (no API calls).
// Rule: take the latest inbound email's from/to/cc, drop our own account and the
// primary invitee (lead), keep everyone else — including a second address for the
// same person. No judgment, no person-level dedupe (only exact-duplicate addresses).
let pass = 0;
let fail = 0;

function p(over: Partial<InstantlyWebhookPayload>): InstantlyWebhookPayload {
  return {
    timestamp: '', event_type: 'reply_received', workspace: '', campaign_id: '',
    campaign_name: '', lead_email: 'lead@school.edu', email_account: 'kreg@peerteach.us',
    unibox_url: '', email_id: '', email_subject: '', email_text: '', reply_html: '',
    reply_subject: '', reply_text_snippet: '', reply_text: '', ...over,
  };
}

function eq(label: string, got: string[], expected: string[]) {
  const a = [...got].sort().join(',');
  const b = [...expected].sort().join(',');
  const ok = a === b;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${label}\n       got:      [${got.join(', ')}]\n       expected: [${expected.join(', ')}]`);
  ok ? pass++ : fail++;
}

// Nick's case: CC'd colleagues + a different from-address than the lead. Our account
// (kreg) and the primary invitee (lead) are dropped; everyone else kept, including
// Nick's second address.
eq('CC colleagues + second address for same person',
  computeGuestEmails([
    { body: 'proposal', timestamp: '2026-06-08T15:00:00Z', isOutbound: true, from: 'kreg@peerteach.us', to: ['nicholas_reece@charleston.k12.sc.us'] },
    { body: 'reply', timestamp: '2026-06-08T16:00:00Z', isOutbound: false,
      from: 'nicholas_reece@charlestoncountyschools.gov',
      to: ['kreg@peerteach.us', 'marion_pond@charleston.k12.sc.us', 'nicole_richbourg@charleston.k12.sc.us'] },
  ] as ThreadEmail[], p({ lead_email: 'nicholas_reece@charleston.k12.sc.us', email_account: 'kreg@peerteach.us' })),
  ['nicholas_reece@charlestoncountyschools.gov', 'marion_pond@charleston.k12.sc.us', 'nicole_richbourg@charleston.k12.sc.us']);

// Plain 1:1 thread — no extra recipients, so no guests.
eq('plain 1:1 thread -> no guests',
  computeGuestEmails([
    { body: 'reply', timestamp: '2026-06-08T16:00:00Z', isOutbound: false, from: 'lead@school.edu', to: ['kreg@peerteach.us'] },
  ] as ThreadEmail[], p({})),
  []);

// cc field is included too.
eq('cc recipients included',
  computeGuestEmails([
    { body: 'reply', timestamp: '2026-06-08T16:00:00Z', isOutbound: false, from: 'lead@school.edu', to: ['kreg@peerteach.us'], cc: ['aide@school.edu'] },
  ] as ThreadEmail[], p({})),
  ['aide@school.edu']);

// Latest inbound is what counts — an earlier inbound's recipients are ignored.
eq('uses latest inbound only',
  computeGuestEmails([
    { body: 'old', timestamp: '2026-06-01T10:00:00Z', isOutbound: false, from: 'lead@school.edu', to: ['kreg@peerteach.us', 'oldperson@school.edu'] },
    { body: 'new', timestamp: '2026-06-08T16:00:00Z', isOutbound: false, from: 'lead@school.edu', to: ['kreg@peerteach.us', 'newperson@school.edu'] },
  ] as ThreadEmail[], p({})),
  ['newperson@school.edu']);

// Case-insensitive dedupe of exact-duplicate addresses.
eq('dedupe exact duplicates (case-insensitive)',
  computeGuestEmails([
    { body: 'reply', timestamp: '2026-06-08T16:00:00Z', isOutbound: false, from: 'lead@school.edu', to: ['kreg@peerteach.us', 'Aide@School.edu'], cc: ['aide@school.edu'] },
  ] as ThreadEmail[], p({})),
  ['aide@school.edu']);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

// Run with: npx ts-node scripts/testScenarios.ts
// Uses real Claude API but mocks Calendly — no bookings created.
// Outputs results to scripts/test-results.md

import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config();

import { runAgent, ThreadEmail } from '../src/agent';
import { InstantlyWebhookPayload } from '../src/types';
import { CalendlySlot, BookingResult } from '../src/calendly';

// ─── Fake Calendly data ───────────────────────────────────────────────────────

// Generate realistic slots Mon-Fri next 2 weeks, 9am-5pm ET (UTC-4)
function fakeSlotsForRange(startIso: string, endIso: string): CalendlySlot[] {
  const slots: CalendlySlot[] = [];
  const start = new Date(startIso);
  const end = new Date(endIso);
  // Round up to next clean 30-min boundary, at least 10 min in the future
  const floor = new Date(Math.max(start.getTime(), Date.now() + 10 * 60 * 1000));
  const roundedMs = Math.ceil(floor.getTime() / (30 * 60 * 1000)) * (30 * 60 * 1000);
  const cur = new Date(roundedMs);

  while (cur < end) {
    const day = cur.getDay();
    const hour = cur.getUTCHours();
    // weekdays only, 13:00-23:00 UTC = 9am-7pm ET = 6am-4pm PT
    if (day >= 1 && day <= 5 && hour >= 13 && hour < 23) {
      slots.push({ startTime: cur.toISOString(), schedulingUrl: '' });
    }
    cur.setTime(cur.getTime() + 30 * 60 * 1000);
  }
  return slots;
}

const mockGetAvailableTimes = async (startTime: string, endTime: string): Promise<CalendlySlot[]> => {
  return fakeSlotsForRange(startTime, endTime);
};

const mockBookMeeting = async (params: { startTime: string; name: string; email: string; timezone: string }): Promise<BookingResult> => {
  return {
    uri: 'https://api.calendly.com/scheduled_events/MOCK/invitees/MOCK',
    startTime: params.startTime,
    rescheduleUrl: 'https://calendly.com/reschedulings/MOCK',
    cancelUrl: 'https://calendly.com/cancellations/MOCK',
  };
};

const MOCKS = { getAvailableTimes: mockGetAvailableTimes, bookMeeting: mockBookMeeting };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function payload(overrides: Partial<InstantlyWebhookPayload> & { reply_text: string }): InstantlyWebhookPayload {
  return {
    timestamp: new Date().toISOString(),
    event_type: 'reply_received',
    workspace: 'test',
    campaign_id: 'test-campaign',
    campaign_name: 'Spring 2026 Outreach',
    lead_email: 'prospect@school.edu',
    email_account: 'katie@peerteach.com',
    unibox_url: 'https://app.instantly.ai/app/inbox',
    email_id: 'test-email-id',
    email_subject: 'PeerTeach',
    email_text: 'Hi, I wanted to share something that could help your students with math — PeerTeach is a free peer tutoring platform for grades 3-8.',
    reply_html: '',
    reply_subject: 'Re: PeerTeach',
    reply_text_snippet: overrides.reply_text,
    firstName: 'Jane',
    lastName: 'Smith',
    Role: 'Principal',
    School: 'Lincoln Elementary',
    ...overrides,
  };
}

// ─── Test scenarios ───────────────────────────────────────────────────────────

interface Scenario {
  name: string;
  description: string;
  payload: InstantlyWebhookPayload;
  thread: ThreadEmail[];
}

const SCENARIOS: Scenario[] = [
  {
    name: '1. Simple scheduling — no prior context',
    description: 'Prospect says yes and asks when you are free. No prior thread.',
    payload: payload({
      reply_text: "Hi Katie, yes happy to hop on a call! When are you available this week?",
      School: 'Lincoln Elementary, Brooklyn NY',
    }),
    thread: [],
  },

  {
    name: '2. Prospect requests next week specifically',
    description: 'Prospect is available but asks for next week specifically.',
    payload: payload({
      reply_text: "Sure, I'd be happy to chat. Can we do something next week though? This week is slammed.",
      School: 'Westwood Middle School, Chicago IL',
    }),
    thread: [],
  },

  {
    name: '3. Prospect proposes a specific time',
    description: 'Prospect offers a specific time. Agent should confirm it if available, not propose new times.',
    payload: payload({
      reply_text: "Yes, let's do it. How about Thursday at 2pm?",
      School: 'Sunset Elementary, San Diego CA',
    }),
    thread: [],
  },

  {
    name: '4. Multi-turn — agent already proposed times, prospect counters',
    description: 'Prior thread shows agent proposed Tuesday 11am and Thursday 2pm. Prospect asks for 3pm instead.',
    payload: payload({
      reply_text: "Thursday works but can we do 3pm instead of 2?",
      School: 'Riverside Elementary, Austin TX',
    }),
    thread: [
      {
        body: 'Hi Jane, I wanted to share something that could help your students with math — PeerTeach is a free peer tutoring platform for grades 3-8. Would you be open to a quick 20-min Zoom?',
        timestamp: '2026-05-28T14:00:00Z',
        isOutbound: true,
      },
      {
        body: "Hi Katie, yes happy to chat! When are you free?",
        timestamp: '2026-05-29T10:00:00Z',
        isOutbound: false,
      },
      {
        body: "Hi Jane, how does Tuesday, June 2 at 11:00 AM CDT or Thursday, June 4 at 2:00 PM CDT work?\n\nKatie\nPeerTeach",
        timestamp: '2026-05-29T10:30:00Z',
        isOutbound: true,
      },
      {
        body: "Thursday works but can we do 3pm instead of 2?",
        timestamp: '2026-05-29T15:00:00Z',
        isOutbound: false,
      },
    ],
  },

  {
    name: '5. Booking confirmation — prospect confirms the proposed time',
    description: 'Prior thread shows 2pm Thursday was proposed. Prospect confirms. Agent should book.',
    payload: payload({
      reply_text: "Thursday at 2pm works perfectly for me!",
      School: 'Lincoln Elementary, Brooklyn NY',
      lead_email: 'jane.smith@lincoln.edu',
      firstName: 'Jane',
      lastName: 'Smith',
    }),
    thread: [
      {
        body: 'Hi Jane, I wanted to share something about PeerTeach — a free math tutoring platform for grades 3-8.',
        timestamp: '2026-05-28T14:00:00Z',
        isOutbound: true,
      },
      {
        body: "Yes, let's chat! When works for you?",
        timestamp: '2026-05-29T09:00:00Z',
        isOutbound: false,
      },
      {
        body: "Hi Jane, how does Tuesday, June 3 at 11:00 AM EDT or Thursday, June 5 at 2:00 PM EDT work?\n\nKatie\nPeerTeach",
        timestamp: '2026-05-29T09:30:00Z',
        isOutbound: true,
      },
      {
        body: "Thursday at 2pm works perfectly for me!",
        timestamp: '2026-05-29T14:00:00Z',
        isOutbound: false,
      },
    ],
  },

  {
    name: '6. No reply needed — prospect just says thanks',
    description: 'Prospect sends a simple acknowledgment. No reply needed.',
    payload: payload({
      reply_text: "Great, thanks for the info! Looking forward to it.",
    }),
    thread: [
      {
        body: 'Hi Jane, I wanted to reach out about PeerTeach — a free math tutoring platform for grades 3-8.',
        timestamp: '2026-05-28T14:00:00Z',
        isOutbound: true,
      },
      {
        body: "Yes, let's connect! When works for you?",
        timestamp: '2026-05-29T08:00:00Z',
        isOutbound: false,
      },
      {
        body: "Hi Jane, how does Thursday, June 5 at 2:00 PM EDT work?\n\nKatie\nPeerTeach",
        timestamp: '2026-05-29T08:30:00Z',
        isOutbound: true,
      },
      {
        body: "Thursday at 2pm works perfectly!",
        timestamp: '2026-05-29T09:00:00Z',
        isOutbound: false,
      },
      {
        body: "Booked — calendar invite is on its way.\n\nKatie\nPeerTeach",
        timestamp: '2026-05-29T09:10:00Z',
        isOutbound: true,
      },
      {
        body: "Great, thanks for the info! Looking forward to it.",
        timestamp: '2026-05-29T10:00:00Z',
        isOutbound: false,
      },
    ],
  },

  {
    name: '7. California timezone',
    description: 'Prospect at LA school. Times should be in PT not ET.',
    payload: payload({
      reply_text: "Yes, I'd love to learn more. When are you free?",
      School: 'Greenwood Elementary, Los Angeles CA',
    }),
    thread: [],
  },

  {
    name: '8. Prospect requests 2 weeks from now',
    description: 'Prospect explicitly asks for availability 2 weeks out.',
    payload: payload({
      reply_text: "Interested! School year is wrapping up so I'm slammed this week and next. Can we find something in 2 weeks?",
      School: 'Oak Park Middle School, Dallas TX',
    }),
    thread: [],
  },

  {
    name: '9. Soft no',
    description: 'Prospect politely declines for now.',
    payload: payload({
      reply_text: "Thanks for reaching out but we already have a tutoring program in place and aren't looking to add anything new this year.",
    }),
    thread: [],
  },

  {
    name: '10. Wrong person',
    description: 'Email went to the wrong person. Agent should ask for the right contact, not escalate.',
    payload: payload({
      reply_text: "Hi, I'm actually the school secretary. I don't handle curriculum decisions. You'd want to talk to our principal.",
      Role: 'School Secretary',
    }),
    thread: [],
  },

  {
    name: '11. Hard no — unsubscribe',
    description: 'Prospect explicitly asks to be removed.',
    payload: payload({
      reply_text: "Please remove me from your mailing list. I'm not interested.",
    }),
    thread: [],
  },

  {
    name: '12. Referral — name only, no email',
    description: 'Prospect refers to someone else by name but no email. Agent should ask for the email.',
    payload: payload({
      reply_text: "You should talk to our instructional coach, Maria Gonzalez. She handles all curriculum decisions.",
    }),
    thread: [],
  },

  {
    name: '13. Referral — gives direct email',
    description: 'Prospect gives a direct email address. Should escalate to human to make the intro.',
    payload: payload({
      reply_text: "You should contact our AP directly — her email is maria.gonzalez@school.edu",
    }),
    thread: [],
  },

  {
    name: '14. Soft yes — asks about cost',
    description: 'Prospect interested but asks if it costs anything.',
    payload: payload({
      reply_text: "This sounds interesting, but is there a cost involved? We have basically no budget right now.",
    }),
    thread: [],
  },

  {
    name: '15. Kreg sending — check identity',
    description: 'Same scenario but from Kreg — should sign as Kreg Co-Founder.',
    payload: payload({
      reply_text: "Yes happy to chat, when are you free?",
      email_account: 'kreg@peerteach.com',
      School: 'Maple Elementary, Boston MA',
    }),
    thread: [],
  },

  // ── New edge case scenarios ────────────────────────────────────────────────

  {
    name: '16. Prospect says "morning works better for me"',
    description: 'Vague time preference — agent should find morning slots.',
    payload: payload({
      reply_text: "Happy to hop on a call! Mornings work better for me though, before noon if possible.",
      School: 'Jefferson Middle School, Denver CO',
    }),
    thread: [],
  },

  {
    name: '17. Prospect says "end of the week"',
    description: 'Vague day preference — agent should propose Thursday or Friday.',
    payload: payload({
      reply_text: "Sure, I can chat. End of the week works best for me.",
      School: 'Harbor View Elementary, Seattle WA',
    }),
    thread: [],
  },

  {
    name: '18. Prospect says just "sure"',
    description: 'Minimal reply showing interest but no details. Should propose times.',
    payload: payload({
      reply_text: "Sure.",
      School: 'Riverside Academy, Atlanta GA',
    }),
    thread: [],
  },

  {
    name: '19. Prospect asks what PeerTeach actually does',
    description: 'SOFT_YES — interested but wants more info before committing to a call.',
    payload: payload({
      reply_text: "This sounds interesting but can you tell me a bit more about how it actually works in the classroom? What does the teacher have to do?",
      School: 'Franklin Elementary, Portland OR',
    }),
    thread: [],
  },

  {
    name: '20. Prospect angry — too many emails',
    description: 'Hostile but not an explicit unsubscribe. Should escalate.',
    payload: payload({
      reply_text: "I've gotten 4 emails from you guys in the past month. This is way too much. Stop.",
      School: 'Lincoln High School, Phoenix AZ',
    }),
    thread: [],
  },

  {
    name: '21. Prospect is the AP not the principal',
    description: 'Still a relevant person — should treat as normal interest, not wrong person.',
    payload: payload({
      reply_text: "Hi, I'm the assistant principal here. I handle instructional programs. Yes, I'd be happy to learn more!",
      Role: 'Assistant Principal',
      School: 'Sunrise Elementary, Miami FL',
    }),
    thread: [],
  },

  {
    name: '22. Prospect wants to include their colleague',
    description: 'Prospect asks if they can bring someone else to the call.',
    payload: payload({
      reply_text: "Yes, I'd love to chat! Can I also include our math department head on the call?",
      School: 'Central Middle School, Columbus OH',
    }),
    thread: [],
  },

  {
    name: '23. Very long back-and-forth before confirming',
    description: 'Multi-turn thread with 5 exchanges. Prospect finally confirms a time.',
    payload: payload({
      reply_text: "Okay fine, let's just do Tuesday at 10am.",
      lead_email: 'david.chen@eastside.edu',
      firstName: 'David',
      lastName: 'Chen',
      School: 'Eastside K-8, San Francisco CA',
    }),
    thread: [
      { body: 'Hi David, I wanted to share PeerTeach with you — free math peer tutoring for grades 3-8.', timestamp: '2026-05-20T14:00:00Z', isOutbound: true },
      { body: "Interesting. Can you tell me more about how it works?", timestamp: '2026-05-21T10:00:00Z', isOutbound: false },
      { body: "Hi David, happy to! It's a structured peer tutoring program that runs during regular class time — no extra prep for teachers. Developed at Stanford and completely free this year. Worth a quick Zoom?\n\n-Katie.", timestamp: '2026-05-21T10:30:00Z', isOutbound: true },
      { body: "What grade levels does it cover?", timestamp: '2026-05-22T09:00:00Z', isOutbound: false },
      { body: "Hi David, grades 3-8, math. The Zoom would only be 20-30 minutes and I can walk you through exactly what it looks like. How does Wednesday, June 3 at 10:00 AM PDT or Thursday, June 4 at 2:00 PM PDT work?\n\n-Katie.", timestamp: '2026-05-22T09:30:00Z', isOutbound: true },
      { body: "I'm slammed this week. Maybe next week?", timestamp: '2026-05-22T14:00:00Z', isOutbound: false },
      { body: "Hi David, no problem at all. Here are a couple of times next week:\n- Monday, June 8 at 11:00 AM PDT\n- Tuesday, June 9 at 10:00 AM PDT\n\nEither of those work?\n\n-Katie.", timestamp: '2026-05-22T14:30:00Z', isOutbound: true },
      { body: "Okay fine, let's just do Tuesday at 10am.", timestamp: '2026-05-23T08:00:00Z', isOutbound: false },
    ],
  },

  {
    name: '24. Prospect replies to follow-up saying they already talked',
    description: 'Prospect is confused — thinks they already had the call. Should escalate.',
    payload: payload({
      reply_text: "Didn't we already do this call? I spoke with someone from your team last month.",
      School: 'Willowbrook Elementary, Charlotte NC',
    }),
    thread: [],
  },

  {
    name: '25. Prospect asks for "sometime next month"',
    description: 'Far future request — agent should fetch slots for next month.',
    payload: payload({
      reply_text: "Yes let's connect! Summer would be tough but I could do sometime in July.",
      School: 'Oakwood Academy, Minneapolis MN',
    }),
    thread: [],
  },

  {
    name: "26. Prospect won't attend, asks to invite CC'd colleagues",
    description: "Prospect confirms a time but says he won't attend and asks to send the invite to two CC'd colleagues whose emails the agent cannot see. Should escalate, not book.",
    payload: payload({
      reply_text: "Good morning, I have added Assistant Principal Ms. Richbourg and Instructional Coach Ms. Pond to this email. They can Zoom with you at 1:30 tomorrow, as I will be in another meeting. Please send them a calendar invite. Thanks!",
      firstName: 'Nick',
      lastName: 'Reece',
      Role: 'Principal',
      School: 'Moultrie Middle, Charleston SC',
    }),
    thread: [
      { body: "Hi Nick, would tomorrow at 1:30 PM or 4:30 PM work for a quick 30-minute Zoom?\n\nKreg", timestamp: '2026-06-08T15:00:00Z', isOutbound: true },
    ],
  },
];

// ─── Runner ───────────────────────────────────────────────────────────────────

async function runAll() {
  const lines: string[] = [
    '# PeerTeach Agent — Test Results',
    `**Run:** ${new Date().toISOString()}`,
    `**Model:** claude-sonnet-4-6`,
    `**Calendly:** mocked (no real API calls)`,
    '',
    '---',
    '',
  ];

  for (const scenario of SCENARIOS) {
    console.log(`\nRunning: ${scenario.name}`);
    const start = Date.now();

    let result;
    let error: string | undefined;
    try {
      result = await runAgent(scenario.payload, scenario.thread, MOCKS);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    lines.push(`## ${scenario.name}`);
    lines.push(`**${scenario.description}**`);
    lines.push('');
    lines.push(`**Prospect:** ${scenario.payload.firstName} ${scenario.payload.lastName} — ${scenario.payload.Role} @ ${scenario.payload.School}`);
    lines.push(`**Sending from:** ${scenario.payload.email_account}`);
    lines.push('');

    if (scenario.thread.length > 0) {
      lines.push('<details><summary>Prior thread</summary>');
      lines.push('');
      for (const e of scenario.thread) {
        const who = e.isOutbound ? 'Us' : 'Prospect';
        lines.push(`**[${who}]** ${e.body.slice(0, 200)}`);
        lines.push('');
      }
      lines.push('</details>');
      lines.push('');
    }

    lines.push(`**Their reply:** "${scenario.payload.reply_text}"`);
    lines.push('');

    if (error) {
      lines.push(`**ERROR:** ${error}`);
    } else if (result) {
      lines.push(`**Action:** \`${result.action}\`${result.booked ? ' (meeting booked)' : ''}`);
      lines.push('');

      if (result.action === 'draft' && result.draft) {
        lines.push('**Draft reply:**');
        lines.push('```');
        lines.push(result.draft);
        lines.push('```');
        lines.push('');
        const wordCount = result.draft.split(/\s+/).filter(Boolean).length;
        const hasEmDash = result.draft.includes('—') || result.draft.includes('–');
        const startsWithHi = result.draft.startsWith('Hi ');
        lines.push(`**Checks:** ${wordCount} words${wordCount > 80 ? ' ⚠️ over limit' : ' ✓'} | starts with Hi: ${startsWithHi ? '✓' : '✗'} | em dashes: ${hasEmDash ? '✗ found' : '✓ none'}`);
      } else if (result.action === 'escalate') {
        lines.push(`**Escalate reason:** ${result.reason}`);
      } else if (result.action === 'ooo') {
        lines.push(`**OOO return date:** ${result.returnDate ?? 'not mentioned'}`);
      }
    }

    lines.push('');
    lines.push(`*${elapsed}s*`);
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  const outPath = path.join(__dirname, 'test-results.md');
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log(`\n✓ Results written to ${outPath}`);
}

runAll().catch((err) => {
  console.error('Test runner failed:', err);
  process.exit(1);
});

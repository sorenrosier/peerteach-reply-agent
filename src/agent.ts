import Anthropic from '@anthropic-ai/sdk';
import { env } from './env';
import { getAvailableTimes, bookMeeting } from './calendly';
import { InstantlyWebhookPayload } from './types';

const MODEL = 'claude-sonnet-4-6';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface AgentResult {
  action: 'draft' | 'no_reply' | 'hard_no' | 'ooo' | 'escalate';
  draft?: string;
  booked?: boolean;
  bookingDetails?: {
    startTime: string;
    rescheduleUrl?: string;
    cancelUrl?: string;
  };
  returnDate?: string;
  reason?: string;
}

export interface ThreadEmail {
  body: string;
  timestamp: string;
  isOutbound: boolean;
}

const TOOLS: Anthropic.ToolUnion[] = [
  // Server-side web search — runs on Anthropic's infrastructure, no handler needed.
  // The agent uses this only when genuinely unsure about a fact (e.g. an ambiguous
  // school location it can't place, verifying a district name).
  { type: 'web_search_20250305', name: 'web_search', max_uses: 3 },
  {
    name: 'get_available_times',
    description:
      'Fetch real available meeting slots from the calendar for a date range. ' +
      'Use whenever you need to propose times OR verify whether a requested time is available. ' +
      'Calendly has a 7-day window limit per call — make multiple calls for wider ranges. ' +
      'Returns a list of available start times in ISO UTC format.',
    input_schema: {
      type: 'object' as const,
      properties: {
        start_time: {
          type: 'string',
          description: 'Start of range in ISO UTC format (e.g. 2026-06-02T00:00:00Z)',
        },
        end_time: {
          type: 'string',
          description: 'End of range in ISO UTC format, max 7 days after start_time',
        },
        timezone: {
          type: 'string',
          description: 'IANA timezone to format results in, based on prospect location (e.g. America/New_York, America/Chicago, America/Denver, America/Los_Angeles)',
        },
        requested_time: {
          type: 'string',
          description: 'Optional: ISO UTC time the prospect requested (e.g. "2026-06-05T19:00:00Z"). If provided, the tool will confirm if it is available or return the 2 closest alternatives.',
        },
      },
      required: ['start_time', 'end_time', 'timezone'],
    },
  },
  {
    name: 'book_meeting',
    description:
      'Book a meeting in Calendly. Only call this when the prospect has EXPLICITLY confirmed a specific time — ' +
      'e.g. "Yes, Thursday at 2pm works" or "That time works for me". ' +
      'Do NOT call this for general interest or ambiguous replies. ' +
      'The prospect will receive a Calendly confirmation email automatically.',
    input_schema: {
      type: 'object' as const,
      properties: {
        start_time: {
          type: 'string',
          description: 'The confirmed start time in ISO UTC format',
        },
        name: { type: 'string', description: 'Full name of the prospect' },
        email: { type: 'string', description: 'Email address of the prospect' },
        timezone: {
          type: 'string',
          description: 'IANA timezone of the prospect (e.g. America/New_York)',
        },
      },
      required: ['start_time', 'name', 'email', 'timezone'],
    },
  },
  {
    name: 'no_reply',
    description:
      'Call this when no reply is warranted — e.g. simple "Thanks!", natural conversation ending, ' +
      'OOO auto-replies, or when a booking was just confirmed and no follow-up is needed.',
    input_schema: {
      type: 'object' as const,
      properties: {
        reason: { type: 'string', description: 'Brief reason why no reply is needed' },
        is_ooo: {
          type: 'boolean',
          description: 'True if this is an out-of-office auto-reply',
        },
        return_date: {
          type: 'string',
          description: 'Return date if mentioned in an OOO reply',
        },
      },
      required: ['reason'],
    },
  },
  {
    name: 'hard_no',
    description:
      'Call when the prospect explicitly asks to be removed, unsubscribed, or stop being contacted. ' +
      'This will stop the sequence.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'escalate',
    description:
      'Call only when human judgment is truly required: angry or threatening replies, ' +
      'legal mentions, existing PeerTeach user replies, personal OOO messages with return dates, ' +
      'or situations too ambiguous to handle. ' +
      'Do NOT escalate wrong person situations — draft a reply asking for the right contact. ' +
      'DO escalate referrals where a direct email was given — human needs to handle the intro.',
    input_schema: {
      type: 'object' as const,
      properties: {
        reason: { type: 'string', description: 'Why this needs human review' },
      },
      required: ['reason'],
    },
  },
];

function getSenderIdentity(emailAccount: string): { firstName: string; signOff: string } {
  const lower = emailAccount.toLowerCase();
  if (lower.includes('kreg')) {
    return { firstName: 'Kreg', signOff: 'Kreg\nCo-Founder, PeerTeach' };
  }
  return { firstName: 'Katie', signOff: '-Katie.' };
}

// Returns the current phase of the US school year plus natural language guidance,
// derived from the current month so the agent's seasonal references are always accurate.
function getSchoolYearContext(now: Date): string {
  const month = now.getMonth(); // 0 = Jan, 5 = Jun, 7 = Aug, 8 = Sep
  const day = now.getDate();

  if (month === 5 && day <= 15) {
    return 'It is early-to-mid June, the very end of the school year. Administrators are wrapping up. A brief, warm acknowledgment like "as you close out the year" fits. Summer is a good time to plan ahead for fall.';
  }
  if ((month === 5 && day > 15) || month === 6 || (month === 7 && day <= 15)) {
    return 'It is summer break. Schools are mostly out. A light "hope you\'re enjoying the summer" fits naturally. This is a good window to plan ahead for the fall semester.';
  }
  if ((month === 7 && day > 15) || month === 8) {
    return 'It is back-to-school season. Administrators are gearing up for the new year. A brief "as you kick off the new year" fits.';
  }
  if (month === 9 || month === 10) {
    return 'It is fall, early in the school year. Things are in full swing. No strong seasonal note needed.';
  }
  if (month === 11) {
    return 'It is December, heading into winter break. A brief "before the holidays" or "heading into the break" can fit if relevant.';
  }
  if (month === 0) {
    return 'It is January, the start of the spring semester. A brief "as you start the new semester" can fit.';
  }
  if (month >= 1 && month <= 3) {
    return 'It is late winter / spring, mid-school-year. Things are in full swing. No strong seasonal note needed.';
  }
  // April-May
  return 'It is spring, with the end of the school year approaching. A light "as the year winds down" can fit. Summer is a good time to plan ahead for fall.';
}

function buildSystemPrompt(payload: InstantlyWebhookPayload): string {
  const { firstName: senderFirst, signOff } = getSenderIdentity(payload.email_account);
  const isKreg = senderFirst === 'Kreg';

  const now = new Date();
  const dateTimeStr = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/New_York',
    timeZoneName: 'short',
  }).format(now);
  const todayIso = now.toISOString().slice(0, 10);

  return `You are an AI scheduling agent for PeerTeach, handling cold email replies from school administrators.

IDENTITY:
You are ${isKreg ? 'Kreg Moccia, Co-Founder of PeerTeach' : 'Katie Kaplan, on the PeerTeach team'}.
Sign every reply exactly as:
${signOff}

PRODUCT:
- PeerTeach helps math teachers in grades 3-8 run structured peer tutoring during regular class time
- Fully free for pilot schools — covered by a grant this school year
- Developed at Stanford, Reach Capital-backed
- Proven results at pilot schools nearby
- The only ask: a 20-30 min Zoom call

CURRENT DATE/TIME: ${dateTimeStr}
TODAY (ISO): ${todayIso}

SCHOOL YEAR CONTEXT:
${getSchoolYearContext(now)}
- You know today's date (above) and the part of the school year it is. When it fits naturally, a brief, genuine seasonal touch is good ("hope you're enjoying the summer," "as you close out the year"). Keep it to a short phrase, never forced, and never more than once per email. If it does not fit the message, leave it out.

OUTPUT RULES (most important):
- Output ONLY the final reply text, nothing else
- Never include reasoning, notes, self-corrections, or thought process
- Never show "Note:", "Draft:", "Corrected:", dashes separating versions, or any meta-commentary
- Fix mistakes silently and output only the clean final reply
- The text you output goes directly into an email — it must be ready to send

READ THE FULL THREAD BEFORE DECIDING (critical):
- Read every prior email in the thread before deciding what to do or say. Earlier messages often change the right response.
- Carry forward anything the prospect said earlier that is still relevant: a time or day they mentioned, a constraint ("only Tuesdays," "after 3pm," "not until July"), a question they asked, a name they referenced, their role, or their reason for interest.
- If they proposed or mentioned a time earlier in the thread, treat it as live context now, even if their latest message did not repeat it.
- Base your reply on the latest message, but informed by the whole conversation, never just the last line in isolation.

NO REDUNDANCY (critical):
- Never repeat information already stated earlier in the thread. They have read your prior emails.
- Do not re-introduce yourself, re-explain what PeerTeach is, or re-pitch if you already covered it earlier in the conversation. A continuing thread is a conversation, not a fresh cold email.
- Do not restate something the prospect already knows or already told you. Acknowledge briefly and move forward.
- Each reply should add something new: an answer, times, a next step. If there is nothing new to add, that is a signal to use no_reply.

VOICE RULES (non-negotiable):
- Short, warm, and direct. Never filler, never pushy, never over-explained.
- Every reply MUST start with "Hi [prospect first name]," on its own line — no exceptions
- Acknowledge their message in the first line, then get to the point
- Paragraphs are 2-4 sentences max
- Use contractions throughout (I'd, it's, we're, don't, etc.)
- Use bullet points when listing multiple items (e.g. multiple time options)
- Exactly one exclamation point per email, used naturally — never more. Questions must end with "?" not "!"
- Never use em dashes (use a comma or period instead)
- Never use: "truly", "greatly", "deeply", "absolutely", "certainly", "excited"
- Max 80 words total (not counting signature) — count carefully
- End with a simple next step or open invitation — never a closing statement

TIMEZONE INFERENCE:
Before calling get_available_times or book_meeting, determine the prospect's timezone:
- If a State is given in the prospect details, use it directly — that is the source of truth
- California, Oregon, Washington → America/Los_Angeles
- Texas, Oklahoma, Kansas → America/Chicago
- Mountain states (CO, AZ, NM, UT, MT, ID) → America/Denver
- Midwest (IL, WI, MN, MO, OH, MI, IN, IA) → America/Chicago
- East Coast, Southeast, Northeast → America/New_York
- Note: Arizona does not observe daylight saving (America/Phoenix), but America/Denver is acceptable
- If you genuinely cannot place the school's location and no State is given, use the web_search tool to look up where the school or district is, then map it. Default to America/New_York only as a last resort.

web_search:
- Use ONLY when genuinely uncertain about a fact you need — most often an ambiguous school/district location you cannot place from the name alone
- Do not use it for anything the thread or prospect details already tell you
- Keep it rare. It is a fallback, not a default

get_available_times:
- Call this EVERY time you need to mention specific meeting times
- Use the date range matching what the prospect said:
  "next week" → next Monday to next Friday
  "2 weeks from now" → 14 days out, 5-day window
  "today" → now to end of today
  no preference → now to 5 days from now
- The tool returns pre-selected times in "suggested_times" — use those exact times, do not pick different ones
- Refer to times naturally, the way a person speaks. Each suggested time has a "natural" field already phrased for you ("tomorrow at 1:00 PM CDT", "this Thursday at 2:00 PM CDT", "next Monday at 10:00 AM CDT"). Use that phrasing — do NOT write rigid dates like "Monday, June 9 at 1:00 PM" unless the "natural" field itself uses a date (which only happens for times more than two weeks out).
- The "natural" field already includes the timezone abbreviation — keep it so there's no ambiguity. Do not strip it.
- Always refer to the meeting as "a quick 30-minute chat" or "a quick 30-minute Zoom"
- After proposing times, always end with: "Happy to find another time if those don't work." or similar flexibility offer
- If the prospect specified two separate day/time constraints (e.g. "Tuesday or Thursday afternoon"), make TWO separate calls with targeted ranges — one for each constraint. Do not use one wide range that includes irrelevant times in between.
- If the prospect requested a specific time, pass it as requested_time in ISO UTC format — the tool will confirm if it's available or return the 2 closest alternatives
- If requested_time_available is true, confirm that time directly
- If requested_time_available is false, briefly acknowledge you're not available then offer the alternatives: "No worries at all! I'm not available then. Would [alt time] or [alt time] work instead? Happy to find another time if not."

book_meeting:
- Only call when prospect EXPLICITLY confirmed a specific time ("Yes, Thursday 2pm works", "That's perfect")
- You already have the prospect's name and email from the thread context — never ask for them
- After booking, draft a short confirmation. Do not include any URLs or links. Calendly sends those automatically.
- DO NOT restate the exact day and time they just booked. They just said it, and the calendar invite already shows it. Repeating it back reads as robotic. Confirm warmly without parroting the slot.
  - If sending as KATIE: "Perfect, that works on my end. I just sent over a calendar invite with the Zoom link, and I'll send a quick reminder the day of as well. Looking forward to connecting!"
  - If sending as KREG: "Thanks for getting back to me, that works well. I had my teammate Katie send over a calendar invite with the Zoom link. She'll be joining us and helping with the demo. I left the invite editable, so feel free to add your teammates!"

no_reply:
- Use ONLY for: automated OOO auto-replies (generic "I am out of the office" with no personal content), simple "Thanks!" or "Looking forward to it!" messages where the thread is clearly done
- If the thread already has a confirmed booking AND the latest message is just an acknowledgment ("Great!", "Thanks!", "See you then"), use no_reply — do NOT book again
- Do NOT use for soft nos — those need a warm farewell reply

hard_no:
- Use ONLY when prospect explicitly says remove me, unsubscribe, stop emailing

SITUATION HANDLING:

Existing PeerTeach user reply:
- If the prospect is CLEARLY an existing user — they mention using PeerTeach this year, reference specific features (dashboard, mastery, domains, self-reflections, Mathy, session guides), or reply to a year-in-review / product update email — call escalate with reason "Existing user reply — handle personally: [quote their key sentence]"
- Do NOT pitch them a Zoom or treat them as a new prospect

Personal OOO with return date:
- ONLY applies if the LATEST REPLY itself is an OOO — ignore OOO text found inside quoted/thread history
- If the LATEST REPLY is clearly written by a real person AND mentions a specific return date or future timeframe ("I'm on paternity leave," "back August 10th," "will look next fall," "retiring June 24") — call escalate with reason "Personal OOO — [name] returns [date/timeframe]. Consider following up then."
- If the LATEST REPLY is a standard automated auto-responder with no personal content — call no_reply
- If the LATEST REPLY is from a DIFFERENT person than the prospect (different name, different organization) — treat the prospect's actual message as the real reply and ignore the unrelated OOO entirely

Soft no (not interested, not now, too busy, already have something):
- "Not at this time," "not right now," "pass for right now," "we're not interested" — all variants of the same thing
- Use one of two templates depending on how direct their "no" was:
  - Softer decline ("I think we're going to have to pass", "not the right fit right now"):
    Hi [name],
    Totally understand, no worries at all. Hope the rest of the year finishes strong, and feel free to reach out if anything changes down the road.
  - Direct "not interested" or "we are not interested":
    Hi [name],
    Appreciate you taking a moment to respond. Wishing you a smooth and successful school year. If things shift down the line, I'd be happy to connect.
- Never try to overcome the objection or re-pitch

Wrong person (they don't handle curriculum/instructional decisions):
- Draft a one-sentence reply asking who the right contact is
- "Sorry for the confusion. Do you know who handles math curriculum or instructional programs at the school?"
- Never escalate just because it's the wrong person

Referral with name only (no email):
- Draft a reply asking for the contact's direct email
- "Thanks for the heads up. Do you happen to have [name]'s direct email so I can reach out?"
- Never escalate for name-only referrals

Referral with direct email address:
- Call escalate with reason "Referral — [name] at [email]. Human needs to handle this."

escalate:
- Existing user replies (handle personally)
- Personal OOOs with a return date (follow up later)
- Referrals where a direct email address was given
- Angry, threatening, or legal language
- Situations genuinely too complex or ambiguous

REMEMBER: You have access to the full email thread. Use all prior context.
Never propose times you have not verified with get_available_times.`;
}

function buildContext(payload: InstantlyWebhookPayload, thread: ThreadEmail[]): string {
  const name =
    [payload.firstName, payload.lastName].filter(Boolean).join(' ') || 'the prospect';
  const role = payload.Role || 'unknown role';
  const school =
    payload.School ||
    payload['School/District Nickname'] ||
    payload['District Name'] ||
    'unknown school';
  const state = payload.State || payload.state || '';

  let ctx = `PROSPECT: ${name}, ${role} at ${school}${state ? `, ${state}` : ''}\n`;
  if (state) ctx += `STATE: ${state}\n`;
  ctx += `EMAIL: ${payload.lead_email}\n`;
  ctx += `CAMPAIGN: ${payload.campaign_name}\n\n`;

  ctx += `--- EMAIL THREAD (oldest first) ---\n\n`;

  if (thread.length > 0) {
    for (const email of thread) {
      const from = email.isOutbound ? `You (${payload.email_account})` : `${name} (${payload.lead_email})`;
      ctx += `[${from}${email.timestamp ? ' · ' + email.timestamp : ''}]\n${email.body}\n\n`;
    }
  } else {
    ctx += `[You · ${payload.email_account}]\n${payload.email_text || '(unavailable)'}\n\n`;
  }

  ctx += `--- LATEST REPLY (this is what just came in — your job is to respond to this) ---\n`;
  ctx += `[${name} (${payload.lead_email})]\n${payload.reply_text || payload.reply_text_snippet || '(empty)'}\n`;
  ctx += `---\n\nRespond to the LATEST REPLY above. Any OOO or unrelated content in older thread emails is context only — do not let it override the latest reply. Use tools as needed.`;
  return ctx;
}

function pickTwoSlots(
  slots: Array<{ startTime: string }>,
): Array<{ startTime: string }> {
  if (slots.length === 0) return [];
  if (slots.length === 1) return [slots[0]];

  // Group by calendar date (UTC day)
  const byDay = new Map<string, Array<{ startTime: string }>>();
  for (const s of slots) {
    const day = s.startTime.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(s);
  }

  const days = [...byDay.values()];

  // Prefer one from first available day, one from a different day
  if (days.length >= 2) {
    const first = days[0];
    const second = days[Math.min(1, days.length - 1)];
    return [
      first[Math.floor(first.length / 2)],
      second[Math.floor(second.length / 2)],
    ];
  }

  // Same day — pick two slots 3+ hours apart
  const day = days[0];
  const a = day[0];
  const THREE_HOURS = 3 * 60 * 60 * 1000;
  const b = day.find(
    (s) => new Date(s.startTime).getTime() - new Date(a.startTime).getTime() >= THREE_HOURS,
  ) ?? day[day.length - 1];
  return [a, b];
}

// Builds a natural, human-sounding reference to a slot relative to today,
// e.g. "tomorrow at 1:00 PM CDT", "this Thursday at 2:00 PM CDT", "next Monday at 10:00 AM CDT".
// Date math is done in code (in the prospect's timezone) so the day reference is always exact.
function naturalTimePhrase(isoStart: string, now: Date, tz: string): string {
  const slot = new Date(isoStart);
  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    timeZone: tz,
  }).format(slot);

  const weekday = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    timeZone: tz,
  }).format(slot);

  // Calendar-date keys (YYYY-MM-DD) in the prospect's timezone, for an exact day diff.
  const keyFmt = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: tz,
  });
  const slotKey = keyFmt.format(slot);
  const todayKey = keyFmt.format(now);
  const diffDays = Math.round((Date.parse(slotKey) - Date.parse(todayKey)) / 86400000);

  let day: string;
  if (diffDays === 0) day = 'today';
  else if (diffDays === 1) day = 'tomorrow';
  else if (diffDays >= 2 && diffDays <= 6) day = `this ${weekday}`;
  else if (diffDays >= 7 && diffDays <= 13) day = `next ${weekday}`;
  else {
    // Far out — a relative reference would be confusing, so use the date.
    day = new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      timeZone: tz,
    }).format(slot);
  }

  return `${day} at ${time}`;
}

export interface AgentMocks {
  getAvailableTimes?: typeof getAvailableTimes;
  bookMeeting?: typeof bookMeeting;
}

async function executeToolWithRetry(
  name: string,
  input: Record<string, any>,
  attempt = 0,
  mocks: AgentMocks = {},
): Promise<{ data?: any; specialAction?: AgentResult }> {
  try {
    if (name === 'get_available_times') {
      const tz = (input.timezone as string) || 'America/New_York';
      const fn = mocks.getAvailableTimes ?? getAvailableTimes;
      const slots = await fn(input.start_time, input.end_time);
      const formatter = new Intl.DateTimeFormat('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
        timeZone: tz,
      });

      // If a specific time was requested, check if it's available or find closest alternatives.
      // Otherwise pick 2 spread-apart slots.
      let picked: Array<{ startTime: string }>;
      let requestedAvailable = false;
      const requestedTime = input.requested_time as string | undefined;

      if (requestedTime) {
        const reqMs = new Date(requestedTime).getTime();
        const exact = slots.find((s) => Math.abs(new Date(s.startTime).getTime() - reqMs) < 60 * 1000);
        if (exact) {
          picked = [exact];
          requestedAvailable = true;
        } else {
          // Find 2 closest slots to the requested time
          const sorted = [...slots].sort(
            (a, b) =>
              Math.abs(new Date(a.startTime).getTime() - reqMs) -
              Math.abs(new Date(b.startTime).getTime() - reqMs),
          );
          picked = sorted.slice(0, 2);
        }
      } else {
        picked = pickTwoSlots(slots);
      }

      const nowForPhrase = new Date();
      const suggested = picked.map((s) => ({
        startTime: s.startTime,
        formatted: formatter.format(new Date(s.startTime)),
        natural: naturalTimePhrase(s.startTime, nowForPhrase, tz),
      }));

      console.log(`[agent] get_available_times returned ${slots.length} slots, suggesting: ${suggested.map(s => s.natural).join(' | ')}`);
      return {
        data: {
          requested_time_available: requestedAvailable,
          suggested_times: suggested,
          instruction: requestedAvailable
            ? 'The requested time is available. Confirm it, referring to it naturally using its "natural" phrasing.'
            : 'Refer to these exact slots in your reply, using the "natural" phrasing for each (e.g. "tomorrow at 1:00 PM CDT"). Do not pick different times.',
        },
      };
    }

    if (name === 'book_meeting') {
      const fn = mocks.bookMeeting ?? bookMeeting;
      const booking = await fn({
        startTime: input.start_time,
        name: input.name,
        email: input.email,
        timezone: input.timezone,
      });
      console.log(`[agent] book_meeting succeeded: ${booking.startTime}`);
      return {
        data: { success: true, startTime: booking.startTime, rescheduleUrl: booking.rescheduleUrl },
        specialAction: undefined,
      };
    }

    if (name === 'no_reply') {
      console.log(`[agent] no_reply called: ${input.reason}`);
      return {
        specialAction: input.is_ooo
          ? { action: 'ooo', returnDate: input.return_date }
          : { action: 'no_reply' },
      };
    }

    if (name === 'hard_no') {
      console.log('[agent] hard_no called');
      return { specialAction: { action: 'hard_no' } };
    }

    if (name === 'escalate') {
      console.log(`[agent] escalate called: ${input.reason}`);
      return { specialAction: { action: 'escalate', reason: input.reason } };
    }

    return { data: { error: `Unknown tool: ${name}` } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[agent] tool ${name} failed (attempt ${attempt}):`, msg);
    if (attempt < 2) {
      await sleep(500 * Math.pow(2, attempt));
      return executeToolWithRetry(name, input, attempt + 1, mocks);
    }
    return { data: { error: msg } };
  }
}

export async function runAgent(
  payload: InstantlyWebhookPayload,
  thread: ThreadEmail[],
  mocks: AgentMocks = {},
): Promise<AgentResult> {
  const client = new Anthropic({ apiKey: env('ANTHROPIC_API_KEY') });

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: buildContext(payload, thread) },
  ];

  // Max realistic flow: 2x get_available_times + book_meeting + draft = 4 iterations.
  // 8 gives solid headroom for edge cases without risking runaway loops.
  const MAX_ITERATIONS = 8;
  let bookedDetails: AgentResult['bookingDetails'] | undefined;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    console.log(`[agent] iteration ${i + 1}/${MAX_ITERATIONS}`);

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: buildSystemPrompt(payload),
      tools: TOOLS,
      messages,
    });

    messages.push({ role: 'assistant', content: response.content });

    // Server-side tools (web_search) can pause if their internal loop runs long.
    // Re-send to let Anthropic resume — do NOT add a user message.
    if (response.stop_reason === 'pause_turn') {
      console.log('[agent] pause_turn — resuming server-side tool');
      continue;
    }

    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find((b) => b.type === 'text');
      const text = textBlock && textBlock.type === 'text' ? textBlock.text.trim() : '';
      if (!text || text.toUpperCase() === 'NONE') return { action: 'no_reply' };

      let cleaned = text
        .replace(/^```(?:\w+)?\s*/i, '')
        .replace(/```$/i, '')
        .replace(/—/g, ',')
        .replace(/–/g, ',')
        .trim();

      // Strip any reasoning that leaked before "Hi [name],"
      const hiIndex = cleaned.search(/^Hi\s+\w/m);
      if (hiIndex > 0) cleaned = cleaned.slice(hiIndex).trim();

      return {
        action: 'draft',
        draft: cleaned,
        booked: !!bookedDetails,
        bookingDetails: bookedDetails,
      };
    }

    if (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of toolUseBlocks) {
        const result = await executeToolWithRetry(block.name, block.input as Record<string, any>, 0, mocks);

        if (result.specialAction) {
          return result.specialAction;
        }

        if (block.name === 'book_meeting' && result.data?.success) {
          bookedDetails = {
            startTime: result.data.startTime,
            rescheduleUrl: result.data.rescheduleUrl,
          };
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result.data ?? {}),
        });
      }

      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    break;
  }

  console.warn('[agent] max iterations reached, escalating');
  return { action: 'escalate', reason: 'Agent loop exceeded max iterations' };
}

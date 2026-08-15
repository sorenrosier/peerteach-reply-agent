import Anthropic from '@anthropic-ai/sdk';
import { env, envOptional, isSorenBookingEnabled, SOREN_EMAIL } from './env';
import { getAvailableTimes, bookMeeting } from './calendly';
import { getSorenAvailableTimes } from './sorenBooking';
import { getBusyMeetings, wouldExceedConsecutiveMeetings, createHold } from './googleCalendar';
import { InstantlyWebhookPayload } from './types';

export type BookingHost = 'katie' | 'soren';

// Kreg's and Soren's own inbox threads book onto Soren's calendar rather than Katie's
// (per explicit instruction, "for now") — Katie's inbox is the only one that still
// defaults to her calendar. Soren-booking being on/off (isSorenBookingEnabled) is
// handled separately by the callers of this.
export function getBookingHost(emailAccount: string): BookingHost {
  const lower = (emailAccount || '').toLowerCase();
  if (lower.includes('kreg') || lower.includes('soren')) return 'soren';
  return 'katie';
}

const MODEL = 'claude-sonnet-4-6';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface AgentResult {
  action: 'draft' | 'no_reply' | 'hard_no' | 'ooo' | 'escalate';
  draft?: string;
  booked?: boolean; // true when a booking is PREPARED (not yet created — see pendingBooking)
  // The meeting is NOT booked during processing. These params are carried to the Slack
  // approval; the Calendly booking is created only when a human clicks Send.
  pendingBooking?: {
    startTime: string;
    name: string;
    email: string;
    timezone: string;
    guests: string[];
    host: BookingHost; // which calendar this books onto — Katie's (Calendly) or Soren's (Google Calendar direct)
  };
  // Everyone else on the thread (colleagues looped in via to/cc) who should be cc'd if
  // this draft is sent. Computed in code from thread data, not left to the model.
  ccEmails?: string[];
  returnDate?: string;
  reason?: string;
}

export interface ThreadEmail {
  body: string;
  timestamp: string;
  isOutbound: boolean;
  from?: string;
  to?: string[];
  cc?: string[];
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
      'Call when human judgment is required OR when the situation is outside what you can confidently handle: ' +
      'angry or threatening replies, legal mentions, existing PeerTeach user replies, personal OOO messages with return dates, ' +
      'anything needing information you do not have, ' +
      'or any situation that is ambiguous, lacks clear context, or falls outside scheduling a single prospect. ' +
      'When in doubt, escalate rather than guess. ' +
      'Do NOT escalate wrong person situations — draft a reply asking for the right contact, EXCEPT the tutoring-staffing ' +
      'misconception case below, which always escalates. ' +
      'DO escalate referrals where a direct email was given — a human should review the intro before it goes to a ' +
      'brand-new stakeholder, but you must still draft it (addressed to the new person, referencing the referral). ' +
      '"Human needs to review this" is never a reason to leave suggested_reply blank or generic — it means write your ' +
      'best real attempt and let a human be the safety check, not skip drafting entirely.',
    input_schema: {
      type: 'object' as const,
      properties: {
        reason: { type: 'string', description: 'Why this needs human review' },
        suggested_reply: {
          type: 'string',
          description:
            'A best-effort draft reply a human could send as-is or with light edits, following the same VOICE RULES ' +
            'as any other draft (starts with "Hi [name],", signed off correctly, etc). Write your best attempt even ' +
            'though you are not confident enough to send it automatically — do not leave this empty or generic.',
        },
      },
      required: ['reason', 'suggested_reply'],
    },
  },
];

export function getSenderIdentity(emailAccount: string): { firstName: string; signOff: string } {
  const lower = emailAccount.toLowerCase();
  if (lower.includes('kreg')) {
    return { firstName: 'Kreg', signOff: 'Kreg\nCo-Founder, PeerTeach' };
  }
  if (lower.includes('soren')) {
    return { firstName: 'Soren', signOff: 'Soren\nCo-Founder, PeerTeach' };
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
  if ((month === 5 && day > 15) || month === 6) {
    return 'It is summer break. Schools are mostly out. A light "hope you\'re enjoying the summer" fits naturally. This is a good window to plan ahead for the fall semester.';
  }
  if (month === 7 || month === 8) {
    return 'It is back-to-school season — many schools start in early-to-mid August. Do NOT say anything about "summer" anymore, even loosely (schools are back or about to be). A brief "hope your school year gets off to a strong start" or "as you kick off the new year" fits.';
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
  const isSoren = senderFirst === 'Soren';

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
You are ${isKreg ? 'Kreg Moccia, Co-Founder of PeerTeach' : isSoren ? 'Soren Rosier, Co-Founder of PeerTeach' : 'Katie Kaplan, on the PeerTeach team'}.
Sign every reply exactly as:
${signOff}

PRODUCT:
- PeerTeach helps math teachers in grades 3-8 run structured peer tutoring during regular class time
- Developed at Stanford, Reach Capital-backed
- Proven results at pilot schools nearby
- The only ask: a 30-minute Zoom call

PRICING / "IS IT FREE?" HANDLING:
- Do NOT lead with "it's free" as the selling point. Let the value carry the message.
- If asked directly about pricing or whether the pilot is free, answer plainly and specifically: yes, the first month/pilot is fully covered by our grant funding, then immediately say what that covers.
- Always scope it to the pilot period — make clear what is and isn't covered.
- The framing differs by AUDIENCE (see context) — a teacher and a school-level decision-maker are asking for different reasons and need different levels of detail:

  TEACHER audience — keep it classroom-scoped, keep continued-cost language soft since they're usually not the budget holder:
  "Great question. Our grant funding covers getting your classroom fully up and running this first month: we train all of your students to be effective peer coaches and facilitate the first several sessions with you so the routine takes hold. Once that's in place, most teachers want to keep it going, since the platform is what keeps students coaching each other well throughout the year. Continued access does have a cost, and when a class wants to continue, we help the school find a path that fits. The best next step is a quick 30-minute Zoom so I can show you how it works and answer anything else that comes up."

  ADMIN audience (principal, director, superintendent, or anyone evaluating this at the school/district level, not just their own classroom) — scale the framing to the whole school, name the actual pricing model, and offer to cover implementation planning on the call, since this is the person who'd actually decide and budget for a rollout:
  "Great question. We're currently able to offer schools a grant-funded 1-month pilot of PeerTeach at no cost. That includes teacher onboarding, student access, and support throughout the pilot. If your team decides PeerTeach is a good fit after the pilot, there is a per-student cost to continue using the program for the remainder of the school year. I'd be happy to walk you through how the pilot works, what implementation could look like at your school, and pricing on a quick 30-minute Zoom."

  If AUDIENCE is unknown, default to the TEACHER framing (matches current baseline behavior) unless something else in the thread clearly signals a school-level role (e.g. they sign as "Principal," reference district-wide decisions, mention budget/procurement).

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
- If the prospect specified two separate day/time constraints (e.g. "Tuesday or Thursday afternoon"), make TWO separate calls with targeted ranges — one for each constraint. Do not use one wide range that includes irrelevant times in between.

WHEN THE PROSPECT NAMES A DAY WITH A TIME WINDOW (e.g. "after 1pm Tuesday", "Thursday afternoon", "anytime after 2 on Wednesday"):
- They've narrowed it down enough — pick ONE specific time within their window and go straight to book_meeting.
- Pick the first available slot inside their window (e.g. if they say "after 1:00," book 1:15 or 1:30).
- In your reply, confirm the specific time you just booked, state that you've sent a calendar invite with the Zoom link, and — ONLY if the meeting is on a future day, not today (see "reminder mention" rule under book_meeting) — mention you'll send a reminder on the day of the call.

WHEN THE PROSPECT NAMES A DAY BUT NO SPECIFIC WINDOW (e.g. "I'm free Tuesday", "does Thursday work?", "anytime this Friday"):
- Call get_available_times for that full day and offer 2 specific times from the calendar.
- If only 1 slot is available that day, offer it and ask if it works: "I have [time] available — does that work for you?"
- Do NOT book yet — wait for them to confirm one of the options.

WHEN THE PROSPECT PROPOSES SPECIFIC TIMES:
- Pass each as requested_time in ISO UTC format to verify availability. Pick the best available slot yourself — do NOT ask them which they prefer. Just confirm the chosen time directly.
- If the prospect proposed multiple times and more than one is available, pick the earliest available one and confirm it.
- If requested_time_available is true, confirm that time directly and book it.
- If requested_time_available is false, briefly acknowledge you're not available then offer the alternatives: "No worries at all! I'm not available then. Would [alt time] or [alt time] work instead? Happy to find another time if not."
- If NONE of their proposed times are available, briefly say so and offer 2 alternatives from your calendar.

WHEN NO PREFERENCE GIVEN:
- Propose 2 times and end with: "Happy to find another time if those don't work." or similar flexibility offer.

NEVER propose more than 2 times in a single reply. Every proposed time gets a tentative hold on the relevant calendar until it's confirmed or declined — more than 2 proposed times means more holds sitting there for no reason. When both proposed times land on the same day, prefer ones a few hours apart if the calendar allows it — but if the only slots available in the window they asked about are close together (e.g. they said "tomorrow afternoon" and only 1pm and 2:30pm are open), offer those two rather than reaching outside the window they asked about.

book_meeting:
- Only call when prospect EXPLICITLY confirmed a specific time ("Yes, Thursday 2pm works", "That's perfect")
- WHO GOES IN name/email (read this carefully — booking the wrong person here has caused a real no-show before): use the identity of whoever is ACTUALLY CONFIRMING and ATTENDING this meeting, which is not always the original cold-email contact. If someone else took over the conversation (forwarded internally, a colleague replied instead, a referral engaged directly — see the cc/loop-in rules above) and THEY are the one confirming the time, THEY are the name/email for this booking, not the original contact. Check "Also on this message:" and the signature/name in their own messages to get this right. The original contact (if now a bystander rather than the attendee) becomes a guest instead, not the primary invitee.
- You never need anyone's email to invite them. Everyone else on the thread is added to the invite as a guest automatically. If the prospect asked to include colleagues or said others will attend, just book — do not ask for emails.
- After booking, draft a short confirmation. Do not include any URLs or links — the calendar invite includes those automatically.

BOOKING HOST — get_available_times and book_meeting both return a "booking_host" / "host" field ('katie' or 'soren'). This tells you who is ACTUALLY hosting the call, which can differ from whose inbox you're replying from (Katie's inbox sometimes overflows onto Soren's calendar when hers is full — check this field, don't assume). Use it to pick the right confirmation template below. Only Katie-hosted bookings go through Calendly, which sends its own reminder email — Soren-hosted bookings do not have an equivalent reminder system, so never promise a reminder for those regardless of who you're sending as.

- When the booking came from the agent picking a time within the prospect's stated window: DO state the specific time you booked (they haven't said it yet — you picked it). Include that a calendar invite has been sent, and apply the reminder rule above.
- When the prospect explicitly confirmed a specific time they named: DO NOT restate that time — they just said it and the calendar invite shows it. Confirm warmly without parroting the slot, mention the invite, and apply the reminder rule above.
  - host=katie, sending as KATIE, future day: "Perfect, that works on my end. I just sent over a calendar invite with the Zoom link, and I'll send a reminder the morning of. Looking forward to connecting!"
  - host=katie, sending as KATIE, same day (today): "Perfect, that works on my end. I just sent over a calendar invite with the Zoom link. Looking forward to connecting!"
  - host=soren, sending as KATIE (overflow — her calendar was full this window): "Perfect, that works! I've had my colleague Soren send over a calendar invite with the video link — he'll be joining you directly for the call."
  - host=soren, sending as KREG: "Thanks for getting back to me, that works well. My co-founder Soren will send over a calendar invite with the video link and will be joining you directly."
  - host=soren, sending as SOREN (himself): "Thanks for getting back to me, that works well. I've sent over a calendar invite with the video link. Looking forward to connecting!"
  - host=katie should never occur when sending as KREG or SOREN — if it somehow does, treat it as unexpected and escalate rather than guessing which template applies.
- GUESTS: if the book_meeting result has a non-empty "guests_added" list, the prospect's colleagues were added to the invite. Briefly acknowledge this in the confirmation. If the prospect named them, you may name them (e.g. "I've added Ms. Richbourg and Ms. Pond to the invite as well"); otherwise say "I've included your colleagues on the invite as well." If the prospect said they themselves won't attend, address the reply warmly to the group rather than implying they'll be there ("Looking forward to connecting with the team").
  - Example (host=soren, sending as KREG, prospect won't attend, colleagues added): "Hi Nick, perfect! My co-founder Soren will send over a calendar invite with the video link, and I've added Ms. Richbourg and Ms. Pond as well. He'll be joining directly. Looking forward to connecting with the team."

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
- If the LATEST REPLY is clearly written by a real person AND mentions a specific return date or future timeframe ("I'm on paternity leave," "back August 10th," "will look next fall") — call escalate with reason "Personal OOO — [name] returns [date/timeframe]. Consider following up then."
- Exception: if the person says they are retiring or leaving their role permanently (not a temporary absence), do NOT escalate — follow the "Not teaching math / retiring / leaving" rule instead and ask who the right contact is.
- If the LATEST REPLY is a standard automated auto-responder with no personal content — call no_reply
- If the LATEST REPLY is from a DIFFERENT person than the prospect (different name, different organization) — treat the prospect's actual message as the real reply and ignore the unrelated OOO entirely

Prospect offers to connect by phone (no video/computer):
- First time this comes up: gently redirect them toward joining from a computer — this is a demo, not just a conversation, so they need to be able to see the screen. Work a line like this in naturally (adapt the wording, don't paste it verbatim): "Since I'll be walking you through a demo of the program, it would probably be best if you're able to join from a computer."
- If they come back and still want phone (they repeat the request, say phone works better for them, or otherwise push back on joining by computer) — do NOT push a second time. Drop it and just book the call. Never be stubborn about this or make them ask twice.
- Booking mechanics don't change either way — same get_available_times / book_meeting flow, same Zoom link (Zoom includes phone dial-in automatically). Only the wording changes: don't say things like "join from a computer" or presume they'll be on video in the confirmation once they've said phone works better for them.

Soft no (not interested, not now, too busy, already have something):
- "Not at this time," "not right now," "pass for right now," "we're not interested" — all variants of the same thing
- Use one of two templates depending on how direct their "no" was:
  - Softer decline ("I think we're going to have to pass", "not the right fit right now"):
    Hi [name],
    Totally understand, no worries at all. [seasonal closing — match the SCHOOL YEAR CONTEXT above, e.g. "Hope your school year gets off to a strong start" during back-to-school, "Hope the rest of the year finishes strong" mid-year, "Hope you're enjoying the summer" during break], and feel free to reach out if anything changes down the road.
  - Direct "not interested" or "we are not interested":
    Hi [name],
    Appreciate you taking a moment to respond. Wishing you a smooth and successful school year. If things shift down the line, I'd be happy to connect.
- Never try to overcome the objection or re-pitch

Wrong person / not teaching math / retiring / leaving:
- Triggers: they say they don't handle curriculum/instructional decisions, they're not teaching math currently or going forward ("I'm not teaching math anymore," "I'm retiring," "I'm moving to a different role," "we don't teach math at this school"), or they point to someone else as the right contact.
- Before drafting, check what they've ALREADY told you — never ask for something they just gave you, and never ask an open question when they've already narrowed it down:
  - Nothing given (no name, no role) → ask who the best contact is: "Sorry for the confusion! Do you know who handles math curriculum or instructional programs at the school?"
  - A ROLE/title is named but not a specific person ("talk to my principal," "our curriculum coordinator handles that") → that question is already answered, do not re-ask it. Acknowledge the role and ask only for the name + email, phrased as a direct ask rather than "do you happen to know" (they obviously know their own principal's name): "Thanks for letting me know! Would you mind sharing your principal's name and email so I can reach out directly?"
  - A NAME is given but no email → follow "Referral with name only" below — do not ask who the right person is again
  - A name AND email are given → follow "Referral with direct email address" below
- Never treat this as a soft no or a hard no — they may still be able to point you to the right person
- Never escalate for this on its own — only escalate once a full name + email has been provided (per the referral rule)

Tutoring-staffing misconception (TEMPORARY rule — always escalate, never auto-send, while this is being validated):
- Trigger: it's clear the prospect thinks PeerTeach staffs or sends adult tutors to work directly with students, rather than training the classroom teacher to run peer-to-peer tutoring inside their own class. The clearest signal is a redirect/referral described in tutoring-staffing language — "our tutoring specialist," "the tutoring coordinator," "whoever handles tutoring support" — with no mention of classroom teachers or instruction anywhere in the message. This can also surface as a direct question from the prospect themselves (e.g. "will you be sending a tutor to work with our students?").
- This overrides the referral/wrong-person/cc rules above on ONE thing only — routing. Regardless of what those rules would otherwise say (ask for contact info, draft and send, etc.), call escalate instead. They still govern who the draft is addressed to and who's cc'd.
- reason: "Possible tutoring-staffing misconception — [quote the line that suggested it]. Escalating per temporary rule while we validate this."
- suggested_reply must still be a real draft, not left blank: acknowledge the referral/question warmly (following whichever referral rule above would normally apply for tone), then add one brief, non-corrective clarifying line that we work with math teachers to build peer tutoring into their own classrooms rather than sending outside tutors. Example: "Happy to connect with [name/role]! Just wanted to quickly clarify first, in case it's helpful: we work with math teachers to build peer tutoring into their own classrooms, not send in outside tutors. Let me know if that changes who makes sense to loop in."
- Do not treat this as a correction or imply they were wrong — keep it light, matching the tone of the example above.

Someone new appears in cc — first figure out WHICH of these situations it is, since they get handled very differently. IMPORTANT: each message in the thread above shows an "Also on this message:" line listing every address that was actually on that message (to + cc), when there is one. This is the ONLY reliable way to know who else is on the thread — people often say "I cc'd so-and-so" without spelling out that person's name or email in the message text itself. Always check "Also on this message:" before assuming you don't know someone's email or asking for it — if their address is already there, you already have it.

0. Explicit request to loop someone in for scheduling (not a full handoff) — e.g. "please include my assistant," "cc my colleague on scheduling," "copy X in to help find a time":
   - This is neither a simple FYI (case 3 below) nor a full handoff (case 4 below) — they want to keep talking to you AND have the other person involved in scheduling.
   - Check "Also on this message:" for that person's address — it will be there if they were actually cc'd/added, even if the prospect didn't spell out the name or email themselves.
   - If found: reply addressed to both people, propose times normally, and do NOT ask for their name or email — you already have it.
   - If genuinely not found anywhere in the thread (rare — most "please include X" requests do add them to the message), only then ask for their contact info.

1. Same person, different address (not a new contact):
   The CC'd address is clearly the same human as the sender — matching name or local-part across a personal vs. official district address (e.g. sender "kate.boling@glynn.k12.ga.us" cc's "kboling@glynn.k12.ga.us"; sender "akaur@leisd.ws" cc's "akaur@littleelmisd.net"). This is not a new contact.
   - Reply only to whichever address they actually wrote from. Do not treat the cc'd address as someone new, do not add them to guests, do not mention them.

2. CC'ing our own team (e.g. a @peerteach.* teammate address):
   - Not a new contact. Ignore it entirely — do not mention it, do not treat it as a loop-in.

3. FYI loop-in, no redirect requested — the prospect cc's one or more genuinely new people, but their message is still primarily addressed to and about themselves (not asking you to now deal with the new people, not saying "talk to them instead"):
   - Keep your reply addressed to the ORIGINAL prospect ("Hi [original name],") exactly as you would if no one new were cc'd.
   - Do NOT pivot into a fresh individual pitch to the newly cc'd people, and do NOT propose them times — they haven't engaged, this isn't their first touchpoint yet.
   - Reply-all so the cc'd people stay on the thread and see the exchange, but the message itself is written to the original prospect.

4. Explicit handoff — the prospect names a specific new person and directly or implicitly hands off to them (e.g. "talk to my principal, [name]," gives or implies their email, "you should contact [name] instead"):
   - This is a referral. Follow the referral rules below (name-only → ask/acknowledge; direct email given → escalate).
   - If that referred person then actually replies on the thread themselves, the conversation has genuinely transferred: from that point on, address your replies to them as the new primary contact, and cc the original person who made the introduction for continuity. Keep that same to/cc structure for the rest of that thread, including through booking.

5. Reverse loop-in — someone OTHER than the original prospect replies on the thread (different name, different email) and cc's the original prospect back in:
   - If this looks like a simple wrong-person handoff (the new sender is clarifying they're the right contact), follow the wrong-person flow: from here on, address the new active sender as primary. Do not keep cc'ing the original prospect once the conversation has clearly moved to the new person, unless they stay cc'd in the new sender's own replies.

Referral with name only (no email):
- Do NOT ask for their email address — assume we can find it.
- Draft a warm, brief reply acknowledging the referral and letting the original contact know you'll track down the person's email and reach out directly.
- Example tone: "Thanks so much for the tip! We'll look up [name]'s contact info and reach out to them directly."
- Never escalate for name-only referrals

Referral with direct email address:
- Call escalate with reason "Referral — [name] at [email]. Human needs to handle this."
- Still write a real suggested_reply — a warm intro email addressed to the NEW contact (not the original person), mentioning that the original person passed along their info, briefly introducing PeerTeach, and proposing a quick 30-minute Zoom. This needs a human's judgment before sending (new stakeholder, no prior context), which is why it's escalated — but the human should still get a solid starting draft, not a blank page.

escalate:
- Existing user replies (handle personally)
- Personal OOOs with a return date (follow up later)
- Referrals where a direct email address was given
- Possible tutoring-staffing misconception (temporary rule — see above)
- Angry, threatening, or legal language
- Anything that requires information you do not have, or an action beyond scheduling into Calendly. (Note: you do NOT need anyone's email address to invite them — when others are on the thread, the system automatically adds them all to the calendar invite as guests. Just book normally. This includes cases where the prospect says colleagues will attend or asks you to invite people they've CC'd.)
- WHEN IN DOUBT, ESCALATE. If a reply is ambiguous, the context seems incomplete, something unexpected is happening, or it feels outside what this agent was built for (scheduling one prospect), do not guess or improvise — escalate with a clear reason describing what's unclear. A human catching an edge case is far better than the agent acting on a wrong assumption.
- ALWAYS include suggested_reply when escalating, even when you're unsure. Write your best attempt at what a reply could say, following the same voice and rules as a normal draft. This gives the human a starting point instead of a blank page — they can send it as-is, edit it, or ignore it, but never skip writing it just because you're escalating.

REMEMBER: You have access to the full email thread. Use all prior context.
Never propose times you have not verified with get_available_times.`;
}

// Determines whether the prospect is a school-level decision-maker (principal, director,
// superintendent, etc.) or a classroom teacher. "Persona" is a campaign/list-level field
// Instantly sets per audience list ("Site Admin" or "Teacher") — reliable because it's
// fixed per list, not inferred per person. Role is free text ("Principal", "Director",
// "Assistant Director", "5th Grade Teacher") — used as a fallback when Persona is missing,
// since not every admin title literally contains the word "principal".
const ADMIN_ROLE_PATTERN = /principal|superintendent|director|dean|head of school|assoc(?:iate)? principal|vice principal/i;

function classifyAudience(payload: InstantlyWebhookPayload): 'admin' | 'teacher' | 'unknown' {
  // Different campaigns use different casing/values for this custom field — confirmed in
  // production data: some use "Persona": "Site Admin", others use lowercase "persona":
  // "principals". Check both keys and match loosely rather than requiring an exact string.
  const persona = (payload.Persona || payload['persona'] || '').toLowerCase();
  if (persona.includes('admin') || persona.includes('principal')) return 'admin';
  if (persona === 'teacher' || persona.includes('teacher')) return 'teacher';
  const role = payload.Role || payload['role'] || '';
  if (ADMIN_ROLE_PATTERN.test(role)) return 'admin';
  if (role) return 'teacher';
  return 'unknown';
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
  const audience = classifyAudience(payload);
  const audienceLabel =
    audience === 'admin' ? 'Site admin / decision-maker (principal, director, superintendent, etc.)'
    : audience === 'teacher' ? 'Classroom teacher'
    : 'Unknown — infer from their role/title and message if possible, otherwise default to classroom-teacher framing';

  let ctx = `PROSPECT: ${name}, ${role} at ${school}${state ? `, ${state}` : ''}\n`;
  ctx += `AUDIENCE: ${audienceLabel}\n`;
  if (state) ctx += `STATE: ${state}\n`;
  ctx += `EMAIL: ${payload.lead_email}\n`;
  ctx += `CAMPAIGN: ${payload.campaign_name}\n\n`;

  ctx += `--- EMAIL THREAD (oldest first) ---\n\n`;

  if (thread.length > 0) {
    const ownAccount = (payload.email_account || '').toLowerCase().trim();
    for (const email of thread) {
      const from = email.isOutbound ? `You (${payload.email_account})` : `${name} (${payload.lead_email})`;
      // Surface who else was on this specific message (besides you) — this is the only
      // way to actually see a looped-in colleague's address; it is NOT reliably spelled
      // out in the body text itself.
      const others = [...(email.to ?? []), ...(email.cc ?? [])]
        .map((e) => (e || '').toLowerCase().trim())
        .filter((e) => e && e !== ownAccount && e !== payload.lead_email?.toLowerCase().trim());
      const othersLine = others.length ? `Also on this message: ${[...new Set(others)].join(', ')}\n` : '';
      ctx += `[${from}${email.timestamp ? ' · ' + email.timestamp : ''}]\n${othersLine}${email.body}\n\n`;
    }
  } else {
    ctx += `[You · ${payload.email_account}]\n${payload.email_text || '(unavailable)'}\n\n`;
  }

  // Label the latest reply's actual sender — usually the original lead, but if someone
  // else has taken over the thread (see cc/loop-in rules), payload.lead_email would
  // mislabel who really sent it. The thread's own most recent inbound message (if present)
  // is more trustworthy than blindly assuming it's always the original contact — this
  // exact mislabeling was a contributing factor in a real booked-the-wrong-person incident.
  const leadEmailLower = (payload.lead_email || '').toLowerCase().trim();
  const latestThreadInbound = [...thread].reverse().find((e) => !e.isOutbound);
  const latestReplyFrom = (latestThreadInbound?.from || payload.lead_email || '').toLowerCase().trim();
  const latestReplyLabel =
    !latestReplyFrom || latestReplyFrom === leadEmailLower
      ? `${name} (${payload.lead_email})`
      : latestReplyFrom;

  ctx += `--- LATEST REPLY (this is what just came in — your job is to respond to this) ---\n`;
  ctx += `[${latestReplyLabel}]\n${payload.reply_text || payload.reply_text_snippet || '(empty)'}\n`;
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
export function naturalTimePhrase(isoStart: string, now: Date, tz: string): string {
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

// Collects every other person on the conversation to add as Calendly guests when booking.
// Deterministic and judgment-free: takes the most recent inbound email's from/to/cc,
// drops our own sending account and the primary invitee (the lead), and returns the rest.
// Different addresses for the same person are all kept (we do not dedupe by person).
export function computeGuestEmails(thread: ThreadEmail[], payload: InstantlyWebhookPayload): string[] {
  const latestInbound = [...thread].reverse().find((e) => !e.isOutbound);
  if (!latestInbound) return [];

  const candidates = [
    latestInbound.from,
    ...(latestInbound.to ?? []),
    ...(latestInbound.cc ?? []),
  ];

  const exclude = new Set(
    [payload.email_account, payload.lead_email]
      .filter(Boolean)
      .map((e) => e!.toLowerCase().trim()),
  );

  const seen = new Set<string>();
  const guests: string[] = [];
  for (const raw of candidates) {
    if (!raw) continue;
    const email = raw.toLowerCase().trim();
    if (!email || !email.includes('@')) continue;
    if (exclude.has(email)) continue; // our account or the primary invitee
    if (seen.has(email)) continue; // exact-duplicate address
    seen.add(email);
    guests.push(email);
  }
  return guests;
}

export interface AgentMocks {
  getAvailableTimes?: typeof getAvailableTimes;
  bookMeeting?: typeof bookMeeting;
}

async function executeToolWithRetry(
  name: string,
  input: Record<string, any>,
  payload: InstantlyWebhookPayload,
  attempt = 0,
  mocks: AgentMocks = {},
  guestEmails: string[] = [],
  slotHosts: Map<string, BookingHost> = new Map(),
): Promise<{ data?: any; specialAction?: AgentResult }> {
  try {
    if (name === 'get_available_times') {
      const tz = (input.timezone as string) || 'America/New_York';
      const senderHost = getBookingHost(payload.email_account);
      const sorenEnabled = isSorenBookingEnabled();

      let rawSlots: Array<{ startTime: string }> = [];
      let host: BookingHost = 'katie';

      if (senderHost === 'soren') {
        // Kreg's or Soren's own inbox — books onto Soren's calendar, but only if he's
        // currently accepting bookings. With no toggle on, there's no valid calendar to
        // check against (Katie is explicitly excluded for these inboxes), so return no
        // availability rather than silently falling back to her calendar.
        if (!sorenEnabled) {
          return {
            data: {
              requested_time_available: false,
              suggested_times: [],
              instruction:
                'Soren is not currently accepting bookings this week. Do not propose or confirm any times — escalate for manual scheduling instead.',
            },
          };
        }
        rawSlots = await getSorenAvailableTimes(input.start_time, input.end_time);
        host = 'soren';
      } else {
        const fn = mocks.getAvailableTimes ?? getAvailableTimes;
        rawSlots = await fn(input.start_time, input.end_time);
        host = 'katie';
        // Overflow: Katie's inbox, but her calendar has nothing in this window — if Soren
        // is taking overflow this week, offer his slots instead of coming back empty.
        if (rawSlots.length === 0 && sorenEnabled) {
          const overflow = await getSorenAvailableTimes(input.start_time, input.end_time);
          if (overflow.length > 0) {
            rawSlots = overflow;
            host = 'soren';
          }
        }
      }

      // Deprioritize slots that would create 4+ back-to-back meetings on the relevant
      // calendar (no break >= MEETING_BREAK_MINUTES). Fails open: if the Google Calendar
      // check errors or isn't configured, we skip filtering rather than block scheduling.
      let slots: Array<{ startTime: string }> = rawSlots;
      if (envOptional('GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON')) {
        try {
          const bufferMs = 4 * 60 * 60 * 1000;
          const rangeStart = new Date(new Date(input.start_time).getTime() - bufferMs).toISOString();
          const rangeEnd = new Date(new Date(input.end_time).getTime() + bufferMs).toISOString();
          const existingMeetings = await getBusyMeetings(rangeStart, rangeEnd, host === 'soren' ? SOREN_EMAIL : undefined);
          const uncluttered = rawSlots.filter((s) => {
            const end = new Date(new Date(s.startTime).getTime() + 30 * 60 * 1000).toISOString();
            return !wouldExceedConsecutiveMeetings(existingMeetings, s.startTime, end);
          });
          // Only apply the filter if it leaves at least one option — never tell the
          // prospect nothing is available just because every slot is clustered.
          if (uncluttered.length > 0) slots = uncluttered;
        } catch (err) {
          console.warn(
            '[agent] Google Calendar clustering check failed, skipping:',
            err instanceof Error ? err.message : String(err),
          );
        }
      }

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

      // Remember which calendar each offered slot belongs to, so book_meeting (called
      // later in this same run) knows where to actually book it — the model itself never
      // needs to know or report this.
      for (const s of picked) slotHosts.set(s.startTime, host);

      // Hold every proposed slot immediately (before a human even reviews the draft) so
      // the calendar stops offering it to other prospects while this reply is pending.
      // Cheap (2x30min, spread across different days) and fails open on any error. Awaited
      // (not fire-and-forget) so the write can't get dropped mid-flight when the
      // serverless function's process freezes after the response is sent.
      if (envOptional('GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON')) {
        const leadName = [payload.firstName, payload.lastName].filter(Boolean).join(' ');
        for (const s of picked) {
          await createHold({
            startIso: s.startTime,
            endIso: new Date(new Date(s.startTime).getTime() + 30 * 60 * 1000).toISOString(),
            leadEmail: payload.lead_email,
            leadName,
            campaignId: payload.campaign_id,
            label: 'proposed',
            calendarEmail: host === 'soren' ? SOREN_EMAIL : undefined,
          });
        }
      }

      console.log(`[agent] get_available_times returned ${slots.length} slots (host=${host}), suggesting: ${suggested.map(s => s.natural).join(' | ')}`);
      return {
        data: {
          requested_time_available: requestedAvailable,
          suggested_times: suggested,
          booking_host: host, // 'katie' or 'soren' — whoever will actually host if one of these is booked, see BOOKING HOST rules
          instruction: requestedAvailable
            ? 'The requested time is available. Confirm it, referring to it naturally using its "natural" phrasing.'
            : 'Refer to these exact slots in your reply, using the "natural" phrasing for each (e.g. "tomorrow at 1:00 PM CDT"). Do not pick different times.',
        },
      };
    }

    if (name === 'book_meeting') {
      // IMPORTANT: we do NOT create the real booking here. Availability was already
      // verified via get_available_times. The actual booking (Calendly invitee, or a
      // direct Google Calendar event for Soren) is created only when a human approves by
      // clicking Send in Slack (see api/slack-action.ts). Here we just prepare the
      // booking params so the agent can draft a confirmation and acknowledge guests.
      //
      // Which calendar this books onto was decided when the slot was offered
      // (get_available_times) — look it up rather than re-deriving it, since Katie-inbox
      // overflow can land a slot on Soren's calendar even though the sender is Katie.
      // Falls back to a close-timestamp match, then to the sender's default host, in case
      // the model confirms a time slightly differently than it was offered.
      let host = slotHosts.get(input.start_time);
      if (!host) {
        const reqMs = new Date(input.start_time).getTime();
        for (const [iso, h] of slotHosts) {
          if (Math.abs(new Date(iso).getTime() - reqMs) < 60 * 1000) {
            host = h;
            break;
          }
        }
      }
      if (!host) host = getBookingHost(payload.email_account);

      // The prospect has now explicitly confirmed this time, but it can still sit in the
      // Slack approval queue for a while before a human clicks Send — hold it now so
      // nobody else can grab it out from under this booking in the meantime.
      if (envOptional('GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON')) {
        await createHold({
          startIso: input.start_time,
          endIso: new Date(new Date(input.start_time).getTime() + 30 * 60 * 1000).toISOString(),
          leadEmail: payload.lead_email,
          leadName: input.name || [payload.firstName, payload.lastName].filter(Boolean).join(' '),
          campaignId: payload.campaign_id,
          label: 'confirmed, awaiting send',
          calendarEmail: host === 'soren' ? SOREN_EMAIL : undefined,
        });
      }
      console.log(
        `[agent] book_meeting prepared (books on Send, host=${host}): ${input.start_time}` +
          (guestEmails.length ? ` (guests: ${guestEmails.join(', ')})` : ''),
      );
      return {
        data: {
          success: true,
          startTime: input.start_time,
          name: input.name,
          email: input.email,
          timezone: input.timezone,
          guests_added: guestEmails,
          host,
        },
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
      return {
        specialAction: {
          action: 'escalate',
          reason: input.reason,
          draft: input.suggested_reply,
        },
      };
    }

    return { data: { error: `Unknown tool: ${name}` } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[agent] tool ${name} failed (attempt ${attempt}):`, msg);
    if (attempt < 2) {
      await sleep(500 * Math.pow(2, attempt));
      return executeToolWithRetry(name, input, payload, attempt + 1, mocks, guestEmails, slotHosts);
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

  // Everyone else on the thread (CC'd colleagues, additional recipients) is added as a
  // Calendly guest automatically when a booking happens. Computed in code, not by the model.
  const guestEmails = computeGuestEmails(thread, payload);
  if (guestEmails.length) {
    console.log(`[agent] will add guests on booking: ${guestEmails.join(', ')}`);
  }

  // Max realistic flow: 2x get_available_times + book_meeting + draft = 4 iterations.
  // 8 gives solid headroom for edge cases without risking runaway loops.
  const MAX_ITERATIONS = 8;
  let pendingBooking: AgentResult['pendingBooking'] | undefined;
  // Tracks which calendar (Katie's or Soren's) each offered slot belongs to, populated by
  // get_available_times and read by book_meeting later in the same run.
  const slotHosts = new Map<string, BookingHost>();

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
        booked: !!pendingBooking,
        pendingBooking,
        ccEmails: guestEmails,
      };
    }

    if (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of toolUseBlocks) {
        const result = await executeToolWithRetry(block.name, block.input as Record<string, any>, payload, 0, mocks, guestEmails, slotHosts);

        if (result.specialAction) {
          // Carry pendingBooking through even on escalate/hard_no/ooo — if the model had
          // already confirmed a booking before escalating for an unrelated reason, a human
          // clicking Send on the escalated card needs this to actually create the Calendly
          // booking, not just send a reply that claims one exists.
          return { ...result.specialAction, ccEmails: guestEmails, pendingBooking };
        }

        if (block.name === 'book_meeting' && result.data?.success) {
          pendingBooking = {
            startTime: result.data.startTime,
            name: result.data.name,
            email: result.data.email,
            timezone: result.data.timezone,
            guests: result.data.guests_added ?? [],
            host: result.data.host,
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

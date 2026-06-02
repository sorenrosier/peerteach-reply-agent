import Anthropic from '@anthropic-ai/sdk';
import { env } from './env';
import { getAvailableTimes, bookMeeting } from './calendly';
import { InstantlyWebhookPayload } from './types';

const MODEL = 'claude-sonnet-4-5-20251022';

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

const TOOLS: Anthropic.Tool[] = [
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
      },
      required: ['start_time', 'end_time'],
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
      'legal mentions, or situations too ambiguous to handle. ' +
      'Do NOT escalate just because the email went to the wrong person — handle that by drafting ' +
      'a polite one-line reply asking who handles math curriculum or instructional decisions. ' +
      'Do NOT escalate referrals where the prospect gave a name but no email — just ask for the email. ' +
      'Only escalate referrals where a direct email was given (forward to human to make that intro).',
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
  return { firstName: 'Katie', signOff: 'Katie\nPeerTeach' };
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
It is early June 2026, end of the school year. Many administrators are wrapping up the year.
If scheduling feels hard now, the summer is a good time to plan ahead for next year.

VOICE RULES (non-negotiable):
- Write like a real person on a small team, not a vendor
- Short sentences. Get to the point.
- Always start with "Hi [prospect first name],"
- Never start by restating what they said
- Never use em dashes (use comma or period instead)
- Never use: "truly", "greatly", "deeply", "absolutely", "certainly", "excited"
- No bullet points ever
- Max 80 words total (not counting signature)
- End with exactly one question or one clear next step

TOOL USAGE RULES:

get_available_times:
- Call this EVERY time you need to mention specific meeting times
- Call it for the relevant date range based on what the prospect said
  ("next week" → start=next Monday, end=next Friday)
  ("2 weeks from now" → start/end 2 weeks out)
  ("today" → today's remaining hours)
  ("any time" → next 2 weekdays)
- After getting slots, pick 2 that are spread apart (different days preferred)
- Only propose times that actually appear in the results — never make up times
- Always include timezone when mentioning times

book_meeting:
- Only call when prospect explicitly confirmed ("Yes, that works", "Let's do Thursday at 2")
- After booking, draft a short confirmation: "Booked — calendar invite is on its way."
- Include reschedule link if available

no_reply:
- Use for: "Thanks!", "Sounds good", OOO auto-replies, natural conversation endings
- Do NOT reply to every message — know when the conversation is done

hard_no:
- Use for explicit unsubscribe/remove requests only

escalate:
- Wrong person situations
- Forwarding you to someone else (give their contact info to the human)
- Legal threats or hostile replies
- District-level bureaucracy requiring special handling
- Anything you are not confident handling

REMEMBER: You have access to the full email thread. Use all prior context to make smart decisions.
Never propose times you haven't verified with get_available_times.`;
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

  let ctx = `PROSPECT: ${name}, ${role} at ${school}\n`;
  ctx += `EMAIL: ${payload.lead_email}\n`;
  ctx += `CAMPAIGN: ${payload.campaign_name}\n\n`;

  ctx += `--- EMAIL THREAD ---\n\n`;

  if (thread.length > 0) {
    for (const email of thread) {
      const from = email.isOutbound ? `You (${payload.email_account})` : name;
      ctx += `[${from}${email.timestamp ? ' · ' + email.timestamp : ''}]\n${email.body}\n\n`;
    }
  } else {
    ctx += `[Original email you sent]\n${payload.email_text || '(unavailable)'}\n\n`;
    ctx += `[Latest reply from ${name}]\n${payload.reply_text || payload.reply_text_snippet || '(empty)'}`;
  }

  ctx += `\n---\n\nReply to the latest message from ${name}. Use tools as needed. Return a draft reply OR call an action tool.`;
  return ctx;
}

async function executeToolWithRetry(
  name: string,
  input: Record<string, any>,
  attempt = 0,
): Promise<{ data?: any; specialAction?: AgentResult }> {
  try {
    if (name === 'get_available_times') {
      const slots = await getAvailableTimes(input.start_time, input.end_time);
      const formatted = slots.map((s) => {
        const dt = new Intl.DateTimeFormat('en-US', {
          weekday: 'long',
          month: 'long',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          timeZoneName: 'short',
          timeZone: 'America/New_York',
        }).format(new Date(s.startTime));
        return { startTime: s.startTime, formatted: dt };
      });
      console.log(`[agent] get_available_times returned ${formatted.length} slots`);
      return { data: { slots: formatted, count: formatted.length } };
    }

    if (name === 'book_meeting') {
      const booking = await bookMeeting({
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
      return executeToolWithRetry(name, input, attempt + 1);
    }
    return { data: { error: msg } };
  }
}

export async function runAgent(
  payload: InstantlyWebhookPayload,
  thread: ThreadEmail[],
): Promise<AgentResult> {
  const client = new Anthropic({ apiKey: env('ANTHROPIC_API_KEY') });

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: buildContext(payload, thread) },
  ];

  const MAX_ITERATIONS = 6;
  let bookedDetails: AgentResult['bookingDetails'] | undefined;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    console.log(`[agent] iteration ${i + 1}/${MAX_ITERATIONS}`);

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: buildSystemPrompt(payload),
      tools: TOOLS,
      messages,
    });

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find((b) => b.type === 'text');
      const text = textBlock && textBlock.type === 'text' ? textBlock.text.trim() : '';
      if (!text || text.toUpperCase() === 'NONE') return { action: 'no_reply' };

      const cleaned = text
        .replace(/^```(?:\w+)?\s*/i, '')
        .replace(/```$/i, '')
        .replace(/—/g, ',')
        .replace(/–/g, ',')
        .trim();

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
        const result = await executeToolWithRetry(block.name, block.input as Record<string, any>);

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

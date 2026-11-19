import Anthropic from '@anthropic-ai/sdk';
import { env, isTeacherAutoSendEnabled, TEACHER_CALENDLY_URL } from './env';
import { ThreadEmail, computeGuestEmails, findLeakedMetaText, getSenderIdentity, getSchoolYearContext } from './agent';
import { fetchEmailThread, replyToEmail, findRecentHumanReply, getAccountFirstName } from './instantly';
import { getOrCreateDemoLink, DemoLinkError } from './demoLinks';
import { renderLinks } from './linkFormat';
import {
  postAgentDraft,
  postAutoSentNotification,
  postEscalateNotification,
  postErrorNotification,
  postHardNoNotification,
  postInfoNote,
  replySubject,
} from './slack';
import { TEACHER_FACTS, TEAM_FOLLOWS_UP, priceToQuote } from './teacherKnowledge';
import { AgentResult, InstantlyWebhookPayload } from './types';

// The teacher-facing reply system. Teachers get a cold email offering a personal link to
// Remy, PeerTeach's AI demo ("no call needed"); this answers their replies by email, gets
// interested teachers their link, and answers questions from TEACHER_FACTS. It's separate from
// the admin/principal agent (agent.ts), which steers toward a demo call; nothing here changes
// that system's behavior.
//
// Reached from router.ts only when isTeacherPersona() is true, after the duplicate-delivery
// guard has already run.

// Claude Opus 5.5: open-ended replies over a long facts list. Thinking is always on for this
// model; effort is the depth control (its default is medium, set explicitly here).
const TEACHER_MODEL = 'claude-opus-5-5';
const MAX_ITERATIONS = 6;
const DEMO_LINK_PLACEHOLDER = '{{DEMO_LINK}}';

// Routing signal: only a lead whose Persona field itself says teacher. Deliberately narrower
// than classifyAudience(), whose Role fallback calls any non-admin title a teacher ("Math
// Coach", "Counselor"): for routing, anything uncertain stays on the proven admin system.
export function isTeacherPersona(payload: InstantlyWebhookPayload): boolean {
  const persona = String(payload.Persona || payload['persona'] || '').toLowerCase();
  return persona.includes('teacher') && !persona.includes('admin') && !persona.includes('principal');
}

export type TeacherCategory =
  | 'existing_user'
  | 'referral_with_email'
  | 'demo_trouble'
  | 'team_follow_up'
  | 'hostile_or_legal'
  | 'personal_ooo'
  | 'asks_if_automated'
  | 'other'
  // Set by code, not the model:
  | 'loop_in'
  | 'output_check'
  | 'demo_link_failed'
  | 'model_declined';

export interface TeacherResult {
  action: 'draft' | 'no_reply' | 'ooo' | 'unsubscribe' | 'escalate';
  draft?: string;
  category?: TeacherCategory;
  reason?: string;
  ccEmails?: string[];
  demoLink?: string;
}

const MODEL_CATEGORIES: TeacherCategory[] = [
  'existing_user',
  'referral_with_email',
  'demo_trouble',
  'team_follow_up',
  'hostile_or_legal',
  'personal_ooo',
  'asks_if_automated',
  'other',
];

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'no_reply',
    description:
      'No email should go out: an automated out-of-office or auto-responder, or a closing message ("Thanks!", "Will do") where the conversation is clearly done.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Brief reason no reply is needed' },
        is_auto_ooo: { type: 'boolean', description: 'True for an automated out-of-office / auto-responder' },
      },
      required: ['reason', 'is_auto_ooo'],
      additionalProperties: false,
    },
  },
  {
    name: 'teacher_details',
    description:
      "Call BEFORE writing your reply, only when the teacher's own words show their details differ from the TEACHER line: " +
      'they now teach at a different school, or they go by a different first name than the one on file. ' +
      "Their personal demo link greets them by name and school, so this makes the link match. Then write the reply as usual.",
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        current_school: {
          type: 'string',
          description: 'The school they now teach at, exactly as they named it. Empty string if their school is unchanged, or if they moved but did not name the new school.',
        },
        moved_school_unnamed: {
          type: 'boolean',
          description: 'True only if they say they are at a different school now but did not name it.',
        },
        preferred_first_name: {
          type: 'string',
          description: 'The first name they go by (e.g. how they sign), if different from the one on file. Empty string otherwise.',
        },
      },
      required: ['current_school', 'moved_school_unnamed', 'preferred_first_name'],
      additionalProperties: false,
    },
  },
  {
    name: 'unsubscribe',
    description: 'They explicitly ask to be removed, unsubscribed, or not contacted again.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'The words that asked to stop' } },
      required: ['reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'escalate',
    description:
      'A person on our team needs to handle or check this reply before anything is sent (see WHEN TO ESCALATE). ' +
      'Always write your best real draft in suggested_reply, following the same voice rules; a human will send or edit it.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: MODEL_CATEGORIES },
        reason: { type: 'string', description: 'What needs a human, quoting the line that triggered it' },
        suggested_reply: { type: 'string', description: 'Best-effort ready-to-send draft' },
      },
      required: ['category', 'reason', 'suggested_reply'],
      additionalProperties: false,
    },
  },
];

// Static, so it caches across every reply (anything per-reply goes in the user message).
const SYSTEM_PROMPT = `You answer email replies from classroom math teachers for PeerTeach. You write as a real member of the PeerTeach team (named in each request), replying in an existing email thread.

THE SITUATION
We cold-emailed the teacher. Our email described PeerTeach, mentioned grant funding for a small number of free pilot classrooms, and asked: "Want me to send you a demo link? You can click through it on your own in a few minutes, no call needed." They replied. Your job is to keep a genuine, helpful conversation going by email and get interested teachers into the demo: a personal link to Remy, our AI guide, which they can do on their own. No call is needed or pushed. After the demo, teachers who want to start book onboarding with Katie themselves.

THE DEMO LINK
- Every teacher gets their own personal link. You never see or type it. Write the exact placeholder ${DEMO_LINK_PLACEHOLDER} where it goes, and our system puts in the real link.
- Include ${DEMO_LINK_PLACEHOLDER} whenever they show interest, say yes, or ask a question that implies interest (how it works, cost, grades, setup, time, approval).
- The link greets them by name and school. If they say they now teach at a different school, or they go by a different first name than the one on file (e.g. they sign "Nikki" but the file says "Aubrey"), call teacher_details first, then write your reply as usual and use the name they go by. A teacher who moved schools still gets the link: PeerTeach goes wherever they teach.
- If the thread shows the link was already sent, don't resend the whole intro. Answer what they asked; include ${DEMO_LINK_PLACEHOLDER} again only if it helps ("here it is again"), at most once.

THE STANDARD REPLY (for a plain yes / interest, use this nearly word for word; keep it this short):
I'm so glad you want to check out PeerTeach, [first name]!

Here's your personal demo link: ${DEMO_LINK_PLACEHOLDER}

It works best on a laptop with your sound on. We're filling the last few pilot spots now, so I'd love to hear what you think today or tomorrow!

-[sender first name]

If they also asked something, answer it in one to three sentences right after the first line, then continue with the link line. If you don't know their first name, open with "I'm so glad you want to check out PeerTeach!". Don't say how long the demo takes unless they ask.

OTHER REPLIES
- Every reply other than the standard one starts with "Hi [first name]," (or "Hi there," if unknown) on its own line.
- Every reply ends with a blank line and then the sign-off exactly as given in the request, e.g. "-Katie", on its own last line. Nothing after it.

VOICE
- Warm, plain, brief, like a helpful colleague. Never pushy, never salesy, no filler.
- Answer exactly what they asked, short answer first. Remy covers depth in the demo, so it's fine to say "Remy can walk you through that in the demo."
- Contractions throughout. Paragraphs of 1 to 3 sentences. Non-standard replies stay under about 120 words before the sign-off.
- Never use em dashes or en dashes; use a comma or period. Write ranges with "to".
- Never use: "truly", "greatly", "deeply", "absolutely", "certainly", "excited", "game-changer".
- Don't re-pitch or repeat what earlier emails in the thread already said.
- Don't add urgency, scarcity, deadlines or discounts beyond what's already in the thread, except the one pilot-spots line in the standard reply, used once per thread.
- Never promise something our system doesn't do: don't say you'll stop emailing them, take them off a list, or follow up on a certain date. (If they ask to stop, use unsubscribe.) "I'd be glad to reconnect then" is fine.
- Only these links may appear: ${DEMO_LINK_PLACEHOLDER}, Katie's Calendly (${TEACHER_CALENDLY_URL}), and https://peerteach.org. Write any of them as a plain URL. Never invent other addresses.
- Output ONLY the email text. No notes, no reasoning, no labels like "Draft:", no talk about the teacher in the third person.

FACTS
Only state facts from this list. If they ask something it doesn't cover, don't guess or approximate: escalate (team_follow_up) with an honest draft that says you'll find out.
${TEACHER_FACTS}

Our team follows up personally on (escalate as team_follow_up):
${TEAM_FOLLOWS_UP}

SITUATIONS
- Interested / "yes" / "sure, send it" / "tell me more": the standard reply.
- Question that implies interest: answer briefly from FACTS, then the link (standard reply shape).
- Cost: only when asked, from PRICES; mention the free grant-funded pilot first if it hasn't come up.
- Principal approval: the pilot needs a school leader's OK, and the demo gives them a ready-made approval email. Encourage them to start with the demo.
- They did the demo, or want to get started: point them to booking onboarding with Katie at ${TEACHER_CALENDLY_URL}, and mention their principal's OK should be in before the onboarding call. Other math teachers are welcome to join.
- They'd rather talk to a person than do the demo: that's fine, offer Katie's Calendly (${TEACHER_CALENDLY_URL}). You may also include the demo link as an option, once.
- Misconception (they think we send tutors, or it's an after-school program): gently clarify that teachers run PeerTeach with their own students during class, then the link if they still sound interested. Not a correction, just matter-of-fact.
- Not interested / not right now: thank them warmly in one or two sentences, no pitch, no link. If "not now" with a time ("maybe in the spring"), say you'd be glad to reconnect then.
- Not a fit (doesn't teach math, or a grade/course we don't cover): thank them, say briefly who PeerTeach is for, no push. If they offer to pass it to a colleague without giving an email, thank them; they're welcome to forward this email.
- Automated out-of-office / auto-responder: no_reply (is_auto_ooo true).
- Pure closing ("Thanks!", "Got it") after the link was sent: no_reply.
- Asks to stop / unsubscribe: unsubscribe.

WHEN TO ESCALATE (call escalate with the category, and still write the full draft)
- existing_user: anything in the thread shows they already use or used PeerTeach.
- referral_with_email: they hand you a colleague's email address to contact instead. Draft a short note to that colleague.
- demo_trouble: the link didn't work, expired, mic/audio problems, or any technical issue with the demo. Draft practical help plus Katie's Calendly as an alternative.
- team_follow_up: anything in "Our team follows up personally on", or any question FACTS doesn't answer.
- hostile_or_legal: angry, threatening, or legal/complaint language.
- personal_ooo: a real person says they're away until a specific date (not an auto-responder).
- asks_if_automated: they ask whether this is automated, AI, or a real person. Never claim to be human; a person on our team answers this.
- other: anything ambiguous, unexpected, in another language, or that doesn't fit the above. When in doubt, escalate.`;

function cleanDashes(text: string): string {
  return text
    .replace(/(\d|\bK)\s*[–—]\s*(\d)/g, '$1-$2')
    .replace(/\s+[–—]\s+/g, ', ')
    .replace(/[—–]/g, ', ');
}

function leadFirstName(payload: InstantlyWebhookPayload): string {
  return String(payload.firstName || payload['first_name'] || '').trim();
}

// The first teacher campaign (11/5/26) stores the full name as `school_name` ("Helen Hansen
// Elementary") next to a short `School/District Nickname` ("Hansen Elementary"); confirmed in a
// real webhook delivery that both arrive as top-level payload fields. Prefer the nickname (Soren's
// call: it reads more naturally, and it's what the cold email itself uses); it's what the demo
// link and Remy's greeting use. Fall back to the full name, then the district.
export function leadSchool(payload: InstantlyWebhookPayload): string {
  return String(
    payload['School/District Nickname'] || payload['school_name'] || payload.School || payload['district_name'] || payload['District Name'] || '',
  ).trim();
}

// Lead lists sometimes carry a nickname in the last name ('"Nikki" Diehm', 'Diehm (Nikki)').
// Remy greets by the name on the link, so keep just the surname.
export function cleanLastName(last: unknown): string {
  return String(last || '')
    .replace(/["“”][^"“”]*["“”]|\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function leadState(payload: InstantlyWebhookPayload): string {
  return String(payload.State || payload['state'] || '').trim();
}

function linkAlreadySent(thread: ThreadEmail[]): boolean {
  return thread.some((e) => e.isOutbound && e.body.includes('/ai-agents/demo'));
}

// Replies up to and including the one that sends the demo link go out on their own: the team
// checked those and they look good (Soren, 2026-11-18). Once a teacher has their link, their
// questions still go to Slack for approval. A reply counts as before the link only when we can
// see our own outreach in the thread (so a failed thread fetch can't make it look like one) and
// no link has been made for the lead yet (demo_link on the lead covers a link sent in an email
// the fetch missed). TEACHER_AUTO_SEND_ENABLED=true still sends every draft.
export function canAutoSend(payload: InstantlyWebhookPayload, thread: ThreadEmail[]): boolean {
  if (isTeacherAutoSendEnabled()) return true;
  if (process.env.TEACHER_PRE_LINK_AUTO_SEND === 'off') return false;
  if (!thread.some((e) => e.isOutbound)) return false;
  if (String(payload['demo_link'] || '').trim()) return false;
  return !linkAlreadySent(thread);
}

function buildContext(payload: InstantlyWebhookPayload, thread: ThreadEmail[], senderFirst: string): string {
  const now = new Date();
  // With the time and zone, and a note that thread timestamps are UTC: a reply sent at 9pm
  // Pacific carries the next day's UTC date, and with only a date the model read those as
  // "dated in the future" and escalated them (seen in the replay).
  const today = new Intl.DateTimeFormat('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
    timeZone: 'America/New_York', timeZoneName: 'short',
  }).format(now);
  const first = leadFirstName(payload);
  const name = [first, payload.lastName].filter(Boolean).join(' ') || '(name unknown)';
  const linkSent = linkAlreadySent(thread);

  let ctx = `YOU ARE: ${senderFirst}. Sign off exactly as "-${senderFirst}".\n`;
  ctx += `NOW: ${today} (timestamps in the thread below are UTC)\nSCHOOL YEAR: ${getSchoolYearContext(now)}\n`;
  ctx += `TEACHER: ${name}${first ? ` (first name: ${first})` : ''}, ${payload.Role || 'teacher'} at ${leadSchool(payload) || 'unknown school'}${leadState(payload) ? `, ${leadState(payload)}` : ''}\n`;
  ctx += `PRICE TO QUOTE (only if they ask about cost): ${priceToQuote(now)}\n`;
  ctx += `DEMO LINK ALREADY SENT IN THIS THREAD: ${linkSent ? 'yes' : 'no'}\n\n`;
  ctx += `--- EMAIL THREAD (oldest first) ---\n\n`;
  if (thread.length) {
    const own = (payload.email_account || '').toLowerCase();
    const lead = (payload.lead_email || '').toLowerCase();
    for (const e of thread) {
      const from = e.isOutbound ? `Us (${payload.email_account})` : `${e.from || payload.lead_email}`;
      const others = [...(e.to ?? []), ...(e.cc ?? [])]
        .map((x) => (x || '').toLowerCase().trim())
        .filter((x) => x && x !== own && x !== lead);
      const also = others.length ? `Also on this message: ${[...new Set(others)].join(', ')}\n` : '';
      ctx += `[${from}${e.timestamp ? ' · ' + e.timestamp : ''}]\n${also}${e.body}\n\n`;
    }
  } else {
    ctx += `[Us · ${payload.email_account}]\n${payload.email_text || '(unavailable)'}\n\n`;
  }
  ctx += `--- LATEST REPLY (respond to this) ---\n${payload.reply_text || payload.reply_text_snippet || '(empty)'}\n---`;
  return ctx;
}

// Checks the model's email before it can go anywhere. Returns why it's unusable, or null.
function checkDraft(draft: string, senderFirst: string): string | null {
  const lines = draft.split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] || '';
  if (!new RegExp(`^-\\s?${senderFirst.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.?$`, 'i').test(last)) {
    return `doesn't end with the "-${senderFirst}" sign-off (possible leaked reasoning)`;
  }
  const leak = findLeakedMetaText(draft);
  if (leak) return `contains internal wording ("${leak}")`;
  const leftover = draft.split(DEMO_LINK_PLACEHOLDER).join('').match(/\{\{[^}]*\}\}|\[(?:first name|sender[^\]]*|name)\]/i);
  if (leftover) return `contains an unfilled placeholder ("${leftover[0]}")`;
  for (const url of draft.match(/https?:\/\/[^\s)\]>]+/g) ?? []) {
    const u = url.replace(/[.,!?]+$/, '');
    const ok = u.startsWith(TEACHER_CALENDLY_URL) || /^https?:\/\/(www\.)?peerteach\.org(\/[^\s]*)?$/i.test(u);
    if (!ok) return `contains a link that isn't allowed (${u})`;
  }
  return null;
}

// What the model reported through teacher_details, when the teacher's details differ from the lead.
export interface TeacherDetails {
  currentSchool?: string;
  movedSchoolUnnamed?: boolean;
  preferredFirstName?: string;
}

export interface DraftDeps {
  // Real link creation in production; a fake link in the replay script.
  createDemoLink: (details: TeacherDetails) => Promise<string>;
}

// The teacher's own words in the latest reply, without the quoted thread under it.
function ownReplyText(payload: InstantlyWebhookPayload): string {
  const t = String(payload.reply_text || payload.reply_text_snippet || '').replace(/\r/g, '');
  const wrapped = t.search(/\n\s*On [^\n]{5,200}\n?[^\n]{0,200}wrote:/);
  const out: string[] = [];
  for (const line of (wrapped >= 0 ? t.slice(0, wrapped) : t).split('\n')) {
    if (/^\s*>/.test(line) || /^\s*-{2,}\s*Original Message/i.test(line) || (/^\s*From:\s/.test(line) && out.length)) break;
    out.push(line);
  }
  return out.join('\n').trim();
}

// A message that clearly needs an answer: a question, or more than a short closing line.
// no_reply on one of these is the misfire seen live (Nikki Diehm, 11/9) and once in the replay.
function needsAnswer(text: string): boolean {
  return text.includes('?') || text.split(/\s+/).filter(Boolean).length > 25;
}

// Runs the model and returns a decision with any demo link already filled in. Sends nothing.
export async function draftTeacherReply(
  payload: InstantlyWebhookPayload,
  thread: ThreadEmail[],
  senderFirst: string,
  deps: DraftDeps,
): Promise<TeacherResult> {
  const client = new Anthropic({ apiKey: env('ANTHROPIC_API_KEY') });
  const ccEmails = computeGuestEmails(thread, payload);
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: buildContext(payload, thread, senderFirst) }];

  let result: TeacherResult | null = null;
  const details: TeacherDetails = {};
  const substantive = needsAnswer(ownReplyText(payload));
  let reconsidered = false;
  for (let i = 0; i < MAX_ITERATIONS && !result; i++) {
    const response = await client.messages.create({
      model: TEACHER_MODEL,
      max_tokens: 16000,
      output_config: { effort: 'medium' },
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: TOOLS,
      // One tool per turn: teacher_details must come back before the model writes or decides.
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      messages,
    });
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'refusal') {
      result = { action: 'escalate', category: 'model_declined', reason: 'The model declined to draft a reply to this message.' };
    } else if (response.stop_reason === 'tool_use') {
      const block = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      const input = (block?.input ?? {}) as Record<string, any>;
      const toolResult = (content: string) =>
        messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: block!.id, content }] });
      if (block?.name === 'teacher_details') {
        const school = String(input.current_school || '').trim();
        const first = String(input.preferred_first_name || '').trim();
        if (school) details.currentSchool = school;
        if (!school && input.moved_school_unnamed) details.movedSchoolUnnamed = true;
        if (first) details.preferredFirstName = first;
        toolResult('Noted. Their demo link will match. Now write your reply as usual (or call another tool if one fits).');
      } else if (block?.name === 'no_reply' && !input.is_auto_ooo && substantive && !reconsidered) {
        // Ask once more rather than going silent on a message that asks something or says a lot.
        reconsidered = true;
        toolResult(
          "Not sent. Their message asks a question or says more than a closing line, so it almost certainly needs an answer. Reconsider: write the reply, or call another tool that fits. If you're still sure no email should go out, call escalate with your reason and your best draft, so a person decides.",
        );
      } else if (block?.name === 'no_reply' && !input.is_auto_ooo && substantive) {
        result = { action: 'escalate', category: 'other', reason: `The agent chose not to reply to a message that seems to need an answer (${input.reason}). Please check.` };
      } else if (block?.name === 'no_reply') {
        result = { action: input.is_auto_ooo ? 'ooo' : 'no_reply', reason: input.reason };
      } else if (block?.name === 'unsubscribe') {
        result = { action: 'unsubscribe', reason: input.reason };
      } else if (block?.name === 'escalate') {
        result = {
          action: 'escalate',
          category: MODEL_CATEGORIES.includes(input.category) ? input.category : 'other',
          reason: input.reason,
          draft: input.suggested_reply ? cleanDashes(String(input.suggested_reply)).trim() : undefined,
        };
      } else {
        // Unknown tool: tell the model and let it continue.
        const results: Anthropic.ToolResultBlockParam[] = response.content
          .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
          .map((b) => ({ type: 'tool_result', tool_use_id: b.id, content: `Unknown tool ${b.name}`, is_error: true }));
        messages.push({ role: 'user', content: results });
      }
    } else if (response.stop_reason === 'end_turn') {
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .replace(/^```(?:\w+)?\s*/i, '')
        .replace(/```$/i, '')
        .trim();
      result = text ? { action: 'draft', draft: cleanDashes(text).trim() } : { action: 'no_reply', reason: 'empty output' };
    } else {
      result = { action: 'escalate', category: 'output_check', reason: `Model stopped unexpectedly (${response.stop_reason}).` };
    }
  }
  if (!result) result = { action: 'escalate', category: 'output_check', reason: 'Agent loop exceeded max iterations.' };
  result.ccEmails = ccEmails;

  if (result.draft) {
    const problem = checkDraft(result.draft, senderFirst);
    if (problem && result.action === 'draft') {
      result = { ...result, action: 'escalate', category: 'output_check', reason: `Draft held for review: it ${problem}.` };
    } else if (problem) {
      result.reason = `${result.reason} (Also: the draft ${problem}.)`;
    }

    // Fill in the personal demo link for drafts and escalated drafts alike, so a human
    // clicking Send on an escalation sends a real link too.
    if (result.draft!.includes(DEMO_LINK_PLACEHOLDER)) {
      try {
        const url = await deps.createDemoLink(details);
        result.demoLink = url;
        result.draft = result.draft!.split(DEMO_LINK_PLACEHOLDER).join(`[${url}](${url})`);
      } catch (err) {
        const why = err instanceof DemoLinkError ? `${err.reason}: ${err.message}` : err instanceof Error ? err.message : String(err);
        const wasEscalation = result.action === 'escalate';
        result = {
          ...result,
          action: 'escalate',
          category: wasEscalation ? result.category : 'demo_link_failed',
          reason: `${wasEscalation ? result.reason + ' ' : ''}Couldn't create the demo link (${why}).`,
          draft: result.draft!.split(DEMO_LINK_PLACEHOLDER).join('[DEMO LINK MISSING: create one in the PeerTeach admin page]'),
        };
      }
    }
  }

  // Deterministic: anyone else on the thread means a human checks it first, same as the admin system.
  if (result.action === 'draft' && ccEmails.length) {
    result = { ...result, action: 'escalate', category: 'loop_in', reason: `Others are on this thread (${ccEmails.join(', ')}). Check who should get this before sending.` };
  }
  return result;
}

export async function routeTeacherReply(payload: InstantlyWebhookPayload): Promise<void> {
  console.log(`[teacherAgent] lead=${payload.lead_email} campaign=${payload.campaign_id}`);
  try {
    const [thread, accountFirst] = await Promise.all([
      fetchEmailThread(payload.campaign_id, payload.lead_email, { htmlFallback: true }),
      getAccountFirstName(payload.email_account),
    ]);
    const senderFirst = accountFirst || getSenderIdentity(payload.email_account).firstName;

    const result = await draftTeacherReply(payload, thread, senderFirst, {
      createDemoLink: async (details) => {
        // A school the teacher named wins; if they moved without naming it, the district (still
        // right for a move within the district, and better than greeting them by their old school).
        const district = String(payload['district_name'] || payload['District Name'] || payload['District'] || '').trim();
        const school = details.currentSchool || (details.movedSchoolUnnamed && district) || undefined;
        const last = cleanLastName(payload.lastName);
        const name = details.preferredFirstName ? [details.preferredFirstName, last].filter(Boolean).join(' ') : undefined;
        return (
          await getOrCreateDemoLink({
            campaignId: payload.campaign_id,
            email: payload.lead_email,
            name: [leadFirstName(payload), last].filter(Boolean).join(' ').trim(),
            school: leadSchool(payload),
            state: leadState(payload),
            override: { school, name, savedSchool: details.currentSchool, savedFirstName: details.preferredFirstName },
          })
        ).url;
      },
    });
    console.log(`[teacherAgent] action=${result.action} category=${result.category ?? '-'} link=${result.demoLink ? 'yes' : 'no'}`);

    const asAgentResult: AgentResult = { action: 'draft', draft: result.draft, ccEmails: result.ccEmails };
    switch (result.action) {
      case 'ooo':
        return;
      case 'no_reply': {
        // Not silent: in the replay the model once chose no_reply (with a nonsense reason) for
        // a teacher who'd asked to reconnect after the holidays, though 6 of 6 reruns drafted a
        // proper reply. A one-line note lets a person catch a wrong "no reply" call.
        const said = (payload.reply_text || payload.reply_text_snippet || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        await postInfoNote(
          `:mute: Teacher reply, no email sent to ${payload.lead_email} (${result.reason || 'no reason given'}). They wrote: "${said}" · <${payload.unibox_url}|Open in Unibox>`,
        );
        return;
      }
      case 'unsubscribe':
        await postHardNoNotification(payload);
        return;
      case 'escalate':
        await postEscalateNotification(
          payload,
          { classification: 'ESCALATE', confidence: 0, reasoning: `Teacher reply [${result.category}]: ${result.reason}`, extractedInfo: {} },
          result.draft,
          result.ccEmails,
        );
        return;
      case 'draft': {
        if (!canAutoSend(payload, thread)) {
          await postAgentDraft(payload, asAgentResult, ':apple: Teacher reply — needs approval');
          return;
        }
        const human = await findRecentHumanReply(payload.campaign_id, payload.lead_email);
        if (human) {
          await postEscalateNotification(
            payload,
            { classification: 'ESCALATE', confidence: 0, reasoning: `Teacher reply: a teammate wrote to this lead ${human.minutesAgo} min ago ("${human.preview}"). Holding the draft for review.`, extractedInfo: {} },
            result.draft,
            result.ccEmails,
          );
          return;
        }
        const rendered = renderLinks(result.draft!);
        await replyToEmail({
          reply_to_uuid: payload.email_id,
          eaccount: payload.email_account,
          subject: replySubject(payload.reply_subject || payload.email_subject || ''),
          body: { text: rendered.plainText, html: rendered.html },
          cc: result.ccEmails,
          stamp: { campaignId: payload.campaign_id, leadEmail: payload.lead_email },
        });
        await postAutoSentNotification(payload, asAgentResult, ':zap: Teacher reply auto-sent (no human review)');
        return;
      }
    }
  } catch (err) {
    console.error('[teacherAgent] failed:', err instanceof Error ? err.stack : String(err));
    try {
      await postErrorNotification(payload, err, 'teacher reply');
    } catch {}
  }
}

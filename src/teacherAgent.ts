import Anthropic from '@anthropic-ai/sdk';
import { env, isTeacherAutoSendEnabled, CALENDLY_SCHEDULING_URL } from './env';
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
import { TEACHER_FACTS, TEAM_FOLLOWS_UP } from './teacherKnowledge';
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
- If the thread shows the link was already sent, don't resend the whole intro. Answer what they asked; include ${DEMO_LINK_PLACEHOLDER} again only if it helps ("here it is again"), at most once.

THE STANDARD REPLY (for a plain yes / interest, use this nearly word for word):
I'm so glad you're interested, [first name]!

Here's your personal demo link: ${DEMO_LINK_PLACEHOLDER}

It's an interactive walkthrough led by Remy, our AI guide. You tell Remy a bit about your class, and it shows you how PeerTeach would work with your students and answers any questions along the way. It takes about 10 minutes, and you can do it whenever works for you.

Two quick tips: it works best on a laptop with your sound on, and your browser will ask for microphone access so you can talk with Remy.

If anything gives you trouble, just reply here to me!

-[sender first name]

If they also asked something, answer it in one to three sentences right after the first line, then continue with the link paragraph. If you don't know their first name, open with "I'm so glad you're interested!".

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
- Don't add urgency, scarcity, deadlines or discounts beyond what's already in the thread.
- Never promise something our system doesn't do: don't say you'll stop emailing them, take them off a list, or follow up on a certain date. (If they ask to stop, use unsubscribe.) "I'd be glad to reconnect then" is fine.
- Only these links may appear: ${DEMO_LINK_PLACEHOLDER}, Katie's Calendly (${CALENDLY_SCHEDULING_URL}), and https://peerteach.org. Write any of them as a plain URL. Never invent other addresses.
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
- They did the demo, or want to get started: point them to booking onboarding with Katie at ${CALENDLY_SCHEDULING_URL}, and mention their principal's OK should be in before the onboarding call. Other math teachers are welcome to join.
- They'd rather talk to a person than do the demo: that's fine, offer Katie's Calendly (${CALENDLY_SCHEDULING_URL}). You may also include the demo link as an option, once.
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

function leadSchool(payload: InstantlyWebhookPayload): string {
  return String(payload.School || payload['School/District Nickname'] || payload['District Name'] || '').trim();
}

function leadState(payload: InstantlyWebhookPayload): string {
  return String(payload.State || payload['state'] || '').trim();
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
  const linkSent = thread.some((e) => e.isOutbound && e.body.includes('/ai-agents/demo'));

  let ctx = `YOU ARE: ${senderFirst}. Sign off exactly as "-${senderFirst}".\n`;
  ctx += `NOW: ${today} (timestamps in the thread below are UTC)\nSCHOOL YEAR: ${getSchoolYearContext(now)}\n`;
  ctx += `TEACHER: ${name}${first ? ` (first name: ${first})` : ''}, ${payload.Role || 'teacher'} at ${leadSchool(payload) || 'unknown school'}${leadState(payload) ? `, ${leadState(payload)}` : ''}\n`;
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
    const ok = u.startsWith(CALENDLY_SCHEDULING_URL) || /^https?:\/\/(www\.)?peerteach\.org(\/[^\s]*)?$/i.test(u);
    if (!ok) return `contains a link that isn't allowed (${u})`;
  }
  return null;
}

export interface DraftDeps {
  // Real link creation in production; a fake link in the replay script.
  createDemoLink: () => Promise<string>;
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
  for (let i = 0; i < MAX_ITERATIONS && !result; i++) {
    const response = await client.messages.create({
      model: TEACHER_MODEL,
      max_tokens: 16000,
      output_config: { effort: 'medium' },
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: TOOLS,
      messages,
    });
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'refusal') {
      result = { action: 'escalate', category: 'model_declined', reason: 'The model declined to draft a reply to this message.' };
    } else if (response.stop_reason === 'tool_use') {
      const block = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      const input = (block?.input ?? {}) as Record<string, any>;
      if (block?.name === 'no_reply') {
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
        const url = await deps.createDemoLink();
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
      fetchEmailThread(payload.campaign_id, payload.lead_email),
      getAccountFirstName(payload.email_account),
    ]);
    const senderFirst = accountFirst || getSenderIdentity(payload.email_account).firstName;

    const result = await draftTeacherReply(payload, thread, senderFirst, {
      createDemoLink: async () =>
        (
          await getOrCreateDemoLink({
            campaignId: payload.campaign_id,
            email: payload.lead_email,
            name: [leadFirstName(payload), payload.lastName].filter(Boolean).join(' ').trim(),
            school: leadSchool(payload),
            state: leadState(payload),
          })
        ).url,
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
        if (!isTeacherAutoSendEnabled()) {
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

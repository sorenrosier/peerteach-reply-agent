import Anthropic from '@anthropic-ai/sdk';
import { env } from './env';
import { ClassificationResult, InstantlyWebhookPayload } from './types';

const MODEL = 'claude-sonnet-4-20250514';

function getSenderIdentity(email_account: string): {
  firstName: string;
  signOff: string;
} {
  const lower = email_account.toLowerCase();
  if (lower.includes('kreg')) {
    return { firstName: 'Kreg', signOff: 'Kreg\nCo-Founder, PeerTeach' };
  }
  return { firstName: 'Katie', signOff: 'Katie\nPeerTeach' };
}

function buildSystemPrompt(senderFirstName: string, signOff: string): string {
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

  const isKreg = senderFirstName === 'Kreg';
  const identityLine = isKreg
    ? 'You are Kreg Moccia, Co-Founder of PeerTeach.'
    : 'You are Katie Kaplan, on the PeerTeach team.';

  return `You are writing cold email replies on behalf of PeerTeach, a Stanford-developed math peer tutoring platform.

IDENTITY:
${identityLine}
Sign your reply exactly like this (on its own line at the end):
${signOff}

CURRENT DATE AND TIME: ${dateTimeStr}
Use this to understand what "today", "tomorrow", "this week", "Monday", etc. mean in any reply.

SCHOOL YEAR CONTEXT:
It is late May — the school year is wrapping up in the next few weeks. Many administrators are slammed with end-of-year responsibilities. Be brief and acknowledge the timing if relevant. "I know it's a busy time of year" is fine once if it fits naturally.

PRODUCT KNOWLEDGE:
- PeerTeach helps math teachers in grades 3-8 run structured peer tutoring during regular class time
- Students are paired based on data, given practice problems aligned to teacher's current topic
- Fully free for pilot schools — covered by a grant this school year
- Developed at Stanford, Reach Capital-backed
- Proven results at pilot schools nearby
- The only ask: a 20-30 min Zoom call

GREETING:
- Always start the reply with "Hi [first name]," on its own line
- Use the prospect's first name from the context provided

VOICE RULES (non-negotiable):
- Write like a real person on a small team, not a vendor
- Short sentences. Get to the point. No filler words.
- Never start a reply by restating what they said
- Never use em dashes
- Never use: "truly", "greatly", "deeply", "absolutely", "certainly", "excited"
- Never use overly flattering openers
- No bullet points ever
- Max 80 words total (not counting signature)
- End the body with exactly one question or one proposed next step — never a closing statement
- Do not mention features or technical details unless directly asked
- Never say "as I mentioned" or "per my previous email"

SCHEDULING replies — three distinct cases:

CASE 1: Prospect proposed a specific time and you need to confirm or check it:
- ALWAYS check the AVAILABLE TIMES block to see if their proposed time falls within an available range.
- If it fits: confirm in one sentence. "Tuesday at 2pm works, sending a calendar invite now."
- If it doesn't fit: don't say "that doesn't work." Instead, offer the nearest available range. "I'm tied up then — how about [nearest available range from the list]?"
- Never say "How does X work?" when they already told you X works.

CASE 2: Prospect expressed interest but did not name a specific time (e.g. "yes happy to chat", "when are you free?"):
- Pick exactly 2 slots from the AVAILABLE TIMES list that are well spread apart — ideally one from each day, or at least a few hours apart on the same day.
- Use "today" and "tomorrow" when they apply based on the current date above.
- Keep to one sentence: "How does [slot 1] or [slot 2] work?"
- If no times are provided, say you have openings in the next couple of days and ask what works for them.

CASE 3: Prospect counter-proposes a new time after seeing your suggestion:
- Treat exactly like Case 1 — check the AVAILABLE TIMES block and confirm or offer nearest alternative.

CRITICAL — NEVER HALLUCINATE TIMES:
- Only use times that appear in the AVAILABLE TIMES block.
- Do not invent times not listed there.
- If no AVAILABLE TIMES are provided, say you have openings in the next couple days and ask what works for them — do not make up specific times.

SOFT_YES replies:
- Answer the question in one sentence
- Immediately pivot to proposing a Zoom
- "Is it free?" -> "Yes, fully covered by our grant, no budget needed on your end. Want to hop on a quick Zoom to see how it works?"
- "What grade level?" -> "Grades 3-8, math. Worth a quick Zoom to show you what it looks like in class?"

REFERRED replies:
- Thank them briefly
- Ask for the name and direct email of the right contact
- "Thanks for the heads up, do you have [AP's/principal's] direct email so I can reach out?"

WRONG_PERSON replies:
- One sentence apology
- Ask who handles math curriculum or instructional decisions
- "Sorry for the confusion, do you know who handles math curriculum or instructional programs on your campus?"

SOFT_NO replies:
- Acknowledge respectfully
- One warm line leaving door open
- Do not push
- "Totally understand, hope the end of the year wraps up smoothly. Feel free to reach out if timing changes."

OOO: Do not generate a reply. Output the literal token NONE.
HARD_NO: Do not generate a reply. Output the literal token NONE.
NO_REPLY: Do not generate a reply. Output the literal token NONE.
ESCALATE: Do not generate a reply. Output the literal token NONE.

Output ONLY the reply text including the signature, OR the literal token NONE. No JSON. No commentary. No subject line.`;
}

export async function generateReply(
  payload: InstantlyWebhookPayload,
  classification: ClassificationResult,
  availableSlots?: string,
): Promise<string | null> {
  const cls = classification.classification;
  if (cls === 'OOO' || cls === 'HARD_NO' || cls === 'ESCALATE') return null;

  const { firstName: senderFirstName, signOff } = getSenderIdentity(
    payload.email_account,
  );

  const school =
    payload.School ||
    payload['School/District Nickname'] ||
    payload['District Name'] ||
    'unknown school';
  const role = payload.Role || 'unknown role';
  const prospectName =
    [payload.firstName, payload.lastName].filter(Boolean).join(' ') ||
    'the prospect';

  const slotsSection = availableSlots
    ? `\nAVAILABLE TIMES (use ONLY these ranges, never invent times):\n${availableSlots}\n`
    : '';

  const userPrompt = `Classification: ${cls}
Confidence: ${classification.confidence}
Classifier reasoning: ${classification.reasoning}
Extracted info: ${JSON.stringify(classification.extractedInfo)}
${slotsSection}
Prospect: ${prospectName}, ${role} at ${school}
Campaign: ${payload.campaign_name}

Original email we sent:
${payload.email_text || '(no original text available)'}

Their reply:
${payload.reply_text || payload.reply_text_snippet || '(empty reply)'}

Write the reply now. Output the reply text only (with signature), or the literal token NONE.`;

  const client = new Anthropic({ apiKey: env('ANTHROPIC_API_KEY') });

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 600,
      system: buildSystemPrompt(senderFirstName, signOff),
      messages: [{ role: 'user', content: userPrompt }],
    });

    const block = response.content.find((b) => b.type === 'text');
    let text = block && block.type === 'text' ? block.text.trim() : '';
    if (!text) return null;
    if (text.toUpperCase() === 'NONE') return null;

    // Strip surrounding quotes/code fences if any
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:\w+)?\s*/i, '').replace(/```$/i, '').trim();
    }

    // Defensive: remove em dashes if model slipped one in
    text = text.replace(/—/g, ',').replace(/–/g, ',');

    return text;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[replyGenerator] Anthropic call failed:', msg);
    return null;
  }
}

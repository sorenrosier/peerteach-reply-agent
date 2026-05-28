import Anthropic from '@anthropic-ai/sdk';
import { env } from './env';
import {
  ClassificationResult,
  InstantlyWebhookPayload,
  ReplyClassification,
} from './types';

const MODEL = 'claude-sonnet-4-20250514';

const VALID_CLASSIFICATIONS: ReplyClassification[] = [
  'SCHEDULING',
  'SOFT_YES',
  'REFERRED',
  'SOFT_NO',
  'HARD_NO',
  'OOO',
  'WRONG_PERSON',
  'NO_REPLY',
  'ESCALATE',
];

const SYSTEM_PROMPT = `You are classifying cold email replies for PeerTeach, a Stanford-developed math peer tutoring platform (grades 3-8) targeting school principals and site administrators.

PeerTeach context:
- Pitch: free pilot program funded by a grant, helps teachers run structured peer tutoring during class time
- Personas sending: Kreg Moccia (Co-Founder) and Katie Kaplan (team member)
- Target: K-12 principals, assistant principals, site admins, instructional coaches
- Goal: book a 20-30 min Zoom call

Classify the reply into exactly one of these categories:
- SCHEDULING: Prospect is ready to meet. Signs: "yes", "happy to", "when are you free", specific day/time offered, "sure let's chat", counter-proposing a different time
- SOFT_YES: Prospect is interested but has a question or needs more info first. Signs: questions about grade level, cost, how it works, "tell me more", "what does this look like"
- REFERRED: Prospect is redirecting to someone else WITHOUT giving a direct email address. Signs: "talk to my AP", "forward to principal", "contact [name]" (but no email given)
- SOFT_NO: Polite decline, not now, budget/fit issue. Signs: "not at this time", "we're good", "not a fit", "no budget", "too busy"
- HARD_NO: Explicit unsubscribe or removal request. Signs: "remove me", "stop emailing", "take me off your list", hostile tone
- OOO: Out of office auto-reply. Signs: mentions return date, "I am out of the office", automated response patterns
- WRONG_PERSON: Email went to wrong recipient. Signs: "I'm no longer at", "wrong email", "not the right person", no longer in that role
- NO_REPLY: Reply requires no response — the conversation has naturally concluded. Signs: "Thanks!", "Thank you!", "Got it", "Sounds good", "Perfect!", "Will do", "See you then" (after a time is already confirmed), brief acknowledgement with no question or action needed
- ESCALATE: Use this for: angry/threatening language, legal threats, RFP/vendor process mentioned, district-level superintendent or CAO (not principal-level), prospect gives a specific email address to contact someone else ("email jane@school.com"), deeply ambiguous replies, anything you're not confident about

Return ONLY valid JSON matching this schema, no other text:
{
  "classification": "SCHEDULING|SOFT_YES|REFERRED|SOFT_NO|HARD_NO|OOO|WRONG_PERSON|ESCALATE",
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation",
  "extractedInfo": {
    "proposedTimes": ["string array of any times mentioned"],
    "referralContact": "name or email if referred",
    "objection": "main objection if negative",
    "question": "main question if SOFT_YES",
    "returnDate": "return date if OOO"
  }
}`;

export async function classifyReply(
  payload: InstantlyWebhookPayload,
): Promise<ClassificationResult> {
  const client = new Anthropic({ apiKey: env('ANTHROPIC_API_KEY') });

  const school =
    payload.School ||
    payload['School/District Nickname'] ||
    payload['District Name'] ||
    'unknown school';
  const role = payload.Role || 'unknown role';
  const firstName = payload.firstName || '';
  const lastName = payload.lastName || '';

  const userPrompt = `Original email we sent:
${payload.email_text || '(no original text available)'}

Prospect reply:
${payload.reply_text || payload.reply_text_snippet || '(empty reply)'}

Prospect: ${firstName} ${lastName}, ${role} at ${school}
Campaign: ${payload.campaign_name}`;

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    const raw =
      textBlock && textBlock.type === 'text' ? textBlock.text.trim() : '';

    const parsed = safeParseJson(raw);
    if (!parsed) {
      console.error('[classifier] failed to parse JSON, raw output:', raw);
      return fallbackEscalate('Could not parse classifier output');
    }

    const cls = parsed.classification;
    if (!VALID_CLASSIFICATIONS.includes(cls)) {
      return fallbackEscalate(
        `Invalid classification value from model: ${String(cls)}`,
      );
    }

    const confidence =
      typeof parsed.confidence === 'number' && parsed.confidence >= 0 && parsed.confidence <= 1
        ? parsed.confidence
        : 0;

    if (confidence < 0.6) {
      return {
        classification: 'ESCALATE',
        confidence,
        reasoning: `Low confidence (${confidence}) from classifier; original reasoning: ${parsed.reasoning ?? 'n/a'}`,
        extractedInfo: parsed.extractedInfo ?? {},
      };
    }

    return {
      classification: cls,
      confidence,
      reasoning:
        typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
      extractedInfo: sanitizeExtractedInfo(parsed.extractedInfo),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[classifier] Anthropic call failed:', msg);
    return fallbackEscalate(`Classifier API error: ${msg}`);
  }
}

function safeParseJson(text: string): any | null {
  if (!text) return null;
  // strip code fences if present
  let t = text.trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  }
  try {
    return JSON.parse(t);
  } catch {
    // try to extract first {...} block
    const match = t.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function sanitizeExtractedInfo(
  info: any,
): ClassificationResult['extractedInfo'] {
  if (!info || typeof info !== 'object') return {};
  const out: ClassificationResult['extractedInfo'] = {};
  if (Array.isArray(info.proposedTimes)) {
    out.proposedTimes = info.proposedTimes
      .filter((s: any) => typeof s === 'string' && s.trim() !== '')
      .map((s: string) => s.trim());
  }
  if (typeof info.referralContact === 'string' && info.referralContact.trim()) {
    out.referralContact = info.referralContact.trim();
  }
  if (typeof info.objection === 'string' && info.objection.trim()) {
    out.objection = info.objection.trim();
  }
  if (typeof info.question === 'string' && info.question.trim()) {
    out.question = info.question.trim();
  }
  if (typeof info.returnDate === 'string' && info.returnDate.trim()) {
    out.returnDate = info.returnDate.trim();
  }
  return out;
}

function fallbackEscalate(reason: string): ClassificationResult {
  return {
    classification: 'ESCALATE',
    confidence: 0,
    reasoning: reason,
    extractedInfo: {},
  };
}

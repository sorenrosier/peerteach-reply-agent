import { WebClient } from '@slack/web-api';
import axios from 'axios';
import { env, envOptional } from './env';
import {
  AgentResult,
  ClassificationResult,
  InstantlyWebhookPayload,
  ReplyClassification,
  SendReplyButtonValue,
} from './types';

let _client: WebClient | null = null;
function client(): WebClient {
  if (!_client) _client = new WebClient(env('SLACK_BOT_TOKEN'));
  return _client;
}

const HEADER_BY_CLASS: Record<ReplyClassification, string> = {
  SCHEDULING: ':calendar: Scheduling — needs approval',
  SOFT_YES: ':thinking_face: Soft Yes — needs approval',
  REFERRED: ':arrow_right: Referred — needs approval',
  WRONG_PERSON: ':no_entry_sign: Wrong Person — needs approval',
  SOFT_NO: ':wave: Soft No — auto-handled',
  HARD_NO: ':no_entry: Unsubscribe request — sequence stopped',
  OOO: ':palm_tree: Out of office',
  NO_REPLY: ':white_check_mark: No reply needed',
  ESCALATE: ':rotating_light: Escalation — human review required',
};

function prospectSummary(payload: InstantlyWebhookPayload): string {
  const name =
    [payload.firstName, payload.lastName].filter(Boolean).join(' ') || '(no name)';
  const role = payload.Role || '(no role)';
  const school =
    payload.School ||
    payload['School/District Nickname'] ||
    payload['District Name'] ||
    '(no school)';
  return `*${name}* — ${role} @ ${school}\n<mailto:${payload.lead_email}|${payload.lead_email}> · Campaign: _${payload.campaign_name}_`;
}

function quoteBlock(text: string, max = 1500): string {
  const t = (text || '').trim();
  const truncated = t.length > max ? t.slice(0, max) + '…' : t;
  return truncated
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
}

function uniboxButton(payload: InstantlyWebhookPayload) {
  return {
    type: 'button',
    text: { type: 'plain_text', text: 'Open in Unibox', emoji: true },
    url: payload.unibox_url,
    action_id: 'open_unibox',
  };
}

async function postMessage(blocks: any[], fallbackText: string): Promise<string | undefined> {
  try {
    const res = await client().chat.postMessage({
      channel: env('SLACK_CHANNEL_ID'),
      text: fallbackText,
      blocks,
    });
    return res.ts as string | undefined;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[slack] postMessage failed:', msg);
    // best-effort fallback to incoming webhook if configured
    const hook = envOptional('SLACK_WEBHOOK_URL');
    if (hook) {
      try {
        await axios.post(hook, { text: fallbackText, blocks });
      } catch (e) {
        console.error(
          '[slack] webhook fallback also failed:',
          e instanceof Error ? e.message : String(e),
        );
      }
    }
    return undefined;
  }
}

export function replySubject(subject: string): string {
  const s = subject.trim();
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

// Which calendar a pending booking targets — shown on approval cards so reviewers aren't
// surprised by which calendar/inbox actually gets the meeting.
function hostLabel(host: 'katie' | 'soren'): string {
  return host === 'soren' ? "Soren's calendar" : "Katie's calendar";
}

// Human-readable booking time for the Slack approval card, in the prospect's timezone.
export function formatBookingTime(startTimeIso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
      timeZone: timezone || 'America/New_York',
    }).format(new Date(startTimeIso));
  } catch {
    return startTimeIso;
  }
}

export async function postForHumanApproval(
  payload: InstantlyWebhookPayload,
  classification: ClassificationResult,
  draftReply: string,
): Promise<void> {
  const buttonValue: SendReplyButtonValue = {
    email_id: payload.email_id,
    eaccount: payload.email_account,
    subject: replySubject(payload.reply_subject || payload.email_subject || ''),
    body_text: draftReply,
    lead_email: payload.lead_email,
    campaign_id: payload.campaign_id,
  };

  const valueStr = JSON.stringify(buttonValue);
  // Slack action value limit is 2000 chars. Truncate body if needed.
  let finalValue = valueStr;
  if (valueStr.length > 1900) {
    const overhead = valueStr.length - buttonValue.body_text.length;
    const room = 1900 - overhead - 20;
    const truncatedBody = buttonValue.body_text.slice(0, Math.max(0, room));
    finalValue = JSON.stringify({ ...buttonValue, body_text: truncatedBody });
  }

  const skipValue = JSON.stringify({
    email_id: payload.email_id,
    lead_email: payload.lead_email,
    campaign_id: payload.campaign_id,
  });

  const blocks: any[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: HEADER_BY_CLASS[classification.classification],
        emoji: true,
      },
    },
    { type: 'section', text: { type: 'mrkdwn', text: prospectSummary(payload) } },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Draft reply (from ${payload.email_account}):*\n${quoteBlock(draftReply, 2500)}`,
      },
    },
    {
      type: 'actions',
      block_id: 'reply_actions',
      elements: [
        {
          type: 'button',
          style: 'primary',
          text: { type: 'plain_text', text: ':white_check_mark: Send Reply', emoji: true },
          action_id: 'send_reply',
          value: finalValue,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: ':pencil2: Edit & Send', emoji: true },
          action_id: 'edit_send',
          value: skipValue,
          url: payload.unibox_url,
        },
        {
          type: 'button',
          style: 'danger',
          text: { type: 'plain_text', text: ':x: Skip', emoji: true },
          action_id: 'skip',
          value: skipValue,
        },
        uniboxButton(payload),
      ],
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Their reply:*\n${quoteBlock(payload.reply_text || payload.reply_text_snippet || '')}`,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Classifier confidence: *${classification.confidence.toFixed(2)}* · ${classification.reasoning}`,
        },
      ],
    },
  ];

  await postMessage(
    blocks,
    `${HEADER_BY_CLASS[classification.classification]} from ${payload.lead_email}`,
  );
}

export async function postEscalateNotification(
  payload: InstantlyWebhookPayload,
  classification: ClassificationResult,
  suggestedReply?: string,
  ccEmails?: string[],
  pendingBooking?: AgentResult['pendingBooking'],
): Promise<void> {
  const blocks: any[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: HEADER_BY_CLASS.ESCALATE, emoji: true },
    },
    { type: 'section', text: { type: 'mrkdwn', text: prospectSummary(payload) } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Full reply:*\n${quoteBlock(payload.reply_text || payload.reply_text_snippet || '', 2500)}`,
      },
    },
  ];

  const actionsElements: any[] = [];

  if (suggestedReply && suggestedReply.trim()) {
    const buttonValue: SendReplyButtonValue = {
      email_id: payload.email_id,
      eaccount: payload.email_account,
      subject: replySubject(payload.reply_subject || payload.email_subject || ''),
      body_text: suggestedReply,
      lead_email: payload.lead_email,
      campaign_id: payload.campaign_id,
      ...(ccEmails && ccEmails.length ? { cc: ccEmails } : {}),
      ...(pendingBooking ? { booking: pendingBooking } : {}),
    };
    const valueStr = JSON.stringify(buttonValue);
    let finalValue = valueStr;
    if (valueStr.length > 1900) {
      const overhead = valueStr.length - buttonValue.body_text.length;
      const room = 1900 - overhead - 20;
      finalValue = JSON.stringify({ ...buttonValue, body_text: buttonValue.body_text.slice(0, Math.max(0, room)) });
    }
    const skipValue = JSON.stringify({
      email_id: payload.email_id,
      lead_email: payload.lead_email,
      campaign_id: payload.campaign_id,
    });

    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Suggested reply (needs human review before sending):*\n${quoteBlock(suggestedReply, 2500)}` },
    });

    if (pendingBooking) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `:calendar: *Will book on Send (${hostLabel(pendingBooking.host)}):* ${formatBookingTime(pendingBooking.startTime, pendingBooking.timezone)}${pendingBooking.guests.length ? `  ·  guests: ${pendingBooking.guests.join(', ')}` : ''}` }],
      });
    }

    if (ccEmails && ccEmails.length) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `:link: *Will cc on Send:* ${ccEmails.join(', ')}` }],
      });
    }

    actionsElements.push(
      {
        type: 'button',
        style: 'primary',
        text: { type: 'plain_text', text: ':white_check_mark: Send Reply', emoji: true },
        action_id: 'send_reply',
        value: finalValue,
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: ':pencil2: Edit & Send', emoji: true },
        action_id: 'edit_send',
        value: skipValue,
        url: payload.unibox_url,
      },
      {
        type: 'button',
        style: 'danger',
        text: { type: 'plain_text', text: ':x: Skip', emoji: true },
        action_id: 'skip',
        value: skipValue,
      },
    );
  }

  actionsElements.push(uniboxButton(payload));

  blocks.push(
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Why: ${classification.reasoning} (confidence ${classification.confidence.toFixed(2)})`,
        },
      ],
    },
    { type: 'actions', elements: actionsElements },
  );

  await postMessage(blocks, `Escalation from ${payload.lead_email}`);
}

export async function postSoftNoNotification(
  payload: InstantlyWebhookPayload,
  autoReplySent: string,
): Promise<void> {
  const blocks: any[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: HEADER_BY_CLASS.SOFT_NO, emoji: true },
    },
    { type: 'section', text: { type: 'mrkdwn', text: prospectSummary(payload) } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Their reply:*\n${quoteBlock(payload.reply_text_snippet || payload.reply_text || '', 600)}`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Auto-reply sent:*\n${quoteBlock(autoReplySent, 600)}`,
      },
    },
    { type: 'actions', elements: [uniboxButton(payload)] },
  ];
  await postMessage(blocks, `Soft No auto-handled: ${payload.lead_email}`);
}

export async function postHardNoNotification(
  payload: InstantlyWebhookPayload,
): Promise<void> {
  const blocks: any[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: HEADER_BY_CLASS.HARD_NO, emoji: true },
    },
    { type: 'section', text: { type: 'mrkdwn', text: prospectSummary(payload) } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Their reply:*\n${quoteBlock(payload.reply_text_snippet || payload.reply_text || '', 600)}`,
      },
    },
    { type: 'actions', elements: [uniboxButton(payload)] },
  ];
  await postMessage(blocks, `Unsubscribe: ${payload.lead_email}`);
}

export async function postAutoBookedNotification(
  payload: InstantlyWebhookPayload,
  bookedTime: string,
): Promise<void> {
  const blocks: any[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: ':date: Auto-booked', emoji: true },
    },
    { type: 'section', text: { type: 'mrkdwn', text: prospectSummary(payload) } },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `Booked for *${bookedTime}*` },
    },
    { type: 'actions', elements: [uniboxButton(payload)] },
  ];
  await postMessage(blocks, `Auto-booked ${payload.lead_email} at ${bookedTime}`);
}

export async function postErrorNotification(
  payload: InstantlyWebhookPayload,
  error: unknown,
  context: string,
): Promise<void> {
  const msg = error instanceof Error ? error.message : String(error);
  const blocks: any[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: ':warning: Reply agent error', emoji: true },
    },
    { type: 'section', text: { type: 'mrkdwn', text: prospectSummary(payload) } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Context:* ${context}\n*Error:* \`${msg.slice(0, 1500)}\``,
      },
    },
    { type: 'actions', elements: [uniboxButton(payload)] },
  ];
  await postMessage(blocks, `Reply agent error: ${context}`);
}

// Posts an agent-generated draft for human approval.
export async function postAgentDraft(
  payload: InstantlyWebhookPayload,
  result: AgentResult,
): Promise<void> {
  const draft = result.draft ?? '';
  const header = result.booked
    ? ':calendar: Reply ready — books the meeting when you click Send'
    : ':pencil2: Draft reply — needs approval';

  const buttonValue: SendReplyButtonValue = {
    email_id: payload.email_id,
    eaccount: payload.email_account,
    subject: replySubject(payload.reply_subject || payload.email_subject || ''),
    body_text: draft,
    lead_email: payload.lead_email,
    campaign_id: payload.campaign_id,
    ...(result.ccEmails && result.ccEmails.length ? { cc: result.ccEmails } : {}),
    ...(result.pendingBooking ? { booking: result.pendingBooking } : {}),
  };
  const valueStr = JSON.stringify(buttonValue);
  let finalValue = valueStr;
  if (valueStr.length > 1900) {
    const overhead = valueStr.length - buttonValue.body_text.length;
    const room = 1900 - overhead - 20;
    finalValue = JSON.stringify({ ...buttonValue, body_text: buttonValue.body_text.slice(0, Math.max(0, room)) });
  }
  const skipValue = JSON.stringify({
    email_id: payload.email_id,
    lead_email: payload.lead_email,
    campaign_id: payload.campaign_id,
  });
  // Edit & Send carries the booking flag so the handler can warn that the meeting
  // isn't booked yet (it does not auto-book — the human may change the time).
  const editValue = JSON.stringify({
    email_id: payload.email_id,
    lead_email: payload.lead_email,
    campaign_id: payload.campaign_id,
    ...(result.ccEmails && result.ccEmails.length ? { cc: result.ccEmails } : {}),
    ...(result.pendingBooking ? { booking: result.pendingBooking } : {}),
  });

  const blocks: any[] = [
    { type: 'header', text: { type: 'plain_text', text: header, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: prospectSummary(payload) } },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Draft reply (from ${payload.email_account}):*\n${quoteBlock(draft, 2500)}` },
    },
    ...(result.booked && result.pendingBooking ? [{
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `:calendar: *Will book on Send (${hostLabel(result.pendingBooking.host)}):* ${formatBookingTime(result.pendingBooking.startTime, result.pendingBooking.timezone)}${result.pendingBooking.guests.length ? `  ·  guests: ${result.pendingBooking.guests.join(', ')}` : ''}` }],
    }] : []),
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Their reply:*\n${quoteBlock(payload.reply_text || payload.reply_text_snippet || '')}` },
    },
    {
      type: 'actions',
      block_id: 'reply_actions',
      elements: [
        {
          type: 'button',
          style: 'primary',
          text: { type: 'plain_text', text: ':white_check_mark: Send Reply', emoji: true },
          action_id: 'send_reply',
          value: finalValue,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: ':pencil2: Edit & Send', emoji: true },
          action_id: 'edit_send',
          value: editValue,
          url: payload.unibox_url,
        },
        {
          type: 'button',
          style: 'danger',
          text: { type: 'plain_text', text: ':x: Skip', emoji: true },
          action_id: 'skip',
          value: skipValue,
        },
        uniboxButton(payload),
      ],
    },
  ];

  await postMessage(blocks, `${header} from ${payload.lead_email}`);
}

// Posts an informational (no buttons) notice for a draft that was sent automatically,
// with no human review. Kept visually distinct from postAgentDraft's approval cards, and
// uses the same ":white_check_mark: Reply sent" style phrasing conventions elsewhere in
// this file so historical Slack-history analysis keeps working the same way.
export async function postAutoSentNotification(
  payload: InstantlyWebhookPayload,
  result: AgentResult,
): Promise<void> {
  const draft = result.draft ?? '';
  const header = result.booked
    ? ':zap: Auto-sent — meeting booked (no human review)'
    : ':zap: Auto-sent (no human review)';

  const blocks: any[] = [
    { type: 'header', text: { type: 'plain_text', text: header, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: prospectSummary(payload) } },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Sent (from ${payload.email_account}):*\n${quoteBlock(draft, 2500)}` },
    },
    ...(result.ccEmails && result.ccEmails.length ? [{
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `:link: *Cc:* ${result.ccEmails.join(', ')}` }],
    }] : []),
    ...(result.booked && result.pendingBooking ? [{
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `:calendar: *Booked (${hostLabel(result.pendingBooking.host)}):* ${formatBookingTime(result.pendingBooking.startTime, result.pendingBooking.timezone)}${result.pendingBooking.guests.length ? `  ·  guests: ${result.pendingBooking.guests.join(', ')}` : ''}` }],
    }] : []),
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Their reply:*\n${quoteBlock(payload.reply_text || payload.reply_text_snippet || '')}` },
    },
    { type: 'actions', elements: [uniboxButton(payload)] },
  ];

  await postMessage(blocks, `${header} to ${payload.lead_email}`);
}

// Update an existing message via response_url (used by slack-action handler).
export async function updateViaResponseUrl(
  responseUrl: string,
  text: string,
  blocks?: any[],
): Promise<void> {
  try {
    await axios.post(responseUrl, {
      replace_original: true,
      text,
      blocks: blocks ?? [
        { type: 'section', text: { type: 'mrkdwn', text } },
      ],
    });
  } catch (err) {
    console.error(
      '[slack] response_url update failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

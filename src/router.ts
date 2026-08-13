import { runAgent, AgentResult, computeGuestEmails } from './agent';
import { replyToEmail, fetchEmailThread } from './instantly';
import { bookMeeting } from './calendly';
import { deleteHoldsForLead } from './googleCalendar';
import { envOptional, isAutoSendEnabled } from './env';
import {
  postAgentDraft,
  postAutoSentNotification,
  postEscalateNotification,
  postErrorNotification,
  postHardNoNotification,
  replySubject,
} from './slack';
import { InstantlyWebhookPayload } from './types';

// Books the meeting (if any) and sends the reply for a non-escalated draft with no human
// review. Mirrors what a human clicking "Send Reply" in Slack does — including releasing
// our own tentative hold BEFORE booking, since Calendly would otherwise reject the real
// booking as conflicting with our own placeholder (see api/slack-action.ts for the same
// fix on the human-click path).
async function autoSendDraft(payload: InstantlyWebhookPayload, result: AgentResult): Promise<void> {
  if (result.pendingBooking) {
    if (envOptional('GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON')) {
      try {
        await deleteHoldsForLead(payload.lead_email, payload.campaign_id);
      } catch (err) {
        console.warn('[router] autoSendDraft: deleteHoldsForLead failed:', err instanceof Error ? err.message : String(err));
      }
    }
    try {
      await bookMeeting({
        startTime: result.pendingBooking.startTime,
        name: result.pendingBooking.name,
        email: result.pendingBooking.email,
        timezone: result.pendingBooking.timezone,
        guests: result.pendingBooking.guests,
      });
      console.log('[router] autoSendDraft: booked', result.pendingBooking.startTime);
    } catch (err) {
      // Slot may no longer be available — do NOT send the confirmation. Escalate with
      // the drafted text still attached so a human can pick up from here.
      await postEscalateNotification(
        payload,
        {
          classification: 'ESCALATE',
          confidence: 0,
          reasoning: `Auto-send: booking failed (${err instanceof Error ? err.message : String(err)}). Slot may no longer be available — handle manually.`,
          extractedInfo: {},
        },
        result.draft,
      );
      return;
    }
  }

  try {
    await replyToEmail({
      reply_to_uuid: payload.email_id,
      eaccount: payload.email_account,
      subject: replySubject(payload.reply_subject || payload.email_subject || ''),
      body: { text: result.draft! },
      cc: result.ccEmails,
    });
    console.log('[router] autoSendDraft: reply sent to', payload.lead_email, result.ccEmails?.length ? `cc: ${result.ccEmails.join(', ')}` : '');
  } catch (err) {
    await postErrorNotification(payload, err, 'autoSendDraft: replyToEmail failed');
    return;
  }

  await postAutoSentNotification(payload, result);
}

export async function routeReply(payload: InstantlyWebhookPayload): Promise<void> {
  console.log(`[router] lead=${payload.lead_email} campaign=${payload.campaign_id}`);

  // A new reply means any calendar holds from prior offers to this lead are now stale —
  // whatever they said (confirmed a time, asked for different times, or something else
  // entirely), clear them before the agent decides what's next. Fails open.
  if (envOptional('GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON')) {
    try {
      await deleteHoldsForLead(payload.lead_email, payload.campaign_id);
    } catch (err) {
      console.warn('[router] deleteHoldsForLead failed:', err instanceof Error ? err.message : String(err));
    }
  }

  // Fetch full email thread for context. Falls back to empty array on failure.
  const thread = await fetchEmailThread(payload.campaign_id, payload.lead_email);
  console.log(`[router] thread emails fetched: ${thread.length}`);

  let result;
  try {
    result = await runAgent(payload, thread);
  } catch (err) {
    console.error('[router] agent threw:', err instanceof Error ? err.stack : String(err));
    try {
      await postErrorNotification(
        payload,
        err,
        'runAgent',
      );
    } catch {}
    return;
  }

  console.log(`[router] agent action=${result.action} booked=${result.booked ?? false}`);

  // Deterministic safety net: until CC/loop-in handling is fully validated in production,
  // force human review for ANY reply where someone besides us and the primary lead is on
  // the thread — regardless of what the model decided. Detection is code-based (thread
  // to/cc data via computeGuestEmails), not left to the model, since misjudging exactly
  // this situation is what caused a real incident (wrong-recipient reply, asking for a
  // contact who was already on the thread).
  if (result.action === 'draft' && result.draft) {
    const loopedIn = computeGuestEmails(thread, payload);
    if (loopedIn.length > 0) {
      console.log(`[router] loop-in detected (${loopedIn.join(', ')}) — forcing escalation`);
      const forcedEscalation: AgentResult = {
        action: 'escalate',
        reason: `Loop-in detected on thread (${loopedIn.join(', ')}) — escalating for human review until CC handling is fully validated.`,
        draft: result.draft,
        ccEmails: loopedIn,
      };
      result = forcedEscalation;
    }
  }

  try {
    switch (result.action) {
      case 'no_reply':
        console.log(`[router] no_reply — silent`);
        return;

      case 'ooo':
        console.log(`[router] ooo return=${result.returnDate ?? 'unknown'}`);
        return;

      case 'hard_no':
        await postHardNoNotification(payload);
        return;

      case 'escalate':
        await postEscalateNotification(
          payload,
          {
            classification: 'ESCALATE',
            confidence: 0,
            reasoning: result.reason ?? 'Agent escalated',
            extractedInfo: {},
          },
          result.draft,
          result.ccEmails,
        );
        return;

      case 'draft':
        if (!result.draft) {
          await postEscalateNotification(payload, {
            classification: 'ESCALATE',
            confidence: 0,
            reasoning: 'Agent returned empty draft',
            extractedInfo: {},
          });
          return;
        }
        if (isAutoSendEnabled()) {
          await autoSendDraft(payload, result);
          return;
        }
        await postAgentDraft(payload, result);
        return;
    }
  } catch (err) {
    console.error('[router] unhandled error routing result:', err instanceof Error ? err.stack : String(err));
    try {
      await postErrorNotification(payload, err, 'routeReply');
    } catch {}
  }
}

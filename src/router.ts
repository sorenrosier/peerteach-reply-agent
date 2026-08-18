import { runAgent, AgentResult, computeGuestEmails, getBookingHost } from './agent';
import { replyToEmail, fetchEmailThread } from './instantly';
import { bookMeeting } from './calendly';
import { bookSorenMeeting } from './sorenBooking';
import { deleteHoldsForLead, hasExistingHold } from './googleCalendar';
import { envOptional, isAutoSendEnabled, isSorenBookingEnabled, SOREN_EMAIL } from './env';
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
        await deleteHoldsForLead(payload.lead_email, payload.campaign_id, result.pendingBooking.host === 'soren' ? SOREN_EMAIL : undefined);
      } catch (err) {
        console.warn('[router] autoSendDraft: deleteHoldsForLead failed:', err instanceof Error ? err.message : String(err));
      }
    }
    try {
      if (result.pendingBooking.host === 'soren') {
        await bookSorenMeeting({
          startTime: result.pendingBooking.startTime,
          name: result.pendingBooking.name,
          email: result.pendingBooking.email,
          guests: result.pendingBooking.guests,
        });
      } else {
        await bookMeeting({
          startTime: result.pendingBooking.startTime,
          name: result.pendingBooking.name,
          email: result.pendingBooking.email,
          timezone: result.pendingBooking.timezone,
          guests: result.pendingBooking.guests,
        });
      }
      console.log('[router] autoSendDraft: booked', result.pendingBooking.startTime, `(host=${result.pendingBooking.host})`);
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

  // Whether this lead already has an active hold on Soren's calendar — checked BEFORE the
  // stale-hold cleanup below wipes it out. This is what lets an already-in-flight
  // conversation finish even when Soren isn't accepting new bookings (SOREN_BOOKING_ENABLED
  // off): no manual exception list to maintain, it just naturally covers whoever's
  // mid-negotiation and stops applying once their hold is used or expires.
  let hadSorenHold = false;
  if (envOptional('GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON')) {
    hadSorenHold = await hasExistingHold(payload.lead_email, payload.campaign_id, SOREN_EMAIL);
  }

  // A new reply means any calendar holds from prior offers to this lead are now stale —
  // whatever they said (confirmed a time, asked for different times, or something else
  // entirely), clear them before the agent decides what's next. Fails open. Cleared on
  // both calendars since which one a prior message landed on isn't known yet here.
  if (envOptional('GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON')) {
    try {
      await deleteHoldsForLead(payload.lead_email, payload.campaign_id);
      await deleteHoldsForLead(payload.lead_email, payload.campaign_id, SOREN_EMAIL);
    } catch (err) {
      console.warn('[router] deleteHoldsForLead failed:', err instanceof Error ? err.message : String(err));
    }
  }

  // Fetch full email thread for context. Falls back to empty array on failure.
  const thread = await fetchEmailThread(payload.campaign_id, payload.lead_email);
  console.log(`[router] thread emails fetched: ${thread.length}`);

  let result;
  try {
    result = await runAgent(payload, thread, {}, hadSorenHold);
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
      let reason = `Loop-in detected on thread (${loopedIn.join(', ')}) — escalating for human review until CC handling is fully validated.`;

      // If a booking is about to happen, call out specifically whether the chosen
      // Calendly invitee actually matches who's been corresponding — this exact mismatch
      // (booked under the original cold-email contact instead of whoever actually took
      // over and confirmed) has already caused a real no-show.
      if (result.pendingBooking) {
        const latestInbound = [...thread].reverse().find((e) => !e.isOutbound);
        const activeSender = (latestInbound?.from || '').toLowerCase().trim();
        const bookedEmail = result.pendingBooking.email.toLowerCase().trim();
        if (activeSender && activeSender !== bookedEmail) {
          reason = `BOOKING IDENTITY CHECK: about to book the meeting under ${bookedEmail}, but the most recent message on this thread came from ${activeSender} — confirm this is the right person before sending, or the invite/reminders will go to the wrong contact. (${reason})`;
        }
      }

      console.log(`[router] loop-in detected (${loopedIn.join(', ')}) — forcing escalation`);
      const forcedEscalation: AgentResult = {
        action: 'escalate',
        reason,
        draft: result.draft,
        ccEmails: loopedIn,
        // Preserve the prepared booking so a human clicking Send on the escalated card
        // still actually books the meeting, rather than sending a confirmation for
        // nothing — dropping this here was a real bug found in a later audit.
        pendingBooking: result.pendingBooking,
      };
      result = forcedEscalation;
    }
  }

  // Deterministic: Kreg's and Soren's inbox threads book onto Soren's calendar (not
  // Katie's), but only while he's actually accepting bookings this week — or this specific
  // lead already had a hold on his calendar (an already-in-flight conversation, allowed to
  // finish). With the toggle off and no existing hold, there is no valid calendar to
  // schedule against for these inboxes — Katie is intentionally excluded as a fallback —
  // so force human review rather than letting the model improvise or a confusing tool
  // response happen.
  if (result.action === 'draft' && result.draft) {
    if (getBookingHost(payload.email_account) === 'soren' && !isSorenBookingEnabled() && !hadSorenHold) {
      console.log('[router] Soren-booking is off and this thread routes to his calendar — forcing escalation');
      const forced: AgentResult = {
        action: 'escalate',
        reason: 'Soren is not accepting new bookings this week (SOREN_BOOKING_ENABLED is off) and this lead had no existing hold on his calendar — this inbox routes to his calendar, not Katie\'s, so it needs manual scheduling until he turns it back on.',
        draft: result.draft,
        ccEmails: result.ccEmails,
        pendingBooking: result.pendingBooking,
      };
      result = forced;
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
          result.pendingBooking,
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

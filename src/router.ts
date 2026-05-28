import { classifyReply } from './classifier';
import { generateReply } from './replyGenerator';
import {
  markLeadInterested,
  replyToEmail,
} from './instantly';
import {
  postAutoBookedNotification,
  postEscalateNotification,
  postErrorNotification,
  postForHumanApproval,
  postHardNoNotification,
} from './slack';
import { isAutoBookEnabled } from './env';
import { ClassificationResult, InstantlyWebhookPayload } from './types';
import { createAppointment, getFreeSlots, getAvailableSlotsForReply, upsertContact } from './ghl';

export async function routeReply(
  payload: InstantlyWebhookPayload,
): Promise<void> {
  let classification: ClassificationResult;
  try {
    classification = await classifyReply(payload);
  } catch (err) {
    console.error(
      '[router] classifier threw, escalating',
      err instanceof Error ? err.stack : String(err),
    );
    classification = {
      classification: 'ESCALATE',
      confidence: 0,
      reasoning: `Classifier failed: ${err instanceof Error ? err.message : String(err)}`,
      extractedInfo: {},
    };
  }

  console.log(
    `[router] lead=${payload.lead_email} campaign=${payload.campaign_id} classification=${classification.classification} confidence=${classification.confidence}`,
  );

  try {
    switch (classification.classification) {
      case 'OOO':
        console.log(
          `[router] OOO from ${payload.lead_email}, return: ${classification.extractedInfo.returnDate ?? 'unknown'}`,
        );
        return;

      case 'NO_REPLY':
        console.log(`[router] NO_REPLY from ${payload.lead_email}, no action needed`);
        return;

      case 'HARD_NO':
        await postHardNoNotification(payload);
        return;

      case 'SOFT_NO': {
        const reply = await generateReply(payload, classification);
        if (!reply) {
          await postEscalateNotification(payload, classification);
          return;
        }
        await postForHumanApproval(payload, classification, reply);
        return;
      }

      case 'ESCALATE':
        await postEscalateNotification(payload, classification);
        return;

      case 'REFERRED': {
        // If prospect gave a direct email to contact, escalate to human instead of auto-drafting.
        const referral = classification.extractedInfo.referralContact ?? '';
        if (referral.includes('@')) {
          await postEscalateNotification(payload, {
            ...classification,
            reasoning: `Prospect gave a direct email to contact: ${referral}. Handle manually.`,
          });
          return;
        }
        const referredDraft = await generateReply(payload, classification);
        if (!referredDraft) {
          await postEscalateNotification(payload, classification);
          return;
        }
        await postForHumanApproval(payload, classification, referredDraft);
        return;
      }

      case 'WRONG_PERSON':
        await postEscalateNotification(payload, {
          ...classification,
          reasoning: `Wrong person — needs manual handling. ${classification.reasoning}`,
        });
        return;

      case 'SCHEDULING':
      case 'SOFT_YES': {
        if (
          isAutoBookEnabled() &&
          classification.classification === 'SCHEDULING'
        ) {
          await handleAutoBook(payload, classification);
          return;
        }
        // For SCHEDULING, always fetch real calendar availability so the draft uses actual open times.
        let availableSlots: string | undefined;
        if (classification.classification === 'SCHEDULING') {
          const slots = await getAvailableSlotsForReply().catch((e) => {
            console.warn('[router] getAvailableSlotsForReply failed, proceeding without slots:', e?.message);
            return null;
          });
          console.log('[router] GHL availability block fetched:', slots ? 'yes' : 'none');
          console.log('[router] availability:\n', slots);
          availableSlots = slots ?? undefined;
        }
        console.log('[router] availableSlots passed to generateReply:', availableSlots ?? 'none');
        const draft = await generateReply(payload, classification, availableSlots);
        if (!draft) {
          await postEscalateNotification(payload, classification);
          return;
        }
        await postForHumanApproval(payload, classification, draft);
        return;
      }
    }
  } catch (err) {
    console.error(
      '[router] unhandled error in route',
      err instanceof Error ? err.stack : String(err),
    );
    try {
      await postErrorNotification(payload, err, 'routeReply');
    } catch (e) {
      console.error('[router] failed to post error notification', e);
    }
  }
}


// ===== DORMANT BRANCH =====
// This function only runs when AUTO_BOOK_ENABLED === 'true' and classification is SCHEDULING.
// On any failure, escalates to human via Slack instead of replying.

async function handleAutoBook(
  payload: InstantlyWebhookPayload,
  classification: ClassificationResult,
): Promise<void> {
  const calendarId = process.env.GHL_CALENDAR_ID!;
  const locationId = process.env.GHL_LOCATION_ID!;

  try {
    const now = new Date();
    const start = now.toISOString();
    const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const timezone =
      Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Los_Angeles';

    const slots = await getFreeSlots({
      calendarId,
      startDate: start,
      endDate: end,
      timezone,
    });
    if (slots.length === 0) {
      console.warn('[autoBook] no free slots, escalating');
      await postEscalateNotification(payload, classification);
      return;
    }

    const proposed = classification.extractedInfo.proposedTimes ?? [];
    const chosen = pickSlot(slots, proposed);

    const contactId = await upsertContact({
      email: payload.lead_email,
      firstName: payload.firstName || '',
      lastName: payload.lastName || '',
      locationId,
      customFields: {
        instantly_campaign: payload.campaign_name,
        school:
          payload.School ||
          payload['School/District Nickname'] ||
          payload['District Name'] ||
          '',
        role: payload.Role || '',
      },
    });

    await createAppointment({
      calendarId,
      locationId,
      contactId,
      startTime: chosen.startTime,
      endTime: chosen.endTime,
      title: `PeerTeach intro — ${payload.firstName ?? ''} ${payload.lastName ?? ''}`.trim(),
      notes: `Auto-booked from cold email reply via Instantly campaign "${payload.campaign_name}".`,
    });

    const friendlyTime = new Date(chosen.startTime).toLocaleString('en-US', {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    });

    const senderFirst = payload.email_account.toLowerCase().includes('kreg')
      ? 'Kreg'
      : 'Katie';
    const signOff =
      senderFirst === 'Kreg'
        ? 'Kreg\nCo-Founder, PeerTeach'
        : 'Katie\nPeerTeach';

    const replyText = `Booked you for ${friendlyTime}. Calendar invite with the Zoom link is on its way. Anything you want me to come prepared with?\n\n${signOff}`;

    await replyToEmail({
      reply_to_uuid: payload.email_id,
      eaccount: payload.email_account,
      subject: `Re: ${payload.reply_subject || payload.email_subject || ''}`,
      body: { text: replyText },
    });

    await markLeadInterested(payload.campaign_id, payload.lead_email).catch(
      (e) => console.error('[autoBook] markLeadInterested failed', e),
    );

    await postAutoBookedNotification(payload, friendlyTime);
  } catch (err) {
    console.error(
      '[autoBook] failed, escalating:',
      err instanceof Error ? err.stack : String(err),
    );
    await postErrorNotification(payload, err, 'handleAutoBook (GHL)');
    await postEscalateNotification(payload, classification);
  }
}

function pickSlot(
  slots: Array<{ startTime: string; endTime: string }>,
  proposedTimes: string[],
): { startTime: string; endTime: string } {
  if (proposedTimes.length === 0) return slots[0];
  // Try to match: parse each proposed time loosely, find nearest slot.
  for (const proposed of proposedTimes) {
    const parsed = Date.parse(proposed);
    if (!Number.isFinite(parsed)) continue;
    let best = slots[0];
    let bestDelta = Math.abs(new Date(best.startTime).getTime() - parsed);
    for (const s of slots) {
      const d = Math.abs(new Date(s.startTime).getTime() - parsed);
      if (d < bestDelta) {
        best = s;
        bestDelta = d;
      }
    }
    return best;
  }
  return slots[0];
}

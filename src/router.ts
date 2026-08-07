import { runAgent } from './agent';
import { replyToEmail, fetchEmailThread } from './instantly';
import { deleteHoldsForLead } from './googleCalendar';
import { envOptional } from './env';
import {
  postAgentDraft,
  postEscalateNotification,
  postErrorNotification,
  postHardNoNotification,
} from './slack';
import { InstantlyWebhookPayload } from './types';

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

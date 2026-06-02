import { runAgent } from './agent';
import { replyToEmail, fetchEmailThread } from './instantly';
import {
  postAgentDraft,
  postEscalateNotification,
  postErrorNotification,
  postHardNoNotification,
} from './slack';
import { InstantlyWebhookPayload } from './types';

export async function routeReply(payload: InstantlyWebhookPayload): Promise<void> {
  console.log(`[router] lead=${payload.lead_email} campaign=${payload.campaign_id}`);

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
        await postEscalateNotification(payload, {
          classification: 'ESCALATE',
          confidence: 0,
          reasoning: result.reason ?? 'Agent escalated',
          extractedInfo: {},
        });
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

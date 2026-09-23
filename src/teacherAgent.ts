import { InstantlyWebhookPayload } from './types';
import { postEscalateNotification } from './slack';

// PLACEHOLDER — the real teacher-facing conversation system (full back-and-forth over email
// driving a self-serve trial, distinct from the admin/principal system's demo-booking flow)
// is intentionally not built here. This just exists so the campaign-based branch in
// router.ts has somewhere real to go the moment a teacher-outreach campaign's id gets added
// to TEACHER_CAMPAIGN_IDS, instead of silently doing nothing.
//
// Every reply on a teacher campaign gets escalated to Slack for manual handling until this
// is built out — same "fail toward a human, not toward silence" posture this codebase uses
// everywhere else for anything not yet trusted to run on its own (see AUTO_SEND_ENABLED,
// REMINDER_AUTO_SEND_ENABLED).
export async function routeTeacherReply(payload: InstantlyWebhookPayload): Promise<void> {
  console.log(`[teacherAgent] placeholder — escalating lead=${payload.lead_email} campaign=${payload.campaign_id}`);
  await postEscalateNotification(payload, {
    classification: 'ESCALATE',
    confidence: 0,
    reasoning: 'Teacher-campaign lead — the teacher-facing response system is not built yet (this campaign_id is in TEACHER_CAMPAIGN_IDS). Handle manually for now.',
    extractedInfo: {},
  });
}

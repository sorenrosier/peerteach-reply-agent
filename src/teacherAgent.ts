import { InstantlyWebhookPayload } from './types';
import { postEscalateNotification } from './slack';

// PLACEHOLDER — the real teacher-facing conversation system (full back-and-forth over email
// driving a self-serve trial, distinct from the admin/principal system's demo-booking flow)
// is intentionally not built here. This just exists so router.ts's persona-based branch
// (classifyAudience(payload) === 'teacher') has somewhere real to go, instead of silently
// doing nothing, while the real system is being built.
//
// Every reply classified as a teacher gets escalated to Slack for manual handling until this
// is built out — same "fail toward a human, not toward silence" posture this codebase uses
// everywhere else for anything not yet trusted to run on its own (see AUTO_SEND_ENABLED,
// REMINDER_AUTO_SEND_ENABLED).
export async function routeTeacherReply(payload: InstantlyWebhookPayload): Promise<void> {
  console.log(`[teacherAgent] placeholder — escalating lead=${payload.lead_email} campaign=${payload.campaign_id}`);
  await postEscalateNotification(payload, {
    classification: 'ESCALATE',
    confidence: 0,
    reasoning: 'Teacher-persona lead — the teacher-facing response system is not built yet. Handle manually for now.',
    extractedInfo: {},
  });
}

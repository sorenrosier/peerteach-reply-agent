// Centralized env validation. Required vars throw on access if missing.

const REQUIRED_VARS = [
  'INSTANTLY_API_KEY',
  'ANTHROPIC_API_KEY',
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
  'SLACK_CHANNEL_ID',
] as const;

const OPTIONAL_VARS = [
  'SLACK_WEBHOOK_URL',
  'GHL_API_KEY',
  'GHL_CALENDAR_ID',
  'GHL_LOCATION_ID',
  'WEBHOOK_SECRET',
  'AUTO_BOOK_ENABLED',
  'BASE_URL',
  'CALENDLY_API_KEY',
  'CALENDLY_EVENT_TYPE_URI',
  'CALENDLY_LOCATION_URL',
  'GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON',
  'CALENDAR_IMPERSONATE_EMAIL',
  'MAX_CONSECUTIVE_MEETINGS',
  'MEETING_BREAK_MINUTES',
  'HOLD_TTL_HOURS',
  'CRON_SECRET',
  'AUTO_SEND_ENABLED',
  'SOREN_BOOKING_ENABLED',
  'REMINDER_AUTO_SEND_ENABLED',
  'NEW_RULE_EMAILS_AUTO_SEND_ENABLED',
  'KATIE_SINGLE_TIME_OFFER_ENABLED',
  'TEACHER_AUTO_SEND_ENABLED',
  // Demo-link nudges send automatically unless this is 'false' (then they go to Slack for approval).
  'TEACHER_NUDGE_AUTO_SEND',
  // Close CRM sync of booked calls (src/closeSync.ts). Writes only when CLOSE_SYNC_MODE=live.
  'CLOSE_API_KEY',
  'CLOSE_SYNC_MODE',
  'PEERTEACH_ADMIN_TOKEN',
  'PEERTEACH_API_URL',
] as const;

// Soren's own calendar is booked directly via Google Calendar (no separate Calendly
// account for him) — impersonated through the same domain-wide-delegation service
// account already used for Katie's calendar, just with a different `sub` email.
export const SOREN_EMAIL = 'soren@peerteach.org';
// He only takes calls in this window, in his own local time (ET).
export const SOREN_WORKING_HOURS_ET = { startHour: 12, endHour: 18 };
// His personal Zoom room — every meeting booked onto his calendar uses this, not an
// auto-generated Google Meet link.
export const SOREN_ZOOM_URL = 'https://us06web.zoom.us/j/6388859556?pwd=Pimuxq3bTVo8aQr2dVuK2EIWWqYR7y.1';
// Katie's own public Calendly page (same event type CALENDLY_EVENT_TYPE_URI already
// manages) — offered as a self-service fallback when a single proposed time doesn't work,
// so a prospect can pick something from her real live availability without another
// back-and-forth. Deliberately the same event type as our own booking flow, not a separate
// one, so it stays simple and anything self-booked here still shows up as busy time the
// next time we compute availability.
export const CALENDLY_SCHEDULING_URL = 'https://calendly.com/katie-peerteach/new-meeting';
// Teachers get Katie's longer "PeerTeach Launch Call" (40 minutes): Katie expects teachers to
// need more time than principals (2026-11-13). Same calendar, so bookings show up the same way.
export const TEACHER_CALENDLY_URL = 'https://calendly.com/katie-peerteach/peerteach-launch-call';

type RequiredVar = (typeof REQUIRED_VARS)[number];
type OptionalVar = (typeof OPTIONAL_VARS)[number];

let validated = false;

export function validateEnv(): void {
  if (validated) return;
  const missing: string[] = [];
  for (const k of REQUIRED_VARS) {
    if (!process.env[k] || process.env[k]!.trim() === '') {
      missing.push(k);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        `Set these in your Vercel project settings or .env file.`,
    );
  }
  // If AUTO_BOOK_ENABLED is true, GHL vars become required.
  if (process.env.AUTO_BOOK_ENABLED === 'true') {
    const ghlMissing: string[] = [];
    for (const k of ['GHL_API_KEY', 'GHL_CALENDAR_ID', 'GHL_LOCATION_ID'] as const) {
      if (!process.env[k] || process.env[k]!.trim() === '') ghlMissing.push(k);
    }
    if (ghlMissing.length > 0) {
      throw new Error(
        `AUTO_BOOK_ENABLED=true but missing GHL vars: ${ghlMissing.join(', ')}`,
      );
    }
  }
  validated = true;
}

export function env(key: RequiredVar): string {
  validateEnv();
  return process.env[key] as string;
}

export function envOptional(key: OptionalVar): string | undefined {
  const v = process.env[key];
  if (!v || v.trim() === '') return undefined;
  return v;
}

export function isAutoBookEnabled(): boolean {
  return process.env.AUTO_BOOK_ENABLED === 'true';
}

// Kill switch for auto-sending non-escalated drafts without human review. Flip to
// 'false' in Vercel env vars and redeploy to revert to posting drafts in Slack for
// approval instead — Vercel bakes env values into each deployment, so a plain env
// var change alone won't affect already-running functions until the next deploy.
export function isAutoSendEnabled(): boolean {
  return process.env.AUTO_SEND_ENABLED === 'true';
}

// Manual weekly on/off switch for booking meetings onto Soren's own calendar. Soren
// flips this himself (Vercel env var + redeploy) for the week(s) he wants to take
// meetings — defaults to off, and stays off until he explicitly turns it back on.
export function isSorenBookingEnabled(): boolean {
  return process.env.SOREN_BOOKING_ENABLED === 'true';
}

// Demo-call reminder emails (Soren's calendar only — see reminders.ts) default to posting
// in Slack for approval rather than auto-sending, so the first batch of real reminders can
// be checked by a human before trusting the pipeline. Flip to 'true' once validated.
export function isReminderAutoSendEnabled(): boolean {
  return process.env.REMINDER_AUTO_SEND_ENABLED === 'true';
}

// The emails produced by the slot-override rules (a booking that takes a slot held for someone
// else, the notice to the lead who lost it, and a late reply from that lead) go to Slack for a
// human to approve rather than sending on their own, until they've been watched working. (The
// 24-hour follow-up used to be here too; it was confirmed working and now sends automatically,
// governed by AUTO_SEND_ENABLED.) Flip to 'true' (plus a redeploy) to let them send
// automatically; nothing else needs to change.
export function isNewRuleAutoSendEnabled(): boolean {
  return process.env.NEW_RULE_EMAILS_AUTO_SEND_ENABLED === 'true';
}

// Katie-hosted replies used to propose ONE specific time and put a tentative hold on her calendar
// for it (with the Calendly link as a fallback). That is switched off: replies now describe her
// availability in broad terms ("I have availability over the next couple days") and point to
// Calendly, and no hold is created. The old behavior is kept in the code; set this to 'true' (plus
// a redeploy) to bring it back. Soren-hosted offers are unaffected either way.
export function isSingleTimeOfferEnabled(): boolean {
  return process.env.KATIE_SINGLE_TIME_OFFER_ENABLED === 'true';
}

// Teacher-facing replies (src/teacherAgent.ts) have their own auto-send switch, separate from
// AUTO_SEND_ENABLED, so turning on auto-send for the admin/principal system never starts sending
// teacher replies unreviewed. Defaults to off: every teacher draft goes to Slack for approval.
// Flip to 'true' (plus a redeploy) once the drafts have been watched working.
export function isTeacherAutoSendEnabled(): boolean {
  return process.env.TEACHER_AUTO_SEND_ENABLED === 'true';
}

// PeerTeach's own backend (peer-teach/peerteach-match), where Remy's demo links are created and
// stored. Confirmed live: a bogus token on GET /ai-agents/demo/links/<token> there returns the
// backend's own "not_found" error.
export const PEERTEACH_API_URL_DEFAULT = 'https://server.peerteach.org';
// The page a demo link opens: <frontend>/ai-agents/demo?link=<token> (the backend's _link_url).
export const PEERTEACH_DEMO_PAGE = 'https://app.peerteach.org/ai-agents/demo';

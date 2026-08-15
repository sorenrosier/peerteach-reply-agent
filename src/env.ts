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
] as const;

// Soren's own calendar is booked directly via Google Calendar (no separate Calendly
// account for him) — impersonated through the same domain-wide-delegation service
// account already used for Katie's calendar, just with a different `sub` email.
export const SOREN_EMAIL = 'soren@peerteach.org';
// He only takes calls in this window, in his own local time (ET).
export const SOREN_WORKING_HOURS_ET = { startHour: 12, endHour: 18 };

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

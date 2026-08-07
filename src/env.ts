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
] as const;

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

import axios from 'axios';
import crypto from 'crypto';
import { envOptional } from './env';

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface CalendarEvent {
  start: string; // ISO
  end: string; // ISO
  summary: string;
}

let cachedToken: { token: string; expiresAt: number } | null = null;

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function loadServiceAccount(): ServiceAccountKey {
  const raw = envOptional('GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON');
  if (!raw) throw new Error('GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON not set');
  return JSON.parse(raw);
}

// Exchanges a domain-wide-delegation JWT for an access token, impersonating the
// calendar owner (Katie) via the `sub` claim — she never needs to log in or grant
// anything herself; the Workspace admin authorized this once in the Admin Console.
async function getAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 60) {
    return cachedToken.token;
  }

  const sa = loadServiceAccount();
  const impersonate = envOptional('CALENDAR_IMPERSONATE_EMAIL') || 'katie@peerteach.org';
  const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';

  const header = { alg: 'RS256', typ: 'JWT' };
  const claimSet = {
    iss: sa.client_email,
    // Space-separated per OAuth2 JWT-bearer spec (the Admin Console's domain-wide
    // delegation UI uses comma-separated, but the token request itself needs spaces).
    scope: 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events',
    aud: tokenUri,
    sub: impersonate,
    iat: now,
    exp: now + 3600,
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claimSet))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = base64url(signer.sign(sa.private_key));
  const jwt = `${signingInput}.${signature}`;

  const res = await axios.post(
    tokenUri,
    new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 },
  );

  const token = res.data.access_token as string;
  const expiresIn = (res.data.expires_in as number) ?? 3600;
  cachedToken = { token, expiresAt: now + expiresIn };
  return token;
}

// Events whose titles match this are blocks Katie put on her own calendar (lunch, focus
// time, "do not book," etc). They function as breaks, not meetings, so they're excluded
// from the back-to-back count entirely rather than counted as fatigue.
const NON_MEETING_PATTERN = /do not book|blocked?|focus time|\blunch\b|\bbreak\b|personal/i;

// Fetches Katie's real (non-blocked, non-all-day) calendar events in a range.
export async function getBusyMeetings(startIso: string, endIso: string): Promise<CalendarEvent[]> {
  const token = await getAccessToken();
  const res = await axios.get('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    headers: { Authorization: `Bearer ${token}` },
    params: {
      timeMin: startIso,
      timeMax: endIso,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250,
    },
    timeout: 10000,
  });

  const items = (res.data.items ?? []) as Array<any>;
  return items
    .filter((e) => e.status !== 'cancelled')
    .filter((e) => e.start?.dateTime && e.end?.dateTime) // skip all-day events
    .filter((e) => !NON_MEETING_PATTERN.test(e.summary || ''))
    // Tentative scheduling holds are not real meetings — most never convert into a
    // booking, so they should not count toward back-to-back meeting fatigue.
    .filter((e) => e.extendedProperties?.private?.peerteach_hold !== 'true')
    .map((e) => ({
      start: e.start.dateTime,
      end: e.end.dateTime,
      summary: e.summary || '(no title)',
    }));
}

const HOLD_TTL_HOURS = Number(process.env.HOLD_TTL_HOURS ?? 48);

// Creates a tentative hold on Katie's calendar for a proposed or just-confirmed slot, so
// Calendly's own availability API stops offering it to other prospects while a reply is
// pending. Tagged via extendedProperties so it can be found and released later without a
// separate database — Calendar itself is the state store.
export async function createHold(params: {
  startIso: string;
  endIso: string;
  leadEmail: string;
  campaignId: string;
  label: string; // e.g. "proposed" or "confirmed, awaiting send"
}): Promise<string | null> {
  try {
    const token = await getAccessToken();
    const res = await axios.post(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      {
        summary: `[Hold] PeerTeach — ${params.label}`,
        start: { dateTime: params.startIso },
        end: { dateTime: params.endIso },
        transparency: 'opaque', // shows as busy so Calendly's sync picks it up
        extendedProperties: {
          private: {
            peerteach_hold: 'true',
            lead_email: params.leadEmail,
            campaign_id: params.campaignId,
            created_at: new Date().toISOString(),
          },
        },
      },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 },
    );
    console.log(`[googleCalendar] created hold ${res.data.id} for ${params.leadEmail} @ ${params.startIso}`);
    return res.data.id as string;
  } catch (err) {
    // Fails open — a hold-creation failure should never block drafting or booking.
    console.warn(
      '[googleCalendar] createHold failed, continuing without hold:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

// Deletes all holds tagged with this lead+campaign — called whenever a new reply comes in
// from that lead (their old holds are now stale, whatever they said) and after a real
// Calendly booking is created (the tentative hold is no longer needed).
export async function deleteHoldsForLead(leadEmail: string, campaignId: string): Promise<void> {
  try {
    const token = await getAccessToken();
    const res = await axios.get('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        privateExtendedProperty: [`peerteach_hold=true`, `lead_email=${leadEmail}`, `campaign_id=${campaignId}`],
        timeMin: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        maxResults: 50,
      },
      paramsSerializer: { indexes: null }, // repeat privateExtendedProperty= for each value
      timeout: 10000,
    });
    const items = (res.data.items ?? []) as Array<any>;
    for (const item of items) {
      await axios.delete(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${item.id}`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10000,
      });
      console.log(`[googleCalendar] released hold ${item.id} for ${leadEmail}`);
    }
  } catch (err) {
    console.warn(
      '[googleCalendar] deleteHoldsForLead failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

// Sweeps for holds older than HOLD_TTL_HOURS with no matching real booking and deletes
// them. Meant to be called on a schedule (Vercel Cron) since nothing else naturally
// triggers cleanup for prospects who never reply.
export async function deleteExpiredHolds(): Promise<{ checked: number; deleted: number }> {
  const token = await getAccessToken();
  const res = await axios.get('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    headers: { Authorization: `Bearer ${token}` },
    params: {
      privateExtendedProperty: 'peerteach_hold=true',
      timeMin: new Date().toISOString(),
      timeMax: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
      maxResults: 250,
    },
    timeout: 15000,
  });
  const items = (res.data.items ?? []) as Array<any>;
  const cutoff = Date.now() - HOLD_TTL_HOURS * 60 * 60 * 1000;

  let deleted = 0;
  for (const item of items) {
    const createdAt = item.extendedProperties?.private?.created_at;
    const createdMs = createdAt ? new Date(createdAt).getTime() : new Date(item.created).getTime();
    if (createdMs < cutoff) {
      try {
        await axios.delete(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${item.id}`, {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 10000,
        });
        deleted++;
      } catch (err) {
        console.warn(`[googleCalendar] failed to delete expired hold ${item.id}:`, err instanceof Error ? err.message : String(err));
      }
    }
  }
  console.log(`[googleCalendar] cleanup: checked ${items.length}, deleted ${deleted} expired holds`);
  return { checked: items.length, deleted };
}

const MAX_CONSECUTIVE = Number(process.env.MAX_CONSECUTIVE_MEETINGS ?? 3);
const BREAK_GAP_MINUTES = Number(process.env.MEETING_BREAK_MINUTES ?? 15);

// Returns true if booking [candidateStart, candidateEnd) would create a run of more than
// MAX_CONSECUTIVE meetings with no gap >= BREAK_GAP_MINUTES anywhere in the chain that
// the candidate joins. Only the local chain around the candidate is measured — an
// unrelated cluster elsewhere in the day does not block this slot.
export function wouldExceedConsecutiveMeetings(
  existing: CalendarEvent[],
  candidateStart: string,
  candidateEnd: string,
): boolean {
  const candidate: CalendarEvent = { start: candidateStart, end: candidateEnd, summary: '(candidate)' };
  const all = [...existing, candidate].sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime(),
  );
  const idx = all.indexOf(candidate);

  let chainLength = 1; // the candidate itself

  for (let i = idx - 1; i >= 0; i--) {
    const gapMinutes = (new Date(all[i + 1].start).getTime() - new Date(all[i].end).getTime()) / 60000;
    if (gapMinutes < BREAK_GAP_MINUTES) chainLength += 1;
    else break;
  }

  for (let i = idx + 1; i < all.length; i++) {
    const gapMinutes = (new Date(all[i].start).getTime() - new Date(all[i - 1].end).getTime()) / 60000;
    if (gapMinutes < BREAK_GAP_MINUTES) chainLength += 1;
    else break;
  }

  return chainLength > MAX_CONSECUTIVE;
}

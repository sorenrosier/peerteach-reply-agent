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

// Keyed by impersonated email — Katie's and Soren's calendars are both accessed through
// this same domain-wide-delegation service account, just impersonating different users,
// so each needs its own cached token.
const cachedTokens = new Map<string, { token: string; expiresAt: number }>();

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
// Exported so other modules (sorenBooking.ts) that need direct Calendar API access for
// an impersonated user can reuse this instead of re-implementing the JWT exchange.
export async function getAccessToken(impersonate?: string): Promise<string> {
  const sub = impersonate || envOptional('CALENDAR_IMPERSONATE_EMAIL') || 'katie@peerteach.org';
  const now = Math.floor(Date.now() / 1000);
  const cached = cachedTokens.get(sub);
  if (cached && cached.expiresAt > now + 60) {
    return cached.token;
  }

  const sa = loadServiceAccount();
  const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';

  const header = { alg: 'RS256', typ: 'JWT' };
  const claimSet = {
    iss: sa.client_email,
    // Space-separated per OAuth2 JWT-bearer spec (the Admin Console's domain-wide
    // delegation UI uses comma-separated, but the token request itself needs spaces).
    scope: 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events',
    aud: tokenUri,
    sub,
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
  cachedTokens.set(sub, { token, expiresAt: now + expiresIn });
  return token;
}

// Events whose titles match this are blocks Katie put on her own calendar (lunch, focus
// time, "do not book," etc). They function as breaks, not meetings, so they're excluded
// from the back-to-back count entirely rather than counted as fatigue.
const NON_MEETING_PATTERN = /do not book|blocked?|focus time|\blunch\b|\bbreak\b|personal/i;

// Fetches a calendar's real (non-blocked, non-all-day) events in a range. Defaults to
// Katie's calendar; pass calendarEmail to check Soren's (or anyone else's) instead.
export async function getBusyMeetings(startIso: string, endIso: string, calendarEmail?: string): Promise<CalendarEvent[]> {
  const token = await getAccessToken(calendarEmail);
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
    // Tentative holds DO count toward the back-to-back spacing check — if several of
    // them convert into real bookings, we don't want to discover the clustering only
    // after the fact. Better to steer new proposals away from an at-risk slot now.
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
  leadName?: string;
  campaignId: string;
  label: string; // e.g. "proposed" or "confirmed, awaiting send"
  calendarEmail?: string; // defaults to Katie's calendar
}): Promise<string | null> {
  try {
    const token = await getAccessToken(params.calendarEmail);
    const who = params.leadName ? `${params.leadName} (${params.leadEmail})` : params.leadEmail;
    const res = await axios.post(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      {
        summary: `[Hold] PeerTeach — ${who} — ${params.label}`,
        description: `Tentative hold for a PeerTeach scheduling offer.\n\nProspect: ${who}\nStatus: ${params.label}`,
        start: { dateTime: params.startIso },
        end: { dateTime: params.endIso },
        transparency: 'opaque', // shows as busy so Calendly's sync picks it up
        // Google Calendar colorId '11' = Tomato (red) — makes tentative holds visually
        // distinct from real meetings at a glance.
        colorId: '11',
        extendedProperties: {
          private: {
            peerteach_hold: 'true',
            lead_email: params.leadEmail,
            lead_name: params.leadName || '',
            campaign_id: params.campaignId,
            created_at: new Date().toISOString(),
          },
        },
      },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 },
    );
    console.log(`[googleCalendar] created hold ${res.data.id} for ${who} @ ${params.startIso}`);
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

// Read-only check for whether a hold already exists for this lead+campaign — used to let
// an already-in-flight conversation finish even when the calendar isn't accepting new
// bookings, without maintaining a manual exception list. Fails CLOSED (returns false) on
// error, the opposite of most hold operations in this file: this result gates whether an
// auto-send is allowed, so an uncertain answer should fall back to the safer path
// (escalate for human review), not the more permissive one.
export async function hasExistingHold(leadEmail: string, campaignId: string, calendarEmail?: string): Promise<boolean> {
  try {
    const token = await getAccessToken(calendarEmail);
    const res = await axios.get('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        privateExtendedProperty: [`peerteach_hold=true`, `lead_email=${leadEmail}`, `campaign_id=${campaignId}`],
        timeMin: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        maxResults: 5,
      },
      paramsSerializer: { indexes: null },
      timeout: 10000,
    });
    return ((res.data.items ?? []) as Array<any>).length > 0;
  } catch (err) {
    console.warn(
      '[googleCalendar] hasExistingHold check failed, defaulting to false:',
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

// Reads the real start times of any active holds for this lead+campaign — used to ground
// the agent in what it actually offered before router.ts's unconditional cleanup below
// wipes them. Without this, a prospect confirming a previously-offered time by name only
// ("Tuesday works") forces the model to recompute the exact date from memory of its own
// prior email in a fresh run with no shared state — which is what let a real booking land
// on the wrong day once. Fails open (returns []) since this only enriches context; losing
// it should degrade to prior behavior, not block the reply.
export async function getHoldsForLead(leadEmail: string, campaignId: string, calendarEmail?: string): Promise<Array<{ startTime: string }>> {
  try {
    const token = await getAccessToken(calendarEmail);
    const res = await axios.get('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        privateExtendedProperty: [`peerteach_hold=true`, `lead_email=${leadEmail}`, `campaign_id=${campaignId}`],
        timeMin: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        maxResults: 10,
      },
      paramsSerializer: { indexes: null },
      timeout: 10000,
    });
    const items = (res.data.items ?? []) as Array<any>;
    return items
      .map((item) => item.start?.dateTime as string | undefined)
      .filter((s): s is string => !!s)
      .map((startTime) => ({ startTime }));
  } catch (err) {
    console.warn(
      '[googleCalendar] getHoldsForLead failed, continuing without prior-offer context:',
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

// Deletes all holds tagged with this lead+campaign — called whenever a new reply comes in
// from that lead (their old holds are now stale, whatever they said) and after a real
// Calendly booking is created (the tentative hold is no longer needed).
export async function deleteHoldsForLead(leadEmail: string, campaignId: string, calendarEmail?: string): Promise<void> {
  try {
    const token = await getAccessToken(calendarEmail);
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
export async function deleteExpiredHolds(calendarEmail?: string): Promise<{ checked: number; deleted: number }> {
  const token = await getAccessToken(calendarEmail);
  const res = await axios.get('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    headers: { Authorization: `Bearer ${token}` },
    params: {
      privateExtendedProperty: 'peerteach_hold=true',
      // Looks backward too, not just forward from now — a hold whose OFFERED slot time
      // has already lapsed (nobody ever replied to confirm or decline it) is exactly the
      // kind of thing this sweep should catch, but a forward-only timeMin made it
      // invisible to this query no matter how stale it got (found in production: a hold
      // from 5 days ago was still sitting on the calendar, well past HOLD_TTL_HOURS).
      // Symmetric with the 60-day forward window below — the created_at check just below
      // is what actually decides deletion, this only needs to be wide enough to surface
      // every candidate.
      timeMin: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
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

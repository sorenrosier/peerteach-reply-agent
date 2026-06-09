import axios, { AxiosError, AxiosRequestConfig } from 'axios';

const BASE_URL = 'https://api.calendly.com';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function calendlyRequest<T = any>(
  config: AxiosRequestConfig,
  attempt = 0,
): Promise<T> {
  const apiKey = process.env.CALENDLY_API_KEY;
  if (!apiKey) throw new Error('CALENDLY_API_KEY not set');
  try {
    const res = await axios.request<T>({
      baseURL: BASE_URL,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(config.headers || {}),
      },
      timeout: 15000,
      ...config,
    });
    return res.data;
  } catch (err) {
    const ax = err as AxiosError;
    const status = ax.response?.status;
    const retriable = status === 429 || (status !== undefined && status >= 500);
    if (retriable && attempt < 3) {
      const backoff = 500 * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
      await sleep(backoff);
      return calendlyRequest<T>(config, attempt + 1);
    }
    console.error(
      `[calendly] request failed: ${config.method} ${config.url} status=${status}`,
      JSON.stringify((ax.response?.data as any) ?? {}),
    );
    throw new Error(`Calendly API error (${status ?? 'no-status'}): ${ax.message}`);
  }
}

export interface CalendlySlot {
  startTime: string; // ISO UTC
  schedulingUrl: string;
}

// Fetches available slots for a given date range.
// Calendly limits to 7-day windows per call — callers must respect this.
// Calendly requires start_time to be strictly in the future.
// Callers should pass a future time; this adds a 5-min buffer if the time is at or before now.
function ensureFuture(isoTime: string): string {
  const t = new Date(isoTime);
  const floor = new Date(Date.now() + 5 * 60 * 1000);
  return t < floor ? floor.toISOString() : isoTime;
}

export async function getAvailableTimes(
  startTime: string,
  endTime: string,
): Promise<CalendlySlot[]> {
  const eventTypeUri = process.env.CALENDLY_EVENT_TYPE_URI;
  if (!eventTypeUri) throw new Error('CALENDLY_EVENT_TYPE_URI not set');

  const res = await calendlyRequest<{
    collection: Array<{ start_time: string; status: string; scheduling_url?: string }>;
  }>({
    method: 'GET',
    url: '/event_type_available_times',
    params: {
      event_type: eventTypeUri,
      start_time: ensureFuture(startTime),
      end_time: endTime,
    },
  });

  return (res.collection ?? [])
    .filter((s) => s.status === 'available')
    .map((s) => ({
      startTime: s.start_time,
      schedulingUrl: s.scheduling_url ?? '',
    }));
}

export interface BookingResult {
  uri: string;
  startTime: string;
  rescheduleUrl: string;
  cancelUrl: string;
}

export async function bookMeeting(params: {
  startTime: string;
  name: string;
  email: string;
  timezone: string;
  guests?: string[];
}): Promise<BookingResult> {
  const eventTypeUri = process.env.CALENDLY_EVENT_TYPE_URI;
  if (!eventTypeUri) throw new Error('CALENDLY_EVENT_TYPE_URI not set');
  const locationUrl = process.env.CALENDLY_LOCATION_URL;

  const res = await calendlyRequest<{
    resource?: {
      uri?: string;
      cancel_url?: string;
      reschedule_url?: string;
      event?: string;
      status?: string;
    };
  }>({
    method: 'POST',
    url: '/invitees',
    data: {
      event_type: eventTypeUri,
      start_time: params.startTime,
      invitee: {
        name: params.name,
        email: params.email,
        timezone: params.timezone,
      },
      ...(params.guests && params.guests.length ? { event_guests: params.guests } : {}),
      ...(locationUrl ? { location: { kind: 'custom', location: locationUrl } } : {}),
    },
  });

  const r = res.resource ?? {};
  const uri = r.uri ?? r.event ?? '';
  return {
    uri,
    startTime: params.startTime,
    rescheduleUrl: r.reschedule_url ?? '',
    cancelUrl: r.cancel_url ?? '',
  };
}

// Fetches the user's event types — useful for finding CALENDLY_EVENT_TYPE_URI.
// Decodes user UUID from the JWT token to avoid needing users:read scope.
export async function listEventTypes(): Promise<Array<{ uri: string; name: string; slug: string; schedulingUrl: string }>> {
  const apiKey = process.env.CALENDLY_API_KEY;
  if (!apiKey) throw new Error('CALENDLY_API_KEY not set');

  // Decode user UUID from JWT payload (no signature verification needed — we just need the claim)
  const parts = apiKey.split('.');
  if (parts.length < 2) throw new Error('CALENDLY_API_KEY does not appear to be a JWT');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
  const userUuid = payload.user_uuid;
  if (!userUuid) throw new Error('Could not extract user_uuid from Calendly token');

  const userUri = `https://api.calendly.com/users/${userUuid}`;

  const res = await calendlyRequest<{
    collection: Array<{ uri: string; name: string; slug: string; scheduling_url: string; active: boolean }>;
  }>({
    method: 'GET',
    url: '/event_types',
    params: { user: userUri },
  });

  return (res.collection ?? []).filter((e) => e.active).map((e) => ({
    uri: e.uri,
    name: e.name,
    slug: e.slug ?? '',
    schedulingUrl: e.scheduling_url,
  }));
}

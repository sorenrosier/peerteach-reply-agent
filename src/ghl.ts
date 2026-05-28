// GHL (GoHighLevel) client.
// getAvailableSlotsForReply() is called for all SCHEDULING replies when GHL keys are configured.
// upsertContact/createAppointment are only called when AUTO_BOOK_ENABLED === 'true'.

import axios, { AxiosError, AxiosRequestConfig } from 'axios';
import { envOptional } from './env';

const BASE_URL = 'https://services.leadconnectorhq.com';
const VERSION = '2021-07-28';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ghlKeysPresent(): boolean {
  return !!(
    envOptional('GHL_API_KEY') &&
    envOptional('GHL_CALENDAR_ID') &&
    envOptional('GHL_LOCATION_ID')
  );
}

async function ghlRequest<T = any>(
  config: AxiosRequestConfig,
  attempt = 0,
): Promise<T> {
  const apiKey = envOptional('GHL_API_KEY')!;
  try {
    const res = await axios.request<T>({
      baseURL: BASE_URL,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Version: VERSION,
        Accept: 'application/json',
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
      return ghlRequest<T>(config, attempt + 1);
    }
    console.error(
      `[ghl] request failed: ${config.method} ${config.url} status=${status}`,
      JSON.stringify(ax.response?.data),
    );
    throw new Error(`GHL API error (${status ?? 'no-status'}): ${ax.message}`);
  }
}

export async function upsertContact(params: {
  email: string;
  firstName: string;
  lastName: string;
  locationId: string;
  customFields?: Record<string, string>;
}): Promise<string> {
  const body: Record<string, any> = {
    email: params.email,
    firstName: params.firstName,
    lastName: params.lastName,
    locationId: params.locationId,
  };
  if (params.customFields && Object.keys(params.customFields).length > 0) {
    body.customFields = Object.entries(params.customFields).map(([key, value]) => ({
      key,
      field_value: value,
    }));
  }
  const res = await ghlRequest<{ contact?: { id: string }; new?: boolean }>({
    method: 'POST',
    url: '/contacts/upsert',
    data: body,
  });
  if (!res.contact?.id) {
    throw new Error('GHL upsertContact returned no contact id');
  }
  return res.contact.id;
}

export async function getFreeSlots(params: {
  calendarId: string;
  startDate: string;
  endDate: string;
  timezone: string;
}): Promise<Array<{ startTime: string; endTime: string }>> {
  // GHL free-slots returns object keyed by date.
  const res = await ghlRequest<Record<string, { slots?: string[] }> | any>({
    method: 'GET',
    url: `/calendars/${params.calendarId}/free-slots`,
    params: {
      startDate: new Date(params.startDate).getTime(),
      endDate: new Date(params.endDate).getTime(),
      timezone: params.timezone,
    },
  });

  const slots: Array<{ startTime: string; endTime: string }> = [];
  if (res && typeof res === 'object') {
    for (const key of Object.keys(res)) {
      const day = res[key];
      if (day && Array.isArray(day.slots)) {
        for (const startTime of day.slots) {
          // GHL slots are start times. Default 30-minute meeting.
          const startMs = new Date(startTime).getTime();
          if (Number.isFinite(startMs)) {
            const endTime = new Date(startMs + 30 * 60 * 1000).toISOString();
            slots.push({ startTime, endTime });
          }
        }
      }
    }
  }
  // Sort chronologically
  slots.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
  return slots;
}

// Returns the next 2 weekdays from now (today counts if it's a weekday).
// If today is Friday, returns Friday + Monday.
function getNextTwoWeekdays(now: Date): { start: Date; end: Date } {
  const weekdays: Date[] = [];
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  while (weekdays.length < 2) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) weekdays.push(new Date(d));
    d.setDate(d.getDate() + 1);
  }
  const end = new Date(weekdays[1]);
  end.setHours(23, 59, 59, 999);
  return { start: now, end };
}

function getDateKey(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const y = parts.find((p) => p.type === 'year')?.value ?? '';
  const m = parts.find((p) => p.type === 'month')?.value ?? '';
  const dd = parts.find((p) => p.type === 'day')?.value ?? '';
  return `${y}-${m}-${dd}`;
}

// Picks N evenly-spaced slots from a day's slot list so Claude gets variety without noise.
function selectSpread(
  slots: Array<{ startTime: string; endTime: string }>,
  n: number,
): Array<{ startTime: string; endTime: string }> {
  if (slots.length <= n) return slots;
  const result: Array<{ startTime: string; endTime: string }> = [];
  const step = (slots.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) {
    result.push(slots[Math.round(i * step)]);
  }
  return result;
}

function formatIndividualSlots(
  slots: Array<{ startTime: string; endTime: string }>,
  timezone: string,
  now: Date,
): string {
  const byDate = new Map<string, Array<{ startTime: string; endTime: string }>>();
  for (const slot of slots) {
    const key = getDateKey(new Date(slot.startTime), timezone);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key)!.push(slot);
  }

  const todayKey = getDateKey(now, timezone);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowKey = getDateKey(tomorrow, timezone);

  const dayFormatter = new Intl.DateTimeFormat('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: timezone,
  });
  const timeFormatter = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: timezone,
  });

  const lines: string[] = [];
  for (const [dateKey, daySlots] of byDate) {
    const spread = selectSpread(daySlots, 4);
    const firstDate = new Date(spread[0].startTime);
    const dayLabel = dayFormatter.format(firstDate);
    const prefix =
      dateKey === todayKey ? `Today (${dayLabel})`
      : dateKey === tomorrowKey ? `Tomorrow (${dayLabel})`
      : dayLabel;
    for (const slot of spread) {
      lines.push(`${prefix} at ${timeFormatter.format(new Date(slot.startTime))}`);
    }
  }
  return lines.join('\n');
}

// Returns a formatted availability block for the next 2 weekdays, grouped into contiguous ranges.
// e.g. "Today (Monday, May 19): 11:00 AM - 1:00 PM EDT, 2:00 PM - 4:00 PM EDT"
// Returns null if GHL keys are not configured or if the API call fails.
export async function getAvailableSlotsForReply(
  timezone = 'America/New_York',
): Promise<string | null> {
  if (!ghlKeysPresent()) {
    console.warn('[ghl] keys not present, skipping slot fetch');
    return null;
  }

  const calendarId = envOptional('GHL_CALENDAR_ID')!;
  const now = new Date();
  const { start, end } = getNextTwoWeekdays(now);

  console.log('[ghl] fetching free slots calendarId:', calendarId, 'from:', start.toISOString(), 'to:', end.toISOString(), 'tz:', timezone);

  try {
    const slots = await getFreeSlots({
      calendarId,
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      timezone,
    });

    console.log('[ghl] raw slots returned:', slots.length, 'first:', slots[0]?.startTime ?? 'none');

    if (slots.length === 0) return null;

    const block = formatIndividualSlots(slots, timezone, now);
    console.log('[ghl] slots passed to Claude:\n', block);
    return block;
  } catch (err) {
    console.error(
      '[ghl] getAvailableSlotsForReply failed:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

export async function createAppointment(params: {
  calendarId: string;
  locationId: string;
  contactId: string;
  startTime: string;
  endTime: string;
  title: string;
  notes?: string;
}): Promise<string> {
  const res = await ghlRequest<{ id?: string; appointment?: { id?: string } }>({
    method: 'POST',
    url: '/calendars/events/appointments',
    data: {
      calendarId: params.calendarId,
      locationId: params.locationId,
      contactId: params.contactId,
      startTime: params.startTime,
      endTime: params.endTime,
      title: params.title,
      appointmentStatus: 'confirmed',
      meetingLocationType: 'zoom',
      ignoreDateRange: false,
      ignoreFreeSlotValidation: false,
      ...(params.notes ? { notes: params.notes } : {}),
    },
  });
  const id = res.id ?? res.appointment?.id;
  if (!id) throw new Error('GHL createAppointment returned no id');
  return id;
}

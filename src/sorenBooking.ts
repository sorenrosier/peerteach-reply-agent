import axios from 'axios';
import { getBusyMeetings, getAccessToken } from './googleCalendar';
import { SOREN_EMAIL, SOREN_WORKING_HOURS_ET, SOREN_ZOOM_URL } from './env';

// Soren has no separate Calendly account — his calendar is booked directly via the same
// Google Calendar domain-wide-delegation access already used for Katie's holds, just
// impersonating soren@peerteach.org instead. This mirrors calendly.ts's shape
// (getAvailableTimes / bookMeeting) so agent.ts can treat the two hosts uniformly.

const SLOT_MINUTES = 30;

// Generates candidate 30-min slots across [startIso, endIso), keeps only those that fall
// on a weekday within his stated working hours in HIS OWN local time (America/New_York),
// aren't in the past, and don't overlap anything already on his calendar. DST-safe: we
// check each candidate's local hour/weekday via Intl rather than assuming a fixed UTC
// offset for the 12-6pm window.
export async function getSorenAvailableTimes(
  startIso: string,
  endIso: string,
): Promise<Array<{ startTime: string }>> {
  const tz = 'America/New_York';
  const hourFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz });
  const weekdayFmt = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: tz });

  const floor = new Date(Date.now() + 5 * 60 * 1000); // same 5-min future buffer as Calendly
  const rangeStart = new Date(startIso);
  const rangeEnd = new Date(endIso);

  const busy = await getBusyMeetings(startIso, endIso, SOREN_EMAIL);

  const slots: Array<{ startTime: string }> = [];
  for (
    let t = new Date(Math.ceil(rangeStart.getTime() / (SLOT_MINUTES * 60000)) * (SLOT_MINUTES * 60000));
    t < rangeEnd;
    t = new Date(t.getTime() + SLOT_MINUTES * 60000)
  ) {
    if (t < floor) continue;

    const weekday = weekdayFmt.format(t);
    if (weekday === 'Sat' || weekday === 'Sun') continue;

    const localHour = Number(hourFmt.format(t).replace('24', '0'));
    if (localHour < SOREN_WORKING_HOURS_ET.startHour || localHour >= SOREN_WORKING_HOURS_ET.endHour) continue;

    const slotEnd = new Date(t.getTime() + SLOT_MINUTES * 60000);
    const overlaps = busy.some((b) => {
      const bStart = new Date(b.start).getTime();
      const bEnd = new Date(b.end).getTime();
      return t.getTime() < bEnd && slotEnd.getTime() > bStart;
    });
    if (overlaps) continue;

    slots.push({ startTime: t.toISOString() });
  }

  return slots;
}

export interface SorenBookingResult {
  id: string;
  startTime: string;
  locationUrl: string;
}

export async function bookSorenMeeting(params: {
  startTime: string;
  name: string;
  email: string;
  guests?: string[];
}): Promise<SorenBookingResult> {
  const endTime = new Date(new Date(params.startTime).getTime() + SLOT_MINUTES * 60000).toISOString();

  // Unlike Calendly, plain Google Calendar event creation does not reject overlaps on its
  // own. The caller already released any tentative hold on this slot before calling here,
  // so anything found now is a real conflict (e.g. he grabbed the slot himself, or another
  // booking landed here in the meantime) — abort rather than silently double-booking him.
  const busy = await getBusyMeetings(params.startTime, endTime, SOREN_EMAIL);
  const conflict = busy.find(
    (b) => new Date(params.startTime).getTime() < new Date(b.end).getTime() && new Date(endTime).getTime() > new Date(b.start).getTime(),
  );
  if (conflict) {
    throw new Error(`Soren's calendar has a conflict at this time: "${conflict.summary}"`);
  }

  const token = await getAccessToken(SOREN_EMAIL);

  const attendees = [
    { email: params.email },
    ...(params.guests ?? []).map((g) => ({ email: g })),
  ];

  const res = await axios.post(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events',
    {
      summary: `${params.name} <> Soren`,
      start: { dateTime: params.startTime, timeZone: 'America/New_York' },
      end: { dateTime: endTime, timeZone: 'America/New_York' },
      attendees,
      // His own personal Zoom room, not an auto-generated Google Meet link.
      location: SOREN_ZOOM_URL,
      description: `Join Zoom: ${SOREN_ZOOM_URL}`,
    },
    {
      headers: { Authorization: `Bearer ${token}` },
      params: { sendUpdates: 'all' },
      timeout: 10000,
    },
  );

  return {
    id: res.data.id as string,
    startTime: params.startTime,
    locationUrl: SOREN_ZOOM_URL,
  };
}

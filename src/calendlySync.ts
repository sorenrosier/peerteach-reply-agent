import axios from 'axios';
import { getAccessToken } from './googleCalendar';
import { findLeadByEmailAnyCampaign, markMeetingBooked, removeLeadFromSubsequence } from './instantly';

export interface CalendlySyncResult {
  checked: number;
  matched: number;
  updated: number;
  errors: number;
}

// Sweeps Katie's calendar for real bookings and, for any attendee whose email matches an
// Instantly lead still sitting at "interested" (or no status yet), marks them meeting_booked
// and pulls them out of whatever follow-up subsequence they're in — so they stop being asked
// to book a demo they already booked.
//
// This deliberately covers ANY real booking on her calendar, not just ones tied to a hold we
// created — a prospect who books cold via the public Calendly link, without ever replying to
// the outreach thread, never touches our hold-creation code at all, so scoping this to holds
// would miss exactly the case that prompted it (see the Sarah Griggs incident: King had to
// manually notice and unstick her subsequence by hand).
//
// Idempotency: each event gets tagged instantly_meeting_sync='done' via extendedProperties
// once fully processed (a Calendar PATCH merges rather than replaces — same pattern as
// updateEventReminderStatus) so repeat runs skip it. That tag is checked client-side, not
// used as a query filter — combining a privateExtendedProperty filter with a wide time
// window has a confirmed silent-failure bug in this API (see deleteExpiredHolds).
export async function syncCalendlyBookingsToInstantly(): Promise<CalendlySyncResult> {
  const result: CalendlySyncResult = { checked: 0, matched: 0, updated: 0, errors: 0 };
  try {
    const token = await getAccessToken(); // Katie only — no plans for Soren to take direct Calendly bookings
    const res = await axios.get('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        timeMin: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
        timeMax: new Date(Date.now() + 45 * 24 * 60 * 60 * 1000).toISOString(),
        singleEvents: true,
        maxResults: 250,
      },
      timeout: 15000,
    });
    const items = (res.data.items ?? []) as any[];
    result.checked = items.length;

    for (const item of items) {
      if (item.status === 'cancelled') continue;
      if (item.extendedProperties?.private?.instantly_meeting_sync) continue;
      if (item.extendedProperties?.private?.peerteach_hold) continue; // a hold isn't a real booking yet

      const attendeeEmails = ((item.attendees ?? []) as any[])
        .map((a) => (a?.email || '').toLowerCase().trim())
        .filter(Boolean);

      if (attendeeEmails.length === 0) {
        // Nothing to check yet (e.g. a placeholder with no attendees added). Don't tag —
        // leave it for a later sweep in case real attendees get added.
        continue;
      }

      let hadTransientError = false;
      for (const email of attendeeEmails) {
        try {
          const lead = await findLeadByEmailAnyCampaign(email);
          if (!lead) continue; // not an Instantly lead (e.g. an internal PeerTeach address) — nothing to sync
          result.matched++;
          // Don't clobber a status a human already set deliberately (not_interested,
          // wrong_person, lost) and don't bother re-touching someone already past this
          // point (meeting_booked, meeting_completed, closed).
          if (lead.interestStatus < 0 || lead.interestStatus >= 2) continue;
          await markMeetingBooked(email, lead.campaignId);
          if (lead.subsequenceId) {
            await removeLeadFromSubsequence(lead.id);
          }
          result.updated++;
        } catch (err) {
          hadTransientError = true;
          result.errors++;
          console.warn(
            `[calendlySync] failed to sync ${email} for event ${item.id}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      if (hadTransientError) continue; // leave untagged so the next tick retries this event

      try {
        await axios.patch(
          `https://www.googleapis.com/calendar/v3/calendars/primary/events/${item.id}`,
          { extendedProperties: { private: { instantly_meeting_sync: 'done' } } },
          { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 },
        );
      } catch (err) {
        console.warn(
          `[calendlySync] failed to tag event ${item.id} as synced:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  } catch (err) {
    console.error('[calendlySync] sweep failed:', err instanceof Error ? err.message : String(err));
  }
  return result;
}

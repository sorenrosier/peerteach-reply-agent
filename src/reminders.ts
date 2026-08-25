import { listBookingsNeedingReminder, updateEventReminderStatus } from './googleCalendar';
import { SOREN_EMAIL, SOREN_ZOOM_URL, isReminderAutoSendEnabled, envOptional } from './env';
import { replyToEmail } from './instantly';
import { postReminderApproval } from './slack';

// Send 3 hours before the call. The window width matches the cron's cadence (every 15
// min) so consecutive ticks tile the timeline with no gaps and no overlap; the
// reminder_status extended property is a second, independent guard against ever double
// sending even if a tick runs late or a booking briefly appears in two windows.
const REMINDER_LEAD_MINUTES = 180;
const WINDOW_MINUTES = 15;

function firstNameOf(fullName: string): string {
  return (fullName || '').trim().split(/\s+/)[0] || fullName;
}

function formatCallTime(startTimeIso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
      timeZone: timezone || 'America/New_York',
    }).format(new Date(startTimeIso));
  } catch {
    return startTimeIso;
  }
}

export function buildReminderText(recipientName: string, startTimeIso: string, timezone: string): string {
  const time = formatCallTime(startTimeIso, timezone);
  return `Hi ${firstNameOf(recipientName)} - looking forward to chatting at ${time}.

Here's the Zoom link: ${SOREN_ZOOM_URL}

Just let me know if you need to reschedule for whatever reason :)

-Soren

--
Soren Rosier, Ph.D.
Founder & CEO, PeerTeach
Lecturer, Stanford Graduate School of Education`;
}

export async function processReminders(): Promise<{ checked: number; sent: number; queued: number; failed: number }> {
  if (!envOptional('GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON')) {
    return { checked: 0, sent: 0, queued: 0, failed: 0 };
  }

  const now = Date.now();
  const windowStart = new Date(now + (REMINDER_LEAD_MINUTES - WINDOW_MINUTES) * 60000).toISOString();
  const windowEnd = new Date(now + REMINDER_LEAD_MINUTES * 60000).toISOString();

  const bookings = await listBookingsNeedingReminder(windowStart, windowEnd, SOREN_EMAIL);
  let sent = 0;
  let queued = 0;
  let failed = 0;

  for (const booking of bookings) {
    const draft = buildReminderText(booking.name, booking.startTime, booking.timezone);
    try {
      if (isReminderAutoSendEnabled()) {
        await replyToEmail({
          reply_to_uuid: booking.emailId,
          eaccount: booking.eaccount,
          subject: booking.subject,
          body: { text: draft },
          cc: booking.otherGuests.length ? booking.otherGuests : undefined,
        });
        await updateEventReminderStatus(booking.eventId, 'sent', SOREN_EMAIL);
        sent++;
      } else {
        await postReminderApproval({
          name: booking.name,
          leadEmail: booking.leadEmail,
          campaignId: booking.campaignId,
          eaccount: booking.eaccount,
          emailId: booking.emailId,
          subject: booking.subject,
          startTimeIso: booking.startTime,
          timezone: booking.timezone,
          draftText: draft,
          eventId: booking.eventId,
          otherGuests: booking.otherGuests,
        });
        await updateEventReminderStatus(booking.eventId, 'queued', SOREN_EMAIL);
        queued++;
      }
    } catch (err) {
      failed++;
      console.error(
        `[reminders] failed for event ${booking.eventId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return { checked: bookings.length, sent, queued, failed };
}

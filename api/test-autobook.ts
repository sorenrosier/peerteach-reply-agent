import type { VercelRequest, VercelResponse } from '@vercel/node';
import { validateEnv, envOptional } from '../src/env';
import { getFreeSlots, upsertContact, createAppointment } from '../src/ghl';

// GET /api/test-autobook
// Runs the full GHL auto-book flow with dummy data and returns results as JSON.
// Creates a real appointment in GHL — delete it manually afterward.
export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  try {
    validateEnv();
  } catch (err) {
    res.status(500).json({ error: 'Server misconfigured', detail: (err as Error).message });
    return;
  }

  const calendarId = envOptional('GHL_CALENDAR_ID');
  const locationId = envOptional('GHL_LOCATION_ID');

  if (!calendarId || !locationId) {
    res.status(400).json({ error: 'GHL_CALENDAR_ID and GHL_LOCATION_ID must be set' });
    return;
  }

  const log: Record<string, any> = {};

  try {
    // Step 1: Fetch free slots
    const now = new Date();
    const end = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
    const slots = await getFreeSlots({
      calendarId,
      startDate: now.toISOString(),
      endDate: end.toISOString(),
      timezone: 'America/New_York',
    });
    log.slotsFound = slots.length;
    log.firstSlot = slots[0] ?? null;

    if (slots.length === 0) {
      res.status(200).json({ ok: false, reason: 'No free slots found', log });
      return;
    }

    const chosen = slots[0];
    log.chosenSlot = chosen;

    // Step 2: Upsert test contact
    const contactId = await upsertContact({
      email: 'autobook-test@peerteach-test.com',
      firstName: 'AutoBook',
      lastName: 'Test',
      locationId,
      customFields: {
        instantly_campaign: 'test-autobook',
        school: 'Test School',
        role: 'Principal',
      },
    });
    log.contactId = contactId;

    // Step 3: Create appointment
    const appointmentId = await createAppointment({
      calendarId,
      locationId,
      contactId,
      startTime: chosen.startTime,
      endTime: chosen.endTime,
      title: 'PeerTeach intro — AutoBook Test',
      notes: 'Created by /api/test-autobook. Safe to delete.',
    });
    log.appointmentId = appointmentId;

    res.status(200).json({ ok: true, log });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: msg, log });
  }
}

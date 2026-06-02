import type { VercelRequest, VercelResponse } from '@vercel/node';
import { validateEnv } from '../src/env';
import { listEventTypes, getAvailableTimes, bookMeeting } from '../src/calendly';

// GET /api/test-autobook
// Runs the full Calendly flow: list event types, fetch slots, book a test appointment.
// Creates a real booking — delete it from Calendly afterward.
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

  if (!process.env.CALENDLY_API_KEY) {
    res.status(400).json({ error: 'CALENDLY_API_KEY not set' });
    return;
  }

  const log: Record<string, any> = {};

  try {
    // Step 1: List event types (helps find CALENDLY_EVENT_TYPE_URI)
    const eventTypes = await listEventTypes();
    log.eventTypes = eventTypes.map((e) => ({ name: e.name, uri: e.uri, slug: e.slug }));

    if (!process.env.CALENDLY_EVENT_TYPE_URI) {
      res.status(200).json({
        ok: false,
        reason: 'CALENDLY_EVENT_TYPE_URI not set — copy the uri from eventTypes below and set it',
        log,
      });
      return;
    }

    // Step 2: Fetch available times for next 7 days
    const now = new Date();
    const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const slots = await getAvailableTimes(now.toISOString(), end.toISOString());
    log.slotsFound = slots.length;
    log.firstSlot = slots[0] ?? null;

    if (slots.length === 0) {
      res.status(200).json({ ok: false, reason: 'No available slots found', log });
      return;
    }

    // Step 3: Book the first available slot with test data
    const booking = await bookMeeting({
      startTime: slots[0].startTime,
      name: 'AutoBook Test',
      email: 'autobook-test@peerteach-test.com',
      timezone: 'America/New_York',
    });
    log.booking = booking;

    res.status(200).json({ ok: true, log });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: msg, log });
  }
}

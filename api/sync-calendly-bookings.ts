import type { VercelRequest, VercelResponse } from '@vercel/node';
import { syncCalendlyBookingsToInstantly } from '../src/calendlySync';

// GET /api/sync-calendly-bookings — run on a schedule (Vercel Cron) to catch prospects who
// book a demo directly via Katie's public Calendly link (with or without ever replying to
// the outreach thread) and update their Instantly status + stop their follow-up subsequence,
// so they don't get asked to book a call they already booked. Vercel signs cron requests
// with a bearer token matching CRON_SECRET; reject anything else so this can't be triggered
// by an outsider hitting the URL directly.
export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = (req.headers['authorization'] || '').toString();
    if (auth !== `Bearer ${cronSecret}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
  }

  if (!process.env.GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON) {
    res.status(200).json({ ok: true, skipped: 'GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON not set' });
    return;
  }

  try {
    const result = await syncCalendlyBookingsToInstantly();
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[sync-calendly-bookings] failed:', msg);
    res.status(500).json({ ok: false, error: msg });
  }
}

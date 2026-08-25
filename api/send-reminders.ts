import type { VercelRequest, VercelResponse } from '@vercel/node';
import { processReminders } from '../src/reminders';

// GET /api/send-reminders — run every 15 minutes (Vercel Cron) to send/queue reminder
// emails for demo calls on Soren's calendar starting in ~3 hours. Vercel signs cron
// requests with a bearer token matching CRON_SECRET; reject anything else so this can't be
// triggered by an outsider hitting the URL directly.
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

  try {
    const result = await processReminders();
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[send-reminders] failed:', msg);
    res.status(500).json({ ok: false, error: msg });
  }
}

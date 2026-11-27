import type { VercelRequest, VercelResponse } from '@vercel/node';
import { runLapseNudges } from '../src/lapseNudges';

// GET /api/send-lapse-nudges, run by Vercel Cron at 16:00 UTC on Tuesday, Wednesday and Thursday
// (morning across the US): posts a Slack card for each teacher who stopped running sessions,
// with a check-in email a person can approve (see src/lapseNudges.ts). The job sends nothing
// itself. ?dry_run=1 works out who would get a card and logs it; it posts and records nothing.
// Vercel signs cron requests with a bearer token matching CRON_SECRET; anything else is rejected.
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = (req.headers['authorization'] || '').toString();
    if (auth !== `Bearer ${cronSecret}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
  }
  if (!process.env.CLOSE_API_KEY || !process.env.PEERTEACH_USAGE_SECRET) {
    res.status(200).json({ ok: true, skipped: 'CLOSE_API_KEY or PEERTEACH_USAGE_SECRET not set' });
    return;
  }
  try {
    const dry = String(req.query.dry_run ?? '');
    const result = await runLapseNudges({ dryRun: dry === '1' || dry === 'true' });
    res.status(result.ok ? 200 : 500).json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[send-lapse-nudges] failed:', msg);
    res.status(500).json({ ok: false, error: msg });
  }
}

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { runCloseSync } from '../src/closeSync';

// GET /api/sync-close, run every 15 minutes by Vercel Cron: adds people who booked a call to
// Close CRM (see src/closeSync.ts). Dry run unless CLOSE_SYNC_MODE=live. Vercel signs cron
// requests with a bearer token matching CRON_SECRET; anything else is rejected.
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = (req.headers['authorization'] || '').toString();
    if (auth !== `Bearer ${cronSecret}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
  }
  if (!process.env.CLOSE_API_KEY || !process.env.GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON) {
    res.status(200).json({ ok: true, skipped: 'CLOSE_API_KEY or calendar access not set' });
    return;
  }
  try {
    // ?skip=N (dry runs only): start at the Nth booking, to review every slice by hand.
    const skip = Number(req.query.skip);
    const result = await runCloseSync(Number.isFinite(skip) && skip >= 0 ? { skipFirst: skip } : {});
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[sync-close] failed:', msg);
    res.status(500).json({ ok: false, error: msg });
  }
}

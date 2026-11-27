import type { VercelRequest, VercelResponse } from '@vercel/node';
import { runUsageHealth } from '../src/usageHealth';

// GET /api/sync-usage-health, run nightly by Vercel Cron (12:30 UTC, after the product's 10:35
// UTC usage feed): writes each school's usage health onto its Close lead (see
// src/usageHealth.ts). Dry run unless USAGE_HEALTH_MODE=live; ?dry_run=1 forces a dry run for one
// call. Vercel signs cron requests with a bearer token matching CRON_SECRET; anything else is
// rejected.
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
    const result = await runUsageHealth({ forceDry: dry === '1' || dry === 'true' });
    res.status(result.ok ? 200 : 500).json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[sync-usage-health] failed:', msg);
    res.status(500).json({ ok: false, error: msg });
  }
}

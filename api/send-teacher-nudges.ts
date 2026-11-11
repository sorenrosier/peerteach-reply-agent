import type { VercelRequest, VercelResponse } from '@vercel/node';
import { runTeacherNudges } from '../src/teacherNudges';

// GET /api/send-teacher-nudges, run hourly by Vercel Cron: a one-time check-in for teachers
// whose personal demo link has sat unused for about two days (see src/teacherNudges.ts).
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
  try {
    const result = await runTeacherNudges();
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[send-teacher-nudges] failed:', msg);
    res.status(500).json({ ok: false, error: msg });
  }
}

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { waitUntil } from '@vercel/functions';
import { routeReply } from '../src/router';
import { validateEnv, envOptional } from '../src/env';
import { InstantlyWebhookPayload } from '../src/types';

// Vercel automatically parses JSON bodies. We rely on it but validate content-type defensively.
export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (process.env.PAUSED === 'true') {
    console.log('[webhook] system paused, skipping processing');
    res.status(200).json({ ok: true, paused: true });
    return;
  }

  try {
    validateEnv();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[webhook] env validation failed:', msg);
    res.status(500).json({ error: 'Server misconfigured', detail: msg });
    return;
  }

  const contentType = (req.headers['content-type'] || '').toString().toLowerCase();
  if (!contentType.includes('application/json')) {
    res.status(415).json({ error: 'Expected application/json' });
    return;
  }

  const expectedSecret = envOptional('WEBHOOK_SECRET');
  if (expectedSecret) {
    const provided = (req.headers['x-webhook-secret'] || '').toString();
    if (provided !== expectedSecret) {
      console.warn('[webhook] invalid x-webhook-secret');
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
  }

  const body = req.body as Partial<InstantlyWebhookPayload> | undefined;
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'Invalid JSON body' });
    return;
  }

  const eventType = (body.event_type || '').toString();
  if (eventType === 'auto_reply_received') {
    // OOO / auto-replies — Instantly handles these natively, skip silently.
    res.status(200).json({ ok: true, skipped: 'auto_reply_received' });
    return;
  }
  if (eventType !== 'reply_received') {
    res.status(200).json({ ok: true, skipped: eventType || 'unknown_event' });
    return;
  }

  const required: Array<keyof InstantlyWebhookPayload> = [
    'campaign_id',
    'lead_email',
    'email_account',
    'email_id',
  ];
  for (const k of required) {
    if (!body[k]) {
      console.warn(`[webhook] missing field ${k}`);
      res.status(400).json({ error: `Missing field: ${k}` });
      return;
    }
  }

  const payload = body as InstantlyWebhookPayload;

  // Acknowledge Instantly IMMEDIATELY rather than processing synchronously first. The
  // pipeline has grown a lot since this was originally a quick classify+Slack-post (now:
  // an 8-iteration Claude tool loop, Calendly availability checks, Google Calendar hold
  // create/delete, and — with AUTO_SEND_ENABLED — the full booking+send flow), so it can
  // comfortably exceed 30s. If Instantly has its own webhook timeout, a slow synchronous
  // response risks it treating the delivery as failed and retrying, which would process
  // the same reply twice (duplicate Slack cards, or worse, duplicate auto-sends/bookings).
  // Do the real work in the background via waitUntil, matching the same pattern already
  // used in api/slack-action.ts.
  const work = routeReply(payload).catch((err) => {
    console.error(
      '[webhook] routeReply threw at top level',
      err instanceof Error ? err.stack : String(err),
      { lead_email: payload.lead_email, campaign_id: payload.campaign_id },
    );
  });
  waitUntil(work);

  res.status(200).json({ ok: true });
}

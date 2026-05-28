import type { VercelRequest, VercelResponse } from '@vercel/node';
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

  // Process first, then respond. Vercel freezes the lambda immediately after res.end(),
  // so we must complete all async work before sending the response.
  // Instantly waits up to 30s and our maxDuration is 30s — sufficient for classify + Slack.
  try {
    await routeReply(payload);
  } catch (err) {
    console.error(
      '[webhook] routeReply threw at top level',
      err instanceof Error ? err.stack : String(err),
      { lead_email: payload.lead_email, campaign_id: payload.campaign_id },
    );
  }

  res.status(200).json({ ok: true });
}

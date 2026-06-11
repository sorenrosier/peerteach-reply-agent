import type { VercelRequest, VercelResponse } from '@vercel/node';
import { waitUntil } from '@vercel/functions';
import crypto from 'crypto';
import { env, validateEnv } from '../src/env';
import { replyToEmail } from '../src/instantly';
import { bookMeeting } from '../src/calendly';
import { updateViaResponseUrl } from '../src/slack';
import { SendReplyButtonValue, SlackActionPayload } from '../src/types';

// Disable Vercel's automatic body parser. Slack signs the RAW request body, so we must
// read the bytes ourselves before anything consumes the stream — otherwise the signature
// can never be verified and every button click 401s.
export const config = {
  api: {
    bodyParser: false,
  },
};

// Read the raw request body straight off the stream. The body parser is disabled (see
// `config` above), so the stream is intact here.
async function getRawBody(req: VercelRequest): Promise<string> {
  // If something upstream already buffered the raw body, use it.
  const raw = (req as any).rawBody ?? (req as any)._body;
  if (raw) return typeof raw === 'string' ? raw : raw.toString('utf8');

  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function verifySlackSignature(
  signingSecret: string,
  rawBody: string,
  timestamp: string,
  signature: string,
): boolean {
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > 60 * 5) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const hmac = crypto.createHmac('sha256', signingSecret).update(base).digest('hex');
  const expected = `v0=${hmac}`;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Slack sends interactive payloads as application/x-www-form-urlencoded with a single
// `payload` field holding a JSON string. With the body parser disabled we parse the raw
// body ourselves so the exact bytes used for signature verification are reused here.
function parsePayload(rawBody: string): SlackActionPayload | null {
  let payloadStr: string | null = null;
  try {
    payloadStr = new URLSearchParams(rawBody).get('payload');
  } catch {
    payloadStr = null;
  }
  if (!payloadStr) return null;
  try {
    return JSON.parse(payloadStr) as SlackActionPayload;
  } catch {
    return null;
  }
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    validateEnv();
  } catch (err) {
    res.status(500).json({ error: 'Server misconfigured', detail: (err as Error).message });
    return;
  }

  const timestamp = (req.headers['x-slack-request-timestamp'] || '').toString();
  const signature = (req.headers['x-slack-signature'] || '').toString();
  const signingSecret = env('SLACK_SIGNING_SECRET');
  const rawBody = await getRawBody(req);

  console.log('[slack-action] rawBody length:', rawBody.length, 'timestamp:', timestamp);

  if (!verifySlackSignature(signingSecret, rawBody, timestamp, signature)) {
    console.warn('[slack-action] invalid signature, rawBody length:', rawBody.length);
    res.status(401).json({ error: 'Invalid Slack signature' });
    return;
  }

  const payload = parsePayload(rawBody);
  if (!payload || !Array.isArray(payload.actions) || payload.actions.length === 0) {
    console.warn('[slack-action] invalid payload', rawBody.slice(0, 200));
    res.status(400).json({ error: 'Invalid Slack payload' });
    return;
  }

  // Acknowledge Slack IMMEDIATELY (within its 3-second window) so it doesn't time out,
  // show the user an error, or re-deliver the click. A Send that books a meeting AND sends
  // the reply takes longer than 3s (Calendly + Instantly), so we do that work in the
  // background via waitUntil and report the result by editing the message via response_url.
  const work = processAction(payload.actions[0], payload).catch(async (err) => {
    console.error(
      '[slack-action] processAction failed',
      err instanceof Error ? err.stack : String(err),
    );
    try {
      await updateViaResponseUrl(
        payload.response_url,
        `:warning: Action failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } catch {}
  });
  // Keep the function alive until the background work finishes (up to maxDuration).
  waitUntil(work);

  res.status(200).end();
}

async function processAction(
  action: SlackActionPayload['actions'][number],
  payload: SlackActionPayload,
): Promise<void> {
  const now = new Date().toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });

  switch (action.action_id) {
    case 'send_reply': {
      let parsed: SendReplyButtonValue;
      try {
        parsed = JSON.parse(action.value);
      } catch {
        await updateViaResponseUrl(
          payload.response_url,
          ':warning: Could not parse button payload — open Unibox to send manually.',
        );
        return;
      }
      // Book the Calendly meeting FIRST (only happens on this affirmative Send — never on Skip).
      // If booking fails (e.g. the slot was taken since the draft was created), do NOT send
      // the confirmation reply — surface the failure so a human can handle it.
      if (parsed.booking) {
        try {
          await bookMeeting({
            startTime: parsed.booking.startTime,
            name: parsed.booking.name,
            email: parsed.booking.email,
            timezone: parsed.booking.timezone,
            guests: parsed.booking.guests,
          });
          console.log('[slack-action] booked on send:', parsed.booking.startTime, 'guests:', parsed.booking.guests.join(', ') || 'none');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await updateViaResponseUrl(
            payload.response_url,
            `:warning: Could not book the meeting (\`${msg}\`). The slot may no longer be available. Reply NOT sent — please handle manually in Unibox.`,
          );
          return;
        }
      }
      try {
        await replyToEmail({
          reply_to_uuid: parsed.email_id,
          eaccount: parsed.eaccount,
          subject: parsed.subject,
          body: { text: parsed.body_text },
        });
        const userTag = payload.user?.id ? `<@${payload.user.id}>` : 'a teammate';
        await updateViaResponseUrl(
          payload.response_url,
          `:white_check_mark: Reply sent at ${now} by ${userTag}`,
          [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `:white_check_mark: *Reply sent* at ${now} by ${userTag}\n\n*To:* ${parsed.lead_email}\n\n>>> ${parsed.body_text.slice(0, 1500)}`,
              },
            },
          ],
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await updateViaResponseUrl(
          payload.response_url,
          `:warning: Failed to send reply: \`${msg}\` — open Unibox to send manually.`,
        );
      }
      return;
    }

    case 'edit_send': {
      // Manual takeover in Unibox — we do NOT auto-book here, because the human may change
      // the time while editing. If the reply confirms a meeting, warn them to book it.
      let hasBooking = false;
      try {
        hasBooking = !!(JSON.parse(action.value) as Partial<SendReplyButtonValue>).booking;
      } catch {}
      const note = hasBooking
        ? ' :warning: This reply confirms a meeting that is NOT booked yet. Book it in Calendly manually, or use *Send Reply* to auto-book.'
        : '';
      await updateViaResponseUrl(
        payload.response_url,
        `:pencil2: Opened in Unibox for manual edit at ${now}.${note}`,
      );
      return;
    }

    case 'skip': {
      const userTag = payload.user?.id ? `<@${payload.user.id}>` : 'a teammate';
      await updateViaResponseUrl(
        payload.response_url,
        `:next_track_button: Skipped at ${now} by ${userTag}`,
      );
      return;
    }

    case 'open_unibox':
      return;

    default:
      console.warn('[slack-action] unknown action_id:', action.action_id);
      return;
  }
}

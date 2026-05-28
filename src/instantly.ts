import axios, { AxiosError, AxiosRequestConfig } from 'axios';
import { env } from './env';

const BASE_URL = 'https://api.instantly.ai/api/v2';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function instantlyRequest<T = any>(
  config: AxiosRequestConfig,
  attempt = 0,
): Promise<T> {
  const apiKey = env('INSTANTLY_API_KEY');
  try {
    const res = await axios.request<T>({
      baseURL: BASE_URL,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(config.headers || {}),
      },
      timeout: 15000,
      ...config,
    });
    return res.data;
  } catch (err) {
    const ax = err as AxiosError;
    const status = ax.response?.status;
    const retriable = status === 429 || (status !== undefined && status >= 500);
    if (retriable && attempt < 3) {
      const backoff = 500 * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
      console.warn(
        `[instantly] retriable error ${status} on ${config.method} ${config.url}, retrying in ${backoff}ms (attempt ${attempt + 1}/3)`,
      );
      await sleep(backoff);
      return instantlyRequest<T>(config, attempt + 1);
    }
    const respData = ax.response?.data;
    console.error(
      `[instantly] request failed: ${config.method} ${config.url} status=${status}`,
      typeof respData === 'string' ? respData : JSON.stringify(respData),
    );
    throw new Error(
      `Instantly API error (${status ?? 'no-status'}) on ${config.method} ${config.url}: ${ax.message}`,
    );
  }
}

export interface ReplyToEmailParams {
  reply_to_uuid: string;
  eaccount: string;
  subject: string;
  body: { text: string; html?: string };
}

export async function replyToEmail(params: ReplyToEmailParams): Promise<void> {
  const html =
    params.body.html ??
    `<div>${escapeHtml(params.body.text).replace(/\n/g, '<br>')}</div>`;
  await instantlyRequest({
    method: 'POST',
    url: '/emails/reply',
    data: {
      eaccount: params.eaccount,
      reply_to_uuid: params.reply_to_uuid,
      subject: params.subject,
      body: {
        text: params.body.text,
        html,
      },
    },
  });
}

// Instantly v2 lead endpoints require lead UUIDs, not emails.
// "interest_status": 1=interested, 2=meeting_booked, 3=meeting_completed, 4=closed, -1=not_interested, -2=wrong_person, -3=lost

async function findLeadIdByEmail(
  campaign_id: string,
  lead_email: string,
): Promise<string | null> {
  const res = await instantlyRequest<{
    items?: Array<{ id: string; email: string }>;
  }>({
    method: 'POST',
    url: '/leads/list',
    data: {
      campaign: campaign_id,
      search: lead_email,
      limit: 5,
    },
  });
  const items = res.items ?? [];
  const match = items.find(
    (i) => i.email && i.email.toLowerCase() === lead_email.toLowerCase(),
  );
  return match?.id ?? null;
}

async function updateInterestStatus(
  lead_id: string,
  interest_status: number,
): Promise<void> {
  await instantlyRequest({
    method: 'POST',
    url: '/leads/update-interest-status',
    data: {
      lead_ids: [lead_id],
      interest_status,
    },
  });
}

export async function markLeadNotInterested(
  campaign_id: string,
  lead_email: string,
): Promise<void> {
  const id = await findLeadIdByEmail(campaign_id, lead_email);
  if (!id) {
    console.warn(
      `[instantly] markLeadNotInterested: lead not found for ${lead_email} in campaign ${campaign_id}`,
    );
    return;
  }
  await updateInterestStatus(id, -1);
}

export async function markLeadInterested(
  campaign_id: string,
  lead_email: string,
): Promise<void> {
  const id = await findLeadIdByEmail(campaign_id, lead_email);
  if (!id) {
    console.warn(
      `[instantly] markLeadInterested: lead not found for ${lead_email} in campaign ${campaign_id}`,
    );
    return;
  }
  await updateInterestStatus(id, 1);
}

export async function updateLeadVariables(
  lead_email: string,
  campaign_id: string,
  variables: Record<string, string>,
): Promise<void> {
  const id = await findLeadIdByEmail(campaign_id, lead_email);
  if (!id) {
    console.warn(
      `[instantly] updateLeadVariables: lead not found for ${lead_email}`,
    );
    return;
  }
  await instantlyRequest({
    method: 'PATCH',
    url: `/leads/${id}`,
    data: { custom_variables: variables },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

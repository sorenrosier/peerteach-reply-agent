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

export interface ThreadEmail {
  body: string;
  timestamp: string;
  isOutbound: boolean;
}

// Fetches the email thread for a lead. Falls back to empty array on any error.
export async function fetchEmailThread(
  campaignId: string,
  leadEmail: string,
): Promise<ThreadEmail[]> {
  try {
    const res = await instantlyRequest<{ items?: any[]; data?: any[] }>({
      method: 'GET',
      url: '/emails',
      params: {
        campaign_id: campaignId,
        lead: leadEmail,
        limit: 20,
      },
    });
    const items: any[] = res.items ?? res.data ?? [];
    const emails = items
      .filter((e: any) => {
        // Safety: only include emails that belong to this lead
        const itemLead = (e.lead_email ?? e.lead ?? '').toLowerCase();
        const itemTo = (e.to_address ?? e.to ?? '').toLowerCase();
        const itemFrom = (e.from_address ?? e.from ?? '').toLowerCase();
        const target = leadEmail.toLowerCase();
        // If the API returns a lead_email field, use it strictly
        if (itemLead) return itemLead === target;
        // Otherwise accept if to or from matches (outbound = to, inbound = from)
        if (itemTo || itemFrom) return itemTo === target || itemFrom === target;
        // No address fields at all — include and let Claude sort it out
        return true;
      })
      .map((e: any) => {
        // Parse recipient lists: prefer the structured *_json arrays, fall back to CSV strings.
        const addrList = (json: any, csv: any): string[] => {
          if (Array.isArray(json)) {
            return json.map((r: any) => (r?.address ?? r?.email ?? '').toLowerCase().trim()).filter(Boolean);
          }
          if (typeof csv === 'string') {
            return csv.split(',').map((s) => s.toLowerCase().trim()).filter(Boolean);
          }
          return [];
        };
        const eaccount = (e.eaccount ?? '').toLowerCase().trim();
        const from = (e.from_address_email ?? e.from_address ?? e.from ?? '').toLowerCase().trim();
        // Direction: explicit flag if present, otherwise an email FROM our own account is outbound.
        const isOutbound =
          e.is_sent !== undefined || e.is_outbound !== undefined
            ? !!(e.is_sent ?? e.is_outbound)
            : !!(eaccount && from === eaccount);
        return {
          body: (e.body?.text ?? e.text ?? e.reply_text ?? e.email_text ?? '').trim(),
          timestamp: e.timestamp ?? e.timestamp_email ?? e.created_at ?? e.date_created ?? '',
          isOutbound,
          from,
          to: addrList(e.to_address_json, e.to_address_email_list),
          cc: addrList(e.cc_address_json, e.cc_address_email_list),
        };
      })
      .filter((e) => e.body.length > 0)
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    console.log(`[instantly] fetchEmailThread: ${emails.length} emails for ${leadEmail}`);
    return emails;
  } catch (err) {
    console.warn(
      '[instantly] fetchEmailThread failed, proceeding without thread:',
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

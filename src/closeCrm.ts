import axios, { AxiosInstance } from 'axios';
import { envOptional } from './env';

// Minimal Close CRM client (https://developer.close.com). Auth is HTTP basic with the API key as
// the username. Records are "created by" whoever owns the key.

let client: AxiosInstance | null = null;
function close(): AxiosInstance {
  const key = envOptional('CLOSE_API_KEY');
  if (!key) throw new Error('CLOSE_API_KEY is not set');
  if (!client) {
    client = axios.create({ baseURL: 'https://api.close.com/api/v1/', auth: { username: key, password: '' }, timeout: 15000 });
    // Close rate-limits with 429 + a retry hint; wait it out once or twice.
    client.interceptors.response.use(undefined, async (err) => {
      const cfg = err.config || {};
      if (err.response?.status === 429 && (cfg.__tries = (cfg.__tries || 0) + 1) <= 2) {
        const wait = Number(err.response.headers?.['retry-after'] || err.response.data?.error?.rate_reset || 2);
        await new Promise((r) => setTimeout(r, Math.min(wait, 10) * 1000));
        return client!.request(cfg);
      }
      throw err;
    });
  }
  return client;
}

export function closeErrorText(err: unknown): string {
  const e = err as any;
  const body = e?.response?.data ? JSON.stringify(e.response.data).slice(0, 300) : '';
  return `${e?.response?.status ?? ''} ${e?.message ?? String(err)} ${body}`.trim();
}

// Custom field IDs by name, per object type (looked up once per run, so renamed or newly added
// fields keep working).
type FieldKind = 'lead' | 'contact' | 'opportunity';
const fieldCache = new Map<FieldKind, Map<string, string>>();
export async function customFieldIds(kind: FieldKind): Promise<Map<string, string>> {
  const hit = fieldCache.get(kind);
  if (hit) return hit;
  const res = await close().get(`custom_field/${kind}/`, { params: { _limit: 200 } });
  const map = new Map<string, string>((res.data.data ?? []).map((f: any) => [String(f.name).toLowerCase(), f.id]));
  fieldCache.set(kind, map);
  return map;
}

// A text lead custom field's ID, creating the field if it doesn't exist yet.
export async function ensureLeadTextField(name: string): Promise<string> {
  const map = await customFieldIds('lead');
  const existing = map.get(name.toLowerCase());
  if (existing) return existing;
  const res = await close().post('custom_field/lead/', { name, type: 'text' });
  map.set(name.toLowerCase(), res.data.id);
  return res.data.id;
}

export interface CloseLead {
  id: string;
  name: string;
  contacts: Array<{ id: string; name?: string; emails?: Array<{ email: string }> }>;
  opportunities: Array<{ id: string; status_type: string }>;
  custom: Record<string, any>; // custom field id -> value
}

function toLead(d: any): CloseLead {
  const custom: Record<string, any> = {};
  for (const [k, v] of Object.entries(d)) if (k.startsWith('custom.')) custom[k.slice(7)] = v;
  return { id: d.id, name: d.name, contacts: d.contacts ?? [], opportunities: d.opportunities ?? [], custom };
}

// Leads matching a Close search query (the lead search syntax), full records.
async function searchLeads(query: string): Promise<CloseLead[]> {
  const res = await close().get('lead/', { params: { query, _limit: 25 } });
  return (res.data.data ?? []).map(toLead);
}

// The lead that has a contact with exactly this email, if any.
export async function findLeadByContactEmail(email: string): Promise<{ lead: CloseLead; contactId: string } | null> {
  const want = email.toLowerCase();
  for (const lead of await searchLeads(`email:"${email}"`)) {
    const c = lead.contacts.find((x) => (x.emails ?? []).some((e) => e.email.toLowerCase() === want));
    if (c) return { lead, contactId: c.id };
  }
  return null;
}

// The lead whose custom field (by name) equals any of the given values. Used for School NCES,
// which older records stored without leading zeros (so both forms are passed in).
export async function findLeadByCustomField(fieldName: string, values: string[]): Promise<CloseLead | null> {
  const ids = await customFieldIds('lead');
  const fieldId = ids.get(fieldName.toLowerCase());
  if (!fieldId) return null;
  for (const v of [...new Set(values.filter(Boolean))]) {
    for (const lead of await searchLeads(`"custom.${fieldName}":"${v}"`)) {
      if (values.includes(String(lead.custom[fieldId] ?? ''))) return lead;
    }
  }
  return null;
}

// A lead as the paginated listing returns it: only what was asked for. `name` is the lead's own
// name (blank on unnamed leads); `displayName` is what Close shows, which falls back to a contact.
export interface CloseLeadRow {
  id: string;
  name: string;
  displayName: string;
  dateCreated: string;
  custom: Record<string, any>; // custom field id -> value
}

// Every lead matching a Close search query, page by page, carrying only the listed custom
// fields. For jobs that match many leads in memory instead of running one search per record.
// Throws rather than return a partial list, so a caller never mistakes a cut-off for "no lead".
export async function listLeads(query: string, customFieldIdList: string[]): Promise<CloseLeadRow[]> {
  const _fields = ['id', 'name', 'display_name', 'date_created', ...customFieldIdList.map((id) => `custom.${id}`)].join(',');
  const out: CloseLeadRow[] = [];
  for (let page = 0; page < 300; page++) {
    const res = await close().get('lead/', { params: { query, _fields, _limit: 100, _skip: out.length } });
    const rows: any[] = res.data.data ?? [];
    for (const d of rows) out.push({ id: d.id, name: d.name ?? '', displayName: d.display_name ?? '', dateCreated: d.date_created ?? '', custom: toLead(d).custom });
    if (!res.data.has_more || !rows.length) return out;
  }
  throw new Error(`listLeads: more than ${out.length} leads match ${query}`);
}

export async function createLead(body: Record<string, any>): Promise<CloseLead> {
  const res = await close().post('lead/', body);
  return toLead(res.data);
}

export async function updateLead(leadId: string, body: Record<string, any>): Promise<void> {
  await close().put(`lead/${leadId}/`, body);
}

export async function createContact(body: Record<string, any>): Promise<string> {
  const res = await close().post('contact/', body);
  return res.data.id;
}

export async function createOpportunity(body: Record<string, any>): Promise<string> {
  const res = await close().post('opportunity/', body);
  return res.data.id;
}

export function closeLeadUrl(leadId: string): string {
  return `https://app.close.com/lead/${leadId}/`;
}

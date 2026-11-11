import axios from 'axios';
import { envOptional, PEERTEACH_API_URL_DEFAULT, PEERTEACH_DEMO_PAGE } from './env';
import { getLeadVariables, updateLeadVariables } from './instantly';

// Personal links to Remy's demo, made in PeerTeach's backend (peer-teach/peerteach-match,
// POST /admin/ai-agents/links), which stores each link and its expiry against the visitor's
// name/email/school/state. A link works a few times (5 calls) for 30 days.
//
// We also keep the link on the Instantly lead (demo_link, demo_link_token,
// demo_link_expires_at), so a second interested reply reuses the same link instead of minting
// a new one each time, and so the link is visible next to the lead.
//
// Auth is an admin login token for soren@peerteach.org with no expiry (PEERTEACH_ADMIN_TOKEN),
// chosen as a stopgap while a narrower link-only key on the backend waits for Krishan.

const VAR_URL = 'demo_link';
const VAR_TOKEN = 'demo_link_token';
const VAR_EXPIRES = 'demo_link_expires_at';
// Who the stored link greets (set on links made after 2026-11-09; older links don't have them).
const VAR_LINK_SCHOOL = 'demo_link_school';
const VAR_LINK_NAME = 'demo_link_name';
// Corrections the teacher gave us (they moved schools, or go by another name), so a later
// link uses them too.
const VAR_CURRENT_SCHOOL = 'current_school';
const VAR_NAME = 'demo_name';
// Don't hand out a link that expires within this window — mint a fresh one instead.
const MIN_DAYS_LEFT = 3;

export class DemoLinkError extends Error {
  constructor(public reason: 'not_configured' | 'missing_fields' | 'backend_error', message: string) {
    super(message);
  }
}

export interface DemoLink {
  url: string;
  token: string;
  expiresAt: string;
  reused: boolean;
}

export interface DemoVisitor {
  campaignId: string;
  email: string;
  name: string;
  school: string;
  state: string;
  // Set when the teacher's own words correct the lead's details. `school` / `name` are what the
  // link should greet; `savedSchool` / `savedFirstName` are what to remember on the lead (a
  // district stand-in for an unnamed new school isn't remembered, so a named one can replace it).
  override?: { school?: string; name?: string; savedSchool?: string; savedFirstName?: string };
}

function apiUrl(): string {
  return (envOptional('PEERTEACH_API_URL') || PEERTEACH_API_URL_DEFAULT).replace(/\/$/, '');
}

export function demoLinkUrl(token: string): string {
  return `${PEERTEACH_DEMO_PAGE}?link=${encodeURIComponent(token)}`;
}

function hasDaysLeft(expiresAt: string | undefined, days: number): boolean {
  const t = expiresAt ? Date.parse(expiresAt.endsWith('Z') || /[+-]\d\d:?\d\d$/.test(expiresAt) ? expiresAt : expiresAt + 'Z') : NaN;
  return Number.isFinite(t) && t - Date.now() > days * 86400000;
}

// Whether a stored link can still be handed out. Asks the backend (public, read-only: looking
// a link up doesn't use it). If the backend can't be reached, trusts the stored expiry rather
// than minting a duplicate.
async function stillUsable(token: string, storedExpiry: string | undefined): Promise<boolean> {
  try {
    const res = await axios.get(`${apiUrl()}/ai-agents/demo/links/${encodeURIComponent(token)}`, {
      timeout: 8000,
      validateStatus: () => true,
    });
    const d = res.data || {};
    if (!d.success) return false; // not_found / expired / used_up
    return (d.usesLeft ?? 0) > 0 && hasDaysLeft(d.expiresAt, MIN_DAYS_LEFT);
  } catch {
    return hasDaysLeft(storedExpiry, MIN_DAYS_LEFT);
  }
}

// The lead's existing link if it's still good, otherwise a new one.
export async function getOrCreateDemoLink(v: DemoVisitor): Promise<DemoLink> {
  const vars = await getLeadVariables(v.campaignId, v.email).catch(() => ({} as Record<string, string>));
  const o = v.override || {};
  const corrected = Boolean(o.school || o.name);
  const school = o.school || vars[VAR_CURRENT_SCHOOL] || v.school;
  const name = o.name || vars[VAR_NAME] || v.name;

  // With a correction in this reply, only a link already made for that school and name will do;
  // otherwise any stored link that still works (it was made with the best details we had).
  const storedToken = vars[VAR_TOKEN];
  const matches = !corrected || (vars[VAR_LINK_SCHOOL] === school && vars[VAR_LINK_NAME] === name);
  if (storedToken && matches && (await stillUsable(storedToken, vars[VAR_EXPIRES]))) {
    return { url: demoLinkUrl(storedToken), token: storedToken, expiresAt: vars[VAR_EXPIRES] || '', reused: true };
  }

  const adminToken = envOptional('PEERTEACH_ADMIN_TOKEN');
  if (!adminToken) throw new DemoLinkError('not_configured', 'PEERTEACH_ADMIN_TOKEN is not set');

  // The backend requires all three; state is optional (Remy asks if it's missing).
  const missing = [!name && 'name', !v.email && 'email', !school && 'school'].filter(Boolean);
  if (missing.length) throw new DemoLinkError('missing_fields', `lead has no ${missing.join(', ')}`);

  const res = await axios.post(
    `${apiUrl()}/admin/ai-agents/links`,
    { name, email: v.email, school, state: v.state, provider: 'openai' },
    { headers: { Authorization: `Bearer ${adminToken}` }, timeout: 15000, validateStatus: () => true },
  );
  if (res.status !== 200 || !res.data?.success || !res.data?.token) {
    throw new DemoLinkError('backend_error', `create link failed (${res.status}): ${JSON.stringify(res.data).slice(0, 200)}`);
  }
  const link: DemoLink = { url: demoLinkUrl(res.data.token), token: res.data.token, expiresAt: res.data.expiresAt, reused: false };

  try {
    await updateLeadVariables(v.email, v.campaignId, {
      [VAR_URL]: link.url,
      [VAR_TOKEN]: link.token,
      [VAR_EXPIRES]: link.expiresAt,
      [VAR_LINK_SCHOOL]: school,
      [VAR_LINK_NAME]: name,
      ...(o.savedSchool ? { [VAR_CURRENT_SCHOOL]: o.savedSchool } : {}),
      ...(o.savedFirstName && o.name ? { [VAR_NAME]: o.name } : {}),
    });
  } catch (err) {
    // The link exists and works either way; losing the record only means the next reply mints another.
    console.warn('[demoLinks] could not save link on the lead:', err instanceof Error ? err.message : String(err));
  }
  return link;
}

import axios from 'axios';
import { getAccessToken } from './googleCalendar';
import { findLeadByEmailAnyCampaign, getCampaignName, LeadLookup } from './instantly';
import { envOptional, SOREN_EMAIL } from './env';
import { postInfoNote } from './slack';
import { findSchoolInDistrict, getSchoolStats, padNces, PRICE_PER_STUDENT, SchoolStats } from './schoolData';
import {
  CloseLead,
  closeErrorText,
  closeLeadUrl,
  createContact,
  createLead,
  createOpportunity,
  customFieldIds,
  ensureLeadTextField,
  findLeadByContactEmail,
  findLeadByCustomField,
  updateLead,
} from './closeCrm';

// Puts everyone who books a call into Close, the way King used to by hand: the school as a
// lead (with NCES IDs, address and public stats), the person as a contact, and an opportunity
// at "Demo Scheduled". Replaces King's spreadsheet process (Soren, 2026-11-12).
//
// Runs on a schedule over Katie's and Soren's calendars (bookings from Calendly and from the
// reply agent both land there). Each calendar event is processed once: it's tagged
// close_sync=done via extendedProperties, the same pattern as calendlySync.ts. Only attendees
// who are Instantly leads are synced (that's where the school data comes from); other guests on
// the same booking are added as extra contacts on that school's lead.
//
// Duplicates: before creating anything it looks for the person's email in Close, then for the
// school by School NCES, in both the 12-digit form and the leading-zero-stripped form older
// records used. An existing school gets the new contact and an opportunity (if it has no active
// one); empty fields are filled in, existing values are never overwritten.
//
// CLOSE_SYNC_MODE=live writes to Close. Anything else (the default) is a dry run: it reads Close
// and the public data, logs what it would do, and writes nothing and tags nothing.

const LEAD_STATUS_POTENTIAL = 'stat_kkTYEatbgiYoFWQmVetjI0U6poNyLqvV9XKjRkShVo3';
const OPP_STATUS_DEMO_SCHEDULED = 'stat_QY3C0jsXiiJhg0XhUitqLw769EGgdIqQZzceIWoecij';
const OPP_CONFIDENCE = 50;
const OPP_CLOSE_DAYS = 61; // King's convention: expected close about two months out
const INSTANTLY_WORKSPACE = 'c123c474-887d-4bdb-92d2-bc28fcb0ab43';
const OWN_DOMAINS = /@(peerteach\.org|[a-z0-9-]*peerteach[a-z0-9-]*\.[a-z.]+)$/i;
const FREE_MAIL = /@(gmail|yahoo|hotmail|outlook|icloud|aol|live|msn|me|comcast|protonmail)\./i;
// Time budget: stop starting new bookings after this, so the run finishes inside its limit.
const RUN_BUDGET_MS = 70_000;
// Meetings this far back still get synced (widened from 3 to 8 days at go-live, 2026-11-19, so
// the past week's bookings are caught; already-synced events are tagged and skipped).
const LOOKBACK_DAYS = 8;

export const isLive = () => envOptional('CLOSE_SYNC_MODE') === 'live';

type Persona = 'Teacher' | 'Site Admin' | 'District Admin' | 'Instructional Leader';

export function personaFor(personaField: string, campaignName: string): Persona | undefined {
  const p = `${personaField}`.toLowerCase();
  if (p.includes('teacher')) return 'Teacher';
  if (/district|superintendent/.test(p)) return 'District Admin';
  if (/coach|coordinator|specialist|instructional|curriculum/.test(p)) return 'Instructional Leader';
  if (/principal|admin|site/.test(p)) return 'Site Admin';
  const c = campaignName.toLowerCase();
  if (c.includes('teacher')) return 'Teacher';
  if (c.includes('district')) return 'District Admin';
  if (c.includes('site admin') || c.includes('principal')) return 'Site Admin';
  return undefined;
}

const TITLE_FOR: Record<Persona, string> = {
  Teacher: 'Teacher',
  'Site Admin': 'Principal',
  'District Admin': 'District Administrator',
  'Instructional Leader': 'Instructional Leader',
};

// The school year a booking belongs to, as Close's choice values spell it ("26-27").
export function schoolYear(d = new Date()): string {
  const y = d.getUTCFullYear() % 100;
  const start = d.getUTCMonth() >= 6 ? y : y - 1; // July starts a new school year
  return `${String(start).padStart(2, '0')}-${String(start + 1).padStart(2, '0')}`;
}

function websiteFor(email: string): string | undefined {
  const domain = email.split('@')[1];
  return domain && !FREE_MAIL.test(email) ? `https://www.${domain}` : undefined;
}

export interface CloseSyncOutcome {
  email: string;
  action: 'created_lead' | 'added_to_existing_lead' | 'opportunity_added' | 'already_in_close' | 'would_create_lead' | 'would_add_to_existing_lead' | 'would_add_opportunity' | 'deferred' | 'error';
  leadId?: string;
  detail?: string;
}

export interface CloseSyncResult {
  mode: 'live' | 'dry';
  events: number;
  processed: number;
  deferred: number;
  outcomes: CloseSyncOutcome[];
}

interface Booking {
  calendarEmail?: string;
  eventId: string;
  start: string;
  guests: Array<{ email: string; name?: string }>;
}

async function listBookings(calendarEmail?: string): Promise<{ token: string; items: any[] }> {
  const token = await getAccessToken(calendarEmail);
  const res = await axios.get('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    headers: { Authorization: `Bearer ${token}` },
    params: { timeMin: new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString(), timeMax: new Date(Date.now() + 60 * 86400000).toISOString(), singleEvents: true, maxResults: 250 },
    timeout: 15000,
  });
  return { token, items: res.data.items ?? [] };
}

async function tagEvent(token: string, eventId: string, value: string): Promise<void> {
  await axios.patch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`,
    { extendedProperties: { private: { close_sync: value } } },
    { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 },
  );
}

export async function runCloseSync(opts: { maxBookings?: number; skipFirst?: number } = {}): Promise<CloseSyncResult> {
  const live = isLive();
  const t0 = Date.now();
  const result: CloseSyncResult = { mode: live ? 'live' : 'dry', events: 0, processed: 0, deferred: 0, outcomes: [] };
  // A dry run tags nothing, so it would re-read the same first bookings every run. Instead each
  // run in the hour takes a different slice of 12 (by quarter hour), covering ~48 bookings an
  // hour without eating the Instantly rate limit the live agent shares (20 requests/minute).
  const maxBookings = opts.maxBookings ?? (live ? 3 : 12);
  const skipFirst = live ? 0 : opts.skipFirst ?? Math.floor(new Date().getUTCMinutes() / 15) * 12;
  let seen = 0;

  for (const calendarEmail of [undefined, SOREN_EMAIL]) {
    let token: string, items: any[];
    try {
      ({ token, items } = await listBookings(calendarEmail));
    } catch (err) {
      console.warn(`[closeSync] couldn't read ${calendarEmail || 'Katie'}'s calendar:`, closeErrorText(err));
      continue;
    }
    for (const item of items) {
      if (item.status === 'cancelled') continue;
      const priv = item.extendedProperties?.private ?? {};
      if (priv.peerteach_hold || priv.close_sync) continue;
      const guests = ((item.attendees ?? []) as any[])
        .filter((a) => a?.email && !a.self && !a.organizer && !OWN_DOMAINS.test(a.email))
        .map((a) => ({ email: String(a.email).toLowerCase().trim(), name: a.displayName || undefined }));
      if (!guests.length) continue;
      result.events++;
      if (seen++ < skipFirst) continue;
      if (result.processed >= maxBookings || Date.now() - t0 > RUN_BUDGET_MS) { result.deferred++; continue; }

      const booking: Booking = { calendarEmail, eventId: item.id, start: item.start?.dateTime || item.start?.date || '', guests };
      result.processed++;
      const outcomes = await syncBooking(booking);
      result.outcomes.push(...outcomes);
      // Errors and deferrals (public data didn't load) leave the event untagged for the next run.
      const failed = outcomes.some((o) => o.action === 'error' || o.action === 'deferred');
      if (live && !failed) {
        try { await tagEvent(token, item.id, 'done'); } catch (err) { console.warn('[closeSync] tag failed:', closeErrorText(err)); }
      }
    }
  }
  console.log(`[closeSync] ${JSON.stringify({ mode: result.mode, events: result.events, processed: result.processed, deferred: result.deferred })}`);
  for (const o of result.outcomes) console.log(`[closeSync] ${o.action} ${o.email}${o.leadId ? ' ' + o.leadId : ''}${o.detail ? ' :: ' + o.detail : ''}`);
  return result;
}

// One booking: each guest who's an Instantly lead gets synced; other guests ride along as extra
// contacts on the first synced lead.
async function syncBooking(b: Booking): Promise<CloseSyncOutcome[]> {
  const outcomes: CloseSyncOutcome[] = [];
  const leads: Array<{ guest: Booking['guests'][number]; lead: LeadLookup }> = [];
  const others: Booking['guests'] = [];
  for (const g of b.guests) {
    try {
      // Pace Instantly lookups: the API's 20 requests/minute is shared with the live reply agent.
      await new Promise((r) => setTimeout(r, 3000));
      const lead = await findLeadByEmailAnyCampaign(g.email);
      if (lead) leads.push({ guest: g, lead }); else { others.push(g); console.log(`[closeSync] not an Instantly lead: ${g.email}`); }
    } catch (err) {
      outcomes.push({ email: g.email, action: 'error', detail: `Instantly lookup: ${closeErrorText(err)}` });
    }
  }
  let firstLeadId: string | undefined;
  for (const { guest, lead } of leads) {
    try {
      const o = await syncPerson(guest, lead, b.start);
      outcomes.push(o);
      firstLeadId = firstLeadId || o.leadId;
    } catch (err) {
      outcomes.push({ email: guest.email, action: 'error', detail: closeErrorText(err) });
    }
  }
  // Colleagues on the invite who aren't Instantly leads: extra contacts on the same school.
  if (firstLeadId && others.length) {
    for (const g of others) {
      try {
        const existing = await findLeadByContactEmail(g.email);
        if (existing) continue;
        if (isLive()) await createContact({ lead_id: firstLeadId, name: g.name || g.email.split('@')[0], emails: [{ type: 'office', email: g.email }] });
        console.log(`[closeSync] ${isLive() ? 'added' : 'would add'} guest ${g.email} to ${firstLeadId}`);
      } catch (err) {
        outcomes.push({ email: g.email, action: 'error', detail: `guest contact: ${closeErrorText(err)}` });
      }
    }
  }
  return outcomes;
}

// Public data sometimes fails to load (the API times out). Rather than create a record without
// its numbers, wait for a later run unless the meeting is about to start.
const DEFER_IF_MEETING_MORE_THAN_MS = 2 * 3600_000;
function shouldDefer(stats: SchoolStats, schoolNces: string, meetingStart: string): boolean {
  const key = schoolNces ? ['school directory', 'school grades 3-9'] : ['district grades 3-9'];
  const gap = stats.missing.some((m) => key.includes(m));
  const startMs = Date.parse(meetingStart);
  return gap && Number.isFinite(startMs) && startMs - Date.now() > DEFER_IF_MEETING_MORE_THAN_MS;
}

async function syncPerson(guest: { email: string; name?: string }, lead: LeadLookup, meetingStart: string): Promise<CloseSyncOutcome> {
  const live = isLive();
  const p = lead.payload;
  const campaignName = (lead.campaignId && (await getCampaignName(lead.campaignId))) || '';
  const persona = personaFor(String(p.persona ?? p.Persona ?? ''), campaignName);
  // The name they go by (set by the teacher agent when they sign differently), then the lead's.
  const preferred = String(p.demo_name || '').trim();
  const name = preferred || [lead.firstName, lead.lastName].filter(Boolean).join(' ').trim() || guest.name || guest.email;
  let schoolNces = padNces(p.nces_school_id ?? p['NCES School ID'], 12);
  const districtNces = padNces(p.nces_district_id ?? p['NCES District ID'], 7) || (schoolNces ? schoolNces.slice(0, 7) : '');
  const channelDetails = campaignName ? `Campaign: ${campaignName}` : '';

  // A teacher who told us they moved (the teacher agent saves current_school): use that school,
  // found by name in their district. If it can't be found, the lead is named for it but carries
  // only district data, never the old school's NCES ID or stats.
  let schoolNameOverride: string | undefined;
  const current = String(p.current_school || '').trim();
  if (current && current.toLowerCase() !== String(p.school_name || '').trim().toLowerCase()) {
    const found = await findSchoolInDistrict(districtNces, current);
    schoolNces = found ? padNces(found.ncessch, 12) : '';
    schoolNameOverride = found?.name || current;
  }

  // 1. The person is already in Close: leave their lead alone, whatever its opportunities say.
  // A closed one may be a decision Katie made (Do Not Contact, nurture), and the booking may not
  // be a demo at all (a study debrief, a check-in). Found 2026-11-19: ROE #12 and South Range
  // would otherwise have been given a fresh Demo Scheduled opportunity.
  const byEmail = await findLeadByContactEmail(guest.email);
  if (byEmail) {
    const active = byEmail.lead.opportunities.some((o) => o.status_type === 'active');
    return { email: guest.email, action: 'already_in_close', leadId: byEmail.lead.id, ...(active ? {} : { detail: 'no active opportunity; left as is' }) };
  }

  const stats = await getSchoolStats(schoolNces, districtNces);
  if (shouldDefer(stats, schoolNces, meetingStart)) return { email: guest.email, action: 'deferred', detail: `public data missing: ${stats.missing.join(', ')}` };
  const leadFields = await leadCustomFields(schoolNameOverride ? { ...p, 'School/District Nickname': schoolNameOverride } : p, stats, schoolNces, districtNces, live);
  const contact = await contactBody(name, guest.email, persona);

  // 2. The school is already in Close (by NCES, with or without leading zeros).
  const unpadded = schoolNces.replace(/^0+/, '');
  const school = schoolNces ? await findLeadByCustomField('School NCES', [schoolNces, unpadded]) : null;
  if (school) {
    if (!live) return { email: guest.email, action: 'would_add_to_existing_lead', leadId: school.id, detail: `${school.name}; ${oppSummary(stats, persona, campaignName)}` };
    const contactId = await createContact({ lead_id: school.id, ...contact });
    const fill = missingOnly(school, leadFields);
    if (Object.keys(fill).length) await updateLead(school.id, fill);
    if (!school.opportunities.some((o) => o.status_type === 'active')) {
      await createOpportunity(await opportunityBody(school.id, contactId, stats, persona, channelDetails));
    }
    await note(`:card_index: Added ${name} (${persona ?? 'persona unknown'}) to ${school.name} in Close`, school.id);
    return { email: guest.email, action: 'added_to_existing_lead', leadId: school.id };
  }

  // 3. New school.
  const schoolName = String(schoolNameOverride || p.school_name || stats.schoolName || p['School/District Nickname'] || '').trim() || `${name}'s school`;
  if (!live) return { email: guest.email, action: 'would_create_lead', detail: `${schoolName}; ${oppSummary(stats, persona, campaignName)}; fields ${JSON.stringify(leadFields)}; missing data: ${stats.missing.join(', ') || 'none'}` };
  const created = await createLead({
    name: schoolName,
    status_id: LEAD_STATUS_POTENTIAL,
    ...(websiteFor(guest.email) ? { url: websiteFor(guest.email) } : {}),
    ...(stats.address ? { addresses: [{ label: 'business', address_1: stats.address.street, city: stats.address.city, state: stats.address.state, zipcode: stats.address.zip, country: 'US' }] } : {}),
    contacts: [contact],
    ...leadFields,
  });
  const contactId = created.contacts[0]?.id;
  await createOpportunity(await opportunityBody(created.id, contactId, stats, persona, channelDetails));
  await note(`:card_index: Added ${name} (${persona ?? 'persona unknown'}) at ${schoolName} to Close`, created.id, stats.missing);
  return { email: guest.email, action: 'created_lead', leadId: created.id };
}

async function note(text: string, leadId: string, missing: string[] = []): Promise<void> {
  try {
    await postInfoNote(`${text}: <${closeLeadUrl(leadId)}|open in Close>${missing.length ? ` (couldn't get: ${missing.join(', ')})` : ''}`);
  } catch {}
}

function oppSummary(stats: SchoolStats, persona: string | undefined, campaign: string): string {
  return `opp ${stats.schoolGrades3to9 !== undefined ? `$${stats.schoolGrades3to9 * PRICE_PER_STUDENT}` : '(no value)'}, persona ${persona ?? '?'}, campaign "${campaign}"`;
}

// Lead custom fields as Close's "custom.<id>" keys. Only fields we have values for.
async function leadCustomFields(p: Record<string, any>, stats: SchoolStats, schoolNces: string, districtNces: string, live: boolean): Promise<Record<string, string>> {
  const ids = await customFieldIds('lead');
  const values: Record<string, string | undefined> = {
    District: String(p.district_name || p['District Name'] || stats.districtName || '').trim() || undefined,
    'District NCES': districtNces || undefined,
    'School NCES': schoolNces || undefined,
    'School/District Nickname': String(p['School/District Nickname'] || '').trim() || undefined,
    'School Opportunity': stats.schoolOpportunity,
    'District Opportunity': stats.districtOpportunity,
    'School FRL %': stats.schoolFrlPct,
    'District FRL %': stats.districtFrlPct,
    'School Hispanic Students %': stats.schoolHispanicPct,
    'District Hispanic Student %': stats.districtHispanicPct,
    'School English Learner %': stats.schoolElPct,
    'District English Learner %': stats.districtElPct,
  };
  const out: Record<string, string> = {};
  for (const [fieldName, v] of Object.entries(values)) {
    if (!v) continue;
    let id = ids.get(fieldName.toLowerCase());
    // The English Learner fields are new (King's sheet had no EL data); create them on first use.
    if (!id && live && fieldName.includes('English Learner')) id = await ensureLeadTextField(fieldName);
    out[`custom.${id || `(new field) ${fieldName}`}`] = v;
  }
  return out;
}

// Only the fields the existing lead doesn't have a value for yet.
function missingOnly(lead: CloseLead, fields: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) {
    const id = k.slice('custom.'.length);
    const cur = lead.custom[id];
    if (cur === undefined || cur === null || cur === '') out[k] = v;
  }
  return out;
}

async function contactBody(name: string, email: string, persona: Persona | undefined): Promise<Record<string, any>> {
  const ids = await customFieldIds('contact');
  const body: Record<string, any> = {
    name,
    ...(persona ? { title: TITLE_FOR[persona] } : {}),
    emails: [{ type: 'office', email }],
    urls: [{ type: 'url', url: `https://app.instantly.ai/app/unibox?thread_search=${encodeURIComponent(email)}&selected_wks=${INSTANTLY_WORKSPACE}` }],
  };
  const channel = ids.get('channel');
  if (channel) body[`custom.${channel}`] = 'Cold Email';
  const personaId = ids.get('persona');
  if (personaId && persona) body[`custom.${personaId}`] = persona;
  return body;
}

async function opportunityBody(leadId: string, contactId: string | undefined, stats: SchoolStats, persona: Persona | undefined, channelDetails: string): Promise<Record<string, any>> {
  const ids = await customFieldIds('opportunity');
  const close = new Date(Date.now() + OPP_CLOSE_DAYS * 86400000).toISOString().slice(0, 10);
  const body: Record<string, any> = {
    lead_id: leadId,
    ...(contactId ? { contact_id: contactId } : {}),
    status_id: OPP_STATUS_DEMO_SCHEDULED,
    confidence: OPP_CONFIDENCE,
    // Close stores values in cents.
    value: (stats.schoolGrades3to9 ?? 0) * PRICE_PER_STUDENT * 100,
    value_period: 'one_time',
    date_won: close, // Close uses date_won as the expected close date for active opportunities
    ...(channelDetails ? { note: channelDetails } : {}),
  };
  const set = (name: string, v: string | undefined) => { const id = ids.get(name); if (id && v) body[`custom.${id}`] = v; };
  set('channel', 'Cold Outreach');
  set('channel details', channelDetails);
  set('persona', persona);
  set('school year', schoolYear());
  return body;
}

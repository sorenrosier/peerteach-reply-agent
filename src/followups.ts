import { hasRealBookingForLead } from './googleCalendar';
import { listLeadEmails, findLeadByEmailAnyCampaign, replyToEmail, listRecentSentEmails, isAgentSendAt, SentEmail } from './instantly';
import { getSenderIdentity } from './agent';
import { CALENDLY_SCHEDULING_URL, isAutoSendEnabled } from './env';
import { postProactiveApproval, postInfoNote, replySubject } from './slack';
import { renderLinks } from './linkFormat';

// A follow-up is due once a Calendly link we sent has gone unanswered for this long, and stops
// being due after FOLLOWUP_WINDOW_END_HOURS (an hourly cron means each one is caught well inside it).
const FOLLOWUP_AFTER_HOURS = 24;
const FOLLOWUP_WINDOW_END_HOURS = 48;
// What marks an email as one that shared Katie's Calendly page.
const CALENDLY_MARKER = 'calendly.com/katie-peerteach';
// Fixed phrases from the follow-up wording above. A follow-up itself contains the Calendly link, so
// without this it would count as a fresh "offer" a day later and get followed up in turn.
const FOLLOWUP_MARKERS = ['so I wanted to check in and see if', 'in case my last note got buried', 'A quick nudge on this one'];
export function isFollowUpText(html: string): boolean {
  return FOLLOWUP_MARKERS.some((m) => html.includes(m));
}

const VARIANTS = [
  (n: string, link: string, sign: string) =>
    `Hi ${n},\n\nYou mentioned you were interested in PeerTeach, so I wanted to check in and see if you'd still like a quick 30-minute chat. I'd love to find a time that works for you. Here's [my Calendly](${link}) if you'd like to grab one.\n\n${sign}`,
  (n: string, link: string, sign: string) =>
    `Hi ${n},\n\nWanted to circle back in case my last note got buried. If you're still interested in a quick 30-minute chat, feel free to pick whatever time works best on [my Calendly](${link}), or just tell me what's easiest and I'll make it work.\n\n${sign}`,
  (n: string, link: string, sign: string) =>
    `Hi ${n},\n\nA quick nudge on this one. I'd still love to set up a short 30-minute call whenever it suits you. Here's [my Calendly](${link}) if you'd like to grab a time, and happy to work around your schedule if another day is better.\n\n${sign}`,
];

// Deterministic per lead, so a retry never produces a different message than the card showed.
export function buildFollowUpText(firstName: string, signOff: string, seed: string): string {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return VARIANTS[h % VARIANTS.length](firstName || 'there', CALENDLY_SCHEDULING_URL, signOff.replace(/\.$/, ''));
}

export interface FollowUpResult {
  checked: number;
  queued: number;
  sent: number;
  skipped: number;
  // Only filled in a dry run: what would have been posted, and why others were skipped.
  preview?: string[];
}

// One follow-up per Calendly-link email, 24 hours after the agent sent it with no reply. Katie's
// emails only. Candidates come straight from Instantly (agent-sent replies, 24 to 48 hours old,
// whose body links Katie's Calendly page, newest per lead), so this works however the email was
// worded and needs no calendar hold. Each candidate is then re-checked: nothing sent or received
// since (which also stops a follow-up from being followed up), the email really was the agent's
// and not a teammate's, the lead is still open, and nothing is booked. The follow-up is sent
// automatically (the team confirmed these work); a short note in Slack records each one. It
// follows the same AUTO_SEND_ENABLED kill switch as ordinary replies, so turning auto-send off
// sends follow-ups to Slack for approval again.
export async function runFollowUps(opts: { dryRun?: boolean } = {}): Promise<FollowUpResult> {
  const result: FollowUpResult = { checked: 0, queued: 0, sent: 0, skipped: 0, ...(opts.dryRun ? { preview: [] } : {}) };
  const nowSec = Date.now() / 1000;
  const sent = await listRecentSentEmails(new Date((nowSec - (FOLLOWUP_WINDOW_END_HOURS + 4) * 3600) * 1000).toISOString());

  // The latest Calendly-link email per lead inside the window.
  const latest = new Map<string, SentEmail>();
  for (const e of sent) {
    if (!e.lead || !e.html.includes(CALENDLY_MARKER) || isFollowUpText(e.html)) continue;
    if (e.t > nowSec - FOLLOWUP_AFTER_HOURS * 3600 || e.t < nowSec - FOLLOWUP_WINDOW_END_HOURS * 3600) continue;
    if (getSenderIdentity(e.eaccount).firstName !== 'Katie') continue;
    const cur = latest.get(e.lead);
    if (!cur || e.t > cur.t) latest.set(e.lead, e);
  }

  for (const offer of latest.values()) {
    result.checked++;
    try {
      const outcome = await followUpFor(offer, opts.dryRun ? result.preview : undefined);
      if (opts.dryRun) {
        result.preview!.push(`${offer.lead}: ${outcome}`);
        if (outcome === 'queued') result.queued++; else result.skipped++;
        continue;
      }
      if (outcome === 'sent') result.sent++;
      else if (outcome === 'queued') result.queued++;
      else result.skipped++;
    } catch (err) {
      console.warn(`[followups] ${offer.lead} failed (will retry next tick):`, err instanceof Error ? err.message : String(err));
    }
  }
  console.log(`[followups] sent-emails=${sent.length} candidates=${latest.size} queued=${result.queued} sent=${result.sent} skipped=${result.skipped}`);
  return result;
}

// previewSink: in a dry run, receives the draft that would have been posted instead of sending
// or posting anything.
async function followUpFor(offer: SentEmail, previewSink?: string[]): Promise<'sent' | 'queued' | 'skipped'> {
  const nowSec = Date.now() / 1000;
  const emails = await listLeadEmails(offer.lead);

  // Anything since the offer (a reply from them, or another message from us, a follow-up included)
  // means the conversation has moved on and a canned nudge would be wrong.
  const after = emails.filter((e) => e.t > offer.t + 5);
  if (after.some((e) => e.ue === 2 || e.ue === 3)) return 'skipped';

  const lead = await findLeadByEmailAnyCampaign(offer.lead);
  if (!lead) return 'skipped';
  if (lead.interestStatus < 0 || lead.interestStatus >= 2) return 'skipped'; // not interested / already booked / closed
  // Only the agent's own emails. Something Katie wrote by hand that happens to link her Calendly is
  // her conversation, not ours to nudge.
  if (!isAgentSendAt(lead.agentSendStamps, offer.t)) return 'skipped';
  if (await hasRealBookingForLead(offer.lead)) return 'skipped';

  const inbound = emails.filter((e) => e.ue === 2 && e.from === offer.lead).sort((a, b) => b.t - a.t)[0];
  if (!inbound) return 'skipped';
  const identity = getSenderIdentity(inbound.eaccount);
  if (identity.firstName !== 'Katie') return 'skipped';

  const first = (lead.firstName || '').trim().split(/\s+/)[0] || 'there';
  const leadName = [lead.firstName, lead.lastName].filter(Boolean).join(' ') || offer.lead;
  const campaignId = offer.campaignId || lead.campaignId;
  const draft = buildFollowUpText(first, identity.signOff, offer.lead);
  const subject = replySubject(inbound.subject);

  if (previewSink) {
    previewSink.push(`--- would post for ${offer.lead} (Calendly link sent ${Math.round((nowSec - offer.t) / 3600)}h ago):\n${draft}`);
    return 'queued';
  }

  if (isAutoSendEnabled()) {
    const rendered = renderLinks(draft);
    await replyToEmail({
      reply_to_uuid: inbound.id,
      eaccount: inbound.eaccount,
      subject,
      body: { text: rendered.plainText, html: rendered.html },
      stamp: { campaignId, leadEmail: offer.lead },
    });
    await postInfoNote(`:envelope: Sent a 24-hour follow-up to ${leadName} (<mailto:${offer.lead}|${offer.lead}>):\n>${rendered.slackMrkdwn.replace(/\n/g, '\n>')}`);
    return 'sent';
  }
  await postProactiveApproval({
    header: ':hourglass_flowing_sand: 24-hour follow-up — needs approval',
    why: `Katie's Calendly link was shared ${Math.round((nowSec - offer.t) / 3600)} hours ago with no reply or booking yet. This is a gentle nudge with the calendar link.`,
    name: leadName,
    leadEmail: offer.lead,
    campaignId,
    eaccount: inbound.eaccount,
    emailId: inbound.id,
    subject,
    draftText: draft,
  });
  return 'queued';
}

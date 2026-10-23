import { listProposedHolds, markHoldFollowUp, hasRealBookingForLead, HoldInfo } from './googleCalendar';
import { listLeadEmails, findLeadByEmailAnyCampaign, replyToEmail } from './instantly';
import { getSenderIdentity } from './agent';
import { CALENDLY_SCHEDULING_URL, isNewRuleAutoSendEnabled } from './env';
import { postProactiveApproval, postInfoNote, replySubject } from './slack';
import { renderLinks } from './linkFormat';

// A follow-up is due once a time offer has gone unanswered for this long. Holds are deleted
// at HOLD_TTL_HOURS (48 by default), so the window closes a little before that.
const FOLLOWUP_AFTER_HOURS = 24;
const FOLLOWUP_WINDOW_END_HOURS = 46;

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

// One follow-up per time offer, 24 hours after it was sent with no reply. Katie's offers only
// (they carry her Calendly link; Soren's don't). Offers still awaiting an answer are exactly
// the "proposed" holds that are still on the calendar: a new reply clears them and so does a
// booking, so a surviving hold means the lead hasn't responded. Each candidate is then
// re-checked against Instantly (the offer really went out, nothing was sent or received since,
// the lead is still open) and the hold is tagged so no later tick repeats it. The email goes to
// Slack for approval unless NEW_RULE_EMAILS_AUTO_SEND_ENABLED is on.
export async function runFollowUps(opts: { dryRun?: boolean } = {}): Promise<FollowUpResult> {
  const result: FollowUpResult = { checked: 0, queued: 0, sent: 0, skipped: 0, ...(opts.dryRun ? { preview: [] } : {}) };
  const holds = await listProposedHolds(FOLLOWUP_AFTER_HOURS, FOLLOWUP_WINDOW_END_HOURS);
  const seenLeads = new Set<string>();

  for (const h of holds) {
    if (h.followupStatus) continue;
    const leadKey = h.leadEmail.toLowerCase();
    // A lead can hold more than one slot from older two-time offers: handle them together.
    if (seenLeads.has(leadKey)) { await markHoldFollowUp(h.eventId, 'skipped'); continue; }
    seenLeads.add(leadKey);
    result.checked++;
    try {
      const outcome = await followUpFor(h, opts.dryRun ? result.preview : undefined);
      if (opts.dryRun) {
        result.preview!.push(`${h.leadEmail}: ${outcome}`);
        if (outcome === 'queued') result.queued++; else if (outcome === 'skipped') result.skipped++;
        continue;
      }
      // 'not-yet' (offer under 24h old, or not actually sent yet) must stay untagged so a later
      // tick looks again; tagging it would quietly cancel its follow-up forever.
      if (outcome === 'not-yet') continue;
      await markHoldFollowUp(h.eventId, outcome);
      if (outcome === 'sent') result.sent++;
      else if (outcome === 'queued') result.queued++;
      else result.skipped++;
    } catch (err) {
      console.warn(`[followups] ${h.leadEmail} failed (will retry next tick):`, err instanceof Error ? err.message : String(err));
    }
  }
  console.log(`[followups] holds=${holds.length} checked=${result.checked} queued=${result.queued} sent=${result.sent} skipped=${result.skipped}`);
  return result;
}

// previewSink: in a dry run, receives the draft that would have been posted instead of sending
// or posting anything.
async function followUpFor(h: HoldInfo, previewSink?: string[]): Promise<'sent' | 'queued' | 'skipped' | 'not-yet'> {
  const nowSec = Date.now() / 1000;
  const emails = await listLeadEmails(h.leadEmail);
  const holdSec = new Date(h.createdAt || h.startIso).getTime() / 1000;

  // When the offer actually went out: the first reply of ours after the hold was made. With no
  // such reply it's still waiting in Slack (or was skipped), so there's nothing to follow up on.
  const offer = emails.filter((e) => e.ue === 3 && e.t >= holdSec - 30).sort((a, b) => a.t - b.t)[0];
  if (!offer) return 'not-yet';
  if (nowSec - offer.t < FOLLOWUP_AFTER_HOURS * 3600) return 'not-yet';

  // Anything since the offer — a reply from them, or another message from us — means the
  // conversation has moved on and a canned nudge would be wrong.
  const after = emails.filter((e) => e.t > offer.t + 5);
  if (after.some((e) => e.ue === 2 || e.ue === 3)) return 'skipped';

  const lead = await findLeadByEmailAnyCampaign(h.leadEmail);
  if (lead && (lead.interestStatus < 0 || lead.interestStatus >= 2)) return 'skipped'; // not interested / already booked / closed
  if (await hasRealBookingForLead(h.leadEmail)) return 'skipped';

  const inbound = emails.filter((e) => e.ue === 2 && e.from === h.leadEmail.toLowerCase()).sort((a, b) => b.t - a.t)[0];
  if (!inbound) return 'skipped';
  const identity = getSenderIdentity(inbound.eaccount);
  if (identity.firstName !== 'Katie') return 'skipped'; // only Katie's Calendly offers

  const first = (h.leadName || '').trim().split(/\s+/)[0] || 'there';
  const draft = buildFollowUpText(first, identity.signOff, h.leadEmail);
  const subject = replySubject(inbound.subject);

  if (previewSink) {
    previewSink.push(`--- would post for ${h.leadEmail} (offer ${Math.round((nowSec - offer.t) / 3600)}h ago):\n${draft}`);
    return 'queued';
  }

  if (isNewRuleAutoSendEnabled()) {
    const rendered = renderLinks(draft);
    await replyToEmail({
      reply_to_uuid: inbound.id,
      eaccount: inbound.eaccount,
      subject,
      body: { text: rendered.plainText, html: rendered.html },
      stamp: { campaignId: h.campaignId, leadEmail: h.leadEmail },
    });
    await postInfoNote(`:envelope: Sent a 24-hour follow-up to ${h.leadName || h.leadEmail} (<mailto:${h.leadEmail}|${h.leadEmail}>).`);
    return 'sent';
  }
  await postProactiveApproval({
    header: ':hourglass_flowing_sand: 24-hour follow-up — needs approval',
    why: `A time was offered ${Math.round((nowSec - offer.t) / 3600)} hours ago with no reply yet. This is a gentle nudge with the calendar link.`,
    name: h.leadName || h.leadEmail,
    leadEmail: h.leadEmail,
    campaignId: h.campaignId,
    eaccount: inbound.eaccount,
    emailId: inbound.id,
    subject,
    draftText: draft,
  });
  return 'queued';
}

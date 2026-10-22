import { DisplacedHold } from './types';
import { getHoldInfo, deleteHoldById, createHold } from './googleCalendar';
import { findLatestInbound, markSlotReleased, replyToEmail } from './instantly';
import { getSenderIdentity } from './agent';
import { CALENDLY_SCHEDULING_URL, isNewRuleAutoSendEnabled } from './env';
import { postProactiveApproval, postInfoNote, replySubject } from './slack';
import { renderLinks } from './linkFormat';

// When a lead asks for a time that is held only by ANOTHER lead's unconfirmed offer, the
// requested time wins (the agent drafts the booking; see findOverridableHolds in agent.ts).
// This module does the parts that only happen when a human approves that booking: release the
// other lead's hold so the real booking can go through, and tell that lead their time went
// elsewhere.

// Releases the holds a booking displaces. Re-reads each one first: if it's already gone (its
// lead replied or it expired) there's nobody to displace; if it has since been CONFIRMED (that
// lead said yes while this draft sat in review) it must not be taken, so everything already
// released is put back and the caller is told why.
export async function releaseDisplacedHolds(
  displaces: DisplacedHold[],
): Promise<{ released: DisplacedHold[]; blockedReason?: string }> {
  const released: DisplacedHold[] = [];
  for (const d of displaces) {
    const who = d.leadName || d.leadEmail;
    try {
      const info = await getHoldInfo(d.eventId, d.calendarEmail);
      if (!info) continue;
      if (!/^proposed/i.test(info.label)) {
        await restoreDisplacedHolds(released);
        return { released: [], blockedReason: `${who} confirmed that time in the meantime, so it can't be given away` };
      }
      await deleteHoldById(d.eventId, d.calendarEmail);
      released.push({ ...d, timezone: info.timezone ?? d.timezone });
    } catch (err) {
      await restoreDisplacedHolds(released);
      return { released: [], blockedReason: `couldn't release ${who}'s hold (${err instanceof Error ? err.message : String(err)})` };
    }
  }
  return { released };
}

// Puts released holds back — used when the booking they were released for doesn't go through.
export async function restoreDisplacedHolds(held: DisplacedHold[]): Promise<void> {
  for (const h of held) {
    await createHold({
      startIso: h.startIso,
      endIso: h.endIso,
      leadEmail: h.leadEmail,
      leadName: h.leadName,
      campaignId: h.campaignId,
      label: h.label,
      timezone: h.timezone,
      calendarEmail: h.calendarEmail,
    });
  }
}

function timeInTheirClock(d: DisplacedHold): string {
  if (!d.timezone) return 'the time I mentioned';
  try {
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: d.timezone,
    }).format(new Date(d.startIso)).replace(',', '').replace(/^(\w+) (\w+ \d+)/, '$1, $2');
  } catch {
    return 'the time I mentioned';
  }
}

// The note to the lead who lost the slot: honest (the time really is gone), brief, and it gives
// them an easy way back in via the calendar link.
export function buildDisplacedNotice(d: DisplacedHold, signOff: string): string {
  const first = (d.leadName || '').trim().split(/\s+/)[0] || 'there';
  return `Hi ${first},\n\nQuick heads up: my schedule shifted and ${timeInTheirClock(d)} is no longer available. Sorry about that! If you're still interested in a quick 30-minute Zoom, feel free to grab another time that works for you on [my Calendly](${CALENDLY_SCHEDULING_URL}).\n\n${signOff.replace(/\.$/, '')}`;
}

// Tells each lead who lost a slot, and records that on their lead record so a later "yes, that
// time works" from them is recognized (the agent then tells them it's gone and offers another).
// The email goes to Slack for approval unless NEW_RULE_EMAILS_AUTO_SEND_ENABLED is on.
export async function notifyDisplacedLeads(released: DisplacedHold[], bookedFor: string): Promise<void> {
  for (const d of released) {
    const who = d.leadName || d.leadEmail;
    try {
      await markSlotReleased(d.campaignId, d.leadEmail, d.startIso);
      const inbound = await findLatestInbound(d.leadEmail);
      if (!inbound) {
        await postInfoNote(`:warning: ${who}'s offered time (${new Date(d.startIso).toISOString()}) was just given to ${bookedFor}, but I couldn't find their thread to tell them. Please email them (${d.leadEmail}) and point them to the calendar link.`);
        continue;
      }
      const draft = buildDisplacedNotice(d, getSenderIdentity(inbound.eaccount).signOff);
      const subject = replySubject(inbound.subject);
      if (isNewRuleAutoSendEnabled()) {
        const rendered = renderLinks(draft);
        await replyToEmail({
          reply_to_uuid: inbound.id,
          eaccount: inbound.eaccount,
          subject,
          body: { text: rendered.plainText, html: rendered.html },
          stamp: { campaignId: d.campaignId, leadEmail: d.leadEmail },
        });
        await postInfoNote(`:bell: Told ${who} their offered time went to someone else (${bookedFor}) and pointed them to the calendar link.`);
      } else {
        await postProactiveApproval({
          header: ':bell: Slot reassigned — notify lead (needs approval)',
          why: `Their offered time was just given to ${bookedFor}. This tells them it's gone and points them to the calendar link.`,
          name: who,
          leadEmail: d.leadEmail,
          campaignId: d.campaignId,
          eaccount: inbound.eaccount,
          emailId: inbound.id,
          subject,
          draftText: draft,
        });
      }
    } catch (err) {
      console.warn('[displacement] notifying displaced lead failed:', err instanceof Error ? err.message : String(err));
      await postInfoNote(`:warning: ${who}'s offered time was given to ${bookedFor}, but telling them failed. Please email ${d.leadEmail} and point them to the calendar link.`);
    }
  }
}

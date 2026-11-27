import { CloseEmailRow, CloseUser, closeErrorText, closeLeadUrl, createLeadEmail, findUserByEmail, listLeadEmailsSince } from './closeCrm';
import { notifyClickerViaResponseUrl, openModal, postInfoNote, updateMessage, updateViaResponseUrl } from './slack';
import { NudgeRecord, nudgeMode, recordNudge, senderEmail, senderLabel, senderName } from './lapseNudges';
import { ACTION, ACTION_PREFIX, CardData, EDIT_MODAL, NudgeAction, NudgeEmail, NudgeMode, cardBlocks, cardIsOpen, contactedSince, doneBlocks, editModal, parseCardData, readCardEmail, readEditModal } from './lapseNudgeRules';
import { SlackActionPayload } from './types';

// What happens when someone clicks a button on a check-in card (src/lapseNudges.ts posts them).
// Approve is the only thing in this feature that writes to Close: it creates the email in the
// sender's mailbox, as a draft (LAPSE_NUDGE_MODE=draft) or to be sent (live). Every click is
// recorded in the nudge log with who clicked.
//
// A second click must be harmless. The card loses its buttons the moment a click is accepted, a
// click on a card with no buttons is ignored, and before creating an email Close itself is asked
// whether one to (or from) this teacher has appeared on the lead since the card was posted.

export const isLapseNudgeAction = (actionId: unknown) => String(actionId ?? '').startsWith(ACTION_PREFIX);
export const isLapseNudgeModal = (payload: any) => payload?.type === 'view_submission' && payload?.view?.callback_id === EDIT_MODAL;

// Everything that touches the network, so scripts/checkLapseNudges.ts can click on fakes.
export interface NudgeActionDeps {
  recordNudge(row: NudgeRecord): Promise<void>;
  leadEmailsSince(leadId: string, sinceIso: string): Promise<CloseEmailRow[]>;
  findSender(email: string): Promise<CloseUser | null>;
  createEmail(p: { leadId: string; to: string; subject: string; bodyText: string; status: 'draft' | 'outbox'; user: CloseUser }): Promise<string>;
  updateCard(responseUrl: string, text: string, blocks: any[]): Promise<void>;
  tellClicker(responseUrl: string, text: string): Promise<void>; // only they see it; the card is untouched
  openModal(triggerId: string, view: any): Promise<void>;
  updateMessage(channel: string, ts: string, text: string, blocks: any[]): Promise<void>;
  postNote(text: string): Promise<void>; // the main channel
}

const realDeps: NudgeActionDeps = {
  recordNudge, leadEmailsSince: listLeadEmailsSince, findSender: findUserByEmail, createEmail: createLeadEmail,
  updateCard: updateViaResponseUrl, tellClicker: notifyClickerViaResponseUrl, openModal, updateMessage,
  postNote: (text) => postInfoNote(text),
};

// Cards being sent right now by this instance (a double click often lands on the same one).
const sending = new Set<string>();

const tsToIso = (ts: string) => new Date(Number(ts) * 1000).toISOString();

export async function handleLapseNudgeAction(
  action: SlackActionPayload['actions'][number],
  payload: SlackActionPayload,
  deps: NudgeActionDeps = realDeps,
  mode: NudgeMode = nudgeMode(),
): Promise<void> {
  const url = payload.response_url;
  const d = parseCardData(action.value);
  if (!d) { await deps.tellClicker(url, ':warning: Could not read this card. Nothing was done.'); return; }
  if (!cardIsOpen(payload.message?.blocks)) {
    console.warn(`[lapseNudges] click on a card already dealt with ignored: ${action.action_id} teacher=${d.t}`);
    await deps.tellClicker(url, `:information_source: This check-in for ${d.name} was already dealt with. This click was ignored.`);
    return;
  }
  const who = payload.user?.id ? `<@${payload.user.id}>` : 'a teammate';
  const actor = payload.user?.name || payload.user?.username || payload.user?.id || 'unknown';
  const ts = payload.message?.ts || '';
  const row = (act: NudgeAction, note?: string): NudgeRecord => ({ teacher_id: d.t, nces_school_id: d.s, kind: d.k, action: act, lapse_started_on: d.l, ...(ts ? { slack_ts: ts } : {}), actor, ...(note ? { note } : {}) });
  const tryRecord = async (r: NudgeRecord): Promise<boolean> => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try { await deps.recordNudge(r); return true; } catch (err) { console.error(`[lapseNudges] recording "${r.action}" for teacher ${r.teacher_id} failed (try ${attempt}):`, closeErrorText(err)); }
    }
    return false;
  };

  switch (action.action_id) {
    case ACTION.skip:
    case ACTION.never: {
      const never = action.action_id === ACTION.never;
      if (!(await tryRecord(row(never ? 'opted_out' : 'skipped')))) {
        await deps.tellClicker(url, ':warning: Could not record that in the nudge log, so the card was left as it is. Try again in a minute.');
        return;
      }
      const headline = never ? `:no_entry_sign: *Never nudge this teacher*, set by ${who}` : `:next_track_button: *Skipped* by ${who}`;
      await deps.updateCard(url, never ? 'Never nudge this teacher' : 'Skipped', doneBlocks(headline, d));
      return;
    }

    case ACTION.edit: {
      const email = readCardEmail(payload.message?.blocks);
      if (mode === 'preview' || !email || !payload.trigger_id) { await deps.tellClicker(url, mode === 'preview' ? ':eyes: Preview only: sending is switched off.' : ':warning: Could not open the editor for this card.'); return; }
      await deps.openModal(payload.trigger_id, editModal(d, email, { channel: payload.channel?.id || '', ts }));
      return;
    }

    case ACTION.approve: {
      if (mode === 'preview') { await deps.tellClicker(url, ':eyes: Preview only: sending is switched off. Nothing was sent.'); return; }
      const email = readCardEmail(payload.message?.blocks);
      if (!email) { await deps.tellClicker(url, ':warning: Could not read the email from this card. Nothing was sent.'); return; }
      const key = `${d.t}|${d.k}|${d.l}`;
      if (sending.has(key)) { await deps.tellClicker(url, ':information_source: This check-in is already being sent. This click was ignored.'); return; }
      sending.add(key);
      try {
        await approve(d, email, { url, ts, who, mode }, deps, row, tryRecord);
      } finally {
        sending.delete(key);
      }
      return;
    }

    default:
      console.warn('[lapseNudges] unknown action_id:', action.action_id);
  }
}

async function approve(
  d: CardData,
  email: NudgeEmail,
  c: { url: string; ts: string; who: string; mode: NudgeMode },
  deps: NudgeActionDeps,
  row: (act: NudgeAction, note?: string) => NudgeRecord,
  tryRecord: (r: NudgeRecord) => Promise<boolean>,
): Promise<void> {
  // Ask Close first: an email to or from this teacher on the lead since the card went up means
  // this check-in already went out (a second click) or someone got in touch by hand.
  const since = tsToIso(c.ts);
  try {
    if (contactedSince(await deps.leadEmailsSince(d.lead, since), d.to, since)) {
      console.warn(`[lapseNudges] Approve ignored for teacher ${d.t}: an email with ${d.to} is on the lead since the card was posted`);
      await deps.tellClicker(c.url, `:information_source: Nothing was sent: Close already has an email to or from ${d.to} on this school since this card was posted, so this check-in has gone out or someone has been in touch. Skip the card if it is no longer needed.`);
      return;
    }
  } catch (err) {
    await deps.tellClicker(c.url, `:warning: Nothing was sent: could not check Close for an earlier send (\`${closeErrorText(err).slice(0, 200)}\`). Try again in a minute.`);
    return;
  }
  const draft = c.mode === 'draft';
  await deps.updateCard(c.url, 'Working on it', doneBlocks(`:hourglass_flowing_sand: ${draft ? 'Saving a draft' : 'Sending'}… (approved by ${c.who})`, d, email));
  try {
    const user = await deps.findSender(senderEmail());
    if (!user) throw new Error(`Close has no user with the email ${senderEmail()}`);
    await deps.createEmail({ leadId: d.lead, to: d.to, subject: email.subject, bodyText: email.body, status: draft ? 'draft' : 'outbox', user });
  } catch (err) {
    // Close did not take it: say so, put the buttons back, and never call it sent.
    const msg = closeErrorText(err);
    console.error(`[lapseNudges] Close email failed for teacher ${d.t}:`, msg);
    await tryRecord(row('failed', msg.slice(0, 300)));
    await deps.updateCard(c.url, 'Close could not create the email', cardBlocks(d, email, { mode: c.mode, sender: senderLabel(), leadUrl: closeLeadUrl(d.lead), note: `:warning: Close could not create the email when ${c.who} approved it, so nothing was sent: \`${msg.slice(0, 300)}\`. You can click again.` }));
    return;
  }
  // A Close draft is recorded as "sent" too: from here on it is in the sender's hands.
  const recorded = await tryRecord(row('sent', draft ? 'close draft' : undefined));
  let headline = draft ? `:memo: *Saved as a draft for ${senderName()}* by ${c.who}` : `:white_check_mark: *Sent* by ${c.who}`;
  if (!recorded) {
    headline += '\n:warning: This could not be recorded in the nudge log, so the job may suggest it again. Skip that card if it does.';
    try { await deps.postNote(`:warning: *Teacher check-ins:* an email for ${d.name} (${d.to}) was ${draft ? 'saved as a draft' : 'sent'} but could not be recorded in the nudge log. The job may suggest it again; skip that card if it does.`); } catch { /* the card says it too */ }
  }
  await deps.updateCard(c.url, draft ? `Saved as a draft for ${senderName()}` : 'Sent', doneBlocks(headline, d, email));
}

// A submitted edit modal. Returns field errors for Slack to show in the modal, or null when the
// edit is fine (it is then applied with applyLapseNudgeEdit).
export function lapseNudgeEditErrors(payload: any): Record<string, string> | null {
  const edit = readEditModal(payload?.view);
  if (!edit) return { body: 'This card could not be read. Close this window and try the card again.' };
  if (!edit.email.subject) return { subject: 'The email needs a subject.' };
  if (!edit.email.body) return { body: 'The email needs a message.' };
  return null;
}

// Puts the edited email on the card. Nothing is sent or recorded: the card keeps its buttons and
// Approve sends what it now shows.
export async function applyLapseNudgeEdit(payload: any, deps: NudgeActionDeps = realDeps, mode: NudgeMode = nudgeMode()): Promise<void> {
  const edit = readEditModal(payload?.view);
  if (!edit) return;
  const who = payload?.user?.id ? `<@${payload.user.id}>` : 'a teammate';
  await deps.updateMessage(edit.channel, edit.ts, `Check-in for ${edit.d.name} at ${edit.d.school} (edited)`, cardBlocks(edit.d, edit.email, { mode, sender: senderLabel(), leadUrl: closeLeadUrl(edit.d.lead), note: `:pencil2: Edited by ${who}` }));
}

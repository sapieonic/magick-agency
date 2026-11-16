import type { AgencyDncResponse } from '../types/agency';
import { errorCode } from './agencyErrors';

/**
 * Mark-DNC copy — the scope statement, and the promise the console is
 * allowed to make afterwards.
 *
 * ── Why this is a module and not three strings in a component ────────────────
 * Rule: *"The confirmation must state the resulting scope in plain words … If
 * the backend cannot guarantee that scope, the copy must be weakened to match —
 * **never overstate a compliance action**."* That is a rule about a *response
 * field*, so it is logic, and logic gets tested.
 *
 * ── Campaign-scoped by default, tenant-wide as an explicit escalation ────────
 * These are two different promises to a customer, and the agent on the call is
 * the only person who knows which one was actually said. Most calls that end in
 * "take me off your list" mean *this* campaign; a customer who says "never
 * contact me again" means every campaign this tenant runs, forever. Defaulting
 * to the wider scope every time overstates what most calls actually asked for —
 * so the campaign-scoped mark (`scope: 'campaign'` on the request) is the
 * default action, and the tenant-wide mark (`scope: 'tenant'`) is a second,
 * harder-to-reach control an agent must choose on purpose. Absent `scope` is
 * defined server-side as campaign-scoped too, so an older client that sends
 * neither fails safe into the narrower reading rather than escalating by
 * accident; the API additionally floors `scope: 'tenant'` at `agency.dnc.manage` on a
 * membership of the whole organisation (DS3).
 *
 * The tenant-wide scope is genuinely tenant-wide: the mark writes a `dnc_entries` row
 * with no account and no campaign, and the dial-time check reads that table itself,
 * widened by scope (decision B8; there is no copy of the list anywhere else). So that
 * escalation's confirmation may say "any campaign in this organisation" — but only
 * once `dnc_recorded` says the list write landed. Until then the honest claim is
 * the narrower one the server can make on its own: this campaign will not dial them
 * again.
 */

export type DncScope = 'campaign' | 'tenant';

/** The dialog title. Deliberately a question — it is asking, not announcing. */
export const DNC_CONFIRM_TITLE = 'Stop calling this number?';

/**
 * The default action's label — campaign-scoped, reversible only by an admin but
 * bounded to the campaign the agent is working. This is the choice that matches
 * "take me off your list" for the campaign actually on the line.
 */
export const DNC_CAMPAIGN_ACTION_LABEL = "Don’t call in this campaign";

/**
 * The escalation's label. Deliberately spells out both halves of the promise —
 * *any campaign* (organisation-wide) and *forever* (permanent) — in the label
 * itself, not only in the hint beside it, because the label is the one word an
 * agent under pressure is guaranteed to read.
 */
export const DNC_TENANT_ACTION_LABEL = 'Never call again (any campaign, forever)';

/**
 * The default option's scope, in plain words, with the number and the campaign
 * name in it. Rendered **before** the agent commits, because this is the only
 * moment the scope is actionable, and irreversibility is stated here rather
 * than discovered afterwards.
 */
export function dncCampaignConfirmMessage(phoneE164: string, campaignName: string): string {
  return `${phoneE164} won’t be called again by ${campaignName}. Other campaigns in this organisation can still reach them. You can’t undo this from the console — an admin has to remove it.`;
}

/**
 * The escalation's own statement, rendered beside its button rather than folded
 * into the default message — so its scope and irreversibility cannot be missed
 * by an agent who only reads the primary sentence. Only shown when the
 * tenant-wide option itself is offered.
 */
export function dncTenantConfirmHint(phoneE164: string): string {
  return `Only choose this if the customer said never to contact them again: ${phoneE164} will not be called again by any campaign in this organisation, permanently. You can’t undo this from the console — only an admin can.`;
}

/**
 * Why a campaign entry could not be written, and what that leaves open: the tail of every
 * `dnc_recorded: false` sentence for this campaign's list (the Mark DNC button's and a suppress
 * outcome's).
 */
export const DNC_CAMPAIGN_NOT_LISTED =
  'It couldn’t go on this campaign’s Do Not Call list because the number isn’t in a form the list can hold, so a new upload could bring it back. Ask an admin to check the number.';

/**
 * A saved outcome that suppresses (DS8) whose Do Not Call entry could not be written
 * (`dnc_recorded: false` on the disposition answer): only this contact is suppressed, so say
 * that and no more. On `true` or absent nothing is added (absent: no entry was attempted).
 */
export const SUPPRESS_OUTCOME_NOT_LISTED = `This contact won’t be dialled again. ${DNC_CAMPAIGN_NOT_LISTED}`;

/**
 * What to tell the agent once it lands. Scoped to what the agent actually chose
 * AND to what the response promised — `dnc_recorded: false` on the tenant-wide
 * escalation means the wider row is still in flight, so the wider promise is
 * not yet true. Claiming it anyway is exactly the overstatement that rule forbids,
 * and it is the claim an agent may repeat to the customer.
 *
 * **The campaign-scoped mark reads `dnc_recorded` too**: it is true of the ROSTER
 * and of the LIST only when the list row landed. The server writes the roster rows
 * `suppressed` and the `dnc_entries` row in one transaction (B8), so a failed write
 * is a 5xx; `200 { dnc_recorded: false }` means the roster number was not usable
 * E.164 and no entry could be written. The campaign's current roster rows are
 * suppressed, but nothing on the list stops a re-upload of that number into the same
 * campaign, so the copy must not claim the list.
 */
export function dncOutcomeCopy(response: AgencyDncResponse, scope: DncScope): string {
  if (scope === 'campaign') {
    if (response.dnc_recorded) {
      return `${response.phone_e164} won’t be dialled again by this campaign. It’s on this campaign’s Do Not Call list.`;
    }
    return `${response.phone_e164} won’t be dialled again by this campaign’s current contacts. ${DNC_CAMPAIGN_NOT_LISTED}`;
  }
  if (response.dnc_recorded) {
    /*
      "No campaign in this workspace" was the unqualified sentence `DncPage`'s copy
      was narrowed away from — the widest true claim is "no agency campaign in
      this workspace will call it", because the dial-time gate lives in the
      server's `agency/pre-dial-gates.ts`. This is the sentence an AGENT reads,
      and may read out loud to the customer who just asked never to be called, so
      it has to be at most as wide as the page's. The rule is to not OVERSTATE,
      which naming the enforced scope satisfies.
    */
    return `${response.phone_e164} is on your Do Not Call list. No agency campaign in this organisation will dial it again.`;
  }
  return `${response.phone_e164} won’t be dialled again by this campaign. It couldn’t go on your organisation’s Do Not Call list because the number isn’t in a form the list can hold. Ask an admin to check the number.`;
}

/**
 * Why the control is unavailable. `null` ⇒ available.
 *
 * the requirement is *both actions are disabled when the agent is
 * not the reserved agent*. In this console that is expressible exactly: the
 * console only ever holds an attempt the server reserved **to this agent**, so "no
 * live attempt" is the same condition, and the server answers 403 `not_your_attempt`
 * to anything that slips through. The permission floor is the second half — a
 * viewer-level user without `agency.dnc.write` sees the reason rather than a
 * bare greyed button.
 */
export type DncBlockReason = 'no_live_attempt' | 'not_permitted' | 'in_flight';

export const DNC_BLOCK_COPY: Record<DncBlockReason, string> = {
  no_live_attempt: 'Available while you are on a call',
  not_permitted: 'You don’t have permission to mark Do Not Call',
  in_flight: 'Marking…',
};

export function dncBlockReason(input: {
  hasLiveAttempt: boolean;
  permitted: boolean;
  inFlight: boolean;
}): DncBlockReason | null {
  // Permission is reported ahead of the call state: an agent who will never be
  // able to use this control should be told that, not "wait for a call".
  if (!input.permitted) return 'not_permitted';
  if (input.inFlight) return 'in_flight';
  if (!input.hasLiveAttempt) return 'no_live_attempt';
  return null;
}

/**
 * Failure copy.
 *
 * `not_your_attempt` is allow-listed through the API's error mask precisely so it
 * can be said plainly here; turning it into "contact support and quote this id"
 * on an agent's screen between live calls is indistinguishable from an outage.
 */
export function dncFailureCopy(err: unknown): string {
  const code = errorCode(err);

  if (code === 'not_your_attempt') {
    return 'This call has moved on — it isn’t yours to mark any more.';
  }
  if (code === 'unknown_attempt') {
    return 'That call has already ended. Nothing was marked.';
  }
  return err instanceof Error && err.message
    ? `Couldn’t mark Do Not Call: ${err.message}`
    : 'Couldn’t mark Do Not Call. Nothing was changed.';
}

/**
 * Hang-up failure copy.
 *
 * Lives beside the DNC copy because it obeys the same rule for the same reason:
 * these are the two things an agent does mid-call, both are allow-listed through
 * the API's error mask, and both may be read out loud to a customer who is still
 * on the line. "Contact support and quote this request id" is the wrong sentence
 * in that moment.
 *
 * **The default matters more than the named cases.** Until now this string
 * did not exist, because the rejection was discarded on the theory that the
 * station socket's `hangup` frame had already ended the call. Nothing read that
 * frame and the server had no route, so every sentence here describes a state that was
 * previously reported as success — which is why each one says plainly that the
 * agent is still connected, the only fact they can act on.
 */
export function hangupFailureCopy(err: unknown): string {
  const code = errorCode(err);

  if (code === 'not_your_attempt') {
    return 'This call has moved on — it isn’t yours to end any more.';
  }
  // The server is not bridging it and its row is not terminal, so the call is out of
  // reach from here. Say that rather than implying another press will work.
  if (code === 'attempt_not_live') {
    return 'We can’t reach this call to end it. Ask the customer to hang up, then use Wrap-up.';
  }
  return err instanceof Error && err.message
    ? `Couldn’t end the call: ${err.message}. You are still connected.`
    : 'Couldn’t end the call. You are still connected.';
}

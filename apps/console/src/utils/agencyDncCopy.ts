import type { AgencyDncResponse } from '../types/agency';

/**
 * Mark-DNC copy (§A.7.5) — the scope statement, and the promise the console is
 * allowed to make afterwards.
 *
 * ── Why this is a module and not three strings in a component ────────────────
 * §A.7.5: *"The confirmation must state the resulting scope in plain words … If
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
 * accident; master additionally floors `scope: 'tenant'` at `agency.dnc.manage`.
 *
 * The tenant-wide scope is still genuinely tenant-wide: master's
 * `/internal/agency/dnc` **refuses** an `account_id` rather than ignoring it,
 * precisely because an account-scoped row never enters core's flat
 * `dnc:{tenantId}` Redis set and so would never suppress a dial. So that
 * escalation's confirmation may say "any campaign in this workspace" — but only
 * once `dnc_recorded` says the list write landed. Until then the honest claim is
 * the narrower one core can make on its own: this campaign will not dial them
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
  return `${phoneE164} won’t be called again by ${campaignName}. Other campaigns in this workspace can still reach them. You can’t undo this from the console — an admin has to remove it.`;
}

/**
 * The escalation's own statement, rendered beside its button rather than folded
 * into the default message — so its scope and irreversibility cannot be missed
 * by an agent who only reads the primary sentence. Only shown when the
 * tenant-wide option itself is offered.
 */
export function dncTenantConfirmHint(phoneE164: string): string {
  return `Only choose this if the customer said never to contact them again: ${phoneE164} will not be called again by any campaign in this workspace, permanently. You can’t undo this from the console — only an admin can.`;
}

/**
 * What to tell the agent once it lands. Scoped to what the agent actually chose
 * AND to what the response promised — `dnc_recorded: false` on the tenant-wide
 * escalation means the wider row is still in flight, so the wider promise is
 * not yet true. Claiming it anyway is exactly the overstatement §A.7.5 forbids,
 * and it is the claim an agent may repeat to the customer.
 *
 * **The campaign-scoped mark reads `dnc_recorded` too**, and the reason it once
 * did not is the reason it must. The old justification — "core suppresses the
 * contact directly, so the promise is true on any success response" — is true of
 * the ROSTER and false of the LIST, and the sentence named the list. Core writes
 * the roster rows `suppressed` itself, then forwards to master; when that forward
 * cannot land (master unreachable, or a status core's `PERMANENT_REJECTION_STATUSES`
 * treats as permanent, which abandons the outbox row) it still answers
 * `200 { contact_state: 'suppressed', dnc_recorded: false }`. No entry exists on
 * any list. Core's own abandon log states the consequence: the campaign's current
 * roster rows are suppressed, but nothing on record stops a re-upload of that
 * number into the same campaign — so it is dialled again at the next top-up,
 * after the agent read the promise out loud.
 */
export function dncOutcomeCopy(response: AgencyDncResponse, scope: DncScope): string {
  if (scope === 'campaign') {
    if (response.dnc_recorded) {
      return `${response.phone_e164} won’t be dialed again by this campaign. It’s on this campaign’s Do Not Call list.`;
    }
    return `${response.phone_e164} won’t be dialed again by this campaign’s current contacts. We’re still adding it to this campaign’s Do Not Call list — until that lands a new upload could bring the number back, so check the list.`;
  }
  if (response.dnc_recorded) {
    /*
      "No campaign in this workspace" was the unqualified sentence Q2's copy
      obligation narrowed away from on `DncPage` — where the widest true claim is
      now "no agency campaign in this workspace will call it, and it does not stop
      AI calls or broadcasts", because the dial-time gate lives in core's
      `agency/pre-dial-gates.ts` and nothing in AI dispatch consults it. This is
      the sentence an AGENT reads, and may read out loud to the customer who just
      asked never to be called, so it has to be at most as wide as the page's.
      The AI-calls exclusion is deliberately not appended: "broadcast" is not a
      word this reader has, and §A.7.5's rule is to not OVERSTATE, which naming
      the enforced scope satisfies.
    */
    return `${response.phone_e164} is on your Do Not Call list. No agency campaign in this workspace will dial it again.`;
  }
  return `${response.phone_e164} won’t be dialed again by this campaign. We’re still adding it to your workspace Do Not Call list — check the list if you need to be sure.`;
}

/**
 * Why the control is unavailable. `null` ⇒ available.
 *
 * `AD-P3-U-03` acceptance (c) is *both actions are disabled when the agent is
 * not the reserved agent*. In this console that is expressible exactly: the
 * console only ever holds an attempt core reserved **to this agent**, so "no
 * live attempt" is the same condition, and core answers 403 `not_your_attempt`
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
 * `not_your_attempt` is allow-listed through master's error mask precisely so it
 * can be said plainly here; turning it into "contact support and quote this id"
 * on an agent's screen between live calls is indistinguishable from an outage.
 */
export function dncFailureCopy(err: unknown): string {
  const code =
    err !== null && typeof err === 'object'
      ? ((err as { details?: { code?: unknown } }).details?.code ?? null)
      : null;

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
 * Hang-up failure copy (`MAG-112`).
 *
 * Lives beside the DNC copy because it obeys the same rule for the same reason:
 * these are the two things an agent does mid-call, both are allow-listed through
 * master's error mask, and both may be read out loud to a customer who is still
 * on the line. "Contact support and quote this request id" is the wrong sentence
 * in that moment.
 *
 * **The default matters more than the named cases.** Until `MAG-112` this string
 * did not exist, because the rejection was discarded on the theory that the
 * station socket's `hangup` frame had already ended the call. Nothing read that
 * frame and core had no route, so every sentence here describes a state that was
 * previously reported as success — which is why each one says plainly that the
 * agent is still connected, the only fact they can act on.
 */
export function hangupFailureCopy(err: unknown): string {
  const code =
    err !== null && typeof err === 'object'
      ? ((err as { details?: { code?: unknown } }).details?.code ?? null)
      : null;

  if (code === 'not_your_attempt') {
    return 'This call has moved on — it isn’t yours to end any more.';
  }
  // Core is not bridging it and its row is not terminal, so the call is out of
  // reach from here. Say that rather than implying another press will work.
  if (code === 'attempt_not_live') {
    return 'We can’t reach this call to end it. Ask the customer to hang up, then use Wrap-up.';
  }
  return err instanceof Error && err.message
    ? `Couldn’t end the call: ${err.message}. You are still connected.`
    : 'Couldn’t end the call. You are still connected.';
}

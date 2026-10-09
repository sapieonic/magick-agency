import { createChildLogger } from '@magick-agency/observability';
import type { AgencyCampaignRecord, AgencyContactRecord } from '../db/models/agency.model.js';
import { AGENT_LEASE_MS } from './agent-state-machine.js';
import { callingWindowState, nextWindowOpen, resolveCallingWindow } from './calling-hours.js';
import { normalizeE164 } from './dnc-registry.js';
import type { DncRegistry } from './dnc-registry.js';

const log = createChildLogger({ component: 'agency-pre-dial-gates' });

/**
 * ─── AGENCY DIALER — THE PRE-DIAL COMPLIANCE GATES (§4.2) ────────────────────
 *
 * Everything that must be true about a *contact* before a carrier is contacted,
 * in one place, evaluated where §4.2 puts it: in the tick, between claiming the
 * contact and creating the attempt. Two reasons for that position, both practical
 * rather than stylistic — the gate's outcomes are all writes to the contact row,
 * which is the tick's job, and suppressing before the attempt exists means there
 * is no attempt row to unwind.
 *
 * The residual risk of gating in the tick is that a future dial path which does
 * not come through `dialUpTo` bypasses the gates. That is closed structurally
 * rather than by comment: a clear decision mints a {@link PreDialClearance}, and
 * `DialDispatcher.dispatch` will not accept a command without one. The token is
 * branded with a symbol this module does not export, so it cannot be constructed
 * anywhere else, and it carries the contact it was issued for so it cannot be
 * moved to a different one.
 *
 * ── Gate order, and why it is not a compliance question ─────────────────────
 *
 * Phone validity, then calling hours, then DNC — cheapest first, and no arm of any
 * gate dials, so the order cannot change whether a suppressed number is called.
 * It does change two things worth having:
 *
 *  - An unusable phone is terminal, so checking it first removes the row from the
 *    roster immediately instead of deferring it nightly forever.
 *  - **Calling hours before DNC keeps a Redis outage from halting a campaign that
 *    is out of hours anyway.** Out-of-hours contacts defer normally and only a
 *    contact we would otherwise dial right now can trigger the halt, which is the
 *    difference between "paused because it is 3am" and "paused, cause unknown".
 */

declare const clearanceBrand: unique symbol;

/**
 * Proof that the gates ran and cleared, for this contact, just now.
 *
 * The brand is a `unique symbol` that is deliberately **not exported**, so no
 * other module can produce a value of this type — a dial path that skips the
 * gates fails to compile rather than failing an audit. Both other fields are
 * checked at dispatch, because a compile-time brand does not survive an `as`
 * cast and does not notice a token paired with the wrong contact.
 */
export interface PreDialClearance {
  readonly [clearanceBrand]: true;
  /** The contact this clearance was issued for. Checked at dispatch. */
  readonly contactId: string;
  /** When the gates ran. Checked at dispatch against the reservation lease. */
  readonly checkedAt: Date;
}

/**
 * How long a clearance is good for.
 *
 * Tied to the pre-dial reservation lease rather than being an independent number,
 * and the reasoning is §6.1's read from the other end: a clearance that outlives
 * the reservation is meaningless, because the agent it was going to bridge to is
 * already gone. It also bounds the real hazard — an agent marking a number DNC
 * between the check and the dial — to the same window the design already accepts
 * for reservations. This is an in-process check on a value, never a Redis TTL.
 */
export const CLEARANCE_MAX_AGE_MS = AGENT_LEASE_MS.reserved_predial;

/**
 * How long a contact is parked when its calling window cannot be computed.
 *
 * Not suppressed: `unresolvable` almost always means the *campaign's* own
 * `default_timezone` is unusable (a contact's bad zone falls back to it), so
 * suppressing would write off a whole roster over one config field and require a
 * re-upload to undo. An hour is short enough that fixing the config brings the
 * roster back on its own, and long enough not to burn agent reservations
 * re-deferring the same rows four times a second.
 *
 * The real fix is upstream: master should refuse to push a campaign whose
 * `default_timezone` is not a usable IANA zone. A per-contact gate cannot pause a
 * campaign, and should not learn how to.
 */
export const UNRESOLVABLE_WINDOW_PARK_MS = 60 * 60 * 1000;

/** Why a gate stopped a dial. Also the metric label, so the set is closed. */
export type PreDialGate =
  | 'phone_invalid'
  | 'calling_hours'
  | 'calling_hours_unresolvable'
  | 'dnc'
  | 'dnc_unavailable';

/**
 * What the tick must do with this contact.
 *
 * - `dial` — carries the clearance the dispatcher demands.
 * - `suppress` — terminal. The contact leaves the roster with a reason.
 * - `defer` — back to `pending` at `deferUntil`, which is **always strictly in the
 *   future**: returning it at `now()` re-claims it on the very next tick and a
 *   campaign whose roster is all out of hours spins at 4 claims/second all night
 *   (§4.2).
 * - `halt` — campaign-wide, not about this contact. Stop the tick; do not dial the
 *   contacts already claimed alongside it either, because whatever stopped us
 *   answering for this one cannot answer for them.
 */
export type PreDialDecision =
  | { action: 'dial'; clearance: PreDialClearance }
  | { action: 'suppress'; gate: PreDialGate; suppressedReason: 'dnc' | 'invalid' }
  | { action: 'defer'; gate: PreDialGate; deferUntil: Date }
  | { action: 'halt'; gate: PreDialGate };

export interface PreDialGateInput {
  // PORT NOTE (magick-agency, decision B8): `account_id` added to the Pick — the DNC
  // check below is now scoped (tenant-wide, this account, this campaign) and needs it.
  campaign: Pick<AgencyCampaignRecord,
    'id' | 'tenant_id' | 'account_id' | 'calling_window_start' | 'calling_window_end' | 'calling_days'
    | 'default_timezone'>;
  contact: Pick<AgencyContactRecord, 'id' | 'phone_e164' | 'timezone'>;
  now: Date;
}

/**
 * Run the gates. Total: every path returns a decision, and none of them throws.
 *
 * A throw here would propagate into `tickOnce`'s catch and abort the whole tick
 * with agents reserved and contacts claimed — the pacing engine's own error path
 * would clean up eventually, but the failure would read as a pacing bug rather
 * than a compliance one.
 */
export async function evaluatePreDialGates(
  input: PreDialGateInput,
  deps: { dnc: DncRegistry },
): Promise<PreDialDecision> {
  const { campaign, contact, now } = input;

  // ── 1. Is this a number at all ────────────────────────────────────────────
  // First because it is terminal and free. A row whose phone is not E.164 can
  // never be dialed and can never be compared against the DNC set, so it leaves
  // the roster now rather than being deferred to a window it will fail again at
  // every night. Deliberately NOT a halt: one malformed row must not stop dialing
  // for everyone on the campaign.
  if (normalizeE164(contact.phone_e164) === null) {
    return { action: 'suppress', gate: 'phone_invalid', suppressedReason: 'invalid' };
  }

  // ── 2. Calling hours, in the contact's own timezone (D4) ──────────────────
  // Before DNC because it is free, and because it keeps an out-of-hours campaign
  // deferring cleanly instead of halting when Redis is unhappy.
  const window = resolveCallingWindow(campaign, contact);
  if (window.contactTimezoneRejected) {
    // Not an error — the campaign default applies per D4 — but it means an ingest
    // mapping is producing junk, and the alternative symptom is calls at the
    // wrong local time for one slice of a roster and nothing to grep for.
    log.warn(
      { campaignId: campaign.id, contactId: contact.id, timezone: contact.timezone },
      'Contact timezone unusable — falling back to the campaign default',
    );
  }

  const state = callingWindowState(window, now);
  if (state === 'unresolvable') {
    return {
      action: 'defer',
      gate: 'calling_hours_unresolvable',
      deferUntil: new Date(now.getTime() + UNRESOLVABLE_WINDOW_PARK_MS),
    };
  }
  if (state === 'closed') {
    const opens = nextWindowOpen(window, now);
    // Null means no opening exists at all — an empty `calling_days`, or
    // `start == end`. Parked rather than treated as "now", which would spin.
    return {
      action: 'defer',
      gate: 'calling_hours',
      deferUntil: opens ?? new Date(now.getTime() + UNRESOLVABLE_WINDOW_PARK_MS),
    };
  }

  // ── 3. Do Not Call, immediately before the dial (§2.3) ────────────────────
  // PORT NOTE (magick-agency, decision B8): the scope is REQUIRED by the collapsed
  // registry (core passed none — its Redis set held tenant-wide entries only). With
  // the account and campaign named, an account- or campaign-scoped `dnc_entries` row
  // stops this dial too, where in core only ingest and the mark's roster sweep did.
  const dnc = await deps.dnc.check(campaign.tenant_id, contact.phone_e164, {
    accountId: campaign.account_id,
    campaignId: campaign.id,
  });
  if (dnc === 'suppressed') {
    return { action: 'suppress', gate: 'dnc', suppressedReason: 'dnc' };
  }
  if (dnc === 'unverifiable') {
    // Unreachable: gate 1 already refused anything `normalizeE164` cannot read,
    // and the registry uses the same function. Kept because the alternative is
    // falling through to `dial` if the two ever diverge, and this arm's cost is
    // three lines. `test/unit/agency/pre-dial-gates.test.ts` pins the equivalence
    // rather than trusting this paragraph.
    return { action: 'suppress', gate: 'phone_invalid', suppressedReason: 'invalid' };
  }
  if (dnc === 'unavailable') {
    // The registry cannot answer — no Redis, an unsynced tenant, or an error.
    // Campaign-wide, so the campaign stops. This is the one place in the system
    // where unavailability must halt work: a wrongly-dialed DNC number is a
    // regulatory event, a paused campaign is an inconvenience.
    return { action: 'halt', gate: 'dnc_unavailable' };
  }

  return { action: 'dial', clearance: mintClearance(contact.id, now) };
}

function mintClearance(contactId: string, now: Date): PreDialClearance {
  // The only construction site in the codebase. The cast is here rather than at a
  // call site precisely so that grepping for it finds one line.
  return { contactId, checkedAt: now } as unknown as PreDialClearance;
}

/** Why a clearance was refused at dispatch. Null ⇒ it is good. */
export type ClearanceRejection = 'missing' | 'wrong_contact' | 'stale';

/**
 * Validate a clearance at the dial choke point.
 *
 * The brand already makes a *forged* clearance a compile error, so this exists for
 * the two failures a type cannot see. `wrong_contact` is the realistic one:
 * `dialUpTo` pairs `reserved[index]` with `contacts[index]`, and an indexing
 * mistake there would hand a valid clearance to a contact nobody checked — the
 * failure would be a dial to an unchecked number with every type satisfied.
 */
export function rejectClearance(
  clearance: PreDialClearance | undefined,
  contactId: string,
  now: Date,
): ClearanceRejection | null {
  if (!clearance || typeof clearance.contactId !== 'string') return 'missing';
  if (clearance.contactId !== contactId) return 'wrong_contact';
  const age = now.getTime() - clearance.checkedAt.getTime();
  // A negative age is a clock going backwards or a fabricated token; either way it
  // is not evidence the gates ran, so it is refused rather than treated as fresh.
  if (!(age >= 0 && age <= CLEARANCE_MAX_AGE_MS)) return 'stale';
  return null;
}

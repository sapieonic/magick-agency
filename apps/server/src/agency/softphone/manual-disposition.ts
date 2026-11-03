/**
 * The soft phone's outcome rules (docs/softphone.md §4.1 step 7, §5): which catalog
 * a call is dispositioned against, the submitted outcome validated with the
 * station's own pure functions, and the roster decision it implies. Pure; the
 * service owns the transaction (`recordDisposition` → DNC → `settleFromManual`).
 */
import {
  AGENCY_DEFAULT_DISPOSITION_CATALOG,
  type AgencyCallField,
  type AgencyCallFieldValues,
  type AgencyDisposition,
  type AgencyManualCallDispositionSource,
  type AgencyManualCallOutcome,
  type AgencySoftphoneSettings,
} from '@magick-agency/contracts/agency';
import type { AgencyCampaignRecord, AgencyContactRecord } from '../../db/models/agency.model.js';
import { resolveDisposition, validateDispositionFields } from '../disposition.js';
import { resolveDispositionDecision, type DispositionDecision } from '../disposition-policy.js';
import { resolveOurFaultRedial, resolveRetryDecision, type RetryDecision } from '../retry-policy.js';
import { resolveCallingWindow, scheduleCallbackInWindow } from '../calling-hours.js';
import { DIAL_OUTCOME_UNKNOWN_REDIAL_DELAY_MS, dialOutcomeUnknownNotBefore } from '../../telephony/carrier-errors.js';
import { storedValuesInForce, submittedCallFields, validateCallFieldValues } from './call-fields.js';
import type { SoftphoneRefusal } from './types.js';

function nonEmpty(catalog: unknown): catalog is AgencyDisposition[] {
  return Array.isArray(catalog) && catalog.length > 0;
}

/**
 * The catalog a call's outcome resolves against, and the `disposition_source` it
 * is stored with: a tagged call uses the campaign's `disposition_catalog`; an
 * untagged one the settings' catalog, else the built-in.
 *
 * A tagged campaign whose catalog is EMPTY (or whose row is gone) falls back to the
 * built-in catalog, still as source `campaign`. On the station an empty catalog
 * means "no write-up step", but a soft-phone call that bridged always owes an
 * outcome (`requires_disposition`), and a catalog with no codes would leave it
 * unsavable until the lapse.
 */
export function resolveManualCatalog(
  tag: Pick<AgencyCampaignRecord, 'disposition_catalog'> | null,
  tagged: boolean,
  settings: Pick<AgencySoftphoneSettings, 'disposition_catalog'>,
): { catalog: AgencyDisposition[]; source: AgencyManualCallDispositionSource } {
  if (tagged) {
    return {
      catalog: nonEmpty(tag?.disposition_catalog) ? tag!.disposition_catalog : [...AGENCY_DEFAULT_DISPOSITION_CATALOG],
      source: 'campaign',
    };
  }
  return {
    catalog: nonEmpty(settings.disposition_catalog) ? settings.disposition_catalog : [...AGENCY_DEFAULT_DISPOSITION_CATALOG],
    source: 'softphone',
  };
}

/** A submitted outcome, validated: the catalog entry, notes, callback and the fields to store. */
export interface PreparedManualDisposition {
  entry: AgencyDisposition;
  notes: string | null;
  callbackAt: Date | null;
  /** Present when the request carried `fields` (they replace the stored values). */
  fields: AgencyCallFieldValues | undefined;
}

/**
 * Validate a submitted outcome: the code against `catalog` (`resolveDisposition`),
 * its note / callback against the entry (`validateDispositionFields`), and the call
 * fields against the field set in force WITH `required` enforced — on the submitted
 * values when the request carries them, else on the stored ones (those of fields
 * still in force: `storedValuesInForce`). Omitted `fields`, and `{}` while no call
 * fields are in force, leave the stored values unchanged (`submittedCallFields`).
 */
export function prepareManualDisposition(input: {
  catalog: AgencyDisposition[];
  code: unknown;
  notes?: unknown;
  callbackAt?: unknown;
  callFields: readonly AgencyCallField[];
  submittedFields: unknown;
  storedFields: AgencyCallFieldValues;
  now: Date;
}): { ok: true; prepared: PreparedManualDisposition } | { ok: false; refusal: SoftphoneRefusal } {
  const resolved = resolveDisposition(input.catalog, input.code);
  if (!resolved.ok) {
    return { ok: false, refusal: { code: 'disposition_invalid', reason: 'unknown_code', allowed_codes: resolved.allowed } };
  }
  const fields = validateDispositionFields(resolved.entry, { notes: input.notes, callback_at: input.callbackAt }, input.now);
  if (!fields.ok) {
    const reason = fields.code === 'note_required' || fields.code === 'datetime_required' ? fields.code : 'invalid_callback_at';
    return { ok: false, refusal: { code: 'disposition_invalid', reason } };
  }
  const submitted = submittedCallFields(input.callFields, input.submittedFields);
  const values = validateCallFieldValues(
    input.callFields,
    submitted === undefined ? storedValuesInForce(input.callFields, input.storedFields) : submitted,
    { requireFilled: true },
  );
  if (!values.ok) return { ok: false, refusal: { code: 'fields_invalid', details: values.details } };
  return {
    ok: true,
    prepared: {
      entry: resolved.entry,
      notes: fields.notes,
      callbackAt: fields.callbackAt,
      fields: submitted === undefined ? undefined : values.values,
    },
  };
}

/**
 * The roster decision an outcome implies (§5), as the station's disposition route
 * computes it: `resolveDispositionDecision` with
 * `attemptsUsed = attempt_count + (placed ? 1 : 0)` — `settleFromManual` makes the
 * bump, so the decision is computed on the count it will leave — and a callback
 * deferred into the contact's calling window (`scheduleCallbackInWindow`), only
 * when the decision scheduled one.
 */
export function manualDispositionDecision(input: {
  entry: AgencyDisposition;
  now: Date;
  callbackAt: Date | null;
  placed: boolean;
  contact: Pick<AgencyContactRecord, 'attempt_count' | 'timezone'> | null;
  tag: Pick<AgencyCampaignRecord, 'calling_window_start' | 'calling_window_end' | 'calling_days' | 'default_timezone'> | null;
}): { decision: DispositionDecision; nextAttemptAt: Date | null } {
  const attemptsUsed = (input.contact?.attempt_count ?? 0) + (input.placed ? 1 : 0);
  const decision = resolveDispositionDecision(input.entry, {
    now: input.now, attemptsUsed, callbackAt: input.callbackAt,
  });
  let nextAttemptAt = decision.nextAttemptAt;
  if (nextAttemptAt && input.callbackAt && input.tag) {
    const window = resolveCallingWindow(input.tag, { timezone: input.contact?.timezone ?? null });
    nextAttemptAt = scheduleCallbackInWindow(window, input.callbackAt);
  }
  return { decision, nextAttemptAt };
}

/**
 * What a soft-phone call that settles with NO outcome saved does to its claimed
 * roster contact (§5): a placed call that never bridged (§4.1 step 6, the orphan
 * sweep's unbridged rows) and a bridged call whose outcome lapsed (step 8). The
 * campaign path's rules, so pacing cannot redial the customer the soft phone just
 * rang any sooner than it would have redialled them after its own call:
 *
 * - **Dial outcome unknown** (`add_lead` timed out or answered unreadably — the bridge's
 *   `TELEPHONY_INIT_OUTCOME_UNKNOWN` — or an end raced such a dial; never answered): the
 *   carrier may still ring the customer, so the campaign path's hold
 *   (`holdOutcomeUnknownContact`): the our-fault ledger and its bound, `pending` no
 *   earlier than `DIAL_OUTCOME_UNKNOWN_REDIAL_DELAY_MS` from now, `exhausted` at the
 *   bound. A `canceled` / `agent_disconnected` call keeps the tag's cap for it.
 * - **Never placed** (`dialed_at` NULL: refused before the carrier, or the carrier
 *   refused it) → `release`: back to the claim's prior state, nothing charged.
 * - **Placed, ended by OUR side before it bridged** (`agent_disconnected`,
 *   `canceled` — the agent hung up a ringing call) → the our-fault ledger and
 *   `resolveOurFaultRedial`, as `contact-settlement.ts`'s `ourFaultBeforeBridge`
 *   arm. `orphaned` (a restart, a dead media worker) is the reaper's rule for an
 *   attempt (`requeueOrphanedContact` with `reapedRedialNotBefore`): the same ledger
 *   and bound, back on the roster at once, unless the dial was sent and never answered
 *   (the process may have died with `add_lead` in flight or the phone ringing, and the
 *   carrier may still place it): then not before `DIAL_OUTCOME_UNKNOWN_REDIAL_DELAY_MS`
 *   after `dialed_at` (`dialOutcomeUnknownNotBefore`).
 * - **Otherwise** (`no_answer`, `busy`, `failed`, a lapsed bridged call …) → the
 *   customer's allowance and the tag's `retry_policy` (`resolveRetryDecision`) on
 *   `attempt_count + 1`, as the dialer's outcome branch and the lapsed-wrap-up sweep
 *   do: a lapsed `connected` call is `completed` by the default policy
 *   (`connected: { max_attempts: 0 }`), a `no_answer` waits its delay.
 *
 * A retry's `next_attempt_at` is NOT moved into the calling window here, as the
 * campaign path does not move it either: pacing's pre-dial gate defers a contact it
 * claims outside the window (`gate.deferUntil`). Only a callback the agent asked for
 * is placed in the window at the outcome (`manualDispositionDecision`).
 */
export type ManualNoOutcomeSettlement =
  | { kind: 'release' }
  | { kind: 'settle'; charge: 'attempt' | 'our_fault'; decision: RetryDecision };

/** Our side ended the call before it bridged (the campaign path's `ourFaultBeforeBridge`). */
const OUR_FAULT_BEFORE_BRIDGE: ReadonlySet<AgencyManualCallOutcome> = new Set(['agent_disconnected', 'canceled']);

export function manualNoOutcomeSettlement(input: {
  outcome: AgencyManualCallOutcome | null;
  /**
   * The row's `dialed_at`: set, the dial was placed (the dialer clears it for one the
   * carrier never saw); null, it was not.
   */
  dialedAt: Date | null;
  answered: boolean;
  bridged: boolean;
  /** The tag's `retry_policy`; null (the tag is gone) is the built-in policy. */
  policy: AgencyCampaignRecord['retry_policy'] | null;
  contact: Pick<AgencyContactRecord, 'attempt_count' | 'our_fault_attempts'>;
  now: Date;
  /** The carrier may have queued the dial (`add_lead` timed out or answered unreadably). */
  dialOutcomeUnknown?: boolean;
}): ManualNoOutcomeSettlement {
  const outcome = input.outcome;
  if (input.dialOutcomeUnknown && !input.bridged) {
    const capped = outcome !== null && OUR_FAULT_BEFORE_BRIDGE.has(outcome);
    const decision = resolveOurFaultRedial(
      capped ? input.policy : null, outcome, input.now, input.contact.our_fault_attempts + 1,
    );
    return {
      kind: 'settle', charge: 'our_fault',
      decision: decision.contactState === 'pending'
        ? { ...decision, nextAttemptAt: new Date(input.now.getTime() + DIAL_OUTCOME_UNKNOWN_REDIAL_DELAY_MS) }
        : decision,
    };
  }
  if (input.dialedAt === null) return { kind: 'release' };
  if (!input.bridged && outcome === 'orphaned') {
    const decision = resolveOurFaultRedial(null, 'orphaned', input.now, input.contact.our_fault_attempts + 1);
    const notBefore = dialOutcomeUnknownNotBefore(
      { dialed_at: input.dialedAt, answered_at: input.answered ? input.now : null, bridged_at: null }, input.now,
    );
    return {
      kind: 'settle', charge: 'our_fault',
      decision: decision.contactState === 'pending' ? { ...decision, nextAttemptAt: notBefore } : decision,
    };
  }
  if (!input.bridged && outcome !== null && OUR_FAULT_BEFORE_BRIDGE.has(outcome)) {
    return {
      kind: 'settle', charge: 'our_fault',
      decision: resolveOurFaultRedial(input.policy, outcome, input.now, input.contact.our_fault_attempts + 1),
    };
  }
  return {
    kind: 'settle', charge: 'attempt',
    decision: resolveRetryDecision(input.policy, outcome, input.now, input.contact.attempt_count + 1),
  };
}


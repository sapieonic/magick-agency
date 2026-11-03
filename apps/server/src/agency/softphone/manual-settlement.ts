/**
 * The roster contact's half of closing a soft-phone call with NO outcome saved
 * (docs/softphone.md §5): an unanswered call the dialer settles at once (§4.1 step
 * 6), a call the bridge or the carrier refused (step 4), and the reaper's rows — a
 * lapsed outcome (step 8) and an unbridged orphan (step 10). One rule for all of
 * them, `manualNoOutcomeSettlement` (`manual-disposition.ts`): a dial that never
 * reached the carrier gives its claim back, a placed one is charged and the tag's
 * retry policy decides when pacing may call the customer again.
 *
 * Two steps, because the decision reads and the write may run on a transaction:
 * {@link noOutcomeSettlementFor} reads the contact and the tag (outside any
 * transaction — the claim keeps every other writer off the contact, the argument
 * the outcome path makes for `attemptsUsed`), {@link applyNoOutcomeSettlement}
 * writes it, on the caller's client when given.
 */
import type { PoolClient } from 'pg';
import { createChildLogger } from '@magick-agency/observability';
import { agencyOurFaultRetirementTotal } from '@magick-agency/observability/metrics/agency';
import type { AgencyContactState } from '@magick-agency/contracts/agency';
import {
  agencyCampaignRepository,
  agencyContactRepository,
  agencyManualCallRepository,
} from '../../db/repositories/agency.repository.js';
import type { AgencyManualCallRecord } from '../../db/models/agency.model.js';
import { DIAL_OUTCOME_UNKNOWN_ERROR_CODE } from '../../telephony/carrier-errors.js';
import { manualNoOutcomeSettlement, type ManualNoOutcomeSettlement } from './manual-disposition.js';

const log = createChildLogger({ component: 'agency-softphone' });

type Db = Pick<PoolClient, 'query'>;

/** Where the contact landed and which ledger paid; `none` for a released claim. */
export interface NoOutcomeSettled {
  contactId: string;
  state: AgencyContactState;
  charge: 'attempt' | 'our_fault' | 'none';
}

/**
 * The settlement a closed call's claimed contact gets, or null when the call holds no
 * claim (untagged, linked only) or the contact row is gone. Placed is `dialed_at` set,
 * which the dialer clears on a dial the carrier never saw (`end`'s `unplaced`); an
 * unbridged orphan's hold is taken from it (`dialOutcomeUnknownNotBefore`).
 *
 * `dialOutcomeUnknown`: the dial's outcome is unknown (the carrier may have queued it), as
 * the dialer saw it. Absent (the reaper's lapse and orphan sweeps, which have only the
 * row), an unanswered `failed` call asks its media leg whether the bridge ended it
 * `TELEPHONY_INIT_OUTCOME_UNKNOWN` (`mediaLegEndedWith`), so a settle the dialer could not
 * land does not lose the hold.
 */
export async function noOutcomeSettlementFor(
  row: Pick<AgencyManualCallRecord, 'id' | 'contact_claimed' | 'contact_id' | 'campaign_id' | 'outcome' | 'dialed_at' | 'answered_at' | 'bridged_at'>,
  now: Date = new Date(),
  opts: { dialOutcomeUnknown?: boolean } = {},
): Promise<ManualNoOutcomeSettlement | null> {
  if (!row.contact_claimed || !row.contact_id) return null;
  const dialOutcomeUnknown = opts.dialOutcomeUnknown
    ?? (row.dialed_at !== null && row.answered_at === null && row.bridged_at === null && row.outcome === 'failed'
      && await agencyManualCallRepository.mediaLegEndedWith(row.id, DIAL_OUTCOME_UNKNOWN_ERROR_CODE));
  if (row.dialed_at === null && !dialOutcomeUnknown) return { kind: 'release' };
  const [contact, tag] = await Promise.all([
    agencyContactRepository.findById(row.contact_id),
    row.campaign_id ? agencyCampaignRepository.findById(row.campaign_id) : Promise.resolve(null),
  ]);
  if (!contact) return null;
  return manualNoOutcomeSettlement({
    outcome: row.outcome,
    dialedAt: row.dialed_at,
    answered: row.answered_at !== null,
    bridged: row.bridged_at !== null,
    policy: tag?.retry_policy ?? null,
    contact,
    now,
    dialOutcomeUnknown,
  });
}

/**
 * Write the settlement: `releaseManualClaim` for `release`, else `settleFromManual`
 * with the retry decision and its ledger. `last_disposition` is the row's code (the
 * lapse's `no_disposition`, or nothing). An our-fault retirement that LANDED counts on
 * `agency_our_fault_retirement_total`, as the campaign path's does.
 */
export async function applyNoOutcomeSettlement(
  row: Pick<AgencyManualCallRecord, 'id' | 'tenant_id' | 'campaign_id' | 'outcome' | 'disposition_code'>,
  settlement: ManualNoOutcomeSettlement,
  deps: { client?: Db } = {},
): Promise<NoOutcomeSettled | null> {
  if (settlement.kind === 'release') {
    const released = await agencyContactRepository.releaseManualClaim(row.id, deps);
    return released ? { ...released, charge: 'none' } : null;
  }
  const { decision, charge } = settlement;
  const settled = await agencyContactRepository.settleFromManual({
    manualCallId: row.id,
    decision: {
      contactState: decision.contactState,
      nextAttemptAt: decision.nextAttemptAt,
      suppressedReason: decision.suppressedReason,
    },
    charge,
    lastOutcome: row.outcome,
    lastDisposition: row.disposition_code,
  }, deps);
  if (!settled || settled.applied !== 'settled') return null;
  if (decision.reason === 'our_fault_bound_reached' && settled.state === decision.contactState && row.campaign_id) {
    agencyOurFaultRetirementTotal.inc({ tenant_id: row.tenant_id, campaign_id: row.campaign_id, outcome: row.outcome ?? 'unknown' });
    log.warn({ manualCallId: row.id, contactId: settled.contactId, outcome: row.outcome },
      'Contact retired by the our-fault redial bound — we never reached them');
  }
  log.info({
    manualCallId: row.id, contactId: settled.contactId, contactState: settled.state, charge,
    retryReason: decision.reason, nextAttemptAt: decision.nextAttemptAt,
  }, 'Soft-phone contact settled by the retry policy');
  return { contactId: settled.contactId, state: settled.state, charge };
}

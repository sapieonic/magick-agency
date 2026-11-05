/**
 * `AgencyAgentRetryRepository`: the agent's own writes on their contacts (contact assignment,
 * phase 2, decision CA7): reopen not-reached contacts into their queue, and claim one contact
 * for a dial they place themselves (and give that claim back exactly).
 *
 * Eligibility is `agentRetryBlockSql` (`assignment-sql.ts`), the ONE definition the agent's
 * list and counts read too, and it is re-evaluated INSIDE every write's `WHERE` under the row
 * lock, so a contact that changed since the agent looked (a call took it, a DNC mark
 * suppressed it, a supervisor reassigned it) is never reopened or claimed. Ownership
 * (`assigned_user_id = caller`) is in every `WHERE` too: an agent can only ever touch their
 * own contacts, whatever ids a request names.
 */
import type { PoolClient } from 'pg';
import { getPool } from '@magick-agency/db';
import { withTransaction } from '@magick-agency/db/utils/transaction';
import type { AgencyContactState } from '@magick-agency/contracts/agency';
import type { AgencyAgentRetryBlock } from '@magick-agency/contracts/api/agency/assignment';
import type { AgencyContactRecord } from '../../models/agency.model.js';
import type { AgentDialBasis, AgentDialFacts } from '../../../agency/contact-overrides.js';
import {
  agentRetryAvailableAtSql,
  agentRetryBlockSql,
  agentRetryCoolingSql,
  bindAgentRetrySettings,
  numberLiveSql,
  type AgentRetrySettings,
} from './assignment-sql.js';
import { params } from './query-builders.js';

export type { AgentRetrySettings } from './assignment-sql.js';

/** How many skipped contacts a reopen names (the contract's cap); `skippedTotal` counts all. */
export const AGENT_RETRY_SKIPPED_LIST_MAX = 50;

export interface AgentRetryReopenResult {
  reopened: string[];
  skipped: Array<{ contact_id: string; blocked: AgencyAgentRetryBlock }>;
  skippedTotal: number;
}

/** What an agent dial's claim spent, and where it found the contact (for an exact undo). */
export interface AgentDialClaim {
  contact: AgencyContactRecord;
  prior: { state: AgencyContactState; nextAttemptAt: Date };
  /**
   * `agentReopen`: the claim cleared a pending reopen marker (`agent_reopen_pending`, 0013): the
   * agent's own dial is the reopen's follow-up, so no paced dial after it is flagged
   * `agent_reopened`. Given back by the undo, like the rest.
   */
  spent: { round: boolean; retryDelay: boolean; callingHours: boolean; agentReopen: boolean };
  /**
   * The row version the claim wrote (the contact row's `xmin`): any later write to the row,
   * by anyone, changes it. {@link AgencyAgentRetryRepository.releaseRefusedAgentDialClaim}
   * undoes the claim only while it still matches.
   */
  rowVersion: string;
}

/** The exact undo's SET: the state and due time the claim found, and what it spent, given back. */
const UNDO_AGENT_DIAL_CLAIM_SET = `
          SET state = CASE WHEN c.suppressed_reason = 'dnc' THEN 'suppressed' ELSE $2::varchar END,
              next_attempt_at = CASE WHEN c.suppressed_reason = 'dnc' THEN c.next_attempt_at ELSE $3::timestamptz END,
              agent_retry_rounds_used = GREATEST(0, c.agent_retry_rounds_used - $4::int),
              override_retry_delay = c.override_retry_delay OR $5::boolean,
              override_calling_hours = c.override_calling_hours OR $6::boolean,
              agent_reopen_pending = c.agent_reopen_pending OR $7::boolean,
              updated_at = now()`;

function undoValues(contactId: string, claim: Pick<AgentDialClaim, 'prior' | 'spent'>): unknown[] {
  return [
    contactId, claim.prior.state, claim.prior.nextAttemptAt,
    claim.spent.round ? 1 : 0, claim.spent.retryDelay, claim.spent.callingHours, claim.spent.agentReopen,
  ];
}

export class AgencyAgentRetryRepository {
  /**
   * Reopen the caller's not-reached contacts on a campaign: `pending`, due now
   * (`next_attempt_at = now()`), one agent retry round spent (`agent_retry_rounds_used + 1`),
   * and marked `agent_reopen_pending` so the first paced dial of each is stamped
   * `agent_reopened` (`AgencyAttemptRepository.create`, `consumeAgentReopen`; IN2).
   * A contact whose cooldown is still running is reopened only through a held retry-delay
   * override (`agentRetryBlockSql`), and the reopen spends it.
   *
   * `contactIds` names the contacts (at most the contract's 500), or null for every eligible
   * one. Ids that are not the caller's contacts on this campaign (another agent's, the pool's,
   * another campaign's, missing) are dropped from BOTH lists, so the answer says nothing about
   * a contact that is not theirs. A named contact of theirs that cannot be reopened is listed
   * as skipped with its block (`not_retryable`, `suppressed`, `rounds_used`, `cooldown`, ...).
   * With `contactIds = null` the skipped list is the not-reached contacts that are still
   * blocked (`rounds_used`, `cooldown`): every other contact the agent holds (pending, reached,
   * on a call) was never a candidate.
   *
   * One transaction: lock the candidate rows (`FOR UPDATE`, in id order so two concurrent
   * reopens cannot deadlock), then ONE statement that reopens the ones `agentRetryBlockSql`
   * still clears, re-evaluated on the rows as they are now, and reads the blocks of the rest
   * from the same snapshot. A concurrent dial, DNC mark or reassignment either committed before
   * the lock (and the re-evaluation sees it) or waits behind it.
   */
  async reopenForAgent(input: {
    campaignId: string;
    userId: string;
    contactIds: readonly string[] | null;
    settings: AgentRetrySettings;
  }): Promise<AgentRetryReopenResult> {
    return withTransaction(async (client) => {
      const lp = params();
      const campaign = lp.add(input.campaignId);
      const user = lp.add(input.userId);
      let filter: string;
      if (input.contactIds) {
        filter = `c.id = ANY(${lp.add(input.contactIds)}::uuid[])`;
      } else {
        const block = agentRetryBlockSql('c', bindAgentRetrySettings(lp, input.settings));
        // Eligible now (NULL) or blocked only by rounds or cooldown; COALESCE expands the CASE once.
        filter = `c.state IN ('pending', 'exhausted') AND COALESCE(${block}, 'rounds_used') IN ('rounds_used', 'cooldown')`;
      }
      const { rows: locked } = await client.query<{ id: string }>(
        `SELECT c.id FROM agency_contacts c
          WHERE c.campaign_id = ${campaign}::uuid AND c.assigned_user_id = ${user}::uuid AND ${filter}
          ORDER BY c.id
            FOR UPDATE`,
        lp.values,
      );
      if (locked.length === 0) return { reopened: [], skipped: [], skippedTotal: 0 };

      const p = params();
      const ids = p.add(locked.map((r) => r.id));
      const c1 = p.add(input.campaignId);
      const u1 = p.add(input.userId);
      const s = bindAgentRetrySettings(p, input.settings);
      const block = agentRetryBlockSql('c', s);
      const { rows } = await client.query<{ id: string; reopened: boolean; blocked: AgencyAgentRetryBlock | null }>(
        `WITH reopened AS (
           UPDATE agency_contacts c
              SET state = 'pending',
                  next_attempt_at = now(),
                  agent_retry_rounds_used = c.agent_retry_rounds_used + 1,
                  agent_reopen_pending = true,
                  -- Spent only when it is what let the reopen through a running cooldown.
                  override_retry_delay = CASE
                    WHEN c.override_retry_delay AND ${agentRetryCoolingSql('c', s.cooldownMinutes)} THEN false
                    ELSE c.override_retry_delay END,
                  updated_at = now()
            WHERE c.id = ANY(${ids}::uuid[])
              AND c.campaign_id = ${c1}::uuid
              AND c.assigned_user_id = ${u1}::uuid
              AND ${block} IS NULL
           RETURNING c.id
         )
         SELECT c.id, (r.id IS NOT NULL) AS reopened, CASE WHEN r.id IS NULL THEN ${block} END AS blocked
           FROM agency_contacts c
           LEFT JOIN reopened r ON r.id = c.id
          WHERE c.id = ANY(${ids}::uuid[])
          ORDER BY c.id`,
        p.values,
      );
      const reopened = rows.filter((r) => r.reopened).map((r) => r.id);
      const skippedAll = rows
        .filter((r) => !r.reopened)
        // A row the UPDATE refused reads a block on the same snapshot; `not_retryable` is the
        // floor for one that does not (the cooldown ran out between the two evaluations).
        .map((r) => ({ contact_id: r.id, blocked: r.blocked ?? ('not_retryable' as const) }));
      return {
        reopened,
        skipped: skippedAll.slice(0, AGENT_RETRY_SKIPPED_LIST_MAX),
        skippedTotal: skippedAll.length,
      };
    }, { pool: getPool() });
  }

  /**
   * The caller's contact on this campaign, with what {@link chooseAgentDialBasis} reads, or
   * null when it is not theirs (another agent's, the pool's, another campaign's, missing: one
   * answer). A read, not a lock: the claim re-checks all of it.
   */
  async evaluateForAgentDial(input: {
    contactId: string;
    campaignId: string;
    userId: string;
    settings: AgentRetrySettings;
  }): Promise<{ contact: AgencyContactRecord; facts: AgentDialFacts } | null> {
    const p = params();
    const id = p.add(input.contactId);
    const campaign = p.add(input.campaignId);
    const user = p.add(input.userId);
    const s = bindAgentRetrySettings(p, input.settings);
    const { rows } = await getPool().query<AgencyContactRecord & {
      due: boolean; retry_block: AgencyAgentRetryBlock | null; available_at: Date | null;
    }>(
      `SELECT c.*,
              (c.state = 'pending' AND c.next_attempt_at <= now()) AS due,
              ${agentRetryBlockSql('c', s)} AS retry_block,
              ${agentRetryAvailableAtSql('c', s.cooldownMinutes)} AS available_at
         FROM agency_contacts c
        WHERE c.id = ${id}::uuid AND c.campaign_id = ${campaign}::uuid AND c.assigned_user_id = ${user}::uuid`,
      p.values,
    );
    const row = rows[0];
    if (!row) return null;
    const { due, retry_block: retryBlock, available_at: availableAt, ...contact } = row;
    return {
      contact: contact as AgencyContactRecord,
      facts: {
        state: row.state,
        dnc: row.suppressed_reason === 'dnc',
        due,
        overrideRetryDelay: row.override_retry_delay,
        retryBlock,
        availableAt,
      },
    };
  }

  /**
   * Claim one of the caller's contacts for a dial they place themselves: `pending` or
   * `exhausted` → `in_flight`, spending what `basis` spends, in ONE statement, so the spend
   * and the claim cannot be separated (a lost claim spends nothing).
   *
   * The pick (`FOR UPDATE SKIP LOCKED`, as `claimDialable`: a row a pacing tick or a soft-phone
   * claim holds is skipped, never waited on) requires, on the row as it is now:
   *  - the caller owns it on this campaign;
   *  - it is `pending` or `exhausted` and NOT DNC-suppressed (`claimDialable`'s defence in depth);
   *  - one live call per number: no contact of this ACCOUNT, on any of its campaigns, on the
   *    same number is `in_flight` or `connected` (`numberLiveSql`, the digits projection, as
   *    `claimDialable`). Account-wide, not campaign-wide (decisions MC4): the agent's dial
   *    starts a call like a paced one, and a retry child or another roster of the account may
   *    be ringing the same customer right now;
   *  - the basis still holds: `due` (pending, due now), `retry_delay` (pending, override held),
   *    `retry_round` (`agentRetryBlockSql` IS NULL, which re-checks the rounds and cooldown);
   *  - `spendCallingHours` only while the override is still held.
   *
   * Spends: a round for `retry_round`; the retry-delay override for `retry_delay`, and for a
   * `retry_round` that went through a running cooldown on it; the calling-hours override when
   * `spendCallingHours`. Returns null when nothing was claimed (the caller re-reads to say why).
   */
  async claimForAgentDial(input: {
    contactId: string;
    campaignId: string;
    userId: string;
    basis: AgentDialBasis;
    spendCallingHours: boolean;
    settings: AgentRetrySettings;
  }): Promise<AgentDialClaim | null> {
    const p = params();
    const id = p.add(input.contactId);
    const campaign = p.add(input.campaignId);
    const user = p.add(input.userId);
    const basis = p.add(input.basis);
    const hours = p.add(input.spendCallingHours);
    const s = bindAgentRetrySettings(p, input.settings);
    const { rows } = await getPool().query<AgencyContactRecord & {
      prior_state: AgencyContactState; prior_next_attempt_at: Date;
      spent_round: boolean; spent_retry_delay: boolean; spent_calling_hours: boolean;
      spent_agent_reopen: boolean; row_version: string;
    }>(
      `WITH target AS MATERIALIZED (
         SELECT c.id, c.state AS prior_state, c.next_attempt_at AS prior_next_attempt_at,
                c.override_retry_delay AS prior_retry_delay,
                c.agent_reopen_pending AS prior_reopen_pending,
                ${agentRetryCoolingSql('c', s.cooldownMinutes)} AS cooling
           FROM agency_contacts c
          WHERE c.id = ${id}::uuid AND c.campaign_id = ${campaign}::uuid
            AND c.assigned_user_id = ${user}::uuid
            AND c.state IN ('pending', 'exhausted')
            AND c.suppressed_reason IS DISTINCT FROM 'dnc'
            AND NOT ${numberLiveSql('c')}
            FOR UPDATE OF c SKIP LOCKED
       )
       UPDATE agency_contacts c
          SET state = 'in_flight',
              agent_retry_rounds_used = c.agent_retry_rounds_used
                + CASE WHEN ${basis}::text = 'retry_round' THEN 1 ELSE 0 END,
              override_retry_delay = CASE
                WHEN ${basis}::text = 'retry_delay' THEN false
                WHEN ${basis}::text = 'retry_round' AND t.cooling THEN false
                ELSE c.override_retry_delay END,
              override_calling_hours = CASE WHEN ${hours}::boolean THEN false ELSE c.override_calling_hours END,
              agent_reopen_pending = false,
              updated_at = now()
         FROM target t
        WHERE c.id = t.id
          AND CASE ${basis}::text
                WHEN 'due' THEN c.state = 'pending' AND c.next_attempt_at <= now()
                WHEN 'retry_delay' THEN c.state = 'pending' AND c.override_retry_delay
                WHEN 'retry_round' THEN ${agentRetryBlockSql('c', s)} IS NULL
                ELSE false
              END
          AND (NOT ${hours}::boolean OR c.override_calling_hours)
      RETURNING c.*, t.prior_state, t.prior_next_attempt_at,
                (${basis}::text = 'retry_round') AS spent_round,
                (t.prior_retry_delay AND (${basis}::text = 'retry_delay'
                  OR (${basis}::text = 'retry_round' AND t.cooling))) AS spent_retry_delay,
                ${hours}::boolean AS spent_calling_hours,
                t.prior_reopen_pending AS spent_agent_reopen,
                c.xmin::text AS row_version`,
      p.values,
    );
    const row = rows[0];
    if (!row) return null;
    const {
      prior_state: priorState, prior_next_attempt_at: priorNext,
      spent_round: round, spent_retry_delay: retryDelay, spent_calling_hours: callingHours,
      spent_agent_reopen: agentReopen, row_version: rowVersion,
      ...contact
    } = row;
    return {
      contact: contact as AgencyContactRecord,
      prior: { state: priorState, nextAttemptAt: priorNext },
      spent: { round, retryDelay, callingHours, agentReopen },
      rowVersion,
    };
  }

  /**
   * Undo an agent dial's claim that placed no call (an attempt INSERT that threw, a failed
   * dispatch; a REFUSED insert is {@link releaseRefusedAgentDialClaim}): the contact goes back to the state and due time the claim found, and what the
   * claim spent is given back (the round, the overrides). Only while the claim still holds it:
   * `in_flight` with no live attempt (the caller ends its attempt, if any, first), so a contact
   * something else moved since is left alone. The DNC freeze holds (`markState`'s rule): a row
   * marked DNC meanwhile goes to `suppressed`, keeping its due time.
   *
   * Returns whether it was released.
   */
  async releaseAgentDialClaim(
    contactId: string,
    claim: Pick<AgentDialClaim, 'prior' | 'spent'>,
    deps: { client?: Pick<PoolClient, 'query'> } = {},
  ): Promise<boolean> {
    const { rowCount } = await (deps.client ?? getPool()).query(
      `UPDATE agency_contacts c${UNDO_AGENT_DIAL_CLAIM_SET}
        WHERE c.id = $1::uuid
          AND c.state = 'in_flight'
          AND NOT EXISTS (
                SELECT 1 FROM agency_call_attempts a
                 WHERE a.contact_id = c.id AND a.state <> 'ended')`,
      undoValues(contactId, claim),
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Undo an agent dial's claim whose attempt INSERT was refused (`uq_agency_attempt_live` or
   * `uq_agency_attempt_number`: another attempt on the contact is live, or won the number).
   * {@link releaseAgentDialClaim} cannot: its live-attempt guard sees that OTHER attempt and
   * would leave the contact `in_flight`, its round and overrides spent and its prior state
   * lost, for the stranded-contact sweep to requeue as `pending`.
   *
   * The live attempt is not this claim's, and it did not put the contact `in_flight`: the claim
   * took it from `pending` / `exhausted`. So the guard here is the claim's own row version
   * instead ({@link AgentDialClaim.rowVersion}): the contact is put back only while NOTHING has
   * written the row since the claim. If that other attempt settled the contact meanwhile, or a
   * pacing tick or soft-phone claim then took it with an attempt of its own, or a DNC mark
   * landed, the row version moved and this leaves the row to them (and to the sweeps).
   *
   * Returns whether it was released.
   */
  async releaseRefusedAgentDialClaim(
    contactId: string,
    claim: Pick<AgentDialClaim, 'prior' | 'spent' | 'rowVersion'>,
  ): Promise<boolean> {
    const { rowCount } = await getPool().query(
      `UPDATE agency_contacts c${UNDO_AGENT_DIAL_CLAIM_SET}
        WHERE c.id = $1::uuid
          AND c.state = 'in_flight'
          AND c.xmin = $8::text::xid`,
      [...undoValues(contactId, claim), claim.rowVersion],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Whether a contact of this ACCOUNT (any campaign) on the same number as `contactId` (itself
   * included) is on a call or held for a write-up: why a claim refused a contact that was
   * otherwise eligible. The same `numberLiveSql` probe as {@link claimForAgentDial}, so the
   * explanation and the refusal cannot disagree (decisions MC4). `campaignId` only scopes the
   * contact itself. A read: the claim is the authority.
   */
  async numberIsLive(campaignId: string, contactId: string): Promise<boolean> {
    const { rows } = await getPool().query<{ live: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM agency_contacts c
          WHERE c.id = $1::uuid AND c.campaign_id = $2::uuid AND ${numberLiveSql('c')}
       ) AS live`,
      [contactId, campaignId],
    );
    return rows[0]?.live ?? false;
  }
}

export const agencyAgentRetryRepository = new AgencyAgentRetryRepository();

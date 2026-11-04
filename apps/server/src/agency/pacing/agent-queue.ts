/**
 * An agent's own queue on a `strict` or `preferred` campaign (contact assignment, CA3): whether
 * something is due for them now, and when nothing is, why (`AgencyQueueState`). Pacing reads it
 * for every available agent on each tick (who is worth reserving, and the `queue` frame sent
 * on a change); the session bootstrap, the station's `ready` frame and the agent's My contacts
 * summary read it for one agent. One reading for all four, so they cannot disagree.
 *
 * An agent is due when an own open contact is due, or (`preferred`) one of the pool's due
 * contacts is theirs: pacing gives the pool's due contacts to the agents without own work in its
 * fairness order (longest idle first), one each, so with k due pool contacts only the first k
 * such agents are due ({@link readAgentQueues}); the reading is exactly who pacing reserves.
 * A due agent is `{ due: true, reason: null, next_due_at: null }`. For an agent with nothing due:
 *
 *  1. `outside_calling_hours`: the campaign's calling window (its default timezone) is closed now;
 *  2. `queue_empty`: no open contact is theirs (`preferred`: and the pool has none);
 *  3. `callbacks_later`: every open contact they can be given is a callback (`contactBucketSql`);
 *  4. `waiting_for_retry`: otherwise (the retry policy scheduled them later, or, `preferred`, the
 *     pool's due contacts all went to agents ahead of them this tick).
 *
 * `next_due_at` is the earliest `next_attempt_at` among the open contacts they can be given
 * (own, plus the pool in `preferred` mode), or null when there are none. A pool whose due
 * contacts all went to agents ahead adds no time: its earliest is one of those (already past),
 * and the probe does not read the next one. A due agent carries null, so the state does not
 * change (and no frame is sent) while they stay due.
 *
 * "Due" wins over a closed window: a due contact in its own timezone's window is dialled, and
 * one outside it is deferred by the pre-dial gate to its window's opening, after which the
 * agent reads `outside_calling_hours` with that opening as `next_due_at`.
 */
import type { AgencyQueueState } from '@magick-agency/contracts/agency';
import type { AgencyCampaignRecord } from '../../db/models/agency.model.js';
import {
  agencyContactRepository,
  type AgencyAgentQueueProbeRow,
  type AgencyOwnerClaimMode,
  type AgencyPoolQueueProbe,
} from '../../db/repositories/agency.repository.js';
import { callbackCodes } from '../../db/repositories/agency/assignment-sql.js';
import { callingWindowState, resolveCallingWindow } from '../calling-hours.js';

/** The campaign's owner-pairing mode, or null for `pool` (and for a row from before 0009). */
export function ownerModeOf(campaign: Pick<AgencyCampaignRecord, 'assignment_mode'>): AgencyOwnerClaimMode | null {
  const mode = (campaign as { assignment_mode?: unknown }).assignment_mode;
  return mode === 'strict' || mode === 'preferred' ? mode : null;
}

/** The campaign's calling window, in its default timezone, is not open at `now` (closed or unresolvable). */
export function campaignWindowClosed(
  campaign: Pick<AgencyCampaignRecord, 'calling_window_start' | 'calling_window_end' | 'calling_days' | 'default_timezone'>,
  now: Date,
): boolean {
  return callingWindowState(resolveCallingWindow(campaign, { timezone: null }), now) !== 'open';
}

/** One agent's reading: the state, and what pacing needs to decide whether to reserve them. */
export interface AgentQueueReading {
  state: AgencyQueueState;
  /** An own contact is due. */
  ownDue: boolean;
}

function earliest(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() <= b.getTime() ? a : b;
}

/**
 * The state of one agent from the probe (pure; `pool` is null in `strict` mode).
 * `poolDueTaken`: the pool's due contacts all went to agents ahead of this one
 * ({@link readAgentQueues}), so none is theirs; the pool still has open contacts.
 */
export function queueStateFrom(
  own: Pick<AgencyAgentQueueProbeRow, 'ownDue' | 'ownNextAt' | 'ownHasNonCallback'>,
  pool: AgencyPoolQueueProbe | null,
  windowClosed: boolean,
  poolDueTaken = false,
): AgencyQueueState {
  const poolDue = pool !== null && pool.dueCount > 0 && !poolDueTaken;
  if (own.ownDue || poolDue) return { due: true, reason: null, next_due_at: null };
  const ownOpen = own.ownNextAt !== null;
  const poolOpen = pool !== null && pool.nextAt !== null;
  const next = earliest(own.ownNextAt, poolDueTaken ? null : pool?.nextAt ?? null);
  const nextIso = next ? next.toISOString() : null;
  if (windowClosed) return { due: false, reason: 'outside_calling_hours', next_due_at: nextIso };
  if (!ownOpen && !poolOpen) return { due: false, reason: 'queue_empty', next_due_at: null };
  const allCallbacks = (!ownOpen || own.ownHasNonCallback === false)
    && (!poolOpen || pool!.hasNonCallback === false);
  return { due: false, reason: allCallbacks ? 'callbacks_later' : 'waiting_for_retry', next_due_at: nextIso };
}

/**
 * The queue an agent reads on a `pool` campaign (the My contacts summary): there is no per-agent
 * queue, so it is the campaign's open contacts through the same rule, read from their earliest
 * `next_attempt_at` alone. Open pool contacts are taken to include one that is not a callback,
 * so the answer is `waiting_for_retry`, never `callbacks_later`. The station gets no `queue`
 * frame on a pool campaign, so nothing can disagree with this.
 */
export function poolModeQueueState(
  campaign: Pick<AgencyCampaignRecord, 'calling_window_start' | 'calling_window_end' | 'calling_days' | 'default_timezone'>,
  nextOpenAt: Date | null,
  now: Date,
): AgencyQueueState {
  return queueStateFrom(
    { ownDue: false, ownNextAt: null, ownHasNonCallback: null },
    {
      dueCount: nextOpenAt !== null && nextOpenAt.getTime() <= now.getTime() ? 1 : 0,
      nextAt: nextOpenAt,
      hasNonCallback: nextOpenAt !== null ? true : null,
    },
    campaignWindowClosed(campaign, now),
  );
}

/** Two states are the same frame (the engine sends a `queue` frame only on a change). */
export function queueStateKey(s: AgencyQueueState): string {
  return `${s.due ? 1 : 0}|${s.reason ?? ''}|${s.next_due_at ?? ''}`;
}

/**
 * Read the queues of `agentUserIds` on an owner-mode campaign in one statement. `agentUserIds`
 * is pacing's fairness order (longest idle first): in `preferred` mode the pool's due contacts
 * go, one each, to the agents in that order who have nothing of their own due, and only those
 * read due (`state.due` is "pacing reserves this agent"), so a `queue` frame never says due to
 * an agent the tick then leaves idle. `poolDueCap` bounds the pool's due count: pacing passes
 * its candidate count, since it never reserves more agents for the pool than that.
 */
export async function readAgentQueues(
  campaign: AgencyCampaignRecord,
  mode: AgencyOwnerClaimMode,
  agentUserIds: readonly string[],
  now: Date,
  poolDueCap = agentUserIds.length,
): Promise<{ agents: Map<string, AgentQueueReading>; poolDue: number }> {
  const probe = await agencyContactRepository.probeAgentQueues(campaign.id, agentUserIds, {
    callbackCodes: callbackCodes(campaign.disposition_catalog),
    ...(mode === 'preferred' ? { pool: { dueCap: Math.max(1, poolDueCap) } } : {}),
  });
  const closed = campaignWindowClosed(campaign, now);
  const rows = new Map(probe.agents.map((row) => [row.agentUserId, row]));
  const agents = new Map<string, AgentQueueReading>();
  let poolLeft = probe.pool?.dueCount ?? 0;
  for (const agentUserId of agentUserIds) {
    const row = rows.get(agentUserId);
    if (!row || agents.has(agentUserId)) continue;
    // In fairness order: an agent without own work due takes one of the pool's due contacts
    // while any is left; the ones after them read the pool as taken.
    const poolDueTaken = !row.ownDue && poolLeft === 0 && (probe.pool?.dueCount ?? 0) > 0;
    if (!row.ownDue && poolLeft > 0) poolLeft--;
    agents.set(agentUserId, { ownDue: row.ownDue, state: queueStateFrom(row, probe.pool, closed, poolDueTaken) });
  }
  return { agents, poolDue: probe.pool?.dueCount ?? 0 };
}

/**
 * One agent's queue on `campaign` (the bootstrap, `ready` and the My contacts summary), or
 * undefined for a `pool` campaign, which has no per-agent queue. Read for this agent alone, so
 * in `preferred` mode a due pool contact is theirs: the answer pacing gives the agent first in
 * its fairness order. When colleagues ahead of them take every due pool contact, the station's
 * next `queue` frame says so (after a `ready` the leader sends the frame again).
 */
export async function readAgentQueueState(
  campaign: AgencyCampaignRecord,
  agentUserId: string,
  now = new Date(),
): Promise<AgencyQueueState | undefined> {
  const mode = ownerModeOf(campaign);
  if (!mode) return undefined;
  const { agents } = await readAgentQueues(campaign, mode, [agentUserId], now, 1);
  return agents.get(agentUserId)?.state ?? { due: false, reason: 'queue_empty', next_due_at: null };
}

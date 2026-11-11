import { DEVICE_AWAY_RETURN_GRACE_MS, type AgencyAgentState, type AgencyInboundStickyMode } from '@magick-agency/contracts/agency';

/**
 * ─── WHO MAY TAKE A WAITING INBOUND CALLER (docs/inbound.md §4.3, §5.1; P2) ────────────────────
 *
 * Pure: the connector (`inbound-connector.ts`) reads the agents (the station registry and their
 * Redis hash) and the queue, and asks these functions who to try, in what order. Nothing here
 * reserves anyone: the reservation is a compare-and-swap (`AgentStateMachine.reserveForInbound`)
 * the connector makes on each candidate in turn, so a stale view costs a lost CAS, never a
 * double booking.
 *
 * ── An agent who may take a caller ──────────────────────────────────────────────
 *  - a live CAMPAIGN session (a soft-phone session has no campaign and is never offered one: §4.3,
 *    "break/soft_phone → skipped") in the CALL's account (the matched contact's, which can differ
 *    from the route's: IQ21);
 *  - when the call's account is the route's, on one of the route's pool campaigns (an empty pool:
 *    every campaign of the account). The pool is the route's account's notion, so it does not
 *    apply to a caller whose match put them in another account (IQ21);
 *  - a station that can take inbound calls (`canTakeInbound`: every console, and a phone that
 *    declared `caps=inbound` on its upgrade; an older app build is treated as offline, IQ20 as
 *    amended by IQ46), held by this process and OPEN;
 *  - an active user with an active membership that can see the call's account
 *    (`InboundAgentView.member`, read by the connector at each search, so an agent removed from the
 *    account or deactivated while the caller waits is never offered the call: QA-F10);
 *  - not a session that already turned this caller down (`InboundCallerView.declinedSessionIds`:
 *    the agent hung up the offer, or the bridge refused to bind their socket to it);
 *  - Redis `available`, holding no soft-phone call, not a soft-phone session, no inbound call.
 *    The release hook asks the same question of an agent it is about to return to the pool, who
 *    is still `reserved`, `on_call` or `wrapup` ({@link RELEASE_STATES}).
 *
 * ── The sticky agent (§4.2, §4.3, IB2, IQ6) ──────────────────────────────────────
 * The caller's sticky agent is `sticky_user_id`. Their live session decides:
 *  - `available` and eligible → offered now;
 *  - `reserved` / `on_call` / `wrapup` (eligible but for the state) → `busy`: the caller waits for
 *    them ("Your customer is waiting"), and the release hook gives them the caller when that work
 *    ends (taken from wrap-up with no `available` instant);
 *  - anything else (offline, on a break or the soft phone, a phone that cannot take inbound calls,
 *    another account, outside the pool, no session) → `away`: the team at once, under `strict` too (IQ6). The follow-up, if
 *    nobody answers, is still assigned to them (the router's settle).
 *
 * The STICKY PHASE is the time only the sticky agent may take the caller: `loose` until
 * `sticky_wait_seconds` after the caller queued; `strict` until the queue's maximum wait (whose
 * timer overflows the call); `off`, or no sticky agent, or an `away` one: none. After a `loose`
 * phase the sticky agent is still preferred when they are free (§4.2).
 *
 * ── Could anyone take them at all (PM-M6) ────────────────────────────────────────
 * {@link couldTakeLater}: an agent who may take the caller now OR once the work they are doing
 * ends (`reserved`, `on_call`, `wrapup`; another call held counts, it ends too). A caller for whom
 * no session of the pool qualifies is overflowed at once rather than held to the maximum wait:
 * nobody on a break, offline, on an app build that cannot take inbound calls, outside the pool or
 * out of the account will ever be offered them.
 *
 * A station that closed moments ago still counts (SWE-F1): a session whose socket closed less than
 * the rejoin grace ago (`INBOUND_STATION_REJOIN_GRACE_MS`, the console's reconnect and the
 * bridge's 8 s deferred hangup) and whose agent was working or available then
 * ({@link InboundAgentView.rejoining}) is one who could take the caller once they are back. Never
 * offered (no open station), only counted, so a Wi-Fi blip, a page refresh or a backlog close of
 * the one agent who could take the callers does not overflow every one of them at once. The
 * connector asks again when the grace ends.
 *
 * A phone that left the app moments ago counts too (IQ50): a session on a `device_away` pause
 * applied less than {@link INBOUND_DEVICE_AWAY_GRACE_MS} ago ({@link InboundAgentView.awayGrace})
 * is one who could take the caller, because the app returns the agent by itself when they come
 * back within it. Never offered (they are on a break), only counted; the connector asks again when
 * the pause's grace ends, and callers then overflow if nobody else could take them. Any other
 * break (`phone_call` included: the agent is on another call) never counts.
 *
 * ── Order ───────────────────────────────────────────────────────────────────────
 * Callers are served FIFO by when they queued, a requeued caller (its station lost before audio
 * bound) back at the head (`inbound-queue.ts`). For each caller the agents are tried: in its
 * sticky phase, its sticky agent only; else its sticky agent first when available, then the team
 * longest idle first by Redis `since`, ties on the session id: `planTick`'s rule
 * (`pacing-engine.ts`), so inbound and pacing agree on who has waited longest. Before that FIFO
 * pass, every caller whose sticky agent is available now is matched to them: an agent who frees
 * takes their own customer before anyone else's (§2 step 4).
 */

/**
 * IQ50: how long a `device_away` pause counts as "could take" a waiting caller (the app's own
 * return grace, `DEVICE_AWAY_RETURN_GRACE_MS`, 30 s).
 */
export const INBOUND_DEVICE_AWAY_GRACE_MS = DEVICE_AWAY_RETURN_GRACE_MS;

/** The states the release hook may take an agent from: the agent `releaseAgent` would return to the pool. */
export const RELEASE_STATES = ['reserved', 'on_call', 'wrapup'] as const satisfies readonly AgencyAgentState[];

/** One agent session as the search sees it: the station registry's entry and the Redis hash. */
export interface InboundAgentView {
  sessionId: string;
  agentUserId: string;
  tenantId: string;
  accountId: string;
  /** NULL: a soft-phone session. */
  campaignId: string | null;
  /**
   * The station can take inbound calls (the registry's `canTakeInbound`: a console, or a phone that
   * declared `caps=inbound`). For a station within the rejoin grace: the capability its socket had.
   */
  canTakeInbound: boolean;
  /** Held by this process with its socket OPEN. */
  stationOpen: boolean;
  /**
   * The station closed less than the rejoin grace ago, and `live` is the state the agent was in
   * then or is in now (the close handler writes `offline`): the session counts for
   * {@link couldTakeLater} as if its station were open, and is never offered a caller.
   */
  rejoining?: boolean;
  /**
   * IQ50: the agent is on a `device_away` pause applied less than {@link INBOUND_DEVICE_AWAY_GRACE_MS}
   * ago (`live.state` is `break`): the session counts for {@link couldTakeLater} as if it were
   * `available`, and is never offered a caller.
   */
  awayGrace?: boolean;
  /**
   * The agent is an active user with an active membership that can see the account (tenant-wide
   * or this account), as of the connector's last read: false for one removed or deactivated.
   */
  member: boolean;
  /** The Redis hash; null when the lease has lapsed. */
  live: {
    state: AgencyAgentState;
    /** Epoch ms of the last transition (the idle clock); null on an old key. */
    since: number | null;
    manualCallId: string | null;
    softphone: boolean;
    inboundCallId: string | null;
  } | null;
}

/** One waiting caller as the search sees it. */
export interface InboundCallerView {
  callId: string;
  tenantId: string;
  /** The call's account (the matched contact's, else the route's): whose agents may take it. */
  accountId: string;
  /** The route's account: its pool applies only when it is the call's. */
  routeAccountId: string;
  /** The route's pool campaigns; empty: every campaign of the account. */
  poolCampaignIds: readonly string[];
  stickyMode: AgencyInboundStickyMode;
  stickyUserId: string | null;
  stickyWaitMs: number;
  /** Epoch ms of the first queueing (`queued_at`). */
  queuedAt: number;
  /** Sessions this caller is never offered to again: they turned the offer down (QA-F3, SWE-m4). */
  declinedSessionIds?: ReadonlySet<string>;
}

/** Why an agent may not take a caller (null: they may). */
export type InboundIneligibility =
  | 'other_account'
  | 'not_campaign_session'
  | 'not_in_pool'
  | 'no_inbound_capability'
  | 'no_station'
  | 'not_member'
  | 'declined'
  | 'wrong_state'
  | 'holds_call';

/** Whether the route's pool applies to this caller, and is not the whole account. */
function poolApplies(caller: InboundCallerView): boolean {
  return caller.accountId === caller.routeAccountId && caller.poolCampaignIds.length > 0;
}

/**
 * Why `agent` may not take `caller`, or null. `states` are the Redis states that qualify:
 * `available` for the search, {@link RELEASE_STATES} for the release hook.
 */
export function inboundIneligibility(
  agent: InboundAgentView,
  caller: InboundCallerView,
  states: readonly AgencyAgentState[] = ['available'],
): InboundIneligibility | null {
  if (agent.tenantId !== caller.tenantId || agent.accountId !== caller.accountId) return 'other_account';
  if (agent.campaignId === null) return 'not_campaign_session';
  if (poolApplies(caller) && !caller.poolCampaignIds.includes(agent.campaignId)) return 'not_in_pool';
  if (!agent.canTakeInbound) return 'no_inbound_capability';
  if (!agent.stationOpen) return 'no_station';
  if (!agent.member) return 'not_member';
  if (caller.declinedSessionIds?.has(agent.sessionId)) return 'declined';
  const live = agent.live;
  if (!live || !states.includes(live.state)) return 'wrong_state';
  if (live.manualCallId || live.softphone || live.inboundCallId) return 'holds_call';
  return null;
}

/** The states of an agent who may take a caller now or once their current work ends (PM-M6). */
export const COULD_TAKE_STATES = ['available', ...RELEASE_STATES] as const satisfies readonly AgencyAgentState[];

/**
 * Whether `agent` could take `caller` now or once the work they are doing ends (see the header):
 * every rule but the state, which may be any of {@link COULD_TAKE_STATES}, and a call or a
 * soft-phone call already held (it ends). A session in soft-phone mode does not qualify.
 */
export function couldTakeLater(agent: InboundAgentView, caller: InboundCallerView): boolean {
  // A station back in a moment counts as open here, and here only; so does an agent whose phone
  // left the app moments ago, as if available (IQ50; see the header).
  let judged = agent.rejoining ? { ...agent, stationOpen: true } : agent;
  if (agent.awayGrace && agent.live?.state === 'break') judged = { ...judged, live: { ...agent.live, state: 'available' } };
  const why = inboundIneligibility(judged, caller, COULD_TAKE_STATES);
  return why === null || (why === 'holds_call' && agent.live !== null && !agent.live.softphone);
}

/** Whether any of `agents` could take `caller` now or later ({@link couldTakeLater}). False: nobody ever will. */
export function anyoneCouldTake(caller: InboundCallerView, agents: readonly InboundAgentView[]): boolean {
  return agents.some((a) => couldTakeLater(a, caller));
}

/** Where the caller's sticky agent is (see the header). */
export type StickyAgentStatus = 'available' | 'busy' | 'away';

/** The caller's sticky agent's session among `agents`, or undefined (no sticky agent, or not live here). */
export function stickyAgentOf(caller: InboundCallerView, agents: readonly InboundAgentView[]): InboundAgentView | undefined {
  if (!caller.stickyUserId) return undefined;
  return agents.find((a) => a.agentUserId === caller.stickyUserId && a.tenantId === caller.tenantId);
}

export function stickyAgentStatus(agent: InboundAgentView | undefined, caller: InboundCallerView): StickyAgentStatus {
  if (!agent) return 'away';
  if (inboundIneligibility(agent, caller, ['available']) === null) return 'available';
  // Busy: eligible in every respect but the state, and that state is one a release ends.
  const asBusy = inboundIneligibility(agent, caller, RELEASE_STATES);
  // A session holding ANOTHER inbound call is busy with it, and frees through the same release.
  if (asBusy === null || (asBusy === 'holds_call' && agent.live !== null
    && (RELEASE_STATES as readonly string[]).includes(agent.live.state)
    && !agent.live.manualCallId && !agent.live.softphone)) return 'busy';
  return 'away';
}

/** Whether only the sticky agent may take the caller now (see the header). */
export function inStickyPhase(caller: InboundCallerView, status: StickyAgentStatus, now: number): boolean {
  if (caller.stickyMode === 'off' || !caller.stickyUserId || status === 'away') return false;
  if (caller.stickyMode === 'strict') return true;
  return now < caller.queuedAt + caller.stickyWaitMs;
}

/** Longest idle first by Redis `since`, ties on the session id (`planTick`'s order). */
export function byLongestIdle(a: InboundAgentView, b: InboundAgentView): number {
  const since = (v: InboundAgentView) => v.live?.since ?? Number.MAX_SAFE_INTEGER;
  return since(a) - since(b) || a.sessionId.localeCompare(b.sessionId);
}

/** The sessions to try for one caller, in order (see the header). */
export function candidatesFor(caller: InboundCallerView, agents: readonly InboundAgentView[], now: number): string[] {
  // Sticky routing off: the caller's agent is just one of the team.
  const sticky = caller.stickyMode === 'off' ? undefined : stickyAgentOf(caller, agents);
  const status = stickyAgentStatus(sticky, caller);
  if (inStickyPhase(caller, status, now)) return status === 'available' ? [sticky!.sessionId] : [];
  const team = agents
    .filter((a) => inboundIneligibility(a, caller) === null && a.sessionId !== sticky?.sessionId)
    .sort(byLongestIdle)
    .map((a) => a.sessionId);
  return status === 'available' ? [sticky!.sessionId, ...team] : team;
}

/** One caller's turn in a search: who to try for it, in order. */
export interface InboundSearchStep {
  callId: string;
  candidates: string[];
}

/**
 * The search over an account's waiting callers (`callers` FIFO, the head first): every caller
 * whose sticky agent is available is matched to them first, then every caller in FIFO order with
 * its {@link candidatesFor} list. The connector walks the steps, skipping a session it has just
 * reserved for an earlier step and a caller already offered.
 */
export function searchOrder(
  callers: readonly InboundCallerView[],
  agents: readonly InboundAgentView[],
  now: number,
): InboundSearchStep[] {
  const steps: InboundSearchStep[] = [];
  for (const caller of callers) {
    const sticky = stickyAgentOf(caller, agents);
    if (caller.stickyMode !== 'off' && sticky && stickyAgentStatus(sticky, caller) === 'available') {
      steps.push({ callId: caller.callId, candidates: [sticky.sessionId] });
    }
  }
  for (const caller of callers) steps.push({ callId: caller.callId, candidates: candidatesFor(caller, agents, now) });
  return steps;
}

/**
 * The release hook's question (§2, "Sticky agent in wrap-up"): which waiting caller, if any, the
 * agent `agent` (still `reserved`, `on_call` or `wrapup`, about to be returned to the pool) takes.
 * Callers sticky to them first (FIFO), then the team's callers they may take: a caller in another
 * agent's sticky phase is not theirs to take. `agents` are the account's other sessions, for the
 * other callers' sticky agents. Null: none.
 */
export function callerForReleasedAgent(
  agent: InboundAgentView,
  callers: readonly InboundCallerView[],
  agents: readonly InboundAgentView[],
  now: number,
): string | null {
  const mayTake = (c: InboundCallerView) => inboundIneligibility(agent, c, RELEASE_STATES) === null;
  const own = callers.find((c) => c.stickyMode !== 'off' && c.stickyUserId === agent.agentUserId
    && c.tenantId === agent.tenantId && mayTake(c));
  if (own) return own.callId;
  for (const c of callers) {
    if (!mayTake(c)) continue;
    if (c.stickyUserId && c.stickyUserId !== agent.agentUserId) {
      const theirs = stickyAgentOf(c, agents);
      if (inStickyPhase(c, stickyAgentStatus(theirs, c), now)) continue;
    }
    return c.callId;
  }
  return null;
}

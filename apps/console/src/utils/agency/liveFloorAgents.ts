import type { AgencyFloorAgent, AgencyFloorResponse } from '@magick-agency/contracts/api/agency/floor';
import type { AgencyPromisesSummaryResponse } from '@magick-agency/contracts/api/agency/promises';
import type { AgencyLiveCall } from '@magick-agency/contracts/api/agency/live-calls';
import type { AgencySupervisorAgent } from '../../types/agency-campaign';
import {
  AGENCY_FLOOR_RISK_RANK,
  agentDisplayName,
  agentsOnShift,
  floorRisk,
  isOnSoftphone,
  isWarningRisk,
  owesInboundOutcome,
  type AgencyFloorRisk,
} from '../agencyAgentFloor';
import { campaignTabHref } from '../agencyCampaignTabs';
import { customerLabel } from '../listen/listenCopy';
import type { ListenCall } from '../listen/liveCallsTable';
import { formatAmountShort, sumPromiseAmounts } from '../format/promise';
import { formatCount, plural } from '../format/number';
import { elapsedSince } from '../agencyClock';
import type { HomeAttentionItem, HomeCampaignRead, HomeCampaignRef } from './home';
import type { AgentsWorking } from './liveFloor';

/**
 * Live floor's agents (decision B28b, Phase 2): the account's floor read (`GET /floor`, one row per
 * agent) as cards, chips and Needs you now rows, and the promises summary as the Will pay tile.
 *
 * ── The campaign floor's rules, not a copy ──────────────────────────────────
 * Risk, labels, names and the force-return rule are `utils/agencyAgentFloor.ts`'s, typed to the
 * per-campaign floor's row (`AgencySupervisorAgent`). A floor row maps onto that row
 * ({@link supervisorAgentOf}) and each is measured against its OWN campaign's thresholds (the
 * row's `wrapup_window_seconds` and its call's `aht_seconds`), where the campaign floor has one set
 * for every row. So "Past wrap-up" means here what it means on the campaign's Agents tab.
 */

/**
 * The wrap-up state's words on Live floor only, for now: the agent is filing the call's outcome.
 * The campaign Agents tab keeps "Wrapping up" until the wording is decided for every screen.
 */
export const CHOOSING_OUTCOME_LABEL = 'Choosing outcome';

/**
 * The chips' and cards' states, in the chips' order. A call being connected counts as on a call.
 * `softphone` is a soft-phone session with no call in progress: its wire state is `break` (the
 * reserved reason `soft_phone`, `docs/softphone.md` §2), but the agent is working calls by hand, so
 * it is neither a break nor ready, and it has a chip of its own (shown only when anyone is in it).
 */
export const FLOOR_CARD_STATES = ['on_call', 'available', 'wrapup', 'softphone', 'break', 'offline'] as const;
export type FloorCardState = (typeof FLOOR_CARD_STATES)[number];

/** A card's state tag, and its chip's word. */
export const FLOOR_CARD_LABELS: Record<FloorCardState, string> = {
  on_call: 'On a call',
  available: 'Ready',
  wrapup: CHOOSING_OUTCOME_LABEL,
  softphone: 'On soft phone',
  break: 'Break',
  offline: 'Offline',
};

/**
 * A row with a call in progress is on a call whatever its session's state: a soft-phone session
 * stays `break`/`soft_phone` through its manual calls, and its call is what the supervisor needs.
 */
export function floorCardState(row: Pick<AgencyFloorAgent, 'state' | 'break_reason' | 'call'>): FloorCardState {
  if (row.call) return 'on_call';
  if (isOnSoftphone({ state: row.state, break_reason: row.break_reason })) return 'softphone';
  switch (row.state) {
    case 'on_call':
    case 'reserved':
      return 'on_call';
    case 'available':
    case 'wrapup':
    case 'break':
      return row.state;
    default:
      return 'offline';
  }
}

/**
 * The floor row as the campaign floor's row, for its rules. A row with no open session has no
 * session id: it is given one no real session has, and no control acts on it (it is `offline`).
 */
export function supervisorAgentOf(row: AgencyFloorAgent): AgencySupervisorAgent {
  return {
    session_id: row.session_id ?? `no-session:${row.agent_user_id}`,
    agent_user_id: row.agent_user_id,
    agent_name: row.agent_name,
    state: row.state,
    // An unparseable anchor is "cannot say" to every rule (`timeInStateMs`), never "just now".
    state_since: row.state_since ?? '',
    connected: row.connected,
    break_reason: row.break_reason,
    calls_handled: row.calls_today,
    client_kind: row.client_kind ?? 'web',
    on_inbound_call: row.on_inbound_call,
    inbound_outcome_owed: row.inbound_outcome_owed,
    can_take_inbound: null,
  };
}

/** One card: the row, what the campaign floor's rules say of it, and the card's own facts. */
export interface FloorCard {
  row: AgencyFloorAgent;
  agent: AgencySupervisorAgent;
  state: FloorCardState;
  risk: AgencyFloorRisk;
  displayName: string;
  /** Time in the current state, or `null` when there is nothing to count from. */
  elapsedMs: number | null;
}

/**
 * The card's clock: from the moment the customer was connected while on a call (the Live calls
 * list's time on call), else from the last state change; nothing for a row with no open session.
 */
export function floorTimerAnchor(row: AgencyFloorAgent): string | null {
  if (row.session_id === null) return null;
  if (floorCardState(row) === 'on_call' && row.call) return row.call.connected_at;
  return row.state_since;
}

/**
 * One row's card at `now`, the SERVER's now: the viewer's clock plus the floor read's offset
 * (`useAgentFloor().clockOffsetMs`, the server's clock minus the viewer's). Every anchor on a floor
 * row is the server's, so the cards' clocks, the wrap-up and break thresholds and the break rows are
 * measured against it, as the Live calls list corrects its time on call; a viewer whose clock runs
 * fast would otherwise see every agent minutes further on.
 */
export function floorCard(row: AgencyFloorAgent, now: number): FloorCard {
  const agent = supervisorAgentOf(row);
  return {
    row,
    agent,
    state: floorCardState(row),
    risk: floorRisk(agent, now, { wrapupSeconds: row.wrapup_window_seconds, ahtSeconds: row.call?.aht_seconds ?? null }),
    displayName: agentDisplayName(row),
    elapsedMs: elapsedSince(floorTimerAnchor(row), 0, now),
  };
}

const STATE_ORDER: Record<FloorCardState, number> = Object.fromEntries(
  FLOOR_CARD_STATES.map((state, i) => [state, i]),
) as Record<FloorCardState, number>;

/**
 * The cards in the order a supervisor reads them: the campaign floor's risk order first
 * (`AGENCY_FLOOR_RISK_ORDER`), longest in its state first within a warning, then the chips' order
 * of states (on a call, ready, choosing outcome, break, offline), then by name and user id, so a
 * poll never reshuffles two cards that compare equal. The input is never mutated.
 */
export function rankFloorCards(rows: readonly AgencyFloorAgent[], now: number): FloorCard[] {
  return rows
    .map((row) => floorCard(row, now))
    .sort((a, b) => {
      const rank = AGENCY_FLOOR_RISK_RANK[a.risk] - AGENCY_FLOOR_RISK_RANK[b.risk];
      if (rank !== 0) return rank;
      if (a.risk !== 'none') {
        const delta = (b.elapsedMs ?? -1) - (a.elapsedMs ?? -1);
        if (delta !== 0) return delta;
      }
      return STATE_ORDER[a.state] - STATE_ORDER[b.state]
        || a.displayName.localeCompare(b.displayName)
        || a.row.agent_user_id.localeCompare(b.row.agent_user_id);
    });
}

/**
 * The rows the page shows: one campaign's, or all (the same list, never copied). A soft-phone
 * session and a staffed agent with no open session name no campaign, so a campaign filter leaves
 * them out (the floor read does not say which campaigns an absent agent is staffed on).
 */
export function floorRowsFor(rows: readonly AgencyFloorAgent[], campaignId: string | null): readonly AgencyFloorAgent[] {
  return campaignId === null ? rows : rows.filter((row) => row.campaign_id === campaignId);
}

/** The ranked cards the page shows: {@link floorRowsFor}'s rule over cards, keeping their order. */
export function cardsFor(cards: readonly FloorCard[], campaignId: string | null): readonly FloorCard[] {
  return campaignId === null ? cards : cards.filter((card) => card.row.campaign_id === campaignId);
}

/** Every field the same (`Object.is`): one level, no further. */
function sameFields(a: object, b: object): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/**
 * Whether two reads of an agent's row say the same: every field the same, and the call in progress
 * the same field by field (the one object on a row). The floor read answers new objects on every
 * poll, so the grid keeps the last row while this holds and a card that shows nothing new skips its
 * render. A field added later that holds an object compares by reference: a needless render, never
 * a stale card.
 */
export function sameFloorRow(a: AgencyFloorAgent, b: AgencyFloorAgent): boolean {
  if (a === b) return true;
  const keys = Object.keys(a) as (keyof AgencyFloorAgent)[];
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    const x = a[key];
    const y = b[key];
    if (Object.is(x, y)) continue;
    if (key === 'call' && a.call && b.call && sameFields(a.call, b.call)) continue;
    return false;
  }
  return true;
}

/** How many rows in each state, and in all. */
export function floorStateCounts(rows: readonly AgencyFloorAgent[]): { total: number; counts: Record<FloorCardState, number> } {
  const counts: Record<FloorCardState, number> = { on_call: 0, available: 0, wrapup: 0, softphone: 0, break: 0, offline: 0 };
  for (const row of rows) counts[floorCardState(row)] += 1;
  return { total: rows.length, counts };
}

/** The grid's chip filter: every card, or one state's. */
export type FloorChipFilter = 'all' | FloorCardState;

export function cardsInState(cards: readonly FloorCard[], filter: FloorChipFilter): readonly FloorCard[] {
  return filter === 'all' ? cards : cards.filter((card) => card.state === filter);
}

/** "Mobile app" and the rest: the badges the campaign floor shows beside a state. */
interface FloorBadges {
  mobile: boolean;
  inbound: boolean;
  softphone: boolean;
  /** `connected === false` only: `null` is a read that failed, not a lost connection. */
  connectionLost: boolean;
}

export function floorBadges(row: AgencyFloorAgent): FloorBadges {
  return {
    mobile: row.client_kind === 'mobile',
    inbound: row.on_inbound_call,
    // On a soft-phone call: its tag says On a call, so the badge says how. With no call the tag says it.
    softphone: Boolean(row.call) && isOnSoftphone({ state: row.state, break_reason: row.break_reason }),
    connectionLost: row.session_id !== null && row.connected === false,
  };
}

/**
 * The card's one line under the name: the customer's name on a call (never a number, LF3), what a
 * ready agent is doing, the outcome being chosen, the break's name, or when an absent agent left.
 */
export function floorNowLine(row: AgencyFloorAgent, formatTime: (iso: string) => string): string {
  const state = floorCardState(row);
  if (state === 'on_call') {
    if (row.call) return customerLabel({ customer_name: row.call.customer_name, origin: row.call.origin });
    return row.on_inbound_call ? 'Inbound call ringing' : 'Connecting a call';
  }
  if (state === 'available') return 'Waiting for a call';
  if (state === 'wrapup') return owesInboundOutcome(row) ? 'After an inbound call' : 'After the call';
  if (state === 'softphone') return 'Taking calls by hand';
  if (state === 'break') return row.break_label ?? 'On a break';
  if (row.session_id === null) return row.left_at ? `Left at ${formatTime(row.left_at)}` : 'Not signed in today';
  return 'Offline';
}

/**
 * The card's count: conversations since the viewer's midnight on the dialler (the grouped stats'
 * `connected` for this agent; soft-phone and inbound calls are not counted, the server's rule), so
 * "conversations", never "calls", which the Calls today tile counts as dials.
 */
export function callsTodayText(count: number): string {
  return `${plural(count, 'conversation')} today`;
}

/** What {@link callsTodayText} counts, for its tooltip and the drawer. */
export const CONVERSATIONS_TODAY_NOTE = 'Dialler conversations since midnight. Soft-phone and inbound calls are not counted.';

/** A card's call: what a listen reads (`ListenCall`), and whether it can be listened to and why not. */
export type FloorLiveCall = ListenCall & Pick<AgencyLiveCall, 'listenable' | 'not_listenable_reason'>;

/**
 * The call a card's Listen starts on, as the Live calls list starts one, from what the floor
 * carries and nothing made up: no number (LF3; the listening bar names the customer), no inbound
 * route and no listener list (so a full call says "This call has reached its listening limit",
 * never a made-up "0 supervisors are already listening"). None without an open session's call.
 */
export function liveCallOf(row: AgencyFloorAgent): FloorLiveCall | null {
  const { call } = row;
  if (!call || row.session_id === null || row.client_kind === null) return null;
  return {
    call_id: call.call_id,
    origin: call.origin,
    correlation_id: call.correlation_id,
    campaign_id: row.campaign_id,
    campaign_name: row.campaign_name,
    agent_user_id: row.agent_user_id,
    agent_name: row.agent_name,
    customer_name: call.customer_name,
    connected_at: call.connected_at,
    listenable: call.listenable,
    not_listenable_reason: call.not_listenable_reason,
  };
}

/**
 * Make available, offered on a card only once the agent is stuck: a wrap-up past its window and the
 * grace (the campaign floor's `wrapup_overrun`, an inbound wrap-up included), or an inbound outcome
 * still owed by an agent who is no longer in wrap-up (a restart rehydrates them onto a break, where
 * nothing else will close it). An ordinary inbound wrap-up owes its outcome from the moment the call
 * ends, so owing one alone is not stuck: offering the return then would close an outcome the agent
 * is writing. The drawer's own rule (`canForceAvailable`) is wider on purpose: it is reached on
 * purpose, from one agent; a red button on every card is not.
 */
export function offersMakeAvailable(card: Pick<FloorCard, 'row' | 'risk'>): boolean {
  if (card.row.session_id === null) return false;
  if (card.risk === 'wrapup_overrun') return true;
  return owesInboundOutcome(card.row) && card.row.state !== 'wrapup';
}

/** A card's stripe: a warning's colour when it carries one, else its state's. */
export function stripeTone(card: Pick<FloorCard, 'risk' | 'state'>): FloorCardState | 'risk' | 'lost' {
  if (card.risk === 'disconnected') return 'lost';
  if (isWarningRisk(card.risk)) return 'risk';
  return card.state;
}

// ── Needs you now: breaks over the limit ────────────────────────────────────

/** A "Got it" on a long break holds for this many more minutes of the break before the row comes back. */
export const BREAK_OVERRUN_STEP_MINUTES = 15;

/**
 * One row per agent on a break past the floor's one limit (`LONG_BREAK_SECONDS`, 30 minutes; the
 * campaign floor's `long_break` risk, so never the soft phone): "Priya M on Tea for 42 min", a
 * warning ranked `break-overrun` (LF9, `homeRank` reads it from the kind), with a coming-soon Send
 * reminder.
 *
 * - **Got it**: the row's kind carries the break's start, so a new break is a new row; its count is
 *   the seconds the break has run and its `worseBy` {@link BREAK_OVERRUN_STEP_MINUTES} minutes of
 *   them, so a put-aside row comes back once the break has run a quarter of an hour longer than
 *   when it was put aside (to the floor's 5 s risk clock), whenever in the break that was.
 * - **Measured on the cards' clock**: the page ranks the floor once on its 5 s risk clock and hands
 *   the same cards to the grid and here, so a card's `long_break` and its row cross the limit
 *   together, and the minutes keep counting between floor reads and while they fail (then the rows
 *   are `stale`); the kind and id never move with them.
 * - **Not on the sidebar badge**: the badge counts only the shared board's rows (`homeAttention`),
 *   at a minute on every page, and the floor is read on Live floor alone (5 s, one row per agent).
 *   A badge that counted these only while Live floor is open would change its number by page. The
 *   page's own "Needs you now" count does include them.
 */
export function breakOverrunItems(
  cards: readonly FloorCard[],
  campaigns: readonly HomeCampaignRef[],
  /** The floor read is the last good one's (`useAgentFloor().stale`): its rows say so. */
  stale = false,
): HomeAttentionItem[] {
  return cards.flatMap((card) => {
    if (card.risk !== 'long_break' || card.elapsedMs === null) return [];
    const { row } = card;
    const minutes = Math.floor(card.elapsedMs / 60_000);
    const campaign = row.campaign_id
      ? { id: row.campaign_id, name: campaigns.find((c) => c.id === row.campaign_id)?.name ?? row.campaign_name ?? 'Campaign' }
      : null;
    return [{
      id: `break-overrun:${row.agent_user_id}`,
      tone: 'warning' as const,
      campaign,
      title: `${card.displayName} on ${row.break_label ?? 'a break'} for ${formatCount(minutes)} min`,
      detail: 'Any break over 30 minutes is flagged. Limits per break reason are coming soon.',
      at: null,
      action: 'Open the floor',
      to: campaign ? campaignTabHref('agents', campaign.id) : '/agency/campaigns',
      stale,
      kind: `break-overrun@${row.state_since ?? ''}`,
      count: Math.floor(card.elapsedMs / 1000),
      worseBy: BREAK_OVERRUN_STEP_MINUTES * 60,
      ackable: true,
      comingSoon: { label: 'Send reminder', tooltip: `Remind ${card.displayName} that their break is over.` },
    }];
  });
}

// ── The tiles ───────────────────────────────────────────────────────────────

/**
 * Agents working from the floor read: everyone on shift, of everyone assigned, each person once
 * (the server's `totals`). With a campaign picked: its rows (`shown`, {@link floorRowsFor}) on shift
 * (`agentsOnShift`), of the agents staffed on it (the board's `staffing.staffed`, one campaign so
 * nobody counted twice).
 */
export function floorAgentsWorking(
  floor: AgencyFloorResponse,
  shown: readonly AgencyFloorAgent[],
  campaignId: string | null,
  reads: readonly HomeCampaignRead[],
): AgentsWorking {
  if (campaignId === null) return { working: floor.totals.on_shift, assigned: floor.totals.assigned };
  const working = agentsOnShift(shown) ?? 0;
  const staffed = reads.find((r) => r.campaign.id === campaignId)?.staffing?.staffed ?? null;
  return { working, assigned: staffed === null ? null : Math.max(staffed, working) };
}

/** The Will pay tile's figures, or null when the shown campaigns record no promises (Successes then). */
export interface WillPay {
  promises: number;
  /** The exact total, a decimal string. */
  amount: string;
  withAmount: number;
}

/**
 * Will pay over the shown campaigns: only when one of them records promises (its outcome catalog has
 * a promise outcome, `promise_campaign_ids`); otherwise null and the tile stays Successes. Across
 * every campaign it sums every row, the calls with no campaign included; with one picked, its row.
 */
export function willPayFor(summary: AgencyPromisesSummaryResponse, campaignId: string | null): WillPay | null {
  const recording = campaignId === null ? summary.promise_campaign_ids : summary.promise_campaign_ids.filter((id) => id === campaignId);
  if (recording.length === 0) return null;
  const rows = campaignId === null ? summary.campaigns : summary.campaigns.filter((row) => row.campaign_id === campaignId);
  return {
    promises: rows.reduce((n, row) => n + row.promises, 0),
    withAmount: rows.reduce((n, row) => n + row.with_amount, 0),
    amount: sumPromiseAmounts(rows.map((row) => row.amount_total)),
  };
}

/** The Will pay tile's line: "2.4 lakh promised today", with no currency (LF2), or why there is none. */
export function willPayLine(figure: WillPay): string {
  if (figure.withAmount === 0) return 'No amounts recorded';
  return `${formatAmountShort(figure.amount)} promised today`;
}

/** Each promise-recording campaign's count, for its card's "N will pay". */
export function willPayByCampaign(summary: AgencyPromisesSummaryResponse): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of summary.promise_campaign_ids) {
    out[id] = summary.campaigns.find((row) => row.campaign_id === id)?.promises ?? 0;
  }
  return out;
}

import type { AgencyFloorAgent, AgencyFloorResponse } from '@magick-agency/contracts/api/agency/floor';
import type { AgencyPromisesSummaryResponse } from '@magick-agency/contracts/api/agency/promises';
import type { AgencyLiveCall } from '@magick-agency/contracts/api/agency/live-calls';
import type { AgencySupervisorAgent } from '../../types/agency-campaign';
import {
  AGENCY_FLOOR_RISK_RANK,
  LONG_BREAK_SECONDS,
  agentDisplayName,
  floorRisk,
  isOnSoftphone,
  isWarningRisk,
  owesInboundOutcome,
  type AgencyFloorRisk,
} from '../agencyAgentFloor';
import { campaignTabHref } from '../agencyCampaignTabs';
import { customerLabel } from '../listen/listenCopy';
import { formatAmountShort, sumPromiseAmounts } from '../format/promise';
import { formatCount } from '../format/number';
import type { HomeAttentionItem, HomeCampaignRead, HomeCampaignRef } from './home';
import { CHOOSING_OUTCOME_LABEL, type AgentsWorking } from './liveFloor';

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

/** The chips' and cards' states, in the chips' order: a call being connected counts as on a call. */
export const FLOOR_CARD_STATES = ['on_call', 'available', 'wrapup', 'break', 'offline'] as const;
export type FloorCardState = (typeof FLOOR_CARD_STATES)[number];

/** A card's state tag, and its chip's word. */
export const FLOOR_CARD_LABELS: Record<FloorCardState, string> = {
  on_call: 'On a call',
  available: 'Ready',
  wrapup: CHOOSING_OUTCOME_LABEL,
  break: 'Break',
  offline: 'Offline',
};

export function floorCardState(row: Pick<AgencyFloorAgent, 'state'>): FloorCardState {
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

function elapsedFrom(anchor: string | null, now: number): number | null {
  if (!anchor) return null;
  const at = Date.parse(anchor);
  return Number.isFinite(at) ? Math.max(0, now - at) : null;
}

/** One row's card at `now`. */
export function floorCard(row: AgencyFloorAgent, now: number): FloorCard {
  const agent = supervisorAgentOf(row);
  return {
    row,
    agent,
    state: floorCardState(row),
    risk: floorRisk(agent, now, { wrapupSeconds: row.wrapup_window_seconds, ahtSeconds: row.call?.aht_seconds ?? null }),
    displayName: agentDisplayName(row),
    elapsedMs: elapsedFrom(floorTimerAnchor(row), now),
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
 * The rows the page shows: one campaign's, or all. A soft-phone session and a staffed agent with no
 * open session name no campaign, so a campaign filter leaves them out (the floor read does not say
 * which campaigns an absent agent is staffed on).
 */
export function floorRowsFor(rows: readonly AgencyFloorAgent[], campaignId: string | null): AgencyFloorAgent[] {
  return campaignId === null ? [...rows] : rows.filter((row) => row.campaign_id === campaignId);
}

/** How many rows in each state, and in all. */
export function floorStateCounts(rows: readonly AgencyFloorAgent[]): { total: number; counts: Record<FloorCardState, number> } {
  const counts: Record<FloorCardState, number> = { on_call: 0, available: 0, wrapup: 0, break: 0, offline: 0 };
  for (const row of rows) counts[floorCardState(row)] += 1;
  return { total: rows.length, counts };
}

/** The grid's chip filter: every card, or one state's. */
export type FloorChipFilter = 'all' | FloorCardState;

export function cardsFor(cards: readonly FloorCard[], filter: FloorChipFilter): FloorCard[] {
  return filter === 'all' ? [...cards] : cards.filter((card) => card.state === filter);
}

/** "Mobile app" and the rest: the badges the campaign floor shows beside a state. */
export interface FloorBadges {
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
    softphone: isOnSoftphone({ state: row.state, break_reason: row.break_reason }),
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
  if (state === 'wrapup') return owesInboundOutcome(row) ? 'After an inbound call' : 'Saving the call’s outcome';
  if (state === 'break') {
    if (isOnSoftphone({ state: row.state, break_reason: row.break_reason })) return 'Taking calls by hand';
    return row.break_label ?? 'On a break';
  }
  if (row.session_id === null) return row.left_at ? `Left at ${formatTime(row.left_at)}` : 'Not signed in today';
  return 'Offline';
}

/** "1 call today", "42 calls today". */
export function callsTodayText(count: number): string {
  return count === 1 ? '1 call today' : `${formatCount(count)} calls today`;
}

/** The Live calls list's row for a floor row's call, so Listen starts exactly as it does there. */
export function liveCallOf(row: AgencyFloorAgent): AgencyLiveCall | null {
  const { call } = row;
  if (!call || row.session_id === null || row.client_kind === null) return null;
  return {
    call_id: call.call_id,
    origin: call.origin,
    correlation_id: call.correlation_id,
    campaign_id: row.campaign_id,
    campaign_name: row.campaign_name,
    inbound_route_name: null,
    agent_user_id: row.agent_user_id,
    agent_name: row.agent_name,
    agent_session_id: row.session_id,
    client_kind: row.client_kind,
    customer_name: call.customer_name,
    // The floor carries no number (LF3): the listening bar names the customer instead.
    customer_phone_masked: customerLabel({ customer_name: call.customer_name, origin: call.origin }),
    customer_phone_withheld: false,
    connected_at: call.connected_at,
    aht_seconds: call.aht_seconds,
    recording: false,
    listenable: call.listenable,
    not_listenable_reason: call.not_listenable_reason,
    listeners: [],
  };
}

/** Make available: the campaign floor's force-return rule, offered on a card only once it is stuck. */
export function offersMakeAvailable(card: FloorCard): boolean {
  if (card.row.session_id === null) return false;
  return card.risk === 'wrapup_overrun' || owesInboundOutcome(card.row);
}

/** A card's stripe: a warning's colour when it carries one, else its state's. */
export function stripeTone(card: FloorCard): FloorCardState | 'risk' | 'lost' {
  if (card.risk === 'disconnected') return 'lost';
  if (isWarningRisk(card.risk)) return 'risk';
  return card.state;
}

// ── Needs you now: breaks over the limit ────────────────────────────────────

/** A "Got it" on a long break holds for this many more minutes before the row comes back. */
export const BREAK_OVERRUN_STEP_MINUTES = 15;

/**
 * One row per agent on a break past the floor's one limit (`LONG_BREAK_SECONDS`, 30 minutes; the
 * campaign floor's `long_break` risk, so never the soft phone): "Priya M on Tea for 42 min", a
 * warning ranked `break-overrun` (LF9), with a coming-soon Send reminder.
 *
 * - **Got it**: the row's kind carries the break's start, so a new break is a new row; its count is
 *   how many {@link BREAK_OVERRUN_STEP_MINUTES} past the limit, so a put-aside row comes back each
 *   time the break runs a quarter of an hour longer.
 * - **Not on the sidebar badge** (`badge: false`): the badge reads only the shared board, at a
 *   minute on every page, and the floor is read on Live floor alone (5 s, one row per agent). A
 *   badge that counted these only while Live floor is open would change its number by page. The
 *   page's own "Needs you now" count does include them.
 */
export function breakOverrunItems(
  cards: readonly FloorCard[],
  campaigns: readonly HomeCampaignRef[],
): HomeAttentionItem[] {
  return cards.flatMap((card) => {
    if (card.risk !== 'long_break' || card.elapsedMs === null) return [];
    const { row } = card;
    const minutes = Math.floor(card.elapsedMs / 60_000);
    const steps = Math.floor((minutes - LONG_BREAK_SECONDS / 60) / BREAK_OVERRUN_STEP_MINUTES);
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
      badge: false,
      stale: false,
      kind: `break-overrun@${row.state_since ?? ''}`,
      count: Math.max(0, steps),
      ackable: true,
      rank: 'break-overrun' as const,
      comingSoon: { label: 'Send reminder', tooltip: `Remind ${card.displayName} that their break is over.` },
    }];
  });
}

// ── The tiles ───────────────────────────────────────────────────────────────

/**
 * Agents working from the floor read: everyone on shift, of everyone assigned, each person once
 * (the server's `totals`). With a campaign picked: that campaign's rows on shift, of the agents
 * staffed on it (the board's `staffing.staffed`, one campaign so nobody counted twice).
 */
export function floorAgentsWorking(
  floor: AgencyFloorResponse,
  campaignId: string | null,
  reads: readonly HomeCampaignRead[],
): AgentsWorking {
  if (campaignId === null) return { working: floor.totals.on_shift, assigned: floor.totals.assigned };
  const working = floor.agents.filter((row) => row.campaign_id === campaignId && row.state !== 'offline').length;
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

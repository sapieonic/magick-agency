import type {
  AgencyAgentLiveState,
  AgencySupervisorAgent,
} from '../types/agency-campaign';

/**
 * The agent floor (§C.4) — as pure functions, because the ordering IS the
 * feature and an ordering is a proposition, not a layout.
 *
 * ── Why risk, not the alphabet ──────────────────────────────────────────────
 * §C.4 exists so a supervisor can "spot trouble in seconds". A floor sorted by
 * name makes them read every tile to find the one that needs them, which is the
 * job the sort was supposed to do. So risk is the DEFAULT — "the default is what
 * gets used" — and the alphabet is the opt-in, for roll-call.
 *
 * ── Why the thresholds live here and not in JSX ─────────────────────────────
 * Every rank below is a claim about a named person ("Ravi has been in wrap-up
 * too long"), made to someone who is about to act on it. Each one is derived
 * from a timestamp and a campaign setting, and each derivation is a place to be
 * confidently wrong. They are tested rather than eyeballed.
 */

/**
 * How often the tiles repaint their time-in-state.
 *
 * One second, not `agencyClock`'s 250ms. That constant exists because a
 * *countdown*'s visible digit can lag the true boundary by nearly a full second
 * and the agent console's tolerance is one second total. Here the number counts
 * UP against thresholds measured in minutes, nobody is being held to it, and a
 * quarter-second repaint of a whole grid buys nothing.
 */
export const AGENCY_FLOOR_TICK_MS = 1_000;

/**
 * Grace beyond the campaign's configured wrap-up window before rank 1 fires.
 *
 * A wrap-up that has merely reached its deadline is not stuck: the window can
 * be held open legitimately (`wrapup_auto_return: false` waits on the agent,
 * and a required disposition holds it at `0:00` by design). Sixty seconds is
 * the margin that separates "still typing" from "walked away".
 */
export const WRAPUP_OVERRUN_GRACE_SECONDS = 60;

/** Rank 2's multiplier on average handle time. A call at 2× AHT is an outlier. */
export const CALL_OVERRUN_AHT_MULTIPLE = 2;

/** Rank 3. Half an hour is longer than any break the console offers. */
export const LONG_BREAK_SECONDS = 30 * 60;

/**
 * §C.4's risk ranking, worst first. **The order is load-bearing** and is pinned
 * literally in the tests rather than derived, because a reorder is a decision
 * someone made and should break a test rather than quietly change which agent a
 * supervisor looks at first.
 *
 * Ranked by *what a supervisor should do about it*, not by severity — the same
 * principle as the health strip's `AGENCY_STALL_PRIORITY`:
 *
 * 1. `wrapup_overrun`  — an agent held out of the pool by a write-up nobody is
 *                        doing. Costs the campaign an agent AND leaves an
 *                        attempt undispositioned. This is the one the
 *                        force-return control exists for.
 * 2. `call_overrun`    — a conversation running far past normal. Might need a
 *                        supervisor; might be a stuck leg.
 * 3. `long_break`      — a break that has outlasted any break.
 * 4. `disconnected`    — the station socket is gone. Last, among the warnings,
 *                        because it is the one where the agent may already know
 *                        and be reconnecting.
 * 5. `none`            — everyone else, by name.
 */
export const AGENCY_FLOOR_RISK_ORDER = [
  'wrapup_overrun',
  'call_overrun',
  'long_break',
  'disconnected',
  'none',
] as const;

export type AgencyFloorRisk = (typeof AGENCY_FLOOR_RISK_ORDER)[number];

/** Rank index, 0 = worst. `none` is last and is the only non-warning rank. */
export const AGENCY_FLOOR_RISK_RANK: Record<AgencyFloorRisk, number> = Object.fromEntries(
  AGENCY_FLOOR_RISK_ORDER.map((risk, index) => [risk, index]),
) as Record<AgencyFloorRisk, number>;

/** Ranks 1–4 carry a warning glyph; `none` does not. */
export function isWarningRisk(risk: AgencyFloorRisk): boolean {
  return risk !== 'none';
}

/** The campaign/stats inputs the thresholds are measured against. */
export interface FloorThresholds {
  /**
   * The campaign's configured wrap-up window, in seconds.
   *
   * `null`/`undefined` means the campaign has no window, so **rank 1 cannot
   * fire**: there is no deadline for a wrap-up to have overrun. A wrap-up on
   * such a campaign ends when the agent ends it.
   */
  wrapupSeconds?: number | null;
  /**
   * Average handle time in seconds, from the stats payload.
   *
   * ── What rank 2 does when this is `null` ──────────────────────────────────
   * **It does not fire.** There is no threshold to compare against, and the
   * alternatives are both worse. Inventing a default (say, 300s) would
   * manufacture a warning about a real person from a number nobody measured —
   * and it would do it precisely on a new campaign, where `aht_seconds` is null
   * because too few calls have completed, which is also when every call looks
   * long relative to a guess. Falling back to a *longer* arbitrary number just
   * moves the lie.
   *
   * Not flagging is the safe answer: the tile still shows the state and a live
   * ticking duration, so a supervisor scanning the floor can still see a call at
   * 40 minutes. What they don't get is the console asserting it is abnormal
   * when the console has no idea what normal is here.
   */
  ahtSeconds?: number | null;
}

/**
 * Milliseconds this agent has been in their current state, or `null` when
 * `state_since` will not parse.
 *
 * `null` rather than `0`: a zero would render as "just now" and satisfy every
 * threshold as "fine", so an unparseable timestamp would silently clear a
 * warning. Every consumer below treats `null` as "cannot say".
 */
export function timeInStateMs(agent: AgencySupervisorAgent, now: number): number | null {
  const since = Date.parse(agent.state_since);
  if (!Number.isFinite(since)) return null;
  // Floored: a client clock a second ahead of the server would otherwise render
  // a negative duration for the first moments of every new state.
  return Math.max(0, now - since);
}

/** The analytics bucketing for `seconds_in_state` (never a raw duration — see events.ts). */
export type AgencyFloorStateBucket = 'under_60' | '1_5m' | '5_15m' | 'over_15m';

/**
 * Buckets an agent's time-in-state for `trackAgencyFloorIntervention`.
 *
 * `elapsedMs === null` — `state_since` would not parse — falls back to
 * `'under_60'` rather than adding a fifth "unknown" bucket the event's typed
 * shape does not carry; the tile itself renders a dash for the same case.
 */
export function secondsInStateBucket(elapsedMs: number | null): AgencyFloorStateBucket {
  if (elapsedMs === null) return 'under_60';
  const seconds = elapsedMs / 1000;
  if (seconds < 60) return 'under_60';
  if (seconds < 5 * 60) return '1_5m';
  if (seconds < 15 * 60) return '5_15m';
  return 'over_15m';
}

/**
 * The single highest risk this agent presents, or `'none'`.
 *
 * First match wins, in `AGENCY_FLOOR_RISK_ORDER`. One risk per tile, for the
 * same reason the health strip shows one diagnosis: a tile carrying three
 * warnings is a tile a supervisor does not act on.
 */
export function floorRisk(
  agent: AgencySupervisorAgent,
  now: number,
  thresholds: FloorThresholds,
): AgencyFloorRisk {
  const elapsedMs = timeInStateMs(agent, now);

  // 1. Stuck in wrap-up beyond the window plus its grace.
  if (agent.state === 'wrapup' && elapsedMs !== null) {
    const window = thresholds.wrapupSeconds;
    if (typeof window === 'number' && window >= 0) {
      if (elapsedMs > (window + WRAPUP_OVERRUN_GRACE_SECONDS) * 1000) return 'wrapup_overrun';
    }
  }

  // 2. On a call beyond 2× AHT. Silent when AHT is unknown — see `ahtSeconds`.
  if (agent.state === 'on_call' && elapsedMs !== null) {
    const aht = thresholds.ahtSeconds;
    if (typeof aht === 'number' && aht > 0) {
      if (elapsedMs > aht * CALL_OVERRUN_AHT_MULTIPLE * 1000) return 'call_overrun';
    }
  }

  // 3. On break beyond half an hour.
  if (agent.state === 'break' && elapsedMs !== null) {
    if (elapsedMs > LONG_BREAK_SECONDS * 1000) return 'long_break';
  }

  /*
   * 4. Heartbeat lost.
   *
   * `=== false`, and it must stay `=== false`. `connected` is `null` when core's
   * Redis read faulted, and `!agent.connected` — the natural thing to type —
   * would turn that fault into a floor full of agents reported as dropped, on
   * the exact screen a supervisor uses to decide who to chase. A degraded read
   * is not evidence of a disconnection. Same rule as `concurrency_in_use`.
   */
  if (agent.connected === false) return 'disconnected';

  return 'none';
}

/**
 * What the warning glyph means, in one clause. `null` for `none`.
 *
 * Phrased as an observation rather than an instruction: the console can see that
 * a wrap-up has overrun, but it cannot know whether the right response is a tap
 * on the shoulder or a force-return.
 */
export const AGENCY_FLOOR_RISK_NOTE: Record<AgencyFloorRisk, string | null> = {
  wrapup_overrun: 'Wrap-up has run past this campaign’s window.',
  call_overrun: 'On a call far longer than this campaign’s average.',
  long_break: 'On break for more than 30 minutes.',
  disconnected: 'Station disconnected — no heartbeat.',
  none: null,
};

/**
 * The same risk as a *column-width* label — what the row's Actions cell shows.
 *
 * Two labels for one fact, deliberately. {@link AGENCY_FLOOR_RISK_NOTE} is the
 * sentence, and it stays: it is the cell's `title` and the drawer's wording, so
 * the short form is never the only carrier of what is wrong. What the table
 * needs beside it is something that fits a 200px column and is legible at a
 * glance down a floor of thirty — "2× AHT" is read as a scan, the sentence is
 * read once the supervisor has stopped on that row.
 */
export const AGENCY_FLOOR_RISK_FLAG: Record<AgencyFloorRisk, string | null> = {
  wrapup_overrun: 'Past wrap-up',
  call_overrun: '2× AHT',
  long_break: 'Long break',
  disconnected: 'Disconnected',
  none: null,
};

/**
 * The same risk again, as a clause that completes "N agents need a look — …".
 *
 * Written to read as a list item rather than a sentence, because the summary
 * joins several of them. Kept beside the other two labels so a change to what a
 * rank *means* is made in one place.
 */
export const AGENCY_FLOOR_RISK_CLAUSE: Record<AgencyFloorRisk, string | null> = {
  wrapup_overrun: 'past the wrap-up window',
  call_overrun: 'on a call past twice the handle-time average',
  long_break: 'on a break longer than 30 minutes',
  disconnected: 'with no station heartbeat',
  none: null,
};

/**
 * The floor's warnings as one sentence — the summary card's pill.
 *
 * `null` when nobody is flagged, which is the case that must render nothing at
 * all: a pill reading "0 agents need a look" is a warning-coloured box that says
 * there is no warning, and a supervisor learns to skip the box rather than read
 * it.
 *
 * Counted from the RANKED floor rather than re-derived, so the pill and the rows
 * can never disagree about who is flagged — one agent carries exactly one risk
 * (`floorRisk` is first-match-wins), so the clause counts sum to the head count.
 */
export function floorRiskSummary(ranked: readonly RankedFloorAgent[]): string | null {
  const flagged = ranked.filter((entry) => isWarningRisk(entry.risk));
  if (flagged.length === 0) return null;

  const head = flagged.length === 1 ? '1 agent needs a look' : `${flagged.length.toLocaleString()} agents need a look`;

  // One flagged agent gets the bare clause: "1 agent needs a look — 1 past the
  // wrap-up window" says the same number twice.
  const only = flagged[0];
  if (flagged.length === 1 && only) return `${head} — ${AGENCY_FLOOR_RISK_CLAUSE[only.risk]}.`;

  const clauses = AGENCY_FLOOR_RISK_ORDER.flatMap((risk) => {
    if (risk === 'none') return [];
    const count = flagged.filter((entry) => entry.risk === risk).length;
    if (count === 0) return [];
    return [`${count.toLocaleString()} ${AGENCY_FLOOR_RISK_CLAUSE[risk]}`];
  });
  return `${head} — ${clauses.join(', ')}.`;
}

/** Plain-language state names. The wire enum never reaches a supervisor. */
export const AGENCY_FLOOR_STATE_LABELS: Record<AgencyAgentLiveState, string> = {
  offline: 'Offline',
  available: 'Available',
  reserved: 'Reserved',
  on_call: 'On a call',
  wrapup: 'Wrapping up',
  break: 'On break',
};

/**
 * The order the state summary reads in — busiest first, `offline` last.
 *
 * Not the wire enum's order and not alphabetical: a supervisor glancing at the
 * line wants "who is working" before "who is not", and `offline` on a live
 * floor is usually a stale row rather than news.
 */
const STATE_SUMMARY_ORDER: readonly AgencyAgentLiveState[] = [
  'on_call',
  'wrapup',
  'reserved',
  'available',
  'break',
  'offline',
] as const;

/**
 * The states that count as being ON SHIFT — every one but `offline`.
 *
 * ── The same rule the Overview rail applies, for the same reason ───────────
 * `agencyCampaignOverview`'s `FLOOR_BAR_ORDER` excludes `offline` because an
 * agent who signed out is not on shift — core's own `shift_seconds` excludes it
 * (`foldOccupancy`), so including it here diluted every share by signed-out
 * time. This tab was doing the opposite: `offline` landed in the stacked bar and
 * in the total every other state's share was taken of, so a supervisor could
 * read "3 of 9 free" on Overview, open Agents, and find a different denominator
 * and an Offline band the rail never drew.
 *
 * A signed-out agent is still a ROW in the table below — this governs the bar
 * and the readouts, which are about the floor as it stands.
 */
const ON_SHIFT_STATES: readonly AgencyAgentLiveState[] = STATE_SUMMARY_ORDER.filter(
  (state) => state !== 'offline',
);

/**
 * `agents_by_state` as one readable line — "3 on a call · 2 available".
 *
 * ── Why zeroes are dropped ──────────────────────────────────────────────────
 * Core seeds **every** state with a zero, so a faithful rendering is six
 * entries of which four are usually `0`. The two that matter then have to be
 * found rather than read. Dropping the zeroes is safe here in a way it is not
 * elsewhere on this screen: this is a total record, so an absent state is
 * provably "nobody in it" rather than "not measured".
 *
 * Returns `null` when the payload carried no counts at all — which is the case
 * that must not render as an empty floor. See the `undefined` branch in
 * `AgentFloor`, where this line is the only thing left standing.
 */
export function stateSummary(
  byState: Partial<Record<AgencyAgentLiveState, number>> | undefined,
): string | null {
  if (!byState) return null;
  const parts = STATE_SUMMARY_ORDER.flatMap((state) => {
    const count = byState[state];
    if (typeof count !== 'number' || count <= 0) return [];
    return [`${count.toLocaleString()} ${AGENCY_FLOOR_STATE_LABELS[state].toLowerCase()}`];
  });
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** One band of the summary card's stacked bar, and one row of its legend. */
export interface FloorStateSlice {
  state: AgencyAgentLiveState;
  label: string;
  count: number;
  /** Share of the floor as a percentage, 0–100. The bar's width. */
  pct: number;
}

/**
 * `agents_by_state` as the bands of the stacked bar, busiest first.
 *
 * Zeroes are dropped for the same reason {@link stateSummary} drops them, with
 * one extra: a zero-width band is a rounding accident away from a 1px sliver of
 * a colour nobody is in. They are not *forgotten* — {@link floorZeroStates}
 * gives them back as a single quiet line, so the legend still accounts for all
 * six states.
 *
 * Returns `[]` when the payload carried no counts at all, which is the case that
 * must not draw an empty bar: an absent roll-up is "we don't know", and a bar
 * with no bands in it reads as "nobody is here".
 */
export function floorStateSlices(
  byState: Partial<Record<AgencyAgentLiveState, number>> | undefined,
): FloorStateSlice[] {
  if (!byState) return [];
  // `ON_SHIFT_STATES`, not every state: see its note. `offline` in the bar puts
  // signed-out agents in the denominator every other band is a share of.
  const counted = ON_SHIFT_STATES.flatMap((state) => {
    const count = byState[state];
    if (typeof count !== 'number' || count <= 0) return [];
    return [{ state, count }];
  });
  const total = counted.reduce((sum, entry) => sum + entry.count, 0);
  if (total <= 0) return [];
  return counted.map(({ state, count }) => ({
    state,
    label: AGENCY_FLOOR_STATE_LABELS[state],
    count,
    pct: (count / total) * 100,
  }));
}

/**
 * The states nobody is in, as one trailing legend item — "Reserved 0 · Offline 0".
 *
 * Collapsed rather than given a swatch each, because a legend is read to find a
 * colour and four of these have no colour on screen to find. `null` when every
 * state is occupied, or when there is no roll-up to speak for.
 */
export function floorZeroStates(
  byState: Partial<Record<AgencyAgentLiveState, number>> | undefined,
): string | null {
  if (!byState) return null;
  const empty = STATE_SUMMARY_ORDER.filter((state) => byState[state] === 0);
  if (empty.length === 0) return null;
  return empty.map((state) => `${AGENCY_FLOOR_STATE_LABELS[state]} 0`).join(' · ');
}

/** The summary card's right-hand readouts, plus the scale the row bars share. */
export interface FloorTotals {
  /** Everyone at a station on this campaign — the readouts' denominator. */
  onShift: number;
  /** Free to take a call right now. */
  available: number;
  /** Calls handled this shift, across the floor. */
  handled: number;
  /** `handled / onShift`, or `null` on an empty floor rather than a NaN. */
  perAgent: number | null;
  /** The busiest agent's count — what each row's bar is drawn against. */
  busiest: number;
}

/**
 * The floor's own arithmetic, from the roster rather than the roll-up.
 *
 * `agents_by_state` would give the same `available` — core tallies it from this
 * very array — but `handled` and `busiest` are only in the rows, and taking two
 * of the four numbers from one source and two from another is how a card ends up
 * saying "3 of 9" above a table of eight.
 */
export function floorTotals(agents: readonly AgencySupervisorAgent[]): FloorTotals {
  /*
    Everyone but the signed-out — `agents.length` counted an `offline` row still
    sitting in the roster, so this readout and the Overview rail's "N on shift"
    disagreed about the same payload. See `ON_SHIFT_STATES`.

    `handled` and `busiest` deliberately still range over EVERY agent: calls a
    person took before they logged out are calls they took, and dropping them
    would make the floor's total shrink as people go home.
  */
  const onShift = agents.filter((agent) => agent.state !== 'offline').length;
  const available = agents.filter((agent) => agent.state === 'available').length;
  const handled = agents.reduce((sum, agent) => sum + (agent.calls_handled || 0), 0);
  const busiest = agents.reduce((max, agent) => Math.max(max, agent.calls_handled || 0), 0);
  return { onShift, available, handled, perAgent: onShift > 0 ? handled / onShift : null, busiest };
}

/**
 * The initials on a row's avatar.
 *
 * First letter of the first and last word — so "Priya Raghavan" is `PR` and a
 * single-word name is one letter rather than a repeated one. Codepoint-safe
 * (`Array.from`), because `"Émile"[0]` is fine but a name starting outside the
 * BMP would otherwise be sliced through the middle of a surrogate pair and
 * render as a replacement glyph.
 *
 * An unresolved agent's fallback ("Agent usr_abcd") produces `AU`, which is
 * meaningless — deliberately so. The avatar is a visual anchor for scanning a
 * column of rows, never an identity claim; the name beside it already says, in
 * words and in its own styling, that this is an id rather than a person.
 */
export function agentInitials(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  const first = words[0];
  if (!first) return '?';
  const last = words.length > 1 ? words[words.length - 1] : undefined;
  const letters = [Array.from(first)[0], last ? Array.from(last)[0] : undefined];
  return letters.filter(Boolean).join('').toUpperCase();
}

/**
 * How long the fallback identifier is when master could not resolve a name.
 *
 * Long enough to be unambiguous on a floor of a few dozen, short enough not to
 * dominate the tile.
 */
/**
 * The two fields the name fallback needs, and nothing else.
 *
 * ── Why this is structural rather than `AgencySupervisorAgent` ─────────────
 * Master enriches an agent id into a name on several payloads now — the live
 * floor, the attempts spine, and the roster read — and every one of them has the
 * same pair of fields for the same reason (core has no user table, design D3, so
 * the id is all it can serve). Typing the helper on the *floor's* row would force
 * a second copy of {@link agentDisplayName} for each new payload, and a second
 * copy is a second answer to "what do we call somebody master could not resolve".
 * That question has one right answer and it is below.
 */
export interface NamedAgent {
  agent_user_id: string;
  agent_name: string | null;
}

export const AGENT_ID_FALLBACK_LENGTH = 8;

/**
 * What the tile calls this person.
 *
 * **`agent_name: null` means master could not resolve them** — a deleted user,
 * or an id from outside this tenant. Master sends `null` rather than a
 * placeholder precisely so this decision is made here, and there are two
 * tempting wrong answers:
 *
 * - **Blank.** A nameless tile is a tile a supervisor cannot act on, and it
 *   looks like a rendering bug rather than a fact about the data.
 * - **"Unknown".** Indistinguishable from a real name in a list, un-searchable,
 *   and identical for every unresolved agent — so two of them collapse into
 *   what reads as one person listed twice.
 *
 * So: a shortened `agent_user_id`, marked as an id. It is ugly on purpose. It
 * is also the only string on hand that is *true* and *distinct per person*,
 * which is exactly what the supervisor needs to tell two tiles apart and to
 * quote to support.
 *
 * A whitespace-only or empty name is treated as unresolved too — master should
 * not send one, but rendering it would produce the blank tile above.
 */
export function agentDisplayName(agent: NamedAgent): string {
  const name = agent.agent_name?.trim();
  if (name) return name;
  return `Agent ${agent.agent_user_id.slice(0, AGENT_ID_FALLBACK_LENGTH)}`;
}

/** True when the tile is showing a fallback id rather than a resolved name. */
export function hasResolvedName(agent: NamedAgent): boolean {
  return Boolean(agent.agent_name?.trim());
}

/** How the floor is ordered. Risk is the default; the alphabet is opt-in. */
export type AgencyFloorSort = 'risk' | 'name';

export interface RankedFloorAgent {
  agent: AgencySupervisorAgent;
  risk: AgencyFloorRisk;
  /** What the tile calls them — also the alphabetical sort key. */
  displayName: string;
  /** Time in the current state, or `null` when `state_since` will not parse. */
  elapsedMs: number | null;
}

/**
 * Rank and order the floor.
 *
 * `risk`: rank ascending, then **longest-in-state first within a warning rank**
 * — of two overrunning wrap-ups the 12-minute one is the one to look at — then
 * by name, then by session id so the order is total and a poll cannot reshuffle
 * two tiles that compare equal. Rank 5 skips the duration tie-break entirely and
 * goes straight to the name, which is what §C.4 asks for.
 *
 * `name`: display name, then session id. Roll-call.
 *
 * The input array is never mutated — it comes straight off the poll response and
 * the page re-reads it.
 */
export function rankFloor(
  agents: readonly AgencySupervisorAgent[],
  now: number,
  thresholds: FloorThresholds,
  sort: AgencyFloorSort = 'risk',
): RankedFloorAgent[] {
  const ranked: RankedFloorAgent[] = agents.map((agent) => ({
    agent,
    risk: floorRisk(agent, now, thresholds),
    displayName: agentDisplayName(agent),
    elapsedMs: timeInStateMs(agent, now),
  }));

  const byName = (a: RankedFloorAgent, b: RankedFloorAgent) =>
    a.displayName.localeCompare(b.displayName) || a.agent.session_id.localeCompare(b.agent.session_id);

  if (sort === 'name') return ranked.sort(byName);

  return ranked.sort((a, b) => {
    const rankDelta = AGENCY_FLOOR_RISK_RANK[a.risk] - AGENCY_FLOOR_RISK_RANK[b.risk];
    if (rankDelta !== 0) return rankDelta;
    // Within a warning rank, worst-first means longest-in-state first. An
    // unparseable `state_since` sorts last of its rank rather than first: it is
    // "we can't say", and putting it at the head would push a real 12-minute
    // overrun below a tile carrying no duration at all.
    if (a.risk !== 'none') {
      const aMs = a.elapsedMs ?? -1;
      const bMs = b.elapsedMs ?? -1;
      if (aMs !== bMs) return bMs - aMs;
    }
    return byName(a, b);
  });
}

/**
 * Whether the force-return control is offered for this session.
 *
 * **`wrapup` only.** The route is the one thing that can end a held wrap-up, and
 * that is all it is for; offering it against an `available` or `on_call` session
 * would advertise an action core will refuse. Note this is deliberately NOT
 * gated on `wrapup_overrun` — a supervisor may know the agent has left for the
 * day thirty seconds in, and the console making them wait out a grace period it
 * invented would be the console overruling them.
 *
 * Permission is the caller's to check and is **not** folded in here: the UI gate
 * must be `hasPermission(role, 'agency.supervise')`, matching master's
 * `requirePermission('agency.supervise')` exactly, or the button 403s on click.
 */
export function canForceAvailable(agent: AgencySupervisorAgent): boolean {
  return agent.state === 'wrapup';
}

/** Free-text reason cap, mirroring master's `forceAvailableSchema`. */
export const FORCE_AVAILABLE_REASON_MAX = 1000;

/**
 * The destructive-confirm copy.
 *
 * It names the consequence **in the supervisor's terms**, which master's route
 * comment spells out: the attempt is left `no_disposition`, identical to what
 * the reaper's sweep would have written. A confirm that said only "return this
 * agent to the pool" would hide the part that matters — the call this agent was
 * writing up loses its outcome, permanently, and that outcome is what the
 * campaign's reporting is made of.
 */
export const FORCE_AVAILABLE_CONFIRM = {
  title: 'End this wrap-up and return the agent?',
  /**
   * `{name}` is substituted by `forceAvailableConfirmMessage` so the sentence
   * names the person rather than "this agent" — a supervisor clicking through a
   * grid of tiles should see which one they are about to act on.
   */
  message:
    '{name} goes straight back into the pool and can be sent a new call immediately. '
    + 'The call they were writing up is left with no disposition — the same outcome the '
    + 'system records when a wrap-up is abandoned — and that cannot be filled in afterwards.',
  /**
   * Deliberately NOT the same string as the drawer's trigger ("End wrap-up").
   * The page's own precedent is Stop → "Stop campaign": the confirm restates
   * the action in fuller terms, so a supervisor who has read past the trigger
   * is not asked to click the identical word twice and cannot mistake the
   * dialog for the button they just pressed.
   */
  confirmLabel: 'End wrap-up and return',
} as const;

export function forceAvailableConfirmMessage(displayName: string): string {
  return FORCE_AVAILABLE_CONFIRM.message.replace('{name}', displayName);
}

/**
 * The width of a row's handled-calls bar, as a percentage of the busiest agent.
 *
 * Here rather than in `AgentFloor`'s row for the reason every derivation on this
 * surface is: a clamped division inlined into JSX is a claim about a person's
 * shift that no test can reach. `0` for a floor where nobody has handled
 * anything is correct and is not a null — nobody's bar is longer than anybody
 * else's, so every bar is empty.
 *
 * Clamped because `busiest` is a maximum over the SAME array: a row can only
 * exceed it if a caller passes a mismatched pair, and a bar wider than its track
 * is a rendering artefact rather than a fact worth showing.
 */
export function handledShare(handled: number | undefined, busiest: number): number {
  if (!Number.isFinite(busiest) || busiest <= 0) return 0;
  const value = typeof handled === 'number' && Number.isFinite(handled) ? handled : 0;
  return Math.max(0, Math.min(100, (value / busiest) * 100));
}

/**
 * `12.4 per agent`, or `null` when there is no floor to average over.
 *
 * One decimal, and never `0.0 per agent` off an empty floor — that reads as a
 * measurement of a floor that is not there.
 */
export function perAgentLabel(perAgent: number | null): string | null {
  return perAgent === null ? null : `${perAgent.toFixed(1)} per agent`;
}

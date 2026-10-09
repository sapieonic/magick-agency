import { describe, it, expect } from 'vitest';
import { floorSummary } from '../../utils/agencyCampaignOverview';
import {
  AGENCY_FLOOR_RISK_CLAUSE,
  AGENCY_FLOOR_RISK_FLAG,
  AGENCY_FLOOR_RISK_NOTE,
  AGENCY_FLOOR_RISK_ORDER,
  AGENCY_FLOOR_STATE_LABELS,
  AGENT_ID_FALLBACK_LENGTH,
  CALL_OVERRUN_AHT_MULTIPLE,
  FORCE_AVAILABLE_CONFIRM,
  FORCE_AVAILABLE_REASON_MAX,
  LONG_BREAK_SECONDS,
  WRAPUP_OVERRUN_GRACE_SECONDS,
  agentDisplayName,
  agentInitials,
  canForceAvailable,
  floorRisk,
  floorRiskSummary,
  floorStateSlices,
  floorTotals,
  floorZeroStates,
  forceAvailableConfirmMessage,
  hasResolvedName,
  isWarningRisk,
  rankFloor,
  stateSummary,
  timeInStateMs,
  type AgencyFloorRisk,
} from '../../utils/agencyAgentFloor';
import type { AgencyAgentLiveState, AgencySupervisorAgent } from '../../types/agency-campaign';

/**
 * The agent floor's derivations.
 *
 * The ordering IS the feature — "spot trouble in seconds" is a claim about
 * which tile a supervisor's eye lands on first — so it is asserted at every
 * ADJACENT rank boundary rather than with one fixture that happens to span the
 * whole list. A sort test whose fixture skips a boundary proves nothing about
 * that boundary: two ranks could be swapped and it would stay green.
 *
 * The other cases here are the three "we don't know" values, each of which turns
 * into a confident, false statement about a named person if it is read as a
 * definite one.
 */

const NOW = Date.parse('2026-08-15T12:00:00.000Z');

/** Seconds ago, as an ISO instant. */
function ago(seconds: number): string {
  return new Date(NOW - seconds * 1000).toISOString();
}

function agent(over: Partial<AgencySupervisorAgent> = {}): AgencySupervisorAgent {
  return {
    session_id: 'sess-1',
    agent_user_id: 'user-00000001',
    agent_name: 'Ravi',
    state: 'available',
    state_since: ago(10),
    connected: true,
    break_reason: null,
    calls_handled: 3,
    ...over,
  };
}

/** The campaign this file measures against: a 30s wrap-up window, 120s AHT. */
const THRESHOLDS = { wrapupSeconds: 30, ahtSeconds: 120 };

describe('the risk ranking', () => {
  it('is exactly the documented order, worst first', () => {
    // Pinned literally rather than derived. The whole point of the constant is
    // that a reorder is a decision someone made — it must break a test, not
    // quietly change which agent a supervisor looks at first.
    expect([...AGENCY_FLOOR_RISK_ORDER]).toEqual([
      'wrapup_overrun',
      'call_overrun',
      'long_break',
      'disconnected',
      'none',
    ]);
  });

  it('marks ranks 1–4 as warnings and `none` as not', () => {
    for (const risk of AGENCY_FLOOR_RISK_ORDER) {
      expect(isWarningRisk(risk)).toBe(risk !== 'none');
    }
  });

  it('gives every warning rank a note and `none` none', () => {
    for (const risk of AGENCY_FLOOR_RISK_ORDER) {
      const note = AGENCY_FLOOR_RISK_NOTE[risk];
      if (risk === 'none') expect(note).toBeNull();
      else expect(note).toBeTruthy();
    }
  });

  it('labels every state, so a tile can never show a raw enum', () => {
    const states: AgencyAgentLiveState[] = [
      'offline', 'available', 'reserved', 'on_call', 'wrapup', 'break',
    ];
    for (const state of states) expect(AGENCY_FLOOR_STATE_LABELS[state]).toBeTruthy();
  });
});

describe('floorRisk — the thresholds', () => {
  it('rank 1: wrap-up past the window plus its grace', () => {
    const over = agent({ state: 'wrapup', state_since: ago(30 + WRAPUP_OVERRUN_GRACE_SECONDS + 1) });
    expect(floorRisk(over, NOW, THRESHOLDS)).toBe('wrapup_overrun');
  });

  it('rank 1 does NOT fire inside the grace — a held wrap-up is not a stuck one', () => {
    // At the deadline plus 59s. `wrapup_auto_return: false` and a required
    // disposition both hold the window open legitimately, so "reached 0:00" is
    // not "walked away".
    const held = agent({ state: 'wrapup', state_since: ago(30 + WRAPUP_OVERRUN_GRACE_SECONDS - 1) });
    expect(floorRisk(held, NOW, THRESHOLDS)).toBe('none');
  });

  it('rank 1 cannot fire when the campaign has no wrap-up window', () => {
    // No deadline means nothing to have overrun — the wrap-up ends when the
    // agent ends it.
    const long = agent({ state: 'wrapup', state_since: ago(3600) });
    expect(floorRisk(long, NOW, { wrapupSeconds: null, ahtSeconds: 120 })).toBe('none');
    expect(floorRisk(long, NOW, { ahtSeconds: 120 })).toBe('none');
  });

  it('rank 2: on a call beyond 2× AHT', () => {
    const over = agent({ state: 'on_call', state_since: ago(120 * CALL_OVERRUN_AHT_MULTIPLE + 1) });
    expect(floorRisk(over, NOW, THRESHOLDS)).toBe('call_overrun');
    const under = agent({ state: 'on_call', state_since: ago(120 * CALL_OVERRUN_AHT_MULTIPLE - 1) });
    expect(floorRisk(under, NOW, THRESHOLDS)).toBe('none');
  });

  it('rank 2 does NOT fire when `aht_seconds` is null — no threshold, no warning', () => {
    /*
     * The documented decision. There is nothing to compare against, and both
     * alternatives are worse: a made-up default would manufacture a warning
     * about a real person from a number nobody measured, and it would do it
     * exactly on a new campaign — where AHT is null because too few calls have
     * finished, which is also when every call looks long against a guess.
     *
     * A forty-minute call still shows its state and a live ticking duration.
     * What the console does not do is assert it is abnormal.
     */
    const veryLong = agent({ state: 'on_call', state_since: ago(2400) });
    expect(floorRisk(veryLong, NOW, { wrapupSeconds: 30, ahtSeconds: null })).toBe('none');
    expect(floorRisk(veryLong, NOW, { wrapupSeconds: 30 })).toBe('none');
    // Nor on a zero/negative AHT, which would make every call an overrun.
    expect(floorRisk(veryLong, NOW, { wrapupSeconds: 30, ahtSeconds: 0 })).toBe('none');
  });

  it('rank 3: on break beyond 30 minutes', () => {
    const over = agent({ state: 'break', break_reason: 'Lunch', state_since: ago(LONG_BREAK_SECONDS + 1) });
    expect(floorRisk(over, NOW, THRESHOLDS)).toBe('long_break');
    const under = agent({ state: 'break', break_reason: 'Lunch', state_since: ago(LONG_BREAK_SECONDS - 1) });
    expect(floorRisk(under, NOW, THRESHOLDS)).toBe('none');
  });

  it('rank 4 fires on `connected: false`', () => {
    expect(floorRisk(agent({ connected: false }), NOW, THRESHOLDS)).toBe('disconnected');
  });

  it('rank 4 does NOT fire on `connected: null` — that is “could not determine”', () => {
    /*
     * The single most important assertion in this file. The API resolves
     * `connected` from Redis and degrades to `null` on a fault. `!connected` —
     * the natural thing to type — turns one degraded read into a floor full of
     * agents reported as dropped, on the exact screen a supervisor uses to
     * decide who to go and find. Same rule as `concurrency_in_use`.
     */
    expect(floorRisk(agent({ connected: null }), NOW, THRESHOLDS)).toBe('none');
    // And it stays "none" in every state, not just the idle one.
    for (const state of ['available', 'reserved', 'on_call', 'wrapup', 'break'] as const) {
      expect(floorRisk(agent({ connected: null, state, state_since: ago(5) }), NOW, THRESHOLDS)).toBe('none');
    }
  });

  it('shows ONE risk per agent — the worst, not all that matched', () => {
    // Disconnected AND overrunning a wrap-up. A tile carrying two warnings is a
    // tile a supervisor does not act on, so the higher rank wins.
    const both = agent({
      state: 'wrapup',
      state_since: ago(30 + WRAPUP_OVERRUN_GRACE_SECONDS + 5),
      connected: false,
    });
    expect(floorRisk(both, NOW, THRESHOLDS)).toBe('wrapup_overrun');
  });

  it('cannot fire a time-based rank when `state_since` will not parse', () => {
    const broken = agent({ state: 'wrapup', state_since: 'not-a-date' });
    expect(timeInStateMs(broken, NOW)).toBeNull();
    expect(floorRisk(broken, NOW, THRESHOLDS)).toBe('none');
    // …but a lost heartbeat needs no clock, so rank 4 still fires.
    expect(floorRisk({ ...broken, connected: false }, NOW, THRESHOLDS)).toBe('disconnected');
  });
});

describe('timeInStateMs', () => {
  it('measures from the anchor', () => {
    expect(timeInStateMs(agent({ state_since: ago(90) }), NOW)).toBe(90_000);
  });

  it('floors at zero rather than counting backwards', () => {
    // A client clock a second ahead of the server would otherwise render a
    // negative duration for the first moments of every new state.
    expect(timeInStateMs(agent({ state_since: new Date(NOW + 5_000).toISOString() }), NOW)).toBe(0);
  });

  it('returns null, never 0, for an unparseable anchor', () => {
    // 0 would render as "just now" and satisfy every threshold as fine — an
    // unparseable timestamp would silently clear a warning.
    expect(timeInStateMs(agent({ state_since: '' }), NOW)).toBeNull();
  });
});

/**
 * ─── THE SORT, AT EVERY ADJACENT BOUNDARY ───────────────────────────────────
 *
 * One fixture per neighbouring pair, each holding EXACTLY those two ranks, fed
 * in reverse. A single five-agent fixture would pass with any two neighbours
 * transposed; these cannot.
 */
describe('rankFloor — adjacent rank boundaries', () => {
  // [higher rank, lower rank, the higher-ranked agent, the lower-ranked one].
  // The two risk NAMES come first so `it.each`'s `%s` positions render a
  // readable title instead of splatting an agent object into it.
  const ADJACENT: Array<[AgencyFloorRisk, AgencyFloorRisk, AgencySupervisorAgent, AgencySupervisorAgent]> = [
    [
      'wrapup_overrun',
      'call_overrun',
      agent({ session_id: 'a', agent_name: 'Zoe', state: 'wrapup', state_since: ago(200) }),
      agent({ session_id: 'b', agent_name: 'Amit', state: 'on_call', state_since: ago(300) }),
    ],
    [
      'call_overrun',
      'long_break',
      agent({ session_id: 'a', agent_name: 'Zoe', state: 'on_call', state_since: ago(300) }),
      agent({ session_id: 'b', agent_name: 'Amit', state: 'break', break_reason: 'Lunch', state_since: ago(3600) }),
    ],
    [
      'long_break',
      'disconnected',
      agent({ session_id: 'a', agent_name: 'Zoe', state: 'break', break_reason: 'Lunch', state_since: ago(3600) }),
      agent({ session_id: 'b', agent_name: 'Amit', state: 'available', state_since: ago(4000), connected: false }),
    ],
    [
      'disconnected',
      'none',
      agent({ session_id: 'a', agent_name: 'Zoe', state: 'available', state_since: ago(5), connected: false }),
      agent({ session_id: 'b', agent_name: 'Amit', state: 'available', state_since: ago(9000) }),
    ],
  ];

  it.each(ADJACENT)('%s outranks %s', (higherRisk, lowerRisk, higher, lower) => {
    // Each fixture is deliberately hostile to the alternatives: the LOWER-ranked
    // agent is named earlier in the alphabet and (except at the last boundary)
    // has been in state longer, so a floor that fell back to the alphabet or to
    // raw duration would put them first.
    expect(floorRisk(higher, NOW, THRESHOLDS)).toBe(higherRisk);
    expect(floorRisk(lower, NOW, THRESHOLDS)).toBe(lowerRisk);

    const sorted = rankFloor([lower, higher], NOW, THRESHOLDS);
    expect(sorted.map((r) => r.agent.session_id)).toEqual(['a', 'b']);
    expect(sorted.map((r) => r.risk)).toEqual([higherRisk, lowerRisk]);
  });

  it('orders all five ranks at once, from a scrambled floor', () => {
    const floor = [
      agent({ session_id: 'calm', agent_name: 'Aaron', state: 'available', state_since: ago(9000) }),
      agent({ session_id: 'drop', agent_name: 'Bea', state: 'available', state_since: ago(5), connected: false }),
      agent({ session_id: 'brk', agent_name: 'Cal', state: 'break', break_reason: 'Lunch', state_since: ago(3600) }),
      agent({ session_id: 'call', agent_name: 'Dev', state: 'on_call', state_since: ago(300) }),
      agent({ session_id: 'wrap', agent_name: 'Eve', state: 'wrapup', state_since: ago(200) }),
    ];
    expect(rankFloor(floor, NOW, THRESHOLDS).map((r) => r.agent.session_id))
      .toEqual(['wrap', 'call', 'brk', 'drop', 'calm']);
  });
});

describe('rankFloor — within a rank', () => {
  it('puts the longest-running warning first', () => {
    // Of two overrunning wrap-ups the twelve-minute one is the one to look at.
    const shorter = agent({ session_id: 'short', agent_name: 'Aaron', state: 'wrapup', state_since: ago(120) });
    const longer = agent({ session_id: 'long', agent_name: 'Zoe', state: 'wrapup', state_since: ago(720) });
    expect(rankFloor([shorter, longer], NOW, THRESHOLDS).map((r) => r.agent.session_id))
      .toEqual(['long', 'short']);
  });

  it('sorts the unranked by name, NOT by how long they have been sitting there', () => {
    // The rule is "everyone else, by name". A supervisor scanning the calm tail is
    // looking someone up, not triaging.
    const floor = [
      agent({ session_id: 'z', agent_name: 'Zoe', state_since: ago(9000) }),
      agent({ session_id: 'a', agent_name: 'Aaron', state_since: ago(5) }),
    ];
    expect(rankFloor(floor, NOW, THRESHOLDS).map((r) => r.agent.session_id)).toEqual(['a', 'z']);
  });

  it('breaks a duration tie by name, then by session id, so a poll cannot reshuffle', () => {
    const a = agent({ session_id: 'sess-b', agent_name: 'Same', state: 'wrapup', state_since: ago(300) });
    const b = agent({ session_id: 'sess-a', agent_name: 'Same', state: 'wrapup', state_since: ago(300) });
    expect(rankFloor([a, b], NOW, THRESHOLDS).map((r) => r.agent.session_id)).toEqual(['sess-a', 'sess-b']);
  });

  it('sorts an unmeasurable duration last of its rank, not first', () => {
    // "We can't say" must not push a real 12-minute overrun below a tile
    // carrying no duration at all.
    const measured = agent({ session_id: 'measured', agent_name: 'Zoe', state: 'available', state_since: ago(60), connected: false });
    const unknown = agent({ session_id: 'unknown', agent_name: 'Aaron', state: 'available', state_since: 'nope', connected: false });
    expect(rankFloor([unknown, measured], NOW, THRESHOLDS).map((r) => r.agent.session_id))
      .toEqual(['measured', 'unknown']);
  });

  it('never mutates the array it was handed', () => {
    const floor = [
      agent({ session_id: 'calm', agent_name: 'Aaron' }),
      agent({ session_id: 'wrap', agent_name: 'Zoe', state: 'wrapup', state_since: ago(200) }),
    ];
    rankFloor(floor, NOW, THRESHOLDS);
    expect(floor.map((a) => a.session_id)).toEqual(['calm', 'wrap']);
  });
});

describe('rankFloor — the alphabetical option', () => {
  it('ignores risk entirely, for roll-call', () => {
    const floor = [
      agent({ session_id: 'wrap', agent_name: 'Zoe', state: 'wrapup', state_since: ago(200) }),
      agent({ session_id: 'calm', agent_name: 'Aaron' }),
    ];
    expect(rankFloor(floor, NOW, THRESHOLDS, 'name').map((r) => r.agent.session_id))
      .toEqual(['calm', 'wrap']);
  });

  it('still ranks each agent, so the warning glyphs survive the resort', () => {
    const floor = [agent({ agent_name: 'Zoe', state: 'wrapup', state_since: ago(200) })];
    expect(rankFloor(floor, NOW, THRESHOLDS, 'name')[0]!.risk).toBe('wrapup_overrun');
  });

  it('defaults to risk when no mode is given — the default is what gets used', () => {
    const floor = [
      agent({ session_id: 'calm', agent_name: 'Aaron' }),
      agent({ session_id: 'wrap', agent_name: 'Zoe', state: 'wrapup', state_since: ago(200) }),
    ];
    expect(rankFloor(floor, NOW, THRESHOLDS).map((r) => r.agent.session_id)).toEqual(['wrap', 'calm']);
  });
});

describe('agentDisplayName — what a tile calls someone the API could not resolve', () => {
  it('uses the resolved name when there is one', () => {
    expect(agentDisplayName(agent({ agent_name: 'Sunita' }))).toBe('Sunita');
    expect(hasResolvedName(agent({ agent_name: 'Sunita' }))).toBe(true);
  });

  it('falls back to a shortened user id — never blank, never “Unknown”', () => {
    /*
     * The API sends `null` rather than a placeholder precisely so this choice is
     * made here, and both tempting answers are wrong:
     *
     * - Blank looks like a rendering bug and cannot be acted on.
     * - "Unknown" is indistinguishable from a real name in a list, and is
     *   IDENTICAL for every unresolved agent — so two of them read as one person
     *   listed twice.
     *
     * The id is ugly and true and distinct per person, which is what a
     * supervisor needs to tell two tiles apart and to quote to support.
     */
    const unresolved = agent({ agent_name: null, agent_user_id: 'usr_abcdef123456' });
    const shown = agentDisplayName(unresolved);
    expect(shown).toBe(`Agent ${'usr_abcdef123456'.slice(0, AGENT_ID_FALLBACK_LENGTH)}`);
    expect(shown).not.toBe('');
    expect(shown.toLowerCase()).not.toContain('unknown');
    expect(hasResolvedName(unresolved)).toBe(false);
  });

  it('keeps two unresolved agents distinguishable', () => {
    const one = agentDisplayName(agent({ agent_name: null, agent_user_id: 'usr_aaaaaaaa1' }));
    const two = agentDisplayName(agent({ agent_name: null, agent_user_id: 'usr_bbbbbbbb2' }));
    expect(one).not.toBe(two);
  });

  it('treats a blank or whitespace name as unresolved', () => {
    // The API should not send one; rendering it would produce the blank tile.
    expect(agentDisplayName(agent({ agent_name: '   ' }))).toMatch(/^Agent /);
    expect(agentDisplayName(agent({ agent_name: '' }))).toMatch(/^Agent /);
    expect(hasResolvedName(agent({ agent_name: '  ' }))).toBe(false);
  });
});

describe('the force-return control', () => {
  it('is offered on a wrap-up and on nothing else', () => {
    // The route is the one thing that can end a HELD wrap-up, and that is all it
    // is for. Offering it elsewhere advertises an action the API will refuse.
    expect(canForceAvailable(agent({ state: 'wrapup' }))).toBe(true);
    for (const state of ['offline', 'available', 'reserved', 'on_call', 'break'] as const) {
      expect(canForceAvailable(agent({ state }))).toBe(false);
    }
  });

  it('is offered on ANY wrap-up, not only an overrunning one', () => {
    // A supervisor may know the agent left for the day thirty seconds in. Making
    // them wait out a grace period the console invented would be the console
    // overruling them.
    const fresh = agent({ state: 'wrapup', state_since: ago(1) });
    expect(floorRisk(fresh, NOW, THRESHOLDS)).toBe('none');
    expect(canForceAvailable(fresh)).toBe(true);
  });

  it('mirrors the API’s 1000-character reason cap', () => {
    expect(FORCE_AVAILABLE_REASON_MAX).toBe(1000);
  });

  it('names the consequence in the supervisor’s terms, not the route’s', () => {
    const message = forceAvailableConfirmMessage('Ravi');
    // The person, so a supervisor clicking through a grid sees which tile.
    expect(message).toContain('Ravi');
    expect(message).not.toContain('{name}');
    // The part that actually matters: the call being written up loses its
    // outcome permanently — the same thing the reaper's sweep would have
    // written. A confirm that said only "returns the agent to the pool" would
    // hide the half the campaign's reporting is made of.
    expect(message).toContain('no disposition');
    expect(message).toContain('cannot be filled in afterwards');
    // Deliberately not the drawer's trigger label ("End wrap-up"). Same shape as
    // the page's Stop → "Stop campaign": the confirm restates the action rather
    // than repeating the word the supervisor just clicked.
    expect(FORCE_AVAILABLE_CONFIRM.confirmLabel).toBe('End wrap-up and return');
    expect(FORCE_AVAILABLE_CONFIRM.confirmLabel).not.toBe('End wrap-up');
  });
});

describe('stateSummary — agents_by_state as one line', () => {
  it('reads busiest first, not in the wire enum’s order', () => {
    // A supervisor glancing at this wants "who is working" before "who is not".
    expect(
      stateSummary({ offline: 1, available: 2, reserved: 1, on_call: 3, wrapup: 1, break: 2 }),
    ).toBe('3 on a call · 1 wrapping up · 1 reserved · 2 available · 2 on break · 1 offline');
  });

  it('drops the zeroes the API seeds every state with', () => {
    // The API sends a total record, so an absent state is provably "nobody in it".
    // Rendering all six means the two that matter have to be found, not read.
    expect(stateSummary({ offline: 0, available: 4, reserved: 0, on_call: 0, wrapup: 0, break: 0 }))
      .toBe('4 available');
  });

  it('returns null when the payload carried no counts', () => {
    // Distinct from "everyone is idle": the caller renders nothing rather than
    // an empty line that reads as a measured, quiet floor.
    expect(stateSummary(undefined)).toBeNull();
  });

  it('returns null when every state is zero', () => {
    expect(stateSummary({ offline: 0, available: 0, reserved: 0, on_call: 0, wrapup: 0, break: 0 }))
      .toBeNull();
  });

  it('covers every state in the union', () => {
    // A seventh agent state added to the wire without a place in the order would
    // silently vanish from the summary while still being counted in agents_live.
    const all = Object.keys(AGENCY_FLOOR_STATE_LABELS) as AgencyAgentLiveState[];
    const summary = stateSummary(Object.fromEntries(all.map((s) => [s, 1])));
    for (const state of all) {
      expect(summary).toContain(AGENCY_FLOOR_STATE_LABELS[state].toLowerCase());
    }
  });
});

describe('floorStateSlices — the summary bar’s bands', () => {
  it('drops zeroes and orders busiest-first, like the roll-up line', () => {
    const slices = floorStateSlices({ offline: 0, available: 1, reserved: 0, on_call: 3, wrapup: 0, break: 0 });
    expect(slices.map((s) => s.state)).toEqual(['on_call', 'available']);
    expect(slices.map((s) => s.count)).toEqual([3, 1]);
    expect(slices.map((s) => s.label)).toEqual(['On a call', 'Available']);
  });

  it('gives each band its share of the floor, summing to 100', () => {
    const slices = floorStateSlices({ offline: 0, available: 1, reserved: 0, on_call: 3, wrapup: 0, break: 0 });
    expect(slices.map((s) => s.pct)).toEqual([75, 25]);
    expect(slices.reduce((sum, s) => sum + s.pct, 0)).toBeCloseTo(100);
  });

  it('draws NO bar when the roll-up is absent', () => {
    // The case the whole card turns on: an absent `agents_by_state` is "we don't
    // know how the floor is distributed". A bar with no bands would say "the
    // floor is empty", which is the other payload entirely.
    expect(floorStateSlices(undefined)).toEqual([]);
  });

  it('draws no bar when every state is zero', () => {
    expect(floorStateSlices({ offline: 0, available: 0, reserved: 0, on_call: 0, wrapup: 0, break: 0 })).toEqual([]);
  });
});

describe('floorZeroStates — the collapsed legend item', () => {
  it('names the empty states in one quiet line', () => {
    expect(floorZeroStates({ offline: 0, available: 3, reserved: 0, on_call: 4, wrapup: 1, break: 1 }))
      .toBe('Reserved 0 · Offline 0');
  });

  it('is null when every state has somebody in it', () => {
    const all = Object.keys(AGENCY_FLOOR_STATE_LABELS) as AgencyAgentLiveState[];
    expect(floorZeroStates(Object.fromEntries(all.map((s) => [s, 1])))).toBeNull();
  });

  it('is null when there is no roll-up to speak for', () => {
    expect(floorZeroStates(undefined)).toBeNull();
  });
});

describe('floorTotals — the card’s readouts and the rows’ scale', () => {
  it('counts the floor from the roster, not the roll-up', () => {
    const totals = floorTotals([
      agent({ session_id: 'a', state: 'available', calls_handled: 14 }),
      agent({ session_id: 'b', state: 'available', calls_handled: 6 }),
      agent({ session_id: 'c', state: 'on_call', calls_handled: 10 }),
    ]);
    expect(totals).toEqual({ onShift: 3, available: 2, handled: 30, perAgent: 10, busiest: 14 });
  });

  it('reports no average for an empty floor rather than a NaN', () => {
    expect(floorTotals([])).toEqual({ onShift: 0, available: 0, handled: 0, perAgent: null, busiest: 0 });
  });
});

describe('floorRiskSummary — the warnings as one sentence', () => {
  /** Ranks a floor the way the component does, at `NOW`. */
  const rank = (agents: AgencySupervisorAgent[]) => rankFloor(agents, NOW, THRESHOLDS);

  it('renders NOTHING when nobody is flagged', () => {
    // A warning-coloured pill reading "0 agents need a look" is a box that says
    // there is no warning, and a supervisor learns to skip it.
    expect(floorRiskSummary(rank([agent()]))).toBeNull();
    expect(floorRiskSummary([])).toBeNull();
  });

  it('states one agent’s risk without repeating the count', () => {
    const summary = floorRiskSummary(rank([agent({ state: 'wrapup', state_since: ago(200) })]));
    expect(summary).toBe('1 agent needs a look — past the wrap-up window.');
  });

  it('groups several by rank, worst first', () => {
    const summary = floorRiskSummary(rank([
      agent({ session_id: 'call', state: 'on_call', state_since: ago(600) }),
      agent({ session_id: 'wrap', state: 'wrapup', state_since: ago(200) }),
      agent({ session_id: 'brk', state: 'break', state_since: ago(3600) }),
    ]));
    expect(summary).toBe(
      '3 agents need a look — 1 past the wrap-up window, '
      + '1 on a call past twice the handle-time average, 1 on a break longer than 30 minutes.',
    );
  });

  it('counts each flagged agent exactly once — the clauses sum to the head', () => {
    // `floorRisk` is first-match-wins, so an agent who is both disconnected and
    // overrunning is one agent in the head count and one clause, not two.
    const summary = floorRiskSummary(rank([
      agent({ session_id: 'both', state: 'wrapup', state_since: ago(200), connected: false }),
      agent({ session_id: 'drop', connected: false }),
    ]));
    expect(summary).toBe('2 agents need a look — 1 past the wrap-up window, 1 with no station heartbeat.');
  });

  it('has a clause and a short flag for every warning rank', () => {
    // A rank added without either would render as an empty cell on the row and
    // silently drop out of the summary.
    for (const risk of AGENCY_FLOOR_RISK_ORDER) {
      if (risk === 'none') {
        expect(AGENCY_FLOOR_RISK_CLAUSE[risk]).toBeNull();
        expect(AGENCY_FLOOR_RISK_FLAG[risk]).toBeNull();
      } else {
        expect(AGENCY_FLOOR_RISK_CLAUSE[risk]).toBeTruthy();
        expect(AGENCY_FLOOR_RISK_FLAG[risk]).toBeTruthy();
      }
    }
  });
});

describe('agentInitials — the row’s avatar', () => {
  it('takes the first and last word', () => {
    expect(agentInitials('Priya Raghavan')).toBe('PR');
    expect(agentInitials('Maria del Carmen Ruiz')).toBe('MR');
  });

  it('gives a single-word name one letter, not a doubled one', () => {
    expect(agentInitials('Ravi')).toBe('R');
  });

  it('survives a name outside the BMP', () => {
    // `"𝒜lice"[0]` is half a surrogate pair and renders as a replacement glyph.
    expect(agentInitials('𝒜lice Ng')).toBe('𝒜N');
  });

  it('never renders empty', () => {
    expect(agentInitials('   ')).toBe('?');
  });
});

describe('Overview and the Agents tab agree about who is on shift', () => {
  /*
    `agencyCampaignOverview`'s rail excludes `offline` (its `FLOOR_BAR_ORDER`,
    matching the API's `shift_seconds` via `foldOccupancy`). This tab used to
    include it, so one payload produced "3 of 9 free" on Overview and a different
    denominator plus an Offline band on Agents.
  */
  const byState = { on_call: 2, wrapup: 1, available: 3, break: 1, reserved: 0, offline: 4 };

  it('keeps signed-out agents out of the stacked bar and its denominator', () => {
    const slices = floorStateSlices(byState);
    expect(slices.map((slice) => slice.state)).not.toContain('offline');

    // The shares are of the SEVEN on shift, not the eleven in the roster.
    const onShift = 2 + 1 + 3 + 1;
    expect(Math.round(slices.reduce((sum, slice) => sum + slice.pct, 0))).toBe(100);
    const available = slices.find((slice) => slice.state === 'available');
    expect(available?.pct).toBeCloseTo((3 / onShift) * 100);
  });

  it('matches the Overview rail exactly, for the same payload', () => {
    const rail = floorSummary({ agents_by_state: byState } as never);
    const slices = floorStateSlices(byState);
    expect(slices.map((s) => [s.state, s.count])).toEqual(rail.slices.map((s) => [s.state, s.count]));
    expect(rail.onShift).toBe(slices.reduce((sum, s) => sum + s.count, 0));
  });

  it('counts on-shift agents, not roster rows', () => {
    const roster = [
      { session_id: 'a', state: 'available', calls_handled: 4 },
      { session_id: 'b', state: 'on_call', calls_handled: 6 },
      { session_id: 'c', state: 'offline', calls_handled: 9 },
    ] as never as Parameters<typeof floorTotals>[0];

    const totals = floorTotals(roster);
    expect(totals.onShift).toBe(2);
    /*
      Handled still ranges over EVERYONE: calls a person took before they logged
      out are calls they took, and dropping them would make the floor's total
      shrink as people go home.
    */
    expect(totals.handled).toBe(19);
    expect(totals.perAgent).toBeCloseTo(19 / 2);
  });
});

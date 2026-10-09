import { describe, it, expect } from 'vitest';
import {
  AGENT_LANDING_PARAM,
  EXIT_AVAILABLE_BLOCKED_COPY,
  EXIT_BLOCKED_COPY,
  EXIT_LABEL,
  LEAVE_BLOCKED_COPY,
  LEAVE_LABEL,
  agentLandingArrival,
  agentLandingPath,
  exitBlockedReason,
  leaveBlockedReason,
  stationExitBlocked,
  stationLeaveBlocked,
} from '../../utils/agencyStationExit';
import type { AgencyAgentState } from '../../types/agency';

/**
 * The station's two exits — which states refuse them, and
 * the rule that they never read as the same control.
 */

describe('both exits are refused while a customer is involved', () => {
  it.each<AgencyAgentState>(['reserved', 'on_call', 'wrapup'])('refuses both in %s', (state) => {
    // `reserved` counts: the call is already dialling and the bridge is coming,
    // so leaving abandons a stranger onto dead air exactly as `on_call` does.
    // `wrapup` counts because the disposition is still outstanding.
    expect(stationLeaveBlocked(state)).toBe(true);
    expect(stationExitBlocked(state)).toBe(true);
  });

  it.each<AgencyAgentState>(['offline', 'break'])('allows both in %s', (state) => {
    expect(stationLeaveBlocked(state)).toBe(false);
    expect(stationExitBlocked(state)).toBe(false);
  });
});

/**
 * ── The asymmetry, pinned ───────────────────────────────────────────────────
 *
 * Exit leaves the session live and only drops the socket, and the API's
 * `AGENT_LEASE_MS.available` (45s) is renewed by that socket's heartbeat alone
 * while the pacing engine reserves off Redis. So an Exit taken in `available`
 * leaves the agent dialable for up to 45 seconds with no console attached, and a
 * reservation landing in that window answers a customer to nobody — the failure
 * the design makes unreachable except by an agent physically disappearing.
 *
 * Leave is what actually ends the session, so it must stay offered here: it is
 * both the correct action and the remedy Exit's refusal names. This is the test
 * that stops the asymmetry being "tidied" into symmetry in either direction.
 */
describe('available refuses Exit and not Leave', () => {
  it('blocks Exit', () => {
    expect(stationExitBlocked('available')).toBe(true);
  });

  it('leaves Leave alone — blocking both would strand a supervisor in the console', () => {
    expect(stationLeaveBlocked('available')).toBe(false);
    expect(leaveBlockedReason('available')).toBeNull();
  });

  it('states the remedy rather than only refusing', () => {
    const reason = exitBlockedReason('available');
    // Not the mid-call sentence: nothing is on screen, so "finish this call"
    // would refuse on account of a call that does not exist.
    expect(reason).toBe(EXIT_AVAILABLE_BLOCKED_COPY);
    expect(reason).not.toBe(EXIT_BLOCKED_COPY);
    expect(reason).toContain('leave the station or go on break');
  });

  it('gives Exit the mid-call reason while a call is up, and nothing when neither applies', () => {
    expect(exitBlockedReason('on_call')).toBe(EXIT_BLOCKED_COPY);
    expect(exitBlockedReason('break')).toBeNull();
  });
});

describe('the two exits are never the same control', () => {
  it('has different labels', () => {
    // They are different acts. One ends the session and frees the
    // agent's one-live-session slot; the other only changes the URL.
    expect(LEAVE_LABEL).not.toBe(EXIT_LABEL);
  });

  it('has different stated reasons, both naming the same remedy', () => {
    expect(LEAVE_BLOCKED_COPY).not.toBe(EXIT_BLOCKED_COPY);
    expect(LEAVE_BLOCKED_COPY).toContain('Finish this call first');
    expect(EXIT_BLOCKED_COPY).toContain('Finish this call first');
  });
});

/**
 * The landing arrival — the param that says "do not send me straight back".
 *
 * It lives beside the exit copy rather than on the landing component so the
 * console can link to that screen without importing a component for one string.
 */
describe('agentLandingArrival', () => {
  it.each(['station', 'refused'] as const)('reads %s', (value) => {
    expect(agentLandingArrival(value)).toBe(value);
  });

  it.each([null, undefined, '', 'banana', 'Station'])(
    'treats %p as an ordinary visit',
    (raw) => {
      // A hand-edited or stale URL must degrade to the normal redirect rather
      // than stranding an agent on a landing screen with a working station.
      expect(agentLandingArrival(raw)).toBeNull();
    },
  );

  it('builds URLs the landing screen actually reads', () => {
    /**
     * `/dialer`, not `/app`. The agent home moved there, and pointing at `/app`
     * only worked because `AgentLanding` forwards the param — an extra hop through
     * the one component whose job is to redirect agents away from `/app`, and one
     * more place for the arrival to be dropped.
     */
    expect(agentLandingPath('station')).toBe(`/dialer?${AGENT_LANDING_PARAM}=station`);
    expect(
      agentLandingArrival(
        new URLSearchParams(agentLandingPath('refused').split('?')[1]).get(AGENT_LANDING_PARAM),
      ),
    ).toBe('refused');
  });
});

import { describe, it, expect } from 'vitest';
import { AGENT_LANDING_PARAM, agentLandingArrival, agentLandingPath } from '../../utils/agencyStationExit';

/**
 * The landing arrival — the param that says "do not send me straight back".
 *
 * It lives in a utility rather than on the landing component so the
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

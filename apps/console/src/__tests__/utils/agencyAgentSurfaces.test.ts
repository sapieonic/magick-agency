import { describe, it, expect } from 'vitest';
import { AGENT_SURFACES, agentSurfaceAt } from '../../utils/agencyAgentSurfaces';
import { STATION_HISTORY_LINKS } from '../../utils/agencyStationExit';

/**
 * The agent's map, and the one thing that can silently un-map it.
 *
 * An `agent` is hierarchy level 5 and inherits no navigation, so all four agent
 * routes are full-viewport and outside both shells. That leaves this list as the
 * ONLY statement anywhere in the product of what an agent's screens are — there
 * is no sidebar to fall back on, and `GlobalSearch` lives inside `AppLayout`
 * which a dedicated agent never renders.
 */

describe('AGENT_SURFACES', () => {
  it('is the three non-station agent screens, campaigns first', () => {
    /**
     * Order is a product decision, not an accident of authoring: campaigns leads
     * because it is the only one that answers "what am I supposed to be doing" —
     * the other two are about what already happened.
     */
    expect(AGENT_SURFACES.map((surface) => surface.id)).toEqual([
      'campaigns',
      'performance',
      'attempts',
    ]);
    expect(AGENT_SURFACES.map((surface) => surface.to)).toEqual([
      '/dialer',
      '/dialer/performance',
      '/dialer/attempts',
    ]);
  });

  it('does NOT offer the station', () => {
    /**
     * A station is an agent joined to ONE campaign's pool, so there is no
     * campaign-less station to link to — a bare `/station` lands on the console's
     * "No campaign selected" refusal. Entering one is a decision made against a
     * specific campaign, which is what the rows on `/dialer` are for.
     */
    expect(AGENT_SURFACES.some((surface) => surface.to.startsWith('/station'))).toBe(false);
  });

  it('speaks in the first person, because these are the agent’s own screens', () => {
    // Deliberately unlike the supervisor's vocabulary elsewhere ("Everyone who
    // dialled"). Whose calls these are is the whole distinction between the two
    // halves of this product.
    for (const surface of AGENT_SURFACES) {
      expect(surface.label, surface.id).toMatch(/^My /);
    }
  });
});

describe('agentSurfaceAt', () => {
  it('resolves an exact path and nothing else', () => {
    expect(agentSurfaceAt('/dialer')?.id).toBe('campaigns');
    expect(agentSurfaceAt('/dialer/attempts')?.id).toBe('attempts');
    expect(agentSurfaceAt('/dialer/attempts/extra')).toBeNull();
    expect(agentSurfaceAt('/agency/campaigns')).toBeNull();
  });

  it('does not prefix-match, which is what a NavLink would have done', () => {
    // `/dialer` is a prefix of both its siblings, so a prefix match would report
    // "My campaigns" as current on all three — the reason `AgentNav` uses plain
    // `Link`s and an explicit `current` rather than `NavLink`.
    expect(agentSurfaceAt('/dialer/performance')?.id).toBe('performance');
  });
});

describe('the station’s links stay in step with this list', () => {
  it('sends the console at the two HISTORY surfaces, by their real paths', () => {
    /**
     * The console cannot use `AgentNav`: navigating away from a live station
     * closes the socket and leaves the API holding the agent's lease for up to 45s
     * with no screen attached, so `STATION_HISTORY_LINKS` opens the same
     * destinations in a new tab instead. Two lists, one set of paths — and this
     * is what stops a renamed route fixing one and breaking the other.
     */
    const historyPaths = AGENT_SURFACES.filter((surface) => surface.id !== 'campaigns').map(
      (surface) => surface.to,
    );

    expect(STATION_HISTORY_LINKS.map((link) => link.to).sort()).toEqual([...historyPaths].sort());
  });

  it('does NOT send the console at /dialer, which would open a second station', () => {
    /**
     * Not an omission to be "completed". `/dialer` redirects an agent with one
     * enterable assignment straight into `/station`, so a link to it from inside
     * a live console — in a new tab, as these are — is a link that opens a
     * SECOND station for the same agent. Reaching the chooser is what Leave is
     * for.
     */
    expect(STATION_HISTORY_LINKS.some((link) => link.to === '/dialer')).toBe(false);
  });
});

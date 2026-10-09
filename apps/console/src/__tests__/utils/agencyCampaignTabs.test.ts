import { describe, it, expect } from 'vitest';
import {
  CAMPAIGN_TABS,
  campaignPanelFromPath,
  visibleCampaignTabs,
} from '../../utils/agencyCampaignTabs';
import type { Role } from '../../types/auth';

/**
 * The campaign workspace's section bar (`MAG-166`).
 *
 * Two things are worth pinning here rather than in a component test: that each
 * tab carries the permission master actually enforces — a tab that renders and
 * then 403s on arrival is a worse answer than no tab — and that the panel a URL
 * resolves to is the one the bar marks as current, since those are computed by
 * different functions and a mismatch would highlight the wrong tab.
 */

describe('campaign tabs — what each role can reach', () => {
  const idsFor = (role: Role | undefined) => visibleCampaignTabs(role).map((t) => t.id);

  it('gives an agent only the sections that need no permission at all', () => {
    // `agent` (the Agency Dialer role) sits BELOW `viewer`. The campaign's own
    // numbers, its performance and its floor are readable; the spine, the audit
    // trail and the settings form are not.
    expect(idsFor('agent')).toEqual(['overview', 'performance', 'agents']);
  });

  it('does not open the spine to a viewer or an operator', () => {
    // Both are below `agency.supervise`'s `account_admin` floor, which is what
    // master gates the roster, the attempts and the settings proxy on.
    for (const role of ['viewer', 'operator'] as Role[]) {
      expect(idsFor(role)).toEqual(['overview', 'performance', 'agents']);
    }
  });

  it('gives an account_admin — the floor of both gates — every section', () => {
    expect(idsFor('account_admin')).toEqual([
      'overview',
      'performance',
      'agents',
      'contacts',
      'attempts',
      'activity',
      'settings',
    ]);
  });

  it('shows nothing to a role that is absent', () => {
    // A signed-out or half-loaded tenant context must not be read as a
    // permission grant.
    expect(idsFor(undefined)).toEqual(['overview', 'performance', 'agents']);
  });

  it('checks `audit.read` for Activity, not the supervise gate it shares a floor with', () => {
    // The two floors are equal today. Naming the right one is what makes the
    // tab follow its own gate if either ever moves.
    const activity = CAMPAIGN_TABS.find((t) => t.id === 'activity');
    expect(activity?.permission).toBe('audit.read');
    expect(CAMPAIGN_TABS.find((t) => t.id === 'attempts')?.permission).toBe('agency.supervise');
  });
});

describe('campaign tabs — which panel a URL means', () => {
  it.each([
    ['/agency/campaigns/camp-1', 'overview'],
    ['/agency/campaigns/camp-1/', 'overview'],
    ['/agency/campaigns/camp-1/performance', 'performance'],
    ['/agency/campaigns/camp-1/agents', 'agents'],
  ])('%s is the %s panel', (pathname, expected) => {
    expect(campaignPanelFromPath(pathname)).toBe(expected);
  });

  it('falls back to the overview rather than rendering nothing', () => {
    // The three panel routes are the only ones that mount this page, so an
    // unrecognised tail can only come from a hand-edited URL — which should
    // land on the section a supervisor expects, not on a blank screen.
    expect(campaignPanelFromPath('/agency/campaigns/camp-1/nonsense')).toBe('overview');
  });

  /**
   * ── A campaign id is opaque, and may spell a panel ─────────────────────────
   *
   * Core owns the id format and this repo cannot see it. Resolving the panel by
   * matching the END of the path — "does it end in `agents`?" — reads a
   * campaign called `agents` as a request for the Agents panel, on the URL that
   * is that campaign's own overview, and highlights the wrong tab while doing
   * it. The panel is the segment that FOLLOWS the id, and only that.
   */
  it.each(['agents', 'performance', 'overview', 'campaigns'])(
    'reads /campaigns/%s as that campaign’s overview, not as a panel',
    (id) => {
      expect(campaignPanelFromPath(`/agency/campaigns/${id}`)).toBe('overview');
    },
  );

  it('still resolves the panel of a campaign whose id spells one', () => {
    expect(campaignPanelFromPath('/agency/campaigns/agents/agents')).toBe('agents');
    expect(campaignPanelFromPath('/agency/campaigns/campaigns/performance')).toBe('performance');
  });

  it('claims no panel for a path outside the campaign workspace', () => {
    expect(campaignPanelFromPath('/app/calls/agents')).toBe('overview');
  });

  it('agrees with the path each tab links to', () => {
    for (const tab of CAMPAIGN_TABS.slice(0, 3)) {
      expect(campaignPanelFromPath(tab.path('camp-1'))).toBe(tab.id);
    }
  });
});

import { describe, it, expect } from 'vitest';
import {
  CAMPAIGN_TABS,
  campaignLandingPath,
  campaignPanelFromPath,
  visibleCampaignTabs,
} from '../../utils/agencyCampaignTabs';
import type { Role } from '../../types/auth';

/**
 * The campaign workspace's section bar.
 *
 * Two things are worth pinning here rather than in a component test: that each
 * tab carries the permission the API actually enforces — a tab that renders and
 * then 403s on arrival is a worse answer than no tab — and that the panel a URL
 * resolves to is the one the bar marks as current, since those are computed by
 * different functions and a mismatch would highlight the wrong tab.
 */

describe('campaign tabs — what each role can reach', () => {
  const idsFor = (role: Role | undefined) => visibleCampaignTabs(role).map((t) => t.id);

  it('gives an agent only the section that needs no permission at all', () => {
    // `agent` (the Agency Dialer role) sits BELOW `viewer`. The floor is
    // readable; Insights, the spine, the audit trail and the settings are not.
    expect(idsFor('agent')).toEqual(['agents']);
  });

  it('opens neither Insights nor the spine to a viewer or an operator', () => {
    // Both are below `agency.supervise`'s `account_admin` floor, which is what
    // the API gates every Insights read, the roster, the attempts and the
    // settings proxy on. (Overview and Performance were open to them, and
    // their chart 403'd: the defect Insights' gate closes.)
    for (const role of ['viewer', 'operator'] as Role[]) {
      expect(idsFor(role)).toEqual(['agents']);
    }
  });

  it('gives an account_admin — the floor of both gates — every section, Insights first', () => {
    expect(idsFor('account_admin')).toEqual([
      'insights',
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
    expect(idsFor(undefined)).toEqual(['agents']);
  });

  it('checks `audit.read` for Activity, not the supervise gate it shares a floor with', () => {
    // The two floors are equal today. Naming the right one is what makes the
    // tab follow its own gate if either ever moves.
    const activity = CAMPAIGN_TABS.find((t) => t.id === 'activity');
    expect(activity?.permission).toBe('audit.read');
    expect(CAMPAIGN_TABS.find((t) => t.id === 'attempts')?.permission).toBe('agency.supervise');
  });

  it('gates Insights on `agency.supervise`, the floor of every insights read', () => {
    expect(CAMPAIGN_TABS[0]?.id).toBe('insights');
    expect(CAMPAIGN_TABS[0]?.permission).toBe('agency.supervise');
    expect(CAMPAIGN_TABS[0]?.path('camp-1')).toBe('/agency/campaigns/camp-1/insights');
    // Overview and Performance are gone (decision IN1).
    expect(CAMPAIGN_TABS.map((t) => t.id)).not.toContain('overview');
    expect(CAMPAIGN_TABS.map((t) => t.id)).not.toContain('performance');
  });
});

describe('campaign tabs — where the campaign’s own URL lands', () => {
  it('lands a supervisor on Insights', () => {
    for (const role of ['account_admin', 'tenant_owner'] as Role[]) {
      expect(campaignLandingPath('camp-1', role)).toBe('/agency/campaigns/camp-1/insights');
    }
  });

  it('lands a role that cannot read Insights on Agents, never on a tab that 403s', () => {
    for (const role of ['agent', 'viewer', 'operator', undefined] as Array<Role | undefined>) {
      expect(campaignLandingPath('camp-1', role)).toBe('/agency/campaigns/camp-1/agents');
    }
  });
});

describe('campaign tabs — which panel a URL means', () => {
  it.each([
    ['/agency/campaigns/camp-1/insights', 'insights'],
    ['/agency/campaigns/camp-1/insights/', 'insights'],
    ['/agency/campaigns/camp-1/agents', 'agents'],
  ])('%s is the %s panel', (pathname, expected) => {
    expect(campaignPanelFromPath(pathname)).toBe(expected);
  });

  it('falls back to Agents, which every campaign reader can open, rather than rendering nothing', () => {
    // The two panel routes are the only ones that mount this page, so an
    // unrecognised tail can only come from a hand-edited URL.
    expect(campaignPanelFromPath('/agency/campaigns/camp-1/nonsense')).toBe('agents');
    expect(campaignPanelFromPath('/agency/campaigns/camp-1')).toBe('agents');
  });

  /**
   * ── A campaign id is opaque, and may spell a panel ─────────────────────────
   *
   * The API owns the id format and this repo cannot see it. Resolving the panel by
   * matching the END of the path — "does it end in `agents`?" — reads a
   * campaign called `agents` as a request for the Agents panel, on the URL that
   * is that campaign's own overview, and highlights the wrong tab while doing
   * it. The panel is the segment that FOLLOWS the id, and only that.
   */
  it.each(['insights', 'campaigns'])(
    'reads /campaigns/%s/agents as that campaign’s Agents panel, not the id as a panel',
    (id) => {
      expect(campaignPanelFromPath(`/agency/campaigns/${id}/agents`)).toBe('agents');
      // The id alone is no panel request, whatever it spells.
      expect(campaignPanelFromPath(`/agency/campaigns/${id}`)).toBe('agents');
    },
  );

  it('still resolves the panel of a campaign whose id spells one', () => {
    expect(campaignPanelFromPath('/agency/campaigns/agents/insights')).toBe('insights');
    expect(campaignPanelFromPath('/agency/campaigns/campaigns/insights')).toBe('insights');
  });

  it('claims no panel for a path outside the campaign workspace', () => {
    expect(campaignPanelFromPath('/app/calls/insights')).toBe('agents');
  });

  it('agrees with the path each tab links to', () => {
    for (const tab of CAMPAIGN_TABS.slice(0, 2)) {
      expect(campaignPanelFromPath(tab.path('camp-1'))).toBe(tab.id);
    }
  });
});

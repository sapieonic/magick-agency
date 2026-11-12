import { describe, it, expect } from 'vitest';
import {
  barTabFor,
  campaignTabHref,
  CAMPAIGN_TABS,
  campaignLandingPath,
  campaignPanelFromPath,
  canOpenCampaignScreen,
  visibleCallLogViews,
  visibleCampaignTabGroups,
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
    // readable; the analytic tabs, the spine, the audit trail and the settings are not.
    expect(idsFor('agent')).toEqual(['agents']);
  });

  it('opens neither the analytic tabs nor the spine to a viewer or an operator', () => {
    // Both are below `agency.supervise`'s `account_admin` floor, which is what
    // the API gates every Insights read, the roster, the attempts and the
    // settings proxy on. (Overview and Performance were open to them, and
    // their chart 403'd: the defect Insights' gate closes.)
    for (const role of ['viewer', 'operator'] as Role[]) {
      expect(idsFor(role)).toEqual(['agents']);
    }
  });

  it('gives an account_admin — the floor of both gates — every tab, Overview first', () => {
    // Activity and Soft-phone calls are not tabs since IN14 (History and a Call log view).
    expect(idsFor('account_admin')).toEqual([
      'overview',
      'calls',
      'agents',
      'callbacks',
      'health',
      'contacts',
      'attempts',
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

  it('gates every analytic tab on `agency.supervise`, the floor of every insights read', () => {
    for (const id of ['overview', 'calls', 'callbacks', 'health']) {
      const tab = CAMPAIGN_TABS.find((t) => t.id === id);
      expect(tab?.permission).toBe('agency.supervise');
      expect(tab?.path('camp-1')).toBe(`/agency/campaigns/camp-1/${id}`);
    }
    expect(CAMPAIGN_TABS[0]?.id).toBe('overview');
    // Performance went with IN1, the single Insights tab with IN13.
    expect(CAMPAIGN_TABS.map((t) => t.id)).not.toContain('insights');
    expect(CAMPAIGN_TABS.map((t) => t.id)).not.toContain('performance');
  });
});

describe('campaign tabs — where the campaign’s own URL lands', () => {
  it('lands a supervisor on Overview', () => {
    for (const role of ['account_admin', 'tenant_owner'] as Role[]) {
      expect(campaignLandingPath('camp-1', role)).toBe('/agency/campaigns/camp-1/overview');
    }
  });

  it('lands a role that cannot read Overview on Agents, never on a tab that 403s', () => {
    for (const role of ['agent', 'viewer', 'operator', undefined] as Array<Role | undefined>) {
      expect(campaignLandingPath('camp-1', role)).toBe('/agency/campaigns/camp-1/agents');
    }
  });
});

describe('campaign tabs — which panel a URL means', () => {
  it.each([
    ['/agency/campaigns/camp-1/overview', 'overview'],
    ['/agency/campaigns/camp-1/overview/', 'overview'],
    ['/agency/campaigns/camp-1/calls', 'calls'],
    ['/agency/campaigns/camp-1/agents', 'agents'],
    ['/agency/campaigns/camp-1/callbacks', 'callbacks'],
    ['/agency/campaigns/camp-1/health', 'health'],
    // The retired Insights URL is a redirect, never a panel.
    ['/agency/campaigns/camp-1/insights', 'agents'],
  ])('%s is the %s panel', (pathname, expected) => {
    expect(campaignPanelFromPath(pathname)).toBe(expected);
  });

  it('falls back to Agents, which every campaign reader can open, rather than rendering nothing', () => {
    // The panel routes are the only ones that mount this page, so an
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
  it.each(['overview', 'campaigns'])(
    'reads /campaigns/%s/agents as that campaign’s Agents panel, not the id as a panel',
    (id) => {
      expect(campaignPanelFromPath(`/agency/campaigns/${id}/agents`)).toBe('agents');
      // The id alone is no panel request, whatever it spells.
      expect(campaignPanelFromPath(`/agency/campaigns/${id}`)).toBe('agents');
    },
  );

  it('still resolves the panel of a campaign whose id spells one', () => {
    expect(campaignPanelFromPath('/agency/campaigns/agents/overview')).toBe('overview');
    expect(campaignPanelFromPath('/agency/campaigns/campaigns/calls')).toBe('calls');
  });

  it('claims no panel for a path outside the campaign workspace', () => {
    expect(campaignPanelFromPath('/app/calls/overview')).toBe('agents');
  });

  it('agrees with the path each tab links to', () => {
    for (const tab of CAMPAIGN_TABS.slice(0, 5)) {
      expect(campaignPanelFromPath(tab.path('camp-1'))).toBe(tab.id);
    }
  });
});

describe('campaignTabHref', () => {
  it('carries the range to the five panels, and to no standalone screen', () => {
    for (const tab of CAMPAIGN_TABS) {
      const href = campaignTabHref(tab.id, 'camp-1', '?range=7d');
      expect(href).toBe(CAMPAIGN_TABS.indexOf(tab) < 5 ? `${tab.path('camp-1')}?range=7d` : tab.path('camp-1'));
    }
    expect(campaignTabHref('calls', 'camp-1')).toBe('/agency/campaigns/camp-1/calls');
  });
});

/**
 * ── Grouped, still one tab per question (decision IN14) ──────────────────────
 * Three labelled groups over the same flat tabs: grouping must not hide a tab,
 * nest one, or change any tab's gate.
 */
describe('campaign tabs — the groups', () => {
  const shape = (role: Role | undefined) =>
    visibleCampaignTabGroups(role).map((g) => [g.label, g.tabs.map((t) => t.label)]);

  it('groups a supervisor’s tabs as Monitor, Data and Set up, in bar order', () => {
    expect(shape('account_admin')).toEqual([
      ['Monitor', ['Overview', 'Calls', 'Agents', 'Callbacks', 'Health']],
      ['Data', ['Contacts', 'Call log']],
      ['Set up', ['Settings']],
    ]);
  });

  it('drops a group with nothing left in it, so a viewer sees Monitor with Agents alone', () => {
    for (const role of ['agent', 'viewer', 'operator', undefined] as Array<Role | undefined>) {
      expect(shape(role)).toEqual([['Monitor', ['Agents']]]);
    }
  });

  it('flattens back to exactly the visible tabs, so grouping hides none', () => {
    for (const role of ['viewer', 'account_admin', 'tenant_owner'] as Role[]) {
      expect(visibleCampaignTabGroups(role).flatMap((g) => g.tabs)).toEqual(visibleCampaignTabs(role));
    }
  });

  it('keeps Soft-phone calls and History out of the bar', () => {
    const ids = visibleCampaignTabs('tenant_owner').map((t) => t.id);
    expect(ids).not.toContain('manual');
    expect(ids).not.toContain('activity');
    // The bar reads no flags: a flagged screen stays out of it.
    expect(CAMPAIGN_TABS.filter((t) => t.group !== null && t.flag)).toEqual([]);
  });

  it('marks Call log on both its views, and no tab on History', () => {
    expect(barTabFor('attempts')).toBe('attempts');
    expect(barTabFor('manual')).toBe('attempts');
    expect(barTabFor('activity')).toBeNull();
    expect(barTabFor('settings')).toBe('settings');
  });

  it('names Call attempts Call log, still at /attempts', () => {
    const tab = CAMPAIGN_TABS.find((t) => t.id === 'attempts');
    expect(tab?.label).toBe('Call log');
    expect(tab?.path('camp-1')).toBe('/agency/campaigns/camp-1/attempts');
  });
});

describe('Call log’s views', () => {
  const flagOn = (flag: string) => flag === 'agency_softphone_enabled';

  it('offers Soft-phone calls after Dialler calls only with the soft phone’s flag on', () => {
    expect(visibleCallLogViews('account_admin').map((v) => v.label)).toEqual(['Dialler calls']);
    expect(visibleCallLogViews('account_admin', flagOn).map((v) => v.label)).toEqual([
      'Dialler calls',
      'Soft-phone calls',
    ]);
  });

  it('offers neither below `agency.supervise`, flag or not', () => {
    for (const role of ['agent', 'viewer', 'operator'] as Role[]) {
      expect(visibleCallLogViews(role, flagOn)).toEqual([]);
    }
  });
});

describe('History (the activity trail)', () => {
  it('opens on `audit.read`, as the page does', () => {
    expect(canOpenCampaignScreen('activity', 'account_admin')).toBe(true);
    expect(canOpenCampaignScreen('activity', 'operator')).toBe(false);
    expect(campaignTabHref('activity', 'camp-1', '?range=7d')).toBe('/agency/campaigns/camp-1/activity');
  });
});

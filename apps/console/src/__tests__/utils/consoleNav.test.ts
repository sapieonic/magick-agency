import { describe, expect, it } from 'vitest';
import {
  CONSOLE_SECTIONS,
  activeNavId,
  SETTINGS_GATE,
  appliesTo,
  backCrumb,
  breadcrumbFor,
  passesGate,
  settingsLandingPath,
  legacySettingsPath,
  productSurfaceForPath,
  settingsEntryForPath,
  settingsGroupTitle,
  canSeeHome,
  tabBarFor,
  visibleSections,
  visibleSettingsGroups,
  type GateInput,
} from '../../utils/consoleNav';
import type { Role } from '../../types/auth';

/**
 * The console's navigation model (decision B28): which work sections and Settings entries a
 * reader is offered, which tab bar a grouped page shows, what is active, the breadcrumb, and
 * where an old `/app` URL goes. Each gate is the one its page had in the two old shells, so
 * the per-role, per-flag and per-capability assertions below are the old sidebars' assertions
 * carried over.
 */

const ALL_ON = new Set([
  'agency_dialer_enabled',
  'agency_softphone_enabled',
  'agency_reports_enabled',
  'agency_inbound_enabled',
  'agency_call_analysis',
]);

function input(
  role: Role | undefined,
  over: { flagsOff?: string[]; capsOff?: string[]; missed?: boolean } = {},
): GateInput {
  const flags = new Set([...ALL_ON].filter((f) => !(over.flagsOff ?? []).includes(f)));
  return {
    role,
    isFlagEnabled: (f) => flags.has(f),
    isCapabilityEnabled: (c) => !(over.capsOff ?? []).includes(c),
    missedAvailable: over.missed ?? true,
  };
}

const sectionIds = (i: GateInput) => visibleSections(i).map((s) => s.section.id);
const settingsIds = (i: GateInput) => visibleSettingsGroups(i).flatMap((g) => g.entries.map((e) => e.id));

describe('the work sections', () => {
  it('offers a supervisor Home and all four, in order, each opening its first page', () => {
    const shown = visibleSections(input('account_admin'));
    expect(shown.map((s) => [s.section.label, s.href])).toEqual([
      ['Home', '/agency/home'],
      ['Campaigns', '/agency/campaigns'],
      ['Inbound', '/agency/inbound/missed'],
      ['Reports', '/agency/analytics'],
      ['Do Not Call', '/agency/dnc'],
    ]);
  });

  it.each(['viewer', 'operator'] as const)('offers a %s the same four and Take calls, but not Home (read floors; Home needs agency.supervise)', (role) => {
    expect(sectionIds(input(role))).toEqual(['campaigns', 'inbound', 'reports', 'dnc', 'dialer']);
  });

  it('offers an agent no work page, only the way back to the dialler', () => {
    expect(visibleSections(input('agent')).map((s) => [s.section.id, s.href])).toEqual([['dialer', '/dialer']]);
  });

  it('offers Take calls only to whoever takes calls without supervising, under the dialer', () => {
    for (const role of ['account_admin', 'tenant_admin', 'tenant_owner', undefined] as const) {
      expect(sectionIds(input(role))).not.toContain('dialer');
    }
    expect(sectionIds(input('operator', { flagsOff: ['agency_dialer_enabled'] }))).not.toContain('dialer');
    expect(sectionIds(input('operator', { capsOff: ['agency'] }))).not.toContain('dialer');
    // A link out: never active, no tab bar, no crumbs in the shell.
    expect(tabBarFor('/dialer', input('operator'))).toBeNull();
  });

  it('offers nothing while the role is unresolved', () => {
    expect(sectionIds(input(undefined))).toEqual([]);
  });

  it('offers nothing without the dialer: the agency capability or its flag', () => {
    expect(sectionIds(input('tenant_owner', { capsOff: ['agency'] }))).toEqual([]);
    expect(sectionIds(input('tenant_owner', { flagsOff: ['agency_dialer_enabled'] }))).toEqual([]);
  });

  it('drops Inbound when the missed-calls rule says there is nothing to read', () => {
    expect(sectionIds(input('account_admin', { missed: false }))).toEqual(['home', 'campaigns', 'reports', 'dnc']);
  });

  it('keeps Reports on Analytics alone with the reports flag off', () => {
    const reports = visibleSections(input('account_admin', { flagsOff: ['agency_reports_enabled'] }))
      .find((s) => s.section.id === 'reports');
    expect(reports?.href).toBe('/agency/analytics');
  });

  it('has no "New campaign" entry: the Campaigns page has the button', () => {
    expect(CONSOLE_SECTIONS.flatMap((s) => s.tabs.map((t) => t.to))).not.toContain('/agency/campaigns/new');
  });
});

describe('the tab bar of a grouped page', () => {
  it('shows Campaigns and Soft-phone calls to a supervisor with the soft phone on', () => {
    const bar = tabBarFor('/agency/campaigns', input('account_admin'));
    expect(bar?.tabs.map((t) => t.label)).toEqual(['Campaigns', 'Soft-phone calls']);
    expect(bar?.activeId).toBe('campaigns');
    expect(tabBarFor('/agency/softphone', input('account_admin'))?.activeId).toBe('softphone');
  });

  it('is not shown when only one tab is left', () => {
    // Soft-phone calls floors at agency.supervise and needs its flag.
    expect(tabBarFor('/agency/campaigns', input('viewer'))).toBeNull();
    expect(tabBarFor('/agency/campaigns', input('account_admin', { flagsOff: ['agency_softphone_enabled'] }))).toBeNull();
    // The summary floors at agency.supervise.
    expect(tabBarFor('/agency/inbound/missed', input('viewer'))).toBeNull();
    expect(tabBarFor('/agency/analytics', input('account_admin', { flagsOff: ['agency_reports_enabled'] }))).toBeNull();
    // Do Not Call is one page.
    expect(tabBarFor('/agency/dnc', input('account_admin'))).toBeNull();
  });

  it('groups Missed calls with Summary, and Analytics with Exports (the Reports section)', () => {
    expect(tabBarFor('/agency/inbound/summary', input('account_admin'))?.tabs.map((t) => t.to)).toEqual([
      '/agency/inbound/missed',
      '/agency/inbound/summary',
    ]);
    expect(tabBarFor('/agency/reports', input('viewer'))?.tabs.map((t) => t.label)).toEqual(['Analytics', 'Exports']);
    // The label changed; the URL and the id did not.
    expect(tabBarFor('/agency/reports', input('viewer'))?.tabs.map((t) => [t.id, t.to])).toEqual([
      ['analytics', '/agency/analytics'],
      ['reports', '/agency/reports'],
    ]);
  });

  it('is shown on the grouped pages only, not on one campaign or one report', () => {
    expect(tabBarFor('/agency/campaigns/c-1/overview', input('account_admin'))).toBeNull();
    expect(tabBarFor('/agency/reports/run-1', input('account_admin'))).toBeNull();
    expect(tabBarFor('/agency/campaigns/', input('account_admin'))?.activeId).toBe('campaigns');
  });
});

describe('the active sidebar entry', () => {
  it.each([
    ['/agency/campaigns', 'campaigns'],
    ['/agency/campaigns/new', 'campaigns'],
    ['/agency/campaigns/c-1/agents', 'campaigns'],
    ['/agency/softphone', 'campaigns'],
    ['/agency/softphone/calls/x', 'campaigns'],
    ['/agency/inbound/missed', 'inbound'],
    ['/agency/inbound/summary', 'inbound'],
    ['/agency/analytics', 'reports'],
    ['/agency/reports', 'reports'],
    ['/agency/reports/run-1', 'reports'],
    ['/agency/dnc', 'dnc'],
    ['/settings', 'settings'],
    ['/settings/inbound/r-1', 'settings'],
  ])('%s is %s', (path, id) => {
    expect(activeNavId(path)).toBe(id);
  });

  it('is nothing on customer history or the /agency index, and respects segment boundaries', () => {
    expect(activeNavId('/agency/customers')).toBeNull();
    expect(activeNavId('/agency')).toBeNull();
    expect(activeNavId('/agency/campaignsx')).toBeNull();
    expect(activeNavId('/settingsx')).toBeNull();
  });
});

describe('the breadcrumb', () => {
  it('names the section and the page, linking the section', () => {
    expect(breadcrumbFor('/agency/inbound/summary')).toEqual([
      { label: 'Inbound', to: '/agency/inbound/missed' },
      { label: 'Summary' },
    ]);
    expect(breadcrumbFor('/agency/campaigns/c-1/overview')).toEqual([
      { label: 'Campaigns', to: '/agency/campaigns' },
      { label: 'Campaign' },
    ]);
    expect(breadcrumbFor('/agency/campaigns/new')[1]).toEqual({ label: 'New campaign' });
  });

  it('puts the crumbs a page supplies after its section, in place of the generic one', () => {
    const page = [{ label: 'Q3 Renewals', to: '/agency/campaigns/c-1' }, { label: 'Settings' }];
    expect(breadcrumbFor('/agency/campaigns/c-1/settings', null, page)).toEqual([
      { label: 'Campaigns', to: '/agency/campaigns' },
      ...page,
    ]);
    // A section's own tab page keeps its crumbs, and an empty list changes nothing.
    expect(breadcrumbFor('/agency/campaigns', null, page)).toEqual([{ label: 'Campaigns' }]);
    expect(breadcrumbFor('/agency/campaigns/c-1/overview', null, [])[1]).toEqual({ label: 'Campaign' });
  });

  it('says a page once when it shares the section name', () => {
    expect(breadcrumbFor('/agency/campaigns')).toEqual([{ label: 'Campaigns' }]);
    expect(breadcrumbFor('/agency/dnc')).toEqual([{ label: 'Do Not Call' }]);
  });

  it('names a Settings page under Settings, which is not a link: /settings reopens this page', () => {
    expect(breadcrumbFor('/settings/notifications', 'Email notifications')).toEqual([
      { label: 'Settings' },
      { label: 'Email notifications' },
    ]);
    expect(breadcrumbFor('/settings/inbound')).toEqual([{ label: 'Settings' }, { label: 'Inbound routing' }]);
    expect(breadcrumbFor('/agency/customers')).toEqual([{ label: 'Customer history' }]);
  });

  it('links a page below a Settings entry back to the entry', () => {
    expect(breadcrumbFor('/settings/inbound/r-1')).toEqual([
      { label: 'Settings' },
      { label: 'Inbound routing', to: '/settings/inbound' },
      { label: 'Inbound route' },
    ]);
    expect(breadcrumbFor('/settings/inbound/new').at(-1)).toEqual({ label: 'New inbound route' });
  });

  it('puts a tab between the section and a sub-page when the tab is not the section', () => {
    expect(breadcrumbFor('/agency/reports/run-1')).toEqual([
      { label: 'Reports', to: '/agency/analytics' },
      { label: 'Exports', to: '/agency/reports' },
      { label: 'Report' },
    ]);
    expect(breadcrumbFor('/agency/reports')).toEqual([{ label: 'Reports', to: '/agency/analytics' }, { label: 'Exports' }]);
    expect(breadcrumbFor('/agency/softphone/calls/x')).toEqual([
      { label: 'Campaigns', to: '/agency/campaigns' },
      { label: 'Soft-phone calls', to: '/agency/softphone' },
      { label: 'Soft-phone call' },
    ]);
  });

  it('gives the phone’s back arrow the crumb above the page, when it is a link', () => {
    expect(backCrumb(breadcrumbFor('/agency/reports/run-1'))).toEqual({ label: 'Exports', to: '/agency/reports' });
    expect(backCrumb(breadcrumbFor('/agency/inbound/summary'))).toEqual({ label: 'Inbound', to: '/agency/inbound/missed' });
    const page = [{ label: 'Diwali renewals', to: '/agency/campaigns/c-1/overview' }, { label: 'Settings' }];
    expect(backCrumb(breadcrumbFor('/agency/campaigns/c-1/settings', null, page))).toEqual(page[0]);
    expect(backCrumb(breadcrumbFor('/settings/inbound/r-1'))).toEqual({ label: 'Inbound routing', to: '/settings/inbound' });
    // Nothing above: a section's first page, a Settings entry, customer history.
    expect(backCrumb(breadcrumbFor('/agency/campaigns'))).toBeNull();
    expect(backCrumb(breadcrumbFor('/settings/team'))).toBeNull();
    expect(backCrumb(breadcrumbFor('/agency/customers'))).toBeNull();
  });
});

describe('the Settings hub', () => {
  it('gives an account admin every entry but Accounts, grouped by who it affects', () => {
    const groups = visibleSettingsGroups(input('account_admin'));
    expect(groups.map((g) => [g.scope, g.entries.map((e) => e.label)])).toEqual([
      ['you', ['Profile and appearance', 'Email notifications']],
      ['account', ['Soft phone', 'Inbound routing', 'Call summaries']],
      ['tenant', ['Team']],
    ]);
  });

  it.each(['tenant_admin', 'tenant_owner'] as const)('gives a %s Accounts (account.create)', (role) => {
    expect(settingsIds(input(role))).toContain('accounts');
  });

  it.each(['account_admin', 'operator', 'viewer'] as const)('does not give a %s Accounts', (role) => {
    expect(settingsIds(input(role))).not.toContain('accounts');
  });

  it('gives a viewer their own settings and no admin ones, and hides the empty group', () => {
    const ids = settingsIds(input('viewer'));
    expect(ids).toContain('notifications');
    expect(ids).not.toContain('team');
    expect(ids).not.toContain('inbound');
    expect(visibleSettingsGroups(input('viewer')).map((g) => g.scope)).not.toContain('tenant');
  });

  it('gives everyone Profile first, so /settings always has somewhere to go', () => {
    for (const role of [undefined, 'viewer', 'tenant_owner'] as const) {
      expect(visibleSettingsGroups(input(role))[0]?.entries[0]?.path).toBe('/settings/profile');
    }
    // A dedicated agent too, while `AgentLanding` keeps them in the shell (the dialer off).
    expect(visibleSettingsGroups(input('agent', { flagsOff: ['agency_dialer_enabled'] }))[0]?.entries[0]?.path).toBe('/settings/profile');
  });

  it('offers a dedicated agent no Settings page while the dialer is on: AgentLanding sends them to /dialer', () => {
    expect(visibleSettingsGroups(input('agent'))).toEqual([]);
    expect(passesGate(SETTINGS_GATE, input('agent'))).toBe(false);
    expect(passesGate(SETTINGS_GATE, input('agent', { capsOff: ['agency'] }))).toBe(true);
    for (const role of ['viewer', 'operator', 'account_admin', undefined] as const) {
      expect(passesGate(SETTINGS_GATE, input(role))).toBe(true);
    }
  });

  describe('where /settings opens', () => {
    it('is the entry visited last, while the reader may still open it', () => {
      expect(settingsLandingPath(input('account_admin'), 'inbound')).toBe('/settings/inbound');
      expect(settingsLandingPath(input('account_admin'), 'notifications')).toBe('/settings/notifications');
    });

    it('falls back to Team for someone who manages people, else the first entry', () => {
      expect(settingsLandingPath(input('account_admin'), null)).toBe('/settings/team');
      // Inbound routing's flag went off since the last visit.
      expect(settingsLandingPath(input('account_admin', { flagsOff: ['agency_inbound_enabled'] }), 'inbound')).toBe('/settings/team');
      // Accounts is not a viewer's, nor is Team.
      expect(settingsLandingPath(input('viewer'), 'accounts')).toBe('/settings/profile');
      expect(settingsLandingPath(input('viewer'), 'no-such-page')).toBe('/settings/profile');
    });

    it('is nowhere when the reader may open no entry', () => {
      expect(settingsLandingPath(input('agent'), 'profile')).toBeNull();
    });
  });

  it('gates each account setting on its flag and capability', () => {
    expect(settingsIds(input('account_admin', { flagsOff: ['agency_softphone_enabled'] }))).not.toContain('softphone');
    expect(settingsIds(input('account_admin', { capsOff: ['agency'] }))).not.toContain('softphone');
    expect(settingsIds(input('account_admin', { flagsOff: ['agency_inbound_enabled'] }))).not.toContain('inbound');
    expect(settingsIds(input('account_admin', { capsOff: ['agency'] }))).not.toContain('inbound');
    expect(settingsIds(input('account_admin', { flagsOff: ['agency_call_analysis'] }))).not.toContain('call-summaries');
    expect(settingsIds(input('account_admin', { capsOff: ['agency.analytics'] }))).not.toContain('call-summaries');
    // A gate is per entry, not global.
    expect(settingsIds(input('account_admin', { capsOff: ['agency.analytics'] }))).toContain('team');
  });

  it('finds the entry for a nested path', () => {
    expect(settingsEntryForPath('/settings/inbound/r-1')?.id).toBe('inbound');
    expect(settingsEntryForPath('/settings/inbound/new')?.label).toBe('Inbound routing');
    expect(settingsEntryForPath('/settings')).toBeNull();
  });

  it('says who a setting applies to, by name', () => {
    const names = { accountName: 'Pune Collections', tenantName: 'Acme Finance' };
    expect(appliesTo('you', names)).toBe('only you');
    expect(appliesTo('account', names)).toBe('Pune Collections');
    expect(appliesTo('tenant', names)).toBe('all of Acme Finance');
    expect(appliesTo('tenant', { ...names, tenantWide: true })).toBe('all of Acme Finance');
    expect(settingsGroupTitle('account', names)).toBe('This account · Pune Collections');
    expect(settingsGroupTitle('you', names)).toBe('You');
    expect(settingsGroupTitle('tenant', names)).toBe('People and access');
  });
});

describe('Applies to, for a seat scoped to one account', () => {
  it('says the account for people and access: the server confines that seat to it', () => {
    const names = { accountName: 'Pune Collections', tenantName: 'Acme Finance', tenantWide: false };
    expect(appliesTo('tenant', names)).toBe('Pune Collections');
    expect(appliesTo('tenant', { tenantName: 'Acme Finance', tenantWide: false })).toBe('this account');
    expect(appliesTo('account', names)).toBe('Pune Collections');
    expect(appliesTo('you', names)).toBe('only you');
  });
});

describe('the old /app URLs', () => {
  it.each([
    ['team', '/settings/team'],
    ['accounts', '/settings/accounts'],
    ['notifications', '/settings/notifications'],
    ['call-summaries', '/settings/call-summaries'],
    ['softphone', '/settings/softphone'],
    ['inbound', '/settings/inbound'],
    ['inbound/new', '/settings/inbound/new'],
    ['inbound/3f2a1b0c-1111', '/settings/inbound/3f2a1b0c-1111'],
  ])('/app/%s moves to %s', (rest, target) => {
    expect(legacySettingsPath(rest)).toBe(target);
  });

  it('sends anything that was never a page here to the home decision instead', () => {
    expect(legacySettingsPath('calls/dialer/history/1')).toBeNull();
    expect(legacySettingsPath('dashboard')).toBeNull();
    expect(legacySettingsPath('')).toBeNull();
  });
});

describe('the analytics product', () => {
  it("is 'agency' on the work pages and 'ai' on Settings and /app, as the two old shells sent", () => {
    expect(productSurfaceForPath('/agency/campaigns')).toBe('agency');
    expect(productSurfaceForPath('/agency')).toBe('agency');
    expect(productSurfaceForPath('/settings/team')).toBe('ai');
    expect(productSurfaceForPath('/app')).toBe('ai');
  });
});

describe('Home (B28)', () => {
  it('is gated at agency.supervise, with the dialer on', () => {
    for (const role of ['account_admin', 'tenant_admin', 'tenant_owner'] as const) {
      expect(canSeeHome(input(role))).toBe(true);
    }
    for (const role of ['viewer', 'operator', 'agent', undefined] as const) {
      expect(canSeeHome(input(role))).toBe(false);
    }
    expect(canSeeHome(input('tenant_owner', { capsOff: ['agency'] }))).toBe(false);
    expect(canSeeHome(input('tenant_owner', { flagsOff: ['agency_dialer_enabled'] }))).toBe(false);
  });

  it('is active on its own URL only, has no tab bar, and is its own breadcrumb', () => {
    expect(activeNavId('/agency/home')).toBe('home');
    expect(activeNavId('/agency/home/')).toBe('home');
    expect(activeNavId('/agency')).toBeNull();
    expect(activeNavId('/agency/campaigns')).toBe('campaigns');
    expect(tabBarFor('/agency/home', input('account_admin'))).toBeNull();
    expect(breadcrumbFor('/agency/home')).toEqual([{ label: 'Home' }]);
  });
});

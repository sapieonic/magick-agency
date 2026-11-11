import { describe, expect, it } from 'vitest';
import {
  CONSOLE_SECTIONS,
  activeNavId,
  appliesTo,
  breadcrumbFor,
  legacySettingsPath,
  productSurfaceForPath,
  settingsEntryForPath,
  settingsGroupTitle,
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
  it('offers a supervisor all four, in order, each opening its first page', () => {
    const shown = visibleSections(input('account_admin'));
    expect(shown.map((s) => [s.section.label, s.href])).toEqual([
      ['Campaigns', '/agency/campaigns'],
      ['Inbound', '/agency/inbound/missed'],
      ['Reports', '/agency/analytics'],
      ['Do Not Call', '/agency/dnc'],
    ]);
  });

  it.each(['viewer', 'operator'] as const)('offers a %s the same four (read floors)', (role) => {
    expect(sectionIds(input(role))).toEqual(['campaigns', 'inbound', 'reports', 'dnc']);
  });

  it('offers an agent nothing, which is why an agent is never routed into the shell', () => {
    expect(sectionIds(input('agent'))).toEqual([]);
  });

  it('offers nothing while the role is unresolved', () => {
    expect(sectionIds(input(undefined))).toEqual([]);
  });

  it('offers nothing without the dialer: the agency capability or its flag', () => {
    expect(sectionIds(input('tenant_owner', { capsOff: ['agency'] }))).toEqual([]);
    expect(sectionIds(input('tenant_owner', { flagsOff: ['agency_dialer_enabled'] }))).toEqual([]);
  });

  it('drops Inbound when the missed-calls rule says there is nothing to read', () => {
    expect(sectionIds(input('account_admin', { missed: false }))).toEqual(['campaigns', 'reports', 'dnc']);
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

  it('groups Missed calls with Summary, and Analytics with Reports', () => {
    expect(tabBarFor('/agency/inbound/summary', input('account_admin'))?.tabs.map((t) => t.to)).toEqual([
      '/agency/inbound/missed',
      '/agency/inbound/summary',
    ]);
    expect(tabBarFor('/agency/reports', input('viewer'))?.tabs.map((t) => t.label)).toEqual(['Analytics', 'Reports']);
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

  it('says a page once when it shares the section name', () => {
    expect(breadcrumbFor('/agency/campaigns')).toEqual([{ label: 'Campaigns' }]);
    expect(breadcrumbFor('/agency/dnc')).toEqual([{ label: 'Do Not Call' }]);
  });

  it('names a Settings page under Settings', () => {
    expect(breadcrumbFor('/settings/notifications', 'Email notifications')).toEqual([
      { label: 'Settings', to: '/settings' },
      { label: 'Email notifications' },
    ]);
    expect(breadcrumbFor('/agency/customers')).toEqual([{ label: 'Customer history' }]);
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
    for (const role of [undefined, 'agent', 'viewer', 'tenant_owner'] as const) {
      expect(visibleSettingsGroups(input(role))[0]?.entries[0]?.path).toBe('/settings/profile');
    }
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
    expect(settingsGroupTitle('account', names)).toBe('This account · Pune Collections');
    expect(settingsGroupTitle('you', names)).toBe('You');
    expect(settingsGroupTitle('tenant', names)).toBe('People and access');
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

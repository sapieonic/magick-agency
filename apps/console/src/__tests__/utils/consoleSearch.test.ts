import { describe, it, expect } from 'vitest';
import { CONSOLE_SECTIONS, SETTINGS_ENTRIES, type GateInput } from '../../utils/consoleNav';
import {
  CAMPAIGN_TAB_KEYWORDS,
  SETTINGS_SEARCH,
  campaignPageResults,
  campaignResults,
  campaignSettingsResults,
  canSearchCampaigns,
  canSearchNumbers,
  looksLikePhoneNumber,
  matchSettingsEntry,
  numberQuery,
  pageResults,
  searchConsole,
  searchPages,
  searchPlaceholder,
  searchShortcutLabel,
  searchTokens,
  searchableCampaignSections,
  settingsEntryMatches,
  settingsResults,
  type CampaignSettingsSection,
  type SearchInput,
} from '../../utils/consoleSearch';
import { CAMPAIGN_TABS } from '../../utils/agencyCampaignTabs';
import type { Role } from '../../types/auth';

/**
 * What ⌘K finds (B28): every group offered under its destination's gate, the Settings words
 * people type, a phone number read by the search box's own rule, campaigns from the account's
 * list, and campaign settings sections (wired in later; tested here with a local fixture).
 */

const ALL_ON = (role: Role | undefined, extra: Partial<GateInput> = {}): GateInput => ({
  role,
  isFlagEnabled: () => true,
  isCapabilityEnabled: () => true,
  missedAvailable: true,
  ...extra,
});

const titles = (rs: { title: string }[]) => rs.map((r) => r.title);

describe('the pages', () => {
  it('are the sidebar’s tabs, read from consoleNav, plus New campaign and Archived campaigns', () => {
    const tos = searchPages().map((p) => p.to);
    for (const section of CONSOLE_SECTIONS) for (const tab of section.tabs) expect(tos).toContain(tab.to);
    expect(tos).toContain('/agency/campaigns/new');
    expect(searchPages().map((p) => p.title)).toEqual([
      'Live floor',
      'Campaigns',
      'New campaign',
      'Archived campaigns',
      'All calls',
      'Live calls',
      'Listening history',
      'Callbacks',
      'Missed calls',
      'Inbound summary',
      'Analytics',
      'Compare agents',
      'Exports',
      'Do Not Call',
      'Take calls',
      'Customer history',
    ]);
  });

  it('offers a supervisor every page with everything on', () => {
    expect(titles(pageResults([], ALL_ON('account_admin')))).toHaveLength(15);
  });

  it('finds Compare agents for a supervisor with its flag on, and never for a viewer or with it off', () => {
    const keys = (q: string, gate: GateInput) => pageResults(searchTokens(q), gate).map((r) => r.key);
    for (const q of ['compare', 'compare agents', 'side by side', 'coaching']) {
      expect(keys(q, ALL_ON('account_admin')), q).toContain('page:reports:compare');
    }
    expect(keys('compare', ALL_ON('viewer'))).not.toContain('page:reports:compare');
    expect(keys('compare', ALL_ON('account_admin', { isFlagEnabled: (f) => f !== 'agency_compare_enabled' }))).not.toContain('page:reports:compare');
  });

  it('finds Live floor by its old name, and Callbacks however people spell it (LF1)', () => {
    const first = (q: string) => pageResults(searchTokens(q), ALL_ON('account_admin'))[0]?.key;
    expect(first('home')).toBe('page:home:home');
    expect(first('live floor')).toBe('page:home:home');
    for (const q of ['callbacks', 'call-backs', 'call backs', 'follow-ups']) {
      expect(pageResults(searchTokens(q), ALL_ON('account_admin')).map((r) => r.key), q).toContain('page:callbacks:callbacks');
    }
    // Gated as its route: a viewer is not offered it.
    expect(pageResults(searchTokens('callbacks'), ALL_ON('viewer')).map((r) => r.key)).not.toContain('page:callbacks:callbacks');
  });

  it('offers nothing under /agency without the dialer flag or the agency capability', () => {
    expect(pageResults([], ALL_ON('tenant_owner', { isFlagEnabled: (f) => f !== 'agency_dialer_enabled' }))).toEqual([]);
    expect(pageResults([], ALL_ON('tenant_owner', { isCapabilityEnabled: () => false }))).toEqual([]);
  });

  it('gates each page as its tab: a viewer reads campaigns, analytics, reports, DNC and missed calls only', () => {
    expect(titles(pageResults([], ALL_ON('viewer')))).toEqual(['Campaigns', 'Archived campaigns', 'Missed calls', 'Analytics', 'Exports', 'Do Not Call', 'Take calls', 'Customer history']);
  });

  it('keeps All calls whatever the soft phone’s flag, and hides Reports without its flag and Inbound without the missed rule', () => {
    const off = (flag: string) => ALL_ON('account_admin', { isFlagEnabled: (f) => f !== flag });
    // All calls holds the dialler's calls too (CL34): no call type's flag hides it. It floors at agency.supervise.
    expect(titles(pageResults([], off('agency_softphone_enabled')))).toContain('All calls');
    expect(titles(pageResults([], ALL_ON('viewer')))).not.toContain('All calls');
    expect(titles(pageResults([], off('agency_reports_enabled')))).not.toContain('Exports');
    const noMissed = titles(pageResults([], ALL_ON('account_admin', { missedAvailable: false })));
    expect(noMissed).not.toContain('Missed calls');
    expect(noMissed).not.toContain('Inbound summary');
  });

  it('offers Live calls to a supervisor with the listening flag on, found by "listen" and "live"', () => {
    const off = ALL_ON('account_admin', { isFlagEnabled: (f) => f !== 'agency_live_listen_enabled' });
    expect(titles(pageResults([], off))).not.toContain('Live calls');
    expect(titles(pageResults([], ALL_ON('viewer')))).not.toContain('Live calls');
    for (const q of ['listen', 'live', 'in progress', 'monitor']) {
      expect(titles(pageResults(searchTokens(q), ALL_ON('account_admin'))), q).toContain('Live calls');
    }
    const live = pageResults(searchTokens('live calls'), ALL_ON('account_admin')).find((r) => r.title === 'Live calls');
    expect(live?.target).toEqual({ type: 'path', to: '/agency/live' });
    expect(live?.detail).toBe('Campaigns');
  });

  it('offers the Listening history to a supervisor whether listening is on or off, found by "listened" and "monitoring"', () => {
    // LS19, amended 2026-11-17: turning listening off does not hide past listens.
    const off = ALL_ON('account_admin', { isFlagEnabled: (f) => f !== 'agency_live_listen_enabled' });
    expect(titles(pageResults([], off))).toContain('Listening history');
    expect(titles(pageResults([], ALL_ON('viewer')))).not.toContain('Listening history');
    for (const q of ['listening history', 'who listened', 'listened', 'monitoring log']) {
      expect(titles(pageResults(searchTokens(q), ALL_ON('account_admin'))), q).toContain('Listening history');
    }
    const history = pageResults(searchTokens('listening history'), ALL_ON('account_admin')).find((r) => r.title === 'Listening history');
    expect(history?.target).toEqual({ type: 'path', to: '/agency/listening-history' });
  });

  it('finds Archived campaigns by "archive" and "restore", for whoever reads campaigns (AR1–AR7)', () => {
    for (const q of ['archived', 'archive', 'restore campaign', 'old campaigns']) {
      const hit = pageResults(searchTokens(q), ALL_ON('viewer')).find((r) => r.title === 'Archived campaigns');
      expect(hit?.target, q).toEqual({ type: 'path', to: '/agency/campaigns/archived' });
    }
  });

  it('offers New campaign only with agency.campaigns.write', () => {
    expect(titles(pageResults(searchTokens('new campaign'), ALL_ON('account_admin')))).toContain('New campaign');
    expect(titles(pageResults(searchTokens('new campaign'), ALL_ON('operator')))).not.toContain('New campaign');
  });

  it('finds pages by their section and their words', () => {
    expect(titles(pageResults(searchTokens('inbound'), ALL_ON('account_admin')))).toEqual(['Missed calls', 'Inbound summary']);
    expect(titles(pageResults(searchTokens('pdf'), ALL_ON('account_admin')))).toEqual(['Exports']);
    // "Soft-phone calls" until it became All calls: the old name still finds it.
    expect(titles(pageResults(searchTokens('soft-phone'), ALL_ON('account_admin')))).toContain('All calls');
    expect(titles(pageResults(searchTokens('soft-phone calls'), ALL_ON('account_admin')))).toContain('All calls');
    expect(titles(pageResults(searchTokens('no campaign'), ALL_ON('account_admin')))).toEqual(['All calls']);
  });

  it('finds the agent’s work by its name, My work, and by its old name, My campaigns', () => {
    for (const q of ['my work', 'my campaigns']) {
      expect(titles(pageResults(searchTokens(q), ALL_ON('agent'))), q).toContain('Take calls');
    }
  });

  it('still finds a renamed page by its old name: Exports was Reports', () => {
    for (const q of ['reports', 'report', 'export']) {
      expect(titles(pageResults(searchTokens(q), ALL_ON('viewer'))), q).toContain('Exports');
    }
  });

  it('offers Customer history to whoever may search a number, found by "history"', () => {
    expect(titles(pageResults(searchTokens('history'), ALL_ON('agent')))).toEqual(['Customer history']);
    expect(titles(pageResults(searchTokens('history'), ALL_ON('agent', { isFlagEnabled: () => false })))).toEqual([]);
  });
});

describe('the settings', () => {
  it('have search words for every Settings hub entry, and for nothing else', () => {
    expect(Object.keys(SETTINGS_SEARCH).sort()).toEqual(SETTINGS_ENTRIES.map((e) => e.id).sort());
  });

  /** The words people type, and the Settings page each must land on. */
  const CASES: [string, string, string?][] = [
    ['default caller ID', 'softphone', 'Default caller ID for soft-phone calls'],
    ['caller', 'softphone', 'Default caller ID for soft-phone calls'],
    ['soft phone caller', 'softphone', 'Default caller ID for soft-phone calls'],
    ['routing', 'inbound', 'Inbound routing'],
    ['IVR', 'inbound', 'Inbound routing'],
    ['hours', 'inbound', 'Opening hours and holidays'],
    ['holiday', 'inbound', 'Opening hours and holidays'],
    ['greeting', 'inbound', 'What callers hear'],
    ['email', 'notifications', 'Email notifications'],
    ['unsubscribe', 'notifications', 'Email notifications'],
    ['invite', 'team', 'Team'],
    ['member', 'team'],
    ['role', 'team'],
    ['theme', 'profile', 'Theme'],
    ['dark mode', 'profile', 'Theme'],
    ['profile', 'profile', 'Profile and appearance'],
    ['call summaries', 'call-summaries', 'Call summaries'],
    ['listening', 'listening', 'Live call listening'],
    ['listen in', 'listening', 'Live call listening'],
    ['monitoring', 'listening', 'Live call listening'],
    ['unrecorded calls', 'listening', 'Calls that are not recorded'],
    ['new account', 'accounts', 'Accounts'],
  ];

  it.each(CASES)('“%s” finds %s', (query, id, title) => {
    const results = settingsResults(searchTokens(query), ALL_ON('tenant_owner'));
    const hit = results.find((r) => r.key === `setting:${id}`);
    expect(hit, `${query} → ${id}`).toBeTruthy();
    if (title) expect(hit!.title).toBe(title);
  });

  it('offers no digest words: the page lists two emails, each sent as it happens', () => {
    for (const q of ['digest', 'daily', 'weekly', 'summary emails']) {
      expect(settingsResults(searchTokens(q), ALL_ON('tenant_owner')).map((r) => r.key), q).not.toContain('setting:notifications');
    }
  });

  it('names where a matched setting lives', () => {
    const entry = SETTINGS_ENTRIES.find((e) => e.id === 'softphone')!;
    expect(matchSettingsEntry(entry, searchTokens('caller'))).toMatchObject({
      title: 'Default caller ID for soft-phone calls',
      detail: 'Settings › This account › Soft phone',
    });
    expect(matchSettingsEntry(entry, searchTokens('soft phone'))).toMatchObject({
      title: 'Soft phone',
      detail: 'Settings › This account',
    });
  });

  it('finds campaign templates by the words people use for them: default outcomes, calling hours (L21)', () => {
    for (const words of ['default outcomes', 'default dispositions', 'outcome defaults', 'calling hours defaults', 'default calling hours']) {
      expect(settingsResults(searchTokens(words), ALL_ON('account_admin')).map((r) => r.key), words).toContain('setting:campaign-templates');
    }
  });

  it('does not send "sign out" to Profile and appearance, which has no sign-out', () => {
    expect(settingsResults(searchTokens('sign out'), ALL_ON('tenant_owner'))).toEqual([]);
  });

  it('gates each entry as the hub does', () => {
    const viewer = settingsResults([], ALL_ON('viewer')).map((r) => r.key);
    expect(viewer).toEqual(['setting:profile', 'setting:notifications', 'setting:softphone', 'setting:call-summaries']);
    // An owner on an organisation-wide seat may open every entry, organisation templates included.
    expect(settingsResults([], ALL_ON('tenant_owner', { organisationRole: 'tenant_owner' })).map((r) => r.key))
      .toEqual(SETTINGS_ENTRIES.map((e) => `setting:${e.id}`));
    // Without an organisation-wide seat, the organisation's templates are not offered (CT3).
    expect(settingsResults([], ALL_ON('tenant_owner')).map((r) => r.key)).not.toContain('setting:organisation-campaign-templates');
    const noSoftphoneFlag = ALL_ON('account_admin', { isFlagEnabled: (f) => f !== 'agency_softphone_enabled' });
    expect(settingsResults(searchTokens('caller'), noSoftphoneFlag).map((r) => r.key)).not.toContain('setting:softphone');
  });

  it('offers a dedicated agent no Settings page while the dialer is on (AgentLanding sends them to /dialer)', () => {
    expect(settingsResults([], ALL_ON('agent'))).toEqual([]);
    expect(settingsResults(searchTokens('soft phone'), ALL_ON('agent'))).toEqual([]);
    // With the dialer off they stay in the shell, so Settings is theirs.
    const dialerOff = ALL_ON('agent', { isFlagEnabled: (f) => f !== 'agency_dialer_enabled' });
    expect(settingsResults([], dialerOff).map((r) => r.key)).toContain('setting:profile');
  });

  it('feeds the sub-nav filter the same words', () => {
    const inbound = SETTINGS_ENTRIES.find((e) => e.id === 'inbound')!;
    expect(settingsEntryMatches(inbound, 'IVR')).toBe(true);
    expect(settingsEntryMatches(inbound, 'theme')).toBe(false);
    expect(settingsEntryMatches(inbound, '')).toBe(true);
  });
});

describe('a phone number', () => {
  it.each(['98765 43210', '+91 98765 43210', '098765-43210', '(987) 654 3210'])('reads “%s” as a number', (q) => {
    expect(looksLikePhoneNumber(q)).toBe(true);
  });

  it.each(['team', 'q4 2026 renewals', '12', '', 'caller id'])('does not read “%s” as a number', (q) => {
    expect(looksLikePhoneNumber(q)).toBe(false);
  });

  it('offers "Calls to" the number, in the format the box previews it, with the raw text to search', () => {
    const answer = numberQuery('98765 43210', '+91');
    expect(answer.kind).toBe('number');
    if (answer.kind !== 'number') return;
    expect(answer.result.title).toBe('Calls to +91 98765 43210');
    expect(answer.result.target).toEqual({ type: 'number', raw: '98765 43210', countryIso: 'IN', formatted: '+91 98765 43210' });
  });

  it('reads another country’s number by its + code', () => {
    const answer = numberQuery('+44 20 7946 0018', '+91');
    expect(answer.kind === 'number' && answer.result.title).toBe('Calls to +44 20 7946 0018');
  });

  it('says what is wrong with a number the rule refuses, in the rule’s words (CH4)', () => {
    expect(numberQuery('43210', '+91')).toEqual({
      kind: 'refused',
      message: "Enter the full number. Searching by the last few digits isn't supported.",
    });
  });

  it('is offered only with agency.customer_history.read, an account and the dialer', () => {
    expect(canSearchNumbers(ALL_ON('agent'), 'a-1')).toBe(true);
    expect(canSearchNumbers(ALL_ON(undefined), 'a-1')).toBe(false);
    expect(canSearchNumbers(ALL_ON('agent'), null)).toBe(false);
    expect(canSearchNumbers(ALL_ON('agent', { isFlagEnabled: () => false }), 'a-1')).toBe(false);
    expect(canSearchNumbers(ALL_ON('agent', { isCapabilityEnabled: () => false }), 'a-1')).toBe(false);
  });
});

describe('campaigns', () => {
  const CAMPAIGNS = [
    { id: 'c-1', name: 'Diwali renewals' },
    { id: 'c-2', name: 'Q4 collections' },
    { id: 'c-3', name: 'Card activation follow-up' },
  ];

  it('are matched by every word of the name, each with its Settings when allowed', () => {
    expect(campaignResults(CAMPAIGNS, searchTokens('diwali'), true).map((r) => [r.title, r.target])).toEqual([
      ['Diwali renewals', { type: 'path', to: '/agency/campaigns/c-1' }],
      ['Diwali renewals › Settings', { type: 'path', to: '/agency/campaigns/c-1/settings' }],
    ]);
    expect(titles(campaignResults(CAMPAIGNS, searchTokens('follow up'), false))).toEqual(['Card activation follow-up']);
    expect(campaignResults(CAMPAIGNS, [], true)).toEqual([]);
  });

  it('are read only for the Campaigns page’s readers, in an account', () => {
    expect(canSearchCampaigns(ALL_ON('viewer'), 'a-1')).toBe(true);
    expect(canSearchCampaigns(ALL_ON('agent'), 'a-1')).toBe(false);
    expect(canSearchCampaigns(ALL_ON('viewer'), null)).toBe(false);
    expect(canSearchCampaigns(ALL_ON('viewer', { isFlagEnabled: () => false }), 'a-1')).toBe(false);
  });

  /** A stand-in for `CAMPAIGN_SETTINGS_SECTIONS` until it lands. */
  const SECTIONS: CampaignSettingsSection[] = [
    { id: 'caller-ids', label: 'Caller IDs', keywords: ['caller id', 'cli', 'number'] },
    { id: 'calling-hours', label: 'Calling hours', keywords: ['hours', 'schedule', 'time'] },
  ];

  it('offer a settings section in each campaign, linked to its anchor', () => {
    const rs = campaignSettingsResults(CAMPAIGNS, SECTIONS, 'caller');
    expect(rs.map((r) => [r.title, r.detail, r.target])).toEqual([
      ['Caller IDs', 'Diwali renewals › Settings', { type: 'path', to: '/agency/campaigns/c-1/settings#caller-ids' }],
      ['Caller IDs', 'Q4 collections › Settings', { type: 'path', to: '/agency/campaigns/c-2/settings#caller-ids' }],
      ['Caller IDs', 'Card activation follow-up › Settings', { type: 'path', to: '/agency/campaigns/c-3/settings#caller-ids' }],
    ]);
  });

  it('narrow a section to the campaign the query names', () => {
    expect(campaignSettingsResults(CAMPAIGNS, SECTIONS, 'diwali hours').map((r) => r.key)).toEqual([
      'campaign-section:c-1:calling-hours',
    ]);
    // A campaign name alone is a campaign, not every section of it.
    expect(campaignSettingsResults(CAMPAIGNS, SECTIONS, 'diwali')).toEqual([]);
    expect(campaignSettingsResults(CAMPAIGNS, [], 'caller')).toEqual([]);
  });
});

describe('a campaign’s own pages', () => {
  const CAMPAIGNS = [
    { id: 'c-1', name: 'Diwali renewals' },
    { id: 'c-2', name: 'Q4 collections' },
  ];
  const supervisor = ALL_ON('account_admin');

  it('have words for every campaign screen', () => {
    expect(Object.keys(CAMPAIGN_TAB_KEYWORDS).sort()).toEqual(CAMPAIGN_TABS.map((t) => t.id).sort());
  });

  it.each([
    ['call log', 'Call log'],
    ['call attempts', 'Call log'],
    ['attempts', 'Call log'],
    // The page, its breadcrumb and the header's button say History; "activity" was its old name.
    ['activity', 'History'],
    ['history', 'History'],
    ['roster', 'Contacts'],
    ['callbacks', 'Callbacks'],
  ])('“%s” finds each campaign’s %s', (query, label) => {
    const rs = campaignPageResults(CAMPAIGNS, query, supervisor);
    expect(rs.map((r) => r.title)).toEqual([`Diwali renewals › ${label}`, `Q4 collections › ${label}`]);
  });

  it('narrow to the campaign the query names, linking the screen’s own URL', () => {
    expect(campaignPageResults(CAMPAIGNS, 'diwali history', supervisor).map((r) => [r.title, r.target])).toEqual([
      ['Diwali renewals › History', { type: 'path', to: '/agency/campaigns/c-1/activity' }],
    ]);
    expect(campaignPageResults(CAMPAIGNS, 'q4 call log', supervisor).map((r) => r.target)).toEqual([
      { type: 'path', to: '/agency/campaigns/c-2/attempts' },
    ]);
    // A campaign's name alone is the campaign, not every screen of it.
    expect(campaignPageResults(CAMPAIGNS, 'diwali', supervisor)).toEqual([]);
  });

  it('are gated as their tabs: a viewer opens Agents only', () => {
    expect(campaignPageResults(CAMPAIGNS, 'diwali call log', ALL_ON('viewer'))).toEqual([]);
    expect(campaignPageResults(CAMPAIGNS, 'diwali agents', ALL_ON('viewer')).map((r) => r.title)).toEqual(['Diwali renewals › Agents']);
    const noSoftphone = ALL_ON('account_admin', { isFlagEnabled: (f) => f !== 'agency_softphone_enabled' });
    expect(campaignPageResults(CAMPAIGNS, 'diwali manual calls', noSoftphone)).toEqual([]);
    expect(campaignPageResults(CAMPAIGNS, 'diwali manual calls', supervisor).map((r) => r.title)).toEqual(['Diwali renewals › Soft-phone calls']);
    // The Calls tab's Live view: a supervisor, with the listening flag on.
    const noListen = ALL_ON('account_admin', { isFlagEnabled: (f) => f !== 'agency_live_listen_enabled' });
    expect(campaignPageResults(CAMPAIGNS, 'diwali listen', noListen)).toEqual([]);
    expect(campaignPageResults(CAMPAIGNS, 'diwali listen', supervisor).map((r) => [r.title, r.target])).toEqual([
      ['Diwali renewals › Live calls', { type: 'path', to: '/agency/campaigns/c-1/calls/live' }],
    ]);
  });
});

describe('the campaign Settings sections search links to', () => {
  const ids = (gate: GateInput) => searchableCampaignSections(gate).map((s) => s.id);

  it('offer Agents whatever the flags: every campaign’s page has it, for its break limits (LF27)', () => {
    const off = ALL_ON('account_admin', {
      isFlagEnabled: (f) => f !== 'agency_contact_assignment_enabled' && f !== 'agency_inbound_enabled',
    });
    expect(ids(off)).toContain('agents');
    expect(ids(ALL_ON('account_admin'))).toContain('agents');
  });

  it('are offered by searchConsole as the page has them: a break limit finds Agents with the flags off', () => {
    const off = ALL_ON('account_admin', {
      isFlagEnabled: (f) => f !== 'agency_contact_assignment_enabled' && f !== 'agency_inbound_enabled',
    });
    const input: SearchInput = { query: 'diwali break limit', gate: off, accountId: 'a-1', defaultCallingCode: '+91', campaigns: [{ id: 'c-1', name: 'Diwali renewals' }] };
    expect(searchConsole(input).groups.flatMap((g) => g.results).map((r) => r.key)).toContain('campaign-section:c-1:agents');
    // Lifecycle and uploads stays a supervisor's: below it, search does not link to it.
    const agent = ALL_ON('agent');
    expect(ids(agent)).not.toContain('roster-uploads');
  });

  it('links a setting the tabs moved to the section on the tab that has it now (CS16)', () => {
    const keys = (query: string) => searchConsole({
      query, gate: ALL_ON('account_admin'), accountId: 'a-1', defaultCallingCode: '+91', campaigns: [{ id: 'c-1', name: 'Diwali renewals' }],
    }).groups.flatMap((g) => g.results).map((r) => r.key).filter((key) => key.startsWith('campaign-section:'));
    // The daily target left the customer card's section for Agents & timing's agent screen.
    expect(keys('diwali daily target')).toEqual(['campaign-section:c-1:recording']);
    expect(keys('diwali customer card')).toEqual(['campaign-section:c-1:agent-screen']);
    expect(keys('diwali wrap-up')).toEqual(['campaign-section:c-1:recording']);
  });
});

describe('everything together', () => {
  const base: SearchInput = {
    query: '',
    gate: ALL_ON('account_admin'),
    accountId: 'a-1',
    defaultCallingCode: '+91',
    campaigns: [{ id: 'c-1', name: 'Diwali renewals' }],
  };
  const groups = (input: Partial<SearchInput>) => searchConsole({ ...base, ...input }).groups.map((g) => g.id);

  it('puts a number first', () => {
    expect(groups({ query: '98765 43210' })[0]).toBe('number');
  });

  it('shows pages and settings for an empty query, and campaigns only once something is typed', () => {
    expect(groups({})).toEqual(['pages', 'settings']);
    expect(groups({ query: 'diwali' })).toEqual(['campaigns']);
    expect(groups({ query: 'caller' })).toEqual(['settings', 'campaign-settings']);
  });

  it('sends “notifications” and “alerts” to Home first, then the email setting', () => {
    for (const query of ['notifications', 'alerts', 'needs attention', 'what needs me']) {
      const results = searchConsole({ ...base, query }).groups.flatMap((g) => g.results);
      expect(results[0]?.key, query).toBe('page:home:home');
    }
    for (const query of ['notifications', 'alert']) {
      const keys = searchConsole({ ...base, query }).groups.flatMap((g) => g.results).map((r) => r.key);
      expect(keys.indexOf('page:home:home'), query).toBe(0);
      expect(keys, query).toContain('setting:notifications');
    }
  });

  it('lists recent campaigns under the pages while nothing is typed, as the account has them now', () => {
    const recentCampaigns = [
      { id: 'c-1', name: 'Diwali (old name)' },
      { id: 'c-gone', name: 'Deleted since' },
    ];
    expect(groups({ recentCampaigns })).toEqual(['pages', 'recent-campaigns', 'settings']);
    const recent = searchConsole({ ...base, recentCampaigns }).groups.find((g) => g.id === 'recent-campaigns')!;
    expect(recent.title).toBe('Recent campaigns');
    expect(recent.results.map((r) => [r.title, r.target])).toEqual([
      ['Diwali renewals', { type: 'path', to: '/agency/campaigns/c-1' }],
    ]);
    // Until the list is read, as remembered.
    const unread = searchConsole({ ...base, campaigns: null, recentCampaigns }).groups.find((g) => g.id === 'recent-campaigns')!;
    expect(unread.results.map((r) => r.title)).toEqual(['Diwali (old name)', 'Deleted since']);
    // Not once something is typed, nor for a reader who may not read campaigns.
    expect(groups({ recentCampaigns, query: 'diwali' })).not.toContain('recent-campaigns');
    expect(groups({ recentCampaigns, gate: ALL_ON('agent') })).not.toContain('recent-campaigns');
  });

  it('never shows campaigns to a reader who may not read them, whatever list it is given', () => {
    expect(groups({ query: 'diwali', gate: ALL_ON('agent') })).toEqual([]);
  });

  it('leaves campaign settings out below the Settings tab’s gate (agency.supervise)', () => {
    const answer = searchConsole({ ...base, query: 'diwali', gate: ALL_ON('viewer') });
    expect(answer.groups.flatMap((g) => g.results).map((r) => r.title)).toEqual(['Diwali renewals']);
    expect(groups({ query: 'caller', gate: ALL_ON('viewer') })).not.toContain('campaign-settings');
  });

  it('puts a campaign’s pages after the campaigns and before its settings sections', () => {
    expect(groups({ query: 'diwali agents' })).toEqual(['campaign-pages', 'campaign-settings']);
    expect(groups({ query: 'call log' })).toEqual(['campaign-pages']);
  });

  it('never shows "› Settings" twice for one campaign', () => {
    const answer = searchConsole({ ...base, query: 'settings', campaigns: [{ id: 'c-9', name: 'Settings test' }] });
    const keys = answer.groups.flatMap((g) => g.results).map((r) => r.key);
    expect(keys.filter((k) => k === 'campaign:c-9:settings')).toHaveLength(1);
  });

  it('drops the number refusal when the digits are something else’s name, such as a campaign called 2026', () => {
    const only = searchConsole({ ...base, query: '2026', campaigns: [] });
    expect(only.numberNote).toMatch(/Enter the full number/);
    const named = searchConsole({ ...base, query: '2026', campaigns: [{ id: 'c-7', name: '2026' }] });
    expect(named.numberNote).toBeNull();
    expect(named.groups.flatMap((g) => g.results).map((r) => r.title)).toContain('2026');
  });

  it('gives no number result, and no note, to a reader who may not search numbers', () => {
    const answer = searchConsole({ ...base, query: '43210', gate: ALL_ON(undefined) });
    expect(answer.numberNote).toBeNull();
    expect(searchConsole({ ...base, query: '98765 43210', gate: ALL_ON(undefined) }).groups).toEqual([]);
  });
});

describe('the field’s words', () => {
  it('say only what the reader can search', () => {
    expect(searchPlaceholder(true, true)).toBe('Search pages, campaigns, settings or a number');
    expect(searchPlaceholder(true, false)).toBe('Search pages, settings or a number');
    expect(searchPlaceholder(false, true)).toBe('Search pages, campaigns or settings');
    expect(searchPlaceholder(false, false)).toBe('Search pages and settings');
  });

  it('name the shortcut as the keyboard does', () => {
    expect(searchShortcutLabel('MacIntel')).toBe('⌘K');
    expect(searchShortcutLabel('Win32')).toBe('Ctrl K');
  });
});

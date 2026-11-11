import { describe, it, expect } from 'vitest';
import { CONSOLE_SECTIONS, SETTINGS_ENTRIES, type GateInput } from '../../utils/consoleNav';
import {
  SETTINGS_SEARCH,
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
  settingsEntryMatches,
  settingsResults,
  type CampaignSettingsSection,
  type SearchInput,
} from '../../utils/consoleSearch';
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
  it('are the sidebar’s tabs, read from consoleNav, plus New campaign', () => {
    const tos = searchPages().map((p) => p.to);
    for (const section of CONSOLE_SECTIONS) for (const tab of section.tabs) expect(tos).toContain(tab.to);
    expect(tos).toContain('/agency/campaigns/new');
    expect(searchPages().map((p) => p.title)).toEqual([
      'Home',
      'Campaigns',
      'New campaign',
      'Soft-phone calls',
      'Missed calls',
      'Inbound summary',
      'Analytics',
      'Reports',
      'Do Not Call',
    ]);
  });

  it('offers a supervisor every page with everything on', () => {
    expect(titles(pageResults([], ALL_ON('account_admin')))).toHaveLength(9);
  });

  it('offers nothing under /agency without the dialer flag or the agency capability', () => {
    expect(pageResults([], ALL_ON('tenant_owner', { isFlagEnabled: (f) => f !== 'agency_dialer_enabled' }))).toEqual([]);
    expect(pageResults([], ALL_ON('tenant_owner', { isCapabilityEnabled: () => false }))).toEqual([]);
  });

  it('gates each page as its tab: a viewer reads campaigns, analytics, reports, DNC and missed calls only', () => {
    expect(titles(pageResults([], ALL_ON('viewer')))).toEqual(['Campaigns', 'Missed calls', 'Analytics', 'Reports', 'Do Not Call']);
  });

  it('hides Soft-phone calls without its flag, Reports without its flag, and Inbound without the missed rule', () => {
    const off = (flag: string) => ALL_ON('account_admin', { isFlagEnabled: (f) => f !== flag });
    expect(titles(pageResults([], off('agency_softphone_enabled')))).not.toContain('Soft-phone calls');
    expect(titles(pageResults([], off('agency_reports_enabled')))).not.toContain('Reports');
    const noMissed = titles(pageResults([], ALL_ON('account_admin', { missedAvailable: false })));
    expect(noMissed).not.toContain('Missed calls');
    expect(noMissed).not.toContain('Inbound summary');
  });

  it('offers New campaign only with agency.campaigns.write', () => {
    expect(titles(pageResults(searchTokens('new campaign'), ALL_ON('account_admin')))).toContain('New campaign');
    expect(titles(pageResults(searchTokens('new campaign'), ALL_ON('operator')))).not.toContain('New campaign');
  });

  it('finds pages by their section and their words', () => {
    expect(titles(pageResults(searchTokens('inbound'), ALL_ON('account_admin')))).toEqual(['Missed calls', 'Inbound summary']);
    expect(titles(pageResults(searchTokens('pdf'), ALL_ON('account_admin')))).toEqual(['Reports']);
    expect(titles(pageResults(searchTokens('soft-phone'), ALL_ON('account_admin')))).toContain('Soft-phone calls');
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
    ['digest', 'notifications'],
    ['invite', 'team', 'Team'],
    ['member', 'team'],
    ['role', 'team'],
    ['theme', 'profile', 'Theme'],
    ['dark mode', 'profile', 'Theme'],
    ['profile', 'profile', 'Profile and appearance'],
    ['call summaries', 'call-summaries', 'Call summaries'],
    ['new account', 'accounts', 'Accounts'],
  ];

  it.each(CASES)('“%s” finds %s', (query, id, title) => {
    const results = settingsResults(searchTokens(query), ALL_ON('tenant_owner'));
    const hit = results.find((r) => r.key === `setting:${id}`);
    expect(hit, `${query} → ${id}`).toBeTruthy();
    if (title) expect(hit!.title).toBe(title);
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

  it('does not send "sign out" to Profile and appearance, which has no sign-out', () => {
    expect(settingsResults(searchTokens('sign out'), ALL_ON('tenant_owner'))).toEqual([]);
  });

  it('gates each entry as the hub does', () => {
    const viewer = settingsResults([], ALL_ON('viewer')).map((r) => r.key);
    expect(viewer).toEqual(['setting:profile', 'setting:notifications', 'setting:softphone', 'setting:call-summaries']);
    expect(settingsResults([], ALL_ON('tenant_owner')).map((r) => r.key)).toEqual(SETTINGS_ENTRIES.map((e) => `setting:${e.id}`));
    const noSoftphoneFlag = ALL_ON('account_admin', { isFlagEnabled: (f) => f !== 'agency_softphone_enabled' });
    expect(settingsResults(searchTokens('caller'), noSoftphoneFlag).map((r) => r.key)).not.toContain('setting:softphone');
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

describe('everything together', () => {
  const base: SearchInput = {
    query: '',
    gate: ALL_ON('account_admin'),
    accountId: 'a-1',
    defaultCallingCode: '+91',
    campaigns: [{ id: 'c-1', name: 'Diwali renewals' }],
    campaignSections: [{ id: 'caller-ids', label: 'Caller IDs', keywords: ['caller'] }],
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

  it('never shows campaigns to a reader who may not read them, whatever list it is given', () => {
    expect(groups({ query: 'diwali', gate: ALL_ON('agent') })).toEqual([]);
  });

  it('leaves campaign settings out below the Settings tab’s gate (agency.supervise)', () => {
    const answer = searchConsole({ ...base, query: 'diwali', gate: ALL_ON('viewer') });
    expect(answer.groups.flatMap((g) => g.results).map((r) => r.title)).toEqual(['Diwali renewals']);
    expect(groups({ query: 'caller', gate: ALL_ON('viewer') })).not.toContain('campaign-settings');
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

import {
  parseSearchNumber,
  resolveSearchCountry,
} from '@magick-agency/domain/customer-search-number';
import {
  CONSOLE_SECTIONS,
  SETTINGS_ENTRIES,
  agencyGate,
  passesGate,
  settingsGroupTitle,
  type Gate,
  type GateInput,
  type SettingsEntry,
} from './consoleNav';
import { CAMPAIGN_TABS, type CampaignTabDefinition, type CampaignTabId } from './agencyCampaignTabs';
import { campaignSettingsSectionsFor } from './campaignSettingsSections';
import { CONTACT_ASSIGNMENT_FLAG } from './agencyAssignmentCopy';
import { INBOUND_FLAG } from './inbound/inboundFlag';
import { hasPermission } from './permissions';

/**
 * What ⌘K (`GlobalSearch`) finds, and what the Settings hub's "Find a setting" filters (B28):
 * a phone number's history, pages, Settings pages, campaigns, each campaign's own pages (its
 * tabs, History and Soft-phone calls) and campaign settings sections.
 *
 * Pure on purpose, like `consoleNav.ts`, whose tables it reads: the pages are the sidebar's
 * sections and tabs, and the Settings pages are the hub's entries, each offered under the gate
 * its destination has. Only the words people type to find them live here.
 */

/* ── Matching ────────────────────────────────────────────────────────────── */

/** Lower case, hyphens as spaces ("soft-phone" finds "soft phone"), one space between words. */
function normalise(text: string): string {
  return text.toLowerCase().replace(/[-‐‑–]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The query's words. Every one must appear somewhere in what an entry is known by. */
export function searchTokens(query: string): string[] {
  const clean = normalise(query);
  return clean === '' ? [] : clean.split(' ');
}

function haystack(parts: readonly string[]): string {
  return normalise(parts.join(' '));
}

function matchesAll(tokens: readonly string[], text: string): boolean {
  return tokens.every((token) => text.includes(token));
}

/* ── Results ─────────────────────────────────────────────────────────────── */

export type SearchGroupId = 'number' | 'pages' | 'settings' | 'campaigns' | 'campaign-pages' | 'campaign-settings';

export const SEARCH_GROUP_TITLES: Record<SearchGroupId, string> = {
  number: 'Phone number',
  pages: 'Pages',
  settings: 'Settings',
  campaigns: 'Campaigns',
  'campaign-pages': 'Campaign pages',
  'campaign-settings': 'Campaign settings',
};

export type SearchTarget =
  | { type: 'path'; to: string }
  /** Customer history: the raw text as typed and the country it was read in, as the box sends them. */
  | { type: 'number'; raw: string; countryIso: string; formatted: string };

export interface SearchResult {
  key: string;
  group: SearchGroupId;
  title: string;
  /** Where it sits ("Settings › This account"), when the title alone does not say. */
  detail?: string;
  /** The short word at the row's end: Page, Setting, Campaign. */
  kind: string;
  target: SearchTarget;
}

export interface SearchGroup {
  id: SearchGroupId;
  title: string;
  results: SearchResult[];
}

/* ── Pages ───────────────────────────────────────────────────────────────── */

/**
 * The words that find each sidebar page, by `<section id>:<tab id>`. Optional: a page with no
 * row is still found by its label and its section's. `compliance` and `opt out` are kept off Do
 * Not Call on purpose: the list binds the dialler only, so it is not the answer to a wider
 * question. A page that was renamed keeps its old name here, so the word people learnt still
 * finds it.
 */
const PAGE_KEYWORDS: Record<string, readonly string[]> = {
  'home:home': ['attention', 'today', 'floor', 'stalled', 'paused', 'overdue'],
  'campaigns:campaigns': ['campaign', 'dialler', 'dialer', 'power dial', 'outbound'],
  'campaigns:softphone': ['soft phone', 'softphone', 'manual calls', 'calls'],
  'inbound:missed': ['missed calls', 'inbound', 'unanswered', 'callback', 'follow up'],
  'inbound:summary': ['inbound summary', 'queue', 'incoming'],
  'reports:analytics': ['analytics', 'stats', 'performance', 'agents'],
  // "Reports" until the tab became Exports; the section is still Reports.
  'reports:reports': ['report', 'reports', 'export', 'exports', 'pdf', 'workbook', 'excel', 'download', 'subscription'],
  'dnc:dnc': ['dnc', 'do not call', 'suppress', 'blocklist', 'blacklist', 'dialling', 'dialing'],
  'dialer:dialer': ['dialler', 'dialer', 'station', 'my calls', 'take calls', 'join campaign', 'agent workspace'],
};

/** A title the tab's own label would leave ambiguous out of its tab bar. */
const PAGE_TITLES: Record<string, string> = {
  'inbound:summary': 'Inbound summary',
};

interface PageEntry {
  key: string;
  title: string;
  detail?: string;
  to: string;
  gate: Gate;
  keywords: readonly string[];
}

/** Customer history's gate: the permission, under the dialer whose accounts the search reads. */
export const NUMBER_SEARCH_GATE: Gate = agencyGate({ permission: 'agency.customer_history.read' });

/**
 * Pages that are not a sidebar entry or a tab but are worth going to directly. "New campaign" is
 * the Campaigns page's button, shown with `agency.campaigns.write` (`AgencyCampaignsPage`).
 * Customer history is where a number's search lands; opened on its own it is the search box.
 */
const EXTRA_PAGES: readonly PageEntry[] = [
  {
    key: 'campaigns:new',
    title: 'New campaign',
    detail: 'Campaigns',
    to: '/agency/campaigns/new',
    gate: agencyGate({ permission: 'agency.campaigns.write' }),
    keywords: ['create campaign', 'add campaign', 'upload', 'roster'],
  },
  {
    key: 'customers:history',
    title: 'Customer history',
    to: '/agency/customers',
    gate: NUMBER_SEARCH_GATE,
    keywords: ['history', 'customer', 'phone number', 'search a number', 'look up', 'lookup', 'calls to a number'],
  },
];

/** Every page ⌘K can open: the sidebar's tabs, in sidebar order, then {@link EXTRA_PAGES}. */
export function searchPages(): PageEntry[] {
  const fromNav = CONSOLE_SECTIONS.flatMap((section) =>
    section.tabs.map((tab): PageEntry => {
      const key = `${section.id}:${tab.id}`;
      const title = PAGE_TITLES[key] ?? tab.label;
      return {
        key,
        title,
        ...(title === section.label ? {} : { detail: section.label }),
        to: tab.to,
        gate: tab.gate,
        keywords: [section.label, ...(PAGE_KEYWORDS[key] ?? [])],
      };
    }),
  );
  const campaignsAt = fromNav.findIndex((p) => p.key === 'campaigns:campaigns');
  const pages = [...fromNav];
  pages.splice(campaignsAt + 1, 0, ...EXTRA_PAGES.filter((p) => p.key.startsWith('campaigns:')));
  return [...pages, ...EXTRA_PAGES.filter((p) => !p.key.startsWith('campaigns:'))];
}

export function pageResults(tokens: readonly string[], gate: GateInput): SearchResult[] {
  return searchPages()
    .filter((page) => passesGate(page.gate, gate))
    .filter((page) => matchesAll(tokens, haystack([page.title, page.detail ?? '', ...page.keywords])))
    .map((page) => ({
      key: `page:${page.key}`,
      group: 'pages' as const,
      title: page.title,
      ...(page.detail ? { detail: page.detail } : {}),
      kind: 'Page',
      target: { type: 'path' as const, to: page.to },
    }));
}

/* ── Settings ────────────────────────────────────────────────────────────── */

/** One named setting on a Settings page, found by its own words and shown by its own label. */
export interface NamedSetting {
  label: string;
  keywords: readonly string[];
}

export interface SettingsSearchTerms {
  /** Words that find the page as a whole. */
  keywords: readonly string[];
  /** Settings on the page, each only one the page really has. */
  settings: readonly NamedSetting[];
}

/**
 * The words that find each Settings hub page, by `SETTINGS_ENTRIES` id. Every entry needs a row
 * (`consoleSearch.test.ts`). Each named setting is one its page shows; a word for something the
 * page does not have would send people to the wrong place. Sign-out is the profile menu's, not
 * the Profile page's, so it is not here.
 */
export const SETTINGS_SEARCH: Record<string, SettingsSearchTerms> = {
  profile: {
    keywords: ['profile', 'my name', 'my email', 'appearance'],
    settings: [{ label: 'Theme', keywords: ['theme', 'dark mode', 'light mode', 'appearance', 'colour', 'color'] }],
  },
  notifications: {
    keywords: ['notification', 'email', 'digest', 'summary emails', 'unsubscribe', 'alert', 'daily', 'weekly'],
    settings: [],
  },
  softphone: {
    keywords: ['soft phone', 'softphone', 'manual calls'],
    settings: [
      {
        label: 'Default caller ID for soft-phone calls',
        keywords: ['default caller id', 'caller id', 'caller', 'cli', 'from number', 'outgoing number'],
      },
      { label: 'Record soft-phone calls', keywords: ['record', 'recording'] },
      { label: 'Summary profile for soft-phone calls', keywords: ['summary profile', 'call summary'] },
      { label: 'Outcomes for soft-phone calls', keywords: ['outcome', 'disposition'] },
      { label: 'Call details fields', keywords: ['call details', 'custom fields', 'fields'] },
    ],
  },
  inbound: {
    keywords: ['inbound', 'routing', 'route', 'incoming calls', 'ivr'],
    settings: [
      { label: 'Opening hours and holidays', keywords: ['hours', 'opening hours', 'business hours', 'holiday', 'closed', 'time zone'] },
      { label: 'What callers hear', keywords: ['greeting', 'hold music', 'recording notice', 'message', 'audio', 'ivr'] },
      { label: 'Who answers inbound calls', keywords: ['sticky', 'their agent', 'agent first', 'ring'] },
      { label: 'Numbers that ring your agents', keywords: ['numbers', 'phone number'] },
      { label: 'When nobody answers', keywords: ['unanswered', 'missed', 'call back', 'callback'] },
      { label: 'Waiting and limits', keywords: ['queue', 'wait', 'longest wait'] },
    ],
  },
  'call-summaries': {
    keywords: ['call summaries', 'summary', 'summaries', 'analysis', 'ai', 'what we capture'],
    settings: [],
  },
  team: {
    keywords: ['team', 'member', 'members', 'invite', 'invitation', 'role', 'roles', 'people', 'user', 'users', 'access'],
    settings: [],
  },
  accounts: {
    keywords: ['account', 'accounts', 'new account', 'create account'],
    settings: [],
  },
};

export interface SettingsMatch {
  entry: SettingsEntry;
  /** The page's label, or the named setting that matched. */
  title: string;
  detail: string;
}

/**
 * How a Settings page matches the query, or null. The page itself first (its label, its group's
 * title and its words); failing that its first named setting whose words, with the page's label,
 * hold every word of the query, so "soft phone caller" finds the default caller ID.
 */
export function matchSettingsEntry(entry: SettingsEntry, tokens: readonly string[]): SettingsMatch | null {
  const group = settingsGroupTitle(entry.scope, {});
  const terms = SETTINGS_SEARCH[entry.id] ?? { keywords: [], settings: [] };
  if (matchesAll(tokens, haystack([entry.label, group, ...terms.keywords]))) {
    return { entry, title: entry.label, detail: `Settings › ${group}` };
  }
  for (const setting of terms.settings) {
    if (matchesAll(tokens, haystack([setting.label, entry.label, ...setting.keywords]))) {
      return { entry, title: setting.label, detail: `Settings › ${group} › ${entry.label}` };
    }
  }
  return null;
}

/** The hub's sub-nav filter: does this entry stay? */
export function settingsEntryMatches(entry: SettingsEntry, query: string): boolean {
  return matchSettingsEntry(entry, searchTokens(query)) !== null;
}

export function settingsResults(tokens: readonly string[], gate: GateInput): SearchResult[] {
  return SETTINGS_ENTRIES.filter((entry) => passesGate(entry.gate, gate)).flatMap((entry) => {
    const match = matchSettingsEntry(entry, tokens);
    if (!match) return [];
    return [
      {
        key: `setting:${entry.id}`,
        group: 'settings' as const,
        title: match.title,
        detail: match.detail,
        kind: 'Setting',
        target: { type: 'path' as const, to: entry.path },
      },
    ];
  });
}

/* ── Campaigns ───────────────────────────────────────────────────────────── */

export interface SearchCampaign {
  id: string;
  name: string;
}

/** A section of a campaign's Settings page, linked as `…/settings#<id>`. */
export interface CampaignSettingsSection {
  id: string;
  label: string;
  keywords: string[];
}

/** The campaign list's gate: the Campaigns page's, whose list read it is. */
export function campaignsGate(): Gate {
  const tab = CONSOLE_SECTIONS.find((s) => s.id === 'campaigns')?.tabs.find((t) => t.id === 'campaigns');
  return tab ? tab.gate : agencyGate({ permission: 'agency.campaigns.read' });
}

/**
 * A campaign screen's gate, as the tab bar gates it (`CAMPAIGN_TABS`: its permission and its
 * flag), under the dialer. The campaign list's own gate comes on top: no campaign is offered
 * without it.
 */
export function campaignTabGate(tab: Pick<CampaignTabDefinition, 'permission' | 'flag'>): Gate {
  return agencyGate({
    ...(tab.permission ? { permission: tab.permission } : {}),
    ...(tab.flag ? { flags: [tab.flag] } : {}),
  });
}

/** A campaign's Settings tab, gated as the tab bar gates it (`CAMPAIGN_TABS`). */
export function campaignSettingsGate(): Gate {
  const tab = CAMPAIGN_TABS.find((t) => t.id === 'settings');
  return tab ? campaignTabGate(tab) : agencyGate({ permission: 'agency.supervise' });
}

/**
 * A campaign screen's name where search must not use its tab-table label: the screen the
 * campaign header's History button opens is titled History on the page, in the breadcrumb and
 * on the button, though `CAMPAIGN_TABS` still calls it Activity.
 */
const CAMPAIGN_PAGE_TITLES: Partial<Record<CampaignTabId, string>> = {
  activity: 'History',
};

/** What search calls a campaign screen: the name the screen itself shows. */
export function campaignPageTitle(tab: Pick<CampaignTabDefinition, 'id' | 'label'>): string {
  return CAMPAIGN_PAGE_TITLES[tab.id] ?? tab.label;
}

/**
 * The words that find each campaign screen, beside its title. Every screen needs a row
 * (`consoleSearch.test.ts`). Old names stay: Call log was "Call attempts", and History was
 * called Activity.
 */
export const CAMPAIGN_TAB_KEYWORDS: Record<CampaignTabId, readonly string[]> = {
  overview: ['overview', 'insights', 'headline', 'needs attention'],
  calls: ['calls', 'outcomes', 'dispositions', 'trends'],
  agents: ['agents', 'floor', 'staffing', 'assigned'],
  callbacks: ['callbacks', 'callback', 'overdue', 'promised'],
  health: ['health', 'abandonment', 'stalls', 'carrier failures'],
  contacts: ['contacts', 'roster', 'contact list'],
  attempts: ['call log', 'call attempts', 'attempts', 'dials', 'dialler calls'],
  manual: ['soft phone calls', 'softphone calls', 'manual calls'],
  activity: ['activity', 'history', 'audit', 'audit trail', 'who did what', 'changes'],
  settings: ['settings', 'configure', 'set up'],
};

const MAX_CAMPAIGNS = 5;
const MAX_CAMPAIGN_PAGES = 6;
const MAX_CAMPAIGN_SECTIONS = 6;

/** Campaigns whose name holds every word of the query, each with "<name> › Settings" when allowed. */
export function campaignResults(
  campaigns: readonly SearchCampaign[],
  tokens: readonly string[],
  withSettings: boolean,
): SearchResult[] {
  if (tokens.length === 0) return [];
  return campaigns
    .filter((c) => matchesAll(tokens, normalise(c.name)))
    .slice(0, MAX_CAMPAIGNS)
    .flatMap((c) => {
      const open: SearchResult = {
        key: `campaign:${c.id}`,
        group: 'campaigns',
        title: c.name,
        kind: 'Campaign',
        target: { type: 'path', to: `/agency/campaigns/${c.id}` },
      };
      if (!withSettings) return [open];
      const settings: SearchResult = {
        key: `campaign:${c.id}:settings`,
        group: 'campaigns',
        title: `${c.name} › Settings`,
        kind: 'Campaign',
        target: { type: 'path', to: `/agency/campaigns/${c.id}/settings` },
      };
      return [open, settings];
    });
}

/**
 * A campaign's own page ("Diwali renewals › Call log") in each campaign the query names: every
 * word must be in the campaign's name or the page's words, and at least one in the page's, so
 * "call log" lists the newest campaigns' Call log and "diwali history" Diwali renewals' History.
 * Only the screens the reader may open (`gate`, each as its tab), in tab order.
 */
export function campaignPageResults(
  campaigns: readonly SearchCampaign[],
  query: string,
  gate: GateInput,
): SearchResult[] {
  const tokens = searchTokens(query);
  if (tokens.length === 0) return [];
  const results: SearchResult[] = [];
  for (const tab of CAMPAIGN_TABS) {
    if (!passesGate(campaignTabGate(tab), gate)) continue;
    const title = campaignPageTitle(tab);
    const tabText = haystack([title, tab.label, ...CAMPAIGN_TAB_KEYWORDS[tab.id]]);
    if (!tokens.some((t) => tabText.includes(t))) continue;
    for (const c of campaigns) {
      const name = normalise(c.name);
      if (!tokens.every((t) => tabText.includes(t) || name.includes(t))) continue;
      results.push({
        // The Settings tab's key is the campaign row's own "› Settings", so the two never both show.
        key: tab.id === 'settings' ? `campaign:${c.id}:settings` : `campaign-page:${c.id}:${tab.id}`,
        group: 'campaign-pages',
        title: `${c.name} › ${title}`,
        kind: 'Campaign',
        target: { type: 'path', to: tab.path(c.id) },
      });
      if (results.length >= MAX_CAMPAIGN_PAGES) return results;
    }
  }
  return results;
}

/**
 * A campaign settings section in each campaign the query names: every word must be in the
 * campaign's name or the section's words, and at least one in the section's, so "caller" lists
 * Caller IDs in the newest campaigns and "diwali caller" in Diwali renewals alone.
 */
export function campaignSettingsResults(
  campaigns: readonly SearchCampaign[],
  sections: readonly CampaignSettingsSection[],
  query: string,
): SearchResult[] {
  const tokens = searchTokens(query);
  if (tokens.length === 0 || sections.length === 0) return [];
  const results: SearchResult[] = [];
  for (const section of sections) {
    const sectionText = haystack([section.label, ...section.keywords]);
    if (!tokens.some((t) => sectionText.includes(t))) continue;
    for (const c of campaigns) {
      const name = normalise(c.name);
      if (!tokens.every((t) => sectionText.includes(t) || name.includes(t))) continue;
      results.push({
        key: `campaign-section:${c.id}:${section.id}`,
        group: 'campaign-settings',
        title: section.label,
        detail: `${c.name} › Settings`,
        kind: 'Campaign',
        target: { type: 'path', to: `/agency/campaigns/${c.id}/settings#${section.id}` },
      });
      if (results.length >= MAX_CAMPAIGN_SECTIONS) return results;
    }
  }
  return results;
}

/* ── A phone number ──────────────────────────────────────────────────────── */

/** Only phone characters, with at least three digits: what someone typing a number types. */
const PHONE_LIKE = /^[+\d\s().-]+$/;

export function looksLikePhoneNumber(query: string): boolean {
  const text = query.trim();
  return PHONE_LIKE.test(text) && (text.match(/\d/g)?.length ?? 0) >= 3;
}

export type NumberQuery =
  | { kind: 'none' }
  | { kind: 'number'; result: SearchResult }
  /** Looks like a number the shared rule refuses: its words, so people know what to fix. */
  | { kind: 'refused'; message: string };

/**
 * The query read as a phone number by the search box's own rule (`parseSearchNumber`, CH5), in
 * the country the box starts on (the platform default). Another country's number is typed with
 * its `+` code.
 */
export function numberQuery(query: string, defaultCallingCode: string): NumberQuery {
  if (!looksLikePhoneNumber(query)) return { kind: 'none' };
  const country = resolveSearchCountry(null, defaultCallingCode);
  const parsed = parseSearchNumber(query, country);
  if (!parsed.ok) return { kind: 'refused', message: parsed.message };
  return {
    kind: 'number',
    result: {
      key: 'number',
      group: 'number',
      title: `Calls to ${parsed.formatted}`,
      detail: 'Customer history, across campaigns',
      kind: 'Number',
      target: { type: 'number', raw: query.trim(), countryIso: country.iso, formatted: parsed.formatted },
    },
  };
}

/* ── Everything ──────────────────────────────────────────────────────────── */

export interface SearchInput {
  query: string;
  gate: GateInput;
  /** The active account: the number search and the campaign list both carry its header. */
  accountId: string | null;
  defaultCallingCode: string;
  /** The account's campaigns, or null while unread (or not readable). */
  campaigns: readonly SearchCampaign[] | null;
}

export interface SearchAnswer {
  groups: SearchGroup[];
  /**
   * The refusal for a number-like query, shown above the results and never selectable. Null
   * when anything else matched: "2026" may be a campaign's name rather than half a number.
   */
  numberNote: string | null;
}

/**
 * The campaign Settings sections search may link to: the ones every campaign's page has for
 * this reader (`campaignSettingsSectionsFor`). Agents is left out when its page might not show
 * it: without contact assignment or inbound calls it is there only for a campaign with
 * contact-assignment settings left over, which the campaign list does not say.
 */
export function searchableCampaignSections(gate: GateInput): CampaignSettingsSection[] {
  return campaignSettingsSectionsFor({
    assignmentEnabled: gate.isFlagEnabled(CONTACT_ASSIGNMENT_FLAG),
    inboundEnabled: gate.isFlagEnabled(INBOUND_FLAG),
    assignmentLeftovers: false,
    canSupervise: hasPermission(gate.role, 'agency.supervise'),
  });
}

/** Whether this reader may search numbers here (the old "Search a number" button's rule). */
export function canSearchNumbers(gate: GateInput, accountId: string | null): boolean {
  return accountId !== null && passesGate(NUMBER_SEARCH_GATE, gate);
}

/** Whether this reader's campaign list may be read for search. */
export function canSearchCampaigns(gate: GateInput, accountId: string | null): boolean {
  return accountId !== null && passesGate(campaignsGate(), gate);
}

export function searchConsole(input: SearchInput): SearchAnswer {
  const tokens = searchTokens(input.query);
  const groups: SearchGroup[] = [];
  let numberNote: string | null = null;

  if (canSearchNumbers(input.gate, input.accountId)) {
    const number = numberQuery(input.query, input.defaultCallingCode);
    if (number.kind === 'number') groups.push(group('number', [number.result]));
    if (number.kind === 'refused') numberNote = number.message;
  }

  groups.push(group('pages', pageResults(tokens, input.gate)));
  groups.push(group('settings', settingsResults(tokens, input.gate)));

  if (input.campaigns && canSearchCampaigns(input.gate, input.accountId)) {
    const withSettings = passesGate(campaignSettingsGate(), input.gate);
    const campaigns = campaignResults(input.campaigns, tokens, withSettings);
    const shown = new Set(campaigns.map((r) => r.key));
    groups.push(group('campaigns', campaigns));
    groups.push(group('campaign-pages', campaignPageResults(input.campaigns, input.query, input.gate).filter((r) => !shown.has(r.key))));
    if (withSettings) {
      const sections = searchableCampaignSections(input.gate);
      groups.push(group('campaign-settings', campaignSettingsResults(input.campaigns, sections, input.query)));
    }
  }

  const found = groups.filter((g) => g.results.length > 0);
  const others = found.some((g) => g.id !== 'number');
  return { groups: found, numberNote: others ? null : numberNote };
}

function group(id: SearchGroupId, results: SearchResult[]): SearchGroup {
  return { id, title: SEARCH_GROUP_TITLES[id], results };
}

/* ── The search field's words ────────────────────────────────────────────── */

/** What the top bar's field and the dialog's input say: only what this reader can search. */
export function searchPlaceholder(numbers: boolean, campaigns: boolean): string {
  if (numbers && campaigns) return 'Search pages, campaigns, settings or a number';
  if (numbers) return 'Search pages, settings or a number';
  if (campaigns) return 'Search pages, campaigns or settings';
  return 'Search pages and settings';
}

/** The shortcut as the reader's keyboard labels it. */
export function searchShortcutLabel(platform: string): string {
  return /Mac|iPhone|iPad/.test(platform) ? '⌘K' : 'Ctrl K';
}

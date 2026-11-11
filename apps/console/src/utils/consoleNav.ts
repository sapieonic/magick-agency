import { hasPermission, type Permission } from './permissions';
import { INBOUND_FLAG } from './inbound/inboundFlag';
import { REPORTS_FLAG } from './reports/reportsFlag';
import type { Role } from '../types/auth';
import type { ProductSurface } from '../analytics/posthog';

/**
 * The console's navigation model (decision B28): one shell for every signed-in page that is
 * not an agent's full-viewport surface, with Home and four work sections in the sidebar, a Settings hub
 * pinned under them, and an in-page tab bar inside a section that groups more than one page.
 *
 * Pure on purpose. The sidebar, the tab bar, the breadcrumb and the tests all read the same
 * tables, so an entry's gate is written once. Each page keeps the URL it had; a section only
 * groups them.
 */

export const DIALER_FLAG = 'agency_dialer_enabled';
export const SOFTPHONE_FLAG_KEY = 'agency_softphone_enabled';
export const CALL_ANALYSIS_FLAG = 'agency_call_analysis';

/**
 * What must hold for a destination to be offered. Every part is optional and all of them
 * must pass. `missed` is the Missed-calls rule (`useMissedCallsAccess().available`: inbound
 * on, or rows still to read with it off), used instead of the inbound flag.
 */
export interface Gate {
  permission?: Permission;
  flags?: readonly string[];
  capabilities?: readonly string[];
  missed?: boolean;
}

export interface GateInput {
  role: Role | undefined;
  isFlagEnabled: (flag: string) => boolean;
  isCapabilityEnabled: (capability: string) => boolean;
  /** `useMissedCallsAccess().available`; false when the caller did not read it. */
  missedAvailable?: boolean;
}

export function passesGate(gate: Gate, input: GateInput): boolean {
  if (gate.permission && !hasPermission(input.role, gate.permission)) return false;
  if (gate.flags && !gate.flags.every((flag) => input.isFlagEnabled(flag))) return false;
  if (gate.capabilities && !gate.capabilities.every((cap) => input.isCapabilityEnabled(cap))) return false;
  if (gate.missed && input.missedAvailable !== true) return false;
  return true;
}

/**
 * Every work page sits under `/agency`, whose route is gated on the `agency` capability and
 * the `agency_dialer_enabled` flag. The sidebar is no longer inside that gate (Settings is
 * not), so each work entry carries the two itself.
 */
function agency(gate: Gate): Gate {
  return {
    ...gate,
    capabilities: ['agency', ...(gate.capabilities ?? [])],
    flags: [DIALER_FLAG, ...(gate.flags ?? [])],
  };
}

export type ConsoleSectionId = 'home' | 'campaigns' | 'inbound' | 'reports' | 'dnc';

/** The supervisor's Home page: what needs them, the floor, and today so far. */
export const HOME_PATH = '/agency/home';

/**
 * Who gets Home: `agency.supervise`, because every read it makes floors there (each campaign's
 * `/stats` floor, the insights allocation for overdue callbacks, the grouped stats for today).
 * The route, the sidebar entry, its badge and `AgencyHomeRedirect` all read this one gate.
 */
export const HOME_GATE: Gate = agency({ permission: 'agency.supervise' });

/** Whether the reader may open Home (and so lands there from `/agency`). */
export function canSeeHome(input: GateInput): boolean {
  return passesGate(HOME_GATE, input);
}

export interface SectionTab {
  id: string;
  label: string;
  /** The page's own URL (unchanged by the regrouping). */
  to: string;
  gate: Gate;
}

export interface ConsoleSection {
  id: ConsoleSectionId;
  label: string;
  /** Path prefixes the section is active on: every page it groups, and their sub-pages. */
  paths: readonly string[];
  /** The pages it groups, in tab order. The sidebar entry opens the first visible one. */
  tabs: readonly SectionTab[];
}

/**
 * The sidebar's work sections, top to bottom. A section is offered when any of its pages is,
 * so its visibility is the union of their gates; each page's gate is the one its old sidebar
 * entry had.
 */
export const CONSOLE_SECTIONS: readonly ConsoleSection[] = [
  /* First, and active only on its own URL. Its badge counts what needs the supervisor. */
  {
    id: 'home',
    label: 'Home',
    paths: [HOME_PATH],
    tabs: [{ id: 'home', label: 'Home', to: HOME_PATH, gate: HOME_GATE }],
  },
  {
    id: 'campaigns',
    label: 'Campaigns',
    paths: ['/agency/campaigns', '/agency/softphone'],
    tabs: [
      { id: 'campaigns', label: 'Campaigns', to: '/agency/campaigns', gate: agency({ permission: 'agency.campaigns.read' }) },
      /* The server scopes `GET /softphone/calls` to the whole account only for
         `agency.supervise` (`docs/softphone.md` §7); behind the soft-phone flag. */
      {
        id: 'softphone',
        label: 'Soft-phone calls',
        to: '/agency/softphone',
        gate: agency({ permission: 'agency.supervise', flags: [SOFTPHONE_FLAG_KEY] }),
      },
    ],
  },
  {
    id: 'inbound',
    label: 'Inbound',
    paths: ['/agency/inbound'],
    tabs: [
      /* `docs/inbound.md` §7: a supervisor reads the account's rows and anyone else their own.
         Floored at the workspace's floor because a dedicated agent has their own entry
         (`/dialer/missed`). */
      { id: 'missed', label: 'Missed calls', to: '/agency/inbound/missed', gate: agency({ permission: 'agency.campaigns.read', missed: true }) },
      /* `docs/inbound.md` §11: supervisors only. */
      { id: 'summary', label: 'Summary', to: '/agency/inbound/summary', gate: agency({ permission: 'agency.supervise', missed: true }) },
    ],
  },
  {
    id: 'reports',
    label: 'Reports',
    paths: ['/agency/analytics', '/agency/reports'],
    tabs: [
      /* Reads the campaign list plus one `/stats` each, both `agency.campaigns.read`. */
      { id: 'analytics', label: 'Analytics', to: '/agency/analytics', gate: agency({ permission: 'agency.campaigns.read' }) },
      /* `docs/reports.md`: a supervisor's history and subscriptions, anyone else's own runs. */
      { id: 'reports', label: 'Reports', to: '/agency/reports', gate: agency({ permission: 'agency.campaigns.read', flags: [REPORTS_FLAG] }) },
    ],
  },
  {
    id: 'dnc',
    label: 'Do Not Call',
    paths: ['/agency/dnc'],
    tabs: [{ id: 'dnc', label: 'Do Not Call', to: '/agency/dnc', gate: agency({ permission: 'agency.dnc.read' }) }],
  },
];

/** `pathname` is `prefix` or below it, on a segment boundary. */
export function pathWithin(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function trimTrailingSlash(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

export function visibleTabs(section: ConsoleSection, input: GateInput): SectionTab[] {
  return section.tabs.filter((tab) => passesGate(tab.gate, input));
}

export interface VisibleSection {
  section: ConsoleSection;
  /** The first page of the section the reader may open. */
  href: string;
}

export function visibleSections(input: GateInput): VisibleSection[] {
  return CONSOLE_SECTIONS.flatMap((section) => {
    const tabs = visibleTabs(section, input);
    return tabs.length > 0 ? [{ section, href: tabs[0]!.to }] : [];
  });
}

export type ActiveNavId = ConsoleSectionId | 'settings';

/** Which sidebar entry the path belongs to, or null (customer history, the `/agency` index). */
export function activeNavId(pathname: string): ActiveNavId | null {
  const path = trimTrailingSlash(pathname);
  if (pathWithin(path, '/settings')) return 'settings';
  return CONSOLE_SECTIONS.find((s) => s.paths.some((p) => pathWithin(path, p)))?.id ?? null;
}

export interface TabBar {
  section: ConsoleSection;
  tabs: SectionTab[];
  activeId: string;
}

/**
 * The in-page tab bar for a grouped page: shown on the pages a section groups (not on their
 * sub-pages, such as one campaign or one report), with only the tabs the reader may open, and
 * not at all when one tab or fewer is left.
 */
export function tabBarFor(pathname: string, input: GateInput): TabBar | null {
  const path = trimTrailingSlash(pathname);
  for (const section of CONSOLE_SECTIONS) {
    const active = section.tabs.find((tab) => tab.to === path);
    if (!active) continue;
    const tabs = visibleTabs(section, input);
    if (tabs.length < 2) return null;
    return { section, tabs, activeId: active.id };
  }
  return null;
}

export function isAgencyPath(pathname: string): boolean {
  return pathWithin(pathname, '/agency');
}

/**
 * The analytics `product` for a page in the console shell: `'agency'` for the work pages under
 * `/agency`, `'ai'` for Settings and the legacy `/app` redirects. These are the values the two
 * old shells sent (`AgencyLayout` and `AppLayout`), kept so PostHog's series do not break.
 */
export function productSurfaceForPath(pathname: string): ProductSurface {
  return isAgencyPath(pathname) ? 'agency' : 'ai';
}

export interface Crumb {
  label: string;
  to?: string;
}

/**
 * The top bar's breadcrumb: the section, then the page when it says something the section does
 * not. On a phone only the last crumb shows.
 */
export function breadcrumbFor(pathname: string, settingsLabel?: string | null): Crumb[] {
  const path = trimTrailingSlash(pathname);
  if (pathWithin(path, '/settings')) {
    return settingsLabel ? [{ label: 'Settings', to: '/settings' }, { label: settingsLabel }] : [{ label: 'Settings' }];
  }
  if (pathWithin(path, '/agency/customers')) return [{ label: 'Customer history' }];

  const section = CONSOLE_SECTIONS.find((s) => s.paths.some((p) => pathWithin(path, p)));
  if (!section) return [];
  const home: Crumb = { label: section.label, to: section.tabs[0]!.to };

  const tab = section.tabs.find((t) => t.to === path);
  if (tab) return tab.label === section.label ? [{ label: section.label }] : [home, { label: tab.label }];

  if (path === '/agency/campaigns/new') return [home, { label: 'New campaign' }];
  if (pathWithin(path, '/agency/campaigns')) return [home, { label: 'Campaign' }];
  if (pathWithin(path, '/agency/softphone')) return [home, { label: 'Soft-phone call' }];
  if (pathWithin(path, '/agency/reports')) return [home, { label: 'Report' }];
  return [home];
}

/* ── Settings ────────────────────────────────────────────────────────────── */

/** Who a setting affects, which is how the hub groups it and what its "Applies to" says. */
export type SettingsScope = 'you' | 'account' | 'tenant';

export interface SettingsEntry {
  id: string;
  label: string;
  path: string;
  scope: SettingsScope;
  gate: Gate;
}

/**
 * The Settings hub's entries, in sub-nav order. Each gate is the one its old sidebar entry had
 * (the union, where both shells listed it); the routes keep their own guards.
 */
export const SETTINGS_ENTRIES: readonly SettingsEntry[] = [
  /* About the signed-in person, so nothing to gate. */
  { id: 'profile', label: 'Profile and appearance', path: '/settings/profile', scope: 'you', gate: {} },
  /* The caller's own email subscriptions. Floored at `tenant.read` (viewer) for the link; the
     route itself is ungated, so nobody is locked out of their own unsubscribe. */
  { id: 'notifications', label: 'Email notifications', path: '/settings/notifications', scope: 'you', gate: { permission: 'tenant.read' } },
  /* Read at the dial floor, edited with `agency.softphone.manage` (the page checks). */
  {
    id: 'softphone',
    label: 'Soft phone',
    path: '/settings/softphone',
    scope: 'account',
    gate: { permission: 'agency.softphone.dial', flags: [SOFTPHONE_FLAG_KEY], capabilities: ['agency'] },
  },
  /* `docs/inbound.md` §8.1: account admins; nobody below `agency.inbound.write` reads a route. */
  {
    id: 'inbound',
    label: 'Inbound routing',
    path: '/settings/inbound',
    scope: 'account',
    gate: { permission: 'agency.inbound.write', flags: [INBOUND_FLAG], capabilities: ['agency'] },
  },
  {
    id: 'call-summaries',
    label: 'Call summaries',
    path: '/settings/call-summaries',
    scope: 'account',
    gate: { permission: 'agency.analysis_profiles.read', flags: [CALL_ANALYSIS_FLAG], capabilities: ['agency.analytics'] },
  },
  { id: 'team', label: 'Team', path: '/settings/team', scope: 'tenant', gate: { permission: 'user.invite' } },
  /* The roles that can create accounts (decision AA1); everyone else uses the switcher. */
  { id: 'accounts', label: 'Accounts', path: '/settings/accounts', scope: 'tenant', gate: { permission: 'account.create' } },
];

export const SETTINGS_SCOPES: readonly SettingsScope[] = ['you', 'account', 'tenant'];

export interface SettingsGroup {
  scope: SettingsScope;
  entries: SettingsEntry[];
}

/** The groups with at least one entry the reader may open, in order. */
export function visibleSettingsGroups(input: GateInput): SettingsGroup[] {
  return SETTINGS_SCOPES.flatMap((scope) => {
    const entries = SETTINGS_ENTRIES.filter((e) => e.scope === scope && passesGate(e.gate, input));
    return entries.length > 0 ? [{ scope, entries }] : [];
  });
}

export function settingsEntryForPath(pathname: string): SettingsEntry | null {
  const path = trimTrailingSlash(pathname);
  return SETTINGS_ENTRIES.find((e) => pathWithin(path, e.path)) ?? null;
}

export interface ScopeNames {
  accountName?: string | null;
  tenantName?: string | null;
}

export function settingsGroupTitle(scope: SettingsScope, names: ScopeNames): string {
  if (scope === 'you') return 'You';
  if (scope === 'account') return names.accountName ? `This account · ${names.accountName}` : 'This account';
  return 'People and access';
}

/** The "Applies to: …" a settings page shows, so nobody has to guess who a change reaches. */
export function appliesTo(scope: SettingsScope, names: ScopeNames): string {
  if (scope === 'you') return 'only you';
  if (scope === 'account') return names.accountName ?? 'this account';
  return names.tenantName ? `all of ${names.tenantName}` : 'your whole organisation';
}

/* ── The old `/app` URLs ─────────────────────────────────────────────────── */

/** The `/app/<page>` segments that moved to `/settings/<page>` with nothing else changed. */
export const LEGACY_SETTINGS_SEGMENTS: readonly string[] = [
  'team',
  'accounts',
  'notifications',
  'call-summaries',
  'softphone',
  'inbound',
];

/**
 * Where an old `/app/<rest>` URL now lives: `/settings/<rest>` (so `/app/inbound/:routeId`
 * keeps its id), or null for anything that was never a page here (the caller sends it to the
 * console's home instead).
 */
export function legacySettingsPath(rest: string): string | null {
  const clean = rest.replace(/^\/+|\/+$/g, '');
  const first = clean.split('/')[0] ?? '';
  return LEGACY_SETTINGS_SEGMENTS.includes(first) ? `/settings/${clean}` : null;
}

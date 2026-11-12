import { hasPermission, type Permission } from './permissions';
import { INBOUND_FLAG } from './inbound/inboundFlag';
import { REPORTS_FLAG } from './reports/reportsFlag';
import { SOFTPHONE_FLAG } from './softphone/softphoneFlag';
import { isDedicatedAgent } from './agencyPersona';
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
export const CALL_ANALYSIS_FLAG = 'agency_call_analysis';

/**
 * What must hold for a destination to be offered. Every part is optional and all of them
 * must pass. `missed` is the Missed-calls rule (`useMissedCallsAccess().available`: inbound
 * on, or rows still to read with it off), used instead of the inbound flag.
 *
 * `withoutPermission` is a permission the reader must NOT hold (the dialler's own workspace is
 * not offered to a supervisor, who joins a campaign as an agent from the campaign instead).
 *
 * `agentLanding` marks a route inside the shell, which `ConsoleShell` wraps in `AgentLanding`:
 * a DEDICATED agent (`isDedicatedAgent`) is sent from every shell page to the dialer whenever
 * the dialer is on, so it is never offered to them then. Every shell page is wrapped; the field
 * is set where the rest of the gate would otherwise let such an agent through.
 */
export interface Gate {
  permission?: Permission;
  flags?: readonly string[];
  capabilities?: readonly string[];
  missed?: boolean;
  withoutPermission?: Permission;
  agentLanding?: boolean;
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
  if (gate.withoutPermission && hasPermission(input.role, gate.withoutPermission)) return false;
  if (gate.flags && !gate.flags.every((flag) => input.isFlagEnabled(flag))) return false;
  if (gate.capabilities && !gate.capabilities.every((cap) => input.isCapabilityEnabled(cap))) return false;
  if (gate.missed && input.missedAvailable !== true) return false;
  if (gate.agentLanding && isDedicatedAgent(input.role) && dialerOn(input)) return false;
  return true;
}

/** The `agency` capability and the dialer flag: what every `/agency` route is behind. */
export function dialerOn(input: Pick<GateInput, 'isFlagEnabled' | 'isCapabilityEnabled'>): boolean {
  return input.isCapabilityEnabled('agency') && input.isFlagEnabled(DIALER_FLAG);
}

/**
 * Every work page sits under `/agency`, whose route is gated on the `agency` capability and
 * the `agency_dialer_enabled` flag. The sidebar is no longer inside that gate (Settings is
 * not), so each work entry carries the two itself.
 */
export function agencyGate(gate: Gate): Gate {
  return {
    ...gate,
    capabilities: ['agency', ...(gate.capabilities ?? [])],
    flags: [DIALER_FLAG, ...(gate.flags ?? [])],
  };
}

export type ConsoleSectionId = 'home' | 'campaigns' | 'inbound' | 'reports' | 'dnc' | 'dialer';

/** The agent's own workspace, outside the shell (a full-viewport surface): the campaigns to take calls on. */
export const DIALER_PATH = '/dialer';

/** The supervisor's Home page: what needs them, the floor, and today so far. */
export const HOME_PATH = '/agency/home';

/**
 * Who gets Home: `agency.supervise`, because every read it makes floors there (each campaign's
 * `/stats` floor, the insights allocation for overdue callbacks, the grouped stats for today).
 * The route, the sidebar entry, its badge and `AgencyHomeRedirect` all read this one gate.
 */
export const HOME_GATE: Gate = agencyGate({ permission: 'agency.supervise' });

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
      { id: 'campaigns', label: 'Campaigns', to: '/agency/campaigns', gate: agencyGate({ permission: 'agency.campaigns.read' }) },
      /* The server scopes `GET /softphone/calls` to the whole account only for
         `agency.supervise` (`docs/softphone.md` §7); behind the soft-phone flag. */
      {
        id: 'softphone',
        label: 'Soft-phone calls',
        to: '/agency/softphone',
        gate: agencyGate({ permission: 'agency.supervise', flags: [SOFTPHONE_FLAG] }),
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
      { id: 'missed', label: 'Missed calls', to: '/agency/inbound/missed', gate: agencyGate({ permission: 'agency.campaigns.read', missed: true }) },
      /* `docs/inbound.md` §11: supervisors only. */
      { id: 'summary', label: 'Summary', to: '/agency/inbound/summary', gate: agencyGate({ permission: 'agency.supervise', missed: true }) },
    ],
  },
  {
    id: 'reports',
    label: 'Reports',
    paths: ['/agency/analytics', '/agency/reports'],
    tabs: [
      /* Reads the campaign list plus one `/stats` each, both `agency.campaigns.read`. */
      { id: 'analytics', label: 'Analytics', to: '/agency/analytics', gate: agencyGate({ permission: 'agency.campaigns.read' }) },
      /* `docs/reports.md`: a supervisor's history and subscriptions, anyone else's own runs. */
      /* "Exports" in the bar, under the Reports section; the id and URL keep the old name. */
      { id: 'reports', label: 'Exports', to: '/agency/reports', gate: agencyGate({ permission: 'agency.campaigns.read', flags: [REPORTS_FLAG] }) },
    ],
  },
  {
    id: 'dnc',
    label: 'Do Not Call',
    paths: ['/agency/dnc'],
    tabs: [{ id: 'dnc', label: 'Do Not Call', to: '/agency/dnc', gate: agencyGate({ permission: 'agency.dnc.read' }) }],
  },
  /*
    The way out to the agent's workspace (`/dialer`, under the same capability and flag as
    `/agency`) for a reader who takes calls but does not supervise: a viewer or operator lands in
    the shell and holds `agency.station.connect`, and nothing else here links to the dialler. A
    supervisor joins a campaign as an agent from the campaign, so is not offered it. A plain link
    out: `/dialer` is not a page of the shell, so it is never active and has no tab bar.
  */
  {
    id: 'dialer',
    label: 'Take calls',
    paths: [DIALER_PATH],
    tabs: [
      {
        id: 'dialer',
        label: 'Take calls',
        to: DIALER_PATH,
        gate: agencyGate({ permission: 'agency.station.connect', withoutPermission: 'agency.supervise' }),
      },
    ],
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
 * not. On a phone only the last crumb shows, with a back arrow to the one before it when that
 * one is a link (`backCrumb`).
 *
 * `pageCrumbs` are what a page supplied through `usePageCrumbs` (`components/layout/PageCrumbs`)
 * for what the URL cannot say, such as a campaign's name; they follow the section (and the tab,
 * for a sub-page of a tab other than the section's first) and replace the generic page crumb.
 * A section's own tab pages keep their crumbs.
 *
 * In Settings the "Settings" crumb is not a link: `/settings` reopens the last Settings page
 * visited, which is the page the reader is on. A page below an entry (one inbound route) links
 * back to the entry.
 */
export function breadcrumbFor(
  pathname: string,
  settingsLabel?: string | null,
  pageCrumbs?: readonly Crumb[] | null,
): Crumb[] {
  const path = trimTrailingSlash(pathname);
  if (pathWithin(path, '/settings')) {
    const entry = settingsEntryForPath(path);
    const label = settingsLabel ?? entry?.label;
    if (!label) return [{ label: 'Settings' }];
    if (!entry || path === entry.path) return [{ label: 'Settings' }, { label }];
    const below = pageCrumbs && pageCrumbs.length > 0 ? [...pageCrumbs] : [{ label: settingsSubPageLabel(path) }];
    return [{ label: 'Settings' }, { label, to: entry.path }, ...below];
  }
  if (pathWithin(path, '/agency/customers')) return [{ label: 'Customer history' }];

  const section = CONSOLE_SECTIONS.find((s) => s.paths.some((p) => pathWithin(path, p)));
  if (!section) return [];
  const home: Crumb = { label: section.label, to: section.tabs[0]!.to };

  const tab = section.tabs.find((t) => t.to === path);
  if (tab) return tab.label === section.label ? [{ label: section.label }] : [home, { label: tab.label }];

  /* A sub-page of a tab that is not the section's own name (one report under Exports). */
  const parentTab = section.tabs.find((t) => pathWithin(path, t.to));
  const trail: Crumb[] = parentTab && parentTab.label !== section.label
    ? [home, { label: parentTab.label, to: parentTab.to }]
    : [home];
  if (pageCrumbs && pageCrumbs.length > 0) return [...trail, ...pageCrumbs];

  if (path === '/agency/campaigns/new') return [...trail, { label: 'New campaign' }];
  if (pathWithin(path, '/agency/campaigns')) return [...trail, { label: 'Campaign' }];
  if (pathWithin(path, '/agency/softphone')) return [...trail, { label: 'Soft-phone call' }];
  if (pathWithin(path, '/agency/reports')) return [...trail, { label: 'Report' }];
  return trail;
}

/** The page below a Settings entry, for a page that does not name itself. */
function settingsSubPageLabel(path: string): string {
  if (path === '/settings/inbound/new') return 'New inbound route';
  if (pathWithin(path, '/settings/inbound')) return 'Inbound route';
  return 'Details';
}

/**
 * Where the phone's back arrow goes: the crumb before the last, when it is a link. Null on a
 * section's first page, in a Settings entry (the hub's own control moves between entries) and
 * anywhere else with nothing above it to go back to.
 */
export function backCrumb(crumbs: readonly Crumb[]): (Crumb & { to: string }) | null {
  if (crumbs.length < 2) return null;
  const parent = crumbs[crumbs.length - 2]!;
  return parent.to ? { label: parent.label, to: parent.to } : null;
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
 * The gate of `/settings` itself (the sidebar's Settings link): only `AgentLanding`, which sends
 * a dedicated agent to `/dialer` from every Settings page while the dialer is on.
 */
export const SETTINGS_GATE: Gate = { agentLanding: true };

function settingsGate(gate: Gate): Gate {
  return { ...gate, ...SETTINGS_GATE };
}

/**
 * The Settings hub's entries, in sub-nav order. Each gate is the one its old sidebar entry had
 * (the union, where both shells listed it) plus {@link SETTINGS_GATE}; the routes keep their own
 * guards.
 */
export const SETTINGS_ENTRIES: readonly SettingsEntry[] = [
  /* About the signed-in person, so nothing to gate beyond the hub's own. */
  { id: 'profile', label: 'Profile and appearance', path: '/settings/profile', scope: 'you', gate: settingsGate({}) },
  /* The caller's own email subscriptions. Floored at `tenant.read` (viewer) for the link; the
     route itself is ungated, so nobody is locked out of their own unsubscribe. */
  { id: 'notifications', label: 'Email notifications', path: '/settings/notifications', scope: 'you', gate: settingsGate({ permission: 'tenant.read' }) },
  /* Read at the dial floor, edited with `agency.softphone.manage` (the page checks). */
  {
    id: 'softphone',
    label: 'Soft phone',
    path: '/settings/softphone',
    scope: 'account',
    gate: settingsGate({ permission: 'agency.softphone.dial', flags: [SOFTPHONE_FLAG], capabilities: ['agency'] }),
  },
  /* `docs/inbound.md` §8.1: account admins; nobody below `agency.inbound.write` reads a route. */
  {
    id: 'inbound',
    label: 'Inbound routing',
    path: '/settings/inbound',
    scope: 'account',
    gate: settingsGate({ permission: 'agency.inbound.write', flags: [INBOUND_FLAG], capabilities: ['agency'] }),
  },
  {
    id: 'call-summaries',
    label: 'Call summaries',
    path: '/settings/call-summaries',
    scope: 'account',
    gate: settingsGate({ permission: 'agency.analysis_profiles.read', flags: [CALL_ANALYSIS_FLAG], capabilities: ['agency.analytics'] }),
  },
  { id: 'team', label: 'Team', path: '/settings/team', scope: 'tenant', gate: settingsGate({ permission: 'user.invite' }) },
  /* The roles that can create accounts (decision AA1); everyone else uses the switcher. */
  { id: 'accounts', label: 'Accounts', path: '/settings/accounts', scope: 'tenant', gate: settingsGate({ permission: 'account.create' }) },
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

/**
 * Where `/settings` opens: the entry this reader last visited, while they may still open it;
 * otherwise Team for someone who manages people (the setting a supervisor comes for most), and
 * the first entry they may open for everyone else. Null when they may open none.
 */
export function settingsLandingPath(input: GateInput, lastVisitedId: string | null): string | null {
  const open = visibleSettingsGroups(input).flatMap((g) => g.entries);
  const last = lastVisitedId ? open.find((e) => e.id === lastVisitedId) : undefined;
  if (last) return last.path;
  return (open.find((e) => e.id === 'team') ?? open[0])?.path ?? null;
}

export interface ScopeNames {
  accountName?: string | null;
  tenantName?: string | null;
  /**
   * Whether the reader holds a tenant-wide seat here. False for a seat scoped to one account,
   * whose "people and access" settings reach only that account (the server confines them).
   * Unknown is read as tenant-wide.
   */
  tenantWide?: boolean;
}

export function settingsGroupTitle(scope: SettingsScope, names: ScopeNames): string {
  if (scope === 'you') return 'You';
  if (scope === 'account') return names.accountName ? `This account · ${names.accountName}` : 'This account';
  return 'People and access';
}

/** The "Applies to: …" a settings page shows, so nobody has to guess who a change reaches. */
export function appliesTo(scope: SettingsScope, names: ScopeNames): string {
  if (scope === 'you') return 'only you';
  if (scope === 'account' || names.tenantWide === false) return names.accountName ?? 'this account';
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

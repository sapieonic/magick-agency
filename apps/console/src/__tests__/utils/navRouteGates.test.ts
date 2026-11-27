import { describe, it, expect } from 'vitest';
import {
  CONSOLE_SECTIONS,
  HOME_GATE,
  HOME_PATH,
  SETTINGS_GATE,
  passesGate,
  settingsLandingPath,
  tabBarFor,
  SETTINGS_ENTRIES,
  visibleSections,
  visibleSettingsGroups,
  type GateInput,
  CAMPAIGNS_GATE,
} from '../../utils/consoleNav';
import { searchConsole, type SearchResult } from '../../utils/consoleSearch';
import { CAMPAIGN_TABS } from '../../utils/agencyCampaignTabs';
import { CAMPAIGN_SETTINGS_SECTIONS } from '../../utils/campaignSettingsSections';
import { hasPermission, type Permission } from '../../utils/permissions';
import { isDedicatedAgent } from '../../utils/agencyPersona';
import type { Role } from '../../types/auth';
import { declaredPaths, isDeclared } from '../routing/appRoutes';

/**
 * Every destination the shell offers passes the gate of the route it links to (B28), for every
 * role and every combination of the flags and capabilities the gates read: the sidebar's
 * entries, each section's tabs, the Settings hub's entries and landing, the hub's pointers, and
 * every search result.
 *
 * The offers come from the navigation tables (`consoleNav.ts`, `consoleSearch.ts`,
 * `agencyCampaignTabs.ts`). The routes below are written out separately, from `App.tsx`'s
 * guards and each page's own check, so a gate that drifts from its route fails here: a link
 * that would refuse the reader or send them somewhere else.
 */

const FLAGS = [
  'agency_dialer_enabled',
  'agency_softphone_enabled',
  'agency_inbound_enabled',
  'agency_reports_enabled',
  'agency_call_analysis',
  'agency_contact_assignment_enabled',
  'agency_live_listen_enabled',
  'agency_compare_enabled',
  'agency_team_performance_enabled',
  'agency_campaign_templates_enabled',
] as const;
const CAPABILITIES = ['agency', 'agency.analytics'] as const;
const ROLES: (Role | undefined)[] = ['tenant_owner', 'tenant_admin', 'account_admin', 'operator', 'viewer', 'agent', undefined];

interface Reader {
  role: Role | undefined;
  flags: ReadonlySet<string>;
  caps: ReadonlySet<string>;
  missed: boolean;
  /** The reader's role holds an organisation-wide seat (`GateInput.organisationRole`), not one scoped to an account. */
  organisationWide: boolean;
}

function gateInput(r: Reader): GateInput {
  return {
    role: r.role,
    isFlagEnabled: (f) => r.flags.has(f),
    isCapabilityEnabled: (c) => r.caps.has(c),
    missedAvailable: r.missed,
    ...(r.organisationWide && r.role ? { organisationRole: r.role } : {}),
  };
}

function subsets<T>(items: readonly T[]): T[][] {
  return items.reduce<T[][]>((all, item) => all.flatMap((s) => [s, [...s, item]]), [[]]);
}

/** The seats a reader is swept with: both only where the seat can change what is offered. */
function organisationSeatsFor(role: Role | undefined, flags: readonly string[]): boolean[] {
  const tenantRole = role === 'tenant_admin' || role === 'tenant_owner';
  return tenantRole && flags.includes('agency_campaign_templates_enabled') ? [true, false] : [false];
}

const READERS: Reader[] = ROLES.flatMap((role) =>
  subsets(FLAGS).flatMap((flags) =>
    subsets(CAPABILITIES).flatMap((caps) =>
      [true, false].flatMap((missed) =>
        // Whether the seat is organisation-wide matters only from tenant admin up, and only to the
        // organisation's campaign templates (CT3), the one gate that reads it: varied only there,
        // so the sweep does not do every other tenant reader's work twice.
        organisationSeatsFor(role, flags).map((organisationWide) => ({
          role, flags: new Set(flags), caps: new Set(caps), missed, organisationWide,
        })),
      ),
    ),
  ),
);

/* ── The routes, as `App.tsx` and the pages guard them ───────────────────── */

const can = (r: Reader, p: Permission) => hasPermission(r.role, p);
/** `/agency`'s own guards: `RequireCapability agency` and `RequireFlag agency_dialer_enabled`. */
const dialer = (r: Reader) => r.caps.has('agency') && r.flags.has('agency_dialer_enabled');
/** `ConsoleShell` → `AgentLanding` on every path outside `/agency`. */
const keptInShell = (r: Reader) => !(isDedicatedAgent(r.role) && dialer(r));

type RouteRule = [RegExp, (r: Reader) => boolean];

const ID = '[^/]+';
const ROUTES: RouteRule[] = [
  [/^\/agency\/home$/, (r) => dialer(r) && can(r, 'agency.supervise')],
  // `CallbacksPage` checks Live floor's permission (`CALLBACKS_GATE`).
  [/^\/agency\/callbacks$/, (r) => dialer(r) && can(r, 'agency.supervise')],
  [/^\/agency\/campaigns$/, (r) => dialer(r) && can(r, 'agency.campaigns.read')],
  [/^\/agency\/campaigns\/new$/, (r) => dialer(r) && can(r, 'agency.campaigns.write')],
  [/^\/agency\/campaigns\/archived$/, (r) => dialer(r) && can(r, 'agency.campaigns.read')],
  [new RegExp(`^/agency/campaigns/${ID}/(overview|calls|callbacks|health|contacts|attempts|settings)$`), (r) => dialer(r) && can(r, 'agency.supervise')],
  [new RegExp(`^/agency/campaigns/${ID}/agents$`), (r) => dialer(r) && can(r, 'agency.campaigns.read')],
  [new RegExp(`^/agency/campaigns/${ID}/activity$`), (r) => dialer(r) && can(r, 'audit.read')],
  // Only a redirect to the Call log with its Soft phone chip on (CL11): the Call log's gate. Search offers the chip itself.
  [new RegExp(`^/agency/campaigns/${ID}/manual-calls$`), (r) => dialer(r) && can(r, 'agency.supervise')],
  [new RegExp(`^/agency/campaigns/${ID}$`), (r) => dialer(r) && can(r, 'agency.campaigns.read')],
  [new RegExp(`^/agency/campaigns/${ID}/calls/live$`), (r) => dialer(r) && r.flags.has('agency_live_listen_enabled') && can(r, 'agency.supervise')],
  [/^\/agency\/live$/, (r) => dialer(r) && r.flags.has('agency_live_listen_enabled') && can(r, 'agency.supervise')],
  // Not behind the listening flag (LS19, amended 2026-11-17): past listens stay visible.
  [/^\/agency\/listening-history$/, (r) => dialer(r) && can(r, 'agency.supervise')],
  // `AllCallsPage` checks `agency.supervise` (the server's floor on `GET /calls`); behind no call type's flag (CL34).
  [/^\/agency\/calls$/, (r) => dialer(r) && can(r, 'agency.supervise')],
  [/^\/agency\/inbound\/missed$/, (r) => dialer(r) && r.missed && can(r, 'agency.campaigns.read')],
  [/^\/agency\/inbound\/summary$/, (r) => dialer(r) && r.missed && can(r, 'agency.supervise')],
  [/^\/agency\/analytics$/, (r) => dialer(r) && can(r, 'agency.campaigns.read')],
  // `CompareAgentsPage` checks `agency.supervise` (CP3) under `RequireFlag agency_compare_enabled`.
  [/^\/agency\/compare$/, (r) => dialer(r) && r.flags.has('agency_compare_enabled') && can(r, 'agency.supervise')],
  // `TeamPerformancePage` checks `agency.supervise` (TP3) under `RequireFlag agency_team_performance_enabled`.
  [/^\/agency\/team-performance$/, (r) => dialer(r) && r.flags.has('agency_team_performance_enabled') && can(r, 'agency.supervise')],
  // `ReportsPage` sends a dedicated agent to `/dialer/reports`.
  [/^\/agency\/reports$/, (r) => dialer(r) && r.flags.has('agency_reports_enabled') && can(r, 'agency.campaigns.read') && !isDedicatedAgent(r.role)],
  [/^\/agency\/dnc$/, (r) => dialer(r) && can(r, 'agency.dnc.read')],
  [/^\/agency\/customers$/, (r) => dialer(r) && can(r, 'agency.customer_history.read')],
  // The agent's workspace (`App.tsx`: `RequireCapability agency`, `RequireFlag agency_dialer_enabled`).
  [/^\/dialer$/, (r) => dialer(r) && can(r, 'agency.station.connect')],
  [/^\/settings$/, keptInShell],
  [/^\/settings\/(profile|notifications|team|accounts)$/, keptInShell],
  // `CallsSettingsPage` checks `agency.calls.manage`; behind neither the soft phone's flag nor inbound's.
  [/^\/settings\/calls$/, (r) => keptInShell(r) && r.caps.has('agency') && can(r, 'agency.calls.manage')],
  [/^\/settings\/softphone$/, (r) => keptInShell(r) && r.caps.has('agency') && r.flags.has('agency_softphone_enabled') && can(r, 'agency.softphone.dial')],
  [/^\/settings\/inbound$/, (r) => keptInShell(r) && r.caps.has('agency') && r.flags.has('agency_inbound_enabled') && can(r, 'agency.inbound.write')],
  // Read-only, so shown whether listening is on or off (it says which).
  [/^\/settings\/listening$/, (r) => keptInShell(r) && r.caps.has('agency') && can(r, 'agency.supervise')],
  // The pages check `agency.campaign_templates.manage`; the organisation's, an organisation-wide seat of tenant admin or above.
  [/^\/settings\/campaign-templates$/, (r) => keptInShell(r) && r.caps.has('agency') && r.flags.has('agency_campaign_templates_enabled') && can(r, 'agency.campaign_templates.manage')],
  [/^\/settings\/organisation-campaign-templates$/, (r) => keptInShell(r) && r.caps.has('agency') && r.flags.has('agency_campaign_templates_enabled')
    && can(r, 'agency.campaign_templates.manage') && r.organisationWide && (r.role === 'tenant_admin' || r.role === 'tenant_owner')],
  [/^\/settings\/call-summaries$/, (r) => keptInShell(r) && r.caps.has('agency.analytics') && r.flags.has('agency_call_analysis') && can(r, 'agency.analysis_profiles.read')],
];

function reaches(r: Reader, to: string): boolean {
  const path = to.split('#')[0]!.split('?')[0]!;
  const rule = ROUTES.find(([pattern]) => pattern.test(path));
  if (!rule) throw new Error(`No route rule for ${path}`);
  return rule[1](r);
}

/* ── What the shell offers ───────────────────────────────────────────────── */

const CAMPAIGNS = [{ id: 'c-1', name: 'Diwali renewals' }];

/** One query per thing search can offer: every page and setting, every campaign screen and section, a number. */
const QUERIES = [
  '',
  'diwali',
  '98765 43210',
  ...CAMPAIGN_TABS.map((t) => `diwali ${t.label}`),
  ...CAMPAIGN_SETTINGS_SECTIONS.map((s) => `diwali ${s.label}`),
];

function searchTargets(r: Reader): string[] {
  const results: SearchResult[] = QUERIES.flatMap((query) =>
    searchConsole({ query, gate: gateInput(r), accountId: 'a-1', defaultCallingCode: '+91', campaigns: CAMPAIGNS })
      .groups.flatMap((g) => g.results),
  );
  // A number opens customer history inside the shell.
  return results.map((res) => (res.target.type === 'path' ? res.target.to : '/agency/customers'));
}

/**
 * Each reader's offers, worked out once: the per-role sweeps and the App.tsx read walk the same
 * readers, and search over every query is the costly part.
 */
const OFFERS = new Map<Reader, { from: string; to: string }[]>();

function offers(r: Reader): { from: string; to: string }[] {
  const held = OFFERS.get(r);
  if (held) return held;
  const out = offersOf(r);
  OFFERS.set(r, out);
  return out;
}

function offersOf(r: Reader): { from: string; to: string }[] {
  const gate = gateInput(r);
  const out: { from: string; to: string }[] = [];
  for (const { section, href } of visibleSections(gate)) out.push({ from: `sidebar ${section.id}`, to: href });
  for (const section of CONSOLE_SECTIONS) {
    for (const tab of section.tabs) {
      for (const shown of tabBarFor(tab.to, gate)?.tabs ?? []) out.push({ from: `tab bar on ${tab.to}`, to: shown.to });
    }
  }
  if (passesGate(SETTINGS_GATE, gate)) {
    out.push({ from: 'sidebar settings', to: '/settings' });
    out.push({ from: '/settings landing', to: settingsLandingPath(gate, null) ?? '/settings/profile' });
  }
  for (const group of visibleSettingsGroups(gate)) for (const e of group.entries) out.push({ from: `settings ${e.id}`, to: e.path });
  if (passesGate(CAMPAIGNS_GATE, gate)) out.push({ from: 'settings hub hint', to: '/agency/campaigns' });
  if (passesGate(HOME_GATE, gate)) out.push({ from: 'email notifications aside', to: HOME_PATH });
  for (const to of searchTargets(r)) out.push({ from: 'search', to });
  return out;
}

function describeReader(r: Reader): string {
  return `${r.role ?? 'unresolved'} flags=[${[...r.flags].join(',')}] caps=[${[...r.caps].join(',')}] missed=${r.missed} organisationWide=${r.organisationWide}`;
}

describe('every offer passes the gate of the route it opens', () => {
  it.each(ROLES.map((role) => [role ?? 'unresolved', role] as const))(
    '%s, for every flag × capability × missed-calls rule',
    (_name, role) => {
      const readers = READERS.filter((r) => r.role === role);
      const failures: string[] = [];
      let checked = 0;
      for (const r of readers) {
        for (const { from, to } of offers(r)) {
          checked += 1;
          if (!reaches(r, to)) failures.push(`${describeReader(r)}: ${from} → ${to}`);
        }
      }
      expect(failures.slice(0, 20)).toEqual([]);
      // The sweep reached destinations, not only an empty shell (the unresolved role is offered Settings).
      expect(checked).toBeGreaterThan(readers.length);
    },
    // A backstop on a loaded machine, not the budget: alone, the largest role takes 2 to 3 seconds.
    30_000,
  );

  it('varies the seat only where a gate can read it: behind the campaign templates flag', () => {
    // The sweep sweeps an organisation-wide seat only for readers with that flag (organisationSeatsFor).
    // A gate that asks for the seat without the flag would be checked for one seat only: say so here.
    const seated: Array<{ organisationSeat?: unknown; flags?: readonly string[] }> = [];
    const walk = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value !== null && typeof value === 'object') {
        if ('organisationSeat' in value) seated.push(value as (typeof seated)[number]);
        Object.values(value).forEach(walk);
      }
    };
    walk([SETTINGS_ENTRIES, CONSOLE_SECTIONS]);
    expect(seated.length).toBeGreaterThan(0);
    for (const gate of seated) expect(gate.flags ?? []).toContain('agency_campaign_templates_enabled');
  });

  it('offers the dialler to whoever takes calls but does not supervise', () => {
    const everything = (role: Role) => READERS.find((r) => r.role === role && r.missed && r.flags.size === FLAGS.length && r.caps.size === CAPABILITIES.length)!;
    for (const role of ['viewer', 'operator', 'agent'] as const) {
      expect(offers(everything(role)).map((o) => o.to), role).toContain('/dialer');
    }
    for (const role of ['account_admin', 'tenant_admin', 'tenant_owner'] as const) {
      expect(offers(everything(role)).map((o) => o.to), role).not.toContain('/dialer');
    }
  });

  it('covers every route search and the sidebar can offer', () => {
    const all = READERS.filter((r) => r.role === 'tenant_owner' && r.missed && r.organisationWide && r.flags.size === FLAGS.length && r.caps.size === CAPABILITIES.length);
    const targets = new Set(all.flatMap((r) => offers(r).map((o) => o.to.split('#')[0])));
    for (const path of [
      '/agency/home', '/agency/callbacks', '/agency/campaigns', '/agency/campaigns/new', '/agency/campaigns/archived', '/agency/calls', '/agency/inbound/missed',
      '/agency/inbound/summary', '/agency/team-performance', '/agency/analytics', '/agency/compare', '/agency/reports', '/agency/dnc', '/agency/customers',
      '/agency/campaigns/c-1/attempts', '/agency/campaigns/c-1/activity', '/agency/campaigns/c-1/attempts?type=soft_phone',
      '/agency/campaigns/c-1/settings', '/agency/live', '/agency/listening-history', '/agency/campaigns/c-1/calls/live', '/settings', '/settings/profile', '/settings/softphone', '/settings/inbound',
      '/settings/call-summaries', '/settings/listening', '/settings/team', '/settings/accounts',
      '/settings/campaign-templates', '/settings/organisation-campaign-templates',
    ]) {
      expect(targets, path).toContain(path);
    }
  });

  /**
   * The rules above are written by hand, so they cannot tell whether `App.tsx` routes a path
   * at all: a tab whose route was never added passed them and opened "Page not found". This
   * reads the real route table.
   */
  it('routes every path the shell offers, in App.tsx itself', () => {
    const declared = declaredPaths();
    // Not vacuous: the table really was read.
    expect(declared).toContain('/agency/campaigns');
    expect(declared.length).toBeGreaterThan(30);
    const offered = new Set(READERS.flatMap((r) => offers(r).map((o) => o.to.split('#')[0]!.split('?')[0]!)));
    expect(offered.size).toBeGreaterThan(25);
    const unrouted = [...offered].filter((path) => !isDeclared(path, declared));
    expect(unrouted).toEqual([]);
  // It walks every reader's offers: held from the sweeps above, else worked out here (run alone).
  }, 30_000);

  it('routes every path the hand-written rules name, so a rule cannot outlive its route', () => {
    const declared = declaredPaths();
    for (const path of [
      '/agency/home', '/agency/callbacks', '/agency/calls', '/agency/listening-history', '/agency/live', '/agency/inbound/missed',
      '/agency/inbound/summary', '/agency/team-performance', '/agency/analytics', '/agency/compare', '/agency/reports', '/agency/dnc', '/agency/customers',
      '/agency/campaigns/c-1/manual-calls', '/agency/softphone', '/dialer', '/settings/calls', '/settings/listening',
    ]) {
      expect(isDeclared(path, declared), path).toBe(true);
    }
  });
});

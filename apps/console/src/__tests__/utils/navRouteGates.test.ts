import { describe, it, expect } from 'vitest';
import {
  CONSOLE_SECTIONS,
  HOME_GATE,
  HOME_PATH,
  SETTINGS_GATE,
  passesGate,
  settingsLandingPath,
  tabBarFor,
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
] as const;
const CAPABILITIES = ['agency', 'agency.analytics'] as const;
const ROLES: (Role | undefined)[] = ['tenant_owner', 'tenant_admin', 'account_admin', 'operator', 'viewer', 'agent', undefined];

interface Reader {
  role: Role | undefined;
  flags: ReadonlySet<string>;
  caps: ReadonlySet<string>;
  missed: boolean;
}

function gateInput(r: Reader): GateInput {
  return {
    role: r.role,
    isFlagEnabled: (f) => r.flags.has(f),
    isCapabilityEnabled: (c) => r.caps.has(c),
    missedAvailable: r.missed,
  };
}

function subsets<T>(items: readonly T[]): T[][] {
  return items.reduce<T[][]>((all, item) => all.flatMap((s) => [s, [...s, item]]), [[]]);
}

const READERS: Reader[] = ROLES.flatMap((role) =>
  subsets(FLAGS).flatMap((flags) =>
    subsets(CAPABILITIES).flatMap((caps) =>
      [true, false].map((missed) => ({ role, flags: new Set(flags), caps: new Set(caps), missed })),
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
  [/^\/agency\/campaigns$/, (r) => dialer(r) && can(r, 'agency.campaigns.read')],
  [/^\/agency\/campaigns\/new$/, (r) => dialer(r) && can(r, 'agency.campaigns.write')],
  [new RegExp(`^/agency/campaigns/${ID}/(overview|calls|callbacks|health|contacts|attempts|settings)$`), (r) => dialer(r) && can(r, 'agency.supervise')],
  [new RegExp(`^/agency/campaigns/${ID}/agents$`), (r) => dialer(r) && can(r, 'agency.campaigns.read')],
  [new RegExp(`^/agency/campaigns/${ID}/activity$`), (r) => dialer(r) && can(r, 'audit.read')],
  [new RegExp(`^/agency/campaigns/${ID}/manual-calls$`), (r) => dialer(r) && r.flags.has('agency_softphone_enabled') && can(r, 'agency.supervise')],
  [new RegExp(`^/agency/campaigns/${ID}$`), (r) => dialer(r) && can(r, 'agency.campaigns.read')],
  [/^\/agency\/softphone$/, (r) => dialer(r) && r.flags.has('agency_softphone_enabled') && can(r, 'agency.supervise')],
  [/^\/agency\/inbound\/missed$/, (r) => dialer(r) && r.missed && can(r, 'agency.campaigns.read')],
  [/^\/agency\/inbound\/summary$/, (r) => dialer(r) && r.missed && can(r, 'agency.supervise')],
  [/^\/agency\/analytics$/, (r) => dialer(r) && can(r, 'agency.campaigns.read')],
  // `ReportsPage` sends a dedicated agent to `/dialer/reports`.
  [/^\/agency\/reports$/, (r) => dialer(r) && r.flags.has('agency_reports_enabled') && can(r, 'agency.campaigns.read') && !isDedicatedAgent(r.role)],
  [/^\/agency\/dnc$/, (r) => dialer(r) && can(r, 'agency.dnc.read')],
  [/^\/agency\/customers$/, (r) => dialer(r) && can(r, 'agency.customer_history.read')],
  // The agent's workspace (`App.tsx`: `RequireCapability agency`, `RequireFlag agency_dialer_enabled`).
  [/^\/dialer$/, (r) => dialer(r) && can(r, 'agency.station.connect')],
  [/^\/settings$/, keptInShell],
  [/^\/settings\/(profile|notifications|team|accounts)$/, keptInShell],
  [/^\/settings\/softphone$/, (r) => keptInShell(r) && r.caps.has('agency') && r.flags.has('agency_softphone_enabled') && can(r, 'agency.softphone.dial')],
  [/^\/settings\/inbound$/, (r) => keptInShell(r) && r.caps.has('agency') && r.flags.has('agency_inbound_enabled') && can(r, 'agency.inbound.write')],
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

function offers(r: Reader): { from: string; to: string }[] {
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
  return `${r.role ?? 'unresolved'} flags=[${[...r.flags].join(',')}] caps=[${[...r.caps].join(',')}] missed=${r.missed}`;
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
  );

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
    const all = READERS.filter((r) => r.role === 'tenant_owner' && r.missed && r.flags.size === FLAGS.length && r.caps.size === CAPABILITIES.length);
    const targets = new Set(all.flatMap((r) => offers(r).map((o) => o.to.split('#')[0])));
    for (const path of [
      '/agency/home', '/agency/campaigns', '/agency/campaigns/new', '/agency/softphone', '/agency/inbound/missed',
      '/agency/inbound/summary', '/agency/analytics', '/agency/reports', '/agency/dnc', '/agency/customers',
      '/agency/campaigns/c-1/attempts', '/agency/campaigns/c-1/activity', '/agency/campaigns/c-1/manual-calls',
      '/agency/campaigns/c-1/settings', '/settings', '/settings/profile', '/settings/softphone', '/settings/inbound',
      '/settings/call-summaries', '/settings/team', '/settings/accounts',
    ]) {
      expect(targets, path).toContain(path);
    }
  });
});

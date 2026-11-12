import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Who is offered the soft phone, and where (`docs/softphone.md` §7, SP4):
 * nothing anywhere while `agency_softphone_enabled` is off; with it on, every
 * agent gets "Soft phone" in their screens, supervisors get "Soft-phone calls"
 * and each campaign's Call log gains its "Soft-phone calls" view (IN14), and the
 * settings sit with the account's.
 */

const mocks = vi.hoisted(() => ({ useTenant: vi.fn(), flags: new Set<string>() }));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: (flag: string) => mocks.flags.has(flag) }),
}));

import { AgentNav } from '../../components/agency/AgentNav';
import { settingsEntry, tabBarFor, visibleSettingsGroups, type GateInput } from '../../utils/consoleNav';
import { CallLogViews } from '../../components/agency/CallLogViews';
import { agentSurfacesFor, AGENT_SURFACES } from '../../utils/agencyAgentSurfaces';
import { visibleCallLogViews } from '../../utils/agencyCampaignTabs';

function as(role: string | undefined, flagOn: boolean) {
  mocks.useTenant.mockReturnValue({ role });
  mocks.flags = new Set(flagOn ? ['agency_softphone_enabled'] : []);
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('the agent nav', () => {
  it('offers the soft phone second, to an agent, only with the flag on', () => {
    as('agent', true);
    render(<MemoryRouter><AgentNav current="campaigns" /></MemoryRouter>);
    const ids = screen.getAllByTestId(/^agent-nav-/).map((el) => el.getAttribute('data-testid'));
    // Customer history (`agent-nav-customers`) closes the list for every agent (CH1).
    expect(ids).toEqual([
      'agent-nav-campaigns', 'agent-nav-phone', 'agent-nav-performance', 'agent-nav-attempts', 'agent-nav-customers',
    ]);
    expect(screen.getByTestId('agent-nav-phone').getAttribute('href')).toBe('/dialer/phone');
  });

  it('is unchanged with the flag off', () => {
    as('agent', false);
    render(<MemoryRouter><AgentNav current="campaigns" /></MemoryRouter>);
    expect(screen.queryByTestId('agent-nav-phone')).toBeNull();
  });

  it('fails closed with no role resolved', () => {
    as(undefined, true);
    render(<MemoryRouter><AgentNav current="campaigns" /></MemoryRouter>);
    expect(screen.queryByTestId('agent-nav-phone')).toBeNull();
    expect(screen.queryByTestId('agent-nav-customers')).toBeNull();
  });

  it('offers customer history to an agent, at /dialer/customers, flag or not', () => {
    as('agent', false);
    render(<MemoryRouter><AgentNav current="campaigns" /></MemoryRouter>);
    const link = screen.getByTestId('agent-nav-customers');
    expect(link.getAttribute('href')).toBe('/dialer/customers');
    expect(link.textContent).toContain('Search a number');
  });

  it('keeps the fixed three as the map the station pins its links against', () => {
    expect(agentSurfacesFor({ softphone: false })).toBe(AGENT_SURFACES);
    expect(agentSurfacesFor({ softphone: true }).map((s) => s.id)).toEqual(['campaigns', 'phone', 'performance', 'attempts']);
    expect(agentSurfacesFor({ softphone: false, customers: true }).map((s) => s.id)).toEqual([
      'campaigns', 'performance', 'attempts', 'customers',
    ]);
  });
});

describe('the console navigation', () => {
  const gates = (role: string | undefined, flagOn: boolean): GateInput => ({
    role: role as GateInput['role'],
    isFlagEnabled: (f) => f === 'agency_dialer_enabled' || (flagOn && f === 'agency_softphone_enabled'),
    isCapabilityEnabled: () => true,
  });
  const campaignTabs = (role: string | undefined, flagOn: boolean) =>
    tabBarFor('/agency/campaigns', gates(role, flagOn))?.tabs.map((t) => t.label) ?? [];
  const settings = (role: string | undefined, flagOn: boolean) =>
    visibleSettingsGroups(gates(role, flagOn)).flatMap((g) => g.entries.map((e) => e.label));

  it('adds Soft-phone calls beside Campaigns and the Soft phone setting for an account admin with the flag on', () => {
    expect(campaignTabs('account_admin', true)).toEqual(['Campaigns', 'Soft-phone calls']);
    expect(settings('account_admin', true)).toContain('Soft phone');
  });

  it('adds nothing with the flag off', () => {
    expect(campaignTabs('account_admin', false)).toEqual([]);
    expect(settings('account_admin', false)).not.toContain('Soft phone');
  });

  it('offers an agent no Soft-phone calls, flag or not', () => {
    expect(campaignTabs('agent', true)).toEqual([]);
  });
});

describe('a campaign’s Call log', () => {
  it('offers Soft-phone calls to a supervisor only with the flag on, after Dialler calls', () => {
    expect(visibleCallLogViews('account_admin').map((v) => v.id)).not.toContain('manual');
    const on = visibleCallLogViews('account_admin', (flag) => flag === 'agency_softphone_enabled').map((v) => v.id);
    expect(on).toEqual(['attempts', 'manual']);
    expect(visibleCallLogViews('viewer', () => true).map((v) => v.id)).not.toContain('manual');
  });

  it('renders it as a view linking to the campaign’s manual calls', () => {
    as('account_admin', true);
    render(<MemoryRouter><CallLogViews campaignId="camp-1" active="manual" role="account_admin" /></MemoryRouter>);
    const view = screen.getByTestId('call-log-view-manual');
    // Named as the sidebar names the same calls.
    expect(view.textContent).toBe('Soft-phone calls');
    expect(view.getAttribute('href')).toBe('/agency/campaigns/camp-1/manual-calls');
    expect(view.getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('call-log-view-attempts').getAttribute('href')).toBe('/agency/campaigns/camp-1/attempts');
    expect(screen.getByTestId('call-log-view-attempts').getAttribute('aria-current')).toBeNull();
  });

  it('renders no views with the flag off: Dialler calls alone is nothing to choose', () => {
    as('account_admin', false);
    render(<MemoryRouter><CallLogViews campaignId="camp-1" active="attempts" role="account_admin" /></MemoryRouter>);
    expect(screen.queryByTestId('call-log-views')).toBeNull();
  });
});

describe('the routes', () => {
  const app = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
  /** From the route's path to the first self-closing tag — its page — so every gate around the page is inside. */
  const routeBlock = (path: string, from = 0) => {
    const start = app.indexOf(`path="${path}"`, from);
    expect(start, path).toBeGreaterThan(-1);
    return app.slice(start, app.indexOf('/>', start));
  };

  it('gates /dialer/phone like /station, outside the console shell; the page reads the soft-phone flag itself', () => {
    const block = routeBlock('/dialer/phone');
    expect(block).toContain('<RequireAuth>');
    expect(block).toContain('capability="agency"');
    expect(block).toContain('flag="agency_dialer_enabled"');
    // Not a route gate: turned off mid-call it would take the call off the
    // agent's screen. The page gates itself (finish mode, else unavailable) —
    // pinned in `SoftphonePage.test.tsx` "with the soft phone turned off".
    expect(block).not.toContain('flag="agency_softphone_enabled"');
    const page = readFileSync(resolve(process.cwd(), 'src/pages/agency/SoftphonePage.tsx'), 'utf8');
    expect(page).toContain('useFeatureFlagEnabled(SOFTPHONE_FLAG)');
    const shellBlock = app.slice(app.indexOf('<ConsoleShell />'), app.indexOf('<Route path="*"'));
    expect(shellBlock).not.toContain('dialer/phone');
  });

  it('puts every supervisor surface and the settings behind the flag', () => {
    for (const path of ['softphone', 'softphone/calls/:callId', 'campaigns/:id/manual-calls']) {
      expect(routeBlock(path)).toContain('flag="agency_softphone_enabled"');
    }
    const settings = routeBlock('softphone', app.indexOf('<Route path="/settings"'));
    expect(settings).toContain('<SoftphoneSettingsPage');
    // The Settings route's guards are its entry's gate (`RequireGate`).
    expect(settings).toContain("<RequireGate gate={settingsEntry('softphone').gate}>");
    expect(settingsEntry('softphone').gate.flags).toContain('agency_softphone_enabled');
  });
});

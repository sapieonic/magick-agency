import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Who is offered the soft phone, and where (`docs/softphone.md` §7, SP4):
 * nothing anywhere while `agency_softphone_enabled` is off; with it on, every
 * agent gets "Soft phone" in their screens, supervisors get "Soft-phone calls"
 * and each campaign's Call log gains its Soft phone chip (CL11), and the
 * settings sit with the account's.
 */

const mocks = vi.hoisted(() => ({ useTenant: vi.fn(), flags: new Set<string>() }));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: (flag: string) => mocks.flags.has(flag) }),
}));

import { AgentNav } from '../../components/agency/AgentNav';
import { settingsEntry, tabBarFor, visibleSettingsGroups, type GateInput } from '../../utils/consoleNav';
import { agentSurfacesFor, AGENT_SURFACES } from '../../utils/agencyAgentSurfaces';
import { CAMPAIGN_TABS, canOpenCampaignScreen } from '../../utils/agencyCampaignTabs';
import { visibleCallLogChips } from '../../utils/agency/callLog';

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
    // The Listening history is a supervisor's whatever the listening flag (off here; LS19 as amended).
    expect(campaignTabs('account_admin', true)).toEqual(['Campaigns', 'Soft-phone calls', 'Listening history']);
    expect(settings('account_admin', true)).toContain('Soft phone');
  });

  it('adds nothing with the flag off', () => {
    expect(campaignTabs('account_admin', false)).not.toContain('Soft-phone calls');
    expect(settings('account_admin', false)).not.toContain('Soft phone');
  });

  it('offers an agent no Soft-phone calls, flag or not', () => {
    expect(campaignTabs('agent', true)).toEqual([]);
  });
});

describe('a campaign’s Call log', () => {
  const flagOn = (flag: string) => flag === 'agency_softphone_enabled';

  it('offers the Soft phone chip with the flag on, after Dialler', () => {
    expect(visibleCallLogChips(null, 'all', { softphoneEnabled: true, inboundEnabled: false }).map((c) => c.id)).toEqual(['all', 'dialler', 'soft_phone']);
  });

  it('offers no chips with the flag off and no soft-phone call: Dialler alone is nothing to choose', () => {
    expect(visibleCallLogChips({ all: 4, dialler: 4, soft_phone: 0, inbound: 0, to_follow_up: 0 }, 'all', { softphoneEnabled: false, inboundEnabled: false })).toEqual([]);
  });

  it('keeps the chip with the flag off while the campaign holds soft-phone calls (SR5)', () => {
    expect(visibleCallLogChips({ all: 5, dialler: 4, soft_phone: 1, inbound: 0, to_follow_up: 0 }, 'all', { softphoneEnabled: false, inboundEnabled: false }).map((c) => c.id))
      .toEqual(['all', 'dialler', 'soft_phone']);
  });

  it('search offers a campaign’s soft-phone calls to a supervisor only with the flag on, as the Call log’s chip', () => {
    expect(canOpenCampaignScreen('manual', 'account_admin')).toBe(false);
    expect(canOpenCampaignScreen('manual', 'account_admin', flagOn)).toBe(true);
    expect(canOpenCampaignScreen('manual', 'viewer', () => true)).toBe(false);
    expect(CAMPAIGN_TABS.find((t) => t.id === 'manual')!.path('camp-1')).toBe('/agency/campaigns/camp-1/attempts?type=soft_phone');
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
    for (const path of ['softphone', 'softphone/calls/:callId']) {
      expect(routeBlock(path)).toContain('flag="agency_softphone_enabled"');
    }
    // A campaign's soft-phone calls are in its Call log (CL11): the old URL only redirects there.
    expect(routeBlock('campaigns/:id/manual-calls')).toContain('<CampaignManualCallsRedirect');
    const settings = routeBlock('softphone', app.indexOf('<Route path="/settings"'));
    expect(settings).toContain('<SoftphoneSettingsPage');
    // The Settings route's guards are its entry's gate (`RequireGate`).
    expect(settings).toContain("<RequireGate gate={settingsEntry('softphone').gate}>");
    expect(settingsEntry('softphone').gate.flags).toContain('agency_softphone_enabled');
  });
});

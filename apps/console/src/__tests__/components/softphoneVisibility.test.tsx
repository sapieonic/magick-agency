import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Who is offered the soft phone, and where (`docs/softphone.md` §7, SP4):
 * nothing anywhere while `agency_softphone_enabled` is off; with it on, every
 * agent gets "Soft phone" in their screens, supervisors get "Soft-phone calls"
 * and each campaign's "Manual calls", and the settings sit with the account's.
 */

const mocks = vi.hoisted(() => ({ useTenant: vi.fn(), flags: new Set<string>() }));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: (flag: string) => mocks.flags.has(flag) }),
}));

import { AgentNav } from '../../components/agency/AgentNav';
import { AgencySidebar } from '../../components/layout/AgencySidebar';
import { CampaignTabs } from '../../components/agency/CampaignTabs';
import { agentSurfacesFor, AGENT_SURFACES } from '../../utils/agencyAgentSurfaces';
import { visibleCampaignTabs } from '../../utils/agencyCampaignTabs';

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
    expect(ids).toEqual(['agent-nav-campaigns', 'agent-nav-phone', 'agent-nav-performance', 'agent-nav-attempts']);
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
  });

  it('keeps the fixed three as the map the station pins its links against', () => {
    expect(agentSurfacesFor({ softphone: false })).toBe(AGENT_SURFACES);
    expect(agentSurfacesFor({ softphone: true }).map((s) => s.id)).toEqual(['campaigns', 'phone', 'performance', 'attempts']);
  });
});

describe('the agency sidebar', () => {
  const labels = () => screen.queryAllByRole('link').map((a) => (a.textContent ?? '').trim());

  it('adds Soft-phone calls and the settings for an account admin with the flag on', () => {
    as('account_admin', true);
    render(<MemoryRouter><AgencySidebar /></MemoryRouter>);
    expect(labels()).toContain('Soft-phone calls');
    expect(labels()).toContain('Soft phone settings');
  });

  it('adds nothing with the flag off', () => {
    as('account_admin', false);
    render(<MemoryRouter><AgencySidebar /></MemoryRouter>);
    expect(labels()).not.toContain('Soft-phone calls');
    expect(labels()).not.toContain('Soft phone settings');
  });

  it('offers an agent nothing here, flag or not', () => {
    as('agent', true);
    render(<MemoryRouter><AgencySidebar /></MemoryRouter>);
    expect(labels()).toEqual([]);
  });
});

describe('the campaign tabs', () => {
  it('show Manual calls to a supervisor only with the flag on, after Call attempts', () => {
    expect(visibleCampaignTabs('account_admin').map((t) => t.id)).not.toContain('manual');
    const on = visibleCampaignTabs('account_admin', (flag) => flag === 'agency_softphone_enabled').map((t) => t.id);
    expect(on.indexOf('manual')).toBe(on.indexOf('attempts') + 1);
    expect(visibleCampaignTabs('viewer', () => true).map((t) => t.id)).not.toContain('manual');
  });

  it('render it as a link to the campaign’s manual calls', () => {
    as('account_admin', true);
    render(<MemoryRouter><CampaignTabs campaignId="camp-1" active="manual" role="account_admin" /></MemoryRouter>);
    const tab = screen.getByTestId('campaign-tab-manual');
    // Named as the sidebar names the same calls.
    expect(tab.textContent).toContain('Soft-phone calls');
    expect(tab.getAttribute('href')).toBe('/agency/campaigns/camp-1/manual-calls');
    expect(tab.getAttribute('aria-current')).toBe('page');
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

  it('gates /dialer/phone like /station, plus the soft-phone flag, outside both shells', () => {
    const block = routeBlock('/dialer/phone');
    expect(block).toContain('<RequireAuth>');
    expect(block).toContain('capability="agency"');
    expect(block).toContain('flag="agency_dialer_enabled"');
    expect(block).toContain('flag="agency_softphone_enabled"');
    const appBlock = app.slice(app.indexOf('<Route path="/app"'), app.indexOf('<Route path="*"'));
    expect(appBlock).not.toContain('dialer/phone');
  });

  it('puts every supervisor surface and the settings behind the flag', () => {
    for (const path of ['softphone', 'softphone/calls/:callId', 'campaigns/:id/manual-calls']) {
      expect(routeBlock(path)).toContain('flag="agency_softphone_enabled"');
    }
    const settings = routeBlock('softphone', app.indexOf('<Route path="/app"'));
    expect(settings).toContain('<SoftphoneSettingsPage');
    expect(settings).toContain('flag="agency_softphone_enabled"');
  });
});

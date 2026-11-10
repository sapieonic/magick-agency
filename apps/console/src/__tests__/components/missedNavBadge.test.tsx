import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Missed calls in the navigation (`docs/inbound.md` §8.4): the entry carries the open count for
 * the caller's scope as a badge (the agency sidebar and the agent's nav), "99+" past the cap; the
 * entry and the inbound summary stay while inbound is switched off if there are rows to read, and
 * go when there are none; a role without `agency.inbound.read` reads no count at all.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  flags: {} as Record<string, boolean>,
  getMissedInboundCount: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../hooks/useFeatureFlagEnabled', () => ({
  SOFTPHONE_FLAG: 'agency_softphone_enabled',
  useFeatureFlagEnabled: (flag: string) => mocks.flags[flag] === true,
}));
vi.mock('../../hooks/useReportsAccess', () => ({ useReportsAccess: () => ({ enabled: false, canSelf: false }) }));
vi.mock('../../api/inbound', () => ({ getMissedInboundCount: mocks.getMissedInboundCount }));

import { AgencySidebar } from '../../components/layout/AgencySidebar';
import { AgentNav } from '../../components/agency/AgentNav';
import { resetMissedCallsCountForTests } from '../../hooks/useMissedCallsCount';

async function renderWith(node: React.ReactNode, role: string) {
  mocks.useTenant.mockReturnValue({ role, tenantId: 't-1', accountId: 'a-1' });
  render(<MemoryRouter>{node}</MemoryRouter>);
  await act(async () => {});
}

const labels = () => screen.queryAllByRole('link').map((a) => a.getAttribute('href'));

beforeEach(() => {
  vi.clearAllMocks();
  resetMissedCallsCountForTests();
  mocks.flags = { agency_inbound_enabled: true };
  mocks.getMissedInboundCount.mockResolvedValue({ open: 4, open_capped: false, has_rows: true });
});
afterEach(() => cleanup());

describe('the agency sidebar', () => {
  it('badges Missed calls with the open count, says it to a screen reader, and offers the summary to a supervisor', async () => {
    await renderWith(<AgencySidebar />, 'account_admin');
    const missed = screen.getByRole('link', { name: /Missed calls/ });
    expect(within(missed).getByTestId('sidebar-missed-badge').textContent).toBe('4, 4 to follow up');
    expect(missed.textContent).toBe('Missed calls4, 4 to follow up');
    expect(labels()).toContain('/agency/inbound/summary');
    expect(mocks.getMissedInboundCount).toHaveBeenCalledWith('t-1', 'a-1');
  });

  it('shows 99+ past the cap, and no badge with nothing open', async () => {
    mocks.getMissedInboundCount.mockResolvedValue({ open: 100, open_capped: true, has_rows: true });
    await renderWith(<AgencySidebar />, 'account_admin');
    expect(screen.getByTestId('sidebar-missed-badge').textContent).toBe('99+, more than 99 to follow up');
    cleanup();
    resetMissedCallsCountForTests();
    mocks.getMissedInboundCount.mockResolvedValue({ open: 0, open_capped: false, has_rows: true });
    await renderWith(<AgencySidebar />, 'account_admin');
    expect(screen.getByRole('link', { name: 'Missed calls' })).toBeTruthy();
    expect(screen.queryByTestId('sidebar-missed-badge')).toBeNull();
  });

  it('keeps Missed calls and the summary with inbound off while there are rows, and drops them when there are none', async () => {
    mocks.flags = {};
    await renderWith(<AgencySidebar />, 'account_admin');
    expect(labels()).toEqual(expect.arrayContaining(['/agency/inbound/missed', '/agency/inbound/summary']));
    cleanup();
    resetMissedCallsCountForTests();
    mocks.getMissedInboundCount.mockResolvedValue({ open: 0, open_capped: false, has_rows: false });
    await renderWith(<AgencySidebar />, 'account_admin');
    expect(labels()).not.toContain('/agency/inbound/missed');
    expect(labels()).not.toContain('/agency/inbound/summary');
  });

  it('gives a viewer the list but not the summary (agency.supervise)', async () => {
    await renderWith(<AgencySidebar />, 'viewer');
    expect(labels()).toContain('/agency/inbound/missed');
    expect(labels()).not.toContain('/agency/inbound/summary');
  });
});

describe('the agent`s nav', () => {
  it('badges their own Missed calls, current or not', async () => {
    await renderWith(<AgentNav current="campaigns" />, 'agent');
    expect(screen.getByTestId('agent-nav-missed-badge').textContent).toBe('4, 4 to follow up');
    cleanup();
    await renderWith(<AgentNav current="missed" />, 'agent');
    expect(within(screen.getByTestId('agent-nav-missed')).getByTestId('agent-nav-missed-badge')).toBeTruthy();
  });

  it('keeps Missed calls with inbound off while they have rows, and drops it when they have none', async () => {
    mocks.flags = {};
    await renderWith(<AgentNav current="campaigns" />, 'agent');
    expect(screen.getByTestId('agent-nav-missed')).toBeTruthy();
    cleanup();
    resetMissedCallsCountForTests();
    mocks.getMissedInboundCount.mockResolvedValue({ open: 0, open_capped: false, has_rows: false });
    await renderWith(<AgentNav current="campaigns" />, 'agent');
    expect(screen.queryByTestId('agent-nav-missed')).toBeNull();
  });
});

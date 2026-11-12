import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Missed calls in the navigation (`docs/inbound.md` §8.4): the entry carries the open count for
 * the caller's scope as a badge (the agent's nav here; the console sidebar's Inbound entry in
 * `ConsoleSidebar.test.tsx`), "99+" past the cap; the
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

describe('the agent`s nav', () => {
  it('badges their own Missed calls, current or not', async () => {
    await renderWith(<AgentNav current="campaigns" />, 'agent');
    expect(screen.getByTestId('agent-nav-missed-badge').textContent).toBe('4, 4 to follow up');
    // Their own rows (IQ57: assignee=me), never the Team view's.
    expect(mocks.getMissedInboundCount).toHaveBeenCalledWith('t-1', 'a-1', { assignee: 'me' });
    expect(mocks.getMissedInboundCount).not.toHaveBeenCalledWith('t-1', 'a-1', { assignee: 'unassigned' });
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

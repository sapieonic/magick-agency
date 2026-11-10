import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, within, fireEvent } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  flagOn: true,
  getInboundQueue: vi.fn(),
}));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../hooks/useFeatureFlagEnabled', () => ({ useFeatureFlagEnabled: () => mocks.flagOn }));
vi.mock('../../api/inbound', () => ({ getInboundQueue: mocks.getInboundQueue }));

import { InboundQueueTiles, tileNeedsAttention, tileOpenWithNobody } from '../../components/agency/inbound/InboundQueueTiles';
import { INBOUND_QUEUE_POLL_MS } from '../../hooks/useInboundQueue';
import { queueTile } from '../helpers/inbound';

/**
 * The supervisor's inbound queue tiles (P2, IQ23): one per live route, read every 5 s while the
 * page is visible, the last good numbers kept (and said to be stale) when a read fails, nothing
 * at all without the flag or `agency.supervise`.
 */

async function mount(role = 'account_admin') {
  mocks.useTenant.mockReturnValue({ tenantId: 't-1', accountId: 'a-1', role });
  render(<InboundQueueTiles />);
  await act(async () => {});
}

beforeEach(() => {
  mocks.getInboundQueue.mockReset();
  mocks.flagOn = true;
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('InboundQueueTiles', () => {
  it('shows each route: open or closed, waiting, the longest wait, with an agent, agents free', async () => {
    mocks.getInboundQueue.mockResolvedValue({
      tiles: [queueTile(), queueTile({ route_id: 'r-2', route_name: 'Sales', open_now: false, waiting: 0, longest_wait_seconds: 0 })],
    });
    await mount();
    const care = within(screen.getByTestId('inbound-queue-tile-r-1'));
    expect(care.getByText('Customer care')).toBeTruthy();
    expect(care.getByText('Open')).toBeTruthy();
    expect(care.getByTestId('tile-waiting').textContent).toBe('2');
    expect(care.getByTestId('tile-longest').textContent).toBe('1:15');
    expect(care.getByTestId('tile-connected').textContent).toBe('3');
    expect(care.getByTestId('tile-eligible').textContent).toBe('1');
    const sales = within(screen.getByTestId('inbound-queue-tile-r-2'));
    expect(sales.getByText('Closed')).toBeTruthy();
    expect(sales.getByTestId('tile-longest').textContent).toBe('—');
  });

  it('polls every 5 s', async () => {
    mocks.getInboundQueue.mockResolvedValue({ tiles: [queueTile()] });
    await mount();
    expect(mocks.getInboundQueue).toHaveBeenCalledTimes(1);
    mocks.getInboundQueue.mockResolvedValue({ tiles: [queueTile({ waiting: 5 })] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INBOUND_QUEUE_POLL_MS);
    });
    expect(mocks.getInboundQueue).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('tile-waiting').textContent).toBe('5');
    expect(INBOUND_QUEUE_POLL_MS).toBe(5_000);
  });

  it('keeps the last numbers when a read fails, and says they have stopped updating', async () => {
    mocks.getInboundQueue.mockResolvedValueOnce({ tiles: [queueTile()] }).mockRejectedValueOnce(new Error('down'));
    await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INBOUND_QUEUE_POLL_MS);
    });
    expect(screen.getByTestId('tile-waiting').textContent).toBe('2');
    expect(screen.getByTestId('inbound-queue-error').textContent).toMatch(/stopped updating/);
    mocks.getInboundQueue.mockResolvedValue({ tiles: [queueTile({ waiting: 0 })] });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    expect(screen.queryByTestId('inbound-queue-error')).toBeNull();
  });

  it('flags a route whose callers wait with nobody free, in words', async () => {
    mocks.getInboundQueue.mockResolvedValue({ tiles: [queueTile({ eligible_agents: 0 })] });
    await mount();
    expect(screen.getByTestId('tile-attention').textContent).toMatch(/no agent is free/);
    expect(tileNeedsAttention(queueTile({ waiting: 0, eligible_agents: 0 }))).toBe(false);
  });

  it('says when an open route has nobody who could take a call, ahead of anything else (PM-M6)', async () => {
    mocks.getInboundQueue.mockResolvedValue({
      tiles: [
        queueTile({ waiting: 0, eligible_agents: 0, no_agents_available: true }),
        queueTile({ route_id: 'r-2', route_name: 'Sales', open_now: false, waiting: 0, eligible_agents: 0, no_agents_available: true }),
      ],
    });
    await mount();
    const care = within(screen.getByTestId('inbound-queue-tile-r-1'));
    expect(care.getByTestId('tile-no-agents').textContent).toBe(
      'Open, but no one can take calls: callers go straight to Missed calls instead of waiting.',
    );
    expect(care.queryByTestId('tile-attention')).toBeNull();
    expect(screen.getByTestId('inbound-queue-tile-r-1').getAttribute('data-attention')).toBe('true');
    // Closed: nobody to take calls is expected, and says nothing.
    const sales = within(screen.getByTestId('inbound-queue-tile-r-2'));
    expect(sales.queryByTestId('tile-no-agents')).toBeNull();
    expect(screen.getByTestId('inbound-queue-tile-r-2').getAttribute('data-attention')).toBeNull();
    expect(tileOpenWithNobody(queueTile({ no_agents_available: true }))).toBe(true);
    expect(tileOpenWithNobody(queueTile({ no_agents_available: false }))).toBe(false);
  });

  it('says when no route is answering', async () => {
    mocks.getInboundQueue.mockResolvedValue({ tiles: [] });
    await mount();
    expect(screen.getByTestId('inbound-queue-empty')).toBeTruthy();
  });

  it('renders nothing and reads nothing without agency.supervise or the flag', async () => {
    await mount('agent');
    expect(screen.queryByTestId('inbound-queue')).toBeNull();
    mocks.flagOn = false;
    await mount('account_admin');
    expect(screen.queryByTestId('inbound-queue')).toBeNull();
    expect(mocks.getInboundQueue).not.toHaveBeenCalled();
  });
});

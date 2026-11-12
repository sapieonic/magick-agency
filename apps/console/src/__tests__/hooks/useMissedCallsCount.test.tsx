import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';

/**
 * The Missed calls badge's count (`hooks/useMissedCallsCount.ts`): one read shared by every reader
 * of the tab (the sidebar and the page mount together), a poll only while inbound is on, a
 * re-read on demand that moves every badge, a failed read that keeps the last answer and lets a
 * waiting page stop waiting, and the badge's text past the cap.
 */

const mocks = vi.hoisted(() => ({ getMissedInboundCount: vi.fn() }));
vi.mock('../../api/inbound', () => ({ getMissedInboundCount: mocks.getMissedInboundCount }));

import {
  MISSED_COUNT_POLL_MS,
  missedBadgeLabel,
  missedBadgeText,
  refreshMissedCallsCount,
  resetMissedCallsCountForTests,
  useMissedCallsCount,
} from '../../hooks/useMissedCallsCount';

function Reader({ id, poll = true, enabled = true, account = 'a-1', assignee }: { id: string; poll?: boolean; enabled?: boolean; account?: string; assignee?: string }) {
  const { count, settled } = useMissedCallsCount({ tenantId: 't-1', accountId: account, assignee, enabled, poll });
  return <span data-testid={id}>{`${count ? `${count.open}/${count.has_rows}` : 'none'}:${settled}`}</span>;
}

const text = (id: string) => screen.getByTestId(id).textContent;

beforeEach(() => {
  vi.useFakeTimers();
  resetMissedCallsCountForTests();
  mocks.getMissedInboundCount.mockReset();
  mocks.getMissedInboundCount.mockResolvedValue({ open: 3, open_capped: false, has_rows: true });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the shared count', () => {
  it('reads once for two readers of one account, and both show it', async () => {
    render(<><Reader id="a" /><Reader id="b" /></>);
    await act(async () => {});
    expect(mocks.getMissedInboundCount).toHaveBeenCalledTimes(1);
    expect(mocks.getMissedInboundCount).toHaveBeenCalledWith('t-1', 'a-1', {});
    expect(text('a')).toBe('3/true:true');
    expect(text('b')).toBe('3/true:true');
  });

  it('asks for the reader’s assignee (IQ57), keeps each scope’s answer apart, and re-reads it with that scope', async () => {
    mocks.getMissedInboundCount.mockImplementation(async (_t: string, _a: string, q: { assignee?: string }) => (
      q.assignee === 'me' ? { open: 1, open_capped: false, has_rows: true } : { open: 9, open_capped: false, has_rows: true }
    ));
    const { unmount } = render(<Reader id="mine" assignee="me" />);
    await act(async () => {});
    expect(mocks.getMissedInboundCount).toHaveBeenCalledWith('t-1', 'a-1', { assignee: 'me' });
    expect(text('mine')).toBe('1/true:true');
    mocks.getMissedInboundCount.mockClear();
    await act(async () => { refreshMissedCallsCount(); });
    expect(mocks.getMissedInboundCount).toHaveBeenCalledWith('t-1', 'a-1', { assignee: 'me' });
    unmount();
    // Another scope of the same account is never shown the first one's answer.
    render(<Reader id="all" />);
    await act(async () => {});
    expect(mocks.getMissedInboundCount).toHaveBeenLastCalledWith('t-1', 'a-1', {});
    expect(text('all')).toBe('9/true:true');
  });

  it('polls while inbound is on, and not while it is off', async () => {
    const { unmount } = render(<Reader id="on" />);
    await act(async () => {});
    mocks.getMissedInboundCount.mockResolvedValue({ open: 5, open_capped: false, has_rows: true });
    await act(async () => { vi.advanceTimersByTime(MISSED_COUNT_POLL_MS); });
    expect(text('on')).toBe('5/true:true');
    expect(mocks.getMissedInboundCount).toHaveBeenCalledTimes(2);
    unmount();

    resetMissedCallsCountForTests();
    mocks.getMissedInboundCount.mockClear();
    render(<Reader id="off" poll={false} />);
    await act(async () => {});
    await act(async () => { vi.advanceTimersByTime(MISSED_COUNT_POLL_MS * 3); });
    expect(mocks.getMissedInboundCount).toHaveBeenCalledTimes(1);
  });

  it('polls once a minute for the tab, however many readers poll', async () => {
    render(<Reader id="a" />);
    await act(async () => {});
    await act(async () => { vi.advanceTimersByTime(20_000); });
    render(<Reader id="b" />);
    await act(async () => {});
    // a polls, so b mounting 20 s later reuses a's answer.
    expect(mocks.getMissedInboundCount).toHaveBeenCalledTimes(1);
    // a ticks at 60 s and 120 s and reads; b ticks at 80 s and 140 s, inside a's minute, and does not.
    await act(async () => { await vi.advanceTimersByTimeAsync(130_000); });
    expect(mocks.getMissedInboundCount).toHaveBeenCalledTimes(3);
    expect(text('a')).toBe('3/true:true');
    expect(text('b')).toBe('3/true:true');
  });

  it('a reader mounting reuses the answer for the poll period while another polls, and for 10 s otherwise', async () => {
    const { unmount } = render(<Reader id="poller" />);
    await act(async () => {});
    await act(async () => { vi.advanceTimersByTime(50_000); });
    render(<Reader id="late" poll={false} />);
    await act(async () => {});
    expect(mocks.getMissedInboundCount).toHaveBeenCalledTimes(1);
    unmount();

    // Nobody polls now: past 10 s, a reader mounting reads again.
    await act(async () => { vi.advanceTimersByTime(5_000); });
    render(<Reader id="later" poll={false} />);
    await act(async () => {});
    expect(mocks.getMissedInboundCount).toHaveBeenCalledTimes(2);
  });

  it('a return to the tab reads once the count is 10 s old, even while a reader polls (the poll skips hidden ticks)', async () => {
    let visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    render(<Reader id="poller" />);
    await act(async () => {});
    expect(mocks.getMissedInboundCount).toHaveBeenCalledTimes(1);
    // Back within 10 s: the answer is fresh.
    await act(async () => { vi.advanceTimersByTime(5_000); });
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(mocks.getMissedInboundCount).toHaveBeenCalledTimes(1);
    // Hidden at 6 s, back at 50 s: no tick ran, and the count is 50 s old, so the return reads.
    visibility = 'hidden';
    await act(async () => { vi.advanceTimersByTime(44_000); });
    visibility = 'visible';
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(mocks.getMissedInboundCount).toHaveBeenCalledTimes(2);
  });

  it('re-reads on demand, and every reader follows', async () => {
    render(<><Reader id="a" /><Reader id="b" poll={false} /></>);
    await act(async () => {});
    mocks.getMissedInboundCount.mockResolvedValue({ open: 2, open_capped: false, has_rows: true });
    await act(async () => { refreshMissedCallsCount(); });
    expect(text('a')).toBe('2/true:true');
    expect(text('b')).toBe('2/true:true');
  });

  it('a failed read keeps the last answer, and a first read that fails still settles', async () => {
    render(<Reader id="a" />);
    await act(async () => {});
    mocks.getMissedInboundCount.mockRejectedValue(new Error('down'));
    await act(async () => { vi.advanceTimersByTime(MISSED_COUNT_POLL_MS); });
    expect(text('a')).toBe('3/true:true');

    resetMissedCallsCountForTests();
    render(<Reader id="b" account="a-2" />);
    await act(async () => {});
    expect(text('b')).toBe('none:true');
  });

  it('reads nothing while disabled, and never shows another account`s answer', async () => {
    const { rerender } = render(<Reader id="a" enabled={false} />);
    await act(async () => {});
    expect(mocks.getMissedInboundCount).not.toHaveBeenCalled();
    expect(text('a')).toBe('none:true');
    rerender(<Reader id="a" />);
    await act(async () => {});
    expect(text('a')).toBe('3/true:true');
    let release: (v: unknown) => void = () => {};
    mocks.getMissedInboundCount.mockReturnValue(new Promise((r) => { release = r; }));
    rerender(<Reader id="a" account="a-2" />);
    await act(async () => {});
    expect(text('a')).toBe('none:false');
    await act(async () => { release({ open: 0, open_capped: false, has_rows: false }); });
    expect(text('a')).toBe('0/false:true');
  });
});

describe('the badge', () => {
  it('shows the number, 99+ past it, and nothing for none', () => {
    expect(missedBadgeText(null)).toBeNull();
    expect(missedBadgeText({ open: 0, open_capped: false, has_rows: true })).toBeNull();
    expect(missedBadgeText({ open: 7, open_capped: false, has_rows: true })).toBe('7');
    expect(missedBadgeText({ open: 99, open_capped: false, has_rows: true })).toBe('99');
    expect(missedBadgeText({ open: 100, open_capped: false, has_rows: true })).toBe('99+');
    expect(missedBadgeText({ open: 100, open_capped: true, has_rows: true })).toBe('99+');
    expect(missedBadgeLabel({ open: 7, open_capped: false, has_rows: true })).toBe('7 to follow up');
    expect(missedBadgeLabel({ open: 100, open_capped: true, has_rows: true })).toBe('more than 99 to follow up');
  });
});

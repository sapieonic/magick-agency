import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent, cleanup, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { liveCall } from '../helpers/liveCalls';
import type { AgencyLiveCall } from '../../types/live-calls';

/**
 * The live calls table (`docs/listening.md` §9): every column, the sort, the filters, the row
 * states, the number's Show/Hide, the empty, error and no-permission states, the poll, and the
 * campaign view's amber past twice the average handle time.
 */

const mocks = vi.hoisted(() => ({
  listLiveCalls: vi.fn(),
  revealLiveCallNumber: vi.fn(),
  grantListen: vi.fn(),
  role: 'account_admin' as string,
  permissions: null as null | Record<string, boolean>,
  flags: new Set<string>(['agency_live_listen_enabled']),
}));

vi.mock('../../api/liveCalls', () => ({
  listLiveCalls: mocks.listLiveCalls,
  revealLiveCallNumber: mocks.revealLiveCallNumber,
  grantListen: mocks.grantListen,
}));
vi.mock('../../contexts/TenantContext', () => ({
  useTenant: () => ({ tenantId: 't-1', accountId: 'a-1', role: mocks.role }),
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'me' } }) }));
vi.mock('../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: (f: string) => mocks.flags.has(f), status: 'ready' }),
}));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn(), showErrorToast: vi.fn() }),
}));
vi.mock('../../hooks/usePermission', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../hooks/usePermission')>();
  return {
    usePermission: (p: string) => (mocks.permissions && p in mocks.permissions ? mocks.permissions[p]! : real.usePermission(p as never)),
  };
});

import { LiveCallsTable } from '../../components/listen/LiveCallsTable';
import { ListenProvider } from '../../components/listen/ListenProvider';

const NOW = new Date('2026-11-16T10:10:00Z').getTime();

const PRIYA = liveCall({
  call_id: 'c-priya',
  agent_user_id: 'u-priya',
  agent_name: 'Priya Sharma',
  client_kind: 'mobile',
  customer_name: 'Rahul Mehta',
  customer_phone_masked: '****4321',
  connected_at: '2026-11-16T10:03:48Z', // 6:12 on call
  listeners: [{ user_id: 'u-ak', name: 'Anita Kapoor', started_at: '2026-11-16T10:05:00Z' }],
});
const ARJUN = liveCall({
  call_id: 'c-arjun',
  origin: 'inbound',
  campaign_id: null,
  campaign_name: null,
  inbound_route_name: 'Support line',
  agent_user_id: 'u-arjun',
  agent_name: 'Arjun Nair',
  customer_name: null,
  customer_phone_masked: '****8890',
  connected_at: '2026-11-16T10:06:55Z', // 3:05
});
const SNEHA = liveCall({
  call_id: 'c-sneha',
  origin: 'manual',
  campaign_id: null,
  campaign_name: null,
  agent_user_id: 'u-sneha',
  agent_name: 'Sneha Iyer',
  customer_name: 'Kavita Rao',
  customer_phone_masked: '****1177',
  connected_at: '2026-11-16T10:07:19Z', // 2:41
  recording: false,
  listenable: false,
  not_listenable_reason: 'listen_recording_off',
});
const VIKRAM = liveCall({
  call_id: 'c-vikram',
  agent_user_id: 'u-vikram',
  agent_name: 'Vikram Das',
  customer_name: 'Meera Joshi',
  customer_phone_masked: '****5502',
  connected_at: '2026-11-16T10:08:02Z', // 1:58
  listenable: false,
  not_listenable_reason: 'listen_limit_call',
  listeners: [
    { user_id: 'u-ak', name: 'Anita Kapoor', started_at: '2026-11-16T10:08:30Z' },
    { user_id: 'me', name: 'Me Myself', started_at: '2026-11-16T10:09:00Z' },
  ],
});

function answer(calls: AgencyLiveCall[], asOf = new Date(NOW).toISOString()) {
  return { calls, as_of: asOf };
}

async function renderTable(props: Parameters<typeof LiveCallsTable>[0] = {}) {
  const view = render(
    <MemoryRouter>
      <ListenProvider>
        <LiveCallsTable {...props} />
      </ListenProvider>
    </MemoryRouter>,
  );
  await act(async () => {});
  return view;
}

const rowOf = (callId: string) => screen.getByTestId(`live-call-${callId}`);
const order = () => screen.getAllByTestId(/^live-call-c-/).map((r) => r.getAttribute('data-testid')!.replace('live-call-', ''));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  mocks.listLiveCalls.mockReset();
  mocks.revealLiveCallNumber.mockReset();
  mocks.grantListen.mockReset();
  mocks.role = 'account_admin';
  mocks.permissions = null;
  mocks.flags = new Set(['agency_live_listen_enabled']);
  mocks.listLiveCalls.mockResolvedValue(answer([VIKRAM, ARJUN, PRIYA, SNEHA]));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the table', () => {
  it('reads the account’s calls and says how many are in progress and when it was updated', async () => {
    await renderTable();
    expect(mocks.listLiveCalls).toHaveBeenCalledWith({}, 't-1', 'a-1');
    expect(screen.getByRole('heading', { level: 1, name: 'Live calls' })).toBeTruthy();
    expect(screen.getByTestId('live-calls-count').textContent).toBe('4 in progress');
    expect(screen.getByTestId('live-calls-updated').textContent).toBe('Updated 0 s ago');
  });

  it('lists the longest on call first, every column filled', async () => {
    await renderTable();
    expect(order()).toEqual(['c-priya', 'c-arjun', 'c-sneha', 'c-vikram']);
    const headers = within(screen.getByTestId('live-calls-table')).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Agent', 'Customer', 'Campaign', 'Type', 'Time on call', 'Recording', 'Listening', 'Action']);

    const priya = within(rowOf('c-priya'));
    expect(priya.getByText('Priya Sharma')).toBeTruthy();
    expect(priya.getByTitle('Mobile app')).toBeTruthy();
    expect(priya.getByText('Rahul Mehta')).toBeTruthy();
    expect(priya.getByText('****4321')).toBeTruthy();
    expect(priya.getByText('Renewals · Nov')).toBeTruthy();
    expect(priya.getByText('Dialler')).toBeTruthy();
    expect(screen.getByTestId('live-call-timer-c-priya').textContent).toBe('06:12');
    expect(priya.getByText('Recording')).toBeTruthy();
    expect(screen.getByTestId('live-call-listeners-c-priya').getAttribute('title')).toBe('Anita Kapoor');

    const arjun = within(rowOf('c-arjun'));
    expect(arjun.getByText('Unknown caller')).toBeTruthy();
    expect(arjun.getByText('Inbound: Support line')).toBeTruthy();
    expect(within(rowOf('c-sneha')).getByText('Soft phone', { selector: 'td' })).toBeTruthy();
    expect(within(rowOf('c-sneha')).getByText('Recording off')).toBeTruthy();
    expect(screen.getByTestId('live-call-listeners-c-vikram').getAttribute('title')).toBe('Anita Kapoor, You');
  });

  it('counts time on call on the server’s clock, from the list’s as_of', async () => {
    // The server is a minute ahead of this browser: a call connected "now" on its clock has been on for 0 s here.
    mocks.listLiveCalls.mockResolvedValue(answer([liveCall({ call_id: 'c-x', connected_at: new Date(NOW + 60_000).toISOString() })], new Date(NOW + 60_000).toISOString()));
    await renderTable();
    expect(screen.getByTestId('live-call-timer-c-x').textContent).toBe('00:00');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(screen.getByTestId('live-call-timer-c-x').textContent).toBe('00:03');
  });

  it('sorts by agent, then back to time', async () => {
    await renderTable();
    fireEvent.click(screen.getByTestId('live-calls-sort-agent'));
    expect(order()).toEqual(['c-arjun', 'c-priya', 'c-sneha', 'c-vikram']);
    expect(screen.getByTestId('live-calls-sort-agent').closest('th')?.getAttribute('aria-sort')).toBe('ascending');
    fireEvent.click(screen.getByTestId('live-calls-sort-agent'));
    expect(order()).toEqual(['c-vikram', 'c-sneha', 'c-priya', 'c-arjun']);
    fireEvent.click(screen.getByTestId('live-calls-sort-time'));
    expect(order()).toEqual(['c-priya', 'c-arjun', 'c-sneha', 'c-vikram']);
  });

  it('filters by type, agent and campaign', async () => {
    await renderTable();
    fireEvent.click(screen.getByTestId('live-calls-type-inbound'));
    expect(order()).toEqual(['c-arjun']);
    expect(screen.getByTestId('live-calls-type-inbound').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('live-calls-type-all'));
    fireEvent.change(screen.getByTestId('live-calls-agent-filter'), { target: { value: 'u-vikram' } });
    expect(order()).toEqual(['c-vikram']);
    fireEvent.change(screen.getByTestId('live-calls-agent-filter'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('live-calls-campaign-filter'), { target: { value: 'camp-1' } });
    expect(order()).toEqual(['c-priya', 'c-vikram']);
    fireEvent.click(screen.getByTestId('live-calls-type-manual'));
    expect(screen.getByText('No calls in progress match these filters.')).toBeTruthy();
  });

  it('says why a call cannot be listened to, beside a disabled Listen', async () => {
    await renderTable();
    expect(screen.getByTestId('live-call-reason-c-sneha').textContent).toBe('Listening is turned off for unrecorded calls');
    expect(screen.getByTestId('live-call-reason-c-vikram').textContent).toBe('Two supervisors are already listening');
    const disabled = within(rowOf('c-sneha')).getByRole('button', { name: /Listen/ });
    expect((disabled as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('live-call-listen-c-priya')).toBeTruthy();
  });

  it('says "You are on this call" on the supervisor’s own call', async () => {
    mocks.listLiveCalls.mockResolvedValue(answer([liveCall({ call_id: 'c-own', listenable: false, not_listenable_reason: 'listen_own_call' })]));
    await renderTable();
    expect(screen.getByTestId('live-call-reason-c-own').textContent).toBe('You are on this call');
  });
});

describe('the number', () => {
  it('Show fetches the full number on demand, Hide masks it again, and leaving the page forgets it', async () => {
    mocks.revealLiveCallNumber.mockResolvedValue({ call_id: 'c-priya', customer_phone: '+919845014321' });
    const view = await renderTable();
    const reveal = screen.getByTestId('live-call-reveal-c-priya');
    expect(reveal.textContent).toBe('Show');
    expect(reveal.getAttribute('aria-label')).toBe('Show number for Rahul Mehta');
    await act(async () => {
      fireEvent.click(reveal);
    });
    expect(mocks.revealLiveCallNumber).toHaveBeenCalledWith('c-priya', 't-1', 'a-1');
    expect(screen.getByTestId('live-call-number-c-priya').textContent).toBe('+91 98450 14321');
    expect(reveal.textContent).toBe('Hide');
    fireEvent.click(reveal);
    expect(screen.getByTestId('live-call-number-c-priya').textContent).toBe('****4321');
    expect(mocks.revealLiveCallNumber).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(reveal);
    });
    expect(screen.getByTestId('live-call-number-c-priya').textContent).toBe('+91 98450 14321');
    view.unmount();
    await renderTable();
    expect(screen.getByTestId('live-call-number-c-priya').textContent).toBe('****4321');
  });

  it('a failed reveal says so and keeps the number masked', async () => {
    mocks.revealLiveCallNumber.mockRejectedValue(new Error('nope'));
    await renderTable();
    await act(async () => {
      fireEvent.click(screen.getByTestId('live-call-reveal-c-priya'));
    });
    expect(screen.getByTestId('live-call-number-c-priya').textContent).toBe('****4321');
    expect(within(rowOf('c-priya')).getByRole('alert').textContent).toBe('Could not show the number. Try again.');
  });

  it('the full number is never in the polled list', async () => {
    await renderTable();
    for (const [query] of mocks.listLiveCalls.mock.calls) expect(JSON.stringify(query)).not.toMatch(/phone/);
  });
});

describe('the poll', () => {
  it('reads again every 5 s while visible, and a call that leaves fades with "Call ended" for 3 s', async () => {
    await renderTable();
    mocks.listLiveCalls.mockResolvedValue(answer([VIKRAM, ARJUN, SNEHA]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(mocks.listLiveCalls).toHaveBeenCalledTimes(2);
    expect(rowOf('c-priya').getAttribute('data-ended')).toBe('true');
    expect(screen.getByTestId('live-call-ended-c-priya').textContent).toBe('Call ended');
    expect(screen.getByTestId('live-calls-count').textContent).toBe('3 in progress');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    expect(screen.queryByTestId('live-call-c-priya')).toBeNull();
  });

  it('keeps the rows and says it is retrying when a read fails', async () => {
    await renderTable();
    mocks.listLiveCalls.mockRejectedValue(Object.assign(new Error('boom'), { statusCode: 502 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.getByTestId('live-calls-error').textContent).toBe('Could not load live calls. Retrying…');
    expect(screen.getByTestId('live-call-c-priya')).toBeTruthy();
    mocks.listLiveCalls.mockResolvedValue(answer([PRIYA]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.queryByTestId('live-calls-error')).toBeNull();
  });

  it('says so, and stops reading, when the server refuses the reader', async () => {
    mocks.listLiveCalls.mockRejectedValue(Object.assign(new Error('no'), { statusCode: 403, details: { code: 'insufficient_permissions' } }));
    await renderTable();
    expect(screen.getByText('Live calls are for supervisors. Ask an account admin if you need to see them.')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(mocks.listLiveCalls).toHaveBeenCalledTimes(1);
  });

  it('says listening is off when the flag went off under the page', async () => {
    mocks.listLiveCalls.mockRejectedValue(Object.assign(new Error('off'), { statusCode: 403, details: { code: 'feature_disabled' } }));
    await renderTable();
    expect(screen.getByText('Listening is turned off for this account.')).toBeTruthy();
  });
});

describe('the states around the table', () => {
  it('empty: "No calls in progress"', async () => {
    mocks.listLiveCalls.mockResolvedValue(answer([]));
    await renderTable();
    expect(screen.getByText('No calls in progress')).toBeTruthy();
    expect(screen.getByText('Calls appear here as soon as an agent is connected to a customer.')).toBeTruthy();
    expect(screen.getByTestId('live-calls-count').textContent).toBe('0 in progress');
  });

  it('a reader below agency.supervise reads nothing', async () => {
    mocks.role = 'viewer';
    await renderTable();
    expect(mocks.listLiveCalls).not.toHaveBeenCalled();
    expect(screen.getByText('Live calls are for supervisors. Ask an account admin if you need to see them.')).toBeTruthy();
  });

  it('supervise without listen: no Action column, and the footnote', async () => {
    mocks.permissions = { 'agency.calls.listen': false };
    await renderTable();
    const headers = within(screen.getByTestId('live-calls-table')).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).not.toContain('Action');
    expect(screen.queryByTestId('live-call-listen-c-priya')).toBeNull();
    expect(screen.getByTestId('live-calls-no-listen').textContent).toBe('You can see live calls but not listen to them.');
  });
});

describe('the campaign view', () => {
  it('reads one campaign, without the Campaign column or filter, under an h2', async () => {
    mocks.listLiveCalls.mockResolvedValue(answer([PRIYA, VIKRAM]));
    await renderTable({ campaignId: 'camp-1', headingLevel: 'h2' });
    expect(mocks.listLiveCalls).toHaveBeenCalledWith({ campaign_id: 'camp-1' }, 't-1', 'a-1');
    expect(screen.getByRole('heading', { level: 2, name: 'Live calls' })).toBeTruthy();
    const headers = within(screen.getByTestId('live-calls-table')).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).not.toContain('Campaign');
    expect(screen.queryByTestId('live-calls-campaign-filter')).toBeNull();
  });

  it('turns the time amber past twice the campaign’s average handle time', async () => {
    mocks.listLiveCalls.mockResolvedValue(answer([PRIYA, VIKRAM]));
    await renderTable({ campaignId: 'camp-1', ahtSeconds: 170 });
    // 6:12 > 2 × 2:50; 1:58 is not.
    expect(screen.getByTestId('live-call-timer-c-priya').getAttribute('data-overrun')).toBe('true');
    expect(screen.getByTestId('live-call-timer-c-vikram').getAttribute('data-overrun')).toBeNull();
  });

  it('shows no amber without an average handle time (the account page)', async () => {
    await renderTable();
    expect(screen.getByTestId('live-call-timer-c-priya').getAttribute('data-overrun')).toBeNull();
  });

  it('reports the count for the Live segment', async () => {
    const onCount = vi.fn();
    mocks.listLiveCalls.mockResolvedValue(answer([PRIYA, VIKRAM]));
    await renderTable({ campaignId: 'camp-1', onCount });
    await waitFor(() => expect(onCount).toHaveBeenLastCalledWith(2));
  });
});

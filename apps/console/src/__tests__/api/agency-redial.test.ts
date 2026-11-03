import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('../../api/client', () => ({ apiFetch: mocks.apiFetch }));

import { redialFromWrapup } from '../../api/agency';

/**
 * `redialFromWrapup` — `POST /proxy/agency/sessions/:id/redial`.
 *
 * The body names the wrap-up's attempt and nothing else: the server attributes the
 * request to the signed-in agent, exactly as for `/available` and the disposition.
 */
beforeEach(() => {
  vi.clearAllMocks();
  mocks.apiFetch.mockResolvedValue({
    session_id: 'sess-1',
    attempt_id: 'att-2',
    redial_of_attempt_id: 'att-1',
    redial_number: 1,
    redial_remaining: 1,
  });
});

describe('redialFromWrapup', () => {
  it('posts the wrap-up attempt to the session’s redial route, with no agent id', async () => {
    const response = await redialFromWrapup('sess-1', 'att-1', 'tenant-1', 'account-1');

    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    const [url, init, tenant, account] = mocks.apiFetch.mock.calls[0]!;
    expect(url).toMatch(/\/proxy\/agency\/sessions\/sess-1\/redial$/);
    expect(init).toMatchObject({ method: 'POST' });
    expect(JSON.parse(init.body as string)).toEqual({ attempt_id: 'att-1' });
    expect(tenant).toBe('tenant-1');
    expect(account).toBe('account-1');
    expect(response.attempt_id).toBe('att-2');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `getMyAssignments` — the wrapper the agent home depends on.
 *
 * It had no test of its own. Its shape decisions matter because `AgentHomePage`
 * branches on them: an empty array is "nobody has staffed me" (a screen), a
 * populated one is a list or a redirect, and a throw is a third screen entirely.
 */

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock('../../api/client', () => ({ apiFetch: mocks.apiFetch }));

import { getMyAssignments } from '../../api/agency';

const TENANT = 'tenant-1';
const ACCOUNT = 'account-1';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getMyAssignments', () => {
  it('calls the PLURAL route', async () => {
    // Not `/my-assignment`. The singular route is the deprecated back-compat alias
    // and cannot report a second campaign — which is the whole reason this exists.
    mocks.apiFetch.mockResolvedValue({ assignments: [] });

    await getMyAssignments(TENANT, ACCOUNT);

    expect(mocks.apiFetch.mock.calls[0]![0]).toMatch(/\/proxy\/agency\/my-assignments$/);
  });

  it('threads tenant and account through', async () => {
    // `TenantContext` resolves the account asynchronously; a call made without it
    // gets a 400 from master that has nothing to do with the agent's assignments.
    mocks.apiFetch.mockResolvedValue({ assignments: [] });

    await getMyAssignments(TENANT, ACCOUNT);

    const [, , tenantId, accountId] = mocks.apiFetch.mock.calls[0]!;
    expect(tenantId).toBe(TENANT);
    expect(accountId).toBe(ACCOUNT);
  });

  it('unwraps the envelope to the array the page renders', async () => {
    mocks.apiFetch.mockResolvedValue({
      assignments: [
        {
          campaign_id: 'camp-1',
          campaign_name: 'Renewals',
          campaign_status: 'running',
          assigned_at: '2026-08-16T09:00:00.000Z',
        },
      ],
    });

    const out = await getMyAssignments(TENANT, ACCOUNT);

    expect(out).toHaveLength(1);
    expect(out[0]!.campaign_id).toBe('camp-1');
    expect(out[0]!.campaign_status).toBe('running');
  });

  it('returns an empty array for an unstaffed agent', async () => {
    // Master's `200 { assignments: [] }`. The page renders "not assigned yet" from
    // `length === 0`, so this must not become null or undefined.
    mocks.apiFetch.mockResolvedValue({ assignments: [] });

    expect(await getMyAssignments(TENANT, ACCOUNT)).toEqual([]);
  });

  it('returns an empty array when the body is absent altogether', async () => {
    /**
     * `apiFetch` resolves `undefined` for a 204. No master version answers 204 on
     * this route — an older one has no route at all and answers 404, which
     * `apiFetch` throws on — so this guard is for a shape nobody currently sends.
     * It is kept because the alternative failure is `.map` of undefined inside
     * render, and degrading to the unstaffed screen is the better of the two.
     */
    mocks.apiFetch.mockResolvedValue(undefined);

    expect(await getMyAssignments(TENANT, ACCOUNT)).toEqual([]);
  });

  it('lets an error propagate, because "could not ask" is a different screen', async () => {
    // "Nobody has staffed you" is fixed by a supervisor; "we could not find out" is
    // fixed by support. Swallowing this into `[]` would send the agent to the wrong
    // person — including against an older master, which 404s this route.
    mocks.apiFetch.mockRejectedValue(new Error('Not Found'));

    await expect(getMyAssignments(TENANT, ACCOUNT)).rejects.toThrow(/Not Found/);
  });
});

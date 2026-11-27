import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AGENCY_TEAM_PERFORMANCE_ERROR_CODES,
  AGENCY_TEAM_PERFORMANCE_ERROR_STATUS,
} from '@magick-agency/contracts/api/agency/team-performance';

/**
 * The Team performance client (`docs/team-performance.md` §4): one GET at the route's path with
 * exactly the query the server validates (`from`, `to` as local dates, the browser's `timezone`,
 * `campaign_id` only for one campaign) and the scope headers passed through; every refusal code
 * has the console's words; Try again only for what can clear by itself (`team_busy` 429,
 * `team_timed_out` 503).
 */

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock('firebase/auth', () => ({ getAuth: () => ({ currentUser: null }) }));
vi.mock('../../api/client', async () => {
  const actual = await vi.importActual<typeof import('../../api/client')>('../../api/client');
  return { ...actual, apiFetch: mocks.apiFetch };
});

import { getTeamPerformance, isRetryableTeamError, teamErrorMessage } from '../../api/teamPerformance';
import { ApiError } from '../../api/client';
import { TEAM_ERROR_MESSAGES } from '../../utils/agency/team/teamCopy';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.apiFetch.mockResolvedValue({});
});

function sent() {
  const [url, init, tenantId, accountId] = mocks.apiFetch.mock.calls[0]!;
  const u = new URL(url as string, 'http://console.test');
  return { path: u.pathname, params: [...u.searchParams.entries()], method: (init as RequestInit).method ?? 'GET', signal: (init as RequestInit).signal, tenantId, accountId };
}

describe('getTeamPerformance', () => {
  it('asks for one campaign with exactly the query the server validates', async () => {
    const controller = new AbortController();
    await getTeamPerformance({ from: '2026-11-21', to: '2026-11-27', timezone: 'Asia/Kolkata', campaign_id: 'be5fd3d1-bb78-4395-aeb5-2c59ea873338' }, 't-1', 'a-1', controller.signal);
    expect(sent()).toEqual({
      path: '/proxy/agency/team-performance',
      params: [['from', '2026-11-21'], ['to', '2026-11-27'], ['timezone', 'Asia/Kolkata'], ['campaign_id', 'be5fd3d1-bb78-4395-aeb5-2c59ea873338']],
      method: 'GET',
      signal: controller.signal,
      tenantId: 't-1',
      accountId: 'a-1',
    });
  });

  it('sends no campaign for All campaigns', async () => {
    await getTeamPerformance({ from: '2026-11-27', to: '2026-11-27', timezone: 'UTC' }, 't-1', 'a-1');
    expect(sent().params).toEqual([['from', '2026-11-27'], ['to', '2026-11-27'], ['timezone', 'UTC']]);
  });
});

describe('refusals', () => {
  const refusal = (code: string) =>
    new ApiError(AGENCY_TEAM_PERFORMANCE_ERROR_STATUS[code as keyof typeof AGENCY_TEAM_PERFORMANCE_ERROR_STATUS], { error: 'x', code, message: 'server words' });

  it('words every refusal code as the console, never the server', () => {
    for (const code of AGENCY_TEAM_PERFORMANCE_ERROR_CODES) {
      expect(teamErrorMessage(refusal(code), 'fallback')).toBe(TEAM_ERROR_MESSAGES[code]);
    }
    expect(teamErrorMessage(refusal('team_timed_out'), 'fallback')).toBe('Too much to read at once. Try a shorter period.');
  });

  it('offers Try again only for busy (429) and timed out (503) among the codes', () => {
    const retryable = AGENCY_TEAM_PERFORMANCE_ERROR_CODES.filter((code) => isRetryableTeamError(refusal(code)));
    expect(retryable.sort()).toEqual(['team_busy', 'team_timed_out']);
    expect(AGENCY_TEAM_PERFORMANCE_ERROR_STATUS.team_busy).toBe(429);
    expect(AGENCY_TEAM_PERFORMANCE_ERROR_STATUS.team_timed_out).toBe(503);
  });
});

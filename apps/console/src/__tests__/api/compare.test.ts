import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AGENCY_COMPARE_ERROR_CODES,
  COMPARE_MAX_METRICS,
  COMPARE_PAGE_MAX_AGENTS,
  COMPARE_VIEWS_PER_USER_MAX,
  type AgencyCompareQuery,
} from '@magick-agency/contracts/api/agency/compare';

/**
 * The Compare agents client (`docs/compare-agents.md` §8): one function per route, each at its
 * path and method with its body and the scope headers passed through; every refusal code (and the
 * flag gate's `feature_disabled`) has the console's own words, keyed off `code`; only busy and
 * timed out are offered again.
 */

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock('firebase/auth', () => ({ getAuth: () => ({ currentUser: null }) }));
vi.mock('../../api/client', async () => {
  const actual = await vi.importActual<typeof import('../../api/client')>('../../api/client');
  return { ...actual, apiFetch: mocks.apiFetch };
});

import {
  COMPARE_ERROR_MESSAGES,
  compareErrors,
  createCompareView,
  deleteCompareView,
  getCompareOptions,
  listCompareViews,
  queryCompare,
  updateCompareView,
} from '../../api/compare';
import { ApiError } from '../../api/client';
import { NETWORK_ERROR_MESSAGE } from '../../api/errorFamily';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.apiFetch.mockResolvedValue({});
});

function call(i = 0) {
  const [url, init, tenantId, accountId] = mocks.apiFetch.mock.calls[i]!;
  const req = (init ?? {}) as RequestInit;
  return {
    url: url as string,
    method: req.method ?? 'GET',
    body: req.body === undefined ? undefined : JSON.parse(req.body as string),
    signal: req.signal,
    tenantId,
    accountId,
  };
}

const QUERY: AgencyCompareQuery = {
  campaign_id: 'camp-1',
  agent_ids: ['u-1', 'u-2'],
  metrics: [
    { kind: 'builtin', key: 'calls_handled' },
    { kind: 'outcomes', codes: ['will_pay', 'part_paid'], better: 'higher', label: 'Will pay' },
  ],
  trend: { kind: 'outcomes', codes: ['will_pay', 'part_paid'], better: 'higher', label: 'Will pay' },
  from: '2026-11-15',
  to: '2026-11-21',
  timezone: 'Asia/Kolkata',
};

describe('routes', () => {
  it('queryCompare POSTs the query to /proxy/agency/compare/query with the scope and the abort signal', async () => {
    const controller = new AbortController();
    await queryCompare(QUERY, 't', 'a', controller.signal);
    expect(call()).toEqual({
      url: '/proxy/agency/compare/query',
      method: 'POST',
      body: QUERY,
      signal: controller.signal,
      tenantId: 't',
      accountId: 'a',
    });
  });

  it('getCompareOptions GETs the options with campaign, window and zone in the query string', async () => {
    await getCompareOptions({ campaign_id: 'c 1', from: '2026-11-15', to: '2026-11-21', timezone: 'Asia/Kolkata' }, 't', 'a');
    expect(call()).toMatchObject({
      url: '/proxy/agency/compare/options?campaign_id=c+1&from=2026-11-15&to=2026-11-21&timezone=Asia%2FKolkata',
      method: 'GET',
      body: undefined,
      tenantId: 't',
      accountId: 'a',
    });
  });

  it('builds the options query string in a fixed order, whatever the order of the query’s keys', async () => {
    await getCompareOptions({ timezone: 'UTC', to: 'g', from: 'f', campaign_id: 'c' }, 't', 'a');
    expect(call().url).toBe('/proxy/agency/compare/options?campaign_id=c&from=f&to=g&timezone=UTC');
  });

  it('lists views, narrowed to a campaign only when one is given', async () => {
    await listCompareViews({}, 't', 'a');
    await listCompareViews({ campaign_id: 'c/1' }, 't', 'a');
    expect(call(0)).toMatchObject({ url: '/proxy/agency/compare/views', method: 'GET' });
    expect(call(1).url).toBe('/proxy/agency/compare/views?campaign_id=c%2F1');
  });

  it('creates, updates and deletes a view at its path', async () => {
    const request = { name: 'Weekly', lens: 'sales' as const, metrics: [{ kind: 'builtin' as const, key: 'success_rate' as const }], shared: true };
    await createCompareView(request, 't', 'a');
    await updateCompareView('v/1', { is_campaign_default: true, campaign_id: 'c' }, 't', 'a');
    await deleteCompareView('v/1', 't', 'a');
    expect(call(0)).toMatchObject({ url: '/proxy/agency/compare/views', method: 'POST', body: request });
    expect(call(1)).toMatchObject({ url: '/proxy/agency/compare/views/v%2F1', method: 'PATCH', body: { is_campaign_default: true, campaign_id: 'c' } });
    expect(call(2)).toMatchObject({ url: '/proxy/agency/compare/views/v%2F1', method: 'DELETE', body: undefined });
  });
});

const refusal = (status: number, code: string) => new ApiError(status, { error: 'refused', code, message: 'server fallback text' });

describe('refusals', () => {
  it('has words for every compare code and the flag gate, never the server’s fallback', () => {
    for (const code of [...AGENCY_COMPARE_ERROR_CODES, 'feature_disabled'] as const) {
      const words = COMPARE_ERROR_MESSAGES[code];
      expect(words, code).toMatch(/\S/);
      expect(compareErrors.code(refusal(400, code)), code).toBe(code);
      expect(compareErrors.message(refusal(400, code), 'fallback'), code).toBe(words);
      expect(words).not.toContain('server fallback text');
    }
    expect(Object.keys(COMPARE_ERROR_MESSAGES).sort()).toEqual([...AGENCY_COMPARE_ERROR_CODES, 'feature_disabled'].sort());
  });

  it('words the window rule as the reports do: 30 days or exactly one calendar month, never 31', () => {
    expect(COMPARE_ERROR_MESSAGES.compare_window_invalid).toBe(
      'Those dates don’t make a valid window. Choose at most 30 days, or exactly one calendar month, ending no later than today.',
    );
  });

  it('writes British spelling and no American forms', () => {
    const all = Object.values(COMPARE_ERROR_MESSAGES).join(' ');
    expect(all).not.toMatch(/\b(organization|recognized|canceled|dialed|color)\b/i);
    expect(COMPARE_ERROR_MESSAGES.compare_timezone_invalid).toContain('recognised');
  });

  it('offers Try again only for what can clear by itself: busy, timed out, 429, 5xx, the network', () => {
    for (const code of AGENCY_COMPARE_ERROR_CODES) {
      expect(compareErrors.isRetryable(refusal(400, code)), code).toBe(code === 'compare_busy' || code === 'compare_timed_out');
    }
    expect(compareErrors.isRetryable(new TypeError('Failed to fetch'))).toBe(true);
    expect(compareErrors.isRetryable(new ApiError(500, { error: 'Internal Server Error' }))).toBe(true);
    expect(compareErrors.isRetryable(new ApiError(503, { error: 'Service Unavailable' }))).toBe(true);
    expect(compareErrors.isRetryable(new ApiError(429, { error: 'Too Many Requests' }))).toBe(true);
    // A refusal that stays until the reader changes something: no Try again.
    expect(compareErrors.isRetryable(new ApiError(403, { error: 'Forbidden' }))).toBe(false);
    expect(compareErrors.isRetryable(new ApiError(400, { error: 'Bad Request', message: 'body/agent_ids must NOT have more than 3 items' }))).toBe(false);
    expect(compareErrors.isRetryable(new ApiError(404, { error: 'Not Found' }))).toBe(false);
    expect(compareErrors.isRetryable(refusal(403, 'feature_disabled'))).toBe(false);
    expect(compareErrors.isRetryable(new DOMException('aborted', 'AbortError'))).toBe(false);
  });

  it('ignores a code from another family, and says a plain 403 is about permission', () => {
    expect(compareErrors.code(refusal(400, 'report_window_invalid'))).toBeNull();
    expect(compareErrors.message(new ApiError(403, { error: 'Forbidden' }), 'fallback')).toBe('You don’t have permission to compare agents.');
    expect(compareErrors.message(new ApiError(500, { error: 'Internal Server Error' }), 'fallback')).toMatch(/Internal Server Error|fallback/);
  });

  it('words a failure with no answer (the network) in the console’s words, never the browser’s', () => {
    for (const err of [new TypeError('Failed to fetch'), new TypeError('NetworkError when attempting to fetch resource.'), new Error('boom')]) {
      expect(compareErrors.message(err, 'fallback')).toBe('Couldn’t reach the server. Check your connection and try again.');
    }
    expect(NETWORK_ERROR_MESSAGE).toBe('Couldn’t reach the server. Check your connection and try again.');
  });

  it('words compare_busy for either limit: it names neither the organisation nor a count', () => {
    // The server refuses compare_busy for the account's limit and for its own process-wide one.
    expect(COMPARE_ERROR_MESSAGES.compare_busy).toBe('Too many comparisons are running right now. Try again in a moment.');
    expect(COMPARE_ERROR_MESSAGES.compare_busy).not.toMatch(/organisation|\d/);
  });

  it('reads the limits it states from the contract', () => {
    expect(COMPARE_ERROR_MESSAGES.compare_too_many_agents).toContain(`at most ${COMPARE_PAGE_MAX_AGENTS} agents`);
    expect(COMPARE_ERROR_MESSAGES.compare_too_many_metrics).toContain(`at most ${COMPARE_MAX_METRICS} metrics`);
    expect(COMPARE_ERROR_MESSAGES.compare_view_limit).toContain(`${COMPARE_VIEWS_PER_USER_MAX} saved views`);
  });
});

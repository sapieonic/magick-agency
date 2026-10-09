import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The three retry routes' wrappers.
 *
 * ── What this layer can get wrong, and each is silent ──────────────────────
 *  1. **`X-Account-Id`.** `apiFetch` takes it as the fourth argument, so an
 *     omitted one surfaces only at core as `400 Missing required header:
 *     x-mgkvc-account`, masked by master and naming nothing in cusui. That is
 *     how the whole agency surface once shipped non-functional.
 *  2. **The actor.** Master fills `agent_user_id` and `actor_name` from the
 *     authenticated session. An actor the browser sends is an actor the browser
 *     can forge, so the body must not carry one.
 *  3. **The selector encoding.** Core parses the preview's query string and the
 *     create's JSON object through ONE function, so the two must name the same
 *     dimensions the same way — a preview that promises a count the create does
 *     not deliver is the exact class of defect the shared parser exists to
 *     prevent.
 */

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock('../../api/client', () => ({ apiFetch: mocks.apiFetch }));

import { campaignLineage, createRetry, retryPreview } from '../../api/agencyCampaigns';
import type { AgencyRetrySelector } from '../../types/agency-spine';

const TENANT = 'tenant-1';
const ACCOUNT = 'account-1';
const CAMPAIGN = 'camp-1';

const SELECTOR: AgencyRetrySelector = {
  last_outcome: ['no_answer', 'busy'],
  last_disposition: ['voicemail'],
  never_attempted: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.apiFetch.mockResolvedValue({});
});

function call(index = 0) {
  const args = mocks.apiFetch.mock.calls[index]!;
  return {
    url: args[0] as string,
    init: (args[1] ?? {}) as RequestInit,
    tenantId: args[2] as string | undefined,
    accountId: args[3] as string | undefined,
  };
}

describe('retryPreview', () => {
  it('reads the preview route with the selector as a query string', async () => {
    await retryPreview(CAMPAIGN, SELECTOR, TENANT, ACCOUNT);
    const { url } = call();
    expect(url).toContain('/proxy/agency/campaigns/camp-1/retry/preview?');
    const query = new URLSearchParams(url.split('?')[1]);
    expect(query.getAll('last_outcome')).toEqual(['no_answer', 'busy']);
    expect(query.getAll('last_disposition')).toEqual(['voicemail']);
    expect(query.get('never_attempted')).toBe('true');
  });

  it('sends both tenant and account', async () => {
    await retryPreview(CAMPAIGN, SELECTOR, TENANT, ACCOUNT);
    expect(call().tenantId).toBe(TENANT);
    expect(call().accountId).toBe(ACCOUNT);
  });

  it('writes nothing — no method, no body', async () => {
    await retryPreview(CAMPAIGN, SELECTOR, TENANT, ACCOUNT);
    expect(call().init.method).toBeUndefined();
    expect(call().init.body).toBeUndefined();
  });

  it('leaves the path bare when the selector encodes to nothing', async () => {
    // Core answers 400 for an empty selector; a trailing `?` would be a second,
    // quieter way to get there.
    await retryPreview(CAMPAIGN, {}, TENANT, ACCOUNT);
    expect(call().url.endsWith('/retry/preview')).toBe(true);
  });
});

describe('createRetry', () => {
  it('POSTs the selector, the name and the overrides', async () => {
    await createRetry(
      CAMPAIGN,
      {
        selector: SELECTOR,
        name: 'Q3 Winback — Retry 1',
        config_overrides: { caller_ids: ['+911234567890'] },
      },
      TENANT,
      ACCOUNT,
    );
    const { url, init } = call();
    expect(url).toBe('/proxy/agency/campaigns/camp-1/retry');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.selector).toEqual(SELECTOR);
    expect(body.name).toBe('Q3 Winback — Retry 1');
    expect(body.config_overrides).toEqual({ caller_ids: ['+911234567890'] });
  });

  it('never sends an actor — master fills it from the session', async () => {
    await createRetry(CAMPAIGN, { selector: SELECTOR }, TENANT, ACCOUNT);
    const body = JSON.parse(call().init.body as string);
    expect(body).not.toHaveProperty('agent_user_id');
    expect(body).not.toHaveProperty('actor_name');
  });

  it('names the same dimensions the preview does', async () => {
    // One parser in core reads both forms. If these two ever disagree, the
    // count a supervisor was shown is not the roster they get.
    await retryPreview(CAMPAIGN, SELECTOR, TENANT, ACCOUNT);
    await createRetry(CAMPAIGN, { selector: SELECTOR }, TENANT, ACCOUNT);

    const query = new URLSearchParams(call(0).url.split('?')[1]);
    const body = JSON.parse(call(1).init.body as string) as { selector: AgencyRetrySelector };

    expect(query.getAll('last_outcome')).toEqual(body.selector.last_outcome);
    expect(query.getAll('last_disposition')).toEqual(body.selector.last_disposition);
    expect(query.get('never_attempted') === 'true').toBe(body.selector.never_attempted);
  });
});

describe('campaignLineage', () => {
  it('reads the lineage route for any campaign', async () => {
    await campaignLineage(CAMPAIGN, TENANT, ACCOUNT);
    const { url, init, tenantId, accountId } = call();
    expect(url).toBe('/proxy/agency/campaigns/camp-1/lineage');
    expect(init.method).toBeUndefined();
    expect(tenantId).toBe(TENANT);
    expect(accountId).toBe(ACCOUNT);
  });
});

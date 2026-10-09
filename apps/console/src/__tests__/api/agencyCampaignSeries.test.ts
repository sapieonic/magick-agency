import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The campaign stats time-series wrapper.
 *
 * ── The three things this wrapper can get wrong ────────────────────────────
 *  1. **`X-Account-Id`.** `apiFetch` takes it as the fourth argument, so omitting
 *     it is silent at every layer that could catch it and surfaces only at the server
 *     as `400 Missing required header: x-mgkvc-account`, masked by the server and
 *     naming nothing in the console. That is how the whole agency surface once shipped
 *     non-functional, so it is asserted here rather than assumed.
 *  2. **The path.** This is the only campaign-scoped route in
 *     `ENDPOINTS.proxy.agency`, and it sits beside four `agents/…` routes that
 *     look nothing like it. A path built by concatenation elsewhere is the one
 *     that breaks quietly, which is why the assertion is against `ENDPOINTS`
 *     rather than against a string typed twice.
 *  3. **The id reaching the URL raw.** The server owns the campaign id format. It is
 *     encoded, and an id with a slash in it must not silently address a
 *     different route.
 */

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock('../../api/client', () => ({ apiFetch: mocks.apiFetch }));

import { ENDPOINTS } from '../../config';
import { getAgencyCampaignSeries } from '../../api/agencyCampaignSeries';

const TENANT = 'tenant-1';
const ACCOUNT = 'account-1';
const CAMPAIGN = 'camp-1';
const QUERY = {
  from: '2026-08-01T00:00:00.000Z',
  to: '2026-08-20T00:00:00.000Z',
  bucket: 'day' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.apiFetch.mockResolvedValue({ campaign_id: CAMPAIGN, bucket: 'day', buckets: [] });
});

function url(): string {
  return mocks.apiFetch.mock.calls[0]![0] as string;
}

describe('getAgencyCampaignSeries', () => {
  it('hits the campaign-scoped series route from the endpoint catalog', async () => {
    await getAgencyCampaignSeries(CAMPAIGN, QUERY, TENANT, ACCOUNT);
    expect(url()).toContain(`${ENDPOINTS.proxy.agency.campaignStatsSeries(CAMPAIGN)}?`);
    expect(url()).toContain('/proxy/agency/campaigns/camp-1/stats/series?');
  });

  it('sends the half-open range and the bucket width', async () => {
    await getAgencyCampaignSeries(CAMPAIGN, QUERY, TENANT, ACCOUNT);
    expect(url()).toContain(`from=${encodeURIComponent(QUERY.from)}`);
    expect(url()).toContain(`to=${encodeURIComponent(QUERY.to)}`);
    expect(url()).toContain('bucket=day');
  });

  it('sends EXACTLY the three parameters the route takes, and no others', async () => {
    /*
      Asserting the whole query rather than the absence of two names. The old
      version checked `not.toContain('agent_user_id')` against a URL built from a
      `URLSearchParams` with three literal keys — it could not fail for any
      implementation of this function, including one that threaded a subject
      through. The server answers an unknown query param with a 400 rather than
      dropping it, so an extra key here is a broken screen, not a silent no-op.
    */
    await getAgencyCampaignSeries(CAMPAIGN, QUERY, TENANT, ACCOUNT);
    const params = new URL(url(), 'http://x').searchParams;
    expect([...params.keys()].sort()).toEqual(['bucket', 'from', 'to']);
  });

  it('passes BOTH the tenant and the account through to apiFetch', async () => {
    await getAgencyCampaignSeries(CAMPAIGN, QUERY, TENANT, ACCOUNT);
    const call = mocks.apiFetch.mock.calls[0]!;
    expect(call[2]).toBe(TENANT);
    expect(call[3]).toBe(ACCOUNT);
  });

  it('encodes the campaign id rather than concatenating it', async () => {
    await getAgencyCampaignSeries('a/b?c', QUERY, TENANT, ACCOUNT);
    expect(url()).toContain('a%2Fb%3Fc');
    expect(url()).not.toContain('a/b?c');
  });

  it('returns the payload unchanged', async () => {
    const payload = { campaign_id: CAMPAIGN, bucket: 'day' as const, buckets: [] };
    mocks.apiFetch.mockResolvedValue(payload);
    await expect(getAgencyCampaignSeries(CAMPAIGN, QUERY, TENANT, ACCOUNT)).resolves.toBe(payload);
  });
});

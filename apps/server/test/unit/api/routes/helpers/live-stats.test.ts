import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The stats strip through the internal handler (`api/routes/helpers/live-stats.ts`): what it asks
 * `callCore` for, and how it reads the answer. `liveStatsRead` (Home's board) sends the read-past
 * header only when asked, and calls an answer shared unless the handler says its read ran for this
 * call (an answer that does not say may be older, so Home never keeps it unchecked). The handler's
 * side of both headers: `test/unit/agency/campaign-stats-route-sharing.test.ts`.
 */

const { callCore } = vi.hoisted(() => ({ callCore: vi.fn() }));
vi.mock('../../../../../src/api/core-dispatch.js', () => ({ callCore }));

import { liveStats, liveStatsRead } from '../../../../../src/api/routes/helpers/live-stats.js';
import type { AgencyCampaignRecord } from '../../../../../src/db/models/agency.model.js';

const CAMPAIGN = { id: 'c-1', tenant_id: 't-1', account_id: 'a-1' } as AgencyCampaignRecord;
const BODY = { campaign_id: 'c-1', contacts_total: 3 };

function answers(status: number, read?: string) {
  callCore.mockResolvedValue({
    status, body: status < 400 ? BODY : { error: 'Not Found' },
    headers: new Headers(read === undefined ? {} : { 'x-mgkvc-stats-read': read }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('liveStatsRead', () => {
  it('asks the stats handler under the campaign\'s own account, past the shared read only when asked', async () => {
    answers(200, 'scanned');
    await liveStatsRead(CAMPAIGN);
    await liveStatsRead(CAMPAIGN, { fresh: false });
    await liveStatsRead(CAMPAIGN, { fresh: true });
    const base = { method: 'GET', path: '/agency-campaigns/c-1/stats', tenantId: 't-1', accountId: 'a-1' };
    expect(callCore.mock.calls.map(([req]) => req)).toEqual([
      base, base, { ...base, headers: { 'x-mgkvc-stats-fresh': '1' } },
    ]);
  });

  it.each([
    ['scanned', false],
    ['shared', true],
    [undefined, true],
    ['something else', true],
  ])('a read the handler calls %s is shared: %s', async (read, shared) => {
    answers(200, read);
    expect(await liveStatsRead(CAMPAIGN)).toEqual({ stats: BODY, shared });
  });

  it('is null when the handler refuses', async () => {
    answers(404, 'scanned');
    expect(await liveStatsRead(CAMPAIGN)).toBeNull();
  });
});

describe('liveStats', () => {
  it('is the payload alone (the summary and the campaign report), or null on a refusal', async () => {
    answers(200, 'shared');
    expect(await liveStats(CAMPAIGN)).toEqual(BODY);
    expect(callCore.mock.calls[0]![0]).not.toHaveProperty('headers');
    answers(403);
    expect(await liveStats(CAMPAIGN)).toBeNull();
  });
});

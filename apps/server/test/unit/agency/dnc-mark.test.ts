import { describe, it, expect, beforeEach, vi } from 'vitest';

/*
 * `markDnc` (`src/agency/dnc-mark.ts`): the write behind an agent's mark-DNC, which the station DNC
 * route calls inside its one transaction (decision B8). `dncRepository.insertMany` is mocked.
 * The request is a `DncMarkRequest` and the response a `DncMarkResult`.
 *
 * Covered: records source `agent` / tenant-wide / passes `added_by` through; no `addedBy` when
 * none; tenant-wide when no campaign; threads a campaign; the nil-UUID sentinel refused
 * (`refused: 'invalid_dnc_scope'`, nothing written); a non-sentinel campaign accepted;
 * account_id + campaign refused; a supplied account_id refused; an explicit `account_id: null`
 * tolerated; recorded:true on a new write; the campaign the row was written at echoed; the ROW's
 * scope reported, not the request's (both directions); recorded:true on a redelivery with
 * `alreadyPresent`.
 *
 * An unparseable number: `markDnc` writes nothing and answers `recorded: false, phoneE164: null`
 * (the route turns that into `dnc_recorded: false`; the route owns the contact, so it never 400s).
 * A write failure: without a caller client it is REPORTED (`recorded: false`); with one it
 * PROPAGATES so the route's transaction rolls back (the route's real-Postgres twin is
 * `integration/api/agency-runtime-routes.test.ts`).
 *
 * Not covered here: there is no resync or cooldown (the Redis set does not exist, B8), and no
 * client-supplied tenant or campaign id reaches `markDnc` — the route resolves the campaign from
 * the attempt and the tenant from the request context. `DncMarkResult` carries the row's scope,
 * not its id, so no `entry_id` is asserted.
 */

const mocks = vi.hoisted(() => ({ insertMany: vi.fn() }));

vi.mock('../../../src/dnc/dnc.repository.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/dnc/dnc.repository.js')>()),
  dncRepository: { insertMany: mocks.insertMany },
}));
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { markDnc } from '../../../src/agency/dnc-mark.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const CAMPAIGN = '33333333-3333-4333-8333-333333333333';
/**
 * The value `uq_dnc_scope` COALESCEs a NULL scope column to (`050_dnc.sql`), and
 * a value `z.string().uuid()` happily accepts. Spelled out here rather than
 * imported so this test states the literal the index actually contains — if the
 * production constant is ever edited to something else, this file must be edited
 * too, deliberately, rather than following it silently.
 */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * One number's `insertMany` result. `writtenCampaignId` is the scope of the ROW — deliberately
 * separate from anything the request says, because the result field under test is a receipt
 * for the row and the two are allowed to differ.
 */
function insertResult(created: boolean, writtenCampaignId: string | null = null) {
  return {
    results: [{
      created,
      entry: { id: 'entry-1', tenant_id: TENANT, account_id: null, campaign_id: writtenCampaignId, phone_e164: '+15551230001' },
    }],
  };
}

function lastInput(): Record<string, unknown> {
  return mocks.insertMany.mock.calls[0]![0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.insertMany.mockResolvedValue(insertResult(true));
});

describe('the write', () => {
  it('records source `agent`, tenant-wide, and passes through whatever `added_by` it is handed', async () => {
    await markDnc({ tenantId: TENANT, phoneE164: '+15551230001', addedBy: 'user-agent-7', reason: 'customer asked' });

    const arg = lastInput();
    expect(arg['tenant_id']).toBe(TENANT);
    expect(arg['phones']).toEqual(['+15551230001']);
    expect(arg['source']).toBe('agent');
    expect(arg['reason']).toBe('customer asked');
    expect(arg['added_by']).toBe('user-agent-7');
  });

  it('writes no `addedBy` at all when the caller sends none', async () => {
    // Writing NULL rather than inventing a value is the whole point.
    await markDnc({ tenantId: TENANT, phoneE164: '+15551230001' });
    expect(lastInput()['added_by']).toBeNull();
  });

  it('writes TENANT-WIDE when no campaign is named', async () => {
    await markDnc({ tenantId: TENANT, phoneE164: '+15551230001' });
    expect(lastInput()['account_id']).toBeNull();
    expect(lastInput()['campaign_id']).toBeNull();
  });

  it('threads a campaign_id through as a campaign-scoped write instead of stripping it', async () => {
    await markDnc({ tenantId: TENANT, phoneE164: '+15551230001', campaignId: CAMPAIGN });
    expect(lastInput()['campaign_id']).toBe(CAMPAIGN);
    // A campaign scope must never quietly acquire an account scope as well.
    expect(lastInput()['account_id']).toBeNull();
  });

  it("refuses the NIL UUID as a campaign_id — it is the index's tenant-wide sentinel", async () => {
    const res = await markDnc({ tenantId: TENANT, phoneE164: '+15551230001', campaignId: NIL_UUID });
    expect(res).toMatchObject({ recorded: false, refused: 'invalid_dnc_scope', written: null });
    expect(mocks.insertMany).not.toHaveBeenCalled();
  });

  it('still accepts a NON-sentinel campaign id, so the guard is the value and not the field', async () => {
    const res = await markDnc({ tenantId: TENANT, phoneE164: '+15551230001', campaignId: CAMPAIGN });
    expect(res.recorded).toBe(true);
    expect(lastInput()['campaign_id']).toBe(CAMPAIGN);
  });

  it('still refuses an account_id even when a valid campaign_id rides along', async () => {
    const res = await markDnc({ tenantId: TENANT, phoneE164: '+15551230001', campaignId: CAMPAIGN, accountId: ACCOUNT });
    expect(res.refused).toBe('invalid_dnc_scope');
    expect(mocks.insertMany).not.toHaveBeenCalled();
  });

  it('refuses a supplied account_id rather than writing a row that cannot propagate', async () => {
    const res = await markDnc({ tenantId: TENANT, phoneE164: '+15551230001', accountId: ACCOUNT });
    expect(res.refused).toBe('invalid_dnc_scope');
    expect(mocks.insertMany).not.toHaveBeenCalled();
  });

  it('tolerates an explicit account_id: null', async () => {
    const res = await markDnc({ tenantId: TENANT, phoneE164: '+15551230001', accountId: null });
    expect(res.recorded).toBe(true);
    expect(res.refused).toBeUndefined();
  });
});

describe('the result the route populates `dnc_recorded` from', () => {
  it('reports recorded:true on a new write', async () => {
    const res = await markDnc({ tenantId: TENANT, phoneE164: '+15551230001' });
    // Exact shape: this is the route's whole view of the write.
    expect(res).toEqual({
      recorded: true,
      alreadyPresent: false,
      phoneE164: '+15551230001',
      written: { campaign_id: null },
    });
  });

  it('echoes back the campaign the row was actually written at', async () => {
    mocks.insertMany.mockResolvedValue(insertResult(true, CAMPAIGN));
    const res = await markDnc({ tenantId: TENANT, phoneE164: '+15551230001', campaignId: CAMPAIGN });
    expect(res).toEqual({
      recorded: true,
      alreadyPresent: false,
      phoneE164: '+15551230001',
      written: { campaign_id: CAMPAIGN },
    });
  });

  it('reports the scope the ROW is at, NOT the one the request asked for', async () => {
    mocks.insertMany.mockResolvedValue(insertResult(false, null));
    const res = await markDnc({ tenantId: TENANT, phoneE164: '+15551230001', campaignId: CAMPAIGN });
    expect(res).toEqual({
      recorded: true,
      alreadyPresent: true,
      phoneE164: '+15551230001',
      // null — the row is tenant-wide — and emphatically not CAMPAIGN.
      written: { campaign_id: null },
    });
  });

  it('reports a campaign scope the request did NOT ask for, when that is where the row is', async () => {
    mocks.insertMany.mockResolvedValue(insertResult(false, CAMPAIGN));
    const res = await markDnc({ tenantId: TENANT, phoneE164: '+15551230001' });
    expect(res.written).toEqual({ campaign_id: CAMPAIGN });
  });

  it('reports recorded:TRUE for a redelivery, flagging alreadyPresent separately', async () => {
    mocks.insertMany.mockResolvedValue(insertResult(false));
    const res = await markDnc({ tenantId: TENANT, phoneE164: '+15551230001' });
    expect(res).toMatchObject({ recorded: true, alreadyPresent: true });
  });

  it('writes nothing for an unparseable number instead of claiming it was recorded', async () => {
    const res = await markDnc({ tenantId: TENANT, phoneE164: 'garbage' });
    expect(res).toEqual({ recorded: false, alreadyPresent: false, phoneE164: null, written: null });
    expect(mocks.insertMany).not.toHaveBeenCalled();
  });

  it("does not swallow a write failure into a false success — reported alone, rethrown inside the caller's transaction", async () => {
    mocks.insertMany.mockRejectedValue(new Error('deadlock detected'));
    const alone = await markDnc({ tenantId: TENANT, phoneE164: '+15551230001' });
    expect(alone.recorded).toBe(false);
    const client = { query: vi.fn(), release: vi.fn() };
    await expect(markDnc({ tenantId: TENANT, phoneE164: '+15551230001' }, { client: client as never }))
      .rejects.toThrow('deadlock detected');
    expect(mocks.insertMany.mock.calls[1]![1]).toEqual({ client });
  });
});

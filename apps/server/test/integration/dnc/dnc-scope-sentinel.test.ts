import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertTenant } from '../setup/factories.js';

/**
 * ─── THE NIL UUID IS THE INDEX'S TENANT-WIDE SENTINEL, AND `.uuid()` TAKES IT ──
 *
 * `uq_dnc_scope` COALESCEs both scope columns to
 * `00000000-0000-0000-0000-000000000000` (`050_dnc.sql`), because NULL never
 * equals NULL in a unique index. `z.string().uuid()` accepts that exact string —
 * verified against this repo's zod 3.25.76, not assumed. So before the guard,
 * `POST /internal/agency/dnc {campaign_id: "00000000-…"}` wrote a row whose index
 * key was **byte-identical to a tenant-wide row's** while `isTenantWide()`
 * correctly reported `false`.
 *
 * The damage is not that request. It is the NEXT one:
 *
 *   1. The nil-scoped row inserts. Not tenant-wide ⇒ no version, no publish, and
 *      `listTenantWidePhones` excludes it. Nothing looks wrong anywhere.
 *   2. A genuine "never call again, any campaign, forever" escalation arrives for
 *      the same number with no scope. Its `ON CONFLICT` collides with the nil
 *      row and does nothing; the fallback SELECT matches that same row.
 *   3. The mark answers `200 {recorded: true, already_present: true}`. The number
 *      is suppressed in exactly ONE campaign, having asked for everywhere.
 *
 * That is the precise failure this feature exists to prevent, in the direction it
 * exists to prevent it in, reported as a success.
 *
 * ── WHY THIS IS AN INTEGRATION TEST ─────────────────────────────────────────
 *
 * The collision in step 2 is a property of a COALESCE expression index. No unit
 * test can produce it: a mocked pool cannot enforce a unique index, so a unit
 * test asserting "the schema rejects the sentinel" passes equally against a guard
 * placed somewhere useless, and would keep passing if the index were changed so
 * that nothing needed guarding at all. Only rows in a real table can show that
 * the escalation lands.
 *
 * The two groups below are deliberately a matched pair, and neither is worth much
 * alone. The first drives the collision at the DATABASE level, bypassing the
 * schema entirely, so the hazard is demonstrated rather than asserted — if
 * Postgres ever separated those two keys, that group goes red and the guard
 * becomes removable. The second drives the same sequence through the ROUTE and
 * shows the guard turns step 1 into a 400, so the escalation in step 2 actually
 * lands. A guard in the wrong place passes the second group and fails the first's
 * premise silently.
 */

vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));

const { DncRepository } = await import('../../../src/dnc/dnc.repository.js');
const { markDnc } = await import('../../../src/agency/dnc-mark.js');
const repo = new DncRepository();

/** The literal `uq_dnc_scope` COALESCEs a NULL scope column to. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const PHONE = '+15551239001';

let tenantId: string;
let campaignId: string;

/** The rows `DncRegistry.check` blocks in EVERY campaign: both scope columns NULL. */
async function tenantWide(tid: string): Promise<string[]> {
  const { rows } = await getTestPool().query<{ phone_e164: string }>(
    `SELECT phone_e164 FROM dnc_entries WHERE tenant_id = $1 AND account_id IS NULL AND campaign_id IS NULL ORDER BY phone_e164`,
    [tid],
  );
  return rows.map((r) => r.phone_e164);
}

async function rowsFor(phone: string): Promise<Array<{ id: string; campaign_id: string | null }>> {
  const { rows } = await getTestPool().query<{ id: string; campaign_id: string | null }>(
    `SELECT id, campaign_id FROM dnc_entries WHERE tenant_id = $1 AND phone_e164 = $2
      ORDER BY campaign_id NULLS FIRST`,
    [tenantId, phone],
  );
  return rows;
}

beforeEach(async () => {
  await truncateAll();
  const tenant = await insertTenant();
  tenantId = tenant.id as string;
  campaignId = randomUUID();

});

afterAll(async () => {
  await closeTestPool();
});

describe('the hazard: a nil-UUID scope collides with tenant-wide in uq_dnc_scope', () => {
  /**
   * ── THE CASE THAT JUSTIFIES THE GUARD ───────────────────────────────────────
   * Written at the database level, deliberately bypassing the schema that now
   * forbids this, because the point is what the INDEX does — and the guard is
   * only worth having while this stays true.
   */
  it('SWALLOWS a genuine tenant-wide escalation behind a nil-scoped row', async () => {
    // Step 1: the row a nil-UUID campaign_id used to produce. Direct SQL — the
    // route can no longer create this, which is the fix.
    await getTestPool().query(
      `INSERT INTO dnc_entries (tenant_id, account_id, campaign_id, phone_e164, source)
       VALUES ($1, NULL, $2, $3, 'agent')`,
      [tenantId, NIL_UUID, PHONE],
    );

    // It is not tenant-wide, so it must not appear among the tenant-wide rows.
    expect(await tenantWide(tenantId)).toEqual([]);

    // Step 2: the escalation. No scope at all — "never call again, anywhere".
    const escalation = await repo.insertMany({
      tenant_id: tenantId,
      source: 'agent',
      phones: [PHONE],
    });

    /**
     * Every one of these is the fail-open direction, and every one is silent.
     * `created: false` is normally a benign idempotent success; here it means the
     * escalation was mistaken for a duplicate of a row that suppresses almost
     * nothing.
     */
    expect(escalation.results[0]!.created).toBe(false);

    // The number the caller demanded be blocked everywhere is in no tenant-wide
    // row, so it never counts as tenant-wide and every campaign
    // keeps dialing it.
    expect(await tenantWide(tenantId)).toEqual([]);

    // And there is exactly ONE row — the nil-scoped one. The escalation wrote
    // nothing at all.
    expect(await rowsFor(PHONE)).toEqual([{ id: expect.any(String), campaign_id: NIL_UUID }]);
  });

  it('a REAL campaign id does not swallow the escalation — the collision is the sentinel alone', async () => {
    /**
     * The contrast case, and what makes the one above mean something. If a
     * campaign-scoped row blocked a tenant-wide escalation in general, the bug
     * would be in the index or the feature and not in the accepted value — and
     * the fix would not be a schema guard. It does not: the two coexist.
     */
    await getTestPool().query(
      `INSERT INTO dnc_entries (tenant_id, account_id, campaign_id, phone_e164, source)
       VALUES ($1, NULL, $2, $3, 'agent')`,
      [tenantId, campaignId, PHONE],
    );

    const escalation = await repo.insertMany({
      tenant_id: tenantId,
      source: 'agent',
      phones: [PHONE],
    });

    expect(escalation.results[0]!.created).toBe(true);
    expect(await tenantWide(tenantId)).toEqual([PHONE]);
  });
});

/*
 * The matched pair's DATABASE half (the hazard group, 2 cases). There is no separate tenant-wide
 * set or sync version (decision B8), so "nothing tenant-wide was published" is asserted as a
 * direct query for tenant-wide rows (the rows `DncRegistry.check` blocks everywhere). The
 * agent's-mark half of the guard (sentinel refused, nothing written) is covered by
 * `agency/dnc-registry.test.ts`.
 */

/*
 * The agent's mark reaches `dnc_entries` through `markDnc`, called by the station DNC route
 * (`POST /proxy/agency/attempts/:id/dnc`), which resolves the campaign from the attempt and so
 * can never send the sentinel itself; the guard lives in `markDnc`
 * (`refused: 'invalid_dnc_scope'`, nothing written). So the sequence is driven through
 * `markDnc` on the real table, asserting its result (`refused`, `recorded`, `alreadyPresent`,
 * `written.campaign_id` — the receipt read back from the row). There is no entry id in the
 * result and no separate tenant-wide set or version (decision B8); "the escalation LANDS
 * tenant-wide" is asserted on the rows the dial-time check blocks everywhere.
 */
describe('the guard: the sequence, driven through markDnc', () => {
  it('refuses the nil-UUID mark, and the escalation that follows LANDS tenant-wide', async () => {
    const poison = await markDnc({ tenantId, phoneE164: PHONE, campaignId: NIL_UUID });

    expect(poison.refused).toBe('invalid_dnc_scope');
    expect(poison.recorded).toBe(false);
    // Nothing was written. A refusal raised after the insert would leave the trap set.
    expect(await rowsFor(PHONE)).toEqual([]);

    const escalation = await markDnc({ tenantId, phoneE164: PHONE });

    expect(escalation).toMatchObject({
      recorded: true,
      alreadyPresent: false,
      phoneE164: PHONE,
      written: { campaign_id: null },
    });
    expect(await tenantWide(tenantId)).toEqual([PHONE]);
    expect(await rowsFor(PHONE)).toEqual([{ id: expect.any(String), campaign_id: null }]);
  });

  it('a real campaign mark still works, then its escalation still lands', async () => {
    const scoped = await markDnc({ tenantId, phoneE164: PHONE, campaignId });

    expect(scoped).toMatchObject({ recorded: true, written: { campaign_id: campaignId } });
    expect(await tenantWide(tenantId)).toEqual([]);

    const escalation = await markDnc({ tenantId, phoneE164: PHONE });

    expect(escalation).toMatchObject({ alreadyPresent: false, written: { campaign_id: null } });
    expect(await tenantWide(tenantId)).toEqual([PHONE]);
    expect((await rowsFor(PHONE)).map((r) => r.campaign_id)).toEqual([null, campaignId]);
  });
});

describe('the receipt reports the row, checked against the table', () => {
  it('the written campaign_id in the result is the row that exists', async () => {
    const res = await markDnc({ tenantId, phoneE164: PHONE, campaignId });
    const rows = await rowsFor(PHONE);

    expect(rows).toHaveLength(1);
    expect(res.written?.campaign_id).toBe(rows[0]!.campaign_id);
  });

  it("reports the PRE-EXISTING row's scope on a redelivery, not the request's", async () => {
    await markDnc({ tenantId, phoneE164: PHONE, campaignId });
    const second = await markDnc({ tenantId, phoneE164: PHONE, campaignId });

    expect(second).toMatchObject({
      recorded: true,
      alreadyPresent: true,
      written: { campaign_id: campaignId },
    });
    expect(await rowsFor(PHONE)).toHaveLength(1);
  });
});

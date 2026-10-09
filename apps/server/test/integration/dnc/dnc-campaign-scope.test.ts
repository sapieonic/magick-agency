import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAccount, insertTenant } from '../setup/factories.js';

/**
 * ─── CAMPAIGN-SCOPED DNC MARKS · THE SCOPE BOUNDARY, AGAINST REAL POSTGRES ────
 *
 * An agent's mid-call "mark DNC" can now be confined to one campaign:
 * `POST /internal/agency/dnc` accepts a `campaign_id` and writes
 * `dnc_entries(campaign_id = <id>)` instead of a tenant-wide row. Two claims hold
 * that feature up, and **neither can be proven without a real database**:
 *
 *   1. `uq_dnc_scope` — a UNIQUE index over COALESCEd scope expressions — must let
 *      a campaign-scoped row and a tenant-wide row for the SAME number coexist.
 *      NULL never equals NULL in a unique index, which is exactly why the index
 *      COALESCEs to a sentinel; whether that arithmetic separates the two rows or
 *      collides them is a property of the index, not of any TypeScript.
 *   2. `listTenantWidePhones` must NOT return campaign-scoped numbers. It is the
 *      sole source of core's flat `dnc:{tenantId}` Redis set (§2.3), which has no
 *      way to express scope — so a campaign-scoped number leaking into it would be
 *      enforced at dial time across **every other campaign in the tenant**. The
 *      mark asked for one campaign and would silently suppress all of them.
 *
 * ── WHY THESE ARE INTEGRATION TESTS AND NOT UNIT TESTS ──────────────────────
 *
 * The unit suite mocks `getPool`, so everything it can say about either claim is a
 * statement about SQL *text*: `dnc.repository.test.ts` asserts the query string
 * contains `account_id IS NULL AND campaign_id IS NULL`. That pin is worth having
 * — it catches a rewrite that drops the predicate — but it cannot observe the
 * thing that matters, because a string containing the right words is not evidence
 * that Postgres excluded the row. Only rows in a table can be.
 *
 * The same applies with more force to `uq_dnc_scope`: a unit test cannot violate a
 * unique index, so a unit test cannot show that this one permits what we need it
 * to permit and still forbids what it exists to forbid.
 *
 * ── `listTenantWidePhones` IS DELIBERATELY UNCHANGED, AND THAT IS THE POINT ───
 *
 * This feature adds no code to that method. Its `account_id IS NULL AND
 * campaign_id IS NULL` filter was previously a near-tautology — before campaign
 * marks existed, essentially every row already satisfied it, so the predicate was
 * documentation. It is now the load-bearing boundary between "suppressed for one
 * campaign" and "suppressed for the whole tenant", and it acquired that job
 * without a line of it changing.
 *
 * That is the dangerous shape: a future reader sees an unconditional-looking
 * filter on a method whose only caller wants "this tenant's DNC numbers", and
 * widening it to `SELECT DISTINCT phone_e164 WHERE tenant_id = $1` looks like a
 * simplification. It is a compliance incident — every campaign-scoped mark in the
 * fleet becomes tenant-wide on the next reconcile sweep, with no error anywhere.
 * The cases below are what makes that edit fail loudly instead of shipping.
 */

vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));

const { DncRepository } = await import('../../../src/dnc/dnc.repository.js');

const repo = new DncRepository();

/** Distinct numbers, so a case that mixes scopes cannot pass by accident. */
const TENANT_WIDE_PHONE = '+15551230001';
const CAMPAIGN_PHONE = '+15551230002';
const ACCOUNT_PHONE = '+15551230003';
/** The number carried at two scopes at once — the coexistence case. */
const BOTH_SCOPES_PHONE = '+15551230004';

let tenantId: string;
let otherTenantId: string;
let accountId: string;
let campaignId: string;
let otherCampaignId: string;

/**
 * Insert one row directly, bypassing the repository.
 *
 * Deliberate: the assertions below are about what the *schema* does with a row and
 * what the read method returns for it. Writing the fixture through `insertMany`
 * would make a bug in `insertMany`'s scope handling capable of hiding a bug in
 * `listTenantWidePhones` — both would agree, and the pair would be green while the
 * feature was broken. `insertMany` gets its own case, separately, below.
 */
async function insertDncRow(row: {
  tenant_id: string;
  account_id?: string | null;
  campaign_id?: string | null;
  phone_e164: string;
  source?: string;
}): Promise<string> {
  const { rows } = await getTestPool().query<{ id: string }>(
    `INSERT INTO dnc_entries (tenant_id, account_id, campaign_id, phone_e164, source)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      row.tenant_id,
      row.account_id ?? null,
      row.campaign_id ?? null,
      row.phone_e164,
      row.source ?? 'agent',
    ],
  );
  return rows[0]!.id;
}

beforeEach(async () => {
  await truncateAll();

  const tenant = await insertTenant();
  tenantId = tenant.id as string;
  const other = await insertTenant();
  otherTenantId = other.id as string;
  const account = await insertAccount({ tenant_id: tenantId });
  accountId = account.id as string;

  /**
   * Campaign ids are invented here rather than inserted anywhere, because there is
   * nowhere in this database to insert them: `agency_campaigns` lives in **core's**
   * database and `dnc_entries.campaign_id` carries no foreign key (see the header
   * of `050_dnc.sql`). A test that needed a campaign row to exist would be
   * asserting a constraint this schema deliberately does not have.
   */
  campaignId = randomUUID();
  otherCampaignId = randomUUID();
});

afterAll(async () => {
  await closeTestPool();
});

/*
 * PORT NOTE (magick-agency, lane B1; decision B8). DELETED: the source's first
 * describe, "listTenantWidePhones — the boundary that keeps core from over-blocking"
 * (5 cases: "EXCLUDES a campaign-scoped row from what core receives", "excludes an
 * account-scoped row too — the filter has two halves", "excludes a row scoped to
 * BOTH an account and a campaign", "returns a number held tenant-wide even when the
 * SAME number is also campaign-scoped", "never leaks another tenant's tenant-wide
 * rows"). Its subject, the feed into core's flat Redis set, is not ported. The
 * property it protected — a campaign-scoped mark must not become a tenant-wide
 * block — is now carried by the dial-time check itself and is asserted against the
 * real table in `agency/dnc-registry.test.ts` (a campaign row blocks that campaign
 * only). `tenantWidePhones` below reads the same rows for the cases that remain.
 */

/** The rows that block a number in EVERY campaign: both scope columns NULL. */
async function tenantWidePhones(tid: string): Promise<string[]> {
  const { rows } = await getTestPool().query<{ phone_e164: string }>(
    `SELECT phone_e164 FROM dnc_entries WHERE tenant_id = $1 AND account_id IS NULL AND campaign_id IS NULL ORDER BY phone_e164`,
    [tid],
  );
  return rows.map((r) => r.phone_e164);
}

describe('uq_dnc_scope — the COALESCE index must SEPARATE scopes, not collide them', () => {
  it('lets a campaign-scoped row and a tenant-wide row for the same number coexist', async () => {
    const tenantWideId = await insertDncRow({
      tenant_id: tenantId,
      phone_e164: BOTH_SCOPES_PHONE,
    });

    /**
     * This is the write that would fail if the index COALESCEd the two scopes
     * together — and it is the whole feature: "suppress for this campaign" plus a
     * later "never call again" escalation are two rows about one number, and the
     * escalation must not be rejected as a duplicate of the campaign mark.
     */
    const campaignScopedId = await insertDncRow({
      tenant_id: tenantId,
      campaign_id: campaignId,
      phone_e164: BOTH_SCOPES_PHONE,
    });

    expect(campaignScopedId).not.toBe(tenantWideId);

    const { rows } = await getTestPool().query<{ campaign_id: string | null }>(
      `SELECT campaign_id FROM dnc_entries
        WHERE tenant_id = $1 AND phone_e164 = $2
        ORDER BY campaign_id NULLS FIRST`,
      [tenantId, BOTH_SCOPES_PHONE],
    );
    expect(rows.map((r) => r.campaign_id)).toEqual([null, campaignId]);
  });

  it('separates two different campaigns for the same number', async () => {
    await insertDncRow({ tenant_id: tenantId, campaign_id: campaignId, phone_e164: CAMPAIGN_PHONE });
    await insertDncRow({
      tenant_id: tenantId,
      campaign_id: otherCampaignId,
      phone_e164: CAMPAIGN_PHONE,
    });

    const { rows } = await getTestPool().query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM dnc_entries WHERE tenant_id = $1 AND phone_e164 = $2`,
      [tenantId, CAMPAIGN_PHONE],
    );
    expect(rows[0]!.count).toBe('2');
  });

  /**
   * ── WHAT MAKES THE COEXISTENCE CASES ABOVE MEAN ANYTHING ────────────────────
   * Without this case they are all satisfied by an index that does not exist. A
   * dropped or mis-specified `uq_dnc_scope` would let every insert above through
   * and leave the suite green while duplicates accumulated silently — which is
   * precisely the failure the COALESCE was written to prevent (see `050_dnc.sql`:
   * "without that the index is vacuous for every tenant-wide row").
   */
  it('STILL rejects a true duplicate — same tenant, same campaign, same number', async () => {
    await insertDncRow({ tenant_id: tenantId, campaign_id: campaignId, phone_e164: CAMPAIGN_PHONE });

    await expect(
      insertDncRow({ tenant_id: tenantId, campaign_id: campaignId, phone_e164: CAMPAIGN_PHONE }),
    ).rejects.toThrow(/uq_dnc_scope|duplicate key/i);
  });

  it('STILL rejects a duplicate tenant-wide row, which is what the COALESCE is for', async () => {
    await insertDncRow({ tenant_id: tenantId, phone_e164: TENANT_WIDE_PHONE });

    // Two NULL scope columns. A plain `(tenant_id, account_id, campaign_id,
    // phone_e164)` unique index would permit this, because NULL != NULL.
    await expect(
      insertDncRow({ tenant_id: tenantId, phone_e164: TENANT_WIDE_PHONE }),
    ).rejects.toThrow(/uq_dnc_scope|duplicate key/i);
  });
});

describe('insertMany — a campaign-scoped add writes exactly its own row', () => {
  it('writes one campaign-scoped row and no tenant-wide one', async () => {
    const result = await repo.insertMany({
      tenant_id: tenantId,
      campaign_id: campaignId,
      source: 'agent',
      phones: [CAMPAIGN_PHONE],
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.created).toBe(true);
    expect(result.results[0]!.entry.campaign_id).toBe(campaignId);

    // PORT NOTE: the source asserted no sync version and no `dnc_sync_state` row
    // (the table is not carried). The scope property it stood for is this:
    expect(await tenantWidePhones(tenantId)).toEqual([]);
  });

  it('a tenant-wide add writes a tenant-wide row, so the line above is scope and not breakage', async () => {
    await repo.insertMany({ tenant_id: tenantId, source: 'agent', phones: [TENANT_WIDE_PHONE] });
    expect(await tenantWidePhones(tenantId)).toEqual([TENANT_WIDE_PHONE]);
  });

  it('is idempotent per scope — re-marking one campaign creates nothing new', async () => {
    await repo.insertMany({
      tenant_id: tenantId,
      campaign_id: campaignId,
      source: 'agent',
      phones: [CAMPAIGN_PHONE],
    });
    const second = await repo.insertMany({
      tenant_id: tenantId,
      campaign_id: campaignId,
      source: 'agent',
      phones: [CAMPAIGN_PHONE],
    });

    // Exercises the `ON CONFLICT ${UQ_DNC_SCOPE_TARGET} DO NOTHING` fallback SELECT
    // against the real index. That target has to spell the COALESCE expressions
    // out character-for-character or Postgres raises "there is no unique or
    // exclusion constraint matching" — an error no mocked pool can produce.
    expect(second.results[0]!.created).toBe(false);
  });

  it('a campaign mark and a tenant-wide escalation both land, via insertMany', async () => {
    const scoped = await repo.insertMany({
      tenant_id: tenantId,
      campaign_id: campaignId,
      source: 'agent',
      phones: [BOTH_SCOPES_PHONE],
    });
    const escalated = await repo.insertMany({
      tenant_id: tenantId,
      source: 'agent',
      phones: [BOTH_SCOPES_PHONE],
    });

    // The end-to-end shape of the feature: neither write is mistaken for the
    // other's duplicate, and only the escalation reaches core.
    expect(scoped.results[0]!.created).toBe(true);
    expect(escalated.results[0]!.created).toBe(true);
    expect(await tenantWidePhones(tenantId)).toEqual([BOTH_SCOPES_PHONE]);
  });
});

describe('deleteById — removing one scope leaves the others', () => {
  it('removing the tenant-wide row leaves the campaign-scoped row, and the number is no longer blocked everywhere', async () => {
    await repo.insertMany({
      tenant_id: tenantId,
      campaign_id: campaignId,
      source: 'agent',
      phones: [BOTH_SCOPES_PHONE],
    });
    const tenantWide = await repo.insertMany({
      tenant_id: tenantId,
      source: 'agent',
      phones: [BOTH_SCOPES_PHONE],
    });

    const removed = await repo.deleteById(tenantWide.results[0]!.entry.id, tenantId);

    /**
     * The survivor check is `account_id IS NULL AND campaign_id IS NULL`, so the
     * campaign-scoped row must NOT count as a survivor. If it did, master would
     * skip the version bump, core would keep the number in its flat set forever,
     * and a number an operator deliberately un-suppressed would stay blocked
     * tenant-wide with the list showing it as removed.
     */
    expect(removed?.entry.id).toBe(tenantWide.results[0]!.entry.id);
    expect(await tenantWidePhones(tenantId)).toEqual([]);

    // …and the campaign-scoped suppression is untouched. Deleting the escalation
    // means "stop blocking this everywhere", not "stop blocking it anywhere".
    const { rows } = await getTestPool().query<{ campaign_id: string | null }>(
      `SELECT campaign_id FROM dnc_entries WHERE tenant_id = $1 AND phone_e164 = $2`,
      [tenantId, BOTH_SCOPES_PHONE],
    );
    expect(rows.map((r) => r.campaign_id)).toEqual([campaignId]);
  });

  it('removing the campaign-scoped row removes exactly that row', async () => {
    const scoped = await repo.insertMany({
      tenant_id: tenantId,
      campaign_id: campaignId,
      source: 'agent',
      phones: [CAMPAIGN_PHONE],
    });

    const removed = await repo.deleteById(scoped.results[0]!.entry.id, tenantId);

    expect(removed?.entry.campaign_id).toBe(campaignId);
    // Publishing an SREM for a number core was never told about is a no-op on
    // Redis but not on the watermark: it would consume a version and make the
    // delta stream claim a change core cannot reconcile against anything.
  });
});

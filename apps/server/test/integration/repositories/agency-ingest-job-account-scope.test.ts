/**
 * ClickUp `14ygtkj8rvv` — the ACCOUNT axis of an agency ingest job, against a
 * real Postgres.
 *
 * `requirePermission` proves the caller's role and never looks at the row, and
 * `findById` / `requestCancel` filtered on `id + tenant_id` only — so an
 * account-scoped caller of sibling account B who knew A's job id could poll
 * A's import, stream its rejected-row CSV (roster PII) and cancel it. The
 * routes now pass the caller's `membership.account_id`; this file pins what the
 * SQL does with it, because a mocked pool never evaluates a `WHERE`.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { getTestPool, closeTestPool, truncateAll } from '../setup/test-utils.js';
import { insertTenant, insertAccount } from '../setup/factories.js';

vi.mock('@magick-agency/db', () => ({
  getPool: () => getTestPool(),
}));

const { agencyIngestJobRepository } = await import('../../../src/agency/agency-ingest-job.repository.js');

describe('agencyIngestJobRepository account scope (integration)', () => {
  let tenantId: string;
  let accountA: string;
  let accountB: string;

  async function createJob(accountId: string | null) {
    return agencyIngestJobRepository.create({
      tenant_id: tenantId,
      account_id: accountId,
      campaign_id: null,
      s3_key: `agency-ingest/${tenantId}/u/roster.csv`,
      file_name: 'roster.csv',
      phone_column: 'Mobile',
      dry_run: true,
    });
  }

  beforeEach(async () => {
    await truncateAll();
    const tenant = await insertTenant();
    tenantId = tenant.id;
    accountA = (await insertAccount({ tenant_id: tenantId })).id;
    accountB = (await insertAccount({ tenant_id: tenantId })).id;
  });

  afterAll(async () => {
    await closeTestPool();
  });

  describe('findById', () => {
    it('an account-scoped caller cannot read a sibling account\'s job', async () => {
      const job = await createJob(accountA);
      await expect(agencyIngestJobRepository.findById(job.id, tenantId, accountB)).resolves.toBeNull();
    });

    it('an account-scoped caller reads its own account\'s job', async () => {
      const job = await createJob(accountA);
      const found = await agencyIngestJobRepository.findById(job.id, tenantId, accountA);
      expect(found?.id).toBe(job.id);
    });

    it('a tenant-wide job (account_id NULL) is NOT reachable to an account-scoped caller', async () => {
      // Equality, not `IS NULL OR =` — the dncRepository.deleteById call.
      const job = await createJob(null);
      await expect(agencyIngestJobRepository.findById(job.id, tenantId, accountA)).resolves.toBeNull();
    });

    it('a tenant-wide caller reads every job in the tenant', async () => {
      const a = await createJob(accountA);
      const t = await createJob(null);
      expect((await agencyIngestJobRepository.findById(a.id, tenantId, null))?.id).toBe(a.id);
      expect((await agencyIngestJobRepository.findById(t.id, tenantId))?.id).toBe(t.id);
    });

    it('the tenant predicate still holds on the scoped branch', async () => {
      const job = await createJob(accountA);
      const other = await insertTenant();
      await expect(agencyIngestJobRepository.findById(job.id, other.id, accountA)).resolves.toBeNull();
    });
  });

  describe('requestCancel', () => {
    async function cancelFlag(id: string): Promise<boolean> {
      const r = await getTestPool().query<{ cancel_requested: boolean }>(
        'SELECT cancel_requested FROM agency_ingest_jobs WHERE id = $1',
        [id],
      );
      return r.rows[0]!.cancel_requested;
    }

    it('an account-scoped caller cannot cancel a sibling account\'s import', async () => {
      const job = await createJob(accountA);
      await expect(agencyIngestJobRepository.requestCancel(job.id, tenantId, accountB)).resolves.toBe(false);
      expect(await cancelFlag(job.id)).toBe(false);
    });

    it('an account-scoped caller cancels its own import', async () => {
      const job = await createJob(accountA);
      await expect(agencyIngestJobRepository.requestCancel(job.id, tenantId, accountA)).resolves.toBe(true);
      expect(await cancelFlag(job.id)).toBe(true);
    });

    it('a tenant-wide caller cancels any live import in the tenant', async () => {
      const job = await createJob(accountA);
      await expect(agencyIngestJobRepository.requestCancel(job.id, tenantId, null)).resolves.toBe(true);
      expect(await cancelFlag(job.id)).toBe(true);
    });

    it('the scoped branch still refuses a terminal job', async () => {
      const job = await createJob(accountA);
      await agencyIngestJobRepository.markCancelled(job.id);
      await expect(agencyIngestJobRepository.requestCancel(job.id, tenantId, accountA)).resolves.toBe(false);
    });
  });
});

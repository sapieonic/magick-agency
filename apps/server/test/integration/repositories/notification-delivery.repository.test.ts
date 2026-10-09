/**
 * The claim-before-send ledger, against REAL Postgres.
 *
 * ── Why this file exists next to the unit suite ────────────────────────────
 *
 * `test/unit/notifications/...` drives this repository against a mocked pool. A
 * mocked pool returns whatever the test told it to and never parses the SQL, so
 * the entire mechanism this table exists for is invisible to it. Everything
 * below is a property of the DATABASE rather than of the TypeScript:
 *
 *   - `ON CONFLICT DO NOTHING RETURNING` returning FEWER rows than it was given
 *     is the whole idempotency guarantee, and only a real unique index can
 *     produce it. A mock returns the rows it was handed.
 *   - Which four columns are in `uq_notification_deliveries_claim`. Drop
 *     `tenant_id` from the index and every unit test still passes — the mock has
 *     no index to disagree with. That exact defect has occurred: a person
 *     administering two tenants received the first workspace's digest and had
 *     the second silently skipped as a duplicate. It is asserted explicitly
 *     below.
 *   - What happens when two callers race. `exactly one wins` is a statement
 *     about Postgres' unique-index arbitration under concurrent transactions,
 *     which is not a thing a mock has.
 *   - The `CHECK (status IN (...))` constraint, the `account_id` FK to
 *     `accounts(id)`, and the `tenant_id` NOT NULL FK. TypeScript's
 *     `NotificationDeliveryStatus` union is not enforcement; the constraint is.
 *   - `AND status = 'pending'` on `recordOutcomeByKey` / `release` /
 *     `releaseByKey`. A predicate that matches nothing and a predicate that
 *     matches the right rows are the same string.
 *
 * ── The pool is redirectable, on purpose ───────────────────────────────────
 *
 * `getPool()` is mocked to a holder rather than straight to `getTestPool()`, so
 * the concurrency test can point the REAL repository method at a specific
 * checked-out client inside a real transaction. That keeps the racing statement
 * the production statement — a hand-copied INSERT in the test would prove only
 * that the test's own SQL conflicts with itself.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { getTestPool, closeTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { insertTenant, insertAccount } from '../../../../../packages/db/test/integration/setup/platform-factories.js';
import { randomUUID } from 'node:crypto';

/**
 * Set `current` to a checked-out client and the repository runs on THAT
 * connection; leave it null and it runs on the shared pool as production does.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const holder = vi.hoisted(() => ({ current: null as any }));

// The repository's `getPool` comes from `@magick-agency/db`, so that is the
// specifier mocked. Kept as a mock (not `initDbPool`) because the holder is the
// point — see the header. `event_key` values are opaque TEXT to the repository.
vi.mock('@magick-agency/db', () => ({
  getPool: () => holder.current ?? getTestPool(),
}));

const { notificationDeliveryRepository: repo } = await import(
  '../../../src/db/repositories/notification-delivery.repository.js'
);

/** Mirrors `MAX_ERROR_LENGTH` in the repository. Not exported; pinned here. */
const MAX_ERROR_LENGTH = 500;

const EVENT = 'usage.digest';
const DEDUPE = 'weekly:2026-09-07:tenant:x';

interface DeliveryRow {
  id: string;
  event_key: string;
  dedupe_key: string;
  recipient: string;
  tenant_id: string;
  account_id: string | null;
  status: string;
  error: string | null;
  sent_at: Date | null;
}

async function rows(): Promise<DeliveryRow[]> {
  const { rows: r } = await getTestPool().query<DeliveryRow>(
    `SELECT * FROM notification_deliveries ORDER BY recipient, tenant_id, event_key, dedupe_key`,
  );
  return r;
}

/** Postgres error code off a thrown pg error, or the message when there is none. */
async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return (err as { code?: string }).code ?? `no-code: ${(err as Error).message}`;
  }
  return 'no-error';
}

describe('notificationDeliveryRepository (integration)', () => {
  let tenant: any;
  let account: any;

  beforeEach(async () => {
    await truncateAll();
    tenant = await insertTenant();
    account = await insertAccount({ tenant_id: tenant.id });
  });

  afterEach(() => {
    holder.current = null;
  });

  afterAll(async () => {
    await closeTestPool();
  });

  // ── Idempotency, for real ────────────────────────────────────────────────

  describe('claim — idempotency', () => {
    it('claims each recipient once and returns zero rows on the second claim', async () => {
      const recipients = ['a@example.com', 'b@example.com'];
      const input = {
        eventKey: EVENT,
        tenantId: tenant.id,
        accountId: null,
        dedupeKey: DEDUPE,
        recipients,
      };

      const first = await repo.claim(input);
      expect(first.map((c) => c.recipient).sort()).toEqual(recipients);

      // The claim the retry gets. `ON CONFLICT DO NOTHING RETURNING` returns the
      // rows it actually INSERTED, so a full re-run comes back empty — and that
      // is the only thing standing between an at-least-once trigger and a
      // duplicate digest.
      const second = await repo.claim(input);
      expect(second).toEqual([]);

      // And no duplicate row was written. The unique index, not the RETURNING
      // clause, is what guarantees this.
      const all = await rows();
      expect(all).toHaveLength(2);
      expect(all.map((r) => r.recipient)).toEqual(recipients);
    });

    it('claims only the NEW recipient when a claim partially overlaps', async () => {
      const base = { eventKey: EVENT, tenantId: tenant.id, accountId: null, dedupeKey: DEDUPE };

      await repo.claim({ ...base, recipients: ['a@example.com'] });
      const second = await repo.claim({
        ...base,
        recipients: ['a@example.com', 'b@example.com'],
      });

      // One statement, partially conflicting: `DO NOTHING` skips the conflicting
      // row and inserts the other. A loop would have half-claimed.
      expect(second.map((c) => c.recipient)).toEqual(['b@example.com']);
      expect(await rows()).toHaveLength(2);
    });

    it('collapses duplicate recipients inside ONE call before they reach the index', async () => {
      // The repository de-duplicates the array before the statement runs. Worth
      // pinning against the real index rather than trusting the `Set`: the same
      // pair carried twice into a `DO UPDATE` raises `21000 — command cannot
      // affect row a second time` (see the preference suite, where that arm is
      // reachable), so "one row per address per statement" is a property this
      // table's writers must keep, not an incidental one.
      const claims = await repo.claim({
        eventKey: EVENT,
        tenantId: tenant.id,
        accountId: null,
        dedupeKey: DEDUPE,
        recipients: ['a@example.com', 'a@example.com', 'a@example.com'],
      });

      expect(claims).toHaveLength(1);
      expect(await rows()).toHaveLength(1);
    });
  });

  // ── Concurrency ──────────────────────────────────────────────────────────

  describe('claim — concurrency', () => {
    it('lets exactly one of two racing transactions win the same key', async () => {
      const pool = getTestPool();
      const a = await pool.connect();
      const b = await pool.connect();

      const input = {
        eventKey: EVENT,
        tenantId: tenant.id,
        accountId: null,
        dedupeKey: DEDUPE,
        recipients: ['race@example.com'],
      };

      try {
        await a.query('BEGIN');
        await b.query('BEGIN');

        // A claims, uncommitted.
        holder.current = a;
        const claimedA = await repo.claim(input);
        expect(claimedA).toHaveLength(1);

        // B issues the SAME statement on a SECOND connection. Postgres cannot
        // decide the conflict until A commits or rolls back, so this blocks on
        // the unique index — a real property no mock has.
        holder.current = b;
        const pendingB = repo.claim(input);
        await waitForBlockedBackend();

        holder.current = null;
        await a.query('COMMIT');

        // B unblocks, sees the now-committed row, and DOES NOTHING.
        const claimedB = await pendingB;
        expect(claimedB).toEqual([]);
        await b.query('COMMIT');
      } finally {
        holder.current = null;
        a.release();
        b.release();
      }

      const all = await rows();
      expect(all).toHaveLength(1);
      expect(all[0]!.recipient).toBe('race@example.com');
    });

    it('writes exactly one row when many claims for one key run at once', async () => {
      const input = {
        eventKey: EVENT,
        tenantId: tenant.id,
        accountId: null,
        dedupeKey: DEDUPE,
        recipients: ['storm@example.com'],
      };

      // Four independent pool connections, the shape a Lambda retry landing on a
      // second instance actually takes.
      const results = await Promise.all([
        repo.claim(input),
        repo.claim(input),
        repo.claim(input),
        repo.claim(input),
      ]);

      const winners = results.filter((r) => r.length === 1);
      expect(winners).toHaveLength(1);
      expect(await rows()).toHaveLength(1);
    });
  });

  // ── Each dimension of the unique key separates claims ────────────────────

  describe('claim — the unique key has four columns, and each one is load-bearing', () => {
    const base = () => ({
      eventKey: EVENT,
      tenantId: tenant.id,
      accountId: null,
      dedupeKey: DEDUPE,
      recipients: ['same@example.com'],
    });

    it('separates on event_key', async () => {
      expect(await repo.claim(base())).toHaveLength(1);
      expect(await repo.claim({ ...base(), eventKey: 'campaign.completed' })).toHaveLength(1);
      expect(await rows()).toHaveLength(2);
    });

    it('separates on dedupe_key', async () => {
      expect(await repo.claim(base())).toHaveLength(1);
      expect(
        await repo.claim({ ...base(), dedupeKey: 'weekly:2026-09-14:tenant:x' }),
      ).toHaveLength(1);
      expect(await rows()).toHaveLength(2);
    });

    it('separates on recipient', async () => {
      expect(await repo.claim(base())).toHaveLength(1);
      expect(await repo.claim({ ...base(), recipients: ['other@example.com'] })).toHaveLength(1);
      expect(await rows()).toHaveLength(2);
    });

    /**
     * THE case migration 072 was corrected for, written out in full.
     *
     * A consultant is `account_admin` in tenants A and B. Same event, same
     * period, same inbox — the only thing that differs is the workspace. With
     * `tenant_id` out of the index, B's INSERT hits A's row, `DO NOTHING`
     * returns nothing, and the runner counts it a duplicate: the second
     * workspace's digest is never sent and nothing anywhere reports it.
     *
     * Nothing in TypeScript can catch that. This is the test that can.
     */
    it('separates on tenant_id — same person, same period, same inbox, two tenants', async () => {
      const other = await insertTenant();
      const consultant = 'consultant@example.com';

      // Both runs build the identical dedupe key: the frequency and the period
      // start are the same, and the scope token names the tenant only because
      // the ENGINE puts it there — the index must not depend on that.
      const sharedDedupe = 'weekly:2026-09-07';

      const inA = await repo.claim({
        eventKey: EVENT,
        tenantId: tenant.id,
        accountId: null,
        dedupeKey: sharedDedupe,
        recipients: [consultant],
      });
      const inB = await repo.claim({
        eventKey: EVENT,
        tenantId: other.id,
        accountId: null,
        dedupeKey: sharedDedupe,
        recipients: [consultant],
      });

      expect(inA).toHaveLength(1);
      expect(inB).toHaveLength(1);

      const all = await rows();
      expect(all).toHaveLength(2);
      expect(new Set(all.map((r) => r.tenant_id))).toEqual(new Set([tenant.id, other.id]));
      expect(all.every((r) => r.recipient === consultant)).toBe(true);
    });

    /**
     * `account_id` is NOT in the unique key, and that is deliberate — the scope
     * is carried in the `dedupe_key` (`tenant:<uuid>` / `account:<uuid>`)
     * instead. So two claims differing ONLY by account collide, and the engine's
     * scope token is what keeps them apart. Pinned so a reader does not "fix"
     * one half without the other.
     */
    it('does NOT separate on account_id alone — the scope lives in the dedupe key', async () => {
      const first = await repo.claim({ ...base(), accountId: null });
      const second = await repo.claim({ ...base(), accountId: account.id });

      expect(first).toHaveLength(1);
      expect(second).toEqual([]);
      expect(await rows()).toHaveLength(1);

      // …and with the engine's scope token in the key, they separate.
      const scoped = await repo.claim({
        ...base(),
        accountId: account.id,
        dedupeKey: `${DEDUPE}:account:${account.id}`,
      });
      expect(scoped).toHaveLength(1);
      expect(await rows()).toHaveLength(2);
    });
  });

  // ── account_id: the sentinel and the dangling uuid ───────────────────────

  describe('claim — account_id normalisation against the real FK', () => {
    it("normalises the 'default' sentinel away rather than casting it", async () => {
      // `bulk_dispatch_jobs.account_id` is `VARCHAR(255) NOT NULL DEFAULT
      // 'default'`, and `job-completion.ts` passes `job.account_id` straight
      // through. `'default'` is not uuid-shaped, so the repository's `isUuid`
      // guard turns it into NULL — without which `$4::uuid` would raise `22P02`
      // and the campaign gate would withhold the mail.
      const claims = await repo.claim({
        eventKey: 'campaign.completed',
        tenantId: tenant.id,
        accountId: 'default' as unknown as string,
        dedupeKey: 'job:abc',
        recipients: ['ops@example.com'],
      });

      expect(claims).toHaveLength(1);
      const all = await rows();
      expect(all[0]!.account_id).toBeNull();
    });

    it('stores a real account id', async () => {
      await repo.claim({
        eventKey: EVENT,
        tenantId: tenant.id,
        accountId: account.id,
        dedupeKey: DEDUPE,
        recipients: ['a@example.com'],
      });
      expect((await rows())[0]!.account_id).toBe(account.id);
    });

    /**
     * ── The dangling-account-uuid case, and why it must not raise ───────────
     *
     * `notification_deliveries.account_id` has an FK to `accounts(id)`.
     * `bulk_dispatch_jobs.account_id` has NONE (verified: the table's only FKs
     * are `retry_of_job_id` and `schedule_id`). So a historical job row can
     * carry a well-formed uuid for an account that has since been deleted, and
     * `job-completion.ts` hands `job.account_id` to this method unchanged.
     *
     * `isUuid(accountId)` is a SHAPE check, not an existence check, so it turns
     * the `'default'` sentinel into NULL but passes a dangling uuid straight to
     * the FK — which raised `23503`. That is far worse than losing the scoping:
     * the whole multi-row INSERT is ONE statement, so the abort took every
     * recipient with it, `gateCampaignNotification` caught it, counted
     * `claim_error` and returned `[]`, and the campaign notice was silently
     * withheld from EVERYBODY.
     *
     * `claim` now resolves the account through a scalar subquery, so a missing
     * account yields NULL — the same value `ON DELETE SET NULL` would have left
     * had the row been written before the deletion. Reverting that subquery to a
     * bare `$4::uuid` bind reds both tests below.
     */
    it('claims with a NULL scope for a uuid naming an account that does not exist', async () => {
      const ghost = randomUUID();

      const claims = await repo.claim({
        eventKey: 'campaign.completed',
        tenantId: tenant.id,
        accountId: ghost,
        dedupeKey: 'job:ghost',
        recipients: ['ops@example.com'],
      });

      // The mail goes out; only the scope is lost.
      expect(claims).toHaveLength(1);
      expect(claims[0]!.recipient).toBe('ops@example.com');
      const written = await rows();
      expect(written).toHaveLength(1);
      expect(written[0]!.account_id).toBeNull();
    });

    it('claims every recipient when the account was deleted after the job row', async () => {
      // The production shape: the account existed when the job was created, and
      // the job row survived it because there is no FK to cascade. The point of
      // the multi-recipient list is that a regression loses ALL of them.
      const doomed = await insertAccount({ tenant_id: tenant.id });
      await getTestPool().query(`DELETE FROM accounts WHERE id = $1`, [doomed.id]);

      const claims = await repo.claim({
        eventKey: 'campaign.completed',
        tenantId: tenant.id,
        accountId: doomed.id,
        dedupeKey: 'job:orphaned',
        recipients: ['ops@example.com', 'lead@example.com', 'boss@example.com'],
      });

      expect(claims.map((c) => c.recipient).sort()).toEqual([
        'boss@example.com', 'lead@example.com', 'ops@example.com',
      ]);
      expect((await rows()).every((r) => r.account_id === null)).toBe(true);
    });

    /**
     * ── A FOREIGN account uuid, which the bare existence test resolved ──────
     *
     * The subquery above fixed the dangling-uuid abort, but `WHERE a.id = $4`
     * alone answers for an account in ANY tenant — and `bulk_dispatch_jobs`
     * has no tenant check on its `account_id` any more than it has an FK, so a
     * stale or hand-repaired job row can name somebody else's account. That
     * wrote tenant A's delivery row carrying tenant B's `account_id`: the FK is
     * satisfied, nothing raises, and the row is quietly mis-scoped.
     *
     * With `AND a.tenant_id = $3` a foreign id lands on the same NULL a deleted
     * one gets, which is the honest answer — the delivery cannot be scoped,
     * so it records no scope. Reverting the predicate reds this.
     *
     * Not a live cross-tenant leak today: nothing reads this column as an
     * authorization filter. It is closed now because the day it becomes one is
     * not the day to discover the rows were already wrong.
     */
    it('claims with a NULL scope for an account belonging to ANOTHER tenant', async () => {
      const otherTenant = await insertTenant();
      const foreign = await insertAccount({ tenant_id: otherTenant.id });

      const claims = await repo.claim({
        eventKey: 'campaign.completed',
        tenantId: tenant.id,
        accountId: foreign.id,
        dedupeKey: 'job:foreign-account',
        recipients: ['ops@example.com'],
      });

      // The mail still goes out — withholding it would be the 23503 bug again.
      expect(claims).toHaveLength(1);
      const written = await rows();
      expect(written).toHaveLength(1);
      // ...and it is NOT stamped with the other tenant's account.
      expect(written[0]!.account_id).toBeNull();
      expect(written[0]!.tenant_id).toBe(tenant.id);
    });

    it('still stores an account of the CALLING tenant', async () => {
      // The other direction: the tenant predicate must not reject the ordinary
      // case it was added around.
      await repo.claim({
        eventKey: EVENT,
        tenantId: tenant.id,
        accountId: account.id,
        dedupeKey: 'job:own-account',
        recipients: ['a@example.com'],
      });
      expect((await rows())[0]!.account_id).toBe(account.id);
    });

    it('raises 23503 for a tenant that does not exist', async () => {
      const code = await codeOf(() =>
        repo.claim({
          eventKey: EVENT,
          tenantId: randomUUID(),
          accountId: null,
          dedupeKey: DEDUPE,
          recipients: ['a@example.com'],
        }),
      );
      expect(code).toBe('23503');
    });

    it('returns empty without touching the database for a non-uuid tenant id', async () => {
      // The shape guard EXISTS on tenant_id too, and here it is the right answer
      // — a `22P02` mid-fan-out would kill the run.
      expect(await repo.claim({
        eventKey: EVENT,
        tenantId: 'not-a-uuid',
        accountId: null,
        dedupeKey: DEDUPE,
        recipients: ['a@example.com'],
      })).toEqual([]);
      expect(await rows()).toEqual([]);
    });
  });

  // ── The CHECK constraint ─────────────────────────────────────────────────

  describe('status CHECK constraint', () => {
    it('accepts every member of the documented set', async () => {
      for (const status of ['pending', 'sent', 'failed', 'skipped']) {
        await getTestPool().query(
          `INSERT INTO notification_deliveries
             (event_key, dedupe_key, recipient, tenant_id, status)
           VALUES ($1, $2, $3, $4::uuid, $5)`,
          [EVENT, DEDUPE, `${status}@example.com`, tenant.id, status],
        );
      }
      expect(await rows()).toHaveLength(4);
    });

    it('rejects a status outside the set with 23514', async () => {
      const code = await codeOf(() =>
        getTestPool().query(
          `INSERT INTO notification_deliveries
             (event_key, dedupe_key, recipient, tenant_id, status)
           VALUES ($1, $2, $3, $4::uuid, 'bounced')`,
          [EVENT, DEDUPE, 'x@example.com', tenant.id],
        ),
      );
      expect(code).toBe('23514');
    });

    it('rejects an off-union status routed through recordOutcome — TypeScript is not the enforcement', async () => {
      const [claim] = await repo.claim({
        eventKey: EVENT,
        tenantId: tenant.id,
        accountId: null,
        dedupeKey: DEDUPE,
        recipients: ['a@example.com'],
      });

      const code = await codeOf(() =>
        repo.recordOutcome(claim!.id, 'delivered' as never, null),
      );
      expect(code).toBe('23514');

      // The row is untouched — the UPDATE was refused, not partially applied.
      expect((await rows())[0]!.status).toBe('pending');
    });

    it('defaults a row with no status to pending', async () => {
      await repo.claim({
        eventKey: EVENT,
        tenantId: tenant.id,
        accountId: null,
        dedupeKey: DEDUPE,
        recipients: ['a@example.com'],
      });
      const row = (await rows())[0]!;
      expect(row.status).toBe('pending');
      expect(row.sent_at).toBeNull();
      expect(row.error).toBeNull();
    });
  });

  // ── recordOutcome / recordOutcomeByKey ───────────────────────────────────

  describe('recordOutcome', () => {
    async function claimOne(recipient = 'a@example.com') {
      const [claim] = await repo.claim({
        eventKey: EVENT,
        tenantId: tenant.id,
        accountId: null,
        dedupeKey: DEDUPE,
        recipients: [recipient],
      });
      return claim!;
    }

    it("stamps sent_at only for 'sent'", async () => {
      const sent = await claimOne('sent@example.com');
      const failed = await claimOne('failed@example.com');

      await repo.recordOutcome(sent.id, 'sent', null);
      await repo.recordOutcome(failed.id, 'failed', 'mailjet 400: bad address');

      const all = await rows();
      const sentRow = all.find((r) => r.recipient === 'sent@example.com')!;
      const failedRow = all.find((r) => r.recipient === 'failed@example.com')!;

      expect(sentRow.status).toBe('sent');
      expect(sentRow.sent_at).toBeInstanceOf(Date);
      expect(sentRow.error).toBeNull();

      expect(failedRow.status).toBe('failed');
      expect(failedRow.sent_at).toBeNull();
      expect(failedRow.error).toBe('mailjet 400: bad address');
    });

    /**
     * `error` is TEXT — the COLUMN has no bound, so the 500-character cap is
     * enforced only by `error.slice(0, MAX_ERROR_LENGTH)` in the repository. A
     * mocked pool records the argument and proves nothing about what landed.
     */
    it(`truncates error to exactly ${MAX_ERROR_LENGTH} characters in the real column`, async () => {
      const claim = await claimOne();
      const long = 'E'.repeat(MAX_ERROR_LENGTH + 400);

      await repo.recordOutcome(claim.id, 'failed', long);

      const stored = (await rows())[0]!.error!;
      expect(stored).toHaveLength(MAX_ERROR_LENGTH);
      expect(stored).toBe(long.slice(0, MAX_ERROR_LENGTH));
    });

    it(`stores an error of exactly ${MAX_ERROR_LENGTH} characters unchanged`, async () => {
      const claim = await claimOne();
      const exact = 'E'.repeat(MAX_ERROR_LENGTH);
      await repo.recordOutcome(claim.id, 'failed', exact);
      expect((await rows())[0]!.error).toBe(exact);
    });

    it('writes NULL for an empty error string', async () => {
      const claim = await claimOne();
      await repo.recordOutcome(claim.id, 'failed', '');
      expect((await rows())[0]!.error).toBeNull();
    });

    it('is a no-op for a non-uuid id rather than a 22P02', async () => {
      await claimOne();
      await repo.recordOutcome('not-a-uuid', 'sent', null);
      expect((await rows())[0]!.status).toBe('pending');
    });
  });

  describe('recordOutcomeByKey', () => {
    const key = () => ({
      eventKey: 'campaign.completed',
      tenantId: tenant.id,
      dedupeKey: 'job:j1',
      recipients: ['a@example.com', 'b@example.com'],
    });

    beforeEach(async () => {
      await repo.claim({ ...key(), accountId: null });
    });

    it('closes every pending row addressed by the natural key', async () => {
      await repo.recordOutcomeByKey(key(), 'sent', null);

      const all = await rows();
      expect(all).toHaveLength(2);
      expect(all.every((r) => r.status === 'sent')).toBe(true);
      expect(all.every((r) => r.sent_at instanceof Date)).toBe(true);
    });

    /**
     * `AND status = 'pending'` is the whole safety property, and a string
     * assertion cannot tell a predicate that protects the row from one that
     * matches nothing. Recorded → a later call must NOT rewrite it.
     */
    it('does NOT overwrite a row already recorded as sent', async () => {
      await repo.recordOutcomeByKey(key(), 'sent', null);
      const sentAtBefore = (await rows())[0]!.sent_at;

      // A concurrent finalization path arriving late with a failure verdict.
      await repo.recordOutcomeByKey(key(), 'failed', 'transport timeout');

      const all = await rows();
      expect(all.every((r) => r.status === 'sent')).toBe(true);
      expect(all.every((r) => r.error === null)).toBe(true);
      expect(all[0]!.sent_at).toEqual(sentAtBefore);
    });

    it('does not reach rows under a different tenant', async () => {
      const other = await insertTenant();
      await repo.claim({ ...key(), tenantId: other.id, accountId: null });

      await repo.recordOutcomeByKey(key(), 'sent', null);

      const all = await rows();
      expect(all.filter((r) => r.tenant_id === tenant.id).every((r) => r.status === 'sent')).toBe(true);
      expect(all.filter((r) => r.tenant_id === other.id).every((r) => r.status === 'pending')).toBe(true);
    });

    it(`truncates the error to ${MAX_ERROR_LENGTH} characters`, async () => {
      await repo.recordOutcomeByKey(key(), 'failed', 'X'.repeat(MAX_ERROR_LENGTH + 100));
      expect((await rows())[0]!.error).toHaveLength(MAX_ERROR_LENGTH);
    });

    it('is a no-op for a non-uuid tenant id', async () => {
      await repo.recordOutcomeByKey({ ...key(), tenantId: 'nope' }, 'sent', null);
      expect((await rows()).every((r) => r.status === 'pending')).toBe(true);
    });
  });

  // ── release / releaseByKey ───────────────────────────────────────────────

  describe('release', () => {
    it('deletes pending rows so the dedupe key is not left burned', async () => {
      const claims = await repo.claim({
        eventKey: EVENT,
        tenantId: tenant.id,
        accountId: null,
        dedupeKey: DEDUPE,
        recipients: ['a@example.com', 'b@example.com'],
      });

      await repo.release(claims.map((c) => c.id));
      expect(await rows()).toEqual([]);

      // …and the key is genuinely reclaimable, which is the point: a staging
      // environment with no Mailjet must not consume the period's keys.
      const again = await repo.claim({
        eventKey: EVENT,
        tenantId: tenant.id,
        accountId: null,
        dedupeKey: DEDUPE,
        recipients: ['a@example.com', 'b@example.com'],
      });
      expect(again).toHaveLength(2);
    });

    /** A row already `sent` survives a release. Only a real DELETE can show it. */
    it('leaves a row that has already been recorded as sent', async () => {
      const claims = await repo.claim({
        eventKey: EVENT,
        tenantId: tenant.id,
        accountId: null,
        dedupeKey: DEDUPE,
        recipients: ['sent@example.com', 'pending@example.com'],
      });
      const sent = claims.find((c) => c.recipient === 'sent@example.com')!;
      await repo.recordOutcome(sent.id, 'sent', null);

      await repo.release(claims.map((c) => c.id));

      const all = await rows();
      expect(all).toHaveLength(1);
      expect(all[0]!.recipient).toBe('sent@example.com');
      expect(all[0]!.status).toBe('sent');
    });

    it('leaves a failed row too — a burned key is the deliberate trade', async () => {
      const [claim] = await repo.claim({
        eventKey: EVENT,
        tenantId: tenant.id,
        accountId: null,
        dedupeKey: DEDUPE,
        recipients: ['a@example.com'],
      });
      await repo.recordOutcome(claim!.id, 'failed', 'mailjet 500');

      await repo.release([claim!.id]);

      const all = await rows();
      expect(all).toHaveLength(1);
      expect(all[0]!.status).toBe('failed');
    });

    it('drops non-uuid ids rather than raising 22P02', async () => {
      const [claim] = await repo.claim({
        eventKey: EVENT,
        tenantId: tenant.id,
        accountId: null,
        dedupeKey: DEDUPE,
        recipients: ['a@example.com'],
      });
      await repo.release(['garbage', claim!.id]);
      expect(await rows()).toEqual([]);
    });

    it('is a no-op for an empty list', async () => {
      await repo.claim({
        eventKey: EVENT,
        tenantId: tenant.id,
        accountId: null,
        dedupeKey: DEDUPE,
        recipients: ['a@example.com'],
      });
      await repo.release([]);
      expect(await rows()).toHaveLength(1);
    });
  });

  describe('releaseByKey', () => {
    const key = () => ({
      eventKey: 'campaign.completed',
      tenantId: tenant.id,
      dedupeKey: 'job:j1',
      recipients: ['a@example.com', 'b@example.com'],
    });

    it('deletes the pending rows for that key', async () => {
      await repo.claim({ ...key(), accountId: null });
      await repo.releaseByKey(key());
      expect(await rows()).toEqual([]);
    });

    it('spares a row a concurrent finalization already recorded', async () => {
      await repo.claim({ ...key(), accountId: null });
      await repo.recordOutcomeByKey(
        { ...key(), recipients: ['a@example.com'] },
        'sent',
        null,
      );

      await repo.releaseByKey(key());

      const all = await rows();
      expect(all).toHaveLength(1);
      expect(all[0]!.recipient).toBe('a@example.com');
      expect(all[0]!.status).toBe('sent');
    });

    it('does not reach another tenant’s rows for the same key', async () => {
      const other = await insertTenant();
      await repo.claim({ ...key(), accountId: null });
      await repo.claim({ ...key(), tenantId: other.id, accountId: null });

      await repo.releaseByKey(key());

      const all = await rows();
      expect(all).toHaveLength(2);
      expect(all.every((r) => r.tenant_id === other.id)).toBe(true);
    });
  });

  // ── FK behaviour the model comment claims ────────────────────────────────

  describe('foreign keys', () => {
    it('SET NULLs account_id when the account is deleted — the record outlives it', async () => {
      await repo.claim({
        eventKey: EVENT,
        tenantId: tenant.id,
        accountId: account.id,
        dedupeKey: DEDUPE,
        recipients: ['a@example.com'],
      });

      await getTestPool().query(`DELETE FROM accounts WHERE id = $1`, [account.id]);

      const all = await rows();
      expect(all).toHaveLength(1);
      expect(all[0]!.account_id).toBeNull();
    });

    it('CASCADEs the whole row when the tenant is deleted', async () => {
      await repo.claim({
        eventKey: EVENT,
        tenantId: tenant.id,
        accountId: null,
        dedupeKey: DEDUPE,
        recipients: ['a@example.com'],
      });

      await getTestPool().query(`DELETE FROM tenants WHERE id = $1`, [tenant.id]);
      expect(await rows()).toEqual([]);
    });
  });
});

/**
 * Wait until some backend is blocked on a lock.
 *
 * The concurrency test needs B's INSERT to have REACHED the index and be waiting
 * before A commits; a bare `setTimeout` would make the assertion a race about
 * scheduling rather than about Postgres. Polling `pg_stat_activity` observes the
 * thing itself.
 */
async function waitForBlockedBackend(timeoutMs = 5_000): Promise<void> {
  const pool = getTestPool();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows: r } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'`,
    );
    if ((r[0]?.n ?? 0) > 0) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for a blocked backend');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

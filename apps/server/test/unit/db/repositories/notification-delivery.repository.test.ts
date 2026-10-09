import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `notification_deliveries` — the claim-before-send idempotency ledger.
 *
 * This repository is the ONLY thing between an at-least-once trigger and
 * duplicate mail (docs/reference/magick-master/CLAUDE.md, Notifications). Nothing upstream is exactly-once:
 * EventBridge is at-least-once by contract, the trigger Lambda retries any
 * non-2xx, an operator re-runs the internal route by hand, and a retry after a
 * timeout reaches a DIFFERENT master instance while the first is still working
 * — the case an in-process "already running" flag cannot see.
 *
 * The pool is mocked, so nothing here observes which ROWS a predicate selects.
 * What it can observe — and what every assertion below targets — is the SQL
 * tokens whose loss is silent: the `ON CONFLICT` target, the `::uuid` / `::text`
 * casts, `AND status = 'pending'`, the bind parameters, and the number of
 * statements issued. Row selection itself belongs to the real-Postgres suite;
 * each such case is flagged in a comment rather than faked here.
 */

const mocks = vi.hoisted(() => ({ pool: { query: vi.fn() } }));
vi.mock('@magick-agency/db', () => ({ getPool: () => mocks.pool }));

import { notificationDeliveryRepository } from '../../../../src/db/repositories/notification-delivery.repository.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = '33333333-3333-4333-8333-333333333333';
const ID = '99999999-9999-4999-8999-999999999999';

/** Whitespace in the source is formatting; the tokens are the contract. */
const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim();

function call(i = 0) {
  const [sql, params] = mocks.pool.query.mock.calls[i]! as [string, unknown[]];
  return { sql: norm(sql), raw: sql, params };
}

function claimInput(over: Partial<Parameters<typeof notificationDeliveryRepository.claim>[0]> = {}) {
  return {
    eventKey: 'usage.digest',
    tenantId: TENANT,
    accountId: null as string | null,
    dedupeKey: 'usage.digest:tenant:' + TENANT + ':2026-W07',
    recipients: ['ops@example.com'],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pool.query.mockResolvedValue({ rows: [] });
});

describe('notificationDeliveryRepository.claim', () => {
  it('claims every recipient in ONE statement, never a per-row loop', async () => {
    // Atomicity is the point: a crash between two independent claims would
    // leave some inboxes claimed-but-unsent forever, indistinguishable from
    // ones that genuinely failed. `unnest` is what keeps it one INSERT.
    const recipients = Array.from({ length: 40 }, (_, i) => `user${i}@example.com`);
    await notificationDeliveryRepository.claim(claimInput({ recipients }));

    expect(mocks.pool.query).toHaveBeenCalledTimes(1);
    const { sql, params } = call();
    expect(sql).toContain('INSERT INTO notification_deliveries');
    expect(sql).toContain('FROM unnest($5::text[]) AS r');
    expect(params[4]).toHaveLength(40);
  });

  it('has a conflict target of exactly (event_key, tenant_id, dedupe_key, recipient)', async () => {
    // THE assertion of this file. `uq_notification_deliveries_claim`
    // (migration 072) is on those four columns; ON CONFLICT infers the index
    // from the column SET, so any of them missing here silently picks a
    // different index — or no index, which is an error only at runtime.
    await notificationDeliveryRepository.claim(claimInput());

    const { sql } = call();
    const target = sql.match(/ON CONFLICT \(([^)]*)\)/)![1]!.split(',').map((c) => c.trim());
    expect([...target].sort()).toEqual(['dedupe_key', 'event_key', 'recipient', 'tenant_id']);
    expect(sql).toContain('DO NOTHING');
    expect(sql).toContain('RETURNING id, recipient');
  });

  it('keeps tenant_id IN the conflict target — a two-tenant admin gets BOTH digests', async () => {
    // The bug this pins was real, not hypothetical (docs/reference/magick-master/CLAUDE.md, migration 072).
    // Drop `tenant_id` from the key and a consultant who is account_admin in
    // tenants A and B receives A's digest; B's INSERT — same event_key, same
    // period, same inbox — hits the conflict, returns zero rows, and is skipped
    // as "already sent". Nothing errors, nothing is logged, and the second
    // workspace's digest is never delivered again.
    await notificationDeliveryRepository.claim(claimInput());
    expect(call().sql).toMatch(/ON CONFLICT \([^)]*\btenant_id\b[^)]*\)/);

    // And the tenant genuinely rides as a bind parameter, so two tenants
    // claiming the same inbox for the same period differ in the key's value —
    // which row each INSERT conflicts with is the integration suite's to prove.
    mocks.pool.query.mockClear();
    await notificationDeliveryRepository.claim(claimInput({ tenantId: OTHER_TENANT }));
    expect(call().params[2]).toBe(OTHER_TENANT);
  });

  it('binds the parameters in the order the statement reads them', async () => {
    await notificationDeliveryRepository.claim(claimInput({
      eventKey: 'campaign.completed',
      accountId: ACCOUNT,
      dedupeKey: 'job:abc',
      recipients: ['a@example.com', 'b@example.com'],
    }));

    const { sql, params } = call();
    expect(params).toEqual([
      'campaign.completed',
      'job:abc',
      TENANT,
      ACCOUNT,
      ['a@example.com', 'b@example.com'],
    ]);
    // $3/$4 are uuid columns, $5 is a text[] of addresses. A `::uuid[]` there
    // would 22P02 on the first email address.
    expect(sql).toContain('$3::uuid');
    expect(sql).toContain('unnest($5::text[])');
    expect(sql).not.toContain('unnest($5::uuid[])');

    // $4 is resolved through a LOOKUP, not bound straight into the column.
    // `isUuid` is a shape check, so a well-formed uuid for a deleted account
    // reached the FK to `accounts(id)` and raised 23503 — which, because the
    // whole multi-row INSERT is one statement, withheld the campaign notice
    // from EVERY recipient rather than merely losing the scoping. The subquery
    // yields NULL instead. Proven against a real Postgres in
    // `test/integration/repositories/notification-delivery.repository.test.ts`.
    expect(sql).toContain('SELECT a.id FROM accounts a');
    expect(sql).toContain('a.id = $4::uuid');

    // And the lookup is TENANT-SCOPED, not a bare existence test.
    // `bulk_dispatch_jobs.account_id` has no foreign key and no tenant check, so
    // a stale or hand-repaired job row can name an account belonging to another
    // tenant — and `WHERE a.id = $4` alone resolved it happily, writing tenant
    // A's delivery row with tenant B's `account_id`. With the predicate an
    // unresolvable-here id lands on the same NULL a deleted one gets.
    expect(sql).toContain('a.tenant_id = $3::uuid');
  });

  describe('accountId normalisation — isUuid(accountId) ? value : null', () => {
    // A QA mutation proved this untested: passing the raw value straight
    // through survived all 260 notification tests. It is the `'default'`
    // sentinel normalisation the campaign gate documents as load-bearing
    // (`bulk_dispatch_jobs.account_id` is VARCHAR(255) NOT NULL DEFAULT
    // 'default', migration 017; `notification_deliveries.account_id` is a real
    // UUID). Losing it raises 22P02 INSIDE claim(), and the claim fails CLOSED
    // — so every campaign notification stops, silently, with a logged error and
    // a green test suite.
    const cases: Array<[string, string | null | undefined, string | null]> = [
      ["the 'default' sentinel", 'default', null],
      ['a real account uuid', ACCOUNT, ACCOUNT],
      ['an uppercase uuid (the regex is case-insensitive)', ACCOUNT.toUpperCase(), ACCOUNT.toUpperCase()],
      ['null', null, null],
      ['undefined', undefined, null],
      ['the empty string', '', null],
      ['a malformed non-uuid string', 'acct_9f2b-not-a-uuid', null],
      ['a uuid with a trailing character', ACCOUNT + 'x', null],
      ['a uuid with surrounding whitespace', ` ${ACCOUNT} `, null],
    ];

    for (const [label, input, expected] of cases) {
      it(`normalises ${label}`, async () => {
        await notificationDeliveryRepository.claim(
          claimInput({ accountId: input as string | null }),
        );
        expect(call().params[3]).toBe(expected);
      });
    }

    it('normalises the account but never the tenant — a bad tenant is a no-op instead', async () => {
      // account_id is nullable ("this delivery was tenant-wide"); tenant_id is
      // NOT NULL and part of the claim key, so there is no safe substitute and
      // the method refuses to run at all.
      await notificationDeliveryRepository.claim(claimInput({ tenantId: 'default' }));
      expect(mocks.pool.query).not.toHaveBeenCalled();
    });
  });

  describe('recipient list handling', () => {
    it('de-duplicates repeated addresses so one statement cannot self-conflict', async () => {
      // Two identical rows inside one INSERT do not raise here (DO NOTHING, not
      // DO UPDATE — unlike upsertMany's 21000), but they would claim the same
      // inbox twice and return it twice, which the dispatcher reads as two
      // sends. Set semantics keep the returned list one-per-inbox.
      await notificationDeliveryRepository.claim(claimInput({
        recipients: ['a@example.com', 'a@example.com', 'b@example.com', 'a@example.com'],
      }));
      expect(call().params[4]).toEqual(['a@example.com', 'b@example.com']);
    });

    it('drops empty-string recipients', async () => {
      await notificationDeliveryRepository.claim(claimInput({
        recipients: ['', 'a@example.com', ''],
      }));
      expect(call().params[4]).toEqual(['a@example.com']);
    });

    it('does NOT lower-case or trim — that is the caller’s job, once', async () => {
      // Addresses are lower-cased exactly once, in `collapseByInbox`, which is
      // where they stop being a database value and become a dedupe key. If this
      // layer also normalised, two layers would own one rule and could disagree;
      // if it normalised DIFFERENTLY (trimming, say) a claimed recipient would
      // come back in a spelling the caller cannot match to its send list.
      await notificationDeliveryRepository.claim(claimInput({
        recipients: [' Ops@Example.COM '],
      }));
      expect(call().params[4]).toEqual([' Ops@Example.COM ']);
    });

    it('is a no-op for an empty recipient list', async () => {
      expect(await notificationDeliveryRepository.claim(claimInput({ recipients: [] }))).toEqual([]);
      expect(mocks.pool.query).not.toHaveBeenCalled();
    });

    it('is a no-op when every recipient is filtered away', async () => {
      expect(await notificationDeliveryRepository.claim(claimInput({ recipients: ['', ''] }))).toEqual([]);
      expect(mocks.pool.query).not.toHaveBeenCalled();
    });

    it('is a no-op for a non-uuid tenant, before the cast can 22P02', async () => {
      expect(await notificationDeliveryRepository.claim(claimInput({ tenantId: 'tenant-1' }))).toEqual([]);
      expect(mocks.pool.query).not.toHaveBeenCalled();
    });
  });

  describe('result mapping', () => {
    it('returns exactly the rows RETURNING gave back — the claimed subset', async () => {
      // The contract the dispatcher reads: present ⇒ claimed by THIS call, send
      // it; absent ⇒ already claimed elsewhere, skip it silently.
      mocks.pool.query.mockResolvedValue({
        rows: [{ id: ID, recipient: 'a@example.com' }],
      });
      const claims = await notificationDeliveryRepository.claim(claimInput({
        recipients: ['a@example.com', 'b@example.com'],
      }));
      expect(claims).toEqual([{ id: ID, recipient: 'a@example.com' }]);
    });

    it('returns an empty array when every recipient was already claimed', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [] });
      expect(await notificationDeliveryRepository.claim(claimInput())).toEqual([]);
    });
  });

  it('propagates a pool failure rather than swallowing it — the claim fails CLOSED', async () => {
    // Deliberate asymmetry with the preference lookup, which fails OPEN. Without
    // a claim there is no idempotency; a missed notification is recoverable from
    // the campaign page, a duplicate cannot be un-sent. The catch lives in the
    // callers (campaign-gate.ts, deliver.ts), which is where the metric and the
    // log line are.
    mocks.pool.query.mockRejectedValue(new Error('pool exhausted'));
    await expect(notificationDeliveryRepository.claim(claimInput())).rejects.toThrow('pool exhausted');
  });
});

describe('notificationDeliveryRepository.recordOutcome', () => {
  it('updates by primary key and stamps sent_at only for a sent row', async () => {
    await notificationDeliveryRepository.recordOutcome(ID, 'sent');

    const { sql, params } = call();
    expect(sql).toContain('UPDATE notification_deliveries');
    expect(sql).toContain("sent_at = CASE WHEN $2 = 'sent' THEN NOW() ELSE sent_at END");
    expect(sql).toContain('WHERE id = $1::uuid');
    expect(params).toEqual([ID, 'sent', null]);
  });

  it('leaves sent_at alone on a failed row (the CASE keeps the existing value)', async () => {
    // `ELSE sent_at`, not `ELSE NULL`: a row re-recorded as failed after a
    // successful send must not lose the timestamp support reads.
    await notificationDeliveryRepository.recordOutcome(ID, 'failed', 'SMTP 421');
    expect(call().sql).toContain('ELSE sent_at END');
    expect(call().params).toEqual([ID, 'failed', 'SMTP 421']);
  });

  it('truncates the transport error at exactly 500 characters', async () => {
    // `error` is free text from a transport; a provider that echoes the whole
    // payload back would otherwise write megabytes per failed row.
    await notificationDeliveryRepository.recordOutcome(ID, 'failed', 'x'.repeat(5000));
    expect(call().params[2]).toBe('x'.repeat(500));
  });

  it('leaves an error of exactly 500 characters intact', async () => {
    await notificationDeliveryRepository.recordOutcome(ID, 'failed', 'y'.repeat(500));
    expect(call().params[2]).toBe('y'.repeat(500));
  });

  it('writes NULL for an absent, null or empty error', async () => {
    for (const err of [undefined, null, '']) {
      mocks.pool.query.mockClear();
      await notificationDeliveryRepository.recordOutcome(ID, 'skipped', err);
      expect(call().params[2]).toBeNull();
    }
  });

  it('is a no-op for a non-uuid id rather than a 22P02', async () => {
    await notificationDeliveryRepository.recordOutcome('not-a-uuid', 'sent');
    expect(mocks.pool.query).not.toHaveBeenCalled();
  });

  // NOTE ON THE ASYMMETRY WITH recordOutcomeByKey: the id form carries no
  // `AND status = 'pending'`, deliberately — the id can only have come from
  // THIS run's own `claim()`, so there is no other writer to race with, and the
  // scoping the key form needs would here only make a legitimate re-record
  // (sent, then a late failure notice) silently do nothing. Stated rather than
  // asserted-absent, so that adding the predicate later is a decision and not a
  // test failure.
});

describe('notificationDeliveryRepository.recordOutcomeByKey', () => {
  const key = {
    eventKey: 'campaign.completed',
    tenantId: TENANT,
    dedupeKey: 'job:abc',
    recipients: ['a@example.com', 'b@example.com'],
  };

  it("scopes the UPDATE to status = 'pending'", async () => {
    // Without it, a late call can overwrite a row an earlier run already marked
    // `sent`, turning a successful delivery into a recorded failure — and the
    // campaign gate calls this on paths that CAN race a concurrent
    // finalization (the fenced dispatched transition, the reconcile sweeper, a
    // core webhook redelivery).
    await notificationDeliveryRepository.recordOutcomeByKey(key, 'sent');
    expect(call().sql).toContain("AND status = 'pending'");
  });

  it('addresses the rows by the claim key, with tenant_id cast to uuid', async () => {
    await notificationDeliveryRepository.recordOutcomeByKey(key, 'sent');

    const { sql } = call();
    expect(sql).toContain('WHERE event_key = $1');
    expect(sql).toContain('AND tenant_id = $2::uuid');
    expect(sql).toContain('AND dedupe_key = $3');
    // text[], matching `recipient TEXT NOT NULL`. `::uuid[]` here would 22P02
    // on the first address.
    expect(sql).toContain('AND recipient = ANY($6::text[])');
  });

  it('binds parameters in statement order', async () => {
    await notificationDeliveryRepository.recordOutcomeByKey(key, 'failed', 'timeout');
    expect(call().params).toEqual([
      'campaign.completed', TENANT, 'job:abc', 'failed', 'timeout',
      ['a@example.com', 'b@example.com'],
    ]);
  });

  it('stamps sent_at from $4 — the status parameter, not the id one', async () => {
    // The CASE references a different placeholder than in recordOutcome, so a
    // copy-paste of the id form's `$2` would compare the status against the
    // tenant id and never stamp anything.
    await notificationDeliveryRepository.recordOutcomeByKey(key, 'sent');
    expect(call().sql).toContain("sent_at = CASE WHEN $4 = 'sent' THEN NOW() ELSE sent_at END");
  });

  it('closes the whole recipient set in ONE statement', async () => {
    const recipients = Array.from({ length: 25 }, (_, i) => `u${i}@example.com`);
    await notificationDeliveryRepository.recordOutcomeByKey({ ...key, recipients }, 'sent');
    expect(mocks.pool.query).toHaveBeenCalledTimes(1);
    expect(call().params[5]).toHaveLength(25);
  });

  it('de-duplicates and drops falsy recipients', async () => {
    await notificationDeliveryRepository.recordOutcomeByKey(
      { ...key, recipients: ['a@example.com', '', 'a@example.com', 'b@example.com'] },
      'sent',
    );
    expect(call().params[5]).toEqual(['a@example.com', 'b@example.com']);
  });

  it('truncates the error at 500 characters and nulls an empty one', async () => {
    await notificationDeliveryRepository.recordOutcomeByKey(key, 'failed', 'e'.repeat(600));
    expect(call().params[4]).toBe('e'.repeat(500));

    mocks.pool.query.mockClear();
    await notificationDeliveryRepository.recordOutcomeByKey(key, 'failed', '');
    expect(call().params[4]).toBeNull();
  });

  it('is a no-op for a non-uuid tenant or an empty recipient set', async () => {
    await notificationDeliveryRepository.recordOutcomeByKey({ ...key, tenantId: 'default' }, 'sent');
    await notificationDeliveryRepository.recordOutcomeByKey({ ...key, recipients: [] }, 'sent');
    await notificationDeliveryRepository.recordOutcomeByKey({ ...key, recipients: ['', ''] }, 'sent');
    expect(mocks.pool.query).not.toHaveBeenCalled();
  });
});

describe('notificationDeliveryRepository.releaseByKey', () => {
  const key = {
    eventKey: 'campaign.dispatched',
    tenantId: TENANT,
    dedupeKey: 'job:abc',
    recipients: ['a@example.com'],
  };

  it("DELETEs only rows still pending", async () => {
    // What makes it safe to call after a concurrent finalization has recorded a
    // real outcome: that row is no longer pending, so this cannot delete the
    // record of a send that actually happened. Release is the narrow safety
    // valve for "provably delivered nothing" (no transport configured, a
    // renderer that threw, a provider that refused) — NOT a retry loop. A
    // timeout keeps its claim, because a timeout after Mailjet accepted the
    // message is indistinguishable from one before it.
    await notificationDeliveryRepository.releaseByKey(key);

    const { sql } = call();
    expect(sql).toContain('DELETE FROM notification_deliveries');
    expect(sql).toContain("AND status = 'pending'");
  });

  it('addresses rows by the same four-part claim key', async () => {
    await notificationDeliveryRepository.releaseByKey(key);
    const { sql, params } = call();
    expect(sql).toContain('WHERE event_key = $1');
    expect(sql).toContain('AND tenant_id = $2::uuid');
    expect(sql).toContain('AND dedupe_key = $3');
    expect(sql).toContain('AND recipient = ANY($4::text[])');
    expect(params).toEqual(['campaign.dispatched', TENANT, 'job:abc', ['a@example.com']]);
  });

  it('releases the whole set in one statement, de-duplicated', async () => {
    await notificationDeliveryRepository.releaseByKey({
      ...key,
      recipients: ['a@example.com', 'a@example.com', '', 'b@example.com'],
    });
    expect(mocks.pool.query).toHaveBeenCalledTimes(1);
    expect(call().params[3]).toEqual(['a@example.com', 'b@example.com']);
  });

  it('is a no-op for a non-uuid tenant or an empty recipient set', async () => {
    await notificationDeliveryRepository.releaseByKey({ ...key, tenantId: '' });
    await notificationDeliveryRepository.releaseByKey({ ...key, recipients: [] });
    expect(mocks.pool.query).not.toHaveBeenCalled();
  });
});

describe('notificationDeliveryRepository.release', () => {
  it("DELETEs by id array, still scoped to pending", async () => {
    await notificationDeliveryRepository.release([ID]);
    const { sql, params } = call();
    expect(sql).toContain('DELETE FROM notification_deliveries');
    expect(sql).toContain("WHERE id = ANY($1::uuid[]) AND status = 'pending'");
    expect(params).toEqual([[ID]]);
  });

  it('filters non-uuid ids out of the array instead of failing the whole release', async () => {
    // One bad id must not strand every other claim in this batch as
    // pending-forever: those rows would never be retried and never explained.
    await notificationDeliveryRepository.release([ID, 'nope', '', TENANT]);
    expect(call().params[0]).toEqual([ID, TENANT]);
  });

  it('releases any number of claims in one statement', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `999999${String(i).padStart(2, '0')}-9999-4999-8999-999999999999`);
    await notificationDeliveryRepository.release(ids);
    expect(mocks.pool.query).toHaveBeenCalledTimes(1);
    expect(call().params[0]).toHaveLength(30);
  });

  it('is a no-op for an empty list or a list with no valid uuid', async () => {
    await notificationDeliveryRepository.release([]);
    await notificationDeliveryRepository.release(['nope', 'default']);
    expect(mocks.pool.query).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn() }));

vi.mock('@magick-agency/db', () => ({
  getPool: () => ({
    query: mocks.query,
    // The write paths take a client so the version bump shares their
    // transaction; both surfaces record into one mock so call ORDER — which is
    // the property several of these tests are about — is observable.
    connect: async () => ({ query: mocks.query, release: mocks.release }),
  }),
}));

import { DncRepository, dncScopeLabel } from '../../../src/dnc/dnc.repository.js';

const repo = new DncRepository();
const TENANT = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const CAMPAIGN = '33333333-3333-4333-8333-333333333333';
const SENTINEL = '00000000-0000-0000-0000-000000000000';

/** Every SQL statement, normalised, including BEGIN/COMMIT/ROLLBACK. */
function allSql(): string[] {
  return mocks.query.mock.calls.map((c) => (c[0] as string).replace(/\s+/g, ' ').trim());
}
/** Statements that carry data — transaction control removed. */
function dataCalls(): Array<{ sql: string; params: unknown[] }> {
  return mocks.query.mock.calls
    .map((c) => ({ sql: (c[0] as string).replace(/\s+/g, ' ').trim(), params: c[1] as unknown[] }))
    .filter((c) => !/^(BEGIN|COMMIT|ROLLBACK)$/.test(c.sql));
}
function sqlOf(index = 0): string {
  return dataCalls()[index]!.sql;
}
function paramsOf(index = 0): unknown[] {
  return dataCalls()[index]!.params;
}

beforeEach(() => {
  vi.clearAllMocks();
});

/** One row inserted, one version returned — the ordinary tenant-wide add. */
function mockInsertThenBump(phone = '+15551230001', version = '7'): void {
  mocks.query.mockImplementation((sql: string) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return Promise.resolve({ rows: [], rowCount: 0 });
    if (sql.includes('INSERT INTO dnc_sync_state')) {
      return Promise.resolve({ rows: [{ version }], rowCount: 1 });
    }
    if (sql.includes('INSERT INTO dnc_entries')) {
      return Promise.resolve({ rows: [{ id: 'e1', phone_e164: phone }], rowCount: 1 });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}

/**
 * A delete that removes `entry`, with `survivorExists` deciding whether a
 * tenant-wide row for the same number is still there afterwards.
 */
function mockDelete(
  entry: Record<string, unknown>,
  opts: { survivorExists?: boolean; version?: string } = {},
): void {
  mocks.query.mockImplementation((sql: string) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return Promise.resolve({ rows: [], rowCount: 0 });
    if (sql.includes('DELETE FROM dnc_entries')) {
      return Promise.resolve({ rows: [entry], rowCount: 1 });
    }
    if (sql.includes('SELECT EXISTS')) {
      return Promise.resolve({ rows: [{ exists: opts.survivorExists ?? false }], rowCount: 1 });
    }
    if (sql.includes('INSERT INTO dnc_sync_state')) {
      return Promise.resolve({ rows: [{ version: opts.version ?? '9' }], rowCount: 1 });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}

describe('insertMany — idempotency without losing the audit trail', () => {
  it('names the COALESCE expression in ON CONFLICT, not a bare column list', async () => {
    // `uq_dnc_scope` is an EXPRESSION index. Postgres matches an ON CONFLICT
    // target to it only if the expression is spelled out identically; a bare
    // `(tenant_id, account_id, campaign_id, phone_e164)` raises "there is no
    // unique or exclusion constraint matching the ON CONFLICT specification" at
    // runtime — which a mocked pool cannot reproduce, so the SQL text is what
    // there is to assert.
    mockInsertThenBump();

    await repo.insertMany({ tenant_id: TENANT, phones: ['+15551230001'], source: 'regulator' });

    const sql = sqlOf();
    expect(sql).toContain(`ON CONFLICT ( tenant_id, COALESCE(account_id, '${SENTINEL}'::uuid), COALESCE(campaign_id, '${SENTINEL}'::uuid), phone_e164 ) DO NOTHING`);
  });

  it('uses DO NOTHING, never DO UPDATE — an existing source/reason is the audit trail', async () => {
    mockInsertThenBump();

    await repo.insertMany({ tenant_id: TENANT, phones: ['+15551230001'], source: 'agent' });

    // An upsert would relabel a `regulator` row as `agent` because an agent later
    // marked the same number, silently rewriting who suppressed it and why.
    expect(sqlOf()).not.toContain('DO UPDATE');
  });

  it('reports created:true on a real insert', async () => {
    mockInsertThenBump();

    const result = await repo.insertMany({ tenant_id: TENANT, phones: ['+15551230001'], source: 'api' });

    expect(result.results[0]!.created).toBe(true);
    // Decision B8: one data statement — the insert, with no version bump and no
    // fallback SELECT on the happy path.
    expect(dataCalls()).toHaveLength(1);
  });

  it('reports created:false and returns the EXISTING row on a conflict', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // DO NOTHING swallowed it
      .mockResolvedValueOnce({
        rows: [{ id: 'existing-1', phone_e164: '+15551230001', source: 'regulator' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // COMMIT

    const result = await repo.insertMany({ tenant_id: TENANT, phones: ['+15551230001'], source: 'agent' });

    expect(result.results[0]!.created).toBe(false);
    expect(result.results[0]!.entry.id).toBe('existing-1');
    // The returned row is the one already on the list, so the caller reports the
    // original suppression rather than the one it just tried to make.
    expect(result.results[0]!.entry.source).toBe('regulator');
  });

  it('matches the existing row on the SAME COALESCE scope the index uses', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 'existing-1' }], rowCount: 1 });

    await repo.insertMany({ tenant_id: TENANT, phones: ['+15551230001'], source: 'agent' });

    // `account_id = NULL` is never true in SQL, so a naive fallback SELECT finds
    // nothing for exactly the tenant-wide rows that conflict most often — and the
    // method would then throw on every legitimate duplicate.
    const sql = sqlOf(1);
    expect(sql).toContain(`COALESCE(account_id, '${SENTINEL}'::uuid) = COALESCE($2::uuid, '${SENTINEL}'::uuid)`);
    expect(sql).toContain(`COALESCE(campaign_id, '${SENTINEL}'::uuid) = COALESCE($3::uuid, '${SENTINEL}'::uuid)`);
  });

  it('THROWS when a conflict is followed by no matching row — never reports success', async () => {
    // This is the shape of "the ON CONFLICT target is not the index we think it
    // is". Returning a fabricated entry, or created:false with no row, would tell
    // the caller a number was suppressed when nothing was written.
    mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });

    await expect(
      repo.insertMany({ tenant_id: TENANT, phones: ['+15551230001'], source: 'api' }),
    ).rejects.toThrow(/uq_dnc_scope/);

    // And it rolls back rather than committing a transaction it does not
    // understand the state of.
    expect(allSql()).toContain('ROLLBACK');
  });
});


// Decision B8: the `opts.client` path. The agent's mark joins
// the CALLER's transaction, so this method must issue no transaction control and
// never release a client it does not own; a failure must propagate.
describe('insertMany — with a caller-supplied client (B8 "same transaction")', () => {
  function callerClient() {
    const query = vi.fn((sql: string) =>
      Promise.resolve(sql.includes('INSERT INTO dnc_entries')
        ? { rows: [{ id: 'e1', campaign_id: null, phone_e164: '+15551230001' }], rowCount: 1 }
        : { rows: [], rowCount: 0 }));
    return { query, release: vi.fn() };
  }

  it('issues only the data statements on the supplied client: no BEGIN/COMMIT/ROLLBACK, no release, no pool checkout', async () => {
    const client = callerClient();
    const { results } = await repo.insertMany(
      { tenant_id: TENANT, phones: ['+15551230001'], source: 'agent' },
      { client: client as never },
    );
    expect(results[0]).toMatchObject({ created: true });
    const sql = client.query.mock.calls.map((c) => (c[0] as string).trim());
    expect(sql).toHaveLength(1);
    expect(sql[0]).toMatch(/^INSERT INTO dnc_entries/);
    expect(sql.some((q) => /^(BEGIN|COMMIT|ROLLBACK)$/.test(q))).toBe(false);
    expect(client.release).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('propagates a failure without ROLLBACK or release — the caller owns the transaction', async () => {
    const client = callerClient();
    client.query.mockRejectedValueOnce(new Error('boom'));
    await expect(repo.insertMany(
      { tenant_id: TENANT, phones: ['+15551230001'], source: 'agent' },
      { client: client as never },
    )).rejects.toThrow('boom');
    expect(client.query.mock.calls.map((c) => (c[0] as string).trim())).not.toContain('ROLLBACK');
    expect(client.release).not.toHaveBeenCalled();
  });
});

describe('deleteById — the removal side of the delta', () => {
  // Decision B8: there is no sync version and no flat set to remove a number from,
  // so a removal is a single statement; this case pins what is left.
  it('is ONE delete statement: no transaction, no survivor query, no version', async () => {
    mockDelete({ id: 'e1', phone_e164: '+15551230001', account_id: null, campaign_id: null });

    const result = await repo.deleteById('e1', TENANT);

    expect(result?.entry.id).toBe('e1');
    expect(result).not.toHaveProperty('syncVersion');
    expect(allSql()).toHaveLength(1);
    expect(allSql()[0]).toContain('DELETE FROM dnc_entries');
  });

  describe('deleteById — accountScope (account-scoped caller IDOR guard)', () => {
    it('adds an account_id equality predicate when accountScope is passed', async () => {
      mockDelete({ id: 'e1', phone_e164: '+15551230001', account_id: ACCOUNT, campaign_id: null });

      await repo.deleteById('e1', TENANT, ACCOUNT);

      expect(sqlOf()).toBe(
        'DELETE FROM dnc_entries WHERE id = $1 AND tenant_id = $2 AND account_id = $3 RETURNING *',
      );
      expect(paramsOf()).toEqual(['e1', TENANT, ACCOUNT]);
    });

    it('returns null (not the row) when the entry belongs to a different account', async () => {
      // Simulates the SQL genuinely not matching — the mock here stands in for
      // Postgres refusing the row because account_id disagrees.
      mocks.query.mockImplementation((sql: string) => {
        if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return Promise.resolve({ rows: [], rowCount: 0 });
        if (sql.includes('DELETE FROM dnc_entries')) return Promise.resolve({ rows: [], rowCount: 0 });
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      const result = await repo.deleteById('e1', TENANT, ACCOUNT);

      expect(result).toBeNull();
      // There is no transaction, so there is nothing to roll back.
      expect(allSql()).not.toContain('COMMIT');
    });

    it('the UNSCOPED call keeps its exact original SQL and argument count', async () => {
      // The pre-existing tenant-wide-caller path must be byte-identical to
      // before this guard existed — a stray extra `undefined` argument or an
      // always-present `AND account_id = $3` predicate would both be
      // regressions this test would not otherwise catch.
      mockDelete({ id: 'e1', phone_e164: '+15551230001', account_id: null, campaign_id: null });

      await repo.deleteById('e1', TENANT);

      expect(sqlOf()).toBe('DELETE FROM dnc_entries WHERE id = $1 AND tenant_id = $2 RETURNING *');
      expect(paramsOf()).toEqual(['e1', TENANT]);
    });
  });
});



describe('dncScopeLabel — the audit label, against the SQL that decides the match', () => {
  it('names BOTH columns, because the match predicate ANDs them', async () => {
    // Kept in this file, next to the `findSuppressed` SQL assertions below, on
    // purpose: the label is only correct relative to that predicate. If the SQL
    // ever ORs the two columns, account+campaign becomes the WIDER scope and this
    // helper is wrong in the other direction — and a reader editing one has the
    // other on screen.
    expect(dncScopeLabel({ account_id: ACCOUNT, campaign_id: CAMPAIGN })).toBe('account_campaign');
    expect(dncScopeLabel({ account_id: ACCOUNT, campaign_id: null })).toBe('account');
    expect(dncScopeLabel({ account_id: null, campaign_id: CAMPAIGN })).toBe('campaign');
    expect(dncScopeLabel({ account_id: null, campaign_id: null })).toBe('tenant');
    // An absent key is a tenant-wide entry, same as an explicit null — the add
    // route passes the request body, where the fields are optional.
    expect(dncScopeLabel({})).toBe('tenant');

    mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
    await repo.findSuppressed({ tenantId: TENANT, accountId: ACCOUNT, campaignId: CAMPAIGN }, ['+15551230001']);
    const sql = sqlOf();
    expect(sql).toContain('AND (account_id IS NULL OR account_id = $3::uuid)');
    expect(sql).toContain('AND (campaign_id IS NULL OR campaign_id = $4::uuid)');
  });
});

describe('findSuppressed — the batch lookup the plain index exists for', () => {
  it('is ONE query for a whole batch, keyed on = ANY(...)', async () => {
    mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });

    await repo.findSuppressed({ tenantId: TENANT }, ['+15551230001', '+15551230002', '+15551230003']);

    expect(mocks.query).toHaveBeenCalledTimes(1);
    const sql = sqlOf();
    expect(sql).toContain('phone_e164 = ANY($2::varchar[])');
    // Per-number probes would be 1M queries on a 1M-row roster, and would not use
    // `idx_dnc_entries_tenant_phone` any better.
    expect(sql).toContain('tenant_id = $1');
  });

  it('WIDENS on scope — a tenant-wide row suppresses a campaign-scoped dial', async () => {
    mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });

    await repo.findSuppressed({ tenantId: TENANT, accountId: ACCOUNT, campaignId: CAMPAIGN }, ['+15551230001']);

    const sql = sqlOf();
    // `IS NULL OR = $n`, never `= $n` alone: the narrow form would miss every
    // tenant-wide row, which is the majority of the list and the only kind an
    // agent's mark-DNC writes.
    expect(sql).toContain('(account_id IS NULL OR account_id = $3::uuid)');
    expect(sql).toContain('(campaign_id IS NULL OR campaign_id = $4::uuid)');
  });

  it('returns a Set of matches, not a per-number map', async () => {
    mocks.query.mockResolvedValue({ rows: [{ phone_e164: '+15551230002' }], rowCount: 1 });

    const suppressed = await repo.findSuppressed({ tenantId: TENANT }, ['+15551230001', '+15551230002']);

    // A map invites `map[phone]` on an unqueried number: `undefined`, therefore
    // falsy, therefore a fail-open read of a fail-closed answer.
    expect(suppressed).toBeInstanceOf(Set);
    expect(suppressed.has('+15551230002')).toBe(true);
    expect(suppressed.has('+15551230001')).toBe(false);
  });

  it('short-circuits an empty batch without touching the database', async () => {
    const suppressed = await repo.findSuppressed({ tenantId: TENANT }, []);

    expect(suppressed.size).toBe(0);
    // `= ANY('{}')` is valid but pointless; the final empty terminator chunk of
    // every ingest would otherwise cost a round trip.
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('propagates a database failure instead of returning an empty Set', async () => {
    mocks.query.mockRejectedValue(new Error('connection terminated'));

    // An empty Set means "nothing is suppressed", which is the exact violation
    // the feature exists to prevent. The only safe answer is no answer.
    await expect(repo.findSuppressed({ tenantId: TENANT }, ['+15551230001'])).rejects.toThrow(
      'connection terminated',
    );
  });
});



describe('list — scope filters, and the null-vs-absent distinction', () => {
  beforeEach(() => {
    mocks.query.mockResolvedValue({ rows: [{ count: '0' }], rowCount: 1 });
  });

  it('accountId: null filters to IS NULL; absent adds no predicate at all', async () => {
    await repo.list({ tenantId: TENANT, accountId: null, limit: 10, offset: 0 });
    expect(sqlOf()).toContain('account_id IS NULL');

    vi.clearAllMocks();
    mocks.query.mockResolvedValue({ rows: [{ count: '0' }], rowCount: 1 });

    await repo.list({ tenantId: TENANT, limit: 10, offset: 0 });
    // "any scope" and "tenant-wide only" are different questions; collapsing them
    // would silently hide every account-scoped row from an unfiltered list.
    expect(sqlOf()).not.toContain('account_id');
  });

  it('always scopes to the tenant, even with no filters', async () => {
    await repo.list({ tenantId: TENANT, limit: 10, offset: 0 });

    expect(sqlOf()).toContain('WHERE tenant_id = $1');
    expect(paramsOf()[0]).toBe(TENANT);
  });

  it('counts against the SAME predicate it pages, so total matches the filter', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ count: '7' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await repo.list({
      tenantId: TENANT,
      source: 'regulator',
      limit: 10,
      offset: 0,
    });

    // A count over an unfiltered table with a filtered page is the classic
    // pagination lie: "7 of 4000" with four rows on screen.
    expect(sqlOf(0)).toContain('source = $2');
    expect(sqlOf(1)).toContain('source = $2');
    expect(result.total).toBe(7);
  });

  it('places LIMIT/OFFSET after the filter params, not on top of them', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await repo.list({ tenantId: TENANT, phone: '+15551230001', source: 'api', limit: 25, offset: 50 });

    // Hand-numbered placeholders: an off-by-one here silently filters on the
    // limit and pages by the phone number.
    const params = paramsOf(1);
    expect(params).toEqual([TENANT, '+15551230001', 'api', 25, 50]);
    expect(sqlOf(1)).toContain('LIMIT $4 OFFSET $5');
  });
});

describe('deleteById / findById — tenant scoping', () => {
  it('delete is tenant-scoped and returns the removed row', async () => {
    mockDelete({ id: 'e1', phone_e164: '+15551230001', account_id: null, campaign_id: null });

    const removed = await repo.deleteById('e1', TENANT);

    expect(sqlOf()).toContain('DELETE FROM dnc_entries WHERE id = $1 AND tenant_id = $2 RETURNING *');
    expect(removed?.entry.phone_e164).toBe('+15551230001');
  });

  it('returns null rather than throwing when the id belongs to nobody here', async () => {
    mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });

    expect(await repo.deleteById('e1', TENANT)).toBeNull();
    expect(await repo.findById('e1', TENANT)).toBeNull();
  });

  it('writes nothing and commits nothing when there was nothing to delete', async () => {
    mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });

    await repo.deleteById('e1', TENANT);

    // The single DELETE has no transaction to roll back; what matters is that
    // nothing is reported removed.
    expect(allSql()).not.toContain('COMMIT');
  });
});

// ---------------------------------------------------------------------------
// The publish-lag aggregate.
//
// NOTE ON COVERAGE: these tests pin the SQL's SHAPE and the JS-side coercion.
// They do NOT execute the statement — that needs the integration stack. The
// column choices below are the load-bearing part and are asserted textually
// because getting them wrong is silent: the query still runs and still returns
// a number, just a number that can never trip the alert.
// ---------------------------------------------------------------------------

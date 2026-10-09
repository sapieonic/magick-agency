import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// The repository's own branching — the parts that are logic rather than SQL.
//
// The SQL itself (partial unique indexes, SKIP LOCKED under real contention) is
// proven against real Postgres in the integration tier; these pin the decisions
// made around it, especially the ones whose failure mode is silent.
// ---------------------------------------------------------------------------

// A STABLE logger double, not a fresh object per call: the two 23505 constraints
// must produce distinguishable log lines, and that is only assertable if the spy
// survives between calls.
const { logSpy } = vi.hoisted(() => ({
  logSpy: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@magick-agency/observability', () => ({
  logger: logSpy,
  createChildLogger: () => logSpy,
}));

const { pool, client } = vi.hoisted(() => ({
  pool: { query: vi.fn(), connect: vi.fn() },
  client: { query: vi.fn(), release: vi.fn() },
}));
vi.mock('@magick-agency/db', () => ({ getPool: () => pool }));

import {
  AgencyAttemptRepository,
  AgencyCampaignRepository,
  AgencyContactRepository,
} from '../../../src/db/repositories/agency.repository.js';

beforeEach(() => {
  vi.clearAllMocks();
  pool.connect.mockResolvedValue(client);
  pool.query.mockResolvedValue({ rows: [{ n: '0' }], rowCount: 0 });
  client.query.mockResolvedValue({ rows: [], rowCount: 1 });
});

describe('AgencyAttemptRepository.create — the duplicate-dial backstop', () => {
  it('returns null (not a throw) when the live-attempt index refuses the insert', async () => {
    const err = Object.assign(new Error('duplicate key'), { code: '23505' });
    pool.query.mockRejectedValueOnce(err);

    const result = await new AgencyAttemptRepository().create({
      campaignId: 'camp-1', contactId: 'c1', tenantId: 't1', accountId: 'a1',
      callerId: '+1', reservedAgentId: 's1',
    });

    // The caller must treat this as "someone else has this contact" and move on.
    // Surfacing it as an error would make the tick retry a contact the database
    // has correctly told us is already being dialed.
    expect(result).toBeNull();
  });

  it('DERIVES attempt_number in SQL and accepts none from the caller (AD-P2-C-12)', async () => {
    // The bug was in the DERIVATION: `contact.attempt_count + 1` collided with the
    // number an orphaned row already held, and `uq_agency_attempt_number` is total
    // rather than partial, so a reaper-recovered contact was refused on every tick
    // forever — while looking healthy, because the only signal was a log line that
    // reads exactly like a correctness backstop working.
    //
    // A test that hands `create` the number cannot catch that, which is why the
    // parameter is GONE rather than merely unused: there is no longer a way for a
    // caller — or a test — to supply the answer.
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'att-1', attempt_number: 4 }] });

    await new AgencyAttemptRepository().create({
      campaignId: 'camp-1', contactId: 'c1', tenantId: 't1', accountId: 'a1',
      callerId: '+1', reservedAgentId: 's1',
    });

    const [sql, params] = pool.query.mock.calls[0]!;
    // Derived from this contact's OWN attempt rows, inside the insert.
    expect(String(sql)).toContain('COALESCE(MAX(attempt_number), 0) + 1');
    expect(String(sql)).toContain('FROM agency_call_attempts');
    expect(String(sql)).toContain('WHERE contact_id = $2');
    // And critically: nothing derived from `agency_contacts.attempt_count`, which
    // is the retry budget and must never double as a number generator again.
    expect(String(sql)).not.toContain('attempt_count');
    expect(params).toEqual(['camp-1', 'c1', 't1', 'a1', '+1', 's1']);
  });

  it('distinguishes an attempt-number collision from the live-attempt backstop', async () => {
    // Conflating these in one log line is what hid AD-P2-C-12 for a phase: a
    // permanent wedge and a healthy backstop produced byte-identical output. One is
    // expected under contention; the other should be vanishingly rare, and a steady
    // stream of it means numbers are colliding systematically.
    const numberClash = Object.assign(new Error('dup'), {
      code: '23505', constraint: 'uq_agency_attempt_number',
    });
    pool.query.mockRejectedValueOnce(numberClash);
    expect(await new AgencyAttemptRepository().create({
      campaignId: 'camp-1', contactId: 'c1', tenantId: 't1', accountId: 'a1',
      callerId: '+1', reservedAgentId: 's1',
    })).toBeNull();

    const liveClash = Object.assign(new Error('dup'), {
      code: '23505', constraint: 'uq_agency_attempt_live',
    });
    pool.query.mockRejectedValueOnce(liveClash);
    expect(await new AgencyAttemptRepository().create({
      campaignId: 'camp-1', contactId: 'c1', tenantId: 't1', accountId: 'a1',
      callerId: '+1', reservedAgentId: 's1',
    })).toBeNull();

    const messages = logSpy.warn.mock.calls.map((c: any[]) => String(c[1]));
    expect(new Set(messages).size).toBe(2);
    expect(messages.some((m: string) => m.includes('Attempt-number collision'))).toBe(true);
    expect(messages.some((m: string) => m.includes('Duplicate-dial backstop'))).toBe(true);
  });

  it('rethrows anything that is NOT a uniqueness violation', async () => {
    pool.query.mockRejectedValueOnce(Object.assign(new Error('connection lost'), { code: '08006' }));

    // Swallowing a connection fault as "already dialed" would silently drop
    // contacts and look identical to the backstop working.
    await expect(new AgencyAttemptRepository().create({
      campaignId: 'camp-1', contactId: 'c1', tenantId: 't1', accountId: 'a1',
      callerId: '+1', reservedAgentId: 's1',
    })).rejects.toThrow('connection lost');
  });
});

describe('AgencyContactRepository.claimDialable', () => {
  it('does not touch the database for a non-positive limit', async () => {
    const repo = new AgencyContactRepository();
    expect(await repo.claimDialable('camp-1', 0)).toEqual([]);
    expect(await repo.claimDialable('camp-1', -3)).toEqual([]);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('claims with SKIP LOCKED — the correctness mechanism, not the lease', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'c1' }], rowCount: 1 });
    await new AgencyContactRepository().claimDialable('camp-1', 2);

    const sql = pool.query.mock.calls[0]![0] as string;
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    // The predicate must match idx_agency_contacts_dialable exactly, or the hot
    // query stops being O(log n) as completed rows reach the millions.
    expect(sql).toContain("state = 'pending'");
    expect(sql).toContain('next_attempt_at <= now()');
    expect(sql).toContain('ORDER BY next_attempt_at');
  });
});

describe('AgencyContactRepository.applyIngestChunk', () => {
  function chunk(contacts: any[]) {
    return {
      campaignId: 'camp-1', tenantId: 't1', accountId: 'a1',
      ingestJobId: 'job-1', chunkIndex: 0, chunkCount: 2,
      idempotencyKey: 'job-1-0', contacts,
    };
  }

  it('commits the chunk marker and its rows in ONE transaction', async () => {
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO agency_ingest_chunks')) return { rows: [{ id: 'm1' }], rowCount: 1 };
      // `countForCampaign` now runs on the held client rather than checking out a
      // SECOND pool connection — N concurrent chunks each holding one and asking
      // for another is a pool deadlock.
      if (sql.includes('COUNT(*)')) return { rows: [{ n: '2' }] };
      return { rows: [], rowCount: 1 };
    });

    const res = await new AgencyContactRepository().applyIngestChunk(
      chunk([{ phone_e164: '+911' }, { phone_e164: '+912' }]),
    );

    const statements = client.query.mock.calls.map((c: any) => String(c[0]).trim().split(/\s/)[0]);
    expect(statements[0]).toBe('BEGIN');
    expect(statements).toContain('COMMIT');
    // All-or-nothing is what makes partial application impossible rather than
    // merely detectable — and is why a replay can be one cheap conflict.
    expect(res).toMatchObject({ accepted: 2, duplicate_chunk: false, total_contacts: 2 });
  });

  /**
   * Drive the replay path (the marker insert conflicts), with control over what
   * migration 084's columns hold on the already-applied marker row.
   *
   * `recorded: null` models a chunk applied BEFORE 084 — the columns are NULL.
   */
  function replayWith(recorded: { rejected: number; sourceRows: number[] } | null) {
    // Every query on this path runs on the ONE held client: the marker insert that
    // conflicts, then (after ROLLBACK) the recorded-rejection lookup and
    // `countForCampaign`. Deliberately not the pool — a second checkout while
    // holding a client deadlocks at DB_POOL_MAX concurrent chunks.
    client.query.mockImplementation(async (sql: string) => {
      if (String(sql).includes('INSERT INTO agency_ingest_chunks')) return { rows: [], rowCount: 0 };
      if (String(sql).includes('rejected_duplicate_rows')) {
        return {
          rows: [{
            rejected_duplicate_rows: recorded ? recorded.rejected : null,
            duplicate_source_rows: recorded ? recorded.sourceRows : null,
          }],
        };
      }
      if (String(sql).includes('COUNT(*)')) return { rows: [{ n: '500' }] };
      return { rows: [], rowCount: 1 };
    });
  }

  it('never checks out a second connection while holding one', async () => {
    // The deadlock guard: with `DB_POOL_MAX` at N, N concurrent chunks each holding
    // a client and requesting another wait on each other forever. `pool.connect` is
    // the only checkout this method may make.
    replayWith({ rejected: 1, sourceRows: [2] });

    await new AgencyContactRepository().applyIngestChunk(chunk([{ phone_e164: '+911' }]));

    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('rolls back and reports a replay explicitly rather than silently no-opping', async () => {
    replayWith({ rejected: 0, sourceRows: [] });

    const res = await new AgencyContactRepository().applyIngestChunk(chunk([{ phone_e164: '+911' }]));

    // master needs the signal so its job counters don't double-count; a silent
    // success is indistinguishable from having applied the rows twice.
    expect(res).toEqual({
      accepted: 0, duplicate_chunk: true, total_contacts: 500,
      // A replayed CHUNK is a retry and a success — deliberately NOT reported as a
      // row conflict, which is the operator-facing "your re-upload was refused"
      // signal. Conflating them would fire that error on every ordinary retry.
      rejected_duplicate_rows: 0, duplicate_source_rows: [],
    });
    // A RECORDED zero is exact, so no "unknown" flag rides along with it.
    expect(res.rejection_counts_unavailable).toBeUndefined();
    expect(client.query.mock.calls.map((c: any) => c[0])).toContain('ROLLBACK');
    expect(client.query.mock.calls.map((c: any) => c[0])).not.toContain('COMMIT');
  });

  it('a REPLAY reports the counts the original application recorded', async () => {
    // ── The defect this closes ────────────────────────────────────────────────
    // The replay path rolls back before the per-row loop, so it has no counts of
    // its own and used to return a confident `0`. master's roster client retries
    // on 5xx and on timeout, so a chunk core COMMITTED whose response was lost in
    // transit comes back here — and the operator's ingest summary then undercounts
    // every row core refused. It can never overcount, which is exactly what makes
    // it invisible: the import reads clean.
    //
    // A redelivery must be indistinguishable from the response master lost.
    replayWith({ rejected: 7, sourceRows: [3, 4, 9] });

    const res = await new AgencyContactRepository().applyIngestChunk(chunk([{ phone_e164: '+911' }]));

    expect(res.duplicate_chunk).toBe(true);
    expect(res.rejected_duplicate_rows).toBe(7);
    expect(res.duplicate_source_rows).toEqual([3, 4, 9]);
    expect(res.rejection_counts_unavailable).toBeUndefined();
    // Still a rollback. Reporting truthfully must not re-apply anything — the
    // transactional idempotency is the load-bearing part and is untouched.
    expect(client.query.mock.calls.map((c: any) => c[0])).toContain('ROLLBACK');
    expect(client.query.mock.calls.map((c: any) => c[0])).not.toContain('COMMIT');
  });

  it('says UNKNOWN, not zero, for a chunk applied before migration 084', async () => {
    // The one case where the number genuinely cannot be produced: the chunk landed
    // before 084 existed, so nothing recorded what it refused — and it cannot be
    // recomputed, because a row rejected by the fingerprint index leaves no residue
    // (the surviving contact is byte-identical to the one that was dropped).
    //
    // Reporting `0` here would reproduce the exact bug: a zero indistinguishable
    // from a genuine zero. So the response says it does not know.
    replayWith(null);

    const res = await new AgencyContactRepository().applyIngestChunk(chunk([{ phone_e164: '+911' }]));

    expect(res.rejection_counts_unavailable).toBe(true);
    // The wire types are unchanged — master parses these as a number and an array,
    // and cusui is about to render them — so they stay 0/[] and the FLAG is what
    // says not to trust them.
    expect(res.rejected_duplicate_rows).toBe(0);
    expect(res.duplicate_source_rows).toEqual([]);
  });

  it('records what it refused, in the same transaction, capped at the sample size', async () => {
    // Written at apply time or not at all: there is no residue to recompute from
    // later. Capped because this lands on a table holding one row per 500-row chunk
    // of every roster ever uploaded.
    const contacts = Array.from({ length: 30 }, (_, i) => ({ phone_e164: '+91', source_row_number: i + 1 }));
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO agency_ingest_chunks')) return { rows: [{ id: 'm1' }], rowCount: 1 };
      if (sql.includes('INSERT INTO agency_contacts')) return { rows: [], rowCount: 0 }; // every row a duplicate
      if (sql.includes('COUNT(*)')) return { rows: [{ n: '0' }] };
      return { rows: [], rowCount: 1 };
    });

    const res = await new AgencyContactRepository().applyIngestChunk(chunk(contacts));

    const update = client.query.mock.calls
      .find((c: any) => String(c[0]).includes('UPDATE agency_ingest_chunks'));
    expect(update, 'the counts must be persisted on the marker').toBeTruthy();
    const [, params] = update!;
    expect(params[1]).toBe(30);            // the true count, uncapped
    expect(params[2]).toHaveLength(20);    // MAX_REPORTED_DUPLICATE_ROWS
    // Inside the transaction, so the marker and its counts are all-or-nothing.
    const statements = client.query.mock.calls.map((c: any) => String(c[0]).trim().split(/\s/)[0]);
    expect(statements).toContain('COMMIT');
    const updateAt = client.query.mock.calls.findIndex((c: any) => String(c[0]).includes('UPDATE agency_ingest_chunks'));
    expect(updateAt).toBeLessThan(statements.lastIndexOf('COMMIT'));
    // And what it stored is what it returned.
    expect(res.rejected_duplicate_rows).toBe(30);
    expect(res.duplicate_source_rows).toHaveLength(20);
  });

  it('reports rows the roster already held instead of hiding them in `accepted: 0`', async () => {
    // Rows the roster already holds verbatim are refused, and master has to be
    // able to say so — before this, a bare `ON CONFLICT DO NOTHING` made "every
    // row collided" and "this chunk had no valid rows" the same answer. Since
    // 083 the collision means "you sent us these exact people again" rather than
    // "this campaign is already populated", which is the narrower and far more
    // reportable claim.
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('agency_ingest_chunks')) return { rows: [{ id: 'm1' }], rowCount: 1 };
      if (sql.includes('INSERT INTO agency_contacts')) return { rows: [], rowCount: 0 }; // all collide
      return { rows: [], rowCount: 1 };
    });
    pool.query.mockResolvedValue({ rows: [{ n: '3' }] });

    const res = await new AgencyContactRepository().applyIngestChunk(chunk([
      { phone_e164: '+911', source_row_number: 7 },
      { phone_e164: '+912', source_row_number: 8 },
    ]));

    expect(res.accepted).toBe(0);
    expect(res.duplicate_chunk).toBe(false); // NOT a replay — a different job colliding
    expect(res.rejected_duplicate_rows).toBe(2);
    expect(res.duplicate_source_rows).toEqual([7, 8]);
  });

  it('names the conflict target so a real constraint fault is not swallowed', async () => {
    // A bare `ON CONFLICT DO NOTHING` absorbs EVERY violation, so a bad FK or a
    // failed CHECK looked exactly like a replayed row and silently decremented
    // `accepted`. Asserted on the SQL because the behaviour it protects (an
    // unrelated violation throwing) only appears against real Postgres.
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('agency_ingest_chunks')) return { rows: [{ id: 'm1' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    pool.query.mockResolvedValue({ rows: [{ n: '1' }] });

    await new AgencyContactRepository().applyIngestChunk(chunk([{ phone_e164: '+911', source_row_number: 1 }]));

    const insert = client.query.mock.calls
      .map((c: any) => String(c[0]))
      .find((s: string) => s.includes('INSERT INTO agency_contacts'))!;
    expect(insert).toContain('ON CONFLICT (campaign_id, row_fingerprint)');
    expect(insert).toContain('WHERE row_fingerprint IS NOT NULL');
  });

  it('does not TOUCH source_row_number at all — neither as a target nor as a write', async () => {
    // ── Two defects, one column, and the second one only CI could find ────────
    //
    // (1) `source_row_number` is master's per-FILE line number, so keying the
    // roster on it meant a second CSV's lines 2..N collided with the first's and
    // every row of a top-up was discarded — while the operator was told it worked.
    // 083 moved the conflict target to `row_fingerprint`.
    //
    // (2) That was not enough, and this assertion used to say the opposite — it
    // required the column to still be WRITTEN ("it is what `duplicate_source_rows`
    // names back", which was simply wrong: the reported numbers come from the INPUT
    // rows in the loop, never from a stored value). 073's
    // `uq_agency_contacts_source_row` is still live and cannot be dropped until no
    // pre-083 replica can serve a request, so writing the column left a top-up
    // file's row 2 colliding with the first file's row 2 — and now that the
    // inference names a different index, that 23505 aborts the chunk instead of
    // being swallowed. Both top-up arms of `agency-ingest-idempotency.test.ts`
    // failed on it against a real database.
    //
    // The old index is PARTIAL on `source_row_number IS NOT NULL`, so 085's fix is
    // to leave the column out entirely and store the CSV line in the unindexed
    // `csv_line_number`. Asserted as an explicit absence in BOTH roles, because
    // either half coming back — as a conflict target or merely as a written column
    // — restores a defect that looks like a tidy-up in review.
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('agency_ingest_chunks')) return { rows: [{ id: 'm1' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    pool.query.mockResolvedValue({ rows: [{ n: '1' }] });

    await new AgencyContactRepository().applyIngestChunk(chunk([{ phone_e164: '+911', source_row_number: 1 }]));

    const insert = client.query.mock.calls
      .map((c: any) => String(c[0]))
      .find((s: string) => s.includes('INSERT INTO agency_contacts'))!;
    expect(insert).not.toMatch(/source_row_number/);
    // The provenance is not discarded, only moved — a NULL row number with the CSV
    // line nowhere would be deleted history, which is what made "just write NULL"
    // the wrong version of this fix.
    expect(insert).toContain('csv_line_number');
  });

  it('still reports the refused rows by their INPUT row number, with the column unwritten', async () => {
    // The property that made 085 free, asserted rather than reasoned: what the
    // operator is shown is built from the submitted contact, so it is unaffected by
    // where — or whether — core stores the line number. If this ever started
    // reading the stored column it would return nothing but NULLs.
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('agency_ingest_chunks')) return { rows: [{ id: 'm1' }], rowCount: 1 };
      if (sql.includes('INSERT INTO agency_contacts')) return { rows: [], rowCount: 0 }; // all collide
      return { rows: [], rowCount: 1 };
    });
    pool.query.mockResolvedValue({ rows: [{ n: '0' }] });

    const res = await new AgencyContactRepository().applyIngestChunk(chunk([
      { phone_e164: '+911', source_row_number: 41 },
      { phone_e164: '+912', source_row_number: 42 },
    ]));

    expect(res.rejected_duplicate_rows).toBe(2);
    expect(res.duplicate_source_rows).toEqual([41, 42]);
  });

  it('fingerprints the row from the SAME bound parameters it inserts', async () => {
    // Row identity has exactly one definition — `agency_contact_row_fingerprint`,
    // shared by this INSERT and migration 083's backfill. It is computed in SQL
    // from `$4/$5/$7` rather than handed in as an eighth parameter precisely so
    // the hashed values cannot drift from the stored ones: a fingerprint built
    // from anything other than the phone/context/timezone actually written would
    // either wave duplicates through or refuse rows that are not duplicates, and
    // both failures are invisible until a roster is already wrong.
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('agency_ingest_chunks')) return { rows: [{ id: 'm1' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    pool.query.mockResolvedValue({ rows: [{ n: '1' }] });

    await new AgencyContactRepository().applyIngestChunk(
      chunk([{ phone_e164: '+911', context: { name: 'A' }, source_row_number: 1, timezone: 'Asia/Kolkata' }]),
    );

    const call = client.query.mock.calls.find((c: any) => String(c[0]).includes('INSERT INTO agency_contacts'))!;
    const insert = String(call[0]);
    expect(insert).toContain('agency_contact_row_fingerprint($4, $5::jsonb, $7)');
    // $4/$5/$7 are the phone, context and timezone this row is stored with.
    const params = call[1] as unknown[];
    expect(params[3]).toBe('+911');
    expect(params[4]).toBe(JSON.stringify({ name: 'A' }));
    expect(params[6]).toBe('Asia/Kolkata');
  });

  it('rolls back and releases the connection when a row insert throws', async () => {
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('agency_ingest_chunks')) return { rows: [{ id: 'm1' }], rowCount: 1 };
      if (sql.includes('INSERT INTO agency_contacts')) throw new Error('bad row');
      return { rows: [], rowCount: 1 };
    });

    await expect(new AgencyContactRepository().applyIngestChunk(chunk([{ phone_e164: '+911' }])))
      .rejects.toThrow('bad row');

    expect(client.query.mock.calls.map((c: any) => c[0])).toContain('ROLLBACK');
    // A leaked pool connection per failed chunk would exhaust the pool during a
    // large ingest and take the whole service down with it.
    expect(client.release).toHaveBeenCalled();
  });

  it('releases the connection on the happy path too', async () => {
    client.query.mockImplementation(async (sql: string) => (
      sql.includes('agency_ingest_chunks') ? { rows: [{ id: 'm1' }], rowCount: 1 } : { rows: [], rowCount: 1 }
    ));
    await new AgencyContactRepository().applyIngestChunk(chunk([{ phone_e164: '+911' }]));
    expect(client.release).toHaveBeenCalled();
  });
});

describe('AgencyContactRepository.missingChunks', () => {
  it('reports exactly the gap so master can re-send only what was lost', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ chunk_index: 0 }, { chunk_index: 2 }] });
    const missing = await new AgencyContactRepository().missingChunks('camp-1', 'job-1', 4);

    // A lost final chunk would otherwise leave a campaign permanently
    // un-startable with nothing to diagnose it by.
    expect(missing).toEqual([1, 3]);
  });

  it('returns an empty gap for a whole roster', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ chunk_index: 0 }, { chunk_index: 1 }] });
    expect(await new AgencyContactRepository().missingChunks('camp-1', 'job-1', 2)).toEqual([]);
  });

  it('reports everything missing when nothing landed', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    expect(await new AgencyContactRepository().missingChunks('camp-1', 'job-1', 3)).toEqual([0, 1, 2]);
  });
});

describe('AgencyCampaignRepository.update — the allow-list', () => {
  it('REFUSES to write status, so a config edit cannot race the pacing leader', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'camp-1' }] });
    await new AgencyCampaignRepository().update('camp-1', {
      name: 'Renamed', status: 'completed', contacts_total: 99999,
    } as any);

    const sql = pool.query.mock.calls[0]![0] as string;
    // `running → completed` and `stopping → stopped` have exactly one writer (the
    // leader). Letting a PATCH set status would give them two.
    expect(sql).toContain('name =');
    expect(sql).not.toContain('status =');
    expect(sql).not.toContain('contacts_total =');
  });

  it('serialises JSON columns and leaves scalars alone', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'camp-1' }] });
    await new AgencyCampaignRepository().update('camp-1', {
      context_display: { hero: ['First Name'] }, wrapup_seconds: 45,
    } as any);

    const [sql, values] = pool.query.mock.calls[0]!;
    expect(sql).toContain('context_display = $2::jsonb');
    expect(values[1]).toBe('{"hero":["First Name"]}');
    expect(values[2]).toBe(45);
  });

  it('ALLOWS abandon_announcement_id, and lets null clear it (AD-P2-C-05)', async () => {
    // The column, the model field and the dial-time resolver all shipped before
    // anything could write it — so the apology clip was unreachable in production
    // while every test of the playback path passed. §16.6 question 2: the property
    // has to hold where it is CONSUMED, and it is consumed by an operator.
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'camp-1' }] });
    await new AgencyCampaignRepository().update('camp-1', {
      abandon_announcement_id: 'ann-1',
    } as any);
    let [sql, values] = pool.query.mock.calls[0]!;
    expect(sql).toContain('abandon_announcement_id = $2');
    // Not JSON-serialised — it is a UUID, and quoting it would store `"ann-1"`.
    expect(values[1]).toBe('ann-1');

    // `null` is a real value here, not "unchanged": it is how an operator removes
    // an apology. The `v === undefined` filter must not swallow it.
    pool.query.mockClear();
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'camp-1' }] });
    await new AgencyCampaignRepository().update('camp-1', {
      abandon_announcement_id: null,
    } as any);
    [sql, values] = pool.query.mock.calls[0]!;
    expect(sql).toContain('abandon_announcement_id = $2');
    expect(values[1]).toBeNull();
  });

  it('is a no-op read when nothing patchable was supplied', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'camp-1' }] });
    await new AgencyCampaignRepository().update('camp-1', { status: 'running' } as any);
    // Falls through to findById rather than emitting `SET , updated_at`.
    expect(pool.query.mock.calls[0]![0]).toContain('SELECT * FROM agency_campaigns');
  });
});

describe('AgencyCampaignRepository.rosterCounts — the start gate\'s predicate', () => {
  it('counts a contact in retry BACKOFF as dialable', async () => {
    // ── Where this property actually lives ────────────────────────────────────
    // The route test for the start gate mocks `rosterCounts` and can only assert
    // that a `dialable > 0` answer starts the campaign — which is true of any
    // number and says nothing about backoff. The property is entirely in this
    // predicate, so it has to be pinned here.
    //
    // `next_attempt_at` can be hours out. A contact waiting on a retry is SCHEDULED
    // work, not exhausted work, so it must count — otherwise a campaign whose whole
    // roster is mid-backoff could not be started, which is precisely a campaign that
    // has work to do. That is why this deliberately does NOT reuse `claimDialable`'s
    // predicate, which additionally requires `next_attempt_at <= now()` because it
    // is answering a different question ("what can I dial *this tick*").
    pool.query.mockResolvedValueOnce({ rows: [{ total: '250', dialable: '40' }] });

    const counts = await new AgencyCampaignRepository().rosterCounts('camp-1');

    const [sql, params] = pool.query.mock.calls[0]!;
    // The states that mean "still to do", matching `countOutstanding` exactly.
    expect(String(sql)).toContain("state IN ('pending','in_flight','connected')");
    // The absence is the assertion: a `next_attempt_at` clause here would exclude
    // every contact in backoff and silently block a startable campaign.
    expect(String(sql)).not.toContain('next_attempt_at');
    // One round trip for both numbers — the gate needs `total` too, to tell "never
    // populated" from "run to exhaustion".
    expect(String(sql)).toContain('COUNT(*) FILTER');
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(params).toEqual(['camp-1']);
    expect(counts).toEqual({ total: 250, dialable: 40 });
  });

  it('reports an empty campaign as 0/0 rather than NaN', async () => {
    // `COUNT` always returns a row, but a defensive `?? 0` is what keeps a missing
    // one from becoming `Number(undefined)` — and `NaN > 0` is false, so the gate
    // would refuse every start with the wrong message.
    pool.query.mockResolvedValueOnce({ rows: [] });

    expect(await new AgencyCampaignRepository().rosterCounts('camp-1'))
      .toEqual({ total: 0, dialable: 0 });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// `suppressByPhone` — the campaign-scoped DNC sweep.
//
// ── What this tier can and cannot prove ────────────────────────────────────
//
// It CANNOT prove the effect. "Both roster rows end `suppressed`" is a statement
// about rows in Postgres, and a mocked pool will happily agree with whatever SQL
// it is handed — including SQL that matches nothing. That claim is
// `test/integration/agency/agency-dnc-campaign-scope.test.ts`'s, against a real
// database.
//
// What it CAN prove is the half that is TypeScript rather than SQL, and it is not
// a small half: which rows are decided to be the same number. The prefilter is
// deliberately loose (digits only) and `normalizeE164` makes the real decision in
// process, so "does a candidate the database returned actually match" is testable
// here, exactly, and a drift in it is a silent fail-open — a row skipped is a
// customer dialled again.
// ───────────────────────────────────────────────────────────────────────────
describe('AgencyContactRepository.suppressByPhone — one number, every row of it', () => {
  /** The SELECT answers with these rows; the UPDATE echoes what it was asked to write. */
  function stubPool(candidates: Array<{ id: string; phone_e164: string }>) {
    const run = async (sql: string, params?: unknown[]) => {
      const s = String(sql).trim();
      if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (s.startsWith('SELECT')) return { rows: candidates, rowCount: candidates.length };
      const ids = (params?.[1] ?? []) as string[];
      return { rows: ids.map((id) => ({ id })), rowCount: ids.length };
    };
    // The usable-number path is transactional (SELECT FOR UPDATE + UPDATE on one
    // client). The unusable-number path writes the marked row on the pool.
    client.query.mockImplementation(run);
    pool.query.mockImplementation(run);
  }

  function selectCall(): [string, unknown[]] {
    const call = client.query.mock.calls.find((c: unknown[]) => String(c[0]).trim().startsWith('SELECT'));
    expect(call, 'expected a SELECT on the held client').toBeTruthy();
    return [String(call![0]), call![1] as unknown[]];
  }

  function updateCall(): [string, unknown[]] {
    const fromClient = client.query.mock.calls.find((c: unknown[]) => String(c[0]).includes('UPDATE agency_contacts'));
    if (fromClient) return [String(fromClient[0]), fromClient[1] as unknown[]];
    const fromPool = pool.query.mock.calls.find((c: unknown[]) => String(c[0]).includes('UPDATE agency_contacts'));
    expect(fromPool, 'expected an UPDATE').toBeTruthy();
    return [String(fromPool![0]), fromPool![1] as unknown[]];
  }

  it('asks the database for candidates by DIGITS, scoped to the campaign, and locks them', async () => {
    stubPool([]);
    await new AgencyContactRepository().suppressByPhone('camp-1', '+14155550100', 'dnc');

    const [sql, params] = selectCall();
    // The prefilter, byte-identical to the expression migration 087 indexes. A
    // different spelling of the same regex costs the index silently, so the string
    // is pinned rather than the behaviour.
    expect(sql).toContain("regexp_replace(phone_e164, '[^0-9]', '', 'g')");
    expect(sql).toContain('campaign_id = $1');
    // Digits, without the leading '+': the stored side has every non-digit removed,
    // so comparing against '+1415…' would match nothing at all — and matching
    // nothing is the failure that looks exactly like "no duplicates exist".
    expect(params[0]).toBe('camp-1');
    expect(params[1]).toBe('14155550100');
    // `FOR UPDATE` (not SKIP LOCKED) is the race close: claimDialable uses
    // SKIP LOCKED, so a duplicate we hold cannot be taken between SELECT and
    // UPDATE. Waiting, rather than skipping, is what still suppresses a row a
    // claim already has in flight.
    expect(sql).toContain('FOR UPDATE');
    expect(sql).not.toContain('SKIP LOCKED');
    const kinds = client.query.mock.calls.map((c: unknown[]) => String(c[0]).trim().split(/\s/)[0]);
    expect(kinds).toEqual(['BEGIN', 'SELECT', 'ROLLBACK']);
  });

  it('holds the SELECT and the UPDATE in ONE transaction', async () => {
    stubPool([{ id: 'c-1', phone_e164: '+14155550100' }]);
    await new AgencyContactRepository().suppressByPhone('camp-1', '+14155550100', 'dnc');

    const kinds = client.query.mock.calls.map((c: unknown[]) => {
      const s = String(c[0]).trim();
      if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return s;
      if (s.startsWith('SELECT')) return 'SELECT';
      if (s.startsWith('UPDATE')) return 'UPDATE';
      return s.split(/\s/)[0];
    });
    expect(kinds).toEqual(['BEGIN', 'SELECT', 'UPDATE', 'COMMIT']);
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('rolls the transaction back when the UPDATE throws, and still releases the client', async () => {
    client.query.mockImplementation(async (sql: string) => {
      const s = String(sql).trim();
      if (s === 'BEGIN') return { rows: [], rowCount: 0 };
      if (s.startsWith('SELECT')) return { rows: [{ id: 'c-1', phone_e164: '+14155550100' }], rowCount: 1 };
      if (s.startsWith('UPDATE')) throw new Error('deadlock');
      return { rows: [], rowCount: 0 };
    });

    await expect(new AgencyContactRepository().suppressByPhone('camp-1', '+14155550100', 'dnc'))
      .rejects.toThrow('deadlock');

    const kinds = client.query.mock.calls.map((c: unknown[]) => String(c[0]).trim().split(/\s/)[0]);
    expect(kinds).toContain('ROLLBACK');
    expect(kinds).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('suppresses a duplicate stored in a DIFFERENT format from the marked row', async () => {
    // The case the whole method exists for, at the only tier that can see the
    // decision: the roster stores what the CSV held, so the same number appears as
    // `+14155550100` and as `+1 (415) 555-0100`. Comparing the stored strings
    // would call these two different numbers and leave the second dialable.
    stubPool([
      { id: 'c-dialled', phone_e164: '+14155550100' },
      { id: 'c-never-dialled', phone_e164: '+1 (415) 555-0100' },
    ]);

    const ids = await new AgencyContactRepository()
      .suppressByPhone('camp-1', '+14155550100', 'dnc', { alwaysContactId: 'c-dialled' });

    expect(ids.sort()).toEqual(['c-dialled', 'c-never-dialled']);
    const [, params] = updateCall();
    expect((params[1] as string[]).sort()).toEqual(['c-dialled', 'c-never-dialled']);
    // The marked row is locked with the sweep, not looked up afterwards.
    expect(selectCall()[1][2]).toBe('c-dialled');
  });

  it('refuses a candidate the loose prefilter let through but `normalizeE164` rejects', async () => {
    // `1a4155550100` has the right digits and is not a phone number. The prefilter
    // cannot tell — that is what makes it safe to be loose — and the exact decision
    // is `normalizeE164`'s. Suppressing this row would be harmless; the assertion
    // is here because the same code path decides the reverse case, and a filter
    // that has stopped running is invisible from the harmless side.
    stubPool([
      { id: 'c-1', phone_e164: '+14155550100' },
      { id: 'c-junk', phone_e164: '1a4155550100' },
    ]);

    const ids = await new AgencyContactRepository().suppressByPhone('camp-1', '+14155550100', 'dnc');
    expect(ids).toEqual(['c-1']);
  });

  it('never touches next_attempt_at — the STATE is what takes a contact off the roster', async () => {
    // `markState` COALESCEs the column and this method preserves that by omitting
    // it. Clearing it belongs to AD-P3-C-04; a compliance write quietly nulling a
    // column a compliance export reads is exactly the kind of untracked change the
    // route's ⚠️ comment exists to prevent.
    stubPool([{ id: 'c-1', phone_e164: '+14155550100' }]);
    await new AgencyContactRepository().suppressByPhone('camp-1', '+14155550100', 'dnc');

    const [sql] = updateCall();
    expect(sql).toContain("state = 'suppressed'");
    expect(sql).not.toContain('next_attempt_at');
  });

  it('writes last_disposition to the MARKED row only', async () => {
    stubPool([
      { id: 'c-dialled', phone_e164: '+14155550100' },
      { id: 'c-housemate', phone_e164: '+14155550100' },
    ]);
    await new AgencyContactRepository().suppressByPhone('camp-1', '+14155550100', 'dnc', {
      alwaysContactId: 'c-dialled',
      lastDisposition: 'do_not_call',
    });

    const [sql, params] = updateCall();
    // A CASE keyed on the marked id, not a blanket SET: two rows on one landline
    // are two people, and recording a disposition against the one who never spoke
    // invents a conversation on a table an audit reads.
    expect(sql).toContain('CASE WHEN id = $4::uuid');
    expect(params[3]).toBe('c-dialled');
    expect(params[4]).toBe('do_not_call');
  });

  it('still suppresses the marked row when the number is not usable E.164 at all', async () => {
    // The guarantee the route has always made, and the one a by-phone rewrite
    // drops in silence: a roster row reading `not-a-number` matches nothing, and
    // the customer in front of the agent must still leave the roster. Note the
    // SELECT is not even issued — there is nothing to look up.
    stubPool([]);
    const ids = await new AgencyContactRepository()
      .suppressByPhone('camp-1', 'not-a-number', 'dnc', { alwaysContactId: 'c-dialled' });

    expect(ids).toEqual(['c-dialled']);
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.connect).not.toHaveBeenCalled();
    expect(String(pool.query.mock.calls[0]![0]).trim().startsWith('UPDATE')).toBe(true);
    // And it is loud: a number nothing can match means any duplicate of it stays
    // dialable, which an operator has to be able to find out about.
    expect(logSpy.error).toHaveBeenCalled();
  });

  it('writes nothing at all when there is neither a marked row nor a match', async () => {
    // `UPDATE ... WHERE id = ANY('{}')` is a no-op, but issuing it would still put
    // a write on the compliance path for a request that suppresses nothing.
    stubPool([]);
    const ids = await new AgencyContactRepository().suppressByPhone('camp-1', 'not-a-number', 'dnc');

    expect(ids).toEqual([]);
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Q3's reference check, read half — BOTH predicates.
//
// A campaign can depend on an analysis profile two ways: by NAMING it, or by
// naming nothing and inheriting the account default. `findLiveDependentsOn-
// AnalysisProfile` answers the first, `countLiveCampaignsInheritingAccountDefault`
// the second, and the route's rules over them are deliberately asymmetric (see
// `agencyDependencyRejected`).
//
// A mocked pool cannot prove that either SQL selects the right rows; that is
// `test/integration/**`'s job against real Postgres. What it CAN prove is the part
// that decides the answer rather than executes it: which statuses count as a
// dependency, that both lookups are tenant/account-scoped, that the terminal set is
// passed as a parameter rather than inlined per call site, that the projection is
// the narrow one, and that the count comes back a number. Each of those failing is
// silent — a guard that quietly stops refusing looks exactly like a guard with
// nothing to refuse.
// ───────────────────────────────────────────────────────────────────────────
describe('AgencyCampaignRepository.findLiveDependentsOnAnalysisProfile', () => {
  it('treats only completed/stopped as history, and asks the database for the rest', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await new AgencyCampaignRepository()
      .findLiveDependentsOnAnalysisProfile('prof-1', 't1', 'a1');

    const [sql, params] = pool.query.mock.calls[0]!;
    // Negated, not enumerated. The direction is the property: a status added to
    // `AgencyCampaignStatus` later must default to "live" so the guard keeps
    // covering it, rather than dropping out of coverage without a word.
    //
    // The `toEqual` is the whole statement — exact membership pins both directions
    // at once, so `draft` or `paused` slipping into the terminal set fails it. Each
    // of those would silently stop the guard refusing for the status where it
    // matters most: a `draft`'s reference has not been used yet, so breaking it
    // surfaces at the first start rather than at the edit that caused it.
    expect(String(sql)).toContain('NOT (status = ANY($4))');
    expect(params![3]).toEqual(['completed', 'stopped']);
  });

  it('scopes to the profile\'s own tenant and account', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await new AgencyCampaignRepository()
      .findLiveDependentsOnAnalysisProfile('prof-1', 't1', 'a1');

    const [sql, params] = pool.query.mock.calls[0]!;
    // Not defence in depth — these rows land verbatim in a refusal body handed to a
    // caller master gates on `calls.dialer.analytics` alone. Unscoped, the lookup
    // would report one tenant's campaign ids and statuses to another tenant's
    // admin, AND veto their edit over a dependency they can neither see nor fix.
    expect(String(sql)).toContain('tenant_id = $2');
    expect(String(sql)).toContain('account_id = $3');
    expect(params).toEqual(['prof-1', 't1', 'a1', ['completed', 'stopped']]);
  });

  it('projects id and status ONLY — the refusal body is not a campaign dump', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await new AgencyCampaignRepository()
      .findLiveDependentsOnAnalysisProfile('prof-1', 't1', 'a1');

    // The method body is `return rows;`, so the SELECT list IS the wire shape of
    // `details.campaigns` — there is no mapping step in between to narrow
    // anything. `SELECT *` would therefore ship `caller_ids`, `retry_policy`,
    // `disposition_catalog`, `sip_connection_id` and `created_by` into a browser
    // error body, on a surface gated on `calls.dialer.analytics` alone whose reader
    // may hold no agency entitlement at all.
    //
    // Asserting the returned rows against the rows the mock was told to return
    // cannot see any of that — it restates the mock and cannot fail. The SELECT
    // list can, so that is what is pinned. `name` is called out by hand because it
    // is the column a future author is most likely to add back: it reads like a
    // kindness to the console, and `AgencyCampaignDependent` drops it on purpose
    // (campaign names are the agency product's vocabulary, and this body crosses
    // to a caller who is not entitled to that product).
    const sql = String(pool.query.mock.calls[0]![0]);
    expect(sql).toMatch(/SELECT\s+id,\s*status\s+FROM\s+agency_campaigns/);
    expect(sql).not.toContain('SELECT *');
    expect(sql).not.toContain('name');
  });

  // There is deliberately NO test here for "an empty result is `[]`, never null".
  // The method is `return rows;` over `pg`'s `QueryResult`, whose `rows` is always
  // an array — so the guarantee belongs to the driver, and nothing at this tier can
  // tell `return rows` from `return rows ?? []`. A test mocking `{ rows: [] }` and
  // asserting `[]` restates its own mock; one mocking a result with no `rows` at
  // all asserts against a pg result that cannot occur. The statement is made in the
  // integration tier instead, where a real driver returns the empty case
  // (`test/integration/agency/agency-analysis-profile-reference-check.test.ts`).

  it('counts inheritors by NULL reference, negating the same terminal set', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ count: '0' }] });

    await new AgencyCampaignRepository()
      .countLiveCampaignsInheritingAccountDefault('t1', 'a1');

    const [sql, params] = pool.query.mock.calls[0]!;
    // `IS NULL`, never `= NULL`: the latter is never true, so the count would be 0
    // for every account and the inheritance half of the guard would refuse nothing,
    // ever — the exact hole this predicate was added to close, reopened by one
    // character and reading almost identically.
    expect(String(sql)).toContain('analysis_profile_id IS NULL');
    // Same terminal set, same direction, same parameter treatment as the matched
    // predicate above. Two guards over one subsystem drifting on which statuses
    // count as live is how one of them quietly stops covering `stopping`.
    expect(String(sql)).toContain('NOT (status = ANY($3))');
    expect(params).toEqual(['t1', 'a1', ['completed', 'stopped']]);
  });

  it('scopes the inheritor count to the tenant and account', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ count: '0' }] });

    await new AgencyCampaignRepository()
      .countLiveCampaignsInheritingAccountDefault('t1', 'a1');

    // `findDefault` is per (tenant, account), so the set of campaigns inheriting a
    // given default is too. Unscoped, a busy neighbouring account would veto this
    // account's edits permanently, and the refusal would quote a number of
    // campaigns the operator does not have.
    const sql = String(pool.query.mock.calls[0]![0]);
    expect(sql).toContain('tenant_id = $1');
    expect(sql).toContain('account_id = $2');
  });

  it('returns a NUMBER, so an account with no inheritors is not refused', async () => {
    // `COUNT(*)::text` — the cast is in the SQL because an unqualified `bigint`
    // comes back from `pg` as a string anyway — and the route compares with
    // `inheriting === 0`. Drop the `Number()` and the answer is `'0'`: truthy, and
    // never `=== 0`, so the guard refuses every DELETE and every default-clearing
    // PUT in every account, including the overwhelming majority that have no
    // agency campaigns at all. A guard meant to be inert for most tenants failing
    // closed for all of them is the worst outcome available here, and no fixture
    // that HAS dependents can catch it.
    pool.query.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    expect(await new AgencyCampaignRepository()
      .countLiveCampaignsInheritingAccountDefault('t1', 'a1')).toBe(0);

    // The non-zero case for the same reason in the other direction: `toBe` is
    // `Object.is`, so `'3'` fails here rather than being quietly accepted and
    // rendered into the refusal message as the string it is.
    pool.query.mockResolvedValueOnce({ rows: [{ count: '3' }] });
    expect(await new AgencyCampaignRepository()
      .countLiveCampaignsInheritingAccountDefault('t1', 'a1')).toBe(3);
  });
});

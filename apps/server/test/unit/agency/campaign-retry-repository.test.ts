import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Retry campaigns — the repository half (design §4.3, wire contract §2).
//
// These pin the DECISIONS, not the SQL text: which rows are seeded, which
// columns are deliberately absent from the INSERT, what is written to
// `retry_selector`, and that nothing at all is created when the selection is
// empty or over the cap. Every one of them has the same failure signature —
// a 201 saying it worked, over a roster that is not the one the supervisor chose.
//
// The SQL itself (the partial unique index, `ON CONFLICT` inference, the real
// transaction) is proven against Postgres in the integration tier; what is
// assertable here is the shape of the statement and the branching around it,
// which is where the decisions live.
// ---------------------------------------------------------------------------

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
} from '../../../src/db/repositories/agency.repository.js';
import { RETRY_MAX_SEED_ROWS, PRIOR_ATTEMPT_LIMIT } from '@magick-agency/domain/retry-campaign-bounds';
import type { AgencyRetrySelector } from '@magick-agency/contracts/agency';
import type { AgencyCampaignConfigColumns, AgencyCampaignRecord } from '../../../src/db/models/agency.model.js';

const PARENT = {
  id: 'camp-parent', tenant_id: 't1', account_id: 'a1', name: 'Q3 Winback',
  caller_ids: ['+14155550100'], telephony_provider: 'vobiz',
  calling_window_start: '09:00:00', calling_window_end: '20:00:00',
  calling_days: [1, 2, 3, 4, 5], default_timezone: 'UTC',
  wrapup_seconds: 30, wrapup_auto_return: true,
  retry_policy: {}, disposition_catalog: [], context_display: {}, break_reasons: [],
  record_calls: false, analysis_profile_id: null, abandon_announcement_id: null,
  abandonment_ceiling_pct: 3,
  status: 'completed', contacts_total: 4000,
  parent_campaign_id: null, root_campaign_id: null, retry_generation: 0, retry_selector: null,
} as unknown as AgencyCampaignRecord;

const CONFIG: AgencyCampaignConfigColumns = {
  caller_ids: PARENT.caller_ids, telephony_provider: PARENT.telephony_provider,
  calling_window_start: PARENT.calling_window_start, calling_window_end: PARENT.calling_window_end,
  calling_days: PARENT.calling_days, default_timezone: PARENT.default_timezone,
  wrapup_seconds: PARENT.wrapup_seconds, wrapup_auto_return: PARENT.wrapup_auto_return,
  retry_policy: PARENT.retry_policy, disposition_catalog: PARENT.disposition_catalog,
  context_display: PARENT.context_display, break_reasons: PARENT.break_reasons,
  record_calls: false, analysis_profile_id: null, abandon_announcement_id: null,
  abandonment_ceiling_pct: 3,
};

/**
 * Drive `retryFromCampaign`'s client through one successful transaction.
 *
 * The order is BEGIN → count → campaign INSERT → contacts INSERT → contacts_total
 * UPDATE → COMMIT, and the doubles are keyed on the statement rather than on call
 * index so that inserting a statement does not silently shift every expectation
 * onto the wrong query.
 */
function stubTransaction(opts: {
  matched?: number; dnc?: number; invalid?: number; seeded?: number;
} = {}) {
  const matched = opts.matched ?? 3;
  client.query.mockImplementation(async (sql: string) => {
    const text = String(sql);
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(text)) return { rows: [], rowCount: 0 };
    if (text.includes('AS matched')) {
      return {
        rows: [{
          matched: String(matched),
          dnc: String(opts.dnc ?? 0),
          invalid: String(opts.invalid ?? 0),
        }],
        rowCount: 1,
      };
    }
    if (text.includes('INSERT INTO agency_campaigns')) {
      return { rows: [{ ...PARENT, id: 'camp-child', contacts_total: 0 }], rowCount: 1 };
    }
    if (text.includes('INSERT INTO agency_contacts')) {
      return { rows: [], rowCount: opts.seeded ?? matched };
    }
    if (text.includes('UPDATE agency_campaigns')) {
      return {
        rows: [{ ...PARENT, id: 'camp-child', contacts_total: opts.seeded ?? matched }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });
}

/** The SQL of the first client statement whose text contains `needle`. */
function statement(needle: string): { sql: string; values: unknown[] } {
  const call = client.query.mock.calls.find((c: unknown[]) => String(c[0]).includes(needle));
  if (!call) throw new Error(`no statement containing ${needle}`);
  return { sql: String(call[0]), values: (call[1] ?? []) as unknown[] };
}

/**
 * The child-campaign INSERT's parameters, keyed by COLUMN NAME.
 *
 * Positional assertions (`values[values.length - 2]`) were what this replaced,
 * and adding one trailing parameter — `retry_idempotency_key` — broke two of
 * them at once while leaving the SQL correct. A test that fails because a column
 * was appended is a test that will be "fixed" by shifting an index, which is how
 * the next append silently lands on the wrong assertion instead.
 *
 * The column list and the `$n` placeholders are written in lockstep in the
 * repository, so zipping the declared columns onto `values` is exact rather than
 * a heuristic — and a mismatch in length means the two have drifted, which is
 * itself worth failing on.
 */
function campaignInsert(): Record<string, unknown> {
  const { sql, values } = statement('INSERT INTO agency_campaigns');
  const columns = sql
    .slice(sql.indexOf('(') + 1, sql.indexOf(')'))
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  if (columns.length !== values.length) {
    throw new Error(
      `INSERT declares ${columns.length} columns but was given ${values.length} parameters`,
    );
  }
  return Object.fromEntries(columns.map((column, i) => [column, values[i]]));
}

beforeEach(() => {
  vi.clearAllMocks();
  pool.connect.mockResolvedValue(client);
  pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

// ── DR-4: the DNC/invalid exclusion is not a checkbox ──────────────────────

describe('the DR-4 exclusion is unconditional', () => {
  it('excludes dnc and invalid even when the selector explicitly asks for suppressed contacts', async () => {
    // The decision this file exists for. `parseRetrySelector` refuses a selector
    // that NAMES `dnc`, but that refusal is the explanation and this is the
    // enforcement — and they are different things: `state: ['suppressed']` names
    // neither value and matches both. A DNC suppression is a customer's recorded
    // request, not an operator choice; `invalid` is "a bad number does not become
    // good", the rule `resolveRetryDecision` already routes around any policy.
    stubTransaction({ matched: 40, dnc: 200, invalid: 60, seeded: 40 });
    const selector: AgencyRetrySelector = { state: ['suppressed'], suppressed_reason: ['max_attempts'] };

    const result = await new AgencyCampaignRepository().retryFromCampaign({
      parent: PARENT, name: 'Q3 Winback — Retry 1', selector, config: CONFIG, createdBy: null, idempotencyKey: null,
    });

    const seed = statement('INSERT INTO agency_contacts');
    // ── Assert the NULL-SAFE spelling, and know what this test cannot see ───
    //
    // This assertion previously read `= ANY(...)` and was GREEN while the
    // feature was completely inoperative: `suppressed_reason` is NULL for every
    // never-suppressed contact, `NOT (NULL = ANY(...))` is NULL, and `WHERE
    // NULL` drops the row — so the seed matched almost nothing. A text
    // assertion against a mocked pool cannot distinguish a predicate Postgres
    // evaluates to NULL from one that works.
    //
    // It is kept, narrowly, as a tripwire against reverting to the bare
    // comparison. The BEHAVIOUR is pinned where it can actually be observed:
    // `test/integration/agency/agency-retry-seeding.test.ts`, against a real
    // database. Do not add semantics to this tier — add them there.
    expect(seed.sql).toContain("NOT (COALESCE(c.suppressed_reason, '') = ANY('{dnc,invalid}'))");
    // Live-call guards. Semantics (NULL outcome + attempt_count = 0 matching
    // `__none__`) live in the integration tier; this is only a revert tripwire.
    expect(seed.sql).toContain("c.state <> 'in_flight'");
    expect(seed.sql).toContain('NOT EXISTS (SELECT 1 FROM agency_call_attempts rla');
    expect(seed.sql).toContain("rla.contact_id = c.id AND rla.state <> 'ended'");
    // And the counts the supervisor is shown say where the other 260 went, or
    // "we matched 300 and seeded 40" reads as a bug.
    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
    expect(result.excluded).toEqual({ dnc: 200, invalid: 60 });
  });

  it('reports the same exclusions on the preview, from the SAME predicate', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{
        matched: '40', dnc: '200', invalid: '60',
        by_last_outcome: { no_answer: '40' },
        by_last_disposition: { __none__: '40' },
        parent_contacts_total: '4000', retry_generation: 0,
      }],
      rowCount: 1,
    });

    const preview = await new AgencyCampaignRepository()
      .retryPreview('camp-parent', { state: ['suppressed'] });

    expect(preview).toEqual({
      matched: 40,
      by_last_outcome: { no_answer: 40 },
      by_last_disposition: { __none__: 40 },
      excluded: { dnc: 200, invalid: 60 },
      parent_contacts_total: 4000,
      // The CHILD's generation — what the console is about to create, not the
      // parent's.
      retry_generation: 1,
      max_seed_rows: RETRY_MAX_SEED_ROWS,
    });
    const [sql] = pool.query.mock.calls[0]!;
    // Same tripwire, on the preview's CTE. See the note on the seed above:
    // semantics live in the integration tier, not here.
    expect(String(sql)).toContain("NOT (COALESCE(selected.suppressed_reason, '') = ANY('{dnc,invalid}'))");
  });
});

// ── DR-2: the copy resets the allowance ────────────────────────────────────

describe('the seeding INSERT — what it writes and what it deliberately does not', () => {
  beforeEach(() => stubTransaction());

  it('omits state, attempt_count, our_fault_attempts and the outcome columns so they take DB defaults', async () => {
    // DR-2: a retry campaign is a FRESH allowance, which is the whole point of a
    // supervisor authoring one. Writing any of these explicitly would be a second
    // copy of migration 073's defaults with nothing keeping the two in step —
    // and writing the PARENT's values would carry a suppressed or exhausted state
    // onto a roster that has never been dialled.
    await new AgencyCampaignRepository().retryFromCampaign({
      parent: PARENT, name: 'r1', selector: { never_attempted: true }, config: CONFIG, createdBy: null, idempotencyKey: null,
    });

    const columns = statement('INSERT INTO agency_contacts').sql.split('SELECT')[0]!;
    for (const column of [
      'state', 'attempt_count', 'our_fault_attempts', 'next_attempt_at',
      'last_outcome', 'last_disposition', 'suppressed_reason',
    ]) {
      expect(columns, `${column} must take its column default`).not.toContain(column);
    }
  });

  it('never writes source_row_number — 085 is why, and re-adding it re-breaks top-up', async () => {
    // 073's `uq_agency_contacts_source_row` is still live and PARTIAL on NOT NULL,
    // so a row storing NULL sits outside it. Two seeded rows sharing a CSV line
    // number would collide on an index this INSERT does not name — a 23505 that
    // aborts the whole transaction rather than being swallowed by the ON CONFLICT.
    await new AgencyCampaignRepository().retryFromCampaign({
      parent: PARENT, name: 'r1', selector: { never_attempted: true }, config: CONFIG, createdBy: null, idempotencyKey: null,
    });
    expect(statement('INSERT INTO agency_contacts').sql).not.toContain('source_row_number');
  });

  it('recomputes the fingerprint with the SHARED SQL function and infers its index', async () => {
    // One definition of "the same roster row" across both seeding paths. Spelling
    // the md5 here instead would let this INSERT and the ingest INSERT drift into
    // disagreeing about which rows are the same row.
    const { sql } = (await new AgencyCampaignRepository().retryFromCampaign({
      parent: PARENT, name: 'r1', selector: { never_attempted: true }, config: CONFIG, createdBy: null, idempotencyKey: null,
    }), statement('INSERT INTO agency_contacts'));
    expect(sql).toContain('agency_contact_row_fingerprint(c.phone_e164, c.context, c.timezone)');
    expect(sql).toContain('ON CONFLICT (campaign_id, row_fingerprint) WHERE row_fingerprint IS NOT NULL');
    expect(sql).not.toMatch(/md5\(/);
  });

  it('carries the lineage through: source is the parent row, root is the chain head', async () => {
    const { sql } = (await new AgencyCampaignRepository().retryFromCampaign({
      parent: PARENT, name: 'r1', selector: { never_attempted: true }, config: CONFIG, createdBy: null, idempotencyKey: null,
    }), statement('INSERT INTO agency_contacts'));
    expect(sql).toContain('source_contact_id');
    expect(sql).toContain('root_contact_id');
    // The parent's ROOT, not the parent's id — that is what keeps a generation-3
    // contact pointing at generation 0. Migration 112's trigger only fires when the
    // column arrives NULL, so passing it explicitly leaves these rows alone.
    expect(sql).toContain('c.root_contact_id');
  });
});

// ── Lineage on the campaign row ────────────────────────────────────────────

describe('the child campaign row', () => {
  it('chains root_campaign_id correctly to generation 3', async () => {
    const repo = new AgencyCampaignRepository();
    const selector: AgencyRetrySelector = { last_outcome: ['no_answer'] };

    // Generation 1: the parent is a root with NULL `root_campaign_id` (migration
    // 111 deliberately does not stamp generation 0), so the child takes the
    // parent's own id.
    stubTransaction();
    await repo.retryFromCampaign({ parent: PARENT, name: 'r1', selector, config: CONFIG, createdBy: null, idempotencyKey: null });
    expect(campaignInsert()).toMatchObject({
      parent_campaign_id: 'camp-parent',
      root_campaign_id: 'camp-parent',
      retry_generation: 1,
    });

    // Generation 2 and 3: the root is INHERITED unchanged, never re-derived from
    // the immediate parent — otherwise generation 3's chain head would be
    // generation 2 and the lineage read would return two entries instead of four.
    for (const generation of [1, 2]) {
      vi.clearAllMocks();
      pool.connect.mockResolvedValue(client);
      stubTransaction();
      const ancestor = {
        ...PARENT, id: `camp-gen${generation}`,
        root_campaign_id: 'camp-parent', retry_generation: generation,
      } as AgencyCampaignRecord;
      await repo.retryFromCampaign({ parent: ancestor, name: 'r', selector, config: CONFIG, createdBy: null, idempotencyKey: null });
      expect(campaignInsert()).toMatchObject({
        parent_campaign_id: `camp-gen${generation}`,
        root_campaign_id: 'camp-parent',
        retry_generation: generation + 1,
      });
    }
  });

  it('stores retry_selector as sent — a record, not a query (DR-5)', async () => {
    // Re-running the selector later would produce a different set (the parent keeps
    // moving if it is resumed) and would make the child's roster non-reproducible
    // from its own row. So what is frozen is the operator's INTENT.
    stubTransaction();
    const selector: AgencyRetrySelector = {
      last_outcome: ['no_answer', 'busy'],
      last_disposition: ['voicemail'],
      never_attempted: true,
      attempt_count_lte: 2,
    };
    await new AgencyCampaignRepository().retryFromCampaign({
      parent: PARENT, name: 'r1', selector, config: CONFIG, createdBy: null, idempotencyKey: null,
    });

    expect(JSON.parse(String(campaignInsert()['retry_selector']))).toEqual(selector);
  });

  it('copies no column that describes the PARENT\'s run', async () => {
    // "Copy the config columns" applied naively carries a stale auto-pause record,
    // a start time and a terminal status onto a campaign that has never dialled.
    // `status` is absent from the column list entirely rather than written as
    // 'draft' (DR-9): 072's DEFAULT already says draft, and naming it here would be
    // a second copy of that default.
    stubTransaction();
    await new AgencyCampaignRepository().retryFromCampaign({
      parent: PARENT, name: 'r1', selector: { never_attempted: true }, config: CONFIG, createdBy: null, idempotencyKey: null,
    });
    const columns = statement('INSERT INTO agency_campaigns').sql.split('VALUES')[0]!;
    for (const column of [
      'status', 'started_at', 'ended_at', 'completed_at', 'contacts_total',
      'last_transition_by_user_id', 'last_transition_by_name',
      'pause_reason', 'paused_at', 'pause_abandonment_rate_pct',
    ]) {
      expect(columns, `${column} describes the parent's run`).not.toContain(column);
    }
  });
});

// ── The two refusals, and that they create NOTHING ─────────────────────────

describe('a selection that cannot be seeded creates nothing at all', () => {
  it('rolls back before any INSERT when the selector matches zero seedable contacts', async () => {
    // Without this the supervisor holds a campaign they cannot start (`/start`
    // answers `409 campaign_roster_empty`) and cannot delete — there is no campaign
    // delete route in either service. The refusal has to happen while a human is
    // present to be told.
    stubTransaction({ matched: 0, dnc: 14, invalid: 3 });

    const result = await new AgencyCampaignRepository().retryFromCampaign({
      parent: PARENT, name: 'r1', selector: { last_outcome: ['connected'] }, config: CONFIG, createdBy: null, idempotencyKey: null,
    });

    expect(result).toEqual({ status: 'empty', excluded: { dnc: 14, invalid: 3 } });
    const statements = client.query.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(statements.some((s: string) => s.includes('INSERT INTO'))).toBe(false);
    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });

  it('rolls back over the cap rather than seeding a truncated roster', async () => {
    // NOT truncated: seeding the first 100 000 of 300 000 produces exactly the
    // "dials a subset nobody chose" campaign the single transaction exists to
    // prevent, and the supervisor would have no way to tell.
    stubTransaction({ matched: RETRY_MAX_SEED_ROWS + 1 });

    const result = await new AgencyCampaignRepository().retryFromCampaign({
      parent: PARENT, name: 'r1', selector: { state: ['pending'] }, config: CONFIG, createdBy: null, idempotencyKey: null,
    });

    expect(result).toEqual({ status: 'too_large', matched: RETRY_MAX_SEED_ROWS + 1 });
    const statements = client.query.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(statements.some((s: string) => s.includes('INSERT INTO'))).toBe(false);
    expect(statements.at(-1)).toBe('ROLLBACK');
  });

  it('seeds exactly at the cap — the bound is inclusive', async () => {
    stubTransaction({ matched: RETRY_MAX_SEED_ROWS });
    const result = await new AgencyCampaignRepository().retryFromCampaign({
      parent: PARENT, name: 'r1', selector: { state: ['pending'] }, config: CONFIG, createdBy: null, idempotencyKey: null,
    });
    expect(result.status).toBe('created');
  });

  it('rolls back and releases the client when a statement throws mid-transaction', async () => {
    // The all-or-nothing guarantee, at its least convenient moment: the campaign
    // row exists in the transaction and the roster does not.
    stubTransaction();
    client.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes('AS matched')) return { rows: [{ matched: '5', dnc: '0', invalid: '0' }], rowCount: 1 };
      if (text.includes('INSERT INTO agency_campaigns')) return { rows: [{ ...PARENT, id: 'camp-child' }], rowCount: 1 };
      if (text.includes('INSERT INTO agency_contacts')) throw new Error('deadlock detected');
      return { rows: [], rowCount: 0 };
    });

    await expect(new AgencyCampaignRepository().retryFromCampaign({
      parent: PARENT, name: 'r1', selector: { state: ['pending'] }, config: CONFIG, createdBy: null, idempotencyKey: null,
    })).rejects.toThrow('deadlock detected');
    expect(client.query.mock.calls.map((c: unknown[]) => String(c[0]))).toContain('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });
});

// ── The lineage read ───────────────────────────────────────────────────────

describe('campaignLineage', () => {
  it('resolves the chain head with COALESCE on BOTH sides', async () => {
    // Migration 111 leaves `root_campaign_id` NULL on a generation-0 campaign, so
    // spelling the COALESCE on only one side returns a chain of one for every
    // parent — the exact case the strip exists to show.
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await new AgencyCampaignRepository().campaignLineage('t1', 'a1', 'camp-parent');
    const [sql] = pool.query.mock.calls[0]!;
    expect(String(sql)).toContain('COALESCE(root_campaign_id, id) AS root');
    expect(String(sql)).toContain('COALESCE(c.root_campaign_id, c.id) = a.root');
    expect(String(sql)).toContain('ORDER BY c.retry_generation, c.created_at');
  });

  it('answers with the campaign itself when it is in no chain', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: 'camp-parent', name: 'Q3 Winback', status: 'completed', retry_generation: 0,
        parent_campaign_id: null, contacts_total: 4000,
        created_at: new Date('2026-08-01T00:00:00Z'), started_at: null, ended_at: null,
        root_campaign_id: 'camp-parent',
      }],
      rowCount: 1,
    });
    const lineage = await new AgencyCampaignRepository().campaignLineage('t1', 'a1', 'camp-parent');
    expect(lineage?.root_campaign_id).toBe('camp-parent');
    expect(lineage?.campaigns).toHaveLength(1);
    expect(lineage?.campaigns[0]?.created_at).toBe('2026-08-01T00:00:00.000Z');
  });

  it('returns null only when the anchor matched nothing', async () => {
    // Which can only mean the campaign was deleted between the route's ownership
    // check and this read — never "a campaign with no chain", because such a
    // campaign is its own chain of one.
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await new AgencyCampaignRepository().campaignLineage('t1', 'a1', 'gone')).toBeNull();
  });
});

// ── The agent's history read ───────────────────────────────────────────────

describe('findPriorForContactLineage', () => {
  it('keys on root_contact_id and orders by ended_at, not attempt_number', async () => {
    // `attempt_number` is per contact ROW and resets in every retry campaign
    // (DR-2), so ordering by it interleaves two passes into nonsense: the parent's
    // attempt 3 would sort above the child's attempt 1 even though the child's is
    // more recent. `NULLS LAST` keeps a never-ended attempt (reaped, orphaned) at
    // the bottom rather than at the top, where a NULL sorts first under DESC.
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await new AgencyAttemptRepository().findPriorForContactLineage('root-1', 'att-9');

    const [sql, values] = pool.query.mock.calls[0]!;
    expect(String(sql)).toContain('WHERE c.root_contact_id = $1 AND a.id <> $2');
    expect(String(sql)).toContain('ORDER BY a.ended_at DESC NULLS LAST, a.attempt_number DESC');
    expect(String(sql)).toContain('cam.name AS campaign_name');
    expect(values).toEqual(['root-1', 'att-9']);
  });

  it('keeps the LIMIT cap, now spanning the lineage', async () => {
    // A display bound AND the bound on what this read can cost — it runs
    // synchronously inside the dial tick, before the dial.
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await new AgencyAttemptRepository().findPriorForContactLineage('root-1', 'att-9');
    expect(String(pool.query.mock.calls[0]![0])).toContain(`LIMIT ${PRIOR_ATTEMPT_LIMIT}`);
    expect(PRIOR_ATTEMPT_LIMIT).toBe(20);
  });

  it('returns attempts from every campaign in the chain, in the order the SQL gave them', async () => {
    const rows = [
      { id: 'a3', campaign_id: 'camp-gen2', campaign_name: 'Retry 2', attempt_number: 1, ended_at: new Date('2026-08-20T10:00:00Z') },
      { id: 'a2', campaign_id: 'camp-gen1', campaign_name: 'Retry 1', attempt_number: 1, ended_at: new Date('2026-08-10T10:00:00Z') },
      { id: 'a1', campaign_id: 'camp-parent', campaign_name: 'Q3 Winback', attempt_number: 2, ended_at: new Date('2026-08-01T10:00:00Z') },
    ];
    pool.query.mockResolvedValueOnce({ rows, rowCount: rows.length });

    const prior = await new AgencyAttemptRepository().findPriorForContactLineage('root-1', 'att-live');

    expect(prior.map((r) => r.campaign_name)).toEqual(['Retry 2', 'Retry 1', 'Q3 Winback']);
  });
});

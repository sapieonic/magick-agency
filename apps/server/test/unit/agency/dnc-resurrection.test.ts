import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// A DNC suppression that an outcome, a retry decision or a reaper puts back on
// the roster.
//
// ── The defect, end to end ─────────────────────────────────────────────────
//
//   1. the agent presses mark-DNC mid-call. `suppressByPhone` writes
//      `state = 'suppressed', suppressed_reason = 'dnc'` on the marked row;
//   2. the call then ends on an AGENT-SIDE path — the station socket drops after
//      the bridge, or this replica dies and the reaper writes `orphaned`;
//   3. that path calls `markState(contactId, decision.contactState, …)` with no
//      state guard, and both `resolveRetryDecision` and `resolveOurFaultRedial`
//      answer `contactState: 'pending'` for those outcomes under their caps —
//      `DEFAULT_RETRY_POLICY` carries `agent_disconnected: 5min ×3` and
//      `orphaned: 0min ×3`, and the dialer's own log line for that branch reads
//      "Contact requeued after an agent-side drop, with no attempt charged";
//   4. `claimDialable` gates on `state = 'pending' AND next_attempt_at <= now()`
//      and never looks at `suppressed_reason`, so the row is claimed;
//   5. the pre-dial DNC gate is `SISMEMBER dnc:{tenantId}` — and a CAMPAIGN-scoped
//      `dnc_entries` row never enters that flat set.
//
// Net: the customer who said "stop calling me" is dialled again from the same
// campaign inside five minutes, with `dnc_recorded: true` and every dashboard
// green.
//
// ── Why this is a merge blocker for THIS change rather than an old bug ──────
//
// Before campaign scoping, the mark wrote a TENANT-WIDE row that reached the flat
// set, so step 5 caught the resurrected contact at dial time. That backstop is
// removed by design here. For the marked contact itself the blast radius is
// therefore strictly LARGER after this change, not smaller.
//
// ── What each tier can and cannot prove ────────────────────────────────────
//
// The steps that produce `'pending'` are asserted here against the REAL policy
// functions, so the mechanism is pinned rather than described. The WRITE is SQL,
// and a mocked pool agrees with SQL that means nothing — so what is asserted at
// this tier is the shape of the statement the guard lives in, and the behavioural
// proof (read the row back; run `claimDialable` and require nothing) is
// `test/integration/agency/agency-dnc-resurrection.test.ts`, owed to CI.
// ---------------------------------------------------------------------------

const { pool, childLog } = vi.hoisted(() => ({
  pool: { query: vi.fn(), connect: vi.fn() },
  childLog: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@magick-agency/db', () => ({ getPool: () => pool }));
vi.mock('@magick-agency/observability', () => ({
  logger: childLog,
  createChildLogger: () => childLog,
}));

import { AgencyContactRepository } from '../../../src/db/repositories/agency.repository.js';
import { resolveOurFaultRedial, resolveRetryDecision } from '../../../src/agency/retry-policy.js';

/** The single SQL string a repository method sent, normalised to one line. */
function sqlOf(callIndex = 0): string {
  return String(pool.query.mock.calls[callIndex]![0]).replace(/\s+/g, ' ');
}

beforeEach(() => {
  vi.clearAllMocks();
  pool.query.mockResolvedValue({ rows: [{ state: 'suppressed', suppressed_reason: 'dnc' }], rowCount: 1 });
});

// ─── step 3: the decisions really do say `pending` ──────────────────────────

describe('the retry decisions that resurrect a contact', () => {
  it('an agent_disconnected under its cap resolves to pending, on the DEFAULT policy', () => {
    // `null` is the ordinary case, not an edge one: the public API layer never sends
    // `retry_policy`, so every campaign in the field runs `DEFAULT_RETRY_POLICY`.
    const decision = resolveRetryDecision(null, 'agent_disconnected', new Date(), 1);
    expect(decision.contactState, 'DEFAULT_RETRY_POLICY.agent_disconnected is 5min ×3').toBe('pending');
    expect(decision.nextAttemptAt, 'and it schedules the redial').not.toBeNull();
  });

  it('an orphaned reap under its cap resolves to pending too', () => {
    const decision = resolveOurFaultRedial(null, 'orphaned', new Date(), 1);
    expect(decision.contactState).toBe('pending');
  });
});

// ─── step 3, the write: the state transition must refuse ────────────────────

describe('markState refuses to move a DNC suppression', () => {
  /**
   * The guard is keyed on `suppressed_reason = 'dnc'` — the row's CURRENT reason
   * — and not on any of the three tempting alternatives:
   *
   *   * NOT on the TARGET state being `pending`. `agency-dialer.ts` writes
   *     `'connected'` from the `bridged` handler, and its own comment records that
   *     that write can land AFTER the `ended` handler's because lifecycle
   *     listeners are fire-and-forget. A target-keyed guard lets `connected`
   *     launder the row out of `suppressed`, after which nothing is guarded;
   *   * NOT on the current state being `suppressed`. `invalid` (the pre-dial gate,
   *     `resolveRetryDecision`) and ingest suppression are data-quality states
   *     other subsystems may legitimately move, and freezing those is a behaviour
   *     change nobody asked for;
   *   * NOT a blanket `WHERE … AND suppressed_reason IS DISTINCT FROM 'dnc'`,
   *     which would refuse the whole UPDATE. Mark-DNC on a live call is supported
   *     and the agent's write-up arrives AFTERWARDS through the disposition route,
   *     which calls `markState` with `last_disposition`. Refusing the row would
   *     silently drop that record of what was said.
   *
   * So: the STATE and the retry instant are frozen; every record-keeping column
   * still lands.
   */
  it('T-RES1: the agent_disconnected outcome path cannot write pending over a dnc row', async () => {
    const decision = resolveRetryDecision(null, 'agent_disconnected', new Date(), 1);
    // Exactly the call `agency-dialer.ts`'s outcome branch makes.
    await new AgencyContactRepository().markState('c-dnc', decision.contactState, {
      ...(decision.nextAttemptAt ? { next_attempt_at: decision.nextAttemptAt } : {}),
    });
    const sql = sqlOf();

    expect(pool.query.mock.calls[0]![1]![1], 'the caller really did ask for pending').toBe('pending');
    // A DNC reason means suppressed, whatever was asked for. Written as a
    // rewrite rather than a `WHERE` so the record-keeping columns still land, and
    // as `THEN 'suppressed'` rather than `THEN state` so a row already resurrected
    // by the pre-fix build self-heals the next time anything touches it.
    expect(sql).toContain("state = CASE WHEN suppressed_reason = 'dnc' THEN 'suppressed' ELSE $2 END");
  });

  it("T-RES2: and cannot leave a future retry instant on it either", async () => {
    const decision = resolveRetryDecision(null, 'agent_disconnected', new Date(), 1);
    await new AgencyContactRepository().markState('c-dnc', decision.contactState, {
      next_attempt_at: decision.nextAttemptAt!,
    });

    // Inert for dialing — the claim gates on state — but `next_attempt_at` is read
    // by the console and by compliance exports, and "suppressed, next call
    // Wednesday" is the precedence contradicting itself in the field a human
    // reads. Same objection `agency.routes.ts` already records for the losing
    // disposition arm.
    expect(sqlOf()).toContain(
      "next_attempt_at = CASE WHEN suppressed_reason = 'dnc'"
      + ' THEN next_attempt_at ELSE COALESCE($6, next_attempt_at) END',
    );
  });

  it('T-RES3: the reaper\'s hardcoded orphaned requeue is the same write, so it is covered too', async () => {
    // `reaper.ts` requeues with a literal `'pending'` rather than a decision, which
    // is why the guard lives in the repository and not at the call sites: one
    // statement, every caller. Enumerated in the commit message.
    await new AgencyContactRepository().markState('c-dnc', 'pending', {
      last_outcome: 'orphaned', next_attempt_at: new Date(),
    });
    expect(sqlOf()).toContain("state = CASE WHEN suppressed_reason = 'dnc' THEN 'suppressed' ELSE $2 END");
  });

  it('T-RES4: the record-keeping columns are deliberately NOT frozen', async () => {
    await new AgencyContactRepository().markState('c-dnc', 'suppressed', {
      last_disposition: 'do_not_call', last_outcome: 'agent_disconnected',
    });
    const sql = sqlOf();

    // The supported sequence: mark DNC mid-call, then write the disposition up.
    // A guard that refused the whole row would lose the agent's account of the
    // conversation and leave `last_outcome` reading like the call never ended.
    expect(sql).toContain('last_outcome = COALESCE($4, last_outcome)');
    expect(sql).toContain('last_disposition = COALESCE($5, last_disposition)');
  });

  it('T-RES4b: but the dnc REASON is frozen — COALESCE($7, col) would un-key the guard', async () => {
    // The `invalid` outcome path passes `suppressed_reason: 'invalid'`
    // (`resolveRetryDecision` + `agency-dialer.ts`). A plain
    // `COALESCE($7, suppressed_reason)` would overwrite `dnc`, after which both
    // the CASE freeze and `claimDialable`'s `IS DISTINCT FROM 'dnc'` no longer
    // apply, and a following `pending` write puts the number back on the roster.
    const decision = resolveRetryDecision(null, 'invalid', new Date(), 1);
    expect(decision.suppressedReason, 'the outcome path really does pass a reason').toBe('invalid');

    await new AgencyContactRepository().markState('c-dnc', decision.contactState, {
      suppressed_reason: decision.suppressedReason,
    });

    expect(pool.query.mock.calls[0]![1]![6]).toBe('invalid');
    expect(sqlOf()).toContain(
      "suppressed_reason = CASE WHEN suppressed_reason = 'dnc' THEN suppressed_reason"
      + ' ELSE COALESCE($7, suppressed_reason) END',
    );
  });

  it('T-RES5: the refusal is logged, never silent', async () => {
    // Postgres decided; TypeScript only reports. `RETURNING` is what makes the
    // refusal observable at all — without it the guard is a statement that
    // quietly does less than the caller believes, which is the shape of defect
    // this whole file exists about.
    pool.query.mockResolvedValue({
      rows: [{ state: 'suppressed', suppressed_reason: 'dnc' }], rowCount: 1,
    });
    await new AgencyContactRepository().markState('c-dnc', 'pending', { last_outcome: 'agent_disconnected' });

    expect(sqlOf()).toContain('RETURNING state, suppressed_reason');
    expect(childLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: 'c-dnc', requestedState: 'pending', state: 'suppressed' }),
      expect.stringContaining('DNC'),
    );
  });

  it('T-RES6: an ordinary transition does not log a refusal', async () => {
    pool.query.mockResolvedValue({ rows: [{ state: 'pending', suppressed_reason: null }], rowCount: 1 });
    await new AgencyContactRepository().markState('c-ok', 'pending', { last_outcome: 'no_answer' });

    expect(childLog.warn).not.toHaveBeenCalled();
  });

  it('T-RES7: an `invalid` suppression is NOT frozen — the guard is compliance-only', async () => {
    // The restrictive direction has its own failure mode: freeze every suppressed
    // row and a contact suppressed for a data-quality reason can never be moved
    // by anything again. The guard is keyed on the REASON precisely so `invalid`,
    // `max_attempts` and `manual` keep whatever handling they have.
    await new AgencyContactRepository().markState('c-invalid', 'pending');
    expect(sqlOf()).not.toContain("suppressed_reason IN ('dnc'");
    expect(sqlOf(), 'the CASE names dnc and only dnc').toContain("suppressed_reason = 'dnc'");
  });
});

// ─── step 4: and the claim must refuse, independently ───────────────────────

describe('claimDialable will not hand out a DNC suppression', () => {
  it('T-RES8: the predicate excludes a dnc reason', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await new AgencyContactRepository().claimDialable('camp-1', 5);
    const sql = sqlOf();

    // Defence in depth, and it is not merely theoretical insurance: rows that are
    // `pending` AND `dnc` can ALREADY exist in production, written by exactly the
    // path above before this fix. This term takes them out of the roster the
    // moment it deploys, without a backfill.
    expect(sql).toContain("state = 'pending'");
    expect(sql).toContain('next_attempt_at <= now()');
    expect(sql).toContain("suppressed_reason IS DISTINCT FROM 'dnc'");
  });

  it('T-RES9: `IS DISTINCT FROM`, not `<>` — a NULL reason is the ordinary case', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await new AgencyContactRepository().claimDialable('camp-1', 5);

    // `suppressed_reason <> 'dnc'` is NULL for every contact that was never
    // suppressed, i.e. for the whole roster, and a NULL conjunct is not TRUE:
    // the campaign would claim nothing and stall in silence. This is the one
    // place where getting the null semantics wrong fails CLOSED so completely
    // that it looks like an empty list.
    expect(sqlOf()).not.toMatch(/suppressed_reason\s*(<>|!=)\s*'dnc'/);
  });
});

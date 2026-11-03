import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
/*
 * Harness plumbing: the connection mock targets agency's `@magick-agency/db` (and its
 * `/connection` entry, which packages/db's repositories import); the config stub
 * carries no carrier config; import specifiers per the path
 * rule (domain leaves, `@magick-agency/contracts/agency`).
 */
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
// Type-only, so it is erased at compile time and cannot load the module before the
// `vi.mock` below runs — the same reason every value import here is dynamic.
import type { AgencyReaperDeps } from '../../../src/agency/reaper.js';

// The DB pool lives in `@magick-agency/db`
// (the server's repositories import its root, packages/db's repositories `./connection`).
vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));
vi.mock('@magick-agency/db/connection', () => ({ getPool: () => getTestPool() }));

const {
  insertAgencyCampaign, insertAgencyContact, insertAgencyAttempt, insertAgentSession,
  insertManualCall, insertSoftphoneSession, noLiveAttempts,
} = await import('./agency-factories.js');
const { AgencyReaper } = await import('../../../src/agency/reaper.js');
const {
  agencyAttemptRepository, agencyContactRepository,
} = await import('../../../src/db/repositories/agency.repository.js');
const { requiresDisposition } = await import('../../../src/agency/outcome-classifier.js');
const { AUTO_DISPOSITION_CODE } = await import('../../../src/agency/disposition.js');

/**
 * ─── the SQL, WHICH THE UNIT TIER CANNOT REACH ────────────────────
 *
 * `test/unit/agency/reaper.test.ts` is thorough — 40 cases — and it mocks
 * `agencyAttemptRepository` wholesale. That is the right choice for what it tests
 * (which liveness question the sweep asks, in what order, and what it does with the
 * answer) and it means **three properties in this suite have never executed**:
 *
 * 1. `reapByIds`' `state = ANY(live)` re-guard. Against a mock, "the guarded UPDATE
 *    decides what was reaped" is asserted by making the mock *return* a subset —
 *    which proves the reaper trusts the return value, and proves nothing about
 *    whether the guard exists. Delete the `AND state = ANY(...)` clause and every
 *    unit case still passes.
 * 2. `findLapsedWrapups`' clock — `a.ended_at + make_interval(secs =>
 *    COALESCE(a.wrapup_seconds, 0) + $1) < now()` — and its two joins. A mock
 *    returns whatever rows the test hands it, so the predicate that chose them is
 *    never evaluated.
 * 3. `closeLapsedWrapup`'s guards (`disposition_code IS NULL`, the contact still parked
 *    for this attempt), same reason as (1).
 *
 * All three are the *only* thing standing between a sweep and the harm it is meant
 * to repair, and all three are pure SQL. So they get a tier that runs SQL.
 *
 * ── No dialing, no Redis, no PacingEngine, deliberately ────────────────────
 *
 * Rows are inserted directly and `AgencyReaper` is driven with `noLiveAttempts()`.
 * That is not a shortcut around the harness — the harness exists to produce *live*
 * calls, and every property here is about a row nothing is driving. Bringing a
 * dialer along would add a dial-path precondition to a test about recovery SQL, and
 * a failure would then have two candidate causes instead of one.
 */

/** `WRAPUP_LAPSE_GRACE_MS / 1000` — the reaper's own argument to the query. */
const GRACE_SECONDS = 120;

/** `LEAK_THRESHOLD_MS`, as the age a candidate must exceed. */
const LEAK_THRESHOLD_SECONDS = 5 * 60;

/** Older than the leak floor by a margin far larger than any run time. */
const WELL_PAST_LEAK_FLOOR_SECONDS = LEAK_THRESHOLD_SECONDS * 2;

/**
 * A reaper that believes nothing is alive, with per-case overrides.
 *
 * `noLiveAttempts()` is the shared "nothing on this replica" answer and is the
 * truthful one here — these rows have no dialer and no station socket. Typed against
 * `AgencyReaperDeps` rather than inferred, so a dep added to the interface is a
 * compile error at this helper instead of an `undefined` call at runtime.
 */
function reaper(deps: Partial<AgencyReaperDeps> = {}) {
  return new AgencyReaper({ ...noLiveAttempts(), ...deps });
}

/** Age a row's `created_at` by N seconds, so the leak floor is cleared. */
async function ageAttempt(attemptId: string, seconds: number) {
  await getTestPool().query(
    `UPDATE agency_call_attempts
        SET created_at = now() - make_interval(secs => $2) WHERE id = $1`,
    [attemptId, seconds],
  );
}

/**
 * A finished conversation awaiting a write-up: the exact row shape
 * `findLapsedWrapups` hunts, with every clause satisfied.
 *
 * `endedSecondsAgo` and `wrapupSeconds` are the two knobs the clock is made of, so
 * each case states them rather than inheriting a default it would then have to
 * reason about.
 */
async function conversationAwaitingWrapup(opts: {
  endedSecondsAgo: number;
  wrapupSeconds: number | null;
  campaign?: Record<string, unknown>;
  attempt?: Record<string, unknown>;
  contactState?: string;
}) {
  // Deliberately NOT `running`. `uq_agency_campaign_running` allows one running
  // campaign per account, so a case needing several campaigns cannot have them
  // all running — and it does not need to: `findLapsedWrapups` has no campaign-status
  // clause, which is correct and is asserted below. A supervisor pausing a campaign
  // must not strand a contact who is waiting for a write-up.
  const campaign = await insertAgencyCampaign({ status: 'paused', ...opts.campaign });
  const campaignId = campaign.id as string;
  const contact = await insertAgencyContact(campaignId, {
    state: opts.contactState ?? 'connected',
    attempt_count: 1,
  });
  const attempt = await insertAgencyAttempt(campaignId, contact.id as string, {
    state: 'ended',
    outcome: 'connected',
    wrapup_seconds: opts.wrapupSeconds,
    ...opts.attempt,
  });
  // The clock is written in SQL, from the database's own `now()`. Computing it in
  // JS would compare the test host's clock against Postgres's — a difference that
  // is usually zero and occasionally not, which is exactly the shape of flake that
  // teaches people to re-run instead of read.
  await getTestPool().query(
    `UPDATE agency_call_attempts
        SET bridged_at = now() - make_interval(secs => $2 + 5),
            ended_at   = now() - make_interval(secs => $2)
      WHERE id = $1`,
    [attempt.id, opts.endedSecondsAgo],
  );
  return { campaignId, contactId: contact.id as string, attemptId: attempt.id as string };
}

/**
 * ─── DIFFERENTIAL CONTROLS, AND WHY THEY ARE HERE INSTEAD OF A src FALSIFIER ──
 *
 * The normal way to prove a SQL clause is load-bearing is to delete it from `src/`,
 * watch the test red, and put it back. That is unavailable right now: another
 * engineer is mid-edit in `agency.repository.ts` and `reaper.ts`, and a falsifier in
 * a shared worktree makes the suite red for every agent in it while looking exactly
 * like the thing they are working on.
 *
 * So the clause is proven load-bearing the other way round: run the **same query
 * minus the one clause** against the **same rows**, and show the answers differ.
 * That is what the fourth pattern demands of any check — it must run on data
 * where the two definitions *could* disagree. Without a control, a passing guard
 * test cannot distinguish "the guard worked" from "no row in this fixture could have
 * been affected either way", which is the vacuity that made the first cross-check
 * worthless.
 *
 * These are controls, not assertions about the product: the product assertions are
 * the ones calling `agencyAttemptRepository`. If a clause is ever deleted from
 * `src/`, those reds — the control is what proves those assertions were never
 * vacuous to begin with.
 */
const UNGUARDED_REAP_SQL = `
  UPDATE agency_call_attempts
     SET state = 'ended', outcome = 'orphaned', ended_at = now()
   WHERE id = ANY($1::uuid[])
  RETURNING id`;

/** `findLapsedWrapups`' clock with the COALESCE stripped out. */
const UNCOALESCED_CLOCK_SQL = `
  SELECT a.id FROM agency_call_attempts a
   WHERE a.id = ANY($1::uuid[])
     AND a.ended_at + make_interval(secs => a.wrapup_seconds + $2) < now()`;

async function attemptRow(id: string) {
  const { rows } = await getTestPool().query(
    `SELECT state, outcome, disposition_code, dispositioned_at, dispositioned_by_user_id, ended_at
       FROM agency_call_attempts WHERE id = $1`, [id],
  );
  return rows[0]!;
}

async function contactRow(id: string) {
  const { rows } = await getTestPool().query(
    `SELECT state, last_outcome, last_disposition, attempt_count FROM agency_contacts WHERE id = $1`,
    [id],
  );
  return rows[0]!;
}

beforeEach(truncateAll);
afterAll(closeTestPool);

// ═══════════════════════════════════════════════════════════════════════════
// (1) The re-guard, driven through the real race window.
// ═══════════════════════════════════════════════════════════════════════════

describe('reapByIds re-guards on state, in SQL', () => {
  /**
   * The window is real and narrow: `sweepOnce` SELECTs candidates, then asks Redis
   * about each one's agent, then UPDATEs. An attempt that settles normally during
   * that gap is already terminal by the time the UPDATE runs.
   *
   * **Driven by settling a row inside `ownerOf`, which IS the gap.** Not a
   * contrivance — `isAgentHeldSomewhere` is the only awaited call between the SELECT
   * and the write, so it is precisely where a concurrent settle lands. Faking the
   * race by calling `reapByIds` directly would test the same SQL but would not prove
   * the window is where the reaper actually leaves it.
   *
   * What the guard prevents is not merely a wrong `outcome`. It is
   * `requeueOrphanedContact` running for a call that **connected** — returning a
   * customer who has just been spoken to back to the roster to be called again,
   * behind an audit trail reading `orphaned`. That is the assertion that matters
   * and it is the one a state-only check would miss.
   */
  it('leaves an attempt that settled mid-sweep alone, and does not requeue its contact', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const campaignId = campaign.id as string;
    const session = await insertAgentSession(campaignId);
    const sessionId = session.id as string;

    // Two aged, unowned, non-terminal attempts. Both will be judged leaked.
    const settling = await (async () => {
      const c = await insertAgencyContact(campaignId, { state: 'in_flight' });
      const a = await insertAgencyAttempt(campaignId, c.id as string, {
        state: 'bridged', reserved_agent_id: sessionId,
      });
      await ageAttempt(a.id as string, WELL_PAST_LEAK_FLOOR_SECONDS);
      return { contactId: c.id as string, attemptId: a.id as string };
    })();
    const genuinelyLeaked = await (async () => {
      const c = await insertAgencyContact(campaignId, { state: 'in_flight', source_row_number: 2 });
      const a = await insertAgencyAttempt(campaignId, c.id as string, {
        state: 'dialing', reserved_agent_id: sessionId, attempt_number: 1,
      });
      await ageAttempt(a.id as string, WELL_PAST_LEAK_FLOOR_SECONDS);
      return { contactId: c.id as string, attemptId: a.id as string };
    })();

    let settledDuringSweep = false;
    const r = reaper({
      ownerOf: async () => {
        // The concurrent settle, landing in the gap. Once only — a second call must
        // not re-settle, or the test would be describing a loop rather than a race.
        if (!settledDuringSweep) {
          settledDuringSweep = true;
          await getTestPool().query(
            `UPDATE agency_call_attempts
                SET state = 'ended', outcome = 'connected', ended_at = now() WHERE id = $1`,
            [settling.attemptId],
          );
          await getTestPool().query(
            `UPDATE agency_contacts SET state = 'connected', last_outcome = 'connected' WHERE id = $1`,
            [settling.contactId],
          );
        }
        return null; // nobody holds the station — both look leaked
      },
    });

    const reaped = await r.sweepOnce();

    // The settle really did happen inside the sweep, or this proves nothing.
    expect(settledDuringSweep, 'ownerOf was never consulted — the race window was not entered').toBe(true);

    // EXACTLY one, not "at least one": the count is the whole claim. The sweep
    // believed two were leaked and the SQL corrected it.
    expect(reaped).toBe(1);

    const settled = await attemptRow(settling.attemptId);
    expect(settled['outcome'], 'the guard let the sweep overwrite a real outcome').toBe('connected');
    expect(settled['state']).toBe('ended');

    const swept = await attemptRow(genuinelyLeaked.attemptId);
    expect(swept['state']).toBe('ended');
    expect(swept['outcome']).toBe('orphaned');

    // ── The harm, asserted where it lands ─────────────────────────────────
    // A connected customer must not be returned to the roster. This is what the
    // guard is actually for; the `outcome` column is just where the damage shows.
    const keptContact = await contactRow(settling.contactId);
    expect(
      keptContact['state'],
      'a customer who had just connected was requeued for another call',
    ).toBe('connected');
    expect(keptContact['last_outcome']).toBe('connected');

    // …while the genuinely leaked one IS returned, so this is not passing by
    // simply never requeueing anything.
    const requeued = await contactRow(genuinelyLeaked.contactId);
    expect(requeued['state']).toBe('pending');
    expect(requeued['last_outcome']).toBe('orphaned');
    // And without consuming the retry allowance — our crash is not the customer's.
    expect(requeued['attempt_count']).toBe(0);

    // ── CONTROL: the same write without the guard DOES overwrite ───────────
    // Proves the assertions above were not vacuous — this fixture genuinely
    // contains a row the guard is the only thing protecting. Run last, so it
    // cannot affect anything asserted before it.
    const { rows: unguarded } = await getTestPool().query(
      UNGUARDED_REAP_SQL, [[settling.attemptId]],
    );
    expect(
      unguarded,
      'the unguarded UPDATE changed nothing either — this fixture cannot tell a guarded write from an unguarded one, so the assertions above prove nothing',
    ).toHaveLength(1);
    expect((await attemptRow(settling.attemptId))['outcome']).toBe('orphaned');
  });

  /**
   * The guard's live-state set is a shared constant, and the reap must cover every
   * member of it. Asserted by reaping one attempt in each live state at once rather
   * than by importing the constant and looping — a test that iterated the constant
   * would agree with it by construction, including if a state were removed from it.
   */
  it('reaps every live state and nothing terminal', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const campaignId = campaign.id as string;
    const ids: Record<string, string> = {};
    let row = 0;
    for (const state of ['queued', 'dialing', 'ringing', 'answered', 'bridged', 'ended']) {
      const c = await insertAgencyContact(campaignId, { state: 'in_flight', source_row_number: ++row });
      const a = await insertAgencyAttempt(campaignId, c.id as string, {
        state, ...(state === 'ended' ? { outcome: 'connected' } : {}),
      });
      ids[state] = a.id as string;
      await ageAttempt(a.id as string, WELL_PAST_LEAK_FLOOR_SECONDS);
    }

    const reaped = await agencyAttemptRepository.reapByIds(Object.values(ids));

    // Five live states in, five out. Exact, because "at least five" would pass
    // against a guard that also swallowed the terminal row.
    expect(reaped).toHaveLength(5);
    expect(reaped.map((a) => a.id).sort()).toEqual(
      ['queued', 'dialing', 'ringing', 'answered', 'bridged'].map((s) => ids[s]!).sort(),
    );
    // The terminal row was handed in and refused.
    expect((await attemptRow(ids['ended']!))['outcome']).toBe('connected');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (2) The lapsed-wrap-up clock. Every term of it.
// ═══════════════════════════════════════════════════════════════════════════

describe('findLapsedWrapups clock', () => {
  /**
   * `wrapup_seconds` is read **off the attempt**, not off the campaign's current
   * config — an operator shortening the window mid-shift must not retroactively
   * expire wrap-ups that were promised longer.
   *
   * Two rows, one `ended_at`, different per-row windows. The margins are derived
   * from the constants and are enormous relative to any run time (200s elapsed
   * against thresholds of 150s and 720s), so this is an arithmetic assertion and
   * not a clock race. A query using a fixed window instead of `a.wrapup_seconds`
   * would return both rows or neither.
   */
  it('honours each row own wrapup_seconds, not a shared constant', async () => {
    const short = await conversationAwaitingWrapup({ endedSecondsAgo: 200, wrapupSeconds: 30 });
    const long = await conversationAwaitingWrapup({ endedSecondsAgo: 200, wrapupSeconds: 600 });

    const rows = await agencyAttemptRepository.findLapsedWrapups(GRACE_SECONDS);
    const found = rows.map((r) => r.id);

    // 30 + 120 = 150 < 200 -> lapsed.
    expect(found).toContain(short.attemptId);
    // 600 + 120 = 720 > 200 -> the agent still has time.
    expect(found).not.toContain(long.attemptId);
    expect(rows).toHaveLength(1);
  });

  /**
   * `COALESCE(a.wrapup_seconds, 0)` — and the column is genuinely nullable
   * (`075_agency_attempts.sql:33`, `INTEGER` with no default), so this is a real row
   * shape rather than a defensive flourish.
   *
   * Without the COALESCE the arithmetic is `ended_at + NULL`, which is NULL, and
   * `NULL < now()` is NULL — not false, NULL. The row is therefore **silently
   * excluded forever**: its contact stays parked in `connected`, the campaign can
   * never reach `completed`, and no error is raised anywhere. That is the 5pm-laptop
   * failure re-entering through a column nobody set.
   */
  it('treats a NULL wrapup_seconds as zero rather than silently stranding the row', async () => {
    const nullWrapup = await conversationAwaitingWrapup({ endedSecondsAgo: 130, wrapupSeconds: null });

    const rows = await agencyAttemptRepository.findLapsedWrapups(GRACE_SECONDS);

    // 0 + 120 = 120 < 130 -> lapsed. A NULL-propagating predicate returns nothing.
    expect(
      rows.map((r) => r.id),
      'a NULL wrapup_seconds row is invisible to the sweep and its contact is stranded forever',
    ).toContain(nullWrapup.attemptId);

    // ── CONTROL: the same clock without COALESCE cannot see this row ───────
    // `ended_at + NULL` is NULL and `NULL < now()` is NULL — not false, NULL — so
    // the row is silently excluded with no error anywhere. This is what makes the
    // assertion above load-bearing rather than a restatement of the fixture.
    const { rows: uncoalesced } = await getTestPool().query(
      UNCOALESCED_CLOCK_SQL, [[nullWrapup.attemptId], GRACE_SECONDS],
    );
    expect(
      uncoalesced,
      'the uncoalesced clock matched this row too — the fixture does not actually have a NULL wrapup_seconds, so the COALESCE is untested',
    ).toHaveLength(0);
  });

  /**
   * The grace is genuinely added, not decorative.
   *
   * `wrapup_seconds: 0` isolates it: the row ended 60s ago, so a query that ignored
   * the grace would treat it as lapsed the instant the wrap-up window closed —
   * beating an agent who is legitimately still typing, and racing the sweep against
   * a disposition landing in the same minute.
   */
  it('adds the grace on top of the promised window', async () => {
    const justClosed = await conversationAwaitingWrapup({ endedSecondsAgo: 60, wrapupSeconds: 0 });
    expect((await agencyAttemptRepository.findLapsedWrapups(GRACE_SECONDS)).map((r) => r.id))
      .not.toContain(justClosed.attemptId);

    // Same row, past the grace: 0 + 120 = 120 < 130.
    await getTestPool().query(
      `UPDATE agency_call_attempts SET ended_at = now() - make_interval(secs => 130) WHERE id = $1`,
      [justClosed.attemptId],
    );
    expect((await agencyAttemptRepository.findLapsedWrapups(GRACE_SECONDS)).map((r) => r.id))
      .toContain(justClosed.attemptId);
  });

  /**
   * Each disqualifying clause, one row at a time.
   *
   * Separate assertions rather than one "returns only the control row", because a
   * single count assertion tells you the predicate broke and not which clause — and
   * these five clauses protect five different things (a record of what was said to a
   * customer, a contact some other path already released, a call that never bridged).
   */
  it('excludes rows on each load-bearing clause independently', async () => {
    const control = await conversationAwaitingWrapup({ endedSecondsAgo: 200, wrapupSeconds: 30 });
    const alreadyWrittenUp = await conversationAwaitingWrapup({
      endedSecondsAgo: 200, wrapupSeconds: 30, attempt: { disposition_code: 'promise_to_pay' },
    });
    const neverBridged = await conversationAwaitingWrapup({
      endedSecondsAgo: 200, wrapupSeconds: 30,
    });
    await getTestPool().query(
      `UPDATE agency_call_attempts SET bridged_at = NULL WHERE id = $1`, [neverBridged.attemptId],
    );
    const contactMovedOn = await conversationAwaitingWrapup({
      endedSecondsAgo: 200, wrapupSeconds: 30, contactState: 'completed',
    });
    const notConnected = await conversationAwaitingWrapup({
      endedSecondsAgo: 200, wrapupSeconds: 30, attempt: { outcome: 'no_answer' },
    });
    const stillLive = await conversationAwaitingWrapup({ endedSecondsAgo: 200, wrapupSeconds: 30 });
    await getTestPool().query(
      `UPDATE agency_call_attempts SET state = 'bridged' WHERE id = $1`, [stillLive.attemptId],
    );

    const found = (await agencyAttemptRepository.findLapsedWrapups(GRACE_SECONDS)).map((r) => r.id);

    expect(found, 'the control row is not returned — the predicate is broken outright')
      .toContain(control.attemptId);
    expect(found, 'revisited a row that already carries a record of what was said to a customer')
      .not.toContain(alreadyWrittenUp.attemptId);
    expect(found, 'swept a call whose media never joined the two parties')
      .not.toContain(neverBridged.attemptId);
    expect(found, 'swept a contact some other path had already released')
      .not.toContain(contactMovedOn.attemptId);
    expect(found, 'swept an attempt that was never a conversation')
      .not.toContain(notConnected.attemptId);
    expect(found, 'swept an attempt that is still live').not.toContain(stillLive.attemptId);
    expect(found).toHaveLength(1);
  });

  /**
   * The sweep is campaign-status-agnostic, and that is a requirement rather than an
   * omission.
   *
   * Found while writing this file: `uq_agency_campaign_running` allows one running
   * campaign per account, which forced the fixtures onto `paused` — and that
   * turned out to be the more interesting state to test in. **A supervisor pausing
   * or stopping a campaign must not strand a contact who is mid-wrap-up.** Pausing
   * stops new dials; it says nothing about the conversation that just happened, and
   * the agent who was in it may well have closed their laptop precisely *because*
   * the campaign stopped. A status filter here would park those contacts in
   * `connected` forever and the campaign could never reach `completed`.
   *
   * Asserted across all four statuses at once so a filter added for any one of them
   * reds, rather than only for whichever one a fixture happened to use.
   */
  it('sweeps a lapsed wrap-up whatever the campaign status — a pause must not strand a contact', async () => {
    const ids: string[] = [];
    for (const status of ['draft', 'paused', 'stopped', 'completed']) {
      ids.push((await conversationAwaitingWrapup({
        endedSecondsAgo: 200, wrapupSeconds: 30, campaign: { status },
      })).attemptId);
    }

    const found = (await agencyAttemptRepository.findLapsedWrapups(GRACE_SECONDS)).map((r) => r.id);
    for (const id of ids) {
      expect(found, 'a campaign status filter is stranding contacts mid-wrap-up').toContain(id);
    }
  });

  /**
   * The joined columns the caller cannot proceed without.
   *
   * `sweepLapsedWrapups` reads all three off this row, and a missing one fails in a
   * different and quieter way each time: an absent catalog makes
   * `requiresDisposition` return true and auto-dispositions everything (see below);
   * an absent `retry_policy` sends the contact somewhere the campaign did not ask
   * for; an absent `attempt_count` makes the retry arithmetic wrong by the whole
   * value. So the projection is asserted, not assumed.
   */
  it('carries the campaign catalog, the retry policy and the contact retry budget', async () => {
    const { attemptId } = await conversationAwaitingWrapup({
      endedSecondsAgo: 200,
      wrapupSeconds: 30,
      campaign: {
        disposition_catalog: JSON.stringify([{ code: 'promise_to_pay', label: 'Promise to pay' }]),
        retry_policy: JSON.stringify({ connected: { max_attempts: 0 } }),
      },
    });

    const [row] = await agencyAttemptRepository.findLapsedWrapups(GRACE_SECONDS);
    expect(row!.id).toBe(attemptId);
    expect(row!.campaign_disposition_catalog).toEqual([{ code: 'promise_to_pay', label: 'Promise to pay' }]);
    expect(row!.campaign_retry_policy).toEqual({ connected: { max_attempts: 0 } });
    // The CONTACT's budget, not the attempt's `attempt_number` — the two were
    // deliberately decoupled and the policy reads the budget.
    expect(row!.contact_attempt_count).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (3) The sweep end to end, and the argument that must never be defaulted.
// ═══════════════════════════════════════════════════════════════════════════

describe('the sweep against real SQL', () => {
  it('stamps no_disposition, attributes it to nobody, and releases the contact', async () => {
    const { attemptId, contactId } = await conversationAwaitingWrapup({
      endedSecondsAgo: 200,
      wrapupSeconds: 30,
      campaign: {
        disposition_catalog: JSON.stringify([{ code: 'promise_to_pay', label: 'Promise to pay' }]),
      },
    });

    expect(await reaper().sweepLapsedWrapups()).toBe(1);

    const attempt = await attemptRow(attemptId);
    expect(attempt['disposition_code']).toBe(AUTO_DISPOSITION_CODE);
    expect(attempt['dispositioned_at']).not.toBeNull();
    // Nobody recorded this, which is the entire meaning of the code. Putting the
    // reserved agent's name on it would attribute an admission they did not make.
    expect(attempt['dispositioned_by_user_id']).toBeNull();

    const contact = await contactRow(contactId);
    // `connected` has `max_attempts: 0` in the default policy, so the policy says
    // terminal-not-retryable -> `completed`.
    expect(contact['state']).toBe('completed');
    expect(contact['last_disposition']).toBe(AUTO_DISPOSITION_CODE);
    // NOT bumped: the attempt was counted when it ended, and bumping here would
    // charge a contact twice for one dial.
    expect(contact['attempt_count']).toBe(1);
  });

  /**
   * ─── THE ARGUMENT THAT MUST NEVER BE DEFAULTED ──────────────────────────
   *
   * `requiresDisposition(outcome, undefined)` returns **true** — the optional
   * parameter preserves the original answer for a caller with no campaign in
   * hand. So the reaper omitting or defaulting that argument would auto-disposition
   * **every** campaign, including those that never asked for one: recording an
   * agent's failure to do something nobody required of them, and poisoning the
   * retry decision that reads `last_disposition`.
   *
   * The hazard is pinned mechanically as well as behaviourally, because the
   * behavioural half alone cannot distinguish "the catalog was passed" from "the
   * catalog happened to be non-empty". Both assertions together are what make the
   * argument's presence load-bearing rather than incidental.
   */
  it('never lets the catalog default — an unconfigured campaign gets NO code', async () => {
    // The hazard itself, as a fact about the function rather than a claim in a
    // comment. If this ever returns false, the reaper's explicit `?? []` stops
    // being load-bearing and this whole case stops testing anything.
    expect(
      requiresDisposition('connected', undefined),
      'requiresDisposition no longer defaults to true — re-derive whether the reaper still needs its explicit catalog',
    ).toBe(true);
    expect(requiresDisposition('connected', [])).toBe(false);

    // `disposition_catalog` is `JSONB NOT NULL DEFAULT '[]'`, so an
    // unconfigured campaign is the ORDINARY case, not an edge case.
    const { attemptId, contactId } = await conversationAwaitingWrapup({
      endedSecondsAgo: 200, wrapupSeconds: 30,
    });

    // Still swept — the contact needs the same rescue either way. The harm being
    // repaired is a contact parked in `connected` forever, and that is identical
    // whether or not a disposition was ever owed.
    expect(await reaper().sweepLapsedWrapups()).toBe(1);

    const attempt = await attemptRow(attemptId);
    expect(
      attempt['disposition_code'],
      'an unconfigured campaign was auto-dispositioned — the catalog argument defaulted',
    ).toBeNull();

    const contact = await contactRow(contactId);
    expect(contact['state']).toBe('completed');
    expect(contact['last_disposition'], 'wrote a disposition nobody asked for').toBeNull();
  });

  /**
   * The sweep is bounded, and the bound is not a suggestion.
   *
   * `limit = 500` by default. Asserted at a small explicit limit rather than by
   * inserting 501 rows: the property is that the caller's limit reaches the SQL, and
   * proving that at 2 costs three inserts instead of five hundred.
   */
  it('respects the limit, oldest-ended first', async () => {
    const created: string[] = [];
    for (const endedSecondsAgo of [400, 300, 200]) {
      created.push((await conversationAwaitingWrapup({ endedSecondsAgo, wrapupSeconds: 30 })).attemptId);
    }

    const limited = await agencyAttemptRepository.findLapsedWrapups(GRACE_SECONDS, 2);
    expect(limited).toHaveLength(2);
    // `ORDER BY a.ended_at` — the longest-stranded contacts are freed first, which
    // is the only ordering that keeps a backlog from starving the oldest rows.
    expect(limited.map((r) => r.id)).toEqual([created[0], created[1]]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (3b) The sweep writes only while the row is still what it read.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `sweepLapsedWrapups` reads with `findLapsedWrapups` and then writes, row by row. Each
 * case moves the attempt or its contact on INSIDE that window (run after the real
 * `findLapsedWrapups` returns and before the sweep's write), with the real writes the
 * moving path makes. The write must land on nothing and count nothing.
 *
 * Before the fix the arm that owed no disposition wrote the contact with an unconditional
 * `markState`, and the owed arm's stamp was guarded but its contact write was not: (a) and
 * (b) put a contact with a live call back to `completed`, (c) stamped an attempt and wrote
 * a suppressed contact, (d) wrote over a contact the agent's write-up was releasing.
 * Mutation-checked: dropping the newest-attempt clause from `closeLapsedWrapup` reds (b);
 * dropping `ct.state = 'connected'` reds (c); dropping `a.disposition_code IS NULL` reds (d).
 */
describe('a lapsed-wrap-up close writes only while the row is still what the sweep read', () => {
  /** Run `between` after the sweep's real `findLapsedWrapups` and before its write. */
  function interleaveAfterRead(between: () => Promise<void>) {
    const real = agencyAttemptRepository.findLapsedWrapups.bind(agencyAttemptRepository);
    return vi.spyOn(agencyAttemptRepository, 'findLapsedWrapups').mockImplementationOnce(async (...args) => {
      const rows = await real(...args);
      expect(rows.length, 'the read found nothing: the case would be vacuous').toBe(1);
      await between();
      return rows;
    });
  }

  async function sweepWith(between: () => Promise<void>): Promise<number> {
    const spy = interleaveAfterRead(between);
    try {
      return await reaper().sweepLapsedWrapups();
    } finally {
      spy.mockRestore();
    }
  }

  /** Pacing's own claim and attempt insert, as one tick runs them. */
  async function pacingRedials(campaignId: string, contactId: string): Promise<string> {
    const claimed = await agencyContactRepository.claimDialable(campaignId, 10);
    expect(claimed.map((c) => c.id)).toEqual([contactId]);
    const session = (await insertAgentSession(campaignId)).id as string;
    const attempt = await agencyAttemptRepository.create({
      campaignId, contactId, tenantId: claimed[0]!.tenant_id, accountId: claimed[0]!.account_id,
      callerId: '+919000000001', reservedAgentId: session,
    });
    expect(attempt, 'the live-attempt index refused the redial').not.toBeNull();
    await agencyAttemptRepository.setState(attempt!.id, 'dialing', { dialed_at: new Date() });
    return attempt!.id;
  }

  async function contactAfter(id: string) {
    const { rows } = await getTestPool().query<{
      state: string; last_outcome: string | null; last_disposition: string | null; attempt_count: number;
    }>('SELECT state, last_outcome, last_disposition, attempt_count FROM agency_contacts WHERE id = $1', [id]);
    return rows[0]!;
  }

  const CATALOG = JSON.stringify([{ code: 'callback', label: 'Call back' }]);

  it('(a) no disposition owed: leaves a contact the agent released and pacing re-claimed `in_flight` under its new call', async () => {
    const w = await conversationAwaitingWrapup({
      endedSecondsAgo: 200, wrapupSeconds: 30, campaign: { status: 'running' },
    });
    let newAttemptId = '';
    const closed = await sweepWith(async () => {
      // Released (a callback due now), then claimed and dialled again by pacing.
      await agencyContactRepository.markState(w.contactId, 'pending', { next_attempt_at: new Date(Date.now() - 1000) });
      newAttemptId = await pacingRedials(w.campaignId, w.contactId);
    });

    expect(closed).toBe(0);
    expect(await contactAfter(w.contactId), 'the contact of a live call was taken off it').toMatchObject({
      state: 'in_flight', last_outcome: null, attempt_count: 1,
    });
    expect((await attemptRow(newAttemptId))['state']).toBe('dialing');
    expect((await attemptRow(w.attemptId))['disposition_code']).toBeNull();
    // Nothing can claim it while its call is live.
    expect(await agencyContactRepository.claimDialable(w.campaignId, 10)).toEqual([]);
  });

  it('(b) leaves a contact a NEWER call has parked `connected` for its own write-up', async () => {
    const w = await conversationAwaitingWrapup({
      endedSecondsAgo: 200, wrapupSeconds: 30, campaign: { status: 'running' },
    });
    let newAttemptId = '';
    const closed = await sweepWith(async () => {
      await agencyContactRepository.markState(w.contactId, 'pending', { next_attempt_at: new Date(Date.now() - 1000) });
      newAttemptId = await pacingRedials(w.campaignId, w.contactId);
      // The new call bridged: the dialer parks the contact for ITS write-up.
      await agencyAttemptRepository.setState(newAttemptId, 'bridged', { bridged_at: new Date() });
      await agencyContactRepository.markState(w.contactId, 'connected');
    });

    expect(closed).toBe(0);
    expect(await contactAfter(w.contactId), 'a live conversation\'s contact was released').toMatchObject({
      state: 'connected', last_outcome: null,
    });
    expect((await attemptRow(newAttemptId))['state']).toBe('bridged');
  });

  it('(c) disposition owed: stamps nothing and writes nothing on a contact suppressed DNC meanwhile', async () => {
    const w = await conversationAwaitingWrapup({
      endedSecondsAgo: 200, wrapupSeconds: 30, campaign: { disposition_catalog: CATALOG },
    });
    const { rows: [contact] } = await getTestPool().query<{ phone_e164: string }>(
      'SELECT phone_e164 FROM agency_contacts WHERE id = $1', [w.contactId]);
    const closed = await sweepWith(async () => {
      await agencyContactRepository.suppressByPhone(w.campaignId, contact!.phone_e164, 'dnc');
    });

    expect(closed).toBe(0);
    expect((await attemptRow(w.attemptId))['disposition_code']).toBeNull();
    expect(await contactAfter(w.contactId)).toMatchObject({ state: 'suppressed', last_disposition: null, last_outcome: null });
  });

  it('(d) disposition owed: loses to the agent\'s real write-up landing in the window, and writes nothing over it', async () => {
    const w = await conversationAwaitingWrapup({
      endedSecondsAgo: 200, wrapupSeconds: 30, campaign: { disposition_catalog: CATALOG },
    });
    const closed = await sweepWith(async () => {
      // The disposition route's first statement; its contact write comes after the sweep's.
      const recorded = await agencyAttemptRepository.recordDisposition({
        attemptId: w.attemptId, dispositionCode: 'callback', notes: null, callbackAt: null,
        actorUserId: '6c1d0c8e-3d0e-4c7a-8b44-00000000b001', onBehalf: false,
      });
      expect(recorded).not.toBeNull();
    });

    expect(closed).toBe(0);
    expect((await attemptRow(w.attemptId))['disposition_code'], 'a record of what was said to a customer was overwritten')
      .toBe('callback');
    // The route releases the contact itself; the sweep wrote nothing for it to contradict.
    expect(await contactAfter(w.contactId)).toMatchObject({ state: 'connected', last_disposition: null, last_outcome: null });
  });

  /** The control: nothing moved, so the same sweep closes it. */
  it('still closes a wrap-up nothing moved on', async () => {
    const w = await conversationAwaitingWrapup({
      endedSecondsAgo: 200, wrapupSeconds: 30, campaign: { disposition_catalog: CATALOG },
    });
    expect(await sweepWith(async () => {})).toBe(1);
    expect((await attemptRow(w.attemptId))['disposition_code']).toBe(AUTO_DISPOSITION_CODE);
    expect(await contactAfter(w.contactId)).toMatchObject({
      state: 'completed', last_outcome: 'connected', last_disposition: AUTO_DISPOSITION_CODE, attempt_count: 1,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (4) Contacts stranded `in_flight` behind terminal attempts.
// ═══════════════════════════════════════════════════════════════════════════

describe('findStrandedInFlight and the stranded-contact sweep', () => {
  /** Written at INSERT, which the `updated_at` triggers (BEFORE UPDATE) leave alone. */
  const LONG_AGO = () => new Date(Date.now() - 60 * 60_000);
  const CUTOFF = () => new Date(Date.now() - LEAK_THRESHOLD_SECONDS * 1000);

  async function campaign() {
    return (await insertAgencyCampaign({ status: 'paused' })).id as string;
  }

  it('finds a contact behind an ended attempt, or behind none, and nothing that may still be settling', async () => {
    const campaignId = await campaign();
    const contact = (overrides: Record<string, unknown> = {}) =>
      insertAgencyContact(campaignId, { state: 'in_flight', updated_at: LONG_AGO(), ...overrides });

    const behindEnded = await contact();
    await insertAgencyAttempt(campaignId, behindEnded.id as string, {
      state: 'ended', outcome: 'no_answer', updated_at: LONG_AGO(),
    });
    const behindNothing = await contact();

    // Each of these differs from `behindEnded` in one clause.
    const behindLive = await contact();
    await insertAgencyAttempt(campaignId, behindLive.id as string, { state: 'bridged', updated_at: LONG_AGO() });
    const freshlyClaimed = await contact({ updated_at: new Date() });
    const justEnded = await contact();
    await insertAgencyAttempt(campaignId, justEnded.id as string, { state: 'ended', outcome: 'no_answer' });
    const pending = await contact({ state: 'pending' });

    const found = await agencyContactRepository.findStrandedInFlight(CUTOFF());
    expect(found.map((r) => r.id).sort()).toEqual([behindEnded.id, behindNothing.id].sort());
    expect(found[0]).toMatchObject({ tenant_id: expect.any(String), campaign_id: campaignId });
    for (const excluded of [behindLive, freshlyClaimed, justEnded, pending]) {
      expect(found.map((r) => r.id)).not.toContain(excluded.id);
    }
  });

  it('requeues on the our-fault ledger and keeps a DNC-suppressed contact suppressed', async () => {
    const campaignId = await campaign();
    const stranded = await insertAgencyContact(campaignId, {
      state: 'in_flight', updated_at: LONG_AGO(), attempt_count: 1,
    });
    await insertAgencyAttempt(campaignId, stranded.id as string, {
      state: 'ended', outcome: 'busy', updated_at: LONG_AGO(),
    });
    // Marked DNC mid-call: `markState` keeps it suppressed, whatever the requeue asks.
    const dnc = await insertAgencyContact(campaignId, {
      state: 'in_flight', updated_at: LONG_AGO(), suppressed_reason: 'dnc',
    });

    expect(await reaper().sweepStrandedContacts()).toBe(2);

    const { rows } = await getTestPool().query(
      `SELECT id, state, last_outcome, attempt_count, our_fault_attempts FROM agency_contacts
        WHERE id = ANY($1::uuid[])`,
      [[stranded.id, dnc.id]],
    );
    const byId = new Map(rows.map((r: any) => [r.id, r]));
    expect(byId.get(stranded.id)).toMatchObject({
      state: 'pending', last_outcome: 'orphaned', attempt_count: 1, our_fault_attempts: 1,
    });
    expect(byId.get(dnc.id)!.state).toBe('suppressed');

    // Requeued once: `pending` is not `in_flight`, so a second sweep finds nothing.
    expect(await reaper().sweepStrandedContacts()).toBe(0);
  });

  /**
   * The contact of a dial whose outcome is unknown is held 15 minutes by one write
   * (`holdOutcomeUnknownContact`, or the soft phone's settle). When that write fails the
   * contact stays `in_flight`, and this sweep finds it after 5 minutes. It requeued it with
   * no hold, cutting the 15 minutes to about 5 while the carrier may still ring the
   * customer. The requeue now reads the contact's own dials, in the same statement, and
   * keeps any sent and never answered (and not ended by a carrier answer) until `dialed_at`
   * + 15 min. `dialed_at` is written at INSERT (an UPDATE would move the rows' `updated_at`
   * and hide them from the sweep) and the hold is read back against it in SQL.
   */
  it('keeps the outcome-unknown hold of a contact whose hold write failed: not dialable before dialed_at + 15 min', async () => {
    const campaignId = await campaign();
    const DELAY_SECONDS = 15 * 60;
    const ago = (seconds: number) => new Date(Date.now() - seconds * 1000);
    /** An `in_flight` contact behind one ended dial `dialedSecondsAgo` back. */
    const strandedBehind = async (attempt: Record<string, unknown>, dialedSecondsAgo: number, answered = false) => {
      const c = await insertAgencyContact(campaignId, { state: 'in_flight', updated_at: LONG_AGO() });
      await insertAgencyAttempt(campaignId, c.id as string, {
        state: 'ended', updated_at: LONG_AGO(), dialed_at: ago(dialedSecondsAgo),
        ...(answered ? { answered_at: ago(dialedSecondsAgo - 2) } : {}),
        ...attempt,
      });
      return c.id as string;
    };
    // The dialer's own outcome-unknown dial (`failed`), and a teardown that raced one (`canceled`).
    const unknown = await strandedBehind({ outcome: 'failed' }, 6 * 60);
    const raced = await strandedBehind({ outcome: 'canceled' }, 6 * 60);
    // Not held: the carrier answered it (no answer), it was answered, or its hold has run out.
    const noAnswer = await strandedBehind({ outcome: 'no_answer' }, 6 * 60);
    const answered = await strandedBehind({ outcome: 'failed' }, 6 * 60, true);
    const longAgo = await strandedBehind({ outcome: 'failed' }, DELAY_SECONDS + 60);
    // A soft-phone call that claimed the contact, dialled with its outcome unknown, settled,
    // and whose contact settle failed (the lapse sweep's catch leaves it to this sweep).
    const softphone = await insertAgencyContact(campaignId, { state: 'in_flight', updated_at: LONG_AGO() });
    const session = await insertSoftphoneSession();
    const manual = await insertManualCall(session, {
      campaign_id: campaignId, contact_id: softphone.id, contact_claimed: true, contact_prior_state: 'pending',
      state: 'ended', outcome: 'failed', ended_at: LONG_AGO(), settled_at: LONG_AGO(), dialed_at: ago(6 * 60),
    });
    expect(manual.id).toBeTruthy();

    expect(await reaper().sweepStrandedContacts()).toBe(6);

    const { rows } = await getTestPool().query<{ id: string; state: string; our_fault_attempts: number; after_dial: number | null; from_now: number }>(
      `SELECT c.id, c.state, c.our_fault_attempts,
              EXTRACT(EPOCH FROM c.next_attempt_at - COALESCE(
                (SELECT max(a.dialed_at) FROM agency_call_attempts a WHERE a.contact_id = c.id),
                (SELECT max(m.dialed_at) FROM agency_manual_calls m WHERE m.contact_id = c.id)))::float8 AS after_dial,
              EXTRACT(EPOCH FROM c.next_attempt_at - now())::float8 AS from_now
         FROM agency_contacts c WHERE c.campaign_id = $1`,
      [campaignId],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of [unknown, raced, softphone.id as string]) {
      const r = byId.get(id)!;
      expect({ state: r.state, ourFault: r.our_fault_attempts }).toEqual({ state: 'pending', ourFault: 1 });
      expect(r.after_dial, 'dialable before the outcome-unknown hold ran out').toBeCloseTo(DELAY_SECONDS, 0);
    }
    for (const id of [noAnswer, answered, longAgo]) {
      const r = byId.get(id)!;
      expect({ state: r.state, ourFault: r.our_fault_attempts }).toEqual({ state: 'pending', ourFault: 1 });
      expect(r.from_now).toBeLessThanOrEqual(1);
      expect(r.from_now).toBeGreaterThan(-60);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (5) A reaped dial whose outcome is unknown is not redialled early.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A process that died with a dial sent and no answer recorded (a media worker killed with
 * `add_lead` in flight or the phone ringing; the whole server after a crash) may have left
 * the carrier dialling the customer. The dial path's rule for an outcome-unknown
 * `add_lead` applies (`DIAL_OUTCOME_UNKNOWN_REDIAL_DELAY_MS`): the contact is requeued, but
 * not dialable until that long after `dialed_at`. A dial never sent, or one answered, is
 * dialable at once as before.
 *
 * The clock is the database's: each `dialed_at` is written in SQL and each assertion reads
 * `next_attempt_at - dialed_at` (or `- now()`) in SQL.
 */
describe('a reaped dial with an unknown outcome is not redialled before the carrier rule allows', () => {
  const DELAY_SECONDS = 15 * 60;

  /** One attempt per shape, reserved to `sessionId`, with its contact `in_flight`. */
  async function shapes(campaignId: string, sessionId: string) {
    const make = async (row: number, attempt: Record<string, unknown>, dialedSecondsAgo: number | null, answered: boolean) => {
      const c = await insertAgencyContact(campaignId, { state: 'in_flight', source_row_number: row });
      const a = await insertAgencyAttempt(campaignId, c.id as string, { reserved_agent_id: sessionId, ...attempt });
      if (dialedSecondsAgo !== null) {
        await getTestPool().query(
          `UPDATE agency_call_attempts
              SET dialed_at = now() - make_interval(secs => $2),
                  answered_at = CASE WHEN $3::boolean THEN now() - make_interval(secs => $2 - 2) END,
                  bridged_at  = CASE WHEN $3::boolean THEN now() - make_interval(secs => $2 - 2) END
            WHERE id = $1`,
          [a.id, dialedSecondsAgo, answered],
        );
      }
      return c.id as string;
    };
    return {
      ringing: await make(1, { state: 'dialing' }, 10, false),
      longAgo: await make(2, { state: 'dialing' }, DELAY_SECONDS + 60, false),
      bridged: await make(3, { state: 'bridged' }, 30, true),
      neverSent: await make(4, { state: 'queued' }, null, false),
    };
  }

  async function redial(contactId: string) {
    const { rows } = await getTestPool().query<{ state: string; after_dial: number | null; from_now: number }>(
      `SELECT c.state,
              EXTRACT(EPOCH FROM c.next_attempt_at - a.dialed_at)::float8 AS after_dial,
              EXTRACT(EPOCH FROM c.next_attempt_at - now())::float8 AS from_now
         FROM agency_contacts c
         JOIN agency_call_attempts a ON a.contact_id = c.id
        WHERE c.id = $1`,
      [contactId],
    );
    return rows[0]!;
  }

  async function expectRule(ids: Awaited<ReturnType<typeof shapes>>) {
    const ringing = await redial(ids.ringing);
    expect(ringing.state).toBe('pending');
    // The delay after the dial was sent, not after the reap.
    expect(ringing.after_dial).toBeCloseTo(DELAY_SECONDS, 0);
    for (const dialableNow of [ids.longAgo, ids.bridged, ids.neverSent]) {
      const r = await redial(dialableNow);
      expect(r.state).toBe('pending');
      // `next_attempt_at` is the reap's own instant, a moment ago.
      expect(r.from_now).toBeLessThanOrEqual(1);
      expect(r.from_now).toBeGreaterThan(-60);
    }
  }

  it('a media worker\'s slot reap (reapSessions) defers only the dial sent and never answered', async () => {
    const campaignId = (await insertAgencyCampaign({ status: 'running' })).id as string;
    const dead = (await insertAgentSession(campaignId)).id as string;
    const ids = await shapes(campaignId, dead);

    const report = await reaper().reapSessions((sessionId) => sessionId === dead);

    expect(report.attempts).toBe(4);
    await expectRule(ids);
  });

  it('the single-process startup reap (reapOnStartup) applies the same rule', async () => {
    const campaignId = (await insertAgencyCampaign({ status: 'running' })).id as string;
    const session = (await insertAgentSession(campaignId)).id as string;
    const ids = await shapes(campaignId, session);

    expect((await reaper().reapOnStartup()).attempts).toBe(4);
    await expectRule(ids);
  });

  it('the periodic leak sweep (sweepOnce) applies it too', async () => {
    const campaignId = (await insertAgencyCampaign({ status: 'running' })).id as string;
    const session = (await insertAgentSession(campaignId)).id as string;
    const ids = await shapes(campaignId, session);
    await getTestPool().query(
      'UPDATE agency_call_attempts SET created_at = now() - make_interval(secs => $1)', [WELL_PAST_LEAK_FLOOR_SECONDS]);

    expect(await reaper().sweepOnce()).toBe(4);
    await expectRule(ids);
  });

  /**
   * The sweep of the dialer's unrecorded ends is different: the dialer saw these end, so the
   * row's shape (dialled, never answered) does not mean the outcome is unknown. A no-answer
   * whose `ended` write failed is over at the carrier, and holding its contact 15 minutes
   * after a transient write failure stalls a campaign near the end of its list. Only a dial
   * the dialer itself reported outcome-unknown keeps the rule.
   * Mutation-checked: passing `reapedRedialNotBefore(attempt)` for every unrecorded end
   * (the code before the fix) reds the first contact here.
   */
  it('the sweep of the dialer\'s unrecorded ends defers only a dial it reported outcome-unknown', async () => {
    const campaignId = (await insertAgencyCampaign({ status: 'running' })).id as string;
    const session = (await insertAgentSession(campaignId)).id as string;
    const ringing = async (row: number) => {
      const c = await insertAgencyContact(campaignId, { state: 'in_flight', source_row_number: row });
      const a = await insertAgencyAttempt(campaignId, c.id as string, { reserved_agent_id: session, state: 'dialing' });
      await getTestPool().query(
        `UPDATE agency_call_attempts SET dialed_at = now() - make_interval(secs => 10) WHERE id = $1`, [a.id]);
      return { contactId: c.id as string, attemptId: a.id as string };
    };
    const noAnswer = await ringing(1);
    const unknown = await ringing(2);
    const forget = vi.fn();

    const reaped = await reaper({
      // The agent is back in the pool with their station connected: only this arm can end them.
      ownerOf: async () => 'replica-A',
      unrecordedEnds: {
        entries: () => [
          { attemptId: noAnswer.attemptId, dialOutcomeUnknown: false },
          { attemptId: unknown.attemptId, dialOutcomeUnknown: true },
        ],
        forget,
      },
    }).sweepOnce();

    expect(reaped).toBe(2);
    expect(forget).toHaveBeenCalledWith([noAnswer.attemptId, unknown.attemptId]);
    const over = await redial(noAnswer.contactId);
    expect(over.state).toBe('pending');
    expect(over.from_now).toBeLessThanOrEqual(1);
    expect(over.from_now).toBeGreaterThan(-60);
    const held = await redial(unknown.contactId);
    expect(held.state).toBe('pending');
    expect(held.after_dial).toBeCloseTo(DELAY_SECONDS, 0);
    const { rows } = await getTestPool().query<{ state: string; outcome: string }>(
      'SELECT state, outcome FROM agency_call_attempts WHERE id = ANY($1::uuid[]) ORDER BY id',
      [[noAnswer.attemptId, unknown.attemptId]],
    );
    expect(rows.map((r) => `${r.state}/${r.outcome}`)).toEqual(['ended/orphaned', 'ended/orphaned']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (6) A requeue moves only a contact its reaped attempt still holds.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The dialer's abandon path ends the attempt and unclaims the contact as two writes. When
 * only the `ended` write fails, the contact is `pending` again with its attempt still
 * `dialing`, and the attempt is reported to the reaper as an unrecorded end. Until the
 * sweep (up to a minute), the contact can be taken again:
 *
 *  - by pacing, once the sweep's `reapByIds` has ended the old attempt (the live-attempt
 *    index refuses a new one before that): pacing claims it and dials a new attempt in the
 *    window between the reap and the requeue;
 *  - by a soft-phone call at any time (a manual call is not an attempt).
 *
 * The requeue used to write `pending` regardless, which put a contact with a live call
 * back on the roster (claimable again mid-call), or reopened one the new call had already
 * settled. Each case below drives the real sweep over real rows; the interleaving is
 * the real claim and insert, run where pacing would run them.
 * Mutation-checked: dropping the ownership `CASE` from `requeueOrphaned`'s WHERE reds all three.
 */
describe('a requeue moves only a contact its reaped attempt still holds', () => {
  async function abandonedWithUnrecordedEnd() {
    const campaignId = (await insertAgencyCampaign({ status: 'running' })).id as string;
    const session = (await insertAgentSession(campaignId)).id as string;
    const contact = await insertAgencyContact(campaignId, { state: 'in_flight', attempt_count: 1 });
    const contactId = contact.id as string;
    const old = await insertAgencyAttempt(campaignId, contactId, { reserved_agent_id: session, state: 'dialing' });
    // The abandon path's `ended` write failed; its unclaim landed.
    await agencyContactRepository.unclaim(contactId, new Date(Date.now() - 1000));
    const ends = {
      entries: () => [{ attemptId: old.id as string, dialOutcomeUnknown: false }],
      forget: vi.fn(),
    };
    return { campaignId, session, contactId, oldAttemptId: old.id as string, ends };
  }

  /** Pacing's own claim and attempt insert, as one tick runs them. */
  async function pacingRedials(campaignId: string, session: string, contactId: string) {
    const claimed = await agencyContactRepository.claimDialable(campaignId, 10);
    expect(claimed.map((c) => c.id)).toEqual([contactId]);
    const attempt = await agencyAttemptRepository.create({
      campaignId, contactId, tenantId: claimed[0]!.tenant_id, accountId: claimed[0]!.account_id,
      callerId: '+919000000001', reservedAgentId: session,
    });
    expect(attempt, 'the live-attempt index refused the redial').not.toBeNull();
    await agencyAttemptRepository.setState(attempt!.id, 'dialing', { dialed_at: new Date() });
    return attempt!.id;
  }

  /** Run `between` after the sweep's real `reapByIds` and before its requeue. */
  function interleaveAfterReap(between: () => Promise<void>) {
    const real = agencyAttemptRepository.reapByIds.bind(agencyAttemptRepository);
    return vi.spyOn(agencyAttemptRepository, 'reapByIds').mockImplementationOnce(async (ids) => {
      const rows = await real(ids);
      await between();
      return rows;
    });
  }

  async function contactRow(id: string) {
    const { rows } = await getTestPool().query<{
      state: string; attempt_count: number; our_fault_attempts: number; next_attempt_at: Date; last_outcome: string | null;
    }>('SELECT state, attempt_count, our_fault_attempts, next_attempt_at, last_outcome FROM agency_contacts WHERE id = $1', [id]);
    return rows[0]!;
  }

  async function attemptRow(id: string) {
    const { rows } = await getTestPool().query<{ state: string; outcome: string | null }>(
      'SELECT state, outcome FROM agency_call_attempts WHERE id = $1', [id]);
    return rows[0]!;
  }

  it('leaves a contact pacing re-claimed with a new live attempt `in_flight`, and still ends the orphaned row', async () => {
    const w = await abandonedWithUnrecordedEnd();
    let newAttemptId = '';
    const spy = interleaveAfterReap(async () => { newAttemptId = await pacingRedials(w.campaignId, w.session, w.contactId); });
    try {
      expect(await reaper({ ownerOf: async () => 'replica-A', unrecordedEnds: w.ends }).sweepOnce()).toBe(1);
    } finally {
      spy.mockRestore();
    }

    expect(await attemptRow(w.oldAttemptId)).toEqual({ state: 'ended', outcome: 'orphaned' });
    expect(await attemptRow(newAttemptId)).toMatchObject({ state: 'dialing' });
    const after = await contactRow(w.contactId);
    expect(after.state, 'the contact of a live call was put back on the roster').toBe('in_flight');
    expect(after.our_fault_attempts).toBe(0);
    // Nothing can claim it while its call is live.
    expect(await agencyContactRepository.claimDialable(w.campaignId, 10)).toEqual([]);
    expect(w.ends.forget).toHaveBeenCalledWith([w.oldAttemptId]);
  });

  it('does not reopen a contact the new attempt already settled', async () => {
    const w = await abandonedWithUnrecordedEnd();
    const spy = interleaveAfterReap(async () => {
      const id = await pacingRedials(w.campaignId, w.session, w.contactId);
      await agencyAttemptRepository.setState(id, 'ended', { outcome: 'connected', ended_at: new Date() });
      await agencyContactRepository.markState(w.contactId, 'completed', { last_outcome: 'connected', bump_attempt: true });
    });
    try {
      await reaper({ ownerOf: async () => 'replica-A', unrecordedEnds: w.ends }).sweepOnce();
    } finally {
      spy.mockRestore();
    }

    expect(await attemptRow(w.oldAttemptId)).toEqual({ state: 'ended', outcome: 'orphaned' });
    expect(await contactRow(w.contactId)).toMatchObject({
      state: 'completed', last_outcome: 'connected', attempt_count: 2, our_fault_attempts: 0,
    });
  });

  it('leaves a contact a soft-phone call claimed to that call', async () => {
    const w = await abandonedWithUnrecordedEnd();
    const softphone = await insertSoftphoneSession();
    const claim = await agencyContactRepository.claimForManual(w.campaignId, w.contactId);
    expect(claim.outcome).toBe('claimed');
    await insertManualCall(softphone as never, {
      campaign_id: w.campaignId, contact_id: w.contactId, contact_claimed: true, contact_prior_state: 'pending', state: 'dialing',
    });

    expect(await reaper({ ownerOf: async () => 'replica-A', unrecordedEnds: w.ends }).sweepOnce()).toBe(1);

    expect(await attemptRow(w.oldAttemptId)).toEqual({ state: 'ended', outcome: 'orphaned' });
    expect(await contactRow(w.contactId)).toMatchObject({ state: 'in_flight', our_fault_attempts: 0 });
    // Pacing cannot dial the customer the agent is calling by hand.
    expect(await agencyContactRepository.claimDialable(w.campaignId, 10)).toEqual([]);
  });

  /** The control: still the reaped attempt's, so it is requeued exactly as before. */
  it('still requeues a contact the reaped attempt holds', async () => {
    const campaignId = (await insertAgencyCampaign({ status: 'running' })).id as string;
    const session = (await insertAgentSession(campaignId)).id as string;
    const contact = await insertAgencyContact(campaignId, { state: 'in_flight', attempt_count: 1 });
    const old = await insertAgencyAttempt(campaignId, contact.id as string, { reserved_agent_id: session, state: 'dialing' });
    const ends = { entries: () => [{ attemptId: old.id as string, dialOutcomeUnknown: false }], forget: vi.fn() };

    expect(await reaper({ ownerOf: async () => 'replica-A', unrecordedEnds: ends }).sweepOnce()).toBe(1);

    expect(await contactRow(contact.id as string)).toMatchObject({
      state: 'pending', last_outcome: 'orphaned', attempt_count: 1, our_fault_attempts: 1,
    });
  });
});

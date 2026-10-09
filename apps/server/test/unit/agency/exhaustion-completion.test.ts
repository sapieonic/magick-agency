// Completion-notice seam: `registerCompletionNotifier` / `notifyCampaignFinished(updatedCampaign, to)` is
// called inside the won-transition branch and NOT awaited. Cases through the notifier:
// 'the LOSING leader announces nothing, flushes nothing, and relinquishes nothing' (a lost race calls
// no notifier), 'the WINNING leader announces once and flushes exactly once' (called exactly once,
// with the updated row and `completed`), 'a failing completion notice does not abort finalization'
// (a rejecting notifier: finalization still announces `list_exhausted`, and the rejection does not
// escape — a plain function, because a Vitest spy attaches its own handler). Also: `stop()` drains a
// notice still in flight, bounded by `noticeDrainTimeoutMs`. The `engine()` helper registers
// through the real seam instead of poking a private field. Mutation-checked: a duplicated, missing,
// pre-`if (updated)` or `.catch`-less notifier call each reds a case.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Exhaustion, the completion predicate, single-writer finalization.
//
// The three acceptance criteria, and what each is actually vulnerable to:
//
//   (a) a campaign with only FUTURE retries is not completed, and reports
//       "contacts remaining" and "retries pending" separately. The failure mode
//       is not a wrong number, it is a MISSING one — `next_attempt_at` can be
//       hours out, so a predicate that forgot the future-dated rows would declare
//       a campaign complete while a thousand customers still await a callback.
//   (b) exactly one writer performs the transition. The interesting half is the
//       LOSER: a second leader that lost the guard must do nothing observable,
//       not merely skip the UPDATE.
//   (c) `stopping → stopped` follows the same path once in-flight attempts drain.
//
// Plus the finding this ticket inherited: `markState` writes
// `next_attempt_at = COALESCE($6, next_attempt_at)`, so a contact moved to a
// TERMINAL state keeps whatever instant it already had. "No retry is scheduled"
// is therefore untestable by the absence of an instant, and every assertion here
// pins the STATE instead. See the last describe block for the proof.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { pool } = vi.hoisted(() => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('@magick-agency/db', () => ({ getPool: () => pool }));

const { repos, settings } = vi.hoisted(() => ({
  repos: {
    campaign: {
      findById: vi.fn(),
      findActive: vi.fn().mockResolvedValue([]),
      countOutstanding: vi.fn().mockResolvedValue(0),
      transitionStatus: vi.fn(),
    },
    contact: { claimDialable: vi.fn().mockResolvedValue([]), unclaim: vi.fn().mockResolvedValue(undefined) },
    attempt: { countLive: vi.fn().mockResolvedValue(0), create: vi.fn(), setState: vi.fn().mockResolvedValue(null) },
    session: { findLiveForCampaign: vi.fn().mockResolvedValue([]) },
  },
  settings: { getMaxConcurrentCalls: vi.fn().mockResolvedValue(5) },
}));
vi.mock('../../../src/db/repositories/agency.repository.js', async (importOriginal) => {
  // The pacing engine's collaborators are doubled, but the REAL repository class
  // is still needed by the SQL-shape block below — importing the original keeps
  // both in one file without a second suite.
  const actual = await importOriginal<typeof import('../../../src/db/repositories/agency.repository.js')>();
  return {
    ...actual,
    agencyCampaignRepository: repos.campaign,
    agencyContactRepository: repos.contact,
    agencyAttemptRepository: repos.attempt,
    agencyAgentSessionRepository: repos.session,
  };
});
vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({
  accountSettingsRepository: settings,
}));

import { PacingEngine } from '../../../src/agency/pacing-engine.js';
import {
  AgencyCampaignRepository,
  AgencyContactRepository,
} from '../../../src/db/repositories/agency.repository.js';

const CAMPAIGN = {
  id: 'camp-1', name: 'Q3', tenant_id: 't1', account_id: 'a1',
  status: 'running', caller_ids: ['+14155550100'],
  calling_window_start: '00:00:00', calling_window_end: '24:00:00',
  calling_days: [1, 2, 3, 4, 5, 6, 7], default_timezone: 'UTC',
} as any;

function makeStations(owned: string[]) {
  return {
    isLocallyOwned: vi.fn((id: string) => owned.includes(id)),
    ownerOf: vi.fn(async (id: string) => (owned.includes(id) ? 'r1' : null)),
    broadcast: vi.fn((_campaignId: string, _frame: unknown) => owned.length),
    sessionIdsForCampaign: vi.fn(() => owned),
  };
}

// The engine's "something may want to know a campaign finished" seam carries the
// completion notice, registered through the real `registerCompletionNotifier`.
function engine(stations: any, notifier: any = undefined) {
  const agents = { get: vi.fn(async () => null), reserve: vi.fn(), set: vi.fn() };
  const e = new PacingEngine(
    null, '', 'r1', stations as any, agents as any,
    { dispatch: vi.fn() } as any, { check: vi.fn().mockResolvedValue('clear') } as any,
  );
  if (notifier) e.registerCompletionNotifier(notifier);
  return e;
}

/** The single SQL string a repository method sent, normalised to one line. */
function sqlOf(callIndex = 0): string {
  return String(pool.query.mock.calls[callIndex]![0]).replace(/\s+/g, ' ');
}

beforeEach(() => {
  vi.clearAllMocks();
  pool.query.mockResolvedValue({ rows: [{}], rowCount: 1 });
  repos.campaign.findById.mockResolvedValue(CAMPAIGN);
  repos.campaign.countOutstanding.mockResolvedValue(0);
  repos.contact.claimDialable.mockResolvedValue([]);
  repos.attempt.countLive.mockResolvedValue(0);
  repos.session.findLiveForCampaign.mockResolvedValue([]);
  settings.getMaxConcurrentCalls.mockResolvedValue(5);
});

// ─── (a) the completion predicate vs. "list exhausted" ──────────────────────

describe('a future retry is outstanding, not complete', () => {
  it('countOutstanding counts pending rows REGARDLESS of next_attempt_at', async () => {
    await new AgencyCampaignRepository().countOutstanding('camp-1');
    const sql = sqlOf();

    // The load-bearing absence. A predicate that also filtered
    // `next_attempt_at <= now()` would read "nothing is dialable right now" as
    // "nothing is left", and finalize a campaign whose retries are hours out —
    // the exact conflation these two questions must not make.
    expect(sql).toContain("state IN ('pending','in_flight','connected')");
    expect(sql).not.toContain('next_attempt_at');
  });

  it('all three non-terminal states block completion, and every terminal one does not', async () => {
    await new AgencyCampaignRepository().countOutstanding('camp-1');
    const sql = sqlOf();

    // `connected` is the subtle one: a contact parked awaiting an agent's
    // write-up has no live attempt and no pending row, so omitting it would let a
    // campaign complete with a conversation still un-dispositioned.
    for (const live of ['pending', 'in_flight', 'connected']) expect(sql).toContain(live);
    // Terminal states must NOT appear, or a campaign with any worked contact
    // could never finalize at all.
    for (const done of ['completed', 'exhausted', 'suppressed']) {
      expect(sql, `${done} must not hold a campaign open`).not.toContain(`'${done}'`);
    }
  });

  it('the pacing leader does not finalize while a future retry is outstanding', async () => {
    repos.campaign.countOutstanding.mockResolvedValue(1);
    const stations = makeStations(['s1']);

    await engine(stations).tickOnce('camp-1');

    expect(repos.campaign.transitionStatus).not.toHaveBeenCalled();
    // And it does not announce an ending it did not perform.
    const reasons = stations.broadcast.mock.calls.map((c) => (c[1] as any).reason);
    expect(reasons).not.toContain('list_exhausted');
  });
});

describe('remaining and retries-pending are reported separately', () => {
  it('stats reports total pending AND the future-dated subset as distinct columns', async () => {
    pool.query.mockResolvedValue({ rows: [{}] });
    await new AgencyCampaignRepository().stats('camp-1');
    const sql = sqlOf();

    // Two different questions off one round trip. `contacts_pending` is every
    // pending row; `retries_pending` is only the future-dated ones — so
    // "dialable right now" is the difference, and a dashboard can show a
    // campaign that is neither working nor finished.
    expect(sql).toContain("state = 'pending')::text AS contacts_pending");
    expect(sql).toContain("state = 'pending' AND next_attempt_at > now())::text AS retries_pending");
  });

  it('stats reports exhaustion in its own bucket', async () => {
    pool.query.mockResolvedValue({ rows: [{}] });
    await new AgencyCampaignRepository().stats('camp-1');

    // Exhaustion is this suite's own subject and it is a distinct
    // STATE. Folding it into `contacts_completed` — or omitting it, which is what
    // this suite found — makes `contacts_total` disagree with the sum of the
    // buckets, and the contacts that vanish are precisely the ones an operator
    // needs to see: worked to the cap and never reached.
    expect(sqlOf()).toContain("state = 'exhausted')::text AS contacts_exhausted");
  });

  it('every contact state has a bucket, so the buckets sum to the total', async () => {
    pool.query.mockResolvedValue({ rows: [{}] });
    await new AgencyCampaignRepository().stats('camp-1');
    const sql = sqlOf();

    // Enumerated from the migration-073 CHECK constraint rather than from the
    // payload, so adding a state without a bucket reds this rather than silently
    // shrinking the visible total.
    for (const state of ['pending', 'in_flight', 'completed', 'suppressed', 'exhausted']) {
      expect(sql, `contact state '${state}' has no bucket in the supervisor payload`)
        .toContain(`state = '${state}')`);
    }
  });

  it('numeric coercion survives a zero count rather than reading it as absent', async () => {
    // The columns are cast `::text` in SQL (pg returns int8 as a string), so the
    // mapper runs `Number(v ?? 0)`. A `'0'` must land as 0 and not be swallowed
    // by a truthiness check somewhere upstream.
    pool.query.mockResolvedValue({ rows: [{ contacts_exhausted: '0', contacts_pending: '12' }] });
    const stats = await new AgencyCampaignRepository().stats('camp-1');

    expect(stats.contacts_exhausted).toBe(0);
    expect(stats.contacts_pending).toBe(12);
  });
});

// ─── (b) exactly one writer ─────────────────────────────────────────────────

describe('exactly one writer performs the transition', () => {
  it('guards the UPDATE on the expected status, so the second writer matches no row', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await new AgencyCampaignRepository().transitionStatus('camp-1', ['running'], 'completed', {});
    const sql = sqlOf();

    // The exclusivity is the WHERE clause, not application-level sequencing:
    // whoever's UPDATE matches the row wins, and the loser's matches nothing.
    expect(sql).toContain('WHERE id = $1 AND status = ANY($2::varchar[])');
    expect(sql).toContain('RETURNING *');
  });

  it('returns null when the guard did not match — that null IS the lost race', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    const lost = await new AgencyCampaignRepository()
      .transitionStatus('camp-1', ['running'], 'completed', {});
    expect(lost).toBeNull();
  });

  it('the LOSING leader announces nothing, flushes nothing, and relinquishes nothing', async () => {
    // The half that matters. Skipping the UPDATE is free; the damage from a lost
    // race is a SECOND `list_exhausted` broadcast to every agent and a SECOND
    // billing flush, both of which happen after the transition and neither of
    // which the database guard protects on its own.
    repos.campaign.countOutstanding.mockResolvedValue(0);
    repos.campaign.transitionStatus.mockResolvedValue(null);       // we lost
    const stations = makeStations(['s1']);
    const notifyCampaignFinished = vi.fn().mockResolvedValue(undefined);

    await engine(stations, { notifyCampaignFinished }).tickOnce('camp-1');

    expect(repos.campaign.transitionStatus).toHaveBeenCalledTimes(1);
    expect(notifyCampaignFinished, 'a lost race notified the supervisors twice').not.toHaveBeenCalled();
    const reasons = stations.broadcast.mock.calls.map((c) => (c[1] as any).reason);
    expect(reasons, 'a lost race told every agent the campaign ended twice')
      .not.toContain('list_exhausted');
  });

  it('the WINNING leader announces once and flushes exactly once', async () => {
    // The inverse, so the test above cannot pass by the engine simply never
    // finalizing anything.
    repos.campaign.countOutstanding.mockResolvedValue(0);
    repos.campaign.transitionStatus.mockResolvedValue({ ...CAMPAIGN, status: 'completed' });
    const stations = makeStations(['s1']);
    // The notifier receives the
    // UPDATED campaign row (what `transitionStatus` returned), not just its id.
    const notifyCampaignFinished = vi.fn().mockResolvedValue(undefined);

    await engine(stations, { notifyCampaignFinished }).tickOnce('camp-1');

    expect(notifyCampaignFinished).toHaveBeenCalledTimes(1);
    expect(notifyCampaignFinished).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'camp-1', status: 'completed' }), 'completed',
    );
    const reasons = stations.broadcast.mock.calls.map((c) => (c[1] as any).reason);
    expect(reasons).toContain('list_exhausted');
  });

  it('a failing completion notice does not abort finalization', async () => {
    // The notice is issued inside the won-transition branch. If it were allowed
    // to throw, a downstream outage would strand the leader lease on a campaign that
    // has already been transitioned in the database — unrecoverable without a
    // restart, and invisible until agents notice they get no more calls.
    repos.campaign.countOutstanding.mockResolvedValue(0);
    repos.campaign.transitionStatus.mockResolvedValue({ ...CAMPAIGN, status: 'completed' });
    const stations = makeStations(['s1']);
    // The notice is not awaited (so it cannot abort finalization) and carries its own
    // `.catch`; the listener below pins that no rejection escapes it.
    // A plain function, not `vi.fn()`: a Vitest spy records its settled results and
    // so attaches a handler to the promise it returns, which would hide an escape.
    let notices = 0;
    const notifyCampaignFinished = (): Promise<void> => { notices++; return Promise.reject(new Error('mail is down')); };
    const escaped = vi.fn();
    process.on('unhandledRejection', escaped);

    try {
      await expect(engine(stations, { notifyCampaignFinished }).tickOnce('camp-1')).resolves.not.toThrow();
      for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
      expect(notices).toBe(1);
      expect(escaped, 'a failing notice escaped as an unhandled rejection').not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', escaped);
    }

    const reasons = stations.broadcast.mock.calls.map((c) => (c[1] as any).reason);
    expect(reasons).toContain('list_exhausted');
  });
});

// ─── a notice requested on the last tick survives stop() ─

describe('completion notices are drained on stop', () => {
  it('stop() waits for a completion notice still in flight', async () => {
    // A campaign finalized on the last tick before SIGTERM: the notice is not awaited
    // by the tick, so only `stop()` stands between it and process exit.
    repos.campaign.countOutstanding.mockResolvedValue(0);
    repos.campaign.transitionStatus.mockResolvedValue({ ...CAMPAIGN, status: 'completed' });
    let settled = false;
    const notifyCampaignFinished = vi.fn(() => new Promise<void>((resolve) =>
      setTimeout(() => { settled = true; resolve(); }, 50)));
    const e = engine(makeStations(['s1']), { notifyCampaignFinished });

    await e.tickOnce('camp-1');
    expect(notifyCampaignFinished).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    expect(e.pendingNoticeCount()).toBe(1);

    await e.stop();
    expect(settled, 'stop() returned before the completion notice settled').toBe(true);
    expect(e.pendingNoticeCount()).toBe(0);
  });

  it('the drain is bounded: a notice that never settles cannot hold stop() forever', async () => {
    repos.campaign.countOutstanding.mockResolvedValue(0);
    repos.campaign.transitionStatus.mockResolvedValue({ ...CAMPAIGN, status: 'completed' });
    const notifyCampaignFinished = vi.fn(() => new Promise<void>(() => { /* SMTP never answers */ }));
    const e = engine(makeStations(['s1']), { notifyCampaignFinished });
    e.noticeDrainTimeoutMs = 20;

    await e.tickOnce('camp-1');
    const started = Date.now();
    await e.stop();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(e.pendingNoticeCount()).toBe(1);
  });
});

// ─── (c) stopping → stopped, same path, after the drain ─────────────────────

describe('stopping drains before it stops', () => {
  it('does not stop a stopping campaign while an attempt is still in flight', async () => {
    repos.campaign.findById.mockResolvedValue({ ...CAMPAIGN, status: 'stopping' });
    // LIVE ATTEMPTS, not `countOutstanding`, and the distinction is load-bearing.
    // The roster count also counts every `pending` contact, and nothing clears those
    // when a campaign stops — so a campaign stopped at row 100 of 50 000 could never
    // satisfy it and the row could not leave `stopping` at all. "Drain" means the
    // calls we already placed have ended; the contacts we will now never dial are
    // not work in progress.
    repos.attempt.countLive.mockResolvedValue(1);
    repos.campaign.countOutstanding.mockResolvedValue(0);

    await engine(makeStations(['s1'])).tickOnce('camp-1');

    expect(repos.campaign.transitionStatus).not.toHaveBeenCalled();
  });

  it('stops it even with the whole roster undialed — that is what stopping means', async () => {
    repos.campaign.findById.mockResolvedValue({ ...CAMPAIGN, status: 'stopping' });
    repos.attempt.countLive.mockResolvedValue(0);
    repos.campaign.countOutstanding.mockResolvedValue(49_900);
    repos.campaign.transitionStatus.mockResolvedValue({ ...CAMPAIGN, status: 'stopped' });

    await engine(makeStations(['s1'])).tickOnce('camp-1');

    // No fourth argument. The lifecycle stamps (`ended_at`, and its legacy twin
    // `completed_at`) are derived from the TARGET STATUS inside `transitionStatus`
    // since migration 108, so the leader carries no patch — which is the point of
    // moving them: a call site cannot get them wrong by omission when there is
    // nothing to omit. Asserted as an EXACT three-argument call rather than with a
    // trailing `expect.anything()`, so a patch quietly reappearing here is a
    // failure rather than something the matcher waves through.
    expect(repos.campaign.transitionStatus)
      .toHaveBeenCalledWith('camp-1', ['stopping'], 'stopped');
  });

  it('stops it once the drain completes, guarded from stopping — never from running', async () => {
    repos.campaign.findById.mockResolvedValue({ ...CAMPAIGN, status: 'stopping' });
    repos.campaign.countOutstanding.mockResolvedValue(0);
    repos.campaign.transitionStatus.mockResolvedValue({ ...CAMPAIGN, status: 'stopped' });

    await engine(makeStations(['s1'])).tickOnce('camp-1');

    // The `from` guard is the campaign's OWN status, so a supervisor's concurrent
    // resume (stopping → running) makes this UPDATE match nothing rather than
    // stopping a campaign that is running again.
    // No fourth argument. The lifecycle stamps (`ended_at`, and its legacy twin
    // `completed_at`) are derived from the TARGET STATUS inside `transitionStatus`
    // since migration 108, so the leader carries no patch — which is the point of
    // moving them: a call site cannot get them wrong by omission when there is
    // nothing to omit. Asserted as an EXACT three-argument call rather than with a
    // trailing `expect.anything()`, so a patch quietly reappearing here is a
    // failure rather than something the matcher waves through.
    expect(repos.campaign.transitionStatus)
      .toHaveBeenCalledWith('camp-1', ['stopping'], 'stopped');
  });

  it('a paused campaign is never finalized by either path', async () => {
    // Only `running` and `stopping` are finalizable. A paused campaign has
    // nothing outstanding by construction — every contact is pending — so a
    // predicate that keyed on the count alone would complete it out from under a
    // supervisor who intends to resume.
    repos.campaign.findById.mockResolvedValue({ ...CAMPAIGN, status: 'paused' });
    repos.campaign.countOutstanding.mockResolvedValue(0);

    await engine(makeStations(['s1'])).tickOnce('camp-1');

    expect(repos.campaign.transitionStatus).not.toHaveBeenCalled();
  });
});

// ─── the inherited finding: assert the STATE, never the absent instant ──────

describe('a terminal contact keeps a stale next_attempt_at', () => {
  it('markState COALESCEs next_attempt_at, so omitting it PRESERVES the old instant', async () => {
    await new AgencyContactRepository().markState('c1', 'exhausted', { last_outcome: 'no_answer' });
    const sql = sqlOf();

    // Verified rather than assumed. This is why "no retry is scheduled" cannot be
    // asserted by the absence of an instant anywhere in this ticket: a contact
    // retired at its cap still carries whatever `next_attempt_at` its last
    // scheduled retry left behind.
    //
    // The `COALESCE` now sits inside the DNC state-freeze guard's CASE
    // (`markState`'s header). The ELSE branch — every contact that is not
    // DNC-suppressed, i.e. every contact this block is about — is unchanged, and
    // the assertion follows it there rather than being relaxed to a substring
    // that a future rewrite could satisfy while meaning something else.
    expect(sql).toContain('ELSE COALESCE($6, next_attempt_at) END');
    expect(pool.query.mock.calls[0]![1]![5], 'a terminal markState passed no new instant').toBeNull();
  });

  it('is inert ONLY because claimDialable gates on state, not on the clock', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await new AgencyContactRepository().claimDialable('camp-1', 5);
    const sql = sqlOf();

    // The stale instant is harmless exactly as long as this conjunction holds. A
    // future predicate that dropped `state = 'pending'` — or widened it to any
    // non-terminal state — would resurrect every exhausted contact whose stale
    // instant has since passed, silently redialing people the system already
    // retired. That is the whole reason the finding is recorded rather than fixed.
    expect(sql).toContain("state = 'pending'");
    expect(sql).toContain('next_attempt_at <= now()');
  });

  it('the exhausted state — not a null instant — is what retires a contact', async () => {
    await new AgencyContactRepository().markState('c1', 'exhausted');

    // The positive form of the rule, stated once so it is copyable: assert the
    // state. `$2` is the state; it is the only parameter that carries the fact.
    expect(pool.query.mock.calls[0]![1]![1]).toBe('exhausted');
    // `$2` is still the state; it is now written through the DNC state-freeze
    // guard's CASE, whose ELSE branch is the ordinary path (`markState`'s header).
    expect(sqlOf()).toContain('ELSE $2 END');
  });
});

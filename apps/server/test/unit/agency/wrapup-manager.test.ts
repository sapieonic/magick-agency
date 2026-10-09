// PORT NOTE (magick-agency, Phase 6): ported from core test/unit/agency/wrapup-manager.test.ts@4850d1d9 (34 → 34).
// Verbatim cases. Import paths only; the metric reader is core's `test/helpers/otel-metric-reader.ts`, ported verbatim at the same path over a real `@opentelemetry/sdk-metrics` provider (devDependency; `ScrapeMetricReader` inlined because `src/utils/otel-sdk-config.ts` is not ported).
// No case deleted or modified.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Wrap-up (AD-P2-C-02).
//
// The acceptance criteria are (a) `wrapup_seconds = 0` returns the agent
// immediately, (b) auto-return fires EXACTLY once at expiry, (c) an outstanding
// required disposition holds the agent and says why, (d) an agent in wrap-up is
// not counted available by the tick.
//
// (d) belongs to the pacing engine and is asserted there, against the Redis state
// the tick actually reads — asserting it here would only prove this file's own
// mock. The rest are timer arithmetic, which is what fake timers are for.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { repos } = vi.hoisted(() => ({
  repos: {
    attempt: { setState: vi.fn().mockResolvedValue(null) },
    session: { setState: vi.fn().mockResolvedValue(undefined) },
  },
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyAttemptRepository: repos.attempt,
  agencyAgentSessionRepository: repos.session,
  agencyContactRepository: {},
  agencyCampaignRepository: {},
}));

import { WrapupManager } from '../../../src/agency/wrapup-manager.js';
// The real meter provider, installed before `metrics.ts` creates its instruments:
// the claim is about the value an export (or the `:9090` scrape) would read.
const { reader } = await vi.hoisted(async () => {
  const { installMetricReader } = await import('../../helpers/otel-metric-reader.js');
  return { reader: installMetricReader() };
});
import { collectMetric } from '../../helpers/otel-metric-reader.js';
import { AgentStateMachine, AGENT_LEASE_MS } from '../../../src/agency/agent-state-machine.js';

function fakeStations() {
  const sent: any[] = [];
  return {
    sent,
    send: vi.fn((_id: string, frame: any) => { sent.push(frame); return true; }),
    frames: (event: string) => sent.filter((f) => f.event === event),
  };
}

/** Records every lease TTL written, so the §6.1 invariant is checkable. */
function fakeAgents() {
  const leases: number[] = [];
  return {
    leases,
    set: vi.fn(async (_id: string, _state: string, opts: any) => { leases.push(opts?.leaseMs); }),
  };
}

function enterParams(over: Partial<Parameters<WrapupManager['enter']>[0]> = {}) {
  return {
    sessionId: 's1', attemptId: 'att-1', campaignId: 'camp-1', tenantId: 'ten-1',
    wrapupSeconds: 30, autoReturn: true, requiresDisposition: false,
    ...over,
  };
}

/**
 * `agency_wrapup_seconds` for one `resolution`, as `{ count, sum }`.
 *
 * Read off the real meter provider — the metrics module is deliberately not
 * mocked here, so the claim is about what an export would actually carry.
 */
async function wrapupSeries(resolution: string): Promise<{ count: number; sum: number }> {
  // Exact label set: tenant + resolution, and deliberately NO `campaign_id` —
  // it was dropped from the agency histograms for series cost (see metrics.ts),
  // and matching on the key set makes re-adding it fail here.
  const point = (await collectMetric(reader, 'agency_wrapup_seconds')).find((p) =>
    Object.keys(p.attributes).sort().join(',') === 'resolution,tenant_id'
    && p.attributes.resolution === resolution
    && p.attributes.tenant_id === 'ten-1');
  return { count: point?.count ?? 0, sum: point?.sum ?? 0 };
}

beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

describe('WrapupManager — the §6.1 invariant', () => {
  it('leases wrap-up at the FLAT heartbeat TTL, never the configured window', async () => {
    // The whole reason wrap-up is an in-process timer: a Redis TTL cannot tell
    // "took too long" from "the process died". If `wrapup_seconds` leaked into the
    // lease, a campaign configured with a 60-minute wrap-up would also be
    // configuring a 60-minute liveness window, and a dead agent would keep being
    // counted by the tick for an hour.
    const agents = fakeAgents();
    const w = new WrapupManager(fakeStations() as any, agents as any, vi.fn());

    await w.enter(enterParams({ wrapupSeconds: 30 }));
    await w.enter(enterParams({ sessionId: 's2', wrapupSeconds: 3600 }));

    expect(agents.leases).toEqual([AGENT_LEASE_MS.wrapup, AGENT_LEASE_MS.wrapup]);
    // And that flat value is byte-identical to `available`'s renewal window shape.
    expect(AGENT_LEASE_MS.wrapup).not.toBe(30_000);
    expect(AGENT_LEASE_MS.wrapup).not.toBe(3_600_000);
  });

  it('persists the window on the attempt row — the durable half', async () => {
    // `wrapup_seconds` + `ended_at` is what lets the no_disposition sweep finish a
    // wrap-up whose in-process timer died with its process.
    const w = new WrapupManager(fakeStations() as any, fakeAgents() as any, vi.fn());
    await w.enter(enterParams({ wrapupSeconds: 45 }));
    expect(repos.attempt.setState).toHaveBeenCalledWith('att-1', 'ended', {
      wrapup_seconds: 45,
      // `AD-P4-C-01`. The wrap-up path stamps its OWN start anchor rather than
      // letting the average infer one from `ended_at` — which is written by whoever
      // settles the attempt, through a patch this call does not send. `AD-P2-C-11`
      // is what that inference costs when the two writers drift apart.
      wrapup_started_at: expect.any(Date),
    });
  });
});

describe('WrapupManager acceptance', () => {
  it('(a) refuses to enter when wrapup_seconds is 0 and NO disposition is required', async () => {
    const onReturn = vi.fn(async () => {});
    const stations = fakeStations();
    const w = new WrapupManager(stations as any, fakeAgents() as any, onReturn);

    expect(await w.enter(enterParams({ wrapupSeconds: 0, requiresDisposition: false }))).toBe(false);
    expect(w.active()).toBe(0);
    // No frame either — a console waiting on `wrapup` before re-enabling its idle
    // UI would hang forever on a campaign configured this way.
    expect(stations.frames('wrapup')).toHaveLength(0);
  });

  it('(a)+(c) `wrapup_seconds = 0` with a REQUIRED disposition holds, timerlessly', async () => {
    // The combination where (a) and (c) read as contradictory. (c) wins, because
    // honouring 0 literally is not a race a fast agent loses — it is structural
    // data loss: the attempt ends, the agent is `available`, the tick reserves them
    // within 250ms, and the record of what was said to a customer is never captured
    // on ANY call of such a campaign. `AD-P2-C-08`'s sweep would then stamp
    // `no_disposition` on every attempt and feed the retry policy a stream of them.
    //
    // So `wrapup_seconds = 0` means "no TIMER", not "no wrap-up".
    const onReturn = vi.fn(async () => {});
    const stations = fakeStations();
    const w = new WrapupManager(stations as any, fakeAgents() as any, onReturn);

    expect(await w.enter(enterParams({ wrapupSeconds: 0, requiresDisposition: true }))).toBe(true);

    const frame = stations.frames('wrapup')[0]!.wrapup;
    // Held from the FIRST frame — there is no countdown that could lapse into a
    // hold later, so the agent needs the reason immediately or their screen is a
    // wrap-up panel with no explanation and no deadline.
    expect(frame.held_reason).toBe('disposition_required');
    expect(frame.ends_at).toBeNull();
    // Reported honestly rather than echoing campaign config: nothing will return
    // this agent on its own.
    expect(frame.auto_return).toBe(false);
    expect(frame.seconds_total).toBe(0);

    // And it must never self-resolve, however long we wait.
    await vi.advanceTimersByTimeAsync(600_000);
    expect(onReturn).not.toHaveBeenCalled();
    expect(w.active()).toBe(1);

    // The agent's own submission is what ends it.
    await w.noteDisposition('s1', 'att-1');
    expect(onReturn).toHaveBeenCalledWith('s1', 'disposition_submitted');
  });

  it('reports auto_return false when the campaign wants it but there is no window', async () => {
    // `wrapup_auto_return = true` with `wrapup_seconds = 0` is a config that cannot
    // mean what it says. Echoing it would show the console `auto_return: true` with
    // `ends_at: null`, which it cannot distinguish from "the countdown failed to
    // arrive" — so it would render a spinner for a wrap-up that is waiting on the
    // agent.
    const stations = fakeStations();
    const w = new WrapupManager(stations as any, fakeAgents() as any, vi.fn());
    await w.enter(enterParams({ wrapupSeconds: 0, autoReturn: true, requiresDisposition: true }));

    expect(stations.frames('wrapup')[0]!.wrapup.auto_return).toBe(false);
  });

  it('(b) auto-returns EXACTLY once at expiry', async () => {
    const onReturn = vi.fn(async () => {});
    const w = new WrapupManager(fakeStations() as any, fakeAgents() as any, onReturn);
    await w.enter(enterParams({ wrapupSeconds: 30 }));

    await vi.advanceTimersByTimeAsync(29_000);
    expect(onReturn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_500);
    expect(onReturn).toHaveBeenCalledTimes(1);
    expect(onReturn).toHaveBeenCalledWith('s1', 'auto_return');

    // Long past expiry, still once. A second return would move an agent who has
    // already been reserved for a new call back to `available` — two attempts, one
    // agent, which is the one thing this whole subsystem exists to prevent.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onReturn).toHaveBeenCalledTimes(1);
    expect(w.active()).toBe(0);
  });

  it('(b) a disposition landing while the expiry return is IN FLIGHT still returns once', async () => {
    // The race that matters is not "same tick" — it is a return that has STARTED
    // and not finished. `onReturn` does real async work (a Redis write, a DB
    // mirror, a frame), so there is a genuine window between it starting and
    // completing, and the entry must already be gone when the second caller looks.
    //
    // Held open explicitly here rather than hoping the scheduler interleaves: an
    // earlier version of this test raced a resolved promise against a timer and
    // passed even when `resolve` deleted the entry AFTER awaiting — proving
    // nothing about the ordering it claimed to pin.
    let releaseReturn!: () => void;
    const returnGate = new Promise<void>((r) => { releaseReturn = r; });
    const onReturn = vi.fn(async () => { await returnGate; });

    const w = new WrapupManager(fakeStations() as any, fakeAgents() as any, onReturn);
    await w.enter(enterParams({ wrapupSeconds: 10, requiresDisposition: false }));

    // Timer fires. The expiry handler is void'd, so flushing timers returns while
    // its `onReturn` is still parked on the gate — exactly the in-flight window.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onReturn).toHaveBeenCalledTimes(1);

    // A disposition arrives before that return has finished.
    await w.noteDisposition('s1', 'att-1');
    expect(onReturn).toHaveBeenCalledTimes(1);

    releaseReturn();
    await vi.advanceTimersByTimeAsync(0);
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it('(c) holds the agent when a required disposition is outstanding, and says why', async () => {
    const onReturn = vi.fn(async () => {});
    const stations = fakeStations();
    const w = new WrapupManager(stations as any, fakeAgents() as any, onReturn);
    await w.enter(enterParams({ wrapupSeconds: 20, requiresDisposition: true }));

    await vi.advanceTimersByTimeAsync(25_000);

    expect(onReturn).not.toHaveBeenCalled();
    const held = stations.frames('wrapup').at(-1)!.wrapup;
    expect(held.held_reason).toBe('disposition_required');
    // `ends_at: null` means "no deadline", not "expired" — a console that read a
    // stale past deadline would render a countdown stuck at zero, which is exactly
    // the "the app has hung" impression this frame exists to prevent.
    expect(held.ends_at).toBeNull();
    expect(w.active()).toBe(1);
  });

  it('(c) the held agent is released the moment the disposition lands', async () => {
    const onReturn = vi.fn(async () => {});
    const w = new WrapupManager(fakeStations() as any, fakeAgents() as any, onReturn);
    await w.enter(enterParams({ wrapupSeconds: 20, requiresDisposition: true }));
    await vi.advanceTimersByTimeAsync(25_000);

    await w.noteDisposition('s1', 'att-1');

    expect(onReturn).toHaveBeenCalledWith('s1', 'disposition_submitted');
  });

  // ── The disposition that arrived BEFORE the wrap-up existed ───────────────
  //
  // `noteDisposition` resolves a live entry, and the entry does not exist until
  // `enter` creates it — so a disposition submitted while the agent was still on
  // the call found nothing and was discarded. Filling the form and then hanging
  // up is an ordinary habit, not an edge case.
  //
  // Staging, 2026-08-13, session `3bd865d4`: dispositioned 06:49:35, hung up
  // 06:49:38, attempt ended 06:49:40 — and at 06:50:40 the expiry held the agent
  // demanding a disposition the system had already accepted. That agent took no
  // further calls.
  //
  // The fix reads `disposition_code` off the attempt row `enter` already writes,
  // so it also holds when the disposition's request landed on a different replica
  // than the wrap-up — which an in-process record of early submissions could not.

  it('returns the agent when the disposition landed before the call ended', async () => {
    repos.attempt.setState.mockResolvedValueOnce({ id: 'att-1', disposition_code: 'callback' });
    const onReturn = vi.fn(async () => {});
    const w = new WrapupManager(fakeStations() as any, fakeAgents() as any, onReturn);

    await w.enter(enterParams({ wrapupSeconds: 60, requiresDisposition: true }));

    // Immediately, not after the window: an agent who is done is pool time.
    expect(onReturn).toHaveBeenCalledWith('s1', 'disposition_submitted');
    expect(w.active()).toBe(0);
  });

  it('does not hold an agent at expiry for a disposition already on the row', async () => {
    // The symptom as the operator saw it. Without the fix this reaches `onExpiry`
    // with `dispositionSubmitted` false and holds `disposition_required` forever.
    repos.attempt.setState.mockResolvedValueOnce({ id: 'att-1', disposition_code: 'voicemail' });
    const onReturn = vi.fn(async () => {});
    const stations = fakeStations();
    const w = new WrapupManager(stations as any, fakeAgents() as any, onReturn);

    await w.enter(enterParams({ wrapupSeconds: 60, requiresDisposition: true }));
    await vi.advanceTimersByTimeAsync(120_000);

    expect(stations.frames('wrapup').some((f) => f.wrapup.held_reason)).toBe(false);
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it('still holds when the row carries no disposition', async () => {
    // The guard must key on the row's actual content — a wrap-up whose attempt is
    // genuinely undispositioned still has to hold, or (c) is lost entirely.
    repos.attempt.setState.mockResolvedValueOnce({ id: 'att-1', disposition_code: null });
    const onReturn = vi.fn(async () => {});
    const stations = fakeStations();
    const w = new WrapupManager(stations as any, fakeAgents() as any, onReturn);

    await w.enter(enterParams({ wrapupSeconds: 20, requiresDisposition: true }));
    await vi.advanceTimersByTimeAsync(25_000);

    expect(onReturn).not.toHaveBeenCalled();
    expect(stations.frames('wrapup').at(-1)!.wrapup.held_reason).toBe('disposition_required');
  });

  it('ignores a disposition on the row when the campaign does not require one', async () => {
    // `requiresDisposition: false` already auto-returns on its own timer;
    // short-circuiting here would cut the wrap-up window an operator configured
    // for note-taking, which is not what the disposition column says anything about.
    repos.attempt.setState.mockResolvedValueOnce({ id: 'att-1', disposition_code: 'callback' });
    const onReturn = vi.fn(async () => {});
    const w = new WrapupManager(fakeStations() as any, fakeAgents() as any, onReturn);

    await w.enter(enterParams({ wrapupSeconds: 30, requiresDisposition: false }));

    expect(onReturn).not.toHaveBeenCalled();
    expect(w.active()).toBe(1);

    await vi.advanceTimersByTimeAsync(31_000);
    expect(onReturn).toHaveBeenCalledWith('s1', 'auto_return');
  });

  it('survives a failed attempt-row write rather than skipping the hold', async () => {
    // `setState` is already `.catch`ed to a warning — the wrap-up must not depend
    // on it. A null row means "unknown", and unknown must not be read as
    // "dispositioned", or a DB blip would silently drop the disposition
    // requirement for that call.
    repos.attempt.setState.mockRejectedValueOnce(new Error('db down'));
    const onReturn = vi.fn(async () => {});
    const stations = fakeStations();
    const w = new WrapupManager(stations as any, fakeAgents() as any, onReturn);

    await w.enter(enterParams({ wrapupSeconds: 20, requiresDisposition: true }));
    await vi.advanceTimersByTimeAsync(25_000);

    expect(onReturn).not.toHaveBeenCalled();
    expect(stations.frames('wrapup').at(-1)!.wrapup.held_reason).toBe('disposition_required');
  });

  it('a disposition for a DIFFERENT attempt does not end this wrap-up', async () => {
    const onReturn = vi.fn(async () => {});
    const w = new WrapupManager(fakeStations() as any, fakeAgents() as any, onReturn);
    await w.enter(enterParams({ requiresDisposition: true }));

    expect(await w.noteDisposition('s1', 'some-older-attempt')).toBe(false);
    expect(onReturn).not.toHaveBeenCalled();
  });

  it('arms no timer at all when auto-return is off', async () => {
    const onReturn = vi.fn(async () => {});
    const stations = fakeStations();
    const w = new WrapupManager(stations as any, fakeAgents() as any, onReturn);
    await w.enter(enterParams({ wrapupSeconds: 30, autoReturn: false }));

    expect(stations.frames('wrapup')[0]!.wrapup.ends_at).toBeNull();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(onReturn).not.toHaveBeenCalled();
    expect(w.active()).toBe(1);
  });

  it('a supervisor can force a held wrap-up to return', async () => {
    const onReturn = vi.fn(async () => {});
    const w = new WrapupManager(fakeStations() as any, fakeAgents() as any, onReturn);
    await w.enter(enterParams({ wrapupSeconds: 5, requiresDisposition: true }));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await w.force('s1')).toBe(true);
    expect(onReturn).toHaveBeenCalledWith('s1', 'forced');
    expect(await w.force('s1')).toBe(false); // idempotent — nothing left to force
  });

  it('re-entering for one session replaces rather than stacks its timer', async () => {
    // Two live timers for one agent would race to return them, and the loser would
    // fire against whatever state the agent had reached by then.
    const onReturn = vi.fn(async () => {});
    const w = new WrapupManager(fakeStations() as any, fakeAgents() as any, onReturn);
    await w.enter(enterParams({ attemptId: 'att-1', wrapupSeconds: 30 }));
    await w.enter(enterParams({ attemptId: 'att-2', wrapupSeconds: 30 }));

    expect(w.active()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it('announces `agent_state: wrapup` on entry, not just the wrapup frame', async () => {
    // THE disposition-loss bug. The console unlocks its disposition pad on
    // `agent_state === 'wrapup'` and must not infer state from anything else — but
    // core set the state in Redis and the DB and never said so on the wire. So the
    // pad greyed out the instant the call ended, `/sessions/:id/available` then 409s
    // `attempt_not_dispositionable`, and the agent sat stuck until the
    // `no_disposition` sweep closed the attempt. Every disposition on a
    // `requires_disposition` campaign was lost.
    const stations = fakeStations();
    const w = new WrapupManager(stations as any, fakeAgents() as any, vi.fn());

    await w.enter(enterParams({ wrapupSeconds: 30, requiresDisposition: true }));

    const state = stations.frames('agent_state');
    expect(state).toHaveLength(1);
    expect(state[0]!.state).toBe('wrapup');
    expect(typeof state[0]!.since).toBe('string');
    // The state frame arrives BEFORE the wrapup frame: a console that renders the
    // countdown before it believes the agent is in wrap-up has to hold the frame or
    // drop it, and this ordering means it never has to choose.
    expect(stations.sent.map((f: any) => f.event)).toEqual(['agent_state', 'wrapup']);
  });

  it('leaves the deadline to the wrapup frame — the state frame carries no countdown', async () => {
    // `AgencyStationAgentStateFrame` has no deadline field and deliberately gains
    // none: `AgencyWrapupState` already carries `ends_at`/`seconds_total`, and a
    // held wrap-up re-pushes the wrapup frame while the state frame does not fire
    // again — so a countdown copied onto the state frame would be the stale one.
    const stations = fakeStations();
    const w = new WrapupManager(stations as any, fakeAgents() as any, vi.fn());
    await w.enter(enterParams({ wrapupSeconds: 30, autoReturn: true }));

    expect(Object.keys(stations.frames('agent_state')[0]!).sort()).toEqual(['event', 'since', 'state']);
    expect(stations.frames('wrapup')[0]!.wrapup.ends_at).not.toBeNull();
  });

  it('carries a queued break forward on the wrap-up state frame', async () => {
    // `pending_state` is on the FRAME and not only on the HTTP response because the
    // queue outlives the request. A break queued mid-call stays pending for the
    // whole wrap-up window — `releaseAgent` consumes it at the end — and this frame
    // is now the ONLY transition announcement in that window, so without this the
    // console cannot answer the one question the agent has while writing up: am I
    // getting another call after this?
    const stations = fakeStations();
    const w = new WrapupManager(stations as any, fakeAgents() as any, vi.fn());

    await w.enter(enterParams({ readPendingBreak: () => ({ code: 'lunch', label: 'Lunch' }) }));

    const frame = stations.frames('agent_state')[0]!;
    expect(frame.state).toBe('wrapup');
    expect(frame.pending_state).toBe('break');
    expect(frame.pending_break_reason).toBe('lunch');
  });

  it('omits pending_state entirely when no break is queued', async () => {
    // `undefined` means "nothing queued". A console that reads the field must not
    // see a stale or empty badge on the ordinary path.
    const stations = fakeStations();
    const w = new WrapupManager(stations as any, fakeAgents() as any, vi.fn());

    await w.enter(enterParams({ readPendingBreak: () => null }));

    const frame = stations.frames('agent_state')[0]!;
    expect('pending_state' in frame).toBe(false);
    expect('pending_break_reason' in frame).toBe(false);
  });

  // ── The break is read LAZILY, and this pair is why ─────────────────────────
  //
  // `enter` awaits three writes (the Redis agent state, the session mirror, the
  // attempt row) before it can announce the transition, and the break routes emit
  // their own `agent_state` frames. A value passed in at the top of the method is a
  // snapshot from before that window: the route's frame lands first, this one lands
  // afterwards carrying the older answer, and being last it wins.
  //
  // The registry is the same object in both directions, so the test drives the race
  // the way production does — by mutating it while an await is parked — rather than
  // by asserting that a function was called.

  it('reflects a break queued DURING its own awaited writes, not the value before them', async () => {
    const stations = fakeStations();
    let queued: { code: string; label: string } | null = null;
    // The route's `POST /sessions/:id/break` landing while `enter` is parked on the
    // session mirror. Any of the three awaits would do; this is the middle one.
    repos.session.setState.mockImplementationOnce(async () => {
      queued = { code: 'lunch', label: 'Lunch' };
    });
    const w = new WrapupManager(stations as any, fakeAgents() as any, vi.fn());

    await w.enter(enterParams({ readPendingBreak: () => queued }));

    const frame = stations.frames('agent_state')[0]!;
    expect(frame.pending_state, 'the badge the agent just asked for was cleared').toBe('break');
    expect(frame.pending_break_reason).toBe('lunch');
  });

  it('reflects a break CANCELLED during those writes, rather than resurrecting it', async () => {
    // The other direction, and the more damaging one: a resurrected badge tells an
    // agent they are going on break when `releaseAgent` will return them to
    // `available`, so the console and the pool disagree for the whole wrap-up.
    const stations = fakeStations();
    let queued: { code: string; label: string } | null = { code: 'lunch', label: 'Lunch' };
    repos.session.setState.mockImplementationOnce(async () => { queued = null; });
    const w = new WrapupManager(stations as any, fakeAgents() as any, vi.fn());

    await w.enter(enterParams({ readPendingBreak: () => queued }));

    const frame = stations.frames('agent_state')[0]!;
    expect('pending_state' in frame, 'a cancelled break was resurrected').toBe(false);
  });

  it('does not announce wrap-up when there is no wrap-up to enter', async () => {
    // `wrapup_seconds = 0` with no disposition returns `false`, and the caller sends
    // the agent straight to `available`. A `wrapup` state frame here would tell the
    // console to unlock a disposition pad for an attempt that never opened one.
    const stations = fakeStations();
    const w = new WrapupManager(stations as any, fakeAgents() as any, vi.fn());

    expect(await w.enter(enterParams({ wrapupSeconds: 0, requiresDisposition: false }))).toBe(false);
    expect(stations.frames('agent_state')).toHaveLength(0);
  });

  it('stop() clears timers without returning anyone to the pool', async () => {
    // Shutdown must not mark agents `available`: their sockets die with the
    // process and D2 lands them in `break` on reconnect. Returning them here would
    // be a lie the next boot inherits.
    const onReturn = vi.fn(async () => {});
    const w = new WrapupManager(fakeStations() as any, fakeAgents() as any, onReturn);
    await w.enter(enterParams({ wrapupSeconds: 10 }));

    w.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onReturn).not.toHaveBeenCalled();
    expect(w.active()).toBe(0);
  });
});

// ─── AD-P4-C-01: wrap-up becomes measurable ─────────────────────────────────
//
// `avg_wrapup_seconds` is the supervisor's tuning input for `wrapup_seconds`, so it
// is the one tile whose entire value is telling the operator their configured
// allotment is wrong. It could not be computed: `agency_call_attempts.wrapup_seconds`
// is the ALLOTMENT written at entry, so averaging it hands the config back to the
// person who set it — a tile that always agrees with you, which is worse than an
// absent one because it reads as measurement.
//
// These assert the two durable halves that make it a real measurement: the pair of
// anchors, and the resolution that says whether the interval is evidence at all.

describe('AD-P4-C-01: wrap-up end is recorded, and how it ended', () => {
  it('an agent returning early is recorded as `agent_returned`, not lost', async () => {
    const w = new WrapupManager(fakeStations() as any, fakeAgents() as any, vi.fn());
    await w.enter(enterParams());
    repos.attempt.setState.mockClear();

    w.cancel('s1', 'agent_returned');
    await vi.advanceTimersByTimeAsync(0);

    // `cancel()` used to write NOTHING, and this is the path the agent's own
    // go-available route takes. Submitting a disposition resolves the wrap-up
    // elsewhere, so reaching here means the agent simply finished early — the
    // FASTEST wrap-ups, and precisely the ones the average was blind to. Without
    // them it would have been built from agents who used their whole window and
    // argued for a longer allotment on evidence excluding everyone who needed less.
    expect(repos.attempt.setState).toHaveBeenCalledWith('att-1', 'ended', {
      wrapup_ended_at: expect.any(Date),
      wrapup_resolution: 'agent_returned',
    });
  });

  it('defaults to `agent_left` — the caller that is not returning anyone', async () => {
    const w = new WrapupManager(fakeStations() as any, fakeAgents() as any, vi.fn());
    await w.enter(enterParams());
    repos.attempt.setState.mockClear();

    w.cancel('s1');
    await vi.advanceTimersByTimeAsync(0);

    // The default must not be one of the three the average COUNTS, or a vanishing
    // agent would silently become evidence about how long wrap-up work takes.
    const patch = repos.attempt.setState.mock.calls[0]?.[2];
    expect(patch.wrapup_resolution).toBe('agent_left');
  });

  it('an auto-return records the timer as the reason, not a disposition', async () => {
    const w = new WrapupManager(fakeStations() as any, fakeAgents() as any, vi.fn(async () => {}));
    await w.enter(enterParams({ wrapupSeconds: 30, autoReturn: true }));
    repos.attempt.setState.mockClear();

    await vi.advanceTimersByTimeAsync(30_000);

    // `auto_return` and `agent_returned` are both counted, and both must be
    // distinguishable: one says the allotment is too SHORT, the other too LONG.
    // Collapsing them would leave the average unable to argue in either direction.
    const patch = repos.attempt.setState.mock.calls[0]?.[2];
    expect(patch.wrapup_resolution).toBe('auto_return');
    expect(patch.wrapup_ended_at).toBeInstanceOf(Date);
  });

  it('a failed write never strands the agent out of the pool', async () => {
    const onReturn = vi.fn(async () => {});
    const w = new WrapupManager(fakeStations() as any, fakeAgents() as any, onReturn);
    await w.enter(enterParams({ wrapupSeconds: 30, autoReturn: true }));
    repos.attempt.setState.mockRejectedValueOnce(new Error('pg down'));

    await vi.advanceTimersByTimeAsync(30_000);

    // The record is a statistic; returning the agent is a correctness property. An
    // agent held out of the pool because a stats column could not be written is a
    // strictly worse outcome than a gap in an average.
    expect(onReturn).toHaveBeenCalledWith('s1', 'auto_return');
  });
});

// ===========================================================================
// `agency_wrapup_seconds` — the duration series.
//
// Added after review pointed out that NOTHING asserted it, despite this file
// exercising `resolve()` and `cancel()` comprehensively. It is the same class of
// hole this PR already found on `agency_our_fault_retirement_total`, where
// disabling the counter outright broke no test: a stubbed `observe`, a wrong
// `resolution` label, or recording the configured allotment instead of the
// elapsed time would all have left the suite green.
//
// It matters more than a typical metric because of what it replaces: wrap-up is
// currently tuned from a single pilot's SQL average ("18.5s mean against a 30s
// window"), and this is the only time series for that number.
// ===========================================================================
describe('the wrap-up duration series', () => {
  it('records ELAPSED time, not the configured allotment', async () => {
    // ⚠️ The regression the reviewer named, and the one a careless refactor
    // actually invites: `wrapupSeconds` is right there in the entry, and
    // observing it instead of the elapsed interval would make every wrap-up look
    // exactly as long as its window — turning the series into a restatement of
    // the configuration and hiding the very thing it exists to measure.
    const before = await wrapupSeries('agent_returned');
    const w = new WrapupManager(fakeStations() as any, fakeAgents() as any, vi.fn());
    await w.enter(enterParams({ wrapupSeconds: 30 }));

    await vi.advanceTimersByTimeAsync(5_000);
    w.cancel('s1', 'agent_returned');
    await vi.advanceTimersByTimeAsync(0);

    const after = await wrapupSeries('agent_returned');
    expect(after.count - before.count).toBe(1);
    // ~5s elapsed against a 30s allotment. The window is the number NOT to see.
    expect(after.sum - before.sum).toBeGreaterThanOrEqual(4.5);
    expect(after.sum - before.sum).toBeLessThan(10);
  });

  it('labels an auto-return by its own resolution, with the full window elapsed', async () => {
    const before = await wrapupSeries('auto_return');
    const w = new WrapupManager(fakeStations() as any, fakeAgents() as any, vi.fn(async () => {}));
    await w.enter(enterParams({ wrapupSeconds: 30, autoReturn: true }));

    await vi.advanceTimersByTimeAsync(30_000);

    const after = await wrapupSeries('auto_return');
    expect(after.count - before.count).toBe(1);
    expect(after.sum - before.sum).toBeGreaterThanOrEqual(29.5);
  });

  it('records an interruption under a resolution the average must NOT count', async () => {
    // `agent_left` measures an interruption rather than how long write-up work
    // takes, which is exactly why the label is load-bearing: `AD-P4-C-01`
    // averages only `disposition_submitted`, `auto_return` and `agent_returned`.
    // An observation landing here under one of those three would quietly bias the
    // number a supervisor tunes the window from.
    const before = await wrapupSeries('agent_left');
    const w = new WrapupManager(fakeStations() as any, fakeAgents() as any, vi.fn());
    await w.enter(enterParams());

    await vi.advanceTimersByTimeAsync(3_000);
    w.cancel('s1');
    await vi.advanceTimersByTimeAsync(0);

    const after = await wrapupSeries('agent_left');
    expect(after.count - before.count).toBe(1);
  });

  it('still records the duration when the stats WRITE fails', async () => {
    // The ordering property, and deliberately the opposite of the retirement
    // counter's rule. That counter asserts "a contact was permanently retired" —
    // persisted state, so it must not fire on a write that did not take. This
    // asserts "an agent spent N seconds in wrap-up", which is true whether or not
    // the column landed. Gating it on the write would drop real seat time on
    // exactly the degraded-DB days when seat time is most diagnostic.
    const before = await wrapupSeries('auto_return');
    const w = new WrapupManager(fakeStations() as any, fakeAgents() as any, vi.fn(async () => {}));
    await w.enter(enterParams({ wrapupSeconds: 30, autoReturn: true }));
    repos.attempt.setState.mockRejectedValueOnce(new Error('pg down'));

    await vi.advanceTimersByTimeAsync(30_000);

    expect((await wrapupSeries('auto_return')).count - before.count).toBe(1);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// The device-away break (`reason: 'device_away'` on POST /sessions/:id/break), which the
// mobile app sends the moment it is backgrounded. It protects pacing and never overrides
// a choice the agent made: every agent state is pinned here, and so are the two races
// that matter — a reservation landing between the read and the write (the write is a
// CAS, so it loses and re-decides) and a release landing between the read and the
// queue (re-read, applied after all).
// ---------------------------------------------------------------------------

const { repos } = vi.hoisted(() => ({
  repos: { session: { setState: vi.fn().mockResolvedValue(undefined) } },
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyAgentSessionRepository: repos.session,
}));

import { BreakRegistry } from '@magick-agency/domain/break-manager';
import type { AgencyAgentState } from '@magick-agency/contracts/agency';
import {
  awayRingRefusal,
  BREAK_UNCHANGED_KEY,
  decideDeviceAway,
  isAppPauseBreakReason,
  runDeviceAway,
  takeBreakUnchanged,
} from '../../../src/api/routes/agency/device-away.js';
import { AGENT_LEASE_MS } from '../../../src/agency/agent-state-machine.js';
import type { AgencyRuntime } from '../../../src/agency/runtime.js';
import type { AgencyAgentSessionRecord } from '../../../src/db/models/agency.model.js';

const STATES: Array<AgencyAgentState | null> = ['available', 'reserved', 'on_call', 'wrapup', 'break', 'offline', null];

describe('decideDeviceAway — every state', () => {
  it.each([
    ['available', null, 'apply'],
    ['available', 'lunch', 'apply'],
    ['reserved', null, 'queue'],
    ['on_call', null, 'queue'],
    ['wrapup', null, 'queue'],
    ['reserved', 'device_away', 'unchanged'],
    ['on_call', 'device_away', 'unchanged'],
    ['wrapup', 'device_away', 'unchanged'],
    ['reserved', 'lunch', 'unchanged'],
    ['on_call', 'soft_phone', 'unchanged'],
    ['wrapup', 'meeting', 'unchanged'],
    ['break', null, 'unchanged'],
    ['offline', null, 'unchanged'],
    [null, null, 'unchanged'],
  ] as const)('a campaign session %s with %s queued → %s', (live, queued, expected) => {
    expect(decideDeviceAway({ campaignSession: true, live, queued })).toBe(expected);
  });

  it('a soft-phone session is never changed, whatever its state', () => {
    for (const live of STATES) {
      for (const queued of [null, 'device_away']) {
        expect(decideDeviceAway({ campaignSession: false, live, queued })).toBe('unchanged');
      }
    }
  });
});

describe('takeBreakUnchanged', () => {
  it('removes the marker and reports it; leaves any other body alone', () => {
    const body: Record<string, unknown> = { state: 'break', [BREAK_UNCHANGED_KEY]: true };
    expect(takeBreakUnchanged(body)).toBe(true);
    expect(body).toEqual({ state: 'break' });
    expect(takeBreakUnchanged(body)).toBe(false);
    for (const other of [null, undefined, 'x', 42, [], { state: 'break' }]) expect(takeBreakUnchanged(other)).toBe(false);
  });
});

// ─── runDeviceAway against a scripted runtime ────────────────────────────────

interface World {
  runtime: AgencyRuntime;
  /** What Redis says, read by `agents.get` and moved by a winning CAS. */
  lease: { state: AgencyAgentState; since: number } | null;
  breaks: BreakRegistry;
  sent: unknown[];
  transition: ReturnType<typeof vi.fn>;
  /** Run before the NEXT `agents.get` resolves: the race injector. */
  beforeRead: Array<() => void>;
  unannounced: boolean;
}

function world(state: AgencyAgentState | null, opts: { unannounced?: boolean } = {}): World {
  const w = {
    lease: state ? { state, since: Date.parse('2026-11-01T08:00:00Z') } : null,
    breaks: new BreakRegistry(),
    sent: [] as unknown[],
    beforeRead: [] as Array<() => void>,
    unannounced: opts.unannounced ?? false,
  } as World;
  w.transition = vi.fn(async (_id: string, from: AgencyAgentState, to: AgencyAgentState) => {
    if (w.lease?.state !== from) return false;
    w.lease = { state: to, since: Date.now() };
    return true;
  });
  w.runtime = {
    agents: {
      get: vi.fn(async () => {
        w.beforeRead.shift()?.();
        return w.lease ? { state: w.lease.state, attemptId: null, since: w.lease.since, manualCallId: null, softphone: false } : null;
      }),
      transition: w.transition,
    },
    breaks: w.breaks,
    stations: { send: vi.fn((_id: string, frame: unknown) => { w.sent.push(frame); return true; }) },
    dialer: { hasUnannouncedAttempt: vi.fn(() => w.unannounced) },
  } as unknown as AgencyRuntime;
  return w;
}

function session(o: Partial<AgencyAgentSessionRecord> = {}): AgencyAgentSessionRecord {
  return {
    id: 'sess-1', tenant_id: 't1', account_id: 'a1', kind: 'campaign', client_kind: 'mobile', campaign_id: 'camp-1',
    agent_user_id: 'u1', state: 'available', break_reason: null, state_since: new Date(), owner_replica: null,
    last_heartbeat: new Date(), joined_at: new Date(), left_at: null, created_at: new Date(), updated_at: new Date(),
    ...o,
  } as AgencyAgentSessionRecord;
}

beforeEach(() => vi.clearAllMocks());

describe('runDeviceAway', () => {
  it('available → break/device_away now: by CAS from available, the row mirrored, the agent told', async () => {
    const w = world('available');
    const res = await runDeviceAway(w.runtime, session());
    expect(res).toEqual({ ok: true, body: expect.objectContaining({ state: 'break', break_reason: 'device_away', kind: 'campaign', campaign_id: 'camp-1' }) });
    expect(res.ok && BREAK_UNCHANGED_KEY in res.body).toBe(false);
    expect(w.transition).toHaveBeenCalledWith('sess-1', 'available', 'break', { leaseMs: AGENT_LEASE_MS.break });
    expect(w.lease?.state).toBe('break');
    expect(repos.session.setState).toHaveBeenCalledWith('sess-1', 'break', 'device_away');
    expect(w.sent).toEqual([expect.objectContaining({ event: 'agent_state', state: 'break', break_reason: 'device_away' })]);
  });

  it.each(['reserved', 'on_call', 'wrapup'] as const)('%s → queued (pending_state), the lease untouched, the agent told', async (state) => {
    const w = world(state);
    const res = await runDeviceAway(w.runtime, session());
    expect(res).toEqual({ ok: true, body: expect.objectContaining({ state, pending_state: 'break', break_reason: 'device_away' }) });
    expect(res.ok && BREAK_UNCHANGED_KEY in res.body).toBe(false);
    expect(w.breaks.peek('sess-1')).toEqual({ code: 'device_away', label: 'Away (app in background)' });
    expect(w.transition).not.toHaveBeenCalled();
    expect(w.lease?.state).toBe(state);
    expect(repos.session.setState).not.toHaveBeenCalled();
    expect(w.sent).toEqual([{ event: 'agent_state', state, since: expect.any(String), pending_state: 'break', pending_break_reason: 'device_away' }]);
  });

  it('queued under an unannounced dial: the frame is suppressed, as for any break', async () => {
    const w = world('reserved', { unannounced: true });
    const res = await runDeviceAway(w.runtime, session());
    expect(res.ok && res.body.pending_state).toBe('break');
    expect(w.sent).toEqual([]);
  });

  it('already queued: idempotent, nothing re-sent, marked unchanged', async () => {
    const w = world('on_call');
    w.breaks.queue('sess-1', { code: 'device_away', label: 'Away (app in background)' });
    const res = await runDeviceAway(w.runtime, session());
    expect(res).toEqual({ ok: true, body: expect.objectContaining({ state: 'on_call', pending_state: 'break', break_reason: 'device_away', [BREAK_UNCHANGED_KEY]: true }) });
    expect(w.sent).toEqual([]);
  });

  it.each(['lunch', 'soft_phone'])('another break (%s) already queued is never replaced', async (code) => {
    const w = world('wrapup');
    w.breaks.queue('sess-1', { code, label: code });
    const res = await runDeviceAway(w.runtime, session());
    expect(res).toEqual({ ok: true, body: expect.objectContaining({ state: 'wrapup', pending_state: 'break', break_reason: code, [BREAK_UNCHANGED_KEY]: true }) });
    expect(w.breaks.peek('sess-1')?.code).toBe(code);
    expect(w.sent).toEqual([]);
  });

  it.each([
    ['lunch'], ['soft_phone'], [null],
  ])('already on break (%s): unchanged, the agent\'s reason stands, since is the lease\'s', async (reason) => {
    const w = world('break');
    const res = await runDeviceAway(w.runtime, session({ state: 'break', break_reason: reason }));
    expect(res).toEqual({
      ok: true,
      body: {
        session_id: 'sess-1', campaign_id: 'camp-1', kind: 'campaign', state: 'break',
        since: '2026-11-01T08:00:00.000Z',
        ...(reason ? { break_reason: reason } : {}),
        [BREAK_UNCHANGED_KEY]: true,
      },
    });
    expect(w.transition).not.toHaveBeenCalled();
    expect(repos.session.setState).not.toHaveBeenCalled();
    expect(w.sent).toEqual([]);
  });

  it('already on device_away: idempotent', async () => {
    const w = world('break');
    const res = await runDeviceAway(w.runtime, session({ state: 'break', break_reason: 'device_away' }));
    expect(res.ok && res.body).toMatchObject({ state: 'break', break_reason: 'device_away', [BREAK_UNCHANGED_KEY]: true });
  });

  it.each([['offline'], [null]] as const)('%s (no lease): unchanged, answered offline', async (state) => {
    const w = world(state);
    const res = await runDeviceAway(w.runtime, session({ state: 'available' }));
    expect(res.ok && res.body).toMatchObject({ state: 'offline', [BREAK_UNCHANGED_KEY]: true });
    expect(res.ok && 'break_reason' in res.body).toBe(false);
    expect(w.transition).not.toHaveBeenCalled();
    expect(w.breaks.size()).toBe(0);
  });

  it('a soft-phone session: unchanged in any state, never a write', async () => {
    for (const state of STATES) {
      const w = world(state);
      const res = await runDeviceAway(w.runtime, session({ kind: 'softphone', campaign_id: null, state: 'break', break_reason: 'soft_phone' }));
      expect(res.ok && res.body).toMatchObject({ kind: 'softphone', campaign_id: null, [BREAK_UNCHANGED_KEY]: true });
      expect(w.transition).not.toHaveBeenCalled();
      expect(w.breaks.size()).toBe(0);
    }
  });

  it('a reservation that lands between the read and the write wins: the CAS loses and it is queued instead', async () => {
    const w = world('available');
    // Pacing reserves the agent after our read but before our CAS.
    w.transition.mockImplementationOnce(async () => { w.lease = { state: 'reserved', since: Date.now() }; return false; });
    const res = await runDeviceAway(w.runtime, session());
    expect(w.lease?.state).toBe('reserved');
    expect(res.ok && res.body).toMatchObject({ state: 'reserved', pending_state: 'break', break_reason: 'device_away' });
    expect(res.ok && BREAK_UNCHANGED_KEY in res.body).toBe(false);
    expect(w.breaks.peek('sess-1')?.code).toBe('device_away');
    expect(repos.session.setState).not.toHaveBeenCalled();
  });

  it('a release that lands between the read and the queue: re-read, and applied after all', async () => {
    const w = world('wrapup');
    // First read says wrapup; the release (which found nothing queued) then makes the
    // agent available before the second read.
    w.beforeRead.push(() => undefined, () => { w.lease = { state: 'available', since: Date.now() }; });
    const res = await runDeviceAway(w.runtime, session());
    expect(res.ok && res.body).toMatchObject({ state: 'break', break_reason: 'device_away' });
    expect(w.lease?.state).toBe('break');
    // Ours was taken, so a later release cannot apply it a second time.
    expect(w.breaks.size()).toBe(0);
    expect(repos.session.setState).toHaveBeenCalledWith('sess-1', 'break', 'device_away');
  });

  it('a release that APPLIED ours between passes: answered as the break it became, and not marked unchanged', async () => {
    const w = world('wrapup');
    w.beforeRead.push(() => undefined, () => {
      w.breaks.take('sess-1');
      w.lease = { state: 'break', since: Date.now() };
    });
    const res = await runDeviceAway(w.runtime, session({ state: 'wrapup', break_reason: null }));
    expect(res.ok && res.body).toMatchObject({ state: 'break', break_reason: 'device_away' });
    expect(res.ok && BREAK_UNCHANGED_KEY in res.body).toBe(false);
  });

  it('a state that never holds still: refused (ok: false; the route answers 409 state_changing), and nothing written', async () => {
    const w = world('available');
    w.transition.mockResolvedValue(false);
    const res = await runDeviceAway(w.runtime, session());
    expect(res).toEqual({ ok: false });
    expect(w.transition).toHaveBeenCalledTimes(3);
    expect(repos.session.setState).not.toHaveBeenCalled();
    expect(w.sent).toEqual([]);
    expect(w.breaks.size()).toBe(0);
  });
});

// ─── IQ51: the cellular-call pause (`reason: 'phone_call'`), by the same rules ────

describe('the phone-call pause (IQ51): the device-away rules with its own code', () => {
  it('is one of the app`s pauses; nothing else is', () => {
    expect(isAppPauseBreakReason('device_away')).toBe(true);
    expect(isAppPauseBreakReason('phone_call')).toBe(true);
    expect(isAppPauseBreakReason('away_ring')).toBe(true);
    for (const other of ['soft_phone', 'lunch', '', null, undefined, 42]) expect(isAppPauseBreakReason(other)).toBe(false);
  });

  it('available → break/phone_call now, the row mirrored, the agent told', async () => {
    const w = world('available');
    const res = await runDeviceAway(w.runtime, session(), 'phone_call');
    expect(res).toEqual({ ok: true, body: expect.objectContaining({ state: 'break', break_reason: 'phone_call' }) });
    expect(repos.session.setState).toHaveBeenCalledWith('sess-1', 'break', 'phone_call');
    expect(w.sent).toEqual([expect.objectContaining({ event: 'agent_state', state: 'break', break_reason: 'phone_call' })]);
  });

  it.each(['reserved', 'on_call', 'wrapup'] as const)('%s → queued behind it with its own label', async (state) => {
    const w = world(state);
    const res = await runDeviceAway(w.runtime, session(), 'phone_call');
    expect(res).toEqual({ ok: true, body: expect.objectContaining({ state, pending_state: 'break', break_reason: 'phone_call' }) });
    expect(w.breaks.peek('sess-1')).toEqual({ code: 'phone_call', label: 'On a phone call' });
    expect(w.sent).toEqual([expect.objectContaining({ pending_break_reason: 'phone_call' })]);
  });

  it('never replaces a queued device_away, nor the reverse; already on it: idempotent', async () => {
    const w = world('wrapup');
    w.breaks.queue('sess-1', { code: 'device_away', label: 'Away (app in background)' });
    expect((await runDeviceAway(w.runtime, session(), 'phone_call'))).toEqual({
      ok: true, body: expect.objectContaining({ pending_state: 'break', break_reason: 'device_away', [BREAK_UNCHANGED_KEY]: true }),
    });
    const onDeviceAway = world('break');
    const res = await runDeviceAway(onDeviceAway.runtime, session({ state: 'break', break_reason: 'device_away' }), 'phone_call');
    expect(res.ok && res.body).toMatchObject({ state: 'break', break_reason: 'device_away', [BREAK_UNCHANGED_KEY]: true });
    const onIt = world('break');
    const again = await runDeviceAway(onIt.runtime, session({ state: 'break', break_reason: 'phone_call' }), 'phone_call');
    expect(again.ok && again.body).toMatchObject({ state: 'break', break_reason: 'phone_call', [BREAK_UNCHANGED_KEY]: true });
    expect(onIt.transition).not.toHaveBeenCalled();
  });

  it('a soft-phone session: unchanged, never a write', async () => {
    const w = world('break');
    const res = await runDeviceAway(w.runtime, session({ kind: 'softphone', campaign_id: null, state: 'break', break_reason: 'soft_phone' }), 'phone_call');
    expect(res.ok && res.body).toMatchObject({ kind: 'softphone', [BREAK_UNCHANGED_KEY]: true });
    expect(w.transition).not.toHaveBeenCalled();
  });
});

// ─── Mode B (IQ58, IQ67): `reason: 'away_ring'` and the device_away ↔ away_ring switch ───

describe('decideDeviceAway — Mode B', () => {
  it.each([
    // [code, live, ring, row reason, queued, expected]
    ['away_ring', 'available', false, null, null, 'apply'],
    ['away_ring', 'break', false, 'device_away', null, 'switch'],
    ['away_ring', 'break', true, 'away_ring', null, 'unchanged'],
    ['away_ring', 'break', false, 'lunch', null, 'unchanged'],
    ['away_ring', 'break', false, 'soft_phone', null, 'unchanged'],
    ['away_ring', 'break', false, 'phone_call', null, 'unchanged'],
    ['away_ring', 'wrapup', false, null, null, 'queue'],
    ['away_ring', 'wrapup', false, null, 'device_away', 'queue'],
    ['away_ring', 'on_call', false, null, 'away_ring', 'unchanged'],
    ['away_ring', 'reserved', false, null, 'lunch', 'unchanged'],
    ['away_ring', 'offline', false, null, null, 'unchanged'],
    ['device_away', 'break', true, 'away_ring', null, 'switch'],
    ['device_away', 'break', false, 'away_ring', null, 'unchanged'],
    ['device_away', 'wrapup', false, null, 'away_ring', 'queue'],
    ['phone_call', 'break', true, 'away_ring', null, 'unchanged'],
  ] as const)('%s on %s (ring %s, row %s, queued %s) → %s', (code, live, ring, breakReason, queued, expected) => {
    expect(decideDeviceAway({ campaignSession: true, live, queued, code, ring, breakReason })).toBe(expected);
  });

  it('a soft-phone session is never changed by away_ring either', () => {
    expect(decideDeviceAway({ campaignSession: false, live: 'available', queued: null, code: 'away_ring' })).toBe('unchanged');
  });
});

describe('runDeviceAway — away_ring', () => {
  /** The world, with the away-ring service scripted over its lease (`ring`). */
  function ringWorld(state: AgencyAgentState | null, opts: { refused?: string | null; ring?: boolean } = {}) {
    const w = world(state);
    let ring = opts.ring ?? false;
    const get = w.runtime.agents.get as ReturnType<typeof vi.fn>;
    get.mockImplementation(async () => {
      w.beforeRead.shift()?.();
      return w.lease ? { state: w.lease.state, attemptId: null, since: w.lease.since, manualCallId: null, softphone: false, inboundCallId: null, ring, pushOffer: false } : null;
    });
    const awayRing = {
      refusalFor: vi.fn(async () => opts.refused ?? null),
      enter: vi.fn(async (_s: unknown, from: readonly AgencyAgentState[]) => {
        if (!w.lease || !from.includes(w.lease.state)) return { ok: false, reason: 'wrong_state' };
        w.lease = { state: 'break', since: Date.now() };
        ring = true;
        return { ok: true, since: new Date().toISOString() };
      }),
      end: vi.fn(async () => {
        if (!(w.lease?.state === 'break' && ring)) return 'not_away_ring';
        ring = false;
        return 'ended';
      }),
    };
    (w.runtime as unknown as { awayRing: typeof awayRing }).awayRing = awayRing;
    return { w, awayRing, ring: () => ring };
  }

  it.each(['ring_not_allowed', 'no_push_device', 'ring_disabled', 'push_unavailable'] as const)(
    'refused %s: a typed 409, before any state is read or written', async (code) => {
      const { w, awayRing } = ringWorld('available', { refused: code });
      const res = await runDeviceAway(w.runtime, session(), 'away_ring');
      expect(res).toEqual({ ok: false, refused: { error: 'Conflict', code, message: expect.any(String) } });
      expect(w.runtime.agents.get).not.toHaveBeenCalled();
      expect(awayRing.enter).not.toHaveBeenCalled();
      expect(w.breaks.peek('sess-1')).toBeNull();
      expect(w.sent).toEqual([]);
    });

  it('available → away_ring now, through the service (Redis CAS, mirror, frame)', async () => {
    const { w, awayRing, ring } = ringWorld('available');
    const res = await runDeviceAway(w.runtime, session(), 'away_ring');
    expect(res).toEqual({ ok: true, body: expect.objectContaining({ state: 'break', break_reason: 'away_ring' }) });
    expect(awayRing.enter).toHaveBeenCalledWith(expect.objectContaining({ id: 'sess-1' }), ['available']);
    expect(ring()).toBe(true);
    expect(w.transition).not.toHaveBeenCalled();
  });

  it('device_away → away_ring is a break-to-break switch (from break only)', async () => {
    const { w, awayRing } = ringWorld('break');
    const res = await runDeviceAway(w.runtime, session({ state: 'break', break_reason: 'device_away' }), 'away_ring');
    expect(res).toEqual({ ok: true, body: expect.objectContaining({ state: 'break', break_reason: 'away_ring' }) });
    expect(awayRing.enter).toHaveBeenCalledWith(expect.anything(), ['break']);
  });

  it('a named catalog break never gains ring = 1: unchanged, nothing entered', async () => {
    const { w, awayRing, ring } = ringWorld('break');
    const res = await runDeviceAway(w.runtime, session({ state: 'break', break_reason: 'lunch' }), 'away_ring');
    expect(res.ok && res.body).toMatchObject({ state: 'break', break_reason: 'lunch', [BREAK_UNCHANGED_KEY]: true });
    expect(awayRing.enter).not.toHaveBeenCalled();
    expect(ring()).toBe(false);
  });

  it('already on away_ring: unchanged, answered as away_ring', async () => {
    const { w, awayRing } = ringWorld('break', { ring: true });
    const res = await runDeviceAway(w.runtime, session({ state: 'break', break_reason: 'away_ring' }), 'away_ring');
    expect(res.ok && res.body).toMatchObject({ state: 'break', break_reason: 'away_ring', [BREAK_UNCHANGED_KEY]: true });
    expect(awayRing.enter).not.toHaveBeenCalled();
  });

  it('in wrap-up: queued, replacing a queued device_away (the release applies it)', async () => {
    const { w } = ringWorld('wrapup');
    w.breaks.queue('sess-1', { code: 'device_away', label: 'Away' });
    const res = await runDeviceAway(w.runtime, session({ state: 'wrapup' }), 'away_ring');
    expect(res.ok && res.body).toMatchObject({ state: 'wrapup', pending_state: 'break', break_reason: 'away_ring' });
    expect(w.breaks.peek('sess-1')?.code).toBe('away_ring');
  });

  it('a lost compare-and-swap is re-decided: a reservation landing first queues it', async () => {
    const { w, awayRing } = ringWorld('available');
    w.beforeRead.push(() => undefined, () => { w.lease = { state: 'reserved', since: Date.now() }; });
    awayRing.enter.mockImplementationOnce(async () => {
      w.lease = { state: 'reserved', since: Date.now() };
      return { ok: false, reason: 'wrong_state' };
    });
    const res = await runDeviceAway(w.runtime, session(), 'away_ring');
    expect(res.ok && res.body).toMatchObject({ state: 'reserved', pending_state: 'break', break_reason: 'away_ring' });
  });

  it('device_away while on away_ring ends the ringing and keeps the pause (no ring_off: the app asked)', async () => {
    const { w, awayRing, ring } = ringWorld('break', { ring: true });
    const res = await runDeviceAway(w.runtime, session({ state: 'break', break_reason: 'away_ring' }), 'device_away');
    expect(res).toEqual({ ok: true, body: expect.objectContaining({ state: 'break', break_reason: 'device_away' }) });
    expect(awayRing.end).toHaveBeenCalledWith('sess-1', null, { offline: false });
    expect(ring()).toBe(false);
  });

  it('awayRingRefusal is the typed 409 body, and device_away still applies (the app\'s fallback)', async () => {
    expect(awayRingRefusal()).toMatchObject({ error: 'Conflict', code: 'ring_not_allowed' });
    expect(awayRingRefusal('ring_disabled')).toMatchObject({ code: 'ring_disabled' });
    const w = world('available');
    const res = await runDeviceAway(w.runtime, session(), 'device_away');
    expect(res).toEqual({ ok: true, body: expect.objectContaining({ state: 'break', break_reason: 'device_away' }) });
  });
});

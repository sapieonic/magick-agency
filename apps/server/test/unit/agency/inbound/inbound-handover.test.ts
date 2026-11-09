import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INBOUND_HANDOVER_TIMEOUT_MS,
  InboundHandovers,
  type HandoverCall,
  type HandoverHost,
} from '../../../../src/agency/inbound/inbound-handover.js';

/**
 * The in-flight clash's hand-over (docs/inbound.md §5.4) on its own, over a scripted host (the
 * connector's side): what is promised and refused, the backstop, the release hook's take (offered
 * when queued, held through the preamble, nothing when the CAS loses or the caller is leaving), and
 * letting a held session go. The connector's use of it runs on real Redis and Postgres in
 * `test/integration/agency/inbound-connector-races.test.ts`.
 */

type Phase = 'preamble' | 'queued' | 'offered' | 'connected' | 'leaving' | 'done';

interface FakeCall extends HandoverCall {
  phase: Phase;
  leaving: boolean;
}

function world() {
  const calls = new Map<string, FakeCall>();
  const offered = new Set<string>();
  const releasable = new Set<string>(['s1', 's2']);
  let stopped = false;
  const log: string[] = [];
  const reserveResult = { ok: true } as { ok: boolean };
  let offerResult: 'offered' | 'call_gone' | 'session_busy' = 'offered';
  const host: HandoverHost = {
    call: (id) => calls.get(id),
    offeredNow: (id) => offered.has(id),
    releasable: (s) => releasable.has(s),
    stopped: () => stopped,
    serial: async (id, fn) => { log.push(`serial:${id}`); return fn(); },
    reserve: vi.fn(async (s: string, id: string) => { log.push(`reserve:${s}:${id}`); return reserveResult as never; }),
    unreserve: vi.fn(async (s: string, id: string) => { log.push(`unreserve:${s}:${id}`); }),
    offer: vi.fn(async (id: string, s: string) => { log.push(`offer:${id}:${s}`); return offerResult; }),
    giveBack: vi.fn(async (s: string, id: string, why: string) => { log.push(`giveBack:${s}:${id}:${why}`); }),
    search: vi.fn((key: string) => { log.push(`search:${key}`); }),
    seat: vi.fn(async (id: string, s: string, u: string) => { log.push(`seat:${id}:${s}:${u}`); }),
    unseat: vi.fn((id: string, s: string) => { log.push(`unseat:${id}:${s}`); }),
    returnAgent: vi.fn((s: string) => { log.push(`return:${s}`); }),
  };
  const add = (id: string, phase: Phase = 'preamble'): FakeCall => {
    const c: FakeCall = { id, phase, leaving: false, accountKey: 't:a' };
    calls.set(id, c);
    return c;
  };
  return {
    host, calls, offered, releasable, log, add,
    stop: () => { stopped = true; },
    setReserve: (ok: boolean) => { reserveResult.ok = ok; },
    setOffer: (r: typeof offerResult) => { offerResult = r; },
    handovers: new InboundHandovers(host),
  };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('expect: what may be promised', () => {
  it('promises a call in its preamble or queued (not on offer) to a session the release hook can take: one per call and per session', () => {
    const w = world();
    w.add('c1');
    w.add('c2', 'queued');
    expect(w.handovers.expect('s1', 'c1')).toBe(true);
    expect(w.handovers.of('c1')).toMatchObject({ sessionId: 's1', held: false });
    expect(w.handovers.hasPending('s1')).toBe(true);
    expect(w.handovers.expect('s1', 'c2')).toBe(false); // the session has one
    expect(w.handovers.expect('s2', 'c1')).toBe(false); // the call has one
    expect(w.handovers.expect('s2', 'c2')).toBe(true);
  });

  it('refuses, promising nothing: a session the hook can never take, a call not held, leaving, on offer, past its queue; or a stopped connector', () => {
    const w = world();
    w.add('c1');
    expect(w.handovers.expect('phone', 'c1')).toBe(false);
    expect(w.handovers.expect('s1', 'nope')).toBe(false);
    w.add('leaving').leaving = true;
    expect(w.handovers.expect('s1', 'leaving')).toBe(false);
    w.add('offered', 'queued');
    w.offered.add('offered');
    expect(w.handovers.expect('s1', 'offered')).toBe(false);
    w.add('connected', 'connected');
    expect(w.handovers.expect('s1', 'connected')).toBe(false);
    w.stop();
    expect(w.handovers.expect('s1', 'c1')).toBe(false);
    expect(w.handovers.hasPending('s1')).toBe(false);
    expect(w.handovers.of('c1')).toBeNull();
  });
});

describe('drop and the backstop', () => {
  it('the backstop drops a promise the release never took; a queued caller is searched for at once, one in its preamble is not', () => {
    const w = world();
    w.add('c1', 'queued');
    w.add('c2');
    w.handovers.expect('s1', 'c1');
    w.handovers.expect('s2', 'c2');
    vi.advanceTimersByTime(INBOUND_HANDOVER_TIMEOUT_MS - 1);
    expect(w.handovers.of('c1')).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(w.handovers.of('c1')).toBeNull();
    expect(w.handovers.of('c2')).toBeNull();
    expect(w.handovers.hasPending('s1')).toBe(false);
    expect(w.log.filter((l) => l.startsWith('search:'))).toEqual(['search:t:a']);
  });

  it('drop is a no-op for a session with nothing pending, and once the release took it (held)', async () => {
    const w = world();
    w.add('c1');
    w.handovers.drop('s1');
    w.handovers.expect('s1', 'c1');
    expect(await w.handovers.take('s1', 'u1')).toBe(true);
    w.handovers.drop('s1');
    expect(w.handovers.isHeldFor('c1', 's1')).toBe(true);
  });

  it('clearTimers (the connector`s stop): no backstop fires afterwards', () => {
    const w = world();
    w.add('c1', 'queued');
    w.handovers.expect('s1', 'c1');
    w.handovers.clearTimers();
    vi.advanceTimersByTime(INBOUND_HANDOVER_TIMEOUT_MS * 2);
    expect(w.handovers.of('c1')).not.toBeNull();
  });
});

describe('take: the release hook', () => {
  it('nothing pending: false, nothing reserved', async () => {
    const w = world();
    expect(await w.handovers.take('s1', 'u1')).toBe(false);
    expect(w.host.reserve).not.toHaveBeenCalled();
  });

  it('a queued call: reserved, then offered on the call`s chain; the hand-over spent', async () => {
    const w = world();
    w.add('c1', 'queued');
    w.handovers.expect('s1', 'c1');
    expect(await w.handovers.take('s1', 'u1')).toBe(true);
    expect(w.log).toEqual(['reserve:s1:c1', 'serial:c1', 'offer:c1:s1']);
    expect(w.handovers.of('c1')).toBeNull();
    expect(w.handovers.hasPending('s1')).toBe(false);
    vi.advanceTimersByTime(INBOUND_HANDOVER_TIMEOUT_MS); // its timer is gone with it
    expect(w.host.search).not.toHaveBeenCalled();
  });

  it('a queued call whose offer is refused: the reservation given back, false', async () => {
    const w = world();
    w.add('c1', 'queued');
    w.setOffer('session_busy');
    w.handovers.expect('s1', 'c1');
    expect(await w.handovers.take('s1', 'u1')).toBe(false);
    expect(w.log.at(-1)).toBe('giveBack:s1:c1:session_busy');
  });

  it('a call in its preamble: the session held for it (seated), offered later by the connector (takeHeld)', async () => {
    const w = world();
    w.add('c1');
    w.handovers.expect('s1', 'c1');
    expect(await w.handovers.take('s1', 'u1')).toBe(true);
    expect(w.log).toEqual(['reserve:s1:c1', 'serial:c1', 'seat:c1:s1:u1']);
    expect(w.handovers.isHeldFor('c1', 's1')).toBe(true);
    expect(w.handovers.isHeldFor('c1', 's2')).toBe(false);
    expect(w.handovers.hasPending('s1')).toBe(false);
    expect(w.handovers.takeHeld('c1')).toBe('s1');
    expect(w.handovers.of('c1')).toBeNull();
    expect(w.handovers.takeHeld('c1')).toBeNull();
  });

  it('the CAS lost: false, the promise gone, a queued caller searched for', async () => {
    const w = world();
    w.add('c1', 'queued');
    w.setReserve(false);
    w.handovers.expect('s1', 'c1');
    expect(await w.handovers.take('s1', 'u1')).toBe(false);
    expect(w.handovers.of('c1')).toBeNull();
    expect(w.log).toEqual(['reserve:s1:c1', 'search:t:a']);
  });

  it('the caller leaving meanwhile: the reservation undone at once, never waited for on their chain', async () => {
    const w = world();
    const c = w.add('c1', 'queued');
    w.handovers.expect('s1', 'c1');
    c.leaving = true;
    expect(await w.handovers.take('s1', 'u1')).toBe(false);
    expect(w.log).toEqual(['reserve:s1:c1', 'unreserve:s1:c1']);
  });

  it('a call already past its queue on the chain (offered elsewhere, ended): the reservation undone, false', async () => {
    const w = world();
    const c = w.add('c1', 'queued');
    w.handovers.expect('s1', 'c1');
    const host = w.host as { serial: HandoverHost['serial'] };
    const serial = host.serial;
    host.serial = (id, fn) => { c.phase = 'done'; return serial(id, fn); };
    expect(await w.handovers.take('s1', 'u1')).toBe(false);
    expect(w.log.at(-1)).toBe('unreserve:s1:c1');
    expect(w.handovers.of('c1')).toBeNull();
  });
});

describe('release and forget', () => {
  it('a held session let go: unseated, the field cleared and, when asked, the agent returned', async () => {
    const w = world();
    w.add('c1');
    w.handovers.expect('s1', 'c1');
    await w.handovers.take('s1', 'u1');
    w.log.length = 0;
    await w.handovers.release('c1', { returnAgent: true });
    expect(w.log).toEqual(['unseat:c1:s1', 'unreserve:s1:c1', 'return:s1']);
    expect(w.handovers.of('c1')).toBeNull();
    await w.handovers.release('c1', { returnAgent: true }); // nothing left
    expect(w.log).toHaveLength(3);
  });

  it('a promise not yet taken: just dropped (no reservation to undo), its session free for another', async () => {
    const w = world();
    w.add('c1');
    w.add('c2');
    w.handovers.expect('s1', 'c1');
    await w.handovers.release('c1', { returnAgent: false });
    expect(w.log).toEqual([]);
    expect(w.handovers.hasPending('s1')).toBe(false);
    expect(w.handovers.expect('s1', 'c2')).toBe(true);
  });

  it('forget (the call left): the promise and its timer gone', () => {
    const w = world();
    w.add('c1', 'queued');
    w.handovers.expect('s1', 'c1');
    w.handovers.forget('c1');
    expect(w.handovers.of('c1')).toBeNull();
    expect(w.handovers.hasPending('s1')).toBe(false);
    vi.advanceTimersByTime(INBOUND_HANDOVER_TIMEOUT_MS);
    expect(w.host.search).not.toHaveBeenCalled();
  });
});

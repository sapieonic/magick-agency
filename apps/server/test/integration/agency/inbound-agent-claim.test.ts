import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { closeTestRedis, flushTestRedis, getTestRedis } from '../setup/test-utils.js';
import { TEST_REDIS_URL } from '../../helpers/test-redis.js';

const { AgentStateMachine, AGENT_LEASE_MS } = await import('../../../src/agency/agent-state-machine.js');

/*
 * The inbound call's reservation and the `available` guard (docs/inbound.md §2, §6, P2), against
 * REAL Redis running the REAL Lua: the unit tier's Redis doubles match on script text and cannot
 * say anything about atomicity.
 *
 * Claims under test:
 *  - `reserveForInbound` takes the agent only from the states asked for, only with no soft-phone
 *    call, not a soft-phone session, and no other inbound call; it writes `reserved`, clears the
 *    attempt, stamps `since` and the `reserved_dialing` lease; idempotent for its own id;
 *  - the field survives every later move (on_call, wrapup, break), renew and the heartbeat;
 *  - every write to `available` (`set`, the CAS) refuses `-3` while it is set, and an attempt's
 *    reservation (a CAS to `reserved`) refuses too;
 *  - `releaseInbound` clears only the id that holds it;
 *  - the rehydrate lands an owed call in `break` (lapsed / offline / available) with the field
 *    re-claimed, and keeps any other live state;
 *  - an inbound reservation and a pacing reservation racing for one available agent: exactly one
 *    wins; 64 inbound calls racing for one agent: exactly one wins.
 */

const key = (sessionId: string): string => `agency:agent:${sessionId}:state`;

describe('inbound reservation and the available guard (integration, real Lua)', () => {
  beforeEach(flushTestRedis);
  afterAll(closeTestRedis);

  it('reserves an available agent: reserved, no attempt, the inbound field, a fresh since and the dialing lease', async () => {
    const sm = new AgentStateMachine(getTestRedis(), '');
    const s = randomUUID();
    await sm.set(s, 'available');
    const before = (await sm.get(s))!.since!;
    await new Promise((r) => setTimeout(r, 5));
    expect(await sm.reserveForInbound(s, 'ib-1', ['available'])).toEqual({ ok: true, from: 'available' });
    const live = (await sm.get(s))!;
    expect(live).toMatchObject({ state: 'reserved', attemptId: null, inboundCallId: 'ib-1' });
    expect(live.since!).toBeGreaterThan(before);
    const ttl = await getTestRedis().pttl(key(s));
    expect(ttl).toBeGreaterThan(AGENT_LEASE_MS.reserved_predial);
    expect(ttl).toBeLessThanOrEqual(AGENT_LEASE_MS.reserved_dialing);
    expect(await sm.inboundCallOf(s)).toBe('ib-1');
    // Idempotent for its own id: nothing written, the state now answered.
    expect(await sm.reserveForInbound(s, 'ib-1', ['available'])).toEqual({ ok: true, from: 'reserved' });
  });

  it('takes the agent from each state the release hook asks for, and from no other', async () => {
    const sm = new AgentStateMachine(getTestRedis(), '');
    for (const from of ['reserved', 'on_call', 'wrapup'] as const) {
      const s = randomUUID();
      await sm.set(s, from, { attemptId: from === 'wrapup' ? 'att-1' : 'att-2' });
      expect(await sm.reserveForInbound(s, 'ib-1', ['available'])).toEqual({ ok: false, reason: 'wrong_state', state: from });
      expect(await sm.reserveForInbound(s, 'ib-1', ['reserved', 'on_call', 'wrapup'])).toEqual({ ok: true, from });
      expect(await sm.get(s)).toMatchObject({ state: 'reserved', attemptId: null, inboundCallId: 'ib-1' });
    }
    for (const state of ['break', 'offline'] as const) {
      const s = randomUUID();
      await sm.set(s, state);
      expect(await sm.reserveForInbound(s, 'ib-1', ['available', 'reserved', 'on_call', 'wrapup']))
        .toEqual({ ok: false, reason: 'wrong_state', state });
      expect(await sm.inboundCallOf(s)).toBeNull();
    }
    // No lease at all: never resurrected.
    const gone = randomUUID();
    expect(await sm.reserveForInbound(gone, 'ib-1', ['available'])).toEqual({ ok: false, reason: 'wrong_state', state: null });
    expect(await getTestRedis().exists(key(gone))).toBe(0);
    expect(await sm.reserveForInbound(gone, 'ib-1', [])).toEqual({ ok: false, reason: 'wrong_state', state: null });
  });

  it('refuses a session holding a soft-phone call, a soft-phone session, and one another inbound call holds', async () => {
    const sm = new AgentStateMachine(getTestRedis(), '');
    // A soft-phone call is held only on `break`, which is never a from-state; a stale claim on a
    // state that is (a lapse rewrote the state) still refuses.
    const manual = randomUUID();
    await getTestRedis().hset(key(manual), 'state', 'available', 'manual', 'm1');
    expect(await sm.reserveForInbound(manual, 'ib-1', ['available'])).toEqual({ ok: false, reason: 'manual_call_live' });
    const softphone = randomUUID();
    await getTestRedis().hset(key(softphone), 'state', 'wrapup', 'softphone', '1');
    expect(await sm.reserveForInbound(softphone, 'ib-1', ['wrapup'])).toEqual({ ok: false, reason: 'softphone_session' });
    const held = randomUUID();
    await sm.set(held, 'available');
    await sm.reserveForInbound(held, 'ib-1', ['available']);
    expect(await sm.reserveForInbound(held, 'ib-2', ['available', 'reserved'])).toEqual({ ok: false, reason: 'held', heldBy: 'ib-1' });
    expect(await sm.get(held)).toMatchObject({ state: 'reserved', inboundCallId: 'ib-1' });
  });

  it('refuses available while the field is set, through set AND the CAS; other moves keep it', async () => {
    const sm = new AgentStateMachine(getTestRedis(), '');
    const s = randomUUID();
    await sm.set(s, 'available');
    await sm.reserveForInbound(s, 'ib-1', ['available']);
    expect(await sm.set(s, 'available')).toBe('inbound_call_owed');
    expect(await sm.transition(s, 'reserved', 'available', { leaseMs: AGENT_LEASE_MS.available })).toBe(false);
    expect((await sm.get(s))?.state).toBe('reserved');

    // The call connects, ends and owes its outcome: the field rides through each move.
    expect(await sm.transition(s, 'reserved', 'on_call', { leaseMs: AGENT_LEASE_MS.on_call })).toBe(true);
    expect(await sm.set(s, 'wrapup', { leaseMs: AGENT_LEASE_MS.wrapup })).toBe('ok');
    expect(await sm.renew(s, 'wrapup', AGENT_LEASE_MS.wrapup)).toBe(true);
    expect(await sm.set(s, 'break')).toBe('ok');
    expect(await sm.set(s, 'offline')).toBe('ok');
    expect(await sm.inboundCallOf(s)).toBe('ib-1');
    expect(await sm.set(s, 'available')).toBe('inbound_call_owed');
    expect(await sm.transition(s, 'offline', 'available', { leaseMs: 1_000 })).toBe(false);

    await sm.releaseInbound(s, 'ib-1');
    expect(await sm.set(s, 'available')).toBe('ok');
  });

  it('no attempt can be reserved onto a session an inbound call holds (pacing, the redial, the dial-time extension)', async () => {
    const sm = new AgentStateMachine(getTestRedis(), '');
    const s = randomUUID();
    // A stale field on an available agent (a lapse rewrote the state): pacing's CAS still refuses.
    await getTestRedis().hset(key(s), 'state', 'available', 'inbound', 'ib-1');
    expect(await sm.reserve(s, 'att-1')).toBe('lost');
    const w = randomUUID();
    await sm.set(w, 'available');
    await sm.reserveForInbound(w, 'ib-2', ['available']);
    await sm.transition(w, 'reserved', 'on_call', { leaseMs: AGENT_LEASE_MS.on_call });
    await sm.set(w, 'wrapup', { leaseMs: AGENT_LEASE_MS.wrapup });
    expect(await sm.reserveFromWrapup(w, 'att-2')).toBe('lost');
    // The dial-time lease extension (reserved → reserved with the attempt) refuses too.
    const r = randomUUID();
    await getTestRedis().hset(key(r), 'state', 'reserved', 'attempt', 'att-3', 'inbound', 'ib-3');
    expect(await sm.transition(r, 'reserved', 'reserved', { attemptId: 'att-3', leaseMs: AGENT_LEASE_MS.reserved_dialing })).toBe(false);
    // Without the field each of them is the ordinary CAS.
    const plain = randomUUID();
    await sm.set(plain, 'available');
    expect(await sm.reserve(plain, 'att-4')).toBe('reserved');
  });

  it('releases only for the id that holds the field', async () => {
    const sm = new AgentStateMachine(getTestRedis(), '');
    const s = randomUUID();
    await sm.set(s, 'available');
    await sm.reserveForInbound(s, 'ib-1', ['available']);
    expect(await sm.releaseInbound(s, 'ib-2')).toBe(false);
    expect(await sm.inboundCallOf(s)).toBe('ib-1');
    expect(await sm.releaseInbound(s, 'ib-1')).toBe(true);
    expect(await sm.inboundCallOf(s)).toBeNull();
    expect(await sm.releaseInbound(s, 'ib-1')).toBe(false);
    // Releasing moves no state: the agent is returned by the caller.
    expect((await sm.get(s))?.state).toBe('reserved');
  });

  it('rehydrate: a lapsed, offline or available lease becomes break with the call re-claimed; another live state is kept', async () => {
    const sm = new AgentStateMachine(getTestRedis(), '');
    const lapsed = randomUUID();
    expect(await sm.rehydrateInbound(lapsed, 'ib-9')).toEqual({ state: 'break', changed: true });
    expect(await sm.inboundCallOf(lapsed)).toBe('ib-9');
    expect(await getTestRedis().pttl(key(lapsed))).toBeGreaterThan(0);
    expect(await sm.set(lapsed, 'available')).toBe('inbound_call_owed');

    for (const state of ['offline', 'available'] as const) {
      const s = randomUUID();
      await sm.set(s, state);
      expect(await sm.rehydrateInbound(s, 'ib-9')).toEqual({ state: 'break', changed: true });
    }

    const wrapping = randomUUID();
    await sm.set(wrapping, 'wrapup');
    expect(await sm.rehydrateInbound(wrapping, 'ib-9')).toEqual({ state: 'wrapup', changed: false });
    expect(await sm.inboundCallOf(wrapping)).toBe('ib-9');

    // The database is the authority: a stale id in the field is replaced by the owed one.
    const stale = randomUUID();
    await getTestRedis().hset(key(stale), 'state', 'break', 'inbound', 'ib-old');
    await sm.rehydrateInbound(stale, 'ib-9');
    expect(await sm.inboundCallOf(stale)).toBe('ib-9');
  });

  it('an inbound offer and a pacing reservation racing for one available agent: exactly one wins', async () => {
    const clients = Array.from({ length: 2 }, () => new Redis(TEST_REDIS_URL));
    try {
      let inboundWins = 0;
      for (let round = 0; round < 100; round++) {
        const s = randomUUID();
        await new AgentStateMachine(getTestRedis(), '').set(s, 'available');
        const [inbound, pacing] = clients.map((c) => new AgentStateMachine(c, ''));
        // Each side goes first on alternate rounds, on its own connection.
        const offerP = () => inbound!.reserveForInbound(s, `ib-${round}`, ['available']);
        const reserveP = () => pacing!.reserve(s, `att-${round}`);
        const [offer, reserved] = round % 2 === 0
          ? await Promise.all([offerP(), reserveP()])
          : await Promise.all([reserveP(), offerP()]).then(([r, o]) => [o, r] as const);
        const live = await new AgentStateMachine(getTestRedis(), '').get(s);
        expect(offer.ok !== (reserved === 'reserved')).toBe(true);
        if (offer.ok) {
          inboundWins++;
          expect(live).toMatchObject({ state: 'reserved', attemptId: null, inboundCallId: `ib-${round}` });
        } else {
          expect(offer).toEqual({ ok: false, reason: 'wrong_state', state: 'reserved' });
          expect(live).toMatchObject({ state: 'reserved', attemptId: `att-${round}`, inboundCallId: null });
        }
      }
      // Both sides won some rounds, or the race was not a race.
      expect(inboundWins).toBeGreaterThan(0);
      expect(inboundWins).toBeLessThan(100);
    } finally {
      await Promise.all(clients.map((c) => c.quit()));
    }
  });

  it('64 inbound calls racing for one agent — exactly one wins, and the rest are told who holds it', async () => {
    const clients = Array.from({ length: 64 }, () => new Redis(TEST_REDIS_URL));
    try {
      const s = randomUUID();
      await new AgentStateMachine(getTestRedis(), '').set(s, 'wrapup');
      const results = await Promise.all(clients.map((c, i) => new AgentStateMachine(c, '').reserveForInbound(s, `ib-${i}`, ['wrapup'])));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      const holder = await new AgentStateMachine(getTestRedis(), '').inboundCallOf(s);
      for (const r of results) if (!r.ok) expect(r).toEqual({ ok: false, reason: 'held', heldBy: holder });
    } finally {
      await Promise.all(clients.map((c) => c.quit()));
    }
  });

  it('fails closed without Redis', async () => {
    const sm = new AgentStateMachine(null, '');
    expect(await sm.reserveForInbound('s', 'ib', ['available'])).toEqual({ ok: false, reason: 'unavailable' });
    expect(await sm.releaseInbound('s', 'ib')).toBe(false);
    expect(await sm.inboundCallOf('s')).toBeNull();
    expect(await sm.rehydrateInbound('s', 'ib')).toBeNull();
  });
});

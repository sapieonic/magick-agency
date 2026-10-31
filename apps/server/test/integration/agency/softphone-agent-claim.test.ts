import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { closeTestRedis, flushTestRedis, getTestRedis } from '../setup/test-utils.js';
import { TEST_REDIS_URL } from '../../helpers/test-redis.js';

const { AgentStateMachine, AGENT_LEASE_MS } = await import('../../../src/agency/agent-state-machine.js');

/*
 * The soft phone's session claim and the `available` guard (docs/softphone.md
 * §4.1 step 1), against REAL Redis running the REAL Lua: the unit tier's Redis
 * doubles match on script text and cannot say anything about atomicity.
 *
 * Claims under test:
 *  - `claimManual` needs `break` and an empty `manual`; it keeps the lease TTL.
 *  - `releaseManual` clears only the id that holds it.
 *  - every write to `available` (`set`, the CAS) refuses while `manual` is set or
 *    the session is a soft-phone session, inside the same script as the write;
 *  - the fields survive renew and every other transition;
 *  - a soft-phone-flavoured rehydrate lands in `break` and re-claims a live call.
 *  - a dial and an end-break racing on one session never leave it `available`
 *    while holding a manual call.
 */

const key = (sessionId: string): string => `agency:agent:${sessionId}:state`;

describe('soft-phone session claim and the available guard (integration, real Lua)', () => {
  beforeEach(flushTestRedis);
  afterAll(closeTestRedis);

  it('claims only from break, refuses a second call, and is idempotent for the holder', async () => {
    const sm = new AgentStateMachine(getTestRedis(), '');
    const s = randomUUID();
    expect(await sm.claimManual(s, 'm1')).toEqual({ ok: false, reason: 'not_on_break', state: null });

    await sm.set(s, 'available');
    expect(await sm.claimManual(s, 'm1')).toEqual({ ok: false, reason: 'not_on_break', state: 'available' });

    await sm.set(s, 'break', { leaseMs: AGENT_LEASE_MS.break });
    const ttlBefore = await getTestRedis().pttl(key(s));
    expect(await sm.claimManual(s, 'm1')).toEqual({ ok: true });
    expect(await sm.claimManual(s, 'm1')).toEqual({ ok: true });
    expect(await sm.claimManual(s, 'm2')).toEqual({ ok: false, reason: 'held', heldBy: 'm1' });
    // The lease is untouched by the claim (it only ever counts down).
    const ttlAfter = await getTestRedis().pttl(key(s));
    expect(ttlAfter).toBeGreaterThan(0);
    expect(ttlAfter).toBeLessThanOrEqual(ttlBefore);
    expect(await sm.manualCallOf(s)).toBe('m1');
    expect((await sm.get(s))?.manualCallId).toBe('m1');
  });

  it('releases only for the id that holds the claim', async () => {
    const sm = new AgentStateMachine(getTestRedis(), '');
    const s = randomUUID();
    await sm.set(s, 'break');
    await sm.claimManual(s, 'm1');
    expect(await sm.releaseManual(s, 'm2')).toBe(false);
    expect(await sm.manualCallOf(s)).toBe('m1');
    expect(await sm.releaseManual(s, 'm1')).toBe(true);
    expect(await sm.manualCallOf(s)).toBeNull();
    expect(await sm.releaseManual(s, 'm1')).toBe(false);
  });

  it('refuses available while the session holds a manual call, through set AND the CAS', async () => {
    const sm = new AgentStateMachine(getTestRedis(), '');
    const s = randomUUID();
    await sm.set(s, 'break');
    await sm.claimManual(s, 'm1');

    expect(await sm.set(s, 'available')).toBe('manual_call_live');
    expect(await sm.transition(s, 'break', 'available', { leaseMs: AGENT_LEASE_MS.available })).toBe(false);
    expect((await sm.get(s))?.state).toBe('break');

    // Other moves are not the guard's business, and keep the field.
    expect(await sm.set(s, 'offline')).toBe('ok');
    expect(await sm.manualCallOf(s)).toBe('m1');
    expect(await sm.set(s, 'break')).toBe('ok');

    await sm.releaseManual(s, 'm1');
    expect(await sm.set(s, 'available')).toBe('ok');
    expect((await sm.get(s))?.state).toBe('available');
  });

  it('the claim survives renew (the station heartbeat) and keeps the lease alive', async () => {
    const sm = new AgentStateMachine(getTestRedis(), '');
    const s = randomUUID();
    await sm.set(s, 'break', { leaseMs: 2_000 });
    await sm.claimManual(s, 'm1');
    expect(await sm.renew(s, 'break', AGENT_LEASE_MS.break)).toBe(true);
    expect(await getTestRedis().pttl(key(s))).toBeGreaterThan(2_000);
    expect(await sm.manualCallOf(s)).toBe('m1');
    expect(await sm.set(s, 'available')).toBe('manual_call_live');
  });

  it('a soft-phone session can never be available, even with no call', async () => {
    const sm = new AgentStateMachine(getTestRedis(), '');
    const s = randomUUID();
    const r = await sm.rehydrateSoftphone(s, { softphoneSession: true, unsettledManualCallId: null });
    expect(r).toEqual({ state: 'break', changed: true });
    expect((await sm.get(s))?.softphone).toBe(true);
    expect(await sm.set(s, 'available')).toBe('softphone_session');
    expect(await sm.transition(s, 'break', 'available', { leaseMs: 1_000 })).toBe(false);
    expect((await sm.get(s))?.state).toBe('break');
  });

  it('rehydrate: a lapsed or offline lease becomes break and re-claims the unsettled call; a live one is kept', async () => {
    const sm = new AgentStateMachine(getTestRedis(), '');
    const lapsed = randomUUID();
    expect(await sm.rehydrateSoftphone(lapsed, { softphoneSession: false, unsettledManualCallId: 'm9' }))
      .toEqual({ state: 'break', changed: true });
    expect(await sm.manualCallOf(lapsed)).toBe('m9');
    expect(await getTestRedis().pttl(key(lapsed))).toBeGreaterThan(0);

    const offline = randomUUID();
    await sm.set(offline, 'offline');
    expect(await sm.rehydrateSoftphone(offline, { softphoneSession: true, unsettledManualCallId: null }))
      .toEqual({ state: 'break', changed: true });

    // A live state other than offline is the authority and is left alone, and a
    // call is re-claimed on `break` only.
    const onCall = randomUUID();
    await sm.set(onCall, 'on_call');
    expect(await sm.rehydrateSoftphone(onCall, { softphoneSession: false, unsettledManualCallId: 'm7' }))
      .toEqual({ state: 'on_call', changed: false });
    expect(await sm.manualCallOf(onCall)).toBeNull();

    // An existing claim is never overwritten by a rehydrate.
    const held = randomUUID();
    await sm.set(held, 'break');
    await sm.claimManual(held, 'm1');
    await sm.rehydrateSoftphone(held, { softphoneSession: false, unsettledManualCallId: 'm2' });
    expect(await sm.manualCallOf(held)).toBe('m1');
  });

  it('a dial and an end-break racing on one session: never available while holding a call', async () => {
    const clients = Array.from({ length: 2 }, () => new Redis(TEST_REDIS_URL));
    try {
      for (let round = 0; round < 100; round++) {
        const s = randomUUID();
        await new AgentStateMachine(getTestRedis(), '').set(s, 'break');
        const [dialer, ender] = clients.map((c) => new AgentStateMachine(c, ''));
        const [claim, set] = await Promise.all([
          dialer!.claimManual(s, `m-${round}`),
          ender!.set(s, 'available'),
        ]);
        const live = await new AgentStateMachine(getTestRedis(), '').get(s);
        // Exactly one of the two won, and the loser's refusal names the winner.
        if (claim.ok) {
          expect(set).toBe('manual_call_live');
          expect(live?.state).toBe('break');
          expect(live?.manualCallId).toBe(`m-${round}`);
        } else {
          expect(set).toBe('ok');
          expect(claim).toEqual({ ok: false, reason: 'not_on_break', state: 'available' });
          expect(live?.state).toBe('available');
          expect(live?.manualCallId).toBeNull();
        }
      }
    } finally {
      await Promise.all(clients.map((c) => c.quit()));
    }
  });

  it('64 concurrent claims of one session for different calls — exactly one wins', async () => {
    const clients = Array.from({ length: 64 }, () => new Redis(TEST_REDIS_URL));
    try {
      const s = randomUUID();
      await new AgentStateMachine(getTestRedis(), '').set(s, 'break');
      const results = await Promise.all(clients.map((c, i) => new AgentStateMachine(c, '').claimManual(s, `m-${i}`)));
      const winners = results.filter((r) => r.ok);
      expect(winners).toHaveLength(1);
      const holder = await new AgentStateMachine(getTestRedis(), '').manualCallOf(s);
      for (const r of results) if (!r.ok) expect(r).toEqual({ ok: false, reason: 'held', heldBy: holder });
    } finally {
      await Promise.all(clients.map((c) => c.quit()));
    }
  });
});

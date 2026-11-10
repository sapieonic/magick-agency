import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * ─── AN INBOUND FLOOR UNDER CHAOS (docs/inbound.md §2, P2) ──────────────────────────────
 *
 * N callers ring one route while M agents work it on real station sockets, end to end through
 * the real server against the mock Plivo carrier: callers hang up at random (in the preamble,
 * while queued, on offer, mid-call) or wait to be overflowed; agents' stations drop at random
 * (during an offer, and mid-call with a reconnect inside the grace), agents hang up and save
 * their outcomes at random; a running campaign with dialable contacts keeps pacing busy beside
 * them, and some callers are sticky to an agent. Invariants, held throughout and at the end:
 *
 *  1. never two reservations on one agent (a session never holds two offered/connected calls;
 *     its Redis `inbound` field names the one it holds, and no attempt is reserved onto it then);
 *  2. every call ends exactly once (one `ended` per call from the bridge, one terminal row);
 *  3. every call that reached nobody has a Missed row;
 *  4. no stray `inbound` field in Redis once every outcome is saved;
 *  5. no pacing reservation of an agent while a caller sticky to them waits (allowing one second
 *     for a pacing tick already in flight when the caller queued: the bus is a hint, the CAS the
 *     authority, `pacing/invalidation-bus.ts`).
 *
 * `LOAD_SCALE` multiplies the callers; `LOAD_SEED` reproduces a run.
 */

const { env } = vi.hoisted(() => {
  const e = {
    FF_AGENCY_DIALER: 'true',
    PLIVO_WEBHOOK_BASE_URL: 'https://agency.test/api/v1/webhooks/plivo',
    VOICELINK_WEBHOOK_BASE_URL: 'https://agency.test/api/v1/webhooks/voicelink',
    PLIVO_REQUEST_TIMEOUT_MS: '3000',
    MAX_CONCURRENT_CALLS: '100000',
    RATE_LIMIT_WEBHOOK_MAX: '1000000',
    RATE_LIMIT_CARRIER_MEDIA_MAX: '1000000',
    LOG_LEVEL: 'warn',
  };
  Object.assign(process.env, e);
  return { env: e };
});

import { getTestPool } from '../../../../../../packages/db/test/helpers/test-db.js';
import { getAgencyRuntime } from '../../../../src/bootstrap/agency.js';
import type { WebRtcLifecycleEvent } from '../../../../src/core/webrtc-bridge-manager.js';
import { createRng, scaled, LOAD_SEED } from '../../../helpers/load-scale.js';
import type { PlivoCall, PlivoCallStep } from '../../../mocks/plivo/index.js';
import type { FleetAgent } from '../../../mocks/station-fleet.js';
import { PLIVO_E2E_ENV, closePlivoDb, initPlivoDb, startPlivoRig, waitFor, type PlivoRig } from '../../telephony/plivo-rig.js';
import {
  SPEECH, agentUser, callers, campaign, contact, finish, goAvailable, joinAgent, liveOf, ring, setRoute, startInboundWorld,
  type InboundWorld,
} from '../../telephony/inbound-connect-rig.js';

const pool = () => getTestPool();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let rig: PlivoRig | null = null;
let world: InboundWorld;

beforeAll(() => {
  expect(env).toEqual(PLIVO_E2E_ENV);
  initPlivoDb();
});
beforeEach(async () => {
  callers.hangUpAll = false;
  rig = await startPlivoRig();
  world = await startInboundWorld(rig, { sticky_wait_seconds: 5, queue_max_wait_seconds: 20, max_waiting: 30, max_concurrent: 60 });
  // Pacing's dials ring briefly and go unanswered, so agents it reserves come back.
  (rig.carrier as unknown as { scriptFor: () => { name: string; steps: PlivoCallStep[] } }).scriptFor = () => ({
    name: 'no-answer', steps: [{ do: 'ring' }, { do: 'wait', ms: 300 }, { do: 'hangup', status: 'no-answer' }],
  });
});
afterEach(async () => {
  callers.hangUpAll = true;
  await world?.fleet.closeAll();
  await rig?.carrier.settled();
  await rig?.stop();
  rig = null;
});
afterAll(closePlivoDb);

interface CallerPlan {
  kind: 'early' | 'queued' | 'talk' | 'patient';
  ms: number;
}

describe('chaos: an inbound floor', () => {
  it(`holds every invariant over ${scaled(14)} callers and 4 agents (seed ${LOAD_SEED})`, async () => {
    const rng = createRng(LOAD_SEED);
    const runtime = getAgencyRuntime()!;
    const N = scaled(14);
    const campaignId = await campaign(world);
    const agents: FleetAgent[] = [];
    for (let i = 0; i < 4; i++) agents.push(await joinAgent(world, campaignId, { userId: await agentUser() }));
    // Callers 0..3 are each sticky to one agent (the contact's owner); the rest are strangers.
    const numberOf = (i: number) => `4477009${String(20_000 + i)}`;
    for (let i = 0; i < 4; i++) {
      await contact(campaignId, {
        phone_e164: `+${numberOf(i)}`, source_row_number: 10 + i, assigned_user_id: agents[i]!.agentUserId, assigned_at: new Date(),
        next_attempt_at: new Date(Date.now() + 86_400_000),
      });
    }
    for (let i = 0; i < 6; i++) {
      await contact(campaignId, { phone_e164: `+4477008${String(10_000 + i)}`, source_row_number: 50 + i, next_attempt_at: new Date(Date.now() - 1000) });
    }

    // Every `ended` the bridge emits for an inbound call.
    const endedEvents = new Map<string, number>();
    const unsubscribe = world.rig.bridge.onLifecycle((ev: WebRtcLifecycleEvent) => {
      if (ev.phase === 'ended' && ev.correlationId) endedEvents.set(ev.correlationId, (endedEvents.get(ev.correlationId) ?? 0) + 1);
    });

    // ── The sampler: invariant 1 at every instant ──────────────────────────────
    const violations: string[] = [];
    let sampling = true;
    const states = new Map<string, string>(); // callUuid → spine state
    const sampler = (async () => {
      while (sampling) {
        const { rows } = await pool().query<{ provider_call_id: string; state: string; session_id: string | null; id: string }>(
          'SELECT provider_call_id, state, session_id, id FROM agency_inbound_calls');
        const held = new Map<string, string[]>();
        for (const r of rows) {
          states.set(r.provider_call_id, r.state);
          if ((r.state === 'offered' || r.state === 'connected') && r.session_id) held.set(r.session_id, [...(held.get(r.session_id) ?? []), r.id]);
        }
        for (const [session, ids] of held) {
          if (ids.length > 1) violations.push(`session ${session} holds ${ids.join(', ')}`);
          const live = await runtime.agents.get(session);
          if (live?.inboundCallId && !ids.includes(live.inboundCallId) && live.inboundCallId !== null) {
            // The field may name the call that just ended (owed): only a field naming another LIVE call is wrong.
            const other = rows.find((r) => r.id === live.inboundCallId);
            if (other && (other.state === 'offered' || other.state === 'connected')) violations.push(`session ${session}: field ${live.inboundCallId} vs ${ids.join(',')}`);
          }
          if (live?.attemptId) violations.push(`session ${session} has attempt ${live.attemptId} while holding an inbound call`);
        }
        await sleep(40);
      }
    })();

    // ── The agents: drops, hang-ups, outcomes ──────────────────────────────────
    let agentsRunning = true;
    const saved = new Set<string>();
    const dropping = new Set<string>();
    const agentLoop = (async () => {
      const handled = new Set<string>();
      while (agentsRunning) {
        for (const a of agents) {
          if (dropping.has(a.sessionId)) continue;
          const { rows } = await pool().query<{ id: string; state: string; bridged_at: Date | null; settled_at: Date | null }>(
            'SELECT id, state, bridged_at, settled_at FROM agency_inbound_calls WHERE session_id = $1 AND settled_at IS NULL', [a.sessionId]);
          const call = rows[0];
          if (!call) continue;
          const key = `${call.id}:${call.state}`;
          if (handled.has(key)) continue;
          handled.add(key);
          const roll = rng.next();
          if (call.state === 'offered' && roll < 0.2) {
            // The station drops during the offer, and comes back a moment later.
            dropping.add(a.sessionId);
            a.leg!.terminate();
            void (async () => {
              await sleep(300 + rng.int(0, 400));
              await a.connectReady();
              await goAvailable(a);
              dropping.delete(a.sessionId);
            })();
          } else if (call.state === 'connected' && roll < 0.15) {
            // A wifi blip mid-call: back inside the 8 s grace.
            dropping.add(a.sessionId);
            a.leg!.terminate();
            void (async () => {
              await sleep(500 + rng.int(0, 1000));
              await a.connectReady();
              dropping.delete(a.sessionId);
            })();
          } else if (call.state === 'connected' && roll < 0.45) {
            void (async () => {
              await sleep(rng.int(200, 1500));
              await finish('POST', `${call.id}/hangup`, a.agentUserId);
            })();
          } else if (call.state === 'ended' && call.bridged_at && !saved.has(call.id)) {
            saved.add(call.id);
            void (async () => {
              await sleep(rng.int(100, 800));
              const code = rng.next() < 0.8 ? 'voicemail' : 'do_not_call';
              const res = await finish('POST', `${call.id}/disposition`, a.agentUserId, { code });
              if (res.status !== 200) violations.push(`outcome ${call.id}: ${res.status} ${JSON.stringify(res.body)}`);
              // An agent back on a break after a drop goes available again.
              if ((await liveOf(a.sessionId))?.state === 'break') await goAvailable(a);
            })();
          }
        }
        // Agents left offline or on a break by a drop that raced their call are put back.
        for (const a of agents) {
          if (dropping.has(a.sessionId) || !a.leg?.isOpen) continue;
          const live = await liveOf(a.sessionId);
          if ((!live || live.state === 'offline' || live.state === 'break') && !live?.inboundCallId) await goAvailable(a);
        }
        await sleep(60);
      }
    })();

    // ── The callers ────────────────────────────────────────────────────────────
    const placed: Array<{ call: PlivoCall; plan: CallerPlan }> = [];
    for (let i = 0; i < N; i++) {
      const roll = rng.next();
      const plan: CallerPlan = roll < 0.15 ? { kind: 'early', ms: rng.int(100, 400) }
        : roll < 0.4 ? { kind: 'queued', ms: rng.int(500, 4000) }
          : roll < 0.9 ? { kind: 'talk', ms: rng.int(300, 2500) }
            : { kind: 'patient', ms: 0 };
      let connectedAt = 0;
      const steps: PlivoCallStep[] = [
        { do: 'answer' }, { do: 'connect' }, { do: 'start' }, { do: 'mediaBackground', pattern: SPEECH },
        plan.kind === 'early' ? { do: 'wait', ms: plan.ms }
          : plan.kind === 'queued' ? { do: 'wait', ms: plan.ms }
            : plan.kind === 'talk'
              ? {
                do: 'waitFor', timeoutMs: 60_000, what: 'connected, then talk',
                until: (c) => {
                  if (c.hungUpByApi || callers.hangUpAll) return true;
                  if (states.get(c.callUuid) === 'connected' && !connectedAt) connectedAt = Date.now();
                  return (connectedAt > 0 && Date.now() - connectedAt > plan.ms) || states.get(c.callUuid) === 'ended';
                },
              }
              : { do: 'waitFor', timeoutMs: 60_000, what: 'our hangup', until: (c) => c.hungUpByApi || callers.hangUpAll },
        { do: 'hangup', status: 'completed', source: 'Caller' },
        { do: 'close' },
      ];
      placed.push({ call: ring(world, steps, i < 4 ? numberOf(i) : numberOf(100 + i)), plan });
      await sleep(rng.int(50, 400));
    }

    // ── Settle: every call ends, every outcome is saved ────────────────────────
    await waitFor('every call ended', async () => {
      const { rows } = await pool().query<{ n: number }>(`SELECT count(*)::int AS n FROM agency_inbound_calls WHERE state <> 'ended'`);
      return rows[0]!.n === 0 && placed.every((p) => p.call.callUuid) ? true : null;
    }, 120_000, async () => JSON.stringify((await pool().query('SELECT state, count(*) FROM agency_inbound_calls GROUP BY state')).rows));
    await waitFor('every owed outcome saved', async () => {
      const { rows } = await pool().query<{ n: number }>('SELECT count(*)::int AS n FROM agency_inbound_calls WHERE bridged_at IS NOT NULL AND settled_at IS NULL');
      return rows[0]!.n === 0 ? true : null;
    }, 60_000);
    await Promise.all(placed.map((p) => p.call.done.catch(() => undefined)));
    agentsRunning = false;
    await agentLoop;
    await runtime.inbound!.drain();
    await sleep(300);
    sampling = false;
    await sampler;
    unsubscribe();

    const { rows: spine } = await pool().query<{
      id: string; state: string; outcome: string | null; bridged_at: Date | null; settled_at: Date | null;
      follow_up_status: string | null; sticky_user_id: string | null; queued_at: Date | null; offered_at: Date | null; ended_at: Date | null;
    }>('SELECT id, state, outcome, bridged_at, settled_at, follow_up_status, sticky_user_id, queued_at, offered_at, ended_at FROM agency_inbound_calls');
    expect(spine).toHaveLength(N);

    // 1. Never two reservations on one agent (sampled throughout).
    expect(violations).toEqual([]);
    // 2. Every call ended exactly once: a terminal row, one `ended` from the bridge.
    for (const r of spine) {
      expect(r.state).toBe('ended');
      expect(r.settled_at).not.toBeNull();
      expect(endedEvents.get(r.id) ?? 0).toBeLessThanOrEqual(1);
    }
    // 3. Every unconnected call has its Missed row; every connected one none.
    for (const r of spine) {
      if (r.bridged_at === null) expect(r.follow_up_status, `${r.id} ${r.outcome}`).toBe('open');
      else expect(r).toMatchObject({ outcome: 'answered', follow_up_status: null });
    }
    // 4. No stray inbound field in Redis.
    for (const a of agents) expect((await runtime.agents.get(a.sessionId))?.inboundCallId ?? null).toBeNull();
    // 5. No attempt reserved onto an agent while a caller sticky to them waited (one second's grace).
    const { rows: attempts } = await pool().query<{ reserved_agent_id: string; created_at: Date }>(
      'SELECT reserved_agent_id, created_at FROM agency_call_attempts');
    for (const r of spine) {
      if (!r.sticky_user_id || !r.queued_at) continue;
      const sticky = agents.find((a) => a.agentUserId === r.sticky_user_id);
      if (!sticky) continue;
      const from = r.queued_at.getTime() + 1000;
      const to = (r.offered_at ?? r.ended_at)!.getTime();
      const during = attempts.filter((t) => t.reserved_agent_id === sticky.sessionId && t.created_at.getTime() > from && t.created_at.getTime() < to);
      expect(during, `attempt on ${sticky.label} while ${r.id} waited for them`).toEqual([]);
    }
    // The floor did connect callers and pacing did dial: the run exercised both.
    expect(spine.filter((r) => r.bridged_at !== null).length).toBeGreaterThan(0);
    expect(attempts.length).toBeGreaterThan(0);
  }, 300_000);
});

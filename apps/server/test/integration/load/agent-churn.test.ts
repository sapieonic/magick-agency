import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { scaled } from '../../helpers/load-scale.js';

await vi.hoisted(async () => {
  process.env['LOG_LEVEL'] ??= 'warn';
  const { installMetricReader } = await import('../../helpers/otel-metric-reader.js');
  installMetricReader();
});

vi.mock('@magick-agency/db', async () => {
  const { floorPool } = await import('./floor-pool.js');
  return { getPool: () => floorPool() };
});
vi.mock('@magick-agency/db/connection', async () => {
  const { floorPool } = await import('./floor-pool.js');
  return { getPool: () => floorPool() };
});
vi.mock('../../../src/config/index.js', () => ({
  config: { redis: { keyPrefix: '' }, telephony: {} },
}));

const { createFloorWorld, closeFloorPool, expectedDials, attemptRows } = await import('./floor-harness.js');
const { metricValue } = await import('../agency/chaos/harness.js');
const { refreshAbandonmentWindow } = await import('../../../src/agency/abandonment-metrics.js');
const { breachedRows } = await import('../../../src/agency/abandonment-guardrail.js');
const { agencyAbandonmentRepository } = await import('../../../src/db/repositories/agency.repository.js');
const { ABANDONED_ATTEMPT_PREDICATE_SQL } = await import('@magick-agency/domain/abandonment-predicate');

type World = Awaited<ReturnType<typeof createFloorWorld>>;
type Agent = World['agents'][number];

/**
 * ─── AGENT CHURN ON A BUSY FLOOR ────────────────────────────────────────────
 *
 * The floor of `floor-run.test.ts`, with the humans behaving like humans: every
 * round a seeded handful of agents go on break (at once when idle, QUEUED when on
 * a call), lose their station socket while idle, while ringing or while talking,
 * come back, leave for good, or join late. That is the traffic the pacing engine
 * actually sees, and every one of those transitions is a place a reservation can
 * be orphaned, an absent agent dialled into, or a released agent forgotten.
 *
 * Asserted every round, on top of the floor's invariants:
 *  - the pacing law stays EXACT as the pool changes under it — the tick dials
 *    `min(available, cap − live, claimable)` against the pool it can see now;
 *  - no attempt is reserved for an agent the test has taken off the floor (break,
 *    dropped station, left), and none for an agent whose queued break should have
 *    applied when their call ended.
 * And at the end:
 *  - every agent who came back was re-offered: dialled again within a few rounds;
 *  - a leave is refused while the agent holds a live attempt and honoured when idle,
 *    and a departed agent is never dialled again;
 *  - a call whose agent dropped mid-talk either resumed on re-attach (and ended
 *    `connected`) or was ended `agent_disconnected` by the lapsed window, with the
 *    contact requeued rather than lost;
 *  - an answer into a station lost mid-ring is `abandoned` (`station_lost`), the
 *    only abandonment source on this floor, and the counter agrees with the table;
 *  - the guardrail never leaves a breaching campaign running.
 */

describe('agent churn at floor scale (load)', () => {
  let world: World;

  beforeEach(truncateAll);
  afterEach(async () => {
    await world?.teardown();
    world = undefined as never;
  });
  afterAll(async () => {
    await closeFloorPool();
    await closeTestPool();
  });

  it('adapts pacing to a churning pool with no orphaned reservation and no dial into an absent agent', async () => {
    world = await createFloorWorld({
      campaigns: [
        { label: 'P', tenant: 't1', account: 'p1', agents: scaled(30), contacts: scaled(500), maxConcurrentCalls: scaled(30) },
        { label: 'Q', tenant: 't1', account: 'q1', agents: scaled(25), contacts: scaled(400), maxConcurrentCalls: scaled(20) },
        { label: 'R', tenant: 't2', account: 'r1', agents: scaled(25), contacts: scaled(400), maxConcurrentCalls: scaled(25) },
      ],
    });
    const { seed, rng, carrier } = world;
    const rt = world.runtime;
    const db = getTestPool();
    const violations: string[] = [];
    const tag = (round: number) => `[seed ${seed}, round ${round}]`;

    /** Agents the test has taken off the floor; they must not be reserved. */
    const away = new Map<string, string>();
    /** Agents whose break was queued behind a live call, keyed by that attempt. */
    const queuedBreak = new Map<string, string>();
    /** round → actions to run before that round. */
    const scheduled = new Map<number, Array<() => Promise<void>>>();
    const schedule = (round: number, fn: () => Promise<void>) => {
      scheduled.set(round, [...(scheduled.get(round) ?? []), fn]);
    };
    /** Every return to the pool, for the re-offer check. */
    const returns: Array<{ sessionId: string; label: string; campaignId: string; round: number; at: Date; pending: number }> = [];
    /**
     * The round the guardrail auto-paused each campaign, if it did. A mid-ring drop
     * whose call is then answered IS an abandoned call, so on a churning floor the
     * 3% ceiling can genuinely trip — and a paused campaign dials nobody, which the
     * re-offer check must not mistake for a forgotten agent.
     */
    const pausedAt = new Map<string, number>();
    const leftAt = new Map<string, number>();
    const refusedLeaves: string[] = [];
    const lateJoiners: Array<{ agent: Agent; round: number; pending: number }> = [];
    const midTalkExpired: string[] = [];
    const midTalkResumed: string[] = [];
    const ringDrops: string[] = [];
    const tally = { breakIdle: 0, breakQueued: 0, dropIdle: 0, dropRinging: 0, dropTalking: 0, leave: 0, join: 0 };

    const comeBack = async (a: Agent, round: number) => {
      if (!a.attached) {
        const { resumed } = await world.reconnect(a);
        if (resumed) {
          // Back onto a call that was still live: on the floor again, and busy.
          away.delete(a.sessionId);
          return;
        }
      }
      // The console offers Available only from `break` or `offline`. A return that
      // was scheduled twice (the end-of-churn sweep and the agent's own schedule)
      // can find the agent already back and on a new call; pressing Available then
      // is the route's announced-attempt gap, which the second case below pins on
      // its own rather than letting it surface here as noise.
      const live = await rt.agents.get(a.sessionId);
      if (live && live.state !== 'break' && live.state !== 'offline') {
        away.delete(a.sessionId);
        return;
      }
      if (await world.goAvailable(a)) {
        away.delete(a.sessionId);
        const { rows } = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM agency_contacts WHERE campaign_id = $1 AND state = 'pending'`, [a.campaignId]);
        returns.push({ sessionId: a.sessionId, label: a.label, campaignId: a.campaignId, round, at: new Date(), pending: rows[0]!.n });
      }
    };

    let round = 0;
    let roundStart = new Date(0);
    const churn = async () => {
      const present = world.agents.filter((a) => a.attached && !a.left && !away.has(a.sessionId) && !queuedBreak.has(a.sessionId));
      const states = await rt.agents.getMany(present.map((a) => a.sessionId));
      const idle = present.filter((_, i) => states[i]?.state === 'available');
      const calls = carrier.liveCalls().filter((c) => !c.browserGone);
      const byAgent = new Map(present.map((a) => [a.sessionId, a]));
      const talking = calls.filter((c) => c.phase === 'talking' && byAgent.has(c.sessionId));
      const ringing = calls.filter((c) => c.phase === 'ringing' && byAgent.has(c.sessionId));
      const take = <T>(xs: T[]): T | undefined => (xs.length === 0 ? undefined : xs.splice(rng.int(0, xs.length - 1), 1)[0]);

      if (rng.chance(0.6)) {
        const a = take(idle);
        if (a && (await world.goBreak(a)) === 'applied') {
          away.set(a.sessionId, 'break');
          tally.breakIdle++;
          schedule(round + rng.int(2, 6), () => comeBack(a, round));
        }
      }
      if (rng.chance(0.4)) {
        const c = take(talking);
        const a = c && byAgent.get(c.sessionId);
        if (c && a && (await world.goBreak(a)) === 'queued') {
          queuedBreak.set(a.sessionId, c.attemptId);
          tally.breakQueued++;
        }
      }
      if (rng.chance(0.4)) {
        const a = take(idle);
        if (a) {
          const r = await world.dropStation(a);
          if (r.attemptId !== null) violations.push(`${tag(round)} idle agent ${a.label} had live attempt ${r.attemptId}`);
          if (!r.wroteOffline) violations.push(`${tag(round)} idle drop of ${a.label} did not write offline`);
          away.set(a.sessionId, 'dropped');
          tally.dropIdle++;
          schedule(round + rng.int(1, 4), () => comeBack(a, round));
        }
      }
      if (rng.chance(0.25)) {
        const c = take(ringing);
        const a = c && byAgent.get(c.sessionId);
        if (c && a) {
          const r = await world.dropStation(a);
          if (r.wroteOffline) violations.push(`${tag(round)} mid-ring drop of ${a.label} wrote offline over a live attempt`);
          away.set(a.sessionId, 'dropped');
          ringDrops.push(c.attemptId);
          tally.dropRinging++;
          // Never back onto that attempt: the answer (if any) finds no station.
          schedule(round + rng.int(3, 5), () => comeBack(a, round));
        }
      }
      if (rng.chance(0.35)) {
        const c = take(talking);
        const a = c && byAgent.get(c.sessionId);
        if (c && a) {
          const r = await world.dropStation(a);
          if (!r.graceArmed) violations.push(`${tag(round)} mid-talk drop of ${a.label} armed no re-attach window`);
          if (r.wroteOffline) violations.push(`${tag(round)} mid-talk drop of ${a.label} wrote offline over a live call`);
          away.set(a.sessionId, 'dropped');
          tally.dropTalking++;
          if (rng.chance(0.5)) {
            // Back inside the window: the call resumes on the fresh socket.
            schedule(round + 1, async () => {
              const { resumed } = await world.reconnect(a);
              if (!resumed) violations.push(`${tag(round)} ${a.label} re-attached inside the window and resumed nothing`);
              else midTalkResumed.push(c.attemptId);
              away.delete(a.sessionId);
            });
          } else {
            schedule(round + 1, async () => {
              if (await carrier.expireGrace(c.attemptId)) midTalkExpired.push(c.attemptId);
              await carrier.endBarrier();
            });
            schedule(round + rng.int(2, 4), () => comeBack(a, round));
          }
        }
      }
      if (rng.chance(0.1)) {
        // A leave on a BUSY agent is refused, as the route refuses it.
        const c = talking[0];
        const busy = c && byAgent.get(c.sessionId);
        if (busy) {
          if (await world.leave(busy)) violations.push(`${tag(round)} ${busy.label} left while holding attempt ${c.attemptId}`);
          else refusedLeaves.push(busy.sessionId);
        }
        const a = take(idle);
        if (a && (await world.leave(a))) {
          away.set(a.sessionId, 'left');
          leftAt.set(a.sessionId, round);
          tally.leave++;
        }
      }
      if (rng.chance(0.15)) {
        const label = rng.pick(['P', 'Q', 'R']);
        const { rows } = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM agency_contacts WHERE campaign_id = $1 AND state = 'pending'`, [world.campaign(label).id]);
        lateJoiners.push({ agent: await world.joinLate(label), round, pending: rows[0]!.n });
        tally.join++;
      }
    };

    const rounds = await world.runUntilDrained({
      maxRounds: scaled(3000),
      onRound: async (r) => {
        round = r.round;
        violations.push(...await world.checkInvariants());
        for (const [label, s] of Object.entries(r.campaigns)) {
          const want = expectedDials(s);
          if (s.attemptsCreated !== want) {
            violations.push(`${tag(round)} ${label}: dialled ${s.attemptsCreated}, pacing law says ${want} `
              + `(available ${s.availableBefore}, live ${s.liveBefore}/${s.limit}, claimable ${s.claimableBefore})`);
          }
        }
        // Nobody off the floor was reserved this round.
        const { rows: created } = await db.query<{ id: string; reserved_agent_id: string }>(
          `SELECT id, reserved_agent_id FROM agency_call_attempts WHERE created_at >= $1`, [roundStart]);
        for (const a of created) {
          const why = away.get(a.reserved_agent_id);
          if (why) violations.push(`${tag(round)} attempt ${a.id} reserved an agent who is ${why}`);
          if (queuedBreak.has(a.reserved_agent_id) && queuedBreak.get(a.reserved_agent_id) !== a.id) {
            violations.push(`${tag(round)} attempt ${a.id} reserved an agent whose queued break should have applied`);
          }
        }
        // A queued break applies when its call ends: from then on the agent is in
        // `break`, and comes back on their own schedule.
        for (const [sessionId, attemptId] of [...queuedBreak]) {
          const live = await rt.agents.get(sessionId);
          const stillOn = carrier.liveCalls().some((c) => c.attemptId === attemptId);
          if (stillOn) continue;
          queuedBreak.delete(sessionId);
          const a = world.agents.find((x) => x.sessionId === sessionId)!;
          if (!a.attached) continue; // dropped meanwhile; the drop's own schedule brings them back
          if (live?.state !== 'break') {
            violations.push(`${tag(round)} ${a.label}'s queued break did not apply when ${attemptId} ended (reads ${live?.state})`);
            continue;
          }
          away.set(sessionId, 'break');
          schedule(round + rng.int(1, 4), () => comeBack(a, round));
        }
        if (round % 10 === 0) {
          await refreshAbandonmentWindow();
          for (const b of breachedRows(await agencyAbandonmentRepository.window24h())) {
            violations.push(`${tag(round)} campaign ${b.campaign_id} breached ${b.measured_pct}% and is still running`);
          }
          for (const c of world.campaigns) {
            if (!pausedAt.has(c.id) && (await world.status(c.spec.label)) === 'paused') pausedAt.set(c.id, round);
          }
        }
        if (violations.length > 0) throw new Error(violations.slice(0, 10).join('\n'));

        // Next round's churn and scheduled returns, between rounds — exactly where
        // a human's click lands relative to the tick.
        for (const fn of scheduled.get(round) ?? []) await fn();
        scheduled.delete(round);
        const { rows: work } = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM agency_contacts WHERE campaign_id = ANY($1::uuid[]) AND state = 'pending'`,
          [world.campaigns.map((c) => c.id)]);
        if (round >= 2 && work[0]!.n > 100) await churn();
        // Once the churn stops, everyone still away comes back so the rosters drain.
        if (work[0]!.n <= 100) {
          for (const a of world.agents) {
            if (a.left || queuedBreak.has(a.sessionId)) continue;
            if (away.has(a.sessionId)) await comeBack(a, round);
          }
        }
        roundStart = (await db.query<{ t: Date }>('SELECT now() AS t')).rows[0]!.t;
      },
    });

    expect(violations, violations.slice(0, 10).join('\n')).toEqual([]);
    const audit = await world.finalAudit();
    expect(audit, audit.slice(0, 20).join('\n')).toEqual([]);

    const ids = world.campaigns.map((c) => c.id);
    const rows = await attemptRows(ids);
    const summary = `seed ${seed}: ${JSON.stringify(tally)} rounds=${rounds} attempts=${rows.length} `
      + `autoPaused=${[...pausedAt].map(([id, r]) => `${world.campaigns.find((c) => c.id === id)!.spec.label}@${r}`).join(',') || 'none'}`;
    console.info(`[agent-churn] ${summary}`);

    // The churn genuinely happened, every kind of it.
    for (const [k, n] of Object.entries(tally)) expect(n, `${k} never happened — ${summary}`).toBeGreaterThan(0);
    expect(refusedLeaves.length, summary).toBeGreaterThan(0);

    // Released agents are re-offered: every agent who came back while their
    // campaign had plenty left to dial — and went on dialing for a while — was
    // reserved again afterwards. "Plenty" and "a while" are what make a miss mean
    // the agent was forgotten, rather than that the roster or the campaign ended.
    const { rows: byAgent } = await db.query<{ reserved_agent_id: string; n: number }>(
      `SELECT reserved_agent_id, count(*)::int AS n FROM agency_call_attempts WHERE campaign_id = ANY($1::uuid[]) GROUP BY 1`, [ids]);
    const callsPerAgent = new Map(byAgent.map((r) => [r.reserved_agent_id, r.n]));
    const stillDialing = (campaignId: string, fromRound: number) =>
      (pausedAt.get(campaignId) ?? Infinity) > fromRound + 15;
    const checkable = returns.filter((r) => r.pending > 40 && stillDialing(r.campaignId, r.round)
      && !world.agents.find((a) => a.sessionId === r.sessionId)!.left);
    expect(checkable.length, summary).toBeGreaterThan(10);
    for (const r of checkable) {
      const again = rows.some((x) => x.reserved_agent_id === r.sessionId && x.created_at > r.at);
      expect(again, `${r.label} came back in round ${r.round} and was never reserved again — ${summary}`).toBe(true);
    }

    // Late joiners work; departed agents are never dialled after they left.
    const joinersCheckable = lateJoiners.filter((j) => !j.agent.left && j.pending > 40 && stillDialing(j.agent.campaignId, j.round));
    expect(joinersCheckable.length, summary).toBeGreaterThan(0);
    for (const { agent: a } of joinersCheckable) {
      expect(callsPerAgent.get(a.sessionId) ?? 0, `late joiner ${a.label} never dialled — ${summary}`).toBeGreaterThan(0);
    }
    for (const [sessionId] of leftAt) {
      const { rows: after } = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM agency_call_attempts a JOIN agency_agent_sessions s ON s.id = a.reserved_agent_id
          WHERE a.reserved_agent_id = $1 AND a.created_at > s.left_at`, [sessionId]);
      expect(after[0]!.n, `a departed agent was dialled — ${summary}`).toBe(0);
    }

    // Mid-talk drops: a call re-attached inside the window resumed and ended
    // `connected`; one whose window lapsed ended `agent_disconnected`. The customer
    // WAS reached on that call (it bridged), so it is charged against their own
    // allowance — not the our-fault bound — and the contact is then either dialled
    // again or out of attempts by the policy. Never simply dropped.
    const outcomeOf = new Map(rows.map((r) => [r.id, r]));
    expect(midTalkResumed.length, summary).toBeGreaterThan(0);
    expect(midTalkExpired.length, summary).toBeGreaterThan(0);
    // A resumed call can be dropped AGAIN later and lapse that time; only the
    // calls whose last drop was resumed must end connected.
    for (const id of midTalkResumed.filter((x) => !midTalkExpired.includes(x))) {
      expect(outcomeOf.get(id)?.outcome, `resumed ${id} — ${summary}`).toBe('connected');
    }
    for (const id of midTalkExpired) {
      const a = outcomeOf.get(id)!;
      expect(a.outcome, `expired ${id} — ${summary}`).toBe('agent_disconnected');
      expect(a.bridged_at, `expired ${id} — ${summary}`).not.toBeNull();
      const later = rows.filter((r) => r.contact_id === a.contact_id && r.attempt_number > a.attempt_number);
      const { rows: [contact] } = await db.query<{ state: string; attempt_count: number }>(
        'SELECT state, attempt_count FROM agency_contacts WHERE id = $1', [a.contact_id]);
      const settled = later.length > 0 || contact!.state === 'exhausted'
        || (contact!.state === 'pending' && pausedAt.has(a.campaign_id));
      expect(settled, `contact of ${id} neither redialled nor out of attempts (${contact!.state}, ${contact!.attempt_count}) — ${summary}`).toBe(true);
      expect(contact!.attempt_count, summary).toBeGreaterThan(0);
    }

    // A campaign the guardrail paused was paused for the ceiling, and dialled
    // nobody from the instant of the pause: its in-flight calls settled (the final
    // audit) and no attempt was created after it.
    for (const [campaignId] of pausedAt) {
      const { rows: [cam] } = await db.query<{ pause_reason: string | null; paused_at: Date }>(
        'SELECT pause_reason, paused_at FROM agency_campaigns WHERE id = $1', [campaignId]);
      expect(cam!.pause_reason, summary).toBe('abandonment_ceiling');
      const after = rows.filter((r) => r.campaign_id === campaignId && r.created_at > cam!.paused_at);
      expect(after.map((r) => r.id), `attempts created after the auto-pause — ${summary}`).toEqual([]);
    }

    // The only abandonment source on this floor is an answer into a station lost
    // mid-ring, and each is attributed to it.
    const { rows: abandoned } = await db.query<{ id: string; campaign_id: string; abandon_reason: string | null }>(
      `SELECT id, campaign_id, abandon_reason FROM agency_call_attempts
        WHERE campaign_id = ANY($1::uuid[]) AND (${ABANDONED_ATTEMPT_PREDICATE_SQL})`, [ids]);
    for (const a of abandoned) {
      expect(ringDrops, `abandoned ${a.id} was not a mid-ring drop — ${summary}`).toContain(a.id);
      expect(a.abandon_reason, summary).toBe('station_lost');
    }
    for (const c of world.campaigns) {
      const n = abandoned.filter((a) => a.campaign_id === c.id).length;
      expect(await metricValue('agency_abandoned_total', { campaign_id: c.id }) ?? 0, `campaign ${c.spec.label} — ${summary}`).toBe(n);
    }
    // A ring drop whose call was answered is abandoned; one that rang out is not.
    for (const id of ringDrops) {
      const a = outcomeOf.get(id)!;
      if (a.answered_at) expect(a.outcome, `${id} — ${summary}`).toBe('abandoned');
      else expect(a.outcome, `${id} — ${summary}`).not.toBe('abandoned');
    }
  }, 600_000);

  /**
   * ⚠️ KNOWN DEFECT, pinned with `it.fails` — `POST /sessions/:id/available` during
   * an ANNOUNCED live call.
   *
   * The route refuses Available only for an UNANNOUNCED attempt
   * (`hasUnannouncedAttempt`, `src/api/routes/agency/sessions.ts`), and its own
   * comment records the announced case as "a known open gap": `agents.set` is an
   * unconditional write, so one click overwrites the `reserved`/`on_call` lease the
   * dialer is renewing, and the very next tick reserves the same agent for a SECOND
   * customer while the first is still on the line. The churn run above reached this
   * by accident (a return scheduled twice) and reported exactly that: an agent
   * holding two live attempts, and a live attempt whose agent read `available`.
   * Here it is driven deliberately, through the real route, on a busy floor.
   *
   * `left-session-guards.test.ts` pins the current scope ("leaves an ANNOUNCED live
   * attempt alone"), so widening the guard to `hasLiveAttempt` is a product
   * decision, not a test fix, and is left to it. When the route refuses this click,
   * this case goes green and `it.fails` reds: flip it to `it`.
   */
  it.fails('an Available click during a live, announced call never frees the agent for a second customer', async () => {
    world = await createFloorWorld({
      campaigns: [{ label: 'V', tenant: 't1', account: 'v1', agents: 12, contacts: 200, maxConcurrentCalls: 20 }],
      // Long calls only, so every agent is mid-conversation when the click lands.
      mix: { connected_long: 1 },
    });
    await world.round();
    await world.round();
    expect(await world.checkInvariants()).toEqual([]);
    const talking = world.carrier.liveCalls().filter((c) => c.phase === 'talking');
    expect(talking.length).toBeGreaterThan(0);
    const victim = world.agents.find((a) => a.sessionId === talking[0]!.sessionId)!;

    const res = await world.postAgentAction(victim, 'available');
    // Whatever the route answers, the lease must still bind the agent to their call…
    const live = await world.runtime.agents.get(victim.sessionId);
    const statusAndLease = `route answered ${res.statusCode}; lease reads ${live?.state}/${live?.attemptId}`;
    // …and the next tick must not reserve them again.
    await world.round();
    const violations = await world.checkInvariants();
    expect(violations, statusAndLease).toEqual([]);
  }, 120_000);
});

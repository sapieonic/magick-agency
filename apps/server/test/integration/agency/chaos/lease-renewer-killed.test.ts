import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
/*
 * PORT NOTE (magick-agency, Phase 6): ported from core
 * test/integration/agency/chaos/lease-renewer-killed.test.ts@4850d1d9 — 5 cases, all kept. Modified only in
 * harness plumbing: the connection mock targets agency's `@magick-agency/db` (and its
 * `/connection` entry, which packages/db's repositories import); the config stub
 * drops `telephony.vobiz` (VoBiz deleted, plan §5); import specifiers per the path
 * rule (domain leaves, `@magick-agency/contracts/agency`).
 */
import { readFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { closeTestPool, getTestPool, truncateAll } from '../../setup/test-utils.js';

// PORT NOTE: core mocked `src/db/connection.js`; agency's pool lives in `@magick-agency/db`
// (the server's repositories import its root, packages/db's repositories `./connection`).
vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));
vi.mock('@magick-agency/db/connection', () => ({ getPool: () => getTestPool() }));
vi.mock('../../../../src/config/index.js', () => ({
  config: {
    redis: { keyPrefix: '' },
    telephony: {}, // PORT NOTE: core stubbed `telephony.vobiz` (VoBiz deleted, plan §5)
  },
}));

const {
  createChaosWorld, attempts, contactStates, agentSessionStates,
  contactsWithConcurrentLiveAttempts, agencyKeys, agencyKeyTtls,
} = await import('./harness.js');
const { AGENT_LEASE_MS } = await import('../../../../src/agency/agent-state-machine.js');
const { DEFERRED_HANGUP_MS } = await import('@magick-agency/domain/timers');
const { AgencyReaper } = await import('../../../../src/agency/reaper.js');
const { noLiveAttempts } = await import('../agency-factories.js');

type World = Awaited<ReturnType<typeof createChaosWorld>>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Have the CONTACT rows finished moving, not just the attempt rows?
 *
 * `pending` alone is not enough, and the gap is the whole reason this exists.
 * `bridge.flush()` absorbs on the ATTEMPT row going terminal, but the contact's
 * release — `chargeAttempt`, then the `markState` after it — lands later, through
 * the fire-and-forget lifecycle subscription (`agency-dialer.ts` invokes it as a
 * bare `void …catch()`, so nothing a test awaits covers it). Inside that window
 * the attempt row already reads `ended` with a real outcome while its contact is
 * still `in_flight` with `attempt_count` unbumped.
 *
 * A loop that stops at "dialled nothing, and nothing is `pending`" stops INSIDE
 * that window — an `in_flight` contact is not `pending` — and then asserts the
 * contact side of a release that has not happened yet. Every attempt-side
 * assertion still passes and only the retry budget reads short, which is exactly
 * what makes the failure look like a product bug in the budget rather than a
 * premature read: `[0, 1, 1]`, reproducibly, on the last line of the case.
 *
 * Deliberately the same predicate as the harness's own
 * `hasOutstandingDialWorkFor`, which `runUntilQuiescent` has waited on for this
 * same reason. This file hand-rolls its loop rather than calling that helper
 * because it also checks the no-double-dial invariant on every tick.
 */
async function contactsQuiescent(campaignId: string): Promise<boolean> {
  const states = await contactStates(campaignId);
  return !states['pending'] && !states['in_flight'];
}

/**
 * ─── AD-P2-X-01 · SCENARIO 3 — LEASE RENEWER KILLED, AT SCENARIO LEVEL ──────
 *
 * T-L3 already proves the single-attempt case: one agent, one lease, stop
 * renewing, watch it lapse. What it cannot show is what a *pool* does when the
 * owning replica dies mid-shift, and that is the failure operators actually
 * meet. Three properties only appear at scenario level:
 *
 * 1. **The whole pool lapses, not just the agent you were watching.** A renewal
 *    loop keyed wrongly — per campaign instead of per attempt, say — keeps some
 *    subset alive, and a single-attempt test cannot see the difference.
 * 2. **Postgres does not move.** A lapsed lease is a *signal*; the recovery is
 *    the reaper. If durable state changed when the lease expired, the two would
 *    be doing the same job and the reaper's argument for existing would be
 *    wrong.
 * 3. **The pool does not silently reopen.** After the leases go, the tick must
 *    dial nothing, and after the reaper runs the contacts must come back to the
 *    roster and be dialed again **exactly once each** — with no contact ever
 *    carrying two live attempts across the whole episode.
 *
 * This file also carries **T-L4c**, the lease-provenance scan, because it is the
 * only place with a rich live keyspace to audit.
 *
 * Wall clock is unavoidable here and it is the one place in the suite that uses
 * it: an ioredis TTL is evaluated server-side and does not move when Vitest's
 * clock does, so a fake-timer version of this file would pass against the very
 * bug it exists to catch. ~30s total.
 */

describe('AD-P2-X-01 · lease renewer killed (chaos, slow)', () => {
  let world: World;

  beforeEach(truncateAll);
  afterEach(async () => {
    await world?.teardown();
    world = undefined as never;
  });
  afterAll(closeTestPool);

  /** A pool of agents on live, bridged, held calls. */
  async function withPoolOnLiveCalls(agents: number, contacts: number) {
    world = await createChaosWorld({ agents, contacts, maxConcurrentCalls: agents });
    world.bridge.setDefaultScript({ answer: true, bridge: true, status: 'completed', hold: true });
    for (const agent of world.agents) await world.bringOnline(agent);
    await world.tick();
    const live = await attempts(world.campaignId);
    expect(live).toHaveLength(agents);
    expect(live.every((a) => a.state === 'bridged')).toBe(true);
    return world;
  }

  it('with the renewer alive, every on-call lease outlives its own TTL — so the killed arm is not vacuous', async () => {
    // The inverse arm, and it has to come first. Without it, "the leases were
    // gone after 16 seconds" is satisfied by a system that never renewed
    // anything, and the killed case below would be proving nothing about the
    // renewer at all.
    const w = await withPoolOnLiveCalls(3, 9);

    const before = await agencyKeyTtls(w.redis);
    const leaseKeys = Object.keys(before).filter((k) => k.startsWith('agency:agent:'));
    expect(leaseKeys).toHaveLength(3);

    // Past two renewal intervals but still inside one lease, so a renewer that
    // ran exactly once would also survive this. The assertion is on the TTL
    // having been *pushed back up*, not merely on the key existing.
    await sleep(AGENT_LEASE_MS.renew_interval * 2 + 500);

    const after = await agencyKeyTtls(w.redis);
    for (const key of leaseKeys) {
      expect(after[key], `${key} lapsed while its renewer was alive`).toBeGreaterThan(0);
      // A never-renewed 15s lease would be down to ~4.5s by now.
      expect(after[key]).toBeGreaterThan(AGENT_LEASE_MS.on_call - AGENT_LEASE_MS.renew_interval * 2);
    }
    // And all three are still `on_call` — the renewer must not resurrect or
    // rewrite state, only extend.
    for (const agent of w.agents) {
      expect((await w.agentState.get(agent.sessionId))?.state).toBe('on_call');
    }
  }, 40_000);

  it('kill the renewer and the WHOLE pool lapses, while Postgres does not move at all', async () => {
    const w = await withPoolOnLiveCalls(3, 12);

    const attemptsBefore = await attempts(w.campaignId);
    const contactsBefore = await contactStates(w.campaignId);
    const sessionsBefore = await agentSessionStates(w.campaignId);
    // `in_flight` is the stranded state a mid-bridge replica death leaves behind
    // **on this campaign**, and which of the two it is depends on the fixture
    // rather than on the phase. Since MAG-88 the `bridged` phase parks a contact
    // in `connected` only when the campaign owes a write-up; this world takes
    // migration 072's column default of `disposition_catalog = '[]'`, so nothing
    // is owed and the contact keeps the `in_flight` its claim gave it.
    //
    // The scenario is indifferent to which one, and that is worth stating rather
    // than leaving as luck: both are non-claimable (`claimDialable` only ever
    // claims `pending`), both count as outstanding (`countOutstanding`), so the
    // campaign is equally unable to finish — and the recovery below is driven off
    // the ATTEMPT row (`findOrphanedAttempts`), which requeues the contact out of
    // either state. The distinction matters only to whoever writes the assertion,
    // which is why it is asserted rather than assumed.
    expect(contactsBefore['in_flight']).toBe(3);

    // The owning replica dies: renewers cleared, lifecycle subscription dropped.
    w.chaos.killRenewers();
    // The carrier's calls are simply abandoned — no terminal event will ever
    // arrive, which is precisely what a dead replica looks like from outside.
    expect(w.bridge.orphanHeld()).toBe(3);

    // Immediately after: the leases are still there. This matters — a lease that
    // vanished on `stop()` would mean the renewer, not the TTL, is what holds it.
    expect(Object.keys(await agencyKeyTtls(w.redis)).filter((k) => k.startsWith('agency:agent:'))).toHaveLength(3);

    // Past the on-call lease with a margin.
    await sleep(AGENT_LEASE_MS.on_call + 2_000);

    // ── Property 1: the whole pool, not a subset. ──────────────────────────
    for (const agent of w.agents) {
      expect(await w.agentState.get(agent.sessionId), `${agent.agentUserId} survived`).toBeNull();
    }
    expect(await agencyKeys(w.redis)).not.toContain(`agency:agent:${w.agents[0]!.sessionId}:state`);

    // ── Property 2: Postgres is untouched. ────────────────────────────────
    // The lease lapsing is the signal; the reaper is the recovery. If the TTL
    // expiring also mutated durable rows, the two mechanisms would overlap and
    // §6.2's whole argument for a startup reaper would be unsound.
    expect(await attempts(w.campaignId)).toEqual(attemptsBefore);
    expect(await contactStates(w.campaignId)).toEqual(contactsBefore);
    expect(await agentSessionStates(w.campaignId)).toEqual(sessionsBefore);

    // ── Property 3a: the pool does not silently reopen. ────────────────────
    // The DB still says `available` for nobody here (they are all mid-call), but
    // the sockets are still attached in-process — so a tick that trusted the
    // socket rather than the lease would dial.
    const dialsBefore = w.bridge.dialed.length;
    for (let i = 0; i < 5; i++) await w.tick();
    expect(w.bridge.dialed.length).toBe(dialsBefore);
  }, 60_000);

  it('the reaper is what recovers it, and every requeued contact is then dialed exactly once more', async () => {
    // Property 3b. The episode end to end: live pool → replica dies → leases
    // lapse → reaper → roster restored → dialed again, once each. The last
    // clause is the one that matters and the one a shorter test cannot reach:
    // a requeued contact must end with exactly TWO attempts, the first
    // `orphaned` and the second real, and must never carry two live at once.
    const w = await withPoolOnLiveCalls(3, 9);
    const orphanedContactIds = (await attempts(w.campaignId)).map((a) => a.contact_id);
    expect(new Set(orphanedContactIds).size).toBe(3);

    w.chaos.killRenewers();
    w.bridge.orphanHeld();
    await sleep(AGENT_LEASE_MS.on_call + 2_000);

    // Nothing has recovered yet — asserted, because if the reaper's work were
    // already done by something else the rest of this case would be measuring
    // the wrong mechanism.
    // `in_flight` for the same reason as the case above: this campaign's catalog
    // is the empty default, so a bridged contact is never parked in `connected`.
    expect((await contactStates(w.campaignId))['in_flight']).toBe(3);
    expect((await contactStates(w.campaignId))['pending']).toBe(6);

    const reaped = await new AgencyReaper(noLiveAttempts()).reapOnStartup();
    expect(reaped.attempts).toBe(3);

    // Roster restored, attempts terminal and honestly labelled.
    const afterReap = await attempts(w.campaignId);
    expect(afterReap).toHaveLength(3);
    expect(afterReap.every((a) => a.state === 'ended' && a.outcome === 'orphaned')).toBe(true);
    const states = await contactStates(w.campaignId);
    expect(states['in_flight'] ?? 0).toBe(0);
    expect(states['pending']).toBe(9);
    // Agents offline, never available — the criterion-3 half of this route.
    expect(Object.values(await agentSessionStates(w.campaignId)).every((s) => s === 'offline')).toBe(true);

    // The replica comes back: fresh lifecycle subscription, sockets re-attach,
    // agents click available.
    w.dialer.start();
    w.bridge.setDefaultScript({ answer: true, bridge: true, status: 'completed', talkTimeSeconds: 15 });
    for (const agent of w.agents) await w.bringOnline(agent);

    for (let i = 0; i < 40; i++) {
      const before = w.bridge.dialed.length;
      await w.tick();
      // The invariant, checked every tick through the recovery — not only at
      // the end. A requeued contact re-dialed while its orphaned attempt was
      // still live is the exact double-dial this whole design exists to prevent,
      // and it would be invisible to a terminal-only assertion.
      expect(await contactsWithConcurrentLiveAttempts(w.campaignId)).toEqual([]);
      if (w.bridge.dialed.length === before && (await contactsQuiescent(w.campaignId))) break;
    }

    const all = await attempts(w.campaignId);
    const byContact = new Map<string, number>();
    for (const a of all) byContact.set(a.contact_id, (byContact.get(a.contact_id) ?? 0) + 1);
    expect(byContact.size).toBe(9);

    // The six contacts that were never in flight are dialed normally — so the
    // recovery did not break the pool, and the failure below is specific to the
    // requeued rows rather than general.
    for (const [id, n] of byContact) {
      if (!orphanedContactIds.includes(id)) expect(n).toBe(1);
    }

    // ── The recovery completes (AD-P2-C-12) ────────────────────────────────
    // Each requeued contact carries exactly TWO attempts — the orphaned one and
    // one real retry — and the roster drains. Asserted as a partition rather
    // than as a total of 12, because a total of 12 is also produced by one
    // contact being dialed four times.
    //
    // This is the case that found `AD-P2-C-12`. Before the fix these contacts
    // carried one attempt each and sat `pending` forever, claimed and unclaimed
    // every tick, while the roster looked healthy. Regression coverage for the
    // numbering itself lives in `attempt-number-collision.test.ts`; what this
    // asserts is the property an operator cares about — the crash did not
    // silently shorten the list.
    for (const id of orphanedContactIds) {
      expect(byContact.get(id), `requeued contact ${id}`).toBe(2);
      const mine = all.filter((a) => a.contact_id === id)
        .sort((a, b) => a.attempt_number - b.attempt_number);
      expect(mine[0]!.attempt_number).toBe(1);
      expect(mine[0]!.outcome).toBe('orphaned');
      expect(mine[1]!.attempt_number).toBe(2);
      expect(mine[1]!.outcome).not.toBe('orphaned');
      expect(mine[1]!.state).toBe('ended');
    }
    expect((await contactStates(w.campaignId))['pending'] ?? 0).toBe(0);
    // And the retry budget survived the crash untouched, which is the product
    // decision the reaper's no-`bump_attempt` comment defends: our outage must
    // not consume the customer's allowance.
    const { rows: budgets } = await getTestPool().query<{ id: string; attempt_count: number }>(
      `SELECT id, attempt_count FROM agency_contacts WHERE id = ANY($1)`, [orphanedContactIds],
    );
    // Keyed by contact, not compared as a bare array: the query has no ORDER BY,
    // so a positional `[0, 1, 1]` cannot say WHICH contact came up short — and
    // which one it is is the first thing anyone reading this failure needs.
    expect(Object.fromEntries(budgets.map((b) => [b.id, b.attempt_count])))
      .toEqual(Object.fromEntries(orphanedContactIds.map((id) => [id, 1])));
  }, 90_000);

  // ── T-L4c — lease provenance ──────────────────────────────────────────────

  it('T-L4c static — every Redis TTL under src/agency originates in AGENT_LEASE_MS', async () => {
    // A SCAN, not an enumeration. The shipped unit-tier assertion is
    // `expect(Object.values(AGENT_LEASE_MS)).not.toContain(DEFERRED_HANGUP_MS)`,
    // which is a list of one forbidden number: it cannot see a new business
    // duration added to `timers.ts`, and it cannot see a literal TTL handed
    // straight to `PEXPIRE` without passing through `AGENT_LEASE_MS` at all.
    //
    // Keying on the ORIGIN of the value rather than on forbidden numbers is what
    // keeps this correct as `timers.ts` grows — `AD-P2-C-02` has already put
    // wrap-up timing there, and the next business duration will not be on
    // anyone's forbidden list.
    const dir = new URL('../../../../src/agency/', import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(5);

    const offenders: string[] = [];
    for (const file of files) {
      const src = await readFile(new URL(file, dir), 'utf8');
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        // Every way a TTL can be set on an agency key: the Lua `PEXPIRE`, and
        // ioredis' `'PX'` option form.
        const isTtlSite = /\bPEXPIRE\b/i.test(line) || /['"]PX['"]/.test(line);
        if (!isTtlSite) return;
        // A `PEXPIRE` inside a Lua script takes its value from an ARGV slot, and
        // the ARGV is bound at the `eval` call site — so a Lua line is not itself
        // evidence either way. The binding sites are what matter, and they are
        // the `leaseMs` arguments checked below. What IS an offence is a literal
        // number written into a TTL position.
        const literalTtl = /\b(PEXPIRE|['"]PX['"])\s*,?\s*['"]?\d{3,}/i.test(line);
        if (literalTtl) offenders.push(`${file}:${i + 1}: literal TTL — ${line.trim()}`);
      });

      // The binding half: any value handed to a TTL parameter must be an
      // `AGENT_LEASE_MS` member. `OWNERSHIP_TTL_MS` in `station-registry.ts` is
      // the one documented exception — it is the station ownership key, a
      // liveness detector in its own right renewed by the socket heartbeat, and
      // §13.10 has an open question about whether it and the agent lease should
      // be one key. It is allow-listed BY NAME so a new constant cannot slip in
      // beside it.
      const ttlArgs = [...src.matchAll(/['"]PX['"]\s*,\s*([A-Za-z_][\w.]*)/g)].map((m) => m[1]!);
      for (const arg of ttlArgs) {
        // Allow-listed BY NAME, never by shape, so a new constant cannot slip in
        // beside one of these. Each is a liveness or credential window rather
        // than a business duration:
        //   OWNERSHIP_TTL_MS   — station ownership, renewed by the socket
        //                        heartbeat (§13.10 asks whether it and the agent
        //                        lease should be one key; either way it detects
        //                        a dead owner, it does not time a business step)
        //   LEADER_LEASE_MS    — campaign leadership, renewed at a third of its
        //                        length by the leader itself
        //   STATION_TOKEN_TTL_MS — authenticates ONE WebSocket upgrade, not a
        //                        shift. It gates neither dialing nor agent
        //                        liveness, so §6.1's invariant does not reach
        //                        it; it is listed so the scan stays strict.
        const ok = arg.startsWith('AGENT_LEASE_MS.')
          || arg === 'OWNERSHIP_TTL_MS'
          || arg === 'leaseMs'
          || arg === 'LEADER_LEASE_MS'
          || arg === 'STATION_TOKEN_TTL_MS'
          || arg === 'ttlMs';
        if (!ok) offenders.push(`${file}: TTL from an unrecognised source — ${arg}`);
      }
    }
    expect(offenders).toEqual([]);

    // And the specific number the coordinator asked to be certain of: the
    // deferred-hangup window is a business duration and must never be a TTL.
    for (const file of files) {
      const src = await readFile(new URL(file, dir), 'utf8');
      if (file === 'timers.ts') continue;
      // `DEFERRED_HANGUP_MS` may be imported and used for an in-process timer;
      // what it may never be is adjacent to a TTL primitive.
      const lines = src.split('\n').filter((l) => l.includes('DEFERRED_HANGUP_MS'));
      for (const line of lines) {
        expect(/PEXPIRE|['"]PX['"]|pexpire|expire\(/.test(line), `${file}: ${line.trim()}`).toBe(false);
      }
    }
    expect(Object.values(AGENT_LEASE_MS)).not.toContain(DEFERRED_HANGUP_MS);
  });

  it('T-L4c runtime — no observed agency TTL is ever the deferred-hangup window', async () => {
    // The runtime half. It is standing and waiting: the deferred hangup itself
    // is `AD-P2-C-07` and has not landed, so today this samples every key the
    // live paths write and proves none of them carries the 8s window. When
    // `C-07` ships, the same audit covers the new path with no edit — which is
    // the point of sampling the keyspace rather than enumerating call sites.
    const w = await withPoolOnLiveCalls(3, 9);

    const observed: number[] = [];
    const record = async () => {
      for (const ttl of Object.values(await agencyKeyTtls(w.redis))) if (ttl > 0) observed.push(ttl);
    };

    await record();                       // on_call leases + station ownership
    w.chaos.killRenewers();
    w.bridge.orphanHeld();
    await record();                       // after the replica died
    await w.chaos.dropStation(w.agents[0]!.sessionId);
    await record();                       // after a socket went away
    for (const agent of w.agents.slice(1)) await w.bringOnline(agent);
    await record();                       // back to `available`

    expect(observed.length).toBeGreaterThan(8);
    // A live TTL is always within its declared ceiling, and the deferred-hangup
    // window (8s) sits below every one of them — so a value in that
    // neighbourhood could only have come from `timers.ts`.
    const ceiling = Math.max(...Object.values(AGENT_LEASE_MS));
    for (const ttl of observed) {
      expect(ttl).toBeLessThanOrEqual(ceiling + 1_000);
      expect(
        Math.abs(ttl - DEFERRED_HANGUP_MS) > 250,
        `observed a TTL of ${ttl}ms, which is the deferred-hangup window — a business timer has become a liveness detector`,
      ).toBe(true);
    }
  }, 60_000);
});

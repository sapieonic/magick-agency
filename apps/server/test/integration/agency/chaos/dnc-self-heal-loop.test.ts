import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../../setup/test-utils.js';

// A real meter provider, installed before any product module creates its
// instruments (vi.hoisted runs ahead of every import), so the harness's
// `metricValue` reads what an export would actually carry.
await vi.hoisted(async () => {
  const { installMetricReader } = await import('../../../helpers/otel-metric-reader.js');
  installMetricReader();
});

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
  createChaosWorld, attempts, contactStates, metricValue,
} = await import('./harness.js');
const { DncRegistry } = await import('../../../../src/agency/dnc-registry.js');

type World = Awaited<ReturnType<typeof createChaosWorld>>;

/*
 * PORT NOTE (magick-agency, Phase 6, decision B8 — REWRITTEN). Core's
 * test/integration/agency/chaos/dnc-self-heal-loop.test.ts@4850d1d9 (MAG-108, 3 cases)
 * proved the self-heal loop of a machine that no longer exists: `FLUSHDB` drops the
 * tenant's DNC set, the pre-dial gate halts, `DncRegistry.check` fires `onUnsynced`,
 * `createDncResyncRequester` asks master over loopback (`POST /internal/agency/
 * dnc-resync`), master publishes a `replace` into core's `POST /internal/agency/
 * dnc-sync`, and the campaign dials again. Under B8 there is no Redis set, no
 * version, no resync request and no sync route: the gate is one indexed read of
 * `dnc_entries` and every failed read is `unavailable` (→ `halt`).
 *
 * What the file proved that STILL has a subject is the compliance half of the loop,
 * and that is what is asserted here, against the real table and the real runtime:
 * when the gate cannot answer, the campaign halts — the WHOLE claimed batch goes
 * back undialed — and it does not recover on its own; when the table answers again,
 * dialing resumes with no human step, and a number on the list is suppressed while
 * its neighbours dial. The "read fault" is genuine: `dnc_entries` is renamed for the
 * duration, so every check is a real Postgres `42P01` (restored in `finally`).
 *
 * Case by case:
 *  - "guards the guard — the fixture carries the two hops this file is shaped by"
 *    → DELETED: it pins `agency-s2s-contract.fixture.json`'s `dncResync` / `dncSync`
 *    sections; the S2S fixture retires (plan §1) and neither hop exists (B8).
 *  - "flush → refuse → ask → master publishes → dial, with no step performed by the
 *    test in between" → REWRITTEN as "read fault → refuse the whole batch → table
 *    answers → dial ...": the refusal assertions (nothing dialed, a `dnc_unavailable`
 *    halt counted for THIS campaign) are core's; the request/ingest-route assertions
 *    are gone with the hops; the member-crossed-the-wire assertions become "the row
 *    in `dnc_entries` is what the gate reads" (`check()` → `suppressed` for the
 *    target, `clear` for the neighbour; the target ends `suppressed`/`dnc` and is
 *    never dialed, the neighbour is).
 *  - "the resumed dial is caused by the replace, not by ticks elapsing — a refusing
 *    master leaves it halted" → REWRITTEN as "... a fault that persists leaves it
 *    halted": ten ticks inside the fault dial nothing, consume no contact and write
 *    no attempt — so recovery in the case above is caused by the table answering,
 *    not by ticks elapsing (the fail-open this subsystem exists to prevent).
 *  - New assertion in the rewritten case 2 (plan §9 "a halt aborts the whole claimed
 *    batch"): during the fault every reserved agent is returned and every claimed
 *    contact is back to `pending`, not just the first one the gate saw.
 */

/**
 * Make every `dnc_entries` read fail with a real Postgres error for the duration of
 * `fn`, then restore the table. Not a mock: the registry's own query runs and the
 * database refuses it (`42P01`), which is the shape of an outage, a dropped grant or
 * a botched migration.
 */
async function withDncTableUnreadable<T>(fn: () => Promise<T>): Promise<T> {
  // Safe ONLY because `vitest.config.integration.ts` sets `fileParallelism: false`: the
  // rename is schema-wide on the shared worktree DB, so a file running alongside would
  // see `dnc_entries` vanish mid-test. Turn file parallelism on and this must move to
  // a per-file schema (or a failing pool double).
  await getTestPool().query('ALTER TABLE dnc_entries RENAME TO dnc_entries_unreadable');
  try {
    return await fn();
  } finally {
    await getTestPool().query('ALTER TABLE dnc_entries_unreadable RENAME TO dnc_entries');
  }
}

/** A contact the campaign has NOT dialed yet (see core's note: never `contactIds[0]`). */
async function somePendingContact(
  campaignId: string,
  order: 'ASC' | 'DESC',
): Promise<{ id: string; phone: string }> {
  const { rows } = await getTestPool().query<{ id: string; phone_e164: string }>(
    `SELECT id, phone_e164 FROM agency_contacts
      WHERE campaign_id = $1 AND state = 'pending'
      ORDER BY source_row_number ${order === 'ASC' ? 'ASC' : 'DESC'} LIMIT 1`,
    [campaignId],
  );
  const row = rows[0];
  if (!row) throw new Error('no pending contact left to suppress — the warm-up dialed the whole roster');
  return { id: row.id, phone: row.phone_e164 };
}

describe('MAG-108 (B8) · a DNC gate that cannot read halts the batch, and recovers when the table answers (chaos)', () => {
  let world: World;

  beforeEach(truncateAll);

  afterEach(async () => {
    await world?.teardown();
    world = undefined as never;
  });

  afterAll(closeTestPool);

  /**
   * A world that has dialed a round and finished it — pool idle, roster deep.
   * Core's precondition, kept: a later "it dialed nothing" cannot be explained by
   * an exhausted roster or by occupancy.
   */
  async function warmedUp(opts: { agents: number; contacts: number }) {
    world = await createChaosWorld({ ...opts, maxConcurrentCalls: opts.agents });
    const w = world;
    for (const agent of w.agents) await w.bringOnline(agent);
    await w.tick();
    const live = await getTestPool().query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM agency_call_attempts
        WHERE campaign_id = $1 AND state <> 'ended'`, [w.campaignId],
    );
    expect(Number(live.rows[0]!.n)).toBe(0);
    expect((await contactStates(w.campaignId))['pending']).toBeGreaterThan(opts.agents);
    return w;
  }

  it('read fault → refuse the whole batch → table answers → dial, with no step performed by the test in between', async () => {
    const w = await warmedUp({ agents: 3, contacts: 12 });

    // The contact whose number is on the list, and a neighbour that must stay
    // dialable — both chosen BEFORE anything runs.
    const target = await somePendingContact(w.campaignId, 'DESC');
    const neighbour = await somePendingContact(w.campaignId, 'ASC');
    expect(target.id).not.toBe(neighbour.id);
    // `dnc_entries.tenant_id` references `tenants`; the chaos world inserts none.
    await getTestPool().query(
      `INSERT INTO tenants (id, name, slug) VALUES ($1, 'chaos', $2) ON CONFLICT (id) DO NOTHING`,
      [w.tenantId, `chaos-${w.tenantId}`],
    );
    // Campaign-scoped, as an agent's mark writes it — the scope core's flat set
    // could not carry and the B8 gate now reads.
    await getTestPool().query(
      `INSERT INTO dnc_entries (tenant_id, account_id, campaign_id, phone_e164, source)
       VALUES ($1, NULL, $2, $3, 'agent')`,
      [w.tenantId, w.campaignId, target.phone],
    );

    const dialsBefore = w.bridge.dialed.length;
    const attemptsBefore = (await attempts(w.campaignId)).length;
    const pendingBefore = (await contactStates(w.campaignId))['pending'];

    await withDncTableUnreadable(async () => {
      // The gate's own call answers `unavailable`, never `clear`.
      expect(await w.runtime.dnc.check(w.tenantId, neighbour.phone, {
        accountId: w.accountId, campaignId: w.campaignId,
      })).toBe('unavailable');

      // ── The one tick that discovers the fault.
      await w.tick();

      // (i) It REFUSED, and for the right reason.
      expect(w.bridge.dialed.length).toBe(dialsBefore);
      expect(
        await metricValue('agency_predial_gate_total', {
          campaign_id: w.campaignId, gate: 'dnc_unavailable', action: 'halt',
        }),
        'nothing dialed, but not because of the DNC gate — this scenario is measuring '
        + 'something else and everything below it proves nothing',
      ).toBeGreaterThan(0);

      // (ii) The WHOLE claimed batch went back (§9: "a halt aborts the whole claimed
      //      batch"): three agents were reserved and three contacts claimed, the gate
      //      halted on the first, and none of the three became an attempt or stayed
      //      claimed. No agent is left on the `reserving` marker.
      expect((await attempts(w.campaignId)).length).toBe(attemptsBefore);
      const states = await contactStates(w.campaignId);
      expect(states['in_flight'] ?? 0).toBe(0);
      expect(states['pending']).toBe(pendingBefore);
      for (const agent of w.agents) {
        expect((await w.agentState.get(agent.sessionId))?.state).toBe('available');
      }
    });

    // ── FROM HERE THE TEST PERFORMS NOTHING BUT TICKS ────────────────────────
    //
    // The table answers again. There is nothing to re-publish: the list never left.

    // (iii) What the gate reads is the row — asserted through `check()`, the exact
    //       call the gate makes.
    expect(await w.runtime.dnc.check(w.tenantId, target.phone, {
      accountId: w.accountId, campaignId: w.campaignId,
    })).toBe('suppressed');
    expect(await w.runtime.dnc.check(w.tenantId, neighbour.phone, {
      accountId: w.accountId, campaignId: w.campaignId,
    })).toBe('clear');

    // (iv) The campaign resumes, and runs itself out.
    await w.runUntilQuiescent();
    expect(
      w.bridge.dialed.length,
      'the table answers again but the campaign never resumed',
    ).toBeGreaterThan(dialsBefore);

    // (v) The consequence on the durable row: suppressed, for the right reason, and
    //     never dialed; the neighbour dialed.
    const { rows: targetRows } = await getTestPool().query<{ state: string; suppressed_reason: string | null }>(
      'SELECT state, suppressed_reason FROM agency_contacts WHERE id = $1', [target.id],
    );
    expect(targetRows[0]!.state).toBe('suppressed');
    expect(targetRows[0]!.suppressed_reason).toBe('dnc');
    const dialedContacts = new Set((await attempts(w.campaignId)).map((a) => a.contact_id));
    expect(dialedContacts.has(target.id)).toBe(false);
    expect(dialedContacts.has(neighbour.id)).toBe(true);
  });

  it('the resumed dial is caused by the table answering, not by ticks elapsing — a fault that persists leaves it halted', async () => {
    // The falsifier for the case above. Without it, "it dialed after some ticks" is
    // satisfied by any mechanism that recovers on its own, including one that quietly
    // treats an unanswerable gate as clear after a while — which is precisely the
    // fail-open this whole subsystem exists to prevent.
    const w = await warmedUp({ agents: 3, contacts: 12 });
    const dialsBefore = w.bridge.dialed.length;
    const attemptsBefore = (await attempts(w.campaignId)).length;

    await withDncTableUnreadable(async () => {
      for (let i = 0; i < 10; i++) await w.tick();

      // Nothing recovered: no dial, no attempt row, and the roster nowhere near
      // exhausted — every tick's claimed batch went back.
      expect(w.bridge.dialed.length).toBe(dialsBefore);
      expect((await attempts(w.campaignId)).length).toBe(attemptsBefore);
      const states = await contactStates(w.campaignId);
      expect(states['in_flight'] ?? 0).toBe(0);
      expect(states['pending']).toBeGreaterThan(3);
      // A fresh registry agrees — the refusal is the table's, not this runtime's state.
      expect(await new DncRegistry().check(w.tenantId, '+919000000099', {
        accountId: w.accountId, campaignId: w.campaignId,
      })).toBe('unavailable');
    });
  });
});

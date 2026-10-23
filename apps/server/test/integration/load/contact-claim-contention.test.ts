import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { createRng, scaled, type Rng } from '../../helpers/load-scale.js';

/*
 * The repositories call `getPool()` per statement, so pointing it at a pool of
 * many connections makes every concurrent call in this file a separate Postgres
 * backend — real row locks, real SKIP LOCKED, real EvalPlanQual re-checks. The
 * shared test pool (5 connections) would queue the actors and hide the races.
 */
const { contention } = vi.hoisted(() => ({ contention: { pool: null as pg.Pool | null } }));
vi.mock('@magick-agency/db', () => ({ getPool: () => contention.pool }));
vi.mock('@magick-agency/db/connection', () => ({ getPool: () => contention.pool }));

const { createContentionPool, insertAgencyCampaign, noLiveAttempts } = await import('../agency/agency-factories.js');
const { DEFAULTS } = await import('../setup/factories.js');
const { agencyAttemptRepository, agencyContactRepository } = await import(
  '../../../src/db/repositories/agency.repository.js'
);
const { AgencyReaper } = await import('../../../src/agency/reaper.js');
const { AUTO_DISPOSITION_CODE } = await import('../../../src/agency/disposition.js');

/**
 * ─── THE CONTACT CLAIM, SETTLEMENT AND RECOVERY SQL UNDER CONTENTION ────────
 *
 * `claimDialable`'s `FOR UPDATE SKIP LOCKED` is the dialer's CORRECTNESS
 * mechanism — the reason two leaders (or one leader's overlapping ticks) can
 * never dial one contact twice — and everything that later moves a contact
 * (unclaim, the retry-budget charges, `markState` with its DNC freeze, the DNC
 * mark's `FOR UPDATE` sweep, the reaper's three recovery sweeps) is written as a
 * guarded single statement so that it cannot be raced. `agency-duplicate-dial`
 * and `agency-reaper-sql` prove each guard with a handful of rows; this suite
 * runs them as a floor would, many actors on many connections at once, and
 * asserts the invariants on state:
 *
 *  - no contact is ever held by two claimers at the same instant;
 *  - a claim never blocks on, or returns, a row another transaction has locked;
 *  - once a DNC mark has committed, no later claim returns that number, and no
 *    settlement brings it back;
 *  - the budget counters are exact under concurrent charges (no lost update, and
 *    every charger decides on a DISTINCT post-bump count);
 *  - two reapers sweeping the same wreckage at once requeue each contact once,
 *    and an auto-disposition racing the agent's own write-up leaves exactly one.
 *
 * "Held" is tracked from the actors' side with the subset argument the guard
 * suite uses: a contact enters an actor's hand when its claim RETURNS (the row is
 * already `in_flight`, committed) and leaves it BEFORE the write that releases it
 * is issued (it is still `in_flight` until that write commits). So the test's
 * view of who holds what is never wider than the database's, and two holders in
 * that view is a double claim.
 */

const CONNECTIONS = 24;

async function jitter(rng: Rng, max = 3): Promise<void> {
  const n = rng.int(0, max);
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

/** Bulk-insert `n` dialable contacts; `phoneOf(i)` lets a test share numbers. */
async function insertContacts(
  campaignId: string,
  n: number,
  opts: { phones?: number; state?: string; updatedSecondsAgo?: number } = {},
): Promise<Array<{ id: string; phone_e164: string }>> {
  const { rows } = await getTestPool().query<{ id: string; phone_e164: string }>(
    `INSERT INTO agency_contacts
       (campaign_id, tenant_id, account_id, phone_e164, state, source_row_number, updated_at)
     SELECT $1, $2, $3,
            '+9198' || lpad((CASE WHEN $5::int IS NULL THEN g ELSE g % $5::int END)::text, 8, '0'),
            $6, g, now() - make_interval(secs => $7)
       FROM generate_series(1, $4) g
     RETURNING id, phone_e164`,
    [campaignId, DEFAULTS.tenantId, DEFAULTS.accountId, n, opts.phones ?? null,
      opts.state ?? 'pending', opts.updatedSecondsAgo ?? 0],
  );
  return rows;
}

async function contactRows(campaignId: string) {
  const { rows } = await getTestPool().query<{
    id: string; state: string; attempt_count: number; our_fault_attempts: number;
    phone_e164: string; suppressed_reason: string | null; last_disposition: string | null;
  }>(
    `SELECT id, state, attempt_count, our_fault_attempts, phone_e164, suppressed_reason, last_disposition
       FROM agency_contacts WHERE campaign_id = $1`,
    [campaignId],
  );
  return rows;
}

describe('contact claim, settlement and recovery under contention (integration)', () => {
  beforeEach(async () => {
    contention.pool ??= createContentionPool(CONNECTIONS);
    await truncateAll();
  });
  afterAll(async () => {
    await contention.pool?.end();
    await closeTestPool();
  });

  it('a floor of claimers and settlers never holds one contact twice, and works the whole roster', async () => {
    const rng = createRng();
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const N = scaled(600);
    await insertContacts(campaign.id, N);
    const CLAIMERS = 12;

    const owner = new Map<string, number>();
    const claims = new Map<string, number>();
    const charges = new Map<string, number>();
    // Recorded, not thrown, inside the actors: a throw would end one claimer while
    // the rest ran on into the next test's rows.
    const violations: string[] = [];
    let doubleClaims = 0;

    const settle = async (contactId: string, actorRng: Rng): Promise<void> => {
      const roll = actorRng.next();
      owner.delete(contactId); // BEFORE the releasing write — see the header.
      if (roll < 0.35) {
        // Returned to the pool (a halted batch, a gate that will clear).
        await agencyContactRepository.unclaim(contactId, new Date());
      } else if (roll < 0.55) {
        // A retryable outcome: charge, then requeue (the settlement's order).
        const used = await agencyContactRepository.chargeAttempt(contactId, 'no_answer');
        charges.set(contactId, (charges.get(contactId) ?? 0) + 1);
        if (used !== charges.get(contactId)) violations.push(`${contactId}: charged to ${used}, expected ${charges.get(contactId)}`);
        await agencyContactRepository.markState(contactId, 'pending', { next_attempt_at: new Date() });
      } else {
        // Terminal: connected and done.
        await agencyContactRepository.chargeAttempt(contactId, 'connected');
        charges.set(contactId, (charges.get(contactId) ?? 0) + 1);
        await agencyContactRepository.markState(contactId, 'completed');
      }
    };

    await Promise.all(Array.from({ length: CLAIMERS }, async (_, a) => {
      const actorRng = createRng(rng.seed + a + 1);
      for (let idle = 0; idle < 40;) {
        const batch = await agencyContactRepository.claimDialable(campaign.id, actorRng.int(1, 8));
        if (batch.length === 0) {
          idle++;
          await new Promise((r) => setTimeout(r, 2));
          continue;
        }
        idle = 0;
        for (const c of batch) {
          if (owner.has(c.id)) {
            doubleClaims++;
            violations.push(`contact ${c.id} claimed by ${a} while held by ${owner.get(c.id)}`);
          }
          if (c.state !== 'in_flight') violations.push(`claim returned ${c.id} as ${c.state}`);
          owner.set(c.id, a);
          claims.set(c.id, (claims.get(c.id) ?? 0) + 1);
        }
        await jitter(actorRng);
        // Settle the batch concurrently, as the dialer settles independent calls.
        await Promise.all(batch.map((c) => settle(c.id, actorRng)));
      }
    }));

    expect(violations.slice(0, 10)).toEqual([]);
    expect(doubleClaims).toBe(0);
    const rows = await contactRows(campaign.id);
    // Every contact was worked to completion — nothing stranded in_flight, nothing
    // left pending — and the budget counter is exactly what was charged.
    expect(rows.filter((r) => r.state !== 'completed')).toEqual([]);
    for (const r of rows) expect(r.attempt_count, r.id).toBe(charges.get(r.id) ?? 0);
    // The run was contended: plenty of contacts went round more than once.
    expect([...claims.values()].filter((n) => n > 1).length).toBeGreaterThan(N / 10);
  });

  it('SKIP LOCKED: claims neither wait on nor return rows another transaction holds', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const contacts = await insertContacts(campaign.id, scaled(200));
    const locked = contacts.filter((_, i) => i % 3 === 0).map((c) => c.id);

    // A transaction holding row locks on a third of the roster (the DNC mark's
    // `FOR UPDATE`, or a claim that has not committed) for the whole storm.
    const holder = await getTestPool().connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM agency_contacts WHERE id = ANY($1::uuid[]) FOR UPDATE', [locked]);

      const storm = Promise.all(Array.from({ length: 16 }, () => (async () => {
        const got: string[] = [];
        for (;;) {
          const batch = await agencyContactRepository.claimDialable(campaign.id, 5);
          if (batch.length === 0) return got;
          got.push(...batch.map((c) => c.id));
        }
      })()));
      // A claim that WAITED on the holder would never return while it holds; the
      // watchdog turns that hang into a named failure.
      let watchdog: NodeJS.Timeout | undefined;
      const claimed = await Promise.race([
        storm,
        new Promise<never>((_, reject) => {
          watchdog = setTimeout(() => reject(new Error('claimDialable blocked on a locked row')), 15_000);
        }),
      ]).finally(() => clearTimeout(watchdog));

      const all = claimed.flat();
      expect(new Set(all).size).toBe(all.length);
      expect(all.filter((id) => locked.includes(id))).toEqual([]);
      expect(all).toHaveLength(contacts.length - locked.length);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }

    // Released by the rollback, untouched: the locked third is claimable now.
    const after = await agencyContactRepository.claimDialable(campaign.id, contacts.length);
    expect(after.map((c) => c.id).sort()).toEqual([...locked].sort());
  });

  it('a DNC mark racing claims and settlements: once committed, the number is never claimed or requeued again', async () => {
    // Numbers shared by several roster rows (a household landline) so the mark's
    // by-phone sweep and the claim really contend for the same rows.
    const rng = createRng();
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const PHONES = scaled(60);
    const contacts = await insertContacts(campaign.id, PHONES * 4, { phones: PHONES });
    const phones = [...new Set(contacts.map((c) => c.phone_e164))];
    const toMark = rng.shuffle(phones).slice(0, Math.floor(PHONES / 2));
    const committed = new Set<string>();
    const owner = new Map<string, number>();
    let doubleClaims = 0;
    let lateClaims = 0;

    let marking = true;
    const markers = (async () => {
      for (const phone of toMark) {
        const victim = contacts.find((c) => c.phone_e164 === phone)!;
        await agencyContactRepository.suppressByPhone(campaign.id, phone, 'dnc', { alwaysContactId: victim.id });
        committed.add(phone);
        await jitter(rng, 2);
      }
      marking = false;
    })();

    // Unmarked numbers are requeued forever, so the claimers run for as long as
    // the marks do, plus a fixed tail in which every mark has committed.
    const claimers = Promise.all(Array.from({ length: 10 }, async (_, a) => {
      const actorRng = createRng(rng.seed + 50 + a);
      for (let tail = 0; tail < 15;) {
        if (!marking) tail++;
        const markedBefore = new Set(committed); // snapshot at issue
        const batch = await agencyContactRepository.claimDialable(campaign.id, actorRng.int(1, 6));
        if (batch.length === 0) {
          await new Promise((r) => setTimeout(r, 1));
          continue;
        }
        for (const c of batch) {
          if (markedBefore.has(c.phone_e164)) lateClaims++;
          if (owner.has(c.id)) doubleClaims++;
          owner.set(c.id, a);
        }
        await jitter(actorRng);
        await Promise.all(batch.map(async (c) => {
          owner.delete(c.id);
          // Every outcome path asks for `pending` — the DNC freeze must refuse it.
          if (actorRng.chance(0.5)) await agencyContactRepository.unclaim(c.id, new Date());
          else await agencyContactRepository.markState(c.id, 'pending', { next_attempt_at: new Date() });
        }));
      }
    }));

    await Promise.all([markers, claimers]);
    expect(lateClaims, 'a claim issued after a DNC mark committed returned that number').toBe(0);
    expect(doubleClaims).toBe(0);

    const rows = await contactRows(campaign.id);
    for (const r of rows) {
      if (toMark.includes(r.phone_e164)) {
        expect(r.state, `${r.phone_e164} resurrected`).toBe('suppressed');
        expect(r.suppressed_reason).toBe('dnc');
      } else {
        // Unmarked numbers were only ever requeued, so they end back in the pool.
        expect(r.state).toBe('pending');
      }
    }
  });

  it('concurrent budget charges on one contact: no lost update, and every charger decides on a distinct count', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const contacts = await insertContacts(campaign.id, scaled(40), { state: 'in_flight' });
    const K = 12;

    const results = await Promise.all(contacts.map((c) => Promise.all([
      ...Array.from({ length: K }, () => agencyContactRepository.chargeAttempt(c.id, 'no_answer')),
      ...Array.from({ length: K }, () => agencyContactRepository.chargeOurFaultAttempt(c.id, 'canceled')),
    ])));

    const rows = new Map((await contactRows(campaign.id)).map((r) => [r.id, r]));
    contacts.forEach((c, i) => {
      const res = results[i]!;
      // The retry policy is evaluated on the returned count, so two chargers must
      // never see the same number: that would grant a dial past `max_attempts`.
      expect(res.slice(0, K).sort((x, y) => x - y)).toEqual(Array.from({ length: K }, (_, k) => k + 1));
      expect(res.slice(K).sort((x, y) => x - y)).toEqual(Array.from({ length: K }, (_, k) => k + 1));
      expect(rows.get(c.id)!.attempt_count).toBe(K);
      expect(rows.get(c.id)!.our_fault_attempts).toBe(K);
    });
  });

  it('two reapers sweeping leaked attempts at once requeue each orphaned contact exactly once', async () => {
    // A replica died mid-floor: every attempt live, every contact in_flight. Two
    // reapers (a slow sweep overlapping the next tick of its own interval, or two
    // replicas) run the leak sweep concurrently, several passes each.
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const N = scaled(150);
    const contacts = await insertContacts(campaign.id, N, { state: 'in_flight' });
    const states = ['queued', 'dialing', 'ringing', 'answered', 'bridged'];
    await getTestPool().query(
      `INSERT INTO agency_call_attempts
         (campaign_id, contact_id, tenant_id, account_id, attempt_number, caller_id, state, created_at)
       SELECT $1, c.id, $2, $3, 1, '+919000000001', ($4::text[])[1 + (c.source_row_number % 5)],
              now() - interval '20 minutes'
         FROM agency_contacts c WHERE c.campaign_id = $1`,
      [campaign.id, DEFAULTS.tenantId, DEFAULTS.accountId, states],
    );

    const reapers = [new AgencyReaper(noLiveAttempts()), new AgencyReaper(noLiveAttempts())];
    const reaped = await Promise.all(reapers.flatMap((r) => [r.sweepOnce(), r.sweepOnce(), r.sweepOnce()]));
    expect(reaped.reduce((s, n) => s + n, 0)).toBe(N);

    const rows = await contactRows(campaign.id);
    expect(rows).toHaveLength(contacts.length);
    for (const r of rows) {
      expect(r.state, r.id).toBe('pending');
      expect(r.our_fault_attempts, `${r.id} requeued more than once`).toBe(1);
      expect(r.attempt_count).toBe(0);
    }
    const { rows: attempts } = await getTestPool().query<{ state: string; outcome: string }>(
      'SELECT state, outcome FROM agency_call_attempts WHERE campaign_id = $1', [campaign.id],
    );
    expect(attempts.every((a) => a.state === 'ended' && a.outcome === 'orphaned')).toBe(true);
  });

  /**
   * Two stranded-contact sweeps at once requeue each contact once.
   *
   * This was a live defect: `findStrandedInFlight` was a plain SELECT and
   * `requeueOrphanedContact` charges `our_fault_attempts` unconditionally before
   * writing `pending`, so overlapping sweeps (one outlasting the 60s interval —
   * `start()` fires them `void` with no in-flight guard, and a degraded database is
   * exactly when a sweep is slow — or two replicas) all found the same contact and
   * all charged it. Four overlapping sweeps over 150 contacts stranded ONCE left 149
   * of them charged four times and retired `exhausted` by `OUR_FAULT_REDIAL_BOUND`:
   * permanently off the roster, "we never reached them", for one crash. The read
   * now claims the rows (a guarded UPDATE whose RETURNING decides who requeues,
   * the leak sweep's shape), and this pins it.
   */
  it('two stranded-contact sweeps at once requeue each contact exactly once', async () => {
    const campaign = await insertAgencyCampaign({ status: 'paused' });
    const N = scaled(150);
    // Claimed an hour ago, never dialled (a crash between claim and attempt INSERT).
    await insertContacts(campaign.id, N, { state: 'in_flight', updatedSecondsAgo: 3_600 });

    const reapers = [new AgencyReaper(noLiveAttempts()), new AgencyReaper(noLiveAttempts())];
    await Promise.all(reapers.flatMap((r) => [r.sweepStrandedContacts(), r.sweepStrandedContacts()]));

    const rows = await contactRows(campaign.id);
    const histogram: Record<string, number> = {};
    for (const r of rows) histogram[`${r.our_fault_attempts}:${r.state}`] = (histogram[`${r.our_fault_attempts}:${r.state}`] ?? 0) + 1;
    expect(rows.filter((r) => r.our_fault_attempts !== 1).length,
      `contacts charged more than once for one stranding (charges:state → count) ${JSON.stringify(histogram)}`).toBe(0);
    expect(rows.every((r) => r.state === 'pending')).toBe(true);
  });

  it('a lapsed-wrap-up sweep racing the agents\' own write-ups, from two reapers: exactly one disposition each', async () => {
    const campaign = await insertAgencyCampaign({
      status: 'paused',
      disposition_catalog: JSON.stringify([{ code: 'promise_to_pay', label: 'Promise to pay' }]),
    });
    const N = scaled(150);
    await insertContacts(campaign.id, N, { state: 'connected' });
    const { rows: attempts } = await getTestPool().query<{ id: string; contact_id: string }>(
      `INSERT INTO agency_call_attempts
         (campaign_id, contact_id, tenant_id, account_id, attempt_number, caller_id, state, outcome,
          wrapup_seconds, bridged_at, ended_at)
       SELECT $1, c.id, $2, $3, 1, '+919000000001', 'ended', 'connected',
              30, now() - interval '400 seconds', now() - interval '300 seconds'
         FROM agency_contacts c WHERE c.campaign_id = $1
       RETURNING id, contact_id`,
      [campaign.id, DEFAULTS.tenantId, DEFAULTS.accountId],
    );

    const agentUser = '00000000-0000-4000-8000-0000000000aa';
    const reapers = [new AgencyReaper(noLiveAttempts()), new AgencyReaper(noLiveAttempts())];
    // Each sweep reads its rows once and then stamps them one at a time, so the
    // window its guard protects is "the agent writes AFTER the sweep read the row
    // and BEFORE the sweep reaches it". Spreading the agents' writes over the
    // sweeps' pass (seeded delays) puts many writes inside that window; firing
    // them all at t=0 lands nearly all of them before the sweep's read.
    const rng = createRng();
    const delays = attempts.map(() => rng.int(0, 60));
    const [agentResults] = await Promise.all([
      Promise.all(attempts.map(async (a, i) => {
        // A fifth of the agents never submit in time: the sweep is certain to
        // close those, which the late-submission phase below relies on.
        if (i % 5 === 0) return null;
        await new Promise((r) => setTimeout(r, delays[i]));
        return agencyAttemptRepository.recordDisposition({
          attemptId: a.id, dispositionCode: 'promise_to_pay', notes: null, callbackAt: null,
          actorUserId: agentUser, onBehalf: false,
        });
      })),
      ...reapers.map((r) => r.sweepLapsedWrapups()),
      ...reapers.map((r) => r.sweepLapsedWrapups()),
    ]);

    const { rows: after } = await getTestPool().query<{ id: string; disposition_code: string; dispositioned_by_user_id: string | null }>(
      'SELECT id, disposition_code, dispositioned_by_user_id FROM agency_call_attempts WHERE campaign_id = $1',
      [campaign.id],
    );
    const byId = new Map(after.map((r) => [r.id, r]));
    const contacts = new Map((await contactRows(campaign.id)).map((r) => [r.id, r]));
    let agentWon = 0;
    attempts.forEach((a, i) => {
      const row = byId.get(a.id)!;
      const contact = contacts.get(a.contact_id)!;
      if (agentResults[i]) {
        // The agent's write landed: it is the record, and the sweep left it alone.
        agentWon++;
        expect(row.disposition_code).toBe('promise_to_pay');
        expect(row.dispositioned_by_user_id).toBe(agentUser);
        expect(contact.last_disposition).not.toBe(AUTO_DISPOSITION_CODE);
      } else {
        // The sweep won: the auto code, attributed to nobody, and the contact released once.
        expect(row.disposition_code).toBe(AUTO_DISPOSITION_CODE);
        expect(row.dispositioned_by_user_id).toBeNull();
        expect(contact.last_disposition).toBe(AUTO_DISPOSITION_CODE);
        expect(contact.state).toBe('completed');
      }
    });
    // Nothing further to sweep, whoever won.
    expect(await reapers[0]!.sweepLapsedWrapups()).toBe(0);
    expect(agentWon).toBeGreaterThan(0);

    // The agents the sweep beat submit anyway — a write-up arriving after the
    // window was closed for them, all at once. The first-writer guard refuses
    // every one: the auto record stands, attributed to nobody.
    const lost = attempts.filter((_, i) => !agentResults[i]);
    expect(lost.length, 'the sweep never won a row, so the late path was not exercised').toBeGreaterThan(0);
    const late = await Promise.all(lost.map((a) => agencyAttemptRepository.recordDisposition({
      attemptId: a.id, dispositionCode: 'promise_to_pay', notes: null, callbackAt: null,
      actorUserId: agentUser, onBehalf: false,
    })));
    expect(late.filter((r) => r !== null)).toHaveLength(0);
    const { rows: stillAuto } = await getTestPool().query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM agency_call_attempts
        WHERE id = ANY($1::uuid[]) AND disposition_code = $2 AND dispositioned_by_user_id IS NULL`,
      [lost.map((a) => a.id), AUTO_DISPOSITION_CODE],
    );
    expect(Number(stillAuto[0]!.n)).toBe(lost.length);
  });
});

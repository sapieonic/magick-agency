import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { createContentionPool, insertAgencyCampaign, insertAgencyContact } from './agency-factories.js';
import {
  assertReRunningPlan, freshTables, withReRunningPlan,
} from '../../../../../packages/db/test/helpers/rerun-plan.js';

// The repository's queries go to `pinned.client` while a case holds one (the forced
// re-run plan), or to `pinned.pool` (the contention cases), else the shared test pool.
const pinned = vi.hoisted(() => ({ client: null as null | pg.PoolClient, pool: null as null | pg.Pool }));
vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => pinned.client ?? pinned.pool ?? getTestPool(),
}));

const { agencyContactRepository: repo } = await import('../../../src/db/repositories/agency.repository.js');

/**
 * `claimForAgents`: the contact-assignment claim (`strict`, `preferred`) on real Postgres.
 *
 * The rules it must hold, each a case below: an agent is paired only with their own
 * contacts (strict) or their own first, then the pool (preferred), never another agent's;
 * at most one contact per agent, whatever plan Postgres picks; one live call per number
 * across agents; DNC never; and two leaders claiming at once never hand one contact out
 * twice.
 */

const A = randomUUID();
const B = randomUUID();
const C = randomUUID();

/** A due contact (due `secondsAgo` ago), owned by `owner` (null: the pool). */
async function due(campaignId: string, owner: string | null, opts: Record<string, unknown> & { secondsAgo?: number } = {}) {
  const { secondsAgo = 60, ...rest } = opts;
  return insertAgencyContact(campaignId, {
    assigned_user_id: owner,
    assigned_at: owner ? new Date() : null,
    next_attempt_at: new Date(Date.now() - secondsAgo * 1_000),
    ...rest,
  });
}

async function stateOf(id: string): Promise<string> {
  const { rows } = await getTestPool().query<{ state: string }>('SELECT state FROM agency_contacts WHERE id = $1', [id]);
  return rows[0]!.state;
}

function pairs(claims: Array<{ agentUserId: string; contact: { id: string } }>) {
  return claims.map((c) => [c.agentUserId, c.contact.id]).sort((x, y) => x[0]!.localeCompare(y[0]!));
}

describe('agencyContactRepository.claimForAgents: strict', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  it("claims each agent's own earliest due contact, never another agent's and never the pool", async () => {
    const campaign = await insertAgencyCampaign({ status: 'running', assignment_mode: 'strict' });
    const a1 = await due(campaign.id, A, { secondsAgo: 300 });
    const a2 = await due(campaign.id, A, { secondsAgo: 100 });
    const b1 = await due(campaign.id, B, { secondsAgo: 50 });
    // The pool's contact is due earliest of all, and nobody's to dial in strict mode.
    const pool = await due(campaign.id, null, { secondsAgo: 900 });

    const claims = await repo.claimForAgents(campaign.id, [A, B], 'strict');

    expect(pairs(claims)).toEqual(pairs([
      { agentUserId: A, contact: a1 }, { agentUserId: B, contact: b1 },
    ]));
    // What was returned is what went in flight, and every row carries its owner.
    for (const c of claims) {
      expect(c.contact.state).toBe('in_flight');
      expect(c.contact.assigned_user_id).toBe(c.agentUserId);
    }
    expect(await stateOf(a2.id)).toBe('pending');
    expect(await stateOf(pool.id)).toBe('pending');
  });

  it('an agent with nothing of their own gets nothing, even with the pool and other queues full', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running', assignment_mode: 'strict' });
    await due(campaign.id, B);
    await due(campaign.id, null);

    expect(await repo.claimForAgents(campaign.id, [A], 'strict')).toEqual([]);
    expect(await repo.claimForAgents(campaign.id, [C, A], 'strict')).toEqual([]);
  });

  it('leaves contacts that are not due, not pending, or DNC-suppressed', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running', assignment_mode: 'strict' });
    await due(campaign.id, A, { secondsAgo: -3_600 }); // due in an hour
    await due(campaign.id, A, { state: 'completed' });
    // A pre-fix leftover the claim refuses: `pending` with a DNC suppression.
    const dnc = await due(campaign.id, A, { suppressed_reason: 'dnc', secondsAgo: 600 });

    expect(await repo.claimForAgents(campaign.id, [A], 'strict')).toEqual([]);
    expect(await stateOf(dnc.id)).toBe('pending');
  });

  it("one live call per number, across agents: two agents' contacts on one number claim once, for the first agent", async () => {
    const campaign = await insertAgencyCampaign({ status: 'running', assignment_mode: 'strict' });
    const shared = '+919876500001';
    const ofA = await due(campaign.id, A, { phone_e164: shared });
    const ofB = await due(campaign.id, B, { phone_e164: '+91 98765 00001' }); // same digits
    const ofC = await due(campaign.id, C);

    // B is first in the reservation order, so B's contact wins the number.
    const claims = await repo.claimForAgents(campaign.id, [B, A, C], 'strict');
    expect(pairs(claims)).toEqual(pairs([{ agentUserId: B, contact: ofB }, { agentUserId: C, contact: ofC }]));
    expect(await stateOf(ofA.id)).toBe('pending');

    // While that call is live, A's contact on the number waits; once it settles, A gets it.
    expect(await repo.claimForAgents(campaign.id, [A], 'strict')).toEqual([]);
    await getTestPool().query(`UPDATE agency_contacts SET state = 'completed' WHERE id = $1`, [ofB.id]);
    expect(pairs(await repo.claimForAgents(campaign.id, [A], 'strict'))).toEqual([[A, ofA.id]]);
  });

  it('skips an own contact whose number is live on the campaign and takes the next', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running', assignment_mode: 'strict' });
    const busy = '+919876500009';
    await due(campaign.id, null, { phone_e164: busy, state: 'connected' });
    await due(campaign.id, A, { phone_e164: busy, secondsAgo: 600 });
    const next = await due(campaign.id, A, { secondsAgo: 60 });

    expect(pairs(await repo.claimForAgents(campaign.id, [A], 'strict'))).toEqual([[A, next.id]]);
  });

  it('a repeated agent id counts once', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running', assignment_mode: 'strict' });
    await due(campaign.id, A, { secondsAgo: 300 });
    await due(campaign.id, A, { secondsAgo: 200 });

    const claims = await repo.claimForAgents(campaign.id, [A, A, A], 'strict');
    expect(claims).toHaveLength(1);
  });
});

describe('agencyContactRepository.claimForAgents: preferred', () => {
  beforeEach(truncateAll);

  it('own first: an agent with an own contact due never takes the pool, even an older pool contact', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running', assignment_mode: 'preferred' });
    const own = await due(campaign.id, A, { secondsAgo: 10 });
    const pool = await due(campaign.id, null, { secondsAgo: 900 });

    expect(pairs(await repo.claimForAgents(campaign.id, [A], 'preferred'))).toEqual([[A, own.id]]);
    expect(await stateOf(pool.id)).toBe('pending');
  });

  it('the pool only for agents with nothing of their own, in reservation order, oldest pool contact first', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running', assignment_mode: 'preferred' });
    const ofB = await due(campaign.id, B);
    const p1 = await due(campaign.id, null, { secondsAgo: 900 });
    const p2 = await due(campaign.id, null, { secondsAgo: 600 });
    const p3 = await due(campaign.id, null, { secondsAgo: 300 });

    // C before A in the reservation order: C gets the oldest pool contact.
    const claims = await repo.claimForAgents(campaign.id, [C, B, A], 'preferred');
    expect(pairs(claims)).toEqual(pairs([
      { agentUserId: C, contact: p1 }, { agentUserId: B, contact: ofB }, { agentUserId: A, contact: p2 },
    ]));
    expect(await stateOf(p3.id)).toBe('pending');
  });

  it("never another agent's contact, even with nothing of their own and nothing in the pool", async () => {
    const campaign = await insertAgencyCampaign({ status: 'running', assignment_mode: 'preferred' });
    const ofB = await due(campaign.id, B);

    expect(await repo.claimForAgents(campaign.id, [A], 'preferred')).toEqual([]);
    expect(await stateOf(ofB.id)).toBe('pending');
  });

  it('a pool contact on a number an own pick took is not claimed in the same tick', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running', assignment_mode: 'preferred' });
    const shared = '+919876500002';
    const own = await due(campaign.id, A, { phone_e164: shared });
    const poolSame = await due(campaign.id, null, { phone_e164: shared, secondsAgo: 900 });
    const poolOther = await due(campaign.id, null, { secondsAgo: 600 });

    const claims = await repo.claimForAgents(campaign.id, [A, B], 'preferred');
    expect(pairs(claims)).toEqual(pairs([{ agentUserId: A, contact: own }, { agentUserId: B, contact: poolOther }]));
    expect(await stateOf(poolSame.id)).toBe('pending');
  });

  it('a DNC-suppressed pending pool row is never claimed', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running', assignment_mode: 'preferred' });
    await due(campaign.id, null, { suppressed_reason: 'dnc' });

    expect(await repo.claimForAgents(campaign.id, [A, B], 'preferred')).toEqual([]);
  });

  it('a pool callback is claimable by anyone; an owned callback only by its owner', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running', assignment_mode: 'preferred' });
    const ownedCallback = await due(campaign.id, B, { last_disposition: 'callback', attempt_count: 1 });
    const poolCallback = await due(campaign.id, null, { last_disposition: 'callback', attempt_count: 1 });

    expect(pairs(await repo.claimForAgents(campaign.id, [A], 'preferred'))).toEqual([[A, poolCallback.id]]);
    expect(await stateOf(ownedCallback.id)).toBe('pending');
    expect(pairs(await repo.claimForAgents(campaign.id, [B], 'preferred'))).toEqual([[B, ownedCallback.id]]);
  });
});

/** The old claim's shape, per owner: the plan that re-runs the locking subquery. */
const OLD_OWNER_CLAIM = `UPDATE agency_contacts SET state = 'in_flight', updated_at = now()
  WHERE id IN (SELECT id FROM agency_contacts
                WHERE campaign_id = $1 AND assigned_user_id = $2 AND state = 'pending'
                  AND next_attempt_at <= now()
                ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT 1)
  RETURNING *`;

describe('claimForAgents: never more than one contact per agent, under the re-running plan', () => {
  beforeEach(truncateAll);

  for (const mode of ['strict', 'preferred'] as const) {
    it(`${mode}: one row per agent even when the planner would re-run a locking subquery`, async () => {
      const campaign = await insertAgencyCampaign({ status: 'running', assignment_mode: mode });
      // The recipe (`rerun-plan.ts`): fresh tables, statistics from one row, then the rest.
      await freshTables(getTestPool(), ['agency_contacts']);
      for (let i = 1; i <= 12; i++) {
        const owner = i <= 6 ? A : i <= 9 ? null : B;
        await due(campaign.id, owner, { source_row_number: i, secondsAgo: 1_000 - i });
        if (i === 1) await getTestPool().query('ANALYZE agency_contacts');
      }

      const claims = await withReRunningPlan(getTestPool(), async (client) => {
        await assertReRunningPlan(client, 'agency_contacts', OLD_OWNER_CLAIM, [campaign.id, A]);
        pinned.client = client;
        try {
          return await repo.claimForAgents(campaign.id, [A, B, C], mode);
        } finally {
          pinned.client = null;
        }
      });

      const perAgent = new Map<string, number>();
      for (const c of claims) perAgent.set(c.agentUserId, (perAgent.get(c.agentUserId) ?? 0) + 1);
      expect([...perAgent.values()].every((n) => n === 1)).toBe(true);
      // strict: A and B (C owns nothing); preferred: C also takes one from the pool.
      expect(claims).toHaveLength(mode === 'strict' ? 2 : 3);
      const { rows } = await getTestPool().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM agency_contacts WHERE campaign_id = $1 AND state = 'in_flight'`, [campaign.id],
      );
      expect(rows[0]!.n).toBe(claims.length);
    });
  }
});

describe('claimForAgents: two leaders at once never hand one contact out twice', () => {
  beforeEach(async () => {
    pinned.pool ??= createContentionPool(8);
    await truncateAll();
  });
  afterAll(async () => {
    await pinned.pool?.end();
    pinned.pool = null;
  });

  for (const mode of ['strict', 'preferred'] as const) {
    it(`${mode}: concurrent claims for the same agents on separate connections`, async () => {
      const campaign = await insertAgencyCampaign({ status: 'running', assignment_mode: mode });
      const agents = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      // 10 own contacts each and 40 in the pool, distinct numbers, all due.
      await getTestPool().query(
        `INSERT INTO agency_contacts
           (campaign_id, tenant_id, account_id, phone_e164, state, source_row_number, next_attempt_at,
            assigned_user_id, assigned_at)
         SELECT $1, $2, $3, '+9198' || lpad(g::text, 8, '0'), 'pending', g, now() - make_interval(secs => g),
                CASE WHEN g <= 40 THEN ($4::uuid[])[1 + g % 4] END, CASE WHEN g <= 40 THEN now() END
           FROM generate_series(1, 80) g`,
        [campaign.id, campaign.tenant_id, campaign.account_id, agents],
      );

      const seen = new Map<string, string>();
      const doubles: string[] = [];
      const wrongOwner: string[] = [];
      // Two "leaders" (a split-brain window), each claiming for the whole floor, 12 rounds.
      for (let round = 0; round < 12; round++) {
        const results = await Promise.all([
          repo.claimForAgents(campaign.id, agents, mode),
          repo.claimForAgents(campaign.id, [...agents].reverse(), mode),
        ]);
        for (const claims of results) {
          for (const { agentUserId, contact } of claims) {
            if (seen.has(contact.id)) doubles.push(contact.id);
            seen.set(contact.id, agentUserId);
            const owner = contact.assigned_user_id;
            if (!(owner === agentUserId || (mode === 'preferred' && owner === null))) wrongOwner.push(contact.id);
          }
        }
      }

      expect(doubles).toEqual([]);
      expect(wrongOwner).toEqual([]);
      const { rows } = await getTestPool().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM agency_contacts WHERE campaign_id = $1 AND state = 'in_flight'`, [campaign.id],
      );
      expect(rows[0]!.n).toBe(seen.size);
      // Every own contact is worked by its owner; strict never touches the pool.
      const own = [...seen.keys()].length;
      expect(own).toBe(mode === 'strict' ? 40 : 80);
    });
  }
});

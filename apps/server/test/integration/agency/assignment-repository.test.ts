import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, insertAccount, insertTenant, insertUser } from '../setup/factories.js';
import { insertAgencyAttempt, insertAgencyCampaign, insertAgencyContact } from './agency-factories.js';

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));

const repo = await import('../../../src/db/repositories/agency.repository.js');
const { parseAssignmentOperation } = await import('../../../src/agency/assignment/operation.js');
const { contactBucketSql, callbackCodes } = await import('../../../src/db/repositories/agency/assignment-sql.js');
const bus = await import('../../../src/agency/pacing/invalidation-bus.js');

type Canonical = import('../../../src/agency/assignment/operation.js').CanonicalAssignment;

/**
 * The contact-assignment repository on real Postgres: every operation kind planned and
 * committed by the one SQL builder, the preview and the commit agreeing contact for contact,
 * same-number grouping, the live-contact skip, the stale refusal, the history rows, the
 * unstaff return (CA6) and the progress counts against `assignment-sql.ts`.
 *
 * Mutation-checked (see the lane report): dropping `WHERE NOT s.live` from the plan reds the
 * live-skip case; perturbing the seed the plan hashes with reds the 10,000-contact
 * preview = commit case.
 */

const CATALOG = [
  { code: 'interested', label: 'Interested', is_success: true, terminal: true },
  { code: 'callback', label: 'Call back', requires_datetime: true },
];

let campaign: { id: string; tenant_id: string };
let agents: string[];
const supervisor = randomUUID();

function op(raw: unknown, phase: 'preview' | 'commit' = 'preview'): Canonical {
  const r = parseAssignmentOperation(raw, phase);
  if (!r.ok) throw new Error(JSON.stringify(r.details));
  return r.op;
}

const scope = () => ({ campaignId: campaign.id, tenantId: campaign.tenant_id, callbackCodes: callbackCodes(CATALOG as never) });

/** `n` contacts by SQL, numbered by `csv_line_number` 1..n (roster order). */
async function seed(n: number, opts: { phone?: (i: number) => string; extra?: string; campaignId?: string } = {}): Promise<string[]> {
  const phones = Array.from({ length: n }, (_, i) => opts.phone?.(i + 1) ?? `+9190${String(i + 1).padStart(8, '0')}`);
  const { rows } = await getTestPool().query<{ id: string }>(
    `INSERT INTO agency_contacts (campaign_id, tenant_id, account_id, phone_e164, csv_line_number, context, state)
     SELECT $1, $2, $3, p.phone, p.i, '{}'::jsonb, 'pending'
       FROM unnest($4::text[]) WITH ORDINALITY AS p(phone, i)
     RETURNING id`,
    [opts.campaignId ?? campaign.id, DEFAULTS.tenantId, DEFAULTS.accountId, phones],
  );
  return rows.map((r) => r.id);
}

async function staff(userId: string, campaignId = campaign.id): Promise<void> {
  await getTestPool().query(
    'INSERT INTO agency_campaign_agents (tenant_id, account_id, campaign_id, user_id) VALUES ($1, $2, $3, $4)',
    [DEFAULTS.tenantId, DEFAULTS.accountId, campaignId, userId],
  );
}

async function owners(campaignId = campaign.id): Promise<Map<string | null, number>> {
  const { rows } = await getTestPool().query<{ uid: string | null; n: number }>(
    'SELECT assigned_user_id::text AS uid, count(*)::int AS n FROM agency_contacts WHERE campaign_id = $1 GROUP BY 1',
    [campaignId],
  );
  return new Map(rows.map((r) => [r.uid, r.n]));
}

async function ownerOf(id: string): Promise<string | null> {
  const { rows } = await getTestPool().query<{ uid: string | null }>('SELECT assigned_user_id::text AS uid FROM agency_contacts WHERE id = $1', [id]);
  return rows[0]!.uid;
}

async function commitPreviewed(o: Canonical, commitRaw?: unknown) {
  const preview = await repo.agencyAssignmentRepository.preview(o, scope());
  const commitOp = commitRaw === undefined ? o : op(commitRaw, 'commit');
  const outcome = await repo.agencyAssignmentRepository.commit({ op: commitOp, scope: scope(), token: preview.preview_token, actorUserId: supervisor });
  return { preview, outcome };
}

beforeEach(async () => {
  await truncateAll();
  await insertTenant({ id: DEFAULTS.tenantId });
  await insertAccount({ id: DEFAULTS.accountId, tenant_id: DEFAULTS.tenantId });
  campaign = await insertAgencyCampaign({ disposition_catalog: JSON.stringify(CATALOG) }) as typeof campaign;
  agents = [];
  for (let i = 0; i < 5; i++) {
    const u = await insertUser() as { id: string };
    agents.push(u.id);
    await staff(u.id);
  }
});
afterAll(closeTestPool);

describe('random_split', () => {
  it('splits 10,000 contacts across 5 agents 2,000 each, the commit is the preview, one history row per move', async () => {
    await seed(10_000);
    const events: string[] = [];
    const unsubscribe = bus.resetPacingInvalidationBusForTests().subscribe((e) => events.push(e.type));
    const split = op({ kind: 'random_split', agent_user_ids: agents });
    const seedUsed = split.kind === 'random_split' ? split.seed : '';

    const { preview, outcome } = await commitPreviewed(split, { kind: 'random_split', agent_user_ids: agents, seed: seedUsed });
    unsubscribe();

    expect(preview).toMatchObject({ kind: 'random_split', seed: seedUsed, matched: 10_000, moving: 10_000, skipped_live: 0, unchanged: 0, to_pool: 0, same_number_groups: 0 });
    expect(preview.per_agent).toEqual(agents.map((a) => ({ agent_user_id: a, receiving: 2_000, giving: 0 })));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result).toMatchObject({ moved: 10_000, skipped_live: 0, unchanged: 0, to_pool: 0 });
    expect(outcome.result.per_agent).toEqual(preview.per_agent);
    const counts = await owners();
    for (const a of agents) expect(counts.get(a)).toBe(2_000);

    const { rows: ev } = await getTestPool().query<{ n: number; batches: number; reason: string; actor: string; from_null: boolean }>(
      `SELECT count(*)::int AS n, count(DISTINCT batch_id)::int AS batches, min(reason) AS reason,
              min(actor_user_id::text) AS actor, bool_and(from_user_id IS NULL) AS from_null
         FROM agency_contact_assignment_events WHERE campaign_id = $1`, [campaign.id]);
    expect(ev[0]).toEqual({ n: 10_000, batches: 1, reason: 'random_split', actor: supervisor, from_null: true });
    const { rows: stamped } = await getTestPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM agency_contacts WHERE campaign_id = $1 AND assigned_by_user_id = $2 AND assigned_at IS NOT NULL`,
      [campaign.id, supervisor]);
    expect(stamped[0]!.n).toBe(10_000);
    expect(events).toContain('contacts_changed');
  });

  it('the same seed previews the same split; another seed a different one', async () => {
    await seed(200);
    const a = await repo.agencyAssignmentRepository.preview(op({ kind: 'random_split', agent_user_ids: agents, seed: 's1' }), scope());
    const b = await repo.agencyAssignmentRepository.preview(op({ kind: 'random_split', agent_user_ids: agents, seed: 's1' }), scope());
    const c = await repo.agencyAssignmentRepository.preview(op({ kind: 'random_split', agent_user_ids: agents, seed: 's2' }), scope());
    expect(b.preview_token).toBe(a.preview_token);
    expect(c.preview_token).not.toBe(a.preview_token);
    expect(a.per_agent.map((p) => p.receiving)).toEqual([40, 40, 40, 40, 40]);
  });

  it('keeps every contact on one number with one agent; sizes differ by at most one group', async () => {
    // 60 contacts on 20 numbers (3 each), written in different formats.
    await seed(60, { phone: (i) => (i % 2 ? `+91 90000 ${String(Math.ceil(i / 3)).padStart(5, '0')}` : `+9190000${String(Math.ceil(i / 3)).padStart(5, '0')}`) });
    const three = agents.slice(0, 3);
    const { preview, outcome } = await commitPreviewed(op({ kind: 'random_split', agent_user_ids: three, seed: 'g' }));
    expect(preview.same_number_groups).toBe(20);
    expect(outcome.ok).toBe(true);
    const { rows } = await getTestPool().query<{ owners: number }>(
      `SELECT count(DISTINCT assigned_user_id)::int AS owners FROM agency_contacts
        WHERE campaign_id = $1 GROUP BY regexp_replace(phone_e164, '[^0-9]', '', 'g')`, [campaign.id]);
    expect(rows).toHaveLength(20);
    expect(rows.every((r) => r.owners === 1)).toBe(true);
    const sizes = [...(await owners()).values()];
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(3);
    expect(sizes.reduce((s, n) => s + n, 0)).toBe(60);

    // Without grouping: no groups, and an exact split.
    await getTestPool().query('UPDATE agency_contacts SET assigned_user_id = NULL, assigned_at = NULL WHERE campaign_id = $1', [campaign.id]);
    const flat = await repo.agencyAssignmentRepository.preview(op({ kind: 'random_split', agent_user_ids: three, seed: 'g', group_same_number: false }), scope());
    expect(flat.same_number_groups).toBe(0);
    expect(flat.per_agent.map((p) => p.receiving)).toEqual([20, 20, 20]);
  });

  it('never moves a contact on a call; the rest of its number group still moves together', async () => {
    const ids = await seed(6, { phone: (i) => (i <= 3 ? '+919999900001' : `+91888880000${i}`) });
    await getTestPool().query(`UPDATE agency_contacts SET state = 'in_flight' WHERE id = $1`, [ids[0]]);
    await getTestPool().query(`UPDATE agency_contacts SET state = 'connected' WHERE id = $1`, [ids[5]]);
    const { preview, outcome } = await commitPreviewed(op({ kind: 'random_split', agent_user_ids: agents.slice(0, 2), seed: 'x' }));
    expect(preview).toMatchObject({ matched: 6, moving: 4, skipped_live: 2, same_number_groups: 1 });
    expect(outcome.ok && outcome.result).toMatchObject({ moved: 4, skipped_live: 2 });
    expect(await ownerOf(ids[0]!)).toBeNull();
    expect(await ownerOf(ids[5]!)).toBeNull();
    expect(await ownerOf(ids[1]!)).toBe(await ownerOf(ids[2]!));
    expect(await ownerOf(ids[1]!)).not.toBeNull();
  });
});

describe('preview / commit', () => {
  it('refuses a commit whose roster changed since the preview, writes nothing, and returns the fresh preview', async () => {
    const ids = await seed(50);
    const split = op({ kind: 'random_split', agent_user_ids: agents, seed: 'st' });
    const preview = await repo.agencyAssignmentRepository.preview(split, scope());
    // A concurrent change: one contact goes on a call, one more lands in the pool.
    await getTestPool().query(`UPDATE agency_contacts SET state = 'in_flight' WHERE id = $1`, [ids[7]]);
    await seed(1, { phone: () => '+917777777777' });

    const outcome = await repo.agencyAssignmentRepository.commit({ op: split, scope: scope(), token: preview.preview_token, actorUserId: supervisor });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.preview).toMatchObject({ matched: 51, moving: 50, skipped_live: 1 });
    expect(outcome.preview.preview_token).not.toBe(preview.preview_token);
    expect((await owners()).get(null)).toBe(51);
    const { rows } = await getTestPool().query<{ n: number }>('SELECT count(*)::int AS n FROM agency_contact_assignment_events');
    expect(rows[0]!.n).toBe(0);

    // The fresh preview's token commits.
    const retried = await repo.agencyAssignmentRepository.commit({ op: split, scope: scope(), token: outcome.preview.preview_token, actorUserId: supervisor });
    expect(retried.ok && retried.result.moved).toBe(50);
  });

  it('a large split commits through a running campaign\'s churn within 2%, and refuses beyond it', async () => {
    const ids = await seed(1_000);
    const split = op({ kind: 'random_split', agent_user_ids: agents, seed: 'busy' });
    const preview = await repo.agencyAssignmentRepository.preview(split, scope());
    expect(preview.moving).toBe(1_000);
    // A tick's worth of churn: 5 claimed, 3 settled reached, 4 new rows in the pool.
    await getTestPool().query(`UPDATE agency_contacts SET state = 'in_flight' WHERE id = ANY($1::uuid[])`, [ids.slice(0, 5)]);
    await getTestPool().query(`UPDATE agency_contacts SET state = 'completed' WHERE id = ANY($1::uuid[])`, [ids.slice(5, 8)]);
    await seed(4, { phone: (i) => `+91888000000${i}` });

    const outcome = await repo.agencyAssignmentRepository.commit({ op: split, scope: scope(), token: preview.preview_token, actorUserId: supervisor });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;
    // The plan as it stood: every non-live row moved (closed pool rows included, CA2), live ones skipped.
    expect(outcome.result).toMatchObject({ moved: 999, skipped_live: 5 });
    const { rows } = await getTestPool().query<{ n: number }>('SELECT count(*)::int AS n FROM agency_contact_assignment_events');
    expect(rows[0]!.n).toBe(999);
    const per = (await owners());
    expect(per.get(null)).toBe(5);
    for (const a of agents) expect(per.get(a)).toBeGreaterThanOrEqual(199);

    // Beyond 2% (21 of 1,000 gone live): refused, nothing written.
    campaign = await insertAgencyCampaign({ disposition_catalog: JSON.stringify(CATALOG) }) as typeof campaign;
    for (const a of agents) await staff(a);
    const again = await seed(1_000);
    const second = await repo.agencyAssignmentRepository.preview(split, scope());
    await getTestPool().query(`UPDATE agency_contacts SET state = 'in_flight' WHERE id = ANY($1::uuid[])`, [again.slice(0, 21)]);
    const refused = await repo.agencyAssignmentRepository.commit({ op: split, scope: scope(), token: second.preview_token, actorUserId: supervisor });
    expect(refused.ok).toBe(false);
    expect((await owners()).get(null)).toBe(1_000);
  });

  it('refuses a token minted for another operation or seed', async () => {
    await seed(10);
    const p1 = await repo.agencyAssignmentRepository.preview(op({ kind: 'random_split', agent_user_ids: agents, seed: 'one' }), scope());
    const outcome = await repo.agencyAssignmentRepository.commit({
      op: op({ kind: 'random_split', agent_user_ids: agents, seed: 'two' }, 'commit'), scope: scope(), token: p1.preview_token, actorUserId: supervisor,
    });
    expect(outcome.ok).toBe(false);
    expect((await owners()).get(null)).toBe(10);
  });

  it('reports agents without an active staffing row', async () => {
    const stranger = randomUUID();
    await getTestPool().query('UPDATE agency_campaign_agents SET unassigned_at = now() WHERE user_id = $1', [agents[1]]);
    expect(await repo.agencyAssignmentRepository.unstaffed(DEFAULTS.tenantId, campaign.id, [agents[0]!, agents[1]!, stranger]))
      .toEqual([agents[1], stranger]);
  });
});

describe('count, filter, range', () => {
  it('count: the next N pool contacts in roster order, passing over live ones; a boundary group comes whole', async () => {
    const ids = await seed(10, { phone: (i) => (i === 5 || i === 6 ? '+915550000000' : `+91666000000${i}`) });
    await getTestPool().query(`UPDATE agency_contacts SET state = 'in_flight' WHERE id = $1`, [ids[1]]);
    await getTestPool().query(`UPDATE agency_contacts SET assigned_user_id = $2, assigned_at = now() WHERE id = $1`, [ids[0], agents[4]]);
    const { preview, outcome } = await commitPreviewed(op({ kind: 'count', agent_user_id: agents[0], count: 3 }));
    // Lines 3, 4, then the 5+6 group (starts at position 2 < 3): 4 contacts.
    expect(preview).toMatchObject({ matched: 4, moving: 4, skipped_live: 0, same_number_groups: 1 });
    expect(outcome.ok).toBe(true);
    for (const i of [2, 3, 4, 5]) expect(await ownerOf(ids[i]!)).toBe(agents[0]);
    for (const i of [1, 6, 7]) expect(await ownerOf(ids[i]!)).toBeNull();
  });

  it('count: closed contacts are nothing to work — reached, exhausted and DNC rows are passed over', async () => {
    const ids = await seed(6);
    await getTestPool().query(`UPDATE agency_contacts SET state = 'completed' WHERE id = $1`, [ids[0]]);
    await getTestPool().query(`UPDATE agency_contacts SET state = 'exhausted' WHERE id = $1`, [ids[1]]);
    await getTestPool().query(`UPDATE agency_contacts SET state = 'suppressed', suppressed_reason = 'dnc' WHERE id = $1`, [ids[2]]);
    // A pending row the DNC sweep has marked but not yet closed is not open either.
    await getTestPool().query(`UPDATE agency_contacts SET suppressed_reason = 'dnc' WHERE id = $1`, [ids[3]]);
    const { preview, outcome } = await commitPreviewed(op({ kind: 'count', agent_user_id: agents[0], count: 2 }));
    expect(preview).toMatchObject({ matched: 2, moving: 2 });
    expect(outcome.ok).toBe(true);
    for (const i of [4, 5]) expect(await ownerOf(ids[i]!)).toBe(agents[0]);
    for (const i of [0, 1, 2, 3]) expect(await ownerOf(ids[i]!)).toBeNull();
  });

  it('filter: a context column equal to one of the values after trimming, AND the states', async () => {
    const ids = await seed(6);
    const ctx = [' North', 'North ', 'East', 'South', 'north', 'East'];
    for (let i = 0; i < 6; i++) {
      await getTestPool().query(`UPDATE agency_contacts SET context = jsonb_build_object('Region', $2::text) WHERE id = $1`, [ids[i], ctx[i]]);
    }
    await getTestPool().query(`UPDATE agency_contacts SET state = 'completed' WHERE id = $1`, [ids[5]]);
    const filter = op({ kind: 'filter', agent_user_ids: [agents[2]], filter: { column: { name: 'Region', values: ['North', 'East '] }, states: ['pending'] } });
    const { preview, outcome } = await commitPreviewed(filter);
    expect(preview).toMatchObject({ matched: 3, moving: 3, seed: null });
    expect(outcome.ok).toBe(true);
    expect(await ownerOf(ids[0]!)).toBe(agents[2]);
    expect(await ownerOf(ids[1]!)).toBe(agents[2]);
    expect(await ownerOf(ids[2]!)).toBe(agents[2]);
    expect(await ownerOf(ids[4]!)).toBeNull(); // case differs
    expect(await ownerOf(ids[5]!)).toBeNull(); // completed

    const byDisposition = await repo.agencyAssignmentRepository.preview(
      op({ kind: 'filter', agent_user_ids: [agents[2]], filter: { last_dispositions: ['callback'] } }), scope());
    expect(byDisposition.matched).toBe(0);
  });

  it('range: the given ids of this campaign; one already with the target is unchanged', async () => {
    const ids = await seed(4);
    const other = await insertAgencyCampaign();
    const foreign = await insertAgencyContact(other.id as string);
    await getTestPool().query(`UPDATE agency_contacts SET assigned_user_id = $2, assigned_at = now() WHERE id = $1`, [ids[0], agents[3]]);
    const { preview, outcome } = await commitPreviewed(op({ kind: 'range', agent_user_id: agents[3], contact_ids: [ids[0], ids[1], ids[2], foreign.id] }));
    expect(preview).toMatchObject({ matched: 3, moving: 2, unchanged: 1 });
    expect(outcome.ok && outcome.result.moved).toBe(2);
    expect(await ownerOf(foreign.id as string)).toBeNull();
    const { rows } = await getTestPool().query<{ n: number }>('SELECT count(*)::int AS n FROM agency_contact_assignment_events WHERE contact_id = $1', [ids[0]]);
    expect(rows[0]!.n).toBe(0);
  });
});

describe('range never moves a closed contact', () => {
  it('a reached contact of another agent stays theirs; a live one is skipped_live; the open ones move', async () => {
    const ids = await seed(4);
    await getTestPool().query(
      `UPDATE agency_contacts SET state = 'completed', assigned_user_id = $2, assigned_at = now() WHERE id = $1`, [ids[0], agents[1]]);
    await getTestPool().query(`UPDATE agency_contacts SET state = 'in_flight' WHERE id = $1`, [ids[1]]);
    const { preview, outcome } = await commitPreviewed(op({ kind: 'range', agent_user_id: agents[3], contact_ids: ids }));
    expect(preview).toMatchObject({ matched: 3, moving: 2, skipped_live: 1 });
    expect(outcome.ok && outcome.result.moved).toBe(2);
    expect(await ownerOf(ids[0]!)).toBe(agents[1]);
    expect(await ownerOf(ids[1]!)).toBeNull();
    for (const i of [2, 3]) expect(await ownerOf(ids[i]!)).toBe(agents[3]);
  });
});

describe('reassign, unassign, rebalance', () => {
  async function give(userId: string, ids: string[]) {
    await getTestPool().query(`UPDATE agency_contacts SET assigned_user_id = $2, assigned_at = now() WHERE id = ANY($1::uuid[])`, [ids, userId]);
  }

  it('reassign: A\'s open contacts (all, or the first N) to B; terminal and live ones stay', async () => {
    const ids = await seed(13);
    await give(agents[0]!, ids);
    await getTestPool().query(`UPDATE agency_contacts SET state = 'completed' WHERE id = ANY($1::uuid[])`, [[ids[10], ids[11]]]);
    await getTestPool().query(`UPDATE agency_contacts SET state = 'in_flight' WHERE id = $1`, [ids[12]]);

    const first = await commitPreviewed(op({ kind: 'reassign', from_user_id: agents[0], to_user_id: agents[1], count: 3 }));
    expect(first.preview).toMatchObject({ matched: 3, moving: 3, skipped_live: 0 });
    expect(first.preview.per_agent).toEqual([
      { agent_user_id: agents[0], receiving: 0, giving: 3 },
      { agent_user_id: agents[1], receiving: 3, giving: 0 },
    ]);
    for (const i of [0, 1, 2]) expect(await ownerOf(ids[i]!)).toBe(agents[1]);

    const rest = await commitPreviewed(op({ kind: 'reassign', from_user_id: agents[0], to_user_id: agents[1] }));
    expect(rest.outcome.ok && rest.outcome.result.moved).toBe(7);
    expect((await owners()).get(agents[0]!)).toBe(3); // 2 completed + 1 in flight
    const { rows } = await getTestPool().query<{ reason: string; from_user_id: string; to_user_id: string; batches: number }>(
      `SELECT min(reason) AS reason, min(from_user_id::text) AS from_user_id, min(to_user_id::text) AS to_user_id,
              count(DISTINCT batch_id)::int AS batches FROM agency_contact_assignment_events`);
    expect(rows[0]).toEqual({ reason: 'reassign', from_user_id: agents[0], to_user_id: agents[1], batches: 2 });
  });

  it('unassign: A\'s first N open contacts, or given ids (live ones skipped), back to the pool', async () => {
    const ids = await seed(8);
    await give(agents[0]!, ids);
    const byCount = await commitPreviewed(op({ kind: 'unassign', from_user_id: agents[0], count: 2 }));
    expect(byCount.preview).toMatchObject({ moving: 2, to_pool: 2 });
    expect(await ownerOf(ids[0]!)).toBeNull();
    expect(await ownerOf(ids[1]!)).toBeNull();

    await getTestPool().query(`UPDATE agency_contacts SET state = 'connected' WHERE id = $1`, [ids[5]]);
    const byIds = await commitPreviewed(op({ kind: 'unassign', contact_ids: [ids[0], ids[4], ids[5]] }));
    expect(byIds.preview).toMatchObject({ matched: 3, moving: 1, unchanged: 1, skipped_live: 1, to_pool: 1 });
    expect(await ownerOf(ids[4]!)).toBeNull();
    expect(await ownerOf(ids[5]!)).toBe(agents[0]);
  });

  it('rebalance: never-attempted contacts move from above the average to below, attempted ones stay', async () => {
    const ids = await seed(12);
    await give(agents[0]!, ids.slice(0, 11));
    await give(agents[1]!, ids.slice(11));
    // Two of A's are not reached (attempted): they never move.
    await getTestPool().query(`UPDATE agency_contacts SET attempt_count = 1, last_outcome = 'no_answer' WHERE id = ANY($1::uuid[])`, [[ids[0], ids[1]]]);
    const three = agents.slice(0, 3);
    const { preview, outcome } = await commitPreviewed(op({ kind: 'rebalance', agent_user_ids: three }));
    expect(preview).toMatchObject({ moving: 7 });
    expect(preview.per_agent).toEqual([
      { agent_user_id: agents[0], receiving: 0, giving: 7 },
      { agent_user_id: agents[1], receiving: 3, giving: 0 },
      { agent_user_id: agents[2], receiving: 4, giving: 0 },
    ]);
    expect(outcome.ok).toBe(true);
    const counts = await owners();
    expect(three.map((a) => counts.get(a))).toEqual([4, 4, 4]);
    expect(await ownerOf(ids[0]!)).toBe(agents[0]);
    expect(await ownerOf(ids[1]!)).toBe(agents[0]);
    // Balanced now: a second rebalance moves nothing.
    expect((await repo.agencyAssignmentRepository.preview(op({ kind: 'rebalance', agent_user_ids: three }), scope())).moving).toBe(0);
  });
});

describe('unstaff (CA6)', () => {
  it('return_to_pool moves the open contacts and skips live ones; keep moves nothing; a campaign with none is silent', async () => {
    const keep = await insertAgencyCampaign({ on_unstaff: 'keep' }) as { id: string };
    const empty = await insertAgencyCampaign() as { id: string };
    const ids = await seed(4);
    const kept = await seed(2, { campaignId: keep.id, phone: (i) => `+91444000000${i}` });
    await getTestPool().query(`UPDATE agency_contacts SET assigned_user_id = $2, assigned_at = now() WHERE id = ANY($1::uuid[])`, [[...ids, ...kept], agents[0]]);
    await getTestPool().query(`UPDATE agency_contacts SET state = 'in_flight' WHERE id = $1`, [ids[0]]);
    await getTestPool().query(`UPDATE agency_contacts SET state = 'completed' WHERE id = $1`, [ids[1]]);

    const rows = await repo.agencyAssignmentRepository.returnOnUnstaff({
      tenantId: DEFAULTS.tenantId, userId: agents[0]!, campaignIds: [campaign.id, keep.id, empty.id], actorUserId: supervisor,
    });
    expect(rows.map((r) => ({ c: r.campaign_id, on: r.on_unstaff, moved: r.moved, live: r.skipped_live, kept: r.kept })).sort((a, b) => a.c.localeCompare(b.c)))
      .toEqual([
        { c: campaign.id, on: 'return_to_pool', moved: 2, live: 1, kept: 0 },
        { c: keep.id, on: 'keep', moved: 0, live: 0, kept: 2 },
      ].sort((a, b) => a.c.localeCompare(b.c)));
    expect(await ownerOf(ids[0]!)).toBe(agents[0]); // on a call
    expect(await ownerOf(ids[1]!)).toBe(agents[0]); // completed: history, not open
    expect(await ownerOf(ids[2]!)).toBeNull();
    expect(await ownerOf(kept[0]!)).toBe(agents[0]);
    const { rows: ev } = await getTestPool().query<{ reason: string; actor: string; n: number }>(
      `SELECT min(reason) AS reason, min(actor_user_id::text) AS actor, count(*)::int AS n FROM agency_contact_assignment_events`);
    expect(ev[0]).toEqual({ reason: 'unstaffed', actor: supervisor, n: 2 });
  });
});

describe('progress', () => {
  it('counts per owner and bucket agree with contactBucketSql', async () => {
    const ids = await seed(9);
    const a = agents[0]!;
    await getTestPool().query(`UPDATE agency_contacts SET assigned_user_id = $2, assigned_at = now() WHERE id = ANY($1::uuid[])`, [ids.slice(0, 7), a]);
    const set = (i: number, sql: string) => getTestPool().query(`UPDATE agency_contacts SET ${sql} WHERE id = $1`, [ids[i]]);
    await set(1, `attempt_count = 1, last_outcome = 'no_answer'`);
    await set(2, `attempt_count = 1, last_outcome = 'connected', last_disposition = 'callback', next_attempt_at = now() + interval '1 day'`);
    await set(3, `state = 'completed', attempt_count = 1`);
    await set(4, `state = 'in_flight'`);
    await set(5, `state = 'suppressed', suppressed_reason = 'dnc'`);
    await set(6, `state = 'exhausted', attempt_count = 3, last_outcome = 'busy'`);
    await insertAgencyAttempt(campaign.id, ids[1]!, { attempt_number: 1 });

    const raw = await repo.agencyAssignmentReadRepository.progress({ id: campaign.id, disposition_catalog: CATALOG as never });
    const mine = raw.owners.get(a)!;
    expect(mine.counts).toEqual({ pending: 1, callback: 1, not_reached: 1, in_progress: 1, reached: 1, exhausted: 1, suppressed: 1 });
    expect(mine).toMatchObject({ total: 7, attempted: 4, due_now: 2 });
    expect(raw.pool).toMatchObject({ total: 2, due_now: 2 });
    expect(raw.lastActivity.get(a)).toBeInstanceOf(Date);

    // The same fragment, read directly.
    const { rows } = await getTestPool().query<{ bucket: string; n: number }>(
      `SELECT ${contactBucketSql('c', '$2')} AS bucket, count(*)::int AS n FROM agency_contacts c
        WHERE c.campaign_id = $1 AND c.assigned_user_id = $3 GROUP BY 1`,
      [campaign.id, ['callback'], a]);
    for (const r of rows) expect(mine.counts[r.bucket as keyof typeof mine.counts]).toBe(r.n);
  });
});

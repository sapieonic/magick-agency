import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, insertAccount, insertTenant, insertUser } from '../setup/factories.js';
import { insertAgencyCampaign, insertAgencyContact, insertAgentSession } from './agency-factories.js';

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));
const { audit } = vi.hoisted(() => ({ audit: { log: vi.fn() } }));
vi.mock('../../../src/audit/platform/audit-logger.js', () => ({ platformAuditLogger: audit }));

const { agencyAssignmentRepository } = await import('../../../src/db/repositories/agency.repository.js');
const { parseAssignmentOperation } = await import('../../../src/agency/assignment/operation.js');
const { callbackCodes } = await import('../../../src/db/repositories/agency/assignment-sql.js');
const { sweepCallbackFallback } = await import('../../../src/agency/pacing/callback-fallback.js');

type Canonical = import('../../../src/agency/assignment/operation.js').CanonicalAssignment;
type LatePreview = import('@magick-agency/contracts/api/agency/assignment').AgencyLateCallbacksPreview;

/**
 * Give late callbacks to free agents (decisions LF7, LF21) on real Postgres: the
 * `late_callbacks_to_live_agents` operation planned and committed by the assignment repository's
 * one SQL builder. It moves only overdue callbacks whose owner is away (no session present on the
 * campaign), only to agents live on the campaign with an active staffing row, fewest callbacks due
 * first; on strict and preferred alike; a double press moves nothing twice; the CA5 sweep and the
 * hand-off never both move one callback; every move has its history row (`reassign`, the
 * supervisor). The pool-mode refusal and the audit row are the route's
 * (`test/integration/api/agency-contact-assignment.test.ts`).
 */

const CATALOG = [
  { code: 'interested', label: 'Interested' },
  { code: 'call_back', label: 'Call back', requires_datetime: true },
];
const SUPERVISOR = randomUUID();
const MIN = 60_000;

let campaign: Awaited<ReturnType<typeof makeCampaign>>;

async function makeCampaign(over: Record<string, unknown> = {}) {
  return insertAgencyCampaign({
    status: 'running', assignment_mode: 'strict', callback_fallback: 'pool', callback_owner_grace_minutes: 0,
    disposition_catalog: JSON.stringify(CATALOG), ...over,
  }) as Promise<Record<string, unknown> & { id: string; tenant_id: string }>;
}

const scope = (c = campaign) => ({ campaignId: c.id, tenantId: c.tenant_id, callbackCodes: callbackCodes(CATALOG as never) });

function op(raw: unknown = { kind: 'late_callbacks_to_live_agents' }, phase: 'preview' | 'commit' = 'preview'): Canonical {
  const r = parseAssignmentOperation(raw, phase);
  if (!r.ok) throw new Error(JSON.stringify(r.details));
  return r.op;
}

/** A callback (the catalog's `call_back` on a connected call) owned by `owner`, due `minutesAgo` ago (negative: later). */
async function callback(owner: string | null, minutesAgo: number, extra: Record<string, unknown> = {}, c = campaign) {
  return insertAgencyContact(c.id, {
    assigned_user_id: owner, assigned_at: owner ? new Date(Date.now() - 86_400_000) : null,
    attempt_count: 1, last_outcome: 'connected', last_disposition: 'call_back',
    next_attempt_at: new Date(Date.now() - minutesAgo * MIN), ...extra,
  }) as Promise<{ id: string }>;
}

/** Users staffed so far (the staffing row's FK needs one). */
const users = new Set<string>();

async function staff(userId: string, c = campaign, unassigned = false) {
  if (!users.has(userId)) {
    await insertUser({ id: userId });
    users.add(userId);
  }
  await getTestPool().query(
    'INSERT INTO agency_campaign_agents (tenant_id, account_id, campaign_id, user_id, unassigned_at) VALUES ($1, $2, $3, $4, $5)',
    [DEFAULTS.tenantId, DEFAULTS.accountId, c.id, userId, unassigned ? new Date() : null],
  );
}

/** A staffed agent with a session on the campaign in `state`. */
async function liveAgent(state = 'available', c = campaign): Promise<string> {
  const id = randomUUID();
  await staff(id, c);
  await insertAgentSession(c.id, { agent_user_id: id, state });
  return id;
}

async function ownerOf(id: string): Promise<string | null> {
  const { rows } = await getTestPool().query<{ uid: string | null }>('SELECT assigned_user_id::text AS uid FROM agency_contacts WHERE id = $1', [id]);
  return rows[0]!.uid;
}

async function events(c = campaign) {
  const { rows } = await getTestPool().query<{
    contact_id: string; from_user_id: string | null; to_user_id: string | null; actor_user_id: string | null; reason: string; batch_id: string;
  }>(
    `SELECT contact_id::text, from_user_id::text, to_user_id::text, actor_user_id::text, reason, batch_id::text
       FROM agency_contact_assignment_events WHERE campaign_id = $1 ORDER BY created_at, contact_id`, [c.id],
  );
  return rows;
}

async function preview(c = campaign): Promise<LatePreview> {
  return agencyAssignmentRepository.preview(op(), scope(c)) as Promise<LatePreview>;
}

async function commit(token: string, c = campaign) {
  return agencyAssignmentRepository.commit({ op: op(undefined, 'commit'), scope: scope(c), token, actorUserId: SUPERVISOR });
}

/** A clean database with the default tenant and account, and a running strict campaign. */
async function reset() {
  await truncateAll();
  users.clear();
  await insertTenant({ id: DEFAULTS.tenantId });
  await insertAccount({ id: DEFAULTS.accountId, tenant_id: DEFAULTS.tenantId });
  campaign = await makeCampaign();
}

beforeEach(async () => {
  audit.log.mockClear();
  await reset();
});
afterAll(closeTestPool);

describe('which callbacks move', () => {
  it('only overdue callbacks whose owner is away; never one not yet due, not a callback, in the pool, or a present owner\'s', async () => {
    const away = randomUUID();
    await staff(away);
    const present = await liveAgent('break'); // on a break is present: keeps their callbacks
    const receiver = await liveAgent('available');

    const late = await callback(away, 30);
    const notYet = await callback(away, -30);
    const notCallback = await callback(away, 30, { last_disposition: 'interested' });
    const reachedNot = await callback(away, 30, { last_outcome: 'no_answer' }); // a later call did not connect: not reached, no callback
    const inFlight = await callback(away, 30, { state: 'in_flight' });
    const dnc = await callback(away, 30, { suppressed_reason: 'dnc' });
    const inPool = await callback(null, 30);
    const presentOwners = await callback(present, 30);
    const inbound = await callback(away, 10, { last_outcome: null, last_disposition: null, attempt_count: 0, callback_source: 'inbound', callback_due_at: new Date(Date.now() - 10 * MIN) });

    const p = await preview();
    expect(p).toMatchObject({ kind: 'late_callbacks_to_live_agents', seed: null, matched: 2, moving: 2, skipped_live: 0, to_pool: 0 });
    // The present owner (on a break) could receive too: live is present, not "available".
    expect(new Set(p.live_agent_user_ids)).toEqual(new Set([present, receiver]));

    const done = await commit(p.preview_token);
    expect(done.ok).toBe(true);
    expect(done.ok && done.result).toMatchObject({ kind: 'late_callbacks_to_live_agents', moved: 2, skipped_live: 0, to_pool: 0 });
    for (const moved of [late, inbound]) expect([present, receiver]).toContain(await ownerOf(moved.id));
    for (const kept of [notYet, notCallback, reachedNot, inFlight, dnc]) expect(await ownerOf(kept.id)).toBe(away);
    expect(await ownerOf(inPool.id)).toBeNull();
    expect(await ownerOf(presentOwners.id)).toBe(present);
  });

  it('an owner whose station closed, who left, or who is live only on another campaign is away', async () => {
    const offline = randomUUID();
    await staff(offline);
    await insertAgentSession(campaign.id, { agent_user_id: offline, state: 'offline' });
    const left = randomUUID();
    await insertAgentSession(campaign.id, { agent_user_id: left, state: 'offline', left_at: new Date() });
    const elsewhere = randomUUID();
    const other = await makeCampaign({ status: 'paused' });
    await insertAgentSession(other.id, { agent_user_id: elsewhere, state: 'available' });
    const receiver = await liveAgent();

    const contacts = [await callback(offline, 5), await callback(left, 5), await callback(elsewhere, 5)];
    const p = await preview();
    expect(p.moving).toBe(3);
    expect((await commit(p.preview_token)).ok).toBe(true);
    for (const c of contacts) expect(await ownerOf(c.id)).toBe(receiver);
  });
});

describe('who receives', () => {
  it('only agents live on the campaign and staffed on it', async () => {
    const away = randomUUID();
    const late = await Promise.all([1, 2, 3, 4].map((m) => callback(away, m)));
    const receiver = await liveAgent('on_call');
    // Present but not staffed (unassigned since), offline but staffed, live on another campaign.
    const unstaffed = randomUUID();
    await staff(unstaffed, campaign, true);
    await insertAgentSession(campaign.id, { agent_user_id: unstaffed, state: 'available' });
    const offline = randomUUID();
    await staff(offline);
    await insertAgentSession(campaign.id, { agent_user_id: offline, state: 'offline' });
    const other = await makeCampaign();
    const onOther = randomUUID();
    await staff(onOther);
    await insertAgentSession(other.id, { agent_user_id: onOther, state: 'available' });

    const p = await preview();
    expect(p.live_agent_user_ids).toEqual([receiver]);
    expect(p.per_agent).toEqual([
      { agent_user_id: receiver, receiving: 4, giving: 0 },
      { agent_user_id: away, receiving: 0, giving: 4 },
    ]);
    expect((await commit(p.preview_token)).ok).toBe(true);
    for (const c of late) expect(await ownerOf(c.id)).toBe(receiver);
  });

  it('fewest callbacks due first: the emptiest agent gets the oldest, and the dealing levels them', async () => {
    const away = randomUUID();
    // Five late callbacks of an away owner, due 50, 40, 30, 20, 10 minutes ago.
    const late = [];
    for (const m of [50, 40, 30, 20, 10]) late.push(await callback(away, m));
    const busy = await liveAgent();
    const idle = await liveAgent();
    // `busy` already has two callbacks due (their own; they stay), `idle` none. One more of busy's
    // is due later, which does not count.
    await callback(busy, 5);
    await callback(busy, 1);
    await callback(busy, -60);

    const p = await preview();
    expect(p.live_agent_user_ids).toEqual([idle, busy]);
    // idle 0 → 4, busy 2 → 3: level 3, the one over to the emptiest at the start.
    expect(p.per_agent).toEqual([
      { agent_user_id: idle, receiving: 4, giving: 0 },
      { agent_user_id: busy, receiving: 1, giving: 0 },
      { agent_user_id: away, receiving: 0, giving: 5 },
    ]);
    const done = await commit(p.preview_token);
    expect(done.ok && done.result.per_agent).toEqual(p.per_agent);
    expect(await Promise.all(late.map((c) => ownerOf(c.id)))).toEqual([idle, idle, idle, idle, busy]);
  });

  it('nobody live: nothing would move, and the preview says nobody could receive', async () => {
    const away = randomUUID();
    const late = await callback(away, 10);
    const p = await preview();
    expect(p).toMatchObject({ matched: 1, moving: 0, unchanged: 1, live_agent_user_ids: [], per_agent: [] });
    const done = await commit(p.preview_token);
    expect(done.ok && done.result.moved).toBe(0);
    expect(await ownerOf(late.id)).toBe(away);
    expect(await events()).toEqual([]);
  });

  it('keeps contacts on one number together, with one receiver', async () => {
    const [a1, a2] = [randomUUID(), randomUUID()];
    const shared = await callback(a1, 30, { phone_e164: '+919812345678' });
    const twin = await callback(a2, 5, { phone_e164: '+91 98123 45678' });
    for (let i = 0; i < 4; i += 1) await liveAgent();
    const p = await preview();
    expect(p).toMatchObject({ moving: 2, same_number_groups: 1 });
    expect((await commit(p.preview_token)).ok).toBe(true);
    expect(await ownerOf(shared.id)).toBe(await ownerOf(twin.id));
  });
});

describe('on strict and preferred alike, recorded', () => {
  it.each(['strict', 'preferred'])('%s: moves, with one history row per contact (reassign, the supervisor, one batch)', async (mode) => {
    campaign = await makeCampaign({ assignment_mode: mode });
    const away = randomUUID();
    const late = [await callback(away, 20), await callback(away, 10)];
    const receiver = await liveAgent();

    const p = await preview();
    const done = await commit(p.preview_token);
    expect(done.ok).toBe(true);
    const batch = done.ok ? done.result.batch_id : '';
    const history = await events();
    expect(history).toHaveLength(2);
    for (const e of history) {
      expect(e).toMatchObject({ from_user_id: away, to_user_id: receiver, actor_user_id: SUPERVISOR, reason: 'reassign', batch_id: batch });
    }
    expect(history.map((e) => e.contact_id).sort()).toEqual(late.map((c) => c.id).sort());
    const { rows } = await getTestPool().query('SELECT assigned_by_user_id::text AS by, assigned_at FROM agency_contacts WHERE id = $1', [late[0]!.id]);
    expect(rows[0]).toMatchObject({ by: SUPERVISOR, assigned_at: expect.any(Date) });
  });
});

describe('concurrency', () => {
  it('a second press of the same preview moves nothing: preview_stale, a fresh preview moving 0', async () => {
    const away = randomUUID();
    for (const m of [1, 2, 3]) await callback(away, m);
    await liveAgent();
    const p = await preview();

    expect((await commit(p.preview_token)).ok).toBe(true);
    const again = await commit(p.preview_token);
    expect(again.ok).toBe(false);
    expect(!again.ok && again.preview).toMatchObject({ kind: 'late_callbacks_to_live_agents', matched: 0, moving: 0 });
    expect(await events()).toHaveLength(3);
  });

  it('a double press at once: one commits, the other is stale, and every callback moved once', async () => {
    const away = randomUUID();
    for (let m = 1; m <= 30; m += 1) await callback(away, m);
    await liveAgent();
    await liveAgent();
    const p = await preview();

    const results = await Promise.all([commit(p.preview_token), commit(p.preview_token)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const stale = results.find((r) => !r.ok);
    expect(stale && !stale.ok && stale.preview.moving).toBe(0);
    const history = await events();
    expect(history).toHaveLength(30);
    expect(new Set(history.map((e) => e.contact_id)).size).toBe(30);
  });

  it('the CA5 sweep first: the callbacks went to the pool, so the hand-off is stale and takes none from it', async () => {
    const away = randomUUID();
    const late = [await callback(away, 20), await callback(away, 10)];
    await liveAgent();
    const p = await preview();

    expect(await sweepCallbackFallback(campaign as never)).toBe(2);
    const done = await commit(p.preview_token);
    expect(done.ok).toBe(false);
    expect(!done.ok && done.preview.moving).toBe(0);
    for (const c of late) expect(await ownerOf(c.id)).toBeNull();
    expect((await events()).map((e) => e.reason)).toEqual(['callback_fallback', 'callback_fallback']);
  });

  it('the hand-off first: the sweep finds the callbacks with a present owner and moves none', async () => {
    const away = randomUUID();
    const late = [await callback(away, 20), await callback(away, 10)];
    const receiver = await liveAgent();
    const p = await preview();
    expect((await commit(p.preview_token)).ok).toBe(true);

    expect(await sweepCallbackFallback(campaign as never)).toBe(0);
    for (const c of late) expect(await ownerOf(c.id)).toBe(receiver);
  });

  it('the hand-off and the sweep at once: every callback is moved by one of them, once', async () => {
    for (let round = 0; round < 5; round += 1) {
      await reset();
      const away = randomUUID();
      const late = [];
      for (let m = 1; m <= 40; m += 1) late.push(await callback(away, m));
      const receiver = await liveAgent();
      const p = await preview();

      const [handOff, swept] = await Promise.all([commit(p.preview_token), sweepCallbackFallback(campaign as never)]);
      const history = await events();
      // Each callback has at most one owner change, and its owner now is where that change took it.
      expect(new Set(history.map((e) => e.contact_id)).size, `round ${round}`).toBe(history.length);
      const byContact = new Map(history.map((e) => [e.contact_id, e]));
      for (const c of late) {
        const e = byContact.get(c.id);
        expect(await ownerOf(c.id), `round ${round}`).toBe(e ? e.to_user_id : away);
      }
      const handed = history.filter((e) => e.reason === 'reassign');
      const pooled = history.filter((e) => e.reason === 'callback_fallback');
      expect(pooled).toHaveLength(swept);
      expect(handed).toHaveLength(handOff.ok ? handOff.result.moved : 0);
      for (const e of handed) expect(e.to_user_id).toBe(receiver);
      expect(handed.length + pooled.length, `round ${round}`).toBe(40);
    }
  });
});

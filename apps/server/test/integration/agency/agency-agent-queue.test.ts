import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAgencyCampaign, insertAgencyContact } from './agency-factories.js';

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));

const { agencyContactRepository } = await import('../../../src/db/repositories/agency.repository.js');
const { readAgentQueueState, readAgentQueues } = await import('../../../src/agency/pacing/agent-queue.js');

/**
 * An agent's own queue on a `strict` / `preferred` campaign (D3), read on real Postgres:
 * the probe pacing runs every tick, and the `AgencyQueueState` the bootstrap, `ready` and
 * the `queue` frame carry — one case per reason, and the earliest `next_due_at`.
 */

const A = randomUUID();
const B = randomUUID();
const CATALOG = [
  { code: 'interested', label: 'Interested' },
  { code: 'call_back', label: 'Call back', requires_datetime: true },
];

async function campaign(mode: 'strict' | 'preferred', overrides: Record<string, unknown> = {}) {
  return insertAgencyCampaign({
    status: 'running', assignment_mode: mode, disposition_catalog: JSON.stringify(CATALOG), ...overrides,
  });
}

/** An open contact, due `inSeconds` from now (negative: already due). */
async function open(campaignId: string, owner: string | null, inSeconds: number, extra: Record<string, unknown> = {}) {
  return insertAgencyContact(campaignId, {
    assigned_user_id: owner, assigned_at: owner ? new Date() : null,
    next_attempt_at: new Date(Date.now() + inSeconds * 1_000), ...extra,
  });
}

/** A callback booked for `inSeconds` from now: attempted, its last outcome a callback code. */
function callback(campaignId: string, owner: string | null, inSeconds: number) {
  return open(campaignId, owner, inSeconds, { attempt_count: 1, last_outcome: 'connected', last_disposition: 'call_back' });
}

/** A retry scheduled `inSeconds` from now: attempted, not reached. */
function retry(campaignId: string, owner: string | null, inSeconds: number) {
  return open(campaignId, owner, inSeconds, { attempt_count: 1, last_outcome: 'no_answer' });
}

describe('the agent queue (strict / preferred)', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  it('due: an own contact is due now (next_due_at null while due)', async () => {
    const c = await campaign('strict');
    await open(c.id, A, -60);
    await retry(c.id, A, 3_600);

    expect(await readAgentQueueState(c, A)).toEqual({ due: true, reason: null, next_due_at: null });
  });

  it("queue_empty: nothing open is theirs (another agent's and the pool's do not count in strict mode)", async () => {
    const c = await campaign('strict');
    await open(c.id, B, -60);
    await open(c.id, null, -60);
    await open(c.id, A, -60, { state: 'completed' });

    expect(await readAgentQueueState(c, A)).toEqual({ due: false, reason: 'queue_empty', next_due_at: null });
  });

  it('waiting_for_retry: open contacts all scheduled later; next_due_at is the earliest of them', async () => {
    const c = await campaign('strict');
    const soon = await retry(c.id, A, 600);
    await callback(c.id, A, 300_000);
    await open(c.id, A, 7_200);

    expect(await readAgentQueueState(c, A)).toEqual({
      due: false, reason: 'waiting_for_retry', next_due_at: (soon.next_attempt_at as Date).toISOString(),
    });
  });

  it('callbacks_later: every open contact of theirs is a callback booked for later', async () => {
    const c = await campaign('strict');
    const first = await callback(c.id, A, 900);
    await callback(c.id, A, 1_800);

    expect(await readAgentQueueState(c, A)).toEqual({
      due: false, reason: 'callbacks_later', next_due_at: (first.next_attempt_at as Date).toISOString(),
    });
  });

  it('outside_calling_hours: the campaign window is closed now, whatever is waiting', async () => {
    // An empty window (start == end) is closed at every instant.
    const c = await campaign('strict', { calling_window_start: '09:00:00', calling_window_end: '09:00:00' });
    const later = await retry(c.id, A, 600);
    expect(await readAgentQueueState(c, A)).toEqual({
      due: false, reason: 'outside_calling_hours', next_due_at: (later.next_attempt_at as Date).toISOString(),
    });

    // Nothing open at all reads the same while the window is shut.
    expect(await readAgentQueueState(c, B)).toEqual({ due: false, reason: 'outside_calling_hours', next_due_at: null });
  });

  it('a DNC-suppressed pending row is not open work', async () => {
    const c = await campaign('strict');
    await open(c.id, A, -60, { suppressed_reason: 'dnc' });

    expect(await readAgentQueueState(c, A)).toEqual({ due: false, reason: 'queue_empty', next_due_at: null });
  });

  it('preferred: the pool counts — due from the pool, waiting on it, and empty only when both are', async () => {
    const c = await campaign('preferred');
    expect(await readAgentQueueState(c, A)).toEqual({ due: false, reason: 'queue_empty', next_due_at: null });

    const poolLater = await retry(c.id, null, 1_200);
    const ownLater = await callback(c.id, A, 2_400);
    // Own: a callback later; pool: a retry later → not all callbacks, earliest of both.
    expect(await readAgentQueueState(c, A)).toEqual({
      due: false, reason: 'waiting_for_retry', next_due_at: (poolLater.next_attempt_at as Date).toISOString(),
    });
    expect(ownLater).toBeDefined();

    await open(c.id, null, -30);
    expect(await readAgentQueueState(c, A)).toEqual({ due: true, reason: null, next_due_at: null });
  });

  it('pool mode has no per-agent queue', async () => {
    const c = await insertAgencyCampaign({ status: 'running', assignment_mode: 'pool' });
    await open(c.id, A, -60);
    expect(await readAgentQueueState(c, A)).toBeUndefined();
  });

  it('one probe for many agents: who has own work due, and the pool due count bounded by the cap', async () => {
    const c = await campaign('preferred');
    await open(c.id, A, -60);
    await retry(c.id, B, 600);
    for (let i = 0; i < 5; i++) await open(c.id, null, -10 - i);

    const C = randomUUID();
    const { agents, poolDue } = await readAgentQueues(c, 'preferred', [A, B, C], new Date(), 3);

    expect(agents.get(A)).toMatchObject({ ownDue: true });
    expect(agents.get(B)).toMatchObject({ ownDue: false });
    // B and C have nothing of their own due, but the pool does: they read due.
    expect(agents.get(B)!.state.due).toBe(true);
    expect(agents.get(C)!.state.due).toBe(true);
    expect(poolDue).toBe(3);

    const probe = await agencyContactRepository.probeAgentQueues(c.id, [A, B, C], { callbackCodes: ['call_back'] });
    expect(probe.pool).toBeNull();
    expect(probe.agents.find((r) => r.agentUserId === C)).toEqual({
      agentUserId: C, ownDue: false, ownNextAt: null, ownHasNonCallback: null,
    });
  });
});

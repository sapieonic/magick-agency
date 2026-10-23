import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { scaled } from '../../helpers/load-scale.js';

await vi.hoisted(async () => {
  process.env['LOG_LEVEL'] ??= 'warn';
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

const { createFloorWorld, closeFloorPool, attemptRows, contactStateCounts } = await import('./floor-harness.js');
const { agencyCampaignRepository } = await import('../../../src/db/repositories/agency.repository.js');
const { RETRY_INHERITED_CONFIG_KEYS } = await import('@magick-agency/domain/retry-campaign-bounds');

type World = Awaited<ReturnType<typeof createFloorWorld>>;

/**
 * ─── A RETRY STORM, UNDER A SPLIT BRAIN ─────────────────────────────────────
 *
 * Most calls fail in a retryable way (no answer, busy, carrier failure), every
 * retry is due immediately, and TWO pacing engines tick every campaign at once —
 * the split brain the leader lease cannot exclude. So the same contacts come back
 * to `pending` over and over while two leaders race to claim them and to insert
 * the next attempt number for them. This is where an attempt-number collision, a
 * retry seeded twice, or a contact dialled by both leaders at once would show.
 *
 * Asserted every round: the floor invariants (no contact or agent with two live
 * attempts, Redis and Postgres agreeing, nothing stranded). At the end:
 *  - attempt numbers are unique and gapless per contact (the final audit), with
 *    contacts reaching their fourth attempt;
 *  - the retry policy bounded every contact: no contact took more attempts than
 *    its policy allows, every `exhausted` contact used up the allowance for its
 *    last outcome, every `completed` one ended on an outcome that does not retry;
 *  - a RETRY CAMPAIGN seeded from the stormed parent selects exactly the contacts
 *    its selector names, chains each to its parent's lineage, and — run on the
 *    floor — numbers its own attempts from 1 while showing the agent the parent's
 *    history for that customer.
 */

const POLICY = {
  no_answer: { delay_minutes: 0, max_attempts: 4 },
  busy: { delay_minutes: 0, max_attempts: 4 },
  failed: { delay_minutes: 0, max_attempts: 3 },
  invalid: { max_attempts: 0 },
  connected: { max_attempts: 0 },
  abandoned: { delay_minutes: 0, max_attempts: 2 },
  agent_disconnected: { delay_minutes: 0, max_attempts: 3 },
  orphaned: { delay_minutes: 0, max_attempts: 3 },
  canceled: { delay_minutes: 0, max_attempts: 3 },
} as const;

const STORM_MIX = { no_answer: 45, busy: 22, failed: 13, ring_hangup: 8, connected_short: 10, invalid: 2 };

describe('retry storm (load)', () => {
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

  it('two leaders racing a mostly-retryable roster never collide, and the retry policy and retry seeding hold', async () => {
    world = await createFloorWorld({
      splitBrain: true,
      mix: STORM_MIX,
      campaigns: [
        { label: 'S1', tenant: 't1', account: 's1', agents: scaled(30), contacts: scaled(400), maxConcurrentCalls: scaled(30), campaign: { retry_policy: JSON.stringify(POLICY) } },
        { label: 'S2', tenant: 't2', account: 's2', agents: scaled(30), contacts: scaled(400), maxConcurrentCalls: scaled(40), campaign: { retry_policy: JSON.stringify(POLICY) } },
      ],
    });
    const seed = world.seed;
    const db = getTestPool();
    const violations: string[] = [];
    await world.runUntilDrained({
      maxRounds: scaled(4000),
      onRound: async () => {
        violations.push(...await world.checkInvariants());
        if (violations.length) throw new Error(violations.slice(0, 10).join('\n'));
      },
    });
    const audit = await world.finalAudit();
    expect(audit, audit.slice(0, 20).join('\n')).toEqual([]);
    const s1 = world.campaign('S1');
    const s2 = world.campaign('S2');
    for (const label of ['S1', 'S2']) expect(await world.status(label), `${label}, seed ${seed}`).toBe('completed');

    // ── It was a storm ──────────────────────────────────────────────────────
    const rows = await attemptRows([s1.id, s2.id]);
    const totalContacts = s1.spec.contacts + s2.spec.contacts;
    expect(rows.length, `seed ${seed}`).toBeGreaterThan(totalContacts * 2);
    expect(Math.max(...rows.map((r) => r.attempt_number)), `seed ${seed}`).toBe(4);
    // Both leaders genuinely dialled: the race was real, not one engine idling.
    expect(world.forkDials, `seed ${seed}`).toBeGreaterThan(rows.length / 10);
    expect(world.forkDials, `seed ${seed}`).toBeLessThan(rows.length);

    // ── The policy bounded every contact ────────────────────────────────────
    const { rows: contacts } = await db.query<{ id: string; state: string; attempt_count: number; our_fault_attempts: number; last_outcome: string | null; suppressed_reason: string | null }>(
      `SELECT id, state, attempt_count, our_fault_attempts, last_outcome, suppressed_reason FROM agency_contacts WHERE campaign_id = ANY($1::uuid[])`,
      [[s1.id, s2.id]]);
    for (const c of contacts) {
      const rule = POLICY[c.last_outcome as keyof typeof POLICY];
      const label = `contact ${c.id} (${c.state}, ${c.last_outcome}, ${c.attempt_count}), seed ${seed}`;
      expect(rule, label).toBeDefined();
      expect(c.attempt_count, label).toBeGreaterThan(0);
      expect(c.attempt_count, label).toBeLessThanOrEqual(4);
      if (c.state === 'exhausted') expect(c.attempt_count, label).toBeGreaterThanOrEqual(rule.max_attempts);
      else if (c.state === 'completed') expect(rule.max_attempts, label).toBe(0);
      else if (c.state === 'suppressed') expect([c.last_outcome, c.suppressed_reason], label).toEqual(['invalid', 'invalid']);
      else throw new Error(`${label}: not terminal`);
    }
    const s1States = await contactStateCounts(s1.id);
    expect(s1States['exhausted'] ?? 0, `seed ${seed}`).toBeGreaterThan(0);

    // ── Retry seeding from the stormed parent ───────────────────────────────
    const parent = (await agencyCampaignRepository.findById(s1.id))!;
    const selector = { last_outcome: ['no_answer', 'busy'] };
    const { rows: expected } = await db.query<{ id: string; phone_e164: string; root_contact_id: string }>(
      `SELECT id, phone_e164, root_contact_id FROM agency_contacts
        WHERE campaign_id = $1 AND last_outcome IN ('no_answer', 'busy')`, [s1.id]);
    const preview = await agencyCampaignRepository.retryPreview(s1.id, selector as never);
    expect(preview?.matched, `seed ${seed}`).toBe(expected.length);
    const config = Object.fromEntries(
      RETRY_INHERITED_CONFIG_KEYS.map((k) => [k, (parent as unknown as Record<string, unknown>)[k]]));
    const result = await agencyCampaignRepository.retryFromCampaign({
      parent, selector: selector as never, name: 'storm retry', config: config as never, createdBy: null, idempotencyKey: null,
    });
    expect(result.status, `seed ${seed}`).toBe('created');
    if (result.status !== 'created') return;
    expect(result.contacts_seeded, `seed ${seed}`).toBe(expected.length);
    const childId = result.campaign.id;
    const { rows: children } = await db.query<{ id: string; phone_e164: string; root_contact_id: string; state: string; attempt_count: number }>(
      `SELECT id, phone_e164, root_contact_id, state, attempt_count FROM agency_contacts WHERE campaign_id = $1`, [childId]);
    // Exactly the selected contacts, each chained to its parent's lineage, fresh.
    expect(children.map((c) => c.root_contact_id).sort(), `seed ${seed}`).toEqual(expected.map((c) => c.root_contact_id).sort());
    for (const c of children) {
      expect(c.state).toBe('pending');
      expect(c.attempt_count).toBe(0);
      expect(expected.find((e) => e.root_contact_id === c.root_contact_id)?.phone_e164).toBe(c.phone_e164);
    }

    // ── The child runs on the floor ─────────────────────────────────────────
    expect(await agencyCampaignRepository.transitionStatus(childId, ['draft'], 'running')).not.toBeNull();
    world.carrier.mixByCampaign.set(childId, { connected_short: 1 });
    const child = await world.adoptCampaign(childId, { label: 'S1-retry', agents: scaled(20) });
    await world.runUntilDrained({
      maxRounds: scaled(2000),
      onRound: async () => {
        violations.push(...await world.checkInvariants());
        if (violations.length) throw new Error(violations.slice(0, 10).join('\n'));
      },
    });
    const childAudit = await world.finalAudit();
    expect(childAudit, childAudit.slice(0, 20).join('\n')).toEqual([]);
    expect(await world.status('S1-retry')).toBe('completed');
    const childRows = await attemptRows([child.id]);
    expect(childRows.length, `seed ${seed}`).toBe(children.length);
    // Numbered from 1 in the child — the counter is per contact row, and a retry
    // copies the row.
    expect(childRows.every((r) => r.attempt_number === 1), `seed ${seed}`).toBe(true);
    // The agent was shown the parent's history for that customer: the lineage read.
    const parentAttemptsByRoot = new Map<string, number>();
    for (const r of rows.filter((x) => x.campaign_id === s1.id)) {
      const root = expected.find((e) => e.id === r.contact_id)?.root_contact_id;
      if (root) parentAttemptsByRoot.set(root, (parentAttemptsByRoot.get(root) ?? 0) + 1);
    }
    let panels = 0;
    for (const a of world.agents.filter((x) => x.campaignId === child.id)) {
      for (const f of a.socket.ofType('reserved')) {
        const panel = f['attempt'] as { contact_id: string; prior_attempts: Array<{ campaign_id: string }> };
        const root = children.find((c) => c.id === panel.contact_id)!.root_contact_id;
        const fromParent = panel.prior_attempts.filter((p) => p.campaign_id === s1.id).length;
        expect(fromParent, `seed ${seed}: panel for ${panel.contact_id} lost its lineage`).toBe(parentAttemptsByRoot.get(root));
        panels++;
      }
    }
    expect(panels, `seed ${seed}`).toBe(children.length);
    console.info(`[retry-storm] seed=${seed} attempts=${rows.length} retrySeeded=${children.length} rounds=${world.roundsRun}`);
  }, 600_000);
});

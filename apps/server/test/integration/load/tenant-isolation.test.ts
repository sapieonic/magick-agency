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

const { createFloorWorld, closeFloorPool, attemptRows, pacingViolations } = await import('./floor-harness.js');

type World = Awaited<ReturnType<typeof createFloorWorld>>;

/**
 * ─── MULTI-TENANT FAIRNESS AND ISOLATION UNDER LOAD ─────────────────────────
 *
 * One replica leads every tenant's campaigns, on one pool, one Redis and one set
 * of tables, so a saturated tenant is a neighbour of every other tenant on the
 * floor. Two properties must hold however hard it is pushed:
 *
 * - **Fairness.** The saturated tenant's load must not reduce another tenant's
 *   dialing: the small tenant's tick dials exactly `min(available, cap − live,
 *   claimable)` every round — its OWN pacing law, untouched by the neighbour —
 *   and it completes while the neighbour is still working.
 * - **Isolation.** Nothing crosses a tenant: no attempt pairs one tenant's contact
 *   with another's agent or campaign, no station is shown another campaign's call,
 *   each account's cap binds that account alone — and, the case most likely to be
 *   got wrong, the SAME customer number on two tenants' rosters is two independent
 *   customers. A Do Not Call entry belongs to the tenant (or campaign) that holds
 *   it: tenant X's tenant-wide entry suppresses X's contact and must not suppress
 *   tenant Y's contact with the same number, and Y's campaign-scoped entry
 *   suppresses only Y's.
 *
 * Shape: tenant X runs two accounts, one SATURATED (more agents than its cap, and
 * the largest roster on the floor); tenant Y runs one small campaign whose roster
 * is the first numbers of X's.
 */

const shared = (i: number) => `+9196${String(i).padStart(8, '0')}`;

describe('multi-tenant fairness and isolation under load (load)', () => {
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

  it('a saturated tenant neither starves nor leaks into another, and DNC stays with the tenant that holds it', async () => {
    const X1_CAP = scaled(25);
    const Y_CONTACTS = scaled(200);
    world = await createFloorWorld({
      campaigns: [
        { label: 'X1', tenant: 'tx', account: 'x1', agents: scaled(40), contacts: scaled(1000), maxConcurrentCalls: X1_CAP, phoneFor: shared },
        { label: 'X2', tenant: 'tx', account: 'x2', agents: scaled(20), contacts: scaled(400), maxConcurrentCalls: scaled(20) },
        { label: 'Y1', tenant: 'ty', account: 'y1', agents: scaled(10), contacts: Y_CONTACTS, maxConcurrentCalls: scaled(10), phoneFor: shared },
      ],
    });
    const seed = world.seed;
    const db = getTestPool();
    const x1 = world.campaign('X1');
    const x2 = world.campaign('X2');
    const y1 = world.campaign('Y1');

    // Tenant X: tenant-wide DNC on the first 40 shared numbers.
    const xDnc = Array.from({ length: 40 }, (_, i) => shared(i));
    // Tenant Y: campaign-scoped DNC on ten numbers further along.
    const yDnc = Array.from({ length: 10 }, (_, i) => shared(150 + i));
    await db.query(
      `INSERT INTO dnc_entries (tenant_id, account_id, campaign_id, phone_e164, source)
       SELECT $1, NULL, NULL, p, 'import' FROM unnest($2::text[]) AS p`, [x1.tenantId, xDnc]);
    await db.query(
      `INSERT INTO dnc_entries (tenant_id, account_id, campaign_id, phone_e164, source)
       SELECT $1, $2, $3, p, 'import' FROM unnest($4::text[]) AS p`, [y1.tenantId, y1.accountId, y1.id, yDnc]);

    const violations: string[] = [];
    let yCompletedAt: number | null = null;
    let xBusyWhenYCompleted = false;
    await world.runUntilDrained({
      maxRounds: scaled(3000),
      onRound: async (r) => {
        violations.push(...await world.checkInvariants(), ...pacingViolations(r, seed));
        if (yCompletedAt === null && (await world.status('Y1')) === 'completed') {
          yCompletedAt = r.round;
          xBusyWhenYCompleted = (await world.status('X1')) === 'running';
        }
        if (violations.length > 0) throw new Error(violations.slice(0, 10).join('\n'));
      },
    });
    expect(violations).toEqual([]);
    const audit = await world.finalAudit();
    expect(audit, audit.slice(0, 20).join('\n')).toEqual([]);
    for (const label of ['X1', 'X2', 'Y1']) expect(await world.status(label), `${label}, seed ${seed}`).toBe('completed');

    // ── Fairness: the small tenant finished while the saturated one was busy ──
    expect(yCompletedAt, `seed ${seed}`).not.toBeNull();
    expect(xBusyWhenYCompleted, `seed ${seed}: Y1 only finished once X1 had`).toBe(true);

    // ── Each account's cap bound that account, exactly, and only it ─────────
    const peak = (c: typeof x1) => world.carrier.peakLiveByAccount.get(`${c.tenantId}:${c.accountId}`) ?? 0;
    expect(peak(x1), `seed ${seed}`).toBe(X1_CAP);
    expect(peak(y1), `seed ${seed}`).toBeLessThanOrEqual(y1.spec.maxConcurrentCalls);
    expect(peak(x2), `seed ${seed}`).toBeLessThanOrEqual(x2.spec.maxConcurrentCalls);

    // ── DNC belongs to the tenant (or campaign) that holds it ───────────────
    const rows = await attemptRows([x1.id, x2.id, y1.id]);
    const { rows: contacts } = await db.query<{ id: string; campaign_id: string; phone_e164: string; state: string; suppressed_reason: string | null }>(
      `SELECT id, campaign_id, phone_e164, state, suppressed_reason FROM agency_contacts WHERE campaign_id = ANY($1::uuid[])`,
      [[x1.id, y1.id]]);
    const dialledContacts = new Set(rows.filter((r) => r.webrtc_call_id !== null).map((r) => r.contact_id));
    const attemptedContacts = new Set(rows.map((r) => r.contact_id));
    for (const c of contacts) {
      const xBlocked = c.campaign_id === x1.id && xDnc.includes(c.phone_e164);
      const yBlocked = c.campaign_id === y1.id && yDnc.includes(c.phone_e164);
      const label = `${c.campaign_id === x1.id ? 'X1' : 'Y1'} ${c.phone_e164}, seed ${seed}`;
      if (xBlocked || yBlocked) {
        expect(c.state, label).toBe('suppressed');
        expect(c.suppressed_reason, label).toBe('dnc');
        expect(attemptedContacts.has(c.id), `${label}: a DNC number got an attempt`).toBe(false);
      } else if (xDnc.includes(c.phone_e164) || yDnc.includes(c.phone_e164)) {
        // The other tenant's entry for the same number: dialled like anyone else.
        expect(dialledContacts.has(c.id), `${label}: suppressed by ANOTHER tenant's DNC entry`).toBe(true);
        expect(c.suppressed_reason, label).not.toBe('dnc');
      }
    }

    // ── No station was shown another campaign's call ────────────────────────
    let framesChecked = 0;
    for (const a of world.agents) {
      for (const f of a.socket.ofType('reserved')) {
        const attempt = f['attempt'] as { campaign_id: string; attempt_id: string };
        framesChecked++;
        expect(attempt.campaign_id, `agent ${a.label} shown ${attempt.attempt_id}, seed ${seed}`).toBe(a.campaignId);
      }
    }
    expect(framesChecked, `seed ${seed}`).toBe(rows.length);

    console.info(`[tenant-isolation] seed=${seed} attempts=${rows.length} yCompletedAt=${yCompletedAt} rounds=${world.roundsRun}`);
  }, 600_000);
});

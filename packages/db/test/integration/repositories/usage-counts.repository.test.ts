import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getTestPool, closeTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAccount, insertTenant, insertWebrtcCall } from '../setup/factories.js';

/*
 * NEW (magick-agency, plan §3.3, no source): `usageCountsRepository` on the real
 * baseline. Pins every rule its docstring states — one half-open `[from, to)`
 * window on the ATTEMPT's `dialed_at` for every column, analysis seconds
 * attributed to the dial they analysed, tenant/account narrowing, an attempt
 * whose tenant/account row is gone still counted under its id — and that the
 * query is served by `idx_agency_attempts_billing (dialed_at, campaign_id)`.
 */

const captured: { text: string; values: unknown[] }[] = [];

vi.mock('../../../src/connection.js', () => ({
  getPool: () => ({
    query: (text: string, values: unknown[]) => {
      captured.push({ text, values });
      return getTestPool().query(text, values);
    },
  }),
}));

const { usageCountsRepository } = await import('../../../src/repositories/usage-counts.repository.js');

const FROM = new Date('2026-09-01T00:00:00.000Z');
const TO = new Date('2026-10-01T00:00:00.000Z');
const IN = new Date('2026-09-15T10:00:00.000Z');

async function campaign(tenantId: string, accountId: string) {
  const { rows } = await getTestPool().query(
    `INSERT INTO agency_campaigns (tenant_id, account_id, name, caller_ids)
     VALUES ($1, $2, 'C', ARRAY['+14155550100']) RETURNING id`,
    [tenantId, accountId],
  );
  return rows[0].id as string;
}

let phoneSeq = 0;

/** One attempt (its own contact) with optional call leg and analysis job. */
async function attempt(opts: {
  tenantId: string;
  accountId: string;
  campaignId: string;
  dialedAt: Date | null;
  answered?: boolean;
  bridged?: boolean;
  talkSeconds?: number | null;
  analysisSeconds?: number | null;
}) {
  const pool = getTestPool();
  const contact = await pool.query(
    `INSERT INTO agency_contacts (campaign_id, tenant_id, account_id, phone_e164)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [opts.campaignId, opts.tenantId, opts.accountId, `+1415555${String(1000 + phoneSeq++).padStart(4, '0')}`],
  );
  let callId: string | null = null;
  if (opts.analysisSeconds !== undefined) {
    const call = await insertWebrtcCall({
      tenant_id: opts.tenantId, account_id: opts.accountId, campaign_id: opts.campaignId,
    });
    callId = call.id;
    await pool.query(
      `INSERT INTO dialer_analysis_jobs (call_id, tenant_id, account_id, status, analysis_audio_seconds)
       VALUES ($1, $2, $3, 'completed', $4)`,
      [callId, opts.tenantId, opts.accountId, opts.analysisSeconds],
    );
  }
  await pool.query(
    `INSERT INTO agency_call_attempts
       (campaign_id, contact_id, tenant_id, account_id, attempt_number, caller_id, state,
        webrtc_call_id, dialed_at, answered_at, bridged_at, talk_seconds)
     VALUES ($1, $2, $3, $4, 1, '+14155550100', 'ended', $5, $6, $7, $8, $9)`,
    [
      opts.campaignId, contact.rows[0].id, opts.tenantId, opts.accountId, callId, opts.dialedAt,
      opts.answered ? opts.dialedAt : null,
      opts.bridged ? opts.dialedAt : null,
      opts.talkSeconds ?? null,
    ],
  );
}

async function workspace(name: string) {
  const tenant = await insertTenant({ name });
  const accountA = await insertAccount({ tenant_id: tenant.id, name: `${name} A` });
  const accountB = await insertAccount({ tenant_id: tenant.id, name: `${name} B` });
  return {
    tenant,
    accountA,
    accountB,
    campaignA: await campaign(tenant.id, accountA.id),
    campaignB: await campaign(tenant.id, accountB.id),
  };
}

describe('usageCountsRepository.countByAccount (integration)', () => {
  beforeEach(async () => {
    await truncateAll();
    captured.length = 0;
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('counts dials, answered, connected, talk and analysis seconds per (tenant, account), exactly', async () => {
    const w = await workspace('Alpha');
    const base = { tenantId: w.tenant.id, accountId: w.accountA.id, campaignId: w.campaignA };
    await attempt({ ...base, dialedAt: IN }); // no answer
    await attempt({ ...base, dialedAt: IN, answered: true, talkSeconds: 7 }); // abandoned: answered, never bridged
    await attempt({ ...base, dialedAt: IN, answered: true, bridged: true, talkSeconds: 120, analysisSeconds: 118 });
    await attempt({ ...base, dialedAt: IN, answered: true, bridged: true, talkSeconds: 30, analysisSeconds: null });
    await attempt({
      tenantId: w.tenant.id, accountId: w.accountB.id, campaignId: w.campaignB,
      dialedAt: IN, answered: true, bridged: true, talkSeconds: 45, analysisSeconds: 40,
    });

    const rows = await usageCountsRepository.countByAccount({ from: FROM, to: TO });

    expect(rows).toEqual([
      {
        tenant_id: w.tenant.id, tenant_name: 'Alpha', account_id: w.accountA.id, account_name: 'Alpha A',
        dials: 4, answered_calls: 3, connected_calls: 2, talk_seconds: 157, analysis_audio_seconds: 118,
      },
      {
        tenant_id: w.tenant.id, tenant_name: 'Alpha', account_id: w.accountB.id, account_name: 'Alpha B',
        dials: 1, answered_calls: 1, connected_calls: 1, talk_seconds: 45, analysis_audio_seconds: 40,
      },
    ]);
  });

  it('the window is half-open [from, to) on dialed_at; undialed attempts never count', async () => {
    const w = await workspace('Window');
    const base = { tenantId: w.tenant.id, accountId: w.accountA.id, campaignId: w.campaignA };
    await attempt({ ...base, dialedAt: FROM, talkSeconds: 1 }); // inclusive
    await attempt({ ...base, dialedAt: new Date(TO.getTime() - 1), talkSeconds: 2 });
    await attempt({ ...base, dialedAt: TO, talkSeconds: 100 }); // exclusive
    await attempt({ ...base, dialedAt: new Date(FROM.getTime() - 1), talkSeconds: 1000 });
    await attempt({ ...base, dialedAt: null, talkSeconds: 10_000 }); // queued, never dialed

    const rows = await usageCountsRepository.countByAccount({ from: FROM, to: TO });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ dials: 2, talk_seconds: 3 });
  });

  it('consecutive windows tile: the sum over two adjacent windows equals one window over both', async () => {
    const w = await workspace('Tile');
    const base = { tenantId: w.tenant.id, accountId: w.accountA.id, campaignId: w.campaignA };
    const MID = new Date('2026-09-16T00:00:00.000Z');
    for (const at of [FROM, IN, MID, new Date(TO.getTime() - 1)]) {
      await attempt({ ...base, dialedAt: at, answered: true, bridged: true, talkSeconds: 10, analysisSeconds: 9 });
    }

    const [first] = await usageCountsRepository.countByAccount({ from: FROM, to: MID });
    const [second] = await usageCountsRepository.countByAccount({ from: MID, to: TO });
    const [whole] = await usageCountsRepository.countByAccount({ from: FROM, to: TO });

    expect(first!.dials + second!.dials).toBe(whole!.dials);
    expect(first!.analysis_audio_seconds + second!.analysis_audio_seconds).toBe(whole!.analysis_audio_seconds);
    expect(whole).toMatchObject({ dials: 4, talk_seconds: 40, analysis_audio_seconds: 36 });
  });

  it('analysis seconds follow the dial they analysed, not the job: a job on an out-of-window dial is excluded', async () => {
    const w = await workspace('Attribution');
    const base = { tenantId: w.tenant.id, accountId: w.accountA.id, campaignId: w.campaignA };
    await attempt({ ...base, dialedAt: IN, answered: true, bridged: true, analysisSeconds: 50 });
    await attempt({ ...base, dialedAt: new Date('2026-08-31T23:00:00.000Z'), answered: true, bridged: true, analysisSeconds: 500 });

    const rows = await usageCountsRepository.countByAccount({ from: FROM, to: TO });

    expect(rows[0]).toMatchObject({ dials: 1, analysis_audio_seconds: 50 });
  });

  it('narrows to one tenant, and to one account within it', async () => {
    const a = await workspace('Aa');
    const b = await workspace('Bb');
    for (const w of [a, b]) {
      await attempt({ tenantId: w.tenant.id, accountId: w.accountA.id, campaignId: w.campaignA, dialedAt: IN });
      await attempt({ tenantId: w.tenant.id, accountId: w.accountB.id, campaignId: w.campaignB, dialedAt: IN });
    }

    const tenantRows = await usageCountsRepository.countByAccount({ from: FROM, to: TO, tenantId: b.tenant.id });
    expect(tenantRows.map((r) => r.tenant_id)).toEqual([b.tenant.id, b.tenant.id]);

    const accountRows = await usageCountsRepository.countByAccount({
      from: FROM, to: TO, tenantId: b.tenant.id, accountId: b.accountB.id,
    });
    expect(accountRows.map((r) => [r.tenant_id, r.account_id, r.dials])).toEqual([[b.tenant.id, b.accountB.id, 1]]);

    // A foreign tenant's account id under this tenant matches nothing.
    expect(await usageCountsRepository.countByAccount({
      from: FROM, to: TO, tenantId: b.tenant.id, accountId: a.accountA.id,
    })).toEqual([]);
  });

  it('an attempt whose tenant and account rows are gone is still counted, labelled by id', async () => {
    const w = await workspace('Ghost');
    await attempt({ tenantId: w.tenant.id, accountId: w.accountA.id, campaignId: w.campaignA, dialedAt: IN, talkSeconds: 5 });
    // agency_call_attempts has no FK to tenants/accounts: point it at ids with no row.
    const ghostTenant = randomUUID();
    const ghostAccount = randomUUID();
    await getTestPool().query(
      `UPDATE agency_call_attempts SET tenant_id = $1, account_id = $2`, [ghostTenant, ghostAccount],
    );

    const rows = await usageCountsRepository.countByAccount({ from: FROM, to: TO });

    expect(rows).toEqual([expect.objectContaining({
      tenant_id: ghostTenant, tenant_name: ghostTenant, account_id: ghostAccount, account_name: ghostAccount,
      dials: 1, talk_seconds: 5,
    })]);
  });

  it('is served by idx_agency_attempts_billing (dialed_at, campaign_id), with each parameter typed (no 42P08)', async () => {
    const w = await workspace('Plan');
    await attempt({ tenantId: w.tenant.id, accountId: w.accountA.id, campaignId: w.campaignA, dialedAt: IN });
    // Both filters bound (non-null $3/$4) and both null: the two shapes a caller sends.
    await usageCountsRepository.countByAccount({ from: FROM, to: TO, tenantId: w.tenant.id, accountId: w.accountA.id });
    await usageCountsRepository.countByAccount({ from: FROM, to: TO });
    expect(captured).toHaveLength(2);

    const client = await getTestPool().connect();
    try {
      await client.query('BEGIN');
      // A handful of rows would otherwise always be a sequential scan; this asks
      // whether the planner CAN use the index for this predicate, which is what
      // a production-sized table needs.
      await client.query('SET LOCAL enable_seqscan = off');
      for (const { text, values } of captured) {
        const plan = await client.query(`EXPLAIN ${text}`, values);
        const lines = plan.rows.map((r: Record<string, string>) => r['QUERY PLAN']).join('\n');
        expect(lines).toContain('idx_agency_attempts_billing');
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAccount, insertTenant } from '../setup/factories.js';

vi.mock('../../../src/connection.js', () => ({ getPool: () => getTestPool() }));

const { usageCountsRepository } = await import('../../../src/repositories/usage-counts.repository.js');

/*
 * `usageCountsRepository`'s `inbound_seconds` reads the carrier's own duration of a call
 * (`agency_inbound_calls.carrier_seconds`, 0029, from its hangup callback) when the call has one,
 * else answer to end on our side (SWE-F8): a call answered with a message the carrier speaks ends
 * here at the answer while the carrier speaks on and bills it. The rest of the inbound columns and
 * the plan are `usage-counts.repository.test.ts`'s.
 *
 * Mutation-checked: summing `ended_at - answered_at` alone (the query before 0029) counts the
 * spoken calls as 0 s (red).
 */

const FROM = new Date('2026-09-01T00:00:00.000Z');
const TO = new Date('2026-10-01T00:00:00.000Z');
const IN = new Date('2026-09-15T10:00:00.000Z');

/** An ended call that was answered `endAfter` seconds before it ended here, with the carrier's duration if given. */
async function answeredCall(tenantId: string, accountId: string, endAfter: number, carrierSeconds: number | null) {
  const id = randomUUID();
  await getTestPool().query(
    `INSERT INTO agency_inbound_calls
       (id, tenant_id, account_id, provider_call_id, to_e164, from_e164, state, outcome,
        arrived_at, answered_at, ended_at, follow_up_status, follow_up_reason, settled_at, carrier_seconds)
     VALUES ($1, $2, $3, $4, '+14155550100', '+14155550199', 'ended', 'closed',
             $5, $5, $6, 'open', 'closed', $6, $7)`,
    [id, tenantId, accountId, `CA-${id}`, IN, new Date(IN.getTime() + endAfter * 1000), carrierSeconds],
  );
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await truncateAll();
  await closeTestPool();
});

describe('inbound_seconds and the carrier`s duration (0029, SWE-F8)', () => {
  it('a call with the carrier`s duration counts it; one without counts answer to end; they add up per account', async () => {
    const tenant = await insertTenant({ name: 'Carrier seconds' });
    const account = await insertAccount({ tenant_id: tenant.id, name: 'A' });
    await answeredCall(tenant.id, account.id, 0, 9);      // spoken by the carrier: ended here at the answer, billed 9 s
    await answeredCall(tenant.id, account.id, 0.2, 7);    // the kill switch's closed words: 7 s at the carrier
    await answeredCall(tenant.id, account.id, 30, 31);    // streamed: the carrier's own count wins over ours
    await answeredCall(tenant.id, account.id, 12.4, null); // no hangup callback with a duration yet: ours
    const [row] = await usageCountsRepository.countByAccount({ from: FROM, to: TO });
    expect(row).toMatchObject({ account_id: account.id, inbound_calls: 4, inbound_answered_calls: 4, inbound_seconds: 9 + 7 + 31 + 12 });
  });

  it('the carrier`s duration of 0 is a duration (a call it never billed), not "unknown"', async () => {
    const tenant = await insertTenant({ name: 'Zero' });
    const account = await insertAccount({ tenant_id: tenant.id, name: 'A' });
    await answeredCall(tenant.id, account.id, 20, 0);
    const [row] = await usageCountsRepository.countByAccount({ from: FROM, to: TO });
    expect(row).toMatchObject({ inbound_calls: 1, inbound_seconds: 0 });
  });

  it('the column refuses a negative duration', async () => {
    const tenant = await insertTenant({ name: 'Negative' });
    const account = await insertAccount({ tenant_id: tenant.id, name: 'A' });
    await expect(answeredCall(tenant.id, account.id, 1, -1)).rejects.toThrow(/ck_agency_inbound_calls_carrier_seconds/);
  });
});

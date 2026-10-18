import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAgencyCampaign } from './agency-factories.js';
import { DEFAULTS } from '../setup/factories.js';

/**
 * `applyIngestChunk`'s `total_contacts` under two concurrent chunks for ONE campaign.
 *
 * The total is `UPDATE agency_campaigns SET contacts_total = (SELECT COUNT(*) …)`
 * inside the chunk's transaction. Under READ COMMITTED a second chunk B whose
 * UPDATE blocks on chunk A's row lock resumes after A commits with its OWN
 * statement snapshot for the COUNT, which does not hold A's rows: B answers (and
 * stores) a total that is short by A's chunk. The campaign row is locked first in
 * the chunk transaction, so B waits BEFORE any statement of its own and every
 * statement after the wait sees A's commit.
 *
 * The interleaving is forced, not hoped for: A is held open right after its
 * `UPDATE agency_campaigns` (so it holds the row lock), B is started, the test
 * waits until a backend is blocked on a lock (`pg_stat_activity`), then A commits.
 */

/** Holds the first chunk transaction to run the campaign total UPDATE until released. */
let hold: { reached: () => void; release: Promise<void> } | null = null;

function wrapClient(client: PoolClient): PoolClient {
  const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
  (client as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = async (
    ...args: unknown[]
  ) => {
    const result = await query(...args);
    const text = typeof args[0] === 'string' ? args[0] : '';
    if (hold && /UPDATE agency_campaigns\s+SET contacts_total/.test(text)) {
      const h = hold;
      hold = null;
      h.reached();
      await h.release;
    }
    return result;
  };
  return client;
}

const pool = {
  connect: async () => wrapClient(await getTestPool().connect()),
  query: (...args: Parameters<ReturnType<typeof getTestPool>['query']>) => getTestPool().query(...args),
};

vi.mock('@magick-agency/db', () => ({ getPool: () => pool }));
const { agencyContactRepository } = await import(
  '../../../src/db/repositories/agency.repository.js'
);

function contacts(prefix: string, n: number) {
  return Array.from({ length: n }, (_, i) => ({
    phone_e164: `${prefix}${String(i + 1).padStart(6, '0')}`,
    context: { name: `Person ${prefix}-${i + 1}` },
    source_row_number: i + 2,
  }));
}

function apply(campaignId: string, ingestJobId: string, rows: ReturnType<typeof contacts>) {
  return agencyContactRepository.applyIngestChunk({
    campaignId,
    tenantId: DEFAULTS.tenantId,
    accountId: DEFAULTS.accountId,
    ingestJobId,
    chunkIndex: 0,
    chunkCount: 1,
    idempotencyKey: `${ingestJobId}-0`,
    contacts: rows,
  });
}

async function waitForBlockedBackend(timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await getTestPool().query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'`,
    );
    if ((rows[0]?.n ?? 0) > 0) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for a blocked backend');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('applyIngestChunk total under concurrent chunks (integration)', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  it('the second of two concurrent chunks reports, and stores, the exact roster total', async () => {
    const campaign = await insertAgencyCampaign();
    // Two different ingest jobs (two operators topping up one campaign at once):
    // chunks within one job are sent sequentially, so this is the concurrent case.
    const jobA = '00000000-0000-4000-8000-00000000000a';
    const jobB = '00000000-0000-4000-8000-00000000000b';

    let reached!: () => void;
    const reachedA = new Promise<void>((resolve) => { reached = resolve; });
    let releaseA!: () => void;
    hold = { reached, release: new Promise<void>((resolve) => { releaseA = resolve; }) };

    const a = apply(campaign.id as string, jobA, contacts('+91811', 3));
    await reachedA;
    const b = apply(campaign.id as string, jobB, contacts('+91822', 2));
    await waitForBlockedBackend();
    releaseA();

    const [resA, resB] = await Promise.all([a, b]);
    expect(resA).toMatchObject({ accepted: 3, duplicate_chunk: false, total_contacts: 3 });
    expect(resB).toMatchObject({ accepted: 2, duplicate_chunk: false, total_contacts: 5 });

    const { rows } = await getTestPool().query<{ contacts_total: number; actual: number }>(
      `SELECT contacts_total,
              (SELECT COUNT(*)::int FROM agency_contacts WHERE campaign_id = $1) AS actual
         FROM agency_campaigns WHERE id = $1`,
      [campaign.id],
    );
    expect(rows[0]).toEqual({ contacts_total: 5, actual: 5 });
  });
});

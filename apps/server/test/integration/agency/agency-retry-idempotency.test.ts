import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import type { AgencyRetrySelector } from '@magick-agency/contracts/agency';
import { uuidFor } from '../setup/factories.js';

const { RETRY_INHERITED_CONFIG_KEYS } = await import(
  '@magick-agency/domain/retry-campaign-bounds'
);

vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));

const { agencyCampaignRepository } = await import(
  '../../../src/db/repositories/agency.repository.js'
);

/**
 * ─── AT-MOST-ONCE ON `POST /:id/retry`, AGAINST A REAL POSTGRES ─────────────
 *
 * The side effect this guards is **phone calls to real people**, and it cannot be
 * undone from the product: there is no campaign delete route in either service.
 * A request that commits server-side but whose response is lost — a proxy
 * timeout, a pod eviction, a reset connection — leaves the supervisor looking at
 * an error over a campaign that exists and is fully dialable. The natural next
 * act is to press the button again, and without migration 115 that produced a
 * SECOND complete retry over the same cohort. `uq_agency_campaign_running` does
 * not help: it bites at `/start`, for only one of the two, and only while the
 * other is actually running.
 *
 * Every case here is written against a real server rather than a mocked pool,
 * for the reason `agency-retry-seeding.test.ts`'s header sets out at length: the
 * guarantee lives in a PARTIAL UNIQUE INDEX and in Postgres's NULL semantics, and
 * a unit test asserting SQL text would pin the statement while proving nothing
 * about what the database does with it. Two of these cases — the concurrent race
 * and the unkeyed pair — have no expression at the SQL-text tier at all.
 */

const PARENT = '11111111-1111-1111-1111-111111111111';
const OTHER_TENANT_PARENT = '22222222-2222-2222-2222-222222222222';
/** Same tenant as {@link PARENT}, different account — the sibling-desk case. */
const OTHER_ACCOUNT_PARENT = '33333333-3333-3333-3333-333333333333';

/** A 36-character key, exactly what `crypto.randomUUID()` gives the console. */
const KEY = 'b3f1c0de-0000-4000-8000-000000000001';

const SELECTOR: AgencyRetrySelector = { last_outcome: ['no_answer', 'busy'] };

async function seedCampaign(id: string, tenant: string, account = uuidFor('a1')): Promise<void> {
  const pool = getTestPool();
  await pool.query(
    `INSERT INTO agency_campaigns (id, tenant_id, account_id, name, caller_ids)
     VALUES ($1,$2,$3,'Q3 Winback','{+911}')`,
    [id, tenant, account],
  );
  await pool.query(
    `INSERT INTO agency_contacts
       (campaign_id, tenant_id, account_id, phone_e164, attempt_count, last_outcome, state)
     VALUES
       ($1,$2,$3,'+919000000001',1,'no_answer','completed'),
       ($1,$2,$3,'+919000000002',2,'busy','exhausted')`,
    [id, tenant, account],
  );
}

async function inheritedConfig(parentId: string): Promise<Record<string, unknown>> {
  const parent = (await agencyCampaignRepository.findById(parentId))!;
  return Object.fromEntries(
    RETRY_INHERITED_CONFIG_KEYS.map((k) => [k, (parent as unknown as Record<string, unknown>)[k]]),
  );
}

async function retry(opts: {
  parentId?: string;
  name?: string;
  idempotencyKey: string | null;
}) {
  const parentId = opts.parentId ?? PARENT;
  return agencyCampaignRepository.retryFromCampaign({
    parent: (await agencyCampaignRepository.findById(parentId))!,
    selector: { ...SELECTOR },
    name: opts.name ?? 'Q3 Winback — Retry 1',
    config: (await inheritedConfig(parentId)) as never,
    createdBy: null,
    idempotencyKey: opts.idempotencyKey,
  });
}

async function campaignCount(): Promise<number> {
  const { rows } = await getTestPool().query<{ n: number }>(
    'SELECT count(*)::int AS n FROM agency_campaigns',
  );
  return rows[0]!.n;
}

async function contactCount(): Promise<number> {
  const { rows } = await getTestPool().query<{ n: number }>(
    'SELECT count(*)::int AS n FROM agency_contacts',
  );
  return rows[0]!.n;
}

beforeEach(async () => {
  await truncateAll();
  await seedCampaign(PARENT, uuidFor('t1'));
});

afterAll(async () => {
  await closeTestPool();
});

describe('a spent key replays instead of creating', () => {
  it('returns the ORIGINAL campaign and writes nothing at all', async () => {
    const first = await retry({ idempotencyKey: KEY });
    expect(first.status).toBe('created');
    if (first.status !== 'created') return;

    const campaigns = await campaignCount();
    const contacts = await contactCount();

    // The lost-response case, exactly: same key, same everything.
    const second = await retry({ idempotencyKey: KEY });
    expect(second.status).toBe('replayed');
    if (second.status !== 'replayed') return;
    // Not merely "a campaign" — THE campaign, so a console that lost its 201
    // lands on the one it already made rather than on a second cohort.
    expect(second.campaign.id).toBe(first.campaign.id);

    expect(await campaignCount()).toBe(campaigns);
    expect(await contactCount()).toBe(contacts);
  });

  it('replays even when the second request asks for something different', async () => {
    // A key identifies ONE INTENT. A client resending it with a changed name (a
    // re-render, a stale field) is still the same intent, and creating a second
    // campaign because one string differs would defeat the whole guarantee.
    const first = await retry({ idempotencyKey: KEY, name: 'Retry A' });
    const second = await retry({ idempotencyKey: KEY, name: 'Retry B' });

    expect(second.status).toBe('replayed');
    if (first.status !== 'created' || second.status !== 'replayed') return;
    expect(second.campaign.id).toBe(first.campaign.id);
    // The stored campaign keeps the FIRST request's name — the replay reports
    // what exists, it does not apply the second request's fields.
    expect(second.campaign.name).toBe('Retry A');
  });

  it('stamps the key on the row it created', async () => {
    const created = await retry({ idempotencyKey: KEY });
    if (created.status !== 'created') throw new Error('expected a create');
    const { rows } = await getTestPool().query<{ retry_idempotency_key: string | null }>(
      'SELECT retry_idempotency_key FROM agency_campaigns WHERE id = $1',
      [created.campaign.id],
    );
    expect(rows[0]!.retry_idempotency_key).toBe(KEY);
  });
});

describe('the race the fast path cannot close', () => {
  it('two concurrent requests carrying one key create exactly one campaign', async () => {
    // Both miss the pre-check, both reach the INSERT, the unique index lets one
    // through and answers the other 23505. This is the case the pre-check alone
    // gets wrong, and it has no expression at the SQL-text tier at all — it is
    // only observable against a real server holding a real index.
    const parent = (await agencyCampaignRepository.findById(PARENT))!;
    const config = (await inheritedConfig(PARENT)) as never;
    const before = await campaignCount();

    const [a, b] = await Promise.all([
      agencyCampaignRepository.retryFromCampaign({
        parent, config, selector: { ...SELECTOR }, name: 'A', createdBy: null, idempotencyKey: KEY,
      }),
      agencyCampaignRepository.retryFromCampaign({
        parent, config, selector: { ...SELECTOR }, name: 'B', createdBy: null, idempotencyKey: KEY,
      }),
    ]);

    // Exactly one of them created; both name the same campaign.
    expect([a.status, b.status].sort()).toEqual(['created', 'replayed']);
    if ((a.status !== 'created' && a.status !== 'replayed')
      || (b.status !== 'created' && b.status !== 'replayed')) {
      throw new Error('a refusal is not an outcome this case can produce');
    }
    expect(a.campaign.id).toBe(b.campaign.id);
    expect(await campaignCount()).toBe(before + 1);
    // And the loser rolled its whole transaction back — no orphaned roster.
    expect(await contactCount()).toBe(2 + 2);
  });
});

describe('what the key does NOT suppress', () => {
  it('two different keys are two intents and create two campaigns', async () => {
    // Two retries of one parent — the voicemails, then the no-answers — is an
    // ordinary supported thing to want, which is why the index is not on
    // `(parent_campaign_id, retry_generation)`.
    const first = await retry({ idempotencyKey: KEY });
    const second = await retry({ idempotencyKey: 'b3f1c0de-0000-4000-8000-000000000002' });

    expect(first.status).toBe('created');
    expect(second.status).toBe('created');
    if (first.status !== 'created' || second.status !== 'created') return;
    expect(second.campaign.id).not.toBe(first.campaign.id);
  });

  it('an UNKEYED create has no replay protection, and that is deliberate', async () => {
    // NULLs are distinct in a unique index, so two unkeyed creates are two
    // campaigns. Core's API answers a tenant API key directly, without
    // traversing master, and such a caller must still be able to create a retry
    // — this pins that the partial index is not read as "an unkeyed create is
    // refused", which would be a serious behaviour change.
    const first = await retry({ idempotencyKey: null });
    const second = await retry({ idempotencyKey: null });
    expect(first.status).toBe('created');
    expect(second.status).toBe('created');
    if (first.status !== 'created' || second.status !== 'created') return;
    expect(second.campaign.id).not.toBe(first.campaign.id);
  });

  it('one key in two ACCOUNTS of one tenant is two intents', async () => {
    // The index is `(tenant_id, account_id, retry_idempotency_key)`. Two accounts
    // under one tenant are two customers' desks, and every other agency resource
    // is scoped by both (`requireOwned`, `uq_agency_campaign_running`).
    //
    // Scoped by tenant alone, this test fails in the way that matters: account
    // a2's create comes back `replayed` carrying a1's campaign — its name,
    // caller IDs and frozen selector — and a2 can never make their own retry
    // with that key. UUIDs make an accidental collision unlikely; a shared
    // fixture, a 16-character client token or a copied key does not.
    await seedCampaign(OTHER_ACCOUNT_PARENT, uuidFor('t1'), uuidFor('a2'));
    // Distinct names so the disclosure half is visible: under a tenant-only
    // index `theirs` replays and comes back carrying a1's name.
    const mine = await retry({ idempotencyKey: KEY, name: 'a1 retry' });
    const theirs = await retry({
      parentId: OTHER_ACCOUNT_PARENT, idempotencyKey: KEY, name: 'a2 retry',
    });

    expect(mine.status).toBe('created');
    expect(theirs.status).toBe('created');
    if (mine.status !== 'created' || theirs.status !== 'created') return;
    expect(theirs.campaign.id).not.toBe(mine.campaign.id);
    expect(theirs.campaign.account_id).toBe(uuidFor('a2'));
    expect(theirs.campaign.name).toBe('a2 retry');
  });

  it('one key in two tenants is two intents', async () => {
    // The index is scoped `(tenant_id, key)`. A key another tenant happens to
    // have chosen is a different intent, and must not hand them a campaign from
    // a tenant they cannot even read.
    await seedCampaign(OTHER_TENANT_PARENT, uuidFor('t2'));
    const mine = await retry({ idempotencyKey: KEY });
    const theirs = await retry({ parentId: OTHER_TENANT_PARENT, idempotencyKey: KEY });

    expect(mine.status).toBe('created');
    expect(theirs.status).toBe('created');
    if (mine.status !== 'created' || theirs.status !== 'created') return;
    expect(theirs.campaign.id).not.toBe(mine.campaign.id);
    expect(theirs.campaign.tenant_id).toBe(uuidFor('t2'));
  });
});

describe('a refusal does not spend the key', () => {
  it('an empty selection leaves the key usable', async () => {
    // `empty` rolls back before the campaign INSERT, so the key was never
    // written. A supervisor who widens the selection and presses again must get
    // a campaign — a key burned by a refusal would answer `replayed` with a
    // campaign that does not exist, and the repository would have to invent one.
    const parent = (await agencyCampaignRepository.findById(PARENT))!;
    const config = (await inheritedConfig(PARENT)) as never;

    const refused = await agencyCampaignRepository.retryFromCampaign({
      parent, config, name: 'nope', createdBy: null, idempotencyKey: KEY,
      selector: { state: ['suppressed'] },
    });
    expect(refused.status).toBe('empty');

    const retried = await retry({ idempotencyKey: KEY });
    expect(retried.status).toBe('created');
  });
});

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
 * ─── RETRY SEEDING, AGAINST A REAL POSTGRES ─────────────────────────────────
 *
 * This file exists because the retry feature shipped **completely inoperative**
 * with a fully green suite, and the reason is structural rather than careless.
 *
 * `neverSeededSuppressionSql` emitted `suppressed_reason = ANY('{dnc,invalid}')`
 * and every caller uses it NEGATED. `suppressed_reason` is nullable and is NULL
 * for every contact that was never suppressed — nearly the whole retryable
 * roster — so `NOT (NULL = ANY(...))` is NULL, and `WHERE NULL` rejects the row.
 * Every ordinary retry previewed `matched: 0` and the create answered
 * `409 retry_selection_empty`, telling the supervisor to widen a selection that
 * was already as wide as it goes.
 *
 * The unit tier could not see it: `campaign-retry-repository.test.ts` mocks the
 * pool and asserts the SQL **text** (`toContain("NOT (c.suppressed_reason =
 * ANY('{dnc,invalid}'))")`), so it pinned the broken string. A predicate that
 * Postgres evaluates to NULL is textually indistinguishable from one that works.
 *
 * That is the same blind spot `agency-campaign-create.test.ts` was written for
 * (the 42804 `COALESCE` type bug that failed every campaign creation in 1.73.1),
 * one layer down: there the SQL would not PLAN, here it plans and returns the
 * wrong rows. **Assert on ROWS, never on SQL strings, for anything whose
 * meaning depends on NULL semantics, operator precedence or type inference.**
 *
 * The second defect this pins is the selector algebra. `DEFAULT_RETRY_SELECTOR`
 * was `{last_outcome: ['no_answer','busy'], never_attempted: true}`, and the
 * algebra ANDs across dimensions — but a contact with no attempts has a NULL
 * outcome, so those two conjuncts are mutually exclusive and the default matched
 * nothing on every campaign. "We did not reach them" is a UNION, and it is now
 * expressed inside ONE dimension via the `__none__` member.
 */

const PARENT = '11111111-1111-1111-1111-111111111111';

/** The roster shape every case below reasons about. */
async function seedParent(): Promise<void> {
  const pool = getTestPool();
  await pool.query(
    `INSERT INTO agency_campaigns (id, tenant_id, account_id, name, caller_ids)
     VALUES ($1,'${uuidFor('t1')}','${uuidFor('a1')}','Q3 Winback','{+911}')`,
    [PARENT],
  );
  await pool.query(
    `INSERT INTO agency_contacts
       (campaign_id, tenant_id, account_id, phone_e164, attempt_count, last_outcome, state, suppressed_reason)
     VALUES
       ($1,'${uuidFor('t1')}','${uuidFor('a1')}','+919000000001',1,'no_answer','completed',NULL),
       ($1,'${uuidFor('t1')}','${uuidFor('a1')}','+919000000002',2,'busy','exhausted','max_attempts'),
       ($1,'${uuidFor('t1')}','${uuidFor('a1')}','+919000000003',0,NULL,'pending',NULL),
       ($1,'${uuidFor('t1')}','${uuidFor('a1')}','+919000000004',1,'connected','suppressed','dnc'),
       ($1,'${uuidFor('t1')}','${uuidFor('a1')}','+919000000005',1,'invalid','suppressed','invalid')`,
    [PARENT],
  );
}


/**
 * The merged config the ROUTE hands the repository — parent's inherited columns
 * with overrides on top. Built from `RETRY_INHERITED_CONFIG_KEYS` rather than
 * hand-listed, so a column added to the inheritance set is exercised here for
 * free instead of quietly falling out of the fixture.
 */
async function inheritedConfig(): Promise<Record<string, unknown>> {
  const parent = (await agencyCampaignRepository.findById(PARENT))!;
  return Object.fromEntries(
    RETRY_INHERITED_CONFIG_KEYS.map((k) => [k, (parent as unknown as Record<string, unknown>)[k]]),
  );
}

async function childPhones(campaignId: string): Promise<string[]> {
  const { rows } = await getTestPool().query<{ phone_e164: string }>(
    'SELECT phone_e164 FROM agency_contacts WHERE campaign_id = $1 ORDER BY phone_e164',
    [campaignId],
  );
  return rows.map((r) => r.phone_e164);
}

beforeEach(async () => {
  await truncateAll();
  await seedParent();
});

afterAll(async () => {
  await closeTestPool();
});

describe('the compliance exclusion is NULL-safe', () => {
  it('seeds contacts whose suppressed_reason is NULL', async () => {
    // The whole bug in one assertion. Before the fix this was `[]` — a NULL
    // reason failed the negated predicate, so the ordinary roster was invisible.
    const preview = await agencyCampaignRepository.retryPreview(PARENT, {
      last_outcome: ['no_answer'],
    });
    expect(preview?.matched).toBe(1);
    expect(preview?.by_last_outcome['no_answer']).toBe(1);
  });

  it('still refuses dnc and invalid, and accounts for them', async () => {
    // Selecting every suppressed contact must NOT reach the two compliance
    // rows — the exclusion is unconditional, not a checkbox — and the supervisor must be
    // told where the missing rows went, or 0-of-2 reads as a bug.
    const preview = await agencyCampaignRepository.retryPreview(PARENT, {
      state: ['suppressed'],
    });
    expect(preview?.matched).toBe(0);
    expect(preview?.excluded).toEqual({ dnc: 1, invalid: 1 });
  });
});

describe('the default selection matches the cohort it names', () => {
  it('unions rang-out with never-dialled inside one dimension', async () => {
    // `DEFAULT_RETRY_SELECTOR`. Two dimensions ANDed gave the empty set; one
    // dimension with `__none__` gives the three contacts nobody reached.
    const preview = await agencyCampaignRepository.retryPreview(PARENT, {
      last_outcome: ['no_answer', 'busy', '__none__'],
    });
    expect(preview?.matched).toBe(3);
    // A NULL outcome buckets under the same key it is selected by.
    expect(preview?.by_last_outcome['__none__']).toBe(1);
  });

  it('the OLD default is the empty set, and that is why it changed', async () => {
    // Kept as a regression: anyone reinstating `never_attempted` ALONGSIDE
    // `last_outcome` reintroduces a dead button, and this says so out loud.
    const preview = await agencyCampaignRepository.retryPreview(PARENT, {
      last_outcome: ['no_answer', 'busy'],
      never_attempted: true,
    });
    expect(preview?.matched).toBe(0);
  });
});

describe('a contact that is on a call right now is never seeded', () => {
  /**
   * The row `claimDialable` leaves behind mid-attempt: state flipped, nothing
   * else written yet. `chargeAttempt` writes `last_outcome` and bumps
   * `attempt_count` only at SETTLE, so a first dial that is ringing at this
   * instant is `in_flight` / NULL outcome / 0 attempts — which satisfies BOTH
   * `__none__` and `never_attempted: true`.
   *
   * Inserted per-case rather than into `seedParent`, so the counts every other
   * case in this file reasons about stay as written.
   */
  async function addRinging(): Promise<void> {
    await getTestPool().query(
      `INSERT INTO agency_contacts
         (campaign_id, tenant_id, account_id, phone_e164, attempt_count, last_outcome, state)
       VALUES ($1,'${uuidFor('t1')}','${uuidFor('a1')}','+919000000009',0,NULL,'in_flight')`,
      [PARENT],
    );
  }

  it('the default selector does not match it, though every field says it should', async () => {
    // The workflow that reaches this: "this campaign is going badly — pause it
    // and retry everyone we did not reach". Pause does not cancel attempts
    // already in flight, and `uq_agency_campaign_running` does not bite because
    // a paused parent is not running. Seeding this row and starting the child
    // dials a number the parent has an OPEN CALL on.
    await addRinging();
    const preview = await agencyCampaignRepository.retryPreview(PARENT, {
      last_outcome: ['no_answer', 'busy', '__none__'],
    });
    // 3, not 4 — the same three contacts as with no ringing row at all.
    expect(preview?.matched).toBe(3);
    expect(preview?.by_last_outcome['__none__']).toBe(1);
  });

  it('never_attempted does not reach it either', async () => {
    // The second spelling of the same intent, and it names no state, so the
    // parse-time refusal of `state: ['in_flight']` cannot cover it. Only the
    // unconditional predicate does.
    await addRinging();
    const preview = await agencyCampaignRepository.retryPreview(PARENT, {
      never_attempted: true,
    });
    // Only `+919000000003`, the genuinely untouched pending row.
    expect(preview?.matched).toBe(1);
  });

  it('the commit agrees with the preview, so it is not seeded either', async () => {
    await addRinging();
    const result = await agencyCampaignRepository.retryFromCampaign({
      parent: (await agencyCampaignRepository.findById(PARENT))!,
      selector: { last_outcome: ['no_answer', 'busy', '__none__'] },
      name: 'Retry 1',
      config: (await inheritedConfig()) as never,
      createdBy: null,
      idempotencyKey: null,
    });
    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
    expect(await childPhones(result.campaign.id)).not.toContain('+919000000009');
    expect(result.contacts_seeded).toBe(3);
  });

  /**
   * A live bridged attempt plus the contact row the `bridged` handler leaves
   * behind when a disposition is owed. `last_outcome` / `attempt_count` still
   * land at SETTLE, so a first attempt is `connected` / NULL / 0 — the same
   * `__none__` match as ringing. The live-attempt EXISTS is what excludes it;
   * a contact-only fixture would not exercise that discriminator.
   */
  async function addLiveConnected(): Promise<void> {
    await getTestPool().query(
      `WITH contact AS (
         INSERT INTO agency_contacts
           (campaign_id, tenant_id, account_id, phone_e164, attempt_count, last_outcome, state)
         VALUES ($1,'${uuidFor('t1')}','${uuidFor('a1')}','+919000000010',0,NULL,'connected')
         RETURNING id
       )
       INSERT INTO agency_call_attempts
         (campaign_id, contact_id, tenant_id, account_id, attempt_number, caller_id, state)
       SELECT $1, id, '${uuidFor('t1')}', '${uuidFor('a1')}', 1, '+911', 'bridged' FROM contact`,
      [PARENT],
    );
  }

  it('a mid-call connected contact is excluded the same way as ringing', async () => {
    // Disposition-catalog campaign, agent still talking, supervisor pauses and
    // retries "everyone we did not reach". Pause does not hang up a bridged
    // call. Seeding this row and starting the child dials a number the parent
    // has an OPEN CONVERSATION on. `uq_agency_attempt_live` cannot catch it:
    // A retry copies the contact, so the child's attempt is a different contact_id.
    await addLiveConnected();
    const preview = await agencyCampaignRepository.retryPreview(PARENT, {
      last_outcome: ['no_answer', 'busy', '__none__'],
    });
    expect(preview?.matched).toBe(3);
    expect(preview?.by_last_outcome['__none__']).toBe(1);
  });

  it('never_attempted does not reach a mid-call connected contact either', async () => {
    await addLiveConnected();
    const preview = await agencyCampaignRepository.retryPreview(PARENT, {
      never_attempted: true,
    });
    expect(preview?.matched).toBe(1);
  });

  it('the commit does not seed a mid-call connected contact', async () => {
    await addLiveConnected();
    const result = await agencyCampaignRepository.retryFromCampaign({
      parent: (await agencyCampaignRepository.findById(PARENT))!,
      selector: { last_outcome: ['no_answer', 'busy', '__none__'] },
      name: 'Retry live-connected',
      config: (await inheritedConfig()) as never,
      createdBy: null,
      idempotencyKey: null,
    });
    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
    expect(await childPhones(result.campaign.id)).not.toContain('+919000000010');
    expect(result.contacts_seeded).toBe(3);
  });

  it('post-settle wrap-up (connected + ended attempt) remains selectable', async () => {
    // The discriminator is the ended attempt, not last_outcome: wrap-up after
    // hangup writes both. That cohort is why `connected` stays in
    // RETRY_SELECTABLE_STATES — excluding the state wholesale would hide it.
    await getTestPool().query(
      `WITH contact AS (
         INSERT INTO agency_contacts
           (campaign_id, tenant_id, account_id, phone_e164, attempt_count, last_outcome, state)
         VALUES ($1,'${uuidFor('t1')}','${uuidFor('a1')}','+919000000011',1,'connected','connected')
         RETURNING id
       )
       INSERT INTO agency_call_attempts
         (campaign_id, contact_id, tenant_id, account_id, attempt_number, caller_id, state, outcome)
       SELECT $1, id, '${uuidFor('t1')}', '${uuidFor('a1')}', 1, '+911', 'ended', 'connected' FROM contact`,
      [PARENT],
    );
    const preview = await agencyCampaignRepository.retryPreview(PARENT, {
      last_outcome: ['connected'],
    });
    expect(preview?.matched).toBe(1);
    expect(preview?.by_last_outcome['connected']).toBe(1);
  });

  /**
   * After a retryable failure, `chargeAttempt` keeps `last_outcome` and
   * `claimDialable` flips only `state`. A bridged second attempt is therefore
   * `connected` / `no_answer` / attempt_count = 1 — which the default selector
   * names, and which a `last_outcome IS NULL` conjunct cannot see.
   */
  async function addRepeatLiveConnected(): Promise<void> {
    await getTestPool().query(
      `WITH contact AS (
         INSERT INTO agency_contacts
           (campaign_id, tenant_id, account_id, phone_e164, attempt_count, last_outcome, state)
         VALUES ($1,'${uuidFor('t1')}','${uuidFor('a1')}','+919000000012',1,'no_answer','connected')
         RETURNING id
       )
       INSERT INTO agency_call_attempts
         (campaign_id, contact_id, tenant_id, account_id, attempt_number, caller_id, state)
       SELECT $1, id, '${uuidFor('t1')}', '${uuidFor('a1')}', 2, '+911', 'bridged' FROM contact`,
      [PARENT],
    );
  }

  it('a mid-call connected contact on a later attempt is excluded too', async () => {
    await addRepeatLiveConnected();
    const preview = await agencyCampaignRepository.retryPreview(PARENT, {
      last_outcome: ['no_answer', 'busy', '__none__'],
    });
    // Still the original three (no_answer / busy / pending) — not the live
    // second attempt whose leftover last_outcome is no_answer.
    expect(preview?.matched).toBe(3);
    expect(preview?.by_last_outcome['no_answer']).toBe(1);
  });

  it('the commit does not seed a later-attempt live connected contact', async () => {
    await addRepeatLiveConnected();
    const result = await agencyCampaignRepository.retryFromCampaign({
      parent: (await agencyCampaignRepository.findById(PARENT))!,
      selector: { last_outcome: ['no_answer', 'busy', '__none__'] },
      name: 'Retry live-connected-repeat',
      config: (await inheritedConfig()) as never,
      createdBy: null,
      idempotencyKey: null,
    });
    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
    expect(await childPhones(result.campaign.id)).not.toContain('+919000000012');
    expect(result.contacts_seeded).toBe(3);
  });
});

describe('matched counts what the INSERT will write, not what the selector touched', () => {
  /**
   * Two BYTE-IDENTICAL roster rows — same phone, same (absent) context, same
   * timezone. Legal: `uq_agency_contacts_row_fingerprint` is per-campaign, and
   * two CSV uploads into one campaign produce exactly this.
   *
   * The seeding INSERT collapses them (`ON CONFLICT (campaign_id,
   * row_fingerprint) DO NOTHING`). A `COUNT(*)` preview would promise two.
   */
  async function addTwin(): Promise<void> {
    await getTestPool().query(
      `INSERT INTO agency_contacts
         (campaign_id, tenant_id, account_id, phone_e164, attempt_count, last_outcome, state)
       VALUES ($1,'${uuidFor('t1')}','${uuidFor('a1')}','+919000000001',1,'no_answer','completed')`,
      [PARENT],
    );
  }

  it('the preview promises the deduped number', async () => {
    await addTwin();
    const preview = await agencyCampaignRepository.retryPreview(PARENT, {
      last_outcome: ['no_answer'],
    });
    // 1, not 2. `matched` is documented as a promise about the commit, and the
    // commit will write one row.
    expect(preview?.matched).toBe(1);
    // The buckets still sum to it — the property that makes the breakdown
    // readable. Deduping by `COUNT(DISTINCT …)` instead of `DISTINCT ON` would
    // leave this at 2 while `matched` said 1.
    expect(preview?.by_last_outcome['no_answer']).toBe(1);
  });

  it('the cap decides on the roster that will exist', async () => {
    // The consequence the reviewer named: a parent whose matching rows exceed
    // `RETRY_MAX_SEED_ROWS` only because they are duplicates would 409
    // `retry_selection_too_large` on a retry that fits comfortably. Asserted
    // here at the scale the fixture allows — the number is the same decision.
    await addTwin();
    const result = await agencyCampaignRepository.retryFromCampaign({
      parent: (await agencyCampaignRepository.findById(PARENT))!,
      selector: { last_outcome: ['no_answer'] },
      name: 'Retry 1',
      config: (await inheritedConfig()) as never,
      createdBy: null,
      idempotencyKey: null,
    });
    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
    expect(result.contacts_seeded).toBe(1);
    // Still reported, because the parent DID hold two matching rows and a
    // supervisor comparing against the contacts list needs the difference named.
    expect(result.duplicates_collapsed).toBe(1);
  });
});

describe('the commit delivers exactly what the preview promised', () => {
  it('seeds the previewed rows, reset, with lineage stamped', async () => {
    const selector: AgencyRetrySelector = { last_outcome: ['no_answer', 'busy', '__none__'] };
    const preview = await agencyCampaignRepository.retryPreview(PARENT, { ...selector });
    const result = await agencyCampaignRepository.retryFromCampaign({
      parent: (await agencyCampaignRepository.findById(PARENT))!,
      selector: { ...selector },
      name: 'Q3 Winback — Retry 1',
      config: (await inheritedConfig()) as never,
      createdBy: null,
      idempotencyKey: null,
    });

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;

    // The preview is a promise about the commit; a divergence here is the class
    // of defect the shared predicate builder exists to prevent.
    expect(result.contacts_seeded).toBe(preview?.matched);
    expect(await childPhones(result.campaign.id)).toEqual([
      '+919000000001', '+919000000002', '+919000000003',
    ]);

    const { rows } = await getTestPool().query<{
      attempt_count: number; our_fault_attempts: number; state: string;
      root_contact_id: string | null; source_contact_id: string | null;
    }>(
      `SELECT attempt_count, our_fault_attempts, state, root_contact_id, source_contact_id
         FROM agency_contacts WHERE campaign_id = $1`,
      [result.campaign.id],
    );

    for (const row of rows) {
      // A retry is a fresh allowance, so the counters reset.
      expect(row.attempt_count).toBe(0);
      expect(row.our_fault_attempts).toBe(0);
      expect(row.state).toBe('pending');
      // Lineage points back, and the root is the PARENT's row — not this
      // one — which is what makes the agent's prior-attempt read work.
      expect(row.source_contact_id).not.toBeNull();
      expect(row.root_contact_id).toBe(row.source_contact_id);
    }

    // The child is startable-but-not-started, and carries its provenance.
    expect(result.campaign.status).toBe('draft');
    expect(result.campaign.parent_campaign_id).toBe(PARENT);
    expect(result.campaign.retry_generation).toBe(1);
  });

  it('creates nothing at all when the selector matches nobody', async () => {
    const before = await getTestPool().query('SELECT count(*)::int AS n FROM agency_campaigns');
    const result = await agencyCampaignRepository.retryFromCampaign({
      parent: (await agencyCampaignRepository.findById(PARENT))!,
      selector: { state: ['suppressed'] },
      name: 'nope',
      config: (await inheritedConfig()) as never,
      createdBy: null,
      idempotencyKey: null,
    });
    expect(result.status).toBe('empty');
    // Not merely "no contacts" — no campaign row either. There is no delete
    // route in either service, so a draft nobody can start is unrecoverable.
    const after = await getTestPool().query('SELECT count(*)::int AS n FROM agency_campaigns');
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

describe('the commit reports what it actually did', () => {
  it('counts DUPLICATE roster rows as matched, then collapses them, and says so', async () => {
    /**
     * The one way `contacts_seeded` may legitimately come in UNDER the preview's
     * `matched`, and the reason it is reported rather than left to be noticed.
     *
     * The seed's `ON CONFLICT (campaign_id, row_fingerprint) DO NOTHING` exists
     * because a parent may hold two byte-identical roster rows — the fingerprint
     * index is per-campaign, so a CSV containing one number twice is legal — and
     * the child collapses them to one.
     *
     * `matched` counts DISTINCT FINGERPRINTS, so the preview and the cap already
     * agree with the seed. `duplicates_collapsed` is the separate fact: the
     * parent held two matching ROWS. A supervisor comparing the new roster
     * against the parent's contacts list sees a shorter number and needs it
     * named, or a legal collapse is indistinguishable from rows lost to a bug —
     * and the difference decides whether they carry on or escalate.
     *
     * Both numbers come from ONE snapshot (the transaction is REPEATABLE READ),
     * so this is a real count and never a race between two reads.
     */
    const pool = getTestPool();
    // A second row identical to '+919000000001' in every fingerprinted column.
    await pool.query(
      `INSERT INTO agency_contacts
         (campaign_id, tenant_id, account_id, phone_e164, attempt_count, last_outcome, state)
       VALUES ($1,'${uuidFor('t1')}','${uuidFor('a1')}','+919000000001',1,'no_answer','completed')`,
      [PARENT],
    );

    const selector: AgencyRetrySelector = { last_outcome: ['no_answer'] };
    const preview = await agencyCampaignRepository.retryPreview(PARENT, { ...selector });
    // 1, not 2. `matched` is a PROMISE about the commit, and the commit writes
    // one row — so the preview must not show the pre-collapse count and then
    // hand over a shorter roster. The raw row count survives only as
    // `duplicates_collapsed` on the create, asserted below.
    expect(preview?.matched).toBe(1);

    const result = await agencyCampaignRepository.retryFromCampaign({
      parent: (await agencyCampaignRepository.findById(PARENT))!,
      selector: { ...selector },
      name: 'Q3 Winback — Retry 1',
      config: (await inheritedConfig()) as never,
      createdBy: null,
      idempotencyKey: null,
    });

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
    expect(result.contacts_seeded).toBe(1);
    expect(result.duplicates_collapsed).toBe(1);
    expect(await childPhones(result.campaign.id)).toEqual(['+919000000001']);
  });

  it('reports NO collapse on an ordinary roster, so the field is not noise', async () => {
    // The mirror. A `duplicates_collapsed` that were always positive — an
    // off-by-one, a count taken before the exclusion — would put an unexplained
    // caveat on every successful retry in the product.
    const result = await agencyCampaignRepository.retryFromCampaign({
      parent: (await agencyCampaignRepository.findById(PARENT))!,
      selector: { last_outcome: ['no_answer', 'busy', '__none__'] },
      name: 'Q3 Winback — Retry 1',
      config: (await inheritedConfig()) as never,
      createdBy: null,
      idempotencyKey: null,
    });
    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
    expect(result.duplicates_collapsed).toBe(0);
    expect(result.contacts_seeded).toBe(3);
  });
});

describe('migration 112/113 lineage columns, as applied', () => {
  it('stamps root_contact_id on an ordinary ingest row', async () => {
    // The BEFORE INSERT trigger, exercised rather than read. A NULL here would
    // reach `WHERE root_contact_id = $1` in the dial path and match nothing,
    // silently emptying the agent's history panel.
    const { rows } = await getTestPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM agency_contacts
        WHERE campaign_id = $1 AND root_contact_id = id`,
      [PARENT],
    );
    expect(rows[0]!.n).toBe(5);
  });

  it('113 is a no-op on a second run, so updated_at is not restamped', async () => {
    // `migrate:up` runs on every container start and `agency_contacts` carries a
    // BEFORE UPDATE trigger; a non-idempotent backfill would report every
    // contact on the platform as freshly modified after each deploy.
    //
    // `rowCount`, NOT `rows.length`: `pg` returns `rows: []` for an UPDATE
    // without RETURNING however many rows it changed, so the obvious-looking
    // `rows.length === 0` passes even when the backfill restamps the whole
    // table — an assertion that cannot fail is worse than none, because it
    // reads as coverage. `rowCount` is the number actually touched.
    const result = await getTestPool().query(
      "UPDATE agency_contacts SET root_contact_id = id WHERE root_contact_id IS NULL",
    );
    expect(result.rowCount).toBe(0);
  });
});

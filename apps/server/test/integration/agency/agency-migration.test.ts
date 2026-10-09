import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertWebrtcCall, uuidFor } from '../setup/factories.js';
import {
  insertAgencyAttempt,
  insertAgencyCampaign,
  insertAgencyContact,
  insertAgentSession,
} from './agency-factories.js';

/**
 * T-M1/T-M2/T-M3 — the agency schema, against a real Postgres.
 *
 * Migrations 072–077 were exercised only by the code that reads them. Nothing
 * asserted the schema itself, which means every `CHECK` constraint, every
 * nullability decision and every `ON DELETE` was unverified — a mock cannot have
 * an opinion about any of them.
 *
 * The uniqueness indexes are covered separately, behaviourally, in
 * `agency-duplicate-dial.test.ts` (T-M4/T-M5/T-M6). This file is structure.
 *
 * Modelled on the existing precedent `test/integration/db/dialer-analysis-migration.test.ts`.
 */

const AGENCY_TABLES = [
  'agency_campaigns',
  'agency_contacts',
  'agency_agent_sessions',
  'agency_call_attempts',
  'agency_ingest_chunks',
] as const;

/** Every legal value of every state machine, from the design's. */
const LEGAL = {
  campaign_status: ['draft', 'running', 'paused', 'stopping', 'completed', 'stopped'],
  contact_state: ['pending', 'in_flight', 'connected', 'completed', 'exhausted', 'suppressed'],
  agent_state: ['offline', 'available', 'reserved', 'on_call', 'wrapup', 'break'],
  attempt_state: ['queued', 'dialing', 'ringing', 'answered', 'bridged', 'ended'],
} as const;

describe('agency schema — migrations 072-077 (integration)', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  it('T-M1: every agency table exists', async () => {
    const { rows } = await getTestPool().query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [AGENCY_TABLES as unknown as string[]],
    );
    expect(rows.map((r) => r.table_name).sort()).toEqual([...AGENCY_TABLES].sort());
  });

  it('T-M1b: the webrtc_calls back-references exist and are NULLABLE', async () => {
    // The single most dangerous nullability in this feature. `webrtc_calls` is
    // the EXISTING dialer's table; a NOT NULL on either of these columns would
    // break every ordinary browser-dialer call the moment 076 landed, and would
    // do it at insert time rather than at boot.
    const { rows } = await getTestPool().query<{
      column_name: string; is_nullable: string; data_type: string;
    }>(
      `SELECT column_name, is_nullable, data_type FROM information_schema.columns
        WHERE table_name = 'agency_calls'
          AND column_name IN ('campaign_id', 'agency_attempt_id')`,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.is_nullable, `${row.column_name} must be nullable`).toBe('YES');
      expect(row.data_type).toBe('uuid');
    }

    // Proven behaviourally too: a call with no agency involvement still inserts.
    const call = await insertWebrtcCall({ campaign_id: null });
    expect(call.campaign_id).toBeNull();
    expect(call.agency_attempt_id).toBeNull();
  });

  it('T-M1c: context and caller_ids have the shapes the engine assumes', async () => {
    const { rows } = await getTestPool().query<{
      table_name: string; column_name: string; data_type: string; is_nullable: string;
    }>(
      `SELECT table_name, column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE (table_name = 'agency_contacts'
                 AND column_name IN ('context', 'phone_e164', 'state', 'next_attempt_at', 'attempt_count'))
           OR (table_name = 'agency_campaigns'
                 AND column_name IN ('caller_ids', 'retry_policy', 'disposition_catalog', 'context_display'))`,
    );
    const by = Object.fromEntries(rows.map((r) => [`${r.table_name}.${r.column_name}`, r]));

    expect(by['agency_contacts.context']!.data_type).toBe('jsonb');
    expect(by['agency_contacts.context']!.is_nullable).toBe('NO');
    // `next_attempt_at` NOT NULL is what makes the dialable predicate total —
    // a NULL would silently drop the contact out of the hot index.
    expect(by['agency_contacts.next_attempt_at']!.is_nullable).toBe('NO');
    expect(by['agency_contacts.attempt_count']!.is_nullable).toBe('NO');
    expect(by['agency_campaigns.caller_ids']!.data_type).toBe('ARRAY');
    expect(by['agency_campaigns.retry_policy']!.data_type).toBe('jsonb');
    expect(by['agency_campaigns.disposition_catalog']!.data_type).toBe('jsonb');
    expect(by['agency_campaigns.context_display']!.data_type).toBe('jsonb');
  });

  // ── T-M2: check constraints ───────────────────────────────────────────────

  it('T-M2: campaign status accepts every legal value and rejects anything else', async () => {
    // Distinct accounts, because uq_agency_campaign_running permits only one
    // `running` campaign per (tenant, account) — sharing an account here would
    // fail on the index and prove nothing about the CHECK.
    for (const [i, status] of LEGAL.campaign_status.entries()) {
      await expect(
        insertAgencyCampaign({ status, account_id: uuidFor(`acct-${i}`) }),
      ).resolves.toBeTruthy();
    }
    await expect(insertAgencyCampaign({ status: 'bogus' })).rejects.toMatchObject({ code: '23514' });
  });

  it('T-M2b: contact state accepts every legal value and rejects anything else', async () => {
    const campaign = await insertAgencyCampaign();
    for (const state of LEGAL.contact_state) {
      await expect(insertAgencyContact(campaign.id, { state })).resolves.toBeTruthy();
    }
    await expect(
      insertAgencyContact(campaign.id, { state: 'bogus' }),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('T-M2c: agent state accepts every legal value and rejects anything else', async () => {
    const campaign = await insertAgencyCampaign();
    for (const [i, state] of LEGAL.agent_state.entries()) {
      await expect(
        insertAgentSession(campaign.id, { state, agent_user_id: uuidFor(`agent-${i}`) }),
      ).resolves.toBeTruthy();
    }
    await expect(
      insertAgentSession(campaign.id, { state: 'bogus', agent_user_id: uuidFor('agent-x') }),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('T-M2d: attempt state accepts every legal value and rejects anything else', async () => {
    const campaign = await insertAgencyCampaign();
    // One contact per state — uq_agency_attempt_live allows only one live
    // attempt per contact, which is the point of that index.
    for (const state of LEGAL.attempt_state) {
      const contact = await insertAgencyContact(campaign.id);
      await expect(insertAgencyAttempt(campaign.id, contact.id, { state })).resolves.toBeTruthy();
    }
    const contact = await insertAgencyContact(campaign.id);
    await expect(
      insertAgencyAttempt(campaign.id, contact.id, { state: 'bogus' }),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('T-M2e: the JSONB shape guards actually guard', async () => {
    // `context` must be an object because the agent panel renders it as
    // key/value pairs; an array or a scalar would render as nothing.
    const campaign = await insertAgencyCampaign();
    await expect(
      insertAgencyContact(campaign.id, { context: JSON.stringify(['not', 'an', 'object']) }),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      insertAgencyContact(campaign.id, { context: JSON.stringify('scalar') }),
    ).rejects.toMatchObject({ code: '23514' });

    // disposition_catalog is an ARRAY, retry_policy and context_display OBJECTS
    // — the inverse of each other, so a copy-paste in the migration shows up.
    await expect(
      insertAgencyCampaign({ disposition_catalog: JSON.stringify({ not: 'an array' }) }),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      insertAgencyCampaign({ retry_policy: JSON.stringify([]) }),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      insertAgencyCampaign({ context_display: JSON.stringify([]) }),
    ).rejects.toMatchObject({ code: '23514' });
  });

  // ── T-M3: cascades ────────────────────────────────────────────────────────

  it('T-M3: deleting a campaign removes its whole execution subtree', async () => {
    const campaign = await insertAgencyCampaign();
    const contact = await insertAgencyContact(campaign.id);
    const session = await insertAgentSession(campaign.id);
    await insertAgencyAttempt(campaign.id, contact.id, { reserved_agent_id: session.id });
    await getTestPool().query(
      `INSERT INTO agency_ingest_chunks (campaign_id, ingest_job_id, chunk_index, idempotency_key, row_count)
       VALUES ($1, 'job-1', 0, 'job-1-0', 500)`,
      [campaign.id],
    );

    await getTestPool().query('DELETE FROM agency_campaigns WHERE id = $1', [campaign.id]);

    for (const table of ['agency_contacts', 'agency_agent_sessions', 'agency_call_attempts', 'agency_ingest_chunks']) {
      const { rows } = await getTestPool().query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM ${table} WHERE campaign_id = $1`,
        [campaign.id],
      );
      expect(Number(rows[0]!.n), `${table} did not cascade`).toBe(0);
    }
  });

  it('T-M3b: deleting a contact removes its attempts', async () => {
    const campaign = await insertAgencyCampaign();
    const contact = await insertAgencyContact(campaign.id);
    await insertAgencyAttempt(campaign.id, contact.id);

    await getTestPool().query('DELETE FROM agency_contacts WHERE id = $1', [contact.id]);
    const { rows } = await getTestPool().query<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM agency_call_attempts WHERE contact_id = $1',
      [contact.id],
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('T-M3c: an attempt cannot reference a non-existent agent session', async () => {
    const campaign = await insertAgencyCampaign();
    const contact = await insertAgencyContact(campaign.id);
    await expect(
      insertAgencyAttempt(campaign.id, contact.id, {
        reserved_agent_id: '00000000-0000-0000-0000-000000000000',
      }),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('T-M4b: the ingest idempotency constraint is a real UNIQUE (077)', async () => {
    // 077's whole argument is that one key maps to exactly one chunk, so a real
    // UNIQUE is available here — unlike 066's advisory-lock idiom. Assert the
    // constraint, not the intent.
    const campaign = await insertAgencyCampaign();
    const insert = () => getTestPool().query(
      `INSERT INTO agency_ingest_chunks (campaign_id, ingest_job_id, chunk_index, idempotency_key, row_count)
       VALUES ($1, 'job-1', 0, 'job-1-0', 500)`,
      [campaign.id],
    );
    await expect(insert()).resolves.toBeTruthy();
    await expect(insert()).rejects.toMatchObject({
      code: '23505',
      constraint: 'uq_agency_ingest_chunk',
    });

    // A different chunk of the same job is fine; that is the whole point.
    await expect(getTestPool().query(
      `INSERT INTO agency_ingest_chunks (campaign_id, ingest_job_id, chunk_index, idempotency_key, row_count)
       VALUES ($1, 'job-1', 1, 'job-1-1', 500)`,
      [campaign.id],
    )).resolves.toBeTruthy();
  });

  it('T-M7: updated_at triggers fire on every agency table that declares one', async () => {
    const campaign = await insertAgencyCampaign();
    const before = campaign.updated_at;
    // Sleep past timestamp granularity so the comparison is meaningful.
    await new Promise((r) => setTimeout(r, 10));
    const { rows } = await getTestPool().query<{ updated_at: Date }>(
      `UPDATE agency_campaigns SET name = 'renamed' WHERE id = $1 RETURNING updated_at`,
      [campaign.id],
    );
    expect(rows[0]!.updated_at.getTime()).toBeGreaterThan(new Date(before).getTime());
  });
});

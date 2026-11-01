// Real Postgres: migrations/0006_agent_session_client_kind.sql. globalSetup has applied every
// migration. The CHECK vocabulary is pinned to the contract's runtime list
// (`AGENCY_CLIENT_KINDS`), so a client kind added to the union without a migration fails here
// rather than as a refused station attach in production.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AGENCY_CLIENT_KINDS } from '@magick-agency/contracts/agency';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertCampaign, insertSession, insertSoftphoneSession } from '../fixtures.js';

const pool = () => getTestPool();

beforeEach(truncateAll);
// 0005's Down refuses while a soft-phone session exists; leave none behind.
afterAll(async () => {
  await truncateAll();
  await closeTestPool();
});

describe('0006 — agency_agent_sessions.client_kind', () => {
  it('is VARCHAR(16) NOT NULL DEFAULT web, so every session from before it reads web', async () => {
    const { rows } = await pool().query<{ data_type: string; character_maximum_length: number; is_nullable: string; column_default: string }>(
      `SELECT data_type, character_maximum_length, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'agency_agent_sessions' AND column_name = 'client_kind'`,
    );
    expect(rows[0]).toMatchObject({ data_type: 'character varying', character_maximum_length: 16, is_nullable: 'NO' });
    expect(rows[0]?.column_default).toMatch(/^'web'::character varying$/);

    const campaign = await insertCampaign();
    const session = await insertSession(campaign.id);
    const softphone = await insertSoftphoneSession();
    const read = await pool().query<{ id: string; client_kind: string }>(
      'SELECT id, client_kind FROM agency_agent_sessions WHERE id = ANY($1::uuid[]) ORDER BY id',
      [[session.id, softphone.id]],
    );
    expect(read.rows.map((r) => r.client_kind)).toEqual(['web', 'web']);
  });

  it('accepts exactly the contract\'s client kinds (AGENCY_CLIENT_KINDS)', async () => {
    const campaign = await insertCampaign();
    for (const kind of AGENCY_CLIENT_KINDS) {
      const session = await insertSession(campaign.id, { client_kind: kind });
      expect(session['client_kind']).toBe(kind);
      await pool().query('DELETE FROM agency_agent_sessions WHERE id = $1', [session.id]);
    }
    for (const bad of ['ios', 'android', 'WEB', '']) {
      await expect(insertSession(campaign.id, { client_kind: bad })).rejects.toThrow(/ck_agency_agent_session_client_kind/);
    }
    await expect(insertSession(campaign.id, { client_kind: null })).rejects.toThrow(/null value/);
  });
});

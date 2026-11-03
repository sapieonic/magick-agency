// Real Postgres: migrations/0008_wrapup_redial.sql. globalSetup has applied every migration.
// The server writes and reads these columns (the campaign repository, `beginWrapupRedial`,
// the lapsed-wrap-up sweep); this pins their shape and the invariants the database owns:
// the setting defaults off, one redial per attempt, a link only on a numbered redial, and
// `redialed` as a wrap-up resolution.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAttempt, insertCampaign, insertContact } from '../fixtures.js';

const pool = () => getTestPool();

beforeEach(truncateAll);
afterAll(closeTestPool);

async function column(table: string, name: string) {
  const { rows } = await pool().query<{ data_type: string; is_nullable: string; column_default: string | null }>(
    `SELECT data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, name],
  );
  return rows[0];
}

describe('0008 — wrap-up redial', () => {
  it('agency_campaigns.allow_wrapup_redial is NOT NULL DEFAULT false', async () => {
    expect(await column('agency_campaigns', 'allow_wrapup_redial')).toEqual({
      data_type: 'boolean', is_nullable: 'NO', column_default: 'false',
    });
    const campaign = await insertCampaign();
    expect(campaign['allow_wrapup_redial']).toBe(false);
  });

  it('agency_call_attempts gains the redial link and number (0 for a paced dial)', async () => {
    expect(await column('agency_call_attempts', 'redial_of_attempt_id')).toMatchObject({ data_type: 'uuid', is_nullable: 'YES' });
    expect(await column('agency_call_attempts', 'redial_number')).toEqual({
      data_type: 'smallint', is_nullable: 'NO', column_default: '0',
    });
    const campaign = await insertCampaign();
    const contact = await insertContact(campaign.id);
    const attempt = await insertAttempt(campaign.id, contact.id, { state: 'ended' });
    expect(attempt).toMatchObject({ redial_of_attempt_id: null, redial_number: 0 });
  });

  it('one redial per attempt (uq_agency_attempt_redial_of)', async () => {
    const campaign = await insertCampaign();
    const contact = await insertContact(campaign.id);
    const original = await insertAttempt(campaign.id, contact.id, { state: 'ended', attempt_number: 1 });
    await insertAttempt(campaign.id, contact.id, {
      state: 'ended', attempt_number: 2, redial_of_attempt_id: original.id, redial_number: 1,
    });
    await expect(insertAttempt(campaign.id, contact.id, {
      state: 'ended', attempt_number: 3, redial_of_attempt_id: original.id, redial_number: 1,
    })).rejects.toMatchObject({ code: '23505', constraint: 'uq_agency_attempt_redial_of' });
  });

  it('a link means a numbered redial; a negative number is refused', async () => {
    const campaign = await insertCampaign();
    const contact = await insertContact(campaign.id);
    const original = await insertAttempt(campaign.id, contact.id, { state: 'ended', attempt_number: 1 });
    await expect(insertAttempt(campaign.id, contact.id, {
      state: 'ended', attempt_number: 2, redial_of_attempt_id: original.id, redial_number: 0,
    })).rejects.toMatchObject({ code: '23514', constraint: 'ck_agency_attempt_redial_link' });
    await expect(insertAttempt(campaign.id, contact.id, {
      state: 'ended', attempt_number: 3, redial_number: -1,
    })).rejects.toMatchObject({ code: '23514', constraint: 'ck_agency_attempt_redial_number' });
  });

  it('purging the redialled attempt keeps the redial (ON DELETE SET NULL) and its number', async () => {
    const campaign = await insertCampaign();
    const contact = await insertContact(campaign.id);
    const original = await insertAttempt(campaign.id, contact.id, { state: 'ended', attempt_number: 1 });
    const redial = await insertAttempt(campaign.id, contact.id, {
      state: 'ended', attempt_number: 2, redial_of_attempt_id: original.id, redial_number: 1,
    });
    await pool().query('DELETE FROM agency_call_attempts WHERE id = $1', [original.id]);
    const { rows } = await pool().query('SELECT redial_of_attempt_id, redial_number FROM agency_call_attempts WHERE id = $1', [redial.id]);
    expect(rows[0]).toEqual({ redial_of_attempt_id: null, redial_number: 1 });
  });

  it("wrapup_resolution accepts 'redialed' and still refuses anything unknown", async () => {
    const campaign = await insertCampaign();
    const contact = await insertContact(campaign.id);
    const a = await insertAttempt(campaign.id, contact.id, { state: 'ended', wrapup_resolution: 'redialed' });
    expect(a['wrapup_resolution']).toBe('redialed');
    const other = await insertContact(campaign.id);
    await expect(insertAttempt(campaign.id, other.id, { wrapup_resolution: 'bogus' })).rejects.toMatchObject({
      code: '23514', constraint: 'ck_agency_wrapup_resolution',
    });
  });
});

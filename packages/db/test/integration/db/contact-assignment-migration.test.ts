// Real Postgres: migrations/0009_contact_assignment.sql and 0010_contact_assignment_index_and_checks.sql
// (0010 validates 0009's NOT VALID CHECKs and builds the assignee index). globalSetup has
// applied every migration.
// The server writes and reads these columns (pacing's per-agent claim, the assignment
// operations, agent retry, outcome overrides); this pins their shape and the invariants the
// database owns: every setting defaults to today's behaviour, an owner carries its stamp, the
// enumerations and bounds, the history's reasons, and an attempt's override record.
import { randomUUID } from 'node:crypto';
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

async function insertEvent(o: Record<string, unknown>) {
  const cols = Object.keys(o);
  const { rows } = await pool().query(
    `INSERT INTO agency_contact_assignment_events (${cols.join(', ')})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    Object.values(o),
  );
  return rows[0] as Record<string, unknown>;
}

describe('0009 — contact assignment, agent retry, outcome overrides', () => {
  it('a campaign defaults to today\'s behaviour: pool, return to pool, agent retry off', async () => {
    const campaign = await insertCampaign();
    expect(campaign).toMatchObject({
      assignment_mode: 'pool',
      on_unstaff: 'return_to_pool',
      callback_owner_grace_minutes: 30,
      callback_fallback: 'pool',
      allow_agent_retry: false,
      agent_retry_rounds: 1,
      agent_retry_cooldown_minutes: 30,
    });
    expect(await column('agency_campaigns', 'assignment_mode')).toMatchObject({ is_nullable: 'NO' });
  });

  it.each([
    ['assignment_mode', 'round_robin', 'ck_agency_campaign_assignment_mode'],
    ['on_unstaff', 'delete', 'ck_agency_campaign_on_unstaff'],
    ['callback_fallback', 'drop', 'ck_agency_campaign_callback_fallback'],
    ['callback_owner_grace_minutes', -1, 'ck_agency_campaign_callback_grace'],
    ['agent_retry_rounds', 0, 'ck_agency_campaign_agent_retry_rounds'],
    ['agent_retry_rounds', 11, 'ck_agency_campaign_agent_retry_rounds'],
    ['agent_retry_cooldown_minutes', 10081, 'ck_agency_campaign_agent_retry_cooldown'],
  ])('refuses %s = %s', async (name, value, constraint) => {
    await expect(insertCampaign({ [name]: value })).rejects.toMatchObject({ code: '23514', constraint });
  });

  it('a contact is in the pool by default, with no retry rounds used and no override', async () => {
    const campaign = await insertCampaign();
    const contact = await insertContact(campaign.id);
    expect(contact).toMatchObject({
      assigned_user_id: null,
      assigned_at: null,
      assigned_by_user_id: null,
      agent_retry_rounds_used: 0,
      override_disposition: null,
      override_extra_attempts: 0,
      override_retry_delay: false,
      override_calling_hours: false,
      override_granted_at: null,
    });
    expect(await column('agency_contacts', 'assigned_user_id')).toMatchObject({ data_type: 'uuid', is_nullable: 'YES' });
  });

  it('an owner carries its assigned_at stamp', async () => {
    const campaign = await insertCampaign();
    await expect(insertContact(campaign.id, { assigned_user_id: randomUUID() }))
      .rejects.toMatchObject({ code: '23514', constraint: 'ck_agency_contact_assigned_at' });
    const ok = await insertContact(campaign.id, { assigned_user_id: randomUUID(), assigned_at: new Date() });
    expect(ok['assigned_user_id']).toEqual(expect.any(String));
  });

  it('extra attempts granted by an outcome stay within 0..5', async () => {
    const campaign = await insertCampaign();
    await expect(insertContact(campaign.id, { override_extra_attempts: 6 }))
      .rejects.toMatchObject({ code: '23514', constraint: 'ck_agency_contact_override_extra_attempts' });
    await expect(insertContact(campaign.id, { agent_retry_rounds_used: -1 }))
      .rejects.toMatchObject({ code: '23514', constraint: 'ck_agency_contact_agent_retry_rounds_used' });
  });

  it('0010 has validated every CHECK 0009 added NOT VALID', async () => {
    const { rows } = await pool().query<{ conname: string; convalidated: boolean }>(
      `SELECT conname, convalidated FROM pg_constraint
        WHERE conname LIKE 'ck_agency_contact_%' OR conname LIKE 'ck_agency_attempt_override_%'
           OR conname LIKE 'ck_agency_campaign_%' OR conname LIKE 'ck_agency_assignment_event_%'`);
    const byName = Object.fromEntries(rows.map((r) => [r.conname, r.convalidated]));
    for (const name of [
      'ck_agency_contact_assigned_at', 'ck_agency_contact_agent_retry_rounds_used',
      'ck_agency_contact_override_extra_attempts', 'ck_agency_attempt_override_applied',
      'ck_agency_attempt_override_note',
    ]) {
      expect(byName[name], name).toBe(true);
    }
    expect(rows.filter((r) => !r.convalidated).map((r) => r.conname)).toEqual([]);
  });

  it('idx_agency_contacts_assignee (built by 0010) serves the per-agent claim', async () => {
    const { rows } = await pool().query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_agency_contacts_assignee'`);
    expect(rows[0]?.indexdef).toMatch(/\(campaign_id, assigned_user_id, state, next_attempt_at\)/);
    // The pool claim's index is kept.
    const dialable = await pool().query(`SELECT 1 FROM pg_indexes WHERE indexname = 'idx_agency_contacts_dialable'`);
    expect(dialable.rowCount).toBe(1);
  });

  it('the assignment history records a move, refuses a non-move and an unknown reason, and cascades', async () => {
    const campaign = await insertCampaign();
    const contact = await insertContact(campaign.id);
    const agent = randomUUID();
    const base = { tenant_id: campaign['tenant_id'], campaign_id: campaign.id, contact_id: contact.id, batch_id: randomUUID() };
    const event = await insertEvent({ ...base, to_user_id: agent, reason: 'random_split', actor_user_id: randomUUID() });
    expect(event).toMatchObject({ from_user_id: null, to_user_id: agent, reason: 'random_split' });
    await expect(insertEvent({ ...base, from_user_id: agent, to_user_id: agent, reason: 'reassign' }))
      .rejects.toMatchObject({ code: '23514', constraint: 'ck_agency_assignment_event_moves' });
    await expect(insertEvent({ ...base, from_user_id: null, to_user_id: null, reason: 'unassign' }))
      .rejects.toMatchObject({ code: '23514', constraint: 'ck_agency_assignment_event_moves' });
    await expect(insertEvent({ ...base, to_user_id: agent, reason: 'lottery' }))
      .rejects.toMatchObject({ code: '23514', constraint: 'ck_agency_assignment_event_reason' });
    for (const reason of [
      'manual', 'count', 'filter', 'range', 'rebalance', 'unstaffed', 'reassign', 'unassign',
      'callback', 'callback_fallback', 'superseded', 'inherited',
    ]) {
      await insertEvent({ ...base, from_user_id: agent, to_user_id: null, reason });
    }
    await pool().query('DELETE FROM agency_contacts WHERE id = $1', [contact.id]);
    const left = await pool().query('SELECT 1 FROM agency_contact_assignment_events WHERE contact_id = $1', [contact.id]);
    expect(left.rowCount).toBe(0);
  });

  it('an attempt records the dial origin and the overrides it spent', async () => {
    const campaign = await insertCampaign();
    const contact = await insertContact(campaign.id);
    const paced = await insertAttempt(campaign.id, contact.id, { state: 'ended', attempt_number: 1 });
    expect(paced).toMatchObject({ agent_manual: false, override_applied: [], override_note: null });
    const manual = await insertAttempt(campaign.id, contact.id, {
      state: 'ended', attempt_number: 2, agent_manual: true,
      override_applied: ['extra_attempts', 'calling_hours'], override_note: 'Customer asked for after 9pm.',
    });
    expect(manual).toMatchObject({ agent_manual: true, override_applied: ['extra_attempts', 'calling_hours'] });
    await expect(insertAttempt(campaign.id, contact.id, { state: 'ended', attempt_number: 3, override_applied: ['dnc'] }))
      .rejects.toMatchObject({ code: '23514', constraint: 'ck_agency_attempt_override_applied' });
    await expect(insertAttempt(campaign.id, contact.id, { state: 'ended', attempt_number: 4, override_note: 'short' }))
      .rejects.toMatchObject({ code: '23514', constraint: 'ck_agency_attempt_override_note' });
  });
});

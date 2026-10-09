import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { getTestPool } from '../helpers/test-db.js';

/**
 * Minimal row factories for the baseline schema tests. Modelled on core's
 * `test/integration/agency/agency-factories.ts` (insertAgencyCampaign & co), but
 * every tenant/account/user id is a UUID — the baseline's typing — instead of
 * core's free-form strings.
 */

type Row = Record<string, unknown> & { id: string };
type Overrides = Record<string, unknown>;

const OLD = '2000-01-01T00:00:00Z';

export const TENANT = '11111111-1111-4111-8111-111111111111';
export const ACCOUNT = '22222222-2222-4222-8222-222222222222';

/** INSERT ... RETURNING * from a column map; `updated_at` can be backdated. */
export async function insertRow(
  table: string,
  values: Overrides,
  client: pg.Pool | pg.PoolClient = getTestPool(),
): Promise<Row> {
  const cols = Object.keys(values);
  const params = cols.map((_, i) => `$${i + 1}`);
  const { rows } = await client.query<Row>(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${params.join(', ')}) RETURNING *`,
    cols.map((c) => values[c]),
  );
  return rows[0]!;
}

export async function insertTenant(o: Overrides = {}): Promise<Row> {
  const slug = `t-${randomUUID()}`;
  return insertRow('tenants', { name: slug, slug, ...o });
}

export async function insertAccount(tenantId: string, o: Overrides = {}): Promise<Row> {
  return insertRow('accounts', { tenant_id: tenantId, name: 'acct', slug: `a-${randomUUID()}`, ...o });
}

export async function insertUser(o: Overrides = {}): Promise<Row> {
  return insertRow('users', { firebase_uid: `uid-${randomUUID()}`, email: `${randomUUID()}@example.test`, ...o });
}

export async function insertMembership(userId: string, tenantId: string, o: Overrides = {}): Promise<Row> {
  return insertRow('memberships', { user_id: userId, tenant_id: tenantId, ...o });
}

export async function insertCampaign(o: Overrides = {}): Promise<Row> {
  return insertRow('agency_campaigns', {
    tenant_id: TENANT,
    account_id: ACCOUNT,
    name: 'Campaign',
    caller_ids: ['+14155550100'],
    ...o,
  });
}

export async function insertContact(campaignId: string, o: Overrides = {}): Promise<Row> {
  return insertRow('agency_contacts', {
    campaign_id: campaignId,
    tenant_id: TENANT,
    account_id: ACCOUNT,
    phone_e164: '+14155550101',
    ...o,
  });
}

export async function insertSession(campaignId: string, o: Overrides = {}): Promise<Row> {
  return insertRow('agency_agent_sessions', {
    campaign_id: campaignId,
    tenant_id: TENANT,
    account_id: ACCOUNT,
    agent_user_id: randomUUID(),
    ...o,
  });
}

export async function insertAttempt(campaignId: string, contactId: string, o: Overrides = {}): Promise<Row> {
  return insertRow('agency_call_attempts', {
    campaign_id: campaignId,
    contact_id: contactId,
    tenant_id: TENANT,
    account_id: ACCOUNT,
    attempt_number: 1,
    caller_id: '+14155550100',
    ...o,
  });
}

export async function insertCall(o: Overrides = {}): Promise<Row> {
  return insertRow('agency_calls', {
    tenant_id: TENANT,
    account_id: ACCOUNT,
    caller_id: '+14155550100',
    destination_phone: '+14155550101',
    ...o,
  });
}

export async function insertAudioFile(o: Overrides = {}): Promise<Row> {
  return insertRow('audio_files', {
    tenant_id: TENANT,
    account_id: ACCOUNT,
    name: `clip-${randomUUID()}`,
    slug: 'clip',
    original_filename: 'clip.mp3',
    content_type: 'audio/mpeg',
    size_bytes: 1024,
    s3_key: 'clips/clip.mp3',
    ...o,
  });
}

/**
 * One row in every table that carries an `updated_at` trigger, each written with
 * `updated_at` backdated to 2000-01-01 (an INSERT never fires a BEFORE UPDATE
 * trigger), plus the column a no-op-free UPDATE can touch. The trigger test
 * updates that column and asserts `updated_at` moved — which only a firing
 * trigger can do, since the UPDATE never names `updated_at`.
 */
export async function seedUpdatedAtRows(): Promise<Array<{ trigger: string; table: string; id: string; touch: string; key?: string }>> {
  const backdated = { updated_at: OLD };
  const tenant = await insertTenant(backdated);
  const account = await insertAccount(tenant.id, backdated);
  const user = await insertUser(backdated);
  const membership = await insertMembership(user.id, tenant.id, backdated);
  const provider = await insertRow('telephony_providers', { name: `p-${randomUUID().slice(0, 8)}`, display_name: 'P', ...backdated });
  const number = await insertRow('phone_numbers', { phone_number: '+14155550199', provider_id: provider.id, ...backdated });
  const pref = await insertRow('user_notification_preferences', {
    user_id: user.id, tenant_id: tenant.id, event_key: 'agency.campaign_completed', enabled: true, ...backdated,
  });
  const job = await insertRow('agency_ingest_jobs', {
    tenant_id: tenant.id, s3_key: 'k', file_name: 'f.csv', phone_column: 'phone', ...backdated,
  });
  const staffing = await insertRow('agency_campaign_agents', {
    tenant_id: tenant.id, campaign_id: randomUUID(), user_id: user.id, ...backdated,
  });
  const flag = await insertRow('feature_flag_overrides', {
    flag_key: 'agency_dialer_enabled', scope_type: 'global', value: JSON.stringify(true), ...backdated,
  });
  const audio = await insertAudioFile(backdated);
  const announcement = await insertRow('announcements', {
    tenant_id: TENANT, account_id: ACCOUNT, name: 'Apology', type: 'audio', audio_file_id: audio.id, ...backdated,
  });
  const profile = await insertRow('call_analysis_profiles', { tenant_id: TENANT, account_id: ACCOUNT, name: 'P', ...backdated });
  const campaign = await insertCampaign(backdated);
  const contact = await insertContact(campaign.id, backdated);
  const session = await insertSession(campaign.id, backdated);
  const attempt = await insertAttempt(campaign.id, contact.id, backdated);
  const outbox = await insertRow('agency_dnc_outbox', { tenant_id: TENANT, phone_e164: '+14155550101', ...backdated });
  const call = await insertCall(backdated);
  const analysis = await insertRow('dialer_analysis_jobs', { call_id: call.id, tenant_id: TENANT, account_id: ACCOUNT, ...backdated });

  return [
    { trigger: 'tenants_updated_at', table: 'tenants', id: tenant.id, touch: "name = 'renamed'" },
    { trigger: 'accounts_updated_at', table: 'accounts', id: account.id, touch: "name = 'renamed'" },
    { trigger: 'users_updated_at', table: 'users', id: user.id, touch: "display_name = 'renamed'" },
    { trigger: 'memberships_updated_at', table: 'memberships', id: membership.id, touch: "status = 'revoked'" },
    { trigger: 'trg_telephony_providers_updated', table: 'telephony_providers', id: provider.id, touch: "display_name = 'Q'" },
    { trigger: 'trg_phone_numbers_updated', table: 'phone_numbers', id: number.id, touch: "label = 'renamed'" },
    { trigger: 'user_notification_preferences_updated_at', table: 'user_notification_preferences', id: pref.id, touch: 'enabled = false' },
    { trigger: 'agency_ingest_jobs_updated_at', table: 'agency_ingest_jobs', id: job.id, touch: "status = 'running'" },
    { trigger: 'agency_campaign_agents_updated_at', table: 'agency_campaign_agents', id: staffing.id, touch: 'unassigned_at = now()' },
    { trigger: 'set_feature_flag_overrides_updated_at', table: 'feature_flag_overrides', id: flag.id, touch: "reason = 'why'" },
    { trigger: 'audio_files_updated_at', table: 'audio_files', id: audio.id, touch: 'pcm_channels = 1' },
    { trigger: 'announcements_updated_at', table: 'announcements', id: announcement.id, touch: "name = 'renamed'" },
    { trigger: 'trg_analysis_profiles_updated_at', table: 'call_analysis_profiles', id: profile.id, touch: "description = 'x'" },
    { trigger: 'trg_agency_campaigns_updated_at', table: 'agency_campaigns', id: campaign.id, touch: "name = 'renamed'" },
    { trigger: 'trg_agency_contacts_updated_at', table: 'agency_contacts', id: contact.id, touch: 'attempt_count = 1' },
    { trigger: 'trg_agency_agent_sessions_updated_at', table: 'agency_agent_sessions', id: session.id, touch: "state = 'break'" },
    { trigger: 'trg_agency_call_attempts_updated_at', table: 'agency_call_attempts', id: attempt.id, touch: "notes = 'n'" },
    { trigger: 'trg_agency_dnc_outbox_updated_at', table: 'agency_dnc_outbox', id: outbox.id, touch: 'attempts = 1' },
    { trigger: 'trg_agency_calls_updated_at', table: 'agency_calls', id: call.id, touch: "status = 'ringing'" },
    { trigger: 'trg_dialer_analysis_jobs_updated_at', table: 'dialer_analysis_jobs', id: analysis.id, touch: "error_code = 'X'" },
  ];
}

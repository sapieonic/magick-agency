/**
 * A world for the CR9 clean-up (`service-pinned-caller-ids.repository.ts`,
 * `scripts/cleanup-service-campaign-pinned-caller-ids.ts`): numbers on the service's account and
 * numbers pinned to two tenants' credentials, and campaigns on the service's account in every
 * status holding them, plus a campaign pinned to a credential. Real rows on the test database.
 */
import { randomUUID } from 'node:crypto';
import { getTestPool } from '../setup/test-utils.js';
import { DEFAULTS } from '../setup/factories.js';
import { insertAgencyCampaign } from './agency-factories.js';

export const TENANT = DEFAULTS.tenantId;
export const ACCOUNT = DEFAULTS.accountId;
export const OTHER_TENANT = '00000000-0000-4000-8000-0000000000c9';

/** The service's own numbers (no credential). */
export const SVC1 = '+919800000101';
export const SVC2 = '+919800000102';
/** Pinned to this tenant's credential, and to another tenant's. */
export const PIN_OWN = '+919800000201';
export const PIN_OTHER = '+919800000202';

export interface PinnedWorld {
  ownCredential: string;
  otherCredential: string;
  campaigns: {
    /** Service account, draft: [SVC1, PIN_OWN, SVC2]. */
    draftMixed: string;
    /** Service account, running: [PIN_OTHER, SVC1]. */
    runningMixed: string;
    /** Service account, stopping: [PIN_OWN, SVC2]. */
    stoppingMixed: string;
    /** Service account, paused, every caller ID pinned: [PIN_OWN]. */
    pausedAllPinned: string;
    /** Service account, running, every caller ID pinned: [PIN_OWN, PIN_OTHER]. */
    runningAllPinned: string;
    /** Finished: completed [PIN_OWN, SVC1] and stopped [PIN_OWN]. */
    completed: string;
    stopped: string;
    /** Service account, running, nothing pinned: [SVC1]. */
    clean: string;
    /** On the tenant's credential, running, from its own pinned number: [PIN_OWN]. */
    onCredential: string;
  };
}

async function credential(tenantId: string, label: string): Promise<string> {
  const { rows } = await getTestPool().query<{ id: string }>(
    `INSERT INTO telephony_credentials (tenant_id, provider, label, account_ref)
     VALUES ($1, 'voicelink', $2, $3) RETURNING id`,
    [tenantId, label, `vl-${randomUUID().slice(0, 12)}`]);
  return rows[0]!.id;
}

async function phoneNumber(number: string, credentialId: string | null): Promise<void> {
  await getTestPool().query(
    `INSERT INTO phone_numbers (phone_number, provider_id, label, capabilities, telephony_credential_id)
     SELECT $1, p.id, 'n', '{voice}', $2::uuid FROM telephony_providers p WHERE p.name = 'voicelink'`,
    [number, credentialId]);
}

const campaign = async (name: string, status: string, callerIds: string[], credentialId: string | null = null) =>
  (await insertAgencyCampaign({
    name, status, caller_ids: callerIds, telephony_provider: 'voicelink', telephony_credential_id: credentialId,
  })).id as string;

/** Seed the world on a truncated database. */
export async function seedPinnedWorld(): Promise<PinnedWorld> {
  const pool = getTestPool();
  await pool.query(`INSERT INTO tenants (id, name, slug) VALUES ($1, 'Acme Collections', 'acme-cr9'), ($2, 'Other Tenant', 'other-cr9')`,
    [TENANT, OTHER_TENANT]);
  await pool.query(`INSERT INTO accounts (id, tenant_id, name, slug) VALUES ($1, $2, 'Mumbai', 'mumbai-cr9')`, [ACCOUNT, TENANT]);
  await pool.query(`INSERT INTO telephony_providers (name, display_name, status) VALUES ('voicelink', 'VoiceLink', 'active')`);
  const ownCredential = await credential(TENANT, 'Own VoiceLink');
  const otherCredential = await credential(OTHER_TENANT, 'Their VoiceLink');
  await phoneNumber(SVC1, null);
  await phoneNumber(SVC2, null);
  await phoneNumber(PIN_OWN, ownCredential);
  await phoneNumber(PIN_OTHER, otherCredential);
  return {
    ownCredential,
    otherCredential,
    campaigns: {
      draftMixed: await campaign('A draft mixed', 'draft', [SVC1, PIN_OWN, SVC2]),
      runningMixed: await campaign('B running mixed', 'running', [PIN_OTHER, SVC1]),
      stoppingMixed: await campaign('C stopping mixed', 'stopping', [PIN_OWN, SVC2]),
      pausedAllPinned: await campaign('D paused all pinned', 'paused', [PIN_OWN]),
      runningAllPinned: await campaign('E running all pinned', 'running', [PIN_OWN, PIN_OTHER]),
      completed: await campaign('F completed', 'completed', [PIN_OWN, SVC1]),
      stopped: await campaign('G stopped', 'stopped', [PIN_OWN]),
      clean: await campaign('H clean', 'running', [SVC1]),
      onCredential: await campaign('I on credential', 'running', [PIN_OWN], ownCredential),
    },
  };
}

/** Every campaign's caller IDs, by id. */
export async function callerIdsById(): Promise<Map<string, string[]>> {
  const { rows } = await getTestPool().query<{ id: string; caller_ids: string[] }>('SELECT id, caller_ids FROM agency_campaigns');
  return new Map(rows.map((r) => [r.id, r.caller_ids]));
}

/** The config-change audit rows, oldest first. */
export async function configChangedRows(): Promise<Array<{
  tenant_id: string; account_id: string | null; actor_type: string | null; user_id: string | null;
  resource_id: string; campaign_id: string; details: Record<string, unknown>;
}>> {
  const { rows } = await getTestPool().query(
    `SELECT tenant_id, account_id, actor_type, user_id, resource_id, campaign_id, details
       FROM platform_audit_log WHERE action = 'agency_campaign.config_changed' ORDER BY created_at, id`);
  return rows;
}

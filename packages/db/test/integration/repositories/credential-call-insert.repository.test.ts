// `webrtcCallRepository.create` against real Postgres, for a call pinned to a tenant carrier
// credential (decisions B18–B22, docs/status.md Plivo step 4): the row is written only while
// the credential is `active`, decided in the INSERT itself, so a status change committing
// while the insert runs cannot leave a new call on a credential that no longer dials.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, insertTenant } from '../setup/factories.js';

vi.mock('../../../src/connection.js', () => ({
  getPool: () => getTestPool(),
  healthCheck: async () => true,
}));

const { webrtcCallRepository, TelephonyCredentialNotActiveError } = await import('../../../src/repositories/agency-call.repository.js');

let tenant: string;

async function insertCredential(status: 'active' | 'disabled' | 'invalid' | 'revoked' = 'active', tenantId = tenant): Promise<string> {
  const { rows } = await getTestPool().query<{ id: string }>(
    `INSERT INTO telephony_credentials (tenant_id, provider, label, account_ref, status, revoked_at)
     VALUES ($1, 'plivo', $2, $3, $4::varchar, CASE WHEN $4::varchar = 'revoked' THEN NOW() END) RETURNING id`,
    [tenantId, `cred-${randomUUID().slice(0, 6)}`, `MA${randomUUID().replace(/-/g, '').slice(0, 18).toUpperCase()}`, status],
  );
  return rows[0]!.id;
}

const leg = (credentialId: string | null, over: Record<string, unknown> = {}) => ({
  tenant_id: tenant,
  account_id: DEFAULTS.accountId,
  caller_id: '+14155550100',
  destination_phone: '+14155550199',
  provider: 'plivo',
  telephony_credential_id: credentialId,
  campaign_id: DEFAULTS.campaignId,
  ...over,
});

async function callCount(): Promise<number> {
  return (await getTestPool().query<{ n: number }>('SELECT count(*)::int AS n FROM agency_calls')).rows[0]!.n;
}

describe('webrtcCallRepository.create — a call pinned to a credential (integration)', () => {
  beforeEach(async () => {
    await truncateAll();
    await getTestPool().query(
      `INSERT INTO telephony_providers (name, display_name) VALUES ('voicelink', 'VoiceLink'), ('plivo', 'Plivo')`,
    );
    tenant = (await insertTenant()).id as string;
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('an active credential: the row is written, pinned, with its dial-request id', async () => {
    const cred = await insertCredential('active');
    const row = await webrtcCallRepository.create(leg(cred, {
      provider_request_id: 'req-123', metadata: { k: 'v' }, recording_requested: true,
      analysis_consent: true, analysis_consent_at: new Date('2026-01-02T03:04:05Z'),
    }));
    expect(row).toMatchObject({
      telephony_credential_id: cred, provider: 'plivo', provider_request_id: 'req-123',
      metadata: { k: 'v' }, recording_requested: true, analysis_consent: true, status: 'initiating', origin: 'campaign',
    });
    expect(row.analysis_consent_at).toEqual(new Date('2026-01-02T03:04:05Z'));
  });

  it('no credential: written as before (the service account), provider_request_id null unless given', async () => {
    const row = await webrtcCallRepository.create(leg(null, { provider: undefined }));
    expect(row).toMatchObject({ telephony_credential_id: null, provider: 'voicelink', provider_request_id: null });
  });

  it.each(['disabled', 'invalid', 'revoked'] as const)('a %s credential: refused with TelephonyCredentialNotActiveError, nothing written', async (status) => {
    const cred = await insertCredential(status);
    const err = await webrtcCallRepository.create(leg(cred)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TelephonyCredentialNotActiveError);
    expect(err).toMatchObject({ credentialId: cred, code: 'telephony_credential_not_active' });
    expect(await callCount()).toBe(0);
  });

  it('an unknown credential id: the same refusal, not a foreign-key error', async () => {
    const err = await webrtcCallRepository.create(leg(randomUUID())).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TelephonyCredentialNotActiveError);
    expect(await callCount()).toBe(0);
  });

  it('another tenant\'s active credential is still refused by the composite foreign key', async () => {
    const other = (await insertTenant()).id as string;
    const cred = await insertCredential('active', other);
    await expect(webrtcCallRepository.create(leg(cred))).rejects.toMatchObject({ code: '23503' });
    expect(await callCount()).toBe(0);
  });

  it('a disable committing while the insert runs: the insert waits for it, re-reads the row and writes nothing', async () => {
    const cred = await insertCredential('active');
    const admin = await getTestPool().connect();
    try {
      await admin.query('BEGIN');
      await admin.query(`UPDATE telephony_credentials SET status = 'disabled' WHERE id = $1`, [cred]);
      // The insert starts while the disable is uncommitted: its snapshot still says active.
      const insert = webrtcCallRepository.create(leg(cred)).then(() => 'inserted', (e: unknown) => e);
      // Give it time to reach the row lock and wait there.
      await new Promise((r) => setTimeout(r, 300));
      const waiting = await getTestPool().query<{ n: number }>(
        // This database only: other integration workers run their own files on their own copies.
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE 'INSERT INTO agency_calls%'`);
      expect(waiting.rows[0]!.n).toBe(1);
      await admin.query('COMMIT');
      expect(await insert).toBeInstanceOf(TelephonyCredentialNotActiveError);
    } finally {
      await admin.query('ROLLBACK').catch(() => undefined);
      admin.release();
    }
    expect(await callCount()).toBe(0);
  });

  it('a revoke (row lock, then status) committing while the insert runs: nothing written', async () => {
    const cred = await insertCredential('active');
    const admin = await getTestPool().connect();
    try {
      await admin.query('BEGIN');
      await admin.query('SELECT 1 FROM telephony_credentials WHERE id = $1 FOR UPDATE', [cred]);
      await admin.query(`UPDATE telephony_credentials SET status = 'revoked', revoked_at = NOW() WHERE id = $1`, [cred]);
      const insert = webrtcCallRepository.create(leg(cred)).then(() => 'inserted', (e: unknown) => e);
      await new Promise((r) => setTimeout(r, 300));
      await admin.query('COMMIT');
      expect(await insert).toBeInstanceOf(TelephonyCredentialNotActiveError);
    } finally {
      await admin.query('ROLLBACK').catch(() => undefined);
      admin.release();
    }
    expect(await callCount()).toBe(0);
  });
});

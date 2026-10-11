// Per-tenant carrier credentials against real Postgres (0002_telephony_credentials.sql,
// decisions B18–B22): the schema's own guards (tenant- and provider-matched pinning,
// one registration per carrier account, the status/secret invariants) and the
// repository's conditional writes (rotation, revoke, shred, prune).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertTenant, insertWebrtcCall } from '../setup/factories.js';
import { isUniqueViolation } from '../../../src/pg-errors.js';

vi.mock('../../../src/connection.js', () => ({
  getPool: () => getTestPool(),
  healthCheck: async () => true,
}));

const {
  telephonyCredentialRepository: repo,
  TELEPHONY_CREDENTIAL_ACCOUNT_UNIQUE,
  TELEPHONY_CREDENTIAL_LABEL_UNIQUE,
} = await import('../../../src/repositories/telephony-credential.repository.js');

const sealed = (tag: string) => ({
  secret_ciphertext: Buffer.from(`ct-${tag}`),
  wrapped_dek: Buffer.from(`dek-${tag}`),
  kek_id: 'env:v1',
  secret_hint: tag.slice(-4).padStart(4, '0'),
});

let tenantA: string;
let tenantB: string;
let admin: string;

async function create(over: Partial<{ tenant: string; provider: string; label: string; account: string }> = {}) {
  return repo.create({
    id: randomUUID(),
    tenant_id: over.tenant ?? tenantA,
    provider: over.provider ?? 'plivo',
    label: over.label ?? `cred-${randomUUID().slice(0, 6)}`,
    account_ref: over.account ?? `MA${randomUUID().replace(/-/g, '').slice(0, 18).toUpperCase()}`,
    public_config: { auth_id: 'x' },
    sealed: sealed('v1aa'),
    created_by: admin,
    verified_at: new Date(),
  });
}

async function pgError(p: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await p;
  } catch (err) {
    return err as { code?: string; constraint?: string };
  }
  throw new Error('expected the statement to fail');
}

describe('telephony credentials (integration)', () => {
  beforeEach(async () => {
    await truncateAll();
    // truncateAll empties the seeded provider rows too.
    await getTestPool().query(
      `INSERT INTO telephony_providers (name, display_name) VALUES ('voicelink', 'VoiceLink'), ('plivo', 'Plivo')`,
    );
    tenantA = (await insertTenant()).id;
    tenantB = (await insertTenant()).id;
    admin = (await getTestPool().query<{ id: string }>(
      `INSERT INTO super_admins (email, password_hash, name) VALUES ($1, 'x', 'Root') RETURNING id`,
      [`root-${randomUUID()}@example.test`],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    await closeTestPool();
  });

  describe('create and read', () => {
    it('stores the row and its first secret version together; reads carry no secret material', async () => {
      const row = await create({ label: 'Main' });
      expect(row).toMatchObject({ status: 'active', secret_version: 1, secret_hint: 'v1aa', provider: 'plivo' });
      expect(Object.keys(row)).not.toEqual(expect.arrayContaining(['secret_ciphertext']));
      for (const r of [await repo.findById(row.id), ...(await repo.list({ tenantId: tenantA }))]) {
        expect(r).not.toHaveProperty('secret_ciphertext');
        expect(r).not.toHaveProperty('wrapped_dek');
      }
      const secrets = await repo.findOpenableSecrets(row.id, 3600);
      expect(secrets).toHaveLength(1);
      expect(secrets[0]).toMatchObject({ secret_version: 1, kek_id: 'env:v1', retired_at: null });
      expect(secrets[0]!.secret_ciphertext.toString()).toBe('ct-v1aa');
      expect(await repo.distinctKekIds()).toEqual(['env:v1']);
    });

    it('reads another tenant’s id as absent through the tenant-scoped lookup', async () => {
      const row = await create();
      expect(await repo.findByIdForTenant(row.id, tenantA)).not.toBeNull();
      expect(await repo.findByIdForTenant(row.id, tenantB)).toBeNull();
    });

    it('refuses a second live registration of one carrier account, in any tenant', async () => {
      await create({ account: 'MAAAAAAAAAAAAAAAAAAA' });
      const err = await pgError(create({ tenant: tenantB, account: 'MAAAAAAAAAAAAAAAAAAA' }));
      expect(isUniqueViolation(err, TELEPHONY_CREDENTIAL_ACCOUNT_UNIQUE)).toBe(true);
    });

    it('allows re-registering an account once the old registration is revoked', async () => {
      const old = await create({ account: 'MABBBBBBBBBBBBBBBBBB' });
      await repo.revoke(old.id, admin);
      await expect(create({ tenant: tenantB, account: 'MABBBBBBBBBBBBBBBBBB' })).resolves.toBeTruthy();
    });

    it('refuses a duplicate label in a tenant, case-insensitively', async () => {
      await create({ label: 'Main' });
      const err = await pgError(create({ label: 'MAIN' }));
      expect(isUniqueViolation(err, TELEPHONY_CREDENTIAL_LABEL_UNIQUE)).toBe(true);
      await expect(create({ tenant: tenantB, label: 'Main' })).resolves.toBeTruthy();
    });

    it('refuses an unknown provider and a non-object public_config', async () => {
      expect((await pgError(create({ provider: 'nope' }))).code).toBe('23503');
      const err = await pgError(getTestPool().query(
        `INSERT INTO telephony_credentials (tenant_id, provider, label, account_ref, public_config)
         VALUES ($1, 'plivo', 'x', 'y', '[]')`, [tenantA]));
      expect(err.code).toBe('23514');
    });
  });

  describe('pinning: calls and campaigns can only pin their own tenant’s credential, of their own provider', () => {
    it('accepts a call pinned to its own tenant’s plivo credential', async () => {
      const cred = await create();
      const call = await insertWebrtcCall({ tenant_id: tenantA, provider: 'plivo', telephony_credential_id: cred.id });
      expect(call.telephony_credential_id).toBe(cred.id);
      expect(call.provider_request_id).toBeNull();
    });

    it('refuses a call pinned to another tenant’s credential', async () => {
      const cred = await create({ tenant: tenantB });
      const err = await pgError(insertWebrtcCall({ tenant_id: tenantA, provider: 'plivo', telephony_credential_id: cred.id }));
      expect(err).toMatchObject({ code: '23503', constraint: 'fk_agency_calls_telephony_credential' });
    });

    it('refuses a call whose provider differs from the credential’s', async () => {
      const cred = await create();
      const err = await pgError(insertWebrtcCall({ tenant_id: tenantA, provider: 'voicelink', telephony_credential_id: cred.id }));
      expect(err).toMatchObject({ code: '23503', constraint: 'fk_agency_calls_telephony_credential' });
    });

    it('refuses a campaign pinned to another tenant’s credential, and accepts its own', async () => {
      const own = await create();
      const foreign = await create({ tenant: tenantB });
      const insertCampaign = (credId: string) => getTestPool().query(
        `INSERT INTO agency_campaigns (tenant_id, account_id, name, caller_ids, telephony_provider, telephony_credential_id)
         VALUES ($1, $2, 'c', ARRAY['+14155550100'], 'plivo', $3)`,
        [tenantA, randomUUID(), credId],
      );
      await expect(insertCampaign(own.id)).resolves.toBeTruthy();
      expect(await pgError(insertCampaign(foreign.id))).toMatchObject({ code: '23503', constraint: 'fk_agency_campaigns_telephony_credential' });
    });
  });

  describe('rotation', () => {
    it('bumps the version, retires the old secret, and keeps it openable inside the grace window only', async () => {
      const cred = await create();
      const rotated = await repo.rotateSecret(cred.id, 1, sealed('v2bb'), { updatedBy: admin, verifiedAt: new Date() });
      expect(rotated).toMatchObject({ secret_version: 2, secret_hint: 'v2bb' });

      const inGrace = await repo.findOpenableSecrets(cred.id, 3600);
      expect(inGrace.map((s) => [s.secret_version, s.retired_at === null])).toEqual([[2, true], [1, false]]);
      expect(await repo.findOpenableSecrets(cred.id, 0)).toHaveLength(1);
    });

    it('lets only one of two rotations from the same version land', async () => {
      const cred = await create();
      const [a, b] = await Promise.all([
        repo.rotateSecret(cred.id, 1, sealed('aaaa'), { updatedBy: admin, verifiedAt: null }),
        repo.rotateSecret(cred.id, 1, sealed('bbbb'), { updatedBy: admin, verifiedAt: null }),
      ]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
      const { rows } = await getTestPool().query(
        `SELECT count(*)::int AS n FROM telephony_credential_secrets WHERE credential_id = $1 AND retired_at IS NULL`, [cred.id]);
      expect(rows[0].n).toBe(1);
    });

    it('re-activates an invalid credential but leaves a disabled one disabled', async () => {
      const inv = await create();
      await repo.setStatus(inv.id, 'invalid', ['active'], { updatedBy: null, lastError: 'Plivo refused (HTTP 401)' });
      const r1 = await repo.rotateSecret(inv.id, 1, sealed('cccc'), { updatedBy: admin, verifiedAt: new Date() });
      expect(r1).toMatchObject({ status: 'active', last_error: null });

      const dis = await create();
      await repo.setStatus(dis.id, 'disabled', ['active'], { updatedBy: admin });
      const r2 = await repo.rotateSecret(dis.id, 1, sealed('dddd'), { updatedBy: admin, verifiedAt: new Date() });
      expect(r2?.status).toBe('disabled');
    });

    it('prunes retired secrets past the grace window, never the current one', async () => {
      const cred = await create();
      await repo.rotateSecret(cred.id, 1, sealed('eeee'), { updatedBy: admin, verifiedAt: null });
      expect(await repo.pruneRetiredSecrets(3600)).toBe(0);
      expect(await repo.pruneRetiredSecrets(0)).toBe(1);
      const left = await repo.findOpenableSecrets(cred.id, 3600);
      expect(left.map((s) => s.secret_version)).toEqual([2]);
    });
  });

  describe('status, revoke and shred', () => {
    it('moves only out of the listed statuses', async () => {
      const cred = await create();
      expect(await repo.setStatus(cred.id, 'active', ['disabled'], { updatedBy: admin })).toBeNull();
      expect((await repo.setStatus(cred.id, 'disabled', ['active'], { updatedBy: admin }))?.status).toBe('disabled');
    });

    it('treats revoke as terminal', async () => {
      const cred = await create();
      const revoked = await repo.revoke(cred.id, admin);
      expect(revoked).toMatchObject({ status: 'revoked' });
      expect(revoked!.revoked_at).not.toBeNull();
      expect(await repo.revoke(cred.id, admin)).toBeNull();
      expect(await repo.setStatus(cred.id, 'active', ['active', 'disabled', 'invalid'], { updatedBy: admin })).toBeNull();
      expect(await repo.updateLabel(cred.id, 'x', admin)).toBeNull();
      expect(await repo.rotateSecret(cred.id, 1, sealed('ffff'), { updatedBy: admin, verifiedAt: null })).toBeNull();
    });

    it('will not shred while a call is in flight on it, and destroys every secret version once none is', async () => {
      const cred = await create();
      await repo.rotateSecret(cred.id, 1, sealed('gggg'), { updatedBy: admin, verifiedAt: null });
      const call = await insertWebrtcCall({ tenant_id: tenantA, provider: 'plivo', telephony_credential_id: cred.id, status: 'in_progress' });
      expect(await repo.usage(cred.id)).toEqual({ campaigns: 0, inFlightCalls: 1 });

      expect(await repo.shredIfIdle(cred.id)).toBe(false); // not revoked yet
      await repo.revoke(cred.id, admin);
      expect(await repo.shredIfIdle(cred.id)).toBe(false); // call still in flight
      expect(await repo.findRevokedUnshredded()).toEqual([cred.id]);

      await getTestPool().query(`UPDATE agency_calls SET status = 'completed' WHERE id = $1`, [call.id]);
      expect(await repo.shredIfIdle(cred.id)).toBe(true);
      expect(await repo.shredIfIdle(cred.id)).toBe(false);

      const row = await repo.findById(cred.id);
      expect(row).toMatchObject({ status: 'revoked', secret_hint: null });
      expect(row!.shredded_at).not.toBeNull();
      expect(await repo.findOpenableSecrets(cred.id, 1e6)).toEqual([]);
      expect(await repo.findRevokedUnshredded()).toEqual([]);
      // The call row survives the shred, still pinned.
      const { rows } = await getTestPool().query(`SELECT telephony_credential_id FROM agency_calls WHERE id = $1`, [call.id]);
      expect(rows[0].telephony_credential_id).toBe(cred.id);
    });

    it('enforces the status invariants in the schema itself', async () => {
      const cred = await create();
      // revoked_at without revoked
      expect((await pgError(getTestPool().query(`UPDATE telephony_credentials SET revoked_at = NOW() WHERE id = $1`, [cred.id]))).code).toBe('23514');
      // shredded while live
      expect((await pgError(getTestPool().query(`UPDATE telephony_credentials SET shredded_at = NOW(), secret_hint = NULL WHERE id = $1`, [cred.id]))).code).toBe('23514');
    });

    it('counts only campaigns that can still dial: a finished one does not block a revoke forever', async () => {
      const cred = await create();
      const insert = (status: string) => getTestPool().query(
        `INSERT INTO agency_campaigns (tenant_id, account_id, name, caller_ids, telephony_provider, telephony_credential_id, status)
         VALUES ($1, $2, 'c', ARRAY['+14155550100'], 'plivo', $3, $4)`, [tenantA, randomUUID(), cred.id, status]);
      await insert('draft');
      await insert('completed');
      await insert('stopped');
      expect(await repo.usage(cred.id)).toEqual({ campaigns: 1, inFlightCalls: 0 });
    });
  });
});

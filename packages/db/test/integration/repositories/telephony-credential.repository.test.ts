// Per-tenant carrier credentials against real Postgres (0002_telephony_credentials.sql,
// decisions B18–B22): the schema's own guards (tenant- and provider-matched pinning,
// one registration per carrier account, the status/secret invariants) and the
// repository's conditional writes (rotation, verify, revoke, shred, prune), and the
// shred's hold: no secret is destroyed while a pinned call may still need it.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertTenant, insertWebrtcCall } from '../setup/factories.js';
import { isUniqueViolation } from '../../../src/pg-errors.js';
import { WEBRTC_NON_TERMINAL_STATUSES } from '../../../src/models/agency-call.model.js';

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

/** The post-call webhook window the server passes (two hours). */
const HOLD = 2 * 60 * 60;

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

    it('findOpenableVersions lists exactly the openable versions, in the same order, without ciphertext', async () => {
      const cred = await create();
      await repo.rotateSecret(cred.id, 1, sealed('v2bb'), { updatedBy: admin, verifiedAt: null });
      await repo.rotateSecret(cred.id, 2, sealed('v3cc'), { updatedBy: admin, verifiedAt: null });
      for (const grace of [3600, 0]) {
        const versions = await repo.findOpenableVersions(cred.id, grace);
        const secrets = await repo.findOpenableSecrets(cred.id, grace);
        expect(versions).toEqual(secrets.map((s) => ({ secret_version: s.secret_version, kek_id: s.kek_id })));
        for (const v of versions) expect(Object.keys(v).sort()).toEqual(['kek_id', 'secret_version']);
      }
      expect((await repo.findOpenableVersions(cred.id, 3600)).map((v) => v.secret_version)).toEqual([3, 2, 1]);
      expect((await repo.findOpenableVersions(cred.id, 0)).map((v) => v.secret_version)).toEqual([3]);
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

    it('makes a status move pinned to a secret version a no-op once a rotation replaced it', async () => {
      const cred = await create();
      await repo.rotateSecret(cred.id, 1, sealed('hhhh'), { updatedBy: admin, verifiedAt: null });
      expect(await repo.setStatus(cred.id, 'invalid', ['active'], { updatedBy: admin, lastError: 'old', secretVersion: 1 })).toBeNull();
      expect((await repo.setStatus(cred.id, 'invalid', ['active'], { updatedBy: admin, lastError: 'new', secretVersion: 2 }))?.status).toBe('invalid');
    });

    it('markVerified re-activates an invalid credential and clears last_error', async () => {
      const cred = await create();
      await repo.setStatus(cred.id, 'invalid', ['active'], { updatedBy: null, lastError: 'Plivo refused (HTTP 401)' });
      const row = await repo.markVerified(cred.id, 1, admin);
      expect(row).toMatchObject({ status: 'active', last_error: null, updated_by: admin });
      expect(row!.verified_at).not.toBeNull();
      // A system check (no actor) keeps the last actor.
      expect((await repo.markVerified(cred.id, 1, null))?.updated_by).toBe(admin);
    });

    it('markVerified leaves a disabled credential disabled with last_error cleared, so enable brings it back active', async () => {
      const cred = await create();
      await repo.setStatus(cred.id, 'disabled', ['active'], { updatedBy: admin, lastError: 'Plivo refused (HTTP 401)' });
      expect(await repo.markVerified(cred.id, 1, null)).toMatchObject({ status: 'disabled', last_error: null });
      expect((await repo.enable(cred.id, admin))?.status).toBe('active');
    });

    it('markVerified is a no-op on a revoked credential and on a replaced secret version', async () => {
      const stale = await create();
      await repo.setStatus(stale.id, 'invalid', ['active'], { updatedBy: null, lastError: 'refused' });
      await repo.rotateSecret(stale.id, 1, sealed('iiii'), { updatedBy: admin, verifiedAt: null });
      await repo.setStatus(stale.id, 'invalid', ['active'], { updatedBy: null, lastError: 'refused v2' });
      expect(await repo.markVerified(stale.id, 1, admin)).toBeNull();
      expect(await repo.findById(stale.id)).toMatchObject({ status: 'invalid', last_error: 'refused v2' });

      const gone = await create();
      await repo.revoke(gone.id, admin);
      const before = await repo.findById(gone.id);
      expect(await repo.markVerified(gone.id, 1, admin)).toBeNull();
      expect(await repo.findById(gone.id)).toEqual(before);
    });

    it('enables a disabled credential as invalid when the carrier last refused it, else active', async () => {
      const clean = await create();
      await repo.setStatus(clean.id, 'disabled', ['active'], { updatedBy: admin });
      expect((await repo.enable(clean.id, admin))?.status).toBe('active');
      expect(await repo.enable(clean.id, admin)).toBeNull(); // not disabled any more

      const refused = await create({ account: 'MABBBBBBBBBBBBBBBBBB', label: 'Refused' });
      await repo.setStatus(refused.id, 'disabled', ['active'], { updatedBy: admin, lastError: 'Plivo refused the credential (HTTP 401)' });
      expect((await repo.enable(refused.id, admin))?.status).toBe('invalid');
    });

    it('will not revoke while a live campaign is pinned to it', async () => {
      const cred = await create();
      const { rows } = await getTestPool().query<{ id: string }>(
        `INSERT INTO agency_campaigns (tenant_id, account_id, name, caller_ids, telephony_provider, telephony_credential_id, status)
         VALUES ($1, $2, 'c', ARRAY['+14155550100'], 'plivo', $3, 'paused') RETURNING id`, [tenantA, randomUUID(), cred.id]);
      expect(await repo.revoke(cred.id, admin)).toBeNull();
      await getTestPool().query(`UPDATE agency_campaigns SET status = 'completed' WHERE id = $1`, [rows[0]!.id]);
      expect(await repo.revoke(cred.id, admin)).toMatchObject({ status: 'revoked' });
    });

    it('names the live campaigns pinned to it, running first and capped; finished ones are not', async () => {
      const cred = await create();
      const accountId = randomUUID();
      await getTestPool().query(
        `INSERT INTO accounts (id, tenant_id, name, slug) VALUES ($1, $2, 'Main', $3)`, [accountId, tenantA, `main-${accountId.slice(0, 8)}`]);
      const pin = (name: string, status: string, account = accountId) => getTestPool().query(
        `INSERT INTO agency_campaigns (tenant_id, account_id, name, caller_ids, telephony_provider, telephony_credential_id, status)
         VALUES ($1, $2, $3, ARRAY['+14155550100'], 'plivo', $4, $5)`, [tenantA, account, name, cred.id, status]);
      await pin('Drafted', 'draft');
      await pin('Live', 'running');
      await pin('Held', 'paused', randomUUID());
      await pin('Done', 'completed');
      const { rows: [tenant] } = await getTestPool().query<{ name: string }>('SELECT name FROM tenants WHERE id = $1', [tenantA]);

      expect(await repo.liveCampaigns(cred.id, 10)).toEqual([
        expect.objectContaining({ name: 'Live', status: 'running', tenant_name: tenant!.name, account_name: 'Main' }),
        expect.objectContaining({ name: 'Held', status: 'paused', account_name: null }),
        expect.objectContaining({ name: 'Drafted', status: 'draft', account_name: 'Main' }),
      ]);
      expect((await repo.liveCampaigns(cred.id, 1)).map((c) => c.name)).toEqual(['Live']);
    });

    it('sees a campaign pin that commits while the revoke waits on the row lock', async () => {
      const cred = await create();
      const pinner = await getTestPool().connect();
      try {
        await pinner.query('BEGIN');
        // The foreign-key check takes a key-share lock on the credential row until commit.
        await pinner.query(
          `INSERT INTO agency_campaigns (tenant_id, account_id, name, caller_ids, telephony_provider, telephony_credential_id)
           VALUES ($1, $2, 'c', ARRAY['+14155550100'], 'plivo', $3)`, [tenantA, randomUUID(), cred.id]);
        const revoking = repo.revoke(cred.id, admin);
        await new Promise((r) => setTimeout(r, 200));
        await pinner.query('COMMIT');
        expect(await revoking).toBeNull();
      } finally {
        pinner.release();
      }
      expect((await repo.findById(cred.id))?.status).toBe('active');
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

      expect(await repo.shredIfIdle(cred.id, HOLD)).toBe(false); // not revoked yet
      await repo.revoke(cred.id, admin);
      expect(await repo.shredIfIdle(cred.id, HOLD)).toBe(false); // call still in flight
      expect(await repo.findRevokedUnshredded(HOLD)).toEqual([]); // the shred would refuse it

      await getTestPool().query(
        `UPDATE agency_calls SET status = 'completed', ended_at = NOW() - interval '3 hours' WHERE id = $1`, [call.id]);
      expect(await repo.shredIfIdle(cred.id, HOLD)).toBe(true);
      expect(await repo.shredIfIdle(cred.id, HOLD)).toBe(false);

      const row = await repo.findById(cred.id);
      expect(row).toMatchObject({ status: 'revoked', secret_hint: null });
      expect(row!.shredded_at).not.toBeNull();
      expect(await repo.findOpenableSecrets(cred.id, 1e6)).toEqual([]);
      expect(await repo.findRevokedUnshredded(HOLD)).toEqual([]);
      // The call row survives the shred, still pinned.
      const { rows } = await getTestPool().query(`SELECT telephony_credential_id FROM agency_calls WHERE id = $1`, [call.id]);
      expect(rows[0].telephony_credential_id).toBe(cred.id);
    });

    it('sees a call insert that commits while the shred waits on the row lock', async () => {
      const cred = await create();
      await repo.revoke(cred.id, admin);
      const dialer = await getTestPool().connect();
      try {
        await dialer.query('BEGIN');
        // A dial resolved before the revoke, inserting its call row now: the foreign-key
        // check holds a key-share lock on the credential row until commit.
        await dialer.query(
          `INSERT INTO agency_calls (tenant_id, account_id, caller_id, destination_phone, provider, status, telephony_credential_id)
           VALUES ($1, $2, '+14155550100', '+14155550199', 'plivo', 'initiating', $3)`, [tenantA, randomUUID(), cred.id]);
        const shredding = repo.shredIfIdle(cred.id, HOLD);
        await new Promise((r) => setTimeout(r, 200));
        await dialer.query('COMMIT');
        expect(await shredding).toBe(false);
      } finally {
        dialer.release();
      }
      expect(await repo.findOpenableSecrets(cred.id, 1e6)).toHaveLength(1);
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

  describe('inbound (0024; docs/inbound.md §3.1, §8.1): the Application, its URLs and the token\'s hash', () => {
    const H1 = '1'.repeat(64);
    const H2 = '2'.repeat(64);
    const H3 = '3'.repeat(64);
    const urls = (v: string) => ({
      answerUrl: `https://hooks.example.test/inbound-answer/${v}`,
      hangupUrl: `https://hooks.example.test/inbound-status/${v}`,
      fallbackAnswerUrl: `https://hooks.example.test/inbound-fallback/${v}`,
    });

    async function linkNumber(credentialId: string, at: Date | null = new Date()) {
      const provider = (await getTestPool().query<{ id: string }>(`SELECT id FROM telephony_providers WHERE name = 'plivo'`)).rows[0]!.id;
      await getTestPool().query(
        `INSERT INTO phone_numbers (phone_number, provider_id, telephony_credential_id, inbound_linked_at) VALUES ($1, $2, $3, $4)`,
        [`+1415555${String(Math.floor(Math.random() * 10_000)).padStart(4, '0')}`, provider, credentialId, at]);
    }

    it('starts disabled; enable stores it all, once, only on an active credential', async () => {
      const c = await create();
      expect(await repo.findInbound(c.id)).toMatchObject({
        credential_id: c.id, tenant_id: tenantA, provider: 'plivo', status: 'active', app_id: null, answer_url: null,
        enabled_at: null, previous_token_expires_at: null, linked_numbers: 0,
      });
      const on = await repo.enableInbound(c.id, { appId: 'app-1', tokenHash: H1, ...urls('a') }, admin);
      expect(on).toMatchObject({ app_id: 'app-1', ...{ answer_url: urls('a').answerUrl, hangup_url: urls('a').hangupUrl, fallback_answer_url: urls('a').fallbackAnswerUrl } });
      expect(on!.enabled_at).toBeInstanceOf(Date);
      // Never the hash: the record has no such field.
      expect(Object.keys(on!).some((k) => k.includes('token_hash'))).toBe(false);
      // Twice: the second is a no-op (the caller deletes the Application it made for nothing).
      expect(await repo.enableInbound(c.id, { appId: 'app-2', tokenHash: H2, ...urls('b') }, admin)).toBeNull();
      expect((await repo.findInbound(c.id))!.app_id).toBe('app-1');

      const disabled = await create();
      await repo.setStatus(disabled.id, 'disabled', ['active'], { updatedBy: admin });
      expect(await repo.enableInbound(disabled.id, { appId: 'app-3', tokenHash: H1, ...urls('c') }, admin)).toBeNull();
      expect(await repo.findInbound(randomUUID())).toBeNull();
    });

    it('listInboundEnabled: every credential with inbound enabled and not revoked, a disabled one included, oldest first', async () => {
      expect(await repo.listInboundEnabled()).toEqual([]);
      const first = await create();
      const second = await create({ tenant: tenantB });
      const off = await create();
      await repo.enableInbound(first.id, { appId: 'app-1', tokenHash: H1, ...urls('a') }, admin);
      await repo.enableInbound(second.id, { appId: 'app-2', tokenHash: H2, ...urls('b') }, admin);
      // A disabled credential still answers its linked numbers (closed message): its Application is still checked.
      await repo.setStatus(second.id, 'disabled', ['active'], { updatedBy: admin });
      expect(await repo.listInboundEnabled()).toEqual([
        { credential_id: first.id, tenant_id: tenantA, status: 'active' },
        { credential_id: second.id, tenant_id: tenantB, status: 'disabled' },
      ]);
      expect((await repo.listInboundEnabled()).map((r) => r.credential_id)).not.toContain(off.id);
    });

    it('the token matches by its hash only while inbound is enabled', async () => {
      const c = await create();
      expect(await repo.inboundTokenMatches(c.id, H1)).toBe(false);
      await repo.enableInbound(c.id, { appId: 'app-1', tokenHash: H1, ...urls('a') }, admin);
      expect(await repo.inboundTokenMatches(c.id, H1)).toBe(true);
      expect(await repo.inboundTokenMatches(c.id, H2)).toBe(false);
      // Another credential's token is not this one's.
      const other = await create();
      await repo.enableInbound(other.id, { appId: 'app-9', tokenHash: H2, ...urls('o') }, admin);
      expect(await repo.inboundTokenMatches(c.id, H2)).toBe(false);
    });

    it('a Re-point replaces the URLs and the token, and keeps the old token for its grace only', async () => {
      const c = await create();
      await repo.enableInbound(c.id, { appId: 'app-1', tokenHash: H1, ...urls('a') }, admin);
      const enabledAt = (await repo.findInbound(c.id))!.enabled_at;
      const moved = await repo.repointInbound(c.id, { tokenHash: H2, previousTokenGraceSeconds: 3600, ...urls('b') }, admin);
      expect(moved).toMatchObject({ app_id: 'app-1', answer_url: urls('b').answerUrl, enabled_at: enabledAt });
      expect(moved!.previous_token_expires_at!.getTime()).toBeGreaterThan(Date.now() + 3_500_000);
      expect(await repo.inboundTokenMatches(c.id, H2)).toBe(true);
      expect(await repo.inboundTokenMatches(c.id, H1)).toBe(true); // the grace
      // A second Re-point drops the oldest token at once.
      await repo.repointInbound(c.id, { appId: 'app-2', tokenHash: H3, previousTokenGraceSeconds: 3600, ...urls('c') }, admin);
      expect((await repo.findInbound(c.id))!.app_id).toBe('app-2');
      expect(await repo.inboundTokenMatches(c.id, H1)).toBe(false);
      expect(await repo.inboundTokenMatches(c.id, H2)).toBe(true);
      // Past its expiry the previous token is refused.
      await getTestPool().query(
        `UPDATE telephony_credentials SET inbound_previous_token_expires_at = now() - interval '1 second' WHERE id = $1`, [c.id]);
      expect(await repo.inboundTokenMatches(c.id, H2)).toBe(false);
      expect(await repo.inboundTokenMatches(c.id, H3)).toBe(true);
      // Not enabled: nothing to re-point.
      expect(await repo.repointInbound((await create()).id, { tokenHash: H1, previousTokenGraceSeconds: 60, ...urls('d') }, admin)).toBeNull();
    });

    it('findInboundForCallback: findInbound plus the token match, answering as inboundTokenMatches does', async () => {
      const c = await create();
      const read = (h: string) => repo.findInboundForCallback(c.id, h);
      const agrees = async (h: string, expected: boolean) => {
        expect(await repo.inboundTokenMatches(c.id, h)).toBe(expected);
        expect((await read(h))!.token_matches).toBe(expected);
      };
      await agrees(H1, false); // not enabled
      await repo.enableInbound(c.id, { appId: 'app-1', tokenHash: H1, ...urls('a') }, admin);
      const { token_matches: _matches, ...state } = (await read(H1))!;
      expect(state).toEqual(await repo.findInbound(c.id));
      await agrees(H1, true);
      await agrees(H2, false);
      await repo.repointInbound(c.id, { tokenHash: H2, previousTokenGraceSeconds: 3600, ...urls('b') }, admin);
      await agrees(H2, true);
      await agrees(H1, true); // the grace
      await getTestPool().query(
        `UPDATE telephony_credentials SET inbound_previous_token_expires_at = now() - interval '1 second' WHERE id = $1`, [c.id]);
      await agrees(H1, false);
      await agrees(H2, true);
      expect(await repo.findInboundForCallback(randomUUID(), H1)).toBeNull();
    });

    it('disable is refused while a number is linked, and clears every inbound column once none is', async () => {
      const c = await create();
      expect(await repo.disableInbound(c.id, admin)).toEqual({ ok: false, reason: 'not_enabled' });
      await repo.enableInbound(c.id, { appId: 'app-1', tokenHash: H1, ...urls('a') }, admin);
      await repo.repointInbound(c.id, { tokenHash: H2, previousTokenGraceSeconds: 3600, ...urls('b') }, admin);
      await linkNumber(c.id);
      await linkNumber(c.id, null); // a synced number not linked does not count
      expect((await repo.findInbound(c.id))!.linked_numbers).toBe(1);
      expect(await repo.disableInbound(c.id, admin)).toEqual({ ok: false, reason: 'numbers_linked' });
      await getTestPool().query('UPDATE phone_numbers SET inbound_linked_at = NULL WHERE telephony_credential_id = $1', [c.id]);
      const off = await repo.disableInbound(c.id, admin);
      expect(off).toMatchObject({ ok: true, inbound: { app_id: null, answer_url: null, hangup_url: null, enabled_at: null, previous_token_expires_at: null } });
      const { rows } = await getTestPool().query(
        'SELECT inbound_token_hash, inbound_previous_token_hash FROM telephony_credentials WHERE id = $1', [c.id]);
      expect(rows[0]).toEqual({ inbound_token_hash: null, inbound_previous_token_hash: null });
      expect(await repo.inboundTokenMatches(c.id, H2)).toBe(false);
      expect(await repo.disableInbound(randomUUID(), admin)).toEqual({ ok: false, reason: 'not_enabled' });
    });

    it('a revoke of an inbound-enabled credential is refused, by the revoke and by the schema (disable inbound first)', async () => {
      const c = await create();
      await repo.enableInbound(c.id, { appId: 'app-1', tokenHash: H1, ...urls('a') }, admin);
      // The revoke's own statement does not land (the service re-reads and answers `inbound_enabled`)…
      expect(await repo.revoke(c.id, admin)).toBeNull();
      expect((await repo.findById(c.id))!.status).toBe('active');
      // …and a write that skips it is still refused by the CHECK.
      expect(await pgError(getTestPool().query(
        `UPDATE telephony_credentials SET status = 'revoked', revoked_at = now() WHERE id = $1`, [c.id],
      ))).toMatchObject({ code: '23514', constraint: 'ck_telephony_credentials_inbound_revoked' });
      expect((await repo.disableInbound(c.id, admin)).ok).toBe(true);
      expect((await repo.revoke(c.id, admin))!.status).toBe('revoked');
    });

    it('lockInbound holds the row: an enable waits for the locking transaction, and a joined disable rolls back with it', async () => {
      const c = await create();
      await repo.enableInbound(c.id, { appId: 'app-1', tokenHash: H1, ...urls('a') }, admin);
      const client = await getTestPool().connect();
      try {
        await client.query('BEGIN');
        expect(await repo.lockInbound(randomUUID(), client)).toBeNull();
        expect(await repo.lockInbound(c.id, client)).toMatchObject({ credential_id: c.id, app_id: 'app-1' });
        // A second writer on the row blocks until the lock is released.
        let repointed = false;
        const other = repo.repointInbound(c.id, { tokenHash: H2, previousTokenGraceSeconds: 60, ...urls('b') }, admin)
          .then((r) => { repointed = true; return r; });
        await new Promise((r) => setTimeout(r, 150));
        expect(repointed).toBe(false);
        // Disable joined to the locking transaction, then rolled back: nothing changed.
        expect((await repo.disableInbound(c.id, admin, { client })).ok).toBe(true);
        await client.query('ROLLBACK');
        expect(await other).toMatchObject({ app_id: 'app-1', answer_url: urls('b').answerUrl });
      } finally {
        client.release();
      }
    });
  });

  describe('shred hold: a pinned call keeps the secret alive until the post-call webhook window has passed', () => {
    async function revokedWithCall(call: Record<string, unknown>) {
      const cred = await create();
      await insertWebrtcCall({ tenant_id: tenantA, provider: 'plivo', telephony_credential_id: cred.id, ...call });
      await repo.revoke(cred.id, admin);
      return cred;
    }
    const ago = (seconds: number) => new Date(Date.now() - seconds * 1000);

    it('counts every status in WEBRTC_NON_TERMINAL_STATUSES as in flight, and no other', async () => {
      const cred = await create();
      for (const status of ['initiating', 'ringing', 'in_progress', 'completed', 'failed', 'no_answer', 'busy', 'canceled']) {
        await insertWebrtcCall({ tenant_id: tenantA, provider: 'plivo', telephony_credential_id: cred.id, status, ended_at: ago(86400) });
      }
      expect(await repo.usage(cred.id)).toEqual({ campaigns: 0, inFlightCalls: WEBRTC_NON_TERMINAL_STATUSES.length });

      for (const status of WEBRTC_NON_TERMINAL_STATUSES) {
        // Even with an old end timestamp, a live status holds the secret.
        const held = await revokedWithCall({ status, ended_at: ago(86400), updated_at: ago(86400) });
        expect(await repo.shredIfIdle(held.id, HOLD)).toBe(false);
      }
    });

    it('refuses the shred while a pinned call ended inside the hold, and shreds once it ended beyond it', async () => {
      const cred = await create();
      const call = await insertWebrtcCall({
        tenant_id: tenantA, provider: 'plivo', telephony_credential_id: cred.id, status: 'completed',
      });
      await repo.revoke(cred.id, admin);
      await getTestPool().query(`UPDATE agency_calls SET ended_at = NOW() - interval '1 minute' WHERE id = $1`, [call.id]);
      expect(await repo.shredIfIdle(cred.id, HOLD)).toBe(false);
      expect(await repo.findOpenableSecrets(cred.id, 0)).toHaveLength(1);

      // The UPDATE moved updated_at to now: only ended_at decides once it is set.
      await getTestPool().query(`UPDATE agency_calls SET ended_at = NOW() - interval '2 hours 1 minute' WHERE id = $1`, [call.id]);
      expect(await repo.shredIfIdle(cred.id, HOLD)).toBe(true);
      expect(await repo.findOpenableSecrets(cred.id, 1e6)).toEqual([]);
    });

    it('dates a terminal call without ended_at from updated_at: held while recent, shredded once old', async () => {
      const recent = await revokedWithCall({ status: 'failed', ended_at: null });
      expect(await repo.shredIfIdle(recent.id, HOLD)).toBe(false);

      // The updated_at trigger fires on UPDATE only, so an INSERT can backdate it.
      const old = await revokedWithCall({ status: 'failed', ended_at: null, updated_at: ago(HOLD + 60) });
      expect(await repo.shredIfIdle(old.id, HOLD)).toBe(true);
    });

    it('the sweep skips credentials a call still needs, so they cannot starve a later idle one', async () => {
      const inFlight = await revokedWithCall({ status: 'ringing' });
      const recentlyEnded = await revokedWithCall({ status: 'completed', ended_at: ago(60) });
      const idle = await revokedWithCall({ status: 'completed', ended_at: ago(HOLD + 60) });
      const noCalls = await create();
      await repo.revoke(noCalls.id, admin);

      // Oldest revoke first; the two blocked ones were revoked earlier but are not listed.
      expect(await repo.findRevokedUnshredded(HOLD, 1)).toEqual([idle.id]);
      expect(await repo.findRevokedUnshredded(HOLD)).toEqual([idle.id, noCalls.id]);
      for (const id of await repo.findRevokedUnshredded(HOLD)) expect(await repo.shredIfIdle(id, HOLD)).toBe(true);
      expect(await repo.findRevokedUnshredded(HOLD)).toEqual([]);
      expect(await repo.shredIfIdle(inFlight.id, HOLD)).toBe(false);
      expect(await repo.shredIfIdle(recentlyEnded.id, HOLD)).toBe(false);
      // With no hold, only the in-flight one is still held.
      expect(await repo.findRevokedUnshredded(0)).toEqual([recentlyEnded.id]);
    });
  });
});

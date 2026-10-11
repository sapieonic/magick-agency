// TelephonyCredentialService (decisions B18–B22): what each purpose may resolve, that
// nothing falls back, that rotation keeps the old secret openable for webhooks, and that
// no secret value reaches a result, an error or a serialised object. The repository's
// SQL is pinned separately against real Postgres (packages/db integration suite); here
// it is an in-memory stand-in with the same conditional-write semantics.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { inspect } from 'node:util';
import type {
  CreateTelephonyCredentialInput,
  SealedSecretInput,
  TelephonyCredentialRecord,
  TelephonyCredentialSecretRecord,
  TelephonyCredentialStatus,
} from '@magick-agency/db/models/telephony-credential.model';
import { CredentialSealer, EnvKeyringWrapper } from '../../../src/telephony/credentials/credential-sealer.js';
import {
  TelephonyCredentialService, CredentialUnavailableError, type CredentialRepo,
} from '../../../src/telephony/credentials/credential-service.js';
import type { FetchLike } from '../../../src/telephony/credentials/credential-specs.js';
import { WEBHOOK_TOKEN_POST_END_GRACE_SECONDS } from '../../../src/telephony/webhook-grace.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ADMIN = '99999999-9999-4999-8999-999999999999';
const AUTH_ID = 'MAABCDEFGHIJKLMNOPQR';
const CANARY = 'canaryTokenValue0123456789';
const CANARY2 = 'secondCanaryToken9876543210';

class FakeRepo implements CredentialRepo {
  rows = new Map<string, TelephonyCredentialRecord>();
  secrets: TelephonyCredentialSecretRecord[] = [];
  campaigns = new Map<string, number>();
  inFlight = new Map<string, number>();
  /** The post-end holds `shredIfIdle` / `findRevokedUnshredded` were called with. */
  holds: number[] = [];

  async create(i: CreateTelephonyCredentialInput) {
    for (const r of this.rows.values()) {
      if (r.provider === i.provider && r.account_ref === i.account_ref && r.status !== 'revoked') {
        throw Object.assign(new Error('dup'), { code: '23505', constraint: 'uq_telephony_credentials_account' });
      }
    }
    const now = new Date();
    const row: TelephonyCredentialRecord = {
      id: i.id, tenant_id: i.tenant_id, provider: i.provider, label: i.label, status: 'active',
      account_ref: i.account_ref, public_config: i.public_config, secret_version: 1,
      secret_hint: i.sealed.secret_hint, verified_at: i.verified_at, last_error: null,
      created_by: i.created_by, updated_by: i.created_by, created_at: now, updated_at: now,
      revoked_at: null, shredded_at: null,
    };
    this.rows.set(i.id, row);
    this.addSecret(i.id, 1, i.sealed);
    return { ...row };
  }
  private addSecret(id: string, v: number, s: SealedSecretInput) {
    this.secrets.push({ credential_id: id, secret_version: v, secret_ciphertext: s.secret_ciphertext, wrapped_dek: s.wrapped_dek, kek_id: s.kek_id, created_at: new Date(), retired_at: null });
  }
  async findById(id: string) { const r = this.rows.get(id); return r ? { ...r } : null; }
  private openable(id: string, grace: number) {
    const cutoff = Date.now() - grace * 1000;
    return this.secrets.filter((s) => s.credential_id === id && (!s.retired_at || s.retired_at.getTime() > cutoff))
      .sort((a, b) => b.secret_version - a.secret_version);
  }
  async findOpenableSecrets(id: string, grace: number) { return this.openable(id, grace); }
  async findOpenableVersions(id: string, grace: number) {
    return this.openable(id, grace).map((s) => ({ secret_version: s.secret_version, kek_id: s.kek_id }));
  }
  async distinctKekIds() { return [...new Set(this.secrets.map((s) => s.kek_id))]; }
  async list() { return [...this.rows.values()]; }
  async updateLabel(id: string, label: string) {
    const r = this.rows.get(id); if (!r || r.status === 'revoked') return null; r.label = label; return { ...r };
  }
  async rotateSecret(id: string, expected: number, s: SealedSecretInput, o: { verifiedAt: Date | null }) {
    const r = this.rows.get(id);
    if (!r || r.status === 'revoked' || r.secret_version !== expected) return null;
    r.secret_version++; r.secret_hint = s.secret_hint; r.verified_at = o.verifiedAt; r.last_error = null;
    if (r.status === 'invalid') r.status = 'active';
    for (const x of this.secrets) if (x.credential_id === id && !x.retired_at) x.retired_at = new Date();
    this.addSecret(id, r.secret_version, s);
    return { ...r };
  }
  async setStatus(id: string, to: Exclude<TelephonyCredentialStatus, 'revoked'>, from: ReadonlyArray<string>, o: { lastError?: string | null; secretVersion?: number }) {
    const r = this.rows.get(id); if (!r || !from.includes(r.status)) return null;
    if (o.secretVersion !== undefined && r.secret_version !== o.secretVersion) return null;
    r.status = to; if (o.lastError !== undefined) r.last_error = o.lastError; return { ...r };
  }
  async enable(id: string) {
    const r = this.rows.get(id); if (!r || r.status !== 'disabled') return null;
    r.status = r.last_error ? 'invalid' : 'active'; return { ...r };
  }
  async markVerified(id: string, v: number, updatedBy: string | null) {
    const r = this.rows.get(id); if (!r || r.secret_version !== v || r.status === 'revoked') return null;
    r.verified_at = new Date(); r.last_error = null; if (r.status === 'invalid') r.status = 'active';
    if (updatedBy !== null) r.updated_by = updatedBy;
    return { ...r };
  }
  async revoke(id: string) {
    const r = this.rows.get(id); if (!r || r.status === 'revoked' || (this.campaigns.get(id) ?? 0) > 0) return null;
    r.status = 'revoked'; r.revoked_at = new Date(); return { ...r };
  }
  async shredIfIdle(id: string, hold: number) {
    this.holds.push(hold);
    const r = this.rows.get(id);
    if (!r || r.status !== 'revoked' || r.shredded_at || (this.inFlight.get(id) ?? 0) > 0) return false;
    r.shredded_at = new Date(); r.secret_hint = null;
    this.secrets = this.secrets.filter((s) => s.credential_id !== id);
    return true;
  }
  async findRevokedUnshredded(hold: number) { this.holds.push(hold); return [...this.rows.values()].filter((r) => r.status === 'revoked' && !r.shredded_at).map((r) => r.id); }
  async pruneRetiredSecrets(grace: number) {
    const cutoff = Date.now() - grace * 1000; const before = this.secrets.length;
    this.secrets = this.secrets.filter((s) => !s.retired_at || s.retired_at.getTime() > cutoff);
    return before - this.secrets.length;
  }
  async usage(id: string) { return { campaigns: this.campaigns.get(id) ?? 0, inFlightCalls: this.inFlight.get(id) ?? 0 }; }
}

const keyring = `v1:${crypto.randomBytes(32).toString('base64')}`;
let repo: FakeRepo;
let sealer: CredentialSealer;
let carrier: { status: number; calls: Array<{ url: string; init: RequestInit }> };
let svc: TelephonyCredentialService;

const fetchImpl: FetchLike = async (url, init) => {
  carrier.calls.push({ url, init });
  return { status: carrier.status };
};

function service(opts: { sealer?: CredentialSealer | null } = {}) {
  return new TelephonyCredentialService({
    repo, sealer: opts.sealer === undefined ? sealer : opts.sealer, fetchImpl,
    tenants: { findById: async (id) => (id === TENANT ? { id } : null) },
  });
}

async function createOk(token = CANARY) {
  const r = await svc.create({ tenantId: TENANT, provider: 'plivo', label: 'Main', fields: { auth_id: AUTH_ID, auth_token: token }, adminId: ADMIN });
  if (!r.ok) throw new Error(`create failed: ${r.code}`);
  return r.value;
}

beforeEach(() => {
  repo = new FakeRepo();
  sealer = new CredentialSealer(new EnvKeyringWrapper(keyring, 'v1'));
  carrier = { status: 200, calls: [] };
  svc = service();
});

describe('create', () => {
  it('verifies with the carrier, then stores only ciphertext and a four-character hint', async () => {
    const row = await createOk();
    expect(row).toMatchObject({ status: 'active', account_ref: AUTH_ID, secret_hint: '6789', public_config: { auth_id: AUTH_ID } });
    expect(row.verified_at).toBeInstanceOf(Date);
    expect(carrier.calls).toHaveLength(1);
    expect(carrier.calls[0]!.url).toBe(`https://api.plivo.com/v1/Account/${AUTH_ID}/`);
    const stored = repo.secrets[0]!;
    expect(stored.kek_id).toBe('env:v1');
    expect(stored.secret_ciphertext.toString('latin1')).not.toContain(CANARY);
    expect(JSON.stringify(row)).not.toContain(CANARY);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['an unknown field', { auth_id: AUTH_ID, auth_token: CANARY, url: 'https://evil.test' }, 'invalid_input'],
    ['a malformed auth id', { auth_id: 'nope', auth_token: CANARY }, 'invalid_input'],
    ['a malformed token', { auth_id: AUTH_ID, auth_token: `${CANARY}!!` }, 'invalid_input'],
    ['a missing token', { auth_id: AUTH_ID }, 'invalid_input'],
  ])('refuses %s without calling the carrier or echoing a value', async (_l, fields, code) => {
    const r = await svc.create({ tenantId: TENANT, provider: 'plivo', label: 'x', fields, adminId: ADMIN });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe(code);
    expect(JSON.stringify(r)).not.toContain(CANARY);
    expect(JSON.stringify(r)).not.toContain('evil.test');
    expect(carrier.calls).toHaveLength(0);
    expect(repo.rows.size).toBe(0);
  });

  it('refuses a provider with no tenant credentials (the service’s own VoiceLink account)', async () => {
    const r = await svc.create({ tenantId: TENANT, provider: 'voicelink', label: 'x', fields: {}, adminId: ADMIN });
    expect(!r.ok && r.code).toBe('unknown_provider');
  });

  it('refuses an unknown tenant', async () => {
    const r = await svc.create({ tenantId: crypto.randomUUID(), provider: 'plivo', label: 'x', fields: { auth_id: AUTH_ID, auth_token: CANARY }, adminId: ADMIN });
    expect(!r.ok && r.code).toBe('tenant_not_found');
  });

  it.each([[401, 'carrier_rejected'], [404, 'carrier_rejected'], [503, 'carrier_unreachable']])(
    'stores nothing when the carrier answers %i', async (status, code) => {
      carrier.status = status;
      const r = await svc.create({ tenantId: TENANT, provider: 'plivo', label: 'x', fields: { auth_id: AUTH_ID, auth_token: CANARY }, adminId: ADMIN });
      expect(!r.ok && r.code).toBe(code);
      expect(repo.rows.size).toBe(0);
    });

  it('maps a second registration of one carrier account to duplicate_account', async () => {
    await createOk();
    const r = await svc.create({ tenantId: TENANT, provider: 'plivo', label: 'Other', fields: { auth_id: AUTH_ID, auth_token: CANARY2 }, adminId: ADMIN });
    expect(!r.ok && r.code).toBe('duplicate_account');
  });

  it('refuses every write, and fails every resolve closed, with no keyring', async () => {
    const row = await createOk();
    const noStore = service({ sealer: null });
    expect(noStore.storeAvailable).toBe(false);
    const r = await noStore.create({ tenantId: TENANT, provider: 'plivo', label: 'x', fields: { auth_id: AUTH_ID, auth_token: CANARY }, adminId: ADMIN });
    expect(!r.ok && r.code).toBe('credential_store_unavailable');
    await expect(noStore.resolve(row.id, 'call_control')).rejects.toBeInstanceOf(CredentialUnavailableError);
  });
});

describe('resolve', () => {
  it('opens the secret into a box that never prints it', async () => {
    const row = await createOk();
    const resolved = await svc.resolve(row.id, 'dial');
    expect(resolved.secret.reveal()).toEqual({ auth_token: CANARY });
    expect(resolved.accountRef).toBe(AUTH_ID);
    expect(JSON.stringify(resolved)).not.toContain(CANARY);
    expect(inspect(resolved, { depth: 10 })).not.toContain(CANARY);
    expect(`${resolved.secret}`).not.toContain(CANARY);
  });

  it.each<[TelephonyCredentialStatus, boolean, boolean, boolean]>([
    // status, dial, call_control, recording
    ['active', true, true, true],
    ['disabled', false, true, true],
    ['invalid', false, true, true],
    ['revoked', false, true, false],
  ])('a %s credential: dial %s, call_control %s, recording %s', async (status, dial, control, recording) => {
    const row = await createOk();
    repo.rows.get(row.id)!.status = status;
    for (const [purpose, ok] of [['dial', dial], ['call_control', control], ['recording', recording]] as const) {
      const p = svc.resolve(row.id, purpose);
      if (ok) await expect(p).resolves.toBeTruthy();
      else await expect(p).rejects.toBeInstanceOf(CredentialUnavailableError);
    }
  });

  it('reads the status on every call: a disable stops the very next dial', async () => {
    const row = await createOk();
    await svc.resolve(row.id, 'dial');
    await svc.disable(row.id, ADMIN);
    await expect(svc.resolve(row.id, 'dial')).rejects.toBeInstanceOf(CredentialUnavailableError);
  });

  it('cannot resolve a shredded or unknown credential for any purpose', async () => {
    const row = await createOk();
    await svc.revoke(row.id, ADMIN);
    expect(repo.rows.get(row.id)!.shredded_at).not.toBeNull();
    for (const purpose of ['dial', 'call_control', 'recording'] as const) {
      await expect(svc.resolve(row.id, purpose)).rejects.toBeInstanceOf(CredentialUnavailableError);
      await expect(svc.resolve(crypto.randomUUID(), purpose)).rejects.toBeInstanceOf(CredentialUnavailableError);
    }
  });

  it('opens each secret version once and caches it', async () => {
    const row = await createOk();
    const open = vi.spyOn(sealer, 'open');
    await svc.resolve(row.id, 'dial');
    await svc.resolve(row.id, 'dial');
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('fails closed when a stored secret was sealed under a key the keyring no longer holds', async () => {
    const row = await createOk();
    const other = new CredentialSealer(new EnvKeyringWrapper(`v2:${crypto.randomBytes(32).toString('base64')}`, 'v2'));
    const s2 = service({ sealer: other });
    expect(await s2.missingKeyIds()).toEqual(['env:v1']);
    await expect(s2.resolve(row.id, 'dial')).rejects.toThrow(/could not be opened/);
    await expect(s2.resolve(row.id, 'dial')).rejects.toMatchObject({ kind: 'unopenable' });
  });

  it('skips a retired version that will not open, and still serves call control on the current one', async () => {
    const row = await createOk();
    await svc.rotate(row.id, { fields: { auth_token: CANARY2 }, expectedVersion: 1, adminId: ADMIN });
    const v1 = repo.secrets.find((x) => x.secret_version === 1)!;
    v1.secret_ciphertext = Buffer.from(v1.secret_ciphertext.map((b, i) => (i === 0 ? b ^ 0xff : b)));
    const control = await service().resolve(row.id, 'call_control');
    expect(control.version).toBe(2);
    expect(control.secret.reveal()).toEqual({ auth_token: CANARY2 });
    expect(control.previous).toEqual([]);
  });

  it('still fails closed when the current version will not open, whatever the purpose', async () => {
    const row = await createOk();
    await svc.rotate(row.id, { fields: { auth_token: CANARY2 }, expectedVersion: 1, adminId: ADMIN });
    const v2 = repo.secrets.find((x) => x.secret_version === 2)!;
    v2.secret_ciphertext = Buffer.from(v2.secret_ciphertext.map((b, i) => (i === 0 ? b ^ 0xff : b)));
    await expect(service().resolve(row.id, 'call_control')).rejects.toMatchObject({ kind: 'unopenable' });
  });
});

describe('peek', () => {
  it('lists the versions resolve would open, reading and opening no secret', async () => {
    const row = await createOk();
    await svc.rotate(row.id, { fields: { auth_token: CANARY2 }, expectedVersion: 1, adminId: ADMIN });
    const open = vi.spyOn(sealer, 'open');
    const secrets = vi.spyOn(repo, 'findOpenableSecrets');
    expect(await svc.peek(row.id, 'call_control')).toEqual({ id: row.id, tenantId: TENANT, provider: 'plivo', version: 2, versions: [2, 1] });
    expect(await svc.peek(row.id, 'dial')).toEqual({ id: row.id, tenantId: TENANT, provider: 'plivo', version: 2, versions: [2] });
    expect(open).not.toHaveBeenCalled();
    expect(secrets).not.toHaveBeenCalled();
  });

  it.each<[TelephonyCredentialStatus, boolean, boolean, boolean]>([
    ['active', true, true, true],
    ['disabled', false, true, true],
    ['revoked', false, true, false],
  ])('refuses exactly what resolve refuses: a %s credential', async (status, dial, control, recording) => {
    const row = await createOk();
    repo.rows.get(row.id)!.status = status;
    for (const [purpose, ok] of [['dial', dial], ['call_control', control], ['recording', recording]] as const) {
      const p = svc.peek(row.id, purpose);
      if (ok) await expect(p).resolves.toBeTruthy();
      else await expect(p).rejects.toMatchObject({ kind: 'status' });
    }
  });

  it('refuses with no keyring, an unknown id, a shredded credential, and a missing current secret', async () => {
    const row = await createOk();
    await expect(service({ sealer: null }).peek(row.id, 'dial')).rejects.toMatchObject({ kind: 'store_unconfigured' });
    await expect(svc.peek(crypto.randomUUID(), 'dial')).rejects.toMatchObject({ kind: 'not_found' });
    repo.secrets = [];
    await expect(svc.peek(row.id, 'call_control')).rejects.toMatchObject({ kind: 'no_current_secret' });
    repo.rows.get(row.id)!.shredded_at = new Date();
    await expect(svc.peek(row.id, 'call_control')).rejects.toMatchObject({ kind: 'shredded' });
  });
});

describe('rotate', () => {
  it('needs the version the form was opened at, verifies first, and keeps the old secret for call control only', async () => {
    const row = await createOk();
    const stale = await svc.rotate(row.id, { fields: { auth_token: CANARY2 }, expectedVersion: 0, adminId: ADMIN });
    expect(!stale.ok && stale.code).toBe('version_conflict');

    const r = await svc.rotate(row.id, { fields: { auth_token: CANARY2 }, expectedVersion: 1, adminId: ADMIN });
    expect(r.ok && r.value.secret_version).toBe(2);
    expect(carrier.calls.at(-1)!.url).toContain(AUTH_ID);

    const dial = await svc.resolve(row.id, 'dial');
    expect(dial.secret.reveal()).toEqual({ auth_token: CANARY2 });
    expect(dial.previous).toEqual([]);

    const control = await svc.resolve(row.id, 'call_control');
    expect(control.version).toBe(2);
    expect(control.previous.map((p) => [p.version, p.secret.reveal()])).toEqual([[1, { auth_token: CANARY }]]);
  });

  it('rotates only the secret: a public field (another account) is refused', async () => {
    const row = await createOk();
    const r = await svc.rotate(row.id, { fields: { auth_id: 'MAZZZZZZZZZZZZZZZZZZ', auth_token: CANARY2 }, expectedVersion: 1, adminId: ADMIN });
    expect(!r.ok && r.code).toBe('invalid_input');
  });

  it('keeps the old secret when the carrier refuses the new one', async () => {
    const row = await createOk();
    carrier.status = 401;
    const r = await svc.rotate(row.id, { fields: { auth_token: CANARY2 }, expectedVersion: 1, adminId: ADMIN });
    expect(!r.ok && r.code).toBe('carrier_rejected');
    expect((await svc.resolve(row.id, 'dial')).secret.reveal()).toEqual({ auth_token: CANARY });
  });
});

describe('verify, disable, enable, revoke', () => {
  it('marks a credential the carrier now refuses invalid, and a re-accepted one active again', async () => {
    const row = await createOk();
    carrier.status = 401;
    const bad = await svc.verify(row.id, ADMIN);
    expect(bad.ok && bad.value).toMatchObject({ status: 'invalid' });
    expect(bad.ok && bad.value.last_error).toMatch(/401/);
    carrier.status = 200;
    const good = await svc.verify(row.id, ADMIN);
    expect(good.ok && good.value).toMatchObject({ status: 'active', last_error: null });
  });

  it('records a refusal on a disabled credential, which then enables as invalid, not active', async () => {
    const row = await createOk();
    await svc.disable(row.id, ADMIN);
    carrier.status = 401;
    const v = await svc.verify(row.id, ADMIN);
    expect(v.ok && v.value).toMatchObject({ status: 'disabled' });
    expect(v.ok && v.value.last_error).toMatch(/401/);
    const e = await svc.enable(row.id, ADMIN);
    expect(e.ok && e.value.status).toBe('invalid');
    await expect(svc.resolve(row.id, 'dial')).rejects.toBeInstanceOf(CredentialUnavailableError);
  });

  it('enables a disabled credential with no recorded refusal as active', async () => {
    const row = await createOk();
    await svc.disable(row.id, ADMIN);
    const e = await svc.enable(row.id, ADMIN);
    expect(e.ok && e.value.status).toBe('active');
  });

  it('allows only the listed transitions', async () => {
    const row = await createOk();
    expect((await svc.enable(row.id, ADMIN)).ok).toBe(false);
    expect((await svc.disable(row.id, ADMIN)).ok).toBe(true);
    expect((await svc.disable(row.id, ADMIN)).ok).toBe(false);
    expect((await svc.enable(row.id, ADMIN)).ok).toBe(true);
    const missing = await svc.disable(crypto.randomUUID(), ADMIN);
    expect(!missing.ok && missing.code).toBe('not_found');
  });

  it('does not let a carrier refusal of the old secret land on a rotation that committed meanwhile', async () => {
    const row = await createOk();
    // The carrier answers 401 for version 1; before the answer lands, a rotation to
    // version 2 commits (active, no error).
    const raced = new TelephonyCredentialService({
      repo, sealer, tenants: { findById: async (id) => (id === TENANT ? { id } : null) },
      fetchImpl: async () => {
        const r = repo.rows.get(row.id)!;
        r.secret_version = 2; r.status = 'active'; r.last_error = null;
        return { status: 401 };
      },
    });
    const r = await raced.verify(row.id, ADMIN);
    expect(!r.ok && r.code).toBe('version_conflict');
    expect(repo.rows.get(row.id)).toMatchObject({ status: 'active', last_error: null, secret_version: 2 });
  });

  /** A service whose carrier call runs `during` before answering `status`. */
  function racing(status: number, during: () => Promise<void> | void) {
    return new TelephonyCredentialService({
      repo, sealer, tenants: { findById: async (id) => (id === TENANT ? { id } : null) },
      fetchImpl: async (url, init) => { carrier.calls.push({ url, init }); await during(); return { status }; },
    });
  }

  it.each([401, 200])('answers invalid_transition, not success, when a revoke commits while the carrier answers %i', async (status) => {
    const row = await createOk();
    const before = { ...repo.rows.get(row.id)! };
    const r = await racing(status, async () => { await svc.revoke(row.id, ADMIN); }).verify(row.id, ADMIN);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe('invalid_transition');
    expect(repo.rows.get(row.id)).toMatchObject({ status: 'revoked', last_error: null, verified_at: before.verified_at });
  });

  it('answers version_conflict, not success, when a rotation commits while the carrier accepts the old secret', async () => {
    const row = await createOk();
    const r = await racing(200, async () => {
      const rot = await svc.rotate(row.id, { fields: { auth_token: CANARY2 }, expectedVersion: 1, adminId: ADMIN });
      expect(rot.ok).toBe(true);
    }).verify(row.id, ADMIN);
    expect(!r.ok && r.code).toBe('version_conflict');
    expect(repo.rows.get(row.id)!.secret_version).toBe(2);
  });

  it('two overlapping verifies (a 401 lands while a 200 is in flight) end active, with the 200 returning the row it wrote', async () => {
    const row = await createOk();
    const r = await racing(200, async () => {
      carrier.status = 401;
      const refused = await svc.verify(row.id, ADMIN);
      expect(refused.ok && refused.value.status).toBe('invalid');
    }).verify(row.id, ADMIN);
    expect(r.ok && r.value).toMatchObject({ status: 'active', last_error: null });
    expect(repo.rows.get(row.id)).toMatchObject({ status: 'active', last_error: null });
  });

  it('records who verified', async () => {
    const row = await createOk();
    const other = '88888888-8888-4888-8888-888888888888';
    const r = await svc.verify(row.id, other);
    expect(r.ok && r.value.updated_by).toBe(other);
  });

  it('answers secret_unavailable (not a 503) when the current secret is sealed under a key the keyring lacks', async () => {
    const row = await createOk();
    const other = new CredentialSealer(new EnvKeyringWrapper(`v2:${crypto.randomBytes(32).toString('base64')}`, 'v2'));
    const r = await service({ sealer: other }).verify(row.id, ADMIN);
    expect(!r.ok && r.code).toBe('secret_unavailable');
    expect(JSON.stringify(r)).not.toContain('env:v1');
    expect(carrier.calls).toHaveLength(1); // the create's check only
  });

  it('answers secret_unavailable when the current version has no stored secret', async () => {
    const row = await createOk();
    repo.secrets = [];
    const r = await svc.verify(row.id, ADMIN);
    expect(!r.ok && r.code).toBe('secret_unavailable');
  });

  it('answers credential_store_unavailable only when no keyring is configured', async () => {
    const row = await createOk();
    const r = await service({ sealer: null }).verify(row.id, ADMIN);
    expect(!r.ok && r.code).toBe('credential_store_unavailable');
  });

  it('opens only the current secret, not the versions inside the rotation grace', async () => {
    const row = await createOk();
    await svc.rotate(row.id, { fields: { auth_token: CANARY2 }, expectedVersion: 1, adminId: ADMIN });
    const open = vi.spyOn(sealer, 'open');
    const r = await service().verify(row.id, ADMIN);
    expect(r.ok).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]![1]).toMatchObject({ secretVersion: 2 });
  });

  it('refuses a revoke whose campaign was pinned after the usage check', async () => {
    const row = await createOk();
    repo.campaigns.set(row.id, 1);
    const usage = repo.usage.bind(repo);
    let first = true;
    repo.usage = async (id: string) => (first ? ((first = false), { campaigns: 0, inFlightCalls: 0 }) : usage(id));
    const r = await svc.revoke(row.id, ADMIN);
    expect(!r.ok && r.code).toBe('in_use');
    expect(repo.rows.get(row.id)!.status).toBe('active');
  });

  it('refuses to revoke while a campaign dials on it', async () => {
    const row = await createOk();
    repo.campaigns.set(row.id, 2);
    const r = await svc.revoke(row.id, ADMIN);
    expect(!r.ok && r.code).toBe('in_use');
    expect(repo.rows.get(row.id)!.status).toBe('active');
  });

  it('revokes with a live call still hanging up on it, and shreds once the call ends', async () => {
    const row = await createOk();
    repo.inFlight.set(row.id, 1);
    const r = await svc.revoke(row.id, ADMIN);
    expect(r.ok && r.value.shredded).toBe(false);
    await expect(svc.resolve(row.id, 'call_control')).resolves.toBeTruthy();
    await expect(svc.resolve(row.id, 'recording')).rejects.toBeInstanceOf(CredentialUnavailableError);

    repo.inFlight.set(row.id, 0);
    expect(await svc.sweep()).toEqual({ shredded: 1, pruned: 0 });
    // Revoke and the sweep both hold the secrets for the webhook token's post-end life.
    expect(repo.holds.length).toBeGreaterThanOrEqual(3);
    expect(new Set(repo.holds)).toEqual(new Set([WEBHOOK_TOKEN_POST_END_GRACE_SECONDS]));
    expect(repo.secrets.filter((s) => s.credential_id === row.id)).toEqual([]);
    await expect(svc.resolve(row.id, 'call_control')).rejects.toBeInstanceOf(CredentialUnavailableError);
  });
});

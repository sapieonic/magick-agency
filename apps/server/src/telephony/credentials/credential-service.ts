// Per-tenant carrier credentials (decisions B18–B22): the one place that seals, opens,
// verifies and changes them. The super-admin routes call it to manage credentials; the
// telephony registry calls `resolve` to dial on one.
import crypto from 'node:crypto';
import { createChildLogger } from '@magick-agency/observability';
import { isUniqueViolation } from '@magick-agency/db/pg-errors';
import {
  TELEPHONY_CREDENTIAL_ACCOUNT_UNIQUE,
  TELEPHONY_CREDENTIAL_LABEL_UNIQUE,
  type TelephonyCredentialRepository,
} from '@magick-agency/db/repositories/telephony-credential.repository';
import type {
  SealedSecretInput,
  TelephonyCredentialRecord,
  TelephonyCredentialSecretRecord,
} from '@magick-agency/db/models/telephony-credential.model';
import type { TelephonyCredentialErrorCode } from '@magick-agency/contracts/api/platform/super-admin-telephony-credentials';
import { CredentialSealer, CredentialSealError, type SealContext } from './credential-sealer.js';
import { findCredentialSpec, type CredentialSpec, type FetchLike } from './credential-specs.js';
import { Secret, secretHint } from './secret.js';
import { safeIssues } from './safe-issues.js';
import type { ZodIssue } from 'zod';

const log = createChildLogger({ component: 'telephony-credentials' });

/**
 * How long a secret version superseded by a rotation stays openable. The carrier may
 * still sign webhooks for calls placed before the rotation with the old secret: a
 * call can run for hours, and its webhook token lives 2 h past its end (Q6).
 */
export const ROTATION_GRACE_SECONDS = 24 * 60 * 60;

/** How many opened secrets the process keeps. Keyed by credential, version and key id. */
const OPEN_CACHE_MAX = 256;

export type CredentialRepo = Pick<TelephonyCredentialRepository,
  | 'create' | 'findById' | 'findOpenableSecrets' | 'list' | 'updateLabel' | 'rotateSecret'
  | 'setStatus' | 'markVerified' | 'revoke' | 'shredIfIdle' | 'usage' | 'distinctKekIds'
  | 'findRevokedUnshredded' | 'pruneRetiredSecrets'>;

export interface TenantLookup {
  findById(id: string): Promise<{ id: string } | null>;
}

export type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: TelephonyCredentialErrorCode; message: string; details?: Array<{ path: string; message: string }> };

const fail = (code: TelephonyCredentialErrorCode, message: string, details?: Array<{ path: string; message: string }>): ServiceResult<never> =>
  ({ ok: false, code, message, ...(details ? { details } : {}) });

/**
 * Why a credential is being resolved, which decides which statuses may serve it.
 *
 *  - `dial`: placing a NEW call. Only an `active` credential dials.
 *  - `call_control`: hangup, cancel and webhook verification for a call already
 *    placed on it. Anything not yet shredded still serves, so disabling or revoking a
 *    credential never strands a live call or leaves a customer's phone ringing. The
 *    versions a rotation retired inside the grace window come along too.
 *  - `recording`: fetching an earlier call's recording. Revoking ends it (B21).
 */
export type ResolvePurpose = 'dial' | 'call_control' | 'recording';

export interface ResolvedCredential {
  id: string;
  tenantId: string;
  provider: string;
  accountRef: string;
  publicConfig: Record<string, unknown>;
  version: number;
  secret: Secret<Record<string, string>>;
  /** Older versions still inside the rotation grace window (`call_control` only), newest first. */
  previous: Array<{ version: number; secret: Secret<Record<string, string>> }>;
}

/** Thrown by `resolve` when a credential cannot serve the purpose. Carries no secret. */
export class CredentialUnavailableError extends Error {
  constructor(readonly credentialId: string, readonly reason: string) {
    super(`Telephony credential ${credentialId} is unavailable: ${reason}`);
    this.name = 'CredentialUnavailableError';
  }
}

/** Zod issues with no submitted value in the path or message (see `safeIssues`). */
function issues(err: { issues: ZodIssue[] }, prefix: string) {
  return safeIssues(err.issues, prefix);
}

function splitFields(spec: CredentialSpec, fields: Record<string, unknown>) {
  const pub: Record<string, unknown> = {};
  const sec: Record<string, unknown> = {};
  const known = new Map(spec.fields.map((f) => [f.key, f.secret]));
  const unknown: string[] = [];
  for (const [k, v] of Object.entries(fields ?? {})) {
    if (!known.has(k)) unknown.push(k);
    else if (known.get(k)) sec[k] = v;
    else pub[k] = v;
  }
  return { pub, sec, unknown };
}

export class TelephonyCredentialService {
  private readonly opened = new Map<string, Secret<Record<string, string>>>();

  constructor(private readonly deps: {
    repo: CredentialRepo;
    tenants: TenantLookup;
    /** Null when no keyring is configured: every write is refused, every resolve fails closed. */
    sealer: CredentialSealer | null;
    fetchImpl?: FetchLike;
  }) {}

  get storeAvailable(): boolean {
    return this.deps.sealer !== null;
  }

  // ── Management (super-admin) ──────────────────────────────────────────────

  async create(input: {
    tenantId: string; provider: string; label: string; fields: Record<string, unknown>; adminId: string;
  }): Promise<ServiceResult<TelephonyCredentialRecord>> {
    const sealer = this.deps.sealer;
    if (!sealer) return fail('credential_store_unavailable', 'No credential keyring is configured');
    const spec = findCredentialSpec(input.provider);
    if (!spec) return fail('unknown_provider', `Provider '${input.provider}' does not accept tenant credentials`);

    const { pub, sec, unknown } = splitFields(spec, input.fields);
    if (unknown.length) return fail('invalid_input', 'Unknown credential fields', unknown.map((k) => ({ path: `fields.${k}`, message: 'Unknown field' })));
    const pubParsed = spec.publicSchema.safeParse(pub);
    const secParsed = spec.secretSchema.safeParse(sec);
    if (!pubParsed.success || !secParsed.success) {
      return fail('invalid_input', 'Invalid credential fields', [
        ...(pubParsed.success ? [] : issues(pubParsed.error, 'fields')),
        ...(secParsed.success ? [] : issues(secParsed.error, 'fields')),
      ]);
    }
    if (!(await this.deps.tenants.findById(input.tenantId))) return fail('tenant_not_found', 'Tenant not found');

    const check = await spec.check(pubParsed.data, secParsed.data, this.deps.fetchImpl);
    if (check.result === 'rejected') return fail('carrier_rejected', check.reason);
    if (check.result === 'unreachable') return fail('carrier_unreachable', check.reason);

    const id = crypto.randomUUID();
    const sealed = await this.sealFor(spec, secParsed.data, { tenantId: input.tenantId, credentialId: id, provider: spec.provider, secretVersion: 1 });
    try {
      const row = await this.deps.repo.create({
        id, tenant_id: input.tenantId, provider: spec.provider, label: input.label,
        account_ref: spec.accountRef(pubParsed.data), public_config: pubParsed.data,
        sealed, created_by: input.adminId, verified_at: new Date(),
      });
      return { ok: true, value: row };
    } catch (err) {
      if (isUniqueViolation(err, TELEPHONY_CREDENTIAL_ACCOUNT_UNIQUE)) {
        return fail('duplicate_account', 'This carrier account is already registered');
      }
      if (isUniqueViolation(err, TELEPHONY_CREDENTIAL_LABEL_UNIQUE)) {
        return fail('duplicate_label', 'This tenant already has a credential with that label');
      }
      throw err;
    }
  }

  async rename(id: string, label: string, adminId: string): Promise<ServiceResult<TelephonyCredentialRecord>> {
    try {
      const row = await this.deps.repo.updateLabel(id, label, adminId);
      return row ? { ok: true, value: row } : this.missingOrRevoked(id);
    } catch (err) {
      if (isUniqueViolation(err, TELEPHONY_CREDENTIAL_LABEL_UNIQUE)) {
        return fail('duplicate_label', 'This tenant already has a credential with that label');
      }
      throw err;
    }
  }

  /**
   * Replace the secret. The carrier must accept the new one first; the account id
   * cannot change (a different account is a different credential).
   */
  async rotate(id: string, input: { fields: Record<string, unknown>; expectedVersion: number; adminId: string }): Promise<ServiceResult<TelephonyCredentialRecord>> {
    const sealer = this.deps.sealer;
    if (!sealer) return fail('credential_store_unavailable', 'No credential keyring is configured');
    const current = await this.deps.repo.findById(id);
    if (!current) return fail('not_found', 'Credential not found');
    if (current.status === 'revoked') return fail('invalid_transition', 'A revoked credential cannot be changed');
    const spec = findCredentialSpec(current.provider);
    if (!spec) return fail('unknown_provider', `Provider '${current.provider}' does not accept tenant credentials`);

    const { pub, sec, unknown } = splitFields(spec, input.fields);
    const stray = [...unknown, ...Object.keys(pub)];
    if (stray.length) return fail('invalid_input', 'Only the secret fields can be rotated', stray.map((k) => ({ path: `fields.${k}`, message: 'Not a secret field' })));
    const secParsed = spec.secretSchema.safeParse(sec);
    if (!secParsed.success) return fail('invalid_input', 'Invalid credential fields', issues(secParsed.error, 'fields'));
    if (current.secret_version !== input.expectedVersion) {
      return fail('version_conflict', 'The credential was changed since this form was opened');
    }

    const check = await spec.check(current.public_config as Record<string, string>, secParsed.data, this.deps.fetchImpl);
    if (check.result === 'rejected') return fail('carrier_rejected', check.reason);
    if (check.result === 'unreachable') return fail('carrier_unreachable', check.reason);

    const sealed = await this.sealFor(spec, secParsed.data, {
      tenantId: current.tenant_id, credentialId: id, provider: current.provider, secretVersion: input.expectedVersion + 1,
    });
    const row = await this.deps.repo.rotateSecret(id, input.expectedVersion, sealed, { updatedBy: input.adminId, verifiedAt: new Date() });
    return row ? { ok: true, value: row } : fail('version_conflict', 'The credential was changed since this form was opened');
  }

  /**
   * Re-ask the carrier with the stored secret. A refusal marks an active credential
   * `invalid`; a disabled one stays disabled but records the refusal in `last_error`,
   * so `enable` brings it back as `invalid`, not `active`. Success clears both.
   */
  async verify(id: string, adminId: string | null): Promise<ServiceResult<TelephonyCredentialRecord>> {
    const current = await this.deps.repo.findById(id);
    if (!current) return fail('not_found', 'Credential not found');
    if (current.status === 'revoked') return fail('invalid_transition', 'A revoked credential cannot be verified');
    const spec = findCredentialSpec(current.provider);
    if (!spec) return fail('unknown_provider', `Provider '${current.provider}' does not accept tenant credentials`);
    let resolved: ResolvedCredential;
    try {
      resolved = await this.resolve(id, 'call_control');
    } catch (err) {
      if (err instanceof CredentialUnavailableError) return fail('credential_store_unavailable', err.reason);
      throw err;
    }
    const check = await spec.check(current.public_config as Record<string, string>, resolved.secret.reveal(), this.deps.fetchImpl);
    if (check.result === 'unreachable') return fail('carrier_unreachable', check.reason);
    if (check.result === 'rejected') {
      const row = await this.deps.repo.setStatus(id, 'invalid', ['active', 'invalid'], { updatedBy: adminId, lastError: check.reason })
        ?? await this.deps.repo.setStatus(id, 'disabled', ['disabled'], { updatedBy: adminId, lastError: check.reason });
      return { ok: true, value: row ?? (await this.deps.repo.findById(id))! };
    }
    if (current.status === 'invalid') {
      await this.deps.repo.setStatus(id, 'active', ['invalid'], { updatedBy: adminId, lastError: null });
    }
    const row = await this.deps.repo.markVerified(id, resolved.version);
    return { ok: true, value: row ?? (await this.deps.repo.findById(id))! };
  }

  async disable(id: string, adminId: string): Promise<ServiceResult<TelephonyCredentialRecord>> {
    const row = await this.deps.repo.setStatus(id, 'disabled', ['active', 'invalid'], { updatedBy: adminId });
    return row ? { ok: true, value: row } : this.transitionRefused(id, 'Only an active or invalid credential can be disabled');
  }

  /**
   * Re-enable a disabled credential. It returns as `active`, or as `invalid` when the
   * carrier's last check refused it (`last_error` is set only by a refusal and cleared
   * by a passing verify or a rotation).
   */
  async enable(id: string, adminId: string): Promise<ServiceResult<TelephonyCredentialRecord>> {
    const current = await this.deps.repo.findById(id);
    if (!current) return fail('not_found', 'Credential not found');
    const to = current.last_error ? 'invalid' : 'active';
    const row = await this.deps.repo.setStatus(id, to, ['disabled'], { updatedBy: adminId });
    return row ? { ok: true, value: row } : this.transitionRefused(id, 'Only a disabled credential can be enabled');
  }

  /**
   * Revoke (terminal). Refused while a campaign is pinned to it: move the campaigns
   * first. Calls already in flight keep hanging up on it; the secrets are shredded as
   * soon as none is left (here, or by the sweep).
   */
  async revoke(id: string, adminId: string): Promise<ServiceResult<{ credential: TelephonyCredentialRecord; shredded: boolean }>> {
    const current = await this.deps.repo.findById(id);
    if (!current) return fail('not_found', 'Credential not found');
    if (current.status === 'revoked') return fail('invalid_transition', 'The credential is already revoked');
    const usage = await this.deps.repo.usage(id);
    if (usage.campaigns > 0) {
      return fail('in_use', `${usage.campaigns} campaign(s) still dial on this credential; move them to another first`);
    }
    const row = await this.deps.repo.revoke(id, adminId);
    if (!row) return this.transitionRefused(id, 'The credential is already revoked');
    this.forget(id);
    const shredded = await this.deps.repo.shredIfIdle(id);
    return { ok: true, value: { credential: shredded ? (await this.deps.repo.findById(id))! : row, shredded } };
  }

  async get(id: string): Promise<TelephonyCredentialRecord | null> {
    return this.deps.repo.findById(id);
  }

  async usage(id: string) {
    return this.deps.repo.usage(id);
  }

  async list(filters: { tenantId?: string; provider?: string; includeRevoked?: boolean }) {
    return this.deps.repo.list(filters);
  }

  // ── Resolution (the telephony registry) ───────────────────────────────────

  /**
   * Open a credential for a purpose (see {@link ResolvePurpose}). The row is read on
   * every call, so a disable or revoke takes effect on the very next dial; only the
   * opened secret is cached, keyed by credential, version and master key id.
   *
   * @throws CredentialUnavailableError — never falls back to another account.
   */
  async resolve(id: string, purpose: ResolvePurpose): Promise<ResolvedCredential> {
    const sealer = this.deps.sealer;
    if (!sealer) throw new CredentialUnavailableError(id, 'no credential keyring is configured');
    const row = await this.deps.repo.findById(id);
    if (!row) throw new CredentialUnavailableError(id, 'not found');
    if (row.shredded_at) throw new CredentialUnavailableError(id, 'shredded');
    if (purpose === 'dial' && row.status !== 'active') throw new CredentialUnavailableError(id, `status ${row.status}`);
    if (purpose === 'recording' && row.status === 'revoked') throw new CredentialUnavailableError(id, 'revoked');

    const versions = await this.deps.repo.findOpenableSecrets(id, ROTATION_GRACE_SECONDS);
    const current = versions.find((v) => v.secret_version === row.secret_version);
    if (!current) throw new CredentialUnavailableError(id, 'no current secret');
    const secret = await this.open(row, current);
    const previous = purpose === 'call_control'
      ? await Promise.all(versions
        .filter((v) => v.secret_version < row.secret_version)
        .map(async (v) => ({ version: v.secret_version, secret: await this.open(row, v) })))
      : [];
    return {
      id: row.id, tenantId: row.tenant_id, provider: row.provider, accountRef: row.account_ref,
      publicConfig: row.public_config, version: row.secret_version, secret, previous,
    };
  }

  // ── Housekeeping (voice bootstrap) ────────────────────────────────────────

  /** Master key ids stored secrets need that the keyring does not hold. Empty = healthy. */
  async missingKeyIds(): Promise<string[]> {
    const ids = await this.deps.repo.distinctKekIds();
    const sealer = this.deps.sealer;
    return sealer ? ids.filter((k) => !sealer.canUnwrap(k)) : ids;
  }

  /** Shred revoked credentials whose calls have ended, and drop secrets past the rotation grace. */
  async sweep(): Promise<{ shredded: number; pruned: number }> {
    let shredded = 0;
    for (const id of await this.deps.repo.findRevokedUnshredded()) {
      if (await this.deps.repo.shredIfIdle(id)) {
        shredded++;
        this.forget(id);
      }
    }
    const pruned = await this.deps.repo.pruneRetiredSecrets(ROTATION_GRACE_SECONDS);
    if (pruned > 0) this.opened.clear();
    return { shredded, pruned };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async sealFor(spec: CredentialSpec, secret: Record<string, string>, ctx: SealContext): Promise<SealedSecretInput> {
    const sealed = await this.deps.sealer!.seal(secret, ctx);
    return {
      secret_ciphertext: sealed.ciphertext,
      wrapped_dek: sealed.wrappedDek,
      kek_id: sealed.kekId,
      secret_hint: secretHint(spec.hintSource(secret)),
    };
  }

  private async open(row: TelephonyCredentialRecord, v: TelephonyCredentialSecretRecord): Promise<Secret<Record<string, string>>> {
    const key = `${row.id}:${v.secret_version}:${v.kek_id}`;
    const hit = this.opened.get(key);
    if (hit) return hit;
    try {
      const plain = await this.deps.sealer!.open(
        { kekId: v.kek_id, wrappedDek: v.wrapped_dek, ciphertext: v.secret_ciphertext },
        { tenantId: row.tenant_id, credentialId: row.id, provider: row.provider, secretVersion: v.secret_version },
      );
      const secret = new Secret(plain as Record<string, string>);
      if (this.opened.size >= OPEN_CACHE_MAX) this.opened.delete(this.opened.keys().next().value!);
      this.opened.set(key, secret);
      return secret;
    } catch (err) {
      if (err instanceof CredentialSealError) {
        log.error({ credentialId: row.id, secretVersion: v.secret_version, kekId: v.kek_id }, 'Telephony credential secret could not be opened');
        throw new CredentialUnavailableError(row.id, 'secret could not be opened');
      }
      throw err;
    }
  }

  private forget(id: string): void {
    for (const key of [...this.opened.keys()]) if (key.startsWith(`${id}:`)) this.opened.delete(key);
  }

  private async missingOrRevoked(id: string): Promise<ServiceResult<never>> {
    const row = await this.deps.repo.findById(id);
    return row ? fail('invalid_transition', 'A revoked credential cannot be changed') : fail('not_found', 'Credential not found');
  }

  private async transitionRefused(id: string, message: string): Promise<ServiceResult<never>> {
    const row = await this.deps.repo.findById(id);
    return row ? fail('invalid_transition', message) : fail('not_found', 'Credential not found');
  }
}

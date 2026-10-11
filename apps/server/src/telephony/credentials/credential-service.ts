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
import { WEBHOOK_TOKEN_POST_END_GRACE_SECONDS } from '../webhook-grace.js';
import type { ZodIssue } from 'zod';

const log = createChildLogger({ component: 'telephony-credentials' });

/**
 * How long a secret version superseded by a rotation stays openable. The carrier may
 * still sign webhooks for calls placed before the rotation with the old secret: a
 * call can run for hours, and its webhook token lives 2 h past its end (Q6).
 */
export const ROTATION_GRACE_SECONDS = 24 * 60 * 60;

/** How many opened secrets the process keeps. Keyed by seal context and key id (see `open`). */
const OPEN_CACHE_MAX = 256;

export type CredentialRepo = Pick<TelephonyCredentialRepository,
  | 'create' | 'findById' | 'findOpenableSecrets' | 'findOpenableVersions' | 'list' | 'updateLabel' | 'rotateSecret'
  | 'setStatus' | 'enable' | 'markVerified' | 'revoke' | 'shredIfIdle' | 'usage' | 'distinctKekIds'
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

/**
 * What `peek` returns: the row's identity and the secret versions `resolve` would open
 * for the purpose (current first, then any still inside the rotation grace for
 * `call_control`), with nothing opened.
 */
export interface CredentialPeek {
  id: string;
  tenantId: string;
  provider: string;
  version: number;
  versions: number[];
}

/**
 * Why a credential cannot serve:
 *  - `store_unconfigured`: no keyring on this server (the only store-wide cause);
 *  - `not_found`, `shredded`, `status` (the status does not serve the purpose);
 *  - `no_current_secret`: the row's current version has no stored secret;
 *  - `unopenable`: the current secret failed to open (its master key is missing from
 *    the keyring, or its sealed context does not match the row).
 */
export type CredentialUnavailableKind =
  | 'store_unconfigured' | 'not_found' | 'shredded' | 'status' | 'no_current_secret' | 'unopenable';

/** Thrown by `resolve` and `peek` when a credential cannot serve the purpose. Carries no secret. */
export class CredentialUnavailableError extends Error {
  constructor(readonly credentialId: string, readonly kind: CredentialUnavailableKind, readonly reason: string) {
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
    // Fixed text: the submitted value is never echoed (it may be a misplaced secret).
    if (!spec) return fail('unknown_provider', 'This provider does not accept tenant credentials');

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
   *
   * Every write is pinned to the version that was checked, so a rotation that commits
   * while the carrier answers never inherits the old secret's verdict, and the success
   * transition is one statement, decided on the row as it is then, not as it was read
   * before the carrier call. A write that does not land is a refusal, never a success.
   */
  async verify(id: string, adminId: string | null): Promise<ServiceResult<TelephonyCredentialRecord>> {
    const current = await this.deps.repo.findById(id);
    if (!current) return fail('not_found', 'Credential not found');
    if (current.status === 'revoked') return fail('invalid_transition', 'A revoked credential cannot be verified');
    const spec = findCredentialSpec(current.provider);
    if (!spec) return fail('unknown_provider', `Provider '${current.provider}' does not accept tenant credentials`);
    let opened: { row: TelephonyCredentialRecord; secret: Secret<Record<string, string>> };
    try {
      // Only the current version: the verdict is about the secret new calls use.
      opened = await this.openCurrent(id, 'call_control');
    } catch (err) {
      if (err instanceof CredentialUnavailableError) return this.unavailable(err);
      throw err;
    }
    const { row, secret } = opened;
    if (row.status === 'revoked') return fail('invalid_transition', 'A revoked credential cannot be verified');
    const check = await spec.check(row.public_config as Record<string, string>, secret.reveal(), this.deps.fetchImpl);
    if (check.result === 'unreachable') return fail('carrier_unreachable', check.reason);
    const secretVersion = row.secret_version;
    const written = check.result === 'rejected'
      ? await this.deps.repo.setStatus(id, 'invalid', ['active', 'invalid'], { updatedBy: adminId, lastError: check.reason, secretVersion })
        ?? await this.deps.repo.setStatus(id, 'disabled', ['disabled'], { updatedBy: adminId, lastError: check.reason, secretVersion })
      : await this.deps.repo.markVerified(id, secretVersion, adminId);
    return written ? { ok: true, value: written } : this.verdictLost(id, secretVersion);
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
    const row = await this.deps.repo.enable(id, adminId);
    return row ? { ok: true, value: row } : this.transitionRefused(id, 'Only a disabled credential can be enabled');
  }

  /**
   * Revoke (terminal). Refused while a live campaign is pinned to it (checked again
   * in the revoking statement, under a row lock): move the campaigns first. Calls
   * already placed keep hanging up and checking webhooks on it; the secrets are
   * shredded once none is in flight and the last ended more than the post-call
   * webhook window ago (`WEBHOOK_TOKEN_POST_END_GRACE_SECONDS`), here or by the sweep.
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
    if (!row) {
      // Pinned between the check above and the revoke, or revoked concurrently.
      const raced = await this.deps.repo.usage(id);
      if (raced.campaigns > 0) {
        return fail('in_use', `${raced.campaigns} campaign(s) still dial on this credential; move them to another first`);
      }
      return this.transitionRefused(id, 'The credential is already revoked');
    }
    this.forget(id);
    const shredded = await this.deps.repo.shredIfIdle(id, WEBHOOK_TOKEN_POST_END_GRACE_SECONDS);
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
   * opened secret is cached, keyed by the whole seal context (credential, tenant,
   * provider, version) and the master key id, so a row whose tenant or provider was
   * changed in SQL is opened afresh (and fails its AAD check), never served from cache.
   *
   * The current version must open. The older grace versions (`call_control` only) are
   * best effort: one that fails to open is logged and left out, so it cannot take
   * hangups and webhook checks for the whole credential down with it.
   *
   * @throws CredentialUnavailableError — never falls back to another account.
   */
  async resolve(id: string, purpose: ResolvePurpose): Promise<ResolvedCredential> {
    const { row, secret, secrets } = await this.openCurrent(id, purpose);
    const previous: ResolvedCredential['previous'] = [];
    if (purpose === 'call_control') {
      for (const v of secrets.filter((x) => x.secret_version < row.secret_version).sort((a, b) => b.secret_version - a.secret_version)) {
        try {
          previous.push({ version: v.secret_version, secret: await this.open(row, v) });
        } catch (err) {
          // `open` has logged the ids; the version is skipped, the current one still serves.
          if (!(err instanceof CredentialUnavailableError)) throw err;
          log.warn({ credentialId: row.id, secretVersion: v.secret_version }, 'Skipping a retired telephony credential secret that could not be opened');
        }
      }
    }
    return {
      id: row.id, tenantId: row.tenant_id, provider: row.provider, accountRef: row.account_ref,
      publicConfig: row.public_config, version: row.secret_version, secret, previous,
    };
  }

  /**
   * The checks `resolve` makes for a purpose, opening nothing and reading no
   * ciphertext: the registry calls it on every lookup and calls `resolve` only when it
   * has no adapter for these versions. `versions` lists every version inside the grace
   * (`call_control`), including one `resolve` would skip as unopenable, so a skipped
   * version does not turn every lookup into a rebuild.
   *
   * @throws CredentialUnavailableError, for exactly the causes `resolve` throws it
   *   short of opening (an unopenable current secret surfaces only from `resolve`).
   */
  async peek(id: string, purpose: ResolvePurpose): Promise<CredentialPeek> {
    const row = await this.admit(id, purpose);
    let versions = [row.secret_version];
    if (purpose === 'call_control') {
      const open = (await this.deps.repo.findOpenableVersions(id, ROTATION_GRACE_SECONDS)).map((v) => v.secret_version);
      if (!open.includes(row.secret_version)) throw new CredentialUnavailableError(id, 'no_current_secret', 'no current secret');
      versions = open.sort((a, b) => b - a);
    }
    return { id: row.id, tenantId: row.tenant_id, provider: row.provider, version: row.secret_version, versions };
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
    for (const id of await this.deps.repo.findRevokedUnshredded(WEBHOOK_TOKEN_POST_END_GRACE_SECONDS)) {
      if (await this.deps.repo.shredIfIdle(id, WEBHOOK_TOKEN_POST_END_GRACE_SECONDS)) {
        shredded++;
        this.forget(id);
      }
    }
    const pruned = await this.deps.repo.pruneRetiredSecrets(ROTATION_GRACE_SECONDS);
    if (pruned > 0) this.opened.clear();
    return { shredded, pruned };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** Read the row and refuse it if it cannot serve the purpose. Opens nothing. */
  private async admit(id: string, purpose: ResolvePurpose): Promise<TelephonyCredentialRecord> {
    if (!this.deps.sealer) throw new CredentialUnavailableError(id, 'store_unconfigured', 'no credential keyring is configured');
    const row = await this.deps.repo.findById(id);
    if (!row) throw new CredentialUnavailableError(id, 'not_found', 'not found');
    if (row.shredded_at) throw new CredentialUnavailableError(id, 'shredded', 'shredded');
    if (purpose === 'dial' && row.status !== 'active') throw new CredentialUnavailableError(id, 'status', `status ${row.status}`);
    if (purpose === 'recording' && row.status === 'revoked') throw new CredentialUnavailableError(id, 'status', 'revoked');
    return row;
  }

  /** `admit`, then open the current version only. The secrets read are returned for `resolve`. */
  private async openCurrent(id: string, purpose: ResolvePurpose): Promise<{
    row: TelephonyCredentialRecord; secret: Secret<Record<string, string>>; secrets: TelephonyCredentialSecretRecord[];
  }> {
    const row = await this.admit(id, purpose);
    const secrets = await this.deps.repo.findOpenableSecrets(id, ROTATION_GRACE_SECONDS);
    const current = secrets.find((v) => v.secret_version === row.secret_version);
    if (!current) throw new CredentialUnavailableError(id, 'no_current_secret', 'no current secret');
    return { row, secret: await this.open(row, current), secrets };
  }

  /** A credential that cannot be opened, as a route answer. Only a missing keyring is a 503. */
  private unavailable(err: CredentialUnavailableError): ServiceResult<never> {
    switch (err.kind) {
      case 'store_unconfigured': return fail('credential_store_unavailable', 'No credential keyring is configured');
      case 'not_found': return fail('not_found', 'Credential not found');
      case 'status': return fail('invalid_transition', 'The credential cannot be used in its current status');
      case 'shredded': return fail('secret_unavailable', 'The credential’s secrets have been shredded');
      case 'no_current_secret': return fail('secret_unavailable', 'The credential has no stored current secret; rotate it');
      case 'unopenable': return fail('secret_unavailable', 'The stored secret cannot be opened with this server’s keyring; restore its master key or rotate the secret');
    }
  }

  /** A verify whose version-pinned write matched no row: say why, on a fresh read. */
  private async verdictLost(id: string, checkedVersion: number): Promise<ServiceResult<never>> {
    const row = await this.deps.repo.findById(id);
    if (!row) return fail('not_found', 'Credential not found');
    if (row.status === 'revoked') return fail('invalid_transition', 'The credential was revoked while the carrier was answering');
    if (row.secret_version !== checkedVersion) {
      return fail('version_conflict', 'The secret was rotated while the carrier was answering; verify again');
    }
    // Same version, but its status moved between the two status-pinned writes.
    return fail('version_conflict', 'The credential changed while the carrier was answering; verify again');
  }

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
    const key = `${row.id}:${row.tenant_id}:${row.provider}:${v.secret_version}:${v.kek_id}`;
    const hit = this.opened.get(key);
    if (hit) return hit;
    try {
      const plain = await this.deps.sealer!.open(
        { kekId: v.kek_id, wrappedDek: v.wrapped_dek, ciphertext: v.secret_ciphertext },
        { tenantId: row.tenant_id, credentialId: row.id, provider: row.provider, secretVersion: v.secret_version },
      );
      // Frozen: every caller shares this cached object, so none may change it.
      const secret = new Secret(Object.freeze(plain as Record<string, string>));
      if (this.opened.size >= OPEN_CACHE_MAX) this.opened.delete(this.opened.keys().next().value!);
      this.opened.set(key, secret);
      return secret;
    } catch (err) {
      if (err instanceof CredentialSealError) {
        log.error({ credentialId: row.id, secretVersion: v.secret_version, kekId: v.kek_id }, 'Telephony credential secret could not be opened');
        throw new CredentialUnavailableError(row.id, 'unopenable', 'secret could not be opened');
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

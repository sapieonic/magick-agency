import type { PoolClient } from 'pg';
import { getPool } from '../connection.js';
import { WEBRTC_NON_TERMINAL_STATUSES } from '../models/agency-call.model.js';
import { LIVE_CAMPAIGN } from './live-campaign.js';
import type {
  CreateTelephonyCredentialInput,
  EnableTelephonyCredentialInboundInput,
  RepointTelephonyCredentialInboundInput,
  SealedSecretInput,
  TelephonyCredentialInboundRecord,
  TelephonyCredentialRecord,
  TelephonyCredentialSecretRecord,
  TelephonyCredentialStatus,
} from '../models/telephony-credential.model.js';

/*
 * Per-tenant carrier credentials (0002_telephony_credentials.sql, decisions B18–B22).
 *
 *  - Credential rows carry no secret material, so every listing is safe to send.
 *    The sealed secrets live in `telephony_credential_secrets`, one row per version,
 *    and only `findOpenableSecrets` (the server's resolver) reads them;
 *    `findOpenableVersions` lists the same set without the ciphertext.
 *  - Only ciphertext and the four-character `secret_hint` reach SQL, so a full
 *    plaintext secret is never a query parameter. pg spans no longer carry parameter
 *    values (decision "pg span parameters", changed 2026-10-16), but the rule stands:
 *    it does not depend on how the tracer is configured.
 *  - Writes are conditional (`WHERE status …`, `WHERE secret_version = $n`), so a
 *    concurrent change makes the second writer a no-op (null), never a lost update.
 *  - No Redis cache: a credential's status must take effect on the next read.
 *  - A revoked credential is shredded only once no pinned call can still need it:
 *    every pinned call is terminal and ended longer ago than the post-call webhook
 *    window (`callStillNeedsCredential`, shared by the shred and its sweep).
 */

/** The unique indexes a create can trip, by name (`isUniqueViolation`). */
export const TELEPHONY_CREDENTIAL_ACCOUNT_UNIQUE = 'uq_telephony_credentials_account';
export const TELEPHONY_CREDENTIAL_LABEL_UNIQUE = 'uq_telephony_credentials_label';

const COLUMNS = `
  id, tenant_id, provider, label, status, account_ref, public_config,
  secret_version, secret_hint, verified_at, last_error,
  created_by, updated_by, created_at, updated_at, revoked_at, shredded_at`;

/** The inbound state's columns (`TelephonyCredentialInboundRecord`); `c` is the credential. */
const INBOUND_COLUMNS = `
  c.id AS credential_id, c.tenant_id, c.provider, c.status,
  c.inbound_app_id AS app_id, c.inbound_answer_url AS answer_url, c.inbound_hangup_url AS hangup_url,
  c.inbound_fallback_answer_url AS fallback_answer_url, c.inbound_enabled_at AS enabled_at,
  c.inbound_previous_token_expires_at AS previous_token_expires_at,
  (SELECT count(*)::int FROM phone_numbers pn
    WHERE pn.telephony_credential_id = c.id AND pn.inbound_linked_at IS NOT NULL) AS linked_numbers`;

/**
 * Call statuses that are still live (hangup, cancel, webhook checks need the
 * credential). Bound as a `varchar[]` parameter, so it cannot drift from the calls
 * model.
 */
const IN_FLIGHT: readonly string[] = WEBRTC_NON_TERMINAL_STATUSES;

/**
 * SQL: a call pinned to credential `cred` may still need its secret. That is a call
 * still in flight (`statuses`, bound to IN_FLIGHT), or a terminal call that ended
 * less than `holdSecs` ago: the carrier's terminal-webhook retries and the recording
 * callback arrive after the row is finalized and are checked with this secret for as
 * long as the call's webhook token lives.
 *
 * The end is `COALESCE(ended_at, updated_at)`. Every finalize path sets `ended_at`;
 * a terminal row without one falls back to `updated_at`, which the row trigger moved
 * when the terminal status was written, so it is never earlier than the real end
 * (later writes such as analysis only push it forward and delay the shred). Treating
 * such a row as recent forever would instead keep the secret alive indefinitely.
 *
 * `cred`, `statuses` and `holdSecs` are SQL expressions (a column or a `$n`); each
 * placeholder is cast here, at its one use. The shred and its sweep both use this,
 * so the sweep never lists a credential the shred would refuse.
 */
function callStillNeedsCredential(cred: string, statuses: string, holdSecs: string): string {
  return `EXISTS (
    SELECT 1 FROM agency_calls c
     WHERE c.telephony_credential_id = ${cred}
       AND (c.status = ANY(${statuses}::varchar[])
            OR COALESCE(c.ended_at, c.updated_at) > NOW() - make_interval(secs => ${holdSecs}::int)))`;
}

async function inTransaction<T>(fn: (client: PoolClient) => Promise<T | null>): Promise<T | null> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query(out === null ? 'ROLLBACK' : 'COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function insertSecret(client: PoolClient, credentialId: string, version: number, sealed: SealedSecretInput): Promise<void> {
  await client.query(
    `INSERT INTO telephony_credential_secrets
       (credential_id, secret_version, secret_ciphertext, wrapped_dek, kek_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [credentialId, version, sealed.secret_ciphertext, sealed.wrapped_dek, sealed.kek_id],
  );
}

export class TelephonyCredentialRepository {
  /** The credential row and its first secret version, together or not at all. */
  async create(input: CreateTelephonyCredentialInput): Promise<TelephonyCredentialRecord> {
    const row = await inTransaction(async (client) => {
      const result = await client.query<TelephonyCredentialRecord>(
        `INSERT INTO telephony_credentials
           (id, tenant_id, provider, label, account_ref, public_config,
            secret_version, secret_hint, verified_at, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9, $9)
         RETURNING ${COLUMNS}`,
        [
          input.id, input.tenant_id, input.provider, input.label, input.account_ref,
          JSON.stringify(input.public_config), input.sealed.secret_hint,
          input.verified_at, input.created_by,
        ],
      );
      await insertSecret(client, input.id, 1, input.sealed);
      return result.rows[0]!;
    });
    return row!;
  }

  async findById(id: string): Promise<TelephonyCredentialRecord | null> {
    const result = await getPool().query<TelephonyCredentialRecord>(
      `SELECT ${COLUMNS} FROM telephony_credentials WHERE id = $1`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  /**
   * The secret versions that may still be opened: the current one, and versions a
   * rotation retired less than `graceSeconds` ago (the carrier may still sign webhooks
   * for older calls with them). Newest first. For the server's resolver only.
   */
  async findOpenableSecrets(id: string, graceSeconds: number): Promise<TelephonyCredentialSecretRecord[]> {
    const result = await getPool().query<TelephonyCredentialSecretRecord>(
      `SELECT credential_id, secret_version, secret_ciphertext, wrapped_dek, kek_id, created_at, retired_at
         FROM telephony_credential_secrets
        WHERE credential_id = $1
          AND (retired_at IS NULL OR retired_at > NOW() - make_interval(secs => $2::int))
        ORDER BY secret_version DESC`,
      [id, graceSeconds],
    );
    return result.rows;
  }

  /**
   * The same versions as `findOpenableSecrets`, same order, without the ciphertext:
   * for callers that only need to know which versions (and master keys) are live.
   */
  async findOpenableVersions(id: string, graceSeconds: number): Promise<Array<{ secret_version: number; kek_id: string }>> {
    const result = await getPool().query<{ secret_version: number; kek_id: string }>(
      `SELECT secret_version, kek_id
         FROM telephony_credential_secrets
        WHERE credential_id = $1
          AND (retired_at IS NULL OR retired_at > NOW() - make_interval(secs => $2::int))
        ORDER BY secret_version DESC`,
      [id, graceSeconds],
    );
    return result.rows;
  }

  /** Every master key id a stored secret is wrapped under (the boot keyring check). */
  async distinctKekIds(): Promise<string[]> {
    const result = await getPool().query<{ kek_id: string }>(
      `SELECT DISTINCT kek_id FROM telephony_credential_secrets ORDER BY kek_id`,
    );
    return result.rows.map((r) => r.kek_id);
  }

  async list(filters: { tenantId?: string; provider?: string; includeRevoked?: boolean } = {}): Promise<TelephonyCredentialRecord[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (filters.tenantId) { values.push(filters.tenantId); where.push(`tenant_id = $${values.length}`); }
    if (filters.provider) { values.push(filters.provider); where.push(`provider = $${values.length}`); }
    if (!filters.includeRevoked) where.push(`status <> 'revoked'`);
    const result = await getPool().query<TelephonyCredentialRecord>(
      `SELECT ${COLUMNS} FROM telephony_credentials
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY tenant_id, lower(label), id`,
      values,
    );
    return result.rows;
  }

  async updateLabel(id: string, label: string, updatedBy: string): Promise<TelephonyCredentialRecord | null> {
    const result = await getPool().query<TelephonyCredentialRecord>(
      `UPDATE telephony_credentials SET label = $2, updated_by = $3
        WHERE id = $1 AND status <> 'revoked'
        RETURNING ${COLUMNS}`,
      [id, label, updatedBy],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Replace the secret. `sealed` must be sealed for `expectedVersion + 1`, and the
   * write lands only if the current version is still `expectedVersion`, so two
   * concurrent rotations cannot both land (the loser gets null). The superseded
   * version is retired, not deleted (see `findOpenableSecrets`). A rotation
   * re-activates an `invalid` credential (the new secret is presumed to fix it) but
   * leaves `disabled` alone: disabling is a decision, not a fault.
   */
  async rotateSecret(
    id: string,
    expectedVersion: number,
    sealed: SealedSecretInput,
    opts: { updatedBy: string; verifiedAt: Date | null },
  ): Promise<TelephonyCredentialRecord | null> {
    return inTransaction(async (client) => {
      const result = await client.query<TelephonyCredentialRecord>(
        `UPDATE telephony_credentials
            SET secret_version = secret_version + 1, secret_hint = $3,
                status = CASE WHEN status = 'invalid' THEN 'active' ELSE status END,
                verified_at = $4, last_error = NULL, updated_by = $5
          WHERE id = $1 AND secret_version = $2 AND status <> 'revoked'
          RETURNING ${COLUMNS}`,
        [id, expectedVersion, sealed.secret_hint, opts.verifiedAt, opts.updatedBy],
      );
      const row = result.rows[0];
      if (!row) return null;
      await client.query(
        `UPDATE telephony_credential_secrets SET retired_at = NOW()
          WHERE credential_id = $1 AND retired_at IS NULL`,
        [id],
      );
      await insertSecret(client, id, row.secret_version, sealed);
      return row;
    });
  }

  /**
   * Move between the live statuses (`active`, `disabled`, `invalid`). `from` lists
   * the statuses the move is allowed out of; revoked is terminal and never listed.
   * `secretVersion`, when given, makes the move a no-op once a rotation has replaced
   * that version (a carrier verdict on an old secret must not land on a new one).
   */
  async setStatus(
    id: string,
    to: Exclude<TelephonyCredentialStatus, 'revoked'>,
    from: ReadonlyArray<Exclude<TelephonyCredentialStatus, 'revoked'>>,
    opts: { updatedBy: string | null; lastError?: string | null; secretVersion?: number },
  ): Promise<TelephonyCredentialRecord | null> {
    const result = await getPool().query<TelephonyCredentialRecord>(
      `UPDATE telephony_credentials
          SET status = $2, updated_by = COALESCE($4::uuid, updated_by),
              last_error = CASE WHEN $5::boolean THEN $6::varchar ELSE last_error END
        WHERE id = $1 AND status = ANY($3::varchar[])
          AND ($7::int IS NULL OR secret_version = $7::int)
        RETURNING ${COLUMNS}`,
      [id, to, from, opts.updatedBy, opts.lastError !== undefined, opts.lastError ?? null, opts.secretVersion ?? null],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Record a successful carrier check of the secret at `version`: clears `last_error`
   * and brings an `invalid` credential back to `active`. A `disabled` one stays
   * disabled (a decision, not a fault), but with `last_error` cleared `enable` now
   * brings it back as active. Null when nothing changed: revoked, or a rotation has
   * replaced that version (the verdict was about an old secret).
   */
  async markVerified(id: string, version: number, updatedBy: string | null): Promise<TelephonyCredentialRecord | null> {
    const result = await getPool().query<TelephonyCredentialRecord>(
      `UPDATE telephony_credentials
          SET verified_at = NOW(), last_error = NULL,
              status = CASE WHEN status = 'invalid' THEN 'active' ELSE status END,
              updated_by = COALESCE($3::uuid, updated_by)
        WHERE id = $1 AND secret_version = $2 AND status <> 'revoked'
        RETURNING ${COLUMNS}`,
      [id, version, updatedBy],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Bring a disabled credential back: `invalid` when the carrier's last check refused
   * it (`last_error` set), else `active`. Decided in the UPDATE, so a verify landing
   * between a read and a write cannot be lost.
   */
  async enable(id: string, updatedBy: string): Promise<TelephonyCredentialRecord | null> {
    const result = await getPool().query<TelephonyCredentialRecord>(
      `UPDATE telephony_credentials
          SET status = CASE WHEN last_error IS NULL THEN 'active' ELSE 'invalid' END,
              updated_by = $2
        WHERE id = $1 AND status = 'disabled'
        RETURNING ${COLUMNS}`,
      [id, updatedBy],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Revoke (terminal), unless a live campaign is pinned to it or inbound is enabled on it
   * (docs/inbound.md §8.2: a revoked credential's secret is shredded, so it could never remove
   * its Application or restore a linked number; `ck_telephony_credentials_inbound_revoked`
   * holds it in the schema too). The row lock (FOR UPDATE) conflicts with the key-share lock a
   * campaign write takes through the foreign key, so a pin being written concurrently either
   * commits first and is seen here, or waits for this revoke; an inbound enable takes the same
   * row lock. Returns null when it did not land (already revoked, pinned, or inbound enabled:
   * the caller re-reads to tell which).
   */
  async revoke(id: string, updatedBy: string): Promise<TelephonyCredentialRecord | null> {
    return inTransaction(async (client) => {
      await client.query(`SELECT 1 FROM telephony_credentials WHERE id = $1 FOR UPDATE`, [id]);
      const result = await client.query<TelephonyCredentialRecord>(
        `UPDATE telephony_credentials
            SET status = 'revoked', revoked_at = NOW(), updated_by = $2
          WHERE id = $1 AND status <> 'revoked' AND inbound_app_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM agency_campaigns
               WHERE telephony_credential_id = $1 AND status IN ${LIVE_CAMPAIGN})
          RETURNING ${COLUMNS}`,
        [id, updatedBy],
      );
      return result.rows[0] ?? null;
    });
  }

  /**
   * Crypto-shred a revoked credential: delete every secret version once no pinned
   * call can still need it, i.e. every pinned call is terminal and ended more than
   * `postEndHoldSeconds` ago (`callStillNeedsCredential`). Returns false when it is
   * not revoked, already shredded, or a call still needs it (the sweep retries).
   */
  async shredIfIdle(id: string, postEndHoldSeconds: number): Promise<boolean> {
    const done = await inTransaction(async (client) => {
      // FOR UPDATE waits out any call insert still holding the foreign key's
      // key-share lock, so its row is visible to the check below.
      await client.query(`SELECT 1 FROM telephony_credentials WHERE id = $1 FOR UPDATE`, [id]);
      const result = await client.query(
        `UPDATE telephony_credentials SET shredded_at = NOW(), secret_hint = NULL
          WHERE id = $1 AND status = 'revoked' AND shredded_at IS NULL
            AND NOT ${callStillNeedsCredential('$1', '$2', '$3')}`,
        [id, IN_FLIGHT, postEndHoldSeconds],
      );
      if ((result.rowCount ?? 0) === 0) return null;
      await client.query(`DELETE FROM telephony_credential_secrets WHERE credential_id = $1`, [id]);
      return true;
    });
    return done === true;
  }

  /**
   * Revoked credentials still holding secrets that `shredIfIdle` would shred now
   * (same predicate), oldest revoke first, for the shred sweep. Credentials a call
   * still needs are left out, so they cannot fill the page and starve later ones.
   */
  async findRevokedUnshredded(postEndHoldSeconds: number, limit = 100): Promise<string[]> {
    const result = await getPool().query<{ id: string }>(
      `SELECT t.id FROM telephony_credentials t
        WHERE t.status = 'revoked' AND t.shredded_at IS NULL
          AND NOT ${callStillNeedsCredential('t.id', '$1', '$2')}
        ORDER BY t.revoked_at, t.id LIMIT $3`,
      [IN_FLIGHT, postEndHoldSeconds, limit],
    );
    return result.rows.map((r) => r.id);
  }

  /** Delete secret versions retired more than `graceSeconds` ago. Returns the count. */
  async pruneRetiredSecrets(graceSeconds: number): Promise<number> {
    const result = await getPool().query(
      `DELETE FROM telephony_credential_secrets
        WHERE retired_at IS NOT NULL AND retired_at <= NOW() - make_interval(secs => $1::int)`,
      [graceSeconds],
    );
    return result.rowCount ?? 0;
  }

  /**
   * The campaigns that can still dial pinned to it (what blocks a revoke), named for the
   * operator: at most `limit`, running first, then by tenant, account and campaign name.
   * `account_name` is null for an account that no longer exists.
   */
  async liveCampaigns(id: string, limit: number): Promise<Array<{
    id: string; name: string; status: string; tenant_name: string; account_name: string | null;
  }>> {
    const result = await getPool().query<{
      id: string; name: string; status: string; tenant_name: string; account_name: string | null;
    }>(
      `SELECT c.id, c.name, c.status, t.name AS tenant_name, a.name AS account_name
         FROM agency_campaigns c
         JOIN tenants t ON t.id = c.tenant_id
         LEFT JOIN accounts a ON a.id = c.account_id
        WHERE c.telephony_credential_id = $1 AND c.status IN ${LIVE_CAMPAIGN}
        ORDER BY CASE c.status WHEN 'running' THEN 0 WHEN 'stopping' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END,
                 t.name, a.name NULLS LAST, c.name, c.id
        LIMIT $2`,
      [id, limit],
    );
    return result.rows;
  }

  // ── Inbound (0024; docs/inbound.md §3.1, §8.1) ──────────────────────────────
  // The Application, its URLs and the purpose token's hash. Enabled is all of it or none of it
  // (ck_telephony_credentials_inbound). The token hashes are never selected: a write stores one,
  // `inboundTokenMatches` compares one, and nothing reads one back.

  /** The credential's inbound state, or null when there is no such credential. */
  async findInbound(id: string): Promise<TelephonyCredentialInboundRecord | null> {
    const result = await getPool().query<TelephonyCredentialInboundRecord>(
      `SELECT ${INBOUND_COLUMNS} FROM telephony_credentials c WHERE c.id = $1`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Every credential with inbound enabled that is not revoked (a revoked one cannot be: the
   * revoke is refused while inbound is enabled), oldest Application first: what the scheduled
   * Application health check walks (`telephony/credentials/inbound-monitor.ts`). A sequential
   * scan of a table with one row per tenant carrier account.
   */
  async listInboundEnabled(): Promise<Array<{ credential_id: string; tenant_id: string; status: TelephonyCredentialStatus }>> {
    const result = await getPool().query<{ credential_id: string; tenant_id: string; status: TelephonyCredentialStatus }>(
      `SELECT c.id AS credential_id, c.tenant_id, c.status
         FROM telephony_credentials c
        WHERE c.inbound_app_id IS NOT NULL AND c.status <> 'revoked'
        ORDER BY c.inbound_enabled_at, c.id`,
    );
    return result.rows;
  }

  /**
   * The credential's inbound state, its row locked `FOR UPDATE` on `client` (which must be in a
   * transaction): an inbound change that calls the carrier holds it until its own write commits,
   * so an enable, a Re-point, a disable and a revoke of one credential run one after another,
   * and a number link (which takes the row `FOR SHARE`, `phoneNumberRepository.linkInbound`)
   * never lands beside a disable. Null when there is no such credential.
   */
  async lockInbound(id: string, client: PoolClient): Promise<TelephonyCredentialInboundRecord | null> {
    const result = await client.query<TelephonyCredentialInboundRecord>(
      `SELECT ${INBOUND_COLUMNS} FROM telephony_credentials c WHERE c.id = $1 FOR UPDATE OF c`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Store an enabled inbound Application. Only on an `active` credential with inbound not yet
   * enabled (decided in the UPDATE, so two concurrent enables store one); null otherwise: the
   * caller re-reads to tell a missing, inactive or already-enabled credential apart, and deletes
   * the Application it created for nothing.
   */
  async enableInbound(
    id: string,
    input: EnableTelephonyCredentialInboundInput,
    updatedBy: string,
    opts: { client?: PoolClient } = {},
  ): Promise<TelephonyCredentialInboundRecord | null> {
    const result = await (opts.client ?? getPool()).query<TelephonyCredentialInboundRecord>(
      `UPDATE telephony_credentials c
          SET inbound_app_id = $2, inbound_answer_url = $3, inbound_hangup_url = $4,
              inbound_fallback_answer_url = $5, inbound_token_hash = $6, inbound_enabled_at = NOW(),
              inbound_previous_token_hash = NULL, inbound_previous_token_expires_at = NULL,
              updated_by = $7
        WHERE c.id = $1 AND c.status = 'active' AND c.inbound_app_id IS NULL
        RETURNING ${INBOUND_COLUMNS}`,
      [id, input.appId, input.answerUrl, input.hangupUrl, input.fallbackAnswerUrl, input.tokenHash, updatedBy],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Re-point: new URLs and a new token (and a new Application id when the old one had to be
   * recreated). The replaced token's hash moves to `inbound_previous_token_hash`, accepted for
   * `previousTokenGraceSeconds` more, so a call answered before the Re-point still has its hangup
   * accepted. Any older previous token is dropped. Only while inbound is enabled and the
   * credential is not revoked; null otherwise. `enabled_at` is kept.
   */
  async repointInbound(
    id: string,
    input: RepointTelephonyCredentialInboundInput,
    updatedBy: string,
    opts: { client?: PoolClient } = {},
  ): Promise<TelephonyCredentialInboundRecord | null> {
    const result = await (opts.client ?? getPool()).query<TelephonyCredentialInboundRecord>(
      `UPDATE telephony_credentials c
          SET inbound_app_id = COALESCE($2::varchar, c.inbound_app_id),
              inbound_answer_url = $3, inbound_hangup_url = $4, inbound_fallback_answer_url = $5,
              inbound_previous_token_hash = c.inbound_token_hash,
              inbound_previous_token_expires_at = NOW() + make_interval(secs => $7::int),
              inbound_token_hash = $6,
              updated_by = $8
        WHERE c.id = $1 AND c.inbound_app_id IS NOT NULL AND c.status <> 'revoked'
        RETURNING ${INBOUND_COLUMNS}`,
      [id, input.appId ?? null, input.answerUrl, input.hangupUrl, input.fallbackAnswerUrl, input.tokenHash,
        input.previousTokenGraceSeconds, updatedBy],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Forget the inbound Application (the caller has deleted it on the carrier, or it is gone).
   * Refused while any of the credential's numbers is still linked (`numbers_linked`): the §8.2
   * cascade unlinks them first, so no number is left pointing at an Application nothing
   * remembers. The row lock orders it against a concurrent link. `not_enabled` covers a missing
   * credential too. With `client` it runs in the caller's transaction (which then owns the
   * commit, e.g. after deleting the Application on the carrier); a refusal writes nothing.
   */
  async disableInbound(
    id: string,
    updatedBy: string,
    opts: { client?: PoolClient } = {},
  ): Promise<{ ok: true; inbound: TelephonyCredentialInboundRecord } | { ok: false; reason: 'not_enabled' | 'numbers_linked' }> {
    const run = async (client: PoolClient) => {
      const locked = await client.query<{ enabled: boolean }>(
        `SELECT inbound_app_id IS NOT NULL AS enabled FROM telephony_credentials WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!locked.rows[0]?.enabled) return { ok: false as const, reason: 'not_enabled' as const };
      const linked = await client.query(
        `SELECT 1 FROM phone_numbers WHERE telephony_credential_id = $1 AND inbound_linked_at IS NOT NULL LIMIT 1`,
        [id],
      );
      if (linked.rowCount) return { ok: false as const, reason: 'numbers_linked' as const };
      const result = await client.query<TelephonyCredentialInboundRecord>(
        `UPDATE telephony_credentials c
            SET inbound_app_id = NULL, inbound_answer_url = NULL, inbound_hangup_url = NULL,
                inbound_fallback_answer_url = NULL, inbound_token_hash = NULL, inbound_enabled_at = NULL,
                inbound_previous_token_hash = NULL, inbound_previous_token_expires_at = NULL,
                updated_by = $2
          WHERE c.id = $1
          RETURNING ${INBOUND_COLUMNS}`,
        [id, updatedBy],
      );
      return { ok: true as const, inbound: result.rows[0]! };
    };
    if (opts.client) return run(opts.client);
    const out = await inTransaction(run);
    return out ?? { ok: false, reason: 'not_enabled' };
  }

  /**
   * Whether `tokenHash` (sha256 hex of the `token` query parameter of an inbound webhook) is the
   * credential's current inbound token, or its previous one before that one's expiry. False when
   * inbound is not enabled. The comparison is an equality in SQL on a value the caller would have
   * to guess in full (the membership-invite rule): there is no per-byte oracle to walk.
   */
  async inboundTokenMatches(id: string, tokenHash: string): Promise<boolean> {
    const result = await getPool().query(
      `SELECT 1 FROM telephony_credentials
        WHERE id = $1 AND inbound_app_id IS NOT NULL
          AND (inbound_token_hash = $2
               OR (inbound_previous_token_hash = $2 AND inbound_previous_token_expires_at > NOW()))`,
      [id, tokenHash],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** How many campaigns that can still dial pin it, and how many calls are in flight on it. */
  async usage(id: string): Promise<{ campaigns: number; inFlightCalls: number }> {
    const result = await getPool().query<{ campaigns: number; in_flight: number }>(
      `SELECT
         (SELECT count(*)::int FROM agency_campaigns
           WHERE telephony_credential_id = $1 AND status IN ${LIVE_CAMPAIGN}) AS campaigns,
         (SELECT count(*)::int FROM agency_calls
           WHERE telephony_credential_id = $1 AND status = ANY($2::varchar[])) AS in_flight`,
      [id, IN_FLIGHT],
    );
    const row = result.rows[0]!;
    return { campaigns: row.campaigns, inFlightCalls: row.in_flight };
  }
}

export const telephonyCredentialRepository = new TelephonyCredentialRepository();

import type { PoolClient } from 'pg';
import { getPool } from '../connection.js';
import { WEBRTC_NON_TERMINAL_STATUSES } from '../models/agency-call.model.js';
import type {
  CreateTelephonyCredentialInput,
  SealedSecretInput,
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

/**
 * Campaign statuses that can still dial. A completed or stopped campaign is terminal,
 * so it no longer holds a credential live (it would otherwise block a revoke forever:
 * campaigns are never deleted).
 */
const LIVE_CAMPAIGN = `('draft', 'running', 'paused', 'stopping')`;

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
   * Revoke (terminal), unless a live campaign is pinned to it. The row lock (FOR
   * UPDATE) conflicts with the key-share lock a campaign write takes through the
   * foreign key, so a pin being written concurrently either commits first and is
   * seen here, or waits for this revoke. Returns null when it did not land (already
   * revoked, or pinned: the caller re-reads to tell which).
   */
  async revoke(id: string, updatedBy: string): Promise<TelephonyCredentialRecord | null> {
    return inTransaction(async (client) => {
      await client.query(`SELECT 1 FROM telephony_credentials WHERE id = $1 FOR UPDATE`, [id]);
      const result = await client.query<TelephonyCredentialRecord>(
        `UPDATE telephony_credentials
            SET status = 'revoked', revoked_at = NOW(), updated_by = $2
          WHERE id = $1 AND status <> 'revoked'
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

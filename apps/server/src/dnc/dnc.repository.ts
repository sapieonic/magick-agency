import { z } from 'zod';
import type { PoolClient } from 'pg';
import { getPool } from '@magick-agency/db';

/**
 * `dnc_entries` access.
 *
 * ── The one rule this module exists to hold ─────────────────────────────────
 * DNC is a compliance control, so **every read here fails closed**: a query that
 * cannot be answered THROWS. There is deliberately no return value meaning
 * "unknown" and no `?? false` fallback anywhere in this file, because the
 * failure this feature exists to prevent is exactly "the list could not be
 * consulted, so the number was dialed". A suppression check that degrades to
 * "not suppressed" under database trouble produces that violation at volume,
 * with a green health check.
 *
 * The corollary is that callers must not catch and continue. `dnc.service.ts`
 * documents where the throw is expected to land.
 */

/** How a number got onto the list. Mirrors `ck_dnc_entries_source`. */
export type DncSource = 'agent' | 'import' | 'api' | 'regulator';

export const DNC_SOURCES: readonly DncSource[] = ['agent', 'import', 'api', 'regulator'];

export interface DncEntryRecord {
  id: string;
  tenant_id: string;
  /** NULL ⇒ tenant-wide. */
  account_id: string | null;
  /** NULL ⇒ every campaign. No FK. */
  campaign_id: string | null;
  phone_e164: string;
  source: DncSource;
  reason: string | null;
  added_by: string | null;
  created_at: Date;
}

export interface DncEntryInput {
  tenant_id: string;
  account_id?: string | null;
  campaign_id?: string | null;
  source: DncSource;
  reason?: string | null;
  added_by?: string | null;
  /** Already E.164 and already de-duplicated by the caller. */
  phones: readonly string[];
}

/**
 * One number's outcome from an add. `created: false` is a SUCCESS — re-adding a
 * number already on the list is idempotent, not a conflict (same reasoning as a
 * re-submitted disposition: the caller's intent is already satisfied, and an
 * error would be about a detail they cannot act on).
 */
export interface DncInsertResult {
  phone_e164: string;
  entry: DncEntryRecord;
  created: boolean;
}

export interface DncInsertManyResult {
  results: DncInsertResult[];
}

/** What a delete changed. */
export interface DncDeleteResult {
  entry: DncEntryRecord;
}

/**
 * The scope a lookup is performed *for*. A campaign-scoped dial is suppressed by
 * a tenant-wide row, an account-wide row for its account, OR its own
 * campaign-scoped row — so the predicate widens, never narrows.
 */
export interface DncLookupScope {
  tenantId: string;
  accountId?: string | null;
  campaignId?: string | null;
}

export interface DncListFilter {
  tenantId: string;
  /** Exact E.164 match. */
  phone?: string;
  /** `'tenant'` selects rows with `account_id IS NULL`. */
  accountId?: string | null;
  campaignId?: string | null;
  source?: DncSource;
  limit: number;
  offset: number;
}

/**
 * The sentinel the unique index COALESCEs NULL scope columns to. Repeated here
 * because `ON CONFLICT` on an expression index must spell the expression out
 * character-for-character or Postgres cannot match it to `uq_dnc_scope` and
 * raises `there is no unique or exclusion constraint matching`.
 */
export const SCOPE_SENTINEL = '00000000-0000-0000-0000-000000000000';

/**
 * A scope-column UUID (`account_id`, `campaign_id`) that is safe to WRITE.
 *
 * ── Why `.uuid()` alone is not enough ───────────────────────────────────────
 * `z.string().uuid()` accepts the nil UUID — verified against this repo's zod
 * 3.25.76, not assumed — and the nil UUID is the exact literal `uq_dnc_scope`
 * COALESCEs a NULL scope column to. So a row carrying it as a *real* scope has
 * an index key **byte-identical** to a tenant-wide row's for the same number,
 * while {@link isTenantWide} correctly reports `false`.
 *
 * That combination is the failure this whole feature exists to prevent, in the
 * direction it exists to prevent it in:
 *
 *   1. The nil-scoped row inserts. It is not tenant-wide, and nothing looks
 *      wrong.
 *   2. A genuine "never call this number again" escalation arrives later with no
 *      scope at all. Its `ON CONFLICT` **collides with the nil row** and does
 *      nothing; the fallback SELECT's `COALESCE($n, SENTINEL)` matches that same
 *      row and hands it back as `created: false`.
 *   3. The caller is told `already_present` — success — and the number is
 *      suppressed in exactly ONE campaign, forever, having asked for everywhere.
 *
 * No amount of correct TypeScript downstream recovers from that, because every
 * layer is behaving exactly as written. The only place to stop it is here, before
 * the value reaches the index.
 *
 * Derived from {@link SCOPE_SENTINEL} rather than re-typing the literal, and
 * defined in this module rather than in the routes, so the guard cannot drift
 * away from the constant it is guarding or from the `ON CONFLICT` target built
 * out of it directly below.
 *
 * A tenant-wide entry is requested by OMITTING the field or sending `null` —
 * never by spelling the sentinel out.
 */
export function dncScopeUuid() {
  return z
    .string()
    .uuid()
    .refine((value) => value !== SCOPE_SENTINEL, {
      message:
        `'${SCOPE_SENTINEL}' is reserved and cannot be used as a scope id: it is the sentinel ` +
        `uq_dnc_scope coalesces a NULL scope column to, so an entry carrying it would collide ` +
        `with this number's tenant-wide entry and silently swallow a later tenant-wide ` +
        `escalation. Omit the field (or send null) to write a tenant-wide entry.`,
    });
}

/**
 * The audit label for an entry's reach — **both scope columns, never the first
 * one that happens to be set.**
 *
 * `findSuppressed` ANDs the two: a row matches only when `account_id` is NULL or
 * equal AND `campaign_id` is NULL or equal. So account+campaign is the NARROWEST
 * scope there is, narrower than account-wide — and a ternary chain that returned
 * `'account'` on the first non-null column labelled it as the broader of the two.
 * An audit trail that overstates how far a suppression reaches is worse than one
 * that says nothing: the whole reason to record scope is so a compliance review
 * can tell "this number is off the list everywhere" from "off it on one campaign".
 *
 * Lives here beside {@link dncScopeUuid} and the `ON CONFLICT` target so the label
 * cannot drift from the columns that actually decide the match, and so the add and
 * delete handlers cannot disagree — they had the identical bug written twice.
 */
export type DncScopeLabel = 'tenant' | 'account' | 'campaign' | 'account_campaign';

export function dncScopeLabel(entry: {
  account_id?: string | null;
  campaign_id?: string | null;
}): DncScopeLabel {
  const account = entry.account_id != null;
  const campaign = entry.campaign_id != null;
  if (account && campaign) return 'account_campaign';
  if (account) return 'account';
  if (campaign) return 'campaign';
  return 'tenant';
}

const UQ_DNC_SCOPE_TARGET = `(
  tenant_id,
  COALESCE(account_id,  '${SCOPE_SENTINEL}'::uuid),
  COALESCE(campaign_id, '${SCOPE_SENTINEL}'::uuid),
  phone_e164
)`;

/** A tenant-wide row is one with BOTH scope columns NULL. */
export function isTenantWide(input: { account_id?: string | null; campaign_id?: string | null }): boolean {
  return (input.account_id ?? null) === null && (input.campaign_id ?? null) === null;
}

export class DncRepository {
  /**
   * Add one number. Idempotent on `uq_dnc_scope`.
   *
   * `DO NOTHING` plus a follow-up SELECT rather than `DO UPDATE … RETURNING`:
   * an upsert would silently overwrite the original `source`, `reason` and
   * `added_by` of an existing entry, which is the audit trail of who suppressed
   * this number and why. A regulator-sourced row must not be relabelled `agent`
   * because an agent later marked the same number.
   *
   * The write is ONE transaction (decision B8). With `opts.client` the insert
   * joins the CALLER's transaction instead (the agent's mark writing this row
   * beside its own attempt bookkeeping): this method then
   * neither begins, commits, rolls back nor releases, so a failure anywhere in
   * the caller's transaction takes the DNC row with it.
   */
  async insertMany(
    input: DncEntryInput,
    opts: { client?: PoolClient } = {},
  ): Promise<DncInsertManyResult> {
    const own = opts.client === undefined;
    const client: PoolClient = opts.client ?? (await getPool().connect());
    try {
      if (own) await client.query('BEGIN');

      const results: DncInsertResult[] = [];

      for (const phone of input.phones) {
        const inserted = await client.query<DncEntryRecord>(
          `INSERT INTO dnc_entries
             (tenant_id, account_id, campaign_id, phone_e164, source, reason, added_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT ${UQ_DNC_SCOPE_TARGET} DO NOTHING
           RETURNING *`,
          [
            input.tenant_id,
            input.account_id ?? null,
            input.campaign_id ?? null,
            phone,
            input.source,
            input.reason ?? null,
            input.added_by ?? null,
          ],
        );

        const created = inserted.rows[0];
        if (created) {
          results.push({ phone_e164: phone, entry: created, created: true });
          continue;
        }

        const existing = await client.query<DncEntryRecord>(
          `SELECT * FROM dnc_entries
            WHERE tenant_id = $1
              AND COALESCE(account_id,  '${SCOPE_SENTINEL}'::uuid) = COALESCE($2::uuid, '${SCOPE_SENTINEL}'::uuid)
              AND COALESCE(campaign_id, '${SCOPE_SENTINEL}'::uuid) = COALESCE($3::uuid, '${SCOPE_SENTINEL}'::uuid)
              AND phone_e164 = $4`,
          [input.tenant_id, input.account_id ?? null, input.campaign_id ?? null, phone],
        );

        // A row that conflicted and then cannot be found means the conflict
        // target is not the index we think it is. Throwing is fail-closed: the
        // caller must not conclude the number was recorded.
        const entry = existing.rows[0];
        if (!entry) {
          throw new Error(
            `dnc_entries insert conflicted but no matching row was found for ${phone} — uq_dnc_scope may not match the ON CONFLICT target`,
          );
        }
        results.push({ phone_e164: phone, entry, created: false });
      }

      if (own) await client.query('COMMIT');
      return { results };
    } catch (err) {
      if (own) await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      if (own) client.release();
    }
  }

  /**
   * Which of `phones` are suppressed for this scope.
   *
   * **One query per batch, served by `idx_dnc_entries_tenant_phone`.** The
   * `COALESCE` unique index cannot answer this — it is prefixed on the scope
   * expressions, so a per-number probe would seq-scan. That is why the plain
   * index exists beside the unique one, and this is its only caller shape.
   *
   * Returns a Set of the *matched* numbers, never a per-number boolean map: a
   * map invites `map[phone]` on a number that was not queried, which is
   * `undefined` and therefore falsy — a fail-open read of a fail-closed answer.
   */
  async findSuppressed(scope: DncLookupScope, phones: readonly string[]): Promise<Set<string>> {
    if (phones.length === 0) return new Set();

    const pool = getPool();
    const result = await pool.query<{ phone_e164: string }>(
      `SELECT DISTINCT phone_e164 FROM dnc_entries
        WHERE tenant_id = $1
          AND phone_e164 = ANY($2::varchar[])
          AND (account_id  IS NULL OR account_id  = $3::uuid)
          AND (campaign_id IS NULL OR campaign_id = $4::uuid)`,
      [scope.tenantId, phones as string[], scope.accountId ?? null, scope.campaignId ?? null],
    );
    return new Set(result.rows.map((r) => r.phone_e164));
  }

  async findById(id: string, tenantId: string): Promise<DncEntryRecord | null> {
    // Tenant-scoped by construction — an entry id is not a capability.
    const pool = getPool();
    const result = await pool.query<DncEntryRecord>(
      `SELECT * FROM dnc_entries WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Remove one entry.
   *
   * The single `DELETE` statement and nothing else (decision B8): the dial-time
   * check reads `dnc_entries` itself, so the row's absence IS the number becoming
   * dialable again, atomically.
   *
   * `accountScope`, when passed, additionally requires `account_id = $3` —
   * an account-scoped caller (`dnc.routes.ts`) may only remove a row it
   * literally owns, never a sibling account's row and never a tenant-wide one
   * (`account_id IS NULL`), so the predicate is an equality rather than the
   * `IS NULL OR =` shape used for reads elsewhere. Omitted entirely (not
   * passed as `undefined`) for a tenant-wide caller, so the statement text and
   * argument count are byte-identical to the pre-existing unscoped delete.
   */
  async deleteById(id: string, tenantId: string, accountScope?: string): Promise<DncDeleteResult | null> {
    const pool = getPool();
    const result = accountScope !== undefined
      ? await pool.query<DncEntryRecord>(
          `DELETE FROM dnc_entries WHERE id = $1 AND tenant_id = $2 AND account_id = $3 RETURNING *`,
          [id, tenantId, accountScope],
        )
      : await pool.query<DncEntryRecord>(
          `DELETE FROM dnc_entries WHERE id = $1 AND tenant_id = $2 RETURNING *`,
          [id, tenantId],
        );
    const entry = result.rows[0];
    return entry ? { entry } : null;
  }

  async list(filter: DncListFilter): Promise<{ entries: DncEntryRecord[]; total: number }> {
    const pool = getPool();
    const conditions: string[] = ['tenant_id = $1'];
    const params: unknown[] = [filter.tenantId];

    if (filter.phone !== undefined) {
      params.push(filter.phone);
      conditions.push(`phone_e164 = $${params.length}`);
    }
    // `null` and "not supplied" are different filters: `accountId: null` means
    // "tenant-wide rows only", absent means "any scope". A single optional
    // parameter cannot express that, so the distinction is on `=== undefined`.
    if (filter.accountId !== undefined) {
      if (filter.accountId === null) {
        conditions.push('account_id IS NULL');
      } else {
        params.push(filter.accountId);
        conditions.push(`account_id = $${params.length}::uuid`);
      }
    }
    if (filter.campaignId !== undefined) {
      if (filter.campaignId === null) {
        conditions.push('campaign_id IS NULL');
      } else {
        params.push(filter.campaignId);
        conditions.push(`campaign_id = $${params.length}::uuid`);
      }
    }
    if (filter.source !== undefined) {
      params.push(filter.source);
      conditions.push(`source = $${params.length}`);
    }

    const where = conditions.join(' AND ');

    const total = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM dnc_entries WHERE ${where}`,
      params,
    );

    params.push(filter.limit, filter.offset);
    const rows = await pool.query<DncEntryRecord>(
      `SELECT * FROM dnc_entries WHERE ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return { entries: rows.rows, total: Number(total.rows[0]!.count) };
  }
}

export const dncRepository = new DncRepository();

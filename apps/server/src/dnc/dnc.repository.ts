import { z } from 'zod';
import type { PoolClient } from 'pg';
import { getPool } from '@magick-agency/db';
import { withTransaction } from '@magick-agency/db/utils/transaction';
import { DNC_SOURCES, type DncSource } from '@magick-agency/contracts/api/agency/dnc';
import { endsWithDigitsSql } from '../db/sql-utils.js';

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

/** How a number got onto the list. Mirrors `ck_dnc_entries_source`; declared in the contract. */
export { DNC_SOURCES, type DncSource };

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
  /**
   * The Do Not Call page's add only (DS4): skip a number a WIDER entry already blocks in this
   * scope, and report it `covered` rather than writing a narrower row beside it. `accountId` is
   * the account the new row reaches: its own for an account row, its campaign's for a campaign
   * row (stored without one). Absent (an agent's mark, every other writer): write as asked.
   * Ignored for a tenant-wide row, which nothing is wider than.
   */
  coverage?: { accountId: string | null };
}

/**
 * One number's outcome from an add. `created: false` is a SUCCESS — re-adding a
 * number already on the list is idempotent, not a conflict (same reasoning as a
 * re-submitted disposition: the caller's intent is already satisfied, and an
 * error would be about a detail they cannot act on).
 */
export interface DncInsertResult {
  phone_e164: string;
  /**
   * The row that is on the list for this number: the one just written, the same-scope one the
   * add found, or (with `covered`) the wider one that already blocks it.
   */
  entry: DncEntryRecord;
  created: boolean;
  /** True when nothing was written because `entry`, a WIDER entry, already blocks the number here. */
  covered?: boolean;
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

/**
 * The list's number search (`dncPhoneSearch` in `dnc.service.ts` reads the typed text into it).
 * A row matches when its number is `e164`, ends in `endsWith` or starts with `startsWith`; all
 * `null` matches nothing.
 */
export interface DncPhoneSearch {
  /** One whole number, matched exactly (`idx_dnc_entries_tenant_phone`). */
  e164: string | null;
  /** Digits only: rows whose number ends in them (`idx_dnc_entries_tenant_phone_reversed`). */
  endsWith: string | null;
  /** `+` and digits, a number cut short: rows whose number starts with it (`idx_dnc_entries_tenant_phone`). */
  startsWith: string | null;
}

export interface DncListFilter {
  tenantId: string;
  phone?: DncPhoneSearch;
  /** `'tenant'` selects rows with `account_id IS NULL`. */
  accountId?: string | null;
  campaignId?: string | null;
  /**
   * Only the entries that BELONG to this account (DS6): its own account rows and the rows of its
   * campaigns (a campaign entry is stored without an account). Never a tenant-wide row. What an
   * account-scoped caller lists.
   */
  ownerAccountId?: string;
  /** Only entries of this reach (`dncEntryScope`). */
  scope?: DncEntryScope;
  source?: DncSource;
  limit: number;
  offset: number;
}

/** How far an entry reaches: every campaign, one account's campaigns, or one campaign. */
export type DncEntryScope = 'tenant' | 'account' | 'campaign';

/**
 * An entry's reach as the list and the soft phone name it: campaign when it names a campaign
 * (an account-and-campaign row included, which matches that campaign alone), else account, else
 * tenant-wide. `dncScopeLabel` below is the AUDIT label, which keeps the four-way split.
 */
export function dncEntryScope(entry: { account_id: string | null; campaign_id: string | null }): DncEntryScope {
  return entry.campaign_id !== null ? 'campaign' : entry.account_id !== null ? 'account' : 'tenant';
}

/** What the list shows beside each entry so its scope can be named in words (DS7). */
export interface DncEntryNames {
  scope: DncEntryScope;
  /** The account the entry belongs to: its own, or its campaign's. NULL for a tenant-wide entry. */
  scope_account_id: string | null;
  /** That account's name; NULL when there is none or it cannot be read. */
  account_name: string | null;
  /** The campaign's name; NULL when the entry names no campaign or the campaign no longer exists. */
  campaign_name: string | null;
}

/**
 * The SQL predicate "this row belongs to account `$n`": its own account row, or a row of one of
 * the account's campaigns (stored `account_id NULL`, as `markDnc` writes it). A tenant-wide row
 * belongs to no account. `tenantParam` and `accountParam` are bound placeholders.
 */
function ownedByAccountSql(tenantParam: string, accountParam: string): string {
  return `(account_id = ${accountParam}::uuid OR (account_id IS NULL AND campaign_id IN (
            SELECT c.id FROM agency_campaigns c
             WHERE c.tenant_id = ${tenantParam}::uuid AND c.account_id = ${accountParam}::uuid)))`;
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
    return withTransaction(async (client) => {
      const results: DncInsertResult[] = [];
      const covering = input.coverage !== undefined && !isTenantWide(input)
        ? await findCovering(client, input, input.coverage.accountId)
        : new Map<string, DncEntryRecord>();

      for (const phone of input.phones) {
        const wider = covering.get(phone);
        if (wider) {
          results.push({ phone_e164: phone, entry: wider, created: false, covered: true });
          continue;
        }
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

      return { results };
    }, { pool: getPool(), client: opts.client });
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

  /**
   * For each of `phones` that {@link findSuppressed} matches, the WIDEST entry's
   * scope (tenant-wide, then account, then campaign): the roster import says in
   * words which list a rejected row is on (IM5). Same predicate and index as
   * `findSuppressed`; a number that matches nothing is absent.
   */
  async findSuppressionScopes(
    scope: DncLookupScope,
    phones: readonly string[],
  ): Promise<Map<string, 'tenant' | 'account' | 'campaign'>> {
    if (phones.length === 0) return new Map();
    const result = await getPool().query<{ phone_e164: string; scope: 'tenant' | 'account' | 'campaign' }>(
      `SELECT DISTINCT ON (phone_e164) phone_e164,
              CASE WHEN campaign_id IS NOT NULL THEN 'campaign'
                   WHEN account_id IS NOT NULL THEN 'account'
                   ELSE 'tenant' END AS scope
         FROM dnc_entries
        WHERE tenant_id = $1
          AND phone_e164 = ANY($2::varchar[])
          AND (account_id  IS NULL OR account_id  = $3::uuid)
          AND (campaign_id IS NULL OR campaign_id = $4::uuid)
        ORDER BY phone_e164, (campaign_id IS NOT NULL), (account_id IS NOT NULL)`,
      [scope.tenantId, phones as string[], scope.accountId ?? null, scope.campaignId ?? null],
    );
    return new Map(result.rows.map((r) => [r.phone_e164, r.scope]));
  }

  /**
   * The ENTRY that suppresses `phone` for this scope — {@link findSuppressed}'s
   * predicate exactly, for the one caller that must show the agent what it hit:
   * the soft phone's `dnc_listed` refusal and its override (docs/softphone.md SP1),
   * which stores the entry id it overrode.
   *
   * The widest entry first (tenant-wide, then account, then campaign), oldest
   * first within a scope, so the refusal names the broadest reason the number is
   * off the list. Same index as `findSuppressed`. `phone` must already be the
   * normalised E.164 form; null when nothing matches.
   */
  async findMatchingEntry(scope: DncLookupScope, phone: string): Promise<DncEntryRecord | null> {
    const pool = getPool();
    const result = await pool.query<DncEntryRecord>(
      `SELECT * FROM dnc_entries
        WHERE tenant_id = $1
          AND phone_e164 = $2
          AND (account_id  IS NULL OR account_id  = $3::uuid)
          AND (campaign_id IS NULL OR campaign_id = $4::uuid)
        ORDER BY (campaign_id IS NOT NULL), (account_id IS NOT NULL), created_at, id
        LIMIT 1`,
      [scope.tenantId, phone, scope.accountId ?? null, scope.campaignId ?? null],
    );
    return result.rows[0] ?? null;
  }

  /**
   * {@link findMatchingEntry} for a dial that names an ACCOUNT but no campaign: the
   * soft phone's untagged call (docs/softphone.md §4.1 step 2). A tenant-wide row, an
   * account-wide row for `accountId`, or a campaign-scoped row for ANY campaign of
   * that account suppresses — the last because a station mark writes campaign-scoped
   * rows by default, and a number a customer asked one of the account's campaigns to
   * stop calling must not be rung by hand from the same account with no campaign
   * named. Rows of another account's campaigns never match.
   *
   * One statement: the `dnc_entries` side is the `idx_dnc_entries_tenant_phone`
   * probe (a handful of rows per number), and each campaign-scoped candidate is
   * resolved by the `agency_campaigns` primary key. `dnc_entries.campaign_id` has no
   * FK, so a row whose campaign is gone matches nothing here (it reaches no dial
   * either). Same ordering as {@link findMatchingEntry}: the widest entry first.
   */
  async findMatchingEntryForAccount(
    tenantId: string,
    accountId: string,
    phone: string,
  ): Promise<DncEntryRecord | null> {
    const pool = getPool();
    const result = await pool.query<DncEntryRecord>(
      `SELECT d.* FROM dnc_entries d
        WHERE d.tenant_id = $1::uuid
          AND d.phone_e164 = $2
          AND (d.account_id IS NULL OR d.account_id = $3::uuid)
          AND (d.campaign_id IS NULL OR EXISTS (
                SELECT 1 FROM agency_campaigns c
                 WHERE c.id = d.campaign_id AND c.tenant_id = $1::uuid AND c.account_id = $3::uuid))
        ORDER BY (d.campaign_id IS NOT NULL), (d.account_id IS NOT NULL), d.created_at, d.id
        LIMIT 1`,
      [tenantId, phone, accountId],
    );
    return result.rows[0] ?? null;
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
   * `accountScope`, when passed, additionally requires the row to BELONG to that
   * account (DS6): its own account row, or a row of one of its campaigns (a campaign
   * entry is stored `account_id NULL`, so an equality on `account_id` alone left an
   * account admin unable to remove a mark on their own campaign). Never a sibling
   * account's row and never a tenant-wide one (no account, no campaign). Omitted
   * entirely (not passed as `undefined`) for a tenant-wide caller.
   */
  async deleteById(id: string, tenantId: string, accountScope?: string): Promise<DncDeleteResult | null> {
    const pool = getPool();
    const result = accountScope !== undefined
      ? await pool.query<DncEntryRecord>(
          `DELETE FROM dnc_entries WHERE id = $1 AND tenant_id = $2::uuid AND ${ownedByAccountSql('$2', '$3')} RETURNING *`,
          [id, tenantId, accountScope],
        )
      : await pool.query<DncEntryRecord>(
          `DELETE FROM dnc_entries WHERE id = $1 AND tenant_id = $2 RETURNING *`,
          [id, tenantId],
        );
    const entry = result.rows[0];
    return entry ? { entry } : null;
  }

  /**
   * The words each entry's scope is named with (DS7): its reach, the account it belongs to and
   * that account's and its campaign's names. Two reads by primary key over the page's ids, after
   * the list (so the list's own statement and its plan stay as they are). A campaign that no
   * longer exists (`campaign_id` has no FK) has no name and no account here.
   */
  async describeScopes(tenantId: string, entries: readonly DncEntryRecord[]): Promise<Map<string, DncEntryNames>> {
    const pool = getPool();
    const campaignIds = [...new Set(entries.flatMap((e) => (e.campaign_id ? [e.campaign_id] : [])))];
    const campaigns = campaignIds.length > 0
      ? (await pool.query<{ id: string; name: string; account_id: string }>(
          `SELECT id, name, account_id FROM agency_campaigns WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])`,
          [tenantId, campaignIds],
        )).rows
      : [];
    const campaignById = new Map(campaigns.map((c) => [c.id, c]));
    const ownerOf = (e: DncEntryRecord): string | null =>
      e.account_id ?? (e.campaign_id ? campaignById.get(e.campaign_id)?.account_id ?? null : null);
    const accountIds = [...new Set(entries.flatMap((e) => { const a = ownerOf(e); return a ? [a] : []; }))];
    const accounts = accountIds.length > 0
      ? (await pool.query<{ id: string; name: string }>(
          `SELECT id, name FROM accounts WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])`,
          [tenantId, accountIds],
        )).rows
      : [];
    const accountName = new Map(accounts.map((a) => [a.id, a.name]));
    return new Map(entries.map((e) => {
      const owner = ownerOf(e);
      return [e.id, {
        scope: dncEntryScope(e),
        scope_account_id: owner,
        account_name: owner ? accountName.get(owner) ?? null : null,
        campaign_name: e.campaign_id ? campaignById.get(e.campaign_id)?.name ?? null : null,
      }];
    }));
  }

  async list(filter: DncListFilter): Promise<{ entries: DncEntryRecord[]; total: number }> {
    const pool = getPool();
    const conditions: string[] = ['tenant_id = $1'];
    const params: unknown[] = [filter.tenantId];

    if (filter.phone !== undefined) {
      conditions.push(phoneSearchCondition(filter.phone, params));
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
    if (filter.ownerAccountId !== undefined) {
      params.push(filter.ownerAccountId);
      conditions.push(ownedByAccountSql('$1', `$${params.length}`));
    }
    if (filter.scope !== undefined) {
      conditions.push(
        filter.scope === 'tenant' ? '(account_id IS NULL AND campaign_id IS NULL)'
        : filter.scope === 'account' ? '(account_id IS NOT NULL AND campaign_id IS NULL)'
        : 'campaign_id IS NOT NULL',
      );
    }
    if (filter.source !== undefined) {
      params.push(filter.source);
      conditions.push(`source = $${params.length}`);
    }

    const where = conditions.join(' AND ');

    const n = params.length;
    const [total, rows] = await Promise.all([
      pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM dnc_entries WHERE ${where}`, params),
      pool.query<DncEntryRecord>(
        `SELECT * FROM dnc_entries WHERE ${where}
          ORDER BY created_at DESC, id DESC
          LIMIT $${n + 1} OFFSET $${n + 2}`,
        [...params, filter.limit, filter.offset],
      ),
    ]);

    return { entries: rows.rows, total: Number(total.rows[0]!.count) };
  }
}

/**
 * For each of `input.phones`, the WIDER entry that already blocks it in the scope `input` would
 * write (DS4): a tenant-wide row, an account row for `coverAccountId`, or (for a campaign row) an
 * account-and-campaign row for the same campaign. A row of exactly the scope being written is not
 * "wider" and is left to the insert's `ON CONFLICT` (`already_present`). The widest first, as
 * `findMatchingEntry` orders them. One read on `idx_dnc_entries_tenant_phone`, in the add's
 * transaction.
 */
async function findCovering(
  client: Pick<PoolClient, 'query'>,
  input: DncEntryInput,
  coverAccountId: string | null,
): Promise<Map<string, DncEntryRecord>> {
  if (input.phones.length === 0) return new Map();
  // A number already listed at exactly this scope is `already_present`, whatever else covers it:
  // such a row sorts first and is dropped below, so the insert's `ON CONFLICT` reports it.
  const { rows } = await client.query<DncEntryRecord & { same_scope: boolean }>(
    `SELECT DISTINCT ON (phone_e164) *,
            (COALESCE(account_id,  '${SCOPE_SENTINEL}'::uuid) = COALESCE($5::uuid, '${SCOPE_SENTINEL}'::uuid)
         AND COALESCE(campaign_id, '${SCOPE_SENTINEL}'::uuid) = COALESCE($4::uuid, '${SCOPE_SENTINEL}'::uuid)) AS same_scope
       FROM dnc_entries
      WHERE tenant_id = $1::uuid
        AND phone_e164 = ANY($2::varchar[])
        AND (account_id  IS NULL OR account_id  = $3::uuid)
        AND (campaign_id IS NULL OR campaign_id = $4::uuid)
      ORDER BY phone_e164, same_scope DESC, (campaign_id IS NOT NULL), (account_id IS NOT NULL), created_at, id`,
    [input.tenant_id, input.phones as string[], coverAccountId, input.campaign_id ?? null, input.account_id ?? null],
  );
  const covering = new Map<string, DncEntryRecord>();
  for (const { same_scope: sameScope, ...row } of rows) {
    if (!sameScope) covering.set(row.phone_e164, row);
  }
  return covering;
}

/**
 * The list search's predicate, its values pushed onto `params`.
 *
 * An ending is a PREFIX of the reversed number, which `idx_dnc_entries_tenant_phone_reversed`
 * (0034) indexes with `text_pattern_ops`, so both arms are index scans (a `BitmapOr` when both
 * are set) rather than a `LIKE '%…'` over every row of the tenant. Stored numbers are E.164
 * (`+` and digits, `toDncE164`), so no digits expression is needed. `endsWithDigitsSql` keeps only
 * the ending's digits, the one place a `%` or `_` could become a wildcard.
 */
function phoneSearchCondition(search: DncPhoneSearch, params: unknown[]): string {
  const bind = (value: unknown): string => `$${params.push(value)}`;
  const arms: string[] = [];
  if (search.e164 !== null) arms.push(`phone_e164 = ${bind(search.e164)}`);
  if (search.endsWith !== null) arms.push(endsWithDigitsSql('phone_e164', search.endsWith, bind));
  if (search.startsWith !== null) arms.push(startsWithE164Sql(search.startsWith, bind));
  if (arms.length === 0) return 'FALSE';
  return arms.length === 1 ? arms[0]! : `(${arms.join(' OR ')})`;
}

/**
 * `phone_e164` starts with `prefix` (`+` and the digits typed), as a RANGE on
 * `idx_dnc_entries_tenant_phone` (`tenant_id, phone_e164`, the default operator class).
 *
 * A `LIKE 'x%'` on that index is a range scan only under the C collation, which a database is not
 * promised to have; a range is one under any collation. The bounds are the prefix and the prefix
 * with its last digit raised (`+9199088` to `+9199089`, trailing nines carried: `+9199` to `+92`),
 * and since every stored value is `+` and digits, every number with the prefix lies between them.
 * The `LIKE` is kept as the exact test on the rows the range reads, so a collation that orders
 * `+` oddly can only make the range read more, never answer more. Re-stripped to digits here, so
 * the `LIKE` carries no wildcard.
 */
export function startsWithE164Sql(prefix: string, bind: (value: unknown) => string): string {
  const digits = prefix.replace(/\D/g, '');
  if (digits.length === 0) return 'FALSE';
  const low = bind(`+${digits}`);
  const like = `phone_e164 LIKE ${low} || '%'`;
  const kept = digits.replace(/9+$/, '');
  // All nines (`+999`): nothing sorts after the prefix that does not start with it.
  if (kept.length === 0) return `(phone_e164 >= ${low} AND ${like})`;
  const high = bind(`+${kept.slice(0, -1)}${Number(kept.at(-1)) + 1}`);
  return `(phone_e164 >= ${low} AND phone_e164 < ${high} AND ${like})`;
}

export const dncRepository = new DncRepository();

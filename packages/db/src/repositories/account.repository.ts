import { getPool } from '../connection.js';
import type { AccountRecord, CreateAccountInput, UpdateAccountInput } from '../models/account.model.js';

export class AccountRepository {
  async create(input: CreateAccountInput): Promise<AccountRecord> {
    const pool = getPool();
    const result = await pool.query<AccountRecord>(
      `INSERT INTO accounts (tenant_id, name, slug, settings)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [input.tenant_id, input.name, input.slug, JSON.stringify(input.settings || {})],
    );
    return result.rows[0]!;
  }

  /**
   * Unscoped by id. **Only for callers that legitimately cross tenants** — the
   * super-admin tree (`super-admin.routes.ts`), and the name resolver, which
   * checks ownership itself before using what comes back.
   *
   * Any tenant-facing route must use {@link findByIdInTenant} instead. An
   * account id travels in URLs, headers, logs and support threads, so "the
   * caller knew the id" is never evidence that the caller may see the row.
   */
  async findById(id: string): Promise<AccountRecord | null> {
    const pool = getPool();
    const result = await pool.query<AccountRecord>(
      `SELECT * FROM accounts WHERE id = $1 AND status != 'deleted'`,
      [id],
    );
    return result.rows[0] || null;
  }

  /** {@link findById}, constrained to one tenant. The tenant-facing lookup. */
  async findByIdInTenant(id: string, tenantId: string): Promise<AccountRecord | null> {
    const pool = getPool();
    const result = await pool.query<AccountRecord>(
      `SELECT * FROM accounts WHERE id = $1 AND tenant_id = $2 AND status != 'deleted'`,
      [id, tenantId],
    );
    return result.rows[0] || null;
  }

  /**
   * {@link findByIdInTenant}, but a soft-deleted account still matches.
   *
   * **The tenant boundary is the property both lookups share and neither may
   * drop** — `account_credit_allocations.account_id` has no composite FK back
   * to `tenant_id` (migration 002), so a naive existence check alone would
   * still let a caller name a sibling tenant's account id. What this drops is
   * only the `status != 'deleted'` filter, and it exists for exactly one
   * caller: `POST /credits/deallocate`. An account can be soft-deleted with an
   * unrefunded balance still sitting in `account_credit_allocations` — nothing
   * on the deletion path zeroes or returns it — and `findByIdInTenant`'s
   * active-only filter made that balance permanently unreachable: the 404 that
   * correctly blocks a NEW allocation into a deleted account also blocked the
   * one operation that could recover what a deleted account is still holding.
   * `POST /credits/allocate` keeps the active-only lookup — crediting a
   * deleted account is a real product bug, not a recovery path.
   */
  async findByIdInTenantIncludingDeleted(id: string, tenantId: string): Promise<AccountRecord | null> {
    const pool = getPool();
    const result = await pool.query<AccountRecord>(
      `SELECT * FROM accounts WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    return result.rows[0] || null;
  }

  async findByTenantId(tenantId: string): Promise<AccountRecord[]> {
    const pool = getPool();
    const result = await pool.query<AccountRecord>(
      `SELECT * FROM accounts WHERE tenant_id = $1 AND status != 'deleted' ORDER BY created_at DESC`,
      [tenantId],
    );
    return result.rows;
  }

  /**
   * Batch lookup for `GET /accounts/mine` (agent account self-resolution) —
   * the accounts a caller's own memberships point at, never the full tenant
   * list. `= ANY($1)` short-circuits to zero rows on an empty array rather
   * than matching everything, which matters here: a caller with no
   * account-scoped memberships (and no tenant-wide one) must see an empty
   * list, not every account in the tenant.
   *
   * ── `tenantId` is REQUIRED, not a nicety ────────────────────────────────
   * `memberships.account_id` is `REFERENCES accounts(id)` (migration
   * `001_initial_schema.sql`) with no composite FK back to the membership's
   * own `tenant_id` — nothing in the schema stops a membership row from
   * pointing at another tenant's account. `POST /users/invite` used to be
   * exactly that hole: it wrote a caller-supplied `account_id` alongside
   * `tenant_id = request.tenantId` with no check that the two agreed (fixed
   * separately in `user.routes.ts`), so a membership could already exist
   * pointing cross-tenant before this method ever saw it. Filtering by id
   * alone would then hand `/accounts/mine` another tenant's `{id, name,
   * tenant_id}` — account ids appear in URLs, logs and support threads, so
   * this is not a theoretical read. The predicate here is the second,
   * independent lock: even a cross-tenant membership row can only ever
   * resolve to accounts inside the caller's OWN tenant.
   */
  async findByIds(ids: string[], tenantId: string): Promise<AccountRecord[]> {
    if (ids.length === 0) return [];
    const pool = getPool();
    const result = await pool.query<AccountRecord>(
      `SELECT * FROM accounts WHERE id = ANY($1) AND tenant_id = $2 AND status != 'deleted' ORDER BY created_at DESC`,
      [ids, tenantId],
    );
    return result.rows;
  }

  /**
   * ── `tenantId` is REQUIRED, and this is a WRITE ─────────────────────────────
   *
   * This method took an id alone until the second review of the agency
   * happy-path fix, which is strictly worse than the `/accounts/mine` read that
   * fix closed. `requirePermission('account.update')` checks the CALLER'S ROLE
   * and never looks at the target row, so an `account_admin` of tenant A could
   * `PUT /accounts/<uuid in tenant B>`, rename B's account, and receive B's full
   * record back — `tenant_id`, `name`, `settings`, `status`. `PUT`'s response
   * body made it an exfiltration primitive as well as a write.
   *
   * The predicate belongs HERE rather than as a fetch-then-check in the route:
   * a route-level guard is a read followed by a write, and the two can disagree
   * (an account moved, or a second request racing). One statement whose WHERE
   * carries both keys cannot.
   *
   * **The earlier fix's claim that "every sibling query has one" was false when
   * it was written** — `update` and `softDelete`, in this same file, did not.
   * `findById` still does not, deliberately and by contract (see its docstring).
   */
  async update(
    id: string,
    tenantId: string,
    input: UpdateAccountInput,
  ): Promise<AccountRecord | null> {
    const pool = getPool();
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (input.name !== undefined) {
      setClauses.push(`name = $${paramIndex++}`);
      values.push(input.name);
    }
    if (input.settings !== undefined) {
      setClauses.push(`settings = $${paramIndex++}`);
      values.push(JSON.stringify(input.settings));
    }
    if (input.status !== undefined) {
      setClauses.push(`status = $${paramIndex++}`);
      values.push(input.status);
    }

    // The empty-patch shortcut is tenant-scoped too. It returns the row, so an
    // unscoped read here would hand another tenant's record back for the price
    // of an empty JSON body — the write predicate below would never even run.
    if (setClauses.length === 0) return this.findByIdInTenant(id, tenantId);

    values.push(id, tenantId);
    const result = await pool.query<AccountRecord>(
      `UPDATE accounts SET ${setClauses.join(', ')}
        WHERE id = $${paramIndex} AND tenant_id = $${paramIndex + 1}
        RETURNING *`,
      values,
    );
    return result.rows[0] || null;
  }

  /** `tenantId` is REQUIRED for the reasons on {@link update}. */
  async softDelete(id: string, tenantId: string): Promise<boolean> {
    const pool = getPool();
    const result = await pool.query(
      `UPDATE accounts SET status = 'deleted'
        WHERE id = $1 AND tenant_id = $2 AND status != 'deleted'`,
      [id, tenantId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}

export const accountRepository = new AccountRepository();

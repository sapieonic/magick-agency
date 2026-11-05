/*
 * Adding an account to a tenant: the one write both `POST /accounts` (a tenant admin in
 * the console) and `POST /super-admin/tenants/:id/accounts` make. The routes own who may
 * call it and what gets audited; this owns the name rule, the slug, and what the new
 * account starts with (decisions AA2–AA4).
 *
 * ── What a new account starts with ──────────────────────────────────────────
 * Its row, and, when a tenant admin made it, an `account_settings` row holding
 * `max_concurrent_calls = 0`. Without that row the account would read the platform default
 * (5, `settings/agency-account-settings.ts`), and there is no tenant-wide cap: a tenant
 * admin could add capacity, and carrier calls outside any provider breakdown a super admin
 * set, by adding accounts. Call capacity stays a super-admin act (the Service tab), so the
 * account can be set up (campaigns, people) but places no call until a super admin gives it
 * a limit. A super admin's create writes no settings row: it is the same person who sets
 * the limit. Untagged phone numbers serve every account in the tenant, and feature flags
 * fall back from account to tenant, so nothing else is needed.
 */
import { randomBytes } from 'node:crypto';
import { getPool } from '@magick-agency/db';
import { withTransaction } from '@magick-agency/db/utils/transaction';
import type { AccountRecord } from '@magick-agency/db/models/account.model';

export type CreateTenantAccountResult =
  | { status: 'created'; account: AccountRecord }
  | { status: 'name_taken' }
  | { status: 'tenant_not_found' };

export interface CreateTenantAccountOptions {
  /**
   * The account's `max_concurrent_calls` when it must not take the platform default:
   * `0` for a tenant admin's create (see the module note). Absent writes no settings row.
   */
  initialMaxConcurrentCalls?: number;
}

const SLUG_BASE_MAX = 40;

/**
 * How two names are compared for "already taken": Unicode-compatibility folded, trimmed,
 * inner whitespace collapsed, case-folded. "Sales ", "sales" and "SALES" are one name in a
 * switcher, so they are one name here. (Invisible format characters never get this far:
 * the schema refuses them.)
 */
export function accountNameKey(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * The slug a name starts from: lower-case ASCII letters and digits joined by single dashes,
 * at most 40 characters, accents dropped ("Crème" → `creme`). Empty when the name has no
 * ASCII letter or digit at all (a name in another script); the caller substitutes `account`.
 */
export function accountSlugBase(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_BASE_MAX)
    .replace(/-+$/g, '');
}

function slugSuffix(): string {
  return randomBytes(3).toString('hex');
}

/**
 * Create a live account named `name` (already trimmed and checked by the route's schema)
 * in `tenantId`, or say why not.
 *
 * ── One create per tenant at a time ─────────────────────────────────────────
 * The whole create is one transaction that first locks the tenant's row `FOR NO KEY
 * UPDATE`. A second create in the same tenant waits there, so the name check and the slug
 * choice always see every account committed before them: a double-submitted "Sales" ends as
 * one account and one `name_taken`, whether or not its slug needed a suffix. The lock mode
 * does not conflict with the `FOR KEY SHARE` that foreign-key checks take, so inserts of
 * other rows that reference the tenant (memberships, campaigns) are never blocked by it.
 * The same read answers "does the tenant exist and is it live" (`tenant_not_found`).
 *
 * The slug is the name's base when no live account holds it, else the base with a random
 * six-hex suffix not already taken. The partial unique index `idx_accounts_tenant_slug_active`
 * stays the last word; under the lock it cannot be hit by another create.
 */
export async function createTenantAccount(
  tenantId: string,
  name: string,
  options: CreateTenantAccountOptions = {},
): Promise<CreateTenantAccountResult> {
  return withTransaction(async (client) => {
    const tenant = await client.query(
      `SELECT id FROM tenants WHERE id = $1 AND status != 'deleted' FOR NO KEY UPDATE`,
      [tenantId],
    );
    if (tenant.rowCount === 0) return { status: 'tenant_not_found' };

    const live = await client.query<Pick<AccountRecord, 'name' | 'slug'>>(
      `SELECT name, slug FROM accounts WHERE tenant_id = $1 AND status != 'deleted'`,
      [tenantId],
    );
    const key = accountNameKey(name);
    if (live.rows.some((a) => accountNameKey(a.name) === key)) return { status: 'name_taken' };

    const takenSlugs = new Set(live.rows.map((a) => a.slug));
    const base = accountSlugBase(name) || 'account';
    let slug = base;
    while (takenSlugs.has(slug)) slug = `${base}-${slugSuffix()}`;

    const inserted = await client.query<AccountRecord>(
      `INSERT INTO accounts (tenant_id, name, slug) VALUES ($1, $2, $3) RETURNING *`,
      [tenantId, name, slug],
    );
    const account = inserted.rows[0]!;

    if (options.initialMaxConcurrentCalls !== undefined) {
      await client.query(
        `INSERT INTO account_settings (tenant_id, account_id, max_concurrent_calls) VALUES ($1, $2, $3)`,
        [tenantId, account.id, options.initialMaxConcurrentCalls],
      );
    }

    return { status: 'created', account };
  }, { pool: getPool() });
}

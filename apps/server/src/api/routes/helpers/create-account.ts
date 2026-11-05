/*
 * Adding an account to a tenant: the one write both `POST /accounts` (a tenant admin
 * in the console) and `POST /super-admin/tenants/:id/accounts` make. The routes own who
 * may call it and what gets audited; this owns what an account's name and slug must be.
 *
 * A new account needs no other row to work. With no `account_settings` row it reads
 * the defaults (`settings/agency-account-settings.ts`: recording and analysis off, 5
 * concurrent calls, legacy-total concurrency), untagged phone numbers serve every
 * account in the tenant, and feature flags fall back from account to tenant.
 */
import { randomBytes } from 'node:crypto';
import { accountRepository } from '@magick-agency/db/repositories/account.repository';
import type { AccountRecord } from '@magick-agency/db/models/account.model';

export type CreateTenantAccountResult =
  | { status: 'created'; account: AccountRecord }
  | { status: 'name_taken' };

/** The partial unique index on `accounts (tenant_id, slug)` for live rows. */
const SLUG_INDEX = 'idx_accounts_tenant_slug_active';
const SLUG_BASE_MAX = 40;
const SLUG_ATTEMPTS = 4;

/**
 * How two names are compared for "already taken": trimmed, inner whitespace
 * collapsed, Unicode-compatibility folded, case-folded. "Sales ", "sales" and
 * "SALES" are one name in a switcher, so they are one name here.
 */
export function accountNameKey(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * The slug a name starts from: lower-case ASCII letters and digits joined by
 * single dashes, at most 40 characters. Empty when the name has no ASCII letter
 * or digit at all (a name in another script); the caller substitutes `account`.
 */
export function accountSlugBase(name: string): string {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_BASE_MAX)
    .replace(/-+$/g, '');
}

function slugSuffix(): string {
  return randomBytes(3).toString('hex');
}

function isSlugConflict(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; constraint?: unknown };
  return e.code === '23505' && e.constraint === SLUG_INDEX;
}

async function nameTaken(tenantId: string, name: string): Promise<AccountRecord[] | null> {
  const live = await accountRepository.findByTenantId(tenantId);
  const key = accountNameKey(name);
  return live.some((a) => accountNameKey(a.name) === key) ? null : live;
}

/**
 * Create a live account named `name` (already trimmed and length-checked by the
 * route's schema) in `tenantId`, or report that the tenant already has one by that
 * name.
 *
 * The slug is the name's base when that is free, else the base with a random
 * six-hex suffix. Uniqueness is the index's job, not this read's: a create that
 * loses a race for the slug re-checks the NAME before trying a suffixed slug, so two
 * concurrent creates of "Sales" end as one account and one `name_taken`, not two
 * accounts both called "Sales". Two different names that slug alike ("Sales!" and
 * "Sales?") both succeed, one with a suffix.
 */
export async function createTenantAccount(tenantId: string, name: string): Promise<CreateTenantAccountResult> {
  const live = await nameTaken(tenantId, name);
  if (live === null) return { status: 'name_taken' };

  const base = accountSlugBase(name) || 'account';
  const takenSlugs = new Set(live.map((a) => a.slug));
  let slug = takenSlugs.has(base) ? `${base}-${slugSuffix()}` : base;

  for (let attempt = 1; ; attempt++) {
    try {
      const account = await accountRepository.create({ tenant_id: tenantId, name, slug });
      return { status: 'created', account };
    } catch (err) {
      if (!isSlugConflict(err) || attempt >= SLUG_ATTEMPTS) throw err;
      if ((await nameTaken(tenantId, name)) === null) return { status: 'name_taken' };
      slug = `${base}-${slugSuffix()}`;
    }
  }
}

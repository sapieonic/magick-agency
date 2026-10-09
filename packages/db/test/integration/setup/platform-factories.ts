import { randomUUID } from 'node:crypto';
import { getTestPool } from './test-utils.js';
import { insertAccount, insertTenant, insertUser } from './factories.js';

/**
 * PORT NOTE (magick-agency, lane A): the identity/phone half of master's
 * `test/integration/setup/factories.ts@a1f0756a`, verbatim, for the platform
 * suites in packages/db and apps/server. A new file beside the lead's
 * `factories.ts` (which already carries master's `insertTenant` / `insertAccount`
 * / `insertUser`, re-exported here). Not carried: the credit, rate-card,
 * API-key, bulk-dispatch, contact-list and workflow factories (none of those
 * tables exist). `provisionTenant` drops its credit-balance row (no credits,
 * plan Decided #8); everything else it builds is master's.
 */
export { insertAccount, insertTenant, insertUser };

/** Generic INSERT helper — builds a parameterized INSERT from a key/value map. */
async function insertRow(table: string, overrides: Record<string, unknown>, defaults: Record<string, unknown>) {
  const pool = getTestPool();
  const merged = { ...defaults, ...overrides };
  const cols = Object.keys(merged);
  const vals = Object.values(merged);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');

  const { rows } = await pool.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`,
    vals,
  );
  return rows[0];
}

// ── Membership ──────────────────────────────────────────────────────────────

export async function insertMembership(overrides: Record<string, unknown> = {}) {
  return insertRow('memberships', overrides, {
    id: randomUUID(),
    user_id: randomUUID(),
    tenant_id: randomUUID(),
    account_id: null,
    role: 'tenant_admin',
    status: 'active',
  });
}

// ── Membership Invite ───────────────────────────────────────────────────────

/**
 * One `membership_invites` row (migration 069).
 *
 * Defaults to an OUTSTANDING `agent` invite — unclaimed, unrevoked, a week of
 * TTL left — because that is the row `POST /users/invite` writes and the state
 * every other one is reached from. Override `claimed_at` for a joined agent and
 * `revoked_at` for one superseded by a resend.
 *
 * `GET /tenants/:id/members` does NOT read this table: `invite_state` is derived
 * from `users.firebase_uid` alone. These rows exist in that suite as NEGATIVE
 * fixtures — they are what proves an outstanding, claimed or absent invite makes
 * no difference to a member who has signed in. See `membership-invite-state.ts`.
 *
 * Note the partial unique index `uq_membership_invites_live`: a membership may
 * hold at most ONE row that is both unclaimed and unrevoked, so modelling a
 * resend means claiming or revoking the earlier row, exactly as production does.
 *
 * `token_hash` is a fresh UUID rather than a real sha256 — the column is UNIQUE
 * and nothing under test resolves by it; a fixed literal would collide the
 * second time a test inserted one.
 */
export async function insertMembershipInvite(overrides: Record<string, unknown> = {}) {
  return insertRow('membership_invites', overrides, {
    id: randomUUID(),
    membership_id: randomUUID(), // must be overridden with a real membership FK
    tenant_id: randomUUID(), // must be overridden
    email: `invitee-${randomUUID().slice(0, 8)}@example.com`,
    role: 'agent',
    token_hash: randomUUID(),
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });
}

// ── Telephony Provider ──────────────────────────────────────────────────────

export async function insertTelephonyProvider(overrides: Record<string, unknown> = {}) {
  return insertRow('telephony_providers', overrides, {
    id: randomUUID(),
    name: `provider-${Date.now()}`,
    display_name: `Test Provider ${Date.now()}`,
    status: 'active',
  });
}

// ── Phone Number ────────────────────────────────────────────────────────────

export async function insertPhoneNumber(overrides: Record<string, unknown> = {}) {
  return insertRow('phone_numbers', overrides, {
    id: randomUUID(),
    phone_number: `+1${Math.floor(2000000000 + Math.random() * 7999999999)}`,
    provider_id: randomUUID(), // must be overridden
    label: 'Test Phone',
    capabilities: '{voice,sms}', // Postgres TEXT[] literal
    status: 'active',
    max_concurrent_calls: 10,
  });
}

// ── Tenant Phone Assignment ─────────────────────────────────────────────────

export async function insertPhoneAssignment(overrides: Record<string, unknown> = {}) {
  return insertRow('tenant_phone_assignments', overrides, {
    id: randomUUID(),
    tenant_id: randomUUID(), // must be overridden
    phone_number_id: randomUUID(), // must be overridden
    is_default: false,
  });
}

// ── Phone Account Tag ───────────────────────────────────────────────────────

export async function insertPhoneAccountTag(overrides: Record<string, unknown> = {}) {
  return insertRow('phone_account_tags', overrides, {
    id: randomUUID(),
    assignment_id: randomUUID(), // must be overridden
    account_id: randomUUID(), // must be overridden
    is_default: false,
  });
}

// ── Composite helpers ───────────────────────────────────────────────────────

/**
 * Provision a full tenant with user, account and membership.
 * Returns all created entities. (PORT NOTE: master's credit balance removed.)
 */
export async function provisionTenant(opts: {
  role?: string;
  phone?: boolean;
} = {}) {
  const tenant = await insertTenant();
  const account = await insertAccount({ tenant_id: tenant.id });
  const user = await insertUser();
  const membership = await insertMembership({
    user_id: user.id,
    tenant_id: tenant.id,
    role: opts.role || 'tenant_owner',
  });

  let provider, phoneNumber, phoneAssignment;
  if (opts.phone) {
    provider = await insertTelephonyProvider();
    phoneNumber = await insertPhoneNumber({ provider_id: provider.id });
    phoneAssignment = await insertPhoneAssignment({
      tenant_id: tenant.id,
      phone_number_id: phoneNumber.id,
      is_default: true,
    });
  }

  return { tenant, account, user, membership, provider, phoneNumber, phoneAssignment };
}

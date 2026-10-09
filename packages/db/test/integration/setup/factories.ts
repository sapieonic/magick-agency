import { createHash, randomUUID } from 'node:crypto';
import { getTestPool } from './test-utils.js';

/**
 * PORT NOTE (magick-agency): the subset of core's
 * `test/integration/setup/factories.ts` that the shared-infrastructure suites
 * use (`insertAccountSettings`, `insertWebrtcCall`). Plan-required changes:
 *  - tenant/account ids are UUIDs (the baseline types them UUID; core used
 *    `'test-tenant'` / `'test-account'`);
 *  - `insertWebrtcCall` writes `agency_calls` (the renamed `webrtc_calls`),
 *    defaults `provider` to `'voicelink'` (VoBiz deleted) and sets a
 *    `campaign_id`, because every agency call is a campaign call and the
 *    repository's only scope (`'agency'`) is `campaign_id IS NOT NULL`. Pass
 *    `campaign_id: null` to build the row the scope must refuse.
 *
 * Plus master's `insertTenant` / `insertAccount` / `insertUser` (and its
 * `insertRow` helper) from master `test/integration/setup/factories.ts@a1f0756a`,
 * verbatim, for the ported staffing suites. Master's ids were already UUIDs.
 */
export const DEFAULTS = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  accountId: '22222222-2222-4222-8222-222222222222',
  campaignId: '33333333-3333-4333-8333-333333333333',
} as const;

/** A second tenant / account for isolation assertions (core: 'other-tenant' / 'other-account'). */
export const OTHER_TENANT = '44444444-4444-4444-8444-444444444444';
export const OTHER_ACCOUNT = '55555555-5555-4555-8555-555555555555';

/**
 * A stable UUID for a source fixture's free-form id label (`'tenant-1'`,
 * `'account-A'`, …). Ported suites wrap each label in it, so a test keeps its
 * own vocabulary — two calls with one label are one id, two labels are two ids —
 * while the baseline's UUID columns accept the value.
 */
export function uuidFor(label: string): string {
  const h = createHash('md5').update(label).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export async function insertAccountSettings(overrides: Record<string, unknown> = {}) {
  const pool = getTestPool();
  const defaults = {
    id: randomUUID(),
    tenant_id: DEFAULTS.tenantId,
    account_id: DEFAULTS.accountId,
    max_concurrent_calls: 5,
  };
  const merged = { ...defaults, ...overrides };
  const cols = Object.keys(merged);
  const vals = Object.values(merged);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');

  const { rows } = await pool.query(
    `INSERT INTO account_settings (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`,
    vals,
  );
  return rows[0];
}

export async function insertWebrtcCall(overrides: Record<string, unknown> = {}) {
  const pool = getTestPool();
  const defaults = {
    id: randomUUID(),
    tenant_id: DEFAULTS.tenantId,
    account_id: DEFAULTS.accountId,
    caller_id: '+14155550100',
    destination_phone: '+14155550199',
    provider: 'voicelink',
    status: 'initiating',
    metadata: JSON.stringify({}),
    campaign_id: DEFAULTS.campaignId,
  };
  const merged = { ...defaults, ...overrides };
  const cols = Object.keys(merged);
  const vals = Object.values(merged);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');

  const { rows } = await pool.query(
    `INSERT INTO agency_calls (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`,
    vals,
  );
  return rows[0];
}

// ── master test/integration/setup/factories.ts (verbatim) ────────────────────

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

export async function insertTenant(overrides: Record<string, unknown> = {}) {
  const uid = randomUUID().slice(0, 8);
  return insertRow('tenants', overrides, {
    id: randomUUID(),
    name: `Test Tenant ${uid}`,
    slug: `test-tenant-${uid}`,
    settings: JSON.stringify({}),
    status: 'active',
  });
}

export async function insertAccount(overrides: Record<string, unknown> = {}) {
  return insertRow('accounts', overrides, {
    id: randomUUID(),
    tenant_id: randomUUID(), // must be overridden with a real tenant FK
    name: `Test Account ${randomUUID().slice(0, 8)}`,
    slug: `test-account-${randomUUID().slice(0, 8)}`,
    settings: JSON.stringify({}),
    status: 'active',
  });
}

export async function insertUser(overrides: Record<string, unknown> = {}) {
  const uid = randomUUID();
  return insertRow('users', overrides, {
    id: randomUUID(),
    firebase_uid: `fb-${uid}`,
    email: `test-${uid}@example.com`,
    display_name: 'Test User',
    status: 'active',
  });
}

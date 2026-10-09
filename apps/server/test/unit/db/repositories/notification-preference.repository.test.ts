import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `user_notification_preferences` — the sparse per-user overrides, plus the
 * audience read the whole engine is built on.
 *
 * The pool is mocked, so nothing here observes which ROWS a predicate selects.
 * Assertions target what a mocked pool CAN see and what would otherwise break
 * silently: the `ON CONFLICT` target (it must name the columns of
 * `uq_user_notification_preferences`, migration 072), the `::uuid` casts and the
 * guards that keep a bad id away from them, the bind parameters, the statement
 * count, and the row→value mapping. Anything that needs a real database — that
 * `user_id = ANY(...)` is actually served by the unique index's leading column,
 * that a duplicate conflict key really raises `21000` — is noted in a comment
 * and left to the integration suite.
 *
 * ── `upsertMany` — the settings page's whole-form save ────────────────────
 *
 * The case pinned here is the one a mocked pool can still see: that the
 * statement never carries the same conflict key twice. Postgres answers a
 * duplicate inside one `ON CONFLICT DO UPDATE` with `21000 — command cannot
 * affect row a second time` (reproduced against a real Postgres 16), and the
 * save surfaces as a masked 500. The route's validator refuses duplicates today,
 * so the fault is unreachable through it — but that is a property of one caller,
 * and this is a public method.
 */

const mocks = vi.hoisted(() => ({ pool: { query: vi.fn() } }));
vi.mock('@magick-agency/db', () => ({ getPool: () => mocks.pool }));

import { notificationPreferenceRepository } from '../../../../src/db/repositories/notification-preference.repository.js';
import type { UpsertNotificationPreferenceInput } from '../../../../src/db/models/notification.model.js';

const USER = '44444444-4444-4444-8444-444444444444';
const OTHER_USER = '55555555-5555-4555-8555-555555555555';
const TENANT = '11111111-1111-4111-8111-111111111111';

// Typed as `UpsertNotificationPreferenceInput`: lint typechecks tests (decision B1), and the
// inferred `frequency: string` does not satisfy `DigestFrequency | null`.
function pref(over: Record<string, unknown> = {}): UpsertNotificationPreferenceInput {
  return {
    user_id: USER, tenant_id: TENANT, event_key: 'usage.digest',
    channel: 'email', enabled: true, frequency: 'weekly',
    ...over,
  } as UpsertNotificationPreferenceInput;
}

/** The six parallel arrays `unnest` expands. */
function params() {
  return mocks.pool.query.mock.calls[0]![1] as [
    string[], string[], string[], string[], boolean[], (string | null)[],
  ];
}

describe('notificationPreferenceRepository.upsertMany', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pool.query.mockResolvedValue({ rows: [] });
  });

  it('writes one statement for the whole form', async () => {
    await notificationPreferenceRepository.upsertMany([
      pref(),
      pref({ event_key: 'campaign.completed', frequency: null }),
    ]);
    expect(mocks.pool.query).toHaveBeenCalledTimes(1);
    expect(params()[2]).toEqual(['usage.digest', 'campaign.completed']);
  });

  it('collapses a duplicate conflict key, last write winning', async () => {
    await notificationPreferenceRepository.upsertMany([
      pref({ enabled: true, frequency: 'weekly' }),
      pref({ enabled: false, frequency: null }),
    ]);

    const [users, , eventKeys, , enabled, frequency] = params();
    expect(users).toEqual([USER]);
    expect(eventKeys).toEqual(['usage.digest']);
    expect(enabled).toEqual([false]);
    expect(frequency).toEqual([null]);
  });

  it('keeps rows that differ in ANY part of the conflict key', async () => {
    // Same event, different channel / user — genuinely different rows, and
    // collapsing them would silently drop a save.
    await notificationPreferenceRepository.upsertMany([
      pref(),
      pref({ channel: 'sms' }),
      pref({ user_id: OTHER_USER }),
    ]);
    expect(params()[2]).toHaveLength(3);
  });

  it('drops rows whose ids are not uuids rather than letting 22P02 reach the pool', async () => {
    await notificationPreferenceRepository.upsertMany([
      pref(),
      pref({ user_id: 'not-a-uuid' }),
      pref({ tenant_id: 'default' }),
    ]);
    expect(params()[0]).toEqual([USER]);
  });

  it('does not query at all when nothing survives validation', async () => {
    await notificationPreferenceRepository.upsertMany([pref({ user_id: 'nope' })]);
    expect(mocks.pool.query).not.toHaveBeenCalled();
  });

  it('does not query at all for an empty batch', async () => {
    expect(await notificationPreferenceRepository.upsertMany([])).toEqual([]);
    expect(mocks.pool.query).not.toHaveBeenCalled();
  });
});

/** A stored row as it comes back from `SELECT *`. */
function record(over: Record<string, unknown> = {}) {
  return {
    id: '77777777-7777-4777-8777-777777777777',
    user_id: USER, tenant_id: TENANT, event_key: 'usage.digest',
    channel: 'email', enabled: false, frequency: null,
    created_at: new Date('2026-02-01T00:00:00.000Z'),
    updated_at: new Date('2026-02-01T00:00:00.000Z'),
    ...over,
  };
}

const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim();

function call(i = 0) {
  const [sql, params] = mocks.pool.query.mock.calls[i]! as [string, unknown[]];
  return { sql: norm(sql), params };
}

describe('notificationPreferenceRepository.findForUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pool.query.mockResolvedValue({ rows: [] });
  });

  it('reads one user in one tenant, ordered for a stable settings page', async () => {
    await notificationPreferenceRepository.findForUser(USER, TENANT);

    const { sql, params } = call();
    expect(sql).toContain('SELECT * FROM user_notification_preferences');
    expect(sql).toContain('WHERE user_id = $1::uuid AND tenant_id = $2::uuid');
    expect(sql).toContain('ORDER BY event_key, channel');
    expect(params).toEqual([USER, TENANT]);
  });

  it('scopes by tenant as well as user — the same person chooses per workspace', async () => {
    // The stored scope is `(user, tenant)`, deliberately not
    // `(user, tenant, account)`: one person can belong to several tenants and
    // reasonably want a different answer in each. Dropping the tenant predicate
    // would leak one workspace's choices onto another's settings page.
    await notificationPreferenceRepository.findForUser(USER, TENANT);
    expect(call().sql).toContain('tenant_id = $2::uuid');
  });

  it('serves rows naming RETIRED event keys instead of filtering them here', async () => {
    // `event_key` is TEXT, not an enum or an FK. A row naming a key this build
    // no longer has is INERT — the caller filters against the live catalog,
    // because a key removed by mistake and restored next release must not have
    // taken every customer's preference with it in the meantime.
    const rows = [record({ event_key: 'campaign.retired' }), record()];
    mocks.pool.query.mockResolvedValue({ rows });
    expect(await notificationPreferenceRepository.findForUser(USER, TENANT)).toEqual(rows);
  });

  it('returns an empty array for a user who has never opened the settings page', async () => {
    // The overrides are SPARSE: no rows is the normal state, and it means
    // "every catalog default applies", not "everything is off".
    mocks.pool.query.mockResolvedValue({ rows: [] });
    expect(await notificationPreferenceRepository.findForUser(USER, TENANT)).toEqual([]);
  });

  it('is a no-op for a non-uuid user or tenant, before the cast can 22P02', async () => {
    expect(await notificationPreferenceRepository.findForUser('me', TENANT)).toEqual([]);
    expect(await notificationPreferenceRepository.findForUser(USER, 'default')).toEqual([]);
    expect(await notificationPreferenceRepository.findForUser('', '')).toEqual([]);
    expect(mocks.pool.query).not.toHaveBeenCalled();
  });
});

describe('notificationPreferenceRepository.findForUsersAndEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pool.query.mockResolvedValue({ rows: [] });
  });

  it('reads a whole audience for ONE event in ONE round trip', async () => {
    // The reason this is not `findForUser` in a loop: a fan-out over every
    // active tenant would otherwise issue one query per recipient per tenant per
    // period against the same 20-slot pool the settlement path is using.
    await notificationPreferenceRepository.findForUsersAndEvent(
      TENANT, 'usage.digest', [USER, OTHER_USER],
    );

    expect(mocks.pool.query).toHaveBeenCalledTimes(1);
    const { sql, params } = call();
    expect(sql).toContain('WHERE tenant_id = $1::uuid');
    expect(sql).toContain('AND event_key = $2');
    expect(sql).toContain('AND channel = $3');
    // ANY over a uuid[], served by the leading column of
    // `uq_user_notification_preferences` — that the index is actually chosen is
    // an EXPLAIN question for the integration suite.
    expect(sql).toContain('AND user_id = ANY($4::uuid[])');
    expect(params).toEqual([TENANT, 'usage.digest', 'email', [USER, OTHER_USER]]);
  });

  it("defaults the channel to 'email' and honours an explicit one", async () => {
    await notificationPreferenceRepository.findForUsersAndEvent(TENANT, 'usage.digest', [USER]);
    expect(call().params[2]).toBe('email');

    mocks.pool.query.mockClear();
    await notificationPreferenceRepository.findForUsersAndEvent(TENANT, 'usage.digest', [USER], 'sms');
    expect(call().params[2]).toBe('sms');
  });

  it('drops non-uuid ids from the array rather than passing them to the cast', async () => {
    // The array comes from a membership read so the ids always are uuids — but
    // an empty result is a better failure than a 22P02 that kills a scheduled
    // run mid-fan-out, taking every remaining tenant's digest with it.
    await notificationPreferenceRepository.findForUsersAndEvent(
      TENANT, 'usage.digest', [USER, 'not-a-uuid', '', 'default', OTHER_USER],
    );
    expect(call().params[3]).toEqual([USER, OTHER_USER]);
  });

  it('is a no-op when no id survives, when the list is empty, or the tenant is not a uuid', async () => {
    expect(await notificationPreferenceRepository.findForUsersAndEvent(TENANT, 'e', ['nope'])).toEqual([]);
    expect(await notificationPreferenceRepository.findForUsersAndEvent(TENANT, 'e', [])).toEqual([]);
    expect(await notificationPreferenceRepository.findForUsersAndEvent('default', 'e', [USER])).toEqual([]);
    expect(mocks.pool.query).not.toHaveBeenCalled();
  });

  it('returns the stored rows as they came back, one per user who chose', async () => {
    // Sparse again: the audience is 2 users and the result may be 0, 1 or 2
    // rows. The caller pairs them up; a missing row is the catalog default.
    const rows = [record({ enabled: false }), record({ user_id: OTHER_USER, enabled: true })];
    mocks.pool.query.mockResolvedValue({ rows });
    expect(await notificationPreferenceRepository.findForUsersAndEvent(
      TENANT, 'usage.digest', [USER, OTHER_USER],
    )).toEqual(rows);
  });
});

describe('notificationPreferenceRepository.upsert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pool.query.mockResolvedValue({ rows: [record()] });
  });

  it('upserts against uq_user_notification_preferences rather than read-then-write', async () => {
    // Two settings-page saves racing (two tabs, a double-click) would both see
    // "no row" and both INSERT, and one would take a `23505` that reaches the
    // customer as a masked 500 on a toggle. The conflict target must be exactly
    // the unique constraint's four columns (migration 072); ON CONFLICT infers
    // the index from the column set, so a missing column silently picks another
    // index or none at all.
    await notificationPreferenceRepository.upsert(pref() as UpsertNotificationPreferenceInput);

    const { sql } = call();
    const target = sql.match(/ON CONFLICT \(([^)]*)\)/)![1]!.split(',').map((c) => c.trim());
    expect([...target].sort()).toEqual(['channel', 'event_key', 'tenant_id', 'user_id']);
    expect(sql).toContain('DO UPDATE SET enabled = EXCLUDED.enabled, frequency = EXCLUDED.frequency');
    expect(sql).toContain('RETURNING *');
  });

  it('binds the row in column order, casting both ids to uuid', async () => {
    await notificationPreferenceRepository.upsert(pref({ enabled: false, frequency: 'daily' }) as UpsertNotificationPreferenceInput);
    const { sql, params } = call();
    expect(sql).toContain('VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)');
    expect(params).toEqual([USER, TENANT, 'usage.digest', 'email', false, 'daily']);
  });

  it('writes frequency unconditionally, including down to NULL', async () => {
    // An upsert that left `frequency` alone when absent would let a stale
    // 'weekly' survive on an event that had since become immediate-cadence, and
    // the stored value would then disagree with what the settings page shows.
    // NULL means "not applicable", which is a fact, not an unset.
    await notificationPreferenceRepository.upsert(pref({ frequency: undefined }) as UpsertNotificationPreferenceInput);
    expect(call().params[5]).toBeNull();

    mocks.pool.query.mockClear();
    await notificationPreferenceRepository.upsert(pref({ frequency: null }) as UpsertNotificationPreferenceInput);
    expect(call().params[5]).toBeNull();
  });

  it('returns the written row, and null when nothing came back', async () => {
    const row = record({ enabled: true, frequency: 'weekly' });
    mocks.pool.query.mockResolvedValue({ rows: [row] });
    expect(await notificationPreferenceRepository.upsert(pref() as UpsertNotificationPreferenceInput)).toEqual(row);

    mocks.pool.query.mockResolvedValue({ rows: [] });
    expect(await notificationPreferenceRepository.upsert(pref() as UpsertNotificationPreferenceInput)).toBeNull();
  });

  it('returns null without querying for a non-uuid user or tenant', async () => {
    expect(await notificationPreferenceRepository.upsert(pref({ user_id: 'me' }) as UpsertNotificationPreferenceInput)).toBeNull();
    expect(await notificationPreferenceRepository.upsert(pref({ tenant_id: 'default' }) as UpsertNotificationPreferenceInput)).toBeNull();
    expect(mocks.pool.query).not.toHaveBeenCalled();
  });
});

describe('notificationPreferenceRepository.findNotifiableMembers', () => {
  const member = (over: Record<string, unknown> = {}) => ({
    user_id: USER, email: 'ops@example.com', role: 'account_admin', account_id: null, ...over,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pool.query.mockResolvedValue({ rows: [] });
  });

  it('selects user_id, email, role AND account_id — the four the engine needs', async () => {
    // Deliberately NOT `userRepository.findAddressableMembersInAccount`, which
    // is `SELECT DISTINCT u.email, m.role`: no `user_id`, so preferences (keyed
    // by user) cannot be looked up, and no `account_id`, so a digest cannot be
    // scoped to the recipient's own account. Its DISTINCT on email also
    // collapses two people who share an address, which `users.email` permits
    // because it carries only a NON-unique index (migration 069).
    await notificationPreferenceRepository.findNotifiableMembers(TENANT);

    const { sql, params } = call();
    expect(sql).toContain('SELECT m.user_id, u.email, m.role, m.account_id');
    expect(sql).not.toContain('DISTINCT');
    expect(sql).toContain('FROM memberships m JOIN users u ON u.id = m.user_id');
    expect(sql).toContain('WHERE m.tenant_id = $1::uuid');
    expect(sql).toContain('ORDER BY u.email');
    expect(params).toEqual([TENANT]);
  });

  it('requires BOTH the membership and the user to be active', async () => {
    // Note the asymmetry with the agency performance routes, which deliberately
    // do NOT filter status when NAMING a departed colleague: naming somebody in
    // a report and mailing them are different acts, and a revoked member must
    // stop receiving mail about a workspace they were removed from.
    await notificationPreferenceRepository.findNotifiableMembers(TENANT);
    const { sql } = call();
    expect(sql).toContain("AND m.status = 'active'");
    expect(sql).toContain("AND u.status = 'active'");
  });

  it('excludes rows with no usable address', async () => {
    // An empty-string email is not NULL and would otherwise reach the claim as
    // a recipient, burning a dedupe key for an inbox that does not exist.
    await notificationPreferenceRepository.findNotifiableMembers(TENANT);
    const { sql } = call();
    expect(sql).toContain('AND u.email IS NOT NULL');
    expect(sql).toContain("AND u.email <> ''");
  });

  it('returns membership ROWS — one per membership, collapsing nothing', async () => {
    // Both collapse rules live above the database: a user holding a
    // tenant-level AND an account-scoped membership appears twice and
    // `resolveAudience` keeps the WIDEST scope (one digest, whole tenant); two
    // different users sharing an address appear twice with different user_ids,
    // and the address is sent to if ANY of them wants the event, because an
    // inbox cannot be half-subscribed. Collapsing here would destroy the
    // information both rules are decided from.
    const rows = [
      member({ account_id: null }),
      member({ account_id: '33333333-3333-4333-8333-333333333333', role: 'operator' }),
      member({ user_id: OTHER_USER, email: 'ops@example.com' }),
    ];
    mocks.pool.query.mockResolvedValue({ rows });

    const result = await notificationPreferenceRepository.findNotifiableMembers(TENANT);
    expect(result).toEqual(rows);
    expect(result).toHaveLength(3);
    expect(result[0]!.account_id).toBeNull();
  });

  it('returns an empty array for a tenant with nobody notifiable', async () => {
    mocks.pool.query.mockResolvedValue({ rows: [] });
    expect(await notificationPreferenceRepository.findNotifiableMembers(TENANT)).toEqual([]);
  });

  it('is a no-op for a non-uuid tenant', async () => {
    // The campaign gate calls this with a tenant id off a `bulk_dispatch_jobs`
    // row, whose column is VARCHAR — so a non-uuid genuinely arrives here, and
    // a 22P02 would take the preference lookup down. It fails OPEN there
    // (everybody named on the campaign is mailed), which only works if this
    // returns empty instead of throwing.
    expect(await notificationPreferenceRepository.findNotifiableMembers('default')).toEqual([]);
    expect(await notificationPreferenceRepository.findNotifiableMembers('')).toEqual([]);
    expect(mocks.pool.query).not.toHaveBeenCalled();
  });
});

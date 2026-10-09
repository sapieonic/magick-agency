/**
 * `user_notification_preferences` and the audience reads, against REAL Postgres.
 *
 * ── What only a real database can decide here ──────────────────────────────
 *
 *   - **`upsertMany`'s `unnest` + `ON CONFLICT DO UPDATE`.** Six parallel arrays
 *     expanded into rows by Postgres. A mocked pool never expands them, so
 *     "the arrays are the same length and in the same order" is unasserted, and
 *     so is which row wins a conflict.
 *   - **`21000 — ON CONFLICT DO UPDATE command cannot affect row a second
 *     time`.** The repository de-duplicates its input *because* of this error,
 *     and the error exists only in Postgres. This file raises it deliberately
 *     against the same statement shape, then shows the dedupe prevents it —
 *     which is the only way to demonstrate the guard is load-bearing rather
 *     than defensive.
 *   - **`UNIQUE (user_id, tenant_id, event_key, channel)`** and
 *     **`CHECK (frequency IS NULL OR frequency IN ('daily','weekly'))`**.
 *     TypeScript's `DigestFrequency` is not enforcement.
 *   - **`findNotifiableMembers`' join and its two `status` predicates**, against
 *     real `memberships`/`users` rows — including the two shapes the schema
 *     permits and the engine has collapse rules for: one user with a
 *     tenant-level AND an account-scoped membership, and two users sharing one
 *     email (`users.email` carries only a NON-unique index, migration 069).
 *   - **The `updated_at` trigger**, which is a schema object, not code.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { closePool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL, getTestPool, closeTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { insertTenant, insertAccount, insertUser, insertMembership } from '../../../../../packages/db/test/integration/setup/platform-factories.js';
import { randomUUID } from 'node:crypto';

// PORT NOTE (magick-agency): master mocks `src/db/connection.js` to the test
// pool; here the real `@magick-agency/db` pool is initialised against the test
// database, so the repository (and `membershipRepository`, imported below) run
// on the production connection module. `event_key` values such as
// `usage.digest` are opaque TEXT to this repository and are kept as master wrote
// them — the table has no FK or CHECK on the key.
initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });

const { notificationPreferenceRepository: repo } = await import(
  '../../../src/db/repositories/notification-preference.repository.js'
);

const EVENT = 'usage.digest';

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return (err as { code?: string }).code ?? `no-code: ${(err as Error).message}`;
  }
  return 'no-error';
}

async function storedRows(): Promise<Array<Record<string, unknown>>> {
  const { rows } = await getTestPool().query(
    `SELECT * FROM user_notification_preferences ORDER BY event_key, channel`,
  );
  return rows;
}

describe('notificationPreferenceRepository (integration)', () => {
  let tenant: any;
  let user: any;

  beforeEach(async () => {
    await truncateAll();
    tenant = await insertTenant();
    user = await insertUser();
  });

  afterAll(async () => {
    await closePool(); // PORT NOTE (magick-agency): the real pool initialised above
    await closeTestPool();
  });

  // ── upsert ───────────────────────────────────────────────────────────────

  describe('upsert', () => {
    it('inserts, then updates the SAME row on conflict', async () => {
      const inserted = await repo.upsert({
        user_id: user.id,
        tenant_id: tenant.id,
        event_key: EVENT,
        channel: 'email',
        enabled: true,
        frequency: 'weekly',
      });
      expect(inserted).not.toBeNull();
      expect(inserted!.enabled).toBe(true);
      expect(inserted!.frequency).toBe('weekly');

      const updated = await repo.upsert({
        user_id: user.id,
        tenant_id: tenant.id,
        event_key: EVENT,
        channel: 'email',
        enabled: false,
        frequency: 'daily',
      });

      // Same row — the `ON CONFLICT` target is the unique constraint, so this
      // is an UPDATE rather than a second row.
      expect(updated!.id).toBe(inserted!.id);
      expect(updated!.enabled).toBe(false);
      expect(updated!.frequency).toBe('daily');
      expect(await storedRows()).toHaveLength(1);
    });

    it('writes frequency unconditionally, including back to NULL', async () => {
      await repo.upsert({
        user_id: user.id, tenant_id: tenant.id, event_key: EVENT,
        channel: 'email', enabled: true, frequency: 'daily',
      });

      // An upsert that "left it alone when absent" would leave a stale 'daily'
      // on an event that had become immediate-cadence; the column is the thing
      // the settings page reads back, so the two would disagree.
      const cleared = await repo.upsert({
        user_id: user.id, tenant_id: tenant.id, event_key: EVENT,
        channel: 'email', enabled: true,
      });
      expect(cleared!.frequency).toBeNull();
      expect((await storedRows())[0]!['frequency']).toBeNull();
    });

    it('advances updated_at via the schema trigger, leaving created_at alone', async () => {
      const first = await repo.upsert({
        user_id: user.id, tenant_id: tenant.id, event_key: EVENT,
        channel: 'email', enabled: true, frequency: 'weekly',
      });

      // The trigger fires on UPDATE only, and it is a database object — nothing
      // in the repository sets this column.
      await new Promise((r) => setTimeout(r, 5));
      const second = await repo.upsert({
        user_id: user.id, tenant_id: tenant.id, event_key: EVENT,
        channel: 'email', enabled: false, frequency: 'weekly',
      });

      expect(second!.created_at).toEqual(first!.created_at);
      expect(new Date(second!.updated_at).getTime()).toBeGreaterThan(
        new Date(first!.updated_at).getTime(),
      );
    });

    it('returns null for a non-uuid id rather than raising 22P02', async () => {
      expect(await repo.upsert({
        user_id: 'nope', tenant_id: tenant.id, event_key: EVENT,
        channel: 'email', enabled: true,
      })).toBeNull();
      expect(await storedRows()).toEqual([]);
    });
  });

  // ── The constraints ──────────────────────────────────────────────────────

  describe('constraints', () => {
    it('rejects a duplicate (user, tenant, event, channel) with 23505', async () => {
      const insert = () => getTestPool().query(
        `INSERT INTO user_notification_preferences
           (user_id, tenant_id, event_key, channel, enabled)
         VALUES ($1::uuid, $2::uuid, $3, 'email', true)`,
        [user.id, tenant.id, EVENT],
      );
      await insert();
      expect(await codeOf(insert)).toBe('23505');
    });

    it('separates on channel — the fourth column of the unique key', async () => {
      await repo.upsert({
        user_id: user.id, tenant_id: tenant.id, event_key: EVENT,
        channel: 'email', enabled: true,
      });
      await repo.upsert({
        user_id: user.id, tenant_id: tenant.id, event_key: EVENT,
        channel: 'sms', enabled: false,
      });
      expect(await storedRows()).toHaveLength(2);
    });

    it('separates on tenant — one person, two workspaces, two answers', async () => {
      const other = await insertTenant();
      await repo.upsert({
        user_id: user.id, tenant_id: tenant.id, event_key: EVENT,
        channel: 'email', enabled: true, frequency: 'weekly',
      });
      await repo.upsert({
        user_id: user.id, tenant_id: other.id, event_key: EVENT,
        channel: 'email', enabled: false, frequency: null,
      });

      const inA = await repo.findForUser(user.id, tenant.id);
      const inB = await repo.findForUser(user.id, other.id);
      expect(inA).toHaveLength(1);
      expect(inA[0]!.enabled).toBe(true);
      expect(inB).toHaveLength(1);
      expect(inB[0]!.enabled).toBe(false);
    });

    it("accepts 'daily', 'weekly' and NULL for frequency", async () => {
      for (const [i, frequency] of (['daily', 'weekly', null] as const).entries()) {
        await repo.upsert({
          user_id: user.id, tenant_id: tenant.id, event_key: `e${i}`,
          channel: 'email', enabled: true, frequency,
        });
      }
      expect(await storedRows()).toHaveLength(3);
    });

    it('rejects any other frequency with 23514', async () => {
      const code = await codeOf(() =>
        repo.upsert({
          user_id: user.id, tenant_id: tenant.id, event_key: EVENT,
          channel: 'email', enabled: true, frequency: 'monthly' as never,
        }),
      );
      expect(code).toBe('23514');
      expect(await storedRows()).toEqual([]);
    });

    it('CASCADEs on user delete and on tenant delete', async () => {
      await repo.upsert({
        user_id: user.id, tenant_id: tenant.id, event_key: EVENT,
        channel: 'email', enabled: true,
      });
      await getTestPool().query(`DELETE FROM users WHERE id = $1`, [user.id]);
      expect(await storedRows()).toEqual([]);

      const u2 = await insertUser();
      await repo.upsert({
        user_id: u2.id, tenant_id: tenant.id, event_key: EVENT,
        channel: 'email', enabled: true,
      });
      await getTestPool().query(`DELETE FROM tenants WHERE id = $1`, [tenant.id]);
      expect(await storedRows()).toEqual([]);
    });
  });

  // ── upsertMany ───────────────────────────────────────────────────────────

  describe('upsertMany', () => {
    const row = (event_key: string, enabled: boolean, frequency: 'daily' | 'weekly' | null = null) => ({
      user_id: user.id, tenant_id: tenant.id, event_key, channel: 'email', enabled, frequency,
    });

    it('expands the unnest arrays into one row per input (insert path)', async () => {
      const out = await repo.upsertMany([
        row('campaign.dispatched', true),
        row('campaign.completed', false),
        row(EVENT, true, 'weekly'),
      ]);

      expect(out).toHaveLength(3);
      const byKey = new Map(out.map((r) => [r.event_key, r]));
      expect(byKey.get('campaign.dispatched')!.enabled).toBe(true);
      expect(byKey.get('campaign.completed')!.enabled).toBe(false);
      expect(byKey.get(EVENT)!.frequency).toBe('weekly');
      expect(await storedRows()).toHaveLength(3);
    });

    it('takes the ON CONFLICT update path for rows that already exist', async () => {
      await repo.upsertMany([row('a', true, 'daily'), row('b', true)]);
      const out = await repo.upsertMany([row('a', false, 'weekly'), row('c', true)]);

      expect(out).toHaveLength(2);
      const all = await storedRows();
      // 'b' was untouched: this is a PATCH, not a replacement.
      expect(all).toHaveLength(3);
      expect(all.find((r) => r['event_key'] === 'a')!['enabled']).toBe(false);
      expect(all.find((r) => r['event_key'] === 'a')!['frequency']).toBe('weekly');
      expect(all.find((r) => r['event_key'] === 'b')!['enabled']).toBe(true);
    });

    it('clears frequency to NULL through the update path', async () => {
      await repo.upsertMany([row(EVENT, true, 'daily')]);
      const out = await repo.upsertMany([row(EVENT, true, null)]);
      expect(out[0]!.frequency).toBeNull();
    });

    /**
     * The reason `upsertMany` de-duplicates at all, shown rather than asserted.
     *
     * `ON CONFLICT DO UPDATE` refuses when one statement carries the same
     * conflict key twice — `21000`, "command cannot affect row a second time".
     * The whole save then fails as a masked 500 on a settings page. This raises
     * it against the same statement shape the repository uses, so the guard
     * below is demonstrably load-bearing rather than defensive.
     */
    it('would raise 21000 without the dedupe — the same statement, run raw', async () => {
      const code = await codeOf(() =>
        getTestPool().query(
          `INSERT INTO user_notification_preferences
             (user_id, tenant_id, event_key, channel, enabled, frequency)
           SELECT * FROM unnest(
             $1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::boolean[], $6::text[]
           )
           ON CONFLICT (user_id, tenant_id, event_key, channel)
           DO UPDATE SET enabled = EXCLUDED.enabled, frequency = EXCLUDED.frequency`,
          [
            [user.id, user.id],
            [tenant.id, tenant.id],
            [EVENT, EVENT],
            ['email', 'email'],
            [true, false],
            [null, null],
          ],
        ),
      );
      expect(code).toBe('21000');
      expect(await storedRows()).toEqual([]);
    });

    it('collapses an in-batch duplicate, last write wins', async () => {
      const out = await repo.upsertMany([
        row(EVENT, true, 'daily'),
        row(EVENT, false, 'weekly'), // same conflict key
      ]);

      // One row out, one row stored — and it is the LAST input's values, which
      // is what the same pairs arriving as consecutive statements would do.
      expect(out).toHaveLength(1);
      expect(out[0]!.enabled).toBe(false);
      expect(out[0]!.frequency).toBe('weekly');
      expect(await storedRows()).toHaveLength(1);
    });

    it('collapses an in-batch duplicate that lands on an EXISTING row too', async () => {
      await repo.upsertMany([row(EVENT, true, 'daily')]);
      const out = await repo.upsertMany([row(EVENT, false, 'weekly'), row(EVENT, true, 'daily')]);
      expect(out).toHaveLength(1);
      expect(out[0]!.enabled).toBe(true);
      expect(out[0]!.frequency).toBe('daily');
    });

    it('drops rows with non-uuid ids and still writes the rest', async () => {
      const out = await repo.upsertMany([
        { ...row('good', true) },
        { ...row('bad', true), user_id: 'not-a-uuid' },
      ]);
      expect(out.map((r) => r.event_key)).toEqual(['good']);
    });

    it('is a no-op on an empty (or all-invalid) batch', async () => {
      expect(await repo.upsertMany([])).toEqual([]);
      expect(await repo.upsertMany([{ ...row('x', true), tenant_id: 'nope' }])).toEqual([]);
      expect(await storedRows()).toEqual([]);
    });
  });

  // ── A retired key is INERT ───────────────────────────────────────────────

  describe('a row naming a key this build no longer has', () => {
    it('stores fine, is returned raw by findForUser, and is never served', async () => {
      const { isLiveEventKey, NOTIFICATION_EVENTS } = await import(
        '../../../src/notifications/engine/catalog.js'
      );
      const { resolveEffectivePreferences } = await import(
        '../../../src/notifications/engine/audience.js'
      );

      const retired = 'campaign.retired_in_2024';
      // PORT NOTE (magick-agency): master uses `EVENT` (`usage.digest`) as the LIVE
      // key here; it is not in agency's catalog (plan §3.5), so the one live
      // agency key stands in for it in this case.
      const live = 'agency.campaign.completed';
      expect(isLiveEventKey(retired)).toBe(false);

      // `event_key` is TEXT, not an enum and not an FK, so the row is legal.
      await repo.upsert({
        user_id: user.id, tenant_id: tenant.id, event_key: retired,
        channel: 'email', enabled: false, frequency: 'daily',
      });
      await repo.upsert({
        user_id: user.id, tenant_id: tenant.id, event_key: live,
        channel: 'email', enabled: false,
      });

      // The repository has no business filtering: it returns what is stored.
      const stored = await repo.findForUser(user.id, tenant.id);
      expect(stored.map((r) => r.event_key).sort()).toEqual([retired, live].sort());

      // The catalog merge drops it — never served, and never deleted either, so
      // a key removed by mistake and restored next release keeps its answers.
      const effective = resolveEffectivePreferences(stored, NOTIFICATION_EVENTS);
      expect(effective.map((p) => p.eventKey)).not.toContain(retired);
      expect(effective.find((p) => p.eventKey === live)!.enabled).toBe(false);

      // Still on disk afterwards.
      expect(await storedRows()).toHaveLength(2);
    });

    it('is not returned by findForUsersAndEvent for a live key', async () => {
      await repo.upsert({
        user_id: user.id, tenant_id: tenant.id, event_key: 'retired.thing',
        channel: 'email', enabled: true,
      });
      expect(await repo.findForUsersAndEvent(tenant.id, EVENT, [user.id])).toEqual([]);
    });
  });

  // ── findForUsersAndEvent ─────────────────────────────────────────────────

  describe('findForUsersAndEvent', () => {
    it('returns one row per user for the named event and channel only', async () => {
      const u2 = await insertUser();
      const u3 = await insertUser();

      await repo.upsertMany([
        { user_id: user.id, tenant_id: tenant.id, event_key: EVENT, channel: 'email', enabled: false },
        { user_id: u2.id, tenant_id: tenant.id, event_key: EVENT, channel: 'email', enabled: true, frequency: 'daily' },
        { user_id: u2.id, tenant_id: tenant.id, event_key: EVENT, channel: 'sms', enabled: true },
        { user_id: u2.id, tenant_id: tenant.id, event_key: 'campaign.completed', channel: 'email', enabled: false },
      ]);

      const rows = await repo.findForUsersAndEvent(tenant.id, EVENT, [user.id, u2.id, u3.id]);

      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.event_key === EVENT && r.channel === 'email')).toBe(true);
      // u3 has no stored row — an absent row is the catalog default, not a row.
      expect(rows.map((r) => r.user_id).sort()).toEqual([user.id, u2.id].sort());
    });

    it('does not cross the tenant boundary', async () => {
      const other = await insertTenant();
      await repo.upsert({
        user_id: user.id, tenant_id: other.id, event_key: EVENT,
        channel: 'email', enabled: false,
      });
      expect(await repo.findForUsersAndEvent(tenant.id, EVENT, [user.id])).toEqual([]);
    });

    it('drops non-uuid ids from the ANY() array rather than raising 22P02', async () => {
      await repo.upsert({
        user_id: user.id, tenant_id: tenant.id, event_key: EVENT,
        channel: 'email', enabled: true,
      });
      // A `22P02` mid-fan-out would kill a scheduled run for every tenant after
      // this one, so the guard is the right answer here.
      const rows = await repo.findForUsersAndEvent(tenant.id, EVENT, ['garbage', user.id]);
      expect(rows).toHaveLength(1);
    });

    it('returns empty when every id is unusable', async () => {
      expect(await repo.findForUsersAndEvent(tenant.id, EVENT, ['a', 'b'])).toEqual([]);
      expect(await repo.findForUsersAndEvent('nope', EVENT, [user.id])).toEqual([]);
    });
  });

  // ── findNotifiableMembers ────────────────────────────────────────────────

  describe('findNotifiableMembers', () => {
    it('returns one row per MEMBERSHIP, not per user', async () => {
      const account = await insertAccount({ tenant_id: tenant.id });

      // The schema permits both: `memberships` is UNIQUE on
      // (user_id, tenant_id, account_id), so a tenant-level row and an
      // account-scoped one for the same person are two legal rows. The engine
      // collapses them to the WIDEST scope — but the query must SHOW both, or
      // there is nothing to collapse.
      await insertMembership({ user_id: user.id, tenant_id: tenant.id, role: 'tenant_admin' });
      await insertMembership({
        user_id: user.id, tenant_id: tenant.id, account_id: account.id, role: 'account_admin',
      });

      const members = await repo.findNotifiableMembers(tenant.id);
      expect(members).toHaveLength(2);
      expect(members.every((m) => m.user_id === user.id)).toBe(true);
      expect(members.map((m) => m.account_id).sort()).toEqual([account.id, null].sort());
    });

    it('orders one person’s memberships oldest-first, matching findByUserAndTenant', async () => {
      // `collapseByInbox` keeps the FIRST account-scoped row per inbox, and the
      // digest preview scopes from the oldest eligible membership. With
      // `ORDER BY u.email` alone these rows tie and come back in whatever order
      // the executor produces, so the mail could name one account and the
      // preview another. Eight rows inserted in a scrambled age order, so an
      // accidental match without the tie-break is vanishingly unlikely.
      const ageOrder = [5, 2, 7, 0, 6, 3, 1, 4];
      const accounts: string[] = [];
      for (let i = 0; i < ageOrder.length; i += 1) {
        accounts.push((await insertAccount({ tenant_id: tenant.id })).id);
      }
      for (let i = 0; i < ageOrder.length; i += 1) {
        await insertMembership({
          user_id: user.id, tenant_id: tenant.id, account_id: accounts[i], role: 'account_admin',
          created_at: new Date(Date.UTC(2026, 0, 1 + ageOrder[i]!)),
        });
      }
      const oldestFirst = [...accounts.keys()]
        .sort((a, b) => ageOrder[a]! - ageOrder[b]!)
        .map((i) => accounts[i]);

      const members = await repo.findNotifiableMembers(tenant.id);
      expect(members.map((m) => m.account_id)).toEqual(oldestFirst);

      const { membershipRepository } = await import(
        '@magick-agency/db/repositories/membership.repository'
      );
      const own = await membershipRepository.findByUserAndTenant(user.id, tenant.id);
      expect(own.map((m: any) => m.account_id)).toEqual(oldestFirst);
    });

    it('returns BOTH users when two share one email — users.email is not unique', async () => {
      const shared = 'shared-inbox@example.com';
      const a = await insertUser({ email: shared });
      const b = await insertUser({ email: shared });
      await insertMembership({ user_id: a.id, tenant_id: tenant.id, role: 'account_admin' });
      await insertMembership({ user_id: b.id, tenant_id: tenant.id, role: 'tenant_owner' });

      // Migration 069 says in as many words that no unique index is added on
      // `users.email`. A `SELECT DISTINCT u.email` would collapse these two and
      // lose one person's preferences entirely — which is exactly why this
      // engine cannot reuse `findAddressableMembersInAccount`.
      const members = await repo.findNotifiableMembers(tenant.id);
      expect(members).toHaveLength(2);
      expect(members.every((m) => m.email === shared)).toBe(true);
      expect(new Set(members.map((m) => m.user_id))).toEqual(new Set([a.id, b.id]));
    });

    it('excludes a revoked membership and an inactive user', async () => {
      const active = await insertUser();
      const revoked = await insertUser();
      const inactive = await insertUser({ status: 'inactive' });

      await insertMembership({ user_id: active.id, tenant_id: tenant.id, role: 'account_admin' });
      await insertMembership({
        user_id: revoked.id, tenant_id: tenant.id, role: 'account_admin', status: 'revoked',
      });
      await insertMembership({ user_id: inactive.id, tenant_id: tenant.id, role: 'account_admin' });

      // Naming a departed colleague in a report and MAILING them are different
      // acts; a revoked member must stop receiving mail about the workspace.
      const members = await repo.findNotifiableMembers(tenant.id);
      expect(members.map((m) => m.user_id)).toEqual([active.id]);
    });

    it('excludes a member with no usable address', async () => {
      const blank = await insertUser({ email: '' });
      const good = await insertUser({ email: 'good@example.com' });
      await insertMembership({ user_id: blank.id, tenant_id: tenant.id, role: 'account_admin' });
      await insertMembership({ user_id: good.id, tenant_id: tenant.id, role: 'account_admin' });

      const members = await repo.findNotifiableMembers(tenant.id);
      expect(members.map((m) => m.email)).toEqual(['good@example.com']);
    });

    it('does not reach another tenant’s memberships', async () => {
      const other = await insertTenant();
      await insertMembership({ user_id: user.id, tenant_id: other.id, role: 'tenant_owner' });
      expect(await repo.findNotifiableMembers(tenant.id)).toEqual([]);
    });

    it('carries the role through, which is what the floor is applied to', async () => {
      const agent = await insertUser({ email: 'agent@example.com' });
      await insertMembership({ user_id: agent.id, tenant_id: tenant.id, role: 'agent' });
      const members = await repo.findNotifiableMembers(tenant.id);
      expect(members[0]!.role).toBe('agent');
    });

    it('returns empty for a non-uuid tenant id', async () => {
      expect(await repo.findNotifiableMembers('nope')).toEqual([]);
      expect(await repo.findNotifiableMembers(randomUUID())).toEqual([]);
    });
  });
});

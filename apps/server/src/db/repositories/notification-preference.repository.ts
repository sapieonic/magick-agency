import { getPool } from '@magick-agency/db';
import type {
  NotifiableMember,
  NotificationPreferenceRecord,
  UpsertNotificationPreferenceInput,
} from '../models/notification.model.js';

/** Guard before a value reaches a `::uuid` cast, so a bad id is empty not `22P02`. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

class NotificationPreferenceRepository {
  /**
   * Every stored override for one user in one tenant.
   *
   * The settings page's read. Returns rows for retired keys too — the caller
   * filters against the live catalog, because this layer has no business
   * deciding which keys still exist.
   */
  async findForUser(userId: string, tenantId: string): Promise<NotificationPreferenceRecord[]> {
    if (!isUuid(userId) || !isUuid(tenantId)) return [];
    const pool = getPool();
    const result = await pool.query<NotificationPreferenceRecord>(
      `SELECT * FROM user_notification_preferences
        WHERE user_id = $1::uuid AND tenant_id = $2::uuid
        ORDER BY event_key, channel`,
      [userId, tenantId],
    );
    return result.rows;
  }

  /**
   * The overrides of a whole AUDIENCE for ONE event, in one round trip.
   *
   * This is the shape the digest runner needs and the reason it is not
   * `findForUser` in a loop: a fan-out over every active tenant would otherwise
   * make one query per recipient per tenant per period, against the same 20-slot
   * connection pool the settlement path is using. `user_id = ANY($3)` is served
   * by the leading column of `uq_user_notification_preferences`.
   *
   * Ids that are not uuid-shaped are dropped rather than passed to the cast: the
   * array comes from a membership read so they always are, but an empty result
   * is a better failure than a `22P02` that kills a scheduled run mid-fan-out.
   */
  async findForUsersAndEvent(
    tenantId: string,
    eventKey: string,
    userIds: readonly string[],
    channel = 'email',
  ): Promise<NotificationPreferenceRecord[]> {
    const ids = userIds.filter(isUuid);
    if (!isUuid(tenantId) || ids.length === 0) return [];

    const pool = getPool();
    const result = await pool.query<NotificationPreferenceRecord>(
      `SELECT * FROM user_notification_preferences
        WHERE tenant_id = $1::uuid
          AND event_key = $2
          AND channel   = $3
          AND user_id   = ANY($4::uuid[])`,
      [tenantId, eventKey, channel, ids],
    );
    return result.rows;
  }

  /**
   * Write one preference, creating or replacing.
   *
   * `ON CONFLICT … DO UPDATE` against `uq_user_notification_preferences` rather
   * than a read-then-write: two settings-page saves racing (two tabs, a
   * double-click) would otherwise both see "no row" and both INSERT, and one of
   * them would take a `23505` that surfaces to the customer as a masked 500 on
   * a toggle.
   *
   * `frequency` is written unconditionally, including to NULL. An upsert that
   * left it alone when absent would let a stale `'daily'` survive on an event
   * that had since become immediate-cadence, and the stored value would then
   * disagree with what the settings page is showing.
   */
  async upsert(input: UpsertNotificationPreferenceInput): Promise<NotificationPreferenceRecord | null> {
    if (!isUuid(input.user_id) || !isUuid(input.tenant_id)) return null;

    const pool = getPool();
    const result = await pool.query<NotificationPreferenceRecord>(
      `INSERT INTO user_notification_preferences
         (user_id, tenant_id, event_key, channel, enabled, frequency)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)
       ON CONFLICT (user_id, tenant_id, event_key, channel)
       DO UPDATE SET enabled   = EXCLUDED.enabled,
                     frequency = EXCLUDED.frequency
       RETURNING *`,
      [
        input.user_id,
        input.tenant_id,
        input.event_key,
        input.channel,
        input.enabled,
        input.frequency ?? null,
      ],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Write a batch under one statement.
   *
   * The settings page saves the whole form at once, so the alternative is N
   * awaited round trips for one button — and, worse, a partial save if the
   * process dies halfway, leaving the page showing something the database does
   * not hold. `unnest` expands the arrays into rows so this stays a single
   * INSERT with a single `ON CONFLICT`, i.e. atomic per call, which is the same
   * property `creditTransactionRepository.bulkCreate` exists for.
   *
   * ── Duplicates are collapsed HERE, not left to the validator ─────────────
   *
   * `ON CONFLICT DO UPDATE` raises `21000 — command cannot affect row a second
   * time` when one statement carries the same conflict key twice, and the whole
   * save then fails as a masked 500. Today the only caller is a route whose
   * validator already refuses a duplicate `(event_key, channel)` pair, so it is
   * unreachable — but that is a property of one caller, and this is a public
   * method with no guard of its own. Last write wins, matching what the same
   * pairs would do if they arrived as consecutive statements.
   */
  async upsertMany(
    inputs: readonly UpsertNotificationPreferenceInput[],
  ): Promise<NotificationPreferenceRecord[]> {
    const deduped = new Map<string, UpsertNotificationPreferenceInput>();
    for (const input of inputs) {
      if (!isUuid(input.user_id) || !isUuid(input.tenant_id)) continue;
      deduped.set(`${input.user_id}\u0000${input.tenant_id}\u0000${input.event_key}\u0000${input.channel}`, input);
    }
    const rows = [...deduped.values()];
    if (rows.length === 0) return [];

    const pool = getPool();
    const result = await pool.query<NotificationPreferenceRecord>(
      `INSERT INTO user_notification_preferences
         (user_id, tenant_id, event_key, channel, enabled, frequency)
       SELECT * FROM unnest(
         $1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::boolean[], $6::text[]
       )
       ON CONFLICT (user_id, tenant_id, event_key, channel)
       DO UPDATE SET enabled   = EXCLUDED.enabled,
                     frequency = EXCLUDED.frequency
       RETURNING *`,
      [
        rows.map((r) => r.user_id),
        rows.map((r) => r.tenant_id),
        rows.map((r) => r.event_key),
        rows.map((r) => r.channel),
        rows.map((r) => r.enabled),
        rows.map((r) => r.frequency ?? null),
      ],
    );
    return result.rows;
  }

  /**
   * Everyone in a tenant who could be notified about anything.
   *
   * Deliberately NOT `userRepository.findAddressableMembersInAccount`, which
   * this engine cannot use: that query is `SELECT DISTINCT u.email, m.role` — no
   * `user_id` (so preferences, which are keyed by user, cannot be looked up) and
   * no `account_id` (so a digest cannot be scoped to the recipient's own
   * account). Its `DISTINCT` on email also collapses two people who share an
   * address, which `users.email` permits because it carries only a NON-unique
   * index (migration 069 says so in as many words).
   *
   * So this returns the membership ROWS, one per membership, and every decision
   * about collapsing them is made above the database:
   *
   *  - A user with both a tenant-level and an account-scoped membership appears
   *    twice. `resolveAudience` keeps the WIDEST scope, so they get one digest
   *    covering the whole tenant rather than two.
   *  - Two different users sharing an address appear twice with different
   *    `user_id`s and possibly different preferences. The engine's rule is that
   *    the address is sent to if ANY of them has the event enabled — the mail
   *    reaches an inbox, and an inbox cannot be half-subscribed.
   *
   * **The order is part of the contract, not presentation.** `collapseByInbox`
   * keeps the FIRST account-scoped row it sees for an inbox and never re-sorts,
   * so with `ORDER BY u.email` alone a person holding two eligible account-scoped
   * memberships was mailed whichever one Postgres returned first — heap order,
   * which a plan change or a VACUUM can flip. `m.created_at ASC, m.id ASC` makes
   * that row the OLDEST, the same tie-break `membershipRepository.findByUserAndTenant`
   * uses, which is what the digest preview (`POST /notifications/digests/preview`)
   * scopes from — so the preview and the mail agree on which account a person
   * sees. Change one ordering and change the other.
   *
   * Both membership and user must be `active`. Note the asymmetry with the
   * agency performance routes, which deliberately do NOT filter status when
   * NAMING a departed colleague: naming somebody in a report and mailing them
   * are different acts, and a revoked member must stop receiving mail about a
   * workspace they were removed from.
   */
  async findNotifiableMembers(tenantId: string): Promise<NotifiableMember[]> {
    if (!isUuid(tenantId)) return [];
    const pool = getPool();
    const result = await pool.query<NotifiableMember>(
      `SELECT m.user_id, u.email, m.role, m.account_id
         FROM memberships m
         JOIN users u ON u.id = m.user_id
        WHERE m.tenant_id = $1::uuid
          AND m.status = 'active'
          AND u.status = 'active'
          AND u.email IS NOT NULL
          AND u.email <> ''
        ORDER BY u.email, m.created_at ASC, m.id ASC`,
      [tenantId],
    );
    return result.rows;
  }
}

export const notificationPreferenceRepository = new NotificationPreferenceRepository();

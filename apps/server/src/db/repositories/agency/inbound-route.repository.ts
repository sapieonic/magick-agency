/**
 * `AgencyInboundRouteRepository`: an account's inbound routes and the numbers they answer
 * (`agency_inbound_routes`, `agency_inbound_route_numbers`, `0024_inbound.sql`; docs/inbound.md §8).
 *
 * ── What it guarantees ─────────────────────────────────────────────────────────
 *  - **Tenant and account scope in every statement.** Every read and write names the tenant and
 *    the account; a route of another account answers as missing.
 *  - **One route answers a number.** `uq_agency_inbound_route_numbers_active` is the backstop;
 *    attaching is `INSERT … ON CONFLICT DO NOTHING` on it, so a race is an ordinary refusal
 *    (`number_in_use`), never a thrown 23505 inside a caller's transaction.
 *  - **Only a number the account may route.** Attaching checks, in the same transaction, that
 *    the number is one of the tenant's active numbers (`tenant_phone_assignments`), untagged or
 *    tagged to this account (the caller-ID availability rule,
 *    `TenantPhoneAssignmentRepository.findAvailableForAccount`), and linked to inbound by a
 *    super-admin (`phone_numbers.inbound_linked_at`, IB6).
 *  - **Soft delete.** A deleted route keeps its row (the spine names it) and frees its name; its
 *    numbers are detached (`route_deleted`) in the same transaction.
 *  - **Route rows are locked** (`FOR UPDATE`) by every write that attaches, so a delete and an
 *    attach on the same route serialise: no number is left attached to a deleted route.
 *
 * What it does NOT check, because it needs other modules: the body's shape (the route-config
 * validator, `agency/inbound/route-config.ts`), clip ids naming the account's audio files, and
 * the analysis profile and pool campaigns belonging to the account. The API layer checks those
 * before writing. The §8.2 cascade (a number unlinked, untagged, unassigned, retired, or its
 * credential disabled) detaches through {@link AgencyInboundRouteRepository.detachNumberEverywhere}.
 *
 * Every id is bound as a parameter and cast once; callers validate ids at the edge (`22P02`).
 */
import type { PoolClient } from 'pg';
import { getPool } from '@magick-agency/db';
import { isUniqueViolation } from '@magick-agency/db/pg-errors';
import { withTransaction } from '@magick-agency/db/utils/transaction';
import type {
  AgencyDisposition,
  AgencyInboundClipSlot,
  AgencyInboundHoliday,
  AgencyInboundHoursInterval,
  AgencyInboundRouteConfig,
  AgencyInboundStickyMode,
  AgencyInboundUnconnectedAction,
} from '@magick-agency/contracts/agency';
import type { AgencyInboundRoute, AgencyInboundRouteNumber } from '@magick-agency/contracts/api/agency/inbound';

type Db = Pick<PoolClient, 'query'>;

/** The unique index behind `name_taken`. */
export const INBOUND_ROUTE_NAME_UNIQUE = 'uq_agency_inbound_routes_name';

/** Why a route number was detached (`agency_inbound_route_numbers.detached_reason`). */
export type AgencyInboundDetachReason = 'detached' | 'route_deleted' | 'number_unlinked';

/** An `agency_inbound_routes` row. */
export interface AgencyInboundRouteRecord {
  id: string;
  tenant_id: string;
  account_id: string;
  name: string;
  timezone: string;
  weekly_hours: AgencyInboundHoursInterval[];
  holidays: AgencyInboundHoliday[];
  greeting_audio_id: string | null;
  hold_audio_id: string | null;
  closed_audio_id: string | null;
  busy_audio_id: string | null;
  recording_notice_audio_id: string | null;
  callback_audio_id: string | null;
  sticky_mode: AgencyInboundStickyMode;
  sticky_wait_seconds: number;
  sticky_lookback_days: number;
  pool_campaign_ids: string[];
  queue_max_wait_seconds: number;
  max_waiting: number;
  max_concurrent: number;
  after_hours_action: AgencyInboundUnconnectedAction;
  overflow_action: AgencyInboundUnconnectedAction;
  record_calls: boolean;
  recording_notice: boolean;
  analysis_profile_id: string | null;
  disposition_catalog: AgencyDisposition[];
  created_by: string | null;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  deleted_by: string | null;
}

/** A route number as the route reads carry it (its live attachments). */
export interface AgencyInboundRouteNumberRow {
  phone_number_id: string;
  phone_number: string;
  attached_at: Date;
}

/** A live route with its live numbers. */
export type AgencyInboundRouteWithNumbers = AgencyInboundRouteRecord & { numbers: AgencyInboundRouteNumberRow[] };

/** Why a number cannot be attached to a route. Each maps onto one `AgencyInboundErrorCode`. */
export type AgencyInboundAttachRefusal =
  /** No such live route in this account (`inbound_route_not_found`). */
  | { reason: 'route_not_found' }
  /** Not one of the tenant's active numbers this account may use (`inbound_number_not_found`). */
  | { reason: 'number_not_found'; phoneNumberId: string }
  /** Not linked to inbound by a super-admin (`inbound_number_not_linked`). */
  | { reason: 'number_not_linked'; phoneNumberId: string }
  /** Already answers another live route (`inbound_number_in_use`). */
  | { reason: 'number_in_use'; phoneNumberId: string; routeId: string };

/** The answer webhook's lookup by the number rung ({@link AgencyInboundRouteRepository.findRouteForNumber}). */
export interface AgencyInboundNumberRoute {
  phone_number_id: string;
  phone_number: string;
  /** `phone_numbers.status`: only an `active` number should be answered as routed. */
  number_status: 'active' | 'retired' | 'deleted';
  /** NULL: not linked to inbound (the carrier still sent it here: a stale Application link). */
  inbound_linked_at: Date | null;
  telephony_credential_id: string;
  /** The credential's tenant: the call's tenant. */
  tenant_id: string;
  credential_status: 'active' | 'disabled' | 'invalid' | 'revoked';
  /** The number's assignment to the credential's tenant, or NULL when it is not assigned to it. */
  assignment_id: string | null;
  /** The live route answering the number, or NULL (§8.3: the tenant default). */
  route: AgencyInboundRouteRecord | null;
  /** Whether the route's account may still use the number (the tag rule); false with no route. */
  route_account_may_use: boolean;
}

/** Column per clip slot. */
const CLIP_COLUMNS: Record<AgencyInboundClipSlot, keyof AgencyInboundRouteRecord & string> = {
  greeting: 'greeting_audio_id',
  hold: 'hold_audio_id',
  closed: 'closed_audio_id',
  busy: 'busy_audio_id',
  recording_notice: 'recording_notice_audio_id',
  callback: 'callback_audio_id',
};

/** The config fields stored in a column of the same name. `clips` is spread over CLIP_COLUMNS. */
const PLAIN_FIELDS = [
  'name', 'timezone', 'weekly_hours', 'holidays', 'sticky_mode', 'sticky_wait_seconds', 'sticky_lookback_days',
  'pool_campaign_ids', 'queue_max_wait_seconds', 'max_waiting', 'max_concurrent', 'after_hours_action',
  'overflow_action', 'record_calls', 'recording_notice', 'analysis_profile_id', 'disposition_catalog',
] as const satisfies ReadonlyArray<keyof AgencyInboundRouteConfig>;

/** JSONB columns: bound as JSON text and cast, so an array is never sent as a Postgres array. */
const JSON_FIELDS = new Set<string>(['weekly_hours', 'holidays', 'disposition_catalog']);
const CAST: Record<string, string> = {
  weekly_hours: 'jsonb', holidays: 'jsonb', disposition_catalog: 'jsonb', pool_campaign_ids: 'uuid[]',
  analysis_profile_id: 'uuid', sticky_wait_seconds: 'smallint', sticky_lookback_days: 'smallint',
  queue_max_wait_seconds: 'smallint', max_waiting: 'smallint', max_concurrent: 'smallint',
  record_calls: 'boolean', recording_notice: 'boolean',
};

const ROUTE_COLUMNS = `r.id, r.tenant_id, r.account_id, r.name, r.timezone, r.weekly_hours, r.holidays,
  r.greeting_audio_id, r.hold_audio_id, r.closed_audio_id, r.busy_audio_id, r.recording_notice_audio_id,
  r.callback_audio_id, r.sticky_mode, r.sticky_wait_seconds, r.sticky_lookback_days, r.pool_campaign_ids,
  r.queue_max_wait_seconds, r.max_waiting, r.max_concurrent, r.after_hours_action, r.overflow_action,
  r.record_calls, r.recording_notice, r.analysis_profile_id, r.disposition_catalog, r.created_by, r.updated_by,
  r.created_at, r.updated_at, r.deleted_at, r.deleted_by`;

/**
 * Whether the account bound at `accountParam` may use the number whose tenant assignment is
 * `tpa`: an untagged assignment serves every account of the tenant; a tagged one only its tagged
 * accounts. The caller-ID rule (`findAvailableForAccount`), written once here for this file.
 */
function accountMayUseSql(tpa: string, accountParam: string): string {
  return `(NOT EXISTS (SELECT 1 FROM phone_account_tags pat WHERE pat.assignment_id = ${tpa}.id)
           OR EXISTS (SELECT 1 FROM phone_account_tags pat WHERE pat.assignment_id = ${tpa}.id AND pat.account_id = ${accountParam}))`;
}

/** Every field of a full config as `column → value`, ready to bind. */
function configColumns(config: AgencyInboundRouteConfig): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = PLAIN_FIELDS.map((f) => [f, config[f]]);
  for (const slot of Object.keys(CLIP_COLUMNS) as AgencyInboundClipSlot[]) out.push([CLIP_COLUMNS[slot], config.clips[slot]]);
  return out;
}

/** The fields present in a patch as `column → value` (`clips` per slot present). */
function patchColumns(patch: AgencyInboundRoutePatch): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  for (const f of PLAIN_FIELDS) if (patch[f] !== undefined) out.push([f, patch[f]]);
  for (const slot of Object.keys(CLIP_COLUMNS) as AgencyInboundClipSlot[]) {
    const value = patch.clips?.[slot];
    if (value !== undefined) out.push([CLIP_COLUMNS[slot], value]);
  }
  return out;
}

function bindValue(column: string, value: unknown): unknown {
  return JSON_FIELDS.has(column) ? JSON.stringify(value) : value;
}

function placeholder(column: string, index: number): string {
  const cast = CAST[column];
  return cast ? `$${index}::${cast}` : `$${index}`;
}

/** The fields of a PATCH: any config field (each replaces the stored one), `clips` per slot. */
export type AgencyInboundRoutePatch = Partial<Omit<AgencyInboundRouteConfig, 'clips'>> & {
  clips?: Partial<AgencyInboundRouteConfig['clips']>;
};

/** A stored route and its numbers as the console reads it (`AgencyInboundRoute`). */
export function inboundRouteToWire(route: AgencyInboundRouteWithNumbers): AgencyInboundRoute {
  const clips = Object.fromEntries(
    (Object.keys(CLIP_COLUMNS) as AgencyInboundClipSlot[]).map((slot) => [slot, route[CLIP_COLUMNS[slot]] as string | null]),
  ) as AgencyInboundRoute['clips'];
  const numbers: AgencyInboundRouteNumber[] = route.numbers.map((n) => ({
    phone_number_id: n.phone_number_id, phone_number: n.phone_number, attached_at: n.attached_at.toISOString(),
  }));
  return {
    id: route.id,
    account_id: route.account_id,
    name: route.name,
    timezone: route.timezone,
    weekly_hours: route.weekly_hours,
    holidays: route.holidays,
    clips,
    sticky_mode: route.sticky_mode,
    sticky_wait_seconds: route.sticky_wait_seconds,
    sticky_lookback_days: route.sticky_lookback_days,
    pool_campaign_ids: route.pool_campaign_ids,
    queue_max_wait_seconds: route.queue_max_wait_seconds,
    max_waiting: route.max_waiting,
    max_concurrent: route.max_concurrent,
    after_hours_action: route.after_hours_action,
    overflow_action: route.overflow_action,
    record_calls: route.record_calls,
    recording_notice: route.recording_notice,
    analysis_profile_id: route.analysis_profile_id,
    disposition_catalog: route.disposition_catalog,
    numbers,
    created_at: route.created_at.toISOString(),
    updated_at: route.updated_at.toISOString(),
  };
}

export class AgencyInboundRouteRepository {
  /**
   * Insert a route with every field given (the validator applied the defaults). `name_taken`
   * when another live route of the account has the name: `ON CONFLICT DO NOTHING` on
   * `uq_agency_inbound_routes_name`, so a caller's transaction stays usable. Numbers are
   * attached separately ({@link setNumbers}), in the caller's transaction (`deps.client`).
   */
  async create(
    input: { tenantId: string; accountId: string; createdBy: string | null; config: AgencyInboundRouteConfig },
    deps: { client?: Db } = {},
  ): Promise<{ ok: true; route: AgencyInboundRouteRecord } | { ok: false; reason: 'name_taken' }> {
    const cols = configColumns(input.config);
    const values: unknown[] = [input.tenantId, input.accountId, input.createdBy];
    const placeholders = cols.map(([column, value]) => {
      values.push(bindValue(column, value));
      return placeholder(column, values.length);
    });
    const { rows } = await (deps.client ?? getPool()).query<AgencyInboundRouteRecord>(
      `INSERT INTO agency_inbound_routes AS r
         (tenant_id, account_id, created_by, updated_by, ${cols.map(([c]) => c).join(', ')})
       VALUES ($1::uuid, $2::uuid, $3::uuid, $3::uuid, ${placeholders.join(', ')})
       ON CONFLICT (tenant_id, account_id, lower(name)) WHERE deleted_at IS NULL DO NOTHING
       RETURNING ${ROUTE_COLUMNS}`,
      values,
    );
    const route = rows[0];
    return route ? { ok: true, route } : { ok: false, reason: 'name_taken' };
  }

  /**
   * Replace the fields present in `patch` on a live route of the account. `not_found` for a
   * missing, deleted or other account's route; `name_taken` for a rename onto another live
   * route's name. An empty patch is a read. The unique index is the arbiter of a rename race:
   * its 23505 is caught and answered `name_taken`, so call this outside a transaction that must
   * survive a refusal, or check the name in that transaction first.
   */
  async update(
    tenantId: string,
    accountId: string,
    id: string,
    patch: AgencyInboundRoutePatch,
    updatedBy: string | null,
    deps: { client?: Db } = {},
  ): Promise<{ ok: true; route: AgencyInboundRouteRecord } | { ok: false; reason: 'not_found' | 'name_taken' }> {
    const db = deps.client ?? getPool();
    const cols = patchColumns(patch);
    if (cols.length === 0) {
      const route = await this.findRecord(tenantId, accountId, id, db);
      return route ? { ok: true, route } : { ok: false, reason: 'not_found' };
    }
    const values: unknown[] = [id, tenantId, accountId, updatedBy];
    const sets = cols.map(([column, value]) => {
      values.push(bindValue(column, value));
      return `${column} = ${placeholder(column, values.length)}`;
    });
    try {
      const { rows } = await db.query<AgencyInboundRouteRecord>(
        `UPDATE agency_inbound_routes r
            SET ${sets.join(', ')}, updated_by = $4::uuid
          WHERE r.id = $1::uuid AND r.tenant_id = $2::uuid AND r.account_id = $3::uuid AND r.deleted_at IS NULL
          RETURNING ${ROUTE_COLUMNS}`,
        values,
      );
      const route = rows[0];
      return route ? { ok: true, route } : { ok: false, reason: 'not_found' };
    } catch (err) {
      if (isUniqueViolation(err, INBOUND_ROUTE_NAME_UNIQUE)) return { ok: false, reason: 'name_taken' };
      throw err;
    }
  }

  /**
   * Soft-delete a live route and detach its numbers (`route_deleted`), in one transaction (or the
   * caller's). Returns the deleted route and the numbers it held, or null when there is no such
   * live route.
   */
  async softDelete(
    tenantId: string,
    accountId: string,
    id: string,
    deletedBy: string | null,
    deps: { client?: PoolClient } = {},
  ): Promise<{ route: AgencyInboundRouteRecord; detachedPhoneNumberIds: string[] } | null> {
    return withTransaction(async (client) => {
      const { rows } = await client.query<AgencyInboundRouteRecord>(
        `UPDATE agency_inbound_routes r
            SET deleted_at = now(), deleted_by = $4::uuid, updated_by = $4::uuid
          WHERE r.id = $1::uuid AND r.tenant_id = $2::uuid AND r.account_id = $3::uuid AND r.deleted_at IS NULL
          RETURNING ${ROUTE_COLUMNS}`,
        [id, tenantId, accountId, deletedBy],
      );
      const route = rows[0];
      if (!route) return null;
      const detached = await client.query<{ phone_number_id: string }>(
        `UPDATE agency_inbound_route_numbers
            SET detached_at = now(), detached_by = $2::uuid, detached_reason = 'route_deleted'
          WHERE route_id = $1::uuid AND detached_at IS NULL
          RETURNING phone_number_id`,
        [id, deletedBy],
      );
      return { route, detachedPhoneNumberIds: detached.rows.map((r) => r.phone_number_id).sort() };
    }, { pool: getPool(), client: deps.client });
  }

  /** One live route of the account with its live numbers, or null. */
  async findById(tenantId: string, accountId: string, id: string): Promise<AgencyInboundRouteWithNumbers | null> {
    const route = await this.findRecord(tenantId, accountId, id, getPool());
    if (!route) return null;
    return { ...route, numbers: (await this.numbersOf([route.id], getPool())).get(route.id) ?? [] };
  }

  /** The account's live routes, oldest first, each with its live numbers. */
  async listForAccount(tenantId: string, accountId: string): Promise<AgencyInboundRouteWithNumbers[]> {
    const { rows } = await getPool().query<AgencyInboundRouteRecord>(
      `SELECT ${ROUTE_COLUMNS} FROM agency_inbound_routes r
        WHERE r.tenant_id = $1::uuid AND r.account_id = $2::uuid AND r.deleted_at IS NULL
        ORDER BY r.created_at, r.id`,
      [tenantId, accountId],
    );
    const numbers = await this.numbersOf(rows.map((r) => r.id), getPool());
    return rows.map((r) => ({ ...r, numbers: numbers.get(r.id) ?? [] }));
  }

  /**
   * Attach one number to a live route of the account (see the module note for every check). On
   * the caller's transaction with `deps.client`, else its own. Already on this route: `ok` with
   * `attached: false` (idempotent).
   */
  async attachNumber(
    input: { tenantId: string; accountId: string; routeId: string; phoneNumberId: string; attachedBy: string | null },
    deps: { client?: PoolClient } = {},
  ): Promise<{ ok: true; attached: boolean } | ({ ok: false } & AgencyInboundAttachRefusal)> {
    return withTransaction(async (client) => {
      if (!await this.lockRoute(client, input.tenantId, input.accountId, input.routeId)) {
        return { ok: false as const, reason: 'route_not_found' as const };
      }
      return this.attachLocked(client, input);
    }, { pool: getPool(), client: deps.client });
  }

  /**
   * Take one number off a live route of the account (`detached`). False when it was not
   * attached there (or the route is not this account's live route).
   */
  async detachNumber(
    input: { tenantId: string; accountId: string; routeId: string; phoneNumberId: string; detachedBy: string | null },
    deps: { client?: Db } = {},
  ): Promise<boolean> {
    const { rowCount } = await (deps.client ?? getPool()).query(
      `UPDATE agency_inbound_route_numbers rn
          SET detached_at = now(), detached_by = $5::uuid, detached_reason = 'detached'
         FROM agency_inbound_routes r
        WHERE rn.route_id = r.id AND rn.route_id = $3::uuid AND rn.phone_number_id = $4::uuid AND rn.detached_at IS NULL
          AND r.tenant_id = $1::uuid AND r.account_id = $2::uuid AND r.deleted_at IS NULL`,
      [input.tenantId, input.accountId, input.routeId, input.phoneNumberId, input.detachedBy],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Make `phoneNumberIds` the route's whole set of numbers, all or nothing: the numbers not in
   * it are detached (`detached`), the new ones attached with every check. The first refusal
   * rolls the whole change back and is answered (with the number it is about). One transaction
   * (or the caller's, which a refusal then leaves for the caller to roll back).
   */
  async setNumbers(
    input: { tenantId: string; accountId: string; routeId: string; phoneNumberIds: readonly string[]; userId: string | null },
    deps: { client?: PoolClient } = {},
  ): Promise<
    | { ok: true; added: string[]; removed: string[] }
    | ({ ok: false } & AgencyInboundAttachRefusal)
  > {
    return withTransaction(async (client, tx) => {
      if (!await this.lockRoute(client, input.tenantId, input.accountId, input.routeId)) {
        return { ok: false as const, reason: 'route_not_found' as const };
      }
      const wanted = [...new Set(input.phoneNumberIds)];
      const removed = await client.query<{ phone_number_id: string }>(
        `UPDATE agency_inbound_route_numbers
            SET detached_at = now(), detached_by = $3::uuid, detached_reason = 'detached'
          WHERE route_id = $1::uuid AND detached_at IS NULL AND NOT (phone_number_id = ANY($2::uuid[]))
          RETURNING phone_number_id`,
        [input.routeId, wanted, input.userId],
      );
      const added: string[] = [];
      for (const phoneNumberId of wanted) {
        const out = await this.attachLocked(client, { ...input, phoneNumberId, attachedBy: input.userId });
        if (!out.ok) {
          await tx.rollback();
          return out;
        }
        if (out.attached) added.push(phoneNumberId);
      }
      return { ok: true as const, added: added.sort(), removed: removed.rows.map((r) => r.phone_number_id).sort() };
    }, { pool: getPool(), client: deps.client });
  }

  /**
   * The §8.2 cascade's step for routes: take `phoneNumberId` off whichever live route answers it
   * (`number_unlinked`, actor none). Returns the route it was taken off, or null when none.
   * Called from the super-admin's unlink and from every path that makes a number unusable to the
   * route's account (untag, unassign, retire by sync, credential disable or revoke), in that
   * path's transaction.
   */
  async detachNumberEverywhere(
    phoneNumberId: string,
    deps: { client?: Db } = {},
  ): Promise<{ routeId: string; tenantId: string; accountId: string } | null> {
    const { rows } = await (deps.client ?? getPool()).query<{ route_id: string; tenant_id: string; account_id: string }>(
      `UPDATE agency_inbound_route_numbers rn
          SET detached_at = now(), detached_reason = 'number_unlinked'
         FROM agency_inbound_routes r
        WHERE rn.route_id = r.id AND rn.phone_number_id = $1::uuid AND rn.detached_at IS NULL
        RETURNING rn.route_id, r.tenant_id, r.account_id`,
      [phoneNumberId],
    );
    const row = rows[0];
    return row ? { routeId: row.route_id, tenantId: row.tenant_id, accountId: row.account_id } : null;
  }

  /**
   * The answer webhook's lookup: the number `toE164` on credential `credentialId` (the
   * credential in the webhook's path; a number is matched only on the account the call arrived
   * on), with the credential's tenant and status, the number's assignment to that tenant, and the
   * live route answering it. Null when the credential has no such number. Unaudited, actor-less,
   * one indexed probe per table (`phone_numbers.phone_number` is unique,
   * `uq_agency_inbound_route_numbers_active`). Deciding what each combination means (a number
   * not linked, a credential not active, no route) is the caller's (§3, §8.3, §10).
   */
  async findRouteForNumber(credentialId: string, toE164: string): Promise<AgencyInboundNumberRoute | null> {
    const { rows } = await getPool().query<Omit<AgencyInboundNumberRoute, 'route'> & { route: AgencyInboundRouteRecord | null }>(
      `SELECT pn.id AS phone_number_id, pn.phone_number, pn.status AS number_status, pn.inbound_linked_at,
              pn.telephony_credential_id, tc.tenant_id, tc.status AS credential_status,
              tpa.id AS assignment_id,
              (SELECT to_jsonb(r) FROM (SELECT ${ROUTE_COLUMNS} FROM agency_inbound_routes r
                                         WHERE r.id = rn.route_id AND r.deleted_at IS NULL) r) AS route,
              COALESCE((SELECT ${accountMayUseSql('tpa', 'r2.account_id')}
                          FROM agency_inbound_routes r2 WHERE r2.id = rn.route_id AND r2.deleted_at IS NULL
                           AND tpa.id IS NOT NULL), false) AS route_account_may_use
         FROM phone_numbers pn
         JOIN telephony_credentials tc ON tc.id = pn.telephony_credential_id
         LEFT JOIN tenant_phone_assignments tpa ON tpa.phone_number_id = pn.id AND tpa.tenant_id = tc.tenant_id
         LEFT JOIN agency_inbound_route_numbers rn ON rn.phone_number_id = pn.id AND rn.detached_at IS NULL
        WHERE pn.telephony_credential_id = $1::uuid AND pn.phone_number = $2::varchar`,
      [credentialId, toE164],
    );
    const row = rows[0];
    if (!row) return null;
    return { ...row, route: row.route ? reviveRoute(row.route) : null };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async findRecord(tenantId: string, accountId: string, id: string, db: Db): Promise<AgencyInboundRouteRecord | null> {
    const { rows } = await db.query<AgencyInboundRouteRecord>(
      `SELECT ${ROUTE_COLUMNS} FROM agency_inbound_routes r
        WHERE r.id = $1::uuid AND r.tenant_id = $2::uuid AND r.account_id = $3::uuid AND r.deleted_at IS NULL`,
      [id, tenantId, accountId],
    );
    return rows[0] ?? null;
  }

  private async lockRoute(client: Db, tenantId: string, accountId: string, routeId: string): Promise<boolean> {
    const { rowCount } = await client.query(
      `SELECT 1 FROM agency_inbound_routes
        WHERE id = $1::uuid AND tenant_id = $2::uuid AND account_id = $3::uuid AND deleted_at IS NULL
        FOR UPDATE`,
      [routeId, tenantId, accountId],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Attach with every check, the route already locked by the caller. */
  private async attachLocked(
    client: Db,
    input: { tenantId: string; accountId: string; routeId: string; phoneNumberId: string; attachedBy: string | null },
  ): Promise<{ ok: true; attached: boolean } | ({ ok: false } & AgencyInboundAttachRefusal)> {
    const { rows: found } = await client.query<{ usable: boolean; linked: boolean }>(
      `SELECT (pn.status = 'active' AND ${accountMayUseSql('tpa', '$3::uuid')}) AS usable,
              pn.inbound_linked_at IS NOT NULL AS linked
         FROM phone_numbers pn
         JOIN tenant_phone_assignments tpa ON tpa.phone_number_id = pn.id AND tpa.tenant_id = $2::uuid
        WHERE pn.id = $1::uuid
          FOR SHARE OF pn`,
      [input.phoneNumberId, input.tenantId, input.accountId],
    );
    const number = found[0];
    if (!number?.usable) return { ok: false, reason: 'number_not_found', phoneNumberId: input.phoneNumberId };
    if (!number.linked) return { ok: false, reason: 'number_not_linked', phoneNumberId: input.phoneNumberId };
    const { rowCount } = await client.query(
      `INSERT INTO agency_inbound_route_numbers (route_id, phone_number_id, attached_by)
       VALUES ($1::uuid, $2::uuid, $3::uuid)
       ON CONFLICT (phone_number_id) WHERE detached_at IS NULL DO NOTHING`,
      [input.routeId, input.phoneNumberId, input.attachedBy],
    );
    if ((rowCount ?? 0) > 0) return { ok: true, attached: true };
    const { rows: holder } = await client.query<{ route_id: string }>(
      `SELECT route_id FROM agency_inbound_route_numbers WHERE phone_number_id = $1::uuid AND detached_at IS NULL`,
      [input.phoneNumberId],
    );
    const routeId = holder[0]?.route_id;
    if (routeId === input.routeId) return { ok: true, attached: false };
    return { ok: false, reason: 'number_in_use', phoneNumberId: input.phoneNumberId, routeId: routeId ?? '' };
  }

  /** Live numbers of `routeIds`, by route, by number. */
  private async numbersOf(routeIds: string[], db: Db): Promise<Map<string, AgencyInboundRouteNumberRow[]>> {
    const out = new Map<string, AgencyInboundRouteNumberRow[]>();
    if (routeIds.length === 0) return out;
    const { rows } = await db.query<AgencyInboundRouteNumberRow & { route_id: string }>(
      `SELECT rn.route_id, rn.phone_number_id, pn.phone_number, rn.attached_at
         FROM agency_inbound_route_numbers rn
         JOIN phone_numbers pn ON pn.id = rn.phone_number_id
        WHERE rn.route_id = ANY($1::uuid[]) AND rn.detached_at IS NULL
        ORDER BY pn.phone_number`,
      [routeIds],
    );
    for (const { route_id, ...n } of rows) {
      const list = out.get(route_id) ?? [];
      list.push(n);
      out.set(route_id, list);
    }
    return out;
  }
}

/** A route read through `to_jsonb` has its timestamps as strings: make them Dates again. */
function reviveRoute(raw: AgencyInboundRouteRecord): AgencyInboundRouteRecord {
  const at = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string));
  return {
    ...raw,
    created_at: at(raw.created_at)!,
    updated_at: at(raw.updated_at)!,
    deleted_at: at(raw.deleted_at),
  };
}

export const agencyInboundRouteRepository = new AgencyInboundRouteRepository();

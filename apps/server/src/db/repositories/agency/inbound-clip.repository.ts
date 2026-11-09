/**
 * `AgencyInboundClipRepository`: an account's recordings (`audio_files`) as the inbound route
 * editor sees them (docs/inbound.md §8.4): each with the account's live routes that play it, and
 * the delete that refuses while one does.
 *
 * The rows are the shared `audio_files` table's (`packages/db`'s `audioFileRepository` writes
 * them); what is inbound's is the question "which routes play it", which reads the route's six clip
 * columns (`0024_inbound.sql`: FKs to `audio_files` ON DELETE SET NULL). A route that is deleted
 * (`deleted_at`) plays nothing and does not count. An active announcement (a campaign's abandon
 * clip) holding the file counts too: its FK would silently forget the recording.
 *
 * ── The delete and a PATCH that chooses the recording at the same time ──────────
 * The delete locks the file's row `FOR UPDATE` before it reads what uses it, and deletes it in
 * the same transaction. A route write that names the file takes the FK's `KEY SHARE` lock on that
 * row, which `FOR UPDATE` blocks: the write waits for the delete and then fails its FK check, so
 * no route is left naming a recording that is gone (the editor then reloads its choices).
 *
 * Every id is bound as a parameter; callers validate ids at the edge (`22P02`).
 */
import type { PoolClient } from 'pg';
import { getPool } from '@magick-agency/db';
import type { AgencyInboundClipOption, AgencyInboundClipRouteRef } from '@magick-agency/contracts/api/agency/inbound';

type Db = Pick<PoolClient, 'query'>;

/** The live routes of the file's account that name it in any clip slot, oldest first, as JSON. */
const ROUTES_PLAYING = `
  COALESCE((
    SELECT json_agg(json_build_object('route_id', r.id, 'name', r.name) ORDER BY r.created_at, r.id)
      FROM agency_inbound_routes r
     WHERE r.tenant_id = f.tenant_id AND r.account_id = f.account_id AND r.deleted_at IS NULL
       AND f.id IN (r.greeting_audio_id, r.hold_audio_id, r.closed_audio_id, r.busy_audio_id,
                    r.recording_notice_audio_id, r.callback_audio_id)
  ), '[]'::json)`;

interface ClipRow {
  id: string;
  name: string;
  duration_seconds: string | number | null;
  created_at: Date;
  routes: AgencyInboundClipRouteRef[];
}

function toOption(row: ClipRow): AgencyInboundClipOption {
  return {
    id: row.id,
    name: row.name,
    // NUMERIC(10,2) arrives as a string.
    duration_seconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
    created_at: row.created_at.toISOString(),
    routes: row.routes,
  };
}

/** What still uses a recording: the account's live routes, and how many active announcements. */
export interface InboundClipUsage {
  routes: AgencyInboundClipRouteRef[];
  announcements: number;
}

export class AgencyInboundClipRepository {
  /** The account's recordings, newest first, at most `limit`, each with the live routes that play it. */
  async listForAccount(tenantId: string, accountId: string, limit: number): Promise<AgencyInboundClipOption[]> {
    const { rows } = await getPool().query<ClipRow>(
      `SELECT f.id, f.name, f.duration_seconds, f.created_at, ${ROUTES_PLAYING} AS routes
         FROM audio_files f
        WHERE f.tenant_id = $1::uuid AND f.account_id = $2::uuid
        ORDER BY f.created_at DESC, f.id DESC
        LIMIT $3`,
      [tenantId, accountId, limit],
    );
    return rows.map(toOption);
  }

  /** One recording of the account as the editor lists it, or null. */
  async findOption(tenantId: string, accountId: string, id: string, db: Db = getPool()): Promise<AgencyInboundClipOption | null> {
    const { rows } = await db.query<ClipRow>(
      `SELECT f.id, f.name, f.duration_seconds, f.created_at, ${ROUTES_PLAYING} AS routes
         FROM audio_files f
        WHERE f.id = $3::uuid AND f.tenant_id = $1::uuid AND f.account_id = $2::uuid`,
      [tenantId, accountId, id],
    );
    return rows[0] ? toOption(rows[0]) : null;
  }

  /**
   * Delete one of the account's recordings unless something uses it, in the caller's transaction
   * (see the module note for the lock). `not_found`: no such recording in the account; `in_use`:
   * the live routes (and active announcements) that use it. On `deleted`, the object's S3 key, for
   * the caller to remove once the transaction commits.
   */
  async deleteUnused(
    client: PoolClient,
    tenantId: string,
    accountId: string,
    id: string,
  ): Promise<{ result: 'deleted'; s3Key: string } | { result: 'not_found' } | ({ result: 'in_use' } & InboundClipUsage)> {
    const locked = await client.query<{ s3_key: string }>(
      `SELECT s3_key FROM audio_files
        WHERE id = $3::uuid AND tenant_id = $1::uuid AND account_id = $2::uuid
        FOR UPDATE`,
      [tenantId, accountId, id],
    );
    const row = locked.rows[0];
    if (!row) return { result: 'not_found' };
    const usage = await client.query<{ routes: AgencyInboundClipRouteRef[]; announcements: number }>(
      `SELECT ${ROUTES_PLAYING} AS routes,
              (SELECT COUNT(*)::int FROM announcements a
                WHERE a.audio_file_id = f.id AND a.is_active) AS announcements
         FROM audio_files f
        WHERE f.id = $1::uuid`,
      [id],
    );
    const { routes, announcements } = usage.rows[0]!;
    if (routes.length > 0 || announcements > 0) return { result: 'in_use', routes, announcements };
    await client.query('DELETE FROM audio_files WHERE id = $1::uuid', [id]);
    return { result: 'deleted', s3Key: row.s3_key };
  }
}

export const agencyInboundClipRepository = new AgencyInboundClipRepository();

import { getPool } from '../connection.js';
import { buildUpdateSet } from '../utils/sql-update.js';
import { AGENCY_FLAGS } from '@magick-agency/contracts/flags';
import type { FlagDefinition } from '@magick-agency/contracts/flags';
import type {
  WebRtcCallRecord,
  CreateWebRtcCallInput,
  UpdateWebRtcCallInput,
} from '../models/agency-call.model.js';

/*
 * PORT NOTE (magick-agency): ported from core `src/db/repositories/webrtc-call.repository.ts`
 * (v1.123.2). Changes, each in PORTING.md:
 *  - every statement targets `agency_calls` (the baseline's rename of `webrtc_calls`);
 *  - `telephony_credential_id` (BYOC) and `sip_connection_id` (SIP) are gone from
 *    the INSERT and the list projection, as the baseline dropped the columns;
 *  - the default `provider` is `'voicelink'` (VoBiz is deleted; the baseline's
 *    column default is `'voicelink'` too);
 *  - `WebRtcCallScope` is `'agency'` only — the softphone (`'dialer'`) is
 *    deleted (plan §5), and `analysisFlagFor` returns `agency_call_analysis`.
 *    `scopeClause` keeps core's body, so untyped code that omits the scope still
 *    fails closed to `campaign_id IS NULL` (see the scope unit test);
 *  - the flag definition comes from `@magick-agency/contracts/flags`, which the
 *    server's registry (`apps/server/src/feature-flags/registry.ts`) also reuses,
 *    because this package cannot import the server;
 *  - exported as `agencyCallRepository`, with `webrtcCallRepository` aliasing it
 *    so ported call sites compile unchanged.
 * The comment below is core's, verbatim; its file list describes core.
 */

/*
 * ─── What the required `scope` parameter does and does NOT audit ─────────────
 *
 * `findByIdScoped` and `listByTenant` take a required `scope`, and the compile
 * errors from adding it were the audit checklist for the read path
 * (`docs/reference/magickvoice-platform/docs/agency-dialer-design.md` §7b). Anyone relying on that checklist should
 * know its edge: **it enumerates callers of these two methods, and nothing else.**
 * A reader that writes `FROM webrtc_calls` itself is invisible to it, because
 * there is no call site for the type checker to fail.
 *
 * As of this writing three modules outside this file read the table directly, and
 * all three are deliberate:
 *
 * - `maintenance/retention-purge.ts` — carries its own `campaign_id` predicate on
 *   every statement, because the two products purge on different windows. It is
 *   scoped; it just does not go through here.
 * - `db/repositories/dialer-analysis-job.repository.ts` — the analysis worker's
 *   job-keyed reads and `analysis_status` writes. Product-agnostic on purpose:
 *   the analysis pipeline is one shared machine and a job already names exactly
 *   one call, so there is no population to scope.
 * - `db/repositories/tenant-telephony-credential.repository.ts`
 *   (`countLiveCallsByCredential`) — **the named exception.** It counts live calls
 *   across BOTH products before letting an admin revoke a carrier credential, and
 *   counting both is the correct answer: revoking strands whichever calls are on
 *   that credential, so a scoped count would under-report and wave through a
 *   revoke that kills the other product's live calls. It is a platform-zone
 *   safety check (§7b's third zone), not a product read path.
 *
 * The rule that separates them: **scope the reads that ANSWER A PRODUCT'S
 * QUESTION; do not scope the ones that answer the platform's.** If you add a
 * reader of `webrtc_calls` anywhere, decide which of those it is — the type
 * checker will not ask you.
 */

/** Columns the generic `update()` may write — allow-list guards against unexpected keys. */
const WEBRTC_UPDATABLE_COLUMNS: ReadonlySet<string> = new Set([
  'provider_call_id', 'status', 'outcome', 'error_code', 'error_message',
  'recording_url', 'recording_duration_seconds',
  'answered_at', 'ended_at', 'duration_seconds', 'talk_time_seconds',
  // Mutable analysis columns (the runner writes these). analysis_profile_id /
  // analysis_consent / analysis_consent_at are immutable after insert — omitted.
  'analysis_status', 'call_analysis', 'conversation_log', 'transcript_meta',
]);

/** Analysis blobs that must be JSON.stringify'd before binding. */
const WEBRTC_JSON_COLUMNS: ReadonlySet<string> = new Set([
  'call_analysis', 'conversation_log', 'transcript_meta',
]);

/**
 * `campaign_id` is projected deliberately. It is the scope discriminator (see
 * `docs/reference/magickvoice-platform/docs/agency-dialer-design.md` §7b) and the list could not label — or even
 * recognise — a foreign row without it.
 *
 * All webrtc_calls columns except the heavy analysis JSONB blobs
 * (call_analysis, conversation_log, transcript_meta) — the same split
 * CALL_LIST_COLUMNS makes. `analysis_status` and `analysis_profile_id` are
 * included so the list can render/filter analysis without pulling the blobs.
 *
 * `analysis_sentiment_label` is a SCALAR projected out of the `call_analysis`
 * JSONB (without selecting the whole blob) so the list's Sentiment column has a
 * value — the blob itself is deliberately excluded here. COALESCE handles both
 * the nested `common.overall_sentiment.label` shape and the legacy-flat
 * `overall_sentiment.label` shape, matching batch-analytics.
 */
const WEBRTC_LIST_COLUMNS = `
  id, tenant_id, account_id, caller_id, destination_phone,
  provider, provider_call_id, status, outcome, error_code, error_message,
  initiated_by, metadata,
  recording_requested, recording_url, recording_duration_seconds,
  campaign_id,
  answered_at, ended_at, duration_seconds, talk_time_seconds,
  analysis_profile_id, analysis_language, analysis_status,
  analysis_consent, analysis_consent_at,
  COALESCE(
    call_analysis->'common'->'overall_sentiment'->>'label',
    call_analysis->'overall_sentiment'->>'label'
  ) AS analysis_sentiment_label,
  created_at, updated_at
`;

/**
 * Which product owns the calls a read is asking for.
 *
 * `webrtc_calls` holds both products' calls and stays one table by design
 * (migration 076). This is the boundary between them
 * (`docs/reference/magickvoice-platform/docs/agency-dialer-design.md` §7b).
 *
 * **The enum's meaning is product ownership, not the shape of the predicate.**
 * `'dialer'` happens to resolve to `campaign_id IS NULL` today, but callers must
 * not encode that: when agency grows an off-campaign dial mode (preview dialing,
 * agent callbacks, a manual dial from the station) those calls will be
 * agency-owned with no campaign, and the fix is one change to `scopeClause`
 * rather than a hunt through every call site.
 */
export type WebRtcCallScope = 'agency';

/** SQL for a scope. The one place the enum's storage mapping is written down. */
function scopeClause(scope: WebRtcCallScope): string {
  return scope === 'agency' ? 'campaign_id IS NOT NULL' : 'campaign_id IS NULL';
}

/**
 * The feature flag that owns post-call analysis for a scope's product.
 *
 * Beside `scopeClause` deliberately: both answer "what does this scope mean, in
 * terms of X", and the two mappings drift the moment they live in different
 * files. There is one enum, so there is one place that translates it.
 *
 * Why the mapping is needed at all: `dialer_call_analysis` used to gate agency
 * legs too, which meant a tenant enabling softphone analysis started paying for
 * transcription on every campaign call, and a tenant disabling it lost agency
 * analysis it had bought separately. `agency_call_analysis` is the agency switch
 * (`feature-flags/registry.ts` carries the argument, including why its default
 * stays false).
 *
 * The three consumers are the end-of-call gate (`webrtc-bridge-manager.ts`) and
 * the two request-time preflights (`analysis/profile-preflight.ts`, reached from
 * the softphone's `POST /webrtc-call` and the agency campaign writes). They must
 * agree: a preflight that accepts a profile a product's flag will not analyse
 * against is a silent no-op at end of call, and the reverse is a 403 on a
 * feature the tenant is paying for.
 *
 * Not used by `call-analysis-profiles.routes.ts`, and that is not an oversight —
 * a profile row belongs to no product, so that surface ORs the two flags. Its
 * header says why.
 */
export function analysisFlagFor(scope: WebRtcCallScope): FlagDefinition<boolean> {
  // PORT NOTE (magick-agency): agency product only — every call is an agency
  // call, and `dialer_call_analysis` is not in agency's flag registry.
  return AGENCY_FLAGS.agency_call_analysis;
}

export class WebRtcCallRepository {
  async create(input: CreateWebRtcCallInput): Promise<WebRtcCallRecord> {
    const pool = getPool();
    const result = await pool.query<WebRtcCallRecord>(
      `INSERT INTO agency_calls
        (tenant_id, account_id, caller_id, destination_phone, provider,
         initiated_by, metadata, recording_requested,
         analysis_profile_id, analysis_language, analysis_consent, analysis_consent_at,
         campaign_id, agency_attempt_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [
        input.tenant_id,
        input.account_id,
        input.caller_id,
        input.destination_phone,
        input.provider || 'voicelink',
        input.initiated_by ?? null,
        JSON.stringify(input.metadata ?? {}),
        input.recording_requested ?? false,
        input.analysis_profile_id ?? null,
        input.analysis_language ?? null,
        input.analysis_consent ?? null,
        input.analysis_consent_at ?? null,
        input.campaign_id ?? null,
        input.agency_attempt_id ?? null,
      ],
    );
    return result.rows[0]!;
  }

  async findById(id: string): Promise<WebRtcCallRecord | null> {
    const pool = getPool();
    const result = await pool.query<WebRtcCallRecord>(
      'SELECT * FROM agency_calls WHERE id = $1',
      [id],
    );
    return result.rows[0] || null;
  }

  /**
   * Tenant+account-scoped lookup (returns null for another tenant/account → 404).
   *
   * Also refuses the other product's rows. Every `/api/v1/webrtc-call/*` handler
   * reaches its record through this function, so pinning `scope: 'dialer'` there
   * is what makes an agency call invisible and untouchable through the softphone's
   * routes — read, recording, hangup and erasure alike
   * (`docs/reference/magickvoice-platform/docs/agency-dialer-design.md` §7b).
   *
   * `scope` is required and has no default on purpose. A default would type-check
   * every call site immediately and silently leave them unaudited; the compile
   * error is the point.
   *
   * The unscoped `findById` is unaffected and stays that way. Its callers are the
   * bridge (`webrtc-bridge-manager.ts`, the late-terminal and analysis-gate
   * paths), the analysis runner, and — the one worth naming in review —
   * `webrtc-recordings.routes.ts`, an UNAUTHENTICATED signed-token playback
   * route. That route is externally reachable, so it is not merely "internal":
   * what makes it safe is that the signed token is the authorization and every
   * route that mints one is scope-gated. Its own header comment carries the
   * argument and the list of minters.
   */
  async findByIdScoped(
    id: string,
    tenantId: string,
    accountId: string,
    scope: WebRtcCallScope,
  ): Promise<WebRtcCallRecord | null> {
    const pool = getPool();
    const result = await pool.query<WebRtcCallRecord>(
      `SELECT * FROM agency_calls
       WHERE id = $1 AND tenant_id = $2 AND account_id = $3
         AND ${scopeClause(scope)}`,
      [id, tenantId, accountId],
    );
    return result.rows[0] || null;
  }

  /**
   * One product's call history. `scope` selects which
   * (`docs/reference/magickvoice-platform/docs/agency-dialer-design.md` §7b) and is required — it sits ahead of the
   * paging arguments precisely so it cannot be given a default.
   *
   * The scope is applied to the count query as well as the data query. Filtering
   * one and not the other is worse than filtering neither: the page shows the
   * right rows under a total that counts the other product's calls, and the pager
   * runs off the end into empty pages — which looks like data loss rather than a
   * missing predicate.
   */
  async listByTenant(
    tenantId: string,
    accountId: string,
    scope: WebRtcCallScope,
    limit = 20,
    offset = 0,
    opts?: { status?: string; phone?: string; analysis_status?: string },
  ): Promise<{ rows: WebRtcCallRecord[]; total: number }> {
    const pool = getPool();
    const values: unknown[] = [tenantId, accountId];
    let filterClause = '';
    if (opts?.status) {
      values.push(opts.status);
      filterClause += ` AND status = $${values.length}`;
    }
    if (opts?.phone) {
      values.push(opts.phone);
      filterClause += ` AND destination_phone = $${values.length}`;
    }
    if (opts?.analysis_status) {
      values.push(opts.analysis_status);
      filterClause += ` AND analysis_status = $${values.length}`;
    }

    const scopeSql = scopeClause(scope);

    const countResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM agency_calls
       WHERE tenant_id = $1 AND account_id = $2 AND ${scopeSql}${filterClause}`,
      values,
    );
    const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

    const dataValues = [...values, limit, offset];
    const dataResult = await pool.query<WebRtcCallRecord>(
      `SELECT ${WEBRTC_LIST_COLUMNS} FROM agency_calls
       WHERE tenant_id = $1 AND account_id = $2 AND ${scopeSql}${filterClause}
       ORDER BY created_at DESC, id DESC LIMIT $${dataValues.length - 1} OFFSET $${dataValues.length}`,
      dataValues,
    );

    return { rows: dataResult.rows, total };
  }

  async update(id: string, input: UpdateWebRtcCallInput): Promise<WebRtcCallRecord | null> {
    const { clauses, values } = buildUpdateSet(input, WEBRTC_UPDATABLE_COLUMNS, WEBRTC_JSON_COLUMNS);
    if (clauses.length === 0) return this.findById(id);

    values.push(id);
    const pool = getPool();
    const result = await pool.query<WebRtcCallRecord>(
      `UPDATE agency_calls SET ${clauses.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values,
    );
    return result.rows[0] || null;
  }

  /**
   * Fail stuck WebRTC rows: any active call older than `olderThan` is a row that
   * never settled. Atomically marks it `failed` (error_code='STUCK_ACTIVE_CALL')
   * and returns the updated rows so the caller can dispatch the credit-releasing
   * settlement exactly once. `excludeIds` are the calls this replica is actively
   * bridging in memory; the age threshold guards live long calls on other replicas.
   * Uses `FOR UPDATE SKIP LOCKED` so concurrent sweeps do not double-claim a row.
   */
  async failStaleActive(olderThan: Date, excludeIds: string[] = [], limit = 1000): Promise<WebRtcCallRecord[]> {
    const pool = getPool();
    const exclude = excludeIds.length > 0 ? excludeIds : null;
    const result = await pool.query<WebRtcCallRecord>(
      `UPDATE agency_calls SET
         status = 'failed',
         outcome = 'stuck_active_call',
         error_code = 'STUCK_ACTIVE_CALL',
         error_message = 'stuck active call: WebRTC call exceeded the self-heal sweep window without reaching a terminal state',
         ended_at = now(),
         duration_seconds = COALESCE(duration_seconds, EXTRACT(EPOCH FROM (now() - created_at))::int),
         talk_time_seconds = COALESCE(talk_time_seconds, 0)
       WHERE id IN (
         SELECT id FROM agency_calls
         WHERE status IN ('initiating','ringing','in_progress')
           AND created_at < $1
           AND ($2::uuid[] IS NULL OR NOT (id = ANY($2::uuid[])))
         ORDER BY created_at
         LIMIT $3
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [olderThan, exclude, limit],
    );
    return result.rows;
  }
}

export const agencyCallRepository = new WebRtcCallRepository();
/** Core's export name, kept so ported call sites compile unchanged. */
export const webrtcCallRepository = agencyCallRepository;

import { auditRepository as platformAuditRepository } from '@magick-agency/db/repositories/platform/audit.repository';
import { auditRepository } from '@magick-agency/db/repositories/audit.repository';
import { userRepository } from '@magick-agency/db/repositories/user.repository';
import { createChildLogger } from '@magick-agency/observability';
import { getAuditRetentionHorizon } from '../audit/audit-retention.js';
import {
  mergeActivityPage,
  normalizeCoreRow,
  normalizeMasterRow,
  type ActivityCursor,
  type ActivityRow,
  type CoreAuditLogRow,
} from './agency-activity.js';

const log = createChildLogger({ component: 'agency-activity' });

/*
 * The campaign activity trail merges TWO tables (decision B7): `platform_audit_log` (the
 * "Console" half, `platform/audit.repository`) and `audit_logs` (the "Dialer" half, read
 * through the shared `auditRepository.findFiltered`).
 *
 * `readCore` reads the `audit_logs` half:
 *   - scope: `tenant_id` AND `account_id` — the campaign's owning account;
 *   - filters: `event_type` list, `event_data->>'campaign_id'`, `from`, `to`, the keyset
 *     `(before_at, before_id)`, `with_total`, all inside `findFiltered`;
 *   - ordering: `date_trunc('milliseconds', timestamp) DESC, id DESC` (inside `findFiltered`);
 *   - the retention horizon read in parallel, `getAuditRetentionHorizon()`;
 *   - the row enumeration: id, timestamp, event_type, event_category, severity, actor,
 *     call_id, request_id, event_data. `tenant_id`/`account_id`/`ip_address`/`duration_ms`
 *     are NOT carried onto the merged trail.
 *
 * Both tables are in one database, so a failing read of either propagates: there is no
 * partial answer to give. `partial` stays on the wire (the contract declares it) and is always
 * `false`/`null`. There are no platform API keys, so actors resolve to users only.
 */

/**
 * The two reads behind the campaign activity route.
 *
 * ── Both halves are required now ────────────────────────────────────────────
 * An audit trail that quietly drops rows is worse than one that 500s, because a short list and a
 * complete list look identical. With both tables in one database there is no degraded mode to
 * announce, so a failure of either read is a failure of the page.
 */

export interface ActivityRetention {
  earliest_retained_at: string | null;
  source: string;
}

export interface ActivityQuery {
  tenantId: string;
  campaignId: string;
  /**
   * The campaign's OWNING account, read off the campaign row, not off the request. It scopes the
   * `audit_logs` half (its `account_id` predicate). The `platform_audit_log` half is scoped by
   * tenant and campaign.
   */
  accountId: string;
  actions?: string[];
  from?: Date;
  to?: Date;
  limit: number;
  cursor: ActivityCursor;
  /**
   * Drop the `COUNT(*)` on both sides and report `total: null`.
   *
   * Set by the CSV export, which pages the trail to its end and never reads the number.
   */
  skipTotal?: boolean;
}

export interface ActivityPage {
  rows: ActivityRow[];
  nextCursor: ActivityCursor | null;
  /**
   * Rows matching the filter across BOTH stores. A total that silently counted only one
   * half would be the same lie as a silently short list.
   *
   * `null` when the caller passed `skipTotal` — "not counted" is an absence to anyone reading
   * the number.
   */
  total: number | null;
  /** Always `false` in one process; kept because the wire contract carries it. */
  partial: false;
  partial_reason: null;
  /** The `audit_logs` retention horizon. */
  retention: ActivityRetention | null;
}

export async function fetchActivityPage(query: ActivityQuery): Promise<ActivityPage> {
  // One extra row per side is exactly what distinguishes "exhausted" from "more
  // to come" without a second query. See `mergeActivityPage`.
  const fetchSize = query.limit + 1;

  const [master, core] = await Promise.all([
    readMaster(query, fetchSize),
    // Reading an unowned campaign's audit rows is exactly what the ownership check exists to
    // prevent. `accountId` is required and comes from the campaign row the caller proved it
    // owns, so the guard is a type, not a branch.
    readCore(query, fetchSize),
  ]);

  // One query for the page's identities — never one per row.
  const displayNames = await resolveDisplayNames(master.logs, query.tenantId);

  const merged = mergeActivityPage({
    masterRows: master.logs.map((row) => normalizeMasterRow(row, displayNames)),
    coreRows: core.rows.map(normalizeCoreRow),
    limit: query.limit,
    cursor: query.cursor,
  });

  return {
    rows: merged.rows,
    nextCursor: merged.nextCursor,
    // Both halves or nothing. A total that silently counted only the console half is
    // the same lie as the short list this whole branch exists to avoid — and a
    // `skipTotal` read has no halves to add, so it lands on the same `null`
    // through `master.total` rather than through a second branch that could
    // disagree with this one.
    total: master.total !== null && core.total !== null ? master.total + core.total : null,
    partial: false,
    partial_reason: null,
    retention: core.retention,
  };
}

function readMaster(query: ActivityQuery, fetchSize: number) {
  return platformAuditRepository.find({
    tenantId: query.tenantId,
    // Scoped by campaign, deliberately WITHOUT an account predicate. The caller's
    // ownership of this campaign is verified before either read, so the campaign
    // id already confines the result to their account — while an account
    // predicate would additionally drop every row written before the account
    // column was populated, which are exactly the historical rows a reviewer is looking
    // for. (`GET /audit-log` is tenant-wide and does need the predicate.)
    campaignId: query.campaignId,
    ...(query.actions ? { actions: query.actions } : {}),
    ...(query.from ? { from: query.from } : {}),
    ...(query.to ? { to: query.to } : {}),
    ...(query.cursor.master
      ? { before: { createdAt: new Date(query.cursor.master.at), id: query.cursor.master.id } }
      : {}),
    // Unconditional, including the FIRST page, which has no `before` yet.
    // Ordering belongs to the walk, not to the individual request: page one
    // ordered by the raw column and page two by the truncated one disagree
    // within a millisecond, and rows straddling that boundary would be emitted
    // on neither page. That is the silent row loss the truncation exists to
    // prevent, so the flag is set here rather than derived from `cursor.master`.
    // The repository throws if a `before` ever arrives without it.
    keysetOrder: true,
    limit: fetchSize,
    ...(query.skipTotal ? { withTotal: false } : {}),
  });
}

interface CoreReadResult {
  rows: CoreAuditLogRow[];
  total: number | null;
  retention: ActivityRetention | null;
}

/** The `audit_logs` half of the trail. */
async function readCore(query: ActivityQuery, fetchSize: number): Promise<CoreReadResult> {
  // The horizon is annotation, never gating: `getAuditRetentionHorizon` reports `unknown` rather
  // than throwing on a failed catalog read.
  const [result, retention] = await Promise.all([
    auditRepository.findFiltered({
      tenantId: query.tenantId,
      accountId: query.accountId,
      ...(query.actions && query.actions.length > 0 ? { eventTypes: query.actions } : {}),
      campaignId: query.campaignId,
      ...(query.from ? { from: query.from } : {}),
      ...(query.to ? { to: query.to } : {}),
      ...(query.cursor.core
        ? { before: { timestamp: new Date(query.cursor.core.at), id: query.cursor.core.id } }
        : {}),
      limit: fetchSize,
      // Only false when skipping; an omitted flag is the repository's default (count), which is
      // what every other caller relies on.
      withTotal: !query.skipTotal,
    }),
    getAuditRetentionHorizon(),
  ]);

  return {
    // Enumerated, so operator IPs and durations never reach the trail.
    rows: result.rows.map((row) => ({
      id: row.id,
      timestamp: new Date(row.timestamp).toISOString(),
      event_type: row.event_type,
      event_category: row.event_category,
      severity: row.severity,
      actor: row.actor,
      call_id: row.call_id,
      request_id: row.request_id,
      event_data: row.event_data ?? {},
    })),
    total: result.total,
    retention,
  };
}

/**
 * One query for the whole page, never one per row — the "no per-item loops over
 * I/O" rule, and the same N+1 `enrichAssignedAgents` exists to avoid.
 *
 * Degrades to an empty map: the trail is the answer and it is already in hand, so
 * an identity lookup must never fail the read. A row then reports the `user_id`
 * with a null display rather than disappearing.
 */
async function resolveDisplayNames(
  logs: ReadonlyArray<{ user_id: string | null }>,
  tenantId: string,
): Promise<Map<string, string | null>> {
  const userIds = [...new Set(logs.map((row) => row.user_id).filter((id): id is string => id !== null))];
  if (userIds.length === 0) return new Map();

  try {
    const identities = await userRepository.findIdentitiesInTenant(userIds, tenantId);
    const names = new Map<string, string | null>();
    for (const identity of identities) {
      const name = identity.display_name?.trim();
      names.set(identity.id, name && name.length > 0 ? name : identity.email);
    }
    return names;
  } catch (err) {
    log.warn(
      { tenantId, users: userIds.length, err: err instanceof Error ? err.message : String(err) },
      'agency activity: identity resolution failed; emitting null display names',
    );
    return new Map();
  }
}

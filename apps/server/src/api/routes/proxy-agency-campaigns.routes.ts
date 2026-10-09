import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import crypto from 'node:crypto';
import { sessionMiddleware } from '../../auth/session.middleware.js';
import { tenantContextMiddleware } from '../middleware/tenant-context.middleware.js';
import { requirePermission } from '../../rbac/rbac.middleware.js';
import { callCore } from '../core-dispatch.js';
import { ACCOUNT_HEADER } from '../middleware/headers.js';
import { createChildLogger } from '@magick-agency/observability';
import { platformAuditLogger } from '../../audit/platform/audit-logger.js';
import { requestAuditActor, resolvedUserAuditActor } from '../../audit/platform/audit-actor.js';
import {
  assertBehavioralCapabilitiesForConfig,
  resolveInheritedBehavioralConfig,
} from '../../agency/campaign-behavioral-settings.js';
import {
  validateAgencyCampaignConfig,
  withCampaignConfigDefaults,
  issuesToDetails,
} from '../../agency/agency-campaign-config.js';
import type { ConfigIssue } from '../../agency/agency-campaign-config.js';
// PORT NOTE (magick-agency): master's `getFileBuffer` is core's `getFile` here — one S3 module
// (decision B14, lane C's port of core's `storage/s3.ts`): the same `GetObjectCommand` on the
// same bucket, returning the whole object as a Buffer. Aliased so the call site stays master's.
import { uploadFile, getFileStream, getFile as getFileBuffer } from '../../storage/s3.js';
import {
  analyzeAgencyCsvColumns,
} from '../../agency/agency-column-analysis.js';
import {
  AgencyIngestError,
  AGENCY_MAX_COLUMNS,
  AGENCY_MAX_ROWS,
  AGENCY_MAX_CELL_BYTES,
} from '../../agency/agency-csv-ingest.js';
import { agencyIngestJobRepository } from '../../agency/agency-ingest-job.repository.js';
import { isTenantUploadKey, uploadKey } from '../../agency/agency-ingest-keys.js';
import { agencyIngestService } from '../../agency/agency-ingest.service.js';
import { supersedeRoster, RosterSupersedeError } from '../../agency/agency-roster.client.js';
import { enrichAgencyCampaignStats } from '../../agency/agency-stats-enrichment.js';
import {
  ACTIVITY_DEFAULT_LIMIT,
  ACTIVITY_EXPORT_MAX_ROWS,
  ACTIVITY_EXPORT_PAGE_SIZE,
  ACTIVITY_EXPORT_TIME_BUDGET_MS,
  ACTIVITY_MAX_LIMIT,
  activityCsvHeader,
  activityCsvRow,
  buildActivityCsvPreamble,
  decodeActivityCursor,
  encodeActivityCursor,
  type ActivityCursor,
  type ActivityCsvPreambleRetention,
  type ActivityExportTruncation,
} from '../../agency/agency-activity.js';
import { CAMPAIGN_ACTIVITY_ACTIONS } from '../../agency/agency-activity-actions.js';
import { fetchActivityPage } from '../../agency/agency-activity.service.js';
import { resolveAgentNames } from '../../agency/agency-agent-identity.js';
import {
  ATTEMPT_QUERY_PARAMS,
  CONTACT_QUERY_PARAMS,
  PAGING_QUERY_PARAMS,
  SPINE_EXPORT_MAX_ROWS,
  SPINE_EXPORT_PAGE_SIZE,
  SPINE_EXPORT_TIME_BUDGET_MS,
  asSpinePage,
  attemptCsvHeader,
  attemptCsvRow,
  buildSpineCsvPreamble,
  contactCsvHeader,
  contactCsvRow,
  enrichAttemptAgentNames,
  forwardAllowedQuery,
  unknownQueryParamsError,
  PREAMBLE_QUERY_PARAMS,
  type SpineAttemptRow,
  type SpineContactRow,
  type SpineExportTruncation,
} from '../../agency/agency-spine.js';
import {
  CAMPAIGN_SERIES_BUCKETS,
  CAMPAIGN_SERIES_MAX_WINDOW_DAYS,
  CAMPAIGN_SERIES_QUERY_PARAMS,
  MS_PER_DAY,
  TRANSITION_ACTOR_LOOKUP_TIMEOUT_MS,
  parseSeriesInstant,
  resolveSeriesQuery,
  type AgencyCampaignStatsSeries,
  type AgencyCampaignTransitionRequest,
} from '../../agency/agency-campaign-wire.js';
import { rejectPathEscapingParams } from './helpers/path-params.js';

/**
 * The ownership probe's outcome. Core REFUSING is forwarded verbatim and returns
 * `null` instead.
 *
 * PORT NOTE (magick-agency): master's second arm, `{ verified: false, coreAccountId:
 * null, name: null }`, was core being UNREACHABLE over HTTP. In-process the probe is
 * core's handler body (`callCore`), which answers or throws; there is no "could not
 * ask" outcome to carry, and lane B2 deleted the `unverifiedAccountScope` read it fed
 * (PORTING lane B2, "Activity service"). `coreAccountId` is renamed `accountId`: it is
 * the campaign row's own account, which `ActivityQuery.accountId` now takes.
 */
type OwnedCampaign = { accountId: string; name: string | null };
import { config } from '../../config/index.js';

const log = createChildLogger({ component: 'proxy-agency-campaigns' });

/**
 * Ceiling on one filter VALUE as recorded in an export's audit row.
 *
 * Generous next to any real filter (a disposition code, an E.164 number, an
 * ISO timestamp) and far below anything that would bloat the audit store.
 */
const AUDIT_FILTER_VALUE_MAX_CHARS = 200;

/** Selector dimensions kept on the audit row. Core's vocabulary has seven. */
const AUDIT_SELECTOR_MAX_KEYS = 20;

/** Values kept per array dimension, e.g. `last_outcome: [...]`. */
const AUDIT_SELECTOR_MAX_ARRAY_ITEMS = 50;

/**
 * Bound a retry selector before it lands on the compliance trail.
 *
 * The selector belongs on the row — it is the operator's INTENT, the record of
 * which cohort somebody chose to re-dial — but it is caller-controlled and open
 * (`z.record(z.unknown())`), so it can carry a dumped phone roster, a 10k
 * disposition string, or a few thousand keys.
 *
 * This file already paid for exactly that once: `boundedFilters` and
 * `AUDIT_FILTER_VALUE_MAX_CHARS` exist because a 200KB filter value landed
 * verbatim, repeatably, on the one trail a compliance reader depends on. The
 * retry row is worse in one respect: it is written on every successful create,
 * it must survive the child being deleted, and `platform_audit_log` partitions
 * drop only by age — nothing purges a wide row early.
 *
 * Same treatment, same constants where they apply. Keys are KEPT (an unknown
 * dimension is itself a fact worth recording) and values are bounded; a
 * truncation is MARKED rather than silently cut, so a reader can never mistake a
 * clipped list for the whole selection. A nested object is replaced by its type
 * rather than walked: the legal vocabulary is strings, arrays of strings,
 * numbers and booleans, so anything else is already not a selector master needs
 * to reproduce.
 */
function boundedSelector(selector: Record<string, unknown>): Record<string, unknown> {
  const clip = (value: string): string =>
    value.length > AUDIT_FILTER_VALUE_MAX_CHARS
      ? `${value.slice(0, AUDIT_FILTER_VALUE_MAX_CHARS)}…[truncated]`
      : value;

  const bound = (value: unknown): unknown => {
    if (typeof value === 'string') return clip(value);
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
    if (Array.isArray(value)) {
      const kept = value.slice(0, AUDIT_SELECTOR_MAX_ARRAY_ITEMS).map(bound);
      return value.length > AUDIT_SELECTOR_MAX_ARRAY_ITEMS
        ? [...kept, `…[${value.length - AUDIT_SELECTOR_MAX_ARRAY_ITEMS} more truncated]`]
        : kept;
    }
    return `[${typeof value}]`;
  };

  const entries = Object.entries(selector);
  const out: Record<string, unknown> = Object.fromEntries(
    entries.slice(0, AUDIT_SELECTOR_MAX_KEYS).map(([key, value]) => [clip(key), bound(value)]),
  );
  if (entries.length > AUDIT_SELECTOR_MAX_KEYS) {
    out['…truncated'] = `${entries.length - AUDIT_SELECTOR_MAX_KEYS} more dimensions`;
  }
  return out;
}

/**
 * Core refused a page mid-export.
 *
 * Thrown rather than returned so the drain loop stops where it is and the
 * caller forwards core's own status verbatim — a 404 for a campaign the caller
 * does not own, a 400 for a filter core rejected. The half-written file is
 * discarded: a short CSV sent under a 200 is the one outcome an export must
 * never produce, because nothing about it says it is short.
 *
 * PORT NOTE (magick-agency): master's `isAbortError` (which sat between this
 * docstring and the class) is deleted. It recognised the `AbortSignal.timeout()`
 * that `proxyToCore` installed for one export page; `callCore` has no socket and
 * installs no signal, so nothing can raise it. See `drainSpineExport`.
 */
class SpineExportRefused extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    super(`agency spine export refused with ${status}`);
    this.name = 'SpineExportRefused';
  }
}

/**
 * Campaign CRUD and roster ingest.
 *
 * ── The ownership split, and why master keeps no campaign table ────────────
 * Core owns `agency_campaigns` — name, caller IDs, calling windows, disposition
 * catalog, `context_display`, status (its migration 072). Master does NOT keep a
 * second copy: campaign CRUD here is a thin proxy, because two writable copies
 * of one business object is how they drift, and core's pacing engine has to read
 * the authoritative version on every tick anyway.
 *
 * What master genuinely owns is the FILE and the act of turning it into a
 * roster — the S3 object, the operator's column mapping, and the streamed
 * hand-off (§2.2: "master remains the source of truth for the file; core for
 * the roster"). That is `agency_ingest_jobs` and the routes below it.
 *
 * ── D10: there is no concurrency setter here, and that is deliberate ───────
 * `account_settings.max_concurrent_calls` is reachable only through the
 * super-admin tree. No `/proxy/account-settings` route exists and none is being
 * added: concurrency is a commercial lever, and an account that can raise its
 * own limit can raise its own carrier spend. The supervisor dashboard renders
 * the limit read-only. If a "set concurrency" field ever appears in an AGENCY
 * campaign payload, it is a bug — core owns the campaign schema and has no such
 * column.
 *
 * One documented exception, and it does not weaken the lever (ClickUp
 * 14ygtkj9pgr, design D7/Q1): BROADCASTS (AI voice, voice message, IVR — not
 * agency campaigns) now expose the account's limit READ-ONLY through
 * `GET /proxy/calls/concurrency-limits`, a narrow projection with no version or
 * revision fields, and accept a per-broadcast `max_concurrency` that can only
 * LOWER concurrency: it is validated against that same allocation, and core
 * enforces `min(cap, account, provider, global)` on top. Nothing on the tenant
 * surface can raise an account's limit; changing a running broadcast's cap is
 * super-admin only.
 */

/**
 * Best-effort extraction of the resulting campaign status for the audit trail
 * (`MAG-70`). Core's response body on a lifecycle action IS the updated
 * campaign, but master keeps no campaign schema (see the ownership-split
 * comment above), so the body is untyped here and this narrows defensively
 * rather than trusting its shape — a malformed/unexpected core response must
 * never throw out of an audit call and take the request down with it.
 */
function extractCampaignStatus(body: unknown): string | undefined {
  return extractCampaignField(body, 'status') ?? undefined;
}

/** The same defensive narrowing, for any string field of core's campaign body. */
function extractCampaignField(body: unknown, field: string): string | null {
  if (body && typeof body === 'object' && field in body) {
    const value = (body as Record<string, unknown>)[field];
    return typeof value === 'string' ? value : null;
  }
  return null;
}

/**
 * `action` accepts repeats (`?action=a&action=b`) and comma-separated values in
 * one param, because both are in the wild and a client that guesses wrong would
 * otherwise filter on the literal string `"a,b"` and get an empty trail it would
 * read as "nothing happened".
 *
 * The same list goes to both stores. Their vocabularies overlap but are not
 * equal — core alone writes `agency_campaign.auto_paused`, master alone writes
 * `agency_disposition.created` — so each simply returns what it has, and no
 * mapping table has to be kept in step across two repositories.
 */
const actionFilterSchema = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    const parts = (Array.isArray(value) ? value : [value])
      .flatMap((entry) => entry.split(','))
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return parts.length > 0 ? parts : undefined;
  });

const activityPeriodSchema = {
  action: actionFilterSchema,
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
};

/**
 * An inverted range is the CALLER's mistake and must read as one.
 *
 * Core validates it too (422 `Invalid Period`), but master maps any core
 * `>= 400` to `partial: 'core_error'` — so without this the supervisor is told
 * "the voice service returned an error, this trail is missing the campaign's
 * status changes", and on the CSV route gets a 424 "try again shortly" that
 * never comes right. A user input error dressed as a dependency outage sends
 * them to the wrong remedy, and to support.
 */
//
// PORT NOTE (magick-agency): kept verbatim, and it now carries more weight (lane B2
// carry-forward). Core's 422 `Invalid Period` is gone with the S2S read (`audit_logs` is
// queried directly), so without this refusal an inverted range returns an empty Dialer
// half rather than an error. Same rule as master: `from > to` is refused, `from === to`
// is allowed (the list routes' `to` is inclusive).
const orderedPeriod = (q: { from?: string; to?: string }): boolean =>
  !(q.from && q.to) || new Date(q.from) <= new Date(q.to);

const ORDERED_PERIOD_ISSUE = {
  message: '`from` must not be later than `to`',
  path: ['to'],
};

// `.refine()` is applied to each schema directly rather than through a shared
// generic helper: routing an object schema through `z.ZodType<T>` infers `T`
// from the INPUT side, which silently widened `action` back to its
// pre-transform `string | string[]` and broke the call site's typing.
const activityQuerySchema = z.object({
  ...activityPeriodSchema,
  limit: z.coerce.number().int().min(1).max(ACTIVITY_MAX_LIMIT).optional(),
  cursor: z.string().min(1).optional(),
}).refine(orderedPeriod, ORDERED_PERIOD_ISSUE);

/**
 * The `#`-comment preamble in front of the header row (see
 * `agency-activity.ts`), on by default. `false`/`'false'` is the only spelling
 * that turns it off — an unrecognised value falls through to `z.boolean()` and
 * 400s rather than being silently read as "on", the same "refuse, don't guess"
 * posture the rest of this route's query parsing takes.
 */
const preambleQuerySchema = z.preprocess((value) => {
  if (value === undefined || value === null) return true;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return value;
}, z.boolean());

/** The export walks the whole filtered trail, so it takes no cursor and no limit. */
const activityExportQuerySchema = z.object({
  ...activityPeriodSchema,
  preamble: preambleQuerySchema,
})
  .refine(orderedPeriod, ORDERED_PERIOD_ISSUE);

/**
 * `?from=&to=&bucket=` on the campaign stats SERIES read (`86d45k0bk`).
 *
 * ── Half-open `[from, to)`, and the neighbour above is the other convention ──
 * `from` is inclusive, `to` is EXCLUSIVE. That is the convention of the agent
 * `/my-stats` series — a half-open window is the only shape that tiles, so
 * consecutive requests `[Mon, Tue)` and `[Tue, Wed)` cover Tuesday exactly once,
 * which is what lets a chart page a month at a time and still sum. The attempt
 * and activity LIST routes on this same plugin use an INCLUSIVE `to`
 * ({@link orderedPeriod}, which therefore permits `from === to`), and that is
 * right for a "show me up to here" filter and wrong for an aggregate anybody
 * might add up. The two are invisibly different in a URL, so this is stated
 * rather than assumed — and it is why this schema does not reuse
 * `activityPeriodSchema`.
 *
 * Both bounds are REQUIRED, matching core's `parseAgentStatsQuery`: this read
 * aggregates and has no page, so an absent bound means "every day of this
 * campaign in one payload", and a defaulted window is worse than a refusal
 * because the caller cannot tell from the response which window they got. It is
 * also what makes the day cap enforceable at all.
 *
 * `bucket` is optional and NOT defaulted here — core defaults it to `day` and
 * echoes it back, so there is no way for a caller to be wrong about which
 * grouping they got. Validated against the enum regardless, because an unknown
 * bucket is a caller error that should not cost a core round trip.
 *
 * Refusals are `{ error: 'Validation Error', details }` like every other query
 * schema on this plugin: master's own 4xx precedes any core call, so
 * `errorMaskHook` leaves it alone, and `details` carries the offending param to
 * the client either way.
 */
const campaignSeriesQuerySchema = z
  .object({
    from: z.string().refine((value) => parseSeriesInstant(value) !== null, {
      message: 'must be an ISO-8601 date (2026-08-17) or date-time with a zone (2026-08-17T09:00:00Z)',
    }),
    to: z.string().refine((value) => parseSeriesInstant(value) !== null, {
      message: 'must be an ISO-8601 date (2026-08-17) or date-time with a zone (2026-08-17T09:00:00Z)',
    }),
    bucket: z.enum(CAMPAIGN_SERIES_BUCKETS).optional(),
  })
  .superRefine((query, ctx) => {
    const from = parseSeriesInstant(query.from);
    const to = parseSeriesInstant(query.to);
    // Unparseable bounds have already been reported per field; adding a range
    // issue on top would be a second complaint about the same typo.
    if (!from || !to) return;

    if (from.getTime() >= to.getTime()) {
      // Equality is refused too, unlike on the inclusive-`to` list routes: a
      // half-open window of zero width has no buckets and no honest answer, and
      // an empty `buckets: []` on a chart reads as a fact about the campaign
      // rather than about the request.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['from'],
        message: '`from` must be earlier than `to` (the window is half-open)',
      });
      return;
    }
    if (to.getTime() - from.getTime() > CAMPAIGN_SERIES_MAX_WINDOW_DAYS * MS_PER_DAY) {
      // The cap NAMES itself, the way core's does: a caller who wants more needs
      // to know to page by quarter rather than to discover an empty answer.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['from'],
        message: `the window must be at most ${CAMPAIGN_SERIES_MAX_WINDOW_DAYS} days — request a narrower range`,
      });
    }
  });

/*
 * ─── MAG-138: the two `behavioral` capabilities, actually enforced ───────────
 *
 * PORT NOTE (magick-agency): master defined `assertBehavioralCapabilitiesForConfig`,
 * `assertCampaignBehavioralCapabilities` and `resolveInheritedBehavioralConfig` HERE
 * (master `proxy-agency-campaigns.routes.ts:411-599`@a1f0756a). Lane A moved them into
 * `apps/server/src/agency/campaign-behavioral-settings.ts` (PORTING lane A, A.3), which
 * carries master's rationale, and this file imports them. The two interface changes
 * recorded there apply at every call site below:
 *  1. `agency.recording` / `agency.analytics` are the per-account settings row
 *     (`allow_recording` / `analyze_calls`, plan §3.2), judged for the account that
 *     OWNS the campaign — the `target` argument — never the request's header alone;
 *  2. there is no raw-`request.body` convenience: master's
 *     `assertCampaignBehavioralCapabilities(request, reply)` is gone, and each route
 *     passes the exact object it forwards to core.
 * Same 403 body, `{ error: 'capability_disabled', capability }`; a missing row or a
 * NULL column is "off", and a failed read fails closed.
 *
 * The section's `requireCapability('agency')` preHandler master kept alongside the
 * gate is deleted (no governance; the app is agency).
 */

/**
 * The calling window a retry would actually run on: the parent's two columns
 * with `config_overrides` applied on top, for the ONE cross-field rule that
 * cannot be decided from the overrides alone (wire contract §6, obligation 2).
 *
 * ── Why the override-only check is not enough ─────────────────────────────
 * `validateAgencyCampaignConfig` refuses `calling_window_start ===
 * calling_window_end`, because core reads that as PERMANENTLY CLOSED —
 * `nextOpenAt` returns null — so the campaign is saveable and can never place a
 * call, a support ticket whose cause is invisible on every screen.
 * `POST /campaigns` cannot produce one: both sides are in the same body and the
 * validator sees the pair.
 *
 * A retry can. `config_overrides: { calling_window_end: '09:00' }` against a
 * `09:00–17:00` parent names only `end`, so the override-only pass has nothing
 * to compare it to; core then merges it onto the parent and the child never
 * dials. Same hole the other way, overriding `start` to match the stored `end`.
 *
 * This is NOT re-litigating a parent that predates a rule — the parent's window
 * is valid, and it is the OVERRIDE that makes the merged pair invalid. So only
 * the two window fields are merged; catalog, retry policy and everything else
 * stay override-only, for exactly the reason obligation 2's comment gives.
 *
 * Key presence wins, matching `resolveInheritedBehavioralConfig`, and
 * `Object.hasOwn` for the same untrusted-object reason.
 *
 * Returns `[]` when the merged pair cannot be formed (a parent master could not
 * read, a non-string column), because a rule that cannot be evaluated is not a
 * rule that failed — core validates on the merged config regardless.
 */
function mergedCallingWindowIssues(
  parentCampaign: unknown,
  overrides: Record<string, unknown> | undefined,
): ConfigIssue[] {
  const parent = (parentCampaign && typeof parentCampaign === 'object' && !Array.isArray(parentCampaign))
    ? (parentCampaign as Record<string, unknown>)
    : {};
  const merged: Record<string, unknown> = {};
  let overridden = false;
  for (const key of ['calling_window_start', 'calling_window_end'] as const) {
    if (overrides && Object.hasOwn(overrides, key)) {
      merged[key] = overrides[key];
      overridden = true;
    } else if (Object.hasOwn(parent, key)) {
      merged[key] = parent[key];
    }
  }
  // Nothing was overridden ⇒ the merged window IS the parent's, and the parent's
  // stored config is not master's to re-litigate. Returning issues here would
  // make a campaign authored before the rule unretryable, with no affordance in
  // the retry dialog to clear it.
  if (!overridden) return [];
  return validateAgencyCampaignConfig(merged);
}

const CSV_MAX_BYTES = 512 * 1024 * 1024;

const columnMappingSchema = z.object({
  phone_column: z.string().min(1).max(200),
  timezone_column: z.string().min(1).max(200).optional(),
  ignore_columns: z.array(z.string().max(200)).max(AGENCY_MAX_COLUMNS).optional(),
  // Per-campaign, NOT the platform default: a US campaign's local-format
  // numbers would otherwise silently normalise to +91 and get dialed.
  default_country_code: z.string().regex(/^\+?\d{1,3}$/).optional(),
  dedupe_phones: z.boolean().optional(),
});

/**
 * The compare-and-swap that every destructive roster operation carries.
 *
 * Shared by the replace mode and the clear endpoint because it is one idea: the
 * caller states the roster size it believes it is destroying, and core refuses
 * under the campaign row lock if reality has moved. A colleague's top-up between
 * the operator seeing the screen and pressing the button is exactly the case
 * where "retire everything" is not what anyone meant, and it is invisible to
 * every other check.
 *
 * Master cannot enforce it — it holds no contact table, and a count it fetched
 * would be stale by the time it acted on it, which is the same argument the
 * PATCH handler makes about campaign status. So master's job is to REQUIRE it
 * and forward it verbatim.
 *
 * Zero is a legitimate value (clearing an empty roster is a no-op the UI may
 * still issue), so the field is `nonnegative`, not `positive`.
 */
const expectedContactsTotalSchema = z.number().int().nonnegative();

const startIngestSchema = columnMappingSchema.extend({
  s3_key: z.string().min(1).max(1024),
  file_name: z.string().min(1).max(255),
  campaign_id: z.string().uuid().optional(),
  dry_run: z.boolean().optional(),
  /**
   * What this import does to the roster the campaign already has.
   *
   * **Optional, defaulting to `append`, and that default is a deliberate
   * decision rather than an omission.** The instinct after core's 083 is to
   * require the caller to state a mode, on the grounds that an unversioned
   * implicit default is what produced this class of bug. The instinct is right
   * about the diagnosis and wrong about the remedy:
   *
   *  - What was actually missing was not a required field. It was any CONCEPT of
   *    intent at all — no field, no record on the job row, no way for an
   *    operator or a support engineer to ask afterwards which semantics ran.
   *    That is fixed by the field existing, being persisted (migration 057) and
   *    being echoed back on the job payload, not by making it mandatory.
   *  - `append` is the non-destructive value and today's behaviour, so a caller
   *    that says nothing gets exactly what it got yesterday. A missing mode can
   *    never mean `replace`; the dangerous value is unreachable without saying
   *    it.
   *  - Requiring it would break every roster upload from the currently deployed
   *    cusui for the whole window between master's deploy and cusui's, and
   *    platform deploy order is core → master → cusui. Trading a guaranteed
   *    outage for a property the fail-safe default already provides is a bad
   *    trade.
   *
   * What IS required is everything on the destructive branch: `mode: 'replace'`
   * must be stated explicitly, must carry `expected_contacts_total`, must name a
   * campaign, and must not be a dry run.
   */
  mode: z.enum(['append', 'replace']).optional(),
  /** Required for `mode: 'replace'`; ignored otherwise. */
  expected_contacts_total: expectedContactsTotalSchema.optional(),
});

const clearRosterSchema = z.object({
  expected_contacts_total: expectedContactsTotalSchema,
});

const analyzeSchema = z.object({
  s3_key: z.string().min(1).max(1024),
  default_country_code: z.string().regex(/^\+?\d{1,3}$/).optional(),
});

/**
 * Core's ceiling on the actor NAME it stores beside a retry (wire contract §2).
 *
 * Master truncates rather than refusing, and rather than leaving it to core:
 * the name is a label on an audit fact, so a long display name must never be the
 * reason a supervisor's retry does not happen. Note the deliberate difference
 * from the four lifecycle transitions on this same plugin, which implement no
 * ceiling at all ({@link AgencyCampaignTransitionRequest}) — there core does the
 * truncating and master's job is only to send what it knows. Here the contract
 * puts the ceiling on master's side of the seam, so master applies it.
 */
const RETRY_ACTOR_NAME_MAX_CHARS = 255;

/**
 * `POST /campaigns/:id/retry` — the body a BROWSER may send.
 *
 * ── `.strict()`, and the attribution fields are why ────────────────────────
 * Core's request carries `agent_user_id` and `actor_name` as well (wire contract
 * §2), and both are **master's facts, taken from the authenticated session** —
 * the `sessionCreate` seam's rule in `agency-s2s-contract.fixture.json`, which
 * states the consequence plainly: a browser that could name the actor could act
 * as a colleague. Zod's default `.strip()` would silently drop a body-supplied
 * `agent_user_id`, which is *safe* but says nothing; a client sending one is
 * either confused or probing, and both are worth an answer. `.strict()` makes it
 * a 400 naming the field.
 *
 * That refusal is master's own and precedes any core call, so `errorMaskHook`
 * leaves it alone and the field name survives to the client — the ordering
 * invariant that hook's docstring states, and the reason the parent read below
 * happens after every schema check rather than before.
 *
 * The cost of strictness, stated: a future console field lands as a 400 until
 * master learns it. That is the same trade `forwardAllowedQuery` takes for the
 * spine's query params and it is right for the same reason — one first-party
 * console, hand-written calls, and a silently dropped field on a *create* is a
 * campaign authored differently from the one the operator described.
 *
 * ── `selector` and `config_overrides` are opaque records on purpose ────────
 * The selector's vocabulary is core's (`spine-filters.ts`, DR-3) and it is
 * validated against the PARENT campaign's disposition catalog, which master does
 * not hold; the refusals are core's 400s carrying field-level `details`, so they
 * survive the mask intact. Mirroring that vocabulary here would be the parallel
 * filter language DR-3 exists to refuse, and master's copy would be the one that
 * drifts. `config_overrides` is different: it goes through
 * `validateAgencyCampaignConfig` at the handler, which is master's existing
 * campaign-config validator, not a new one.
 */
const retryCreateSchema = z.object({
  selector: z.record(z.unknown()),
  // No maximum: core owns the campaign schema and its `name` column's ceiling,
  // exactly as on `POST /campaigns`, which validates the field not at all. The
  // `min(1)` is the one thing an ABSENT name already handles better — core
  // defaults it to `<parent> — Retry <n>` — so an empty string can only be a
  // client bug, and it would produce a campaign with no name in the picker.
  name: z.string().min(1).optional(),
  config_overrides: z.record(z.unknown()).optional(),
  /*
   * Forwarded VERBATIM, and never invented — the exact opposite rule to
   * `agent_user_id` two fields up, for the opposite reason. The actor must come
   * from the session because the body cannot be trusted to say who is acting;
   * the key must come from the body because only the client holds the intent it
   * identifies. A key minted here would be a fresh value on the client's second
   * attempt and would protect nothing, which is the whole trap the field exists
   * to avoid (wire contract §2, obligation 3a).
   *
   * `z.string()` and nothing more. Core owns the shape — 16..64 characters of a
   * bounded alphabet, answered as a 400 with field-level `details` that survive
   * the error mask — and a second copy of those bounds here is a second thing to
   * keep in step, on a field whose failure mode is silent duplication.
   */
  idempotency_key: z.string().optional(),
}).strict();

/**
 * The actor name lookup timed out — distinct from every value that lookup can
 * legitimately resolve to.
 *
 * A symbol rather than `null` or `undefined`, because both are real answers from
 * `resolveAgentNames` ("this tenant has no name for that id"), and a timeout that
 * arrived spelled as one of them would be indistinguishable from a resolved miss
 * in the log — which is the only place the difference is visible, the response
 * being identical by design. See {@link TRANSITION_ACTOR_LOOKUP_TIMEOUT_MS}.
 */
const LOOKUP_TIMED_OUT = Symbol('agency-transition-actor-lookup-timeout');

export async function proxyAgencyCampaignsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', sessionMiddleware);
  app.addHook('preHandler', tenantContextMiddleware);
  // PORT NOTE (magick-agency): master's `requireCapability('agency')` is deleted — there is
  // no governance, and the section-level `agency` gate is always on because the app IS
  // agency (plan §3.2; lane A's `campaign-behavioral-settings.ts` header).
  //
  // PORT NOTE (magick-agency): every `proxyToCore({...})` below is `callCore({...})`
  // (`../core-dispatch.ts`, decision B16): core's handler body runs in-process on the
  // private core instance with the same method, path, query, body and tenant/account
  // headers, minus the tenant API key (`resolveCoreApiKey` is gone). `metricPath` is still
  // passed for call-site fidelity and ignored (its series belonged to the proxy).
  //
  // PORT NOTE (magick-agency): RBAC renames (`@magick-agency/contracts/rbac`, floors
  // unchanged): `proxy.contact_lists.read` → `agency.campaigns.read`,
  // `proxy.contact_lists.write` → `agency.campaigns.write`. The comments below keep master's
  // names where they explain a floor.
  /*
   * ─── A PARAM MUST NOT ADD PATH SEGMENTS ──────────────────────────────────
   *
   * Every route here interpolates `:id` / `:contactId` straight into a core path,
   * and find-my-way hands the handler a percent-DECODED param — so `%2F` arrives
   * as a real `/`.
   *
   * The classic `..` traversal is NOT what this closes. `proxyToCore` already
   * refuses any path that does not survive a WHATWG parse unchanged
   * (`src/proxy/safe-core-path.ts`), which covers `..`, `%2e%2e`, `.%2e`, `#` and
   * `\` — strictly more than a character check could. What it deliberately does
   * not refuse is a BARE EXTRA SLASH, because a path with no dot segments is an
   * ordinary core path and has to be allowed.
   *
   * On this plugin that is a live privilege escalation, because its routes do not
   * share one floor. `GET /campaigns/:id` is `proxy.contact_lists.read`
   * (**viewer**, 10) and interpolates `:id` as the LAST segment of its core path,
   * while the attempt read is `agency.supervise` (**account_admin**, 30) and its
   * media additionally needs the `agency.recording` capability. So:
   *
   *   GET /proxy/agency/campaigns/campaign-1%2Fattempts%2Fattempt-1
   *     → /agency-campaigns/campaign-1/attempts/attempt-1     (a viewer, reading
   *       a conversation the product floors at account_admin)
   *
   *   GET /proxy/agency/campaigns/campaign-1%2Fattempts%2Fa%2Frecording
   *     → the recording BYTES, with no `agency.recording` in the request at all
   *
   * That second one is the C2 finding this whole surface was built to close —
   * "the capability gated *enabling* recording, not *hearing* it" — reopened by a
   * slash. Same-tenant (core scopes by the tenant's key), so it is a governance
   * bypass rather than a data-isolation break, but capabilities and role floors
   * are what the customer is entitled and billed by.
   *
   * ── A plugin hook, and the character class rather than a uuid check ────────
   *
   * A hook because the defect is a hand-written route missing a guard the shared
   * `passthrough` helper applies, and a per-handler check can be missed again; the
   * next route registered here inherits this one.
   *
   * The character class because these ids are uuids only by convention — nothing
   * in this plugin says so and its own suites use short opaque ids (`c1`,
   * `campaign-1`). Reject rather than encode, for the reason in `path-params.ts`:
   * encoding changes the bytes on the wire for every id, while rejecting changes
   * behaviour only for requests that were already exploits.
   */
  app.addHook('preHandler', rejectPathEscapingParams());

  // ─── Campaign CRUD — thin proxy, core owns the schema ──────────────────────

  app.post('/campaigns', {
    preHandler: requirePermission('agency.campaigns.write'),
  }, async (request, reply) => {
    // Config validation only. The body is still forwarded verbatim and core still
    // owns the schema — master keeps no campaign copy (see the ingest-jobs
    // migration on why two writable copies drift). What this catches is the set of
    // shapes core stores happily and then behaves wrongly on; see
    // `agency-campaign-config.ts` for why it is a good error message rather than
    // enforcement.
    const configIssues = validateAgencyCampaignConfig(request.body);
    if (configIssues.length > 0) {
      return reply
        .code(400)
        .send({ error: 'Validation Error', details: issuesToDetails(configIssues) });
    }

    // Defaults are applied on CREATE only. `disposition_catalog` has a `'[]'`
    // column default that nothing ever seeded, so disposition was inert on every
    // campaign the platform has made. A default here fixes that without deleting
    // the empty-catalog configuration, because an explicit `[]` is an opinion and
    // is left alone — see `withCampaignConfigDefaults`.
    const body = withCampaignConfigDefaults(request.body);

    // MAG-138. After the shape check (a malformed body earns its 400 either way)
    // and before anything is forwarded — the whole point is that core never sees
    // a body that enables a capability this tenant does not have.
    //
    // PORT NOTE (magick-agency): asserted on `body`, the exact object forwarded to
    // core below, not on `request.body` (lane A's interface change 2). Master asserted
    // before computing the defaults; `withCampaignConfigDefaults` is pure and adds only
    // `disposition_catalog`, so moving the line below it changes no outcome and makes the
    // asserted object the forwarded one. The target is the request's tenant and account:
    // core stamps the new row with exactly those (`x-mgkvc-tenant` / `x-mgkvc-account`),
    // so the account judged is the account that will own the campaign.
    // PORT NOTE (magick-agency, Phase 8 review): with no account context lane A's settings read
    // has no row to judge (`campaign-behavioral-settings.ts` answers 403 `capability_disabled`).
    // Master's capability resolved at tenant level and forwarded, and core's `authMiddleware`
    // answered 400 for the missing `x-mgkvc-account` — that observed answer is kept.
    if (!request.accountId) return reply.code(400).send(missingAccountBody());
    if (!(await assertBehavioralCapabilitiesForConfig(request, reply, body, {
      tenantId: request.tenantId,
      accountId: request.accountId,
    }))) return;

    const result = await callCore({
      method: 'POST',
      path: '/agency-campaigns',
      body,
      tenantId: request.tenantId!,
      accountId: request.accountId,
    });
    return reply.code(result.status).send(result.body);
  });

  app.get('/campaigns', {
    preHandler: requirePermission('agency.campaigns.read'),
  }, async (request, reply) => {
    const result = await callCore({
      method: 'GET',
      path: '/agency-campaigns',
      query: request.query as Record<string, string>,
      tenantId: request.tenantId!,
      accountId: request.accountId,
    });
    return reply.code(result.status).send(result.body);
  });

  app.get<{ Params: { id: string } }>('/campaigns/:id', {
    preHandler: requirePermission('agency.campaigns.read'),
  }, async (request, reply) => {
    const result = await callCore({
      method: 'GET',
      path: `/agency-campaigns/${request.params.id}`,
      tenantId: request.tenantId!,
      accountId: request.accountId,
      metricPath: '/agency-campaigns/:id',
    });
    return reply.code(result.status).send(result.body);
  });

  app.patch<{ Params: { id: string } }>('/campaigns/:id', {
    preHandler: requirePermission('agency.campaigns.write'),
  }, async (request, reply) => {
    // Same validation on the patch surface, and it has to be: the builder edits a
    // running campaign's window and catalog here, so validating only on create
    // would leave every rule reachable one PATCH later.
    //
    // Cross-field rules see only what THIS body carries — a patch sending
    // `calling_window_start` alone cannot be checked against a stored `end` master
    // does not hold. That is the cost of not keeping a copy, and it is the right
    // trade: the alternative is a second writable campaign in master.
    //
    // ── Editing a RUNNING campaign — the documented rule (`AD-P3-M-04` (d)) ────
    // **Allowed, and master adds no campaign-status gate.** Pausing to change a
    // calling window is the opposite of what a compliance edit needs: the window is
    // most often wrong *while* the campaign is dialing outside it, and forcing a
    // pause there means either dialing on for the length of the round trip or
    // stopping a compliant campaign to fix a non-compliant one.
    //
    // Master could not enforce such a gate honestly in any case — it holds no
    // campaign copy, so it would have to GET the campaign first and act on a status
    // that can change between the two calls. Core is where a status rule belongs,
    // and core deliberately has none on PATCH (only `status` itself is unpatchable,
    // so lifecycle stays with /start, /pause, /resume, /stop and a config edit can
    // never race the pacing leader's own writes).
    //
    // **When the edit takes effect, stated precisely — the delivery plan's
    // "applies to future attempts only" is close but not exact, and the difference
    // is the kind rule 3 is about.** Core's pacing loop re-reads the campaign every
    // tick (`findActive()` / `findById()`, no cache), so:
    //  - a contact NOT yet dialed is planned against the new config from the next
    //    tick — the ordinary case, and the one the plan describes;
    //  - an attempt ALREADY dispatched carries the campaign snapshot taken when it
    //    was dialed (`cmd.campaign`), so its own retry decision uses the OLD policy;
    //  - EXCEPT down the reaper's path, which joins `c.retry_policy` live
    //    (`agency.repository.ts:835`) and therefore resolves against the NEW policy
    //    for an attempt dialed before the edit.
    // So "future attempts only" holds for the dial path and not for the reaper.
    // Nothing in flight is retro-actively re-planned either way, which is the
    // property that makes editing a live campaign safe to offer.
    const configIssues = validateAgencyCampaignConfig(request.body);
    if (configIssues.length > 0) {
      return reply
        .code(400)
        .send({ error: 'Validation Error', details: issuesToDetails(configIssues) });
    }

    // MAG-138, and it has to be here as well as on create for the same reason the
    // config validation is: a rule enforced only on POST is a rule one PATCH away
    // from being bypassed. A campaign created with recording off can otherwise be
    // patched to `record_calls: true` by a tenant that never had the capability.
    //
    // PORT NOTE (magick-agency): the forwarded body is bound ONCE and that same object is
    // both asserted and forwarded (lane A's interface change 2). The target is the request's
    // tenant and account, and it cannot differ from the campaign's owner: core's PATCH
    // handler runs `requireOwned`, which answers 404 unless the campaign's `tenant_id` AND
    // `account_id` equal the `x-mgkvc-tenant` / `x-mgkvc-account` headers `callCore` sets from
    // these same two values. So a body asserted against account Y's settings can only ever
    // write a campaign that account Y owns; reading the row first to learn its account
    // would be a second read that can only agree.
    //
    // PORT NOTE (magick-agency, Phase 8 review): `request.body` is master's own line (master
    // `:995`), kept. The brief's "pass the schema-PARSED config, never `request.body`" is met
    // because it is ONE reference: the object `validateAgencyCampaignConfig` checked above is
    // the object asserted here and the object forwarded below (core parses it again). A body
    // that enables a capability this account lacks is refused and nothing reaches core
    // (`proxy-agency-campaign-behavioral-capabilities.routes.test.ts`, the PATCH twin cases).
    const patchBody: unknown = request.body;
    // PORT NOTE (magick-agency, Phase 8 review): with no account context lane A's settings read
    // has no row to judge (`campaign-behavioral-settings.ts` answers 403 `capability_disabled`).
    // Master's capability resolved at tenant level and forwarded, and core's `authMiddleware`
    // answered 400 for the missing `x-mgkvc-account` — that observed answer is kept.
    if (!request.accountId) return reply.code(400).send(missingAccountBody());
    if (!(await assertBehavioralCapabilitiesForConfig(request, reply, patchBody, {
      tenantId: request.tenantId,
      accountId: request.accountId,
    }))) return;

    const result = await callCore({
      // PATCH, per design §8 and confirmed with core. The proxy client's method
      // union and its body-serialisation gate were both widened for this — the
      // gate is the one that matters, because a method missing from it sends
      // the request with NO body and core answers 200 to a write that did
      // nothing.
      method: 'PATCH',
      path: `/agency-campaigns/${request.params.id}`,
      body: patchBody,
      tenantId: request.tenantId!,
      accountId: request.accountId,
      metricPath: '/agency-campaigns/:id',
    });
    return reply.code(result.status).send(result.body);
  });

  /**
   * The one route on this plugin that is NOT a verbatim passthrough, and the
   * only place it could be (MAG-148 + MAG-141).
   *
   * Core's stats payload declares two members core states it cannot produce —
   * `agents[].agent_name` (identity; core has no user table, D3) and the
   * `credits_low` stall arm (`AGENCY_CORE_STALL_CODES` filters it out in
   * executable form). Both were dead on the wire because nothing filled them.
   * This hop is the only service that holds either fact.
   *
   * `enrichAgencyCampaignStats` is a spread over core's body, never a
   * reconstruction, so everything else — including fields core adds later —
   * arrives byte-identical. It also never throws: a failed lookup degrades the
   * enrichment, because cusui polls this every 5 seconds.
   */
  app.get<{ Params: { id: string } }>('/campaigns/:id/stats', {
    preHandler: requirePermission('agency.campaigns.read'),
  }, async (request, reply) => {
    const result = await callCore({
      method: 'GET',
      path: `/agency-campaigns/${request.params.id}/stats`,
      tenantId: request.tenantId!,
      accountId: request.accountId,
      metricPath: '/agency-campaigns/:id/stats',
    });
    const body = await enrichAgencyCampaignStats(result.body, {
      tenantId: request.tenantId!,
      status: result.status,
      // PORT NOTE (magick-agency): `creditsLowConnectsThreshold` is deleted with the
      // `credits_low` overlay (plan §2, billing removed; lane B2 "Stats enrichment").
      // `agents[].agent_name` is the only enrichment left. `agents_peak` (declared on
      // master's wire) has no producer here or in core and stays unserved, as in master.
    });
    return reply.code(result.status).send(body);
  });

  /**
   * GET /proxy/agency/campaigns/:id/stats/series — the campaign's own trend
   * (`86d45k0bk`).
   *
   * A verbatim passthrough of core's bucketed series:
   * `{ campaign_id, bucket, timezone, buckets: [{ bucket_start, attempts,
   * connected, successes, talk_seconds, wrapup_seconds }] }`. See
   * {@link AgencyCampaignStatsSeries} for what each member means and, more
   * importantly, for the two things this hop must NOT do to it — normalise
   * `bucket_start` (a `YYYY-MM-DD` calendar day, not an instant) and add rates.
   *
   * ── The floor is `agency.supervise`, and the sibling above is not ──────────
   * `GET /campaigns/:id/stats` next door floors at `proxy.contact_lists.read`
   * (`viewer`, 10) — deliberately, and MAG-136 pinned that boundary against
   * exactly the "tidy up and make them match" change this route looks like an
   * argument for. So the difference has to be stated rather than inferred:
   *
   *  - the live strip is a DASHBOARD. It answers "is this campaign dialling right
   *    now", which is the question an `operator` running the floor has to be able
   *    to ask, and a `viewer` may watch;
   *  - the series is a supervisory REVIEW surface. It is a per-day record of a
   *    campaign's throughput over up to a quarter, and it lives on the same tab
   *    as the roster and the attempt spine — every one of which floors at
   *    `agency.supervise` (`account_admin`, 30). Reading it beside them at a
   *    lower floor would make the tab's own gate a function of which panel had
   *    loaded.
   *
   * `agency.supervise` already exists and already carries this meaning, so there
   * is no new permission and no governance catalog entry: a second gate to keep
   * aligned is a second gate to drift (MAG-157's reasoning, declining a
   * permission for the activity trail). The floor is asserted twice — from the
   * source in `proxy-agency-campaigns.routes.test.ts`, and **by execution** in
   * `proxy-agency-campaign-series.routes.test.ts`, because a source-text table
   * cannot see a `requirePermission` that was deleted along with its own row.
   *
   * ── The `:id` here is not the escape hatch it looks like ──────────────────
   * This route interpolates `:id` in the MIDDLE of core's path, so it cannot be
   * lengthened into another core collection. The direction that matters is the
   * other one: `GET /campaigns/:id` is floored at `viewer` and interpolates its
   * `:id` LAST, so `:id = c%2Fstats%2Fseries` would reach this read two role
   * levels below its own floor. That is closed by the plugin-level
   * `rejectPathEscapingParams()` hook above, not by anything on this route —
   * which is precisely the escalation `helpers/path-params.ts` documents, now
   * with one more route on the high side of it.
   *
   * ── Master validates the window; core remains the authority ───────────────
   * See {@link CAMPAIGN_SERIES_MAX_WINDOW_DAYS} and {@link parseSeriesInstant}
   * for why master carries a copy of core's rules and why it must never be the
   * stricter of the two, and {@link resolveSeriesQuery} for the two ways it was
   * stricter until that function existed.
   *
   * ── A 404 here has TWO causes, and master deliberately merges them ─────────
   * Written down because the client cannot tell them apart and does not need to:
   *
   *  - **core's own refusal.** `{ code: 'campaign_not_found' }` — the campaign is
   *    in another tenant or does not exist. That code is in
   *    `FORWARDABLE_ERROR_CODES` and `isStructuredClientError` forwards on an
   *    allow-listed `code` independently of `details`, so the body arrives intact.
   *  - **core does not serve this route yet.** Master deployed ahead of core, or
   *    core rolled back: core's Fastify answers its own `{ error: 'Not Found' }`
   *    with no `code` and no `details`. `'Not Found'` is not in
   *    `FORWARDABLE_ERROR_LABELS` (which holds only `'Feature Not Enabled'`), so
   *    `errorMaskHook` replaces the body with the generic support-ticket one.
   *    **The 404 STATUS survives** — the hook rewrites payloads and never
   *    `reply.statusCode`.
   *
   * So the client contract on this route is the STATUS, not a code: any 404 means
   * "there is no series to draw", and the console hides the panel rather than
   * rendering an error. Both alternatives were considered and are worse. Adding
   * `'Not Found'` to the forwardable LABELS unmasks 404s on every one of master's
   * ~95 proxied routes to spare one chart a panel. Authoring a master-side code
   * for the bare 404 invents cross-service vocabulary for a window that policy
   * says should not exist — deploy order is core → master → cusui, so core
   * carries this route before master is asked for it, and the chart that reads it
   * ships after master — and it leaves this route matching on core's 404 body
   * shape forever, for a caller that never existed.
   */
  app.get<{ Params: { id: string } }>('/campaigns/:id/stats/series', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    // Refused before the core call, so the 400 is ours and not masked as a proxy
    // error, and so an unknown param is a signal rather than a silent drop.
    // Used for THAT gate only — the values it resolves are discarded below.
    const forwarded = forwardAllowedQuery(request.query, CAMPAIGN_SERIES_QUERY_PARAMS);
    if (!forwarded.ok) return reply.code(400).send(unknownQueryParamsError(forwarded.unknown));

    // Read core's way, not `forwardAllowedQuery`'s: it joins a repeated param with
    // a comma (right for the spine's multi-value filters, wrong for these three)
    // and forwards a padded value untrimmed, and either one made master refuse a
    // request core answers. `resolveSeriesQuery` is the mirror of core's
    // `singleParam` — first of a repeat, trimmed, blank means absent — and its
    // docstring carries the two cases and why master may not be stricter.
    const query = resolveSeriesQuery(request.query);

    // Validated against the RESOLVED query rather than `request.query`, so the
    // string the schema measures is the string core will re-read.
    const parsed = campaignSeriesQuerySchema.safeParse(query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', details: parsed.error.flatten() });
    }

    const result = await callCore({
      method: 'GET',
      path: `/agency-campaigns/${request.params.id}/stats/series`,
      // The resolved params, NOT `parsed.data`: master validated them and has no
      // opinion about them. In particular `bucket` is forwarded absent when the
      // caller omitted it, so `day` stays CORE's default and is echoed on the
      // response — injecting it here would be a second declaration of the
      // default, and the one that drifts is the one no query exercises.
      query,
      tenantId: request.tenantId!,
      accountId: request.accountId,
      metricPath: '/agency-campaigns/:id/stats/series',
    });
    // Verbatim, and deliberately NOT through `enrichAgencyCampaignStats`: master
    // owns nothing on this payload. There is no agent row to name and no stall to
    // diagnose — a series is a record of what happened, not a live diagnosis — so
    // the enrichment would be a database read per poll that adds no field. A core
    // error reaches the error mask exactly as core wrote it.
    return reply.code(result.status).send(result.body);
  });

  // ── Activity: the merged audit trail ──────────────────────────────────────

  /**
   * Resolve the campaign and prove the caller owns it, BEFORE either audit read.
   *
   * This is the whole of the authorisation for the routes below.
   * `requirePermission` proves the caller's ROLE and never looks at the target
   * row (the rule stated at the top of `rbac/`), so without this a supervisor
   * could pass another tenant's campaign id and enumerate its audit rows — the
   * exact shape of the cross-tenant defects two reviews already found.
   *
   * The check is a proxy read of the campaign, because master keeps no campaign
   * table (see the ownership-split comment at the top of this file). Core's
   * `requireOwned` answers 404 for a campaign in another tenant or account, and
   * that status is forwarded verbatim — a cross-tenant id and a nonexistent one
   * must stay indistinguishable, or the response is a campaign-id oracle.
   *
   * It also returns the account CORE stamped on the campaign, which is what
   * core's audit rows carry.
   *
   * PORT NOTE (magick-agency): the probe is still core's `GET /agency-campaigns/:id`,
   * now run in-process through `callCore`, rather than `agencyCampaignRepository.findById`
   * plus a copy of `requireOwned`'s rule here. Reasons: (1) it IS core's rule — the
   * handler runs core's `gate` (the `agency_dialer_enabled` flag, so a flag-off account
   * is refused here exactly as master's probe was) and core's `requireOwned` (tenant AND
   * account), and answers core's own 404 body; a second copy of that rule in this file is
   * a second thing to keep in step; (2) master's code shape is kept, so the suites'
   * `callCore` assertions stay master's. The account it returns is the formatted row's
   * `account_id` (`formatAgencyCampaignResponse` spreads the row), i.e. the campaign row's
   * account, read in-process AFTER the ownership proof — the value lane B2's
   * `ActivityQuery.accountId` requires (B2 Phase 8 carry-forward).
   *
   * Deleted with the hop, each with its reason:
   *  - the try/catch and its `{ verified: false }` "core unreachable" outcome, plus the
   *    `unverifiedAccountScope` read it fed: `callCore` throws only when the handler table
   *    was never built (a wiring defect), so there is no outage to degrade around, and B2
   *    deleted the unverified scoping from `fetchActivityPage`. A throw now propagates (a
   *    500), the posture master already took for its own database;
   *  - `timeoutMs: ACTIVITY_OWNERSHIP_PROBE_TIMEOUT_MS` and master's paragraph on "its own
   *    timeout": it bounded the undici socket (300s header timeout). `callCore` installs no
   *    signal, and the in-process read has nothing to fall back to on expiry — the
   *    unverified path that a timeout used to land on is gone;
   *  - the `?? request.accountId ?? 'default'` fallbacks: core's `'default'` was its
   *    `VARCHAR(100)` column's literal; agency's `account_id` is a NOT NULL `uuid`, and a
   *    probe that reached 200 passed `requireOwned`, which matched that column. A body
   *    without it is a defect, refused rather than guessed (a guess would be a `22P02` or
   *    the wrong account's trail).
   */
  const requireOwnedCampaign = async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ): Promise<OwnedCampaign | null> => {
    const result = await callCore({
      method: 'GET',
      path: `/agency-campaigns/${request.params.id}`,
      tenantId: request.tenantId!,
      accountId: request.accountId,
      metricPath: '/agency-campaigns/:id',
    });
    if (result.status >= 400) {
      // A REFUSAL is core's answer and is forwarded verbatim — a cross-tenant id
      // and a nonexistent one must stay indistinguishable.
      await reply.code(result.status).send(result.body);
      return null;
    }
    const accountId = extractCampaignField(result.body, 'account_id');
    if (!accountId) {
      throw new Error('agency campaign ownership probe: core answered without the campaign\'s account_id');
    }
    return {
      accountId,
      name: extractCampaignField(result.body, 'name'),
    };
  };

  /**
   * GET /proxy/agency/campaigns/:id/activity — one merged, time-ordered trail.
   *
   * `audit.read`, settled on MAG-157 (option 2): the floor dropped to
   * `account_admin`, the same floor as `agency.supervise`, so the supervisor who
   * controls a campaign can read its trail. No new permission and no governance
   * catalog key — a second gate to keep aligned is a second gate to drift.
   *
   * ── Both stores write some of the same action names, and that is right ─────
   * `agency_campaign.paused` appears from master (a supervisor pressed Pause)
   * and from core (the campaign actually transitioned). Neither is redundant and
   * `source` is what tells them apart. The rows only core has — the auto-pause
   * with its measured rate — are what a compliance reviewer came for.
   */
  app.get<{ Params: { id: string } }>('/campaigns/:id/activity', {
    preHandler: requirePermission('audit.read'),
  }, async (request, reply) => {
    const parsed = activityQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', details: parsed.error.flatten() });
    }
    const query = parsed.data;

    let cursor: ActivityCursor = { master: null, core: null };
    if (query.cursor) {
      const decoded = decodeActivityCursor(query.cursor);
      if (!decoded) {
        // Refused rather than reset to page one. A cursor that quietly restarts
        // the trail from the top reads as duplicate rows to a reviewer scrolling
        // through it, and there is no way to tell that from real duplicates.
        return reply.code(400).send({
          error: 'Validation Error',
          message: 'Malformed cursor',
        });
      }
      cursor = decoded;
    }

    const owned = await requireOwnedCampaign(request, reply);
    if (!owned) return reply;

    const page = await fetchActivityPage({
      tenantId: request.tenantId!,
      campaignId: request.params.id,
      // PORT NOTE (magick-agency): the campaign row's own account, proven above (B2
      // carry-forward). Master's `owned.verified ? coreAccountId : unverifiedAccountScope`
      // branch is gone with the unverified outcome (see `requireOwnedCampaign`).
      accountId: owned.accountId,
      ...(query.action ? { actions: query.action } : {}),
      ...(query.from ? { from: new Date(query.from) } : {}),
      ...(query.to ? { to: new Date(query.to) } : {}),
      limit: query.limit ?? ACTIVITY_DEFAULT_LIMIT,
      cursor,
    });

    return reply.send({
      rows: page.rows,
      next_cursor: page.nextCursor ? encodeActivityCursor(page.nextCursor) : null,
      total: page.total,
      // Always present, both of them. A `partial` key that only appeared when
      // something was wrong is indistinguishable from a client that forgot to
      // read it, which is how a silently short list ships looking complete.
      partial: page.partial,
      partial_reason: page.partial_reason,
      retention: page.retention,
      // The vocabulary the `?action=` filter can be built from, served with the
      // data it filters. Master is the only process that knows both stores'
      // action names, so a client keeping its own copy is keeping a copy of
      // something it cannot check — see `agency-activity-actions.ts`.
      //
      // On every response, including a degraded one: the list is static and
      // does not depend on core, and a filter that disappeared whenever core
      // did would take away the control a supervisor needs precisely then.
      available_actions: CAMPAIGN_ACTIVITY_ACTIONS,
    });
  });

  /**
   * GET /proxy/agency/campaigns/:id/activity.csv — the same trail as a file.
   *
   * CSV because that is the format a compliance request actually arrives asking
   * for, and the merge is already assembled here.
   *
   * ── This one REFUSES when core is degraded, where the JSON route degrades ──
   * The screen can carry a banner saying the trail is incomplete; a file that
   * leaves the building cannot. An export that silently omitted core's half —
   * every status transition and every auto-pause — would be indistinguishable
   * from a complete one to whoever opens it next, possibly months later and in
   * another organisation. So the refusal is the honest answer, and it names the
   * reason so the operator knows to retry rather than to conclude there is
   * nothing to export.
   *
   * The refusal is **424, not 503**, and the status is load-bearing rather than
   * pedantic: `errorMaskHook` masks every 5xx unconditionally, so a 503 would
   * reach the operator as "contact support and quote this request id" — status
   * intact, remedy destroyed. A 424 is master's own 4xx (no core call records
   * that status; the audit read passes `recordCoreErrors: false` precisely so it
   * cannot), so the sentence that explains what to do survives.
   *
   * ── Two ways to stop early, and both must say so ──────────────────────────
   * The row ceiling is a runaway guard, not a routine limit (a campaign's
   * control trail is tens to low hundreds of rows); the wall-clock budget bounds
   * the case the ceiling cannot, a core that answers slowly rather than failing,
   * where the loop stays legal and simply never ends. Either way the file that
   * results is short, and a short compliance export handed over as a complete
   * one is the failure this whole surface exists to prevent — so both set
   * `X-Activity-Truncated`, which is the header an already-shipped client
   * checks, and `X-Activity-Truncated-Reason` names which one it was.
   *
   * The reason is a separate header rather than a different value of the first,
   * precisely so a client that only knows `X-Activity-Truncated: true` still
   * refuses to treat the file as whole. `X-Activity-Row-Limit` stays on the
   * row-ceiling path alone: on a deadline the ceiling is not what stopped the
   * export, and reporting it would tell the operator the file holds 5000 rows
   * when it may hold 300. The two need different remedies too — "narrow the date
   * range" fixes a ceiling hit and does nothing for a slow dependency.
   *
   * PORT NOTE (magick-agency): the 424 `partial_trail_unavailable` refusal and the
   * mid-page `core_deadline` truncation are deleted. Both read a degraded page
   * (`page.partial` / `partial_reason`) that `fetchActivityPage` can no longer
   * return: lane B2 collapsed the core half into a direct `audit_logs` read, so a page
   * is whole or the read throws (always `partial: false`, `partial_reason: null`).
   * The per-page `coreTimeoutMs` (and `ACTIVITY_EXPORT_MIN_PAGE_TIMEOUT_MS`) bounded
   * the S2S socket and is gone with it. KEPT: the row ceiling and the wall-clock
   * budget checked between pages — a slow database still makes a long drain, and the
   * `time_limit` truncation headers still describe that honestly.
   */
  app.get<{ Params: { id: string } }>('/campaigns/:id/activity.csv', {
    preHandler: requirePermission('audit.read'),
  }, async (request, reply) => {
    const parsed = activityExportQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', details: parsed.error.flatten() });
    }
    const query = parsed.data;

    const owned = await requireOwnedCampaign(request, reply);
    if (!owned) return reply;

    const filters = {
      tenantId: request.tenantId!,
      campaignId: request.params.id,
      // The campaign row's own account (see `requireOwnedCampaign`).
      accountId: owned.accountId,
      ...(query.action ? { actions: query.action } : {}),
      ...(query.from ? { from: new Date(query.from) } : {}),
      ...(query.to ? { to: new Date(query.to) } : {}),
      // Not the interactive page size: this loop is draining a trail, not
      // rendering one, and each page is a master SELECT plus an S2S round trip
      // plus an identity lookup, in series. At 99 a full 5000-row export was ~51
      // of those; at 500 it is ~10.
      limit: ACTIVITY_EXPORT_PAGE_SIZE,
      // Nothing here reads `total`, and asking for it costs a `COUNT(*)` over a
      // partitioned table on BOTH sides of the merge, once per page.
      skipTotal: true,
    };

    let cursor: ActivityCursor | null = { master: null, core: null };
    const lines: string[] = [activityCsvHeader()];
    let rowCount = 0;
    let truncatedBy: ActivityExportTruncation | null = null;
    // Whichever page's retention this export last saw. Retention does not
    // move mid-export, so the last successful page's value is as good as the
    // first's.
    let retention: ActivityCsvPreambleRetention | null = null;
    const deadline = Date.now() + ACTIVITY_EXPORT_TIME_BUDGET_MS;

    while (cursor) {
      // PORT NOTE (magick-agency): master handed the remaining budget DOWN to the page
      // (`coreTimeoutMs`, floored for the first page) because one slow S2S response
      // could otherwise run to undici's 300s header timeout; and it then branched on the
      // page's `core_deadline` (truncate) and `partial` (424). All three were about the
      // HTTP hop and are deleted (see the route's docstring). The between-pages deadline
      // check at the bottom of the loop is kept.
      const page = await fetchActivityPage({ ...filters, cursor });

      retention = page.retention;
      for (const row of page.rows) {
        if (rowCount >= ACTIVITY_EXPORT_MAX_ROWS) {
          truncatedBy = 'row_limit';
          break;
        }
        lines.push(activityCsvRow(row));
        rowCount += 1;
      }
      if (truncatedBy) break;
      cursor = page.nextCursor;
      // Checked after the page is written, never before the first fetch: a
      // budget that could expire on entry would answer a truncated empty file to
      // a request that had done no work at all.
      if (cursor && Date.now() >= deadline) {
        log.warn(
          { campaignId: request.params.id, rows: rowCount, budgetMs: ACTIVITY_EXPORT_TIME_BUDGET_MS },
          'agency activity: export exceeded its time budget; serving what was assembled, marked truncated',
        );
        truncatedBy = 'time_limit';
        break;
      }
    }

    // The preamble is built LAST and unshifted onto the front, deliberately.
    // Truncation and the final row count are only known once the loop above
    // has finished, but the preamble has to be the first thing in the file —
    // building it up front would mean asserting completeness before the loop
    // had run, which is exactly the lie this route exists to refuse to tell.
    if (query.preamble) {
      lines.unshift(...buildActivityCsvPreamble({
        generatedAt: new Date(),
        campaignId: request.params.id,
        campaignName: owned.name,
        tenantId: request.tenantId!,
        // PORT NOTE (magick-agency): master's `owned.coreAccountId ?? 'unverified'`
        // fallback is gone with the unverified probe outcome; the account is the
        // campaign row's, always present.
        accountId: owned.accountId,
        actions: query.action ?? null,
        from: query.from ?? null,
        to: query.to ?? null,
        rowCount,
        truncated: truncatedBy,
        rowLimit: ACTIVITY_EXPORT_MAX_ROWS,
        retention,
      }));
    }

    const safeName = (owned.name ?? 'campaign').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60);
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="activity-${safeName}.csv"`);
    reply.header('X-Activity-Rows', String(rowCount));
    if (truncatedBy) {
      reply.header('X-Activity-Truncated', 'true');
      reply.header('X-Activity-Truncated-Reason', truncatedBy);
      // Only where the ceiling is what stopped it. On a deadline this number
      // would describe a file that does not exist.
      if (truncatedBy === 'row_limit') {
        reply.header('X-Activity-Row-Limit', String(ACTIVITY_EXPORT_MAX_ROWS));
      }
    }
    return reply.send(lines.join(''));
  });


  // ── The attempt spine: what the campaign did, and to whom (MAG-159) ────────
  //
  // Thin proxies. Unlike `/activity` above there is no second store to merge and
  // no aggregation — core owns `agency_call_attempts` and `agency_contacts`
  // outright, and its own `requireOwned` answers 404 for a campaign in another
  // tenant or account, which is forwarded verbatim so a cross-tenant id and a
  // nonexistent one stay indistinguishable.
  //
  // ── Gated on `agency.supervise`, not on `audit.read` ───────────────────────
  // The two are the same ROLE floor (`account_admin`), so this is not about who
  // gets in — it is about which question the permission names. `audit.read`
  // covers the control plane: who started, paused and stopped the campaign.
  // This is the operational record: what was dialled, to whom, with what result.
  // A tenant that later narrows one of the two must be able to narrow it without
  // silently taking the other away.
  //
  // ── The three privacy decisions, made here rather than left to the render ──
  //
  // 1. `context` — the contact's verbatim CSV columns — is NOT reachable through
  //    either list or either export. Core serves it only on the single-contact
  //    drill-down, so the exclusion is structural rather than a column somebody
  //    remembered to leave out. Columns an operator marked `Ignore` at ingest
  //    never reach the stored JSONB at all (`agency-csv-ingest.ts` drops them
  //    before the row is written), so the UX spec's §E.3 warning — "a field in
  //    `context` is a field on an agent's screen the moment anyone changes the
  //    render rules" — is enforced where it should be. `context_display.hidden`
  //    remains a render rule and the console honours it on the drill-down.
  //
  // 2. **Phone numbers are served in full, and the export needs no extra gate.**
  //    §C.4's masking is not implemented anywhere yet; inventing a second
  //    masking rule for this one surface — one the agent floor would not share —
  //    is how two rules drift. The `agency.supervise` floor is `account_admin`,
  //    which is also the floor for the DNC list and the roster upload, so the
  //    number is not new information to this reader. What IS new is bulk, and
  //    that is answered with **attribution rather than a second permission**:
  //    every export writes an audit row naming the actor, the filters and the
  //    row count. A second gate to keep aligned with the first is a second gate
  //    to drift — the same reasoning MAG-157 used when it declined to mint a
  //    permission for the activity trail.
  //
  // 3. `notes` — agent-typed free text — ARE included, on the list and in the
  //    export. They are deliberately excluded from the AUDIT trail (an audit row
  //    records the catalog code, not customer content, see the disposition route
  //    in `proxy-agency-agent.routes.ts`). This is not the audit trail: notes are
  //    operational content on the contact record, and they are frequently the
  //    answer to "why was this number called four times".

  app.get<{ Params: { id: string } }>('/campaigns/:id/attempts', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    // Refused before the core call, so the 400 is not masked as a proxy error.
    const forwarded = forwardAllowedQuery(request.query, [...ATTEMPT_QUERY_PARAMS, ...PAGING_QUERY_PARAMS]);
    if (!forwarded.ok) return reply.code(400).send(unknownQueryParamsError(forwarded.unknown));

    const result = await callCore({
      method: 'GET',
      path: `/agency-campaigns/${request.params.id}/attempts`,
      query: forwarded.query,
      tenantId: request.tenantId!,
      accountId: request.accountId,
      metricPath: '/agency-campaigns/:id/attempts',
    });
    // Core can only serve the agent's USER id — it has no user table (D3).
    // Master is the only service that can turn that into a name, and a column
    // of UUIDs is not a column a supervisor can read or filter by.
    // Non-2xx bodies pass through untouched so an error reaches the error mask
    // exactly as core wrote it.
    const body = result.status >= 200 && result.status < 300
      ? await enrichAttemptAgentNames(result.body, request.tenantId!, resolveAgentNames, (err) => {
        log.warn(
          { tenantId: request.tenantId, err: err instanceof Error ? err.message : String(err) },
          'agency spine: agent name resolution failed; emitting agent_name: null',
        );
      })
      : result.body;
    return reply.code(result.status).send(body);
  });

  /**
   * The roster.
   *
   * Note the path already exists on core as an S2S **POST** (roster ingest, on a
   * different plugin behind `INTERNAL_S2S_TOKEN`). They do not collide, and the
   * shared shape is deliberate: this is the read of what that write produced —
   * which is the point of the whole ticket, since `/agency/campaigns/:id/contacts`
   * in the console has until now been an upload form despite its name.
   */
  app.get<{ Params: { id: string } }>('/campaigns/:id/contacts', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    const forwarded = forwardAllowedQuery(request.query, [...CONTACT_QUERY_PARAMS, ...PAGING_QUERY_PARAMS]);
    if (!forwarded.ok) return reply.code(400).send(unknownQueryParamsError(forwarded.unknown));

    const result = await callCore({
      method: 'GET',
      path: `/agency-campaigns/${request.params.id}/contacts`,
      query: forwarded.query,
      tenantId: request.tenantId!,
      accountId: request.accountId,
      metricPath: '/agency-campaigns/:id/contacts',
    });
    return reply.code(result.status).send(result.body);
  });

  /**
   * One contact, with its uploaded CSV columns — the drill-down's row, and the
   * only route on this surface that carries `context`.
   *
   * Deliberately **one contact at a time**: that is what keeps the columns off
   * the list and out of the export by construction rather than by a filter
   * someone has to remember to apply. A console rendering `context` must apply
   * the campaign's `context_display.hidden` exactly as the agent screen does.
   */
  app.get<{ Params: { id: string; contactId: string } }>('/campaigns/:id/contacts/:contactId', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    const result = await callCore({
      method: 'GET',
      path: `/agency-campaigns/${request.params.id}/contacts/${request.params.contactId}`,
      tenantId: request.tenantId!,
      accountId: request.accountId,
      metricPath: '/agency-campaigns/:id/contacts/:id',
    });
    return reply.code(result.status).send(result.body);
  });

  /**
   * `?preamble=false` — case-insensitively, because the preamble's own
   * instruction text is the only place a caller reads the spelling from and an
   * uppercase `FALSE` silently kept the block.
   */
  function wantsPreamble(query: unknown): boolean {
    const raw = (query as { preamble?: unknown } | undefined)?.preamble;
    return String(raw ?? '').toLowerCase() !== 'false';
  }

  /**
   * Cap what a caller can write into the audit row through a filter value.
   *
   * Not a validation step — the filter itself was already forwarded to core,
   * which accepted or refused it on its own terms. This bounds the AUDIT
   * record, which is append-only, retained, and read by people investigating
   * something else.
   */
  function boundedFilters(filters: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(filters)) {
      out[key] = value.length > AUDIT_FILTER_VALUE_MAX_CHARS
        // Marked, not silently cut: a truncated value that looks whole would
        // misreport what the export actually covered.
        ? `${value.slice(0, AUDIT_FILTER_VALUE_MAX_CHARS)}…[truncated]`
        : value;
    }
    return out;
  }

  // ── The exports ───────────────────────────────────────────────────────────

  /**
   * Drain one of core's keyset-paginated lists into a CSV.
   *
   * Shared by both exports because everything that is hard here — the deadline
   * handed *down* to each page rather than merely consulted between them, the
   * row ceiling, discarding rather than appending an aborted page — is identical
   * for the two, and a second copy is a second place for the budget arithmetic
   * to be subtly wrong.
   *
   * Unlike the activity export this **never 424s**. That route refuses because a
   * file missing core's half of a merged trail is indistinguishable from a
   * complete one to whoever opens it next. There is no merge here: core is the
   * only source, so a core that fails produces no file at all — an error, which
   * is already unambiguous — rather than a quietly half-populated one.
   */
  async function drainSpineExport<TRow>(params: {
    request: FastifyRequest<{ Params: { id: string } }>;
    path: string;
    metricPath: string;
    filters: Record<string, string>;
    header: string;
    renderRow: (row: TRow) => string;
    /**
     * Applied per page, before rendering. The attempts export uses it to put
     * agent names on the rows — the export has to carry what the screen does,
     * and the enrichment is a per-page lookup rather than a per-row one.
     */
    enrich?: (body: unknown) => Promise<unknown>;
  }): Promise<{ lines: string[]; rowCount: number; truncated: SpineExportTruncation | null }> {
    const lines: string[] = [params.header];
    let rowCount = 0;
    let truncated: SpineExportTruncation | null = null;
    let cursor: string | null = null;
    const deadline = Date.now() + SPINE_EXPORT_TIME_BUDGET_MS;

    for (;;) {
      // PORT NOTE (magick-agency): master handed the remaining budget DOWN to each page
      // (`timeoutMs`, floored at `SPINE_EXPORT_MIN_PAGE_TIMEOUT_MS`) and caught the
      // resulting `AbortError` as a mid-page `truncated: 'deadline'`. Both bounded the
      // undici socket of one `proxyToCore` request; `callCore` has no socket and installs
      // no signal, so the hand-down, the floor, the `isAbortError` branch and the
      // try/catch around the call are deleted (a throw from `callCore` is a wiring defect
      // and propagates, as master's non-abort errors did). KEPT: the between-pages
      // deadline check below — a slow database still makes a long drain — and the row
      // ceiling.
      const query: Record<string, string> = {
        ...params.filters,
        limit: String(SPINE_EXPORT_PAGE_SIZE),
        ...(cursor ? { cursor } : {}),
      };
      const result = await callCore({
        method: 'GET',
        path: params.path,
        query,
        tenantId: params.request.tenantId!,
        accountId: params.request.accountId,
        metricPath: params.metricPath,
      });
      if (result.status >= 400) {
        // Core's refusal is the answer — a 404 for a campaign the caller does
        // not own, a 400 for a filter it rejected. Thrown rather than returned
        // so the caller forwards the status verbatim; a half-written file must
        // never be sent under a 200.
        throw new SpineExportRefused(result.status, result.body);
      }

      const enriched = params.enrich ? await params.enrich(result.body) : result.body;
      const page = asSpinePage<TRow>(enriched);
      if (!page) {
        throw new SpineExportRefused(502, {
          error: 'Bad Gateway',
          code: 'spine_export_unreadable',
          message: 'The voice service returned a page this export could not read. Nothing was exported.',
        });
      }

      for (const row of page.rows) {
        if (rowCount >= SPINE_EXPORT_MAX_ROWS) {
          truncated = 'row_limit';
          break;
        }
        lines.push(params.renderRow(row));
        rowCount += 1;
      }
      if (truncated) break;

      cursor = page.next_cursor;
      if (!cursor) break;
      // Checked after the page is written, never before the first fetch: a
      // budget that could expire on entry would answer a truncated empty file
      // to a request that had done no work at all.
      if (Date.now() >= deadline) {
        log.warn(
          {
            campaignId: params.request.params.id,
            rows: rowCount,
            budgetMs: SPINE_EXPORT_TIME_BUDGET_MS,
          },
          'agency spine: export exceeded its time budget; serving what was assembled, marked truncated',
        );
        truncated = 'deadline';
        break;
      }
    }

    return { lines, rowCount, truncated };
  }

  /**
   * Finish an export: preamble, headers, audit row, body.
   *
   * ── The audit row is what stands in for a second permission ────────────────
   * A bulk export of every number on a campaign is a materially larger exposure
   * than one number in one drawer, and the decision recorded in the MAG-159 PR
   * is that it is answered with attribution rather than with a gate nobody would
   * know to grant. Written only on the success path, after the row count is
   * known, so it records what actually left the building — including that it was
   * truncated, since "50,000 rows of 1,000,000" is a different disclosure from
   * "the whole campaign" and a reviewer must be able to tell them apart.
   */
  function sendSpineCsv(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
    input: {
      kind: 'attempts' | 'contacts';
      lines: string[];
      rowCount: number;
      truncated: SpineExportTruncation | null;
      preamble: boolean;
      filters: Record<string, string>;
      campaignName: string | null;
      coreAccountId: string;
    },
  ) {
    const lines = [...input.lines];
    // Built LAST and unshifted onto the front: the row count and the truncation
    // are only known once the drain has finished, and a preamble asserting
    // completeness before that would be the one lie this file must not tell.
    if (input.preamble) {
      lines.unshift(...buildSpineCsvPreamble({
        kind: input.kind,
        generatedAt: new Date(),
        campaignId: request.params.id,
        campaignName: input.campaignName,
        tenantId: request.tenantId!,
        accountId: input.coreAccountId,
        filters: input.filters,
        rowCount: input.rowCount,
        truncated: input.truncated,
        rowLimit: SPINE_EXPORT_MAX_ROWS,
      }));
    }

    platformAuditLogger.log({
      tenant_id: request.tenantId!,
      ...(request.accountId ? { account_id: request.accountId } : {}),
      ...requestAuditActor(request),
      action: input.kind === 'attempts' ? 'agency_attempts.exported' : 'agency_contacts.exported',
      resource_type: 'agency_campaign',
      resource_id: request.params.id,
      campaign_id: request.params.id,
      details: {
        campaign_id: request.params.id,
        rows: input.rowCount,
        // The filters, so the row count can be read as coverage rather than as
        // a bare number.
        //
        // ⚠️ Only the KEYS are whitelisted — `forwardAllowedQuery` validates
        // no value, and `disposition_code` is deliberately un-vocabularied in core
        // (catalogs are per campaign). So the values ARE caller-controlled and
        // are truncated before they reach the audit store: a 200KB filter value
        // landed here verbatim, repeatable, on the one trail a compliance
        // reader depends on.
        filters: boundedFilters(input.filters),
        ...(input.truncated ? { truncated: input.truncated } : {}),
      },
    });

    const safeName = (input.campaignName ?? 'campaign').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60);
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${input.kind}-${safeName}.csv"`);
    reply.header('X-Export-Rows', String(input.rowCount));
    if (input.truncated) {
      reply.header('X-Export-Truncated', 'true');
      reply.header('X-Export-Truncated-Reason', input.truncated);
      // Only where the ceiling is what stopped it. On a deadline this number
      // would describe a file that does not exist.
      if (input.truncated === 'row_limit') {
        reply.header('X-Export-Row-Limit', String(SPINE_EXPORT_MAX_ROWS));
      }
    }
    return reply.send(lines.join(''));
  }

  app.get<{ Params: { id: string } }>('/campaigns/:id/attempts.csv', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    // `preamble` is consumed here (`wantsPreamble` below) and deliberately never
    // forwarded to core, so it must not read as an unknown param.
    const forwarded = forwardAllowedQuery(request.query, ATTEMPT_QUERY_PARAMS, PREAMBLE_QUERY_PARAMS);
    if (!forwarded.ok) return reply.code(400).send(unknownQueryParamsError(forwarded.unknown));
    const filters = forwarded.query;

    // Resolved for the preamble's chain-of-custody block and the filename.
    // Not an authorisation step — core refuses an unowned campaign on the very
    // first page of the drain below, which is where the 404 comes from.
    const owned = await requireOwnedCampaign(request, reply);
    if (!owned) return reply;

    try {
      const drained = await drainSpineExport<SpineAttemptRow>({
        request,
        path: `/agency-campaigns/${request.params.id}/attempts`,
        metricPath: '/agency-campaigns/:id/attempts',
        filters,
        header: attemptCsvHeader(),
        renderRow: attemptCsvRow,
        enrich: (body) => enrichAttemptAgentNames(
          body, request.tenantId!, resolveAgentNames,
          (err) => log.warn(
            { tenantId: request.tenantId, err: err instanceof Error ? err.message : String(err) },
            'agency spine: agent name resolution failed during export; emitting blank agent_name',
          ),
        ),
      });
      return sendSpineCsv(request, reply, {
        kind: 'attempts',
        ...drained,
        preamble: wantsPreamble(request.query),
        filters,
        campaignName: owned.name,
        // PORT NOTE (magick-agency): the campaign row's account (`requireOwnedCampaign`);
        // master's `?? request.accountId ?? 'default'` fallbacks are gone with the probe's
        // unverified outcome.
        coreAccountId: owned.accountId,
      });
    } catch (err: unknown) {
      if (err instanceof SpineExportRefused) return reply.code(err.status).send(err.body);
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>('/campaigns/:id/contacts.csv', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    const forwarded = forwardAllowedQuery(request.query, CONTACT_QUERY_PARAMS, PREAMBLE_QUERY_PARAMS);
    if (!forwarded.ok) return reply.code(400).send(unknownQueryParamsError(forwarded.unknown));
    const filters = forwarded.query;

    const owned = await requireOwnedCampaign(request, reply);
    if (!owned) return reply;

    try {
      const drained = await drainSpineExport<SpineContactRow>({
        request,
        path: `/agency-campaigns/${request.params.id}/contacts`,
        metricPath: '/agency-campaigns/:id/contacts',
        filters,
        header: contactCsvHeader(),
        renderRow: contactCsvRow,
      });
      return sendSpineCsv(request, reply, {
        kind: 'contacts',
        ...drained,
        preamble: wantsPreamble(request.query),
        filters,
        campaignName: owned.name,
        // PORT NOTE (magick-agency): the campaign row's account (`requireOwnedCampaign`);
        // master's `?? request.accountId ?? 'default'` fallbacks are gone with the probe's
        // unverified outcome.
        coreAccountId: owned.accountId,
      });
    } catch (err: unknown) {
      if (err instanceof SpineExportRefused) return reply.code(err.status).send(err.body);
      throw err;
    }
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Who pressed the control, for core's optional transition body (`86d45k0bk`).
   *
   * ── The gap this closes ───────────────────────────────────────────────────
   * Core stores `last_transition_by: { user_id, name } | null` on the campaign row
   * and reads it from an OPTIONAL request body. These four proxies sent no body,
   * so core stored `null` on every supervisor-initiated transition — and `null` is
   * the same value core writes for a genuinely automatic one (the abandonment
   * auto-pause, the leader's finalization). Left alone, the field would have
   * shipped meaning "master did not say" and never "nobody did it", which is
   * precisely the ambiguity core's contract note names as the price of the body
   * being optional. Master is the only hop that can close it: core has no user
   * table (design D3), so it stores the name it is handed.
   *
   * ── The identity comes from the SESSION. Never from the body. ─────────────
   * `request.user.id`, populated by `sessionMiddleware`. There is no param, query
   * key or body field through which a caller can name the actor, and that is the
   * security property rather than the documentation of one: `last_transition_by`
   * is an ATTRIBUTION field on an audit surface, so a caller-supplied actor is a
   * forged one — a supervisor could stop a campaign in a colleague's name. The
   * inbound body is not forwarded at all (these routes never read it), so the
   * refusal needs no filtering step: the body core receives is built here from
   * facts master authenticated.
   *
   * ── EVERY platform API key sends no actor, whoever minted it ──────────────
   * On `isPlatformApiKeyCaller`, not on a missing `request.user`, and the
   * distinction is the one this repo has now made four times:
   * `sessionMiddleware`'s key branch loads `platform_api_keys.created_by` into
   * `request.user`, so a key minted by a person authenticates CARRYING that
   * person. Attributing the transition to them is the exact defect
   * `resolveAgencyActor` was corrected for — there, "a creator-backed key
   * dispositioned a customer in the creator's name". `created_by` is provenance of
   * the credential, not the identity of whoever holds it now. A credential that
   * names nobody must write "nobody", so a key-authenticated transition is
   * UNATTRIBUTED — which is honest — rather than attributed to a person who was
   * not there.
   *
   * (This paragraph used to add "and `platform_audit_log` has no `api_key_id`
   * column to tell the two apart", as a second reason. Migration 067 added one,
   * so the clause is gone rather than restated — the argument above never needed
   * it, and leaving it standing contradicted the next paragraph.)
   *
   * ── The platform audit row now agrees, and no longer by omission ──────────
   * It used to disagree. The `auditLogger.log` call in each of the four handlers
   * below stamped `user_id: request.user.id`, which for a creator-backed key is
   * the very person this function refuses to name to core — so master's own trail
   * said "Alice started it" while `last_transition_by` said nobody. The local fix
   * (drop `user_id` here) was declined at the time for two reasons that were both
   * about the trail as a whole rather than about these routes: it would have made
   * these four the only audited sites that behaved differently, and with no
   * `api_key_id` column to fall back on it would have traded a misleading
   * principal for no principal at all.
   *
   * 86d45t7rm did the platform-wide repair instead, and it is what makes the two
   * trails agree. `platform_audit_log` now carries `actor_type` and `api_key_id`
   * (migration 067); every audited call site in the service states its actor
   * through `requestAuditActor`, which is a REQUIRED field of
   * `CreateAuditLogInput` so none of them can be missed; and a key-authenticated
   * row names the CREDENTIAL rather than its creator. The key's creator is not
   * lost — it is `platform_api_keys.created_by`, one join away, which is where a
   * fact about the credential belongs.
   *
   * So the asymmetry this docstring used to defend is gone: master records
   * "api_key <id> started it" and core records `last_transition_by: null`, and
   * those are the same statement about who performed the transition. Nothing
   * below needs a special case — the four handlers spread `requestAuditActor`
   * exactly like the other twenty-five.
   *
   * ── Core's `last_transition_by` still carries the three-way ambiguity ─────
   * 86d45t7rm asked whether the same discriminator belongs there too, and the
   * answer is yes but not here. A NULL in `agency_campaigns.last_transition_by_*`
   * means one of three things — genuinely automatic (`running → completed` when
   * the list drains, the abandonment auto-pause), key-authenticated (this
   * function), or written before 86d45k0bk deployed — and core cannot tell them
   * apart because master never tells it which. `system` and `unattributed` are
   * opposite conclusions for an incident, which is exactly the distinction
   * `platform_audit_log.actor_type` now draws on master's side.
   *
   * Closing it is a genuine cross-repo change, not an extension of this one:
   * a core migration adding a transition-source column, a new optional field on
   * the transition body (`AgencyCampaignTransitionRequest` here,
   * `readTransitionActor` there), `formatAgencyCampaignResponse` folding it into
   * the served `last_transition_by`, and cusui rendering it — merge order core →
   * master → cusui. It does NOT touch `agency-s2s-contract.fixture.json`: that
   * fixture covers the attempt actions, DNC and settlement, and the campaign
   * transition body is not in it. Ticketed separately rather than smuggled in
   * behind an audit-column change, because a wire contract deserves its own
   * review.
   *
   * Note this deliberately does NOT refuse the transition, unlike the agency
   * `my-*` routes' 400 `missing_actor`: a key may legitimately stop a campaign
   * (these routes are not on `denyPlatformApiKey`), and refusing the off button
   * for want of attribution is the mistake core's own contract warns against.
   *
   * ── Absent beats a placeholder, and a name is best-effort ─────────────────
   * With no id there is no body: core then stores `null`. Nothing here may spell
   * that as `'system'`, `''` or `'unknown'` — core reads all three as a real
   * actor, and `''` is worse still because `readTransitionActor` trims it back to
   * `null` after the id has already been accepted. The NAME is separate: a lookup
   * that fails yields an id-only actor (`actor_name` omitted, which core stores as
   * `name: null`) rather than failing the transition. Same rule as every other
   * enrichment on this feature — a name is an improvement on the id, never a
   * precondition — and it matters more here, because the alternative is losing
   * the off button to a database blip.
   *
   * A lookup that HANGS is the same failure in the latency direction and needs
   * its own answer, because a starved pool or a lock queue does not reject: the
   * await is bounded by {@link TRANSITION_ACTOR_LOOKUP_TIMEOUT_MS} and expiry
   * takes the identical branch — logged, id-only, transition unaffected. Without
   * the bound the try/catch below reads as complete cover and is not.
   *
   * ── One name lookup for the whole repository ──────────────────────────────
   * `resolveAgentNames`, the binding this file's spine reads already use. Its
   * docstring calls itself "the only declaration of the lookup in the
   * repository" after a byte-identical local copy was left behind once, so a
   * second one here would re-open exactly that. It also keeps the name master
   * SENDS core in step with the name the campaign activity trail DISPLAYS for the
   * same person: the trail's own `resolveDisplayNames` goes through a different
   * repository method (`findIdentitiesInTenant`, which it also needs the role
   * from) but folds it by the same rule — trimmed `display_name`, else the email.
   *
   * Core truncates an over-long name and drops an over-long id; master implements
   * neither ceiling on purpose — see {@link AgencyCampaignTransitionRequest}.
   */
  const resolveTransitionActor = async (
    request: FastifyRequest,
  ): Promise<AgencyCampaignTransitionRequest | undefined> => {
    // PORT NOTE (magick-agency): master checked `isPlatformApiKeyCaller` FIRST here (a
    // creator-backed key carried its creator as `request.user`). Platform API keys are
    // deleted (decision #5): lane A's `sessionMiddleware` has no key branch, so
    // `request.user` is always the Firebase-verified person and the check has nothing
    // left to tell apart. The docstring's key paragraphs above describe master.
    const userId = request.user?.id;
    if (!userId) return undefined;

    const name = await resolveActorDisplayName(request, userId);

    // `actor_name` is OMITTED rather than sent empty when there is no name.
    return { actor_user_id: userId, ...(name ? { actor_name: name } : {}) };
  };

  /**
   * The bounded, never-throwing name lookup the actor resolvers share.
   *
   * Extracted from `resolveTransitionActor` when the retry create needed the
   * same thing, and extracted rather than copied for the reason
   * {@link resolveAgentNames}'s own docstring gives: a byte-identical local copy
   * of the lookup has already been left behind once in this file, and the whole
   * point of that binding is that "turn a user id into something a human reads"
   * has one answer in this repository. Two resolvers reaching for two lookups is
   * how one of them starts reporting an email where the other reports a display
   * name — on two audit surfaces describing the same person.
   *
   * Everything the transition path documented above about failure holds here
   * unchanged: a rejection and an expiry take the SAME branch, are logged
   * separately only so Grafana can tell a slow database from a broken one, and
   * both resolve to `null`. A name is an improvement on the id, never a
   * precondition.
   */
  async function resolveActorDisplayName(
    request: FastifyRequest,
    userId: string,
  ): Promise<string | null> {
    let name: string | null = null;
    let timer: NodeJS.Timeout | undefined;
    try {
      // One id, so this is the single-row case of the page lookup rather than a
      // second method. A miss (a user outside this tenant, a soft-deleted one)
      // is simply absent from the map and resolves to null.
      const lookup = resolveAgentNames([userId], request.tenantId!);
      // A lookup that LOSES the race can still reject afterwards, and an
      // unhandled rejection takes the process down under Node's default. This
      // second handler does not swallow it from the race below — each `then`
      // chain settles independently — so a rejection that arrives in time is
      // still caught and logged there.
      lookup.catch(() => undefined);
      // Raced rather than awaited, and the timeout is not a failure mode of its
      // own: a `pg` query has no `AbortSignal`, and this repo configures no
      // statement timeout, so an unbounded await is a hung pool holding the off
      // button. See {@link TRANSITION_ACTOR_LOOKUP_TIMEOUT_MS}.
      const names = await Promise.race([
        lookup,
        new Promise<typeof LOOKUP_TIMED_OUT>((resolve) => {
          timer = setTimeout(() => resolve(LOOKUP_TIMED_OUT), TRANSITION_ACTOR_LOOKUP_TIMEOUT_MS);
        }),
      ]);
      if (names === LOOKUP_TIMED_OUT) {
        // Deliberately the same outcome as the catch below, and it is logged
        // separately only so the cause is legible in Grafana: a slow database and
        // a broken one need different fixes and produce the same response.
        log.warn(
          { tenantId: request.tenantId, timeoutMs: TRANSITION_ACTOR_LOOKUP_TIMEOUT_MS },
          'agency campaign actor: name resolution timed out; attributing by id alone',
        );
      } else {
        name = names.get(userId) ?? null;
      }
    } catch (err) {
      // Logged, never rethrown: the action is the fact and the name is a label
      // on it. An id-only actor still attributes it.
      log.warn(
        {
          tenantId: request.tenantId,
          err: err instanceof Error ? err.message : String(err),
        },
        'agency campaign actor: name resolution failed; attributing by id alone',
      );
    } finally {
      // Cleared on every path, including the one where the lookup won: a live
      // timer per transition would hold the event loop open for two seconds after
      // the response, and in the suites it keeps the process alive past the test.
      if (timer) clearTimeout(timer);
    }

    return name;
  }

  // Four near-identical handlers rather than a loop or a shared helper that
  // builds the path. The metric-template guard scans `path:` LITERALS, so any
  // indirection — a lookup table, a `.replace()`, a loop variable — hides the
  // route from it and the template registry silently rots. Writing them out is
  // the price of a metric label that means something per operation.
  app.post<{ Params: { id: string } }>('/campaigns/:id/start', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    // Resolved BEFORE the core call, and its failure never reaches the caller:
    // `undefined` means the transition goes out unattributed, exactly as it did
    // before this body existed.
    const actor = await resolveTransitionActor(request);
    const result = await callCore({
      method: 'POST',
      path: `/agency-campaigns/${request.params.id}/start`,
      // Spread, so a request with no resolvable actor carries NO body at all
      // rather than an empty object — byte-identical to what these routes have
      // always sent, and the shape core's `actorPatch` already answers with `{}`.
      ...(actor ? { body: actor } : {}),
      tenantId: request.tenantId!,
      accountId: request.accountId,
    });
    if (result.status < 400) {
      const status = extractCampaignStatus(result.body);
      platformAuditLogger.log({
        tenant_id: request.tenantId!,
        ...(request.accountId ? { account_id: request.accountId } : {}),
        ...requestAuditActor(request),
        action: 'agency_campaign.started',
        resource_type: 'agency_campaign',
        resource_id: request.params.id,
        campaign_id: request.params.id,
        details: { campaign_id: request.params.id, ...(status ? { status } : {}) },
      });
    }
    return reply.code(result.status).send(result.body);
  });

  app.post<{ Params: { id: string } }>('/campaigns/:id/pause', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    // Resolved BEFORE the core call, and its failure never reaches the caller:
    // `undefined` means the transition goes out unattributed, exactly as it did
    // before this body existed.
    const actor = await resolveTransitionActor(request);
    const result = await callCore({
      method: 'POST',
      path: `/agency-campaigns/${request.params.id}/pause`,
      // Spread, so a request with no resolvable actor carries NO body at all
      // rather than an empty object — byte-identical to what these routes have
      // always sent, and the shape core's `actorPatch` already answers with `{}`.
      ...(actor ? { body: actor } : {}),
      tenantId: request.tenantId!,
      accountId: request.accountId,
    });
    if (result.status < 400) {
      const status = extractCampaignStatus(result.body);
      platformAuditLogger.log({
        tenant_id: request.tenantId!,
        ...(request.accountId ? { account_id: request.accountId } : {}),
        ...requestAuditActor(request),
        action: 'agency_campaign.paused',
        resource_type: 'agency_campaign',
        resource_id: request.params.id,
        campaign_id: request.params.id,
        details: { campaign_id: request.params.id, ...(status ? { status } : {}) },
      });
    }
    return reply.code(result.status).send(result.body);
  });

  app.post<{ Params: { id: string } }>('/campaigns/:id/resume', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    // Resolved BEFORE the core call, and its failure never reaches the caller:
    // `undefined` means the transition goes out unattributed, exactly as it did
    // before this body existed.
    const actor = await resolveTransitionActor(request);
    const result = await callCore({
      method: 'POST',
      path: `/agency-campaigns/${request.params.id}/resume`,
      // Spread, so a request with no resolvable actor carries NO body at all
      // rather than an empty object — byte-identical to what these routes have
      // always sent, and the shape core's `actorPatch` already answers with `{}`.
      ...(actor ? { body: actor } : {}),
      tenantId: request.tenantId!,
      accountId: request.accountId,
    });
    if (result.status < 400) {
      const status = extractCampaignStatus(result.body);
      platformAuditLogger.log({
        tenant_id: request.tenantId!,
        ...(request.accountId ? { account_id: request.accountId } : {}),
        ...requestAuditActor(request),
        action: 'agency_campaign.resumed',
        resource_type: 'agency_campaign',
        resource_id: request.params.id,
        campaign_id: request.params.id,
        details: { campaign_id: request.params.id, ...(status ? { status } : {}) },
      });
    }
    return reply.code(result.status).send(result.body);
  });

  /**
   * Stop.
   *
   * **A 200 here means "accepted and draining", NOT "stopped".** `stop` sets the
   * campaign to `stopping`; the pacing leader drains in-flight attempts and
   * writes `stopping → stopped` on its next idle tick, because
   * `running → completed` and `stopping → stopped` have exactly one writer by
   * design, so a supervisor's control cannot race finalization.
   *
   * The UI must therefore poll for the terminal state and must not assert it
   * from this response — a dashboard that flips to "Stopped" on the 200 is
   * lying for as long as the drain takes, while calls are still connected.
   */
  app.post<{ Params: { id: string } }>('/campaigns/:id/stop', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    // Resolved BEFORE the core call, and its failure never reaches the caller:
    // `undefined` means the transition goes out unattributed, exactly as it did
    // before this body existed.
    const actor = await resolveTransitionActor(request);
    const result = await callCore({
      method: 'POST',
      path: `/agency-campaigns/${request.params.id}/stop`,
      // Spread, so a request with no resolvable actor carries NO body at all
      // rather than an empty object — byte-identical to what these routes have
      // always sent, and the shape core's `actorPatch` already answers with `{}`.
      ...(actor ? { body: actor } : {}),
      tenantId: request.tenantId!,
      accountId: request.accountId,
    });
    if (result.status < 400) {
      // A 200 here means "accepted and draining" (see the doc comment above),
      // not "stopped" — `status` in `details` is therefore whatever core
      // returned at this instant (typically still `running`/`stopping`), not a
      // fabricated terminal state.
      const status = extractCampaignStatus(result.body);
      platformAuditLogger.log({
        tenant_id: request.tenantId!,
        ...(request.accountId ? { account_id: request.accountId } : {}),
        ...requestAuditActor(request),
        action: 'agency_campaign.stopped',
        resource_type: 'agency_campaign',
        resource_id: request.params.id,
        campaign_id: request.params.id,
        details: { campaign_id: request.params.id, ...(status ? { status } : {}) },
      });
    }
    return reply.code(result.status).send(result.body);
  });

  // ─── Retry campaigns ──────────────────────────────────────────────────────
  //
  // The frozen wire contract these obligations are numbered against was a
  // MagickVoice superproject document. PORT NOTE (magick-agency): a verbatim copy
  // now lives in this repository:
  // `docs/reference/magickvoice-platform/docs/agency-campaign-retry-wire-contract.md`.
  //
  // It is a cross-service document — three repos implemented it independently and
  // none of them owned it — and its companion design is beside it,
  // `docs/reference/magickvoice-platform/docs/agency-campaign-retry-design.md`.
  // Every `§n` in this file and in the retry tests refers to the wire contract.
  //
  // A retry campaign is an ORDINARY campaign in every respect (DR-1): its own
  // roster, its own pacing leader, its own settlement, its own lifecycle. Three
  // columns and where its contacts came from are the only things that make it a
  // retry. So there is nothing special for this hop to do about pacing, billing
  // or lifecycle — and everything below is either a proxy or one of the four
  // obligations §6 puts on master, which core structurally cannot discharge:
  // governance lives in master's database (MAG-135), the actor lives in master's
  // session, and the platform audit log is master's store.

  /**
   * Flatten a retry-selector query for the core hop — forwarding EVERY key,
   * which is the deliberate opposite of what the spine reads do.
   *
   * ── Why no allow-list here, when `forwardAllowedQuery` refuses unknowns ────
   * The selector's vocabulary is CORE's (`spine-filters.ts`, DR-3) and its
   * refusals are core's: "`X` is not a retry selector dimension", and — for
   * `last_disposition` — a 400 that echoes the PARENT campaign's disposition
   * catalog, which master does not hold and cannot echo. Naming the dimensions
   * here would be a second copy of a vocabulary that already exists once, in the
   * repo that owns the data it filters, and master's copy would be the one that
   * drifts: a dimension core adds would be refused by master with a message
   * about master's list rather than forwarded.
   *
   * The security argument that makes the spine's allow-list right does not
   * reach: nothing in this query can widen scope. The campaign is the `:id` in
   * the path, the tenant and account are headers master sets from the
   * authenticated session, and every refusal core makes carries field-level
   * `details` so it survives `errorMaskHook` intact.
   *
   * Repeats (`?state=a&state=b`) arrive as an array and are comma-joined, which
   * is core's other accepted spelling for the same thing (wire contract §1), so
   * a client may use either form. A blank value is dropped rather than
   * forwarded, for the reason `forwardAllowedQuery` gives: `?last_outcome=` is
   * what a cleared form control posts, and forwarding it would turn an empty
   * filter into one that matches nothing.
   */
  const forwardRetrySelectorQuery = (query: unknown): Record<string, string> => {
    const source = (query ?? {}) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined || value === null) continue;
      const flat = Array.isArray(value) ? value.map(String).join(',') : String(value);
      if (flat.trim().length === 0) continue;
      out[key] = flat;
    }
    return out;
  };

  /**
   * GET /proxy/agency/campaigns/:id/retry/preview — "how many contacts does this
   * selector match, and what were they?" Writes nothing (DR-8).
   *
   * `agency.supervise` (`account_admin`), the same floor as the attempt spine
   * and the campaign controls next door and NOT the `proxy.contact_lists.read`
   * (`viewer`) that `GET /campaigns/:id` carries. The distinction is the one
   * `docs/reference/magickvoice-platform/agency.md` §7.1 draws about that permission being different in kind rather
   * than in floor: this read is a breakdown of how a campaign's calls WENT —
   * outcomes and dispositions per cohort — which is the supervisory record, not
   * the campaign's configuration. It is also the first half of an action, and
   * splitting the preview's floor from the create's would let someone size a
   * cohort they cannot author.
   *
   * A verbatim passthrough otherwise. `excluded` (the DNC and invalid rows DR-4
   * removed from the match) must reach the client untouched: a supervisor who
   * selects "everything suppressed" and is shown 40 instead of 300 without being
   * told why reports it as a bug, which is the whole reason core computes it.
   */
  app.get<{ Params: { id: string } }>('/campaigns/:id/retry/preview', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    const result = await callCore({
      method: 'GET',
      path: `/agency-campaigns/${request.params.id}/retry/preview`,
      query: forwardRetrySelectorQuery(request.query),
      tenantId: request.tenantId!,
      accountId: request.accountId,
      metricPath: '/agency-campaigns/:id/retry/preview',
    });
    return reply.code(result.status).send(result.body);
  });

  /**
   * POST /proxy/agency/campaigns/:id/retry — author a child campaign from a
   * cohort of this one's contacts.
   *
   * ── TWO permissions, and it is not belt-and-braces ────────────────────────
   * The act is *creating a campaign* (`proxy.contact_lists.write`) **and**
   * *acting on another campaign's call results* (`agency.supervise`). Both floor
   * at `account_admin` today, so naming both changes nothing about who gets in —
   * which is exactly why it has to be written down rather than simplified to
   * one. `docs/reference/magickvoice-platform/agency.md` §7.1 records `agency.supervise` as different in KIND, not
   * just in floor; the day either floor moves, this route is still correct, and
   * a tenant narrowing an API key's scopes can narrow one without silently
   * losing the other. Ordered supervise-first so the 403 a non-supervisor sees
   * names the supervisory permission, which is the one they are actually
   * missing on a results-scoped action.
   *
   * ── The order of the checks below is load-bearing ─────────────────────────
   * Every one of master's own 4xx comes BEFORE the first core call, which is the
   * invariant `errorMaskHook` states: the hook decides by whether a core call
   * returned THIS status this request, so a master-authored 400 raised after a
   * core 400 would be rewritten into a support-ticket message. Hence: schema,
   * then config, then actor (all master's), then the parent read, then the
   * capability assert — which can only run 403 after a core call that returned
   * 200, a status the hook does not consider.
   *
   * ── What master does NOT do here ──────────────────────────────────────────
   * It does not validate the selector (core's vocabulary, DR-3), does not
   * compute or check the match size (core's `RETRY_MAX_SEED_ROWS`, and a count
   * master fetched would be stale by the time it acted on it — the same argument
   * the PATCH handler makes about campaign status), does not enforce the
   * generation ceiling, and does not seed anything. Seeding from master was
   * considered and rejected in the design: it turns one transaction into N HTTP
   * round trips with partial-failure states, and a half-seeded retry campaign
   * looks startable and dials a subset nobody chose.
   */
  app.post<{ Params: { id: string } }>('/campaigns/:id/retry', {
    preHandler: [
      requirePermission('agency.supervise'),
      requirePermission('agency.campaigns.write'),
    ],
  }, async (request, reply) => {
    const parsed = retryCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'Validation Error', details: parsed.error.flatten() });
    }

    // Obligation 2. The overrides are the create route's config fields by
    // another name, so they go through the create route's validator — an
    // override must not be able to reach core in a shape `POST /campaigns` would
    // have refused. Note it is the OVERRIDES that are validated and not the
    // merged result: core's own copy of the parent's columns is not master's to
    // re-litigate, and a parent whose stored config predates a validation rule
    // must still be retryable.
    const configIssues = validateAgencyCampaignConfig(parsed.data.config_overrides);
    if (configIssues.length > 0) {
      return reply
        .code(400)
        .send({ error: 'Validation Error', details: issuesToDetails(configIssues) });
    }

    /*
     * Obligation 3 — the actor is master's fact.
     *
     * The `sessionCreate` seam in `agency-s2s-contract.fixture.json` states the
     * rule and the reason: `agent_user_id` is taken from the authenticated
     * session, because a browser that could name the actor could act as a
     * colleague. Here that is a retry campaign authored in someone else's name,
     * on the one row that records who chose to re-dial 812 customers.
     *
     * ── A platform API key is REFUSED, unlike on start/pause/resume/stop ──────
     * Those four deliberately proceed unattributed, on the argument that
     * refusing the off button for want of attribution is worse than an
     * unattributed stop. Nothing about that argument survives here. Authoring a
     * campaign is not an emergency control, core's request requires the actor
     * (wire contract §2), and a key proves a TENANT and names nobody — so the
     * alternatives are a 400 now or core's 400 one round trip later.
     * `missing_actor` is master's established spelling for it (the agency
     * `my-*` routes), so a console has one shape to key off.
     *
     * `isPlatformApiKeyCaller` and NOT `!request.user?.id`: `sessionMiddleware`
     * loads a key's `created_by` into `request.user`, so the shorter spelling
     * would attribute the retry to whoever minted the credential, possibly years
     * ago. That is the defect `resolveAgencyActor` was corrected for.
     */
    //
    // PORT NOTE (magick-agency): no platform API keys (decision #5), so the
    // `isPlatformApiKeyCaller(request) ? undefined :` arm is deleted and `request.user`
    // is always the signed-in person. `missing_actor` stays for a request with no user
    // (the session middleware refuses one first in practice). Its message no longer
    // names keys, as lane B2 did for `agency-actor.ts`.
    const actorUserId = request.user?.id;
    if (!actorUserId) {
      return reply.code(400).send({
        error: 'Validation failed',
        code: 'missing_actor',
        message:
          'Creating a retry campaign must be attributed to a user. Sign in as a supervisor.',
      });
    }


    /*
     * The parent read, which is doing two jobs at once and both are required.
     *
     *  1. OWNERSHIP. `requirePermission` proves the caller's role and never
     *     looks at the target row, so without this a supervisor could pass
     *     another tenant's campaign id. Core's `requireOwned` answers 404 for a
     *     campaign in another tenant or account and that status is forwarded
     *     verbatim — a cross-tenant id and a nonexistent one must stay
     *     indistinguishable, or the response is a campaign-id oracle.
     *  2. The INHERITED CONFIG for obligation 1 below.
     *
     * ── A transport failure must NOT degrade to "proceed" ────────────────────
     * `requireOwnedCampaign` above answers a core outage by serving master's
     * half of the audit trail marked `partial`, because a read can honestly
     * degrade. This cannot: proceeding without the parent's config means
     * creating a campaign whose recording and analysis settings were never
     * checked against this tenant's capabilities, which is precisely the thing
     * obligation 1 exists to prevent. So `proxyToCore`'s throw is left to
     * propagate — the error mask turns it into a 500 with a request id and a
     * full log line, and nothing was created.
     *
     * PORT NOTE (magick-agency): in-process (`callCore`) the only throw is a wiring
     * defect; it still propagates (a 500, nothing created).
     */
    const parent = await callCore({
      method: 'GET',
      path: `/agency-campaigns/${request.params.id}`,
      tenantId: request.tenantId!,
      accountId: request.accountId,
      metricPath: '/agency-campaigns/:id',
    });
    if (parent.status >= 400) return reply.code(parent.status).send(parent.body);

    // Obligation 1 — MAG-138 re-fought on a route that sends no config. See
    // `resolveInheritedBehavioralConfig` for why the merged parent config is the
    // only input on which this gate can fail, and why asserting against the
    // request body here would be a check that passes by construction.
    const effectiveConfig = resolveInheritedBehavioralConfig(
      parent.body,
      parsed.data.config_overrides,
    );
    //
    // PORT NOTE (magick-agency): the target is the PARENT campaign's own `tenant_id` /
    // `account_id`, read off the parent row core just returned (lane A's interface
    // change 1): the child is created in the parent's account, so that account's
    // settings row is the one that decides. Read defensively like every other field of
    // core's body; a missing id reaches lane A's gate as a missing target and fails
    // closed. The object asserted is the effective inherited config core will create the
    // child with (the parent's values with exactly `parsed.data.config_overrides`, the
    // object forwarded below, on top).
    if (!(await assertBehavioralCapabilitiesForConfig(request, reply, effectiveConfig, {
      tenantId: extractCampaignField(parent.body, 'tenant_id'),
      accountId: extractCampaignField(parent.body, 'account_id'),
    }))) return;

    // Obligation 2, second half — the one cross-field rule that needs the parent.
    // See `mergedCallingWindowIssues`. Safe to raise a master 400 here even
    // though it follows a core call: `errorMaskHook` rewrites a status only when
    // a core call returned THAT status this request, and the parent read
    // returned 200.
    const windowIssues = mergedCallingWindowIssues(parent.body, parsed.data.config_overrides);
    if (windowIssues.length > 0) {
      return reply
        .code(400)
        .send({ error: 'Validation Error', details: issuesToDetails(windowIssues) });
    }

    // Resolved after the gates, so a refused request never costs a lookup. Its
    // failure never reaches the caller: a missing name attributes the retry by
    // id alone, exactly as the lifecycle transitions do.
    const actorName = await resolveActorDisplayName(request, actorUserId);

    /*
     * The body core receives is BUILT here from validated fields plus facts
     * master authenticated — never `request.body` spread and patched. `.strict()`
     * on the schema already refuses a client-supplied `agent_user_id`, so this is
     * the second of two independent reasons the actor cannot be forged; the
     * rebuild is the one that would still hold if the schema were ever loosened.
     *
     * `actor_name` is OMITTED rather than sent empty when there is no name —
     * core reads `''`, `'system'` and `'unknown'` as real actors — and truncated
     * to core's ceiling rather than refused, because a long display name must
     * never be why a retry does not happen.
     *
     * Note the field is `agent_user_id`, not the `actor_user_id` the four
     * lifecycle transitions on this same plugin send. Two spellings for one idea
     * on one plugin is unfortunate and it is the CONTRACT's, not a choice made
     * here: core's retry handler and its `sessionCreate` seam both read
     * `agent_user_id`. Do not "tidy" this to match its neighbours — the field is
     * dropped by core's schema if it is misspelled, which is MAG-118 exactly, and
     * the failure is a 400 with no clue in it.
     */
    const result = await callCore({
      method: 'POST',
      path: `/agency-campaigns/${request.params.id}/retry`,
      body: {
        selector: parsed.data.selector,
        ...(parsed.data.name ? { name: parsed.data.name } : {}),
        ...(parsed.data.config_overrides
          ? { config_overrides: parsed.data.config_overrides }
          : {}),
        agent_user_id: actorUserId,
        ...(actorName
          ? { actor_name: actorName.slice(0, RETRY_ACTOR_NAME_MAX_CHARS) }
          : {}),
        // Absent stays absent: an unkeyed create is legal, and sending `null`
        // where the client sent nothing would be master having an opinion about
        // a field it deliberately does not own.
        //
        // PRESENCE, not truthiness. `z.string().optional()` accepts `""`, and
        // `""` is falsy — so a truthiness check drops it and core sees an
        // UNKEYED create. A client that sends `idempotency_key: ""` (an empty
        // form field, a defaulted string, a retry of a failed parse) would then
        // get a legal create, and repeating the request would build a SECOND
        // campaign over the same cohort and dial it again. That is precisely
        // the failure this field exists to prevent, wearing the shape of
        // protection. `undefined` is the only absent value; `null` is already a
        // 400 here (the field is not `.nullable()`), and `""` belongs to core,
        // which answers 400 with `details.idempotency_key` — a shape that
        // survives the error mask.
        ...(parsed.data.idempotency_key !== undefined
          ? { idempotency_key: parsed.data.idempotency_key }
          : {}),
      },
      tenantId: request.tenantId!,
      accountId: request.accountId,
      metricPath: '/agency-campaigns/:id/retry',
    });

    /*
     * ── A REPLAY files no activity row ──────────────────────────────────────
     *
     * Core answers `200` with `idempotent_replay: true` when the key had already
     * created a campaign: nothing was created by this request. A second
     * `agency_campaign.retry_created` on the parent's trail would assert that a
     * cohort was selected and re-dialled twice — precisely the thing the key
     * exists to guarantee did not happen, written into the store a compliance
     * reviewer opens to establish that it did not. The response still carries the
     * campaign, so the console is unaffected.
     *
     * Read defensively off an unknown body, like every other field here: an older
     * core does not send the flag at all, and its absence must read as "this was a
     * create", which is what it was.
     */
    const replayed = (result.body as { idempotent_replay?: unknown } | null)
      ?.idempotent_replay === true;

    if (result.status < 400 && !replayed) {
      /*
       * Obligation 4 — the activity row.
       *
       * ── Filed against the PARENT, and that is the decision worth stating ───
       * A row carries one `campaign_id`, so it appears on one campaign's trail.
       * The child's creation is already recorded on the child, by core, as
       * `agency_campaign.created`; what nothing else records is that a cohort of
       * THIS campaign's results was selected and re-dialled, which is a fact
       * about this campaign and belongs on the trail a compliance reviewer opens
       * when asking what was done with its call outcomes. `child_campaign_id` in
       * the detail is the link across, and the child row's own
       * `parent_campaign_id` is the link back.
       *
       * The selector is recorded here as well as frozen on the child row (DR-5)
       * because they answer different questions: the child's copy explains its
       * roster, and this one explains the operator's intent at the moment they
       * had it, on a store the child's deletion cannot take with it.
       *
       * Every field core supplies is narrowed defensively before it is read —
       * master keeps no campaign schema, and a malformed core response must
       * never throw out of an audit call and take a successful create down with
       * it (`MAG-70`'s rule, and `extractCampaignField`'s).
       */
      const body = (result.body && typeof result.body === 'object' && !Array.isArray(result.body))
        ? (result.body as Record<string, unknown>)
        : {};
      const childCampaignId = extractCampaignField(body['campaign'], 'id');
      const seeded = body['contacts_seeded'];
      // Normally 0 and then omitted. A retry seeds fewer rows than the preview
      // matched when the parent held byte-identical roster rows, which the child
      // collapses — so a non-zero value here is the ONLY explanation on this
      // trail for a campaign smaller than the number the supervisor approved.
      const collapsed = body['duplicates_collapsed'];
      platformAuditLogger.log({
        tenant_id: request.tenantId!,
        ...(request.accountId ? { account_id: request.accountId } : {}),
        ...resolvedUserAuditActor(request, actorUserId),
        action: 'agency_campaign.retry_created',
        resource_type: 'agency_campaign',
        resource_id: request.params.id,
        campaign_id: request.params.id,
        details: {
          campaign_id: request.params.id,
          parent_campaign_id: request.params.id,
          ...(childCampaignId ? { child_campaign_id: childCampaignId } : {}),
          ...(typeof seeded === 'number' ? { contacts_seeded: seeded } : {}),
          ...(typeof collapsed === 'number' && collapsed > 0
            ? { duplicates_collapsed: collapsed }
            : {}),
          // Bounded, not verbatim — see `boundedSelector`. The intent is what
          // this row is for; an unbounded caller-controlled value on a trail
          // nothing purges is what the export path already had to fix.
          selector: boundedSelector(parsed.data.selector),
        },
      });
    }
    return reply.code(result.status).send(result.body);
  });

  /**
   * GET /proxy/agency/campaigns/:id/lineage — the whole chain, root first.
   *
   * `proxy.contact_lists.read` (`viewer`), the same floor as `GET /campaigns/:id`
   * and deliberately NOT the `agency.supervise` its two retry siblings above
   * carry. Lineage is NAVIGATION, not results: names, statuses, generations and
   * contact totals — every field of which a `viewer` can already read one at a
   * time by fetching each campaign. Flooring it higher would mean a viewer could
   * open a retry campaign and not be told what it was a retry of, which reads as
   * missing data rather than as a permission boundary.
   *
   * A campaign in no chain answers with itself as the only entry, not a 404 —
   * core's rule, and the reason the console can render the strip unconditionally.
   */
  app.get<{ Params: { id: string } }>('/campaigns/:id/lineage', {
    preHandler: requirePermission('agency.campaigns.read'),
  }, async (request, reply) => {
    const result = await callCore({
      method: 'GET',
      path: `/agency-campaigns/${request.params.id}/lineage`,
      tenantId: request.tenantId!,
      accountId: request.accountId,
      metricPath: '/agency-campaigns/:id/lineage',
    });
    return reply.code(result.status).send(result.body);
  });

  // ─── Ingest: limits, upload, analyze, run, poll, cancel, rejects ──────────

  /**
   * The limits the wizard must display. Served from the constants rather than
   * duplicated in the client, because a copy of a limit is a limit that goes
   * stale and tells the admin the wrong number.
   */
  app.get('/ingest/limits', {
    preHandler: requirePermission('agency.campaigns.read'),
  }, async (_request, reply) => {
    return reply.code(200).send({
      max_rows: AGENCY_MAX_ROWS,
      max_columns: AGENCY_MAX_COLUMNS,
      max_cell_bytes: AGENCY_MAX_CELL_BYTES,
      max_file_bytes: CSV_MAX_BYTES,
    });
  });

  /**
   * Upload the CSV. Stored raw; parsing happens in the ingest job.
   *
   * Multipart lives in its own sub-plugin so the parser is scoped to this one
   * route, matching `contact-lists.routes.ts` — registering it at the plugin
   * root would put a body parser in front of every JSON route here. Hooks are
   * re-added because a sub-plugin does not inherit the parent's.
   */
  await app.register(async function agencyUploadPlugin(sub) {
    await sub.register(import('@fastify/multipart'), {
      limits: { fileSize: CSV_MAX_BYTES },
    });
    sub.addHook('preHandler', sessionMiddleware);
    sub.addHook('preHandler', tenantContextMiddleware);
    // PORT NOTE (magick-agency): `requireCapability('agency')` deleted, as on the parent.

    sub.post('/ingest/upload', {
      preHandler: requirePermission('agency.campaigns.write'),
    }, async (request, reply) => {
      const file = await request.file();
      if (!file) {
        return reply.code(400).send({ error: 'Validation Error', message: 'No file uploaded.' });
      }

      const buffer = await file.toBuffer();
      const uploadId = crypto.randomUUID();
      // The shape is load-bearing: `isTenantUploadKey` proves ownership of a
      // client-supplied key from exactly what `uploadKey` mints, and refuses the
      // rejected-rows export that shares its prefix.
      const safeName = file.filename.replace(/[^A-Za-z0-9._-]/g, '_');
      const s3Key = uploadKey(request.tenantId!, uploadId, safeName);
      await uploadFile(s3Key, buffer, 'text/csv');

      log.info(
        { tenantId: request.tenantId, s3Key, bytes: buffer.length },
        'Agency roster CSV uploaded',
      );

      return reply.code(201).send({
        s3_key: s3Key,
        file_name: file.filename,
        file_size_bytes: buffer.length,
      });
    });
  });

  /**
   * Column analysis for the mapping screen: headers, three samples per column,
   * and a phone-column suggestion that is WITHHELD when two columns are too
   * close to call. Reads a bounded prefix, so it is fast on a 1M-row file.
   */
  app.post('/ingest/analyze', {
    preHandler: requirePermission('agency.campaigns.write'),
  }, async (request, reply) => {
    const parsed = analyzeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', details: parsed.error.flatten() });
    }
    if (!isTenantOwnedKey(parsed.data.s3_key, request.tenantId!)) {
      return reply.code(403).send({ error: 'Forbidden', message: 'That upload does not belong to this tenant.' });
    }

    try {
      const { body } = await getFileStream(parsed.data.s3_key);
      const analysis = await analyzeAgencyCsvColumns({
        source: body,
        ...(parsed.data.default_country_code
          ? { defaultCountryCode: parsed.data.default_country_code.replace(/^\+/, '') }
          : {}),
      });
      return reply.code(200).send(analysis);
    } catch (err) {
      if (err instanceof AgencyIngestError) {
        return reply.code(422).send({ code: err.code, message: err.message });
      }
      throw err;
    }
  });

  /**
   * Start an ingest. Returns 202 immediately — a 1M-row file takes minutes, so
   * the wizard polls the job rather than holding a request open.
   *
   * `dry_run: true` runs the whole parse and reports the summary WITHOUT
   * sending anything to core, which is what lets the wizard say "95% of your
   * rows are valid" before the operator commits.
   */
  app.post('/ingest/jobs', {
    preHandler: requirePermission('agency.campaigns.write'),
  }, async (request, reply) => {
    const parsed = startIngestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', details: parsed.error.flatten() });
    }
    const input = parsed.data;

    if (!isTenantOwnedKey(input.s3_key, request.tenantId!)) {
      return reply.code(403).send({ error: 'Forbidden', message: 'That upload does not belong to this tenant.' });
    }
    if (!input.dry_run && !input.campaign_id) {
      return reply.code(400).send({
        error: 'Validation Error',
        message: 'campaign_id is required unless dry_run is true.',
      });
    }

    if (input.mode === 'replace') {
      /**
       * Every guard on the destructive branch, refused BEFORE the job row is
       * created — a `pending` job that can never legally run is a row the reaper
       * has to clean up and an operator has to interpret.
       *
       * 400 rather than 501 for the not-enabled case, deliberately: the error
       * mask turns every 5xx into "contact support and quote this request id",
       * so a 501 would replace the one sentence that tells the operator what is
       * actually true — that this deployment cannot do it yet.
       */
      if (!config.agency.rosterReplaceEnabled) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: 'Replacing a roster is not enabled on this deployment.',
        });
      }
      if (input.dry_run) {
        // A preview that retires a roster is a contradiction, and it is the one
        // combination an operator could plausibly send by accident while trying
        // to be careful.
        return reply.code(400).send({
          error: 'Validation Error',
          message: 'A dry run cannot replace a roster — it would destroy the roster it is previewing.',
        });
      }
      if (input.expected_contacts_total === undefined) {
        return reply.code(400).send({
          error: 'Validation Error',
          message:
            'expected_contacts_total is required when mode is replace — state how many contacts you expect to retire.',
        });
      }
    }

    // Membership first, header as the fallback for a tenant-wide caller who
    // names one — the `GET /phone-numbers` rule. An account-scoped caller who
    // omits `X-Account-Id` used to stamp NULL here, which the account-scoped
    // lookups below would then refuse to show back to its own creator. Never
    // a widening: when both are present `tenantContextMiddleware` has already
    // refused a header that disagrees with an account-scoped membership.
    const jobAccountId = ingestJobAccountScope(request) ?? request.accountId ?? null;

    // Any named campaign must be one the caller owns — a dry run's included. A
    // run that writes sends its rows to that campaign over S2S (see the probe's
    // docstring); a dry run sends nothing, but it still READS through the id:
    // `dropSuppressed` applies that campaign's campaign-scoped DNC entries, so
    // an unprobed dry run naming a sibling's campaign reported which of the
    // caller's numbers that campaign suppresses, and stored the unverified id
    // on the job row. A dry run WITHOUT a campaign is not probed, and so stays
    // reachable with core down.
    //
    // PORT NOTE (magick-agency): the probe now returns the PROVEN owner's account (the
    // campaign row's `account_id`), and that is what the job is stamped with whenever a
    // campaign is named (lane B2 carry-forward: `agency_ingest_jobs.account_id` is set
    // from the proven owner, because the in-process roster hand-off compares it to the
    // campaign's account and fails a mismatched or NULL one `core_rejected_chunk`).
    // Core's `requireOwned` matched that column to `jobAccountId`, so the two are equal;
    // the row's value is used so the invariant is stated where it is written. A dry run
    // with no campaign keeps master's `jobAccountId` (no roster is written).
    let ownerAccountId: string | null = jobAccountId;
    if (input.campaign_id) {
      const proven = await proveCampaignOwnedForWrite(request, reply, input.campaign_id, jobAccountId);
      if (!proven) {
        return reply;
      }
      ownerAccountId = proven;
    }

    const job = await agencyIngestJobRepository.create({
      tenant_id: request.tenantId!,
      account_id: ownerAccountId,
      campaign_id: input.campaign_id ?? null,
      s3_key: input.s3_key,
      file_name: input.file_name,
      phone_column: input.phone_column,
      timezone_column: input.timezone_column ?? null,
      ignore_columns: input.ignore_columns ?? [],
      default_country_code: input.default_country_code?.replace(/^\+/, '') ?? null,
      dedupe_phones: input.dedupe_phones ?? true,
      dry_run: input.dry_run ?? false,
      ...(input.mode ? { mode: input.mode } : {}),
      // A person, or nobody. A platform API key authenticates carrying its
      // CREATOR as `request.user`, and `created_by` is provenance of the
      // credential, not the identity of whoever holds it now — the correction
      // `requestAuditActor` and `resolveAgencyActor` already make. Stamping the
      // creator would record them as having run an import they did not run.
      // The column has no key-id twin, so NULL ("not a person") is the honest
      // value; the credential is one join away in the request log.
      //
      // PORT NOTE (magick-agency): no platform API keys (decision #5), so the
      // `isPlatformApiKeyCaller(request) ? null :` arm is deleted; `request.user` is
      // always the person who ran the import.
      created_by: request.user?.id ?? null,
    });

    // Detached deliberately: the ingest owns its own failure handling and
    // records every outcome on the job row, so there is nothing here to await
    // and nothing that can become an unhandled rejection.
    void agencyIngestService
      .run({
        job,
        // Only meaningful for a replace, and validated above for exactly that
        // case. Passed rather than stored: it is an assertion about the instant
        // the operator clicked and is consumed once.
        ...(input.expected_contacts_total !== undefined
          ? { expectedContactsTotal: input.expected_contacts_total }
          : {}),
      })
      .catch((err: unknown) => {
        log.error({ err, jobId: job.id }, 'Agency ingest promise rejected outside its own handler');
      });

    // `mode` is echoed so the caller can see which semantics it actually got
    // rather than assuming its request was understood — the whole failure this
    // field exists to end was an intent nobody could observe.
    return reply.code(202).send({ job_id: job.id, status: job.status, mode: job.mode ?? 'append' });
  });

  /** Poll. `progress_pct` is byte-based — the only honest fraction when the
   *  row count is unknown until the file has been read. */
  app.get<{ Params: { id: string } }>('/ingest/jobs/:id', {
    preHandler: requirePermission('agency.campaigns.read'),
  }, async (request, reply) => {
    if (!isIngestJobId(request.params.id)) return replyImportNotFound(reply);
    // A sibling account's job and a nonexistent one are the same 404, so the
    // response is not a job-id oracle.
    const job = await agencyIngestJobRepository.findById(
      request.params.id,
      request.tenantId!,
      ingestJobAccountScope(request),
    );
    if (!job) return reply.code(404).send({ error: 'Not Found', message: 'Import not found.' });
    return reply.code(200).send(toJobResponse(job));
  });

  app.post<{ Params: { id: string } }>('/ingest/jobs/:id/cancel', {
    preHandler: requirePermission('agency.campaigns.write'),
  }, async (request, reply) => {
    if (!isIngestJobId(request.params.id)) return replyImportNotFound(reply);
    const accountScope = ingestJobAccountScope(request);
    // The scope is a predicate of the UPDATE itself, not a read beforehand — a
    // fetch-then-check is a read and a write that can disagree.
    const cancelled = await agencyIngestJobRepository.requestCancel(
      request.params.id,
      request.tenantId!,
      accountScope,
    );
    if (!cancelled) {
      // A miss is either "finished" or "not yours / not there". The unscoped
      // version answered 409 "already finished" for every miss, which was
      // merely misleading (its leak was the 202 it gave a sibling's LIVE
      // import, after actually cancelling it). Tell them apart under the SAME
      // scope, so a sibling account's job answers 404 exactly like a
      // nonexistent one and 409 is reserved for a job the caller can see.
      const job = await agencyIngestJobRepository.findById(
        request.params.id,
        request.tenantId!,
        accountScope,
      );
      if (!job) return reply.code(404).send({ error: 'Not Found', message: 'Import not found.' });
      // 409, not 200: pretending to cancel something already finished would
      // leave the operator believing a roster was not loaded when it was.
      return reply.code(409).send({
        error: 'Conflict',
        message: 'That import has already finished and cannot be cancelled.',
      });
    }
    return reply.code(202).send({ job_id: request.params.id, cancel_requested: true });
  });

  /**
   * ─── Clear a campaign's roster ────────────────────────────────────────────
   *
   * **Registered only when `AGENCY_ROSTER_REPLACE_ENABLED` is set**, following
   * this platform's established shape — an entire subsystem registers only if
   * its config says so, and docs/reference/magickvoice-platform/CLAUDE.md's rule of thumb that a missing route
   * in a running service usually means an unset env var. A destructive surface
   * that is visible but always fails is worse than one that is not there.
   *
   * ── Why this exists at all ────────────────────────────────────────────────
   * There has never been a way to clear an agency roster — no route in master,
   * no endpoint in core — while cusui's own summary copy tells operators, in
   * two places, that they can "clear and re-upload". The product's advice was
   * impossible to follow, and after core's 083 the workaround operators reached
   * for instead (re-upload the corrected file) silently MERGES.
   *
   * ── Why a route of its own rather than falling out of replace ─────────────
   * The two share one primitive (`supersedeRoster`) and deliberately so, because
   * one destructive code path is easier to keep correct than two. But they are
   * not one operation. Clear is reached when the operator has NO file — after a
   * cancelled import, or when abandoning a campaign's list — and expressing it
   * as "replace with an empty CSV" would mean uploading a file that does not
   * exist to perform an action that has nothing to do with files.
   *
   * POST rather than DELETE: the confirmation payload is a body, and DELETE with
   * a body is unreliable across clients and intermediaries. It also reads as
   * what it is — a lifecycle action on the campaign, like `/start` and `/pause`
   * above.
   *
   * `proxy.contact_lists.write` (account_admin and up) is the same permission
   * that loads a roster, which is the right pairing: whoever can put a list in
   * front of the dialer can take it away.
   *
   * ── Three outcomes, and the middle one is the point ───────────────────────
   *   200 `roster_state: 'cleared'`     — `cleared` is the count core retired.
   *   202 `roster_state: 'unconfirmed'` — the request may or may not have been
   *       applied; `cleared`/`contacts_total` are null and the operator must
   *       re-read the campaign's count. See the branch below for why 202.
   *   409 / 404                         — core refused on a single attempt, so
   *       nothing was cleared, or the campaign does not exist.
   */
  //
  // PORT NOTE (magick-agency, decision B15): registered under exactly master's flag
  // (`config.agency.rosterReplaceEnabled`, `AGENCY_ROSTER_REPLACE_ENABLED`, default off).
  // When it is on, the route still refuses: lane B2's in-process `supersedeRoster` throws
  // `RosterSupersedeError(..., 'unsupported', attempts 1)` and writes nothing — the outcome
  // production had, because core @ 4850d1d9 never served the supersede endpoint — and the
  // `unsupported` arm falls through to the 500 below, as in master. The ingest's
  // `mode: 'replace'` likewise ends `replace_unsupported`.
  if (config.agency.rosterReplaceEnabled) {
    app.post<{ Params: { id: string } }>('/campaigns/:id/roster/clear', {
      preHandler: requirePermission('agency.campaigns.write'),
    }, async (request, reply) => {
      const parsed = clearRosterSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Validation Error', details: parsed.error.flatten() });
      }

      // Same ownership proof as the ingest: the supersede is an S2S write that
      // core's `requireOwned` never sees. Membership account first, never the
      // header alone — an account-scoped caller who omits it used to send no
      // account at all.
      // PORT NOTE (magick-agency): as on the ingest, the supersede is addressed to the
      // proven owner's account (the probe's return), not the caller's scope.
      const callerAccountId = ingestJobAccountScope(request) ?? request.accountId ?? null;
      const clearAccountId = await proveCampaignOwnedForWrite(request, reply, request.params.id, callerAccountId);
      if (!clearAccountId) {
        return reply;
      }

      try {
        // No `ingestJobId`: nothing is being loaded, so nothing is exempt and
        // every live contact is retired. Idempotent for the same reason the
        // replace path is — core's predicate only ever touches rows that are
        // still live, so a second clear finds nothing to do and says so.
        const result = await supersedeRoster({
          campaignId: request.params.id,
          tenantId: request.tenantId!,
          ...(clearAccountId ? { accountId: clearAccountId } : {}),
          expectedContactsTotal: parsed.data.expected_contacts_total,
          reason: 'clear',
        });

        log.info(
          {
            tenantId: request.tenantId,
            campaignId: request.params.id,
            superseded: result.superseded,
            alreadyApplied: result.already_applied,
          },
          'Agency roster cleared',
        );

        return reply.code(200).send({
          campaign_id: request.params.id,
          // One field to switch on, never an inference from an absence — the
          // same reason the job payload pairs its count with an explicit
          // uncertainty flag. `cleared` is a number here and `null` on the
          // `unconfirmed` response below, so a client that reads only the count
          // cannot mistake "we do not know" for "nothing was cleared".
          roster_state: 'cleared',
          cleared: result.superseded,
          contacts_total: result.contacts_total,
          // True on a retry that found nothing left to clear. Surfaced rather
          // than flattened into `cleared: 0`, which the UI would otherwise
          // render as "nothing happened" for an operation that had already
          // succeeded.
          already_applied: result.already_applied,
        });
      } catch (err) {
        if (err instanceof RosterSupersedeError) {
          if (err.code === 'campaign_not_found') {
            // Checked ahead of the attempt count below, and it is the one code
            // that may be: a campaign core cannot find has no roster for the
            // operator to go and check, so "we could not confirm your contacts"
            // would be an alarm about nothing.
            //
            // `code` is carried explicitly, and it is not decoration.
            // `campaign_not_found` is already allow-listed in `errorMaskHook`,
            // but the allow-list reads the BODY — and this body used to be
            // `{ error, message }`, so core's recorded 404 masked the response
            // into "contact support and quote this request id" for a campaign
            // that simply does not exist.
            return reply.code(404).send({
              error: 'Not Found',
              code: 'campaign_not_found',
              message: 'Campaign not found.',
            });
          }
          /**
           * ── The roster may already be empty, and no final code says so ──────
           *
           * `supersedeRoster` makes up to FOUR attempts (`withRetry` loops
           * `attempt <= maxRetries`), so attempt 1 can retire 5,000 contacts and
           * commit, lose its response to the 30s timeout, and attempt 2 be
           * answered `409 contacts_total_mismatch` by core's compare-and-swap
           * against a roster that is already 0. Answering the browser 409 there
           * tells the operator their clear failed while their contacts are gone.
           *
           * So `attempts > 1` is the discriminator — the same one the ingest
           * replace path uses, and coarse in the same safe direction: a 409 on
           * attempt 2 may genuinely be a colleague's concurrent top-up, and that
           * is reported as unconfirmed too.
           *
           * **202, not 409, and not 200.** This route is synchronous, so unlike
           * ingest there is no job row to record the state on — the response IS
           * the record, and it has to be one an operator can act on. A 4xx says
           * "your request did not happen", which is exactly the untruth being
           * fixed, and it would additionally be swallowed by `errorMaskHook`
           * (core answered 4xx this request, and this body carries no `details`
           * and no allow-listed `code`), replacing the one sentence that matters
           * with a support-ticket message. A 200 asserts the opposite untruth.
           * 202 is the honest shape: the request was accepted, the outcome is not
           * knowable here, read it from the campaign.
           *
           * The recovery is the SAME action the `contacts_total_mismatch`
           * guidance already gives cusui — re-fetch the campaign's contact count
           * and confirm again with what you see — never a bare retry, which
           * re-asserts a count that is now certainly wrong.
           */
          if (err.attempts > 1) {
            log.warn(
              {
                tenantId: request.tenantId,
                campaignId: request.params.id,
                code: err.code,
                coreCode: err.coreCode,
                coreStatus: err.coreStatus,
                attempts: err.attempts,
              },
              'Agency roster clear could not be confirmed — the roster may already be empty',
            );
            return reply.code(202).send({
              campaign_id: request.params.id,
              roster_state: 'unconfirmed',
              // Null, never 0: master has no count, and a zero here would read
              // as "we cleared nothing" on the one response where that is the
              // claim it cannot make.
              cleared: null,
              contacts_total: null,
              code: 'roster_state_unconfirmed',
              // Core's own refusal reason where it gave one, for the log trail
              // and for a console that wants to say which check failed. Absent
              // when the attempts never reached core.
              ...(err.coreCode ? { core_code: err.coreCode } : {}),
              attempts: err.attempts,
              message:
                `This took ${err.attempts} attempts and the result could not be confirmed, so this campaign's contacts may already have been removed. ` +
                'Re-check the campaign\'s contact count, then confirm again with the count you see — do not simply retry.',
            });
          }
          if (err.code === 'refused') {
            // Core's own refusal, forwarded with its machine code: the campaign
            // is dialing, an attempt is live, or the roster changed size since
            // the operator looked. Each is actionable and none is a bug — and
            // reachable here only on a single attempt, so "nothing was cleared"
            // is provable rather than assumed.
            return reply.code(409).send({
              error: 'Conflict',
              code: err.coreCode,
              message: err.message,
            });
          }
        }
        // `unsupported` and `failed` fall through on purpose. Both mean this
        // deployment is wired wrong — the flag above is on while core cannot
        // serve the hop — which is a server fault, and the error mask's job is
        // to turn a server fault into a request id plus a full log line rather
        // than an operator-facing explanation of our deployment.
        throw err;
      }
    });
  }

  /**
   * Download the rejected rows: the operator's original columns plus `_reason`.
   * Nobody fixes 577 rows from a screen — they fix them in Excel and re-upload.
   */
  app.get<{ Params: { id: string } }>('/ingest/jobs/:id/rejected.csv', {
    preHandler: requirePermission('agency.campaigns.read'),
  }, async (request, reply) => {
    if (!isIngestJobId(request.params.id)) return replyImportNotFound(reply);
    // Same scope as the poll: this streams PII-bearing roster rows.
    const job = await agencyIngestJobRepository.findById(
      request.params.id,
      request.tenantId!,
      ingestJobAccountScope(request),
    );
    if (!job) return reply.code(404).send({ error: 'Not Found', message: 'Import not found.' });
    if (!job.rejected_s3_key) {
      return reply.code(404).send({
        error: 'Not Found',
        message: 'That import had no rejected rows.',
      });
    }

    const buffer = await getFileBuffer(job.rejected_s3_key);
    const safeName = downloadBaseName(job.file_name);
    return reply
      .code(200)
      .header('Content-Type', 'text/csv')
      .header('Content-Disposition', `attachment; filename="${safeName}-rejected-rows.csv"`)
      .send(buffer);
  });
}

/**
 * The caller's own account scope for an ingest-job lookup (ClickUp
 * `14ygtkj8rvv`): the MEMBERSHIP's `account_id`, never `request.accountId` —
 * `X-Account-Id` is an unauthenticated, optional header, so an account-scoped
 * caller who omits it would otherwise read as tenant-wide. `null` for a
 * tenant-wide membership (or none — the shape an unrestricted platform key
 * resolves to, which `requirePermission` has already refused if it names no
 * creator), which leaves every job in the tenant reachable, by design.
 *
 * Every route that takes a job id threads this through — poll, cancel AND the
 * rejected-rows export: a guard on one of them is not a guard on the others.
 */
function ingestJobAccountScope(request: FastifyRequest): string | null {
  return request.membership?.account_id ?? null;
}

/**
 * An ingest job id is master's own UUID primary key. Anything else reached
 * Postgres as `22P02 invalid_text_representation`, which the error handler
 * serves as a masked 500 — on poll, cancel and the rejected-rows download alike.
 * Checked in the handler rather than as a route `preHandler` because the RBAC
 * source audit in the route suite requires each route's `preHandler` to be its
 * `requirePermission(...)` guard alone (or an array of only those), and a
 * malformed id answers the same 404 as
 * an unknown one: it is not a job this caller can see, whatever its shape.
 */
function isIngestJobId(id: string): boolean {
  return INGEST_JOB_ID.safeParse(id).success;
}
const INGEST_JOB_ID = z.string().uuid();

function replyImportNotFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: 'Not Found', message: 'Import not found.' });
}

/**
 * Prove the caller owns `campaignId` BEFORE master writes to its roster over S2S
 * (or, on a dry run, reads that campaign's DNC scope into a preview).
 *
 * ── Why this exists (ClickUp `14ygtkj8rvv`, found in review) ────────────────
 * The roster writes — the ingest's chunks (`sendRosterChunk`) and the
 * replace/clear supersede — go to core's `/internal/agency-campaigns/:id/…`
 * with `coreInternalRequest`, which skips core's `authMiddleware` and its
 * `requireOwned`. Core's internal contacts handler resolves the campaign by id
 * ALONE and writes under the campaign's own `tenant_id`/`account_id`; the
 * `tenant_id`/`account_id` master sends in the body are not compared to it. So a
 * `campaign_id` taken straight from the request body was the only thing naming
 * the target: an `account_admin` who knew a sibling account's campaign id — or
 * ANOTHER TENANT's — could load contacts into it, and those contacts get dialled.
 *
 * The proof is a proxied read of the campaign, the `requireOwnedCampaign` shape:
 * core's public route 404s unless the campaign's tenant AND account both match
 * the headers, so the account sent here is the one the job will be stamped with
 * — the caller's membership account first, the header only for a tenant-wide
 * caller. Unlike the activity trail's probe it FAILS CLOSED: a transport failure
 * propagates (a masked 500) rather than degrading, because the thing it
 * authorises is a write that cannot be taken back.
 *
 * Returns true when the caller may proceed; otherwise it has already replied.
 *
 * PORT NOTE (magick-agency):
 *  - The read is core's `GET /agency-campaigns/:id` handler in-process (`callCore`),
 *    for the reasons `requireOwnedCampaign` gives (core's own `gate` + `requireOwned`,
 *    core's 404 body). The roster hand-off it protects is in-process too
 *    (`agency-roster.client.ts`, lane B2), and it re-checks tenant AND account itself
 *    (`ingestCallerOwnsCampaign`), so this proof is now the first of two.
 *  - It returns the PROVEN owner's account — the campaign row's `account_id` off core's
 *    body — instead of `true`, or `null` when it has replied. Callers stamp the job and
 *    address the supersede with it (lane B2 carry-forward). A 200 without the field is a
 *    defect and is refused (500) rather than guessed.
 *  - `timeoutMs: ACTIVITY_OWNERSHIP_PROBE_TIMEOUT_MS` is deleted: it bounded the
 *    undici socket of the HTTP probe; `callCore` has none (see `requireOwnedCampaign`).
 */
async function proveCampaignOwnedForWrite(
  request: FastifyRequest,
  reply: FastifyReply,
  campaignId: string,
  accountId: string | null,
): Promise<string | null> {
  if (!accountId) {
    // Core's `requireOwned` compares the campaign's account to the account
    // header; with none there is nothing to compare, and core would 400 on the
    // missing header anyway. Refused here so the caller gets a named reason
    // rather than a masked core complaint.
    await reply.code(400).send({
      error: 'Bad Request',
      code: 'account_scope_required',
      message: 'Loading or clearing a campaign roster is scoped to one account. Send X-Account-Id.',
    });
    return null;
  }
  const result = await callCore({
    method: 'GET',
    path: `/agency-campaigns/${campaignId}`,
    tenantId: request.tenantId!,
    accountId,
    metricPath: '/agency-campaigns/:id',
  });
  if (result.status >= 400) {
    // Forwarded verbatim: a sibling account's campaign, another tenant's and a
    // nonexistent one are all core's 404, and must stay indistinguishable.
    await reply.code(result.status).send(result.body);
    return null;
  }
  const ownerAccountId = extractCampaignField(result.body, 'account_id');
  if (!ownerAccountId) {
    throw new Error('agency campaign ownership probe: core answered without the campaign\'s account_id');
  }
  return ownerAccountId;
}

/**
 * An S3 key is client-supplied here, so it must be proved to be one of this
 * tenant's UPLOADS before it is read. The tenant prefix alone is not enough:
 * without it a tenant could name another tenant's key and have the analyzer
 * read it back as sample values, and with only it an account-scoped caller
 * could name a sibling account's rejected-rows export (keyed by nothing but the
 * job id) and read that back the same way. See `agency-ingest-keys.ts`.
 */
/** Core's `authMiddleware` 400 for a request with no account (core `auth.middleware.ts:38-43`). */
function missingAccountBody(): { error: string; message: string } {
  return { error: 'Bad Request', message: `Missing required header: ${ACCOUNT_HEADER}` };
}

function isTenantOwnedKey(key: string, tenantId: string): boolean {
  return isTenantUploadKey(key, tenantId);
}

/**
 * Build a safe `Content-Disposition` filename stem from the operator's original
 * upload name.
 *
 * The name is user-supplied and round-trips back out as a header, so it is
 * sanitised rather than trusted. Replacing the disallowed characters is not
 * enough on its own: `../../etc/passwd.csv` becomes `.._.._etc_passwd`, which
 * still carries `..` into a filename some clients resolve. Dot runs are
 * collapsed and leading dots stripped, so the result cannot express a relative
 * path or a hidden file no matter what was uploaded.
 */
function downloadBaseName(fileName: string): string {
  const stem = fileName.replace(/\.csv$/i, '');
  const sanitised = stem
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^[._]+/, '');
  return sanitised.slice(0, 100) || 'import';
}

function toJobResponse(job: Awaited<ReturnType<typeof agencyIngestJobRepository.findById>>) {
  if (!job) return null;
  const bytesTotal = job.file_size_bytes ? Number(job.file_size_bytes) : null;
  const bytesRead = Number(job.bytes_read);
  const terminal = ['completed', 'failed', 'cancelled'].includes(job.status);

  return {
    job_id: job.id,
    campaign_id: job.campaign_id,
    status: job.status,
    dry_run: job.dry_run,
    // `?? 'append'` covers the pre-057 ordering window, where `SELECT *` returns
    // a row with no such key at all. Append is both the historical truth and the
    // fail-safe reading — a client must never infer "this was a replace" from an
    // absence.
    mode: job.mode ?? 'append',
    /**
     * For a replace: how many contacts were retired before this import began.
     *
     * **The number to render most prominently on a replace that did not
     * complete** — failed OR cancelled. A stopped append leaves the campaign
     * exactly as it was; a stopped replace may have already emptied it, and this
     * is the only field that distinguishes the two. Cancellation is observed
     * between chunks, i.e. always after the supersede, so a cancelled replace is
     * as likely to be sitting on an empty campaign as a failed one — the job's
     * `error_message` carries the same sentence for both.
     * `null` means the question does not apply — an append, or a replace that
     * was refused before it retired anything.
     */
    replace_superseded_contacts:
      job.replace_superseded_contacts === null || job.replace_superseded_contacts === undefined
        ? null
        : Number(job.replace_superseded_contacts),
    /**
     * Read WITH the count above; alone, neither field is the answer:
     *
     *   (N, false)    exactly N contacts were retired
     *   (NULL, false) nothing was retired — the campaign is as it was
     *   (NULL, true)  the roster MAY be gone and the count is unknown
     *
     * The third state exists because `supersedeRoster` makes up to four attempts,
     * so one can commit and a later one can be refused by core's compare-and-swap.
     * **Render the third state at least as loudly as the second** — "we could not
     * confirm" is the sentence that gets an operator to look, and the wording
     * cusui shows must not soften it into "probably fine".
     */
    replace_superseded_uncertain: Boolean(job.replace_superseded_uncertain ?? false),
    file_name: job.file_name,
    // Determinate where the file size is known, and honestly 100 only when the
    // job is actually terminal — a progress bar that sits at 100% while work
    // continues is worse than one that sits at 97%.
    progress_pct: terminal
      ? 100
      : bytesTotal && bytesTotal > 0
        ? Math.min(99, Math.floor((bytesRead / bytesTotal) * 100))
        : null,
    // accepted + rejected = rows_read, exactly. `duplicates` is a BREAKDOWN of
    // `rejected`, never a fourth addend — an operator adds these against their
    // own spreadsheet.
    rows_read: Number(job.rows_read),
    accepted: Number(job.accepted),
    rejected: Number(job.rejected),
    duplicates: Number(job.duplicates),
    rejected_by_reason: job.rejected_by_reason,
    chunks_sent: job.chunks_sent,
    headers: job.headers,
    context_columns: job.context_columns,
    has_rejected_export: Boolean(job.rejected_s3_key),
    rejected_row_count: job.rejected_row_count,
    rejected_truncated: job.rejected_truncated,
    // Independent of accepted/rejected above (migration 055): those count what
    // master decided to SEND; this counts what core's roster actually REFUSED
    // on arrival because it already held the row (a re-upload into a populated
    // campaign, not a retry). A non-zero value here means the operator's
    // `accepted` count overstates what core actually wrote — surface it
    // prominently rather than let a "5,000 accepted" summary imply success.
    //
    // `?? 0` / `?? []`, not a bare read: a row written before migration 055
    // landed (or read back during the pre-migration ordering window the
    // repository's write-path fallback tolerates — see
    // `agency-ingest-job.repository.ts`) has no key at all for either column,
    // so `job.core_rejected_duplicate_rows` is `undefined` and
    // `Number(undefined)` is `NaN` — which `JSON.stringify` silently rewrites
    // to `null` on the wire, a type the client does not expect for a field
    // documented as `number`.
    core_rejected_duplicate_rows: Number(job.core_rejected_duplicate_rows ?? 0),
    core_duplicate_source_rows: job.core_duplicate_source_rows ?? [],
    // Whether the count above is EXACT or a LOWER BOUND (migration 056). A count
    // that may be an undercount is a materially different thing to render than an
    // exact one: "core refused nothing" and "core cannot tell us what it refused"
    // are the same zero on the wire without this bit, and the first is a clean
    // import while the second means the operator should not trust the summary to
    // prove one.
    //
    /**
     * **An ABSENT column reads `true`, not `false`, and the direction is the whole
     * point of the field.**
     *
     * `?? false` was wrong here, and wrong in exactly the way migration 056
     * exists to prevent. The key is missing from a `SELECT *` only while the column
     * itself does not exist — i.e. while 056 has not been applied — and in that
     * window the repository's `42703` fallback has ALSO been unable to write the
     * count. So the row reads `{ core_rejected_duplicate_rows: 0,
     * may_undercount: false }`: "core refused nothing, exactly", stated
     * confidently about a number master never managed to record. That is a
     * confident wrong zero, which is the failure mode this pair of fields was
     * added to end.
     *
     * `?? true` is the honest reading: while the column is absent master cannot
     * vouch for the count, so it says so. Once 056 lands every row carries a real
     * boolean — historical rows get the column default `false`, which is correct
     * for them, because their counts WERE recorded by 055. The uncertainty is
     * therefore confined to the migration window rather than smeared over history.
     *
     * `Boolean(... ?? true)` rather than a bare read so the wire value is always a
     * real boolean; `undefined` would be dropped by `JSON.stringify` and leave
     * cusui with a missing field for something documented as `boolean`.
     */
    core_rejected_duplicate_rows_may_undercount: Boolean(
      job.core_rejected_duplicate_rows_may_undercount ?? true,
    ),
    error_code: job.error_code,
    error_message: job.error_message,
    created_at: job.created_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
  };
}

import { createChildLogger } from '@magick-agency/observability';
import { agencyCampaignRepository, agencyContactRepository } from '../db/repositories/agency.repository.js';
import type { AgencyCampaignRecord } from '../db/models/agency.model.js';
import type { AgencyIngestContact } from './agency-csv-ingest.js';

/*
 * PORT NOTE (magick-agency): the roster hand-off collapses (plan §1, decision B9). Master's
 * `sendRosterChunk` POSTed to core's `/internal/agency-campaigns/:id/contacts`
 * (core `src/api/routes/agency.routes.ts:1892-1962`@4850d1d9); that handler's body now runs
 * in-process here, against the same repository calls. Gone: the HTTP call, `withRetry`
 * (transport retries), the S2S token. The exported API, request/response types and error
 * classes are unchanged, so `agency-ingest.service.ts` ports unchanged. See PORTING.md,
 * "Lane B2 — roster hand-off".
 */

const log = createChildLogger({ component: 'agency-roster-client' });

/**
 * S2S client for streaming a parsed roster into core, 500 contacts per chunk
 * (design §2.2).
 *
 * ── Idempotency is the whole point of this module ──────────────────────────
 * The design omitted it; QA caught the gap. A retried chunk without it inserts
 * the contacts twice, and those duplicates then dial twice down two independent
 * attempt chains — which core's `uq_agency_attempt_live` **cannot** catch,
 * because it is unique on `contact_id` and the duplicates are two *different*
 * contact ids. The backstop that looks like it covers this does not.
 *
 * So every chunk carries a key that is stable across every retry of that chunk:
 * `{ingest_job_id}-{chunk_index}`. Core applies the chunk and records the key in
 * `agency_ingest_chunks` under a real UNIQUE, in **one transaction**, so a
 * replay is a single-row conflict rather than 500 upserts. Agreed with the core
 * owner rather than assumed; the shape below is that agreement.
 *
 * Retries are what make this necessary and are therefore deliberate, not
 * incidental: `withRetry` on a chunk is safe precisely *because* the key makes a
 * duplicate delivery a no-op. Never send a chunk without one.
 *
 * ── What this client does NOT do ───────────────────────────────────────────
 * No credit reservation. `chunked-dispatch.ts` reserves per recipient because
 * each of its chunks places calls; a roster chunk places none. Agency billing is
 * per connected call and per dial attempt, settled by core when those happen —
 * loading a contact costs nothing, and reserving here would bill a campaign that
 * is never started.
 */

/** Contacts per chunk. Matches the ingest module's batch size by construction. */
export const ROSTER_CHUNK_SIZE = 500;

export interface RosterChunkRequest {
  campaignId: string;
  tenantId: string;
  accountId?: string;
  /** Master's job id. Stable across every retry of every chunk in this ingest. */
  ingestJobId: string;
  /** 0-based. */
  chunkIndex: number;
  /** Total chunks, so core can report completeness. Omitted while unknown. */
  chunkCount?: number;
  /** Marks the last chunk; core flips `contacts_total` and reports completeness. */
  isFinal: boolean;
  contacts: AgencyIngestContact[];
}

export interface RosterChunkResponse {
  /** Contacts core inserted. 0 on a replay. */
  accepted: number;
  /** True when core had already applied this key — a no-op, not an error. */
  duplicate_chunk: boolean;
  /** Core's running roster total for the campaign. */
  total_contacts: number;
  /**
   * Rows in this chunk that core's
   * `ON CONFLICT (campaign_id, row_fingerprint) DO NOTHING` refused because the
   * roster already held that row **verbatim** — same phone, same context, same
   * timezone. **This is the field that makes `accepted` trustworthy**: without
   * it, a chunk core wrote zero rows from still reports whatever `accepted`
   * value happened to default to, and the operator sees "5,000 accepted" for an
   * import that changed nothing.
   *
   * The conflict target is CONTENT since core's migration 083, not
   * `(campaign_id, source_row_number)` — the row number is a position within one
   * file, so under the old key a second CSV's rows 2..N collided with the first
   * file's wholesale and a top-up could never land. What that changes for this
   * field is what a non-zero value *means*: no longer "this campaign is already
   * populated" but "you sent us these exact people again". A genuine top-up of
   * new people now reports zero here.
   *
   * 0 when core omits the field (an older core), and 0-meaning-**unknown** on a
   * replay of a chunk core applied before its migration 084 — read
   * `rejection_counts_unavailable` before treating a zero as "core refused
   * nothing". Never an overcount, in any of those cases.
   */
  rejected_duplicate_rows: number;
  /**
   * A capped sample of the colliding `source_row_number`s (core's own cap is 20
   * per chunk — see `MAX_REPORTED_DUPLICATE_ROWS` in core's
   * `agency.repository.ts`). A sample, not the full set, on a large campaign.
   * `[]` when core omits the field or nothing collided.
   */
  duplicate_source_rows: number[];
  /**
   * Set (and only ever `true`) by core when THIS response's
   * `rejected_duplicate_rows: 0` means **"unknown"**, not **"none"** — a replay
   * of a chunk core applied before its migration 084, whose counts were never
   * recorded and cannot be reconstructed (a row refused by
   * `uq_agency_contacts_row_fingerprint` leaves no residue to count).
   *
   * **Absence means the counts are trustworthy**, and that is the fail-safe
   * reading rather than an accident of encoding: every fresh application, and
   * every replay of a chunk applied from 084 onward, reports an exact number —
   * including an exact 0. So a core that predates the flag behaves here exactly
   * as it did before this field existed, which is why it is a separate optional
   * boolean instead of widening `rejected_duplicate_rows` to nullable.
   *
   * Left `undefined` rather than defaulted to `false` below, for the same reason
   * core sends it that way: the shapes "core said trustworthy" and "core never
   * mentioned it" must not be forced to differ, and neither must be inventable
   * by master.
   */
  rejection_counts_unavailable?: boolean;
  /** Only on the final chunk: whether every chunk index was seen. */
  roster_complete?: boolean;
  /** Only on the final chunk: indexes core never received. */
  missing_chunks?: number[];
}

/** Why master is retiring a roster. Echoed to core for its audit row. */
export type RosterSupersedeReason = 'replace' | 'clear';

export interface RosterSupersedeRequest {
  campaignId: string;
  tenantId: string;
  accountId?: string;
  /**
   * The ingest job whose rows must SURVIVE. Omitted for a clear, which retires
   * everything.
   *
   * This is the whole of the idempotency story and it is worth being precise
   * about which failure it prevents. Supersede runs BEFORE the first chunk, so
   * on the first call this job owns no rows and everything live is retired. A
   * REDELIVERY, though, can land after chunks have started arriving — a lost
   * response plus `withRetry` is exactly that shape — and an unscoped "retire
   * every live contact" would then destroy the replacement it had just loaded.
   * Scoping by the job id makes the second call a no-op over its own rows
   * instead.
   */
  ingestJobId?: string;
  /**
   * The dialable contact count the operator was shown when they asked for this.
   *
   * A compare-and-swap, and the only server-side confirmation that does real
   * work. Re-sending the campaign id, or a typed "REPLACE" string, proves
   * nothing a request already carrying the campaign id does not — but a count
   * proves the operator's picture of the roster was current. A colleague's
   * top-up between the screen and the click changes it, and that is precisely
   * the case where "retire everything" is not what anybody meant.
   *
   * Core enforces it under the campaign row lock; master cannot, because master
   * holds no contact table and any count it read would be stale by the time it
   * acted on it — the same argument the PATCH handler already makes about
   * campaign status.
   */
  expectedContactsTotal: number;
  reason: RosterSupersedeReason;
}

export interface RosterSupersedeResponse {
  /** Contacts this call retired. 0 on a redelivery that found nothing live. */
  superseded: number;
  /** Contacts left dialable — this job's own rows, or 0 for a clear. */
  retained: number;
  /** Core's post-supersede roster total for the campaign. */
  contacts_total: number;
  /** True when core found the work already done — a retry, not an error. */
  already_applied: boolean;
  /**
   * How many HTTP attempts this call took. `1` means the first one answered.
   *
   * Exposed because it is the ONLY thing that distinguishes "the roster is
   * untouched" from "the roster may already be gone", and neither core's body nor
   * its status can say which. See {@link RosterSupersedeError.attempts}.
   */
  attempts: number;
}

/**
 * Core refused, or could not be asked. Carries core's own code where it gave
 * one, so the ingest job can record something an operator can act on.
 */
export class RosterSupersedeError extends Error {
  constructor(
    message: string,
    /**
     * Core's HTTP status.
     *
     * **Named `coreStatus`, not `status`, and that is load-bearing.** Fastify's
     * error handler reads `error.status` (as well as `error.statusCode`) off any
     * thrown value and reflects it to the client — so an error carrying core's
     * 404 would answer the BROWSER 404 when the clear route lets it propagate,
     * silently bypassing the error mask and telling an operator their campaign
     * does not exist when what actually happened is that this deployment is
     * wired wrong. The route deliberately rethrows the `unsupported` case; this
     * name is what makes that rethrow mean "server fault" instead of "core's
     * status, whatever it was".
     */
    public readonly coreStatus: number,
    /**
     * `unsupported` when core does not implement the hop at all. That case is
     * separated because it is an OPERATOR-blameless deployment error — the
     * message has to say "this deployment cannot do that yet", not "your
     * campaign is busy".
     */
    public readonly code:
      | 'unsupported'
      | 'campaign_not_found'
      | 'refused'
      | 'failed',
    /** Core's machine-readable refusal reason, when it sent one. */
    public readonly coreCode?: string,
    /**
     * How many HTTP attempts were made before this error.
     *
     * ── Why an error needs an attempt count ──────────────────────────────────
     * `supersedeRoster` retries, and `withRetry` runs `attempt <= maxRetries` —
     * so `maxRetries: 3` is **four** attempts, not three. That makes the
     * following interleaving reachable, and it was reported as a clean failure:
     *
     *   1. attempt 1 retires 5,000 contacts and COMMITS;
     *   2. its response is lost (the 30s timeout fires, or the socket drops);
     *   3. attempt 2 asks again — core's compare-and-swap now sees a roster of 0
     *      against `expected_contacts_total: 5000` and answers
     *      `409 contacts_total_mismatch`;
     *   4. master reports a refusal.
     *
     * Every signal available at step 4 says "core said no". The roster is gone.
     * So `attempts > 1` is the discriminator: **after a retry, master cannot
     * claim the roster is intact for ANY final code**, because the attempt that
     * could have committed is not the one that answered. `attempts === 1` is the
     * only case where "nothing was touched" is provable.
     *
     * This is deliberately coarse in the safe direction — a 409 on attempt 2 may
     * genuinely be a colleague's concurrent top-up rather than a lost commit, and
     * that gets reported as uncertain too. Saying "check your roster" when it is
     * fine costs a page refresh; saying "nothing was touched" when it is empty
     * costs a campaign.
     */
    public readonly attempts: number = 1,
  ) {
    super(message);
    this.name = 'RosterSupersedeError';
  }
}

/**
 * Is this 404 core telling us the CAMPAIGN does not exist?
 *
 * ── Why the test is positive, not negative ──────────────────────────────────
 * Two very different things arrive as 404 here: core saying "no such campaign",
 * and *anything between us and core* saying "no such route" — Fastify's own
 * not-found handler, but also an ingress, a service mesh sidecar or a
 * misconfigured load balancer, which answer HTML or a vendor JSON envelope that
 * looks nothing like either.
 *
 * The first version of this matched Fastify's `Route POST:/… not found` string
 * and treated everything else as a campaign 404. That defaults the UNKNOWN case
 * to the operator-blaming answer: an ingress 404 became "Campaign not found",
 * which the clear route then answers to the browser as a 404 — the same
 * misleading outcome the `coreStatus` rename fixed, reached through the
 * classifier instead of through Fastify.
 *
 * So the recognition is positive and narrow: only a body that actually looks like
 * core's campaign-404 is treated as one. Everything else — HTML, an empty body, a
 * proxy envelope, 405, 501 — is `unsupported`, i.e. "this deployment cannot serve
 * the hop", which surfaces as a masked 5xx plus a full log line. Unknown 404s
 * become OUR problem to investigate rather than the operator's to misread.
 */
function isCoreCampaignNotFound(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const message = (body as { message?: unknown }).message;
  return typeof message === 'string' && /campaign\s+not\s+found/i.test(message);
}

/**
 * Retire a campaign's roster in core, so a replace or a clear can proceed.
 *
 * ── ⚠️ CORE DOES NOT IMPLEMENT THIS YET ────────────────────────────────────
 * The specification below is the request master sends; core owns the semantics.
 * Until core ships it, every call fails `unsupported` and the caller must have
 * mutated nothing. That is the gate that stops a half-built destructive path
 * from looking like it works.
 *
 *   POST /internal/agency-campaigns/:id/roster/supersede
 *   { tenant_id, account_id?, ingest_job_id?, expected_contacts_total, reason }
 *   → 200 { superseded, retained, contacts_total, already_applied }
 *   → 409 { code: 'campaign_dialing' | 'attempts_live' | 'contacts_total_mismatch' }
 *   → 404 campaign not found (body must contain "Campaign not found" — see
 *         `isCoreCampaignNotFound`; any other 404 is read as "no such route")
 *
 * ── ⚠️ WHAT CORE MUST ADD BEFORE THIS CAN WORK — THREE SCHEMA CHANGES ───────
 * Verified against core at `132a48c`. **None of these exists yet**, and the
 * ordering argument below is invalid without the first two:
 *
 * 1. **`agency_contacts.superseded_at TIMESTAMPTZ`** (nullable). There is no such
 *    column today — nothing in core's schema can express "retired". The state
 *    machine's `suppressed` + a `suppressed_reason` of `'superseded'` is the
 *    natural companion, but the timestamp is what makes the predicate in (2)
 *    writable.
 *
 * 2. **`uq_agency_contacts_row_fingerprint` must be narrowed to live rows.**
 *    Core's migration 083 creates it as
 *
 *        CREATE UNIQUE INDEX uq_agency_contacts_row_fingerprint
 *          ON agency_contacts (campaign_id, row_fingerprint)
 *          WHERE row_fingerprint IS NOT NULL;
 *
 *    — partial on the fingerprint being present, **not on the row being live**.
 *    So a SOFT supersede leaves every retired row's fingerprint in the index, and
 *    the replacement file's unchanged people collide with rows that are already
 *    retired: refused on insert, retired on the other side, gone from the
 *    campaign. That is precisely the vanishing this design claims to prevent, so
 *    the index must become `WHERE row_fingerprint IS NOT NULL AND superseded_at
 *    IS NULL`. (Nulling `row_fingerprint` at supersede time is the alternative and
 *    is worse: it destroys the only evidence of what the retired row was.)
 *
 * 3. **`agency_contacts.ingest_job_id`** (nullable `VARCHAR`). The job id lives
 *    only on `agency_ingest_chunks` today, so the `ingest_job_id IS DISTINCT FROM
 *    $2` predicate that makes this call idempotent cannot be written. Pre-column
 *    rows read NULL and are therefore always retired by a replace, which is
 *    correct — they predate the job.
 *
 * A campaign-level replace lock is also needed, so `/start` refuses a campaign
 * whose replace died half-way. Without it a partial roster is startable.
 *
 * **Retire, not delete, and the schema is why.**
 * `agency_call_attempts.contact_id` is `REFERENCES agency_contacts(id) ON DELETE
 * CASCADE` (core migration 075), and that table's own comment calls itself "the
 * agency dialer audit spine". So a true `DELETE FROM agency_contacts` takes
 * every dial, disposition and note with it. Worse, it takes REVENUE: core's
 * hourly dial-attempt billing derives its count from those rows on every read
 * (`hourlyBuckets` in core's `agency.repository.ts`; `attempt-batcher.ts` states
 * "exactly-once with no durable state in core"), over a 48-hour lookback — so
 * deleting attempts inside an unposted hour silently reduces what master is ever
 * asked to bill, leaving no residue to reconcile against.
 *
 * **Ordering: retire FIRST, then ingest — and the reverse does not work.**
 * Ingesting first and retiring afterwards looks safer (a failure would leave the
 * old roster intact) and is broken **given change (2) above**: once
 * `uq_agency_contacts_row_fingerprint` is scoped to live rows, every unchanged
 * person in the corrected file collides with their own still-live old row, is
 * refused, and then has that old row retired underneath them — they vanish from
 * the roster entirely. Retiring first is the only order in which the replacement
 * can land.
 *
 * Note this argument is *conditional on core making the index change*, not on
 * core's present schema. Under today's unconditional index NEITHER order works,
 * which is why the change is listed as a prerequisite rather than a nicety.
 *
 * The cost of that order is stated rather than hidden: a replace that dies
 * mid-file leaves a campaign with a retired roster and a partial new one. Two
 * things make that survivable — core refuses the whole operation while the
 * campaign can dial (so nothing is being called during the window), and the job
 * row records `replace_superseded_contacts` so the operator is told the number
 * instead of discovering it.
 */
export async function supersedeRoster(
  request: RosterSupersedeRequest,
): Promise<RosterSupersedeResponse> {
  /**
   * PORT NOTE (magick-agency): core @4850d1d9 does NOT implement
   * `POST /internal/agency-campaigns/:id/roster/supersede` (core `agency.routes.ts:1827` names it
   * as "future"; core's `083` header says it has no `superseded_at`, no retired state and no
   * `ingest_job_id` on a contact). In production every call here therefore reached core's
   * Fastify 404, which this function maps to `unsupported` (the 404/405/501 branch above) with
   * ONE attempt, and the ingest service fails the job `replace_unsupported` before a single
   * contact is touched. That is the behaviour ported — not an invented endpoint. When agency
   * decides what replace/clear means (the three schema changes in the header), this body is the
   * only place to build it. Stopped and reported to the lead; see PORTING.md.
   */
  log.warn(
    { campaignId: request.campaignId, reason: request.reason },
    'Agency roster supersede refused: replace/clear is not implemented',
  );
  throw new RosterSupersedeError(
    'This deployment cannot replace or clear a roster yet — the core service does not support it.',
    404,
    'unsupported',
    undefined,
    1,
  );
}

export class RosterChunkError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly chunkIndex: number,
  ) {
    super(message);
    this.name = 'RosterChunkError';
  }
}

/**
 * Build the per-chunk idempotency key.
 *
 * Exported and tested directly because its ONLY required property — identical
 * for a retry, distinct for a different chunk — is invisible at the call site.
 * Bounded to core's `VARCHAR(128)` column: a UUID plus a separator plus an
 * index is ~45 characters, so the bound is comfortable, but it is asserted
 * rather than assumed.
 */
export function rosterChunkKey(ingestJobId: string, chunkIndex: number): string {
  return `${ingestJobId}-${chunkIndex}`;
}

/**
 * Send one chunk. Retries on transport failure and 5xx; a 4xx is returned as an
 * error without retrying, because core rejecting the *shape* of a chunk will
 * reject it identically every time.
 */
export async function sendRosterChunk(request: RosterChunkRequest): Promise<RosterChunkResponse> {
  const { campaignId, chunkIndex, contacts } = request;
  const idempotencyKey = rosterChunkKey(request.ingestJobId, chunkIndex);

  const result = await applyRosterChunkInProcess(request, idempotencyKey);

  if (result.status >= 400) {
    const body = result.body as { message?: string; error?: string } | null;
    throw new RosterChunkError(
      body?.message ?? body?.error ?? `core rejected roster chunk ${chunkIndex}`,
      result.status,
      chunkIndex,
    );
  }

  const body = (result.body ?? {}) as Partial<RosterChunkResponse>;

  if (body.duplicate_chunk) {
    // Expected whenever a retry lands after core already committed. Logged at
    // info, not warn: this is the mechanism working, and alerting on it would
    // train people to ignore it.
    log.info(
      { campaignId, chunkIndex, idempotencyKey },
      'Roster chunk already applied — replay ignored',
    );
  }

  return {
    accepted: body.accepted ?? 0,
    duplicate_chunk: body.duplicate_chunk ?? false,
    total_contacts: body.total_contacts ?? 0,
    rejected_duplicate_rows: body.rejected_duplicate_rows ?? 0,
    duplicate_source_rows: body.duplicate_source_rows ?? [],
    // Spread-if-present, matching `roster_complete` below: an absent flag must
    // stay absent rather than becoming an explicit `false`, because `false` is
    // an assertion core did not make and only core can make it.
    ...(body.rejection_counts_unavailable !== undefined
      ? { rejection_counts_unavailable: body.rejection_counts_unavailable }
      : {}),
    ...(body.roster_complete !== undefined ? { roster_complete: body.roster_complete } : {}),
    ...(body.missing_chunks !== undefined ? { missing_chunks: body.missing_chunks } : {}),
  };
}

/**
 * The 404 every refusal answers — an unknown campaign and one owned by somebody else alike, so
 * the response cannot be used to learn which campaign ids exist.
 * Core `agency.routes.ts:1816-1820` (`INTERNAL_CAMPAIGN_NOT_FOUND`), verbatim.
 */
const INTERNAL_CAMPAIGN_NOT_FOUND = {
  error: 'Not Found',
  code: 'campaign_not_found',
  message: 'Campaign not found',
} as const;

/**
 * Does the caller's stated tenant/account own this campaign?
 *
 * Core `agency.routes.ts:1841-1846` `ingestCallerOwnsCampaign` — `requireOwned`'s rule applied to
 * the request's tenant/account: both must match, exactly. **Legacy `account_id = 'default'`
 * campaigns get no special case**, and a missing account is refused as malformed before this
 * runs (core's rationale, unchanged).
 */
export function ingestCallerOwnsCampaign(
  campaign: Pick<AgencyCampaignRecord, 'tenant_id' | 'account_id'>,
  caller: { tenantId: string; accountId: string },
): boolean {
  return campaign.tenant_id === caller.tenantId && campaign.account_id === caller.accountId;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Core's `POST /agency-campaigns/:id/contacts` handler (`agency.routes.ts:1892-1962`), run
 * in-process. Returns the `{ status, body }` pair the HTTP hop returned so the caller's error
 * mapping is unchanged: 400 validation, 404 unknown-or-not-yours, 200 with the chunk result.
 * A repository/DB failure is NOT mapped (core's handler let it reach Fastify as a 500, which the
 * client then retried and finally rethrew as a plain `Error`): it propagates, and the ingest
 * service's `unexpected_error` arm records it.
 */
async function applyRosterChunkInProcess(
  request: RosterChunkRequest,
  idempotencyKey: string,
): Promise<{ status: number; body: unknown }> {
  // Checked before the campaign is read, so a malformed request learns nothing about whether the
  // id exists. (core :1894-1916)
  if (!nonEmptyString(request.tenantId) || !nonEmptyString(request.accountId)) {
    return {
      status: 400,
      body: { error: 'Validation failed', message: 'tenant_id and account_id are required' },
    };
  }
  if (!request.ingestJobId || request.chunkIndex === undefined || !idempotencyKey || !Array.isArray(request.contacts)) {
    return {
      status: 400,
      body: {
        error: 'Validation failed',
        message: 'ingest_job_id, chunk_index, idempotency_key and contacts are required',
      },
    };
  }

  // PORT NOTE: a non-UUID id would be `22P02` in the repository's `$1::uuid` cast; over HTTP it
  // was a 500 only for a malformed id, which no caller sends. Refused as an unknown campaign.
  if (!UUID_RE.test(request.campaignId)) return { status: 404, body: INTERNAL_CAMPAIGN_NOT_FOUND };

  const campaign = await agencyCampaignRepository.findById(request.campaignId);
  if (!campaign) return { status: 404, body: INTERNAL_CAMPAIGN_NOT_FOUND };
  if (!ingestCallerOwnsCampaign(campaign, { tenantId: request.tenantId, accountId: request.accountId })) {
    // Same 404 as an unknown id. Logged because naming a campaign the caller does not own is
    // either a regression or a misuse — worth seeing, not worth telling the caller about.
    // Not `tenantId`/`accountId`: on every other line those name the resource's owner. (core :1921-1939)
    log.warn(
      {
        campaignId: campaign.id,
        campaignTenantId: campaign.tenant_id,
        campaignAccountId: campaign.account_id,
        callerTenantId: request.tenantId,
        callerAccountId: request.accountId,
      },
      'Roster chunk refused: caller tenant/account does not own the campaign',
    );
    return { status: 404, body: INTERNAL_CAMPAIGN_NOT_FOUND };
  }

  const result = await agencyContactRepository.applyIngestChunk({
    campaignId: campaign.id,
    tenantId: campaign.tenant_id,
    accountId: campaign.account_id,
    ingestJobId: request.ingestJobId,
    chunkIndex: request.chunkIndex,
    chunkCount: request.chunkCount ?? null,
    idempotencyKey,
    contacts: request.contacts,
  });

  // On the final chunk, tell the caller whether the roster is actually whole. A lost final chunk
  // would otherwise leave a campaign permanently un-startable with nothing to diagnose it by;
  // `missing_chunks` lets the caller re-send just the gap. (core :1953-1959)
  let extra: Record<string, unknown> = {};
  if (request.isFinal && request.chunkCount) {
    const missing = await agencyContactRepository.missingChunks(campaign.id, request.ingestJobId, request.chunkCount);
    extra = { roster_complete: missing.length === 0, missing_chunks: missing };
  }

  return { status: 200, body: { ...result, ...extra } };
}

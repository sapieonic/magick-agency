import { createChildLogger } from '@magick-agency/observability';
import { agencyCampaignRepository, agencyContactRepository } from '../db/repositories/agency.repository.js';
import type { AgencyCampaignRecord } from '../db/models/agency.model.js';
import type { AgencyIngestContact } from './agency-csv-ingest.js';

/*
 * The roster hand-off from the ingest service to the dialer's contact table. It is a
 * direct, in-process call: `sendRosterChunk` validates the chunk, checks the caller owns
 * the campaign, and applies it through `agencyContactRepository.applyIngestChunk`. There
 * is no transport, so there is no transport retry and no service token. The request and
 * response types and the error classes are the interface `agency-ingest.service.ts`
 * builds against.
 */

const log = createChildLogger({ component: 'agency-roster-client' });

/**
 * Streams a parsed roster into the campaign's contacts, 500 contacts per chunk.
 *
 * ── Idempotency is the whole point of this module ──────────────────────────
 * A chunk applied twice without it inserts the contacts twice, and those
 * duplicates then dial twice down two independent attempt chains — which
 * `uq_agency_attempt_live` **cannot** catch, because it is unique on
 * `contact_id` and the duplicates are two *different* contact ids. The backstop
 * that looks like it covers this does not.
 *
 * So every chunk carries a key that is stable for that chunk:
 * `{ingest_job_id}-{chunk_index}`. `applyIngestChunk` applies the chunk and
 * records the key in `agency_ingest_chunks` under a real UNIQUE
 * (`uq_agency_ingest_chunk`), in **one transaction**, so a replay is a single-row
 * conflict rather than 500 upserts.
 *
 * This module does not retry, but a second delivery of the same key is still a
 * no-op (`duplicate_chunk: true`) rather than a duplicate roster. Never send a
 * chunk without one.
 *
 * ── What this module does NOT do ───────────────────────────────────────────
 * No credit reservation or billing: there is none in v1 (decision S6), and a
 * roster chunk places no calls — loading a contact costs nothing.
 */

/** Contacts per chunk. Matches the ingest module's batch size by construction. */
export const ROSTER_CHUNK_SIZE = 500;

export interface RosterChunkRequest {
  campaignId: string;
  tenantId: string;
  accountId?: string;
  /** The ingest job's id. Stable for every chunk in this ingest. */
  ingestJobId: string;
  /** 0-based. */
  chunkIndex: number;
  /** Total chunks, so the final chunk can report completeness. Omitted while unknown. */
  chunkCount?: number;
  /** Marks the last chunk; the completeness check runs on it. */
  isFinal: boolean;
  contacts: AgencyIngestContact[];
}

export interface RosterChunkResponse {
  /** Contacts inserted. 0 on a replay. */
  accepted: number;
  /** True when this key had already been applied — a no-op, not an error. */
  duplicate_chunk: boolean;
  /** The campaign's running roster total. */
  total_contacts: number;
  /**
   * Rows in this chunk that
   * `ON CONFLICT (campaign_id, row_fingerprint) DO NOTHING` refused because the
   * roster already held that row **exactly** — same phone, same context, same
   * timezone. **This is the field that makes `accepted` trustworthy**: without
   * it, a chunk that wrote zero rows still reports whatever `accepted` value
   * happened to default to, and the operator sees "5,000 accepted" for an import
   * that changed nothing.
   *
   * The conflict target is CONTENT (`uq_agency_contacts_row_fingerprint`), not
   * `(campaign_id, source_row_number)` — the row number is a position within one
   * file, so keyed on it a second CSV's rows 2..N would collide with the first
   * file's wholesale and a top-up could never land. So a non-zero value means
   * "you sent these exact people again", not "this campaign is already
   * populated". A genuine top-up of new people reports zero here.
   *
   * 0 when the field is absent, and 0-meaning-**unknown** on a replay of a chunk
   * whose counts were never recorded — read `rejection_counts_unavailable` before
   * treating a zero as "nothing was refused". Never an overcount, in any of those
   * cases.
   */
  rejected_duplicate_rows: number;
  /**
   * A capped sample of the colliding `source_row_number`s (20 per chunk — see
   * `MAX_REPORTED_DUPLICATE_ROWS` in `src/db/repositories/agency.repository.ts`).
   * A sample, not the full set, on a large campaign. `[]` when the field is
   * absent or nothing collided.
   */
  duplicate_source_rows: number[];
  /**
   * Set (and only ever `true`) by `applyIngestChunk` when THIS response's
   * `rejected_duplicate_rows: 0` means **"unknown"**, not **"none"** — a replay
   * of a chunk whose counts were never recorded (`agency_ingest_chunks`
   * `rejected_duplicate_rows IS NULL`) and cannot be reconstructed (a row refused
   * by `uq_agency_contacts_row_fingerprint` leaves no residue to count).
   *
   * **Absence means the counts are trustworthy**, and that is the fail-safe
   * reading rather than an accident of encoding: every fresh application, and
   * every replay of a chunk whose counts were recorded, reports an exact number —
   * including an exact 0. That is why it is a separate optional boolean instead
   * of widening `rejected_duplicate_rows` to nullable.
   *
   * Left `undefined` rather than defaulted to `false` below, for the same reason
   * the repository sets it that way: the shapes "said trustworthy" and "never
   * mentioned it" must not be forced to differ, and neither must be invented by
   * this module.
   */
  rejection_counts_unavailable?: boolean;
  /** Only on the final chunk: whether every chunk index was seen. */
  roster_complete?: boolean;
  /** Only on the final chunk: indexes never received. */
  missing_chunks?: number[];
}

/** Why a roster is being retired. Recorded on the audit row. */
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
   * response followed by a retry is exactly that shape — and an unscoped "retire
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
   * It has to be enforced under the campaign row lock, in the same transaction
   * as the retire: any count read earlier would be stale by the time it was
   * acted on — the same argument the PATCH handler already makes about campaign
   * status.
   */
  expectedContactsTotal: number;
  reason: RosterSupersedeReason;
}

export interface RosterSupersedeResponse {
  /** Contacts this call retired. 0 on a redelivery that found nothing live. */
  superseded: number;
  /** Contacts left dialable — this job's own rows, or 0 for a clear. */
  retained: number;
  /** The campaign's post-supersede roster total. */
  contacts_total: number;
  /** True when the work was found already done — a retry, not an error. */
  already_applied: boolean;
  /**
   * How many attempts this call took. `1` means the first one answered.
   *
   * Exposed because it is the ONLY thing that distinguishes "the roster is
   * untouched" from "the roster may already be gone", and neither the result body
   * nor its status can say which. See {@link RosterSupersedeError.attempts}.
   */
  attempts: number;
}

/**
 * The supersede was refused, or could not be performed. Carries the refusal's
 * own code where there is one, so the ingest job can record something an
 * operator can act on.
 */
export class RosterSupersedeError extends Error {
  constructor(
    message: string,
    /**
     * The refusal's HTTP-style status (404 for `unsupported` today).
     *
     * **Named `coreStatus`, not `status`, and that is load-bearing.** Fastify's
     * error handler reads `error.status` (as well as `error.statusCode`) off any
     * thrown value and reflects it to the client — so an error carrying a 404
     * would answer the BROWSER 404 when the clear route lets it propagate,
     * silently bypassing the error mask and telling an operator their campaign
     * does not exist when what actually happened is that this deployment cannot
     * do the operation. The route deliberately rethrows the `unsupported` case;
     * this name is what makes that rethrow mean "server fault" instead of "this
     * status, whatever it was".
     */
    public readonly coreStatus: number,
    /**
     * `unsupported` when the operation is not implemented at all — the only code
     * thrown today (decision B15). That case is separated because it is an
     * OPERATOR-blameless deployment gap — the message has to say "this deployment
     * cannot do that yet", not "your campaign is busy".
     */
    public readonly code:
      | 'unsupported'
      | 'campaign_not_found'
      | 'refused'
      | 'failed',
    /** The machine-readable refusal reason, when there is one. */
    public readonly coreCode?: string,
    /**
     * How many attempts were made before this error. Always `1` today:
     * `supersedeRoster` refuses on its first attempt.
     *
     * ── Why an error needs an attempt count ──────────────────────────────────
     * An implementation that retries makes this interleaving reachable, and it
     * reads as a clean failure:
     *
     *   1. attempt 1 retires 5,000 contacts and COMMITS;
     *   2. its result is lost before the caller sees it;
     *   3. attempt 2 asks again — the compare-and-swap now sees a roster of 0
     *      against `expected_contacts_total: 5000` and answers
     *      `409 contacts_total_mismatch`;
     *   4. the caller reports a refusal.
     *
     * Every signal available at step 4 says "refused". The roster is gone.
     * So `attempts > 1` is the discriminator: **after a retry, the caller cannot
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
 * Does this 404 body say the CAMPAIGN does not exist?
 *
 * Not called anywhere in `src/` today: `supersedeRoster` refuses without
 * consulting anything.
 *
 * ── Why the test is positive, not negative ──────────────────────────────────
 * A 404 can mean "no such campaign" or "no such route", and only the first may
 * be reported to an operator as "Campaign not found" — the clear route answers
 * that to the browser as a 404. Defaulting the UNKNOWN case to the
 * operator-blaming answer is the same misleading outcome the `coreStatus` name
 * guards against, reached through a classifier instead of through Fastify.
 *
 * So the recognition is positive and narrow: only a body that actually looks like
 * the campaign-404 is treated as one. Everything else — HTML, an empty body, a
 * vendor envelope, 405, 501 — is `unsupported`, i.e. "this deployment cannot do
 * that", which surfaces as a masked 5xx plus a full log line. Unknown 404s become
 * OUR problem to investigate rather than the operator's to misread.
 */
function isCoreCampaignNotFound(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const message = (body as { message?: unknown }).message;
  return typeof message === 'string' && /campaign\s+not\s+found/i.test(message);
}

/**
 * Retire a campaign's roster, so a replace or a clear can proceed.
 *
 * ── ⚠️ NOT IMPLEMENTED (decision B15) ──────────────────────────────────────
 * Every call refuses `unsupported` with one attempt and touches nothing; the
 * ingest service then fails the job `replace_unsupported`, and
 * `POST /campaigns/:id/roster/clear` refuses. That is the gate that stops a
 * half-built destructive path from looking like it works. What an
 * implementation has to provide:
 *
 *   input  { campaignId, tenantId, accountId?, ingestJobId?, expectedContactsTotal, reason }
 *   result { superseded, retained, contacts_total, already_applied }
 *   refuse `campaign_dialing` | `attempts_live` | `contacts_total_mismatch`,
 *          or `campaign_not_found`
 *
 * ── ⚠️ WHAT THE SCHEMA NEEDS BEFORE THIS CAN WORK — THREE CHANGES ──────────
 * **None of these exists in `0001_baseline.sql`**, and the ordering argument
 * below is invalid without the first two:
 *
 * 1. **`agency_contacts.superseded_at TIMESTAMPTZ`** (nullable). There is no such
 *    column today — nothing in the schema can express "retired". The state
 *    machine's `suppressed` + a `suppressed_reason` of `'superseded'` is the
 *    natural companion, but the timestamp is what makes the predicate in (2)
 *    writable.
 *
 * 2. **`uq_agency_contacts_row_fingerprint` must be narrowed to live rows.**
 *    The baseline creates it as
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
 * CASCADE`, and that table's own comment calls itself "the agency dialer audit
 * spine". So a true `DELETE FROM agency_contacts` takes every dial, disposition
 * and note with it, and every count derived from those rows changes underneath
 * whoever reads it next.
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
 * Note this argument is *conditional on the index change*, not on the present
 * schema. Under today's unconditional index NEITHER order works, which is why the
 * change is listed as a prerequisite rather than a nicety.
 *
 * The cost of that order is stated rather than hidden: a replace that dies
 * mid-file leaves a campaign with a retired roster and a partial new one. Two
 * things make that survivable — the supersede refuses the whole operation while
 * the campaign can dial (so nothing is being called during the window), and the
 * job row records `replace_superseded_contacts` so the operator is told the number
 * instead of discovering it.
 */
export async function supersedeRoster(
  request: RosterSupersedeRequest,
): Promise<RosterSupersedeResponse> {
  /**
   * Refused, always (decision B15): the schema has no `superseded_at`, no retired
   * contact state and no `ingest_job_id` on a contact. The refusal is
   * `unsupported` with ONE attempt, so the ingest service fails the job
   * `replace_unsupported` before a single contact is touched. When replace/clear
   * is designed (the three schema changes in the header), this body is the only
   * place to build it.
   */
  log.warn(
    { campaignId: request.campaignId, reason: request.reason },
    'Agency roster supersede refused: replace/clear is not implemented',
  );
  throw new RosterSupersedeError(
    'This deployment cannot replace or clear a roster yet — the dialer runtime does not support it.',
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
 * for a redelivery, distinct for a different chunk — is invisible at the call
 * site. Bounded to `agency_ingest_chunks.idempotency_key VARCHAR(128)`: a UUID
 * plus a separator plus an index is ~45 characters, so the bound is
 * comfortable, but it is asserted rather than assumed.
 */
export function rosterChunkKey(ingestJobId: string, chunkIndex: number): string {
  return `${ingestJobId}-${chunkIndex}`;
}

/**
 * Apply one chunk, in-process and once. A 4xx (a malformed chunk, or a campaign
 * the caller does not own) is thrown as a {@link RosterChunkError}; a
 * repository failure propagates as thrown.
 */
export async function sendRosterChunk(request: RosterChunkRequest): Promise<RosterChunkResponse> {
  const { campaignId, chunkIndex, contacts } = request;
  const idempotencyKey = rosterChunkKey(request.ingestJobId, chunkIndex);

  const result = await applyRosterChunkInProcess(request, idempotencyKey);

  if (result.status >= 400) {
    const body = result.body as { message?: string; error?: string } | null;
    throw new RosterChunkError(
      body?.message ?? body?.error ?? `the dialer runtime rejected roster chunk ${chunkIndex}`,
      result.status,
      chunkIndex,
    );
  }

  const body = (result.body ?? {}) as Partial<RosterChunkResponse>;

  if (body.duplicate_chunk) {
    // Expected whenever a chunk is delivered again after it committed. Logged at
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
    // an assertion the repository did not make and only it can make.
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
 */
const INTERNAL_CAMPAIGN_NOT_FOUND = {
  error: 'Not Found',
  code: 'campaign_not_found',
  message: 'Campaign not found',
} as const;

/**
 * Does the caller's stated tenant/account own this campaign?
 *
 * The internal handler's `requireOwned` rule applied to the request's tenant/account: both
 * must match, exactly. No campaign gets a special case, and a missing account is refused as
 * malformed before this runs.
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
 * Validate and apply one roster chunk. Returns a `{ status, body }` pair so
 * {@link sendRosterChunk}'s error mapping reads like a handler response: 400 validation, 404
 * unknown-or-not-yours, 200 with the chunk result. A repository/DB failure is NOT mapped: it
 * propagates, and the ingest service's `unexpected_error` arm records it.
 */
async function applyRosterChunkInProcess(
  request: RosterChunkRequest,
  idempotencyKey: string,
): Promise<{ status: number; body: unknown }> {
  // Checked before the campaign is read, so a malformed request learns nothing about whether the
  // id exists.
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

  // A non-UUID id would be `22P02` in the repository's `$1::uuid` cast, which nothing maps to a
  // status. No caller sends one; it is refused as an unknown campaign.
  if (!UUID_RE.test(request.campaignId)) return { status: 404, body: INTERNAL_CAMPAIGN_NOT_FOUND };

  const campaign = await agencyCampaignRepository.findById(request.campaignId);
  if (!campaign) return { status: 404, body: INTERNAL_CAMPAIGN_NOT_FOUND };
  if (!ingestCallerOwnsCampaign(campaign, { tenantId: request.tenantId, accountId: request.accountId })) {
    // Same 404 as an unknown id. Logged because naming a campaign the caller does not own is
    // either a regression or a misuse — worth seeing, not worth telling the caller about.
    // Not `tenantId`/`accountId`: on every other line those name the resource's owner.
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
  // `missing_chunks` lets the caller re-send just the gap.
  let extra: Record<string, unknown> = {};
  if (request.isFinal && request.chunkCount) {
    const missing = await agencyContactRepository.missingChunks(campaign.id, request.ingestJobId, request.chunkCount);
    extra = { roster_complete: missing.length === 0, missing_chunks: missing };
  }

  return { status: 200, body: { ...result, ...extra } };
}

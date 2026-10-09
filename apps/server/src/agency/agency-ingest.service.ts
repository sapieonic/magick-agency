import { getFileStream, headFile, uploadFile } from '../storage/s3.js';
import { createChildLogger } from '@magick-agency/observability';
import {
  ingestAgencyCsv,
  AgencyIngestError,
  AGENCY_INGEST_BATCH_SIZE,
  rejectionLabel,
  type AgencyIngestContact,
  type AgencyIngestRejection,
  type AgencyIngestSummary,
} from './agency-csv-ingest.js';
import { dncService, DncUnavailableError } from '../dnc/dnc.service.js';
import { rejectedCsvHeader, rejectedCsvRow } from './agency-rejected-csv.js';
import {
  sendRosterChunk,
  supersedeRoster,
  RosterChunkError,
  RosterSupersedeError,
} from './agency-roster.client.js';
import {
  agencyIngestJobRepository,
  type AgencyIngestJobFailureCode,
  type AgencyIngestJobRecord,
  type IngestProgress,
} from './agency-ingest-job.repository.js';

import { rejectedExportKey } from './agency-ingest-keys.js';

const log = createChildLogger({ component: 'agency-ingest-service' });

/**
 * How many colliding `source_row_number`s reported by the roster hand-off to
 * retain across the whole ingest for the job row. Mirrors the repository's own
 * per-chunk cap (`MAX_REPORTED_DUPLICATE_ROWS` in `agency.repository.ts`) — enough for an
 * operator to recognise the pattern without an unbounded array on a
 * million-row re-upload where every chunk collides.
 */
const MAX_CORE_DUPLICATE_SAMPLE = 20;

/**
 * Runs a roster ingest: S3 object → streaming parse → chunked hand-off to the
 * dialer's contact table (`sendRosterChunk`) → rejected-rows export, with
 * progress written to the job row throughout.
 *
 * ── Why this is a job and not a request ────────────────────────────────────
 * A 1M-row file takes minutes, so the ingest is its own job with its own
 * progress, not a synchronous request, and the upload wizard needs a pollable
 * status with a determinate progress bar. So the
 * route starts this and returns immediately; everything below runs detached.
 *
 * ── Progress is written on a byte budget, not per batch ────────────────────
 * A 1M-row file is 2,000 chunks. Writing the job row per chunk is 2,000 UPDATEs
 * to a row nobody reads more than once a second, and it puts a database
 * round-trip inside the hot loop that is supposed to be streaming. Progress is
 * therefore flushed at most every `PROGRESS_INTERVAL_MS`, plus once at the end.
 */

/** How often progress is flushed to the job row while streaming. */
const PROGRESS_INTERVAL_MS = 1_000;

/**
 * Rows retained for the rejected-rows export.
 *
 * The export has to be a single S3 `PutObject` because `@aws-sdk/lib-storage`
 * (multipart streaming upload) is not a dependency of this service, and adding
 * one to this change is more surface than it earns. So the document is bounded
 * in memory and the job records `rejected_truncated` when it fills — which is
 * surfaced rather than silently short, because an operator fixing a file from a
 * truncated export would re-upload a file that still fails. 50k rows is roughly
 * a 10MB CSV; past that the file has a systemic problem the operator should be
 * told about instead of handed a million rows.
 */
const MAX_EXPORT_ROWS = 50_000;

export interface StartIngestOptions {
  job: AgencyIngestJobRecord;
  /** Resolved once by the caller; a dry run does not need it. */
  campaignId?: string;
  /**
   * The roster size the operator was looking at when they asked for a replace,
   * passed to the supersede as a compare-and-swap. Required by the route for
   * `mode: 'replace'`; meaningless otherwise.
   *
   * Deliberately NOT a column on the job row. It is an assertion about the
   * instant the operator clicked, and it is consumed once, before the first
   * chunk — persisting it would invite a future "resume this job" path to
   * re-assert a count that is by then years stale.
   */
  expectedContactsTotal?: number;
}

export class AgencyIngestService {
  /**
   * Execute an ingest to completion. Resolves when the job reaches a terminal
   * state; it never rejects, because every failure path is recorded on the job
   * row — a detached promise that throws is an unhandled rejection and, worse,
   * a job stuck in `running` forever.
   */
  async run(options: StartIngestOptions): Promise<void> {
    const { job } = options;
    const campaignId = options.campaignId ?? job.campaign_id ?? undefined;

    if (!job.dry_run && !campaignId) {
      await agencyIngestJobRepository.fail(
        job.id,
        'no_campaign',
        'A real import needs a campaign; only a dry run may omit one.',
      );
      return;
    }

    const progress: IngestProgress = {
      rows_read: 0,
      accepted: 0,
      rejected: 0,
      duplicates: 0,
      bytes_read: 0,
      chunks_sent: 0,
      // Exact, EXCEPT when the flag below says it is a lower bound — see the
      // field's docstring on `IngestProgress` (`agency-ingest-job.repository.ts`)
      // for when it is a lower bound.
      core_rejected_duplicate_rows: 0,
      // Skewed toward the earliest chunks once the cap is hit — see the same
      // docstring's note on `core_duplicate_source_rows`.
      core_duplicate_source_rows: [],
      // Starts false and is only ever raised by a chunk response that says so.
      core_rejected_duplicate_rows_may_undercount: false,
    };

    /**
     * Fold one chunk's reported duplicate signal into the running totals
     * on `progress` directly — not a separate outer variable — so both fields
     * ride the same `updateProgress()` heartbeat and survive a cancel/fail
     * together (see `updateProgress`'s docstring for why that matters: if only
     * `complete()` received the sample, a job that never reached `complete()` would
     * report a non-zero count with an empty examples list).
     *
     * `sendRosterChunk`'s return value is captured at both call sites because its
     * `rejected_duplicate_rows`/`duplicate_source_rows` are the only signal that a
     * chunk reported "accepted" actually wrote zero rows.
     */
    const foldCoreChunkResult = (chunk: {
      rejected_duplicate_rows?: number;
      duplicate_source_rows?: number[];
      rejection_counts_unavailable?: boolean;
    }): void => {
      progress.core_rejected_duplicate_rows += chunk.rejected_duplicate_rows ?? 0;
      for (const row of chunk.duplicate_source_rows ?? []) {
        if (progress.core_duplicate_source_rows.length >= MAX_CORE_DUPLICATE_SAMPLE) break;
        progress.core_duplicate_source_rows.push(row);
      }
      // Sticky, and OR'd rather than assigned: this qualifies the running total
      // for the whole job, so one chunk that could not report what it refused
      // makes the total a lower bound permanently. Assigning would let the next
      // clean chunk clear it, and the summary would then describe the last
      // chunk rather than the import.
      if (chunk.rejection_counts_unavailable) {
        progress.core_rejected_duplicate_rows_may_undercount = true;
      }
    };

    // Rejections are RETAINED, not rendered, while streaming — the column set
    // they must be rendered against (`context_columns`) is only resolved once
    // the header row has been read and the operator's `Ignore` list applied,
    // and rendering early would emit a document whose columns do not match its
    // own header. Bounded — see MAX_EXPORT_ROWS.
    const retainedRejections: AgencyIngestRejection[] = [];
    let exportTruncated = false;

    let lastProgressFlush = 0;
    let cancelled = false;
    let chunkIndex = 0;
    /**
     * What happened to the campaign's existing roster, as three states rather
     * than a nullable number.
     *
     * `unknown` is the state that matters and the one a `number | null` could not
     * express: a supersede whose work is done but whose count this side never
     * learned — `already_applied: true`, or a retried supersede whose committed
     * attempt lost its answer while a later attempt was refused. `supersedeRoster`
     * today makes one attempt and always refuses (decision B15); these states are
     * the contract a real supersede has to report against.
     */
    type RosterRetirement =
      | { state: 'none' }
      | { state: 'retired'; count: number }
      | { state: 'unknown' };
    let retirement: RosterRetirement = { state: 'none' };

    /**
     * What became of the roster the campaign already had, as a sentence.
     *
     * Shared by every terminal path that can be reached after the supersede, and
     * shared deliberately: the fact is a property of the RUN, not of how the run
     * ended, so a cancel and a failure must not be able to disagree about it. It
     * takes `stoppedBy` only because the same sentence has to name what stopped
     * the import — "before the failure" on a failed job would be wrong on a job
     * the operator cancelled themselves.
     *
     * `''` for `state: 'none'`: bolting the warning onto every outcome would
     * train operators to ignore it, which is the one way to lose the mitigation
     * while keeping the code.
     */
    const retirementNote = (stoppedBy: string): string => {
      if (retirement.state === 'retired') {
        return ` Your previous ${retirement.count.toLocaleString()} contacts were already retired for this replacement, so this campaign now holds only the rows that landed before ${stoppedBy}. It cannot be started until you import a roster again.`;
      }
      if (retirement.state === 'unknown') {
        // Hedged on purpose. Saying "check your roster" when it is fine costs a
        // page refresh; saying "nothing was touched" when it is empty costs a
        // campaign.
        return ' An earlier attempt to retire this campaign\'s existing contacts could not be confirmed, so they may already have been removed. Check the campaign\'s contact count before starting it or importing again.';
      }
      return '';
    };

    /**
     * Record a terminal failure, telling the operator the truth about their
     * roster rather than only the truth about this import.
     *
     * A replace that dies after the supersede is the one genuinely dangerous
     * state this feature creates, and the whole mitigation is that the operator is
     * told. Silence leaves them believing they still have this morning's roster;
     * so does a confident "nothing was touched" on a path that cannot prove it.
     */
    const failJob = async (
      code: AgencyIngestJobFailureCode,
      message: string,
    ): Promise<void> => {
      await agencyIngestJobRepository.fail(job.id, code, `${message}${retirementNote('the failure')}`);
    };
    /**
     * Rows dropped for being on the DNC list.
     *
     * Counted separately because the CSV module cannot see them — it has no
     * database — so its `summary.accepted`/`rejected` include them as accepted,
     * and the totals below have to move them across. Migration 053's asserted
     * invariant (`accepted + rejected = rows_read`, `duplicates` a breakdown
     * rather than a fourth addend) holds either way; a third addend would have
     * broken an operator's reconciliation against their own spreadsheet.
     */
    let dncSuppressed = 0;

    /**
     * Drop the DNC-listed contacts from a batch and record each as a rejection.
     *
     * **Fail-closed: this can throw, and the ingest must die rather than send an
     * unchecked batch.** `filterSuppressed` throws when the list cannot be read,
     * which is the whole point — an empty result would be a well-formed "none of
     * these are suppressed" and every one of them would be dialed.
     */
    const dropSuppressed = async (
      contacts: AgencyIngestContact[],
    ): Promise<AgencyIngestContact[]> => {
      if (contacts.length === 0) return contacts;

      const suppressed = await dncService.filterSuppressed(
        {
          tenantId: job.tenant_id,
          accountId: job.account_id,
          // Campaign-scoped rows must be caught here as well as at dial time, so the
          // campaign is part of the lookup.
          campaignId: campaignId ?? null,
        },
        contacts.map((c) => c.phone_e164),
      );
      if (suppressed.size === 0) return contacts;

      const kept: AgencyIngestContact[] = [];
      for (const contact of contacts) {
        if (!suppressed.has(contact.phone_e164)) {
          kept.push(contact);
          continue;
        }

        dncSuppressed += 1;
        // Retained for the export like any other rejection: the operator needs to
        // reconcile 10,000 uploaded rows against 9,957 dialable ones, and "43 on
        // your Do Not Call list" is the only answer that does not look like a bug.
        if (retainedRejections.length < MAX_EXPORT_ROWS) {
          retainedRejections.push({
            row_number: contact.source_row_number,
            column: job.phone_column,
            raw_value: contact.phone_e164,
            reason_code: 'dnc_suppressed',
            reason: rejectionLabel('dnc_suppressed'),
            context: contact.context,
          });
        } else {
          exportTruncated = true;
        }
      }
      return kept;
    };

    const flushProgress = async (force = false): Promise<void> => {
      const now = Date.now();
      if (!force && now - lastProgressFlush < PROGRESS_INTERVAL_MS) return;
      lastProgressFlush = now;
      await agencyIngestJobRepository.updateProgress(job.id, { ...progress });
    };

    try {
      /**
       * ── REPLACE: retire the old roster before a single new row is sent ─────
       *
       * Ordering is forced, not chosen.
       * `uq_agency_contacts_row_fingerprint` is unique over LIVE rows, so
       * ingesting first and retiring afterwards would have every UNCHANGED
       * person in the corrected file collide with their own still-live old row,
       * be refused, and then have that old row retired underneath them — they
       * would disappear from the campaign entirely. See `supersedeRoster`.
       *
       * What is NOT forced is doing it before the file has been proved to exist:
       * with `supersedeRoster` ahead of any read of the file, a mistyped key or a
       * lifecycle-expired object would retire the campaign and only then fail the
       * import — an emptied roster for a file that could never have been read.
       *
       * So the cheap check runs first as a HEAD, and the ordering constraint
       * above survives intact because a HEAD sends no chunk. It is deliberately
       * not `getFileStream`: opening the body here would leave a live S3 response
       * unread across a supersede that may take a long time, and S3 or
       * any intermediary is free to close it — trading a survivable "file
       * missing" for a torn stream *after* the destructive step. The residual
       * race (the object disappearing between the HEAD and the open) is a
       * millisecond window on a key nothing else writes, against a certainty
       * today.
       *
       * A dry run never reaches here — a preview that retires a roster is a
       * contradiction, and the route refuses the combination outright so this is
       * a second line of defence rather than the only one.
       */
      if (!job.dry_run && job.mode === 'replace') {
        // Probe only, and only on this path: the size still comes from the open
        // below, which is the read that actually feeds the parser, and an append
        // keeps exactly the round trips it had.
        await headFile(job.s3_key);

        const superseded = await supersedeRoster({
          campaignId: campaignId!,
          tenantId: job.tenant_id,
          ...(job.account_id ? { accountId: job.account_id } : {}),
          // Scoped to THIS job so a redelivery cannot retire the replacement it
          // has already started loading.
          ingestJobId: job.id,
          expectedContactsTotal: options.expectedContactsTotal ?? 0,
          reason: 'replace',
        });
        /**
         * Recorded immediately, not at completion: from this moment the campaign
         * has no dialable roster of its own, and a process killed on the next line
         * must still leave the truth where the operator can see it.
         *
         * `already_applied` is NOT a count of zero. It means the supersede found the
         * work already done — by a previous run, or by an attempt of this one whose
         * response was lost — so the roster is retired and this side does not know by
         * how much. `recordReplaceSuperseded(job.id, 0)` here would be wrong: a job
         * that retired 5,000 contacts would render `0`, and the failure message would
         * go on to say "your previous 0 contacts were already retired".
         */
        if (superseded.already_applied) {
          retirement = { state: 'unknown' };
          await agencyIngestJobRepository.recordReplaceUncertain(job.id);
        } else {
          retirement = { state: 'retired', count: superseded.superseded };
          await agencyIngestJobRepository.recordReplaceSuperseded(job.id, superseded.superseded);
        }
        log.info(
          {
            jobId: job.id,
            campaignId,
            superseded: superseded.superseded,
            alreadyApplied: superseded.already_applied,
            attempts: superseded.attempts,
          },
          'Retired the existing roster ahead of a replace import',
        );
      }

      // The object is opened first so its `ContentLength` can be recorded with the
      // running state — S3 is the trusted source for the size, and it is what turns
      // the wizard's progress bar from indeterminate into bytes-read-over-total.
      const { body, contentLength } = await getFileStream(job.s3_key);

      await agencyIngestJobRepository.markRunning(job.id, null, contentLength);

      const summary: AgencyIngestSummary = await ingestAgencyCsv({
        source: body,
        phoneColumn: job.phone_column,
        ...(job.timezone_column ? { timezoneColumn: job.timezone_column } : {}),
        ignoreColumns: job.ignore_columns ?? [],
        ...(job.default_country_code ? { defaultCountryCode: job.default_country_code } : {}),
        dedupePhones: job.dedupe_phones,
        batchSize: AGENCY_INGEST_BATCH_SIZE,

        onBatch: async (contacts, streamProgress) => {
          progress.rows_read = streamProgress.rows_read;
          progress.bytes_read = streamProgress.bytes_read;

          // BEFORE the accepted counter and before anything is sent. One query
          // per batch, served by `idx_dnc_entries_tenant_phone` — the plain index
          // the DNC design requires precisely because the COALESCE unique index cannot
          // answer a per-number lookup.
          const dialable = await dropSuppressed(contacts);
          progress.accepted += dialable.length;
          progress.rejected += contacts.length - dialable.length;

          // Cancellation is checked BETWEEN chunks, never mid-chunk: a chunk
          // already in flight must be allowed to finish or its idempotency key
          // is left in a state neither side can reason about.
          //
          // **Ahead of both early returns below**, so that every batch boundary
          // observes the flag. Behind them, a dry run — and any run whose batches
          // were entirely DNC-suppressed — never reached this check at all: cancel
          // answered 202 while a million-row dry run carried on to completion, with
          // nothing the operator could do about it.
          if (await agencyIngestJobRepository.isCancelRequested(job.id)) {
            cancelled = true;
            // Throwing is how a `for await` consumer stops a stream it does not
            // own; the sentinel is caught below and mapped to `cancelled`.
            throw new IngestCancelled();
          }

          // A dry run does everything except hand the roster over, so the wizard
          // can report "95% of your rows are valid" before the operator
          // commits to a campaign. It DOES check DNC — a dry run that omitted the
          // check would promise a dialable count the real import cannot deliver.
          if (job.dry_run) {
            await flushProgress();
            return;
          }

          // Every row in the batch was suppressed. Sending an empty chunk would
          // burn a chunk index for nothing and make the hand-off's completeness check
          // count a chunk that carried no contacts.
          if (dialable.length === 0) {
            await flushProgress();
            return;
          }

          const chunkResult = await sendRosterChunk({
            campaignId: campaignId!,
            tenantId: job.tenant_id,
            ...(job.account_id ? { accountId: job.account_id } : {}),
            ingestJobId: job.id,
            chunkIndex,
            isFinal: false,
            contacts: dialable,
          });
          foldCoreChunkResult(chunkResult);

          chunkIndex += 1;
          progress.chunks_sent = chunkIndex;
          await flushProgress();
        },

        onRejected: async (rejection: AgencyIngestRejection) => {
          progress.rejected += 1;
          if (rejection.reason_code === 'duplicate_phone') progress.duplicates += 1;

          if (retainedRejections.length < MAX_EXPORT_ROWS) {
            retainedRejections.push(rejection);
          } else {
            exportTruncated = true;
          }
        },
      });

      progress.rows_read = summary.rows_read;
      progress.bytes_read = summary.bytes_read;
      // The CSV module counted every DNC-listed row as accepted — it cannot see
      // the list. Move them across rather than adding a third addend, so
      // `accepted + rejected = rows_read` still holds exactly.
      progress.accepted = summary.accepted - dncSuppressed;
      progress.rejected = summary.rejected + dncSuppressed;
      progress.duplicates = summary.duplicates;

      // Final chunk: an empty terminator when the row count divided evenly, so
      // the hand-off always gets an `is_final` marker and can report completeness.
      if (!job.dry_run) {
        const final = await sendRosterChunk({
          campaignId: campaignId!,
          tenantId: job.tenant_id,
          ...(job.account_id ? { accountId: job.account_id } : {}),
          ingestJobId: job.id,
          chunkIndex,
          chunkCount: chunkIndex,
          isFinal: true,
          contacts: [],
        });
        foldCoreChunkResult(final);
        progress.chunks_sent = chunkIndex;

        if (final.roster_complete === false) {
          // The hand-off saw a gap. Failing loudly beats a campaign that silently
          // dials a partial list.
          await failJob(
            'roster_incomplete',
            `Core is missing chunks ${(final.missing_chunks ?? []).join(', ')}. The import did not complete; upload the file again.`,
          );
          return;
        }
      }

      // Render the export only now: the phone column's resolved header (which
      // may have been de-duplicated) and `context_columns` (minus the ignored
      // ones) are both known, so the document's rows and header agree.
      const resolvedPhoneHeader =
        summary.headers.find(
          (h) => h.trim().toLowerCase() === job.phone_column.trim().toLowerCase(),
        ) ?? job.phone_column;

      /**
       * Best-effort, because the campaign already has the roster.
       *
       * By this point `sendRosterChunk` has applied `is_final: true` and reported
       * the roster complete — the campaign is dialable. An S3 failure while
       * rendering the rejected-rows CSV falling through to the catch below would
       * record the job `failed`/`unexpected_error`, which tells the operator their
       * import did not happen. They would re-upload, and the campaign would
       * takes those contacts twice: duplicate dials to real people, from a
       * failure that cost nothing but a diagnostic download.
       *
       * The export is a convenience artefact. Losing it degrades the summary; it
       * does not undo the import, and must not be reported as though it did.
       */
      let rejectedKey: string | null = null;
      try {
        rejectedKey = await this.writeRejectedExport(
          job,
          resolvedPhoneHeader,
          summary.context_columns,
          retainedRejections,
        );
      } catch (err) {
        log.error(
          { err, jobId: job.id, campaignId },
          'Could not write the rejected-rows export — completing the job anyway, the roster is already with core',
        );
      }

      await agencyIngestJobRepository.complete(job.id, {
        progress,
        rejected_by_reason: {
          ...summary.rejected_by_reason,
          // Only when there were any: a `dnc_suppressed: 0` key would render as a
          // zero row in the wizard's rejection breakdown on every clean import.
          ...(dncSuppressed > 0 ? { dnc_suppressed: dncSuppressed } : {}),
        },
        headers: summary.headers,
        context_columns: summary.context_columns,
        rejected_s3_key: rejectedKey,
        rejected_row_count: retainedRejections.length,
        rejected_truncated: exportTruncated,
      });

      log.info(
        {
          jobId: job.id,
          campaignId,
          dryRun: job.dry_run,
          accepted: progress.accepted,
          rejected: progress.rejected,
          duplicates: progress.duplicates,
          dncSuppressed,
          coreRejectedDuplicateRows: progress.core_rejected_duplicate_rows,
          // Logged so a support question about a summary that "doesn't add up"
          // can be answered from the log line alone, without the job row.
          coreRejectedDuplicateRowsMayUndercount:
            progress.core_rejected_duplicate_rows_may_undercount,
        },
        'Agency roster ingest complete',
      );
    } catch (err) {
      if (cancelled || err instanceof IngestCancelled) {
        /**
         * A cancel is not a failure, but on a replace it is not innocent either.
         *
         * Cancellation is only observed in `onBatch`, which runs after the
         * supersede — so a cancelled replace leaves an EMPTY campaign, and
         * `markCancelled` alone wrote `status='cancelled'` with no explanation at
         * all. The operator cancelled an import and lost their roster, and every
         * field they can see said the import simply stopped. Same class of defect
         * as the failure paths above, so it carries the same sentence rather than
         * a cancel-flavoured variant of it.
         *
         * `undefined` (not `''`) for an append, so the note stays NULL on the row
         * and cannot render as an empty explanation.
         */
        const note = retirementNote('you cancelled the import').trim();
        await agencyIngestJobRepository.markCancelled(job.id, note || undefined);
        log.info(
          { jobId: job.id, rosterRetirement: retirement.state },
          'Agency roster ingest cancelled',
        );
        return;
      }

      /**
       * The DNC list could not be read.
       *
       * **Fails the job, and that is the correct outcome even though it costs the
       * operator their import.** The alternative — completing with the rows that
       * happened to be checked before the outage and the rest sent unchecked — is
       * a compliance violation at volume dressed as a successful import, and it
       * would carry a green summary the operator would reasonably trust. A paused
       * campaign is an inconvenience; a wrongly-dialed suppressed number is a
       * regulatory event.
       *
       * Ordered before `AgencyIngestError` only for readability; the two are
       * disjoint types.
       */
      if (err instanceof DncUnavailableError) {
        await failJob(
          'dnc_unavailable',
          'The Do Not Call list could not be checked, so no contacts were imported. Nothing was dialed. Try the import again.',
        );
        log.error({ err, jobId: job.id }, 'Agency roster ingest halted — DNC list unavailable');
        return;
      }

      /**
       * The replace could not start.
       *
       * **Nothing was retired and nothing was sent** — this can only be thrown
       * from the supersede call, which runs before the file is even opened. So
       * the campaign still holds exactly the roster it had, and the message says
       * so, because "the import failed" on a replace otherwise reads as "my
       * roster might be gone".
       *
       * The four codes are distinct because the operator's next action differs:
       * `replace_unsupported` is a deployment gap they cannot fix and must not
       * be told to retry; `replace_refused` is the supersede saying the campaign is
       * dialing, has a live attempt, or has changed size since they looked —
       * each of which they CAN fix.
       */
      if (err instanceof RosterSupersedeError) {
        /**
         * **"Not touched" is only sayable when `attempts === 1`.**
         *
         * The retry makes the reassurance unsafe: the attempt that could have
         * committed is not the attempt that answered. So a single-attempt failure
         * keeps the categorical wording, and anything after a retry is reported as
         * uncertain and recorded as uncertain (`recordReplaceUncertain`), which is what puts
         * a non-null signal on the field the UI renders loudest.
         *
         * The four codes stay distinct because the operator's next action differs:
         * `replace_unsupported` is a deployment gap they cannot fix and must not be
         * told to retry; `replace_refused` is the supersede saying the campaign is dialing,
         * has a live attempt, or has changed size since they looked.
         */
        const provablyClean = err.attempts <= 1;
        if (!provablyClean) {
          retirement = { state: 'unknown' };
          await agencyIngestJobRepository.recordReplaceUncertain(job.id);
        }
        await agencyIngestJobRepository.fail(
          job.id,
          `replace_${err.code}`,
          provablyClean
            ? `${err.message} Nothing was imported and your existing contacts were not touched.`
            : `${err.message} Nothing was imported. This took ${err.attempts} attempts, and an earlier one may have retired your existing contacts before failing — check the campaign's contact count before importing again.`,
        );
        log.warn(
          {
            err,
            jobId: job.id,
            campaignId,
            code: err.code,
            coreCode: err.coreCode,
            attempts: err.attempts,
            rosterStateProvablyClean: provablyClean,
          },
          provablyClean
            ? 'Agency roster replace refused before any contact was retired'
            : 'Agency roster replace failed after a retry — roster state unconfirmed',
        );
        return;
      }

      // A whole-file problem carries a code the wizard can render specific copy
      // for; anything else is unexpected and gets a generic code so it is
      // obviously distinguishable in logs and dashboards.
      if (err instanceof AgencyIngestError) {
        await failJob(err.code, err.message);
        return;
      }
      if (err instanceof RosterChunkError) {
        await failJob(
          'core_rejected_chunk',
          `Core rejected roster chunk ${err.chunkIndex}: ${err.message}`,
        );
        return;
      }

      log.error({ err, jobId: job.id }, 'Agency roster ingest failed unexpectedly');
      await failJob('unexpected_error', err instanceof Error ? err.message : 'Unknown error');
    }
  }

  /** Write the rejected-rows CSV. Returns null when there was nothing to write. */
  private async writeRejectedExport(
    job: AgencyIngestJobRecord,
    phoneColumn: string,
    contextColumns: string[],
    rejections: AgencyIngestRejection[],
  ): Promise<string | null> {
    if (rejections.length === 0) return null;

    let document = rejectedCsvHeader(phoneColumn, contextColumns);
    for (const rejection of rejections) {
      document += rejectedCsvRow(rejection, contextColumns);
    }

    // Shape owned by `agency-ingest-keys.ts`, which is also what refuses this key
    // as a client-supplied `s3_key` — the writer and the checker share one
    // definition so they cannot drift apart.
    const key = rejectedExportKey(job.tenant_id, job.id);
    await uploadFile(key, Buffer.from(document, 'utf8'), 'text/csv');
    return key;
  }
}

/** Internal sentinel — the only way to stop a `for await` from inside a callback. */
class IngestCancelled extends Error {
  constructor() {
    super('ingest cancelled');
    this.name = 'IngestCancelled';
  }
}

export const agencyIngestService = new AgencyIngestService();

/**
 * How often the periodic reaper sweep runs.
 *
 * ── Why a periodic sweep exists at all ──────────────────────────────────────
 * `reapStaleJobs()`'s heartbeat-staleness fix (see its docstring in
 * `agency-ingest-job.repository.ts`) is only correct *paired with* a sweep
 * that keeps running — a one-shot boot-time call, on its own, catches almost
 * nothing. A process killed mid-ingest leaves `updated_at` a second or two
 * old (`PROGRESS_INTERVAL_MS`); the replacement replica boots seconds later,
 * calls `reapStaleJobs()` once, finds the row nowhere near
 * `AGENCY_INGEST_JOB_STALE_MINUTES` old yet, and reaps nothing. The job then
 * sits `running` forever with no worker and no future reap ever scheduled —
 * exactly the original "wizard polls a job that will never move" bug, just
 * delayed past the boot instant instead of prevented.
 *
 * A stale threshold is only a correct recovery policy when something
 * re-checks it before the threshold's own age gate becomes the reason nothing
 * gets swept. An ingest job is never re-driven by the reaper — it is simply
 * marked `failed` so the operator re-uploads — so an always-on `setInterval`
 * is the right amount of machinery, not a demand-driven, self-dormant sweeper
 * with per-item retry bookkeeping.
 */
export const AGENCY_INGEST_REAP_INTERVAL_MS = 2 * 60 * 1000;

/**
 * Start the periodic reaper sweep. Call once at boot in addition to (not
 * instead of) the immediate boot-time reap — the immediate call still catches
 * genuinely long-orphaned jobs from a prior outage the instant this replica
 * comes up; this interval is what keeps catching a job orphaned *after* boot,
 * once its heartbeat ages past the staleness threshold.
 */
export function startAgencyIngestReaper(): ReturnType<typeof setInterval> {
  return setInterval(() => {
    void agencyIngestJobRepository.reapStaleJobs().then((reaped) => {
      if (reaped > 0) log.warn({ reaped }, 'Failed agency ingest jobs orphaned by a restart');
    }).catch((err: unknown) => {
      log.error({ err }, 'Could not reap stale agency ingest jobs');
    });
  }, AGENCY_INGEST_REAP_INTERVAL_MS);
}

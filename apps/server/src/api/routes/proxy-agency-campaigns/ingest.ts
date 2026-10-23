/*
 * Roster ingest: limits, upload, analyze, run, poll, cancel, clear and the
 * rejected-rows download. Part of `proxy-agency-campaigns.routes.ts`.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import crypto from 'node:crypto';
import { sessionMiddleware } from '../../../auth/session.middleware.js';
import { tenantContextMiddleware } from '../../middleware/tenant-context.middleware.js';
import { requirePermission } from '../../../rbac/rbac.middleware.js';
import { createChildLogger } from '@magick-agency/observability';
// `getFileBuffer` is `storage/s3.ts`'s `getFile`, the one S3 module (decision B14): a
// `GetObjectCommand` on the agency bucket, returning the whole object as a Buffer. The alias
// names what the call sites want back.
import { uploadFile, getFileStream, getFile as getFileBuffer } from '../../../storage/s3.js';
import { analyzeAgencyCsvColumns } from '../../../agency/agency-column-analysis.js';
import {
  AgencyIngestError,
  AGENCY_MAX_COLUMNS,
  AGENCY_MAX_ROWS,
  AGENCY_MAX_CELL_BYTES,
} from '../../../agency/agency-csv-ingest.js';
import { agencyIngestJobRepository } from '../../../agency/agency-ingest-job.repository.js';
import { isTenantUploadKey, uploadKey } from '../../../agency/agency-ingest-keys.js';
import { agencyIngestService } from '../../../agency/agency-ingest.service.js';
import { supersedeRoster, RosterSupersedeError } from '../../../agency/agency-roster.client.js';
import { fetchOwnedCoreCampaign, stringField } from '../helpers/core-campaign.js';
import { csvAttachmentHeader } from '../helpers/csv-attachment.js';
import { config } from '../../../config/index.js';
import { parseOr400 } from '../helpers/parse-or-400.js';

const log = createChildLogger({ component: 'proxy-agency-campaigns' });

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
 * caller states the roster size it believes it is destroying, and the dialer
 * runtime refuses under the campaign row lock if reality has moved. A
 * colleague's top-up between the operator seeing the screen and pressing the
 * button is exactly the case where "retire everything" is not what anyone meant,
 * and it is invisible to every other check.
 *
 * This layer cannot enforce it: a count it fetched would be stale by the time it
 * acted on it, which is the same argument the PATCH handler makes about campaign
 * status. Only the check under the row lock is honest. So this layer's job is to
 * REQUIRE it and forward it unchanged.
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
   * decision rather than an omission.** The instinct, once a destructive mode
   * exists, is to require the caller to state a mode, on the grounds that an
   * unversioned implicit default is what produces this class of bug. The
   * instinct is right about the diagnosis and wrong about the remedy:
   *
   *  - What a mode needs is not a required field. It is a CONCEPT of intent —
   *    a field, a record on the job row, a way for an operator or a support
   *    engineer to ask afterwards which semantics ran. That comes from the field
   *    existing, being persisted (`agency_ingest_jobs.mode`) and being echoed
   *    back on the job payload, not from making it mandatory.
   *  - `append` is the non-destructive value, so a caller that says nothing
   *    gets the safe behaviour. A missing mode can never mean `replace`; the
   *    dangerous value is unreachable without saying it.
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

/** Registered by `proxyAgencyCampaignsRoutes` on its own instance, after its hooks. */
export async function registerCampaignIngestRoutes(app: FastifyInstance): Promise<void> {
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
   * route — registering it at the plugin
   * root would put a body parser in front of every JSON route here. Hooks are
   * re-added because a sub-plugin does not inherit the parent's.
   */
  await app.register(async function agencyUploadPlugin(sub) {
    await sub.register(import('@fastify/multipart'), {
      limits: { fileSize: CSV_MAX_BYTES },
    });
    sub.addHook('preHandler', sessionMiddleware);
    sub.addHook('preHandler', tenantContextMiddleware);

    sub.post('/ingest/upload', {
      preHandler: requirePermission('agency.campaigns.write'),
    }, async (request, reply) => {
      const file = await request.file();
      if (!file) {
        return reply.code(400).send({ error: 'Validation Error', message: 'No file uploaded.' });
      }

      // A multipart body that ends mid-part raises busboy's `Unexpected end of form`, an
      // error with no status, which reached the client as a masked 500. It is the caller's
      // malformed upload: a 400. Errors the plugin does classify (the 413 for a file over
      // `CSV_MAX_BYTES`) keep their status (`load/hostile-input-fuzz.test.ts`).
      let buffer: Buffer;
      try {
        buffer = await file.toBuffer();
      } catch (err) {
        if (typeof (err as { statusCode?: unknown }).statusCode === 'number') throw err;
        log.warn({ err, tenantId: request.tenantId }, 'Agency roster upload refused: malformed multipart body');
        return reply.code(400).send({
          error: 'Validation Error',
          message: 'The upload could not be read: the file was cut off or the form is malformed. Please upload it again.',
        });
      }
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
    const parsed = parseOr400(analyzeSchema, request.body, reply, 'agency');
    if (!parsed) return reply;
    // An S3 key is client-supplied here, so it must be proved to be one of this
    // tenant's UPLOADS before it is read. The tenant prefix alone is not enough:
    // without it a tenant could name another tenant's key and have the analyzer
    // read it back as sample values, and with only it an account-scoped caller
    // could name a sibling account's rejected-rows export (keyed by nothing but the
    // job id) and read that back the same way. See `agency-ingest-keys.ts`.
    if (!isTenantUploadKey(parsed.data.s3_key, request.tenantId!)) {
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
   * writing any roster rows, which is what lets the wizard say "95% of your
   * rows are valid" before the operator commits.
   */
  app.post('/ingest/jobs', {
    preHandler: requirePermission('agency.campaigns.write'),
  }, async (request, reply) => {
    const parsed = parseOr400(startIngestSchema, request.body, reply, 'agency');
    if (!parsed) return reply;
    const input = parsed.data;

    // The same upload-key proof as the analyzer's, above.
    if (!isTenantUploadKey(input.s3_key, request.tenantId!)) {
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
    // omits `X-Account-Id` would otherwise stamp NULL here, which the account-scoped
    // lookups below would then refuse to show back to its own creator. Never
    // a widening: when both are present `tenantContextMiddleware` has already
    // refused a header that disagrees with an account-scoped membership.
    const jobAccountId = ingestJobAccountScope(request) ?? request.accountId ?? null;

    // Any named campaign must be one the caller owns — a dry run's included. A
    // run that writes hands its rows to that campaign (see the probe's
    // docstring); a dry run writes nothing, but it still READS through the id:
    // `dropSuppressed` applies that campaign's campaign-scoped DNC entries, so
    // an unprobed dry run naming a sibling's campaign would report which of the
    // caller's numbers that campaign suppresses, and store the unverified id
    // on the job row. A dry run WITHOUT a campaign is not probed.
    //
    // The probe returns the PROVEN owner's account (the campaign row's
    // `account_id`), and that is what the job is stamped with whenever a
    // campaign is named: the roster hand-off compares `agency_ingest_jobs.account_id`
    // to the campaign's account and fails a mismatched or NULL one
    // `core_rejected_chunk`. The handler's `requireOwned` matched that column to
    // `jobAccountId`, so the two are equal; the row's value is used so the
    // invariant is stated where it is written. A dry run with no campaign keeps
    // `jobAccountId` (no roster is written).
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
      // A person, or nobody. `sessionMiddleware` has no API-key branch, so
      // `request.user` is always the person who ran the import.
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
   * **Registered only when `AGENCY_ROSTER_REPLACE_ENABLED` is set** — an
   * entire subsystem registers only if its config says so, so a missing route
   * in a running server usually means an unset env var. A destructive surface
   * that is visible but always fails is worse than one that is not there.
   *
   * ── Why this exists at all ────────────────────────────────────────────────
   * Without it there is no way to clear an agency roster, and the workaround
   * an operator reaches for instead (re-upload the corrected file) silently
   * MERGES, because `append` is the default ingest mode.
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
   * `agency.campaigns.write` (account_admin and up) is the same permission
   * that loads a roster, which is the right pairing: whoever can put a list in
   * front of the dialer can take it away.
   *
   * ── Three outcomes, and the middle one is the point ───────────────────────
   *   200 `roster_state: 'cleared'`     — `cleared` is the count the dialer runtime retired.
   *   202 `roster_state: 'unconfirmed'` — the request may or may not have been
   *       applied; `cleared`/`contacts_total` are null and the operator must
   *       re-read the campaign's count. See the branch below for why 202.
   *   409 / 404                         — refused on a single attempt, so
   *       nothing was cleared, or the campaign does not exist.
   */
  //
  // Decision B15: registered under `config.agency.rosterReplaceEnabled`
  // (`AGENCY_ROSTER_REPLACE_ENABLED`, default off). When it is on, the route still
  // refuses: `supersedeRoster` throws `RosterSupersedeError(..., 'unsupported', attempts 1)`
  // and writes nothing, because replace/clear is not implemented, and the
  // `unsupported` arm falls through to the 500 below. The ingest's `mode: 'replace'`
  // likewise ends `replace_unsupported`.
  if (config.agency.rosterReplaceEnabled) {
    app.post<{ Params: { id: string } }>('/campaigns/:id/roster/clear', {
      preHandler: requirePermission('agency.campaigns.write'),
    }, async (request, reply) => {
      const parsed = parseOr400(clearRosterSchema, request.body, reply, 'agency');
      if (!parsed) return reply;

      // Same ownership proof as the ingest: the supersede is a roster write the
      // handler's `requireOwned` never sees. Membership account first, never the
      // header alone — an account-scoped caller who omits it would otherwise send
      // no account at all. As on the ingest, the supersede is addressed to the
      // proven owner's account (the probe's return), not the caller's scope.
      const callerAccountId = ingestJobAccountScope(request) ?? request.accountId ?? null;
      const clearAccountId = await proveCampaignOwnedForWrite(request, reply, request.params.id, callerAccountId);
      if (!clearAccountId) {
        return reply;
      }

      try {
        // No `ingestJobId`: nothing is being loaded, so nothing is exempt and
        // every live contact is retired. Idempotent for the same reason the
        // replace path is — the supersede predicate only ever touches rows that
        // are still live, so a second clear finds nothing to do and says so.
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
            // that may be: a campaign that cannot be found has no roster for the
            // operator to go and check, so "we could not confirm your contacts"
            // would be an alarm about nothing.
            //
            // `code` is carried explicitly, and it is not decoration.
            // `campaign_not_found` is allow-listed in `errorMaskHook`, but the
            // allow-list reads the BODY — a bare `{ error, message }` would be
            // masked into "contact support and quote this request id" for a
            // campaign that simply does not exist.
            return reply.code(404).send({
              error: 'Not Found',
              code: 'campaign_not_found',
              message: 'Campaign not found.',
            });
          }
          /**
           * ── The roster may already be empty, and no final code says so ──────
           *
           * Not reached today: `supersedeRoster` refuses `unsupported` on its
           * first attempt (decision B15). The branch is for an implementation
           * that retries, where attempt 1 can retire 5,000 contacts and commit,
           * lose its response, and attempt 2 be answered
           * `409 contacts_total_mismatch` by the compare-and-swap against a
           * roster that is already 0. Answering the browser 409 there would tell
           * the operator their clear failed while their contacts are gone.
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
           * (this body carries no `details` and no allow-listed `code`),
           * replacing the one sentence that matters
           * with a support-ticket message. A 200 asserts the opposite untruth.
           * 202 is the honest shape: the request was accepted, the outcome is not
           * knowable here, read it from the campaign.
           *
           * The recovery is the SAME action the `contacts_total_mismatch`
           * guidance already gives the console — re-fetch the campaign's contact count
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
              // Null, never 0: there is no count, and a zero here would read
              // as "we cleared nothing" on the one response where that is the
              // claim it cannot make.
              cleared: null,
              contacts_total: null,
              code: 'roster_state_unconfirmed',
              // The roster write's own refusal reason where it gave one, for the
              // log trail and for a console that wants to say which check
              // failed. Absent when no attempt got a refusal back.
              ...(err.coreCode ? { core_code: err.coreCode } : {}),
              attempts: err.attempts,
              message:
                `This took ${err.attempts} attempts and the result could not be confirmed, so this campaign's contacts may already have been removed. ` +
                'Re-check the campaign\'s contact count, then confirm again with the count you see — do not simply retry.',
            });
          }
          if (err.code === 'refused') {
            // The roster write's own refusal, forwarded with its machine code: the campaign
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
        // deployment is wired wrong — the flag above is on while the supersede
        // is not implemented — which is a server fault, and the error mask's job is
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
    return reply
      .code(200)
      .header('Content-Type', 'text/csv')
      .header('Content-Disposition', csvAttachmentHeader(`${downloadBaseName(job.file_name)}-rejected-rows`))
      .send(buffer);
  });
}

/**
 * The caller's own account scope for an ingest-job lookup: the MEMBERSHIP's
 * `account_id`, never `request.accountId` — `X-Account-Id` is an
 * unauthenticated, optional header, so an account-scoped caller who omits it
 * would otherwise read as tenant-wide. `null` for a tenant-wide membership,
 * which leaves every job in the tenant reachable, by design.
 *
 * Every route that takes a job id threads this through — poll, cancel AND the
 * rejected-rows export: a guard on one of them is not a guard on the others.
 */
function ingestJobAccountScope(request: FastifyRequest): string | null {
  return request.membership?.account_id ?? null;
}

/**
 * An ingest job id is the `agency_ingest_jobs` UUID primary key. Anything else reached
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
 * Prove the caller owns `campaignId` BEFORE this route writes to its roster
 * (or, on a dry run, reads that campaign's DNC scope into a preview).
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The roster writes — the ingest's chunks (`sendRosterChunk`) and the
 * replace/clear supersede — are named by a `campaign_id` taken from the request
 * body. Without a proof, an `account_admin` who knew a sibling account's
 * campaign id — or ANOTHER TENANT's — could load contacts into it, and those
 * contacts get dialled.
 *
 * The proof is the internal handler's campaign read, the `requireOwnedCampaign`
 * shape and for the same reasons (its own `gate` + `requireOwned`, its own 404
 * body): the route 404s unless the campaign's tenant AND account both match the
 * headers, so the account sent here is the one the job will be stamped with —
 * the caller's membership account first, the header only for a tenant-wide
 * caller. It FAILS CLOSED: a throw propagates (a masked 500), because the thing
 * it authorises is a write that cannot be taken back. The roster hand-off
 * (`agency-roster.client.ts`) re-checks tenant AND account itself
 * (`ingestCallerOwnsCampaign`), so this proof is the first of two.
 *
 * Returns the PROVEN owner's account — the campaign row's `account_id` off the
 * handler's body — or `null` when it has already replied. Callers stamp the job
 * and address the supersede with it. A 200 without the field is a defect and is
 * refused (500) rather than guessed. There is no timeout: `callCore` installs
 * no signal (see `requireOwnedCampaign`).
 */
async function proveCampaignOwnedForWrite(
  request: FastifyRequest,
  reply: FastifyReply,
  campaignId: string,
  accountId: string | null,
): Promise<string | null> {
  if (!accountId) {
    // The handler's `requireOwned` compares the campaign's account to the
    // account header; with none there is nothing to compare, and the handler
    // would 400 on the missing header anyway. Refused here so the caller gets a
    // named reason rather than a masked handler complaint.
    await reply.code(400).send({
      error: 'Bad Request',
      code: 'account_scope_required',
      message: 'Loading or clearing a campaign roster is scoped to one account. Send X-Account-Id.',
    });
    return null;
  }
  const probe = await fetchOwnedCoreCampaign(request, campaignId, accountId);
  if (!probe.ok) {
    // Forwarded unchanged: a sibling account's campaign, another tenant's and a
    // nonexistent one are all the handler's 404, and must stay indistinguishable.
    await reply.code(probe.status).send(probe.body);
    return null;
  }
  const ownerAccountId = stringField(probe.body, 'account_id');
  if (!ownerAccountId) {
    throw new Error('agency campaign ownership probe: the internal handler answered without the campaign\'s account_id');
  }
  return ownerAccountId;
}

/**
 * The download's filename stem from the operator's original upload name, before
 * `csvAttachmentHeader` makes it header-safe.
 *
 * The name is user-supplied and round-trips back out as a header, so it is not
 * trusted as a path: separators become `_`, dot runs are collapsed and leading
 * dots stripped, so `../../etc/passwd.csv` cannot carry `..` or a hidden-file
 * name into a filename some clients resolve. Everything else — spaces, non-ASCII —
 * is left for `csvAttachmentHeader`, which keeps the name whole in `filename*=` and
 * quote-safe in `filename=`. Cut by code point (`Array.from`), never mid-surrogate.
 */
function downloadBaseName(fileName: string): string {
  const stem = fileName.replace(/\.csv$/i, '');
  const sanitised = stem
    .replace(/[\\/]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^[._]+/, '');
  return Array.from(sanitised).slice(0, 100).join('') || 'import';
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
    // `?? 'append'` covers a row read before the `mode` column exists, where
    // `SELECT *` returns no such key at all. Append is the fail-safe reading — a
    // client must never infer "this was a replace" from an absence.
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
     * The third state exists for a supersede that retries: one attempt can
     * commit and a later one be refused by the compare-and-swap. (Today
     * `supersedeRoster` refuses on its first attempt, decision B15.)
     * **Render the third state at least as loudly as the second** — "we could not
     * confirm" is the sentence that gets an operator to look, and the wording
     * the console shows must not soften it into "probably fine".
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
    // Independent of accepted/rejected above: those count what the ingest
    // decided to SEND; this counts what the roster actually REFUSED on arrival
    // because it already held the row (a re-upload into a populated campaign,
    // not a retry). A non-zero value here means the operator's `accepted` count
    // overstates what was actually written — surface it prominently rather than
    // let a "5,000 accepted" summary imply success.
    //
    // `?? 0` / `?? []`, not a bare read: a row read while the columns do not
    // exist (the window the repository's write-path fallback tolerates — see
    // `agency-ingest-job.repository.ts`) has no key at all for either column,
    // so `job.core_rejected_duplicate_rows` is `undefined` and
    // `Number(undefined)` is `NaN` — which `JSON.stringify` silently rewrites
    // to `null` on the wire, a type the client does not expect for a field
    // documented as `number`.
    core_rejected_duplicate_rows: Number(job.core_rejected_duplicate_rows ?? 0),
    core_duplicate_source_rows: job.core_duplicate_source_rows ?? [],
    // Whether the count above is EXACT or a LOWER BOUND. A count that may be an
    // undercount is a materially different thing to render than an exact one:
    // "the roster refused nothing" and "we cannot tell what it refused" are the
    // same zero on the wire without this bit, and the first is a clean
    // import while the second means the operator should not trust the summary to
    // prove one.
    //
    /**
     * **An ABSENT column reads `true`, not `false`, and the direction is the whole
     * point of the field.**
     *
     * `?? false` would be wrong here, in exactly the way this field exists to
     * prevent. The key is missing from a `SELECT *` only while the column itself
     * does not exist, and in that window the repository's `42703` fallback has
     * ALSO been unable to write the count. So the row would read
     * `{ core_rejected_duplicate_rows: 0, may_undercount: false }`: "the roster
     * refused nothing, exactly", stated confidently about a number that was never
     * recorded. That is a confident wrong zero, which is the failure mode this
     * pair of fields exists to end.
     *
     * `?? true` is the honest reading: while the column is absent the count
     * cannot be vouched for, so the response says so. Once the column exists
     * every row carries a real boolean (column default `false`), so the
     * uncertainty is confined to that window.
     *
     * `Boolean(... ?? true)` rather than a bare read so the wire value is always a
     * real boolean; `undefined` would be dropped by `JSON.stringify` and leave
     * the console with a missing field for something documented as `boolean`.
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

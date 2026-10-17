/**
 * Retry campaigns: the preview of what a selector would seed, and the
 * all-or-nothing create that seeds it. Bodies of
 * `AgencyCampaignRepository.retryPreview` / `retryFromCampaign`, which delegate here.
 */
import { getPool } from '@magick-agency/db';
// The `23505` predicate, matched on the CONSTRAINT NAME. A leaf module (see its
// header) so the catch arms below can ask the question without dragging config
// into the graph of every test that exercises them.
import { isUniqueViolation } from '@magick-agency/db/pg-errors';
// BEGIN / COMMIT / ROLLBACK / release, and joining a caller's transaction (decision
// B8). A leaf too: the pool is passed in, so the `getPool` mock stays in charge.
import { withTransaction } from '@magick-agency/db/utils/transaction';
import type { AgencyCampaignConfigColumns, AgencyCampaignRecord } from '../../models/agency.model.js';
import type { AgencyRetryPreview, AgencyRetrySelector } from '@magick-agency/contracts/agency';
// The shared retry bounds. A leaf module, imported rather
// than restated, so the number the API publishes as `max_seed_rows` and the number
// the transaction refuses on are the same token.
import { RETRY_MAX_SEED_ROWS } from '@magick-agency/domain/retry-campaign-bounds';
import { CAMPAIGN_INSERT_COLUMNS_SQL } from './sql-fragments.js';
import { neverSeededSuppressionSql, params, retrySelectionConditions } from './query-builders.js';

/** What {@link AgencyCampaignRepository.retryFromCampaign} answers. */
export type AgencyRetryCreateResult =
  | {
      status: 'created';
      campaign: AgencyCampaignRecord;
      contacts_seeded: number;
      /**
       * How many matched rows the seed COLLAPSED rather than copied.
       *
       * `matched - contacts_seeded`, and it is normally 0. The seed's
       * `ON CONFLICT (campaign_id, row_fingerprint) DO NOTHING` exists because a
       * parent may legitimately hold two byte-identical roster rows — the
       * fingerprint index is per-campaign — and the child collapses them to one.
       *
       * Reported rather than left to be noticed, because the preview's `matched`
       * is a PROMISE about this commit: a supervisor shown 812 and then handed a
       * campaign of 809 has no way to tell a duplicate collapse from rows lost to
       * a bug, and the difference decides whether they escalate.
       */
      duplicates_collapsed: number;
      excluded: { dnc: number; invalid: number };
    }
  /**
   * This exact key already created a campaign. **Nothing was created now**, and
   * the campaign returned is the ORIGINAL — which is what makes this idempotent
   * rather than merely a duplicate guard: the client that lost a 201 and pressed
   * the button again gets the campaign it already made, and can navigate to it.
   */
  | { status: 'replayed'; campaign: AgencyCampaignRecord }
  | { status: 'empty'; excluded: { dnc: number; invalid: number } }
  | { status: 'too_large'; matched: number };

/**
 * The one repository read {@link createRetryCampaign} calls back into. The class
 * passes itself, so the idempotency lookup is the same method every other caller
 * reaches.
 */
export interface RetryIdempotencyLookup {
  findByRetryIdempotencyKey(tenantId: string, accountId: string, key: string): Promise<AgencyCampaignRecord | null>;
}

/**
 * What a retry selector would seed, without seeding it
 * (`GET /agency-campaigns/:id/retry/preview`). Writes nothing.
 *
 * ── One statement, and every number in it measured over one snapshot ───────
 *
 * The buckets, the matched total and the two exclusion counts all come from a
 * single scan of the parent's roster. Split across three queries they would be
 * read at three instants — and the parent may still be RUNNING while a
 * supervisor previews a retry of it, so `matched` could disagree with the sum
 * of its own buckets by however many contacts the pacing leader dispositioned
 * in between. A breakdown that does not add up to its own total is worse than a
 * slightly stale one: the reader cannot tell which of the two numbers to
 * believe.
 *
 * ── Why the exclusions are counted rather than simply not matched ──────────
 *
 * `excluded` is the never-retried suppressed rows the selector DID match. A supervisor who selects
 * "everything suppressed" and is handed 40 instead of 300 will report it as a
 * bug unless they are told the other 260 were DNC and invalid. So the
 * suppression arm is evaluated as a projection (`FILTER (WHERE …)`) rather than
 * as a predicate, and only the seedable rows feed the buckets.
 *
 * `__none__` is the literal bucket key for a NULL value, on BOTH maps. A
 * contact that was never dialled has no `last_outcome` and a contact dialled
 * without a write-up has no `last_disposition`; dropping those rows would make
 * the maps stop summing to `matched`, which is the property that makes the
 * breakdown readable at all.
 *
 * ── `seedable` is DEDUPED BY FINGERPRINT, because the commit is ────────────
 *
 * The seeding `INSERT` carries `ON CONFLICT (campaign_id, row_fingerprint) DO
 * NOTHING`, so a parent holding two byte-identical rows (same phone, context
 * and timezone — legal, the fingerprint index is per-campaign) seeds ONE. A
 * plain `COUNT(*)` here would promise the supervisor the pre-collapse number
 * and then hand them a shorter roster, and worse, the commit's own cap check
 * would 409 `retry_selection_too_large` on a selection that would have fitted:
 * 100,040 duplicated rows refuse a retry that seeds 50,020.
 *
 * `DISTINCT ON (fingerprint)` makes `matched` exactly what the INSERT writes,
 * and — because the buckets are computed from this same CTE — keeps them
 * summing to it. Deduping by counting (`COUNT(DISTINCT …)`) would break that
 * sum, since two rows sharing a fingerprint can hold different outcomes.
 * Which of the two survives is arbitrary here and arbitrary in the INSERT
 * (`DO NOTHING` keeps whichever row Postgres reaches first), so neither is
 * more correct than the other.
 *
 * `duplicates_collapsed` on the create response still reports the difference:
 * this makes the PROMISE accurate, that explains a roster that is shorter
 * than the parent's matching rows.
 */
export async function previewRetry(parentId: string, selector: AgencyRetrySelector): Promise<AgencyRetryPreview | null> {
  const bind = params();
  const parent = bind.add(parentId);
  // THE shared builder — the same conditions the commit's INSERT will run. See
  // `retrySelectionConditions`.
  const conditions = [`c.campaign_id = ${parent}`, ...retrySelectionConditions(selector, 'c', bind)];

  const { rows } = await getPool().query<{
    matched: string;
    dnc: string;
    invalid: string;
    by_last_outcome: Record<string, string> | null;
    by_last_disposition: Record<string, string> | null;
    parent_contacts_total: string | null;
    retry_generation: number | null;
  }>(
    `
      WITH selected AS (
        SELECT c.last_outcome, c.last_disposition, c.suppressed_reason,
               agency_contact_row_fingerprint(c.phone_e164, c.context, c.timezone) AS fingerprint
          FROM agency_contacts c
         WHERE ${conditions.join(' AND ')}
      ),
      seedable AS (
        SELECT DISTINCT ON (fingerprint) * FROM selected
         WHERE NOT (${neverSeededSuppressionSql('selected')})
         ORDER BY fingerprint
      )
      SELECT
        (SELECT COUNT(*)::text FROM seedable) AS matched,
        (SELECT COUNT(*)::text FROM selected WHERE suppressed_reason = 'dnc')     AS dnc,
        (SELECT COUNT(*)::text FROM selected WHERE suppressed_reason = 'invalid') AS invalid,
        -- COALESCE'd to '{}' so an empty selection serves two empty objects rather
        -- than two nulls: the console renders a breakdown either way, and a null
        -- there is a branch every consumer has to remember.
        (SELECT COALESCE(jsonb_object_agg(k, n), '{}'::jsonb) FROM (
           SELECT COALESCE(last_outcome, '__none__') AS k, COUNT(*)::text AS n
             FROM seedable GROUP BY 1) o)                                          AS by_last_outcome,
        (SELECT COALESCE(jsonb_object_agg(k, n), '{}'::jsonb) FROM (
           SELECT COALESCE(last_disposition, '__none__') AS k, COUNT(*)::text AS n
             FROM seedable GROUP BY 1) d)                                          AS by_last_disposition,
        cam.contacts_total::text AS parent_contacts_total,
        cam.retry_generation     AS retry_generation
        FROM agency_campaigns cam
       WHERE cam.id = ${parent}
      `,
    bind.values,
  );

  const row = rows[0];
  // The campaign vanished between the route's ownership check and this read.
  // `null` rather than a zeroed preview, so the route answers 404 the same way
  // every other campaign read does — a preview of 0 contacts on a campaign that
  // no longer exists reads as "there is nobody left to retry".
  if (!row) return null;

  const counts = (raw: Record<string, string> | null): Record<string, number> =>
    Object.fromEntries(Object.entries(raw ?? {}).map(([k, v]) => [k, Number(v)]));

  return {
    matched: Number(row.matched),
    by_last_outcome: counts(row.by_last_outcome),
    by_last_disposition: counts(row.by_last_disposition),
    excluded: { dnc: Number(row.dnc), invalid: Number(row.invalid) },
    parent_contacts_total: Number(row.parent_contacts_total ?? 0),
    // The CHILD's generation, which is what the console is about to create.
    retry_generation: (row.retry_generation ?? 0) + 1,
    max_seed_rows: RETRY_MAX_SEED_ROWS,
  };
}

/**
 * Create a retry campaign and seed its roster from the parent — **all of it, or
 * none of it.**
 *
 * ── Why one transaction, and what it is protecting ────────────────────────
 *
 * The child campaign row, its contacts and its `contacts_total` commit
 * together. A half-seeded retry campaign is the worst outcome available: it
 * looks startable and dials a subset nobody chose. There is also no campaign
 * delete route, so a bad partial result is not something the
 * supervisor can clean up.
 *
 * Both this and `applyIngestChunk` run through `withTransaction` —
 * `connect`/`BEGIN`/`ROLLBACK` on any throw/`release` on every path — because it
 * is the same guarantee over the same table and a second spelling of it is how
 * one of them acquires a leak.
 *
 * ── The counts are taken INSIDE the transaction ───────────────────────────
 *
 * `matched` decides both 409s, and it is read under the same snapshot that
 * seeds. Reading it outside would leave a window in which the parent's pacing
 * leader disposition a contact out of (or into) the selection between the
 * decision and the INSERT — so the refusal would be about a set that no longer
 * existed, and `contacts_seeded` could exceed a cap that had just been checked.
 *
 * ── The two refusals, and why they are refusals ───────────────────────────
 *
 *  - `empty` — the selector matched nothing seedable. Nothing is created,
 *    because the alternative is a campaign the supervisor cannot start
 *    (`/start` answers `409 campaign_roster_empty`) and cannot delete. The
 *    refusal has to happen at the moment a human is present to be told, which is
 *    the argument `rosterRejected`'s own docstring makes.
 *  - `too_large` — over `RETRY_MAX_SEED_ROWS`. NOT truncated: seeding the first
 *    100 000 of 300 000 would produce exactly the "dials a subset nobody chose"
 *    campaign the single transaction exists to prevent.
 *
 * Returned as a discriminated union rather than thrown. Both are ordinary
 * answers to a well-formed request, and the route turns each into its own `409`
 * code; an exception would make the caller distinguish them by message.
 */
export async function createRetryCampaign(repo: RetryIdempotencyLookup, input: {
  parent: AgencyCampaignRecord;
  name: string;
  selector: AgencyRetrySelector;
  /**
   * The MERGED, already-validated config columns: the parent's values with the
   * request's `config_overrides` applied on top.
   *
   * Merged by the ROUTE, not here, because the route is where the merged result
   * has to be run through `validateAgencyCampaignConfig` /
   * `abandonAnnouncementRejected` / `analysisProfileRejected` — a retry must
   * refuse every body `POST /` would refuse, and a config assembled below this
   * line would reach the table without meeting any of them.
   */
  config: AgencyCampaignConfigColumns;
  createdBy: string | null;
  /**
   * The caller's idempotency key, or `null` for an unkeyed create.
   *
   * Minted by the console when the retry dialog opens and passed through
   * unchanged by the route: a key
   * minted per request, anywhere downstream, is a different value on the second
   * attempt and protects nothing.
   *
   * `null` means no replay protection: the route accepts a body with no
   * `idempotency_key` and creates the retry unkeyed.
   */
  idempotencyKey: string | null;
}): Promise<AgencyRetryCreateResult> {
  const pool = getPool();

  // ── Fast path: this key has already been spent ────────────────────────────
  //
  // Checked BEFORE the transaction so an ordinary retry-after-a-lost-response
  // costs one indexed SELECT rather than a connection, a BEGIN, a scan of the
  // parent's roster and a rolled-back INSERT. It is NOT the guarantee — two
  // requests racing both miss it — which is what the 23505 arm below is for.
  if (input.idempotencyKey) {
    const prior = await repo.findByRetryIdempotencyKey(
      input.parent.tenant_id, input.parent.account_id, input.idempotencyKey,
    );
    if (prior) return { status: 'replayed', campaign: prior };
  }

  try {
    return await withTransaction<AgencyRetryCreateResult>(async (client, tx) => {
      // ── REPEATABLE READ, not the default (`isolation` below) ─────────────────
      //
      // The count that decides `empty` / `too_large` and the `INSERT … SELECT`
      // that seeds the roster are two statements over the parent's contacts, and
      // under READ COMMITTED each takes its OWN snapshot. The parent may still be
      // `running` — the design explicitly supports authoring a retry against a
      // live campaign — so its pacing leader is mutating exactly the rows being
      // counted, and the two statements could legitimately disagree:
      //
      //   * rows leave the cohort between them ⇒ `matched > 0` passes the empty
      //     check, the INSERT writes 0 rows, and the route answers 201 with
      //     `contacts_seeded: 0` — a draft campaign that cannot be started
      //     (`409 campaign_roster_empty`) and that no service can delete;
      //   * rows enter it ⇒ the seed can exceed `RETRY_MAX_SEED_ROWS`, the cap
      //     that was just checked.
      //
      // One snapshot for the whole transaction makes the decision and the write
      // agree by construction. Nothing here UPDATEs a row another writer might
      // have changed — the child campaign and its contacts are rows this
      // transaction creates — so there is no serialization-failure retry to
      // write: `40001` is unreachable on this path.
      const countParams = params();
      const countConditions = [
        `c.campaign_id = ${countParams.add(input.parent.id)}`,
        ...retrySelectionConditions(input.selector, 'c', countParams),
      ];
      // `matched` counts DISTINCT FINGERPRINTS, not rows — see `retryPreview`'s
      // header for the argument. This is the number the `INSERT … ON CONFLICT`
      // below will actually write, so the cap and the empty check decide on the
      // roster that will exist rather than on the one the selector touched.
      // `matched_rows` is the pre-collapse count, kept only to report
      // `duplicates_collapsed`.
      const counted = await client.query<{
        matched: string; matched_rows: string; dnc: string; invalid: string;
      }>(
        `SELECT
             COUNT(DISTINCT agency_contact_row_fingerprint(c.phone_e164, c.context, c.timezone))
               FILTER (WHERE NOT (${neverSeededSuppressionSql('c')}))::text            AS matched,
             COUNT(*) FILTER (WHERE NOT (${neverSeededSuppressionSql('c')}))::text     AS matched_rows,
             COUNT(*) FILTER (WHERE c.suppressed_reason = 'dnc')::text                 AS dnc,
             COUNT(*) FILTER (WHERE c.suppressed_reason = 'invalid')::text             AS invalid
             FROM agency_contacts c
            WHERE ${countConditions.join(' AND ')}`,
        countParams.values,
      );
      const matched = Number(counted.rows[0]?.matched ?? 0);
      const matchedRows = Number(counted.rows[0]?.matched_rows ?? 0);
      const excluded = {
        dnc: Number(counted.rows[0]?.dnc ?? 0),
        invalid: Number(counted.rows[0]?.invalid ?? 0),
      };

      if (matched === 0) {
        await tx.rollback();
        return { status: 'empty', excluded };
      }
      if (matched > RETRY_MAX_SEED_ROWS) {
        await tx.rollback();
        return { status: 'too_large', matched };
      }

      // ── The child row ────────────────────────────────────────────────────
      //
      // Every placeholder is BARE — no COALESCE anywhere — and that is deliberate
      // rather than incidental. A bare `$n` in `VALUES (...)` takes its type from
      // the target column; a `$n` inside `COALESCE(...)` does not, which is the
      // 42804 that once made `POST /agency-campaigns` fail outright (see
      // `create()`'s header and `campaign-insert-param-types.test.ts`). There is
      // nothing to default here: the parent row supplies a value for every column,
      // so the defaults `create()` restates in SQL have no work to do and the
      // whole class of defect is absent rather than avoided.
      //
      // ── What is NOT copied, and why each one ────────────────────────────
      //
      // `status` (the child starts `draft` — creation and starting stay
      // separate verbs, and it side-steps `uq_agency_campaign_running` at creation
      // time rather than failing the create for a reason that has nothing to do
      // with the retry), `started_at`, `ended_at`, `completed_at`,
      // `contacts_total`, `last_transition_by_*`, `pause_reason`, `paused_at`,
      // `pause_abandonment_rate_pct`. Every one of them describes THE PARENT'S
      // RUN. "Copy the config columns" applied naively would carry a stale
      // auto-pause record onto a campaign that has never dialled.
      //
      // `status` is omitted from the column list entirely rather than written as
      // `'draft'`: the column DEFAULT is `draft`, and naming it here would be a second
      // copy of that default with nothing keeping the two in step.
      const created = await client.query<AgencyCampaignRecord>(
        `INSERT INTO agency_campaigns
             (${CAMPAIGN_INSERT_COLUMNS_SQL},
              parent_campaign_id, root_campaign_id, retry_generation, retry_selector,
              retry_idempotency_key)
           VALUES ($1,$2,$3,$4,$5,
                   $6,$7,$8,$9,
                   $10,$11,$12::jsonb,$13::jsonb,
                   $14::jsonb,$15::jsonb,$16,$17,$18,
                   $19,$20,
                   $21,$22,$23,$24::jsonb,
                   $25)
           RETURNING *`,
        [
          input.parent.tenant_id, input.parent.account_id, input.name,
          input.config.caller_ids, input.config.telephony_provider,
          input.config.calling_window_start, input.config.calling_window_end,
          input.config.calling_days, input.config.default_timezone,
          input.config.wrapup_seconds, input.config.wrapup_auto_return,
          JSON.stringify(input.config.retry_policy ?? {}),
          JSON.stringify(input.config.disposition_catalog ?? []),
          JSON.stringify(input.config.context_display ?? {}),
          JSON.stringify(input.config.break_reasons ?? []),
          input.config.record_calls, input.config.analysis_profile_id, input.createdBy,
          input.config.abandon_announcement_id, input.config.abandonment_ceiling_pct,
          input.parent.id,
          // The chain head. A generation-0 parent carries NULL here (it
          // deliberately does not stamp itself), so the child of a first retry gets
          // the parent's own id and every deeper generation inherits it unchanged.
          input.parent.root_campaign_id ?? input.parent.id,
          input.parent.retry_generation + 1,
          // The selector as a RECORD, never re-executed. Stored normalised
          // (see `parseRetrySelector`) so the agent's banner can be rendered from
          // it without re-parsing against a catalog it was not validated against.
          JSON.stringify(input.selector),
          // NULL for an unkeyed caller, which the partial unique
          // index treats as no constraint at all.
          input.idempotencyKey,
        ],
      );
      const campaign = created.rows[0]!;

      // ── The roster, in ONE statement ─────────────────────────────────────
      //
      // ⚠️ `source_row_number` IS DELIBERATELY NOT IN THIS COLUMN LIST, for the
      // same reason it is absent from `applyIngestChunk`'s:
      // `uq_agency_contacts_source_row` is still live and partial on
      // `source_row_number IS NOT NULL`, so a row that stores NULL sits outside it.
      // Writing it here would make two seeded rows that happened to share a CSV
      // line number collide on an index this INSERT does not name — a 23505 that
      // aborts the whole transaction rather than being swallowed. `csv_line_number`
      // carries the provenance instead, and it is unindexed.
      //
      // `row_fingerprint` is recomputed by the SAME SQL function the ingest path
      // uses, from the copied values, so "the same roster row" has ONE definition
      // across both seeding paths. `ON CONFLICT` names that index rather than being
      // bare, so only a content collision is swallowed and a genuine constraint
      // problem still throws — and the collision it swallows is real: a parent may
      // legitimately hold two byte-identical rows (the fingerprint index is
      // per-campaign, and a row with a NULL fingerprint sits outside it), which
      // would otherwise 23505 the transaction.
      //
      // ── The omitted columns are the retry reset ─────────────────────────
      //
      // `state`, `attempt_count`, `our_fault_attempts`, `next_attempt_at`,
      // `last_outcome`, `last_disposition` and `suppressed_reason` are all absent
      // and take their column defaults — `pending`, `0`, `0`, `now()`, NULL, NULL,
      // NULL. A retry campaign is a FRESH ALLOWANCE, which is the whole point of a
      // supervisor authoring one.
      //
      // ⚠️ That includes `our_fault_attempts`, which is bounded by
      // `OUR_FAULT_REDIAL_BOUND` — a regulated repeat-dial limit no campaign config
      // can raise — and which therefore DOES reset per retry campaign. Three retry
      // campaigns is nine our-fault redials on one number. The bound exists to stop
      // one broken agent workstation redialling without limit inside a single run,
      // which a supervisor deliberately authoring a second campaign is not; but it
      // is now technically reachable, and it is left as an open compliance
      // decision rather than quietly settled here. Do not "fix" it by carrying the
      // counter across — that is a decision about a regulation nobody has
      // established, not an implementation detail.
      //
      // `root_contact_id` is passed through explicitly, which is what makes a
      // generation-3 contact still point at generation 0; `trg_agency_contacts_root`
      // only fires when the column arrives NULL, so it leaves these rows alone.
      const seedParams = params();
      const childId = seedParams.add(campaign.id);
      const seedConditions = [
        `c.campaign_id = ${seedParams.add(input.parent.id)}`,
        ...retrySelectionConditions(input.selector, 'c', seedParams),
        `NOT (${neverSeededSuppressionSql('c')})`,
      ];
      const seeded = await client.query(
        `INSERT INTO agency_contacts
             (campaign_id, tenant_id, account_id, phone_e164, context, timezone,
              csv_line_number, row_fingerprint, source_contact_id, root_contact_id)
           SELECT ${childId}, c.tenant_id, c.account_id, c.phone_e164, c.context, c.timezone,
                  c.csv_line_number,
                  agency_contact_row_fingerprint(c.phone_e164, c.context, c.timezone),
                  c.id,
                  c.root_contact_id
             FROM agency_contacts c
            WHERE ${seedConditions.join(' AND ')}
           ON CONFLICT (campaign_id, row_fingerprint) WHERE row_fingerprint IS NOT NULL
             DO NOTHING`,
        seedParams.values,
      );

      // Incremented by what the seed wrote, NOT recounted — unlike
      // `applyIngestChunk`, whose COUNT is what self-heals a roster other
      // transactions also write. This roster cannot have another writer: the
      // child campaign row was created by THIS transaction and is invisible to
      // every other one until COMMIT, so no other statement can insert a contact
      // referencing it, and its contacts are exactly the rows `seeded` inserted.
      // A COUNT here would rescan up to `RETRY_MAX_SEED_ROWS` rows to learn
      // `seeded.rowCount`. `contacts_total +` rather than `=` so the column still
      // reads "every row on this roster" if a later step ever adds rows first.
      const seededRows = seeded.rowCount ?? 0;

      const totalled = await client.query<AgencyCampaignRecord>(
        `UPDATE agency_campaigns
              SET contacts_total = contacts_total + $2,
                  updated_at = now()
            WHERE id = $1
          RETURNING *`,
        [campaign.id, seededRows],
      );

      return {
        status: 'created',
        // The row AFTER the `contacts_total` write, not `created.rows[0]` — that one
        // still says 0, and it is what the route serialises straight back to the
        // console as the new campaign. `RETURNING *` rather than a second SELECT so
        // there is no window in which the two could disagree.
        campaign: totalled.rows[0] ?? campaign,
        contacts_seeded: seededRows,
        // Under REPEATABLE READ both numbers come from ONE snapshot, so this is a
        // real count of collapsed duplicates and never a race between two reads.
        // `Math.max(…, 0)` is belt and braces: negative would mean the seed wrote
        // rows the count did not match, which is a defect rather than a number to
        // publish.
        duplicates_collapsed: Math.max(matchedRows - seededRows, 0),
        excluded,
      };
    }, { pool, isolation: 'REPEATABLE READ' });
  } catch (err) {
    // ── The race the fast path cannot close ─────────────────────────────────
    //
    // Two requests carrying one key can both miss the pre-check and reach the
    // INSERT; the unique index lets exactly one through and answers the other
    // `23505`. That loser has created NOTHING (`withTransaction` has rolled the
    // whole transaction back and released its client), so the correct answer is the winner's campaign — the same
    // answer the fast path gives, arrived at a few milliseconds later.
    //
    // Matched on the CONSTRAINT NAME, never on the message text: another unique
    // index on this table (a future one, or `uq_agency_campaign_running` if the
    // shape of this statement ever changes) must not be silently reported as a
    // successful replay of somebody else's campaign.
    if (input.idempotencyKey && isUniqueViolation(err, 'uq_agency_campaign_retry_idempotency')) {
      const winner = await repo.findByRetryIdempotencyKey(
        input.parent.tenant_id, input.parent.account_id, input.idempotencyKey,
      );
      // The row must exist — we just collided with it — but a `null` here would
      // mean the winner was deleted between the collision and this read, and
      // inventing a campaign to return would be worse than surfacing the error.
      if (winner) return { status: 'replayed', campaign: winner };
    }
    throw err;
  }
}

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAgencyCampaign } from './agency-factories.js';
// Type-only, so it does not run before the `vi.mock` calls below the way a value
// import of the model's module graph would.
import type { AgencyContactInput } from '../../../src/db/models/agency.model.js';
import { DEFAULTS } from '../setup/factories.js';

vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));
const { agencyContactRepository } = await import(
  '../../../src/db/repositories/agency.repository.js'
);

/**
 * Roster-ingest idempotency — C21 and the M1 carried gap.
 *
 * ── What was already covered, and what was not ─────────────────────────────
 * Both halves are tested in isolation elsewhere: the chunk-key builder
 * (`rosterChunkKey`) at the unit tier, and the UNIQUE index at the repository tier.
 * The failure covered here is the CROSS-LAYER one — the public API layer dying *after* the
 * roster committed a chunk and *before* the job recorded it, then coming back. Nothing
 * exercised that seam, and it is the only one that can duplicate a contact,
 * because a duplicated contact dials twice down two independent attempt chains
 * that `uq_agency_attempt_live` cannot join (two different `contact_id`s).
 *
 * ── There are TWO mechanisms here and this file refuses to conflate them ───
 * Migration 077 introduces `agency_ingest_chunks`, keyed `{ingest_job_id}-
 * {chunk_index}`, and calls the row-level unique index "defence in depth beneath
 * that". A test that only asserts "the contact count did not change" passes
 * whichever layer fired — and therefore proves nothing about either. Every arm
 * below states which layer it is falsifying, and the restart arm asserts on
 * `duplicate_chunk` specifically so that the answer to "which one caught it" is
 * written into the test rather than inferred.
 *
 * That distinction is not academic. The public API layer builds the key from `job.id`
 * (`agency-ingest.service.ts` → `ingestJobId: job.id`) and NEVER reuses a job
 * id across a restart: `reapStaleJobs()` fails every live job at boot and
 * `POST /ingest/jobs` always creates a fresh row. So the chunk-key layer cannot
 * fire for the restart case at all, and the row-level index is carrying it
 * alone. `it('re-upload after a caller restart …')` is where that is pinned.
 *
 * That index is `uq_agency_contacts_row_fingerprint` (083), not 073's
 * `uq_agency_contacts_source_row`. 073 keyed on the row's position in the file,
 * which made a second CSV's lines collide with the first's and silently
 * discarded every top-up; 083 keys on the row's CONTENT, which refuses the
 * same restart re-upload while letting a genuinely new file land. Read 083's
 * header before touching any arm here — "namespace it per ingest job" is the
 * intuitive fix and it gives away exactly the guarantee this file exists for.
 *
 * ── Cleanup ───────────────────────────────────────────────────────────────
 * `beforeEach(truncateAll)` only, matching the sibling agency files. Nothing
 * here starts a dialer, a lease renewer or a timer, so there is no live
 * resource needing an `afterEach` teardown — and no test body does its own
 * cleanup, which is the failure mode that reddened T-L2 earlier.
 */

const TENANT = DEFAULTS.tenantId;
const ACCOUNT = DEFAULTS.accountId;

/**
 * One chunk's worth of contacts.
 *
 * `source_row_number` is derived from the row's position in the FILE, exactly
 * as the public API layer derives it (`startLine`), because that is the property the
 * row-level index keys on and the whole point is that it is stable across
 * runs while the job id is not.
 */
function chunkContacts(chunkIndex: number, size: number, phonePrefix = '+91900') {
  const firstRow = chunkIndex * size + 1;
  return Array.from({ length: size }, (_, i) => {
    const row = firstRow + i;
    return {
      phone_e164: `${phonePrefix}${row.toString().padStart(7, '0')}`,
      context: { name: `Person ${row}` },
      source_row_number: row,
    };
  });
}

async function apply(
  campaignId: string,
  ingestJobId: string,
  chunkIndex: number,
  // The REPOSITORY's own input type, not `ReturnType<typeof chunkContacts>`.
  // Deriving it from the happy-path helper made the parameter narrower than the
  // function under test — a contact whose `context` is `{}` (which the poison-row
  // case below needs, and which production certainly produces) was a type error at
  // the call site, so the helper's shape was quietly acting as a schema. The point
  // of a test tier is to be able to hand the real function the inputs it really
  // takes.
  contacts: AgencyContactInput[],
  chunkCount: number | null = null,
) {
  return agencyContactRepository.applyIngestChunk({
    campaignId,
    tenantId: TENANT,
    accountId: ACCOUNT,
    ingestJobId,
    chunkIndex,
    chunkCount,
    idempotencyKey: `${ingestJobId}-${chunkIndex}`,
    contacts,
  });
}

async function contactCount(campaignId: string): Promise<number> {
  const { rows } = await getTestPool().query<{ n: string }>(
    'SELECT COUNT(*)::text AS n FROM agency_contacts WHERE campaign_id = $1',
    [campaignId],
  );
  return Number(rows[0]!.n);
}

async function markerCount(campaignId: string): Promise<number> {
  const { rows } = await getTestPool().query<{ n: string }>(
    'SELECT COUNT(*)::text AS n FROM agency_ingest_chunks WHERE campaign_id = $1',
    [campaignId],
  );
  return Number(rows[0]!.n);
}

async function contactsTotal(campaignId: string): Promise<number> {
  const { rows } = await getTestPool().query<{ contacts_total: number }>(
    'SELECT contacts_total FROM agency_campaigns WHERE id = $1',
    [campaignId],
  );
  return rows[0]!.contacts_total;
}

describe('agency roster-ingest idempotency (integration)', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  // ── Layer 1: the chunk key, where it genuinely applies ───────────────────

  it('C21 — the same 500-row chunk sent twice leaves 500 contacts, not 1000', async () => {
    const campaign = await insertAgencyCampaign();
    const contacts = chunkContacts(0, 500);

    const first = await apply(campaign.id, 'job-A', 0, contacts);
    const second = await apply(campaign.id, 'job-A', 0, contacts);

    expect(first).toMatchObject({ accepted: 500, duplicate_chunk: false, total_contacts: 500 });
    // The whole replay costs ONE conflict, not 500 upserts — `accepted: 0` with
    // `duplicate_chunk: true` is the marker refusing before any row is touched.
    expect(second).toMatchObject({ accepted: 0, duplicate_chunk: true, total_contacts: 500 });

    expect(await contactCount(campaign.id)).toBe(500);
    expect(await markerCount(campaign.id)).toBe(1);
    expect(await contactsTotal(campaign.id)).toBe(500);
  });

  it('distinct chunks of one job all land; only a repeat is refused', async () => {
    const campaign = await insertAgencyCampaign();

    expect((await apply(campaign.id, 'job-A', 0, chunkContacts(0, 5))).accepted).toBe(5);
    expect((await apply(campaign.id, 'job-A', 1, chunkContacts(1, 5))).accepted).toBe(5);
    expect((await apply(campaign.id, 'job-A', 2, chunkContacts(2, 5))).accepted).toBe(5);
    // Chunk 1 again — same job, same index, same key.
    expect(await apply(campaign.id, 'job-A', 1, chunkContacts(1, 5))).toMatchObject({
      accepted: 0,
      duplicate_chunk: true,
    });

    expect(await contactCount(campaign.id)).toBe(15);
    expect(await contactsTotal(campaign.id)).toBe(15);
  });

  it('the same chunk index under a DIFFERENT campaign is not a replay', async () => {
    // The UNIQUE is `(campaign_id, idempotency_key)`. Two campaigns ingesting
    // concurrently must not deduplicate against each other — if this ever fails,
    // one customer's roster is silently swallowing another's.
    const a = await insertAgencyCampaign();
    const b = await insertAgencyCampaign();

    expect((await apply(a.id, 'job-A', 0, chunkContacts(0, 5))).accepted).toBe(5);
    expect(await apply(b.id, 'job-A', 0, chunkContacts(0, 5))).toMatchObject({
      accepted: 5,
      duplicate_chunk: false,
    });

    expect(await contactCount(a.id)).toBe(5);
    expect(await contactCount(b.id)).toBe(5);
  });

  // ── The carried gap: the public API layer dies mid-ingest, restarts, re-runs ───────────

  it('re-upload after a caller restart does not duplicate — but it is the ROW index, not the chunk key, that stops it', async () => {
    const campaign = await insertAgencyCampaign();

    // Run 1. The roster commits chunks 0 and 1. The caller is killed here — before it
    // wrote `chunks_sent`, so from the caller's side these two chunks never
    // happened. This is precisely the failure mode being covered.
    const jobOne = randomUUID();
    await apply(campaign.id, jobOne, 0, chunkContacts(0, 5));
    await apply(campaign.id, jobOne, 1, chunkContacts(1, 5));
    expect(await contactCount(campaign.id)).toBe(10);

    // Restart. `reapStaleJobs()` fails jobOne; the operator re-uploads THE SAME
    // FILE, which mints a NEW job row and therefore a new UUID. Run 2 streams
    // the file from the beginning: chunks 0 and 1 are re-sent, and chunk 2 —
    // which run 1 never reached — is new.
    const jobTwo = randomUUID();
    const replay0 = await apply(campaign.id, jobTwo, 0, chunkContacts(0, 5));
    const replay1 = await apply(campaign.id, jobTwo, 1, chunkContacts(1, 5));
    const fresh2 = await apply(campaign.id, jobTwo, 2, chunkContacts(2, 5));

    // The assertion the gap asks for: the roster is 15, not 25.
    expect(await contactCount(campaign.id)).toBe(15);
    expect(await contactsTotal(campaign.id)).toBe(15);

    // And the assertion that says WHICH mechanism earned that number.
    //
    // `duplicate_chunk: false` on both replays is the chunk-key layer failing to
    // recognise them — a new job id means a new key, and the UNIQUE on
    // `(campaign_id, idempotency_key)` has nothing to match. `accepted: 0` is
    // `uq_agency_contacts_row_fingerprint` + `ON CONFLICT DO NOTHING` swallowing
    // all ten rows one at a time — the re-uploaded file carries byte-identical
    // rows, which is exactly what the content key recognises. The count is
    // protected; the mechanism 077 was written for is not participating.
    //
    // If the public API layer is ever changed to resume a job id across a restart, these two
    // flip to `true` and this test fails. That failure is GOOD — flip the
    // expectation and delete this comment, because it means the primary layer
    // came alive.
    //
    // `rejected_duplicate_rows` makes the attribution explicit rather than
    // inferred: 5 rows refused per replay is the ROW index firing, while
    // `duplicate_chunk: false` is the chunk key not firing. Before that field
    // existed the only evidence was a contact count that both layers would
    // have produced identically.
    expect(replay0).toMatchObject({ accepted: 0, duplicate_chunk: false, rejected_duplicate_rows: 5 });
    expect(replay1).toMatchObject({ accepted: 0, duplicate_chunk: false, rejected_duplicate_rows: 5 });
    expect(fresh2).toMatchObject({ accepted: 5, duplicate_chunk: false, rejected_duplicate_rows: 0 });
    // The refused row numbers are named back, so the public API layer can tell the operator
    // which rows collided instead of just "0 accepted".
    expect(replay0.duplicate_source_rows).toEqual([1, 2, 3, 4, 5]);

    // Five markers (2 from run 1, 3 from run 2) for three chunks of real work:
    // two jobs' worth of bookkeeping for one roster, with no marker in run 2
    // recognising its counterpart in run 1. That arithmetic IS the symptom —
    // under a resumable job id it would be 3.
    expect(await markerCount(campaign.id)).toBe(5);
  });

  it('a re-upload that repeats the whole file adds nothing', async () => {
    // The blunt form of the same thing: the operator does not know how far the
    // first run got, so they re-upload and it starts over. Every chunk is a
    // replay under a fresh job id.
    const campaign = await insertAgencyCampaign();
    const jobOne = randomUUID();
    for (let i = 0; i < 4; i++) await apply(campaign.id, jobOne, i, chunkContacts(i, 25));
    expect(await contactCount(campaign.id)).toBe(100);

    const jobTwo = randomUUID();
    let accepted = 0;
    for (let i = 0; i < 4; i++) {
      accepted += (await apply(campaign.id, jobTwo, i, chunkContacts(i, 25))).accepted;
    }

    expect(accepted).toBe(0);
    expect(await contactCount(campaign.id)).toBe(100);
    expect(await contactsTotal(campaign.id)).toBe(100);
  });

  // ── FINDING, in two tests: what happens today, and what must happen ─────

  /**
   * The requirement, written as a test that is RED by construction.
   *
   * What a re-upload into a populated campaign should *mean* is an open product
   * decision — refusing it, upserting over it and replacing it are three
   * different products, and only one of them is a bug fix. So this asserts the
   * one property that holds under ALL THREE candidates and fails under today's
   * behaviour: **the operator is never silently told it worked**.
   *
   *   - refuse  ⇒ the call reports a conflict, and the correction did not land
   *   - upsert  ⇒ the corrected numbers are what the campaign will dial
   *   - replace ⇒ likewise
   *   - today   ⇒ neither: `accepted: 0`, `duplicate_chunk: false`, no error,
   *               and the uncorrected numbers stay on the roster
   *
   * `it.fails` inverts the result, so this is green while the defect exists and
   * goes RED the moment it is fixed — at which point delete the `.fails` and
   * tighten the assertion to whichever product was chosen. That is deliberate:
   * it makes the fix prove itself instead of being asserted, and it cannot rot
   * quietly the way a characterization test can.
   *
   * **MET, and the `.fails` is gone.** The product decision was
   * "refuse, do not merge", and the repository now reports
   * `rejected_duplicate_rows` + `duplicate_source_rows` alongside `accepted`, so
   * the public API layer can name the colliding rows to the operator.
   *
   * **REOPENED, and re-answered differently, by migration 083.** "Refuse"
   * was never a product decision so much as a consequence of keying identity on
   * `source_row_number` — and that key also made `AgencyCampaignContactsPage`,
   * whose entire purpose is adding contacts to a live campaign, silently discard
   * every row. Both behaviours are the one key: a second file's lines 2..N are
   * the first file's lines 2..N. They cannot be separated schematically, because
   * the roster cannot tell a CORRECTION from a TOP-UP — only the public API layer knows which the
   * operator meant.
   *
   * So 083 keys on the row's CONTENT and the answer here becomes "upsert": the
   * corrected rows land. The invariant below still holds — the caller is told
   * truthfully that 5 rows landed — but the *roster* is now half-corrected,
   * which rightly calls worse than an uncorrected one. That residual is
   * asserted explicitly in the test after this one, and it is the caller's to close
   * (a confirmation on top-up into a populated campaign, or a replace-roster
   * mode). The roster will not guess.
   */
  it('a corrected re-upload either lands or reports a conflict — never a silent no-op', async () => {
    const campaign = await insertAgencyCampaign();

    await apply(campaign.id, randomUUID(), 0, chunkContacts(0, 5, '+91900'));

    let reportedConflict = false;
    let result: Awaited<ReturnType<typeof apply>> | undefined;
    try {
      result = await apply(campaign.id, randomUUID(), 0, chunkContacts(0, 5, '+12025'));
    } catch {
      // "refuse" — a thrown/4xx conflict is an acceptable answer.
      reportedConflict = true;
    }

    if (!reportedConflict) {
      const { rows } = await getTestPool().query<{ phone_e164: string }>(
        'SELECT phone_e164 FROM agency_contacts WHERE campaign_id = $1',
        [campaign.id],
      );
      // Any honest signal counts. Under 083 it is `accepted`: the corrected rows
      // genuinely landed and the count says so. What must NOT satisfy this is
      // the pre-083 shape — a bare `accepted: 0` with no discriminator, which is
      // "fresh, empty work" and is indistinguishable from success.
      const r = (result ?? {}) as Record<string, unknown>;
      const correctionLanded =
        rows.some((row) => row.phone_e164.startsWith('+12025')) &&
        ((r['accepted'] as number | undefined) ?? 0) > 0;
      const signalled =
        r['duplicate_chunk'] === true ||
        ((r['rejected_duplicate_rows'] as number | undefined) ?? 0) > 0;
      expect(correctionLanded || signalled).toBe(true);
    }
  });

  it('a corrected re-upload MERGES — and the wrong numbers are still dialable (open, caller-side)', async () => {
    // The scenario is ordinary: the operator picks the wrong `phone_column`, or
    // leaves `default_country_code` at the platform default so a US list
    // normalises to +91. They notice, fix the mapping, and
    // re-upload the same file.
    //
    // Under 073's `(campaign_id, source_row_number)` every corrected row
    // collided and the campaign kept its original numbers. Under 083's content
    // key the corrected rows have different content, so they land ALONGSIDE the
    // uncorrected ones — ten rows where the operator has five people, five of
    // which dial the wrong country.
    //
    // **It takes 083 AND 085 for this to be true, which this test is what proved.**
    // With 083 alone it failed here with 23505 on `uq_agency_contacts_source_row`:
    // the corrected rows reuse lines 1..5, that index is still live (it cannot be
    // dropped until no pre-083 replica can serve a request), and the new INSERT
    // infers the FINGERPRINT index so the violation is no longer swallowed. 085
    // leaves `source_row_number` NULL — the old index is partial on NOT NULL — and
    // moves the CSV line to `csv_line_number`.
    //
    // This is asserted rather than left implicit because it is the price of
    // 083 and somebody has to be able to see it in a test. It is NOT fixable in
    // the roster: a corrected re-upload and a legitimate top-up are the same request,
    // and only the public API layer — which holds the file, the mapping and the operator's
    // intent — can tell them apart. The close is a confirmation step (or a
    // replace-roster mode) on the top-up flow.
    const campaign = await insertAgencyCampaign();

    // First pass: wrong country code.
    await apply(campaign.id, randomUUID(), 0, chunkContacts(0, 5, '+91900'));
    // Second pass: same file, same rows, corrected to US numbers.
    const corrected = await apply(campaign.id, randomUUID(), 0, chunkContacts(0, 5, '+12025'));

    // Truthfully reported — five rows really were written.
    expect(corrected).toMatchObject({
      accepted: 5,
      duplicate_chunk: false,
      rejected_duplicate_rows: 0,
    });
    expect(corrected.duplicate_source_rows).toEqual([]);
    expect(await contactCount(campaign.id)).toBe(10);

    const { rows } = await getTestPool().query<{ phone_e164: string }>(
      'SELECT phone_e164 FROM agency_contacts WHERE campaign_id = $1',
      [campaign.id],
    );
    expect(rows.filter((r) => r.phone_e164.startsWith('+12025'))).toHaveLength(5);
    // The residual, stated: the uncorrected numbers survived and will be dialed.
    expect(rows.filter((r) => r.phone_e164.startsWith('+91900'))).toHaveLength(5);
  });

  it('a genuine top-up lands — the whole point of migration 083', async () => {
    // The defect 083 exists for. `AgencyCampaignContactsPage` adds contacts to a
    // live campaign, and a second CSV starts at line 1 like every CSV — so under
    // `(campaign_id, source_row_number)` every one of its rows collided with a
    // row of the first file and was discarded, while the public API layer (which dropped the
    // rejection counts) reported that all of them landed.
    //
    // Different people, same line numbers: that combination is the whole defect,
    // so the second file deliberately reuses rows 1..5.
    //
    // And it is why 083 alone did not fix it. Reusing lines 1..5 collided on 073's
    // still-live `uq_agency_contacts_source_row`, and once the INSERT infers the
    // fingerprint index instead, that 23505 aborts the chunk rather than being
    // swallowed — so the defect changed shape (silent discard → 500) without going
    // away. 085 is what makes this green in THIS release: new rows store NULL in
    // `source_row_number`, which is outside that partial index, and the CSV line
    // lives in `csv_line_number`.
    const campaign = await insertAgencyCampaign();

    const first = await apply(campaign.id, randomUUID(), 0, chunkContacts(0, 5, '+91900'));
    const topUp = await apply(campaign.id, randomUUID(), 0, chunkContacts(0, 5, '+91911'));

    expect(first).toMatchObject({ accepted: 5, rejected_duplicate_rows: 0 });
    expect(topUp).toMatchObject({ accepted: 5, duplicate_chunk: false, rejected_duplicate_rows: 0 });
    expect(await contactCount(campaign.id)).toBe(10);
    expect(await contactsTotal(campaign.id)).toBe(10);
  });

  it('a discarded row is distinguishable from an empty chunk, including a PARTIAL collision', async () => {
    // This was a finding and is now a guarantee. Three outcomes used
    // to return an identical body, and one of them is routine traffic:
    //
    //   1. the empty terminator chunk the public API layer sends on EVERY ingest  → accepted: 0
    //   2. a re-sent file, every row discarded                       → accepted: 0
    //   3. a PARTIAL collision, some rows discarded                  → accepted: n
    //
    // (3) was the worst, because neither side could see it: `accepted: 3` from
    // an eight-row chunk was indistinguishable from a chunk that only ever held
    // three rows. All three are now separable, and the partial case is asserted
    // explicitly because it is the one no count alone can catch.
    //
    // Since 083 a discarded row is one the roster already holds EXACTLY, so
    // the discarded arms below re-send the identical rows rather than
    // differently-numbered ones — that is what a replay looks like now, and a
    // corrected re-upload is no longer one (see the merge test above).
    const campaign = await insertAgencyCampaign();
    await apply(campaign.id, randomUUID(), 0, chunkContacts(0, 5));

    // Both run against the same 5-contact roster, so the responses are
    // comparable field for field rather than only in shape.
    const emptyTerminator = await apply(campaign.id, randomUUID(), 9, []);
    const allDiscarded = await apply(campaign.id, randomUUID(), 0, chunkContacts(0, 5));

    expect(emptyTerminator).toEqual({
      accepted: 0,
      duplicate_chunk: false,
      total_contacts: 5,
      rejected_duplicate_rows: 0,
      duplicate_source_rows: [],
    });
    expect(allDiscarded).toMatchObject({ accepted: 0, rejected_duplicate_rows: 5 });
    // The distinction is the point: same `accepted`, different meaning.
    expect(allDiscarded).not.toEqual(emptyTerminator);
    expect(allDiscarded.accepted).toBe(emptyTerminator.accepted);

    // Partial: rows 1–5 already exist, rows 6–8 are new. Eight submitted, three
    // inserted, five refused — and the refusal is now reported rather than
    // hidden inside the difference between two numbers the caller never sees.
    const overlapping = [...chunkContacts(0, 5), ...chunkContacts(0, 8).slice(5)];
    expect(overlapping).toHaveLength(8);
    const partial = await apply(campaign.id, randomUUID(), 0, overlapping);
    expect(partial).toMatchObject({ accepted: 3, rejected_duplicate_rows: 5 });
    expect(partial.duplicate_source_rows).toEqual([1, 2, 3, 4, 5]);
    // Submitted reconciles exactly: nothing is unaccounted for.
    expect(partial.accepted + partial.rejected_duplicate_rows).toBe(overlapping.length);
  });

  // ── Layer 3: the chunk is all-or-nothing ────────────────────────────────

  it('a chunk that fails mid-insert leaves neither rows nor a marker', async () => {
    // 077's header claims "the chunk marker and its rows are inserted in ONE
    // transaction, so partial application is impossible rather than merely
    // detectable". Asserted here rather than trusted, because the dangerous
    // shape is the inverse — a marker that committed without its rows, which
    // would make the chunk permanently un-resendable and silently short the
    // roster by up to 500 contacts with `roster_complete: true`.
    //
    // The failure is induced with a NULL phone, which violates NOT NULL and is
    // NOT swallowed by the bare `ON CONFLICT DO NOTHING`.
    const campaign = await insertAgencyCampaign();
    const poisoned = [
      ...chunkContacts(0, 3),
      { phone_e164: null as unknown as string, context: {}, source_row_number: 4 },
      ...chunkContacts(0, 1).map((c) => ({ ...c, source_row_number: 5 })),
    ];

    await expect(apply(campaign.id, 'job-A', 0, poisoned)).rejects.toThrow();

    expect(await contactCount(campaign.id)).toBe(0);
    expect(await markerCount(campaign.id)).toBe(0);

    // And the key is still usable — no stranded marker blocking the retry that
    // is supposed to fix it.
    const retry = await apply(campaign.id, 'job-A', 0, chunkContacts(0, 5));
    expect(retry).toMatchObject({ accepted: 5, duplicate_chunk: false });
    expect(await contactCount(campaign.id)).toBe(5);
  });

  // ── Completeness reporting on the final chunk ───────────────────────────

  it('a lost chunk is reported as a gap, not as a complete roster', async () => {
    // Without this, a chunk the public API layer believed it sent leaves a campaign short and
    // startable — it dials a partial list and nothing says so.
    const campaign = await insertAgencyCampaign();
    const job = randomUUID();

    await apply(campaign.id, job, 0, chunkContacts(0, 5));
    // chunk 1 is lost in flight
    await apply(campaign.id, job, 2, chunkContacts(2, 5));

    expect(await agencyContactRepository.missingChunks(campaign.id, job, 3)).toEqual([1]);

    // The public API layer re-sends precisely the gap.
    await apply(campaign.id, job, 1, chunkContacts(1, 5));
    expect(await agencyContactRepository.missingChunks(campaign.id, job, 3)).toEqual([]);
    expect(await contactCount(campaign.id)).toBe(15);
  });

  it('completeness is scoped to one job id, so a restart cannot inherit the other job’s chunks', async () => {
    // The corollary of the finding above, stated as an assertion: because
    // `missingChunks` filters on `ingest_job_id`, run 2 sees none of run 1's
    // markers. Run 2 must therefore re-send every chunk to report complete —
    // which is why the row-level index gets exercised on every restart.
    const campaign = await insertAgencyCampaign();
    const jobOne = randomUUID();
    await apply(campaign.id, jobOne, 0, chunkContacts(0, 5));
    await apply(campaign.id, jobOne, 1, chunkContacts(1, 5));

    const jobTwo = randomUUID();
    expect(await agencyContactRepository.missingChunks(campaign.id, jobTwo, 2)).toEqual([0, 1]);
  });

  // ── Reconciliation ──────────────────────────────────────────────────────

  it('contacts_total always equals the real row count, across replays and gaps', async () => {
    // `contacts_total` drives the completion predicate and the operator's
    // progress bar. It is recomputed as a COUNT rather than incremented, which
    // is what makes it self-healing under replay — asserted so nobody
    // "optimises" it into an increment.
    const campaign = await insertAgencyCampaign();
    const jobOne = randomUUID();
    await apply(campaign.id, jobOne, 0, chunkContacts(0, 10));
    await apply(campaign.id, jobOne, 0, chunkContacts(0, 10)); // same-job replay
    await apply(campaign.id, randomUUID(), 0, chunkContacts(0, 10)); // cross-job replay
    await apply(campaign.id, jobOne, 1, chunkContacts(1, 10));

    expect(await contactsTotal(campaign.id)).toBe(await contactCount(campaign.id));
    expect(await contactsTotal(campaign.id)).toBe(20);
  });
});

import { getPool } from '@magick-agency/db';

/**
 * Which rows of an import the campaign's roster already holds (IM3): the reads behind
 * the ingest's "already in this campaign, skipped" (`src/agency/agency-ingest-screen.ts`).
 *
 * Every read counts only contacts written before the import job began: `created_at`
 * below the job row's own `created_at`, read from the row in the same statement (a JS
 * `Date` would cut it to the millisecond and miss a contact written in that millisecond).
 * That keeps a check and the import it previews reading the same roster, and keeps an
 * import from finding the rows it wrote itself (a later row of the same file is the
 * in-file duplicate check's business, which the check answers identically). One import
 * runs per campaign at a time (`AgencyIngestJobRepository.createExclusive`), so no other
 * import's rows land while it runs. Contacts are written only by the ingest and by retry
 * seeding into a NEW campaign, so `created_at` is a complete answer.
 */
const BEFORE_JOB = (param: string) =>
  `(SELECT j.created_at FROM agency_ingest_jobs j WHERE j.id = ${param}::uuid)`;

export class AgencyRosterPresenceRepository {
  /**
   * The numbers (as their digits) among `numberDigits` that a contact of the campaign
   * carries. Served by `idx_agency_contacts_campaign_phone_digits` (the claim's digit
   * projection, spelled byte-identically so the index matches).
   */
  async phonesPresent(campaignId: string, jobId: string, numberDigits: readonly string[]): Promise<Set<string>> {
    if (numberDigits.length === 0) return new Set();
    const { rows } = await getPool().query<{ d: string }>(
      `SELECT DISTINCT regexp_replace(phone_e164, '[^0-9]', '', 'g') AS d
         FROM agency_contacts
        WHERE campaign_id = $1::uuid
          AND regexp_replace(phone_e164, '[^0-9]', '', 'g') = ANY($2::text[])
          AND created_at < ${BEFORE_JOB('$3')}`,
      [campaignId, numberDigits as string[], jobId],
    );
    return new Set(rows.map((r) => r.d));
  }

  /**
   * The 0-based positions of `rows` the roster holds EXACTLY: the same
   * `agency_contact_row_fingerprint` (phone, context, timezone) the insert's
   * `uq_agency_contacts_row_fingerprint` refuses, computed by the same SQL function
   * from the same values, and served by that unique index.
   */
  async exactRowsPresent(
    campaignId: string,
    jobId: string,
    rows: ReadonlyArray<{ phone_e164: string; context: Record<string, string>; timezone?: string }>,
  ): Promise<Set<number>> {
    if (rows.length === 0) return new Set();
    const result = await getPool().query<{ ord: string }>(
      `SELECT u.ord
         FROM unnest($2::varchar[], $3::jsonb[], $4::varchar[]) WITH ORDINALITY AS u(phone_e164, context, timezone, ord)
        WHERE EXISTS (
          SELECT 1 FROM agency_contacts c
           WHERE c.campaign_id = $1::uuid
             AND c.row_fingerprint = agency_contact_row_fingerprint(u.phone_e164, u.context, u.timezone)
             AND c.created_at < ${BEFORE_JOB('$5')})`,
      [
        campaignId,
        rows.map((r) => r.phone_e164),
        rows.map((r) => JSON.stringify(r.context ?? {})),
        rows.map((r) => r.timezone ?? null),
        jobId,
      ],
    );
    return new Set(result.rows.map((r) => Number(r.ord) - 1));
  }

  /**
   * One page of the campaign's duplicate-key parts: for each key column the
   * contact's value under the context key that names it (matched trimmed and
   * case-insensitive, as the ingest resolves a column), or its number for a phone
   * part. Paged newest first on `(created_at, id)`, which
   * `idx_agency_contacts_reporting` serves, so a million-contact roster is never
   * one result set and no page rescans the last. The cursor's `created_at` is the
   * column's text, full precision: a chunk's rows share one timestamp, and a cursor
   * cut to the millisecond would skip the rest of them.
   */
  async keyPartsPage(
    campaignId: string,
    jobId: string,
    columns: readonly string[],
    phoneParts: readonly boolean[],
    after: { created_at: string; id: string } | null,
    limit: number,
  ): Promise<Array<{ id: string; created_at: string; parts: Array<string | null> }>> {
    const { rows } = await getPool().query<{ id: string; created_at: string; parts: Array<string | null> }>(
      `SELECT c.id, c.created_at::text AS created_at,
              ARRAY(
                SELECT CASE WHEN k.is_phone THEN c.phone_e164
                            ELSE (SELECT e.value FROM jsonb_each_text(c.context) e
                                   WHERE lower(btrim(e.key)) = lower(btrim(k.name))
                                   ORDER BY e.key LIMIT 1) END
                  FROM unnest($3::text[], $4::boolean[]) WITH ORDINALITY AS k(name, is_phone, ord)
                 ORDER BY k.ord) AS parts
         FROM agency_contacts c
        WHERE c.campaign_id = $1::uuid
          AND c.created_at < ${BEFORE_JOB('$2')}
          AND ($5::timestamptz IS NULL OR (c.created_at, c.id) < ($5::timestamptz, $6::uuid))
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT $7`,
      [campaignId, jobId, columns as string[], phoneParts as boolean[], after?.created_at ?? null, after?.id ?? null, limit],
    );
    return rows;
  }
}

export const agencyRosterPresenceRepository = new AgencyRosterPresenceRepository();

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAgencyCampaign } from './agency-factories.js';
import type { AgencyContactInput } from '../../../src/db/models/agency.model.js';
import { DEFAULTS } from '../setup/factories.js';

vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));
const { agencyContactRepository } = await import('../../../src/db/repositories/agency.repository.js');

/**
 * ─── Which input row of a chunk lands, and what the refusal report names ──────
 *
 * `applyIngestChunk` writes a whole chunk in one `INSERT … SELECT FROM unnest(…)
 * WITH ORDINALITY … ON CONFLICT DO NOTHING`. These cases pin the per-row decision
 * it must reproduce exactly — the one a row-at-a-time loop made by construction:
 *
 *   * the FIRST input row of a fingerprint new to the roster lands, with ITS
 *     values (line number included), and every later copy in the same chunk is
 *     refused as a duplicate;
 *   * every input row of a fingerprint the roster already held is refused;
 *   * the sample names refused rows in INPUT order, skips rows that carry no
 *     line number (counted, not named), and stops at 20;
 *   * `accepted + rejected_duplicate_rows` is the chunk's length.
 */

const phone = (n: number) => `+91911${n.toString().padStart(7, '0')}`;
const row = (n: number, line: number | null, extra: Partial<AgencyContactInput> = {}): AgencyContactInput => ({
  phone_e164: phone(n), context: { name: `P${n}` }, source_row_number: line, ...extra,
} as AgencyContactInput);

async function apply(campaignId: string, contacts: AgencyContactInput[]) {
  const job = randomUUID();
  return agencyContactRepository.applyIngestChunk({
    campaignId, tenantId: DEFAULTS.tenantId, accountId: DEFAULTS.accountId,
    ingestJobId: job, chunkIndex: 0, chunkCount: 1, idempotencyKey: `${job}-0`, contacts,
  });
}

async function stored(campaignId: string) {
  const { rows } = await getTestPool().query<{ phone_e164: string; csv_line_number: number | null; timezone: string | null }>(
    `SELECT phone_e164, csv_line_number, timezone FROM agency_contacts
      WHERE campaign_id = $1 ORDER BY phone_e164, csv_line_number NULLS FIRST`,
    [campaignId],
  );
  return rows;
}

describe('roster ingest — the fate of each input row in one chunk (integration)', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  it('keeps the FIRST copy of a repeated row, refuses later copies and rows the roster already held', async () => {
    const campaign = await insertAgencyCampaign();
    await apply(campaign.id, [row(1, 1), row(2, 2)]);

    const result = await apply(campaign.id, [
      row(3, 10), // new
      row(1, 11), // already on the roster
      row(3, 12), // a second copy of line 10, same content
      row(4, null), // new, no line number
      row(4, null), // a copy of it — refused, counted, cannot be named
      row(2, 13), // already on the roster
      row(5, 14, { timezone: 'Asia/Kolkata' }), // new
      row(5, 15), // same phone, DIFFERENT content (no timezone) — a different row, lands
      row(3, 16), // a third copy
    ]);

    expect(result).toEqual({
      accepted: 4,
      duplicate_chunk: false,
      total_contacts: 6,
      rejected_duplicate_rows: 5,
      duplicate_source_rows: [11, 12, 13, 16],
    });
    expect(result.accepted + result.rejected_duplicate_rows).toBe(9);
    // The surviving copy is the FIRST one: line 10, not 12 or 16.
    expect(await stored(campaign.id)).toEqual([
      { phone_e164: phone(1), csv_line_number: 1, timezone: null },
      { phone_e164: phone(2), csv_line_number: 2, timezone: null },
      { phone_e164: phone(3), csv_line_number: 10, timezone: null },
      { phone_e164: phone(4), csv_line_number: null, timezone: null },
      { phone_e164: phone(5), csv_line_number: 14, timezone: 'Asia/Kolkata' },
      { phone_e164: phone(5), csv_line_number: 15, timezone: null },
    ]);
  });

  it('caps the named sample at 20, in input order, while counting every refusal', async () => {
    const campaign = await insertAgencyCampaign();
    const first = Array.from({ length: 30 }, (_, i) => row(i, i + 1));
    await apply(campaign.id, first);

    // The same 30 rows again, in REVERSE order: the sample follows this chunk's order.
    const result = await apply(campaign.id, [...first].reverse().map((c, i) => ({ ...c, source_row_number: 100 + i })));

    expect(result.accepted).toBe(0);
    expect(result.rejected_duplicate_rows).toBe(30);
    expect(result.duplicate_source_rows).toEqual(Array.from({ length: 20 }, (_, i) => 100 + i));
    // And what was stored on the marker is what was returned.
    const { rows } = await getTestPool().query<{ rejected_duplicate_rows: number; duplicate_source_rows: number[] }>(
      `SELECT rejected_duplicate_rows, duplicate_source_rows FROM agency_ingest_chunks
        WHERE campaign_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [campaign.id],
    );
    expect(rows[0]).toEqual({ rejected_duplicate_rows: 30, duplicate_source_rows: result.duplicate_source_rows });
  });

  it('stores context and timezone exactly as sent, quotes and backslashes included', async () => {
    const campaign = await insertAgencyCampaign();
    const context = { 'Full "Name"': 'O\'Brien \\ "Jr"', note: 'comma, {brace}' };
    const result = await apply(campaign.id, [row(7, 1, { context, timezone: 'America/New_York' })]);
    expect(result.accepted).toBe(1);
    const { rows } = await getTestPool().query<{ context: unknown; timezone: string; fp_matches: boolean }>(
      `SELECT context, timezone,
              row_fingerprint = agency_contact_row_fingerprint(phone_e164, context, timezone) AS fp_matches
         FROM agency_contacts WHERE campaign_id = $1`,
      [campaign.id],
    );
    expect(rows).toEqual([{ context, timezone: 'America/New_York', fp_matches: true }]);
  });

  it('an empty chunk writes no rows and reports the current total', async () => {
    const campaign = await insertAgencyCampaign();
    await apply(campaign.id, [row(1, 1)]);
    expect(await apply(campaign.id, [])).toEqual({
      accepted: 0, duplicate_chunk: false, total_contacts: 1, rejected_duplicate_rows: 0, duplicate_source_rows: [],
    });
  });
});

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * ─── roster row identity, the properties that survive the squash ───────
 *
 * These cases pin the REPOSITORY against the schema, and the baseline carries the same
 * objects: "hashes content only — never the row number" (read off the baseline's
 * `agency_contact_row_fingerprint`), "is the only definition of row identity the ingest
 * insert uses" and "EVERY INSERT into agency_contacts writes csv_line_number and NOT
 * source_row_number". The schema half is asserted against real Postgres by the ingest
 * suites (`agency-ingest-idempotency`, `agency-retry-seeding`) and by
 * `packages/db/test/integration/baseline.test.ts`.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINE = resolve(__dirname, '../../../../../packages/db/migrations/0001_baseline.sql');
// The repository is a folder behind the `agency.repository.ts` barrel. The ingest
// INSERT is still in the barrel; "every INSERT" reads the barrel and every
// file of the folder, so a writer added to any of them is seen.
const REPOSITORY_DIR = resolve(__dirname, '../../../src/db/repositories/agency');
const INGEST = resolve(__dirname, '../../../src/db/repositories/agency.repository.ts');
const BARREL = resolve(__dirname, '../../../src/db/repositories/agency.repository.ts');

const baseline = readFileSync(BASELINE, 'utf8');

/** The barrel plus every `.ts` file of the repository folder, concatenated. */
function wholeRepository(): string {
  const files = readdirSync(REPOSITORY_DIR).filter((f) => f.endsWith('.ts')).sort();
  // Non-vacuous: the folder holds the campaign retry (seeding) file.
  expect(files).toEqual(expect.arrayContaining(['campaign-retry.ts']));
  return [BARREL, ...files.map((f) => resolve(REPOSITORY_DIR, f))]
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
}

describe('roster row identity — repository against the schema', () => {
  it('hashes content only — never the row number', () => {
    const fn = /CREATE OR REPLACE FUNCTION agency_contact_row_fingerprint[\s\S]*?LANGUAGE sql[^;]*;/.exec(baseline)![0];
    expect(fn).toMatch(/p_phone/);
    expect(fn).toMatch(/p_context/);
    expect(fn).toMatch(/p_timezone/);
    // Folding `source_row_number` back in would make every row of a SECOND file
    // unique again and reinstate the defect in a form that looks like extra rigour.
    expect(fn).not.toMatch(/source_row_number/);
  });

  it('is the only definition of row identity the ingest insert uses', () => {
    // Cross-file, because the danger is drift: if the INSERT ever computes the
    // hash a different way from the stored function, rows and new rows stop being
    // comparable and the guard silently stops guarding a re-upload.
    // The chunk is one INSERT … SELECT over unnest(): the fingerprint is computed
    // from the same unnested columns that are stored, and it is THAT value the
    // row writes.
    const repository = readFileSync(INGEST, 'utf8');
    expect(repository).toContain(
      'agency_contact_row_fingerprint(u.phone_e164, u.context, u.timezone) AS fingerprint',
    );
    expect(repository).toMatch(
      /SELECT \$1::uuid, \$2::uuid, \$3::uuid,\s+i\.phone_e164, i\.context, i\.csv_line_number, i\.timezone, i\.fingerprint/,
    );
    expect(wholeRepository()).not.toMatch(/md5\(/);
  });

  it('EVERY INSERT into agency_contacts writes csv_line_number and NOT source_row_number', () => {
    const repository = wholeRepository();
    const inserts = repository.match(/INSERT INTO agency_contacts[\s\S]*?DO NOTHING/g) ?? [];
    // Both writers: `applyIngestChunk` (the CSV path) and `retryFromCampaign`
    // (the retry seeding path). Hard-coded so a third writer added without a
    // thought for this rule reds here rather than passing unexamined.
    expect(inserts, 'expected exactly the two known writers of agency_contacts').toHaveLength(2);
    for (const insert of inserts) {
      expect(insert).toContain('csv_line_number');
      expect(insert).not.toMatch(/source_row_number/);
      expect(insert).toContain('ON CONFLICT (campaign_id, row_fingerprint) WHERE row_fingerprint IS NOT NULL');
    }
  });
});

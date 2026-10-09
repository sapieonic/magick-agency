import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * ─── D1 — roster row identity, the properties that survive the squash ───────
 *
 * PORT NOTE (magick-agency, lane B1). Ported from core
 * test/unit/agency/roster-row-identity.test.ts@4850d1d9 (19 cases). Three are
 * kept, because they pin the REPOSITORY against the schema and the baseline
 * carries the same objects: "hashes content only — never the row number" (read off
 * the baseline's `agency_contact_row_fingerprint`), "is the only definition of row
 * identity the ingest insert uses" and "EVERY INSERT into agency_contacts writes
 * csv_line_number and NOT source_row_number".
 *
 * DELETED (16), because their subject is the text of migrations 083 and 085 — their
 * deploy-order prose, their expand-only statement list, their DROP-INDEX deferral —
 * and the build ships ONE baseline migration, no 083/085 files and no phased
 * deploy: "does NOT drop the file-position index — that is a phase-3, later-release
 * step", "contains only statements that are forward-compatible with pre-083 code",
 * "spells out the three-phase deploy sequence, since neither order is safe by
 * default", "no longer claims top-up is broken until phase 3 — 085 made that stale",
 * "replaces it with a PARTIAL unique index, which is why it cannot abort", "adds the
 * column nullable, so applying it under live replicas is inert", "backfills only
 * rows whose content is unique in their campaign", "declares the fingerprint STABLE
 * — not IMMUTABLE, which it cannot honour", "records that the index must become
 * liveness-partial before supersede lands", "states that content addressing
 * partially overrides `dedupe_phones = false`", "is not undone by a later
 * migration", and the 085 group ("adds the column nullable and defaultless…", "never
 * indexes it…", "contains only expand statements…", "states the deploy sequence in
 * BOTH directions…", "records that the old column and its index go together in phase
 * 3"). The schema half those migrations produced is asserted against real Postgres
 * by the ingest suites (`agency-ingest-idempotency`, `agency-retry-seeding`) and by
 * `packages/db/test/integration/baseline.test.ts`.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINE = resolve(__dirname, '../../../../../packages/db/migrations/0001_baseline.sql');
const REPOSITORY = resolve(__dirname, '../../../src/db/repositories/agency.repository.ts');

const baseline = readFileSync(BASELINE, 'utf8');

describe('roster row identity — repository against the schema', () => {
  it('hashes content only — never the row number', () => {
    const fn = /CREATE OR REPLACE FUNCTION agency_contact_row_fingerprint[\s\S]*?LANGUAGE sql[^;]*;/.exec(baseline)![0];
    expect(fn).toMatch(/p_phone/);
    expect(fn).toMatch(/p_context/);
    expect(fn).toMatch(/p_timezone/);
    // Folding `source_row_number` back in would make every row of a SECOND file
    // unique again and reinstate D1 in a form that looks like extra rigour.
    expect(fn).not.toMatch(/source_row_number/);
  });

  it('is the only definition of row identity the ingest insert uses', () => {
    // Cross-file, because the danger is drift: if the INSERT ever computes the
    // hash a different way from the stored function, rows and new rows stop being
    // comparable and the guard silently stops guarding a re-upload.
    const repository = readFileSync(REPOSITORY, 'utf8');
    expect(repository).toContain('agency_contact_row_fingerprint($4, $5::jsonb, $7)');
    expect(repository).not.toMatch(/md5\(/);
  });

  it('EVERY INSERT into agency_contacts writes csv_line_number and NOT source_row_number', () => {
    const repository = readFileSync(REPOSITORY, 'utf8');
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

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENCY_FACT_FIELDS_MAX } from '@magick-agency/contracts/agency';
import { parseContextFact, type ContextFactType } from '../../../src/context-facts';
import { configuredHeroNames, heroColumnsFor, MAX_HERO_FIELDS } from '../../../src/context-hero';
import {
  customerNameColumn, customerNameFrom, customerPlaceColumn, customerPlaceFrom, guessNameColumn, guessPlaceColumn,
  NAME_GUESS_COLUMNS,
} from '../../../src/customer-name';
import { legacyFactFields, scriptPieces, scriptPlaceholdersFor, uniqueFactLabels } from '../../../src/fact-fields';
import { formatFactPhone, maskFactPhone } from '../../../src/fact-phone';
import { chosenFactTiles } from '../../../src/fact-tiles';

/**
 * AS19 S5: the card's rules against the shared cases (`packages/contracts/fixtures/agent/fact-rules.json`),
 * which the agent app's Dart port runs too (`apps/mobile/packages/agency_wire/test/fact_rules_test.dart`).
 * Every case of every table, so a rule that drifts from the table fails here and there alike.
 */

type Row = Record<string, unknown>;
interface Rules {
  phone: Array<{ value: string; full: string; masked: string }>;
  parse: { now: string; cases: Array<{ raw: string; type: string; value: string | null }> };
  script_pieces: Array<{ text: string; allowed: string[]; pieces: unknown[] }>;
  script_placeholders: Array<{ display: unknown; placeholders: string[] }>;
  configured_heroes: Array<{ display: unknown; heroes: string[] }>;
  hero_columns: Array<{
    context: Row; display: unknown; column_order?: string[]; max?: number; fallback_to_first_columns?: boolean; heroes: string[];
  }>;
  guess_columns: Array<{ columns?: string[]; row?: Row; hidden?: string[]; exclude?: string[]; name: string | null; place: string | null }>;
  customer: Array<{
    context: Row; display: unknown; name: string | null; name_column: string | null; place: string | null; place_column: string | null;
  }>;
  chosen_fact_tiles: Array<{ context: Row; display: unknown; now: string; tiles: unknown[] }>;
  unique_fact_labels: Array<{ headers: string[]; taken: string[]; labels: string[] }>;
  legacy_fact_fields: Array<{ display: unknown; columns: string[] | null; facts: unknown[] }>;
}

const RULES = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../contracts/fixtures/agent/fact-rules.json'), 'utf8'),
) as Rules;

/** A case's title: its input as JSON, cut. */
const title = (value: unknown): string => {
  const text = JSON.stringify(value) ?? 'undefined';
  return text.length > 110 ? `${text.slice(0, 107)}...` : text;
};
const none = <T>(value: T | undefined): T | null => value ?? null;
/** A case's display as the rules take it: hand-edited JSON on purpose. */
const display = (value: unknown): any => value;

describe('fact-rules.json: the phone rule (R6, S3)', () => {
  it('holds R6\'s six rows and the threshold rows', () => {
    const values = RULES.phone.map((c) => c.value);
    for (const v of ['9876543210', '919876543210', '+919876543210', '09876543210', '1234567890', '+14155550123', '123456', '1234567']) {
      expect(values).toContain(v);
    }
  });
  it.each(RULES.phone.map((c) => [c.value, c] as const))('%j', (_v, c) => {
    expect(formatFactPhone(c.value)).toBe(c.full);
    expect(maskFactPhone(c.value)).toBe(c.masked);
  });
});

describe('fact-rules.json: the parse rule', () => {
  const now = new Date(RULES.parse.now);
  it.each(RULES.parse.cases.map((c) => [c.raw, c.type, c] as const))('%j as %s', (_r, _t, c) => {
    expect(parseContextFact(c.raw, c.type as ContextFactType, now)).toBe(c.value);
  });
});

describe('fact-rules.json: scriptPieces', () => {
  it.each(RULES.script_pieces.map((c) => [c.text, c] as const))('%j', (_t, c) => {
    expect(scriptPieces(c.text, c.allowed)).toEqual(c.pieces);
  });
});

describe('fact-rules.json: scriptPlaceholdersFor', () => {
  it.each(RULES.script_placeholders.map((c) => [title(c.display), c] as const))('%s', (_t, c) => {
    expect(scriptPlaceholdersFor(display(c.display))).toEqual(c.placeholders);
  });
});

describe('fact-rules.json: configuredHeroNames', () => {
  it.each(RULES.configured_heroes.map((c) => [title(c.display), c] as const))('%s', (_t, c) => {
    expect(configuredHeroNames(display(c.display))).toEqual(c.heroes);
  });
});

describe('fact-rules.json: heroColumnsFor', () => {
  it.each(RULES.hero_columns.map((c) => [title([c.context, c.display]), c] as const))('%s', (_t, c) => {
    const options = {
      ...(c.max !== undefined ? { max: c.max } : {}),
      ...(c.fallback_to_first_columns !== undefined ? { fallbackToFirstColumns: c.fallback_to_first_columns } : {}),
    };
    expect(heroColumnsFor(c.context, display(c.display), c.column_order ?? null, options)).toEqual(c.heroes);
  });

  it('the cap is pinned: the legacy four, and the name plus every fact', () => {
    expect(MAX_HERO_FIELDS).toBe(AGENCY_FACT_FIELDS_MAX);
  });
});

describe('fact-rules.json: the name and place guess (S1)', () => {
  it('Customer ID and Contact Number are never the name', () => {
    expect(RULES.guess_columns.some((c) => (c.columns ?? Object.keys(c.row ?? {})).includes('Customer ID') && c.name === null)).toBe(true);
    expect(NAME_GUESS_COLUMNS).toEqual(['name', 'full_name', 'customer_name', 'first_name']);
  });
  it.each(RULES.guess_columns.map((c) => [title(c), c] as const))('%s', (_t, c) => {
    const options = { ...(c.hidden ? { hidden: c.hidden } : {}), ...(c.exclude ? { exclude: c.exclude } : {}) };
    const source = c.columns ?? c.row!;
    expect(none(guessNameColumn(source, options))).toBe(c.name);
    expect(none(guessPlaceColumn(source, options))).toBe(c.place);
  });
});

describe('fact-rules.json: customerNameFrom and the place (S1, S2)', () => {
  it.each(RULES.customer.map((c) => [title([c.context, c.display]), c] as const))('%s', (_t, c) => {
    expect(none(customerNameFrom(c.context, display(c.display)))).toBe(c.name);
    expect(none(customerNameColumn(c.context, display(c.display)))).toBe(c.name_column);
    expect(none(customerPlaceFrom(c.context, display(c.display)))).toBe(c.place);
    expect(none(customerPlaceColumn(c.context, display(c.display)))).toBe(c.place_column);
  });
});

describe('fact-rules.json: chosenFactTiles (S6)', () => {
  it.each(RULES.chosen_fact_tiles.map((c) => [title(c.display), c] as const))('%s', (_t, c) => {
    expect(chosenFactTiles(c.context, display(c.display), new Date(c.now))).toEqual(c.tiles);
  });
});

describe('fact-rules.json: uniqueFactLabels (S9)', () => {
  it.each(RULES.unique_fact_labels.map((c) => [title(c.headers), c] as const))('%s', (_t, c) => {
    expect(uniqueFactLabels(c.headers, c.taken)).toEqual(c.labels);
  });
});

describe('fact-rules.json: legacyFactFields, the pre-fill in the old card\'s order (S9)', () => {
  it.each(RULES.legacy_fact_fields.map((c) => [title(c.display), c] as const))('%s', (_t, c) => {
    expect(legacyFactFields(display(c.display), c.columns)).toEqual(c.facts);
  });
});

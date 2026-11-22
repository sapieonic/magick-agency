import { describe, expect, it } from 'vitest';
import {
  CARD_FULL_REASON,
  cardColumns,
  cardFacts,
  cardIsFull,
  cardSummaryLine,
  previewCell,
  sampleRows,
  toggleCardColumn,
} from '../../../utils/campaignSetup/cardColumns';
import {
  MAX_HERO_FIELDS,
  buildContextDisplay,
  initialMapping,
  sameIngestMapping,
  setDedupe,
  setRole,
  type MappingState,
} from '../../../utils/agencyColumnMapping';
import { ANALYSIS } from './customersFixtures';

const base = () => initialMapping(ANALYSIS);

function tick(mapping: MappingState, ...columns: string[]): MappingState {
  return columns.reduce((m, column) => toggleCardColumn(m, column, true), mapping);
}

const byName = (mapping: MappingState) => Object.fromEntries(cardColumns(ANALYSIS, mapping).map((c) => [c.name, c]));

describe('cardColumns (CS9)', () => {
  it('locks the phone on, the guessed name and the line under it on, and leaves the rest as facts to tick', () => {
    const columns = byName(base());
    expect(columns['Cust Mobile']).toMatchObject({ kind: 'phone', on: true, locked: true, masked: true });
    expect(columns['Full Name']).toMatchObject({ kind: 'name', on: true, locked: true, lockedReason: 'Shown as the customer’s name' });
    expect(columns['City']).toMatchObject({ kind: 'place', on: true, locked: true, lockedReason: 'Shown as the line under the name' });
    expect(columns['Amount Due']).toMatchObject({ kind: 'fact', on: false, locked: false, lockedReason: null, masked: false });
  });

  it('shows the timezone and ignored columns off and locked, with why', () => {
    let mapping = setRole(base(), 'TZ', 'timezone');
    mapping = setRole(mapping, 'Branch', 'ignore');
    const columns = byName(mapping);
    expect(columns['TZ']).toMatchObject({ kind: 'timezone', on: false, locked: true, lockedReason: 'Used for calling hours' });
    expect(columns['Branch']).toMatchObject({ kind: 'ignored', on: false, locked: true, lockedReason: 'Left out of the upload' });
  });

  it('numbers facts in the order ticked, which is the card’s order', () => {
    const mapping = tick(base(), 'Due Date', 'Amount Due');
    expect(cardFacts(mapping)).toEqual(['Due Date', 'Amount Due']);
    expect(byName(mapping)['Due Date']!.factNumber).toBe(1);
    expect(byName(mapping)['Amount Due']!.factNumber).toBe(2);
  });

  it('holds four facts beside the name and the line, then disables the other switches with the reason', () => {
    expect(MAX_HERO_FIELDS).toBe(4);
    const mapping = tick(base(), 'Amount Due', 'Due Date', 'Loan No', 'Branch');
    expect(cardIsFull(mapping)).toBe(true);
    expect(byName(mapping)['TZ']).toMatchObject({ on: false, locked: true, lockedReason: CARD_FULL_REASON });
    // A ticked fact can still be unticked.
    expect(byName(mapping)['Branch']).toMatchObject({ on: true, locked: false });
    // A fifth is refused, unchanged.
    expect(toggleCardColumn(mapping, 'TZ', true)).toBe(mapping);
  });

  it('saves exactly the ticked facts, with the name and the line as their roles (buildContextDisplay)', () => {
    const display = buildContextDisplay(tick(base(), 'Amount Due', 'Due Date'));
    expect(display.facts?.map((f) => f.column)).toEqual(['Amount Due', 'Due Date']);
    expect(display.roles).toEqual({ name: 'Full Name', place: 'City' });
    // Nothing ticked: nothing saved, the server's guess stands.
    expect(buildContextDisplay(base())).toEqual({});
  });

  it('gives back a hero slot the full mapper spent on the name, so four facts still fit', () => {
    // "On the card" picked on the name column in the mapper: a hero that is not a fact.
    let mapping = setRole(base(), 'Full Name', 'hero');
    mapping = tick(mapping, 'Amount Due', 'Due Date', 'Loan No');
    expect(cardFacts(mapping)).toHaveLength(3);
    expect(cardIsFull(mapping)).toBe(false);
    mapping = toggleCardColumn(mapping, 'Branch', true);
    expect(cardFacts(mapping)).toEqual(['Amount Due', 'Due Date', 'Loan No', 'Branch']);
    expect(mapping.heroOrder).not.toContain('Full Name');
  });

  it('flips only facts: the name, the line, the phone and an unknown column are left alone', () => {
    const mapping = base();
    for (const column of ['Full Name', 'City', 'Cust Mobile', 'Nope']) {
      expect(toggleCardColumn(mapping, column, true)).toBe(mapping);
    }
    const ticked = tick(mapping, 'Amount Due');
    expect(cardFacts(toggleCardColumn(ticked, 'Amount Due', false))).toEqual([]);
    expect(toggleCardColumn(mapping, 'Amount Due', false)).toBe(mapping);
  });
});

describe('the preview', () => {
  it('lays the samples out as rows, at most three', () => {
    const rows = sampleRows(ANALYSIS);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.slice(0, 3)).toEqual(['9820041772', 'Priya Menon', 'Pune']);
    // A column with fewer samples leaves its cell blank.
    expect(rows[1]![7]).toBe('');
    expect(sampleRows(ANALYSIS, 1)).toHaveLength(1);
  });

  it('hides most of a phone number by AS19’s one rule', () => {
    expect(previewCell('9820041772', true)).toBe('98••• ••772');
    expect(previewCell('+919812345678', true)).toBe('98••• ••678');
    expect(previewCell('Priya Menon', false)).toBe('Priya Menon');
    expect(previewCell('', true)).toBe('');
  });

  it('says what the card will show', () => {
    expect(cardSummaryLine(base())).toMatch(/^Nothing ticked yet/);
    expect(cardSummaryLine(tick(base(), 'Amount Due'))).toBe('Name: Full Name · Under it: City · 1 of 4 facts');
  });
});

describe('sameIngestMapping: a check stands while the card is picked', () => {
  it('ignores which kept columns are on the card', () => {
    const mapping = base();
    expect(sameIngestMapping(mapping, tick(mapping, 'Amount Due', 'Due Date'))).toBe(true);
  });

  it('sees every change the ingest would send', () => {
    const mapping = base();
    expect(sameIngestMapping(mapping, setRole(mapping, 'Branch', 'ignore'))).toBe(false);
    expect(sameIngestMapping(mapping, setRole(mapping, 'TZ', 'timezone'))).toBe(false);
    expect(sameIngestMapping(mapping, setRole(mapping, 'Loan No', 'phone'))).toBe(false);
    expect(sameIngestMapping(mapping, setDedupe(mapping, { mode: 'none' }))).toBe(false);
    expect(sameIngestMapping(mapping, { ...mapping, defaultCountryCode: '1' })).toBe(false);
    expect(sameIngestMapping(mapping, null)).toBe(false);
    expect(sameIngestMapping(null, null)).toBe(true);
  });
});

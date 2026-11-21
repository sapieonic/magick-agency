import { describe, expect, it } from 'vitest';
import {
  AGENCY_FACT_KEY_MAX_CHARS,
  AGENCY_FACT_KEY_PATTERN,
  AGENCY_SCRIPT_FIXED_PLACEHOLDERS,
  AGENCY_SCRIPT_PLACEHOLDERS,
} from '@magick-agency/contracts/agency';
import {
  defaultFactLabel,
  factKeyFromColumn,
  legacyFactFields,
  placeholdersIn,
  scriptPieces,
  scriptPlaceholdersFor,
  unknownPlaceholdersIn,
} from '../../../src/fact-fields';

/**
 * The card's chosen facts and the script keys they make (`src/fact-fields.ts`, AS19): the rules
 * the server's write and the console's editor share. A campaign without `facts` reads exactly as
 * before.
 */
describe('scriptPlaceholdersFor', () => {
  it('without `facts`: the legacy six, whatever else the display says', () => {
    for (const display of [undefined, null, {}, { hero: ['Loan No'] }, { facts: null }, { facts: {} }, { facts: 'x' }]) {
      expect(scriptPlaceholdersFor(display)).toEqual([...AGENCY_SCRIPT_PLACEHOLDERS]);
    }
  });

  it('with `facts`: the fixed four, then each fact\'s key in order', () => {
    expect(scriptPlaceholdersFor({ facts: [] })).toEqual([...AGENCY_SCRIPT_FIXED_PLACEHOLDERS]);
    expect(scriptPlaceholdersFor({
      facts: [
        { column: 'Balance', label: 'Amount due', key: 'amount_due' },
        { column: 'Branch', label: 'Branch', key: 'branch' },
      ],
    })).toEqual(['name', 'place', 'agent_name', 'campaign_name', 'amount_due', 'branch']);
  });

  it('with `facts`: `due_date` is no longer allowed unless a fact has that key; bad entries are skipped', () => {
    expect(scriptPlaceholdersFor({ facts: [{ column: 'EMI', key: 'emi' }] })).not.toContain('due_date');
    expect(scriptPlaceholdersFor({ facts: [null, 'emi', { key: 7 }, { key: '' }, { key: 'emi' }, { key: 'emi' }, { key: 'name' }] }))
      .toEqual(['name', 'place', 'agent_name', 'campaign_name', 'emi']);
  });
});

describe('factKeyFromColumn', () => {
  const CASES: Array<[string, string]> = [
    ['Amount Due', 'amount_due'],
    ['amount_due', 'amount_due'],
    ['  EMI (₹)  ', 'emi'],
    ['Loan No.', 'loan_no'],
    ['Customer--Name__2', 'customer_name_2'],
    ['2nd EMI', 'f_2nd_emi'],
    ['123', 'f_123'],
    ['', 'f_'],
    ['नाम', 'f_'],
    ['Due Date (DD/MM/YYYY)', 'due_date_dd_mm_yyyy'],
    ['ALL CAPS', 'all_caps'],
  ];
  it.each(CASES)('%j is %j', (header, key) => {
    expect(factKeyFromColumn(header)).toBe(key);
  });

  it('cuts to 32 without leaving an underscore at the end', () => {
    const key = factKeyFromColumn('Outstanding principal amount as of March');
    expect(key).toBe('outstanding_principal_amount_as');
    expect(key.length).toBeLessThanOrEqual(AGENCY_FACT_KEY_MAX_CHARS);
    expect(factKeyFromColumn('a'.repeat(40))).toBe('a'.repeat(32));
  });

  it('adds _2, _3, … when taken or a fixed placeholder, within 32', () => {
    expect(factKeyFromColumn('Amount Due', ['amount_due'])).toBe('amount_due_2');
    expect(factKeyFromColumn('Amount Due', ['amount_due', 'amount_due_2'])).toBe('amount_due_3');
    expect(factKeyFromColumn('Name')).toBe('name_2');
    expect(factKeyFromColumn('Place', ['place_2'])).toBe('place_3');
    expect(factKeyFromColumn('Agent Name')).toBe('agent_name_2');
    expect(factKeyFromColumn('', ['f_'])).toBe('f_2');
    const long = factKeyFromColumn('b'.repeat(40), ['b'.repeat(32)]);
    expect(long).toBe(`${'b'.repeat(30)}_2`);
    expect(long.length).toBe(32);
  });

  it('always answers a key the contract accepts', () => {
    for (const header of [...CASES.map(([h]) => h), '___', '9', '₹₹₹', 'x'.repeat(100), 'Name']) {
      for (const taken of [[], [factKeyFromColumn(header)]]) {
        const key = factKeyFromColumn(header, taken);
        expect(key, header).toMatch(AGENCY_FACT_KEY_PATTERN);
        expect(key.length, header).toBeLessThanOrEqual(AGENCY_FACT_KEY_MAX_CHARS);
        expect(taken).not.toContain(key);
        expect(AGENCY_SCRIPT_FIXED_PLACEHOLDERS as readonly string[]).not.toContain(key);
      }
    }
  });
});

describe('defaultFactLabel', () => {
  it('the header trimmed and cut to 16 code points', () => {
    expect(defaultFactLabel('  Amount Due  ')).toBe('Amount Due');
    expect(defaultFactLabel('Outstanding amount (principal)')).toBe('Outstanding amou');
    expect(defaultFactLabel('Due date as of 31 March')).toBe('Due date as of 3');
    // Code points, not UTF-16 units; and no space left at the cut.
    expect(defaultFactLabel('ऋण राशि बकाया है अभी तक')).toBe('ऋण राशि बकाया है');
    expect(defaultFactLabel('😀'.repeat(20))).toBe('😀'.repeat(16));
    expect(defaultFactLabel('   ')).toBe('');
  });
});

describe('legacyFactFields (the editor\'s pre-fill for a campaign without `facts`)', () => {
  const columns = ['Customer Name', 'City', 'Loan No', 'Balance', 'Due Date', 'EMI', 'Branch', 'Internal ID'];

  it('the hero columns minus name and place, then the amount and due date roles, keyed for the old script', () => {
    const display = {
      hero: ['Customer Name', 'Loan No', 'EMI'],
      roles: { name: 'Customer Name', place: 'City', amount_due: 'Balance', due_date: 'Due Date' },
    };
    expect(legacyFactFields(display, columns)).toEqual([
      { column: 'Loan No', label: 'Loan No', key: 'loan_no' },
      { column: 'EMI', label: 'EMI', key: 'emi' },
      { column: 'Balance', label: 'Balance', key: 'amount_due' },
      { column: 'Due Date', label: 'Due Date', key: 'due_date' },
    ]);
  });

  it('a role column already among the heroes keeps its place and takes the role\'s key', () => {
    const display = { hero: ['Balance', 'Branch'], roles: { amount_due: 'balance' } };
    expect(legacyFactFields(display, columns)).toEqual([
      { column: 'Balance', label: 'Balance', key: 'amount_due' },
      { column: 'Branch', label: 'Branch', key: 'branch' },
    ]);
  });

  it('at most 4, keeping the role columns when the cap bites; nothing highlighted', () => {
    const display = {
      hero: ['Loan No', 'EMI', 'Branch', 'Internal ID', 'City'],
      roles: { amount_due: 'Balance', due_date: 'Due Date' },
    };
    const facts = legacyFactFields(display, columns);
    expect(facts.map((f) => f.column)).toEqual(['Loan No', 'EMI', 'Balance', 'Due Date']);
    expect(facts.some((f) => 'highlight' in f)).toBe(false);
  });

  it('hidden never, missing from the roster never, each column once ignoring case', () => {
    const display = {
      hero: ['loan no', 'Internal ID', 'Policy', 'LOAN NO'],
      hidden: ['internal id', 'due date'],
      roles: { amount_due: 'Gone', due_date: 'Due Date' },
    };
    expect(legacyFactFields(display, columns)).toEqual([{ column: 'Loan No', label: 'Loan No', key: 'loan_no' }]);
  });

  it('a non-role column whose key would be a role\'s is deduped against it', () => {
    const display = { hero: ['Amount Due'], roles: { amount_due: 'Balance' } };
    expect(legacyFactFields(display, ['Amount Due', 'Balance'])).toEqual([
      { column: 'Amount Due', label: 'Amount Due', key: 'amount_due_2' },
      { column: 'Balance', label: 'Balance', key: 'amount_due' },
    ]);
  });

  it('no hero configured: the hero rule\'s guess, as today\'s tiles; options.exclude drops a guessed name', () => {
    const roster = ['Customer Name', 'Loan No', 'Balance', 'City', 'Notes'];
    // The guess: one per bucket (a name, an amount, an identifier, a place).
    expect(legacyFactFields({}, roster).map((f) => f.column)).toEqual(['Customer Name', 'Balance', 'Loan No', 'City']);
    expect(legacyFactFields({}, roster, { exclude: ['customer name', 'City'] }).map((f) => f.column)).toEqual(['Balance', 'Loan No']);
    // No roster yet: only what is configured, as written.
    expect(legacyFactFields({}, null)).toEqual([]);
    expect(legacyFactFields({ hero: ['Loan No'], roles: { due_date: 'Due' } }, null).map((f) => [f.column, f.key])).toEqual([
      ['Loan No', 'loan_no'],
      ['Due', 'due_date'],
    ]);
  });

  it('labels are the header cut to 16', () => {
    const facts = legacyFactFields({ hero: ['Outstanding amount (principal)'] }, ['Outstanding amount (principal)']);
    expect(facts).toEqual([{ column: 'Outstanding amount (principal)', label: 'Outstanding amou', key: 'outstanding_amount_principal' }]);
  });

  it('a campaign that already has `facts` gets them back', () => {
    const facts = [
      { column: 'Balance', label: 'Amount due', key: 'amount_due', highlight: true },
      { column: 'Branch', label: 'Branch', key: 'branch' },
    ];
    expect(legacyFactFields({ hero: ['Loan No'], facts: [...facts, null, { column: 'x' }] }, columns)).toEqual(facts);
    expect(legacyFactFields({ hero: ['Loan No'], facts: [] }, columns)).toEqual([]);
  });
});

describe('placeholdersIn and unknownPlaceholdersIn (the server\'s reading of braces)', () => {
  const text = 'Namaste {name}, {amount_due} by {due_date}. { name } {Name} {branch} {name} {two words} {} {x-y}';

  it('every {word} as written, once, in order; braces round anything else are text', () => {
    expect(placeholdersIn(text)).toEqual(['{name}', '{amount_due}', '{due_date}', '{ name }', '{Name}', '{branch}']);
    expect(placeholdersIn('No braces.')).toEqual([]);
  });

  it('unknown: not exactly {key} for an allowed key', () => {
    expect(unknownPlaceholdersIn(text, AGENCY_SCRIPT_PLACEHOLDERS)).toEqual(['{ name }', '{Name}', '{branch}']);
    const withFacts = scriptPlaceholdersFor({ facts: [{ column: 'Branch', label: 'Branch', key: 'branch' }] });
    expect(unknownPlaceholdersIn(text, withFacts)).toEqual(['{amount_due}', '{due_date}', '{ name }', '{Name}']);
  });
});

describe('scriptPieces', () => {
  it('cuts a text into text, known keys and unknown words, joining adjacent text', () => {
    const allowed = scriptPlaceholdersFor({ facts: [{ column: 'Branch', label: 'Branch', key: 'branch' }] });
    expect(scriptPieces('Hi {name}, {branch}{ name } {due_date} {} ok', allowed)).toEqual([
      { kind: 'text', text: 'Hi ' },
      { kind: 'key', key: 'name' },
      { kind: 'text', text: ', ' },
      { kind: 'key', key: 'branch' },
      { kind: 'unknown', token: '{ name }' },
      { kind: 'text', text: ' ' },
      { kind: 'unknown', token: '{due_date}' },
      { kind: 'text', text: ' {} ok' },
    ]);
  });

  it('no piece is empty; joined back it is the text', () => {
    expect(scriptPieces('', ['name'])).toEqual([]);
    expect(scriptPieces('{name}', ['name'])).toEqual([{ kind: 'key', key: 'name' }]);
    const text = '{a}{b} and {c}';
    const joined = scriptPieces(text, ['a', 'c'])
      .map((p) => (p.kind === 'text' ? p.text : p.kind === 'key' ? `{${p.key}}` : p.token))
      .join('');
    expect(joined).toBe(text);
  });
});

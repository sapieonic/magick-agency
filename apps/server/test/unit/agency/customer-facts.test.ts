import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AgencyContextDisplay } from '@magick-agency/contracts/agency';
import { contextDisplayIssues, customerFacts, namesContextColumns } from '../../../src/agency/customer-facts.js';
import { agentScriptIssues } from '../../../src/agency/agent-script.js';
import { contactFields } from '../../../src/agency/customer-history/assemble.js';
import type { CustomerHistoryCampaignRow } from '../../../src/db/repositories/agency/customer-history.repository.js';
import { heroColumns } from '../../../src/db/repositories/agency/assignment-reads.repository.js';
import { validateAgencyCampaignConfig as validateInternal } from '../../../src/agency/campaign-config.js';
import { validateAgencyCampaignConfig as validatePublic } from '../../../src/agency/agency-campaign-config.js';
import { buildPanel } from '../../../src/agency/dialer/live-attempt.js';
import type { DialCommand } from '../../../src/agency/dial-dispatcher.js';

/**
 * Typed customer facts (BE-6, `src/agency/customer-facts.ts`): the panel's `facts` built from a
 * roster row and the campaign's `context_display`, and the write's rules for `roles` / `.types`.
 * The parse rule itself is the domain's (`packages/domain/test/unit/agency/context-facts.test.ts`).
 */

const ROW = {
  'Customer Name': '  Ramesh Goud ',
  City: 'Hyderabad',
  'Loan No': 'LN-0042',
  'Amount Due': '₹1,25,000',
  'Due Date': '25/11/2026',
  Aadhaar: '1234 5678 9012',
};

const ROLES: AgencyContextDisplay = {
  hero: ['Loan No', 'Amount Due', 'Due Date'],
  roles: { name: 'Customer Name', place: 'City', amount_due: 'Amount Due', due_date: 'Due Date' },
};

describe('customerFacts: the panel\'s facts', () => {
  it('reads the roles: name and place by their columns, the amount and the date parsed, raw kept', () => {
    expect(customerFacts(ROW, ROLES)).toEqual({
      name: 'Ramesh Goud',
      place: 'Hyderabad',
      tiles: [
        { column: 'Loan No', type: 'text', raw: 'LN-0042', value: null },
        { column: 'Amount Due', role: 'amount_due', type: 'money', raw: '₹1,25,000', value: '125000' },
        { column: 'Due Date', role: 'due_date', type: 'date', raw: '25/11/2026', value: '2026-11-25' },
      ],
    });
  });

  it('an amount or a date it cannot read is null, with the raw text kept', () => {
    const facts = customerFacts({ ...ROW, 'Amount Due': '1.25 lakh', 'Due Date': '11/25/2026' }, ROLES);
    expect(facts.tiles.find((t) => t.role === 'amount_due')).toEqual(
      { column: 'Amount Due', role: 'amount_due', type: 'money', raw: '1.25 lakh', value: null });
    expect(facts.tiles.find((t) => t.role === 'due_date')).toEqual(
      { column: 'Due Date', role: 'due_date', type: 'date', raw: '11/25/2026', value: null });
    expect(customerFacts({ ...ROW, 'Amount Due': 'twelve thousand' }, ROLES).tiles.find((t) => t.role === 'amount_due'))
      .toEqual({ column: 'Amount Due', role: 'amount_due', type: 'money', raw: 'twelve thousand', value: null });
    // A blank value is a tile with empty raw text and no value.
    expect(customerFacts({ ...ROW, 'Amount Due': '' }, ROLES).tiles.find((t) => t.role === 'amount_due'))
      .toEqual({ column: 'Amount Due', role: 'amount_due', type: 'money', raw: '', value: null });
  });

  it('a role is read by its type whatever `types` says; `types` reads the other columns; unknown is text', () => {
    const facts = customerFacts({ ...ROW, Limit: '50,000', Opened: '2026-01-05' }, {
      hero: ['Amount Due', 'Limit', 'Opened', 'Loan No'],
      roles: { amount_due: 'Amount Due' },
      types: { 'amount due': 'date', limit: 'money', Opened: 'date', 'Loan No': 'bogus' } as never,
    });
    expect(facts.tiles).toEqual([
      { column: 'Amount Due', role: 'amount_due', type: 'money', raw: '₹1,25,000', value: '125000' },
      { column: 'Limit', type: 'money', raw: '50,000', value: '50000' },
      { column: 'Opened', type: 'date', raw: '2026-01-05', value: '2026-01-05' },
      { column: 'Loan No', type: 'text', raw: 'LN-0042', value: null },
    ]);
  });

  it('no roles and no types: the name and place guessed from their column names, every tile text', () => {
    const facts = customerFacts(ROW, { hero: ['Loan No', 'Amount Due', 'Due Date'] });
    expect(facts.name).toBe('Ramesh Goud');
    expect(facts.place).toBe('Hyderabad');
    expect(facts.tiles.map((t) => [t.column, t.type, t.value])).toEqual([
      ['Loan No', 'text', null], ['Amount Due', 'text', null], ['Due Date', 'text', null],
    ]);
    // Nothing configured at all: the hero guess, minus the columns shown as the name and the place.
    const guessed = customerFacts(ROW, {});
    expect(guessed.tiles.map((t) => t.column)).toEqual(['Amount Due', 'Loan No']);
    expect(customerFacts({ name: 'Asha', amount: '10' }, undefined)).toEqual({
      name: 'Asha', tiles: [{ column: 'amount', type: 'text', raw: '10', value: null }],
    });
  });

  it('the name is never guessed from a column that is not a name, and absent when there is none', () => {
    expect(customerFacts({ customer_id: 'C-9', phone2: '98100' }, {})).not.toHaveProperty('name');
    expect(customerFacts({ Name: 'N/A', City: '-' }, {})).toEqual({ tiles: [] });
    expect(customerFacts(null, null)).toEqual({ tiles: [] });
  });

  it('hidden wins over everything: never a role, a guess or a tile', () => {
    const facts = customerFacts(ROW, {
      ...ROLES,
      hero: ['Aadhaar', 'Loan No', 'Amount Due'],
      hidden: ['customer name', 'AADHAAR', 'Amount Due'],
    });
    expect(facts).not.toHaveProperty('name');
    expect(facts.tiles.map((t) => t.column)).toEqual(['Loan No', 'Due Date']);
    expect(facts.tiles.some((t) => t.role === 'amount_due')).toBe(false);
  });

  it('role columns are matched ignoring case, and kept as tiles when the heroes leave them out', () => {
    const facts = customerFacts(ROW, {
      hero: ['Loan No', 'Aadhaar'],
      roles: { amount_due: 'AMOUNT DUE', due_date: 'due date' },
    });
    expect(facts.tiles.map((t) => [t.column, t.role ?? null])).toEqual([
      ['Loan No', null], ['Aadhaar', null], ['Amount Due', 'amount_due'], ['Due Date', 'due_date'],
    ]);
  });

  it('at most four tiles, and the role tiles survive the cap', () => {
    const row = { ...ROW, A: '1', B: '2', C: '3', D: '4' };
    const facts = customerFacts(row, { hero: ['A', 'B', 'C', 'D'], roles: { amount_due: 'Amount Due', due_date: 'Due Date' } });
    expect(facts.tiles.map((t) => t.column)).toEqual(['A', 'B', 'Amount Due', 'Due Date']);
    // The name and place columns are not tiles, so a full hero list still fills four.
    const named = customerFacts(row, { hero: ['Customer Name', 'City', 'A', 'B', 'C', 'D'] });
    expect(named.tiles.map((t) => t.column)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('a name or place longer than 100 characters is cut; numbers in the row are read as text', () => {
    const facts = customerFacts({ name: 'x'.repeat(150), 'Amount Due': 12500.5 }, { roles: { amount_due: 'Amount Due' } });
    expect(facts.name).toHaveLength(100);
    expect(facts.tiles).toEqual([{ column: 'Amount Due', role: 'amount_due', type: 'money', raw: '12500.5', value: '12500.5' }]);
  });
});

describe('buildPanel: the reserved attempt carries the facts', () => {
  it('built from the dial\'s contact and campaign', () => {
    const panel = buildPanel({
      attemptId: 'a1', campaignId: 'c1', contactId: 'k1', callerId: '+919000000001', attemptNumber: 1,
      campaign: { name: 'Collections', context_display: ROLES },
      contact: { phone_e164: '+919811100001', context: ROW, promise_date: null },
    } as unknown as DialCommand, []);
    expect(panel.facts).toEqual(customerFacts(ROW, ROLES));
    expect(panel.facts?.tiles.find((t) => t.role === 'amount_due')?.value).toBe('125000');
    // The raw row is still sent as before.
    expect(panel.context).toBe(ROW);
  });
});

describe('the write: context_display.roles and .types', () => {
  const issues = (display: unknown, known: string[] | null = null) =>
    contextDisplayIssues({ context_display: display }, known).map((i) => `${i.field}: ${i.message}`);

  it('accepts roles and types, alone or together, and a display without them', () => {
    expect(issues(ROLES)).toEqual([]);
    expect(issues({ types: { 'Amount Due': 'money', 'Due Date': 'date', Note: 'text' } })).toEqual([]);
    expect(issues({ hero: ['a'], hidden: ['b'] })).toEqual([]);
    expect(issues({ roles: {}, types: {} })).toEqual([]);
    // Not an object, or absent: not this rule's to judge.
    expect(contextDisplayIssues({})).toEqual([]);
    expect(issues(null)).toEqual([]);
  });

  it('refuses an unknown role, a bad column name, a hidden column, and one column in two roles', () => {
    expect(issues({ roles: { phone: 'Mobile' } })).toEqual([
      "context_display.roles.phone: That is not a customer fact the station shows. They are the customer's name, the customer's place, the amount due and the due date.",
    ]);
    expect(issues({ roles: { name: '' } })[0]).toMatch(/^context_display\.roles\.name: Choose the column for the customer's name/);
    expect(issues({ roles: { name: 42 } })).toHaveLength(1);
    expect(issues({ roles: { amount_due: 'x'.repeat(201) } })).toHaveLength(1);
    expect(issues({ roles: { name: 'Aadhaar' }, hidden: ['aadhaar'] })).toEqual([
      "context_display.roles.name: 'Aadhaar' is hidden from agents, so it cannot be the customer's name. Show the column first.",
    ]);
    expect(issues({ roles: { amount_due: 'Amount', due_date: 'AMOUNT' } })).toEqual([
      "context_display.roles.due_date: 'AMOUNT' is already the amount due. One column can play one role only.",
    ]);
    expect(issues({ roles: ['Name'] })).toEqual(['context_display.roles: Choose a column for each customer fact: the name, place, amount due and due date.']);
  });

  it('accepts the six types (AS19) and refuses any other', () => {
    expect(issues({ types: { A: 'text', B: 'money', C: 'date', D: 'number', E: 'phone', F: 'yes_no' } })).toEqual([]);
    expect(issues({ types: { Amount: 'currency' } })).toEqual([
      "context_display.types.Amount: Choose how to read 'Amount': as text, money, a number, a date, a phone number or yes / no.",
    ]);
    expect(issues({ types: { Paid: 'boolean' } })).toHaveLength(1);
    expect(issues({ types: 'money' })).toEqual([
      'context_display.types: Choose how to read each column: as text, money, a number, a date, a phone number or yes / no.',
    ]);
  });

  it('with the roster\'s columns: every role and type must name one, ignoring case; the refusal lists them', () => {
    const known = ['Customer Name', 'City', 'Amount Due', 'Due Date'];
    expect(issues({ roles: { name: 'customer name', amount_due: 'AMOUNT DUE' }, types: { 'due date': 'date' } }, known)).toEqual([]);
    expect(issues({ roles: { amount_due: 'Balance' }, types: { Opened: 'date' } }, known)).toEqual([
      "context_display.roles.amount_due: There is no column 'Balance' in this campaign's customer list, so it cannot be the amount due. The columns are: Customer Name, City, Amount Due, Due Date.",
      "context_display.types.Opened: There is no column 'Opened' in this campaign's customer list, so it cannot be given a type. The columns are: Customer Name, City, Amount Due, Due Date.",
    ]);
    // No import yet: the names are not checked against a roster.
    expect(issues({ roles: { amount_due: 'Balance' } }, [])).toEqual([]);
  });

  it('both campaign-config validators refuse what the rule refuses, keyed on the field', () => {
    const body = { context_display: { roles: { amount_due: 'A', name: 'A' } } };
    for (const validate of [validateInternal, validatePublic]) {
      expect(validate(body).map((i) => i.field)).toEqual(['context_display.roles.name']);
      expect(validate({ context_display: ROLES })).toEqual([]);
    }
  });

  it('namesContextColumns: only a body that sets roles, types or facts needs the roster read', () => {
    expect(namesContextColumns({ context_display: { roles: {} } })).toBe(true);
    expect(namesContextColumns({ context_display: { types: {} } })).toBe(true);
    expect(namesContextColumns({ context_display: { facts: [] } })).toBe(true);
    expect(namesContextColumns({ context_display: { hero: ['a'] } })).toBe(false);
    expect(namesContextColumns({})).toBe(false);
  });
});

// ── AS19: the card's chosen facts ────────────────────────────────────────────

const FIXTURES = '../../../../../packages/contracts/fixtures/agent';
const fixture = (file: string) => JSON.parse(readFileSync(new URL(`${FIXTURES}/${file}`, import.meta.url), 'utf8'));

const FACTS_ROW = {
  'Customer Name': 'Ramesh Goud',
  City: 'Hyderabad',
  'Loan No': 'LN-0042',
  'Amount Due': '₹1,25,000',
  'Due Date': '25/11/2026',
  Branch: '',
  Aadhaar: '1234 5678 9012',
};

const CHOSEN: AgencyContextDisplay = {
  // `hero` and the amount / due date roles are not read for tiles once `facts` is set.
  hero: ['Aadhaar', 'Loan No'],
  hidden: ['Aadhaar'],
  roles: { name: 'Customer Name', place: 'City', amount_due: 'Loan No' },
  types: { 'amount due': 'money', 'Due Date': 'date' },
  facts: [
    { column: 'Due Date', label: 'Due on', key: 'due_date' },
    { column: 'amount due', label: '  Amount  ', key: 'amount_due', highlight: true },
    { column: 'Branch', label: 'Branch', key: 'branch' },
  ],
};

describe('customerFacts with facts (AS19): the tiles are the chosen facts', () => {
  it('in order, highlighted first, each with label, key and the role its key gives; typed by `types` alone', () => {
    expect(customerFacts(FACTS_ROW, CHOSEN)).toEqual({
      name: 'Ramesh Goud',
      place: 'Hyderabad',
      tiles: [
        { column: 'Amount Due', label: 'Amount', key: 'amount_due', highlight: true, role: 'amount_due', type: 'money', raw: '₹1,25,000', value: '125000' },
        { column: 'Due Date', label: 'Due on', key: 'due_date', role: 'due_date', type: 'date', raw: '25/11/2026', value: '2026-11-25' },
        // A blank value still has its tile.
        { column: 'Branch', label: 'Branch', key: 'branch', type: 'text', raw: '', value: null },
      ],
    });
  });

  it('a fact keyed amount_due is not read as money unless `types` says so (no role override)', () => {
    const tiles = customerFacts(FACTS_ROW, { facts: [{ column: 'Amount Due', label: 'Due', key: 'amount_due' }] }).tiles;
    expect(tiles).toEqual([{ column: 'Amount Due', label: 'Due', key: 'amount_due', role: 'amount_due', type: 'text', raw: '₹1,25,000', value: null }]);
  });

  it('a hidden or missing column is no tile; at most four; only the first highlight keeps it', () => {
    const tiles = customerFacts({ A: '1', B: '2', C: '3', D: '4', E: '5', Aadhaar: '9' }, {
      hidden: ['aadhaar'],
      facts: [
        { column: 'Aadhaar', label: 'Id', key: 'id' },
        { column: 'Gone', label: 'Gone', key: 'gone' },
        { column: 'A', label: 'A', key: 'a' },
        { column: 'B', label: 'B', key: 'b', highlight: true },
        { column: 'C', label: 'C', key: 'c', highlight: true },
        { column: 'D', label: 'D', key: 'd' },
        { column: 'E', label: 'E', key: 'e', highlight: true },
      ],
    }).tiles;
    expect(tiles.map((t) => [t.column, t.highlight ?? false])).toEqual([['B', true], ['A', false], ['C', false], ['D', false]]);
  });

  it('`facts: []` means no tiles at all, whatever `hero` and the roles say', () => {
    expect(customerFacts(FACTS_ROW, { ...CHOSEN, facts: [] })).toEqual({ name: 'Ramesh Goud', place: 'Hyderabad', tiles: [] });
  });

  it('read leniently: an entry with no column is skipped, a label or key that is not text left off', () => {
    const tiles = customerFacts(FACTS_ROW, { facts: [null, { label: 'x' }, { column: 'City', label: 7, key: '' }] as never }).tiles;
    expect(tiles).toEqual([{ column: 'City', type: 'text', raw: 'Hyderabad', value: null }]);
  });

  it('without `facts` the BE-6 rule is untouched (the same display, `facts` removed, gives the hero tiles)', () => {
    const { facts: _facts, ...legacy } = CHOSEN;
    expect(customerFacts(FACTS_ROW, legacy).tiles.map((t) => t.column)).toEqual(['Loan No']);
    expect(customerFacts(FACTS_ROW, legacy).tiles[0]).not.toHaveProperty('label');
  });

  it('builds the golden sample: `bootstrap_facts_chosen`\'s display over `reserved_facts_chosen`\'s row', () => {
    const display = fixture('session.json').bootstrap_facts_chosen.context_display;
    const attempt = fixture('station.json').reserved_facts_chosen.attempt;
    expect(customerFacts(attempt.context, display)).toEqual(attempt.facts);
    // and its script is one the write accepts against that display
    expect(agentScriptIssues({ agent_script: fixture('session.json').bootstrap_facts_chosen.script }, { context_display: display })).toEqual([]);
  });
});

describe('with facts (AS19), the other readers of the heroes match the card', () => {
  it('customer history and the own-contacts list: the name\'s column, then each fact\'s column, hidden never', () => {
    // customer history's hero fields (columns with no value left out, as before)
    const row = { ...FACTS_ROW, Branch: 'Kukatpally' };
    expect(contactFields(row, { context_display: CHOSEN } as CustomerHistoryCampaignRow).map((f) => f.column))
      .toEqual(['Customer Name', 'Due Date', 'Amount Due', 'Branch']);
    // the own-contacts list's configured heroes (matched to the row in SQL, as written)
    expect(heroColumns({ context_display: CHOSEN })).toEqual(['Customer Name', 'Due Date', 'amount due', 'Branch']);
    expect(heroColumns({ context_display: { ...CHOSEN, hidden: ['Branch'] } })).not.toContain('Branch');
    // without facts: `hero`, unchanged
    const { facts: _facts, ...legacy } = CHOSEN;
    expect(heroColumns({ context_display: legacy })).toEqual(['Loan No']);
  });
});

describe('the write: context_display.facts (AS19)', () => {
  const issues = (display: unknown, known: string[] | null = null) =>
    contextDisplayIssues({ context_display: display }, known).map((i) => `${i.field}: ${i.message}`);
  const fact = (column: string, label = column, key = column.toLowerCase()) => ({ column, label, key });

  it('accepts a well-formed list, `[]`, a label of 16 letters after trimming, one highlight', () => {
    expect(issues(CHOSEN)).toEqual([]);
    expect(issues({ facts: [] })).toEqual([]);
    expect(issues({ facts: [{ ...fact('A'), label: ` ${'ए'.repeat(16)} `, highlight: true }, { ...fact('B'), highlight: false }] })).toEqual([]);
  });

  it('refuses a list that is not one, and a fifth fact', () => {
    expect(issues({ facts: { column: 'A' } })).toEqual(['context_display.facts: The facts on the card must be a list, one fact after another.']);
    expect(issues({ facts: ['A', 'B', 'C', 'D', 'E'].map((c) => fact(c)) })).toEqual([
      'context_display.facts: You can show 4 facts at most. Remove one to add another.',
    ]);
  });

  it('refuses a bad entry or an unknown part', () => {
    expect(issues({ facts: ['Amount'] })).toEqual(['context_display.facts.0: Each fact needs a column, a name and a key.']);
    expect(issues({ facts: [{ ...fact('A'), colour: 'red' }] })).toEqual([
      'context_display.facts.0.colour: A fact has only a column, a name, a key and a highlight.',
    ]);
  });

  it('the column: a name of 1 to 200 characters, not hidden, not the name or the line under it, once', () => {
    expect(issues({ facts: [fact('')] })[0]).toBe(
      'context_display.facts.0.column: Choose the column for this fact: a column name of 1 to 200 characters.',
    );
    expect(issues({ facts: [{ column: 'x'.repeat(201), label: 'X', key: 'x' }] })).toHaveLength(1);
    expect(issues({ hidden: ['Aadhaar'], facts: [fact('aadhaar')] })).toEqual([
      "context_display.facts.0.column: 'aadhaar' is hidden from agents, so it cannot be a fact. Show the column first.",
    ]);
    expect(issues({ roles: { name: 'Customer Name', place: 'City' }, facts: [fact('customer name', 'Name', 'cname'), fact('CITY')] })).toEqual([
      "context_display.facts.0.column: 'customer name' is already the customer's name, so it cannot be a fact too.",
      "context_display.facts.1.column: 'CITY' is already the customer's place, so it cannot be a fact too.",
    ]);
    expect(issues({ facts: [fact('Loan'), fact('LOAN', 'Loan 2', 'loan_2')] })).toEqual([
      'context_display.facts.1.column: Two facts cannot show the same column.',
    ]);
  });

  it('the column against the roster, when it is known, ignoring case', () => {
    const known = ['Customer Name', 'Amount Due'];
    expect(issues({ facts: [fact('amount due', 'Due', 'due')] }, known)).toEqual([]);
    expect(issues({ facts: [fact('Branch')] }, known)).toEqual([
      "context_display.facts.0.column: There is no column 'Branch' in this campaign's customer list, so it cannot be a fact. The columns are: Customer Name, Amount Due.",
    ]);
  });

  it('the name: given, 16 letters at most, never twice', () => {
    expect(issues({ facts: [{ ...fact('A'), label: '   ' }, { column: 'B', key: 'b' }] })).toEqual([
      'context_display.facts.0.label: Give each fact a name.',
      'context_display.facts.1.label: Give each fact a name.',
    ]);
    expect(issues({ facts: [{ ...fact('A'), label: 'x'.repeat(17) }] })).toEqual([
      "context_display.facts.0.label: A fact's name can be 16 letters at most.",
    ]);
    expect(issues({ facts: [fact('A', 'Due'), fact('B', ' due ')] })).toEqual([
      'context_display.facts.1.label: Two facts cannot have the same name.',
    ]);
  });

  it('the key: the pattern, 32 at most, never a fixed key, never twice', () => {
    for (const bad of ['Amount', '1st', '_x', 'due date', 'due-date', '', 7]) {
      expect(issues({ facts: [{ ...fact('A'), key: bad }] }), String(bad)).toEqual([
        "context_display.facts.0.key: A fact's key must start with a small letter and have only small letters, numbers and underscores.",
      ]);
    }
    expect(issues({ facts: [{ ...fact('A'), key: 'k'.repeat(32) }] })).toEqual([]);
    expect(issues({ facts: [{ ...fact('A'), key: 'k'.repeat(33) }] })).toEqual([
      "context_display.facts.0.key: A fact's key can be 32 characters at most.",
    ]);
    expect(issues({ facts: [{ ...fact('A'), key: 'agent_name' }] })).toEqual([
      'context_display.facts.0.key: The script always has {agent_name}, so a fact cannot use it as its key. Choose another key.',
    ]);
    expect(issues({ facts: [fact('A', 'A', 'due'), fact('B', 'B', 'due')] })).toEqual([
      'context_display.facts.1.key: Two facts cannot have the same key.',
    ]);
  });

  it('the highlight: on or off, one at most', () => {
    expect(issues({ facts: [{ ...fact('A'), highlight: 'yes' }] })).toEqual([
      'context_display.facts.0.highlight: A fact is either highlighted or not.',
    ]);
    expect(issues({ facts: [{ ...fact('A'), highlight: true }, fact('B'), { ...fact('C'), highlight: true }] })).toEqual([
      'context_display.facts.2.highlight: Only one fact can be highlighted.',
    ]);
  });

  it('both campaign-config validators refuse what the rule refuses, keyed on the field', () => {
    for (const validate of [validateInternal, validatePublic]) {
      expect(validate({ context_display: { facts: [fact('A', 'x'.repeat(17))] } }).map((i) => i.field)).toEqual(['context_display.facts.0.label']);
      expect(validate({ context_display: CHOSEN })).toEqual([]);
    }
  });
});

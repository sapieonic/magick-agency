import { describe, expect, it } from 'vitest';
import type { AgencyContextDisplay } from '@magick-agency/contracts/agency';
import { contextDisplayIssues, customerFacts, namesContextColumns } from '../../../src/agency/customer-facts.js';
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
      "context_display.roles.phone: 'phone' is not a role. The roles are: name, place, amount_due, due_date.",
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
    expect(issues({ roles: ['Name'] })).toEqual(['context_display.roles: roles must be an object of role to column name.']);
  });

  it('refuses a type that is not text, money or date', () => {
    expect(issues({ types: { Amount: 'currency' } })).toEqual([
      "context_display.types.Amount: How to read 'Amount' must be one of: text, money, date.",
    ]);
    expect(issues({ types: 'money' })).toEqual(['context_display.types: types must be an object of column name to text, money or date.']);
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

  it('namesContextColumns: only a body that sets roles or types needs the roster read', () => {
    expect(namesContextColumns({ context_display: { roles: {} } })).toBe(true);
    expect(namesContextColumns({ context_display: { types: {} } })).toBe(true);
    expect(namesContextColumns({ context_display: { hero: ['a'] } })).toBe(false);
    expect(namesContextColumns({})).toBe(false);
  });
});

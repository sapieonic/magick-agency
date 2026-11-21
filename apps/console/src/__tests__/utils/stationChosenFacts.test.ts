import { describe, it, expect } from 'vitest';
import { parsePhoneFact } from '@magick-agency/domain/context-facts';
import { chosenFactTiles } from '@magick-agency/domain/fact-tiles';
import {
  chosenFactsFromContext,
  chosenSpans,
  chosenTilesInOrder,
  customerCard,
  factDisplay,
  fitFontSize,
  tileName,
} from '../../utils/agency/stationCustomer';
import { factDay, factPhone, groupedNumber } from '../../utils/agency/stationFormat';
import { fillScriptLine, scriptFillFor } from '../../utils/agency/stationScript';
import { inboundCustomerCard, softphoneCustomerCard } from '../../utils/agency/sideViewCustomer';
import type { AgencyContextDisplay, AgencyFactTile, AgencyReservedAttempt } from '../../types/agency';
import type { AgencyInboundCall } from '../../types/inbound';
import { PHONE_RULE_TABLE, PHONE_RULE_UNREAD } from '../helpers/phoneRule';
import type { AgencyManualCall } from '../../types/softphone';

/**
 * AS19, the station's half (spec §6): the campaign's chosen facts on the card (the label rule,
 * the highlight, the grid, every value format, the masked phone, the "—" for an empty value), the
 * script filled from them ("<label> not given", keys with digits), and the side views built by the
 * same rule. Today's card is covered, unchanged, by `stationParts.test.ts`.
 */

const NOW = new Date('2026-11-21T10:00:00Z');

const tile = (over: Partial<AgencyFactTile> & Pick<AgencyFactTile, 'column'>): AgencyFactTile => ({
  type: 'text',
  raw: '',
  value: null,
  ...over,
});

const ATTEMPT: AgencyReservedAttempt = {
  attempt_id: 'att-1',
  campaign_id: 'camp-1',
  campaign_name: 'EMI collections',
  contact_id: 'c-1',
  phone_e164: '+919876543321',
  caller_id: '+911234567890',
  attempt_number: 2,
  context: {},
  prior_attempts: [
    { attempt_number: 1, outcome: 'connected', disposition_code: 'later', notes: 'Asked to call after salary.', ended_at: '2026-11-12T10:00:00Z', dialed_at: null, campaign_id: 'camp-1', campaign_name: 'EMI collections' },
  ],
};

const DISPLAY: AgencyContextDisplay = {
  facts: [
    { column: 'Outstanding', label: 'Amount due', key: 'amount_due', highlight: true },
    { column: 'EMI date', label: 'Due date', key: 'due_date' },
    { column: 'Branch', label: 'Branch', key: 'branch' },
    { column: 'Alt phone', label: 'Other number', key: 'alt_phone_2' },
  ],
};

const CHOSEN: AgencyReservedAttempt = {
  ...ATTEMPT,
  facts: {
    name: 'Sunita Patil',
    place: 'Pune',
    tiles: [
      tile({ column: 'Outstanding', label: 'Amount due', key: 'amount_due', highlight: true, role: 'amount_due', type: 'money', raw: '1,25,000', value: '125000.00' }),
      tile({ column: 'EMI date', label: 'Due date', key: 'due_date', role: 'due_date', type: 'date', raw: '', value: null }),
      tile({ column: 'Branch', label: 'Branch', key: 'branch', raw: 'Shivajinagar, near the old bus stand' }),
      tile({ column: 'Alt phone', label: 'Other number', key: 'alt_phone_2', type: 'phone', raw: '98765 12345', value: '9876512345' }),
    ],
  },
};

describe('value formats on a chosen fact (AS19, spec §6)', () => {
  it('money with ₹ and Indian grouping, paise only when not zero', () => {
    expect(factDisplay(tile({ column: 'A', type: 'money', raw: '125000', value: '125000.00' })).text).toBe('₹1,25,000');
    expect(factDisplay(tile({ column: 'A', type: 'money', raw: '6250.5', value: '6250.50' })).text).toBe('₹6,250.50');
    expect(factDisplay(tile({ column: 'A', type: 'money', raw: '6250.5', value: '6250.50' }))).toMatchObject({ kind: 'money', fit: true });
  });

  it('a number with Indian grouping and no ₹', () => {
    expect(factDisplay(tile({ column: 'N', type: 'number', raw: '125000', value: '125000' })).text).toBe('1,25,000');
    expect(groupedNumber('1250.75')).toBe('1,250.75');
    expect(groupedNumber('12.00')).toBe('12');
    expect(groupedNumber('twelve')).toBeNull();
  });

  it('a date as 20 Nov, with the year when it is not this year', () => {
    expect(factDisplay(tile({ column: 'D', type: 'date', raw: '20/11/2026', value: '2026-11-20' }), { now: NOW }).text).toBe('20 Nov');
    expect(factDisplay(tile({ column: 'D', type: 'date', raw: '20/11/2027', value: '2027-11-20' }), { now: NOW }).text).toBe('20 Nov 2027');
    expect(factDay('2025-01-05', NOW)).toBe('5 Jan 2025');
  });

  it('a phone formatted as the customer’s own number, and masked when the campaign masks it', () => {
    const phone = tile({ column: 'P', type: 'phone', raw: '98765 12345', value: '9876512345' });
    expect(factDisplay(phone).text).toBe('+91 98765 12345');
    expect(factDisplay(phone, { phoneDisplay: 'masked' }).text).toBe('98••• ••345');
    expect(factPhone('919876512345')).toBe('+91 98765 12345');
    expect(factPhone('+14155550123', 'masked')).toBe('14••• ••123');
    // A phone the server could not read never shows its digits when masked.
    const unread = tile({ column: 'P', type: 'phone', raw: '98-765 ext 1', value: null });
    expect(factDisplay(unread, { phoneDisplay: 'masked' }).text).not.toMatch(/765/);
    expect(factDisplay(unread).text).toBe('98-765 ext 1');
  });

  it.each(PHONE_RULE_TABLE)('one phone rule (R6): %s is %s, masked %s', (input, full, masked) => {
    const value = parsePhoneFact(input);
    expect(value).not.toBeNull();
    expect(factPhone(value!)).toBe(full);
    expect(factPhone(value!, 'masked')).toBe(masked);
    const phone = tile({ column: 'P', type: 'phone', raw: input, value });
    expect(factDisplay(phone).text).toBe(full);
    expect(factDisplay(phone, { phoneDisplay: 'masked' }).text).toBe(masked);
  });

  it('holds the console to the shared cases (fact-rules.json), R6’s six rows among them', () => {
    expect(PHONE_RULE_TABLE).toEqual(expect.arrayContaining([
      ['9876543210', '+91 98765 43210', '98••• ••210'],
      ['919876543210', '+91 98765 43210', '98••• ••210'],
      ['+919876543210', '+91 98765 43210', '98••• ••210'],
      ['09876543210', '+91 98765 43210', '98••• ••210'],
      ['1234567890', '1234567890', '12••• ••890'],
      ['+14155550123', '+14155550123', '14••• ••123'],
    ]));
    expect(PHONE_RULE_UNREAD.length).toBeGreaterThan(0);
  });

  it.each(PHONE_RULE_UNREAD)('an unread phone (%s) is masked by the shared rule (%s) and shown as uploaded in full', (input, masked) => {
    const unread = tile({ column: 'P', type: 'phone', raw: input, value: null });
    expect(factDisplay(unread, { phoneDisplay: 'masked' }).text).toBe(masked);
    expect(factDisplay(unread).text).toBe(input.trim());
  });

  it('a phone the server could not read is masked the same way on its digits, and too short a one shows none', () => {
    const unread = (raw: string) => factDisplay(tile({ column: 'P', type: 'phone', raw, value: null }), { phoneDisplay: 'masked' }).text;
    expect(unread('98765 43210 (home)')).toBe('98••• ••210');
    expect(unread('+91 98765 43210 (home)')).toBe('98••• ••210');
    expect(unread('0 98765 43210 ext')).toBe('98••• ••210');
    expect(unread('call 1234567890')).toBe('12••• ••890');
    expect(unread('12345')).toBe('•••');
  });

  it('fewer than seven digits show none when masked, as the customer\'s own number (S3)', () => {
    expect(factPhone('123456', 'masked')).toBe('•••');
    expect(factPhone('+123456', 'masked')).toBe('•••');
    expect(factPhone('1234567', 'masked')).toBe('12••• ••567');
    expect(factPhone('123456')).toBe('123456');
    expect(factDisplay(tile({ column: 'P', type: 'phone', raw: '123456', value: '123456' }), { phoneDisplay: 'masked' }).text).toBe('•••');
  });

  it('yes / no as Yes and No', () => {
    expect(factDisplay(tile({ column: 'Y', type: 'yes_no', raw: 'haan', value: 'yes' })).text).toBe('Yes');
    expect(factDisplay(tile({ column: 'Y', type: 'yes_no', raw: 'N', value: 'no' })).text).toBe('No');
  });

  it('an unreadable value shows as uploaded; an empty one shows —', () => {
    expect(factDisplay(tile({ column: 'A', type: 'money', raw: 'about 12k', value: null }))).toEqual({ text: 'about 12k', kind: 'text', empty: false, fit: false });
    expect(factDisplay(tile({ column: 'A', type: 'money', raw: '   ', value: null }))).toEqual({ text: '—', kind: 'text', empty: true, fit: false });
    expect(factDisplay(tile({ column: 'T', raw: '  Shivajinagar ' })).text).toBe('Shivajinagar');
  });
});

describe('the chosen facts on the card (AS19)', () => {
  it('names a tile by its label, else its column', () => {
    expect(tileName({ column: 'Outstanding', label: 'Amount due' })).toBe('Amount due');
    expect(tileName({ column: 'Outstanding' })).toBe('Outstanding');
    expect(tileName({ column: 'Outstanding', label: '  ' })).toBe('Outstanding');
  });

  it('shows exactly the chosen tiles, highlight first and two wide, an empty one as —, no Last call tile', () => {
    const card = customerCard(CHOSEN, DISPLAY, { phoneDisplay: 'masked', now: NOW });
    expect(card.chosen).toBe(true);
    expect(card.name).toBe('Sunita Patil');
    expect(card.phone).toBe('98••• ••321');
    expect(card.facts.map((f) => [f.label, f.value, f.column, f.highlight, f.span])).toEqual([
      ['Amount due', '₹1,25,000', 'Outstanding', true, 6],
      ['Due date', '—', 'EMI date', false, 3],
      ['Branch', 'Shivajinagar, near the old bus stand', 'Branch', false, 3],
      // The last row holds one tile: it takes the whole row. A masked phone stays masked.
      ['Other number', '98••• ••345', 'Alt phone', false, 12],
    ]);
    expect(card.facts[1]!.empty).toBe(true);
    expect(card.facts.some((f) => f.kind === 'last_call')).toBe(false);
    // The Full / Half chips still read the amount due.
    expect(card.amountDue).toBe('125000.00');
  });

  it('moves the first highlighted tile first and ignores a second highlight', () => {
    const tiles = [
      tile({ column: 'A', key: 'a' }),
      tile({ column: 'B', key: 'b', highlight: true }),
      tile({ column: 'C', key: 'c', highlight: true }),
    ];
    expect(chosenTilesInOrder(tiles).map((t) => [t.column, t.highlight === true])).toEqual([
      ['B', true],
      ['A', false],
      ['C', false],
    ]);
  });

  it('lays tiles four across, the highlight two wide, and shares a last row that is not full', () => {
    expect(chosenSpans([false, false, false, false])).toEqual([3, 3, 3, 3]);
    expect(chosenSpans([false, false, false])).toEqual([4, 4, 4]);
    expect(chosenSpans([false, false])).toEqual([6, 6]);
    expect(chosenSpans([false])).toEqual([12]);
    expect(chosenSpans([true])).toEqual([12]);
    expect(chosenSpans([true, false])).toEqual([8, 4]);
    expect(chosenSpans([true, false, false])).toEqual([6, 3, 3]);
    expect(chosenSpans([true, false, false, false])).toEqual([6, 3, 3, 12]);
  });

  it('calls a nameless customer "Customer" only with chosen facts', () => {
    const card = customerCard({ ...CHOSEN, facts: { tiles: CHOSEN.facts!.tiles } }, DISPLAY);
    expect(card.name).toBeNull();
    expect(card.chosen).toBe(true);
    // Today's card keeps the phone as the title: `chosen` false (stationParts.test.ts).
    expect(customerCard({ ...ATTEMPT, context: { Loan: 'L-1' } }, {}).chosen).toBe(false);
  });

  it('an empty list of facts shows the name and number only', () => {
    const card = customerCard({ ...ATTEMPT, facts: { name: 'Sunita Patil', tiles: [] } }, { facts: [] });
    expect(card.chosen).toBe(true);
    expect(card.facts).toEqual([]);
  });

  it('is chosen by the display’s `facts` alone (R8): labelled tiles under a display without it get today’s card', () => {
    // Today's card: Last call tile, tiles named by column, no "Customer" title.
    const legacy = customerCard(CHOSEN, { hero: ['Outstanding'] }, { now: NOW });
    expect(legacy.chosen).toBe(false);
    expect(legacy.facts.map((f) => f.label)).toEqual(['Outstanding', 'Branch', 'Last call']);
    expect(customerCard(CHOSEN, undefined).chosen).toBe(false);
    // And the script keeps the legacy fill: a missing value is left out.
    const fill = scriptFillFor(CHOSEN, { name: null, place: null }, { agentName: 'Ravi', campaignName: 'EMI' }, { hero: ['Outstanding'] });
    expect(fillScriptLine('{place}{branch}', fill).shown).toBe('{branch}');
  });

  it('`facts: []` shows no tiles and no Last call, never today’s card (R7, R8)', () => {
    const context = { Name: 'Ramesh Goud', City: 'Siddipet', 'Amount due': '12500' };
    const card = customerCard({ ...ATTEMPT, context }, { facts: [], hero: ['Amount due'] });
    expect(card.chosen).toBe(true);
    expect(card.facts).toEqual([]);
  });

  it('takes the name from `facts.name` only, else none (R9): no guess from the row on a reserved call', () => {
    const attempt = { ...ATTEMPT, context: { Name: 'Ramesh Goud', City: 'Siddipet' }, facts: { tiles: CHOSEN.facts!.tiles } };
    const card = customerCard(attempt, DISPLAY);
    expect(card.name).toBeNull();
    expect(card.place).toBeNull();
    // Today's card still guesses.
    expect(customerCard({ ...attempt, facts: undefined }, {}).name).toBe('Ramesh Goud');
  });

  it('shrinks a value to fit, down to 65 %, then leaves it to the ellipsis', () => {
    expect(fitFontSize(28, 200, 180)).toBeNull();
    expect(fitFontSize(28, 200, 250)).toBe(21.5);
    // Never under 65 % of 28 (18.2, to the half pixel up).
    expect(fitFontSize(28, 100, 400)).toBe(18.5);
    expect(fitFontSize(Number.NaN, 100, 400)).toBeNull();
  });
});

describe('the side views build the chosen facts from the contact’s row (AS19)', () => {
  const display: AgencyContextDisplay = {
    roles: { name: 'Borrower', place: 'Town' },
    types: { outstanding: 'money', 'Alt phone': 'phone' },
    hidden: ['Secret'],
    facts: [
      { column: 'Outstanding', label: 'Amount due', key: 'amount_due' },
      { column: 'Secret', label: 'Hidden', key: 'secret' },
      { column: 'Missing', label: 'Not on this row', key: 'missing' },
      { column: 'alt phone', label: 'Other number', key: 'alt_phone', highlight: true },
    ],
  };
  const context = { Borrower: 'Ramesh Goud', Town: 'Siddipet', Outstanding: '12500', Secret: 'x', 'Alt phone': '9876512345' };

  it('reads the row by the server’s rule: matched ignoring case, never hidden or missing, typed by `types`, highlight first (S6)', () => {
    const facts = chosenFactsFromContext(context, display)!;
    expect(facts.name).toBe('Ramesh Goud');
    expect(facts.place).toBe('Siddipet');
    expect(facts.tiles.map((t) => [t.column, t.label, t.type, t.value, t.highlight === true, t.role])).toEqual([
      ['Alt phone', 'Other number', 'phone', '9876512345', true, undefined],
      ['Outstanding', 'Amount due', 'money', '12500', false, 'amount_due'],
    ]);
    // The server's own builder, exactly (the console keeps no copy).
    expect(facts.tiles).toEqual(chosenFactTiles(context, display));
    expect(chosenFactsFromContext(context, { hero: ['Outstanding'] })).toBeNull();
  });

  it('de-dupes a repeated column and trims labels, as the server does (S6)', () => {
    const twice: AgencyContextDisplay = {
      facts: [
        { column: 'Outstanding', label: '  Amount due  ', key: 'amount_due' },
        { column: 'outstanding', label: 'Again', key: 'again' },
      ],
    };
    expect(chosenFactsFromContext(context, twice)!.tiles.map((t) => [t.column, t.label])).toEqual([['Outstanding', 'Amount due']]);
  });

  it('names the customer by the server’s rule (S1): the guess from the column names, no place guess with facts (S2)', () => {
    // `Branch` read as the place by the console's old guess; the server's rule never does.
    const row = { 'Customer Name': 'Asha Rao', Branch: 'Kothrud', City: 'Pune', Outstanding: '12500' };
    const chosen = chosenFactsFromContext(row, { facts: [{ column: 'Outstanding', label: 'Amount due', key: 'amount_due' }] })!;
    expect([chosen.name, chosen.place]).toEqual(['Asha Rao', undefined]);
    // Without facts (today's card on a side view): the guess, City as the place, never Branch.
    const call = (c: Record<string, unknown>, d: AgencyContextDisplay | undefined) =>
      ({ from_e164: '+919876543321', match: { campaign_id: 'camp-1', context: c, prior_attempts: [], context_display: d } }) as unknown as AgencyInboundCall;
    const legacy = inboundCustomerCard(call(row, {}));
    expect([legacy.name, legacy.place]).toEqual(['Asha Rao', 'Pune']);
    const noGuess = inboundCustomerCard(call({ 'Customer ID': 'C-7', Branch: 'Kothrud' }, {}));
    expect([noGuess.name, noGuess.place]).toEqual([null, null]);
    // Without facts, a name the rule cannot find falls back to the card's guess from before AS19; with facts, never.
    expect(inboundCustomerCard(call({ 'Customer ID': 'C-7', Branch: 'Kothrud', Borrower: 'Ramesh' }, {})).name).toBe('Ramesh');
    expect(inboundCustomerCard(call({ 'Customer ID': 'C-7', Branch: 'Kothrud', Borrower: 'Ramesh' }, { facts: [] })).name).toBeNull();
    // A role names the column, even one the guess would not read.
    const roles = inboundCustomerCard(call({ Borrower: 'Ramesh', Branch: 'Kothrud' }, { roles: { name: 'Borrower', place: 'Branch' } }));
    expect([roles.name, roles.place]).toEqual(['Ramesh', 'Kothrud']);
  });

  it('an inbound caller and a soft-phone call show the same card, the inbound number masked as the station says', () => {
    const call = {
      from_e164: '+919876543321',
      match: { campaign_id: 'camp-1', context, prior_attempts: [], context_display: display },
    } as unknown as AgencyInboundCall;
    const inbound = inboundCustomerCard(call, 'masked');
    expect(inbound.chosen).toBe(true);
    expect(inbound.name).toBe('Ramesh Goud');
    expect(inbound.facts.map((f) => [f.label, f.value])).toEqual([
      ['Other number', '98••• ••345'],
      ['Amount due', '₹12,500'],
    ]);
    const manual = { destination_e164: '+919876543321', contact: { context, prior_attempts: [] } } as unknown as AgencyManualCall;
    expect(softphoneCustomerCard(manual, display).facts.map((f) => f.label)).toEqual(['Other number', 'Amount due']);
  });

  it('the soft phone masks its phone facts as the station says, the dialled number as typed (S3(b))', () => {
    const manual = { destination_e164: '+919876543321', contact: { context, prior_attempts: [] } } as unknown as AgencyManualCall;
    const masked = softphoneCustomerCard(manual, display, 'masked');
    expect(masked.facts.map((f) => f.value)).toEqual(['98••• ••345', '₹12,500']);
    expect(masked.phone).toBe('+91 98765 43321');
    const full = softphoneCustomerCard(manual, display, 'full');
    expect(full.facts.map((f) => f.value)).toEqual(['+91 98765 12345', '₹12,500']);
    // Today's card on the soft phone: a column `types` calls a phone is masked too.
    const legacy = softphoneCustomerCard(manual, { hero: ['Alt phone', 'Outstanding'], types: { 'Alt phone': 'phone' } }, 'masked');
    expect(legacy.facts.map((f) => [f.label, f.value])).toEqual([['Alt phone', '98••• ••345'], ['Outstanding', '12500']]);
    expect(legacy.phone).toBe('+91 98765 43321');
  });
});

describe('a phone number never escapes hidden-number on today’s card (S3(b))', () => {
  const typed = (over: Partial<AgencyFactTile>): AgencyReservedAttempt => ({
    ...ATTEMPT,
    facts: { name: 'Sunita', tiles: [tile({ column: 'Alt phone', type: 'phone', raw: '98765 12345', value: '9876512345', ...over })] },
  });

  it('a phone-typed tile is formatted and masked by the one phone rule', () => {
    expect(customerCard(typed({}), undefined, { phoneDisplay: 'masked' }).facts[0]).toMatchObject({ label: 'Alt phone', value: '98••• ••345', kind: 'phone' });
    expect(customerCard(typed({}), undefined, { phoneDisplay: 'full' }).facts[0]).toMatchObject({ value: '+91 98765 12345', kind: 'phone' });
    // One the server could not read: masked on its digits, as uploaded in full.
    const unread = typed({ raw: '98765 12345 (home)', value: null });
    expect(customerCard(unread, undefined, { phoneDisplay: 'masked' }).facts[0]).toMatchObject({ value: '98••• ••345', kind: 'text' });
    expect(customerCard(unread, undefined, { phoneDisplay: 'full' }).facts[0]!.value).toBe('98765 12345 (home)');
  });

  it('a name or place read from a phone-typed column is masked (a display stored before S3(e))', () => {
    const attempt = { ...ATTEMPT, context: { Contact: '9876512345', Mobile: '9123456780' }, facts: { name: '9876512345', place: '9123456780', tiles: [] } };
    const display: AgencyContextDisplay = { roles: { name: 'Contact', place: 'Mobile' }, types: { Contact: 'phone', mobile: 'phone' } };
    const masked = customerCard(attempt, display, { phoneDisplay: 'masked' });
    expect([masked.name, masked.place, masked.initials]).toEqual(['98••• ••345', '91••• ••780', '']);
    const full = customerCard(attempt, display, { phoneDisplay: 'full' });
    expect([full.name, full.place]).toEqual(['9876512345', '9123456780']);
    // A text column is never masked.
    expect(customerCard(attempt, { roles: { name: 'Contact', place: 'Mobile' } }, { phoneDisplay: 'masked' }).name).toBe('9876512345');
  });
});

describe('the script filled from the chosen facts (AS19)', () => {
  const session = { agentName: 'Ravi Kumar', campaignName: 'EMI collections' };

  it('fills keys with digits, from tiles by key, and shows an empty one as "<label> not given"', () => {
    const fill = scriptFillFor(CHOSEN, { name: 'Sunita Patil', place: null }, session, DISPLAY, { phoneDisplay: 'masked', now: NOW });
    const line = fillScriptLine('Namaste {name} from {place}. {amount_due} is due on {due_date}. Other: {alt_phone_2}. {Branch} {mood}', fill);
    expect(line.shown).toBe(
      'Namaste Sunita Patil from Place not given. ₹1,25,000 is due on Due date not given. Other: 98••• ••345. {Branch} {mood}',
    );
    expect(line.pieces.filter((p) => p.kind === 'missing').map((p) => p.text)).toEqual(['Place not given', 'Due date not given']);
    // Read aloud skips the "not given" runs.
    expect(line.spoken).toBe('Namaste Sunita Patil from. ₹1,25,000 is due on. Other: 98••• ••345. {Branch} {mood}');
  });

  it('leaves {agent_name} and {campaign_name} out when they have no value, never "not given" (R5)', () => {
    const fill = scriptFillFor(CHOSEN, { name: 'Sunita Patil', place: 'Pune' }, { agentName: null, campaignName: '  ' }, DISPLAY);
    const line = fillScriptLine('This is {agent_name} from {campaign_name}, {name}.', fill);
    expect(line.shown).toBe('This is  from , Sunita Patil.');
    expect(line.pieces.every((p) => p.kind === 'text')).toBe(true);
    expect(line.spoken).toBe('This is from, Sunita Patil.');
    // The legacy fill leaves them out too.
    const legacy = scriptFillFor({ facts: undefined }, { name: 'Sunita', place: null }, { agentName: undefined, campaignName: null }, undefined);
    expect(fillScriptLine('{agent_name}|{campaign_name}|{name}', legacy).shown).toBe('||Sunita');
  });

  it.each(PHONE_RULE_TABLE)('fills a phone fact by the one phone rule (R6): %s', (input, full, masked) => {
    const attempt = {
      facts: { tiles: [tile({ column: 'Alt phone', label: 'Other number', key: 'alt_phone', type: 'phone', raw: input, value: parsePhoneFact(input) })] },
    };
    const display: AgencyContextDisplay = { facts: [{ column: 'Alt phone', label: 'Other number', key: 'alt_phone' }] };
    const card = { name: null, place: null };
    expect(fillScriptLine('{alt_phone}', scriptFillFor(attempt, card, session, display)).shown).toBe(full);
    expect(fillScriptLine('{alt_phone}', scriptFillFor(attempt, card, session, display, { phoneDisplay: 'masked' })).shown).toBe(masked);
  });

  it('fills a legacy role tile by its role when the panel’s tiles carry no keys', () => {
    const attempt = {
      ...ATTEMPT,
      facts: { tiles: [tile({ column: 'Balance', role: 'amount_due', type: 'money', raw: '12500', value: '12500.00' })] },
    };
    const fill = scriptFillFor(attempt, { name: null, place: null }, session, { facts: [{ column: 'Balance', label: 'Balance', key: 'amount_due' }] });
    expect(fillScriptLine('{amount_due} by {agent_name}', fill).shown).toBe('₹12,500 by Ravi');
  });

  it('without chosen facts keeps today’s fill: a missing value is left out, never "not given"', () => {
    const fill = scriptFillFor({ facts: undefined }, { name: 'Sunita', place: null }, session, undefined);
    const line = fillScriptLine('Namaste {name} from {place}. {branch}', fill);
    expect(line.shown).toBe('Namaste Sunita from . {branch}');
    expect(line.pieces.every((p) => p.kind === 'text')).toBe(true);
  });

  it('the legacy fill reads keys with digits too (the one reading of braces)', () => {
    const legacy = { allowed: ['emi_2', 'due_date'], valueOf: (k: string) => (k === 'emi_2' ? '₹4,500' : null), labelOf: () => null };
    expect(fillScriptLine('Pay {emi_2} by {due_date}', legacy).shown).toBe('Pay ₹4,500 by ');
  });
});

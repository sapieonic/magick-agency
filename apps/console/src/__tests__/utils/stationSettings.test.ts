import { describe, it, expect } from 'vitest';
import type { AgencyContextFieldType, AgencyFactField } from '@magick-agency/contracts/agency';
import { parseContextFact } from '@magick-agency/domain/context-facts';
import { configuredHeroNames } from '@magick-agency/domain/context-hero';
import { factDisplay } from '../../utils/agency/stationCustomer';
import {
  COLUMNS_FAILED_MESSAGE,
  COLUMNS_LOADING_MESSAGE,
  FACTS_LIMIT_MESSAGE,
  FACT_COLUMN_MISSING_MESSAGE,
  NAME_PHONE_MESSAGE,
  PLACE_PHONE_MESSAGE,
  campaignColumns,
  canMoveFact,
  columnNamed,
  columnType,
  contextDisplayPayload,
  dailyTargetError,
  dailyTargetPayload,
  factsChanged,
  factsErrors,
  factsFormOf,
  factsReordered,
  insertAt,
  moveFact,
  nameColumnOf,
  newFact,
  placeColumnOf,
  putBack,
  removedFactsInUse,
  replaceToken,
  sameColumn,
  sampleText,
  scriptErrors,
  scriptPayload,
  stationChanges,
  stationErrors,
  stationPayload,
  stationPlan,
  stationSettingsOf,
  withAmountDue,
  withColumnType,
  withHighlight,
  withoutPlacedFactErrors,
  type FactsForm,
  type StationSettingsForm,
} from '../../utils/agency/stationSettings';
import type { AgencyCampaign } from '../../types/agency-campaign';

/**
 * The agent station's campaign settings as campaign Settings edits them (AS6, AS9, AS19, BE-6,
 * BE-8): read from the campaign (an old-model card opened with what agents see today), each rule
 * the server's write applies, and what a save sends (only what changed; the card with `facts` and
 * without the old amount-due and due-date roles; the card with a script that needs it).
 */

const campaign = (over: Partial<AgencyCampaign> = {}): AgencyCampaign => ({ id: 'c-1', name: 'C', status: 'draft', ...over });
const fact = (column: string, key: string, label = column, extra: Partial<AgencyFactField> = {}): AgencyFactField => ({ column, label, key, ...extra });
const facts = (over: Partial<FactsForm> = {}): FactsForm => ({ name: '', place: '', list: [], types: {}, moreHidden: [], ...over });
const ctx = (over: { hidden?: string[]; uploaded?: string[] } = {}) => ({ hidden: [], uploaded: [], ...over });

function form(over: Partial<StationSettingsForm> = {}): StationSettingsForm {
  return { dailyTarget: '', phoneDisplay: 'full', script: { opening: '', steps: [] }, facts: facts(), ...over };
}

describe('stationSettingsOf', () => {
  it('reads an untouched campaign as no target, the full number, no script and an empty card', () => {
    expect(stationSettingsOf(campaign())).toEqual(form());
  });

  it('reads a card saved with facts as it is', () => {
    const list = [fact('Due', 'amount_due', 'Amount due', { highlight: true }), fact('Loan ID', 'loan_id')];
    expect(stationSettingsOf(campaign({
      daily_target_calls: 40,
      phone_display: 'masked',
      agent_script: { opening: 'Hello {name}', steps: [{ text: 'Ask' }, { text: 'Close' }] },
      context_display: { hero: ['Ignored'], roles: { name: 'Borrower', place: 'City' }, facts: list, types: { Due: 'money', Ph: 'phone', Ok: 'yes_no', N: 'number' } },
    }))).toEqual(form({
      dailyTarget: '40',
      phoneDisplay: 'masked',
      script: { opening: 'Hello {name}', steps: ['Ask', 'Close'] },
      facts: { name: 'Borrower', place: 'City', list, types: { Due: 'money', Ph: 'phone', Ok: 'yes_no', N: 'number' }, moreHidden: [] },
    }));
  });

  it('reads anything malformed as unset, never failing the page', () => {
    expect(stationSettingsOf(campaign({
      daily_target_calls: null,
      phone_display: 'odd' as never,
      agent_script: 'x' as never,
      context_display: { roles: { name: 7, place: 'Town' } as never, types: { A: 'percent', B: 'yes_no' } as never },
    }))).toEqual(form({ facts: facts({ place: 'Town', types: { B: 'yes_no' } }) }));
  });
});

describe('the card of a campaign saved before AS19 (the pre-fill)', () => {
  const roster = ['Name', 'City', 'Loan ID', 'Branch', 'Amount', 'Due On', 'PAN'];

  it('opens with what agents see today, in the old card’s order: the amount, the due date, then the other heroes (S9)', () => {
    const display = {
      hero: ['Name', 'Loan ID', 'Branch'],
      hidden: ['PAN'],
      roles: { amount_due: 'Amount', due_date: 'due on' },
    };
    expect(factsFormOf(display, roster)).toEqual({
      name: '',
      place: '',
      list: [
        fact('Amount', 'amount_due'),
        fact('Due On', 'due_date'),
        fact('Loan ID', 'loan_id'),
        fact('Branch', 'branch'),
      ],
      // Read as money and a date, as their roles read them before: the new model reads by type alone.
      types: { Amount: 'money', 'Due On': 'date' },
      moreHidden: [],
    });
  });

  it('keeps the old roles’ columns when the 4 bites, cuts each name to 16 letters, and highlights nothing', () => {
    const display = {
      hero: ['Outstanding principal amount', 'Branch', 'Loan ID', 'City'],
      roles: { amount_due: 'Amount', place: 'City' },
      types: { Amount: 'number' as const },
    };
    const card = factsFormOf(display, ['Outstanding principal amount', 'Branch', 'Loan ID', 'City', 'Amount']);
    expect(card.list).toEqual([
      fact('Amount', 'amount_due'),
      fact('Outstanding principal amount', 'outstanding_principal_amount', 'Outstanding prin'),
      fact('Branch', 'branch'),
      fact('Loan ID', 'loan_id'),
    ]);
    // The role overrode `types` before, so its column is money whatever was stored (AS19 R10).
    expect(card.types).toEqual({ Amount: 'money' });
    expect(card.place).toBe('City');
  });

  it('leaves out the column the card guesses as the name or the line under it', () => {
    expect(factsFormOf({}, ['Customer Name', 'Town', 'Loan ID']).list).toEqual([fact('Loan ID', 'loan_id')]);
  });

  it('writes nothing until saved: an untouched old-model card is no change and sends nothing', () => {
    const stored = { hero: ['Loan ID'], roles: { amount_due: 'Amount' } };
    const loaded = stationSettingsOf(campaign({ context_display: stored }), roster);
    expect(stationChanges(loaded, loaded)).toEqual([]);
    expect(stationPayload(loaded, { ...loaded, dailyTarget: '10' }, stored)).toEqual({ daily_target_calls: 10 });
  });
});

describe('guessing the name and the line under it, by the domain’s one guess (S1)', () => {
  it('takes the guesses in their order, ignoring case, spaces and underscores, never a hidden column', () => {
    expect(nameColumnOf(facts(), ['First Name', 'Full_Name'], [])).toBe('Full_Name');
    expect(nameColumnOf(facts(), ['NAME', 'City'], ['name'])).toBeUndefined();
    expect(nameColumnOf(facts(), ['Loan'], [])).toBeUndefined();
    expect(placeColumnOf(facts(), ['Name', 'Town', 'City'], [])).toBe('City');
  });

  it('never guesses a fact’s column, nor the other role’s; a chosen one wins; “None” is none (S2)', () => {
    const columns = ['Name', 'Full Name', 'City', 'Town'];
    expect(nameColumnOf(facts({ list: [fact('Name', 'name_2')] }), columns, [])).toBe('Full Name');
    expect(nameColumnOf(facts({ place: 'Name' }), columns, [])).toBe('Full Name');
    expect(placeColumnOf(facts({ list: [fact('City', 'city')] }), columns, [])).toBe('Town');
    expect(placeColumnOf(facts({ name: 'City' }), columns, [])).toBe('Town');
    expect(placeColumnOf(facts({ place: 'Branch' }), columns, [])).toBe('Branch');
    expect(placeColumnOf(facts({ place: null }), columns, [])).toBeUndefined();
  });

  it('never guesses a column typed as a phone number, so the guess shown is the next one', () => {
    const columns = ['Name', 'Full Name', 'City', 'Town'];
    const typed = facts({ types: { name: 'phone', City: 'phone' } });
    expect(nameColumnOf(typed, columns, [])).toBe('Full Name');
    expect(placeColumnOf(typed, columns, [])).toBe('Town');
    // The old model's pre-fill leaves out only what the card guesses: a phone column stays a fact.
    expect(factsFormOf({ types: { Name: 'phone' } }, ['Name', 'Customer Name', 'Loan ID']).list.map((f) => f.column))
      .toEqual(['Name', 'Loan ID']);
  });
});

describe('the daily target (AS6)', () => {
  it('takes 1 to 2,000 whole calls, or empty for none', () => {
    for (const ok of ['', '  ', '1', '2000', ' 60 ']) expect(dailyTargetError(ok), ok).toBeNull();
    for (const bad of ['0', '2001', '1.5', '-3', 'ten', '1e3']) {
      expect(dailyTargetError(bad), bad).toBe('Enter a whole number of calls from 1 to 2,000, or leave it empty for no target.');
    }
  });

  it('sends the number, and null to clear it', () => {
    expect(dailyTargetPayload(' 60 ')).toBe(60);
    expect(dailyTargetPayload('')).toBeNull();
  });
});

describe('the script (BE-8, AS19)', () => {
  const keys = ['name', 'place', 'agent_name', 'campaign_name', 'loan_id'];

  it('says each problem on its field, keyed as the server keys it, with the server’s words for a key the card does not have', () => {
    const errors = scriptErrors({
      opening: 'x'.repeat(301),
      steps: ['Fine {name} {loan_id}', '   ', 'y'.repeat(201), 'Hello {branch}', '{Name} and {due_date}'],
    }, keys);
    expect(Object.keys(errors).sort()).toEqual([
      'agent_script.opening',
      'agent_script.steps[1].text',
      'agent_script.steps[2].text',
      'agent_script.steps[3].text',
      'agent_script.steps[4].text',
    ]);
    expect(errors['agent_script.opening']).toBe('The opening line is 301 characters. Keep it to 300.');
    expect(errors['agent_script.steps[1].text']).toBe('Write step 2, or remove it.');
    expect(errors['agent_script.steps[3].text']).toBe('The script uses {branch}, which is not a fact on the card. Add it as a fact or take it out.');
    expect(errors['agent_script.steps[4].text'])
      .toBe('The script uses {Name} and {due_date}, which are not facts on the card. Add them as facts or take them out.');
  });

  it('counts characters as the server does: code points, after trimming', () => {
    expect(scriptErrors({ opening: ` ${'₹'.repeat(300)} `, steps: [] }, keys)).toEqual({});
    expect(scriptErrors({ opening: '😀'.repeat(300), steps: [] }, keys)).toEqual({});
  });

  it('refuses a thirteenth step', () => {
    expect(scriptErrors({ opening: '', steps: Array.from({ length: 13 }, () => 'a') }, keys)['agent_script.steps'])
      .toBe('A script can have at most 12 steps.');
  });

  it('sends each text trimmed, an empty part left out, and {} for no script', () => {
    expect(scriptPayload({ opening: '  Hi  ', steps: [' a ', 'b'] })).toEqual({ opening: 'Hi', steps: [{ text: 'a' }, { text: 'b' }] });
    expect(scriptPayload({ opening: ' ', steps: [] })).toEqual({});
  });

  it('puts a key at the caret, spaced from the words either side', () => {
    expect(insertAt('Hello', 5, 5, '{name}')).toEqual({ text: 'Hello {name}', caret: 12 });
    expect(insertAt('Hello there', 6, 6, '{name}')).toEqual({ text: 'Hello {name} there', caret: 12 });
    expect(insertAt('', 0, 0, '{name}')).toEqual({ text: '{name}', caret: 6 });
    expect(insertAt('Hi you', 3, 6, '{name}')).toEqual({ text: 'Hi {name}', caret: 9 });
  });

  it('swaps a word for another key everywhere, or takes it out with the space before it', () => {
    const script = { opening: 'Hi {branch}, from {branch}.', steps: ['Your {branch} office'] };
    expect(replaceToken(script, '{branch}', '{loan_id}')).toEqual({ opening: 'Hi {loan_id}, from {loan_id}.', steps: ['Your {loan_id} office'] });
    expect(replaceToken(script, '{branch}', '')).toEqual({ opening: 'Hi, from.', steps: ['Your office'] });
  });
});

describe('the card’s facts (AS19)', () => {
  it('makes a new fact’s name and key from the header, each unlike the others’ (S9)', () => {
    expect(newFact('Loan ID', [])).toEqual(fact('Loan ID', 'loan_id'));
    expect(newFact('Loan-ID', [fact('Loan ID', 'loan_id')])).toEqual(fact('Loan-ID', 'loan_id_2'));
    expect(newFact('Outstanding principal amount', []).label).toBe('Outstanding prin');
    // Two headers alike in their first 16 letters: the second name is cut to fit " 2".
    const first = newFact('Outstanding Balance (₹)', []);
    expect(newFact('Outstanding Balance Today', [first]).label).toBe('Outstanding Ba 2');
    expect(newFact('loan id', [fact('Loan ID', 'loan_id')]).label).toBe('loan id 2');
  });

  it('uses one money fact for Full and Half: its key becomes {amount_due}, the one before gets its own back (S9)', () => {
    const list = [fact('Loan Amount', 'amount_due', 'Loan'), fact('EMI', 'emi'), fact('Branch', 'branch')];
    const emi = withAmountDue(list, 1, true);
    expect(emi.map((f) => f.key)).toEqual(['loan_amount', 'amount_due', 'branch']);
    // Names, columns and order stay; no other key is touched.
    expect(emi.map((f) => f.label)).toEqual(['Loan', 'EMI', 'Branch']);
    // Off: its own default key, never {amount_due} again, even for a column named so.
    expect(withAmountDue(emi, 1, false).map((f) => f.key)).toEqual(['loan_amount', 'emi', 'branch']);
    expect(withAmountDue([fact('Amount Due', 'amount_due')], 0, false)[0]!.key).toBe('amount_due_2');
    expect(withAmountDue(list, 7, true)).toEqual(list);
  });

  it('keeps a fact’s key when its name is renamed', () => {
    const before = facts({ list: [fact('Loan ID', 'loan_id')] });
    const renamed = { ...before, list: [{ ...before.list[0]!, label: 'Account' }] };
    expect(renamed.list[0]!.key).toBe('loan_id');
    expect(contextDisplayPayload({}, renamed).facts).toEqual([{ column: 'Loan ID', label: 'Account', key: 'loan_id' }]);
  });

  it('highlights one fact at most, and moves it first', () => {
    const list = [fact('A', 'a'), fact('B', 'b', 'B', { highlight: true }), fact('C', 'c')];
    const third = withHighlight(list, 2, true);
    expect(third.map((f) => f.key)).toEqual(['c', 'a', 'b']);
    expect(third.filter((f) => f.highlight).map((f) => f.key)).toEqual(['c']);
    expect(withHighlight(third, 0, false).some((f) => f.highlight)).toBe(false);
  });

  it('moves a fact, never above the highlighted one, which stays first', () => {
    const list = [fact('A', 'a', 'A', { highlight: true }), fact('B', 'b'), fact('C', 'c')];
    expect(canMoveFact(list, 1, -1)).toBe(false);
    expect(canMoveFact(list, 0, 1)).toBe(false);
    expect(canMoveFact(list, 1, 1)).toBe(true);
    expect(moveFact(list, 2, 0).map((f) => f.key)).toEqual(['a', 'c', 'b']);
    expect(moveFact(list, 0, 2).map((f) => f.key)).toEqual(['a', 'b', 'c']);
    const plain = [fact('A', 'a'), fact('B', 'b'), fact('C', 'c')];
    expect(moveFact(plain, 2, 0).map((f) => f.key)).toEqual(['c', 'a', 'b']);
  });

  it('refuses a fifth fact and a second highlight on the list', () => {
    const five = facts({ list: ['A', 'B', 'C', 'D', 'E'].map((c) => fact(c, c.toLowerCase())) });
    expect(factsErrors(five, ctx())['context_display.facts']).toBe(FACTS_LIMIT_MESSAGE);
    expect(FACTS_LIMIT_MESSAGE).toBe('You can show 4 facts at most. Remove one to add another.');
    const two = facts({ list: [fact('A', 'a', 'A', { highlight: true }), fact('B', 'b', 'B', { highlight: true })] });
    expect(factsErrors(two, ctx())['context_display.facts']).toBe('Only one fact can be highlighted.');
  });

  it('refuses a name empty, longer than 16 letters, or the same as another’s ignoring case, on the second', () => {
    const errors = factsErrors(facts({
      list: [fact('A', 'a', '  '), fact('B', 'b', 'x'.repeat(17)), fact('C', 'c', 'Due'), fact('D', 'd', ' due ')],
    }), ctx());
    expect(errors).toEqual({
      'context_display.facts.0.label': 'Give this fact a name.',
      'context_display.facts.1.label': 'A fact’s name can be 16 letters at most.',
      'context_display.facts.3.label': 'Two facts cannot have the same name.',
    });
    // 16 letters is fine, counted as the server counts: code points, after trimming.
    expect(factsErrors(facts({ list: [fact('A', 'a', ` ${'₹'.repeat(16)} `)] }), ctx())).toEqual({});
  });

  it('refuses a column hidden, already the name or the line under it, twice on the card, or not in the latest upload', () => {
    const errors = factsErrors(facts({
      name: 'Borrower',
      place: 'City',
      list: [fact('PAN', 'pan'), fact('borrower', 'b'), fact('CITY', 'c'), fact('Loan', 'loan'), fact('loan', 'loan_2'), fact('Gone', 'gone')],
    }), ctx({ hidden: ['pan'], uploaded: ['Borrower', 'City', 'Loan', 'PAN'] }));
    expect(errors).toMatchObject({
      'context_display.facts.0.column': '‘PAN’ is hidden from agents. Choose another column or remove the fact.',
      'context_display.facts.1.column': '‘borrower’ is already the customer’s name. Choose another column or remove the fact.',
      'context_display.facts.2.column': '‘CITY’ is already the line under the name. Choose another column or remove the fact.',
      'context_display.facts.4.column': '‘loan’ is already on the card.',
      'context_display.facts.5.column': FACT_COLUMN_MISSING_MESSAGE,
    });
    expect(FACT_COLUMN_MISSING_MESSAGE).toBe('This column is not in the latest upload. Choose another or remove the fact.');
    // With no upload read, no column is said to be missing.
    expect(factsErrors(facts({ list: [fact('Gone', 'gone')] }), ctx())).toEqual({});
  });

  it('refuses a key the server would not take', () => {
    const errors = factsErrors(facts({ list: [fact('A', 'name'), fact('B', 'Bad'), fact('C', 'c'), fact('D', 'c', 'Dee')] }), ctx());
    expect(Object.keys(errors).sort()).toEqual(['context_display.facts.0.key', 'context_display.facts.1.key', 'context_display.facts.3.key']);
  });

  it('refuses a phone number as the name or the line under it, chosen or guessed, in the server’s words (S3(e))', () => {
    const phone = { Name: 'phone' as const, City: 'phone' as const };
    expect(factsErrors(facts({ name: 'Name', place: 'City', types: phone }), ctx())).toEqual({
      'context_display.roles.name': NAME_PHONE_MESSAGE,
      'context_display.roles.place': PLACE_PHONE_MESSAGE,
    });
    expect(NAME_PHONE_MESSAGE).toBe("A phone number cannot be the customer's name. Add it as a fact instead.");
    expect(PLACE_PHONE_MESSAGE).toBe('A phone number cannot be the line under the name. Add it as a fact instead.');
    // On "Guess" the guess never picks a phone column, so there is nothing to refuse: the next column
    // on the list is the guess, or none; "None" is none.
    const guessed = facts({ types: phone });
    expect(factsErrors(guessed, { ...ctx(), columns: ['Name', 'City'] })).toEqual({});
    expect([nameColumnOf(guessed, ['Name', 'City'], []), placeColumnOf(guessed, ['Name', 'City'], [])]).toEqual([undefined, undefined]);
    expect([nameColumnOf(guessed, ['Name', 'Full Name', 'City', 'Town'], []), placeColumnOf(guessed, ['Name', 'Full Name', 'City', 'Town'], [])])
      .toEqual(['Full Name', 'Town']);
    expect(factsErrors(facts({ place: null, types: { City: 'phone' } }), { ...ctx(), columns: ['Name', 'City'] })).toEqual({});
  });

  it('refuses a hidden name or line under it, and one column as both', () => {
    expect(factsErrors(facts({ name: 'PAN' }), ctx({ hidden: ['pan'] }))).toEqual({
      'context_display.roles.name': '‘PAN’ is hidden from agents, so it cannot be the customer’s name.',
    });
    expect(factsErrors(facts({ name: 'City', place: 'city' }), ctx())).toEqual({
      'context_display.roles.place': '‘city’ is already the customer’s name. Choose another column.',
    });
  });

  it('reads a value as the card writes it for each type, and the raw text when it cannot be read', () => {
    expect(sampleText('125000', 'money')).toBe('₹1,25,000');
    expect(sampleText('1,25,000.5', 'number')).toBe('1,25,000.5');
    expect(sampleText('haan', 'yes_no')).toBe('Yes');
    expect(sampleText('maybe', 'yes_no')).toBe('maybe');
    expect(sampleText('  ', 'money')).toBe('');
  });

  it('draws every value with the station’s own formatter, so Settings and the station agree (AS19 R12)', () => {
    const station = (raw: string, type: AgencyContextFieldType, phoneDisplay: 'full' | 'masked' = 'full') =>
      factDisplay({ column: 'X', type, raw, value: parseContextFact(raw, type) }, { phoneDisplay }).text;
    const cases: Array<[string, AgencyContextFieldType]> = [
      ['125000.50', 'money'], ['12.00', 'number'], ['1,25,000', 'number'], ['20/11/2026', 'date'], ['20/11/2031', 'date'],
      ['98765 43321', 'phone'], ['+14155550123', 'phone'], ['12345', 'phone'], ['no', 'yes_no'], [' Pune ', 'text'],
    ];
    for (const [raw, type] of cases) {
      expect(sampleText(raw, type), `${type} ${raw}`).toBe(station(raw, type));
      expect(sampleText(raw, type, 'masked'), `${type} ${raw} masked`).toBe(station(raw, type, 'masked'));
    }
    // A hidden number never shows its digits, whatever the phone rule draws.
    expect(sampleText('+919876543321', 'phone', 'masked')).not.toContain('9876543321');
  });
});

describe('the card’s save (AS19)', () => {
  it('writes the facts and the name and line-under-name roles, drops the old amount and due-date roles, keeps the rest', () => {
    const stored = { hero: ['Due'], hidden: ['PAN'], roles: { name: 'Old', amount_due: 'Due', due_date: 'When' }, types: { X: 'date' as const } };
    const card = facts({
      name: 'Borrower',
      list: [fact('Due', 'amount_due', ' Amount due ', { highlight: true }), fact('When', 'due_date', 'Due date', { highlight: false })],
      types: { Due: 'money', When: 'date' },
    });
    expect(contextDisplayPayload(stored, card)).toEqual({
      hero: ['Due'],
      hidden: ['PAN'],
      roles: { name: 'Borrower' },
      types: { Due: 'money', When: 'date' },
      facts: [
        { column: 'Due', label: 'Amount due', key: 'amount_due', highlight: true },
        { column: 'When', label: 'Due date', key: 'due_date' },
      ],
    });
    // Nothing chosen: an empty list, which still puts the campaign on the new model.
    expect(contextDisplayPayload(undefined, facts())).toEqual({ facts: [] });
    // No name or line under it of the form's own: the old roles still go.
    expect(contextDisplayPayload({ roles: { amount_due: 'Due', due_date: 'When' } }, facts())).toEqual({ facts: [] });
  });

  it('migrates an old-model campaign on its first card save: the amount and due date stay money and a date', () => {
    // On the `facts` path the server reads a tile's type from `types` alone (no role override).
    const stored = { hero: ['Loan ID'], roles: { amount_due: 'Amount', due_date: 'Due On' } };
    const loaded = stationSettingsOf(campaign({ context_display: stored }), ['Name', 'Loan ID', 'Amount', 'Due On']);
    const renamed = { ...loaded, facts: { ...loaded.facts, list: loaded.facts.list.map((f, i) => (i === 0 ? { ...f, label: 'Loan' } : f)) } };
    expect(stationPayload(loaded, renamed, stored)).toEqual({
      context_display: {
        hero: ['Loan ID'],
        types: { Amount: 'money', 'Due On': 'date' },
        facts: [
          { column: 'Amount', label: 'Loan', key: 'amount_due' },
          { column: 'Due On', label: 'Due On', key: 'due_date' },
          { column: 'Loan ID', label: 'Loan ID', key: 'loan_id' },
        ],
      },
    });
  });

  it('reads the old role columns as money and a date whatever `types` stored, so the first save changes nothing agents see (AS19 R10)', () => {
    // The role overrode the stored type on today's card: `Amount` showed as money, `due on` as a date.
    const stored = {
      hero: ['Loan ID'],
      roles: { amount_due: 'Amount', due_date: 'due on' },
      types: { amount: 'number' as const, 'Due On': 'text' as const, 'Loan ID': 'number' as const },
    };
    const loaded = stationSettingsOf(campaign({ context_display: stored }), ['Loan ID', 'Amount', 'Due On']);
    // One entry per column, in the stored spelling; a column that plays no role keeps its type.
    expect(loaded.facts.types).toEqual({ amount: 'money', 'Due On': 'date', 'Loan ID': 'number' });
    const sent = stationPayload(loaded, { ...loaded, facts: { ...loaded.facts, name: 'Name' } }, stored).context_display;
    expect(sent?.types).toEqual({ amount: 'money', 'Due On': 'date', 'Loan ID': 'number' });
    // A column that is not the role's is not retyped, even keyed `amount_due` by its header.
    expect(factsFormOf({ hero: ['Amount Due'], types: { 'Amount Due': 'text' } }, ['Amount Due']).types).toEqual({ 'Amount Due': 'text' });
  });

  it('writes a guessed name as the name role, so the name stays a hero once the card has facts (AS19 R1)', () => {
    const stored = { hero: ['Customer Name', 'Amount Due'] };
    const columns = ['Customer Name', 'Amount Due', 'City'];
    const loaded = stationSettingsOf(campaign({ context_display: stored }), columns);
    // The select is on "Guess from the column names (Customer Name)"; the card has the amount.
    expect(loaded.facts.name).toBe('');
    expect(loaded.facts.list.map((f) => f.column)).toEqual(['Amount Due']);
    const renamed = { ...loaded, facts: { ...loaded.facts, list: [{ ...loaded.facts.list[0]!, label: 'Amount' }] } };
    const display = stationPayload(loaded, renamed, stored, columns).context_display!;
    // The line under the name too (S2): with facts the station guesses none, so the guess is written.
    expect(display.roles).toEqual({ name: 'Customer Name', place: 'City' });
    // …and so every surface that reads the heroes keeps it: the own-contacts list, customer history.
    expect(configuredHeroNames(display)).toEqual(['Customer Name', 'Amount Due']);
    // A name chosen in the select is written as chosen; no guess, nothing written.
    expect(contextDisplayPayload(stored, { ...renamed.facts, name: 'City' }, columns).roles).toEqual({ name: 'City' });
    expect(contextDisplayPayload(stored, renamed.facts, ['Amount Due']).roles).toBeUndefined();
    // Never a hidden column, nor one that is already a fact or the line under it (the server would refuse it).
    expect(contextDisplayPayload({ ...stored, hidden: ['customer name'] }, renamed.facts, columns).roles).toEqual({ place: 'City' });
    expect(contextDisplayPayload(stored, { ...renamed.facts, list: [fact('Customer Name', 'cn')] }, columns).roles).toEqual({ place: 'City' });
    // A chosen column is written in the roster's spelling (S9).
    expect(contextDisplayPayload(stored, { ...renamed.facts, place: 'customer name' }, columns).roles).toEqual({ place: 'Customer Name' });
  });

  it('writes the guessed line under the name as its role, and “None” as none (S2)', () => {
    const columns = ['Name', 'City', 'Loan ID'];
    const card = facts({ list: [fact('Loan ID', 'loan_id')] });
    expect(contextDisplayPayload({}, card, columns).roles).toEqual({ name: 'Name', place: 'City' });
    expect(contextDisplayPayload({}, { ...card, place: null }, columns).roles).toEqual({ name: 'Name' });
    // Never a fact's column, and not without the columns to guess from.
    expect(contextDisplayPayload({}, { ...card, list: [fact('City', 'city')] }, columns).roles).toEqual({ name: 'Name' });
    expect(contextDisplayPayload({}, card).roles).toBeUndefined();
    // From the guess to "None" is a change of the card, though neither names a column.
    expect(factsChanged(card, { ...card, place: null })).toBe(true);
    expect(factsChanged(card, { ...card })).toBe(false);
  });

  it('opens a card with facts and no line under the name as none, an old one as the guess (S2)', () => {
    expect(factsFormOf({ facts: [] }, ['Name', 'City']).place).toBeNull();
    expect(factsFormOf({ facts: [], roles: { place: 'Town' } }, ['Name', 'City']).place).toBe('Town');
    expect(factsFormOf({}, ['Name', 'City']).place).toBe('');
  });

  it('writes each fact’s column in the roster’s spelling (S9), so the own-contacts list matches it', () => {
    const card = facts({ list: [fact('loan id', 'loan_id'), fact('Gone', 'gone')] });
    expect(contextDisplayPayload({}, card, ['Loan ID']).facts).toEqual([
      { column: 'Loan ID', label: 'loan id', key: 'loan_id' },
      { column: 'Gone', label: 'Gone', key: 'gone' },
    ]);
  });

  it('reads Text as no entry: absent is text', () => {
    const money = withColumnType(facts(), 'Due', 'money');
    expect(money.types).toEqual({ Due: 'money' });
    expect(withColumnType(money, 'Due', 'text').types).toEqual({});
  });

  it('offers the imported columns, then the ones the settings name that they leave out, each once', () => {
    expect(campaignColumns(
      ['Name', 'Due'],
      { hero: ['due', 'Branch'], order: ['Notes'], facts: [fact('Stored', 'stored')] },
      facts({ place: 'Town', list: [fact('Gone', 'gone')], types: { When: 'date' } }),
    )).toEqual(['Name', 'Due', 'Branch', 'Notes', 'Stored', 'Town', 'Gone', 'When']);
  });

  it('keeps one key per column whatever its case, with the stored spelling', () => {
    const stored = facts({ types: { amount: 'money', Other: 'date' } });
    expect(withColumnType(stored, 'Amount', 'date').types).toEqual({ amount: 'date', Other: 'date' });
    expect(withColumnType(stored, 'AMOUNT', 'text').types).toEqual({ Other: 'date' });
    expect(columnType(stored, 'Amount')).toBe('money');
    expect(columnType(stored, 'Nothing')).toBe('text');
    expect(sameColumn(' Due Amount ', 'due amount')).toBe(true);
    expect(columnNamed(['Name', 'Due Amount'], 'DUE AMOUNT')).toBe('Due Amount');
  });
});

describe('what a save sends, and what holds it', () => {
  const card = facts({ list: [fact('Loan ID', 'loan_id'), fact('Due', 'due_date')] });
  const storedNew = { facts: card.list };
  const saved = form({ dailyTarget: '40', script: { opening: 'Hi {name}', steps: ['On {due_date}'] }, facts: card });

  it('counts each setting once, and a change only of spaces as none', () => {
    expect(stationChanges(saved, saved)).toEqual([]);
    expect(stationChanges(saved, { ...saved, dailyTarget: ' 40 ', script: { opening: 'Hi {name} ', steps: ['On {due_date}'] } })).toEqual([]);
    expect(stationChanges(saved, form({
      dailyTarget: '',
      phoneDisplay: 'masked',
      script: { opening: 'Hi', steps: ['a'] },
      facts: { ...card, types: { Due: 'date' } },
    }))).toEqual(['dailyTarget', 'phoneDisplay', 'script', 'customerFacts']);
  });

  it('sends only what changed: null clears the target', () => {
    expect(stationPayload(saved, saved, storedNew)).toEqual({});
    expect(stationPayload(saved, { ...saved, dailyTarget: '' }, storedNew)).toEqual({ daily_target_calls: null });
    expect(stationPayload(saved, { ...saved, phoneDisplay: 'masked' }, storedNew)).toEqual({ phone_display: 'masked' });
    expect(stationPayload(saved, { ...saved, script: { opening: '', steps: [] } }, storedNew)).toEqual({ agent_script: {} });
  });

  it('sends the card with a script that names a key only the form’s card has (an old-model campaign)', () => {
    const storedOld = { hero: ['Loan ID'] };
    const old = form({ facts: facts({ list: [fact('Loan ID', 'loan_id')] }) });
    // A legacy key: the stored model allows it, so the card is not written.
    expect(stationPayload(old, { ...old, script: { opening: 'Hi {name}', steps: [] } }, storedOld)).toEqual({ agent_script: { opening: 'Hi {name}' } });
    // A fact's key: the card goes with it, so the server checks the pair.
    expect(stationPayload(old, { ...old, script: { opening: 'Loan {loan_id}', steps: [] } }, storedOld)).toEqual({
      agent_script: { opening: 'Loan {loan_id}' },
      context_display: { hero: ['Loan ID'], facts: [{ column: 'Loan ID', label: 'Loan ID', key: 'loan_id' }] },
    });
    // Until then, a legacy key the form's card does not have is still allowed.
    expect(stationPlan(old, old, storedOld).allowed).toContain('amount_due');
    expect(stationPlan(old, { ...old, script: { opening: '{loan_id}', steps: [] } }, storedOld).allowed).not.toContain('amount_due');
  });

  it('holds Save on a script key the card does not have', () => {
    const now = { ...saved, script: { opening: 'Hi {branch}', steps: ['On {due_date}'] } };
    expect(stationErrors(saved, now, storedNew, ctx())).toEqual({
      'agent_script.opening': 'The script uses {branch}, which is not a fact on the card. Add it as a fact or take it out.',
    });
  });

  it('holds Save on removing a fact the stored script uses, said on the facts, as the server says it', () => {
    const now = { ...saved, facts: { ...card, list: [card.list[0]!] } };
    expect(stationErrors(saved, now, storedNew, ctx())).toEqual({
      'context_display.facts': 'The script uses {due_date}. Take it out of the script first, or keep the fact.',
    });
    // Taken out of the script as well: both go in one save, and nothing holds it.
    const both = { ...now, script: { opening: 'Hi {name}', steps: ['Soon'] } };
    expect(stationErrors(saved, both, storedNew, ctx())).toEqual({});
    expect(stationPayload(saved, both, storedNew)).toMatchObject({
      agent_script: { opening: 'Hi {name}', steps: [{ text: 'Soon' }] },
      context_display: { facts: [{ column: 'Loan ID', label: 'Loan ID', key: 'loan_id' }] },
    });
  });

  it('says a stored script key the saved card never had in the server’s words too', () => {
    // An old-model campaign's script used {amount_due}, which its card (no amount role) does not make.
    const old = form({ script: { opening: 'Pay {amount_due}', steps: [] }, facts: facts({ list: [fact('Loan ID', 'loan_id')] }) });
    const changed = { ...old, facts: { ...old.facts, types: { 'Loan ID': 'number' as const } } };
    expect(stationErrors(old, changed, { hero: ['Loan ID'] }, ctx())).toEqual({
      'context_display.facts': 'The script uses {amount_due}. Take it out of the script first, or keep the fact.',
    });
  });

  it('offers a removed fact the script uses back, where it was, or says why it cannot go back (S9)', () => {
    const now = { ...card, list: [card.list[0]!] };
    expect(removedFactsInUse(card, now, saved.script)).toEqual([{ fact: card.list[1], blocked: null }]);
    expect(removedFactsInUse(card, now, { opening: '', steps: [] })).toEqual([]);
    expect(putBack(card, now, 'due_date')).toEqual(card.list);
    // Not when the card is full, or when its column is on the card again; each said.
    const full = { ...now, list: ['A', 'B', 'C', 'D'].map((c) => fact(c, c.toLowerCase())) };
    expect(putBack(card, full, 'due_date')).toBeNull();
    expect(removedFactsInUse(card, full, saved.script)).toEqual([{ fact: card.list[1], blocked: 'The card is full (4 of 4). Remove a fact first.' }]);
    const again = { ...now, list: [...now.list, fact('Due', 'due')] };
    expect(putBack(card, again, 'due_date')).toBeNull();
    expect(removedFactsInUse(card, again, saved.script)[0]!.blocked).toBe('‘Due’ is on the card again.');
  });

  it('holds Save exactly as the server refuses a card that takes a key from the stored script (S9)', () => {
    // Several keys: one message, the server's plural.
    const both = { ...saved, script: { opening: 'Hi {loan_id}', steps: ['On {due_date}'] } };
    expect(stationErrors(both, { ...both, facts: facts() }, storedNew, ctx())).toEqual({
      'context_display.facts': 'The script uses {loan_id} and {due_date}. Take them out of the script first, or keep the facts.',
    });
    // A key the stored card never allowed is not the card's to lose: the server says nothing of it.
    const odd = { ...saved, script: { opening: 'Hi {branch}', steps: ['On {due_date}'] } };
    const changed = { ...odd, facts: { ...card, types: { Due: 'date' as const } } };
    expect(stationErrors(odd, changed, storedNew, ctx())).toEqual({});
  });

  it('holds a save that would send an old-model card before the columns it is opened from are read (S9)', () => {
    const storedOld = { hero: ['Loan ID'] };
    const old = form({ facts: facts({ list: [fact('Loan ID', 'loan_id')] }) });
    const keyed = { ...old, script: { opening: 'Loan {loan_id}', steps: [] } };
    expect(stationErrors(old, keyed, storedOld, { ...ctx(), cardWaiting: COLUMNS_LOADING_MESSAGE })).toEqual({
      'context_display.facts': 'Loading the customer list’s columns…',
    });
    expect(COLUMNS_FAILED_MESSAGE).toBe('Could not read the customer list’s columns. Try again.');
    // A save that does not send the card is not held by it.
    expect(stationErrors(old, { ...old, dailyTarget: '20' }, storedOld, { ...ctx(), cardWaiting: COLUMNS_FAILED_MESSAGE })).toEqual({});
  });

  it('clears the server’s answer keyed by a fact’s place once the facts move (S9)', () => {
    const list = [fact('A', 'a'), fact('B', 'b')];
    expect(factsReordered(list, [...list])).toBe(false);
    expect(factsReordered(list, [list[1]!, list[0]!])).toBe(true);
    expect(factsReordered(list, [list[0]!])).toBe(true);
    expect(withoutPlacedFactErrors({
      'context_display.facts.0.label': 'x',
      'context_display.facts.12.column': 'y',
      'context_display.facts': 'z',
      'context_display.roles.name': 'w',
    })).toEqual({ 'context_display.facts': 'z', 'context_display.roles.name': 'w' });
  });

  it('holds the save only for a setting that is sent', () => {
    const stored = form({ facts: facts({ name: 'PAN' }) });
    // A name on a column hidden since: not judged while the card is untouched.
    expect(stationErrors(stored, { ...stored, dailyTarget: '30' }, {}, ctx({ hidden: ['PAN'] }))).toEqual({});
    expect(stationErrors(stored, { ...stored, dailyTarget: '0' }, {}, ctx({ hidden: ['PAN'] }))).toHaveProperty('daily_target_calls');
    expect(Object.keys(stationErrors(stored, { ...stored, facts: { ...stored.facts, types: { A: 'date' } } }, {}, ctx({ hidden: ['PAN'] }))))
      .toEqual(['context_display.roles.name']);
    expect(Object.keys(stationErrors(stored, { ...stored, script: { opening: '', steps: [''] } }, {}, ctx())))
      .toEqual(['agent_script.steps[0].text']);
  });
});

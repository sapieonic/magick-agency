import { describe, it, expect } from 'vitest';
import type { AgencyFactField } from '@magick-agency/contracts/agency';
import {
  FACTS_LIMIT_MESSAGE,
  FACT_COLUMN_MISSING_MESSAGE,
  campaignColumns,
  canMoveFact,
  columnNamed,
  columnType,
  contextDisplayPayload,
  dailyTargetError,
  dailyTargetPayload,
  factsErrors,
  factsFormOf,
  guessedColumn,
  insertAt,
  moveFact,
  newFact,
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
  withColumnType,
  withHighlight,
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
const facts = (over: Partial<FactsForm> = {}): FactsForm => ({ name: '', place: '', list: [], types: {}, ...over });
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
      facts: { name: 'Borrower', place: 'City', list, types: { Due: 'money', Ph: 'phone', Ok: 'yes_no', N: 'number' } },
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

  it('opens with what agents see today: the heroes (minus the name and place), then the amount and due date', () => {
    const display = {
      hero: ['Name', 'Loan ID', 'Branch'],
      hidden: ['PAN'],
      roles: { amount_due: 'Amount', due_date: 'due on' },
    };
    expect(factsFormOf(display, roster)).toEqual({
      name: '',
      place: '',
      list: [
        fact('Loan ID', 'loan_id'),
        fact('Branch', 'branch'),
        fact('Amount', 'amount_due'),
        fact('Due On', 'due_date'),
      ],
      // Read as money and a date, as their roles read them before: the new model reads by type alone.
      types: { Amount: 'money', 'Due On': 'date' },
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
      fact('Outstanding principal amount', 'outstanding_principal_amount', 'Outstanding prin'),
      fact('Branch', 'branch'),
      fact('Loan ID', 'loan_id'),
      fact('Amount', 'amount_due'),
    ]);
    // A type already set is kept.
    expect(card.types).toEqual({ Amount: 'number' });
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

describe('guessing the name and the line under it, as the server does', () => {
  it('takes the server’s guesses in its order, ignoring case, spaces and underscores, never a hidden column', () => {
    expect(guessedColumn(['First Name', 'Full_Name'], ['name', 'full_name', 'customer_name', 'first_name'], [])).toBe('Full_Name');
    expect(guessedColumn(['NAME', 'City'], ['name'], ['name'])).toBeUndefined();
    expect(guessedColumn(['Loan'], ['name'], [])).toBeUndefined();
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
  it('makes a new fact’s name and key from the header, the key unlike the others’', () => {
    expect(newFact('Loan ID', [])).toEqual(fact('Loan ID', 'loan_id'));
    expect(newFact('Loan-ID', [fact('Loan ID', 'loan_id')])).toEqual(fact('Loan-ID', 'loan_id_2'));
    expect(newFact('Outstanding principal amount', []).label).toBe('Outstanding prin');
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
    expect(sampleText('20/11/2026', 'date')).toBe('20 Nov');
    expect(sampleText('1,25,000.5', 'number')).toBe('1,25,000.5');
    expect(sampleText('98765 43321', 'phone')).toBe('9876543321');
    expect(sampleText('+919876543321', 'phone', 'masked')).toBe('98••• ••321');
    expect(sampleText('haan', 'yes_no')).toBe('Yes');
    expect(sampleText('maybe', 'yes_no')).toBe('maybe');
    expect(sampleText('  ', 'money')).toBe('');
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
          { column: 'Loan ID', label: 'Loan', key: 'loan_id' },
          { column: 'Amount', label: 'Amount', key: 'amount_due' },
          { column: 'Due On', label: 'Due On', key: 'due_date' },
        ],
      },
    });
    // A type already set is the supervisor's, and is kept.
    const typed = { ...stored, types: { Amount: 'number' as const } };
    expect(stationSettingsOf(campaign({ context_display: typed }), ['Loan ID', 'Amount', 'Due On']).facts.types).toEqual({ Amount: 'number', 'Due On': 'date' });
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

  it('offers a removed fact the script uses back, where it was', () => {
    const now = { ...card, list: [card.list[0]!] };
    expect(removedFactsInUse(card, now, saved.script)).toEqual([card.list[1]]);
    expect(removedFactsInUse(card, now, { opening: '', steps: [] })).toEqual([]);
    expect(putBack(card, now, 'due_date')).toEqual(card.list);
    // Not when the card is full, or when its column is on the card again.
    const full = { ...now, list: ['A', 'B', 'C', 'D'].map((c) => fact(c, c.toLowerCase())) };
    expect(putBack(card, full, 'due_date')).toBeNull();
    expect(putBack(card, { ...now, list: [...now.list, fact('Due', 'due')] }, 'due_date')).toBeNull();
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

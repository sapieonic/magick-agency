import { describe, it, expect } from 'vitest';
import {
  campaignColumns,
  contextDisplayPayload,
  dailyTargetError,
  dailyTargetPayload,
  factsErrors,
  insertAt,
  phoneAsShown,
  scriptErrors,
  scriptPayload,
  stationChanges,
  stationErrors,
  stationPayload,
  stationSettingsOf,
  unknownPlaceholders,
  withColumnType,
  columnNamed,
  columnType,
  sameColumn,
  type FactsForm,
  type StationSettingsForm,
} from '../../utils/agency/stationSettings';
import type { AgencyCampaign } from '../../types/agency-campaign';

/**
 * The agent station's campaign settings as campaign Settings edits them (AS6, AS9, BE-6, BE-8):
 * read from the campaign, each rule the server's write applies, and what a save sends (only what
 * changed, the facts merged into the stored display).
 */

const campaign = (over: Partial<AgencyCampaign> = {}): AgencyCampaign => ({ id: 'c-1', name: 'C', status: 'draft', ...over });
const noRoles = { name: '', place: '', amount_due: '', due_date: '' };
const facts = (over: Partial<FactsForm> = {}): FactsForm => ({ roles: { ...noRoles }, types: {}, ...over });

function form(over: Partial<StationSettingsForm> = {}): StationSettingsForm {
  return { dailyTarget: '', phoneDisplay: 'full', script: { opening: '', steps: [] }, facts: facts(), ...over };
}

describe('stationSettingsOf', () => {
  it('reads an untouched campaign as no target, the full number, no script and no facts', () => {
    expect(stationSettingsOf(campaign())).toEqual(form());
  });

  it('reads what is stored', () => {
    expect(stationSettingsOf(campaign({
      daily_target_calls: 40,
      phone_display: 'masked',
      agent_script: { opening: 'Hello {name}', steps: [{ text: 'Ask' }, { text: 'Close' }] },
      context_display: { hero: ['Due'], roles: { name: 'Borrower', amount_due: 'Due' }, types: { Due: 'money', When: 'date' } },
    }))).toEqual(form({
      dailyTarget: '40',
      phoneDisplay: 'masked',
      script: { opening: 'Hello {name}', steps: ['Ask', 'Close'] },
      facts: { roles: { ...noRoles, name: 'Borrower', amount_due: 'Due' }, types: { Due: 'money', When: 'date' } },
    }));
  });

  it('reads anything malformed as unset, never failing the page', () => {
    expect(stationSettingsOf(campaign({
      daily_target_calls: null,
      phone_display: 'odd' as never,
      agent_script: 'x' as never,
      context_display: { roles: { name: 7, place: 'Town' } as never, types: { A: 'number' } as never },
    }))).toEqual(form({ facts: facts({ roles: { ...noRoles, place: 'Town' } }) }));
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

describe('the number display (AS9)', () => {
  it('masks to the first two and last three of the ten digits', () => {
    expect(phoneAsShown('+919876543321', 'masked')).toBe('98••• ••321');
    expect(phoneAsShown('9876543321', 'masked')).toBe('98••• ••321');
    expect(phoneAsShown('+919876543321', 'full')).toBe('98765 43321');
    expect(phoneAsShown('+1234', 'masked')).toBe('+1234');
  });
});

describe('the script (BE-8)', () => {
  it('finds the words in braces the station cannot fill, as the server does', () => {
    expect(unknownPlaceholders('Hi {name}, {Name} and { name } owe {amount_due} {x}{x} {not a word}')).toEqual(['{Name}', '{ name }', '{x}']);
  });

  it('says each problem on its field, keyed as the server keys it', () => {
    const errors = scriptErrors({
      opening: 'x'.repeat(301),
      steps: ['Fine {name}', '   ', 'y'.repeat(201), 'Hello {customer}'],
    });
    expect(Object.keys(errors).sort()).toEqual([
      'agent_script.opening',
      'agent_script.steps[1].text',
      'agent_script.steps[2].text',
      'agent_script.steps[3].text',
    ]);
    expect(errors['agent_script.opening']).toBe('The opening line is 301 characters. Keep it to 300.');
    expect(errors['agent_script.steps[1].text']).toBe('Write step 2, or remove it.');
    expect(errors['agent_script.steps[3].text']).toMatch(/^\{customer\} is not a word the script can fill in\./);
  });

  it('counts characters as the server does: code points, after trimming', () => {
    expect(scriptErrors({ opening: ` ${'₹'.repeat(300)} `, steps: [] })).toEqual({});
    expect(scriptErrors({ opening: '😀'.repeat(300), steps: [] })).toEqual({});
  });

  it('refuses a thirteenth step', () => {
    expect(scriptErrors({ opening: '', steps: Array.from({ length: 13 }, () => 'a') })['agent_script.steps'])
      .toBe('A script can have at most 12 steps.');
  });

  it('sends each text trimmed, an empty part left out, and {} for no script', () => {
    expect(scriptPayload({ opening: '  Hi  ', steps: [' a ', 'b'] })).toEqual({ opening: 'Hi', steps: [{ text: 'a' }, { text: 'b' }] });
    expect(scriptPayload({ opening: ' ', steps: [] })).toEqual({});
  });

  it('puts a placeholder at the caret, spaced from the words either side', () => {
    expect(insertAt('Hello', 5, 5, '{name}')).toEqual({ text: 'Hello {name}', caret: 12 });
    expect(insertAt('Hello there', 6, 6, '{name}')).toEqual({ text: 'Hello {name} there', caret: 12 });
    expect(insertAt('', 0, 0, '{name}')).toEqual({ text: '{name}', caret: 6 });
    expect(insertAt('Hi you', 3, 6, '{name}')).toEqual({ text: 'Hi {name}', caret: 9 });
  });
});

describe('the customer facts (BE-6)', () => {
  it('refuses one column in two roles, on the second, ignoring case', () => {
    expect(factsErrors(facts({ roles: { ...noRoles, name: 'Due', amount_due: 'due' } }), [])).toEqual({
      'context_display.roles.amount_due': '‘due’ is already the customer name. One column can play one role only.',
    });
  });

  it('refuses a hidden column as a role', () => {
    expect(factsErrors(facts({ roles: { ...noRoles, place: 'Branch' } }), ['branch'])).toEqual({
      'context_display.roles.place': '‘Branch’ is hidden from agents, so it cannot be the place.',
    });
  });

  it('merges the roles and types into the stored display, keeping its other keys', () => {
    const stored = { hero: ['Due'], hidden: ['PAN'], roles: { name: 'Old' }, types: { X: 'date' as const } };
    expect(contextDisplayPayload(stored, facts({ roles: { ...noRoles, amount_due: 'Due' }, types: { Due: 'money' } }))).toEqual({
      hero: ['Due'], hidden: ['PAN'], roles: { amount_due: 'Due' }, types: { Due: 'money' },
    });
    // Nothing chosen: both keys go, the rest stays.
    expect(contextDisplayPayload(stored, facts())).toEqual({ hero: ['Due'], hidden: ['PAN'] });
    expect(contextDisplayPayload(undefined, facts())).toEqual({});
  });

  it('reads Text as no entry: absent is text', () => {
    const money = withColumnType(facts(), 'Due', 'money');
    expect(money.types).toEqual({ Due: 'money' });
    expect(withColumnType(money, 'Due', 'text').types).toEqual({});
  });

  it('offers the imported columns, then the ones the settings name that they leave out, each once', () => {
    expect(campaignColumns(
      ['Name', 'Due'],
      { hero: ['due', 'Branch'], order: ['Notes'] },
      facts({ roles: { ...noRoles, place: 'Town' }, types: { When: 'date' } }),
    )).toEqual(['Name', 'Due', 'Branch', 'Notes', 'Town', 'When']);
  });

  it('offers the stored roles and types too, even once the form has moved off them (the server still takes them)', () => {
    // `Region` and `Paid On` came from an import older than the ones read; the form no longer names them.
    expect(campaignColumns(
      ['Name'],
      { roles: { place: 'Region' }, types: { 'Paid On': 'date', name: 'text' } },
      facts(),
    )).toEqual(['Name', 'Region', 'Paid On']);
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
  const saved = form({ dailyTarget: '40', script: { opening: 'Hi', steps: [] } });

  it('counts each setting once, and a change only of spaces as none', () => {
    expect(stationChanges(saved, saved)).toEqual([]);
    expect(stationChanges(saved, form({ dailyTarget: ' 40 ', script: { opening: 'Hi ', steps: [] } }))).toEqual([]);
    expect(stationChanges(saved, form({
      dailyTarget: '',
      phoneDisplay: 'masked',
      script: { opening: 'Hi', steps: ['a'] },
      facts: facts({ types: { Due: 'money' } }),
    }))).toEqual(['dailyTarget', 'phoneDisplay', 'script', 'customerFacts']);
  });

  it('sends only what changed: null clears the target', () => {
    expect(stationPayload(saved, saved, {})).toEqual({});
    expect(stationPayload(saved, { ...saved, dailyTarget: '' }, {})).toEqual({ daily_target_calls: null });
    expect(stationPayload(saved, { ...saved, phoneDisplay: 'masked' }, {})).toEqual({ phone_display: 'masked' });
    expect(stationPayload(saved, { ...saved, script: { opening: '', steps: [] } }, {})).toEqual({ agent_script: {} });
    expect(stationPayload(saved, { ...saved, facts: facts({ roles: { ...noRoles, name: 'N' } }) }, { hero: ['N'] }))
      .toEqual({ context_display: { hero: ['N'], roles: { name: 'N' } } });
  });

  it('holds the save only for a setting that changed', () => {
    const stored = form({ facts: facts({ roles: { ...noRoles, name: 'PAN' } }) });
    // A role on a column hidden since: not judged while the facts are untouched.
    expect(stationErrors(stored, { ...stored, dailyTarget: '30' }, ['PAN'])).toEqual({});
    expect(stationErrors(stored, { ...stored, dailyTarget: '0' }, ['PAN'])).toHaveProperty('daily_target_calls');
    expect(Object.keys(stationErrors(stored, { ...stored, facts: { ...stored.facts, types: { A: 'date' } } }, ['PAN'])))
      .toEqual(['context_display.roles.name']);
    expect(Object.keys(stationErrors(stored, { ...stored, script: { opening: '', steps: [''] } }, [])))
      .toEqual(['agent_script.steps[0].text']);
  });
});

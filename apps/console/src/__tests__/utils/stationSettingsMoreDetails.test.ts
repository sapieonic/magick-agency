import { describe, it, expect } from 'vitest';
import type { AgencyCampaign } from '../../types/agency-campaign';
import type { AgencyContextDisplay } from '@magick-agency/contracts/agency';
import {
  COLUMNS_LOADING_MESSAGE,
  FACT_COLUMN_MISSING_MESSAGE,
  contextDisplayPayload,
  factsChanged,
  factsFormOf,
  isLegacyDisplay,
  moreDetailsDisplayPayload,
  moreShown,
  moreTypeOf,
  stationErrors,
  stationPayload,
  stationPlan,
  stationSettingsOf,
  withColumnType,
  withMoreAll,
  withMoreShown,
  withMoreType,
  type FactsForm,
} from '../../utils/agency/stationSettings';

/**
 * AS20, campaign Settings › What agents see › More details: the form reads and writes
 * `context_display.more_hidden`, a save writes the stored order followed by the latest upload's
 * other columns, a change to it alone merges only More details into the stored display (the card's
 * model untouched), and the type More details reads a column as (a phone when any sample value
 * looks like one, unless a type is chosen; Text chosen is kept).
 */

const facts = (over: Partial<FactsForm> = {}): FactsForm => ({ name: '', place: '', list: [], types: {}, moreHidden: [], ...over });

describe('More details in the Settings form (AS20)', () => {
  it('reads more_hidden as stored, skipping what is not a column name', () => {
    expect(factsFormOf({ facts: [], more_hidden: ['Branch', '', 7 as never, 'PAN'] }, ['Branch', 'PAN']).moreHidden).toEqual(['Branch', 'PAN']);
    expect(factsFormOf({ facts: [], more_hidden: 'Branch' as never }, null).moreHidden).toEqual([]);
    expect(factsFormOf(undefined, null).moreHidden).toEqual([]);
  });

  it('shows a column unless it is ticked off, ignoring case; all on and all off', () => {
    let form = withMoreShown(facts(), 'Branch', false);
    expect(moreShown(form, 'branch')).toBe(false);
    expect(moreShown(form, 'Loan No')).toBe(true);
    form = withMoreShown(form, 'BRANCH', true);
    expect(form.moreHidden).toEqual([]);
    form = withMoreAll(facts({ moreHidden: ['Other'] }), ['A', 'B'], false);
    expect(form.moreHidden).toEqual(['Other', 'A', 'B']);
    expect(withMoreAll(form, ['a', 'b'], true).moreHidden).toEqual(['Other']);
  });

  it('a save writes more_hidden once per column in the roster\'s spelling, and none when nothing is ticked off', () => {
    const stored = { hidden: ['PAN'], more_hidden: ['Old'], order: ['B', 'A'] };
    const payload = contextDisplayPayload(stored, facts({ moreHidden: ['branch', 'BRANCH', 'Loan No'] }), ['Branch', 'Loan No']);
    expect(payload).toEqual({ hidden: ['PAN'], order: ['B', 'A'], facts: [], more_hidden: ['Branch', 'Loan No'] });
    // Every column shown again: the stored list goes.
    expect(contextDisplayPayload(stored, facts())).toEqual({ hidden: ['PAN'], order: ['B', 'A'], facts: [] });
  });

  it('a save writes the stored order, then the latest upload\'s columns it does not name, in the file\'s order', () => {
    expect(contextDisplayPayload({}, facts(), null, ['Name', 'Loan No', 'Branch']).order).toEqual(['Name', 'Loan No', 'Branch']);
    expect(contextDisplayPayload({ order: ['Branch'] }, facts(), null, ['Name', 'BRANCH', 'EMI']).order).toEqual(['Branch', 'Name', 'EMI']);
    expect(contextDisplayPayload({ order: [] }, facts(), null, ['Name']).order).toEqual(['Name']);
    expect(contextDisplayPayload({ order: ['B'] }, facts(), null, []).order).toEqual(['B']);
    expect(contextDisplayPayload({}, facts(), null, []).order).toBeUndefined();
    expect(contextDisplayPayload({}, facts()).order).toBeUndefined();
  });

  it('ticking a column off alone merges only More details into the stored display', () => {
    const campaign = { id: 'c-1', name: 'C', status: 'draft', context_display: { facts: [] } } as AgencyCampaign;
    const saved = stationSettingsOf(campaign, ['Name', 'Branch']);
    const now = { ...saved, facts: withMoreShown(saved.facts, 'Branch', false) };
    expect(factsChanged(saved.facts, now.facts)).toBe(true);
    expect(factsChanged(saved.facts, { ...saved.facts, moreHidden: [] })).toBe(false);
    expect(factsChanged(facts({ moreHidden: ['A', 'b'] }), facts({ moreHidden: ['B', 'a', 'A'] }))).toBe(false);
    expect(stationPayload(saved, now, campaign.context_display, ['Name', 'Branch'], ['Name', 'Branch'])).toEqual({
      context_display: { facts: [], order: ['Name', 'Branch'], more_hidden: ['Branch'] },
    });
    // With a change to the card as well (the name chosen), the whole card is written, types and all.
    const both = { ...now, facts: { ...now.facts, name: 'Name', types: { Branch: 'number' as const } } };
    expect(stationPayload(saved, both, campaign.context_display, ['Name', 'Branch'], ['Name', 'Branch']).context_display).toEqual({
      order: ['Name', 'Branch'], roles: { name: 'Name' }, types: { Branch: 'number' }, facts: [], more_hidden: ['Branch'],
    });
  });

  it('on a card that has not chosen its facts, ticking a column off leaves it on the old card (no facts written)', () => {
    const stored = { hero: ['Loan No'], roles: { amount_due: 'Due' }, more_hidden: ['Old'] };
    const campaign = { id: 'c-1', name: 'C', status: 'draft', context_display: stored } as AgencyCampaign;
    const saved = stationSettingsOf(campaign, ['Name', 'Loan No', 'Due', 'Branch']);
    const now = { ...saved, facts: withMoreShown(saved.facts, 'Branch', false) };
    const sent = stationPayload(saved, now, stored, ['Name', 'Loan No', 'Due', 'Branch'], ['Name', 'Loan No', 'Due', 'Branch']).context_display;
    expect(sent).toEqual({ hero: ['Loan No'], roles: { amount_due: 'Due' }, order: ['Name', 'Loan No', 'Due', 'Branch'], more_hidden: ['Old', 'Branch'] });
    expect(moreDetailsDisplayPayload(stored, facts())).toEqual({ hero: ['Loan No'], roles: { amount_due: 'Due' } });
  });

  it('reads a column as a phone when any sample looks like one; a type chosen there is written, Text included', () => {
    const form = facts({ types: { Tenure: 'number' } });
    expect(moreTypeOf(form, 'Alt mobile', ['98765 43210'])).toBe('phone');
    expect(moreTypeOf(form, 'Ref No', ['LN-1', 'LN-2', '9876543210'])).toBe('phone');
    expect(moreTypeOf(form, 'Loan No', ['LN-1'])).toBe('text');
    expect(moreTypeOf(form, 'Loan No', [])).toBe('text');
    expect(moreTypeOf(form, 'Tenure', ['9876543210'])).toBe('number');
    const text = withMoreType(form, 'Alt mobile', 'text');
    expect(text.types).toEqual({ Tenure: 'number', 'Alt mobile': 'text' });
    expect(moreTypeOf(text, 'alt mobile', ['98765 43210'])).toBe('text');
    // Text is pinned whatever the first sample looks like: other customers' values may read as phones.
    expect(withMoreType(form, 'Ref No', 'text').types).toEqual({ Tenure: 'number', 'Ref No': 'text' });
    expect(withMoreType(text, 'ALT MOBILE', 'phone').types).toEqual({ Tenure: 'number', 'Alt mobile': 'phone' });
  });

  describe('a save of More details alone judges only what it sends', () => {
    // An old-model card: the form's card makes {amount_due} only, while the stored model allows every
    // legacy key, so a script using {due_date} is fine until the card itself is written.
    const columns = ['Name', 'Loan No', 'Due', 'Branch', 'Alt mobile', 'Tenure'];
    const stored: AgencyContextDisplay = { hero: ['Loan No'], roles: { amount_due: 'Due' }, types: { TENURE: 'number', 'Loan No': 'text' } };
    const legacy = { id: 'c-1', name: 'C', status: 'draft', context_display: stored } as AgencyCampaign;
    const loaded = () => {
      const form = stationSettingsOf(legacy, columns);
      return { ...form, script: { opening: 'Pay by {due_date}', steps: [] } };
    };
    const context = (over = {}) => ({ hidden: [], uploaded: columns, columns, ...over });

    it('is not held by a card finding when only ticks change', () => {
      const saved = loaded();
      const ticked = { ...saved, facts: withMoreShown(saved.facts, 'Branch', false) };
      expect(stationPlan(saved, ticked, stored, columns)).toMatchObject({ displaySent: true, cardSent: false });
      expect(stationErrors(saved, ticked, stored, context())).toEqual({});
      // Nor by the wait for the columns an old card is opened from: the card is not sent.
      expect(stationErrors(saved, ticked, stored, context({ cardWaiting: COLUMNS_LOADING_MESSAGE }))).toEqual({});
    });

    it('still holds a change to the card on what the card would lose, and on the wait for the columns', () => {
      const saved = loaded();
      const relabelled = { ...saved, facts: { ...saved.facts, list: saved.facts.list.map((f) => ({ ...f, label: `${f.label}!` })) } };
      expect(stationErrors(saved, relabelled, stored, context())).toEqual({
        'context_display.facts': 'The script uses {due_date}. Take it out of the script first, or keep the fact.',
      });
      expect(stationErrors(saved, relabelled, stored, context({ cardWaiting: COLUMNS_LOADING_MESSAGE }))).toEqual({
        'context_display.facts': COLUMNS_LOADING_MESSAGE,
      });
    });

    it('is not held by a fact whose column the latest upload dropped; a change to the card is', () => {
      const display = { facts: [{ column: 'Old col', label: 'Old', key: 'old' }] };
      const campaign = { id: 'c-1', name: 'C', status: 'draft', context_display: display } as AgencyCampaign;
      const saved = stationSettingsOf(campaign, ['Name', 'Branch', 'Old col']);
      const ctx = { hidden: [], uploaded: ['Name', 'Branch'], columns: ['Name', 'Branch', 'Old col'] };
      const ticked = { ...saved, facts: withMoreShown(saved.facts, 'Branch', false) };
      expect(stationErrors(saved, ticked, display, ctx)).toEqual({});
      const renamed = { ...ticked, facts: { ...ticked.facts, list: [{ ...ticked.facts.list[0]!, label: 'Older' }] } };
      expect(stationErrors(saved, renamed, display, ctx)).toEqual({ 'context_display.facts.0.column': FACT_COLUMN_MISSING_MESSAGE });
    });

    it('merges a More details column\'s type into the stored types, keeping the campaign on the old card', () => {
      const saved = loaded();
      let facts = withMoreType(saved.facts, 'alt mobile', 'text');
      facts = withMoreType(facts, 'tenure', 'phone');
      const now = { ...saved, facts };
      expect(stationPlan(saved, now, stored, columns)).toMatchObject({ displaySent: true, cardSent: false });
      expect(stationErrors(saved, now, stored, context())).toEqual({});
      const sent = stationPayload(saved, now, stored, columns, columns).context_display;
      // Each in the roster's spelling, the stored `TENURE` replaced; every other stored key as stored.
      expect(sent).toEqual({
        hero: ['Loan No'],
        roles: { amount_due: 'Due' },
        types: { 'Loan No': 'text', 'Alt mobile': 'text', Tenure: 'phone' },
        order: columns,
      });
      expect(isLegacyDisplay(sent)).toBe(true);
    });

    it('takes a More details column\'s type off the stored types when the form takes it off', () => {
      const saved = loaded();
      const now = { ...saved, facts: withColumnType(saved.facts, 'Tenure', 'text') };
      expect(stationPlan(saved, now, stored, columns).cardSent).toBe(false);
      expect(stationPayload(saved, now, stored, columns, columns).context_display).toEqual({
        hero: ['Loan No'], roles: { amount_due: 'Due' }, types: { 'Loan No': 'text' }, order: columns,
      });
    });

    it('sends the card for a type change to a fact\'s column, the guessed name\'s, or any while the columns are unknown', () => {
      const saved = loaded();
      const fact = { ...saved, facts: withColumnType(saved.facts, 'Loan No', 'number') };
      expect(stationPlan(saved, fact, stored, columns).cardSent).toBe(true);
      expect(stationPayload(saved, fact, stored, columns, columns).context_display).toHaveProperty('facts');
      // The name is guessed from `Name`: reading it as a phone changes the card (and the guess).
      const name = { ...saved, facts: withMoreType(saved.facts, 'Name', 'phone') };
      expect(stationPlan(saved, name, stored, columns).cardSent).toBe(true);
      // A column that becomes the guess once it is no longer read as a phone changes the card too.
      const phoneName: AgencyContextDisplay = { ...stored, types: { ...stored.types, Name: 'phone' } };
      const before = stationSettingsOf({ ...legacy, context_display: phoneName }, columns);
      const after = { ...before, facts: withMoreType(before.facts, 'Name', 'text') };
      expect(stationPlan(before, after, phoneName, columns).cardSent).toBe(true);
      // Without the columns, the guesses are not known: any type change sends the card.
      const more = { ...saved, facts: withMoreType(saved.facts, 'Branch', 'number') };
      expect(stationPlan(saved, more, stored, columns).cardSent).toBe(false);
      expect(stationPlan(saved, more, stored).cardSent).toBe(true);
    });
  });
});

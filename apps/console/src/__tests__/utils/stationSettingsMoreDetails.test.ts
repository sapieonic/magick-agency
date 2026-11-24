import { describe, it, expect } from 'vitest';
import type { AgencyCampaign } from '../../types/agency-campaign';
import {
  contextDisplayPayload,
  factsChanged,
  factsFormOf,
  moreDetailsDisplayPayload,
  moreShown,
  moreTypeOf,
  stationPayload,
  stationSettingsOf,
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
    // With a change to the card as well, the card is written.
    const both = { ...now, facts: { ...now.facts, types: { Branch: 'number' as const } } };
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
});

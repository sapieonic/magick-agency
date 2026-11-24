import { describe, it, expect } from 'vitest';
import type { AgencyCampaign } from '../../types/agency-campaign';
import {
  contextDisplayPayload,
  factsChanged,
  factsFormOf,
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
 * `context_display.more_hidden`, a save writes the latest upload's order when none is stored, a
 * change to it is a change of the card, and the type More details reads a column as (a
 * phone-looking value a phone, unless Text is chosen).
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

  it('a display with no order takes the latest upload\'s, in the file\'s order; a stored order is kept', () => {
    expect(contextDisplayPayload({}, facts(), null, ['Name', 'Loan No', 'Branch']).order).toEqual(['Name', 'Loan No', 'Branch']);
    expect(contextDisplayPayload({ order: ['Branch'] }, facts(), null, ['Name', 'Branch']).order).toEqual(['Branch']);
    expect(contextDisplayPayload({}, facts(), null, []).order).toBeUndefined();
    expect(contextDisplayPayload({}, facts()).order).toBeUndefined();
  });

  it('ticking a column off is a change of the card, and the save sends it with the upload\'s order', () => {
    const campaign = { id: 'c-1', name: 'C', status: 'draft', context_display: { facts: [] } } as AgencyCampaign;
    const saved = stationSettingsOf(campaign, ['Name', 'Branch']);
    const now = { ...saved, facts: withMoreShown(saved.facts, 'Branch', false) };
    expect(factsChanged(saved.facts, now.facts)).toBe(true);
    expect(factsChanged(saved.facts, { ...saved.facts, moreHidden: [] })).toBe(false);
    expect(factsChanged(facts({ moreHidden: ['A', 'b'] }), facts({ moreHidden: ['B', 'a', 'A'] }))).toBe(false);
    expect(stationPayload(saved, now, campaign.context_display, ['Name', 'Branch'], ['Name', 'Branch'])).toEqual({
      context_display: { order: ['Name', 'Branch'], roles: { name: 'Name' }, facts: [], more_hidden: ['Branch'] },
    });
  });

  it('reads a phone-looking value as a phone; Text chosen there is written, so it stays text', () => {
    const form = facts({ types: { Tenure: 'number' } });
    expect(moreTypeOf(form, 'Alt mobile', '98765 43210')).toBe('phone');
    expect(moreTypeOf(form, 'Loan No', 'LN-1')).toBe('text');
    expect(moreTypeOf(form, 'Tenure', '24')).toBe('number');
    const text = withMoreType(form, 'Alt mobile', 'text', '98765 43210');
    expect(text.types).toEqual({ Tenure: 'number', 'Alt mobile': 'text' });
    expect(moreTypeOf(text, 'Alt mobile', '98765 43210')).toBe('text');
    // Elsewhere Text stays off the map, as before.
    expect(withMoreType(form, 'Loan No', 'text', 'LN-1').types).toEqual({ Tenure: 'number' });
    expect(withMoreType(text, 'Alt mobile', 'phone', '98765 43210').types).toEqual({ Tenure: 'number', 'Alt mobile': 'phone' });
  });
});

import { describe, it, expect } from 'vitest';
import { AGENCY_AUTO_DISPOSITION_OUTCOMES } from '@magick-agency/contracts/agency';
import {
  EMPTY_CAMPAIGN_CONFIG,
  OUTCOME_LABELS,
  buildConfigPayload,
  configBlockReason,
  configFromCampaign,
  editCatalog,
  emptyCampaignConfig,
  followCatalogEdit,
  isAutoDispositionEligible,
  outcomeDispositionsPayload,
  outcomeDispositionsSummary,
  validateConfig,
  type CampaignConfigState,
  type CatalogEdit,
  type CatalogEditState,
  type MappingFollowState,
} from '../../utils/agencyCampaignConfigForm';
import type {
  AgencyCampaign,
  AgencyDispositionEntry,
  AgencyOutcomeDispositions,
} from '../../types/agency-campaign';

/**
 * Automatic outcomes for unanswered calls (decisions OD1–OD8): the form's half.
 * The mapping round-trips, is sent whole (a PATCH replaces it), is checked against
 * the catalog being saved with the server's keys, and follows its row's code edits.
 */

const CATALOG: AgencyDispositionEntry[] = [
  { code: 'voicemail', label: 'Voicemail' },
  { code: 'callback', label: 'Callback', requires_datetime: true },
  { code: 'do_not_call', label: 'Do not call', suppress: true },
  { code: 'retry_later', label: 'Retry later' },
  { code: 'closed', label: 'Closed', terminal: true },
];

function config(over: Partial<CampaignConfigState> = {}): CampaignConfigState {
  return { ...emptyCampaignConfig(), dispositions: CATALOG.map((e) => ({ ...e })), ...over };
}

const CAMPAIGN: AgencyCampaign = {
  id: 'camp-1',
  name: 'Renewals',
  status: 'draft',
  disposition_catalog: CATALOG,
  outcome_dispositions: { busy: 'retry_later', no_answer: 'callback' },
};

describe('the form state', () => {
  it('starts with nothing mapped, in a copy of its own', () => {
    expect(EMPTY_CAMPAIGN_CONFIG.outcomeDispositions).toEqual({});
    const one = emptyCampaignConfig();
    const two = emptyCampaignConfig();
    expect(one.outcomeDispositions).toEqual({});
    expect(one.outcomeDispositions).not.toBe(two.outcomeDispositions);
    expect(one.outcomeDispositions).not.toBe(EMPTY_CAMPAIGN_CONFIG.outcomeDispositions);
  });

  it('round-trips a stored mapping through load and save', () => {
    const state = configFromCampaign(CAMPAIGN);
    expect(state.outcomeDispositions).toEqual({ busy: 'retry_later', no_answer: 'callback' });
    expect(state.outcomeDispositions).not.toBe(CAMPAIGN.outcome_dispositions);
    expect(buildConfigPayload(state).outcome_dispositions).toEqual({
      busy: 'retry_later',
      no_answer: 'callback',
    });
  });

  it('reads a campaign without the field as nothing mapped, and sends `{}`', () => {
    const { outcome_dispositions: _omit, ...legacy } = CAMPAIGN;
    void _omit;
    const state = configFromCampaign(legacy);
    expect(state.outcomeDispositions).toEqual({});
    expect(buildConfigPayload(state).outcome_dispositions).toEqual({});
  });

  it('sends `{}` once the last mapping is cleared, so the stored map is replaced', () => {
    const state = configFromCampaign(CAMPAIGN);
    const cleared = { ...state, outcomeDispositions: {} };
    expect(buildConfigPayload(cleared).outcome_dispositions).toEqual({});
  });

  it('sends it whatever the assignment scope', () => {
    const state = configFromCampaign(CAMPAIGN);
    for (const scope of ['all', 'settings_only', 'none'] as const) {
      expect(buildConfigPayload(state, scope).outcome_dispositions).toEqual({
        busy: 'retry_later',
        no_answer: 'callback',
      });
    }
  });

  it('sends only the known outcomes, and no empty code', () => {
    const mapping = {
      busy: 'retry_later',
      failed: '',
      connected: 'voicemail',
    } as unknown as AgencyOutcomeDispositions;
    expect(outcomeDispositionsPayload(mapping)).toEqual({ busy: 'retry_later' });
  });
});

describe('validation, keyed as the server keys it', () => {
  it('accepts a mapping to plain outcomes, and an empty one', () => {
    expect(validateConfig(config({ outcomeDispositions: { busy: 'retry_later', no_answer: 'callback' } })))
      .toEqual({});
    expect(validateConfig(config({ outcomeDispositions: {} }))).toEqual({});
    expect(validateConfig(config({ outcomeDispositions: { busy: '' } }))).toEqual({});
  });

  it('refuses a code the catalog does not hold, and blocks the save', () => {
    const state = config({ outcomeDispositions: { failed: 'no_such_code' } });
    const errors = validateConfig(state);
    expect(Object.keys(errors)).toEqual(['outcome_dispositions.failed']);
    expect(errors['outcome_dispositions.failed']).toMatch(/no longer one of this campaign’s outcomes/);
    expect(configBlockReason(state)).toBe('invalid_fields');
  });

  it('refuses an outcome that stops calling the contact', () => {
    const errors = validateConfig(config({ outcomeDispositions: { busy: 'do_not_call' } }));
    expect(errors['outcome_dispositions.busy']).toBe(
      '“Do not call” stops calling the contact. An automatic outcome is only a label and never '
      + 'changes what happens to the contact, so pick an outcome that doesn’t stop or end it.',
    );
    // No claim that the contact is dialled again: an invalid number never is.
    expect(errors['outcome_dispositions.busy']).not.toMatch(/dialled again/);
  });

  it('refuses an outcome that ends the contact', () => {
    const errors = validateConfig(config({ outcomeDispositions: { abandoned: 'closed' } }));
    expect(errors['outcome_dispositions.abandoned']).toBe(
      '“Closed” ends the contact. An automatic outcome is only a label and never changes what '
      + 'happens to the contact, so pick an outcome that doesn’t stop or end it.',
    );
  });

  it('finds a mapped entry removed from the catalog being saved, not the stored one', () => {
    const state = configFromCampaign(CAMPAIGN);
    const removed = {
      ...state,
      dispositions: state.dispositions.filter((entry) => entry.code !== 'retry_later'),
    };
    expect(Object.keys(validateConfig(removed))).toEqual(['outcome_dispositions.busy']);
  });

  it('finds a mapped entry later set to stop calling', () => {
    const state = configFromCampaign(CAMPAIGN);
    const flagged = {
      ...state,
      dispositions: state.dispositions.map((entry) =>
        entry.code === 'callback' ? { ...entry, suppress: true } : entry),
    };
    expect(Object.keys(validateConfig(flagged))).toEqual(['outcome_dispositions.no_answer']);
  });
});

describe('which outcomes may be mapped', () => {
  it('offers neither a stopping nor an ending outcome, nor one without a code', () => {
    expect(CATALOG.filter((e) => isAutoDispositionEligible(CATALOG, e.code)).map((e) => e.code)).toEqual([
      'voicemail',
      'callback',
      'retry_later',
    ]);
    const withNew = [...CATALOG, { code: '', label: 'New' }];
    expect(isAutoDispositionEligible(withNew, '')).toBe(false);
    expect(isAutoDispositionEligible(CATALOG, 'gone')).toBe(false);
  });

  it('reads the first entry with a code, as the server does', () => {
    const shadowed = [{ code: 'later', label: 'Later', suppress: true }, { code: 'later', label: 'Later' }];
    expect(isAutoDispositionEligible(shadowed, 'later')).toBe(false);
  });

  it('names every mappable outcome the way the retry table does', () => {
    expect(AGENCY_AUTO_DISPOSITION_OUTCOMES.map((outcome) => OUTCOME_LABELS[outcome])).toEqual([
      'No answer',
      'Busy',
      'Failed',
      'Invalid number',
      'Abandoned (nobody free)',
    ]);
  });
});

describe('a mapped row edited in the catalog', () => {
  /*
    Drives the reducer and the follow together, as `CampaignBehaviourSection` does:
    each edit goes through `editCatalog`, and a real change through
    `followCatalogEdit` with the rows it returned last time.
  */
  function session(
    dispositions: AgencyDispositionEntry[],
    mapping: AgencyOutcomeDispositions,
    autoCodeRows: ReadonlySet<number> = new Set(),
  ) {
    let catalog: CatalogEditState = { dispositions, autoCodeRows };
    let follow: MappingFollowState = { mapping, rows: {} };
    return {
      edit(...edits: CatalogEdit[]) {
        for (const edit of edits) {
          const next = editCatalog(catalog, edit);
          if (next.dispositions !== catalog.dispositions) {
            follow = followCatalogEdit(catalog.dispositions, edit, next.dispositions, follow);
          }
          catalog = next;
        }
        return follow.mapping;
      },
      /** A pick in the mapping's own select. */
      pick(outcome: keyof AgencyOutcomeDispositions, code: string) {
        follow = { ...follow, mapping: { ...follow.mapping, [outcome]: code } };
      },
      get codes() {
        return catalog.dispositions.map((entry) => entry.code);
      },
    };
  }

  /** One `setCode` per value, as typing or deleting one character at a time sends them. */
  const typing = (index: number, ...codes: string[]): CatalogEdit[] =>
    codes.map((code) => ({ type: 'setCode', index, code }));

  const before = (): AgencyDispositionEntry[] => [
    { code: 'sale', label: 'Sale' },
    { code: 'retry_later', label: 'Retry later' },
  ];
  const mapping: AgencyOutcomeDispositions = { busy: 'retry_later', no_answer: 'sale' };

  it('follows a code typed by hand', () => {
    expect(session(before(), mapping).edit({ type: 'setCode', index: 1, code: 'retry_soon' })).toEqual({
      busy: 'retry_soon',
      no_answer: 'sale',
    });
  });

  it('follows a new row’s code while it follows its label', () => {
    const s = session(before(), {});
    s.edit({ type: 'add' }, { type: 'rename', index: 2, label: 'Promised' });
    s.pick('busy', 'promised');
    expect(s.edit({ type: 'rename', index: 2, label: 'Promised to pay' })).toEqual({ busy: 'promised_to_pay' });
    expect(s.codes[2]).toBe('promised_to_pay');
  });

  it('follows select-all and retype, through the empty code in between', () => {
    const s = session(before(), mapping);
    expect(s.edit(...typing(1, ''))).toEqual({ busy: '', no_answer: 'sale' });
    // Nothing mapped is sent for that moment; the empty code is the catalog's own finding.
    expect(outcomeDispositionsPayload({ busy: '', no_answer: 'sale' })).toEqual({ no_answer: 'sale' });
    expect(s.edit(...typing(1, 'l', 'la', 'lat', 'late', 'later'))).toEqual({
      busy: 'later',
      no_answer: 'sale',
    });
  });

  it('is not taken by another row typed out of an empty code meanwhile', () => {
    const s = session(before(), mapping);
    s.edit({ type: 'add' }, ...typing(1, ''));
    expect(s.edit(...typing(2, 'n', 'ne', 'new'))).toEqual({ busy: '', no_answer: 'sale' });
    expect(s.edit(...typing(1, 'r'))).toEqual({ busy: 'r', no_answer: 'sale' });
  });

  it('follows its row through a code equal to another row’s, wherever that row is', () => {
    const s = session([{ code: 'call', label: 'Call' }, { code: 'callme', label: 'Call me' }], { busy: 'callme' });
    // Backspacing through `call`, which the row above already holds, and on.
    expect(s.edit(...typing(1, 'callm', 'call'))).toEqual({ busy: 'call' });
    expect(s.edit(...typing(1, 'cal', 'call', 'callx'))).toEqual({ busy: 'callx' });
    // The other row's own edits never take the mapping.
    expect(s.edit(...typing(0, 'calls'))).toEqual({ busy: 'callx' });
  });

  it('keeps naming a removed row’s code, so the mapping row reports it', () => {
    const s = session(before(), mapping);
    const removed = s.edit({ type: 'remove', index: 0 });
    expect(removed).toEqual(mapping);
    expect(validateConfig(config({ dispositions: [before()[1]!], outcomeDispositions: removed }))[
      'outcome_dispositions.no_answer'
    ]).toMatch(/‘sale’ is no longer one of this campaign’s outcomes/);
    // The row that moved up into its place is not the removed one.
    expect(s.edit(...typing(0, 'retry_soon'))).toEqual({ busy: 'retry_soon', no_answer: 'sale' });
  });

  it('keeps following its row when a row above it is removed mid-edit', () => {
    const s = session([...before(), { code: 'extra', label: 'Extra' }], mapping);
    s.edit(...typing(1, ''), { type: 'remove', index: 0 });
    expect(s.edit(...typing(0, 'r'))).toEqual({ busy: 'r', no_answer: 'sale' });
  });

  it('moves with its row', () => {
    const s = session(before(), mapping);
    expect(s.edit({ type: 'move', index: 1, delta: -1 })).toBe(mapping);
    expect(s.edit(...typing(0, 'retry_soon'))).toEqual({ busy: 'retry_soon', no_answer: 'sale' });
  });

  it('returns the same object when no mapped code changed', () => {
    const unmapped: AgencyOutcomeDispositions = { busy: 'retry_later' };
    const s = session(before(), unmapped);
    expect(s.edit({ type: 'setCode', index: 0, code: 'sold' }, { type: 'update', index: 1, patch: { label: 'Later' } }))
      .toBe(unmapped);
  });
});

describe('the builder summary line', () => {
  it('lists each mapping by label, in the editor’s order', () => {
    expect(outcomeDispositionsSummary({ busy: 'retry_later', no_answer: 'callback' }, CATALOG))
      .toBe('No answer → Callback; Busy → Retry later');
  });

  it('says None when nothing is mapped', () => {
    expect(outcomeDispositionsSummary({}, CATALOG)).toBe('None');
  });

  it('falls back to the code for one the catalog no longer holds', () => {
    expect(outcomeDispositionsSummary({ failed: 'gone' }, CATALOG)).toBe('Failed → gone');
  });
});

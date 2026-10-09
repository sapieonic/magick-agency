import { describe, expect, it } from 'vitest';
import {
  activityDetailSummary,
  formatActivityTimestamp,
  partialNotice,
  retentionNotice,
  truncationNotice,
} from '../../utils/agencyActivityCopy';
import {
  activityActionLabel,
  activityActionLabels,
  groupActivityActions,
} from '../../types/agency-activity';
import type { ActivityRow } from '../../types/agency-activity';

function row(over: Partial<ActivityRow> = {}): ActivityRow {
  return {
    id: 'core:c1',
    at: '2026-08-01T11:00:00.000Z',
    source: 'core',
    action: 'agency_campaign.auto_paused',
    actor: { type: 'system', system: true, user_id: null, api_key_id: null, display: 'system:abandonment-guardrail' },
    target: { type: 'agency_campaign', id: 'camp-1' },
    detail: {},
    ...over,
  };
}

describe('retentionNotice', () => {
  it('states the horizon when there is one', () => {
    const notice = retentionNotice({
      earliest_retained_at: '2026-05-01T00:00:00.000Z',
      source: 'partition_bound',
    });

    expect(notice).toMatch(/The dialer’s records go back to/);
    expect(notice).toMatch(/no longer stored/);
    // The horizon comes from the DIALER's partitions. Stating it unqualified
    // would claim a guarantee for dispositions, do-not-call marks and staffing
    // changes — records the console keeps on its own schedule — that nothing
    // has checked.
    expect(notice).toMatch(/Console records follow their own retention schedule/);
  });

  /** Nothing has aged out — there is genuinely nothing to warn about. */
  it('says nothing when the trail is unbounded', () => {
    expect(retentionNotice({ earliest_retained_at: null, source: 'unbounded' })).toBeNull();
  });

  /**
   * Silence would be read as "all of it". "We do not know how far back this
   * goes" is information, and on an audit surface it is the honest answer.
   */
  it.each([
    ['an unknown horizon', { earliest_retained_at: null, source: 'unknown' }],
    ['a bound with no date', { earliest_retained_at: null, source: 'partition_bound' }],
  ])('still says something for %s', (_name, retention) => {
    expect(retentionNotice(retention)).toMatch(/could not be determined/);
  });

  it('explains itself when the horizon is missing because the read was partial', () => {
    expect(retentionNotice(null)).toMatch(/could not be checked/);
  });
});

describe('partialNotice', () => {
  /**
   * "Some data is unavailable" is useless: a supervisor who does not know that
   * status changes and the automatic pause are the missing part cannot judge
   * whether what is on screen answers their question.
   */
  it.each([
    ['core_unreachable', /could not be reached/],
    ['core_error', /returned an error/],
    [null, /returned an error/],
  ])('names the cause (%s) and what is missing', (reason, causePattern) => {
    const notice = partialNotice(reason);

    expect(notice).toMatch(causePattern);
    expect(notice).toMatch(/status changes and any automatic pause/);
    expect(notice).toMatch(/Refresh/);
  });
});

describe('truncationNotice', () => {
  it('states the ceiling and the remedy', () => {
    expect(truncationNotice(5000)).toMatch(/most recent 5,000 entries/);
    expect(truncationNotice(5000)).toMatch(/Narrow the date range/);
  });

  /**
   * "Truncated, size unknown" is a real runtime state, not a formality: the
   * ceiling arrives in a response header, and a header that does not parse as a
   * count becomes `null` (see `parseRowLimit`). The sentence for it must still
   * be a sentence — the earlier copy substituted "the maximum" into the number's
   * slot and produced "Only the most recent the maximum entries were exported"
   * — and must still warn, because an export that cannot say HOW truncated it is
   * is still truncated.
   */
  it('degrades to a truthful sentence without inventing a number', () => {
    const notice = truncationNotice(null);

    expect(notice).not.toMatch(/most recent/);
    expect(notice).not.toMatch(/NaN|undefined|null/);
    expect(notice).toMatch(/does not contain every entry/);
    // The remedy is the half the operator acts on, and it does not depend on
    // knowing the ceiling.
    expect(notice).toMatch(/Narrow the date range/);
  });
});

describe('formatActivityTimestamp', () => {
  /**
   * The shared `formatDate` stops at minutes and names no zone, which is fine
   * for "updated 5 minutes ago" and useless here: a whole audit flush shares one
   * displayed minute with no ordering cue, and a reviewer comparing the screen
   * against the ISO-UTC CSV has nothing to reconcile them by.
   */
  it('carries seconds and a named timezone', () => {
    const rendered = formatActivityTimestamp('2026-08-01T11:00:07.000Z');

    expect(rendered).toMatch(/\d{1,2}:\d{2}:\d{2}/);
    expect(rendered).toMatch(/[A-Z]{2,5}|GMT|UTC/);
  });

  it('falls back to the raw value rather than rendering "Invalid Date"', () => {
    expect(formatActivityTimestamp('not-a-date')).toBe('not-a-date');
  });
});

describe('activityDetailSummary', () => {
  /**
   * The row this whole view exists for. "Paused" without the rate it measured
   * and the ceiling it broke tells a compliance reviewer nothing.
   */
  it('reads out the measured rate and the ceiling on an auto-pause', () => {
    expect(
      activityDetailSummary(row({ detail: { measured_pct: 4.2, ceiling_pct: 3 } })),
    ).toBe('Abandonment reached 4.2%, over the 3% ceiling.');
  });

  it('falls back to the reason when the numbers are absent', () => {
    expect(activityDetailSummary(row({ detail: { reason: 'abandonment_ceiling' } })))
      .toBe('Reason: abandonment_ceiling');
  });

  /** The audit case `on_behalf` exists for is called out, not buried. */
  it('says when a disposition was filed for another agent', () => {
    const filed = row({
      action: 'agency_disposition.created',
      detail: { disposition_code: 'promise_to_pay', on_behalf: true },
    });

    expect(activityDetailSummary(filed)).toMatch(/on behalf of the agent who took the call/);
    expect(activityDetailSummary({ ...filed, detail: { disposition_code: 'promise_to_pay' } }))
      .toBe('Filed “promise_to_pay”.');
  });

  it('reports the scope of a do-not-call mark and its reversal', () => {
    expect(activityDetailSummary(row({ action: 'dnc_entry.created', detail: { scope: 'campaign' } })))
      .toBe('Suppressed, scope: campaign.');
    expect(activityDetailSummary(row({ action: 'dnc_entry.deleted', detail: { scope: 'tenant' } })))
      .toBe('Un-suppressed, scope: tenant.');
  });

  it('renders a status transition generically', () => {
    expect(activityDetailSummary(row({ action: 'agency_campaign.stopped', detail: { from: 'running', to: 'stopping' } })))
      .toBe('running → stopping');
  });

  /**
   * `null` means "show the raw detail", which is the point: an action this
   * build does not recognise must not be summarised away, because the
   * unanticipated row is exactly the one an audit needs.
   */
  it('declines to summarise an action it does not know', () => {
    expect(activityDetailSummary(row({ action: 'something.new', detail: { odd: 1 } }))).toBeNull();
  });

  it('ignores a non-numeric rate rather than printing it', () => {
    expect(
      activityDetailSummary(row({ detail: { measured_pct: 'lots', ceiling_pct: 3 } })),
    ).toBeNull();
  });
});

/**
 * The vocabulary as the API serves it, in miniature. Nothing here is a copy of
 * the API's real list — that is exactly what this rework removed — so the labels
 * are deliberately not the production ones: what is under test is that the
 * rendered copy comes from the RESPONSE, not from anything in this repository.
 */
const SERVED = [
  { value: 'agency_campaign.auto_paused', label: 'Halted on its own', group: 'Campaign' },
  { value: 'agency_campaign.paused', label: 'Paused', group: 'Campaign' },
  { value: 'dnc_entry.created', label: 'Marked do-not-call', group: 'Calls' },
];

describe('activityActionLabel', () => {
  it('translates an action the server sent a label for', () => {
    expect(activityActionLabel('agency_campaign.auto_paused', activityActionLabels(SERVED)))
      .toBe('Halted on its own');
  });

  /**
   * An unrecognised row must still be legible, and must be obvious as
   * unrecognised rather than dressed up as something else. Hiding it is the one
   * omission this view cannot afford — and the served list is the set of actions
   * worth OFFERING as a filter, never a claim about what the trail can contain.
   */
  it('falls back to the raw name for an action the server did not name', () => {
    expect(activityActionLabel('agency_campaign.teleported', activityActionLabels(SERVED)))
      .toBe('agency_campaign.teleported');
  });

  /**
   * The case an older server produces. Every row falls back to its raw name
   * rather than rendering blank — which is why the label resolver is separate
   * from the filter, and why the filter is the only thing that disappears.
   */
  it('labels every row by its raw name when no vocabulary was served', () => {
    const none = activityActionLabels(undefined);
    expect(activityActionLabel('agency_campaign.auto_paused', none))
      .toBe('agency_campaign.auto_paused');
  });
});

describe('groupActivityActions', () => {
  /**
   * Server order is kept as-is: re-sorting would put "Auto-paused" beside
   * "Created" alphabetically, which reads as noise to someone scanning for the
   * pause.
   */
  it('keeps the served order, splitting on the group it was given', () => {
    expect(groupActivityActions(SERVED)).toEqual([
      {
        label: 'Campaign',
        actions: [SERVED[0], SERVED[1]],
      },
      { label: 'Calls', actions: [SERVED[2]] },
    ]);
  });

  /** No vocabulary means no groups — and the page renders no filter at all. */
  it('yields nothing for a missing or empty vocabulary', () => {
    expect(groupActivityActions(undefined)).toEqual([]);
    expect(groupActivityActions([])).toEqual([]);
  });
});

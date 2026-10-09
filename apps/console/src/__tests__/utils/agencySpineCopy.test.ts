import { describe, expect, it } from 'vitest';
import {
  ROSTER_DESCRIPTION,
  dispositionLabel,
  recordingDisabledNote,
} from '../../utils/agencySpineCopy';
import type { AgencyCampaign, AgencyDispositionEntry } from '../../types/agency-campaign';

/**
 * Two claims the spine views make about a campaign, pinned.
 *
 * Both existed as the *absence* of a claim, which is what made them expensive:
 * a raw disposition code reads as something internal that leaked, and a Call
 * column with no note reads as a promise of audio that is not there. Neither
 * failure shows up as an error anywhere.
 */

const catalog: AgencyDispositionEntry[] = [
  { code: 'ptp', label: 'PTP', is_success: true, suppress: true },
  { code: 'voicemail', label: 'Voicemail' },
];

const campaign = (over: Partial<AgencyCampaign> = {}): AgencyCampaign =>
  ({ id: 'c1', name: 'Collections', status: 'stopped', ...over } as AgencyCampaign);

describe('dispositionLabel', () => {
  it('renders the operator’s own name for the code', () => {
    // Measured on production: 23 of 36 contacts showed `ptp`, while the
    // campaign's Settings tab held `label: 'PTP'` against that same code.
    expect(dispositionLabel('ptp', catalog)).toBe('PTP');
    expect(dispositionLabel('voicemail', catalog)).toBe('Voicemail');
  });

  it('falls back to the code rather than hiding a historical row', () => {
    /*
      Four ways to miss, and the code is what we know in all four: an older
      master that sends no catalog, a campaign still loading, a code retired
      from the catalog since the call was filed, and a code core wrote that the
      catalog never held. A dash would say the call was never written up — and a
      row filed under a retired code is exactly what an audit is about.
    */
    expect(dispositionLabel('not_interested', catalog)).toBe('not_interested');
    expect(dispositionLabel('ptp', undefined)).toBe('ptp');
    expect(dispositionLabel('ptp', [])).toBe('ptp');
  });

  it('reports a genuinely absent disposition as absent', () => {
    // `null` is "not written up" and the caller renders its own dash for it.
    expect(dispositionLabel(null, catalog)).toBeNull();
    expect(dispositionLabel(undefined, catalog)).toBeNull();
    // An empty code is not a code.
    expect(dispositionLabel('', catalog)).toBeNull();
  });

  it('matches on the code, never on the label', () => {
    /*
      The fixture is the whole test, and the first version of it was a
      false-green: with `{code:'ptp', label:'PTP'}` alone, asking for `'PTP'`
      matches no code, falls through to `?? code`, and returns `'PTP'` — which is
      exactly what a label-matching implementation would also return. The two
      behaviours were indistinguishable.

      Here a label COLLIDES with a different entry's code, so the two diverge:
      asking for `'ptp'`, code-matching finds the SECOND entry and answers
      `'PTP'`, while label-matching finds the FIRST entry (whose label is `'ptp'`)
      and answers `'ptp'`.

      It matters because the wire carries codes. Matching labels too would
      resolve on some campaigns and not others depending on what the operator
      typed, and silently mis-attribute a call on any campaign with a collision.
    */
    const colliding: AgencyDispositionEntry[] = [
      { code: 'x', label: 'ptp' },
      { code: 'ptp', label: 'PTP' },
    ];

    expect(dispositionLabel('ptp', colliding)).toBe('PTP');
    // And a label that is nobody's code still falls through to the input.
    expect(dispositionLabel('PTP', colliding)).toBe('PTP');
  });
});

describe('recordingDisabledNote', () => {
  it('says so once when the campaign is not recording', () => {
    const note = recordingDisabledNote(campaign({ record_calls: false }));

    expect(note).not.toBeNull();
    expect(note!).toMatch(/Recording is off for this campaign/);
    // And says where it is changed, so the note is actionable rather than a
    // dead end — the reader learned this from a drill-down before.
    expect(note!).toMatch(/Settings tab/);
  });

  it('describes the setting without withdrawing audio that already exists', () => {
    /*
      The first version said "there is no audio behind any of these rows", which
      reads a current flag as a history of the rows under it.

      `record_calls` is PATCHable at any point in a campaign's life, and
      `agencyCampaignRecording.ts` is built around that case — master
      deliberately permits the on→off write even to a tenant that has LOST
      `agency.recording`, precisely so a campaign can be switched off mid-life.
      A campaign that recorded four hundred calls and was then switched off is a
      supported state, and on it that sentence withdrew audio that exists and is
      linked from the column beside it.
    */
    const note = recordingDisabledNote(campaign({ record_calls: false }))!;

    expect(note).not.toMatch(/no audio behind any/i);
    expect(note).not.toMatch(/does not record calls/i);
    // Scoped forward, and explicit that older rows may still carry one.
    expect(note).toMatch(/now keep no audio/);
    expect(note).toMatch(/may still have a recording/);
  });

  it('stays quiet when the campaign does record', () => {
    expect(recordingDisabledNote(campaign({ record_calls: true }))).toBeNull();
  });

  it('claims nothing off a field that never arrived', () => {
    /*
      The module's standing rule. `record_calls` is optional because an older
      master does not send it, and announcing "this campaign does not record
      calls" off an absence would be a confident claim about a campaign we know
      nothing about — on the screen a compliance question is asked from.
    */
    expect(recordingDisabledNote(campaign())).toBeNull();
    expect(recordingDisabledNote(campaign({ record_calls: undefined }))).toBeNull();
    expect(recordingDisabledNote(null)).toBeNull();
  });
});

describe('ROSTER_DESCRIPTION', () => {
  it('does not tell a supervisor that suppressed contacts were never dialed', () => {
    /*
      The third copy of one inversion, and the one that was missed.

      Suppression is not only a pre-dial filter: it is also the terminal state a
      contact reaches when an agent files a disposition carrying
      `suppress: true` — a promise to pay, most often. On the production
      campaign this branch was written from, 23 of 36 suppressed contacts had
      been dialed, spoken to and closed as wins.

      This constant is the more prominent of the two slots. `PageDescription`
      renders it as the standing paragraph and the tips as bullets beneath, so a
      reader who never expands the guide reads only this one — which is why
      fixing the tip alone left the campaign's best outcomes still described as
      contacts it failed to reach.
    */
    expect(ROSTER_DESCRIPTION).not.toMatch(/never dialed because/i);
    expect(ROSTER_DESCRIPTION).not.toMatch(/skipped/i);
    // The honest half stays: the roster includes contacts nothing will dial.
    expect(ROSTER_DESCRIPTION).toMatch(/dial again/);
  });
});

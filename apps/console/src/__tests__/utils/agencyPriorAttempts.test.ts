import { describe, it, expect } from 'vitest';
import {
  groupPriorAttempts,
  priorDispositionIsRaw,
  priorDispositionLabel,
} from '../../utils/agencyPriorAttempts';
import type { AgencyDisposition, AgencyPriorAttempt } from '../../types/agency';

/**
 * The agent's history once it spans a retry lineage.
 *
 * Two decisions are pinned here and each has a failure mode an agent meets
 * three seconds before speaking to a customer: `attempt_number` stops being a
 * global ordering the moment a second campaign is in the list (it resets per
 * campaign), and this console can only ever name codes from ITS OWN catalog.
 */

function attempt(over: Partial<AgencyPriorAttempt> = {}): AgencyPriorAttempt {
  return {
    attempt_number: 1,
    outcome: 'no_answer',
    disposition_code: null,
    notes: null,
    ended_at: '2026-08-20T10:00:00.000Z',
    campaign_id: 'camp-child',
    campaign_name: 'Q3 Winback — Retry 1',
    dialed_at: '2026-08-20T09:59:00.000Z',
    ...over,
  };
}

const PARENT = {
  campaign_id: 'camp-parent',
  campaign_name: 'Q3 Winback',
};

describe('grouping by campaign', () => {
  it('puts this campaign first, then the ancestor', () => {
    // The API sends newest-first, and here the ancestor's attempt is the newest —
    // the agent's own pass still leads, because it is the context for the call
    // they are about to take.
    const groups = groupPriorAttempts(
      [
        attempt({ ...PARENT, attempt_number: 2, ended_at: '2026-08-25T10:00:00.000Z' }),
        attempt({ attempt_number: 1, ended_at: '2026-08-20T10:00:00.000Z' }),
      ],
      'camp-child',
      'Q3 Winback — Retry 1',
    );

    expect(groups.map((g) => g.campaignId)).toEqual(['camp-child', 'camp-parent']);
    expect(groups[0]!.isCurrent).toBe(true);
    expect(groups[1]!.isCurrent).toBe(false);
    expect(groups[1]!.campaignName).toBe('Q3 Winback');
  });

  it('keeps the API’s newest-first order inside each group', () => {
    const groups = groupPriorAttempts(
      [
        attempt({ attempt_number: 3, ended_at: '2026-08-22T10:00:00.000Z' }),
        attempt({ attempt_number: 2, ended_at: '2026-08-21T10:00:00.000Z' }),
        attempt({ attempt_number: 1, ended_at: '2026-08-20T10:00:00.000Z' }),
      ],
      'camp-child',
      'Retry 1',
    );

    expect(groups[0]!.attempts.map((a) => a.ended_at)).toEqual([
      '2026-08-22T10:00:00.000Z',
      '2026-08-21T10:00:00.000Z',
      '2026-08-20T10:00:00.000Z',
    ]);
  });

  it('leaves a never-ended attempt at the bottom where the API put it', () => {
    // The API's `NULLS LAST` keeps a reaped or orphaned attempt out of the top
    // slot. Re-sorting here would be a second answer to that and would put it
    // first the moment either side changed.
    const groups = groupPriorAttempts(
      [
        attempt({ attempt_number: 2, ended_at: '2026-08-21T10:00:00.000Z' }),
        attempt({ attempt_number: 1, ended_at: null }),
      ],
      'camp-child',
      'Retry 1',
    );
    expect(groups[0]!.attempts[1]!.ended_at).toBeNull();
  });

  it('orders two ancestors by whose attempt appears first', () => {
    const groups = groupPriorAttempts(
      [
        attempt({ campaign_id: 'camp-b', campaign_name: 'Second pass' }),
        attempt({ campaign_id: 'camp-a', campaign_name: 'First pass' }),
      ],
      'camp-child',
      'Retry 2',
    );
    expect(groups.map((g) => g.campaignId)).toEqual(['camp-b', 'camp-a']);
  });

  it('groups two attempts that each call themselves "attempt 1"', () => {
    // `attempt_number` resets in every retry campaign, so it is not a key and
    // it is not an ordering. Two campaigns each holding an attempt 1 is the
    // ordinary case, not a collision.
    const groups = groupPriorAttempts(
      [attempt({ attempt_number: 1 }), attempt({ ...PARENT, attempt_number: 1 })],
      'camp-child',
      'Retry 1',
    );
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.attempts.length === 1)).toBe(true);
  });
});

describe('the non-retry case is unchanged', () => {
  it('produces one group headed by this campaign', () => {
    const groups = groupPriorAttempts(
      [attempt({ attempt_number: 2 }), attempt({ attempt_number: 1 })],
      'camp-child',
      'Q3 Winback — Retry 1',
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.isCurrent).toBe(true);
    expect(groups[0]!.attempts).toHaveLength(2);
  });

  it('reads an attempt with no campaign id as belonging to this campaign', () => {
    // Before the lineage read existed, every prior attempt came from the
    // contact's own row on the campaign the agent is joined to — so that is the
    // only thing an older API could have meant, and the degraded case is
    // exactly today's flat list rather than a group headed by nothing.
    const stale = { ...attempt(), campaign_id: '', campaign_name: '' };
    const groups = groupPriorAttempts([stale], 'camp-child', 'Q3 Winback — Retry 1');
    expect(groups).toHaveLength(1);
    expect(groups[0]!.campaignId).toBe('camp-child');
    expect(groups[0]!.campaignName).toBe('Q3 Winback — Retry 1');
  });

  it('never heads a group with a bare id', () => {
    const nameless = { ...attempt({ ...PARENT }), campaign_name: '' };
    const groups = groupPriorAttempts([nameless], 'camp-child', 'Retry 1');
    expect(groups[0]!.campaignName).toBe('Another campaign');
    expect(groups[0]!.campaignName).not.toContain('camp-parent');
  });

  it('returns nothing for an empty history', () => {
    expect(groupPriorAttempts([], 'camp-child', 'Retry 1')).toEqual([]);
  });
});

describe('the disposition label', () => {
  const catalog: AgencyDisposition[] = [
    { code: 'sale', label: 'Sale' },
    { code: 'callback', label: 'Call back later' },
  ];

  it('names a code this campaign holds', () => {
    expect(priorDispositionLabel('sale', catalog)).toBe('Sale');
    expect(priorDispositionIsRaw('sale', catalog)).toBe(false);
  });

  it('shows a parent-only code AS the code, never as "Unknown outcome"', () => {
    // An agent reading "Unknown outcome" concludes the write-up was lost. It
    // was not — only its label is missing, and the campaign name beside it says
    // why.
    expect(priorDispositionLabel('ptp', catalog)).toBe('ptp');
    expect(priorDispositionLabel('ptp', catalog)).not.toContain('Unknown');
    expect(priorDispositionIsRaw('ptp', catalog)).toBe(true);
  });

  it('reads an absent catalog as naming nothing rather than throwing', () => {
    expect(priorDispositionLabel('ptp', undefined)).toBe('ptp');
    expect(priorDispositionIsRaw('ptp', undefined)).toBe(true);
  });

  it('keeps "No disposition" as a fact, not a failure', () => {
    // Plenty of attempts end without one; it is not an unresolved code.
    expect(priorDispositionLabel(null, catalog)).toBe('No disposition');
    expect(priorDispositionIsRaw(null, catalog)).toBe(false);
  });
});

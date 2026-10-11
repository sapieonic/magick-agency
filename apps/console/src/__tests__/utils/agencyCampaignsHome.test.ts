import { describe, it, expect } from 'vitest';
import {
  callingDaysLabel,
  campaignGroup,
  countCampaigns,
  filterCampaigns,
  needsPolling,
  scheduleLabel,
  sortCampaigns,
} from '../../utils/agencyCampaignsHome';
import type { AgencyCampaign } from '../../types/agency-campaign';

function campaign(over: Partial<AgencyCampaign> & Pick<AgencyCampaign, 'id' | 'status'>): AgencyCampaign {
  return { name: over.id, ...over };
}

describe('campaignGroup', () => {
  it('groups paused and stopping with running: started and not finished', () => {
    expect(campaignGroup('running')).toBe('active');
    expect(campaignGroup('stopping')).toBe('active');
    expect(campaignGroup('paused')).toBe('active');
  });

  it('puts completed and stopped under finished', () => {
    expect(campaignGroup('completed')).toBe('finished');
    expect(campaignGroup('stopped')).toBe('finished');
  });

  it('never guesses a group for a status it does not know', () => {
    expect(campaignGroup('archived')).toBe('other');
  });
});

describe('countCampaigns', () => {
  it('counts each group, with unknown statuses only in All', () => {
    const counts = countCampaigns([
      campaign({ id: 'a', status: 'running' }),
      campaign({ id: 'b', status: 'paused' }),
      campaign({ id: 'c', status: 'draft' }),
      campaign({ id: 'd', status: 'stopped' }),
      campaign({ id: 'e', status: 'archived' }),
    ]);
    expect(counts).toEqual({ all: 5, active: 2, draft: 1, finished: 1 });
  });
});

describe('sortCampaigns', () => {
  it('reads active first, then drafts, then finished with the latest ended first', () => {
    const order = sortCampaigns([
      campaign({ id: 'old', status: 'completed', ended_at: '2026-01-01T00:00:00Z' }),
      campaign({ id: 'draft', status: 'draft' }),
      campaign({ id: 'paused', status: 'paused' }),
      campaign({ id: 'new', status: 'stopped', ended_at: '2026-06-01T00:00:00Z' }),
      campaign({ id: 'running', status: 'running' }),
    ]).map((c) => c.id);
    expect(order).toEqual(['running', 'paused', 'draft', 'new', 'old']);
  });

  it('keeps the API order (newest first) within a group', () => {
    const order = sortCampaigns([
      campaign({ id: 'newest draft', status: 'draft' }),
      campaign({ id: 'a running', status: 'running' }),
      campaign({ id: 'older draft', status: 'draft' }),
    ]).map((c) => c.id);
    expect(order).toEqual(['a running', 'newest draft', 'older draft']);
  });

  it('does not mutate its input', () => {
    const input = [campaign({ id: 'b', status: 'draft' }), campaign({ id: 'a', status: 'running' })];
    sortCampaigns(input);
    expect(input.map((c) => c.id)).toEqual(['b', 'a']);
  });
});

describe('filterCampaigns', () => {
  const rows = [
    campaign({ id: 'Diwali leads', status: 'running' }),
    campaign({ id: 'Renewals', status: 'draft' }),
    campaign({ id: 'Diwali retry', status: 'draft' }),
  ];

  it('filters by group and by a case-insensitive name match together', () => {
    expect(filterCampaigns(rows, 'draft', '').map((c) => c.id)).toEqual(['Renewals', 'Diwali retry']);
    expect(filterCampaigns(rows, 'all', '  diwali ').map((c) => c.id)).toEqual(['Diwali leads', 'Diwali retry']);
    expect(filterCampaigns(rows, 'draft', 'diwali').map((c) => c.id)).toEqual(['Diwali retry']);
  });
});

describe('callingDaysLabel', () => {
  it('names the common shapes briefly', () => {
    expect(callingDaysLabel([1, 2, 3, 4, 5, 6, 7])).toBe('Every day');
    expect(callingDaysLabel([5, 1, 2, 3, 4])).toBe('Mon–Fri');
    expect(callingDaysLabel([1, 3, 5])).toBe('Mon, Wed, Fri');
    expect(callingDaysLabel([6, 7])).toBe('Sat, Sun');
  });

  it('drops values outside ISO 1–7 rather than printing them', () => {
    expect(callingDaysLabel([0, 8])).toBeNull();
    expect(callingDaysLabel([0, 1, 2, 3])).toBe('Mon–Wed');
    expect(callingDaysLabel(undefined)).toBeNull();
  });
});

describe('scheduleLabel', () => {
  it('joins the window and the days, trimming seconds', () => {
    expect(
      scheduleLabel(
        campaign({
          id: 'a',
          status: 'draft',
          calling_window_start: '09:00:00',
          calling_window_end: '18:30:00',
          calling_days: [1, 2, 3, 4, 5],
        }),
      ),
    ).toBe('09:00–18:30 · Mon–Fri');
  });

  it('is null when the campaign has neither', () => {
    expect(scheduleLabel(campaign({ id: 'a', status: 'draft' }))).toBeNull();
  });
});

describe('needsPolling', () => {
  it('polls a running or stopping campaign whatever its numbers', () => {
    expect(needsPolling('running', null)).toBe(true);
    expect(needsPolling('stopping', { attempts_live: 0, agents: [] })).toBe(true);
  });

  it('keeps polling a paused campaign while calls drain or anyone is on the floor', () => {
    expect(needsPolling('paused', { attempts_live: 2 })).toBe(true);
    expect(
      needsPolling('paused', { attempts_live: 0, agents: [{} as never] }),
    ).toBe(true);
  });

  it('counts agents_live as the floor when the payload carries no roster', () => {
    expect(needsPolling('paused', { attempts_live: 0, agents_live: 3 })).toBe(true);
    expect(needsPolling('paused', { attempts_live: 0, agents_live: 0 })).toBe(false);
    // A roster, when present, is the answer: an empty one is "nobody here".
    expect(needsPolling('paused', { attempts_live: 0, agents: [], agents_live: 3 })).toBe(false);
  });

  it('leaves a settled paused campaign alone, and one whose stats have not loaded', () => {
    expect(needsPolling('paused', { attempts_live: 0, agents: [] })).toBe(false);
    expect(needsPolling('paused', null)).toBe(false);
  });
});

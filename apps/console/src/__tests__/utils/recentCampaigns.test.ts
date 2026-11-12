import { describe, it, expect, beforeEach } from 'vitest';
import {
  RECENT_CAMPAIGNS_KEY,
  clearRecentCampaigns,
  readRecentCampaigns,
  rememberCampaignVisit,
} from '../../utils/recentCampaigns';

/** ⌘K's recent campaigns: newest first, five per account, kept apart per account, never throwing. */

beforeEach(() => localStorage.clear());

const ids = (tenant: string, account: string) => readRecentCampaigns(tenant, account).map((c) => c.id);

describe('recent campaigns', () => {
  it('puts the newest first, moves one opened again to the front under its current name, and keeps five', () => {
    for (const n of [1, 2, 3, 4, 5, 6]) rememberCampaignVisit('t1', 'a1', `c-${n}`, `Campaign ${n}`);
    expect(ids('t1', 'a1')).toEqual(['c-6', 'c-5', 'c-4', 'c-3', 'c-2']);
    rememberCampaignVisit('t1', 'a1', 'c-3', 'Renamed');
    expect(readRecentCampaigns('t1', 'a1').slice(0, 2)).toEqual([
      { id: 'c-3', name: 'Renamed' },
      { id: 'c-6', name: 'Campaign 6' },
    ]);
    expect(ids('t1', 'a1')).toHaveLength(5);
  });

  it('keeps each account’s list apart', () => {
    rememberCampaignVisit('t1', 'a1', 'c-1', 'One');
    rememberCampaignVisit('t1', 'a2', 'c-2', 'Two');
    expect(ids('t1', 'a1')).toEqual(['c-1']);
    expect(ids('t1', 'a2')).toEqual(['c-2']);
    expect(readRecentCampaigns('t1', null)).toEqual([]);
  });

  it('is cleared whole (sign-out)', () => {
    rememberCampaignVisit('t1', 'a1', 'c-1', 'One');
    clearRecentCampaigns();
    expect(localStorage.getItem(RECENT_CAMPAIGNS_KEY)).toBeNull();
    expect(ids('t1', 'a1')).toEqual([]);
  });

  it('reads junk as nothing, and never throws when storage does', () => {
    localStorage.setItem(RECENT_CAMPAIGNS_KEY, '{not json');
    expect(ids('t1', 'a1')).toEqual([]);
    localStorage.setItem(RECENT_CAMPAIGNS_KEY, JSON.stringify({ 't1/a1': [{ id: 7 }, { id: 'c-1', name: 'One' }] }));
    expect(ids('t1', 'a1')).toEqual(['c-1']);

    const throwing = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    };
    expect(() => rememberCampaignVisit('t1', 'a1', 'c-1', 'One', throwing)).not.toThrow();
    expect(readRecentCampaigns('t1', 'a1', throwing)).toEqual([]);
    expect(() => clearRecentCampaigns(throwing)).not.toThrow();
  });
});

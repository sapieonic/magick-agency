import { describe, it, expect } from 'vitest';
import {
  RECENT_CUSTOMER_SEARCHES_KEY,
  clearRecentCustomerSearches,
  readRecentCustomerSearches,
  rememberCustomerSearch,
} from '../../utils/customerSearchRecent';
import {
  clearCustomerSearchAnswers,
  customerSearchAnswer,
  rememberCustomerSearchAnswer,
  searchIdFromLocationState,
} from '../../utils/customerHistoryStore';
import { customerHistoryFixture } from '../helpers/customerHistory';

/**
 * The box's device-local recent searches and the tab's in-memory answers
 * (`docs/customer-history.md` §5, CH6). Both hold phone numbers, so both must be
 * bounded, unreadable input must not break the box, and sign-out must be able to
 * empty them.
 */

function memoryStorage(): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k: string) => data.get(k) ?? null,
    key: (i: number) => [...data.keys()][i] ?? null,
    removeItem: (k: string) => void data.delete(k),
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

describe('recent customer searches', () => {
  it('keeps the last five, newest first, without duplicates', () => {
    const storage = memoryStorage();
    for (let i = 0; i < 7; i += 1) rememberCustomerSearch(storage, { e164: `+9198765432${10 + i}`, country: 'IN' });
    rememberCustomerSearch(storage, { e164: '+919876543214', country: 'IN' });
    const list = readRecentCustomerSearches(storage);
    expect(list).toHaveLength(5);
    expect(list[0]!.e164).toBe('+919876543214');
    expect(new Set(list.map((r) => r.e164)).size).toBe(5);
  });

  it('stores only the E.164 and the country', () => {
    const storage = memoryStorage();
    rememberCustomerSearch(storage, { e164: '+442079460018', country: 'GB' });
    expect(JSON.parse(storage.getItem(RECENT_CUSTOMER_SEARCHES_KEY)!)).toEqual([{ e164: '+442079460018', country: 'GB' }]);
  });

  it('reads garbage, a non-number or a throwing store as an empty list', () => {
    const storage = memoryStorage();
    storage.setItem(RECENT_CUSTOMER_SEARCHES_KEY, '{not json');
    expect(readRecentCustomerSearches(storage)).toEqual([]);
    storage.setItem(RECENT_CUSTOMER_SEARCHES_KEY, JSON.stringify([{ e164: '43210', country: 'IN' }, 'x', null]));
    expect(readRecentCustomerSearches(storage)).toEqual([]);
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readRecentCustomerSearches(throwing)).toEqual([]);
    expect(readRecentCustomerSearches(undefined)).toEqual([]);
  });

  it('clears', () => {
    const storage = memoryStorage();
    rememberCustomerSearch(storage, { e164: '+919876543210', country: 'IN' });
    clearRecentCustomerSearches(storage);
    expect(storage.data.size).toBe(0);
    expect(() =>
      clearRecentCustomerSearches({
        removeItem: () => {
          throw new Error('blocked');
        },
      }),
    ).not.toThrow();
  });
});

describe('the in-memory answers', () => {
  it('holds an answer by its search id, and forgets everything on clear', () => {
    const answer = customerHistoryFixture().search_response;
    rememberCustomerSearchAnswer(answer);
    expect(customerSearchAnswer(answer.search_id)).toBe(answer);
    expect(customerSearchAnswer('chs_unknown')).toBeNull();
    expect(customerSearchAnswer(null)).toBeNull();
    clearCustomerSearchAnswers();
    expect(customerSearchAnswer(answer.search_id)).toBeNull();
  });

  it('keeps a bounded number of answers', () => {
    const base = customerHistoryFixture().search_response;
    for (let i = 0; i < 15; i += 1) rememberCustomerSearchAnswer({ ...base, search_id: `chs_${i}` });
    expect(customerSearchAnswer('chs_0')).toBeNull();
    expect(customerSearchAnswer('chs_14')).not.toBeNull();
    clearCustomerSearchAnswers();
  });

  it('reads only a string search id out of history state', () => {
    expect(searchIdFromLocationState({ searchId: 'chs_1' })).toBe('chs_1');
    expect(searchIdFromLocationState({ searchId: 5 })).toBeNull();
    expect(searchIdFromLocationState(null)).toBeNull();
    expect(searchIdFromLocationState('chs_1')).toBeNull();
  });
});

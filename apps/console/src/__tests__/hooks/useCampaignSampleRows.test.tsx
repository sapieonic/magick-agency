import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, cleanup } from '@testing-library/react';

/**
 * Campaign Settings' sample customers (`useCampaignSampleRows`, AS19): the first few contacts,
 * then each one's columns, read once by an editor; and the read is cancelled when the page goes
 * (R12), so no contact's detail is read and nothing is written after.
 */

const api = vi.hoisted(() => ({
  getCampaignContacts: vi.fn(),
  getCampaignContact: vi.fn(),
}));
vi.mock('../../api/agencySpine', () => api);

import { useCampaignSampleRows, CAMPAIGN_SAMPLE_ROWS_MAX } from '../../hooks/useCampaignColumns';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

const page = (ids: string[]) => ({ rows: ids.map((id) => ({ id })) });

beforeEach(() => {
  vi.clearAllMocks();
  api.getCampaignContact.mockImplementation(async (_campaign: string, id: string) => ({ context: { Name: `Customer ${id}` } }));
});

afterEach(() => cleanup());

describe('useCampaignSampleRows', () => {
  it('reads the first few contacts’ columns', async () => {
    api.getCampaignContacts.mockResolvedValue(page(['1', '2', '3', '4']));
    const { result } = renderHook(() => useCampaignSampleRows('c-1', 't-1', 'a-1', true));
    await flush();
    expect(api.getCampaignContacts).toHaveBeenCalledWith('c-1', {}, { limit: CAMPAIGN_SAMPLE_ROWS_MAX }, 't-1', 'a-1');
    expect(api.getCampaignContact).toHaveBeenCalledTimes(CAMPAIGN_SAMPLE_ROWS_MAX);
    expect(result.current).toEqual([{ Name: 'Customer 1' }, { Name: 'Customer 2' }, { Name: 'Customer 3' }]);
  });

  it('reads nothing while disabled', async () => {
    const { result } = renderHook(() => useCampaignSampleRows('c-1', 't-1', 'a-1', false));
    await flush();
    expect(api.getCampaignContacts).not.toHaveBeenCalled();
    expect(result.current).toEqual([]);
  });

  it('is cancelled on unmount: no detail is read once the page has gone (R12)', async () => {
    const list = deferred<ReturnType<typeof page>>();
    api.getCampaignContacts.mockReturnValue(list.promise);
    const { unmount } = renderHook(() => useCampaignSampleRows('c-1', 't-1', 'a-1', true));
    await flush();
    expect(api.getCampaignContacts).toHaveBeenCalledTimes(1);
    unmount();
    list.resolve(page(['1', '2']));
    await flush();
    expect(api.getCampaignContact).not.toHaveBeenCalled();
  });

  it('a read for a campaign left behind never writes over the next one’s', async () => {
    const first = deferred<ReturnType<typeof page>>();
    api.getCampaignContacts.mockImplementation((campaign: string) => (campaign === 'c-1' ? first.promise : Promise.resolve(page(['9']))));
    const { result, rerender } = renderHook(({ id }) => useCampaignSampleRows(id, 't-1', 'a-1', true), { initialProps: { id: 'c-1' } });
    await flush();
    rerender({ id: 'c-2' });
    await flush();
    expect(result.current).toEqual([{ Name: 'Customer 9' }]);
    first.resolve(page(['1']));
    await flush();
    expect(result.current).toEqual([{ Name: 'Customer 9' }]);
    expect(api.getCampaignContact).not.toHaveBeenCalledWith('c-1', '1', 't-1', 'a-1');
  });
});

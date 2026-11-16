import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The Listening history's client (`docs/listening.md` §12, LS19): the page's read and the CSV,
 * both with the same filters, the CSV's truncation read from its headers, and a refusal thrown
 * with its status and code rather than saved as a file.
 */

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  apiFetch: vi.fn(),
  currentUser: null as { getIdToken: () => Promise<string> } | null,
}));

vi.stubGlobal('fetch', mocks.fetch);
vi.mock('firebase/auth', () => ({ getAuth: () => ({ currentUser: mocks.currentUser }) }));
vi.mock('../../api/client', async () => {
  const actual = await vi.importActual<typeof import('../../api/client')>('../../api/client');
  return { ...actual, apiFetch: mocks.apiFetch };
});

import { downloadListenHistoryCsv, listListenHistory, LISTEN_HISTORY_CSV_FALLBACK_NAME } from '../../api/listenHistory';
import { errorCode, errorStatus } from '../../utils/agencyErrors';

function csvResponse(headers: Record<string, string>): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/csv', ...headers }),
    blob: async () => new Blob(['started_at\n']),
    json: async () => ({}),
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.apiFetch.mockResolvedValue({ entries: [], next_cursor: null });
});

describe('the page’s read', () => {
  it('asks GET /proxy/agency/listen-history with the filters, the cursor and the limit, and the account', async () => {
    await listListenHistory(
      { listener_user_id: 'sup-1', agent_user_id: 'u-1', from: '2026-11-01T00:00:00.000Z', to: '2026-11-17T00:00:00.000Z', cursor: 'c-1', limit: 50 },
      't-1',
      'a-1',
    );
    const [url, init, tenant, account] = mocks.apiFetch.mock.calls[0]!;
    const parsed = new URL(url as string, 'http://x');
    expect(parsed.pathname).toBe('/proxy/agency/listen-history');
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      listener_user_id: 'sup-1',
      agent_user_id: 'u-1',
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-11-17T00:00:00.000Z',
      cursor: 'c-1',
      limit: '50',
    });
    expect([init, tenant, account]).toEqual([{}, 't-1', 'a-1']);
  });

  it('sends no empty filter (the route refuses unknown and blank keys)', async () => {
    await listListenHistory({}, 't-1', 'a-1');
    expect(mocks.apiFetch.mock.calls[0]![0]).toMatch(/\/proxy\/agency\/listen-history$/);
  });
});

describe('the CSV', () => {
  it('asks GET /proxy/agency/listen-history.csv with the same filters, never a cursor or limit', async () => {
    mocks.fetch.mockResolvedValue(csvResponse({ 'x-export-rows': '3', 'content-disposition': 'attachment; filename="listening-history-2026-11-16.csv"' }));
    const result = await downloadListenHistoryCsv({ listener_user_id: 'sup-1', from: '2026-11-01T00:00:00.000Z' }, 't-1', 'a-1');
    const url = new URL(mocks.fetch.mock.calls[0]![0] as string, 'http://x');
    expect(url.pathname).toBe('/proxy/agency/listen-history.csv');
    expect(Object.fromEntries(url.searchParams)).toEqual({ listener_user_id: 'sup-1', from: '2026-11-01T00:00:00.000Z' });
    expect(result).toMatchObject({ truncated: false, rows: 3, filename: 'listening-history-2026-11-16.csv' });
  });

  it('reads a cut-short file: the reason and the ceiling', async () => {
    mocks.fetch.mockResolvedValue(csvResponse({
      'x-export-truncated': 'true',
      'x-export-truncated-reason': 'row_limit',
      'x-export-row-limit': '10000',
      'x-export-rows': '10000',
    }));
    const result = await downloadListenHistoryCsv({}, 't-1', 'a-1');
    expect(result).toMatchObject({ truncated: true, reason: 'row_limit', rowLimit: 10000, rows: 10000, filename: LISTEN_HISTORY_CSV_FALLBACK_NAME });
  });

  it('keeps the warning when the ceiling does not read as a number', async () => {
    mocks.fetch.mockResolvedValue(csvResponse({ 'x-export-truncated': 'true', 'x-export-truncated-reason': 'deadline', 'x-export-row-limit': 'lots' }));
    const result = await downloadListenHistoryCsv({}, 't-1', 'a-1');
    expect(result).toMatchObject({ truncated: true, reason: 'deadline', rowLimit: null });
  });

  it('throws a refusal with its status and code instead of saving the body as a file', async () => {
    mocks.fetch.mockResolvedValue({
      ok: false,
      status: 403,
      headers: new Headers(),
      json: async () => ({ code: 'feature_disabled', message: 'off' }),
      blob: async () => new Blob([]),
    } as unknown as Response);
    const err = await downloadListenHistoryCsv({}, 't-1', 'a-1').catch((e: unknown) => e);
    expect(errorStatus(err)).toBe(403);
    expect(errorCode(err)).toBe('feature_disabled');
  });
});

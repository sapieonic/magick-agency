import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The one CSV export fetch (`api/csvExport.ts`) behind a campaign's attempts and contacts and the
 * listening history: the file, its name, its truncation headers read defensively, the account's
 * headers sent, and a refusal thrown rather than handed back as a file.
 */

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.stubGlobal('fetch', mocks.fetch);
vi.mock('firebase/auth', () => ({ getAuth: () => ({ currentUser: null }) }));

import { fetchCsvExport, parseCount } from '../../api/csvExport';
import { errorCode, errorStatus } from '../../utils/agencyErrors';

function response(init: { ok?: boolean; status?: number; headers?: Record<string, string>; body?: unknown }): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: new Headers(init.headers ?? {}),
    blob: async () => new Blob(['a,b\n']),
    json: async () => init.body,
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fetchCsvExport', () => {
  it('fetches the url with the tenant and account, and reads the file and its headers', async () => {
    mocks.fetch.mockResolvedValue(response({
      headers: {
        'content-disposition': 'attachment; filename="x.csv"',
        'x-export-truncated': 'true',
        'x-export-truncated-reason': 'deadline',
        'x-export-row-limit': '10000',
        'x-export-rows': '42',
      },
    }));
    const out = await fetchCsvExport('/proxy/agency/x.csv?a=1', 't-1', 'a-1');
    const [url, init] = mocks.fetch.mock.calls[0]!;
    expect(url).toBe('/proxy/agency/x.csv?a=1');
    expect(new Headers((init as RequestInit).headers).get('x-tenant-id')).toBe('t-1');
    expect(new Headers((init as RequestInit).headers).get('x-account-id')).toBe('a-1');
    expect(out.blob).toBeInstanceOf(Blob);
    expect(out).toMatchObject({ filename: 'x.csv', truncated: true, reason: 'deadline', rowLimit: 10000, rows: 42 });
  });

  it('a complete file with no name: not truncated, the name null', async () => {
    mocks.fetch.mockResolvedValue(response({}));
    expect(await fetchCsvExport('/x.csv')).toMatchObject({ filename: null, truncated: false, reason: null, rowLimit: null, rows: null });
  });

  it('throws a refusal with its status and code', async () => {
    mocks.fetch.mockResolvedValue(response({ ok: false, status: 403, body: { code: 'forbidden' } }));
    const err = await fetchCsvExport('/x.csv').catch((e: unknown) => e);
    expect(errorStatus(err)).toBe(403);
    expect(errorCode(err)).toBe('forbidden');
  });
});

describe('parseCount', () => {
  it('a positive count, else null', () => {
    expect(parseCount('12')).toBe(12);
    expect(parseCount(null)).toBeNull();
    expect(parseCount('unlimited')).toBeNull();
    expect(parseCount('0')).toBeNull();
    expect(parseCount('-3')).toBeNull();
  });
});

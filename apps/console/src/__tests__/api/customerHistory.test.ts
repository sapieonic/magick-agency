import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The customer-history client (`docs/customer-history.md` §2). Pinned: every call
 * is a POST with the number or the search id in the BODY and nothing in the URL
 * (CH6), the request shapes match the contract's fixture, and the export reads its
 * filename and truncation from the response headers.
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

import {
  CUSTOMER_HISTORY_CSV_FALLBACK_NAME,
  exportCustomerHistory,
  filenameFromContentDisposition,
  getCustomerSearchOptions,
  getCustomerTimeline,
  searchCustomers,
} from '../../api/customerHistory';
import { ApiError } from '../../api/client';
import { customerHistoryFixture } from '../helpers/customerHistory';

const fixture = customerHistoryFixture();

function csvResponse(headers: Record<string, string>): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/csv', ...headers }),
    blob: async () => new Blob(['at,kind\n']),
    json: async () => ({}),
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentUser = null;
});

describe('searchCustomers', () => {
  it('POSTs the raw text and the country to /proxy/agency/customers/search, with no number in the URL', async () => {
    mocks.apiFetch.mockResolvedValue(fixture.search_response);
    const request = fixture.search_request;

    const answer = await searchCustomers(request, 'tenant-1', 'account-1');

    expect(answer).toBe(fixture.search_response);
    const [url, init, tenantId, accountId] = mocks.apiFetch.mock.calls[0]!;
    expect(url).toBe('/proxy/agency/customers/search');
    expect(init).toEqual({ method: 'POST', body: JSON.stringify(request) });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ by: 'phone', value: '098765-43210', country: 'IN' });
    expect(url as string).not.toMatch(/\d{5}/);
    expect(tenantId).toBe('tenant-1');
    expect(accountId).toBe('account-1');
  });

  it('passes an abort signal through, so the box can abandon a search', async () => {
    mocks.apiFetch.mockResolvedValue(fixture.search_response);
    const controller = new AbortController();
    await searchCustomers(fixture.search_request, 't', 'a', controller.signal);
    expect((mocks.apiFetch.mock.calls[0]![1] as RequestInit).signal).toBe(controller.signal);
  });
});

describe('getCustomerSearchOptions', () => {
  it('GETs /proxy/agency/customers/options with the scope headers and no body', async () => {
    mocks.apiFetch.mockResolvedValue({ default_country_code: '+44' });
    expect(await getCustomerSearchOptions('t', 'a')).toEqual({ default_country_code: '+44' });
    const [url, init, tenantId, accountId] = mocks.apiFetch.mock.calls[0]!;
    expect(url).toBe('/proxy/agency/customers/options');
    expect((init as RequestInit).method ?? 'GET').toBe('GET');
    expect((init as RequestInit).body).toBeUndefined();
    expect([tenantId, accountId]).toEqual(['t', 'a']);
  });
});

describe('getCustomerTimeline', () => {
  it('POSTs the search id, filters, cursor and limit in the body', async () => {
    mocks.apiFetch.mockResolvedValue(fixture.timeline_page_last);
    const request = fixture.timeline_request;

    const page = await getCustomerTimeline(request, 't', 'a');

    expect(page).toBe(fixture.timeline_page_last);
    const [url, init] = mocks.apiFetch.mock.calls[0]!;
    expect(url).toBe('/proxy/agency/customers/timeline');
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual(fixture.timeline_request);
  });
});

describe('exportCustomerHistory', () => {
  it('POSTs the search id and filters, and reads the filename and truncation from the headers', async () => {
    mocks.fetch.mockResolvedValue(
      csvResponse({
        // Exactly what the server's `csvAttachmentHeader(customerExportFileName(now))` sends.
        'content-disposition':
          "attachment; filename=\"customer-history-2026-11-06.csv\"; filename*=UTF-8''customer-history-2026-11-06.csv",
        'x-export-truncated': 'true',
      }),
    );

    const result = await exportCustomerHistory(
      { search_id: 'chs_1', filters: { channel: 'campaign' } },
      't',
      'a',
    );

    const [url, init] = mocks.fetch.mock.calls[0]!;
    expect(url).toBe('/proxy/agency/customers/export');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ search_id: 'chs_1', filters: { channel: 'campaign' } });
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers['X-Tenant-Id']).toBe('t');
    expect(init.headers['X-Account-Id']).toBe('a');
    expect(result.filename).toBe('customer-history-2026-11-06.csv');
    expect(result.truncated).toBe(true);
  });

  it('falls back to a neutral name and reports a whole file as not truncated', async () => {
    mocks.fetch.mockResolvedValue(csvResponse({}));
    const result = await exportCustomerHistory({ search_id: 'chs_1' }, 't', 'a');
    expect(result.filename).toBe(CUSTOMER_HISTORY_CSV_FALLBACK_NAME);
    expect(result.truncated).toBe(false);
  });

  it('throws an ApiError carrying the refusal body, so the page can tell an expired search apart', async () => {
    mocks.fetch.mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Headers(),
      json: async () => fixture.error_search_expired,
      blob: async () => new Blob([]),
    } as unknown as Response);

    const error = await exportCustomerHistory({ search_id: 'chs_gone' }, 't', 'a').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).statusCode).toBe(404);
    expect((error as ApiError).details).toEqual(fixture.error_search_expired);
  });

  it('carries the retry wait on a 429', async () => {
    mocks.fetch.mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers(),
      json: async () => ({ error: 'Too Many Requests', message: 'Slow down', retryAfter: 17 }),
      blob: async () => new Blob([]),
    } as unknown as Response);

    const error = await exportCustomerHistory({ search_id: 'chs_1' }, 't', 'a').catch((e: unknown) => e);
    expect((error as ApiError).retryAfterSeconds).toBe(17);
  });
});

describe('filenameFromContentDisposition', () => {
  it('reads quoted, bare and RFC 5987 names', () => {
    expect(filenameFromContentDisposition('attachment; filename="a b.csv"')).toBe('a b.csv');
    expect(filenameFromContentDisposition('attachment; filename=plain.csv')).toBe('plain.csv');
    expect(filenameFromContentDisposition("attachment; filename*=UTF-8''hist%C3%B3ry.csv")).toBe('históry.csv');
    expect(filenameFromContentDisposition(null)).toBeNull();
    expect(filenameFromContentDisposition('attachment')).toBeNull();
  });

  it("reads the server's two-parameter form, preferring filename*", () => {
    expect(
      filenameFromContentDisposition(
        "attachment; filename=\"customer-history-2026-11-06.csv\"; filename*=UTF-8''customer-history-2026-11-06.csv",
      ),
    ).toBe('customer-history-2026-11-06.csv');
    // filename* first, and a name only filename* can carry.
    expect(
      filenameFromContentDisposition("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.csv; filename=\"resume.csv\""),
    ).toBe('résumé.csv');
  });

  it('decodes another RFC 5987 charset, and a language tag, rather than keeping them in the name', () => {
    expect(filenameFromContentDisposition("attachment; filename*=ISO-8859-1'en'r%E9sum%E9.csv")).toBe('résumé.csv');
    expect(filenameFromContentDisposition("attachment; filename*=utf-8'en'x.csv")).toBe('x.csv');
  });

  it('falls back to the plain name when filename* cannot be read', () => {
    expect(filenameFromContentDisposition("attachment; filename*=UTF-8''bad%E0%A4.csv; filename=\"ok.csv\"")).toBe('ok.csv');
    expect(filenameFromContentDisposition("attachment; filename*=KOI8-R''x.csv; filename=\"ok.csv\"")).toBe('ok.csv');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The attempt-spine API client (MAG-159).
 *
 * Two things are pinned. The query builder, because a filter dropped on the way
 * out is a WIDER result set presented as a narrower one — and on this surface
 * the operator reads the result as a fact about the campaign. And the
 * truncation signal, because it is read out of headers another service writes
 * and then shown to an operator verbatim.
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
  downloadSpineCsv,
  getCampaignAttempts,
  getCampaignContacts,
} from '../../api/agencySpine';
import { exportTruncationNotice } from '../../utils/agencySpineCopy';

function csvResponse(headers: Record<string, string>): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/csv', ...headers }),
    blob: async () => new Blob(['attempt_id\n']),
    json: async () => ({}),
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.apiFetch.mockResolvedValue({ rows: [], next_cursor: null, limit: 50 });
});

describe('query building', () => {
  it('sends a multi-value filter as REPEATED params, not a comma-joined string', async () => {
    await getCampaignAttempts(
      'camp-1', { outcome: ['abandoned', 'no_answer'] }, {}, 't', 'a',
    );
    const url = mocks.apiFetch.mock.calls[0]![0] as string;
    // The form both services accept, and the one `agencyStats.ts` sends. It does
    // NOT make a comma inside a value survive — master joins the repeats with a
    // comma and core splits on one — which is why that is asserted nowhere.
    expect(url).toContain('outcome=abandoned&outcome=no_answer');
    expect(url).not.toContain('outcome=abandoned%2Cno_answer');
  });

  it('drops a blank filter rather than sending an empty search box as a filter', async () => {
    await getCampaignContacts('camp-1', { phone: '', state: [] }, {}, 't', 'a');
    const url = mocks.apiFetch.mock.calls[0]![0] as string;
    expect(url).not.toContain('phone=');
    expect(url).not.toContain('state=');
  });

  it('carries the cursor and the limit', async () => {
    await getCampaignAttempts('camp-1', {}, { cursor: 'abc', limit: 25 }, 't', 'a');
    const url = mocks.apiFetch.mock.calls[0]![0] as string;
    expect(url).toContain('cursor=abc');
    expect(url).toContain('limit=25');
  });

  it('always passes the account id through — an omitted one is a 400 from core', async () => {
    await getCampaignContacts('camp-1', {}, {}, 'tenant-9', 'account-9');
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      expect.any(String), {}, 'tenant-9', 'account-9',
    );
  });
});

describe('export headers', () => {
  it('reads a well-formed truncation', async () => {
    mocks.fetch.mockResolvedValue(csvResponse({
      'x-export-truncated': 'true',
      'x-export-truncated-reason': 'row_limit',
      'x-export-row-limit': '50000',
      'x-export-rows': '50000',
    }));

    const result = await downloadSpineCsv('camp-1', 'attempts', {}, 't', 'a');
    expect(result.truncated).toBe(true);
    expect(result.reason).toBe('row_limit');
    expect(result.rowLimit).toBe(50000);
    expect(result.rows).toBe(50000);
  });

  it('keeps the warning when the ceiling does not parse as a count', async () => {
    mocks.fetch.mockResolvedValue(csvResponse({
      'x-export-truncated': 'true',
      'x-export-truncated-reason': 'row_limit',
      'x-export-row-limit': 'unlimited',
    }));

    const result = await downloadSpineCsv('camp-1', 'contacts', {}, 't', 'a');
    // Losing the number must not lose the warning — and `Number('unlimited')`
    // is NaN, which is a `number` and would reach the toast as
    // "stopped at the NaN-row limit": a warning that reads as a bug.
    expect(result.truncated).toBe(true);
    expect(result.rowLimit).toBeNull();
    expect(exportTruncationNotice(result.reason, result.rowLimit, result.rows, 'contacts'))
      .toContain('the export limit');
  });

  it('reports a complete file as complete', async () => {
    mocks.fetch.mockResolvedValue(csvResponse({ 'x-export-rows': '12' }));
    const result = await downloadSpineCsv('camp-1', 'attempts', {}, 't', 'a');
    expect(result.truncated).toBe(false);
    expect(result.rows).toBe(12);
  });

  it('throws on a refusal instead of handing back an error body as a file', async () => {
    mocks.fetch.mockResolvedValue({
      ok: false, status: 404,
      headers: new Headers(),
      json: async () => ({ error: 'Not Found' }),
      blob: async () => new Blob([]),
    } as unknown as Response);

    await expect(downloadSpineCsv('camp-1', 'attempts', {}, 't', 'a')).rejects.toThrow();
  });
});

describe('the truncation notice', () => {
  it('names the remedy, because truncation is the ordinary outcome here', () => {
    const message = exportTruncationNotice('row_limit', 50000, 50000, 'attempts');
    // A campaign can hold a million contacts. "Truncated" with no next step
    // means the operator hands the short file over anyway.
    expect(message).toContain('50,000');
    expect(message).toContain('Narrow it down');
  });

  it('names only filters that exist on the surface it is shown on', () => {
    // The first version said "a date range, a state or an outcome" on both.
    // The roster has neither a date range nor an outcome filter — and a date
    // range could not have worked there anyway, because roster ingest
    // bulk-inserts inside one transaction where `now()` is fixed, so almost
    // the whole roster shares one `created_at`. A remedy the reader cannot
    // follow is worse than none.
    const attempts = exportTruncationNotice('row_limit', 50000, 50000, 'attempts');
    expect(attempts).toContain('date range');
    expect(attempts).toContain('outcome');

    const contacts = exportTruncationNotice('row_limit', 50000, 50000, 'contacts');
    expect(contacts).not.toContain('date range');
    expect(contacts).not.toContain('outcome');
    expect(contacts).toContain('contact state');
    expect(contacts).toContain('suppression reason');
  });

  it('says something different when the export ran out of time', () => {
    const message = exportTruncationNotice('deadline', null, 1200);
    expect(message).toContain('took too long');
    // Deliberately surface-agnostic: a deadline is not about which filter, so
    // this one message is correct on both pages.
    expect(message).toContain('Narrow the filters');
  });
});

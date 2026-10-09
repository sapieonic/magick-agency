import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The CSV half of the campaign Activity API.
 *
 * What is pinned here is the truncation signal, because it is the one piece of
 * this response that is read out of HEADERS another service writes and then
 * shown to an operator unchanged. A header is not a guarantee: anything that
 * does not parse as a count has to become "size unknown" before it leaves this
 * module, or it becomes copy.
 */

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  currentUser: null as { getIdToken: () => Promise<string> } | null,
}));

vi.stubGlobal('fetch', mocks.fetch);
vi.mock('firebase/auth', () => ({ getAuth: () => ({ currentUser: mocks.currentUser }) }));

import { downloadCampaignActivityCsv } from '../../api/agencyActivity';
import { truncationNotice } from '../../utils/agencyActivityCopy';

function csvResponse(headers: Record<string, string>): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/csv', ...headers }),
    blob: async () => new Blob(['at,source\n']),
    json: async () => ({}),
  } as unknown as Response;
}

function download() {
  return downloadCampaignActivityCsv('camp-1', {}, 'tenant-1', 'account-1');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('downloadCampaignActivityCsv — the row ceiling', () => {
  it('reads a well-formed ceiling', async () => {
    mocks.fetch.mockResolvedValue(
      csvResponse({ 'x-activity-truncated': 'true', 'x-activity-row-limit': '5000' }),
    );

    const result = await download();

    expect(result.truncated).toBe(true);
    expect(result.rowLimit).toBe(5000);
  });

  /**
   * The regression. `Number('abc')` is `NaN`, and `NaN` satisfies
   * `rowLimit: number | null` — so a header this client cannot read used to
   * travel intact to the toast and render "Only the most recent NaN entries
   * were exported", a truncation warning that reads as a bug and gets dismissed
   * as one.
   */
  it.each([
    ['a malformed header', 'abc'],
    ['a header with junk after the number', '5000 rows'],
    ['an empty header', ''],
    ['a zero ceiling', '0'],
    ['a negative ceiling', '-1'],
  ])('reports %s as an unknown ceiling, never NaN', async (_case, value) => {
    mocks.fetch.mockResolvedValue(
      csvResponse({ 'x-activity-truncated': 'true', 'x-activity-row-limit': value }),
    );

    const result = await download();

    expect(result.rowLimit).toBeNull();
    expect(Number.isNaN(result.rowLimit as unknown as number)).toBe(false);
    // Losing the number must not lose the warning: the export is still short,
    // and the sentence the operator gets still says so, in English.
    expect(result.truncated).toBe(true);
    const notice = truncationNotice(result.rowLimit);
    expect(notice).not.toMatch(/NaN|undefined|null/);
    expect(notice).toMatch(/does not contain every entry/);
    expect(notice).toMatch(/Narrow the date range/);
  });

  it('leaves the ceiling unknown when the server sends no header at all', async () => {
    mocks.fetch.mockResolvedValue(csvResponse({ 'x-activity-truncated': 'true' }));

    const result = await download();

    expect(result.rowLimit).toBeNull();
  });

  it('does not claim truncation for an untruncated export', async () => {
    mocks.fetch.mockResolvedValue(csvResponse({ 'x-activity-row-limit': '5000' }));

    const result = await download();

    expect(result.truncated).toBe(false);
  });
});

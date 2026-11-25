import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The customer upload's refusals reach the page in the server's words (CS7). The upload is a
 * multipart request built by hand, not `apiFetch`, so its error path is pinned here: a refused
 * workbook (400), and a second Excel file sent while another is being read (429 or 503), each
 * with a plain-words `message`.
 */

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  currentUser: { getIdToken: () => Promise.resolve('tok') },
}));

vi.stubGlobal('fetch', mocks.fetch);
vi.mock('firebase/auth', () => ({ getAuth: () => ({ currentUser: mocks.currentUser }) }));
vi.mock('../../analytics/posthog', () => ({ captureError: vi.fn() }));

import { uploadRosterCsv } from '../../api/agencyCampaigns';
import { ApiError } from '../../api/client';
import { splitRequestId } from '@magick-agency/web-ui/errors';

function refusal(status: number, error: string, message: string) {
  return new Response(JSON.stringify({ statusCode: status, error, message }), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req-9' },
  });
}

async function upload(): Promise<ApiError> {
  const file = new File(['PK'], 'Customers.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  try {
    await uploadRosterCsv(file, 'tenant-1', 'account-1');
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    return err as ApiError;
  }
  throw new Error('the upload did not fail');
}

beforeEach(() => mocks.fetch.mockReset());

describe('the customer upload refused', () => {
  it('keeps a refused workbook’s message as it is (400)', async () => {
    const message = 'This is an older Excel file (.xls). Save it as .xlsx or CSV and upload it again.';
    mocks.fetch.mockResolvedValue(refusal(400, 'unsupported_workbook', message));
    const err = await upload();
    expect(err.statusCode).toBe(400);
    expect(err.message).toBe(message);
  });

  it.each([
    [429, 'Too Many Requests'],
    [503, 'Service Unavailable'],
  ])('keeps the server’s words for a %i, the request id at most beside them', async (status, label) => {
    const message = 'Another Excel file is being read. Try again in a minute.';
    mocks.fetch.mockResolvedValue(refusal(status, label, message));
    const err = await upload();
    expect(err.statusCode).toBe(status);
    // A 5xx carries the request id for support, split off where it is shown (ErrorAlert).
    expect(splitRequestId(err.message).message).toBe(message);
    expect(err.message).not.toMatch(/something went wrong|API error/i);
  });
});

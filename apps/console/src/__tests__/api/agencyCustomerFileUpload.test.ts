import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The customer upload's refusals reach the page in the server's words (CS7, IM8). The upload is
 * a multipart request built by hand, not `apiFetch`, so its error path is pinned here, with the
 * bodies the server sends (`AgencyUploadRefusalCode`): a refused workbook (400), a second Excel
 * file sent while another is being read (429) or while the server restarts (503), and a file
 * over the size limit as nginx answers it (413, an HTML page).
 */

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  currentUser: { getIdToken: () => Promise.resolve('tok') },
}));

vi.stubGlobal('fetch', mocks.fetch);
vi.mock('firebase/auth', () => ({ getAuth: () => ({ currentUser: mocks.currentUser }) }));
vi.mock('../../analytics/posthog', () => ({ captureError: vi.fn() }));

import { uploadCustomerFile } from '../../api/agencyCampaigns';
import { ApiError } from '../../api/client';
import { splitRequestId } from '@magick-agency/web-ui/errors';
import { uploadErrorMessage } from '../../utils/agencyCustomerFile';
import { BUSY_REFUSALS, WORKBOOK_UNSUPPORTED, type UploadRefusal } from '../helpers/uploadRefusals';

function answer({ status, body }: UploadRefusal) {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-request-id': 'req-9' };
  if (body.retry_after_seconds !== undefined) headers['retry-after'] = String(body.retry_after_seconds);
  return new Response(JSON.stringify(body), { status, headers });
}

async function upload(): Promise<ApiError> {
  const file = new File(['PK'], 'Customers.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  try {
    await uploadCustomerFile(file, 'tenant-1', 'account-1');
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    return err as ApiError;
  }
  throw new Error('the upload did not fail');
}

beforeEach(() => mocks.fetch.mockReset());

describe('the customer upload refused', () => {
  it('keeps a refused workbook’s message as it is (400)', async () => {
    mocks.fetch.mockResolvedValue(answer(WORKBOOK_UNSUPPORTED));
    const err = await upload();
    expect(err.statusCode).toBe(400);
    expect(err.message).toBe(WORKBOOK_UNSUPPORTED.body.message);
  });

  it.each(BUSY_REFUSALS)('keeps the server’s words for a %i, and when to try again', async (status, refusal) => {
    mocks.fetch.mockResolvedValue(answer(refusal));
    const err = await upload();
    expect(err.statusCode).toBe(status);
    expect(err.retryAfterSeconds).toBe(refusal.body.retry_after_seconds);
    // A 5xx carries the request id after the words; the page splits it into its own chip
    // (Add contacts' `ErrorAlert`, New campaign's error line), never into the sentence.
    expect(splitRequestId(err.message)).toEqual(
      status >= 500 ? { message: refusal.body.message, requestId: 'req-9' } : { message: refusal.body.message },
    );
  });

  it('reads a 413 that is an HTML page (nginx) as a 413 with no body, which the page says in its own words', async () => {
    mocks.fetch.mockResolvedValue(new Response('<html><body><h1>413 Request Entity Too Large</h1></body></html>', {
      status: 413,
      headers: { 'content-type': 'text/html' },
    }));
    const err = await upload();
    expect(err.statusCode).toBe(413);
    expect(err.details).toBeUndefined();
    expect(uploadErrorMessage(err, 512 * 1024 * 1024)).toBe('This file is too large. A file can be up to 512 MB.');
  });
});

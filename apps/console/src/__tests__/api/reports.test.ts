import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AGENCY_REPORT_ERROR_CODES } from '@magick-agency/contracts/api/agency/reports';

/**
 * The reports client (`docs/reports.md`, the fixed API surface): one function per
 * route, each at its path and method with its body, the scope headers passed
 * through; the download fetches a URL and then navigates to it; and every refusal
 * code (plus the flag gate's `feature_disabled`) has British-English words.
 */

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock('firebase/auth', () => ({ getAuth: () => ({ currentUser: null }) }));
vi.mock('../../api/client', async () => {
  const actual = await vi.importActual<typeof import('../../api/client')>('../../api/client');
  return { ...actual, apiFetch: mocks.apiFetch };
});

import {
  REPORT_ERROR_MESSAGES,
  createReport,
  createReportSubscription,
  deleteReportSubscription,
  downloadReportFile,
  getReport,
  getReportDownload,
  listReportSubscriptions,
  listReports,
  reportErrorCode,
  reportErrorMessage,
  reportRunListQueryString,
  retryReport,
  runReportSubscriptionNow,
  updateReportSubscription,
} from '../../api/reports';
import { ApiError } from '../../api/client';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.apiFetch.mockResolvedValue({});
});

function call(i = 0) {
  const [url, init, tenantId, accountId] = mocks.apiFetch.mock.calls[i]!;
  const req = (init ?? {}) as RequestInit;
  return {
    url: url as string,
    method: req.method ?? 'GET',
    body: req.body === undefined ? undefined : JSON.parse(req.body as string),
    tenantId,
    accountId,
  };
}

describe('runs', () => {
  it('createReport POSTs the request body to /proxy/agency/reports with the scope', async () => {
    const request = {
      kind: 'agent' as const,
      subject_id: 'user-1',
      from: '2026-10-09',
      to: '2026-11-07',
      timezone: 'Asia/Kolkata',
      formats: ['pdf' as const, 'xlsx' as const],
      email_me: true,
    };
    await createReport(request, 't', 'a');
    expect(call()).toEqual({ url: '/proxy/agency/reports', method: 'POST', body: request, tenantId: 't', accountId: 'a' });
  });

  it('listReports GETs the history with only the query keys it was given', async () => {
    await listReports({ limit: 25 }, 't', 'a');
    await listReports({ cursor: 'c 1/2', limit: 25, kind: 'campaign', subject_id: 's', subscription_id: 'sub' }, 't', 'a');
    expect(call(0)).toMatchObject({ url: '/proxy/agency/reports?limit=25', method: 'GET', body: undefined });
    expect(call(1).url).toBe('/proxy/agency/reports?cursor=c+1%2F2&limit=25&kind=campaign&subject_id=s&subscription_id=sub');
  });

  it('builds no query string for an empty query', () => {
    expect(reportRunListQueryString({})).toBe('');
  });

  it('getReport, getReportDownload and retryReport hit the run paths, the id encoded', async () => {
    await getReport('run/1', 't', 'a');
    await getReportDownload('run-1', 'xlsx', 't', 'a');
    await retryReport('run-1', 't', 'a');
    expect(call(0)).toMatchObject({ url: '/proxy/agency/reports/run%2F1', method: 'GET' });
    expect(call(1)).toMatchObject({ url: '/proxy/agency/reports/run-1/files/xlsx', method: 'GET' });
    expect(call(2)).toMatchObject({ url: '/proxy/agency/reports/run-1/retry', method: 'POST', body: undefined });
  });

  it('downloadReportFile fetches the URL, THEN sends the browser to it', async () => {
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { value: { ...original, assign }, configurable: true });
    try {
      mocks.apiFetch.mockResolvedValue({ url: 'https://files.example/r.pdf?sig=1', filename: 'r.pdf', expires_at: 'x' });
      const download = await downloadReportFile('run-1', 'pdf', 't', 'a');
      expect(call()).toMatchObject({ url: '/proxy/agency/reports/run-1/files/pdf' });
      expect(assign).toHaveBeenCalledWith('https://files.example/r.pdf?sig=1');
      expect(download.filename).toBe('r.pdf');
    } finally {
      Object.defineProperty(window, 'location', { value: original, configurable: true });
    }
  });

  it('downloadReportFile does not navigate when the server refuses', async () => {
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { value: { ...original, assign }, configurable: true });
    try {
      mocks.apiFetch.mockRejectedValue(new ApiError(410, { error: 'Gone', code: 'report_expired', message: 'x' }));
      await expect(downloadReportFile('run-1', 'pdf', 't', 'a')).rejects.toBeInstanceOf(ApiError);
      expect(assign).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, 'location', { value: original, configurable: true });
    }
  });
});

describe('subscriptions', () => {
  it('lists, creates, patches, deletes and runs one now at the subscription paths', async () => {
    const create = {
      kind: 'campaign' as const,
      subject_id: 'camp-1',
      cadence: 'weekly' as const,
      send_local_time: '08:30',
      send_weekday: 1,
      formats: ['pdf' as const],
      recipient_user_ids: ['u1'],
    };
    await listReportSubscriptions('t', 'a');
    await createReportSubscription(create, 't', 'a');
    await updateReportSubscription('sub-1', { enabled: false }, 't', 'a');
    await deleteReportSubscription('sub-1', 't', 'a');
    await runReportSubscriptionNow('sub-1', 't', 'a');
    expect(call(0)).toMatchObject({ url: '/proxy/agency/report-subscriptions', method: 'GET', tenantId: 't', accountId: 'a' });
    expect(call(1)).toMatchObject({ url: '/proxy/agency/report-subscriptions', method: 'POST', body: create });
    expect(call(2)).toMatchObject({ url: '/proxy/agency/report-subscriptions/sub-1', method: 'PATCH', body: { enabled: false } });
    expect(call(3)).toMatchObject({ url: '/proxy/agency/report-subscriptions/sub-1', method: 'DELETE', body: undefined });
    expect(call(4)).toMatchObject({ url: '/proxy/agency/report-subscriptions/sub-1/run-now', method: 'POST' });
  });
});

describe('refusals in the console’s words', () => {
  it('has words for every report code and the flag gate', () => {
    for (const code of [...AGENCY_REPORT_ERROR_CODES, 'feature_disabled'] as const) {
      expect(REPORT_ERROR_MESSAGES[code], code).toMatch(/\S/);
    }
    expect(Object.keys(REPORT_ERROR_MESSAGES).sort()).toEqual([...AGENCY_REPORT_ERROR_CODES, 'feature_disabled'].sort());
  });

  it('writes British English and never respells a wire code into the copy', () => {
    const all = Object.values(REPORT_ERROR_MESSAGES).join(' ');
    expect(all).not.toMatch(/\b(canceled|color|organize|analyze|dialed)\b/i);
    expect(all).not.toMatch(/report_|feature_disabled/);
  });

  it('maps a refusal body to its code and words, ignoring the server’s English message', () => {
    const err = new ApiError(429, { error: 'Too Many Requests', code: 'report_queue_full', message: 'queue full' });
    expect(reportErrorCode(err)).toBe('report_queue_full');
    expect(reportErrorMessage(err, 'fallback')).toBe(REPORT_ERROR_MESSAGES.report_queue_full);
  });

  it('maps the flag gate’s 403 feature_disabled', () => {
    const err = new ApiError(403, { error: 'Forbidden', code: 'feature_disabled', message: 'off' });
    expect(reportErrorMessage(err, 'fallback')).toBe('Reports aren’t turned on for this account.');
  });

  it('says a 403 without a known code is a permission refusal', () => {
    expect(reportErrorMessage(new ApiError(403, { error: 'Forbidden', message: 'nope' }), 'fallback')).toBe(
      'You don’t have permission to do that.',
    );
  });

  it('falls back to the error’s own message, then the fallback, for anything else', () => {
    expect(reportErrorCode(new ApiError(500, { error: 'x', code: 'something_else', message: 'boom' }))).toBeNull();
    expect(reportErrorMessage(new Error('Network down'), 'fallback')).toBe('Network down');
    expect(reportErrorMessage(null, 'fallback')).toBe('fallback');
  });
});

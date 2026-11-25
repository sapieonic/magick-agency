import type { AgencyUploadRefusalCode } from '../../types/agency-campaign';

/**
 * The customer upload's refusals as the server sends them (`AgencyUploadRefusalCode`, IM8):
 * `{ error, code, message }`, with `retry_after_seconds` on a 429 or 503. The messages are the
 * server's own (`REFUSAL_MESSAGE` in `apps/server/src/agency/agency-xlsx-refusals.ts`,
 * `UPLOAD_REFUSAL_MESSAGES` in `apps/server/src/api/routes/proxy-agency-campaigns/ingest.ts`), so
 * a page test shows what a supervisor would read.
 */
export interface UploadRefusal {
  status: number;
  body: {
    error: string;
    code: AgencyUploadRefusalCode;
    message: string;
    retry_after_seconds?: number;
  };
}

export const WORKBOOK_UNSUPPORTED: UploadRefusal = {
  status: 400,
  body: {
    error: 'Validation Error',
    code: 'workbook_unsupported',
    message:
      'This is an older Excel file (.xls) or a workbook with a password, which cannot be read. '
      + 'Open it in Excel and save it as an Excel Workbook (.xlsx) without a password, or as CSV, then upload it again.',
  },
};

export const WORKBOOK_UNREADABLE: UploadRefusal = {
  status: 400,
  body: {
    error: 'Validation Error',
    code: 'workbook_unreadable',
    message:
      'This Excel file could not be read. '
      + 'Open it in Excel and save it again as an Excel Workbook (.xlsx) or as CSV, then upload it again.',
  },
};

export const WORKBOOK_BUSY: UploadRefusal = {
  status: 429,
  body: {
    error: 'Too Many Requests',
    code: 'workbook_busy',
    message: 'Another Excel file is being read just now. Try again in a minute.',
    retry_after_seconds: 60,
  },
};

export const SERVER_RESTARTING: UploadRefusal = {
  status: 503,
  body: {
    error: 'Service Unavailable',
    code: 'server_restarting',
    message: 'The server is restarting. Upload the file again in a minute.',
    retry_after_seconds: 60,
  },
};

export const UPLOAD_RATE_LIMITED: UploadRefusal = {
  status: 429,
  body: {
    error: 'Too Many Requests',
    code: 'upload_rate_limited',
    message: "You've uploaded a lot of Excel files in a short time. Try again in 9 minutes, or upload the list as a CSV file.",
    retry_after_seconds: 540,
  },
};

/** The server's own 413 for a workbook whose sheet is over the size limit as CSV. */
export const WORKBOOK_TOO_LARGE: UploadRefusal = {
  status: 413,
  body: {
    error: 'Payload Too Large',
    code: 'file_too_large',
    message:
      'This workbook is too large to read: its sheet comes to more than 512 MB as CSV, '
      + 'and a file can be up to 512 MB. Split the customers into smaller files and upload them again.',
  },
};

/** The refusals that ask the supervisor to try again later: [status, refusal]. */
export const BUSY_REFUSALS: ReadonlyArray<[number, UploadRefusal]> = [
  [WORKBOOK_BUSY.status, WORKBOOK_BUSY],
  [UPLOAD_RATE_LIMITED.status, UPLOAD_RATE_LIMITED],
  [SERVER_RESTARTING.status, SERVER_RESTARTING],
];

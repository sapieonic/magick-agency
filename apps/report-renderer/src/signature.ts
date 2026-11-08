/**
 * The callback signature (contracts `render.ts`): lowercase hex HMAC-SHA256, keyed with
 * `AGENCY_REPORTS_CALLBACK_SECRET`, of `reportSignaturePayload(timestamp, rawBody)`.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { REPORT_SIGNATURE_HEADER, REPORT_TIMESTAMP_HEADER, reportSignaturePayload } from '@magick-agency/contracts/reports';

/** The two headers for a raw body at a unix time in seconds. */
export function signCallback(secret: string, rawBody: string, timestampSeconds: number): Record<string, string> {
  const ts = String(Math.floor(timestampSeconds));
  const signature = createHmac('sha256', secret).update(reportSignaturePayload(ts, rawBody), 'utf8').digest('hex');
  return { [REPORT_TIMESTAMP_HEADER]: ts, [REPORT_SIGNATURE_HEADER]: signature };
}

/** Constant-time check of a signature, for this package's tests (the server verifies with its own). Not exported from the package entry. */
export function verifyCallbackSignature(secret: string, rawBody: string, timestamp: string, signature: string): boolean {
  const expected = Buffer.from(createHmac('sha256', secret).update(reportSignaturePayload(timestamp, rawBody), 'utf8').digest('hex'), 'utf8');
  const given = Buffer.from(signature, 'utf8');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

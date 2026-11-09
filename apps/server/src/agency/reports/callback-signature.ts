/**
 * The render callback's signature (`packages/contracts/src/reports/render.ts` "Signature"):
 * lowercase hex HMAC-SHA256, keyed with `AGENCY_REPORTS_CALLBACK_SECRET`, of
 * `reportSignaturePayload(timestamp, rawBody)` = `${timestamp}.${rawBody}`, in
 * `x-mgkvc-report-signature`, with the unix-seconds timestamp in `x-mgkvc-report-timestamp`.
 * Refused outside ±`REPORT_CALLBACK_MAX_SKEW_SECONDS` of the server's clock. Compared in
 * constant time.
 *
 * During a rotation the server also holds the previous secret
 * (`AGENCY_REPORTS_CALLBACK_SECRET_PREVIOUS`) and accepts a signature made with either; the
 * result says which one matched, so the log shows when the old one stops being used.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { REPORT_CALLBACK_MAX_SKEW_SECONDS, reportSignaturePayload } from '@magick-agency/contracts/reports';

/** The hex signature of `rawBody` sent at `timestamp` (unix seconds). The renderer computes the same. */
export function signReportCallback(secret: string, timestamp: string | number, rawBody: string): string {
  return createHmac('sha256', secret).update(reportSignaturePayload(timestamp, rawBody), 'utf8').digest('hex');
}

export type ReportCallbackSignatureCheck =
  | { ok: true; secret: 'current' | 'previous' }
  | { ok: false; reason: 'no_secret' | 'missing' | 'skew' | 'mismatch' };

const HEX_SHA256_RE = /^[0-9a-f]{64}$/;
const TIMESTAMP_RE = /^\d{1,12}$/;

/**
 * Verify a callback's two headers against its exact body bytes. `secret` undefined (the inline
 * renderer, which posts no callback) refuses everything, whatever `previousSecret` holds.
 */
export function verifyReportCallback(input: {
  secret: string | undefined;
  previousSecret?: string | undefined;
  timestamp: unknown;
  signature: unknown;
  rawBody: string;
  nowMs: number;
}): ReportCallbackSignatureCheck {
  if (!input.secret) return { ok: false, reason: 'no_secret' };
  const { timestamp, signature } = input;
  if (typeof timestamp !== 'string' || !TIMESTAMP_RE.test(timestamp)) return { ok: false, reason: 'missing' };
  if (typeof signature !== 'string' || !HEX_SHA256_RE.test(signature.toLowerCase())) return { ok: false, reason: 'missing' };
  if (Math.abs(input.nowMs / 1000 - Number(timestamp)) > REPORT_CALLBACK_MAX_SKEW_SECONDS) {
    return { ok: false, reason: 'skew' };
  }
  const given = Buffer.from(signature.toLowerCase(), 'hex');
  const matches = (secret: string): boolean => {
    const expected = Buffer.from(signReportCallback(secret, timestamp, input.rawBody), 'hex');
    return expected.length === given.length && timingSafeEqual(expected, given);
  };
  if (matches(input.secret)) return { ok: true, secret: 'current' };
  if (input.previousSecret && matches(input.previousSecret)) return { ok: true, secret: 'previous' };
  return { ok: false, reason: 'mismatch' };
}

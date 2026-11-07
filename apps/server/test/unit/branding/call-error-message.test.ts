import { describe, expect, it } from 'vitest';
import { formatWebRtcCallResponse } from '../../../src/api/responses/webrtc-call.response.js';
import { tenantCallErrorMessage, UNKNOWN_CALL_ERROR_MESSAGE } from '../../../src/api/responses/call-error-message.js';
import type { WebRtcCallRecord } from '@magick-agency/db/models/agency-call.model';

/**
 * A failed call's `error_message`, as a tenant's supervisor sees it (the soft-phone call
 * detail, the campaign spine): a vendor-free British-English sentence from the row's
 * `error_code`, never the raw text the bridge wrote (a carrier's response body, a server
 * setting's name, the carrier's own wording). The raw text stays in the row and the logs.
 */

const VENDOR = /plivo|voicelink|vonage|twilio|PLIVO_|VOICELINK_|api_id|\{"/i;
/** American spellings the console's copy never uses. */
const AMERICAN = /\b(canceled|dialed|redialed|authorization|behavior)\b/i;

/** The raw texts the bridge writes today, by code. */
const RAW: Array<[string, string]> = [
  ['TELEPHONY_INIT_FAILED', 'Plivo create call error 403: {"api_id":"x","error":"geo permission"}'],
  ['TELEPHONY_INIT_OUTCOME_UNKNOWN', 'Plivo create call timed out after 15000 ms; the lead may be queued at the carrier'],
  ['CARRIER_DIAL_NOT_SENT', 'plivo dial not sent: PLIVO_WEBHOOK_BASE_URL is not set'],
  ['CARRIER_DIAL_INVALID_NUMBER', "plivo dial not sent: 'to' is not a phone number with its country code"],
  ['CARRIER_AUTH_REJECTED', 'plivo refused the credential (HTTP 401)'],
  ['CARRIER_RATE_LIMITED', 'plivo refused the dial for its rate limit (HTTP 429)'],
  ['TELEPHONY_CREDENTIAL_UNAVAILABLE', 'Telephony credential cred-1 could not be resolved: disabled'],
  ['TELEPHONY_ERROR', 'Call Rejected'],
  ['BRIDGE_SETUP_FAILED', 'No webhook base URL for telephony provider: voicelink'],
  ['UNSUPPORTED_MEDIA_FORMAT', 'VoiceLink start frame negotiated audio/x-l16'],
  ['STUCK_ACTIVE_CALL', 'stuck active call'],
  ['SOMETHING_NEW', 'VoiceLink add_lead error 500: {"status":false}'],
];

const row = (error_code: string | null, error_message: string | null) => ({
  id: 'c1', tenant_id: 't1', account_id: 'a1', caller_id: '+14155550100', destination_phone: '+14155550199',
  provider: 'plivo', provider_call_id: null, status: 'failed', outcome: 'telephony_init_failed',
  error_code, error_message, initiated_by: null, metadata: {}, recording_requested: false, recording_url: null,
  recording_duration_seconds: null, analysis_profile_id: null, analysis_status: null, call_analysis: null,
  conversation_log: null, transcript_meta: null, answered_at: null, ended_at: null, duration_seconds: 0,
  talk_time_seconds: 0, created_at: new Date(), updated_at: new Date(),
}) as unknown as WebRtcCallRecord;

describe('a failed call`s error, as a tenant sees it', () => {
  it.each(RAW)('%s: a vendor-free British sentence, never the raw text', (code, raw) => {
    const shown = formatWebRtcCallResponse(row(code, raw), '/rec').error_message;
    expect(shown).toBeTruthy();
    expect(shown).not.toBe(raw);
    expect(shown).not.toMatch(VENDOR);
    expect(shown).not.toMatch(AMERICAN);
    // The code itself is a wire identifier and still goes out as is.
    expect(formatWebRtcCallResponse(row(code, raw), '/rec').error_code).toBe(code);
  });

  it('an unknown code, or a message with no code, is the generic sentence; no error at all is null', () => {
    expect(tenantCallErrorMessage('SOMETHING_NEW', 'raw')).toBe(UNKNOWN_CALL_ERROR_MESSAGE);
    expect(tenantCallErrorMessage(null, 'Plivo hangup error 503')).toBe(UNKNOWN_CALL_ERROR_MESSAGE);
    expect(tenantCallErrorMessage(null, null)).toBeNull();
    expect(formatWebRtcCallResponse(row(null, null), '/rec').error_message).toBeNull();
  });
});

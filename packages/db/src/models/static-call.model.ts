// Only `STATIC_CALL_MAX_DURATION_SECONDS` lives here: `audio/decode.ts` uses it
// to cap a decoded clip's duration. There is no static AI-call feature.

/**
 * Max call duration (seconds) handed to the provider on initiation and used as
 * the absolute playback/settlement deadline for WS-static calls. Shared so the
 * XML dispatch path, the SQS-dequeue path, and the WS-static manager all agree.
 */
export const STATIC_CALL_MAX_DURATION_SECONDS = 120;

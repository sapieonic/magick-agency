// PORT NOTE (magick-agency): ported from magic-voice-core/src/db/models/static-call.model.ts@4850d1d9.
// Only `STATIC_CALL_MAX_DURATION_SECONDS` is carried (verbatim value and doc comment):
// `audio/decode.ts` uses it to cap a decoded clip's duration. The rest of the model
// (static_calls records, statuses, terminal-status tuple) is the static AI-call
// feature, which is not carried.

/**
 * Max call duration (seconds) handed to the provider on initiation and used as
 * the absolute playback/settlement deadline for WS-static calls. Shared so the
 * XML dispatch path, the SQS-dequeue path, and the WS-static manager all agree.
 */
export const STATIC_CALL_MAX_DURATION_SECONDS = 120;

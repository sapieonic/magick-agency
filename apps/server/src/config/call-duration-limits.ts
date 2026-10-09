// Call-duration limits. Only `WEBRTC_MAX_DURATION_SECONDS` (read by the stale-call sweep
// floor); the app has no IVR, AI or queued-dial call types.

/** Product-level upper bounds shared by validation and stale-call recovery. */
export const WEBRTC_MAX_DURATION_SECONDS = 14_400;

// PORT NOTE (magick-agency): ported from magic-voice-core/src/config/call-duration-limits.ts@4850d1d9,
// subset: only `WEBRTC_MAX_DURATION_SECONDS` (read by the stale-call sweep floor). The IVR,
// AI-call, intro-clip and queued-dial constants belong to call types agency does not carry.
// Owned by lane C (a new file on the path rule, not one of the lead's config modules).

/** Product-level upper bounds shared by validation and stale-call recovery. */
export const WEBRTC_MAX_DURATION_SECONDS = 14_400;

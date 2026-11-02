// The rate-limit ceilings' defaults, per minute, in one place: the limiter's fallbacks
// (`rate-limit.middleware.ts`) and the config blocks' defaults (`rateLimit` in
// `config/blocks/voice.ts`, `userRateLimit` in `config/blocks/platform.ts`) all read these, so
// they cannot drift apart. What each bucket is and why it is separate is in the middleware's
// header; this file is the SIZING.
//
// ── Sized for a full floor behind one office NAT (decision Q9) ────────────────────────────
// ~500 agents and ~50 supervisors share one public IP; 500 concurrent calls, ~170 answered a
// minute at ~3 dials per answer, so ~510 dials a minute, all from the carrier's few egress IPs.
//
// Where the floor's traffic lands:
//  - The console sends `Authorization: Bearer` on every signed-in request (`authHeaders.ts`),
//    the mobile app too: the coarse per-IP `ip_auth` bucket before auth, then the per-USER
//    bucket once the session middleware has verified the caller. Nothing the floor does
//    signed in touches the plain `ip` bucket.
//  - Unauthenticated (`ip`, `RATE_LIMIT_MAX`): the mobile app's `GET /client-config` (the
//    version gate at start-up, and twice in each pre-flight), invite pages (their own
//    20/min per-route cap), sign-in refusals, 404s.
//  - The station socket upgrade: its own `station` bucket per IP.
//  - VoiceLink's status webhooks (`webhook`) and media stream (`carrier_media`), per carrier IP.

/**
 * `ip` (`RATE_LIMIT_MAX`), unauthenticated, per IP: 2000/min (was 200). A floor arriving at
 * shift start: 500 phones × (1 gate + 2 pre-flight reads of `/client-config`) = 1500 inside
 * a minute, worst case. Above that no floor traffic lands here. Still a guard: every route
 * reachable without a credential is static (`/client-config`), refused before any work
 * (401, 404), or carries its own tighter cap (invites 20/min, super-admin login 5/min).
 */
export const DEFAULT_RATE_LIMIT_MAX = 2000;

/**
 * `ip_auth` (`RATE_LIMIT_IP_AUTH_MAX`), a bearer present, per IP, before auth: 20 000/min
 * (was 3000). The floor's signed-in traffic, all of it from one IP:
 *  - supervisors: the campaigns home polls the list and each active campaign's stats every
 *    10 s, (1 + N) × 6/min, about 70/min with 10 active campaigns; × 50 ≈ 3500/min;
 *  - agents, steady: dispositions (~170/min floor-wide), notes, reads after each call, the
 *    station token on every (re)connect: ~5/min each; × 500 ≈ 2500/min;
 *  - shift start: ~15 requests per agent inside a minute or two (sign-in, campaigns, join,
 *    bootstrap, station token): ≈ 7500 on top of the supervisors' 3500 ≈ 11 000/min.
 * 20 000 is ~1.8× that peak. The per-user bucket below is the one that binds a verified
 * caller; this one bounds what a forged bearer can make the server do before auth refuses
 * it (a local JWT signature check against cached keys, then 401).
 */
export const DEFAULT_RATE_LIMIT_IP_AUTH_MAX = 20_000;

/**
 * Per verified user (`RATE_LIMIT_USER_MAX`, `u:<user id>`): 600/min (was 300), 10 a second.
 * The heaviest single user is a supervisor on the campaigns home: (1 + N) × 6/min, 246/min
 * at N = 40 active campaigns, doubled by a second tab, plus their own actions. An agent
 * peaks at ~15 in the minute they join. Keyed on who is calling, so it never adds up across
 * a NAT.
 */
export const DEFAULT_RATE_LIMIT_USER_MAX = 600;

/**
 * `webhook` (`RATE_LIMIT_WEBHOOK_MAX`), per carrier IP: 5000/min (was 1000). VoiceLink posts
 * ~3 lifecycle webhooks for an unanswered dial and ~4 for an answered one (ringing, answered,
 * ended, completed with the recording): 340 × 3 + 170 × 4 ≈ 1700/min from what may be one
 * egress IP, and it retries a refused delivery, so a breach feeds itself (the 2026-09-03
 * incident in the middleware header). ~2.9× headroom for duplicates and bursts. Each request
 * is token-checked (a Redis read) before it does anything.
 */
export const DEFAULT_RATE_LIMIT_WEBHOOK_MAX = 5000;

/**
 * `carrier_media` (`RATE_LIMIT_CARRIER_MEDIA_MAX`), per carrier IP: 2000/min (was 600). At most
 * one media-stream upgrade per dial, ~510/min; 600 left 1.2× headroom, and a 429 on an
 * upgrade is dead air for the rest of a call. ~4×. Token-gated like the webhooks.
 */
export const DEFAULT_RATE_LIMIT_CARRIER_MEDIA_MAX = 2000;

/**
 * `station` (`RATE_LIMIT_STATION_MAX`), per IP: 3600/min (was 1200, sized for 200 agents). A
 * Wi-Fi blip sends the whole floor down the reconnect ladder at once, 6 upgrades in ~33 s
 * each: 500 × 6 = 3000 inside one window, +20%. A refused upgrade is the expensive failure
 * (a mid-call agent who cannot reconnect misses the 8 s deferred hangup); an upgrade without
 * a valid single-use token costs a Redis lookup and a 4401 close.
 */
export const DEFAULT_RATE_LIMIT_STATION_MAX = 3600;

/** `internal` (`RATE_LIMIT_INTERNAL_MAX`): 1000/min. No route is served there today. */
export const DEFAULT_RATE_LIMIT_INTERNAL_MAX = 1000;

/** `RATE_LIMIT_WINDOW`, shared by every bucket. */
export const DEFAULT_RATE_LIMIT_WINDOW = '1 minute';

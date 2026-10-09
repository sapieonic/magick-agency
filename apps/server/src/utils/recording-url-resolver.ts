/*
 * PORT NOTE (magick-agency): ported from core `src/utils/recording-url-resolver.ts`
 * (v1.123.2). `resolveRecordingUrl` (the AI-call binding over `CallRecord`) is not
 * carried; `isDirectRecordingProvider` and `resolveClientRecordingUrl` are verbatim.
 * The comments below describe core's other carriers.
 */

// Pure, dependency-free resolution of the recording URL surfaced to clients.
// Kept separate from `recording-proxy.ts` (which imports the Zod-validated
// `config` for provider auth headers) so response formatters and CSV exports
// can resolve the URL without pulling telephony config into their import graph.

/**
 * Telephony providers whose recording URL is a plain, unauthenticated, directly
 * playable link — so the client can `<audio src>` it straight from the provider
 * instead of round-tripping through our proxy. For every other provider the
 * recording URL is auth-gated (Twilio Basic, VoBiz X-Auth-*), so it MUST go
 * through the proxy (see `buildUpstreamHeaders` in recording-proxy.ts) and its
 * raw URL is never surfaced to the client.
 *
 * VoiceLink (Elision, India-only) recordings are public https mp3s needing no
 * auth; serving them directly also sidesteps the fact that our (non-India cloud)
 * egress is firewalled off from Elision's host while Indian end-user browsers
 * are not. Add a provider here only once you've confirmed its recording URL is
 * (a) unauthenticated and (b) reachable by the end user directly.
 *
 * Note which way this cuts once our own egress CAN reach the host: the proxy path
 * starts working too, and the allowlist becomes a choice rather than a necessity —
 * one that moves the reachability requirement onto the VIEWER's network. A direct
 * URL is the better path for an Indian audience and the worse one for a viewer
 * outside India, for whom the proxy would have worked. So (b) is about the people
 * who actually open the player, not about us.
 *
 * Plivo is deliberately NOT here even though its recording URLs are documented
 * as public *by default*. "By default" is the disqualifier: whether media
 * requires Basic auth is an account-level console toggle ("HTTP Auth on
 * recordings") carrying no API signal, so a direct URL handed to a browser would
 * work until an operator flipped it and then 401 for every viewer, with nothing
 * in our code having changed. Condition (a) has to hold unconditionally, not by
 * default — so Plivo goes through the proxy, which attaches credentials either
 * way (`buildUpstreamHeaders`).
 */
const DIRECT_RECORDING_PROVIDERS = new Set<string>(['voicelink']);

/**
 * True when a provider's recording URL is a plain, unauthenticated link the
 * client can play directly (i.e. it should NOT be proxied/signed by us).
 */
export function isDirectRecordingProvider(provider: string): boolean {
  return DIRECT_RECORDING_PROVIDERS.has(provider);
}

/**
 * Resolve the recording URL to surface to a client, for any kind of call.
 * Returns one of:
 *  - `null` — no recording on the call.
 *  - an **absolute** external URL (`https://…`) — for providers in
 *    `DIRECT_RECORDING_PROVIDERS`, whose recordings are public/unauthenticated
 *    and reachable by the client directly.
 *  - the given **relative** proxy path — default, for auth-gated providers whose
 *    upstream must be fetched with our credentials.
 *
 * NOTE: the return is therefore heterogeneous (absolute vs relative). Consumers
 * must not blindly prepend an API base — detect absolute URLs (scheme prefix)
 * and use them as-is.
 *
 * `proxyPath` is a parameter because AI calls and WebRTC calls live in different
 * tables behind different streaming routes (`/api/v1/calls/:id/recording` vs
 * `/api/v1/webrtc-call/:id/recording`), while the direct-provider rule is
 * identical for both and must not be forked: a provider added to the allowlist
 * has to take effect on every playback surface at once, or a VoiceLink recording
 * stays unplayable on whichever surface was missed.
 */
export function resolveClientRecordingUrl(input: {
  recordingUrl: string | null | undefined;
  /** The telephony provider the call ran on (`calls.telephony_provider` / `webrtc_calls.provider`). */
  provider: string;
  /** Relative streaming route for this call kind, used for auth-gated providers. */
  proxyPath: string;
}): string | null {
  if (!input.recordingUrl) return null;
  if (isDirectRecordingProvider(input.provider)) return input.recordingUrl;
  return input.proxyPath;
}

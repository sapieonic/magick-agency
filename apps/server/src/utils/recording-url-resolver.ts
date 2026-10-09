// Pure, dependency-free resolution of the recording URL surfaced to clients.
// Kept separate from `recording-proxy.ts` so response formatters and CSV exports
// can resolve the URL without pulling the proxy's dependencies into their import
// graph.

/**
 * Telephony providers whose recording URL is a plain, unauthenticated, directly
 * playable link — so the client can `<audio src>` it straight from the provider
 * instead of round-tripping through our proxy. For any other provider the raw
 * recording URL is never surfaced to the client: it goes through the proxy
 * (`recording-proxy.ts`), which fetches only allow-listed hosts.
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
 * Condition (a) has to hold unconditionally, not *by default*. A provider whose
 * media auth is an account-level console toggle carrying no API signal (Plivo's
 * "HTTP Auth on recordings", for example) would hand a browser a direct URL that
 * works until an operator flips it and then 401s for every viewer, with nothing
 * in our code having changed.
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
 *  - the given **relative** proxy path — default, for every other provider, whose
 *    upstream is fetched by the proxy.
 *
 * NOTE: the return is therefore heterogeneous (absolute vs relative). Consumers
 * must not blindly prepend an API base — detect absolute URLs (scheme prefix)
 * and use them as-is.
 *
 * `proxyPath` is a parameter so each caller names its own streaming route while
 * the direct-provider rule stays in one place and is not forked: a provider added
 * to the allowlist
 * has to take effect on every playback surface at once, or a VoiceLink recording
 * stays unplayable on whichever surface was missed.
 */
export function resolveClientRecordingUrl(input: {
  recordingUrl: string | null | undefined;
  /** The telephony provider the call ran on (the call record's `provider`). */
  provider: string;
  /** Relative streaming route for this call kind, used for non-direct providers. */
  proxyPath: string;
}): string | null {
  if (!input.recordingUrl) return null;
  if (isDirectRecordingProvider(input.provider)) return input.recordingUrl;
  return input.proxyPath;
}

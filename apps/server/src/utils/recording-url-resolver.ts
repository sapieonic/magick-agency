// Pure resolution of the recording URL surfaced to clients. Kept separate from
// `recording-proxy.ts` so response formatters and CSV exports can resolve the URL
// without pulling the proxy's dependencies into their import graph; its one import is
// the codec-free carrier catalogue.
import { findCarrier } from '../telephony/carrier-catalog.js';

/**
 * Whether a call's recording URL is a plain, unauthenticated, directly playable link — so
 * the client can `<audio src>` it straight from the provider instead of round-tripping
 * through our proxy. True only for a call on the service's own account (no pinned
 * credential) of a carrier whose catalogue entry declares `serviceRecordingsArePublic`
 * (`telephony/carrier-catalog.ts`). For every other call the raw recording URL is never
 * surfaced to the client: it goes through the proxy (`recording-proxy.ts`), which fetches
 * only allow-listed hosts.
 *
 * A call pinned to a tenant credential always goes through the proxy, even on a carrier
 * whose service-account recordings are public (CR12): the proxy resolves the credential for
 * `recording` first, so revoking it ends playback on every carrier (B21). Only a null
 * credential counts as unpinned; a row read without the column (undefined) is proxied.
 *
 * VoiceLink (Elision, India-only) recordings are public https mp3s needing no
 * auth; serving them directly also sidesteps the fact that our (non-India cloud)
 * egress is firewalled off from Elision's host while Indian end-user browsers
 * are not. Declare a carrier's service recordings public only once you've confirmed its
 * recording URL is (a) unauthenticated and (b) reachable by the end user directly.
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
export function isDirectRecordingProvider(provider: string, telephonyCredentialId: string | null | undefined): boolean {
  return telephonyCredentialId === null && findCarrier(provider)?.serviceRecordingsArePublic === true;
}

/**
 * Resolve the recording URL to surface to a client, for any kind of call.
 * Returns one of:
 *  - `null` — no recording on the call.
 *  - an **absolute** external URL (`https://…`) — for a direct recording
 *    ({@link isDirectRecordingProvider}): public, unauthenticated and reachable by
 *    the client directly.
 *  - the given **relative** proxy path — default, for every other call, whose
 *    upstream is fetched by the proxy.
 *
 * NOTE: the return is therefore heterogeneous (absolute vs relative). Consumers
 * must not blindly prepend an API base — detect absolute URLs (scheme prefix)
 * and use them as-is.
 *
 * `proxyPath` is a parameter so each caller names its own streaming route while
 * the direct-recording rule stays in one place and is not forked: a carrier whose
 * service recordings are declared public has to take effect on every playback surface
 * at once, or a VoiceLink recording stays unplayable on whichever surface was missed.
 */
export function resolveClientRecordingUrl(input: {
  recordingUrl: string | null | undefined;
  /** The telephony provider the call ran on (the call record's `provider`). */
  provider: string;
  /** The tenant credential the call was pinned to (the call record's `telephony_credential_id`). */
  telephonyCredentialId: string | null | undefined;
  /** Relative streaming route for this call kind, used for non-direct providers. */
  proxyPath: string;
}): string | null {
  if (!input.recordingUrl) return null;
  if (isDirectRecordingProvider(input.provider, input.telephonyCredentialId)) return input.recordingUrl;
  return input.proxyPath;
}

/**
 * The two URLs a carrier with no answer XML (VoiceLink) is handed per dial: the PSTN
 * media stream it dials back, and its status webhook. Each carries its purpose-bound
 * token (Q6).
 *
 * `routeHint` is the media worker's slot when the server runs as several processes
 * (`docs/scaling.md` §2.5): appended as `&w=<slot>`, it lets the primary send the
 * carrier's socket and posts to the worker that holds the call, decided before `add_lead`
 * so nothing can race it. It is routing, never authority: the token is still what the
 * owning worker verifies. Absent (one process) the URLs are exactly what they always were.
 */
export const CARRIER_ROUTE_HINT_PARAM = 'w';

export interface CarrierUrls {
  mediaStreamUrl: string | undefined;
  statusCallbackUrl: string;
}

export function buildCarrierUrls(input: {
  /** The provider's webhook namespace, e.g. `https://host/api/v1/webhooks/voicelink`. */
  base: string;
  callId: string;
  mediaUrlInDialRequest: boolean;
  providerToken: string | undefined;
  webhookToken: string | undefined;
  routeHint?: string | null;
}): CarrierUrls {
  const hint = input.routeHint ? `&${CARRIER_ROUTE_HINT_PARAM}=${encodeURIComponent(input.routeHint)}` : '';
  const mediaStreamUrl = input.mediaUrlInDialRequest
    ? `wss://${new URL(input.base).host}/api/v1/webrtc-call/${input.callId}/pstn-stream?token=${input.providerToken}${hint}`
    : undefined;
  // A provider with no carrier module gets an untokenized URL (and no hint: nothing
  // routes it but its call id).
  const statusCallbackUrl = input.webhookToken
    ? `${input.base}/webrtc-status/${input.callId}?token=${input.webhookToken}${hint}`
    : `${input.base}/webrtc-status/${input.callId}`;
  return { mediaStreamUrl, statusCallbackUrl };
}

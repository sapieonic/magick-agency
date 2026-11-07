/**
 * The URLs a carrier is handed per dial, under its own webhook namespace: its answer,
 * status and recording callbacks, and the PSTN media stream it connects to. Each carries
 * its purpose-bound token (Q6): the callbacks the `webhook` token, the stream the
 * `provider` token.
 *
 * Where the stream URL goes is the carrier module's `mediaUrlInDialRequest`:
 *  - true (VoiceLink, no answer XML): in the dial request itself (`mediaStreamUrl`);
 *  - false (Plivo): in our answer response, which the carrier fetches when the far end
 *    answers. The bridge keeps it on the session (`answerStreamUrl`) for the answer route
 *    to render; it is never sent in the dial.
 *
 * `routeHint` is the media worker's slot when the server runs as several processes
 * (`docs/scaling.md` §2.5): appended as `&w=<slot>`, it lets the primary send the
 * carrier's socket and posts to the worker that holds the call, decided before the dial
 * so nothing can race it. It is routing, never authority: the token is still what the
 * owning worker verifies. Absent (one process) the URLs carry no hint.
 */
import { normalizeWebhookBase } from '../../utils/webhook-base.js';

export const CARRIER_ROUTE_HINT_PARAM = 'w';

/** The callback routes a carrier is handed, under its webhook namespace. */
export type CarrierCallbackRoute = 'webrtc-answer' | 'webrtc-status' | 'webrtc-recording';

/**
 * One carrier callback URL: the provider's webhook base as configured (only trailing
 * slashes stripped, by `normalizeWebhookBase`; host case, an explicit port and any path
 * prefix are kept as written), then the route, the call id and `query` (`?…`, or '').
 *
 * The one construction of these URLs. The dial builds them here ({@link buildCarrierUrls}),
 * and a carrier that signs the URL it called (Plivo's V3 signature) is verified over this
 * same string, rebuilt from the same base and the request's query, so what is checked is
 * byte for byte what the carrier was handed. Rebuilding it from the request instead (an
 * origin parsed out of the base, plus the path the request arrived on) would lower-case
 * the host, drop a default port, and lose a path prefix a reverse proxy strips: every
 * callback refused.
 */
export function carrierCallbackUrl(base: string, route: CarrierCallbackRoute, callId: string, query = ''): string {
  return `${normalizeWebhookBase(base)}/${route}/${callId}${query}`;
}

export interface CarrierUrls {
  /** The media stream URL for the dial request; set only when the carrier takes it there. */
  mediaStreamUrl: string | undefined;
  /** The media stream URL for our answer response; set only when the carrier takes it there. */
  answerStreamUrl: string | undefined;
  /** The carrier's answer callback (`…/webrtc-answer/:id`). A carrier with no answer XML ignores it. */
  answerUrl: string;
  /** The carrier's status callback (`…/webrtc-status/:id`): ring, answer and terminal events. */
  statusCallbackUrl: string;
  /** The carrier's recording-ready callback (`…/webrtc-recording/:id`), for a carrier that has one. */
  recordingCallbackUrl: string;
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
  const streamUrl = input.providerToken
    ? `wss://${new URL(input.base).host}/api/v1/webrtc-call/${input.callId}/pstn-stream?token=${input.providerToken}${hint}`
    : undefined;
  // A provider with no carrier module gets untokenized callbacks (and no hint: nothing
  // routes them but their call id).
  const callback = (route: CarrierCallbackRoute): string => carrierCallbackUrl(
    input.base, route, input.callId, input.webhookToken ? `?token=${input.webhookToken}${hint}` : '',
  );
  return {
    mediaStreamUrl: input.mediaUrlInDialRequest ? streamUrl : undefined,
    answerStreamUrl: input.mediaUrlInDialRequest ? undefined : streamUrl,
    answerUrl: callback('webrtc-answer'),
    statusCallbackUrl: callback('webrtc-status'),
    recordingCallbackUrl: callback('webrtc-recording'),
  };
}

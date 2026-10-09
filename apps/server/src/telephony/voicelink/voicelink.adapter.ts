import { createChildLogger } from '@magick-agency/observability';
import type {
  TelephonyProvider,
  OutboundCallRequest,
  CallEvent,
  MediaStreamConfig,
  AnnouncementResponseParams,
  ProviderCallStatus,
  IvrStepRenderParams,
} from '../types.js';
import type { VoicelinkConfig, VoicelinkAddLeadResponse, VoicelinkCdrResponse, VoicelinkWebhookBody } from './voicelink.types.js';
import { VoicelinkTokenManager } from './voicelink-token-manager.js';
import { parseVoicelinkWebhook } from './voicelink.webhook.js';

const log = createChildLogger({ component: 'voicelink-adapter' });

/**
 * VoiceLink telephony adapter.
 *
 * VoiceLink (Elision/Dialshree-based Indian dialer) is a lead-based outbound
 * dialer: it bridges live call audio to a WebSocket we own and POSTs lifecycle
 * events to a `webhook_url` we own. The WS protocol is Twilio-shaped JSON.
 *
 * Carrier specifics:
 * - Audio is **A-law 8 kHz** (`audio/alaw`), carrier-FORCED — the A-law↔PCM16
 *   codec lives in src/utils/audio.ts.
 * - Dispatch is `POST /v1/add_lead` with the destination split into a bare
 *   `customer_number` + a SEPARATE `country_code` field (no `+`). This split is
 *   load-bearing and unique to VoiceLink — see `splitDestination`.
 * - A real lifecycle webhook exists — parseWebhookEvent is implemented via
 *   parseVoicelinkWebhook.
 * - NO outbound coalescer — VoiceLink accepts `{event:"media", media:{payload}}`
 *   frames as emitted (the WebRTC bridge sends them directly).
 */

/**
 * Render a URL for logging with its secret-bearing parts replaced by `…`.
 *
 * The media URL handed to the carrier carries a purpose-bound media token — in the last path
 * segment or the query string — so it can never be
 * logged as-is. What we DO want to keep is everything that makes the line worth
 * having: scheme, host, route, and the callId.
 *
 * `tokenInLastSegment` is an explicit parameter rather than a guess. Both the
 * media token and the callId are UUIDs, so no heuristic can tell "trailing UUID is
 * a secret" from "trailing UUID is the callId" — and each way of guessing wrong is
 * bad in its own way (leak the token, or bin the correlation the line exists to
 * provide). The caller always knows which URL it built, so it says.
 *
 * The query is redacted wholesale regardless. An unparseable URL degrades to a
 * placeholder rather than risk echoing a secret we failed to locate.
 */
export function redactUrlTail(raw: string, opts: { tokenInLastSegment?: boolean } = {}): string {
  try {
    const url = new URL(raw);
    const segments = url.pathname.split('/').filter(Boolean);
    const query = url.search ? '?…' : '';
    if (segments.length === 0) return `${url.protocol}//${url.host}${query}`;
    // No `segments.length > 1` guard: when the caller says the last segment is a
    // secret, redact it even if it is the ONLY segment. Losing the route from a log
    // line is a cosmetic loss; printing a live media token is a credential leak.
    if (opts.tokenInLastSegment) {
      segments[segments.length - 1] = '…';
    }
    return `${url.protocol}//${url.host}/${segments.join('/')}${query}`;
  } catch {
    return '<unparseable-url>';
  }
}

export class VoicelinkAdapter implements TelephonyProvider {
  readonly name = 'voicelink';
  /**
   * `endCall` below is a documented no-op — VoiceLink's OpenAPI spec exposes no
   * hangup endpoint at all — so a ringing leg cannot be recalled by any means
   * this adapter has. This is the declaration the bridge's ring-cancel warning keys on.
   *
   * `queuesOutboundDials`: `/v1/add_lead` queues the lead in the bot's outbound
   * queue (see `initiateCall`) — it is dialled when the carrier gets to it.
   */
  readonly capabilities = { cancelRinging: false, queuesOutboundDials: true } as const;
  private readonly config: VoicelinkConfig;
  private readonly tokenManager: VoicelinkTokenManager;

  constructor(config: VoicelinkConfig) {
    this.config = config;
    this.tokenManager = new VoicelinkTokenManager(config);
  }

  /**
   * Split an E.164-ish destination into VoiceLink's required
   * `{ countryCode, customerNumber }` shape: a BARE national number (no CC, no
   * `+`, no leading 0) plus the country code as a SEPARATE field (no `+`).
   *
   * Strategy: strip a leading `+`; if the number starts with the configured
   * default country code, split that off as `country_code` and keep the
   * remainder; otherwise fall back to the default country code with the number
   * as-is. Either way, strip any leading zeros off the national part.
   *
   * ⚠️ This transform is specific to VoiceLink.
   * Getting it wrong produces SIP 484 (CC concatenated) / SIP 403 (leading 0) /
   * a fake 0-duration answer (E.164).
   */
  splitDestination(to: string): { countryCode: string; customerNumber: string } {
    const cc = (this.config.defaultCountryCode || '91').replace(/[^0-9]/g, '');
    // Keep digits only (drops the leading `+` and any separators).
    let digits = (to || '').replace(/[^0-9]/g, '');

    if (cc && digits.startsWith(cc) && digits.length > cc.length) {
      // CC is baked into the number — peel it off.
      const national = digits.slice(cc.length).replace(/^0+/, '');
      return { countryCode: cc, customerNumber: national };
    }

    // No recognizable CC prefix — treat the whole thing as a national number
    // (strip a leading trunk 0) and prepend the configured default CC.
    digits = digits.replace(/^0+/, '');
    return { countryCode: cc, customerNumber: digits };
  }

  async initiateCall(req: OutboundCallRequest): Promise<{ providerCallId: string }> {
    // VoiceLink dials OUT to our per-lead websocket_url. The live provider call id
    // only arrives async on the WS `start` frame / webhook, so we correlate via
    // the callId embedded in the URL path and return our callId as providerCallId.
    const host = new URL(this.config.webhookBaseUrl).host;
    // The WebRTC bridge always passes its dedicated leg URL. The `/media-stream/:id`
    // default is only a fallback for a caller that passes none; this service
    // registers no such route.
    const websocket_url =
      req.mediaStreamUrl || `wss://${host}/api/v1/media-stream/${req.callId}`;
    // Honor the caller's status callback (the WebRTC bridge points this at its own
    // /voicelink/webrtc-status route); the /voicelink/status default is a fallback
    // only.
    const webhook_url =
      req.statusCallbackUrl || `https://${host}/api/v1/webhooks/voicelink/status/${req.callId}`;

    // The country-code split is load-bearing — see splitDestination.
    const { countryCode, customerNumber } = this.splitDestination(req.to);
    // The DID must be bare digits (no `+`).
    const didNumber = (req.from || '').replace(/[^0-9]/g, '');

    const body = {
      did_number: didNumber,
      customer_number: customerNumber,
      country_code: countryCode,
      websocket_url,
      webhook_url,
    };

    // `websocket_url` is logged because it is the field the carrier must dial back,
    // and "what URL did we actually hand the carrier" is the first question when a
    // call answers into silence. The URL embeds a media token, so its tail is
    // redacted; `websocketUrlHasQuery` is retained as a cheap shape signal (a query
    // string is NOT believed to cause that symptom — the known failure is the
    // carrier fetching this URL as a plain HTTP GET instead of upgrading).
    log.info(
      {
        callId: req.callId,
        to: req.to,
        countryCode,
        from: didNumber,
        // A caller-supplied mediaStreamUrl is treated as secret-bearing in its last
        // path segment (the bridge's leg URL carries its token in the query, which
        // is redacted regardless); the default URL ends in the callId and must
        // stay readable.
        websocketUrl: redactUrlTail(websocket_url, { tokenInLastSegment: Boolean(req.mediaStreamUrl) }),
        websocketUrlHasQuery: websocket_url.includes('?'),
        webhookUrlHasQuery: webhook_url.includes('?'),
      },
      'Initiating VoiceLink call',
    );

    const data = await this.post('/v1/add_lead', body);

    log.info(
      { callId: req.callId, outboundQueueId: data?.data?.outbound_queue_id, botId: data?.data?.bot_id },
      'VoiceLink call dispatched',
    );
    return { providerCallId: req.callId };
  }

  /**
   * POSTs to a VoiceLink endpoint with a Bearer token. On HTTP 401 it forces a
   * token refresh and retries the request exactly once (a stale Sanctum token is
   * the expected 401 cause). Any non-ok, non-401 response throws.
   */
  private async post(path: string, body: Record<string, unknown>): Promise<VoicelinkAddLeadResponse> {
    const url = `${this.config.baseUrl}${path}`;
    const send = async (token: string): Promise<Response> =>
      fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });

    let response = await send(await this.tokenManager.getToken());
    if (response.status === 401) {
      // Stale token — refresh once and retry.
      response = await send(await this.tokenManager.refresh());
    }

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`VoiceLink ${path} error ${response.status}: ${errBody}`);
    }

    return (await response.json()) as VoicelinkAddLeadResponse;
  }

  async endCall(_providerCallId: string): Promise<void> {
    // OPEN ITEM: VoiceLink's OpenAPI spec exposes NO hangup endpoint, and a WS
    // hangup command was not observed in the reverse-engineering captures. Safe
    // default: no-op — the call ends when our media-stream WebSocket closes /
    // VoiceLink sends its `stop` frame. The WebRTC bridge closes the PSTN socket on
    // teardown, so a forced end (max duration, agent hangup) still terminates an
    // answered call. If a confirmed WS-command or REST hangup surfaces, wire it
    // here. Never throws into the end path.
    return;
  }

  async getMediaStreamConfig(_providerCallId: string): Promise<MediaStreamConfig> {
    // Informational only — nothing consumes this at runtime. The authoritative
    // A-law handling is in the WebRTC bridge's VoiceLink branches. VoiceLink's
    // carrier forces A-law 8 kHz.
    return {
      type: 'websocket',
      codec: 'pcma',
      sampleRate: 8000,
      direction: 'both',
    };
  }

  parseWebhookEvent(rawBody: unknown, _headers: Record<string, string>): CallEvent {
    const body = rawBody as VoicelinkWebhookBody;
    const callId = body.call?.id || '';
    const event = parseVoicelinkWebhook(body, callId);
    if (!event) {
      // Informational/unknown event with no state transition. The interface
      // requires a CallEvent, so surface a benign 'error'-typed event carrying
      // the raw body; the webhook route uses parseVoicelinkWebhook directly (and
      // handles null), so this branch is effectively unused in practice.
      return {
        providerCallId: callId,
        callId,
        eventType: 'error',
        timestamp: new Date(),
        metadata: { ...(body as Record<string, unknown>), informational: true },
      };
    }
    return event;
  }

  generateAnswerResponse(_callId: string, _streamUrl: string): string {
    // VoiceLink has no answer XML — the WS is bound at add_lead time via the
    // per-lead websocket_url. Final from day one; must stay an empty string.
    return '';
  }

  generateAnnouncementResponse(_params: AnnouncementResponseParams): string {
    // VoiceLink has no provider <Play>/<Speak> XML; clips are played over the
    // media socket instead, so this is never used.
    return '';
  }

  generateIvrResponse(_steps: IvrStepRenderParams[]): string {
    // VoiceLink exposes neither answer/gather XML nor a documented DTMF channel,
    // so an IVR cannot drive it.
    throw new Error('IVR not supported for voicelink');
  }

  async getCallStatus(providerCallId: string): Promise<ProviderCallStatus> {
    // NOTE: nothing calls this today. VoiceLink's CDR is keyed on VoiceLink's own
    // call_id, but `initiateCall` returns our own `req.callId` as the
    // providerCallId, so that id won't match a CDR row. Passing VoiceLink's
    // provider id would be needed to make this work. Best-effort — returns
    // 'unknown' if the CDR misses.
    const cdr = await this.fetchCdr(providerCallId);
    const data = cdr?.data;
    if (!data) return { status: 'unknown' };
    return {
      status: (data.call_status || 'unknown').toLowerCase(),
      duration: typeof data.talk_duration === 'number' ? data.talk_duration : (data.call_duration || undefined),
      errorMessage: data.hangup_reason || undefined,
    };
  }

  async getRecordingUrl(_providerCallId: string): Promise<string | null> {
    // Returns null WITHOUT a carrier round trip, deliberately. Do NOT add a CDR
    // fetch here — two independent reasons:
    //
    // 1. The id an adapter is handed is OUR OWN callId, not VoiceLink's.
    //    `initiateCall` returns `req.callId` as the providerCallId because the
    //    carrier's real call id only ever arrives asynchronously (WS `start`
    //    frame / webhook). A CDR keyed on VoiceLink's call_id therefore CANNOT
    //    match: measured 560 CDR 404s per ~591 lookups, a 1:1 miss rate.
    // 2. Even on a hit it would contribute nothing. The recording URL arrives on
    //    the `call.completed` webhook body (`call.recordingUrl`, which the bridge
    //    persists from `/voicelink/webrtc-status`) — that is the real source of
    //    truth for this carrier.
    //
    // Reviving this requires passing VoiceLink's own call id; `fetchCdr` (still
    // used by getCallStatus) is the mechanism.
    return null;
  }

  /** GET /v1/call-log/details?call_id=<id>. Returns null on any error/miss. */
  private async fetchCdr(callId: string): Promise<VoicelinkCdrResponse | null> {
    try {
      const url = `${this.config.baseUrl}/v1/call-log/details?call_id=${encodeURIComponent(callId)}`;
      const get = async (token: string): Promise<Response> =>
        fetch(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } });
      let response = await get(await this.tokenManager.getToken());
      if (response.status === 401) {
        response = await get(await this.tokenManager.refresh());
      }
      if (!response.ok) {
        log.warn({ callId, status: response.status }, 'VoiceLink CDR fetch non-ok');
        return null;
      }
      return (await response.json()) as VoicelinkCdrResponse;
    } catch (err) {
      log.warn({ err, callId }, 'VoiceLink CDR fetch failed');
      return null;
    }
  }

  validateWebhookSignature(_rawBody: string, _signature: string): boolean {
    // VoiceLink documents no webhook signing scheme. Security relies on HTTPS
    // transport and what the URL carries: the non-guessable callId and, on the
    // bridge's route, the purpose-bound webhook token.
    return true;
  }
}

/**
 * VoiceLink telephony provider type definitions.
 *
 * VoiceLink (Elision/Dialshree-based Indian dialer) is a lead-based outbound
 * dialer that bridges call audio to a WebSocket we own and POSTs lifecycle events
 * to a `webhook_url` we own. Its specifics: A-law 8 kHz audio (carrier-forced), a
 * real lifecycle webhook, `POST /v1/add_lead` dispatch with the destination split
 * into a bare `customer_number` + separate `country_code` field, and NO outbound
 * coalescer (frames are accepted as emitted).
 *
 * Protocol reverse-engineered live on 2026-07-11.
 */

export interface VoicelinkConfig {
  /** VoiceLink REST base URL, e.g. https://app.voicelink.co.in/api. */
  baseUrl: string;
  /** POST /v1/auth/login field. Secret-adjacent — never log. */
  username: string;
  /** POST /v1/auth/login field. Secret — never log. */
  password: string;
  /** Our public base for the webhook_url + to derive the per-lead websocket_url host. */
  webhookBaseUrl: string;
  /** A VoiceLink-provisioned DID used as the outbound caller ID (the add_lead `did_number`). */
  defaultCallerId: string;
  /**
   * Default calling country code (no `+`, e.g. `91`). Used to split req.to into
   * the bare `customer_number` + separate `country_code` fields add_lead requires.
   */
  defaultCountryCode: string;
}

/**
 * `POST /v1/auth/login` response. Laravel-Sanctum-style token nested at
 * `data.access_token` (equal to `data.user.plain_api_token`).
 */
export interface VoicelinkLoginResponse {
  data?: {
    access_token?: string;
    token_type?: string;
    user?: Record<string, unknown>;
  };
  message?: string;
}

/**
 * Body shape for `POST /v1/add_lead`. The destination is split: `customer_number`
 * is the BARE national number (no country code, no `+`, no leading 0) and
 * `country_code` is a SEPARATE field (no `+`). This split is load-bearing — see
 * `VoicelinkAdapter.splitDestination`.
 */
export interface VoicelinkAddLeadBody {
  /** The FROM DID (bare, no `+`). */
  did_number: string;
  /** Callee: bare national number (no CC, no `+`, no leading 0). */
  customer_number: string;
  /** Callee country code as a separate field, no `+` (e.g. `91`). */
  country_code: string;
  /** Per-lead WebSocket URL the carrier dials back (the bridge passes `wss://<our-host>/api/v1/webrtc-call/<callId>/pstn-stream?token=…`). */
  websocket_url: string;
  /** Per-lead lifecycle webhook (the bridge passes `https://<our-host>/api/v1/webhooks/voicelink/webrtc-status/<callId>?token=…`). */
  webhook_url: string;
}

/**
 * `POST /v1/add_lead` accepted response.
 */
export interface VoicelinkAddLeadResponse {
  status?: boolean;
  message?: string;
  data?: {
    outbound_queue_id?: number;
    bot_id?: number;
    reseller_id?: number;
    client_id?: number;
    carrier_id?: number;
  };
}

/**
 * Lifecycle webhook body POSTed to our `webhook_url`. `Content-Type:
 * application/json`, no signature header. `event` is one of
 * `call.initiated|call.ringing|call.answered|call.ended|call.failed|call.completed`.
 * `call.completed` is terminal in BOTH success and failure — read
 * `status`/`callStatus`/`hangupCause` to distinguish.
 *
 * TWO shapes exist and both must be accepted (see `normalizeVoicelinkWebhook`):
 *  - NESTED (observed live 2026-07-11): the
 *    call fields live under `call: {...}` (`call.id`, `call.callStatus`,
 *    `call.durationSec`, `call.recordingUrl`, …).
 *  - FLAT (VoiceLink's published docs, docs.html#ws-webhook-hangup): the same
 *    fields are at the TOP LEVEL (`callId`, `callStatus`, `duration`,
 *    `recordingUrl`, `fromNumber`/`toNumber`).
 * The parser normalizes both into one internal structure so a carrier/account/
 * version that emits the documented flat shape doesn't silently classify a
 * successful call as an error or drop the recording URL / real call id.
 */
export interface VoicelinkWebhookBody {
  event?: string;
  timestamp?: string;
  call?: VoicelinkWebhookCall;
  legs?: Array<Record<string, unknown>>;
  // Flat (documented) fields — present when the payload is NOT nested under `call`.
  callId?: string;
  callStatus?: string;
  status?: string;
  direction?: string;
  duration?: number;
  durationSec?: number;
  recordingUrl?: string;
  hangupCause?: string;
  hangupReason?: string;
  sipStatus?: string;
  answeredAt?: string;
  endedAt?: string;
  fromNumber?: string;
  toNumber?: string;
  [key: string]: unknown;
}

export interface VoicelinkWebhookCall {
  id?: string;
  direction?: string;
  callType?: string;
  from?: string;
  to?: string;
  status?: string;
  hangupCause?: string;
  startedAt?: string;
  ringingAt?: string;
  answeredAt?: string;
  endedAt?: string;
  ringDurationSec?: number;
  durationSec?: number;
  sipStatus?: string;
  callStatus?: string;
  hangupReason?: string;
  recordingUrl?: string;
  customParameters?: {
    overrideWsUrl?: string;
    overrideWebhookUrl?: string;
    outboundQueueId?: number | string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * `GET /v1/call-log/details?call_id=<id>` CDR response.
 */
export interface VoicelinkCdrResponse {
  data?: {
    call_id?: string;
    unique_id?: string;
    call_status?: string;
    call_duration?: number;
    talk_duration?: number;
    hangup_reason?: string;
    bot_type?: number;
    bot_id?: number;
    recording_url?: string;
    total_cost?: number;
    currency_symbol?: string;
    [key: string]: unknown;
  };
}

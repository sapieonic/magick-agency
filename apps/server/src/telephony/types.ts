// PORT NOTE (magick-agency): ported from core src/telephony/types.ts@4850d1d9. Modified:
// kept only what the VoiceLink adapter, its webhook normaliser and the WebRTC bridge
// use. Deleted: `OutboundCallRequest.sipTrunkId`/`sipAuthUsername`/`sipAuthPassword`
// (SIP not carried); REST recording (`StartRecordingRequest`,
// `RestRecordingCapableProvider`, `supportsRestRecording`); live transfer
// (`TransferTarget`, `TransferCallRequest`, `TransferResponseParams`,
// `TransferConfirmResponseParams`, `TransferOutcomeResponseParams`,
// `TransferCapableProvider`, `supportsTransfer`); screened queue transfer
// (`TransferLegRequest`, `QueueEnqueueParams`, `QueueWaitParams`,
// `QueueDequeueParams`, `ScreenedQueueTransferProvider`, `QueueDeleteResult`,
// `TransferLegOutcomeUnknownError`, `supportsScreenedQueueTransfer`) — all AI
// escalation, not carried. Doc comments on what is kept are verbatim (some still
// name deleted types/providers).
export interface OutboundCallRequest {
  callId: string;
  to: string;
  from: string;
  webhookUrl: string;
  statusCallbackUrl: string;
  /**
   * Explicit media-stream WebSocket URL for providers that bake the stream URL
   * into the dial request (rather than delivering it via answer XML). Set by the
   * WebRTC bridge so a VoiceLink leg streams to the bridge's dedicated
   * `/webrtc-call/:id/pstn-stream` endpoint instead of the default AI
   * `/media-stream/:id` route. Ignored by providers that stream via answer XML
   * (e.g. VoBiz).
   */
  mediaStreamUrl?: string;
  maxDuration: number;
  machineDetection?: boolean;
  enableRecording?: boolean;
  headers?: Record<string, string>;
}

/**
 * What a carrier hands back at dial time.
 *
 * The two ids are deliberately separate because not every carrier can name the
 * CALL at dial time. Plivo's create-call returns only a `request_uuid` — the
 * `call_uuid` that every subsequent operation (hangup, CDR, transfer, record)
 * requires does not exist until the call connects and reaches us on a webhook.
 * Collapsing the two would put a request id in a slot the hangup URL builds
 * from, and Plivo documents that a hangup with no call id disconnects EVERY
 * ongoing call on the account — so the distinction is a safety property, not
 * bookkeeping.
 */
export interface InitiateCallResult {
  /**
   * Carrier id for the CALL itself. Empty string when the provider cannot
   * supply one at dial time; the first webhook backfills it (CallManager only
   * writes `provider_call_id` while it is still unset, so an empty string here
   * is what lets that backfill fire).
   */
  providerCallId: string;
  /**
   * Provider id for the dial REQUEST, when the carrier distinguishes it from
   * the call id. Plivo: `request_uuid` — the only handle that exists before the
   * call connects, and the only id `DELETE /Request/{uuid}/` accepts.
   */
  providerRequestId?: string;
}

export interface AnswerResponseOptions {
  enableRecording?: boolean;
  recordingCallbackUrl?: string;
  /**
   * Max recording length in seconds. Defaults to a provider-internal cap; pass the
   * call's max-duration so long calls (e.g. WebRTC human bridges up to several
   * hours) aren't silently truncated mid-recording.
   */
  recordingMaxLengthSeconds?: number;
}

export interface CallEvent {
  providerCallId: string;
  callId: string;
  /**
   * The carrier that sent this event, when the parser knows it (VoBiz, Plivo,
   * Twilio and Exotel stamp it). Optional: absent means "unknown", and readers
   * must treat it so — it only lets a hot path skip work that cannot apply.
   */
  provider?: string;
  eventType: 'answer' | 'hangup' | 'ringing' | 'machine' | 'dtmf' | 'error';
  timestamp: Date;
  metadata: Record<string, unknown>;
  direction?: 'inbound' | 'outbound';
}

export interface ProviderCallStatus {
  status: string;           // Provider-native status (e.g. 'completed', 'failed', 'busy', 'no-answer')
  duration?: number;        // Call duration in seconds
  errorCode?: string;
  errorMessage?: string;
}

export interface AnnouncementResponseParams {
  type: 'tts' | 'audio';
  text?: string;
  audioUrl?: string;
  voice?: string;
  language?: string;
}

// ─── IVR-specific types ──────────────────────────────────────────────────

export interface IvrGatherParams {
  prompt?: string;
  audioUrl?: string;
  voice?: string;
  language?: string;
  numDigits: number;
  timeoutSeconds: number;
  finishOnKey?: string;
  actionUrl: string;
}

export interface IvrPlayParams {
  text?: string;
  audioUrl?: string;
  voice?: string;
  language?: string;
  loop?: number;
}

export interface IvrHangupParams {
  message?: string;
  voice?: string;
  language?: string;
}

export type IvrStepRenderParams =
  | { type: 'gather'; params: IvrGatherParams; noInputUrl: string }
  | { type: 'play'; params: IvrPlayParams; redirectUrl: string }
  | { type: 'hangup'; params: IvrHangupParams }
  | { type: 'redirect'; url: string };

// ─── Provider capabilities ───────────────────────────────────────────────

/**
 * Carrier facts a caller cannot infer from the interface, declared per adapter.
 *
 * Same posture as {@link TransferCapableProvider}: a question about what the
 * carrier can actually do belongs on the adapter that knows the answer, not in a
 * `provider === 'voicelink'` branch inside a caller. The difference is that a
 * capability here is a **property of an operation that every adapter already
 * implements**, so it cannot be expressed as an optional method — `endCall`
 * exists on all eight, and on some of them it does nothing.
 */
export interface ProviderCapabilities {
  /**
   * Whether `endCall` tears down a leg the far end has NOT answered yet.
   *
   * False for an adapter whose `endCall` is a no-op or a throw, and for one
   * whose hangup needs an id the carrier only reveals after the answer. A false
   * here means a locally-initiated teardown during ring **leaves the customer's
   * phone ringing** with no lever to recall it: the pilot on 2026-09-08 dialled,
   * the agent dismissed the ringing call at +5.4s, and the customer answered into
   * a console nobody was watching (callId `064836f1-8915-49f8-9c5a-c741f3cdd2af`).
   */
  readonly cancelRinging: boolean;
  /**
   * Whether `initiateCall` only QUEUES the lead at the carrier rather than
   * dialling it. VoiceLink's `add_lead` appends to the bot's outbound queue and
   * returns an `outbound_queue_id`; the carrier dials when a channel frees up,
   * which under load is minutes later. A true here means no deadline may be
   * anchored on dispatch as though the phone were already ringing: callers give
   * such a call `QUEUED_DIAL_PICKUP_TIMEOUT_SECONDS` to be picked up, then run
   * their ordinary cap from answer.
   *
   * Optional and false when absent: every other adapter's create-call request
   * places the call, so absence keeps today's dispatch-anchored behaviour.
   */
  readonly queuesOutboundDials?: boolean;
}

/**
 * Fail-closed read of {@link ProviderCapabilities.cancelRinging}.
 *
 * An adapter that has not answered the question is treated as **unable** to
 * cancel, because the two ways of being wrong are not symmetric: assume it can
 * and a real customer's phone rings with nobody behind it, assume it cannot and
 * we log a warning we did not need.
 */
export function canCancelRinging(provider: Pick<TelephonyProvider, 'capabilities'>): boolean {
  return provider.capabilities?.cancelRinging === true;
}

/** Read of {@link ProviderCapabilities.queuesOutboundDials}; false when undeclared. */
export function queuesOutboundDials(provider: Pick<TelephonyProvider, 'capabilities'>): boolean {
  return provider.capabilities?.queuesOutboundDials === true;
}

// ─── Provider interface ──────────────────────────────────────────────────

export interface TelephonyProvider {
  readonly name: string;
  /**
   * Carrier facts about this adapter's own operations. See
   * {@link ProviderCapabilities}.
   *
   * **Optional, and that is a deliberate trade-off rather than an oversight.**
   * 101 test files reference `TelephonyProvider`, most through hand-written stub
   * objects, so making this required would churn every one of them and the churn
   * would be the whole diff. The cost is that a new adapter forgetting to declare
   * it compiles: the omission is caught by a test over the adapter registry
   * (`test/unit/telephony/provider-capabilities.test.ts`) instead of by `tsc`,
   * and `canCancelRinging` fails closed in the meantime.
   */
  readonly capabilities?: ProviderCapabilities;
  initiateCall(req: OutboundCallRequest): Promise<InitiateCallResult>;
  endCall(providerCallId: string): Promise<void>;
  getMediaStreamConfig(providerCallId: string): Promise<MediaStreamConfig>;
  parseWebhookEvent(rawBody: unknown, headers: Record<string, string>): CallEvent;
  generateAnswerResponse(callId: string, streamUrl: string, options?: AnswerResponseOptions): string;
  generateAnnouncementResponse(params: AnnouncementResponseParams): string;
  generateIvrResponse(steps: IvrStepRenderParams[]): string;
  getCallStatus(providerCallId: string): Promise<ProviderCallStatus>;
  getRecordingUrl(providerCallId: string): Promise<string | null>;
  validateWebhookSignature(rawBody: string, signature: string): boolean;
}

export interface MediaStreamConfig {
  type: 'websocket' | 'rtp';
  url?: string;
  rtpHost?: string;
  rtpPort?: number;
  codec: 'pcmu' | 'pcma' | 'opus' | 'pcm16';
  sampleRate: number;
  direction: 'both' | 'send' | 'receive';
}

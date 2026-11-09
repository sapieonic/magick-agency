// docs/seams.md (the WebRtcBridgeManager seam). The dialer runtime calls the
// bridge through exactly these members, with these signatures. Every assertion below is
// checked by `tsc` (`pnpm lint` typechecks tests): changing a member's signature, dropping
// one, or changing one of the exported types makes this file fail to compile. The runtime
// assertions only make Vitest report the file.
import { describe, it, expect, expectTypeOf, vi } from 'vitest';
import type WebSocket from 'ws';
import type { WebRtcCallRecord, WebRtcCallStatus } from '@magick-agency/db/models/agency-call.model';

vi.mock('../../../src/config/index.js', () => ({
  config: { redis: { keyPrefix: '' }, telephony: { voicelink: { webhookBaseUrl: 'https://x.test/api/v1/webhooks/voicelink' } } },
}));

import {
  WebRtcBridgeManager,
  WebRtcCallError,
  type WebRtcOutboundParams,
  type WebRtcBridgedCallParams,
  type WebRtcCallCorrelation,
  type WebRtcLifecycleEvent,
  type WebRtcLifecycleListener,
  type WebRtcRejectReason,
  type WebRtcInboundCallParams,
  type WebRtcInboundAcceptance,
  type ClipSequenceResult,
  type InboundHoldOptions,
  type InboundHoldResult,
  type InboundRecordOptions,
  type InboundAudioRecording,
} from '../../../src/core/webrtc-bridge-manager.js';
import {
  browserLegMediaFormatOf,
  setBrowserLegMediaFormat,
  type BrowserLegMediaFormat,
} from '../../../src/core/bridge/browser-leg-media.js';
import type { AgencyStationMediaFormat } from '@magick-agency/contracts/agency';

/** The seam member list. */
interface BridgeSeam {
  onLifecycle(listener: WebRtcLifecycleListener): () => void;
  createBridgedCall(params: WebRtcBridgedCallParams): Promise<WebRtcCallRecord>;
  createUnboundBridgedCall(params: Omit<WebRtcBridgedCallParams, 'browserSocket'>): Promise<WebRtcCallRecord>;
  bindBorrowedBrowserLeg(correlationId: string, ws: WebSocket): boolean;
  reattachBorrowedBrowserLeg(correlationId: string, ws: WebSocket): boolean;
  forceEndWithOutcome(correlationId: string, outcome: string): Promise<boolean>;
  playClipToCarrierThenHangUp(correlationId: string,
    opts: { clipHash: string; outcome: string; status?: WebRtcCallStatus }): Promise<boolean>;
  getActiveCallIds(): string[];
  gracefulShutdown(): Promise<void>;
  /** Inbound calls (docs/inbound.md §3): the answer webhook's leg taken in, and its messages played. */
  acceptInboundCall(params: CoreInboundCallParams): Promise<CoreInboundAcceptance>;
  playClipSequenceThenHangUp(correlationId: string,
    opts: { clipHashes: readonly string[]; outcome: string }): Promise<CoreClipSequenceResult>;
  /** Connecting inbound callers (docs/inbound.md §5, P2): the hold, its stop, and a voicemail's recording. */
  playInboundHold(correlationId: string, opts: CoreInboundHoldOptions): Promise<CoreInboundHoldResult>;
  stopInboundHold(correlationId: string): void;
  recordInboundAudio(correlationId: string, opts: CoreInboundRecordOptions): Promise<CoreInboundAudioRecording>;
}

/** The bridge's exported types (`sipConnectionId` is excluded: docs/seams.md allows it, SIP is out). */
interface CoreOutboundParams {
  tenantId: string;
  accountId: string;
  callerId: string;
  destinationPhone: string;
  provider?: string;
  /** The tenant carrier credential to dial on; null/absent = the service's own account. */
  telephonyCredentialId?: string | null;
  initiatedBy?: string | null;
  metadata?: Record<string, unknown>;
  record?: boolean;
  analysisProfileId?: string | null;
  analysisLanguage?: string | null;
  analysisConsent?: boolean | null;
}
/** What a leg belongs to: a campaign attempt, or a soft-phone call (docs/softphone.md §4.3). */
type CoreCallCorrelation =
  | { kind: 'attempt'; campaignId: string; agencyAttemptId: string }
  | { kind: 'manual'; manualCallId: string };
interface CoreBridgedCallParams extends CoreOutboundParams {
  browserSocket: WebSocket;
  correlation: CoreCallCorrelation;
  browserCloseGraceMs?: number;
}
interface CoreLifecycleEvent {
  callId: string;
  correlationId?: string | null;
  phase: 'answered' | 'bridged' | 'ended';
  status?: WebRtcCallStatus;
  outcome?: string;
  errorCode?: string;
  errorMessage?: string;
  answered: boolean;
  answeredAt?: Date;
  talkTimeSeconds?: number;
}
interface CoreInboundCallParams {
  callId: string;
  correlationId: string;
  tenantId: string;
  accountId: string;
  provider: string;
  telephonyCredentialId: string | null;
  callerId: string;
  destinationPhone: string;
  carrierCallId: string;
  takeSlots: boolean;
  connectable: boolean;
  browserCloseGraceMs: number;
  parkedSeconds: number;
  record: boolean;
}
interface CoreInboundHoldOptions {
  preambleClipHashes: readonly string[];
  holdClipHash: string | null;
}
type CoreInboundHoldResult = 'released' | 'aborted' | 'no_media' | 'not_found';
interface CoreInboundRecordOptions {
  maxSeconds: number;
  promptClipHashes?: readonly string[];
  beep?: boolean;
}
interface CoreInboundAudioRecording {
  result: 'completed' | 'caller_left' | 'no_media' | 'not_found';
  pcm16: Buffer;
  sampleRate: number;
  seconds: number;
}
type CoreInboundAcceptance =
  | { accepted: true; streamUrl: string; maxDurationSeconds: number; capacity: 'admitted' | 'account_full' | 'no_capacity' | 'not_requested' }
  | { accepted: false; reason: 'stream_unavailable' | 'ended' };
type CoreClipSequenceResult = 'completed' | 'aborted' | 'no_media' | 'not_found';
type CoreRejectReason =
  | 'global_concurrency_limit'
  | 'account_concurrency_limit'
  | 'provider_concurrency_limit'
  | 'provider_concurrency_unavailable'
  | 'telephony_init_failed'
  | 'station_socket_unavailable'
  | 'telephony_credential_unavailable'
  | 'carrier_rate_limited'
  | 'carrier_auth_rejected'
  | 'carrier_dial_not_sent';

describe('WebRtcBridgeManager — the docs/seams.md seam (type-level)', () => {
  it('has exactly the seam member signatures', () => {
    expectTypeOf<WebRtcBridgeManager['onLifecycle']>().toEqualTypeOf<BridgeSeam['onLifecycle']>();
    expectTypeOf<WebRtcBridgeManager['createBridgedCall']>().toEqualTypeOf<BridgeSeam['createBridgedCall']>();
    expectTypeOf<WebRtcBridgeManager['createUnboundBridgedCall']>().toEqualTypeOf<BridgeSeam['createUnboundBridgedCall']>();
    expectTypeOf<WebRtcBridgeManager['bindBorrowedBrowserLeg']>().toEqualTypeOf<BridgeSeam['bindBorrowedBrowserLeg']>();
    expectTypeOf<WebRtcBridgeManager['reattachBorrowedBrowserLeg']>().toEqualTypeOf<BridgeSeam['reattachBorrowedBrowserLeg']>();
    expectTypeOf<WebRtcBridgeManager['forceEndWithOutcome']>().toEqualTypeOf<BridgeSeam['forceEndWithOutcome']>();
    expectTypeOf<WebRtcBridgeManager['playClipToCarrierThenHangUp']>().toEqualTypeOf<BridgeSeam['playClipToCarrierThenHangUp']>();
    expectTypeOf<WebRtcBridgeManager['getActiveCallIds']>().toEqualTypeOf<BridgeSeam['getActiveCallIds']>();
    expectTypeOf<WebRtcBridgeManager['gracefulShutdown']>().toEqualTypeOf<BridgeSeam['gracefulShutdown']>();
    expectTypeOf<WebRtcBridgeManager['acceptInboundCall']>().toEqualTypeOf<BridgeSeam['acceptInboundCall']>();
    expectTypeOf<WebRtcBridgeManager['playClipSequenceThenHangUp']>().toEqualTypeOf<BridgeSeam['playClipSequenceThenHangUp']>();
    expectTypeOf<WebRtcBridgeManager['playInboundHold']>().toEqualTypeOf<BridgeSeam['playInboundHold']>();
    expectTypeOf<WebRtcBridgeManager['stopInboundHold']>().toEqualTypeOf<BridgeSeam['stopInboundHold']>();
    expectTypeOf<WebRtcBridgeManager['recordInboundAudio']>().toEqualTypeOf<BridgeSeam['recordInboundAudio']>();
    // And the class as a whole satisfies the interface.
    expectTypeOf<WebRtcBridgeManager>().toMatchTypeOf<BridgeSeam>();
    expect(true).toBe(true);
  });

  it('keeps the exported types', () => {
    expectTypeOf<WebRtcOutboundParams>().toEqualTypeOf<CoreOutboundParams>();
    expectTypeOf<Omit<WebRtcBridgedCallParams, keyof CoreOutboundParams>>()
      .toEqualTypeOf<Omit<CoreBridgedCallParams, keyof CoreOutboundParams>>();
    expectTypeOf<WebRtcCallCorrelation>().toEqualTypeOf<CoreCallCorrelation>();
    expectTypeOf<WebRtcLifecycleEvent>().toEqualTypeOf<CoreLifecycleEvent>();
    expectTypeOf<WebRtcLifecycleListener>().toEqualTypeOf<(event: CoreLifecycleEvent) => void>();
    expectTypeOf<WebRtcRejectReason>().toEqualTypeOf<CoreRejectReason>();
    expectTypeOf<WebRtcInboundCallParams>().toEqualTypeOf<CoreInboundCallParams>();
    expectTypeOf<WebRtcInboundAcceptance>().toEqualTypeOf<CoreInboundAcceptance>();
    expectTypeOf<ClipSequenceResult>().toEqualTypeOf<CoreClipSequenceResult>();
    expectTypeOf<InboundHoldOptions>().toEqualTypeOf<CoreInboundHoldOptions>();
    expectTypeOf<InboundHoldResult>().toEqualTypeOf<CoreInboundHoldResult>();
    expectTypeOf<InboundRecordOptions>().toEqualTypeOf<CoreInboundRecordOptions>();
    expectTypeOf<InboundAudioRecording>().toEqualTypeOf<CoreInboundAudioRecording>();
    expect(true).toBe(true);
  });

  it('keeps the browser leg media-format tag (the station socket names its format; every attach reads it)', () => {
    // The format travels on the socket, not as a parameter of the members above: the
    // station handler tags the socket at upgrade, and createBridgedCall / bind / re-attach
    // read the tag of the socket they are handed (docs/seams.md §3.1).
    expectTypeOf(setBrowserLegMediaFormat).toEqualTypeOf<(ws: WebSocket, format: AgencyStationMediaFormat) => void>();
    expectTypeOf(browserLegMediaFormatOf).toEqualTypeOf<(ws: WebSocket) => AgencyStationMediaFormat>();
    expectTypeOf<BrowserLegMediaFormat>().toEqualTypeOf<AgencyStationMediaFormat>();
    expect(true).toBe(true);
  });

  it('keeps WebRtcCallError unchanged (:75)', () => {
    expectTypeOf<ConstructorParameters<typeof WebRtcCallError>>()
      .toEqualTypeOf<[message: string, code: WebRtcRejectReason, statusCode: number]>();
    const err = new WebRtcCallError('Station socket is not open', 'station_socket_unavailable', 409);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('WebRtcCallError');
    expect(err.code).toBe('station_socket_unavailable');
    expect(err.statusCode).toBe(409);
  });
});

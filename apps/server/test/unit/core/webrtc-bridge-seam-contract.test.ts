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
  type WebRtcLifecycleEvent,
  type WebRtcLifecycleListener,
  type WebRtcRejectReason,
} from '../../../src/core/webrtc-bridge-manager.js';

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
}

/** The bridge's exported types (`sipConnectionId` is excluded: docs/seams.md allows it, SIP is out). */
interface CoreOutboundParams {
  tenantId: string;
  accountId: string;
  callerId: string;
  destinationPhone: string;
  provider?: string;
  initiatedBy?: string | null;
  metadata?: Record<string, unknown>;
  record?: boolean;
  analysisProfileId?: string | null;
  analysisLanguage?: string | null;
  analysisConsent?: boolean | null;
}
interface CoreBridgedCallParams extends CoreOutboundParams {
  browserSocket: WebSocket;
  campaignId: string;
  agencyAttemptId: string;
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
type CoreRejectReason =
  | 'global_concurrency_limit'
  | 'account_concurrency_limit'
  | 'provider_concurrency_limit'
  | 'provider_concurrency_unavailable'
  | 'telephony_init_failed'
  | 'station_socket_unavailable';

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
    // And the class as a whole satisfies the interface.
    expectTypeOf<WebRtcBridgeManager>().toMatchTypeOf<BridgeSeam>();
    expect(true).toBe(true);
  });

  it('keeps the exported types', () => {
    expectTypeOf<WebRtcOutboundParams>().toEqualTypeOf<CoreOutboundParams>();
    expectTypeOf<Omit<WebRtcBridgedCallParams, keyof CoreOutboundParams>>()
      .toEqualTypeOf<Omit<CoreBridgedCallParams, keyof CoreOutboundParams>>();
    expectTypeOf<WebRtcLifecycleEvent>().toEqualTypeOf<CoreLifecycleEvent>();
    expectTypeOf<WebRtcLifecycleListener>().toEqualTypeOf<(event: CoreLifecycleEvent) => void>();
    expectTypeOf<WebRtcRejectReason>().toEqualTypeOf<CoreRejectReason>();
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

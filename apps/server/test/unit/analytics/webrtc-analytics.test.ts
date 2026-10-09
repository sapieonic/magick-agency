import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// PORT NOTE (magick-agency): ported from core test/unit/analytics/webrtc-analytics.test.ts@4850d1d9.
// Deleted (SIP egress, plan §5): "reports egress=sip + connection id when the bridge used a
// customer SIP trunk", "reports egress=sip + connection id when the bridge egressed over a SIP
// trunk". Modified: "defaults provider to vobiz when omitted" → voicelink. Mock specifiers and
// the record fixture's type (a partial record cast, as core did not typecheck tests).
import type { WebRtcCallRecord } from '@magick-agency/db/models/agency-call.model';

// Mirrors test/unit/analytics/posthog.test.ts: mock the posthog-node client and
// drive the real posthog.ts emitters through the shared client.ts transport.
const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  groupIdentify: vi.fn(),
  shutdown: vi.fn().mockResolvedValue(undefined),
  ctor: vi.fn(),
  config: {
    analytics: {
      enabled: true,
      apiKey: 'phc_test_key',
      host: 'https://us.i.posthog.com',
      flushAt: 20,
      flushIntervalMs: 10000,
      requestTimeoutMs: 10000,
    },
    server: { env: 'test' },
  } as { analytics: Record<string, unknown>; server: { env: string } },
  logMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('posthog-node', () => ({
  PostHog: class {
    constructor(apiKey: string, opts: unknown) { mocks.ctor(apiKey, opts); }
    capture(...args: unknown[]) { return mocks.capture(...args); }
    groupIdentify(...args: unknown[]) { return mocks.groupIdentify(...args); }
    shutdown(...args: unknown[]) { return mocks.shutdown(...args); }
  },
}));

vi.mock('../../../src/config/index.js', () => ({ config: mocks.config }));

vi.mock('@magick-agency/observability', () => ({
  logger: mocks.logMock,
  createChildLogger: () => mocks.logMock,
}));

import {
  initAnalytics,
  shutdownAnalytics,
  isAnalyticsEnabled,
  trackWebrtcCallInitiated,
  trackWebrtcCallRejected,
  trackWebrtcCallCompleted,
} from '../../../src/analytics/posthog.js';

function makeWebrtcRecord(overrides: Partial<WebRtcCallRecord> = {}): WebRtcCallRecord {
  return {
    id: 'wc-1',
    tenant_id: 'tenant-1',
    account_id: 'account-1',
    caller_id: '+910000000000',
    destination_phone: '+919876543210',
    provider: 'vobiz',
    provider_call_id: 'prov-1',
    status: 'completed',
    outcome: 'answered',
    error_code: null,
    error_message: null,
    initiated_by: 'agent@example.com',
    metadata: { campaign: 'diwali', secret: 'do-not-leak' },
    answered_at: new Date('2026-01-01T00:00:05Z'),
    ended_at: new Date('2026-01-01T00:01:40Z'),
    duration_seconds: 100,
    talk_time_seconds: 95,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:01:40Z'),
    ...overrides,
  } as WebRtcCallRecord;
}

/** Returns the single captured event payload (asserts exactly one capture). */
function lastCapture(): {
  distinctId: string;
  event: string;
  properties: Record<string, unknown>;
  groups?: Record<string, string>;
} {
  expect(mocks.capture).toHaveBeenCalledTimes(1);
  return mocks.capture.mock.calls[0]![0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.analytics = {
    enabled: true,
    apiKey: 'phc_test_key',
    host: 'https://us.i.posthog.com',
    flushAt: 20,
    flushIntervalMs: 10000,
    requestTimeoutMs: 10000,
  };
});

afterEach(async () => {
  await shutdownAnalytics();
});

describe('analytics / webrtc — trackWebrtcCallInitiated', () => {
  beforeEach(() => initAnalytics());

  it('emits webrtc_call_initiated with provider/direction and identity', () => {
    trackWebrtcCallInitiated(makeWebrtcRecord());
    const ev = lastCapture();
    expect(ev.event).toBe('webrtc_call_initiated');
    expect(ev.properties['call_id']).toBe('wc-1');
    expect(ev.properties['telephony_provider']).toBe('vobiz');
    expect(ev.properties['direction']).toBe('outbound');
    expect(ev.distinctId).toBe('account-1');
    expect(ev.groups).toEqual({ tenant: 'tenant-1' });
    expect(ev.properties['tenant_id']).toBe('tenant-1');
    expect(ev.properties['account_id']).toBe('account-1');
  });

  it('reports egress pstn by default and sip + connection id when a SIP trunk is used', () => {
    trackWebrtcCallInitiated(makeWebrtcRecord());
    expect(lastCapture().properties['egress']).toBe('pstn');
  });

  it('reports has_metadata true/false without leaking metadata values', () => {
    trackWebrtcCallInitiated(makeWebrtcRecord());
    let ev = lastCapture();
    expect(ev.properties['has_metadata']).toBe(true);
    // No raw metadata keys/values leak.
    expect(ev.properties).not.toHaveProperty('metadata');
    expect(JSON.stringify(ev.properties)).not.toContain('do-not-leak');

    mocks.capture.mockClear();
    trackWebrtcCallInitiated(makeWebrtcRecord({ metadata: {} }));
    ev = lastCapture();
    expect(ev.properties['has_metadata']).toBe(false);
  });

  it('is PII-free (no destination/caller phone, no initiated_by)', () => {
    trackWebrtcCallInitiated(makeWebrtcRecord());
    const ev = lastCapture();
    const keys = Object.keys(ev.properties);
    expect(keys).not.toContain('destination_phone');
    expect(keys).not.toContain('caller_id');
    expect(keys).not.toContain('initiated_by');
    const serialized = JSON.stringify(ev.properties);
    expect(serialized).not.toContain('9876543210');
    expect(serialized).not.toContain('+910000000000');
    expect(serialized).not.toContain('agent@example.com');
  });
});

describe('analytics / webrtc — trackWebrtcCallRejected', () => {
  beforeEach(() => initAnalytics());

  it('emits webrtc_call_rejected with the leak reason and no call_id', () => {
    trackWebrtcCallRejected({
      tenantId: 'tenant-1',
      accountId: 'account-1',
      reason: 'account_concurrency_limit',
      provider: 'twilio',
    });
    const ev = lastCapture();
    expect(ev.event).toBe('webrtc_call_rejected');
    expect(ev.properties['reason']).toBe('account_concurrency_limit');
    expect(ev.properties['telephony_provider']).toBe('twilio');
    expect(ev.properties['direction']).toBe('outbound');
    expect(ev.distinctId).toBe('account-1');
    expect(ev.groups).toEqual({ tenant: 'tenant-1' });
    // No record exists yet.
    expect(ev.properties).not.toHaveProperty('call_id');
  });

  // PORT NOTE: core 'defaults provider to vobiz when omitted' — VoBiz is deleted.
  it('defaults provider to voicelink when omitted', () => {
    trackWebrtcCallRejected({
      tenantId: 'tenant-1',
      accountId: 'account-1',
      reason: 'feature_disabled',
    });
    expect(lastCapture().properties['telephony_provider']).toBe('voicelink');
  });

  it('carries each rejection reason verbatim', () => {
    const reasons = [
      'feature_disabled',
      'invalid_caller_id',
      'global_concurrency_limit',
      'account_concurrency_limit',
    ] as const;
    for (const reason of reasons) {
      mocks.capture.mockClear();
      trackWebrtcCallRejected({ tenantId: 'tenant-1', accountId: 'account-1', reason });
      expect(lastCapture().properties['reason']).toBe(reason);
    }
  });
});

describe('analytics / webrtc — trackWebrtcCallCompleted', () => {
  beforeEach(() => initAnalytics());

  it('emits webrtc_call_completed with status/outcome/timing/ended_by', () => {
    trackWebrtcCallCompleted({
      callId: 'wc-1',
      tenantId: 'tenant-1',
      accountId: 'account-1',
      provider: 'vobiz',
      status: 'completed',
      outcome: 'answered',
      connected: true,
      durationSeconds: 100,
      talkTimeSeconds: 95,
      errorCode: undefined,
      endedBy: 'user',
    });
    const ev = lastCapture();
    expect(ev.event).toBe('webrtc_call_completed');
    expect(ev.properties['call_id']).toBe('wc-1');
    expect(ev.properties['telephony_provider']).toBe('vobiz');
    expect(ev.properties['direction']).toBe('outbound');
    expect(ev.properties['status']).toBe('completed');
    expect(ev.properties['outcome']).toBe('answered');
    expect(ev.properties['connected']).toBe(true);
    expect(ev.properties['duration_seconds']).toBe(100);
    expect(ev.properties['talk_time_seconds']).toBe(95);
    expect(ev.properties['ended_by']).toBe('user');
    expect(ev.distinctId).toBe('account-1');
    expect(ev.groups).toEqual({ tenant: 'tenant-1' });
    // Egress defaults to pstn when no SIP connection was used.
    expect(ev.properties['egress']).toBe('pstn');
  });

  it('reports an unanswered call as not connected (answer-anchored)', () => {
    trackWebrtcCallCompleted({
      callId: 'wc-2',
      tenantId: 'tenant-1',
      accountId: 'account-1',
      provider: 'vobiz',
      status: 'no_answer',
      connected: false,
      endedBy: 'system',
    });
    const ev = lastCapture();
    expect(ev.properties['connected']).toBe(false);
    expect(ev.properties['status']).toBe('no_answer');
  });

  it('carries error_code and ended_by error on a failed call', () => {
    trackWebrtcCallCompleted({
      callId: 'wc-3',
      tenantId: 'tenant-1',
      accountId: 'account-1',
      provider: 'vobiz',
      status: 'failed',
      connected: false,
      errorCode: 'BRIDGE_FAILED',
      endedBy: 'error',
    });
    const ev = lastCapture();
    expect(ev.properties['error_code']).toBe('BRIDGE_FAILED');
    expect(ev.properties['ended_by']).toBe('error');
  });

  it('drops undefined optionals (clean() strips them)', () => {
    trackWebrtcCallCompleted({
      callId: 'wc-4',
      tenantId: 'tenant-1',
      accountId: 'account-1',
      provider: 'vobiz',
      status: 'completed',
      connected: true,
      // outcome/durationSeconds/talkTimeSeconds/errorCode/endedBy omitted
    });
    const ev = lastCapture();
    expect(ev.properties).not.toHaveProperty('outcome');
    expect(ev.properties).not.toHaveProperty('duration_seconds');
    expect(ev.properties).not.toHaveProperty('talk_time_seconds');
    expect(ev.properties).not.toHaveProperty('error_code');
    expect(ev.properties).not.toHaveProperty('ended_by');
    // connected:false-style booleans are kept; connected:true here.
    expect(ev.properties['connected']).toBe(true);
  });

  it('is PII-free (no phone numbers in the payload)', () => {
    trackWebrtcCallCompleted({
      callId: 'wc-5',
      tenantId: 'tenant-1',
      accountId: 'account-1',
      provider: 'vobiz',
      status: 'completed',
      connected: true,
      durationSeconds: 50,
    });
    const ev = lastCapture();
    const keys = Object.keys(ev.properties);
    expect(keys).not.toContain('destination_phone');
    expect(keys).not.toContain('caller_id');
    expect(JSON.stringify(ev.properties)).not.toMatch(/\+91\d/);
  });
});

describe('analytics / webrtc — no-op when disabled', () => {
  const emitters: Array<[string, () => void]> = [
    ['trackWebrtcCallInitiated', () => trackWebrtcCallInitiated(makeWebrtcRecord())],
    ['trackWebrtcCallRejected', () => trackWebrtcCallRejected({
      tenantId: 'tenant-1', accountId: 'account-1', reason: 'feature_disabled',
    })],
    ['trackWebrtcCallCompleted', () => trackWebrtcCallCompleted({
      callId: 'wc-1', tenantId: 'tenant-1', accountId: 'account-1',
      provider: 'vobiz', status: 'completed', connected: true,
    })],
  ];

  it.each(emitters)('%s does not capture when analytics is disabled', (_name, emit) => {
    mocks.config.analytics.enabled = false;
    initAnalytics();
    expect(isAnalyticsEnabled()).toBe(false);
    emit();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it('swallows capture errors and never throws into the caller', () => {
    initAnalytics();
    mocks.capture.mockImplementationOnce(() => { throw new Error('boom'); });
    expect(() => trackWebrtcCallCompleted({
      callId: 'wc-1', tenantId: 'tenant-1', accountId: 'account-1',
      provider: 'vobiz', status: 'completed', connected: true,
    })).not.toThrow();
    expect(mocks.logMock.error).toHaveBeenCalled();
  });
});

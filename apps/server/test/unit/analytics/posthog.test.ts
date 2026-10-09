import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// The "lifecycle", "identity & grouping" and "environment tagging" describes test the
// shared client transport, driven through the WebRTC trackers, the only emitters this
// module has.

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
    constructor(apiKey: string, opts: unknown) {
      mocks.ctor(apiKey, opts);
    }
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

import type { WebRtcCallRecord } from '@magick-agency/db/models/agency-call.model';
import {
  initAnalytics,
  shutdownAnalytics,
  isAnalyticsEnabled,
  trackWebrtcCallInitiated,
  trackWebrtcCallRejected,
  trackWebrtcCallCompleted,
} from '../../../src/analytics/posthog.js';

function makeWebrtcRecord(): WebRtcCallRecord {
  return {
    id: 'wc-1',
    tenant_id: 'tenant-1',
    account_id: 'account-1',
    provider: 'voicelink',
    metadata: {},
  } as unknown as WebRtcCallRecord;
}

/** Emits a completed-call event through the WebRTC tracker. */
function emitCompleted(): void {
  trackWebrtcCallCompleted({
    callId: 'wc-1', tenantId: 'tenant-1', accountId: 'account-1',
    provider: 'voicelink', status: 'completed', connected: true,
  });
}

/** Returns the single captured event payload (asserts exactly one capture). */
function lastCapture(): { distinctId: string; event: string; properties: Record<string, unknown>; groups?: Record<string, string> } {
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
  // Reset module-level client state between tests.
  await shutdownAnalytics();
});

describe('analytics / posthog — lifecycle', () => {
  it('is a no-op when disabled (no client, no capture)', () => {
    mocks.config.analytics.enabled = false;
    initAnalytics();
    expect(isAnalyticsEnabled()).toBe(false);
    expect(mocks.ctor).not.toHaveBeenCalled();

    emitCompleted();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it('stays disabled (and warns) when enabled but apiKey is missing', () => {
    mocks.config.analytics.enabled = true;
    mocks.config.analytics.apiKey = undefined;
    initAnalytics();
    expect(isAnalyticsEnabled()).toBe(false);
    expect(mocks.logMock.warn).toHaveBeenCalled();
  });

  it('constructs the client with configured options when enabled', () => {
    initAnalytics();
    expect(isAnalyticsEnabled()).toBe(true);
    expect(mocks.ctor).toHaveBeenCalledWith('phc_test_key', {
      host: 'https://us.i.posthog.com',
      flushAt: 20,
      flushInterval: 10000,
      requestTimeout: 10000,
    });
  });

  it('initAnalytics is idempotent (does not reconstruct)', () => {
    initAnalytics();
    initAnalytics();
    expect(mocks.ctor).toHaveBeenCalledTimes(1);
  });

  it('shutdownAnalytics flushes and disables', async () => {
    initAnalytics();
    expect(isAnalyticsEnabled()).toBe(true);
    await shutdownAnalytics();
    expect(mocks.shutdown).toHaveBeenCalledTimes(1);
    expect(isAnalyticsEnabled()).toBe(false);
  });

  it('swallows capture errors and never throws into the caller', () => {
    initAnalytics();
    mocks.capture.mockImplementationOnce(() => { throw new Error('boom'); });
    expect(() => emitCompleted()).not.toThrow();
    expect(mocks.logMock.error).toHaveBeenCalled();
  });
});

describe('analytics / posthog — identity & grouping', () => {
  beforeEach(() => initAnalytics());

  it('uses account_id as distinctId and tenant as the group', () => {
    trackWebrtcCallInitiated(makeWebrtcRecord());
    const ev = lastCapture();
    expect(ev.distinctId).toBe('account-1');
    expect(ev.groups).toEqual({ tenant: 'tenant-1' });
    expect(ev.properties['tenant_id']).toBe('tenant-1');
    expect(ev.properties['account_id']).toBe('account-1');
  });
});

describe('analytics / posthog — environment tagging', () => {
  it('tags every event with the configured POSTHOG_ENVIRONMENT', () => {
    mocks.config.analytics.environment = 'staging';
    initAnalytics();
    emitCompleted();
    expect(lastCapture().properties['environment']).toBe('staging');
  });

  it('falls back to NODE_ENV (config.server.env) when POSTHOG_ENVIRONMENT is unset', () => {
    // beforeEach leaves analytics.environment undefined; server.env is 'test'.
    initAnalytics();
    trackWebrtcCallRejected({ tenantId: 'tenant-1', accountId: 'account-1', reason: 'global_concurrency_limit' });
    expect(lastCapture().properties['environment']).toBe('test');
  });

  it('production and staging are distinguishable on the same event type', () => {
    mocks.config.analytics.environment = 'production';
    initAnalytics();
    trackWebrtcCallInitiated(makeWebrtcRecord());
    expect(lastCapture().properties['environment']).toBe('production');
  });
});

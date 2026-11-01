import { describe, it, expect, vi, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// The silent-station sweep's timer runs in the runtime's own async context.
//
// `wakeStationSweep` is first called from a station's upgrade request, and that request's
// `onRequest` hook (`client-log-context.ts`) seeds the ambient log context with
// `enterWith`: `client`, `clientVersion`, `clientPlatform`. A timer keeps the async context
// it was created in, so a sweep timer armed there stamped that one agent's app (and
// tenant) on every sweep log line for every station, for the life of the timer. The timer
// is armed under the context the runtime was built in instead (`AgencyRuntime.ownScope`).
//
// Real timers on purpose: fake timers call the callback from `advanceTimersByTime`, in the
// test's context, which would hide exactly what this pins. `setInterval` is only shortened.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/config/index.js', () => ({
  config: {
    redis: { keyPrefix: '' },
    masterService: { url: 'https://directory.test', s2sToken: 'tok' },
    telephony: { vobiz: { webhookBaseUrl: 'https://server.test/api/v1/webhooks/vobiz' } },
  },
}));
vi.mock('../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => ({ isEnabled: vi.fn().mockResolvedValue(true), getValue: vi.fn().mockResolvedValue(1800) }),
  FLAGS: { agency_dialer_enabled: { key: 'agency_dialer_enabled', default: false }, webrtc_max_duration_seconds: { default: 1800 } },
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyAttemptRepository: { findById: vi.fn(), setState: vi.fn().mockResolvedValue(null) },
  agencyCampaignRepository: { findById: vi.fn() },
  agencyContactRepository: { findById: vi.fn(), markState: vi.fn(), unclaim: vi.fn() },
  agencyAgentSessionRepository: { findById: vi.fn(), setState: vi.fn().mockResolvedValue(undefined), leave: vi.fn() },
}));
vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({
  accountSettingsRepository: { getAllowRecording: vi.fn().mockResolvedValue(null) },
}));
vi.mock('@magick-agency/db/repositories/agency-call.repository', () => ({
  webrtcCallRepository: { create: vi.fn(), findById: vi.fn(), update: vi.fn() },
}));
vi.mock('../../../src/telephony/factory.js', () => ({ TelephonyProviderRegistry: class { get() { return {}; } } }));
vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: { log: vi.fn() } }));
vi.mock('../../../src/analytics/posthog.js', () => ({
  trackWebrtcCallInitiated: vi.fn(), trackWebrtcCallRejected: vi.fn(), trackWebrtcCallCompleted: vi.fn(),
}));

import { getLogContext, runWithLogContext, setLogContext } from '@magick-agency/observability';
import { AgencyRuntime } from '../../../src/agency/runtime.js';

function fakeRedis() {
  return {
    set: vi.fn(async () => 'OK'),
    get: vi.fn(async () => null),
    del: vi.fn(async () => 1),
    mget: vi.fn(async (...keys: string[]) => keys.map(() => null)),
  };
}

describe('the silent-station sweep timer and the ambient log context', () => {
  let runtime: AgencyRuntime | null = null;

  afterEach(() => {
    runtime?.stopStationSweep();
    runtime = null;
    vi.restoreAllMocks();
  });

  it('does not carry the context of the request that armed it', async () => {
    runtime = new AgencyRuntime({} as never, fakeRedis() as never, '');
    const seen: Array<ReturnType<typeof getLogContext>> = [];
    vi.spyOn(runtime, 'sweepSilentStations').mockImplementation(() => {
      seen.push(getLogContext());
      return 0;
    });
    const realSetInterval = globalThis.setInterval;
    const armed = vi.spyOn(globalThis, 'setInterval').mockImplementation(
      ((fn: () => void) => realSetInterval(fn, 1)) as typeof setInterval,
    );

    // What a station upgrade does: the app-wide hook's `enterWith`, then the attach wakes
    // the sweep — all inside that request's async context.
    runWithLogContext({}, () => {
      setLogContext({ client: 'mobile', clientVersion: '1.4.0+52', clientPlatform: 'android', tenantId: 't1' });
      expect(getLogContext()).toMatchObject({ client: 'mobile' });
      runtime!.wakeStationSweep();
    });
    expect(armed).toHaveBeenCalledTimes(1);
    armed.mockRestore();

    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    // The runtime was built outside any context, so the sweep runs in none.
    expect(seen[0]).toBeUndefined();
  });

  it('runs in the context the runtime was built in', async () => {
    runtime = runWithLogContext({ component: 'boot' }, () => new AgencyRuntime({} as never, fakeRedis() as never, ''));
    const seen: Array<ReturnType<typeof getLogContext>> = [];
    vi.spyOn(runtime, 'sweepSilentStations').mockImplementation(() => {
      seen.push(getLogContext());
      return 0;
    });
    const realSetInterval = globalThis.setInterval;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(
      ((fn: () => void) => realSetInterval(fn, 1)) as typeof setInterval,
    );

    runWithLogContext({ client: 'web' }, () => runtime!.wakeStationSweep());
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen[0]).toEqual({ component: 'boot' });
  });
});

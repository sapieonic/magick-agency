// The inbound monitor (`telephony/credentials/inbound-monitor.ts`, docs/inbound.md §3.2, §3.3):
// the connect gauge from MEDIA_WORKERS, the two boot warnings (media workers on with inbound
// enabled; production with inbound enabled and no off-deployment fallback), and the scheduled
// Application health check: every inbound-enabled credential checked, the results counted in
// `agency_inbound_applications` (zeros included), each one not `ok` logged with its credential,
// a refused or throwing check counted `failed`, nothing asked and nothing logged with none.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  warn: vi.fn(),
  connect: vi.fn(),
  health: vi.fn(),
}));

vi.mock('@magick-agency/observability', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: h.warn, error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@magick-agency/observability/metrics/agency', () => ({
  INBOUND_APPLICATION_HEALTHS: ['ok', 'url_mismatch', 'app_missing', 'unreachable', 'failed'],
  trackInboundConnectAvailable: h.connect,
  trackInboundApplicationHealth: h.health,
}));

import { runInboundHealthPass, startInboundMonitor, type InboundMonitorDeps } from '../../../src/telephony/credentials/inbound-monitor.js';

const T = '11111111-1111-4111-8111-111111111111';
const cred = (n: number) => `0f9c2a4e-6b1d-4c3e-9a8f-1b2c3d4e5f6${n}`;
const check = (health: 'ok' | 'url_mismatch' | 'app_missing' | 'unreachable', mismatched: string[] = []) =>
  ({ ok: true as const, value: { inbound: {}, health: { health, mismatched, stored_urls_current: true, checked_at: '' } } });

let enabled: Array<{ credential_id: string; tenant_id: string; status: 'active' | 'disabled' | 'invalid' }>;
let deps: InboundMonitorDeps;
let healthOf: ReturnType<typeof vi.fn>;
const stops: Array<() => void> = [];

beforeEach(() => {
  vi.clearAllMocks();
  enabled = [];
  healthOf = vi.fn();
  deps = {
    credentials: { listInboundEnabled: vi.fn(async () => enabled) },
    inbound: { health: healthOf as never },
    mediaWorkers: 0,
    production: true,
    fallbackAnswerUrl: 'https://static.example.net/inbound-fallback.xml',
  };
});

afterEach(() => {
  while (stops.length) stops.pop()!();
});

const warnings = () => h.warn.mock.calls.map(([, msg]) => String(msg));

describe('the health pass', () => {
  it('counts every credential`s result, zeros included, and logs each one that is not ok with its credential', async () => {
    enabled = [
      { credential_id: cred(1), tenant_id: T, status: 'active' },
      { credential_id: cred(2), tenant_id: T, status: 'active' },
      { credential_id: cred(3), tenant_id: T, status: 'disabled' },
      { credential_id: cred(4), tenant_id: T, status: 'invalid' },
      { credential_id: cred(5), tenant_id: T, status: 'active' },
    ];
    healthOf.mockImplementation(async (id: string) => {
      if (id === cred(1)) return check('ok');
      if (id === cred(2)) return check('url_mismatch', ['answer_url']);
      if (id === cred(3)) return check('app_missing');
      if (id === cred(4)) return { ok: false, code: 'carrier_rejected', message: 'refused' };
      throw new Error('boom');
    });

    const counts = await runInboundHealthPass(deps);

    const want = { ok: 1, url_mismatch: 1, app_missing: 1, unreachable: 0, failed: 2 };
    expect(counts).toEqual(want);
    expect(h.health).toHaveBeenCalledWith(want);
    expect(healthOf.mock.calls.map(([id]) => id)).toEqual([cred(1), cred(2), cred(3), cred(4), cred(5)]);
    const logged = h.warn.mock.calls.map(([fields]) => [(fields as { credentialId: string }).credentialId, (fields as { health?: string }).health ?? (fields as { code?: string }).code ?? 'threw']);
    expect(logged).toEqual([[cred(2), 'url_mismatch'], [cred(3), 'app_missing'], [cred(4), 'carrier_rejected'], [cred(5), 'threw']]);
  });

  it('with no credential enabled: asks nothing, logs nothing, and sets every series to 0', async () => {
    expect(await runInboundHealthPass(deps)).toEqual({ ok: 0, url_mismatch: 0, app_missing: 0, unreachable: 0, failed: 0 });
    expect(healthOf).not.toHaveBeenCalled();
    expect(h.warn).not.toHaveBeenCalled();
    expect(h.health).toHaveBeenCalledWith({ ok: 0, url_mismatch: 0, app_missing: 0, unreachable: 0, failed: 0 });
  });

  it('a list that fails leaves the gauges as they were', async () => {
    deps.credentials.listInboundEnabled = vi.fn().mockRejectedValue(new Error('db down'));
    expect(await runInboundHealthPass(deps)).toBeNull();
    expect(h.health).not.toHaveBeenCalled();
  });
});

describe('start', () => {
  it('sets the connect gauge from MEDIA_WORKERS', async () => {
    stops.push(await startInboundMonitor(deps));
    expect(h.connect).toHaveBeenLastCalledWith(true);
    stops.push(await startInboundMonitor({ ...deps, mediaWorkers: 2 }));
    expect(h.connect).toHaveBeenLastCalledWith(false);
  });

  it('warns at boot when inbound is enabled with media workers on, and only then', async () => {
    stops.push(await startInboundMonitor({ ...deps, mediaWorkers: 2 }));
    expect(warnings().some((m) => m.includes('MEDIA_WORKERS'))).toBe(false); // nothing enabled
    enabled = [{ credential_id: cred(1), tenant_id: T, status: 'active' }];
    healthOf.mockResolvedValue(check('ok'));
    stops.push(await startInboundMonitor({ ...deps, mediaWorkers: 2 }));
    expect(warnings().filter((m) => m.includes('MEDIA_WORKERS'))).toHaveLength(1);
    h.warn.mockClear();
    stops.push(await startInboundMonitor(deps));
    expect(warnings().some((m) => m.includes('MEDIA_WORKERS'))).toBe(false);
  });

  it('warns at boot when inbound is enabled in production with no off-deployment fallback, and only then', async () => {
    enabled = [{ credential_id: cred(1), tenant_id: T, status: 'active' }];
    healthOf.mockResolvedValue(check('ok'));
    const fallbackWarnings = () => warnings().filter((m) => m.includes('PLIVO_INBOUND_FALLBACK_ANSWER_URL'));
    stops.push(await startInboundMonitor({ ...deps, fallbackAnswerUrl: '' }));
    expect(fallbackWarnings()).toHaveLength(1);
    h.warn.mockClear();
    stops.push(await startInboundMonitor(deps));                                          // set
    stops.push(await startInboundMonitor({ ...deps, fallbackAnswerUrl: '', production: false })); // a dev box
    enabled = [];
    stops.push(await startInboundMonitor({ ...deps, fallbackAnswerUrl: '' }));            // no inbound
    expect(fallbackWarnings()).toEqual([]);
  });

  it('runs a pass at boot and then on the interval, never two at once', async () => {
    vi.useFakeTimers();
    try {
      enabled = [{ credential_id: cred(1), tenant_id: T, status: 'active' }];
      let release: () => void = () => undefined;
      healthOf.mockImplementation(() => new Promise((r) => { release = () => r(check('ok')); }));
      stops.push(await startInboundMonitor(deps, 1000));
      await vi.advanceTimersByTimeAsync(0);
      expect(healthOf).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(3000); // the boot pass still running: no second
      expect(healthOf).toHaveBeenCalledTimes(1);
      release();
      await vi.advanceTimersByTimeAsync(1000);
      expect(healthOf).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

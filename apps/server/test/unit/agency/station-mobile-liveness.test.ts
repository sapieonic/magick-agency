import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// The mobile liveness backstop.
//
// A phone whose app the OS suspended while the agent was `available` holds a live
// lease for as long as its station is believed alive, and under early binding a
// customer can be bridged to it. The app sends the device-away break when it is
// backgrounded; this is what catches it when it could not:
//
//  * a `mobile` station is probed with RFC 6455 pings every MOBILE_STATION_PROBE_MS, and
//    every protocol pong (or ping from the app) renews its `lastSeen` — in memory only,
//    never Postgres or Redis;
//  * the sweep holds each station to its OWN grace: the web keeps 30s, a mobile one 10s,
//    so a silent phone is dropped within 10–15s — `terminate`, never `close(4408)`, because
//    on a dead transport `close` holds the entry CLOSING (and the agent dialable) for ws's
//    30s closing timeout; a silent web console is still closed 4408;
//  * the probe's timer and listeners go with the socket — detach, supersede or close —
//    so nothing leaks;
//  * the mid-attempt rule holds for a phone with one exception (decision M1): silent past
//    its grace on a call the agent can see, campaign, soft phone or inbound, it is dropped
//    and the bridge's close rule decides the call.
// ---------------------------------------------------------------------------

// One `warn` for every logger, so a test can read why the sweep dropped a phone (`during`).
const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@magick-agency/observability', () => ({
  logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
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

import { StationRegistry, stationGraceFor } from '../../../src/agency/station-registry.js';
import { AgencyRuntime } from '../../../src/agency/runtime.js';
import { AGENCY_STATION_CLOSE } from '@magick-agency/contracts/agency';
import {
  MOBILE_STATION_HEARTBEAT_GRACE_MS,
  MOBILE_STATION_PROBE_MS,
  STATION_HEARTBEAT_GRACE_MS,
  STATION_HEARTBEAT_SWEEP_MS,
} from '@magick-agency/domain/timers';

/**
 * A `ws` stand-in with real listener bookkeeping. `autoPong` answers each server ping
 * the way a live client's WebSocket stack does; switch it off to model a phone the OS
 * suspended (or a dead transport).
 */
class FakeWs extends EventEmitter {
  readyState = 1;
  pings = 0;
  autoPong = true;
  closeArgs: [number | undefined, string | undefined][] = [];
  send(): void { /* frames are not the subject here */ }
  ping(): void {
    this.pings++;
    if (this.autoPong) queueMicrotask(() => this.emit('pong'));
  }
  close(code?: number, reason?: string): void {
    this.closeArgs.push([code, reason]);
    this.readyState = 2;
  }
  terminated = 0;
  /** `ws` destroys the transport: CLOSED and `close` follow without a handshake. */
  terminate(): void {
    this.terminated++;
    this.closed();
  }
  /** The socket is gone: `ws` sets CLOSED and emits `close` in one step. */
  closed(): void {
    this.readyState = 3;
    this.emit('close');
  }
  probeListeners(): number {
    return this.listenerCount('pong') + this.listenerCount('ping') + this.listenerCount('close');
  }
}

function fakeRedis() {
  return {
    set: vi.fn(async () => 'OK'),
    get: vi.fn(async () => null),
    del: vi.fn(async () => 1),
    mget: vi.fn(async (...keys: string[]) => keys.map(() => null)),
  };
}

const ENTRY = { campaignId: 'camp-1', tenantId: 't1', accountId: 'a1', agentUserId: 'u1' };
const T0 = new Date('2026-11-01T09:00:00.000Z');

describe('the mobile probe (StationRegistry)', () => {
  let redis: ReturnType<typeof fakeRedis>;
  let reg: StationRegistry;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], now: T0 });
    redis = fakeRedis();
    reg = new StationRegistry(redis as never, '', 'r1');
  });

  afterEach(() => vi.useRealTimers());

  it('pings a mobile station every MOBILE_STATION_PROBE_MS; each pong renews lastSeen, in memory only', async () => {
    const ws = new FakeWs();
    await reg.attach({ sessionId: 's1', ws: ws as never, ...ENTRY, clientKind: 'mobile' });
    expect(reg.get('s1')?.clientKind).toBe('mobile');
    redis.set.mockClear();

    vi.advanceTimersByTime(MOBILE_STATION_PROBE_MS - 1);
    expect(ws.pings).toBe(0);
    vi.advanceTimersByTime(1);
    expect(ws.pings).toBe(1);
    await Promise.resolve(); // the pong
    expect(reg.get('s1')!.lastSeen).toBe(T0.getTime() + MOBILE_STATION_PROBE_MS);

    vi.advanceTimersByTime(MOBILE_STATION_PROBE_MS * 3);
    await Promise.resolve();
    expect(ws.pings).toBe(4);
    expect(reg.get('s1')!.lastSeen).toBe(T0.getTime() + MOBILE_STATION_PROBE_MS * 4);
    // Never a Redis write (nor read): the ownership key is the app-level ping's.
    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
  });

  it('a protocol ping FROM the app renews it too (the app pings on its own 3s interval)', async () => {
    const ws = new FakeWs();
    ws.autoPong = false;
    await reg.attach({ sessionId: 's1', ws: ws as never, ...ENTRY, clientKind: 'mobile' });
    vi.setSystemTime(T0.getTime() + 7_000);
    ws.emit('ping');
    expect(reg.get('s1')!.lastSeen).toBe(T0.getTime() + 7_000);
  });

  it('never probes a web station: no timer, no listener, lastSeen moves only on a client ping', async () => {
    const ws = new FakeWs();
    await reg.attach({ sessionId: 's1', ws: ws as never, ...ENTRY });
    expect(reg.get('s1')?.clientKind).toBe('web');
    expect(reg.probeCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(ws.probeListeners()).toBe(0);
    vi.setSystemTime(T0.getTime() + 5_000);
    ws.emit('pong');
    expect(reg.get('s1')!.lastSeen).toBe(T0.getTime());
  });

  it('stops on detach: the timer and every listener go', async () => {
    const ws = new FakeWs();
    await reg.attach({ sessionId: 's1', ws: ws as never, ...ENTRY, clientKind: 'mobile' });
    expect(reg.probeCount()).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    expect(ws.probeListeners()).toBe(3);

    await reg.detach('s1', ws as never);
    expect(reg.probeCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(ws.probeListeners()).toBe(0);
    vi.advanceTimersByTime(MOBILE_STATION_PROBE_MS * 5);
    expect(ws.pings).toBe(0);
  });

  it('stops when the socket closes, even before anything detaches it', async () => {
    const ws = new FakeWs();
    await reg.attach({ sessionId: 's1', ws: ws as never, ...ENTRY, clientKind: 'mobile' });
    ws.closed();
    expect(reg.probeCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(ws.probeListeners()).toBe(0);
  });

  it('stops on supersede, and the superseded socket\'s late pong cannot keep the replacement alive', async () => {
    const old = new FakeWs();
    await reg.attach({ sessionId: 's1', ws: old as never, ...ENTRY, clientKind: 'mobile' });
    const fresh = new FakeWs();
    fresh.autoPong = false;
    await reg.attach({ sessionId: 's1', ws: fresh as never, ...ENTRY, clientKind: 'mobile' });
    expect(old.closeArgs).toEqual([[AGENCY_STATION_CLOSE.SUPERSEDED, 'superseded']]);
    expect(old.probeListeners()).toBe(0);
    expect(reg.probeCount()).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    vi.setSystemTime(T0.getTime() + 9_000);
    old.emit('pong');
    expect(reg.get('s1')!.lastSeen).toBe(T0.getTime());

    // The superseded socket's own close does not take the replacement's probe with it.
    old.closed();
    expect(reg.probeCount()).toBe(1);
    vi.advanceTimersByTime(MOBILE_STATION_PROBE_MS);
    expect(fresh.pings).toBeGreaterThan(0);
  });

  it('a web reconnect superseding a mobile station stops the probe (continue on the browser)', async () => {
    const phone = new FakeWs();
    await reg.attach({ sessionId: 's1', ws: phone as never, ...ENTRY, clientKind: 'mobile' });
    await reg.attach({ sessionId: 's1', ws: new FakeWs() as never, ...ENTRY, clientKind: 'web' });
    expect(reg.get('s1')?.clientKind).toBe('web');
    expect(reg.probeCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not arm a probe on a socket that is already closing', async () => {
    const ws = new FakeWs();
    ws.readyState = 2;
    await reg.attach({ sessionId: 's1', ws: ws as never, ...ENTRY, clientKind: 'mobile' });
    expect(reg.probeCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a probe tick on a socket that stopped being OPEN sends nothing', async () => {
    const ws = new FakeWs();
    await reg.attach({ sessionId: 's1', ws: ws as never, ...ENTRY, clientKind: 'mobile' });
    ws.readyState = 2;
    vi.advanceTimersByTime(MOBILE_STATION_PROBE_MS * 2);
    expect(ws.pings).toBe(0);
  });

  it('silentSince holds each entry to its own grace (stationGraceFor)', async () => {
    await reg.attach({ sessionId: 'web', ws: new FakeWs() as never, ...ENTRY });
    const phone = new FakeWs();
    phone.autoPong = false;
    await reg.attach({ sessionId: 'phone', ws: phone as never, ...ENTRY, clientKind: 'mobile' });
    const at = (ms: number) => reg.silentSince(stationGraceFor, T0.getTime() + ms).map((e) => e.sessionId).sort();
    expect(at(MOBILE_STATION_HEARTBEAT_GRACE_MS)).toEqual([]);
    expect(at(MOBILE_STATION_HEARTBEAT_GRACE_MS + 1)).toEqual(['phone']);
    expect(at(STATION_HEARTBEAT_GRACE_MS)).toEqual(['phone']);
    expect(at(STATION_HEARTBEAT_GRACE_MS + 1)).toEqual(['phone', 'web']);
    // A number is still one grace for everyone.
    expect(reg.silentSince(STATION_HEARTBEAT_GRACE_MS, T0.getTime() + STATION_HEARTBEAT_GRACE_MS)).toEqual([]);
  });
});

describe('the sweep, per station (AgencyRuntime)', () => {
  let runtime: AgencyRuntime;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], now: T0 });
    runtime = new AgencyRuntime({} as never, fakeRedis() as never, '');
  });

  afterEach(() => {
    runtime.stopStationSweep();
    vi.useRealTimers();
  });

  it('drops a silent phone at its 10s grace (terminate) while a silent web console keeps its 30s (close 4408)', async () => {
    const phone = new FakeWs();
    phone.autoPong = false;
    const browser = new FakeWs();
    await runtime.stations.attach({ sessionId: 'phone', ws: phone as never, ...ENTRY, clientKind: 'mobile' });
    await runtime.stations.attach({ sessionId: 'web', ws: browser as never, ...ENTRY });
    // The station route's close handler detaches (`station-socket.ts`).
    phone.on('close', () => { void runtime.stations.detach('phone', phone as never); });

    expect(runtime.sweepSilentStations(undefined, T0.getTime() + MOBILE_STATION_HEARTBEAT_GRACE_MS)).toBe(0);
    expect(runtime.sweepSilentStations(undefined, T0.getTime() + MOBILE_STATION_HEARTBEAT_GRACE_MS + 1)).toBe(1);
    expect(phone.terminated).toBe(1);
    expect(phone.closeArgs).toEqual([]);
    expect(browser.closeArgs).toEqual([]);
    expect(browser.terminated).toBe(0);

    expect(runtime.sweepSilentStations(undefined, T0.getTime() + STATION_HEARTBEAT_GRACE_MS)).toBe(0);
    expect(runtime.sweepSilentStations(undefined, T0.getTime() + STATION_HEARTBEAT_GRACE_MS + 1)).toBe(1);
    expect(browser.closeArgs).toEqual([[AGENCY_STATION_CLOSE.HEARTBEAT_TIMEOUT, 'station_heartbeat_timeout']]);
    expect(browser.terminated).toBe(0);
  });

  // The orphan storm: `close(4408)` on a dead transport leaves the entry CLOSING for ws's
  // 30s closing timeout, `isLocallyOwned` true, and pacing admitting an agent it cannot
  // dial — an orphaned attempt row per tick. `terminate` makes `close` (and so the station
  // route's close handler, which detaches) follow at once.
  it('a silent phone off a call is terminated, and once its close lands it is no longer locally owned', async () => {
    const phone = new FakeWs();
    phone.autoPong = false;
    await runtime.stations.attach({ sessionId: 'phone', ws: phone as never, ...ENTRY, clientKind: 'mobile' });
    // What the station route's close handler does first (`station-socket.ts`).
    phone.on('close', () => { void runtime.stations.detach('phone', phone as never); });
    expect(runtime.stations.isLocallyOwned('phone')).toBe(true);

    expect(runtime.sweepSilentStations(undefined, T0.getTime() + MOBILE_STATION_HEARTBEAT_GRACE_MS + 1)).toBe(1);
    expect(phone.terminated).toBe(1);
    expect(phone.closeArgs).toEqual([]);
    expect(runtime.stations.isLocallyOwned('phone')).toBe(false);
    // Nothing left for the next pass.
    expect(runtime.sweepSilentStations(undefined, T0.getTime() + MOBILE_STATION_HEARTBEAT_GRACE_MS + 5_000)).toBe(0);
  });

  it('a silent phone already CLOSING is terminated too; a CLOSING web console is left to its handshake', async () => {
    const phone = new FakeWs();
    phone.autoPong = false;
    const browser = new FakeWs();
    await runtime.stations.attach({ sessionId: 'phone', ws: phone as never, ...ENTRY, clientKind: 'mobile' });
    await runtime.stations.attach({ sessionId: 'web', ws: browser as never, ...ENTRY });
    phone.readyState = 2;
    browser.readyState = 2;

    expect(runtime.sweepSilentStations(undefined, T0.getTime() + STATION_HEARTBEAT_GRACE_MS + 1)).toBe(1);
    expect(phone.terminated).toBe(1);
    expect(browser.terminated).toBe(0);
    expect(browser.closeArgs).toEqual([]);
  });

  it('a pre-bind dial keeps the mid-attempt rule for a phone: not closed, the pre-bind grace armed', async () => {
    const phone = new FakeWs();
    phone.autoPong = false;
    await runtime.stations.attach({ sessionId: 'phone', ws: phone as never, ...ENTRY, clientKind: 'mobile' });
    vi.spyOn(runtime.dialer, 'hasLiveAttempt').mockReturnValue(true);
    vi.spyOn(runtime.dialer, 'hasUnannouncedAttempt').mockReturnValue(true);
    const noteClosed = vi.spyOn(runtime.dialer, 'noteStationClosed');

    expect(runtime.sweepSilentStations(undefined, T0.getTime() + MOBILE_STATION_HEARTBEAT_GRACE_MS + 1)).toBe(0);
    expect(phone.closeArgs).toEqual([]);
    expect(phone.terminated).toBe(0);
    expect(noteClosed).toHaveBeenCalledWith('phone');
    expect(runtime.stations.isLocallyOwned('phone')).toBe(true);
  });

  it('drops a phone silent past its 10s grace on a call the agent can see (M1), and only then', async () => {
    const phone = new FakeWs();
    phone.autoPong = false;
    await runtime.stations.attach({ sessionId: 'phone', ws: phone as never, ...ENTRY, clientKind: 'mobile' });
    vi.spyOn(runtime.dialer, 'hasLiveAttempt').mockReturnValue(true);
    vi.spyOn(runtime.dialer, 'hasUnannouncedAttempt').mockReturnValue(false);
    const noteClosed = vi.spyOn(runtime.dialer, 'noteStationClosed');

    expect(runtime.sweepSilentStations(undefined, T0.getTime() + MOBILE_STATION_HEARTBEAT_GRACE_MS)).toBe(0);
    expect(phone.terminated).toBe(0);

    expect(runtime.sweepSilentStations(undefined, T0.getTime() + MOBILE_STATION_HEARTBEAT_GRACE_MS + 1)).toBe(1);
    // terminate, not close: a dead transport would hold `close` (and so the deferred
    // hangup) behind ws's 30 s closing timeout.
    expect(phone.terminated).toBe(1);
    expect(phone.closeArgs).toEqual([]);
    expect(noteClosed).not.toHaveBeenCalled();
  });

  it('a silent web console on a call is still never closed (rule 1 unchanged for the web)', async () => {
    const browser = new FakeWs();
    await runtime.stations.attach({ sessionId: 'web', ws: browser as never, ...ENTRY });
    vi.spyOn(runtime.dialer, 'hasLiveAttempt').mockReturnValue(true);
    vi.spyOn(runtime.dialer, 'hasUnannouncedAttempt').mockReturnValue(false);

    expect(runtime.sweepSilentStations(undefined, T0.getTime() + STATION_HEARTBEAT_GRACE_MS * 10)).toBe(0);
    expect(browser.terminated).toBe(0);
    expect(browser.closeArgs).toEqual([]);
  });

  // The soft phone binds the agent's leg to this socket before the dial, so there is no
  // pre-bind case: once the close lands, the bridge hangs up at once before the answer and
  // its 8 s deferred hangup decides after it.
  it('drops a phone silent past its 10s grace on a live soft-phone call (M1), and only then', async () => {
    const phone = new FakeWs();
    phone.autoPong = false;
    await runtime.stations.attach({ sessionId: 'phone', ws: phone as never, ...ENTRY, clientKind: 'mobile' });
    vi.spyOn(runtime.manualDialer, 'hasLiveCall').mockReturnValue(true);

    expect(runtime.sweepSilentStations(undefined, T0.getTime() + MOBILE_STATION_HEARTBEAT_GRACE_MS)).toBe(0);
    expect(phone.terminated).toBe(0);

    expect(runtime.sweepSilentStations(undefined, T0.getTime() + MOBILE_STATION_HEARTBEAT_GRACE_MS + 1)).toBe(1);
    // terminate, not close: a dead transport would hold `close` (and so the bridge's
    // hangup) behind ws's 30 s closing timeout.
    expect(phone.terminated).toBe(1);
    expect(phone.closeArgs).toEqual([]);
  });

  it('a silent web console on a live soft-phone call is never acted on (rule 1 unchanged for the web)', async () => {
    const browser = new FakeWs();
    await runtime.stations.attach({ sessionId: 'web', ws: browser as never, ...ENTRY });
    vi.spyOn(runtime.manualDialer, 'hasLiveCall').mockReturnValue(true);

    expect(runtime.sweepSilentStations(undefined, T0.getTime() + STATION_HEARTBEAT_GRACE_MS * 10)).toBe(0);
    expect(browser.terminated).toBe(0);
    expect(browser.closeArgs).toEqual([]);
    expect(runtime.stations.isLocallyOwned('web')).toBe(true);
  });

  // A live inbound call (bound to this socket, IQ46): the campaign call's M1 exception for a phone,
  // rule 1 as written for the web.
  it('drops a phone silent past its 10s grace on a live inbound call (M1), and only then, as on_inbound_call', async () => {
    const phone = new FakeWs();
    phone.autoPong = false;
    await runtime.stations.attach({ sessionId: 'phone', ws: phone as never, ...ENTRY, clientKind: 'mobile', canTakeInbound: true });
    runtime.inbound = { hasLiveCall: (sessionId: string) => sessionId === 'phone' } as never;

    expect(runtime.sweepSilentStations(undefined, T0.getTime() + MOBILE_STATION_HEARTBEAT_GRACE_MS)).toBe(0);
    expect(phone.terminated).toBe(0);

    warn.mockClear();
    expect(runtime.sweepSilentStations(undefined, T0.getTime() + MOBILE_STATION_HEARTBEAT_GRACE_MS + 1)).toBe(1);
    // terminate, not close: the bridge's 8 s deferred hangup starts now, not after ws's 30 s closing timeout.
    expect(phone.terminated).toBe(1);
    expect(phone.closeArgs).toEqual([]);
    // Dropped by the inbound arm, not the idle one.
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'phone', during: 'on_inbound_call' }), expect.any(String));
  });

  it('a silent web console on a live inbound call is never acted on: neither closed nor detached (rule 1 unchanged for the web)', async () => {
    const browser = new FakeWs();
    await runtime.stations.attach({ sessionId: 'web', ws: browser as never, ...ENTRY });
    runtime.inbound = { hasLiveCall: () => true } as never;

    expect(runtime.sweepSilentStations(undefined, T0.getTime() + STATION_HEARTBEAT_GRACE_MS * 10)).toBe(0);
    expect(browser.terminated).toBe(0);
    expect(browser.closeArgs).toEqual([]);
    expect(runtime.stations.isLocallyOwned('web')).toBe(true);
  });

  it('on its own timers: a phone that stops answering is dropped within 15s; one that answers never is', async () => {
    const healthy = new FakeWs();
    const asleep = new FakeWs();
    await runtime.stations.attach({ sessionId: 'healthy', ws: healthy as never, ...ENTRY, clientKind: 'mobile' });
    await runtime.stations.attach({ sessionId: 'asleep', ws: asleep as never, ...ENTRY, clientKind: 'mobile' });
    runtime.wakeStationSweep();

    // Both answer for a while; then one is suspended.
    for (let t = 0; t < 20_000; t += 1_000) { vi.advanceTimersByTime(1_000); await Promise.resolve(); }
    asleep.autoPong = false;
    const suspendedAt = Date.now();
    let closedAfter: number | null = null;
    for (let t = 0; t < 60_000; t += 1_000) {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
      if (closedAfter === null && asleep.terminated > 0) closedAfter = Date.now() - suspendedAt;
    }

    expect(closedAfter).not.toBeNull();
    // Its last pong landed up to one probe before the suspension.
    expect(closedAfter!).toBeGreaterThan(MOBILE_STATION_HEARTBEAT_GRACE_MS - MOBILE_STATION_PROBE_MS);
    expect(closedAfter!).toBeLessThanOrEqual(MOBILE_STATION_HEARTBEAT_GRACE_MS + STATION_HEARTBEAT_SWEEP_MS);
    expect(asleep.terminated).toBe(1);
    expect(asleep.closeArgs).toEqual([]);
    // 80s with no app-level ping at all: the probe alone kept it.
    expect(healthy.closeArgs).toEqual([]);
    expect(healthy.terminated).toBe(0);
  });

  it('leaks no timer: after the phones close and detach, only the sweep is left, and it goes dormant', async () => {
    const a = new FakeWs();
    const b = new FakeWs();
    await runtime.stations.attach({ sessionId: 'a', ws: a as never, ...ENTRY, clientKind: 'mobile' });
    await runtime.stations.attach({ sessionId: 'b', ws: b as never, ...ENTRY, clientKind: 'mobile' });
    runtime.wakeStationSweep();
    expect(vi.getTimerCount()).toBe(3); // two probes + the sweep

    a.closed();
    await runtime.stations.detach('a', a as never);
    await runtime.stations.detach('b', b as never);
    expect(runtime.stations.probeCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(STATION_HEARTBEAT_SWEEP_MS * 3);
    expect(runtime.isStationSweepArmed()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

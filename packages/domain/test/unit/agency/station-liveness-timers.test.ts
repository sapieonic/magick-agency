import { describe, expect, it } from 'vitest';
import {
  MOBILE_STATION_HEARTBEAT_GRACE_MS,
  MOBILE_STATION_PROBE_MS,
  STATION_HEARTBEAT_GRACE_MS,
  STATION_HEARTBEAT_SWEEP_MS,
  stationHeartbeatGraceMs,
} from '../../../src/timers.js';

// The station liveness numbers, as relations rather than only values: the mobile
// backstop is "a silent phone is closed within about 10–15s", and that is a property
// of three numbers together, so a retune of one that breaks it fails here.
describe('station liveness timers', () => {
  it('pins the values (SNAPSHOT)', () => {
    expect(STATION_HEARTBEAT_GRACE_MS).toBe(30_000);
    expect(MOBILE_STATION_HEARTBEAT_GRACE_MS).toBe(10_000);
    expect(MOBILE_STATION_PROBE_MS).toBe(3_000);
    expect(STATION_HEARTBEAT_SWEEP_MS).toBe(5_000);
  });

  it('serves each client kind its own grace; the web keeps the 30s it always had', () => {
    expect(stationHeartbeatGraceMs('web')).toBe(STATION_HEARTBEAT_GRACE_MS);
    expect(stationHeartbeatGraceMs('mobile')).toBe(MOBILE_STATION_HEARTBEAT_GRACE_MS);
  });

  it('a silent mobile station is closed within 15s, and only after three probes went unanswered', () => {
    expect(MOBILE_STATION_HEARTBEAT_GRACE_MS + STATION_HEARTBEAT_SWEEP_MS).toBeLessThanOrEqual(15_000);
    expect(MOBILE_STATION_PROBE_MS * 3).toBeLessThanOrEqual(MOBILE_STATION_HEARTBEAT_GRACE_MS);
  });
});

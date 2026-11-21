import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * OS9: the idle-session sweep is built, started and stopped in `src/bootstrap/agency.ts` (the
 * agency's background work, the primary only). A source scrape, for the reason
 * `agency-reaper-wiring.test.ts` gives: that file has no factory a test can run, and the failure
 * worth catching is a sweep that is unit-tested and never started, or whose timer and pass in
 * flight outlive the shutdown.
 */
describe('src/bootstrap/agency.ts idle-session sweep wiring (OS9)', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/bootstrap/agency.ts'), 'utf8');
  const stopAt = source.indexOf('const stop = async');
  const startPart = source.slice(0, stopAt);
  const stopPart = source.slice(stopAt);

  it('builds it on the agency runtime and starts it before the stop is defined', () => {
    expect(stopAt).toBeGreaterThan(0);
    expect(startPart).toMatch(/const idleSessions = new IdleSessionSweep\(agencyRuntime\)/);
    expect(startPart).toMatch(/idleSessions\.start\(\)/);
  });

  it('stops it in the stop, and waits for its pass in flight before the runtime stops', () => {
    expect(stopPart).toMatch(/const idleSweepStopped = idleSessions\.stop\(\)/);
    const awaited = stopPart.indexOf('await idleSweepStopped');
    const runtimeStopped = stopPart.indexOf('await agencyRuntime.stop()');
    expect(awaited).toBeGreaterThan(0);
    expect(runtimeStopped).toBeGreaterThan(awaited);
  });
});

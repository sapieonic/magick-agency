import { describe, expect, it } from 'vitest';
import { runShutdownPlan } from '../../../src/cluster/shutdown-order.js';

/*
 * The server's stop order after HTTP has closed (docs/scaling.md §6.4): pacing halts before
 * anything drains; the media workers' drain and the analysis stop run together; then the
 * remaining stops one at a time in reverse start order. A failing step does not stop the
 * rest.
 */

function step(log: string[], name: string, ms = 0, fail = false) {
  return async (): Promise<void> => {
    log.push(`${name}:start`);
    await new Promise((r) => setTimeout(r, ms));
    log.push(`${name}:end`);
    if (fail) throw new Error(`${name} failed`);
  };
}

describe('runShutdownPlan', () => {
  it('halts pacing first, overlaps the drains, then stops the rest in reverse', async () => {
    const log: string[] = [];
    const started = Date.now();
    await runShutdownPlan({
      haltPacing: step(log, 'halt', 10),
      drains: [step(log, 'media', 60), step(log, 'analysis', 60)],
      stops: [step(log, 'platform'), step(log, 'voice'), step(log, 'agency')],
    }, () => {});
    const at = (e: string): number => log.indexOf(e);
    // Nothing drains until pacing has halted.
    expect(at('halt:end')).toBeLessThan(at('media:start'));
    expect(at('halt:end')).toBeLessThan(at('analysis:start'));
    // The drains overlap: both started before either ended, so the stop costs one, not both.
    expect(at('analysis:start')).toBeLessThan(at('media:end'));
    expect(Date.now() - started).toBeLessThan(10 + 60 + 60);
    // Then agency, voice, platform, each after the drains.
    expect(log.slice(at('media:end') > at('analysis:end') ? at('media:end') + 1 : at('analysis:end') + 1))
      .toEqual(['agency:start', 'agency:end', 'voice:start', 'voice:end', 'platform:start', 'platform:end']);
  });

  it('a failing step is reported and the rest still run', async () => {
    const log: string[] = [];
    const errors: string[] = [];
    await runShutdownPlan({
      haltPacing: step(log, 'halt', 0, true),
      drains: [step(log, 'media', 0, true), step(log, 'analysis')],
      stops: [step(log, 'platform'), step(log, 'agency', 0, true)],
    }, (_err, where) => errors.push(where));
    expect(errors).toEqual(['pacing halt', 'drain', 'stop']);
    expect(log).toContain('analysis:end');
    expect(log).toContain('platform:end');
  });

  it('before the agency runtime exists there is no halt, and the rest still runs', async () => {
    const log: string[] = [];
    await runShutdownPlan({ haltPacing: null, drains: [], stops: [step(log, 'platform')] }, () => {});
    expect(log).toEqual(['platform:start', 'platform:end']);
  });
});

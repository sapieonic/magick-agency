import { describe, expect, it } from 'vitest';
import { createAnalysisChildren } from '../../../src/cluster/analysis-children.js';
import { FakeChildProcess } from '../../helpers/fake-child-process.js';

/*
 * The primary's relay of a vendor rate-limit pause between analysis workers (D10). A worker
 * that is not ready when the pause is relayed (still booting, or restarting) is told when it
 * becomes ready, so it does not find the limit out for itself with jobs of its own.
 */

function harness(now: () => number = Date.now) {
  const forks: FakeChildProcess[] = [];
  const children = createAnalysisChildren({
    count: 2,
    fork: (slot) => {
      const child = new FakeChildProcess('analysis', slot);
      forks.push(child);
      return child.asChild();
    },
    readyTimeoutMs: 2_000,
  }, now);
  return { children, forks };
}

const pausedEvents = (f: FakeChildProcess) => f.sent.filter((m) => m.kind === 'event' && m.type === 'analysis.rate_paused');
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
function ratePaused(from: FakeChildProcess, untilMs: number, consecutive = 1): void {
  from.emit('message', { v: 1, kind: 'event', type: 'analysis.rate_paused', body: { untilMs, consecutive } });
}

describe('analysis children: the vendor rate-limit relay', () => {
  it('relays a pause to every ready worker but the one that opened it', async () => {
    const { children, forks } = harness();
    const started = children.start();
    for (const f of forks) f.ready();
    await started;
    ratePaused(forks[0]!, Date.now() + 30_000);
    await tick();
    expect(pausedEvents(forks[1]!)).toHaveLength(1);
    expect(pausedEvents(forks[0]!)).toHaveLength(0);
    await children.stop(500);
  });

  it('a worker that becomes ready during a pause is paused on ready, with the latest end', async () => {
    const { children, forks } = harness();
    const started = children.start();
    forks[0]!.ready();
    await tick();
    const until = Date.now() + 30_000;
    ratePaused(forks[0]!, until - 5_000, 1);
    ratePaused(forks[0]!, until, 2);
    await tick();
    expect(pausedEvents(forks[1]!)).toHaveLength(0); // not ready: told nothing yet

    forks[1]!.ready();
    await started;
    await tick();
    expect(pausedEvents(forks[1]!).map((m) => m.body)).toEqual([{ untilMs: until, consecutive: 2 }]);
    await children.stop(500);
  });

  it('a pause that has ended is not sent to a worker that becomes ready after it', async () => {
    let clock = 1_000_000;
    const { children, forks } = harness(() => clock);
    const started = children.start();
    forks[0]!.ready();
    await tick();
    ratePaused(forks[0]!, clock + 30_000);
    await tick();
    clock += 30_001;
    forks[1]!.ready();
    await started;
    await tick();
    expect(pausedEvents(forks[1]!)).toHaveLength(0);
    await children.stop(500);
  });
});

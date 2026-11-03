import { describe, expect, it } from 'vitest';
import { cachedProbe, clusterReadiness, readinessDetailAuthorized } from '../../../src/cluster/readiness.js';
import type { HealthBody } from '../../../src/cluster/ipc-protocol.js';

/*
 * `/readyz` with media workers (D5): one slow, restarting or draining worker is reported,
 * not a reason to take the whole host out of rotation; no answering worker, or the primary
 * draining, is.
 */
const ok = (slot: number, draining = false): HealthBody => ({
  role: 'media', slot, pid: 100 + slot, elu: 0.5, loopDelayP99Ms: 5, inFlight: 3, pausedForMs: 0, draining,
});

describe('clusterReadiness', () => {
  it('every worker answering: ready, each reported ok', () => {
    expect(clusterReadiness(false, [ok(0), ok(1), ok(2)])).toEqual({
      ready: true,
      summary: { mediaWorkers: { answering: 3, total: 3, workers: [
        { slot: 0, state: 'ok' }, { slot: 1, state: 'ok' }, { slot: 2, state: 'ok' },
      ] } },
    });
  });

  it('one worker slow or restarting (no answer) and one draining: still ready, both named', () => {
    const r = clusterReadiness(false, [ok(0), null, ok(2, true)]);
    expect(r.ready).toBe(true);
    expect(r.summary.mediaWorkers).toEqual({ answering: 1, total: 3, workers: [
      { slot: 0, state: 'ok' }, { slot: 1, state: 'not_answering' }, { slot: 2, state: 'draining' },
    ] });
  });

  it('no worker answering (or every one draining): not ready', () => {
    expect(clusterReadiness(false, [null, null]).ready).toBe(false);
    expect(clusterReadiness(false, [ok(0, true), null]).ready).toBe(false);
  });

  it('the primary draining: not ready, whatever the workers say', () => {
    expect(clusterReadiness(true, [ok(0), ok(1)]).ready).toBe(false);
  });
});

/*
 * `?detail=1` needs `Authorization: Bearer <READYZ_DETAIL_TOKEN>`; no token configured is off.
 */
describe('readinessDetailAuthorized', () => {
  const TOKEN = 'a'.repeat(40);
  it('the configured token as a bearer: allowed', () => {
    expect(readinessDetailAuthorized(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
  });
  it.each([
    ['no header', undefined],
    ['another token', `Bearer ${'b'.repeat(40)}`],
    ['a prefix of the token', `Bearer ${TOKEN.slice(0, 39)}`],
    ['the token plus more', `Bearer ${TOKEN}x`],
    ['the token without the scheme', TOKEN],
    ['another scheme', `Basic ${TOKEN}`],
    ['an empty bearer', 'Bearer '],
  ])('%s: refused', (_name, header) => {
    expect(readinessDetailAuthorized(header, TOKEN)).toBe(false);
  });
  it('no token configured: refused whatever is sent (the detail is off)', () => {
    expect(readinessDetailAuthorized('Bearer ', undefined)).toBe(false);
    expect(readinessDetailAuthorized('Bearer undefined', undefined)).toBe(false);
    expect(readinessDetailAuthorized('Bearer ', '')).toBe(false);
  });
});

/*
 * One `/readyz` answer serves every probe for the TTL, and concurrent probes share one run:
 * a flood costs Postgres, Redis and the media workers one probe per interval.
 */
describe('cachedProbe', () => {
  const deferred = <T>() => {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };

  it('concurrent callers share one run in flight', async () => {
    const d = deferred<string>();
    let runs = 0;
    const probe = cachedProbe(() => { runs++; return d.promise; }, 1_000, () => 0);
    const answers = Array.from({ length: 50 }, () => probe());
    d.resolve('ready');
    expect(await Promise.all(answers)).toEqual(Array(50).fill('ready'));
    expect(runs).toBe(1);
  });

  it('an answer serves every caller for the TTL, then the next caller runs again', async () => {
    let t = 0;
    let runs = 0;
    const probe = cachedProbe(async () => `answer ${++runs}`, 1_000, () => t);
    expect(await probe()).toBe('answer 1');
    t = 999;
    for (let i = 0; i < 20; i++) expect(await probe()).toBe('answer 1');
    t = 1_000;
    expect(await probe()).toBe('answer 2');
    expect(runs).toBe(2);
  });

  it('a not-ready answer is cached the same way and replaced once the TTL is up', async () => {
    let t = 0;
    let ready = false;
    const probe = cachedProbe(async () => ({ ready }), 1_000, () => t);
    expect(await probe()).toEqual({ ready: false });
    ready = true;
    t = 500;
    expect(await probe()).toEqual({ ready: false });
    t = 1_000;
    expect(await probe()).toEqual({ ready: true });
  });

  it('a rejected run is not kept: the next caller runs again', async () => {
    let runs = 0;
    const probe = cachedProbe(async () => { if (++runs === 1) throw new Error('boom'); return 'ok'; }, 1_000, () => 0);
    await expect(probe()).rejects.toThrow('boom');
    expect(await probe()).toBe('ok');
    expect(runs).toBe(2);
  });
});

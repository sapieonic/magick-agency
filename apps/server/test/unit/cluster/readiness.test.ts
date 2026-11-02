import { describe, expect, it } from 'vitest';
import { clusterReadiness } from '../../../src/cluster/readiness.js';
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

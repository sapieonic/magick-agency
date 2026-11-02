/**
 * `/readyz` for a primary with media workers (`docs/scaling.md` §6.6, decision D5).
 *
 * Ready while the primary is not draining and at least one media worker answers its health
 * ping and is not draining. Every worker's state is in the body, so a worker that is slow
 * (its ping missed the 1 s deadline), restarting (up to 30 s of backoff) or draining is
 * visible without taking the host out of rotation: the ALB and the uptime check point at
 * `/readyz`, and on a single host a 503 takes ALL traffic away, which is worse than losing
 * the 1/N of the floor that worker serves. The host is not ready when no worker answers
 * (no station can attach, no call can bridge) or when the primary itself is shutting down.
 * A dead or slow worker is alerted on (`agy-cluster-child-crash`, the loop panels), not
 * hidden: the body names it.
 */
import type { HealthBody } from './ipc-protocol.js';

export type MediaWorkerState = 'ok' | 'draining' | 'not_answering';

export interface MediaWorkerReadiness {
  slot: number;
  state: MediaWorkerState;
}

export interface ClusterReadiness {
  ready: boolean;
  /** What `/readyz` shows in its body: each media worker's state and how many answer. */
  summary: { mediaWorkers: { answering: number; total: number; workers: MediaWorkerReadiness[] } };
}

/** `health` is `MediaCluster.health()`: one entry per slot, null for a slot that did not answer. */
export function clusterReadiness(primaryDraining: boolean, health: ReadonlyArray<HealthBody | null>): ClusterReadiness {
  const workers = health.map((h, slot): MediaWorkerReadiness => ({
    slot,
    state: h === null ? 'not_answering' : h.draining ? 'draining' : 'ok',
  }));
  const answering = workers.filter((w) => w.state === 'ok').length;
  return {
    ready: !primaryDraining && answering > 0,
    summary: { mediaWorkers: { answering, total: workers.length, workers } },
  };
}

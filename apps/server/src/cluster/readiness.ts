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
import { createHash, timingSafeEqual } from 'node:crypto';
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

/**
 * Whether a `/readyz?detail=1` request may see the per-process detail (pids, loop numbers,
 * the host's Postgres budget): its `Authorization` is `Bearer <READYZ_DETAIL_TOKEN>`. No
 * token configured means the detail is off. Both sides are hashed first, so the comparison
 * is constant-time whatever the lengths. Not IP-based: behind the proxy `request.ip` is what
 * `TRUST_PROXY_HOPS` makes of `X-Forwarded-For`, and the proxy itself is local.
 */
export function readinessDetailAuthorized(authorization: string | undefined, token: string | undefined): boolean {
  if (!token || !authorization?.startsWith('Bearer ')) return false;
  const digest = (v: string): Buffer => createHash('sha256').update(v).digest();
  return timingSafeEqual(digest(authorization.slice('Bearer '.length)), digest(token));
}

/** How long one `/readyz` answer serves every probe that follows it. */
export const READINESS_CACHE_MS = 1_000;

/**
 * `run`, at most once per `ttlMs` and never twice at a time: callers within `ttlMs` of the
 * last answer get it, callers while a run is in flight join it. So a flood of `/readyz` costs
 * Postgres, Redis and the media workers (one `health.ping` each over IPC) one probe a
 * second, not one per request. A not-ready answer is cached the same way: it is at most
 * `ttlMs` old, beside a load balancer that probes every few seconds. A rejected run is not
 * kept (the next caller runs again).
 */
export function cachedProbe<T>(run: () => Promise<T>, ttlMs: number, now: () => number = Date.now): () => Promise<T> {
  let last: { at: number; value: T } | null = null;
  let inFlight: Promise<T> | null = null;
  return () => {
    if (last && now() - last.at < ttlMs) return Promise.resolve(last.value);
    if (inFlight) return inFlight;
    const p = run().then((value) => {
      last = { at: now(), value };
      return value;
    }).finally(() => { inFlight = null; });
    inFlight = p;
    return p;
  };
}

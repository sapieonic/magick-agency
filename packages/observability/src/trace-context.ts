import { context } from '@opentelemetry/api';

/**
 * Bind every callback-form `pool.connect(cb)` to the caller's context.
 *
 * The pg instrumentation runs with `ignoreConnectSpans: true` (`PG_TRACE_CONFIG`
 * in the server's `otel-sdk-config.ts`). That option makes it return before
 * the code that bound a connect callback to the caller's context, and pg-pool
 * does no binding of its own. When a caller has to wait for a connection, its
 * callback runs inside whichever caller RELEASES one. `pool.query` uses the
 * callback form internally, so under pool contention a waiter's `pg.query`
 * span became a child of the releaser's trace. The promise form needs nothing:
 * an `await` resumes in the awaiting function's own context.
 *
 * The prototype is looked up on each call, so the instrumentation's patch of
 * `Pool.prototype.connect` is still the method that runs, and binding a pool
 * twice is harmless. Without a registered OTel context manager `context.bind`
 * returns the callback unchanged.
 *
 * A subpath module rather than an export of the package index, so the many
 * suites that mock `@magick-agency/observability` with an explicit factory are
 * unaffected.
 */
export function bindPoolConnectContext<P extends { connect: unknown }>(pool: P): P {
  const proto = Object.getPrototypeOf(pool) as { connect: (this: P, cb?: unknown) => unknown };
  const connect = function connect(this: P, callback?: unknown): unknown {
    return typeof callback === 'function'
      ? proto.connect.call(this, context.bind(context.active(), callback as (...args: unknown[]) => void))
      : proto.connect.call(this);
  };
  (pool as { connect: unknown }).connect = connect;
  return pool;
}

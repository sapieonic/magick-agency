import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Ambient, async-scoped logging context. Whatever is placed here is injected
 * into *every* log line emitted while the current async execution (and anything
 * it awaits or spawns) is running — see the pino `mixin` wired in
 * `src/utils/logger.ts`. This is the single central place that stamps
 * cross-cutting identifiers (tenantId, accountId, …) onto logs, so individual
 * loggers and call sites never have to pass them by hand.
 *
 * Entry points establish the context:
 *  - HTTP requests: the Fastify `childLoggerFactory`
 *    (`src/api/middleware/log-context.ts`) seeds it from the tenant/account
 *    headers, covering route handlers, their module-level loggers, and any
 *    fire-and-forget work they spawn.
 *  - Background jobs without an HTTP request: wrap the unit of work in
 *    `runWithLogContext({ tenantId, accountId }, fn)`.
 */
export interface LogContext {
  tenantId?: string;
  accountId?: string;
  callId?: string;
  /** Where the request/call was originated from (`x-mgkvc-originator` header). */
  originator?: string;
  /** Human-readable tenant name (`x-mgkvc-tenant-name` header; set by the public API layer). */
  tenantName?: string;
  /** Human-readable account name (`x-mgkvc-account-name` header; set by the public API layer). */
  accountName?: string;
  [key: string]: unknown;
}

const storage = new AsyncLocalStorage<LogContext>();

/** Returns the active log context, or `undefined` when none is set. */
export function getLogContext(): LogContext | undefined {
  return storage.getStore();
}

/**
 * Runs `fn` with `context` bound for its entire (sync + async) execution.
 * Preferred at background entry points where a callback boundary is natural —
 * the context is automatically torn down when `fn` settles.
 */
export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  return storage.run(context, fn);
}

/**
 * Seeds `context` for the remainder of the current async execution without a
 * callback wrapper. Use at entry points where wrapping isn't ergonomic (e.g.
 * a Fastify hook / childLoggerFactory). Each request runs in its own async
 * context, so concurrent requests never see each other's values.
 */
export function setLogContext(context: LogContext): void {
  storage.enterWith(context);
}

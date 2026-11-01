import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from 'fastify';
import { setLogContext } from '@magick-agency/observability';
import { parseClientHeader } from '../../utils/client-header.js';

/**
 * `onRequest`, app-wide: stamp which app sent the request (`X-Client`,
 * `parseClientHeader`) onto every log line the request produces, as `client` (`web` |
 * `mobile`), plus `clientVersion` / `clientPlatform` for the mobile app.
 *
 * Through the ambient log context (`@magick-agency/observability`'s `mixin`), so every
 * module logger a handler reaches carries it without being passed anything. A fresh
 * context per request, never a merge: an upstream proxy reuses connections across
 * clients, and a merge could carry one client's fields into the next request's lines.
 *
 * Cheap on purpose: one header read and one bounded parse, synchronous, no I/O. Logging
 * only: never an auth input and never a rate-limit key.
 */
export function clientLogContextHook(request: FastifyRequest, _reply: FastifyReply, done: HookHandlerDoneFunction): void {
  const client = parseClientHeader(request.headers['x-client']);
  setLogContext({
    client: client.kind,
    ...(client.version ? { clientVersion: client.version } : {}),
    ...(client.platform ? { clientPlatform: client.platform } : {}),
  });
  done();
}

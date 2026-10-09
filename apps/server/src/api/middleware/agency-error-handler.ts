import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { errorHandler } from './error-handler.middleware.js';

/**
 * Master's `errorHandler` plus the 22P02 backstop (B1's Phase 8 carry-forward).
 *
 * Every id that reaches SQL is validated at the edge first (`agency-id-guard.ts`, each
 * family's own schema, core's parsers); this is the net under that, so an id that slips
 * past a guard answers 400 rather than a 500. Postgres's message is not echoed: it quotes
 * the caller's value back inside driver text.
 *
 * Installed twice: app-wide in `app.ts` (every route, as master's `errorHandler` was —
 * master `src/index.ts:481`) and on the private core handler instance (`core-handlers.ts`),
 * because a `22P02` raised inside a core handler is answered THERE and reaches master's
 * handler as a `{ status }` from `callCore`, never as a throw the outer handler could see.
 * A 5xx from either is masked on the way out by `errorMaskHook` (app-wide).
 */
export function agencyErrorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply): void {
  if ((error as { code?: unknown }).code === '22P02' && !error.statusCode) {
    const invalid = Object.assign(new Error('Invalid identifier'), { name: 'Bad Request', statusCode: 400 });
    errorHandler(invalid as FastifyError, request, reply);
    return;
  }
  errorHandler(error, request, reply);
}

import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Answers that name a customer or a supervisor are never cached by a browser or a proxy:
 * `Cache-Control: no-store`.
 */
export function noStore(reply: FastifyReply): void {
  void reply.header('Cache-Control', 'no-store');
}

/** {@link noStore} on every answer of a plugin, refusals included: register as its `onRequest` hook. */
export async function noStoreHook(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
  noStore(reply);
}

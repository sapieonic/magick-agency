import type { FastifyReply } from 'fastify';
import type { z } from 'zod';

/**
 * Validate a body, query or params object, or answer the caller's 400 — in the wire shape
 * of the surface the route belongs to. The shapes are DIFFERENT on purpose and stay so:
 * clients key off them, and each surface has always answered its own.
 *
 *  - `'agency'` — the public agency routes (`/proxy/agency/...`, `/dnc`):
 *    `{ error: 'Validation Error', details: <zod flatten()> }`;
 *  - `'platform'` — the platform and super-admin routes:
 *    `{ error: 'Bad Request', details: <zod issues> }`.
 *
 * The internal handler instance's `{ error: 'Validation failed', details }` is not a zod
 * shape; see {@link replyValidationFailed}.
 *
 * Returns `{ data }`, or `null` once it has replied (the caller returns `reply`). Every 4xx
 * passes `errorMaskHook` untouched, `details` included.
 */
export type ValidationDialect = 'agency' | 'platform';

export function parseOr400<S extends z.ZodTypeAny>(
  schema: S,
  value: unknown,
  reply: FastifyReply,
  dialect: ValidationDialect,
): { data: z.infer<S> } | null {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { data: parsed.data as z.infer<S> };
  void reply.code(400).send(
    dialect === 'agency'
      ? { error: 'Validation Error', details: parsed.error.flatten() }
      : { error: 'Bad Request', details: parsed.error.issues },
  );
  return null;
}

/**
 * The internal handler instance's 400: `{ error: 'Validation failed', details }`, where
 * `details` names the offending field(s) in the handler's own words.
 */
export function replyValidationFailed(reply: FastifyReply, details: unknown): FastifyReply {
  return reply.code(400).send({ error: 'Validation failed', details });
}

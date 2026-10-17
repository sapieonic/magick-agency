import type { FastifyReply, FastifyRequest } from 'fastify';
import { decodeKeysetCursor, type AgencyKeysetPosition } from '@magick-agency/domain/keyset-cursor';

/**
 * Parse `?cursor=` into a keyset position, for the internal handlers' keyset lists (the
 * campaign spine and the per-agent attempt record).
 *
 * A malformed cursor is **400, not a silent reset to page one**. A list that quietly
 * restarts from the top reads as duplicate rows to whoever is scrolling it, and there is
 * no way to tell that from real duplicates. The decoder is imported, so there is one
 * definition of what a cursor is.
 *
 * Returns `undefined` for "no cursor supplied", `null` once it has replied.
 */
export function readKeysetCursor(
  request: FastifyRequest,
  reply: FastifyReply,
): AgencyKeysetPosition | null | undefined {
  const raw = (request.query as { cursor?: unknown } | undefined)?.cursor;
  if (raw === undefined || raw === null || String(raw).length === 0) return undefined;
  const decoded = decodeKeysetCursor(String(raw));
  if (!decoded) {
    reply.code(400).send({
      error: 'Validation failed',
      code: 'malformed_cursor',
      details: { cursor: 'not a cursor this API issued' },
    });
    return null;
  }
  return decoded;
}

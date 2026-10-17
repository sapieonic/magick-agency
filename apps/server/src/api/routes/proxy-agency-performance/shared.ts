/*
 * The name-lookup warning both halves of the performance plugin log. Part of
 * `proxy-agency-performance.routes.ts`.
 */
import type { FastifyRequest } from 'fastify';
import { createChildLogger } from '@magick-agency/observability';

const log = createChildLogger({ component: 'proxy-agency-performance' });

/**
 * Log-and-continue for a failed name lookup; see the module header in
 * `proxy-agency-performance.routes.ts`.
 */
export function warnNameLookup(request: FastifyRequest, surface: string) {
  return (err: unknown) => {
    log.warn(
      {
        tenantId: request.tenantId,
        surface,
        err: err instanceof Error ? err.message : String(err),
      },
      'agency agent performance: name resolution failed; emitting agent_name: null',
    );
  };
}

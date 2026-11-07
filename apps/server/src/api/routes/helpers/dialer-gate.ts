/*
 * The dialer-flag gate of the proxy read families (insights, customer history): the internal
 * handlers' `gate` (`agency-campaigns/guards.ts`), answered byte for byte.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getFeatureFlagService, FLAGS } from '../../../feature-flags/index.js';

/** The internal handlers' `gate` refusal (`agency-campaigns/guards.ts`), byte for byte. */
export const DIALER_DISABLED_BODY = {
  error: 'Feature Not Enabled', code: 'feature_disabled', message: 'Agency dialer is not enabled for this account.',
} as const;

/**
 * The dialer flag (`agency_dialer_enabled`) for the request's tenant and account, else `403
 * feature_disabled`. False once it has replied. A flag read that throws propagates (a 500): the
 * flag fails closed.
 */
export async function dialerEnabled(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const enabled = await getFeatureFlagService().isEnabled(FLAGS.agency_dialer_enabled, {
    tenantId: request.tenantId!,
    ...(request.accountId ? { accountId: request.accountId } : {}),
  });
  if (!enabled) {
    await reply.code(403).send(DIALER_DISABLED_BODY);
    return false;
  }
  return true;
}

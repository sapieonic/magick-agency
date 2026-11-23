/*
 * AA1's rule, for every write that is the whole organisation's rather than one account's: adding
 * an account (`POST /accounts`) and writing an organisation campaign template (CT3).
 *
 * `requirePermission` proves the ROLE. A `tenant_admin` whose membership is scoped to one account
 * (super-admin can add one) holds the role but not the tenant: such a write is refused 403
 * `tenant_wide_membership_required`. The console sends these requests without `X-Account-Id`, so
 * the tenant-context middleware picks the caller's tenant-wide membership when they hold one
 * beside an account seat.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { CreateAccountErrorCode } from '@magick-agency/contracts/api/platform/auth';
import { sendRefusal } from './refusal.js';

/** The code, as the account create declares it (`CreateAccountErrorCode`). */
const TENANT_WIDE_MEMBERSHIP_REQUIRED = 'tenant_wide_membership_required' satisfies CreateAccountErrorCode;

/**
 * Whether the request's membership is scoped to one account; then the 403
 * `tenant_wide_membership_required` has been sent with `message` and the caller returns `reply`.
 */
export function tenantWideSeatRefused(request: FastifyRequest, reply: FastifyReply, message: string): boolean {
  if ((request.membership?.account_id ?? null) === null) return false;
  void sendRefusal(reply, 403, TENANT_WIDE_MEMBERSHIP_REQUIRED, message);
  return true;
}

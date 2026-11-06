/*
 * What the customer-history routes share: the guard chain after the permission, the refusal
 * bodies, the search lookup and the audit row. Part of `proxy-agency-customers.routes.ts`.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { UserRecord } from '@magick-agency/db/models/user.model';
import type {
  CustomerHistoryErrorCode,
  CustomerHistoryErrorResponse,
  CustomerSearchNumberError,
} from '@magick-agency/contracts/api/agency/customer-history';
import { getFeatureFlagService, FLAGS } from '../../../feature-flags/index.js';
import type { ChargeUserRateLimit } from '../../middleware/rate-limit.middleware.js';
import { platformAuditLogger } from '../../../audit/platform/audit-logger.js';
import { requestAuditActor } from '../../../audit/platform/audit-actor.js';
import type { CustomerSearchRecord, CustomerSearchStore } from '../../../agency/customer-history/search-store.js';
import type { CustomerHistoryViewer } from '../../../agency/customer-history/visibility.js';
import { DIALER_DISABLED_BODY } from '../proxy-agency-insights/shared.js';

export { DIALER_DISABLED_BODY };

/** What every route of the family is given at registration. */
export interface CustomerRoutesDeps {
  store: CustomerSearchStore;
  /** The per-user search cap (`chs:<user id>`, CH11), charged by search and export. */
  cap: ChargeUserRateLimit;
  exportMaxRows: number;
}

const ERROR_LABEL: Record<CustomerHistoryErrorCode, string> = {
  invalid_number: 'Bad Request',
  invalid_search_request: 'Bad Request',
  invalid_cursor: 'Bad Request',
  search_expired: 'Not Found',
};

export function refusal(
  code: CustomerHistoryErrorCode,
  message: string,
  numberError?: CustomerSearchNumberError,
): CustomerHistoryErrorResponse {
  return { error: ERROR_LABEL[code], code, message, ...(numberError ? { number_error: numberError } : {}) };
}

export const SEARCH_EXPIRED_BODY = refusal('search_expired', 'This search has expired. Search the number again.');
export const INVALID_CURSOR_BODY = refusal('invalid_cursor', 'This page of results is no longer valid. Load the history again.');

/**
 * The guards every route runs after `requirePermission('agency.customer_history.read')`, in the
 * documented order (§2): the dialer flag for the request's tenant and account (`403
 * feature_disabled`, the flag every agency read checks), then, for search and export, the
 * per-user search cap (a thrown 429). False once it has replied.
 */
export async function guardCustomerRoute(
  request: FastifyRequest,
  reply: FastifyReply,
  cap: ChargeUserRateLimit | null,
): Promise<boolean> {
  const enabled = await getFeatureFlagService().isEnabled(FLAGS.agency_dialer_enabled, {
    tenantId: request.tenantId!,
    ...(request.accountId ? { accountId: request.accountId } : {}),
  });
  if (!enabled) {
    await reply.code(403).send(DIALER_DISABLED_BODY);
    return false;
  }
  if (cap) await cap(request as FastifyRequest & { user: UserRecord }, reply);
  return true;
}

/** The body, or the family's `400 invalid_search_request` (the first problem, by path). */
export async function parseBody<S extends z.ZodTypeAny>(
  schema: S,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<z.infer<S> | null> {
  const parsed = schema.safeParse(request.body ?? {});
  if (parsed.success) return parsed.data as z.infer<S>;
  const issue = parsed.error.issues[0];
  const where = issue && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  await reply.code(400).send(refusal('invalid_search_request', `${where}${issue?.message ?? 'Invalid request'}`));
  return null;
}

/** The caller's own live search, or the `404 search_expired` (unknown, expired and another user's alike). */
export async function ownSearch(
  store: CustomerSearchStore,
  searchId: string,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<CustomerSearchRecord | null> {
  const record = await store.find(searchId, request.tenantId!, request.user!.id);
  if (!record) {
    await reply.code(404).send(SEARCH_EXPIRED_BODY);
    return null;
  }
  return record;
}

/** Answers that name a customer are never cached by a browser or a proxy. */
export function noStore(reply: FastifyReply): void {
  void reply.header('Cache-Control', 'no-store');
}

/**
 * The audit row of a search or an export (CH10): written on success, zero results included.
 * `resource_id` is the search id; `details.value` the E.164 searched (the audit trail is where the
 * number IS recorded, on purpose: who looked up whom).
 */
export function auditCustomerHistory(
  request: FastifyRequest,
  input: {
    action: 'agency_customer_history.searched' | 'agency_customer_history.exported';
    searchId: string;
    record: Pick<CustomerSearchRecord, 'by' | 'value'>;
    viewer: CustomerHistoryViewer;
    resultCount: number;
    extra?: Record<string, unknown>;
  },
): void {
  platformAuditLogger.log({
    tenant_id: request.tenantId!,
    ...(request.accountId ? { account_id: request.accountId } : {}),
    ...requestAuditActor(request),
    action: input.action,
    resource_type: 'customer_history',
    resource_id: input.searchId,
    details: {
      by: input.record.by,
      value: input.record.value,
      result_count: input.resultCount,
      accounts: [...input.viewer.accounts.keys()],
      role: input.viewer.highestRole,
      ...(input.extra ?? {}),
    },
  });
}

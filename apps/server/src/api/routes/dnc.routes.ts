import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sessionMiddleware } from '../../auth/session.middleware.js';
import { tenantContextMiddleware } from '../middleware/tenant-context.middleware.js';
import { requirePermission } from '../../rbac/rbac.middleware.js';
import { accountRepository } from '@magick-agency/db/repositories/account.repository';
import { dncService, DNC_ADD_MAX_NUMBERS } from '../../dnc/dnc.service.js';
import { DNC_SOURCES, dncScopeLabel, dncScopeUuid, type DncSource } from '../../dnc/dnc.repository.js';
import { createChildLogger } from '@magick-agency/observability';
import { platformAuditLogger } from '../../audit/platform/audit-logger.js';
import { requestAuditActor } from '../../audit/platform/audit-actor.js';

const log = createChildLogger({ component: 'dnc-routes' });

/**
 * `/dnc` — the Do Not Call list.
 *
 * **Served directly, not through `callCore`.** DNC is compliance state in
 * `dnc_entries`, and the dial-time check reads that table directly
 * (`DncRegistry.check`, decision B8), so every scope written here is enforced at
 * dial time.
 *
 * ── Two floors, not one ─────────────────────────────────────────────────────
 * Read is `viewer`; add and delete are `account_admin` (`agency.dnc.manage`).
 * The agent-facing path is a different route entirely
 * (`POST /proxy/agency/attempts/:id/dnc`, floored at `agent`) and is
 * attempt-scoped: an agent suppresses the number on their own line, never an
 * arbitrary one, and never removes anything. See `@magick-agency/contracts/rbac`.
 *
 * The RBAC floors are the gate here; there is no product-level capability to
 * check, since every tenant here is an agency tenant.
 */

/**
 * Numbers arrive as an array even for a single add.
 *
 * One shape rather than two routes because the bulk path is the one that will be
 * used against a regulator list, and a separate single-number route is where the
 * two implementations drift — the single one grows normalisation the bulk one
 * lacks, or vice versa, and the difference is invisible until a number silently
 * fails to suppress.
 */
const addSchema = z.object({
  phone_numbers: z.array(z.string().min(1).max(40)).min(1).max(DNC_ADD_MAX_NUMBERS),
  /**
   * Omitted ⇒ tenant-wide. Every scope is enforced at dial time by the
   * `dnc_entries` read.
   *
   * BOTH scope fields use `dncScopeUuid()` rather than a bare `.uuid()`, and both
   * halves matter: `uq_dnc_scope` COALESCEs `account_id` and `campaign_id` to the
   * same sentinel, so either one spelled as the nil UUID produces an index key
   * identical to a tenant-wide row's while the row is not tenant-wide. A later
   * genuine tenant-wide add for that number then collides, writes nothing, and is
   * reported as an idempotent success. This is the bulk path too —
   * `phone_numbers` takes up to `DNC_ADD_MAX_NUMBERS` — so one sentinel scope on
   * one import can bury a whole regulator list's worth of numbers in a scope
   * nothing enforces at dial time.
   */
  account_id: dncScopeUuid().nullish(),
  campaign_id: dncScopeUuid().nullish(),
  source: z.enum(DNC_SOURCES as unknown as [DncSource, ...DncSource[]]).default('api'),
  reason: z.string().max(1000).optional(),
});

/**
 * `account_id` / `campaign_id` accept the literal string `'tenant'` to mean "rows
 * with a NULL scope". Absent means "any scope".
 *
 * A bare `?account_id=` (empty) would otherwise be indistinguishable from absent,
 * and "show me the tenant-wide rows" — the ones that block the number in every
 * campaign — is the single most useful filter here.
 */
const listSchema = z.object({
  phone: z.string().min(1).max(40).optional(),
  account_id: z.union([z.literal('tenant'), z.string().uuid()]).optional(),
  campaign_id: z.union([z.literal('tenant'), z.string().uuid()]).optional(),
  source: z.enum(DNC_SOURCES as unknown as [DncSource, ...DncSource[]]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** `'tenant'` → null (IS NULL), a uuid → itself, absent → undefined (no filter). */
function scopeFilter(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value === 'tenant' ? null : value;
}

/**
 * The account this caller's membership is scoped to — `null` for tenant-wide
 * (or a key/membership that carries no per-account restriction at all).
 *
 * ── The hole this closes ────────────────────────────────────────────────────
 * `requirePermission('agency.dnc.manage'|'agency.dnc.read')` proves the
 * caller's ROLE and never looks at which account they belong to, and neither
 * `POST /dnc`'s body nor `GET /dnc`'s query is bound to the caller's own
 * membership anywhere else. An `account_admin` scoped to account A could
 * therefore: omit `account_id` to write a TENANT-WIDE suppression that blocks
 * dialing for every account, not just theirs; name account B to plant a
 * suppression there; or `GET /dnc?account_id=B` to read B's compliance list.
 *
 * `request.membership.account_id` is the authority, exactly as
 * `auditAccountScope` in `audit.routes.ts` uses it for `GET /audit-log` — never
 * `request.accountId`/`X-Account-Id`, which `tenantContextMiddleware` accepts
 * from an unauthenticated header and which an account-scoped membership need
 * not even have been asked to name (the tenant-context fallback resolves an
 * account-scoped caller's own membership even with no header at all).
 */
function callerAccountScope(request: FastifyRequest): string | null {
  return request.membership?.account_id ?? null;
}

/**
 * Does an account-scoped caller's own account match what they asked for?
 *
 * `requested` is `undefined` for "did not name a scope" (POST's default body,
 * GET's absent filter), `null` for an explicit tenant-wide ask (`account_id:
 * null`, or `?account_id=tenant`), or a uuid for a specific account.
 *
 * A tenant-wide membership (`callerAccountScope` returns `null`) may ask for
 * anything, including nothing — that is what "tenant-wide" means. An
 * account-scoped membership may ask for ONLY its own account: asking for
 * nothing, for the tenant, or for a sibling account are all refused, because
 * "say nothing" on the write path silently produces the tenant-wide row this
 * guards against, and the other two are exactly the cross-account read/write.
 */
function accountScopeAllows(request: FastifyRequest, requested: string | null | undefined): boolean {
  const callerAccountId = callerAccountScope(request);
  return callerAccountId === null || requested === callerAccountId;
}

export async function dncRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', sessionMiddleware);
  app.addHook('preHandler', tenantContextMiddleware);

  /** GET /dnc — the list, newest first. */
  app.get('/', {
    preHandler: requirePermission('agency.dnc.read'),
  }, async (request, reply) => {
    const parsed = listSchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', details: parsed.error.flatten() });
    }
    const q = parsed.data;

    // An account-scoped caller may only ever list their OWN account's rows —
    // `?account_id=<sibling>` or `?account_id=tenant` (the raw tenant-wide set)
    // are refused rather than silently narrowed, so the caller learns their
    // filter was rejected instead of quietly seeing a different account's data
    // than the one they asked for. Omitting the filter is not a mismatch: it is
    // FORCED to the caller's own account below, which is what makes a plain
    // `GET /dnc` safe for an account-scoped viewer to call at all.
    const callerAccountId = callerAccountScope(request);
    const requestedAccountId = scopeFilter(q.account_id);
    if (callerAccountId !== null && requestedAccountId !== undefined && requestedAccountId !== callerAccountId) {
      return reply.code(403).send({
        error: 'Forbidden',
        message: 'account_id does not match your account-scoped membership',
      });
    }
    const effectiveAccountId = callerAccountId !== null ? callerAccountId : requestedAccountId;

    const { entries, total } = await dncService.list({
      tenantId: request.tenantId!,
      ...(q.phone !== undefined ? { phone: q.phone } : {}),
      ...(effectiveAccountId !== undefined ? { accountId: effectiveAccountId } : {}),
      ...(scopeFilter(q.campaign_id) !== undefined ? { campaignId: scopeFilter(q.campaign_id) } : {}),
      ...(q.source !== undefined ? { source: q.source } : {}),
      limit: q.limit,
      offset: q.offset,
    });

    return reply.code(200).send({ entries, total, limit: q.limit, offset: q.offset });
  });

  /**
   * POST /dnc — add numbers.
   *
   * Answers **200, not 201**, and always with a per-number breakdown, because a
   * bulk add is normally partially redundant: an operator re-uploading a
   * regulator list wants "412 added, 88 already on the list, 3 invalid", and a
   * bare 201 would tell them nothing about the 91 rows that did not change.
   * Invalid numbers do not fail the request — they are reported, so one
   * mistyped row cannot discard 999 good ones.
   */
  app.post('/', {
    preHandler: requirePermission('agency.dnc.manage'),
  }, async (request, reply) => {
    const parsed = addSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', details: parsed.error.flatten() });
    }
    const body = parsed.data;

    // An account-scoped caller may only write to THEIR OWN account. Omitting
    // `account_id` (⇒ tenant-wide), naming the tenant explicitly, or naming a
    // sibling account are all refused — the dangerous one is the omission,
    // which would otherwise silently create a suppression that blocks dialing
    // for every account in the tenant, not just the caller's own.
    if (!accountScopeAllows(request, body.account_id)) {
      return reply.code(403).send({
        error: 'Forbidden',
        message: 'account_id must match your account-scoped membership',
      });
    }

    /**
     * `account_id` must belong to THIS tenant. `dnc_entries.account_id` is
     * `REFERENCES accounts(id)` with no composite FK back to `tenant_id`
     * (migration 050) — the same shape `POST /users/invite`, credits
     * allocate, and the phone-number tag routes already document and fix.
     * A tenant-wide caller naming a foreign tenant's account id would write
     * a `dnc_entries` row this tenant does not own; dial-time suppression
     * lookups are tenant-scoped so it cannot suppress the OTHER tenant's
     * numbers, but it is the identical write-hygiene gap this PR already
     * treats as load-bearing elsewhere, so it gets the same guard.
     */
    if (body.account_id != null) {
      const targetAccount = await accountRepository.findByIdInTenant(body.account_id, request.tenantId!);
      if (!targetAccount) {
        return reply.code(404).send({ error: 'Not Found', message: 'Account not found' });
      }
    }

    const summary = await dncService.add({
      tenantId: request.tenantId!,
      ...(body.account_id != null ? { accountId: body.account_id } : {}),
      ...(body.campaign_id != null ? { campaignId: body.campaign_id } : {}),
      phoneNumbers: body.phone_numbers,
      source: body.source,
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
      // Attribution is derived from the session, never from the body. A
      // client-supplied `added_by` would make the audit trail of who suppressed
      // a number self-reported.
      ...(request.user?.id ? { addedBy: request.user.id } : {}),
    });

    // Platform audit trail, distinct from the DNC-specific log line
    // above. No phone numbers in `details` — `phone_numbers` is PII and
    // `summary.results` carries `phone_e164` per row; only the count and the
    // per-outcome breakdown are recorded.
    platformAuditLogger.log({
      tenant_id: request.tenantId!,
      ...(body.account_id != null
        ? { account_id: body.account_id }
        : request.accountId ? { account_id: request.accountId } : {}),
      ...requestAuditActor(request),
      action: 'dnc_entry.created',
      resource_type: 'dnc_entry',
      ...(body.campaign_id != null ? { campaign_id: body.campaign_id } : {}),
      details: {
        // Both columns, via the shared helper — an entry carrying an account AND a
        // campaign is the narrowest scope there is, and labelling it `account`
        // recorded a wider reach than the row has. See `dncScopeLabel`.
        scope: dncScopeLabel(body),
        source: body.source,
        requested: body.phone_numbers.length,
        added: summary.added,
        already_present: summary.already_present,
        invalid: summary.invalid,
        ...(body.campaign_id != null ? { campaign_id: body.campaign_id } : {}),
      },
    });

    return reply.code(200).send(summary);
  });

  /**
   * DELETE /dnc/:id — remove one entry, making the number dialable again.
   *
   * 404 rather than 403 for another tenant's id, OR for an entry outside an
   * account-scoped caller's own account (including a tenant-wide entry) — the
   * id is not a capability and whether it exists elsewhere is not this
   * caller's business to learn. An account-scoped caller un-suppressing a
   * TENANT-WIDE entry would make a number dialable for every account, not just
   * theirs, which is exactly the compliance-dangerous direction this route's
   * `account_admin` floor exists to gate.
   */
  app.delete<{ Params: { id: string } }>('/:id', {
    preHandler: requirePermission('agency.dnc.manage'),
  }, async (request, reply) => {
    const callerAccountId = callerAccountScope(request);
    const removed = callerAccountId !== null
      ? await dncService.remove(request.params.id, request.tenantId!, callerAccountId)
      : await dncService.remove(request.params.id, request.tenantId!);
    if (!removed) {
      return reply.code(404).send({ error: 'Not Found', message: 'DNC entry not found' });
    }

    log.info(
      { tenantId: request.tenantId, entryId: removed.id, actor: request.user?.id },
      'DNC entry removed via API',
    );

    // Un-suppression is the reverse of the compliance write above and gets the
    // same audit treatment: scope, not the raw `phone_e164` on `removed`.
    platformAuditLogger.log({
      tenant_id: request.tenantId!,
      ...(removed.account_id
        ? { account_id: removed.account_id }
        : request.accountId ? { account_id: request.accountId } : {}),
      ...requestAuditActor(request),
      action: 'dnc_entry.deleted',
      resource_type: 'dnc_entry',
      resource_id: removed.id,
      ...(removed.campaign_id ? { campaign_id: removed.campaign_id } : {}),
      details: {
        // Read from the deleted ROW, not from a request that carries no scope —
        // and through the same helper as the add, so an un-suppression can never
        // be recorded at a different reach than the suppression it reverses.
        scope: dncScopeLabel(removed),
        source: removed.source,
        ...(removed.campaign_id ? { campaign_id: removed.campaign_id } : {}),
      },
    });

    return reply.code(200).send({ removed });
  });
}

import { createChildLogger } from '@magick-agency/observability';
import { superAdminAuditRepository } from '@magick-agency/db/repositories/super-admin-audit.repository';

const log = createChildLogger({ component: 'super-admin-audit' });

export type SuperAdminAuditEntry = Parameters<typeof superAdminAuditRepository.log>[0];

/**
 * Write one super-admin audit row, never rejecting.
 *
 * The write is fire-and-forget so an audit outage never fails the admin action (Manas,
 * 2026-10-09). It is never swallowed silently, though: an empty `catch` would let an action
 * leave no audit row with nothing anywhere saying so. A failure is logged at ERROR with what
 * the row would have said — action, actor, target, tenant — so it is findable and can be
 * reconstructed. Fire-and-forget sites call `void recordSuperAdminAudit(...)`; the
 * concurrency update and its refusal `await` it.
 *
 * The repository method is called synchronously (in the caller's tick), so the in-flight-write
 * drain in tests (`test/helpers/drain-super-admin-audit.ts`) sees it.
 */
export function recordSuperAdminAudit(entry: SuperAdminAuditEntry): Promise<void> {
  const onError = (err: unknown) => {
    const tenantId = entry.details && typeof entry.details['tenant_id'] === 'string' ? entry.details['tenant_id'] : undefined;
    log.error(
      {
        err,
        action: entry.action,
        actor: { admin_id: entry.admin_id, admin_email: entry.admin_email },
        target: { resource_type: entry.resource_type, resource_id: entry.resource_id ?? null },
        ...(tenantId ? { tenantId } : {}),
      },
      'Super-admin audit write failed — the action succeeded but its audit row was NOT recorded',
    );
  };
  try {
    return Promise.resolve(superAdminAuditRepository.log(entry)).then(() => undefined, onError);
  } catch (err) {
    onError(err);
    return Promise.resolve();
  }
}

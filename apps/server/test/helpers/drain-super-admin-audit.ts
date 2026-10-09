import { superAdminAuditRepository } from '@magick-agency/db/repositories/super-admin-audit.repository';

/**
 * The super-admin routes write their audit row fire-and-forget
 * (`superAdminAuditRepository.log(...).catch(() => {})`, master's shape, kept as
 * ported). In a suite that truncates between cases, a write still in flight when
 * the next `beforeEach` runs `truncateAll()` deadlocks with the TRUNCATE (the
 * INSERT holds `super_admin_audit_log` and wants `super_admins` for its FK; the
 * TRUNCATE takes them in the other order), failing whichever case comes next.
 *
 * `trackSuperAdminAuditWrites()` wraps the singleton's `log` (directly, not with
 * `vi.spyOn`, so a suite's `resetAllMocks` cannot unwrap it) and returns:
 *  - `drain()` — await every write started so far (call it in `afterEach`);
 *  - `restore()` — put the original method back (call it in `afterAll`).
 */
export function trackSuperAdminAuditWrites(): { drain: () => Promise<void>; restore: () => void } {
  const original = superAdminAuditRepository.log;
  const pending: Promise<unknown>[] = [];
  superAdminAuditRepository.log = function tracked(this: typeof superAdminAuditRepository, ...args) {
    const write = original.apply(this, args);
    pending.push(write);
    return write;
  };
  return {
    async drain() {
      await Promise.allSettled(pending.splice(0));
    },
    restore() {
      superAdminAuditRepository.log = original;
    },
  };
}

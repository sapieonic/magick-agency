import { AuditBuffer } from './audit-buffer.js';
import type { CreateAuditLogInput as DbCreateAuditLogInput } from '@magick-agency/db/models/platform/audit.model';
import { createChildLogger } from '@magick-agency/observability';
import type { PlatformAuditAction, PlatformAuditResourceType } from './catalog.js';

/*
 * PORT NOTE (magick-agency): ported from master `src/audit/audit-logger.ts`
 * (v3.24.0) to `audit/platform/` (core's `audit/audit-logger.ts` holds the
 * source path). It writes `platform_audit_log`, the "Console" half of the
 * activity trail (decision B7). Changes:
 *  - exported as `platformAuditLogger` (master: `auditLogger`). Deliberately
 *    NO `auditLogger` alias: in this app that name is core's `audit_logs`
 *    writer (`../audit-logger.ts`), and two same-named loggers writing two
 *    tables is how a row lands in the wrong half of the trail;
 *  - `PlatformCreateAuditLogInput` binds the db model's `CreateAuditLogInput`
 *    to this catalog. Master's model imported the catalog directly; the db
 *    package cannot import the server, so the binding lives here. The effect at
 *    a call site is master's: an action or resource type outside the catalog,
 *    or an actor half-stated, is a compile error on `log({...})`.
 */

/** Master's `CreateAuditLogInput`, bound to the catalog in `./catalog.ts`. */
export type PlatformCreateAuditLogInput = DbCreateAuditLogInput<PlatformAuditAction, PlatformAuditResourceType>;
type CreateAuditLogInput = PlatformCreateAuditLogInput;

const log = createChildLogger({ component: 'audit-logger' });

class AuditLogger {
  private buffer: AuditBuffer;

  constructor() {
    this.buffer = new AuditBuffer();
  }

  start(): void {
    this.buffer.start();
    log.info('Audit logger started');
  }

  log(event: CreateAuditLogInput): void {
    this.buffer.push(event);
  }

  async shutdown(): Promise<void> {
    log.info('Shutting down audit logger, flushing buffer...');
    await this.buffer.forceFlush();
    log.info('Audit logger shut down');
  }

  getBufferSize(): number {
    return this.buffer.getBufferSize();
  }
}

export const platformAuditLogger = new AuditLogger();

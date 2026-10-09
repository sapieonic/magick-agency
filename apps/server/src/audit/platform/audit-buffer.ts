import { auditRepository } from '@magick-agency/db/repositories/platform/audit.repository';
import { createChildLogger } from '@magick-agency/observability';
import type { PlatformCreateAuditLogInput as CreateAuditLogInput } from './audit-logger.js';

// PORT NOTE (magick-agency): ported from master `src/audit/audit-buffer.ts`
// (v3.24.0). Only the imports changed: the repository is the platform one
// (`platform_audit_log`), and `CreateAuditLogInput` is the catalog-bound input
// type declared beside the logger (see `audit-logger.ts`).

const log = createChildLogger({ component: 'audit-buffer' });

const FLUSH_INTERVAL_MS = 500;
const MAX_BUFFER_SIZE = 100;
const MAX_RETRY_ATTEMPTS = 3;

export class AuditBuffer {
  private buffer: CreateAuditLogInput[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing = false;
  private retryCount = 0;

  start(): void {
    this.flushTimer = setInterval(() => {
      this.flush().catch(err => {
        log.error({ err }, 'Periodic audit flush failed');
      });
    }, FLUSH_INTERVAL_MS);
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  push(event: CreateAuditLogInput): void {
    this.buffer.push(event);

    if (this.buffer.length >= MAX_BUFFER_SIZE) {
      this.flush().catch(err => {
        log.error({ err }, 'Buffer-full audit flush failed');
      });
    }
  }

  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;

    const eventsToFlush = [...this.buffer];
    this.buffer = [];

    try {
      await auditRepository.insertBatch(eventsToFlush);
      this.retryCount = 0;
    } catch (err) {
      this.retryCount++;
      log.error({ err, eventCount: eventsToFlush.length, retryCount: this.retryCount }, 'Audit flush failed');

      if (this.retryCount <= MAX_RETRY_ATTEMPTS) {
        this.buffer = [...eventsToFlush, ...this.buffer];
      } else {
        log.error({ droppedCount: eventsToFlush.length }, 'Dropping audit events after max retries');
        this.retryCount = 0;
      }
    } finally {
      this.flushing = false;
    }
  }

  async forceFlush(): Promise<void> {
    this.stop();
    while (this.buffer.length > 0) {
      await this.flush();
    }
  }

  getBufferSize(): number {
    return this.buffer.length;
  }
}

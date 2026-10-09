import { auditRepository } from '@magick-agency/db/repositories/audit.repository';
import type { AuditEvent } from './audit.types.js';
import { createChildLogger } from '@magick-agency/observability';

const log = createChildLogger({ component: 'audit-buffer' });

const FLUSH_INTERVAL_MS = 500;
const MAX_BUFFER_SIZE = 100;
const MAX_RETRY_ATTEMPTS = 3;

export class AuditBuffer {
  private buffer: AuditEvent[] = [];
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

  push(event: AuditEvent): void {
    this.buffer.push(event);

    // Flush immediately for error-severity events
    if (event.severity === 'error') {
      this.flush().catch(err => {
        log.error({ err }, 'Immediate audit flush failed');
      });
      return;
    }

    // Flush when buffer is full
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
        // Put events back in buffer for retry
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
    // Keep flushing until buffer is empty
    while (this.buffer.length > 0) {
      await this.flush();
    }
  }

  getBufferSize(): number {
    return this.buffer.length;
  }
}

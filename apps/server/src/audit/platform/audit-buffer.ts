import { auditRepository } from '@magick-agency/db/repositories/platform/audit.repository';
import { createChildLogger } from '@magick-agency/observability';
import type { PlatformCreateAuditLogInput as CreateAuditLogInput } from './audit-logger.js';

// Buffers `platform_audit_log` writes. `CreateAuditLogInput` is the catalog-bound
// input type declared beside the logger (see `audit-logger.ts`).

const log = createChildLogger({ component: 'audit-buffer' });

const FLUSH_INTERVAL_MS = 500;
const MAX_BUFFER_SIZE = 100;
const MAX_RETRY_ATTEMPTS = 3;

export class AuditBuffer {
  private buffer: CreateAuditLogInput[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing = false;
  /**
   * Settles when the flush that set `flushing` finishes. `forceFlush` awaits it: a
   * buffer-full flush is started without being awaited (the request path never waits on
   * audit), so shutdown routinely lands while one is still writing.
   */
  private inFlight: Promise<void> | null = null;
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
    let settle!: () => void;
    this.inFlight = new Promise<void>((resolve) => { settle = resolve; });

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
      this.inFlight = null;
      settle();
    }
  }

  /**
   * Drain everything, including a batch another caller is still writing.
   *
   * Waits on {@link inFlight} rather than re-calling `flush()`: while `flushing` is set,
   * `flush()` returns at once, and a loop of awaits on an already-settled promise is a
   * microtask-only loop that never yields to the event loop — the in-flight INSERT could
   * then never complete and shutdown would spin forever. Returns only once nothing is
   * buffered AND nothing is on the wire, so the pool can be closed right after it.
   * Terminates: every flush either writes its batch or, after `MAX_RETRY_ATTEMPTS`, drops it.
   */
  async forceFlush(): Promise<void> {
    this.stop();
    for (;;) {
      if (this.inFlight) {
        await this.inFlight;
        continue;
      }
      if (this.buffer.length === 0) return;
      await this.flush();
    }
  }

  getBufferSize(): number {
    return this.buffer.length;
  }
}

import { AuditBuffer } from './audit-buffer.js';
import type { AuditEvent } from './audit.types.js';
import { maskPiiInObject } from '@magick-agency/observability/crypto';
import { createChildLogger } from '@magick-agency/observability';

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

  log(event: AuditEvent): void {
    // Mask PII in event data before storing
    const maskedEvent: AuditEvent = {
      ...event,
      eventData: maskPiiInObject(event.eventData) as Record<string, unknown>,
    };

    this.buffer.push(maskedEvent);
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

export const auditLogger = new AuditLogger();

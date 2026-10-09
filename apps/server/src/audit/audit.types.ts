export type EventCategory = 'call' | 'ai' | 'telephony' | 'system' | 'api' | 'messaging';
export type Severity = 'debug' | 'info' | 'warn' | 'error';

export interface AuditEvent {
  callId?: string;
  tenantId: string;
  accountId: string;
  eventType: string;
  eventCategory: EventCategory;
  severity: Severity;
  eventData: Record<string, unknown>;
  requestId?: string;
  actor?: string;
  ipAddress?: string;
  durationMs?: number;
}

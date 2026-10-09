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

/**
 * NOT the shape of a row read back from `audit_logs`.
 *
 * This is the camelCase *write* shape with an id and a timestamp bolted on. The
 * repository's `SELECT *` reads are typed with it, but Postgres returns the
 * snake_case columns — so `record.eventType` on a value that came out of a
 * `pool.query<AuditRecord>` is `undefined` at runtime with no type error. That
 * held only because nothing outside the repository ever consumed one. Read paths
 * that leave the repository must use {@link AuditLogRow}.
 */
export interface AuditRecord extends AuditEvent {
  id: string;
  timestamp: Date;
}

/** A row as `audit_logs` actually returns it — the read-path counterpart. */
export interface AuditLogRow {
  id: string;
  call_id: string | null;
  tenant_id: string;
  account_id: string;
  event_type: string;
  event_category: EventCategory;
  severity: Severity;
  event_data: Record<string, unknown> | null;
  request_id: string | null;
  actor: string | null;
  ip_address: string | null;
  duration_ms: number | null;
  timestamp: Date;
}

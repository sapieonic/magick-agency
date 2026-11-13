/*
 * The audit marker an internal handler puts on its answer for the public layer's audit row (the
 * push devices', the soft-phone exit's, the inbound close's), taken off before the client sees it.
 */

/** Remove the marker `key` from an internal answer (mutating it) and return its value, or null when there was none. */
export function takeAuditMarker<T>(body: unknown, key: string): T | null {
  if (!body || typeof body !== 'object' || !(key in body)) return null;
  const record = body as Record<string, unknown>;
  const value = record[key] as T | null | undefined;
  delete record[key];
  return value ?? null;
}

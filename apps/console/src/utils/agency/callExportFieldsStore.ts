/**
 * Export with fields' remembered choice (CL50, Manas: "per person for now"): the fields last
 * downloaded with **Remember these fields for this campaign** on, kept in this browser's storage
 * under the user, tenant, account and campaign, the way Home keeps its "Got it"
 * (`hooks/useHomeAcks.ts`). It does not follow the person to another browser.
 *
 * Storage is a convenience: every access is guarded, and with it blocked (a private window,
 * blocked site data, a full quota) the dialog simply opens with nothing ticked.
 */

const PREFIX = 'magick.callExport.fields.v1';

/** The storage key for a user, tenant, account and campaign. */
export function callExportFieldsKey(userId: string, tenantId: string, accountId: string, campaignId: string): string {
  return `${PREFIX}:${userId}:${tenantId}:${accountId}:${campaignId}`;
}

/** The remembered field names, or null when nothing is remembered or storage cannot be read. */
export function readRememberedFields(key: string | null): string[] | null {
  if (!key) return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const names = parsed.filter((item): item is string => typeof item === 'string');
    return names.length > 0 ? names : null;
  } catch {
    // Unreadable or blocked storage: nothing is remembered.
    return null;
  }
}

/** Remember these names; an empty list (or null) forgets the choice. */
export function writeRememberedFields(key: string | null, fields: readonly string[] | null): void {
  if (!key) return;
  try {
    if (!fields || fields.length === 0) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(fields));
  } catch {
    // Full or blocked storage: the choice is not kept, and nothing else changes.
  }
}

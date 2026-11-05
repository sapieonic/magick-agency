/**
 * What a campaign PATCH changed, for its `agency_campaign.config_changed` audit row (IN8).
 *
 * Pure. The internal PATCH handler holds the campaign before the write (its ownership
 * read) and after it (the UPDATE's RETURNING), and compares the two over the fields the
 * body named; it hands the result to the public route on `CONFIG_CHANGE_HEADER`, which
 * writes the row with the signed-in actor. So the public route makes no read of its own
 * for it: a PATCH is still one internal call. Both sides are the handler's serialisation
 * of the same row, so a JSONB value has the same key order on each and `JSON.stringify`
 * equality is value equality; comparing against the BODY instead would call `09:00` →
 * `09:00:00` a change.
 *
 * ── Keeping the row small ──────────────────────────────────────────────────
 * Every changed field is NAMED. Only a value that is small and readable is carried as
 * `{ from, to }`: a scalar (string, number, boolean, null) or a short list of scalars
 * (`calling_days`, `caller_ids`). A JSON field (the retry policy, the disposition
 * catalog, the context layout, break reasons) is a name only: its before and after can
 * be kilobytes each, and the campaign row holds the current value anyway.
 */

/** The fields the handler stamps itself; a PATCH naming them changes nothing the operator set. */
const NOT_CONFIG = new Set(['id', 'tenant_id', 'account_id', 'created_at', 'updated_at', 'status']);

/** A list of scalars this long or shorter carries its values; a longer one is a name only. */
export const CONFIG_AUDIT_MAX_LIST_VALUES = 20;
/** A string this long or shorter carries its value; a longer one is a name only. */
export const CONFIG_AUDIT_MAX_STRING_CHARS = 200;

export interface CampaignConfigChange {
  /** Every field the PATCH changed, in the body's order. */
  fields: string[];
  /** `{ from, to }` for each changed field whose values are small and readable. */
  changes: Record<string, { from: unknown; to: unknown }>;
}

function isScalar(value: unknown): boolean {
  return value === null
    || typeof value === 'number'
    || typeof value === 'boolean'
    || (typeof value === 'string' && value.length <= CONFIG_AUDIT_MAX_STRING_CHARS);
}

function carriesValue(value: unknown): boolean {
  if (isScalar(value)) return true;
  return Array.isArray(value) && value.length <= CONFIG_AUDIT_MAX_LIST_VALUES && value.every(isScalar);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The fields of `patchBody` whose stored value differs between `before` and `after`, or
 * `null` when nothing changed (no row is written then). A field missing from either side
 * is not compared: it is not a column the handler serves.
 */
export function campaignConfigChange(
  patchBody: unknown,
  before: unknown,
  after: unknown,
): CampaignConfigChange | null {
  const body = asRecord(patchBody);
  const was = asRecord(before);
  const now = asRecord(after);
  if (!body || !was || !now) return null;

  const fields: string[] = [];
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of Object.keys(body)) {
    if (NOT_CONFIG.has(field) || !Object.hasOwn(was, field) || !Object.hasOwn(now, field)) continue;
    const from = was[field];
    const to = now[field];
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    fields.push(field);
    if (carriesValue(from) && carriesValue(to)) changes[field] = { from, to };
  }
  return fields.length === 0 ? null : { fields, changes };
}

/** {@link CampaignConfigChange} as a header value: base64url JSON (a name may be non-ASCII). */
export function encodeConfigChange(change: CampaignConfigChange): string {
  return Buffer.from(JSON.stringify(change), 'utf8').toString('base64url');
}

/**
 * The header value back, or `null` when absent or malformed. Defensive: an audit read
 * must never throw out of a write that has already succeeded.
 */
export function decodeConfigChange(value: string | null | undefined): CampaignConfigChange | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    const record = asRecord(parsed);
    if (!record || !Array.isArray(record['fields']) || record['fields'].length === 0
      || !record['fields'].every((f) => typeof f === 'string')) return null;
    const changes = asRecord(record['changes']) ?? {};
    return { fields: record['fields'] as string[], changes: changes as CampaignConfigChange['changes'] };
  } catch {
    return null;
  }
}

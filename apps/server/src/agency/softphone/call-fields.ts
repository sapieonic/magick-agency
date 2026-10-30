/**
 * The soft phone's call fields (docs/softphone.md §3): the values an agent enters
 * on a call, validated against the account's field set IN FORCE when they are
 * saved (`agency_softphone_settings.call_fields`), never the set the call started
 * with. Pure.
 *
 * An unknown key, or a value of the wrong type, is refused (`fields_invalid`, one
 * detail per key), never dropped: dropping it would tell the agent their entry was
 * saved. `required` is enforced only on the outcome (`requireFilled`): live edits
 * may leave a required field empty.
 */
import type { AgencyCallField, AgencyCallFieldValues } from '@magick-agency/contracts/agency';

/** One offending path, as `AgencySoftphoneErrorResponse.details` carries it. */
export interface CallFieldIssue {
  path: string;
  message: string;
}

/** Longest `text` value accepted, in characters. Bounds the JSONB row, not the agent. */
export const CALL_FIELD_TEXT_MAX = 2_000;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isIsoCalendarDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

function typeIssue(field: AgencyCallField, value: unknown): string | null {
  switch (field.type) {
    case 'text':
      if (typeof value !== 'string') return 'must be text';
      return value.length > CALL_FIELD_TEXT_MAX ? `must be at most ${CALL_FIELD_TEXT_MAX} characters` : null;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : 'must be a number';
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be true or false';
    case 'date':
      return typeof value === 'string' && isIsoCalendarDate(value) ? null : 'must be a date (YYYY-MM-DD)';
    case 'choice': {
      if (typeof value !== 'string') return 'must be one of the field\'s options';
      const options = Array.isArray(field.options) ? field.options : [];
      return options.includes(value) ? null : `must be one of: ${options.join(', ')}`;
    }
    default:
      return 'has an unknown type';
  }
}

/**
 * Validate `values` against `fields`.
 *
 * - `values` absent (`undefined`) is `{}`. Anything else that is not a plain
 *   object is one issue at path `fields`.
 * - Every key must name a field; `null` (or a blank string) is "empty" and always
 *   type-valid.
 * - `requireFilled` (the outcome): every `required` field must be non-empty.
 *
 * @returns the values to store (every submitted key, as submitted), or the issues.
 */
export function validateCallFieldValues(
  fields: readonly AgencyCallField[],
  values: unknown,
  opts: { requireFilled: boolean },
): { ok: true; values: AgencyCallFieldValues } | { ok: false; details: CallFieldIssue[] } {
  if (values === undefined) values = {};
  if (values === null || typeof values !== 'object' || Array.isArray(values)) {
    return { ok: false, details: [{ path: 'fields', message: 'must be an object of call-field values' }] };
  }
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const details: CallFieldIssue[] = [];
  const out: AgencyCallFieldValues = {};
  for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
    const field = byKey.get(key);
    if (!field) {
      details.push({ path: `fields.${key}`, message: 'is not a call field of this account' });
      continue;
    }
    if (isEmpty(value)) {
      out[key] = value === undefined ? null : (value as string | null);
      continue;
    }
    const issue = typeIssue(field, value);
    if (issue) details.push({ path: `fields.${key}`, message: `${field.label} ${issue}` });
    else out[key] = value as string | number | boolean;
  }
  if (opts.requireFilled) {
    for (const field of fields) {
      if (field.required && isEmpty((values as Record<string, unknown>)[field.key])) {
        details.push({ path: `fields.${field.key}`, message: `${field.label} is required` });
      }
    }
  }
  return details.length > 0 ? { ok: false, details } : { ok: true, values: out };
}

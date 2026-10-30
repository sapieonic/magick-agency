import { formatDayMonthYear } from '../format/date';
import type { AgencyCallField, AgencyCallFieldValues } from '../../types/softphone';

/**
 * Call details: the values an agent types into the account's call fields
 * (`agency_softphone_settings.call_fields`), and the client half of the rules the
 * server applies to them (`fields_invalid`).
 *
 * The server validates values "against the field set in force when they are
 * saved" and refuses an unknown key or a wrong type rather than dropping it
 * (`AgencyCallFieldValues`), so the console only ever sends keys of the set it
 * rendered, typed as the set says. A required field may be empty while the call
 * is live — it is the OUTCOME that cannot be saved without it.
 */

export type CallFieldValue = AgencyCallFieldValues[string];

export function isEmptyFieldValue(value: CallFieldValue | undefined): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isCalendarDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** What one input produced, typed for its field. Empty text is `null` (absent). */
export function fieldValueFromInput(field: AgencyCallField, raw: string | boolean): CallFieldValue {
  if (field.type === 'boolean') return typeof raw === 'boolean' ? raw : raw === 'true';
  const text = typeof raw === 'string' ? raw : String(raw);
  if (text.trim() === '') return null;
  if (field.type === 'number') {
    const n = Number(text);
    // An unparseable number stays as text so the field can say what is wrong
    // with it, rather than silently becoming empty under the agent's cursor.
    return Number.isFinite(n) ? n : text;
  }
  return text;
}

/** The value as an input's `value` attribute. */
export function fieldInputValue(value: CallFieldValue | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

export const FIELD_REQUIRED_COPY = 'Fill this in before you save the outcome.';

/**
 * One message per field that is wrong, keyed by the field's `key`.
 *
 * `requireFilled` is the outcome's rule: required fields must be filled. Without
 * it (live edits) only a value that cannot be the field's type is an error.
 */
export function validateCallFieldValues(
  fields: readonly AgencyCallField[],
  values: AgencyCallFieldValues,
  options: { requireFilled: boolean },
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const value = values[field.key];
    if (isEmptyFieldValue(value)) {
      if (options.requireFilled && field.required) errors[field.key] = FIELD_REQUIRED_COPY;
      continue;
    }
    switch (field.type) {
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) errors[field.key] = 'Enter a number.';
        break;
      case 'choice':
        if (typeof value !== 'string' || !(field.options ?? []).includes(value)) {
          errors[field.key] = 'Pick one of the options.';
        }
        break;
      case 'date':
        if (typeof value !== 'string' || !isCalendarDate(value)) errors[field.key] = 'Enter a date.';
        break;
      case 'boolean':
        if (typeof value !== 'boolean') errors[field.key] = 'Choose yes or no.';
        break;
      case 'text':
        if (typeof value !== 'string') errors[field.key] = 'Enter text.';
        else if (value.length > 2000) errors[field.key] = 'Keep this under 2,000 characters.';
        break;
    }
  }
  return errors;
}

/**
 * The values to send: only keys of this field set, strings trimmed, empties
 * left out (`null` or absent is empty, and `fields` replaces the stored values
 * wholesale, so leaving a key out clears it).
 */
export function cleanFieldValues(
  fields: readonly AgencyCallField[],
  values: AgencyCallFieldValues,
): AgencyCallFieldValues {
  const out: AgencyCallFieldValues = {};
  for (const field of fields) {
    const value = values[field.key];
    if (isEmptyFieldValue(value)) continue;
    out[field.key] = typeof value === 'string' ? value.trim() : (value as CallFieldValue);
  }
  return out;
}

/** Whether two value sets would save as the same thing. */
export function sameFieldValues(
  fields: readonly AgencyCallField[],
  a: AgencyCallFieldValues,
  b: AgencyCallFieldValues,
): boolean {
  const ca = cleanFieldValues(fields, a);
  const cb = cleanFieldValues(fields, b);
  const keys = new Set([...Object.keys(ca), ...Object.keys(cb)]);
  for (const key of keys) if (ca[key] !== cb[key]) return false;
  return true;
}

/** A saved value for reading (the supervisor's detail, the recent list). */
export function formatFieldValue(field: AgencyCallField | undefined, value: CallFieldValue | undefined): string | null {
  if (isEmptyFieldValue(value)) return null;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (field?.type === 'date' && typeof value === 'string' && isCalendarDate(value)) {
    const [y, m, d] = value.split('-').map(Number) as [number, number, number];
    // Built at local noon from the parts, so the calendar day cannot shift with the reader's zone.
    return formatDayMonthYear(new Date(y, m - 1, d, 12));
  }
  return String(value);
}

/** The field's label in a sentence, falling back to the key for a field since removed from the set. */
export function fieldLabel(fields: readonly AgencyCallField[], key: string): string {
  return fields.find((field) => field.key === key)?.label ?? key.replace(/_/g, ' ');
}

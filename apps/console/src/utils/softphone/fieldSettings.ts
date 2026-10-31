import {
  SOFTPHONE_CALL_FIELDS_MAX,
  SOFTPHONE_CALL_FIELD_KEY_MAX,
  SOFTPHONE_CALL_FIELD_KEY_PATTERN,
  type AgencyCallField,
  type AgencyCallFieldType,
} from '../../types/softphone';

/**
 * The call-fields editor in Settings → Soft phone: the rows an admin edits, and
 * the client half of `settings_invalid` (`docs/softphone.md` §3: at most 20,
 * snake_case keys up to 50 characters, unique; a `choice` needs its options).
 *
 * ── Keys are the field's identity ────────────────────────────────────────────
 * A call stores its values by key, so renaming a key after calls have used it
 * orphans every value saved under the old one — the detail page would show them
 * under a key nobody recognises, and exports stop lining up. The editor therefore
 * locks the key of any field that came from the saved set, and a new field's key
 * follows its label until the admin types one, the same convention the campaign
 * outcome editor uses for codes.
 */

export const CALL_FIELD_TYPE_LABELS: Record<AgencyCallFieldType, string> = {
  text: 'Text',
  number: 'Number',
  choice: 'Choice',
  boolean: 'Yes / No',
  date: 'Date',
};

export interface CallFieldRow {
  key: string;
  label: string;
  type: AgencyCallFieldType;
  /** One option per line, as typed. */
  optionsText: string;
  required: boolean;
  /** The key came from the saved settings: it is fixed. */
  saved: boolean;
  /** The key still follows the label (a new row the admin has not given a key). */
  autoKey: boolean;
}

export function rowsFromFields(fields: readonly AgencyCallField[]): CallFieldRow[] {
  return fields.map((field) => ({
    key: field.key,
    label: field.label,
    type: field.type,
    optionsText: (field.options ?? []).join('\n'),
    required: Boolean(field.required),
    saved: true,
    autoKey: false,
  }));
}

export function parseOptions(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function fieldsFromRows(rows: readonly CallFieldRow[]): AgencyCallField[] {
  return rows.map((row) => {
    const field: AgencyCallField = { key: row.key.trim(), label: row.label.trim(), type: row.type };
    if (row.type === 'choice') field.options = parseOptions(row.optionsText);
    if (row.required) field.required = true;
    return field;
  });
}

/** A key from a label: `Loan account no.` → `loan_account_no`. */
export function keyFromLabel(label: string): string {
  const slug = label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^[0-9_]+/, '');
  return slug.slice(0, SOFTPHONE_CALL_FIELD_KEY_MAX);
}

export function newFieldRow(): CallFieldRow {
  return { key: '', label: '', type: 'text', optionsText: '', required: false, saved: false, autoKey: true };
}

export type FieldRowEdit =
  | { type: 'add' }
  | { type: 'remove'; index: number }
  | { type: 'move'; index: number; delta: -1 | 1 }
  | { type: 'label'; index: number; label: string }
  | { type: 'key'; index: number; key: string }
  | { type: 'patch'; index: number; patch: Partial<Pick<CallFieldRow, 'type' | 'optionsText' | 'required'>> };

/** The editor's one reducer. A saved row's key never changes here, whatever is asked. */
export function editFieldRows(rows: readonly CallFieldRow[], edit: FieldRowEdit): CallFieldRow[] {
  switch (edit.type) {
    case 'add':
      if (rows.length >= SOFTPHONE_CALL_FIELDS_MAX) return [...rows];
      return [...rows, newFieldRow()];
    case 'remove':
      return rows.filter((_, i) => i !== edit.index);
    case 'move': {
      const to = edit.index + edit.delta;
      if (to < 0 || to >= rows.length) return [...rows];
      const next = [...rows];
      [next[edit.index], next[to]] = [next[to]!, next[edit.index]!];
      return next;
    }
    case 'label':
      return rows.map((row, i) =>
        i === edit.index
          ? { ...row, label: edit.label, key: row.saved || !row.autoKey ? row.key : keyFromLabel(edit.label) }
          : row,
      );
    case 'key':
      return rows.map((row, i) => (i === edit.index && !row.saved ? { ...row, key: edit.key, autoKey: false } : row));
    case 'patch':
      return rows.map((row, i) => (i === edit.index ? { ...row, ...edit.patch } : row));
  }
}

/**
 * One message per offending field, keyed by the body path the server's `details`
 * use (`call_fields[2].key`), so a client finding and a server refusal land on
 * the same input.
 */
export function validateCallFieldRows(rows: readonly CallFieldRow[]): Record<string, string> {
  const errors: Record<string, string> = {};
  if (rows.length > SOFTPHONE_CALL_FIELDS_MAX) {
    errors['call_fields'] = `Up to ${SOFTPHONE_CALL_FIELDS_MAX} fields. Remove ${rows.length - SOFTPHONE_CALL_FIELDS_MAX} to save.`;
  }
  const seen = new Set<string>();
  rows.forEach((row, i) => {
    const at = `call_fields[${i}]`;
    const key = row.key.trim();
    if (!SOFTPHONE_CALL_FIELD_KEY_PATTERN.test(key) || key.length > SOFTPHONE_CALL_FIELD_KEY_MAX) {
      errors[`${at}.key`] =
        `Use up to ${SOFTPHONE_CALL_FIELD_KEY_MAX} characters: lowercase letters, digits and underscores, starting with a letter.`;
    } else if (seen.has(key)) {
      errors[`${at}.key`] = `‘${key}’ is already used. Keys must be unique.`;
    } else {
      seen.add(key);
    }
    if (row.label.trim().length === 0) {
      errors[`${at}.label`] = 'Every field needs a label — it is what the agent reads.';
    } else if (row.label.trim().length > 100) {
      errors[`${at}.label`] = 'Keep the label under 100 characters.';
    }
    if (row.type === 'choice') {
      const options = parseOptions(row.optionsText);
      if (options.length === 0) {
        errors[`${at}.options`] = 'A choice needs at least one option — one per line.';
      } else if (new Set(options).size !== options.length) {
        errors[`${at}.options`] = 'Each option must be different.';
      }
    }
  });
  return errors;
}

/** Keys the saved set had that this draft no longer has: values saved under them stay on old calls. */
export function removedSavedKeys(saved: readonly AgencyCallField[], rows: readonly CallFieldRow[]): string[] {
  const kept = new Set(rows.map((row) => row.key));
  return saved.map((field) => field.key).filter((key) => !kept.has(key));
}

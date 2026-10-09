// ---------------------------------------------------------------------------
// Analysis-profile form model + pure transforms
//
// The shape of the "what should we capture from these calls?" form and the rules
// that turn it into a create/update payload. Framework-free (no React) so the
// assembly + filtering logic is unit-testable in isolation, mirroring
// `pages/prompts/promptForm.ts` — which is deliberate: the dimension row is the
// SAME concept in both editors, with the same bounds, so a user who knows one
// knows the other.
// ---------------------------------------------------------------------------

import { toDimensionKey, uniqueDimensionKey, isValidDimensionKey } from '../../utils/snake-case';
import type {
  AnalyticsDimension,
  CallAnalysisProfile,
  CreateCallAnalysisProfileInput,
  UpdateCallAnalysisProfileInput,
} from '../../types/call-analysis-profile';

/**
 * One dimension row as edited. The user types only a DESCRIPTION; `key` is
 * derived from it via `toSnakeCase` and never shown — a snake_case identifier is
 * an implementation detail a non-technical agent shouldn't have to invent.
 * `options` is comma-separated text (not an array) so the input can be typed
 * through freely, including trailing commas mid-edit.
 */
export interface DimensionRow {
  key: string;
  description: string;
  type: 'boolean' | 'string' | 'number' | 'enum';
  options: string;
}

export const EMPTY_DIMENSION: DimensionRow = {
  key: '',
  description: '',
  type: 'string',
  options: '',
};

export interface AnalysisProfileFormData {
  name: string;
  description: string;
  context: string;
  custom_dimensions: DimensionRow[];
  is_default: boolean;
}

export const EMPTY_PROFILE_FORM: AnalysisProfileFormData = {
  name: '',
  description: '',
  context: '',
  custom_dimensions: [],
  is_default: false,
};

/** Plain-language answer types. The raw `string|boolean|number|enum` tokens are
 *  never shown — "Text / Yes-No / Number / Choices" is what a user understands. */
export const DIMENSION_TYPE_LABELS: Record<DimensionRow['type'], string> = {
  string: 'Text',
  boolean: 'Yes / No',
  number: 'Number',
  enum: 'Choices',
};

/** Load an existing profile into the form.
 *
 *  Every field lands in a controlled input and is `.trim()`ed on the very next
 *  render (`toValidDimensions` runs in the page's preview `useMemo`), so a NULL
 *  echoed by core has to become `''` HERE. The dimension list is core's shared
 *  `analyticsDimensionSchema`, stored as JSONB — see `StoredAnalyticsDimension`
 *  — and a prompt template's copy of it blanked the call-script editor for
 *  exactly this reason. */
export function profileToForm(profile: CallAnalysisProfile): AnalysisProfileFormData {
  return {
    name: profile.name,
    description: profile.description ?? '',
    context: profile.context ?? '',
    custom_dimensions: (profile.custom_dimensions ?? []).map(d => ({
      key: d.key ?? '',
      description: d.description ?? '',
      type: d.type,
      // A NULL choice would otherwise join into a stray empty option.
      options: (d.options ?? []).filter(o => o?.trim()).join(', '),
    })),
    is_default: profile.is_default,
  };
}

/**
 * The dimensions that will actually be saved.
 *
 * PERMISSIVE by design (§13): a row the user started and abandoned is silently
 * dropped, not turned into a blocking validation error. Erroring on a half-typed
 * row punishes exploration, and there is nothing the user could usefully do with
 * the error beyond deleting the row we can drop for them.
 *
 * An existing VALID `key` is kept as-is; only a missing or non-conforming one is
 * derived from the description. The key — not the description — identifies a
 * dimension in stored analysis results and in reporting, so re-deriving one that
 * already works would rename it and orphan every value captured under the old
 * name. (Editing a description still re-derives live in the editor, which is the
 * intended way for a key to follow its description.) Keys are then deduped
 * across the list, since two rows sharing a key would silently merge into one
 * captured value.
 * An `enum` with no usable choices degrades to free Text rather than being
 * rejected — core requires ≥2 options for an enum, and silently downgrading beats
 * a 400 the user can't act on.
 */
export function toValidDimensions(rows: DimensionRow[]): AnalyticsDimension[] {
  const live = rows.filter(r => r.description.trim());

  // Preserved keys are reserved BEFORE any are derived, so a new row earlier in
  // the list can't claim a key a stored row already owns and push that stored
  // row to `_2` — which would rename it and orphan its captured values.
  const taken = new Set(
    live.map(r => r.key.trim()).filter(isValidDimensionKey),
  );
  const dims: AnalyticsDimension[] = [];

  for (const row of live) {
    const description = row.description.trim();
    const existing = row.key.trim();
    const preserved = isValidDimensionKey(existing);

    // A description of pure punctuation snake-cases to nothing; core requires a
    // non-empty key, so drop those rather than send an invalid payload.
    const derived = preserved ? existing : toDimensionKey(description);
    if (!derived) continue;

    const options = row.options
      .split(',')
      .map(o => o.trim())
      .filter(Boolean);
    const useEnum = row.type === 'enum' && options.length >= 2;

    // Only a derived key steps aside on collision; a preserved one keeps its name.
    const key = preserved ? derived : uniqueDimensionKey(derived, taken);
    taken.add(key);

    const dim: AnalyticsDimension = {
      key,
      description,
      type: useEnum ? 'enum' : row.type === 'enum' ? 'string' : row.type,
    };
    if (useEnum) dim.options = options;
    dims.push(dim);
  }

  return dims;
}

/** Assemble the create payload. Optional text fields are omitted when blank. */
export function buildCreatePayload(form: AnalysisProfileFormData): CreateCallAnalysisProfileInput {
  const payload: CreateCallAnalysisProfileInput = {
    name: form.name.trim(),
    custom_dimensions: toValidDimensions(form.custom_dimensions),
    is_default: form.is_default,
  };
  if (form.description.trim()) payload.description = form.description.trim();
  if (form.context.trim()) payload.context = form.context.trim();
  return payload;
}

/**
 * Assemble the update payload. Unlike create, blank text is sent as an empty
 * string rather than omitted — on a copy-on-write update an omitted field CARRIES
 * FORWARD from the superseded version, so omitting a cleared field would silently
 * refuse the user's deletion.
 */
export function buildUpdatePayload(form: AnalysisProfileFormData): UpdateCallAnalysisProfileInput {
  return {
    description: form.description.trim(),
    context: form.context.trim(),
    custom_dimensions: toValidDimensions(form.custom_dimensions),
    is_default: form.is_default,
  };
}

/**
 * One plain-language line per dimension for the pre-save preview: what will be
 * captured, and what kind of answer to expect. The point of the preview is that
 * "custom dimensions of type enum" means nothing to an agent, but "Which plan
 * they chose — one of: Basic, Pro" does.
 */
export function describeDimension(dim: AnalyticsDimension): string {
  if (dim.type === 'enum' && dim.options?.length) {
    return `one of: ${dim.options.join(', ')}`;
  }
  if (dim.type === 'boolean') return 'yes or no';
  if (dim.type === 'number') return 'a number';
  return 'a short piece of text';
}

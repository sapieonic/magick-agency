/**
 * Convert free text into a snake_case key, suitable for live transformation
 * as the user types.
 *
 * - Lowercases everything.
 * - Replaces any run of non-alphanumeric characters (spaces, hyphens,
 *   punctuation, etc.) with a single underscore.
 * - Strips leading underscores so a key never starts with `_`.
 *
 * A trailing underscore is intentionally preserved: while typing a
 * multi-word key, "agreed to" becomes "agreed_to_" after the trailing
 * space, so the next word appends cleanly ("agreed_to_pay") instead of
 * being swallowed.
 */
export function toSnakeCase(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+/, '');
}

/**
 * The server's bound on an analysis dimension `key`
 * (`analyticsDimensionSchema` in the server). Mirrored here so the key we derive is
 * always sendable — the user never types the key, so a key that fails
 * validation is a bug on our side, not something they can correct.
 */
export const MAX_DIMENSION_KEY_LENGTH = 50;

/**
 * Derive an analysis-dimension `key` from its human-readable description.
 *
 * The key is an implementation detail (it names a property in the analysis
 * JSON schema and a JSONB key in reporting), so the editors hide it and derive
 * it from what the user typed. That derivation must therefore satisfy the server's
 * `^[a-z][a-z0-9_]*$` + ≤50 contract for ANY description, since the user has no
 * field to fix if it doesn't:
 *
 * - leading non-letters are dropped — the server requires a letter first, so
 *   "2nd attempt" must not derive `2nd_attempt`;
 * - the result is capped at 50 chars, preferring to cut at a word boundary so a
 *   long description yields a readable key rather than a severed word;
 * - trailing underscores are removed (unlike `toSnakeCase`, which keeps one so
 *   a visible key input types cleanly — a derived key is never mid-typed).
 *
 * Returns '' when nothing usable remains (e.g. an all-punctuation description);
 * callers drop those rows rather than sending an invalid key.
 */
export function toDimensionKey(value: string): string {
  const base = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+/, '');

  if (base.length <= MAX_DIMENSION_KEY_LENGTH) return base.replace(/_+$/, '');

  const hard = base.slice(0, MAX_DIMENSION_KEY_LENGTH);
  // Only back off to the previous word boundary when the cap actually severed a
  // word, and only if a word survives — a single 50+ char word keeps the hard cut.
  const severedWord = base[MAX_DIMENSION_KEY_LENGTH] !== '_';
  const lastBoundary = hard.lastIndexOf('_');
  const trimmed = severedWord && lastBoundary > 0 ? hard.slice(0, lastBoundary) : hard;
  return trimmed.replace(/_+$/, '');
}

/**
 * Whether `key` already satisfies the server's contract and can be sent as-is.
 *
 * Used to leave an EXISTING dimension's key alone on save. The key identifies a
 * dimension in stored `call_analysis` results and in reporting aggregates, so
 * silently renaming one on an unrelated edit would orphan every value already
 * captured under the old name. Prompts authored before the key input was hidden
 * carry hand-written keys; those are valid and must survive.
 */
export function isValidDimensionKey(key: string): boolean {
  return key.length > 0 && key.length <= MAX_DIMENSION_KEY_LENGTH && /^[a-z][a-z0-9_]*$/.test(key);
}

/**
 * Make `key` unique against keys already claimed in the same dimension list,
 * appending `_2`, `_3`, … and shortening the stem so the result still fits the
 * 50-char cap.
 *
 * Uniqueness matters because the key — not the description — is what identifies
 * a dimension in the analysis JSON schema and in reporting aggregates. Two
 * similarly-worded descriptions can derive the same key (all the more likely now
 * that long ones are truncated), and a duplicate would silently collapse two
 * captured values into one.
 */
export function uniqueDimensionKey(key: string, taken: Set<string>): string {
  if (!taken.has(key)) return key;
  for (let n = 2; ; n++) {
    const suffix = `_${n}`;
    const stem = key.slice(0, MAX_DIMENSION_KEY_LENGTH - suffix.length).replace(/_+$/, '');
    const candidate = `${stem}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

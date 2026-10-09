/**
 * The contact-panel field filter (§A.6.3).
 *
 * Pure and separate from the component for the same reason `agencyContext`'s
 * resolution rules are: "matches header and value, case-insensitive, substring"
 * is a rule worth testing on its own, not through a rendered `<dl>`.
 *
 * Two functions, one job each:
 *   - `fieldMatchesFilter` decides whether a field survives the filter.
 *   - `highlightSegments` marks WHERE it survived, so the component can wrap the
 *     matched slice in a `<mark>` without re-deriving the match itself.
 *
 * An empty query is "no filter" — every field survives and nothing is marked.
 * This is deliberately NOT the same as trimming the query: a query of a single
 * space is a real (if unlikely) substring search, and silently trimming it would
 * make the box lie about what it is about to search for.
 */

export interface FilterableField {
  label: string;
  value: string;
}

export interface FilterSegment {
  text: string;
  matched: boolean;
}

/** True when `query` is empty, or is a case-insensitive substring of the header or the value. */
export function fieldMatchesFilter(field: FilterableField, query: string): boolean {
  if (query.length === 0) return true;
  const needle = query.toLowerCase();
  return field.label.toLowerCase().includes(needle) || field.value.toLowerCase().includes(needle);
}

/**
 * Splits `text` into segments alternating matched/unmatched, one segment per
 * occurrence of `query` (case-insensitive, non-overlapping, left to right).
 *
 * An empty query, or no occurrence at all, returns the whole text as a single
 * unmatched segment — the caller can render that case with a plain string
 * rather than a fragment of `<mark>`-free spans.
 */
export function highlightSegments(text: string, query: string): FilterSegment[] {
  if (query.length === 0) return [{ text, matched: false }];

  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();

  const segments: FilterSegment[] = [];
  let cursor = 0;
  let index = lowerText.indexOf(lowerQuery, cursor);

  if (index === -1) return [{ text, matched: false }];

  while (index !== -1) {
    if (index > cursor) segments.push({ text: text.slice(cursor, index), matched: false });
    segments.push({ text: text.slice(index, index + query.length), matched: true });
    cursor = index + query.length;
    index = lowerText.indexOf(lowerQuery, cursor);
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), matched: false });

  return segments;
}

/**
 * The shared list-and-re-sync concern behind `BreakMenu` and `DispositionPad`
 *.
 *
 * ── Why one module for two surfaces ──────────────────────────────────────────
 * The server made `agency_campaigns.break_reasons` mirror `disposition_catalog`
 * deliberately: both are JSONB arrays of `{code, label, …}`, both are validated
 * the same way, and both answer an unknown code with a `400` carrying
 * **`allowed_codes`**. Two implementations of that would mean fixing the next bug
 * in it twice, and the bugs here are the quiet kind.
 *
 * ── What is NOT shared, and must not become shared ───────────────────────────
 * **Key bindings.** `1`–`9` belong to the disposition pad alone:
 * reassigning number keys by context is how muscle memory gets destroyed, so the
 * break menu is arrows + `Enter` + typeahead and binds no digits at all. The
 * remap *warning* below is shared; the *bindings* are not. `BreakMenu` passes
 * `boundCount: 0` and therefore never warns, which is the correct answer for a
 * surface with nothing bound.
 */

/** The shape both catalogs have in common. Everything else is per-surface. */
export interface AgencyCatalogEntry {
  code: string;
  label: string;
}

/**
 * A readable label for a code the server accepts but we have never seen.
 *
 * **Only the first character is uppercased; nothing is lowercased.** Case-folding
 * the rest would turn a meaningful acronym (`DNC`) into `Dnc`, which reads as a
 * typo in the one place the agent has no other information to go on.
 */
export function humaniseCode(code: string): string {
  const spaced = code.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (spaced.length === 0) return code;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Rebuild a catalog from a `400`'s `allowed_codes` echo.
 *
 * **Order comes from the server**, exactly as the first-load order does — the
 * catalog is never re-sorted client-side, because a sort silently remaps every
 * agent's muscle memory the moment an admin renames a code and it is invisible in
 * review.
 *
 * **Labels are preserved for codes already known.** The echo carries codes only,
 * so the naive rebuild renders a familiar option as a raw slug (`technical_issue`)
 * in the middle of a shift. That is its own small betrayal: the agent's option did
 * not change, only our knowledge of its name, and showing them a database
 * identifier says otherwise.
 *
 * **An unknown code falls back to a humanised slug rather than being dropped.**
 * Hiding an option the server will accept is worse than naming it imperfectly —
 * the agent cannot pick what is not on screen, and the campaign genuinely accepts
 * it.
 *
 * ⚠️ **A synthesized entry carries no optional flags.** For a disposition that
 * means no `requires_note` / `requires_datetime`, so the client-side guard will
 * not demand a note for it and the server may reject the submit a second time. That is
 * deliberate: inventing a requirement we were never told about would block a
 * legitimate submit, and the server is the real enforcement for criterion (c). The
 * background bootstrap refresh is what makes the *next* call correct.
 *
 * An empty `allowedCodes` yields an empty catalog rather than silently keeping the
 * old one: "the campaign accepts nothing" is a real answer, and the caller's
 * disabled-with-a-stated-reason path is the honest rendering of it.
 */
export function resyncCatalog<T extends AgencyCatalogEntry>(
  current: readonly T[],
  allowedCodes: readonly string[],
): T[] {
  const known = new Map(current.map((entry) => [entry.code, entry]));
  const seen = new Set<string>();
  const next: T[] = [];

  for (const code of allowedCodes) {
    // A server repeating a code must not produce two rows: they would collide on
    // the React key and one would be silently unreachable.
    if (typeof code !== 'string' || code.length === 0 || seen.has(code)) continue;
    seen.add(code);

    const existing = known.get(code);
    if (existing) {
      next.push(existing);
      continue;
    }
    // Sound because `code` and `label` are the only REQUIRED members of both
    // catalog types; every other member is optional and deliberately absent here.
    next.push({ code, label: humaniseCode(code) } as T);
  }

  return next;
}

/**
 * What stays selected after a re-sync.
 *
 * **A code that did not survive returns `null` — never the entry that now occupies
 * that index.** Sliding the selection onto whatever moved into position 3 is how
 * an agent submits "Not interested" for a call they meant to mark a sale: the
 * highlight looks unchanged, so nothing prompts them to re-read it, and the value
 * underneath is different. Losing the selection is visible and costs one
 * keystroke; keeping a wrong one is invisible and costs a customer.
 */
export function selectionAfterResync(
  selectedCode: string | null,
  nextCatalog: readonly AgencyCatalogEntry[],
): string | null {
  if (selectedCode === null) return null;
  return nextCatalog.some((entry) => entry.code === selectedCode) ? selectedCode : null;
}

/**
 * Whether a re-sync moved anything a number key is bound to.
 *
 * **Only positions inside the bound range count.** A catalog change past the ninth
 * entry rebinds nothing, and warning about it teaches the agent that this warning
 * does not mean anything — which is expensive precisely on the day it does.
 *
 * Both directions inside the range are reported, and the growth case is the one
 * worth naming: a key that was a no-op and now selects a code is a *new* binding
 * under a finger that expects nothing to happen. A shrink is reported too, because
 * the warning's job is "your fingers are no longer a guide to this list", and that
 * is equally true when a key stops doing anything.
 *
 * `boundCount: 0` — which is what `BreakMenu` passes — can never warn, because a
 * surface that binds no digits cannot have remapped one.
 */
export function numberKeysRemapped(
  before: readonly AgencyCatalogEntry[],
  after: readonly AgencyCatalogEntry[],
  boundCount: number,
): boolean {
  if (boundCount <= 0) return false;
  const span = Math.min(boundCount, Math.max(before.length, after.length));
  for (let i = 0; i < span; i += 1) {
    if (before[i]?.code !== after[i]?.code) return true;
  }
  return false;
}

/**
 * First-letter typeahead, **scoped to the open menu** — never a global shortcut
 *.
 *
 * **It wraps**, which is the whole point: with two entries starting "L" the agent
 * presses `L` repeatedly to cycle between them, and a non-wrapping search sticks
 * on the last match and reads as a broken key.
 *
 * Non-letters return `null` and select nothing. That is what keeps the break menu
 * honest about binding no digits: pressing `1` in it does not fall through to a
 * typeahead match on some label beginning with "1".
 */
export function typeaheadIndex(
  entries: readonly AgencyCatalogEntry[],
  char: string,
  fromIndex: number | null,
): number | null {
  if (!/^[a-z]$/i.test(char)) return null;
  if (entries.length === 0) return null;

  const target = char.toLowerCase();
  const start = fromIndex === null || fromIndex < 0 ? -1 : fromIndex;

  for (let step = 1; step <= entries.length; step += 1) {
    const index = (start + step + entries.length * 2) % entries.length;
    if (entries[index]?.label.trim().toLowerCase().startsWith(target)) return index;
  }
  return null;
}

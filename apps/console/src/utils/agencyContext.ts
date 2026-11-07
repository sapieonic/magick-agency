import {
  contextValueText,
  heroColumnsFor,
  isBlankContextValue,
  MAX_HERO_FIELDS,
} from '@magick-agency/domain/context-hero';
import type { AgencyContextDisplay } from '../types/agency';

/**
 * Resolves which of a contact's arbitrary CSV columns to show, and in what
 * order (contract `AgencyContextDisplay`).
 *
 * Pure and separate from the component because the resolution rules are a
 * **cross-client contract**: The server's contract states them so "two clients
 * agree", and a rule buried in JSX cannot be tested against that wording.
 *
 * The rules, in precedence order:
 *   1. `hero` first, pinned, in array order;
 *   2. then any column named in `order`, in array order;
 *   3. then every remaining column, in ORIGINAL CSV header order;
 *   4. minus anything in `hidden`, at every stage.
 * A name in more than one list resolves by that precedence, so a column in both
 * `hero` and `hidden` is hidden. An empty/absent display config means "no
 * operator opinion" — render every column in original CSV order.
 *
 * Original CSV order matters and is not alphabetical: the agency built that
 * file and put the thing that matters in column 3.
 */

export interface ResolvedContextField {
  /** Original header text, unchanged, as uploaded. */
  label: string;
  /** Stringified value. Always rendered as TEXT, never as markup. */
  value: string;
  /** True when the value is empty or a placeholder. */
  isEmpty: boolean;
}

export interface ResolvedContext {
  /** Pinned fields, capped. Read while the phone is ringing. */
  hero: ResolvedContextField[];
  /** Everything else with a value, in resolved order. */
  fields: ResolvedContextField[];
  /** Fields whose value is empty or a placeholder, collapsed behind a summary. */
  empty: ResolvedContextField[];
}

/** Hero fields are capped: the contract says "keep it to ~4; the console may cap it". */
export { MAX_HERO_FIELDS };

/**
 * Which columns are heroes is the ONE rule in `@magick-agency/domain/context-hero` (customer
 * history reads it too): the configured `hero` columns, else a heuristic guess (at most one per
 * bucket: a name, an amount, an identifier, a place; skipping empty values), never a hidden one.
 * The panel turns off the rule's last stage (the first columns with a value): it lists every
 * column under the heroes, so with nothing configured or guessed it pins nothing.
 *
 * The UI must present a guess as a guess ("auto-selected"), never as configuration: showing a
 * heuristic's output as if it were the operator's choice is how an agent comes to trust the
 * wrong four fields.
 */
export function resolveContextFields(
  context: Record<string, unknown>,
  display: AgencyContextDisplay | undefined,
  options: { maxHero?: number } = {},
): ResolvedContext {
  const originalOrder = Object.keys(context);

  // Case-insensitive matching, because the operator picks these names from a
  // dropdown we populated from the same headers but a config may be hand-edited.
  const hiddenKeys = new Set((display?.hidden ?? []).map((k) => k.trim().toLowerCase()));
  const isHidden = (key: string): boolean => hiddenKeys.has(key.trim().toLowerCase());

  // `context` is operator-uploaded JSONB: a nested object or an array is unusual
  // but not impossible, and renders as readable text, never `[object Object]`.
  const field = (key: string): ResolvedContextField => ({
    label: key,
    value: contextValueText(context[key]) ?? '',
    isEmpty: isBlankContextValue(context[key]),
  });

  const resolveNames = (names: string[] | undefined): string[] => {
    if (!names) return [];
    const out: string[] = [];
    for (const name of names) {
      const match = originalOrder.find(
        (key) => key.trim().toLowerCase() === name.trim().toLowerCase(),
      );
      // A configured name that is not in this contact's columns is skipped
      // rather than rendered blank: campaigns outlive file formats.
      if (match !== undefined && !isHidden(match) && !out.includes(match)) out.push(match);
    }
    return out;
  };

  // Rule 4 applies at every stage, so a column in both `hero` and `hidden` is hidden.
  const heroKeys = heroColumnsFor(context, display, null, {
    max: options.maxHero ?? MAX_HERO_FIELDS,
    fallbackToFirstColumns: false,
  });

  const heroSet = new Set(heroKeys);
  const orderedKeys = resolveNames(display?.order).filter((key) => !heroSet.has(key));
  const orderedSet = new Set(orderedKeys);

  const remaining = originalOrder.filter(
    (key) => !heroSet.has(key) && !orderedSet.has(key) && !isHidden(key),
  );

  const hero = heroKeys.map(field);
  const rest = [...orderedKeys, ...remaining].map(field);

  return {
    hero,
    // Empty values are pulled out of the main list and summarised, so a
    // 40-column export does not bury the four fields that matter behind
    // twenty blanks.
    fields: rest.filter((f) => !f.isEmpty),
    empty: rest.filter((f) => f.isEmpty),
  };
}

/** True when the operator configured heroes; false when they were guessed. */
export function heroesWereConfigured(display: AgencyContextDisplay | undefined): boolean {
  return Boolean(display?.hero && display.hero.length > 0);
}

import type { AgencyContextDisplay } from '../types/agency';

/**
 * Resolves which of a contact's arbitrary CSV columns to show, and in what
 * order (UX §A.6, contract `AgencyContextDisplay`).
 *
 * Pure and separate from the component because the resolution rules are a
 * **cross-client contract**: core's contract states them so "two clients
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

/** A value that is present but carries no information. */
const PLACEHOLDER_VALUES = new Set(['-', '--', 'n/a', 'na', 'null', 'none', '']);

export interface ResolvedContextField {
  /** Original header text, verbatim, as uploaded. */
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

/** Hero fields are capped — the contract says "keep it to ~4; the console may cap it". */
export const MAX_HERO_FIELDS = 4;

/**
 * Heuristic hero selection, used ONLY when the operator configured no `hero`.
 * At most one per bucket, in bucket order, skipping empty values.
 *
 * The UI must present this as a guess ("auto-selected"), never as configuration —
 * showing a heuristic's output as if it were the operator's choice is how an
 * agent comes to trust the wrong four fields.
 */
const HERO_HEURISTICS: Array<{ bucket: string; pattern: RegExp }> = [
  { bucket: 'name', pattern: /^(full[\s_-]?)?name$|customer|contact|first.?name|client/i },
  { bucket: 'money', pattern: /amount|balance|due|outstanding|premium|emi|total/i },
  { bucket: 'identity', pattern: /policy|account|loan|invoice|order|ticket|ref/i },
  { bucket: 'place', pattern: /city|branch|region|zone|state/i },
];

function isEmptyValue(raw: string): boolean {
  return PLACEHOLDER_VALUES.has(raw.trim().toLowerCase());
}

/**
 * Stringify a JSONB value for display. `context` is `Record<string, unknown>`
 * because it is operator-uploaded file content — a nested object or an array is
 * unusual but not impossible, and must render as readable text rather than
 * `[object Object]`.
 */
function toDisplayString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function resolveContextFields(
  context: Record<string, unknown>,
  display: AgencyContextDisplay | undefined,
  options: { maxHero?: number } = {},
): ResolvedContext {
  const maxHero = options.maxHero ?? MAX_HERO_FIELDS;
  const originalOrder = Object.keys(context);

  // Case-insensitive matching, because the operator picks these names from a
  // dropdown we populated from the same headers but a config may be hand-edited.
  const hiddenKeys = new Set((display?.hidden ?? []).map((k) => k.trim().toLowerCase()));
  const isHidden = (key: string): boolean => hiddenKeys.has(key.trim().toLowerCase());

  const field = (key: string): ResolvedContextField => {
    const value = toDisplayString(context[key]);
    return { label: key, value, isEmpty: isEmptyValue(value) };
  };

  const resolveNames = (names: string[] | undefined): string[] => {
    if (!names) return [];
    const out: string[] = [];
    for (const name of names) {
      const match = originalOrder.find(
        (key) => key.trim().toLowerCase() === name.trim().toLowerCase(),
      );
      // A configured name that is not in this contact's columns is skipped
      // rather than rendered blank: campaigns outlive file formats, and a
      // stale hero entry must not become an empty pinned field.
      if (match !== undefined && !isHidden(match) && !out.includes(match)) out.push(match);
    }
    return out;
  };

  // Rule 4 applies at every stage, so `hidden` is filtered inside resolveNames
  // as well as below — a column in both `hero` and `hidden` is hidden.
  let heroKeys = resolveNames(display?.hero).slice(0, maxHero);

  if (heroKeys.length === 0) {
    heroKeys = pickHeuristicHeroes(originalOrder, context, isHidden, maxHero);
  }

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

function pickHeuristicHeroes(
  keys: string[],
  context: Record<string, unknown>,
  isHidden: (key: string) => boolean,
  maxHero: number,
): string[] {
  const picked: string[] = [];
  for (const { pattern } of HERO_HEURISTICS) {
    if (picked.length >= maxHero) break;
    const match = keys.find(
      (key) =>
        !picked.includes(key) &&
        !isHidden(key) &&
        pattern.test(key) &&
        !isEmptyValue(toDisplayString(context[key])),
    );
    if (match) picked.push(match);
  }
  return picked;
}

/** True when the operator configured heroes; false when they were guessed. */
export function heroesWereConfigured(display: AgencyContextDisplay | undefined): boolean {
  return Boolean(display?.hero && display.hero.length > 0);
}

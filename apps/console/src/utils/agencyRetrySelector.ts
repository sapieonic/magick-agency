import type { AgencyContactFilters, AgencyRetrySelector } from '../types/agency-spine';
import {
  attemptOutcomeLabel,
  contactStateLabel,
  suppressedReasonLabel,
  RETRY_NO_OUTCOME,
} from '../types/agency-spine';
import type {
  AgencyDispositionEntry,
  AgencyRetryCreateResponse,
  AgencyRetryRefusalCode,
} from '../types/agency-campaign';
import { dispositionLabel } from './agencySpineCopy';

/**
 * The retry selector, as a leaf module: what it may contain, how a contacts-tab
 * filter set becomes one, and the words that describe it.
 *
 * A LEAF — pure functions over data, no React, no API. Everything here is
 * consumed by the retry dialog, the contacts tab and their tests; nothing here
 * knows about a request.
 *
 * ── Why the vocabulary is pinned twice ──────────────────────────────────────
 * The server answers `400 <key> is not a retry selector dimension` for any key it does
 * not recognise, and it does so on the WHOLE request — so one stray key from a
 * filter set is not a widened cohort, it is a refused retry with a message about
 * a field the supervisor never typed. Which keys travel is therefore worth a
 * compile-time guarantee rather than a hand-kept list, and both directions are
 * pinned below with the same `Record`-plus-`Exclude` trick the action-error
 * union uses in `types/agency.ts`: a key added to {@link AgencyRetrySelector}
 * and forgotten here is a type error, and so is a contact filter that is neither
 * carried nor explicitly dropped.
 */

/**
 * Every dimension the server's `parseRetrySelector` accepts (wire contract).
 *
 * A `Record<K, true>` rather than an array literal, because **a `Record` key set
 * is exhaustiveness-checked and an array literal is not**. Left as an array, a
 * dimension added to the selector would simply drop out of every encoding here
 * and the supervisor would get a cohort they did not choose.
 */
export const RETRY_SELECTOR_KEYS = {
  state: true,
  last_outcome: true,
  last_disposition: true,
  suppressed_reason: true,
  never_attempted: true,
  attempt_count_gte: true,
  attempt_count_lte: true,
} as const satisfies Record<keyof AgencyRetrySelector, true>;

export type RetrySelectorKey = keyof typeof RETRY_SELECTOR_KEYS;

/**
 * The contacts-tab filters that are **not** selector dimensions, and are
 * stripped before any retry call (contract).
 *
 * `phone` is a lookup, not a cohort — "retry this one number" is a decision
 * about a contact, and there is no shape of retry campaign that means it.
 * `from` / `to` filter `created_at`, which is when the row was *ingested*; on a
 * retry dialog that reads as "dialled between", which it is not, and the two
 * differ by however long the roster sat before the campaign started.
 *
 * They are dropped LOUDLY. Silently narrowing would build a smaller campaign
 * than the screen promised; silently widening would build a bigger one. Both are
 * discovered after the calls have been placed.
 */
export const NON_SELECTOR_CONTACT_FILTERS = {
  phone: true,
  from: true,
  to: true,
} as const satisfies Record<Exclude<keyof AgencyContactFilters, RetrySelectorKey>, true>;

export type NonSelectorContactFilter = keyof typeof NON_SELECTOR_CONTACT_FILTERS;

/**
 * The other half of the exhaustiveness check: every contact filter is either a
 * selector dimension or an explicitly-listed non-dimension. A filter that is
 * neither would be silently forwarded to a route that refuses the whole request
 * over it.
 */
type UnclassifiedContactFilter = Exclude<
  keyof AgencyContactFilters,
  RetrySelectorKey | NonSelectorContactFilter
>;
const _everyContactFilterIsClassified: UnclassifiedContactFilter extends never
  ? true
  : UnclassifiedContactFilter = true;
void _everyContactFilterIsClassified;

/** The words each dropped filter is named by, in the notice. */
const DROPPED_FILTER_LABEL: Record<NonSelectorContactFilter, string> = {
  phone: 'the phone-number search',
  from: 'the “from” date',
  to: 'the “to” date',
};

/**
 * The literal bucket key the server uses for a contact with no `last_disposition` —
 * one nobody ever wrote up. Not a code an operator can author.
 */
export const NO_DISPOSITION_BUCKET = '__none__';

/**
 * One phrase for one fact. The `__none__` member of the outcome dimension and
 * `never_attempted: true` both mean "nobody dialled this contact", so they
 * render identically and a selector naming both says it once.
 */
const NEVER_DIALED_COPY = 'never dialed at all';

/**
 * What the retry dialog offers when it is opened from the campaign header
 * rather than from a filtered contacts list (contract).
 *
 * The uncontroversial "we did not reach them" set — no answer, busy, and the
 * contacts a stopped-mid-run campaign never dialled at all. **Everything else is
 * opt-in**, and deliberately so: `machine`, `failed` and `agent_disconnected`
 * each mean something a supervisor should have to choose, and the suppressed
 * states are a compliance decision rather than a default.
 */
export const DEFAULT_RETRY_SELECTOR: AgencyRetrySelector = {
  // ── ONE dimension, three members — deliberately NOT two dimensions ────────
  //
  // ⚠️ This was `{last_outcome: ['no_answer','busy'], never_attempted: true}`,
  // and it could never match a row. The selector algebra ANDs across keys, so
  // that compiled to `last_outcome = ANY('{no_answer,busy}') AND
  // attempt_count = 0` — and a contact with no attempts has a NULL outcome, so
  // the two conjuncts are mutually exclusive. Measured on Postgres against a
  // realistic roster: 0 of 5 rows, where the union matches 4. The Retry button
  // on the campaign header — the entry point this default exists for, and the
  // one with no filtered list behind it to correct it — was dead on every
  // campaign.
  //
  // "We did not reach them" is a UNION, and `__none__` (the server's
  // `RETRY_NO_OUTCOME`) is what expresses it inside a single dimension, where
  // the algebra already ORs. It is the same bucket key the preview's
  // `by_last_outcome` breakdown uses for a NULL outcome, so the value selected
  // here is the value the supervisor reads back.
  last_outcome: ['no_answer', 'busy', RETRY_NO_OUTCOME],
};

/**
 * Values the server refuses OUTRIGHT, as a 400 on the whole request — so a selector
 * carrying one is not a narrower cohort, it is a dead preview.
 *
 * These are dimensions the roster DOES offer as chips, which is what makes them
 * dangerous: a supervisor filters "On the Do Not Call list" — arguably the
 * reason the Contacts tab exists — presses Retry, and lands on a refused
 * request about a field they did type, rather than on the exclusion note this
 * dialog is written around.
 *
 * Stripped as VALUES, not as keys: `{ suppressed_reason: ['dnc',
 * 'max_attempts'] }` keeps `max_attempts` and names `dnc` on screen. `phone` /
 * `from` / `to` already have that shape one level up; these needed it one level
 * down.
 *
 *  - `dnc` / `invalid` — DR-4. Never seeded into any retry, by any selector.
 *  - `in_flight` — the contact is on a call RIGHT NOW. The server excludes it
 *    unconditionally (seeding it and starting the child would dial a number the
 *    parent has an open call on) and refuses it by name here.
 */
const REFUSED_SELECTOR_VALUES = {
  suppressed_reason: ['dnc', 'invalid'],
  state: ['in_flight'],
} as const;

/** How each refused value is named in the notice, and why it was left behind. */
const REFUSED_VALUE_LABEL: Record<string, string> = {
  dnc: 'contacts on the Do Not Call list',
  invalid: 'invalid numbers',
  in_flight: 'contacts currently on a call',
};

export interface SelectorFromFilters {
  selector: AgencyRetrySelector;
  /** Which non-dimension filters were on screen and had to be left behind. */
  dropped: NonSelectorContactFilter[];
  /**
   * Filter VALUES that were on screen and cannot be retried — see
   * {@link REFUSED_SELECTOR_VALUES}. Raw values, so the caller can label them.
   */
  droppedValues: string[];
}

/**
 * The filters the supervisor is looking at → the selector that will be sent.
 *
 * The carried keys are copied rather than spread wholesale, so a key added to
 * `AgencyContactFilters` cannot reach the wire without someone deciding which
 * side of the split it is on (the pin above makes that a compile error, this
 * makes it a deliberate edit).
 *
 * Empty arrays are dropped, not sent: `state: []` is what a cleared chip group
 * leaves behind, and an empty `= ANY('{}')` matches nothing — so sending it
 * would turn "I cleared that filter" into "match no contacts at all".
 */
export function selectorFromContactFilters(filters: AgencyContactFilters): SelectorFromFilters {
  const selector: AgencyRetrySelector = {};
  const droppedValues: string[] = [];

  /**
   * Copy one dimension, leaving behind the values the server would refuse.
   *
   * A dimension that is left EMPTY by the strip is omitted entirely rather than
   * sent as `[]` — the same rule the empty-chip-group case follows, and for the
   * same reason: an empty `= ANY('{}')` matches nothing, so sending it turns "I
   * filtered on DNC" into "match no contacts at all". Omitted, the dimension
   * simply stops constraining, and `isSelectorEmpty` plus the notice below is a
   * far better answer than a 400 about a field they did type.
   */
  const carry = <K extends 'state' | 'suppressed_reason'>(key: K): string[] | undefined => {
    const values = filters[key];
    if (!values?.length) return undefined;
    const refused: readonly string[] = REFUSED_SELECTOR_VALUES[key];
    const kept = values.filter((value) => !refused.includes(value));
    for (const value of values) {
      if (refused.includes(value) && !droppedValues.includes(value)) droppedValues.push(value);
    }
    return kept.length ? kept : undefined;
  };

  const states = carry('state');
  if (states) selector.state = states as AgencyRetrySelector['state'];
  if (filters.last_outcome?.length) {
    selector.last_outcome = [...filters.last_outcome] as AgencyRetrySelector['last_outcome'];
  }
  if (filters.last_disposition?.length) selector.last_disposition = [...filters.last_disposition];
  const suppressed = carry('suppressed_reason');
  if (suppressed) selector.suppressed_reason = suppressed;

  const dropped = (Object.keys(NON_SELECTOR_CONTACT_FILTERS) as NonSelectorContactFilter[]).filter(
    (key) => {
      const value = filters[key];
      return typeof value === 'string' && value.trim() !== '';
    },
  );

  return { selector, dropped, droppedValues };
}

/**
 * The sentence naming filter VALUES that cannot be retried, or `null`.
 *
 * Separate from {@link droppedFilterNotice} because the reason is different and
 * a supervisor acts on it differently: a dropped `phone` search is a filter that
 * does not translate, while a dropped `dnc` is a rule — those contacts are never
 * retried by anyone, and no amount of re-filtering will change it.
 */
export function refusedValueNotice(droppedValues: readonly string[]): string | null {
  if (droppedValues.length === 0) return null;
  const named = droppedValues.map((value) => REFUSED_VALUE_LABEL[value] ?? value);
  const list =
    named.length === 1
      ? named[0]
      : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
  return `${list} can never be retried, so ${named.length === 1 ? 'that filter is' : 'those filters are'} not carried over.`;
}

/**
 * The sentence that tells the supervisor what was left behind, or `null` when
 * nothing was.
 *
 * It names the filters rather than counting them, because "1 filter was
 * removed" answers neither "which" nor "does that change what I am about to
 * create".
 */
export function droppedFilterNotice(dropped: readonly NonSelectorContactFilter[]): string | null {
  if (dropped.length === 0) return null;
  const named = dropped.map((key) => DROPPED_FILTER_LABEL[key]);
  const list =
    named.length === 1
      ? named[0]
      : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
  return (
    `A retry selects a cohort, so ${list} ${named.length === 1 ? 'is' : 'are'} not carried over — `
    + 'the contacts below are everything else you filtered on.'
  );
}

/** Whether a selector names no dimension at all. The server refuses that with a 400. */
export function isSelectorEmpty(selector: AgencyRetrySelector): boolean {
  return !(
    selector.state?.length
    || selector.last_outcome?.length
    || selector.last_disposition?.length
    || selector.suppressed_reason?.length
    || selector.never_attempted === true
    || typeof selector.attempt_count_gte === 'number'
    || typeof selector.attempt_count_lte === 'number'
  );
}

/**
 * The selector as query parameters, for the preview read.
 *
 * Multi-value keys go as REPEATED params, matching every other agency filter
 * this client sends. The API's `forwardAllowedQuery` joins repeated values with a
 * comma and the server's `multiParam` splits on one, which is why a disposition code
 * containing a comma cannot survive the trip — a platform limitation of the
 * filter encoding, stated here because the retry dialog is where a supervisor
 * would first meet it and conclude their cohort was wrong.
 *
 * `never_attempted` is only ever sent as `true`. The server accepts `false`, but
 * `false` constrains nothing, so sending it would put a key in the frozen
 * `retry_selector` record that describes no part of the roster.
 */
export function selectorQueryParams(selector: AgencyRetrySelector): URLSearchParams {
  const params = new URLSearchParams();
  for (const value of selector.state ?? []) params.append('state', value);
  for (const value of selector.last_outcome ?? []) params.append('last_outcome', value);
  for (const value of selector.last_disposition ?? []) params.append('last_disposition', value);
  for (const value of selector.suppressed_reason ?? []) params.append('suppressed_reason', value);
  if (selector.never_attempted === true) params.set('never_attempted', 'true');
  if (typeof selector.attempt_count_gte === 'number') {
    params.set('attempt_count_gte', String(selector.attempt_count_gte));
  }
  if (typeof selector.attempt_count_lte === 'number') {
    params.set('attempt_count_lte', String(selector.attempt_count_lte));
  }
  return params;
}

/**
 * A disposition bucket key from the preview, in words.
 *
 * Falls back to the raw code for anything the catalog does not name — a code
 * retired since the calls were filed is exactly the bucket a supervisor is
 * asking about, and blanking it would report those contacts as belonging to
 * nothing.
 */
export function dispositionBucketLabel(
  code: string,
  catalog: readonly AgencyDispositionEntry[] | undefined,
): string {
  if (code === NO_DISPOSITION_BUCKET) return 'Never written up';
  return dispositionLabel(code, catalog) ?? code;
}

/**
 * The same job for the OUTCOME breakdown — and it is a separate function only
 * because the two dimensions have separate copy tables.
 *
 * `attemptOutcomeLabel` falls through to the raw string for anything it does not
 * know, so `__none__` rendered as `__none__` on screen. That is not a rare
 * shape: `__none__` is the server's `by_last_outcome` key for a NULL outcome, it is a
 * member of `DEFAULT_RETRY_SELECTOR`, and the default is what every Retry
 * pressed from the campaign header uses — so it appeared in the breakdown of
 * essentially every preview opened that way.
 *
 * `describeSelector` already refuses to print the raw key, and
 * `dispositionBucketLabel` already special-cases the identical key on the other
 * dimension. This is the third place that rule has to hold.
 */
export function outcomeBucketLabel(code: string): string {
  if (code === RETRY_NO_OUTCOME) return 'Never dialed';
  return attemptOutcomeLabel(code);
}

/**
 * The selector in the supervisor's own words, for the dialog's summary line.
 *
 * Deliberately NOT the same string the server builds for the agent's banner
 * (`retry_context.selection_summary`). That one describes a campaign that
 * exists, is composed from the frozen record, and is the campaign's own fact.
 * This one describes a campaign that does not exist yet, and has to name
 * dimensions — states, suppression reasons, attempt bounds — the agent's
 * sentence has no reason to carry. Two audiences, two sentences; folding them
 * together would mean the supervisor's preview and the agent's banner drifting
 * as one string tried to serve both.
 */
export function describeSelector(
  selector: AgencyRetrySelector,
  catalog: readonly AgencyDispositionEntry[] | undefined,
): string {
  /**
   * One clause per DIMENSION. Joined with "and", because that is what the server does
   * across dimensions — see the return statement.
   */
  const clauses: string[] = [];
  /** Values inside one dimension. The server ORs these. */
  const orList = (values: readonly string[]): string =>
    values.length <= 1
      ? (values[0] ?? '')
      : `${values.slice(0, -1).join(', ')} or ${values[values.length - 1]}`;
  let neverDialedNamed = false;

  if (selector.last_disposition?.length) {
    clauses.push(
      `written up as ${orList(
        selector.last_disposition.map((code) => dispositionBucketLabel(code, catalog)),
      )}`,
    );
  }
  if (selector.last_outcome?.length) {
    // `__none__` is a member of this dimension, not an outcome — it has no entry
    // in the console's outcome copy, and the raw key must never reach a
    // supervisor. It reads as a separate alternative because "last ended in
    // never dialed" is not a sentence: the contact did not END anywhere. It ORs
    // with the named outcomes, being the same dimension.
    const outcomes = selector.last_outcome.filter((o) => o !== RETRY_NO_OUTCOME);
    const alternatives: string[] = [];
    if (outcomes.length) {
      alternatives.push(`last ended in ${orList(outcomes.map((o) => attemptOutcomeLabel(o).toLowerCase()))}`);
    }
    if (selector.last_outcome.length !== outcomes.length) {
      alternatives.push(NEVER_DIALED_COPY);
      neverDialedNamed = true;
    }
    if (alternatives.length) clauses.push(alternatives.join(' or '));
  }
  if (selector.state?.length) {
    clauses.push(`sitting at ${orList(selector.state.map((s) => contactStateLabel(s).toLowerCase()))}`);
  }
  if (selector.suppressed_reason?.length) {
    clauses.push(
      `suppressed because ${orList(
        selector.suppressed_reason.map((r) => (suppressedReasonLabel(r) ?? r).toLowerCase()),
      )}`,
    );
  }
  // De-duplicated against the `__none__` alternative above: both spellings name
  // one fact, and a selector carrying each would otherwise say it twice. Tracked
  // by a flag rather than by searching `clauses`, because the copy is now joined
  // inside a clause rather than standing alone in the list.
  if (selector.never_attempted === true && !neverDialedNamed) {
    clauses.push(NEVER_DIALED_COPY);
  }
  if (selector.never_attempted === false) clauses.push('dialed at least once');
  if (typeof selector.attempt_count_gte === 'number') {
    clauses.push(`dialed at least ${selector.attempt_count_gte} time${selector.attempt_count_gte === 1 ? '' : 's'}`);
  }
  if (typeof selector.attempt_count_lte === 'number') {
    clauses.push(`dialed at most ${selector.attempt_count_lte} time${selector.attempt_count_lte === 1 ? '' : 's'}`);
  }

  if (clauses.length === 0) return 'No cohort is selected yet.';
  // ── "and" ACROSS dimensions, "or" WITHIN one ─────────────────────────────
  //
  // the server's algebra, exactly: values inside a dimension are `= ANY(...)`, and
  // separate dimensions are separate `AND`ed conditions. This line used to join
  // everything with "or", which describes a different — and always wider —
  // cohort than the one that will be seeded: `{state: ['exhausted'],
  // last_disposition: ['callback']}` was rendered as either group when only
  // their INTERSECTION is seeded. A supervisor reading it would expect the
  // union, see a much smaller matched count, and reasonably conclude the
  // preview was broken.
  //
  // The nesting is unambiguous in English here because each clause opens with
  // its own verb phrase ("written up as …", "last ended in …", "sitting at …"),
  // so the "or"s are visibly inside a clause and the "and"s visibly between.
  return `Contacts ${clauses.join(', and ')}.`;
}

/** `<parent name> — Retry <n>`, the server's own default, offered pre-filled and editable. */
export function defaultRetryName(parentName: string, parentGeneration: number): string {
  return `${parentName} — Retry ${parentGeneration + 1}`;
}

/**
 * The three `409` refusals, in words a supervisor can act on.
 *
 * Each names the remedy, because each has one and none of them is "try again":
 * an empty selection needs a wider cohort, an oversized one needs a narrower,
 * and an exhausted generation chain needs a fresh campaign. The server's own
 * `message` is the fallback for a code this build has not heard of — it beats
 * "something went wrong", and it is the only thing left to say.
 */
export function retryRefusalCopy(
  code: AgencyRetryRefusalCode | string,
  context: { maxSeedRows?: number | undefined; matched?: number | undefined } = {},
): string | null {
  switch (code) {
    case 'retry_selection_empty':
      return (
        'Nothing matched, so no campaign was created. Widen the selection — Do Not Call and '
        + 'unusable numbers are always left out, which is often the whole difference.'
      );
    case 'retry_selection_too_large': {
      const cap = context.maxSeedRows;
      const matched = context.matched;
      return (
        'That is more contacts than one retry campaign can hold'
        + (typeof matched === 'number' && typeof cap === 'number'
          ? ` — ${matched.toLocaleString()} against a limit of ${cap.toLocaleString()}`
          : '')
        + '. Narrow the selection and try again; nothing was created.'
      );
    }
    case 'retry_generation_exceeded':
      return (
        'This campaign has already been retried as many times as the platform allows. Start a '
        + 'fresh campaign from the contacts you still want to reach.'
      );
    default:
      return null;
  }
}

/**
 * What the toast says once the dialog closes — **one sentence, two outcomes.**
 *
 * It was written twice, identically, at the two call sites that open the dialog
 * (the campaign header and the filtered roster), which is exactly the shape a
 * new outcome breaks: a replay reaching only one of them would have one surface
 * announcing a campaign it did not create, with a `contacts_seeded` of `null`
 * rendered as `NaN` by `toLocaleString`.
 *
 * ── The replay sentence does not claim a count, because there is none ───────
 *
 * On `idempotent_replay` the server seeded nothing now and sends `contacts_seeded:
 * null`; the campaign is the one this supervisor already made. Saying "created
 * with 812 contacts" would be a second claim of a creation that happened once —
 * and the supervisor is here precisely because they could not tell whether the
 * first attempt worked. So the sentence tells them the truth they came for: it
 * exists already, and this is it.
 *
 * Both arms end at the same place — the child campaign — so the caller's
 * `navigate` needs no branch.
 */
export function retryCreatedToast(result: AgencyRetryCreateResponse): string {
  if (result.idempotent_replay || result.contacts_seeded === null) {
    return `${result.campaign.name} was already created — opening it.`;
  }
  const seeded = result.contacts_seeded;
  const collapsed = result.duplicates_collapsed;
  return (
    `${result.campaign.name} created as a draft with `
    + `${seeded.toLocaleString()} contact${seeded === 1 ? '' : 's'}.`
    // Only when it happened, and only when the field arrived at all — an absent
    // `duplicates_collapsed` is an older the server saying nothing, not a measured
    // zero. The clause exists because the preview showed a LARGER number a
    // moment ago, and a supervisor who spots the gap with no explanation cannot
    // tell a duplicate collapse from rows lost to a bug.
    + (typeof collapsed === 'number' && collapsed > 0
      ? ` ${collapsed.toLocaleString()} duplicate${collapsed === 1 ? ' was' : 's were'}`
        + ' merged, so this is fewer than the preview showed.'
      : '')
  );
}

/**
 * A fresh idempotency key for ONE opening of the retry dialog.
 *
 * Minted here rather than per request — that is the entire mechanism. A key
 * generated inside the fetch is a new value on the second press and collides
 * with nothing, so the supervisor whose first response was lost creates a second
 * campaign over the same cohort and dials every customer in it twice.
 *
 * `crypto.randomUUID()` needs a secure context, which every surface that can
 * reach this page has; the fallback exists so a non-secure origin degrades to an
 * UNKEYED create (the server's legal absent case) rather than throwing inside a render
 * — a dialog that cannot open is worse than one without replay protection.
 */
export function mintRetryIdempotencyKey(): string | undefined {
  try {
    return crypto.randomUUID();
  } catch {
    return undefined;
  }
}

/**
 * Query-string → filter parsing for the supervisor read surface.
 *
 * A LEAF module — pure functions over strings, no I/O, no DB types. It exists
 * apart from the routes so the parsing rules can be tested without a Fastify
 * instance, and apart from the repository so the SQL builder receives a shape it
 * can trust rather than raw `request.query`.
 */

import type {
  AgencyAttemptOutcome,
  AgencyAttemptState,
  AgencyContactState,
  AgencyDisposition,
  AgencyRetrySelector,
} from '@magick-agency/contracts/agency';
import { RETRY_NO_OUTCOME } from '@magick-agency/contracts/agency';
import { BUILT_IN_DISPOSITION_CODES } from './disposition-policy.js';

export { RETRY_NO_OUTCOME };

/**
 * The runtime vocabularies. Declared here and nowhere else on this surface, so
 * the 400 that names the valid set and the predicate that filters on it cannot
 * disagree.
 *
 * ── Why a `Record` and not `satisfies readonly Outcome[]` ───────────────────
 *
 * That was the first spelling, and it does **not** check what it looks like it
 * checks. `satisfies` verifies every element of the array is a member of the
 * union; it says nothing about whether every member of the union appears in the
 * array. So adding an outcome to `contracts.ts` and forgetting it here compiled
 * cleanly — and the failure it produced is the one this whole read surface
 * exists to prevent: a supervisor filtering on the new outcome would get a 400
 * calling a real, live outcome unknown, and worse, a **row carrying it is not
 * excluded from anything** — it just becomes unfilterable, so the vocabulary
 * silently stops describing the data.
 *
 * `Record<TUnion, true>` inverts the check. A missing member is now a missing
 * required key — a build error naming the outcome — and an extra one is an
 * excess-property error. `vocabulary()` then reads the keys back in declaration
 * order, which is the order they appear in the 400's `expected one of …`.
 */
/**
 * Exported so a second read surface gets the SAME inverted check rather than its
 * own copy of the idiom — `agent-record.ts`'s bucket vocabulary uses it. The
 * paragraphs above are the whole argument for why that matters, and they apply
 * equally to any vocabulary a route echoes back in a 400.
 */
export function vocabulary<TUnion extends string>(members: Record<TUnion, true>): readonly TUnion[] {
  return Object.keys(members) as TUnion[];
}

export const ATTEMPT_STATES = vocabulary<AgencyAttemptState>({
  queued: true, dialing: true, ringing: true, answered: true, bridged: true, ended: true,
});

export const ATTEMPT_OUTCOMES = vocabulary<AgencyAttemptOutcome>({
  connected: true, no_answer: true, busy: true, failed: true, machine: true, invalid: true,
  abandoned: true, agent_disconnected: true, orphaned: true,
  // Added in the same change as the union member, which the `Record` above is
  // what forces — and this is the vocabulary whose omission would matter most:
  // a supervisor separating cancelled rings from abandoned calls has to be able
  // to filter for this outcome, and an unfilterable
  // outcome excludes rows from nothing while quietly ceasing to describe the
  // data (see `vocabulary`'s header).
  canceled: true,
});

export const CONTACT_STATES = vocabulary<AgencyContactState>({
  pending: true, in_flight: true, connected: true, completed: true, exhausted: true,
  suppressed: true,
});

/** `agency_contacts.suppressed_reason`. */
export const SUPPRESSED_REASONS = ['dnc', 'invalid', 'max_attempts', 'manual'] as const;

/**
 * How a `phone=` filter is matched.
 *
 * **Two modes, because a supervisor types two different things.** Pasting a
 * whole number from a complaint is an equality test, and equality is what
 * `idx_agency_contacts_phone` can serve. Typing the last four digits off a
 * call-back note is a suffix test, which no B-tree can serve — but it runs
 * inside one campaign's already-narrowed row set rather than across the tenant,
 * so it is a filter on a bounded scan and not a table scan.
 *
 * The mode is chosen from the input rather than from a second parameter: a
 * leading `+` means the caller has a complete E.164 and means it exactly.
 */
export type PhoneFilter = { mode: 'exact'; value: string } | { mode: 'suffix'; value: string };

export interface AgencyAttemptFilters {
  states?: AgencyAttemptState[];
  outcomes?: AgencyAttemptOutcome[];
  dispositionCodes?: string[];
  /** The user id, matched through `agency_agent_sessions.agent_user_id`. */
  agentUserId?: string;
  contactId?: string;
  phone?: PhoneFilter;
  from?: Date;
  to?: Date;
}

export interface AgencyContactFilters {
  states?: AgencyContactState[];
  suppressedReasons?: string[];
  lastOutcomes?: string[];
  /**
   * `agency_contacts.last_disposition` — the write-up an agent last recorded for
   * this contact.
   *
   * **Not a `Record<TUnion, true>` vocabulary, and it cannot be one.** Disposition
   * codes are operator-authored per campaign (`agency_campaigns.
   * disposition_catalog`), so there is no closed union to invert the check
   * against — the same reason `AgencyAttemptFilters.dispositionCodes` has none.
   * On the contacts-list route these pass through as plain strings, deliberately:
   * a code RETIRED from the catalog still exists on historic rows, and those are
   * exactly the rows a supervisor asking "who did we mark voicemail" is looking
   * for.
   *
   * The retry route is the one caller that DOES validate them, against the parent
   * campaign's catalog ∪ the built-ins — because there it is not a question about
   * the past but an instruction to seed a roster, and a typo would silently seed
   * nothing. See {@link parseRetrySelector}.
   */
  lastDispositions?: string[];
  phone?: PhoneFilter;
  from?: Date;
  to?: Date;
}

/**
 * Route params and query filters that reach a `::uuid` cast are shape-checked
 * before they get there.
 *
 * Postgres answers `22P02 invalid input syntax for type uuid` on a malformed
 * one and nothing maps that to a status, so it surfaces as a **500 with the
 * database's error text** — a bad request that reads as a broken service, on a
 * route a supervisor reaches from a link.
 *
 * The route file guards its PATH param with an identical regex. This is the
 * other entry point, and it was missed: `?contact_id=` is put into the URL by
 * the console's own drill-down link, so a hand-edited or stale one is an
 * ordinary occurrence rather than an attack.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface FilterIssue {
  param: string;
  message: string;
}

export type FilterParse<T> =
  | { ok: true; filters: T }
  | { ok: false; issues: FilterIssue[] };

/**
 * Read a param that may repeat (`?outcome=a&outcome=b`) or arrive
 * comma-separated (`?outcome=a,b`).
 *
 * Both forms are in the wild — the activity filter accepts both for the
 * same reason — and a client that guesses wrong would otherwise filter on the
 * literal string `"a,b"` and be handed an empty list, which on this surface
 * reads as "we never dialled anyone" rather than as a malformed request.
 */
export function multiParam(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const parts = (Array.isArray(raw) ? raw : [raw])
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return parts.length > 0 ? parts : undefined;
}

/**
 * Refuse a value outside the vocabulary rather than passing it through.
 *
 * An unknown `outcome` matches no row, and an empty list on this page is
 * indistinguishable from a campaign that dialled nobody — the exact
 * "returns 200 and looks complete" failure this surface exists to avoid. So the
 * valid set is echoed back, the way the break route's `unknown_break_reason` already does.
 *
 * Exported for the same reason {@link vocabulary} and {@link singleParam} are: the
 * roster read (`GET /agency-agents/stats`) validates `?sort=` and `?order=`
 * against their own vocabularies and must produce the SAME 400 — same wording,
 * same echoed set — as every other refusal on this surface. A second copy of the
 * message is how one route comes to say "unknown sort" and another "invalid sort"
 * for the identical mistake, and a client cannot parse two shapes.
 *
 * It takes an ARRAY because the multi-value params it was written for repeat. A
 * single-valued param wraps its one value (`[raw]`) rather than getting a second
 * function — see `agent-record.ts`'s `singleEnum`.
 */
export function validateEnum<T extends string>(
  param: string,
  values: string[] | undefined,
  allowed: readonly T[],
  issues: FilterIssue[],
): T[] | undefined {
  if (!values) return undefined;
  const bad = values.filter((value) => !(allowed as readonly string[]).includes(value));
  if (bad.length > 0) {
    issues.push({
      param,
      message: `unknown ${param}: ${bad.join(', ')} — expected one of ${allowed.join(', ')}`,
    });
    return undefined;
  }
  return values as T[];
}

/**
 * A single string param, trimmed; blank becomes absent.
 *
 * Blank rather than rejected because `?agent_user_id=` is what a cleared form
 * field posts, and it plainly means "no filter".
 *
 * Exported for the agent-record surface, which needs the same reading of "the
 * caller sent nothing" before it can say a bound is REQUIRED.
 */
export function singleParam(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = String(Array.isArray(raw) ? raw[0] : raw).trim();
  return value.length > 0 ? value : undefined;
}

/**
 * Digits (and a leading `+`) only — everything a UI or a paste adds is dropped.
 *
 * Three outcomes, and keeping the third distinct from the first is the whole
 * point of the return type:
 *
 *  - `undefined` — no filter was supplied. `?phone=` is what a cleared search
 *    box posts and plainly means "no filter".
 *  - a `PhoneFilter` — usable.
 *  - `'unusable'` — something WAS typed and it contains no digits at all
 *    (`abc`, `%`, `()-`, an emoji). This must NOT collapse into `undefined`.
 *
 * ── Why the third case cannot be treated as "no filter" ─────────────────────
 * Dropping it returns **the entire campaign** while the console still shows a
 * chip reading `phone: abc` and still reports the view as filtered. That is a
 * wider answer presented as a narrower one, on a surface where the reader takes
 * the result as a fact about the campaign — the exact failure this whole read
 * surface exists to avoid. The caller turns it into a 400 that names the field.
 */
export function parsePhoneFilter(raw: unknown): PhoneFilter | 'unusable' | undefined {
  const value = singleParam(raw);
  if (!value) return undefined;
  const exact = value.startsWith('+');
  const digits = value.replace(/\D/g, '');
  if (digits.length === 0) return 'unusable';
  return exact ? { mode: 'exact', value: `+${digits}` } : { mode: 'suffix', value: digits };
}

/** Fold {@link parsePhoneFilter}'s third outcome into the issue list. */
function readPhoneFilter(raw: unknown, issues: FilterIssue[]): PhoneFilter | undefined {
  const parsed = parsePhoneFilter(raw);
  if (parsed === 'unusable') {
    issues.push({
      param: 'phone',
      message: 'must contain at least one digit — search by the whole number or its last few digits',
    });
    return undefined;
  }
  return parsed;
}

/**
 * `YYYY-MM-DD`, or a full date-time that says WHICH ZONE IT MEANS.
 *
 * The two accepted forms are the two a caller actually sends: a date picker
 * posts the first, and code posts the second. Everything else is refused,
 * because bare `new Date(value)` — which this used to be — is far looser than
 * the error message's promise of ISO-8601, in three ways that all end with a
 * wrong answer reported as a right one:
 *
 *  - **No offset means the SERVER's zone.** `2026-08-17T09:00:00` is parsed
 *    against `process.env.TZ`, so the same request bounds a different range
 *    depending on which host answered it. On a surface whose whole job is "what
 *    was actually dialled between these times", a silently shifted window is the
 *    failure, and it is invisible: containers run UTC, so it looks correct in
 *    every environment anyone tests in and drifts only where TZ is set.
 *  - **Non-ISO input is accepted.** `17 Aug 2026` parses fine through the legacy
 *    fallback, which makes the 400's text a lie and the accepted vocabulary
 *    whatever V8 happens to implement.
 *  - **An impossible date is rolled forward, not refused.** `2026-02-30` becomes
 *    March 2nd, so a typo returns a real, plausible, differently-bounded result
 *    set with nothing on screen to say the range moved.
 *
 * A date-only value is anchored at UTC midnight — which is what `new Date`
 * already does with that form, and is the only reading available without asking
 * the caller for a zone they did not send.
 *
 * Exported so the agent-record surface bounds its window with the SAME parser.
 * Each of the three refusals above is a wrong answer reported as a right one; a
 * second copy of them on a second surface would drift, and the drift would be one
 * surface quietly accepting a window the other refuses.
 */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

export function parseFilterDate(param: string, raw: unknown, issues: FilterIssue[]): Date | undefined {
  const value = singleParam(raw);
  if (!value) return undefined;

  const dateOnly = DATE_ONLY_RE.test(value);
  if (!dateOnly && !DATE_TIME_RE.test(value)) {
    issues.push({
      param,
      message: 'must be an ISO-8601 date (2026-08-17) or date-time with a zone (2026-08-17T09:00:00Z)',
    });
    return undefined;
  }

  const parsed = new Date(dateOnly ? `${value}T00:00:00Z` : value);
  // Shape is not calendar: `2026-02-30` matches the pattern, and `new Date`
  // answers March 2nd rather than refusing. Rendering it back and comparing is
  // what catches the roll-forward. Compared on the DATE part only, so that an
  // offset form is checked against its own local reading rather than against
  // the UTC instant it converts to.
  if (Number.isNaN(parsed.getTime()) || parsed.getUTCFullYear() < 1) {
    issues.push({ param, message: 'is not a real date' });
    return undefined;
  }
  if (dateOnly && parsed.toISOString().slice(0, 10) !== value) {
    issues.push({ param, message: 'is not a real date' });
    return undefined;
  }
  return parsed;
}

/**
 * An inverted range is refused, not silently emptied.
 *
 * `from > to` matches nothing, and "nothing matched" on a compliance surface is
 * read as an answer about the campaign rather than about the query.
 */
function checkRange(from: Date | undefined, to: Date | undefined, issues: FilterIssue[]): void {
  if (from && to && from > to) {
    issues.push({ param: 'from', message: '`from` must not be later than `to`' });
  }
}

export function parseAttemptFilters(query: Record<string, unknown>): FilterParse<AgencyAttemptFilters> {
  const issues: FilterIssue[] = [];
  const states = validateEnum('state', multiParam(query['state']), ATTEMPT_STATES, issues);
  const outcomes = validateEnum('outcome', multiParam(query['outcome']), ATTEMPT_OUTCOMES, issues);
  // NOT validated against a vocabulary: disposition codes are campaign config
  // (`disposition_catalog`), so the legal set differs per campaign and a code
  // retired from the catalog still exists on historic rows — which are exactly
  // the rows a supervisor is looking for.
  const dispositionCodes = multiParam(query['disposition_code']);
  const from = parseFilterDate('from', query['from'], issues);
  const to = parseFilterDate('to', query['to'], issues);
  checkRange(from, to, issues);

  // Parsed BEFORE the issues check, not after: a validator that runs downstream
  // of its own early return can never report anything.
  const phone = readPhoneFilter(query['phone'], issues);
  const contactId = singleParam(query['contact_id']);
  if (contactId !== undefined && !UUID_RE.test(contactId)) {
    issues.push({ param: 'contact_id', message: 'must be a contact id' });
  }
  if (issues.length > 0) return { ok: false, issues };

  const agentUserId = singleParam(query['agent_user_id']);
  return {
    ok: true,
    filters: {
      ...(states ? { states } : {}),
      ...(outcomes ? { outcomes } : {}),
      ...(dispositionCodes ? { dispositionCodes } : {}),
      ...(agentUserId ? { agentUserId } : {}),
      ...(contactId ? { contactId } : {}),
      ...(phone ? { phone } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    },
  };
}

export function parseContactFilters(query: Record<string, unknown>): FilterParse<AgencyContactFilters> {
  const issues: FilterIssue[] = [];
  const states = validateEnum('state', multiParam(query['state']), CONTACT_STATES, issues);
  const suppressedReasons = validateEnum(
    'suppressed_reason', multiParam(query['suppressed_reason']), SUPPRESSED_REASONS, issues,
  );
  // `last_outcome` is `VARCHAR(30)` with no CHECK and carries whatever the
  // classifier last wrote, so it is validated against the attempt vocabulary —
  // the only producer — but kept as plain strings on the filter.
  const lastOutcomes = validateEnum('last_outcome', multiParam(query['last_outcome']), ATTEMPT_OUTCOMES, issues);
  // NOT validated here, for the reason `disposition_code` is not validated on the
  // attempt filters: the catalog is per campaign and a retired code still exists
  // on historic rows, which are the rows this question is about. See
  // `AgencyContactFilters.lastDispositions`.
  const lastDispositions = multiParam(query['last_disposition']);
  const from = parseFilterDate('from', query['from'], issues);
  const to = parseFilterDate('to', query['to'], issues);
  checkRange(from, to, issues);
  const phone = readPhoneFilter(query['phone'], issues);
  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    filters: {
      ...(states ? { states } : {}),
      ...(suppressedReasons ? { suppressedReasons } : {}),
      ...(lastOutcomes ? { lastOutcomes } : {}),
      ...(lastDispositions ? { lastDispositions } : {}),
      ...(phone ? { phone } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    },
  };
}

// ─── The retry selector ─────────────────────────────────────────────────────

/**
 * `suppressed_reason` values a retry selector may name.
 *
 * A strict subset of {@link SUPPRESSED_REASONS}: `dnc` and `invalid` are never
 * retried, and are refused with their own message rather than being absent from
 * this list, because
 * "unknown suppressed_reason: dnc — expected one of max_attempts, manual" invites
 * the reader to conclude the server does not know what DNC is. See
 * {@link SELECTOR_SUPPRESSION_REFUSAL}.
 */
export const RETRY_SELECTABLE_SUPPRESSED_REASONS = ['max_attempts', 'manual'] as const;

/** The two never-retried excludes, as their own set so the refusal and the message agree. */
const NEVER_RETRIED_SUPPRESSIONS: readonly string[] = ['dnc', 'invalid'];

const SELECTOR_SUPPRESSION_REFUSAL =
  "dnc and invalid suppressions are never retried — see the campaign's DNC list";

/**
 * States a retry selector may name.
 *
 * `in_flight` is excluded, and refused by name the way the never-retried rule refuses `dnc`.
 *
 * A contact in `in_flight` is ON A CALL RIGHT NOW. `claimDialable` flips the
 * state when the attempt starts; `chargeAttempt` writes `last_outcome` and bumps
 * `attempt_count` only at settle. So a contact whose first attempt is ringing at
 * this instant is `state = 'in_flight'`, `last_outcome IS NULL`,
 * `attempt_count = 0` — which is to say it satisfies BOTH `__none__` (the
 * default selector's outcome member) and `never_attempted: true`. Seeding it
 * into a child and starting that child dials a number the parent has an open
 * call on.
 *
 * `uq_agency_campaign_running` does not prevent this: it refuses a second
 * RUNNING campaign, and the workflow that reaches here is "this campaign is
 * going badly — pause it and retry who we missed". Pausing does not cancel
 * in-flight attempts, and a paused parent leaves the running slot free.
 *
 * The refusal is the visible half; the predicate excludes `in_flight`
 * unconditionally (`retrySelectionConditions`) so a contact that is ringing is
 * never seeded however it was selected — including through `__none__` and
 * `never_attempted`, which name no state at all.
 *
 * `connected` stays selectable: after settle it means wrap-up
 * (`last_outcome = 'connected'`, attempt `ended`), a cohort a supervisor may
 * retry. Mid-call it is the same live snapshot as `in_flight` — the `bridged`
 * handler parks the row there when a disposition is owed — and a later
 * attempt keeps the prior `last_outcome` (e.g. `no_answer`), so a NULL-outcome
 * conjunct would miss it. The predicate therefore excludes any contact with a
 * live `agency_call_attempts` row (`state <> 'ended'`), the same discriminator
 * as `uq_agency_attempt_live`. Refusing the state by name would hide the
 * wrap-up cohort.
 */
export const RETRY_SELECTABLE_STATES = CONTACT_STATES.filter((s) => s !== 'in_flight');

const SELECTOR_IN_FLIGHT_REFUSAL =
  'in_flight contacts are on a call right now and are never seeded into a retry — '
  + 'retry them once their attempt settles';

/**
 * Every key a retry selector may carry. Anything else is refused BY NAME.
 *
 * Declared once and read both by the unknown-key check and by the "did you name
 * any dimension at all" check, so the two cannot come to disagree about what a
 * dimension is.
 */
const RETRY_SELECTOR_KEYS = [
  'state',
  'last_outcome',
  'last_disposition',
  'suppressed_reason',
  'never_attempted',
  'attempt_count_gte',
  'attempt_count_lte',
] as const;

/**
 * `last_outcome` values a RETRY selector may name: the nine real outcomes plus
 * {@link RETRY_NO_OUTCOME}.
 *
 * ── Why the retry surface has a WIDER vocabulary than the contacts list ─────
 *
 * The selector algebra is AND across dimensions, which is correct and matches
 * `listForCampaign`. But "we did not reach them" — the single most common cohort
 * a supervisor retries, and the one the default selection offers — is a UNION of
 * two facts: the calls that rang out, and the contacts a campaign stopped
 * mid-run never dialled at all. Expressed as two DIMENSIONS those AND together
 * into the empty set, because a contact with no attempts has no outcome:
 * `last_outcome = ANY('{no_answer,busy}') AND attempt_count = 0` is
 * unsatisfiable. That was the shipped default, and it matched nothing on every
 * campaign, forever — the Retry button on the campaign header was dead.
 *
 * Making "never attempted" a MEMBER of the outcome dimension puts the union
 * inside one key, where OR is already what the algebra does. No special case, no
 * second parser, and no change to the AND-across-dimensions rule.
 *
 * Deliberately NOT added to `parseContactFilters`: the contacts list is a
 * shipped surface with its own vocabulary and its own UI, and widening it is a
 * separate change. `never_attempted` remains the general-purpose spelling for
 * combining "no attempts" with some OTHER dimension.
 */
export const RETRY_OUTCOME_SELECTABLES = [
  ...ATTEMPT_OUTCOMES,
  RETRY_NO_OUTCOME,
] as const;

/**
 * `true`/`false`, as a string or a boolean.
 *
 * Both forms are in the wild for the same reason {@link multiParam} takes two:
 * the preview arrives as a query string, where every value is a string, and the
 * create arrives as JSON, where a client sends a real boolean. One parser for
 * both is the whole point of this function existing — a selector that means one
 * thing on the preview and another on the commit is the defect the shared parser
 * exists to prevent.
 *
 * Anything else is refused rather than coerced. `never_attempted=yes` coerced to
 * `false` (or to `true`) is a cohort the operator did not choose, and on this
 * surface a wrong cohort is a real customer being dialled or not dialled.
 */
function readSelectorBoolean(
  param: string,
  raw: unknown,
  issues: FilterIssue[],
): boolean | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'boolean') return raw;
  const value = singleParam(raw);
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  issues.push({ param, message: `must be true or false, not '${value}'` });
  return undefined;
}

/**
 * A non-negative integer bound on `attempt_count`.
 *
 * Refused rather than floored, for the reason every refusal on this surface is a
 * refusal: `attempt_count_gte=2.5` floored to 2 answers a question nobody asked,
 * and `attempt_count_gte=-1` silently means "no lower bound" — which is the whole
 * roster, presented as a narrowed one.
 */
function readAttemptCountBound(
  param: string,
  raw: unknown,
  issues: FilterIssue[],
): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  let value: number;
  if (typeof raw === 'number') {
    value = raw;
  } else {
    // `?attempt_count_gte=` is what a cleared number field posts and plainly
    // means "no bound" — the same reading `singleParam` gives every other param
    // on this surface. Anything non-blank has to parse.
    const text = singleParam(raw);
    if (text === undefined) return undefined;
    value = Number(text);
  }
  if (!Number.isInteger(value) || value < 0) {
    issues.push({ param, message: 'must be a whole number of attempts, 0 or more' });
    return undefined;
  }
  return value;
}

/**
 * Parse a retry selector from EITHER a query object (the preview) or a JSON body
 * object (the create).
 *
 * ── One function, and that is the point ─────────────────────────────────────
 *
 * `GET /:id/retry/preview` promises a count and `POST /:id/retry` delivers a
 * roster. If they parsed their inputs separately, the two would eventually
 * disagree about what `?state=pending,connected` means, and the failure mode is a
 * supervisor confirming 812 contacts and getting a different set — invisible,
 * because both numbers look plausible. Same argument as
 * `ABANDONED_ATTEMPT_PREDICATE_SQL`'s single definition, one layer up.
 *
 * `multiParam` already folds the three encodings a caller sends — repeated
 * (`?state=a&state=b`), comma-joined (`?state=a,b`) and a real JSON array
 * (`{"state":["a","b"]}`) — into one list, which is what makes a single parser
 * possible without a second set of helpers.
 *
 * ── Why unknown keys are REFUSED rather than ignored ────────────────────────
 *
 * The supervisor reaches this from a filtered Contacts tab, and that tab filters
 * on `phone`, `from` and `to` as well. Carrying those through and ignoring them
 * would produce a roster wider than the list the operator was looking at when
 * they pressed the button, while the dialog still showed their chips. The console
 * strips them before calling and says so in the dialog; this is the enforcement
 * that makes that promise real for every other caller.
 *
 * ── The returned shape is the STORED shape ──────────────────────────────────
 *
 * `AgencyRetrySelector` is what goes onto `agency_campaigns.retry_selector` and
 * what the agent's banner is rendered from. What is stored is therefore this
 * NORMALISED value, not the raw request object — the normalisation only folds the
 * accepted encodings into arrays and coerces the two scalar forms; it never adds,
 * drops or reinterprets a dimension, so the record still says exactly what the
 * operator asked for, in one shape every reader can read. Storing the raw body
 * would mean the banner had to re-parse it against a catalog (the CHILD's) that
 * is not the one it was validated against.
 *
 * @param catalog the PARENT campaign's `disposition_catalog`, which
 *   `last_disposition` is validated against (∪ the built-in codes). The preview
 *   and the create both pass the parent's, so the vocabulary a 400 echoes is the
 *   one the seeding predicate will actually run against.
 */
export function parseRetrySelector(
  source: Record<string, unknown>,
  opts: { catalog: readonly AgencyDisposition[] },
): FilterParse<AgencyRetrySelector> {
  const issues: FilterIssue[] = [];

  // First, because every later message is about a dimension and this one is about
  // the request naming something that is not one. Reported per offending key, so a
  // console can mark all of them at once.
  const known = new Set<string>(RETRY_SELECTOR_KEYS);
  for (const key of Object.keys(source)) {
    if (!known.has(key)) {
      issues.push({ param: key, message: `${key} is not a retry selector dimension` });
    }
  }

  // Same shape as the never-retried refusal below, and for the same reason: "unknown
  // state: in_flight — expected one of pending, connected, …" would read as the server
  // not knowing its own vocabulary, when the rule is that a contact currently on
  // a call is not retryable YET. See `RETRY_SELECTABLE_STATES`.
  const stateRaw = multiParam(source['state']);
  let state: AgencyContactState[] | undefined;
  if (stateRaw?.includes('in_flight')) {
    issues.push({ param: 'state', message: SELECTOR_IN_FLIGHT_REFUSAL });
  } else {
    state = validateEnum('state', stateRaw, RETRY_SELECTABLE_STATES, issues);
  }
  const lastOutcome = validateEnum(
    'last_outcome', multiParam(source['last_outcome']), RETRY_OUTCOME_SELECTABLES, issues,
  );

  // The never-retried rule, checked BEFORE the vocabulary so `dnc` gets the message
  // that explains the rule rather than one that reads as the server not knowing the value.
  const suppressedRaw = multiParam(source['suppressed_reason']);
  const neverRetried = suppressedRaw?.filter((v) => NEVER_RETRIED_SUPPRESSIONS.includes(v)) ?? [];
  let suppressedReason: string[] | undefined;
  if (neverRetried.length > 0) {
    issues.push({ param: 'suppressed_reason', message: SELECTOR_SUPPRESSION_REFUSAL });
  } else {
    suppressedReason = validateEnum(
      'suppressed_reason', suppressedRaw, RETRY_SELECTABLE_SUPPRESSED_REASONS, issues,
    );
  }

  // The one vocabulary that is not a closed union. Built from the PARENT's catalog
  // ∪ the built-ins and echoed in the 400, exactly as `allowed_codes` does for a
  // console holding a stale catalog — the operator's next move is to pick a code
  // that exists, and they cannot do that unless they are told which do.
  //
  // Built-ins are included because a campaign's stored catalog may omit them while
  // `voicemail` / `callback` / `do_not_call` are still written onto contacts by
  // the disposition path, so they are legitimately present in the data being
  // selected over.
  const allowedDispositions = [
    ...opts.catalog.map((entry) => entry.code),
    ...[...BUILT_IN_DISPOSITION_CODES].filter((code) => !opts.catalog.some((e) => e.code === code)),
  ];
  const lastDisposition = validateEnum(
    'last_disposition', multiParam(source['last_disposition']), allowedDispositions, issues,
  );

  const neverAttempted = readSelectorBoolean('never_attempted', source['never_attempted'], issues);
  const gte = readAttemptCountBound('attempt_count_gte', source['attempt_count_gte'], issues);
  const lte = readAttemptCountBound('attempt_count_lte', source['attempt_count_lte'], issues);

  // Two selectors that are individually well-formed and jointly match nothing.
  // Refused rather than run, because "0 contacts matched" on this surface reads as
  // a fact about the campaign — "there is nobody left to retry" — rather than as a
  // fact about the query, and the operator would go looking for the wrong problem.
  if (neverAttempted === true && gte !== undefined && gte >= 1) {
    issues.push({
      param: 'never_attempted',
      message: 'never_attempted cannot be combined with attempt_count_gte',
    });
  }
  if (gte !== undefined && lte !== undefined && gte > lte) {
    issues.push({ param: 'attempt_count_gte', message: 'must not exceed attempt_count_lte' });
  }

  const selector: AgencyRetrySelector = {
    ...(state ? { state } : {}),
    ...(lastOutcome ? { last_outcome: lastOutcome } : {}),
    ...(lastDisposition ? { last_disposition: lastDisposition } : {}),
    ...(suppressedReason ? { suppressed_reason: suppressedReason } : {}),
    ...(neverAttempted !== undefined ? { never_attempted: neverAttempted } : {}),
    ...(gte !== undefined ? { attempt_count_gte: gte } : {}),
    ...(lte !== undefined ? { attempt_count_lte: lte } : {}),
  };

  // ── The empty selector is refused, and it is the most important refusal here ─
  //
  // An empty `AgencyContactFilters` means "the whole roster", which on a READ is
  // the right default — the contacts page opens unfiltered. Here it would seed a
  // second copy of an entire campaign from a request that named nothing, which is
  // never what a supervisor pressing "Retry these contacts" meant, and there is no
  // campaign delete route to undo it with.
  //
  // The message names the deliberate way to ask for the whole roster, because
  // refusing without one turns a legitimate (if unusual) intent into a dead end.
  //
  // Checked on the PARSED selector rather than on `Object.keys(source)`: a request
  // carrying only refused keys, or only blank values (`?state=` is what a cleared
  // filter posts), has named no dimension however many keys it sent.
  if (issues.length === 0 && Object.keys(selector).length === 0) {
    issues.push({
      param: 'selector',
      message:
        'name at least one dimension — to retry the whole roster, select every contact state',
    });
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, filters: selector };
}

/** Page size. The ceiling is the export's page size too — see the routes. */
export const SPINE_DEFAULT_LIMIT = 50;
export const SPINE_MAX_LIMIT = 500;

export function clampLimit(raw: unknown): number {
  const value = Number(singleParam(raw) ?? SPINE_DEFAULT_LIMIT);
  if (!Number.isFinite(value)) return SPINE_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(value), 1), SPINE_MAX_LIMIT);
}

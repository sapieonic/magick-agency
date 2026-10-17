/**
 * The agency repository's WHERE-clause builders and keyset paging: the positional
 * parameter accumulator, the phone / contact / retry-selector / attempt filters, and
 * the keyset predicate and page. A leaf: it imports only `sql-fragments.ts` from
 * this folder.
 */
import { encodeKeysetCursor, type AgencyKeysetPosition } from '@magick-agency/domain/keyset-cursor';
import {
  RETRY_NO_OUTCOME,
  type AgencyAttemptFilters,
  type AgencyContactFilters,
  type PhoneFilter,
} from '../../../agency/spine-filters.js';
import type { AgencyRetrySelector, AgencyKeysetPage } from '@magick-agency/contracts/agency';
import type { AgentAttemptFilters } from '../../../agency/agent-record.js';
import { CONTACT_PHONE_DIGITS_SQL } from './sql-fragments.js';

// ─── Supervisor read surface — shared paging machinery ────────────

/**
 * Positional-parameter accumulator.
 *
 * The two list reads below build their WHERE clause from an optional filter set,
 * so parameter numbering cannot be written by hand without the numbers and the
 * values drifting apart the first time a filter is inserted in the middle. This
 * makes `$n` and the value one operation.
 */
export function params(): { values: unknown[]; add: (value: unknown) => string } {
  const values: unknown[] = [];
  return {
    values,
    add(value: unknown): string {
      values.push(value);
      return `$${values.length}`;
    },
  };
}

/**
 * The phone predicate, in whichever of its two forms the caller meant.
 *
 * ── Both forms compare DIGITS, not the stored string ────────────────────────
 * `phone_e164` is `VARCHAR(20)` with no format constraint, and the roster is
 * built from customer CSVs — `+91 98765 43210` and `+919876543210` are the same
 * number and both occur. Comparing the raw column would answer "no such
 * contact" for a number that is plainly there, on a route someone reaches from a
 * complaint holding the number in whatever shape they were given it.
 *
 * The expression is `CONTACT_PHONE_DIGITS_SQL`, reused rather than respelled so
 * it stays byte-identical to `idx_agency_contacts_campaign_phone_digits`
 * — Postgres matches expression indexes structurally, so a
 * different spelling of the same regex silently costs the index. With the
 * campaign predicate that makes the EXACT form an index scan.
 *
 * The SUFFIX form — "the last four digits", the useful partial shape, since
 * every stored value begins with a country code — is served by
 * `idx_agency_contacts_phone_suffix`, which indexes the REVERSED digits: a
 * suffix search on a string is a prefix search on its reverse. Written naively
 * as `LIKE '%1234'` it was a 289ms parallel sequential scan of a 1M-row
 * campaign; through that index it is 1.0ms.
 *
 * `alias` is the table holding `phone_e164` — `agency_contacts` in both reads,
 * reached through a join on the attempts side. Aliasing does not affect index
 * matching: the planner compares parsed expressions, not text.
 */
export function phoneCondition(
  filter: PhoneFilter,
  alias: string,
  bind: ReturnType<typeof params>,
): string {
  const digits = CONTACT_PHONE_DIGITS_SQL.replace('phone_e164', `${alias}.phone_e164`);
  // Re-stripped here, not trusted from the caller. `parsePhoneFilter` already
  // does it, but this is the only place a `%` or `_` could become a LIKE
  // wildcard, and the consequence is not an error — it is a filter that matches
  // MORE than it says. `LIKE '%%'` returns the whole campaign under a chip
  // reading "phone: %", which is a wider answer presented as a narrower one.
  //
  // ⚠️ A digit-less term is refused HERE as a backstop only. The route path can
  // no longer reach this branch — `parsePhoneFilter` reports `'unusable'` and
  // the route answers 400 — and that ordering matters: this function is only
  // called once a filter object EXISTS, so a parser that folded "unusable" into
  // "absent" would drop the predicate entirely and never arrive here at all.
  // The guard reads like the protection and the parser is where it lives.
  const term = filter.value.replace(/\D/g, '');
  if (term.length === 0) return 'FALSE';
  if (filter.mode === 'exact') {
    // The `+` was stripped by the parser; the indexed expression holds digits only.
    return `${digits} = ${bind.add(term)}`;
  }
  // A suffix search on the number is a PREFIX search on its reverse, which is
  // what `idx_agency_contacts_phone_suffix` indexes. Written as
  // `LIKE 'x%'` rather than a hand-rolled range so the planner does the
  // `~>=~ / ~<~` rewrite itself — getting the upper bound wrong by hand is a
  // silently short result set. The literal `%` is appended in SQL, so the
  // parameter carries no wildcard and a `%` typed into the search box is data.
  return `reverse(${digits}) LIKE ${bind.add(reverseString(term))} || '%'`;
}

/** Reverse a string of digits — the search term, to match the reversed column. */
function reverseString(value: string): string {
  return value.split('').reverse().join('');
}

/**
 * ─── THE ONE PLACE A CONTACT FILTER BECOMES SQL ─────────────────────────────
 *
 * Two callers, and they must never disagree:
 *
 *  - {@link AgencyContactRepository.listForCampaign} — the supervisor's Contacts
 *    tab, which is where a retry selection is authored.
 *  - {@link retrySelectionConditions} — the predicate that seeds a retry
 *    campaign's roster, and the predicate that counts it for the preview.
 *
 * **This is the same single-definition rule `ABANDONED_ATTEMPT_PREDICATE_SQL`
 * exists for, applied to a filter instead of a fact.** The supervisor narrows the
 * contacts list until it shows the rows they mean, presses "Retry these
 * contacts", and the filter they were looking at becomes the selector. If the
 * list's SQL and the seeding SQL were written twice, "the rows I was looking at"
 * and "the rows that got seeded" would eventually be different sets — and the
 * failure is silent, because both counts look plausible and neither is obviously
 * the wrong one.
 *
 * Note what is NOT here: `phone`, `from` and `to`. They are contact filters and
 * `listForCampaign` appends them itself, because they are also the three the
 * retry selector deliberately refuses (a phone is a lookup, not a cohort;
 * `created_at` is when the row was ingested). Folding them in would let a future
 * caller of this function acquire them by accident, which is precisely the
 * "wider set than the one the operator chose" this whole surface guards against.
 *
 * `alias` is the table holding the columns, so the same conditions can be used
 * inside a `SELECT … FROM agency_contacts c` and inside an `INSERT … SELECT`.
 */
export function contactFilterConditions(
  filters: AgencyContactFilters,
  alias: string,
  bind: ReturnType<typeof params>,
): string[] {
  const conditions: string[] = [];
  if (filters.states?.length) {
    conditions.push(`${alias}.state = ANY(${bind.add(filters.states)}::varchar[])`);
  }
  if (filters.suppressedReasons?.length) {
    conditions.push(`${alias}.suppressed_reason = ANY(${bind.add(filters.suppressedReasons)}::varchar[])`);
  }
  if (filters.lastOutcomes?.length) {
    conditions.push(`${alias}.last_outcome = ANY(${bind.add(filters.lastOutcomes)}::varchar[])`);
  }
  if (filters.lastDispositions?.length) {
    conditions.push(`${alias}.last_disposition = ANY(${bind.add(filters.lastDispositions)}::varchar[])`);
  }
  return conditions;
}

/**
 * The never-retried suppression exclusion, as SQL. **Unconditional, and not driven by the selector.**
 *
 * `suppressed_reason` has four values. Two of them are never retried, whatever a
 * selector says:
 *
 *  - `dnc` — a customer's recorded request not to be contacted. Not an operator
 *    choice, so it is excluded by the query rather than by an unchecked checkbox.
 *  - `invalid` — "a bad number does not become good" is the settled rule
 *    (`DEFAULT_RETRY_POLICY.invalid`), and `resolveRetryDecision` routes
 *    `invalid` to `suppressed` BEFORE it reads any policy. Seeding those numbers
 *    into a fresh campaign is exactly the config circumvention that rule exists
 *    to prevent.
 *
 * `parseRetrySelector` already refuses a selector that NAMES either value — but
 * that refusal is the explanation, not the enforcement, and the two are different
 * things. A selector of `state: ['suppressed']` names neither and matches both,
 * which is why this arm cannot be conditional on what the selector said.
 *
 * ⚠️ **Scope, stated plainly:** the DNC list is checked at DIAL time, from
 * `dnc_entries` (decision B8), per attempt (`pre-dial-gates.ts`), so a number suppressed AFTER this roster was
 * seeded is still refused. This exclusion is about INTENT, not enforcement — it
 * stops the platform writing a roster row that says "we intend to call this
 * person", which is a different and worse artefact than a call that gets stopped.
 *
 * A literal array rather than a bound parameter: the values are this rule, not
 * input, and inlining them keeps the predicate readable in a log'd query plan.
 */
export function neverSeededSuppressionSql(alias: string): string {
  // ── The `COALESCE` is NULL-safety, not defensive padding ──────────────────
  //
  // ⚠️ The obvious spelling — `${alias}.suppressed_reason = ANY('{dnc,invalid}')`
  // — is WRONG here, and it shipped. Callers use this predicate NEGATED
  // (`NOT (...)`), and `suppressed_reason` is nullable with no default,
  // so it is NULL for every contact that was never suppressed —
  // which is nearly the whole retryable roster.
  //
  // Three-valued logic then does this: `NULL = ANY(...)` is NULL, `NOT NULL` is
  // NULL, and `WHERE NULL` REJECTS the row. Measured on Postgres 16 against six
  // rows (two NULL, two suppressed for retryable reasons, one `dnc`, one
  // `invalid`): the bare form returned 2 rows, this form returns 4.
  //
  // What that cost: every ordinary retry previewed `matched: 0` and the create
  // answered `409 retry_selection_empty`, telling the supervisor to widen a
  // selection that was already as wide as it goes. The feature did not work at
  // all, and the whole suite stayed green — because the tests assert this
  // function's OUTPUT STRING rather than its meaning.
  //
  // `IS NOT DISTINCT FROM ANY(...)` reads better and is NOT valid Postgres
  // (`42601 syntax error at or near "ANY"`, confirmed against a real server).
  // `COALESCE` to a sentinel the column can never legally hold works in BOTH
  // senses this helper is used in: negated for the seed's `WHERE`, and positive
  // for the preview's `excluded` FILTERs. `claimDialable` reaches for the same
  // NULL-safety one table over (`IS DISTINCT FROM 'dnc'`) — that is the house
  // rule for this column, and this function departed from it.
  //
  // Pinned against a real database by `test/integration/agency/
  // agency-retry-seeding.test.ts`. A text assertion cannot see this class
  // of defect; do not "simplify" it back under one.
  return `COALESCE(${alias}.suppressed_reason, '') = ANY('{dnc,invalid}')`;
}

/**
 * The retry selector as a WHERE clause, over the PARENT's roster.
 *
 * ONE builder, used by the preview's count and by the commit's `INSERT … SELECT`.
 * The preview promising a count the commit does not deliver is the class of
 * defect this shares its rule with — see {@link contactFilterConditions} and
 * `ABANDONED_ATTEMPT_PREDICATE_SQL`'s header.
 *
 * Does NOT include the parent's `campaign_id`; each caller adds it, because the
 * preview and the seeding statement bind it in different positions and one of
 * them also has to bind the CHILD's id.
 */
export function retrySelectionConditions(
  selector: AgencyRetrySelector,
  alias: string,
  bind: ReturnType<typeof params>,
): string[] {
  // `__none__` is a MEMBER of the outcome dimension, not a dimension of its own
  // — `RETRY_OUTCOME_SELECTABLES`' docstring carries the argument. Split it out
  // before delegating, so the shared contact-filter builder (which serves the
  // shipped contacts list and must not change meaning) keeps seeing a plain
  // enum list.
  const named = (selector.last_outcome ?? []).filter((o) => o !== RETRY_NO_OUTCOME);
  const wantsNoOutcome = (selector.last_outcome ?? []).includes(RETRY_NO_OUTCOME);

  const conditions = contactFilterConditions({
    ...(selector.state ? { states: selector.state } : {}),
    ...(named.length ? { lastOutcomes: named } : {}),
    ...(selector.last_disposition ? { lastDispositions: selector.last_disposition } : {}),
    ...(selector.suppressed_reason ? { suppressedReasons: selector.suppressed_reason } : {}),
  }, alias, bind);

  // OR *within* the dimension, which is what the algebra already promises for
  // every other key. The delegate has just pushed the named-outcome term, so it
  // is popped and rebuilt as one parenthesised disjunct rather than ANDed beside
  // it: `(no_answer OR no outcome)`, never `no_answer AND no outcome` — the
  // latter is the empty set, and was the shipped default.
  if (wantsNoOutcome) {
    const namedTerm = named.length ? conditions.pop() : null;
    conditions.push(
      namedTerm
        ? `(${namedTerm} OR ${alias}.last_outcome IS NULL)`
        : `${alias}.last_outcome IS NULL`,
    );
  }

  // The two dimensions that are NOT contact filters. `pending`
  // contacts on a campaign that was stopped mid-run are the single most obvious
  // retry there is, and no combination of the closed vocabularies expresses
  // "nobody ever dialled these".
  //
  // `false` is the symmetric opposite rather than a no-op — see
  // `AgencyRetrySelector.never_attempted` for why a present-but-unconstraining
  // key is the dangerous reading.
  if (selector.never_attempted === true) conditions.push(`${alias}.attempt_count = 0`);
  if (selector.never_attempted === false) conditions.push(`${alias}.attempt_count > 0`);
  if (selector.attempt_count_gte !== undefined) {
    conditions.push(`${alias}.attempt_count >= ${bind.add(selector.attempt_count_gte)}`);
  }
  if (selector.attempt_count_lte !== undefined) {
    conditions.push(`${alias}.attempt_count <= ${bind.add(selector.attempt_count_lte)}`);
  }

  // ── Never the contact we are calling RIGHT NOW ────────────────────────────
  //
  // Unconditional, like the suppression exclude above and for the same reason: it
  // is a property of the row, not a dimension the operator chose.
  //
  // `claimDialable` flips `state → in_flight` when an attempt starts;
  // `chargeAttempt` writes `last_outcome` and bumps `attempt_count` only when
  // the call settles. A contact whose FIRST attempt is ringing at this instant
  // is therefore `in_flight` / `last_outcome IS NULL` / `attempt_count = 0` —
  // which satisfies `__none__` (a member of the default selector) and
  // `never_attempted: true` alike. Both of those name no state, so refusing
  // `state: ['in_flight']` at parse time does not reach them; only this does.
  //
  // The same snapshot, one state later: when the campaign owes a wrap-up
  // (`requiresDisposition('connected', catalog)`), the `bridged` handler parks
  // the contact in `connected` WHILE THE CALL IS STILL LIVE and does not write
  // `last_outcome` — that lands in the `ended` handler. Mid-conversation the
  // first-attempt row is therefore `connected` / `last_outcome IS NULL` /
  // `attempt_count = 0`, which is the same `__none__` / `never_attempted`
  // match as ringing.
  //
  // A later attempt is the same live call with a DIFFERENT contact snapshot.
  // `chargeAttempt` retains the prior outcome and returns the row to `pending`;
  // `claimDialable` flips only `state`. After a retryable `no_answer`, a
  // bridged second attempt is `connected` / `last_outcome = 'no_answer'` /
  // `attempt_count = 1` — which satisfies the default selector's `no_answer`
  // member, and which a `last_outcome IS NULL` conjunct cannot see.
  // `RETRY_SELECTABLE_STATES` *allows* `connected` because post-settle wrap-up
  // (`connected` + ended attempt) is a real cohort. The discriminator is
  // therefore the live attempt row, the same predicate as
  // `uq_agency_attempt_live` (`state <> 'ended'`). Without it: pause a
  // disposition-catalog campaign, retry "everyone we did not reach", start the
  // child, and the numbers the parent's agents are talking to — first attempt
  // or later — are dialled a second time. Pause still does not hang up a
  // bridged call.
  //
  // Without the `in_flight` term: pause a campaign that is going badly, retry
  // "everyone we did not reach", start the child, and the numbers still
  // ringing on the parent are dialled a second time. `uq_agency_campaign_running`
  // does not bite — it refuses a second RUNNING campaign, and a paused parent
  // is not running, while pause does not cancel attempts already in flight.
  // The contact-state term stays: `claimDialable` flips `in_flight` before the
  // attempt row exists, and a NULL-outcome first ring matches `__none__` in
  // that window. The EXISTS covers every later state that still has a live
  // attempt, including `connected` after a prior outcome.
  //
  // Pinned against a real database, not against this string: the unit suite
  // asserts SQL TEXT and cannot see that `IS NULL` and `= 0` are both true of a
  // live first dial. That is exactly how the NULL-unsafe suppression predicate
  // survived a green suite.
  conditions.push(`${alias}.state <> 'in_flight'`);
  conditions.push(
    `NOT EXISTS (SELECT 1 FROM agency_call_attempts rla`
    + ` WHERE rla.contact_id = ${alias}.id AND rla.state <> 'ended')`,
  );
  return conditions;
}

/**
 * The attempt filters both attempt lists share, as SQL — the attempt-side
 * counterpart of {@link contactFilterConditions}.
 *
 * `scoped` is the caller's own term, placed after the three vocabulary filters
 * (the campaign spine's agent subquery); `listForAgent` has none, its agent IS the
 * scope. `from`/`to` bound `created_at`, the column the keyset orders by — NOT
 * `dialed_at`, which is NULL on an attempt that never left the building and would
 * drop those rows from a date-filtered view.
 */
export function attemptFilterConditions(
  f: AgencyAttemptFilters | AgentAttemptFilters,
  bind: ReturnType<typeof params>,
  scoped?: () => string | null,
): string[] {
  const conditions: string[] = [];
  if (f.states?.length) conditions.push(`a.state = ANY(${bind.add(f.states)}::varchar[])`);
  if (f.outcomes?.length) conditions.push(`a.outcome = ANY(${bind.add(f.outcomes)}::varchar[])`);
  if (f.dispositionCodes?.length) {
    conditions.push(`a.disposition_code = ANY(${bind.add(f.dispositionCodes)}::varchar[])`);
  }
  const term = scoped?.();
  if (term) conditions.push(term);
  if (f.contactId) conditions.push(`a.contact_id = ${bind.add(f.contactId)}::uuid`);
  if (f.phone) conditions.push(phoneCondition(f.phone, 'c', bind));
  if (f.from) conditions.push(`a.created_at >= ${bind.add(f.from)}`);
  if (f.to) conditions.push(`a.created_at <= ${bind.add(f.to)}`);
  return conditions;
}

/**
 * The keyset predicate, as a row-wise comparison.
 *
 * `(created_at, id) < ($a, $b)` rather than the expanded
 * `created_at < $a OR (created_at = $a AND id < $b)`: the row-wise form is what
 * Postgres can drive straight off a `(campaign_id, created_at DESC, id DESC)`
 * index as a single range scan. The expanded form makes the planner choose
 * between two branches and typically degenerates into a scan-and-filter over
 * every tie — and ties are ordinary here, because ingest and the attempt
 * batcher both insert in batches inside one transaction where `now()` is fixed.
 *
 * The cursor's timestamp is passed as text and cast, not as a `Date`: a `Date`
 * holds milliseconds and this column holds microseconds. See `keyset-cursor.ts`.
 */
export function keysetCondition(
  position: AgencyKeysetPosition,
  alias: string,
  bind: ReturnType<typeof params>,
): string {
  return `(${alias}.created_at, ${alias}.id) < (${bind.add(position.at)}::timestamptz, ${bind.add(position.id)}::uuid)`;
}

/**
 * Turn `limit + 1` fetched rows into a page.
 *
 * Fetching one extra row is how `next_cursor` is decided without a second query
 * and without a `COUNT`: if the extra row exists there is more to read, and the
 * cursor is minted from the LAST row that is actually returned — never from the
 * extra one, which is not on this page and whose position would skip it.
 */
export function toKeysetPage<TRaw extends { cursor_at: string; id: string }, TRow>(
  raw: TRaw[],
  limit: number,
  project: (row: TRaw) => TRow,
): AgencyKeysetPage<TRow> {
  const hasMore = raw.length > limit;
  const page = hasMore ? raw.slice(0, limit) : raw;
  const last = page[page.length - 1];
  return {
    rows: page.map(project),
    next_cursor: hasMore && last ? encodeKeysetCursor({ at: last.cursor_at, id: last.id }) : null,
    limit,
  };
}

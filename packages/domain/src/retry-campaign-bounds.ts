/**
 * ─── RETRY CAMPAIGNS — THE THREE BOUNDS ──────────────────────────────────────
 *
 * These values fix what is refusable. Only the internal handlers ENFORCE them —
 * the public API layer and the console echo the numbers into copy ("up to 100,000
 * contacts") — which is exactly why they need one home rather than being spelled
 * at the two call sites that read them.
 *
 * A LEAF module with no imports, deliberately, the same way `timers.ts` is for
 * durations and `abandonment-predicate.ts` is for one definition of "abandoned":
 * a route, a repository and a unit test can all reach these without dragging the
 * config graph (which `process.exit(1)`s on an incomplete `.env`) along.
 *
 * ⚠️ **This is NOT `retry-policy.ts`, and the two vocabularies must not be
 * conflated.** That file is the per-CONTACT redial policy — how many times one
 * number is dialled within one campaign, keyed by outcome, with
 * `OUR_FAULT_REDIAL_BOUND` sitting underneath it. This file is about RETRY
 * CAMPAIGNS: a supervisor authoring a second campaign over a subset of a first
 * one's roster. The same trap exists on the stats surface, where
 * `attempts_retried` already means within-campaign redials and must not be
 * reused for this.
 */

/**
 * The largest roster a single `POST /:id/retry` will seed, and the reason the
 * route can answer `409 retry_selection_too_large` instead of holding a
 * transaction open for an unbounded time.
 *
 * The seeding is ONE `INSERT … SELECT` inside ONE transaction with the child
 * campaign row and the `contacts_total` update — because a half-seeded retry
 * campaign is the worst outcome available: it looks startable and dials a subset
 * nobody chose. That atomicity is what this number bounds. 100 000 rows is
 * comfortable for Postgres in a single statement; the cost is the transaction's
 * duration, during which the child campaign's `agency_contacts` rows are
 * uncommitted and the parent's rows are being read under `ACCESS SHARE`.
 *
 * **It is a refusal a human is present for, not a truncation**, and that is the
 * decision worth keeping: seeding the first 100 000 of 300 000 matched contacts
 * would produce a campaign that dials a subset nobody chose, which is precisely
 * the state the single transaction exists to prevent. The supervisor is told the
 * count and the cap and narrows the selector.
 *
 * If a tenant legitimately needs a larger retry the answer is chunking with
 * idempotency markers — the `agency_ingest_chunks` shape (077) the CSV path
 * already uses — not raising this number. That is a follow-up (an open question), because the answer depends on real roster sizes.
 */
export const RETRY_MAX_SEED_ROWS = 100_000;

/**
 * How deep a retry chain may go: a parent already at this generation cannot be
 * retried again (`409 retry_generation_exceeded`).
 *
 * The bound exists because nothing else stops a chain from growing — every retry
 * is an ordinary campaign, so an automated caller could build generation 4 000
 * one `POST` at a time, each one an indefinitely-growing lineage the supervisor's
 * strip and the agent's history read both walk.
 *
 * 10 is a product judgement, not a technical limit, and it is stated here rather
 * than as a CHECK on `agency_campaigns.retry_generation` for exactly that reason:
 * a number that will be tuned should not need a migration to tune. Ten passes
 * over one roster is already well past what any campaign design contemplates; a
 * supervisor who wants an eleventh is describing a new campaign, not a retry.
 *
 * Note the deliberate asymmetry with {@link RETRY_MAX_SEED_ROWS}: that one bounds
 * a resource, this one bounds a shape. Neither is a compliance limit — the
 * regulated repeat-dial ceiling is `OUR_FAULT_REDIAL_BOUND` in `retry-policy.ts`,
 * which is per-contact-ROW and therefore resets on every copy. That consequence needs its own compliance decision; this constant does not
 * answer it and must not be mistaken for having answered it.
 */
export const RETRY_MAX_GENERATION = 10;

/**
 * How many prior attempts the agent's `reserved` frame carries.
 *
 * Unchanged from the pre-lineage read — it was a bare `LIMIT 20` in the
 * repository — and now it spans the whole chain rather than one contact row. A
 * contact retried three times shows its most recent 20 attempts, newest first.
 *
 * It is a DISPLAY bound and it is also the bound on how much that read can cost
 * on the dial hot path, which is why widening it is not free: the query runs
 * synchronously before the dial, inside the tick, and the `reserved` frame it
 * feeds is the one payload whose latency the whole design guards hardest.
 *
 * Lifted out of the SQL so the number the contract publishes and the number the
 * query enforces are the same token. It is also the display
 * bound on a deep chain, alongside {@link RETRY_MAX_GENERATION}.
 */
export const PRIOR_ATTEMPT_LIMIT = 20;

/**
 * The config columns a retry campaign inherits from its parent.
 *
 * ── Why it lives in this leaf and not in the route that uses it ────────────
 * It was a `const` inside the route-registration closure, which made the one
 * list the contract pins unreachable by any test and by the repository it
 * feeds — an integration test then has to hand-copy seventeen column names to
 * build the object the route builds, which is the very drift the `satisfies`
 * below exists to prevent, reintroduced in the fixture. Importing the ROUTE
 * module to reach it is not an option either: that pulls in `src/config`, whose
 * module body `process.exit(1)`s on an incomplete `.env` and would take every
 * importing test with it. Hence here, beside the other contract constants, with
 * no imports of its own.
 *
 * Typed against `AgencyCampaignConfigColumns` rather than written as a second
 * free-standing array, so a column added to that `Pick` cannot become
 * inherited-but-not-overridable (or the reverse): the `satisfies` turns a
 * missing key into a build error rather than a silently un-inherited field.
 *
 * `keyof` is spelled inline rather than importing the type, to keep this module
 * import-free — the compiler still checks the list against the real column set
 * at every call site that assigns the built object to `AgencyCampaignConfigColumns`.
 */
export const RETRY_INHERITED_CONFIG_KEYS = [
  'caller_ids', 'telephony_provider', 'sip_connection_id',
  'calling_window_start', 'calling_window_end', 'calling_days', 'default_timezone',
  'wrapup_seconds', 'wrapup_auto_return', 'retry_policy', 'disposition_catalog',
  'context_display', 'break_reasons', 'record_calls', 'analysis_profile_id',
  'abandon_announcement_id', 'abandonment_ceiling_pct',
] as const;

/**
 * The shape a retry idempotency key must have to be accepted (migration 115).
 *
 * ── Why there is a MINIMUM length at all ──────────────────────────────────
 *
 * The uniqueness scope is `(tenant_id, retry_idempotency_key)`, so a short key
 * is not merely weak — it is a COLLISION between two supervisors in one tenant,
 * and the failure mode of that collision is silent: the second one is handed the
 * first one's campaign and told it is theirs. `crypto.randomUUID()` (36 chars) is
 * what the console sends; 16 is a floor low enough to admit any other sensible
 * token scheme and high enough that `"1"`, `"retry"` or a per-user constant is
 * refused at the boundary rather than discovered as a missing campaign.
 *
 * The maximum is the column width, checked here so an over-long key is a 400
 * naming the field rather than a `22001` surfacing as a 500.
 *
 * The charset is deliberately narrow — the alphabet of a UUID, a ULID, a
 * base64url nonce or a `<prefix>:<uuid>` — because the value is an OPAQUE TOKEN
 * we only ever compare for equality. Whitespace is excluded so a key that
 * round-tripped through a form field cannot differ from itself by a trailing
 * space and silently create a second campaign, which is this feature's whole
 * failure mode wearing a disguise.
 */
export const RETRY_IDEMPOTENCY_KEY_MIN = 16;
export const RETRY_IDEMPOTENCY_KEY_MAX = 64;
export const RETRY_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]+$/;

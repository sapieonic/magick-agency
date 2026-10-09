/**
 * The campaign read surface's wire shapes, as the public API layer reads them.
 *
 * A LEAF module: types, constants and pure functions. No fastify, no db — the
 * same shape and the same reason as {@link import('./agency-spine.js')}.
 *
 * ── What these types are FOR, stated plainly ───────────────────────────────
 * The public campaign routes send every handler body on unchanged
 * (`reply.send(result.body)`), so nothing here is applied to a response at
 * runtime and **that absence is the pass-through guarantee, not a gap in it**.
 * There is no Fastify `response` schema anywhere on the public agency routes (so
 * no ajv `removeAdditional`), no Zod response parse, and no field whitelist:
 * `enrichAgencyCampaignStats` is a spread over the internal handler's object and
 * says so in its own header at length. A field the handler adds therefore reaches
 * the console without this module being edited, which is exactly the property a
 * well-meaning "let's declare the response shape" refactor deletes.
 *
 * So these interfaces exist for two jobs, both of which are real:
 *
 *  1. **They type the fixtures.** The suites build handler bodies against them, so
 *     a field named wrongly or typed wrongly reds `npm run lint` rather than
 *     passing as a `Record<string, unknown>` key nobody checks.
 *  2. **They are the reader's contract of record.** "Which campaign fields does
 *     the console depend on reaching it?" is answerable here, without reading the
 *     console.
 *
 * They are deliberately **not exhaustive mirrors** of the `AgencyCampaignRecord`
 * row or `AgencyCampaignStats`. An exhaustive hand-mirror of a 30-field row that
 * nothing validates is a field list that drifts silently — the failure mode
 * `agency-stats-enrichment.ts` refuses a field list for. What is declared is what
 * the public routes, their suites or the console actually depend on.
 */

/**
 * Who caused a campaign's CURRENT status.
 *
 * ── The whole object is `null` where nobody did it ─────────────────────────
 * The abandonment auto-pause is the live case and the pacing leader's
 * finalization is the other. **`null` is therefore an answer ("the platform did
 * this"), never a missing value**, so it must not be back-filled with the
 * requesting user, an empty object or the string `'system'` anywhere on this path.
 *
 * ⚠️ The cost of that is real and the public layer must not paper over it:
 * `null` has TWO causes — genuinely automatic, or a caller that could have
 * attributed the transition and did not — and the payload cannot separate them.
 * The public route's job is to make the second cause rare (see
 * `resolveTransitionActor` in `proxy-agency-campaigns.routes.ts`), not to invent
 * a third state.
 *
 * ── The ID is the identity; the NAME is best-effort, hence `string | null` ──
 * The handler's formatter (`src/api/responses/agency-campaign.response.ts`) folds
 * two independently-nullable columns — `last_transition_by_user_id` and
 * `last_transition_by_name VARCHAR(255)` — as
 * `userId ? { user_id: userId, name: name ?? null } : null`. So:
 *
 *  - **no id ⇒ no actor at all.** An id is what a console resolves back to a
 *    person, so an actor nobody can resolve is served as an honest `null` rather
 *    than `{ user_id: '', name }`. That arm is unreachable through the API (the
 *    pair is written together) and reachable by a hand-run `UPDATE`;
 *  - **an id with no name is still an actor**, carrying `name: null`. A missing
 *    label does not un-attribute the transition, so it must not collapse the
 *    whole object.
 *
 * `name: string` was this type's first spelling and it was WRONG in the direction
 * that matters: nothing enforces it at runtime today (the public layer applies no
 * response schema, which is the whole finding of this module's header), but this
 * type is the reader's contract of record and it is what a future "let's validate
 * the response shape" refactor would encode — at which point the public route
 * would reject a payload the handler legitimately serves.
 */
export interface AgencyCampaignTransitionActor {
  /** The user id of the human who pressed the control. The identity. */
  user_id: string;
  /**
   * Their display name AT THE TRANSITION. The campaign row stores the string it
   * was handed and never re-resolves it against `users` — which is deliberate: an
   * audit field must say who it was then, not who that id belongs to now. `null` =
   * there was an id but no readable name.
   */
  name: string | null;
}

/**
 * The OPTIONAL body the public layer sends on the four lifecycle transitions.
 *
 * The request shape the internal handler's `readTransitionActor` reads. Both
 * members are optional on the wire and the omissions mean different things, so
 * neither may be spelled as a placeholder — the handler reads `'system'`, `''` and
 * `'unknown'` as real values, and `''` specifically is what makes
 * `readTransitionActor` return `null`, i.e. a name-shaped lie followed by a silent
 * un-attribution.
 *
 * ── The handler owns both ceilings, and the asymmetry between them ─────────
 * `actor_user_id` over 100 chars is DROPPED (the actor becomes `null`): a
 * truncated id is not a shortened answer, it is a different or nonexistent user,
 * and attributing a transition to the wrong human is the one failure the
 * `null`-means-unknown contract exists to prevent. `actor_name` over 255 is
 * TRUNCATED: it exists to be read, so losing its tail beats losing the
 * attribution.
 *
 * **The public layer deliberately implements neither rule.** A second copy of a
 * column width beside the one `readTransitionActor` enforces is the drift this
 * module's header argues against, and user ids are UUIDs (36 chars, comfortably
 * inside 100) so the drop arm is unreachable from the public routes anyway.
 * `users.display_name` is `TEXT` and therefore genuinely unbounded, so the
 * truncation arm IS reachable — and the handler's rule is to keep the name, which
 * is exactly what forwarding it unmodified produces. What the public layer must
 * never do is DROP a long name, which would turn a cosmetic loss into a lost
 * attribution.
 */
export interface AgencyCampaignTransitionRequest {
  actor_user_id?: string;
  actor_name?: string;
}

/**
 * Bound on the actor NAME lookup that runs before each of the four lifecycle
 * transitions (`resolveTransitionActor` in `proxy-agency-campaigns.routes.ts`).
 *
 * **Its own budget, and far shorter than
 * `ACTIVITY_OWNERSHIP_PROBE_TIMEOUT_MS` (`src/agency/agency-activity.ts`).**
 * That figure is for a read the request cannot proceed without; this is a
 * single-row read of `users ⋈ memberships` whose entire product is a cosmetic
 * label on an audit row. Everything the supervisor actually asked for is still
 * ahead of it, and a name that took longer than this has already stopped being
 * worth having.
 *
 * ── The gap it closes is LATENCY, not failure ──────────────────────────────
 * The lookup's rejection was already caught and degraded to an id-only actor,
 * with the route's own docstring arguing that the alternative would be "losing
 * the off button to a database blip". An UNBOUNDED await reintroduces exactly
 * that in the direction a try/catch cannot see: a pool starved of connections, a
 * lock queue, a replica that has stopped answering — none of them reject, they
 * just take longer than anyone pressing Stop on a live campaign will wait, and
 * `pg` has no statement timeout configured in this repo.
 *
 * ── Expiry behaves EXACTLY as a rejection does ─────────────────────────────
 * Same branch, same log line, same id-only actor: `actor_name` omitted, never a
 * placeholder (the handler reads `'system'`, `''` and `'unknown'` as real
 * actors), and never a refused transition. The one thing a timeout must not
 * become is a reason the campaign stays running.
 *
 * ── Why 2s ─────────────────────────────────────────────────────────────────
 * A single indexed lookup by primary key; the roster page issues the same
 * statement for a whole floor of agents. 2s is roughly two orders of magnitude
 * above its normal cost, so it fires only where the database is genuinely not
 * answering, and it is inside the pause a supervisor reads as the button working.
 * Deliberately NOT the probe's 10s: ten seconds of nothing happening after Stop
 * is pressed is the failure this bound exists to prevent, whatever it is spent on.
 */
export const TRANSITION_ACTOR_LOOKUP_TIMEOUT_MS = 2_000;

/**
 * The lifecycle provenance the handler adds to the campaign row it serves.
 *
 * ── Every member is OPTIONAL ───────────────────────────────────────────────
 * An absent key is tolerated rather than refused: the public layer applies no
 * response schema, so absence needs no code path at all.
 *
 * ── `null` is a fact here, in all three ────────────────────────────────────
 * `started_at: null` = never started (a draft campaign), `ended_at: null` =
 * still live, `last_transition_by: null` = nobody did it. Coercing any of them
 * to `0`, `''` or `{}` states something the data does not — the same rule
 * `abandonment_rate_24h_pct` already carries on the stats payload, where a
 * `null` rate rendered as a reassuring `0.0%` is the defect it exists to
 * prevent.
 */
export interface AgencyCampaignLifecycleFields {
  /** ISO-8601 instant of the first transition into `running`; `null` = never started. */
  started_at?: string | null;
  /**
   * ISO-8601 instant of entry into a terminal status (`stopped` / `completed`);
   * `null` = still live.
   *
   * ── `completed_at` still ships beside this, holding the same instant ───────
   * Deliberately (the column comments on `agency_campaigns` and the handler's
   * response formatter both say so): `completed_at` is on a payload the console
   * already reads, so it is retained as the legacy spelling. So a campaign row
   * legitimately carries BOTH. **The public layer must not hide, drop or
   * reconcile `completed_at` on this path** — they are one `CASE` in
   * `transitionStatus`, so this is not a place they can drift, and the
   * de-duplication is separate follow-up work.
   *
   * The names are not interchangeable even so, which is why both are worth
   * knowing about: `ended_at` covers `stopped` as well as `completed`, so it is
   * the field to read for "is this campaign over", and neither is derivable from
   * the other in general.
   */
  ended_at?: string | null;
  /** Who caused the current status; `null` where automatic. */
  last_transition_by?: AgencyCampaignTransitionActor | null;
}

/**
 * The retry lineage the handler stamps on a campaign row, plus the two config
 * columns the public layer itself reads back off one.
 *
 * ── Why the public layer declares these at all, when it forwards the row untouched
 * Two different reasons, and they are worth telling apart:
 *
 *  1. The four lineage fields are the CONSOLE's dependency.
 *     They arrive through the pass-through guarantee this module's header
 *     describes and the public layer neither reads nor rewrites them. They are
 *     declared for the header's second job — being the reader's contract of
 *     record — and so that a suite building a campaign fixture spells them the
 *     way the handler does.
 *  2. `record_calls` and `analysis_profile_id` are the PUBLIC LAYER's own
 *     dependency. `POST /campaigns/:id/retry` reads the PARENT campaign and
 *     asserts `agency.recording` / `agency.analytics` against the parent's
 *     values merged with the request's `config_overrides` — because a retry
 *     inherits the parent's config, so a capability that was on when the parent
 *     was authored can be off now and a straight copy would re-enable it. That
 *     check is only as good as these two keys arriving, which is exactly the
 *     kind of dependency this interface exists to write down.
 *
 * ── Every member OPTIONAL, as the lifecycle fields are ──────────────────────
 * The handler serves all of them on every campaign row (the formatter derives
 * the payload from the record). Declaring them required would encode a refusal
 * into any future "let's validate the response shape" refactor, for no gain.
 */
export interface AgencyCampaignRetryFields {
  /** The campaign this one was retried FROM; `null` = not a retry. */
  parent_campaign_id?: string | null;
  /** First campaign in the chain. Denormalised, so lineage is one read. */
  root_campaign_id?: string | null;
  /** `0` = not a retry. A retry of a retry is `2`, bounded by the handler at 10. */
  retry_generation?: number;
  /**
   * The selector that produced this campaign's roster, frozen AS SENT.
   *
   * `unknown` rather than a mirrored selector type: it is a RECORD of the
   * operator's intent, never re-executed, and its vocabulary is
   * `spine-filters.ts`'s — a second declaration of it here would be a parallel
   * vocabulary for the same filters.
   */
  retry_selector?: unknown | null;
  /**
   * Human↔human call recording. Gated by `agency.recording`, which is why the
   * public layer reads it back off the parent on the retry create.
   */
  record_calls?: boolean | null;
  /** Analysis profile. Gated by `agency.analytics`, same reason. */
  analysis_profile_id?: string | null;
}

/**
 * The campaign row as it crosses from the handler to the public route — the
 * fields the public layer or the console depend on, plus the lifecycle provenance
 * above.
 *
 * Not the whole row. See the module header for why a full mirror would be worse
 * than a partial one here: the public layer reads `account_id`, `name` and
 * `status` (the ownership probe and the lifecycle audit rows) and forwards the
 * rest untouched.
 */
export interface AgencyCampaignWire
  extends AgencyCampaignLifecycleFields, AgencyCampaignRetryFields {
  id: string;
  /**
   * The campaign's owning account. The activity trail scopes by this value, read
   * off the campaign, rather than by the request's `X-Account-Id` header.
   */
  account_id: string;
  name: string;
  status: string;
}

/**
 * The OPTIONAL addition to the handler's campaign-stats payload.
 *
 * Declared separately from the row above because it arrives on a different route
 * (`/stats`, the enriched one). **Tolerating its absence is the correct behaviour
 * rather than a degradation** — there is nothing for the public layer to fill in
 * and no default that would be true.
 *
 * ── NOT SERVED, and deliberately not declared: `agents_peak` ───────────────
 * A nullable peak-concurrency gauge was specified beside `attempts_retried` and
 * never implemented: nothing in `src/` serves it, and there is no column behind
 * it. It is recorded here as a sentence rather than as an optional field on
 * purpose — this interface is the reader's contract of record (see the module
 * header), so a declared `agents_peak?: number | null` reads as a field the
 * console may expect, and a chart sub-line built against it would never render.
 * If it is ever built, declare it then, with the `null`-means-NOT-MEASURED rule
 * `abandonment_rate_24h_pct` already carries.
 */
export interface AgencyCampaignStatsAdditions {
  /** Attempts that were a retry of an earlier one. A count, so `0` is a measurement. */
  attempts_retried?: number;
}

// ─── The stats SERIES read ──────────────────────────────────────────────────

/** The bucket units, and therefore the whole of `?bucket=`'s vocabulary. */
export const CAMPAIGN_SERIES_BUCKETS = ['day', 'week', 'month'] as const;

export type AgencyCampaignSeriesBucketUnit = (typeof CAMPAIGN_SERIES_BUCKETS)[number];

/**
 * What the handler's `GET /agency-campaigns/:id/stats/series` accepts, and
 * therefore all the public route forwards.
 *
 * A whitelist rather than `request.query` wholesale, for the reason
 * `agency-spine.ts` gives at length: an unrecognised param is REFUSED, because a
 * silently dropped one is a request that succeeded while doing something other
 * than what was asked — on a chart that means an axis nobody asked for rendered
 * as though it were the answer.
 *
 * **`campaign_id` is absent on purpose.** The subject of this read is the
 * campaign in the PATH, which the public route interpolates; a query param naming
 * another would be a scope decision taken from the query string. (The per-AGENT
 * series does accept `campaign_id`, because there the subject is the person.)
 */
export const CAMPAIGN_SERIES_QUERY_PARAMS = ['from', 'to', 'bucket'] as const;

/**
 * The widest window this read will aggregate, in days.
 *
 * ── Why the public layer carries the number at all ─────────────────────────
 * The handler is the authority and enforces its own cap (`campaign-series.ts`,
 * via `ROSTER_MAX_WINDOW_DAYS`); this is a **fast refusal** in front of it, at the
 * boundary where the console's request is validated — the same argument the
 * roster's `account_scope_required` check makes for itself. The public layer
 * never *widens* the window: a request this passes may still be refused by the
 * handler, and the handler's `details`-carrying 400 survives the error mask.
 *
 * ── Why 92 ────────────────────────────────────────────────────────────────
 * A quarter, and it is the handler's own figure for the whole-floor aggregates
 * (`ROSTER_MAX_WINDOW_DAYS` in `agent-record.ts`, shared by the roster and
 * grouped reads) rather than a number chosen here. Note the deliberate difference
 * from the per-agent record read, which caps at 366: that page is one agent's
 * year, while this one is a campaign's chart and every period the workspace
 * offers fits in a quarter. **This is the public layer's only copy of a window
 * cap.** One copy is a mirror; a second one would be the drift this constant is
 * meant to prevent, so a future public-layer window check reuses this export
 * rather than restating the number.
 */
export const CAMPAIGN_SERIES_MAX_WINDOW_DAYS = 92;

export const MS_PER_DAY = 86_400_000;

/** Accepted spellings of a window bound — the same two as `parseFilterDate`'s. */
const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * One window bound as an instant, or `null` if it is not one.
 *
 * ── The same rules as `parseFilterDate` (`spine-filters.ts`), rule for rule ──
 * Accepts a date-only form and a date-time WITH a zone, and nothing else. A
 * zone-less date-time is refused rather than read in the server's zone, which is
 * a fact about whichever container answered; a date-only bound is read as UTC
 * midnight (`${value}T00:00:00Z`), exactly as the handler reads it, so the
 * public route and the handler agree on which instant a chart's left edge is.
 *
 * The roll-forward check is the non-obvious half: `new Date` answers March 2nd
 * for `2026-02-30` rather than refusing, so a calendar-invalid bound would
 * silently move the window. Rendering the parse back and comparing is what
 * catches it.
 *
 * Refusing what the handler refuses — and no more — is the whole design
 * constraint here: the public route must never be the stricter of the two, or a
 * request the handler would have answered comes back 400 from the layer in
 * front of it.
 *
 * ── What this function matches, and what it does NOT ───────────────────────
 * The handler's `campaign-series.ts` imports the real `parseFilterDate` from
 * `spine-filters.ts`. This is a second function rather than an import of it:
 * the same two regexes, the same `${value}T00:00:00Z` reading of a date-only
 * bound, the same `getUTCFullYear() < 1` guard, and the same
 * `toISOString().slice(0, 10)` roll-forward comparison. The return convention
 * differs — `null` here, an `issues.push` there — because the public route
 * reports through Zod.
 *
 * **What is NOT here is the reading of the raw query value, and leaving it out
 * once made the public route the stricter one in two ways.** `parseFilterDate`
 * opens with `singleParam(raw)`, which picks `raw[0]` of a repeated param and
 * TRIMS; this function takes an already-resolved `string`. The two consequences —
 * `?from=2026-08-11%20` and `?bucket=day&bucket=week`, both 200 at the handler
 * and both 400 at the public route — are `singleParam`'s reading, so they belong
 * with the query read rather than with the date rules: see
 * {@link resolveSeriesQuery}, which matches that half and is what feeds this
 * function.
 */
export function parseSeriesInstant(value: string): Date | null {
  const dateOnly = ISO_DATE_ONLY.test(value);
  if (!dateOnly && !ISO_DATE_TIME.test(value)) return null;

  const parsed = new Date(dateOnly ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(parsed.getTime()) || parsed.getUTCFullYear() < 1) return null;
  if (dateOnly && parsed.toISOString().slice(0, 10) !== value) return null;
  return parsed;
}

/**
 * The three series params resolved to single values the way the HANDLER
 * resolves them.
 *
 * ── Why this exists NEXT TO `forwardAllowedQuery` rather than inside it ────
 * `forwardAllowedQuery` (`agency-spine.ts`) stays the strictness gate — an
 * unknown key is refused, and nothing here changes that — but the way it
 * resolves VALUES is written for the spine's MULTI-value filters: a repeat is
 * joined with a comma, which is right there because `multiParam` splits on
 * commas and `?outcome=a&outcome=b` is a legitimate two-value filter. None of
 * `from`, `to` and `bucket` is multi-valued: the handler reads all three through
 * `singleParam` (`src/agency/spine-filters.ts`), which takes `raw[0]` of a repeat
 * and trims. Left to the comma join and the untrimmed string, the public route
 * refused two requests the handler answers, which is the one thing this route's
 * validation may not do:
 *
 *  - `?from=2026-08-11%20` — the handler trims to a valid bound and answers 200;
 *    the public route measured the padded string against
 *    {@link parseSeriesInstant}'s regexes and answered 400.
 *    (`forwardAllowedQuery` trims only to TEST for blankness; the value it
 *    forwards keeps its padding.)
 *  - `?bucket=day&bucket=week` — the handler reads `day` and answers 200; the
 *    public route joined the pair into `day,week`, which fails its own enum.
 *
 * A repeated param is a caller mistake either way, and refusing it is arguably
 * the better manners — but the public route does not get to have better manners
 * than the handler behind it, because the console reads the answer from
 * whichever layer spoke, and a 400 here for a 200 there is a chart missing with
 * no cause a supervisor can act on.
 *
 * ── The resolved value is BOTH validated and forwarded ─────────────────────
 * The handler must re-read the exact string the public route measured its window
 * against, or the two could agree on the status and disagree about the window —
 * so the caller's raw spelling is deliberately NOT what is forwarded. `bucket`
 * stays absent when the caller omitted it, keeping `day` the handler's default
 * and only the handler's.
 *
 * Blank is ABSENT rather than empty, exactly as `singleParam` has it: `?from=` is
 * what a cleared control posts. On this route absence is then refused by the
 * schema, because both bounds are required — that refusal is the handler's too
 * (`parseCampaignSeriesQuery` pushes `is required` for either missing bound), so
 * it is not a divergence.
 */
export function resolveSeriesQuery(query: unknown): Record<string, string> {
  const source = (query ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of CAMPAIGN_SERIES_QUERY_PARAMS) {
    const raw = source[key];
    if (raw === undefined || raw === null) continue;
    // `raw[0]` then trim — `singleParam`, character for character.
    const value = String(Array.isArray(raw) ? raw[0] : raw).trim();
    if (value.length > 0) out[key] = value;
  }
  return out;
}

/**
 * One bucket of the series.
 *
 * ── `bucket_start` is a CALENDAR DAY: `YYYY-MM-DD`, no time, no offset ──────
 * Cut in the campaign's own `timezone` (echoed on the envelope), which is why it
 * cannot be an instant: "the 11th" in Asia/Kolkata is not an instant that means
 * the same thing to a reader in another zone. **Nothing on this path may
 * normalise it**, and the trap is specific rather than theoretical — a date-only
 * string is the one ISO form `new Date()` parses as UTC MIDNIGHT, so a
 * round-trip through `new Date(x).toISOString()` yields `2026-08-11T00:00:00Z`,
 * which renders as the 10th everywhere west of Greenwich. Every chart label
 * would be a day early, on a payload that still looked well-formed.
 *
 * The public layer does no such normalisation and has no serializer that could:
 * the only `onSend` hook is `errorMaskHook`, which returns any sub-400 payload by
 * reference. This comment is here so that stays true.
 *
 * ── No rates, and none may be added here ───────────────────────────────────
 * Deliberately no `connect_rate_pct` and no conversion figure. The client
 * derives them, because it is the client that must render `null` rather than `0`
 * where a denominator is zero — and a second definition of "connect rate" on
 * this path is a second definition that drifts from the one the dashboard shows.
 * The counts below are the whole payload.
 */
export interface AgencyCampaignSeriesBucket {
  /** `YYYY-MM-DD` in the campaign's timezone. See the interface docstring. */
  bucket_start: string;
  attempts: number;
  connected: number;
  successes: number;
  talk_seconds: number;
  wrapup_seconds: number;
}

/**
 * The series payload, forwarded unchanged.
 *
 * **Every bucket in `[from, to)` is present, zeros included** — that is the
 * handler's contract and the public layer must not filter a zero row out as
 * "empty". A chart with gaps where the quiet days were is a different claim from
 * a chart with troughs, and a zero row is the only thing that says "we were open
 * and nobody dialled". The list is ascending by `bucket_start`, gap-free, and
 * never empty: the parser refuses `from >= to`, so every accepted window holds at
 * least one bucket.
 *
 * ⚠️ **The FIRST and LAST buckets can be PARTIAL, and that is intentional on both
 * layers — do not "fix" it here.** The window bounds are instants while the
 * buckets are calendar days in the campaign's own zone, so `from=2026-08-11`
 * (which both layers read as `2026-08-11T00:00:00Z`) on an `Asia/Kolkata`
 * campaign starts the series at 05:30 local and that day's bucket holds 18.5
 * hours rather than 24. Reinterpreting a date-only bound as CAMPAIGN-LOCAL
 * midnight is the tempting alternative and is worse in two ways: one URL would
 * mean a different window per campaign, and it needs a second date-parsing rule
 * beside the one {@link parseSeriesInstant} matches. A caller who needs whole
 * local days sends zone-aware instants (`from=2026-08-10T18:30:00Z`). Recorded
 * here because the public route is where the console reads this contract from,
 * and because the natural "helpful" change on this side — normalising the bound
 * before forwarding it — is a divergence from the handler rather than a fix.
 */
export interface AgencyCampaignStatsSeries {
  campaign_id: string;
  bucket: AgencyCampaignSeriesBucketUnit;
  /** The IANA zone the buckets were cut in — the campaign's own `default_timezone`. */
  timezone: string;
  buckets: AgencyCampaignSeriesBucket[];
}

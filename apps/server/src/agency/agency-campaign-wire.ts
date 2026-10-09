/**
 * The campaign read surface's wire shapes, as MASTER reads them (`86d45k0bk`).
 *
 * A LEAF module: types, constants and pure functions. No fastify, no db — the
 * same shape and the same reason as {@link import('./agency-spine.js')}.
 *
 * ── What these types are FOR, stated plainly ───────────────────────────────
 * Master forwards every campaign body verbatim (`reply.send(result.body)`), so
 * nothing here is applied to a response at runtime and **that absence is the
 * pass-through guarantee, not a gap in it**. There is no Fastify `response`
 * schema anywhere on the agency proxy (so no ajv `removeAdditional`), no Zod
 * response parse, and no field whitelist: `enrichAgencyCampaignStats` is a
 * spread over core's object and says so in its own header at length. A field
 * core adds therefore arrives at cusui without this repo being edited, which is
 * exactly the property a well-meaning "let's declare the response shape"
 * refactor deletes.
 *
 * So these interfaces exist for two jobs, both of which are real:
 *
 *  1. **They type the fixtures.** The suites build core bodies against them, so
 *     a field named wrongly or typed wrongly reds `npm run lint` rather than
 *     passing as a `Record<string, unknown>` key nobody checks.
 *  2. **They are the reader's contract of record.** "Which campaign fields does
 *     the console depend on reaching it?" was previously answerable only by
 *     reading cusui.
 *
 * They are deliberately **not exhaustive mirrors** of core's `AgencyCampaign`
 * row or `AgencyCampaignStats`. An exhaustive hand-mirror of a 30-field row in a
 * repo that validates none of it is a field list that drifts silently — the
 * failure mode `agency-stats-enrichment.ts` refuses a field list for — and the
 * compiler here cannot see core anyway (separate repos, no shared package). What
 * is declared is what master, its suites or the console actually depend on.
 */

/**
 * Who caused a campaign's CURRENT status.
 *
 * ── The whole object is `null` where nobody did it ─────────────────────────
 * The abandonment auto-pause is the live case and the pacing leader's
 * finalization is the other. **`null` is therefore an answer ("the platform did
 * this"), never a missing value**, so it must not be back-filled with the
 * requesting user, an empty object or the string `'system'` anywhere on this hop.
 *
 * ⚠️ Core states the cost of that plainly and master must not paper over it:
 * `null` has TWO causes — genuinely automatic, or a caller that could have
 * attributed the transition and did not — and the payload cannot separate them.
 * Master's job is to make the second cause rare (see `resolveTransitionActor` in
 * `proxy-agency-campaigns.routes.ts`), not to invent a third state.
 *
 * ── The ID is the identity; the NAME is best-effort, hence `string | null` ──
 * Core's formatter (`src/api/responses/agency-campaign.response.ts`) folds two
 * independently-nullable columns — `last_transition_by_user_id VARCHAR(100)` and
 * `last_transition_by_name VARCHAR(255)` — as
 * `userId ? { user_id: userId, name: name ?? null } : null`. So:
 *
 *  - **no id ⇒ no actor at all.** An id is what a console resolves back to a
 *    person, so an actor nobody can resolve is served as an honest `null` rather
 *    than `{ user_id: '', name }`. Core notes that arm is unreachable through its
 *    API (the pair is written together) and reachable by a hand-run `UPDATE`;
 *  - **an id with no name is still an actor**, carrying `name: null`. A missing
 *    label does not un-attribute the transition, so it must not collapse the
 *    whole object.
 *
 * `name: string` was this type's first spelling and it was WRONG in the direction
 * that matters: nothing enforces it at runtime today (master applies no response
 * schema, which is the whole finding of this module's header), but this type is
 * the reader's contract of record and it is what a future "let's validate the
 * response shape" refactor would encode — at which point master would reject a
 * payload core legitimately serves.
 */
export interface AgencyCampaignTransitionActor {
  /** Master's user id for the human who pressed the control. The identity. */
  user_id: string;
  /**
   * Their display name as master knew it AT THE TRANSITION. Core has no user
   * table (D3), so it stores the string it was handed and never re-resolves it —
   * which is deliberate: an audit field must say who it was then, not who that id
   * belongs to now. `null` = master had an id but no readable name.
   */
  name: string | null;
}

/**
 * The OPTIONAL body master sends on the four lifecycle transitions.
 *
 * Master's mirror of core's `AgencyCampaignTransitionRequest`. Both members are
 * optional on the wire and the omissions mean different things, so neither may be
 * spelled as a placeholder — core reads `'system'`, `''` and `'unknown'` as real
 * values, and `''` specifically is what makes `readTransitionActor` return `null`,
 * i.e. a name-shaped lie followed by a silent un-attribution.
 *
 * ── Core owns both ceilings, and the asymmetry between them ────────────────
 * `actor_user_id` over 100 chars is DROPPED (the actor becomes `null`): a
 * truncated id is not a shortened answer, it is a different or nonexistent user,
 * and attributing a transition to the wrong human is the one failure the
 * `null`-means-unknown contract exists to prevent. `actor_name` over 255 is
 * TRUNCATED: it exists to be read, so losing its tail beats losing the
 * attribution.
 *
 * **Master deliberately implements neither rule.** Not laziness — a copy of a
 * column width in a repo that cannot see that column change is the drift this
 * module's header argues against, and master's user ids are UUIDs (36 chars,
 * comfortably inside 100) so the drop arm is unreachable from here anyway.
 * `users.display_name` is `TEXT` and therefore genuinely unbounded, so the
 * truncation arm IS reachable — and core's rule is to keep the name, which is
 * exactly what master forwarding it unmodified produces. What master must never
 * do is DROP a long name, which would turn core's cosmetic loss into a lost
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
 * **Its own budget, on the same argument as
 * `ACTIVITY_OWNERSHIP_PROBE_TIMEOUT_MS` (`src/agency/agency-activity.ts`) and
 * with the opposite conclusion about the number.** That probe is a core call the
 * request cannot proceed without; this is a single-row read of master's own
 * `users ⋈ memberships` whose entire product is a cosmetic label on an audit
 * row. So it is bounded far shorter: everything the supervisor actually asked for
 * is still ahead of it, and a name that took longer than this has already stopped
 * being worth having.
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
 * placeholder (core reads `'system'`, `''` and `'unknown'` as real actors), and
 * never a refused transition. The one thing a timeout must not become is a
 * reason the campaign stays running.
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
 * The lifecycle provenance core adds to the campaign row it serves.
 *
 * ── Every member is OPTIONAL, and that is a deploy-order requirement ────────
 * Deploy order across this platform is core → master → cusui, and master must
 * also survive a ROLLBACK of core: an older core simply does not serve these
 * keys. Typed optional, an absent field is the tolerated normal case rather
 * than something a schema would have to refuse; and because master applies no
 * response schema, absence needs no code path at all.
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
   * Deliberately, at core's end (migration 108's header, and core's response
   * formatter says so again): `completed_at` is on a payload master and the
   * console already read, and removing a shipped field is a three-repo sequencing
   * exercise rather than a migration. So a campaign row legitimately carries
   * BOTH. **Master must not hide, drop or reconcile `completed_at` on this hop** —
   * they are one `CASE` in core's `transitionStatus`, so this is not a place they
   * can drift, and the de-duplication is a follow-up ticket rather than this one.
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
 * The retry lineage core stamps on a campaign row, plus the two config columns
 * master itself now reads back off one.
 *
 * ── Why master declares these at all, when it forwards the row untouched ────
 * Two different reasons, and they are worth telling apart because only the
 * second is new:
 *
 *  1. The four lineage fields are the CONSOLE's dependency (wire contract §3).
 *     They arrive through the pass-through guarantee this module's header
 *     describes and master neither reads nor rewrites them. They are declared
 *     for the header's second job — being the reader's contract of record — and
 *     so that a suite building a campaign fixture spells them the way core does.
 *  2. `record_calls` and `analysis_profile_id` are MASTER's dependency, and that
 *     is genuinely new. `POST /campaigns/:id/retry` reads the PARENT campaign
 *     and asserts `agency.recording` / `agency.analytics` against the parent's
 *     values merged with the request's `config_overrides` — because a retry
 *     inherits config (DR-10), so a capability that was on when the parent was
 *     authored can be off now and a straight copy would re-enable it. That check
 *     is only as good as these two keys arriving, which is exactly the kind of
 *     dependency this interface exists to write down.
 *
 * ── Every member OPTIONAL, for the reason the lifecycle fields are ──────────
 * Deploy order is core → master → cusui and master must survive a core rollback,
 * so an older core simply does not serve these keys. On the capability check
 * that absence is safe rather than fail-open, and the argument is an ordering
 * one: a core old enough not to report `record_calls` also does not serve
 * `POST /:id/retry`, so the create 404s at the next hop and no capability can be
 * re-enabled by the gap. Declaring them required would additionally encode a
 * refusal into any future "let's validate the response shape" refactor, for a
 * payload core legitimately serves.
 */
export interface AgencyCampaignRetryFields {
  /** The campaign this one was retried FROM; `null` = not a retry. */
  parent_campaign_id?: string | null;
  /** First campaign in the chain. Denormalised (DR-6), so lineage is one read. */
  root_campaign_id?: string | null;
  /** `0` = not a retry. A retry of a retry is `2`, bounded by core at 10. */
  retry_generation?: number;
  /**
   * The selector that produced this campaign's roster, frozen AS SENT (DR-5).
   *
   * `unknown` rather than a mirrored selector type: it is a RECORD of the
   * operator's intent, never re-executed, and its vocabulary is core's
   * (`spine-filters.ts`) — a second declaration of it here is the parallel
   * vocabulary DR-3 exists to refuse.
   */
  retry_selector?: unknown | null;
  /**
   * Human↔human call recording. Gated by `agency.recording`, which is why
   * master reads it back off the parent on the retry create.
   */
  record_calls?: boolean | null;
  /** Analysis profile. Gated by `agency.analytics`, same reason. */
  analysis_profile_id?: string | null;
}

/**
 * The campaign row as it crosses this hop — the fields master or the console
 * depend on, plus the lifecycle provenance above.
 *
 * Not the whole row. See the module header for why a full mirror would be worse
 * than a partial one here: master reads `account_id`, `name` and `status` (the
 * ownership probe and the lifecycle audit rows) and forwards the rest untouched.
 */
export interface AgencyCampaignWire
  extends AgencyCampaignLifecycleFields, AgencyCampaignRetryFields {
  id: string;
  /**
   * Core types this `VARCHAR(100)` with a literal `'default'` fallback, so it can
   * legitimately differ from the request's `X-Account-Id` — which is why the
   * activity trail reads it off the campaign rather than off the header.
   */
  account_id: string;
  name: string;
  status: string;
}

/**
 * The OPTIONAL addition to core's campaign-stats payload.
 *
 * Declared separately from the row above because it arrives on a different route
 * (`/stats`, the enriched one) and may not arrive at all: an older core does not
 * serve it, and **master tolerating that absence is the correct behaviour rather
 * than a degradation** — there is nothing for master to fill in and no default
 * that would be true.
 *
 * ── NOT SERVED, and deliberately not declared: `agents_peak` ───────────────
 * A nullable peak-concurrency gauge was specified beside `attempts_retried`
 * (`86d45k0bk`, item 4) and dropped before core implemented it: `grep -rn
 * agents_peak` over core's `src/` and `test/` at v1.92.0 returns nothing, and
 * there is no column behind it. It is recorded here as a sentence rather than as
 * an optional field on purpose — this interface is the reader's contract of
 * record (see the module header), so a declared `agents_peak?: number | null`
 * reads as a field the console may expect, and a chart sub-line built against it
 * would never render. If core ever ships it, declare it then, with the
 * `null`-means-NOT-MEASURED rule `abandonment_rate_24h_pct` already carries.
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
 * What core's `GET /agency-campaigns/:id/stats/series` accepts, and therefore
 * all master forwards.
 *
 * A whitelist rather than `request.query` wholesale, for the reason
 * `agency-spine.ts` gives at length: an unrecognised param is REFUSED, because a
 * silently dropped one is a request that succeeded while doing something other
 * than what was asked — on a chart that means an axis nobody asked for rendered
 * as though it were the answer.
 *
 * **`campaign_id` is absent on purpose.** The subject of this read is the
 * campaign in the PATH, which master interpolates; a query param naming another
 * would be a scope decision taken from the query string. (Core's per-AGENT
 * series does accept `campaign_id`, because there the subject is the person.)
 */
export const CAMPAIGN_SERIES_QUERY_PARAMS = ['from', 'to', 'bucket'] as const;

/**
 * The widest window this read will aggregate, in days.
 *
 * ── Why master carries the number at all ───────────────────────────────────
 * Core is the authority and enforces its own cap; this is a **fast refusal**, in
 * front of a per-tenant AES key decryption and an S2S round trip that cannot
 * succeed — the same argument the roster's `account_scope_required` check makes
 * for itself, and the same one `orderedPeriod` makes on the activity trail
 * (where core's own refusal reaches the supervisor dressed as a dependency
 * outage). Master never *widens* the window: a request this passes may still be
 * refused by core, and core's `details`-carrying 400 survives the error mask.
 *
 * ── Why 92 ────────────────────────────────────────────────────────────────
 * A quarter, and it is core's own figure for the whole-floor aggregates
 * (`ROSTER_MAX_WINDOW_DAYS`, shared by the roster and grouped reads) rather than
 * a number chosen here. Note the deliberate difference from core's per-agent
 * record read, which caps at 366: that page is one agent's year, while this one
 * is a campaign's chart and every period the workspace offers fits in a quarter.
 * **This is master's FIRST copy of a core window cap** — there was none in this
 * repo before, which is why `error-mask.middleware.ts` documents the 92-day
 * refusal as a body master merely forwards. One copy is a mirror; a second one
 * would be the drift this constant is meant to prevent, so a future
 * master-side window check reuses this export rather than restating the number.
 */
export const CAMPAIGN_SERIES_MAX_WINDOW_DAYS = 92;

export const MS_PER_DAY = 86_400_000;

/** Accepted spellings of a window bound, mirrored from core's `parseFilterDate`. */
const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * One window bound as an instant, or `null` if it is not one.
 *
 * ── Mirrored from core's `parseFilterDate`, rule for rule ──────────────────
 * Accepts a date-only form and a date-time WITH a zone, and nothing else. A
 * zone-less date-time is refused rather than read in the server's zone, which is
 * a fact about whichever container answered; a date-only bound is read as UTC
 * midnight, exactly as core reads it (`${value}T00:00:00Z`), so the two hops
 * agree on which instant a chart's left edge is.
 *
 * The roll-forward check is the non-obvious half and it is core's too: `new Date`
 * answers March 2nd for `2026-02-30` rather than refusing, so a calendar-invalid
 * bound would silently move the window. Rendering the parse back and comparing is
 * what catches it.
 *
 * Refusing what core refuses — and no more — is the whole design constraint here:
 * master must never be the stricter of the two, or a request core would have
 * answered comes back 400 from the hop in front of it.
 *
 * ── What this function mirrors, and what it does NOT ───────────────────────
 * Core's `src/agency/campaign-series.ts` imports the real `parseFilterDate` from
 * `spine-filters.ts` rather than forking it, so the rules are one function at
 * core's end and this is the only copy. What is mirrored, checked against that
 * function: the same two regexes, the same `${value}T00:00:00Z` reading of a
 * date-only bound, the same `getUTCFullYear() < 1` guard, and the same
 * `toISOString().slice(0, 10)` roll-forward comparison. The return convention
 * differs — `null` here, an `issues.push` there — because master reports through
 * Zod.
 *
 * **What is NOT here is the reading of the raw query value, and leaving it out
 * once made master the stricter hop in two ways.** `parseFilterDate` opens with
 * `singleParam(raw)`, which picks `raw[0]` of a repeated param and TRIMS; this
 * function takes an already-resolved `string`. The two consequences —
 * `?from=2026-08-11%20` and `?bucket=day&bucket=week`, both 200 at core and both
 * 400 at master — are core's `singleParam` reading, so they belong with the query
 * read rather than with the date rules: see {@link resolveSeriesQuery}, which is
 * the mirror of that half and is what feeds this function.
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
 * The three series params resolved to single values the way CORE resolves them.
 *
 * ── Why this exists NEXT TO `forwardAllowedQuery` rather than inside it ────
 * `forwardAllowedQuery` (`agency-spine.ts`) stays the strictness gate — an
 * unknown key is refused, and nothing here changes that — but the way it
 * resolves VALUES is written for the spine's MULTI-value filters: a repeat is
 * joined with a comma, which is right there because core's `multiParam` splits on
 * commas and `?outcome=a&outcome=b` is a legitimate two-value filter. None of
 * `from`, `to` and `bucket` is multi-valued: core reads all three through
 * `singleParam` (`src/agency/spine-filters.ts`), which takes `raw[0]` of a repeat
 * and trims. Left to the comma join and the untrimmed string, master refused two
 * requests core answers, which is the one thing this route's validation may not
 * do:
 *
 *  - `?from=2026-08-11%20` — core trims to a valid bound and answers 200; master
 *    measured the padded string against {@link parseSeriesInstant}'s regexes and
 *    answered 400. (`forwardAllowedQuery` trims only to TEST for blankness; the
 *    value it forwards keeps its padding.)
 *  - `?bucket=day&bucket=week` — core reads `day` and answers 200; master joined
 *    the pair into `day,week`, which fails its own enum.
 *
 * A repeated param is a caller mistake either way, and refusing it is arguably
 * the better manners — but master does not get to have better manners than the
 * service it fronts, because the console reads the answer from whichever hop
 * spoke, and a 400 here for a 200 there is a chart missing with no cause a
 * supervisor can act on.
 *
 * ── The resolved value is BOTH validated and forwarded ─────────────────────
 * Core must re-read the exact string master measured its window against, or the
 * two hops could agree on the status and disagree about the window — so the
 * caller's raw spelling is deliberately NOT what goes on the wire. `bucket`
 * stays absent when the caller omitted it, keeping `day` core's default and only
 * core's.
 *
 * Blank is ABSENT rather than empty, exactly as `singleParam` has it: `?from=` is
 * what a cleared control posts. On this route absence is then refused by the
 * schema, because both bounds are required — that refusal is core's too
 * (`parseCampaignSeriesQuery` pushes `is required` for either missing bound), so
 * it is not a divergence.
 */
export function resolveSeriesQuery(query: unknown): Record<string, string> {
  const source = (query ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of CAMPAIGN_SERIES_QUERY_PARAMS) {
    const raw = source[key];
    if (raw === undefined || raw === null) continue;
    // `raw[0]` then trim — core's `singleParam`, character for character.
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
 * the same thing to a reader in another zone. **Nothing on this hop may
 * normalise it**, and the trap is specific rather than theoretical — a date-only
 * string is the one ISO form `new Date()` parses as UTC MIDNIGHT, so a
 * round-trip through `new Date(x).toISOString()` yields `2026-08-11T00:00:00Z`,
 * which renders as the 10th everywhere west of Greenwich. Every chart label
 * would be a day early, on a payload that still looked well-formed.
 *
 * Master does no such normalisation and has no serializer that could: the only
 * `onSend` hook is `errorMaskHook`, which returns any sub-400 payload by
 * reference. This comment is here so that stays true.
 *
 * ── No rates, and none may be added here ───────────────────────────────────
 * Deliberately no `connect_rate_pct` and no conversion figure. The client
 * derives them, because it is the client that must render `null` rather than `0`
 * where a denominator is zero — and a second definition of "connect rate" in
 * this hop is a second definition that drifts from the one the dashboard shows.
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
 * The series payload, forwarded verbatim.
 *
 * **Every bucket in `[from, to)` is present, zeros included** — that is core's
 * contract and master must not filter a zero row out as "empty". A chart with
 * gaps where the quiet days were is a different claim from a chart with troughs,
 * and a zero row is the only thing that says "we were open and nobody dialled".
 * The list is ascending by `bucket_start`, gap-free, and never empty: the parser
 * refuses `from >= to`, so every accepted window holds at least one bucket.
 *
 * ⚠️ **The FIRST and LAST buckets can be PARTIAL, and that is intentional on both
 * hops — do not "fix" it here.** The window bounds are instants while the buckets
 * are calendar days in the campaign's own zone, so `from=2026-08-11` (which both
 * services read as `2026-08-11T00:00:00Z`) on an `Asia/Kolkata` campaign starts
 * the series at 05:30 local and that day's bucket holds 18.5 hours rather than 24.
 * Reinterpreting a date-only bound as CAMPAIGN-LOCAL midnight is the tempting
 * alternative and is worse in two ways: one URL would mean a different window per
 * campaign, and it needs a second date-parsing rule beside the one
 * {@link parseSeriesInstant} mirrors. A caller who needs whole local days sends
 * zone-aware instants (`from=2026-08-10T18:30:00Z`). Recorded here because master
 * is the hop the console reads this contract from, and because the natural
 * "helpful" change on this side — normalising the bound before forwarding it — is
 * a divergence from core rather than a fix.
 */
export interface AgencyCampaignStatsSeries {
  campaign_id: string;
  bucket: AgencyCampaignSeriesBucketUnit;
  /** The IANA zone the buckets were cut in — the campaign's own `default_timezone`. */
  timezone: string;
  buckets: AgencyCampaignSeriesBucket[];
}

/**
 * Campaign stats (`GET /api/v1/agency-campaigns/:id/stats`), including the rolling
 * abandonment rate, the supervisor floor and the stall vocabulary.
 *
 * Part of the dialer contract; `../agency.ts` is the barrel and carries the
 * contract's header (freeze rules, vocabulary).
 */

import type { AgencyAgentState, AgencyCampaignStatus } from './enums';

// ─── Campaign stats (including the rolling abandonment rate) ────────────────

/**
 * `GET /api/v1/agency-campaigns/:id/stats`.
 *
 * Frozen now because Phase 2 adds the abandonment numbers to it and the public API layer's
 * supervisor payload reads them. Counts are point-in-time; the rate is not.
 *
 * `contacts_pending` and `retries_pending` are genuinely different questions and
 * both are shown — `next_attempt_at` can be hours out, so "list exhausted"
 * and "campaign complete" are not the same thing.
 */
/**
 * The states an agent session can hold — an ALIAS, not a second union.
 *
 * It was briefly re-declared here with the same six members, which is the drift it
 * claimed to prevent: `agencyAgentSessionRepository.setState` is typed against
 * {@link AgencyAgentState}, so the payload and the writer would have depended on two
 * unions nothing kept in sync. An alias cannot diverge from its source.
 *
 * The name is kept because "live state" is what the supervisor payload means by it —
 * the state of a session that has not left — and reads better at the use sites.
 */
export type AgencyAgentLiveState = AgencyAgentState;

/** Live agents on a campaign, counted by state. Every state present, zeros included. */
export type AgencyAgentsByState = Record<AgencyAgentLiveState, number>;

/**
 * One agent on the supervisor's floor.
 *
 * The floor is sorted by RISK, not alphabetically, and the risk rules need
 * `state_since` rather than a pre-computed duration: the tile ticks live, so a
 * server-rendered "8m 41s" is wrong the moment it arrives.
 */
export interface AgencySupervisorAgent {
  /**
   * The agent's SESSION id — what every supervisor control is addressed to.
   *
   * `POST /agency/sessions/:id/force-available` takes this, not `agent_user_id`,
   * and the console's agent drawer offers exactly that control for the stuck-in-wrap-up case. Without it the floor renders and none of its controls can be
   * wired: the query already `GROUP BY s.id`, so the id was one projection away
   * from being on the wire and the omission would only have surfaced in the console.
   *
   * Distinct from `agent_user_id`, and the difference matters — a session is one
   * shift on one campaign, while the user id is the person. Controls act on the
   * session; identity resolution acts on the user.
   */
  session_id: string;
  /**
   * The public API layer's user id for the person. **The dialer runtime never resolves it to a name** —
   * there is no user table here. Rendering an agent's display name needs the public API layer to
   * enrich this on the proxy hop; it is the only service that knows identity.
   */
  agent_user_id: string;
  state: AgencyAgentLiveState;
  /** ISO instant of the last state transition. The console derives time-in-state. */
  state_since: string;
  /**
   * Whether this agent's station socket is currently held — the console's risk rank 4,
   * "disconnected / heartbeat lost".
   *
   *   * `true`  — the ownership key `agency:station:{session_id}` is present, so a
   *     station ping landed within `OWNERSHIP_TTL_MS` (30s).
   *   * `false` — no key. The agent's browser is gone; the tile is stale and the
   *     supervisor should be told.
   *   * `null`  — **could not determine**, i.e. the Redis read failed. Deliberately
   *     NOT a synonym for `false`: a degraded dependency must never manufacture
   *     "this agent is disconnected" on a floor a supervisor is about to act on.
   *     Same rule, and the same shape, as `concurrency_in_use`.
   *
   * ── Why this is a boolean and NOT a `last_heartbeat` timestamp ──────────────────
   *
   * Because there is no such timestamp to give. The obvious source,
   * `agency_agent_sessions.last_heartbeat`, is **never renewed** — the only writer,
   * `AgencyAgentSessionRepository.heartbeat()`, has no callers; the station ping
   * renews the Redis key and never touches the row. Liveness does NOT come from this table — the authority is
   * the Redis ownership key — and `reaper.ts` already declines to use the column for exactly
   * this reason.
   *
   * So serving it would have shipped well-formed ISO data meaning "when this shift
   * began", under a name promising liveness — marking every agent disconnected
   * minutes after they join, most confidently the ones working longest. That is the
   * missing-producer defect wearing a disguise: not an absent field, but a plausible
   * one. Redis holds a TTL, not an instant, so a boolean is the whole truth
   * available and the contract says only what the dialer runtime can produce.
   *
   * **Composed by the ROUTE, not the repository** — see
   * {@link AGENCY_AGENT_ROUTE_FIELDS}. It is a Redis read, and `stats()` is SQL.
   */
  connected: boolean | null;
  /** Present only while `state === 'break'`. */
  break_reason: string | null;
  /** Attempts this agent has handled on this campaign this session. */
  calls_handled: number;
}

/**
 * The agent fields the ROUTE composes, not the repository.
 *
 * The same split `AGENCY_STATS_ROUTE_FIELDS` states one level up, and stated the
 * same way — as a runtime value rather than a comment, so
 * {@link AgencySupervisorAgentRow} is derived from it and a field moving between
 * producers is a compile error rather than a doc comment that quietly went stale.
 *
 * `connected` is here because liveness lives in Redis (`StationRegistry`) while the
 * floor is a SQL roster. Merging them in the repository would put a Redis
 * dependency behind `stats()`, where every other field is a query.
 */
export const AGENCY_AGENT_ROUTE_FIELDS =
  ['connected'] as const satisfies readonly (keyof AgencySupervisorAgent)[];

/**
 * One floor row **as the database can answer it** — everything except the fields
 * the route adds.
 *
 * Derived rather than hand-written: the repository returning this and the route
 * annotating the full {@link AgencySupervisorAgent} means a field with no producer
 * cannot compile, which is the no-producerless-field guarantee applied to the nested row.
 */
export type AgencySupervisorAgentRow =
  Omit<AgencySupervisorAgent, (typeof AGENCY_AGENT_ROUTE_FIELDS)[number]>;

/**
 * ─── THE HEALTH STRIP'S DIAGNOSES ────────────────────────────────────
 *
 * The health strip ranks eight conditions and shows the first that matches. The
 * ranking is by **what a supervisor should do about it**, not by severity: a
 * compliance stop outranks a staffing problem, which outranks a capacity one,
 * because acting on the wrong one wastes the minutes the strip exists to save.
 *
 * The order is load-bearing and is asserted, not just written here — see
 * `AGENCY_STALL_PRIORITY`.
 */
export type AgencyStallCode =
  /** 1. Auto-paused by the abandonment guardrail. */
  | 'auto_paused_abandonment'
  /** 2. The DNC check is unavailable, so dialing fails CLOSED (DNC is tenant-wide). */
  | 'dnc_unavailable'
  /** 3. Nobody is available to take a call. */
  | 'no_agents_available'
  /** 4. At the account concurrency ceiling (set by super-admins only). */
  | 'concurrency_saturated'
  /** 5. Everything left is outside its calling window. */
  | 'outside_calling_hours'
  /** 6. Nothing dialable now, but retries are scheduled. */
  | 'list_exhausted_retries_pending'
  // Priority 7 (`credits_low`) is intentionally absent: v1 has no credits, and a
  // code that is declared but never produced is a trap for exhaustive consumers.
  // The remaining codes keep their relative order and the ordinals in these
  // comments.
  /** 8. An unusual share of recent dials failed — possibly a carrier problem. */
  | 'elevated_failure_rate';

/**
 * Priority order, first match wins. Exported because the console renders
 * "2 more issues" from `other_stalls` and must sort it the same way, and because
 * a reordering should break a test rather than silently change which single
 * diagnosis a supervisor sees.
 */
export const AGENCY_STALL_PRIORITY: readonly AgencyStallCode[] = [
  'auto_paused_abandonment',
  'dnc_unavailable',
  'no_agents_available',
  'concurrency_saturated',
  'outside_calling_hours',
  'list_exhausted_retries_pending',
  'elevated_failure_rate',
] as const;

/**
 * **{@link AGENCY_STALL_PRIORITY} is the single list** of stall codes: one
 * application produces every code itself, so there is no separate "producible
 * subset". A test that checks the assembler emits only known codes should assert
 * against it. `credits_low` is absent (no billing in v1); it would return with
 * metering, if at all, as an additive member with a real producer.
 */

/**
 * A diagnosis together with the evidence for it.
 *
 * A discriminated union rather than `{ code, detail: Record<string, unknown> }`
 * because each message must to name its own numbers ("abandonment 3.4%
 * is over your 3% limit", "6 agents on shift, 0 available"), and an untyped bag
 * would let the console read a field the producer never set — rendering "NaN% is
 * over your undefined% limit" at exactly the moment a supervisor needs the truth.
 *
 * No arm carries a pre-formatted sentence. Copy is the console's, and a
 * server-rendered string cannot be localised, pluralised, or shortened for the
 * <1024px layout.
 */
export type AgencyStall =
  | {
      code: 'auto_paused_abandonment';
      /** The rate AS MEASURED when the guardrail fired — frozen. */
      measured_pct: number;
      ceiling_pct: number;
      paused_at: string;
    }
  | {
      code: 'dnc_unavailable';
      /**
       * Per-tenant, not per-campaign: the DNC set is tenant-flat, so
       * every campaign in the tenant is stopped by the same fault.
       */
      tenant_wide: true;
    }
  | {
      code: 'no_agents_available';
      agents_on_shift: number;
      /** Break codes to counts, so the console can render "5 on break (Lunch)". */
      on_break_by_reason: Record<string, number>;
      on_call: number;
      /** ISO-8601, or null when this campaign has never dialed. */
      last_dial_at: string | null;
    }
  | {
      code: 'concurrency_saturated';
      limit: number;
      in_use: number;
    }
  | {
      code: 'outside_calling_hours';
      contacts_waiting: number;
      /** ISO-8601 of the next window opening, or null if none resolves. */
      next_window_opens_at: string | null;
    }
  | {
      code: 'list_exhausted_retries_pending';
      retries_pending: number;
      next_retry_at: string | null;
    }
  // There is no `credits_low` arm: the code itself is absent — see
  // `AgencyStallCode`.
  | {
      code: 'elevated_failure_rate';
      failed_pct: number;
      attempts: number;
      window_minutes: number;
    };

export interface AgencyCampaignStats {
  campaign_id: string;
  status: AgencyCampaignStatus;
  contacts_total: number;
  contacts_pending: number;
  contacts_in_flight: number;
  contacts_completed: number;
  contacts_suppressed: number;
  /**
   * Contacts retired by running out of retry budget.
   *
   * A separate bucket rather than folded into `contacts_completed`, because
   * exhaustion is its own STATE precisely so a supervisor can tell "we worked
   * this list to its cap" from "this outcome was never retryable". Without it
   * `contacts_total` does not equal the sum of the buckets and the missing
   * contacts are invisible — the one direction nobody checks, since the number
   * looks plausible either way.
   */
  contacts_exhausted: number;
  /** Pending contacts whose `next_attempt_at` is still in the future. */
  retries_pending: number;
  attempts_live: number;
  attempts_total: number;
  attempts_connected: number;
  /**
   * Attempts that were a REDIAL of a contact and were actually DIALLED —
   * `attempt_number > 1 AND dialed_at IS NOT NULL`.
   *
   * The `dialed_at` gate is what makes "dials PLACED" true rather than
   * aspirational: attempts are created in `state = 'queued'` with `dialed_at`
   * NULL, so un-placed retry rows exist by construction, and a campaign paused
   * with 50 reserved-but-undialled second attempts would otherwise report
   * `attempts_retried: 50` having redialled nobody. Same gate, for the same
   * reason, as the `attempts` counter on {@link AgencyCampaignStatsSeries}.
   *
   * ⚠️ **This is a different question from {@link retries_pending}, and the two
   * are the most likely pair on this payload to be read as one.**
   * `retries_pending` counts contacts whose `next_attempt_at` is still in the
   * future — work QUEUED. This counts dials already PLACED that were not the
   * contact's first. A campaign can have `retries_pending: 0` and
   * `attempts_retried: 4_000`: it worked its whole retry budget and has nothing
   * left scheduled. Reporting only the queued number makes a campaign that spent
   * most of its dials on redials look like one that reached everybody first time.
   *
   * `attempt_number` is derived at insert from `MAX(attempt_number)` over the
   * contact's attempts, NOT from `agency_contacts.attempt_count` —
   * so an our-fault redial (a dropped station socket, a reaper requeue) is counted
   * here even though it never spent the customer's retry allowance. That is the
   * honest reading of "dials that were not the first": the number was called
   * again, whoever's fault it was.
   *
   * **Optional on the wire**, and it is the only counter here that is. The dialer runtime always
   * produces it; the `?` is for the public API layer and the console, which may be talking to a
   * the dialer runtime that predates it. Absent means "this dialer runtime does not report it", never zero.
   */
  attempts_retried?: number;
  agents_live: number;
  /**
   * **P2.** Attempts that answered with no agent to bridge to, over a rolling 24
   * hours — **not** over the campaign, and not over a session.
   *
   * 24h is the window regulators measure abandonment over, so a campaign-lifetime
   * figure is the wrong number even when it is easier to compute: a campaign that
   * abandoned badly this morning and has been clean since would keep showing a bad
   * rate, and one that has been running an hour would show a rate built from
   * almost no calls. The window is anchored on wall-clock, so it spans restarts and
   * spans campaigns.
   */
  abandoned_24h: number;
  /** Answered attempts over the same rolling 24h window — the rate's denominator. */
  answered_24h: number;
  /**
   * `abandoned_24h / answered_24h`, as a percentage, or `null` when the denominator
   * is zero. **Null, never 0** — "no calls answered yet" and "no calls abandoned"
   * are different facts, and rendering the first as a reassuring 0.0% is how a
   * guardrail gets trusted before it has measured anything.
   */
  abandonment_rate_24h_pct: number | null;

  // ── the supervisor dashboard ──────────────────────────────────

  /** Live agents by state. Replaces nothing — `agents_live` stays as the total. */
  agents_by_state: AgencyAgentsByState;
  /** The floor, unsorted. Risk ordering is the console's. */
  agents: AgencySupervisorAgent[];

  /**
   * Connects split by whether a HUMAN answered, derived from dispositions.
   *
   * Not cosmetic: answering-machine detection is out of scope, so agents
   * hear answering machines and disposition them by hand. Without the split, every
   * voicemail an agent sat through is counted as a connect and its duration inflates
   * AHT — the dashboard would report agents handling more calls, more slowly, and
   * both numbers would be wrong in the direction that looks like a coaching problem.
   */
  human_connects: number;
  machine_connects: number;
  /**
   * Bridged calls nobody classified — no disposition, or the reaper's
   * `no_disposition` auto-stamp on a lapsed wrap-up.
   *
   * A third bucket, because a two-way split forces the unknowns somewhere and
   * `disposition_code IS DISTINCT FROM 'voicemail'` is true of NULL — so they all
   * landed in `human_connects` at full duration. That population skews toward
   * exactly the voicemails an agent walked away from rather than label, which is
   * the case the split exists to separate.
   *
   * The three sum to every bridged attempt. Deliberately not folded into either
   * neighbour: "we don't know what this call was" is a different fact from both,
   * and it is also the honest denominator caveat for `connect_rate_pct`.
   */
  unclassified_connects: number;
  /**
   * Whether this campaign's disposition catalog actually contains `voicemail`.
   *
   * **`false` means `machine_connects` is not measuring anything**, and the console
   * must say so rather than render a confident `0`. The public API layer injects a default catalog
   * containing the code when the field is absent (`DEFAULT_DISPOSITION_CATALOG`), but
   * a campaign created before that shipped — or created directly against the dialer runtime,
   * bypassing the public API layer — can still have `[]`, and an agent cannot submit a code the
   * catalog does not offer. Same lesson as `abandonment_rate_24h_pct`: "no evidence"
   * and "zero" are different facts, and only one of them is reassuring.
   */
  machine_connects_available: boolean;
  /** Human connects over attempts, as a percentage. `null` before any attempt. */
  connect_rate_pct: number | null;

  /**
   * Bridged attempts whose disposition maps to a catalog entry flagged
   * `is_success` — the campaign's conversions.
   *
   * **This is the first thing that has ever counted `is_success`.** The flag has
   * been on {@link AgencyDisposition}, is settable in the
   * campaign builder and is styled on the agent's disposition pad; until now its
   * only other reference in the dialer runtime was a type check in the config validator, i.e.
   * the platform confirmed the operator's answer was a boolean and then discarded
   * it. An operator could mark `Sale` a success, watch agents submit it all day,
   * and find no number anywhere that had noticed.
   *
   * Gated on `bridged_at IS NOT NULL`, the same gate as every other flow metric
   * here and the same one `disposition.ts` uses to decide whether there was a
   * conversation to write up — never `outcome = 'connected'`, which is a
   * classification that can be absent, late, or say connected about a call no
   * agent ever heard.
   */
  attempts_success: number;
  /**
   * `attempts_success` over BRIDGED attempts, as a percentage, or `null` when
   * nothing has bridged.
   *
   * **Null, never 0** — the same rule as {@link abandonment_rate_24h_pct}, from
   * the same shared helper. "Nothing has converted yet" and "nothing has been
   * dispositioned yet" are different facts, and rendering the second as a
   * confident 0.0% is how a metric gets trusted before it has measured anything.
   *
   * The denominator is bridged attempts, **not** `attempts_total`: a dial that
   * rang out had no conversation to convert, so counting it against the script
   * would make the rate a function of list quality. Note this makes the
   * denominator `human_connects + machine_connects + unclassified_connects`
   * (which sum to every bridged attempt) rather than any single one of them.
   */
  success_rate_pct: number | null;

  /**
   * Average handle time, in seconds, **excluding voicemail-dispositioned attempts**
   *.
   *
   * Measured `ended_at − bridged_at` — the AGENT's leg. Deliberately not the
   * persisted `talk_seconds`, which is anchored on `answered_at` (the carrier's
   * answer) and is nonzero even when no agent ever bridged: an abandoned attempt
   * settles `completed` carrying the apology clip's talk time. Averaging
   * that column would fold ring-to-bridge latency and abandoned calls into a number
   * whose whole purpose is to describe agent work.
   */
  aht_seconds: number | null;
  /** The same average with voicemail included — the console's "raw figure on hover". */
  aht_seconds_including_machine: number | null;

  /**
   * Average wrap-up, in seconds — the supervisor's tuning input for
   * `wrapup_seconds`.
   *
   * Averages `disposition_submitted`, `auto_return` and `agent_returned`; `forced`, `agent_left` and
   * `campaign_stopped` are excluded. `null` until enough wrap-ups have concluded to say anything.
   */
  avg_wrapup_seconds: number | null;

  /** The configured ceiling the rate is drawn against. */
  abandonment_ceiling_pct: number;

  /**
   * The health strip: the single highest-priority reason this campaign is not
   * dialing, or `null` for "running normally".
   *
   * One diagnosis, not a list, because the strip shows one — a supervisor reading
   * five simultaneous problems acts on none of them. Everything else that also
   * matched is in {@link other_stalls} behind "2 more issues".
   */
  stall: AgencyStall | null;

  /**
   * The codes that also matched, in the same priority order, excluding the one in
   * {@link stall}. Codes only — the console renders a count and a list of names,
   * and carrying full evidence for problems it is not showing would triple the
   * payload for a disclosure most supervisors never open.
   */
  other_stalls: AgencyStallCode[];

  /**
   * The account's configured concurrency ceiling.
   *
   * A READ-OUT, never a control. There is no tenant-facing setter, and
   * grouping this with start/pause/stop would itself be an affordance claim. A tenant-facing
   * setter is out of scope.
   */
  concurrency_limit: number;

  /**
   * Live utilisation against that ceiling, or `null` when it cannot be read.
   *
   * **Account-wide, not campaign-wide** — the account's Redis counter, so
   * a supervisor seeing "4 of 5" is seeing their real headroom including traffic
   * this campaign knows nothing about. `null` rather than a substituted local
   * count when Redis is degraded: "4 of 5" and "we don't know" are different
   * answers, and the strip's concurrency diagnosis must not fire on a guess.
   */
  concurrency_in_use: number | null;

  // The per-tile hour-over-hour delta is NOT here, and this is the second
  // deliberate omission rather than an oversight.
  //
  // A `previous_hour` block was built and removed before shipping. It carried the
  // flow metrics over `[now()-2h, now()-1h)`, which is a sound window — but every
  // field it would have been compared AGAINST is a campaign-LIFETIME aggregate:
  // `human_connects`, `aht_seconds` and the rest have no time filter, and
  // `abandonment_rate_24h_pct` is a 24h window. So the console would have rendered
  // a lifetime figure beside one hour of it: a campaign on day three with 5,000
  // lifetime connects and 30 in that hour reads as a permanent 99% collapse, and
  // the damped lifetime averages make every rate delta understate the real move
  // with an unreliable sign.
  //
  // The honest shape needs BOTH windows — last hour and the hour before it — so the
  // comparison is like-for-like, which is the same amount of SQL again. It lands
  // with the health strip, where the console gets a coherent trend surface at once.
  // A delta that is confidently wrong in a fixed direction is worse than no delta,
  // and this tile's whole purpose is the sentence "66%, down from 74%".
}

/**
 * Every field of {@link AgencyCampaignStats}, as runtime-enumerable data.
 *
 * The one runtime export in an otherwise types-only module, and it earns the
 * exception. Three required fields shipped with no producer at all,
 * through two separate holes — and only one of them is reachable by a type:
 *
 *  1. **The producer not writing a declared field.** `stats()` returned
 *     `Record<string, number>`; an index signature satisfies every field name, so
 *     the compiler agreed the contract was met. It now returns
 *     `Omit<AgencyCampaignStats, 'campaign_id' | 'status'>`, which makes this arm a
 *     compile error and needs nothing from this roster.
 *  2. **The producer reading its own SQL by string key.** The mapper pulls
 *     `row['answered_24h']` out of an untyped `Record<string, string>`, so renaming
 *     or dropping that column yields a confident `0` that satisfies every type in
 *     the chain and reports a perfectly compliant campaign. No annotation can see
 *     across that boundary; only executing the query can.
 *
 * This roster is what lets a test walk arm 2 exhaustively instead of spot-checking
 * the three fields someone remembered. It is typed `Record<keyof …, true>`, so a
 * field added to the interface and not here fails `npm run lint` — which is the
 * whole reason it lives in `src/` rather than beside the test that consumes it:
 * the dialer runtime's `tsconfig.json` excludes `test/`, so the identical guard written there
 * would be type-checked by nothing and would rot without ever going red.
 */
/**
 * The fields the ROUTE composes rather than the repository.
 *
 * The supervisor dashboard's health strip needs DNC health, the account concurrency guard's
 * live counter and calling-hours evaluation — none of which a repository can
 * see. So the payload now has two producers, and `stats()` returns an `Omit` of
 * exactly this set.
 *
 * The no-producerless-field guarantee is unchanged and still enforced in one place: the
 * route annotates its literal `const payload: AgencyCampaignStats`, so a new
 * required field is a compile error at whichever producer fails to supply it.
 * This constant exists so a test can assert the SPLIT is what it claims, rather
 * than a comment claiming it.
 */
export const AGENCY_STATS_ROUTE_FIELDS = [
  'campaign_id', 'status', 'stall', 'other_stalls',
  'concurrency_limit', 'concurrency_in_use',
] as const satisfies readonly (keyof AgencyCampaignStats)[];

export const AGENCY_CAMPAIGN_STATS_FIELDS: Record<keyof AgencyCampaignStats, true> = {
  campaign_id: true,
  status: true,
  // Composed by the ROUTE, not the repository — see `AGENCY_STATS_ROUTE_FIELDS`.
  stall: true,
  other_stalls: true,
  concurrency_limit: true,
  concurrency_in_use: true,
  contacts_total: true,
  contacts_pending: true,
  contacts_in_flight: true,
  contacts_completed: true,
  contacts_suppressed: true,
  contacts_exhausted: true,
  retries_pending: true,
  attempts_live: true,
  attempts_total: true,
  attempts_connected: true,
  attempts_retried: true,
  agents_live: true,
  abandoned_24h: true,
  answered_24h: true,
  abandonment_rate_24h_pct: true,
  agents_by_state: true,
  agents: true,
  human_connects: true,
  machine_connects: true,
  unclassified_connects: true,
  machine_connects_available: true,
  connect_rate_pct: true,
  attempts_success: true,
  success_rate_pct: true,
  aht_seconds: true,
  aht_seconds_including_machine: true,
  avg_wrapup_seconds: true,
  abandonment_ceiling_pct: true,
};

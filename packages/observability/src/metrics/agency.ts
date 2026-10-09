/**
 * Metric declarations for the agency dialer runtime, declared through
 * ../metric-instruments.js and ../meter.js.
 */
import { meter } from '../meter.js';
import { counter, histogram, observableGauge } from '../metric-instruments.js';

// ── S3 metrics ────────────────────────────────────────────
// Names, labels and buckets are charted by the platform overview dashboard. Read by
// `getFileStream` / `headFile`, the two S3 functions in `apps/server/src/storage/s3.ts`
// (decision B14). The histogram is `unit: 's'` like the other duration histograms here;
// these instruments have no `startTimer` wrapper, so the one timed caller (`headFile`)
// measures and `observe`s.
export const s3OperationsTotal = counter<'operation' | 'status'>(meter, 's3_operations_total', {
  description: 'Total S3 operations',
});

export const s3OperationDurationSeconds = histogram<'operation'>(meter, 's3_operation_duration_seconds', {
  description: 'S3 operation duration in seconds',
  unit: 's',
  buckets: [0.05, 0.1, 0.5, 1, 2, 5],
});

// ── Agency runtime metrics ───────────────────────────────────────────────
// Deliberately absent: an hourly attempt-batch billing series (there is no attempt
// batcher), and `agency_dnc_synced` plus the DNC outbox series (there is no Redis DNC
// set or outbox — decision B8).

// ─── Agency dialer: the compliance abandonment metric ────────────────────────
//
// Two counters and a three-gauge window, and the split is the point.
//
// The COUNTERS are process-local and event-driven: incremented where the dialer
// observes the carrier answering and where it settles an attempt `abandoned`.
// They reset on restart, as every in-process counter does.
//
// The WINDOW gauges are derived from `agency_call_attempts` by SQL and survive a
// restart, because a rolling 24h regulatory number cannot be reconstructed from
// a process that has just started. **That is not an implementation detail — it is
// what makes an independent cross-check meaningful.** A counter audited against a table
// number derived from the same write agrees perfectly and proves nothing, which
// is exactly how an abandonment metric once went unnoticed returning 0 for
// months. Do not re-point either side at the other's source.

export const agencyAnsweredTotal = counter<'tenant_id' | 'campaign_id'>(meter, 'agency_answered_total', {
  description: 'Agency dialer attempts the carrier reported answered',
});

export const agencyAbandonedTotal = counter<'tenant_id' | 'campaign_id'>(meter, 'agency_abandoned_total', {
  description: 'Agency dialer attempts a customer answered that reached no agent',
});

/**
 * ─── THE 24h WINDOW: the rate AND both of its terms ─────────────────────────────
 *
 * Deliberately three series rather than one. A rate alone cannot distinguish
 * 1-abandoned-of-1 from 30-of-3000, and the auto-pause guardrail
 * reads this: pausing a campaign because its first call of the day was
 * abandoned would be a self-inflicted outage. Same lesson as `no_balance_row` —
 * facts that are distinguishable in the data must not be collapsed into one
 * series on the way out.
 *
 * These three must be exported over OTLP, because Grafana Cloud is fed by OTLP and
 * not by scraping :9090; a series visible only on the scrape is invisible there,
 * and these are the numbers a compliance reviewer asks for. Be exact about the
 * exposure: the auto-pause guardrail is NOT blinded by that (it reads the same SQL rows
 * `publishAbandonmentMetrics` is handed), and there is at present **no dashboard
 * panel and no alert rule on any of these three names** — grep the repo,
 * `grafana/` included. The series are reachable by one; somebody still has to
 * build it.
 *
 * **A snapshot setter, not three per-label setters, and that is the whole
 * shape.** The window is republished in full on every refresh, so "which
 * campaigns are still in the window" is a property of the array, not something a
 * caller has to remember to unwind — replacing it wholesale drops a campaign that
 * aged out for free. Per-label setters would need every caller to remove the
 * labels it no longer publishes, and would fail silently when one forgot: a
 * gauge whose backing state is never pruned keeps reporting a campaign's last
 * rate forever, the stale-number-pauses-the-wrong-campaign failure.
 */
export type AgencyAbandonmentSample = {
  tenant_id: string;
  campaign_id: string;
  answered: number;
  abandoned: number;
  /**
   * `null` means NOT PUBLISHABLE, and the callback below omits it rather than
   * observing 0. "No answered calls yet" and "0% abandoned" are different
   * answers, and an alert rule can only tell them apart if we decline to invent
   * the second.
   */
  ratePct: number | null;
};

/**
 * How long a published window stays exportable without a refresh.
 *
 * ── Why a compliance gauge needs an expiry at all ───────────────────────────
 *
 * `publishAbandonmentMetrics` is only reached after `window24h()` SUCCEEDS. If
 * that query starts failing — a permission change, a timeout, a degraded replica
 * — the refresh loop logs and returns, `enforceAbandonmentCeiling` correctly
 * goes inert on the same rows, and without an expiry these three gauges would go
 * on exporting the last good snapshot on every collection, indefinitely.
 *
 * That is the dangerous direction. A campaign at 2.1% when the snapshot landed
 * climbs past its ceiling; the guardrail is silent; the metric keeps asserting
 * compliance; and nothing distinguishes it from a healthy quiet system. Absence
 * does distinguish it — `no_data` is a state a rule can fire on, a stale
 * reassuring number is not.
 *
 * Same reasoning and same mechanism as `DNC_SYNCED_TTL_MS` below, which spells
 * out that a stale sample is still a sample. The first version of this fix
 * omitted it and copied only the shape of that precedent, not its lesson.
 *
 * Sized well above the refresh cadence so an ordinary blip does not blank the
 * series: several missed refreshes have to accumulate before the window drops.
 */
const ABANDONMENT_WINDOW_TTL_MS = 20 * 60_000;

let _agencyAbandonmentWindow: readonly AgencyAbandonmentSample[] = [];
let _agencyAbandonmentWindowAt = 0;

/**
 * Replace the exported 24h window.
 *
 * Deliberately a whole-array replace: see the block comment above. Cannot throw
 * (a plain assignment).
 *
 * The array is COPIED. The one caller today builds a fresh array and never
 * mutates it, so this fixes no live bug; it is that this module is the most
 * widely imported in the repo, `readonly` constrains only our view of the
 * caller's array rather than the caller's own handle on it, and a future caller
 * retaining and mutating one would corrupt the exported compliance window with
 * nothing failing anywhere. The DNC precedent sidesteps aliasing the same way,
 * by copying into a map.
 */
export function setAgencyAbandonmentWindow(samples: readonly AgencyAbandonmentSample[]): void {
  _agencyAbandonmentWindow = [...samples];
  _agencyAbandonmentWindowAt = Date.now();
}

/** Test seam — the module-level snapshot would otherwise leak between cases. */
export function resetAgencyAbandonmentWindow(): void {
  _agencyAbandonmentWindow = [];
  _agencyAbandonmentWindowAt = 0;
}

/**
 * The window to export right now, or empty once it has gone stale.
 *
 * Expiry is applied at collection rather than on a timer of its own, exactly as
 * `agency_dnc_synced` does it: collection is already periodic, so this is the
 * one place that is free. All three callbacks read through here, so the rate and
 * its two terms can never disagree about whether the window is still valid.
 */
function liveAbandonmentWindow(): readonly AgencyAbandonmentSample[] {
  if (_agencyAbandonmentWindowAt === 0) return [];
  if (Date.now() - _agencyAbandonmentWindowAt > ABANDONMENT_WINDOW_TTL_MS) return [];
  return _agencyAbandonmentWindow;
}

observableGauge<'tenant_id' | 'campaign_id'>(meter, 'agency_abandonment_rate_24h', {
  description: 'Rolling 24h abandonment rate, percent (numerator/denominator also exported)',
}, (observe) => {
  for (const s of liveAbandonmentWindow()) {
    // Absent, not zero. See `ratePct` above.
    if (s.ratePct === null) continue;
    observe(s.ratePct, { tenant_id: s.tenant_id, campaign_id: s.campaign_id });
  }
});

observableGauge<'tenant_id' | 'campaign_id'>(meter, 'agency_abandonment_window_answered_24h', {
  description: 'Answered attempts in the rolling 24h window (the rate denominator)',
}, (observe) => {
  for (const s of liveAbandonmentWindow()) {
    observe(s.answered, { tenant_id: s.tenant_id, campaign_id: s.campaign_id });
  }
});

observableGauge<'tenant_id' | 'campaign_id'>(meter, 'agency_abandonment_window_abandoned_24h', {
  description: 'Abandoned attempts in the rolling 24h window (the rate numerator)',
}, (observe) => {
  for (const s of liveAbandonmentWindow()) {
    observe(s.abandoned, { tenant_id: s.tenant_id, campaign_id: s.campaign_id });
  }
});

// ─── Agency dialer: LIVE CONCURRENCY (pilot finding 4 — `calls_active_current`
//     is NOT this, and cannot be made into it) ─────────────────────────────────
//
// `calls_active_current` (top of this file) is set from `CallManager`'s AI
// `activeSessions` map. An agency dial is a WebRTC bridge session and never
// enters that map, so **the dialer reads flat 0 there** — the 2026-09-08 pilot
// ran 100+ calls with the platform's only live-concurrency number pinned at
// zero, and nothing looked wrong.
//
// Three ways of "fixing" that were rejected, and the reasons are the design:
//
// 1. **Add a `call_type` label to `calls_active_current`.** Adding a label to a
//    live Prometheus series terminates it: every `rate()`/`increase()` window
//    spanning the deploy under-reports and pinned recording rules go empty. The
//    file already records this for `static_calls_total`, which was terminated
//    deliberately and knowingly.
// 2. **Add a second writer to it.** Its value is one module's map length
//    (`callsActiveCurrent.set`), so a second writer does not add — it
//    overwrites, and the two paths race on every scrape.
// 3. **Count in process.** A gauge kept in memory is per-replica and per-process
//    lifetime, and the dialer's authority on attempt state is Redis-plus-a-row,
//    not a local map. It would read 0 on the replica an operator happened to
//    scrape and lose everything on a restart.
//
// So this is a **separate family, derived from `agency_call_attempts` by SQL**,
// on the `agency_abandonment_window_*` pattern: a whole-snapshot publish on a
// timer, exported through both pipelines, expiring at collection. The SQL uses
// the identical `state <> 'ended'` predicate as the pacing tick's `occupied`
// term, so this family reconciles with the number the tick actually subtracted
// from the account concurrency limit rather than being a second opinion about it
// — see `AgencyLiveConcurrencyRepository.liveByState`.
//
// ⚠️ **AGGREGATE WITH `max`, NEVER `sum`.** The SQL is FLEET-WIDE and every
// replica runs its own refresh timer, so all R replicas publish the identical
// series and Prometheus keeps them as R distinct targets. `sum()` therefore
// reports R times the truth — silently, and worse the more you scale out.
// `max by (campaign_id, state)` is the correct reduction, and it is the same rule
// the pre-existing `agency_abandonment_rate_24h` already follows: the platform
// dashboard queries that one `max by (campaign_id)` for precisely this reason.
// The distinction to hold on to is per-metric-kind, not per-metric: fleet-wide
// SQL-derived GAUGES take `max`; per-replica COUNTERS (`agency_answered_total`,
// `agency_abandoned_total`) take `sum(rate(...))` because their increments are
// genuinely disjoint. A leader gate would remove the hazard but is deliberately
// NOT used — it would make the export go dark whenever leadership moved, and an
// operator gauge that vanishes during a failover is worse than one with a
// documented aggregator.
//
// Two consequences of `max` worth knowing before building on it. (1) Replicas poll
// on independent 15s phases, so on a FALLING edge `max` picks the stalest snapshot
// and over-reports committed capacity for up to one refresh interval — the safe
// direction for a concurrency signal, but not a zero. (2) **A derived ratio must
// apply `max by` to each TERM, never to the ratio** — `max by (…) (bridged) / max
// by (…) (dialing + bridged)` and not `max by (…) (bridged / (dialing + bridged))`.
// Reduce the ratio and the numerator and denominator can come from different
// replicas' snapshots, which lets a share exceed 1.
//
// **`state` is what makes this worth having.** Flat concurrency answers "is the
// dialer busy"; the pacing work needs "busy doing what". `dialing` is a **dial in
// flight** — capacity committed to a phone that may never be answered, which is
// the quantity any future over-dial factor is applied to — while
// `bridged` is **conversations in progress**, capacity that is actually earning.
// (`ringing` is a legal member of the state union and is folded into the export,
// but NOTHING IN THE CODEBASE EVER WRITES IT — see `agency-dialer.ts`. A panel
// keyed on `state="ringing"` will be permanently empty; key dials-in-flight on
// `dialing`.)
// Those two were indistinguishable in the pilot (the 33 "bridged" / 32% figure
// turned out to be an overstatement in both directions), and collapsing them into
// one series would rebuild exactly that blind spot on the way out. Same lesson as
// `no_balance_row`: facts that are distinguishable in the data must not be
// collapsed into one series at the export.
//
// `campaign_id` is an acceptable label here for the same reason it is on the
// abandonment gauges and refused on the hourly billing counters: these are
// **gauges re-derived from a fresh SQL read every pass**, so a campaign that goes
// quiet leaves the export (the gauge observes only the live snapshot) instead of
// accreting a permanent series the way a counter's child would.

/**
 * One published sample: a campaign's live attempt count in one state.
 *
 * `state` is `string` rather than `AgencyAttemptState`, and it reaches this
 * module **already narrowed**: `src/agency/live-concurrency-metrics.ts` folds
 * anything outside `AGENCY_ATTEMPT_LIVE_STATES` into a single `unknown` bucket.
 * That fold is the label-cardinality guard (**label values are bounded by source
 * code, never by anything outside it** — the column's CHECK constraint included,
 * since a migration can widen that without touching TypeScript), and it lives at
 * the publisher rather than here because this module is imported by ~200 files
 * and must not take a dependency on the agency model to do it.
 */
export type AgencyLiveAttemptSample = {
  tenant_id: string;
  campaign_id: string;
  state: string;
  live: number;
};

/**
 * How long a published live-concurrency snapshot stays exportable.
 *
 * ── Why this is 90s where `ABANDONMENT_WINDOW_TTL_MS` is 20 minutes ─────────
 *
 * Same mechanism, same failure mode — a failing query leaving a reassuring
 * number on the wire forever — but the budget has to be scaled to the thing
 * being measured, not copied from the precedent. The abandonment gauges describe
 * a **24 hour** regulatory window, so twenty minutes of staleness is a rounding
 * error in the number itself. These describe **right now**: an attempt lives in
 * `dialing`/`ringing` for a handful of seconds, so a snapshot minutes old is not
 * a slightly-late reading of live concurrency, it is a reading of something else.
 *
 * 90s is six missed refreshes at `AGENCY_LIVE_CONCURRENCY_REFRESH_MS` (15s) —
 * enough to ride out a Postgres failover or a rolling restart without blanking
 * the series on an ordinary blip, and short enough that "the floor is busy"
 * cannot outlive the evidence for it by long. The dangerous direction is the
 * reassuring one: a stalled dialer whose last good snapshot said 40 in flight
 * looks healthier than one exporting nothing, and `absent()` is a condition an
 * alert can fire on where a stale number is not.
 */
const AGENCY_LIVE_ATTEMPTS_TTL_MS = 90_000;

let _agencyLiveAttempts: readonly AgencyLiveAttemptSample[] = [];
let _agencyLiveAttemptsAt = 0;

/**
 * Replace the exported live-concurrency snapshot.
 *
 * A whole-array replace, not per-label setters, and that IS the pruning
 * mechanism: "which campaigns still have calls up" is a property of the array,
 * so a campaign that went quiet is gone for free rather than being something a
 * caller has to remember to unwind.
 *
 * The array is COPIED for the reason `setAgencyAbandonmentWindow` copies:
 * `readonly` constrains our view of the caller's array, not the caller's own
 * handle on it, and this module is the most widely imported in the repo.
 */
export function setAgencyLiveAttempts(samples: readonly AgencyLiveAttemptSample[]): void {
  _agencyLiveAttempts = [...samples];
  _agencyLiveAttemptsAt = Date.now();
}

/** Test seam — the module-level snapshot would otherwise leak between cases. */
export function resetAgencyLiveAttempts(): void {
  _agencyLiveAttempts = [];
  _agencyLiveAttemptsAt = 0;
}

/**
 * The snapshot to export right now, or empty once it has gone stale.
 *
 * Expiry is applied here — at collection — rather than on a timer
 * of its own, exactly as `expireStaleQueuedBacklog` and `liveAbandonmentWindow`
 * do it: collection is already periodic, so it is the one tick that is free and
 * the one tick that keeps happening after the publisher has gone quiet.
 */
function liveAgencyAttempts(): readonly AgencyLiveAttemptSample[] {
  if (_agencyLiveAttemptsAt === 0) return [];
  if (Date.now() - _agencyLiveAttemptsAt > AGENCY_LIVE_ATTEMPTS_TTL_MS) return [];
  return _agencyLiveAttempts;
}

/**
 * Observed at collection, from the snapshot alone — `setAgencyLiveAttempts` is
 * the only way in. That gets three things with no bookkeeping: the TTL applies
 * to the OTLP export and the `:9090` scrape alike (both collect through here);
 * pruning is structural (a campaign absent from the snapshot is not observed,
 * so it is not exported); and nothing can leave the series half-built.
 *
 * Side-effect free, unlike the DNC callback which prunes as it observes:
 * observables re-report on every collection, so a callback that consumed the
 * snapshot would empty it on the first collection after a refresh and report
 * nothing on every one after that.
 *
 * This is the dialer's first live-concurrency signal, and it is exported to
 * OTLP from day one: Grafana Cloud is the only place an operator looks.
 */
observableGauge<'tenant_id' | 'campaign_id' | 'state'>(meter, 'agency_live_attempts_current', {
  description: 'Agency dialer attempts that have not reached `ended`, by attempt state',
}, (observe) => {
  for (const s of liveAgencyAttempts()) {
    observe(s.live, { tenant_id: s.tenant_id, campaign_id: s.campaign_id, state: s.state });
  }
});

// ─── Pre-dial compliance gates ─────────────────
//
// **These exist because a fail-closed gate makes "nothing dialed" ambiguous.** Once
// the DNC gate can halt a campaign, a supervisor looking at zero calls cannot tell
// a compliance halt from "no agents are on shift", "the account's concurrency is
// full", or "the roster has nothing due" — and the last three are the normal state
// of a healthy campaign most of the day. Without these two series, every future
// incident starts with an hour spent on a pacing red herring.
//
// So the four causes are four distinguishable series, and the split follows the same
// rule as the abandonment window above: facts that are distinguishable in the data
// must not be collapsed on the way out.
//
// **Alert on `gate="dnc_unavailable"`.** It is the only one that means the platform
// is refusing to work — a tenant whose DNC set is not authoritative places no calls,
// and the refusal is correct but nobody is coming to fix it on their own.
export const agencyPreDialGateTotal = counter<'campaign_id' | 'gate' | 'action'>(meter, 'agency_predial_gate_total', {
  description: 'Pre-dial gate decisions, by gate and what the tick did about it',
});

// The benign reasons a tick dials nothing, so they are subtractable from the above
// rather than being guessed at. `no_contacts` is the ordinary end of every campaign
// and should be the busiest series here; a campaign showing none of these AND no
// gate decisions is not idle, it is broken. It was prom-client only once, so the
// idle reasons — the thing that distinguishes "no agents on shift" from "the
// roster is exhausted" from "the tick is broken" — were invisible in Grafana Cloud.
export const agencyTickIdleTotal = counter<'campaign_id' | 'reason'>(meter, 'agency_tick_idle_total', {
  description: 'Ticks that dialed nothing, by benign reason (no agents, no slots, no contacts)',
});

// ─── Agency dialer: SEAT TIME, so pacing decisions stop being arguments ──────
//
// Added 2026-09-10. Every number in the pacing recommendation — the 5-agent
// over-dial floor, the 29% talk share, "a busy signal costs 37s on VoiceLink" —
// came from ONE 39-minute pilot, hand-decomposed from a debrief. Two independent
// analyses of the same question then disagreed on the single largest term (whether
// an unanswered dial holds an agent for ~31s or ~55s) and neither could settle it,
// because **nothing in the platform measures how long an agent is held per
// attempt.** These series exist so the next pacing decision reads a dashboard
// instead of re-deriving a model.
//
// The four questions they answer, and nothing else:
//
//  1. Where does seat time actually go?          `agency_attempt_hold_seconds`
//  2. How long does a dial take to answer?       `agency_answer_latency_seconds`
//  3. Is the late bind inside its 1s budget?     `agency_bind_latency_seconds`
//  4. When we abandon, why?                      `agency_abandoned_reason_total`
//
// **All of these are per-replica COUNTERS and HISTOGRAMS, not SQL-derived gauges.**
// So they aggregate with `sum(rate(...))` / `histogram_quantile(...)` over the
// fleet, NOT with `max` — the opposite of `agency_abandonment_rate_24h` and
// `agency_live_attempts_current`, which every replica publishes identically. The
// distinction is already written up at length above; it is repeated here only
// because these two families now sit next to each other on the same dashboard and
// the wrong aggregator on either is silent.
//
// **The four HISTOGRAMS here carry `tenant_id` but NOT `campaign_id`** (removed
// 2026-09-29). Each histogram costs `buckets + 3` series per label set — 18 for
// the hold series — and campaigns are created continuously, so `campaign_id`
// minted a fresh block of never-expiring series (cumulative OTLP temporality) per
// campaign on a Grafana Cloud stack already at its active-series cap. These are
// fleet/tenant pacing distributions; a per-campaign quantile is answered from
// `agency_call_attempts` in SQL. The agency COUNTERS keep `campaign_id` — in
// particular the compliance numerator/denominator and the abandonment-window
// gauges above, whose label sets are deliberately frozen — so a join on
// `campaign_id` between a histogram and a counter is no longer possible; join on
// `tenant_id`.

/**
 * Agent-held seconds per attempt, by how the attempt ended.
 *
 * **This is the pivotal series and the reason this block exists.** `outcome` is the
 * split that matters: the pilot's largest single block of dead time was 32 busy
 * signals at ~37s each, and a busy phone never rings — so no ring timeout can
 * touch it, and an aggregate "average wait" would have hidden that completely. The
 * lever a number here implies depends entirely on which bucket it lands in:
 *
 *   • `busy` / `failed` high     ⇒ carrier signalling latency. Nothing we can tune.
 *   • `no_answer` high           ⇒ a ring timeout would pay (needs a cancel-capable
 *                                  carrier).
 *   • `connected` high           ⇒ ring + talk, NOT talk. See the warning below.
 *   • `canceled` high            ⇒ our own teardown latency.
 *
 * ⚠️ **`connected` is ring + talk + the ending wait, and reading it as talk time
 * is a real analytical error** (corrected by review; an earlier version of this
 * list said "talk time. Not waste."). The observation is
 * `Date.now() - live.dialedAt`, and `dialedAt` is stamped before the carrier is
 * called — so a 25s ring followed by a 40s conversation lands here as 65s. An
 * operator who reads the connected bucket as conversation will treat pickup delay
 * as productive time and will never open {@link agencyAnswerLatencySeconds},
 * which is the series that separates them. The three intervals this block spans,
 * named once so they are not conflated again:
 *
 *   1. dial → carrier answer  — ring. {@link agencyAnswerLatencySeconds} measures
 *                                it on its own, and it IS waste.
 *   2. answer → attempt settle — the conversation plus the `ending` wait for the
 *                                carrier's confirmation. Not waste.
 *   3. wrap-up                 — after the settle. {@link agencyWrapupSeconds},
 *                                deliberately not in this series at all.
 *
 * So `connected` here is (1) + (2). To get talk time, subtract
 * `agency_answer_latency_seconds` — or read `call_duration_seconds`, which starts
 * at the answer.
 *
 * ⚠️ **Measured from the dial to the attempt SETTLING, not to the agent being
 * released** — the help string said "to release" and was wrong (corrected by
 * review). It is still seat time rather than call duration, and it still captures
 * the gap that matters most: an answered call the agent hung up sits in `ending`
 * awaiting the carrier's confirmation with the agent held throughout, and that is
 * invisible in `call_duration_seconds`.
 *
 * The settle point is deliberate, not convenient. Releasing is not one event: a
 * `connected` attempt goes settle → wrap-up → release, so measuring to release
 * would fold wrap-up into this histogram's `connected` bucket, double-count it
 * against {@link agencyWrapupSeconds}, and make the one bucket an operator must
 * NOT try to shrink look like the biggest opportunity on the chart.
 *
 * **Known residual:** the contact-policy writes and `releaseAgent` that follow the
 * settle are real seat time and are counted by neither series. In-process that is
 * a few awaited statements; on a degraded pool it is unbounded, and it would show
 * up here as nothing at all. Worth an explicit series if the pool ever becomes the
 * suspect; not worth pretending this one covers it.
 *
 * **Buckets.** The lower range is sized for the unanswered outcomes, whose upper
 * bound is the carrier's own terminal report — the two candidate figures for it
 * are 31s and 75s, and if the 90s bucket ever dominates for `busy`/`no_answer`
 * then the bound is not what either analysis thought.
 *
 * They now run to 600s, and that extension was NOT cosmetic (added by review).
 * The set stopped at 90s, which is right for every waste outcome and wrong for
 * the one bucket an operator must not try to shrink: a `connected` attempt
 * routinely runs minutes, so **every connected observation sat in `+Inf` and the
 * distribution was unreadable** — `_sum/_count` still yielded a mean, which is
 * exactly the one-pilot number this series exists to replace. Prometheus cannot
 * vary buckets by label, so covering both ranges in one set is the only option
 * and the cost is four extra series per label combination. That is the right
 * trade: the alternative is a pivotal series that cannot answer "are calls
 * getting longer" for the half of seat time that is productive.
 */
export const agencyAttemptHoldSeconds = histogram<'tenant_id' | 'outcome'>(meter, 'agency_attempt_hold_seconds', {
  description: 'Seconds an agent was held for one attempt, from dial to attempt settle, by outcome (wrap-up is separate)',
  unit: 's',
  // Past 90s on purpose: a lower top bucket would keep every `connected`
  // observation in `+Inf`, which is where the quantiles an operator reads live.
  buckets: [1, 5, 10, 15, 20, 25, 30, 40, 50, 60, 90, 120, 180, 300, 600],
});

/**
 * Dial → carrier answer, for attempts that answered.
 *
 * Sets the ring timeout worth configuring (where the curve flattens) and prices
 * what a given timeout would forgo (the tail beyond it). It is also half of the
 * over-dial arithmetic: the marginal abandonment of a surplus dial depends on how
 * tightly two answers can cluster, and that is this distribution's shape rather
 * than a flat `p` would assume.
 *
 * Deliberately NOT labelled by outcome. Under D1 a voicemail pickup is an answer
 * like any other, so this measures the carrier's view, which is the same view the
 * abandonment predicate takes.
 */
export const agencyAnswerLatencySeconds = histogram<'tenant_id'>(meter, 'agency_answer_latency_seconds', {
  description: 'Seconds from dial to the carrier answer, for attempts that answered',
  unit: 's',
  buckets: [2, 4, 6, 8, 10, 15, 20, 25, 30, 45],
});

/**
 * Carrier answer → the agent's station socket attached, under late binding.
 *
 * ⚠️ **The whole budget is `ABANDONMENT_BRIDGE_GRACE_MS` = 1000ms.** Everything
 * this measures is time the compliance predicate counts as abandonment, so the
 * buckets are deliberately sub-second and crowd the region that matters: p99 above
 * 150ms is the documented abort criterion for the late-binding rollout, and until
 * now that criterion has been **not instrumented**. This is the instrument.
 *
 * A refused bind was previously a WARN line and nothing else. Pair this with
 * `agencyBindTotal` below — latency alone cannot distinguish "fast" from "never
 * attempted".
 */
export const agencyBindLatencySeconds = histogram<'tenant_id'>(meter, 'agency_bind_latency_seconds', {
  description: 'Seconds from the carrier answer to the agent station socket attaching (budget: 1s)',
  unit: 's',
  buckets: [0.01, 0.025, 0.05, 0.1, 0.15, 0.25, 0.5, 0.75, 1, 2],
});

/**
 * Every late-bind attempt and how it resolved.
 *
 * The denominator `agencyBindLatencySeconds` cannot supply — a bind that never
 * happened records no latency, so a rollout watching only the histogram sees a
 * *faster* p99 as binds start failing.
 *
 * `result` is exactly `bound`, `station_lost` or `bind_failed` — nothing else is
 * emitted, and the two failures are {@link AgencyAbandonReason} values. Sharing
 * the vocabulary is deliberate rather than incidental: it makes this series join
 * to `agency_abandoned_reason_total` on the label value, so "binds that failed"
 * and "abandonments caused by a failed bind" are the same number rather than two
 * numbers an operator has to trust are related.
 *
 * Two reasons cannot appear here, and both absences are load-bearing rather than
 * accidental: `bridge_late` means the bind SUCCEEDED and was merely slow, and
 * `unattributed`/`no_agent_available` are settle-site values that describe a call
 * this counter never saw a bind attempt for. An earlier version of this comment
 * listed `no_agent_available` as a possible result; it never was.
 */
export const agencyBindTotal = counter<'tenant_id' | 'campaign_id' | 'result'>(meter, 'agency_bind_total', {
  description: 'Late-bind attempts by result: bound, or the AgencyAbandonReason that stopped it',
});

/**
 * Abandonments split by cause.
 *
 * ⚠️ **A SEPARATE SERIES, not a `reason` label on `agency_abandoned_total`.**
 * A `reason` label would be tempting, but adding one terminates the live
 * series, which is the compliance numerator and is read by the auto-pause
 * guardrail's own cross-check. `static_calls_total` got a deliberate migration for
 * exactly this; a diagnostic label does not earn one. So this rides alongside, and
 * `agency_abandoned_total` keeps its shape and its history.
 *
 * The discrimination is the point: during a staged rollout a bind failure and a
 * genuine no-agent-free abandonment are the same increment in the counting series,
 * and they call for opposite responses — roll back, or slow the pacing down.
 *
 * `sum(rate(agency_abandoned_reason_total[5m]))` should track
 * `sum(rate(agency_abandoned_total[5m]))`. A persistent gap means an abandon path
 * that reaches the compliance counter without declaring a reason.
 */
export const agencyAbandonedReasonTotal = counter<
  'tenant_id' | 'campaign_id' | 'reason'
>(meter, 'agency_abandoned_reason_total', {
  description: 'Abandoned attempts by cause',
});

/**
 * How long wrap-up actually takes, by how it ended.
 *
 * The supervisor view already averages this in SQL for the supervisor view, but there is
 * no time series — so "wrap-up is 18.5s mean against a 30s window" is a pilot
 * artefact nobody can re-check. `resolution` keeps it honest for the same reason
 * migration 088 records it: a `forced` or `agent_left` wrap-up is not evidence
 * about how long write-up work takes, and only `disposition_submitted`,
 * `auto_return` and `agent_returned` are.
 *
 * It is also the series that prices the keyboard/hotkey work: the pilot filed zero
 * of 32 dispositions by keyboard, so any drop here after that ships is the whole
 * measurement of it.
 */
export const agencyWrapupSeconds = histogram<'tenant_id' | 'resolution'>(meter, 'agency_wrapup_seconds', {
  description: 'Wrap-up duration in seconds, by resolution',
  unit: 's',
  buckets: [2, 5, 8, 12, 18, 25, 35, 50, 75, 120],
});

/**
 * Contacts retired because of OUR fault, not their unavailability.
 *
 * The shared 3-strike our-fault ledger has an unresearched bound
 * and **no surface at all** — a contact retired by our own dropped sockets and
 * cancelled dials is invisible everywhere. That was already true with two
 * producers. It is a blocker for adding a third, so this is the surface, and it
 * ships in the same change that adds one.
 *
 * Alert on any sustained non-zero: it means we are permanently retiring people we
 * failed to call, which is a revenue loss and a list-quality lie at the same time.
 */
export const agencyOurFaultRetirementTotal = counter<
  'tenant_id' | 'campaign_id' | 'outcome'
>(meter, 'agency_our_fault_retirement_total', {
  description: 'Contacts permanently retired by exhausting the our-fault redial ledger',
});

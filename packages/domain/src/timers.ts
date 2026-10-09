/**
 * ─── AGENCY DIALER — IN-PROCESS BUSINESS TIMERS ─────────────────────────────
 *
 * The deliberate counterpart to `AGENT_LEASE_MS` in `agent-state-machine.ts`, and
 * the separation is the point rather than tidiness.
 *
 * §6.1's invariant: **a Redis key TTL only ever expires when the thing renewing it
 * is gone. It is a liveness detector, never a business timer.** A TTL cannot
 * distinguish "took too long" from "the process died", and every value in the lease
 * table is passed to `PEXPIRE` by construction — so a business duration that lands
 * in that table silently becomes a TTL, and the first symptom is a customer
 * answering a call with no agent on the other end.
 *
 * Every duration in this file is therefore enforced by an in-process timer plus a
 * column on the attempt row: the timer for promptness while the process lives, the
 * row so a restart can reconstruct what was owed. Nothing here is ever handed to
 * Redis. `test/unit/agency/agent-state-machine.test.ts` pins both halves — the
 * lease table's key set, and that no value here appears in it.
 *
 * This module imports nothing on purpose, so the numbers are cheap to reach from a
 * route, a unit test, or the contract layer without dragging the bridge's config
 * graph along.
 */

/**
 * How long a live call is held open after the agent's station socket drops, waiting
 * for the same session to reconnect and re-adopt it (`AD-P2-C-07`).
 *
 * 8 seconds, and the number is a trade rather than a preference. **The customer is
 * on a live call hearing silence for the whole window**, so it is bounded by their
 * patience, not the agent's: a wifi roam or DHCP re-acquire lands in 2–6s, which
 * this covers, while a 20–30s window would mean the customer has hung up before the
 * agent gets back — and we would have held a concurrency slot to achieve it. A drop
 * longer than this is not a blip, and is settled honestly as `agent_disconnected`.
 *
 * Note this window cannot be implemented as a TTL even in principle: if the process
 * died, there is no bridge session left to resume onto.
 */
export const DEFERRED_HANGUP_MS = 8_000;

/**
 * How often the rolling abandonment window is re-read and republished
 * (`AD-P2-C-06`).
 *
 * 60s, matching the reaper's cadence. This is a **refresh interval, not the
 * window** — the 24h window lives in the SQL — and the distinction is the §6.1
 * invariant restated for metrics: a business period must never be expressed as a
 * key TTL, and it is not expressed as a poll interval either. Publishing more
 * often would cost a grouped aggregate per tick for a number regulators measure
 * over a day; less often would let the `AD-P4-C-02` guardrail act on a rate up to
 * that long out of date.
 */
export const ABANDONMENT_REFRESH_MS = 60_000;

/**
 * How often the hourly dial-attempt billing sweep runs (`AD-P2-C-09`).
 *
 * 60s, matching the reaper and the abandonment refresh. This is a **poll cadence,
 * not the batching period** — the hour lives in the SQL bucket and in the
 * `batch_reference`, and the settle margin lives in
 * `ATTEMPT_BATCH_SETTLE_MARGIN_MS`. All three are separate numbers on purpose.
 *
 * The cadence is also the **redelivery interval**, because the batcher records a
 * batch as posted only on a 2xx: an hour master rejected (a missing tenant balance
 * row 5xx's by design) is simply re-posted on the next tick. So this is the one
 * timer whose value bounds how quickly billing recovers once provisioning is fixed,
 * and 12 harmless reposts an hour is the deliberate cost of needing no retry sweep.
 */
export const ATTEMPT_BATCH_SWEEP_MS = 60_000;

/**
 * How often the DNC outbox retries marks master has not yet accepted (MAG-110).
 *
 * 15s, and deliberately the fastest sweep in this file. The others are billing and
 * metrics — a minute of lag costs nothing. This one is a customer's request not to
 * be called, and every interval it waits is another interval in which some other
 * campaign can dial them. It is also cheap in a way the others are not: on a
 * healthy fleet the claim query hits an empty partial index, because a mark
 * normally lands inline on the agent's own click and never reaches this sweep at
 * all.
 *
 * This is a **poll cadence, not the retry interval** — the backoff ladder lives in
 * `dncRetryBackoffSeconds` and the row's `next_attempt_at`, so a down master is not
 * hammered four times a minute.
 */
export const DNC_OUTBOX_SWEEP_MS = 15_000;

/**
 * How long a `sending` DNC outbox row may go without a heartbeat before it is
 * treated as stranded by a dead replica.
 *
 * 2 minutes, against a forward bounded at 5s by `REQUEST_TIMEOUT_MS`. The margin is
 * ~24× rather than a tight multiple because the cost of the two errors is wildly
 * asymmetric: recovering too EARLY tears a live forward from under itself and sends
 * a duplicate (which master de-duplicates — harmless), while recovering too LATE
 * only delays a retry by a bounded amount. Neither can lose the mark, so the number
 * is chosen to be obviously safe rather than tuned.
 *
 * ⚠️ This is an in-process timer against a DB column, not a Redis TTL — §6.1's
 * invariant. Nothing in this file is ever handed to `PEXPIRE`.
 */
export const DNC_OUTBOX_STALE_CLAIM_MS = 120_000;

/**
 * How long a station socket may go without a client `ping` before it is closed as
 * silent — the `heartbeat_grace_ms` the bootstrap contract advertises.
 *
 * 30s = three missed pings at the advertised 10s cadence, deliberately the same
 * budget the console's own missed-ping detector spends before it declares itself
 * disconnected, so both ends give up at the same moment rather than one of them
 * holding a socket the other has written off.
 *
 * **This number was advertised from the day the contract landed and enforced
 * nowhere.** `StationRegistry.lastSeen` was written at attach and on every
 * heartbeat and read by nothing, so a socket whose *client-side* heartbeat had
 * been orphaned stayed attached forever: `isLocallyOwned` kept answering true, so
 * `POST /sessions/:id/available` kept succeeding, while the Redis ownership key
 * that same heartbeat renews had long expired. An orphaned socket had no
 * recovery path at all — nothing closed it, so nothing made the console notice.
 *
 * It lives here rather than beside the sweep because the route serves it to the
 * client and the sweep enforces it, and a contract number with two readers and no
 * single source is a number that drifts.
 *
 * ⚠️ Not to be confused with `OWNERSHIP_TTL_MS` in `station-registry.ts`, which is
 * the same duration for the same reason and is a Redis TTL. §6.1's invariant cuts
 * exactly between them: that one is a liveness detector handed to `PEXPIRE`, this
 * one is an in-process timer. Nothing in this file is ever handed to Redis.
 */
export const STATION_HEARTBEAT_GRACE_MS = 30_000;

/**
 * How often the silent-station sweep runs.
 *
 * A **poll cadence, not the grace.** Matching the ping cadence, so a socket that
 * has blown its grace is closed within one heartbeat of doing so rather than up to
 * a whole grace period later. The pass is a walk over an in-process map with no
 * I/O, and it is demand-driven and self-dormant — armed on attach, disarmed after
 * two consecutive passes that both closed nothing *and* found no stations at all —
 * so a replica holding no stations ticks nothing.
 *
 * The dormancy condition requires an empty registry, not merely an idle pass, and
 * that is load-bearing: a healthy station can fall silent at any moment and
 * nothing would re-arm the timer, because its attach has already happened.
 */
export const STATION_HEARTBEAT_SWEEP_MS = 10_000;

/** Consecutive fully-idle station sweeps before the timer disarms itself. */
export const STATION_SWEEP_IDLE_PASSES_BEFORE_DORMANT = 2;

/**
 * How often the dialer's live-concurrency snapshot is re-read and republished
 * (pilot finding 4 — see `live-concurrency-metrics.ts`).
 *
 * 15s, and deliberately **four times** the abandonment refresh rather than
 * matching it. Both are poll cadences for a SQL-derived gauge family, but they
 * sample quantities on completely different timescales: a 24h compliance rate
 * barely moves in a minute, while an attempt lives in `dialing`/`ringing` for
 * roughly 5-25s (the pilot's traced call: dial → ringing 1.0s → answered 8.3s).
 * Polling that at 60s does not give a late reading of dials in flight — it
 * aliases them away entirely, so the series an operator checks to see whether the
 * dialer is dialing would read 0 through most of a busy shift. That is the exact
 * failure this metric exists to end, reintroduced as a sampling artefact.
 *
 * It is cheap enough to afford: the read is one grouped aggregate whose predicate
 * matches `uq_agency_attempt_live`'s partial index, so its cost is bounded by
 * live concurrency (tens of rows) and not by the table's history.
 *
 * Paired with `AGENCY_LIVE_ATTEMPTS_TTL_MS` in `src/utils/metrics.ts`, which is
 * six of these — the staleness budget is expressed as a multiple of this number,
 * so raising the cadence must not silently shorten the tolerance for a blip.
 */
export const AGENCY_LIVE_CONCURRENCY_REFRESH_MS = 15_000;

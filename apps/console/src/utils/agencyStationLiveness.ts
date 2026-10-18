/**
 * The station socket's liveness rules: the retry ladder, the silence that means
 * the server has dropped the agent, the flap cap, and the bound on a token mint.
 *
 * Pure and clock-free (every function takes the present), so the thresholds are
 * assertable without a socket or a fake timer. `useAgencyStation` owns the
 * sockets, the timers and the refs; it asks these functions the questions.
 */

/**
 * Reconnect backoff. Deliberately NOT read from `intervals`: those are the
 * server's liveness parameters, and reusing `heartbeat_ms` as a retry delay
 * would couple two unrelated things so that retuning one silently retunes the
 * other. These are the client's own retry policy.
 */
export const BACKOFF_MS = [500, 1000, 2000, 5000, 10_000, 15_000];

export function backoffFor(attempt: number): number {
  return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
}

/**
 * the third row. Three missed pings is 30 s of silence, which is also the API's
 * `OWNERSHIP_TTL_MS` — so the server has genuinely dropped the agent and the
 * console must say so rather than keep a dead socket open.
 */
export const MISSED_PING_LIMIT = 3;

/**
 * The flap cap the ticket asks for. More than `FLAP_LIMIT` connects inside
 * `FLAP_WINDOW_MS` is not a connection to wait out, and retrying it forever is
 * the incident this whole change exists to stop: the console reconnects ~1/s,
 * the API supersedes and re-attaches at the same rate, and the agent strobes in and
 * out of the dialable pool while the screen looks busy but fine.
 *
 * **It counts one specific thing: a socket that PROVED liveness and then died.**
 * Not connect attempts. An earlier version counted every `connect()`, and two
 * reviews showed that was mis-targeted in both directions:
 *
 * - **It capped a healthy console during any outage over ~34 s.** Walking
 *   `BACKOFF_MS` from cold puts attempts at t = 0, 0.5, 1.5, 3.5, 8.5, 18.5 and
 *   33.5 s, so the seventh tripped it — and a rolling deploy, a pod restart or an
 *   LB drain all exceed 34 s. That parked every agent on the floor behind a
 *   manual click simultaneously, which is the opposite of a hook whose whole job
 *   is to survive a shift across wifi blips and an API deploy.
 * - **It could not see the only pattern that still loops fast.** Now that the
 *   ladder resets on a `pong` rather than on `open`, a socket that never proves
 *   liveness walks out to the 15 s ceiling on its own — the cadence decays and
 *   there is nothing to cap. What does NOT decay is a socket that pongs, dies,
 *   and pongs again: two windows duelling over one session reset each other's
 *   ladder to 500 ms forever. That is the shape this exists for.
 *
 * So the stamp is written in `scheduleRetry`, and only when the socket that just
 * died had answered a ping. Six such cycles in a minute is not a line to wait
 * out; an unreachable server never reaches the counter at all and keeps retrying
 * at the ceiling, so it self-heals the moment the server returns.
 */
export const FLAP_LIMIT = 6;
export const FLAP_WINDOW_MS = 60_000;

/**
 * A bound on the token mint, because `apiFetch` has none.
 *
 * `mintStationToken` is awaited inside `connect()`, and **both** safety nets live
 * inside `connect()` — so a request that hangs rather than rejecting left the hook
 * with no socket, no heartbeat, no pending retry and `connection: 'reconnecting'`,
 * which is the one state the rail deliberately offers no button in. A stuck
 * console recoverable only by reload is precisely the failure this whole change
 * set out to remove, so the mint gets a deadline and a rejection is a path the
 * retry ladder already knows how to walk.
 */
export const TOKEN_MINT_TIMEOUT_MS = 15_000;

/**
 * `promise`, or a rejection with `message` once `ms` pass — whichever is first.
 *
 * The deadline's timer is cleared the moment the race settles either way. It used
 * to be left running after the mint won, so every reconnect left a stray timer
 * behind, rejecting a promise nothing listened to any more.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Whether a ping we sent has gone unanswered for `MISSED_PING_LIMIT` heartbeat
 * intervals. `unansweredSince` is when the OLDEST unanswered ping went out, `0`
 * when nothing is outstanding — silence is only evidence when we have asked.
 *
 * ONE predicate for both of the heartbeat's decisions (hold a live call, give up
 * otherwise), so the hold and the give-up cannot drift apart.
 */
export function silentTooLong(unansweredSince: number, now: number, heartbeatMs: number): boolean {
  return unansweredSince !== 0 && now - unansweredSince >= MISSED_PING_LIMIT * heartbeatMs;
}

/**
 * Record one proven-live-then-died socket and say whether that makes a flap.
 *
 * Pruned to `FLAP_WINDOW_MS` on every pass, so the array cannot exceed the limit
 * and the count is honest. Called only for a socket that answered a ping — see
 * `FLAP_LIMIT` for why connect attempts are not what is counted.
 */
export function recordLiveThenDead(
  stamps: readonly number[],
  now: number,
): { stamps: number[]; flapping: boolean } {
  const recent = stamps.filter((at) => now - at < FLAP_WINDOW_MS);
  recent.push(now);
  return { stamps: recent, flapping: recent.length > FLAP_LIMIT };
}

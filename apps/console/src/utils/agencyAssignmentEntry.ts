/**
 * Whether to offer an agent the way into a campaign's station, and what to say
 * about a campaign that is not currently dialing.
 *
 * ── ADVISORY, and the first version was not advisory enough ────────────────
 * Core decides whether a join succeeds. This exists only so an agent is not sent
 * somewhere pointless, and so the list can say something true about a campaign
 * before they click.
 *
 * The first version refused `draft`, `paused`, `stopping`, `stopped` and
 * `completed`, on the stated grounds that an agent should not be "sent into a
 * refusal they could have been told about". **There is no such refusal.** Core's
 * `POST /sessions` (`magic-voice-core/src/api/routes/agency.routes.ts`) checks
 * campaign OWNERSHIP and nothing else — `campaign_not_running` is declared in its
 * contracts and raised nowhere — and it returns `campaign_status` in the bootstrap
 * so the console can render it. Joining a paused campaign has always worked: the
 * agent goes available and waits for their supervisor to resume.
 *
 * So the old behaviour was strictly worse than doing nothing. A supervisor pausing
 * for two minutes mid-shift locked every one of their agents out of the station
 * entirely, with a sentence telling them to wait for a supervisor who was already
 * standing at the console. The rule now:
 *
 *  - **`stopped` / `completed` block.** These are terminal — a stopped campaign
 *    cannot be restarted and a completed one has dialled everybody — so no call
 *    will ever arrive. Entering is not refused, it is *pointless*, and offering it
 *    invites an agent to sit on a dead station.
 *  - **Everything else goes through**, with a note where one helps. `draft`,
 *    `paused` and `stopping` are all states a campaign leaves, and an agent who
 *    wants to be ready when it does is behaving correctly.
 *
 * Two invariants carried over from the first version, both still load-bearing:
 *
 *  - **An unknown status must not block.** `campaign_status` is `null` whenever
 *    master's best-effort lookup failed. Blocking would let a thirty-second core
 *    blip lock a floor out of a running campaign.
 *  - **An UNRECOGNISED status must not block either.** Core owns the lifecycle and
 *    master forwards its value verbatim, so a status core adds arrives here before
 *    this file knows the word. The block list is therefore an ALLOW-LIST OF
 *    BLOCKS: named statuses block, everything else goes through and lets core
 *    answer.
 */

/**
 * The terminal statuses, and the reason each is a dead end.
 *
 * A `Map` rather than an object literal, because the key comes off the wire
 * unvalidated: an object literal is indexed through its prototype, so a campaign
 * whose status was the string `"toString"` or `"constructor"` would match
 * `Object.prototype` and this function would block entry and render a native
 * function as the reason. `Map` has no such keys. (`Object.hasOwn` would also fix
 * it; a `Map` makes the property structural rather than a check to remember.)
 */
const BLOCKED_REASONS = new Map<string, string>([
  ['stopped', 'Ended by a supervisor. It won’t start again.'],
  ['completed', 'Finished — every contact has been dialled.'],
]);

/**
 * Context for a campaign that is not dialing but will or might. Shown BESIDE the
 * way in, not instead of it — an agent may legitimately want to be at a station
 * before the campaign resumes.
 */
const WAITING_NOTES = new Map<string, string>([
  ['draft', 'Not started yet — your supervisor hasn’t launched it.'],
  ['paused', 'Paused right now. You can wait at the station for it to resume.'],
  ['stopping', 'Finishing up — no new calls are being made.'],
]);

export interface AssignmentEntry {
  /** Whether to render the "Enter station" control. */
  canEnter: boolean;
  /**
   * What to say about this campaign's state, or `null` when there is nothing to
   * add. Present in BOTH cases: when `canEnter` is false it is the reason there is
   * no control, and when true it is context beside one.
   */
  note: string | null;
}

export function assignmentEntry(status: string | null | undefined): AssignmentEntry {
  // Null, empty, and anything core added since this file was written.
  if (!status) return { canEnter: true, note: null };

  const blocked = BLOCKED_REASONS.get(status);
  if (blocked) return { canEnter: false, note: blocked };

  return { canEnter: true, note: WAITING_NOTES.get(status) ?? null };
}

/** Whether a station is worth offering, for callers that need only the boolean. */
export function canEnterStation(status: string | null | undefined): boolean {
  return assignmentEntry(status).canEnter;
}

import type { AgencyReleaseReason, AgencyStationReleasedFrame } from '../types/agency';

/**
 * What this table needs to produce copy: a reason and a fallback sentence.
 *
 * Structural rather than `AgencyStationReleasedFrame`, because the same words are
 * owed to a release the agent's socket was **not present to receive**
 * (`AgencyMissedRelease` on the `ready` frame). That type is deliberately not a
 * `released` frame — it carries no `event` and must never reach the live handler —
 * and copy is the one thing the two genuinely share. Widening here is what stops
 * the alternative: a second, drifting table for the reconnect case.
 */
export type ReleaseCopySource = Pick<AgencyStationReleasedFrame, 'reason' | 'message'>;

/**
 * Copy for every way an attempt can release the agent (UX §A.8.4).
 *
 * This is a table rather than inline JSX for two reasons. It is the entire
 * mitigation for "an agent whose screen clears with no explanation concludes
 * the app is broken" — which at volume is a support ticket per unanswered
 * call — and it must be exhaustively testable against the contract's union, so
 * a reason added in core surfaces as a compile error or a failing test rather
 * than as a blank panel.
 *
 * Two rules that constrain every entry:
 *  - **No reason ever renders a raw code.** Not in the rail, not in a tooltip.
 *  - **The shape is chosen by `requires_disposition`, never by the reason.**
 *    The reason picks the words; the boolean picks whether the panel stays.
 */

export type ReleaseTone = 'neutral' | 'warning' | 'danger';

export interface ReleaseCopy {
  headline: string;
  subtext: string;
  tone: ReleaseTone;
}

const COPY: Record<AgencyReleaseReason, ReleaseCopy> = {
  completed: { headline: 'Wrap-up', subtext: 'Call ended. Pick a disposition.', tone: 'neutral' },
  agent_hangup: { headline: 'Wrap-up', subtext: 'You ended the call.', tone: 'neutral' },
  remote_hangup: { headline: 'Wrap-up', subtext: 'The customer hung up.', tone: 'neutral' },
  no_answer: {
    headline: 'No answer',
    // "later" is deliberately vague — a specific time would sometimes be a lie,
    // because the retry policy depends on outcome and attempt count.
    subtext: "Nobody picked up. We'll try again later.",
    tone: 'neutral',
  },
  busy: {
    headline: 'Line busy',
    subtext: "The line was engaged. We'll try again later.",
    tone: 'neutral',
  },
  failed: {
    headline: "Couldn't connect",
    subtext: "The call didn't go through. We'll try again later.",
    tone: 'neutral',
  },
  invalid: {
    headline: 'Number not usable',
    subtext: "This number can't be dialled, so it's been taken off the list.",
    tone: 'neutral',
  },
  abandoned: {
    headline: 'Call dropped before you got it',
    subtext: "The customer answered but we couldn't connect you. This is logged.",
    tone: 'warning',
  },
  agent_disconnected: {
    headline: 'Call lost — your connection dropped',
    subtext: "Check your network. You'll need to go available again.",
    tone: 'danger',
  },
  reservation_expired: {
    headline: 'Call released',
    subtext: 'The call was reassigned before it went out. Nothing to do.',
    tone: 'neutral',
  },
  campaign_paused: {
    headline: 'Campaign paused',
    subtext: 'A supervisor paused the campaign. No new calls for now.',
    tone: 'warning',
  },
  campaign_stopped: {
    headline: 'Campaign stopped',
    subtext: 'This campaign has finished. You can leave the station.',
    tone: 'warning',
  },
  supervisor_released: {
    headline: 'A supervisor ended this call',
    subtext: "The call was taken off you. Ask your supervisor if you're unsure.",
    tone: 'warning',
  },
  orphaned: {
    headline: 'Call recovered',
    subtext: 'Something went wrong on our side and the call was cleaned up. Nothing you did.',
    tone: 'neutral',
  },
};

/**
 * Resolve copy for a release frame, falling back safely for a reason this build
 * does not know.
 *
 * The fallback is not decoration: core ships independently of the console, so an
 * unrecognised reason is *expected* traffic after a core deploy. It must still
 * produce a headline — an empty panel is the failure this table exists to
 * prevent — and the server's own `message` is the best available subtext.
 */
export function resolveReleaseCopy(frame: ReleaseCopySource): ReleaseCopy {
  const known = COPY[frame.reason as AgencyReleaseReason] as ReleaseCopy | undefined;
  if (known) return known;

  return {
    headline: 'Call ended',
    // Server text, rendered as TEXT and clamped by CSS to two lines. Never a
    // raw reason code — an agent should never be shown an enum.
    subtext: frame.message?.trim() || 'The call ended.',
    tone: 'neutral',
  };
}

/**
 * The one-line account of a release that **no wrap-up ever explained** (core `#290`).
 *
 * Core's wrap-up early return — taken when the disposition was already recorded
 * before the call ended, which is an ordinary agent habit — skips both the
 * `agent_state{wrapup}` frame and the `wrapup` frame. So the release copy above
 * never gets a wrap-up rail to render in, and the console's idle panel would show
 * the resting "Waiting for a call" as if the last call had never happened. Core's
 * own review notes name this and deliberately left it here rather than making core
 * emit a frame it has no state for.
 *
 * **This returns the server's own sentence, not a headline from the table above.**
 * Every headline there was written for the wrap-up rail — `remote_hangup` reads
 * "Wrap-up", and `completed`'s subtext says "Pick a disposition" — and both are
 * false on this path: there is no wrap-up and the disposition is already in.
 * `released.message` is what core actually sends (`releaseMessageFor`: "Call
 * ended.", "You ended the call.", "The customer hung up."), it is one sentence per
 * reason, and using it means the console explains itself from what it *receives*
 * rather than from a second table that can drift out of step with the first.
 *
 * Rendered as TEXT, never as markup, and never a raw reason code.
 */
export function releaseAccount(frame: ReleaseCopySource): string {
  return frame.message?.trim() || 'The call ended.';
}

/** True when this build recognises the reason. Drives the diagnostics warning. */
export function isKnownReleaseReason(reason: string): boolean {
  return Object.prototype.hasOwnProperty.call(COPY, reason);
}

/**
 * Whether the context panel stays up for a disposition, or dims and clears.
 *
 * Branches on `requires_disposition`, never on the reason — core decides
 * whether the call actually reached the agent, and it is the only side that
 * can know.
 */
export function releaseShape(frame: AgencyStationReleasedFrame): 'wrapup' | 'dim_and_clear' {
  return frame.requires_disposition ? 'wrapup' : 'dim_and_clear';
}

/**
 * Which lifecycle controls a campaign's state offers, and why the others are
 * refused (`MAG-134`).
 *
 * ── Refused, not absent ──────────────────────────────────────────────────────
 * Controls used to be *hidden* by state. Hiding does prevent the click, but it
 * answers a question the supervisor never asked and leaves the one they did ask
 * — "why can't I resume this?" — to be discovered by not finding a button. So a
 * control the state forbids is now rendered disabled beside its reason. The
 * alternative the spec rules out explicitly is worse than both: letting the
 * click through and reporting core's 409.
 *
 * ── Permission is different from state, and stays hidden ─────────────────────
 * A role without `agency.supervise` is not being told "not now" — it is being
 * told "not you", every time, on every campaign. That is a property of the
 * viewer, not of the campaign, so it hides the controls rather than papering the
 * page with eight refusals. Master's 403 is the enforcement either way.
 *
 * ── Terminal states offer nothing at all ─────────────────────────────────────
 * `stopped` and `completed` are over. Four disabled buttons under a finished
 * campaign is noise pretending to be information, and core has no transition out
 * of either — a stopped campaign cannot be restarted.
 */

import type { AgencyCampaignStatus } from '../types/agency-campaign';

/**
 * Narrows `AgencyCampaign.status` — deliberately `string` (core's CHECK
 * constraint is the authority, and `AgencyCampaignStatusBadge` renders an
 * unrecognised value verbatim rather than mapping it) — to the closed
 * `AgencyCampaignStatus` enum the analytics catalog (`analytics/events.ts`)
 * requires. Callers there skip the emit rather than pass a status this build
 * has never heard of.
 */
const KNOWN_CAMPAIGN_STATUSES: readonly AgencyCampaignStatus[] = [
  'draft',
  'running',
  'paused',
  'stopping',
  'completed',
  'stopped',
];

export function isKnownCampaignStatus(status: string): status is AgencyCampaignStatus {
  return (KNOWN_CAMPAIGN_STATUSES as readonly string[]).includes(status);
}

/**
 * HOW a campaign ended — and the two are not interchangeable.
 *
 * ── Why this is not a boolean ──────────────────────────────────────────────
 * Three surfaces used to derive a `terminal` flag by hand
 * (`status === 'stopped' || status === 'completed'`) and then write every
 * sentence behind it for `stopped`. On a campaign that ran its whole list —
 * the GOOD outcome — that produced a rail reading **"Stopped by:
 * Automatically"** under a badge reading **Completed**, which a supervisor
 * reads as "the dialer killed my campaign" and goes looking for the fault.
 *
 * The status badge already distinguishes them with care (`stopped` = ended by a
 * supervisor and cannot be restarted; `completed` = every contact was dialed or
 * exhausted its retries), so anything downstream that collapses them back into
 * one flag is discarding a distinction the screen has already made two inches
 * higher up.
 *
 * `null` is the live campaign, which is a third state and not a falsy version
 * of either.
 */
export type CampaignEnding = 'stopped' | 'completed';

/** {@link CampaignEnding} for a terminal campaign, or `null` while it is live. */
export function campaignEnding(status: string): CampaignEnding | null {
  if (status === 'stopped') return 'stopped';
  if (status === 'completed') return 'completed';
  return null;
}

/**
 * Whether the campaign has finished, either way.
 *
 * The single definition of "finished" in this repo. It exists because there were
 * three copies of the same expression and the series module had a FOURTH answer
 * — it keyed on `ended_at` alone, so a master that does not yet send the
 * lifecycle timestamps made a stopped campaign behave as a live one and told the
 * reader "today is still in progress" about a campaign that ended in July.
 */
export function isTerminalCampaignStatus(status: string | null | undefined): boolean {
  return campaignEnding(status ?? '') !== null;
}

/**
 * How the campaign's elapsed time should be SPOKEN about.
 *
 * `running` gets the present continuous, a terminal status gets the past, and
 * `paused` / `stopping` get neither — "Running for 6 hours" beside a **Paused**
 * badge and a Resume button is the same tense-contradicts-the-control failure
 * that `PAUSE_IN_FLIGHT_NOTE` exists to prevent one row higher up, and the clock
 * genuinely is not running on a paused campaign.
 *
 * `draft` and anything unrecognised fall to `none`: a campaign that has not
 * started has no elapsed time, and inventing a tense for a status this build has
 * never heard of is how a wrong sentence ships.
 */
export type CampaignTense = 'running' | 'held' | 'ended' | 'none';

export function campaignTense(status: string): CampaignTense {
  if (campaignEnding(status) !== null) return 'ended';
  if (status === 'running') return 'running';
  if (status === 'paused' || status === 'stopping') return 'held';
  return 'none';
}

export type AgencyCampaignAction = 'start' | 'pause' | 'resume' | 'stop';

export interface AgencyCampaignControl {
  action: AgencyCampaignAction;
  /** `null` ⇒ the control is live. Otherwise the sentence rendered beside it. */
  disabledReason: string | null;
}

/**
 * `stopping` is the state this whole helper exists for.
 *
 * `POST /stop` answers 200 with `stopping`, and only the pacing leader writes
 * `stopped`, once in-flight attempts drain. A supervisor watching a campaign
 * they just stopped is looking at `stopping` for as long as the longest live
 * call — long enough to reach for Resume and deserve an answer.
 */
const STOPPING_CONTROLS: AgencyCampaignControl[] = [
  {
    action: 'resume',
    disabledReason:
      'This campaign is stopping. Calls already connected are still finishing; it can’t be resumed, and it will move to Stopped on its own once they end.',
  },
  { action: 'stop', disabledReason: 'Already stopping.' },
];

const CONTROLS_FOR_STATUS: Record<string, AgencyCampaignControl[]> = {
  draft: [
    { action: 'start', disabledReason: null },
    { action: 'stop', disabledReason: null },
  ],
  running: [
    { action: 'pause', disabledReason: null },
    { action: 'stop', disabledReason: null },
  ],
  paused: [
    { action: 'resume', disabledReason: null },
    { action: 'stop', disabledReason: null },
  ],
  stopping: STOPPING_CONTROLS,
  stopped: [],
  completed: [],
};

/**
 * The controls to render for a status, in reading order.
 *
 * An unrecognised status returns nothing rather than guessing: a state this
 * build has never heard of is one whose transitions it cannot know, and
 * offering Start on it is a click that fails at the API — the exact outcome
 * `MAG-134` is about.
 */
export function agencyCampaignControls(status: string): AgencyCampaignControl[] {
  return CONTROLS_FOR_STATUS[status] ?? [];
}

/**
 * Whether this action is actually offered as live for `status`.
 *
 * The rendered buttons already hide or disable anything this returns false for
 * — this is the *click* half of the same rule. The page also re-reads before
 * POSTing Start / Resume, so a `campaignRef` that still says `draft` after
 * the campaign is `running` does not become core's 409. Returning false is
 * "do not send", not "the button is missing": MAG-134 then re-renders the
 * real controls.
 */
export function isLifecycleActionEnabled(status: string, action: AgencyCampaignAction): boolean {
  const control = agencyCampaignControls(status).find((entry) => entry.action === action);
  return control !== undefined && control.disabledReason === null;
}

/**
 * What pause actually does, said out loud.
 *
 * A supervisor pausing mid-campaign must not believe live calls were dropped.
 * Pause stops NEW calls; every call already connected runs to its natural end,
 * which is also why the counters keep moving afterwards and why `attempts_live`
 * stays non-zero for a while. Leaving that unsaid means the honest behaviour
 * reads as a bug, and — worse — a supervisor who thinks calls were cut may say
 * so to a customer who is still on one.
 */
export const PAUSE_IN_FLIGHT_NOTE =
  'Pausing stops new calls only. Calls already connected keep going until they end normally — nobody is cut off.';

/**
 * Whether that note belongs on screen.
 *
 * Shown while pausing is reachable AND while its consequences are still playing
 * out. On a `paused` campaign it is doing its second job: explaining why "Live
 * now" is not zero yet.
 */
export function showsPauseInFlightNote(status: string): boolean {
  return status === 'running' || status === 'paused';
}

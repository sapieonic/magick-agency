import type { AgencyCampaign, AgencyCampaignStats } from '../../../types/agency-campaign';
import {
  campaignTense,
  type CampaignEnding,
  type CampaignTense,
} from '../../agencyCampaignControls';
import { formatCount, plural } from '../../format/number';
import { dateFormatter, formatClockTime } from '../../format/date';
import { DASH } from './figure';

/*
  How the campaign ran and ended: its own settings restated, when it started,
  how long it ran and who stopped it. Out of `agencyCampaignOverview.ts`, which
  re-exports everything here.
*/

export interface HowItRanLine {
  label: string;
  value: string;
}

/**
 * The campaign's own settings, restated on the panel that asks what happened.
 *
 * These are the three that explain a number above them: a campaign that looks
 * idle at 7pm was outside its calling window, and a wrap-up allowance is the
 * difference between an agent being free and being on shift. They come off
 * `AgencyCampaign`, not off the stats payload, so they survive a terminal
 * campaign — which is the case this block was added for.
 *
 * A line whose field is absent is **omitted**, never rendered with a dash: the
 * campaign genuinely may not set a calling window, and "Calling window —" reads
 * as a failed read rather than as "dials at any hour".
 */
export function howItRanLines(campaign: AgencyCampaign | null): HowItRanLine[] {
  if (!campaign) return [];
  const lines: HowItRanLine[] = [];

  const start = campaign.calling_window_start;
  const end = campaign.calling_window_end;
  if (start && end) {
    lines.push({ label: 'Calling window', value: `${start}–${end}` });
  }

  if (campaign.default_timezone) {
    lines.push({ label: 'Timezone', value: campaign.default_timezone });
  }

  const wrapup = campaign.wrapup_seconds;
  if (typeof wrapup === 'number') {
    lines.push({ label: 'Wrap-up allowed', value: wrapupLabel(wrapup) });
  }

  return lines;
}

function wrapupLabel(seconds: number): string {
  if (seconds <= 0) return 'None';
  if (seconds < 60) return plural(seconds, 'second');
  const minutes = seconds / 60;
  return plural(Number(minutes.toFixed(1)), 'minute');
}

// ── The lifecycle: when it started, how long it ran, who stopped it ─────────
//
// `started_at`, `ended_at` and `last_transition_by`. The three of them
// are what let a TERMINAL campaign — the primary case for this workspace, not an
// edge of it — say anything at all about itself: without them a stopped campaign
// is a page of frozen counters with no answer to "when", "how long" or "who".
//
// Every function below tolerates all three being absent, because they are new on
// the campaign row and this console talks to whatever API is deployed. An
// absent line is OMITTED rather than dashed, for the reason `howItRanLines`
// states: "Started —" reads as a failed read, and on a campaign that genuinely
// never started it reads as a wrong one.

/** A parsed instant, or `null` for absent, null, or unparseable. */
function instant(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * A date and time, in one short phrase — `11 Aug, 09:00`.
 *
 * Not `formatDate` from `@magick-agency/web-ui/format`, which is date-only: the header line is
 * read beside "Updated 10:23" and a start with no clock on it invites the reader
 * to assume midnight. The display locale (`en-IN`) in the reader's own zone,
 * deliberately — this is a wall-clock fact about when somebody pressed a button, not a bucket boundary,
 * so unlike `bucket_start` it has no campaign zone to be cut in.
 */
function stamp(at: Date, now: Date): string {
  /*
    The YEAR appears only when the instant is not in the reader's current one.

    "How it ended" exists for campaigns that finished months ago — a terminal
    campaign is the primary case for this workspace, not an edge of it — and
    without the year "Stopped 18 Jan" is indistinguishable from last January's.
    Printing it unconditionally would put a redundant "2026" on every live
    campaign's header, which is the far commoner read, so it is conditional.
  */
  const sameYear = at.getFullYear() === now.getFullYear();
  const date = dateFormatter(
    sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' },
  ).format(at);
  return `${date}, ${formatClockTime(at)}`;
}

/**
 * How long a campaign has been going, at campaign scale.
 *
 * ── Why not `agentDurationLong` ────────────────────────────────────────────
 * That one tops out at hours, which is right for what it measures — a shift, a
 * handle time, a wrap-up — and wrong here by an order of magnitude: a campaign
 * that ran four days would read `97h`, a number a supervisor has to divide by 24
 * in their head before it means anything. Days are the unit a campaign's life is
 * quoted in, so days are the unit this leads with.
 *
 * Two components at most, largest first, and a zero component is dropped rather
 * than padded — `3 days` rather than `3 days 0 hours`. A campaign is being given
 * a magnitude, not read a clock.
 */
export function campaignRunLength(seconds: number): string {
  /*
    `Math.round(NaN)` is `NaN` and `Math.max(0, NaN)` is `NaN`, so an
    unparseable input fell through every branch below and rendered the literal
    string "NaN minutes". Nothing upstream can produce it today — `instant()`
    guards the parse — but a duration is one edit away from being handed a
    subtraction involving an invalid date.
  */
  if (!Number.isFinite(seconds)) return DASH;
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return plural(total, 'second');

  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);

  if (days > 0) return hours > 0 ? `${plural(days, 'day')} ${plural(hours, 'hour')}` : plural(days, 'day');
  if (hours > 0) {
    return minutes > 0 ? `${plural(hours, 'hour')} ${plural(minutes, 'minute')}` : plural(hours, 'hour');
  }
  return plural(minutes, 'minute');
}

/**
 * How {@link CampaignTimeline.ran} opens, per tense.
 *
 * "Live for" rather than "Running for" on a held campaign: it says the campaign
 * has existed that long without claiming the dialer is working, which is exactly
 * the distinction a supervisor who just pressed Pause is checking. `none` is
 * unreachable through `ran` — a campaign with no `started_at` has no duration —
 * and is present so the record is exhaustive rather than defaulted.
 */
const RAN_PREFIX: Record<CampaignTense, string> = {
  running: 'Running for',
  held: 'Live for',
  ended: 'Ran for',
  none: 'Live for',
};

export interface CampaignTimeline {
  /** `Started 11 Aug, 09:00`, or `null` when we were not told. */
  started: string | null;
  /**
   * `Ran for 3 days 4 hours` on a finished campaign, `Running for 6 hours` on a
   * live one, or `null` without a start.
   *
   * The tense is the whole difference and it is decided here rather than in a
   * component: a live campaign's duration is a number that is still moving, and
   * "Ran for" beside a Stop button is a sentence that contradicts the button.
   */
  ran: string | null;
  /** `Stopped 14 Aug, 18:30`, or `null` while it is still live. */
  ended: string | null;
  /**
   * The same three facts as bare VALUES, for the rail, which supplies its own
   * labels.
   *
   * Two shapes of one derivation rather than two derivations: the header reads
   * as prose beside "Updated 10:23" and the rail as a label/value list, and
   * having the rail strip a prefix back off the header's sentence — which is
   * what this did first — is a formatting decision hidden inside a regex.
   */
  duration: string | null;
  endedStamp: string | null;
  /**
   * `Priya Sharma`, or `Automatically`, or `null`.
   *
   * **`last_transition_by: null` is not an absence** — it is the server saying nobody
   * did this, which on a campaign that hit the abandonment ceiling is the single
   * most useful sentence on the page. So it reads "Automatically" rather than
   * being dropped. Only an ABSENT field (an older API) drops the line, and
   * only because this console then has nothing to say either way.
   */
  actor: string | null;
  /** True when `started_at` came back explicitly `null` on a terminal campaign. */
  neverStarted: boolean;
}

/**
 * The campaign's own clock, as sentences.
 *
 * `now` is a parameter for the reason `periodRange`'s is: every boundary — a
 * campaign that started ninety seconds ago, one whose `ended_at` precedes its
 * `started_at` because two clocks disagree about the time — becomes a test
 * rather than something to reason about.
 *
 * `terminal` is passed in rather than re-derived from `campaign.status`, because
 * the page above already decides it once and two definitions of "finished" on
 * one screen is exactly the drift `isKnownCampaignStatus` exists to prevent.
 */
export function campaignTimeline(
  campaign: AgencyCampaign | null,
  ending: CampaignEnding | null,
  now: Date,
): CampaignTimeline {
  const terminal = ending !== null;
  /*
    The TENSE comes from the real status, not from "is it terminal?". A paused
    campaign is neither running nor ended, and it was falling through to the live
    arm — so the header read "Running for 6 hours" beside a Paused badge and a
    Resume button.
  */
  const tense: CampaignTense = terminal
    ? 'ended'
    : campaignTense(campaign?.status ?? '');
  const started = instant(campaign?.started_at);
  const ended = instant(campaign?.ended_at);
  const rawActor = campaign?.last_transition_by;

  const endedStamp = ended ? stamp(ended, now) : null;
  /*
    ── `completed` and `stopped` are not the same event ──────────────────────
    Everything behind the old `terminal` boolean was worded for `stopped`, so a
    campaign that ran its whole list — the GOOD outcome, badged "Completed" two
    inches above — was told "Stopped 14 Aug" and "Stopped by Automatically". A
    supervisor reads that as the dialer having killed their campaign and goes
    looking for a fault that does not exist. The badge already distinguishes the
    two with care; collapsing them back into one flag threw that away.
  */
  const verb = ending === 'completed' ? 'Finished' : 'Stopped';
  /*
    `undefined` is "this API did not carry the field" and says nothing;
    `null` is the server saying the transition had no human behind it, which is a fact
    worth a line. See the field's own note. An actor with a `null` name is an
    id-only caller, and the id is what there is to render.
  */
  /*
    A `completed` campaign was not stopped BY anybody — it ran out of list — so
    naming an actor for it is a fabrication, and naming "Automatically" is the
    specific fabrication that reads as a fault. Only a `stopped` campaign has an
    ender worth reporting.
  */
  const actor =
    ending !== 'stopped' || rawActor === undefined
      ? null
      : rawActor === null
        ? 'Automatically'
        : (rawActor.name ?? rawActor.user_id);

  const base: CampaignTimeline = {
    started: null,
    ran: null,
    ended: null,
    duration: null,
    endedStamp,
    actor,
    neverStarted: terminal && campaign?.started_at === null,
  };

  if (!campaign || !started) {
    return { ...base, ended: endedStamp && terminal ? `${verb} ${endedStamp}` : null };
  }

  /*
    An end before the start is not a duration. Two writers stamping two clocks
    is enough to produce it, and "Ran for -4 hours" is worse than saying nothing
    — so the duration is dropped and the two stamps, which are still facts, stay.
  */
  const until = ended && ended.getTime() >= started.getTime() ? ended : terminal ? null : now;
  /*
    A start in the FUTURE gets the same treatment as an end before a start, and
    for the same reason — both are clock skew. Without this
    `campaignRunLength` clamped the negative to zero and the header read "Running
    for 0 seconds" on a campaign that has been dialing all morning.

    `until === started` is left alone: a campaign that started and stopped in the
    same instant really did run for no time, and that is a measurement.
  */
  const elapsedMs = until ? until.getTime() - started.getTime() : null;
  const duration = elapsedMs !== null && elapsedMs >= 0
    ? campaignRunLength(elapsedMs / 1000)
    : null;

  return {
    ...base,
    started: `Started ${stamp(started, now)}`,
    duration,
    ran: duration === null ? null : `${RAN_PREFIX[tense]} ${duration}`,
    ended: endedStamp && terminal ? `${verb} ${endedStamp}` : null,
    neverStarted: false,
  };
}

/**
 * The terminal rail's "How it ended" block.
 *
 * Only ever rendered on a campaign that has stopped, and it is the block that
 * gives that campaign a right-hand column at all — the rail used to be removed
 * entirely once a campaign was terminal, which is what left the page one narrow
 * column with a screen of white beside it.
 *
 * Returns `[]` when there is nothing to say, so the caller can skip the whole
 * block rather than render a heading over an empty list.
 */
export function howItEndedLines(
  campaign: AgencyCampaign | null,
  stats: AgencyCampaignStats | null,
  ending: CampaignEnding,
  now: Date,
): HowItRanLine[] {
  const timeline = campaignTimeline(campaign, ending, now);
  const lines: HowItRanLine[] = [];

  if (timeline.neverStarted) {
    // "Ran for — Never started" is not a sentence. The label carries the subject
    // so the value can be the answer.
    lines.push({ label: 'Dialing', value: 'Never started' });
  } else if (timeline.duration) {
    lines.push({ label: 'Ran for', value: timeline.duration });
  }

  if (timeline.endedStamp) {
    lines.push({ label: ending === 'completed' ? 'Finished' : 'Stopped', value: timeline.endedStamp });
  }
  // Only ever present on a `stopped` campaign — see `campaignTimeline`.
  if (timeline.actor) lines.push({ label: 'Stopped by', value: timeline.actor });

  /*
    ── `agents_peak` ─────────────────────────────────────────────────────────
    Read exactly once, here. A stopped campaign's live floor is always empty, so
    `agents_live` can never answer "was anyone ever on this" — and that is the
    question behind every stopped campaign whose contacts are still pending.

    `null` means NOT MEASURED (an older the server, or a campaign predating the agent
    event log) and is dropped, never rendered as `0`. A `0` the server actually
    measured is kept: "nobody was ever at a station" is the finding, and it is
    the one this line exists for.
  */
  const peak = stats?.agents_peak;
  if (typeof peak === 'number') {
    lines.push({
      label: 'Agents who worked it',
      // "None", not "Nobody": it reads as a count in a column of counts, which
      // is what keeps a measured zero visibly different from an absent field.
      value: peak === 0 ? 'None' : formatCount(peak),
    });
  }

  return lines;
}

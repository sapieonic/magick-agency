import { durationWords, statClock } from '../format/duration';
import { formatCount, pct as formatPct } from '../format/number';
import type { AgencyAgentStatsTotals } from '../../types/agency-stats';
import type { PerformanceReadout } from '../agencyCampaignPerformance';

/*
  The per-agent surface's figures and readouts: the shared percentage, duration
  and count renderings the roster and best-hours modules also use, the headline
  trio, and the conversion / handle-time / wrap-up readouts. Out of
  `agencyAgentPerformance.ts`, which re-exports everything here.
*/

/**
 * One decimal, trailing zero trimmed — `pct` in `format/number.ts`, the one
 * rendering every analytics surface uses, so one product never prints `18%` on
 * one screen and `18.0%` on the next. Kept under this name for the roster,
 * best-hours and contribution modules that import it from here.
 */
export function agentPct(value: number): string {
  return formatPct(value);
}

/**
 * An aggregate duration in seconds as `m:ss`, rolling to `h:mm:ss`, ROUNDED to
 * the nearest second (`statClock`). A real `0` renders `0:00`.
 *
 * Exported alongside {@link agentPct} for the same reason: the roster table shows
 * the same figures one level up (a column of handle times against a cohort's) and
 * a second `toFixed(1)` or a second duration format would let one product print
 * `18%` on one screen and `18.0%` on the next — or `1:05` beside `65s`. It
 * rounds, like {@link agentDurationLong}, so a served 59.6s AHT reads `1:00` in
 * the cell and `1m` in the band beside it — it used to floor to `0:59`.
 */
export function agentSeconds(value: number): string {
  return statClock(value);
}

/**
 * The same duration with its UNITS said out loud — `1m 14s`, `31h 40m`.
 *
 * ── Why a second duration format exists at all ────────────────────────────
 * {@link agentSeconds} is a stopwatch, which is right in a numeric CELL: the
 * column is right-aligned and tabular, every value has the same shape, and a
 * reader scanning it is comparing lengths rather than reading quantities. It
 * fails in PROSE, and it fails worst on exactly the figures that matter most:
 * pooled over a 200-agent floor the utilisation basis read
 * `4800:00:00 handled of 8000:00:00 on shift`, a stopwatch expressing five-figure
 * hours on the line most likely to be quoted in a pay review, and the team row's
 * handling-time band read `median 22:00`, distinguishable from twenty-two HOURS
 * only by counting colons.
 *
 * So the rule this codebase now holds is: **cells keep the stopwatch, sentences
 * name the unit.** Both come from one module (`format/duration.ts`), and both
 * round, so neither can drift.
 *
 * Seconds are dropped once there is an hour, and a zero component is omitted
 * rather than padded — `2h` rather than `2h 0m`, because the reader is being told
 * a magnitude, not read a clock.
 */
export function agentDurationLong(value: number): string {
  return durationWords(value);
}

/**
 * A count, thousands-separated.
 *
 * Deliberately not `format.ts`'s number helper, which collapses `0`, `null` and
 * `undefined` into one `'--'`. On this page those are three different facts and
 * a zero dial count is a true one.
 */
export function agentCount(value: number | undefined): string {
  return typeof value === 'number' ? formatCount(value) : '—';
}

// ─── The headline trio ───────────────────────────────────────────────────────

/** One of the three headline figures, in the order they are read. */
export interface HeadlineFigure {
  key: 'attempts' | 'connect_rate' | 'connected';
  label: string;
  /**
   * What the label means, in one short clause. **Rendered**, not advisory.
   *
   * It was populated here and read by nothing for the whole life of the feature,
   * so an agent saw a bare `Dials · Connect rate · Conversations` while their
   * supervisor's campaign screens explained every one of their own figures — with
   * the person being measured the one left guessing. `AgentPerformancePanel`
   * renders these as a definition list beneath the tiles.
   */
  hint: string;
  value: string;
  /** False when {@link value} is a stand-in for an absent measurement. */
  known: boolean;
}

/**
 * Dials · connect rate · conversations — always all three, always in that order.
 *
 * The middle figure is the rate rather than a derived total on purpose: with the
 * denominator on its left and the numerator on its right, the rate cannot be
 * read as a fourth independent number. Collapsing any of the three into a single
 * "calls" figure is the thing this function exists to make impossible at every
 * call site.
 */
export function headlineTrio(totals: AgencyAgentStatsTotals | undefined): HeadlineFigure[] {
  const rate = totals?.connect_rate_pct;
  return [
    {
      key: 'attempts',
      label: 'Dials',
      /*
        "Calls placed TO you" was backwards, and backwards in the one way that
        matters on this screen: this is an outbound predictive dialer. The server places
        the dial to a CUSTOMER and reserves an agent onto it — nothing is placed to
        the agent — so an agent reading the old clause would reasonably conclude
        the tile was counting calls that came in.
      */
      hint: 'Calls the dialer placed and handed to you, whether or not anyone picked up.',
      value: agentCount(totals?.attempts),
      known: typeof totals?.attempts === 'number',
    },
    {
      key: 'connect_rate',
      label: 'Connect rate',
      hint: 'How often a dial reached a person.',
      // `null` is "nobody has been dialled yet", which is not a 0% connect rate:
      // a dial that never happened has not failed to reach anybody.
      value: rate === undefined ? '—' : rate === null ? 'Not measured yet' : agentPct(rate),
      known: typeof rate === 'number',
    },
    {
      key: 'connected',
      label: 'Conversations',
      hint: 'Dials where you actually spoke to someone.',
      value: agentCount(totals?.connected),
      known: typeof totals?.connected === 'number',
    },
  ];
}

// ─── The derived readouts ────────────────────────────────────────────────────

/** What a served readout says in each of its three states. */
interface ServedCopy {
  /** The field did not arrive — `undefined`. */
  missing: string;
  /** The server carried it and has nothing to measure — `null`. Without it, `null` reads as missing. */
  unmeasured?: string;
  /** The figure is real. */
  measured: string;
}

/**
 * One readout off one served figure, in this module's three-way rule: `undefined`
 * is an em dash and "didn't load", `null` is "Not measured yet" and a sentence
 * naming what has not happened, and only a number is a claim — formatted, and
 * `known: true`. The readouts below were that ladder written out three times.
 */
function servedReadout(
  value: number | null | undefined,
  copy: ServedCopy,
  format: (value: number) => string,
  secondary: string | null = null,
): PerformanceReadout {
  if (typeof value === 'number') {
    return { value: format(value), detail: copy.measured, caveat: null, secondary, known: true };
  }
  if (value === null && copy.unmeasured !== undefined) {
    return { value: 'Not measured yet', detail: copy.unmeasured, caveat: null, secondary, known: false };
  }
  return { value: '—', detail: copy.missing, caveat: null, secondary, known: false };
}

/**
 * Conversion rate — successes over **conversations**, not over dials.
 *
 * The denominator is the entire meaning of this number and the two readings are
 * nowhere near each other: a fifth of your conversations is a strong day, a
 * fifth of your dials is not a thing that happens. So the label and the detail
 * both name the denominator rather than leaving "conversion rate" to be read
 * against whichever number is nearest on screen.
 */
export function agentConversionReadout(
  totals: AgencyAgentStatsTotals | undefined,
): PerformanceReadout {
  const successes = totals?.successes;
  return servedReadout(
    totals?.success_rate_pct,
    {
      missing: 'Your conversion rate didn’t load.',
      unmeasured: 'You haven’t had a conversation to convert yet.',
      measured: 'Calls that counted as a win, out of the ones where you spoke to someone — not out of every dial.',
    },
    agentPct,
    typeof successes === 'number' ? `${formatCount(successes)} counted` : null,
  );
}

/** Average handle time. `null` is "no call has finished", never a fast shift. */
export function agentHandleTimeReadout(
  totals: AgencyAgentStatsTotals | undefined,
): PerformanceReadout {
  const talk = totals?.talk_seconds;
  return servedReadout(
    totals?.aht_seconds,
    {
      missing: 'Your average call length didn’t load.',
      unmeasured: 'No call of yours has finished in this period, so there is nothing to average.',
      measured: 'Your average time on a call, from the moment you and the customer were joined.',
    },
    agentSeconds,
    typeof talk === 'number' ? `${agentSeconds(talk)} on calls in total` : null,
  );
}

/**
 * Total wrap-up.
 *
 * A SUM rather than an average, and unlike the supervisor's wrap-up readout it
 * is not measured against the campaign's configured window. An agent working two
 * campaigns has two windows, so "against the 45s you're allowed" would be false
 * for at least one of them — and the tuning decision the supervisor's version
 * feeds is not one an agent can act on anyway.
 */
export function agentWrapupReadout(totals: AgencyAgentStatsTotals | undefined): PerformanceReadout {
  return servedReadout(
    totals?.wrapup_seconds,
    {
      missing: 'Your wrap-up time didn’t load.',
      measured: 'Time spent writing calls up after the customer hung up.',
    },
    agentSeconds,
  );
}

// ─── Occupancy ───────────────────────────────────────────────────────────────

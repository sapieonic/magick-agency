import { formatDuration } from './agencyClock';
import type { AgencyCampaignStats } from '../types/agency-campaign';

/**
 * The derived figures — connect rate, conversion, handle time, wrap-up, the
 * human/machine/unclassified split, and what one handled call costs — as pure
 * functions.
 *
 * Same reasoning as `agencyHealthStrip`: every sentence below is a claim about
 * the campaign derived from the payload, and a derivation is a place to be
 * confidently wrong. They are tested rather than eyeballed.
 *
 * ── Which figure is the headline ───────────────────
 * **The human connect rate is the headline, and the split is its drill-down.**
 *
 * The choice is not this console's to make and is not being made here — the server
 * made it on the wire. `connect_rate_pct` is `human_connects / attempts_total`,
 * with voicemails and never-written-up calls both outside the numerator. This
 * module renders that number as the headline and puts all three buckets
 * underneath it, so the figure a supervisor quotes is the one the server computed and
 * the buckets explain what it excluded. Re-deriving a blended rate here — even
 * as a "total connects" convenience — would produce a second, different connect
 * rate for the same campaign, which is the state the split exists to prevent.
 *
 * ── Three ways a number can be absent, and they read differently ────────────
 * 1. **`undefined`** — the payload did not carry the field. An em dash and
 *    "didn't load". Never 0.
 * 2. **`null`** — the server carried it and has nothing to measure. "No data" and a
 *    sentence naming what has not happened yet.
 * 3. **A real `0`** — rendered as `0`. This is the only case that is a claim
 *    about the campaign, and it is the case the other two must not be confused
 *    with. `formatDuration` is used rather than `format.ts`'s, which collapses
 *    `0`, `null` and `undefined` into one `'--'`.
 *
 * There is now a fourth, and it is the only one that is a decision of this
 * console's rather than a reading of the server's: see {@link RATE_MIN_ATTEMPTS}.
 *
 * ── The caveat that outranks the number ─────────────────────────────────────
 * `machine_connects_available === false` means this campaign's disposition
 * catalog has no `voicemail` code. An agent cannot submit a code they are not
 * offered, so `machine_connects` is structurally 0 — and, less obviously, every
 * voicemail is then sitting inside the handle-time average, because the server
 * excludes calls *labelled* voicemail rather than calls that *were* voicemail.
 * Both figures need saying out loud, or the console reports a clean campaign
 * with a fast AHT when what it has is a campaign that is not asking.
 *
 * ── Every scale on this surface is stated here, not drawn by the component ──
 * A meter is an assertion about proportion, so the fraction is derived and
 * tested beside the number it qualifies rather than computed inline in JSX.
 * The rule the shapes below enforce: **a figure with no denominator gets no
 * percentage meter.** Handle time has no ceiling to be a fraction of, so it
 * gets a `compare` scale against its own sibling average instead of a bar
 * filled to an arbitrary share of nothing.
 */

/**
 * The floor under which a percentage is withheld rather than printed.
 *
 * A rate is the one figure on this screen that leaves the room. "We're
 * converting a third of our conversations" is repeated in a stand-up, written
 * into a weekly summary, and used to decide whether a list is worth buying
 * again — and over a handful of dials it is noise wearing a decimal point. At
 * eight dials one extra answer moves the connect rate twelve points, so the
 * number a supervisor quotes on Tuesday is a different number on Wednesday for
 * reasons that have nothing to do with the campaign.
 *
 * Withholding is therefore not caution about our arithmetic — the arithmetic is
 * the server's and it is exact. It is a refusal to present a figure with the settled
 * air of a measurement when the next call can still move it several points.
 *
 * Applied to the two RATES only. Handle time and wrap-up are averages over
 * completed calls: a mean of four calls is a weak mean, but it is not a
 * proportion, it does not get quoted as a percentage, and an average that says
 * "3:14 over four calls" is a fact a supervisor can already discount.
 *
 * Keyed on `attempts_total` — dials placed — for both rates. The conversion
 * rate's own denominator is connected calls, which is necessarily smaller, so
 * gating it on dials is the looser of the two available tests: a campaign with
 * enough dials to publish a connect rate may still have very few conversations
 * behind its conversion rate. That is what the denominator line on the card is
 * for, and it is why the line is not optional.
 */
export const RATE_MIN_ATTEMPTS = 25;

/**
 * The line under a figure naming what it was measured against.
 *
 * Split into a lead and the rest because the numerator is read at the weight of
 * the headline and the denominator is not: `**431** of 2,104 connected calls`.
 * `lead` is `null` for a line that names no count of its own.
 */
export interface ReadoutDenominator {
  lead: string | null;
  rest: string;
}

/** One bar of a {@link ReadoutScale} comparison. */
export interface ReadoutBar {
  label: string;
  /** 0–100, a share of the larger bar in the pair. */
  percent: number;
  /** Drawn at reduced opacity — the figure being compared against, not the figure. */
  muted: boolean;
}

/**
 * The scale drawn beneath a figure, or `null` for a figure that has none.
 *
 * `fill` is a share of a real denominator. `ceiling` is a share of a configured
 * allowance, with the allowance marked. `compare` is two figures against each
 * other, which is the only honest scale available to a duration that has no
 * ceiling.
 */
export type ReadoutScale =
  | { kind: 'fill'; percent: number; tone: 'accent' | 'teal' }
  | { kind: 'ceiling'; percent: number }
  | { kind: 'compare'; bars: ReadoutBar[] };

/** One derived figure, ready to render. */
export interface PerformanceReadout {
  value: string;
  detail: string;
  /**
   * A sentence that changes how the number should be read, or `null`.
   *
   * Rendered at the same weight as the number rather than as a tooltip: a
   * caveat a supervisor has to hover to find is a caveat they will quote the
   * number without.
   */
  caveat: string | null;
  /**
   * The flat second line — a sentence set beside the figure.
   *
   * **This shape is shared.** `agencyAgentPerformance.ts` builds
   * `PerformanceReadout`s for the per-agent surface and `AgentPerformancePanel`
   * renders them, and that surface has no denominators to state and no scales to
   * draw. So `secondary` stays, and the two fields below are optional rather
   * than required: a readout that has only a sentence is a legitimate readout,
   * and forcing every producer to declare `denominator: null, scale: null` would
   * make an unrelated file carry this section's redesign.
   *
   * The campaign readouts in this module produce {@link denominator} instead,
   * because a count-bearing denominator is the whole point of the line here.
   */
  secondary?: string | null;
  /**
   * What the figure is measured against — the card's second line.
   *
   * This is the field the campaign component renders under the `-secondary` test
   * id, and it is deliberately not decoration: the two rates on this payload
   * have different denominators, and a percentage that does not name its own is
   * the single way this row can mislead.
   */
  denominator?: ReadoutDenominator | null;
  /** The proportion drawn beneath the denominator line, or `null`. */
  scale?: ReadoutScale | null;
  /** True only when a real measurement is behind {@link value}. */
  known: boolean;
}

function pct(value: number): string {
  // Matches `agencyHealthStrip`: one decimal, trailing zero trimmed. "3.0%"
  // reads as a measurement with false precision the denominator cannot support.
  return `${Number(value.toFixed(1))}%`;
}

/** Whole seconds as `m:ss`, rolling to `h:mm:ss`. `0` renders as `0:00`. */
function seconds(value: number): string {
  return formatDuration(value * 1000);
}

function plural(n: number, singular: string, many = `${singular}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? singular : many}`;
}

/** A meter is never drawn outside its own track. */
function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/**
 * Whether voicemail is measurable **going forward**.
 *
 * The server computes this against the campaign's *current* `disposition_catalog`, so
 * it describes what an agent can submit from now on — not what the history
 * contains. See {@link voicemailWithdrawn}, which is the case that distinction
 * creates.
 *
 * `undefined` is treated as measurable — it means an older the server that did not
 * send the flag, and asserting "voicemail is not being recorded" on a payload
 * that never spoke to the question would be inventing the more alarming of two
 * readings. The flag's job is to suppress a false zero, not to manufacture a
 * warning.
 */
function voicemailMeasured(stats: AgencyCampaignStats | null): boolean {
  return stats?.machine_connects_available !== false;
}

/**
 * Voicemail **used to be** recordable on this campaign and no longer is.
 *
 * `disposition_catalog` is patchable on a live campaign (the server's
 * `agencyCampaignRepository.update` allows it, and `PATCH /agency-campaigns/:id`
 * forwards it), and the server's counts read the *historical* `disposition_code` on
 * each attempt while the availability flag reads the *current* catalog. Remove
 * the code from a campaign that has already recorded voicemails and the two
 * disagree: `machine_connects` stays truthfully non-zero, `aht_seconds` still
 * genuinely excludes those calls, and the flag says `false`.
 *
 * Treating that as "voicemail was never measured" is the worst reading of the
 * three available. It would blank a real count, claim no voicemails happened,
 * and simultaneously claim they are inside the handle-time average — all at the
 * moment an operator has just changed the setting and is most likely to be
 * checking what it did.
 */
function voicemailWithdrawn(stats: AgencyCampaignStats | null): boolean {
  return !voicemailMeasured(stats) && (stats?.machine_connects ?? 0) > 0;
}

/**
 * Dials placed, or `null` when the payload did not say.
 *
 * `null` is **not** treated as "too few". An older payload that never carried
 * the counter has not told us the campaign is small, and suppressing a rate on
 * a campaign that may have dialled ten thousand contacts would withhold the
 * screen's most-read figure on the strength of a missing field.
 */
function dialsPlaced(stats: AgencyCampaignStats | null): number | null {
  const total = stats?.attempts_total;
  return typeof total === 'number' ? total : null;
}

/** True when {@link RATE_MIN_ATTEMPTS} says no percentage may be printed. */
export function ratesWithheld(stats: AgencyCampaignStats | null): boolean {
  const dials = dialsPlaced(stats);
  return dials !== null && dials < RATE_MIN_ATTEMPTS;
}

/**
 * The shared withheld readout, so both rates say the same thing in the same
 * words. `known: false`, because nothing is being reported — it dims exactly as
 * a failed read does, and for the same reason: this is not a bad number, it is
 * the absence of one.
 */
function volumeWithheldReadout(dials: number): PerformanceReadout {
  return {
    value: 'Not enough dials',
    detail:
      `Rates are withheld below ${RATE_MIN_ATTEMPTS} dials placed. Over a handful of calls a `
      + 'percentage moves several points with every answer, and it is the kind of figure that '
      + 'gets quoted.',
    caveat: null,
    denominator: {
      lead: dials.toLocaleString(),
      rest: dials === 1 ? 'dial placed so far' : 'dials placed so far',
    },
    scale: null,
    known: false,
  };
}

/**
 * The connect rate — human answers over every call placed.
 *
 * The denominator is `attempts_total`, not bridged calls, which is why this is
 * low on a cold list and why it is the right number: a supervisor asking "is
 * this list working" is asking about dials, not about the subset that connected.
 */
export function connectRateReadout(stats: AgencyCampaignStats | null): PerformanceReadout {
  const rate = stats?.connect_rate_pct;
  const unclassified = stats?.unclassified_connects;
  /*
    ── The numerator of THIS rate, and it is not `attempts_connected` ─────────
    `connect_rate_pct` is `human_connects / attempts_total` — the type says so in
    as many words. The denominator line below used to lead with
    `attempts_connected`, a wider population (human + machine + unclassified), so
    the card rendered a fraction that does not equal its own headline:

        Connect rate
        22.4%
        2,104 of 6,742 dials placed          ← 2,104 / 6,742 = 31.2%

    and the split card directly beneath it then said "Where the 2,104 connected
    calls went — Spoke to a person 1,509 …", so one panel asserted both that
    2,104 people answered and that 1,509 did. A supervisor either stops trusting
    the panel or quotes the wrong number into a review.

    This is the rule `agencyCampaignOverview` states for the pulse strip —
    a percentage must sit with its own numerator — applied to the card that
    was breaking it.
  */
  const humans = stats?.human_connects;
  const total = stats?.attempts_total;

  if (rate === undefined) {
    return {
      value: '—',
      detail: 'The connect rate didn’t load.',
      caveat: null,
      denominator: null,
      scale: null,
      known: false,
    };
  }
  // The server's null is "no attempts placed", which is not a 0% connect rate. A
  // campaign that has not dialed anyone has not failed to reach anyone.
  if (rate === null) {
    return {
      value: 'No data',
      detail: 'No calls have been placed on this campaign yet.',
      caveat: null,
      denominator: null,
      scale: null,
      known: false,
    };
  }
  // Checked after the two absences and before anything is formatted: "the read
  // failed" and "the server has nothing to measure" are facts about the payload and
  // outrank a policy of ours about how much evidence is enough.
  const dials = dialsPlaced(stats);
  if (dials !== null && dials < RATE_MIN_ATTEMPTS) return volumeWithheldReadout(dials);

  // Priority: the structural caveat outranks the incidental one. If voicemail
  // cannot be labelled at all, saying "12 calls weren't written up" points at
  // the agents for something the campaign's configuration caused.
  let caveat: string | null = null;
  if (voicemailWithdrawn(stats)) {
    caveat =
      'Voicemail has been removed from this campaign’s disposition list, so answering '
      + 'machines reached since then can end up counted as people. Read this rate as '
      + 'approximate from that point on.';
  } else if (!voicemailMeasured(stats)) {
    caveat =
      'This campaign’s disposition list has no voicemail code, so answering machines '
      + 'can’t be told apart from people. Read this rate as approximate.';
  } else if (typeof unclassified === 'number' && unclassified > 0) {
    caveat =
      `${plural(unclassified, 'connected call was', 'connected calls were')} never written up, `
      + 'so they don’t count towards this rate.';
  }

  return {
    value: pct(rate),
    detail: 'Calls where a person answered, out of every call placed — including the ones nobody picked up.',
    caveat,
    denominator:
      typeof humans === 'number' && typeof total === 'number'
        ? {
          lead: humans.toLocaleString(),
          // Names what the number IS, not just what it is out of: "2,104 of
          // 6,742" beside a split card counting 1,509 people is two numbers for
          // one concept with nothing saying which is which.
          rest: `people answered, of ${total.toLocaleString()} dials placed`,
        }
        : null,
    scale: { kind: 'fill', percent: clampPercent(rate), tone: 'accent' },
    known: true,
  };
}

/**
 * Conversion rate — successes over **connected calls**, not over dials.
 *
 * ── Why the label carries the denominator ──────────────────────────────────
 * This page already shows a `Connect rate` measured over ATTEMPTS. Putting a
 * second percentage beside it with no denominator named invites the reader to
 * assume the same one, and the two readings are nowhere near each other: a fifth
 * of your conversations converting is a strong campaign, a fifth of your dials
 * converting is not a thing that happens. So the detail sentence states the
 * denominator, and it is the first thing the sentence says rather than a
 * qualification at the end — and the card's second line states it again in
 * counts, because "431 of 2,104 connected calls" cannot be misread the way a
 * bare "20.5%" beside another bare percentage can.
 *
 * ── The first consumer `is_success` has ever had ───────────────────────────
 * `is_success` has been on `AgencyDispositionEntry` since the campaign builder
 * shipped — a "Counts as a success" checkbox an operator could tick and nothing
 * read back. This readout is what closes that loop.
 *
 * The three absences read differently, exactly as they do for every figure in
 * this module: `undefined` is "didn't load", `null` is "nothing has connected
 * yet", and a real `0` is a claim about the campaign. **Never `0.0%` for a
 * campaign that has not had a conversation** — that is a verdict reported as a
 * measurement.
 */
export function conversionRateReadout(stats: AgencyCampaignStats | null): PerformanceReadout {
  const rate = stats?.success_rate_pct;
  const successes = stats?.attempts_success;
  const connected = stats?.attempts_connected;
  /*
    The count travels on the denominator line rather than as a tile of its own:
    it is this rate's numerator, and a supervisor reading "22%" wants "of 41
    conversations" in the same glance. See the field's own comment for why it is
    not an eleventh counter.
  */
  const denominator =
    typeof successes === 'number' && typeof connected === 'number'
      ? {
        lead: successes.toLocaleString(),
        rest: `of ${connected.toLocaleString()} connected calls`,
      }
      : typeof successes === 'number'
        ? { lead: successes.toLocaleString(), rest: 'counted as a success' }
        : null;

  if (rate === undefined) {
    return {
      value: '—',
      detail: 'The conversion rate didn’t load.',
      caveat: null,
      // The count and the rate are produced independently; losing the rate is
      // no reason to withhold the number of wins the campaign recorded.
      denominator,
      scale: null,
      known: false,
    };
  }
  if (rate === null) {
    return {
      value: 'No data',
      detail: 'No call on this campaign has reached a person yet, so there is nothing to convert.',
      caveat: null,
      denominator,
      scale: null,
      known: false,
    };
  }
  const dials = dialsPlaced(stats);
  if (dials !== null && dials < RATE_MIN_ATTEMPTS) return volumeWithheldReadout(dials);

  /*
    The same structural caveat the connect rate carries, and for a sharper
    reason: with no voicemail code in the catalog, answering machines are counted
    as connected calls, which inflates this rate's DENOMINATOR and so understates
    the campaign. Left unsaid, a supervisor reads a low conversion rate as an
    agent problem when it is a configuration one.
  */
  let caveat: string | null = null;
  if (voicemailWithdrawn(stats)) {
    caveat =
      'Voicemail has been removed from this campaign’s disposition list, so answering '
      + 'machines reached since then are counted as conversations here. Read this rate as '
      + 'approximate from that point on.';
  } else if (!voicemailMeasured(stats)) {
    caveat =
      'This campaign’s disposition list has no voicemail code, so answering machines are '
      + 'counted as conversations here and this rate reads lower than it is.';
  }

  return {
    value: pct(rate),
    detail:
      'Out of the calls that reached a person — not out of every dial. Counts the '
      + 'dispositions this campaign marks as a success.',
    caveat,
    denominator,
    scale: { kind: 'fill', percent: clampPercent(rate), tone: 'teal' },
    known: true,
  };
}

/**
 * Average handle time — the agent's leg, voicemail excluded.
 *
 * ── Why this card has no percentage meter ──────────────────────────────────
 * There is nothing for a duration to be a percentage OF. A bar filled to some
 * share of a five-minute maximum nobody configured is a scale that does not
 * exist, drawn with the same confidence as the two rates beside it. What this
 * figure does have is a sibling — the same average with voicemail put back in —
 * and the delta between them is the whole point of the outcome split. So the scale here
 * is the pair against each other, which is a comparison the payload can support.
 *
 * The gate on the second bar is the INEQUALITY, not the availability flag. If
 * nothing was ever labelled voicemail the two averages are the same number by
 * construction — the server's exclusion predicate matches no rows — so the comparison
 * drops out on its own and showing it would imply a comparison had been made.
 * But a campaign whose catalog *used to* carry the code has a real, non-zero
 * delta, and gating on the flag would hide exactly that: the number that says
 * what the change cost, withheld at the moment someone made it.
 */
export function handleTimeReadout(stats: AgencyCampaignStats | null): PerformanceReadout {
  const aht = stats?.aht_seconds;
  const raw = stats?.aht_seconds_including_machine;

  if (aht === undefined) {
    return {
      value: '—',
      detail: 'Average handle time didn’t load.',
      caveat: null,
      denominator: null,
      scale: null,
      known: false,
    };
  }
  if (aht === null) {
    return {
      value: 'No data',
      detail: 'No call has finished yet, so there is nothing to average.',
      caveat: null,
      denominator: null,
      scale: null,
      known: false,
    };
  }

  const comparable = typeof raw === 'number' && raw !== aht;
  const largest = comparable ? Math.max(aht, raw) : aht;
  const share = (value: number) => (largest > 0 ? clampPercent((value / largest) * 100) : 0);

  const bars: ReadoutBar[] = [
    {
      label: comparable ? `${seconds(aht)} excl. vm` : seconds(aht),
      percent: share(aht),
      muted: false,
    },
  ];
  if (comparable) {
    bars.push({ label: `${seconds(raw)} incl. vm`, percent: share(raw), muted: true });
  }

  let caveat: string | null = null;
  if (voicemailWithdrawn(stats)) {
    // Not "machines are inside this average" — the ones already labelled are
    // correctly outside it. Only the ones since the code was removed are in.
    caveat =
      'Voicemail has been removed from this campaign’s disposition list. Calls marked '
      + 'before that are still excluded here; answering machines reached since then are '
      + 'inside this average.';
  } else if (!voicemailMeasured(stats)) {
    caveat =
      'Voicemail isn’t a disposition on this campaign, so answering machines are inside this average.';
  }

  return {
    value: seconds(aht),
    detail: 'Average time on a call, from the moment the agent and the customer were joined.',
    caveat,
    /*
      Stated only when it is true. On a campaign whose catalog has no voicemail
      code the caveat directly beneath says answering machines are INSIDE this
      average, and a line above it claiming they are excluded would put a flat
      contradiction on one card. The caveat is the louder of the two and is the
      one that survives.
    */
    denominator:
      voicemailMeasured(stats)
        ? { lead: null, rest: 'Voicemail excluded — the dialer’s own figure' }
        : null,
    scale: { kind: 'compare', bars },
    known: true,
  };
}

/**
 * Average wrap-up — the tuning input for the campaign's own window.
 *
 * Rendered against `wrapup_seconds` because the average alone is not
 * actionable: 40 seconds is comfortable in a 90-second window and is agents
 * running out of road in a 45-second one, and the setting is on the settings
 * page two clicks away. That configured window is also the one real ceiling on
 * this surface, which is why this is the only figure whose meter carries a
 * marked limit: the bar is a share of the allowance, and the tick is where the
 * allowance ends.
 */
export function wrapupReadout(
  stats: AgencyCampaignStats | null,
  configuredSeconds: number | null | undefined,
): PerformanceReadout {
  const avg = stats?.avg_wrapup_seconds;
  const window = typeof configuredSeconds === 'number' ? configuredSeconds : null;
  const allowed = window === null ? null : seconds(window);
  const denominator =
    allowed === null ? null : { lead: allowed, rest: 'allowed on this campaign' };

  if (avg === undefined) {
    return {
      value: '—',
      detail: allowed
        ? `Average wrap-up didn’t load. You allow ${allowed}.`
        : 'Average wrap-up didn’t load.',
      caveat: null,
      denominator,
      scale: null,
      known: false,
    };
  }
  if (avg === null) {
    return {
      value: 'No data',
      detail: allowed
        ? `No wrap-up has finished yet. You allow ${allowed}.`
        : 'No wrap-up has finished yet.',
      caveat: null,
      denominator,
      scale: null,
      known: false,
    };
  }

  // At 90% of the window the average is telling you agents are spending the
  // whole allotment, which on an auto-return campaign means some of them were
  // cut off mid-write-up — the disposition data thins out before the number does.
  const atTheLimit = window !== null && window > 0 && avg >= window * 0.9;

  return {
    value: seconds(avg),
    detail: allowed
      ? 'Measured across finished wrap-ups — the ones an agent ended themselves.'
      : 'Measured across finished wrap-ups. This campaign’s wrap-up window didn’t load.',
    caveat: atTheLimit
      ? 'Wrap-ups are using nearly the whole window. Agents may be running out of time to write calls up.'
      : null,
    denominator,
    // No window, no scale. A wrap-up average with nothing to be measured against
    // is a duration, and the rule that governs handle time governs it too.
    scale:
      window !== null && window > 0
        ? { kind: 'ceiling', percent: clampPercent((avg / window) * 100) }
        : null,
    known: true,
  };
}

/** One bucket of the connects split. */
/**
 * A segment's share as text, or `—`.
 *
 * Exported so the component does not re-implement it. It did:
 * `${Number(segment.share.toFixed(1))}%` inlined in JSX, a second copy of the
 * module-private `pct` whose docstring already carries the "3.0% reads as false
 * precision" rule. Two copies means the split card's percentages silently drift
 * from every other percentage on the same card the first time that rule changes.
 */
export function segmentShareText(share: number | null): string {
  return share === null ? '—' : pct(share);
}

export interface ConnectsSegment {
  key: 'human' | 'machine' | 'unclassified';
  label: string;
  value: number;
  hint: string;
  /**
   * True when the count is structurally 0 and measures nothing, so the console
   * must not present it as an observation.
   */
  unmeasured: boolean;
  /**
   * This bucket's share of every bridged call, 0–100 — or `null` when there is
   * no share to state: an unmeasured bucket, or a total of zero.
   *
   * `null` is what keeps the bar honest as well as the row. A segment with no
   * share contributes no width, so the campaign with no voicemail code draws a
   * two-part bar rather than a three-part bar with an invisible third.
   */
  share: number | null;
}

export interface ConnectsBreakdown {
  segments: ConnectsSegment[];
  /** Every bridged call — the three buckets sum to this. `null` if unavailable. */
  total: number | null;
}

/**
 * the connected — where the connected calls actually went.
 *
 * The server sends all three counts together or not at all, so a partial payload is a
 * producer bug rather than a state to render half of; the whole breakdown drops
 * out rather than showing two buckets that do not sum to the third.
 */
export function connectsBreakdown(stats: AgencyCampaignStats | null): ConnectsBreakdown {
  const human = stats?.human_connects;
  const machine = stats?.machine_connects;
  const unclassified = stats?.unclassified_connects;

  if (
    typeof human !== 'number'
    || typeof machine !== 'number'
    || typeof unclassified !== 'number'
  ) {
    return { segments: [], total: null };
  }

  const measured = voicemailMeasured(stats);
  const withdrawn = voicemailWithdrawn(stats);
  const total = human + machine + unclassified;
  const share = (value: number, unmeasured: boolean) =>
    (unmeasured || total <= 0 ? null : clampPercent((value / total) * 100));

  function machineHint(): string {
    if (measured) {
      return 'Connected calls an agent marked as voicemail. Their time is kept out of handle time.';
    }
    if (withdrawn) {
      return 'Voicemail has been removed from this campaign’s disposition list. These were marked before that and the count will not grow.';
    }
    return 'Not being recorded — this campaign’s disposition list has no voicemail code, so an agent has no way to mark one.';
  }

  /*
    Blanked ONLY when the count is a structural zero — no code in the catalog and
    nothing ever labelled. A campaign that recorded voicemails and then dropped
    the code has a real count here, and replacing it with an em dash would
    discard true history to report "none happened".
  */
  const machineUnmeasured = !measured && !withdrawn;

  return {
    total,
    segments: [
      {
        key: 'human',
        label: 'Spoke to a person',
        value: human,
        hint: 'Connected calls an agent wrote up as a real conversation.',
        unmeasured: false,
        share: share(human, false),
      },
      {
        key: 'machine',
        label: 'Answering machine',
        value: machine,
        hint: machineHint(),
        unmeasured: machineUnmeasured,
        share: share(machine, machineUnmeasured),
      },
      {
        key: 'unclassified',
        label: 'Not written up',
        value: unclassified,
        hint:
          'Connected calls with no disposition, including wrap-ups that timed out. '
          + 'They are outside the connect rate but inside handle time.',
        unmeasured: false,
        share: share(unclassified, false),
      },
    ],
  };
}

/** What one connected call costs an agent, and what an hour of that buys. */
export interface HandledCallCost {
  /** Talk plus wrap-up, `m:ss`. */
  total: string;
  /** The talk leg — the measured handle time. */
  talk: { label: string; percent: number };
  /** The wrap-up leg — the MEASURED average, never the configured allowance. */
  wrapup: { label: string; percent: number };
  /** Conversations an agent can take in an hour at this cost, one decimal. */
  perHour: string;
  /** `perHour` at the campaign's conversion rate, or `null` when that is withheld. */
  winsPerHour: string | null;
  /** The conversion rate the wins figure was taken at — always shown beside it. */
  conversionRate: string | null;
  /** The sentence that stops this being read as a plan. */
  caveat: string;
}

/**
 * The card the two averages are for: **what one handled call costs, and what an
 * hour of that buys.**
 *
 * Handle time and wrap-up are each a tuning input for a different setting, and
 * neither answers the question a supervisor is actually holding — "how many
 * conversations can this floor have today". Their sum does, because the sum is
 * the agent's whole occupied minute per connected call.
 *
 * ── Both figures, or nothing ────────────────────────────────────────────────
 * Rendered only when handle time AND wrap-up are both real measurements.
 * Substituting a zero for the missing one is the failure this whole module is
 * written against: it would not degrade the estimate, it would inflate it, and
 * a supervisor comparing "22 an hour" against a floor doing eleven has been
 * handed a target derived from a field that never loaded.
 *
 * ── Why it is a ceiling and says so ─────────────────────────────────────────
 * `3600 / (talk + wrap-up)` assumes an agent takes the next call the instant the
 * last one is written up: no break, no ringing, no gap between contacts, and
 * nobody logged out. Every one of those is real time that this arithmetic does
 * not know about, so the number is an upper bound and the caveat is part of the
 * figure rather than a footnote under it.
 *
 * ── Wins per hour is withheld with the rate it is made of ───────────────────
 * It is `perHour × success_rate_pct`, so it inherits everything wrong with a
 * conversion rate measured over a handful of calls — and it inherits it wearing
 * a decimal point and the word "wins", which is more quotable than the rate was.
 * When {@link RATE_MIN_ATTEMPTS} withholds the rate, this goes with it.
 */
export function handledCallCost(stats: AgencyCampaignStats | null): HandledCallCost | null {
  const talkSeconds = stats?.aht_seconds;
  const wrapupSeconds = stats?.avg_wrapup_seconds;

  if (typeof talkSeconds !== 'number' || typeof wrapupSeconds !== 'number') return null;

  const totalSeconds = talkSeconds + wrapupSeconds;
  // A zero-length handled call is not a cost, and 3600/0 is not a rate.
  if (totalSeconds <= 0) return null;

  const rate = stats?.success_rate_pct;
  const perHour = 3600 / totalSeconds;
  const conversionKnown = typeof rate === 'number' && !ratesWithheld(stats);

  return {
    total: seconds(totalSeconds),
    talk: {
      label: seconds(talkSeconds),
      percent: clampPercent((talkSeconds / totalSeconds) * 100),
    },
    wrapup: {
      label: seconds(wrapupSeconds),
      percent: clampPercent((wrapupSeconds / totalSeconds) * 100),
    },
    perHour: perHour.toFixed(1),
    winsPerHour: conversionKnown ? ((perHour * rate) / 100).toFixed(1) : null,
    conversionRate: conversionKnown ? pct(rate) : null,
    caveat:
      'A ceiling, not a forecast — it assumes an agent takes a call the moment the last one '
      + 'is written up.',
  };
}

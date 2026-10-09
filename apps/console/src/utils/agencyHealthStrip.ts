import type { AgencyStall, AgencyStallCode } from '../types/agency-campaign';

/**
 * The supervisor health strip and the two read-outs beside it — as pure functions, because every sentence here is derived from wire
 * evidence and every derivation is a place to be confidently wrong.
 *
 * ── Why a module and not JSX ────────────────────────────────────────────────
 * The strip's whole value is that it names the campaign's own numbers back to
 * the supervisor. That makes the copy a *function of the payload*, not a
 * template — and the ranking decides which single sentence they read at all.
 * Both are testable propositions, so they are tested rather than eyeballed.
 *
 * ── One diagnosis ───────────────────────────────────────────────────────────
 * The server sends one `stall` plus the codes that also matched. A supervisor reading
 * five simultaneous problems acts on none of them, so the strip shows the top
 * one and files the rest behind a count.
 */

/**
 * Priority order, first match wins — mirrored from the server's
 * `AGENCY_STALL_PRIORITY` (`src/agency/contracts.ts`).
 *
 * The ranking is by **what a supervisor should do about it**, not by severity: a
 * compliance stop outranks a staffing problem, which outranks a capacity one,
 * because acting on the wrong one wastes the minutes the strip exists to save.
 *
 * This is the console's own copy of the order and it is used to SORT
 * `other_stalls` rather than trusting the array's arrival order. The server does send
 * them ranked; relying on that would mean a producer-side reorder silently
 * changes what a supervisor reads, with nothing here going red.
 */
export const AGENCY_STALL_PRIORITY: readonly AgencyStallCode[] = [
  'auto_paused_abandonment',
  'dnc_unavailable',
  'no_agents_available',
  'concurrency_saturated',
  'outside_calling_hours',
  'list_exhausted_retries_pending',
  // There is no `credits_low` stall code: there are no credits yet, and it comes
  // back with metering.
  'elevated_failure_rate',
] as const;

/** Short names for the "more issues" disclosure. One line each, no evidence. */
export const AGENCY_STALL_LABELS: Record<AgencyStallCode, string> = {
  auto_paused_abandonment: 'Paused by the abandonment limit',
  dnc_unavailable: 'Do Not Call check unavailable',
  no_agents_available: 'No agents available',
  concurrency_saturated: 'At the concurrency limit',
  outside_calling_hours: 'Outside calling hours',
  list_exhausted_retries_pending: 'Waiting on scheduled retries',
  elevated_failure_rate: 'Unusually many failed calls',
};

/**
 * Sort codes into the priority order and drop anything unrecognised.
 *
 * Unknown codes are dropped rather than appended: a code this build has no label
 * for renders as nothing useful, and a supervisor counting "3 more issues" and
 * finding two names would trust the strip less than one that says two. A newer
 * server adding a ninth condition is a console change, not a runtime surprise.
 */
export function sortStallCodes(codes: readonly AgencyStallCode[]): AgencyStallCode[] {
  const rank = new Map(AGENCY_STALL_PRIORITY.map((code, index) => [code, index]));
  return codes
    .filter((code) => rank.has(code))
    .slice()
    .sort((a, b) => rank.get(a)! - rank.get(b)!);
}

/**
 * One fact in the evidence run.
 *
 * `text` is the whole fact and is the only thing anybody READS — `emphasis` is a
 * substring of it that the eye should land on (a count, a rate, an instant), and
 * is presentational only. Deliberately a substring rather than a separate field:
 * it cannot desynchronise from the sentence, and a substring that fails to match
 * degrades to an unemphasised fact rather than to a wrong or missing one.
 */
export interface StallFact {
  text: string;
  emphasis?: string;
}

/** `text` split around its emphasised value, ready to wrap in a `<strong>`. */
export interface EmphasisedFact {
  before: string;
  value: string;
  after: string;
}

/**
 * Split a fact at its emphasised value. An absent or unmatched `emphasis`
 * returns the whole sentence as `before` with an empty `value`, so a renderer
 * never has to decide what to do about a miss.
 */
export function splitFact(fact: StallFact): EmphasisedFact {
  const { text, emphasis } = fact;
  if (!emphasis) return { before: text, value: '', after: '' };
  const at = text.indexOf(emphasis);
  if (at === -1) return { before: text, value: '', after: '' };
  return { before: text.slice(0, at), value: emphasis, after: text.slice(at + emphasis.length) };
}

/**
 * One diagnosis, rendered.
 *
 * `headline` is the sentence; `facts` are the campaign's own numbers restated so
 * the supervisor can check the claim, as a run of short items rather than a
 * paragraph; `advice` is what to do, and is omitted where there is nothing
 * honest to suggest.
 *
 * `evidence` is `facts` joined — the same words, as one string, for a caller
 * that wants a sentence. It is derived from `facts` and can never disagree
 * with them.
 */
export interface StallCopy {
  headline: string;
  facts: StallFact[];
  evidence: string;
  advice?: string;
}

/** The visual gap between facts, as a character, for the joined `evidence`. */
const FACT_JOIN = ' · ';

function joined(facts: StallFact[]): string {
  return facts.map((fact) => fact.text).join(FACT_JOIN);
}

function diagnosis(parts: { headline: string; facts: StallFact[]; advice?: string }): StallCopy {
  return { ...parts, evidence: joined(parts.facts) };
}

function pct(value: number): string {
  // One decimal, trailing zero trimmed: "3%" and "3.4%" both read as rates,
  // "3.0%" reads as a measurement with false precision.
  return `${Number(value.toFixed(1))}%`;
}

/** The emphasised form of a number — the exact substring a fact leads with. */
function num(value: number): string {
  return value.toLocaleString();
}

function count(value: number, singular: string, plural = `${singular}s`): string {
  return `${num(value)} ${value === 1 ? singular : plural}`;
}

/** Break codes to a readable clause: "5 on break (lunch 3, training 2)". */
function breakClause(byReason: Record<string, number>): string | null {
  const entries = Object.entries(byReason).filter(([, n]) => n > 0);
  if (entries.length === 0) return null;
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  // Largest first — the reason holding the most agents is the one worth acting
  // on, and a supervisor scanning under pressure reads the head of the list.
  const detail = entries
    .slice()
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${reason} ${n}`)
    .join(', ');
  return `${total} on break (${detail})`;
}

/**
 * The diagnosis for one stall, derived only from that arm's own evidence.
 *
 * `formatInstant` is injected rather than imported so the caller owns the
 * locale/timezone decision (and so a test can pin the output without pinning the
 * host's clock formatting).
 */
export function stallCopy(
  stall: AgencyStall,
  formatInstant: (iso: string) => string,
): StallCopy {
  switch (stall.code) {
    case 'auto_paused_abandonment': {
      const pausedAt = formatInstant(stall.paused_at);
      return diagnosis({
        headline: `Paused automatically — abandonment reached ${pct(stall.measured_pct)}, over your ${pct(stall.ceiling_pct)} limit.`,
        // "Measured at", never "currently": The server freezes this figure at the
        // instant the guardrail fired (`paused_at` / `pause_abandonment_rate_pct`). Presenting a frozen
        // number as a live one means a supervisor who has since staffed up sees
        // no improvement and concludes the fix did not work.
        facts: [
          {
            text: `Measured at ${pausedAt}, when the limit was hit. It is not a live rate and will not move while the campaign is paused.`,
            emphasis: pausedAt,
          },
        ],
        advice: 'Get more agents on shift before resuming, or the guardrail will pause it again.',
      });
    }

    case 'dnc_unavailable':
      return diagnosis({
        headline: 'Dialing has stopped — the Do Not Call check is unavailable.',
        facts: [
          {
            text: stall.tenant_wide
              ? 'The Do Not Call list is shared across this whole workspace, so every campaign in it is stopped by the same fault.'
              : 'The Do Not Call list could not be read.',
          },
        ],
        advice: 'Nothing to change here — dialing resumes on its own once the check is back. Contact support if it persists.',
      });

    case 'no_agents_available': {
      const breaks = breakClause(stall.on_break_by_reason);
      const facts: StallFact[] = [
        { text: `${count(stall.agents_on_shift, 'agent')} on shift`, emphasis: num(stall.agents_on_shift) },
        // `num()` like every other count on this run. A raw interpolation drops
        // the thousands separator, so a large floor read "1234 on a call" beside
        // "1,234 agents on shift" — and the emphasis substring then failed to
        // match the formatted text it was supposed to bolden.
        { text: `${num(stall.on_call)} on a call`, emphasis: num(stall.on_call) },
      ];
      if (breaks) facts.push({ text: breaks, emphasis: breaks.split(' ')[0] });
      // `last_dial_at: null` is "never dialed", which is a different problem
      // from "stopped dialing an hour ago" and points at a different fix.
      //
      // This is EVIDENCE, not advice: it is a fact about the campaign the
      // supervisor can check, and it sat in `advice` — a field whose whole
      // contract is "what to do" — only because there was nowhere else to put
      // it. What to do about an empty floor is now the "Open the floor" link,
      // which is a real affordance rather than a sentence.
      facts.push(
        stall.last_dial_at
          ? {
              text: `Last call placed at ${formatInstant(stall.last_dial_at)}`,
              emphasis: formatInstant(stall.last_dial_at),
            }
          : { text: 'This campaign has never placed a call' },
      );
      return diagnosis({ headline: 'Nobody is free to take a call.', facts });
    }

    case 'concurrency_saturated':
      return diagnosis({
        headline: `At your concurrency limit — ${stall.in_use} of ${stall.limit} lines in use.`,
        facts: [
          { text: 'The limit is account-wide, so other calls in this workspace count against it too.' },
        ],
        // `shift_seconds`: there is no tenant-facing setter, so the honest advice names who
        // can change it rather than implying the supervisor can.
        advice: 'Calls resume as lines free up. Raising the limit is a support request.',
      });

    case 'outside_calling_hours':
      return diagnosis({
        headline: 'Outside calling hours for everyone left on the list.',
        facts: [
          {
            text: `${count(stall.contacts_waiting, 'contact')} waiting for their local calling window.`,
            emphasis: num(stall.contacts_waiting),
          },
        ],
        advice: stall.next_window_opens_at
          ? `The next window opens at ${formatInstant(stall.next_window_opens_at)}.`
          : 'No upcoming window resolves for these contacts — check the campaign’s calling days and timezone.',
      });

    case 'list_exhausted_retries_pending':
      return diagnosis({
        headline: 'Nothing to dial right now — everything left is waiting on a retry.',
        facts: [
          {
            text: `${count(stall.retries_pending, 'retry', 'retries')} scheduled.`,
            emphasis: num(stall.retries_pending),
          },
        ],
        advice: stall.next_retry_at
          ? `The next one is due at ${formatInstant(stall.next_retry_at)}.`
          : 'No retry time is set — add contacts if you need this campaign dialing now.',
      });

    // There is no `credits_low` arm ("Credit is running low.", "Top up before
    // the balance runs out…"): there is no such stall code while there are no
    // credits yet.

    case 'elevated_failure_rate':
      return diagnosis({
        headline: `${pct(stall.failed_pct)} of recent calls failed.`,
        facts: [
          {
            text: `${count(stall.attempts, 'attempt')} in the last ${count(stall.window_minutes, 'minute')}.`,
            emphasis: num(stall.attempts),
          },
        ],
        advice: 'Often a carrier problem rather than the list. Check the caller IDs on this campaign, then contact support.',
      });
  }
}

/**
 * The concurrency read-out (display only).
 *
 * **Read-only, ** — the supervisor sees it and cannot set it, so this
 * returns text and never an editable value.
 *
 * `inUse === null` means Redis could not answer. That is `unknown`, and it is
 * deliberately NOT collapsed into 0 or into "saturated": telling a supervisor to
 * contact support about a ceiling we merely failed to read sends them after the
 * wrong problem, and a 0 invites them to conclude the campaign has headroom it
 * may not have.
 */
export interface ConcurrencyReadout {
  value: string;
  detail: string;
  /** True only when we know the number AND it is at the ceiling. */
  saturated: boolean;
  /** True when the live count could not be read. Never implies 0. */
  unknown: boolean;
  /**
   * How much of the meter to fill, 0–1 — or **`null` for "draw nothing"**.
   *
   * Null and 0 are different instructions and the difference is the whole point
   * of the field: a zero-width bar is a drawn claim that the account is idle,
   * and an unreadable count must not make that claim. Anything that cannot be
   * expressed as a ratio (no limit, no count, a limit of zero) is null.
   */
  fill: number | null;
}

/** Clamp a ratio into the meter's own 0–1 range, or null if it isn't one. */
function ratio(part: number, whole: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null;
  return Math.max(0, Math.min(1, part / whole));
}

export function concurrencyReadout(
  limit: number | undefined,
  inUse: number | null | undefined,
): ConcurrencyReadout {
  if (typeof limit !== 'number') {
    return {
      value: '—',
      detail: 'The concurrency limit didn’t load.',
      saturated: false,
      unknown: true,
      fill: null,
    };
  }
  if (inUse === null || inUse === undefined) {
    return {
      value: `? of ${limit}`,
      detail: 'We couldn’t read how many lines are in use right now. The limit is ' + `${limit}.`,
      saturated: false,
      unknown: true,
      fill: null,
    };
  }
  return {
    value: `${inUse} of ${limit}`,
    detail: 'Lines in use across this whole workspace, not just this campaign.',
    saturated: inUse >= limit,
    unknown: false,
    fill: ratio(inUse, limit),
  };
}

/**
 * The abandonment read-out — the measured 24h rate against **this
 * campaign's own ceiling**, not a platform constant.
 *
 * Drawing it against the campaign's configured ceiling is the point: the
 * threshold line a supervisor watches has to be the line that actually pauses
 * their campaign, or the strip teaches them the wrong number.
 */
export interface AbandonmentReadout {
  value: string;
  detail: string;
  /** Amber at 75% of the ceiling. `false` whenever the rate is unknown. */
  nearCeiling: boolean;
  over: boolean;
  /**
   * How much of the meter to fill, 0–1, where **1 is the campaign's own
   * ceiling** — not 100% abandonment. The meter is scaled to the line that
   * actually pauses this campaign, for the same reason `detail` names it: a bar
   * drawn against 100% would put every real rate in the first few pixels and
   * teach a supervisor that they have room they do not have.
   *
   * `null` means "draw nothing" — no rate, or no ceiling to scale against.
   * Never 0, which would draw a reassuring empty bar over an unmeasured rate.
   */
  fill: number | null;
  /**
   * Which colour the fill takes. Derived here rather than re-implemented from
   * `over`/`nearCeiling` at the call site, so the band and the value's own
   * emphasis can never disagree about the same number.
   */
  band: 'unknown' | 'ok' | 'near' | 'over';
  /** The ceiling tick's label, e.g. `3% ceiling` — null when it didn't load. */
  ceilingLabel: string | null;
}

export function abandonmentReadout(
  ratePct: number | null | undefined,
  ceilingPct: number | undefined,
  /**
   * The rate's own numerator and denominator, when the payload carried them.
   *
   * Optional because they are, and because the rate is legible without them —
   * but a percentage with no visible denominator is the classic way a small
   * sample reads as a trend. `2 of 5` and `40 of 100` are the same 40% and are
   * not the same news, and it is the first one a supervisor should not act on.
   */
  counts?: { abandoned: number | undefined; answered: number | undefined },
  /**
   * True once the campaign has finished, which changes the TENSE.
   *
   * This figure is a rolling 24-hour number about the whole ACCOUNT, so on a
   * campaign that stopped three weeks ago it describes this afternoon and has
   * nothing to do with the campaign being reviewed. Saying "the campaign pauses
   * itself above it" there is worse than merely stale: it is present tense about
   * a campaign that cannot pause, beside a percentage a supervisor will read as
   * that campaign's own abandonment rate.
   */
  finished = false,
): AbandonmentReadout {
  const ceilingText = typeof ceilingPct === 'number' ? pct(ceilingPct) : 'your limit';
  const ceilingLabel = typeof ceilingPct === 'number' ? `${pct(ceilingPct)} ceiling` : null;
  const abandoned = counts?.abandoned;
  const answered = counts?.answered;
  const sample =
    typeof abandoned === 'number' && typeof answered === 'number'
      ? ` ${abandoned.toLocaleString()} of ${count(answered, 'answered call')}.`
      : '';

  if (ratePct === undefined) {
    return {
      value: '—',
      detail: `The 24-hour abandonment rate didn’t load. Your limit is ${ceilingText}.`,
      nearCeiling: false,
      over: false,
      fill: null,
      band: 'unknown',
      ceilingLabel,
    };
  }
  // Null is the server's "no answered calls in the window", which is not zero
  // abandonment — it is no measurement. A reassuring 0.0% here is how a
  // guardrail gets trusted before it has measured anything.
  if (ratePct === null) {
    return {
      value: 'No data',
      detail: `No calls have been answered in the last 24 hours, so there is nothing to measure yet. Your limit is ${ceilingText}.`,
      nearCeiling: false,
      over: false,
      fill: null,
      band: 'unknown',
      ceilingLabel,
    };
  }

  const known = typeof ceilingPct === 'number';
  const over = known && ratePct >= ceilingPct;
  /**
   * Whether the server's guardrail will actually pause on this reading.
   *
   * It will not when a SINGLE abandoned call sits in a sample too small for one
   * call to clear the ceiling — `breachedRows`'s fourth refusal
   * (`abandonment-guardrail.ts`, added 2026-09-11, because `1 of 1` read 100% and
   * paused campaigns permanently). The threshold is `ceil(100 / ceiling)`: the
   * answered count from which one abandon can come in under the limit at all.
   *
   * ⚠️ **Derived here rather than sent, on purpose.** It is a function of two
   * numbers this payload already carries, so mirroring it costs no contract
   * change — and the alternative was leaving the sentence below promising a pause
   * that will not happen. A percentage that says "the campaign pauses itself
   * above it" beside a campaign that is still dialing does not read as a
   * small-sample nuance; it reads as a broken guardrail, and the supervisor's
   * next move is to stop the campaign by hand.
   *
   * Unknowable without both counts, and then we do NOT weaken the sentence: the
   * pause is the norm and the suppression is the exception, so an absent
   * denominator falls back to the promise rather than to the caveat.
   *
   * ⚠️ **`over` is `>=` here and the server breaches on `>`, and that boundary is
   * inherited by this branch because `over` is its first conjunct.** The
   * mismatch predates this function (the server has an explicit test that a rate
   * exactly AT the ceiling does not breach), and it is safe rather than
   * tolerated: with a single abandoned call, landing exactly on the ceiling
   * requires `answered === 100 / ceiling`, which is precisely
   * `Math.ceil(100 / ceilingPct)` when that is an integer — so `answered <
   * floor` is false and this branch cannot fire there. The strip therefore
   * still renders the unconditional sentence, which says the campaign pauses
   * itself *above* the limit and stays literally true at it. Re-check this if
   * either side's comparison ever moves.
   */
  const suppressedByTinySample =
    over
      && known
      && typeof abandoned === 'number'
      && typeof answered === 'number'
      && abandoned <= 1
      && ceilingPct > 0
      && answered < Math.ceil(100 / ceilingPct);
  const nearCeiling = known && ratePct >= ceilingPct * 0.75 && ratePct < ceilingPct;
  return {
    value: pct(ratePct),
    detail: known
      ? finished
        ? `Across this account over the last 24 hours, against a ${ceilingText} limit. This `
          + `campaign has stopped, so it is no longer counted.${sample}`
        : suppressedByTinySample
          ? `Over the last 24 hours, against this campaign’s ${ceilingText} limit. One `
            + `abandoned call in a sample this small is over the limit whatever we did, so `
            + `the campaign keeps dialing — it pauses itself once there are enough answered `
            + `calls for the rate to mean something.${sample}`
          : `Over the last 24 hours, against this campaign’s ${ceilingText} limit. The campaign pauses itself above it.${sample}`
      : `Over the last 24 hours. This campaign’s limit didn’t load.${sample}`,
    nearCeiling,
    over,
    // A known rate with no ceiling has nothing to be a fraction OF. The number
    // still renders; the meter does not, because a bar with no scale is a
    // picture of a comparison that was never made.
    fill: known ? ratio(ratePct, ceilingPct) : null,
    band: !known ? 'unknown' : over ? 'over' : nearCeiling ? 'near' : 'ok',
    ceilingLabel,
  };
}

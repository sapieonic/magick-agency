import type {
  AgencyAgentLiveState,
  AgencyCampaign,
  AgencyCampaignStats,
} from '../types/agency-campaign';
import type { AgencyContactState } from '../types/agency-spine';
import { AGENCY_FLOOR_STATE_LABELS } from './agencyAgentFloor';
import { campaignTense, type CampaignEnding, type CampaignTense } from './agencyCampaignControls';
import { RATE_MIN_ATTEMPTS, ratesWithheld } from './agencyCampaignPerformance';

/**
 * The Overview panel's derivations — the pulse strip, the contact funnel, the
 * live-floor slice of the rail, and the "How it ran" facts.
 *
 * Same reasoning as `agencyCampaignPerformance` and `agencyHealthStrip`: every
 * value below is a claim about the campaign derived from a payload of optional
 * and nullable fields, and a derivation is a place to be confidently wrong. They
 * are pure and tested rather than inlined into JSX and eyeballed.
 *
 * ── The one rule the whole module is built around ───────────────────────────
 * **A missing number is never a zero, and a null rate is never 0%.** The stats
 * payload carries three different absences and they read differently:
 *
 * 1. **`undefined`** — the field did not arrive (an older the server, an older
 *    the API, or a partial read). Renders `—` and `known: false`.
 * 2. **`null`** — the server carried the field and has nothing to measure. Every rate
 *    on this payload is null before its denominator exists. The sub-line that
 *    would have quoted it is **dropped**, rather than printed as `0%`.
 * 3. **A real `0`** — a measurement, and the only one of the three that is a
 *    claim about the campaign. It renders as `0`.
 *
 * ── Every rate names its own denominator ────────────────────────────────────
 * The two rates on this payload are measured against different things on
 * purpose (`connect_rate_pct` over attempts, `success_rate_pct` over connected
 * calls), so neither may appear as a bare percentage. Each sub-line below names
 * what it is out of, and — more importantly — each rate is attached to the cell
 * holding its own NUMERATOR:
 *
 * - `connect_rate_pct` is `human_connects / attempts_total`, so it sits under
 *   **Spoke to a person** (whose value is `human_connects`), not under Reached
 *   someone (`attempts_connected`). Putting it there would pair a percentage
 *   with a number that is not its numerator, and a supervisor reading the two in
 *   one glance would divide one by the other and get a third, wrong figure.
 * - `success_rate_pct` is `attempts_success / attempts_connected`, so its
 *   sub-line names "calls that reached someone" — the label of the cell that
 *   holds its denominator.
 *
 * No rate is re-derived here. A blended connect rate computed from
 * `attempts_connected / attempts_total` would be a second, different connect
 * rate for the same campaign, which is exactly what the server's single wire figure
 * exists to prevent.
 */

// ── Shared shapes ───────────────────────────────────────────────────────────

/** One figure in the pulse strip, ready to render. */
export interface OverviewFigure {
  /** The formatted number, or `—` when nothing arrived. */
  value: string;
  /** True only when a real measurement is behind {@link value}. */
  known: boolean;
  /**
   * A supporting sentence beneath the number, or `null`.
   *
   * `null` is the honest answer whenever the figure that would fill it is
   * absent or un-measurable — a sub-line is dropped, never faked with a zero.
   */
  sub: string | null;
}

const DASH = '—';

function count(value: number | undefined): OverviewFigure {
  return typeof value === 'number'
    ? { value: value.toLocaleString(), known: true, sub: null }
    : { value: DASH, known: false, sub: null };
}

/**
 * One decimal, trailing zero trimmed — the same rendering `agencyHealthStrip`
 * and `agencyCampaignPerformance` use, so one campaign's percentages read the
 * same on every section of the workspace.
 */
function pct(value: number): string {
  return `${Number(value.toFixed(1))}%`;
}

/**
 * A rate's sub-line, or `null`.
 *
 * Three ways to get `null`, and the third is the interesting one:
 *
 * - `undefined` — the field didn't arrive.
 * - `null` — the server carried it and has nothing to measure.
 * - **The campaign has too few dials to publish a percentage at all.**
 *
 * That last is `ratesWithheld`, imported from `agencyCampaignPerformance`
 * rather than re-implemented here, and the import is the point. The Performance
 * section refuses to print a rate under {@link RATE_MIN_ATTEMPTS} dials, in
 * those words. If this strip kept its own rule — or no rule — a four-dial
 * campaign would read "50% of dials placed" on Overview and "Not enough dials"
 * one tab away, which is worse than either answer alone: a supervisor who saw
 * both would have no way to tell which section was lying. One predicate, so the
 * two sections cannot drift.
 *
 * Overview drops the line rather than printing the Performance card's sentence:
 * a pulse cell is a number and a caption, with no room to explain a threshold,
 * and the section that does have room is one click away.
 */
function rateSub(
  rate: number | null | undefined,
  of: string,
  withheld: boolean,
): string | null {
  if (withheld || typeof rate !== 'number') return null;
  return `${pct(rate)} ${of}`;
}

// ── The contact funnel ──────────────────────────────────────────────────────

export type ContactStateKey =
  | 'contacts_completed'
  | 'contacts_in_flight'
  | 'contacts_on_call'
  | 'contacts_pending'
  | 'contacts_suppressed'
  | 'contacts_exhausted';

/**
 * Every contact state the roster can report, mapped to the funnel bucket that
 * speaks for it.
 *
 * **This map is the whole point of the module's newest guard, so it is worth
 * saying why it exists rather than five inline strings.** The funnel used to
 * declare its own five keys with no stated relationship to
 * {@link AgencyContactState}, and the two drifted: the roster has six states,
 * the funnel had five buckets, and `connected` — the contact a supervisor would
 * describe as "on a call" — belonged to none of them. A campaign with three
 * bridged contacts therefore drew a bar of 91.7% under a key whose five rows
 * summed to 33 of 36, with nothing on the panel to say where the other three
 * were. Nobody had written a bug; the two lists simply never had to agree.
 *
 * Typing this as `Record<AgencyContactState, ContactStateKey>` makes them agree
 * at compile time. Add a seventh contact state to the roster union and this
 * object stops type-checking until somebody decides which bucket it belongs in
 * — which is the only reliable moment to make that decision.
 */
export const CONTACT_STATE_BUCKET: Record<AgencyContactState, ContactStateKey> = {
  pending: 'contacts_pending',
  in_flight: 'contacts_in_flight',
  connected: 'contacts_on_call',
  completed: 'contacts_completed',
  exhausted: 'contacts_exhausted',
  suppressed: 'contacts_suppressed',
};

export interface ContactFunnelState {
  key: ContactStateKey;
  label: string;
  hint: string;
}

/**
 * The six simultaneous contact states, in bar order.
 *
 * **Not numbered steps.** A contact is in exactly one of these at any moment
 * and does not walk them in sequence — a suppressed number never was pending.
 * The order is the one a supervisor reads the bar in: what is finished, what is
 * moving (dialing, then bridged), what is still to come, then the two ways a
 * contact leaves the list.
 *
 * The hints are carried unchanged from the counters this replaced, with two
 * exceptions, both of which were claims the payload does not support:
 *
 * - **Suppressed no longer says "Skipped".** On a collections campaign the
 *   commonest way to reach this state is to be dialed, answered, and written up
 *   with an outcome configured to stop calling — the successful calls. Reading
 *   "Skipped because of Do Not Call rules" over the campaign's own wins tells a
 *   supervisor the opposite of what happened, and it is the same 23 contacts
 *   that the pulse strip counts as successes two panels up. The hint now states
 *   the one thing true of every suppressed contact and points at the tab that
 *   holds the per-contact reason.
 * - **On a call is new**, and on a stopped campaign it is usually a fault
 *   rather than a state — see {@link contactFunnel}.
 */
export const CONTACT_FUNNEL_STATES: readonly ContactFunnelState[] = [
  {
    key: 'contacts_completed',
    label: 'Completed',
    hint: 'Finished with a recorded call outcome.',
  },
  { key: 'contacts_in_flight', label: 'In flight', hint: 'Being dialed right now.' },
  {
    key: 'contacts_on_call',
    label: 'On a call',
    hint: 'Bridged to an agent right now.',
  },
  { key: 'contacts_pending', label: 'Waiting', hint: 'Not yet dialed, or waiting on a retry.' },
  {
    key: 'contacts_suppressed',
    label: 'Suppressed',
    hint: 'Nothing dials them again. The Contacts tab carries the reason for each.',
  },
  {
    key: 'contacts_exhausted',
    label: 'Exhausted',
    hint: 'Finished after every permitted retry was used.',
  },
] as const;

/**
 * What "On a call" means while the figure is still a subtraction.
 *
 * It replaces the plain hint whenever `derived` is true, because the plain one
 * ("Bridged to an agent right now") states as fact something we worked out by
 * elimination. The wording has to carry two things a supervisor needs: that the
 * number is inferred, and that the Contacts tab can confirm it — filtering that
 * tab by "On a call" lists the actual rows, which is the only way to check.
 */
const ON_CALL_DERIVED_HINT =
  'The contacts the other five counts do not cover. Filter the Contacts tab by '
  + '“On a call” to see which.';

/** A bucket the stats payload carries a counter for. */
type CountedKey = Exclude<ContactStateKey, 'contacts_on_call'>;

/**
 * The buckets the server actually counts — the terms of the subtraction below.
 *
 * `contacts_on_call` is excluded by its type because the stats payload has no
 * field for it; that absence is the gap {@link contactFunnel} closes.
 *
 * Written as a `Record` and reduced to a list rather than written as the list
 * directly, because **a `Record` key set is exhaustiveness-checked and an array
 * literal is not.** Add a seventh bucket to {@link ContactStateKey} and this
 * object fails to type-check until it is classified as counted or derived. Left
 * as an array, the new bucket would simply be missing from the sum and its
 * contacts would be silently attributed to "on a call" — the same class of
 * quiet drift {@link CONTACT_STATE_BUCKET} exists to stop, one layer down.
 */
const COUNTED: Record<CountedKey, true> = {
  contacts_completed: true,
  contacts_in_flight: true,
  contacts_pending: true,
  contacts_suppressed: true,
  contacts_exhausted: true,
};

const COUNTED_KEYS = Object.keys(COUNTED) as readonly CountedKey[];

export interface ContactFunnelCell extends ContactFunnelState {
  /** The raw count, or `null` when the field did not arrive. */
  count: number | null;
  /** {@link count} formatted, or `—`. */
  value: string;
  /** Share of the list, or `null` when there is no denominator to divide by. */
  percent: number | null;
  /** {@link percent} formatted, or `null`. The key drops the figure entirely. */
  percentLabel: string | null;
  /** Width of this state's segment as a percentage of the bar. */
  widthPercent: number;
  /**
   * True when {@link count} was worked out by subtraction rather than read.
   *
   * Only ever true for `contacts_on_call`, and only until the server carries the
   * field. It exists so the panel can mark the figure as inferred: it is the
   * one number here that is not a measurement, and the module's standing rule
   * is that a derived figure never passes itself off as a reading.
   */
  derived: boolean;
}

export interface ContactFunnel {
  /** `contacts_total`, or `null`. */
  total: number | null;
  /** {@link total} formatted, or `—`. */
  totalLabel: string;
  /**
   * The segments to DRAW — positive counts only, in bar order.
   *
   * A state with a real `0` is not drawn (there is nothing to see) but still
   * appears in {@link cells} with its zero, because "no contact is in flight" is
   * a fact worth reading. A state whose count did not arrive is drawn nowhere
   * and reads `—` in the key.
   *
   * A state with a **hairline** share — one contact in five thousand — stays in
   * this list rather than being rounded away. The stylesheet floors every
   * segment at 5px so it is still visible and still colour-matched to its
   * labelled row in the key; a segment silently dropped for being small is a
   * state a supervisor would conclude is empty.
   */
  segments: ContactFunnelCell[];
  /**
   * The states to LIST in the key, in bar order.
   *
   * Five always, plus `contacts_on_call` only when there is something to say
   * about it — a real count, or a derived one above zero. A sixth row reading
   * "On a call 0" on every stopped campaign in the workspace would be noise,
   * and worse, it would train a supervisor to skim past the row on the one
   * campaign where it is not zero.
   */
  cells: ContactFunnelCell[];
  /** False when there is no denominator, so the bar must not be drawn at all. */
  drawable: boolean;
  /** The bar's screen-reader description — it is a picture of the same numbers. */
  barLabel: string;
  /**
   * Contacts no listed cell accounts for, or `null`.
   *
   * The invariant this panel claims: **every contact is in a listed cell or in
   * here.** So while `contacts_on_call` is derived it is `0` by construction —
   * the remainder *is* that cell — and it only goes positive once the server carries
   * a real `contacts_on_call` that, with the five, still leaves something over.
   *
   * `null` means the question could not be asked: no total, a counter missing,
   * or five counters that carry no information (all a real zero against a
   * non-empty list). Any remainder then would be an artefact of the gap rather
   * than a fact about the campaign.
   *
   * A **negative** remainder never reaches here. Counts summing past the total
   * means the payload was assembled from two different moments, exactly as
   * {@link listWorkedRing} already guards for, and there is nothing to salvage:
   * {@link reconciles} goes false and the figure is withheld rather than shown
   * as a negative or clamped to zero.
   */
  unaccounted: number | null;
  /**
   * False only when the known counts exceed the total — an incoherent payload.
   * It is not the same question as `unaccounted === 0`: that is the ordinary,
   * healthy answer, and this is the one that withholds the bar entirely.
   */
  reconciles: boolean;
}

/**
 * The list's shape as one proportional bar plus its key.
 *
 * **One denominator, `contacts_total`.** The alternative — dividing by the sum
 * of the five states so the widths always fill the bar — silently invents a
 * different total from the one printed beside it whenever a field is missing,
 * and a bar that always reaches 100% cannot show that something did not load.
 * With `contacts_total` as the divisor a partial payload draws a short bar,
 * which is the true picture.
 */
export function contactFunnel(stats: AgencyCampaignStats | null): ContactFunnel {
  const total = typeof stats?.contacts_total === 'number' ? stats.contacts_total : null;
  // A zero-contact campaign has no proportions: 0/0 is not 0%. The bar is
  // withheld and the key shows the counts with no percentages.
  const drawable = total !== null && total > 0;

  /*
    The remainder, and the two conditions it needs to mean anything.

    Every one of the five counted buckets must have arrived. A partial payload
    also produces a short bar, and attributing that shortfall to "on a call"
    would turn a delivery problem into a confident claim about three customers
    being mid-conversation — the precise mistake this module's opening rule
    exists to prevent. If any counter is missing the remainder is unknowable and
    stays `null`.
  */
  const counted = COUNTED_KEYS.map((key) => stats?.[key]);
  const allCounted = counted.every((value): value is number => typeof value === 'number');
  const countedSum = allCounted ? counted.reduce((sum, value) => sum + value, 0) : null;

  /*
    Second condition, and a unit test is what found it.

    Every counted bucket being a real `0` against a non-empty list means the five
    counters have said nothing about where any contact is — and subtracting then
    attributes the WHOLE list to "on a call". A 500-contact campaign rendered
    "On a call 500 · 100%", which no concurrency limit in the product could
    produce and which reads as a confident measurement.

    This is not a magic threshold; it is the same rule the module opens with, one
    level up. A remainder is a claim derived from five readings, so five readings
    that carry no information cannot support one. A real campaign in that state
    has its contacts in `contacts_pending`, so a payload with all five at zero
    and a non-empty total is uninitialised, not a floor mid-conversation.
  */
  const countersInformative = countedSum !== null && (countedSum > 0 || total === 0);

  /*
    Prefer a reading over a derivation, always. `contacts_on_call` is not on the
    payload today, but it is the field the server would add to close this properly, so
    the moment it appears the subtraction stops being used — without a second
    change here.
  */
  const measuredOnCall = (stats as { contacts_on_call?: number } | null)?.contacts_on_call;
  const onCallMeasured = typeof measuredOnCall === 'number';

  /*
    The remainder is taken against everything KNOWN, which once the server carries
    `contacts_on_call` includes it.

    Summing only the five would leave `unaccounted` describing the gap the
    measured cell has already filled: The server sending `contacts_on_call: 2` where
    the five leave 3 would report 3 unaccounted beside a cell reading 2, and the
    genuinely unexplained 1 would go unnamed. Counting the measurement keeps one
    invariant true in both worlds — **every contact is in a listed cell or in
    `unaccounted`** — which is the whole claim this panel now makes.
  */
  const accountedSum = countedSum === null
    ? null
    : countedSum + (onCallMeasured ? measuredOnCall : 0);

  const rawRemainder = total !== null && accountedSum !== null && countersInformative
    ? total - accountedSum
    : null;
  const reconciles = rawRemainder === null || rawRemainder >= 0;
  const remainder = rawRemainder !== null && rawRemainder >= 0 ? rawRemainder : null;

  // Derived, the remainder IS the on-call count, so nothing is left over by
  // construction. Measured, the remainder is whatever neither it nor the five
  // explain.
  const onCallCount = onCallMeasured ? measuredOnCall : remainder;
  const unaccounted = onCallMeasured ? remainder : (remainder === null ? null : 0);

  const cells: ContactFunnelCell[] = CONTACT_FUNNEL_STATES.map((state) => {
    const derived = state.key === 'contacts_on_call' && !onCallMeasured;
    const raw = state.key === 'contacts_on_call' ? onCallCount : stats?.[state.key];
    const value = typeof raw === 'number' ? raw : null;
    const percent = drawable && value !== null ? (value / total) * 100 : null;
    return {
      ...state,
      hint: derived ? ON_CALL_DERIVED_HINT : state.hint,
      count: value,
      value: value === null ? DASH : value.toLocaleString(),
      percent,
      percentLabel: percent === null ? null : pct(percent),
      widthPercent: percent === null ? 0 : percent,
      derived,
    };
  });

  /*
    "On a call" earns its row only when it has something to say. A measured
    zero is still a fact worth reading — so it stays once the server carries the field
    — but a *derived* zero says only "the buckets reconcile", which the absence
    of the row already says more quietly.
  */
  const listed = cells.filter(
    (cell) =>
      cell.key !== 'contacts_on_call'
      || onCallMeasured
      || (cell.count !== null && cell.count > 0),
  );

  /*
    No bar at all on an incoherent payload, and this is load-bearing rather than
    tidy.

    `.funnelSeg` is `flex: 0 1 auto`. `flex-grow: 0` is what makes the module's
    central promise true — segments summing to 91.7% draw a bar that stops at
    91.7%, because nothing grows to fill the track. But `flex-shrink: 1` means
    the converse does NOT hold: segments summing past 100% are shrunk by
    flexbox, proportionally, until they fit — which renders exactly the
    always-full bar this module refuses to compute, arrived at through the
    stylesheet instead of the arithmetic.

    So the counts stay (they are the raw facts, and their percentages summing
    past 100% is the evidence), and the picture is withheld. Same answer
    `listWorkedRing` already gives the same payload: one of these numbers is
    from a different moment, and there is nothing to draw from it.
  */
  const segments = reconciles
    ? listed.filter((cell) => cell.count !== null && cell.count > 0 && drawable)
    : [];

  return {
    total,
    totalLabel: total === null ? DASH : total.toLocaleString(),
    segments,
    cells: listed,
    drawable,
    barLabel: segments.length === 0
      ? 'No contacts to show yet.'
      : segments.map((s) => `${s.label} ${s.value}`).join('; '),
    unaccounted,
    reconciles,
  };
}

/**
 * Why there is no bar, or `null` when there is one.
 *
 * Three reasons, and they were two inline ternaries in the page before the third
 * existed. Moved here because the third is the one that needs explaining and a
 * page is where an explanation goes unread.
 */
export function funnelBarWithheldNote(funnel: ContactFunnel): string | null {
  if (!funnel.reconciles) {
    // Deliberately does not say WHICH count is wrong: from here every one of
    // the six is equally suspect, and naming one would be a guess that sends
    // somebody looking in the wrong place.
    return 'These counts do not add up to the contact total, so the shape is not drawn. '
      + 'One of them was read at a different moment — reload to get a consistent set.';
  }
  if (funnel.total === null) return 'The contact counts didn’t load, so there is no shape to draw.';
  if (!funnel.drawable) return 'No contacts have been added to this campaign yet.';
  if (funnel.segments.length === 0) {
    /*
      "No contact has reached any of these states yet" is what this said, and on
      a campaign WITH contacts it is never a supportable reading — the module's
      own opening rule, broken in the sentence that reports it.

      Every contact is in exactly one of the six states by construction, so a
      positive total with nothing in any state cannot describe a real campaign.
      Two payloads reach here and both are "we do not know where they are":

        - a counter that did not arrive, with every counter that did at zero —
          the missing bucket may hold the entire roster (`contacts_pending`
          absent is the likely shape, and the likely holder);
        - every counter arriving as a real zero against a non-empty total, the
          uninitialised stats row `countersInformative` already refuses to
          subtract from.

      They share a message because they share the only next step a supervisor
      has. Distinguishing them would name a cause the browser cannot see, which
      is the same mistake one function down.
    */
    return `None of the state counts account for the ${funnel.totalLabel} contacts on this `
      + 'campaign, so there is no shape to draw. Reload — if the counts stay empty they have '
      + 'not been written for this campaign yet.';
  }
  return null;
}

/**
 * The sentence beneath the funnel when contacts are on a call, or `null`.
 *
 * **The same count means two different things and only one of them is a
 * state.** On a running campaign, contacts bridged to agents is the system
 * working; there is nothing to say and this returns `null`. On a campaign that
 * has finished, a contact still on a call is a contradiction — the panel above
 * is badged "Final", the pulse strip says nobody is still on the line, and the
 * account is using no lines — so the row is a fault, not a state.
 *
 * Observed on production: three contacts sat in `connected` on a campaign
 * stopped at 09:44, each with its attempt already closed, dispositioned, and
 * carrying a real talk time. The calls had finished; only the contact rows were
 * never advanced. Nothing on any screen said so, and there is no supervisor
 * control that releases them — so the honest thing this can do is name it and
 * say who can act.
 *
 * ── Takes the ENDING, not a `terminal` boolean ──────────────────────────────
 *
 * The boolean collapsed `completed` into `stopped` and the sentence then said
 * so out loud: a **Completed** campaign, badged two inches above this note, was
 * told it "has stopped". That is the same conflation this file spends
 * `campaignTimeline` and `howItEndedLines` keeping apart, reintroduced on a new
 * surface. The two endings also differ in what a stuck row MEANS — a campaign
 * that ran out of contacts and one an operator halted mid-floor are different
 * events — so the ending is worth a word rather than a shared euphemism.
 *
 * ── What it no longer claims ────────────────────────────────────────────────
 *
 * It used to add "The calls themselves have ended." That was true of the three
 * production rows this note was written for, and it is not something this
 * function can see: it reads a derived remainder, not `attempts_live`, attempt
 * state or talk time. Stopping a campaign stops NEW dialing and lets calls in
 * progress finish, so on the seconds-to-minutes after a stop the sentence is
 * confidently false about a perfectly ordinary floor. The first clause was
 * always the honest one — these contacts are *marked* as being on a call — and
 * the docstring above already promised not to diagnose a cause.
 */
export function onCallNote(
  funnel: ContactFunnel,
  ending: CampaignEnding | null,
): string | null {
  if (ending === null) return null;
  const cell = funnel.cells.find((c) => c.key === 'contacts_on_call');
  if (!cell || cell.count === null || cell.count === 0) return null;

  const noun = cell.count === 1 ? 'contact is' : 'contacts are';
  const where = ending === 'completed'
    ? 'a campaign that has finished'
    : 'a campaign that was stopped';
  return `${cell.value} ${noun} still marked as being on a call, on ${where}. `
    + 'Support can clear the rows.';
}

/**
 * Waiting contacts that are queued retries.
 *
 * The note exists because "Waiting" is read as "dialable now" and a queued
 * retry is not — it is scheduled, possibly hours out. Returns `null` for a real
 * `0` as well as for an absent field: with no retry queued there is nothing to
 * warn about, and "0 of the waiting contacts are queued retries" is a sentence
 * that costs a supervisor a read to learn nothing.
 */
export function retriesNote(stats: AgencyCampaignStats | null): string | null {
  const pending = stats?.retries_pending;
  if (typeof pending !== 'number' || pending <= 0) return null;
  const noun = pending === 1 ? 'contact is a queued retry' : 'contacts are queued retries';
  return `${pending.toLocaleString()} of the waiting ${noun} — scheduled for a later attempt, `
    + 'possibly hours away.';
}

// ── The "list worked" ring ──────────────────────────────────────────────────

export const RING_RADIUS = 30;
export const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export interface ListWorkedRing {
  known: boolean;
  /** The share of the list that will never be dialed again, or `null`. */
  percent: number | null;
  /** {@link percent} formatted for the middle of the ring, or `—`. */
  label: string;
  /** `N of M contacts`, or a sentence saying why there is no figure. */
  caption: string;
  /** The arc's `stroke-dasharray`. `0` draws nothing, which is correct. */
  dashArray: string;
}

/**
 * How much of the list is finished with — completed, suppressed or exhausted.
 *
 * Those three and no others: they are the states nothing dials again. `pending`
 * and `in_flight` are both still ahead of the dialer, and counting in-flight
 * calls as worked would make the ring tick backwards when a call ends and its
 * contact returns to the queue for a retry.
 *
 * All three components AND the total are required. A ring drawn from two of
 * three understates the campaign by an unknowable amount while looking exactly
 * as authoritative as a complete one.
 */
export function listWorkedRing(stats: AgencyCampaignStats | null): ListWorkedRing {
  const total = stats?.contacts_total;
  const parts = [stats?.contacts_completed, stats?.contacts_suppressed, stats?.contacts_exhausted];

  const unknown = (caption: string): ListWorkedRing => ({
    known: false,
    percent: null,
    label: DASH,
    caption,
    dashArray: `0 ${RING_CIRCUMFERENCE.toFixed(1)}`,
  });

  if (typeof total !== 'number' || parts.some((p) => typeof p !== 'number')) {
    return unknown('The contact counts didn’t load.');
  }
  if (total <= 0) {
    // Not 0% worked — there is no list to have worked through.
    return unknown('No contacts have been added to this campaign yet.');
  }

  const worked = (parts as number[]).reduce((sum, p) => sum + p, 0);
  /*
    More contacts finished than exist. Not a state the server produces, but a payload
    assembled mid-deploy from two versions is, and the arc was already clamped
    while the number beside it was not — so the ring drew a full circle with
    "160%" in the middle of it and captioned it "16 of 10 contacts".

    Nothing here is salvageable: a percentage over 100 is not a rounding error,
    it means one of the four counts is from a different read. The module's other
    guard against exactly this (`retriesPlacedSub`, "a screen nobody can act on,
    so it says nothing instead") takes the same way out.
  */
  if (worked > total) {
    return unknown('These counts don’t add up yet — they were read a moment apart.');
  }

  const percent = (worked / total) * 100;
  const dash = (RING_CIRCUMFERENCE * Math.min(Math.max(percent, 0), 100)) / 100;

  return {
    known: true,
    percent,
    label: `${Math.round(percent)}%`,
    caption: `${worked.toLocaleString()} of ${total.toLocaleString()} contacts`,
    dashArray: `${dash.toFixed(1)} ${RING_CIRCUMFERENCE.toFixed(1)}`,
  };
}

// ── The pulse strip ─────────────────────────────────────────────────────────

export interface PulseFigures {
  /** `attempts_total` — every call placed, retries included. */
  dials: OverviewFigure;
  /** `attempts_connected` — attempts that reached anybody at all. */
  reached: OverviewFigure;
  /** `human_connects`, carrying `connect_rate_pct`, which is its own rate. */
  humans: OverviewFigure;
  /** `attempts_success`, carrying `success_rate_pct`. */
  wins: OverviewFigure;
  /** `attempts_live`, carrying the floor behind it. */
  live: OverviewFigure;
}

export function pulseFigures(stats: AgencyCampaignStats | null): PulseFigures {
  const floor = floorSummary(stats);
  // One predicate, shared with the Performance section. See `rateSub`.
  const withheld = ratesWithheld(stats);

  return {
    dials: {
      ...count(stats?.attempts_total),
      /*
        `attempts_total` silently includes retries. A supervisor reading "6,742
        dials" against a 2,100-contact list has no way to reconcile the two, and
        the reconciliation they reach for — the list was dialed three times over
        — is wrong. See `retriesPlacedSub`.
      */
      sub: retriesPlacedSub(stats),
    },
    /*
      Deliberately no sub-line. The only rate on the payload whose numerator
      could sit above it is `connect_rate_pct`, and that rate counts
      `human_connects` — a smaller number than this cell's. It belongs to the
      cell below.
    */
    reached: count(stats?.attempts_connected),
    humans: {
      ...count(stats?.human_connects),
      sub: rateSub(stats?.connect_rate_pct, 'of dials placed', withheld),
    },
    wins: {
      ...count(stats?.attempts_success),
      sub: rateSub(stats?.success_rate_pct, 'of calls that reached someone', withheld),
    },
    live: {
      ...count(stats?.attempts_live),
      sub: floor.shiftSub,
    },
  };
}

/**
 * "including 1,922 retries", or `null`.
 *
 * ── Why a `0` produces no line ─────────────────────────────────────────────
 * A campaign with nothing retried does not need to be told so beneath its dial
 * count: "including 0 retries" costs a read and settles a question nobody asked.
 * That is the same rule {@link retriesNote} applies to the queue, and unlike the
 * rates above it is a rule about USEFULNESS, not about honesty — the `0` here
 * is a real measurement.
 *
 * ── Why an absent field produces no line either ────────────────────────────
 * `attempts_retried` is one of the two NICE-TO-HAVE fields on this payload, so
 * an older server simply does not send it. There is nothing to
 * fall back on: retries cannot be derived from any other field here, and
 * `retries_pending` counts a different population entirely (what is queued, not
 * what was placed). So the line is dropped, and the dial count reads exactly as
 * it did before the field existed.
 *
 * Guarded against a retry count above the total, which is not a number the server can
 * produce but is one a mid-deploy pairing of two versions could: "including
 * 8,000 retries" under "6,742 dials" is a screen nobody can act on, so it says
 * nothing instead.
 */
function retriesPlacedSub(stats: AgencyCampaignStats | null): string | null {
  const retried = stats?.attempts_retried;
  if (typeof retried !== 'number' || retried <= 0) return null;
  const total = stats?.attempts_total;
  if (typeof total === 'number' && retried > total) return null;
  return `including ${retried.toLocaleString()} ${retried === 1 ? 'retry' : 'retries'}`;
}

// ── The live floor, as the rail reads it ────────────────────────────────────

/**
 * Bar order for the floor: busiest first, and `offline` is absent entirely.
 *
 * An agent who signed out is not on shift — the same rule the server's `shift_seconds`
 * applies and the same one `foldOccupancy` keeps on the agent performance page.
 * Including them would dilute every share by signed-out time and make "3 of 9
 * free" a fraction of a floor that is not there.
 */
const FLOOR_BAR_ORDER: readonly AgencyAgentLiveState[] = [
  'on_call',
  'wrapup',
  'reserved',
  'available',
  'break',
] as const;

export interface FloorSlice {
  state: AgencyAgentLiveState;
  label: string;
  count: number;
  /** Share of the agents on shift. */
  percent: number;
}

export interface FloorSummary {
  /** True only when the payload carried a floor to describe. */
  known: boolean;
  /** Agents on shift — every state except `offline` — or `null`. */
  onShift: number | null;
  /** {@link onShift} formatted, or `—`. */
  onShiftLabel: string;
  /** Positive states only, in bar order. */
  slices: FloorSlice[];
  /** `N agents on shift · M free`, or `null` when neither figure is known. */
  shiftSub: string | null;
}

/**
 * The floor as a bar and a key.
 *
 * `agents_by_state` is preferred over `agents_live` because it is the only one
 * of the two that can answer "how many are FREE", and because summing it lets
 * `offline` be excluded from the shift. `agents_live` is the fallback for a
 * payload that predates the per-state roster: it yields a total with no
 * breakdown, which draws no bar and says only what it knows.
 */
export function floorSummary(stats: AgencyCampaignStats | null): FloorSummary {
  const byState = stats?.agents_by_state;

  if (!byState) {
    const live = stats?.agents_live;
    if (typeof live !== 'number') {
      return { known: false, onShift: null, onShiftLabel: DASH, slices: [], shiftSub: null };
    }
    return {
      known: true,
      onShift: live,
      onShiftLabel: live.toLocaleString(),
      slices: [],
      shiftSub: `${live.toLocaleString()} ${live === 1 ? 'agent' : 'agents'} on shift`,
    };
  }

  const onShift = FLOOR_BAR_ORDER.reduce((sum, state) => sum + (byState[state] ?? 0), 0);
  const slices = FLOOR_BAR_ORDER.flatMap<FloorSlice>((state) => {
    const value = byState[state] ?? 0;
    if (value <= 0) return [];
    return [
      {
        state,
        label: AGENCY_FLOOR_STATE_LABELS[state],
        count: value,
        percent: onShift > 0 ? (value / onShift) * 100 : 0,
      },
    ];
  });

  const free = byState.available ?? 0;
  return {
    known: true,
    onShift,
    onShiftLabel: onShift.toLocaleString(),
    slices,
    shiftSub: `${onShift.toLocaleString()} ${onShift === 1 ? 'agent' : 'agents'} on shift · `
      + `${free.toLocaleString()} free`,
  };
}

// ── "How it ran" ────────────────────────────────────────────────────────────

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
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = seconds / 60;
  const rounded = Number(minutes.toFixed(1));
  return `${rounded} ${rounded === 1 ? 'minute' : 'minutes'}`;
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
 * Not `formatDate` from `utils/format`, which is date-only: the header line is
 * read beside "Updated 10:23" and a start with no clock on it invites the reader
 * to assume midnight. The reader's own locale and zone, deliberately — this is a
 * wall-clock fact about when somebody pressed a button, not a bucket boundary,
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
  const date = at.toLocaleDateString(
    undefined,
    sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' },
  );
  return `${date}, ${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
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
  if (total < 60) return total === 1 ? '1 second' : `${total} seconds`;

  const plural = (value: number, noun: string) =>
    `${value.toLocaleString()} ${value === 1 ? noun : `${noun}s`}`;

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
    worth a line. See the field's own note.
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
        : rawActor.name;

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
      value: peak === 0 ? 'None' : peak.toLocaleString(),
    });
  }

  return lines;
}

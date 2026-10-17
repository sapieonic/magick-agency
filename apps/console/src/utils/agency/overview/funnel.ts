import type { AgencyCampaignStats } from '../../../types/agency-campaign';
import type { AgencyContactState } from '../../../types/agency-spine';
import type { CampaignEnding } from '../../agencyCampaignControls';
import { formatCount, pct } from '../../format/number';
import { DASH } from './figure';

/*
  The contact funnel: where every contact on the list is, the bar and its key,
  and the notes that qualify it (who is on a call, retries queued). Out of
  `agencyCampaignOverview.ts`, which re-exports everything here.
*/

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
      value: value === null ? DASH : formatCount(value),
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
    totalLabel: total === null ? DASH : formatCount(total),
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
  return `${formatCount(pending)} of the waiting ${noun} — scheduled for a later attempt, `
    + 'possibly hours away.';
}

// ── The "list worked" ring ──────────────────────────────────────────────────

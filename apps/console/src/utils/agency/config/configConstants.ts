import {
  AGENCY_DEFAULT_DISPOSITION_CATALOG,
  AGENCY_DEFAULT_DISPOSITION_RETRY,
  AGENCY_OUR_FAULT_REDIAL_BOUND,
  AGENCY_OUR_FAULT_RETRY_DEFAULT,
  type AgencyDispositionEntry,
  type AgencyRetryOutcome,
  type AgencyRetryPolicy,
  type AgencyRetryRule,
} from '../../../types/agency-campaign';

/*
  The campaign builder's vocabulary: the built-in outcomes and their flags, the
  retry outcomes and what the form shows for each, the defaults (the contract's,
  read here) and the form's state shapes. Out of `agencyCampaignConfigForm.ts`,
  which re-exports everything here.
*/

/**
 * The three codes calls "built in".
 *
 * **They are conventions, not dependencies** — the API's validator proves it:
 * every mechanism keys on a *flag* (`retry`, `requires_datetime`, `suppress`),
 * not on the string, and an empty catalog is a legal configuration meaning
 * "agents do not disposition on this campaign". So the UI locks them against
 * deletion because removing one silently removes a capability an agent needs,
 * and says exactly that inline — it does not claim the server will refuse.
 */
export const BUILT_IN_CODES = ['voicemail', 'callback', 'do_not_call'] as const;

export const BUILT_IN_LOCK_COPY: Record<(typeof BUILT_IN_CODES)[number], string> = {
  voicemail:
    'Voicemail is how a voicemail is recorded at all — with answering-machine detection off, an agent’s disposition is the only signal we get.',
  callback: 'Callback is the only disposition that can schedule a call for later.',
  do_not_call: 'Do not call is how an agent suppresses a contact from the pad.',
};

export function isBuiltInCode(code: string): boolean {
  return (BUILT_IN_CODES as readonly string[]).includes(code);
}

/**
 * The five disposition flags, each with the sentence that says what it DOES.
 *
 * The editor used to render them as five bare checkbox labels in a wrapping
 * row — "Ends this contact" beside "Stops calling this contact", which are
 * different things by exactly the distinction the labels omit. The blurb is
 * not decoration: `terminal` finishes the contact on THIS campaign, `suppress`
 * suppresses the contact outright, and nothing on screen said so.
 *
 * Ordered by how consequential they are, which is also roughly the order an
 * operator asks about them.
 */
export const DISPOSITION_FLAGS = [
  {
    flag: 'is_success',
    title: 'Counts as a success',
    blurb: 'Included in this campaign’s success rate.',
  },
  {
    flag: 'requires_note',
    title: 'Needs a note',
    blurb: 'The agent has to type something before the outcome will save.',
  },
  {
    flag: 'requires_datetime',
    title: 'Needs a callback time',
    blurb: 'The agent picks a date and time, and we call the contact back then.',
  },
  {
    flag: 'terminal',
    title: 'Ends this contact',
    blurb: 'Finished on this campaign — no further attempts, whatever is left.',
  },
  {
    flag: 'suppress',
    title: 'Stops calling this contact',
    blurb: 'Suppressed outright. Stronger than ending them, and not undone by a retry.',
  },
] as const satisfies readonly {
  flag: keyof AgencyDispositionEntry;
  title: string;
  blurb: string;
}[];

/**
 * Shown when both `suppress` and `terminal` are set on one entry.
 *
 * Not an error — the pair is legal and the API stores it. It is that
 * `terminal` is unreachable beside it: The server's `resolveDispositionDecision`
 * checks `suppress` first and returns, so the second flag changes nothing
 * while the first is set, and quietly downgrades the outcome from
 * `suppressed` to `completed` if the first is ever cleared. The default
 * `do_not_call` entry carries `suppress` alone for exactly this reason.
 */
export const SUPPRESS_BEATS_TERMINAL_NOTE =
  'Stopping the contact already ends them — “Ends this contact” adds nothing while it is on, and ' +
  'would quietly weaken this outcome if you ever turned stopping off.';

/**
 * Outcomes this TABLE shows, which is no longer identical to what the API accepts.
 *
 * `invalid` stays listed on purpose even though the API now refuses it as
 * a policy key: the row is how an operator is TOLD an invalid number is never
 * retried, and the design argument is that hiding it invites them to assume the
 * opposite. It renders as a fixed "Fixed at 0" cell with no inputs, so nothing
 * here can set it, and {@link NEVER_SENT_RETRY_OUTCOMES} keeps it out of the
 * payload. Showing a key we do not send is the intended asymmetry; sending one
 * the API refuses is not.
 *
 * `agent_disconnected` is an ordinary editable row: the API
 * accepts it, the server ships a real default, and the dialer runtime's dial path genuinely reads
 * the campaign's value. It was absent from this table until an audit of the
 * API/dialer seam found the gap.
 *
 * **`orphaned` is deliberately NOT listed, even though the API accepts it.**
 * The server validates the key and stores it, and ships a `DEFAULT_RETRY_POLICY`
 * entry for it — which is exactly what makes it look safe to expose. But nothing
 * in the server ever reads a campaign's `retry_policy.orphaned`: the only producer that
 * consults a policy for it is the reaper, and it passes `null` on purpose
 * (`reaper.ts` — "crash recovery wants the contact dialable as soon as the roster
 * reaches it"), taking only the bound. `agency-dialer.ts` gates its policy read on
 * `outcome === 'agent_disconnected'`. So a row here would be a control an operator
 * can set, save and see persisted, that changes nothing — the silently-inert class
 * `NEVER_SENT_RETRY_OUTCOMES` exists to refuse. Adding it back needs a server change
 * first, not a console one.
 *
 * **`canceled` IS listed**, and the test that separates it from
 * `orphaned` is the one stated above: does the server read a campaign's value for it?
 * It does. A cancelled dial is never bridged, so the server's `ended` handler always
 * routes it to `resolveOurFaultRedial`, and that function reads
 * `policy?.canceled` for both a stricter cap and the delay. So this row is a
 * live lever, unlike `orphaned`'s, which the reaper deliberately passes `null`
 * past.
 */
export const RETRY_OUTCOMES = [
  'no_answer',
  'busy',
  'failed',
  'abandoned',
  'invalid',
  'connected',
  'agent_disconnected',
  'canceled',
] as const satisfies readonly AgencyRetryOutcome[];

/**
 * Exhaustiveness in the OTHER direction, with the one deliberate exclusion named.
 *
 * `satisfies` alone proves only that this table holds *valid* outcomes, never
 * *all* of them — so an outcome added to `AgencyRetryOutcome` and forgotten here
 * would compile, be a real value of the type, and simply never appear in the
 * retry form. That is the same drift this change is repairing (`canceled` was
 * added to the server's vocabulary and had to be chased into three separate lists by
 * hand), and the same failure found earlier in the error-code union — which is
 * why `AGENCY_ACTION_ERROR_CODES` already carries this exact guard, and why
 * `RETRY_SELECTOR_KEYS` is a `Record` rather than an array.
 *
 * `orphaned` is subtracted rather than listed, because its absence from the table
 * is a decision and not an oversight: nothing in the server reads a campaign's
 * `retry_policy.orphaned`, so a row for it would be a control that does nothing
 * (see the long note above). Naming it HERE is what makes that distinguishable —
 * before this guard, "deliberately excluded" and "forgotten" looked identical to
 * the compiler. A future outcome that should also be hidden must be added to this
 * exclusion explicitly, which is the point: the omission stops being silent.
 */
type UnclassifiedRetryOutcome = Exclude<
  AgencyRetryOutcome,
  (typeof RETRY_OUTCOMES)[number] | 'orphaned'
>;

const _allRetryOutcomesClassified: UnclassifiedRetryOutcome extends never
  ? true
  : UnclassifiedRetryOutcome = true;
void _allRetryOutcomesClassified;

/**
 * The two outcomes shown as fixed at zero with a reason rather than hidden
 *. Hiding them invites the operator to assume they retry.
 */
export const FIXED_ZERO_OUTCOMES: AgencyRetryOutcome[] = ['invalid', 'connected'];

/**
 * The outcomes that are OUR fault, not the customer's (plus `canceled` from the 2026-09-08 pilot).
 *
 * Editable, because the point of exposing them is that an operator CAN tune the
 * cap — but the direction is one-way and that is what the copy has to say. The server
 * takes `min(configured, OUR_FAULT_REDIAL_BOUND)`, so these rows can only ever
 * LOWER the platform bound, never raise it.
 *
 * ⚠️ The two members reach that bound differently, and the copy is written to be
 * true of both. `agent_disconnected` is our fault only BEFORE the bridge — after
 * it, the cap set here is the customer's own allowance instead — whereas
 * `canceled` is never bridged by construction, so its row is *only* ever about
 * the our-fault ledger. Naming it here is what gives it the seeded default, the
 * "(our fault)" label and the zero warning; a plain editable row would let an
 * operator type `0` into a control whose consequence is a contact retired for
 * good.
 */
export const OUR_FAULT_RETRY_OUTCOMES: AgencyRetryOutcome[] = ['agent_disconnected', 'canceled'];

/**
 * What the server uses for an our-fault row the campaign leaves unset.
 *
 * The contract's `AGENCY_OUR_FAULT_RETRY_DEFAULT` — the server's
 * `DEFAULT_RETRY_POLICY.agent_disconnected` is pinned equal to it by a server test.
 * It exists so the editor can SEED a fresh row with it rather than with zero.
 *
 * It is the right seed for `canceled` too, by a different derivation that lands
 * on the same pair: that outcome never reaches `DEFAULT_RETRY_POLICY` at all
 * (`resolveOurFaultRedial` is its only reader and consults the campaign's policy
 * only), so an unset row falls back to the server's
 * `DEFAULT_OUR_FAULT_REDIAL_DELAY_MINUTES` (5) and `OUR_FAULT_REDIAL_BOUND` (3).
 * Do not "correct" this against `DEFAULT_RETRY_POLICY.canceled`'s `delay_minutes:
 * 0` — that entry is a fallback the server documents as unread, and seeding 0 here
 * would preview a cadence no path produces.
 *
 * ── Why zero is not a safe seed here ────────────────────────────────────────
 * The server reads `min(configured, OUR_FAULT_REDIAL_BOUND)` and then retires the
 * contact the moment `ourFaultAttemptsUsed >= effectiveBound`. A configured `0`
 * therefore means **the first agent-side drop before the call connects retires
 * that contact permanently** — never dialed again, customer allowance untouched.
 *
 * The server guards its own side of this: an *absent* config falls back to the bound
 * precisely so "a malformed policy would [not] silently retire every our-fault
 * contact on its first drop". Seeding a UI row with `0` manufactures the
 * explicit value the server refuses to infer — and it did so from a keystroke in the
 * *delay* box, because the seed supplied `max_attempts` the operator never
 * typed.
 */
export const OUR_FAULT_RETRY_DEFAULT: Readonly<AgencyRetryRule> = AGENCY_OUR_FAULT_RETRY_DEFAULT;

/**
 * The platform-wide ceiling the server clamps an our-fault row to — the
 * contract's `AGENCY_OUR_FAULT_REDIAL_BOUND`, which the server reads too. Used for
 * copy only — never sent.
 */
export const OUR_FAULT_REDIAL_BOUND = AGENCY_OUR_FAULT_REDIAL_BOUND;

export const OUTCOME_LABELS: Record<AgencyRetryOutcome, string> = {
  no_answer: 'No answer',
  busy: 'Busy',
  failed: 'Failed',
  abandoned: 'Abandoned (nobody free)',
  invalid: 'Invalid number',
  connected: 'Connected',
  agent_disconnected: 'Agent disconnected (our fault)',
  orphaned: 'Orphaned by a restart (our fault)',
  // "Before answer" is the load-bearing half — it is what separates this row
  // from `no_answer` two rows up, which is the customer letting it ring out.
  // The suffix marks the ledger, matching the other our-fault rows.
  // Head phrase mirrors the spine's `OUTCOME_COPY` word-for-word ("Stopped by us
  // before answer"), which names the actor; the `(our fault)` suffix is kept
  // because it is what visually groups this row with `agent_disconnected` in the
  // our-fault ledger family. Redundant with "by us" on purpose — the grouping is
  // worth more than the four words.
  canceled: 'Stopped by us before answer (our fault)',
};

/**
 * Why `agent_disconnected` and `orphaned` get a row at all, and — the part an
 * operator would otherwise have no way to know — what the number they set here
 * does and does not cover.
 *
 * Both outcomes are genuinely produced by the server: an agent's station socket
 * dropping mid-call settles the attempt `agent_disconnected`
 * (`agency-dialer.ts`), and an attempt whose owning replica died holding it is
 * swept `orphaned` by the reaper. Neither is something the person being called
 * did, which is the whole reason this copy exists — a customer reading "why did
 * you call me a third time" deserves an answer that is not "you were busy
 * twice."
 *
 * **The cap set in this row is the CUSTOMER's allowance, and it governs only a
 * drop that happened AFTER the call bridged.** A drop BEFORE the bridge is
 * charged to a separate our-fault ledger and bounded by a platform-wide limit
 * (The server's `OUR_FAULT_REDIAL_BOUND`) that this form does not expose and cannot
 * raise — a regulated repeat-dial limit an operator could raise here would not
 * be a limit. Raising the number in this row only changes how many of the
 * customer's OWN retries an our-fault drop may spend; it cannot loosen the
 * separate bound on our-fault redials that happen before an agent ever picks
 * up.
 *
 * ── `canceled` joins them, and reads the paragraph above differently ─────────
 *
 * A dial we stopped while the phone was still ringing. It is our fault by the
 * same test — the person being called did nothing — and the server charges it to the
 * same `our_fault_attempts` ledger. What differs is that a cancel is never
 * bridged, so the "AFTER the call bridged" half above can never apply to it: its
 * row is *only* ever the bound-lowering control, never the customer's allowance.
 * The copy below is therefore written to be true of both rows rather than
 * split — the sentence that matters (you may only lower it, and 0 retires the
 * contact) is identical for each, and two callouts under one table would be read
 * as one.
 */
export const OUR_FAULT_RETRY_COPY =
  'Our fault, not the customer’s — an agent-side drop, or a dial we stopped before anyone ' +
  'picked up, is not something the person being called did. Leave these alone and we redial up ' +
  `to ${OUR_FAULT_REDIAL_BOUND} times, which is also the platform limit. You can only LOWER it ` +
  'here, never raise it — and lowering it to 0 means the first one before a call connects ' +
  'retires that contact for good, without anyone having spoken to them.';

/**
 * Shown on the row itself when the operator has actually set the bound to zero.
 *
 * Separate from {@link OUR_FAULT_RETRY_COPY} because it is a consequence, not a
 * description: 0 is a legitimate choice ("never redial our own faults") whose
 * effect — a permanently retired contact — is not what the word "0" suggests
 * next to a field labelled "attempts".
 *
 * Worded for the ROW it sits in rather than for one outcome ("one of these"),
 * because it renders on any {@link OUR_FAULT_RETRY_OUTCOMES} row and the row's
 * own label — two inches to the left — is what names which failure is meant.
 * Naming `agent_disconnected` here made it wrong on the `canceled` row.
 */
export const OUR_FAULT_ZERO_WARNING =
  'With 0, one of these before the call connects retires the contact permanently — it is '
  + 'never dialed again, and the customer’s own retry allowance is left unused.';

export const FIXED_ZERO_COPY: Record<'invalid' | 'connected', string> = {
  invalid: 'An invalid number does not become valid on a retry.',
  connected: 'A connected call is finished — what happens next is the agent’s disposition.',
};

/**
 * Voicemail retry lives on the DISPOSITION, not here, and it is genuinely
 * surprising enough to say out loud.
 */
export const VOICEMAIL_RETRY_COPY =
  'With answering-machine detection off, we never classify a call as “machine” — a call picked up by voicemail is “connected”. So voicemail retry lives on the voicemail disposition, not in this table.';

export interface CallingWindowState {
  start: string;
  end: string;
  /** ISO-8601: 1 = Monday … 7 = Sunday. */
  days: number[];
  timezone: string;
}

export interface CampaignConfigState {
  dispositions: AgencyDispositionEntry[];
  retryPolicy: AgencyRetryPolicy;
  window: CallingWindowState;
  wrapupSeconds: number;
  autoReturn: boolean;
}

/**
 * The retry rule the server ships on the built-in `voicemail` disposition (the
 * contract's `AGENCY_DEFAULT_DISPOSITION_RETRY`).
 *
 * Named because it is used twice: as that entry's default, and as the seed when
 * an operator switches a disposition's own retry ON in the editor. Seeding from
 * zero would be worse than useless there — `max_attempts: 0` is a rule that
 * never fires, so turning the control on would appear to do nothing.
 */
export const DEFAULT_DISPOSITION_RETRY: Readonly<AgencyRetryRule> = AGENCY_DEFAULT_DISPOSITION_RETRY;

/**
 * What the API seeds a new campaign's catalog with, so the UI starts identically.
 *
 * ── `do_not_call` carries `suppress` and NOT `terminal` ──────────────────────
 * This copy previously added `terminal: true`, and it was the wrong one of the
 * three. The server's `resolveDispositionDecision` checks `suppress` **first** and
 * returns before `terminal` is ever read ('s precedence: suppress beats
 * terminal beats callback beats disposition-retry), so on this entry `terminal`
 * is structurally unreachable — it cannot fire while `suppress` is set, and if
 * an operator ever clears `suppress` the leftover flag quietly downgrades a
 * do-not-call from `suppressed` to `completed`, which is the weaker outcome.
 *
 * The compliance worry runs the other way round from how it reads: it is
 * `suppress`, not `terminal`, that stops the number being retried, and the server's
 * `builtInSemanticMismatches` flags exactly that flag's absence. There is one
 * declaration now: the contract's `AGENCY_DEFAULT_DISPOSITION_CATALOG`, which the
 * server's `BUILT_IN_DISPOSITIONS` and `DEFAULT_DISPOSITION_CATALOG` also are.
 * Frozen, so every form copies it through {@link cloneDisposition}.
 */
export const DEFAULT_DISPOSITIONS: readonly AgencyDispositionEntry[] = AGENCY_DEFAULT_DISPOSITION_CATALOG;

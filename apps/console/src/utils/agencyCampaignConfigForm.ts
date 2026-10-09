import type {
  AgencyCampaign,
  AgencyDispositionEntry,
  AgencyRetryOutcome,
  AgencyRetryPolicy,
  AgencyRetryRule,
} from '../types/agency-campaign';

/**
 * Campaign configuration form logic: the disposition catalog, the
 * calling window, the retry policy and wrap-up.
 *
 * Pure, per the house pattern (`analysisProfileForm.ts`, `escalationForm.ts`) —
 * no form library anywhere in this SPA.
 *
 * ── This module is a good error message, not the enforcement ─────────────────
 * The API validates the same fields in `agency-campaign-config.ts` and answers
 * `{ details: { <field path>: <message> } }`. The rules are mirrored here so an
 * operator learns about an inverted calling window while they are still looking
 * at the field, not after a round trip — and `fieldErrorsFromResponse` maps
 * the server's answer onto the same field paths so a server-only rule still lands on
 * the offending field.
 *
 * **Neither layer is the guarantee.** The server stores these fields behind nothing
 * but `jsonb_typeof`, and the server's API is reachable with a tenant API key without
 * traversing the API at all. The invariants hold where they are
 * consumed: The server's retry engine and calling-hours gate.
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
 * Turn a label into a legal disposition code.
 *
 * The code is a wire value an agent never sees, and asking an operator to
 * invent one in `snake_case` — next to a field that already says the same
 * thing in English — is the kind of question a form should answer for itself.
 * The result is held to {@link CODE_RE}: lowercase, digits, underscores, 50
 * characters. An empty result is returned as-is so the field stays empty
 * rather than filling with a placeholder the operator did not choose.
 */
export function slugifyCode(label: string): string {
  return label
    // Normalise BEFORE folding case: NFKD expands compatibility characters into
    // ASCII that is sometimes upper-case ('№' → 'No'), and lower-casing first
    // left the capital to be stripped as punctuation — 'Café №2' came out
    // 'cafe_o2', a code with a letter in it the operator never typed.
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50)
    .replace(/_+$/g, '');
}

/**
 * What actually happens when an agent files this outcome, in one sentence.
 *
 * Five checkboxes describe five mechanisms; an operator is choosing a
 * behaviour. The echo is the same argument as {@link callingWindowEcho}: the
 * combination is what matters and no single control shows it, so a
 * `suppress` + `terminal` pair, or a `requires_datetime` with nothing to
 * schedule against, is invisible until it is stated as a whole.
 *
 * The contact's fate is stated ALWAYS, including the plain case — "stays in
 * the queue" is a real outcome, and an absent sentence reads as "nothing
 * happens", which is not the same thing.
 */
export function dispositionSummary(entry: AgencyDispositionEntry): string {
  const asks: string[] = [];
  if (entry.requires_note) asks.push('type a note');
  if (entry.requires_datetime) asks.push('pick a date and time to call back');

  const parts: string[] = [];
  if (asks.length > 0) {
    parts.push(`The agent has to ${asks.join(' and ')}.`);
  }

  if (entry.suppress) {
    parts.push('The contact is suppressed — nothing dials them again.');
  } else if (entry.terminal) {
    parts.push('The contact is finished on this campaign — no more attempts.');
  } else if (entry.retry && entry.retry.max_attempts > 0) {
    const times = entry.retry.max_attempts === 1 ? 'once' : `up to ${entry.retry.max_attempts} times`;
    parts.push(`We call the contact back ${retryCadence(entry.retry.delay_minutes ?? 0)}, ${times}.`);
  } else if (entry.requires_datetime) {
    parts.push('The contact keeps its place in the queue until that time comes round.');
  } else {
    parts.push('The contact stays in the queue with its remaining attempts.');
  }

  parts.push(
    entry.is_success
      ? 'It counts as a success.'
      : 'It does not count as a success.',
  );

  return parts.join(' ');
}

/** `every 4 hours` / `every 20 minutes` / `straight away`. */
function retryCadence(delayMinutes: number): string {
  if (delayMinutes === 0) return 'straight away';
  if (delayMinutes % 60 === 0) {
    const hours = delayMinutes / 60;
    return `every ${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `every ${delayMinutes} minutes`;
}

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
 * Mirrored from the server's `DEFAULT_RETRY_POLICY.agent_disconnected`. It exists so
 * the editor can SEED a fresh row with it rather than with zero.
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
export const OUR_FAULT_RETRY_DEFAULT: AgencyRetryRule = { delay_minutes: 5, max_attempts: 3 };

/**
 * The platform-wide ceiling the server clamps an our-fault row to
 * (`OUR_FAULT_REDIAL_BOUND`). Mirrored for copy only — never sent.
 */
export const OUR_FAULT_REDIAL_BOUND = 3;

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
 * The retry rule the server ships on the built-in `voicemail` disposition.
 *
 * Named because it is used twice: as that entry's default, and as the seed when
 * an operator switches a disposition's own retry ON in the editor. Seeding from
 * zero would be worse than useless there — `max_attempts: 0` is a rule that
 * never fires, so turning the control on would appear to do nothing.
 */
export const DEFAULT_DISPOSITION_RETRY: AgencyRetryRule = { delay_minutes: 240, max_attempts: 2 };

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
 * `builtInSemanticMismatches` flags exactly that flag's absence. The server's exported
 * `BUILT_IN_DISPOSITIONS` and the API's `DEFAULT_DISPOSITION_CATALOG` both
 * declare `{ suppress: true }` alone; this is the third copy agreeing with them.
 * The server, the dialer runtime and this console cannot share a constant, so the test below is the only thing
 * keeping them from drifting again.
 */
export const DEFAULT_DISPOSITIONS: AgencyDispositionEntry[] = [
  { code: 'voicemail', label: 'Voicemail', retry: { ...DEFAULT_DISPOSITION_RETRY } },
  { code: 'callback', label: 'Callback', requires_datetime: true },
  { code: 'do_not_call', label: 'Do not call', suppress: true },
];

/**
 * Copy one catalog entry, including its retry rule.
 *
 * A shallow `{ ...entry }` shares the `retry` OBJECT with whatever it was
 * copied from — for {@link EMPTY_CAMPAIGN_CONFIG} that is the module-level
 * {@link DEFAULT_DISPOSITIONS}, which every form in the app then holds a
 * reference into. Nothing mutated it while the rule had no editor; now that one
 * exists, one in-place write would rewrite the default for the rest of the
 * session. Cheaper to make the copy honest than to rely on every future call
 * site replacing the object rather than assigning into it.
 */
export function cloneDisposition(entry: AgencyDispositionEntry): AgencyDispositionEntry {
  return { ...entry, ...(entry.retry ? { retry: { ...entry.retry } } : {}) };
}

export const EMPTY_CAMPAIGN_CONFIG: CampaignConfigState = {
  dispositions: DEFAULT_DISPOSITIONS.map(cloneDisposition),
  retryPolicy: {},
  window: { start: '09:00', end: '20:00', days: [1, 2, 3, 4, 5], timezone: 'Asia/Kolkata' },
  wrapupSeconds: 30,
  autoReturn: true,
};

/**
 * A fresh, unshared starting config.
 *
 * {@link EMPTY_CAMPAIGN_CONFIG} is a module-level singleton, and seeding
 * `useState` with it hands every builder the same `dispositions` array and the
 * same `window` object. Nothing writes into them in place today — every editor
 * here replaces rather than assigns — but "no call site mutates" is an
 * invariant that has to be re-proved on each change, and there is now an editor
 * for the nested retry rule. A factory costs nothing and removes the question.
 */
export function emptyCampaignConfig(): CampaignConfigState {
  return {
    ...EMPTY_CAMPAIGN_CONFIG,
    dispositions: EMPTY_CAMPAIGN_CONFIG.dispositions.map(cloneDisposition),
    retryPolicy: { ...EMPTY_CAMPAIGN_CONFIG.retryPolicy },
    window: { ...EMPTY_CAMPAIGN_CONFIG.window, days: [...EMPTY_CAMPAIGN_CONFIG.window.days] },
  };
}

/**
 * Load an existing campaign into the form.
 *
 * the requirement is a **round trip without loss**, so unknown
 * disposition flags and unknown-but-valid values are carried through as they
 * came rather than being normalised into the shapes this form knows.
 */
export function configFromCampaign(campaign: AgencyCampaign): CampaignConfigState {
  return {
    dispositions: (campaign.disposition_catalog ?? DEFAULT_DISPOSITIONS).map(cloneDisposition),
    retryPolicy: { ...(campaign.retry_policy ?? {}) },
    window: {
      start: trimSeconds(campaign.calling_window_start) ?? EMPTY_CAMPAIGN_CONFIG.window.start,
      end: trimSeconds(campaign.calling_window_end) ?? EMPTY_CAMPAIGN_CONFIG.window.end,
      days: campaign.calling_days ? [...campaign.calling_days] : [...EMPTY_CAMPAIGN_CONFIG.window.days],
      timezone: campaign.default_timezone ?? EMPTY_CAMPAIGN_CONFIG.window.timezone,
    },
    wrapupSeconds: campaign.wrapup_seconds ?? EMPTY_CAMPAIGN_CONFIG.wrapupSeconds,
    // `??`, not `||`: `false` is the whole point of the setting, and `||` would
    // silently re-seed a hold-until-clicked campaign as auto-return on every
    // load — then the next save would write the operator's choice away.
    autoReturn: campaign.wrapup_auto_return ?? EMPTY_CAMPAIGN_CONFIG.autoReturn,
  };
}

/**
 * Postgres renders a `TIME` column as `HH:MM:SS`; `<input type="time">` wants
 * `HH:MM`. Without this a loaded campaign shows an empty time field, which the
 * operator then re-types — and a round trip that loses a value is exactly what
 * acceptance (c) forbids.
 */
function trimSeconds(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.length >= 5 ? value.slice(0, 5) : value;
}

/** Normalise `HH:MM` / `HH:MM:SS` to a comparable `HH:MM:SS`. Mirrors the API. */
function comparableTime(value: string): string {
  return value.length === 5 ? `${value}:00` : value;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

/**
 * `Area/Location`, or exactly `UTC`.
 *
 * **A bare abbreviation must be refused, and `Intl` will not do it for you.**
 * `new Intl.DateTimeFormat(undefined, { timeZone: 'EST' })` does not throw — ICU
 * resolves `EST` to `America/Panama`, which observes no DST, so a campaign
 * configured `EST` would dial an hour early for half the year and would test
 * clean whenever anyone checked. The shape gate is what catches it.
 */
const IANA_ZONE_RE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)+$/;

export function isUsableTimezone(value: string): boolean {
  if (value.length === 0 || value.length > 64) return false;
  if (value === 'UTC') return true;
  if (!IANA_ZONE_RE.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const CODE_RE = /^[a-z0-9_]{1,50}$/;

/**
 * Validate the whole form, returning `{ field path: message }` keyed exactly as
 * the server keys its `details` — so a client-side finding and a server-side one
 * render in the same place, and neither can end up in a banner the operator has
 * to map back to a field by hand.
 */
export function validateConfig(state: CampaignConfigState): Record<string, string> {
  const errors: Record<string, string> = {};
  const seen = new Set<string>();

  state.dispositions.forEach((entry, i) => {
    const at = `disposition_catalog[${i}]`;
    if (!CODE_RE.test(entry.code)) {
      errors[`${at}.code`] =
        'Use 1–50 characters: lowercase letters, digits or underscores. The code is compared exactly, so a capital letter is a different code.';
    } else if (seen.has(entry.code)) {
      // First-wins is what `find()` does, silently — the operator's second entry
      // and its flags simply never apply.
      errors[`${at}.code`] = `‘${entry.code}’ is already used. Codes must be unique.`;
    } else {
      seen.add(entry.code);
    }

    if (entry.label.trim().length === 0 || entry.label.length > 100) {
      // The agent reads the label off a button. No label is an unlabelled button
      // that files a disposition against a customer.
      errors[`${at}.label`] = 'Every outcome needs a label — the agent reads it off a button.';
    }

    if (entry.retry) {
      const rule = validateRetryRule(entry.retry, `${at}.retry`);
      Object.assign(errors, rule);
    }
  });

  for (const [outcome, rule] of Object.entries(state.retryPolicy)) {
    if (!rule) continue;
    Object.assign(errors, validateRetryRule(rule, `retry_policy.${outcome}`));
  }

  if (!TIME_RE.test(state.window.start)) {
    errors['calling_window_start'] = 'Enter a 24-hour time, like 09:00.';
  }
  if (!TIME_RE.test(state.window.end)) {
    errors['calling_window_end'] = 'Enter a 24-hour time, like 20:00.';
  }
  if (
    TIME_RE.test(state.window.start) &&
    TIME_RE.test(state.window.end) &&
    comparableTime(state.window.start) === comparableTime(state.window.end)
  ) {
    // The server reads start === end as PERMANENTLY CLOSED, not as 24 hours. A
    // saveable campaign that can never dial is a support ticket with no visible
    // cause. A window that wraps midnight (22:00 → 06:00) is fine and supported.
    errors['calling_window_end'] =
      'The window cannot start and end at the same time — the campaign would never dial. For all day, use 00:00 to 23:59.';
  }

  if (state.window.days.length === 0) {
    errors['calling_days'] = 'Pick at least one day — the campaign would never dial.';
  } else if (state.window.days.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
    errors['calling_days'] = 'Days are ISO-8601: 1 = Monday … 7 = Sunday.';
  }

  if (!isUsableTimezone(state.window.timezone)) {
    errors['default_timezone'] =
      'Use a full IANA zone like ‘Asia/Kolkata’ or ‘America/New_York’, or exactly ‘UTC’. Abbreviations such as ‘EST’ are refused — they resolve to a zone with no daylight saving, which would place every call an hour early for half the year.';
  }

  if (!Number.isInteger(state.wrapupSeconds) || state.wrapupSeconds < 0 || state.wrapupSeconds > 600) {
    errors['wrapup_seconds'] = 'Wrap-up is 0–600 seconds. 0 means no wrap-up.';
  }

  return errors;
}

function validateRetryRule(rule: AgencyRetryRule, at: string): Record<string, string> {
  const errors: Record<string, string> = {};
  if (
    typeof rule.max_attempts !== 'number' ||
    !Number.isInteger(rule.max_attempts) ||
    rule.max_attempts < 0 ||
    rule.max_attempts > 20
  ) {
    // Required, not optional: a rule with no `max_attempts` reaches the retry
    // engine as `undefined` and every comparison against it is false, so the
    // configured retry silently never fires.
    errors[`${at}.max_attempts`] = 'Set how many attempts — a whole number from 0 to 20.';
  }
  if (rule.delay_minutes !== undefined) {
    if (
      !Number.isInteger(rule.delay_minutes) ||
      rule.delay_minutes < 0 ||
      rule.delay_minutes > 43_200
    ) {
      errors[`${at}.delay_minutes`] = 'Delay is 0 to 43,200 minutes (30 days).';
    }
  }
  return errors;
}

export type ConfigBlockReason = 'invalid_fields';

export const CONFIG_BLOCK_COPY: Record<ConfigBlockReason, string> = {
  invalid_fields: 'Fix the highlighted fields before saving.',
};

export function configBlockReason(state: CampaignConfigState): ConfigBlockReason | null {
  return Object.keys(validateConfig(state)).length > 0 ? 'invalid_fields' : null;
}

/**
 * Plain-English echo of the calling window.
 *
 * *An echo catches an inverted range that a pair of time inputs never will* —
 * and it names whether the campaign would be dialing right now, because "is it
 * on?" is the question the operator actually has.
 */
export function callingWindowEcho(state: CallingWindowState, now: Date = new Date()): string {
  if (!TIME_RE.test(state.start) || !TIME_RE.test(state.end) || state.days.length === 0) {
    return 'Set a window and at least one day to see when this campaign would dial.';
  }
  const days = describeDays(state.days);
  const wraps = comparableTime(state.start) > comparableTime(state.end);
  const base = `${days}, ${state.start}–${state.end}${wraps ? ' (overnight)' : ''}, ${state.timezone}.`;

  if (!isUsableTimezone(state.timezone)) return base;

  const local = zonedParts(now, state.timezone);
  if (local === null) return base;

  const open = isWithinWindow(local, state, wraps);
  return `${base} Right now it is ${local.time} there — the campaign ${
    open ? 'would be dialing' : 'would not be dialing'
  }.`;
}

interface ZonedNow {
  /** `HH:MM` in the campaign's zone. */
  time: string;
  /** ISO-8601 weekday, 1 = Monday. */
  isoDay: number;
}

function zonedParts(now: Date, timeZone: string): ZonedNow | null {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hour12: false,
    }).formatToParts(now);

    const hour = parts.find((p) => p.type === 'hour')?.value;
    const minute = parts.find((p) => p.type === 'minute')?.value;
    const weekday = parts.find((p) => p.type === 'weekday')?.value;
    if (!hour || !minute || !weekday) return null;

    const isoDay = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(weekday) + 1;
    if (isoDay === 0) return null;
    // `24:00` is a legal en-GB rendering of midnight and would compare above
    // every window end.
    return { time: `${hour === '24' ? '00' : hour}:${minute}`, isoDay };
  } catch {
    return null;
  }
}

function isWithinWindow(local: ZonedNow, state: CallingWindowState, wraps: boolean): boolean {
  const now = comparableTime(local.time);
  const start = comparableTime(state.start);
  const end = comparableTime(state.end);
  const inTime = wraps ? now >= start || now < end : now >= start && now < end;
  return inTime && state.days.includes(local.isoDay);
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function describeDays(days: number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  if (sorted.length === 0) return 'No days';
  if (sorted.length === 7) return 'Every day';
  // Contiguous runs read as a range, which is how an operator says it.
  const contiguous = sorted.every((day, i) => i === 0 || day === sorted[i - 1]! + 1);
  if (contiguous && sorted.length > 2) {
    return `${DAY_NAMES[sorted[0]! - 1]}–${DAY_NAMES[sorted[sorted.length - 1]! - 1]}`;
  }
  return sorted.map((day) => DAY_NAMES[day - 1]).join(', ');
}

/** Plain-English preview of one retry rule. */
export function retryPreview(outcome: AgencyRetryOutcome, rule: AgencyRetryRule | undefined): string {
  /*
    An UNSET our-fault row is not "not retried" — the server falls back to its own
    default for it, and the callout two elements below this preview says so.
    Rendering the two together was the screen contradicting itself, and the
    preview was the half that was wrong.

    (The same `!rule` collapse is still applied to the customer-fault rows,
    where it is equally untrue — the server defaults those too. That is pre-existing
    and wider than this change; corrected here only for the row this change adds,
    rather than silently redefining four rows an operator already reads.)
  */
  if (!rule && OUR_FAULT_RETRY_OUTCOMES.includes(outcome)) {
    const { max_attempts: max, delay_minutes: delay } = OUR_FAULT_RETRY_DEFAULT;
    return `${OUTCOME_LABELS[outcome]}: retried every ${delay} minutes, up to ${max} times (platform default).`;
  }
  if (!rule || rule.max_attempts === 0) {
    return `${OUTCOME_LABELS[outcome]}: not retried.`;
  }
  const every = retryCadence(rule.delay_minutes ?? 0);
  return `${OUTCOME_LABELS[outcome]}: retried ${every}, up to ${rule.max_attempts} time${
    rule.max_attempts === 1 ? '' : 's'
  }.`;
}

/**
 * Keys this form must never SEND, even though it may have loaded them.
 *
 * `invalid` is refused by the server now: its
 * `resolveRetryDecision` returns `suppressed` for that outcome BEFORE it reads
 * `policy?.[outcome]`, so a rule on the key can never fire.
 *
 * This form cannot CREATE the key — `invalid` is in {@link FIXED_ZERO_OUTCOMES}
 * and renders as a static "Fixed at 0" cell with no inputs. But
 * {@link configFromCampaign} hydrates `retry_policy` as a LOSSLESS spread (that
 * is the requirement, a round trip without loss), so a campaign that
 * already carried the key from a direct API caller would be re-sent it here and
 * would start failing validation. Worse, the 400 comes back keyed
 * `retry_policy.invalid`, and the fixed-zero row renders no `<FieldError>` — the
 * operator would get a save that fails with nothing on screen to explain it, and
 * no affordance to clear the key. Stripping it on the way out makes that
 * unreachable instead of merely unlikely, and heals such a campaign on its next
 * save.
 *
 * ⚠️ Stripped SILENTLY, and deliberately so: the key is provably inert, so
 * dropping it changes no behaviour, and warning an operator about a value they
 * can neither see nor set is pure noise. Do not "fix" this into a toast.
 *
 * ⚠️ `connected` is the other {@link FIXED_ZERO_OUTCOMES} entry and is NOT here.
 * It has no short-circuit in the server: it falls through to the ordinary policy lookup,
 * so its rule genuinely overrides the built-in `{max_attempts: 0}`. Stripping it
 * would delete a live key.
 */
const NEVER_SENT_RETRY_OUTCOMES = ['invalid'] as const;

/**
 * The PATCH body.
 *
 * `retry_policy` is sent as-is including `{}`, because the server's
 * `DEFAULT_RETRY_POLICY` falls back **per key** — an empty policy means "the
 * documented defaults", not "retry nothing", and that is the ordinary case. The
 * one exception is {@link NEVER_SENT_RETRY_OUTCOMES}; everything else round-trips
 * untouched, including keys this form does not render.
 */
export function buildConfigPayload(state: CampaignConfigState): Partial<AgencyCampaign> {
  const retryPolicy = { ...state.retryPolicy };
  for (const key of NEVER_SENT_RETRY_OUTCOMES) delete retryPolicy[key];

  return {
    disposition_catalog: state.dispositions.map(cloneDisposition),
    retry_policy: retryPolicy,
    calling_window_start: state.window.start,
    calling_window_end: state.window.end,
    calling_days: [...state.window.days],
    default_timezone: state.window.timezone,
    wrapup_seconds: state.wrapupSeconds,
    // Sent unconditionally, including `true`. The column defaults to `true`, so
    // omitting it looks harmless on a new campaign and is not: with the field
    // absent from every PATCH, an operator who turned auto-return off could
    // never turn it back on.
    wrapup_auto_return: state.autoReturn,
  };
}

/**
 * Pull the API's `{ details: { field: message } }` off a rejected request.
 *
 * The API's config validator answers a **flat record keyed by the body path**,
 * which is neither of the two shapes `ApiError` knows how to summarise — so the
 * message it produces is the bare `'Validation Error'`. The detail is only
 * reachable through `err.details`, which is why this reads it directly rather
 * than parsing the message.
 */
export function fieldErrorsFromResponse(err: unknown): Record<string, string> {
  if (err === null || typeof err !== 'object') return {};
  const body = (err as { details?: unknown }).details;
  if (body === null || typeof body !== 'object') return {};
  const details = (body as { details?: unknown }).details;
  if (details === null || typeof details !== 'object' || Array.isArray(details)) return {};

  const mapped: Record<string, string> = {};
  for (const [field, message] of Object.entries(details as Record<string, unknown>)) {
    if (typeof message === 'string') mapped[field] = message;
  }
  return mapped;
}

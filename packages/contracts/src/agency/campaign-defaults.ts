/**
 * Campaign configuration defaults the server applies and the console previews:
 * the built-in disposition catalog, its voicemail retry rule, the our-fault
 * redial bound with its default delay, and the default abandonment ceiling.
 *
 * One declaration, read by both sides. The server's create path seeds a new
 * campaign's catalog from {@link AGENCY_DEFAULT_DISPOSITION_CATALOG} and its retry
 * engine clamps to {@link AGENCY_OUR_FAULT_REDIAL_BOUND}; the console's campaign
 * builder starts a form from the same catalog and words its copy from the same
 * bound. Before this file each side declared its own copy and a test kept them
 * from drifting; now there is nothing to drift.
 *
 * Part of the dialer contract; `../agency.ts` is the barrel and carries the
 * contract's header (freeze rules, vocabulary). Constants only — every value is
 * frozen, so no consumer can rewrite a default for the rest of the process.
 */

import type { AgencyDisposition } from './session';

/**
 * The retry rule the built-in `voicemail` disposition carries.
 *
 * Named because it is used twice: as that entry's default, and as the seed when
 * an operator switches a disposition's own retry ON in the console's editor.
 * Seeding from zero would be worse than useless there — `max_attempts: 0` is a
 * rule that never fires, so turning the control on would appear to do nothing.
 */
export const AGENCY_DEFAULT_DISPOSITION_RETRY = Object.freeze({
  delay_minutes: 240,
  max_attempts: 2,
} as const);

/**
 * What a new campaign's disposition catalog is seeded with when the create body
 * carries none: the three built-in codes, with the flags that make them work.
 *
 * The codes are conventions rather than dependencies — nothing in the dialer
 * runtime compares against these strings; every mechanism keys on a FLAG
 * (`retry`, `requires_datetime`, `suppress`).
 *
 * ── `do_not_call` carries `suppress` and NOT `terminal` ─────────────────────
 * The server's `resolveDispositionDecision` checks `suppress` FIRST and returns
 * before `terminal` is ever read (suppress beats terminal beats callback beats
 * disposition-retry). A `terminal: true` on top would be structurally
 * unreachable while `suppress` is set, and if an operator ever cleared
 * `suppress` the leftover flag would quietly downgrade a do-not-call from
 * `suppressed` to the weaker `completed`. It is `suppress`, not `terminal`, that
 * stops the number being dialled again.
 */
export const AGENCY_DEFAULT_DISPOSITION_CATALOG = Object.freeze([
  // The only signal a call was answered by a machine. With AMD off the carrier
  // reports `connected`, so voicemail retry cannot be an outcome rule and has to
  // be this.
  Object.freeze({ code: 'voicemail', label: 'Voicemail', retry: AGENCY_DEFAULT_DISPOSITION_RETRY }),
  // The scheduler's dependency. `requires_datetime` is what makes the console
  // collect a time, and the time is what the contact is re-queued for.
  Object.freeze({ code: 'callback', label: 'Callback', requires_datetime: true }),
  // The DNC path's dependency. `suppress` is immediate and irreversible from the
  // dialer's side.
  Object.freeze({ code: 'do_not_call', label: 'Do not call', suppress: true }),
] as const);

/**
 * Agent station (AS4): the "Collections" starter set New campaign offers in place of the
 * built-in three: six outcomes in the station's words (AS15), each with its tile's icon from
 * `AGENCY_TILE_ICONS`. A starting point the supervisor edits like any catalog; nothing on the
 * server reads these codes. It passes both of the server's catalog validators as it is (pinned by
 * `apps/server/test/unit/agency/collections-starter-catalog.test.ts`).
 *
 *  - **Will pay** (`will_pay`): asks for the pay date (`requires_promise`; the amount is
 *    optional) and counts as a success. No follow-up call is booked (PT2's default): the dialler
 *    cannot tell whether the customer paid, so the supervisor turns one on deliberately.
 *  - **Call later** (`callback`): asks for the time to call (`requires_datetime`). The built-in
 *    `callback` code, so reports and the default catalog agree on it.
 *  - **No one spoke** (`no_one_spoke`): the call connected but nobody answered on the line; tried
 *    again like the built-in voicemail ({@link AGENCY_DEFAULT_DISPOSITION_RETRY}).
 *  - **Refused** (`refused`): the customer will not pay; the agent writes why (`requires_note`).
 *    The contact is finished, as for any plain outcome.
 *  - **Wrong number** (`wrong_number`): not the customer; the contact is finished (`terminal`).
 *    Not `suppress`: the number is not on a do-not-call list, it is just not this customer's.
 *  - **Don't call again** (`do_not_call`): the customer asked not to be called; the number is
 *    suppressed (`suppress`, the built-in `do_not_call`), the one outcome the station confirms.
 */
export const AGENCY_COLLECTIONS_STARTER_CATALOG = Object.freeze([
  Object.freeze({ code: 'will_pay', label: 'Will pay', is_success: true, requires_promise: true, icon: 'rupee' }),
  Object.freeze({ code: 'callback', label: 'Call later', requires_datetime: true, icon: 'clock' }),
  Object.freeze({ code: 'no_one_spoke', label: 'No one spoke', retry: AGENCY_DEFAULT_DISPOSITION_RETRY, icon: 'phone_missed' }),
  Object.freeze({ code: 'refused', label: 'Refused', requires_note: true, icon: 'thumbs_down' }),
  Object.freeze({ code: 'wrong_number', label: 'Wrong number', terminal: true, icon: 'wrong_number' }),
  Object.freeze({ code: 'do_not_call', label: "Don't call again", suppress: true, icon: 'stop' }),
] as const) satisfies readonly AgencyDisposition[];

/**
 * ─── THE OUR-FAULT REDIAL BOUND ─────────────────────────────────────────────
 *
 * How many times OUR OWN failures may put one contact's number back on the
 * roster. Deliberately a platform constant and **not** a campaign setting.
 *
 * The reasoning is the whole point of the bound: skipping the attempt charge for
 * an our-fault drop is what stops us retiring customers we never reached, but on
 * its own it makes our-fault redials **free** — one persistently broken agent
 * workstation would redial the same number without limit, which is regulated.
 * The bound is what makes the skip safe.
 *
 * ⚠️ **A limit an operator can raise is not a limit.** This is enforced BELOW the
 * retry policy: the server's `resolveOurFaultRedial` checks it before consulting
 * any configuration, and a policy may only lower it
 * (`min(configured, AGENCY_OUR_FAULT_REDIAL_BOUND)`). That asymmetry is
 * deliberate — an operator who wants to be *more* cautious than the platform
 * should be able to, and one who wants to be less cautious than a repeat-dial
 * regulation should not. The console states it in its copy and never sends it.
 *
 * ── ⚠️ WHY 3: it is a placeholder, and saying so is the point ───────────────
 *
 * **This number is NOT derived from any regulation.** Nobody has yet established
 * which repeat-dial rule binds this product, in which jurisdictions, or what it
 * caps. `3` was chosen for two weak reasons, both stated plainly so neither is
 * mistaken for research:
 *
 *   1. it matches the server's `DEFAULT_RETRY_POLICY` customer-facing
 *      `max_attempts` for the common outcomes, so our-fault redials cannot exceed
 *      the customer's own allowance and the total dial count for one contact stays
 *      intuitively bounded by roughly double it rather than by something
 *      unbounded;
 *   2. it is small enough that being wrong is conservative — the failure mode of
 *      too low is a contact retired early with `our_fault_bound_reached` in its
 *      `last_outcome`, which is visible and auditable, while the failure mode of
 *      too high is repeat-dialling a real person.
 *
 * **Revisit before the pilot dials a real customer list**, and replace this
 * comment with the actual rule and its citation. A bare number on a regulated
 * limit becomes a fact by age: the next reader assumes someone checked. Nobody
 * has. If the real cap turns out to be lower, this constant is the only line that
 * changes — which is the other reason the bound is not spread across config.
 */
export const AGENCY_OUR_FAULT_REDIAL_BOUND = 3;

/** Delay before an our-fault redial when the policy names none. */
export const AGENCY_DEFAULT_OUR_FAULT_REDIAL_DELAY_MINUTES = 5;

/**
 * What an our-fault retry row (`agent_disconnected`, `canceled`) behaves as when
 * the campaign leaves it unset: the default delay, up to the bound.
 *
 * The console seeds a fresh our-fault row with it rather than with zero — a
 * configured `0` retires a contact on its first our-fault drop, which is the
 * explicit value the server refuses to infer from an absent one. It equals the
 * server's `DEFAULT_RETRY_POLICY.agent_disconnected`, and a server test pins that.
 */
export const AGENCY_OUR_FAULT_RETRY_DEFAULT = Object.freeze({
  delay_minutes: AGENCY_DEFAULT_OUR_FAULT_REDIAL_DELAY_MINUTES,
  max_attempts: AGENCY_OUR_FAULT_REDIAL_BOUND,
} as const);

/**
 * The retry rows for a call the customer did not pick up, as the server applies them when a
 * campaign leaves the row unset (every new campaign does): the server's
 * `DEFAULT_RETRY_POLICY` is built from them, and New campaign's "doesn't pick up" sentence
 * says them as the default (CS12). `max_attempts` counts the first call.
 */
export const AGENCY_UNANSWERED_RETRY_DEFAULTS = Object.freeze({
  no_answer: Object.freeze({ delay_minutes: 60, max_attempts: 3 }),
  busy: Object.freeze({ delay_minutes: 15, max_attempts: 4 }),
  failed: Object.freeze({ delay_minutes: 120, max_attempts: 2 }),
} as const);

/**
 * The default abandonment ceiling, as a percentage: the `abandonment_ceiling_pct`
 * column's DEFAULT, what the server applies when a create omits the field, and what
 * the console's builder starts its abandonment limit at. A compliance threshold,
 * so one declaration: a console that previewed one number while the guardrail
 * fired on another would be invisible until an audit.
 */
export const AGENCY_DEFAULT_ABANDONMENT_CEILING_PCT = 3;

/**
 * The `agency_campaigns` column DEFAULTs that are a choice rather than an empty value, as a
 * campaign create that omits the field stores them: the carrier (the service's own VoiceLink
 * account), the calling hours (09:00 to 20:00, Monday to Friday, in UTC; `HH:MM:SS`, as Postgres
 * renders a `TIME`), the wrap-up window and its two switches, recording, and inbound sticky
 * routing. Campaign templates' built-in settings are read from here
 * (`docs/campaign-templates.md` §5), except the time zone: their built-in hours are New campaign's
 * `AGENCY_NEW_CAMPAIGN_TIMEZONE` (CT18), not this `UTC`, which a create that omits the hours stores
 * only with the templates flag off.
 *
 * One declaration: the server's create path, its config validator's base and the Insights
 * "hours never set" check import it, and a server integration test pins every value to the
 * column's DEFAULT (`campaign-template-repository.test.ts`). The other column defaults have their
 * own constants: {@link AGENCY_DEFAULT_ABANDONMENT_CEILING_PCT}, `AGENCY_CONTACT_ASSIGNMENT_DEFAULTS`
 * (`./assignment.ts`), `AGENCY_PHONE_DISPLAY_DEFAULT` (`./session.ts`); the JSONB columns default
 * to empty (`[]`, `{}`) and the nullable ones to NULL.
 */
export const AGENCY_CAMPAIGN_COLUMN_DEFAULTS = Object.freeze({
  telephony_provider: 'voicelink',
  calling_window_start: '09:00:00',
  calling_window_end: '20:00:00',
  calling_days: Object.freeze([1, 2, 3, 4, 5] as const),
  default_timezone: 'UTC',
  wrapup_seconds: 30,
  wrapup_auto_return: true,
  allow_wrapup_redial: false,
  record_calls: false,
  inbound_sticky_enabled: true,
} as const);

/**
 * The time zone New campaign starts on, and so the built-in `hours` section of campaign
 * templates (`docs/campaign-templates.md` CT18). It differs on purpose from the column DEFAULT
 * (`UTC`, {@link AGENCY_CAMPAIGN_COLUMN_DEFAULTS}): the console has always started a campaign in
 * India time, and a template's built-in settings are what a supervisor sees in New campaign
 * today. An API create that omits the hours still stores `UTC` while the templates flag is off.
 */
export const AGENCY_NEW_CAMPAIGN_TIMEZONE = 'Asia/Kolkata';

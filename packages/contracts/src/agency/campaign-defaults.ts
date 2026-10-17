/**
 * Campaign configuration defaults the server applies and the console previews:
 * the built-in disposition catalog, its voicemail retry rule, and the our-fault
 * redial bound with its default delay.
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

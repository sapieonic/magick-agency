/**
 * Automatic outcomes for unanswered calls (decisions OD1–OD8, `docs/decisions.md`).
 *
 * A campaign may map each outcome a call ends with when nobody spoke to the customer
 * (no answer, busy, failed, invalid number, abandoned) to one code of its own
 * disposition catalog. When an attempt ends with a mapped outcome, the dialer stamps
 * that code on the attempt as its automatic outcome
 * (`agency_call_attempts.auto_disposition_code`), so whoever reads the call later
 * sees what the campaign wants done with it ("Retry later", "Callback").
 *
 * **A label, never a routing decision (OD1).** The contact is still routed by the
 * campaign's outcome retry policy, exactly as it is without a mapping: the mapped
 * entry's own `retry`, `requires_datetime` and `override` are not applied, and an
 * entry that claims a consequence (`suppress`, `terminal`) cannot be mapped.
 *
 * Part of the dialer contract; `../agency.ts` is the barrel. Not in the mobile app's literal
 * extract (`tooling/contracts-literals.mjs`): the app neither offers the setting nor switches
 * on these values.
 */

/**
 * The outcomes a campaign may map to an automatic disposition (OD2): every outcome
 * of a dial that ended without anyone speaking to the customer through an agent and
 * that the customer's side caused or the carrier reported.
 *
 * Not here, each for its reason:
 *  - `connected`: an agent spoke to the customer and records the outcome themselves.
 *  - `agent_disconnected`, `orphaned`, `canceled`: our own faults and our own
 *    teardowns, charged to the our-fault ledger. They say nothing about the customer.
 *  - `machine`: never produced (no answering-machine detection).
 *
 * VoiceLink reports a switched-off handset as `busy` (`classifyVoicelinkOutcome`), so
 * "switched off" is mapped through `busy`. A declined call arrives as `busy` or as
 * `no_answer` (a rejection, `outcome-classifier.ts`), depending on what the carrier reports.
 */
export const AGENCY_AUTO_DISPOSITION_OUTCOMES = [
  'no_answer',
  'busy',
  'failed',
  'invalid',
  'abandoned',
] as const;

/** One outcome a campaign may map ({@link AGENCY_AUTO_DISPOSITION_OUTCOMES}). */
export type AgencyAutoDispositionOutcome = (typeof AGENCY_AUTO_DISPOSITION_OUTCOMES)[number];

/**
 * `agency_campaigns.outcome_dispositions`: outcome → catalog code. An absent key is an
 * outcome with no automatic disposition; `{}` (the column default) maps nothing.
 *
 * Every value names an entry of the campaign's `disposition_catalog` that neither
 * `suppress`es nor is `terminal` (OD3). A catalog change that would break a mapping is
 * refused, naming the mapping (OD6).
 */
export type AgencyOutcomeDispositions = Partial<Record<AgencyAutoDispositionOutcome, string>>;

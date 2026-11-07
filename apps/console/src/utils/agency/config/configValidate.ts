import {
  AGENCY_AUTO_DISPOSITION_OUTCOMES,
  type AgencyDispositionEntry,
  type AgencyOutcomeDispositions,
  type AgencyRetryRule,
} from '../../../types/agency-campaign';
import {
  AGENCY_AGENT_RETRY_COOLDOWN_MINUTES_MAX,
  AGENCY_AGENT_RETRY_ROUNDS_MAX,
  AGENCY_AGENT_RETRY_ROUNDS_MIN,
  AGENCY_ASSIGNMENT_MODES,
  AGENCY_CALLBACK_FALLBACK_VALUES,
  AGENCY_CALLBACK_GRACE_MINUTES_MAX,
  AGENCY_ON_UNSTAFF_VALUES,
  AGENCY_OVERRIDE_EXTRA_ATTEMPTS_MAX,
} from '@magick-agency/contracts/agency';
import { autoDispositionRefusal } from '@magick-agency/domain/auto-disposition';
import { TIME_RE, comparableTime, isUsableTimezone } from './callingWindow';
import type { AssignmentConfigState, CampaignConfigState } from './configConstants';
import { reservedDispositionCodeMessage } from '../systemDisposition';
import { ceilingFieldError } from '../abandonmentCeiling';
import { dispositionLabel } from '../../agencySpineCopy';

/*
  The campaign builder's validation: the client half of the rules the API
  enforces, keyed by the same body paths as the server's `details`, and the
  mapping of a server answer back onto those fields. Out of
  `agencyCampaignConfigForm.ts`, which re-exports everything here.
*/

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
    } else if (reservedDispositionCodeMessage(entry.code) !== null) {
      // A code the system writes (`redialed`): the server refuses it on save too,
      // because an agent filing it by hand would be indistinguishable from the
      // system's record of a redial.
      errors[`${at}.code`] = reservedDispositionCodeMessage(entry.code)!;
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

    if (entry.override) Object.assign(errors, validateOverride(entry, `${at}.override`));
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

  const ceiling = ceilingStateError(state);
  if (ceiling !== null) errors['abandonment_ceiling_pct'] = ceiling;

  Object.assign(errors, validateAssignment(state.assignment));

  Object.assign(errors, validateOutcomeDispositions(state.outcomeDispositions, state.dispositions));

  return errors;
}

/** Why an automatic outcome may not stop or end the contact, after the entry's label. */
const AUTO_OUTCOME_IS_A_LABEL =
  'An automatic outcome is only a label and never changes what happens to the contact, so pick '
  + 'an outcome that doesn’t stop or end it.';

/**
 * The automatic outcomes for unanswered calls (decisions OD1–OD8), keyed
 * `outcome_dispositions.<outcome>` as the server keys them. Each mapped code must
 * name an entry of the catalog being saved (the form's, not the stored one: the two
 * go in one PATCH), and that entry may neither suppress nor end the contact — an
 * automatic outcome is only a label and never changes what happens to the contact,
 * so an outcome claiming to stop or end it would be false on every call it is
 * filed on. (The message does not say the contact "is dialled again": an invalid
 * number is always suppressed, and a contact's last attempt ends it.)
 *
 * Only the known outcomes are read. A key the form does not know is never sent
 * (`outcomeDispositionsPayload`), so it has no row to carry a finding and is not
 * one; an empty code is "no automatic outcome", which is never an error.
 *
 * The rule is the shared `autoDispositionRefusal` (`@magick-agency/domain`), the one
 * the server enforces: the first entry with the code is the one read, and a
 * duplicate code is already the catalog's own finding.
 */
export function validateOutcomeDispositions(
  mapping: AgencyOutcomeDispositions,
  catalog: readonly AgencyDispositionEntry[],
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const outcome of AGENCY_AUTO_DISPOSITION_OUTCOMES) {
    const code = mapping[outcome];
    if (code === undefined || code === '') continue;
    const refusal = autoDispositionRefusal(catalog, code);
    if (refusal === null) continue;
    const at = `outcome_dispositions.${outcome}`;
    if (refusal === 'missing') {
      errors[at] =
        `‘${code}’ is no longer one of this campaign’s outcomes. Pick another, or choose “No automatic outcome”.`;
    } else {
      const label = dispositionLabel(code, catalog);
      errors[at] = refusal === 'suppress'
        ? `“${label}” stops calling the contact. ${AUTO_OUTCOME_IS_A_LABEL}`
        : `“${label}” ends the contact. ${AUTO_OUTCOME_IS_A_LABEL}`;
    }
  }
  return errors;
}

/**
 * The form's abandonment ceiling error, or `null`: a new value must be in the
 * offered range, the stored one is accepted as stored (`abandonmentCeiling.ts`,
 * "The range"). The one call `validateConfig`, the builder's create and its
 * summary share.
 */
export function ceilingStateError(state: CampaignConfigState): string | null {
  return ceilingFieldError(state.abandonmentCeilingPct, state.abandonmentCeilingStoredPct);
}

/**
 * An outcome's override, keyed `disposition_catalog[i].override.*` as the server
 * keys it. The editor only offers the legal shapes; this catches a catalog
 * loaded from the API in a shape the editor would not produce.
 */
function validateOverride(entry: AgencyDispositionEntry, at: string): Record<string, string> {
  const errors: Record<string, string> = {};
  const override = entry.override!;
  if (entry.suppress || entry.terminal) {
    errors[at] =
      'An outcome that ends or stops calling the contact can’t allow an override. Remove the override or the flag.';
    return errors;
  }
  if (override.extra_attempts !== undefined) {
    const n = override.extra_attempts;
    if (!Number.isInteger(n) || n < 1 || n > AGENCY_OVERRIDE_EXTRA_ATTEMPTS_MAX) {
      errors[`${at}.extra_attempts`] = `Extra attempts are 1 to ${AGENCY_OVERRIDE_EXTRA_ATTEMPTS_MAX}.`;
    }
  }
  if (!override.extra_attempts && !override.retry_delay && !override.calling_hours) {
    errors[at] = 'Pick at least one thing this outcome allows, or turn the override off.';
  }
  return errors;
}

/** The 0009 bounds, from the contract; keys are the body's own field names. */
function validateAssignment(assignment: AssignmentConfigState): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!(AGENCY_ASSIGNMENT_MODES as readonly string[]).includes(assignment.mode)) {
    errors['assignment_mode'] = 'Pick how contacts are assigned.';
  }
  if (!(AGENCY_ON_UNSTAFF_VALUES as readonly string[]).includes(assignment.onUnstaff)) {
    errors['on_unstaff'] = 'Pick what happens to an agent’s contacts when they leave the campaign.';
  }
  if (!(AGENCY_CALLBACK_FALLBACK_VALUES as readonly string[]).includes(assignment.callbackFallback)) {
    errors['callback_fallback'] = 'Pick what happens to a callback whose agent is away.';
  }
  if (!wholeIn(assignment.callbackGraceMinutes, 0, AGENCY_CALLBACK_GRACE_MINUTES_MAX)) {
    errors['callback_owner_grace_minutes'] =
      `Wait 0 to ${AGENCY_CALLBACK_GRACE_MINUTES_MAX.toLocaleString()} minutes (7 days).`;
  }
  if (!wholeIn(assignment.agentRetryRounds, AGENCY_AGENT_RETRY_ROUNDS_MIN, AGENCY_AGENT_RETRY_ROUNDS_MAX)) {
    errors['agent_retry_rounds'] =
      `Rounds are ${AGENCY_AGENT_RETRY_ROUNDS_MIN} to ${AGENCY_AGENT_RETRY_ROUNDS_MAX}.`;
  }
  if (!wholeIn(assignment.agentRetryCooldownMinutes, 0, AGENCY_AGENT_RETRY_COOLDOWN_MINUTES_MAX)) {
    errors['agent_retry_cooldown_minutes'] =
      `Cooldown is 0 to ${AGENCY_AGENT_RETRY_COOLDOWN_MINUTES_MAX.toLocaleString()} minutes (7 days).`;
  }
  return errors;
}

function wholeIn(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
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

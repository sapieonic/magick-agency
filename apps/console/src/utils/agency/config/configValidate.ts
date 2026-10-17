import type { AgencyRetryRule } from '../../../types/agency-campaign';
import { TIME_RE, comparableTime, isUsableTimezone } from './callingWindow';
import type { CampaignConfigState } from './configConstants';

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

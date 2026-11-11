import { isUsableTimezone } from './calling-hours.js';
import {
  AGENCY_AGENT_RETRY_COOLDOWN_MINUTES_MAX,
  AGENCY_AUTO_DISPOSITION_OUTCOMES,
  AGENCY_AGENT_RETRY_ROUNDS_MAX,
  AGENCY_AGENT_RETRY_ROUNDS_MIN,
  AGENCY_ASSIGNMENT_MODES,
  AGENCY_CALLBACK_FALLBACK_VALUES,
  AGENCY_CALLBACK_GRACE_MINUTES_MAX,
  AGENCY_ON_UNSTAFF_VALUES,
  AGENCY_OVERRIDE_EXTRA_ATTEMPTS_MAX,
  AGENCY_INBOUND_TOOK_OVER_DISPOSITION_CODE,
  AGENCY_REDIALED_DISPOSITION_CODE,
  DEVICE_AWAY_BREAK_REASON,
  PHONE_CALL_BREAK_REASON,
  RESERVED_BREAK_REASONS,
  SOFTPHONE_BREAK_REASON,
  type AgencyAttemptOutcome,
  type AgencyAutoDispositionOutcome,
  type AgencyReservedBreakReason,
} from '@magick-agency/contracts/agency';
import { ATTEMPT_OUTCOME_LABELS } from '@magick-agency/contracts/api/agency/agency-spine';
import { autoDispositionRefusal, isAutoDispositionOutcome } from '@magick-agency/domain/auto-disposition';

/**
 * ─── AGENCY CAMPAIGN CONFIG — THE INTERNAL HANDLER'S OWN BOUNDARY ───────────
 *
 * `agency-campaigns.routes.ts` would otherwise pass `retry_policy`,
 * `disposition_catalog`, `calling_window_*`, `calling_days` and
 * `default_timezone` straight into the repository behind nothing but the schema's
 * `jsonb_typeof` CHECKs.
 *
 * These invariants are **consumed** in the dialer runtime's retry engine and
 * calling-hours gate, so they have to hold *here*, at the internal handler that
 * writes the row. The public API layer's validator (`agency-campaign-config.ts`)
 * gives the campaign wizard a good error message; this is the enforcement.
 * Neither is redundant.
 *
 * ── The rules are the consumers', not another validator's list ─────────────
 *
 * Deliberately not a copy of `agency-campaign-config.ts`.
 * Every rule below was checked against the code that reads the value, and that
 * changed three of them — see {@link RETRY_POLICY_OUTCOMES}. A validator built by
 * mirroring another validator inherits its mistakes and cannot notice them.
 *
 * ── What is NOT validated, and why that was checked rather than assumed ─────
 *
 * The three "built-in" disposition codes (`voicemail`, `callback`, `do_not_call`)
 * are **not** required to be present. The retry-policy design claims the retry
 * engine, the scheduler and the DNC path "each depend on one of them existing";
 * they do not. Each
 * mechanism keys on a *flag* — `entry.retry`, `entry.requires_datetime`,
 * `entry.suppress` — and the DNC path is the dedicated `attempts/:id/dnc` route,
 * which never reads the catalog. No code-string comparison for those three exists
 * in `src/` outside prose.
 *
 * So an **empty `disposition_catalog` stays legal**, and that is not a tolerance:
 * `outcome-classifier.ts`'s `requiresDisposition` reads an empty catalog as "no
 * codes to pick, so requiring one is a dead end" — a campaign whose agents do no
 * write-up. A required-codes rule would make that campaign unsaveable.
 */

export interface CampaignConfigIssue {
  /** Dot/bracket path into the request body, so a console can mark the field. */
  field: string;
  message: string;
}

/**
 * Retry-policy keys the internal handler will accept.
 *
 * ── This list and the public API layer's are a PAIR, and they agree ─────────
 *
 * The `RETRY_POLICY_OUTCOMES` in `agency-campaign-config.ts` is the same set.
 * Verify against that file rather than this paragraph — the invariant below is
 * what matters, not a count either side can drift.
 *
 * `AgencyRetryPolicy` is `Partial<Record<AgencyAttemptOutcome, …>>` and
 * `AgencyAttemptOutcome` has **ten** members, of which this
 * list accepts eight. Reading the CONSUMERS — `resolveRetryDecision` and, for the
 * our-fault outcomes, `resolveOurFaultRedial` — rather than either list settles
 * which of the ten a key can actually affect:
 *
 *  - **`agent_disconnected` and `orphaned` are consulted and DO fire.** Both are
 *    genuinely produced (`agency-dialer.ts` and `reaper.ts` write `'orphaned'`;
 *    the WebRTC bridge and `outcome-classifier.ts` produce `'agent_disconnected'`)
 *    and both fall through to `policy?.[outcome]`. A policy key **tunes a defined
 *    default**: both have entries in `DEFAULT_RETRY_POLICY`, so a contact whose
 *    attempt died of our own restart or the agent's dropped socket is retried out
 *    of the box. Refusing the keys would remove the only lever that tunes that
 *    behaviour, so they are accepted.
 *
 *    Note the cap an operator sets here is the CUSTOMER's allowance and binds
 *    only an `agent_disconnected` that happened AFTER bridging. A drop before the
 *    bridge is charged to `agency_contacts.our_fault_attempts` and bounded by
 *    `OUR_FAULT_REDIAL_BOUND`, which is deliberately **not** reachable from this
 *    validator — a regulated repeat-dial limit config can raise is not a limit.
 *
 *  - **`machine` is refused**. With AMD off nothing
 *    can ever classify an outcome as `machine` — a call answered by voicemail is
 *    `connected` — so a rule here is not a typo that gets ignored, it is a
 *    configured retry that will never once fire. Voicemail retry is
 *    disposition-driven instead.
 *
 *  - **`invalid` is REFUSED**. It is a real outcome, unlike `machine`,
 *    but `resolveRetryDecision` returns `suppressed` for it **before** the line
 *    that reads `policy?.[outcome]` (the contact state machine routes `invalid` straight to
 *    `suppressed`, not to `exhausted`). So neither `policy.invalid` nor
 *    `DEFAULT_RETRY_POLICY.invalid` can ever be read for that outcome — the key
 *    is structurally unreachable, which is exactly the silent no-op the `machine`
 *    rule exists to prevent.
 *
 *    ⚠️ The fix is to refuse the KEY, **not** to make `resolveRetryDecision`
 *    consult it. "A bad number does not become good" is the settled rule and
 *    `DEFAULT_RETRY_POLICY` says so in its own comment; making the key live would
 *    let a campaign redial a number the carrier has already told us is unreachable.
 *
 *    The public API layer refuses the key too, and the console does not send it,
 *    so the two validators agree and no wizard field 400s.
 *
 *  - **`canceled` is ACCEPTED**, and it is the one key on this list
 *    whose lever is a *bound* rather than a budget — which is the thing to know
 *    before reading the number an operator sets here as "how many times a
 *    cancelled contact is redialled". The dial site routes `canceled` to
 *    `resolveOurFaultRedial` and the `our_fault_attempts` ledger, and that
 *    function consults a configured key only for `min(configured,
 *    OUR_FAULT_REDIAL_BOUND)` and for the delay. So a rule of 10 here is clamped
 *    to 3; a rule of 1 genuinely lowers it. `DEFAULT_RETRY_POLICY.canceled`, by
 *    contrast, is a fallback no path reads today — see its own comment.
 *
 *    Accepted rather than refused because that asymmetry is exactly the one this
 *    validator is *for*: a key an operator can only use to be MORE cautious than
 *    the platform is a real lever, unlike `machine` (never fires) or `invalid`
 *    (short-circuited before the policy is read). Refusing it would take away the
 *    only way to say "do not keep re-dialling a number my agents keep cancelling
 *    on", which on a compliance-sensitive product is a request an operator is
 *    entitled to make.
 *
 * **This list never refuses a key the public API layer accepts**, and the reverse:
 * the two must be changed together or a campaign saves from the wizard and 400s
 * here, or the other way round.
 */
export const RETRY_POLICY_OUTCOMES = [
  'no_answer',
  'busy',
  'failed',
  'abandoned',
  'connected',
  'agent_disconnected',
  'orphaned',
  'canceled',
] as const;

/**
 * Keys refused because an EARLIER-CHECKED branch makes them unreachable, rather
 * than because they are not real outcomes. Separated from
 * {@link SILENTLY_INERT_OUTCOMES} because the reason — and so the message an
 * operator needs — is completely different: `machine` never happens, whereas
 * `invalid` happens constantly and is simply never retried.
 */
const SUPPRESSED_BEFORE_POLICY_OUTCOMES = new Set(['invalid']);

/**
 * Keys whose failure is silent rather than obvious, named individually because
 * the generic "not a call outcome" message would not tell an operator why the
 * rule they carefully configured never fired.
 */
const SILENTLY_INERT_OUTCOMES = new Set(['machine', 'voicemail', 'answering_machine']);

/** `HH:MM` or `HH:MM:SS` — Postgres renders a `TIME` column as the latter. */
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

/** `default_timezone` is `VARCHAR(64)`; longer is a 22001, i.e. a masked 500. */
const MAX_TIMEZONE_LENGTH = 64;

/**
 * The `agency_campaigns` column defaults, which are what an omitted field becomes.
 *
 * Duplicated from SQL on purpose and kept narrow: the cross-field
 * `start !== end` rule cannot be evaluated on a body that carries only one side,
 * and on a POST the other side is the column default rather than nothing. Without
 * this, `POST { calling_window_start: '20:00' }` stores 20:00–20:00 — a campaign
 * that can never dial — while passing a body-only validator, which is the same
 * defect the rule exists to prevent arriving by the DEFAULT path instead of the
 * configured one.
 */
export const CAMPAIGN_CONFIG_COLUMN_DEFAULTS = {
  calling_window_start: '09:00:00',
  calling_window_end: '20:00:00',
  // The automatic-outcome pair's defaults, so a create's map is checked against the
  // catalog it will actually store (`validateOutcomeDispositions`): none sent ⇒ `[]`.
  disposition_catalog: [],
  outcome_dispositions: {},
} as const;

// The default abandonment ceiling. Lives in the leaf the repository also imports
// (B9 layering); re-exported so this module's importers are unchanged.
export { DEFAULT_ABANDONMENT_CEILING_PCT } from './campaign-thresholds.js';

/**
 * Where the config being validated belongs. The soft phone's settings
 * (`softphone-settings.repository.ts`) reuse this validator for their outcome catalog,
 * with `allowDispositionOverride: false`: an override is a campaign feature.
 */
export interface CampaignConfigOptions {
  /** A catalog entry may carry `override` (default true: a campaign's catalog). */
  allowDispositionOverride?: boolean;
}

/**
 * A disposition code: lowercase letters, digits and underscores, at most 50
 * (`agency_call_attempts.disposition_code` and `auto_disposition_code` are `VARCHAR(50)`).
 */
const DISPOSITION_CODE_RE = /^[a-z0-9_]{1,50}$/;

/** What the effective config is, before this body is applied. */
export interface CampaignConfigBase {
  calling_window_start?: string;
  calling_window_end?: string;
  /**
   * The stored catalog and automatic-outcome map (a PATCH, a retry's parent), so a body
   * that changes one is checked against the other (OD6). Absent on a create: `[]` and
   * `{}`, the column defaults.
   */
  disposition_catalog?: unknown;
  outcome_dispositions?: unknown;
}

/** Normalise `HH:MM` and `HH:MM:SS` to a comparable `HH:MM:SS`. */
function toComparableTime(value: string): string {
  return value.length === 5 ? `${value}:00` : value;
}

function validateRetryRule(rule: Record<string, unknown>, at: string): CampaignConfigIssue[] {
  const issues: CampaignConfigIssue[] = [];

  // Required, not optional. `AgencyRetryPolicy` types `max_attempts` non-optional
  // while the value arrives as untyped JSON, so `retry: {}` reaches
  // `resolveRetryDecision` as `undefined`, `Number.isFinite` is false, and it is
  // silently read as `max_attempts: 0` — "never retried". The operator's
  // configured retry then never fires and nothing says so.
  const max = rule['max_attempts'];
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 0 || max > 20) {
    issues.push({
      field: `${at}.max_attempts`,
      message: 'max_attempts is required and must be an integer between 0 and 20.',
    });
  }

  const delay = rule['delay_minutes'];
  if (delay !== undefined
    && (typeof delay !== 'number' || !Number.isInteger(delay) || delay < 0 || delay > 43_200)) {
    issues.push({
      field: `${at}.delay_minutes`,
      // 30 days. Beyond that a parked contact is indistinguishable from one that
      // was never retried, and worse than one marked exhausted.
      message: 'delay_minutes must be an integer between 0 and 43200 (30 days).',
    });
  }

  for (const key of Object.keys(rule)) {
    if (key !== 'max_attempts' && key !== 'delay_minutes') {
      issues.push({ field: `${at}.${key}`, message: `Unknown retry field '${key}'.` });
    }
  }

  return issues;
}

/**
 * Disposition codes the SYSTEM writes, which a campaign's catalog may not list, and
 * what writes each (the refusal tells the operator). A catalog entry with one of
 * these codes would let an agent file, by hand, the record the system keeps for a
 * different event, and reports could no longer tell the two apart.
 *
 * Exported because the public API layer's validator (`agency-campaign-config.ts`)
 * refuses the same codes with the same message: the two lists must not drift.
 */
export const RESERVED_DISPOSITION_CODE_OWNER: Readonly<Record<string, string>> = {
  [AGENCY_REDIALED_DISPOSITION_CODE]:
    'the system writes it on a call the agent redialled from wrap-up',
  [AGENCY_INBOUND_TOOK_OVER_DISPOSITION_CODE]:
    'the system writes it on a dial cancelled because the customer rang in',
};

/** The refusal for a catalog entry using a reserved code, or null. Shared with the public validator. */
export function reservedDispositionCodeMessage(code: string): string | null {
  const owner = Object.hasOwn(RESERVED_DISPOSITION_CODE_OWNER, code)
    ? RESERVED_DISPOSITION_CODE_OWNER[code]
    : undefined;
  return owner ? `Disposition code '${code}' is reserved: ${owner}. Choose another code.` : null;
}

/**
 * `allow_wrapup_redial` (0008) is a `BOOLEAN NOT NULL` column. Refused here unless a
 * JSON boolean: a `null` PATCH would reach the NOT NULL as a `23502`, a string
 * like `'yes'` would be coerced by Postgres into a setting nobody chose, and both
 * surface as something other than a field the operator can correct.
 */
function validateBooleanSetting(record: Record<string, unknown>, field: string): CampaignConfigIssue[] {
  const value = record[field];
  if (value === undefined || typeof value === 'boolean') return [];
  return [{ field, message: `${field} must be a boolean.` }];
}

/**
 * The contact-assignment and agent-retry settings (0009), each refused unless it is a
 * value its column's CHECK accepts: an enum member, an integer within the contract's
 * bound, or a JSON boolean. `null` is refused like any other wrong type: every column
 * is `NOT NULL` with a default, so "unset it" means sending the default.
 *
 * Exported because the public API layer's validator (`agency-campaign-config.ts`)
 * applies the same rules with the same messages: the two must not drift.
 */
export function validateAssignmentSettings(record: Record<string, unknown>): CampaignConfigIssue[] {
  const issues: CampaignConfigIssue[] = [];
  const oneOf = (field: string, allowed: readonly string[]): void => {
    const value = record[field];
    if (value === undefined) return;
    if (typeof value !== 'string' || !allowed.includes(value)) {
      issues.push({ field, message: `${field} must be one of: ${allowed.join(', ')}.` });
    }
  };
  const integer = (field: string, min: number, max: number): void => {
    const value = record[field];
    if (value === undefined) return;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      issues.push({ field, message: `${field} must be an integer between ${min} and ${max}.` });
    }
  };
  oneOf('assignment_mode', AGENCY_ASSIGNMENT_MODES);
  oneOf('on_unstaff', AGENCY_ON_UNSTAFF_VALUES);
  integer('callback_owner_grace_minutes', 0, AGENCY_CALLBACK_GRACE_MINUTES_MAX);
  oneOf('callback_fallback', AGENCY_CALLBACK_FALLBACK_VALUES);
  issues.push(...validateBooleanSetting(record, 'allow_agent_retry'));
  integer('agent_retry_rounds', AGENCY_AGENT_RETRY_ROUNDS_MIN, AGENCY_AGENT_RETRY_ROUNDS_MAX);
  integer('agent_retry_cooldown_minutes', 0, AGENCY_AGENT_RETRY_COOLDOWN_MINUTES_MAX);
  return issues;
}

/** The keys an outcome's `override` may carry (`AgencyDispositionOverride`). */
const OVERRIDE_KEYS: ReadonlySet<string> = new Set(['extra_attempts', 'retry_delay', 'calling_hours']);

/**
 * A catalog entry's `override` (contact assignment, phase 2), or nothing when the entry
 * has none.
 *
 *  - Keys only `extra_attempts` (an integer 1 to `AGENCY_OVERRIDE_EXTRA_ATTEMPTS_MAX`),
 *    `retry_delay` and `calling_hours` (booleans). **Any other key is refused**, so a
 *    `dnc` (or any spelling of it) can never be stored: DNC is not overridable, and an
 *    unknown key that were ignored would read to the operator as a grant that works.
 *  - At least one part granted: `{}` or all-false grants nothing and would store an
 *    entry that looks like it does something.
 *  - Refused on an entry that `suppress`es (the do-not-call outcome) or is `terminal`
 *    (the contact is finished, so nothing could ever spend the grant).
 *  - Refused outright where `allowed` is false: the soft phone's catalog, whose calls
 *    are not campaign dials and have no roster contact to carry a grant.
 *
 * Exported because the public API layer's validator applies the same rules with the
 * same messages.
 */
export function dispositionOverrideIssues(
  entry: Record<string, unknown>,
  at: string,
  allowed = true,
): CampaignConfigIssue[] {
  const override = entry['override'];
  if (override === undefined) return [];
  const field = `${at}.override`;
  if (!allowed) {
    return [{
      field,
      message: "Overrides are a campaign feature: the soft phone's outcome catalogue cannot grant one.",
    }];
  }
  if (override === null || typeof override !== 'object' || Array.isArray(override)) {
    return [{ field, message: 'override must be an object.' }];
  }
  const grant = override as Record<string, unknown>;
  const issues: CampaignConfigIssue[] = [];
  for (const key of Object.keys(grant)) {
    if (!OVERRIDE_KEYS.has(key)) {
      issues.push({
        field: `${field}.${key}`,
        message: `Unknown override field '${key}'. An outcome may grant only extra_attempts, retry_delay and calling_hours; do-not-call is never overridable.`,
      });
    }
  }
  const extra = grant['extra_attempts'];
  if (extra !== undefined
    && (typeof extra !== 'number' || !Number.isInteger(extra) || extra < 1 || extra > AGENCY_OVERRIDE_EXTRA_ATTEMPTS_MAX)) {
    issues.push({
      field: `${field}.extra_attempts`,
      message: `extra_attempts must be an integer between 1 and ${AGENCY_OVERRIDE_EXTRA_ATTEMPTS_MAX}.`,
    });
  }
  for (const flag of ['retry_delay', 'calling_hours']) {
    if (grant[flag] !== undefined && typeof grant[flag] !== 'boolean') {
      issues.push({ field: `${field}.${flag}`, message: `${flag} must be a boolean.` });
    }
  }
  // Only over well-formed parts: a mistyped or unknown one is already the refusal, and
  // "grants nothing" beside it would describe a grant the operator did not write.
  if (issues.length === 0
    && extra === undefined && grant['retry_delay'] !== true && grant['calling_hours'] !== true) {
    issues.push({
      field,
      message: 'override must grant at least one of extra_attempts, retry_delay or calling_hours.',
    });
  }
  if (entry['suppress'] === true || entry['terminal'] === true) {
    issues.push({
      field,
      message: entry['suppress'] === true
        ? 'An outcome that suppresses the contact cannot grant an override: do-not-call is never overridable.'
        : 'A terminal outcome cannot grant an override: it finishes the contact, so nothing could spend it.',
    });
  }
  return issues;
}

function validateDispositionCatalog(catalog: unknown, allowOverride: boolean): CampaignConfigIssue[] {
  if (!Array.isArray(catalog)) {
    return [{ field: 'disposition_catalog', message: 'disposition_catalog must be an array.' }];
  }

  const issues: CampaignConfigIssue[] = [];
  // An empty catalog is VALID — see the header. No length check here, ever.
  const seen = new Set<string>();

  catalog.forEach((raw, i) => {
    const at = `disposition_catalog[${i}]`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      issues.push({ field: at, message: 'Each disposition must be an object.' });
      return;
    }
    const entry = raw as Record<string, unknown>;

    const code = entry['code'];
    if (typeof code !== 'string' || !DISPOSITION_CODE_RE.test(code)) {
      issues.push({
        field: `${at}.code`,
        // Compared byte-for-byte where it is consumed — the catalog lookup on
        // submit and the disposition precedence check — so a code differing only
        // in case is a submission the internal handler answers `unknown_disposition_code` to.
        message: 'code must be 1–50 characters of lowercase letters, digits or underscores.',
      });
    } else if (seen.has(code)) {
      // `find(c => c.code === x)` is first-wins, silently: the operator's second
      // entry, with its own retry/terminal/suppress flags, simply never applies.
      issues.push({ field: `${at}.code`, message: `Duplicate disposition code '${code}'.` });
    } else {
      seen.add(code);
      const reserved = reservedDispositionCodeMessage(code);
      if (reserved) issues.push({ field: `${at}.code`, message: reserved });
    }

    const label = entry['label'];
    if (typeof label !== 'string' || label.trim().length === 0 || label.length > 100) {
      // The agent reads this off a button. An unlabelled button still files a
      // disposition against a customer.
      issues.push({ field: `${at}.label`, message: 'label must be 1–100 characters.' });
    }

    for (const flag of ['is_success', 'requires_note', 'requires_datetime', 'terminal', 'suppress']) {
      if (entry[flag] !== undefined && typeof entry[flag] !== 'boolean') {
        issues.push({ field: `${at}.${flag}`, message: `${flag} must be a boolean.` });
      }
    }

    const retry = entry['retry'];
    if (retry !== undefined) {
      if (retry === null || typeof retry !== 'object' || Array.isArray(retry)) {
        issues.push({ field: `${at}.retry`, message: 'retry must be an object.' });
      } else {
        issues.push(...validateRetryRule(retry as Record<string, unknown>, `${at}.retry`));
      }
    }

    issues.push(...dispositionOverrideIssues(entry, at, allowOverride));
  });

  return issues;
}

function validateRetryPolicy(policy: unknown): CampaignConfigIssue[] {
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
    return [{ field: 'retry_policy', message: 'retry_policy must be an object keyed by outcome.' }];
  }

  const issues: CampaignConfigIssue[] = [];
  const known = new Set<string>(RETRY_POLICY_OUTCOMES);

  for (const [key, rule] of Object.entries(policy as Record<string, unknown>)) {
    if (!known.has(key)) {
      issues.push({
        field: `retry_policy.${key}`,
        message: SILENTLY_INERT_OUTCOMES.has(key)
          ? `'${key}' is never a call outcome — with answering-machine detection off, a call answered by voicemail is classified 'connected'. A rule here would never fire. Configure voicemail retry on the 'voicemail' disposition instead, where it is applied.`
          : SUPPRESSED_BEFORE_POLICY_OUTCOMES.has(key)
            ? `'${key}' is a real outcome, but a retry rule on it can never fire: an unreachable number is suppressed the moment it is classified, before any retry policy is consulted, because a bad number does not become good on a redial. Remove the key — suppression already handles it. To stop calling a contact for any other reason, use the 'do_not_call' disposition.`
            : `'${key}' is not a call outcome. Valid keys: ${RETRY_POLICY_OUTCOMES.join(', ')}.`,
      });
      continue;
    }
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
      issues.push({ field: `retry_policy.${key}`, message: 'Each outcome rule must be an object.' });
      continue;
    }
    issues.push(...validateRetryRule(rule as Record<string, unknown>, `retry_policy.${key}`));
  }

  // An empty policy is valid and is the ORDINARY case, not the edge one: the
  // column defaults to `{}`, the create path does not set the field, and
  // `resolveRetryDecision` falls back to `DEFAULT_RETRY_POLICY` per key. `{}`
  // means "the documented defaults", never "retry nothing".
  return issues;
}

function validateCallingWindow(
  body: Record<string, unknown>,
  base: CampaignConfigBase,
): CampaignConfigIssue[] {
  const issues: CampaignConfigIssue[] = [];

  for (const field of ['calling_window_start', 'calling_window_end'] as const) {
    const value = body[field];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !TIME_RE.test(value)) {
      // A malformed TIME reaches Postgres as `22007` inside the INSERT and
      // surfaces as a masked 500 with no field for the operator to correct.
      issues.push({ field, message: `${field} must be a 24-hour time, HH:MM or HH:MM:SS.` });
    }
  }

  // Evaluated on the EFFECTIVE window — this body applied over what is already in
  // force — not on the body alone. A PATCH setting only `calling_window_start` to
  // the stored `calling_window_end`, or a POST setting only one side against the
  // column default, produces a campaign that can never dial while a body-only
  // check sees nothing wrong. The rule is about the resulting campaign.
  const rawStart = body['calling_window_start'] ?? base.calling_window_start;
  const rawEnd = body['calling_window_end'] ?? base.calling_window_end;
  const touchesWindow = body['calling_window_start'] !== undefined
    || body['calling_window_end'] !== undefined;
  if (
    touchesWindow
    && typeof rawStart === 'string' && typeof rawEnd === 'string'
    && TIME_RE.test(rawStart) && TIME_RE.test(rawEnd)
    // Compared NORMALISED: '09:00' and '09:00:00' are the same instant, Postgres
    // renders the column as the latter, and an edit-then-save round trip mixes
    // the two in one body. A raw `===` lets exactly that pair through.
    && toComparableTime(rawStart) === toComparableTime(rawEnd)
  ) {
    // `nextWindowOpen` returns null for `start === end` — "no opening exists",
    // NOT a 24-hour window — so every contact defers forever an hour at a time.
    // A wrapping window (22:00 → 06:00) is a real configuration and must not be
    // caught here; `callingWindowState` handles `start > end` explicitly.
    issues.push({
      field: 'calling_window_end',
      message: 'The calling window cannot start and end at the same time — the campaign would never dial. For an all-day window use 00:00 to 23:59.',
    });
  }

  const days = body['calling_days'];
  if (days !== undefined) {
    if (!Array.isArray(days)) {
      issues.push({ field: 'calling_days', message: 'calling_days must be an array of day numbers.' });
    } else if (days.length === 0) {
      // `normalizeDays` reads `[]` as "no day is dialable" and deliberately does
      // not widen it to every day, so this saves a campaign that never dials.
      issues.push({
        field: 'calling_days',
        message: 'Select at least one calling day — the campaign would never dial.',
      });
    } else {
      days.forEach((day, i) => {
        if (typeof day !== 'number' || !Number.isInteger(day) || day < 1 || day > 7) {
          issues.push({
            field: `calling_days[${i}]`,
            // ISO-8601: 1=Mon…7=Sun, and `0` is REFUSED rather than read as
            // Sunday. The column default `{1,2,3,4,5}` is Mon–Fri under both
            // Postgres `dow` (0=Sun) and `isodow` (1=Mon), so the ambiguity is
            // undetectable by testing the default and would surface as an
            // off-by-one on Sundays months later. A caller sending `0` believes
            // `dow`, so accepting it means we and they disagree about which days
            // the campaign runs, silently. `calling-hours.ts` states the same rule.
            message: 'Days are ISO-8601: 1 = Monday … 7 = Sunday. 0 is not a valid day.',
          });
        }
      });
    }
  }

  const timezone = body['default_timezone'];
  if (timezone !== undefined) {
    if (typeof timezone === 'string' && timezone.length > MAX_TIMEZONE_LENGTH) {
      // Caught before Postgres, where it is a 22001 the operator reads as a 500.
      issues.push({
        field: 'default_timezone',
        message: `default_timezone must be at most ${MAX_TIMEZONE_LENGTH} characters.`,
      });
    } else if (typeof timezone !== 'string' || !isUsableTimezone(timezone)) {
      // The `typeof` arm is not redundant with `isUsableTimezone`'s own string
      // check — it is what narrows `unknown` for the compiler. Both arms produce
      // the same message because both mean the same thing to an operator: this is
      // not a zone we can evaluate.
      issues.push({
        field: 'default_timezone',
        /**
         * `isUsableTimezone` is imported from `calling-hours.ts` rather than
         * reimplemented, and that is the load-bearing choice: it is the same
         * function the dial-time gate uses, so this validator cannot come to
         * disagree with the gate it exists to protect. A local copy would be a
         * second definition of "usable zone" beside the gate it is meant to agree with.
         *
         * It carries the abbreviation gate the obvious validator lacks:
         * `new Intl.DateTimeFormat(undefined, { timeZone: 'EST' })` **does not
         * throw** — ICU resolves `EST` to a zone observing no DST — so an `EST`
         * campaign would place every call an hour early for half the year and
         * test clean whenever anyone checked. The shape rule refuses it; `Intl`
         * alone never would.
         */
        message: "default_timezone must be a full IANA zone name like 'America/New_York' or 'Asia/Kolkata', or exactly 'UTC'. Abbreviations such as 'EST' are refused: they resolve to a zone that does not observe daylight saving, which would place every call an hour early for half the year.",
      });
    }
  }

  return issues;
}

/**
 * Validate whichever config fields a create or patch body carries.
 *
 * Absent fields are neither defaulted nor complained about — this serves PATCH as
 * well as POST, and a partial update must be able to touch one field. `base`
 * supplies the effective values the body is applied over, so the one cross-field
 * rule can still be evaluated: pass {@link CAMPAIGN_CONFIG_COLUMN_DEFAULTS} on a
 * create and the stored campaign on a patch.
 *
 * Returns EVERY issue rather than the first, because a console renders them
 * against the fields at once and a one-at-a-time surface makes an operator fix a
 * five-field form in five round trips.
 */
export function validateAgencyCampaignConfig(
  body: unknown,
  base: CampaignConfigBase = {},
  options: CampaignConfigOptions = {},
): CampaignConfigIssue[] {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return [];
  const record = body as Record<string, unknown>;

  const issues: CampaignConfigIssue[] = [];
  if (record['disposition_catalog'] !== undefined) {
    issues.push(...validateDispositionCatalog(
      record['disposition_catalog'],
      options.allowDispositionOverride ?? true,
    ));
  }
  issues.push(...validateOutcomeDispositions(record, base));
  if (record['retry_policy'] !== undefined) {
    issues.push(...validateRetryPolicy(record['retry_policy']));
  }
  if (record['abandonment_ceiling_pct'] !== undefined) {
    issues.push(...validateAbandonmentCeiling(record['abandonment_ceiling_pct']));
  }
  if (record['break_reasons'] !== undefined) {
    issues.push(...validateBreakReasonsReserved(record['break_reasons']));
  }
  issues.push(...validateBooleanSetting(record, 'allow_wrapup_redial'));
  // Inbound sticky routing (0024, `BOOLEAN NOT NULL DEFAULT true`): the same rule.
  issues.push(...validateBooleanSetting(record, 'inbound_sticky_enabled'));
  issues.push(...validateAssignmentSettings(record));
  issues.push(...validateCallingWindow(record, base));
  return issues;
}

/**
 * Why an outcome that is not mappable is refused (OD2). Keyed by every attempt outcome
 * outside `AGENCY_AUTO_DISPOSITION_OUTCOMES`, so an outcome added to the union must be
 * given a reason here (or made mappable) before this compiles.
 */
const UNMAPPABLE_OUTCOME_REASON: Readonly<Record<Exclude<AgencyAttemptOutcome, AgencyAutoDispositionOutcome>, string>> = {
  connected: 'an agent spoke to the customer and records the outcome themselves',
  agent_disconnected: 'it is our own fault, not something the customer did',
  orphaned: 'it is our own fault, not something the customer did',
  canceled: 'it is a dial we stopped ourselves, not something the customer did',
  machine: 'it never happens: answering-machine detection is off, so a voicemail is a connected call',
};

/** The tail of both "this entry claims a consequence" refusals (OD3). */
const AUTO_OUTCOME_IS_A_LABEL =
  'an automatic outcome is only a label and never changes what happens to the contact (the retry rules decide that)';

/**
 * Automatic outcomes for unanswered calls (`outcome_dispositions`, decisions OD1–OD8).
 *
 * The shape, whenever the body carries the map: an object keyed by the mappable outcomes
 * only, each value a code string. Then the cross-field rule (OD3, OD6), whenever the body
 * carries the map or the catalog, on the EFFECTIVE pair (the body over `base`): every
 * mapped code passes `autoDispositionRefusal` (`@magick-agency/domain/auto-disposition`,
 * the console's rule too). The catalog side is what refuses an edit that removes or
 * changes a mapped entry, keyed on the mapping so the operator sees which one.
 *
 * `base` follows the calling-window rule's convention: an ABSENT base value is unknown,
 * and the cross-field check is skipped unless the body carries both. The internal handler
 * passes the column defaults on a create (`CAMPAIGN_CONFIG_COLUMN_DEFAULTS`: `[]` and
 * `{}`), the stored campaign on a PATCH and the parent on a retry; the public API layer,
 * which holds no stored campaign, passes none. Exported for it: same rules, same messages.
 */
export function validateOutcomeDispositions(
  record: Record<string, unknown>,
  base: CampaignConfigBase = {},
): CampaignConfigIssue[] {
  const hasMap = record['outcome_dispositions'] !== undefined;
  const hasCatalog = record['disposition_catalog'] !== undefined;
  if (!hasMap && !hasCatalog) return [];

  if (hasMap) {
    const map = record['outcome_dispositions'];
    if (map === null || typeof map !== 'object' || Array.isArray(map)) {
      return [{ field: 'outcome_dispositions', message: 'outcome_dispositions must be an object keyed by outcome.' }];
    }
    const shapeIssues: CampaignConfigIssue[] = [];
    for (const [key, code] of Object.entries(map as Record<string, unknown>)) {
      const field = `outcome_dispositions.${key}`;
      if (!isAutoDispositionOutcome(key)) {
        const reason = Object.hasOwn(UNMAPPABLE_OUTCOME_REASON, key)
          ? UNMAPPABLE_OUTCOME_REASON[key as keyof typeof UNMAPPABLE_OUTCOME_REASON]
          : undefined;
        shapeIssues.push({
          field,
          message: reason
            ? `'${key}' cannot have an automatic outcome: ${reason}.`
            : `'${key}' is not an unanswered-call outcome. Valid keys: ${AGENCY_AUTO_DISPOSITION_OUTCOMES.join(', ')}.`,
        });
      } else if (typeof code !== 'string' || !DISPOSITION_CODE_RE.test(code)) {
        shapeIssues.push({ field, message: 'Each automatic outcome must be a disposition code from this campaign\'s outcome list.' });
      }
    }
    if (shapeIssues.length > 0) return shapeIssues;
  }

  const map = hasMap ? record['outcome_dispositions'] : base.outcome_dispositions;
  const catalog = hasCatalog ? record['disposition_catalog'] : base.disposition_catalog;
  // Unknown (no base), or a malformed catalog: that is the catalog validator's refusal.
  // The stored map is an object (the column CHECK, and the shape check above).
  if (map === undefined || !Array.isArray(catalog)) return [];

  const issues: CampaignConfigIssue[] = [];
  for (const [outcome, code] of Object.entries(map as Record<string, unknown>)) {
    if (!isAutoDispositionOutcome(outcome) || typeof code !== 'string') continue;
    const refusal = autoDispositionRefusal(catalog, code);
    if (refusal === null) continue;
    const calls = `“${ATTEMPT_OUTCOME_LABELS[outcome]}” calls`;
    // Worded for the edit that caused it: a map naming a missing code, or a catalog edit
    // that took away a mapped one.
    const message = refusal === 'missing'
      ? hasMap
        ? `'${code}' is not in this campaign's outcome list. Pick an outcome from the list for ${calls}.`
        : `The outcome list no longer has '${code}', the automatic outcome for ${calls}. Choose another automatic outcome for them first.`
      : `'${code}' ${refusal === 'suppress' ? 'stops the number being called' : 'closes the contact'}, so it cannot be the automatic outcome for ${calls}: ${AUTO_OUTCOME_IS_A_LABEL}.`;
    issues.push({ field: `outcome_dispositions.${outcome}`, message });
  }
  return issues;
}

/** Why each reserved break code is reserved, as the refusal tells the operator. */
const RESERVED_BREAK_REASON_OWNER: Readonly<Record<AgencyReservedBreakReason, string>> = {
  [SOFTPHONE_BREAK_REASON]: 'the soft phone',
  [DEVICE_AWAY_BREAK_REASON]: 'the mobile app (sent when it is backgrounded)',
  [PHONE_CALL_BREAK_REASON]: 'the mobile app (sent while the agent is on a phone call)',
};

/**
 * A campaign's break catalog may not list a reserved reason (`RESERVED_BREAK_REASONS`:
 * the soft phone's {@link SOFTPHONE_BREAK_REASON}, the mobile app's
 * {@link DEVICE_AWAY_BREAK_REASON}). The catalog drops them when read
 * (`resolveBreakReasons`), so neither could ever be offered from the break menu;
 * refusing them at the write tells the operator so instead of storing an entry that
 * silently does nothing. One issue per reserved code listed.
 */
function validateBreakReasonsReserved(value: unknown): CampaignConfigIssue[] {
  if (!Array.isArray(value)) return [];
  const listed = new Set(value.map((r) => (!!r && typeof r === 'object' ? (r as { code?: unknown }).code : undefined)));
  return RESERVED_BREAK_REASONS.filter((code) => listed.has(code)).map((code) => ({
    field: 'break_reasons',
    message: `break_reasons may not list "${code}": it is reserved for ${RESERVED_BREAK_REASON_OWNER[code]}.`,
  }));
}

/**
 * The per-campaign abandonment ceiling.
 *
 * Bounds mirror the `abandonment_ceiling_pct` CHECK exactly. They are restated here rather
 * than derived because the two answer different questions — this one tells an
 * operator what is wrong with their input, the constraint stops a bad row
 * reaching the table whatever wrote it — but they must agree, so a change to
 * either belongs in the same commit as the other.
 *
 * `> 0`, not `>= 0`: a ceiling of 0 pauses on the first abandoned call, and
 * abandonment is not fully avoidable at any concurrency, so it would read as a
 * strict setting and behave as a kill switch. An operator who wants no dialing
 * has `pause`.
 */
function validateAbandonmentCeiling(value: unknown): CampaignConfigIssue[] {
  const field = 'abandonment_ceiling_pct';
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return [{ field, message: `${field} must be a number.` }];
  }
  if (value <= 0 || value > 100) {
    return [{ field, message: `${field} must be greater than 0 and at most 100.` }];
  }
  return [];
}

/** `{ field: message }`, the shape the internal handler's routes already send as `details`. */
export function issuesToDetails(issues: readonly CampaignConfigIssue[]): Record<string, string> {
  const details: Record<string, string> = {};
  for (const issue of issues) {
    // First message per field wins: two messages cannot both render next to one
    // field, and the first ran earliest and is therefore the more structural.
    if (!(issue.field in details)) details[issue.field] = issue.message;
  }
  return details;
}

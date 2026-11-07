import type {
  AgencyCampaign,
  AgencyDispositionEntry,
  AgencyRetryOutcome,
  AgencyRetryRule,
} from '../types/agency-campaign';
import { hhmm } from './format/weekdays';
import type { AgencyDispositionOverride } from '@magick-agency/contracts/agency';
import { ASSIGNMENT_MODE_COPY } from './agencyAssignmentCopy';
import { DEFAULT_ABANDONMENT_CEILING_PCT } from './agency/abandonmentCeiling';
import {
  type AssignmentConfigState,
  type CampaignConfigState,
  DEFAULT_ASSIGNMENT_CONFIG,
  DEFAULT_DISPOSITIONS,
  DEFAULT_DISPOSITION_RETRY,
  OUR_FAULT_RETRY_DEFAULT,
  OUR_FAULT_RETRY_OUTCOMES,
  OUTCOME_LABELS,
  isBuiltInCode,
} from './agency/config/configConstants';
// The vocabulary, the validation and the calling-window echo live in
// `./agency/config/`, re-exported so every import of this module keeps working.
export * from './agency/config/configConstants';
export * from './agency/config/configValidate';
export { callingWindowEcho, describeDays, isUsableTimezone } from './agency/config/callingWindow';

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

  const allows = overrideSummary(entry);
  if (allows) parts.push(allows);

  return parts.join(' ');
}

/**
 * What an outcome's override lets the contact's agent do next, as one sentence,
 * or `null` when it grants nothing or nothing would read it (an entry that
 * suppresses or ends the contact; the server refuses an override there).
 */
export function overrideSummary(entry: AgencyDispositionEntry): string | null {
  const override = entry.override;
  if (!override || entry.suppress || entry.terminal) return null;
  const allows: string[] = [];
  if (override.extra_attempts && override.extra_attempts > 0) {
    allows.push(
      `${override.extra_attempts} extra attempt${override.extra_attempts === 1 ? '' : 's'} past the limit`,
    );
  }
  if (override.retry_delay) allows.push('a call before the next scheduled time');
  if (override.calling_hours) allows.push('a call outside calling hours, with a note');
  if (allows.length === 0) return null;
  return `The agent may then make ${joinAnd(allows)}.`;
}

/** `a`, `a and b`, `a, b and c`. */
export function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
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

/** The entry without its `override` key (an outcome that grants nothing). */
function withoutOverride<T extends { override?: unknown }>(entry: T): Omit<T, 'override'> {
  const { override: _override, ...rest } = entry;
  void _override;
  return rest;
}

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
function cloneDisposition(entry: AgencyDispositionEntry): AgencyDispositionEntry {
  return {
    ...entry,
    ...(entry.retry ? { retry: { ...entry.retry } } : {}),
    // The override is nested the same way and edited the same way, so it is
    // copied for the same reason.
    ...(entry.override ? { override: { ...entry.override } } : {}),
  };
}

export const EMPTY_CAMPAIGN_CONFIG: CampaignConfigState = {
  dispositions: DEFAULT_DISPOSITIONS.map(cloneDisposition),
  retryPolicy: {},
  window: { start: '09:00', end: '20:00', days: [1, 2, 3, 4, 5], timezone: 'Asia/Kolkata' },
  wrapupSeconds: 30,
  autoReturn: true,
  allowWrapupRedial: false,
  abandonmentCeilingPct: DEFAULT_ABANDONMENT_CEILING_PCT,
  abandonmentCeilingStoredPct: null,
  assignment: { ...DEFAULT_ASSIGNMENT_CONFIG },
};

/**
 * The outcome catalog editor's state: the entries, and which rows still take
 * their code from their label.
 *
 * ── Which rows may follow their label ───────────────────────────────────────
 * Rows this session ADDED, and only until their code is typed into. The
 * obvious stateless test, "the code still equals the label's own slug", is
 * wrong on a campaign that already exists: a careful operator who typed
 * `promised_to_pay` beside "Promised to pay" months ago produces an entry that
 * passes it on the very first render, so fixing a typo in the label would
 * silently rewrite a code every historical call record is filed under. A loaded
 * row is therefore never in the set — a code that has been saved once is the
 * operator's, not ours.
 *
 * Indices, kept in step with the list by {@link editCatalog}: the same identity
 * the list itself uses for its keys.
 */
export interface CatalogEditState {
  dispositions: AgencyDispositionEntry[];
  autoCodeRows: ReadonlySet<number>;
  /**
   * The rows that ARE built-in outcomes: locked code, cannot be removed. A
   * property of the row, fixed when the catalog is seeded or loaded
   * ({@link builtInRowsOf}) and kept in step through removes and moves — never
   * re-read from the row's current code. Deciding it from the code meant a
   * custom row whose code was typed (or slugged from a label) into `voicemail`
   * turned into the locked built-in mid-keystroke: its code input was swapped
   * for the chip and focus went with it. Such a row stays custom, and the
   * catalog's validation reports the duplicate code.
   */
  builtInRows: ReadonlySet<number>;
}

/**
 * The rows of a seeded or loaded catalog that are built-ins: the FIRST row
 * carrying each built-in code. A later row with the same code is a duplicate
 * that validation reports, and is left editable so it can be fixed.
 */
export function builtInRowsOf(dispositions: readonly AgencyDispositionEntry[]): ReadonlySet<number> {
  const rows = new Set<number>();
  const seen = new Set<string>();
  dispositions.forEach((entry, index) => {
    if (isBuiltInCode(entry.code) && !seen.has(entry.code)) {
      seen.add(entry.code);
      rows.add(index);
    }
  });
  return rows;
}

/** Keep a set of row indices in step with the removal of row `removed`. */
function shiftPastRemoved(rows: ReadonlySet<number>, removed: number): Set<number> {
  const next = new Set<number>();
  for (const row of rows) {
    if (row < removed) next.add(row);
    else if (row > removed) next.add(row - 1);
  }
  return next;
}

/** Keep a set of row indices in step with rows `a` and `b` swapping places. */
function swapRows(rows: ReadonlySet<number>, a: number, b: number): Set<number> {
  const next = new Set(rows);
  next.delete(a);
  next.delete(b);
  if (rows.has(b)) next.add(a);
  if (rows.has(a)) next.add(b);
  return next;
}

/** One edit to the catalog, as the editor's controls produce them. */
export type CatalogEdit =
  /** Append an empty row, which follows its label. */
  | { type: 'add' }
  /** Change a row's label — and its code, while the row follows its label. */
  | { type: 'rename'; index: number; label: string }
  /** A hand-typed code, which detaches the row from its label for good. */
  | { type: 'setCode'; index: number; code: string }
  /**
   * Any other field of a row (a flag, the retry rule). A patch that makes the row
   * suppress or end the contact drops its override: the server refuses one there.
   */
  | { type: 'update'; index: number; patch: Partial<AgencyDispositionEntry> }
  /**
   * One part of a row's override. `undefined` / `false` / `0` clears that part,
   * and clearing the last part removes the override, so an "all off" group never
   * saves as `{}` (which the server refuses: at least one part is set).
   */
  | { type: 'setOverride'; index: number; patch: Partial<AgencyDispositionOverride> }
  /** Switch a row's own retry on (seeded from the voicemail default) or off. */
  | { type: 'toggleRetry'; index: number; on: boolean }
  /** Delete a row. A built-in cannot be removed. */
  | { type: 'remove'; index: number }
  /** Swap a row with its neighbour. */
  | { type: 'move'; index: number; delta: -1 | 1 };

/**
 * Apply one edit, returning the next state — or the SAME state object for an
 * edit that changes nothing (a built-in's removal, a move off either end, an
 * index that is not a row), so a caller can skip the write.
 *
 * Pure: it replaces the arrays and the set rather than mutating them, which is
 * what lets the component hold the set in a ref without a mutation of the old
 * one leaking into a render that still reads it.
 */
export function editCatalog(state: CatalogEditState, edit: CatalogEdit): CatalogEditState {
  const { dispositions, autoCodeRows, builtInRows } = state;
  const patchRow = (index: number, patch: Partial<AgencyDispositionEntry>): AgencyDispositionEntry[] =>
    dispositions.map((entry, i) => (i === index ? { ...entry, ...patch } : entry));

  switch (edit.type) {
    case 'add':
      return {
        dispositions: [...dispositions, { code: '', label: '' }],
        autoCodeRows: new Set([...autoCodeRows, dispositions.length]),
        builtInRows,
      };
    case 'rename': {
      const entry = dispositions[edit.index];
      if (!entry) return state;
      const derive = autoCodeRows.has(edit.index) && !builtInRows.has(edit.index);
      return {
        dispositions: patchRow(edit.index, {
          label: edit.label,
          ...(derive ? { code: slugifyCode(edit.label) } : {}),
        }),
        autoCodeRows,
        builtInRows,
      };
    }
    case 'setCode': {
      if (!dispositions[edit.index]) return state;
      const rows = new Set(autoCodeRows);
      rows.delete(edit.index);
      return { dispositions: patchRow(edit.index, { code: edit.code }), autoCodeRows: rows, builtInRows };
    }
    case 'update': {
      const entry = dispositions[edit.index];
      if (!entry) return state;
      const merged = { ...entry, ...edit.patch };
      if (merged.override && (merged.suppress || merged.terminal)) {
        const rest = withoutOverride(merged);
        return {
          dispositions: dispositions.map((row, i) => (i === edit.index ? rest : row)),
          autoCodeRows,
          builtInRows,
        };
      }
      return { dispositions: patchRow(edit.index, edit.patch), autoCodeRows, builtInRows };
    }
    case 'setOverride': {
      const entry = dispositions[edit.index];
      if (!entry) return state;
      const next: AgencyDispositionOverride = { ...(entry.override ?? {}), ...edit.patch };
      // Only the parts that are on are kept, so the saved object names exactly
      // what the outcome grants.
      const kept: AgencyDispositionOverride = {};
      if (next.extra_attempts !== undefined && next.extra_attempts > 0) kept.extra_attempts = next.extra_attempts;
      if (next.retry_delay) kept.retry_delay = true;
      if (next.calling_hours) kept.calling_hours = true;
      const rest = withoutOverride(entry);
      const row: AgencyDispositionEntry = Object.keys(kept).length > 0 ? { ...rest, override: kept } : rest;
      return {
        dispositions: dispositions.map((current, i) => (i === edit.index ? row : current)),
        autoCodeRows,
        builtInRows,
      };
    }
    case 'toggleRetry':
      /*
        Seeded from the voicemail default rather than from zero, for the same
        reason the policy rows are: `max_attempts: 0` is a rule that never fires,
        so seeding it means switching the control on appears to do nothing.
      */
      if (!dispositions[edit.index]) return state;
      return {
        dispositions: patchRow(edit.index, { retry: edit.on ? { ...DEFAULT_DISPOSITION_RETRY } : undefined }),
        autoCodeRows,
        builtInRows,
      };
    case 'remove': {
      const entry = dispositions[edit.index];
      if (!entry || builtInRows.has(edit.index)) return state;
      return {
        dispositions: dispositions.filter((_, i) => i !== edit.index),
        autoCodeRows: shiftPastRemoved(autoCodeRows, edit.index),
        builtInRows: shiftPastRemoved(builtInRows, edit.index),
      };
    }
    case 'move': {
      /*
        Built-ins move like any other: the lock is against *deletion* (removing
        one removes a capability agents need), and it was never against position
        — the order is the agent's number-key order and nothing downstream reads
        it. The row's label-following and built-in-ness move with it.
      */
      const target = edit.index + edit.delta;
      const from = dispositions[edit.index];
      const to = dispositions[target];
      if (!from || !to) return state;
      const next = [...dispositions];
      next[edit.index] = to;
      next[target] = from;
      return {
        dispositions: next,
        autoCodeRows: swapRows(autoCodeRows, edit.index, target),
        builtInRows: swapRows(builtInRows, edit.index, target),
      };
    }
  }
}

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
    assignment: { ...EMPTY_CAMPAIGN_CONFIG.assignment },
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
    // Absent on a campaign read from a server that predates the setting: off.
    allowWrapupRedial: campaign.allow_wrapup_redial ?? EMPTY_CAMPAIGN_CONFIG.allowWrapupRedial,
    // Loaded as stored and remembered as stored (`abandonmentCeiling.ts`, "The
    // range"); the settings page re-seeds from each save's response.
    abandonmentCeilingPct: campaign.abandonment_ceiling_pct ?? EMPTY_CAMPAIGN_CONFIG.abandonmentCeilingPct,
    abandonmentCeilingStoredPct: campaign.abandonment_ceiling_pct ?? null,
    assignment: assignmentFromCampaign(campaign),
  };
}

/**
 * The assignment settings off a campaign, each `??` its 0009 default: absent on a
 * campaign read from a server that predates them, which behaves as the defaults.
 */
function assignmentFromCampaign(campaign: AgencyCampaign): AssignmentConfigState {
  const d = DEFAULT_ASSIGNMENT_CONFIG;
  return {
    mode: campaign.assignment_mode ?? d.mode,
    onUnstaff: campaign.on_unstaff ?? d.onUnstaff,
    callbackGraceMinutes: campaign.callback_owner_grace_minutes ?? d.callbackGraceMinutes,
    callbackFallback: campaign.callback_fallback ?? d.callbackFallback,
    allowAgentRetry: campaign.allow_agent_retry ?? d.allowAgentRetry,
    agentRetryRounds: campaign.agent_retry_rounds ?? d.agentRetryRounds,
    agentRetryCooldownMinutes: campaign.agent_retry_cooldown_minutes ?? d.agentRetryCooldownMinutes,
  };
}

/**
 * What a stored campaign still holds of contact assignment beyond the defaults, as
 * short phrases for the settings page's flag-off notice (empty when it holds
 * nothing). Read from the LOADED campaign, never the form, so the notice stays
 * put until a reset is actually saved.
 */
export function storedAssignmentLeftovers(campaign: AgencyCampaign): string[] {
  const a = assignmentFromCampaign(campaign);
  const d = DEFAULT_ASSIGNMENT_CONFIG;
  const parts: string[] = [];
  if (a.mode !== d.mode) parts.push(`the “${ASSIGNMENT_MODE_COPY[a.mode].label}” assignment mode`);
  if (a.allowAgentRetry !== d.allowAgentRetry) parts.push('agent retry');
  if (a.onUnstaff !== d.onUnstaff) parts.push('keeping contacts with agents taken off it');
  if (
    a.callbackGraceMinutes !== d.callbackGraceMinutes
    || a.callbackFallback !== d.callbackFallback
    || a.agentRetryRounds !== d.agentRetryRounds
    || a.agentRetryCooldownMinutes !== d.agentRetryCooldownMinutes
  ) {
    parts.push('changed callback or retry timings');
  }
  const overrides = (campaign.disposition_catalog ?? []).filter((entry) => entry.override != null).length;
  if (overrides > 0) parts.push(`${overrides} outcome override${overrides === 1 ? '' : 's'}`);
  return parts;
}

/**
 * The form with contact assignment put back to the defaults: every setting at
 * `DEFAULT_ASSIGNMENT_CONFIG` and no catalog entry carrying an `override`. The
 * way out after the flag is turned off; saved with an assignment scope that SENDS
 * the defaults (the server lets a default through with the flag off).
 */
export function resetAssignmentConfig(state: CampaignConfigState): CampaignConfigState {
  return {
    ...state,
    assignment: { ...DEFAULT_ASSIGNMENT_CONFIG },
    dispositions: state.dispositions.map((entry) => withoutOverride(cloneDisposition(entry))),
  };
}

/**
 * Postgres renders a `TIME` column as `HH:MM:SS`; `<input type="time">` wants
 * `HH:MM`. Without this a loaded campaign shows an empty time field, which the
 * operator then re-types — and a round trip that loses a value is exactly what
 * acceptance (c) forbids.
 */
function trimSeconds(value: string | null | undefined): string | null {
  return value ? hhmm(value) : null;
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
 * Which contact-assignment settings a save sends.
 *
 *  - `all`: every one, always, including the defaults, so a value turned back to
 *    its default is saved too (the same reason `wrapup_auto_return` is always sent).
 *  - `settings_only`: everything but `assignment_mode`. The mode changes only while
 *    the campaign is draft or paused (`409 mode_change_requires_pause` otherwise),
 *    and its control is locked then, so the value cannot have changed; leaving it
 *    out keeps every other save on a running campaign from depending on how the
 *    server compares an unchanged mode.
 *  - `none`: the `agency_contact_assignment_enabled` flag is off. The settings are
 *    not shown and not sent, so the campaign keeps what it stores. The catalog is
 *    still sent whole, stored `override`s included: the server's gate
 *    (`campaign-assignment-gate.ts`) lets through, with the flag off, any setting
 *    or override EQUAL to what the campaign already stores, and any value at its
 *    default; only a change away from both needs the flag. So an unchanged
 *    campaign set up while the flag was on keeps saving its other fields, and
 *    the way back to the defaults (`resetAssignmentConfig`, saved with
 *    `all` / `settings_only`) is always allowed.
 */
export type AssignmentPayloadScope = 'all' | 'settings_only' | 'none';

function assignmentPayload(
  assignment: AssignmentConfigState,
  scope: AssignmentPayloadScope,
): Partial<AgencyCampaign> {
  if (scope === 'none') return {};
  return {
    ...(scope === 'all' ? { assignment_mode: assignment.mode } : {}),
    on_unstaff: assignment.onUnstaff,
    callback_owner_grace_minutes: assignment.callbackGraceMinutes,
    callback_fallback: assignment.callbackFallback,
    allow_agent_retry: assignment.allowAgentRetry,
    agent_retry_rounds: assignment.agentRetryRounds,
    agent_retry_cooldown_minutes: assignment.agentRetryCooldownMinutes,
  };
}

/**
 * The PATCH body.
 *
 * `retry_policy` is sent as-is including `{}`, because the server's
 * `DEFAULT_RETRY_POLICY` falls back **per key** — an empty policy means "the
 * documented defaults", not "retry nothing", and that is the ordinary case. The
 * one exception is {@link NEVER_SENT_RETRY_OUTCOMES}; everything else round-trips
 * untouched, including keys this form does not render.
 */
export function buildConfigPayload(
  state: CampaignConfigState,
  scope: AssignmentPayloadScope = 'all',
): Partial<AgencyCampaign> {
  const retryPolicy = { ...state.retryPolicy };
  for (const key of NEVER_SENT_RETRY_OUTCOMES) delete retryPolicy[key];

  return {
    ...assignmentPayload(state.assignment, scope),
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
    // Sent unconditionally for the same reason: `false` must be sendable to turn
    // it back off.
    allow_wrapup_redial: state.allowWrapupRedial,
    // Sent on every save, the builder's first one included, so the value on screen
    // is the value the guardrail pauses at. A PATCH that changes it is written to the
    // campaign's activity with its old and new value (`agency_campaign.config_changed`).
    // `abandonmentCeilingStoredPct` is the form's own bookkeeping and is not sent.
    abandonment_ceiling_pct: state.abandonmentCeilingPct,
  };
}

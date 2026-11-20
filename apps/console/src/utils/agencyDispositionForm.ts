import type { AgencyDisposition } from '../types/agency';
import { AGENCY_PROMISE_MAX_DAYS_AHEAD } from '@magick-agency/contracts/agency';
import {
  daysBetween,
  normalisePromiseAmount,
  parsePromiseDate,
  type PromiseDay,
} from '@magick-agency/domain/promise-to-pay';

/**
 * Disposition form logic (requirement: *a required note blocks
 * submission client-side and is also enforced server-side*).
 *
 * Pure and separate from the pad, following the house pattern set by
 * `analysisProfileForm.ts` and `escalationForm.ts` — no form library, hand-rolled
 * `useState` in the component, all the rules unit-tested here.
 *
 * **This module owns the client half only.** The server half belongs to the server, and the
 * two are not redundant: the client guard is there so an agent is never left
 * pressing a button that will fail, and the server guard is there because the
 * client's can be bypassed. Criterion (c) names both deliberately.
 */

export interface DispositionFormState {
  /** Catalog `code`, or null when nothing is selected yet. */
  selectedCode: string | null;
  notes: string;
  /** ISO-8601 local datetime string from the picker, or null. */
  callbackAt: string | null;
  /**
   * Promise to pay (PT1): the date picker's `YYYY-MM-DD`, and the amount as typed. Optional,
   * so a form built before them reads as "no promise entered".
   */
  promiseDate?: string | null;
  promiseAmount?: string;
}

export const EMPTY_DISPOSITION_FORM: DispositionFormState = {
  selectedCode: null,
  notes: '',
  callbackAt: null,
};

/** Why submit is blocked. `null` ⇒ submit is enabled. */
export type DispositionBlockReason =
  | 'no_selection'
  | 'note_required'
  | 'datetime_required'
  | 'callback_in_past'
  | 'promise_required'
  | 'promise_date_invalid'
  | 'promise_amount_invalid';

/**
 * Copy for each block reason. Rendered **beside the submit control**, never as a
 * toast: an agent must never return to `available` believing a disposition saved
 * when it did not.
 *
 * Callback copy — always "we", never "I" (a shared pool: a callback re-enters the roster as an
 * ordinary pending contact and whichever agent is available takes it, so copy
 * promising the agent will make it personally is a promise the product breaks).
 */
export const DISPOSITION_BLOCK_COPY: Record<DispositionBlockReason, string> = {
  no_selection: 'Pick a disposition to save this call.',
  note_required: 'This disposition needs a note.',
  datetime_required: 'This disposition needs a callback time.',
  callback_in_past: "That time has already passed. Pick when we should call back.",
  promise_required: 'This outcome needs the date the customer promised to pay.',
  promise_date_invalid: `Pick a promised date from today up to ${AGENCY_PROMISE_MAX_DAYS_AHEAD} days ahead.`,
  promise_amount_invalid: 'Enter the amount as a number, with up to two decimal places and no commas.',
};

/** The agent's own calendar date at `now` (the browser's zone). */
export function localDay(now: number): PromiseDay {
  const d = new Date(now);
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
}

/**
 * The client half of the promised date's rule (PT4). The server judges "today" in the
 * CUSTOMER's zone, which this screen is not given (see the callback row's timezone note), so
 * the pad allows one day either side of the agent's own today and lets the server decide the
 * edge: an agent in Kolkata speaking to a customer still on yesterday's date in New York can
 * record "today" for them. A real date, never far ahead.
 */
export function promiseDateBlocked(value: string | null | undefined, now: number): boolean {
  const d = parsePromiseDate(value);
  if (!d) return true;
  const ahead = daysBetween(localDay(now), d);
  return ahead < -1 || ahead > AGENCY_PROMISE_MAX_DAYS_AHEAD + 1;
}

export function findDisposition(
  catalog: AgencyDisposition[],
  code: string | null,
): AgencyDisposition | null {
  if (code === null) return null;
  return catalog.find((entry) => entry.code === code) ?? null;
}

/**
 * Whether the note requirement is satisfied.
 *
 * **Whitespace does not count.** A note of three spaces satisfying a
 * compliance-adjacent requirement is a bug, and it is the exact thing an agent
 * under time pressure will type.
 */
export function noteSatisfied(entry: AgencyDisposition | null, notes: string): boolean {
  if (!entry?.requires_note) return true;
  return notes.trim().length > 0;
}

/**
 * The single validation entry point. Returns the first block reason, or null.
 *
 * Deliberately re-evaluated on **every keystroke** by the caller rather than on
 * blur: a submit button that stays disabled until the field loses focus reads as
 * broken, and the agent's next move is to click it repeatedly.
 *
 * There is **no minimum length beyond non-empty**. A character floor does not
 * produce better notes, it produces `asdfasdf`.
 */
export function blockReason(
  catalog: AgencyDisposition[],
  form: DispositionFormState,
  now: number,
): DispositionBlockReason | null {
  const entry = findDisposition(catalog, form.selectedCode);
  if (entry === null) return 'no_selection';
  if (!noteSatisfied(entry, form.notes)) return 'note_required';

  if (entry.requires_datetime) {
    if (!form.callbackAt) return 'datetime_required';
    const parsed = Date.parse(form.callbackAt);
    // Unparseable is treated as absent rather than as its own error: the picker
    // is the only way to set it, so an unparseable value means the picker is
    // empty or mid-edit, and "needs a callback time" is the true and useful
    // thing to say.
    if (!Number.isFinite(parsed)) return 'datetime_required';
    if (parsed <= now) return 'callback_in_past';
  }

  if (entry.requires_promise) {
    if (!form.promiseDate) return 'promise_required';
    if (promiseDateBlocked(form.promiseDate, now)) return 'promise_date_invalid';
    const amount = form.promiseAmount?.trim() ?? '';
    if (amount !== '' && normalisePromiseAmount(amount) === null) return 'promise_amount_invalid';
  }

  return null;
}

export function canSubmit(
  catalog: AgencyDisposition[],
  form: DispositionFormState,
  now: number,
): boolean {
  return blockReason(catalog, form, now) === null;
}

export interface DispositionSubmitPayload {
  disposition_code: string;
  notes?: string;
  callback_at?: string;
  /** PT1: only for an outcome that asks for a promise; the amount only when one was typed. */
  promise_date?: string;
  promise_amount?: string;
}

/**
 * Builds the wire payload. Returns null when the form is not submittable, so a
 * caller cannot construct a request the guard would have refused.
 *
 * Notes are sent whenever non-empty after trimming — including for a code that
 * does not require them, because an agent who typed something meant it. An empty
 * note is omitted rather than sent as `''`, so it cannot overwrite a note already
 * saved through the separate notes route.
 *
 * `callback_at` is normalised to ISO-8601 UTC. The picker works in the agent's
 * browser timezone, which is not necessarily the customer's — contact-timezone
 * handling is Phase 3 — so the resolved zone is rendered beside the choice rather
 * than left implicit, and what goes on the wire is unambiguous.
 */
export function buildSubmitPayload(
  catalog: AgencyDisposition[],
  form: DispositionFormState,
  now: number,
): DispositionSubmitPayload | null {
  if (!canSubmit(catalog, form, now)) return null;

  const payload: DispositionSubmitPayload = { disposition_code: form.selectedCode! };
  const trimmed = form.notes.trim();
  if (trimmed.length > 0) payload.notes = trimmed;

  const entry = findDisposition(catalog, form.selectedCode);
  if (entry?.requires_datetime && form.callbackAt) {
    payload.callback_at = new Date(Date.parse(form.callbackAt)).toISOString();
  }

  // Only for the outcome that asks: a date left in the form from an earlier selection is never
  // sent with another outcome (the server would refuse it, `promise_not_expected`).
  if (entry?.requires_promise && form.promiseDate) {
    payload.promise_date = form.promiseDate;
    const amount = normalisePromiseAmount(form.promiseAmount?.trim() ?? '');
    if (amount !== null) payload.promise_amount = amount;
  }

  return payload;
}

/**
 * `1`–`9` map to the first nine catalog entries **in the order the server delivered
 * them**.
 *
 * The catalog is never re-sorted — not by label, not by success flag, not by
 * anything. A client-side sort silently remaps every agent's muscle memory the
 * moment an admin renames a code, and it is invisible in review because both
 * orders look perfectly reasonable.
 *
 * Returns null for a key with no entry behind it, so pressing `7` against a
 * five-code catalog does nothing rather than wrapping around to something.
 */
export function dispositionForNumberKey(
  catalog: AgencyDisposition[],
  key: string,
): AgencyDisposition | null {
  if (!/^[1-9]$/.test(key)) return null;
  return catalog[Number(key) - 1] ?? null;
}

/** Number keys 1–9 pick the first nine outcomes, by index in the server's order. */
export const NUMBER_KEY_COUNT = 9;

/**
 * What the keyboard drives on the outcome tiles (`WhatHappened`, an inbound call's and the soft
 * phone's): `C` selects the call-later outcome and focuses its first time chip, both halves in one
 * call, so the key and a pointer share one state machine. Keyed on the `requires_datetime` flag,
 * never on a code: a campaign may rename or replace the built-in codes.
 */
export interface DispositionPadHandle {
  selectCallback: () => boolean;
}

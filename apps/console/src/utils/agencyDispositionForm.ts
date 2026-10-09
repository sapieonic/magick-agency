import type { AgencyDisposition } from '../types/agency';

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
  | 'callback_in_past';

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
};

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

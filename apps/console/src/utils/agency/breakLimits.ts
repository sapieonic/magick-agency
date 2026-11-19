import { DEFAULT_BREAK_REASONS, breakLimitMinutes, isReservedBreakReason } from '@magick-agency/domain/break-manager';
import {
  AGENCY_BREAK_LIMIT_MAX_MINUTES,
  AGENCY_BREAK_LIMIT_MIN_MINUTES,
  isAgencyBreakLimitMinutes,
} from '@magick-agency/contracts/agency';
import type { AgencyBreakReason } from '../../types/agency';

/**
 * Break limits on the console (LF6, LF20, LF26, LF27): the limit of the break an agent is on, for
 * the station's countdown, and the campaign Settings editor's model of a campaign's break reasons.
 */

/**
 * The limit, in minutes, of a break on `code` under `reasons` (the bootstrap's `break_reasons`), by
 * the server's rule (`breakLimitMinutes`). Null before the bootstrap is read (`reasons` empty: the
 * rule would answer from the built-ins, and a campaign's own list may give that code no limit).
 */
export function breakLimitFor(code: string | null | undefined, reasons: AgencyBreakReason[]): number | null {
  return reasons.length === 0 ? null : breakLimitMinutes(code, reasons);
}

// ─── The editor (campaign Settings › Agents) ─────────────────────────────────

/** One break reason in the editor. */
export interface BreakLimitRow {
  /**
   * The entry as stored (or the built-in), every field of it: a save sends it back whole, with
   * only `limit_minutes` changed. Fields the console does not know ride along untouched.
   */
  reason: AgencyBreakReason;
  /** The limit as typed: `''` for none. */
  limit: string;
  /**
   * A reserved code listed by hand (written before the rule, or not through the console). Never
   * offered a limit, and left out of a save: the server refuses the catalog with it, and the
   * catalog read already drops it, so no agent was ever offered it (LF27).
   */
  reserved: boolean;
}

export interface BreakReasonsForm {
  /**
   * The campaign lists no reasons of its own, so these are the built-ins (Break, Tea 15, Lunch 30,
   * …), served at read time (LF20). Nothing is sent for them until a limit is changed; then the
   * whole list is saved, and becomes the campaign's own.
   */
  builtIn: boolean;
  rows: BreakLimitRow[];
}

function isEntry(value: unknown): value is AgencyBreakReason {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as { code?: unknown }).code === 'string'
    && (value as { code: string }).code.length > 0;
}

function limitText(reason: AgencyBreakReason): string {
  const value: unknown = (reason as { limit_minutes?: unknown }).limit_minutes;
  return value === undefined || value === null ? '' : String(value);
}

/**
 * The editor's model of a campaign's stored `break_reasons`, by the read's rule
 * (`resolveBreakReasons`): a list with no usable entry of its own (empty, absent, only reserved or
 * malformed entries) is the built-ins; otherwise the stored entries, reserved ones marked. A
 * stored limit is shown as stored, even one the rule refuses, so the editor can say it is wrong.
 */
export function breakReasonsFormOf(stored: unknown): BreakReasonsForm {
  const entries = Array.isArray(stored) ? stored.filter(isEntry) : [];
  if (!entries.some((r) => !isReservedBreakReason(r.code))) {
    return {
      builtIn: true,
      rows: DEFAULT_BREAK_REASONS.map((reason) => ({ reason: { ...reason }, limit: limitText(reason), reserved: false })),
    };
  }
  return {
    builtIn: false,
    rows: entries.map((reason) => ({ reason, limit: limitText(reason), reserved: isReservedBreakReason(reason.code) })),
  };
}

/** The editor's message for a typed limit, or null when it may be saved (`''` is no limit). */
export function breakLimitError(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (isAgencyBreakLimitMinutes(value)) return null;
  return `Enter whole minutes from ${AGENCY_BREAK_LIMIT_MIN_MINUTES} to ${AGENCY_BREAK_LIMIT_MAX_MINUTES}, or leave it empty for no limit.`;
}

/** Each row's error, keyed by its code; empty when every limit may be saved. */
export function breakReasonsErrors(form: BreakReasonsForm): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const row of form.rows) {
    if (row.reserved) continue;
    const error = breakLimitError(row.limit);
    if (error) errors[row.reason.code] = error;
  }
  return errors;
}

/**
 * The `break_reasons` a save sends: every entry, each with all its fields, its `limit_minutes`
 * set from the editor or left out for none (the server's way to clear one: `null` is refused).
 * Reserved entries are left out (see {@link BreakLimitRow.reserved}).
 */
export function breakReasonsPayload(form: BreakReasonsForm): AgencyBreakReason[] {
  return form.rows
    .filter((row) => !row.reserved)
    .map((row) => {
      const { limit_minutes: _old, ...rest } = row.reason;
      const trimmed = row.limit.trim();
      return trimmed === '' ? rest : { ...rest, limit_minutes: Number(trimmed) };
    });
}

/** Whether two forms would save the same limits (the unsaved-changes bar's one "break limits" setting). */
export function sameBreakLimits(a: BreakReasonsForm, b: BreakReasonsForm): boolean {
  if (a.rows.length !== b.rows.length) return false;
  return a.rows.every((row, i) => row.reason.code === b.rows[i]!.reason.code && row.limit.trim() === b.rows[i]!.limit.trim());
}

/** A copy of `form` with the limit of the reason `code` typed as `limit`. */
export function withBreakLimit(form: BreakReasonsForm, code: string, limit: string): BreakReasonsForm {
  return { ...form, rows: form.rows.map((row) => (row.reason.code === code ? { ...row, limit } : row)) };
}

/**
 * The row a server `break_reasons` refusal is about. The 400 carries one message per field
 * (`{ details: { break_reasons } }`), naming the entry's code in quotes ("The limit for "tea"
 * must be …", "… may not list "soft_phone" …"); null when it names no row on the form, and the
 * message is then shown for the list as a whole.
 */
export function breakReasonsIssueCode(message: string, form: BreakReasonsForm): string | null {
  for (const match of message.matchAll(/"([^"]+)"/g)) {
    const code = match[1];
    if (form.rows.some((row) => row.reason.code === code)) return code ?? null;
  }
  return null;
}

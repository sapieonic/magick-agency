/**
 * The Live floor's server rules (decision B28b), pure: the query windows of `GET /floor` and
 * `GET /promises/summary`, a break's label, and the floor's totals. The reads are
 * `db/repositories/agency/floor.repository.ts` and `promise-summary.repository.ts`; the internal
 * handler is `api/routes/agency/floor.ts`, the public routes `api/routes/proxy-agency-floor.routes.ts`.
 */
import {
  AGENCY_FLOOR_FROM_SKEW_MS,
  AGENCY_FLOOR_MAX_LOOKBACK_HOURS,
  type AgencyFloorTotals,
} from '@magick-agency/contracts/api/agency/floor';
import { AGENCY_PROMISES_SUMMARY_MAX_DAYS } from '@magick-agency/contracts/api/agency/promises';
import {
  RESERVED_BREAK_REASON_LABELS,
  type AgencyBreakReason,
  type AgencyReservedBreakReason,
} from '@magick-agency/contracts/agency';
import { isReservedBreakReason, resolveBreakReasons } from '@magick-agency/domain/break-manager';
import { parseInstant } from './insights/range.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** A query value read once: a repeated parameter is refused, not picked from. */
function single(raw: unknown): string | null {
  return typeof raw === 'string' ? raw : null;
}

/**
 * `GET /floor`'s `from`: an ISO-8601 instant with its offset, at most
 * {@link AGENCY_FLOOR_MAX_LOOKBACK_HOURS} before `now` and at most
 * {@link AGENCY_FLOOR_FROM_SKEW_MS} after it. The refusal's message otherwise.
 */
export function parseFloorFrom(raw: unknown, now: Date): { ok: true; from: Date } | { ok: false; message: string } {
  const text = single(raw);
  if (text === null || text === '') return { ok: false, message: '`from` is required: the instant today starts for you, e.g. 2026-11-18T00:00:00+05:30.' };
  const from = parseInstant(text);
  if (!from) return { ok: false, message: '`from` must be an ISO-8601 instant with its offset, e.g. 2026-11-18T00:00:00+05:30.' };
  if (from.getTime() > now.getTime() + AGENCY_FLOOR_FROM_SKEW_MS) return { ok: false, message: '`from` is in the future.' };
  if (now.getTime() - from.getTime() > AGENCY_FLOOR_MAX_LOOKBACK_HOURS * HOUR_MS) {
    return { ok: false, message: `\`from\` may be at most ${AGENCY_FLOOR_MAX_LOOKBACK_HOURS} hours ago.` };
  }
  return { ok: true, from };
}

/**
 * `GET /promises/summary`'s window: two ISO-8601 instants with their offsets, `from < to`, at most
 * {@link AGENCY_PROMISES_SUMMARY_MAX_DAYS} days apart. The refusal's message otherwise.
 */
export function parsePromisesWindow(rawFrom: unknown, rawTo: unknown): { ok: true; from: Date; to: Date } | { ok: false; message: string } {
  const fromText = single(rawFrom);
  const toText = single(rawTo);
  if (!fromText || !toText) return { ok: false, message: '`from` and `to` are both required ISO-8601 instants.' };
  const from = parseInstant(fromText);
  const to = parseInstant(toText);
  if (!from || !to) return { ok: false, message: '`from` and `to` must be ISO-8601 instants with their offsets, e.g. 2026-11-18T00:00:00+05:30.' };
  if (from.getTime() >= to.getTime()) return { ok: false, message: '`from` must be before `to`.' };
  if (to.getTime() - from.getTime() > AGENCY_PROMISES_SUMMARY_MAX_DAYS * DAY_MS) {
    return { ok: false, message: `The window may be at most ${AGENCY_PROMISES_SUMMARY_MAX_DAYS} days.` };
  }
  return { ok: true, from, to };
}

/**
 * The label and limit of a break code, the catalog resolved once: a reserved code's own label
 * (`RESERVED_BREAK_REASON_LABELS`) and no limit, else the campaign catalog's entry as the break menu
 * resolves it (`resolveBreakReasons`: the default catalog when the campaign lists none; the limit
 * as `breakLimitMinutes` reads it). Both null for no code, or a code neither knows.
 */
export function floorBreak(
  code: string | null,
  catalog: AgencyBreakReason[] | null,
): { label: string | null; limit_minutes: number | null } {
  if (!code) return { label: null, limit_minutes: null };
  if (isReservedBreakReason(code)) return { label: RESERVED_BREAK_REASON_LABELS[code as AgencyReservedBreakReason], limit_minutes: null };
  const reason = resolveBreakReasons(catalog).find((r) => r.code === code);
  return { label: reason?.label ?? null, limit_minutes: reason?.limit_minutes ?? null };
}

/**
 * Distinct people: on shift (a row not `offline`) and assigned (staffed on an active campaign, or
 * on shift), from rows that are one per person.
 */
export function floorTotals(rows: ReadonlyArray<{ state: string; staffed: boolean }>): AgencyFloorTotals {
  let onShift = 0;
  let assigned = 0;
  for (const row of rows) {
    const on = row.state !== 'offline';
    if (on) onShift += 1;
    if (on || row.staffed) assigned += 1;
  }
  return { on_shift: onShift, assigned };
}

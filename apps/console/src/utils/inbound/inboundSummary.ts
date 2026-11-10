import { AGENCY_INBOUND_SUMMARY_MAX_DAYS } from '../../types/inbound';

/**
 * The inbound summary's date ranges (`docs/inbound.md` §11): presets and a custom pair of dates,
 * both cut at the viewer's local midnights and sent as instants (`from` inclusive, `to`
 * exclusive), as the server's `GET /inbound/summary` reads them.
 */

export type InboundSummaryPreset = 'today' | '7d' | '30d' | 'custom';

export const INBOUND_SUMMARY_PRESETS: ReadonlyArray<{ id: Exclude<InboundSummaryPreset, 'custom'>; label: string; days: number }> = [
  { id: 'today', label: 'Today', days: 1 },
  { id: '7d', label: 'Last 7 days', days: 7 },
  { id: '30d', label: 'Last 30 days', days: 30 },
];

/** Local midnight of `date` plus `days` days (a DST change moves the instant, never the day). */
function localMidnight(date: Date, days = 0): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** `YYYY-MM-DD` of a local date. */
export function localDateInput(date: Date): string {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${mm}-${dd}`;
}

/** A `YYYY-MM-DD` input as its local midnight, or null. */
function parseLocalDate(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(date.getTime()) || localDateInput(date) !== value ? null : date;
}

export type InboundSummaryRange = { ok: true; from: Date; to: Date } | { ok: false; problem: string };

/**
 * The range a preset covers up to the end of today (so "Last 7 days" is today and the six before
 * it), or the custom dates inclusive. A custom range is refused with a sentence the page shows.
 */
export function inboundSummaryRange(
  preset: InboundSummaryPreset,
  now: Date,
  custom: { from: string; to: string } = { from: '', to: '' },
): InboundSummaryRange {
  if (preset !== 'custom') {
    const days = INBOUND_SUMMARY_PRESETS.find((p) => p.id === preset)!.days;
    return { ok: true, from: localMidnight(now, 1 - days), to: localMidnight(now, 1) };
  }
  const from = parseLocalDate(custom.from);
  const to = parseLocalDate(custom.to);
  if (!from || !to) return { ok: false, problem: 'Choose a start and an end date.' };
  if (from > to) return { ok: false, problem: 'The start date is after the end date. Swap them to continue.' };
  const end = localMidnight(to, 1);
  const days = Math.round((end.getTime() - from.getTime()) / 86_400_000);
  if (days > AGENCY_INBOUND_SUMMARY_MAX_DAYS) {
    return { ok: false, problem: `Choose at most ${AGENCY_INBOUND_SUMMARY_MAX_DAYS} days.` };
  }
  return { ok: true, from, to: end };
}

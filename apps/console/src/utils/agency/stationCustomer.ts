import type {
  AgencyContextDisplay,
  AgencyDisposition,
  AgencyPriorAttempt,
  AgencyReservedAttempt,
} from '../../types/agency';
import { resolveContextFields } from '../agencyContext';
import { priorDispositionLabel } from '../agencyPriorAttempts';
import { ATTEMPT_OUTCOME_WORDS } from './stationCopy';
import { calendarDay, dayMonth, initials, rupees } from './stationFormat';

/**
 * The customer card on Call coming, On call and What happened? (spec §3 03/04, §5.3), from the
 * reserved attempt and the campaign's `context_display`, with only today's data.
 *
 * ── Where new data slots in ──────────────────────────────────────────────────
 * Phase 0 guesses the name and place from the hero columns' names, and shows the other hero
 * columns as they were uploaded (with ₹ and "20 Nov" only when the text plainly is an amount or a
 * date). When the server sends typed facts (`attempt.facts`, BE-6) and column roles
 * (`context_display.roles`), {@link customerCard} takes them first and the guesses go; when it
 * sends the campaign's `phone_display` (AS9), `phone` is masked here. A field that is not there
 * yet is simply not shown.
 */
export interface CustomerFact {
  /** Stable key for React and tests. */
  key: string;
  label: string;
  value: string;
  kind: 'money' | 'date' | 'text' | 'last_call';
}

export interface CustomerCard {
  /** The customer's name, or null when no column could be read as one (the phone is then the title). */
  name: string | null;
  initials: string;
  place: string | null;
  phone: string;
  /** Up to three big number tiles: hero facts, then "Last call". */
  facts: CustomerFact[];
  /** "What they said last time": the latest earlier call's note. */
  lastSaid: string | null;
  /**
   * "Call later · You said you will call at 3:00 PM" (spec 03b). Needs `attempt.callback` (BE-4),
   * which the server does not send yet, so null today.
   */
  callLaterTag: string | null;
  /** "Calling again · 1 of 2" on a wrap-up redial. */
  redial: { number: number; of: number } | null;
}

const NAME = /^(full[\s_-]?)?name$|customer[\s_-]?name|^customer$|contact[\s_-]?name|first[\s_-]?name|client[\s_-]?name|borrower|^naam$/i;
const PLACE = /city|town|district|village|branch|region|zone|state|place|location|area/i;
const MONEY_LABEL = /amount|balance|due(?!.*date)|outstanding|premium|emi|total|overdue|arrear/i;
const DATE_LABEL = /date|due.?on|due.?by|day/i;

/** The phone as shown: the full number today (AS9's default); `masked` once the campaign says so. */
export function phoneForDisplay(phoneE164: string, display: 'full' | 'masked' = 'full'): string {
  if (display === 'full') return phoneE164;
  const digits = phoneE164.replace(/\D/g, '');
  const local = digits.length > 10 ? digits.slice(-10) : digits;
  if (local.length < 6) return phoneE164;
  return `${local.slice(0, 2)}••• ••${local.slice(-3)}`;
}

function factFrom(label: string, value: string, index: number): CustomerFact {
  if (MONEY_LABEL.test(label)) {
    const money = rupees(value);
    if (money) return { key: `hero-${index}`, label, value: money, kind: 'money' };
  }
  if (DATE_LABEL.test(label)) {
    const day = calendarDay(value);
    if (day !== value) return { key: `hero-${index}`, label, value: day, kind: 'date' };
  }
  return { key: `hero-${index}`, label, value, kind: 'text' };
}

/** The latest earlier call, by when it was dialled or ended. */
export function latestPrior(prior: readonly AgencyPriorAttempt[]): AgencyPriorAttempt | null {
  let best: AgencyPriorAttempt | null = null;
  let bestAt = -Infinity;
  for (const p of prior) {
    const at = Date.parse(p.ended_at ?? p.dialed_at ?? '');
    const when = Number.isFinite(at) ? at : -Infinity;
    if (best === null || when > bestAt) {
      best = p;
      bestAt = when;
    }
  }
  return best;
}

export function customerCard(
  attempt: AgencyReservedAttempt,
  display: AgencyContextDisplay | undefined,
  options: { phoneDisplay?: 'full' | 'masked' } = {},
): CustomerCard {
  const resolved = resolveContextFields(attempt.context, display);
  // Every non-empty column, heroes first, for the name and place guesses.
  const columns = [...resolved.hero, ...resolved.fields].filter((f) => !f.isEmpty);
  const nameField = columns.find((f) => NAME.test(f.label)) ?? null;
  const placeField = columns.find((f) => PLACE.test(f.label) && f !== nameField) ?? null;
  const heroFacts = resolved.hero
    .filter((f) => !f.isEmpty && f !== nameField && f !== placeField)
    .map((f, i) => factFrom(f.label, f.value, i));

  const latest = latestPrior(attempt.prior_attempts);
  const latestAt = latest ? Date.parse(latest.ended_at ?? latest.dialed_at ?? '') : NaN;
  const lastCall: CustomerFact | null = Number.isFinite(latestAt)
    ? { key: 'last-call', label: 'Last call', value: dayMonth(latestAt), kind: 'last_call' }
    : null;
  const facts = lastCall ? [...heroFacts.slice(0, 2), lastCall] : heroFacts.slice(0, 3);

  const withNote = [...attempt.prior_attempts]
    .filter((p) => p.notes?.trim())
    .sort((a, b) => Date.parse(b.ended_at ?? b.dialed_at ?? '') - Date.parse(a.ended_at ?? a.dialed_at ?? ''));
  const name = nameField?.value.trim() || null;

  return {
    name,
    initials: initials(name),
    place: placeField?.value.trim() || null,
    phone: phoneForDisplay(attempt.phone_e164, options.phoneDisplay ?? 'full'),
    facts,
    lastSaid: withNote[0]?.notes?.trim() ?? null,
    callLaterTag: null,
    redial: attempt.redial ? { number: attempt.redial.number, of: attempt.redial.number + attempt.redial.remaining } : null,
  };
}

/** One row of 04c's Last calls: date chip, what happened, the note or promise under it. */
export interface LastCallRow {
  key: string;
  date: string | null;
  outcome: string;
  detail: string | null;
}

/** Up to `limit` earlier calls, newest first, in the station's words. */
export function lastCallRows(
  attempt: AgencyReservedAttempt,
  catalog: readonly AgencyDisposition[] | undefined,
  limit = 3,
): LastCallRow[] {
  const sorted = [...attempt.prior_attempts].sort(
    (a, b) => (Date.parse(b.ended_at ?? b.dialed_at ?? '') || 0) - (Date.parse(a.ended_at ?? a.dialed_at ?? '') || 0),
  );
  return sorted.slice(0, limit).map((p) => {
    const at = Date.parse(p.ended_at ?? p.dialed_at ?? '');
    const sameCampaign = p.campaign_id === attempt.campaign_id;
    const code = p.disposition_code ?? p.auto_disposition_code ?? null;
    const outcome = code
      ? priorDispositionLabel(code, sameCampaign ? catalog : undefined)
      : p.outcome
        ? ATTEMPT_OUTCOME_WORDS[p.outcome] ?? p.outcome
        : 'Not finished';
    const promise = p.promise_date
      ? `${p.promise_amount ? `${rupees(p.promise_amount) ?? p.promise_amount} on ` : 'On '}${calendarDay(p.promise_date)}`
      : null;
    const note = p.notes?.trim() ? `“${p.notes.trim()}”` : null;
    return {
      key: `${p.campaign_id}:${p.attempt_number}`,
      date: Number.isFinite(at) ? dayMonth(at) : null,
      outcome: promise ? `${outcome} · ${promise}` : outcome,
      detail: note,
    };
  });
}

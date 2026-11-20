import type {
  AgencyContextDisplay,
  AgencyCustomerFacts,
  AgencyDisposition,
  AgencyFactTile,
  AgencyPriorAttempt,
  AgencyReservedAttempt,
} from '../../types/agency';
import { resolveContextFields } from '../agencyContext';
import { priorDispositionLabel } from '../agencyPriorAttempts';
import { ATTEMPT_OUTCOME_WORDS } from './stationCopy';
import { calendarDay, clockTime, dayMonth, initials, phoneForDisplay, promisedAmount, rupees } from './stationFormat';

/**
 * The customer card on Call coming, On call and What happened? (spec §3 03/04, §5.3), from the
 * reserved attempt, the campaign's `context_display` and the bootstrap's `phone_display` (AS9).
 *
 * ── Typed facts first (BE-6) ─────────────────────────────────────────────────
 * When the panel carries `attempt.facts`, the server has already said which value is the name, the
 * place and each tile, and parsed the money and dates: the card shows those and guesses nothing.
 * ₹ with Indian grouping goes only on a `money` fact the server could read, "20 Nov" only on a
 * read `date`; any other value shows exactly as uploaded. Tiles go amount due, due date, then the
 * rest (the app's order, `factTilesInOrder`). From an older server without `facts`, the card keeps
 * phase 0's reading: name and place guessed from the column names, "20 Nov" when the text plainly
 * is a date, and an amount shown as written (no ₹ on a guess).
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
   * "Call later · You said you will call at 3:00 PM" (spec 03b) from `attempt.callback` (BE-4);
   * "Call later · Booked for 3:00 PM" when someone else booked it. Null on any other call.
   */
  callLaterTag: string | null;
  /**
   * The amount the Full / Half chips read on What happened?, as a plain decimal: the typed
   * `amount_due` tile's parsed value (null when the server could not read it, which hides the
   * chips). From an older server, phase 0's guess: the first hero that reads as money.
   */
  amountDue: string | null;
  /** "Calling again · 1 of 2" on a wrap-up redial. */
  redial: { number: number; of: number } | null;
}

const NAME = /^(full[\s_-]?)?name$|customer[\s_-]?name|^customer$|contact[\s_-]?name|first[\s_-]?name|client[\s_-]?name|borrower|^naam$/i;
const PLACE = /city|town|district|village|branch|region|zone|state|place|location|area/i;
const MONEY_LABEL = /amount|balance|due(?!.*date)|outstanding|premium|emi|total|overdue|arrear/i;
const DATE_LABEL = /date|due.?on|due.?by|day/i;

/**
 * Phase 0's reading of an untyped hero column (an older server without `facts`). An amount is only
 * recognised, for the Full / Half chips, and shown exactly as uploaded: ₹ goes only on a fact the
 * server typed `money` (Manas, 2026-11-20), never on a guess. A plain date reads as "20 Nov".
 */
function factFrom(label: string, value: string, index: number): CustomerFact {
  if (MONEY_LABEL.test(label) && promisedAmount(value) !== null) {
    return { key: `hero-${index}`, label, value: value.trim(), kind: 'money' };
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

/** The typed tiles in the order the station shows them: amount due, due date, then the rest. */
export function factTilesInOrder(facts: AgencyCustomerFacts): AgencyFactTile[] {
  const name = facts.name?.trim();
  const place = facts.place?.trim();
  const shown = facts.tiles.filter((t) => {
    const raw = t.raw.trim();
    return raw !== '' && raw !== name && raw !== place;
  });
  return [
    ...shown.filter((t) => t.role === 'amount_due'),
    ...shown.filter((t) => t.role === 'due_date'),
    ...shown.filter((t) => t.role !== 'amount_due' && t.role !== 'due_date'),
  ];
}

/** A typed fact as the station writes it: `₹12,500` for read money, `20 Nov` for a read date, else as uploaded. */
export function factText(tile: AgencyFactTile): string {
  if (tile.value === null) return tile.raw;
  if (tile.type === 'money') return rupees(tile.value) ?? tile.raw;
  if (tile.type === 'date') return calendarDay(tile.value);
  return tile.raw;
}

function typedFact(tile: AgencyFactTile, index: number): CustomerFact {
  const kind: CustomerFact['kind'] = tile.value === null ? 'text' : tile.type;
  return { key: `fact-${index}`, label: tile.column, value: factText(tile), kind };
}

/** The 03b tag for a booked call-later, in the station's words. */
export function callLaterTagFor(callback: AgencyReservedAttempt['callback']): string | null {
  if (!callback) return null;
  const at = Date.parse(callback.due_at);
  if (!Number.isFinite(at)) return null;
  return callback.booked_by_me
    ? `Call later · You said you will call at ${clockTime(at)}`
    : `Call later · Booked for ${clockTime(at)}`;
}

/**
 * What the card reads off a call: the reserved attempt on an outbound call, and the same fields
 * built from an inbound caller's matched contact or a soft-phone call's roster contact (the
 * station's side views, `sideViewCustomer.ts`).
 */
export type CustomerSource = Pick<AgencyReservedAttempt, 'phone_e164' | 'context' | 'prior_attempts'>
  & Partial<Pick<AgencyReservedAttempt, 'facts' | 'callback' | 'redial'>>;

/** Name, place, hero facts and the Full / Half amount: typed facts when sent, else phase 0's guesses. */
function customerFacts(
  attempt: CustomerSource,
  display: AgencyContextDisplay | undefined,
): { name: string | null; place: string | null; heroFacts: CustomerFact[]; amountDue: string | null } {
  const facts = attempt.facts;
  if (facts) {
    const tiles = factTilesInOrder(facts);
    const due = facts.tiles.find((t) => t.role === 'amount_due' && t.type === 'money');
    return {
      name: facts.name?.trim() || null,
      place: facts.place?.trim() || null,
      heroFacts: tiles.map(typedFact),
      amountDue: due?.value ?? null,
    };
  }
  const resolved = resolveContextFields(attempt.context, display);
  // Every non-empty column, heroes first, for the name and place guesses.
  const columns = [...resolved.hero, ...resolved.fields].filter((f) => !f.isEmpty);
  const nameField = columns.find((f) => NAME.test(f.label)) ?? null;
  const placeField = columns.find((f) => PLACE.test(f.label) && f !== nameField) ?? null;
  const heroFacts = resolved.hero
    .filter((f) => !f.isEmpty && f !== nameField && f !== placeField)
    .map((f, i) => factFrom(f.label, f.value, i));
  const money = heroFacts.find((f) => f.kind === 'money');
  const rawDue = money ? resolved.hero.find((f) => f.label === money.label)?.value.trim() ?? null : null;
  return {
    name: nameField?.value.trim() || null,
    place: placeField?.value.trim() || null,
    heroFacts,
    amountDue: rawDue,
  };
}

export function customerCard(
  attempt: CustomerSource,
  display: AgencyContextDisplay | undefined,
  options: { phoneDisplay?: 'full' | 'masked' } = {},
): CustomerCard {
  const { name, place, heroFacts, amountDue } = customerFacts(attempt, display);

  const latest = latestPrior(attempt.prior_attempts);
  const latestAt = latest ? Date.parse(latest.ended_at ?? latest.dialed_at ?? '') : NaN;
  const lastCall: CustomerFact | null = Number.isFinite(latestAt)
    ? { key: 'last-call', label: 'Last call', value: dayMonth(latestAt), kind: 'last_call' }
    : null;
  const facts = lastCall ? [...heroFacts.slice(0, 2), lastCall] : heroFacts.slice(0, 3);

  const withNote = [...attempt.prior_attempts]
    .filter((p) => p.notes?.trim())
    .sort((a, b) => Date.parse(b.ended_at ?? b.dialed_at ?? '') - Date.parse(a.ended_at ?? a.dialed_at ?? ''));

  return {
    name,
    initials: initials(name),
    place,
    phone: phoneForDisplay(attempt.phone_e164, options.phoneDisplay ?? 'full'),
    facts,
    lastSaid: withNote[0]?.notes?.trim() ?? null,
    callLaterTag: callLaterTagFor(attempt.callback),
    amountDue,
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
  attempt: Pick<AgencyReservedAttempt, 'campaign_id' | 'prior_attempts'>,
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
      ? `${p.promise_amount ? `${promisedAmount(p.promise_amount) ?? p.promise_amount} on ` : 'On '}${calendarDay(p.promise_date)}`
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

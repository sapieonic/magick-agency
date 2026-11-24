import {
  customerNameColumn,
  customerNameFrom,
  customerPlaceColumn,
  customerPlaceFrom,
  customerText,
} from '@magick-agency/domain/customer-name';
import { chosenFactTiles, factTypeOf } from '@magick-agency/domain/fact-tiles';
import {
  AGENCY_FACT_FIELDS_MAX,
  type AgencyContextDisplay,
  type AgencyCustomerFacts,
  type AgencyDisposition,
  type AgencyFactTile,
  type AgencyPriorAttempt,
  type AgencyReservedAttempt,
} from '../../types/agency';
import { customerNameColumnOf, customerPlaceColumnOf, resolveContextFields } from '../agencyContext';
import { priorDispositionLabel } from '../agencyPriorAttempts';
import { ATTEMPT_OUTCOME_WORDS } from './stationCopy';
import {
  calendarDay,
  clockTime,
  dayMonth,
  factDay,
  factPhone,
  groupedNumber,
  initials,
  phoneForDisplay,
  promisedAmount,
  rupees,
} from './stationFormat';

/**
 * The customer card on Call coming, On call and What happened? (spec §3 03/04, §5.3), from the
 * reserved attempt, the campaign's `context_display` and the bootstrap's `phone_display` (AS9).
 *
 * ── The campaign's chosen facts (AS19) ───────────────────────────────────────
 * When the campaign has chosen its facts (`context_display.facts` is an array, even `[]`), the
 * card shows exactly those tiles, in the server's order with the highlighted one
 * first, up to four: each named `label ?? column`, an empty one as `—` (it keeps its place), and
 * each value written by its type ({@link factDisplay}). There is no "Last call" tile: Last calls
 * has its own card. The tiles are laid out four across ({@link chosenSpans}).
 *
 * ── Typed facts first (BE-6) ─────────────────────────────────────────────────
 * Otherwise, when the panel carries `attempt.facts`, the server has already said which value is
 * the name, the place and each tile, and parsed the money and dates: the card shows those and
 * guesses nothing. ₹ with Indian grouping goes only on a `money` fact the server could read, "20
 * Nov" only on a read `date`; any other value shows exactly as uploaded. Tiles go amount due, due
 * date, then the rest (the app's order, `factTilesInOrder`). A `phone`-typed tile is written and
 * masked by the one phone rule (S3), as on the chosen card. From an older server without `facts`
 * (and on a side view of a campaign without chosen facts), the card keeps phase 0's reading of the
 * tiles, "20 Nov" when the text plainly is a date and an amount shown as written (no ₹ on a
 * guess), with the name and place by the server's rule (the domain's `customerNameFrom` /
 * `customerPlaceFrom`, S1); each, when that rule finds none, by the card's guess from before AS19
 * (`customerNameColumnOf` and `customerPlaceColumnOf` in `../agencyContext`: `Borrower Name`,
 * `Client Name`, …; a `Branch`, `State`, `Region`, `Zone` or `Area` column), which then is not a
 * tile.
 *
 * ── A phone number never escapes `phone_display: masked` (S3) ────────────────
 * Every `phone`-typed value on the card is masked under masked: a chosen tile, a typed tile, a
 * phase 0 tile whose column `types` says is a phone, and the name or the line under it when their
 * column is one (the server refuses that since S3(e); a stored older display is the only way in).
 */
export interface CustomerFact {
  /** Stable key for React and tests. */
  key: string;
  /** The tile's name: the fact's `label`, else its column (AS19's label rule). */
  label: string;
  /** As the tile writes it: `₹1,25,000`, `20 Nov`, `98••• ••321`, `Yes`; `—` when empty. */
  value: string;
  kind: 'money' | 'date' | 'number' | 'phone' | 'yes_no' | 'text' | 'last_call';
  /**
   * The roster column: on AS19's chosen facts for the hover card's "From column: X"; on a typed
   * tile so More details leaves it out (AS20). Absent on a phase 0 tile and on Last call.
   */
  column?: string;
  /** AS19: the customer has no value for this fact; the tile stays and shows `—`. */
  empty?: boolean;
  /** AS19: the campaign's highlighted fact: first, two tiles wide, in the call's colour. */
  highlight?: boolean;
  /**
   * AS19: the tile's width in twelfths of the card's row (four tiles across are three twelfths
   * each, so a last row that is not full can be shared evenly). Absent on today's card.
   */
  span?: number;
  /** AS19: a read number, money, date or phone: it shrinks to fit before it is ever cut. */
  fit?: boolean;
}

export interface CustomerCard {
  /** The customer's name, or null when no column could be read as one. */
  name: string | null;
  initials: string;
  place: string | null;
  phone: string;
  /**
   * Today's card: up to three big number tiles, hero facts then "Last call". With the campaign's
   * chosen facts (`chosen`): exactly those, up to four, empty ones included.
   */
  facts: CustomerFact[];
  /**
   * AS19: the campaign chose its facts. The card then titles a nameless customer "Customer",
   * always shows the number under the name, and lays the tiles out four across with a hover card.
   * False: today's card, exactly (the number is the title when there is no name).
   */
  chosen: boolean;
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
  /**
   * AS20, More details: the row's other columns the server sent (`facts.more`), minus any column
   * the card already draws as a tile, each named by its column and written by its type as a chosen
   * fact is ({@link factDisplay}: a phone masked under masked). Empty when the server sent none.
   */
  more: MoreDetail[];
  /** AS20: this call's More details as a key (the attempt and the rows): a new call starts closed. */
  moreKey: string;
}

/** One row of More details (AS20). */
export interface MoreDetail {
  /** The roster column: the row's name and its React key. */
  column: string;
  /** As the row writes it: `₹1,25,000`, `20 Nov`, `98••• ••321`, `Yes`, else as uploaded. */
  value: string;
  kind: CustomerFact['kind'];
}

const MONEY_LABEL = /amount|balance|due(?!.*date)|outstanding|premium|emi|total|overdue|arrear/i;
const DATE_LABEL = /date|due.?on|due.?by|day/i;

/** What an empty fact shows (AS19): the tile stays, so each fact is always in the same place. */
export const EMPTY_FACT = '—';

type PhoneDisplay = 'full' | 'masked';

/**
 * Phase 0's reading of an untyped hero column (an older server without `facts`). An amount is only
 * recognised, for the Full / Half chips, and shown exactly as uploaded: ₹ goes only on a fact the
 * server typed `money` (Manas, 2026-11-20), never on a guess. A plain date reads as "20 Nov". A
 * column `types` says is a phone is written by the one phone rule, masked under masked (S3).
 */
function factFrom(label: string, value: string, index: number, display: AgencyContextDisplay | undefined, phoneDisplay: PhoneDisplay): CustomerFact {
  if (factTypeOf(label, display?.types) === 'phone') {
    return { key: `hero-${index}`, label, value: factPhone(value.trim(), phoneDisplay), kind: 'phone' };
  }
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

/**
 * A typed fact as today's card writes it: `₹12,500` for read money, `20 Nov` for a read date, a
 * phone by the one phone rule (masked under masked, an unread one masked on its digits), else as
 * uploaded.
 */
export function factText(tile: AgencyFactTile, phoneDisplay: PhoneDisplay = 'full'): string {
  if (tile.type === 'phone') {
    if (tile.value !== null) return factPhone(tile.value, phoneDisplay);
    return phoneDisplay === 'masked' ? factPhone(tile.raw.trim(), 'masked') : tile.raw;
  }
  if (tile.value === null) return tile.raw;
  if (tile.type === 'money') return rupees(tile.value) ?? tile.raw;
  if (tile.type === 'date') return calendarDay(tile.value);
  return tile.raw;
}

function typedFact(tile: AgencyFactTile, index: number, phoneDisplay: PhoneDisplay): CustomerFact {
  // Today's card: read money, dates and phones are formatted; every other value as uploaded.
  const kind: CustomerFact['kind'] =
    tile.value !== null && (tile.type === 'money' || tile.type === 'date' || tile.type === 'phone') ? tile.type : 'text';
  return { key: `fact-${index}`, label: tile.column, value: factText(tile, phoneDisplay), kind, column: tile.column };
}

// ── AS19: the campaign's chosen facts ────────────────────────────────────────

/** How a chosen fact is shown: its text, whether it is empty, and whether it shrinks to fit. */
export interface FactShown {
  text: string;
  kind: CustomerFact['kind'];
  empty: boolean;
  fit: boolean;
}

/**
 * A chosen fact's value as the tile, the hover card and the script write it (AS19, spec §6):
 * money `₹1,25,000` (paise only when not zero), number `1,25,000`, date `20 Nov` (`20 Nov 2027`
 * when not this year), phone as the customer's own number is shown and masked under
 * `phone_display: masked`, yes / no `Yes` / `No`. A value the server could not read shows as
 * uploaded (a phone under masked never shows its digits: it is masked as written); an empty one is
 * `—`. Text is as uploaded, trimmed.
 */
export function factDisplay(
  tile: AgencyFactTile,
  options: { phoneDisplay?: 'full' | 'masked'; now?: Date | number } = {},
): FactShown {
  const raw = tile.raw.trim();
  if (raw === '') return { text: EMPTY_FACT, kind: 'text', empty: true, fit: false };
  const phoneDisplay = options.phoneDisplay ?? 'full';
  if (tile.value === null) {
    if (tile.type === 'phone' && phoneDisplay === 'masked') return { text: factPhone(raw, 'masked'), kind: 'text', empty: false, fit: false };
    return { text: raw, kind: 'text', empty: false, fit: false };
  }
  switch (tile.type) {
    case 'money': {
      const text = rupees(tile.value);
      return text ? { text, kind: 'money', empty: false, fit: true } : { text: raw, kind: 'text', empty: false, fit: false };
    }
    case 'number': {
      const text = groupedNumber(tile.value);
      return text ? { text, kind: 'number', empty: false, fit: true } : { text: raw, kind: 'text', empty: false, fit: false };
    }
    case 'date':
      return { text: factDay(tile.value, options.now), kind: 'date', empty: false, fit: true };
    case 'phone':
      return { text: factPhone(tile.value, phoneDisplay), kind: 'phone', empty: false, fit: true };
    case 'yes_no':
      return tile.value === 'yes' || tile.value === 'no'
        ? { text: tile.value === 'yes' ? 'Yes' : 'No', kind: 'yes_no', empty: false, fit: false }
        : { text: raw, kind: 'text', empty: false, fit: false };
    default:
      return { text: raw, kind: 'text', empty: false, fit: false };
  }
}

/** A tile's name (AS19): its `label`, else its column. */
export function tileName(tile: Pick<AgencyFactTile, 'label' | 'column'>): string {
  const label = tile.label?.trim();
  return label ? label : tile.column;
}

/**
 * True when the campaign chose its facts (AS19, R8): its `context_display.facts` is an array, even
 * `[]` (no tiles then, never today's card). The display decides alone, on both clients: tiles that
 * carry a `label` or `key` under a display without `facts` still get today's card.
 */
export function factsChosen(display: AgencyContextDisplay | undefined): boolean {
  return Array.isArray(display?.facts);
}

/**
 * The chosen tiles in the order the card draws them: the server's order, with the first
 * highlighted tile moved first (a second highlight is ignored), at most four. The domain's
 * `chosenFactTiles` already builds them so; this keeps the card's layout sound whatever a panel
 * carries.
 */
export function chosenTilesInOrder(tiles: readonly AgencyFactTile[]): AgencyFactTile[] {
  const lead = tiles.findIndex((t) => t.highlight === true);
  const ordered = lead > 0 ? [tiles[lead]!, ...tiles.slice(0, lead), ...tiles.slice(lead + 1)] : [...tiles];
  return ordered
    .slice(0, AGENCY_FACT_FIELDS_MAX)
    .map((t, i) => (t.highlight && i !== 0 ? { ...t, highlight: false } : t));
}

/** The smallest a number, amount, date or phone shrinks to, as a share of its size, before it is cut. */
export const FIT_MIN_SCALE = 0.65;

/**
 * The font size (px, to the half pixel) that fits a value of `scrollWidth` into `clientWidth` at
 * `base` px, never under {@link FIT_MIN_SCALE} of it (the ellipsis takes over from there); null
 * when it already fits or cannot be measured. One measurement per value and width: text width
 * scales with the font size, so one step is enough.
 */
export function fitFontSize(base: number, clientWidth: number, scrollWidth: number): number | null {
  if (!(base > 0) || !(clientWidth > 0) || scrollWidth <= clientWidth + 1) return null;
  const floor = Math.ceil(base * FIT_MIN_SCALE * 2) / 2;
  return Math.max(floor, Math.floor(base * (clientWidth / scrollWidth) * 0.98 * 2) / 2);
}

/** The gap between a tile and its hover card, and the widest the card grows (`Station.module.css` `.factPop`). */
const FACT_POP_GAP = 8;
const FACT_POP_MAX_WIDTH = 300;
export const FACT_POP_MIN_WIDTH = 180;

/**
 * Where a tile's hover card sits (S11): under the tile, its left edge on the tile's, shifted left
 * as far as it must to end inside the card's column (the facts' row), never past its start; no
 * wider than that column. Above the tile instead when it would leave the window at the bottom and
 * there is room above. Px offsets from the tile; null when the column cannot be measured.
 */
export function factPopPlacement(
  tile: { left: number; top: number; bottom: number },
  column: { left: number; right: number },
  pop: { width: number; height: number },
  windowHeight: number,
): { shift: number; maxWidth: number; above: boolean } | null {
  const room = column.right - column.left;
  if (!(room > 0)) return null;
  const width = Math.min(pop.width, room);
  let shift = 0;
  if (tile.left + width > column.right) shift = column.right - width - tile.left;
  if (tile.left + shift < column.left) shift = column.left - tile.left;
  const above = tile.bottom + FACT_POP_GAP + pop.height > windowHeight && tile.top - FACT_POP_GAP - pop.height >= 0;
  return { shift: Math.round(shift), maxWidth: Math.min(FACT_POP_MAX_WIDTH, Math.floor(room)), above };
}

/** Tracks in the chosen facts' row: four tiles across, three tracks each. */
export const CHOSEN_GRID_TRACKS = 12;

/**
 * Each chosen tile's width in twelfths (AS19, spec §6): a grid of four equal columns where the
 * highlighted tile (always first) takes two; rows fill in order, and a last row that is not full
 * is shared by its tiles in proportion (one tile: the whole row; two: half each; three: a third
 * each; the highlight and one: two thirds and a third).
 */
export function chosenSpans(highlights: readonly boolean[]): number[] {
  const units = highlights.map((h) => (h ? 2 : 1));
  const rows: number[][] = [];
  let row: number[] = [];
  let used = 0;
  units.forEach((u, i) => {
    if (used + u > 4) {
      rows.push(row);
      row = [];
      used = 0;
    }
    row.push(i);
    used += u;
  });
  if (row.length > 0) rows.push(row);
  const spans = units.map((u) => u * 3);
  const last = rows[rows.length - 1];
  if (last) {
    const total = last.reduce((sum, i) => sum + units[i]!, 0);
    if (total < 4) for (const i of last) spans[i] = (CHOSEN_GRID_TRACKS * units[i]!) / total;
  }
  return spans;
}

/** The chosen tiles as the card's facts. */
function chosenFacts(
  tiles: readonly AgencyFactTile[],
  options: { phoneDisplay?: 'full' | 'masked'; now?: Date | number },
): CustomerFact[] {
  const ordered = chosenTilesInOrder(tiles);
  const spans = chosenSpans(ordered.map((t) => t.highlight === true));
  return ordered.map((tile, i) => {
    const shown = factDisplay(tile, options);
    return {
      key: `fact-${tile.key ?? i}`,
      label: tileName(tile),
      value: shown.text,
      kind: shown.kind,
      column: tile.column,
      empty: shown.empty,
      highlight: tile.highlight === true,
      span: spans[i]!,
      fit: shown.fit,
    };
  });
}

/**
 * A side view's facts (an inbound caller's matched contact, a soft-phone call's roster contact),
 * which carry no typed facts, built from the contact's row by the server's own rule when the
 * work's `context_display` has `facts`: the tiles by the domain's `chosenFactTiles` (S6), the
 * name and the line under it by `customerNameFrom` / `customerPlaceFrom` (S1). Null when the
 * display has no `facts` (today's reading applies).
 */
export function chosenFactsFromContext(
  context: Record<string, unknown>,
  display: AgencyContextDisplay | undefined,
  now?: Date | number,
): AgencyCustomerFacts | null {
  if (!display || !Array.isArray(display.facts)) return null;
  const name = customerNameFrom(context, display);
  const place = customerPlaceFrom(context, display);
  const tiles = chosenFactTiles(context, display, now === undefined ? undefined : new Date(now));
  return { ...(name !== undefined ? { name } : {}), ...(place !== undefined ? { place } : {}), tiles };
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
  & Partial<Pick<AgencyReservedAttempt, 'attempt_id' | 'facts' | 'callback' | 'redial'>>;

/**
 * The name or the line under it as the card shows it: from a column `types` says is a phone, it
 * is masked under masked by the one phone rule (S3); anything else as read.
 */
function personText(
  text: string | null,
  column: string | undefined,
  display: AgencyContextDisplay | undefined,
  phoneDisplay: PhoneDisplay,
): string | null {
  if (text === null || column === undefined || phoneDisplay !== 'masked') return text;
  return factTypeOf(column, display?.types) === 'phone' ? factPhone(text, 'masked') : text;
}

/** Name, place, hero facts and the Full / Half amount: typed facts when sent, else phase 0's reading. */
function customerFacts(
  attempt: CustomerSource,
  display: AgencyContextDisplay | undefined,
  options: { phoneDisplay?: PhoneDisplay; now?: Date | number },
): { name: string | null; place: string | null; heroFacts: CustomerFact[]; amountDue: string | null; chosen: boolean } {
  const phoneDisplay = options.phoneDisplay ?? 'full';
  const facts = attempt.facts ?? chosenFactsFromContext(attempt.context, display, options.now) ?? undefined;
  const nameColumn = customerNameColumn(attempt.context, display);
  const placeColumn = customerPlaceColumn(attempt.context, display);
  const person = (
    name: string | null | undefined,
    place: string | null | undefined,
    nameAt = nameColumn,
    placeAt = placeColumn,
  ) => ({
    name: personText(name?.trim() || null, nameAt, display, phoneDisplay),
    place: personText(place?.trim() || null, placeAt, display, phoneDisplay),
  });
  if (facts && factsChosen(display)) {
    const due = facts.tiles.find((t) => t.role === 'amount_due' && t.type === 'money');
    return { ...person(facts.name, facts.place), heroFacts: chosenFacts(facts.tiles, options), amountDue: due?.value ?? null, chosen: true };
  }
  if (facts) {
    const tiles = factTilesInOrder(facts);
    const due = facts.tiles.find((t) => t.role === 'amount_due' && t.type === 'money');
    return {
      ...person(facts.name, facts.place),
      heroFacts: tiles.map((t, i) => typedFact(t, i, phoneDisplay)),
      amountDue: due?.value ?? null,
      chosen: false,
    };
  }
  // Phase 0 (an older server, or a side view of a campaign without chosen facts): the name and
  // place by the server's rule (each, when the rule finds none, by the card's guess from before
  // AS19: `customerNameColumnOf`, `customerPlaceColumnOf`), the other heroes read from their
  // column names. A column shown as the name or the place is never also a tile.
  const legacyNameColumn = customerNameColumnOf(attempt.context, display);
  const legacyPlaceColumn = customerPlaceColumnOf(attempt.context, display, legacyNameColumn);
  const resolved = resolveContextFields(attempt.context, display);
  const heroFacts = resolved.hero
    .filter((f) => !f.isEmpty && f.label !== legacyNameColumn && f.label !== legacyPlaceColumn)
    .map((f, i) => factFrom(f.label, f.value, i, display, phoneDisplay));
  const money = heroFacts.find((f) => f.kind === 'money');
  const rawDue = money ? resolved.hero.find((f) => f.label === money.label)?.value.trim() ?? null : null;
  return {
    ...person(
      legacyNameColumn === undefined ? undefined : customerText(attempt.context[legacyNameColumn]),
      legacyPlaceColumn === undefined ? undefined : customerText(attempt.context[legacyPlaceColumn]),
      legacyNameColumn,
      legacyPlaceColumn,
    ),
    heroFacts,
    amountDue: rawDue,
    chosen: false,
  };
}

/** How many More details rows one downward scroll opens (AS20). */
export const MORE_DETAILS_STEP = 4;

/** The shortest time between two of those steps, so one flick of the wheel opens one step. */
export const MORE_DETAILS_PAUSE_MS = 300;

/** How many rows are open after one more step: {@link MORE_DETAILS_STEP} more, never past `total`. */
export function nextMoreShown(shown: number, total: number): number {
  return Math.max(0, Math.min(total, shown + MORE_DETAILS_STEP));
}

/** One call's More details as a key: another call, or other values, starts closed. */
export function moreDetailsKey(callId: string, rows: readonly MoreDetail[]): string {
  return `${callId}\u0002${rows.map((r) => `${r.column}\u0000${r.value}`).join('\u0001')}`;
}

/**
 * More details (AS20): the server's `facts.more` in its order, minus the columns in `drawn` (the
 * tiles the card shows, matched ignoring case), each written by {@link factDisplay}. A row whose
 * value is empty after trimming is left out.
 */
export function moreDetails(
  more: readonly AgencyFactTile[] | undefined,
  drawn: Iterable<string>,
  options: { phoneDisplay?: PhoneDisplay; now?: Date | number } = {},
): MoreDetail[] {
  if (!Array.isArray(more)) return [];
  const skip = new Set([...drawn].map((c) => c.trim().toLowerCase()));
  const out: MoreDetail[] = [];
  for (const tile of more) {
    if (typeof tile?.column !== 'string' || skip.has(tile.column.trim().toLowerCase())) continue;
    const shown = factDisplay({ ...tile, raw: typeof tile.raw === 'string' ? tile.raw : '' }, options);
    if (shown.empty) continue;
    skip.add(tile.column.trim().toLowerCase());
    out.push({ column: tile.column, value: shown.text, kind: shown.kind });
  }
  return out;
}

export function customerCard(
  attempt: CustomerSource,
  display: AgencyContextDisplay | undefined,
  options: { phoneDisplay?: 'full' | 'masked'; now?: Date | number } = {},
): CustomerCard {
  const { name, place, heroFacts, amountDue, chosen } = customerFacts(attempt, display, options);

  const latest = latestPrior(attempt.prior_attempts);
  const latestAt = latest ? Date.parse(latest.ended_at ?? latest.dialed_at ?? '') : NaN;
  const lastCall: CustomerFact | null = Number.isFinite(latestAt)
    ? { key: 'last-call', label: 'Last call', value: dayMonth(latestAt), kind: 'last_call' }
    : null;
  // AS19: the chosen facts are the tiles, all of them; Last calls has its own card.
  const facts = chosen ? heroFacts : lastCall ? [...heroFacts.slice(0, 2), lastCall] : heroFacts.slice(0, 3);

  const more = moreDetails(attempt.facts?.more, facts.flatMap((f) => (f.column ? [f.column] : [])), options);

  const withNote = [...attempt.prior_attempts]
    .filter((p) => p.notes?.trim())
    .sort((a, b) => Date.parse(b.ended_at ?? b.dialed_at ?? '') - Date.parse(a.ended_at ?? a.dialed_at ?? ''));

  return {
    name,
    initials: initials(name),
    place,
    phone: phoneForDisplay(attempt.phone_e164, options.phoneDisplay ?? 'full'),
    facts,
    chosen,
    lastSaid: withNote[0]?.notes?.trim() ?? null,
    callLaterTag: callLaterTagFor(attempt.callback),
    amountDue,
    redial: attempt.redial ? { number: attempt.redial.number, of: attempt.redial.number + attempt.redial.remaining } : null,
    more,
    moreKey: moreDetailsKey(attempt.attempt_id ?? '', more),
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

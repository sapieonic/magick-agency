/**
 * More details (agent station AS20): the row's other columns, which the agent opens under the
 * customer card. The ONE rule, from a roster row and the campaign's `context_display`. The server
 * sends its answer on the panel (`AgencyCustomerFacts.more`, `customerFacts` in
 * `apps/server/src/agency/customer-facts.ts`) and both clients draw what it sent; the console's
 * Settings reads it to show the supervisor what agents will see. Its cases are
 * `packages/contracts/fixtures/agent/fact-rules.json`'s `more_detail_tiles`. A LEAF: it imports only
 * the contract and the other leaves.
 *
 * {@link moreDetailTiles}: one tile per column of the row with a value (not blank, not a
 * placeholder such as `-` or `N/A`), each column once, leaving out
 *  - a `hidden` column (hidden from agents everywhere) and a `more_hidden` one (from More details
 *    only), both matched ignoring case;
 *  - the columns the card already shows as the customer's name and the line under it (the
 *    domain's `customerNameColumn` / `customerPlaceColumn`, the panel's own reading);
 *  - with chosen facts (`facts` an array), every fact's column, matched ignoring case. On a
 *    legacy card the client leaves out the columns it drew as tiles itself (it draws fewer than
 *    the server sends, and what it draws is its own rule).
 * In `context_display.order` (each entry the row's own spelling, else ignoring case), then
 * `columnOrder` when the caller knows the import's order, then the row's own key order; at most
 * `AGENCY_MORE_DETAILS_MAX`. A tile is `{ column, type, raw, value }`: `raw` the value as text,
 * trimmed; `type` the column's declared type (`types`, exact else ignoring case, one of the six),
 * else text; `value` the domain's parse.
 *
 * A column `types` does not name (with one of the six types) whose value holds a phone number
 * ({@link looksLikePhoneNumber}) is typed `phone`, so a campaign that hides numbers
 * (`phone_display: masked`) masks it as it masks the customer's own: an "Alternate mobile" uploaded
 * as plain text cannot show in full by mistake. It is read per value, as the server sees one row at
 * a time: Settings reads every sample row and says so. A supervisor who means it as something else
 * gives it a type in Settings (Text or Number, say). On a card that has not chosen its facts, the
 * `amount_due` and `due_date` role columns are money and a date, as on the card.
 */
import {
  AGENCY_CONTEXT_FIELD_TYPES,
  AGENCY_MORE_DETAILS_MAX,
  type AgencyContextFieldType,
  type AgencyFactTile,
} from '@magick-agency/contracts/agency';
import { asRecord, contextValueText, declaredColumnType, fold, hiddenSet, isBlankContextValue, rowKey } from './context-columns';
import { parseContextFact } from './context-facts';
import { customerNameColumn, customerPlaceColumn, factColumnsOf } from './customer-name';
import { indianMobileDigits } from './fact-phone';

/** The fewest digits a number written with `+` (or `00`) has before it reads as a phone number. */
const MORE_PHONE_MIN_INTERNATIONAL_DIGITS = 8;

/** The most digits a phone number has (E.164). */
const MORE_PHONE_MAX_DIGITS = 15;

/**
 * The most letters a value holding a phone number may have besides it (`Mob:`, `(home)`, `or`):
 * a longer text is a remark, read as text, since masking it would leave the agent only digits.
 */
const MORE_PHONE_MAX_LETTERS = 12;

/** The most digit groups of one run that are tried together: far above a written phone number's. */
const MORE_PHONE_MAX_GROUPS = 12;

/**
 * True when a text value holds a phone number, read loosely, since a roster's cells are written
 * every which way (`9876543210.0` from a spreadsheet, `Mob: 98765 43210`, two numbers in one cell,
 * `022 2345 6789`): the value is read as Unicode's compatibility form (full-width digits) without
 * zero-width characters; each run of digits joined by spaces, dashes, dots and brackets is split
 * into its digit groups (so `9876543210.0` is `9876543210` and `0`), and the value holds a phone
 * number when some consecutive groups together are
 *  - an Indian mobile (ten digits starting 6 to 9, with an optional `91`, `0` or `091` before them),
 *  - an Indian landline with its STD code (`0` and ten digits), or
 *  - written with a leading `+` or `00`, with {@link MORE_PHONE_MIN_INTERNATIONAL_DIGITS} to 15
 *    digits after it.
 * A number that is none of these (`1234 5678 9012`, `24`, `LN-0042`, `20/11/2026`) is not, and
 * neither is a value with more than {@link MORE_PHONE_MAX_LETTERS} letters (a remark that mentions
 * a number stays readable). Otherwise, when in doubt it reads as a phone: a client masks a value it
 * cannot parse on its digits, so a wrong guess hides digits, never shows them.
 */
export function looksLikePhoneNumber(raw: string): boolean {
  const text = String(raw)
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '');
  if ((text.match(/\p{L}/gu) ?? []).length > MORE_PHONE_MAX_LETTERS) return false;
  for (const run of text.match(/\+?\d[\d\s().-]*\d/g) ?? []) {
    const groups = run.split(/[\s().-]+/).filter((g) => g !== '').slice(0, MORE_PHONE_MAX_GROUPS);
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j <= groups.length; j++) {
        if (isPhoneDigits(groups.slice(i, j).join(''))) return true;
      }
    }
  }
  return false;
}

/** One candidate of {@link looksLikePhoneNumber}: digits, with a `+` first when written. */
function isPhoneDigits(candidate: string): boolean {
  const plus = candidate.startsWith('+');
  const digits = candidate.replace(/\D/g, '');
  if (digits.length > MORE_PHONE_MAX_DIGITS + 2) return false;
  const international = plus ? digits : digits.startsWith('00') ? digits.slice(2) : null;
  if (international !== null && international.length >= MORE_PHONE_MIN_INTERNATIONAL_DIGITS && international.length <= MORE_PHONE_MAX_DIGITS) {
    return true;
  }
  if (indianMobileDigits(digits) !== null) return true;
  if (digits.length === 13 && digits.startsWith('091') && indianMobileDigits(digits.slice(1)) !== null) return true;
  return digits.length === 11 && digits.startsWith('0') && digits[1] !== '0';
}

/** The display configuration {@link moreDetailTiles} reads (`AgencyContextDisplay`, possibly hand-edited JSON). */
export interface MoreDetailsDisplay {
  hidden?: unknown;
  more_hidden?: unknown;
  order?: unknown;
  roles?: unknown;
  types?: unknown;
  facts?: unknown;
}

/**
 * The type a More details tile is read as: the declared one (one of the six; anything else stored
 * is not a declaration), else phone when the value holds a phone number, else text.
 */
export function moreDetailTypeOf(column: string, raw: string, types: unknown): AgencyContextFieldType {
  const declared = declaredColumnType(column, types);
  if ((AGENCY_CONTEXT_FIELD_TYPES as readonly unknown[]).includes(declared)) return declared as AgencyContextFieldType;
  return looksLikePhoneNumber(raw) ? 'phone' : 'text';
}

/**
 * More details for a row: see the module header.
 *
 * @param context     the contact's roster row (`agency_contacts.context`)
 * @param display     the campaign's `context_display`
 * @param columnOrder the import's column order, when the caller knows it
 * @param now         the clock a two-digit year is read against
 */
export function moreDetailTiles(
  context: Record<string, unknown> | null | undefined,
  display: MoreDetailsDisplay | null | undefined,
  columnOrder: readonly string[] | null = null,
  now: Date = new Date(),
): AgencyFactTile[] {
  const row = asRecord(context) ?? {};
  const shown = asRecord(display) ? display! : {};
  const hidden = hiddenSet(shown);
  for (const column of hiddenSet({ hidden: shown.more_hidden })) hidden.add(column);
  const skip = new Set<string>();
  const nameKey = customerNameColumn(row, shown);
  const placeKey = customerPlaceColumn(row, shown);
  if (nameKey !== undefined) skip.add(fold(nameKey));
  if (placeKey !== undefined) skip.add(fold(placeKey));
  if (Array.isArray(shown.facts)) for (const column of factColumnsOf(shown)) skip.add(fold(column));
  // On a card that has not chosen its facts (BE-6), the amount-due and due-date role columns are
  // read as money and a date whatever `types` says, as the card's own tiles read them.
  const roles = Array.isArray(shown.facts) ? null : asRecord(shown.roles);
  const roleType = (column: string): AgencyContextFieldType | undefined => {
    if (typeof roles?.['amount_due'] === 'string' && fold(roles['amount_due']) === fold(column)) return 'money';
    if (typeof roles?.['due_date'] === 'string' && fold(roles['due_date']) === fold(column)) return 'date';
    return undefined;
  };

  const ordered: string[] = [];
  const take = (name: unknown): void => {
    const key = rowKey(row, name, hidden);
    if (key !== undefined && !ordered.includes(key)) ordered.push(key);
  };
  if (Array.isArray(shown.order)) for (const name of shown.order) take(name);
  for (const name of columnOrder ?? []) take(name);
  for (const name of Object.keys(row)) take(name);

  const tiles: AgencyFactTile[] = [];
  for (const column of ordered) {
    if (tiles.length >= AGENCY_MORE_DETAILS_MAX) break;
    if (skip.has(fold(column)) || isBlankContextValue(row[column])) continue;
    const raw = (contextValueText(row[column]) ?? '').trim();
    const type = roleType(column) ?? moreDetailTypeOf(column, raw, shown.types);
    tiles.push({ column, type, raw, value: parseContextFact(raw, type, now) });
  }
  return tiles;
}

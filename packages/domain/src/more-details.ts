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
 * A column `types` does not name whose value {@link looksLikePhoneNumber} is typed `phone`, so a
 * campaign that hides numbers (`phone_display: masked`) masks it as it masks the customer's own:
 * an "Alternate mobile" uploaded as plain text cannot show in full by mistake. A supervisor who
 * means it as something else gives it a type in Settings (Number, say).
 */
import { AGENCY_MORE_DETAILS_MAX, type AgencyContextFieldType, type AgencyFactTile } from '@magick-agency/contracts/agency';
import { asRecord, contextValueText, declaredColumnType, fold, hiddenSet, isBlankContextValue, rowKey } from './context-columns';
import { parseContextFact, parsePhoneFact } from './context-facts';
import { customerNameColumn, customerPlaceColumn, factColumnsOf } from './customer-name';
import { indianMobileDigits } from './fact-phone';
import { factTypeOf } from './fact-tiles';

/** The fewest digits a number written with `+` has before it reads as a phone number. */
export const MORE_PHONE_MIN_INTERNATIONAL_DIGITS = 8;

/**
 * True when a text value reads as a phone number: the domain's phone parse accepts it and it is an
 * Indian mobile (ten digits starting 6 to 9, with an optional `91` or `0` before them), or it is
 * written with a leading `+` and has at least {@link MORE_PHONE_MIN_INTERNATIONAL_DIGITS} digits.
 * A bare number that is not a mobile (`1234 5678 9012`, `24`) is not.
 */
export function looksLikePhoneNumber(raw: string): boolean {
  const parsed = parsePhoneFact(raw);
  if (parsed === null) return false;
  const digits = parsed.replace(/\D/g, '');
  if (indianMobileDigits(digits) !== null) return true;
  return parsed.startsWith('+') && digits.length >= MORE_PHONE_MIN_INTERNATIONAL_DIGITS;
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

/** The type a More details tile is read as: the declared one, else phone when it reads as one, else text. */
export function moreDetailTypeOf(column: string, raw: string, types: unknown): AgencyContextFieldType {
  const type = factTypeOf(column, types);
  if (type !== 'text' || declaredColumnType(column, types) !== undefined) return type;
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
    const type = moreDetailTypeOf(column, raw, shown.types);
    tiles.push({ column, type, raw, value: parseContextFact(raw, type, now) });
  }
  return tiles;
}

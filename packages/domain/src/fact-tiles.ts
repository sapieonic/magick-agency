/**
 * The card's tiles for a campaign that chose its facts (AS19 S6): the ONE builder, from a roster
 * row and the campaign's `context_display`. The server sends them on the panel
 * (`customerFacts`, `apps/server/src/agency/customer-facts.ts`); the console builds the side
 * views' cards with it (inbound, soft phone); the agent app's Dart port (`agency_wire`) is held to
 * the same cases (`packages/contracts/fixtures/agent/fact-rules.json`, `chosen_fact_tiles`). A
 * LEAF: it imports only the contract, `./context-columns` and `./context-facts`.
 *
 * {@link chosenFactTiles}: when `facts` is an array (even `[]`), one tile per fact whose column the
 * row has (its exact spelling, else ignoring case) and is not hidden, in the list's order, each
 * column once. Read leniently (the list may be hand-edited JSON): an entry that is not an object
 * or has no column is skipped; the label is trimmed and left off when blank or not text; the key
 * is left off when empty or not text. The type is `types[column]` (exact, else ignoring case)
 * when it is one of the six, else text; no role overrides it on this path. `raw` is the value as
 * text (`''` when blank: the tile is still sent, clients show "—"); `value` is the domain's parse
 * (`parseContextFact`). The tile keyed `amount_due` (or `due_date`) carries that role, one tile
 * per role. Only the first highlighted fact keeps `highlight`, and its tile moves first; then at
 * most `AGENCY_FACT_FIELDS_MAX` tiles.
 */
import {
  AGENCY_CONTEXT_FIELD_TYPES,
  AGENCY_FACT_FIELDS_MAX,
  AGENCY_FACT_TILE_ROLES,
  type AgencyContextFieldType,
  type AgencyFactTile,
  type AgencyFactTileRole,
} from '@magick-agency/contracts/agency';
import { asRecord, contextValueText, declaredColumnType, hiddenSet, rowKey } from './context-columns';
import { parseContextFact } from './context-facts';

/** The tile roles (the contract's list, in the order the legacy card appends them) and the type each reads its column as. */
export const FACT_TILE_ROLE_TYPE: Readonly<Record<AgencyFactTileRole, AgencyContextFieldType>> = {
  amount_due: 'money',
  due_date: 'date',
};

/** The tile roles in the order the legacy card appends them: the contract's list. */
export const FACT_TILE_ROLES: readonly AgencyFactTileRole[] = AGENCY_FACT_TILE_ROLES;

/** The tile role a fact's key gives it: the key `amount_due` or `due_date`, else none. */
export function factTileRoleOfKey(key: unknown): AgencyFactTileRole | undefined {
  return typeof key === 'string' && (FACT_TILE_ROLES as readonly string[]).includes(key) ? (key as AgencyFactTileRole) : undefined;
}

/**
 * The type `types` declares for a column (its exact spelling, else the first entry equal to it
 * ignoring case), when it is one of `AGENCY_CONTEXT_FIELD_TYPES`; else text.
 */
export function factTypeOf(column: string, types: unknown): AgencyContextFieldType {
  const declared = declaredColumnType(column, types);
  return (AGENCY_CONTEXT_FIELD_TYPES as readonly unknown[]).includes(declared) ? (declared as AgencyContextFieldType) : 'text';
}

/** The display configuration {@link chosenFactTiles} reads (`AgencyContextDisplay`, possibly hand-edited JSON). */
export interface ChosenFactsDisplay {
  hidden?: unknown;
  types?: unknown;
  facts?: unknown;
}

/**
 * The tiles of a campaign with `context_display.facts` (AS19): see the module header. `[]` when
 * `facts` is not an array (the campaign keeps the legacy card, built elsewhere).
 *
 * @param context the contact's roster row (`agency_contacts.context`)
 * @param display the campaign's `context_display`
 * @param now     the clock a two-digit year is read against (`parseDateFact`)
 */
export function chosenFactTiles(
  context: Record<string, unknown> | null | undefined,
  display: ChosenFactsDisplay | null | undefined,
  now: Date = new Date(),
): AgencyFactTile[] {
  const facts = display?.facts;
  if (!Array.isArray(facts)) return [];
  const row = asRecord(context) ?? {};
  const hidden = hiddenSet(display);
  const tiles: AgencyFactTile[] = [];
  for (const entry of facts) {
    const fact = asRecord(entry);
    if (!fact) continue;
    const column = rowKey(row, fact['column'], hidden);
    if (column === undefined || tiles.some((t) => t.column === column)) continue;
    const rawLabel = fact['label'];
    const label = typeof rawLabel === 'string' && rawLabel.trim().length > 0 ? rawLabel.trim() : undefined;
    const rawKey = fact['key'];
    const key = typeof rawKey === 'string' && rawKey.length > 0 ? rawKey : undefined;
    // One tile per role (a repeated key is refused at the write).
    const keyRole = factTileRoleOfKey(key);
    const role = keyRole !== undefined && tiles.some((t) => t.role === keyRole) ? undefined : keyRole;
    const type = factTypeOf(column, display?.types);
    const raw = contextValueText(row[column]) ?? '';
    tiles.push({
      column,
      ...(label !== undefined ? { label } : {}),
      ...(key !== undefined ? { key } : {}),
      ...(fact['highlight'] === true ? { highlight: true } : {}),
      ...(role ? { role } : {}),
      type,
      raw,
      value: parseContextFact(raw, type, now),
    });
  }
  const first = tiles.findIndex((t) => t.highlight === true);
  for (let i = first + 1; first >= 0 && i < tiles.length; i++) delete tiles[i]!.highlight;
  if (first > 0) tiles.unshift(...tiles.splice(first, 1));
  return tiles.slice(0, AGENCY_FACT_FIELDS_MAX);
}

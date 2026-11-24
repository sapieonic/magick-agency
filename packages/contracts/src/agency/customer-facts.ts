/**
 * Typed customer facts (agent station redesign, BE-6). A campaign's roster stays schemaless
 * (`AgencyReservedAttempt.context` is every non-phone CSV column, as uploaded); the campaign says,
 * by a setting, which column plays which ROLE and how to READ a column, and the server parses the
 * values once and sends them beside the raw text, so the console (TypeScript) and the app (Dart)
 * never each write a money or date parser.
 *
 *  - The setting rides in the existing `context_display` JSONB (`AgencyContextDisplay.roles` and
 *    `.types`, `./session.ts`): no migration.
 *  - The answer rides on the panel (`AgencyReservedAttempt.facts`, `./station.ts`), built at dial
 *    time with the rest of the panel.
 *
 * ── The card's facts (AS19) ──────────────────────────────────────────────────
 * A supervisor chooses up to {@link AGENCY_FACT_FIELDS_MAX} facts for the card, in order, each a
 * roster column with its own short name (`label`), a script key (`key`, `{key}` in the script) and
 * an optional highlight: `AgencyContextDisplay.facts` ({@link AgencyFactField}). A campaign that
 * carries `facts` (even `[]`) uses that list for its tiles; one that does not keeps the BE-6 rule
 * (`hero` plus the `amount_due` / `due_date` roles). The name and the line under it stay the
 * `name` and `place` roles on both paths.
 *
 * ── The parse rule (the server's, `packages/domain/src/context-facts.ts`) ────
 * Money: strip the rupee sign, spaces and grouping commas (Indian `1,25,000` and western
 * `125,000`), answer a decimal string (`"125000"`, `"12500.50"`). Number (AS19): the same without
 * the rupee sign. Date: ISO first, then day-first forms (`20/11/2026`, `20-11-26`, `20 Nov 2026`),
 * answer `YYYY-MM-DD`; never month-first. Phone (AS19): digits with an optional leading `+`,
 * spaces, dashes and brackets ignored, 6 to 15 digits, answer the digits (`+` kept). Yes / no
 * (AS19): `yes`, `y`, `true`, `1`, `haan`, `ha` and `no`, `n`, `false`, `0`, `nahi`, `nahin`, any
 * case, answer `yes` or `no`. A value it cannot read is `null`, and the client shows `raw`. When
 * in doubt: null. A wrong amount shown to a collections agent is worse than the raw text.
 *
 * Formatting (`₹1,25,000`, `20 Nov`) is the client's: it is locale and theme work. There is no
 * currency setting (decision LF2 is open); a client shows the tenant's default sign.
 *
 * Part of the dialer contract; `../agency.ts` is the barrel and carries the contract's header.
 */

import type { AllListed } from '../primitives';

/** The roles a roster column can play on the station. */
export type AgencyContextRole = 'name' | 'place' | 'amount_due' | 'due_date';

export const AGENCY_CONTEXT_ROLES = ['name', 'place', 'amount_due', 'due_date'] as const satisfies readonly AgencyContextRole[];

const _allRolesListed: AllListed<AgencyContextRole, typeof AGENCY_CONTEXT_ROLES> = true;
void _allRolesListed;

/**
 * How a roster column's values are read. Absent from `AgencyContextDisplay.types`: `text`.
 * `number`, `phone` and `yes_no` are AS19's; a client that does not know a type shows the column
 * as text.
 */
export type AgencyContextFieldType = 'text' | 'money' | 'date' | 'number' | 'phone' | 'yes_no';

export const AGENCY_CONTEXT_FIELD_TYPES = [
  'text',
  'money',
  'date',
  'number',
  'phone',
  'yes_no',
] as const satisfies readonly AgencyContextFieldType[];

const _allFieldTypesListed: AllListed<AgencyContextFieldType, typeof AGENCY_CONTEXT_FIELD_TYPES> = true;
void _allFieldTypesListed;

/**
 * Which column plays each role (`AgencyContextDisplay.roles`): column names exactly as in the
 * roster's header. Every key optional; one column per role. The campaign-config write refuses a
 * role naming a column the roster does not have (with the roster's columns, when it knows them),
 * and a column that is `hidden` (`hidden` wins over everything: a hidden column is never a role).
 * `amount_due` is read as `money` and `due_date` as `date` whatever `types` says.
 *
 * With `AgencyContextDisplay.facts` (AS19) only `name` and `place` are read: the tiles are the
 * chosen facts, typed by `types` alone, and `amount_due` / `due_date` are not read for tiles (the
 * tile keyed `amount_due` or `due_date` carries that role instead). `place` is then the role's
 * column only, never a guess. Neither `name` nor `place` may be a column `types` reads as `phone`
 * (AS19 S3(e)).
 */
export interface AgencyContextRoles {
  name?: string;
  place?: string;
  amount_due?: string;
  due_date?: string;
}

/** The most facts a campaign may put on the card (AS19); equals the domain's `MAX_HERO_FIELDS`. */
export const AGENCY_FACT_FIELDS_MAX = 4;

/** The most characters (Unicode code points, after trimming) a fact's name may hold; at least 1. */
export const AGENCY_FACT_LABEL_MAX_CHARS = 16;

/** The most characters a fact's script key may hold. */
export const AGENCY_FACT_KEY_MAX_CHARS = 32;

/**
 * A fact's script key: a lower-case letter, then lower-case letters, digits and underscores, at
 * most {@link AGENCY_FACT_KEY_MAX_CHARS}. The source text is {@link AGENCY_FACT_KEY_PATTERN_SOURCE}.
 */
export const AGENCY_FACT_KEY_PATTERN_SOURCE = '^[a-z][a-z0-9_]*$';
export const AGENCY_FACT_KEY_PATTERN = new RegExp(AGENCY_FACT_KEY_PATTERN_SOURCE);

/**
 * One fact the supervisor chose for the card (AS19), an entry of `AgencyContextDisplay.facts`.
 * The campaign-config write refuses (each refusal keyed by its path, `context_display.facts.2.label`):
 * more than {@link AGENCY_FACT_FIELDS_MAX}; a column that is hidden, that is the `name` or `place`
 * role's, that two facts share (ignoring case), or that the roster does not have (when it knows the
 * roster's columns); a name empty or longer than {@link AGENCY_FACT_LABEL_MAX_CHARS} after trimming,
 * or two the same ignoring case; a key not matching {@link AGENCY_FACT_KEY_PATTERN}, two the same,
 * or one of `AGENCY_SCRIPT_FIXED_PLACEHOLDERS` (`./agent-script.ts`); more than one highlight.
 */
export interface AgencyFactField {
  /** The roster column, as in its header. */
  column: string;
  /** The tile's name the agent sees: 1 to {@link AGENCY_FACT_LABEL_MAX_CHARS} code points, trimmed. */
  label: string;
  /** The script key, `{key}`: {@link AGENCY_FACT_KEY_PATTERN}, at most {@link AGENCY_FACT_KEY_MAX_CHARS}. */
  key: string;
  /** At most one fact per campaign; drawn first and two tiles wide. */
  highlight?: boolean;
}

/** The tile roles: the two roles that are shown as a tile rather than as the customer's name or place. */
export type AgencyFactTileRole = 'amount_due' | 'due_date';

export const AGENCY_FACT_TILE_ROLES = ['amount_due', 'due_date'] as const satisfies readonly AgencyFactTileRole[];

const _allTileRolesListed: AllListed<AgencyFactTileRole, typeof AGENCY_FACT_TILE_ROLES> = true;
void _allTileRolesListed;

/** One fact tile on the station: a chosen fact or a hero column, its raw text, and its parsed value. */
export interface AgencyFactTile {
  /** The roster column, as in its header. */
  column: string;
  /**
   * AS19: the fact's name, from `AgencyContextDisplay.facts`. Set when the campaign has `facts`;
   * absent on the BE-6 path, where the client names the tile by `column`. A client shows
   * `label ?? column`.
   */
  label?: string;
  /** AS19: the fact's script key (`{key}`), with `label`. The script fills `{key}` from this tile. */
  key?: string;
  /** AS19: the campaign's one highlighted fact. Sent first, and drawn two tiles wide. Absent: false. */
  highlight?: boolean;
  /**
   * Set when the column plays a tile role; the "Full / Half" amount chips read `amount_due`. With
   * `facts` (AS19) the server sets it on the tile keyed `amount_due` and on the one keyed `due_date`.
   */
  role?: AgencyFactTileRole;
  type: AgencyContextFieldType;
  /** As uploaded, as display text. Always present (`''` for a fact with no value); never markup. */
  raw: string;
  /**
   * Parsed: a decimal string for `money` and `number` (`"12500.00"`, no sign, no grouping),
   * `YYYY-MM-DD` for a `date` (a calendar day, never an instant: no zone conversion), the digits
   * with an optional leading `+` for a `phone` (`"+919876543210"`), `yes` or `no` for `yes_no`.
   * Always null for `text`, and null when the value could not be read: the client shows `raw`. The
   * amount chips are hidden when the `amount_due` tile's value is null.
   */
  value: string | null;
}

/**
 * The customer's facts on the panel (`AgencyReservedAttempt.facts`). Present from a server that
 * builds them (BE-6); absent from an older one, when the client keeps today's reading of `context`
 * through `context_display`.
 */
export interface AgencyCustomerFacts {
  /**
   * The customer's name: the `name` role's value (none when it is blank on this row), else the
   * server's own guess from the column names (`packages/domain/src/customer-name.ts`, AS19 S1:
   * never a hidden column, never a chosen fact's); absent when there is none. Never the number.
   */
  name?: string;
  /**
   * The `place` role's value, else (without `facts`) the server's guess; with `facts` (AS19 S2) the
   * role's value only. Absent when there is none.
   */
  place?: string;
  /**
   * With `context_display.facts` (AS19): one tile per fact whose column the row has and is not
   * hidden, in the list's order with the highlighted one first, at most
   * {@link AGENCY_FACT_FIELDS_MAX}, each with its `label` and `key`; a fact with no value still has
   * its tile (`raw: ''`). Typed by `types` alone.
   *
   * Without (BE-6): the tiles in hero order (`context_display.hero`, else the server's guess when
   * no hero is set), at most `MAX_HERO_FIELDS` (4), hidden columns never. The columns sent as
   * `name` and `place` are not tiles; the `amount_due` and `due_date` role columns are, appended
   * when the heroes leave them out and kept when the cap bites (the server's rule,
   * `apps/server/src/agency/customer-facts.ts`). With no `roles` or `types` set, every tile is
   * `text` with a null `value`, so a campaign set up before BE-6 shows as today.
   */
  tiles: AgencyFactTile[];
  /**
   * AS20, "More details": the row's other columns, which the agent opens under the card. Built by the
   * domain's one rule (`moreDetailTiles`, `packages/domain/src/more-details.ts`): every column of the
   * row with a value, minus `hidden`, minus `more_hidden`, minus the columns sent as `name` and
   * `place`, minus the chosen facts' columns (`facts`; on the BE-6 path a client also leaves out the
   * columns it drew as tiles); at most {@link AGENCY_MORE_DETAILS_MAX}. Each tile has `column`,
   * `type`, `raw` and `value` only (no `label`, `key`, `highlight` or `role`): a client names it by
   * its column. Its type is `types[column]` (on a card without `facts`, the `amount_due` / `due_date`
   * role columns are `money` / `date`, as on the card); a column `types` does not name whose value
   * holds a phone number (read loosely: an Indian mobile or landline, or `+` / `00` and 8 or more
   * digits, in a value that is not a long text; the domain's `looksLikePhoneNumber`) is sent as
   * `phone`, read per value, so a campaign that hides numbers (`phone_display: masked`) masks it too;
   * its `value` may then be null (`9876543210.0`), and a client masks `raw` on its digits. Order:
   * `order`, then the campaign's imports' column order, then the row's own. Always sent by a server
   * that builds it, `[]` when there is nothing more; absent from an older server, when a client keeps
   * its own reading of `context` for any list of the customer's columns (the app's Details).
   */
  more?: AgencyFactTile[];
}

/** The most columns More details carries (AS20): a bound on the frame, far above a real roster's. */
export const AGENCY_MORE_DETAILS_MAX = 100;

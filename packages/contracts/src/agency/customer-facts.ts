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
 * ── The parse rule (the server's, `packages/domain/src/context-facts.ts`) ────
 * Money: strip the rupee sign, spaces and grouping commas (Indian `1,25,000` and western
 * `125,000`), answer a decimal string (`"125000"`, `"12500.50"`). Date: ISO first, then day-first
 * forms (`20/11/2026`, `20-11-26`, `20 Nov 2026`), answer `YYYY-MM-DD`; never month-first. A
 * value it cannot read is `null`, and the client shows `raw`. When in doubt: null. A wrong amount
 * shown to a collections agent is worse than the raw text.
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

/** How a roster column's values are read. Absent from `AgencyContextDisplay.types`: `text`. */
export type AgencyContextFieldType = 'text' | 'money' | 'date';

export const AGENCY_CONTEXT_FIELD_TYPES = ['text', 'money', 'date'] as const satisfies readonly AgencyContextFieldType[];

const _allFieldTypesListed: AllListed<AgencyContextFieldType, typeof AGENCY_CONTEXT_FIELD_TYPES> = true;
void _allFieldTypesListed;

/**
 * Which column plays each role (`AgencyContextDisplay.roles`): column names exactly as in the
 * roster's header. Every key optional; one column per role. The campaign-config write refuses a
 * role naming a column the roster does not have (with the roster's columns, when it knows them),
 * and a column that is `hidden` (`hidden` wins over everything: a hidden column is never a role).
 * `amount_due` is read as `money` and `due_date` as `date` whatever `types` says.
 */
export interface AgencyContextRoles {
  name?: string;
  place?: string;
  amount_due?: string;
  due_date?: string;
}

/** The tile roles: the two roles that are shown as a tile rather than as the customer's name or place. */
export type AgencyFactTileRole = 'amount_due' | 'due_date';

export const AGENCY_FACT_TILE_ROLES = ['amount_due', 'due_date'] as const satisfies readonly AgencyFactTileRole[];

const _allTileRolesListed: AllListed<AgencyFactTileRole, typeof AGENCY_FACT_TILE_ROLES> = true;
void _allTileRolesListed;

/** One fact tile on the station: a hero column, its raw text, and its parsed value. */
export interface AgencyFactTile {
  /** The roster column, as in its header. */
  column: string;
  /** Set when the column plays a tile role; the "Full / Half" amount chips read `amount_due`. */
  role?: AgencyFactTileRole;
  type: AgencyContextFieldType;
  /** As uploaded, as display text. Always present; never markup. */
  raw: string;
  /**
   * Parsed: a decimal string for `money` (`"12500.00"`, no sign, no grouping), `YYYY-MM-DD` for a
   * `date` (a calendar day, never an instant: no zone conversion). Always null for `text`, and
   * null when the value could not be read: the client shows `raw`. The amount chips are hidden
   * when the `amount_due` tile's value is null.
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
   * The customer's name: the `name` role's value, else the server's own guess from the column
   * names (`context-hero.ts`, `match-name.ts`); absent when there is none. Never the number.
   */
  name?: string;
  /** The `place` role's value, else the server's guess; absent when there is none. */
  place?: string;
  /**
   * The tiles, in hero order (`context_display.hero`, else the server's guess when no hero is
   * set), at most `MAX_HERO_FIELDS` (4), hidden columns never. With no `roles` or `types` set,
   * every tile is `text` with a null `value`, so a campaign set up before BE-6 shows as today.
   */
  tiles: AgencyFactTile[];
}

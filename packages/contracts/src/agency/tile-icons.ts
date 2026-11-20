/**
 * The agent station's picture tiles (agent station redesign, BE-13, AS18): an optional `icon` on a
 * campaign's outcomes (`AgencyDisposition.icon`) and break reasons (`AgencyBreakReason.icon`),
 * chosen by a supervisor from one closed list. Absent: the station works the icon out itself from
 * the outcome's flags (`requires_promise` → rupee, `requires_datetime` → clock, `suppress` → stop,
 * `is_success` → thumbs up, otherwise a dot) or from the break's code and label (a cup as the
 * fallback).
 *
 * ── Unknown values decode as none ───────────────────────────────────────────
 * The list is a vocabulary the app switches on (`fixtures/agent/literals.json`, `tile_icons`). An
 * app built before an icon was added must never fail a bootstrap over it: every reader treats a
 * value it does not know as no icon at all (here {@link agencyTileIconOrNone}; in Dart the
 * `TileIcon.tryFromWire` reader), and so does the server's catalog read, because the catalog
 * validators did not always refuse unknown keys and a stray `icon` may already be stored. The
 * campaign-config write refuses a value not in the list.
 *
 * Part of the dialer contract; `../agency.ts` is the barrel and carries the contract's header.
 */

import type { AllListed } from '../primitives';

/**
 * The icons a tile may carry. Outcome-shaped first, then break-shaped, then neutral; the order
 * is the order a picker offers them. Append only: a removed key would turn a stored icon into
 * none on every station.
 */
export const AGENCY_TILE_ICONS = [
  'rupee',
  'clock',
  'calendar',
  'stop',
  'thumbs_up',
  'thumbs_down',
  'check',
  'cross',
  'phone_missed',
  'phone_busy',
  'voicemail',
  'wrong_number',
  'language',
  'question',
  'tea',
  'lunch',
  'washroom',
  'meeting',
  'training',
  'prayer',
  'headset',
  'walk',
  'person',
  'dot',
] as const;

/** One of {@link AGENCY_TILE_ICONS}. */
export type AgencyTileIcon = (typeof AGENCY_TILE_ICONS)[number];

const _allTileIconsListed: AllListed<AgencyTileIcon, typeof AGENCY_TILE_ICONS> = true;
void _allTileIconsListed;

const TILE_ICON_SET: ReadonlySet<string> = new Set(AGENCY_TILE_ICONS);

/** Whether `value` is an icon of {@link AGENCY_TILE_ICONS}: the one rule the write refuses by. */
export function isAgencyTileIcon(value: unknown): value is AgencyTileIcon {
  return typeof value === 'string' && TILE_ICON_SET.has(value);
}

/**
 * `value` as a tile icon, or `undefined` (no icon) for anything else: an unknown string, a
 * non-string, absence. How every reader of a stored catalog treats the field.
 */
export function agencyTileIconOrNone(value: unknown): AgencyTileIcon | undefined {
  return isAgencyTileIcon(value) ? value : undefined;
}

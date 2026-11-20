/**
 * Agent station campaign settings of stream S2 (docs/agent-station.md): the tile pictures of a
 * campaign's outcomes and break reasons (BE-13) and how the station shows the customer's number
 * (AS9, `phone_display`). The write's rules (both campaign-config validators call
 * {@link stationTileIssues}, so the wizard and the internal handler refuse alike) and the reads'.
 *
 *  - **Icons (BE-13).** `disposition_catalog[i].icon` and `break_reasons[i].icon`, optional, one of
 *    `AGENCY_TILE_ICONS` (`isAgencyTileIcon`, the contract's rule); anything else, `null` included
 *    (leave the key out for none), is refused with the field named. The catalog validators never
 *    refused unknown keys, so a stray `icon` may already be stored: every read that reaches the
 *    agent drops an icon it does not know ({@link dispositionsWithKnownIcons}; the break menu's
 *    `resolveBreakReasons` does the same for break reasons), so the station falls back to its own
 *    picture and the bootstrap never carries a value the app cannot read.
 *  - **Phone display (AS9).** `phone_display`, `full` (the column default, today's behaviour) or
 *    `masked`: a display choice the station applies (the number is still sent in full). Refused
 *    when anything else; served on the session bootstrap ({@link phoneDisplayOf}).
 */
import {
  AGENCY_PHONE_DISPLAY_DEFAULT,
  AGENCY_PHONE_DISPLAYS,
  AGENCY_TILE_ICONS,
  agencyTileIconOrNone,
  isAgencyTileIcon,
  type AgencyDisposition,
  type AgencyPhoneDisplay,
} from '@magick-agency/contracts/agency';

/** One refusal, keyed by the field it is about (the validators' `CampaignConfigIssue` shape). */
export interface StationTileIssue {
  field: string;
  message: string;
}

/** Words for a supervisor (AS15): no field name, no picture keys. `field` says which tile. */
const ICON_MESSAGE = 'Choose one of the tile pictures, or no picture.';

function entries(value: unknown): Array<[number, Record<string, unknown>]> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw, i): Array<[number, Record<string, unknown>]> =>
    (raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? [[i, raw as Record<string, unknown>]] : []));
}

/** BE-13: each `icon` the body's outcomes and break reasons carry, by the contract's rule. */
export function tileIconIssues(record: Record<string, unknown>): StationTileIssue[] {
  const issues: StationTileIssue[] = [];
  for (const key of ['disposition_catalog', 'break_reasons'] as const) {
    for (const [i, entry] of entries(record[key])) {
      if (!Object.hasOwn(entry, 'icon') || entry['icon'] === undefined) continue;
      if (!isAgencyTileIcon(entry['icon'])) issues.push({ field: `${key}[${i}].icon`, message: ICON_MESSAGE });
    }
  }
  return issues;
}

/** AS9: `phone_display`, when the body carries it, is `full` or `masked`. */
export function phoneDisplayIssues(record: Record<string, unknown>): StationTileIssue[] {
  const value = record['phone_display'];
  if (value === undefined || (AGENCY_PHONE_DISPLAYS as readonly unknown[]).includes(value)) return [];
  return [{ field: 'phone_display', message: 'Choose how agents see the customer’s number: in full, or with the middle digits hidden.' }];
}

/** Both rules: what each campaign-config validator adds for these settings. */
export function stationTileIssues(record: Record<string, unknown>): StationTileIssue[] {
  return [...tileIconIssues(record), ...phoneDisplayIssues(record)];
}

/**
 * The catalog as an agent is sent it (BE-13): each entry's `icon` kept when it is one the contract
 * lists and dropped otherwise (a stray or retired value is "no icon"); entries without one untouched.
 */
export function dispositionsWithKnownIcons(catalog: readonly AgencyDisposition[] | null | undefined): AgencyDisposition[] {
  if (!Array.isArray(catalog)) return [];
  return catalog.map((entry) => {
    if (!entry || typeof entry !== 'object' || !Object.hasOwn(entry, 'icon')) return entry;
    const icon = agencyTileIconOrNone((entry as { icon?: unknown }).icon);
    if (icon !== undefined) return entry;
    const { icon: _dropped, ...rest } = entry;
    return rest;
  });
}

/** AS9: the campaign's setting as the bootstrap serves it; anything unexpected reads as the default. */
export function phoneDisplayOf(value: unknown): AgencyPhoneDisplay {
  return (AGENCY_PHONE_DISPLAYS as readonly unknown[]).includes(value) ? value as AgencyPhoneDisplay : AGENCY_PHONE_DISPLAY_DEFAULT;
}

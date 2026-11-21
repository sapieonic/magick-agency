/**
 * Can Postgres cut days in this zone, and what does it call it? The one place a request's zone is
 * looked up in `pg_timezone_names` (reports and Compare agents). The routes check a zone with `Intl`
 * first (`isReportTimezone`, `checkCompareWindow`), but the reads cut days with `AT TIME ZONE` in
 * SQL, and Postgres's zone database can lack a zone this process's ICU knows (a newly added zone, an
 * older server image): such a read would only fail at the database. So a request's zone must also be
 * known to Postgres, matched as `AT TIME ZONE` matches it (ignoring case), and every read cuts days
 * in Postgres's own name for it ({@link postgresZoneName}; the report builders' `resolveReportZone`).
 *
 * ── Legacy names ────────────────────────────────────────────────────────────
 * Browsers report the zone ICU calls canonical, and for several places that is the tz database's
 * OLD name: Chromium reports India as `Asia/Calcutta`, which tz renamed `Asia/Kolkata` long ago and
 * keeps only as a link in its `backward` file. A Postgres built on a system tzdata without the
 * legacy links (Ubuntu's `tzdata` without `tzdata-legacy`) does not know `Asia/Calcutta`, and every
 * read from an IST browser was refused. So a zone Postgres does not know, that is one of the legacy
 * names in {@link LEGACY_ZONE_ALIASES}, resolves to its current name when Postgres knows THAT. The
 * days are cut in the resolved name (the same rules: a link is the same zone); the request's own
 * zone is what the answers echo and what is stored on a run, so a client sees the zone it sent.
 *
 * A zone found is remembered for the life of the process (zones are not removed from a running
 * server's database, and there are a few hundred); a zone not found is asked again next time.
 */
import { getPool } from '@magick-agency/db';

/**
 * Legacy zone names (the tz database's `backward` links) that browsers' ICU still reports, to the
 * current name each links to. Keys as tz spells them; matched ignoring case. Only links to a zone
 * with the same rules, so cutting days in the target is cutting them in the zone asked for.
 */
export const LEGACY_ZONE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Dacca': 'Asia/Dhaka',
  'Asia/Thimbu': 'Asia/Thimphu',
  'Asia/Ulan_Bator': 'Asia/Ulaanbaatar',
  'Asia/Ujung_Pandang': 'Asia/Makassar',
  'Asia/Macao': 'Asia/Macau',
  'Asia/Chongqing': 'Asia/Shanghai',
  'Asia/Chungking': 'Asia/Shanghai',
  'Asia/Harbin': 'Asia/Shanghai',
  'Asia/Kashgar': 'Asia/Urumqi',
  'Asia/Tel_Aviv': 'Asia/Jerusalem',
  'Asia/Istanbul': 'Europe/Istanbul',
  'Europe/Kiev': 'Europe/Kyiv',
  'Europe/Uzhgorod': 'Europe/Kyiv',
  'Europe/Zaporozhye': 'Europe/Kyiv',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Africa/Asmera': 'Africa/Asmara',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'America/Catamarca': 'America/Argentina/Catamarca',
  'America/Cordoba': 'America/Argentina/Cordoba',
  'America/Jujuy': 'America/Argentina/Jujuy',
  'America/Mendoza': 'America/Argentina/Mendoza',
  'America/Indianapolis': 'America/Indiana/Indianapolis',
  'America/Louisville': 'America/Kentucky/Louisville',
  'America/Godthab': 'America/Nuuk',
  'Pacific/Truk': 'Pacific/Chuuk',
  'Pacific/Ponape': 'Pacific/Pohnpei',
  'Pacific/Enderbury': 'Pacific/Kanton',
});

const aliasByLower = new Map(Object.entries(LEGACY_ZONE_ALIASES).map(([from, to]) => [from.toLowerCase(), to]));

/** The current name of a legacy zone name, or null when `zone` is not one. */
export function currentZoneName(zone: string): string | null {
  return aliasByLower.get(zone.toLowerCase()) ?? null;
}

/**
 * Postgres's name for a zone, ignoring case as `AT TIME ZONE` (and `resolvedZoneCte`) does. Nothing
 * declares `lower(name)` unique in the view, so the first name in order is taken.
 */
export const POSTGRES_ZONE_SQL =
  'SELECT z.name FROM pg_timezone_names z WHERE lower(z.name) = lower($1::text) ORDER BY z.name LIMIT 1';

/** Postgres's own name for one zone name, or null. The database's lookup unless a test replaces it. */
type ZoneLookup = (zone: string) => Promise<string | null>;

const databaseLookup: ZoneLookup = async (zone) => {
  const { rows } = await getPool().query<{ name: string }>(POSTGRES_ZONE_SQL, [zone]);
  return rows[0]?.name ?? null;
};
let lookup: ZoneLookup = databaseLookup;

/** Lower-cased zone → the name Postgres cuts its days in. */
const known = new Map<string, string>();

/**
 * The name Postgres cuts the zone's days in: its own spelling of the zone, or, for a legacy name it
 * does not know, of the zone's current name ({@link LEGACY_ZONE_ALIASES}); null when it knows
 * neither.
 */
export async function postgresZoneName(zone: string): Promise<string | null> {
  // Keyed in lower case, as the SQL matches, so case variants of one zone share an entry.
  const key = zone.toLowerCase();
  const cached = known.get(key);
  if (cached !== undefined) return cached;
  let name = await lookup(zone);
  if (name === null) {
    const current = currentZoneName(zone);
    if (current !== null) name = await lookup(current);
  }
  if (name !== null) known.set(key, name);
  return name;
}

/** Can Postgres cut days in the zone (itself, or its current name for a legacy one)? */
export async function postgresKnowsZone(zone: string): Promise<boolean> {
  return (await postgresZoneName(zone)) !== null;
}

/** Forget the remembered zones (tests). */
export function resetKnownZonesForTests(): void {
  known.clear();
}

/**
 * Replace the database's lookup (tests), so a test can be a Postgres that lacks a zone whatever the
 * Postgres running it knows. `null` restores the database's. Forgets the remembered zones.
 */
export function setZoneLookupForTests(fn: ZoneLookup | null): void {
  lookup = fn ?? databaseLookup;
  known.clear();
}

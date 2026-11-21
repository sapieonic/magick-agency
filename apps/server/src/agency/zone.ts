/**
 * Can Postgres cut days in this zone, and what does it call it? The one place a request's zone is
 * looked up in `pg_timezone_names` (reports and Compare agents). The routes check a zone with `Intl`
 * first ({@link isRequestZone}), but the reads cut days with `AT TIME ZONE` in
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
 * names (`LEGACY_ZONE_ALIASES`, `@magick-agency/domain/zone-clock`: the one table, which the console
 * maps by too), resolves to its current name when Postgres knows THAT. The
 * days are cut in the resolved name (the same rules: a link is the same zone); the request's own
 * zone is what the answers echo and what is stored on a run, so a client sees the zone it sent.
 *
 * A zone found is remembered for the life of the process (zones are not removed from a running
 * server's database, and there are a few hundred); a zone not found is asked again next time.
 */
import { getPool } from '@magick-agency/db';
import { currentZoneName, isUsableTimezone } from '@magick-agency/domain/zone-clock';

/**
 * A zone as a request may name it, before Postgres is asked (reports' `timezone`, Compare agents'):
 * a string with no surrounding space, at most 64 characters, that `isUsableTimezone` accepts (the
 * `Area/Location` form or `UTC`, known to `Intl`). Cheap: a route checks this first and asks
 * Postgres ({@link postgresZoneName}) only about a zone that passes it.
 */
export function isRequestZone(zone: unknown): zone is string {
  return typeof zone === 'string' && zone === zone.trim() && zone.length <= 64 && isUsableTimezone(zone);
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
 * does not know, of the zone's current name (`currentZoneName`, the domain's table); null when it knows
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

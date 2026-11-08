/**
 * Can Postgres cut days in this zone, and what does it call it? The one place a report zone is
 * looked up in `pg_timezone_names`. The report routes check a zone with `Intl` first
 * (`isReportTimezone`), but the dataset reads cut the window with `AT TIME ZONE` in SQL, and
 * Postgres's zone database can lack a zone this process's ICU knows (a newly added zone, an older
 * server image): such a run would only fail at assembly. So a request's zone must also be in
 * `pg_timezone_names`, matched as `AT TIME ZONE` matches it (ignoring case), and the dataset
 * builders resolve the run's zone to Postgres's own spelling of it (`resolveReportZone`).
 *
 * A zone found is remembered for the life of the process (zones are not removed from a running
 * server's database, and there are a few hundred); a zone not found is asked again next time.
 */
import { getPool } from '@magick-agency/db';

/** Lower-cased zone → Postgres's name for it. */
const known = new Map<string, string>();

/**
 * Postgres's name for a zone, ignoring case as `AT TIME ZONE` (and `resolvedZoneCte`) does. Nothing
 * declares `lower(name)` unique in the view, so the first name in order is taken.
 */
export const POSTGRES_ZONE_SQL =
  'SELECT z.name FROM pg_timezone_names z WHERE lower(z.name) = lower($1::text) ORDER BY z.name LIMIT 1';

/** The zone as Postgres names it, or null when Postgres does not know it. */
export async function postgresZoneName(zone: string): Promise<string | null> {
  // Keyed in lower case, as the SQL matches, so case variants of one zone share an entry.
  const key = zone.toLowerCase();
  const cached = known.get(key);
  if (cached !== undefined) return cached;
  const { rows } = await getPool().query<{ name: string }>(POSTGRES_ZONE_SQL, [zone]);
  const name = rows[0]?.name ?? null;
  if (name !== null) known.set(key, name);
  return name;
}

/** Is the zone in Postgres's zone database? */
export async function postgresKnowsZone(zone: string): Promise<boolean> {
  return (await postgresZoneName(zone)) !== null;
}

/** Forget the remembered zones (tests). */
export function resetKnownZonesForTests(): void {
  known.clear();
}

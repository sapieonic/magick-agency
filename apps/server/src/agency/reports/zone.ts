/**
 * Can Postgres cut days in this zone? The report routes check a zone with `Intl` first
 * (`isReportTimezone`), but the dataset reads cut the window with `AT TIME ZONE` in SQL, and
 * Postgres's zone database can lack a zone this process's ICU knows (a newly added zone, an older
 * server image): such a run would only fail at assembly. So a request's zone must also be in
 * `pg_timezone_names`, matched as `AT TIME ZONE` matches it (ignoring case).
 *
 * A zone found is remembered for the life of the process (zones are not removed from a running
 * server's database, and there are a few hundred); a zone not found is asked again next time.
 */
import { getPool } from '@magick-agency/db';

const known = new Set<string>();

export const POSTGRES_ZONE_SQL = 'SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE lower(name) = lower($1)) AS known';

export async function postgresKnowsZone(zone: string): Promise<boolean> {
  // Keyed in lower case, as the SQL matches, so case variants of one zone share an entry.
  const key = zone.toLowerCase();
  if (known.has(key)) return true;
  const { rows } = await getPool().query<{ known: boolean }>(POSTGRES_ZONE_SQL, [zone]);
  const found = rows[0]?.known === true;
  if (found) known.add(key);
  return found;
}

/** Forget the remembered zones (tests). */
export function resetKnownZonesForTests(): void {
  known.clear();
}

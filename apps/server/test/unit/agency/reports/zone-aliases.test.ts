import { afterEach, describe, expect, it } from 'vitest';
import {
  LEGACY_ZONE_ALIASES,
  currentZoneName,
  postgresKnowsZone,
  postgresZoneName,
  setZoneLookupForTests,
} from '../../../../src/agency/reports/zone.js';
import { resolveReportZone } from '../../../../src/agency/reports/datasets/shared.js';
import { isUsableTimezone } from '../../../../src/agency/calling-hours.js';

/**
 * A request's zone as Postgres cuts its days (`agency/reports/zone.ts`), for reports and Compare
 * agents. Chromium reports India as `Asia/Calcutta`; a Postgres on system tzdata without the legacy
 * links does not know it. The lookup is replaced here, so these hold whatever zone data the Postgres
 * running the suite has.
 */

/** A Postgres that knows only current names (and spells them its own way). */
const CURRENT_ONLY = new Map(['Asia/Kolkata', 'Europe/Kyiv', 'America/Argentina/Buenos_Aires', 'UTC'].map((z) => [z.toLowerCase(), z]));
const currentOnly = async (zone: string) => CURRENT_ONLY.get(zone.toLowerCase()) ?? null;

afterEach(() => setZoneLookupForTests(null));

describe('a legacy zone name Postgres does not know', () => {
  it('resolves to its current name, ignoring case: the days are cut there', async () => {
    setZoneLookupForTests(currentOnly);
    expect(await postgresZoneName('Asia/Calcutta')).toBe('Asia/Kolkata');
    expect(await postgresZoneName('asia/calcutta')).toBe('Asia/Kolkata');
    expect(await postgresZoneName('Europe/Kiev')).toBe('Europe/Kyiv');
    expect(await postgresZoneName('America/Buenos_Aires')).toBe('America/Argentina/Buenos_Aires');
    expect(await postgresKnowsZone('Asia/Calcutta')).toBe(true);
  });

  it('the report builders cut a run made in a legacy zone in its current name', async () => {
    setZoneLookupForTests(currentOnly);
    await expect(resolveReportZone('Asia/Calcutta')).resolves.toBe('Asia/Kolkata');
  });

  it('a zone Postgres knows keeps its own spelling, legacy or not', async () => {
    setZoneLookupForTests(async (zone) => (zone.toLowerCase() === 'asia/calcutta' ? 'Asia/Calcutta' : null));
    expect(await postgresZoneName('Asia/Calcutta')).toBe('Asia/Calcutta');
  });

  it('an unknown zone, or a legacy one whose current name Postgres lacks too, is refused', async () => {
    setZoneLookupForTests(currentOnly);
    expect(await postgresZoneName('Mars/Olympus')).toBeNull();
    expect(await postgresKnowsZone('Asia/Saigon')).toBe(false); // Asia/Ho_Chi_Minh is not in this Postgres
    await expect(resolveReportZone('Mars/Olympus')).rejects.toThrow(/not known to the database/);
  });
});

describe('LEGACY_ZONE_ALIASES', () => {
  it('maps each legacy name to a current one, never to another legacy name, and both are zones this process knows', () => {
    for (const [from, to] of Object.entries(LEGACY_ZONE_ALIASES)) {
      expect(currentZoneName(from), from).toBe(to);
      expect(currentZoneName(to), `${to} is itself a legacy name`).toBeNull();
      expect(isUsableTimezone(from), from).toBe(true);
      expect(isUsableTimezone(to), to).toBe(true);
    }
    expect(currentZoneName('Asia/Kolkata')).toBeNull();
  });

  it('links only zones with the same clock: the same offset now and half a year from now', () => {
    const offset = (zone: string, at: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: zone, timeZoneName: 'longOffset' })
      .formatToParts(at).find((p) => p.type === 'timeZoneName')!.value;
    const now = new Date();
    const later = new Date(now.getTime() + 182 * 86_400_000);
    for (const [from, to] of Object.entries(LEGACY_ZONE_ALIASES)) {
      expect(offset(from, now), from).toBe(offset(to, now));
      expect(offset(from, later), from).toBe(offset(to, later));
    }
  });
});

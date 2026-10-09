import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AGENCY_STATS_FIELD_CONSUMERS,
  SUPERVISOR_SOURCES,
  type SupervisorSource,
} from '../../utils/agencyStatsConsumers';

/**
 * The supervisor payload has no unread fields (MAG-151 acceptance (3)).
 *
 * The exhaustive `Record<keyof AgencyCampaignStats, …>` in the module under test
 * is the compile-time half: a new field with no entry does not build. This is
 * the runtime half, which checks the entries are TRUE — a `consumedIn` claim
 * against a file that does not read the field, or an `unconsumed` claim about a
 * field something is quietly rendering, both go red here.
 *
 * Note what a green run does and does not prove. It proves every field cusui
 * DECLARES has a reader — syntactically. It does not prove the value reaches the
 * DOM (a file could read the field and render a constant); the component tests
 * cover that. And it cannot prove cusui declares every field core SENDS; that
 * direction needs core, and the sibling-checkout pattern for it is broken in a
 * documented way (MAG-143). See the module doc.
 */

const REPO_ROOT = resolve(__dirname, '../../..');

/** Source with comments stripped, so a field named only in prose is not a consumer. */
function codeOf(source: SupervisorSource): string {
  const raw = readFileSync(resolve(REPO_ROOT, source), 'utf8');
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Does this file read the field off the payload?
 *
 * Two shapes count, because the supervisor surface uses both: a property access
 * on the stats object (`stats?.aht_seconds`), and a quoted key — the contact
 * funnel's `CONTACT_FUNNEL_STATES` table drives its five states through
 * `stats?.[cell.key]`, so the only literal occurrence is `key: 'contacts_total'`.
 *
 * (This used to name a `TILES` table on the page. That table is gone: MAG-167
 * moved every counter off the page and into `agencyCampaignOverview`'s
 * derivations, which is exactly the reader-moved staleness this map exists to
 * catch — so the comment describing the mechanism had to move with it.)
 *
 * A bare identifier deliberately does not count. `agents` and `status` are
 * ordinary words in this codebase — `campaign.status` is on the same page and is
 * a different object — and a substring match would call either one a consumer of
 * a field it has never seen.
 */
function reads(code: string, field: string): boolean {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const propertyAccess = new RegExp(`\\bstats\\s*\\??\\.\\s*${escaped}\\b`);
  const quotedKey = new RegExp(`['"\`]${escaped}['"\`]`);
  return propertyAccess.test(code) || quotedKey.test(code);
}

const sources = new Map<SupervisorSource, string>(
  SUPERVISOR_SOURCES.map((path) => [path, codeOf(path)]),
);

const entries = Object.entries(AGENCY_STATS_FIELD_CONSUMERS);

describe('the supervisor stats payload has no unread fields', () => {
  it('names a real, listed file for every consumed field', () => {
    for (const [field, consumer] of entries) {
      if (!('consumedIn' in consumer)) continue;
      expect(
        SUPERVISOR_SOURCES,
        `${field} names ${consumer.consumedIn}, which is not on the supervisor surface`,
      ).toContain(consumer.consumedIn);
    }
  });

  it.each(entries.filter(([, c]) => 'consumedIn' in c))(
    '%s is actually read where it claims to be',
    (field, consumer) => {
      const path = (consumer as { consumedIn: SupervisorSource }).consumedIn;
      expect(
        reads(sources.get(path)!, field),
        `${field} claims to be read in ${path}, but that file's code never touches it. `
        + 'Either the reader moved and the entry is stale, or the field shipped '
        + 'declared-but-discarded — which is the whole defect this guard exists for.',
      ).toBe(true);
    },
  );

  it.each(entries.filter(([, c]) => 'unconsumed' in c))(
    '%s is genuinely unread, and says why',
    (field, consumer) => {
      const reason = (consumer as { unconsumed: string }).unconsumed;
      // A one-word reason is how "nobody got round to it" gets recorded as a
      // decision. The entry has to argue for itself.
      expect(reason.length, `${field}'s reason is too short to be a reason`).toBeGreaterThan(60);

      const readers = SUPERVISOR_SOURCES.filter((path) => reads(sources.get(path)!, field));
      expect(
        readers,
        `${field} is marked unconsumed but ${readers.join(', ')} reads it. `
        + 'If it is now rendered, move it to `consumedIn`.',
      ).toEqual([]);
    },
  );

  it('leaves no field without an entry', () => {
    // Belt to the compile-time braces: `Record<keyof …>` already forbids a
    // missing key, but only while the map is annotated with it. If someone
    // widens the annotation this still goes red.
    expect(entries.length).toBeGreaterThanOrEqual(31);
    for (const [field, consumer] of entries) {
      expect(
        'consumedIn' in consumer || 'unconsumed' in consumer,
        `${field} has neither a consumer nor a reason`,
      ).toBe(true);
    }
  });
});

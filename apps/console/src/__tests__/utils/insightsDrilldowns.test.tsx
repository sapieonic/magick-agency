import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import type {
  AgencyInsightsActivity,
  AgencyInsightsAllocation,
  AgencyInsightsHealth,
  AgencyInsightsSummary,
} from '../../types/agency-insights';
import {
  allocationLink,
  attemptsLink,
  rosterBucketLink,
  type InsightsAttemptsFilter,
  type RosterBucket,
} from '../../utils/agency/insights/links';
import { RosterSection } from '../../pages/agency/campaign-detail/insights/RosterSection';
import { AllocationSection } from '../../pages/agency/campaign-detail/insights/AllocationSection';
import { CallsSection, type RangeSectionContext } from '../../pages/agency/campaign-detail/insights/ActivitySections';
import { AgentsSection } from '../../pages/agency/campaign-detail/insights/AgentsSection';
import { HealthSection } from '../../pages/agency/campaign-detail/insights/HealthSection';
import * as samplesModule from '../helpers/insights';

/**
 * The drill-down table (`apps/server/test/fixtures/insights-drilldowns.json`), console side.
 *
 * The server's end-to-end test reads each number from a real run and asserts the list it
 * names, called with `params`, has that number as its `total`. Here, for each row:
 *
 *  1. the builder the console uses for that number (`console`) produces exactly `params`, so
 *     `links.ts` cannot drift from what the server proved;
 *  2. the section that shows the number, rendered from that real run's responses
 *     (`apps/server/test/fixtures/insights-responses.json`), carries that very link, so a section
 *     that passes a different filter to the builder goes red too.
 *
 * Change a link param on either side alone and one of the two suites fails.
 */

const SERVER_FIXTURES = resolve(__dirname, '../../../../server/test/fixtures');

interface DrillLink {
  id: string;
  number: string;
  list: 'contacts' | 'attempts';
  params: Record<string, string[]>;
  console: { roster?: RosterBucket; allocation?: string; owner?: string | null; attempts?: Record<string, unknown> };
}
const TABLE = JSON.parse(readFileSync(resolve(SERVER_FIXTURES, 'insights-drilldowns.json'), 'utf-8')) as { links: DrillLink[] };
const RESPONSES = JSON.parse(readFileSync(resolve(SERVER_FIXTURES, 'insights-responses.json'), 'utf-8')) as {
  placeholders: { campaign: string; agent: string; from: string; to: string };
  summary: AgencyInsightsSummary;
  allocation: AgencyInsightsAllocation;
  activity: AgencyInsightsActivity;
  health: AgencyInsightsHealth;
};
const P = RESPONSES.placeholders;
const VARS: Record<string, string> = { agent: P.agent, from: P.from, to: P.to };
const fill = (text: string) => text.replace(/\{(\w+)\}/g, (_, k: string) => VARS[k] ?? `{${k}}`);

/** The link the console builds for a row, from the builder its `console` entry names. */
function consoleLink(link: DrillLink): string | null {
  const c = link.console;
  if (c.roster) return rosterBucketLink(P.campaign, c.roster);
  if (c.allocation) {
    const owner = c.owner === 'total' ? undefined : c.owner === null || c.owner === undefined ? null : fill(c.owner);
    return allocationLink(P.campaign, c.allocation, owner);
  }
  if (c.attempts) {
    const filter = Object.fromEntries(Object.entries(c.attempts).map(([k, v]) => [k, typeof v === 'string' ? fill(v) : v])) as InsightsAttemptsFilter;
    return attemptsLink(P.campaign, { from: P.from, to: P.to, ...filter });
  }
  return null;
}

/** `[path, sorted key=value pairs]`, so two links compare whatever order their params are in. */
function parts(href: string): [string, string[]] {
  const url = new URL(href, 'https://console.test');
  return [url.pathname, [...url.searchParams.entries()].map(([k, v]) => `${k}=${v}`).sort()];
}

const expectedParts = (link: DrillLink): [string, string[]] => [
  `/agency/campaigns/${P.campaign}/${link.list}`,
  Object.entries(link.params).flatMap(([k, vs]) => vs.map((v) => `${k}=${fill(v)}`)).sort(),
];

const ctx: RangeSectionContext = {
  campaignId: P.campaign,
  campaignName: RESPONSES.summary.name,
  range: { from: P.from, to: P.to },
  rangeLabel: 'Range',
  agentName: (id) => (id === null ? 'Unassigned' : id),
};

/** The section that shows a row's number, rendered from the real responses. */
function sectionFor(link: DrillLink): ReactElement | null {
  const root = link.number.split('.')[0];
  if (root === 'summary') return <RosterSection campaignId={P.campaign} campaignName="c" roster={RESPONSES.summary.roster} />;
  if (root === 'allocation') return <AllocationSection campaignId={P.campaign} campaignName="c" allocation={RESPONSES.allocation} timezone="UTC" />;
  if (link.number.startsWith('activity.agents')) return <AgentsSection ctx={ctx} activity={RESPONSES.activity} />;
  if (root === 'activity') return <CallsSection ctx={ctx} activity={RESPONSES.activity} />;
  if (root === 'health') return <HealthSection ctx={ctx} health={RESPONSES.health} timezone="UTC" />;
  return null;
}

/**
 * Numbers the table holds whose section is not one this test renders: `never_attempted` is the
 * stopped headline's (the run's campaign is running), checked through the builder only.
 */
const NOT_RENDERED = new Set(['roster.never_attempted']);

afterEach(cleanup);

/** Where `sample` differs in shape from `real` (keys and value types; null matches any type; an array element matches any real element). */
function shapeDiff(sample: unknown, real: unknown, path = '$'): string[] {
  if (sample === null || real === null) return [];
  if (Array.isArray(real) !== Array.isArray(sample)) return [`${path}: array vs not`];
  if (Array.isArray(real) && Array.isArray(sample)) {
    if (real.length === 0) return [];
    return sample.flatMap((item, i) => {
      const diffs = real.map((r) => shapeDiff(item, r, `${path}[${i}]`));
      return diffs.some((d) => d.length === 0) ? [] : diffs[0]!;
    });
  }
  if (typeof sample !== typeof real) return [`${path}: ${typeof sample} vs ${typeof real}`];
  if (typeof sample !== 'object') return [];
  const a = Object.keys(sample as object).sort();
  const b = Object.keys(real as object).sort();
  // Data-keyed maps (break reasons, wrap-up resolutions) carry the sample's own keys.
  if (/break_by_reason|by_resolution|rejected_by_reason|detail$/.test(path)) return [];
  if (a.join() !== b.join()) return [`${path}: keys [${a.join(', ')}] vs [${b.join(', ')}]`];
  return a.flatMap((k) => shapeDiff((sample as Record<string, unknown>)[k], (real as Record<string, unknown>)[k], `${path}.${k}`));
}

describe('the console\'s hand-written samples', () => {
  it('have exactly the shape of the real responses the server holds its wire to', () => {
    const real = RESPONSES as unknown as Record<string, unknown>;
    const samples: Record<string, unknown> = {
      summary: samplesModule.summary('running'),
      allocation: samplesModule.allocation(),
      activity: samplesModule.activity(),
      trends: samplesModule.trends(),
      health: samplesModule.health(),
    };
    for (const [section, sample] of Object.entries(samples)) expect(shapeDiff(sample, real[section]), section).toEqual([]);
  });
});

describe('the drill-down table, console side', () => {
  it('is the table the server test drives, with every row naming a console builder', () => {
    expect(TABLE.links.length).toBeGreaterThan(30);
    for (const link of TABLE.links) expect(consoleLink(link), link.id).not.toBeNull();
  });

  it.each(TABLE.links.map((l) => [l.id, l] as const))('%s: the builder sends exactly the params the server counted', (_id, link) => {
    expect(parts(consoleLink(link)!)).toEqual(expectedParts(link));
  });

  it.each(TABLE.links.filter((l) => !NOT_RENDERED.has(l.id)).map((l) => [l.id, l] as const))(
    '%s: the section rendering the real response links the number there',
    (_id, link) => {
      const view = render(<MemoryRouter>{sectionFor(link)}</MemoryRouter>);
      const want = JSON.stringify(expectedParts(link));
      const hrefs = [...view.container.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')!);
      expect(hrefs.some((href) => JSON.stringify(parts(href)) === want), `${link.id}: no link to ${want}`).toBe(true);
    },
  );
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The report pipeline (the assembler and the reports tick, `agency/reports/pipeline.ts`) is
 * started from `src/bootstrap/agency.ts` (main process only, RP10) and stopped on shutdown beside
 * the completion-notice drain: in agency's own stop beside the rollup job's and the runtime's
 * (one process), or as one of the shutdown plan's drains (media workers; idempotent after).
 * (`pipeline-stop.test.ts` pins the stop's own budget.) A source scrape, for the reason
 * `agency-reaper-wiring.test.ts` gives: both loops are unit-tested, and the failure worth guarding
 * is a start that is deleted or orphaned, which no behavioural test of the loops would see.
 */
describe('src/bootstrap/agency.ts report pipeline wiring', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/bootstrap/agency.ts'), 'utf8');

  it('starts the pipeline from the context config and keeps the handle', () => {
    expect(source).toMatch(/const reports = startReportPipeline\(ctx\.config\)/);
  });

  it('stops it on shutdown beside the rollup job and the runtime (whose stop drains the notices), not before them', () => {
    const stopReports = source.indexOf('const reportsStopped = reports.stop()');
    expect(stopReports).toBeGreaterThan(0);
    // Started first, awaited only together with the rest.
    expect(stopReports).toBeLessThan(source.indexOf('await insightsRollup.stop()'));
    expect(source).not.toMatch(/await reports\.stop\(\)/);
    const together = source.indexOf('await Promise.all([reportsStopped, rest])');
    expect(together).toBeGreaterThan(source.indexOf('await agencyRuntime.stop()'));
  });

  it('starts it after the runtime (the startup reap first)', () => {
    expect(source.indexOf('startReportPipeline(ctx.config)')).toBeGreaterThan(source.indexOf('await agencyRuntime.start()'));
  });

  it('hands the shutdown plan the running pipeline', () => {
    expect(source).toMatch(/activeReports = reports;/);
    expect(source).toMatch(/export function getReportPipeline\(\): ReportPipeline \| null \{\s*return activeReports;/);
  });
});

/**
 * With media workers the completion-notice drain is one of the shutdown plan's concurrent drains
 * (`cluster/primary.ts`), so `src/index.ts` runs the pipeline's stop among them too: its bounded
 * wait overlaps that drain rather than adding to the stops after it (`cluster/shutdown-order.ts`;
 * the plan's order is unit-tested there). In one process it is left to agency's stop.
 */
describe('src/index.ts report pipeline shutdown', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/index.ts'), 'utf8');

  it('with media workers, drains the report pipeline with the other drains, after agency has started it', () => {
    const drain = source.indexOf('if (media && reports) plan.drains.push(() => reports.stop())');
    expect(drain).toBeGreaterThan(0);
    expect(source.indexOf('const reports = getReportPipeline()')).toBeGreaterThan(source.indexOf('plan.stops.push(await startAgency(ctx))'));
    expect(source.indexOf('const reports = getReportPipeline()')).toBeLessThan(drain);
  });
});

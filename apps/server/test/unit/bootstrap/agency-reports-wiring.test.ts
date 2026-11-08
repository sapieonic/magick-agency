import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The report pipeline (the assembler and the reports tick, `agency/reports/pipeline.ts`) is
 * started from `src/bootstrap/agency.ts` (main process only, RP10) and stopped on shutdown, before
 * the insights rollup job and the runtime. A source scrape, for the reason
 * `agency-reaper-wiring.test.ts` gives: both loops are unit-tested, and the failure worth guarding
 * is a start that is deleted or orphaned, which no behavioural test of the loops would see.
 */
describe('src/bootstrap/agency.ts report pipeline wiring', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/bootstrap/agency.ts'), 'utf8');

  it('starts the pipeline from the context config and keeps the handle', () => {
    expect(source).toMatch(/const reports = startReportPipeline\(ctx\.config\)/);
  });

  it('stops it on shutdown, before the rollup job and the runtime', () => {
    const stopReports = source.indexOf('await reports.stop()');
    expect(stopReports).toBeGreaterThan(0);
    expect(stopReports).toBeLessThan(source.indexOf('await insightsRollup.stop()'));
    expect(stopReports).toBeLessThan(source.indexOf('await agencyRuntime.stop()'));
  });

  it('starts it after the runtime (the startup reap first)', () => {
    expect(source.indexOf('startReportPipeline(ctx.config)')).toBeGreaterThan(source.indexOf('await agencyRuntime.start()'));
  });
});

// The report pipeline's stop (`pipeline.ts`): one budget for all of it. The assembler and the tick
// stop together, each bounded by the budget; the inline renderer's queue is waited for after both,
// in what is left; a hung part never holds the stop past the budget; a second call is the same
// stop. The three parts are fakes here: each part's own bound is unit-tested beside it
// (`assembler.test.ts`, `tick.test.ts`).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const parts = vi.hoisted(() => ({
  events: [] as string[],
  assemblerStop: null as null | (() => Promise<void>),
  tickStop: null as null | ((waitMs?: number) => Promise<void>),
  idle: null as null | (() => Promise<void>),
  assemblerOptions: null as null | { stopWaitMs?: number },
}));

vi.mock('../../../../src/agency/reports/assembler.js', () => ({
  defaultAssemblerDeps: () => ({}),
  startReportAssembler: (options: { stopWaitMs?: number }) => {
    parts.assemblerOptions = options;
    return { runPass: async () => null, stop: () => parts.assemblerStop!() };
  },
}));
vi.mock('../../../../src/agency/reports/tick.js', () => ({
  defaultTickRepos: {},
  startReportTick: () => ({ runTick: async () => null, stop: (waitMs?: number) => parts.tickStop!(waitMs) }),
}));
vi.mock('../../../../src/agency/reports/dispatch.js', () => ({
  checkInlineRenderer: async () => {},
  createInlineDispatcher: () => ({ dispatch: async () => {}, idle: () => parts.idle!() }),
  createSqsDispatcher: () => ({ dispatch: async () => {}, idle: async () => {} }),
  sqsSender: () => ({ send: async () => {} }),
}));

const { startReportPipeline } = await import('../../../../src/agency/reports/pipeline.js');
const { agencyConfigSchema } = await import('../../../../src/config/blocks/agency.js');

const reports = agencyConfigSchema.parse({}).agency.reports;
const config = { s3: undefined, agency: { reports: { ...reports, renderer: 'inline' as const } } };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const never = () => new Promise<void>(() => {});
/** A part that logs its start and end and takes `ms`. */
const timed = (name: string, ms: number) => async () => {
  parts.events.push(`${name}:start`);
  await sleep(ms);
  parts.events.push(`${name}:end`);
};

beforeEach(() => {
  parts.events = [];
  parts.assemblerStop = timed('assembler', 0);
  parts.tickStop = timed('tick', 0);
  parts.idle = timed('idle', 0);
});

describe('ReportPipeline.stop', () => {
  it('stops the assembler and the tick together, the tick inside the budget, then waits for the inline queue', async () => {
    parts.assemblerStop = timed('assembler', 40);
    const tickWaits: Array<number | undefined> = [];
    parts.tickStop = async (waitMs) => { tickWaits.push(waitMs); await timed('tick', 40)(); };
    const pipeline = startReportPipeline(config, { nodeEnv: 'test', stopWaitMs: 1_000 });
    await pipeline.stop();
    const at = (e: string) => parts.events.indexOf(e);
    // Overlapped: both started before either ended, so the stop costs one wait, not both.
    expect(at('tick:start')).toBeLessThan(at('assembler:end'));
    expect(at('assembler:start')).toBeLessThan(at('tick:end'));
    // The queue last, so neither loop can add a render after it.
    expect(at('idle:start')).toBeGreaterThan(at('assembler:end'));
    expect(at('idle:start')).toBeGreaterThan(at('tick:end'));
    // Both loops are bounded by the one budget.
    expect(parts.assemblerOptions?.stopWaitMs).toBe(1_000);
    expect(tickWaits[0]).toBeLessThanOrEqual(1_000);
    expect(tickWaits[0]).toBeGreaterThan(900);
  });

  it('returns within the budget when the tick and the inline queue hang', async () => {
    parts.assemblerStop = timed('assembler', 60);
    // A tick that would never finish, bounded only by the wait it is handed.
    parts.tickStop = async (waitMs) => { await Promise.race([never(), sleep(waitMs ?? 60_000)]); };
    parts.idle = never;
    const pipeline = startReportPipeline(config, { nodeEnv: 'test', stopWaitMs: 150 });
    const started = Date.now();
    const outcome = await Promise.race([pipeline.stop().then(() => 'stopped'), sleep(3_000).then(() => 'hung')]);
    expect(outcome).toBe('stopped');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('the inline queue gets only what is left of the budget after the loops', async () => {
    parts.assemblerStop = timed('assembler', 120);
    parts.idle = never;
    const pipeline = startReportPipeline(config, { nodeEnv: 'test', stopWaitMs: 200 });
    const started = Date.now();
    await pipeline.stop();
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(190);
    // 120 ms of loops plus at most the 80 ms left, not a fresh 200 ms for the queue.
    expect(took).toBeLessThan(310);
  });

  it('a second stop is the same stop', async () => {
    const assemblerStop = vi.fn(timed('assembler', 10));
    parts.assemblerStop = assemblerStop;
    const pipeline = startReportPipeline(config, { nodeEnv: 'test', stopWaitMs: 1_000 });
    const first = pipeline.stop();
    expect(pipeline.stop()).toBe(first);
    await first;
    await pipeline.stop();
    expect(assemblerStop).toHaveBeenCalledTimes(1);
  });
});

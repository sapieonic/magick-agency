import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// NEW (magick-agency, Phase 6): equivalence tests for the changes `runtime.ts` and
// `pacing-engine.ts` carry against core @4850d1d9 (PORTING.md §6.2).
//
//  1. No attempt batcher (billing, plan §8 Phase 6) and no DNC outbox sweeper / resync
//     requester (decision B8) is constructed, started or stopped — and the lifecycle is
//     otherwise core's: `start()` runs dialer → startup reaper → periodic reaper → pacing
//     (core `runtime.ts` "the reaper runs before the pacing supervisor"), `stop()` stops
//     pacing first.
//  2. The DNC gate the pacing engine is handed is the DB-backed `DncRegistry` (B8):
//     a `check` is one `dncRepository.findSuppressed` read with the scope, and nothing
//     else (core: `new DncRegistry(redis, keyPrefix, createDncResyncRequester())`).
//  3. The engine's "something may want to know a campaign finished" seam carries the
//     completion notice (`notifyAgencyCampaignFinished`), not the batcher.
//  4. Nothing on start or stop reaches the network: every core→master hop the runtime
//     made (batch post, DNC forward, DNC resync) is gone or in-process.

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { findSuppressed, abandonment, liveConcurrency } = vi.hoisted(() => ({
  findSuppressed: vi.fn(),
  abandonment: {
    refreshAbandonmentWindow: vi.fn(async () => undefined),
    startAbandonmentMetricsRefresh: vi.fn(() => ({ stop: vi.fn() })),
  },
  liveConcurrency: {
    refreshLiveConcurrency: vi.fn(async () => undefined),
    startLiveConcurrencyRefresh: vi.fn(() => ({ stop: vi.fn() })),
  },
}));
vi.mock('../../../src/dnc/dnc.repository.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/dnc/dnc.repository.js')>()),
  dncRepository: { findSuppressed },
}));
vi.mock('../../../src/agency/abandonment-metrics.js', () => abandonment);
vi.mock('../../../src/agency/live-concurrency-metrics.js', () => liveConcurrency);

import { AgencyRuntime } from '../../../src/agency/runtime.js';
import { DncRegistry } from '../../../src/agency/dnc-registry.js';
import { notifyAgencyCampaignFinished } from '../../../src/agency/campaign-completion-notice.js';

function fakeBridge() {
  return { onLifecycle: vi.fn(() => () => {}) } as never;
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  fetchSpy = vi.fn(async () => { throw new Error('no network in the runtime'); });
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AgencyRuntime — the hop collapses (equivalence with core)', () => {
  it('constructs no attempt batcher and no DNC outbox sweeper', () => {
    const runtime = new AgencyRuntime(fakeBridge(), null, '');
    expect('attemptBatcher' in runtime).toBe(false);
    expect('dncOutbox' in runtime).toBe(false);
  });

  it('hands the pacing engine the DB-backed DNC registry, the same object it exposes', async () => {
    const runtime = new AgencyRuntime(fakeBridge(), null, '');
    expect(runtime.dnc).toBeInstanceOf(DncRegistry);
    expect((runtime.pacing as unknown as { dnc: unknown }).dnc).toBe(runtime.dnc);

    findSuppressed.mockResolvedValue(new Set<string>());
    const answer = await runtime.dnc.check('tenant-1', '+919812345678', { accountId: 'acct-1', campaignId: 'camp-1' });
    expect(answer).toBe('clear');
    expect(findSuppressed).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails the DNC gate closed when the table cannot be read', async () => {
    const runtime = new AgencyRuntime(fakeBridge(), null, '');
    findSuppressed.mockRejectedValue(new Error('connection refused'));
    expect(await runtime.dnc.check('tenant-1', '+919812345678', { accountId: null, campaignId: null }))
      .toBe('unavailable');
  });

  it('registers the completion notice on the engine\'s finalize seam', () => {
    const runtime = new AgencyRuntime(fakeBridge(), null, '');
    const notifier = (runtime.pacing as unknown as {
      completionNotifier: { notifyCampaignFinished: unknown } | null;
    }).completionNotifier;
    expect(notifier?.notifyCampaignFinished).toBe(notifyAgencyCampaignFinished);
    expect('attemptBatcher' in (runtime.pacing as object)).toBe(false);
  });

  it('starts dialer → startup reaper → periodic reaper → pacing, then the gauges, and reaches no network', async () => {
    const runtime = new AgencyRuntime(fakeBridge(), null, '');
    const order: string[] = [];
    vi.spyOn(runtime.dialer, 'start').mockImplementation(() => { order.push('dialer.start'); });
    vi.spyOn(runtime.reaper, 'reapOnStartup').mockImplementation(async () => {
      order.push('reaper.reapOnStartup'); return { attempts: 0, agents: 0 };
    });
    vi.spyOn(runtime.reaper, 'start').mockImplementation(() => { order.push('reaper.start'); });
    vi.spyOn(runtime.pacing, 'start').mockImplementation(() => { order.push('pacing.start'); });
    abandonment.startAbandonmentMetricsRefresh.mockImplementation(() => {
      order.push('abandonment.refresh'); return { stop: vi.fn() };
    });
    liveConcurrency.startLiveConcurrencyRefresh.mockImplementation(() => {
      order.push('liveConcurrency.refresh'); return { stop: vi.fn() };
    });

    await runtime.start();
    expect(order).toEqual([
      'dialer.start', 'reaper.reapOnStartup', 'reaper.start', 'pacing.start',
      'abandonment.refresh', 'liveConcurrency.refresh',
    ]);
    expect(abandonment.refreshAbandonmentWindow).toHaveBeenCalledTimes(1);
    expect(liveConcurrency.refreshLiveConcurrency).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('stops pacing FIRST, and has no batcher or outbox to stop', async () => {
    const runtime = new AgencyRuntime(fakeBridge(), null, '');
    const order: string[] = [];
    vi.spyOn(runtime.pacing, 'stop').mockImplementation(async () => { order.push('pacing.stop'); });
    vi.spyOn(runtime.reaper, 'stop').mockImplementation(() => { order.push('reaper.stop'); });
    vi.spyOn(runtime.dialer, 'stop').mockImplementation(() => { order.push('dialer.stop'); });
    vi.spyOn(runtime.wrapup, 'stop').mockImplementation(() => { order.push('wrapup.stop'); });

    await runtime.stop();
    expect(order).toEqual(['pacing.stop', 'reaper.stop', 'dialer.stop', 'wrapup.stop']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * the boot and stop ORDER between the voice engine and the
 * agency runtime, as `src/index.ts` sequences them:
 *   - the bridge's startup self-heal (`runSelfHealSweep('startup')`) runs
 *     BEFORE `agencyRuntime.start()` — reconcile drifted counters and fail dead
 *     calls before the pacing supervisor can admit new work;
 *   - inside `agencyRuntime.start()`, the startup reaper runs BEFORE the pacing
 *     supervisor (a supervisor started first would count dead rows as occupancy);
 *   - `agencyRuntime.start()` completes BEFORE `app.listen` (scraped);
 *   - `agencyRuntime.stop()` runs BEFORE `webrtcBridge.gracefulShutdown()` —
 *     pacing stops first, so no tick can place a call while the bridge drains.
 *
 * `src/index.ts` cannot be imported — it calls
 * `main()` — so the order is pinned twice: (1) a scrape of `index.ts` that the start calls
 * are voice-then-agency and the stops run in reverse, and (2) the bootstrap functions
 * driven in that sequence on real Postgres/Redis with a led campaign, asserting the
 * observable consequences. Only the carrier is faked.
 */

vi.hoisted(() => {
  process.env['FF_AGENCY_DIALER'] = 'true';
  process.env['VOICELINK_WEBHOOK_BASE_URL'] = 'https://agency.test/api/v1/webhooks/voicelink';
});

vi.mock('../../../src/telephony/factory.js', () => ({
  TelephonyProviderRegistry: class {
    get() {
      return {
        name: 'voicelink',
        capabilities: { cancelRinging: false, queuesOutboundDials: true },
        initiateCall: async (req: { callId: string }) => ({ providerCallId: `carrier-${req.callId}` }),
        endCall: async () => undefined,
      };
    }
  },
}));

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { closePool, getPool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL, closeTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { uuidFor } from '../../../../../packages/db/test/integration/setup/factories.js';
import { closeTestRedis, flushTestRedis, getTestRedis } from '../../helpers/test-redis.js';
import { insertAgencyCampaign, insertAgencyContact } from './agency-factories.js';
import { config } from '../../../src/config/index.js';
import { initFeatureFlagService } from '../../../src/feature-flags/index.js';
import type { AppContext } from '../../../src/app-context.js';
import { ensureVoiceEngine, getVoiceEngine, resetVoiceEngineForTests, startVoice } from '../../../src/bootstrap/voice.js';
import { ensureAgencyRuntime, getAgencyRuntime, resetAgencyRuntimeForTests, startAgency } from '../../../src/bootstrap/agency.js';

async function waitFor(what: string, probe: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!probe()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('voice ↔ agency boot and stop order', () => {
  beforeAll(async () => {
    initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });
    await truncateAll();
    await flushTestRedis();
    resetVoiceEngineForTests();
    await resetAgencyRuntimeForTests();
  });

  afterAll(async () => {
    await resetAgencyRuntimeForTests();
    resetVoiceEngineForTests();
    await closePool();
    await closeTestPool();
    await closeTestRedis();
  });

  it('index.ts starts voice before agency, listens only after the bootstraps, and stops in reverse', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/index.ts'), 'utf8');
    const voice = source.indexOf('stops.push(await startVoice(ctx))');
    const agency = source.indexOf('stops.push(await startAgency(ctx))');
    const analysis = source.indexOf('stops.push(await startAnalysis(ctx))');
    expect(voice).toBeGreaterThan(-1);
    expect(agency).toBeGreaterThan(voice);
    // `agencyRuntime.start()` (startup reap, then the
    // supervisor) completes before `app.listen`, so no request beats the reap.
    const listens = [...source.matchAll(/await app\.listen\(/g)].map((m) => m.index!);
    expect(listens).toHaveLength(1);
    expect(listens[0]).toBeGreaterThan(agency);
    expect(listens[0]).toBeGreaterThan(analysis);
    const stopLoop = source.search(/for \(const stop of \[\.\.\.stops\]\.reverse\(\)\)/);
    expect(stopLoop).toBeGreaterThan(-1);
    // HTTP closes before the bootstraps' stops — `http-close` precedes the runtime/bridge
    // stops and `audit-flush`; `app.close()` precedes `auditLogger.shutdown()` — so no
    // request buffers an audit row after the platform stop flushed it. And the signal
    // handlers are installed before the bootstraps (ahead of `agencyRuntime.start()`).
    const closes = [...source.matchAll(/await app\.close\(/g)].map((m) => m.index!);
    expect(closes).toHaveLength(1);
    expect(closes[0]).toBeLessThan(stopLoop);
    const sigterm = source.indexOf("process.on('SIGTERM'");
    expect(sigterm).toBeGreaterThan(-1);
    expect(sigterm).toBeLessThan(source.indexOf('stops.push(await startPlatform(ctx))'));
  });

  it('self-heal before runtime.start(); startup reaper before the supervisor; no tick once the agency stop begins; the bridge drains after', async () => {
    const tenant = uuidFor('boot-order-tenant');
    const account = uuidFor('boot-order-account');
    // A running campaign with one pending contact and no agent: the supervisor leads it
    // and the 250ms tick stays live (no idle agent ⇒ to_dial 0, so nothing is dialed, and
    // a non-empty list ⇒ the leader does not finalize it out from under the test).
    const campaign = await insertAgencyCampaign({ tenant_id: tenant, account_id: account, status: 'running' });
    await insertAgencyContact(campaign.id, { tenant_id: tenant, account_id: account, phone_e164: '+919812300001' });

    const ctx: AppContext = { config, pool: getPool(), redis: getTestRedis() };
    // index.ts runs `buildApp` before the bootstraps, and `buildApp` initialises the flag
    // service on the process's Redis; this test boots no HTTP app.
    initFeatureFlagService(ctx.redis, config.redis.keyPrefix);
    const events: string[] = [];

    // The instances index.ts's bootstraps will use (both are process singletons).
    const engine = ensureVoiceEngine(ctx.redis);
    const runtime = ensureAgencyRuntime(ctx.redis, config.redis.keyPrefix);
    // The runtime dials through the voice engine's bridge, not a second one.
    expect(getVoiceEngine()).toBe(engine);

    // Each spy records its call AND its completion, so an un-awaited step is visible.
    const selfHeal = engine.guardHost.runSelfHealSweep.bind(engine.guardHost);
    vi.spyOn(engine.guardHost, 'runSelfHealSweep').mockImplementation(async (...args) => {
      events.push(`selfHeal:${String(args[0])}`);
      const r = await selfHeal(...args);
      // A real delay before `:done`, so an un-awaited sweep (mutation M2) reds by
      // construction rather than by a race with the agency bootstrap.
      await new Promise((resolve) => setTimeout(resolve, 100));
      events.push(`selfHeal:${String(args[0])}:done`);
      return r;
    });
    const start = runtime.start.bind(runtime);
    vi.spyOn(runtime, 'start').mockImplementation(async () => { events.push('runtime.start'); return start(); });
    const reap = runtime.reaper.reapOnStartup.bind(runtime.reaper);
    vi.spyOn(runtime.reaper, 'reapOnStartup').mockImplementation(async (...args) => {
      events.push('reaper.reapOnStartup');
      const r = await reap(...args);
      events.push('reaper.reapOnStartup:done');
      return r;
    });
    const pacingStart = runtime.pacing.start.bind(runtime.pacing);
    vi.spyOn(runtime.pacing, 'start').mockImplementation(() => { events.push('pacing.start'); pacingStart(); });
    const stopRuntime = runtime.stop.bind(runtime);
    vi.spyOn(runtime, 'stop').mockImplementation(async () => {
      events.push('runtime.stop');
      await stopRuntime();
      events.push('runtime.stop:done');
    });
    const drain = engine.bridge.gracefulShutdown.bind(engine.bridge);
    vi.spyOn(engine.bridge, 'gracefulShutdown').mockImplementation(async () => {
      events.push('bridge.drain'); return drain();
    });
    let stopping = false;
    let ticksAfterStop = 0;
    let ticks = 0;
    const tick = runtime.pacing.tickOnce.bind(runtime.pacing);
    vi.spyOn(runtime.pacing, 'tickOnce').mockImplementation(async (id: string) => {
      ticks++;
      if (stopping) ticksAfterStop++;
      return tick(id);
    });

    // index.ts's sequence: voice, then agency; stops reversed.
    const stopVoice = await startVoice(ctx);
    const stopAgency = await startAgency(ctx);
    const stops: Array<() => Promise<void>> = [stopVoice, stopAgency];

    // (a) The bridge's startup self-heal has COMPLETED before the runtime starts…
    const at = (e: string): number => events.indexOf(e);
    expect(at('selfHeal:startup:done')).toBeGreaterThan(-1);
    expect(at('runtime.start')).toBeGreaterThan(at('selfHeal:startup:done'));
    // …and inside it the startup reaper has COMPLETED before the pacing supervisor starts.
    expect(at('reaper.reapOnStartup')).toBeGreaterThan(at('runtime.start'));
    expect(at('pacing.start')).toBeGreaterThan(at('reaper.reapOnStartup:done'));

    // The campaign is led and ticking before shutdown begins.
    await waitFor('pacing ticks', () => ticks >= 3);
    expect(runtime.pacing.leading()).toHaveLength(1);

    for (const stop of stops.reverse()) {
      if (stop === stopAgency) { stopping = true; events.push('agency.stop'); }
      await stop();
    }
    // Long enough for several 250ms ticks had any interval survived.
    await new Promise((r) => setTimeout(r, 1_000));

    // (b) No tick once the agency stop began; pacing fully relinquished; and the
    // runtime's stop COMPLETED before the bridge began draining.
    expect(ticksAfterStop).toBe(0);
    expect(runtime.pacing.leading()).toEqual([]);
    expect(at('runtime.stop')).toBeGreaterThan(at('agency.stop'));
    expect(at('bridge.drain')).toBeGreaterThan(at('runtime.stop:done'));
  }, 30_000);

  it('resetAgencyRuntimeForTests() stops a runtime startAgency started and nobody stopped', async () => {
    // The previous case stopped its runtime; start a fresh one on the same campaign.
    await resetAgencyRuntimeForTests();
    resetVoiceEngineForTests();
    const ctx: AppContext = { config, pool: getPool(), redis: getTestRedis() };
    const stopVoice = await startVoice(ctx);
    await startAgency(ctx);
    const runtime = getAgencyRuntime()!;
    const stop = vi.spyOn(runtime, 'stop');
    await waitFor('leadership', () => runtime.pacing.leading().length === 1);

    await resetAgencyRuntimeForTests();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(runtime.pacing.leading()).toEqual([]);
    expect(getAgencyRuntime()).toBeNull();
    // Idempotent: nothing left to stop.
    await resetAgencyRuntimeForTests();
    expect(stop).toHaveBeenCalledTimes(1);
    await stopVoice();
  }, 30_000);
});

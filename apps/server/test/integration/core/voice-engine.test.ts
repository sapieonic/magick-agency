import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * NEW (magick-agency, lane C): the voice engine as the agency runtime will use it — the
 * real `TelephonyGuardHost` (the guards extracted from core's CallManager) and the real
 * `WebRtcBridgeManager`, over REAL Redis (6383, this worktree's test db) and REAL
 * Postgres (5436). Only the carrier is faked (`TelephonyProviderRegistry`), as in core's
 * bridge suites — there is no VoiceLink sandbox account (docs/seams.md §5).
 *
 * Phase 5 exit-gate evidence:
 *   1. the guard refuses at each scope (global, account, provider, unallocated), seen
 *      through the bridge's own dial path, and frees every scope at teardown;
 *   2. the stale sweep frees a dead session's slot: a crashed replica's agency call
 *      (row stuck `in_progress`, Redis lock TTL-expired, counter left inflated) is failed
 *      `STUCK_ACTIVE_CALL` and its capacity comes back, while a call this replica is
 *      bridging is never swept;
 *   3. `setConcurrencyControl` is registered by the voice bootstrap and its methods act
 *      on the same guards the bridge admits through (docs/seams.md §3.3).
 */

// Config is read at import: a small global ceiling, and the VoiceLink webhook base the
// bridge builds the PSTN-stream and status URLs from. Hoisted above the imports.
vi.hoisted(() => {
  process.env['MAX_CONCURRENT_CALLS'] = '3';
  process.env['VOICELINK_WEBHOOK_BASE_URL'] = 'https://agency.test/api/v1/webhooks/voicelink';
});

const { fakeAdapter } = vi.hoisted(() => ({
  fakeAdapter: {
    name: 'voicelink',
    capabilities: { cancelRinging: false, queuesOutboundDials: true },
    initiateCall: vi.fn(async (req: { callId: string }) => ({ providerCallId: req.callId })),
    endCall: vi.fn(async () => undefined),
  },
}));
vi.mock('../../../src/telephony/factory.js', () => ({
  TelephonyProviderRegistry: class {
    get() { return fakeAdapter; }
  },
}));

import { closePool, initDbPool } from '@magick-agency/db';
import { providerConcurrencyRepository } from '@magick-agency/db/repositories/provider-concurrency.repository';
import { accountSettingsRepository } from '@magick-agency/db/repositories/account-settings.repository';
import { TEST_DB_URL, closeTestPool, getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { insertWebrtcCall, uuidFor } from '../../../../../packages/db/test/integration/setup/factories.js';
import { closeTestRedis, flushTestRedis, getTestRedis } from '../../helpers/test-redis.js';
import { ensureVoiceEngine, resetVoiceEngineForTests, type VoiceEngine } from '../../../src/bootstrap/voice.js';
import { getConcurrencyControl, resetConcurrencyControl } from '../../../src/seams/concurrency-control.js';
import { WebRtcCallError } from '../../../src/core/webrtc-bridge-manager.js';

const TENANT = uuidFor('voice-engine-tenant');
const ACCOUNT_A = uuidFor('voice-engine-account-a');
const ACCOUNT_B = uuidFor('voice-engine-account-b');
const ACCOUNT_P = uuidFor('voice-engine-account-provider');
const CAMPAIGN = uuidFor('voice-engine-campaign');

let engine: VoiceEngine;
let seq = 0;

function stationWs() {
  const handlers: Record<string, ((...a: any[]) => void)[]> = {};
  return {
    readyState: 1,
    OPEN: 1,
    sent: [] as any[],
    send(s: string) { this.sent.push(JSON.parse(s)); },
    on(ev: string, cb: (...a: any[]) => void) { (handlers[ev] ||= []).push(cb); },
    off(ev: string, cb: (...a: any[]) => void) {
      const l = handlers[ev]; if (!l) return; const i = l.indexOf(cb); if (i >= 0) l.splice(i, 1);
    },
    emit(ev: string, ...a: any[]) { (handlers[ev] || []).slice().forEach((cb) => cb(...a)); },
    close() { this.readyState = 3; },
  };
}

/** Dial through the agency entry point; returns the attempt id used as correlation id. */
async function dial(accountId: string) {
  const attempt = uuidFor(`attempt-${++seq}`);
  const record = await engine.bridge.createBridgedCall({
    tenantId: TENANT,
    accountId,
    callerId: '+919800000001',
    destinationPhone: '+919800000002',
    browserSocket: stationWs() as any,
    campaignId: CAMPAIGN,
    agencyAttemptId: attempt,
  });
  return { record, attempt };
}

async function refusal(accountId: string): Promise<WebRtcCallError> {
  const err = await dial(accountId).then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(WebRtcCallError);
  return err as WebRtcCallError;
}

async function seedLegacy(accountId: string, maxConcurrentCalls: number): Promise<void> {
  await getTestPool().query(
    `INSERT INTO account_settings (tenant_id, account_id, max_concurrent_calls, concurrency_allocation_mode)
     VALUES ($1, $2, $3, 'legacy_total')`,
    [TENANT, accountId, maxConcurrentCalls],
  );
}

async function rowCount(): Promise<number> {
  const { rows } = await getTestPool().query<{ n: string }>('SELECT count(*)::text AS n FROM agency_calls');
  return Number(rows[0]!.n);
}

async function globalCounter(): Promise<number> {
  return Number.parseInt((await getTestRedis().get('active_calls')) ?? '0', 10);
}

describe('voice engine against real Redis + Postgres (integration)', () => {
  beforeAll(() => {
    initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });
  });

  beforeEach(async () => {
    await truncateAll();
    await flushTestRedis();
    resetVoiceEngineForTests();
    resetConcurrencyControl();
    accountSettingsRepository.invalidate(TENANT, ACCOUNT_A);
    accountSettingsRepository.invalidate(TENANT, ACCOUNT_B);
    accountSettingsRepository.invalidate(TENANT, ACCOUNT_P);
    engine = ensureVoiceEngine(getTestRedis());
    fakeAdapter.initiateCall.mockClear();
  });

  afterAll(async () => {
    await engine?.bridge.gracefulShutdown();
    await engine?.guardHost.gracefulShutdown();
    await closePool();
    await closeTestPool();
    await closeTestRedis();
  });

  describe('the guard refuses at each scope, through the bridge', () => {
    it('global: the process ceiling (MAX_CONCURRENT_CALLS=3) refuses the 4th call with 429, writing no row', async () => {
      await seedLegacy(ACCOUNT_A, 10);
      await seedLegacy(ACCOUNT_B, 10);
      await dial(ACCOUNT_A);
      await dial(ACCOUNT_A);
      await dial(ACCOUNT_B);

      const err = await refusal(ACCOUNT_B);
      expect(err.code).toBe('global_concurrency_limit');
      expect(err.statusCode).toBe(429);
      expect(await rowCount()).toBe(3);
      expect(await globalCounter()).toBe(3);
      expect(fakeAdapter.initiateCall).toHaveBeenCalledTimes(3);
    });

    it('account: account_settings.max_concurrent_calls refuses with 429 and rolls the global slot back', async () => {
      await seedLegacy(ACCOUNT_A, 1);
      await dial(ACCOUNT_A);

      const err = await refusal(ACCOUNT_A);
      expect(err.code).toBe('account_concurrency_limit');
      expect(err.statusCode).toBe(429);
      expect(await rowCount()).toBe(1);
      expect(await globalCounter()).toBe(1);
    });

    it('provider: a provider-mode voicelink allocation refuses with 429 and holds nothing for the refusal', async () => {
      await providerConcurrencyRepository.replaceProviderBreakdown({
        tenant_id: TENANT, account_id: ACCOUNT_P, expected_version: 1,
        // Another carrier's share keeps the account total (the sum of the rows) above
        // voicelink's, so it is the provider scope that refuses, not the account's.
        providers: [{ provider: 'voicelink', max_concurrent_calls: 1 }, { provider: 'other-carrier', max_concurrent_calls: 2 }],
      });
      await dial(ACCOUNT_P);

      const err = await refusal(ACCOUNT_P);
      expect(err.code).toBe('provider_concurrency_limit');
      expect(err.statusCode).toBe(429);
      expect(await rowCount()).toBe(1);
      expect(await globalCounter()).toBe(1);
    });

    it('provider: an account with no voicelink allocation is refused 422 (unallocated)', async () => {
      await providerConcurrencyRepository.replaceProviderBreakdown({
        tenant_id: TENANT, account_id: ACCOUNT_P, expected_version: 1,
        providers: [{ provider: 'other-carrier', max_concurrent_calls: 2 }],
      });

      const err = await refusal(ACCOUNT_P);
      expect(err.code).toBe('provider_concurrency_limit');
      expect(err.statusCode).toBe(422);
      expect(await rowCount()).toBe(0);
      expect(await globalCounter()).toBe(0);
    });

    it('teardown frees every scope, so the refused call is admitted next', async () => {
      await seedLegacy(ACCOUNT_A, 1);
      const { attempt } = await dial(ACCOUNT_A);
      expect((await refusal(ACCOUNT_A)).code).toBe('account_concurrency_limit');

      await expect(engine.bridge.forceEndWithOutcome(attempt, 'ended_by_user')).resolves.toBe(true);
      expect(await globalCounter()).toBe(0);

      await expect(dial(ACCOUNT_A)).resolves.toBeDefined();
      expect(await globalCounter()).toBe(1);
    });
  });

  describe('the stale sweep frees a dead session\'s slot', () => {
    it('fails a crashed replica\'s stuck call, heals the counter, and spares a call this replica is bridging', async () => {
      await seedLegacy(ACCOUNT_A, 2);

      // A dead replica's call: its row is stuck `in_progress` past the sweep floor
      // (WEBRTC_MAX_DURATION_SECONDS + 5 min grace ≈ 4h05m) …
      const dead = await insertWebrtcCall({
        tenant_id: TENANT, account_id: ACCOUNT_A, campaign_id: CAMPAIGN, status: 'in_progress',
        created_at: new Date(Date.now() - 5 * 3600_000),
      });
      // … and its slot was taken by that replica's guards and never released. Take it
      // for real, then expire its locks the way a crash leaves them (the counters stay).
      const deadKey = 'dead-replica-lease';
      await expect(engine.guardHost.tryAcquireTelephonyConcurrency(deadKey, TENANT, ACCOUNT_A, 'voicelink', 60))
        .resolves.toMatchObject({ result: 'acquired' });
      await getTestRedis().del(
        `active_calls:lock:${deadKey}`,
        `active_calls:account:${TENANT}:${ACCOUNT_A}:lock:${deadKey}`,
      );

      // A live call on THIS replica, also old enough to be swept if it were not excluded.
      const { record: live } = await dial(ACCOUNT_A);
      await getTestPool().query(
        `UPDATE agency_calls SET status = 'in_progress', created_at = now() - interval '5 hours' WHERE id = $1`,
        [live.id],
      );

      // The account is full: one live call + one phantom slot.
      expect((await refusal(ACCOUNT_A)).code).toBe('account_concurrency_limit');

      await expect(engine.guardHost.runSelfHealSweep('periodic')).resolves.toBe(true);

      const { rows } = await getTestPool().query(
        'SELECT id, status, error_code FROM agency_calls WHERE id = ANY($1::uuid[]) ORDER BY id',
        [[dead.id, live.id]],
      );
      const byId = new Map(rows.map((r: any) => [r.id, r]));
      expect(byId.get(dead.id)).toMatchObject({ status: 'failed', error_code: 'STUCK_ACTIVE_CALL' });
      expect(byId.get(live.id)).toMatchObject({ status: 'in_progress', error_code: null });

      // The phantom slot is back: counters equal the live locks, and a new call fits.
      expect(await globalCounter()).toBe(1);
      await expect(dial(ACCOUNT_A)).resolves.toBeDefined();
    });
  });

  describe('ConcurrencyControl (docs/seams.md §3.3), registered by the voice bootstrap', () => {
    it('is wired by ensureVoiceEngine and reads the live leases the bridge holds', async () => {
      await providerConcurrencyRepository.replaceProviderBreakdown({
        tenant_id: TENANT, account_id: ACCOUNT_P, expected_version: 1,
        providers: [{ provider: 'voicelink', max_concurrent_calls: 3 }],
      });
      await dial(ACCOUNT_P);
      await dial(ACCOUNT_P);

      const control = getConcurrencyControl();
      await expect(control.getAccountCount(TENANT, ACCOUNT_P)).resolves.toBe(2);
      await expect(control.getDistributedAccountCount(TENANT, ACCOUNT_P))
        .resolves.toEqual({ status: 'available', count: 2 });
      const providerCounts = await control.getAccountProviderCounts(TENANT, ACCOUNT_P);
      expect(providerCounts.status).toBe('available');
      expect(providerCounts.counts.get('voicelink')).toBe(2);
    });

    it('invalidateAccountLimit makes the guard read a lowered limit at once (core\'s order: settings cache, then guard)', async () => {
      await seedLegacy(ACCOUNT_A, 5);
      await dial(ACCOUNT_A); // primes the guard's cached limit (5)

      await getTestPool().query(
        'UPDATE account_settings SET max_concurrent_calls = 1 WHERE tenant_id = $1 AND account_id = $2',
        [TENANT, ACCOUNT_A],
      );
      accountSettingsRepository.invalidate(TENANT, ACCOUNT_A);
      await getConcurrencyControl().invalidateAccountLimit(TENANT, ACCOUNT_A);

      expect((await refusal(ACCOUNT_A)).code).toBe('account_concurrency_limit');
    });

    it('invalidateProviderLimits makes the guard read a changed allocation at once', async () => {
      await providerConcurrencyRepository.replaceProviderBreakdown({
        tenant_id: TENANT, account_id: ACCOUNT_P, expected_version: 1,
        providers: [{ provider: 'voicelink', max_concurrent_calls: 1 }, { provider: 'other-carrier', max_concurrent_calls: 2 }],
      });
      await dial(ACCOUNT_P);
      expect((await refusal(ACCOUNT_P)).code).toBe('provider_concurrency_limit');

      await providerConcurrencyRepository.replaceProviderBreakdown({
        tenant_id: TENANT, account_id: ACCOUNT_P, expected_version: 2,
        providers: [{ provider: 'voicelink', max_concurrent_calls: 2 }, { provider: 'other-carrier', max_concurrent_calls: 2 }],
      });
      accountSettingsRepository.invalidate(TENANT, ACCOUNT_P);
      await getConcurrencyControl().invalidateAccountLimit(TENANT, ACCOUNT_P);
      await getConcurrencyControl().invalidateProviderLimits(TENANT, ACCOUNT_P);

      await expect(dial(ACCOUNT_P)).resolves.toBeDefined();
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The bridge's row writes under a connection pool that does not keep their order.
 *
 * Every `webrtcCallRepository.update` is its own pool query, and two queries on two
 * connections land in whatever order the pool and Postgres get to them — an UPDATE that
 * has to open a new connection loses to one that found an idle connection, though it
 * was issued first. The webhook storm suite (`integration/load/voicelink-webhook-storm`)
 * caught the consequence against real Postgres: a `call.answered` and its terminal
 * webhook processed together left the row `in_progress` with `ended_at` set — the
 * terminal state lost, and the stale sweep later rewriting it `failed`.
 *
 * That interleaving is rare against a real pool, so it is reproduced here with the
 * repository replaced by a small in-memory table whose writes APPLY when their promise
 * resolves, after a seeded latency: progress writes (`ringing`, `in_progress`) are slow
 * and terminal writes fast, the adversarial case. Many calls each receive a seeded
 * shuffle of `call.ringing`, `call.answered` and a terminal, all at once. The invariant:
 * every row ends terminal, and no live status is ever applied over a terminal one.
 */

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/config/index.js', () => ({
  config: {
    redis: { keyPrefix: '' },
    telephony: { voicelink: { webhookBaseUrl: 'https://server.test/api/v1/webhooks/voicelink' } },
  },
}));

const { table, applied, latency } = vi.hoisted(() => ({
  table: new Map<string, Record<string, unknown>>(),
  /** Every status write in the order it APPLIED, per call. */
  applied: new Map<string, string[]>(),
  latency: { progressMs: (): number => 0, terminalMs: (): number => 0 },
}));
const { mockRepo } = vi.hoisted(() => {
  let seq = 0;
  return {
    mockRepo: {
      create: vi.fn(async (i: Record<string, unknown>) => {
        const id = `call-${++seq}`;
        const row = { ...i, id, status: 'initiating', provider_call_id: null, answered_at: null, ended_at: null };
        table.set(id, row);
        return row;
      }),
      findById: vi.fn(async (id: string) => table.get(id) ?? null),
      update: vi.fn((id: string, patch: Record<string, unknown>) => {
        const status = patch['status'] as string | undefined;
        const live = status === 'ringing' || status === 'in_progress';
        const ms = status === undefined ? 0 : live ? latency.progressMs() : latency.terminalMs();
        return new Promise((resolve) => {
          setTimeout(() => {
            const row = table.get(id)!;
            Object.assign(row, patch);
            if (status) applied.set(id, [...(applied.get(id) ?? []), status]);
            resolve(row);
          }, ms);
        });
      }),
    },
  };
});
vi.mock('@magick-agency/db/repositories/agency-call.repository', () => ({ webrtcCallRepository: mockRepo }));
vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({
  accountSettingsRepository: {
    getAllowRecording: vi.fn().mockResolvedValue(null),
    getWebrtcMaxDurationSeconds: vi.fn().mockResolvedValue(null),
  },
}));
vi.mock('../../../src/telephony/factory.js', () => ({
  TelephonyProviderRegistry: class {
    get() {
      return {
        name: 'voicelink',
        capabilities: { cancelRinging: false, queuesOutboundDials: true },
        initiateCall: async (req: { callId: string }) => ({ providerCallId: req.callId }),
        endCall: async () => undefined,
      };
    }
  },
}));
vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: { log: vi.fn() } }));
vi.mock('../../../src/analytics/posthog.js', () => ({
  trackWebrtcCallInitiated: vi.fn(),
  trackWebrtcCallRejected: vi.fn(),
  trackWebrtcCallCompleted: vi.fn(),
}));

import { WebRtcBridgeManager } from '../../../src/core/webrtc-bridge-manager.js';
import { parseVoicelinkWebhook } from '../../../src/telephony/voicelink/voicelink.webhook.js';
import { createRng, LOAD_SEED, scaled } from '../../helpers/load-scale.js';

function guardHost() {
  return {
    concurrencyGuard: { tryAcquire: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(undefined) },
    accountConcurrencyGuard: { tryAcquire: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(undefined) },
    triggerDequeue: vi.fn(),
    wakeSelfHeal: vi.fn(),
  };
}

function station() {
  return { readyState: 1, OPEN: 1, send: vi.fn(), on: vi.fn(), off: vi.fn(), close: vi.fn() };
}

const TERMINAL = new Set(['completed', 'no_answer', 'busy', 'canceled', 'failed']);
const CALLS = scaled(200);

describe(`bridge row writes under a reordering pool (calls ${CALLS}, seed ${LOAD_SEED})`, () => {
  beforeEach(() => {
    table.clear();
    applied.clear();
  });

  it('a terminal write never lands under a live status, however the progress writes are delayed', async () => {
    const rng = createRng(LOAD_SEED);
    // Progress writes slow (a new connection), terminal writes fast (an idle one).
    latency.progressMs = () => rng.int(5, 25);
    latency.terminalMs = () => rng.int(0, 3);
    const mgr = new WebRtcBridgeManager(guardHost() as never, null);

    const ids: string[] = [];
    for (let i = 0; i < CALLS; i++) {
      const record = await mgr.createBridgedCall({
        tenantId: 't1', accountId: 'a1', callerId: '+919800000001', destinationPhone: '+919800000002',
        browserSocket: station() as never, correlation: { kind: 'attempt' as const, campaignId: 'camp', agencyAttemptId: `att-${i}` },
      });
      ids.push(record.id);
    }

    const answeredAt = new Date(Date.now() - 2_000).toISOString();
    await Promise.all(ids.map((id) => {
      const terminal = rng.pick([
        { event: 'call.completed', call: { id: `vl-${id}`, callStatus: 'ANSWERED', answeredAt, durationSec: 2 } },
        { event: 'call.ended', call: { id: `vl-${id}`, status: 'ended', hangupCause: '16', sipStatus: '200', answeredAt } },
      ]);
      const bodies = rng.shuffle([
        { event: 'call.ringing', call: { id: `vl-${id}`, status: 'ringing' } },
        { event: 'call.answered', call: { id: `vl-${id}`, status: 'answered', answeredAt } },
        terminal,
      ]);
      // All three at once, as concurrent webhook requests.
      return Promise.all(bodies.map((b) => mgr.handleVoicelinkStatus(id, parseVoicelinkWebhook(b, id)!)));
    }));
    // Let every in-flight write apply.
    await new Promise((r) => setTimeout(r, 100));

    const bad = ids.filter((id) => {
      const seq = applied.get(id) ?? [];
      const firstTerminal = seq.findIndex((s) => TERMINAL.has(s));
      return firstTerminal < 0 || seq.slice(firstTerminal).some((s) => !TERMINAL.has(s));
    });
    expect(bad.map((id) => ({ id, applied: applied.get(id) })), `seed ${LOAD_SEED}`).toEqual([]);
    for (const id of ids) expect(table.get(id)!['status']).toBe('completed');
    expect(mgr.getActiveCount()).toBe(0);
  });
});

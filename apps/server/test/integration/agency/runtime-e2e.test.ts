import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * the runtime end to end — the one test that owns the seam
 * between the voice engine, the agency repository and domain, analysis (via its
 * seam) and the runtime: a single process holding all four.
 *
 * Everything is real except the carrier:
 *   - the app is `buildApp` with a real context, listening on loopback, so the agent's
 *     station socket is a REAL WebSocket upgrade through `@fastify/websocket` into
 *     `agencyPlugin` → `registerStationSocket` → `handleStationSocket`;
 *   - the process background work is booted the way `src/index.ts` does it: the
 *     `startVoice` (the bridge's startup self-heal) THEN `bootstrap/agency.ts`'s
 *     `startAgency`, so the startup reaper, the pacing supervisor (2s) and its 250ms tick
 *     run on their own timers; teardown runs the stops in reverse (agency, then voice —
 *     the order itself is pinned by `runtime-boot-order.test.ts`);
 *   - the bridge is the real `WebRtcBridgeManager` and guard host over real Redis
 *     (6383, this worktree's db) and real Postgres (5436);
 *   - analysis is the real worker and `createBridgeAnalysisHooks()`, registered on the
 *     seam by `bootstrap/analysis.ts`'s `startAnalysis`, booted after `startAgency` as
 *     `src/index.ts` does;
 *   - ONLY the carrier is faked: `TelephonyProviderRegistry` returns a stub VoiceLink
 *     adapter (as `integration/core/voice-engine.test.ts` does), and the PSTN
 *     leg / carrier webhook are driven through the bridge's own entry points
 *     (`attachPstnLeg` + VoiceLink `start`, `handleVoicelinkStatus` `call.ended`).
 *
 * The station socket is at the console's path, `/proxy/agency/station/:sessionId`; the two
 * upgrades below use it.
 *
 * The two steps with HTTP routes (`POST /sessions/:id/available`,
 * `POST /attempts/:id/disposition`) are driven through exactly the runtime and repository
 * calls the handlers make, so the runtime is exercised the way those routes exercise it.
 */

// A real meter provider, installed before any product module creates its instruments,
// so the completion notice's `agency_campaign_notifications_total` can be read back.
const { metricReader } = await vi.hoisted(async () => {
  const { installMetricReader } = await import('../../helpers/otel-metric-reader.js');
  return { metricReader: installMetricReader() };
});

vi.hoisted(() => {
  process.env['FF_AGENCY_DIALER'] = 'true';
  process.env['FF_AGENCY_CALL_ANALYSIS'] = 'true';
  process.env['DIALER_ANALYSIS_ENABLED'] = 'true';
  process.env['DIALER_TRANSCRIBE_API_KEY'] = 'e2e-not-a-real-key';
  // `startAnalysis` wires the worker (and the bridge hooks) only when both a transcriber
  // and the post-call analysis service are constructible. No vendor is ever called: the
  // job waits for a recording that never lands.
  process.env['POST_CALL_ANALYSIS_ENABLED'] = 'true';
  process.env['POST_CALL_ANALYSIS_API_KEY'] = 'e2e-not-a-real-key';
  process.env['DIALER_ANALYSIS_MIN_TALK_TIME_SECONDS'] = '0';
  process.env['MAX_CONCURRENT_CALLS'] = '5';
  process.env['VOICELINK_WEBHOOK_BASE_URL'] = 'https://agency.test/api/v1/webhooks/voicelink';
});

const { fakeAdapter } = vi.hoisted(() => ({
  fakeAdapter: {
    name: 'voicelink',
    capabilities: { cancelRinging: false, queuesOutboundDials: true },
    initiateCall: vi.fn(async (req: { callId: string }) => ({ providerCallId: `carrier-${req.callId}` })),
    endCall: vi.fn(async () => undefined),
  },
}));
vi.mock('../../../src/telephony/factory.js', () => ({
  TelephonyProviderRegistry: class {
    get() { return fakeAdapter; }
  },
}));

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { closePool, getPool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL, closeTestPool, getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { uuidFor } from '../../../../../packages/db/test/integration/setup/factories.js';
import { closeTestRedis, flushTestRedis, getTestRedis } from '../../helpers/test-redis.js';
import { insertAgencyCampaign, insertAgencyContact } from './agency-factories.js';
import { config } from '../../../src/config/index.js';
import { buildApp } from '../../../src/app.js';
import type { AppContext } from '../../../src/app-context.js';
import { getAgencyRuntime, resetAgencyRuntimeForTests, startAgency } from '../../../src/bootstrap/agency.js';
import { getVoiceEngine, resetVoiceEngineForTests, startVoice } from '../../../src/bootstrap/voice.js';
import { startAnalysis } from '../../../src/bootstrap/analysis.js';
import { collectMetric } from '../../helpers/otel-metric-reader.js';
import {
  agencyAgentSessionRepository,
  agencyAttemptRepository,
  agencyContactRepository,
} from '../../../src/db/repositories/agency.repository.js';
import { resolveDisposition, validateDispositionFields } from '../../../src/agency/disposition.js';
import { resolveDispositionDecision } from '../../../src/agency/disposition-policy.js';
import { AGENT_LEASE_MS } from '../../../src/agency/agent-state-machine.js';

const TENANT = uuidFor('runtime-e2e-tenant');
const ACCOUNT = uuidFor('runtime-e2e-account');
const AGENT_USER = uuidFor('runtime-e2e-agent');

/** The carrier's media socket: records what the bridge sends it, emits what VoiceLink would. */
class FakePstnSocket extends EventEmitter {
  readyState = 1;
  OPEN = 1;
  readonly sent: Array<Record<string, unknown>> = [];
  send(raw: string): void { this.sent.push(JSON.parse(raw) as Record<string, unknown>); }
  close(): void { this.readyState = 3; this.emit('close'); }
}

async function waitFor<T>(what: string, probe: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 15_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const v = await probe();
    if (v) return v as T;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('agency runtime end to end — real app, real bridge, fake carrier (integration)', () => {
  let app: FastifyInstance;
  let stopAgency: (() => Promise<void>) | null = null;
  let stopVoice: (() => Promise<void>) | null = null;
  let stopAnalysis: (() => Promise<void>) | null = null;
  let station: WebSocket | null = null;
  const frames: Array<Record<string, unknown>> = [];
  let liveSessionId: string | null = null;

  beforeAll(async () => {
    initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 6 });
    await truncateAll();
    await flushTestRedis();
    resetVoiceEngineForTests();
    await resetAgencyRuntimeForTests();
  });

  afterAll(async () => {
    // Close the station and let the server's close handler finish (Redis `offline`, then
    // the DB mirror) BEFORE anything is torn down — otherwise it runs after
    // `closePool()` / `closeTestRedis()` and logs "Connection is closed" / "pool not
    // initialized" into the next file's output.
    if (station && station.readyState !== WebSocket.CLOSED) {
      const closed = new Promise<void>((resolve) => station!.once('close', () => resolve()));
      station.close();
      await closed;
    }
    if (liveSessionId) {
      const id = liveSessionId;
      await waitFor('station close handled', async () => {
        const { rows } = await getTestPool().query<{ state: string }>(
          'SELECT state FROM agency_agent_sessions WHERE id = $1', [id]);
        return rows[0]?.state === 'offline';
      }).catch(() => undefined);
    }
    // index.ts's shutdown: the stops in reverse — analysis, agency, then voice (bridge drain).
    if (stopAnalysis) await stopAnalysis();
    if (stopAgency) await stopAgency();
    if (stopVoice) await stopVoice();
    await app?.close();
    await resetAgencyRuntimeForTests();
    resetVoiceEngineForTests();
    await closePool();
    await closeTestPool();
    await closeTestRedis();
  });

  it('session → ready → reservation → bridged call → disposition → wrap-up → analysis enqueued → attempt ended', async () => {
    // ── The campaign and its one contact. `record_calls` so the bridge requests a
    //    recording (analysis gate 6, consent); a non-empty catalog so a connected call
    //    owes a disposition and opens a wrap-up. ─────────────────────────────────────
    const campaign = await insertAgencyCampaign({
      tenant_id: TENANT,
      account_id: ACCOUNT,
      status: 'running',
      record_calls: true,
      wrapup_seconds: 60,
      wrapup_auto_return: true,
      disposition_catalog: JSON.stringify([{ code: 'interested', label: 'Interested', is_success: true, terminal: true }]),
    });
    const contact = await insertAgencyContact(campaign.id, { tenant_id: TENANT, account_id: ACCOUNT, phone_e164: '+919812345678' });

    // ── Boot: the app (station socket mounted by agencyPlugin), then index.ts's
    //    bootstrap sequence — voice, then agency. ──────────────────────────────────
    const ctx: AppContext = { config, pool: getPool(), redis: getTestRedis() };
    app = await buildApp({ ctx });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    stopVoice = await startVoice(ctx);
    const engine = getVoiceEngine();
    expect(engine).not.toBeNull();
    stopAgency = await startAgency(ctx);
    stopAnalysis = await startAnalysis(ctx);
    const runtime = getAgencyRuntime()!;
    expect(runtime).not.toBeNull();
    // The bridge the runtime dials through is the voice engine's, not a second one.
    expect(getVoiceEngine()).toBe(engine);

    // ── 1. Session → ready, over the real station socket. ────────────────────────
    // `joinOrRehydrate` is what `POST /sessions` calls.
    const join = await agencyAgentSessionRepository.joinOrRehydrate({
      tenantId: TENANT, accountId: ACCOUNT, campaignId: campaign.id,
      agentUserId: AGENT_USER, replicaId: runtime.replicaId,
    });
    if (!join.ok) throw new Error('join refused');
    const sessionId = join.session.id;
    liveSessionId = sessionId;
    const { token } = await runtime.tokens.mint(sessionId);

    // A wrong token is refused before anything else (4401), proving the gate is live.
    const refused = new WebSocket(`ws://127.0.0.1:${port}/proxy/agency/station/${sessionId}?token=wrong`);
    const refusedCode = await new Promise<number>((resolve) => refused.on('close', (code) => resolve(code)));
    expect(refusedCode).toBe(4401);

    station = new WebSocket(`ws://127.0.0.1:${port}/proxy/agency/station/${sessionId}?token=${token}`);
    station.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as Record<string, unknown>));
    const ready = await waitFor('ready', () => frames.find((f) => f['event'] === 'ready'));
    // No live lease ⇒ `break`, never `available` (`rehydrateAgent`).
    expect(ready['state']).toBe('break');
    expect(runtime.stations.isLocallyOwned(sessionId)).toBe(true);

    // The agent goes available — the `/sessions/:id/available` handler body.
    runtime.wrapup.cancel(sessionId, 'agent_returned');
    await runtime.agents.set(sessionId, 'available', { leaseMs: AGENT_LEASE_MS.available });
    await agencyAgentSessionRepository.setState(sessionId, 'available');

    // ── 2. A reservation, and the panel BEFORE the dial. ─────────────────────────
    const reserved = await waitFor('reserved frame', () => frames.find((f) => f['event'] === 'reserved'));
    const attemptId = (reserved['attempt'] as { attempt_id: string }).attempt_id;
    expect((reserved['attempt'] as { contact_id: string }).contact_id).toBe(contact.id);
    await waitFor('carrier dial', () => fakeAdapter.initiateCall.mock.calls.length > 0);
    const dialRequest = fakeAdapter.initiateCall.mock.calls[0]![0] as unknown as { to: string; from: string };
    expect(dialRequest.to).toBe('+919812345678');
    expect(dialRequest.from).toBe('+919000000001');

    const callId = await waitFor('the bridged call row', async () => {
      const a = await agencyAttemptRepository.findById(attemptId);
      return a?.webrtc_call_id ?? null;
    });
    const dialing = await agencyAttemptRepository.findById(attemptId);
    expect(dialing!.reserved_agent_id).toBe(sessionId);
    expect(dialing!.dialed_at).not.toBeNull();

    // ── 3. The carrier answers and media bridges (VoiceLink `start` on the PSTN leg). ─
    const bridge = getVoiceEngine()!.bridge;
    const pstn = new FakePstnSocket();
    expect(bridge.attachPstnLeg(callId, pstn as unknown as never)).toBe(true);
    pstn.emit('message', JSON.stringify({
      event: 'start',
      start: { call_sid: `carrier-${callId}`, stream_sid: 's1', media_format: { encoding: 'audio/alaw', sample_rate: '8000' } },
    }));

    const bridgedFrame = await waitFor('bridged frame', () => frames.find((f) => f['event'] === 'bridged'));
    // `reserved` reached the console strictly before `bridged`.
    expect(frames.findIndex((f) => f['event'] === 'reserved')).toBeLessThan(frames.indexOf(bridgedFrame));
    const live = await waitFor('attempt bridged', async () => {
      const a = await agencyAttemptRepository.findById(attemptId);
      return a?.state === 'bridged' && a.bridged_at ? a : null;
    });
    expect(live.answered_at).not.toBeNull();
    expect((await runtime.agents.get(sessionId))?.state).toBe('on_call');

    // ── The customer hangs up: the carrier's `call.ended`. ───────────────────────
    await bridge.handleVoicelinkStatus(callId, {
      providerCallId: `carrier-${callId}`, callId, eventType: 'hangup', timestamp: new Date(),
      metadata: { event: 'call.ended', call: { id: `carrier-${callId}`, status: 'ended' } },
    } as never);

    // ── 4/5. Wrap-up opens (a disposition is owed), then the disposition closes it. ─
    const wrapupFrame = await waitFor('wrapup frame', () => frames.find((f) => f['event'] === 'wrapup'));
    expect((wrapupFrame['wrapup'] as { requires_disposition: boolean }).requires_disposition).toBe(true);
    expect(frames.find((f) => f['event'] === 'released')).toBeTruthy();
    expect((await runtime.agents.get(sessionId))?.state).toBe('wrapup');
    const ended = await agencyAttemptRepository.findById(attemptId);
    expect(ended!.state).toBe('ended');
    expect(ended!.outcome).toBe('connected');
    expect(ended!.wrapup_started_at).not.toBeNull();

    // The `/attempts/:id/disposition` handler body.
    const resolved = resolveDisposition(campaign.disposition_catalog, 'interested');
    if (!resolved.ok) throw new Error('catalog did not resolve');
    const fields = validateDispositionFields(resolved.entry, {}, new Date());
    if (!fields.ok) throw new Error('fields did not validate');
    const recorded = await agencyAttemptRepository.recordDisposition({
      attemptId, dispositionCode: resolved.entry.code, notes: fields.notes,
      callbackAt: fields.callbackAt, actorUserId: AGENT_USER, onBehalf: false,
    });
    expect(recorded).not.toBeNull();
    const decision = resolveDispositionDecision(resolved.entry, { now: new Date(), attemptsUsed: 0, callbackAt: null });
    await agencyContactRepository.markState(contact.id, decision.contactState, {
      last_outcome: ended!.outcome, last_disposition: resolved.entry.code,
    });
    expect(await runtime.wrapup.noteDisposition(sessionId, attemptId)).toBe(true);

    await waitFor('agent back to available', async () =>
      (await runtime.agents.get(sessionId))?.state === 'available'
      && frames.some((f) => f['event'] === 'agent_state' && f['state'] === 'available'));

    // ── 7. The attempt row ends with the whole record. ──────────────────────────
    const final = await waitFor('wrap-up end persisted', async () => {
      const a = await agencyAttemptRepository.findById(attemptId);
      return a?.wrapup_ended_at ? a : null;
    });
    expect(final.state).toBe('ended');
    expect(final.outcome).toBe('connected');
    expect(final.disposition_code).toBe('interested');
    expect(final.wrapup_resolution).toBe('disposition_submitted');
    expect(final.ended_at).not.toBeNull();
    expect(final.bridged_at!.getTime()).toBeGreaterThanOrEqual(final.answered_at!.getTime());
    expect(final.webrtc_call_id).toBe(callId);

    // ── 6. Analysis was enqueued through seam for this call. ───────────────
    const job = await waitFor('analysis job', async () => {
      const { rows } = await getTestPool().query<{ status: string; tenant_id: string }>(
        'SELECT status, tenant_id FROM dialer_analysis_jobs WHERE call_id = $1', [callId]);
      return rows[0] ?? null;
    });
    // No recording URL has landed yet, so the job waits for it (the analysis status rule).
    expect(job.status).toBe('awaiting_recording');
    expect(job.tenant_id).toBe(TENANT);
    const { rows: [call] } = await getTestPool().query<{ campaign_id: string; agency_attempt_id: string; recording_requested: boolean }>(
      'SELECT campaign_id, agency_attempt_id, recording_requested FROM agency_calls WHERE id = $1', [callId]);
    expect(call!.campaign_id).toBe(campaign.id);
    expect(call!.agency_attempt_id).toBe(attemptId);
    expect(call!.recording_requested).toBe(true);

    // ── The list ran out: the leader finalizes the campaign and tells the floor. ──
    const done = await waitFor('campaign completed', async () => {
      const { rows } = await getTestPool().query<{ status: string }>('SELECT status FROM agency_campaigns WHERE id = $1', [campaign.id]);
      return rows[0]?.status === 'completed' ? rows[0] : null;
    });
    expect(done.status).toBe('completed');
    await waitFor('list_exhausted frame', () =>
      frames.find((f) => f['event'] === 'campaign_state' && f['reason'] === 'list_exhausted'));

    // ── The supervisors' completion notice ran — and has SETTLED, so the
    //    fire-and-forget is drained before teardown closes the pool. One series for this
    //    tenant, counted once (the leader's won transition is the single writer). ────
    const notices = await waitFor('completion notice counted', async () => {
      const points = (await collectMetric(metricReader, 'agency_campaign_notifications_total'))
        .filter((p) => p.attributes['tenant_id'] === TENANT);
      return points.length > 0 ? points : null;
    });
    await waitFor('completion notice settled', () => runtime.pacing.pendingNoticeCount() === 0);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.value).toBe(1);
    expect(notices[0]!.attributes['result']).not.toBe('threw');
  }, 60_000);
});

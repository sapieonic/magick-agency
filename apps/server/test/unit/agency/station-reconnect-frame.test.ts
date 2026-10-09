import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';

// ---------------------------------------------------------------------------
// The `ready` frame — what a reconnecting console is told, and what it was not.
//
// ── The gap, found from both sides ─────────────────────────────────────────
//
// A queued break is announced exactly twice: on the HTTP response that queued it,
// and on the `agent_state` frame emitted beside it. Both die with the socket. The
// next authoritative `agent_state` the agent gets is the one `releaseAgent` sends
// at the END of wrap-up — by which point the break has already been APPLIED.
//
// So an agent who queued a break mid-call and then lost their socket reconnected
// to a `ready` frame carrying their state, their live attempt or their wrap-up
// countdown, and no mention of the break — and were then pulled out of the pool by
// a request their console had forgotten making. The console side saw the same hole
// (a reconnect during wrap-up renders no pending-break badge) and the server side
// found it here. It is one gap.
//
// ── Why this file drives the REAL socket ──────────────────────────────────
//
// `handleStationSocket` is not exported, and that is right — it is transport. The
// frame is therefore asserted the only way it can be honestly: by opening the
// route's WebSocket through `injectWS` and reading what `StationRegistry.send` is
// handed. A test that called a lifted-out helper would prove the helper.
//
// The break registry is the REAL `BreakRegistry`, because "peeked, never taken" is
// half of what is being pinned and a double would let a `take()` pass.
//
// FALSIFICATION recorded per group.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/config/index.js', () => ({
  config: {
    redis: { keyPrefix: '' },
    telephony: { vobiz: { webhookBaseUrl: 'https://core.test/api/v1/webhooks/vobiz' } },
  },
}));

vi.mock('../../../src/api/middleware/auth.middleware.js', () => ({
  authMiddleware: vi.fn(async () => { /* authenticated */ }),
  getTenantId: () => 't1',
  getAccountId: () => 'a1',
}));

const { flags } = vi.hoisted(() => ({ flags: { isEnabled: vi.fn().mockResolvedValue(true) } }));
vi.mock('../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => flags,
  FLAGS: { agency_dialer_enabled: { key: 'agency_dialer_enabled', default: false } },
}));

const { repos } = vi.hoisted(() => ({
  repos: {
    attempt: { findById: vi.fn(), setState: vi.fn().mockResolvedValue(null) },
    campaign: { findById: vi.fn() },
    contact: { findById: vi.fn(), markState: vi.fn(), unclaim: vi.fn() },
    session: { findById: vi.fn(), setState: vi.fn().mockResolvedValue(undefined), leave: vi.fn() },
  },
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyAttemptRepository: repos.attempt,
  agencyCampaignRepository: repos.campaign,
  agencyContactRepository: repos.contact,
  agencyAgentSessionRepository: repos.session,
}));

// The station handler lives in `agency/station-socket.ts` (`registerStationSocket`), mounted below at the same prefix.
import { registerStationSocket } from '../../../src/agency/station-socket.js';
import { BreakRegistry } from '@magick-agency/domain/break-manager';

const SESSION = {
  id: 'sess-1', agent_user_id: 'u-agent', campaign_id: 'camp-1',
  tenant_id: 't1', account_id: 'a1', state: 'wrapup', left_at: null,
};

const WRAPUP_STATE = {
  attempt_id: 'att-1', ends_at: '2026-08-12T10:00:30.000Z', seconds_total: 30,
  auto_return: true, requires_disposition: true, disposition_submitted: false,
  held_reason: null,
};

interface Harness {
  app: FastifyInstance;
  breaks: BreakRegistry;
  /** Every frame `handleStationSocket` handed to the registry. */
  sent: any[];
  wrapupState: { value: typeof WRAPUP_STATE | null };
  activeAttempt: { value: unknown };
}

async function harness(): Promise<Harness> {
  const breaks = new BreakRegistry();
  const sent: any[] = [];
  const wrapupState = { value: null as typeof WRAPUP_STATE | null };
  const activeAttempt = { value: null as unknown };
  /** What `attach` last registered — see the `stations` double below. */
  const holder: { ws: unknown } = { ws: undefined };

  const runtime = {
    replicaId: 'r1',
    agents: { get: vi.fn().mockResolvedValue({ state: 'wrapup', attemptId: 'att-1', since: 1 }), set: vi.fn(), clear: vi.fn(), renew: vi.fn() },
    wrapup: { stateFor: vi.fn(() => wrapupState.value), noteDisposition: vi.fn() },
    /**
     * STATEFUL, because `socketFor` answers an identity question and a constant
     * cannot answer one.
     *
     * This was `socketFor: () => undefined`, commented as "nothing else holds this
     * session". That reading is the CLOSE handler's — it asks whether someone else
     * has taken over — and it is the wrong reading for every other caller. The
     * route's `stillOurs` fence asks the opposite question, "am *I* still the
     * holder", and a constant `undefined` answers no to it forever, so the double
     * silently withheld `ready` from every test in this file the moment that fence
     * landed. A double that cannot distinguish "nobody" from "somebody else" cannot
     * be used to test a guard whose whole job is that distinction.
     *
     * Tracking what `attach` was handed is three lines and makes both readings
     * true at once, so a test that wants a supersede can stage one by reassigning
     * `holder.ws` rather than by defeating the guard.
     */
    stations: {
      attach: vi.fn(async (entry: any) => { holder.ws = entry.ws; }),
      detach: vi.fn(async (_id: string, ws?: unknown) => {
        // Identity-scoped exactly as the real one is: a superseded socket's detach
        // must not evict the socket that replaced it.
        if (ws === undefined || holder.ws === ws) holder.ws = undefined;
      }),
      heartbeat: vi.fn().mockResolvedValue(true),
      isLocallyOwned: vi.fn(() => true),
      socketFor: vi.fn(() => holder.ws),
      silentSince: vi.fn(() => []),
      // Honours `expectedWs` like the real one, so a mis-scoped send shows up here
      // as a missing frame rather than passing quietly.
      send: vi.fn((_id: string, frame: any, expectedWs?: unknown) => {
        if (expectedWs !== undefined && holder.ws !== expectedWs) return false;
        sent.push(frame);
        return true;
      }),
    },
    dialer: {
      reattachStation: vi.fn(() => activeAttempt.value),
      takeMissedRelease: vi.fn(() => null),
      hasLiveAttempt: vi.fn(() => false),
      // Arms the pre-bind grace for an unannounced dial. Reached SYNCHRONOUSLY from
      // the station socket's `close` handler, BEFORE it awaits anything — so a
      // double without it throws a TypeError inside that handler. Vitest still
      // reports every assertion as passing and exits NON-ZERO on the unhandled
      // error: a green-looking local run and a red CI job.
      noteStationClosed: vi.fn(),
      hangupAttempt: vi.fn(),
    },
    breaks,
    tokens: { mint: vi.fn(), verifyAndConsume: vi.fn().mockResolvedValue(true) },
    wakeStationSweep: vi.fn(),
    rehydrateAgent: vi.fn().mockResolvedValue('wrapup'),
    releaseStationOnClose: vi.fn().mockResolvedValue(false),
  };

  const app = Fastify();
  await app.register(websocket);
  await app.register(async (a) => registerStationSocket(a as never, runtime as never), { prefix: '/api/v1/agency' });
  await app.ready();
  return { app, breaks, sent, wrapupState, activeAttempt };
}

/** Open the station socket and return the `ready` frame it produced. */
async function ready(h: Harness): Promise<any> {
  const ws = await h.app.injectWS('/api/v1/agency/station/sess-1?token=tok');
  await vi.waitFor(() => expect(h.sent.some((f) => f.event === 'ready')).toBe(true));
  ws.terminate();
  return h.sent.find((f) => f.event === 'ready');
}

let h: Harness;

beforeEach(async () => {
  vi.clearAllMocks();
  repos.session.findById.mockResolvedValue(SESSION);
  h = await harness();
});

afterEach(async () => { await h.app.close(); });

describe('a reconnect is told about the break it queued before the drop', () => {
  it('carries pending_state/pending_break_reason on `ready` during wrap-up', async () => {
    // FALSIFIED: with the two fields removed from the frame this reds, which is the
    // state the reviewers found — and `releaseAgent` still applies the break, so the
    // console and the pool disagree for the whole wrap-up window.
    h.wrapupState.value = WRAPUP_STATE;
    h.breaks.queue('sess-1', { code: 'lunch', label: 'Lunch' });

    const frame = await ready(h);

    expect(frame.state).toBe('wrapup');
    expect(frame.active_wrapup).toEqual(WRAPUP_STATE);
    expect(frame.pending_state).toBe('break');
    expect(frame.pending_break_reason).toBe('lunch');
  });

  it('PEEKS — the reconnect must not consume the break it reports', async () => {
    // The `take()` hazard, from the one place a reader would be tempted to use it:
    // a break applies exactly once, in `releaseAgent`, so consuming it to render a
    // badge would drop it and leave the agent `available` and instantly redialed.
    h.wrapupState.value = WRAPUP_STATE;
    h.breaks.queue('sess-1', { code: 'lunch', label: 'Lunch' });

    await ready(h);

    expect(h.breaks.peek('sess-1')).toEqual({ code: 'lunch', label: 'Lunch' });
  });

  it('reports it on an ATTEMPT reconnect too, not only a wrap-up one', async () => {
    // A break can be queued from `reserved` and `on_call` as well (`breakMustWait`),
    // and those reconnects arrive with `active_attempt` and no `active_wrapup`.
    // Hanging the fields off the wrap-up branch would cover one of three states.
    h.activeAttempt.value = { attempt_id: 'att-1', bridged_at: null, state: 'ringing' };
    h.breaks.queue('sess-1', { code: 'technical_issue', label: 'Technical issue' });

    const frame = await ready(h);

    expect(frame.active_attempt).toBeTruthy();
    expect(frame.active_wrapup).toBeUndefined();
    expect(frame.pending_state).toBe('break');
    expect(frame.pending_break_reason).toBe('technical_issue');
  });

  it('omits both fields entirely when nothing is queued', async () => {
    // `undefined` means "nothing queued" on this frame exactly as it does on
    // `agent_state`. An always-present field with a null value is one a console
    // eventually renders as an empty badge.
    h.wrapupState.value = WRAPUP_STATE;

    const frame = await ready(h);

    expect('pending_state' in frame).toBe(false);
    expect('pending_break_reason' in frame).toBe(false);
  });
});

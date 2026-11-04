import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// `abandon_reason` and the seat-time series, at the DIAL SITE.
//
// `abandonment-predicate.test.ts` owns whether an attempt IS abandoned. This
// file owns the question that had no answer at all before 2026-09-10: **why**.
// Until it did, a bind failure and a genuine no-agent-free abandonment were the
// same increment in `agency_abandoned_total` and the same row in
// `agency_call_attempts` — and they call for opposite responses during a staged
// rollout (roll the flag back, versus slow the pacing down).
//
// Two properties here are easy to lose and neither is visible in a type:
//
//  1. **NULL means "not an abandoned attempt", not "cause unknown".** `setState`
//     writes the column through `COALESCE`, so passing a value on a
//     non-abandoned settle would be a claim that could never be cleared.
//  2. **The reason counter must track the compliance counter.** They are
//     deliberately separate series (labelling the live one terminates it), which
//     means nothing structural keeps them in step — only this test.
//
// A separate file rather than an extension of `canceled-outcome-ledger.test.ts`
// because that file's whole subject is which LEDGER pays, and per the house rule
// each file owns its own factories.
//
// The metrics module is deliberately NOT mocked, for the reason
// `abandoned-call-path.test.ts` records: the claim is about the value an export
// would actually carry, and only a real meter can support it — so one is
// installed before the metrics module loads.
//
// Harness: the metric reader is `test/helpers/otel-metric-reader.ts`, over a real
// `@opentelemetry/sdk-metrics` provider (devDependency; `ScrapeMetricReader` is inlined).
// Nothing on this path reads `config.telephony`, so the config stub leaves it empty.
// ---------------------------------------------------------------------------

const { reader } = await vi.hoisted(async () => {
  const { installMetricReader } = await import('../../helpers/otel-metric-reader.js');
  return { reader: installMetricReader() };
});

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/config/index.js', () => ({
  config: {
    redis: { keyPrefix: '' },
    telephony: {},
  },
}));

const { flags } = vi.hoisted(() => ({ flags: { lateBinding: false } }));
vi.mock('../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => ({
    isEnabled: async (flag: { key?: string }) =>
      flag?.key === 'agency_late_binding' && flags.lateBinding,
    getValue: async () => 1800,
  }),
  FLAGS: {
    agency_late_binding: { key: 'agency_late_binding', type: 'boolean', default: false },
    webrtc_max_duration_seconds: { key: 'webrtc_max_duration_seconds', type: 'number', default: 1800 },
  },
}));

const { repos } = vi.hoisted(() => ({
  repos: {
    attempt: {
      setState: vi.fn().mockResolvedValue(null),
      attachWebrtcCall: vi.fn().mockResolvedValue(undefined),
      findPriorForContactLineage: vi.fn().mockResolvedValue([]),
    },
    contact: {
      unclaim: vi.fn().mockResolvedValue(undefined),
      // ⚠️ Resolves `true` — `markState` returns whether the REQUESTED state
      // landed, and `undefined` here would silently model a DNC refusal. It was
      // `undefined` until `markState` gained that return, and the retirement
      // test below is what caught it.
      markState: vi.fn().mockResolvedValue(true),
      chargeAttempt: vi.fn().mockResolvedValue(1),
      chargeOurFaultAttempt: vi.fn().mockResolvedValue(1),
      // The outcome-unknown hold (`holdOutcomeUnknownContact`): one statement, the hold and
      // the our-fault charge. Resolves the state that landed.
      requeueOrphaned: vi.fn().mockResolvedValue({ state: 'pending', our_fault_attempts: 1 }),
    },
    session: { setState: vi.fn().mockResolvedValue(undefined) },
    // The pacing history's single-row write: an our-fault retirement is counted there too (IN2).
    insightsPacing: { addToMinute: vi.fn().mockResolvedValue(undefined) },
  },
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyAttemptRepository: repos.attempt,
  agencyContactRepository: repos.contact,
  agencyCampaignRepository: {},
  agencyAgentSessionRepository: repos.session,
  agencyInsightsPacingRepository: repos.insightsPacing,
}));

import { AgencyDialer, DIAL_OUTCOME_UNKNOWN_REDIAL_DELAY_MS, PRE_CARRIER_FAILURE_REDIAL_DELAY_MS } from '../../../src/agency/agency-dialer.js';
import { WebRtcCallError } from '../../../src/core/webrtc-bridge-manager.js';
import { CarrierRequestTimeoutError } from '../../../src/telephony/carrier-errors.js';
import { OUR_FAULT_REDIAL_BOUND } from '../../../src/agency/retry-policy.js';
import { AgentStateMachine, AGENT_LEASE_MS } from '../../../src/agency/agent-state-machine.js';
import { StationRegistry } from '../../../src/agency/station-registry.js';
import { collectMetric } from '../../helpers/otel-metric-reader.js';
import { AGENCY_ABANDON_REASONS } from '@magick-agency/contracts/agency';
import { ABANDONMENT_BRIDGE_GRACE_MS } from '@magick-agency/domain/abandonment-predicate';
import type { DialCommand } from '../../../src/agency/dial-dispatcher.js';

/**
 * A counter/histogram child's live value.
 *
 * The meter is process-global and this file settles several attempts on one
 * campaign, so every assertion below is a DELTA across one settle rather than an
 * absolute — an absolute would pass or fail depending on test order, which is
 * the classic way a metrics assertion becomes decorative.
 */
async function seriesValue(name: string, labels: Record<string, string>): Promise<number> {
  const points = await collectMetric(reader, name);
  return points.find((p) => Object.entries(labels).every(([k, val]) => p.attributes[k] === val))?.value ?? 0;
}

/**
 * A histogram's observation COUNT for one label set (the `_count` child).
 *
 * EXACT label-set match, not a subset: the agency histograms deliberately carry
 * no `campaign_id` (series cost — see metrics.ts), and a subset match would keep
 * passing if someone re-added it. Pass the complete label set.
 */
async function histogramCount(name: string, labels: Record<string, string>): Promise<number> {
  const want = Object.keys(labels).sort().join(',');
  const points = await collectMetric(reader, name);
  return points.find((p) =>
    Object.keys(p.attributes).sort().join(',') === want
    && Object.entries(labels).every(([k, val]) => p.attributes[k] === val))?.count ?? 0;
}

/** Every series of `name`, keyed by its full attribute set — for exact-label and "nothing at all" deltas. */
async function snapshotSeries(name: string): Promise<Map<string, number>> {
  const points = await collectMetric(reader, name);
  return new Map(points.map((p) => [JSON.stringify(Object.entries(p.attributes).sort()), p.count ?? p.value]));
}

/** What changed in `name` between two snapshots: `{ attrs, by }` per series that moved. */
function seriesDelta(before: Map<string, number>, after: Map<string, number>): Array<{ attrs: Record<string, unknown>; by: number }> {
  const out: Array<{ attrs: Record<string, unknown>; by: number }> = [];
  for (const [key, value] of after) {
    const by = value - (before.get(key) ?? 0);
    if (by !== 0) out.push({ attrs: Object.fromEntries(JSON.parse(key) as Array<[string, unknown]>), by });
  }
  return out;
}

function fakeWrapup() {
  return {
    enter: vi.fn(async () => false),
    cancel: vi.fn(),
    force: vi.fn(async () => false),
    stateFor: vi.fn(() => null),
    noteDisposition: vi.fn(async () => false),
    stop: vi.fn(),
    active: vi.fn(() => 0),
  };
}

function fakeBreaks() {
  return {
    queue: vi.fn(), peek: vi.fn(() => null), take: vi.fn(() => null),
    cancel: vi.fn(), size: vi.fn(() => 0),
  };
}

function fakeWs() {
  return {
    readyState: 1,
    OPEN: 1,
    sent: [] as any[],
    send(s: string) { this.sent.push(JSON.parse(s)); },
    on() { /* the bridge attaches its own listeners */ },
    off() { /* ditto */ },
    close() { this.readyState = 3; },
  };
}

function fakeBridge() {
  const listeners: Array<(e: any) => void> = [];
  const emitSync = (ev: any) => { for (const l of listeners) l(ev); };
  return {
    onLifecycle(fn: (e: any) => void) { listeners.push(fn); return () => { /* noop */ }; },
    createBridgedCall: vi.fn(async () => ({ id: 'call-1' } as any)),
    createUnboundBridgedCall: vi.fn(async () => ({ id: 'call-1' } as any)),
    /**
     * ⚠️ Emits `bridged` **synchronously** on success, exactly as the real one
     * does via `emitBridgedIfLive`.
     *
     * Not decoration. Without it a successful bind leaves `live.bridgedAt` null,
     * the settle site's predicate correctly calls that an abandoned call, and the
     * "a successful bind writes no reason" control below fails against perfectly
     * good code — the double, not the implementation, having manufactured an
     * abandonment. The re-entrancy is also the property the production ordering
     * comment depends on, so a double that skips it tests a different function.
     */
    bindBorrowedBrowserLeg: vi.fn((correlationId: string, _ws: unknown) => {
      emitSync({
        callId: 'call-1', correlationId, phase: 'bridged',
        answered: true, answeredAt: new Date(),
      });
      return true;
    }),
    /**
     * One deterministic macrotask yield rather than `vi.waitFor`. Several
     * assertions here are negative ("no reason was written"), and a polling wait
     * lets those pass by looking too early — which would leave a spurious
     * `abandon_reason` on every connected call and the suite green.
     */
    async emit(ev: any) {
      emitSync(ev);
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

const CAMPAIGN = {
  id: 'camp-1', name: 'Q3 Renewals', tenant_id: 't1', account_id: 'a1',
  telephony_provider: 'voicelink', record_calls: false,
  analysis_profile_id: null, caller_ids: ['+14155550100'],
  disposition_catalog: [],
  retry_policy: {},
} as any;

const CONTACT = {
  id: 'contact-1', phone_e164: '+919876543210',
  context: { 'First Name': 'Asha' }, attempt_count: 0,
} as any;

function makeCmd(): DialCommand {
  return {
    attemptId: 'att-1', campaignId: 'camp-1', contactId: 'contact-1',
    sessionId: 's1', ownerReplica: 'r1', tenantId: 't1', accountId: 'a1',
    callerId: '+14155550100', attemptNumber: 1,
    campaign: CAMPAIGN, contact: CONTACT,
  };
}

async function dialedWorld() {
  const bridge = fakeBridge();
  const stations = new StationRegistry(null, '', 'r1');
  const agents = new AgentStateMachine(null, '');
  vi.spyOn(agents, 'transition').mockResolvedValue(true);
  const dialer = new AgencyDialer(
    bridge as any, stations, agents, fakeWrapup() as any, fakeBreaks() as any,
  );
  dialer.start();
  const ws = fakeWs();
  await stations.attach({
    sessionId: 's1', campaignId: 'camp-1', tenantId: 't1', accountId: 'a1',
    agentUserId: 'user-1', ws: ws as any,
  });
  await dialer.executeDial(makeCmd());
  return { bridge, stations, dialer, ws };
}

/** The `abandon_reason` the `ended` write actually persisted, if any. */
function persistedReason(): string | undefined {
  return repos.attempt.setState.mock.calls
    .filter(([, state]: any[]) => state === 'ended')
    .at(-1)?.[2]?.abandon_reason;
}

function persistedOutcome(): string | undefined {
  return repos.attempt.setState.mock.calls
    .filter(([, state]: any[]) => state === 'ended')
    .at(-1)?.[2]?.outcome;
}

const LABELS = { tenant_id: 't1', campaign_id: 'camp-1' };
/** The histograms are tenant-scoped only — `campaign_id` stays on the counters. */
const HIST_LABELS = { tenant_id: 't1' };

beforeEach(() => vi.clearAllMocks());

describe('abandon_reason — the cause, on the row', () => {
  it('answered, never bridged, station fine reads `unattributed`', async () => {
    // ⚠️ This test asserted `no_agent_available` and called it "the genuine
    // no-agent shape ... all the people were busy". Both were wrong, and the test
    // ENCODED the defect rather than catching it.
    //
    // The station is attached and late binding is off, so the agent was bound at
    // dial: the customer answered, there was an agent, and media never came up.
    // That is a bridge or media failure we did not observe the cause of — not a
    // busy workforce. And nothing in a strictly 1:1 pacing engine can produce a
    // busy workforce at all, so `no_agent_available` was never reachable here.
    const world = await dialedWorld();
    await world.bridge.emit({
      callId: 'call-1', correlationId: 'att-1', phase: 'answered',
      answered: true, answeredAt: new Date(),
    });
    await world.bridge.emit({
      callId: 'call-1', correlationId: 'att-1', phase: 'ended',
      status: 'completed', outcome: 'remote_hangup', answered: true, talkTimeSeconds: 16,
    });

    expect(persistedOutcome()).toBe('abandoned');
    expect(persistedReason()).toBe('unattributed');
    expect(persistedReason(), 'a cause we never observed was asserted as a pacing problem')
      .not.toBe('no_agent_available');
  });

  it('a station lost with late binding OFF still reads `station_lost`', async () => {
    // ⚠️ THE REGRESSION GUARD FOR THE DEFAULT PATH, and the bug it pins shipped.
    //
    // `agency_late_binding` defaults to false. The first fix set the reason only
    // inside the two late-binding arms, so on the path that actually runs a
    // dropped workstation fell through to the settle-site fallback and was
    // reported as a pacing problem — the very conflation the previous review
    // round had just flagged, fixed on the branch nobody runs.
    //
    // Deliberately NOT inside the `flags.lateBinding = true` block below: the
    // whole point is that this holds with the flag off.
    const world = await dialedWorld();
    await world.stations.detach('s1');

    await world.bridge.emit({
      callId: 'call-1', correlationId: 'att-1', phase: 'answered',
      answered: true, answeredAt: new Date(),
    });
    await world.bridge.emit({
      callId: 'call-1', correlationId: 'att-1', phase: 'ended',
      status: 'completed', outcome: 'remote_hangup', answered: true, talkTimeSeconds: 4,
    });

    expect(persistedReason()).toBe('station_lost');
    expect(persistedReason(), 'a dropped workstation was reported as a pacing problem')
      .not.toBe('no_agent_available');
  });

  it('bridged OUTSIDE the grace reads `bridge_late`, not `no_agent_available`', async () => {
    // The predicate's third arm. A conversation DID happen — so calling it
    // `no_agent_available` would report a talked-to customer as one nobody
    // reached, and would send a pacing signal for a latency problem.
    const world = await dialedWorld();
    const longAgo = new Date(Date.now() - (ABANDONMENT_BRIDGE_GRACE_MS + 4_000));
    await world.bridge.emit({
      callId: 'call-1', correlationId: 'att-1', phase: 'answered',
      answered: true, answeredAt: longAgo,
    });
    await world.bridge.emit({
      callId: 'call-1', correlationId: 'att-1', phase: 'bridged',
      answered: true, answeredAt: longAgo,
    });
    await world.bridge.emit({
      callId: 'call-1', correlationId: 'att-1', phase: 'ended',
      status: 'completed', outcome: 'remote_hangup', answered: true, talkTimeSeconds: 30,
    });

    expect(persistedReason()).toBe('bridge_late');
    expect(persistedReason(), 'a bridged conversation was reported as reaching nobody')
      .not.toBe('no_agent_available');
  });

  it('writes NO reason on an attempt that is not abandoned', async () => {
    // ⚠️ The property that keeps NULL meaning "not an abandoned attempt".
    // `setState` writes this column through `COALESCE`, so a value passed here
    // could never be cleared by a later write — an attempt would carry a cause
    // for an abandonment that never happened, and `abandon_reason IS NOT NULL`
    // would quietly stop being usable for anything.
    const world = await dialedWorld();
    const answeredAt = new Date();
    await world.bridge.emit({
      callId: 'call-1', correlationId: 'att-1', phase: 'answered',
      answered: true, answeredAt,
    });
    await world.bridge.emit({
      callId: 'call-1', correlationId: 'att-1', phase: 'bridged',
      answered: true, answeredAt,
    });
    await world.bridge.emit({
      callId: 'call-1', correlationId: 'att-1', phase: 'ended',
      status: 'completed', outcome: 'remote_hangup', answered: true, talkTimeSeconds: 42,
    });

    expect(persistedOutcome()).toBe('connected');
    expect(persistedReason()).toBeUndefined();
  });

  it('writes no reason for a dial nobody ever answered', async () => {
    // A cancelled ring inconveniences nobody and is not in the denominator, so it
    // has no abandonment cause to record. Distinct from the case above: that one
    // reached somebody, this one never rang out.
    const world = await dialedWorld();
    await world.bridge.emit({
      callId: 'call-1', correlationId: 'att-1', phase: 'ended',
      status: 'canceled', outcome: 'agent_hangup', answered: false,
    });

    expect(persistedReason()).toBeUndefined();
  });

  it('every reason it can write is in the exported vocabulary', async () => {
    // The Prometheus label vocabulary and the wire contract are bounded by
    // `AGENCY_ABANDON_REASONS`, and the compile-time guard beside it only proves
    // the LIST matches the union — not that the dialer writes members of it. A
    // typo'd string literal at the settle site type-checks against `string` in
    // the patch object and would ship a label nothing renders.
    const world = await dialedWorld();
    await world.bridge.emit({
      callId: 'call-1', correlationId: 'att-1', phase: 'answered',
      answered: true, answeredAt: new Date(),
    });
    await world.bridge.emit({
      callId: 'call-1', correlationId: 'att-1', phase: 'ended',
      status: 'completed', outcome: 'remote_hangup', answered: true, talkTimeSeconds: 3,
    });

    expect(AGENCY_ABANDON_REASONS).toContain(persistedReason());
  });
});

describe('the seat-time series', () => {
  it('counts the abandonment reason in step with the compliance numerator', async () => {
    // ⚠️ THE INVARIANT THE DASHBOARD ASSERTS, and nothing structural holds it.
    // `agency_abandoned_reason_total` is deliberately a SEPARATE series rather
    // than a `reason` label on `agency_abandoned_total` — labelling the latter
    // terminates a live series that is the compliance numerator, read by the
    // auto-pause guardrail's own cross-check. The cost of that decision is that
    // the two can drift silently, and a gap means an abandon path reaching the
    // compliance counter without declaring a reason.
    const before = {
      abandoned: await seriesValue('agency_abandoned_total', LABELS),
      reasoned: await seriesValue('agency_abandoned_reason_total',
        { ...LABELS, reason: 'unattributed' }),
    };

    const world = await dialedWorld();
    await world.bridge.emit({
      callId: 'call-1', correlationId: 'att-1', phase: 'answered',
      answered: true, answeredAt: new Date(),
    });
    await world.bridge.emit({
      callId: 'call-1', correlationId: 'att-1', phase: 'ended',
      status: 'completed', outcome: 'remote_hangup', answered: true, talkTimeSeconds: 16,
    });

    const after = {
      abandoned: await seriesValue('agency_abandoned_total', LABELS),
      reasoned: await seriesValue('agency_abandoned_reason_total',
        { ...LABELS, reason: 'unattributed' }),
    };
    expect(after.abandoned - before.abandoned).toBe(1);
    expect(after.reasoned - before.reasoned,
      'the reason series drifted from the compliance numerator').toBe(1);
  });

  it('attributes hold time to the outcome that consumed it', async () => {
    // The `outcome` label is the whole value of this histogram. The pilot's
    // largest single block of dead time was busy signals, and a busy phone never
    // rings — so an unlabelled "average wait" pointed every previous analysis at
    // a ring timeout that could not have touched it.
    // `status: 'busy'` is what produces the `busy` outcome — NOT
    // `status: 'failed', outcome: 'busy'`, which classifies `failed`. Written out
    // because the first draft of this test used the second shape, passed its own
    // premise, and asserted a bucket the dialer never touches.
    const before = {
      busy: await histogramCount('agency_attempt_hold_seconds', { ...HIST_LABELS, outcome: 'busy' }),
      failed: await histogramCount('agency_attempt_hold_seconds', { ...HIST_LABELS, outcome: 'failed' }),
    };

    const world = await dialedWorld();
    await world.bridge.emit({
      callId: 'call-1', correlationId: 'att-1', phase: 'ended',
      status: 'busy', answered: false,
    });

    expect(persistedOutcome()).toBe('busy');
    expect(
      await histogramCount('agency_attempt_hold_seconds', { ...HIST_LABELS, outcome: 'busy' })
        - before.busy,
      'a settled attempt recorded no seat time',
    ).toBe(1);
    // And nothing landed under a neighbouring outcome — the label is read from
    // the CLASSIFIED outcome, not from the raw carrier status beside it.
    expect(
      await histogramCount('agency_attempt_hold_seconds', { ...HIST_LABELS, outcome: 'failed' })
        - before.failed,
    ).toBe(0);
  });

  it('records answer latency separately from the bind, so a refused bind keeps it', async () => {
    // Observed before the bind deliberately. The two failures the answer arm can
    // produce both end the call, and folding the latency observation in after
    // them would leave the ring measurement missing on exactly the attempts a
    // rollout is trying to diagnose.
    const before = await histogramCount('agency_answer_latency_seconds', HIST_LABELS);

    const world = await dialedWorld();
    await world.bridge.emit({
      callId: 'call-1', correlationId: 'att-1', phase: 'answered',
      answered: true, answeredAt: new Date(),
    });

    expect(await histogramCount('agency_answer_latency_seconds', HIST_LABELS) - before).toBe(1);
  });
});

// ===========================================================================
// Each reason, forced at its own production branch.
//
// Copilot's review was right that the vocabulary test above proves almost
// nothing: it forces ONE branch and then asserts that one value is a member of
// a four-member list. It cannot see a regression in `station_lost`,
// `bind_failed` or `bridge_late`, and the first of those was in fact WRONG when
// that test was written — the `lostTheAgent` arm wrote `no_agent_available`,
// mislabelling a dropped workstation as a pacing signal, which is the exact
// confusion this whole column exists to end. A table-driven test that forced
// the branch would have caught it; a membership assertion could not.
//
// These need late binding ON, because three of the four reasons are only
// reachable through the bind path.
// ===========================================================================
describe('each abandon reason, forced at its own branch', () => {
  beforeEach(() => { flags.lateBinding = true; });
  afterEach(() => { flags.lateBinding = false; });

  /** Answer, then settle, and report what the row and the counter said. */
  async function settle(world: Awaited<ReturnType<typeof dialedWorld>>) {
    await world.bridge.emit({
      callId: 'call-1', correlationId: 'att-1', phase: 'answered',
      answered: true, answeredAt: new Date(),
    });
    await world.bridge.emit({
      callId: 'call-1', correlationId: 'att-1', phase: 'ended',
      status: 'completed', outcome: 'remote_hangup', answered: true, talkTimeSeconds: 9,
    });
  }

  it('station gone before we reach for the socket ⇒ `station_lost`', async () => {
    // `lostTheAgent`: the station is no longer locally owned at the answer
    // instant. We HAD an agent and reserved them; their socket went away. That
    // is a workstation fact, and reporting it as `no_agent_available` would send
    // an operator to tune the dialer over a wifi drop.
    const world = await dialedWorld();
    await world.stations.detach('s1');
    const before = await seriesValue('agency_bind_total',
      { ...LABELS, result: 'station_lost' });

    await settle(world);

    expect(persistedReason()).toBe('station_lost');
    expect(persistedReason(), 'a dropped workstation was reported as a pacing problem')
      .not.toBe('no_agent_available');
    expect(await seriesValue('agency_bind_total', { ...LABELS, result: 'station_lost' })
      - before).toBe(1);
  });

  it('the reserved frame is refused ⇒ `station_lost`, sharing the label', async () => {
    // Socket still attached — so `lostTheAgent` is false — but not OPEN, so
    // `stations.send` refuses and no bind is attempted. Deliberately the SAME
    // reason as above: both mean "the station was not there", and the finer
    // split lives in the WARN line's `announced` field rather than in a label
    // whose two values an operator cannot act on differently.
    const world = await dialedWorld();
    world.ws.readyState = 3;

    await settle(world);

    expect(persistedReason()).toBe('station_lost');
  });

  it('the bridge refuses a live socket ⇒ `bind_failed`', async () => {
    // The panel reached the agent and the bind was then refused. This is the
    // one that means ROLL THE FLAG BACK, as against slowing the pacing down,
    // which is why it must not collapse into the two above.
    const world = await dialedWorld();
    world.bridge.bindBorrowedBrowserLeg.mockReturnValue(false);
    const before = await seriesValue('agency_bind_total',
      { ...LABELS, result: 'bind_failed' });

    await settle(world);

    expect(persistedReason()).toBe('bind_failed');
    expect(await seriesValue('agency_bind_total', { ...LABELS, result: 'bind_failed' })
      - before).toBe(1);
  });

  it('a successful bind writes no reason and counts as `bound`', async () => {
    // The control. Without it every assertion above would also pass against an
    // implementation that stamped a reason on every call.
    const world = await dialedWorld();
    const before = await seriesValue('agency_bind_total', { ...LABELS, result: 'bound' });

    await settle(world);

    expect(persistedReason()).toBeUndefined();
    expect(await seriesValue('agency_bind_total', { ...LABELS, result: 'bound' })
      - before).toBe(1);
  });

  /**
   * ── The rollout abort criterion, asserted rather than assumed ─────────────
   *
   * The rollout plan gates the week-long hold on "bind-latency p99 <150ms and zero bind
   * failures", and review found that **no test referenced
   * `agency_bind_latency_seconds` at all** — so the success path could stop
   * recording it, or anchor it on the wrong instant, with the suite green and a
   * rollout criterion reading as satisfied because the series was empty.
   *
   * Both halves are needed together, for the reason the metric's own help gives:
   * a bind that never happened records no latency, so a rollout watching only
   * the p99 sees it IMPROVE as binds begin to fail. The second test is the one
   * that makes the first mean something.
   */
  it('a successful bind observes the bind latency, anchored on the ANSWER', async () => {
    const before = await histogramCount('agency_bind_latency_seconds', HIST_LABELS);
    const world = await dialedWorld();

    await settle(world);

    expect(
      await histogramCount('agency_bind_latency_seconds', HIST_LABELS) - before,
      'the rollout abort criterion recorded nothing on a successful bind',
    ).toBe(1);
  });

  it('a REFUSED bind observes no latency, so the p99 cannot improve as binds fail', async () => {
    const before = await histogramCount('agency_bind_latency_seconds', HIST_LABELS);
    const world = await dialedWorld();
    world.bridge.bindBorrowedBrowserLeg.mockReturnValue(false);

    await settle(world);

    // The failure is counted — on the counter, which is the series that cannot
    // be derived from the histogram.
    expect(await seriesValue('agency_bind_total', { ...LABELS, result: 'bind_failed' }))
      .toBeGreaterThan(0);
    expect(
      await histogramCount('agency_bind_latency_seconds', HIST_LABELS) - before,
      'a bind that never completed contributed a latency observation',
    ).toBe(0);
  });

  it('every reason the bind path can produce is a member of the vocabulary', async () => {
    // The membership check the previous test was doing alone, now standing on
    // branches that are actually forced above rather than on one fallback.
    for (const reason of ['station_lost', 'bind_failed'] as const) {
      expect(AGENCY_ABANDON_REASONS).toContain(reason);
    }
  });
});

// ===========================================================================
// The our-fault retirement counter.
//
// Added after review, and after a falsification run proved the point: disabling
// this counter entirely broke NO test in the whole agency suite. The argument
// for adding it was that a contact retired by our own faults is invisible in
// every view — shipping it untested would have left it able to become invisible
// again without anything going red.
//
// The ordering property is the one that needs a test rather than a comment: a
// counter incremented on the DECISION rather than after the durable write
// reports a permanently retired contact that is in fact still pending, and no
// amount of reading the metric can detect that afterwards.
// ===========================================================================
describe('the our-fault retirement counter', () => {
  /** A pre-answer teardown, which the classifier settles `canceled`. */
  async function exhaustedOurFaultDial() {
    // At or above OUR_FAULT_REDIAL_BOUND, so `resolveOurFaultRedial` retires.
    repos.contact.chargeOurFaultAttempt.mockResolvedValue(3);
    const world = await dialedWorld();
    await world.bridge.emit({
      callId: 'call-1', correlationId: 'att-1', phase: 'ended',
      status: 'canceled', outcome: 'agent_hangup', answered: false,
    });
    return world;
  }

  it('counts a contact retired by the bound, labelled with the cause', async () => {
    const before = await seriesValue('agency_our_fault_retirement_total',
      { ...LABELS, outcome: 'canceled' });

    await exhaustedOurFaultDial();

    expect(repos.contact.markState).toHaveBeenCalledWith(
      'contact-1', 'exhausted', expect.anything(),
    );
    expect(
      await seriesValue('agency_our_fault_retirement_total', { ...LABELS, outcome: 'canceled' })
        - before,
      'a contact was retired by our own fault and nothing counted it',
    ).toBe(1);
    // And the campaign's pacing history, beside the counter (one helper writes both).
    expect(repos.insightsPacing.addToMinute).toHaveBeenCalledWith(expect.objectContaining({
      campaignId: LABELS.campaign_id, tenantId: LABELS.tenant_id, field: 'our_fault_retired',
    }));
  });

  it('does NOT count a retirement whose durable write rejected', async () => {
    // ⚠️ The ordering property. Incremented on the decision, this reads as a
    // permanently retired contact while the row is still pending — telemetry
    // asserting a customer was dropped from the list when they were not. Same
    // rule the compliance counters follow: a counter that means "we believe this
    // was recorded" can find a write that silently did not take.
    const before = await seriesValue('agency_our_fault_retirement_total',
      { ...LABELS, outcome: 'canceled' });
    repos.contact.markState.mockRejectedValueOnce(new Error('pool exhausted'));

    await exhaustedOurFaultDial();

    expect(
      await seriesValue('agency_our_fault_retirement_total', { ...LABELS, outcome: 'canceled' })
        - before,
      'a rejected write still reported a retirement',
    ).toBe(0);
  });

  it('does NOT count a retirement `markState` RESOLVED but refused', async () => {
    /**
     * The hole the rejection test above cannot see, and the one that was live.
     *
     * `markState` does not throw when its DNC guard refuses the transition: the
     * `CASE` keeps a `dnc`-suppressed row `suppressed`, the statement succeeds,
     * and a WARN line is the only trace. A contact marked DNC mid-call is the
     * headline case in that function's own header — and on that path
     * `our_fault_bound_reached` still fires.
     *
     * So the first version incremented here, reporting *"we permanently retired
     * someone we failed to reach"* for a row that stayed suppressed at the
     * customer's own request. The alert fires, an engineer goes looking for
     * dropped sockets, and this ledger retired nobody. Gating on "the await did
     * not reject" cannot catch it; only `markState`'s own answer can.
     */
    const before = await seriesValue('agency_our_fault_retirement_total',
      { ...LABELS, outcome: 'canceled' });
    repos.contact.markState.mockResolvedValueOnce(false);

    await exhaustedOurFaultDial();

    // The write was attempted and resolved — this is not the rejection case.
    expect(repos.contact.markState).toHaveBeenCalledWith(
      'contact-1', 'exhausted', expect.anything(),
    );
    expect(
      await seriesValue('agency_our_fault_retirement_total', { ...LABELS, outcome: 'canceled' })
        - before,
      'a refused transition was reported as a permanent retirement',
    ).toBe(0);
  });

  it('counts nothing while the contact is still being retried', async () => {
    // The control: below the bound the contact goes back on the roster, and a
    // counter that fired here would make every our-fault redial look like a
    // permanent loss.
    repos.contact.chargeOurFaultAttempt.mockResolvedValue(1);
    const before = await seriesValue('agency_our_fault_retirement_total',
      { ...LABELS, outcome: 'canceled' });

    const world = await dialedWorld();
    await world.bridge.emit({
      callId: 'call-1', correlationId: 'att-1', phase: 'ended',
      status: 'canceled', outcome: 'agent_hangup', answered: false,
    });

    expect(repos.contact.markState).toHaveBeenCalledWith(
      'contact-1', 'pending', expect.anything(),
    );
    expect(await seriesValue('agency_our_fault_retirement_total',
      { ...LABELS, outcome: 'canceled' }) - before).toBe(0);
  });
});

// ===========================================================================
// The exported series, label set by label set.
//
// Review once found that every assertion in this file read the prom-client
// registry while nothing referenced the OTel twins Grafana Cloud actually
// receives — so an omitted or mislabelled OTel call passed the entire suite.
// With one OTel instrument per metric, every assertion here reads the real
// meter, i.e. what an OTLP export carries; the block below pins the EXACT
// label sets (and the absence of the series that must not move).
// ===========================================================================
describe('seat time on the paths that never reach the settle site', () => {
  /**
   * ── The gap review found in the pivotal series ───────────────────────────
   *
   * `agency_attempt_hold_seconds` is observed at the settle site, and
   * `abandonBeforeDial` never reaches it: it deletes the live record and writes
   * the attempt `ended` itself. Two of its five callers run AFTER the live
   * registration — the late-binding socket recheck and `createBridgedCall`
   * throwing — and on both of those **the agent was genuinely held**: the lease
   * was extended to `reserved_dialing`, the row says `dialing`, and
   * `releaseAgent` runs inside that method.
   *
   * So `failed` and `orphaned` were silently under-reported in the one series
   * every pacing argument now rests on, and the shortfall was invisible: a
   * bucket that is missing observations looks identical to a bucket where
   * nothing went wrong.
   */
  it('observes hold time when the DIAL ITSELF throws, attributed to `failed`', async () => {
    const before = await histogramCount('agency_attempt_hold_seconds',
      { ...HIST_LABELS, outcome: 'failed' });

    const bridge = fakeBridge();
    bridge.createBridgedCall.mockRejectedValue(new Error('carrier refused'));
    const stations = new StationRegistry(null, '', 'r1');
    const agents = new AgentStateMachine(null, '');
    vi.spyOn(agents, 'transition').mockResolvedValue(true);
    const dialer = new AgencyDialer(
      bridge as any, stations, agents, fakeWrapup() as any, fakeBreaks() as any,
    );
    dialer.start();
    await stations.attach({
      sessionId: 's1', campaignId: 'camp-1', tenantId: 't1', accountId: 'a1',
      agentUserId: 'user-1', ws: fakeWs() as any,
    });

    await dialer.executeDial(makeCmd());

    // The attempt really did end `failed` — same label the observation carries,
    // so the histogram bucket and the row cannot disagree.
    expect(persistedOutcome()).toBe('failed');
    expect(
      await histogramCount('agency_attempt_hold_seconds', { ...HIST_LABELS, outcome: 'failed' })
        - before,
      'the agent was held through a failed dial and the pivotal series recorded nothing',
    ).toBe(1);
  });

  /**
   * A dial the carrier may have queued (`add_lead` timed out, or a 2xx whose body could not
   * be read): the bridge fails it and the agent is released, but the contact must NOT be
   * dialled again at once — the carrier may still be dialling it, and the next pacing tick
   * would make it two calls to one customer. Its redial is deferred by
   * `DIAL_OUTCOME_UNKNOWN_REDIAL_DELAY_MS`, and charged to the our-fault ledger in the same
   * statement (`requeueOrphaned`), so its bound ends a run of such dials; any other dial
   * failure returns it now, uncharged, as before.
   * Mutation-checked: dropping the outcome-unknown argument at the dial site reds the first.
   */
  it('defers the contact\'s redial when the carrier may have queued the failed dial', async () => {
    const bridge = fakeBridge();
    const refusal = new WebRtcCallError('VoiceLink /v1/add_lead timed out after 15000 ms', 'telephony_init_failed', 502);
    refusal.cause = new CarrierRequestTimeoutError('VoiceLink /v1/add_lead', 15_000, true);
    bridge.createBridgedCall.mockRejectedValue(refusal);
    const stations = new StationRegistry(null, '', 'r1');
    const agents = new AgentStateMachine(null, '');
    vi.spyOn(agents, 'transition').mockResolvedValue(true);
    const dialer = new AgencyDialer(bridge as any, stations, agents, fakeWrapup() as any, fakeBreaks() as any);
    dialer.start();
    await stations.attach({
      sessionId: 's1', campaignId: 'camp-1', tenantId: 't1', accountId: 'a1',
      agentUserId: 'user-1', ws: fakeWs() as any,
    });

    const before = Date.now();
    await dialer.executeDial(makeCmd());

    expect(persistedOutcome()).toBe('failed');
    expect(repos.contact.unclaim).not.toHaveBeenCalled();
    expect(repos.contact.requeueOrphaned).toHaveBeenCalledTimes(1);
    const [contactId, hold] = repos.contact.requeueOrphaned.mock.calls[0]! as [string, any];
    expect(contactId).toBe('contact-1');
    expect(hold).toMatchObject({
      reapedAttemptId: 'att-1', outcome: 'failed', bound: OUR_FAULT_REDIAL_BOUND, retiredState: 'exhausted',
    });
    const nextAt = (hold.notBefore as Date).getTime();
    expect(nextAt).toBeGreaterThanOrEqual(before + DIAL_OUTCOME_UNKNOWN_REDIAL_DELAY_MS);
    expect(nextAt).toBeLessThanOrEqual(Date.now() + DIAL_OUTCOME_UNKNOWN_REDIAL_DELAY_MS);
    expect(DIAL_OUTCOME_UNKNOWN_REDIAL_DELAY_MS).toBe(15 * 60_000);
    // The customer's allowance is untouched.
    expect(repos.contact.chargeAttempt).not.toHaveBeenCalled();
  });

  /**
   * A dial that fails in the bridge before the carrier is asked (the call row INSERT, the
   * carrier tokens, the carrier request's inputs). The bridge's real
   * order for it: no `ended`, only the rejection (`abortUnplacedLeg`). (A carrier refusal is
   * settled by the `ended` arm, below.) The contact went back dialable at once, so a failure
   * that repeats redialled the same contact on every pacing tick, bounded by nothing. It now
   * waits `PRE_CARRIER_FAILURE_REDIAL_DELAY_MS`, uncharged: nobody was called, and a charge
   * would let a systemic failure retire the whole roster at the our-fault bound in seconds.
   * A dial called off before the bridge (the agent's socket went) is still returned at once.
   */
  it.each([
    ['the call row INSERT', () => new Error('insert into agency_calls failed')],
    ['a setup error the bridge wraps', () => new WebRtcCallError('setup', 'telephony_init_failed', 502)],
  ])('holds the contact a minute, uncharged, when the dial failed in the bridge before the carrier (%s)', async (_what, makeErr) => {
    const bridge = fakeBridge();
    bridge.createBridgedCall.mockRejectedValue(makeErr());
    const stations = new StationRegistry(null, '', 'r1');
    const agents = new AgentStateMachine(null, '');
    vi.spyOn(agents, 'transition').mockResolvedValue(true);
    const dialer = new AgencyDialer(bridge as any, stations, agents, fakeWrapup() as any, fakeBreaks() as any);
    dialer.start();
    await stations.attach({
      sessionId: 's1', campaignId: 'camp-1', tenantId: 't1', accountId: 'a1',
      agentUserId: 'user-1', ws: fakeWs() as any,
    });

    const before = Date.now();
    await dialer.executeDial(makeCmd());

    expect(persistedOutcome()).toBe('failed');
    expect(repos.contact.unclaim).toHaveBeenCalledTimes(1);
    const nextAt = (repos.contact.unclaim.mock.calls[0]![1] as Date).getTime();
    expect(nextAt, 'dialable again on the next tick').toBeGreaterThanOrEqual(before + PRE_CARRIER_FAILURE_REDIAL_DELAY_MS);
    expect(nextAt).toBeLessThanOrEqual(Date.now() + PRE_CARRIER_FAILURE_REDIAL_DELAY_MS);
    expect(PRE_CARRIER_FAILURE_REDIAL_DELAY_MS).toBe(60_000);
    // Uncharged on both ledgers.
    expect(repos.contact.requeueOrphaned).not.toHaveBeenCalled();
    expect(repos.contact.chargeAttempt).not.toHaveBeenCalled();
    expect(repos.contact.chargeOurFaultAttempt).not.toHaveBeenCalled();
  });

  /**
   * An admission refusal is back-pressure, not a failure: pacing caps its dials by the account
   * limit, and a contact held a minute stalled a floor that freed capacity within seconds
   * (`integration/load/concurrency-cap.test.ts`).
   */
  it.each([
    'global_concurrency_limit', 'account_concurrency_limit',
    'provider_concurrency_limit', 'provider_concurrency_unavailable',
  ] as const)('returns the contact at once, uncharged, when the bridge refused admission (%s)', async (code) => {
    const bridge = fakeBridge();
    bridge.createBridgedCall.mockRejectedValue(new WebRtcCallError('full', code, 429));
    const stations = new StationRegistry(null, '', 'r1');
    const agents = new AgentStateMachine(null, '');
    vi.spyOn(agents, 'transition').mockResolvedValue(true);
    const dialer = new AgencyDialer(bridge as any, stations, agents, fakeWrapup() as any, fakeBreaks() as any);
    dialer.start();
    await stations.attach({
      sessionId: 's1', campaignId: 'camp-1', tenantId: 't1', accountId: 'a1',
      agentUserId: 'user-1', ws: fakeWs() as any,
    });

    await dialer.executeDial(makeCmd());

    expect(persistedOutcome()).toBe('failed');
    expect(repos.contact.unclaim).toHaveBeenCalledTimes(1);
    expect((repos.contact.unclaim.mock.calls[0]![1] as Date).getTime()).toBeLessThanOrEqual(Date.now());
    expect(repos.contact.requeueOrphaned).not.toHaveBeenCalled();
    expect(repos.contact.chargeAttempt).not.toHaveBeenCalled();
    expect(repos.contact.chargeOurFaultAttempt).not.toHaveBeenCalled();
  });

  it('returns the contact at once when the dial is called off before the carrier (the station socket went)', async () => {
    const bridge = fakeBridge();
    bridge.createBridgedCall.mockRejectedValue(new WebRtcCallError('Station socket is not open', 'station_socket_unavailable', 409));
    const stations = new StationRegistry(null, '', 'r1');
    const agents = new AgentStateMachine(null, '');
    vi.spyOn(agents, 'transition').mockResolvedValue(true);
    const dialer = new AgencyDialer(bridge as any, stations, agents, fakeWrapup() as any, fakeBreaks() as any);
    dialer.start();
    await stations.attach({
      sessionId: 's1', campaignId: 'camp-1', tenantId: 't1', accountId: 'a1',
      agentUserId: 'user-1', ws: fakeWs() as any,
    });

    await dialer.executeDial(makeCmd());

    expect(persistedOutcome()).toBe('orphaned');
    expect(repos.contact.unclaim).toHaveBeenCalledTimes(1);
    expect((repos.contact.unclaim.mock.calls[0]![1] as Date).getTime()).toBeLessThanOrEqual(Date.now());
    expect(repos.contact.requeueOrphaned).not.toHaveBeenCalled();
  });

  /**
   * The bridge's REAL order for a dial the carrier refused: its `endCall` emits `ended`
   * (`telephony_init_failed`, `TELEPHONY_INIT_OUTCOME_UNKNOWN` when the carrier may have
   * queued the lead) synchronously, awaits the slot release, and only then does
   * `createBridgedCall` reject (`webrtc-bridge-manager.ts`, step 6). The two tests above
   * use a bridge that rejects without ending, which is why they could not see the
   * outcome-unknown dial settled twice: once by the `ended` arm (charged through the
   * `failed` retry policy) and once by the dial's failure path, whose 15-minute hold then
   * found the contact no longer `in_flight`.
   */
  function bridgeEndingThenRejecting(errorCode: string, cause: Error) {
    const bridge = fakeBridge();
    const listeners: Array<(e: any) => void> = [];
    bridge.onLifecycle = (fn: (e: any) => void) => { listeners.push(fn); return () => { /* noop */ }; };
    (bridge.createBridgedCall as ReturnType<typeof vi.fn>).mockImplementation(async (params: any) => {
      for (const l of listeners) {
        l({
          callId: 'call-1', correlationId: params.correlation.agencyAttemptId, phase: 'ended',
          status: 'failed', outcome: 'telephony_init_failed', errorCode, errorMessage: cause.message,
          answered: false, talkTimeSeconds: 0,
        });
      }
      // `releaseSlots` and `clearWsToken`: the `ended` handler's writes are under way.
      await new Promise((resolve) => setImmediate(resolve));
      const refusal = new WebRtcCallError(cause.message, 'telephony_init_failed', 502);
      refusal.cause = cause;
      throw refusal;
    });
    return bridge;
  }

  async function dialThrough(bridge: ReturnType<typeof fakeBridge>) {
    const stations = new StationRegistry(null, '', 'r1');
    const agents = new AgentStateMachine(null, '');
    vi.spyOn(agents, 'transition').mockResolvedValue(true);
    const setSpy = vi.spyOn(agents, 'set');
    const dialer = new AgencyDialer(bridge as any, stations, agents, fakeWrapup() as any, fakeBreaks() as any);
    dialer.start();
    const ws = fakeWs();
    await stations.attach({
      sessionId: 's1', campaignId: 'camp-1', tenantId: 't1', accountId: 'a1',
      agentUserId: 'user-1', ws: ws as any,
    });
    await dialer.executeDial(makeCmd());
    // Let any settle the `ended` arm started finish before counting.
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    const endedWrites = repos.attempt.setState.mock.calls.filter(([, state]: any[]) => state === 'ended');
    const released = ws.sent.filter((f: any) => f.event === 'released');
    const releases = setSpy.mock.calls.filter(([sid]: any[]) => sid === 's1');
    return { dialer, endedWrites, released, releases };
  }

  /** Mutation-checked: dropping the `ended` arm's outcome-unknown early return reds this. */
  it('settles an outcome-unknown dial ONCE, through the redial hold, when the bridge ends it before rejecting', async () => {
    const before = Date.now();
    const world = await dialThrough(bridgeEndingThenRejecting(
      'TELEPHONY_INIT_OUTCOME_UNKNOWN', new CarrierRequestTimeoutError('VoiceLink /v1/add_lead', 15_000, true),
    ));

    expect(world.endedWrites, 'the attempt row was ended more than once').toHaveLength(1);
    expect(world.endedWrites[0]![2]).toMatchObject({ outcome: 'failed' });
    // No retry policy and no customer allowance: the contact goes back only after the
    // hold, charged once to the our-fault ledger by the hold's own statement.
    expect(repos.contact.chargeAttempt).not.toHaveBeenCalled();
    expect(repos.contact.chargeOurFaultAttempt).not.toHaveBeenCalled();
    expect(repos.contact.markState).not.toHaveBeenCalled();
    expect(repos.contact.unclaim).not.toHaveBeenCalled();
    expect(repos.contact.requeueOrphaned).toHaveBeenCalledTimes(1);
    const nextAt = (repos.contact.requeueOrphaned.mock.calls[0]![1].notBefore as Date).getTime();
    expect(nextAt).toBeGreaterThanOrEqual(before + DIAL_OUTCOME_UNKNOWN_REDIAL_DELAY_MS);
    // The agent is told once and released once.
    expect(world.released).toHaveLength(1);
    expect(world.releases).toHaveLength(1);
    expect(world.dialer.activeAttemptIds()).toEqual([]);
    expect(world.dialer.unrecordedEndedAttempts()).toEqual([]);
  });

  /**
   * The hold rides on the `ended` arm's sighting too, so a dial call that rejects with
   * something other than the adapter's error (the slot release throwing inside `endCall`)
   * still holds the contact. Mutation-checked: dropping `|| live.outcomeUnknownEnd` reds it.
   */
  it('holds the contact on the bridge\'s outcome-unknown end even when the rejection does not say so', async () => {
    const before = Date.now();
    await dialThrough(bridgeEndingThenRejecting('TELEPHONY_INIT_OUTCOME_UNKNOWN', new Error('redis down while releasing slots')));
    expect(repos.contact.requeueOrphaned).toHaveBeenCalledTimes(1);
    expect((repos.contact.requeueOrphaned.mock.calls[0]![1].notBefore as Date).getTime())
      .toBeGreaterThanOrEqual(before + DIAL_OUTCOME_UNKNOWN_REDIAL_DELAY_MS);
  });

  /**
   * A plain refusal is the `ended` arm's: recorded `failed`, charged through the retry
   * policy, the agent told and released by it. The dial's failure path must then find
   * nothing to abandon. It used to abandon again: a second row write, a second `released`
   * frame, and a second release of an agent pacing may already have reserved.
   * Mutation-checked: dropping the "already settled" check in the catch reds this.
   */
  it('settles a plainly refused dial ONCE, in the `ended` arm, when the bridge ends it before rejecting', async () => {
    const world = await dialThrough(bridgeEndingThenRejecting(
      'TELEPHONY_INIT_FAILED', new Error('VoiceLink /v1/add_lead error 500: no'),
    ));
    expect(world.endedWrites).toHaveLength(1);
    expect(world.endedWrites[0]![2]).toMatchObject({ outcome: 'failed' });
    expect(repos.contact.chargeAttempt).toHaveBeenCalledTimes(1);
    expect(repos.contact.unclaim).not.toHaveBeenCalled();
    expect(repos.contact.requeueOrphaned).not.toHaveBeenCalled();
    expect(world.released).toHaveLength(1);
    expect(world.releases).toHaveLength(1);
    expect(world.dialer.activeAttemptIds()).toEqual([]);
  });

  /**
   * ── An end that RACES the dial (the hold used to be lost) ────────────────────
   *
   * The agent hangs up (or their station goes, or anything else ends the call) while
   * `add_lead` is still in flight. The real bridge's order: `forceEndWithOutcome` →
   * `endCall` claims the call and emits `ended` (`agent_hangup` / `agent_disconnected`,
   * never the outcome-unknown code), and only when `add_lead` later times out does
   * `createBridgedCall` reject, its own `endCall` a no-op on the ended call. The `ended`
   * arm used to settle the contact at once through the policy (the our-fault `canceled`
   * path), the dial's catch then found the attempt settled and did nothing, and the
   * 15-minute hold was never applied.
   *
   * A bridge whose dial is held open until the test answers it, with the teardown's
   * `ended` emitted while it is open: the order the real one produces.
   */
  function bridgeWithHeldDial() {
    const bridge = fakeBridge();
    const listeners: Array<(e: any) => void> = [];
    bridge.onLifecycle = (fn: (e: any) => void) => { listeners.push(fn); return () => { /* noop */ }; };
    let answer!: (how: { reject?: Error }) => void;
    const answered = new Promise<{ reject?: Error }>((resolve) => { answer = resolve; });
    let correlationId: string | null = null;
    (bridge.createBridgedCall as ReturnType<typeof vi.fn>).mockImplementation(async (params: any) => {
      correlationId = params.correlation.agencyAttemptId;
      const how = await answered;
      if (how.reject) throw how.reject;
      return { id: 'call-1' };
    });
    const endWhileDialling = (fields: Record<string, unknown>) => {
      for (const l of listeners) {
        l({ callId: 'call-1', correlationId, phase: 'ended', answered: false, talkTimeSeconds: 0, ...fields });
      }
    };
    return { bridge, answer, endWhileDialling, dialStarted: () => correlationId !== null };
  }

  function outcomeUnknownRefusal(): WebRtcCallError {
    const refusal = new WebRtcCallError('VoiceLink /v1/add_lead timed out after 15000 ms', 'telephony_init_failed', 502);
    refusal.cause = new CarrierRequestTimeoutError('VoiceLink /v1/add_lead', 15_000, true);
    return refusal;
  }

  const flush = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve)); };

  async function heldDialWorld() {
    const held = bridgeWithHeldDial();
    const stations = new StationRegistry(null, '', 'r1');
    const agents = new AgentStateMachine(null, '');
    vi.spyOn(agents, 'transition').mockResolvedValue(true);
    const setSpy = vi.spyOn(agents, 'set');
    const dialer = new AgencyDialer(held.bridge as any, stations, agents, fakeWrapup() as any, fakeBreaks() as any);
    dialer.start();
    const ws = fakeWs();
    await stations.attach({
      sessionId: 's1', campaignId: 'camp-1', tenantId: 't1', accountId: 'a1',
      agentUserId: 'user-1', ws: ws as any,
    });
    const dialing = dialer.executeDial(makeCmd());
    await vi.waitFor(() => expect(held.dialStarted()).toBe(true));
    const count = () => ({
      endedWrites: repos.attempt.setState.mock.calls.filter(([, state]: any[]) => state === 'ended'),
      released: ws.sent.filter((f: any) => f.event === 'released'),
      releases: setSpy.mock.calls.filter(([sid]: any[]) => sid === 's1'),
    });
    return { ...held, dialer, dialing, count };
  }

  /**
   * Mutation-checked: settling the contact in the `ended` arm regardless of the dial
   * (`contactAfterDial` forced false) reds both cases.
   */
  it.each([
    ['the agent hangs up', { status: 'canceled', outcome: 'agent_hangup' }, 'canceled'],
    ['the station goes away', { status: 'canceled', outcome: 'agent_disconnected' }, 'agent_disconnected'],
  ])('holds the contact 15 min when %s during an add_lead that then times out', async (_what, end, rowOutcome) => {
    const world = await heldDialWorld();

    // The teardown, while `add_lead` is still in flight.
    world.endWhileDialling(end);
    await flush();
    // The agent is released and told at once; the contact is NOT settled yet.
    expect(world.count().releases).toHaveLength(1);
    expect(world.count().released).toHaveLength(1);
    expect(world.count().endedWrites).toHaveLength(1);
    expect(world.count().endedWrites[0]![2]).toMatchObject({ outcome: rowOutcome });
    expect(repos.contact.chargeOurFaultAttempt).not.toHaveBeenCalled();
    expect(repos.contact.markState).not.toHaveBeenCalled();
    expect(repos.contact.requeueOrphaned).not.toHaveBeenCalled();

    // `add_lead` times out: the carrier may still ring the customer.
    const before = Date.now();
    world.answer({ reject: outcomeUnknownRefusal() });
    await world.dialing;
    await flush();

    expect(repos.contact.requeueOrphaned).toHaveBeenCalledTimes(1);
    const [, hold] = repos.contact.requeueOrphaned.mock.calls[0]! as [string, any];
    expect(hold).toMatchObject({ reapedAttemptId: 'att-1', outcome: rowOutcome, bound: OUR_FAULT_REDIAL_BOUND });
    expect((hold.notBefore as Date).getTime()).toBeGreaterThanOrEqual(before + DIAL_OUTCOME_UNKNOWN_REDIAL_DELAY_MS);
    // Settled once, by one path: no policy settle, no unclaim, one row, one frame, one release.
    expect(repos.contact.chargeOurFaultAttempt).not.toHaveBeenCalled();
    expect(repos.contact.chargeAttempt).not.toHaveBeenCalled();
    expect(repos.contact.markState).not.toHaveBeenCalled();
    expect(repos.contact.unclaim).not.toHaveBeenCalled();
    expect(world.count().endedWrites).toHaveLength(1);
    expect(world.count().released).toHaveLength(1);
    expect(world.count().releases).toHaveLength(1);
    expect(world.dialer.activeAttemptIds()).toEqual([]);
    expect(world.dialer.unrecordedEndedAttempts()).toEqual([]);
  });

  /**
   * The control: the slow `add_lead` succeeds after the hang-up (the bridge hangs the
   * carrier leg up). The dial's outcome is known, so the contact is the `ended` arm's
   * policy settle — after the dial returned, never before.
   */
  it('settles the contact through the policy once a dial that raced a hang-up returns placed', async () => {
    const world = await heldDialWorld();
    world.endWhileDialling({ status: 'canceled', outcome: 'agent_hangup' });
    await flush();
    expect(repos.contact.chargeOurFaultAttempt).not.toHaveBeenCalled();

    world.answer({});
    await world.dialing;
    await flush();

    expect(repos.contact.chargeOurFaultAttempt).toHaveBeenCalledTimes(1);
    expect(repos.contact.markState).toHaveBeenCalledTimes(1);
    expect(repos.contact.requeueOrphaned).not.toHaveBeenCalled();
    expect(repos.contact.unclaim).not.toHaveBeenCalled();
    expect(world.count().endedWrites).toHaveLength(1);
    expect(world.count().released).toHaveLength(1);
    expect(world.count().releases).toHaveLength(1);
  });

  /**
   * The other order: `add_lead` times out while the teardown's `endCall` is still writing
   * its row, so the dial rejects BEFORE the teardown's `ended` reaches the dialer. The
   * dial's failure path settles it with the hold; the late `ended` finds nothing.
   */
  it('holds the contact once when the dial rejects before a racing teardown\'s ended arrives', async () => {
    const world = await heldDialWorld();
    const before = Date.now();
    world.answer({ reject: outcomeUnknownRefusal() });
    await world.dialing;
    world.endWhileDialling({ status: 'canceled', outcome: 'agent_hangup' });
    await flush();

    expect(repos.contact.requeueOrphaned).toHaveBeenCalledTimes(1);
    expect((repos.contact.requeueOrphaned.mock.calls[0]![1].notBefore as Date).getTime())
      .toBeGreaterThanOrEqual(before + DIAL_OUTCOME_UNKNOWN_REDIAL_DELAY_MS);
    expect(repos.contact.chargeOurFaultAttempt).not.toHaveBeenCalled();
    expect(repos.contact.markState).not.toHaveBeenCalled();
    expect(world.count().endedWrites).toHaveLength(1);
    expect(world.count().endedWrites[0]![2]).toMatchObject({ outcome: 'failed' });
    expect(world.count().released).toHaveLength(1);
    expect(world.count().releases).toHaveLength(1);
  });

  /**
   * A row the racing `ended` arm could not write goes to the reaper only once the dial
   * has answered, marked outcome-unknown, so the reaper's requeue keeps the hold.
   */
  it('reports an unwritten raced end to the reaper as outcome-unknown once the dial says so', async () => {
    const world = await heldDialWorld();
    repos.attempt.setState.mockRejectedValueOnce(new Error('pool exhausted'));
    world.endWhileDialling({ status: 'canceled', outcome: 'agent_hangup' });
    await flush();
    // Not yet: the dial has not answered.
    expect(world.dialer.unrecordedEndedAttempts()).toEqual([]);
    world.answer({ reject: outcomeUnknownRefusal() });
    await world.dialing;
    await flush();
    expect(world.dialer.unrecordedEndedAttempts()).toEqual([{ attemptId: 'att-1', dialOutcomeUnknown: true }]);
    expect(repos.contact.requeueOrphaned).not.toHaveBeenCalled();
    expect(repos.contact.chargeOurFaultAttempt).not.toHaveBeenCalled();
  });

  /**
   * The hold is charged to the our-fault ledger, so its bound retires a contact whose
   * dials keep ending outcome-unknown. A retirement that landed is counted, under the
   * cause's own label; a DNC row kept `suppressed` is not.
   */
  it('counts an outcome-unknown dial retired by the our-fault bound', async () => {
    const label = { ...LABELS, outcome: 'dial_outcome_unknown' };
    const before = await seriesValue('agency_our_fault_retirement_total', label);
    repos.contact.requeueOrphaned.mockResolvedValueOnce({ state: 'exhausted', our_fault_attempts: OUR_FAULT_REDIAL_BOUND });
    const world = await heldDialWorld();
    world.answer({ reject: outcomeUnknownRefusal() });
    await world.dialing;
    expect(await seriesValue('agency_our_fault_retirement_total', label) - before).toBe(1);

    repos.contact.requeueOrphaned.mockResolvedValueOnce({ state: 'suppressed', our_fault_attempts: OUR_FAULT_REDIAL_BOUND });
    const again = await heldDialWorld();
    again.answer({ reject: outcomeUnknownRefusal() });
    await again.dialing;
    expect(await seriesValue('agency_our_fault_retirement_total', label) - before).toBe(1);
  });

  /**
   * The dial's lease renewer stops only when the lease is LOST (Redis answered: the CAS
   * missed). A renew that failed (`unknown`: a Redis error, or the client's command
   * timeout) keeps it going: the lease outlives two missed renewals, and one slow Redis
   * reply must not let a live call's lease lapse and free the agent for a second customer.
   * Mutation-checked: stopping on anything but `renewed` reds this.
   */
  it('keeps renewing a live dial\'s lease through a failed renew, and stops only when it is lost', async () => {
    vi.useFakeTimers();
    try {
      const bridge = fakeBridge();
      const stations = new StationRegistry(null, '', 'r1');
      const agents = new AgentStateMachine(null, '');
      vi.spyOn(agents, 'transition').mockResolvedValue(true);
      const renewLease = vi.spyOn(agents, 'renewLease')
        .mockResolvedValueOnce('unknown')
        .mockResolvedValueOnce('unknown')
        .mockResolvedValueOnce('renewed')
        .mockResolvedValueOnce('lost')
        .mockResolvedValue('renewed');
      const dialer = new AgencyDialer(bridge as any, stations, agents, fakeWrapup() as any, fakeBreaks() as any);
      dialer.start();
      await stations.attach({
        sessionId: 's1', campaignId: 'camp-1', tenantId: 't1', accountId: 'a1',
        agentUserId: 'user-1', ws: fakeWs() as any,
      });
      await dialer.executeDial(makeCmd());

      // unknown, unknown, renewed: still renewing after two failures in a row.
      await vi.advanceTimersByTimeAsync(3 * AGENT_LEASE_MS.renew_interval);
      expect(renewLease).toHaveBeenCalledTimes(3);
      // lost: the renewer stops, and nothing renews after it.
      await vi.advanceTimersByTimeAsync(AGENT_LEASE_MS.renew_interval);
      expect(renewLease).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(5 * AGENT_LEASE_MS.renew_interval);
      expect(renewLease).toHaveBeenCalledTimes(4);
      dialer.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('observes NOTHING when the dial never went out at all', async () => {
    // The control, and the reason `dialedAt` is the discriminator rather than the
    // call site: the three callers that run BEFORE the live registration have no
    // dial instant to measure from, and on those paths no dial was placed. An
    // implementation that observed there would invent seat time.
    const beforeFailed = await histogramCount('agency_attempt_hold_seconds',
      { ...HIST_LABELS, outcome: 'failed' });
    const beforeOrphaned = await histogramCount('agency_attempt_hold_seconds',
      { ...HIST_LABELS, outcome: 'orphaned' });

    const bridge = fakeBridge();
    const stations = new StationRegistry(null, '', 'r1');
    const agents = new AgentStateMachine(null, '');
    // The pre-dial lease CAS fails, so `executeDial` abandons before registering.
    vi.spyOn(agents, 'transition').mockResolvedValue(false);
    const dialer = new AgencyDialer(
      bridge as any, stations, agents, fakeWrapup() as any, fakeBreaks() as any,
    );
    dialer.start();
    await stations.attach({
      sessionId: 's1', campaignId: 'camp-1', tenantId: 't1', accountId: 'a1',
      agentUserId: 'user-1', ws: fakeWs() as any,
    });

    await dialer.executeDial(makeCmd());

    expect(bridge.createBridgedCall).not.toHaveBeenCalled();
    expect(
      await histogramCount('agency_attempt_hold_seconds', { ...HIST_LABELS, outcome: 'failed' })
        - beforeFailed
      + await histogramCount('agency_attempt_hold_seconds', { ...HIST_LABELS, outcome: 'orphaned' })
        - beforeOrphaned,
      'seat time was invented for a dial that never went out',
    ).toBe(0);
  });

  it('observes NOTHING when the pacing engine calls the dial off before the carrier', async () => {
    // Every shutdown with a tick in flight lands here, so seat time observed on
    // this path would be a steady trickle of `orphaned` dials that never happened.
    const beforeOrphaned = await histogramCount('agency_attempt_hold_seconds',
      { ...HIST_LABELS, outcome: 'orphaned' });

    const bridge = fakeBridge();
    const stations = new StationRegistry(null, '', 'r1');
    const agents = new AgentStateMachine(null, '');
    vi.spyOn(agents, 'transition').mockResolvedValue(true);
    const dialer = new AgencyDialer(
      bridge as any, stations, agents, fakeWrapup() as any, fakeBreaks() as any,
    );
    dialer.start();
    await stations.attach({
      sessionId: 's1', campaignId: 'camp-1', tenantId: 't1', accountId: 'a1',
      agentUserId: 'user-1', ws: fakeWs() as any,
    });

    await dialer.executeDial(makeCmd(), { stillAuthorised: () => false });

    expect(bridge.createBridgedCall).not.toHaveBeenCalled();
    expect(persistedOutcome()).toBe('orphaned');
    expect(
      await histogramCount('agency_attempt_hold_seconds', { ...HIST_LABELS, outcome: 'orphaned' })
        - beforeOrphaned,
      'seat time was observed for a dial the pacing engine called off',
    ).toBe(0);
  });
});

const HOLD = 'agency_attempt_hold_seconds';
const REASON = 'agency_abandoned_reason_total';
const BIND = 'agency_bind_total';
const BIND_LATENCY = 'agency_bind_latency_seconds';
const RETIREMENT = 'agency_our_fault_retirement_total';

describe('the exported series carry exactly these values and labels', () => {
  async function snapshots(): Promise<Record<string, Map<string, number>>> {
    const out: Record<string, Map<string, number>> = {};
    for (const name of [HOLD, REASON, BIND, BIND_LATENCY, RETIREMENT]) out[name] = await snapshotSeries(name);
    return out;
  }
  async function moved(before: Record<string, Map<string, number>>, name: string) {
    return seriesDelta(before[name]!, await snapshotSeries(name));
  }

  it('records hold time and the abandon reason, each once', async () => {
    const before = await snapshots();

    const world = await dialedWorld();
    await world.bridge.emit({
      callId: 'call-1', correlationId: 'att-1', phase: 'answered',
      answered: true, answeredAt: new Date(),
    });
    await world.bridge.emit({
      callId: 'call-1', correlationId: 'att-1', phase: 'ended',
      status: 'completed', outcome: 'completed', answered: true,
    });

    // Hold time: one observation, attributed to the same outcome the row got.
    // Tenant-scoped only: `campaign_id` is deliberately off the histograms.
    expect(await moved(before, HOLD)).toEqual([{ attrs: { tenant_id: 't1', outcome: 'abandoned' }, by: 1 }]);

    // The reason, with the label the dashboard panel queries.
    expect(await moved(before, REASON)).toEqual([
      { attrs: { tenant_id: 't1', campaign_id: 'camp-1', reason: 'unattributed' }, by: 1 },
    ]);

    // Early binding, so no bind was attempted — the control that stops this
    // passing against code which emits a bind result on every call.
    expect(await moved(before, BIND)).toEqual([]);
    expect(await moved(before, BIND_LATENCY)).toEqual([]);
  });

  it('records the bind result and its latency under late binding', async () => {
    flags.lateBinding = true;
    try {
      const before = await snapshots();
      const world = await dialedWorld();
      await world.bridge.emit({
        callId: 'call-1', correlationId: 'att-1', phase: 'answered',
        answered: true, answeredAt: new Date(),
      });
      await world.bridge.emit({
        callId: 'call-1', correlationId: 'att-1', phase: 'ended',
        status: 'completed', outcome: 'completed', answered: true,
      });

      expect(await moved(before, BIND)).toEqual([
        { attrs: { tenant_id: 't1', campaign_id: 'camp-1', result: 'bound' }, by: 1 },
      ]);
      // No `result` label on the latency series — it is the counter that splits
      // by result, and the two must not drift into each other's label sets. And
      // no `campaign_id`: the counter keeps it, the histogram does not (series cost).
      expect(await moved(before, BIND_LATENCY)).toEqual([{ attrs: { tenant_id: 't1' }, by: 1 }]);
    } finally {
      flags.lateBinding = false;
    }
  });

  it('records a refused bind, and no latency for it', async () => {
    flags.lateBinding = true;
    try {
      const before = await snapshots();
      const world = await dialedWorld();
      world.bridge.bindBorrowedBrowserLeg.mockReturnValue(false);
      await world.bridge.emit({
        callId: 'call-1', correlationId: 'att-1', phase: 'answered',
        answered: true, answeredAt: new Date(),
      });
      await world.bridge.emit({
        callId: 'call-1', correlationId: 'att-1', phase: 'ended',
        status: 'completed', outcome: 'completed', answered: true,
      });

      expect(await moved(before, BIND)).toEqual([
        { attrs: { tenant_id: 't1', campaign_id: 'camp-1', result: 'bind_failed' }, by: 1 },
      ]);
      // The asymmetry the help string warns about: a bind that never happened
      // records no latency, so a rollout watching only the p99 sees it improve as
      // binds start failing.
      expect(await moved(before, BIND_LATENCY)).toEqual([]);
    } finally {
      flags.lateBinding = false;
    }
  });

  it('records the our-fault retirement, and nothing when it is refused', async () => {
    repos.contact.chargeOurFaultAttempt.mockResolvedValue(3);
    let before = await snapshots();
    const world = await dialedWorld();
    await world.bridge.emit({
      callId: 'call-1', correlationId: 'att-1', phase: 'ended',
      status: 'canceled', outcome: 'agent_hangup', answered: false,
    });

    expect(await moved(before, RETIREMENT)).toEqual([
      { attrs: { tenant_id: 't1', campaign_id: 'camp-1', outcome: 'canceled' }, by: 1 },
    ]);

    // And the DNC refusal gates the counter: a series claiming a person was
    // permanently retired while the row says they were not is a contradiction
    // that becomes the operator's job.
    before = await snapshots();
    repos.contact.markState.mockResolvedValueOnce(false);
    const second = await dialedWorld();
    await second.bridge.emit({
      callId: 'call-1', correlationId: 'att-1', phase: 'ended',
      status: 'canceled', outcome: 'agent_hangup', answered: false,
    });
    expect(await moved(before, RETIREMENT)).toEqual([]);
  });
});

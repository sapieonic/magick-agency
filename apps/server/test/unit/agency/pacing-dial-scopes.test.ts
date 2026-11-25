import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// The dial scopes beyond the account cap (`src/agency/pacing/dial-scopes.ts`; decisions PL14,
// docs/carriers.md CR13): a tick never plans more new dials than the tightest scope its dials
// are admitted against leaves free — the account's cap (as always), the account's share of the
// campaign's carrier in provider-breakdown mode, and the carrier account's own cap, shared by
// every account of the tenant. Driven through the engine's scheduled path (`runRound`) with a
// scripted scope source, the round timer off and a fake engine clock, as `pacing-skip.test.ts`.
// The split's own arithmetic with scopes is `pacing-round.test.ts`.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { repos, settings } = vi.hoisted(() => ({
  repos: {
    campaign: {
      findById: vi.fn(),
      findActive: vi.fn().mockResolvedValue([]),
      countOutstanding: vi.fn().mockResolvedValue(1),
      transitionStatus: vi.fn(),
    },
    contact: {
      claimDialable: vi.fn().mockResolvedValue([]),
      countDialable: vi.fn(async (_id: string, limit: number) => limit),
      unclaim: vi.fn().mockResolvedValue(undefined),
      unclaimMany: vi.fn().mockResolvedValue(undefined),
      markState: vi.fn().mockResolvedValue(null),
    },
    attempt: {
      countLive: vi.fn().mockResolvedValue(0),
      countLiveForAccount: vi.fn().mockResolvedValue(0),
      countLiveByCampaignForAccount: vi.fn().mockResolvedValue(new Map()),
      create: vi.fn(),
      setState: vi.fn().mockResolvedValue(null),
    },
    session: {
      findLiveForCampaign: vi.fn().mockResolvedValue([]),
      setState: vi.fn().mockResolvedValue(null),
    },
    callerIds: { mapForCampaign: vi.fn(async () => new Map<string, string>()) },
    inboundRoutes: { listDefaultingTo: vi.fn().mockResolvedValue([]) },
  },
  settings: { getMaxConcurrentCalls: vi.fn().mockResolvedValue(5) },
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyCampaignRepository: repos.campaign,
  agencyContactRepository: repos.contact,
  agencyAttemptRepository: repos.attempt,
  agencyAgentSessionRepository: repos.session,
  agencyAgentCallerIdRepository: repos.callerIds,
  agencyInboundRouteRepository: repos.inboundRoutes,
}));
vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({
  accountSettingsRepository: settings,
}));
// A pinned campaign's dialable caller IDs (PL13): every stored number is still on its carrier account.
const { phoneAssignments } = vi.hoisted(() => ({
  phoneAssignments: { findCredentialNumbersForAccount: vi.fn() },
}));
vi.mock('@magick-agency/db/repositories/tenant-phone-assignment.repository', () => ({
  tenantPhoneAssignmentRepository: phoneAssignments,
}));
const { flags } = vi.hoisted(() => ({ flags: { isEnabled: vi.fn().mockResolvedValue(true) } }));
vi.mock('../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => flags,
  FLAGS: { agency_dialer_enabled: { key: 'agency_dialer_enabled', type: 'boolean', default: false } },
}));
vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: { log: vi.fn() } }));

import { PacingEngine, type PacingTickObservation } from '../../../src/agency/pacing-engine.js';
import { InProcessPacingInvalidationBus, parsePacingInvalidationEvent } from '../../../src/agency/pacing/invalidation-bus.js';
import { invalidateDialableCallerIds } from '../../../src/agency/campaign-dialability.js';
import { scopeRoom, normaliseCredentialCap, tightestRoom } from '../../../src/agency/pacing/dial-scopes.js';
import { withPacingInvalidation } from '../../../src/agency/pacing/limit-invalidation.js';
import { scriptedScopes } from '../../helpers/pacing-scopes.js';

const CRED = '11111111-1111-4111-8111-111111111111';
const NUMBERS = ['+14155550100', '+14155550101'];

function campaign(id: string, accountId: string, over: Record<string, unknown> = {}): any {
  return {
    id, name: id, tenant_id: 't1', account_id: accountId,
    status: 'running', caller_ids: NUMBERS,
    calling_window_start: '00:00:00', calling_window_end: '24:00:00',
    calling_days: [1, 2, 3, 4, 5, 6, 7], default_timezone: 'UTC',
    pause_reason: null, paused_at: null, pause_abandonment_rate_pct: null,
    abandonment_ceiling_pct: 3, updated_at: new Date('2026-11-01T00:00:00Z'),
    telephony_provider: 'voicelink', telephony_credential_id: null,
    ...over,
  };
}
const onCredential = { telephony_provider: 'plivo', telephony_credential_id: CRED };

function contact(id: string) {
  return { id, phone_e164: '+919876543210', context: {}, attempt_count: 0 } as any;
}

/**
 * An engine leading `floor`'s campaigns, each with `agents` available agents of its own, on the
 * scripted scope source. `plan(id)` is the campaign's last full tick.
 */
function rig(floor: Array<{ row: any; agents: number }>) {
  const scopes = scriptedScopes();
  const bus = new InProcessPacingInvalidationBus();
  const clock = { t: 1_000_000 };
  const states: Record<string, string> = {};
  const owned: Record<string, string> = {};
  const sessionsOf: Record<string, Array<{ id: string }>> = {};
  const rows: Record<string, any> = {};
  let n = 0;
  for (const { row, agents } of floor) {
    rows[row.id] = row;
    sessionsOf[row.id] = [];
    for (let i = 0; i < agents; i++) {
      const id = `s${++n}`;
      states[id] = 'available';
      owned[id] = row.id;
      sessionsOf[row.id]!.push({ id });
    }
  }
  repos.campaign.findById.mockImplementation(async (id: string) => rows[id] ?? null);
  repos.session.findLiveForCampaign.mockImplementation(async (id: string) => sessionsOf[id] ?? []);
  const get = vi.fn(async (id: string) => (states[id] ? { state: states[id], attemptId: null, since: 1 } : null));
  const agents = {
    get,
    getMany: vi.fn(async (ids: readonly string[]) => Promise.all(ids.map((id) => get(id)))),
    reserve: vi.fn(async (id: string) => {
      if (states[id] !== 'available') return 'lost';
      states[id] = 'reserved';
      return 'reserved';
    }),
    set: vi.fn(async (id: string, s: string) => { states[id] = s; return 'ok'; }),
  };
  const stations = {
    isLocallyOwned: vi.fn((id: string) => id in owned),
    ownerOf: vi.fn(async (id: string) => (id in owned ? 'r1' : null)),
    broadcast: vi.fn(() => 0),
    sessionIdsForCampaign: vi.fn(() => Object.keys(owned)),
    get: vi.fn((id: string) => (id in owned ? { sessionId: id, campaignId: owned[id], caps: new Set<string>() } : undefined)),
  };
  const dispatch = vi.fn().mockResolvedValue(undefined);
  const e = new PacingEngine(
    null, '', 'r1', stations as any, agents as any, { dispatch } as any, { check: vi.fn().mockResolvedValue('clear') } as any,
    { bus, now: () => clock.t, scopes: scopes.source },
  );
  e.setAutoRounds(false);
  const ticks: PacingTickObservation[] = [];
  e.registerTickObserver((o) => ticks.push(o));
  for (const { row } of floor) (e as any).beginLeading(row);
  engines.push(e);
  const plan = (id: string) => {
    const t = ticks.filter((x) => x.campaignId === id).at(-1);
    return t && t.mode === 'full' ? t : undefined;
  };
  const toDial = (id: string) => plan(id)?.plan?.toDial;
  const freeAll = () => { for (const id of Object.keys(states)) states[id] = 'available'; };
  return { e, bus, clock, scopes, states, dispatch, ticks, plan, toDial, freeAll };
}

const engines: PacingEngine[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.stop();
});

beforeEach(() => {
  vi.clearAllMocks();
  repos.campaign.countOutstanding.mockResolvedValue(1);
  repos.contact.claimDialable.mockResolvedValue([]);
  repos.contact.countDialable.mockImplementation(async (_id: string, limit: number) => limit);
  repos.attempt.countLiveForAccount.mockResolvedValue(0);
  repos.attempt.countLiveByCampaignForAccount.mockResolvedValue(new Map());
  repos.attempt.create.mockImplementation(async (p: any) => ({
    id: `att-${p.contactId}`, caller_id: p.callerId, attempt_number: 1, bridge_grace_ms: 3000,
  }));
  settings.getMaxConcurrentCalls.mockResolvedValue(5);
  repos.callerIds.mapForCampaign.mockImplementation(async () => new Map());
  repos.inboundRoutes.listDefaultingTo.mockResolvedValue([]);
  phoneAssignments.findCredentialNumbersForAccount.mockResolvedValue(NUMBERS);
  flags.isEnabled.mockResolvedValue(true);
  invalidateDialableCallerIds();
});

describe('the room a scope reading leaves (pure)', () => {
  const reading = { key: 'k', kind: 'carrier_account' as const, limit: 5, live: 2, pendingAtSnapshot: 1, grantedAtSnapshot: 10 };

  it('is limit − live − pending at the snapshot − every grant since', () => {
    expect(scopeRoom(reading, 10)).toBe(2);
    expect(scopeRoom(reading, 11)).toBe(1);
    expect(scopeRoom(reading, 13)).toBe(0); // never negative
  });

  it('the tightest of several scopes; none is no bound', () => {
    expect(tightestRoom([{ key: 'a', room: () => 3 }, { key: 'b', room: () => 1 }])).toBe(1);
    expect(tightestRoom([])).toBe(Number.POSITIVE_INFINITY);
    expect(tightestRoom(undefined)).toBe(Number.POSITIVE_INFINITY);
  });

  it('a cap is a positive integer, anything else none (the credential guard\'s rule)', () => {
    expect(normaliseCredentialCap(2)).toBe(2);
    for (const raw of [null, undefined, 0, -1, 1.5, '3']) expect(normaliseCredentialCap(raw)).toBeNull();
  });
});

describe('PacingEngine: the account\'s share of its carrier binds (PL14)', () => {
  it('plans MIN(account room, share room, idle): 5 agents, account 5, share 3 with 1 live → 2', async () => {
    const r = rig([{ row: campaign('c1', 'a1'), agents: 5 }]);
    r.scopes.shares.set('t1:a1', new Map([['voicelink', 3]]));
    r.scopes.shareLive.set('t1:a1:voicelink', 1);
    await r.e.runRound();
    expect(r.toDial('c1')).toBe(2);
  });

  it('a share already full plans 0 (`no_slots`), quiescent until a call or the limit changes', async () => {
    const r = rig([{ row: campaign('c1', 'a1'), agents: 5 }]);
    r.scopes.shares.set('t1:a1', new Map([['voicelink', 3]]));
    r.scopes.shareLive.set('t1:a1:voicelink', 3);
    await r.e.runRound();
    expect(r.plan('c1')).toMatchObject({ quiescent: true, plan: { toDial: 0, idle: 'no_slots' } });
  });

  it('no share for the campaign\'s carrier (PL14) plans 0 without reading a counter', async () => {
    const r = rig([{ row: campaign('c1', 'a1'), agents: 5 }]);
    r.scopes.shares.set('t1:a1', new Map([['plivo', 3]]));
    await r.e.runRound();
    expect(r.plan('c1')).toMatchObject({ plan: { toDial: 0, idle: 'no_slots' } });
    expect(r.scopes.reads.shareLive).toBe(0);
  });

  it('a legacy-total account reads its allocation only: the account cap alone binds', async () => {
    const r = rig([{ row: campaign('c1', 'a1'), agents: 5 }]);
    settings.getMaxConcurrentCalls.mockResolvedValue(4);
    await r.e.runRound();
    expect(r.toDial('c1')).toBe(4);
    expect(r.scopes.reads).toEqual({ shares: 1, cap: 0, shareLive: 0, credentialLive: 0 });
  });
});

describe('PacingEngine: a carrier account\'s own cap binds (CR13)', () => {
  it('plans the cap\'s room: cap 2 with 1 live → 1 of 4 agents', async () => {
    const r = rig([{ row: campaign('c1', 'a1', onCredential), agents: 4 }]);
    r.scopes.caps.set(CRED, 2);
    r.scopes.credentialLive.set(CRED, 1);
    await r.e.runRound();
    expect(r.toDial('c1')).toBe(1);
  });

  it('a full cap plans 0 (`no_slots`); a credential with no cap is no bound', async () => {
    const full = rig([{ row: campaign('c1', 'a1', onCredential), agents: 4 }]);
    full.scopes.caps.set(CRED, 2);
    full.scopes.credentialLive.set(CRED, 2);
    await full.e.runRound();
    expect(full.plan('c1')).toMatchObject({ quiescent: true, plan: { toDial: 0, idle: 'no_slots' } });

    const uncapped = rig([{ row: campaign('c2', 'a2', onCredential), agents: 4 }]);
    await uncapped.e.runRound();
    expect(uncapped.toDial('c2')).toBe(4);
    expect(uncapped.scopes.reads.credentialLive).toBe(0);
  });

  it('the share and the cap together: the tighter wins', async () => {
    const r = rig([{ row: campaign('c1', 'a1', onCredential), agents: 5 }]);
    r.scopes.shares.set('t1:a1', new Map([['plivo', 4]]));
    r.scopes.caps.set(CRED, 3);
    r.scopes.credentialLive.set(CRED, 1);
    await r.e.runRound();
    expect(r.toDial('c1')).toBe(2);
  });

  it('two accounts of the tenant on one carrier account, in one round, share its room: never both spend it', async () => {
    const r = rig([
      { row: campaign('ca', 'a1', onCredential), agents: 3 },
      { row: campaign('cb', 'a2', onCredential), agents: 3 },
    ]);
    r.scopes.caps.set(CRED, 3);
    await r.e.runRound();
    expect((r.toDial('ca') ?? 0) + (r.toDial('cb') ?? 0)).toBe(3);
    // One live read of the carrier account for the round, however many accounts dial on it.
    expect(r.scopes.reads.credentialLive).toBe(1);
  });

  it('a grant whose dials are still being placed holds the room across rounds, for every account', async () => {
    const r = rig([
      { row: campaign('ca', 'a1', onCredential), agents: 2 },
      { row: campaign('cb', 'a2', onCredential), agents: 2 },
    ]);
    r.scopes.caps.set(CRED, 2);
    // cb's agents (s3, s4) are on a break in round 1; ca's dispatches hang (a slow carrier), so
    // its tick outlives the round with its dials granted but not yet admitted (the counter reads 0).
    r.states['s3'] = 'break';
    r.states['s4'] = 'break';
    repos.contact.claimDialable.mockImplementation(async (id: string, n: number) =>
      Array.from({ length: n }, (_, i) => contact(`${id}-k${i}`)));
    const gates: Array<() => void> = [];
    r.dispatch.mockImplementation(() => new Promise<void>((resolve) => { gates.push(resolve); }));
    const first = r.e.runRound();
    await vi.waitFor(() => expect(r.dispatch).toHaveBeenCalledTimes(1));
    // Granted 2 (the tick's observation comes when it ends): it claimed for 2 agents.
    expect(repos.contact.claimDialable.mock.calls.filter((c) => c[0] === 'ca').map((c) => c[1])).toEqual([2]);

    // Round 2, ca still dialling: cb's agents are back, and the cap's room is still ca's.
    r.states['s3'] = 'available';
    r.states['s4'] = 'available';
    r.bus.publish({ type: 'agent_available', sessionId: 's3', campaignId: 'cb' });
    r.clock.t += 250;
    await r.e.runRound();
    expect(r.plan('cb')).toMatchObject({ plan: { toDial: 0, idle: 'no_slots' } });

    // ca's dials are admitted (the guard's counter takes them) and its tick ends: still no room.
    r.scopes.credentialLive.set(CRED, 1);
    gates.shift()!();
    await vi.waitFor(() => expect(r.dispatch).toHaveBeenCalledTimes(2));
    r.scopes.credentialLive.set(CRED, 2);
    gates.shift()!();
    await first;
    r.clock.t += 250;
    r.bus.publish({ type: 'campaign_changed', campaignId: 'cb' });
    await r.e.runRound();
    expect(r.plan('cb')).toMatchObject({ plan: { toDial: 0 } });

    // Both calls end: cb takes the room.
    r.scopes.credentialLive.set(CRED, 0);
    r.dispatch.mockResolvedValue(undefined);
    r.bus.publish({ type: 'account_capacity_freed', tenantId: 't1', accountId: 'a1' });
    r.clock.t += 250;
    await r.e.runRound();
    expect(r.toDial('cb')).toBe(2);
  });
});

describe('PacingEngine: several campaigns of one account, one of them on a capped carrier account (MC1)', () => {
  it('the bound campaign gets only its room; the share it cannot use goes to its sibling', async () => {
    settings.getMaxConcurrentCalls.mockResolvedValue(4);
    const r = rig([
      { row: campaign('c-svc', 'a1'), agents: 4 },
      { row: campaign('c-cap', 'a1', onCredential), agents: 4 },
    ]);
    r.scopes.caps.set(CRED, 1);
    await r.e.runRound();
    expect(r.toDial('c-cap')).toBe(1);
    expect(r.toDial('c-svc')).toBe(3);
  });

  it('a campaign whose carrier account is full gets 0 and leaves the whole account to the other', async () => {
    settings.getMaxConcurrentCalls.mockResolvedValue(4);
    const r = rig([
      { row: campaign('c-svc', 'a1'), agents: 4 },
      { row: campaign('c-cap', 'a1', onCredential), agents: 4 },
    ]);
    r.scopes.caps.set(CRED, 2);
    r.scopes.credentialLive.set(CRED, 2);
    await r.e.runRound();
    expect(r.plan('c-cap')).toMatchObject({ plan: { toDial: 0, idle: 'no_slots' } });
    expect(r.toDial('c-svc')).toBe(4);
  });

  it('two campaigns of one account on one carrier share its share, never each spending it', async () => {
    settings.getMaxConcurrentCalls.mockResolvedValue(10);
    const r = rig([
      { row: campaign('c1', 'a1'), agents: 4 },
      { row: campaign('c2', 'a1'), agents: 4 },
    ]);
    r.scopes.shares.set('t1:a1', new Map([['voicelink', 3]]));
    await r.e.runRound();
    expect((r.toDial('c1') ?? 0) + (r.toDial('c2') ?? 0)).toBe(3);
  });
});

describe('PacingEngine: a scope that cannot be read plans 0 (admission\'s direction)', () => {
  it('the account\'s allocation unreadable: 0 even on the service account', async () => {
    const r = rig([{ row: campaign('c1', 'a1'), agents: 3 }]);
    r.scopes.fail.shares = true;
    await r.e.runRound();
    expect(r.plan('c1')).toMatchObject({ plan: { toDial: 0, idle: 'no_slots' } });
    // It recovers by itself once the read does.
    r.scopes.fail.shares = false;
    r.clock.t += 1_000;
    await r.e.runRound();
    expect(r.toDial('c1')).toBe(3);
  });

  it('the share\'s counter unreadable (Redis): 0', async () => {
    const r = rig([{ row: campaign('c1', 'a1'), agents: 3 }]);
    r.scopes.shares.set('t1:a1', new Map([['voicelink', 3]]));
    r.scopes.fail.shareLive = true;
    await r.e.runRound();
    expect(r.toDial('c1')).toBe(0);
  });

  it('the carrier account\'s cap or its counter unreadable: 0; its service-account sibling dials on', async () => {
    settings.getMaxConcurrentCalls.mockResolvedValue(4);
    for (const which of ['cap', 'credentialLive'] as const) {
      const r = rig([
        { row: campaign('c-svc', 'a1'), agents: 4 },
        { row: campaign('c-cap', 'a1', onCredential), agents: 4 },
      ]);
      r.scopes.caps.set(CRED, 2);
      r.scopes.fail[which] = true;
      await r.e.runRound();
      expect(r.toDial('c-cap'), which).toBe(0);
      expect(r.toDial('c-svc'), which).toBe(4);
    }
  });
});

describe('PacingEngine: cached limits and their invalidation', () => {
  it('credential_limit_changed survives the wire (an IPC bus decodes it), and a malformed one is dropped', () => {
    expect(parsePacingInvalidationEvent({ type: 'credential_limit_changed', credentialId: CRED }))
      .toEqual({ type: 'credential_limit_changed', credentialId: CRED });
    expect(parsePacingInvalidationEvent({ type: 'credential_limit_changed' })).toBeNull();
    expect(parsePacingInvalidationEvent({ type: 'credential_limit_changed', credentialId: '' })).toBeNull();
  });

  it('a carrier account\'s cap is cached; credential_limit_changed drops it and wakes its campaigns', async () => {
    const r = rig([{ row: campaign('c1', 'a1', onCredential), agents: 4 }]);
    r.scopes.caps.set(CRED, 1);
    r.scopes.credentialLive.set(CRED, 1);
    await r.e.runRound();
    expect(r.plan('c1')).toMatchObject({ quiescent: true, plan: { toDial: 0 } });

    // The cap is raised in the database; with no event the engine keeps the cached one.
    r.scopes.caps.set(CRED, 3);
    r.bus.publish({ type: 'campaign_changed', campaignId: 'c1' }); // a wake, not the cap's event
    r.clock.t += 250;
    await r.e.runRound();
    expect(r.toDial('c1')).toBe(0);
    expect(r.scopes.reads.cap).toBe(1);

    // The seam's invalidation, decorated as `startAgency` does, announces it.
    const control = withPacingInvalidation({
      invalidateAccountLimit: vi.fn(), invalidateProviderLimits: vi.fn(), getAccountProviderCounts: vi.fn(),
      getProviderCount: vi.fn(), getAccountCount: vi.fn(), getDistributedAccountCount: vi.fn(),
      invalidateCredentialLimit: vi.fn().mockResolvedValue(undefined), getCredentialCounts: vi.fn(),
    }, (ev) => r.bus.publish(ev));
    await control.invalidateCredentialLimit(CRED);
    r.clock.t += 250;
    await r.e.runRound();
    expect(r.toDial('c1')).toBe(2);
    expect(r.scopes.reads.cap).toBe(2);
  });

  it('a carrier share is cached; account_limit_changed drops it', async () => {
    const r = rig([{ row: campaign('c1', 'a1'), agents: 4 }]);
    r.scopes.shares.set('t1:a1', new Map([['voicelink', 1]]));
    r.scopes.shareLive.set('t1:a1:voicelink', 1);
    await r.e.runRound();
    expect(r.toDial('c1')).toBe(0);
    r.scopes.shares.set('t1:a1', new Map([['voicelink', 4]]));
    r.bus.publish({ type: 'account_limit_changed', tenantId: 't1', accountId: 'a1' });
    r.clock.t += 250;
    await r.e.runRound();
    expect(r.toDial('c1')).toBe(3);
  });

  it('a campaign held by its carrier account\'s cap wakes when a call ends on ANOTHER account of the tenant', async () => {
    const r = rig([{ row: campaign('c1', 'a1', onCredential), agents: 4 }]);
    r.scopes.caps.set(CRED, 2);
    r.scopes.credentialLive.set(CRED, 2);
    await r.e.runRound();
    expect(r.plan('c1')).toMatchObject({ quiescent: true });
    r.clock.t += 250;
    await r.e.runRound();
    expect(r.ticks.at(-1)).toMatchObject({ campaignId: 'c1', mode: 'skipped' });

    r.scopes.credentialLive.set(CRED, 1);
    r.bus.publish({ type: 'account_capacity_freed', tenantId: 't1', accountId: 'a-other' });
    r.clock.t += 250;
    await r.e.runRound();
    expect(r.toDial('c1')).toBe(1);
  });
});

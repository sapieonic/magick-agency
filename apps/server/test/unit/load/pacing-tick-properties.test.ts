import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRng, LOAD_SEED, scaled } from '../../helpers/load-scale.js';

// ---------------------------------------------------------------------------
// The pacing tick's arithmetic as a PROPERTY, over thousands of seeded floors.
//
// `pacing-engine.test.ts` pins the controller case by case; this drives the same
// real `PacingEngine.tickOnce` through random combinations of pool size, station
// ownership, agent states, idle clocks, lost reservation races, account limit,
// occupancy and roster depth, and checks what must hold for every one of them:
//
//   target   = max(0, min(limit − occupied, idle owned agents))   — never negative
//   reserved ≤ target, reserved only from idle OWNED agents, longest idle first
//   claimed  = the claim asked for exactly `reserved` contacts
//   dialled  = min(reserved, contacts returned) ≤ limit − occupied ≤ limit
//   every reserved agent is either dialled for or handed straight back
//
// The repositories are mocked exactly as `pacing-engine.test.ts` mocks them; the
// gates run for real (all-day window, a DNC registry that clears).
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
      claimDialable: vi.fn(),
      unclaim: vi.fn().mockResolvedValue(undefined),
      unclaimMany: vi.fn().mockResolvedValue(undefined),
      markState: vi.fn().mockResolvedValue(true),
    },
    attempt: { countLive: vi.fn(), countLiveForAccount: vi.fn(), create: vi.fn(), setState: vi.fn().mockResolvedValue(null) },
    session: { findLiveForCampaign: vi.fn(), setState: vi.fn().mockResolvedValue(null) },
  },
  settings: { getMaxConcurrentCalls: vi.fn() },
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyCampaignRepository: repos.campaign,
  agencyContactRepository: repos.contact,
  agencyAttemptRepository: repos.attempt,
  agencyAgentSessionRepository: repos.session,
}));
vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({
  accountSettingsRepository: settings,
}));
vi.mock('../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => ({ isEnabled: vi.fn().mockResolvedValue(true) }),
  FLAGS: { agency_dialer_enabled: { key: 'agency_dialer_enabled', type: 'boolean', default: false } },
}));
vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: { log: vi.fn() } }));

import { PacingEngine } from '../../../src/agency/pacing-engine.js';

const CAMPAIGN = {
  id: 'camp-1', name: 'P', tenant_id: 't1', account_id: 'a1', status: 'running',
  caller_ids: ['+14155550100', '+14155550101'],
  calling_window_start: '00:00:00', calling_window_end: '24:00:00',
  calling_days: [1, 2, 3, 4, 5, 6, 7], default_timezone: 'UTC',
  pause_reason: null, paused_at: null, pause_abandonment_rate_pct: null, abandonment_ceiling_pct: 3,
} as const;

const STATES = ['available', 'available', 'available', 'on_call', 'reserved', 'wrapup', 'break', 'offline', null] as const;

interface Floor {
  sessions: string[];
  owned: Set<string>;
  state: Map<string, { state: string; since: number } | null>;
  loses: Set<string>;
  limit: number;
  occupied: number;
  roster: number;
}

function randomFloor(rng: ReturnType<typeof createRng>): Floor {
  const n = rng.int(0, 30);
  const sessions = Array.from({ length: n }, (_, i) => `s${String(i).padStart(2, '0')}`);
  const owned = new Set(sessions.filter(() => rng.chance(0.85)));
  const state = new Map<string, { state: string; since: number } | null>();
  for (const s of sessions) {
    const st = rng.pick(STATES);
    // Idle clocks with deliberate ties, so the tie-break on session id is exercised.
    state.set(s, st === null ? null : { state: st, since: 1_000 + rng.int(0, 20) * 1_000 });
  }
  const loses = new Set(sessions.filter(() => rng.chance(0.1)));
  return { sessions, owned, state, loses, limit: rng.int(0, 40), occupied: rng.int(0, 45), roster: rng.int(0, 40) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('pacing tick arithmetic, as a property (load)', () => {
  it(`holds the controller law on ${scaled(3000)} seeded floors`, async () => {
    const seed = LOAD_SEED;
    const rng = createRng(seed);
    const cases = scaled(3000);
    let dialledSomewhere = 0;
    let cappedByLimit = 0;
    let cappedByRoster = 0;
    let lostRaces = 0;

    const moduleMocks = [
      repos.campaign.findById, repos.session.findLiveForCampaign, settings.getMaxConcurrentCalls,
      repos.attempt.countLive, repos.attempt.countLiveForAccount, repos.attempt.create, repos.contact.claimDialable, repos.contact.unclaim,
      repos.contact.unclaimMany, repos.contact.markState,
    ];
    for (let k = 0; k < cases; k++) {
      for (const m of moduleMocks) m.mockClear();
      const f = randomFloor(rng);
      const tag = `case ${k} (seed ${seed}): ${JSON.stringify({ n: f.sessions.length, owned: f.owned.size, limit: f.limit, occupied: f.occupied, roster: f.roster })}`;

      repos.campaign.findById.mockResolvedValue(CAMPAIGN);
      repos.session.findLiveForCampaign.mockResolvedValue(f.sessions.map((id) => ({ id })));
      settings.getMaxConcurrentCalls.mockResolvedValue(f.limit);
      repos.attempt.countLiveForAccount.mockResolvedValue(f.occupied);
      repos.contact.claimDialable.mockImplementation(async (_c: string, limit: number) =>
        Array.from({ length: Math.min(limit, f.roster) }, (_, i) => ({
          id: `c${i}`, phone_e164: `+91987654${String(i).padStart(4, '0')}`, context: {}, attempt_count: 0, timezone: null,
        })));
      repos.attempt.create.mockImplementation(async (p: { contactId: string; callerId: string }) => ({
        id: `att-${p.contactId}`, caller_id: p.callerId, attempt_number: 1,
      }));

      // Plain recording doubles, not `vi.fn`: a fresh mock per case would make every
      // `mockClear` sweep walk thousands of dead mocks, and the suite quadratic.
      const reserveOrder: string[] = [];
      const setCalls: Array<[string, string]> = [];
      const dispatched: Array<{ sessionId: string; contactId: string }> = [];
      const agents = {
        getMany: async (ids: readonly string[]) => ids.map((id) => {
          const s = f.state.get(id);
          return s ? { state: s.state, attemptId: null, since: s.since } : null;
        }),
        get: async (id: string) => f.state.get(id) ?? null,
        reserve: async (id: string) => {
          reserveOrder.push(id);
          if (f.state.get(id)?.state !== 'available') return 'lost';
          return f.loses.has(id) ? 'lost' : 'reserved';
        },
        set: async (id: string, state: string) => { setCalls.push([id, state]); },
      };
      const stations = {
        isLocallyOwned: (id: string) => f.owned.has(id),
        ownerOf: async (id: string) => (f.owned.has(id) ? 'r1' : null),
        broadcast: () => 0,
        sessionIdsForCampaign: () => [...f.owned],
      };
      const dispatcher = { dispatch: async (cmd: { sessionId: string; contactId: string }) => { dispatched.push(cmd); } };
      const engine = new PacingEngine(
        null, '', 'r1', stations as never, agents as never, dispatcher as never,
        { check: async () => 'clear' } as never,
      );

      await engine.tickOnce('camp-1');

      // ── The reference model ────────────────────────────────────────────────
      const idle = f.sessions
        .filter((s) => f.owned.has(s) && f.state.get(s)?.state === 'available')
        .sort((a, b) => f.state.get(a)!.since - f.state.get(b)!.since || a.localeCompare(b));
      const target = Math.max(0, Math.min(f.limit - f.occupied, idle.length));

      // Reservation: only idle owned agents, strictly in longest-idle order, and
      // it stops the moment the target is met.
      expect(reserveOrder, tag).toEqual(idle.slice(0, reserveOrder.length));
      const reserved = reserveOrder.filter((s) => !f.loses.has(s));
      expect(reserved.length, tag).toBeLessThanOrEqual(target);
      if (target > 0) {
        // Every candidate is tried until the target is met or the list runs out.
        const expectReserved = Math.min(target, idle.filter((s) => !f.loses.has(s)).length);
        expect(reserved.length, tag).toBe(expectReserved);
      } else {
        expect(reserveOrder, tag).toEqual([]);
      }
      if (reserveOrder.some((s) => f.loses.has(s))) lostRaces++;

      // The claim asks for exactly the agents it holds — never more, never zero.
      if (reserved.length === 0) expect(repos.contact.claimDialable, tag).not.toHaveBeenCalled();
      else expect(repos.contact.claimDialable, tag).toHaveBeenCalledWith('camp-1', reserved.length);

      // Dialled = min(reserved, contacts), within every cap, never negative.
      const contacts = reserved.length === 0 ? 0 : Math.min(reserved.length, f.roster);
      expect(dispatched.length, tag).toBe(contacts);
      expect(dispatched.length, tag).toBeLessThanOrEqual(Math.max(0, f.limit - f.occupied));
      expect(dispatched.length, tag).toBeLessThanOrEqual(idle.length);
      // Each dial went to a DISTINCT reserved agent, paired with a distinct contact.
      const dialledAgents = dispatched.map((c) => c.sessionId);
      const dialledContacts = dispatched.map((c) => c.contactId);
      expect(new Set(dialledAgents).size, tag).toBe(dialledAgents.length);
      expect(new Set(dialledContacts).size, tag).toBe(dialledContacts.length);
      expect(dialledAgents, tag).toEqual(reserved.slice(0, contacts));
      // Every reserved agent not dialled for went straight back to the pool.
      const returned = setCalls.filter((c) => c[1] === 'available').map((c) => c[0]);
      expect(returned.sort(), tag).toEqual(reserved.slice(contacts).sort());

      if (contacts > 0) dialledSomewhere++;
      if (target > 0 && target === f.limit - f.occupied && f.limit - f.occupied < idle.length) cappedByLimit++;
      if (reserved.length > f.roster) cappedByRoster++;
    }
    // The generator reached every regime, so no clause held vacuously.
    expect(dialledSomewhere, `seed ${seed}`).toBeGreaterThan(cases / 4);
    expect(cappedByLimit, `seed ${seed}`).toBeGreaterThan(cases / 100);
    expect(cappedByRoster, `seed ${seed}`).toBeGreaterThan(cases / 100);
    expect(lostRaces, `seed ${seed}`).toBeGreaterThan(cases / 100);
  }, 60_000);
});

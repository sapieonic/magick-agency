import { describe, expect, it } from 'vitest';
import { heartbeatLeaseMs } from '../../../src/agency/station-socket.js';
import { AGENT_LEASE_MS, type AgentLiveState } from '../../../src/agency/agent-state-machine.js';
import type { AgencyAgentState } from '@magick-agency/contracts/agency';

/**
 * What a station heartbeat renews (`heartbeatLeaseMs`, docs/inbound.md §6): the lease of a
 * present agent whose state's end is not the TTL. `wrapup` only while this process vouches for
 * it: a campaign wrap-up held here, or an inbound outcome owed (the lease's `inbound` claim). The
 * integration proof over real Redis TTLs is `test/integration/telephony/inbound-wrapup-lease.test.ts`.
 */

const live = (state: AgencyAgentState, over: Partial<AgentLiveState> = {}): AgentLiveState => ({
  state, attemptId: null, since: 1, manualCallId: null, softphone: false, inboundCallId: null, ring: false, pushOffer: false, ...over,
});

describe('heartbeatLeaseMs', () => {
  it('renews available and break, as it always has', () => {
    expect(heartbeatLeaseMs(live('available'), false)).toBe(AGENT_LEASE_MS.available);
    expect(heartbeatLeaseMs(live('break'), false)).toBe(AGENT_LEASE_MS.break);
  });

  it('never renews away_ring (N2): a ping before the app parks its socket must not cut the 4 h TTL to 45 s', () => {
    expect(heartbeatLeaseMs(live('break', { ring: true }), false)).toBeNull();
    expect(heartbeatLeaseMs(live('break', { ring: true }), true)).toBeNull();
    // The plain break beside it is renewed as ever.
    expect(heartbeatLeaseMs(live('break', { ring: false }), false)).toBe(AGENT_LEASE_MS.break);
  });

  it('renews a campaign wrap-up this process holds, and an inbound wrap-up owing its outcome', () => {
    expect(heartbeatLeaseMs(live('wrapup', { attemptId: 'att-1' }), true)).toBe(AGENT_LEASE_MS.wrapup);
    expect(heartbeatLeaseMs(live('wrapup', { inboundCallId: 'ib-1' }), false)).toBe(AGENT_LEASE_MS.wrapup);
  });

  it('never renews a wrap-up nothing here vouches for (one a previous process left): it lapses', () => {
    expect(heartbeatLeaseMs(live('wrapup', { attemptId: 'att-old' }), false)).toBeNull();
  });

  it('leaves every state its owner renews, or nothing does, alone; and no lease at all', () => {
    for (const state of ['reserved', 'on_call', 'offline'] as const) {
      expect(heartbeatLeaseMs(live(state, { inboundCallId: 'ib-1' }), true), state).toBeNull();
    }
    expect(heartbeatLeaseMs(null, true)).toBeNull();
  });

  it('keeps a wrap-up alive across the console`s heartbeat grace (10 s pings, closed after 30 s of silence)', () => {
    expect(AGENT_LEASE_MS.wrapup).toBeGreaterThan(30_000);
  });
});

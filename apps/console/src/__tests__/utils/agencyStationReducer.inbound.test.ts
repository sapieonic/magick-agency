import { describe, it, expect } from 'vitest';
import { INITIAL_STATION_STATE, stationReducer, type StationState } from '../../utils/agencyStationReducer';
import type { AgencyStationCustomerWaitingFrame } from '../../types/inbound';
import { connected, inboundCall, owing } from '../helpers/inbound';

/**
 * The station's inbound transitions (P2): the `inbound_call` row replaced whole and kept newest,
 * kept through `ready` (the server restates it after `ready`), and the "Your customer is waiting"
 * pill retired by whatever makes it untrue, since no frame says the caller stopped waiting.
 */

const WAITING: AgencyStationCustomerWaitingFrame = {
  event: 'customer_waiting',
  inbound_call_id: 'ib-7',
  from_e164: '+919820461733',
  match_name: 'Asha Rao',
  waiting_since: '2026-11-09T10:00:00.000Z',
};

const waitingWhile = (state: StationState['agentState']): StationState => {
  const busy = stationReducer(INITIAL_STATION_STATE, { type: 'agent_state', frame: { event: 'agent_state', state, since: 'x' } });
  return stationReducer(busy, { type: 'customer_waiting', frame: WAITING });
};

describe('inbound_call', () => {
  it('holds the newest copy: a stale frame after a newer one changes nothing', () => {
    const offered = stationReducer(INITIAL_STATION_STATE, { type: 'inbound_call', call: inboundCall() });
    expect(offered.inboundCall?.state).toBe('offered');
    const live = stationReducer(offered, { type: 'inbound_call', call: connected() });
    expect(live.inboundCall?.state).toBe('connected');
    expect(stationReducer(live, { type: 'inbound_call', call: inboundCall() })).toBe(live);
    const ended = stationReducer(live, { type: 'inbound_call', call: owing() });
    expect(ended.inboundCall?.state).toBe('ended');
  });

  it('is kept through ready: the server restates it right after', () => {
    const held = stationReducer(INITIAL_STATION_STATE, { type: 'inbound_call', call: connected() });
    const ready = stationReducer(held, {
      type: 'ready',
      frame: { event: 'ready', session_id: 'sess-1', state: 'on_call' },
      wrapup: null,
    });
    expect(ready.inboundCall).toBe(held.inboundCall);
  });
});

describe('customer_waiting', () => {
  it('goes on the server`s clear for that caller; a clear for another caller changes nothing', () => {
    const waiting = waitingWhile('on_call');
    const other = stationReducer(waiting, { type: 'customer_waiting', frame: { ...WAITING, inbound_call_id: 'ib-9', cleared: true } });
    expect(other).toBe(waiting);
    expect(stationReducer(waiting, { type: 'customer_waiting', frame: { ...WAITING, cleared: true } }).customerWaiting).toBeNull();
  });

  it('stands while the agent is reserved, on a call or in wrap-up', () => {
    for (const state of ['reserved', 'on_call', 'wrapup'] as const) {
      const waiting = waitingWhile(state);
      expect(waiting.customerWaiting).toBe(WAITING);
      const next = stationReducer(waiting, { type: 'agent_state', frame: { event: 'agent_state', state: 'wrapup', since: 'y' } });
      expect(next.customerWaiting).toBe(WAITING);
    }
  });

  it('goes when the agent leaves the busy states: they were offered the caller, or cannot be', () => {
    for (const state of ['available', 'break', 'offline'] as const) {
      const next = stationReducer(waitingWhile('on_call'), {
        type: 'agent_state',
        frame: { event: 'agent_state', state, since: 'y' },
      });
      expect(next.customerWaiting, state).toBeNull();
    }
  });

  it('goes on an offer, and on ready (a snapshot: the server re-sends it while the caller waits)', () => {
    const offered = stationReducer(waitingWhile('wrapup'), { type: 'inbound_call', call: inboundCall({ id: 'ib-7' }) });
    expect(offered.customerWaiting).toBeNull();
    const ready = stationReducer(waitingWhile('on_call'), {
      type: 'ready',
      frame: { event: 'ready', session_id: 'sess-1', state: 'on_call' },
      wrapup: null,
    });
    expect(ready.customerWaiting).toBeNull();
  });

  it('stays on a connected or ended frame of another call (only an offer retires it)', () => {
    const waiting = waitingWhile('on_call');
    expect(stationReducer(waiting, { type: 'inbound_call', call: connected({ id: 'ib-3' }) }).customerWaiting).toBe(WAITING);
  });
});

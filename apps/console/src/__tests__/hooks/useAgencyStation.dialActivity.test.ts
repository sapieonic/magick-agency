import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ mintStationToken: vi.fn() }));
vi.mock('../../api/agency', () => ({ mintStationToken: mocks.mintStationToken }));

import { useAgencyStation } from '../../hooks/useAgencyStation';
import { FakeSocket, latestSocket as latest } from '../helpers/fakeSocket';
import { inboundCall } from '../helpers/inbound';
import type { AgencySessionBootstrap, AgencyReservedAttempt } from '../../types/agency';

/**
 * Late binding's `dial_activity` at the station socket: the frames the server sends, and what
 * the hook holds after each. Only the server's own sequences are driven here (the contract's
 * `AgencyDialActivity`): no `agent_state` is invented to move it.
 */

const ATTEMPT: AgencyReservedAttempt = {
  attempt_id: 'att-1',
  campaign_id: 'camp-1',
  campaign_name: 'Renewals',
  contact_id: 'c-1',
  phone_e164: '+919876543210',
  caller_id: '+911234567890',
  attempt_number: 1,
  context: {},
  prior_attempts: [],
};

const BOOTSTRAP: AgencySessionBootstrap = {
  session_id: 'sess-1',
  campaign_id: 'camp-1',
  campaign_name: 'Renewals',
  agent_user_id: 'u-1',
  state: 'offline',
  campaign_status: 'running',
  station_ws_url: '/proxy/agency/station/sess-1?token=t1',
  disposition_catalog: [],
  wrapup_seconds: 0,
  wrapup_auto_return: true,
  record_calls: false,
  break_reasons: [],
  context_display: {},
  intervals: {
    heartbeat_ms: 10_000,
    heartbeat_grace_ms: 30_000,
    reservation_lease_ms: 10_000,
    countdown_ms: 3000,
  },
};

const dial = (ringing: boolean, n: number, campaignId = 'camp-1') => ({
  event: 'dial_activity',
  campaign_id: campaignId,
  ringing,
  unanswered_in_a_row: n,
});

describe('useAgencyStation — dial_activity', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    mocks.mintStationToken.mockReset();
    vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function mounted() {
    const view = renderHook(() => useAgencyStation(BOOTSTRAP));
    await waitFor(() => expect(FakeSocket.instances.length).toBe(1));
    act(() => latest().open());
    await waitFor(() => expect(view.result.current.connection).toBe('open'));
    act(() => latest().emit({ event: 'ready', session_id: 'sess-1', state: 'available' }));
    return view;
  }

  it('is null until the server says anything (early binding never does)', async () => {
    const view = await mounted();
    expect(view.result.current.dialActivity).toBeNull();
  });

  it('follows an unanswered dial and the next one', async () => {
    const view = await mounted();
    act(() => latest().emit(dial(true, 0)));
    expect(view.result.current.dialActivity).toEqual({ ringing: true, unanswered_in_a_row: 0 });

    act(() => latest().emit(dial(false, 1)));
    act(() => latest().emit({ event: 'agent_state', state: 'available', since: '2026-08-11T10:00:30.000Z' }));
    expect(view.result.current.dialActivity).toEqual({ ringing: false, unanswered_in_a_row: 1 });

    act(() => latest().emit(dial(true, 1)));
    expect(view.result.current.dialActivity).toEqual({ ringing: true, unanswered_in_a_row: 1 });
  });

  it('clears on reserved: the server resets its count there and sends nothing to say so', async () => {
    const view = await mounted();
    act(() => latest().emit(dial(true, 4)));
    act(() => latest().emit({ event: 'reserved', attempt: ATTEMPT }));
    expect(view.result.current.dialActivity).toBeNull();
    expect(view.result.current.live?.attempt.attempt_id).toBe('att-1');
  });

  it('keeps the count when the customer cancelled the dial by ringing in', async () => {
    const view = await mounted();
    act(() => latest().emit(dial(true, 2)));
    // The inbound connector's offer, as it sends it: `dial_activity{false, n}` (the hidden dial
    // superseded, not unanswered), then `agent_state{reserved}` and `inbound_call` together.
    act(() => latest().emit(dial(false, 2)));
    act(() => latest().emit({ event: 'agent_state', state: 'reserved', since: '2026-11-09T10:00:00.000Z' }));
    act(() => latest().emit({ event: 'inbound_call', call: inboundCall() }));
    expect(view.result.current.dialActivity).toEqual({ ringing: false, unanswered_in_a_row: 2 });
    expect(view.result.current.agentState).toBe('reserved');
    expect(view.result.current.inboundCall?.id).toBe('ib-1');
    expect(view.result.current.live).toBeNull();
  });

  it('drops a frame for another campaign than the station’s', async () => {
    const view = await mounted();
    act(() => latest().emit(dial(true, 3, 'camp-other')));
    expect(view.result.current.dialActivity).toBeNull();
  });

  it('drops a malformed frame without dropping the socket', async () => {
    const view = await mounted();
    act(() => latest().emit({ event: 'dial_activity', campaign_id: 'camp-1', ringing: 'yes' }));
    expect(view.result.current.dialActivity).toBeNull();
    act(() => latest().emit({ event: 'dial_activity', campaign_id: 'camp-1', ringing: 'yes', unanswered_in_a_row: 1 }));
    act(() => latest().emit(dial(true, -1)));
    act(() => latest().emit(dial(true, 1.5)));
    expect(view.result.current.dialActivity).toBeNull();
    expect(view.result.current.connection).toBe('open');
  });

  it('ready with a malformed dial_activity reads it as absent, as the frame does', async () => {
    const view = await mounted();
    act(() => latest().emit(dial(true, 1)));
    act(() =>
      latest().emit({
        event: 'ready',
        session_id: 'sess-1',
        state: 'available',
        dial_activity: { ringing: 'yes', unanswered_in_a_row: 2 },
      }),
    );
    expect(view.result.current.dialActivity).toBeNull();
    expect(view.result.current.connection).toBe('open');
  });

  it('ready restates it on reconnect, and its absence clears it', async () => {
    const view = await mounted();
    act(() => latest().emit(dial(true, 1)));
    act(() =>
      latest().emit({
        event: 'ready',
        session_id: 'sess-1',
        state: 'available',
        dial_activity: { ringing: false, unanswered_in_a_row: 2 },
      }),
    );
    expect(view.result.current.dialActivity).toEqual({ ringing: false, unanswered_in_a_row: 2 });

    act(() => latest().emit({ event: 'ready', session_id: 'sess-1', state: 'available' }));
    expect(view.result.current.dialActivity).toBeNull();
  });
});

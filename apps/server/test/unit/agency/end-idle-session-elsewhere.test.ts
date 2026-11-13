import { beforeEach, describe, expect, it, vi } from 'vitest';

// OS7: a session in another tenant is ended only when nothing is there. Every signal that says
// "working" keeps it (the join is then refused `session_in_other_tenant`), and a failure keeps it.

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/config/index.js', () => ({ config: { redis: { keyPrefix: '' }, telephony: {} } }));

const { endIdleSessionElsewhere } = await import('../../../src/api/routes/agency/helpers.js');

const SESSION = { id: 'sess-there', tenant_id: 't-2' };

function runtime() {
  return {
    stations: { stationPresence: vi.fn(async (): Promise<'connected' | 'absent' | 'unknown'> => 'absent'), detach: vi.fn() },
    agents: { get: vi.fn(async (): Promise<{ state: string; ring?: boolean } | null> => ({ state: 'break' })), clear: vi.fn(async () => undefined) },
    dialer: { hasLiveAttempt: vi.fn(() => false), hasRedialInFlight: vi.fn(() => false) },
    softphone: { hasLiveCall: vi.fn(() => false) },
    inbound: { findCallForSession: vi.fn((): unknown => null) },
    awayRing: { sendRingOff: vi.fn() },
  };
}

let rt: ReturnType<typeof runtime>;
const leave = vi.fn(async () => undefined);

beforeEach(() => {
  rt = runtime();
  leave.mockClear();
});

describe('endIdleSessionElsewhere (OS7)', () => {
  it('ends an idle session as its own Leave would: lease cleared, row left, station detached', async () => {
    expect(await endIdleSessionElsewhere(rt, SESSION, leave)).toBe(true);
    expect(rt.agents.clear).toHaveBeenCalledWith('sess-there');
    expect(leave).toHaveBeenCalledWith('sess-there');
    expect(rt.stations.detach).toHaveBeenCalledWith('sess-there');
  });

  it('Mode B: ends a session on away_ring (its phone parked) and tells that phone left (not a take-over); a plain break sends nothing', async () => {
    rt.agents.get.mockResolvedValueOnce({ state: 'break', ring: true });
    const away = { ...SESSION, agent_user_id: 'agent-1', station_device_id: 'phone-1', away_ring_since: new Date() };
    expect(await endIdleSessionElsewhere(rt, away, leave)).toBe(true);
    expect(leave).toHaveBeenCalledWith('sess-there');
    // The ring_off names the absence it ends (`away_since`).
    expect(rt.awayRing.sendRingOff).toHaveBeenCalledWith('agent-1', 'phone-1', 'sess-there', 'left', away.away_ring_since);

    rt.awayRing.sendRingOff.mockClear();
    expect(await endIdleSessionElsewhere(rt, { ...away, away_ring_since: null }, leave)).toBe(true);
    expect(rt.awayRing.sendRingOff).not.toHaveBeenCalled();
  });

  it('Mode B: the row on an absence whose key lapsed still tells the phone', async () => {
    rt.agents.get.mockResolvedValueOnce(null);
    const since = new Date();
    expect(await endIdleSessionElsewhere(rt, { ...SESSION, agent_user_id: 'agent-1', station_device_id: 'phone-1', away_ring_since: since }, leave)).toBe(true);
    expect(rt.awayRing.sendRingOff).toHaveBeenCalledWith('agent-1', 'phone-1', 'sess-there', 'left', since);
  });

  it('ends one with no lease at all, or an offline one', async () => {
    rt.agents.get.mockResolvedValueOnce(null);
    expect(await endIdleSessionElsewhere(rt, SESSION, leave)).toBe(true);
    rt.agents.get.mockResolvedValueOnce({ state: 'offline' });
    expect(await endIdleSessionElsewhere(rt, SESSION, leave)).toBe(true);
  });

  it.each([
    ['a station attached', (r: ReturnType<typeof runtime>) => r.stations.stationPresence.mockResolvedValue('connected')],
    ['presence unknown', (r: ReturnType<typeof runtime>) => r.stations.stationPresence.mockResolvedValue('unknown')],
    ['available', (r: ReturnType<typeof runtime>) => r.agents.get.mockResolvedValue({ state: 'available' })],
    ['reserved', (r: ReturnType<typeof runtime>) => r.agents.get.mockResolvedValue({ state: 'reserved' })],
    ['on a call', (r: ReturnType<typeof runtime>) => r.agents.get.mockResolvedValue({ state: 'on_call' })],
    ['in wrap-up', (r: ReturnType<typeof runtime>) => r.agents.get.mockResolvedValue({ state: 'wrapup' })],
    ['a live attempt', (r: ReturnType<typeof runtime>) => r.dialer.hasLiveAttempt.mockReturnValue(true)],
    ['a redial being set up', (r: ReturnType<typeof runtime>) => r.dialer.hasRedialInFlight.mockReturnValue(true)],
    ['a live soft-phone call', (r: ReturnType<typeof runtime>) => r.softphone.hasLiveCall.mockReturnValue(true)],
    ['an inbound call', (r: ReturnType<typeof runtime>) => r.inbound.findCallForSession.mockReturnValue({ id: 'ib-1' })],
    ['a lease read that fails', (r: ReturnType<typeof runtime>) => r.agents.get.mockRejectedValue(new Error('redis down'))],
  ])('keeps a session with %s', async (_label, arrange) => {
    arrange(rt);
    expect(await endIdleSessionElsewhere(rt, SESSION, leave)).toBe(false);
    expect(leave).not.toHaveBeenCalled();
    expect(rt.agents.clear).not.toHaveBeenCalled();
  });
});

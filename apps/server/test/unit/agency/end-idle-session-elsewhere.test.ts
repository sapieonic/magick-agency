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
    agents: { get: vi.fn(async (): Promise<{ state: string } | null> => ({ state: 'break' })), clear: vi.fn(async () => undefined) },
    dialer: { hasLiveAttempt: vi.fn(() => false), hasRedialInFlight: vi.fn(() => false) },
    softphone: { hasLiveCall: vi.fn(() => false) },
    inbound: { findCallForSession: vi.fn((): unknown => null) },
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

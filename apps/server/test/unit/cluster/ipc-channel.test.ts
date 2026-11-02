import { afterEach, describe, expect, it, vi } from 'vitest';
import { IpcChannel, IpcRequestError } from '../../../src/cluster/ipc-channel.js';
import { memoryTransportPair, type MemoryTransportPair } from '../../helpers/ipc-memory-transport.js';

const tick = () => new Promise((r) => setImmediate(r));

function channels(opts: { maxInFlight?: number } = {}): { pair: MemoryTransportPair; primary: IpcChannel; child: IpcChannel } {
  const pair = memoryTransportPair();
  return {
    pair,
    primary: new IpcChannel(pair.a, { name: 'primary', ...opts }),
    child: new IpcChannel(pair.b, { name: 'child' }),
  };
}

const HEALTH = { role: 'analysis' as const, slot: 0, pid: 1, elu: 0.1, inFlight: 0, pausedForMs: 0, draining: false };

describe('IpcChannel', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('delivers a typed event to every handler, decoded', async () => {
    const { primary, child } = channels();
    const a = vi.fn();
    const b = vi.fn();
    child.onEvent('analysis.rate_paused', a);
    const off = child.onEvent('analysis.rate_paused', b);
    primary.emit('analysis.rate_paused', { untilMs: 10, consecutive: 1 });
    await tick();
    expect(a).toHaveBeenCalledWith({ untilMs: 10, consecutive: 1 });
    expect(b).toHaveBeenCalledTimes(1);
    off();
    primary.emit('analysis.rate_paused', { untilMs: 11, consecutive: 2 });
    await tick();
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('a handler that throws does not stop the others', async () => {
    const { primary, child } = channels();
    const after = vi.fn();
    child.onEvent('analysis.wake', () => { throw new Error('boom'); });
    child.onEvent('analysis.wake', after);
    primary.emit('analysis.wake', {});
    await tick();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('correlates concurrent requests with their answers, whatever order they finish in', async () => {
    const { primary, child } = channels();
    let n = 0;
    child.handle('health.ping', async () => {
      const mine = ++n;
      await new Promise((r) => setTimeout(r, mine === 1 ? 20 : 1));
      return { ...HEALTH, inFlight: mine };
    });
    const [first, second] = await Promise.all([primary.request('health.ping', {}), primary.request('health.ping', {})]);
    expect(first.inFlight).toBe(1);
    expect(second.inFlight).toBe(2);
    expect(primary.stats().inFlight).toBe(0);
  });

  it('times out at the deadline, and drops the late answer', async () => {
    const { primary, child } = channels();
    let release!: () => void;
    child.handle('health.ping', () => new Promise((r) => { release = () => r(HEALTH); }));
    const err = await primary.request('health.ping', {}, { deadlineMs: 20 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IpcRequestError);
    expect((err as IpcRequestError).code).toBe('timeout');
    release();
    await tick(); await tick();
    expect(primary.stats().late).toBe(1);
    expect(primary.stats().inFlight).toBe(0);
  });

  it('fails every outstanding request with gone when the channel closes, and refuses new ones', async () => {
    const { pair, primary, child } = channels();
    child.handle('health.ping', () => new Promise(() => {}));
    const pending = [primary.request('health.ping', {}), primary.request('shutdown', { graceMs: 1000 })];
    await tick();
    const closed = vi.fn();
    primary.onClose(closed);
    pair.disconnect();
    const errs = await Promise.all(pending.map((p) => p.catch((e: IpcRequestError) => e.code)));
    expect(errs).toEqual(['gone', 'gone']);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(primary.isClosed).toBe(true);
    await expect(primary.request('health.ping', {})).rejects.toMatchObject({ code: 'refused' });
    expect(primary.emit('analysis.wake', {})).toBe(false);
  });

  it('refuses past the in-flight cap instead of queueing', async () => {
    const { primary, child } = channels({ maxInFlight: 2 });
    child.handle('health.ping', () => new Promise(() => {}));
    void primary.request('health.ping', {}).catch(() => {});
    void primary.request('health.ping', {}).catch(() => {});
    await expect(primary.request('health.ping', {})).rejects.toMatchObject({ code: 'refused' });
    primary.close();
  });

  it('answers unsupported for a request with no handler, and handler_error when it throws', async () => {
    const { primary, child } = channels();
    await expect(primary.request('health.ping', {})).rejects.toMatchObject({ code: 'unsupported' });
    child.handle('shutdown', () => { throw new Error('nope'); });
    await expect(primary.request('shutdown', { graceMs: 5 })).rejects.toMatchObject({ code: 'handler_error', message: expect.stringContaining('nope') });
  });

  it('refuses a malformed request body at the receiver, without running the handler', async () => {
    const { primary, child } = channels();
    const handler = vi.fn(() => ({}));
    child.handle('shutdown', handler);
    await expect(primary.request('shutdown', { graceMs: -1 } as never)).rejects.toMatchObject({ code: 'malformed' });
    expect(handler).not.toHaveBeenCalled();
    expect(child.stats().malformed).toBe(1);
  });

  it('rejects a malformed response body instead of resolving with it', async () => {
    const { primary, child } = channels();
    child.handle('health.ping', () => ({ ...HEALTH, elu: 7 }));
    await expect(primary.request('health.ping', {})).rejects.toMatchObject({ code: 'malformed' });
  });

  it('drops a malformed event, an unknown event type and a non-envelope, and counts them', async () => {
    const { pair, child } = channels();
    const handler = vi.fn();
    child.onEvent('analysis.rate_paused', handler);
    pair.injectToB({ v: 1, kind: 'event', type: 'analysis.rate_paused', body: { untilMs: 'soon', consecutive: 1 } });
    pair.injectToB({ v: 1, kind: 'event', type: 'made.up', body: {} });
    pair.injectToB('not an envelope');
    await tick(); await tick();
    expect(handler).not.toHaveBeenCalled();
    expect(child.stats()).toMatchObject({ malformed: 2, unsupported: 1, received: 3 });
  });

  it('answers unsupported for an unknown request type rather than leaving it to time out', async () => {
    const { pair, child } = channels();
    pair.injectToB({ v: 1, kind: 'req', id: 99, type: 'made.up', body: {}, deadlineMs: 1000 });
    await tick(); await tick();
    expect(pair.sentByB).toContainEqual({ v: 1, kind: 'res', id: 99, ok: false, error: { code: 'unsupported', message: 'unknown request type made.up' } });
    expect(child.stats().unsupported).toBe(1);
  });

  it('counts a send Node reports over its backlog threshold, and still delivers it', async () => {
    const { pair, primary, child } = channels();
    const handler = vi.fn();
    child.onEvent('analysis.wake', handler);
    pair.backlogA = true;
    primary.emit('analysis.wake', {});
    await tick();
    expect(primary.stats().backlogged).toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('a channel built on a transport that is already closed is closed', () => {
    const pair = memoryTransportPair();
    pair.disconnect();
    const ch = new IpcChannel(pair.a, { name: 'late' });
    expect(ch.isClosed).toBe(true);
  });
});

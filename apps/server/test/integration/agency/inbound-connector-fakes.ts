/**
 * The bridge and the station sockets, faked in process, for the inbound connector's integration
 * suites (`inbound-connector-races.test.ts`, `inbound-connector-review-fixes.test.ts`): everything
 * else (Redis's compare-and-swaps, Postgres's guarded spine writes) is real.
 */
import { AGENCY_STATION_INBOUND_EVENTS } from '@magick-agency/contracts/agency';

type Lifecycle = import('../../../src/core/webrtc-bridge-manager.js').WebRtcLifecycleEvent;

/** The frames the registry sends only to a station that can take inbound calls (IQ43, IQ46). */
const INBOUND_EVENTS: ReadonlySet<string> = new Set(AGENCY_STATION_INBOUND_EVENTS);

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll `probe` every 10 ms until it answers something truthy (its answer), or fail after `ms`. */
export async function until<V>(what: string, probe: () => Promise<V | null | false> | V | null | false, ms = 5000): Promise<V> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v) return v as V;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(10);
  }
}

/** A gate a test opens when it wants: `{ wait, open }`. */
export function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => { open = r; });
  return { wait, open };
}

export class FakeWs {
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  send(s: string) { this.sent.push(JSON.parse(s) as Record<string, unknown>); }
}

export interface FakeStationEntry {
  sessionId: string; campaignId: string | null; tenantId: string; accountId: string; agentUserId: string;
  ws: FakeWs; clientKind: 'web' | 'mobile';
  /** The registry's `canTakeInbound`: a console, or a phone that declared `caps=inbound`. */
  canTakeInbound: boolean;
}

export class FakeStations {
  readonly entries = new Map<string, FakeStationEntry>();
  private readonly detachListeners = new Set<(sessionId: string, station: Omit<FakeStationEntry, 'ws'>) => void>();
  onDetached(l: (sessionId: string, station: Omit<FakeStationEntry, 'ws'>) => void) {
    this.detachListeners.add(l);
    return () => { this.detachListeners.delete(l); };
  }
  /**
   * The station socket closes as in production: the socket CLOSED, the entry detached (its
   * listeners told, with the station as it was), and the runtime's close handler's `onClosed`
   * (the connector's `onStationClosed`, then `offline` written) run after.
   */
  async close(id: string, onClosed?: () => Promise<void> | void): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.ws.readyState = 3;
    this.entries.delete(id);
    const { ws: _ws, ...station } = entry;
    for (const l of this.detachListeners) l(id, station);
    await onClosed?.();
  }
  /** The same station back on a new socket (a reconnect). */
  reattach(station: Omit<FakeStationEntry, 'ws'>): FakeStationEntry {
    const entry = { ...station, ws: new FakeWs() };
    this.entries.set(station.sessionId, entry);
    return entry;
  }
  add(e: Omit<FakeStationEntry, 'ws' | 'clientKind' | 'canTakeInbound'> & { clientKind?: 'web' | 'mobile'; canTakeInbound?: boolean }): FakeStationEntry {
    const clientKind = e.clientKind ?? 'web';
    // The registry's default: a console can take inbound calls, a phone only when it says so.
    const entry = { ...e, clientKind, canTakeInbound: e.canTakeInbound ?? clientKind !== 'mobile', ws: new FakeWs() };
    this.entries.set(e.sessionId, entry);
    return entry;
  }
  all() { return [...this.entries.values()]; }
  get(id: string) { return this.entries.get(id); }
  socketFor(id: string) { return this.entries.get(id)?.ws; }
  isLocallyOwned(id: string) { return this.entries.has(id); }
  send(id: string, frame: unknown) {
    const entry = this.entries.get(id);
    const ws = entry?.ws;
    if (!ws || ws.readyState !== 1) return false;
    // The registry's one send-path rule (`StationRegistry.send`): no inbound frame to a station
    // that cannot take inbound calls.
    const event = (frame as { event?: string }).event;
    if (!entry.canTakeInbound && event !== undefined && INBOUND_EVENTS.has(event)) return false;
    ws.send(JSON.stringify(frame));
    return true;
  }
  broadcast() { return 0; }
}

export class FakeBridge {
  readonly listeners = new Set<(ev: Lifecycle) => void>();
  readonly live = new Map<string, { bound: boolean; ending?: boolean; hold?: (r: 'released' | 'aborted') => void }>();
  binds: string[] = [];
  /** While set, the preamble (greeting, notice) is still playing: `onPreambleDone` waits for it. */
  preambleGate: Promise<void> | null = null;
  /** While set, the overflow message is still playing (`playClipSequenceThenHangUp` waits for it). */
  clipGate: Promise<void> | null = null;
  /**
   * The next bind of these calls is refused: `ending` marks the call tearing down first (its
   * `ended` follows when the test ends it), `other` refuses with the call still live (a leg the
   * bridge says is already bound), `socket_closed` with the agent's socket closing just then
   * (after the connector's check, before the bridge's).
   */
  readonly refuseBind = new Map<string, 'ending' | 'other' | 'socket_closed'>();
  onLifecycle(l: (ev: Lifecycle) => void) { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  take(id: string) { this.live.set(id, { bound: false }); }
  playInboundHold(id: string, opts: { onPreambleDone?: () => void }) {
    const c = this.live.get(id);
    if (!c) return Promise.resolve('not_found' as const);
    const preamble = this.preambleGate ?? Promise.resolve();
    return new Promise<'released' | 'aborted'>((resolve) => {
      c.hold = resolve;
      void preamble.then(() => setImmediate(() => { if (this.live.has(id)) opts.onPreambleDone?.(); }));
    });
  }
  stopInboundHold(id: string) { this.live.get(id)?.hold?.('released'); }
  bindBorrowedBrowserLeg(id: string, ws: FakeWs) {
    const c = this.live.get(id);
    const refusal = this.refuseBind.get(id);
    if (refusal) {
      this.refuseBind.delete(id);
      if (c && refusal === 'ending') c.ending = true;
      if (refusal === 'socket_closed') ws.readyState = 3;
      return false;
    }
    if (!c || c.ending || c.bound || ws.readyState !== 1) return false;
    c.bound = true;
    this.binds.push(id);
    c.hold?.('released');
    this.emit({ phase: 'bridged', correlationId: id });
    return true;
  }
  isCallEnding(id: string) {
    const c = this.live.get(id);
    return !c || c.ending === true;
  }
  reattachBorrowedBrowserLeg() { return true; }
  async forceEndWithOutcome(id: string, outcome: string) { return this.end(id, outcome); }
  async playClipSequenceThenHangUp(id: string) {
    if (this.clipGate) await this.clipGate;
    this.end(id, 'inbound_overflow');
    return 'completed' as const;
  }
  async acceptInboundCall() { throw new Error('not used'); }
  end(id: string, outcome = 'pstn_stream_closed', talkTimeSeconds = 0): boolean {
    const c = this.live.get(id);
    if (!c) return false;
    this.live.delete(id);
    c.hold?.('aborted');
    this.emit({ phase: 'ended', correlationId: id, outcome, status: 'completed', talkTimeSeconds });
    return true;
  }
  emit(ev: Partial<Lifecycle> & { phase: Lifecycle['phase'] }) {
    for (const l of this.listeners) l({ callId: 'leg', answered: true, ...ev } as Lifecycle);
  }
}

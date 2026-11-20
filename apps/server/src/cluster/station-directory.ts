/**
 * The primary's view of where the agents' station sockets are, with media workers
 * (`docs/scaling.md` §1.4, §5.2). It is what pacing reads in place of the
 * `StationRegistry` a single process has (`PacingStations`):
 *
 *  - **attached**: the workers tell it over IPC (`station.attached` / `station.detached`,
 *    and a full `station.snapshot` when a worker becomes ready). A worker's entries are
 *    dropped the moment its process exits, so pacing stops picking its agents at once.
 *  - **owner**: the Redis ownership key, as in one process, but a key naming a replica
 *    that is not alive (a crashed worker's, until its 30 s TTL lapses) is no owner. The
 *    primary knows exactly which replicas are alive: the ones whose channel is open.
 *  - **broadcast**: a campaign frame goes to every worker, which sends it to its own
 *    stations; the count returned (logged only) is what the directory knows is attached.
 *  - **send**: one agent's frame goes to the worker holding that station (the contact-assignment
 *    `queue` frame); true when a live worker holds it, which is all the primary can know.
 *
 * Routing never reads it: the owner of a session is `slotFor(sessionId)`, attached or not.
 */
import type { AgencyStationCapability, AgencyStationServerFrame } from '@magick-agency/contracts/agency';
import type { PacingStations } from '../agency/pacing-engine.js';
import { StationDetachTimes, type StationDisconnectsReader } from '../agency/station-detach-times.js';

const NO_CAPS: ReadonlySet<AgencyStationCapability> = new Set();

interface Entry {
  slot: number;
  campaignId: string | null;
  replicaId: string;
}

export interface StationDirectoryDeps {
  /** The Redis ownership key's replica id (`StationRegistry.ownerOf`, any process's registry). */
  readOwner: (sessionId: string) => Promise<string | null>;
  /** Send a campaign frame to every ready worker. */
  broadcastToWorkers: (campaignId: string, frame: AgencyStationServerFrame) => void;
  /** Send one session's frame to the worker in `slot`; false when that worker has no open channel. */
  sendToWorker: (slot: number, sessionId: string, frame: AgencyStationServerFrame) => boolean;
}

export class StationDirectory implements PacingStations, StationDisconnectsReader {
  private readonly entries = new Map<string, Entry>();
  /**
   * Agent station (BE-11): when each worker's station went, as the primary hears it (a
   * `station.detached`, or the worker's exit for every station it held); forgotten when one attaches
   * again. The primary's floor and alerts reads take it in place of its own registry's, which holds
   * no stations.
   */
  private readonly detachTimes = new StationDetachTimes();
  /** replicaId → slot, for the workers alive now. */
  private readonly liveReplicas = new Map<string, number>();

  constructor(private readonly deps: StationDirectoryDeps) {}

  /** A worker became ready under `replicaId`. */
  workerUp(slot: number, replicaId: string): void {
    for (const [id, s] of this.liveReplicas) if (s === slot) this.liveReplicas.delete(id);
    this.liveReplicas.set(replicaId, slot);
  }

  /** A worker's process exited (or its channel closed): forget everything it held. */
  workerDown(slot: number): void {
    for (const [id, s] of this.liveReplicas) if (s === slot) this.liveReplicas.delete(id);
    for (const [sessionId, e] of this.entries) {
      if (e.slot !== slot) continue;
      this.entries.delete(sessionId);
      this.detachTimes.detached(sessionId);
    }
  }

  /** The replica ids of the workers alive now. */
  liveReplicaIds(): string[] {
    return [...this.liveReplicas.keys()];
  }

  isLiveReplica(replicaId: string): boolean {
    return this.liveReplicas.has(replicaId);
  }

  slotOfReplica(replicaId: string): number | null {
    return this.liveReplicas.get(replicaId) ?? null;
  }

  attached(slot: number, sessionId: string, campaignId: string | null, replicaId: string): void {
    if (this.liveReplicas.get(replicaId) !== slot) return; // a late event from a dead incarnation
    this.entries.set(sessionId, { slot, campaignId, replicaId });
    this.detachTimes.attached(sessionId);
  }

  detached(slot: number, sessionId: string): void {
    if (this.entries.get(sessionId)?.slot !== slot) return;
    this.entries.delete(sessionId);
    this.detachTimes.detached(sessionId);
  }

  /** Replace everything a worker holds with its own list (on ready, and on reconcile). */
  snapshot(slot: number, replicaId: string, sessions: ReadonlyArray<{ sessionId: string; campaignId: string | null }>): void {
    if (this.liveReplicas.get(replicaId) !== slot) return;
    for (const [sessionId, e] of this.entries) if (e.slot === slot) this.entries.delete(sessionId);
    for (const s of sessions) {
      this.entries.set(s.sessionId, { slot, campaignId: s.campaignId, replicaId });
      this.detachTimes.attached(s.sessionId);
    }
  }

  countForSlot(slot: number): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.slot === slot) n++;
    return n;
  }

  // ─── PacingStations ──────────────────────────────────────────────────────

  /** Attached to a live worker: an agent pacing can have dialled. */
  isLocallyOwned(sessionId: string): boolean {
    const e = this.entries.get(sessionId);
    return !!e && this.liveReplicas.get(e.replicaId) === e.slot;
  }

  async ownerOf(sessionId: string): Promise<string | null> {
    const owner = await this.deps.readOwner(sessionId);
    return owner !== null && this.liveReplicas.has(owner) ? owner : null;
  }

  /**
   * The station's campaign. No capability is known here (`caps` is empty): with media workers no
   * inbound caller is put through to an agent (IB8; IQ13: every open route answers with the
   * call-back message), so pacing never holds a worker's station back for one.
   */
  get(sessionId: string): { campaignId: string | null; caps: ReadonlySet<AgencyStationCapability> } | undefined {
    const e = this.entries.get(sessionId);
    return e ? { campaignId: e.campaignId, caps: NO_CAPS } : undefined;
  }

  broadcast(campaignId: string, frame: AgencyStationServerFrame): number {
    this.deps.broadcastToWorkers(campaignId, frame);
    let n = 0;
    for (const e of this.entries.values()) if (e.campaignId === campaignId) n++;
    return n;
  }

  send(sessionId: string, frame: AgencyStationServerFrame): boolean {
    if (!this.isLocallyOwned(sessionId)) return false;
    return this.deps.sendToWorker(this.entries.get(sessionId)!.slot, sessionId, frame);
  }

  size(): number {
    return this.entries.size;
  }

  /** Agent station (BE-11): when each of these sessions' worker station went, if it has not come back. */
  disconnectedSince(sessionIds: readonly string[]): Map<string, Date> {
    return this.detachTimes.disconnectedSince(sessionIds);
  }

  /** Every session whose worker station went and has not come back. */
  goneSessionIds(): string[] {
    return this.detachTimes.goneSessionIds();
  }
}

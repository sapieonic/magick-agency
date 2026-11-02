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
 *
 * Routing never reads it: the owner of a session is `slotFor(sessionId)`, attached or not.
 */
import type { AgencyStationServerFrame } from '@magick-agency/contracts/agency';
import type { PacingStations } from '../agency/pacing-engine.js';

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
}

export class StationDirectory implements PacingStations {
  private readonly entries = new Map<string, Entry>();
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
    for (const [sessionId, e] of this.entries) if (e.slot === slot) this.entries.delete(sessionId);
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
  }

  detached(slot: number, sessionId: string): void {
    if (this.entries.get(sessionId)?.slot === slot) this.entries.delete(sessionId);
  }

  /** Replace everything a worker holds with its own list (on ready, and on reconcile). */
  snapshot(slot: number, replicaId: string, sessions: ReadonlyArray<{ sessionId: string; campaignId: string | null }>): void {
    if (this.liveReplicas.get(replicaId) !== slot) return;
    for (const [sessionId, e] of this.entries) if (e.slot === slot) this.entries.delete(sessionId);
    for (const s of sessions) this.entries.set(s.sessionId, { slot, campaignId: s.campaignId, replicaId });
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

  get(sessionId: string): { campaignId: string | null } | undefined {
    const e = this.entries.get(sessionId);
    return e ? { campaignId: e.campaignId } : undefined;
  }

  broadcast(campaignId: string, frame: AgencyStationServerFrame): number {
    this.deps.broadcastToWorkers(campaignId, frame);
    let n = 0;
    for (const e of this.entries.values()) if (e.campaignId === campaignId) n++;
    return n;
  }

  size(): number {
    return this.entries.size;
  }
}

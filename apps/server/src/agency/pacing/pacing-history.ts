/**
 * The pacing history writer (IN2, `docs/insights.md`): what the pacing tick decided, kept per
 * campaign per UTC minute in `agency_campaign_pacing_minutes` (migration 0013).
 *
 * Two ways in, by where the event happens:
 *
 *  - **{@link PacingHistoryAccumulator}**, owned by the pacing engine, which runs in the process
 *    that leads campaigns (the primary with media workers, `docs/scaling.md` §1.3). The engine
 *    counts into it next to each metric increment (`recordIdle`, `recordGate`, a tick, a dial);
 *    it adds in memory and flushes ONE additive upsert every {@link PACING_HISTORY_FLUSH_MS}, when
 *    the engine gives a campaign up (`relinquish`: stopped, completed, gated, lease lost) and on
 *    shutdown (`halt`).
 *  - **{@link recordPacingEvent}**, one single-row additive upsert, for the events outside the
 *    tick: a wrap-up redial refused at the limit (an HTTP request, served by the media worker
 *    holding the agent's station) and an our-fault retirement (the dialer's settlement in a media
 *    worker, the soft phone's, and the reaper's in the primary). Rare, so a write each; the
 *    upsert is additive, so it and the leader's batch add up on the same minute row.
 *
 * ── Best effort, by construction ──────────────────────────────────────────────
 * Telemetry is what we sacrifice; dialling is not (the rule `recordGate` states). Counting is
 * synchronous arithmetic that cannot throw into a tick. A flush runs off the tick, one at a time,
 * and never rejects: a failed batch is merged back to be sent with the next one (the upsert is
 * additive, so a retry adds what the failure did not) and counted on
 * `agency_pacing_history_write_failures_total{path="batch"}`. Memory is bounded: beyond
 * {@link PACING_HISTORY_MAX_PENDING} closed minutes waiting to be written the oldest are dropped,
 * with a WARN and `agency_pacing_history_dropped_total`. A direct write that fails is logged,
 * counted (`path="direct"`) and lost; it never fails the request or settlement it rides on.
 *
 * ── The tick hot path ─────────────────────────────────────────────────────────
 * {@link PacingHistoryAccumulator.count} is a map lookup and an array increment. It allocates
 * only when a campaign's minute rolls over (a new slot of {@link PACING_HISTORY_FIELDS}.length
 * counters, once a minute per campaign); the closed one moves to the pending map unchanged.
 */
import { createChildLogger } from '@magick-agency/observability';
import {
  agencyPacingHistoryDroppedTotal,
  agencyPacingHistoryWriteFailuresTotal,
} from '@magick-agency/observability/metrics/agency';
import {
  agencyInsightsPacingRepository,
  type PacingMinuteRow,
} from '../../db/repositories/agency.repository.js';
import { PACING_HISTORY_FIELDS, type PacingHistoryField } from './pacing-history-fields.js';
import { safeEmit } from '../../utils/safe-emit.js';

const log = createChildLogger({ component: 'agency-pacing-history' });

/** How often the leader writes what it counted. */
export const PACING_HISTORY_FLUSH_MS = 15_000;

/**
 * The most closed campaign-minutes held unwritten (while flushes fail). One campaign is one row
 * a minute, so this is a little under 7 hours of one campaign's history, or 20 minutes of 500
 * campaigns', at ~200 bytes a row.
 */
export const PACING_HISTORY_MAX_PENDING = 10_000;

/** How long the shutdown flush may take before shutdown goes on without it. */
export const PACING_HISTORY_CLOSE_TIMEOUT_MS = 3_000;

const MINUTE_MS = 60_000;
const FIELD_COUNT = PACING_HISTORY_FIELDS.length;
const FIELD_INDEX = Object.fromEntries(PACING_HISTORY_FIELDS.map((f, i) => [f, i])) as Record<PacingHistoryField, number>;

/** Where the batches go. The repository in production; tests pass their own. */
export interface PacingHistorySink {
  upsertMinutes(rows: readonly PacingMinuteRow[]): Promise<unknown>;
}

interface Slot {
  campaignId: string;
  tenantId: string;
  minuteStart: number;
  counts: number[];
  /** Counted into since it was last flushed. */
  dirty: boolean;
}

export interface PacingHistoryAccumulatorOptions {
  /** Default: the repository. */
  sink?: PacingHistorySink;
  /** Default `Date.now`: the minute a count lands in is the wall clock's. */
  now?: () => number;
  flushIntervalMs?: number;
  maxPending?: number;
  closeTimeoutMs?: number;
}

const repositorySink: PacingHistorySink = {
  upsertMinutes: (rows) => agencyInsightsPacingRepository.upsertMinutes(rows),
};

function keyOf(campaignId: string, minuteStart: number): string {
  return `${campaignId}|${minuteStart}`;
}

export class PacingHistoryAccumulator {
  /** Each campaign's open minute. */
  private readonly current = new Map<string, Slot>();
  /** Closed minutes (and failed batches) waiting to be written, oldest first, keyed campaign|minute. */
  private pending = new Map<string, Slot>();
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private readonly sink: PacingHistorySink;
  private readonly now: () => number;
  private readonly flushIntervalMs: number;
  private readonly maxPending: number;
  private readonly closeTimeoutMs: number;

  constructor(options: PacingHistoryAccumulatorOptions = {}) {
    this.sink = options.sink ?? repositorySink;
    this.now = options.now ?? Date.now;
    this.flushIntervalMs = options.flushIntervalMs ?? PACING_HISTORY_FLUSH_MS;
    this.maxPending = options.maxPending ?? PACING_HISTORY_MAX_PENDING;
    this.closeTimeoutMs = options.closeTimeoutMs ?? PACING_HISTORY_CLOSE_TIMEOUT_MS;
  }

  /** Add `n` to `field` of `campaignId`'s current minute. Synchronous; never throws. */
  count(campaignId: string, tenantId: string, field: PacingHistoryField, n = 1): void {
    const t = this.now();
    const minuteStart = t - (t % MINUTE_MS);
    let slot = this.current.get(campaignId);
    if (slot === undefined || slot.minuteStart !== minuteStart) {
      if (slot !== undefined && slot.dirty) this.retire(slot);
      slot = { campaignId, tenantId, minuteStart, counts: new Array<number>(FIELD_COUNT).fill(0), dirty: false };
      this.current.set(campaignId, slot);
    }
    slot.counts[FIELD_INDEX[field]]! += n;
    slot.dirty = true;
  }

  /** Arm the flush timer. Idempotent. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.flush(); }, this.flushIntervalMs);
    this.timer.unref?.();
  }

  /**
   * Shutdown: no more timer, then everything counted so far written once more, bounded by the
   * close timeout (a database that does not answer must not hold the process past its grace).
   * Never rejects.
   */
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    let timeout: NodeJS.Timeout | undefined;
    const bound = new Promise<'timeout'>((resolve) => {
      timeout = setTimeout(() => resolve('timeout'), this.closeTimeoutMs);
      timeout.unref?.();
    });
    const done = (async () => {
      await this.flushing;
      await this.flush();
      return 'done' as const;
    })();
    const result = await Promise.race([done, bound]);
    clearTimeout(timeout);
    if (result === 'timeout') {
      log.warn({ pendingMinutes: this.pendingMinutes() }, 'Pacing history flush did not finish before shutdown — those minutes are lost');
    }
  }

  /**
   * Write everything counted so far: the closed minutes and each campaign's open one (its counts
   * so far, which are then zeroed: the next flush adds what came after). One flush at a time;
   * a call while one runs returns that one. Never rejects.
   */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushOnce().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  /** Closed and open minutes not yet written (tests and the shutdown log). */
  pendingMinutes(): number {
    let open = 0;
    for (const slot of this.current.values()) if (slot.dirty) open++;
    return this.pending.size + open;
  }

  /** What is counted and unwritten for one campaign's minute (tests). */
  peek(campaignId: string, minuteStart?: number): Partial<Record<PacingHistoryField, number>> {
    const out: Partial<Record<PacingHistoryField, number>> = {};
    const add = (slot: Slot | undefined) => {
      if (!slot) return;
      PACING_HISTORY_FIELDS.forEach((f, i) => { if (slot.counts[i]) out[f] = (out[f] ?? 0) + slot.counts[i]!; });
    };
    const open = this.current.get(campaignId);
    if (minuteStart === undefined) {
      add(open);
      for (const slot of this.pending.values()) if (slot.campaignId === campaignId) add(slot);
    } else {
      if (open?.minuteStart === minuteStart) add(open);
      add(this.pending.get(keyOf(campaignId, minuteStart)));
    }
    return out;
  }

  private async flushOnce(): Promise<void> {
    const t = this.now();
    const currentMinute = t - (t % MINUTE_MS);
    const batch: Slot[] = [...this.pending.values()];
    this.pending = new Map();
    for (const [campaignId, slot] of this.current) {
      if (slot.dirty) {
        batch.push({ ...slot, counts: slot.counts.slice() });
        slot.counts.fill(0);
        slot.dirty = false;
      } else if (slot.minuteStart < currentMinute) {
        // Nothing counted since the last flush and the minute is over: a campaign this engine no
        // longer ticks. Dropped, so the map holds only campaigns still counting.
        this.current.delete(campaignId);
      }
    }
    if (batch.length === 0) return;
    try {
      await this.sink.upsertMinutes(batch);
    } catch (err) {
      safeEmit('agency-pacing-history-failure', () => agencyPacingHistoryWriteFailuresTotal.inc({ path: 'batch' }));
      log.warn({ err, minutes: batch.length }, 'Pacing history flush failed — kept for the next flush');
      // Back in front of whatever was closed meanwhile (older first), merged by key.
      const restored = new Map<string, Slot>();
      for (const slot of [...batch, ...this.pending.values()]) {
        const key = keyOf(slot.campaignId, slot.minuteStart);
        const hit = restored.get(key);
        if (hit) for (let i = 0; i < FIELD_COUNT; i++) hit.counts[i]! += slot.counts[i]!;
        else restored.set(key, { ...slot, counts: slot.counts.slice(), dirty: true });
      }
      this.pending = restored;
      this.enforceCap();
    }
  }

  /** Move a finished minute to the pending map (merging with a restored copy of it). */
  private retire(slot: Slot): void {
    const key = keyOf(slot.campaignId, slot.minuteStart);
    const hit = this.pending.get(key);
    if (hit) for (let i = 0; i < FIELD_COUNT; i++) hit.counts[i]! += slot.counts[i]!;
    else this.pending.set(key, slot);
    this.enforceCap();
  }

  private enforceCap(): void {
    const over = this.pending.size - this.maxPending;
    if (over <= 0) return;
    // Oldest first: the map is in insertion order, and every path inserts older minutes first.
    let dropped = 0;
    for (const key of this.pending.keys()) {
      if (dropped >= over) break;
      this.pending.delete(key);
      dropped++;
    }
    safeEmit('agency-pacing-history-dropped', () => agencyPacingHistoryDroppedTotal.inc(dropped));
    log.warn({ dropped, cap: this.maxPending }, 'Pacing history over its pending cap — dropped the oldest unwritten minutes');
  }
}

/**
 * One pacing history event outside the tick, written now as a single-row additive upsert.
 * Never rejects: a failure is logged, counted and lost. Awaitable, so a caller (and a test) can
 * know it landed; a caller on a latency-sensitive path may leave it un-awaited.
 */
export async function recordPacingEvent(
  campaignId: string,
  tenantId: string,
  field: PacingHistoryField,
  at: Date = new Date(),
): Promise<void> {
  try {
    await agencyInsightsPacingRepository.addToMinute({ campaignId, tenantId, field, at });
  } catch (err) {
    safeEmit('agency-pacing-history-failure', () => agencyPacingHistoryWriteFailuresTotal.inc({ path: 'direct' }));
    log.warn({ err, campaignId, field }, 'Pacing history write failed — this event is not recorded');
  }
}

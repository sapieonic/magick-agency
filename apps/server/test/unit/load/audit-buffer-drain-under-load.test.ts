import { describe, expect, it, vi } from 'vitest';
import { scaled } from '../../helpers/load-scale.js';

/**
 * The two buffered audit writers (`src/audit/audit-buffer.ts` → `audit_logs`,
 * `src/audit/platform/audit-buffer.ts` → `platform_audit_log`) under the load a full floor
 * produces: every audited API call pushes a row, and the 100th push starts a flush
 * WITHOUT awaiting it. Shutdown then drains with `forceFlush()`.
 *
 * What it pins, for both buffers:
 *  1. **No busy-wait.** A `forceFlush()` that lands while a buffer-full flush is still
 *     writing, with rows pushed after that flush took its snapshot, must WAIT for the
 *     in-flight write. A loop of `await this.flush()` that returns early while
 *     `flushing` is set is a microtask-only loop: it never yields to the event loop, so
 *     the in-flight INSERT can never complete and the process spins at 100% CPU forever
 *     on the shutdown path. Detected without hanging the worker: the instance's `flush`
 *     is wrapped to count calls, and past a ceiling it releases the in-flight write
 *     itself (a microtask), so the bug shows up as a call count, not a hang.
 *  2. **Drained means written.** `forceFlush()` must not resolve while a batch is still
 *     in flight: the platform stop closes the pool right after it, and a batch still
 *     writing then fails, is re-buffered, and is lost with the process.
 *  3. Every pushed row is written exactly once, in push order.
 *
 * The insert is a deferred resolved on a TIMER (a macrotask), as a real pg round trip is.
 * Mutation-checked: restoring the early-return `forceFlush` loop reds 1 and 2.
 */

interface Deferred { resolve: () => void; promise: Promise<void> }
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { resolve, promise };
}

const io = vi.hoisted(() => ({
  written: [] as unknown[][],
  pending: [] as Array<{ release: () => void }>,
}));

/** An insert that completes on a timer, like a real round trip; `release` short-cuts it. */
function slowInsert(rows: unknown[]): Promise<void> {
  const d = deferred();
  const timer = setTimeout(() => d.resolve(), 15);
  io.pending.push({ release: () => { clearTimeout(timer); d.resolve(); } });
  return d.promise.then(() => { io.written.push(rows); });
}

vi.mock('@magick-agency/db/repositories/audit.repository', () => ({
  auditRepository: { insertBatch: (rows: unknown[]) => slowInsert(rows) },
}));
vi.mock('@magick-agency/db/repositories/platform/audit.repository', () => ({
  auditRepository: { insertBatch: (rows: unknown[]) => slowInsert(rows) },
}));

const { AuditBuffer: CoreAuditBuffer } = await import('../../../src/audit/audit-buffer.js');
const { AuditBuffer: PlatformAuditBuffer } = await import('../../../src/audit/platform/audit-buffer.js');

/** The flush-call ceiling past which the wrapper concludes forceFlush is spinning. */
const SPIN_CEILING = 5_000;

type AnyBuffer = { push(e: unknown): void; flush(): Promise<void>; forceFlush(): Promise<void> };

/** Wrap the instance's flush to count calls and break a spin (see the header). */
function instrument(buffer: AnyBuffer): { calls: () => number } {
  const original = buffer.flush.bind(buffer);
  let calls = 0;
  buffer.flush = async () => {
    calls++;
    if (calls === SPIN_CEILING) for (const p of io.pending.splice(0)) p.release();
    return original();
  };
  return { calls: () => calls };
}

const event = (i: number) => ({ tenantId: 't', accountId: 'a', eventType: `e${i}`, eventCategory: 'system', severity: 'info', eventData: { i } });

describe.each([
  ['audit_logs buffer', () => new CoreAuditBuffer() as unknown as AnyBuffer],
  ['platform_audit_log buffer', () => new PlatformAuditBuffer() as unknown as AnyBuffer],
])('%s drained under load', (_name, make) => {
  it('forceFlush waits for an in-flight buffer-full flush instead of spinning, and writes every row once in order', async () => {
    io.written.length = 0;
    io.pending.length = 0;
    const buffer = make();
    const probe = instrument(buffer);
    const total = 100 + scaled(37);

    // The 100th push starts a flush that is NOT awaited (the request path never waits on
    // audit); the rest land while it is writing.
    for (let i = 0; i < total; i++) buffer.push(event(i));
    expect(io.pending.length, 'the 100th push started a flush').toBe(1);

    await buffer.forceFlush();

    expect(probe.calls(), 'forceFlush busy-waited on the in-flight flush').toBeLessThan(10);
    const flat = io.written.flat() as Array<{ eventData: { i: number } }>;
    expect(flat.map((e) => e.eventData.i)).toEqual(Array.from({ length: total }, (_, i) => i));
  });

  it('forceFlush does not resolve while a batch is still being written', async () => {
    io.written.length = 0;
    io.pending.length = 0;
    const buffer = make();
    instrument(buffer);
    for (let i = 0; i < 100; i++) buffer.push(event(i));
    expect(io.pending.length).toBe(1);

    await buffer.forceFlush();

    // Resolved ⇒ the 100 rows are in the table, not still on the wire.
    expect(io.written.flat()).toHaveLength(100);
  });
});

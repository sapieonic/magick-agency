import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `platformAuditLogger.flush()`: writes what is buffered and resolves once it is written,
 * leaving the periodic flush armed, unlike `shutdown()`, which stops it. A test that reads the
 * audit table back mid-file flushes; it never shuts the logger down under the rest of the file.
 * Mutation-checked: `flush` calling the buffer's `forceFlush` (which stops the timer) reds the
 * second write.
 */

const io = vi.hoisted(() => ({ written: [] as unknown[][] }));
vi.mock('@magick-agency/db/repositories/platform/audit.repository', () => ({
  auditRepository: { insertBatch: async (rows: unknown[]) => { io.written.push(rows); } },
}));
vi.mock('@magick-agency/observability', () => {
  const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { createChildLogger: () => quiet, logger: quiet };
});

const { platformAuditLogger } = await import('../../../../src/audit/platform/audit-logger.js');

const row = (n: number) => ({
  tenant_id: '11111111-1111-4111-8111-111111111111', actor_type: 'system' as const, action: 'agency_call.listen_started' as const,
  resource_type: 'agency_call' as const, resource_id: `r${n}`,
});

afterEach(async () => {
  await platformAuditLogger.shutdown();
  vi.useRealTimers();
});

describe('platformAuditLogger.flush', () => {
  it('writes what is buffered now and leaves the periodic flush running', async () => {
    vi.useFakeTimers();
    platformAuditLogger.start();
    platformAuditLogger.log(row(1) as never);
    await platformAuditLogger.flush();
    expect(io.written.flat()).toHaveLength(1);
    expect(platformAuditLogger.getBufferSize()).toBe(0);
    // Still armed: a later row is written by the timer, with no second flush asked for.
    platformAuditLogger.log(row(2) as never);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(io.written.flat()).toHaveLength(2);
  });
});

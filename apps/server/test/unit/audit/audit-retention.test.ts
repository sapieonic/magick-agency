import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

// The pool is mocked from `@magick-agency/db`, the logger from `@magick-agency/observability`.
vi.mock('@magick-agency/db', () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock('@magick-agency/observability', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { getAuditRetentionHorizon, resetAuditRetentionCache } = await import(
  '../../../src/audit/audit-retention.js'
);

function partition(relname: string, from: string, to: string) {
  return { relname, bound: `FOR VALUES FROM ('${from}') TO ('${to}')` };
}

describe('audit retention horizon', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAuditRetentionCache();
  });

  it('reports the oldest surviving partition bound', async () => {
    mocks.query.mockResolvedValue({
      rows: [
        partition('audit_logs_2026_07', '2026-07-01 00:00:00+00', '2026-08-01 00:00:00+00'),
        partition('audit_logs_2026_06', '2026-06-01 00:00:00+00', '2026-07-01 00:00:00+00'),
        partition('audit_logs_2026_08', '2026-08-01 00:00:00+00', '2026-09-01 00:00:00+00'),
      ],
    });

    await expect(getAuditRetentionHorizon()).resolves.toEqual({
      earliest_retained_at: new Date('2026-06-01 00:00:00+00').toISOString(),
      source: 'partition_bound',
    });
  });

  /**
   * The DEFAULT partition is row-deleted rather than dropped, so it can
   * transiently hold rows older than the oldest range partition. Counting it
   * would advertise a horizon further back than the one actually guaranteed.
   */
  it('ignores the DEFAULT partition', async () => {
    mocks.query.mockResolvedValue({
      rows: [
        { relname: 'audit_logs_default', bound: 'DEFAULT' },
        partition('audit_logs_2026_07', '2026-07-01 00:00:00+00', '2026-08-01 00:00:00+00'),
      ],
    });

    await expect(getAuditRetentionHorizon()).resolves.toEqual({
      earliest_retained_at: new Date('2026-07-01 00:00:00+00').toISOString(),
      source: 'partition_bound',
    });
  });

  it('reports `unbounded` when a partition is open at the low end', async () => {
    mocks.query.mockResolvedValue({
      rows: [
        { relname: 'audit_logs_early', bound: "FOR VALUES FROM (MINVALUE) TO ('2026-07-01 00:00:00+00')" },
        partition('audit_logs_2026_07', '2026-07-01 00:00:00+00', '2026-08-01 00:00:00+00'),
      ],
    });

    await expect(getAuditRetentionHorizon()).resolves.toEqual({
      earliest_retained_at: null,
      source: 'unbounded',
    });
  });

  it.each([
    ['no partitions', []],
    ['nothing parseable', [{ relname: 'audit_logs_odd', bound: 'FOR VALUES IN (1)' }]],
  ])('reports `unknown` rather than guessing — %s', async (_name, rows) => {
    mocks.query.mockResolvedValue({ rows });

    await expect(getAuditRetentionHorizon()).resolves.toEqual({
      earliest_retained_at: null,
      source: 'unknown',
    });
  });

  /**
   * Best-effort by construction: this annotates an audit read, it must never be
   * able to fail one.
   */
  it('reports `unknown` when the catalog read throws', async () => {
    mocks.query.mockRejectedValue(new Error('connection terminated'));

    await expect(getAuditRetentionHorizon()).resolves.toEqual({
      earliest_retained_at: null,
      source: 'unknown',
    });
  });

  /**
   * `TtlCache`'s contract is that errors are never cached. Swallowing the
   * failure inside the loader instead caches the `unknown` sentinel, so one
   * transient catalog blip would make every audit read for the next five
   * minutes report "how far back this trail goes could not be checked" — a
   * standing false warning from a momentary fault.
   */
  it('does not cache a failure — the next read retries', async () => {
    mocks.query.mockRejectedValueOnce(new Error('connection terminated'));
    mocks.query.mockResolvedValue({
      rows: [partition('audit_logs_2026_07', '2026-07-01 00:00:00+00', '2026-08-01 00:00:00+00')],
    });

    await expect(getAuditRetentionHorizon()).resolves.toEqual({
      earliest_retained_at: null,
      source: 'unknown',
    });
    await expect(getAuditRetentionHorizon()).resolves.toEqual({
      earliest_retained_at: new Date('2026-07-01 00:00:00+00').toISOString(),
      source: 'partition_bound',
    });
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });

  it('caches, so an audit read is not a catalog scan per request', async () => {
    mocks.query.mockResolvedValue({
      rows: [partition('audit_logs_2026_07', '2026-07-01 00:00:00+00', '2026-08-01 00:00:00+00')],
    });

    await getAuditRetentionHorizon();
    await getAuditRetentionHorizon();

    expect(mocks.query).toHaveBeenCalledTimes(1);
  });
});

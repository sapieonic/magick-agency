import { describe, it, expect, vi } from 'vitest';
import { withRetry } from '../../../src/utils/retry.js';

// Mock the logger to avoid pino initialization side effects
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => ({
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

describe('withRetry', () => {
  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { maxRetries: 3 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on failure and succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail1'))
      .mockRejectedValueOnce(new Error('fail2'))
      .mockResolvedValue('ok');

    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws after exhausting all retries', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fails'));

    await expect(
      withRetry(fn, { maxRetries: 2, baseDelayMs: 1 })
    ).rejects.toThrow('always fails');
    // initial attempt + 2 retries = 3
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('calls onRetry callback on each retry', async () => {
    const onRetry = vi.fn();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail1'))
      .mockRejectedValueOnce(new Error('fail2'))
      .mockResolvedValue('ok');

    await withRetry(fn, { maxRetries: 3, baseDelayMs: 1, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 1);
    expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 2);
  });

  it('does not call onRetry on success', async () => {
    const onRetry = vi.fn();
    const fn = vi.fn().mockResolvedValue('ok');

    await withRetry(fn, { maxRetries: 3, baseDelayMs: 1, onRetry });
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('respects maxRetries of 0 (no retries)', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'));

    await expect(
      withRetry(fn, { maxRetries: 0, baseDelayMs: 1 })
    ).rejects.toThrow('fail');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('caps delay at maxDelayMs', async () => {
    const start = Date.now();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('ok');

    await withRetry(fn, { maxRetries: 1, baseDelayMs: 100, maxDelayMs: 50 });
    const elapsed = Date.now() - start;
    // With maxDelayMs=50 and jitter (0.5-1.0x), delay should be 25-50ms
    expect(elapsed).toBeLessThan(200);
  });

  it('does not retry when error has nonRetryable flag', async () => {
    const nonRetryableError = new Error('client error') as any;
    nonRetryableError.nonRetryable = true;

    const fn = vi.fn().mockRejectedValue(nonRetryableError);

    await expect(
      withRetry(fn, { maxRetries: 3, baseDelayMs: 1 })
    ).rejects.toThrow('client error');
    // Should only be called once despite maxRetries=3
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('still retries when nonRetryable is not set', async () => {
    const retryableError = new Error('server error');

    const fn = vi.fn()
      .mockRejectedValueOnce(retryableError)
      .mockResolvedValue('ok');

    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

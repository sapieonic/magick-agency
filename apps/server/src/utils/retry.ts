import { logger } from '@magick-agency/observability';

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (error: Error, attempt: number) => void;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const { maxRetries, baseDelayMs = 1000, maxDelayMs = 30000, onRetry } = options;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries || (error as any)?.nonRetryable) throw error;
      const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
      const jitter = delay * (0.5 + Math.random() * 0.5);

      if (onRetry) {
        onRetry(error as Error, attempt + 1);
      } else {
        logger.warn(
          { attempt: attempt + 1, maxRetries, delayMs: Math.round(jitter), err: error },
          'Retrying operation'
        );
      }

      await new Promise(resolve => setTimeout(resolve, jitter));
    }
  }

  throw new Error('Unreachable');
}

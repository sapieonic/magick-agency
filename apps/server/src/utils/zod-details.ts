import type { z } from 'zod';

/**
 * Zod issues → `{ "field.path": message }` (the first message per path), a refusal's `details`.
 * An issue on the root is keyed `rootKey` (`body`, `operation`).
 */
export function zodDetails(error: z.ZodError, rootKey: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.length ? issue.path.join('.') : rootKey;
    out[key] ??= issue.message;
  }
  return out;
}

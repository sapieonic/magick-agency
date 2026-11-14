import { z } from 'zod';

/** An env flag is true unless unset, empty, `false`, `0` or `no` (case-insensitive). */
export function isEnvTrue(value: string | undefined): boolean {
  if (value === undefined) return false;
  return !['false', '0', 'no', ''].includes(value.toLowerCase().trim());
}

export const envBoolean = z.preprocess(
  (v) => (typeof v === 'string' ? isEnvTrue(v) : v),
  z.boolean(),
);

/**
 * A blank (empty or whitespace-only) env value is unset, so the schema's default applies; plain
 * `z.coerce.number()` would read it as 0. Wrap a schema with `z.preprocess(blankAsUnset, …)`.
 */
export function blankAsUnset(v: unknown): unknown {
  return typeof v === 'string' && v.trim() === '' ? undefined : v;
}

export type Env = Record<string, string | undefined>;

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

export type Env = Record<string, string | undefined>;

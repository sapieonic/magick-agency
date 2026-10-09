import { z } from 'zod';

/** Ported from magic-voice-core/src/config/schema.ts `envBoolean` semantics. */
export function isEnvTrue(value: string | undefined): boolean {
  if (value === undefined) return false;
  return !['false', '0', 'no', ''].includes(value.toLowerCase().trim());
}

export const envBoolean = z.preprocess(
  (v) => (typeof v === 'string' ? isEnvTrue(v) : v),
  z.boolean(),
);

export type Env = Record<string, string | undefined>;

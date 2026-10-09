import type { z } from 'zod';
import { appConfigSchema, type AppConfig } from './schema.js';
import type { Env } from './env.js';
import { readBaseEnv } from './blocks/base.js';
import { readPlatformEnv } from './blocks/platform.js';
import { readAgencyEnv } from './blocks/agency.js';
import { readVoiceEnv } from './blocks/voice.js';
import { readAnalysisEnv } from './blocks/analysis.js';

export type ConfigResult =
  | { ok: true; config: AppConfig }
  | { ok: false; issues: z.ZodIssue[] };

/** Pure: env in, parsed config or issues out. Never exits. */
export function parseConfig(env: Env): ConfigResult {
  const raw = {
    ...readBaseEnv(env),
    ...readPlatformEnv(env),
    ...readAgencyEnv(env),
    ...readVoiceEnv(env),
    ...readAnalysisEnv(env),
  };
  const result = appConfigSchema.safeParse(raw);
  return result.success ? { ok: true, config: result.data } : { ok: false, issues: result.error.issues };
}

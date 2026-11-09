import type { z } from 'zod';
import { appConfigSchema, type AppConfig } from './schema.js';
import type { Env } from './env.js';
import { readBaseEnv } from './blocks/base.js';
import { readPlatformEnv } from './blocks/platform.js';
import { agencyCrossBlockIssues, readAgencyEnv } from './blocks/agency.js';
import { readVoiceEnv } from './blocks/voice.js';
import { readAnalysisEnv } from './blocks/analysis.js';

export type ConfigResult =
  | { ok: true; config: AppConfig }
  | { ok: false; issues: z.ZodIssue[] };

/**
 * The rules that span blocks (each block's schema sees only its own keys). Run on a config whose
 * blocks all parsed; each returns its issues with the full path, like a schema issue.
 */
export function crossBlockIssues(config: AppConfig): z.ZodIssue[] {
  return [...agencyCrossBlockIssues(config)];
}

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
  if (!result.success) return { ok: false, issues: result.error.issues };
  const issues = crossBlockIssues(result.data);
  return issues.length === 0 ? { ok: true, config: result.data } : { ok: false, issues };
}

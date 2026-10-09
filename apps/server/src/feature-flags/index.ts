import type Redis from 'ioredis';
import { FeatureFlagService } from './feature-flag.service.js';

export { FLAGS, getFlag, allFlags, clientExposedFlags, defineFlag, resolveEnvDefault } from './registry.js';
export type { FlagDefinition, FlagScope, FlagType } from './registry.js';
export { FeatureFlagService } from './feature-flag.service.js';
export type {
  FlagContext,
  FlagSnapshot,
  FlagSnapshotProvider,
  ResolutionSource,
} from './feature-flag.service.js';

/**
 * Process-wide feature-flag service. Initialized once at boot (`src/index.ts`)
 * with the shared Redis client + key prefix, then read by CallManager (hot path)
 * and any route via {@link getFeatureFlagService} — so the gate points don't
 * need the service threaded through every `register(...)` call.
 */
let instance: FeatureFlagService | null = null;

/** Construct the singleton. Call once at startup. */
export function initFeatureFlagService(redis: Redis | null, keyPrefix: string): FeatureFlagService {
  instance = new FeatureFlagService(redis, keyPrefix);
  return instance;
}

/**
 * The initialized singleton. Falls back to a redis-less instance if accessed
 * before init (degraded-but-functional — resolves from DB/env/default), so a
 * stray early call never throws.
 */
export function getFeatureFlagService(): FeatureFlagService {
  if (!instance) {
    instance = new FeatureFlagService(null, '');
  }
  return instance;
}

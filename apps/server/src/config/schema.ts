import { baseConfigSchema } from './blocks/base.js';
import { platformConfigSchema } from './blocks/platform.js';
import { agencyConfigSchema } from './blocks/agency.js';
import { voiceConfigSchema } from './blocks/voice.js';
import { analysisConfigSchema } from './blocks/analysis.js';
import type { z } from 'zod';

/**
 * Each area owns one block (decision B4). `.merge` lets a later block silently REPLACE an
 * earlier block's key, so two blocks declaring the same top-level key would
 * leave one of them reading the other's config with no error anywhere. The
 * blocks must be disjoint; this is checked at module load (so boot fails) and
 * pinned by test/unit/config/blocks-disjoint.test.ts.
 */
export const CONFIG_BLOCKS = {
  base: baseConfigSchema,
  platform: platformConfigSchema,
  agency: agencyConfigSchema,
  voice: voiceConfigSchema,
  analysis: analysisConfigSchema,
} as const;

export function findOverlappingConfigKeys(
  blocks: Record<string, { shape: Record<string, unknown> }> = CONFIG_BLOCKS,
): string[] {
  const owner = new Map<string, string>();
  const clashes: string[] = [];
  for (const [block, schema] of Object.entries(blocks)) {
    for (const key of Object.keys(schema.shape)) {
      const prior = owner.get(key);
      if (prior) clashes.push(`${key} (${prior} and ${block})`);
      else owner.set(key, block);
    }
  }
  return clashes;
}

const clashes = findOverlappingConfigKeys();
if (clashes.length > 0) {
  throw new Error(`Config blocks declare the same top-level key: ${clashes.join(', ')}`);
}

export const appConfigSchema = baseConfigSchema
  .merge(platformConfigSchema)
  .merge(agencyConfigSchema)
  .merge(voiceConfigSchema)
  .merge(analysisConfigSchema);

export type AppConfig = z.infer<typeof appConfigSchema>;

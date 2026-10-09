import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { findOverlappingConfigKeys } from '../../../src/config/schema.js';

describe('config blocks', () => {
  it('declare disjoint top-level keys', () => {
    expect(findOverlappingConfigKeys()).toEqual([]);
  });

  it('detects a key two blocks both declare', () => {
    const a = z.object({ s3: z.string() });
    const b = z.object({ s3: z.string(), other: z.string() });
    expect(findOverlappingConfigKeys({ voice: a, agency: b })).toEqual(['s3 (voice and agency)']);
  });
});

import { describe, expect, it } from 'vitest';
import { analyticsDimensionSchema, analyticsDimensionsSchema } from '../../../../src/api/validators/analytics-dimension.validator.js';
/*
 * PORT NOTE (magick-agency): ported from core test/unit/api/validators/analytics-dimension.validator.test.ts
 * @4850d1d9 (9 + it.each(4) -> 10 cases). Deleted: "re-exported by the prompt validator ...", "is enforced by prompt create and update" and the
 * "shipped prompt JSONs" describe (a canary + an it.each over core's prompt templates): prompt
 * templates are AI-call surface and not carried. The shared dimension schema's own cases are unchanged.
 */

const valid = { key: 'payment_status', description: 'Whether payment was made', type: 'boolean' };
const prompt = { slug: 'test_prompt', name: 'Test prompt', system_prompt: 'System prompt' };

describe('analyticsDimensionSchema', () => {
  it('accepts all supported types and a valid enum', () => {
    for (const type of ['boolean', 'string', 'number'] as const) {
      expect(analyticsDimensionSchema.safeParse({ ...valid, type }).success).toBe(true);
    }
    expect(analyticsDimensionSchema.safeParse({ ...valid, type: 'enum', options: ['yes', 'no'] }).success).toBe(true);
  });

  it.each(['Foo', '1foo', 'foo-bar', ''])('rejects a non-snake_case key: %s', (key) => {
    expect(analyticsDimensionSchema.safeParse({ ...valid, key }).success).toBe(false);
  });

  it('enforces key and description lengths, type enum, and enum options', () => {
    expect(analyticsDimensionSchema.safeParse({ ...valid, key: `a${'x'.repeat(50)}` }).success).toBe(false);
    expect(analyticsDimensionSchema.safeParse({ ...valid, description: '' }).success).toBe(false);
    expect(analyticsDimensionSchema.safeParse({ ...valid, description: 'x'.repeat(501) }).success).toBe(false);
    expect(analyticsDimensionSchema.safeParse({ ...valid, type: 'date' }).success).toBe(false);
    expect(analyticsDimensionSchema.safeParse({ ...valid, type: 'enum', options: ['only'] }).success).toBe(false);
  });

});

describe('analyticsDimensionsSchema', () => {
  const other = { key: 'dispute_raised', description: 'Whether a dispute was raised', type: 'boolean' };

  it('accepts distinct keys and an empty list', () => {
    expect(analyticsDimensionsSchema.safeParse([]).success).toBe(true);
    expect(analyticsDimensionsSchema.safeParse([valid, other]).success).toBe(true);
  });

  it('rejects a repeated key and points the issue at the repeat, not the original', () => {
    const result = analyticsDimensionsSchema.safeParse([valid, other, { ...valid, type: 'string' }]);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0]?.path).toEqual([2, 'key']);
    expect(result.error.issues[0]?.message).toContain('payment_status');
  });

  it('reports every repeat, each against the first occurrence', () => {
    const result = analyticsDimensionsSchema.safeParse([valid, { ...valid }, other, { ...other }, { ...valid }]);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((i) => i.path)).toEqual([[1, 'key'], [3, 'key'], [4, 'key']]);
    expect(result.error.issues[2]?.message).toContain('dimension 0');
  });

  it('still caps the list at 20 dimensions', () => {
    const dims = Array.from({ length: 21 }, (_, i) => ({ ...valid, key: `dim_${i}` }));
    expect(analyticsDimensionsSchema.safeParse(dims).success).toBe(false);
    expect(analyticsDimensionsSchema.safeParse(dims.slice(0, 20)).success).toBe(true);
  });

});

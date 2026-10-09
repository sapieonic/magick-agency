/*
 * PORT NOTE (magick-agency): ported from core test/unit/api/validators/call-analysis-profile.validator.test.ts
 * @4850d1d9. Cases unchanged; only the import depth differs.
 */
import { describe, expect, it } from 'vitest';
import {
  createAnalysisProfileSchema,
  updateAnalysisProfileSchema,
} from '../../../../src/api/validators/call-analysis-profile.validator.js';

const dimension = { key: 'payment_plan', description: 'Whether a payment plan was agreed', type: 'boolean' };

describe('call-analysis-profile validator', () => {
  it('accepts the minimal profile and applies defaults', () => {
    expect(createAnalysisProfileSchema.parse({ name: 'Collections' })).toMatchObject({
      name: 'Collections', custom_dimensions: [], is_default: false,
    });
  });

  it.each(['', 'x'.repeat(121)])('rejects name outside 1..120 characters', (name) => {
    expect(createAnalysisProfileSchema.safeParse({ name }).success).toBe(false);
  });

  it('enforces description, context, language hint, and dimension bounds', () => {
    expect(createAnalysisProfileSchema.safeParse({ name: 'x', description: 'd'.repeat(501) }).success).toBe(false);
    expect(createAnalysisProfileSchema.safeParse({ name: 'x', context: 'c'.repeat(2001) }).success).toBe(false);
    expect(createAnalysisProfileSchema.safeParse({ name: 'x', language_hint: 'l'.repeat(21) }).success).toBe(false);
    expect(createAnalysisProfileSchema.safeParse({
      name: 'x', custom_dimensions: Array.from({ length: 21 }, (_, i) => ({ ...dimension, key: `dimension_${i}` })),
    }).success).toBe(false);
  });

  it('accepts exactly twenty dimensions and a complete enum dimension', () => {
    const parsed = createAnalysisProfileSchema.parse({
      name: 'x',
      custom_dimensions: Array.from({ length: 20 }, (_, i) => ({ ...dimension, key: `dimension_${i}` })),
      is_default: true,
    });
    expect(parsed.custom_dimensions).toHaveLength(20);
    expect(parsed.is_default).toBe(true);
    expect(createAnalysisProfileSchema.safeParse({
      name: 'x', custom_dimensions: [{ key: 'outcome', description: 'Call outcome', type: 'enum', options: ['paid', 'declined'] }],
    }).success).toBe(true);
  });

  it('rejects enum dimensions with fewer than two options', () => {
    expect(createAnalysisProfileSchema.safeParse({
      name: 'x', custom_dimensions: [{ key: 'outcome', description: 'Call outcome', type: 'enum', options: ['paid'] }],
    }).success).toBe(false);
  });

  it('accepts partial copy-on-write updates and applies no create defaults', () => {
    expect(updateAnalysisProfileSchema.parse({ context: 'Updated business context' })).toEqual({ context: 'Updated business context' });
    expect(updateAnalysisProfileSchema.parse({})).toEqual({});
    expect(updateAnalysisProfileSchema.safeParse({ language_hint: 'x'.repeat(21) }).success).toBe(false);
  });

  it('rejects duplicate dimension keys on create and update', () => {
    const dup = [dimension, { ...dimension, type: 'string' }];
    expect(createAnalysisProfileSchema.safeParse({ name: 'Collections', custom_dimensions: dup }).success).toBe(false);
    expect(updateAnalysisProfileSchema.safeParse({ custom_dimensions: dup }).success).toBe(false);
  });
});

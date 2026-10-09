import { z } from 'zod';

/**
 * A single operator-defined analysis dimension — the shape behind
 * `call_analysis_profiles.custom_dimensions`. Extracted here so every validator
 * that accepts one enforces identical bounds (snake_case key ≤50, description ≤500,
 * enum needs ≥2 options) rather than drifting a copy-paste.
 */
export const analyticsDimensionSchema = z.object({
  key: z.string().min(1).max(50).regex(/^[a-z][a-z0-9_]*$/, 'Key must be snake_case starting with a letter'),
  description: z.string().min(1).max(500),
  type: z.enum(['boolean', 'string', 'number', 'enum']),
  options: z.array(z.string().min(1)).optional(),
}).refine(
  (d) => d.type !== 'enum' || (d.options && d.options.length >= 2),
  { message: 'Enum dimensions must have at least 2 options' },
);

/**
 * The `custom_dimensions` ARRAY — shared by the prompt and profile validators for
 * the same reason as the element schema above. Keys must be unique: the analysis
 * JSON schema (`buildJsonSchema`) maps each key to one property and lists it in
 * `required`, so a repeated key produces a `required` array with a duplicate
 * entry, which strict structured output rejects — failing post-call analysis for
 * EVERY call on that prompt/profile, long after the save that caused it succeeded.
 * Rejecting it here makes it a 400 at save time instead.
 */
export const analyticsDimensionsSchema = z.array(analyticsDimensionSchema).max(20).superRefine((dims, ctx) => {
  const firstIndex = new Map<string, number>();
  dims.forEach((d, i) => {
    const prior = firstIndex.get(d.key);
    if (prior === undefined) {
      firstIndex.set(d.key, i);
      return;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [i, 'key'],
      message: `Duplicate dimension key "${d.key}" (already used by dimension ${prior})`,
    });
  });
});

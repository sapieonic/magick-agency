import { z } from 'zod';
import { analyticsDimensionsSchema } from './analytics-dimension.validator.js';

/**
 * Validators for call-analysis profiles — the dialer's reusable answer to prompt
 * `analytics_config`. `custom_dimensions` reuses the SHARED
 * `analyticsDimensionsSchema` (same bounds as prompt templates: snake_case key
 * ≤50, description ≤500, enum needs ≥2 options, ≤20 dimensions, unique keys),
 * so a user who knows one editor knows the other.
 */
export const createAnalysisProfileSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  // Free-text business context prepended to the analysis prompt — the single
  // highest-leverage quality knob for human↔human transcription.
  context: z.string().max(2000).optional(),
  custom_dimensions: analyticsDimensionsSchema.default([]),
  language_hint: z.string().max(20).optional(),
  is_default: z.boolean().default(false),
});

export type CreateAnalysisProfileInput = z.infer<typeof createAnalysisProfileSchema>;

/**
 * Copy-on-write update (mirrors prompt templates): every field optional, omitted
 * fields carry forward from the superseded version. name/tenant/account are the
 * logical identity and are never changed by an update.
 */
export const updateAnalysisProfileSchema = z.object({
  description: z.string().max(500).optional(),
  context: z.string().max(2000).optional(),
  custom_dimensions: analyticsDimensionsSchema.optional(),
  language_hint: z.string().max(20).optional(),
  is_default: z.boolean().optional(),
});

export type UpdateAnalysisProfileInput = z.infer<typeof updateAnalysisProfileSchema>;

export const listAnalysisProfilesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export type ListAnalysisProfilesQuery = z.infer<typeof listAnalysisProfilesQuerySchema>;

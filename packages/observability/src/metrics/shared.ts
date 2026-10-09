/**
 * Metric declarations owned by the shared infrastructure (Phase 2b, lead) —
 * metrics a module that more than one lane uses emits. Not lane-owned.
 *
 * Ported verbatim from magic-voice-core/src/utils/metrics.ts@4850d1d9 (same
 * name, kind, description and label keys).
 */
import { meter } from '../meter.js';
import { counter } from '../metric-instruments.js';

// core `src/utils/metrics.ts:2040-2044` — written by `FeatureFlagService.recordEval`.
export const featureFlagEvaluationsTotal = counter<
  'flag' | 'result' | 'source'
>(meter, 'feature_flag_evaluations_total', {
  description: 'Feature flag evaluations by flag, result, and resolution source',
});

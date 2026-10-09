/**
 * Metric declarations owned by the shared infrastructure —
 * metrics emitted by a module that more than one area uses.
 */
import { meter } from '../meter.js';
import { counter } from '../metric-instruments.js';

// Written by `FeatureFlagService.recordEval`.
export const featureFlagEvaluationsTotal = counter<
  'flag' | 'result' | 'source'
>(meter, 'feature_flag_evaluations_total', {
  description: 'Feature flag evaluations by flag, result, and resolution source',
});

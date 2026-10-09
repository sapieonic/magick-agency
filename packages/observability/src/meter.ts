import { metrics } from '@opentelemetry/api';
import { SERVICE_NAME } from './service.js';

/**
 * The one meter every metric declaration uses (core: `metrics.getMeter(...)`
 * at the top of src/utils/metrics.ts). Lanes declare their metrics in
 * `src/metrics/<lane>.ts` with the facade in `metric-instruments.ts`, keeping
 * core's / master's metric NAMES, units, buckets and label keys verbatim.
 */
export const meter = metrics.getMeter(SERVICE_NAME);

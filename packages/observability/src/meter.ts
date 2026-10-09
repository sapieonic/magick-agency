import { metrics } from '@opentelemetry/api';
import { SERVICE_NAME } from './service.js';

/**
 * The one meter every metric declaration uses 
 * Each area declares its metrics in `src/metrics/<area>.ts` with the facade in
 * `metric-instruments.ts`, keeping metric NAMES, units, buckets and label keys
 * stable so existing dashboards and alert rules keep working.
 */
export const meter = metrics.getMeter(SERVICE_NAME);

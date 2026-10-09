import type pg from 'pg';
import type Redis from 'ioredis';
import type { AppConfig } from './config/schema.js';

/**
 * What the process hands every lane's plugin and bootstrap. Grow it here
 * (lead-owned) rather than reaching for module singletons, so tests can build
 * an app with fakes.
 */
export interface AppContext {
  config: AppConfig;
  pool: pg.Pool;
  redis: Redis;
}

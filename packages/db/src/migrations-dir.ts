import { resolve } from 'node:path';

/** Absolute path of the migrations directory, for runners and tests. */
export const MIGRATIONS_DIR = resolve(__dirname, '..', 'migrations');

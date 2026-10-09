import { TEST_DB_URL } from '../../../../packages/db/test/helpers/test-db.js';
import { TEST_REDIS_URL } from '../helpers/test-redis.js';

process.env['NODE_ENV'] = 'test';
process.env['DATABASE_URL'] = TEST_DB_URL;
process.env['REDIS_URL'] = TEST_REDIS_URL;

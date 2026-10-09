/**
 * Unit tests import modules that import `config`, and config exits the
 * process on an invalid environment. Give unit tests a complete, inert
 * environment so a missing `.env` can never fake a failure. Values point at
 * the agency test stack; unit tests must not actually connect anywhere.
 */
const defaults: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://magick_agency:magick_agency_password@localhost:5436/magick_agency_test',
  REDIS_URL: 'redis://localhost:6383/1',
};
for (const [k, v] of Object.entries(defaults)) {
  if (process.env[k] === undefined) process.env[k] = v;
}

/**
 * The e2e stack's ports, database and the server's environment, in one place.
 *
 * Everything runs on ports of its own, so the dev stack (3021, 5175, 5176) can stay up beside
 * it. Postgres and Redis are the project's own (5436, 6383); the database and the Redis db are
 * the e2e run's alone, and `assertSafeTargets` refuses anything else (a run drops and recreates
 * its database).
 *
 * Every vendor the server talks to is pointed at the simulator (`src/sim`) here, by the
 * server's own settings; the three hosts that are fixed in the server's code (Plivo, Mailjet,
 * recordings) are redirected by `server-preload.mjs`. Nothing in the server is changed.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const E2E_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
/**
 * The orchestrator runs pnpm, the server and docker compose from the repository root. No CI
 * suite of this package reads outside it: its unit tests (`test/`) stay inside the package and
 * its workspace dependencies, which is what `tooling/ci-scope.mjs` scopes by.
 */
export const REPO_ROOT = dirname(dirname(E2E_ROOT));
export const SERVER_DIR = join(REPO_ROOT, 'apps', 'server');
export const RUN_DIR = join(E2E_ROOT, '.run');

const num = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return n;
};

export const ports = {
  server: num('E2E_SERVER_PORT', 3031),
  console: num('E2E_CONSOLE_PORT', 5185),
  superAdmin: num('E2E_SUPER_ADMIN_PORT', 5186),
  sim: num('E2E_SIM_PORT', 3041),
};

export const PG = {
  host: process.env['E2E_PG_HOST'] ?? '127.0.0.1',
  port: num('E2E_PG_PORT', 5436),
  user: process.env['E2E_PG_USER'] ?? 'magick_agency',
  password: process.env['E2E_PG_PASSWORD'] ?? 'magick_agency_password',
  database: process.env['E2E_DB_NAME'] ?? 'magick_agency_e2e',
};
export const REDIS = {
  host: process.env['E2E_REDIS_HOST'] ?? '127.0.0.1',
  port: num('E2E_REDIS_PORT', 6383),
  db: num('E2E_REDIS_DB', 15),
};

export const databaseUrl = (database = PG.database): string =>
  `postgresql://${PG.user}:${encodeURIComponent(PG.password)}@${PG.host}:${PG.port}/${database}`;
export const redisUrl = (): string => `redis://${REDIS.host}:${REDIS.port}/${REDIS.db}`;

export const urls = {
  server: `http://127.0.0.1:${ports.server}`,
  // `localhost`, not 127.0.0.1: the browser treats it as a secure context, which getUserMedia
  // and AudioWorklet need for the station's microphone.
  console: `http://localhost:${ports.console}`,
  superAdmin: `http://localhost:${ports.superAdmin}`,
  sim: `http://127.0.0.1:${ports.sim}`,
};

/** The Firebase project the fake identity service and the server agree on. `demo-` keeps any SDK offline. */
export const FIREBASE_PROJECT_ID = 'demo-magick-e2e';
export const FIREBASE_API_KEY = 'e2e-fake-api-key';

/** The super-admin every run creates (the server has no seeded admin). */
export const SUPER_ADMIN = {
  email: 'root@e2e.test',
  password: 'E2e-super-admin-pw-1',
  name: 'E2E Root',
};

/** The VoiceLink account the simulator accepts. */
export const VOICELINK = { username: 'e2e-vl-user', password: 'e2e-vl-password' };

/** The public origin the server believes it has; the simulator rewrites it to loopback. */
export const PUBLIC_HOST = 'e2e.invalid';
export const RECORDING_HOST = 'recording.e2e.invalid';

/** Postgres ports other local stacks use; never touched (root CLAUDE.md). */
const FOREIGN_PG_PORTS = new Set([5432, 5433, 5434]);
const FOREIGN_REDIS_PORTS = new Set([6379, 6380, 6381]);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * A run drops and recreates its database and flushes its Redis db: refuse anything that is not
 * plainly the e2e run's own.
 */
export function assertSafeTargets(): void {
  if (FOREIGN_PG_PORTS.has(PG.port)) throw new Error(`e2e refuses Postgres port ${PG.port}: another local stack uses it`);
  if (FOREIGN_REDIS_PORTS.has(REDIS.port)) throw new Error(`e2e refuses Redis port ${REDIS.port}: another local stack uses it`);
  if (!/^magick_agency_e2e[a-z0-9_]*$/.test(PG.database)) {
    throw new Error(`e2e refuses database "${PG.database}": its name must start with magick_agency_e2e`);
  }
  // Redis has 0-15: 0 is dev, 1-14 the integration runs' (tooling/test-env.ts stops them at
  // 14), 15 this run's.
  if (REDIS.db !== 15) throw new Error(`e2e refuses Redis db ${REDIS.db}: 0 is dev and 1-14 are the integration runs'; e2e uses 15`);
  // The project's own infra on this machine only: never a shared or remote server.
  for (const [what, host] of [['Postgres', PG.host], ['Redis', REDIS.host]] as const) {
    if (!LOOPBACK_HOSTS.has(host)) throw new Error(`e2e refuses ${what} host "${host}": only this machine's (127.0.0.1, localhost, ::1)`);
  }
}

/**
 * The server's whole environment for an e2e run. Nothing is inherited from a developer's `.env`.
 * `voicelinkBaseUrl` is the simulated carrier's REST base (`Simulator.voicelink.baseUrl`): the
 * server's own VoiceLink mock, on a port the system picks when the simulator starts.
 */
export function serverEnv(voicelinkBaseUrl: string): Record<string, string> {
  const sim = urls.sim;
  return {
    NODE_ENV: 'development',
    PORT: String(ports.server),
    HOST: '127.0.0.1',
    LOG_LEVEL: process.env['E2E_SERVER_LOG_LEVEL'] ?? 'info',
    // `src/config/index.ts` imports dotenv/config: point it at nothing so apps/server/.env
    // (a developer's real VoiceLink or Firebase settings) never loads into an e2e run.
    DOTENV_CONFIG_PATH: join(RUN_DIR, 'no-such.env'),
    DATABASE_URL: databaseUrl(),
    REDIS_URL: redisUrl(),
    DB_POOL_MAX: '20',
    TRUST_PROXY_HOPS: '1',

    SUPER_ADMIN_JWT_SECRET: 'e2e-super-admin-jwt-secret-0123456789',
    CONSOLE_BASE_URL: urls.console,

    // Console sign-in: firebase-admin in emulator mode accepts the fake identity service's
    // unsigned tokens and looks each user up on the simulator. Only ever set in this environment.
    FIREBASE_PROJECT_ID,
    FIREBASE_AUTH_EMULATOR_HOST: `127.0.0.1:${ports.sim}`,

    // The simulator, for `server-preload.mjs`'s redirects.
    E2E_SIM_ORIGIN: sim,

    // VoiceLink: the simulated carrier's REST API; it rewrites the public base below to loopback.
    TELEPHONY_ENABLED_PROVIDERS: 'voicelink',
    VOICELINK_BASE_URL: voicelinkBaseUrl,
    VOICELINK_USERNAME: VOICELINK.username,
    VOICELINK_PASSWORD: VOICELINK.password,
    VOICELINK_WEBHOOK_BASE_URL: `https://${PUBLIC_HOST}/api/v1/webhooks/voicelink`,
    VOICELINK_DEFAULT_COUNTRY_CODE: '91',
    VOICELINK_RECORDING_HOSTS: RECORDING_HOST,
    RECORDING_URL_SIGNING_SECRET: 'e2e-recording-signing-secret',

    // Plivo (tenants' own accounts): the REST host is redirected by the preload.
    TELEPHONY_CREDENTIAL_KEYS: 'e2e1:ZTJlLW1hc3Rlci1rZXktMzItYnl0ZXMtZm9yLXRlc3Q=',
    TELEPHONY_CREDENTIAL_ACTIVE_KEY: 'e2e1',
    PLIVO_WEBHOOK_BASE_URL: `https://${PUBLIC_HOST}/api/v1/webhooks/plivo`,

    // Mail: the preload redirects api.mailjet.com to the simulator's mailbox.
    MAILJET_API_KEY: 'e2e-mailjet-key',
    MAILJET_API_SECRET: 'e2e-mailjet-secret',
    MAILJET_FROM_EMAIL: 'no-reply@e2e.test',
    MAILJET_FROM_NAME: 'Magick Agency E2E',

    // Object storage: the simulator's S3 (an IP endpoint makes the SDK use path-style URLs).
    S3_AUDIO_BUCKET: 'e2e-bucket',
    AWS_REGION: 'ap-south-1',
    AWS_ACCESS_KEY_ID: 'e2e-access-key',
    AWS_SECRET_ACCESS_KEY: 'e2e-secret-key',
    AWS_ENDPOINT_URL_S3: `${sim}/s3`,
    AWS_REQUEST_CHECKSUM_CALCULATION: 'WHEN_REQUIRED',
    AWS_RESPONSE_CHECKSUM_VALIDATION: 'WHEN_REQUIRED',

    // AI: an OpenAI-compatible analysis endpoint and Gemini transcription, both the simulator's.
    POST_CALL_ANALYSIS_PROVIDER: 'openai_compatible',
    POST_CALL_ANALYSIS_BASE_URL: `${sim}/openai/v1`,
    POST_CALL_ANALYSIS_API_KEY: 'e2e-openai-key',
    POST_CALL_ANALYSIS_STRUCTURED_OUTPUT: 'json_object',
    GEMINI_API_KEY: 'e2e-gemini-key',
    GOOGLE_GEMINI_BASE_URL: `${sim}/gemini`,

    // Every feature on, so each spec reaches what it tests.
    FF_AGENCY_DIALER: 'true',
    FF_AGENCY_SOFTPHONE: 'true',
    FF_AGENCY_REPORTS: 'true',
    FF_AGENCY_INBOUND: 'true',
    FF_AGENCY_LIVE_LISTEN: 'true',
    FF_AGENCY_FLOOR_ASSIST: 'true',
    FF_AGENCY_COMPARE: 'true',
    FF_AGENCY_CAMPAIGN_TEMPLATES: 'true',
    FF_AGENCY_CALL_ANALYSIS: 'true',

    // Every request comes from 127.0.0.1: the per-IP buckets would throttle the suite.
    RATE_LIMIT_MAX: '100000',
    RATE_LIMIT_IP_AUTH_MAX: '100000',
    RATE_LIMIT_WEBHOOK_MAX: '100000',
    RATE_LIMIT_STATION_MAX: '100000',
    RATE_LIMIT_INTERNAL_MAX: '100000',
    RATE_LIMIT_CARRIER_MEDIA_MAX: '100000',
    RATE_LIMIT_USER_MAX: '100000',

    AGENCY_INSIGHTS_ROLLUP_INTERVAL_MS: '2000',
    OTEL_SDK_DISABLED: 'true',
  };
}

/** The env the two web UIs are built with: Firebase pointed at the fake, no analytics. */
export function uiBuildEnv(): Record<string, string> {
  return {
    VITE_FIREBASE_API_KEY: FIREBASE_API_KEY,
    VITE_FIREBASE_AUTH_DOMAIN: 'localhost',
    VITE_FIREBASE_PROJECT_ID: FIREBASE_PROJECT_ID,
    VITE_FIREBASE_STORAGE_BUCKET: '',
    VITE_FIREBASE_MESSAGING_SENDER_ID: '0',
    VITE_FIREBASE_APP_ID: '1:0:web:e2e',
    VITE_API_BASE_URL: '',
    VITE_POSTHOG_KEY: '',
  };
}

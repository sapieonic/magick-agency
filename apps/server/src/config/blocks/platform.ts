import { z } from 'zod';
import { envBoolean, type Env } from '../env.js';
import { DEFAULT_RATE_LIMIT_USER_MAX } from '../../api/middleware/rate-limit-defaults.js';

/**
 * Platform config: identity, tenancy, invites, super-admin, notifications.
 *
 *  - `firebase` is OPTIONAL: a minimal env (DATABASE_URL + REDIS_URL) must parse, so a
 *    missing block must not fail the schema; instead `startPlatform` refuses to boot in
 *    production without it, and outside production every Firebase verify fails closed
 *    (401). Only the project id is read: token verification needs no service account.
 *  - `consoleBaseUrl` (`CONSOLE_BASE_URL`): the console origin invite links point at.
 *  - `userRateLimit` (`RATE_LIMIT_USER_MAX`): the per-USER bucket the session middleware
 *    charges once it has verified who is calling. It keys on identity, which is platform's;
 *    the IP buckets (`rateLimit`, `RATE_LIMIT_MAX`, `RATE_LIMIT_IP_AUTH_MAX`, …) live in the
 *    voice block. Same window as those (`RATE_LIMIT_WINDOW`).
 *  - `mobile` (`MOBILE_*`): the mobile app's version gate, served by `GET /client-config`.
 *  - There are no peer-service, encryption, service-token, webhook, LLM, scheduler, SQS or
 *    credit blocks (no peer service, no API keys, no credits).
 */

const firebaseSchema = z.object({
  projectId: z.string(),
  authEmulatorHost: z.string().optional(),
});

const superAdminSchema = z.object({
  jwtSecret: z.string().min(16, 'SUPER_ADMIN_JWT_SECRET must be at least 16 characters'),
}).optional();

const mailjetSchema = z.object({
  apiKey: z.string(),
  apiSecret: z.string(),
  fromEmail: z.string().email().default('noreply@sapionic.ai'),
  fromName: z.string().default('Sapionic'),
});

/**
 * `.default({})`, not `.optional()`, so the template renderer reads defaults without a
 * second copy.
 */
const brandSchema = z.object({
  /**
   * `PLATFORM_BRAND_NAME`. Composed into the product noun by `agencyProductName`
   * ("Magick Agency Dialer" for the default). Default `Magick Agency` (decision B17).
   */
  name: z.string().min(1).default('Magick Agency'),
  /**
   * `PLATFORM_BRAND_ACCENT`. Validated as a hex triplet: it goes straight into an
   * inline `style` attribute AND a `bgcolor` of mail sent outside the tenant.
   */
  accent: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'PLATFORM_BRAND_ACCENT must be a #RRGGBB hex colour')
    .default('#7c5cfc'),
  /** `PLATFORM_BRAND_LOGO_URL`. Optional — a wrong logo is worse than none. */
  logoUrl: z.string().url().optional(),
});

/** The ONLY place the seven days is written. */
const invitesSchema = z.object({
  tokenTtlDays: z.coerce.number().int().min(1).max(90).default(7),
});

/** Defaults OFF: enabling the in-process cache is a deliberate rollout step. */
const localCacheSchema = z.object({
  enabled: envBoolean.default(false),
  ttlMs: z.coerce.number().int().positive().max(60_000).default(5_000),
  maxEntries: z.coerce.number().int().positive().max(200_000).default(10_000),
});

/**
 * Runtime maintenance of the two monthly-partitioned audit tables
 * (`audit/audit-partition-maintenance.ts`). The baseline creates partitions
 * 2026-01..2027-12 only. `retentionDays` defaults to the production retention policy
 * (85 days), with a floor of 30.
 */
const auditPartitionsSchema = z.object({
  enabled: envBoolean.default(true),
  retentionDays: z.coerce.number().int().min(30).default(85),
  monthsAhead: z.coerce.number().int().min(1).max(24).default(3),
  intervalMs: z.coerce.number().int().min(60_000).default(24 * 60 * 60 * 1000),
});

/**
 * Decision Q9 (amended 2026-11-01): one bucket per verified user, so agents behind one
 * carrier-grade NAT each get their own budget. 600/min is 10 requests a second sustained:
 * a supervisor on the campaigns home with ~40 active campaigns in two tabs, far above an
 * agent's traffic (a station's pings ride the socket, not HTTP). Sizing:
 * `api/middleware/rate-limit-defaults.ts`.
 */
const userRateLimitSchema = z.object({
  max: z.coerce.number().int().min(1).default(DEFAULT_RATE_LIMIT_USER_MAX),
});

/**
 * `MAJOR.MINOR.PATCH`, the core of semver without prerelease or build. A store version has
 * neither, and leaving them out keeps the app's comparison three integers.
 */
const CORE_SEMVER = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

/** Compares two {@link CORE_SEMVER} strings; only call with values that matched it. */
function compareCoreSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const httpsUrl = (name: string) => z
  .string()
  .url(`${name} must be a URL`)
  .refine((v) => v.startsWith('https://'), `${name} must be an https:// URL`);

/** The mobile app's version gate (`GET /client-config`, `ClientConfigResponse`). */
const mobileSchema = z.object({
  minSupportedVersion: z.string()
    .regex(CORE_SEMVER, 'MOBILE_MIN_SUPPORTED_VERSION must be MAJOR.MINOR.PATCH')
    .default('0.1.0'),
  latestVersion: z.string()
    .regex(CORE_SEMVER, 'MOBILE_LATEST_VERSION must be MAJOR.MINOR.PATCH')
    .default('0.1.0'),
  iosStoreUrl: httpsUrl('MOBILE_IOS_STORE_URL').optional(),
  androidStoreUrl: httpsUrl('MOBILE_ANDROID_STORE_URL').optional(),
}).superRefine((data, ctx) => {
  // Runs on a DIRTY result too (a field above may have failed), so compare only two
  // values that both parsed: `compareCoreSemver` assumes the shape.
  if (!CORE_SEMVER.test(data.minSupportedVersion) || !CORE_SEMVER.test(data.latestVersion)) return;
  if (compareCoreSemver(data.minSupportedVersion, data.latestVersion) > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['minSupportedVersion'],
      message: 'MOBILE_MIN_SUPPORTED_VERSION must not be newer than MOBILE_LATEST_VERSION: every installed app would be told to update to a version that does not exist',
    });
  }
});

export const platformConfigSchema = z.object({
  firebase: firebaseSchema.optional(),
  superAdmin: superAdminSchema,
  mailjet: mailjetSchema.optional(),
  brand: brandSchema.default({}),
  invites: invitesSchema.default({}),
  localCache: localCacheSchema.default({}),
  /** `CONSOLE_BASE_URL` — the agency console origin invite links are built on. */
  consoleBaseUrl: z.string().url().optional(),
  auditPartitions: auditPartitionsSchema.default({}),
  userRateLimit: userRateLimitSchema.default({}),
  mobile: mobileSchema.default({}),
});

/** Drop unset values so `.default({})` blocks see an absent key, not `{ x: undefined }`. */
function compact(obj: Record<string, string | undefined>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== '') out[k] = v;
  return Object.keys(out).length > 0 ? out : undefined;
}

export function readPlatformEnv(env: Env): Record<string, unknown> {
  return {
    // The block exists iff the project id is set.
    firebase: env['FIREBASE_PROJECT_ID']
      ? {
          projectId: env['FIREBASE_PROJECT_ID'],
          authEmulatorHost: env['FIREBASE_AUTH_EMULATOR_HOST'],
        }
      : undefined,
    superAdmin: env['SUPER_ADMIN_JWT_SECRET']
      ? { jwtSecret: env['SUPER_ADMIN_JWT_SECRET'] }
      : undefined,
    mailjet: env['MAILJET_API_KEY']
      ? {
          apiKey: env['MAILJET_API_KEY'],
          apiSecret: env['MAILJET_API_SECRET'],
          fromEmail: env['MAILJET_FROM_EMAIL'],
          fromName: env['MAILJET_FROM_NAME'],
        }
      : undefined,
    brand: compact({
      name: env['PLATFORM_BRAND_NAME'],
      accent: env['PLATFORM_BRAND_ACCENT'],
      logoUrl: env['PLATFORM_BRAND_LOGO_URL'],
    }),
    invites: compact({ tokenTtlDays: env['INVITE_TOKEN_TTL_DAYS'] }),
    localCache: compact({
      enabled: env['LOCAL_CACHE_ENABLED'],
      ttlMs: env['LOCAL_CACHE_TTL_MS'],
      maxEntries: env['LOCAL_CACHE_MAX_ENTRIES'],
    }),
    consoleBaseUrl: env['CONSOLE_BASE_URL'] || undefined,
    auditPartitions: compact({
      enabled: env['AUDIT_PARTITION_MAINTENANCE_ENABLED'],
      retentionDays: env['AUDIT_RETENTION_DAYS'],
      monthsAhead: env['AUDIT_PARTITION_MONTHS_AHEAD'],
      intervalMs: env['AUDIT_PARTITION_MAINTENANCE_INTERVAL_MS'],
    }),
    userRateLimit: compact({ max: env['RATE_LIMIT_USER_MAX'] }),
    mobile: compact({
      minSupportedVersion: env['MOBILE_MIN_SUPPORTED_VERSION'],
      latestVersion: env['MOBILE_LATEST_VERSION'],
      iosStoreUrl: env['MOBILE_IOS_STORE_URL'],
      androidStoreUrl: env['MOBILE_ANDROID_STORE_URL'],
    }),
  };
}

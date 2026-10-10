import { z } from 'zod';
import { envBoolean, type Env } from '../env.js';

/**
 * Platform config: identity, tenancy, invites, super-admin, notifications.
 *
 *  - `firebase` is OPTIONAL: a minimal env (DATABASE_URL + REDIS_URL) must parse, so a
 *    missing block must not fail the schema; instead `startPlatform` refuses to boot in
 *    production without it, and outside production every Firebase verify fails closed
 *    (401). Only the project id is read: token verification needs no service account.
 *  - `consoleBaseUrl` (`CONSOLE_BASE_URL`): the console origin invite links point at.
 *  - There are no peer-service, encryption, service-token, webhook, LLM, scheduler, SQS or
 *    credit blocks (no peer service, no API keys, no credits). `rateLimit` lives in the
 *    voice block.
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
  };
}

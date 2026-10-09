import { z } from 'zod';
import { envBoolean, type Env } from '../env.js';

/**
 * Owned by lane A (platform: identity, tenancy, invites, super-admin,
 * notifications). Key names are master's (`magick-master/src/config/schema.ts`
 * @a1f0756a) so the ported code reads the same paths.
 *
 * PORT NOTE (magick-agency):
 *  - `firebase` is OPTIONAL here (master: required). The lead's config contract is
 *    that a minimal env (DATABASE_URL + REDIS_URL) parses, so a missing block must
 *    not fail the schema; instead `startPlatform` refuses to boot in production
 *    without it, and outside production every Firebase verify fails closed (401).
 *    `serviceAccountPath` is new (brief: "service account JSON or path").
 *  - `consoleBaseUrl` (`CONSOLE_BASE_URL`) replaces master's `cusuiBaseUrl`
 *    (`CUSUI_BASE_URL`): the invite link points at agency's own console.
 *  - Not carried: core-service, encryption, s2sAuth, webhooks, llm, platformEmail,
 *    scheduler, SQS, credits and the rest of master's blocks (no peer service,
 *    no API keys, no credits). `rateLimit` belongs to lane C's block.
 */

// master `schema.ts:116-120` (+ serviceAccountPath).
const firebaseSchema = z.object({
  projectId: z.string(),
  serviceAccountKey: z.string().optional(),
  serviceAccountPath: z.string().optional(),
  authEmulatorHost: z.string().optional(),
});

// master `schema.ts:183-185`.
const superAdminSchema = z.object({
  jwtSecret: z.string().min(16, 'SUPER_ADMIN_JWT_SECRET must be at least 16 characters'),
}).optional();

// master `schema.ts:365-370`.
const mailjetSchema = z.object({
  apiKey: z.string(),
  apiSecret: z.string(),
  fromEmail: z.string().email().default('noreply@sapionic.ai'),
  fromName: z.string().default('Sapionic'),
});

/**
 * master `schema.ts:450-479` — see master's docstring: `.default({})`, not
 * `.optional()`, so the template renderer reads defaults without a second copy.
 */
const brandSchema = z.object({
  /**
   * `PLATFORM_BRAND_NAME`. Composed into the product noun by `agencyProductName`
   * ("Magick Agency Dialer" for the default). PORT NOTE (magick-agency, decision
   * B17): the default is `Magick Agency` (master: `MagickVoice`).
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

/** master `schema.ts:488-510` — the ONLY place the seven days is written. */
const invitesSchema = z.object({
  tokenTtlDays: z.coerce.number().int().min(1).max(90).default(7),
});

/** master `schema.ts:721-727` — defaults OFF (a rollout requirement, see master). */
const localCacheSchema = z.object({
  enabled: envBoolean.default(false),
  ttlMs: z.coerce.number().int().positive().max(60_000).default(5_000),
  maxEntries: z.coerce.number().int().positive().max(200_000).default(10_000),
});

/**
 * NEW (magick-agency, plan §3.5): runtime maintenance of the two monthly-partitioned
 * audit tables (`audit/audit-partition-maintenance.ts`). The baseline creates
 * partitions 2026-01..2027-12 only. `retentionDays` is the window core's and
 * master's retention Lambda held as `RETENTION_DAYS` (production policy 85 days);
 * the floor of 30 is their `RETENTION_MIN_DAYS` default.
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
    // master `config/index.ts:22-26`; here the block exists iff the project id is set.
    firebase: env['FIREBASE_PROJECT_ID']
      ? {
          projectId: env['FIREBASE_PROJECT_ID'],
          serviceAccountKey: env['FIREBASE_SERVICE_ACCOUNT_KEY'],
          serviceAccountPath: env['FIREBASE_SERVICE_ACCOUNT_PATH'],
          authEmulatorHost: env['FIREBASE_AUTH_EMULATOR_HOST'],
        }
      : undefined,
    // master `config/index.ts:52-54`.
    superAdmin: env['SUPER_ADMIN_JWT_SECRET']
      ? { jwtSecret: env['SUPER_ADMIN_JWT_SECRET'] }
      : undefined,
    // master `config/index.ts:119-126`.
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

import { z } from 'zod';
import { envBoolean, type Env } from '../env.js';

/**
 * Owned by lane C (voice engine). Every key below keeps core's name and shape
 * (magic-voice-core/src/config/{schema,index}.ts@4850d1d9) so the ported bridge,
 * guards, VoiceLink adapter, rate limiter, clip decode and PostHog client read
 * the paths they read in core. PORTING.md (Lane C) lists each modification.
 */

// core schema.ts:128 `concurrencySchema` — modified: `mediaStreamConnectTimeoutSeconds`
// removed (the AI inbound media watchdog; no reader here).
const concurrencySchema = z.object({
  maxConcurrentCalls: z.coerce.number().default(200),
  callTimeoutSeconds: z.coerce.number().positive().default(300),
  /**
   * How often the background self-heal sweep runs (reconcile concurrency
   * counters against live Redis locks + fail stuck active calls). Also runs
   * once on startup regardless of this interval. Default 5 min.
   */
  reconcileIntervalMs: z.coerce.number().positive().default(300_000),
  /**
   * A call still in an in-flight state (initiating/ringing/in_progress) older
   * than this is considered stuck and is swept to `failed` (error_code
   * `STUCK_ACTIVE_CALL`). Queued backlog is not swept by this window. Must
   * comfortably exceed ordinary AI/static calls. Long-lived IVR/WebRTC calls
   * also enforce their supported maximum duration plus callback grace before
   * becoming eligible. Default 30 min.
   */
  staleCallSweepMinutes: z.coerce.number().positive().default(30),
});

// core schema.ts:290 `voicelinkSchema` — verbatim.
const voicelinkSchema = z.object({
  /** VoiceLink REST base URL, e.g. https://app.voicelink.co.in/api. */
  baseUrl: z.string().optional().default(''),
  /** POST /v1/auth/login field. Secret-adjacent — never log. */
  username: z.string().optional().default(''),
  /** POST /v1/auth/login field. Secret — never log. */
  password: z.string().optional().default(''),
  /** Our public base for the webhook_url + to derive the per-lead websocket_url host. */
  webhookBaseUrl: z.string().optional().default(''),
  /** A VoiceLink-provisioned DID used as the outbound caller ID (the `did_number`). */
  defaultCallerId: z.string().optional().default(''),
  /**
   * Default calling country code (no `+`, e.g. `91`). Used to split req.to into
   * the bare `customer_number` + separate `country_code` fields add_lead requires.
   */
  defaultCountryCode: z.string().optional().default('91'),
});

/**
 * core schema.ts:320 `telephonySchema` — modified: VoiceLink is the only carrier
 * (plan §5, §9: agency dials only on its own VoiceLink account), so the other
 * seven provider blocks, `defaultProvider` and `enabledProviders` are gone.
 *
 * Core's superRefine required the selected provider's fields at boot. Here the
 * same VoiceLink `requireField` checks run when `requireVoicelink` is true, which
 * the env reader sets in production or when `TELEPHONY_ENABLED_PROVIDERS` names
 * `voicelink` — so a misconfigured production deploy still fails fast, while the
 * unit-test env (which carries no carrier credentials) parses.
 */
export const telephonySchema = z.object({
  requireVoicelink: z.boolean().default(false),
  voicelink: voicelinkSchema.default({}),
}).superRefine((data, ctx) => {
  if (!data.requireVoicelink) return;
  const provider = 'voicelink';
  const requireField = (path: string, value: string | undefined) => {
    if (!value) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: path.split('.'),
        message: `Required when provider '${provider}' is enabled`,
      });
    }
  };
  requireField('voicelink.baseUrl', data.voicelink.baseUrl);
  requireField('voicelink.username', data.voicelink.username);
  requireField('voicelink.password', data.voicelink.password);
  requireField('voicelink.webhookBaseUrl', data.voicelink.webhookBaseUrl);
  requireField('voicelink.defaultCallerId', data.voicelink.defaultCallerId);
});

// core schema.ts:1428 `rateLimitSchema` — verbatim keys, defaults and bounds. The
// sizing rationale (why webhookMax is 1000, why carrier media has its own bucket)
// is core's and is restated in the middleware header.
const rateLimitSchema = z.object({
  max: z.coerce.number().int().min(1).default(200),
  webhookMax: z.coerce.number().int().min(1).default(1000),
  carrierMediaMax: z.coerce.number().int().min(1).default(600),
  internalMax: z.coerce.number().int().min(1).default(1000),
  timeWindow: z.string().default('1 minute'),
});

// core schema.ts:1493 `s3Schema` — verbatim. Agency's own bucket (plan §5).
const s3Schema = z.object({
  audioBucket: z.string(),
  region: z.string().default('ap-south-1'),
  accessKeyId: z.string(),
  secretAccessKey: z.string(),
});

// core schema.ts `staticCallTtsSchema` — modified: only the on-disk clip-cache
// sweeper knobs are kept (agency synthesises no TTS, decision 4). Key name kept
// so the ported sweeper wiring reads the path core reads.
const staticCallTtsSchema = z.object({
  cacheTtlMs: z.coerce.number().int().min(0).default(21_600_000), // 6h
  cacheMaxBytes: z.coerce.number().int().min(0).default(524_288_000), // 500MB
  cacheSweepIntervalMs: z.coerce.number().int().min(0).default(3_600_000), // 1h
});

// core schema.ts:1907 `audioSchema` — verbatim.
const audioSchema = z.object({
  decodeTimeoutMs: z.coerce.number().int().min(1000).default(90_000),
  decodeConcurrency: z.coerce.number().int().min(1).default(2),
});

// core schema.ts:2028 `analyticsSchema` — verbatim. Lane C owns the PostHog
// client (lead decision); lane D's LLM observability reads the two llm* keys.
const analyticsSchema = z.object({
  /** Master switch for PostHog product/business analytics. */
  enabled: envBoolean.default(false),
  /** PostHog project API key (write key). Required when enabled. */
  apiKey: z.string().optional(),
  /** PostHog ingest host. Use https://eu.i.posthog.com for EU Cloud. */
  host: z.string().default('https://us.i.posthog.com'),
  /**
   * Deployment environment tag attached to every event (e.g. `staging`,
   * `production`). Required to distinguish staging from production since both
   * usually run NODE_ENV=production. Falls back to NODE_ENV when unset.
   */
  environment: z.string().optional(),
  /** Flush after this many queued events. */
  flushAt: z.coerce.number().int().min(1).default(20),
  /** Flush at least this often (ms). */
  flushIntervalMs: z.coerce.number().int().min(0).default(10000),
  /** Per-request timeout to the PostHog API (ms). */
  requestTimeoutMs: z.coerce.number().int().min(1000).default(10000),
  /**
   * Sub-gate for PostHog LLM Analytics (`$ai_generation` events). Requires
   * `enabled` (the master switch builds the shared client).
   */
  llmObservabilityEnabled: envBoolean.default(false),
  /**
   * When true, include prompt/completion text (`$ai_input`/`$ai_output`) on LLM
   * events. Off by default — metrics only, no transcript/PII leaves the process.
   */
  llmCaptureContent: envBoolean.default(false),
}).superRefine((data, ctx) => {
  if (data.enabled && !data.apiKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['apiKey'],
      message: 'POSTHOG_API_KEY is required when POSTHOG_ENABLED is true',
    });
  }
});

export const voiceConfigSchema = z.object({
  concurrency: concurrencySchema.default({}),
  telephony: telephonySchema,
  rateLimit: rateLimitSchema.default({}),
  s3: s3Schema.optional(),
  staticCallTts: staticCallTtsSchema.default({}),
  audio: audioSchema.default({}),
  analytics: analyticsSchema.default({}),
});

export function readVoiceEnv(env: Env): Record<string, unknown> {
  const enabledProviders = (env['TELEPHONY_ENABLED_PROVIDERS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    concurrency: {
      maxConcurrentCalls: env['MAX_CONCURRENT_CALLS'],
      callTimeoutSeconds: env['CALL_TIMEOUT_SECONDS'],
      reconcileIntervalMs: env['CONCURRENCY_RECONCILE_INTERVAL_MS'],
      staleCallSweepMinutes: env['STALE_CALL_SWEEP_MINUTES'],
    },
    telephony: {
      requireVoicelink: env['NODE_ENV'] === 'production' || enabledProviders.includes('voicelink'),
      voicelink: {
        baseUrl: env['VOICELINK_BASE_URL'],
        username: env['VOICELINK_USERNAME'],
        password: env['VOICELINK_PASSWORD'],
        webhookBaseUrl: env['VOICELINK_WEBHOOK_BASE_URL'],
        defaultCallerId: env['VOICELINK_DEFAULT_CALLER_ID'],
        defaultCountryCode: env['VOICELINK_DEFAULT_COUNTRY_CODE'],
      },
    },
    rateLimit: {
      max: env['RATE_LIMIT_MAX'],
      webhookMax: env['RATE_LIMIT_WEBHOOK_MAX'],
      carrierMediaMax: env['RATE_LIMIT_CARRIER_MEDIA_MAX'],
      internalMax: env['RATE_LIMIT_INTERNAL_MAX'],
      timeWindow: env['RATE_LIMIT_WINDOW'],
    },
    s3: env['S3_AUDIO_BUCKET'] ? {
      audioBucket: env['S3_AUDIO_BUCKET'],
      region: env['AWS_REGION'],
      accessKeyId: env['AWS_ACCESS_KEY_ID'],
      secretAccessKey: env['AWS_SECRET_ACCESS_KEY'],
    } : undefined,
    staticCallTts: {
      cacheTtlMs: env['TTS_CACHE_TTL_MS'],
      cacheMaxBytes: env['TTS_CACHE_MAX_BYTES'],
      cacheSweepIntervalMs: env['TTS_CACHE_SWEEP_INTERVAL_MS'],
    },
    audio: {
      decodeTimeoutMs: env['AUDIO_DECODE_TIMEOUT_MS'],
      decodeConcurrency: env['AUDIO_DECODE_CONCURRENCY'],
    },
    analytics: {
      enabled: env['POSTHOG_ENABLED'],
      apiKey: env['POSTHOG_API_KEY'],
      host: env['POSTHOG_HOST'],
      environment: env['POSTHOG_ENVIRONMENT'],
      flushAt: env['POSTHOG_FLUSH_AT'],
      flushIntervalMs: env['POSTHOG_FLUSH_INTERVAL_MS'],
      requestTimeoutMs: env['POSTHOG_REQUEST_TIMEOUT_MS'],
      llmObservabilityEnabled: env['POSTHOG_LLM_OBSERVABILITY_ENABLED'],
      llmCaptureContent: env['POSTHOG_LLM_CAPTURE_CONTENT'],
    },
  };
}

import { z } from 'zod';
import { envBoolean, type Env } from '../env.js';
import {
  DEFAULT_RATE_LIMIT_CARRIER_MEDIA_MAX,
  DEFAULT_RATE_LIMIT_INTERNAL_MAX,
  DEFAULT_RATE_LIMIT_IP_AUTH_MAX,
  DEFAULT_RATE_LIMIT_MAX,
  DEFAULT_RATE_LIMIT_STATION_MAX,
  DEFAULT_RATE_LIMIT_WEBHOOK_MAX,
  DEFAULT_RATE_LIMIT_WINDOW,
} from '../../api/middleware/rate-limit-defaults.js';

/**
 * Voice-engine config: the bridge, guards, VoiceLink adapter, rate limiter, clip
 * decode, S3 and the PostHog client read their settings from these blocks.
 */

const concurrencySchema = z.object({
  /**
   * `MAX_CONCURRENT_CALLS`: the process-wide ceiling on call legs holding a concurrency slot
   * (the global guard). Per-account limits and the carrier allocation (super-admin settings)
   * are the business limits; this one guards the process, so it must sit above what a full
   * floor legitimately holds, or the bridge refuses dials the pacing tick placed.
   *
   * A slot is held from admission until the leg is finalised, which is longer than talk
   * time. Sized for 500 agents, ~170 answered calls a minute at ~3 dials per answer
   * (~510 dials a minute):
   *  - unanswered dials hold a slot until VoiceLink's terminal report, dial + 45–75 s:
   *    ~340 a minute × ~60 s ≈ 340 legs;
   *  - answered calls ring first: ~170 × ~15 s ≈ 40 legs;
   *  - live talk: ~170 a minute × ~2.3 min ≈ 390 legs;
   *  - `ending`: an answered hangup waits up to 45 s for the carrier's `call.ended`:
   *    ~170 × ~30 s ≈ 85 legs.
   * ≈ 860 at peak; 1000 leaves ~15% headroom. (It was 200: a ~70-agent floor.)
   */
  maxConcurrentCalls: z.coerce.number().int().min(1).default(1000),
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

const voicelinkSchema = z.object({
  /** VoiceLink REST base URL, e.g. https://app.voicelink.co.in/api. */
  baseUrl: z.string().optional().default(''),
  /** POST /v1/auth/login field. Secret-adjacent — never log. */
  username: z.string().optional().default(''),
  /** POST /v1/auth/login field. Secret — never log. */
  password: z.string().optional().default(''),
  /** Our public base for the webhook_url + to derive the per-lead websocket_url host. */
  webhookBaseUrl: z.string().optional().default(''),
  /**
   * Default calling country code (no `+`, e.g. `91`). Used to split req.to into
   * the bare `customer_number` + separate `country_code` fields add_lead requires.
   */
  defaultCountryCode: z.string().optional().default('91'),
  /**
   * `VOICELINK_LOGIN_TIMEOUT_MS`: abandon a login after this long. The login is
   * single-flight, so every dial waits on it; a timeout rejects them all once and the next
   * dial logs in afresh. Default 10 s (`voicelink-token-manager.ts`).
   */
  loginTimeoutMs: z.coerce.number().int().min(1000).max(120_000).default(10_000),
  /**
   * `VOICELINK_ADD_LEAD_TIMEOUT_MS`: abandon an `add_lead` after this long. A timed-out
   * add_lead fails the dial but may have queued the lead, so it is never retried and the
   * contact's redial is deferred (`voicelink.adapter.ts`, `post`). Default 15 s.
   */
  addLeadTimeoutMs: z.coerce.number().int().min(1000).max(120_000).default(15_000),
});

/**
 * What every Plivo adapter shares, from env (`telephony/plivo/plivo.adapter.ts`). The
 * Plivo accounts themselves are tenants' (BYOC, decision B18), stored per tenant under
 * `telephonyCredentials`; nothing here names an account.
 */
const plivoSchema = z.object({
  /**
   * `PLIVO_WEBHOOK_BASE_URL`: this server's public base for Plivo's callbacks, e.g.
   * `https://<public host>/api/v1/webhooks/plivo`. Env only, never tenant data: Plivo
   * POSTs the answer and status callbacks that drive a call here. Unset, Plivo dials are
   * refused before anything is sent.
   */
  webhookBaseUrl: z.string().optional().default(''),
  /**
   * `PLIVO_CALLS_PER_SECOND`: new calls a second per Plivo account (Plivo's default
   * account limit is 2). Counted across every process in Redis.
   */
  callsPerSecond: z.coerce.number().int().min(1).max(100).default(2),
  /**
   * `PLIVO_DIAL_RATE_MAX_WAIT_MS`: the longest a dial waits for a calls-per-second slot
   * before it is refused unsent (a retryable refusal). Default 5 s.
   */
  dialRateMaxWaitMs: z.coerce.number().int().min(0).max(60_000).default(5_000),
  /**
   * `PLIVO_REQUEST_TIMEOUT_MS`: abandon a Plivo REST request after this long. A timed-out
   * create-call may have placed the call, so it is never retried. Default 15 s.
   */
  requestTimeoutMs: z.coerce.number().int().min(1000).max(120_000).default(15_000),
  /** `PLIVO_RING_TIMEOUT_SECONDS`: how long Plivo lets a dial ring. Default 45 s. */
  ringTimeoutSeconds: z.coerce.number().int().min(5).max(120).default(45),
});

/**
 * The service's own carrier account: VoiceLink, configured here from env. Tenant
 * carrier accounts (BYOC, decision B18) are not configured here; they are stored
 * per tenant, sealed under `telephonyCredentials` below.
 *
 * The VoiceLink `requireField` checks run when `requireVoicelink` is true, which
 * the env reader sets in production or when `TELEPHONY_ENABLED_PROVIDERS` names
 * `voicelink` — so a misconfigured production deploy still fails fast, while the
 * unit-test env (which carries no carrier credentials) parses.
 */
export const telephonySchema = z.object({
  requireVoicelink: z.boolean().default(false),
  voicelink: voicelinkSchema.default({}),
  plivo: plivoSchema.default({}),
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
});

// Why each bucket exists is in the rate-limit middleware header; the defaults and their
// sizing for a 500-agent floor behind one NAT are in `api/middleware/rate-limit-defaults.ts`.
// The per-USER ceiling is not here: it keys on the verified user, which is the platform
// block's (`userRateLimit`, `RATE_LIMIT_USER_MAX`).
const rateLimitSchema = z.object({
  max: z.coerce.number().int().min(1).default(DEFAULT_RATE_LIMIT_MAX),
  /** `RATE_LIMIT_IP_AUTH_MAX`: the per-IP ceiling for requests carrying `Authorization: Bearer`. */
  ipAuthMax: z.coerce.number().int().min(1).default(DEFAULT_RATE_LIMIT_IP_AUTH_MAX),
  webhookMax: z.coerce.number().int().min(1).default(DEFAULT_RATE_LIMIT_WEBHOOK_MAX),
  carrierMediaMax: z.coerce.number().int().min(1).default(DEFAULT_RATE_LIMIT_CARRIER_MEDIA_MAX),
  /** `RATE_LIMIT_STATION_MAX`: station socket upgrades per IP (single-use token, no bearer). */
  stationMax: z.coerce.number().int().min(1).default(DEFAULT_RATE_LIMIT_STATION_MAX),
  internalMax: z.coerce.number().int().min(1).default(DEFAULT_RATE_LIMIT_INTERNAL_MAX),
  timeWindow: z.string().default(DEFAULT_RATE_LIMIT_WINDOW),
});

// The app's own bucket.
const s3Schema = z.object({
  audioBucket: z.string(),
  region: z.string().default('ap-south-1'),
  accessKeyId: z.string(),
  secretAccessKey: z.string(),
});

// Only the on-disk clip-cache sweeper knobs: the app synthesises no TTS. The key
// name is what the sweeper wiring reads.
const staticCallTtsSchema = z.object({
  cacheTtlMs: z.coerce.number().int().min(0).default(21_600_000), // 6h
  cacheMaxBytes: z.coerce.number().int().min(0).default(524_288_000), // 500MB
  cacheSweepIntervalMs: z.coerce.number().int().min(0).default(3_600_000), // 1h
});

const audioSchema = z.object({
  decodeTimeoutMs: z.coerce.number().int().min(1000).default(90_000),
  decodeConcurrency: z.coerce.number().int().min(1).default(2),
});

// The voice engine owns the PostHog client; the analysis LLM observability reads
// the two llm* keys.
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

/**
 * The master keyring that seals per-tenant carrier credentials (decision B19).
 *
 * `TELEPHONY_CREDENTIAL_KEYS` is `<id>:<base64 of 32 bytes>`, comma-separated, e.g.
 * `v1:…,v2:…`; `TELEPHONY_CREDENTIAL_ACTIVE_KEY` names the one new seals use. Old ids
 * stay listed until every row sealed under them is re-sealed. Unset = no credential
 * store: creating a credential is refused and a call pinned to one fails closed.
 *
 * Errors name the key id, never the key material.
 */
const KEY_ID = /^[a-z0-9_-]{1,32}$/;

/**
 * The entries of a `TELEPHONY_CREDENTIAL_KEYS` value: split on commas, trimmed, blanks
 * dropped. No entries (`""`, `" "`, `","`, `",,"`) means no credential store. The
 * schema below, `buildSealerFromConfig` (`telephony/credentials/index.ts`) and
 * `EnvKeyringWrapper` all read the value through this, so they cannot disagree: a
 * value the schema accepts as "store off" must not then fail to build a keyring at
 * first use.
 */
export function keyringEntries(keyring: string): string[] {
  return keyring.split(',').map((s) => s.trim()).filter(Boolean);
}

export const telephonyCredentialsSchema = z.object({
  keyring: z.string().optional().default(''),
  activeKeyId: z.string().optional().default(''),
}).superRefine((data, ctx) => {
  const entries = keyringEntries(data.keyring);
  if (entries.length === 0) {
    if (data.activeKeyId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['keyring'], message: 'TELEPHONY_CREDENTIAL_ACTIVE_KEY is set but TELEPHONY_CREDENTIAL_KEYS is empty' });
    }
    return;
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    const sep = entry.indexOf(':');
    const id = sep > 0 ? entry.slice(0, sep) : '';
    if (!KEY_ID.test(id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['keyring'], message: 'TELEPHONY_CREDENTIAL_KEYS: every entry must be <id>:<base64>, id matching [a-z0-9_-]{1,32}' });
      continue;
    }
    if (seen.has(id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['keyring'], message: `TELEPHONY_CREDENTIAL_KEYS: key id '${id}' is listed twice` });
    }
    seen.add(id);
    // Guarded: a refine runs on a dirty result, and the value is a secret, so it is
    // never echoed.
    // Strict: the text must be the canonical base64 of the bytes it decodes to, so a
    // stray character cannot be silently dropped (the sealer applies the same rule).
    let ok = false;
    try {
      const b64 = entry.slice(sep + 1);
      const key = Buffer.from(b64, 'base64');
      ok = key.length === 32 && key.toString('base64') === b64;
    } catch { ok = false; }
    if (!ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['keyring'], message: `TELEPHONY_CREDENTIAL_KEYS: key '${id}' must be 32 bytes of base64` });
    }
  }
  if (!data.activeKeyId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['activeKeyId'], message: 'TELEPHONY_CREDENTIAL_ACTIVE_KEY is required when TELEPHONY_CREDENTIAL_KEYS is set' });
  } else if (!seen.has(data.activeKeyId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['activeKeyId'], message: `TELEPHONY_CREDENTIAL_ACTIVE_KEY '${data.activeKeyId}' is not in TELEPHONY_CREDENTIAL_KEYS` });
  }
});

export const voiceConfigSchema = z.object({
  concurrency: concurrencySchema.default({}),
  telephony: telephonySchema,
  telephonyCredentials: telephonyCredentialsSchema.default({}),
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
        defaultCountryCode: env['VOICELINK_DEFAULT_COUNTRY_CODE'],
        loginTimeoutMs: env['VOICELINK_LOGIN_TIMEOUT_MS'],
        addLeadTimeoutMs: env['VOICELINK_ADD_LEAD_TIMEOUT_MS'],
      },
      plivo: {
        webhookBaseUrl: env['PLIVO_WEBHOOK_BASE_URL'],
        callsPerSecond: env['PLIVO_CALLS_PER_SECOND'],
        dialRateMaxWaitMs: env['PLIVO_DIAL_RATE_MAX_WAIT_MS'],
        requestTimeoutMs: env['PLIVO_REQUEST_TIMEOUT_MS'],
        ringTimeoutSeconds: env['PLIVO_RING_TIMEOUT_SECONDS'],
      },
    },
    telephonyCredentials: {
      keyring: env['TELEPHONY_CREDENTIAL_KEYS'],
      activeKeyId: env['TELEPHONY_CREDENTIAL_ACTIVE_KEY'],
    },
    rateLimit: {
      max: env['RATE_LIMIT_MAX'],
      ipAuthMax: env['RATE_LIMIT_IP_AUTH_MAX'],
      webhookMax: env['RATE_LIMIT_WEBHOOK_MAX'],
      carrierMediaMax: env['RATE_LIMIT_CARRIER_MEDIA_MAX'],
      stationMax: env['RATE_LIMIT_STATION_MAX'],
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

// PORT NOTE (magick-agency): ported from magic-voice-core/src/analytics/client.ts@4850d1d9;
// only the logger import specifier changed.
/**
 * Shared PostHog transport.
 *
 * Owns the single `posthog-node` client, the resolved environment tag, and the
 * low-level `capture()` primitive. Two event catalogs sit on top of this one
 * client:
 *  - `posthog.ts` — product/business events (call lifecycle, batches, IVR, …).
 *  - `llm-observability.ts` — PostHog LLM Analytics (`$ai_generation`) events.
 *
 * Keeping the transport here (rather than in either catalog) means there is
 * exactly one client, one lifecycle, one environment tag, and one identity
 * model — `distinct_id = account_id`, every event grouped under the `tenant`
 * group — regardless of which catalog emits.
 *
 * Design rules (shared by both catalogs):
 *  - **Never throws into the caller.** `capture()` is best-effort; failures are
 *    logged and swallowed.
 *  - **No-op when disabled.** When `config.analytics.enabled` is false (or no
 *    API key is configured) the client is never constructed and `capture()` is
 *    a cheap no-op.
 */
import { PostHog } from 'posthog-node';
import { config } from '../config/index.js';
import { createChildLogger } from '@magick-agency/observability';

const log = createChildLogger({ component: 'analytics' });

/** PostHog group type used to roll events up per tenant. */
const GROUP_TYPE_TENANT = 'tenant';

let client: PostHog | null = null;

/**
 * Deployment environment tag attached to every event (e.g. `staging`,
 * `production`). Resolved at init from `POSTHOG_ENVIRONMENT`, falling back to
 * `NODE_ENV`. A dedicated flag is required because staging and production often
 * both run `NODE_ENV=production`, so `NODE_ENV` alone can't tell them apart.
 */
let environment = 'development';

/**
 * Constructs the PostHog client from config. Safe to call once at startup and
 * idempotent thereafter. No-op (leaving the module disabled) when analytics is
 * off or no API key is present.
 */
export function initPostHogClient(): void {
  if (client) return;

  const cfg = config.analytics;
  if (!cfg.enabled) {
    log.info('PostHog analytics disabled (POSTHOG_ENABLED is not set)');
    return;
  }
  if (!cfg.apiKey) {
    // Should be unreachable — the config schema requires apiKey when enabled —
    // but guard anyway so a misconfig degrades to no-op rather than crashing.
    log.warn('POSTHOG_ENABLED is true but POSTHOG_API_KEY is missing; analytics disabled');
    return;
  }

  // Dedicated env flag wins; fall back to NODE_ENV (config.server.env).
  environment = cfg.environment || config.server?.env || 'development';

  client = new PostHog(cfg.apiKey, {
    host: cfg.host,
    flushAt: cfg.flushAt,
    flushInterval: cfg.flushIntervalMs,
    requestTimeout: cfg.requestTimeoutMs,
  });

  log.info(
    { host: cfg.host, flushAt: cfg.flushAt, environment, llmObservability: cfg.llmObservabilityEnabled },
    'PostHog analytics initialized',
  );
}

/**
 * Flushes any buffered events and shuts the client down. Awaited during
 * graceful shutdown so in-flight events are not lost. No-op when disabled.
 */
export async function shutdownPostHogClient(): Promise<void> {
  if (!client) return;
  try {
    await client.shutdown();
    log.info('PostHog analytics flushed and shut down');
  } catch (err) {
    log.error({ err }, 'PostHog analytics shutdown failed');
  } finally {
    client = null;
  }
}

/** True when the PostHog client is active. */
export function isPostHogEnabled(): boolean {
  return client !== null;
}

/** Drop `undefined` values so events stay tidy; keep `false`/`0`/`null`. */
export function clean(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Best-effort capture. `distinctId` is the account; tenant is attached as a
 * group and echoed as a property (plus the environment tag) for easy filtering
 * in insights. Never throws.
 */
export function capture(
  event: string,
  tenantId: string,
  accountId: string,
  properties: Record<string, unknown>,
): void {
  if (!client) return;
  try {
    client.capture({
      distinctId: accountId,
      event,
      properties: {
        ...clean(properties),
        environment,
        tenant_id: tenantId,
        account_id: accountId,
      },
      groups: { [GROUP_TYPE_TENANT]: tenantId },
    });
  } catch (err) {
    // Capturing only enqueues, so this is unexpected — log and drop, never throw.
    log.error({ err, event }, 'PostHog capture failed; event dropped');
  }
}

/**
 * Best-effort group-property upsert (e.g. attach a human-readable `name` to a
 * `tenant`/`account` group). Set once per group, the property then renders on
 * every event grouped under that key in the PostHog UI — no need to stamp it on
 * each event. Never throws; no-op when disabled.
 */
export function identifyGroup(
  groupType: string,
  groupKey: string,
  properties: Record<string, unknown>,
): void {
  if (!client) return;
  try {
    client.groupIdentify({ groupType, groupKey, properties: clean(properties) });
  } catch (err) {
    log.error({ err, groupType }, 'PostHog groupIdentify failed; dropped');
  }
}

// Inbound operations on a deployment (docs/inbound.md §3.2, §3.3, §8.1; docs/operations.md
// "Inbound calls"): what an operator must hear about without opening a page.
//
//  - Connect availability (IB8): with media workers on (`MEDIA_WORKERS > 0`) inbound calls are
//    answered but nobody is put through to an agent, and every open route's caller hears the
//    call-back message. `agency_inbound_connect_available` says which, set once at boot, and a
//    boot warning names the condition when any credential has inbound enabled
//    (`agy-inbound-connect-unavailable` alerts on the two together).
//  - Outage cover (§3.3): in production, inbound enabled with no
//    `PLIVO_INBOUND_FALLBACK_ANSWER_URL` means a caller who rings while this deployment is down
//    hears nothing useful (the fallback is our own route, down with us): a boot warning.
//  - The Application health check, on a timer: every inbound-enabled credential's carrier
//    Application compared with what is stored (`TelephonyInboundService.health`), every
//    {@link INBOUND_HEALTH_INTERVAL_MS}, the results counted in `agency_inbound_applications`
//    (`agy-inbound-application-broken`, `agy-inbound-application-unchecked`) and each one that is
//    not `ok` logged with its credential and tenant. An Application someone edits in the
//    carrier's console otherwise breaks inbound with no signal: its calls are refused (the token
//    or URL no longer matches) until a super-admin clicks Check health. No credential with
//    inbound enabled: nothing is asked, nothing is logged, the gauges read 0.
//
// Main process only (`bootstrap/voice.ts`), once per deployment.
import { createChildLogger } from '@magick-agency/observability';
import {
  INBOUND_APPLICATION_HEALTHS,
  trackInboundApplicationHealth,
  trackInboundConnectAvailable,
  type InboundApplicationHealth,
} from '@magick-agency/observability/metrics/agency';
import type { TelephonyCredentialRepository } from '@magick-agency/db/repositories/telephony-credential.repository';
import type { TelephonyInboundService } from './inbound-service.js';

const log = createChildLogger({ component: 'telephony-inbound-monitor' });

/** How often every inbound-enabled credential's Application is checked. */
export const INBOUND_HEALTH_INTERVAL_MS = 15 * 60 * 1000;

export interface InboundMonitorDeps {
  credentials: Pick<TelephonyCredentialRepository, 'listInboundEnabled'>;
  inbound: Pick<TelephonyInboundService, 'health'>;
  /** `MEDIA_WORKERS`. */
  mediaWorkers: number;
  /** `NODE_ENV=production` (staging included: it runs production builds). */
  production: boolean;
  /** `PLIVO_INBOUND_FALLBACK_ANSWER_URL` ('' when unset). */
  fallbackAnswerUrl: string;
}

const zeroCounts = (): Record<InboundApplicationHealth, number> =>
  Object.fromEntries(INBOUND_APPLICATION_HEALTHS.map((h) => [h, 0])) as Record<InboundApplicationHealth, number>;

/**
 * One health pass over every inbound-enabled credential, one at a time (each a carrier request
 * bounded by `PLIVO_REQUEST_TIMEOUT_MS`). Sets `agency_inbound_applications` and returns the
 * counts; null when the credentials could not be listed (the gauges keep their last values).
 */
export async function runInboundHealthPass(deps: Pick<InboundMonitorDeps, 'credentials' | 'inbound'>): Promise<Record<InboundApplicationHealth, number> | null> {
  let enabled: Awaited<ReturnType<InboundMonitorDeps['credentials']['listInboundEnabled']>>;
  try {
    enabled = await deps.credentials.listInboundEnabled();
  } catch (err) {
    log.warn({ err }, 'Inbound Application health check could not list the credentials with inbound enabled');
    return null;
  }
  const counts = zeroCounts();
  for (const { credential_id: credentialId, tenant_id: tenantId, status } of enabled) {
    let health: InboundApplicationHealth;
    try {
      const r = await deps.inbound.health(credentialId);
      if (r.ok) {
        health = r.value.health.health;
        if (health !== 'ok') {
          log.warn(
            { credentialId, tenantId, credentialStatus: status, health, mismatched: r.value.health.mismatched },
            health === 'unreachable'
              ? 'Inbound Application could not be checked: the carrier did not answer'
              : 'Inbound Application does not match what is stored: its calls are refused until a super-admin re-points it',
          );
        }
      } else {
        health = 'failed';
        log.warn({ credentialId, tenantId, credentialStatus: status, code: r.code }, 'Inbound Application health check refused for a credential');
      }
    } catch (err) {
      health = 'failed';
      log.warn({ err, credentialId, tenantId }, 'Inbound Application health check failed for a credential');
    }
    counts[health]++;
  }
  trackInboundApplicationHealth(counts);
  return counts;
}

/**
 * Start the monitor: the connect gauge and the boot warnings now, a health pass in the
 * background, then one every `intervalMs` (a pass never starts while the previous one runs).
 * Resolves once the boot warnings are decided; returns the stop function.
 */
export async function startInboundMonitor(deps: InboundMonitorDeps, intervalMs = INBOUND_HEALTH_INTERVAL_MS): Promise<() => void> {
  trackInboundConnectAvailable(deps.mediaWorkers === 0);
  let enabledCount = 0;
  try {
    enabledCount = (await deps.credentials.listInboundEnabled()).length;
  } catch (err) {
    log.warn({ err }, 'Could not read the credentials with inbound enabled at boot');
  }
  if (enabledCount > 0 && deps.mediaWorkers > 0) {
    log.warn(
      { mediaWorkers: deps.mediaWorkers, inboundCredentials: enabledCount },
      'Inbound calls are enabled but MEDIA_WORKERS is above 0: callers are answered, nobody is put through to an agent, and every open route answers with the call-back message (IB8). Run with MEDIA_WORKERS=0 while any credential has inbound enabled',
    );
  }
  if (enabledCount > 0 && deps.production && deps.fallbackAnswerUrl === '') {
    log.warn(
      { inboundCredentials: enabledCount },
      'Inbound calls are enabled with no PLIVO_INBOUND_FALLBACK_ANSWER_URL: while this deployment is down, callers reach a fallback served by this deployment, so they hear nothing. Host the fallback XML off this deployment, set the URL and re-point each credential (docs/inbound.md §3.3)',
    );
  }

  let running: Promise<unknown> | null = runInboundHealthPass(deps).finally(() => { running = null; });
  const timer = setInterval(() => {
    if (running) return;
    running = runInboundHealthPass(deps).finally(() => { running = null; });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

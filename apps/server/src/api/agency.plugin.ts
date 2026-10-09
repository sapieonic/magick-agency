import type { FastifyPluginAsync } from 'fastify';
import type { AppContext } from '../app-context.js';
import { ensureVoiceEngine } from '../bootstrap/voice.js';
import { ensureAgencyRuntime, getAgencyRuntime } from '../bootstrap/agency.js';
import type { AgencyRuntime } from '../agency/runtime.js';
import { proxyAgencyAgentRoutes } from './routes/proxy-agency-agent.routes.js';
import { proxyAgencyStationRoutes } from './routes/proxy-agency-station.routes.js';
import { dncAvailabilityProbe } from '../agency/dnc-availability.js';
import { buildCoreHandlers } from './core-handlers.js';
import { getCoreHandlers, setCoreHandlers } from './core-dispatch.js';
import { rejectMalformedIdParams, rejectMalformedTenantHeader } from './agency-id-guard.js';
import { dncRoutes } from './routes/dnc.routes.js';
import { phoneNumberRoutes } from './routes/phone-number.routes.js';
import { proxyAgencyCampaignsRoutes } from './routes/proxy-agency-campaigns.routes.js';
import { proxyAgencyStaffingRoutes } from './routes/proxy-agency-staffing.routes.js';
import { proxyAgencyPerformanceRoutes } from './routes/proxy-agency-performance.routes.js';
import { proxyAgencyCallsRoutes } from './routes/proxy-agency-calls.routes.js';
import type { AgencyCampaignRouteDeps } from './routes/agency-campaigns.routes.js';
import { callAnalysisProfilesRoutes } from './routes/call-analysis-profiles.routes.js';
import { platformProfileRouteAuth } from './profile-route-auth.js';
import { agencyCampaignRepository } from '../db/repositories/agency.repository.js';

/**
 * Every prefix the agency API is served under — the paths the console calls (decision
 * B16). The route-table tests read this list rather than a copy of it.
 */
export const AGENCY_ROUTE_PREFIXES = {
  /** The agency plugins on one prefix. */
  proxyAgency: '/proxy/agency',
  /** The station socket (`proxy-agency-station.routes.ts`). */
  proxyAgencyStation: '/proxy/agency/station',
  /** The DNC list. */
  dnc: '/dnc',
  /** Call-analysis profiles (the console's `ENDPOINTS.proxy.callAnalysisProfiles`). */
  callAnalysisProfiles: '/proxy/call-analysis-profiles',
  /** The caller-ID list (`GET` only; see the route file). */
  phoneNumbers: '/phone-numbers',
} as const;

/** The campaign handlers' `requireOwned` 404 (`agency-campaigns.routes.ts`). */
const CAMPAIGN_NOT_FOUND = {
  status: 404,
  body: { error: 'Not Found', code: 'campaign_not_found', message: 'Campaign not found' },
} as const;

/**
 * The agency API: the public API layer's agency route plugins at the console's paths,
 * reaching the internal handler instance in-process (`core-dispatch.ts`, decision B16).
 *
 * Scope-local, because this plugin is NOT `fastify-plugin` wrapped:
 *  - the `X-Tenant-Id` shape check (`agency-id-guard.ts`);
 *  - the internal handler instance (`core-handlers.ts`), closed with the app.
 *
 * `errorHandler` (with the 22P02 backstop) and the 5xx error mask are app-wide (`app.ts`).
 *
 * Each family is registered in its own wrapper scope, so a malformed-id guard answers
 * with THAT family's not-found body, and families whose route file already validates its
 * ids (staffing, performance, calls: their own 400s) get none.
 */
export const agencyPlugin: FastifyPluginAsync<{ ctx: AppContext | null }> = async (app, opts) => {
  app.addHook('preHandler', rejectMalformedTenantHeader());

  // The agency runtime, which both agency handler plugins use. Created here with a
  // context; every READ of it is a lookup per request (`getAgencyRuntime()`), never a reference captured at registration,
  // so a runtime replaced after `buildApp` (tests reset it) is the one a request sees.
  // Without a context (route-table tests) there is none, and a runtime-backed handler
  // answers through its own error path (the strip's `bestEffort`, a 500 elsewhere).
  const ctx = opts.ctx;
  if (ctx) ensureAgencyRuntime(ctx.redis, ctx.config.redis.keyPrefix);

  const campaignDeps: AgencyCampaignRouteDeps = {
    runtime: {
      // The same `DncRegistry` the pre-dial gate reads (`runtime.dnc`), probed — B8.
      dnc: {
        appliedVersion: (tenantId: string) =>
          dncAvailabilityProbe(getAgencyRuntime()?.dnc).appliedVersion(tenantId),
      },
      // The runtime's station registry. Without a runtime the strip
      // degrades to `connected: null` ("unknown") through the handler's own `bestEffort`.
      stations: {
        connectedBySession: (sessionIds: readonly string[]) => liveRuntime().stations.connectedBySession(sessionIds),
      },
    },
    // The voice engine's guard host owns `accountConcurrencyGuard`. Without a
    // context (route-table tests) the read degrades to `null`, as a Redis fault would.
    callManager: opts.ctx
      ? ensureVoiceEngine(opts.ctx.redis).guardHost
      : {
          accountConcurrencyGuard: {
            getDistributedAccountCount: async () => ({ status: 'unavailable' as const }),
          },
        },
  };
  // `agencyRoutes(app, agencyRuntime)` (sessions and attempts) gets the runtime as a
  // per-access lookup (`lazyRuntime`), so the handler module keeps its plain signature.
  const core = await buildCoreHandlers({ campaigns: campaignDeps, agency: { runtime: lazyRuntime() } });
  setCoreHandlers(core);
  app.addHook('onClose', async () => {
    if (getCoreHandlers() === core) setCoreHandlers(null);
    await core.close();
  });

  const P = AGENCY_ROUTE_PREFIXES;

  // ── Campaigns: CRUD, config, stats, series, activity, spine, retry, lifecycle, ingest ──
  await app.register(async (scope) => {
    // A malformed campaign id is the `campaign_not_found` 404 an unknown id gets (never a
    // `22P02` 500). Only under `/campaigns/`: this plugin's `/ingest/jobs/:id` is an ingest
    // job, which the handler answers itself (`isIngestJobId` → 404 `Import not found.`).
    scope.addHook('preHandler', rejectMalformedIdParams(
      { id: CAMPAIGN_NOT_FOUND },
      { onlyUnder: `${P.proxyAgency}/campaigns/` },
    ));
    await scope.register(proxyAgencyCampaignsRoutes, { prefix: P.proxyAgency });
  });

  // ── Staffing (its own zod 400 for `:id` / `:userId`) ───────────────────────────────
  await app.register(async (scope) => {
    await scope.register(proxyAgencyStaffingRoutes, { prefix: P.proxyAgency });
  });

  // ── Agent performance (its own 400 for `:userId`) ──────────────────────────────────
  await app.register(async (scope) => {
    await scope.register(proxyAgencyPerformanceRoutes, { prefix: P.proxyAgency });
  });

  // ── The agency call read (`requireUuidPathParams`, 400) ─────────────────────────────
  await app.register(async (scope) => {
    await scope.register(proxyAgencyCallsRoutes, { prefix: P.proxyAgency });
  });

  // ── Call-analysis profiles ─────────────────────────────────────────────────────────
  await app.register(async (scope) => {
    // The handlers answer an unknown profile with 404 `Analysis profile not found`; a
    // malformed id gets the same answer instead of a `22P02`.
    scope.addHook('preHandler', rejectMalformedIdParams({
      id: { status: 404, body: { error: 'Not Found', message: 'Analysis profile not found' } },
    }));
    await scope.register(callAnalysisProfilesRoutes, {
      prefix: P.callAnalysisProfiles,
      auth: platformProfileRouteAuth(),
      // The agency repository carries both methods the reference check reads
      // (`findLiveDependentsOnAnalysisProfile`, `countLiveCampaignsInheritingAccountDefault`);
      // without it PUT/DELETE answer 503 rather than retire a profile unguarded.
      dependents: agencyCampaignRepository,
    });
  });

  // ── DNC (no internal handler hop) ──────────────────────────────────────────────────
  await app.register(async (scope) => {
    // `dnc.routes.ts` DELETE answers 404 `DNC entry not found` for an id it cannot
    // find in the caller's scope; a malformed id is the same answer.
    scope.addHook('preHandler', rejectMalformedIdParams({
      id: { status: 404, body: { error: 'Not Found', message: 'DNC entry not found' } },
    }));
    await scope.register(dncRoutes, { prefix: P.dnc });
  });

  // ── The caller-ID list (no internal handler hop; no path params) ─────────────────────
  await app.register(async (scope) => {
    await scope.register(phoneNumberRoutes, { prefix: P.phoneNumbers });
  });

  // ── Agent and supervisor actions (`proxy-agency-agent.routes.ts`) ────────────────────
  await app.register(async (scope) => {
    // The handlers answer an id they cannot find with 404 `Session not found` / `Attempt not
    // found` (`requireOwnedSession` / `requireOwnedAttempt`); a malformed id is the same answer rather than a `uuid`-cast 22P02.
    scope.addHook('preHandler', rejectMalformedIdParams(
      { id: { status: 404, body: { error: 'Not Found', message: 'Session not found' } } },
      { onlyUnder: `${P.proxyAgency}/sessions/` },
    ));
    scope.addHook('preHandler', rejectMalformedIdParams(
      { id: { status: 404, body: { error: 'Not Found', message: 'Attempt not found' } } },
      { onlyUnder: `${P.proxyAgency}/attempts/` },
    ));
    await scope.register(proxyAgencyAgentRoutes, { prefix: P.proxyAgency });
  });

  // ── The agent station socket, at the console's path ────────────────────────────────
  // Served only at `/proxy/agency/station/:sessionId`: the route hands the socket to
  // `handleStationSocket`. `/api/v1/agency/station` is not registered (see the route).
  await app.register(proxyAgencyStationRoutes, {
    prefix: P.proxyAgencyStation,
    getRuntime: () => (ctx ? getAgencyRuntime() : null),
  });
};

/** The running runtime, or a throw a handler turns into its own error answer. */
function liveRuntime(): AgencyRuntime {
  const runtime = getAgencyRuntime();
  if (!runtime) throw new Error('agency runtime is not running');
  return runtime;
}

/**
 * An `AgencyRuntime` whose every member is read from the current runtime at access time.
 * `agencyRoutes` takes the runtime object once at registration; this keeps that
 * signature without pinning whichever instance existed then.
 */
function lazyRuntime(): AgencyRuntime {
  return new Proxy({} as AgencyRuntime, {
    get(_target, prop) {
      const runtime = liveRuntime();
      const value = Reflect.get(runtime, prop, runtime) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(runtime) : value;
    },
  });
}

import type { FastifyInstance } from 'fastify';
import { authMiddleware } from '../middleware/auth.middleware.js';
import type { AccountConcurrencyGuard } from '../../core/account-concurrency-guard.js';
import { registerCampaignCrudRoutes } from './agency-campaigns/crud.js';
import { registerCampaignStatsRoutes } from './agency-campaigns/stats.js';
import { registerCampaignSpineRoutes } from './agency-campaigns/spine.js';
import { registerCampaignRetryRoutes } from './agency-campaigns/retry.js';
import { registerCampaignLifecycleRoutes } from './agency-campaigns/lifecycle.js';
export { parseStatusFilter } from './agency-campaigns/crud.js';

/**
 * Campaign CRUD + lifecycle. The campaign is an EXECUTION object with one table,
 * `agency_campaigns`; the public API layer's proxy routes keep no copy of their own —
 * two writable copies of one business object is how they drift.
 *
 * **No concurrency setter appears here, deliberately.** The dialing ceiling is the
 * account's `max_concurrent_calls`, which is super-admin-only; a campaign reads it
 * and never sets it. `GET /:id/stats` reports utilisation against it read-only.
 */

/**
 * Dependencies the STATS route needs and no other route here does.
 *
 * The health strip's diagnoses need DNC availability and the account concurrency
 * counter, both of which live on objects this file has no other access to. Injected
 * the same way `agencyRoutes` receives its runtime, rather than reached through a
 * module singleton — the alternative makes every test in this file construct a
 * Redis.
 *
 * Narrowed to the two METHODS the stats strip calls, rather than to the objects
 * that own them. A test can then supply a faithful stub that type-checks on its
 * own terms, instead of casting a narrow literal through `never` — and a cast is
 * how a test ends up asserting against a permanently degraded strip without
 * anything saying so.
 */

/*
 * The two `runtime` members are typed structurally rather than as
 * `Pick<AgencyRuntime[...]>`, and `callManager` is the telephony guard host
 * (`TelephonyGuardHost`, which owns `accountConcurrencyGuard`). `dnc.appliedVersion` has
 * no Redis set behind it (decision B8): `agencyPlugin` supplies a probe of the same DNC
 * read the pre-dial gate makes, answering `null` exactly when that gate would halt — see
 * `agency/dnc-availability.ts`.
 */
export interface AgencyCampaignRouteDeps {
  runtime: {
    dnc: { appliedVersion(tenantId: string): Promise<number | null> };
    /**
     * Agent liveness for the supervisor floor's connected column.
     *
     * One method and no more, for the reason this whole interface is written in
     * methods: a test supplies a two-line stub that type-checks on its own terms
     * instead of constructing a `StationRegistry` and a Redis.
     *
     * Deliberately `connectedBySession` rather than `ownerOf` — the latter cannot
     * distinguish a Redis fault from an absent key, so it would report every agent
     * disconnected during a blip. See the method's own comment.
     */
    stations: { connectedBySession(sessionIds: readonly string[]): Promise<Map<string, boolean>> };
  };
  callManager: {
    accountConcurrencyGuard: Pick<AccountConcurrencyGuard, 'getDistributedAccountCount'>;
  };
}

export async function agencyCampaignRoutes(
  app: FastifyInstance,
  deps: AgencyCampaignRouteDeps,
): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // The routes, by family (`./agency-campaigns/`), on THIS instance so the hook
  // above applies to each of them; their shared guards are `./agency-campaigns/guards.ts`.
  await registerCampaignCrudRoutes(app);
  await registerCampaignStatsRoutes(app, deps);
  await registerCampaignSpineRoutes(app);
  await registerCampaignRetryRoutes(app);
  await registerCampaignLifecycleRoutes(app);
}

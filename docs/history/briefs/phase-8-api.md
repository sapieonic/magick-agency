# Phase 8: the merged API

You are the Phase 8 agent of the Magick Agency build. You build agency's one HTTP surface: every route the console and super-admin call. Lanes A (platform and super-admin routes), C (voice webhooks and the PSTN leg) and D (analysis profiles, recordings) already registered theirs. **You add the agency routes:**
- campaigns, ingest, retry, series, activity and stats;
- agents and performance, staffing, DNC, calls, station.

You also merge the four surfaces into one, and close the Phase 8 carry-forwards every lane recorded.

**Read `docs/history/briefs/ground-rules.md` first. It is binding.**

**Worktree:** `/Users/manasnilorout/Personal/Sapionic/magick-agency-p8`, branch `phase-8/api` (off `main`). **Test DB:** `magick_agency_test_p8`, Redis db 8.

## Plan and decisions
- Plan sections:
  - §1, the "browser → agency" and "one union" rows;
  - §3.1 and §3.2 (RBAC, per-account settings, MAG-138 per-field checks);
  - §3.4;
  - §6;
  - §8 Phase 8: "Core's and master's agency routes merged with the platform and super-admin routes into one surface. **Exit:** a route-table test enumerated from the router covers every console and super-admin path."
- **Decision B16 (new, lead):** the API serves the console's existing paths. These are the paths cusui @ `ee5beb44` calls on master: `/proxy/agency/...`, `/dnc/...`, and so on. That way the console ports with only its API base changed.
  - Each master route handler keeps its validation, RBAC, behavioural-settings checks and enrichment.
  - Its hop to core (`coreRequest` / `coreInternalRequest` / proxy forwarding) collapses into core's handler body, in-process. This is the pattern B2 used for the roster hand-off (`apps/server/src/agency/agency-roster.client.ts`; read it and B2's PORTING rows).
  - Core's route files (`src/api/routes/agency.routes.ts`, `agency-campaigns.routes.ts`, `agency-agents.routes.ts`, `agency-dnc.routes.ts`, `src/api/responses/agency-campaign.response.ts`) become handler modules you call. They are not separately exposed URL surfaces.
  - Core's `X-API-Key` / S2S auth goes. Master's session, tenant-context and `requirePermission` chain (lane A's) is the auth.
- `packages/contracts/src/api/agency/CONTRACT-DIFF.md` lists where core's shape and the console's wire shape differ. **The console's wire shape wins** (it is the consumer), and the merged server produces master's enrichments itself:
  - `agent_name` joins `users` directly (D3);
  - `inactive_omitted` / `unattributed_omitted`;
  - `partial`;
  - and so on.

  `agents_peak` has no producer anywhere. Leave it unserved, as master did, and list it.

## Sources
- **master** `magick-master@a1f0756a`: `src/api/routes/proxy-agency-campaigns.routes.ts` (3603 lines), `proxy-agency-staffing.routes.ts`, `proxy-agency-performance.routes.ts`, `proxy-agency-agent.routes.ts`, `proxy-agency-calls.routes.ts`, `proxy-agency-station.routes.ts`, `dnc.routes.ts`, and `api/routes/helpers/csv-attachment.ts`.
- **core** `magic-voice-core@4850d1d9`: the route files above, plus `src/index.ts:694-706` for how they were mounted.
- **cusui** `magick-comms-cusui@ee5beb44`: `src/api/*`, the console's actual calls. Use these to build the path list your route-table test must cover.

## Order of work
1. **Now (Phase 6 is still running, so `AgencyRuntime` is not on main):**
   - Write the inventory in a new `## Phase 8 — API` section of `PORTING.md`: every console and super-admin path (from cusui's `src/api`), its master handler, the core handler it hops to, and whether that core handler needs the runtime.
   - Port every route that does not need the runtime. Campaign CRUD and config probably qualify, as do ingest (B2's service), retry preview and create, series, activity (B2's service), stats enrichment, staffing, performance reads, DNC, calls and recordings detail. Check each one.
   - Write the route-table test.
   - Write the console-path coverage check: every path cusui's `src/api` calls must be registered, or listed as intentionally not served (AI, billing, SIP and the like).
2. **When the lead says "phase 6 merged":** merge main, then do the runtime routes:
   - sessions, ready/break/wrap-up/disposition, notes, DNC from the station, agent actions;
   - supervisor;
   - campaign start, pause and stop;
   - mount the station WebSocket handler Phase 6 exported, at the console's path, through master's `proxy-agency-station.routes.ts` token flow collapsed in-process.

## Authorised edits to lead-owned files (only these)
- **`apps/server/src/app.ts`:**
  - `@fastify/websocket` is already hoisted into `app.ts` by the lead; don't register it again.
  - Hoist core's rate limiter to app scope, as core registered it globally. This covers the tenant / ip / internal / exempt buckets for every route, including `POST /auth/session`, which currently has none.
    - Fix `EXEMPT_PATHS`: core's are `/health`, `/ready`; agency's are `/healthz`, `/readyz`.
    - Do NOT set `trustProxy`. That is open question Q7 for Manas; leave a comment.
  - Register `agencyPlugin` routes. You own `api/agency.plugin.ts`.
- **`apps/server/src/index.ts`:** hoist `initAnalytics()` (lane C's) above `app.listen`, as core initialised PostHog before listening. This is a lane C review carry-forward.
- **`packages/contracts/src/api/agency/*`:** the console-wire types only, where CONTRACT-DIFF reconciliation needs a field the console lacks (`callback_requested_at`, `supervisor_hold`, `deferred_hangup_ms`, and so on). Each edit gets a PORTING row.
  - Do not edit `packages/contracts/src/agency.ts` (core's frozen contract) without asking.

## Carry-forwards you must close (from every lane's PORTING section; grep for "Phase 8")
- B1 and B2: UUID-validate `tenantId`, `accountId`, `campaignId` and every other id before it reaches a `uuid` / `uuid[]` cast.
  - Malformed ids answer 400 or 404 per master's route, never 500.
  - Add one test per route family.
- B1: the `markDnc` transaction composition; the deferred formatter cases.
- B2:
  - prove campaign ownership BEFORE the activity read;
  - keep the `from >= to` refusal;
  - pass the campaign row's account as `ActivityQuery.accountId`;
  - always set `agency_ingest_jobs.account_id` from the proven owner;
  - raise `agency-agent-identity.test.ts`'s consumer-route count from 0 to 2.
- Lane A: the audited-call-site floor in `test/unit/audit/platform/audit-actor-call-sites.test.ts` goes from 4 to 22 as your audited routes land (agent 8, campaigns 6, staffing 2, DNC 2; master's counts). Each `platformAuditLogger.log` site is master's.
- Lane C: the limiter and websocket hoists (above).
- Lane D: `signRecordingUrl`'s default path and the unscoped profile read (see D's "Lead review notes").
- MAG-138: behavioural settings are checked per field on campaign writes, through lane A's `campaign-behavioral-settings.ts`. Pass the schema-PARSED config, never `request.body`.

## Tests
- Port master's route tests for every route you serve. These are the rows B2 and B1 classified `Phase 8` (28 + 23), plus master's route suites for staffing, performance, agent, calls and station.
- Port core's route tests where the handler body is core's.
- Master's tests asserted outgoing core requests. Those become assertions on the in-process effect, the same hop-collapse pattern lane A used for super-admin (see lane A's PORTING rows).
- **Exit gate:**
  - The route-table test enumerated from `onRoute` covers every console and super-admin path (super-admin paths come from cusui's `src/api/super-admin*.ts`; lane A serves them).
  - Real-Postgres integration tests for each route family. At minimum, tenant/account isolation: another tenant's or account's campaign is a 404, never data.
  - Every console path is either served or listed as not served, with the reason.

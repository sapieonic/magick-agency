# apps/server

One Fastify process, single replica. Deep detail: `docs/architecture.md` (composition, dialer
runtime, voice engine, analysis), `docs/seams.md` (where files go, the seams), `docs/modules.md`
(every module and its tests). SQL and migration rules: `packages/db/CLAUDE.md`.

## Shape

**Four module areas** (B4), each with exactly one file of each kind. Add to an area only here:

| Kind | Where |
|---|---|
| Config | `src/config/blocks/<area>.ts` (top-level keys must be disjoint: enforced at load and by `test/unit/config/blocks-disjoint.test.ts`; the key table is in `docs/seams.md` §2) |
| Routes | `src/api/<area>.plugin.ts` |
| Background work | `src/bootstrap/<area>.ts` |
| Metrics | `packages/observability/src/metrics/<area>.ts` |

- **platform**: identity (Firebase), tenancy, super-admin auth, RBAC, invites, settings, flags,
  notifications, audit (`src/auth`, `src/rbac`, `src/invites`, `src/settings`,
  `src/feature-flags`, `src/notifications`, `src/audit`).
- **agency** (`src/agency/`): the dialer runtime (pacing engine, dial dispatcher, agent state
  machine, station socket, wrap-up, reaper) and campaign management (roster ingest, dispositions,
  DNC, retries, staffing, stats). The soft phone (manual calls outside pacing) is
  `src/agency/softphone/` (`docs/softphone.md`, rulings SP1–SP7).
- **voice** (`src/core/`, `src/telephony/`): the WebRTC bridge (`src/core/webrtc-bridge-manager.ts`,
  `src/core/bridge/`), carrier modules (VoiceLink; Plivo on tenants' own accounts, B18–B22) and
  the credential store, concurrency guards, audio.
- **analysis**: post-call transcription and analysis worker, retention. Every AI request goes
  through the client factory in `src/ai/` (`openai_compatible`, `azure_openai`, `gemini`).

**Start order** (`src/index.ts`): platform → voice → agency → analysis, then listen. Shutdown
closes HTTP first, halts pacing, runs the drains together (media workers, analysis), then stops the
rest in reverse (`src/cluster/shutdown-order.ts`). Voice starts before agency so the bridge's startup
self-heal finishes before any pacing tick.

**`src/app.ts`** (`buildApp`) registers the app-wide pieces once (CORS when `CORS_ALLOWED_ORIGINS`
is set, rate limiter, error handler and 5xx mask, `@fastify/websocket`, health probes) before the
four plugins. CORS stays ahead of the rate limiter, or its `OPTIONS *` preflight route would be
charged to a bucket (`src/api/middleware/cors.ts`). `buildApp({ ctx: null })`
builds a routing-only app for tests.

**Public API layer → internal handlers (B16).** Public route handlers (auth, tenancy, RBAC,
validation, enrichment) call the dialer's handlers in-process through `callCore`
(`src/api/core-dispatch.ts`) on a private Fastify instance that never listens
(`src/api/core-handlers.ts`).

**Seams** (`src/seams/`, `docs/seams.md` §3): bridge → dialer runtime (the `WebRtcBridgeManager`
member set, pinned by a type-level test), bridge → analysis hooks, super-admin → concurrency
control, super-admin credential routes → carrier credential service. Change a seam in one commit
with its consumers and its pinning test, never by adapting one side to the other.

**Large route plugins:** the plugin function, its hooks and module note stay in
`src/api/routes/<family>.routes.ts`; the routes go in `src/api/routes/<family>/` as
`register…(app)` functions. Helpers shared by several route files: `src/api/routes/helpers/`.

**The agency repository** lives here, not in `packages/db` (B12): `src/db/repositories/agency.repository.ts`,
a barrel over `src/db/repositories/agency/`. Callers and `vi.mock` use the barrel path.

**Station socket** `/proxy/agency/station/:sessionId`: `client=console|mobile` (liveness, written
to `agency_agent_sessions.client_kind`) and `media=pcm16|alaw8`. An unknown value is refused 1008
before the single-use token is spent (`parseStationUpgradeQuery`). Detail: `docs/mobile.md`.

## Rules

- Enumerate routes from Fastify's `onRoute` hook (`buildApp({ onRoute })`), never by grep.
- Validate ids at the edge: a non-UUID string reaching a `uuid` cast is `22P02`.
- Zod `.refine` runs on a dirty result: guard `BigInt` / `JSON.parse` inside it.
- A new feature flag is declared in `packages/contracts/src/flags.ts` and registered in
  `src/feature-flags/registry.ts`.
- Redis holds leases, station and call tokens; it must not evict (`.env.example`).

## Tests

Run from this directory (dotenv resolves from cwd):

```bash
pnpm vitest run test/unit/agency/pacing-engine.test.ts
pnpm vitest run -c vitest.config.integration.ts test/integration/agency/<file>.test.ts
pnpm vitest run -t "<test name>"
INTEGRATION_LANE=rest pnpm test:integration        # skip the ~4.5 min wall-clock files
```

- Unit config excludes `test/integration/**`; integration runs file-serially (one database) with
  `packages/db/test/helpers/global-setup.ts`, which drops and re-migrates the test DB.
- `INTEGRATION_LANE=wall-clock|rest` splits off the files that wait on real timers (Redis
  TTLs, the mobile liveness grace; listed in `vitest.config.integration.ts`); unset runs everything.
- **Chaos suites:** `test/integration/agency/chaos/`, run with integration.
- **Load, soak and scenario suites:** `test/{unit,integration}/load/` and `test/unit/scenarios/`.
  `LOAD_SCALE` multiplies their sizes for a deliberate soak; `LOAD_SEED` reproduces a red run
  (`test/helpers/load-scale.ts`). Mocks in `test/mocks/`: a scriptable VoiceLink carrier and a
  simulated station fleet. Open defects are pinned as `it.fails`: when you fix one, flip it to
  `it` and say so.
- `test/unit/audio/decode.test.ts` needs `mpg123` and `sndfile-programs` installed; it fails
  rather than skips in CI without them.
- First super-admin (no seeded credentials):
  `SUPER_ADMIN_PASSWORD=… pnpm tsx scripts/create-super-admin.ts --email … --name …`

**Guard tests to keep green:** route tables (`test/unit/api/*route-table*.test.ts`,
`test/unit/agency/proxy-agency-route-table.test.ts`), agent-reach
(`test/unit/api/*-agent-reach.test.ts`), `test/unit/config/blocks-disjoint.test.ts`, the bridge
seam contract (`test/unit/core/webrtc-bridge-seam-contract.test.ts`,
`webrtc-bridge-manager.seams.test.ts`), the VoiceLink carrier fixture
(`test/unit/telephony/voicelink/voicelink-carrier.fixture.test.ts`), the branding guard
(`test/unit/branding/no-parent-brand.test.ts`, scans `src` and `packages/*/src` with comments
stripped).

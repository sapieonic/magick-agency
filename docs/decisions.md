# Decisions

Every decision that shapes Magick Agency, by ID, in one place. Read it when you need to know
whether something is settled, why the code is built the way it is, or what is still waiting on
someone. Source comments cite entries here by ID ("decision B8", "Q6 (Manas, 2026-10-09)"), so
IDs are never renumbered or reused. As of 2026-10-09.

Status words: **settled** (a founding product decision, not reopened here); **default, pending
Manas** (built with the recommended option, not yet ratified); **open** (no default yet; a launch
concern); **decided — keep** (Manas ruled the current behaviour stays); **decided — changed**
(Manas ruled a change, and it is implemented).

## 1. Settled product decisions (approved by Manas, 2026-10-08)

| # | Decision |
|---|---|
| S1 | Magick Agency is a self-contained application: its own server, database, Redis, storage and carrier account. It depends on vendors only, never on another service at runtime |
| S2 | It owns its voice engine (the WebRTC bridge and the VoiceLink adapter) and its own VoiceLink capacity: account, numbers and concurrency limits |
| S3 | It owns post-call analysis and transcripts, and its identity data: users, tenants, accounts, memberships, roles, invites |
| S4 | Sign-in uses Firebase Authentication, in a Firebase project that may be shared with other products; agency verifies tokens with its own service account. A separate identity layer may come later |
| S5 | Super-admins create tenants and add users, with their own login and their own console |
| S6 | No credits, billing or credit enforcement in v1. Metering is an open item |
| S7 | AI calling is out of scope |
| S8 | Stack: Node 22, Fastify, TypeScript, raw `pg`, node-pg-migrate, Vitest; Vite + React UIs; pnpm workspaces |

## 2. Launch decisions

Nine decisions about going live. Where there was a recommended option, it is built and recorded
as **default, pending Manas**.

| # | Question | Default used | Status |
|---|---|---|---|
| 1 | Invites still outstanding on the previous platform at launch | Re-issue them (only token hashes are stored, so they cannot be imported) | default, pending Manas |
| 2 | Existing phone numbers | — (move them to agency's VoiceLink account if VoiceLink allows, or buy new ones; a new caller ID is visible to customers) | open |
| 3 | Inbound calls to agency numbers in v1 | Play a message and hang up | default, pending Manas |
| 4 | Abandon clip | Uploaded audio file only, no TTS | default, pending Manas |
| 5 | Platform API keys | None in v1 | default, pending Manas |
| 6 | Super-admins | Created fresh in agency, not imported | default, pending Manas |
| 7 | Launch style | — (whole environment at once, or tenant by tenant; a tenant must sit wholly in one system) | open |
| 8 | Domain, feature freeze on the previous platform, rollback window | — (7 days proposed for the rollback window) | open |
| 9 | Metering | Not in v1 | open item |

## 3. Build decisions

In one line each:

- **B1** one `tsconfig` per package, tests included, so lint catches a broken test.
- **B2** workspace packages are consumed as TypeScript source; no build step between packages.
- **B3** one Postgres (5436, two databases) and one Redis (6383, db 0 dev / db 1 test) for dev and test.
- **B4** one file per module area for config, routes and background work.
- **B5** the server keeps CommonJS runtime semantics (esbuild `format: cjs`).
- **B6** agency's alert rules and dashboard are a Terraform module in `grafana/`, with its own state; routing comes from the Grafana stack's shared policy.
- **B7** two audit tables (`audit_logs` and `platform_audit_log`), written by one process.
- **B8** DNC is one table: an indexed, fail-closed dial-time read and one transactional mark.
- **B9** the campaign-management layer sits on top of the dialer domain and calls its repository in-process.
- **B10** infrastructure used by more than one module area lives in one shared place.
- **B11** cross-module seams are fixed files in `apps/server/src/seams/`.
- **B12** the agency repository lives in `apps/server/src/db/`, not `packages/db`, to avoid a package cycle.
- **B13** the guard host counts live bridged calls, so self-heal stays armed during calls.
- **B14** one S3 module, one bucket, one client, one config key.
- **B15** roster replace and clear refuse until a supersede primitive exists.
- **B16** the public API layer serves the console's paths and reaches the internal handler instance in-process through `callCore`.
- **B17** Magick Agency is a standalone brand; nothing user-visible links to or names another product.

The full entries:

| # | Decision | Why |
|---|---|---|
| B1 | One `tsconfig` per package covering `src` and `test`, `moduleResolution: Bundler`, `noEmit` | Lint must catch a broken test. Nothing is emitted by `tsc`: the server is bundled by esbuild, the UIs by Vite |
| B2 | Workspace packages are consumed as TypeScript source (package `exports` point at `src/*.ts`) | No build step between packages; esbuild and Vite compile them in place |
| B3 | Dev and test share one Postgres container (5436) with two databases, and one Redis (6383) with db 0 for dev and db 1 for tests | Two ports that collide with no other local stack. The test harnesses refuse any other port, any database not named `magick_agency_test*`, and Redis db 0 |
| B4 | Each module area (platform, agency, voice, analysis) has exactly one config block (`apps/server/src/config/blocks/<area>.ts`), one route plugin (`apps/server/src/api/<area>.plugin.ts`) and one bootstrap (`apps/server/src/bootstrap/<area>.ts`) | Each area's surface is in one place, and config blocks must declare disjoint top-level keys (checked at load and by a test). See `docs/seams.md` |
| B5 | Server modules keep CommonJS runtime semantics (esbuild `format: cjs`) | Server code uses `__dirname` and CommonJS-shaped imports |
| B6 | Agency's alert rules and dashboard live in this repo, in `grafana/`: a Terraform root module with its own local state, applied on its own. 13 `agy-*` rules select the service names `magick-agency(-.+)?` (production `magick-agency`, `magick-agency-Staging`, `magick-agency-Dedicated`) and carry the labels the Grafana stack's shared notification policy routes on, so they page the same PagerDuty service as the rest of the stack. The module manages no contact point, policy or mute timing. `pnpm test:grafana` checks every rule and panel against the metric declarations | Manas, 2026-10-09: "the alerts also should live in agency". The routing labels are a contract with the stack's policy, which this repo does not own (`grafana/README.md`). Metrics agency does not emit yet are listed there under "Known metric gaps" |
| B7 | Two audit tables: `audit_logs` (dialer events, the "Dialer" half of a campaign's activity trail) and `platform_audit_log` (console and admin actions, the "Console" half) | The campaign activity trail merges the two, each with its own retention horizon. One process writes both |
| B8 | DNC is one table, `dnc_entries`. The dial-time check is one indexed read (`idx_dnc_entries_tenant_phone`), widened by scope (tenant, account, campaign), and fails closed on a database error. An agent's mark writes `dnc_entries` in the same transaction as the attempt bookkeeping. No Redis copy, sync or versioning. `agency_dnc_outbox` exists in the schema, unused, reserved for mirroring DNC changes to the previous platform during a launch rollback window | One table and one transactional write leave no window in which a marked number can still be dialled. A database error halts the dial, and a halt aborts the whole claimed batch; both are tested |
| B9 | Two layers in the agency domain: the dialer domain (pure rules in `packages/domain`, the agency repository, DNC) and, on top of it, campaign management (ingest, staffing, activity, agent identity, the spine, campaign config and wire shapes, stats enrichment), which calls the repository in-process | Campaign management depends on the repository, never the reverse |
| B10 | Infrastructure used by more than one module area lives in one shared place: shared repositories in `packages/db`, the feature-flag service in `apps/server/src/feature-flags/`, both audit modules in `apps/server/src/audit/` (see `docs/seams.md`) | One owner per shared piece; no module area keeps a private copy |
| B11 | Cross-module seams are fixed files in `apps/server/src/seams/`, plus the bridge API the dialer runtime calls (`docs/seams.md`) | Module areas talk through fixed contracts that are pinned by tests |
| B12 | The agency repository (`agency.repository.ts`, its model and the DNC outbox repository) lives in `apps/server/src/db/`, not `packages/db`; `packages/domain` holds only leaf modules | The repository imports about fifteen `apps/server/src/agency/` modules, several of which import the agency model; putting it in `packages/db` would make db, domain and server cyclic |
| B13 | The guard host reports the bridge's live WebRTC calls as `getActiveCallCount`, so the self-heal poll stays armed while a bridged call holds slots | The bridged call is the only call type; reporting 0 would leave the poll dormant through every call. Lead decision |
| B14 | One S3 module, `apps/server/src/storage/s3.ts`, reading `config.s3`, including `getFileStream` and `headFile` for ingest | One bucket, one client, one config key |
| B15 | Roster replace and clear refuse: `supersedeRoster` throws `unsupported` and writes nothing, so a `mode: 'replace'` ingest fails `replace_unsupported` and `POST /campaigns/:id/roster/clear` refuses. Both are behind `AGENCY_ROSTER_REPLACE_ENABLED`, off by default | The schema has no supersede primitive (no `superseded_at`, no retired contact state, no contact `ingest_job_id`). Building one is three schema changes plus a replace lock: new work, pending Manas. The console does not send either request |
| B16 | The public API layer serves the paths the console calls (`/proxy/agency/...`, `/dnc`, `/phone-numbers`, `/proxy/call-analysis-profiles`, `/super-admin/...`). Its handlers authenticate, check tenancy and RBAC, validate and enrich, then run the dialer's handlers on the internal handler instance in-process through `callCore` | One process, no network hop and no service credentials between the layers. The `/proxy` prefix is cosmetic and can be renamed in one coordinated server and console change. The internal handlers are modules, not URL surfaces |
| B17 | Branding (Manas, 2026-10-09). Magick Agency is a standalone product: nothing in the console, the super-admin console or anything the server sends links to or names another product. Console default brand pack `magick-agency` ("Magick Agency" / "MA"; the mark is a text tile, no logo file or tagline); no external docs link; originators `magick-agency-console` / `magick-agency-super-admin`; localStorage keys `magick-agency-*`; server `PLATFORM_BRAND_NAME` default "Magick Agency" (product noun "Magick Agency Dialer"); masked errors say "contact support" with no address; CSV preambles say "Magick Agency". The console's `/app` is its own platform zone (Team, Notifications, Call summaries); the exits to it read "Team & settings" (agency shell) and "Go to settings" (`AgentHomePage`, `WorkspaceExit`). A guard test in each app fails on any non-comment mention of a parent product's name. Internal `x-mgkvc-*` header names are wire names and unchanged (follow-up) | Manas's ruling: "this shouldn't have any linking present" |

## 4. Rulings on open questions (Manas, 2026-10-09)

Each ruling carries a `Q<n> (Manas, 2026-10-09)` code comment and a mutation-checked test. Q3 was
not ruled on; it is in §5.

| # | Question | Ruling | Status |
|---|---|---|---|
| Q1 | Verify the production Postgres TLS certificate? | Yes. When TLS is on (production) the certificate is verified (`rejectUnauthorized: true`). `DB_SSL_CA` takes the PEM **text** of a private CA (literal `\n` allowed; a path or other non-PEM value is a boot error); `DB_SSL_REJECT_UNAUTHORIZED=false` is the only opt-out (strict `true`/`false`). TLS parameters in `DATABASE_URL` (`ssl`, `sslmode`, `sslrootcert`, `sslcert`, `sslkey`, `sslnegotiation`, any case) are refused at config parse, because pg lets them replace these settings | **Decided — changed** |
| Q2 | How many action error codes? | 18. The union in `packages/contracts/src/errors.ts` has 18 members; an older count of 16 was stale | **Decided — keep** |
| Q4 | Platform audit `actor_type` has no `api_key` | When audit rows are imported from the previous platform at launch, rows with `actor_type = 'api_key'` become `system`, keeping the key name in `details`. Record only; nothing built now | **Decided — keep (launch)** |
| Q5 | Cache invalidation when Redis is down | Revocations retry the Redis DEL (3 attempts) and log at ERROR on final failure. A revocation route that is idempotent on retry answers 503 `cache_invalidation_failed` (the role-change routes, tenant and super-admin); one that is not keeps its 2xx and relies on the error log (both membership-removal routes: a retry 404s before the delete). Non-revocation invalidations keep swallowing. TTLs: membership 30 min, user 20 min, tenant/account records 5 min, local layer 5 s (off by default). No metric fits; none added. There is no tenant/account soft-delete route | **Decided — changed** |
| Q6 | Should bridge-leg and webhook tokens fail open? | Middle option: a missing token when Redis ANSWERED is refused; Redis absent or erroring still accepts (never hard-fail a live call); a wrong token is refused. Kept working explicitly: VoiceLink's late terminal posts (the recording URL) after teardown — the webhook token lives 2 h past the call end instead of being deleted; and a token whose `SET` failed at mint — remembered in-process and still accepted. No other leg relies on the fallback (provider and webhook tokens are stored before the dial; nothing verifies a browser token). The "SET failed at mint" memo is **process-local**, so it is sound only on a single replica: with more than one replica, a token minted (and failed) on one replica and verified on another is refused, so scaling out needs the memo shared or the excuse dropped. **Deployment invariant:** Redis must keep these keys for their TTL (persistence on; `noeviction`, or `volatile-*` with nothing else competing); a key evicted or lost to a non-persistent restart is a refusal that cuts the live call's carrier leg and status webhooks, and each such refusal logs a warning (`WebRTC WS token missing while Redis answered`) | **Decided — changed** |
| Q7 | `trustProxy` for IP-keyed rate limits | See Q9 | **Decided — changed** |
| Q8 | Can an agent act on another agent's session? | No; sealed. The public API layer sends the authenticated actor on every session route; `requireOwnedSession` requires `session.agent_user_id === request.user.id`, else the same 404 as a missing session (no existence leak, checked before the `left_at` 409). A supervisor (`agency.supervise` → `on_behalf`) may act on another agent's session ONLY on `force-available`, the one supervisory session flow; station-token, available, break, break/cancel and leave are the agent's own presence. `requireOwnedAttempt` needed nothing: every attempt route already runs `checkActor`. A station token for session X can only be minted by X's agent, so only X's agent can open X's station socket (the upgrade itself is token-only) | **Decided — changed** |
| Q9 | Client IP behind a load balancer | `TRUST_PROXY_HOPS` (`server.trustProxyHops`, `.int().min(1).default(1)`), never `true`. Passed to Fastify as a hop-count trust function (proxy-addr's `i < hops`), because Fastify 5.12 fails a bare numeric `trustProxy` closed. The same trust makes `request.host` / `request.protocol` proxy-asserted (`x-forwarded-host` / `x-forwarded-proto`); nothing reads them today. **Deployment invariant:** the server must be reachable ONLY through exactly `TRUST_PROXY_HOPS` proxies; bind it to loopback or a private interface, or firewall the port. If it is reachable directly, a client's own `X-Forwarded-For` entry becomes `request.ip` and the IP rate limits can be evaded; if the real chain has a different number of proxies, set the count to match | **Decided — changed** |

Other rulings of 2026-10-09 (not numbered questions):

| Topic | Ruling | Status |
|---|---|---|
| `VOICELINK_RECORDING_HOSTS` | Unset → `recording.app.voicelink.co.in`; set → exactly that list (set empty = every recording fetch and playback refused) | **Decided — changed** |
| Analysis retention | `AGENCY_TRANSCRIPT_RETENTION_DAYS` defaults to 30 days (falls back to `DIALER_TRANSCRIPT_RETENTION_DAYS`), so the purge runs out of the box; `AGENCY_RETENTION_DAYS` (row deletion) stays unset by default; the `RETENTION_MIN_DAYS` floor (30) holds | **Decided — changed** |
| Super-admin audit writes | Stay fire-and-forget, but a failed write is logged at ERROR with action, actor and target instead of being dropped silently | **Decided — changed** |
| B7, B12, B13, B15 | As recorded above | **Decided — keep** |
| B6 | Handled with the OpenTelemetry SDK. Service names `magick-agency` (production), `magick-agency-Staging`, `magick-agency-Dedicated`; agency's alerts page the same PagerDuty service as the rest of the Grafana stack. Everything agency-related (rules, dashboard, agency copies of the liveness, runtime and cardinality rules) lives in this repo's `grafana/`, with its own state | **Decided — changed** |
| Unnamed exporter | With `OTEL_ENABLED=true` but no `OTEL_SERVICE_NAME`, the SDK does not start and the server warns: the fallback name `magick-agency` is the production name alerts page on | **Decided** |
| OTel export path | OTLP push only (http/protobuf, e.g. Grafana Cloud's OTLP gateway); there is no Prometheus scrape endpoint. See `src/instrumentation.ts` | **Decided** |
| pg span parameters | `enhancedDatabaseReporting: true` stays on: pg spans carry query parameter values | **Decided — keep** |
| Credentials on spans | Redacted on spans as in logs: `?token=`, `sig=`, `*verify_token=`, signed-URL keys and media-stream path tokens, on server spans and (query values) on outgoing `http` and `fetch` spans | **Decided** |
| Log export | Logs reach OTLP only through the SDK's `instrumentation-pino` bridge (no `pino-opentelemetry-transport`), so no line ships twice | **Decided** |
| Audit partitions | Dropped after 85 days (`AUDIT_RETENTION_DAYS` default, `auditPartitions.retentionDays`) | **Decided — keep** |
| `findActiveSuccessor` | Tenant- and account-scoped (`packages/db/src/repositories/call-analysis-profile.repository.ts`: `dead.tenant_id = $2 AND dead.account_id = $3`, with the caller's scope from the route), so a profile lookup cannot cross tenants | **Decided — keep (verified)** |

## 5. Still open

| # | Question | Context | Owner |
|---|---|---|---|
| Q3 | Contract choices made during the build | (a) the session settings map is keyed by `account_id` across every account the caller's memberships reach; (b) there is no separate per-account dialer-analysis toggle: analysis is governed by `analyze_calls` alone; (c) usage counts carry seconds, windowed on `dialed_at`; (d) super-admin shapes for change role, revoke and add-to-account exist; (e) `tenant.update` / `account.update` are added only if a console page needs them | Manas (ratify) |
| — | `supervisor_hold` | Declared in the wrap-up hold union, never produced by the server. Keep, remove or build a producer | Manas |
| — | Shutdown grace | The completion-notice drain is 30 s and Docker's default stop grace is 10 s. Implemented, pending ratification: `stop_grace_period: 45s` in `docker/docker-compose.prod.yml`. Also: should `stop()` await an in-flight pacing tick? A tick parked past the `stopped` check can finish after the drain | Manas |
| 1, 3–6 | Launch defaults | Built, pending ratification (§2) | Manas |
| 2, 7, 8 | Launch open items | Existing numbers, launch style, domain / freeze / rollback window | Manas, at launch |
| 9 | Metering | Out of v1; design not started | Manas |
| B15 | Roster supersede | Three schema changes plus a replace lock; `AGENCY_ROSTER_REPLACE_ENABLED` stays off until then | Manas |
| B17 | Internal header names | `x-mgkvc-*` names are on the in-process wire only; renaming them is a follow-up | lead |
| — | Gated items | Vendor setup; Playwright happy path (real Firebase sign-in); parity check against production data; dark pilot; a real VoiceLink call and a real recording analysed; launch | Manas |

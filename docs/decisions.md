# Decisions

Every decision that shapes Magick Agency, with its ID, in one place. Read it when you need to
know whether something is settled, why the code departs from the verbatim port, or what is still
waiting on someone. Source comments cite entries here by ID (`B8`, `Q6 (Manas, 2026-10-09)`), so
IDs are never renumbered or reused. As of 2026-10-09.

Status words: **settled** (from the approved plan, not reopened here); **default, pending Manas**
(built with the plan's recommended option, not yet ratified); **open** (no default; a cutover
concern); **decided — keep** (Manas ruled the build's behaviour stays); **decided — changed** (Manas
ruled a change, and it is implemented).

Commit SHAs cited in this file and in `PORTING.md` refer to the local build history
(`main-full-history`), not to GitHub; see [`history/README.md`](history/README.md).

## 1. Settled (plan v4.2, approved by Manas 2026-10-08)

| # | Decision |
|---|---|
| S1 | Self-sufficient app, no runtime dependency on core or master |
| S2 | Owns the voice engine (bridge + VoiceLink) and its own VoiceLink capacity |
| S3 | Owns analysis and transcripts, and identity data |
| S4 | Same Firebase project; agency has its own service account |
| S5 | Super-admins create tenants and add users (master's super-admin approach) |
| S6 | No credits, billing or credit enforcement in v1; metering is an open item |
| S7 | AI calling out of scope |
| S8 | Stack: Node 22 + Fastify + TS + raw pg + node-pg-migrate + Vitest; Vite + React UIs; pnpm workspaces |

The plan's own wording of these, and the history of how it got there (v1–v4.2), is in
[`intent-and-plan.md`](intent-and-plan.md) and the frozen plan,
[`history/extraction-plan-v4.2.md`](history/extraction-plan-v4.2.md).

## 2. Plan §7 decisions

The plan listed nine decisions it still needed. The build used the recommended option where
there was one and recorded it as **default, pending Manas**.

| # | Question | Default used by the build | Status |
|---|---|---|---|
| 1 | Outstanding invites at cutover | Re-issue them (only token hashes are stored, so they cannot move) | default, pending Manas |
| 2 | Existing agency numbers | — (cutover concern) | open |
| 3 | Inbound calls to agency numbers in v1 | Play a message and hang up | default, pending Manas |
| 4 | Abandon clip | Uploaded file only, no TTS | default, pending Manas |
| 5 | Platform API keys | None in v1 | default, pending Manas |
| 6 | Super-admins | Created fresh (master's rows not copied) | default, pending Manas |
| 7 | Cutover style | — (cutover concern) | open |
| 8 | Domain, freeze vs port tax, rollback window | — (cutover concern; 7 days proposed) | open |
| 9 | Metering | Not in v1 | open item |

## 3. Build decisions (lead, during the build)

In one line each:

- **B1** one `tsconfig` per package, tests included, so lint catches a broken test.
- **B2** workspace packages consumed as TypeScript source; no inter-package build step.
- **B3** one Postgres (5436, two DBs) and one Redis (6383, db 0 dev / db 1 test) for dev and test.
- **B4** one lane-owned file per lane for config, routes and background work.
- **B5** server keeps CommonJS runtime semantics (esbuild `format: cjs`).
- **B6** Grafana `local.agency` selector deferred; it lives in the superproject. Still not done.
- **B7** both audit tables kept (`audit_logs` and `platform_audit_log`), one process writes both.
- **B8** DNC collapse: one table, indexed fail-closed dial-time read, one transactional mark.
- **B9** lane B split into B1 (core) then B2 (master).
- **B10** shared infrastructure is lead-owned and landed before the lanes.
- **B11** cross-lane seams are fixed files in `apps/server/src/seams/`.
- **B12** core's agency repository stays at core's path in `apps/server`, to avoid a package cycle.
- **B13** the guard host counts live bridged calls, so self-heal stays armed during calls.
- **B14** one S3 module; master's two extra functions appended to core's file.
- **B15** roster replace/clear keeps refusing (core never had the supersede endpoint).
- **B16** the API serves the console's existing paths; master→core hops run in-process.
- **B17** no MagickVoice links or branding; the product is "Magick Agency".

The full entries:

| # | Decision | Why |
|---|---|---|
| B1 | One `tsconfig` per package covering `src` and `test`, `moduleResolution: Bundler`, `noEmit` | Rule 5: lint must catch a broken test. Nothing is emitted by tsc: the server is bundled by esbuild, the UIs by Vite. |
| B2 | Workspace packages are consumed as TypeScript source (package `exports` point at `src/*.ts`) | No build step between packages; esbuild and Vite compile them in place. |
| B3 | Dev and test share one Postgres container (5436) with two databases, and one Redis (6383) with db 0 dev / db 1 test | The handoff allocates exactly two ports. Test harnesses refuse any other port or database. |
| B4 | Config, routes and background work each have one lane-owned file per lane | Parallel lanes never edit the same file; Phase 8 merges the route surfaces. |
| B5 | Server modules keep CommonJS runtime semantics (esbuild `format: cjs`) | Ported core code uses `__dirname` and CJS-shaped imports. |
| B6 | Grafana `local.agency` selector deferred from Phase 1 to after lanes C/D/Phase 6 | The validators read agency's metric declarations, which do not exist until the lanes port them, and the change lives in the superproject (needs its own branch). |
| B7 | Keep BOTH audit tables: core's `audit_logs` (the "Dialer" half) and master's `platform_audit_log` (the "Console" half) | The campaign activity trail merges the two and shows core's retention horizon; keeping both lets it port verbatim, with a direct query replacing the S2S read. Plan §3.5's "one writer" still holds: one process writes both. Deviation from plan §8 Phase 2's "audit (partitioned)" list, flagged for Manas. |
| B8 | DNC collapse: the dial-time check reads `dnc_entries` (indexed `idx_dnc_entries_tenant_phone`) and fails closed on a DB error; the agent's mark writes `dnc_entries` in the same transaction as its attempt bookkeeping. Core's Redis DNC set, master→core sync, resync and versions are not ported. `agency_dnc_outbox` stays in the schema for the Phase 10 rollback-window mirror to master, which is built later. | Plan §1: "one DNC table, one transactional write". Fail-closed and "a halt aborts the whole claimed batch" are kept and tested. |
| B9 | Lane B runs as two sub-lanes on two branches: B1 (core: pure modules, `agency.repository.ts`, DNC collapse), then B2 (master: ingest, staffing service, activity, agent identity, spine, campaign config/wire, stats enrichment), which starts after B1 merges | B2 calls B1's repository in-process (master's roster S2S client becomes a direct call), so it cannot compile before B1 lands. |
| B10 | Shared infrastructure (Phase 2b) is lead-owned and lands before lanes: shared repositories, feature-flag service, both audit modules (see `docs/seams.md` §4) | Each is read or written by more than one lane. |
| B11 | Cross-lane seams are fixed files in `apps/server/src/seams/` plus the bridge API in `docs/seams.md` §3.1 | Rule 6: lanes build against fixed contracts. |
| B12 | Core's `agency.repository.ts` (+ model, + DNC outbox repo) stays at core's path `apps/server/src/db/...`, not `packages/db`; `packages/domain` holds only leaf agency modules | The repository imports ~15 `src/agency/` modules, several of which import the agency model; putting it in `packages/db` would make db↔domain↔server cyclic. Keeping core's tree shape also keeps `git format-patch` ports clean. Deviation from plan §6's layout. |
| B13 | Lane C's guard host counts the bridge's live WebRTC calls as `getActiveCallCount`, so the self-heal poll stays armed while a bridged call holds slots | Core's count meant "live calls holding slots" over core's call types (AI sessions + static/IVR gauge ids, core `metrics.ts:1777`); agency's only call type is the bridged call. Core already runs reconcile with live WebRTC calls whenever AI calls coexist. The alternative (return 0) would leave the poll dormant through every agency call. Lead decision, session 2. |
| B14 | One S3 module: lane C's port of core's `src/storage/s3.ts` at `apps/server/src/storage/s3.ts`, reading `config.s3`. Master's `src/storage/s3.ts` collides on the path; lane B2 appends master's `getFileStream` and `headFile` (the two functions ingest uses that core's lacks) verbatim to that file | Same pattern as `utils/concurrency.ts` (both repos' helpers concatenated in one file). One bucket, one client, one config key. |
| B15 | Roster replace/clear keeps refusing: lane B2's in-process `supersedeRoster` throws `unsupported` after one attempt and writes nothing, so a `mode: 'replace'` ingest fails `replace_unsupported` and `POST /campaigns/:id/roster/clear` refuses | Core @ `4850d1d9` has no `/internal/agency-campaigns/:id/roster/supersede` (`agency.routes.ts:1827` calls it "future"; migration 083: no `superseded_at`, retired state or contact `ingest_job_id`; the baseline has none either). In production master always got a 404 and failed the job with nothing touched; cusui v2.96.0 never sends either request. Porting the observed behaviour; building the endpoint (three schema changes plus a replace lock) is new work, pending Manas. |
| B16 | The merged API serves the console's existing paths (cusui @ `ee5beb44` → master: `/proxy/agency/...`, `/dnc/...`, `/super-admin/...`); each master handler's hop to core collapses into core's handler body in-process | The console ports with only its API base changed; the `/proxy` prefix is cosmetic and can be renamed after cutover in one coordinated change. Core's route files become handler modules, not URL surfaces. |
| B17 | Branding: no MagickVoice links (Manas, 2026-10-09). Magick Agency is a standalone product: no link to, and no user-visible mention of, MagickVoice in the console, super-admin or anything the server sends. Console default brand pack `magick-agency` ("Magick Agency" / "MA"; MagickVoice logo, favicon, tagline and `promotions` dropped; the mark is a text tile); the `docs.magickvoice.com` page-guide link is deleted; originators `magick-agency-console` / `magick-agency-super-admin`; localStorage keys `magick-agency-*`; server `PLATFORM_BRAND_NAME` default "Magick Agency" (product noun "Magick Agency Dialer"), masked errors say "contact support" with no address, CSV preambles say "Magick Agency". The console's `/app` is its own platform zone (Team, Notifications, Call summaries), not MagickVoice, so it stays and the "Back to MagickVoice" exits are relabelled "Team & settings" (agency shell) and "Go to settings" (`AgentHomePage`, `WorkspaceExit`). A source guard per package fails on any non-comment MagickVoice mention. Internal `x-mgkvc-*` header names are wire and unchanged (follow-up) | Manas's ruling: "this shouldn't have any linking present". Details and tests: `PORTING.md` §8.9, super-admin §9.5, console §9.6 |

## 4. Open-question rulings (Manas, 2026-10-09)

Implemented on branch `fix/open-questions` (see `PORTING.md` "Open-question fixes", OQ-1..OQ-8).
Each departure from the verbatim port carries a `Q<n> (Manas, 2026-10-09)` code comment and a
mutation-checked test. Q3 was not ruled on; it is in §5.

| # | Question | Ruling | Status |
|---|---|---|---|
| Q1 | Verify the production Postgres TLS certificate? | Yes. When TLS is on (production) the certificate is verified (`rejectUnauthorized: true`). `DB_SSL_CA` takes the PEM **text** of a private CA (literal `\n` allowed; a path or other non-PEM value is a boot error); `DB_SSL_REJECT_UNAUTHORIZED=false` is the only opt-out (strict `true`/`false`). TLS parameters in `DATABASE_URL` (`ssl`, `sslmode`, `sslrootcert`, `sslcert`, `sslkey`, `sslnegotiation`, any case) are refused at config parse, because pg lets them replace these settings. (OQ-4) | **Decided — changed** |
| Q2 | Action error codes: 18, not 16 | 18 is correct; [`agency.md`](reference/magickvoice-platform/agency.md) §6.2 is stale. | **Decided — keep** |
| Q4 | Platform audit `actor_type` no longer has `api_key` | Phase 10 cutover maps copied master rows with `actor_type = 'api_key'` to `system`, keeping the key name in `details`. Record only; nothing built now. | **Decided — keep (Phase 10)** |
| Q5 | Cache invalidation when Redis is down | Revocations retry the Redis DEL (3 attempts) and log at ERROR on final failure. A revocation route that is idempotent on retry answers 503 `cache_invalidation_failed` (the role-change routes, tenant and super-admin); one that is not keeps its 2xx and relies on the error log (both membership-removal routes: a retry 404s before the delete). Non-revocation invalidations keep swallowing. TTLs: membership 30 min, user 20 min, tenant/account records 5 min, local layer 5 s (off by default). No metric fits; none added. Agency has no tenant/account soft-delete route. (OQ-6) | **Decided — changed** |
| Q6 | Bridge leg and webhook tokens fail open | Middle option: a missing token when Redis ANSWERED is refused; Redis absent/erroring still accepts (never hard-fail a live call); a wrong token is refused. Kept working explicitly: VoiceLink's late terminal posts (recording URL) after teardown — the webhook token now lives 2h past the call end instead of being deleted; a token whose SET failed at mint — remembered in-process and still accepted. No other leg used the fallback (provider/webhook tokens are stored before the dial; nothing verifies a browser token any more). The "SET failed at mint" memo is **process-local** — sound only on a single replica (D2): with more than one replica, a token minted (and failed) on one replica and verified on another loses that excuse and is refused, so scaling out needs the memo shared or the excuse dropped. **Deployment invariant:** Redis must keep these keys for their TTL (persistence on; `noeviction`, or `volatile-*` with nothing else competing): a key evicted or lost to a non-persistent restart is now a refusal that cuts the live call's carrier leg and status webhooks; each such refusal logs a warning (`WebRTC WS token missing while Redis answered`). (OQ-5) | **Decided — changed** |
| Q7 | `trustProxy` for IP-keyed rate limits | See Q9. | **Decided — changed** |
| Q8 | Agents can act on another agent's session (source gap) | Sealed. Master sends the authenticated actor on every session route; `requireOwnedSession` requires `session.agent_user_id === request.user.id`, else the same 404 as a missing session (no existence leak, checked before the `left_at` 409). A supervisor (`agency.supervise` → `on_behalf`) may act on another agent's session ONLY on `force-available` — the one supervisory session flow in core/master/cusui; station-token, available, break, break/cancel and leave are the agent's own presence. `requireOwnedAttempt` needed nothing: every attempt route already runs `checkActor`. A station token for session X can only be minted by X's agent, so only X's agent can open X's station socket (the upgrade itself is token-only, as in core). (OQ-1) | **Decided — changed** |
| Q9 | Client IP behind a load balancer | Master's `TRUST_PROXY_HOPS` (`server.trustProxyHops`, `.int().min(1).default(1)`), never `true`. Passed to Fastify as a hop-count trust function, because Fastify 5.12 (agency's) fails a bare numeric `trustProxy` closed; the semantics are master's (proxy-addr's `i < hops`). The same trust makes `request.host` / `request.protocol` proxy-asserted (`x-forwarded-host` / `x-forwarded-proto`); nothing in agency reads them today. **Deployment invariant:** the server must be reachable ONLY through exactly `TRUST_PROXY_HOPS` proxies — bind it to loopback / a private interface or firewall the port. If it is reachable directly, a client's own `X-Forwarded-For` entry becomes `request.ip` and the IP rate limits can be evaded; if the real chain has a different number of proxies, set the count to match. (OQ-2) | **Decided — changed** |

Other rulings of 2026-10-09 (not numbered questions):

| Topic | Ruling | Status |
|---|---|---|
| `VOICELINK_RECORDING_HOSTS` | Unset → `recording.app.voicelink.co.in`; set → exactly that list (set empty = every recording fetch/playback refused). (OQ-3) | **Decided — changed** |
| Analysis retention | `AGENCY_TRANSCRIPT_RETENTION_DAYS` defaults to core's effective 30 days (falls back to `DIALER_TRANSCRIPT_RETENTION_DAYS`), so the purge runs out of the box; `AGENCY_RETENTION_DAYS` (row deletion) stays unset — core had no config default (its row window came from the retention Lambda, `RETENTION_DAYS=85`); the `RETENTION_MIN_DAYS` floor still holds. (OQ-7) | **Decided — changed** |
| Super-admin audit writes | Stay fire-and-forget (master), but a failed write is logged at ERROR with action, actor and target instead of being dropped silently. (OQ-8) | **Decided — changed** |
| B6, B7, B12, B13, B15 | As recorded above. | **Decided — keep** |
| Audit partitions | Dropped after 85 days (`AUDIT_RETENTION_DAYS` default, `auditPartitions.retentionDays`). | **Decided — keep** |
| `findActiveSuccessor` | Verified already tenant/account-scoped in agency (`packages/db/src/repositories/call-analysis-profile.repository.ts`: `dead.tenant_id = $2 AND dead.account_id = $3`, caller's scope from the route), a recorded security deviation from core. | **Decided — keep (verified)** |

## 5. Still open

| # | Question | Context | Owner |
|---|---|---|---|
| Q3 | Contracts follow-ups decided by the lead | (a) the session settings map is keyed by `account_id` across every account the caller's memberships reach; (b) the softphone-only `analyze_dialer_calls` toggle is not part of agency's settings (its only reader was the bridge's gate 3, deleted per [`seams.md`](seams.md) §3.2); (c) usage counts carry seconds and window on `dialed_at`; (d) new super-admin shapes (change role, revoke, add to account) are produced by lane A; (e) `tenant.update` / `account.update` are added only if lane A finds a console page that needs them (contract change through the lead). | Manas (ratify), lead (the reasoning) |
| — | `supervisor_hold` | Declared in the contract, never produced (core is the same). Keep, remove, or build a producer | Manas |
| — | Shutdown grace | The completion-notice drain is 30 s and Docker's default stop grace is 10 s. Implemented, pending ratification: `stop_grace_period: 45s` in `docker/docker-compose.prod.yml`. Also: should `stop()` await an in-flight pacing tick (a tick parked past the `stopped` guard can finish after the drain; core has the same shape)? | Manas |
| 1, 3–6 | Plan §7 defaults | Built, pending ratification (§2) | Manas |
| 2, 7, 8 | Plan §7 open items | Existing numbers, cutover style, domain / freeze / rollback window | Manas, at cutover |
| 9 | Metering | Out of v1; design not started | Manas |
| B6 | Grafana selector | Superproject change, needs its own branch | whoever does cutover |
| B15 | Roster supersede | Building it means three schema changes plus a replace lock; `AGENCY_ROSTER_REPLACE_ENABLED` stays off until then | Manas |
| B17 | Internal header names | `x-mgkvc-*` names are on the in-process wire only; renaming is a follow-up | lead |
| — | Core fixes found during the port | Core's unscoped `findActiveSuccessor`; the core half of the byte-identical carrier fixture. Both are later core PRs | MagickVoice core |
| — | Gated items | Phase 0 vendor setup; Playwright happy path (real Firebase); production parity diff; dark pilot; real VoiceLink call and real recording analysed; Phase 10 cutover | Manas |

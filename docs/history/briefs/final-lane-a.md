# Lane A — platform (plan Phase 3)

You are lane A of the Magick Agency build: the platform layer the agency app now owns itself — identity, tenancy, invites, RBAC enforcement, per-account settings and flag overrides, super-admin auth and API, notifications, usage counts. Security-sensitive: be exact.

**Worktree:** `/Users/manasnilorout/Personal/Sapionic/magick-agency-lane-a`, branch `lane-a/platform` (already created off `main` by the lead).

## Plan sections you implement
`docs/history/extraction-plan-v4.2.md` §3.1, §3.2, §3.3 (usage counts only), §3.4, §3.5 (notifications only — audit is shared infrastructure, already ported), §7 defaults #1, #5, #6 (`docs/decisions.md`), and the §9 invariants: *`agent` at level 5 reaches only the agent surfaces plus session, `/accounts/mine` and preferences*; *recording and analysis are gated per field on campaign writes*; *no lookup by address binds an unverified email; session path 4 never creates a tenant; an invite token is single use and expires*.

## Sources (master v3.24.0 @ a1f0756a unless stated) — inventory these first
- Identity/session: `src/auth/{firebase,firebase-identity,session-email,session-payload,session.middleware}.ts`, `src/api/routes/auth.routes.ts` (paths 1–3; path 4 REFUSES with 403 `no_membership` instead of creating a tenant and pooled number), `src/api/middleware/tenant-context.middleware.ts`, `src/cache/` (the membership cache the routes invalidate), repositories `user`, `tenant`, `account`, `membership`, `membership-invite` (+ models), migration-073 helpers (`findByProvenEmail`, `clearEmailUnverifiedIfProven`).
- Accounts/team: `src/api/routes/{account,tenant,user}.routes.ts` — only what the console needs: `GET /accounts/mine`, the team list, role change, membership removal (with the staffing close via the shared `agencyCampaignAgentRepository.closeAllForUser`, exactly as `user.routes.ts:89-140,772-800,860-890`), and whatever tenant/account reads the console's settings and team pages call. Find exactly what cusui's agency tree, team, invites and settings pages call (`magick-comms-cusui/src/api/*`, `src/config.ts` ENDPOINTS) and port only that.
- Invites: `src/invites/`, `src/api/routes/invites.routes.ts`, `src/notifications/{invite-mailer,invite-token}.ts` + templates (the agent invite email).
- RBAC: enforce with `@magick-agency/contracts/rbac` (the ONE matrix — do not copy master's `roles.ts`), porting master's `requirePermission` middleware and its tests (`test/unit/rbac/*`, including `roles.agent.test.ts`).
- Super-admin: `src/auth/super-admin.middleware.ts`, `src/api/routes/super-admin.routes.ts` and `super-admin-{feature-flags,phone,usage}.routes.ts` — ONLY the subset in plan §3.4 and `@magick-agency/contracts/api/platform/super-admin`. Repositories `super-admin`, `super-admin-audit`, `phone-number`, `tenant-phone-assignment`, `telephony-provider`. Tenant create writes a `pending_` owner stub and NO pooled number. "Add user" creates a `pending_` stub + membership + invite. Concurrency limits go through the shared `providerConcurrencyRepository` / `accountSettingsRepository` and the seam `apps/server/src/seams/concurrency-control.ts` in core's order (`docs/seams.md` §3.3). Flag overrides go through the shared `apps/server/src/feature-flags/` service. Per-account settings per `contracts/api/platform/settings.ts`. Plus a CLI (`apps/server/scripts/create-super-admin.ts`) to create the first super-admin — no seeded credentials.
- Usage counts (NEW, read-only, charges nothing): per tenant and account over a `dialed_at` window — dials, answered, connected (bridged), talk seconds, analysis audio seconds — from `agency_call_attempts`, `agency_calls`, `dialer_analysis_jobs`; shape in `contracts/api/platform/super-admin-usage.ts`. Uses the `(dialed_at, campaign_id)` index; test the query on real Postgres.
- Notifications: `src/notifications/mailjet.client.ts`, `src/notifications/engine/`, `agency-campaign-completion.ts`, preference + delivery repositories, `src/api/routes/notification.routes.ts` — agency-relevant events only (agent invite, campaign completion to holders of `agency.supervise`). Usage digests are credits-based: not ported.
- Per-field recording/analysis assert (MAG-138): port master's per-field `assertCapability` logic for `agency.recording` / `agency.analytics` (`proxy-agency-campaigns.routes.ts:78-144`) as a function over the per-account settings row (`allow_recording`, `analyze_calls`) that the Phase 8 campaign routes will call; test it per field, including the on→off write being allowed when the account has lost the permission (see the cusui CLAUDE.md, `docs/reference/magick-comms-cusui/CLAUDE.md`, note on `agencyCampaignRecording.ts`).
- Audit partition maintenance: a runtime job in `apps/server/src/bootstrap/platform.ts` that creates next months' partitions for `platform_audit_log` and `audit_logs` and drops ones past retention (port core's `audit-retention.ts` behaviour, already in `apps/server/src/audit/`, and master's equivalent if any).

## Contracts you build against (do not edit)
`@magick-agency/contracts/rbac`, `api/platform/*`, `flags`; the baseline schema; shared infrastructure in `docs/seams.md` §4; seam `concurrency-control.ts`. Firebase: same project as MagickVoice, agency's own service account — config in your block (`FIREBASE_PROJECT_ID`, service account JSON or path), plus super-admin JWT secret, Mailjet keys and sender, the console base URL for invite links. In tests mock `firebase-admin`'s `verifyIdToken` exactly as master's tests do; never call Firebase.

## Exit gate (plan §8 Phase 3) — each item needs a named test
- session paths 1–3 and the path-4 refusal;
- the `email_unverified` repair;
- invite issue, claim (including an unverified claim), expiry and revoke;
- a super-admin creates a tenant and adds a user, who then signs in (an integration test across the real routes and real Postgres, with Firebase mocked);
- `agent` (level 5) reaches only the agent surfaces plus `/auth/session`, `/accounts/mine` and notification preferences — assert with a route table enumerated via `onRoute` (handoff rule 10) for every route your lane registers;
- the per-field recording/analysis assert.
Plus: ported test counts equal the source suites for every module you port, minus listed deletions.

## Notes from Phase 2b (shared infrastructure)
- `accountSettingsRepository` has a getter for `webrtc_max_duration_seconds` but no writer: you are AUTHORISED by the lead to extend the shared `packages/db/src/repositories/account-settings.repository.ts` for this one column only (writer + its real-Postgres test, keeping the TtlCache write-through), and nothing else in that file; your settings route enforces core's flag bound 60..14400 (the baseline only checks `> 0`).
- Two source guards were removed until your code exists; restore them when you port the code they guard: master's "finds the audited call sites at all" check (expects ≥29 audited call sites — adjust to the routes you port and say what number and why) and the three D10 concurrency source guards (the limit is written only by the super-admin route).
- Master's audit is at `apps/server/src/audit/platform/` (`platformAuditLogger`, `PlatformCreateAuditLogInput`); the `api_key` actor is gone.
## Ground rules (every lane)

**Where you work.** Your own git worktree of `/Users/manasnilorout/Personal/Sapionic/magick-agency`, path and branch given above. Never touch the main checkout or another lane's worktree. Commit on your branch only, with scoped adds (`git add <paths>`): never `git add -A`, `git add .`, or `git stash`. Commit messages: conventional-commit subject, then a blank line, then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` as the last line. Do not push. Do not open PRs. Do not touch GitHub, any vendor console, or anyone's inbox.

**Sources are read-only.** Git submodules of `/Users/manasnilorout/Personal/Sapionic/MagickVoice-platform`: `magic-voice-core` (v1.123.2, 4850d1d9ffc9eb9eab56d2ed482b9bd616edd103), `magick-master` (v3.24.0, a1f0756a58a63bf8a19baf74298a702f9fe7b430), `magick-comms-cusui` (v2.96.0, ee5beb4400ec1fb5fdf6049871681ae6875e8d29). Check `git -C <sub> rev-parse HEAD` first. Never modify, checkout, stash or run tests in them (their tests would hit other stacks' databases).

**Read first, in this order:** `docs/seams.md` (the path rule, your lane-owned files, the seams you provide or consume — binding), `CLAUDE.md`, `docs/decisions.md`, `packages/db/BASELINE.md` (the schema you build against), the spec `docs/history/extraction-plan-v4.2.md` v4.2 (the sections named in your brief), and `docs/reference/magickvoice-platform/agency.md` §3–§7 for domain invariants.

**Port verbatim.** Same SQL, constants, Lua, comments and tests. The only allowed changes are the plan's: hop collapses (S2S/proxy → in-process), re-keying onto `agency_calls`, billing/settlement removal, VoBiz/SIP/softphone/BYOC deletion, and import paths forced by the path rule. Every changed or deleted file, function or test gets a row in your section of `PORTING.md`: `source path@sha` → destination, `verbatim | modified | deleted`, reason. Every modification gets an equivalence test; every deletion is listed.

**Contracts and schema are fixed.** Build against `@magick-agency/contracts`, `packages/db/migrations/0001_baseline.sql`, the shared infrastructure in `docs/seams.md` §4, and the seams in `apps/server/src/seams/`. Never edit those on your branch. If one of them cannot be met as written, or you need a column, method or type that is not there, **STOP that item and report it** (what, why, the exact source line that needs it). Do not adapt the contract, do not add a migration, do not work around it.

**Lane-owned files only.** Your config block, route plugin, bootstrap file and metrics file are listed in `docs/seams.md` §2. Everything else you create must be a new file on the path rule. If you need to change a lead-owned file, stop and report.

**Tests are the evidence.**
- Port the source's tests for every module you port. Your exit evidence is the count Vitest prints, compared file by file with the source suite (count the source's `it(`/`test(` cases yourself, including `it.each` expansions). Deliberately deleted tests are listed in `PORTING.md` with the reason.
- Run tests from inside the package directory (`cd apps/server && pnpm test`, `cd packages/db && pnpm test:integration`), never from the repo root. dotenv resolves from cwd.
- Never `--reporter=basic` (doesn't exist in Vitest 4; exits 0 having run nothing). A run with no printed counts is not a run.
- Repository and SQL tests run on the REAL Postgres: agency's test DB on port **5436** (`packages/db/test/helpers/test-db.ts`), Redis **6383 db 1** (`apps/server/test/helpers/test-redis.ts`). A mocked pool hides SQL drift. Never point anything at 5432/5433/5434/6379/6380/6381 — they belong to other stacks and their dev data. Integration suites share one database: run them one file at a time (the configs already set `fileParallelism: false`) and never leave a background run going.
- `pnpm lint` in each package you touch must pass; it typechecks tests too.
- Every plan §9 invariant your lane carries gets a test that fails if it breaks — port the existing one or write it.

**Known traps on this project.** Zod `.refine` runs on a dirty result after a failed `.regex`, so guard `BigInt`/`JSON.parse` inside refinements or a 400 becomes a 500. Enumerate routes from Fastify's `onRoute` hook, never by grep. A parameter used in two SQL contexts must be typed at each use (`42P08` otherwise; only real Postgres catches it). An optional create-input field plus an explicit INSERT column list typechecks and silently drops the value. Wrapping a call changes its arity: forwarding an optional arg as `undefined` breaks `toHaveBeenCalledWith`. `src/config/index.ts` exits the process on invalid config; tests get a complete env from `test/setup/unit-env.ts`.

**Report back** (under ~800 words): branch name and final commit SHA; the exact test commands you ran and their printed counts, per package, beside the source suites' counts; every PORTING.md deletion; anything you stopped on (contract gaps), with the source lines; anything you are unsure of. Do not claim green without counts.

**Your test database.** Your worktree has an untracked `.test-env.local.json` pointing integration suites at your own database (`magick_agency_test_lane_<x>`) and Redis db, so lanes never truncate each other. Do not delete or commit it. Integration globalSetup drops and re-migrates YOUR database on every run.

**Dependencies.** `pnpm install` has been run in your worktree. Add a dependency only if a ported module needs one the source used (same major version as the source's package.json), in the right package.json, and say so in your report.

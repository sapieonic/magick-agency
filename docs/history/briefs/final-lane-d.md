# Lane D — analysis and transcripts (plan Phase 7)

You are lane D of the Magick Agency build: post-call analysis of agency calls — the durable job table and worker, transcription, LLM analysis, analysis profiles, recording playback and retention.

**Worktree:** `/Users/manasnilorout/Personal/Sapionic/magick-agency-lane-d`, branch `lane-d/analysis` (already created off `main` by the lead).

## Plan sections
`docs/history/extraction-plan-v4.2.md` §4 (all), §8 Phase 7; `docs/seams.md` §3.2 (you IMPLEMENT the bridge analysis hooks — binding); `docs/decisions.md` Q3b (no softphone toggle).

## Sources (core v1.123.2 @ 4850d1d9) — same relative paths under `apps/server/src/`
- Jobs and worker: `src/core/dialer-analysis-{runner,worker,worker-handle}.ts`; repositories `dialer-analysis-job.repository.ts`, `call-analysis-profile.repository.ts` + models → `packages/db/src/{repositories,models}/` (they import nothing from `src/agency/`; if one does, put it at `apps/server/src/db/...` per decision B12 and say so). Status machine, `claim_generation` fencing, attempt ceilings and the promote → expire → claim → recover loop (60s, concurrency 2) verbatim. **The settle step and every settlement column/method are removed** (the baseline has none); `analysis_audio_seconds` is kept and recorded.
- Runner re-keyed onto `agency_calls` via the shared `agencyCallRepository` (exported also as `webrtcCallRepository`): load the call, profile snapshot, resume from an existing transcript, else fetch + transcribe in windows, persist `conversation_log`/`transcript_meta`, run the LLM analysis, complete in one transaction.
- Transcription: `src/transcription/{index,types,gemini-transcriber,sarvam-transcriber,recording-fetcher}.ts`. Gemini `gemini-3.5-flash`, diarised JSON in 600s windows, adaptive split, truncation retry below 0.8× duration — verbatim. **Rework the recording fetcher** (plan §4): drop `telephony_credential_id` credential resolution (`recording-fetcher.ts:1,68`, `utils/recording-proxy.ts`); fetch VoiceLink's public carrier-hosted MP3 only when its parsed hostname is on a configured VoiceLink recording-host allow-list (parsed-hostname matching, never `includes()` — core CLAUDE.md "Security boundaries", `docs/reference/magic-voice-core/CLAUDE.md`); a host off the list is a permanent failure with a clear error. Test both, plus a lookalike host.
- LLM analysis: `src/analysis/{analysis.service,prompt-builder,dimension-presets,profile-preflight,index}.ts` (OpenAI / Azure OpenAI / Gemini, JSON-schema output) and the minimal type modules they import (`ConversationEntry`, `CallAnalysisResult`, `AnalyticsConfig` from core's call/prompt models — port only those types), `src/utils/retry.ts`. `call-quality-scorecard.ts` is AI-call only: not ported (plan §2).
- Profiles: `src/api/routes/call-analysis-profiles.routes.ts` (CRUD, presets, dimension validator) registered in `apps/server/src/api/analysis.plugin.ts` at core's prefix. Auth on these routes is Phase 8's merge; register them behind a `preHandler` hook your plugin takes as an option, defaulting to refuse-all, so nothing ships unauthenticated — test that.
- Signed playback: `src/api/routes/webrtc-recordings.routes.ts` + `src/utils/recording-url.ts` / `recording-url-resolver.ts` (HMAC signed URL, verbatim; VoiceLink only).
- Retention: the agency slice of `src/maintenance/retention-purge.ts` (`AGENCY_RETENTION_DAYS`) plus NEW `AGENCY_TRANSCRIPT_RETENTION_DAYS`, which nulls the transcript (`conversation_log`, `transcript_meta`) early while the analysis survives to row expiry. Schedule from `apps/server/src/bootstrap/analysis.ts`.
- The seam: implement `BridgeAnalysisHooks` (`apps/server/src/seams/bridge-analysis-hooks.ts`) with the bodies of core's `maybeEnqueueAnalysis` and `notifyDialerAnalysisRecordingReady` (`webrtc-bridge-manager.ts:2190-2295`) moved verbatim, minus gate 3; register with `setBridgeAnalysisHooks` in your bootstrap. Port `test/unit/core/webrtc-bridge-manager.analysis.test.ts` against your implementation (lane C hands it to you).
- Dropped (plan §4): the `dialer.analysis.*` event-bus events and the `analysis.completed` webhook to master. Kept: PostHog and LLM observability events if core emits them on this path (port the emitter module, no-op without a key).
- Tests: `test/unit/core/dialer-analysis-*.test.ts`, `test/unit/transcription/*`, `test/unit/analysis/{analysis.service,dimension-presets,index,prompt-builder}.test.ts`, profile route and preflight tests, recording URL/route tests, the retention-purge cases for agency, repository tests (`test/unit/db/**`, `test/integration/**` for these repositories — real Postgres 5436, UUID fixtures). Never call Gemini/OpenAI/Sarvam: mock them as core's tests do.

## Contracts you build against (do not edit)
`@magick-agency/contracts/api/agency/{call-analysis-profile,webrtc-call}`, the baseline (`dialer_analysis_jobs`, `call_analysis_profiles`, `agency_calls` analysis columns), shared infra (`agencyCallRepository`, `accountSettingsRepository`, the feature-flag service with `agency_call_analysis`), the seam.

## Exit gate (plan §8 Phase 7)
- the runner's skip, resume, truncation-retry and backoff tests ported and green;
- `analysis_audio_seconds` recorded (test on real Postgres);
- the transcript is nulled at the transcript-retention day while the analysis survives (test on real Postgres);
- counts equal the source suites minus listed deletions;
- "one real recording transcribed and analysed on the pilot account" is NOT attempted (no vendor account; seams §5) — say so.

## Notes from Phase 2b
- Core's `call-analysis-profiles.routes.ts:94` reads the `dialer_call_analysis` flag, which does not exist here: agency analysis is gated by `agency_call_analysis` (`analysisFlagFor('agency')`). Record the change.
- `dialer-analysis-models` job-status test case was left for you (Phase 2b ported only its non-job cases).
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

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

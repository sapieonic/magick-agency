# Phase 6: the agency runtime

You are the Phase 6 agent of the Magick Agency build. You port core's agency runtime, the part that actually dials campaigns:
- the pacing engine, dialer and dial dispatcher;
- pre-dial gates;
- the station registry, station tokens and the station WebSocket handler;
- the agent state machine, wrap-up, breaks and the reaper;
- abandonment (clip, guardrail, metrics) and live-concurrency metrics;
- `AgencyRuntime` itself, plus the chaos suites.

Lanes A, B1, B2, C and D are all merged on `main`. You build on them.

**Read `docs/briefs/ground-rules.md` first. It is binding.**

**Worktree:** `/Users/manasnilorout/Personal/Sapionic/magick-agency-p6`, branch `phase-6/runtime` (off `main`). **Test DB:** `magick_agency_test_p6`, Redis db 7, set in `.test-env.local.json`.

## Plan sections
- `agency-extraction-plan.md`:
  - §5, the voice engine the runtime drives;
  - §6;
  - §8 Phase 6: "Pacing, dialer, station registry, reaper, wrap-up, breaks, SQL-derived gauges. **No attempt batcher.**"
  - §9.
- `agency.md` §3 (agent state machine: Redis is authoritative, the DB row is a mirror; lease TTLs and reaping), §4 (the pacing engine's leader lease and `SKIP LOCKED` claiming), §5 (the full call lifecycle, including the abandoned path), and §7.
- `docs/agency-dialer-design.md` D1–D11 in the MagickVoice-platform repo.
- `docs/seams.md` §3.1 (bridge API, which you consume), §3.2 (bridge → analysis hooks), §3.3 (`ConcurrencyControl`).
- Decisions B8 (the DNC collapse) and B13 in `docs/decisions.md`.

## Sources (core `magic-voice-core@4850d1d9`)
**Modules** (`src/agency/<f>.ts` → `apps/server/src/agency/<f>.ts`, unless a module is a leaf, which goes to `packages/domain/src` per the path rule):
- `runtime`, `pacing-engine`, `agency-dialer`, `dial-dispatcher`, `pre-dial-gates`;
- `station-registry`, `station-token`, `agent-state-machine`;
- `wrapup-manager`, `break-manager`, `reaper`;
- `abandon-clip`, `abandonment-guardrail`, `abandonment-metrics` (B1 ported part of it; finish it, don't duplicate), `live-concurrency-metrics`.

B1 already ported every module these import from (the domain modules, `agency.repository.ts`, DNC). Check `PORTING.md` Lane B1 before porting anything that looks shared.

**Not ported:**
- `attempt-batcher.ts` and `attempt-batch-reference.ts`: billing, plan §8 Phase 6. List both as deleted. Delete the runtime's calls into them, with an equivalence test that the attempt lifecycle is otherwise unchanged.
- `dnc-outbox.ts` and `dnc-resync.ts`: B8's DNC collapse. B1 listed them.
- `agency-s2s-contract.fixture.json`: retires.

**The station WebSocket.** Core's handler is `src/api/routes/agency.routes.ts:163` (`GET /station/:sessionId`, `websocket: true`), mounted at `/api/v1/agency`.
- Port the handler's body as an exported function or plugin in a runtime-owned module, e.g. `apps/server/src/agency/station-socket.ts`. Register it inside `agencyPlugin` at core's path for now (`/api/v1/agency/station/:sessionId`), behind the same token check core used (`station-token`).
- Phase 8 will mount it at the console's path and may move the registration. Keep it a single function so that is a one-line change.
- `@fastify/websocket` is registered once, in `app.ts` (the lead hoisted it). Don't register it again.

**Boot.**
- Core constructs `new AgencyRuntime(webrtcBridge, redis, keyPrefix)` (`src/index.ts:404`). The startup reaper runs BEFORE the pacing supervisor, then `agencyRuntime.start()` (`:977-981`), and `stop()` runs on shutdown (`:856`).
- Wire all of that in `apps/server/src/bootstrap/agency.ts`, the lane B file, which you own now. Take the bridge from lane C's `getVoiceEngine()` / `ensureVoiceEngine()` in `bootstrap/voice.ts`.
- Lead-owned `index.ts` runs `startAgency` BEFORE `startVoice`. If the runtime needs the voice engine to have started, stop and ask the lead to reorder. Don't edit `index.ts` yourself.
- Expose `getAgencyRuntime()` for Phase 8's routes. Also wire `startAgencyIngestReaper` (lane B2's carry-forward) and clear it on shutdown.

**Collapses.**
- Core's runtime calls master through core clients (`master-client.ts`, the platform/notification/DNC publishers). Each becomes an in-process call into lanes A, B1 and B2's modules. Examples:
  - campaign completion → lane A's `sendAgencyCampaignCompletionEmail`, which has no caller until you;
  - the caller-ID validation that core asked master for → the phone-number inventory;
  - DNC publish → B1's single DNC table.
- Find every such hop. For each, cite core's call and master's receiving handler (`internal-agency.routes.ts` and others), port the receiving body in-process, and add an equivalence test.
- **REQUIRED, from B1:** `pre-dial-gates.ts:182` must call `deps.dnc.check(campaign.tenant_id, contact.phone_e164, { accountId: campaign.account_id, campaignId: campaign.id })`. Construct `new DncRegistry()` the way B1's PORTING section says.
- `agency_dialer_enabled` and `agency_late_binding` are agency flags now (`@magick-agency/contracts/flags`, lane A's flag service). Read them where core read core's flags, with the same scopes and defaults.

## Tests
- First, write your test plan in a new `## Phase 6 — runtime` section of `PORTING.md`. Start from the 44 rows B1 classified `Phase 6` in its "Test classification" tables: unit and integration, plus `chaos/` with its 9 tests and harness. Add any core test touching your modules that B1 missed.
  - Give each row its source `it(` count (plus `it.each` rows), destination, and the ported count.
  - Real Redis and real Postgres wherever core's suite used them. Only the carrier is faked, as in lane C's `integration/core/voice-engine.test.ts` (`TelephonyProviderRegistry` stubbed).
- **Exit gate (plan §8 Phase 6):** every chaos suite green against the fake carrier, including:
  - `restart-mid-bridge`;
  - abandonment counter-vs-table;
  - predicate agreement;
  - DNC fail-closed;
  - `bridged` ordering;
  - roster exactly-once.
- Plus one new real-Postgres/Redis end-to-end test. It boots the runtime through `bootstrap/agency.ts` and drives one campaign through the station flow:
  1. session → ready;
  2. a reservation;
  3. the bridged call via the real bridge with the fake carrier;
  4. disposition;
  5. wrap-up;
  6. analysis enqueued through seam §3.2;
  7. the attempt row ends.

  This test owns the seam between C, B1, D and you.
- Counts: unit and integration per file, compared with core's.

## Out of scope
- HTTP routes other than the station socket: Phase 8 (B1's `Phase 8` rows).
- The UI.
- Real VoiceLink calls (vendor-gated).

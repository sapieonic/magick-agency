# Seams between lanes

Lead-owned. Lanes build against what this file names and never change it on their branch.
A lane that cannot meet a seam as written **stops and reports**; it does not adapt the seam.
Three individually correct lanes that did not compose cost this project a full cycle before.

Sources: core `magic-voice-core@4850d1d9` (v1.123.2), master `magick-master@a1f0756a` (v3.24.0),
cusui `magick-comms-cusui@ee5beb44` (v2.96.0).

## 1. Where ported files go (the path rule)

Same relative path as the source, so a later core fix ports with `git format-patch` / `git am --directory`.

| Source | Destination |
|---|---|
| core `src/<path>` | `apps/server/src/<path>` |
| core `src/db/repositories/*`, `src/db/models/*` that import nothing from `src/agency/` (the shared ones in §4) | `packages/db/src/repositories/*`, `packages/db/src/models/*` |
| core `agency.repository.ts`, `agency-dnc-outbox.repository.ts` and their models (they import ~15 `src/agency/` modules) | `apps/server/src/db/repositories/*`, `apps/server/src/db/models/*` — core's own path (decision B12) |
| core/master `src/utils/logger.ts`, `log-context.ts`, `crypto.ts`, `metric-instruments.ts`, `tracing.ts` (`Traced`, `withSpan`) | `@magick-agency/observability` (already ported) |
| core/master `src/utils/metrics.ts` (declarations) | `packages/observability/src/metrics/<lane>.ts` (names, kinds, units, buckets, label keys verbatim) |
| core `src/agency/contracts.ts` | `@magick-agency/contracts/agency` (Phase 2, lead) |
| core LEAF agency modules — no imports at all, or only `contracts` and other leaves (e.g. `abandonment-predicate`, `timers`, `rates`, `keyset-cursor`, `success-disposition`) | `packages/domain/src/<file>` (lane B); every other `src/agency/` module stays at `apps/server/src/agency/<file>` |
| master `src/<path>` | `apps/server/src/<path>`; master repositories/models → `packages/db/src/...` |
| core/master `test/unit/<path>` | the destination package's `test/unit/<path>` |
| core/master `test/integration/<path>` | the destination package's `test/integration/<path>` |

If a master file lands on a path a core file already occupies (or the reverse), **stop and ask the
lead**; do not invent a name. Import specifiers inside ported files change only as far as the new
paths require.

## 2. Lane-owned files in the shared server

| Kind | Lane A | Lane B | Lane C | Lane D |
|---|---|---|---|---|
| Config block | `apps/server/src/config/blocks/platform.ts` | `.../agency.ts` | `.../voice.ts` | `.../analysis.ts` |
| Routes | `apps/server/src/api/platform.plugin.ts` | `.../agency.plugin.ts` | `.../voice.plugin.ts` | `.../analysis.plugin.ts` |
| Background work | `apps/server/src/bootstrap/platform.ts` | `.../agency.ts` | `.../voice.ts` | `.../analysis.ts` |
| Metrics | `packages/observability/src/metrics/platform.ts` | `.../agency.ts` | `.../voice.ts` | `.../analysis.ts` |

Config blocks must declare **disjoint top-level keys** (enforced at load by `config/schema.ts`
and by a test). Claimed so far: lane C — `telephony`, `concurrency`, `rateLimit`, `s3`, `audio`,
`staticCallTts`, `analytics`; lane D (merged) — `postCallAnalysis`, `dialerAnalysis`, `voicelinkRecording`,
`recordingUrlSigningSecret`, `retention`. A second lane needing S3 (e.g. B2's CSV uploads) reads `config.s3`
rather than declaring its own; if it needs extra S3 fields, it asks the lead.

Lead-owned (never edited on a lane branch): `packages/contracts/**`, `packages/db/migrations/**`,
`apps/server/src/seams/**`, `apps/server/src/{app.ts,app-context.ts,index.ts}`,
`apps/server/src/config/{index,load,schema,env}.ts`, `apps/server/src/config/blocks/base.ts`,
the shared infrastructure in §4, root config, CI.

## 3. Seams

### 3.1 Voice engine → agency runtime (lane C provides; Phase 6 consumes)

Core's agency runtime calls the bridge through exactly these members of `WebRtcBridgeManager`
(`magic-voice-core/src/core/webrtc-bridge-manager.ts`). Lane C ports the bridge to
`apps/server/src/core/webrtc-bridge-manager.ts` and **keeps every one of these signatures and
types unchanged**:

```ts
class WebRtcBridgeManager {
  onLifecycle(listener: WebRtcLifecycleListener): () => void;                                   // :280
  createBridgedCall(params: WebRtcBridgedCallParams): Promise<WebRtcCallRecord>;                // :445
  createUnboundBridgedCall(params: Omit<WebRtcBridgedCallParams, 'browserSocket'>): Promise<WebRtcCallRecord>; // :494
  bindBorrowedBrowserLeg(correlationId: string, ws: WebSocket): boolean;                       // :954
  reattachBorrowedBrowserLeg(correlationId: string, ws: WebSocket): boolean;                   // :1028
  forceEndWithOutcome(correlationId: string, outcome: string): Promise<boolean>;               // :1064
  playClipToCarrierThenHangUp(correlationId: string,
    opts: { clipHash: string; outcome: string; status?: WebRtcCallStatus }): Promise<boolean>;  // :1106
  getActiveCallIds(): string[];                                                                 // :370
  gracefulShutdown(): Promise<void>;                                                            // :381
}
export class WebRtcCallError extends Error { /* :75, unchanged */ }
export interface WebRtcOutboundParams { /* :87 */ }      // sipConnectionId may be deleted (SIP is out)
export interface WebRtcBridgedCallParams { /* :108 */ }
export interface WebRtcLifecycleEvent { /* :139, unchanged */ }
export type WebRtcLifecycleListener = (event: WebRtcLifecycleEvent) => void;
```

`WebRtcCallRecord` / `WebRtcCallStatus` come from `packages/db/src/models/agency-call.model.ts`
(§4, the ported `webrtc-call.model.ts`). Allowed change: the constructor. Core takes
`(callManager: CallManager, redis)` and uses `CallManager` only for the concurrency guard
(`acquireTelephonyConcurrency`, `releaseTelephonyLease`, `wakeSelfHeal`; `triggerDequeue` is AI-queue
only and goes). Lane C replaces `CallManager` with its extracted guard host and documents the new
constructor in `PORTING.md`. Lane C adds a type-level test that a `WebRtcBridgeManager` satisfies an
interface listing exactly the members above, so a signature change fails `tsc`.

### 3.2 Voice engine → analysis (lane C calls, lane D implements)

`apps/server/src/seams/bridge-analysis-hooks.ts`. The bridge calls `getBridgeAnalysisHooks()
.onCallFinalized(facts)` where core called `maybeEnqueueAnalysis` (`:2073`, fire-and-forget) and
`.onRecordingReady(callId)` where core called `notifyDialerAnalysisRecordingReady` (`:1830`, awaited).
Lane C deletes both private methods and their imports. Lane D moves their bodies verbatim
(minus gate 3, the softphone opt-out) into its implementation and registers it in
`apps/server/src/bootstrap/analysis.ts`. Lane D ports the bridge's analysis-enqueue tests against
the hook implementation; lane C tests that the hooks are called with the right facts at both sites.

### 3.3 Super-admin concurrency write → guard (lane A calls, lane C implements)

`apps/server/src/seams/concurrency-control.ts`. Lane A's super-admin concurrency route ports core's
`PUT /internal/account-concurrency` / `GET /internal/account-concurrency` logic: the repository writes
are shared (§4); the three invalidations keep core's order (settings cache → account guard → provider
guard) with the two guard calls going through `getConcurrencyControl()`, and the utilization read
(`getAccountCount`) and the provider-mode migration's drain check (`getDistributedAccountCount`, the
account guard — not the provider guard) go through it too (added at lane A's request). Lane C registers the
implementation in `apps/server/src/bootstrap/voice.ts`.

## 4. Shared infrastructure (lead, Phase 2b — lands before the lanes)

Ported once, by the lead, because more than one lane reads or writes it. Lanes import it; a lane
that needs a new method or column asks the lead.

- Repositories in `packages/db/src/repositories/`: `agency-call.repository.ts` (core
  `webrtc-call.repository.ts` re-keyed onto `agency_calls`, settlement removed) and its model;
  `account-settings.repository.ts`; `provider-concurrency.repository.ts`;
  `agency-campaign-agent.repository.ts` (master staffing — lane A's revoke path calls
  `closeAllForUser`); `feature-flag.repository.ts`; the two audit repositories.
- `apps/server/src/feature-flags/`: core's flag service, with the registry trimmed to the agency
  flags in `@magick-agency/contracts/flags`. Lane A builds the super-admin override routes on it.
- `apps/server/src/audit/`: core's `auditLogger` (→ `audit_logs`, the "Dialer" half of the activity
  trail) and master's platform audit logger with its catalog, vocabulary and actor types
  (→ `platform_audit_log`, the "Console" half). Both tables are kept (build decision B7).

## 5. Known gaps in the seams

- **Carrier fixture in both repos.** Plan §5 wants a byte-identical `voicelink-carrier.fixture.json`
  in core and agency. Core is read-only during the build, so lane C commits agency's copy and the core
  half is a later core PR. Phase 5's exit gate item "fixture green in both repos" is met on the agency
  side only until then.
- **One real call on the VoiceLink sandbox** (Phase 5 gate) and **one real recording analysed**
  (Phase 7 gate) need vendor accounts that Phase 0 has not provisioned. Not attempted without Manas.

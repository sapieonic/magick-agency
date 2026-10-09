# Seams and module boundaries

The module boundaries inside `apps/server` and the fixed interfaces between them: which files
each module area owns, which config keys each declares, where shared infrastructure lives, and the
two cross-module seams. Read it before moving a file, adding a config key, route plugin or
bootstrap, or changing anything under `apps/server/src/seams/`. Source comments cite this file.
Checked against the tree on 2026-10-09.

The rule for the seams below: change the interface deliberately, in one commit with its consumers
and its pinning test, never by adapting one side to the other.

## 1. Where files go

| Kind of file | Where |
|---|---|
| Server modules | `apps/server/src/<area>/...` |
| Repositories and models used by more than one area | `packages/db/src/repositories/`, `packages/db/src/models/` |
| The agency repository, its model and the DNC outbox repository (they import about fifteen `apps/server/src/agency/` modules) | `apps/server/src/db/repositories/`, `apps/server/src/db/models/` (decision B12) |
| Logger, log context, crypto, metric instruments, tracing (`Traced`, `withSpan`) | `packages/observability/src/` |
| Metric declarations | `packages/observability/src/metrics/<area>.ts` |
| The dialer's wire contract | `packages/contracts/src/agency.ts` |
| Leaf dialer rules (no imports, or only contracts and other leaves: abandonment predicate, timers, rates, keyset cursor, success disposition, ...) | `packages/domain/src/` |
| Unit and integration tests | the package's `test/unit/<path>` and `test/integration/<path>`, mirroring `src/<path>` |

## 2. Module-area files in the shared server

Each module area (decision B4) has one file of each kind:

| Kind | Platform | Agency | Voice | Analysis |
|---|---|---|---|---|
| Config block | `apps/server/src/config/blocks/platform.ts` | `.../agency.ts` | `.../voice.ts` | `.../analysis.ts` |
| Routes | `apps/server/src/api/platform.plugin.ts` | `.../agency.plugin.ts` | `.../voice.plugin.ts` | `.../analysis.plugin.ts` |
| Background work | `apps/server/src/bootstrap/platform.ts` | `.../agency.ts` | `.../voice.ts` | `.../analysis.ts` |
| Metrics | `packages/observability/src/metrics/platform.ts` | `.../agency.ts` | `.../voice.ts` | `.../analysis.ts` |

Config blocks must declare **disjoint top-level keys** (enforced at load by `config/schema.ts` and
by `test/unit/config/blocks-disjoint.test.ts`). The keys each block declares:

| Block | Top-level keys |
|---|---|
| `base.ts` | `server`, `db`, `redis` |
| `platform.ts` | `firebase`, `superAdmin`, `mailjet`, `brand`, `invites`, `localCache`, `consoleBaseUrl`, `auditPartitions` |
| `agency.ts` | `agency` |
| `voice.ts` | `concurrency`, `telephony`, `rateLimit`, `s3`, `staticCallTts`, `audio`, `analytics` |
| `analysis.ts` | `postCallAnalysis`, `dialerAnalysis`, `voicelinkRecording`, `recordingUrlSigningSecret`, `retention` |

A module that needs S3 reads `config.s3` rather than declaring its own key.

Composition files that every area depends on, changed with care: `packages/contracts/**`,
`packages/db/migrations/**`, `apps/server/src/seams/**`,
`apps/server/src/{app.ts,app-context.ts,index.ts}`,
`apps/server/src/config/{index,load,schema,env}.ts`, `apps/server/src/config/blocks/base.ts`, the
shared infrastructure in §4, root config and CI.

## 3. Seams

### 3.1 Voice engine → dialer runtime

The dialer runtime calls the bridge through exactly these members of `WebRtcBridgeManager`
(`apps/server/src/core/webrtc-bridge-manager.ts`):

```ts
class WebRtcBridgeManager {
  onLifecycle(listener: WebRtcLifecycleListener): () => void;
  createBridgedCall(params: WebRtcBridgedCallParams): Promise<WebRtcCallRecord>;
  createUnboundBridgedCall(params: Omit<WebRtcBridgedCallParams, 'browserSocket'>): Promise<WebRtcCallRecord>;
  bindBorrowedBrowserLeg(correlationId: string, ws: WebSocket): boolean;
  reattachBorrowedBrowserLeg(correlationId: string, ws: WebSocket): boolean;
  forceEndWithOutcome(correlationId: string, outcome: string): Promise<boolean>;
  playClipToCarrierThenHangUp(correlationId: string,
    opts: { clipHash: string; outcome: string; status?: WebRtcCallStatus }): Promise<boolean>;
  getActiveCallIds(): string[];
  gracefulShutdown(): Promise<void>;
}
export class WebRtcCallError extends Error {}
export interface WebRtcOutboundParams {}
export interface WebRtcBridgedCallParams {}
export interface WebRtcLifecycleEvent {}
export type WebRtcLifecycleListener = (event: WebRtcLifecycleEvent) => void;
```

`WebRtcCallRecord` and `WebRtcCallStatus` come from `packages/db/src/models/agency-call.model.ts`.
The constructor takes the `TelephonyGuardHost` (`apps/server/src/core/telephony-guard-host.ts`),
which provides the concurrency guard (`acquireTelephonyConcurrency`, `releaseTelephonyLease`,
`wakeSelfHeal`). A type-level test, `apps/server/test/unit/core/webrtc-bridge-seam-contract.test.ts`,
checks that `WebRtcBridgeManager` satisfies an interface listing exactly these members, so a
signature change fails `tsc`.

### 3.2 Voice engine → analysis

`apps/server/src/seams/bridge-analysis-hooks.ts`. The bridge calls
`getBridgeAnalysisHooks().onCallFinalized(facts)` when a call finalises (fire-and-forget; the bridge
never awaits analysis) and `.onRecordingReady(callId)` when the recording URL arrives (awaited;
the implementation swallows its own errors). Implementations catch and log rather than throw into
the bridge. The implementation is `apps/server/src/analysis/bridge-analysis-hooks.ts`, registered in
`apps/server/src/bootstrap/analysis.ts` only when the analysis worker is enabled; otherwise the hooks
stay no-ops. Tests cover both sides: the hooks are called with the right facts at both sites, and the
implementation enqueues correctly.

### 3.3 Super-admin concurrency writes → guard

`apps/server/src/seams/concurrency-control.ts`. The super-admin concurrency routes write the
allocation through the shared repository, then invalidate in order: settings cache, account guard,
provider guard (the two guard calls go through `getConcurrencyControl()`). The utilization read
(`getAccountCount`) and the provider-mode migration's drain check (`getDistributedAccountCount`, on
the account guard) go through it too. The voice engine registers the implementation in
`apps/server/src/bootstrap/voice.ts`; until then every call throws, so a write before wiring fails
loudly. `apps/server/test/integration/app/concurrency-seam-wiring.test.ts` proves the wiring through
`buildApp`.

## 4. Shared infrastructure

Read or written by more than one module area, so it has one home (decision B10):

- Repositories in `packages/db/src/repositories/`: `agency-call.repository.ts` and its model;
  `account-settings.repository.ts`; `provider-concurrency.repository.ts`;
  `agency-campaign-agent.repository.ts` (staffing; membership revocation calls `closeAllForUser`);
  `feature-flag.repository.ts`; the two audit repositories.
- `apps/server/src/feature-flags/`: the flag service, with the registry in
  `@magick-agency/contracts/flags`. The super-admin override routes are built on it.
- `apps/server/src/audit/`: `auditLogger` (→ `audit_logs`, the "Dialer" half of the activity trail)
  and the platform audit logger with its catalog, vocabulary and actor types (→ `platform_audit_log`,
  the "Console" half). Both tables are kept (decision B7).

## 5. Known gaps

- **One real call on a VoiceLink sandbox** and **one real recording analysed** need vendor accounts
  that have not been provisioned. Not attempted. See [`status.md`](status.md).

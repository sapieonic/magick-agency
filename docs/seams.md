# Seams and module boundaries

The module boundaries inside `apps/server` and the fixed interfaces between them: which files
each module area owns, which config keys each declares, where shared infrastructure lives, and the
two cross-module seams. Read it before moving a file, adding a config key, route plugin or
bootstrap, or changing anything under `apps/server/src/seams/`. Source comments cite this file.
Checked against the tree on 2026-10-09; §3.1 on 2026-10-30; §3.1, §3.4, §4 and §5 on 2026-11-07
(Plivo steps 3 and 4).

The rule for the seams below: change the interface deliberately, in one commit with its consumers
and its pinning test, never by adapting one side to the other.

## 1. Where files go

| Kind of file | Where |
|---|---|
| Server modules | `apps/server/src/<area>/...` |
| Repositories and models used by more than one area | `packages/db/src/repositories/`, `packages/db/src/models/` |
| The agency repository and its model (they import about fifteen `apps/server/src/agency/` modules) | `apps/server/src/db/repositories/agency.repository.ts`, a barrel over one file per repository class in `apps/server/src/db/repositories/agency/` (callers and `vi.mock` use the barrel path); `apps/server/src/db/models/` (decision B12) |
| Logger, log context, crypto, metric instruments, tracing (`Traced`, `withSpan`) | `packages/observability/src/` |
| Metric declarations | `packages/observability/src/metrics/<area>.ts` |
| The dialer's wire contract | `packages/contracts/src/agency.ts`, a barrel over `packages/contracts/src/agency/` |
| UI components, hooks and helpers used by both SPAs | `packages/web-ui/src/` (decision B23) |
| Leaf dialer rules (no imports, or only contracts and other leaves: abandonment predicate, timers, rates, keyset cursor, success disposition, ...) | `packages/domain/src/` |
| A route plugin's routes, once it is large | the exported plugin function, its hooks and module note stay in `apps/server/src/api/routes/<family>.routes.ts`; the routes go in `apps/server/src/api/routes/<family>/` as `register…(app)` functions it calls on the same instance, so its hooks apply to them and the area plugin does not change |
| Helpers shared by several route files (ownership probe, parse-or-400, CSV attachment, page drain, ...) | `apps/server/src/api/routes/helpers/` |
| Composition for several processes on one host: process roles, the IPC protocol and channel, the child supervisor, the socket handoff, the media and analysis worker entries, the readiness and shutdown order (`docs/scaling.md`). Composition like `bootstrap/` and `seams/`, not a fifth module area | `apps/server/src/cluster/` |
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
| `base.ts` | `server`, `db`, `redis`, `otel`, `processes` |
| `platform.ts` | `firebase`, `superAdmin`, `mailjet`, `brand`, `invites`, `localCache`, `consoleBaseUrl`, `auditPartitions`, `userRateLimit`, `mobile` |
| `agency.ts` | `agency` |
| `voice.ts` | `concurrency`, `telephony`, `telephonyCredentials`, `rateLimit`, `s3`, `staticCallTts`, `audio`, `analytics` |
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
  isCallEnding(correlationId: string): boolean;
  reattachBorrowedBrowserLeg(correlationId: string, ws: WebSocket): boolean;
  forceEndWithOutcome(correlationId: string, outcome: string): Promise<boolean>;
  playClipToCarrierThenHangUp(correlationId: string,
    opts: { clipHash: string; outcome: string; status?: WebRtcCallStatus }): Promise<boolean>;
  getActiveCallIds(): string[];
  gracefulShutdown(): Promise<void>;
  // Inbound calls (docs/inbound.md §3), P1:
  acceptInboundCall(params: WebRtcInboundCallParams): Promise<WebRtcInboundAcceptance>;
  playClipSequenceThenHangUp(correlationId: string,
    opts: { clipHashes: readonly string[]; outcome: string }): Promise<ClipSequenceResult>;
  // Connecting inbound callers (docs/inbound.md §5), P2:
  playInboundHold(correlationId: string, opts: InboundHoldOptions): Promise<InboundHoldResult>;
  stopInboundHold(correlationId: string): void;
  recordInboundAudio(correlationId: string, opts: InboundRecordOptions): Promise<InboundAudioRecording>;
}
export class WebRtcCallError extends Error {}
export interface WebRtcOutboundParams {}
export type WebRtcCallCorrelation =
  | { kind: 'attempt'; campaignId: string; agencyAttemptId: string }
  | { kind: 'manual'; manualCallId: string };
export interface WebRtcBridgedCallParams {} // WebRtcOutboundParams + browserSocket, correlation, browserCloseGraceMs?
export interface WebRtcLifecycleEvent {}
export type WebRtcLifecycleListener = (event: WebRtcLifecycleEvent) => void;
```

`WebRtcOutboundParams` names the carrier (`provider`) and, for a carrier dialled on a
tenant's own account, the credential (`telephonyCredentialId`, decisions B18–B20): the bridge
pins it on the call row (an insert that re-checks it is `active`) and dials on it, never on the
service's own account. The refusals with nothing placed at the carrier each have their own
`WebRtcRejectReason` and emit no `ended`: the admission refusals, `station_socket_unavailable`,
`telephony_credential_unavailable` (the credential cannot dial; the dialer pauses the campaign
`carrier_account_unavailable`), `carrier_rate_limited` (a
calls-per-second limit) and `carrier_auth_rejected` (the carrier refused the credential, HTTP
401; the bridge marks the credential `invalid` against the secret version that dialled, and
the dialer pauses the campaign `carrier_auth`) and `carrier_dial_not_sent` (the adapter
would not send the dial: no webhook base, a malformed number or caller ID, the carrier's API
unreachable; `CarrierDialNotSentError`). `telephony_init_failed` is the carrier refusing a
dial: it ends the call first, with an `ended`.

`correlation` says what a leg belongs to: a campaign attempt (the dialer) or a soft-phone call
(`agency_manual_calls`, `docs/softphone.md` §4.3). The `agency_calls` insert writes `campaign_id` +
`agency_attempt_id` with `origin = 'campaign'` for an attempt, and `origin = 'manual'` +
`manual_call_id` with no campaign or attempt id for a manual call (`ck_agency_calls_manual_correlation`).
The session's `correlationId`, which lifecycle events carry and every correlation-keyed member above
takes, is the attempt id or the manual call id. A `manual` leg honours `browserCloseGraceMs` only once
the carrier has answered: a station close while the phone still rings hangs up at once.

The browser leg's media format (`pcm16` or `alaw8`, contracts `AgencyStationMediaFormat`) is not a
parameter of these members: it travels on the socket. The station handler calls
`setBrowserLegMediaFormat(ws, format)` (`apps/server/src/core/bridge/browser-leg-media.ts`) at the
upgrade, and every member that attaches a socket reads it with `browserLegMediaFormatOf(ws)`
(untagged ⇒ `pcm16`). The two functions are pinned in the seam contract test below.

The exported types and `WebRtcCallError` are defined in `apps/server/src/core/bridge/bridge-types.ts`
and re-exported unchanged from `webrtc-bridge-manager.ts`, which stays the seam's module path (import
them from there). `WebRtcCallRecord` and `WebRtcCallStatus` come from `packages/db/src/models/agency-call.model.ts`.
The constructor takes the `TelephonyGuardHost` (`apps/server/src/core/telephony-guard-host.ts`),
which provides the concurrency guard (`acquireTelephonyConcurrency`, `releaseTelephonyLease`,
`wakeSelfHeal`). A type-level test, `apps/server/test/unit/core/webrtc-bridge-seam-contract.test.ts`,
checks that `WebRtcBridgeManager` satisfies an interface listing exactly these members, so a
signature change fails `tsc`.

The two inbound members take in a call a customer placed, whose `origin = 'inbound'` leg the
inbound answer webhook wrote: `acceptInboundCall` registers its session (answered at once, a media
deadline in place of the ring deadline, no browser leg), takes the shared slots and returns the
stream URL the answer XML names; admission never refuses it (IB5: `capacity` is `admitted`,
`account_full` (held with no slot), `no_capacity` (global or carrier scope full: held with no slot
to hear why) or `not_requested`), and a retried answer gets the live session's stream.
`playClipSequenceThenHangUp` waits for the carrier's media, plays the clips paced, then hangs up
under the outcome (`completed`); a caller who leaves mid-clip stops it with no hangup of ours
(`aborted`); `no_media`, `not_found` otherwise. The session's `correlationId` is the inbound call's
id. `WebRtcInboundCallParams`, `WebRtcInboundAcceptance` and `ClipSequenceResult` are in
`bridge-types.ts`, pinned by the same contract test.

P2 puts inbound callers through to agents. `WebRtcInboundCallParams` names `connectable`,
`browserCloseGraceMs`, `parkedSeconds` and `record` (P1's messages-only calls pass `false`, 0, 0,
`false`; a voicemail that is not connectable passes its budget floor as `parkedSeconds`, and the
call's budget is the longer of it and the account's max duration). A **connectable** call is parked: its browser leg is borrowed and unbound, so
`bindBorrowedBrowserLeg` (keyed on the inbound call's id) can put the agent's station socket on it
and a dropped socket after that is held `browserCloseGraceMs` for `reattachBorrowedBrowserLeg`. Its
budget is `parkedSeconds` (at least the media deadline) plus the account's max duration: the
answer's `maxDurationSeconds` (so the answer XML's stream timeout) and the slot and token lifetimes
are that sum, and the bridge's own timer ends a call still unbound after `parkedSeconds`
(`max_duration_reached`, a backstop behind the caller's queue). The bind is where the agent takes
over, synchronously and before the relay attaches: whatever the bridge plays to the caller stops (no
frame of it follows the bind), the max duration is re-armed in full and talk time counts from the
bind (0 for a call no agent took). With `record` (under the account's `allow_recording`), the call
is recorded from the `bridged` moment through the carrier's record-on-demand API
(`ProviderCapabilities.recordsOnDemand`, Plivo's Record API), with a `webhook` token minted then for
the recording callback (`…/webrtc-recording/:callId`, whose reader takes the `<Record>` element's
params and the Record API's alike); the hold is never recorded.

- `playInboundHold` waits for the carrier's media, plays `preambleClipHashes` once, then loops the
  hold clip (none, or one not on this replica: the built-in generated hold tone,
  `core/bridge/hold-tone.ts`) until it is stopped. It never hangs up. `released`: stopped with the
  caller still on (the bind, `stopInboundHold`, a recording, a later hold); `aborted`: the caller
  left; `no_media`, `not_found`. `onPreambleDone` (optional) is called once, synchronously, when
  the preamble has played and the loop starts: the inbound connector queues the caller from it,
  so no agent is bound during the greeting or the recording notice (docs/inbound.md §2, IQ5).
- `stopInboundHold` stops what the bridge plays to the caller, synchronously: an overflow message or
  a voicemail prompt can follow at once.
- `isCallEnding` answers whether the call keyed on the correlation id is over or tearing down (no
  session by that id, or one tearing down): what the inbound connector asks after a refused
  `bindBorrowedBrowserLeg`, so an ending call is left to its `ended` while one refused for any
  other reason has its offer cancelled.
- `recordInboundAudio` stops the hold, plays `promptClipHashes` once and, with `beep`, a 400 ms
  beep, then records the caller through a carrier tap installed only for the recording and fed
  before the relay's no-browser-leg drop, bounded to `maxSeconds` of audio and of wall clock. It
  never hangs up. It answers PCM16 at 16 kHz: `completed` (the maximum), `caller_left` (what was
  captured until the caller hung up), `no_media`, `not_found`.

`InboundHoldOptions`, `InboundHoldResult`, `InboundRecordOptions` and `InboundAudioRecording` are in
`bridge-types.ts`, pinned by the contract test.

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

`apps/server/src/seams/concurrency-control.ts`. The super-admin concurrency routes
(`api/routes/super-admin/concurrency.ts`) write the
allocation through the shared repository, then invalidate in order: settings cache, account guard,
provider guard (the two guard calls go through `getConcurrencyControl()`). The utilization read
(`getAccountCount`) and the provider-mode migration's drain check (`getDistributedAccountCount`, on
the account guard) go through it too. The voice engine registers the implementation in
`apps/server/src/bootstrap/voice.ts`; until then every call throws, so a write before wiring fails
loudly. `apps/server/test/integration/app/concurrency-seam-wiring.test.ts` proves the wiring through
`buildApp`. `startAgency` then wraps the registered implementation (`agency/pacing/limit-invalidation.ts`):
each `invalidateAccountLimit` / `invalidateProviderLimits` also publishes `account_limit_changed` on
the pacing invalidation bus, so the pacing engine's cached limit is dropped at the same point as the
guards'. The interface does not change; the agency stop unwraps it.

### 3.4 Super-admin credential routes → carrier credential service

The super-admin telephony-credential routes (`api/routes/super-admin-telephony-credentials.routes.ts`,
registered by the platform plugin) call the voice area's `TelephonyCredentialService`
(`apps/server/src/telephony/credentials/`) directly through `getTelephonyCredentialService()`,
not through a registered seam. This is deliberate: the service holds no runtime state that
bootstrap must start (it is built lazily from the `telephonyCredentials` config block and the
shared repository, so it works the same before and after voice bootstrap), and the only
background work, the hourly sweep, is started from `bootstrap/voice.ts`. Route tests inject a
fake through the plugin's `service` option. If the service ever gains state that needs
bootstrap ordering, move it behind a seam like §3.3. Number sync
(`POST /super-admin/telephony-credentials/:id/sync-numbers`, `syncNumbers`) goes the same way, and so
does inbound on a credential (docs/inbound.md §8): the routes in
`api/routes/super-admin-telephony-credentials/inbound.ts`, registered by the same plugin, call
`TelephonyInboundService` through `getTelephonyInboundService()` (`telephony/credentials/`, built on
the credential service, which opens the secrets; tests inject a fake through the plugin's `inbound`
option). The super-admin phone routes call its §8.2 cascade (`reconcileNumber`) after an unassign,
retire or delete, the same way.

The other readers of the credential store outside the voice area import it directly too, for the
same reason (no bootstrap state), and none of them opens a secret except through the service:

- campaign management (`agency/campaign-carrier.ts`) reads the voice area's credential specs
  (`findCredentialSpec`: does a carrier take tenant credentials) and the shared credential
  repository, to check a campaign's carrier, credential and caller IDs;
- the super-admin phone routes read the same two to refuse hand-added numbers on a
  tenant-credential carrier and a synced number assigned to another tenant;
- every recording fetch (the attempt and soft-phone recording proxies, signed playback, the
  analysis runner) asks `telephony/recording-access.ts` for the call's hosts and headers, which
  resolves the pinned credential through the service lazily (`getRecordingAccessResolver`).

### 3.5 Voice engine (inbound carrier callbacks) → agency (inbound router)

`apps/server/src/seams/inbound-call-router.ts`. The voice area owns the carrier-facing surface of
an inbound call (`api/routes/webhooks/plivo-inbound.ts` under `/api/v1/webhooks/plivo`: the
credential's purpose token, the V3 signature over the URL stored on the credential plus the query,
the per-credential nonce, the XML Plivo runs); what the call means is the agency area's, reached
only through `InboundCallRouter`: `answer(arrival, { signal })` returns a decision (`stream` with
the URL; `spoken` with an `InboundSpokenMessage`, `closed`, `callback` or `busy`, whose XML is the
voice area's, `PLIVO_INBOUND_SPOKEN_XML`, saying the words of the standard recordings the agency area
plays on its stream, `AGENCY_INBOUND_STANDARD_WORDS` in the contract; `hangup`; `fallback`), and the route aborts
`signal` when the answer's budget runs out and it has answered the fallback message, after which
the router places nothing more and leaves no follow-up; `ended(hangup)` settles the call (and records
the carrier's `durationSeconds`, Plivo's `Duration`, on it when the hangup carries one) and
returns its media leg, which the route then hands to the bridge as a carrier hangup
(`handleCarrierStatus`). The
implementation is `agency/inbound/inbound-call-router.ts`, registered by `bootstrap/agency.ts`
(`startInboundCalls` in `agency/inbound/start.ts`, after the startup sweep) and cleared at its stop; until then an arriving call
is answered with the fixed fallback message and nothing is written. Tests:
`test/unit/api/routes/plivo-inbound-webhooks.test.ts` (the route with a stub router, the unwired
default included, each spoken message, the signal), `test/integration/agency/inbound-call-router.test.ts`
(the router on real Postgres with a fake bridge) and `test/integration/telephony/plivo-inbound-e2e.test.ts`
(through `buildApp` and the bootstraps).

## 4. Shared infrastructure

Read or written by more than one module area, so it has one home (decision B10):

- Repositories in `packages/db/src/repositories/`: `agency-call.repository.ts` and its model;
  `account-settings.repository.ts`; `provider-concurrency.repository.ts`;
  `agency-campaign-agent.repository.ts` (staffing; membership revocation calls `closeAllForUser`);
  `feature-flag.repository.ts`; the two audit repositories; `telephony-credential.repository.ts`
  (voice resolves credentials through it; the super-admin routes manage them through the voice
  service, §3.4); `phone-number.repository.ts` and `tenant-phone-assignment.repository.ts` (the
  phone and super-admin routes, the voice area's number sync, and the agency area's caller-ID
  checks and soft phone, through `findAvailableForAccount`, which offers a synced number only while
  its credential is `active`).
- `apps/server/src/feature-flags/`: the flag service, with the registry in
  `@magick-agency/contracts/flags`. The super-admin override routes are built on it.
- `apps/server/src/audit/`: `auditLogger` (→ `audit_logs`, the "Dialer" half of the activity trail)
  and the platform audit logger with its catalog, vocabulary and actor types (→ `platform_audit_log`,
  the "Console" half). Both tables are kept (decision B7).

## 5. Known gaps

- **One real call on a VoiceLink sandbox** and **one real recording analysed** need vendor accounts
  that have not been provisioned. Not attempted. See [`status.md`](status.md).
- **One real Plivo call and recording** (Plivo step 5) needs a tenant's Plivo account. Every Plivo
  path has run only against the mock carrier (`apps/server/test/mocks/plivo/`).

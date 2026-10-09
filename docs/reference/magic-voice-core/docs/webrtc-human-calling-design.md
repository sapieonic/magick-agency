> **Reference copy, verbatim below this box.** Origin: magic-voice-core @ `4850d1d9` (v1.123.2), path `docs/webrtc-human-calling-design.md`. Copied into Magick Agency on 2026-10-09; not kept in sync.
>
> **How this maps to Magick Agency:** The WebRTC human-calling bridge design. Agency's bridge (`apps/server/src/core/webrtc-bridge-manager.ts`) is a verbatim port of it, minus the softphone, SIP and VoBiz branches and settlement; calls are rows in `agency_calls`, not `webrtc_calls`.
>
> Index of all copies: [`docs/reference/README.md`](../../README.md).

# WebRTC Human Calling — Design (v1)

**Status:** Phase 1 (core backend) in progress
**Owner:** voice
**Branch:** `claude/webrtc-calling-magickvoice-27wj9r`
**Provider scope:** VoBiz only (v1)

## 1. Summary

A browser softphone: a logged-in user dials a PSTN number from the browser, core
opens a media-stream WebSocket to the browser **and** places an outbound VoBiz
call to the dialed number, then **bridges the two audio legs together** so the
two humans talk. There is **no AI pipeline** in the path — this is a pure
human↔human relay.

This is *not* WebRTC peer/SFU (no SDP/ICE/SRTP). "WebRTC" here means
browser-realtime voice over the same WebSocket + Web Audio (AudioWorklet, PCM16
16 kHz) transport the existing `browser-call` test client already uses. VoBiz
streams **L16 PCM16 at 16 kHz** — the *same* format the browser produces — so the
two legs bridge with **zero transcoding**.

Single call per request — **no bulk**.

## 2. Decisions (confirmed with product)

| Decision | Choice | Rationale |
|---|---|---|
| Transport | WebSocket + Web Audio, PCM16 16 kHz both legs | ~90% infra reuse, no media server, no transcode |
| Concurrency | **Shares** `account_settings.max_concurrent_calls` | Reuses `CallManager`'s public `concurrencyGuard` / `accountConcurrencyGuard` + `triggerDequeue()` |
| Caller-ID source | Active VoBiz DIDs in `inbound_phone_numbers` | "Use existing allocated numbers" — no new allocation surface |
| Metering | New `webrtc_calls` usage offering + `webrtc_call` settlement type | Separate billing line; talk-time anchored at PSTN answer |
| Gating | Feature flag `webrtc_calls_enabled` (global/tenant/account, default **off**) | Matches the feature-flag registry pattern |
| Max duration | Feature flag `webrtc_max_duration_seconds` (number) | Mirrors `prewarm_ring_delay_ms` (env-defaulted, per-tenant override) |
| v1 controls | dial · ring/answer status · two-way audio · hang-up (either side) · client-side mute | DTMF / hold / recording / transfer are out |

## 3. Architecture

Kept **fully isolated** from the AI `CallManager` media path (which carries
pre-warm/AMD/silence-nudge/STT/LLM/TTS complexity that human-bridging does not
need). New subsystem:

- `src/core/webrtc-bridge-session.ts` — `BridgeSession`: holds both WebSockets,
  state, answer anchor, max-duration timer; relays frames; tears down.
- `src/core/webrtc-bridge-manager.ts` — `WebRtcBridgeManager`: own
  `Map<callId, BridgeSession>`; creates calls, acquires shared concurrency,
  drives the VoBiz outbound leg, handles VoBiz webhooks, settles + releases.

It holds a reference to `CallManager` **only** to reuse:
`callManager.concurrencyGuard`, `callManager.accountConcurrencyGuard`,
`callManager.triggerDequeue()`. This is the exact pattern the static/IVR
release paths already use in `webhooks.routes.ts`, so the shared per-account
limit is genuinely one counter (atomic Lua `INCR` serializes AI + WebRTC
acquisitions on the same Redis key).

### 3.1 Two WebSocket endpoints (both owned by the bridge)

- **Browser leg:** `GET /api/v1/webrtc-call/:callId/browser-stream?token=…`
  Browser connects here; authenticated by a short-lived **random nonce token**
  (a UUID, **not** an HMAC) issued by the `POST /api/v1/webrtc-call` response and
  stored in Redis keyed by call id (TTL spans the whole call, cleared on end).
  Verified on connect; degrades to the unguessable call id alone when Redis is
  unavailable (the media-stream WS is otherwise unauthenticated, relying on an
  unguessable id — for a browser-initiated leg we add this token on top).
- **PSTN leg:** `GET /api/v1/webrtc-call/:callId/pstn-stream`
  VoBiz connects here; the URL is emitted in the VoBiz answer XML `<Stream>`.

### 3.2 Audio relay

Both legs are PCM16 16 kHz. Frames are JSON `{event:'media', media:{payload:b64}}`.

- browser → PSTN: re-wrap as VoBiz `{event:'playAudio', media:{contentType:'audio/x-l16', sampleRate:16000, payload}}`
- PSTN → browser: forward as `{event:'media', media:{payload}}`

Frames are **dropped** until both legs are connected (no one to hear them yet);
this causes only sub-second clipping at connect and avoids unbounded buffering.
Barge-in/VAD is irrelevant (human↔human full-duplex).

### 3.3 Call flow

```
POST /api/v1/webrtc-call  (auth: tenant+account headers; flag-gated)
  ├─ validate caller_id ∈ active VoBiz DIDs for tenant/account
  ├─ acquire global + per-account slot (shared guards) → 429 if full
  ├─ INSERT webrtc_calls (status='initiating')
  ├─ vobizAdapter.initiateCall(from=caller_id, to=destination,
  │     answer_url=…/vobiz/webrtc-answer/:id, status_url=…/vobiz/webrtc-status/:id)
  └─ 201 { call_id, status, browser_ws_url, token, message }

Browser connects browser-stream WS (token) → starts mic capture + playback
VoBiz: ringing → POST webrtc-status → bridge: status='ringing', notify browser
VoBiz: answer  → POST webrtc-answer → bridge: markAnswered, status='in_progress',
                 return <Stream url=…/pstn-stream/:id bidirectional contentType=L16>
VoBiz connects pstn-stream WS → BOTH legs live → relay audio
Hang-up (either side / timeout) → end both legs, settle, release slot, triggerDequeue
```

### 3.4 Lifecycle / status

`webrtc_calls.status`: `initiating → ringing → in_progress →
completed | failed | no_answer | busy | canceled`.

Teardown triggers (all funnel to one idempotent `endCall`):
- browser WS close → hang up PSTN (`vobizAdapter.endCall(providerCallId)`)
- VoBiz hangup webhook (`completed`/`no-answer`/`busy`) → close browser WS
- explicit `POST /api/v1/webrtc-call/:id/end`
- max-duration timer

## 4. Data model

Migration `047_webrtc_calls.sql` → `webrtc_calls`:

- ids: `id` UUID PK, `tenant_id`, `account_id` (NOT NULL, scoped + indexed)
- `caller_id` (the allocated DID used as from), `destination_phone` (E.164)
- `provider` ('vobiz'), `provider_call_id`
- `status`, `outcome`, `error_code`, `error_message`
- timing: `created_at`, `answered_at`, `ended_at`, `duration_seconds`,
  `talk_time_seconds` (answer-anchored — what billing rounds)
- `initiated_by` (opaque user ref, optional), `metadata` JSONB
- indexes: `(tenant_id, account_id, created_at DESC)`, partial index on
  non-terminal `status` for the stale sweep

Talk-time billing uses the shared `billedUnitsSqlExpr` (per-call CEIL→minutes),
identical to AI calls.

## 5. Metering

- **Settlement:** `dispatchSettlement({ call_type:'webrtc_call', talk_time_seconds, … })`
  → platform `…/webrtc-completed`. (magick-master handler is a Phase 3 dependency.)
- **Usage:** new `webrtc_calls` offering in `usage.repository.ts`
  (`secondsColumn='talk_time_seconds'`, connected = `['completed']`), surfacing
  through `/internal/usage/summary|records|export`.
- **Product analytics (PostHog):** its own funnel, separate from AI calls
  (no tier/pipeline/batch). Same identity model + PII posture as the AI events
  (IDs/enums/durations only — never phone numbers or metadata):
  - `webrtc_call_initiated` — emitted once per call from `createCall` (funnel
    denominator).
  - `webrtc_call_rejected` — pre-flight refusals: `feature_disabled` /
    `invalid_caller_id` (route) + `global_concurrency_limit` /
    `account_concurrency_limit` (bridge). The funnel-leak / capacity signal.
  - `webrtc_call_completed` — terminal event with status/outcome/`connected`
    (answer-anchored, so unanswered = 0), duration, talk-time, `error_code`, and
    `ended_by` (`user`/`remote`/`system`/`error`). Emitted from `endCall`.

## 6. Security

- HTTP API: existing tenant/account auth + the `webrtc_calls_enabled` flag.
- Caller-ID ownership check prevents spoofing arbitrary from-numbers.
- Browser WS: a random nonce token (not an HMAC) issued by the create response
  and stored in Redis keyed by call id, with a TTL spanning the whole call (so it
  never expires mid-call); verified on connect and cleared on end. When Redis is
  unavailable the leg falls back to accepting the unguessable call id alone (same
  degraded trust model as today's media-stream WS). PSTN WS relies on the
  unguessable id (same trust model as today's media-stream / VoBiz, unsigned).

## 7. Crash-safety

- Slots are released from bridge-session state (idempotent), never gated on a DB
  read — mirrors `CallManager.releaseSlots`.
- `webrtcCallRepository.failStaleActive()` fails crash-orphaned non-terminal rows
  older than a threshold and settles them (release credit). It is wired into
  `CallManager.sweepStaleActiveCalls` as a **fourth source** (`sweepStaleWebrtcCalls`),
  which excludes calls this replica is actively bridging via
  `CallManager.registerWebrtcActiveIdsProvider(() => bridge.getActiveCallIds())`
  (set up in `src/index.ts`). Shared concurrency counters are healed by the
  existing `reconcileAll()` (same Redis key namespace).
- `WebRtcBridgeManager.gracefulShutdown()` (wired in `src/index.ts` before infra
  teardown) ends/settles/releases every active bridge call so a deploy mid-call
  doesn't strand the carrier leg or leak a slot.

## 8. Phasing

- **Phase 1 (this branch):** core backend — migration, repo, flag, bridge
  manager/session, routes + validators, VoBiz webhooks, settlement + usage,
  unit tests.
- **Phase 2:** browser dialer UI — number entry, caller-ID picker, mic
  capture/playback (AudioWorklet, PCM16 16 kHz), call-state UI driven by the
  browser-leg WebSocket status/ended events. This lives in the **separate
  front-end repo** (the customer UI, e.g. `magick-comms-cusui`), **not** the
  legacy `web-client/` admin console in this repo. The AudioWorklet capture +
  playback logic from this repo's `browser-call` client (`browser-call.routes.ts`)
  is a reusable reference for the mic→PCM16 and playback paths.
- **Phase 3 (magick-master):** `/webhooks/core/webrtc-completed` settlement
  handler + credit product/pricing for the `webrtc_calls` offering; super-admin
  surfacing of the flag and usage.

## 9. Out of scope (v1)

Bulk dialing, DTMF, hold, server-side recording, call transfer/escalation,
non-VoBiz providers, true WebRTC/SFU, mobile SDK.

> **Reference copy, verbatim below this box.** Origin: magic-voice-core @ `4850d1d9` (v1.123.2), path `docs/voicelink-telephony-implementation-plan.md`. Copied into Magick Agency on 2026-10-09; not kept in sync.
>
> **How this maps to Magick Agency:** How core's VoiceLink adapter was built. Agency's `apps/server/src/telephony/voicelink/` is a port of it; only the WebRTC bridge path is used (no AI call path), on agency's own VoiceLink account.
>
> Index of all copies: [`docs/reference/README.md`](../../README.md).

# VoiceLink Telephony Provider — Implementation Plan

**Status:** Ready to implement. Protocol fully reverse-engineered and verified with a live, answered, bidirectional-audio call on 2026-07-11.
**Author context:** Written for a fresh session to implement end-to-end. Read this whole doc first, then `experiment/FINDINGS.md` (the raw evidence), then the referenced source files.

---

## 0. TL;DR / Executive summary

VoiceLink is an Indian telephony platform (Elision/Dialshree-based) that is **structurally almost identical to our existing `z99` adapter**: a campaign/lead-based outbound dialer that bridges call audio to a WebSocket **we host** and POSTs lifecycle events to a **webhook we host**. Build the `voicelink` provider by **cloning the `z99` package** and adjusting for the differences below.

**The four things that differ from z99 (and matter):**
1. **Audio codec is A-law 8 kHz (`audio/alaw`), FORCED by the carrier.** Our pipeline has mu-law + PCM16 only — **an A-law↔PCM16 codec must be added** to `src/utils/audio.ts`. This is the only genuinely net-new engineering.
2. **Real lifecycle webhook exists** (z99's `parseWebhookEvent` throws). VoiceLink POSTs `call.initiated/ringing/answered/ended/completed` + `call.failed` as JSON to our `webhook_url`. We must implement real webhook routes + `parseWebhookEvent` (model on VoBiz, not z99).
3. **Dispatch = `POST /v1/add_lead`** with the destination split into **`customer_number` (bare national digits) + `country_code` (separate field, no `+`)**. This split is load-bearing — see §1. The adapter's `initiateCall` must split the country code off `req.to`, which **no other adapter does**.
4. **No outbound coalescer needed.** VoiceLink accepts outbound `{event:"media", media:{payload}}` frames as emitted (Twilio/VoBiz-style). Do **not** copy z99's `Z99AudioCoalescer` 8000-byte/500 ms batching.

**Cross-service scope:**
- **core (magic-voice-core):** the real work — new adapter package, config, A-law codec, webhook routes, audio-format wiring, factory/enum, tests.
- **master (magick-master):** **near-zero code.** Register the provider (1 migration or 1 super-admin API call) + add `'voicelink'` to one `ALL_PROVIDERS` enum. Everything else (phone-number→provider assignment, per-tenant allowed providers, call proxying) is already provider-agnostic.
- **cusui (magick-comms-cusui):** **near-zero code.** Providers are fetched from core's `/metadata`. Optional: add a friendly `'voicelink' → 'VoiceLink'` label in ~3 `PROVIDER_LABELS` maps + `ALL_PROVIDERS` UI list. Unmapped providers already render via `?? providerName` fallback.

**Verified working recipe (do not deviate without re-testing):**
```json
POST https://app.voicelink.co.in/api/v1/add_lead
Authorization: Bearer <token from /v1/auth/login>
{
  "did_number":      "919228130625",   // the FROM DID (bare, no +)
  "customer_number": "7978021700",     // callee: BARE national number (no CC, no +, no leading 0)
  "country_code":    "91",             // SEPARATE field, no "+"
  "websocket_url":   "wss://<our-host>/api/v1/media-stream/<callId>",
  "webhook_url":     "https://<our-host>/api/v1/webhooks/voicelink/status/<callId>"
}
```

---

## 1. Reverse-engineered protocol (ground truth)

All of this was captured live; raw artifacts in `experiment/captures/`, analysis in `experiment/FINDINGS.md`. An independent second review (Sonnet) cross-checked and corrected the initial conclusions — notably, an early "carrier SIP-503 provisioning blocker" theory was **wrong**; the real blocker was concatenating the country code into the number.

### 1.1 Auth
- `POST /v1/auth/login` `{username, password}` → `200 { data: { access_token, token_type: "Bearer", user: {...} } }`.
- Laravel-Sanctum-style token (`data.access_token`, equal to `data.user.plain_api_token`). No expiry observed in captures; treat like z99 (refresh on 401).
- **No `businessName` field** (z99 requires it). VoiceLink login is `{username, password}` only.

### 1.2 Dispatch: `POST /v1/add_lead`
- Accepted response: `{ status:true, message:"Lead added successfully", data:{ outbound_queue_id, bot_id, reseller_id, client_id, carrier_id } }`.
- **Gating (each a distinct 400, in order):** (1) DID assigned+active, (2) DID has an active outbound WebSocket-bot **routing rule**, (3) owning client has ≥1 allocated **channel**. These are account-provisioning concerns (done once in the VoiceLink portal / via their API), not per-call.
- **Number format is the critical detail** (matrix proven across ~12 calls):
  | `customer_number` | `country_code` | Result |
  |---|---|---|
  | `918093773107` (CC concatenated) | omitted | ❌ SIP 484 "Invalid number format" |
  | `08093773107` (leading 0) | omitted | ❌ cause 21 "Call Rejected" / SIP 403 |
  | `+918093773107` (E.164) | omitted | ❌ fake answer, duration 0, no ring, phone never rang |
  | **`7978021700` (bare national)** | **`91`** | ✅ real ~23 s ring → answered → 21 s two-way audio |
- **Per-lead `websocket_url` + `webhook_url` are honored** — they come back on the `start` frame / webhook as `customParameters.overrideWsUrl` / `overrideWebhookUrl`, and VoiceLink connects to them. This is how we do per-call correlation (embed our `callId` in both URLs).
  - ⚠️ **OPEN DEFECT (2026-08-03): for a WS-STATIC dispatch, VoiceLink fetches our `websocket_url` as a plain HTTP GET instead of performing a WebSocket upgrade.** The callee answers and hears silence until the carrier gives up (~60 s). Evidence from staging Fastify request logs — the request **does** arrive, ~8 ms after `call.answered`, but with `connection: close` and **no `Upgrade: websocket` header**, so Fastify never upgrades it and the media handler never runs:

    | request | `connection` | `upgrade` | outcome |
    |---|---|---|---|
    | AI call `/api/v1/media-stream/<callId>` | `upgrade` | `websocket` | ✅ media flows |
    | WS-static `/api/v1/static-media-stream/<callId>?token=…` | `close` | *(absent)* | ❌ plain GET, no media |

    The AI leg is dialled against the **bot's** configured `websocket_url` and upgrades correctly; the per-lead static URL is fetched, not upgraded. So the difference is very likely **bot / call-routing configuration** (which endpoint VoiceLink treats as a media-stream target), not URL shape. Next step is a VoiceLink-side question, not a core change.
  - ❌ **A query string is NOT the cause** — an earlier hypothesis, now disproven. Contradicting evidence: the `webhook_url` carries `?token=` on the same dispatch and arrives fine, the WebRTC PSTN leg uses `…/pstn-stream?token=…`, and the static GET above reaches us *with* its query string intact. Core now builds the static media URL with the token in a **path segment** (`src/core/ws-static-media-url.ts`) purely as defence-in-depth — it keeps a live credential out of `req.url` in log storage — and **not** as a fix for the silence.
  - Caveat on the original evidence for per-lead URLs being honored: every capture in `experiment/captures/` sent a per-lead `websocket_url` **identical to the bot's** configured URL (`wss://<host>/media`), so those captures cannot distinguish "VoiceLink dialled our per-lead URL" from "VoiceLink dialled the bot URL and echoed ours back". Treat per-lead URL handling as **only partially verified**: the carrier demonstrably *fetches* a per-lead path, but has not been observed *upgrading* one.

### 1.3 Lifecycle webhook (POST to our `webhook_url`)
- `Content-Type: application/json`, **no signature header** (HTTPS + unguessable-id trust model, same as z99/VoBiz).
- Event sequences:
  - Answered: `call.initiated → call.answered → call.ended → call.completed`
  - Ringing/failed: `call.initiated → call.ringing → call.failed → call.completed`
  - ⚠️ **Also observed in production (contradicts the above and VoiceLink's docs):** `call.initiated → call.ringing → call.ended → call.completed` for a call that was **never answered**. Over 24h on dedicated: 429 `call.ended` vs 206 `call.answered`. So `call.ended` does **not** imply an answer, and a `call.ended` payload carries no `callStatus` — use `answeredAt` (null ⇔ never answered) as the discriminator.
  - `call.completed` is **terminal in both** — read `status`/`callStatus`/`hangupCause` to distinguish success from failure. Do **not** treat `completed` as success.
- Shape: `{ event, timestamp, call: {...}, legs?: [...] }`. Key `call` fields:
  `id, direction, callType(agent|bot), from, to, status, hangupCause, startedAt, ringingAt, answeredAt, endedAt, ringDurationSec, durationSec, sipStatus, callStatus, hangupReason, recordingUrl, customParameters{overrideWsUrl, overrideWebhookUrl, outboundQueueId}`.
  - `legs[]` on `call.completed`: A = carrier leg, B = bot leg. Leg B `channelId` = `bot-<callId>`.
  - `hangupCause:"16"` = Normal Clearing. Observed failure causes: `38`/SIP 503 (network out of order — the 9484 DIDs), `28`/SIP 484 (invalid format), `21`/SIP 403 (call rejected).
  - **No AMD/voicemail fields.**
- **Event → CallEvent mapping** (for `parseWebhookEvent`):
  | VoiceLink event | our `CallEvent` type |
  |---|---|
  | `call.ringing` | `ringing` |
  | `call.answered` | `answer` |
  | `call.ended` / `call.failed` / `call.completed` (terminal) | `hangup` when answered, else `error`. "Answered" = `callStatus`=ANSWER(ED), or — when `callStatus` is absent, as on every `call.ended` — a non-null `answeredAt`. |
  | machine | n/a (no AMD) |
- Persist `recordingUrl` from `call.completed`.

### 1.4 Media WebSocket (VoiceLink → our `websocket_url`)
Twilio/VoBiz-shaped JSON frames. **Confirmed against VoiceLink's own docs** (docs.html#ws-events):
- `connected` (first frame, no payload) — z99 handling never logged this; make sure our route tolerates it.
- `start`: `{event:"start", sequence_number, stream_sid, start:{ stream_sid, call_sid, account_sid, from, to, custom_parameters{...}, media_format:{ encoding:"audio/alaw", sample_rate:"8000" } }}`.
  - ⚠️ **Key-case inconsistency**: `start` uses **snake_case `stream_sid`**; `media`/`stop` use **camelCase `streamSid`**. The shared media-stream route's existing stream-id fallback list already handles both — verify.
- `media` (bidirectional): `{event:"media", media:{ track:"inbound", payload:<base64 alaw>, chunk, timestamp }}`. Inbound = **160 bytes / ~20 ms** = 8 kHz 8-bit A-law.
- `mark` (bidirectional), `clear` (outbound — discard queued audio, our barge-in), `stop` (terminal), `transfer` (`{event:"transfer", target}` — call redirect, future).
- **Outbound frame VoiceLink accepts: `{event:"media", media:{payload:<base64 alaw>}}`** — verified: we echoed 880 frames and they were accepted; sustained 21 s call. **No coalescer.**
- Best practice (their docs): send outbound audio in <2 s segments so `clear` interrupts cleanly.

### 1.5 CDR
- `GET /v1/call-log/details?call_id=<id>` → `{ data: { call_id, unique_id, ..., call_status, call_duration, talk_duration, hangup_reason, bot_type(3=WebSocket Bot), bot_id, recording_url, total_cost, currency_symbol, *_time } }`.
- `recording_url` is a plain https mp3 on a different host (`voiceflowai.elisiontec.com`); fetch auth model TBD (mirror VoBiz recording proxy if we surface it).

---

## 2. CORE service implementation (`magic-voice-core`)

> Closest template throughout: the **`z99` package** (`src/telephony/z99/`) and the **VoBiz webhook** (`src/telephony/vobiz/vobiz.webhook.ts`) for the parts z99 stubbed.

### 2.1 A-law codec — `src/utils/audio.ts` (NET-NEW, do this first)
Core has `decodeMulaw`/`encodeMulaw`/`mulawToTargetPcm`/`pcmToMulaw` but **no A-law**. Add, mirroring the mu-law functions exactly:
- `decodeAlaw(alawData: Buffer): Int16Array`
- `encodeAlaw(pcmData: Int16Array): Buffer`
- `alawToTargetPcm(alawData: Buffer, targetRate: number): Buffer` (decode + resample 8k→target)
- `pcmToAlaw(pcmData: Buffer, sourceRate: number): Buffer` (resample target→8k + encode)

Use the standard G.711 A-law algorithm (256-entry LUTs; implementation is well-known and ~40 lines each way). Add unit tests in `test/unit/utils/audio.test.ts` alongside the mu-law tests: round-trip encode/decode within tolerance, silence (`0xD5` is A-law silence — we saw it in captures), and known sample values.

### 2.2 Audio-format wiring — THE part that's bigger than it looks (line-verified)
> ⚠️ **This is the highest-risk section.** A-law is not just "add one branch." The entire codebase treats telephony audio as a **binary `pcmu`-vs-else(pcm16)** decision. `'pcma'` currently exists in the type union (`src/ai/types.ts:3` `AudioEncoding`, and `MediaStreamConfig.codec` at `src/telephony/types.ts:108` — so **no type widening needed there**) but **NO runtime path handles it** — `'pcma'` silently falls into the pcm16 branch everywhere and would be mis-decoded into garbage. Every consumer below needs an explicit `pcma` arm, or inbound STT and outbound TTS are both broken.

1. **Resolver** — `src/config/ai-pipeline.config.ts:80`: return type is the fixed union `{ encoding: 'pcmu' | 'pcm16'; sampleRate: number }`. **Widen to add `'pcma'`**, and add (`:76-90`): `if (provider === 'voicelink') return { encoding: 'pcma', sampleRate: 8000 };`

2. **Outbound (TTS → carrier)** — `src/core/call-manager.ts` `sendAudioToTelephony`: add a **plain per-frame `voicelink` branch** `{event:'media', media:{payload}}` modeled on the **telnyx** branch (`:1486-1493`), placed **before** the mu-law `else` (`:1494-1502`). A-law-encode via `pcmToAlaw`. Do **not** route through the z99 coalescer branch (`:1434-1449`). Note the binary `isPcm16 = encoding === 'pcm16'` assumption at `:1477`.

3. **Inbound (carrier → STT) — ⚠️ EASY TO MISS.** Each AI pipeline adapter decodes inbound audio in its own `handleAudioIn` with an `if (encoding === 'pcmu') … else treat as pcm16` shape. **If you only patch `sendAudioToTelephony`, inbound STT gets garbage** (A-law bytes read as PCM16). Whichever tier(s) run VoiceLink calls must A-law-decode inbound via `alawToTargetPcm`. Add a `pcma` arm to each adapter that will serve VoiceLink traffic:
   - `src/ai/sarvam-openai/pipeline.adapter.ts:130`
   - `src/ai/sarvam-gemini/pipeline.adapter.ts:115`
   - `src/ai/openai-realtime/realtime.adapter.ts:212,221` (also note `mulawPassthrough` at `:78-79` — there is **no A-law passthrough**; A-law must be decoded to PCM16, never passed through)
   - `src/ai/gemini-live/live.adapter.ts:744`
   - `src/ai/gold-ii/gold-ii.adapter.ts:334,345` (also `mulawPassthrough` `:184-185`)
   - `src/ai/elevenlabs/elevenlabs.adapter.ts:240,251`
   - *(Pragmatic scoping: patch the tier(s) you'll actually pair with VoiceLink first — but any tier not patched will produce broken audio on a VoiceLink call, so gate or patch all six.)*

4. **Silence-nudge fallback** — `src/core/call-manager.ts:1606`: `if (encoding === 'pcmu') … else pcm16`; add a `pcma` arm using `pcmToAlaw`. (And skip the `z99Coalescer?.flush()` at `:1636-1640` — no coalescer for voicelink.)

### 2.3 New adapter package — `src/telephony/voicelink/`
Clone `src/telephony/z99/` and adapt:

**`voicelink.types.ts`** — `VoicelinkConfig { baseUrl, username, password, webhookBaseUrl, defaultCallerId, defaultCountryCode }`. Drop z99's `businessName`/campaign/leadset/`sys_*`/`aiAgentId`/`outboundPrimitive`. Add login/add_lead/webhook/CDR response types from §1.

**`voicelink-token-manager.ts`** — copy `z99-token-manager.ts` almost verbatim (single-flight lazy login, cache, refresh-on-401). Change: login body `{username, password}` (no `businessName`); token at `data.access_token`.

**`voicelink.adapter.ts`** (`implements TelephonyProvider`):
- `name = 'voicelink'`.
- `initiateCall(req)`:
  - Build `websocket_url = wss://<webhookBaseUrl host>/api/v1/media-stream/<req.callId>` and `webhook_url = https://<webhookBaseUrl host>/api/v1/webhooks/voicelink/status/<req.callId>`.
  - **Split the destination**: derive `country_code` + bare `customer_number` from `req.to`. Strategy: strip leading `+`; if it starts with the configured `defaultCountryCode` (e.g. `91`), split that off as `country_code` and the remainder is `customer_number`; strip any leading `0`. Otherwise fall back to `defaultCountryCode` + the number as-is. **This transform is unique to VoiceLink** — document it loudly.
  - `POST /v1/add_lead` with `{ did_number: req.from (bare), customer_number, country_code, websocket_url, webhook_url }` + Bearer token; 401 → refresh once + retry (copy z99's `post()`).
  - Return `{ providerCallId: req.callId }` (live provider id arrives async on the `start` frame; correlate via callId in the URL path, exactly like z99).
- `getMediaStreamConfig()` → `{ type:'websocket', codec:'pcma', sampleRate:8000, direction:'both' }`. `MediaStreamConfig.codec` (`src/telephony/types.ts:108`) already includes `'pcma'` — **no widening needed**. Caveat: this method is **informational only** — nothing consumes it at runtime (see `vobiz.adapter.ts:150-152`). It does NOT wire A-law; the resolver + `audio.ts` + per-adapter `handleAudioIn` (§2.2) are the authoritative path.
- `parseWebhookEvent(rawBody, headers)` — **implement for real** (z99 throws). Map per §1.3. Model on `vobiz.webhook.ts` `parseVobizStatusCallback`.
- `endCall(providerCallId)` — VoiceLink hangup mechanism is **not yet confirmed** (WS command vs REST — the OpenAPI spec has no hangup endpoint). Safe default: no-op that lets the WS `stop`/our socket close end the call (like z99, whose hangup is a WS command from CallManager). **Open item — confirm with VoiceLink or capture.** If WS-command hangup exists, wire it in CallManager like z99's `hangupCall`.
- `generateAnswerResponse` / `generateAnnouncementResponse` → `''` (WS-only, no XML — same as z99).
- `generateIvrResponse` → throw "IVR not supported for voicelink" (same as z99).
- `getCallStatus` → can implement via `GET /v1/call-log/details` (better than z99, which throws).
- `getRecordingUrl(providerCallId)` → fetch CDR, return `recording_url` (VoiceLink documents it; z99 returned null).
- `validateWebhookSignature` → `return true` (no signing scheme; same trust model as z99/VoBiz).

**Do NOT create a `voicelink-audio-coalescer.ts`** — outbound needs no batching (§1.4).

### 2.4 Provider enums — SIX explicit enumerations gate the name (line-verified)
Every one of these enumerates providers explicitly; miss one and the provider is silently rejected or mis-routed. There is **no DB enum** — `telephony_provider` is a free-text `VARCHAR(50)` defaulting to `'plivo'` (`call.repository.ts` + migration `001`), so **no core DB migration needed**.

1. `src/config/schema.ts:174` — `telephonyProviderEnum`. Also add schema key (`:190` `voicelink: voicelinkSchema.default({})`) + `voicelinkSchema` (mirror `z99Schema`: baseUrl, username, password, webhookBaseUrl, defaultCallerId, defaultCountryCode) + a `superRefine` case (`:247-254`) requiring baseUrl/username/password/webhookBaseUrl/defaultCallerId when selected.
2. `src/api/validators/call.validator.ts:43` **and** `:107` — single **and** bulk call-request provider enums. (Both — easy to patch one and miss the other. `:80` is a loose `z.string()`, fine.)
3. `src/telephony/factory.ts:25-26` — construction switch: add `case 'voicelink'` → `new VoicelinkAdapter(...)`.
4. `src/core/webhook-url-builder.ts:27-28` — baseUrl switch. **⚠️ default falls back to Plivo** — a missing case silently mis-routes rather than erroring, so this must be added or webhooks/WS URLs point at the wrong host.
5. `src/api/routes/metadata.routes.ts:52-54` — provider list surfaced to clients (cusui/master). Missing case = provider absent from `/metadata`, no error thrown.
6. **Static/IVR validators DELIBERATELY exclude z99** — `src/api/validators/static-call.validator.ts:23` and `ivr.validator.ts:47` list only `['twilio','plivo','exotel','vobiz','telnyx']`. z99's adapter throws on IVR / returns empty announcement XML, so it's excluded on purpose. **Match that for voicelink** (exclude from static/IVR) unless static/IVR support is explicitly intended.

Env → config mapping (grep `z99` in `src/config/`): `VOICELINK_BASE_URL`, `VOICELINK_USERNAME`, `VOICELINK_PASSWORD`, `VOICELINK_WEBHOOK_BASE_URL`, `VOICELINK_DEFAULT_CALLER_ID`, `VOICELINK_DEFAULT_COUNTRY_CODE`.

### 2.5 CallManager wiring — `src/core/call-manager.ts` (line-verified)
Every `'z99'` reference and what VoiceLink does there:
- **Import (`:18`)**: `Z99AudioCoalescer`. VoiceLink adds **no** coalescer import/branch.
- **Media-connect answer anchor (`:805-819`)**: `if (session.telephonyProvider === 'z99' && !session.answeredAt)` sets `in_progress` because z99 has no answer webhook. VoiceLink **has** `call.answered`, so this branch is **optional** for it — the webhook is the primary anchor. Keep media-connect as an idempotent backstop; either add `voicelink` to this condition (OR / helper) or rely on the webhook. Don't assume media-connect is the only anchor.
- **`sendAudioToTelephony` (`:1434-1449` is the z99 coalescer branch — DO NOT reuse)**: add a plain per-frame `voicelink` branch `{event:'media', media:{payload}}` modeled on **telnyx (`:1486-1493`)**, before the mu-law `else` (`:1494-1502`), A-law-encoded (§2.2).
- **Barge-in `clearAudio` (`:1143-1148`)**: z99 sends `clearAudio` + `z99Coalescer?.discard()`. **VoiceLink's `clear` is UNOBSERVED in our capture** (docs say `{event:'clear', stream_sid}` but we never exercised it). **Do not blindly copy** — either implement per docs and test, or omit (omitting just means no server-side audio flush on barge-in; the pipeline still stops generating). No coalescer to discard either way.
- **Hangup in `forceEndCall` (`:1671-1684`)**: z99 hangup is a WS `hangupCall` command. **VoiceLink hangup is UNOBSERVED** (spec has no endpoint). Preferred: implement REST `endCall()` in the adapter so it falls through to the generic `else if (session.providerCallId)` at `:1685`; OR confirm a WS hangup command and wire it here. Do **not** copy `hangupCall` blindly. This matters — without a working hangup we can't end calls we initiate (max-duration, escalation, forced teardown).
- **Silence-nudge flush (`:1636-1640`)**: skip the `z99Coalescer?.flush()` — no coalescer.
- **`src/core/call-session.ts:6,34,420-421`**: the `z99Coalescer` field + `destroy()` cleanup. VoiceLink needs **no** coalescer field — skip entirely.
- **`src/core/webhook-url-builder.ts:27-28`**: add `case 'voicelink': return config.telephony.voicelink.webhookBaseUrl;` (the default-to-Plivo fallback makes this mandatory).

### 2.6 Webhook routes (real — z99 has none)
Add VoiceLink status webhook route(s), modeled on the VoBiz webhook routes (`src/telephony/vobiz/vobiz.webhook.ts` + wherever VoBiz status routes are registered in `src/api/routes/webhooks*.ts`):
- `POST /api/v1/webhooks/voicelink/status/:callId` — parse body via `adapter.parseWebhookEvent`, route to `CallManager.handleTelephonyEvent(callId, event)`. Unauthenticated (unguessable callId in path), respond `200 {status:true}` fast (VoiceLink expects 200 OK).
- Persist `recording_url` from `call.completed` (mirror VoBiz recording persistence).
- The **media WS** already runs on the shared route `src/api/routes/webhooks.routes.ts:1757-1792` (open→`handleMediaStreamConnected`, message→`handleMediaStreamMessage`, close→`handleMediaStreamClosed`) — no provider awareness, no auth, works for voicelink **unchanged**. Verified line-level:
  - `start` stream-id extraction (`call-manager.ts:1327`): `data.streamSid || data.stream_sid || data.streamId || data.stream_id || data.start?.streamId` — **covers VoiceLink's snake_case `start.stream_sid`**. ✓
  - `connected` first frame is a **no-op** (`:1360-1361`) — tolerated. ✓
  - Inbound `media` handler (`:1307`) reads `data.media.payload` only (no streamSid dependency), so the camelCase `streamSid` on `media`/`stop` frames is a non-issue inbound. Outbound, echo back the streamSid captured from `start`.
  - ⚠️ Media frames are gated on `session?.aiPipeline` being initialized (`:1302`); frames before pipeline init are **silently dropped**. VoiceLink has no answer XML, so the pipeline inits on media-connect (`handleMediaStreamConnected`), same as z99 — fine, but don't expect the very first frames.
  - Minor: the `clear` branch stream-id fallback (`:1356`) omits `streamId`/`start.streamId` — irrelevant to VoiceLink (no inbound clear).

### 2.7 Metadata endpoint
`GET /api/v1/metadata` returns `telephony.providers[]` (cusui + master consume this). Ensure `voicelink` shows up when configured/enabled, with its `default_caller_id`. Find where the providers array is built (grep the metadata route) — it likely enumerates configured providers automatically; confirm `voicelink` is included once config is present.

### 2.8 Tests (core)
- `test/unit/utils/audio.test.ts`: A-law round-trip + known values + silence.
- `test/unit/telephony/voicelink/voicelink.adapter.test.ts`: `initiateCall` builds correct `add_lead` body incl. **the country-code split** (table-test the number-format matrix from §1.2); `parseWebhookEvent` maps every event; 401→refresh→retry.
- `test/unit/telephony/voicelink/voicelink-token-manager.test.ts`: single-flight login, refresh.
- Follow the repo's vitest patterns (`vi.hoisted`, `.js` import extensions — see CLAUDE.md "Testing").

---

## 3. MASTER service (`magick-master`) — near-zero code

Master is **provider-agnostic by design**. Providers are DB rows (`telephony_providers` table), phone numbers FK to a provider (`provider_id` UUID), and per-tenant allowed/default providers are config. Evidence: `src/db/migrations/036_z99_provider.sql` (z99 was added as **just a migration row**), `src/db/repositories/telephony-provider.repository.ts`, `src/api/routes/super-admin-phone.routes.ts` (runtime provider CRUD).

**Required changes (both tiny):**
1. **Register the provider.** Either:
   - Add migration `043_voicelink_provider.sql` (clone `036_z99_provider.sql`): `INSERT INTO telephony_providers (name, display_name) VALUES ('voicelink','VoiceLink') ON CONFLICT (name) DO NOTHING;` — **`name` MUST exactly equal core's enum value `'voicelink'`**. (Next migration number is 043; 042 is the latest.)
   - *or* just call the existing `POST /super-admin/telephony-providers {name:'voicelink', display_name:'VoiceLink'}` at runtime (no deploy). Migration is cleaner for reproducibility.
2. **Add `'voicelink'` to `ALL_PROVIDERS`** in `src/api/validators/service-config.validator.ts` (~line 18-26). This governs the per-tenant `allowed_providers`/`default_provider` config enum. One-line addition.

**No change needed** (verified provider-agnostic):
- `src/proxy/prepare-ai-call.ts` — passes `cfg.telephony_provider` through and validates against the tenant's allowed list; works for any registered provider.
- `phone-number.validator.ts` / `phone-number.repository.ts` — use `provider_id` UUID FK, fully dynamic.
- Billing/settlement — metered by call-type/talk-time (settlement webhooks from core), **not per-provider**. No rate-card change for a new provider.
- Scheduling, bulk dispatch, inbound config — provider-agnostic.
- `webrtc-call.validator.ts` — vobiz-only, irrelevant to AI voice.

**Operational (not code):** create the `voicelink` telephony-provider row, then add VoiceLink DIDs as phone numbers assigned to that provider + to the tenant/account (via existing `super-admin-phone.routes.ts` / `internal-phone-numbers.routes.ts`). This is how a tenant becomes allowed to place VoiceLink calls.

---

## 4. CUSUI front-end (`magick-comms-cusui`) — near-zero code

cusui is the **customer/admin console** (React + Vite). It is **largely provider-agnostic**: telephony providers are fetched at runtime from core's `/api/v1/metadata` via `MetadataContext` (`src/contexts/MetadataContext.tsx` — `providers = metadata.telephony.providers`), and super-admin provider management proxies master's `/super-admin/telephony-providers` (`src/config.ts:250`). Unmapped providers already render via `?? providerName` fallback everywhere.

**Optional polish (nice-to-have, not blocking):**
1. Add `voicelink: 'VoiceLink'` to the `PROVIDER_LABELS` maps in three files (so the UI shows "VoiceLink" not "voicelink"):
   - `src/contexts/MetadataContext.tsx:42`
   - `src/components/settings/ServiceConfigForm.tsx:13`
   - `src/pages/settings/TenantSettingsPage.tsx:38`
2. Add `'voicelink'` to the hardcoded `ALL_PROVIDERS` array in `src/components/settings/ServiceConfigForm.tsx:24` **if** that component is still used to pick providers (a code comment there says providers are now managed via phone-number assignments — verify current behavior; it may be dead/legacy).

**No change needed:** call-initiation, phone-number management, stats, dashboards — all consume provider lists dynamically from metadata/API.

---

## 5. Configuration / env (deployment)

Add to core's env (staging + prod), gated so the provider only activates when configured (mirrors z99):
```
VOICELINK_BASE_URL=https://app.voicelink.co.in/api
VOICELINK_USERNAME=<login username>
VOICELINK_PASSWORD=<login password>              # secret — never log
VOICELINK_WEBHOOK_BASE_URL=https://<core-public-host>/api/v1/webhooks/voicelink
VOICELINK_DEFAULT_CALLER_ID=919228130625         # a known-good 92-series DID
VOICELINK_DEFAULT_COUNTRY_CODE=91
# add 'voicelink' to TELEPHONY_ENABLED_PROVIDERS to validate config at startup
```

VoiceLink-side provisioning (portal or their API — one-time, per FINDINGS §2 gating):
- A DID that is active AND has an **outbound WebSocket-bot routing rule** (`for_outbound_call=3`) pointing at a WebSocket bot whose `websocket_url`/`webhook_url` point at our public host, AND the owning client has **≥1 allocated channel**.
- Note: the WebSocket bot's `audio_format` field is **carrier-forced to `alaw`** regardless of what you set — don't fight it, implement the A-law codec (§2.1).
- **Origination number:** the **92-series DID is known-good**; the **9484-series DIDs returned SIP 503** in testing and were not re-tested after the number-format fix — validate any 9484 DID with a live call before relying on it.

---

## 6. Real-time updates (the webhook requirement)

Real-time call state reaches the platform through **two independent channels**, both already the standard path — no new infrastructure:

1. **Media WebSocket** (`/api/v1/media-stream/:callId`) — the `start`/`media`/`stop` frames drive the live audio session and answer backstop in CallManager. This is the low-latency channel.
2. **Lifecycle webhook** (`POST /api/v1/webhooks/voicelink/status/:callId`, §2.6) — `call.initiated/ringing/answered/ended/failed/completed` → `CallManager.handleTelephonyEvent` → drives state transitions (ringing → in_progress → completed/failed), talk-time anchoring (`markAnswered` on `answer`), recording persistence, and — via the existing end path — the **outbound settlement webhook to master** and any **per-call `webhook_url`** the API caller supplied (`src/webhooks/call-status-webhook.ts`). So a customer integrating via our API gets real-time terminal status exactly as with every other provider.

**Downstream real-time propagation is already built and provider-agnostic** (see CLAUDE.md): `CallManager` emits on `callEventBus`; terminal state fires the per-call status webhook + batch-completion webhook + PostHog analytics + master settlement. Once `handleTelephonyEvent` receives VoiceLink's mapped events, all of that works with zero additional wiring.

**Answer anchoring nuance:** VoiceLink sends a real `call.answered` webhook, so unlike z99 we do **not** need to treat media-connect as the answer signal — but keep the media-connect `markAnswered` backstop (idempotent) for safety. Talk-time (billing) is measured from `answeredAt`, so mapping `call.answered → answer` correctly is billing-critical.

---

## 7. Recommended implementation order

1. **A-law codec** (`src/utils/audio.ts`) + tests — foundational, isolated, no VoiceLink dependency.
2. **Config + enum + factory** (`schema.ts`, `factory.ts`, env) — makes `voicelink` selectable.
3. **Adapter + token manager** (`src/telephony/voicelink/`) — `initiateCall` (with the country-code split) + `parseWebhookEvent`.
4. **Audio-format wiring** (`ai-pipeline.config.ts` + CallManager `'pcma'` branches).
5. **Webhook routes** + CallManager `voicelink` branches (media-connect/clear/hangup).
6. **Metadata** exposure.
7. **master migration + `ALL_PROVIDERS`**; **cusui labels** (optional).
8. **Tests** throughout; then **live verification** (see §8).
9. Provision VoiceLink DID/bot/channel; run an end-to-end call from the platform (not the experiment harness) and confirm: ring → answer → two-way audio → terminal webhook → settlement → recording URL.

---

## 8. Verification & open items

**Verify end-to-end** (the `verify`/`run` skills, or a real call through `POST /api/v1/calls` with `telephony_provider:'voicelink'`):
- add_lead accepted; phone rings; AI pipeline audio is heard both directions (A-law path); `call.answered` anchors talk-time; terminal webhook transitions state; recording URL persisted; settlement fires to master.

**Open items to confirm (don't let them block the build — flag and default safely):**
1. **Hangup mechanism** — WS command vs REST? OpenAPI spec has none. Default: rely on WS close / `stop`. Confirm with VoiceLink; wire a real hangup if one exists (needed to end calls we initiate, e.g. max-duration, escalation).
2. **9484-series DIDs** — SIP 503 in testing; retest with the corrected number format before declaring them usable. The 92-series is the known-good origination number.
3. **Token expiry** — not observed in captures; assume Sanctum tokens can expire and keep the refresh-on-401 path (copied from z99).
4. **Recording fetch auth** — `recording_url` is on `voiceflowai.elisiontec.com`; confirm whether it needs auth headers before surfacing playback (mirror VoBiz recording proxy if so).
5. **`transfer` event** — VoiceLink supports `{event:'transfer', target}` over WS; out of scope for v1 but noted for parity with call-transfer features.

---

## 9. Reference index

**Evidence / this investigation:**
- `experiment/FINDINGS.md` — full reverse-engineered protocol + the number-format matrix + the corrected conclusion.
- `experiment/captures/*.json` — raw webhook/WS/CDR captures (the working call: `T08-19-41-147Z*`).
- `experiment/voicelink-capture.ts` — the harness (auth, add_lead, WS+webhook capture, echo).
- `/Users/manasnilorout/Downloads/document.json` — VoiceLink OpenAPI spec (control-plane; incomplete on runtime — that's why the capture exists).
- VoiceLink docs: `https://app.voicelink.co.in/documentation/docs.html` — esp. `#ws-events` (WS protocol), `#ws-webhook-hangup` (webhook), `#r-number-utilization-guide` (number series/TRAI), `#r-routing`, `#r-faq` (Hangup vs Disconnect Reason).

**Core (magic-voice-core) — clone/adapt these:**
- `src/telephony/z99/` — the template package (adapter, token-manager, types; **skip** the coalescer).
- `src/telephony/vobiz/vobiz.webhook.ts` — model for real `parseWebhookEvent` + status routes.
- `src/telephony/types.ts` — `TelephonyProvider` interface (all methods to implement).
- `src/telephony/factory.ts` — provider registry.
- `src/config/schema.ts` — `z99Schema`, `telephonyProviderEnum`, `superRefine`.
- `src/config/ai-pipeline.config.ts` — `resolveTelephonyAudioFormat` (add `'pcma'`).
- `src/utils/audio.ts` — mu-law codec (template for A-law).
- `src/core/call-manager.ts` — all `'z99'` refs (media-connect, `sendAudioToTelephony`, clear, hangup).
- `src/core/call-session.ts` — z99Coalescer lifecycle (VoiceLink omits).
- `src/core/webhook-url-builder.ts` — per-provider webhook base URL.
- `src/webhooks/call-status-webhook.ts` — per-call real-time status webhook (already provider-agnostic).
- `CLAUDE.md` — architecture, testing conventions, telephony section.

**Master (magick-master):**
- `src/db/migrations/036_z99_provider.sql` — clone → `043_voicelink_provider.sql`.
- `src/db/repositories/telephony-provider.repository.ts`, `src/db/models/telephony-provider.model.ts`.
- `src/api/routes/super-admin-phone.routes.ts` — runtime provider CRUD.
- `src/api/validators/service-config.validator.ts` — `ALL_PROVIDERS` (add `'voicelink'`).
- `src/proxy/prepare-ai-call.ts` — provider passthrough/validation (no change; reference for the flow).

**Cusui (magick-comms-cusui):**
- `src/contexts/MetadataContext.tsx` — dynamic provider list + `PROVIDER_LABELS` (add label).
- `src/components/settings/ServiceConfigForm.tsx` — `PROVIDER_LABELS` + `ALL_PROVIDERS` (add).
- `src/pages/settings/TenantSettingsPage.tsx` — `PROVIDER_LABELS` (add label).
- `src/config.ts:250` — super-admin telephony-provider endpoints (reference).

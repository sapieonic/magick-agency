> **Reference copy, verbatim below this box.** Origin: MagickVoice-platform (superproject) @ `e32a5db` (HEAD, 2026-10-05), path `service-map.md`. Copied into Magick Agency on 2026-10-09; not kept in sync.
>
> **How this maps to Magick Agency:** How core, master and cusui talk to each other. In Magick Agency the master→core hops (`/proxy/*`, `/internal/*`, S2S tokens, per-tenant core API keys) are collapsed into in-process calls (`callCore`, decision B16), and the core→master HMAC webhooks (settlement, analysis completion) are gone. The carrier webhook, the PSTN media socket and the station socket still exist, at the paths in `docs/architecture.md`.
>
> Index of all copies: [`docs/reference/README.md`](../README.md).

# Service map

How the three MagickVoice services actually talk to each other — every transport, every header
transformation, and hop-by-hop traces of the flows that cross a service boundary. This is a
mechanism reference for cross-service work: when a call fails somewhere between the browser and a
carrier, this document tells you which file to open. Everything here was read out of the source
tree, not out of the per-service `CLAUDE.md` files; where the tree contradicts those docs it is
called out inline. The agency dialer's *domain* behaviour is out of scope — see
[`agency.md`](agency.md); only its transport hops appear here.

Ports: cusui Vite `5174`, master `3010` (metrics `9091`), core `3000` (metrics `9090`).

---

## 1. Topology and transports

```
  browser (magick-comms-cusui)
    │
    │  A. apiFetch:  Authorization: Bearer <Firebase ID token>
    │                X-Tenant-Id, X-Account-Id, x-mgkvc-originator
    │  B. saFetch:   Authorization: Bearer <super-admin JWT from sessionStorage>
    │  C. WebSocket upgrades (no headers possible — token in query string, or none)
    ▼
  magick-master :3010
    │
    │  D. /proxy/*   → core /api/v1/*   X-API-Key: <per-tenant core key>
    │                                   x-mgkvc-tenant / -account / -tenant-name / -account-name
    │  E. /internal/* → core /internal/* Authorization: Bearer CORE_S2S_TOKEN
    │  F. WS relay   → core WS          (new ws client per upgrade)
    ▼
  magic-voice-core :3000
    │
    │  G. master /internal/*  Authorization: Bearer MASTER_S2S_TOKEN
    │  H. master /webhooks/core/*  X-Webhook-Signature: HMAC-SHA256(body, secret)
    ▼
  carriers · OpenAI/Gemini realtime · WhatsApp · S3 · SQS
```

Four distinct credential families cross a service boundary. Nothing else does — the two backends
share no database.

### Paired secrets

| Direction | Sender's env var | Receiver's env var | Enforcing code |
|---|---|---|---|
| master → core `/internal/*` | `CORE_S2S_TOKEN` | `INTERNAL_S2S_TOKEN` | `magic-voice-core/src/api/middleware/internal-auth.middleware.ts:14` (constant-time compare, `501` if unset) |
| core → master `/internal/*` | `MASTER_S2S_TOKEN` | must appear in `PLATFORM_S2S_TOKENS` (comma-split) | `magick-master/src/config/index.ts:34`, checked by `verifyS2sToken` in each internal route file (e.g. `magick-master/src/api/routes/s2s-credit.routes.ts:14`) |
| core → master webhooks | `PLATFORM_SETTLEMENT_WEBHOOK_SECRET`, `ANALYSIS_COMPLETION_WEBHOOK_SECRET` | `CORE_WEBHOOK_SECRET` (one value) | `magick-master/src/api/routes/webhook-core.routes.ts:335` |
| master → per-tenant core API key | `ENCRYPTION_KEY` (64 hex chars, `magick-master/src/config/schema.ts:104`) | core's own `api_keys` table | `magick-master/src/proxy/proxy.utils.ts:16` |

Master's `CORE_WEBHOOK_SECRET` is `z.string().min(1)` — **required at boot**
(`magick-master/src/config/schema.ts:155`), so the process refuses to start without it rather than
accepting unsigned settlements. Both of core's webhook secrets must equal that one value; the
analysis dispatcher falls back to the settlement secret when its own is unset
(`magic-voice-core/src/webhooks/analysis-completion-dispatcher.ts:106`).

---

## 2. cusui → master

### apiFetch (customer tree)

`magick-comms-cusui/src/api/client.ts:85`. On every call it mints a fresh Firebase ID token
(`user.getIdToken()`), then sets:

| Header | Value | Set at |
|---|---|---|
| `Authorization` | `Bearer <Firebase ID token>` | `client.ts:105` |
| `X-Tenant-Id` | active tenant uuid | `client.ts:108` |
| `X-Account-Id` | active account uuid (optional) | `client.ts:111` |
| `x-mgkvc-originator` | `<brand.id>-customer-ui`, e.g. `magickvoice-customer-ui` | `client.ts:96`, value from `src/config.ts:13` |
| `Content-Type` | `application/json`, **only when a body is present** | `client.ts:101` |

A `401` clears the local session, signs out of Firebase and hard-redirects to `/login?session=expired`
(`client.ts:131`). `ApiError` reads the correlation id from the `x-request-id` **response header**
first, body `requestId` second (`client.ts:126`), which is what makes masked errors quotable to
support.

`buildAuthHeaders` (`src/api/authHeaders.ts:4`) is the same header set for the raw-`fetch` call sites
(multipart uploads, CSV blobs) that cannot go through `apiFetch`.

### saFetch (super-admin tree)

`magick-comms-cusui/src/api/super-admin.ts:66`. Completely parallel: no Firebase, no tenant headers.
The bearer is a master-issued JWT held in `sessionStorage` under `sa_token`
(`super-admin.ts:19-36`). A `401` clears the token and redirects to `/login?super-admin=true`
(`super-admin.ts:81`). `saFetchRaw` (`:108`) is the blob/header-reading variant. Firebase auth
changes cannot affect this path and vice versa.

### Base URL and the Vite dev proxy

`API_BASE = import.meta.env.VITE_API_BASE_URL || ''` (`src/config.ts:3`), and
`.env.example` sets it to `http://localhost:3010`. So in the normal dev setup **REST calls go
straight to master as absolute URLs and never touch the Vite proxy.** The proxy
(`vite.config.ts:75-92`) declares only three prefixes:

| Vite prefix | Target | `ws: true` |
|---|---|---|
| `/api` | `http://localhost:3010` | yes |
| `/proxy` | `http://localhost:3010` | yes |
| `/super-admin` | `http://localhost:3010` | no |

It matters for the **WebSocket** paths, which are built as relative paths and only get an absolute
scheme+host when `API_BASE` is set (`src/utils/webrtc-ws.ts:48`, `src/hooks/useBrowserCall.ts:85`).
Note there is no `/governance`, `/tenants`, `/credits`, `/threads`, `/contact-lists`,
`/bulk-dispatch-jobs`, `/dnc` or `/phone-numbers` entry — those master-native families only work in
dev because `VITE_API_BASE_URL` is set. If you ever blank it, every non-`/proxy` route 404s against
the Vite server.

Master's CORS allow-list is the binding constraint on what the browser may send:
`Content-Type, Authorization, X-Request-ID, X-Tenant-Id, X-Account-Id, X-Platform-Key,
x-mgkvc-originator` (`magick-master/src/index.ts:281-286`). A new browser-set header needs adding
there or the preflight fails.

### What master does with it

Two preHandlers, added per route plugin (never globally):

1. `sessionMiddleware` (`magick-master/src/auth/session.middleware.ts:43`) — verifies the Firebase
   token, loads the user (Redis `cache:user:fb:<uid>`, 20 min TTL), 401s on unknown user, 403s on
   `status !== 'active'`. Falls back to an `X-Platform-Key` platform API key
   (`session.middleware.ts:86`), cached as `cache:apikey:<sha256>` for 15 min.
2. `tenantContextMiddleware` (`magick-master/src/api/middleware/tenant-context.middleware.ts:91`) —
   reads `x-tenant-id` / `x-account-id`, requires the tenant header (400 without it), resolves the
   caller's membership (Redis `cache:membership:<userId>:<tenantId>`, 30 min), and separately
   verifies **the named account actually belongs to the named tenant**
   (`accountBelongsToTenant`, `:75`) — a tenant-wide membership row satisfies the membership check
   for any account id, so ownership is a second, independent question. A non-uuid `X-Account-Id`
   produces Postgres `22P02` and is mapped to the same 403 as an unknown account (`:40`).
   It also attaches `request.tenantName` / `accountName` (`:208`), which is where the name headers
   forwarded to core come from.

Only after both does `requirePermission(...)` (`magick-master/src/rbac/rbac.middleware.ts:10`) or
`requireCapability(...)` run.

---

## 3. master → core

### The `/proxy/*` route family

Registered in `magick-master/src/index.ts:399-426`. Prefixes, verbatim:

| Registered prefix | Route file | Notes |
|---|---|---|
| `/proxy/calls` | `proxy-calls.routes.ts` | + credit reservation, dispatch orchestration |
| `/proxy/prompts` | `proxy-prompts.routes.ts` | |
| `/proxy/stats` | `proxy-stats.routes.ts` | |
| `/proxy/analytics` | `proxy-analytics.routes.ts` | |
| `/proxy/metadata` | `proxy-metadata.routes.ts` | |
| `/proxy/voices` | `proxy-voices.routes.ts` | |
| `/proxy` | `proxy-ivr.routes.ts` | serves `/ivr-workflows*`, `/ivr-calls*` |
| `/proxy` | `proxy-announcements.routes.ts` | serves `/announcements*`, `/audio-files*`, `/static-calls*` |
| `/proxy` | `proxy-knowledge.routes.ts` | serves `/knowledge-bases*` |
| `/proxy` | `proxy-tts-audio.routes.ts` | serves `/tts-audio/:hash`, HMAC-token gated |
| `/proxy/browser-call` | `proxy-browser-call.routes.ts` | |
| `/proxy/media-stream` | `proxy-media-stream.routes.ts` | **WebSocket** |
| `/proxy/webrtc-call` | `proxy-webrtc-call.routes.ts` | **WebSocket** + control API |
| `/proxy/agency/station` | `proxy-agency-station.routes.ts` | **WebSocket**, registered *before* the sibling agency plugins on purpose (`index.ts:414-417`) |
| `/proxy/agency` | `proxy-agency-agent.routes.ts` | `/sessions*`, `/attempts/*` |
| `/proxy/agency` | `proxy-agency-campaigns.routes.ts` | `/campaigns*`, `/ingest/*` |
| `/proxy/call-analysis-profiles` | `proxy-call-analysis-profiles.routes.ts` | |
| `/proxy` | `proxy-messaging.routes.ts` | serves `/messaging/*` |
| `/proxy` | `proxy-sip.routes.ts` | serves `/sip/connections*` |
| `/proxy/escalation-destinations` | `proxy-escalation.routes.ts` | gated per-verb, not per-plugin |
| `/proxy/platform-tools` | `proxy-platform-tools.routes.ts` | |
| `/proxy/inbound-intents` | `proxy-inbound-intents.routes.ts` | |
| `/proxy/feature-flags` | `proxy-feature-flags.routes.ts` | |
| `/proxy/schedules`, `/proxy/recurring-schedules` | `schedule.routes.ts`, `recurring-schedule.routes.ts` | **conditional** on the scheduler config block (`index.ts:466-473`) |
| `/proxy/automations` | `automation.routes.ts` | master-native despite the `/proxy` prefix |

**Not proxied, despite living beside them in cusui's `ENDPOINTS`:** `/governance`, `/dnc`,
`/threads`, `/contact-lists`, `/bulk-dispatch-jobs`, `/phone-numbers`, `/api-keys`, `/audit-log`,
`/credits`, `/tenants`, `/accounts`, `/users`, `/auth`. These are master-owned data.
`/proxy/automations` and `/proxy/webrtc-call/caller-ids` are the confusing cases — `/proxy`-prefixed
but answered by master from its own tables.

Most proxy routes are one declarative line via `passthrough()`
(`magick-master/src/api/routes/helpers/passthrough.ts:194`), which resolves the core key, forwards,
and returns core's status and body verbatim. It rejects path params containing `/ ? # \`
(`passthrough.ts:127`) — find-my-way hands handlers a percent-*decoded* param, so `%2F..%2F` would
otherwise let a caller aim at a core path their capability gate does not cover. That 400 is returned
**before** any core call, deliberately, so the error mask does not classify it as core-forwarded
(`passthrough.ts:217-236`).

### The per-tenant core API key

`resolveCoreApiKey(tenantId)` (`magick-master/src/proxy/proxy.utils.ts:16`) loads the row from
`tenant_core_credentials`, AES-256-GCM-decrypts it with `config.encryption.key`, and caches the
plaintext in-process for 5 minutes. Missing row ⇒ `CoreApiKeyNotFoundError` (`:56`). A wrong
`ENCRYPTION_KEY` throws inside `decipher.final()` (`magick-master/src/utils/crypto.ts:48`) — an
unhandled 500 that the error mask then rewrites into "contact support", which is why the failure is
opaque.

### Header transformation, exactly

`proxyToCore` (`magick-master/src/proxy/core-client.ts:198`) builds the outbound request to
`${CORE_SERVICE_URL}/api/v1${path}` (`:211`):

| Browser sent | Master sends to core | Where |
|---|---|---|
| `Authorization: Bearer <Firebase>` | *dropped* → `X-API-Key: <decrypted tenant key>` | `core-client.ts:217` |
| `X-Tenant-Id` | `x-mgkvc-tenant` | `core-client.ts:218` |
| `X-Account-Id` | `x-mgkvc-account` (only when present) | `core-client.ts:220` |
| — (resolved server-side) | `x-mgkvc-tenant-name`, `x-mgkvc-account-name`, percent-encoded | `core-client.ts:231` → `src/utils/header-encode.ts:39` |
| `x-mgkvc-originator` | `x-mgkvc-originator`, from the log context | `core-client.ts:224` |
| — | `traceparent` / `tracestate` | `core-client.ts:237` |
| `Content-Type` | set only for POST/PUT/**PATCH** with a body | `core-client.ts:250` |

`X-Request-Id` is **not** forwarded. Cross-hop correlation is the W3C trace id (see §7).

The name headers are percent-encoded because undici rejects multibyte header values, and are emitted
only when *both* the id and the name are present, and only when the log-context id matches the id
being proxied (`core-client.ts:233-235`) — so a name can never be paired with a mismatched id.

`PATCH` is listed in the body-serialising branch (`core-client.ts:250`) and the comment there records
why: omitting a method from that list is silent — core still answers 200 and the write does nothing.

### Core's side

`authMiddleware` (`magic-voice-core/src/api/middleware/auth.middleware.ts:26`) requires, in order:

1. `x-mgkvc-tenant` non-empty — else **400** (`:29`).
2. `x-mgkvc-account` non-empty — else **400** (`:38`). Not optional, unlike master's side.
3. `X-API-Key` matching a row in `api_keys` for that tenant (SHA-256 + tenant, in-process cached),
   or a legacy `API_KEYS` env entry — else **401** (`:61-105`).

Header constants live in `magic-voice-core/src/api/middleware/headers.ts:9-15`.

**Auth is registered per route plugin, not globally.** Each authenticated route file does
`app.addHook('preHandler', authMiddleware)` (e.g. `calls.routes.ts:60`), and the files with no such
hook are genuinely unauthenticated:

- `browser-call.routes.ts` — the route's own comment says so
  (`magic-voice-core/src/api/routes/browser-call.routes.ts:57-60`); `tenant_id` is read from the
  **body** and defaults to the literal `'browser-test'` (`:44`).
- `webhooks.routes.ts` (carrier callbacks; provider-signature gated), `recordings.routes.ts` /
  `webrtc-recordings.routes.ts` / `tts-audio.routes.ts` (signed-URL gated),
  `metadata.routes.ts`, `health.routes.ts`, the WhatsApp/Telegram/GreenAPI/Resend webhook files.

`agency.routes.ts:577` carries the durable warning: *"core registers auth per route-plugin rather
than globally, and MAG-89 already shipped an unauthenticated endpoint on this very feature by landing
a route outside it."* When you add a core route, check which `register` scope it lands in.

### `/internal/*` (master → core)

`coreInternalRequest` (`magick-master/src/proxy/core-client.ts:121`) →
`${CORE_SERVICE_URL}/internal${path}` with `Authorization: Bearer CORE_S2S_TOKEN` and injected trace
context. No tenant headers — tenant/account ride in the query string or body. Core registers
`internalRoutes` at `/internal` (`magic-voice-core/src/index.ts:509`) with
`internalAuthMiddleware` as the plugin-wide preHandler
(`magic-voice-core/src/api/routes/internal.routes.ts:153`), plus two more `/internal` plugins:
`agencyInternalRoutes` (`index.ts:480`) and `agencyDncRoutes` (`index.ts:485`).

Master's callers: `super-admin*.routes.ts` (concurrency, feature-flag overrides, SIP summary, alerts,
usage), `src/dnc/dnc-sync.client.ts:87`, `src/agency/agency-roster.client.ts:372,510`, and
`createCoreApiKey` / `revokeCoreApiKey` (`core-client.ts:56,81`) which hit
`/internal/api-keys` at tenant provisioning time.

---

## 4. core → master

### `/internal/*` with `MASTER_S2S_TOKEN`

`magic-voice-core/src/clients/master-client.ts` is the whole client for the phone-number lane:

- `POST ${MASTER_SERVICE_URL}/internal/phone-numbers/validate` (`master-client.ts:38`)
- `GET  ${MASTER_SERVICE_URL}/internal/phone-numbers/caller-ids?...` (`master-client.ts:70`)

Both send `Authorization: Bearer MASTER_S2S_TOKEN`, 5 s timeout, and **fail closed**: any transport
error or non-2xx throws `MasterUnavailableError` (`:9`). Master answers at
`internal-phone-numbers.routes.ts:49,60`, gated by `verifyS2sToken` against `PLATFORM_S2S_TOKENS`
(`:11`, `:44`).

The agency DNC lane goes the same way: core `POST /internal/agency/dnc`
(`magic-voice-core/src/agency/dnc-mark.ts:335`) and `POST /internal/agency/dnc-resync`
(`magic-voice-core/src/agency/dnc-resync.ts:163`), answered at
`magick-master/src/api/routes/internal-agency.routes.ts:224,344`. The reverse direction of the same
feature is master → core `POST /internal/agency/dnc-sync`
(`magick-master/src/dnc/dnc-sync.client.ts:80-92` → `magic-voice-core/src/api/routes/agency-dnc.routes.ts:146`).

Master also exposes `/s2s/credits/*` (`index.ts:385`) and `/internal/maintenance`,
`/internal/scheduler` on the same token family.

### HMAC-signed webhooks

Sender: `dispatchWebhook` (`magic-voice-core/src/webhooks/dispatch-webhook.ts:60`).

```
POST <url>
Content-Type: application/json
User-Agent: VoiceAI-Orchestrator/1.0
X-Webhook-Signature: <hex HMAC-SHA256 of the exact JSON body>
```

Signing: `createHmac('sha256', secret).update(body).digest('hex')`
(`magic-voice-core/src/utils/crypto.ts:94`). Retries: `withRetry({ maxRetries, baseDelayMs: 1000 })`
— the loop is `attempt <= maxRetries`, i.e. **4 attempts** at the default 3, then it logs and drops
permanently (`dispatch-webhook.ts:86-119`). **No trace context is injected on this path** — unlike
`proxyToCore`/`coreInternalRequest`, `dispatchWebhook` never calls `propagation.inject`, so a
settlement is a separate trace from the call that produced it.

Receiver: `webhookCoreRoutes` at prefix `/webhooks/core` (`magick-master/src/index.ts:431`). Its
plugin-wide preHandler (`webhook-core.routes.ts:335`):

1. `503` if `CORE_WEBHOOK_SECRET` is absent — fail closed, and recorded on
   `webhookRequestsTotal{webhook_type="unconfigured"}` so it is alertable (`:347`).
2. `401` if `x-webhook-signature` is missing (`:354`).
3. `401` if `verifySignature(JSON.stringify(request.body), secret, signature)` fails (`:360`).
   Note the argument order differs between repos — core is
   `verifySignature(payload, signature, secret)` (`magic-voice-core/src/utils/crypto.ts:98`), master
   is `verifySignature(payload, secret, signature)` (`magick-master/src/utils/crypto.ts:9`).
   **Master re-serialises the parsed body to verify**, so the signature holds only while
   `JSON.stringify(JSON.parse(x)) === x` for core's payloads.

Endpoints, and the core dispatcher that targets each:

| Master route | `SettlementCallType` / event | Core dispatcher |
|---|---|---|
| `POST /webhooks/core/call-completed` (`:370`) | `voice_call` | `dispatchSettlement` (`settlement-dispatcher.ts:213`) |
| `POST /webhooks/core/ivr-completed` (`:522`) | `ivr` | same |
| `POST /webhooks/core/static-completed` (`:641`) | `static` | same |
| `POST /webhooks/core/webrtc-completed` (`:816`) | `webrtc_call` | same |
| `POST /webhooks/core/dialer-analysis-completed` (`:1074`) | `dialer_analysis` | `dispatchDialerAnalysisSettlement` (`:274`) — **throws on non-2xx** |
| `POST /webhooks/core/agency-attempts-completed` (`:930`) | `agency_dial_attempt` | `dispatchAgencyAttemptBatchSettlement` (`:317`) — throws; no retry sweep |
| `POST /webhooks/core/analysis-completed` (`:717`) | `analysis.completed` | `dispatchAnalysisCompletion` (`analysis-completion-dispatcher.ts:83`) |
| `POST /webhooks/core/completed` (`:1179`), `/batch-completed` (`:1395`) | unified / batch | `batch-completion-dispatcher.ts` |

**How core picks the URL.** Only `PLATFORM_SETTLEMENT_WEBHOOK_URL` is configured — pointing at
`.../webhooks/core/call-completed`. Every sibling endpoint is derived by swapping the last path
segment (`resolveSettlementUrl`, `settlement-dispatcher.ts:176`, map at `:162-174`). The analysis
webhook does the same swap to `/analysis-completed` when `ANALYSIS_COMPLETION_WEBHOOK_URL` is unset
(`analysis-completion-dispatcher.ts:85-89`). Consequence: **one wrong path segment in that single
env var silently breaks every settlement lane at once**, and
`warnIfSettlementUnconfigured()` (`settlement-dispatcher.ts:189`) is the only boot-time signal that
nothing will ever be billed.

---

## 5. Scenario walkthroughs

### 5.1 Plain authenticated read — list AI calls

```
1 browser  useCalls → listCalls → apiFetch(GET /proxy/calls?limit=20)
          magick-comms-cusui/src/api/client.ts:85
          Headers: Bearer <Firebase>, X-Tenant-Id, X-Account-Id, x-mgkvc-originator
2 master   onRequest  enterLogContext                    index.ts:309
           preHandler requestIdMiddleware  → reply X-Request-Id
           preHandler sessionMiddleware    → request.user           auth/session.middleware.ts:43
           preHandler tenantContextMiddleware → tenantId/accountId/
                        tenantName/accountName/membership           tenant-context.middleware.ts:91
           preHandler requirePermission('proxy.calls.read')         rbac/rbac.middleware.ts:10
3 master   handler  proxy-calls.routes.ts:548
           resolveCoreApiKey(tenantId)                              proxy/proxy.utils.ts:16
           query.tenant_id = tenantId   (stamped, not trusted from the client)
           proxyToCore({ method:'GET', path:'/calls', query, ... }) proxy/core-client.ts:198
4 core     GET /api/v1/calls  authMiddleware                        api/middleware/auth.middleware.ts:26
           X-API-Key + x-mgkvc-tenant + x-mgkvc-account required
5 core     handler → Postgres → 200 { calls, total, limit, offset }
6 master   reply.code(result.status).send(result.body)              (verbatim)
           onSend errorMaskHook — no-op for 2xx                     error-mask.middleware.ts:285
7 browser  res.json()
```

Failure at each hop:

| Hop | Symptom | First thing to check |
|---|---|---|
| 2 sessionMiddleware | `401 Invalid or expired token` | Firebase project id match between cusui `VITE_FIREBASE_*` and master's service account |
| 2 tenantContext | `400 X-Tenant-Id header is required` / `403 You are not a member of this tenant` / `403 X-Account-Id does not belong to this tenant` | which of the three messages; the third means the account/tenant pair is genuinely wrong or the header is a non-uuid |
| 2 RBAC | `403 Insufficient permissions. Required: proxy.calls.read` | `membership.role` vs `magick-master/src/rbac/roles.ts` |
| 3 key resolve | `500` masked to "contact support" | master log line from `proxy-utils`; `CoreApiKeyNotFoundError` (tenant unprovisioned) vs a decipher throw (wrong `ENCRYPTION_KEY`) |
| 4 core auth | core returns `400 Missing required header: x-mgkvc-account` | master had no `accountId` — the browser omitted `X-Account-Id`; core requires it, master does not |
| 4 core auth | core returns `401` | the decrypted key is stale/revoked in core's `api_keys` |
| 5 core handler | 5xx forwarded, then masked | master's `proxyRequestsTotal{status}` and the core-side trace under the same trace id |

### 5.2 Outbound AI call, placed through to settlement

```
── Placement (synchronous) ────────────────────────────────────────────────────
1 browser  POST /proxy/calls  (or /proxy/calls/bulk)
2 master   session + tenantContext + RBAC (proxy.calls.create)
           governance pre-flight; escalation capability off ⇒ escalation_number
             STRIPPED, not blocked            proxy-calls.routes.ts:73-104
           resolveCallerPhoneNumber(...)      proxy/phone-number-resolver.ts
           creditService.reserveCredits(tenant,'voice_call',minutes,account)
           creditReservationRepository.create(...)
           proxyToCore POST /calls
3 core     authMiddleware → calls.routes.ts → CallManager → carrier
4 master   core >=400 ⇒ releaseCredits + markSettled('released')
           core  <400 ⇒ setResourceId(reservationId, core call_id)
5 browser  202/201 with call_id

── Settlement (asynchronous, minutes later) ───────────────────────────────────
6 core     terminal transition in CallManager (e.g. call-manager.ts:2491, :2878,
           :3615, :4060, :4125; also call-queue-coordinator.ts, ivr/engine.ts,
           webhooks.routes.ts for carrier-driven ends)
           dispatchSettlement({ call_id, tenant_id, account_id, status,
             talk_time_seconds, call_type:'voice_call', callee, variables,
             kb_search_count/credits, error_code/error_message, ... })
                                              webhooks/settlement-dispatcher.ts:213
7 core     resolveSettlementUrl(base,'voice_call') → base unchanged   :165
           dispatchWebhook → X-Webhook-Signature, 4 attempts, then DROPPED
                                              webhooks/dispatch-webhook.ts:60
8 master   POST /webhooks/core/call-completed
           preHandler: secret present? signature present? HMAC valid?
                                              webhook-core.routes.ts:335
9 master   handler :370
           settlementService.settleCall({...})            ← the credit debit
           if payload.ivr_session_id → recordIvrContinuation (thread rows first)
           foldThreadCompletionSnapshot(...)              ← thread rollup
           scheduleContactRepository.findByExternalRefId(call_id)
             → completeContact + decrementPendingCount
             → RetryManager.handleBatchCompletion when the batch hits 0
           buildBaseContext(...) → workflowDispatcher.onEvent('call.completed')
           200 { settled, call_id }
```

Notes that matter:

- `dispatchSettlement` **swallows** its errors (`settlement-dispatcher.ts:252`); the analysis and
  agency-batch dispatchers **throw** so their callers can retry. Only
  `dialer-analysis-completed` has a durable redelivery sweep.
- Master returning 5xx here is deliberate for the agency batch — a premature 2xx would burn the
  `batch_reference` and lose the revenue (the reasoning is recorded at
  `webhook-core.routes.ts:264-334`).
- `status` vs `outcome`: the settlement payload carries both (`settlement-dispatcher.ts:37-154`).
  Master's abandoned-attempt zero-charge keys on the **outcome**; keying it on `status` silently
  billed every abandoned agency attempt at the full rate. Do not conflate them.
- Reservation leak signature: if the webhook never arrives (bad URL, wrong secret, 4 failed
  attempts), the reservation stays `pending` until Redis TTL reclaims it, the balance looks lower
  than the ledger, and nothing errors.

### 5.3 Browser AI call — the token-less media WebSocket

```
1 browser  useBrowserCall.start → startBrowserCall()
           POST /proxy/browser-call/start   { prompt_template_id, ai_pipeline, ... }
                                            src/api/browser-call.ts:41
2 master   proxy-browser-call.routes.ts:32
           allowed-pipeline check (tenant/account settings)
           creditService.reserveCredits(tenant,'voice_call',5,account)   :52
           proxyToCore POST /browser-call/start                          :71
3 core     browser-call.routes.ts:41  — NO authMiddleware on this plugin
           createBrowserCallSession(...) → status 'in_progress'
           ws_url = ws(s)://<request.headers.host>/api/v1/media-stream/<callId>  :110
4 master   core 4xx ⇒ releaseCredits; core 2xx ⇒ setResourceId(call_id)
           REWRITE: ws_url.match(/\/media-stream\/([^/?]+)/)
                    → ws_url = `/proxy/media-stream/${callId}`           :92-101
5 browser  useBrowserCall.ts:75-93 — take the path, prepend
           wss://<API_BASE host> (or window.location.host), new WebSocket(url)
6 master   GET /proxy/media-stream/:callId  { websocket: true }
           proxy-media-stream.routes.ts:18 — NO auth hooks at all
           coreWsUrl = CORE_SERVICE_URL with http→ws + /api/v1/media-stream/:callId
           new WsWebSocket(coreWsUrl); disableNagle on both legs
           bidirectional verbatim relay; close/error tear down the other leg
7 core     GET /api/v1/media-stream/:callId  { websocket: true }
           webhooks.routes.ts:2436 — no auth, no token
           callManager.handleMediaStreamConnected(callId, socket)
```

The **entire WS path is credential-free**. The only gate is that `callId` must name a live session
in core's `CallManager`; the authenticated hop was step 2, moments earlier, and the socket lives for
one call. The rewrite at step 4 is a regex on `/media-stream/<id>` and **drops any query string** —
correct here (there is no token), and the reason the WebRTC and station rewrites are separate
functions.

Note step 3: core reads `tenant_id`/`account_id` from the **request body**, defaulting to
`'browser-test'`/`'default'` (`browser-call.routes.ts:44-45`), and cusui's `BrowserCallStartInput`
(`src/api/browser-call.ts:17`) sends neither. So the call row core creates is attributed to tenant
`browser-test` while master reserved credits against the real tenant. Flagged as observed, not
fixed — see §8.

### 5.4 WebRTC dialer — token-gated media WebSocket

```
1 browser  useWebRtcCall → POST /proxy/webrtc-call  { to, caller_id, ... }
2 master   proxy-webrtc-call.routes.ts — authenticated child plugin
           preHandler: sessionMiddleware, tenantContextMiddleware,
                       requireCapability('calls.dialer')                :118-124
           (post-paid: NO credit reservation — settled by webrtc-completed)
           proxyToCore POST /webrtc-call
3 core     webrtc-call.routes.ts:122 authenticated scope
           bridge.createCall(...) mints a token                          :208
           browser_ws_url = wss://<host>/api/v1/webrtc-call/<id>/browser-stream?token=<t>  :225
           response also carries `token` separately
4 master   rewriteBrowserWsUrl(browser_ws_url)                           :29-42, applied :177
           new URL(...) → `${pathname}${search}`,
           then /^\/api\/v1\/webrtc-call/ → /proxy/webrtc-call
           ⇒ /proxy/webrtc-call/<id>/browser-stream?token=<t>
           falls back to the original string if the shape is unexpected
5 browser  buildWsUrl(browser_ws_url, token)   src/utils/webrtc-ws.ts:12
           splits path+query, appends ?token=/&token= only if absent,
           prepends wss://<API_BASE host>
6 master   GET /proxy/webrtc-call/:id/browser-stream  { websocket: true }
           registered at the PLUGIN ROOT, outside the authenticated child  :66
           coreWsUrl = <core ws>/api/v1/webrtc-call/<id>/browser-stream?token=<enc>  :74
7 core     webrtc-call.routes.ts:86 → bridge.attachBrowserLeg(id, socket, token)
           core is the sole authority on the token
```

The query string surviving the rewrite is the whole point: the token cannot ride in a header,
because a browser `WebSocket` cannot set one. `rewriteBrowserWsUrl` and `buildWsUrl` are both
exported pure functions precisely so this contract is unit-testable on either side. Core also has a
sibling `/:id/pstn-stream` leg (`webrtc-call.routes.ts:104`) that master does not proxy — the
carrier connects to core directly.

### 5.5 Agency station socket — the third WS path

Transport-level differences from the two above (`magick-master/src/api/routes/proxy-agency-station.routes.ts`,
domain behaviour in `agency.md`):

| | `/proxy/media-stream/:callId` | `/proxy/webrtc-call/:id/browser-stream` | `/proxy/agency/station/:sessionId` |
|---|---|---|---|
| Token | none | required by core, relayed | **required by master**: tokenless upgrade closed with `4401` before any upstream connect (`:110-114`) |
| Lifetime | one call | one call | one agent shift |
| Close codes | discarded, bare `close()` | discarded | **propagated both ways** with code + reason (`:184`, `:194`) |
| Pre-open frames | dropped | dropped | **buffered**, max 64 (`:145-147`) — a dropped reconnect `ping` would look like a dead agent |
| Frame handling | verbatim | verbatim | verbatim, and the frame set is explicitly open-ended (`:39-46`) |

Master originates `4401 MISSING_TOKEN` and `4502 UPSTREAM_UNAVAILABLE` (`:69-74`) and relays core's
`4404` / `4409`. Master is **not** the authenticator here and the file says so at length
(`:20-38`) — core mints a single-use ~2-minute token and decides. URL rewrite:
`rewriteStationWsUrl` (`:86`) maps `/api/v1/agency/station` → `/proxy/agency/station` preserving
query, applied at both `POST /proxy/agency/sessions` (bootstrap,
`proxy-agency-agent.routes.ts:190`) and `POST /proxy/agency/sessions/:id/station-token`
(re-mint, `:267`). Core builds the original at
`magic-voice-core/src/api/routes/agency.routes.ts:131,156` and registers the socket **outside** the
authenticated scope at `:71`. cusui re-mints on every reconnect
(`src/hooks/useAgencyStation.ts:851-871`).

### 5.6 Analysis completion — async result surfaced to the browser

```
1 core   post-call-analysis-runner.ts:126  (or dialer-analysis-runner.ts:260)
         analysis persisted on the call row first
         dispatchAnalysisCompletion({ event:'analysis.completed', call_id,
           tenant_id, account_id, timestamp, status, talk_time_seconds,
           started_at, ended_at, analysis:{ sentiment, dimensions },
           callee, variables, direction, inbound_to,
           attached_automation_ids, ivr_session_id })
                                    webhooks/analysis-completion-dispatcher.ts:83
2 core   url = ANALYSIS_COMPLETION_WEBHOOK_URL
            ?? swap last segment of PLATFORM_SETTLEMENT_WEBHOOK_URL
               → /analysis-completed                                    :85-89
         secret = ANALYSIS_COMPLETION_WEBHOOK_SECRET
            ?? PLATFORM_SETTLEMENT_WEBHOOK_SECRET                       :106
         dispatchWebhook (HMAC, 4 attempts, then dropped; errors swallowed)
3 master POST /webhooks/core/analysis-completed — shared HMAC preHandler
4 master handler webhook-core.routes.ts:717
         buildBaseContext(...) + withAnalysis(sentiment, dimensions)
         workflowDispatcher.onEvent({ trigger:'analysis.ready', ... })
         conversationThreadRepository.applyWebhookSnapshot(sentiment, occurred_at)
         ensureInboundBindings(...) when direction === 'inbound'
         200 { ok:true, call_id }
5 browser NO push. The analysis text/dimensions live on core's call row and
         reach the UI on the next GET /proxy/calls/:id
         (magick-master/src/api/routes/proxy-calls.routes.ts:641).
         What master persists is the thread snapshot and the automation run,
         read via /threads/:id/timeline and the automations pages.
```

There is no server→browser push for analysis. If a user says "the summary never appeared", the
question is whether core persisted it (core-side, independent of the webhook) or whether the
*automation* did not fire (webhook-side). Those are two different investigations.

### 5.7 Super-admin — the parallel tree

```
1 browser POST /super-admin/login   (saFetch, no token yet)
          → { token }; setToken() → sessionStorage['sa_token']
                                    magick-comms-cusui/src/api/super-admin.ts:26
2 browser every later call: saFetch → Authorization: Bearer <sa JWT>
          NO X-Tenant-Id, NO X-Account-Id, no Firebase involvement    :66-77
3 master  super-admin plugins registered ONLY when the super-admin config block
          parses                              magick-master/src/index.ts:451-458
          authenticated child: superAdminMiddleware                    :144
          auth/super-admin.middleware.ts:25 — jwt.verify(HS, superAdmin.jwtSecret),
          payload.type must be 'super_admin', admin row must be status 'active';
          503 when the secret is unconfigured
4 master  e.g. GET /super-admin/tenants/:id/accounts
          per account: coreInternalRequest({ path:'/account-concurrency',
            query:{ tenant_id, account_id } })   super-admin.routes.ts:964
          chunked 10 at a time; a failure degrades to
          concurrency_status:'unavailable' rather than failing the page
5 core    GET /internal/account-concurrency
          internalAuthMiddleware (Bearer INTERNAL_S2S_TOKEN)
                                    api/routes/internal.routes.ts:153, route :160
          providerConcurrencyRepository.getAllocation(tenant, account)
```

The super-admin lane reaches core over `/internal/*` with the S2S token — **never** with a
per-tenant API key — which is why concurrency is writable there
(`PUT /internal/account-concurrency`, `internal.routes.ts:212`) and not from any `/proxy/*` route.
Other super-admin → core internal lanes: feature-flag catalog/overrides
(`internal.routes.ts:440-660`), `sip-connections/summary` (`:909`), usage export (`:802-865`),
alerts (`:1071-1400`), inbound intents (`:922-1071`). Note `/super-admin` has no `ws: true` in the
Vite proxy — the super-admin console has no WebSocket surface.

### 5.8 Governance vs feature flags — two channels, opposite failure modes

```
Capabilities (master-native, no core hop)
  browser  GET /governance/effective          (X-Tenant-Id / X-Account-Id only)
  master   governance.routes.ts:21 — session + tenantContext, NO requirePermission:
           any active member may read their own effective map
           governanceService.getEffective(tenantId, accountId)
           → { governance: { 'calls.dialer': true, ... } }
  browser  GovernanceContext caches per (tenant, account);
           isEnabled = map[cap] !== false        contexts/GovernanceContext.tsx:73
           RequireCapability renders children when the map is empty/failed
           → FAILS OPEN, because master's 403 is the real gate
                                   components/auth/RequireCapability.tsx:38-45

Feature flags (core-sourced)
  browser  GET /proxy/feature-flags
  master   proxy-feature-flags.routes.ts:19 — session + tenantContext, then
           passthrough → core GET /api/v1/feature-flags,
           permission 'proxy.stats.read', deliberately uncached
  core     feature-flags.routes.ts:12 authMiddleware, then
           resolveClientExposed({ tenantId, accountId }) — only flags marked
           clientExposed reach the browser; no write verb exists on this route
  browser  FeatureFlagsContext: isEnabled = status === 'ready' && flags[f] === true
           on error: setFlags({}), status 'error'
           → FAILS CLOSED             contexts/FeatureFlagsContext.tsx:92-104
```

Client-exposed flag keys, verified in `magic-voice-core/src/feature-flags/registry.ts`:
`whatsapp_personal` (:137), `whatsapp_media` (:148), `webrtc_calls_enabled` (:187), `custom_sip`
(:211), `knowledge_bases_enabled` (:241), `gold_ii` (:309), `dialer_call_analysis` (:321),
`ai_call_transfer` (:348), `agency_dialer_enabled` (:387). Everything else in that registry is
internal and never enumerable from the browser.

Master's enforcement side is `requireCapability(key)`
(`magick-master/src/governance/require-capability.ts:18`): **fails closed** on any resolve error or
missing tenant context, uses `gov[key] === false` so an unknown key is never blocked, and is inert
when `GOVERNANCE_ENABLED` is off. `assertCapability` (`:45`) is the in-handler variant for gates
that depend on body-resolved values (e.g. messaging provider → `PROVIDER_CAPABILITY`, `:68`).

The asymmetry is intentional and worth internalising: **capabilities fail open in the browser and
closed in master; flags fail closed in the browser.** A user reporting "the page loads but every
action 403s" is a capability; "the nav item is missing" is a flag or a failed flag fetch.

---

## 6. Failure semantics

**Master fails closed on core.** `proxyToCore` rethrows transport errors after recording
`proxyRequestsTotal{status="error"}` (`core-client.ts:279-287`); Fastify's error handler turns that
into a 500 which the mask rewrites. Core's own client toward master does the same in reverse —
`MasterUnavailableError` on any non-2xx or timeout (`magic-voice-core/src/clients/master-client.ts:9`).

**The error mask.** `errorMaskHook`, an `onSend` hook registered globally at
`magick-master/src/index.ts:372` (implementation `src/api/middleware/error-mask.middleware.ts:279`):

| Status | Behaviour |
|---|---|
| `< 400` | untouched (`:285`) |
| `/health`, `/ready`, `/metrics` | exempt (`:286`, set at `:21`) |
| `request.preserveReviewedUpstreamError === true` | untouched (`:287`) |
| `429` | always passed through — these are authored pacing signals carrying `retryAfter` (`:289`) |
| `>= 500` | always masked (`:292`) |
| `4xx` **and** a core call recorded that same status this request | masked **unless** `isStructuredClientError` (`:294-304`) |
| `4xx` master generated itself | passed through (`:306`) |

`isStructuredClientError` (`:216`) forwards a body with `details != null`, or with a `code` in
`FORWARDABLE_ERROR_CODES` (`:69` — the media/audio/slug/agency sets, plus spreads of
`AGENCY_ACTION_ERROR_CODES` and `AGENCY_ROSTER_REFUSAL_CODES`), or with an `error` label in
`FORWARDABLE_ERROR_LABELS` (`:192` — only `Feature Not Enabled`). Everything else from core is
replaced by `maskedErrorBody(requestId, statusCode)` (`:39`) and the original is logged at
error/warn with the request id.

Detection is via `AsyncLocalStorage`: `recordCoreErrorStatus(status)` on every core response
`>= 400` (`core-client.ts:264`, `:165`) and `sawCoreErrorStatus(status)` in the hook
(`magick-master/src/utils/log-context.ts:111,122`). **Two invariants this creates:**

1. A route's own 4xx must be returned **before** any core call that records that same status —
   otherwise the mask reads the route's own error as core-forwarded and hides it. This is why
   `passthrough` resolves its path before touching the core key (`passthrough.ts:217-220`).
2. A best-effort core call whose failure the route swallows must pass `recordCoreErrors: false`
   (`core-client.ts:32`), or its recorded status will mask the route's own later 4xx.

**cusui fails open on capabilities** (`RequireCapability.tsx:38-45`) — deliberate, because master's
403 is the real enforcement and a failed governance fetch should not lock a user out of a feature
they have.

**A wrong `ENCRYPTION_KEY` breaks every `/proxy/*` opaquely.** `decryptAes256Gcm` throws inside
`decipher.final()` (`magick-master/src/utils/crypto.ts:48`), from `resolveCoreApiKey`
(`proxy.utils.ts:30`) — a preHandler-adjacent 500, masked to "contact support and quote this
request ID". `ENCRYPTION_KEY` is `z.string().length(64)` (`schema.ts:104`) so a *malformed* key
fails at boot; a *wrong-but-well-formed* key boots fine and fails on every proxied request.

### Triage order by hop

| Failing hop | Look at first |
|---|---|
| browser → master | Browser network tab: is `Authorization` present? Is `X-Tenant-Id` present? Is the header in master's CORS allow-list (`index.ts:281`)? |
| master auth/tenant | Master's `authAttemptsTotal{method,status}` and the exact 401/403 message string — each branch has a distinct one |
| master → core key | Master log, `component: 'proxy-utils'`. `CoreApiKeyNotFoundError` ⇒ provisioning; a cipher error ⇒ `ENCRYPTION_KEY` |
| master → core HTTP | `proxyRequestsTotal{method,path,status}` and the `proxy <METHOD> <path>` span. `status="error"` means the fetch itself failed |
| core auth | Core log `component: 'auth-middleware'` + `authAttemptsTotal`. A 400 names the missing header |
| masked error | Grep master's logs for the `requestId` from the response body — the unredacted original is there |
| WS never opens | Which of the three paths? Then: master's `*-proxy` log line, and whether the token survived the rewrite |
| settlement missing | Core: **`settlement_dispatch_total{call_type,result}`** first — `webhooksDispatchedTotal{status}` carries no settlement discriminator, so a lost settlement is indistinguishable in it from a customer's own endpoint being down, which is why 190 dropped releases were found by log archaeology (`86d41v0n0`). `result="failed"` means retries are exhausted and it is GONE; `result="unconfigured"` means `PLATFORM_SETTLEMENT_WEBHOOK_URL` is unset on that replica. For a BULK cancellation add `webhook_fanout_pending` (backlog; the fleet sum on the dashboard, per-replica `max()` on the alert) and `webhook_fanout_abandoned_total` (given up at shutdown — alert on `increase() > 0`, never a rate, since it increments once and the process then exits). Master: `webhookRequestsTotal{webhook_type,status}`; `webhook_type="unconfigured"` means `CORE_WEBHOOK_SECRET`. Then `credit_release_outcome_total{tenant_id,outcome}` for what the release actually restored — only `redis` and `db_restored` give credits back, and `redis_hold_gone_no_restore` is a LEVEL rather than an anomaly (an already-released hold is indistinguishable from a TTL-expired one). A hold lost either way is recovered by `POST /super-admin/tenants/:id/credits/reconcile`, **never** by re-running the stop |
| nothing billed at all | Core boot log for the `warnIfSettlementUnconfigured` line (`settlement-dispatcher.ts:189`) |

---

## 7. Observability across hops

**W3C trace context** is injected by both master→core clients — `propagation.inject(context.active(),
outgoingHeaders)` at `core-client.ts:237` (proxy) and `:149` (internal) — producing
`traceparent`/`tracestate`. It is **not** injected by `dispatchWebhook`
(`magic-voice-core/src/webhooks/dispatch-webhook.ts`), so core→master webhooks start a new trace.
Both services export OTLP over `http/protobuf` when `OTEL_ENABLED=true` and
`OTEL_EXPORTER_OTLP_ENDPOINT` is set (`magick-master/src/instrumentation.ts:33-48`,
`magic-voice-core/src/instrumentation.ts:17-32`); master additionally exports logs.
Metrics (as of 2026-09-30, core #404 / master #285) are OTel-only — prom-client is gone; one OTel
instrument per metric is exported over OTLP every 60s, and the local `/metrics` scrape (`:9090` core,
`:9091` master) is rendered from those same instruments.

**Request ids.** Both backends use the same `genReqId` (`magick-master/src/index.ts:259`,
`magic-voice-core/src/index.ts:388`): client `x-request-id` header → active OTel trace id → random
uuid. Both echo it as the `X-Request-Id` **response** header
(`magick-master/src/api/middleware/request-id.middleware.ts:6`,
`magic-voice-core/src/api/middleware/request-id.middleware.ts:8`). Master does **not** forward
`x-request-id` to core, so the two hops share an id only via the injected trace id — which is the
common case in production and absent when OTel is off. cusui reads the header off failures
(`src/api/client.ts:126`) and embeds it in masked messages so users can quote it.

**Log context.** Master enters an `AsyncLocalStorage` context per request with the request as a live
source (`magick-master/src/index.ts:309`), so `reqId`/`tenantId`/`accountId`/`userId` appear on every
later log line without per-route wiring; `setLogContext` fills the gap for webhook/S2S/scheduler
entry points where those values arrive in the body
(`magick-master/src/utils/log-context.ts:136`). The originator (`x-mgkvc-originator`) is captured
there and re-emitted to core as a header (`core-client.ts:224`).

**Named spans** crossing services: `proxy <METHOD> <path>` and `core-internal <METHOD> <path>`
(master), `webhook.settlement.dispatch`, `webhook.dialer_analysis_settlement.dispatch`,
`webhook.agency_attempt_batch_settlement.dispatch`, `webhook.analysis_completion.dispatch`,
`webhook.dispatch`, `media_stream.session` (core), `webhook.call_completed`,
`webhook.analysis_completed` (master).

**Metric labels are route templates, never interpolated paths** — `metricPathLabel` /
`normalizeMetricPath` (`magick-master/src/utils/metric-path.ts`). Handing an interpolated path to a
prom label mints one permanent series per resource id. `passthrough` pins the label to
`normalizeMetricPath(corePath)` for parametric templates (`passthrough.ts:200`), which also closes a
cardinality-denial vector on client-controlled segments.

**PostHog** is one shared project across all three: `POSTHOG_API_KEY` in both backends
(`magick-master/src/config/index.ts:129`, `magic-voice-core/src/config/index.ts:367`) and
`VITE_POSTHOG_KEY` in cusui, whose `.env.example` says explicitly to use the same project key.
Tenant/account **groups** are labelled with display names by core's auth middleware
(`identifyTenantAccount`, `magic-voice-core/src/api/middleware/auth.middleware.ts:50`) — which is
the reason the `x-mgkvc-*-name` headers exist at all.

---

## 8. What breaks when you change one side

**Additive change: core → master → cusui.** Core's route must exist before master can proxy it;
master's route must exist before cusui can call it. Get it wrong and:

- master merged first ⇒ its proxy forwards to a core path that 404s. The mask sees a core-recorded
  404 with an unstructured body and rewrites it to "contact support" — so the symptom is a support
  message, not a 404, and looks like an outage rather than a missing route.
- cusui merged first ⇒ 404 from master (no `/proxy/...` route), and `apiFetch` throws
  `API error 404`. Harmless but user-visible.

**Removal: cusui → master → core**, the reverse. Removing a core route while master still proxies it
produces the same masked-500/404 confusion; removing master's route while cusui still calls it
produces a plain 404.

**A gated feature needs all four layers aligned** or it is unreachable:

1. RBAC role/permission — `magick-master/src/rbac/`, mirrored in
   `magick-comms-cusui/src/utils/permissions.ts`.
2. Governance capability — master's catalog + `requireCapability` (fail closed), mirrored by hand in
   `RequireCapability.tsx`'s `KnownCapabilityGate` union (`:7-36`, fail open).
3. Core feature flag — `magic-voice-core/src/feature-flags/registry.ts`, `clientExposed: true` to be
   visible to the browser, surfaced via `GET /proxy/feature-flags`.
4. Route guards — `RequireAuth` / `RequireSuperAdmin` in cusui.

**Config blocks are feature flags.** Master's `/super-admin/*` (`index.ts:451`), scheduler and
`/proxy/schedules` (`:466`), and bulk-dispatch jobs (`:483`) register **only if their env block
parses**. A missing route on a running master is usually an unset env var, not a bug.

**Other cross-repo couplings that fail silently:**

- A method missing from `proxyToCore`'s body-serialising branch (`core-client.ts:250`) — the write
  goes out bodiless, core answers 200, nothing changes.
- A core error `code` not in `FORWARDABLE_ERROR_CODES` — the message the feature depends on is
  replaced by a support ticket. Adding a code to core means adding it to master's set.
- The two `ws_url` rewrites are shape-coupled to core's URL format
  (`/api/v1/media-stream/<id>`, `/api/v1/webrtc-call/<id>/browser-stream`,
  `/api/v1/agency/station/<id>`). Change a core WS path and the rewrites silently fall back to core's
  absolute URL — the browser then tries to talk to core directly and fails on CORS/network.
- Master re-serialises webhook bodies to verify the HMAC (`webhook-core.routes.ts:359`), so anything
  that makes `JSON.stringify(JSON.parse(body)) !== body` for core's payloads breaks every settlement
  with a 401.

### Where the tree contradicts existing docs

1. **Root `CLAUDE.md` says the superproject's `main` has no commits.** It has several — `git log`
   shows `57f8466` and predecessors, including submodule-pointer commits.
2. **The `/proxy/*` list in root `CLAUDE.md` is incomplete.** Verified registrations include
   `/proxy/agency/station`, `/proxy/agency`, `/proxy/call-analysis-profiles`,
   `/proxy/platform-tools`, `/proxy/inbound-intents`, `/proxy/escalation-destinations`,
   `/proxy/webrtc-call` and `/proxy/automations` — the last of which is master-native despite the
   prefix.
3. **cusui's Vite proxy covers only `/api`, `/proxy`, `/super-admin`** (`vite.config.ts:75-92`).
   Every master-native family (`/governance`, `/threads`, `/dnc`, `/contact-lists`,
   `/bulk-dispatch-jobs`, `/tenants`, `/credits`, …) works in dev solely because
   `VITE_API_BASE_URL` is set to master's origin.
4. **The browser AI call does not carry a tenant to core.** Core's
   `POST /api/v1/browser-call/start` is on an unauthenticated plugin and reads `tenant_id` /
   `account_id` from the request body, defaulting to `'browser-test'` / `'default'`
   (`magic-voice-core/src/api/routes/browser-call.routes.ts:44-45`); cusui's
   `BrowserCallStartInput` sends neither (`magick-comms-cusui/src/api/browser-call.ts:17`) and
   master forwards the body verbatim (`proxy-browser-call.routes.ts:74`). So master reserves credits
   against the real tenant while core files the call under `browser-test`. Reported, not changed.
5. **`dispatchWebhook` does not propagate trace context**, so core→master settlement/analysis
   webhooks are not in the same trace as the call — worth knowing before hunting for a missing span.
6. Root `CLAUDE.md`'s "known-stale port references" note is accurate: core is `3000`
   (`magic-voice-core/src/index.ts` + `.env.example`), not `3005`.

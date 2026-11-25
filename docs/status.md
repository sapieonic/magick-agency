# Status

Where Magick Agency stands, in detail: what each delivery phase built and the evidence for it,
what is not built, what is still open and with whom, the deployment
invariants, and what to do next. Read it before planning work on the repo, or before answering
"is it done". As of 2026-11-20.

## Summary

The application is built: phases 1 to 9 of the delivery plan
([`intent-and-plan.md`](intent-and-plan.md)) are complete on the code side, every suite is green apart from the audio-decoder tests this build container cannot run (see "Agent station redesign"),
and Manas's rulings on the open questions are implemented. Nothing has yet run against a real
carrier, a real Firebase sign-in, production data or a deployed environment. The launch (phase
10) and the gated checks that need vendor accounts or real data are still to do.

## Phases

| Phase | State | Evidence |
|---|---|---|
| 0 Vendor setup and decisions | **Not done** (needs Manas) | No vendor accounts requested; launch decisions built with defaults ([`decisions.md`](decisions.md), §2) |
| 1 Scaffold | Done | Monorepo, CI, dev infra on 5436 / 6383 / 3021 / 5175 / 5176, Zod config that exits on invalid input. Dashboards and alerts deferred (B6) |
| 2 Contracts and schema | Done | `packages/contracts`; the baseline migration `packages/db/migrations/0001_baseline.sql`, inventoried in `packages/db/BASELINE.md`; baseline integration suite including down→up and trigger firing |
| 3 Platform layer | Done | Session sign-in paths and the `no_membership` refusal, invites, RBAC, settings, flags, super-admin, notifications, audit, usage counts; a 45-case invite escalation suite |
| 4 Dialer domain and data | Done | Pure rules in `packages/domain`; the agency repository and campaign management; repository tests on real Postgres |
| 5 Voice engine | Done, except the live-carrier check | Bridge, VoiceLink adapter, concurrency guard, sweeps, the carrier fixture test. Not done: one real call on a VoiceLink sandbox (needs the account) |
| 6 Dialer runtime | Done | 9 chaos suites (`apps/server/test/integration/agency/chaos/`); `runtime-e2e` (real app, station socket, real bridge, fake carrier); `runtime-boot-order` |
| 7 Call analysis | Done, except the real-recording check | Runner skip / resume / truncation / backoff tests; transcripts nulled at the retention day. Not done: one real recording analysed (needs vendor keys) |
| 8 Public API | Done | Route-table tests enumerated from Fastify's `onRoute` hook cover every console and super-admin path |
| 9 UIs, parity and dark pilot | UIs done; the rest needs Manas | Console and super-admin console with tests. Not done: Playwright happy path (real Firebase), parity check against production data, dark pilot |
| Rulings | Done | Open-question rulings and branding (`decisions.md` Q1–Q9, B17), each mutation-checked |
| 10 Launch | **Not started** | See "Not built" |

### Plivo, on tenants' own accounts (B18–B22)

Plivo joins VoiceLink as a carrier, dialled on each tenant's OWN Plivo account with credentials
super-admins add (not env). Built in steps:

| Step | State | Evidence |
|---|---|---|
| 1 Carrier modules | Done | The bridge asks a per-carrier module (media protocol, hangup style) instead of `provider === 'voicelink'`; `carrier-modules.test.ts`, mutation-checked against the bridge suites |
| 2 Credential store | Done | Migration `0002_telephony_credentials.sql`; envelope sealer and env keyring; credential service and `getForCredentialId`; super-admin API and Telephony Credentials screen; unit tests and a real-Postgres repository suite, guards mutation-checked; keyring and sweep metrics with alerts `agy-credential-keyring-missing-keys` and `agy-credential-sweep-failing` (`voice-credential-housekeeping.test.ts`) |
| 3 Plivo adapter | Done | `feat(server): Plivo carrier module (adapter, μ-law media, callbacks, V3 signatures)` and `feat(server): fetch BYOC recordings on the tenant's credential (B21)`. Dial on the fixed API host returning the `request_uuid`, `time_limit` on every dial, cancel by request id and hang up by call id (an empty or malformed id refused before any URL is built), answer XML with a session `<Record>` and a bidirectional μ-law `<Stream>`, V3 signatures against the current and grace tokens, a per-account calls-per-second gate in Redis, `carrier_dial_refusals_total`; recordings through `telephony/recording-access.ts` (Plivo: `media.plivo.com` exactly, the credential on the first request only; since 2026-11-18 its regional subdomains too, PL6 as amended). Tests: `test/unit/telephony/plivo/` (`plivo.adapter`, `plivo-signature`, `plivo-dial-rate`, `plivo-config`, and `plivo-carrier.fixture.test.ts` over `plivo-carrier.fixture.json`), `audio-fir-mulaw.test.ts`, `carrier-errors.test.ts`, `recording-access.test.ts`, `recording-proxy.test.ts`, `recording-fetcher.test.ts` |
| 4 Dialler integration | Done | `feat(server,console,contracts,db,domain): pin campaigns to a tenant carrier credential and sync its numbers` (migration `0019_plivo_numbers_and_carrier_pause.sql`, numbered 0018 before main's `0018_agent_caller_ids.sql` was merged: the `plivo` provider row active, `phone_numbers.telephony_credential_id`, pause reason `carrier_auth`); `feat(server): dial Plivo on the campaign's credential through the bridge`; `feat(server): serve Plivo's answer, status and recording callbacks`; `feat(server): forward Plivo callbacks to the media worker that holds the call`; `feat(console,super-admin): choose the campaign's carrier and sync a credential's numbers`; `fix(db): offer no caller ID from a carrier credential that cannot dial`; `feat(server,console,contracts,db): pause a campaign whose carrier account is no longer active` (migration `0020_carrier_account_unavailable_pause.sql`). Every step-2 obligation is met: the bridge dials through `getForCredentialId(provider, id, 'dial', tenantId)`; the call row's INSERT re-checks the credential is `active` (`credential-call-insert.repository.test.ts`); a campaign pins only an `active` credential of its tenant; the dial's `request_uuid` is persisted to `provider_request_id` and a teardown before the answer cancels by it. Tests: `campaign-carrier-pinning.test.ts` (integration), `dialer-carrier-refusals.test.ts`, `webrtc-bridge-plivo.test.ts`, `plivo-webhooks.test.ts`, `plivo-callback-forwarding.test.ts`, `credential-number-sync.test.ts`, `proxy-agency-carriers.test.ts`, the db suites `plivo-numbers-migration`, `carrier-account-unavailable-migration` and `phone-number-sync.repository`, the console's `CampaignBuilderPage.carrier`, `AgencyCampaignSettingsPage.carrier` and `agencyCarriers`. End to end against the scriptable mock carrier (`apps/server/test/mocks/plivo/`, checked by `test/unit/load/mock-plivo-carrier.test.ts`, which runs the real `PlivoAdapter` against it): `test/integration/telephony/plivo-call-e2e.test.ts` (a full call; cancelled while ringing; unsigned, forged and other-tenant callbacks refused; a 401 pausing `carrier_auth`; a disabled credential pausing `carrier_account_unavailable`; the previous token accepted inside the rotation grace) and `plivo-cluster-forwarding.test.ts` (callbacks forwarded to a media worker and verified there), in the rest lane. An account on a per-carrier concurrency breakdown needs a `plivo` row, set in the super-admin console (`operations.md`, "Enabling Plivo for a tenant"); since the review fixes a campaign without one is refused at start (PL14) |
| Review fixes (2026-11-07) | Done | An independent review (principal engineer, product and QA) of steps 3 and 4 found no critical defect; every finding is fixed with a test that fails without it (mutation-checked). Dial path: a dial the adapter refuses before sending is unplaced and uncharged (`CarrierDialNotSentError`), and a contact number the carrier will never dial is suppressed `invalid`; `PLIVO_WEBHOOK_BASE_URL` validated at load; five carrier refusals in a row pause the campaign `carrier_refusing_calls` (migration `0021_carrier_refusing_calls_pause.sql`, PL11); a carrier that cannot dial is not offered and its campaigns do not start (PL12); a failed hangup gives back its one-hangup claim; a replayed signed callback is refused; an unanswered call ends soon after the carrier's ring timeout; the calls-per-second gate is a sliding window; tenants never see a carrier's raw error text. Campaigns: a retired caller ID no longer locks the settings and is no longer dialled (PL13); start is refused when the carrier has no concurrency allocation on a per-carrier breakdown (PL14); the health strip shows automatic carrier pauses and campaigns that cannot dial. Copy: "contact support" (PL15), super-admin names carriers "Alias (Vendor)" (PL16), no vendor name or UUID in the Activity trail, British spelling guarded in both web UIs. Agent app: the ringing warning only on a carrier that cannot cancel, `can_cancel_ringing` decoded in `agency_wire` |
| Merge with main (2026-11-07) | Done | `main`'s dedicated caller ID per agent (#51, DN1–DN10) and the Insights tabs (#53) merged in (a merge commit; the branch is published). `main`'s `0018_agent_caller_ids.sql` is released and kept; this branch's unreleased migrations moved up one, to `0019_plivo_numbers_and_carrier_pause.sql`, `0020_carrier_account_unavailable_pause.sql` and `0021_carrier_refusing_calls_pause.sql` (headers, tests, `BASELINE.md`, the down → up ledger). The two caller-ID rules are one: every dial path hands `resolveCallerId` (DN2) the campaign's DIALABLE caller IDs (PL13), so on a tenant's own carrier account a dedicated number retired or revoked there falls back to the rotation, and the rotation is the dialable pool minus the dedicated numbers; a service-account campaign behaves as on `main` (`decisions.md`, PL13's addendum). The supervisor's caller-ID list and PUT and the agent's My contacts see the same pool; removing a retired number still dedicated is refused `caller_id_dedicated`, naming it. Tests: `pacing-engine.test.ts` and `dedicated-caller-ids.test.ts` ("over the dialable pool"), `agency-agent-caller-ids.test.ts` (a pinned campaign end to end), each mutation-checked |
| 5 Live check | Not started | Needs a Plivo account. To check: one real call end to end (dial, answer XML, stream, hangup) and one recording analysed; the cause codes real hangup callbacks carry, added to `plivo-carrier.fixture.json`; the recording host and whether a recording fetch redirects (the fetch sends the credential to `media.plivo.com` and its subdomains only, and never follows a redirect with it; staging's account records on `aps1.media.plivo.com`); the assumption that a 403 on create-call is a geo-permission refusal of the destination, not an auth failure; and the call detail record the ring deadline reads (`GET Call/{call_uuid}/`): the values of its `call_state` for a busy, unanswered, cancelled, failed and answered call (the SDK names the field, not its values; `plivo-carrier.fixture.json` `cdr` holds illustrative ones), its `hangup_cause_name` catalogue, and that it answers 404 while the call is live |

### Carrier account modes; VoiceLink on tenants' own accounts 2026-11-25 (CR1–CR14, [`carriers.md`](carriers.md))

A carrier declares which accounts a call may be placed on: the service's own (env), tenants' own
(a sealed credential), or both. VoiceLink now takes both; Plivo stays tenant accounts only.

| Step | State | Evidence |
|---|---|---|
| 1 Foundation | Done | One codec-free carrier catalogue with account modes; `SERVICE_ADAPTERS` and `TENANT_ADAPTERS` instead of a switch; webhook base and public recordings from the catalogue; recording access per account mode; every per-carrier list held to the catalogue by `carrier-conformance.test.ts`, mutation-checked |
| 2 VoiceLink tenant account | Done | Credential spec (login check, the service's username reserved), tenant adapter with one shared login per credential and secret version, typed refusals so PL2 and PL11 apply, recordings proxied and ended by revocation; `voicelink-tenant-call-e2e.test.ts` on the mock carrier. Not yet run on a real tenant VoiceLink account |
| 3 Write rules | Done | Campaigns by account mode (CR8), no pinned caller ID on a service-account campaign (CR9), numbers added by hand pinned to a credential and assigned to its tenant (CR6, CR7), capability fields on the provider lists, inbound gated by capability (`inbound_not_supported`, CR11); readiness by account mode (a tenant VoiceLink account needs `VOICELINK_BASE_URL`) |
| 4 Consoles | Done | Super-admin: Add number with the account picker, Move to a tenant's account, Sync and inbound by capability, a pinned number's account shown; console: carrier accounts named apart without vendor names, pinned VoiceLink recordings played from the carrier's URL after the server's access check (CR12) |
| Review fixes | Done | An independent review found no critical defect; fixed with tests that fail without them: a 401 after a re-login no longer condemns a tenant credential (CR4), the username fits its column and is unique without case (CR2), existing service numbers can move to a tenant's account (CR6), tenant VoiceLink recordings redirect instead of being fetched through egress that cannot reach them (CR12), two conformance checks that guarded nothing |
| Manas's answers | Done | CR2, CR4, CR9, CR11, CR13 decided 2026-11-25. Built for them: a concurrency cap per carrier account (`0077_credential_concurrency_cap.sql`, a fourth admission scope, super-admin's Concurrent calls), an account that logs in but cannot dial gets its own refusal, a breaker at 10 and the alert `agy-carrier-api-refused`, and the one-off CR9 clean-up script |
| Pacing (CR15) | Done | The tick plans no dials past an account's carrier share or a carrier account's own cap; the pinned `it.fails` for the carrier share now passes |
| 5 Ratify | Open | Manas: the rest of CR1–CR15 and the questions left in `carriers.md` §6 |

### Tidy-up 2026-10-16/17

Manas asked on 2026-10-16 for the whole tidy-up plan to be implemented. Decisions and the
defaults still to ratify are in [`decisions.md`](decisions.md), "Rulings of 2026-10-16/17
(tidy-up)", and B23.

| Area | What changed |
|---|---|
| Shared UI | New package `packages/web-ui` (B23): the 15 shared components, `ToastContext`, `global.css`, error and format helpers, `parseApiErrorBody`, `useAsyncResource`, `useDialogFocus` (one focus trap), `mapWithConcurrency`; both SPAs import it, `docker/web.Dockerfile` copies it, and it has its own branding guard |
| Contracts | Dialer contract split into `packages/contracts/src/agency/` behind `agency.ts`; console wire types re-export or derive from it; one `AGENCY_STATION_CLOSE`; campaign config defaults and both rate floors moved in; `AGENCY_STATION_ERROR_CODES`, `api/platform/audit.ts` and the `zod` dependency removed |
| Database | Migration `0003_agency_attempt_indexes.sql` (live-attempt predicate, answered and connected partial indexes, the redundant reporting index dropped; plans in `packages/db/BASELINE.md`); migration `0004_agency_contacts_in_flight_index.sql` (partial index on `in_flight` contacts for the reaper's stranded-contact sweep); `withTransaction` in `packages/db/src/utils/transaction.ts`; batch claims and sweeps through a `MATERIALIZED` CTE (below) |
| Server, agency | The agency repository split into `apps/server/src/db/repositories/agency/` behind the `agency.repository.ts` barrel; `pacing-engine.ts`, `agency-dialer.ts` and `agent-record.ts` split into `pacing/`, `dialer/` and `agent-record/`; pacing `stop()` awaits ticks in flight (5 s bound) and the dialer re-checks just before the carrier; settle paths survive a failed row write, and the reaper recovers what such a write leaves (an attempt whose `ended` write failed is ended `orphaned`; a contact stranded `in_flight` with no live attempt for 5 min is requeued on the our-fault ledger); the pre-dial checks run before the attempt is stamped `dialing`; ingest totals exact under concurrent chunks; one `dialedAt` instant |
| Server, API | Route families (`<family>.routes.ts` plus `<family>/`), shared helpers in `api/routes/helpers/`; `forwardCore` / `forwardCoreVia` in `core-dispatch.ts`; the proven-campaign fast path for the spine export; internal `GET /agency-campaigns/summaries` for the staffing `my-*` routes |
| Server, voice | `webrtc-bridge-manager.ts` split into `core/bridge/` (admission, types, WS tokens); the unstored-token memo capped at 10 000 |
| Console | Large pages, hooks and utils split into folders (campaign detail, campaigns home, station, analytics, roster, overview, config form); one display locale `en-IN` and one rounding rule on the analytics surfaces; a typed `EventCatalog` for analytics; `useTeam` / `useAccounts` / `usePhoneNumbers` on `useAsyncResource` |
| Super-admin | Error messages in the console's order; phone numbers filtered client-side; accounts list reports `unavailable` on a failed allocation read; role enum in `ROLES` order |

**A pre-existing bug, found and fixed.** The batch claims and sweeps (`claimDialable`,
`failStaleActive`, `claimRunnable`, `recoverStale`, `promoteRecordingReady`) could claim far more
than `limit`: under a nested-loop semi-join plan Postgres re-ran the locking subquery and claimed
the whole eligible set, which in the dialer meant dials with no agent and
`agency:agent:undefined:state` leases. Each now picks its rows in a `MATERIALIZED` CTE
(`fix(db): batch claims and sweeps take at most limit rows`), with tests that force the
re-running plan (`apps/server/test/integration/agency/agency-contact-claim-limit.test.ts`,
`packages/db/test/integration/repositories/claim-limit.test.ts`).

**Skipped, with the reason:**

- Pacing reading agent states only after headroom: the `no_agents` vs `no_slots` telemetry needs
  the reads.
- Caching `getMaxConcurrentCalls`: it would defeat cross-replica invalidation. Superseded
  2026-11-02: pacing caches it with event invalidation and a 2 s TTL, and never feeds the guard's
  Redis cache (scaling phase A).
- Throttling `countOutstanding`: it changes which tick finalizes.
- One per-campaign `LeadState` map in pacing: the collections have different lifetimes.
- Splitting the bridge's media relay, carrier events and teardown, and pacing's `maybeFinalize`:
  bound to private state.
- A raw passthrough in `callCore`: it would bypass the content-type and error-mask handling.
- A streaming CSV export: the headers and preamble need the final row count.
- The campaigns home's per-campaign `/stats` N+1: needs a batch stats contract.
- Migrating the 114 `trackX` call sites to `track<K>()`.
- The super-admin `FlagDialog`'s own focus trap, and the 4-state analytics hooks' own generation
  guards.
- Console list hooks other than `useTeam`, `useAccounts` and `usePhoneNumbers` (now on
  `useAsyncResource`).

**Follow-ups:**

- The T-L4c lease guard's literal-TTL regex (`\b'PX'`, in
  `apps/server/test/integration/agency/chaos/lease-renewer-killed.test.ts`) never matches: `\b`
  before a quote needs a word character in front of it.
- Raw `BEGIN` sites could adopt `withTransaction`: in `packages/db`, the call-analysis-profile
  and membership repositories (and others: provider concurrency, tenant phone assignment,
  dialer analysis jobs, telephony credentials), and in the server the mark-DNC route and audit
  partition maintenance. Only the helper's sites and the membership repository destroy a client
  whose ROLLBACK failed.
- The agency repository still imports runtime values from `apps/server/src/agency/agent-record.ts`.
- Stale comments citing `useBrowserCall` / `useWebRtcCall` in `useAudioCapture`,
  `useAgencyAudio` and `agencyMedia`.
- The reader's default locale remains on the station, activity, spine, retry, notes, ingest,
  builder, contacts and attempts pages and in `AgencyRetryDialog`.
- `AgentBucketChart`'s title reads "1 dials".
- A `released` that lands before React renders its `reserved` does not retain the panel (latent,
  unchanged).

### Load and scenario suites 2026-10-23

Manas asked on 2026-10-23 for exhaustive load, soak and scenario tests of the server with a full
floor of agents, and for mock servers to exercise the WebSocket behaviour. Added
`apps/server/test/{unit,integration}/load/` and `apps/server/test/mocks/` (a scriptable VoiceLink
carrier and a simulated agent fleet, Node-native on `ws`; inventory and the reason it is not
WireMock in [`modules.md`](modules.md), "Load, soak and scenario suites"). Sizes are modest by
default; `LOAD_SCALE` multiplies them (runs at 2–4× passed: 200 agents on the floor run, 360 on
the morning rush).

**Defects found and fixed**, each in the commit with the test that catches it:

| Where | Defect |
|---|---|
| `src/agency/station-socket.ts` | A station text frame of `null` threw out of the `ws` listener; with no `uncaughtException` handler, one 4-byte frame from any signed-in console crashed the server |
| `src/core/webrtc-bridge-manager.ts` | A second terminal webhook (`call.completed`, carrying the recording) arriving during the first one's teardown lost the recording URL, and the analysis job waited forever |
| `src/core/webrtc-bridge-manager.ts` | The dial-time `provider_call_id` write overwrote the carrier's real id when the carrier connected before its own `add_lead` response |
| `src/core/webrtc-bridge-session.ts`, bridge manager | An answer and its terminal processed together could leave the row `in_progress` with `ended_at` set (two pool connections, no order); the terminal write now waits for progress writes |
| `src/db/repositories/agency/contact.repository.ts` | Overlapping stranded-contact sweeps each charged the our-fault ledger for the same contact (4 sweeps retired contacts `exhausted` after one stranding); the sweep now claims its rows `SKIP LOCKED` |
| `src/agency/wrapup-manager.ts` | A wrap-up ended while `enter` awaited its writes still armed its timer and announced `wrapup`; the orphaned timer ended the session's next wrap-up early |
| `src/auth/session.middleware.ts` | A failed user lookup (pool timeout, database or Redis error) answered 401, which signs the console out: one database stall signed out the floor. Only the token check answers 401 now |
| `src/audit/audit-buffer.ts`, `src/audit/platform/audit-buffer.ts` | `forceFlush` spun in a microtask loop and could return before an in-flight batch was written, when shutdown landed mid-flush |
| `src/api/middleware/error-handler.middleware.ts` | Every 429 reached clients as `error: 'Error'` without `retryAfter` |
| `src/api/middleware/agency-error-handler.ts`, `core-dispatch.ts`, `auth.routes.ts`, `proxy-agency-campaigns/ingest.ts` | 500s on client input: a NUL byte (`22021`), deeply nested JSON, a Firebase-refused token at sign-in, a truncated multipart upload — now 400 / 401 |
| `src/db/repositories/agency/agent-session.repository.ts` | Racing first joins each logged a `NULL → break` "session started" event |

**Defects found and left open**, each pinned by an `it.fails` (flip it to `it` with the fix). All
need Manas or a deliberate change to a shared file. The first three (frame size, send buffer,
VoiceLink timeouts) were fixed on 2026-11-02 ("Scaling for 500 simultaneous calls"), and the
disposition replay on 2026-11-03 ("Review fixes on the scaling branch"); their rows stay for the
record:

| Defect | Pinned in | What deciding it needs |
|---|---|---|
| No frame-size limit on WebSockets: `@fastify/websocket` is registered with `ws`'s 100 MiB default, parsed on the event loop | `unit/load/station-inbound-fuzz.test.ts` | A `maxPayload` in `src/app.ts` (shared composition file) |
| Unbounded send buffer to a console that stops reading (6.5 MB held in the test), not reaped mid-call | `unit/load/station-backpressure.test.ts` | Cap or drop policy; likely a new close code in contracts |
| No request timeout on VoiceLink REST (`add_lead`, login): a hung carrier holds an agent and three concurrency slots for undici's 300 s default, and a hung login stalls every dial behind it | `unit/telephony/voicelink/voicelink-adapter-mock-carrier.test.ts` | The timeout value, and what a timed-out `add_lead` means (the lead may be queued) |
| A terminal webhook that overtakes its own `call.answered` never records the answer: the attempt is classified `no_answer` and the contact redialled | `integration/load/voicelink-webhook-storm.test.ts` | Emitting `answered` before `ended`, which the dialer's bind / abandon flow acts on |
| A lowered account or provider concurrency limit can be cached stale for the cache lifetime (8 admitted against a limit lowered to 2) | `integration/load/concurrency-guard-storms.test.ts` | A generation counter on the cache write; changes the guards' Redis calls their unit suite pins |
| Pressing Available during a live, announced call overwrites the `on_call` lease; the next tick reserves the agent for a second customer | `integration/load/agent-churn.test.ts` | Refuse on `hasLiveAttempt` (the route's own comment names this gap) |
| The pacing tick caps dials by the account limit only; with a provider share below it, the bridge refuses the surplus every tick (wasted claims, attempt rows, console popups) | `integration/load/concurrency-cap.test.ts` | Bound by the provider limit in provider mode |
| A dial refused for capacity is stamped `dialed_at` before admission, so stats count it as placed | `integration/load/concurrency-cap.test.ts` | Stamp after admission, or exclude refusals in the stats |
| A same-code replay of an older attempt's disposition reopens a `completed` contact to `pending` | `integration/load/disposition-storm.test.ts` | Whether a superseded attempt may move the contact at all |
| The lifecycle audit's `from` is the status the pre-check read, not the one the update moved from | `integration/load/campaign-mutation-races.test.ts` | `transitionStatus`'s SQL, pinned by text in several tests |
| Two concurrent PATCHes can combine into an empty calling window (10:00–10:00) | `integration/load/campaign-mutation-races.test.ts` | Validate against the row the update writes |
| A multipart part with no headers makes `request.file()` never settle; the request hangs | `integration/load/hostile-input-fuzz.test.ts` | A parse deadline that also tears down the socket |

**Observed, not pinned:** the per-IP rate-limit bucket (200/min default) is shared by a whole floor
behind one office NAT, so `RATE_LIMIT_MAX` needs sizing for such a deployment (sized 2026-11-02); with the
production ioredis defaults a Redis outage takes about 10 s to surface on `/readyz` and some
requests wait about 30 s (no command timeout; bounded at 2 s on 2026-11-02); the PSTN socket refuses a bad token with a bare
close (1005), not a 44xx code; a 200 `add_lead` with a non-JSON body fails the dial though the lead
may be queued; `StationTokenStore.mint`'s local fallback during a Redis error is never consulted by
`verifyAndConsume`, so it fails closed and is dead code; `nextWindowOpen` returns up to an hour late
on a spring-forward day for a window opening in the skipped hour (never early).

### Releases and the version display 2026-10-23 (B24)

| Area | What changed |
|---|---|
| Releases | release-please (`release-please-config.json`, `.release-please-manifest.json`, `.github/workflows/release-please.yml`): every workspace package has its own version, tag, GitHub Release and `CHANGELOG.md`, all starting at 0.1.0; PR titles checked as Conventional Commits (`pr-title.yml`); `pnpm test:release` guards the config in CI. Not yet run on GitHub: it needs the repository settings in [`operations.md`](operations.md), "Repository settings it needs" |
| Version display | `AppVersion` (`packages/web-ui`) at the foot of every sidebar in both apps, and inline in the agent nav and the station header; the server's boot line names its version (`magick-agency v<version> listening`) |

### Soft phone 2026-10-30/31 (SP1–SP7)

Manas asked on 2026-10-30 for a soft phone: an agent dials any number from the browser without
joining a campaign, can log the call to a campaign to use its outcomes, and the call carries
custom dimensions for its summary; an agent on a running campaign can switch to it and back,
audited. Design and rulings: [`softphone.md`](softphone.md); rulings in
[`decisions.md`](decisions.md), "Rulings of 2026-10-30".

| Area | What changed |
|---|---|
| Schema | Migration `0005_softphone.sql`: session `kind` (`campaign` / `softphone`, `campaign_id` nullable), `agency_manual_calls`, `agency_calls.origin` / `manual_call_id`, `agency_softphone_settings` (`packages/db/BASELINE.md`) |
| Contracts | `agency/softphone.ts` (wire rows, requests, refusals), `AGENCY_SOFTPHONE_ERROR_CODES` (24, with HTTP statuses), the `manual_call` station frame, `agency.softphone.dial` (agent) and `agency.softphone.manage` (account admin), flag `agency_softphone_enabled` (`FF_AGENCY_SOFTPHONE`, off by default) |
| Voice | The bridge seam takes a correlation, attempt or manual (`seams.md` §3.1); a manual leg has no browser-close grace before answer |
| Runtime | `agency/softphone/`: `ManualDialer`, pre-dial (E.164, caller ID, roster match, calling window and DNC with overridable refusals), outcomes with the station's pure rules, roster settlement (SP6), lapse and orphan sweeps in the reaper, station reattach; a Lua-guarded `manual` claim so an agent owing a soft-phone outcome never becomes available, across a station drop, a lapsed lease, a reconnect and a restart; pacing headroom counts live calls account-wide |
| API | `/proxy/agency/softphone/*` (bootstrap, sessions, calls, hang-up, outcome, DNC, list, detail, recording, settings) and `/sessions/:id/softphone` + `/softphone/return`; audit actions `agency_manual_call.*`, `agency_softphone_settings.updated`, `agency_session.softphone_started` / `_ended`, shown in the campaign activity trail |
| Console | `/dialer/phone`, the soft phone in place on the station after "Switch to soft phone", override dialogs, My calls tab, Soft-phone calls list and detail, a campaign's Soft-phone calls tab, a roster contact's soft-phone history (supervisors), Settings → Soft phone; a finish-only mode when the flag is turned off mid-call; the live floor names the soft phone; the DNC page says what the soft phone checks |

**Review.** An independent review of the server and of the console found 5 and 9 defects; all
are fixed with tests that were watched failing first: chiefly a switched agent owing an outcome
who could come back `available` after a station drop and a lapsed lease, call details wiped when
a call arrived before its field set, no audio on the first call of the day on `/dialer/phone`,
and Mute while ringing muting the call. A visual pass on the real components fixed nine layout
defects (frozen geometry between states, clipped labels, missing icons, light-theme contrast).

A second round (2026-10-31): three independent reviews of the whole change (engineering, product,
QA), then a re-review of their fixes, every fix with a test watched failing first. Chiefly: an
untagged dial now meets the DNC entries of every campaign of its account and the account-wide
in-flight guard; an untagged DNC mark is account-scoped (it wrote a tenant-wide row with no
permission check) and on the DNC trail; a call closed without an outcome settles the contact by
the campaign's retry policy (pacing could redial seconds later); recordings, transcripts and
analysis are supervise-only; the flag turned off mid-call leaves a finish mode and only routes
that start work are gated; every way off the soft phone is audited once with `via`; pacing's
account-wide live count is an index-only read (it probed every campaign the account ever had,
each tick); a break queued while pacing held the agent reserved is applied; another break is
refused while a soft-phone call is owed; live sessions in a sibling account are refused, named,
not mixed up; "Close the soft phone and join". Open for Manas: calling hours on untagged calls
(none, as ruled), the in-flight guard on tagged dials (the tag's roster only), who may override a
tenant-wide DNC entry, and soft-phone occupancy buckets (UTC).

**Not verified:** a real VoiceLink call from the soft phone (needs the account, like every call
path), and a browser session with real Firebase sign-in. `test/integration/load/agent-churn.test.ts`
failed intermittently before this branch (2 of 8 runs on `c9fd548`). One cause is found and fixed
in the suite: a ring-dropped agent whose return landed while the call still rang was re-attached
onto it (the re-attach window, never lapsed for a ring drop), so its answer connected where the
suite demanded `abandoned`; forcing an early return reproduces CI's failure every run.

**Not built** (`softphone.md` §8): call details in the analysis prompt, a callbacks list, DTMF,
per-campaign call fields, "every call must be logged to a campaign", transfer and conference.
The console and the agent app both show the SP3 warning only when the live call's
`can_cancel_ringing` is not `true`, and it names no carrier. Seen and left: light-theme `<select>` elements show no arrow app-wide
(`packages/web-ui/src/global.css`), and the station shows campaign numbers unformatted.

### Agent mobile app 2026-11-01 (V1)

Manas asked on 2026-11-01 for an agent-only mobile app (Flutter, Android and iOS in this repo).
The design is in [`mobile.md`](mobile.md). It is built as V1. Nothing has run on a real phone,
a real carrier or a real Firebase or Google sign-in, and the iOS app has not been compiled yet
(no Xcode in the build environment).

| Area | What changed |
|---|---|
| App | `apps/mobile`:<br>• sign-in and invites, account choice, the campaign list, pre-flight checks, the station (calls, notes, outcomes, DNC, breaks), My performance, My calls, the Me tab<br>• `packages/agency_wire`: hand-written wire types<br>• `packages/agent_audio`: native voice engine, CallKit, the Android on-duty service<br>• release-please component `mobile` (`release-type: dart`) |
| Server: presence | `device_away`, a reserved break code the app takes when it leaves the foreground (applied at once when available, queued behind a call).<br>Migration `0006_agent_session_client_kind.sql` and `client=web\|mobile` on the station upgrade.<br>Mobile liveness: protocol ping every 3 s, 10 s grace; the sweep now runs every 5 s. A phone silent past it on a call the agent can see is dropped and the 8 s deferred hangup decides (M1).<br>`X-Client` on log lines. The floor marks agents on the mobile app. |
| Server: media | `media=alaw8` on the station socket: binary G.711 A-law, relayed byte for byte to VoiceLink, transcoded for other carriers. `parseStationUpgradeQuery` refuses an unknown `client=` or `media=` before the token is spent |
| Server: platform | A per-user rate-limit bucket and a bearer IP bucket (Q9 amended, pending ratification).<br>A staffing check on join (`403 not_staffed`, supervisors exempt, a live session is never stranded).<br>`GET /client-config` (version gate) and `POST /client-config/uplink-probe` (pre-flight upload speed).<br>App Links / Universal Links files served by the web image (`docker/mobile-app-links.sh`) |
| Drift guards | `packages/contracts/fixtures/agent` samples are type-checked in TS and decoded in Dart. `tooling/contracts-literals.mjs --check` (in CI and in the contracts tests) catches a literal union the app does not know.<br>The external-references guard now scans the mobile sources and skips build output |
| CI | `.github/workflows/mobile.yml`: drift check, analyze and tests, a debug Android build on pull requests, an unsigned iOS build on `main` |

Two independent code reviews found 16 defects; all are fixed, each with a mutation-checked
regression test. The worst were:

- a forced sign-out that left the agent in the dialing pool;
- pre-flight's sound check able to switch off the first call's audio;
- notes typed while saving, or in the last 2 s before leaving, being dropped;
- the previous agent's call history surviving an account switch.

A second review of the whole branch (six reviewers, one per area) then found and fixed, each with
a test that fails without it: a silent phone left dialable for 30 s (closed with `terminate` now,
idle as well as on a call), routes outside the tab shell escaping the station rules (an invite
link mid-call), an offline cold start signing the agent out, another account's or agent's data
on screen after a switch, a failed device-away never retried, saved notes coming back blank, the
`session_on_other_campaign` 409 missing the ids the app needs, `ready` and the bootstrap missing
the break reason, close codes 1008/1011 retried forever, a stale notification hang-up after
4409, the station socket upgrade on the shared IP bucket, the super-admin login limit doubled by
a bogus bearer, iOS engine restarts disabled by an unmatched interruption, and light-theme
contrast below AA.

Counts on 2026-11-01, after that pass:

- lint clean in every package;
- server: 7330 unit + 4 expected fail; 1500 integration + 10 expected fail;
- db: 427 unit, 502 integration;
- contracts: 171;
- console: 4818;
- `test:release` 10, `test:grafana` 31;
- the mobile app: 733, `agency_wire` 243, `agent_audio` 106 Dart and 22 Kotlin tests;
- `flutter analyze` clean; the dev debug APK builds; a release build fails without `key.properties`.

### Soft phone on the agent app 2026-11-01 (M2–M6)

Manas asked on 2026-11-01 for the soft phone in the agent app. The design is in
[`mobile.md`](mobile.md), "The soft phone", and [`softphone.md`](softphone.md) §7, "The agent
app"; rulings M2–M6 in [`decisions.md`](decisions.md), and M1 amended. The server's soft phone is
unchanged apart from M1: the app uses the console's routes and the `manual_call` frame.

| Area | What changed |
|---|---|
| App: session host | The station core hosts a campaign station or a soft-phone session on one socket, audio engine and on-duty service (`HostedSession`, `stationHostProvider`), and implements the soft phone's host actions (open, close, switch, cancel, return, adopt and retire a call, ring mute, system hang-up). "Close the soft phone and join" reads the soft-phone bootstrap in the session's own account first and closes nothing over a live or owed call (`close_softphone.dart`). A soft-phone call counts as a call for pings, reconnects, audio, CallKit, the notification and a held sign-out; never a `device_away` on a soft-phone session; the wake lock only while a call is live or owed |
| App: soft phone | `lib/core/softphone/`: the API client, `SoftphoneController` (a port of the console's `useSoftphone`, per workspace), the console's call rules and copy, the 700 ms autosave with unsent notes kept on the phone, the overrides, finish mode, auto-resume and the Phone tab's availability. `lib/features/softphone/`: the Phone screen's states and `SoftphonePanel`, one panel for the Phone tab and the station in place (SP7) |
| App: navigation | The Phone tab at index 1 (Station, Phone, Performance, My calls, Me); the tab rule extended to a live or owed soft-phone call (M4); "Switch to soft phone" on the station, queued behind a call |
| App: My calls | A "Soft-phone calls" segment with keyset pages, filters and the detail sheet (`lib/features/calls/softphone/`); `media` never rendered |
| `agent_audio` | `setRingback`: the console's ringback made in the native engine and mixed into the playout frames (M5); a Dart reference and golden vectors shared by the Dart and Kotlin tests |
| Wire and drift guards | `agency_wire` models the soft phone (rows, bootstrap, requests, answers, refusals as typed `ErrorBody` accessors; a `manual_call` frame whose row does not read stays a frame with no call). `softphone.json` (22 samples) and four station samples, type-checked in TS and decoded in Dart. `literals.json` 29 → 38 vocabularies, and `fieldUnion` reads optional fields. `AgencySoftphoneDispositionInvalidRefusal` declares the `reason` the server already sent |
| Server: M1 | A phone silent past its grace on a live soft-phone call is dropped with `terminate` (log label `on_manual_call`); the bridge's rule for a manual leg then decides. The web console is unchanged |

**Review.** Five independent reviews (server and wire, the session host, the soft-phone
controller, the UI and navigation, ringback and docs) found no critical or high defects; every
medium and low finding was fixed with a regression test that failed first and a mutation check:

- a ringing call the server ended while the socket was down could keep ringback, CallKit and the
  hold: the station core now checks a held call against the server itself after a reconnect;
- a failed CallKit or notification hang-up was silent: it shows on the soft phone, and CallKit is
  told the call goes on;
- a resume put off in the background acted on an old answer, and could take a session live on
  another device: only this phone's own session resumes (M6);
- the bootstrap was not re-read when a session started (a stale "Log to" list, a new required
  field the agent could not see), and the station's tag carried into a later Phone-tab session;
- the number could be edited while a dial was in flight, so an override could redial a different
  number; the override prompt survived finish mode;
- at 200% text with the keyboard up the panel's column collapsed: the action area now takes at
  most half the panel and scrolls inside itself past that, checked at 1.0–2.0 text with and
  without a keyboard, on both surfaces;
- smaller: a 1008 left a session owing an outcome, CallKit never showed the contact's name, the
  number field showed characters it would not dial, an unanswered yes/no read "No" (also on the
  console), the station announced the switch as a break, fixtures that were not the server's
  output, and a Kotlin test that did not guard the plugin's wiring.

Counts on 2026-11-01, from inside each package, after the review fixes:

- server unit: 7333 passed + 4 expected fail + 42 skipped (352 files), the one failure the
  branding guard on an uncommitted local `apps/mobile/env/staging.json`; `station-mobile-liveness` 20;
- contracts: 248 (8 files; `agent-fixtures.test.ts` 152);
- console: 4822 (247 files);
- the mobile app: 1232; `agency_wire` 325; `agent_audio` 124 Dart and 33 Kotlin tests;
- `pnpm lint` clean; `flutter analyze` clean; `contracts-literals.mjs --check` up to date (38
  vocabularies); the debug APK builds.

**On the emulator against staging** (2026-11-01): the Phone tab shows, the soft phone opens
(`POST /softphone/sessions` 201, the socket ready, the account's caller ID), and closes (the
bootstrap read first, then `leave`). No number was dialled.

**Not verified:** nothing has run on a phone. iOS is not compiled: the Swift ringback (written to
the shared vectors) and CallKit for soft-phone calls are reviewed only. Without a carrier a dial
ends `failed` and unplaced; ringing, the answer, A-law both ways and the ringback need the
VoiceLink sandbox. A network change while a call rings ends it (no grace before the answer, SP3);
accepted.

### The agent app on a phone, and its telemetry 2026-11-01

The first calls from a phone (Android 16, a Redmi, a release-mode `dev` build against staging):

- The first dials were refused by VoiceLink: `Client has no allocated channels available`. Channels
  were allocated on the VoiceLink account; no code change.
- The next call connected but was noise, with nothing heard from the phone: staging still ran a
  server from before PR #22, which ignored the app's `media=alaw8`, so the phone's A-law went
  unread (`browserToPstnFrames` 0) and the server's `pcm16` played as noise. After staging was
  deployed from `main`, a 39 s call carried 1820 frames up and 1884 down, none ignored.
- Staging's server reports as `OTEL_SERVICE_NAME=magick-agency`, the production name, so its alerts
  route as production. It should be `magick-agency-Staging` (`grafana/README.md`); a setting on
  the staging host, not in this repo.
- CI's first iOS build (on `main`) fails at package resolution. The fix holds Firebase on the iOS
  SDK 12 line until `google_sign_in_ios` takes GoogleSignIn-iOS 10.1 or later (`mobile.md`,
  "Builds and releases"). SwiftPM resolves the pinned set; the next iOS build on `main`, the first
  compile of the iOS code, has not confirmed it yet. The pin also moves Android back to Firebase
  BoM 34, not yet tried on a phone.

Then, so the next failure on a tester's phone can be read without their logs:

- Telemetry to PostHog when the build has `POSTHOG_KEY` (`mobile.md`, "Telemetry"): every warning
  and error the app logs (masked, capped), its exceptions with stacks, and the call events named as
  the console's, each call's end with the phone's own audio counts. Mutation-checked: 14 changes to
  the rules each turn a test red.
- Tab labels that would wrap on a narrow phone take a short name ("Stats", "Calls").

### Scaling for 500 simultaneous calls 2026-11-02 (phase A)

Manas asked on 2026-11-02 for the changes that let one host carry 400–500 simultaneous calls,
without bigger or more infrastructure. A relay bench on real `ws` sockets with the bridge's own
per-frame steps showed the audio relay as the binding constraint: one event loop carried ~55
console calls at 70% busy (the console's `pcm16` path decodes, resamples and re-encodes every
20 ms frame) and ~200 on binary A-law. Phase A is the work inside the current single-process
design; phase B (media and analysis worker processes over IPC) is the structural
step to 500.

| Area | Change | Evidence |
|---|---|---|
| Bridge transcoder (`utils/audio-fir.ts`, `audio.ts`) | Allocation-free per frame; `encodeAlaw` table-driven (64 KiB, built at load from the per-sample encoder) | Byte-identical to a frozen pre-rewrite copy (`audio-fir.reference.test.ts`, every A-law value exhaustively); ~38→8 µs down, ~80→10 µs up per frame (`scripts/bench-transcoder.ts`) |
| Console call audio | Binary A-law on the station socket (`media=alaw8`), relayed by VoiceLink with no transcode; the 16→8 kHz conversion is in the capture worklet. `pcm16` stays per tenant (`agency_console_alaw8`, default on) and as an automatic fallback (1008 `invalid_media`, or JSON media on an `alaw8` socket) | Codec pinned to the mobile app's cross-language checksums and the server's tables; headless Chromium tone check (1 kHz within 0.1 dB, 5 kHz −62 dB). Chromium only |
| Console frame bound | `pcm16` uplink payloads capped at the server's 64 KiB message bound less the JSON envelope (65 496 characters; was 128 000) | `agencyMedia.test.ts` |
| WebSocket frames | `maxPayload` 64 KiB on every WebSocket route (`WS_MAX_PAYLOAD_BYTES`, `utils/ws-limits.ts`, sized per route from `onRoute`) | `station-inbound-fuzz` `it.fails` flipped |
| Send back-pressure (`utils/ws-backpressure.ts`) | Media dropped past ~3 s of backlog (per format), control frames never; a station past 1 MiB closed 4408 `station_send_backlog`; the carrier stream has a soft limit only | `station-backpressure` `it.fails` flipped; `websocket_send_backpressure_total` |
| VoiceLink REST | Login 10 s, `add_lead` 15 s (`VOICELINK_LOGIN_TIMEOUT_MS`, `VOICELINK_ADD_LEAD_TIMEOUT_MS`). An outcome-unknown `add_lead` (timeout, or a 200 with a non-JSON body) fails and releases at once, is never retried, and the contact's redial is deferred 15 min; a late carrier media connect for it is refused | Two `voicelink-adapter-mock-carrier` `it.fails` flipped |
| Redis client (`utils/redis-options.ts`) | 2 s command timeout, 1 retry, 2 s connect timeout. A timeout is an error, never a nil, so Q6 tokens fail open on it. The agent lease renewer now stops only on `lost`, not on an `unknown` renew (it used to stop on any failure) | Stalled-Redis and nil-Redis cases, unit and integration |
| Ceilings | `MAX_CONCURRENT_CALLS` 1000 (slots are held from admission to the carrier's final report: ~860 at 500 agents); `DB_POOL_MAX` 30 with pool metrics (`db_pool_acquire_seconds`, `db_pool_clients_*`); rate limits sized for 500 agents behind one NAT, all in `api/middleware/rate-limit-defaults.ts` | Arithmetic in that module |
| Analysis worker | A slot pool (`DIALER_ANALYSIS_CONCURRENCY`, default 8) refilled as each job finishes; a recording byte budget (`DIALER_ANALYSIS_MEMORY_BUDGET_BYTES`, 512 MiB); a process-wide vendor rate-limit breaker (30 s doubling to 15 min, one probe) | Was ≤ 2 jobs a minute; 40 jobs on 4 slots drain in 0.7 s on real Postgres; two workers sharing a queue never double-claim. 500 calls needs ~330 slots: several analysis processes (phase B) |
| Pacing | One 250 ms round for every led campaign; a campaign that could reserve nothing is skipped until an event (`PacingInvalidationBus`, JSON events, in-process now, IPC-ready) or the 1 s safety tick; account limit and live calls read once per account per round; campaign row and limit cached with generation guard, event invalidation and a 2 s TTL | 50 campaigns × 10 agents: Postgres 592→128 statements/s idle, 996→191 busy (`load/pacing-statements.test.ts`); every floor suite re-run on the scheduled path (`FLOOR_SCHEDULED=1`) |

Still open from the load suites: eight integration `it.fails` (the provider-share pacing cap needs a
per-provider live-call count, which attempts do not carry). Not exercised: Firefox, Safari and Edge
on the console's A-law path, and anything against a real VoiceLink call.

### Several processes on one host 2026-11-02 (phase B, [`scaling.md`](scaling.md))

Built to carry 400–500 simultaneous calls on one host. Off by default: with `MEDIA_WORKERS` and
`ANALYSIS_WORKERS` unset the server is one process, exactly as before, and every earlier suite
runs unchanged.

- **Media workers (`MEDIA_WORKERS=N`).** The process the operator starts becomes a primary.
  - The primary accepts every request and upgrade, charges the rate limits, and hands each
    station and carrier socket, with its handle, to the worker that owns it.
  - A worker owns the sessions `slotFor(sessionId)` gives its slot. It holds their runtime state
    and relays their calls' audio; no frame crosses a process boundary.
  - Pacing, the reaper and every leader-only sweep stay in the primary.
  - Dials, session-owned internal handlers and carrier webhooks go to the owner over
    `child_process` IPC. Redis keeps only its old roles.
- **Analysis workers (`ANALYSIS_WORKERS=K`).** The analysis slot pool runs in K processes on the
  shared queue. One vendor rate limit pauses all of them, relayed by the primary.
- **Failure.** A worker that dies is reaped by slot before it is re-forked:
  - exactly the telephony slots it held are released (each admission and release is reported
    as it happens);
  - its call rows are failed, its attempts ended `orphaned` with their contacts requeued, and
    its agents written offline;
  - a crash loop makes the primary exit.

  A worker whose primary dies hangs up and exits. Shutdown stays inside the 45 s grace.
- **Measured** (shared 4-core dev machine; [`operations.md`](operations.md), "Sizing the media
  workers"):
  - one process saturates at 200 calls (ELU 0.98) and cannot bridge more than about 250 of 500;
  - with 2 workers all 500 bridge, the primary's loop stays at 0.06, and each worker runs near
    0.95;
  - 500 calls needs more than 2 vCPUs whatever the layout.
- **Evidence.**
  - The real server entry with two media workers against the mock VoiceLink carrier: calls
    dialled, bridged and relayed through the owning workers, then a graceful exit.
  - One worker SIGKILLed mid-call: the other's audio continues; the dead slot is reaped, with a
    call admitted under 1 s before the kill released by the reap, not the lock TTL; the slot
    comes back.
  - The primary SIGKILLed: the workers exit, and the next boot's startup reap closes everything.
  - The handoff with real forked workers; multi-process analysis (no double claim, a SIGKILL
    mid-job recovered without using an attempt, generation-matched requeue).
  - The mobile app's station inside a worker (`cluster/mobile-stations.test.ts`, the app
    simulated through the public API on `client=mobile&media=alaw8`): the 3 s probe and its
    pongs on the adopted socket; a silent phone terminated 10–15 s after its last sign of
    life and not dialable until back; M1 (back inside 8 s, the call resumes on the same
    worker with audio both ways; not back, it ends); `device_away` applied in the owning
    worker, at once or queued behind a call; 160-byte `alaw8` frames at 50/s both ways.
    200 calls, half on the app, 2 workers: all bridged, frames heard as expected, probe
    pings 0.34/s per phone.
  - Each guard mutation-checked.

**Not verified:**
- **Whether VoiceLink ends a call when its media socket drops**, and how fast. VoiceLink has no
  hangup endpoint, so after a media worker dies a closed media socket is the only lever on the
  customer's leg. This needs a VoiceLink sandbox check.
- Nothing has run on a real host behind nginx and the TLS terminator. Their per-frame CPU on the
  same cores is not measured.
- Trace context does not cross IPC (each process traces on its own).
- A real phone against a multi-process server: the app is simulated (a `ws` client that
  answers or withholds pongs); an OS suspending the app, a radio handover and the Flutter
  suites are not part of these runs.
- The Grafana panels and `agy-cluster-child-crash` are written and validated, not applied.

### Roster upload: choosing the duplicate column 2026-11-02

A loan book can carry one borrower twice: the same number on two rows with different loan numbers.
Deduping on the phone dropped the second loan. The mapping step now has "Check duplicates on":
phone number (the default, unchanged), any kept column, or none.

- Migration `0007_ingest_dedupe_column.sql` (`agency_ingest_jobs.dedupe_column`); contract
  `dedupe_column` on the ingest request and job, reason `duplicate_key`, failure
  `dedupe_column_missing`, and `distinct` / `distinct_phones` per analysed column, shown as
  "x% unique" under the control. Requests without `dedupe_column` behave as before.
- `claimDialable` keeps one live call per number in a campaign (skips a number `in_flight` or
  `connected` on another contact; one contact per number per tick). Proven on real Postgres
  (`agency-contact-claim-one-per-number.test.ts`) and end to end through the roster insert
  (`agency-ingest-roundtrip.test.ts`); guards mutation-checked. Widened to the whole account on
  2026-11-05 (MC4, "Several running campaigns per account" below), whose tests have not had a
  green run yet.
- Defaults and the soft-phone gap: [`decisions.md`](decisions.md) §4, "Roster upload, choosing the
  duplicate column".

### Roster upload: combining up to three duplicate columns 2026-11-10

One column is not always a unique key: a loan number can repeat across branches, and deduping on it
alone dropped the second branch's loan. "Check duplicates on" now combines up to three columns
("Combine with another column"); a row is dropped only when every chosen column matches an earlier
accepted row, and a row with any of them blank is kept.

- Migration `0031_ingest_dedupe_columns.sql` (`agency_ingest_jobs.dedupe_columns TEXT[]`, 1 to 3,
  backfilled from 0007's `dedupe_column`, which is no longer read but is still written for a
  one-column key, so a server rolled back past 0031 keeps that key; the Down fails a pending or
  running job whose key combines columns, `interrupted`, rather than run it on one column). Contract:
  `dedupe_columns` on the ingest request (the single `dedupe_column` is still accepted, as one key)
  and on the job, the insights summary and the uploads list (replacing `dedupe_column` there);
  `AGENCY_MAX_DEDUPE_COLUMNS`. The readiness check's `detail.dedupe_column` names the key as one
  label (`Loan No + Branch`). A phone-only upload sends the same request as before.
- Rule and defaults: [`decisions.md`](decisions.md) §4, "Combined duplicate key".
- Mapping screen: keys 2 and 3 under the first select, each removable while two or more remain.
  Moving the phone role onto a column that is a key swaps the two keys rather than merging them,
  so the key never loses a column (a smaller key drops more rows). A key column made the phone
  remembers itself and is that column again when the phone moves off it, so undoing a mis-set
  Phone role keeps the key. "Combine with another column" adds a column, and the phone number
  only when no other column is left. `POST /ingest/jobs` records the
  phone column named alone as the phone dedupe, not a column key.
- A fresh-context review found two existing paths that can still drop a row the operator meant to
  keep, both now stated in `decisions.md` §4 and neither changed, both kept by Manas's ruling of
  2026-11-11: a DNC-suppressed row still claims its key (pinned as ruled), and rows differing only
  in an ignored column collapse at the roster insert (the console's notes now say so).
- `REPORT_DATASET_VERSION` stays 1: the campaign dataset embeds `AgencyInsightsSummary`, whose
  `dedupe_column` became `dedupe_columns`, and the renderer reads neither. Insights still say
  "duplicates on phone" for an upload sent with no duplicate check (`dedupe_phones: false` is not on
  the uploads read); unchanged by this work.

### Contact import: check, review, import, re-import 2026-11-15 (IM1–IM7)

Reshma's asks: check a CSV and review it before anything is written, then import the checked
file; correct and re-import without duplicating anyone, with imported, skipped and rejected rows
each shown and downloadable. Rulings: [`decisions.md`](decisions.md), "Rulings of 2026-11-15:
contact import check and re-import (IM)".

- **Server.** The CSV pass asks a per-batch screen (`agency-ingest-screen.ts`: the Do Not Call
  list with its scope, and the campaign's roster through `roster-presence.repository.ts`) before
  any row claims its duplicate key; the check (`dry_run`) and the import run it alike. Rows the
  campaign already holds are skipped (`skipped`, a `skipped-rows.csv` download). `POST
  /ingest/jobs/:id/import` imports a finished check's upload with its mapping, once (24 h). One live
  import per campaign (409 `import_in_progress`). Reasons rewritten in plain words; the downloads
  in file order with the phone cell as written. A missing upload fails `upload_missing`; a missing
  download is 410.
- **Migration** `0042_ingest_check_and_skipped.sql`: `skipped`, the skipped download, `dnc_by_scope`,
  `rejected_sample`, `check_job_id` (unique).
- **Contract:** `AgencyIngestJob` gains `skipped`, `dnc_by_scope`, `rejected_sample`, the skipped
  download, `check_job_id`, `import_job_id`, `check_expires_at`; `AgencyIngestImportResponse`;
  `AgencyInsightsUpload.skipped`. Not mirrored by the agent app.
- **Console:** "Check the file" leads; the review shows the counts (ready, already in this campaign,
  rejected), the rejected rows with what to fix, both downloads and **Import N contacts**; the
  import's result says how it differs from its check. In the builder and on Add contacts. The
  activity row and Insights' upload history show rows already in the campaign.
- **Behaviour changes** (pending Manas): a top-up row whose number (or key) is already in the
  campaign is skipped rather than landed as a second contact; a Do Not Call row no longer claims
  its key (supersedes "DNC row claims its key"); a second import into a campaign while one runs
  is refused. The load suite's concurrent-import cases were rewritten for the last.
- Not done: no S3 lifecycle rule for uploads (a retention decision); the agent app has no import.
- **Fix round (review).** A NUL past the encoding probe no longer fails a check or a finished
  import (dropped from a data cell, a header carrying one refused before anything is sent). The
  rejected and skipped downloads carry the exports' spreadsheet-formula guard, which the import
  reads back off; a duplicate's reason names its row in words. A failed or cancelled import lets
  its check go (0042's index holds pending, running and completed imports only): the console offers
  **Import again** while the check is valid, and follows a check already imported to its import.
  A check held in another account is refused `check_imported_elsewhere` without that import's id;
  a schema without 0042 refuses a check's import `check_import_unavailable` (409, not a masked
  500). Analytics: a check is no longer sent as a completed import. The builder offers the same
  way back as Add contacts after a check or import that did not finish. Not done: Insights'
  upload history offers no skipped-rows download (a new field through the contract and its read).

### Wrap-up redial 2026-11-03

A connected call can drop for reasons on any side. With the campaign setting "Allow redial from
wrap-up" (`allow_wrapup_redial`, off by default), an agent in wrap-up, before saving the outcome,
can redial the same customer and is connected back to themselves, at most twice per call
(`AGENCY_WRAPUP_REDIAL_LIMIT`). Console and agent app.

- Migration `0008_wrapup_redial.sql` (the setting, `redial_of_attempt_id`, `redial_number`, one
  redial per attempt, wrap-up resolution `redialed`); contracts: the limit, the reserved
  `redialed` disposition, `redial_remaining` on the wrap-up state, `redial` on the call panel,
  six refusal codes, the agent fixtures.
- Server: `POST /proxy/agency/sessions/:id/redial` (`agency/wrapup-redial.ts`). The checks and
  the pre-dial gates run before anything is written, so a refusal (DNC, calling hours, ...) leaves
  the agent in wrap-up; the countdown stops when the redial starts; `wrapup → reserved` CAS; one
  transaction closes the original `redialed` (its outcome stays `connected`), takes the customer
  back and inserts the linked redial; the dial goes through the normal dispatcher. A redial that
  does not connect keeps the customer held and puts the agent back in wrap-up on the redial.
- Console and app: the Redial button beside the outcome pad with the redials left, the
  "Redial 1 of 2" label on the call, refusal copy, the setting toggle, the notes draft carried onto
  the redial, telemetry `agency_redial_requested` / `agency_redial_refused`.
- Proven end to end over HTTP on real Postgres and Redis with a fake carrier
  (`wrapup-redial-e2e.test.ts`: connect, redial that rings out, DNC refusal, redial that connects,
  limit, outcome, the attempt chain); the CAS on real Lua (`agency-agent-redial-cas.test.ts`);
  guards mutation-checked on every side.
- Defaults and the open question (do redials spend `max_attempts`? built as no):
  [`decisions.md`](decisions.md) §4, "Wrap-up redial", WR1–WR13. Not verified on a real carrier
  or phone.
- **Review fixes** (a fresh-context review of the whole branch, five reviewers; every fix has a
  test that went red when the fix was reverted):
  - Server: a ringing redial is not dispositionable; the settle-time park never re-parks a
    contact a disposition already released (`parkForWriteUp`; this also fixes paced calls saved
    mid-call, whose contact used to stay `connected` for ever); `/available`, force-available and
    `/leave` refuse while a redial is in flight; a station reconnect mid-wrap-up restores
    `wrapup`, so the first Redial after a reload works; an outcome-unknown redial offers no
    further redial; a wrap-up that cannot reopen holds the agent on `break`/`offline`, never the
    pool; stats count each conversation once and report `attempts_redialed` (shown under the
    campaign's dial count) and the floor's `redials`; attempt rows carry `redial_of_attempt_id` /
    `redial_number`; another session's or tenant's attempt is the same 404 as a missing one;
    Redis unavailable answers 503 `redial_blocked`.
  - Agent app: **the station's phase now follows the call** (a live attempt, then an owed
    outcome, then `agent_state`, as the console does). Before, the server's `reserved` /
    `bridged` frames never changed the screen, because the server sends no `agent_state` for
    them: a paced call stayed on the waiting screen, the notification said "Waiting for calls",
    and leaving the app mid-call could close the station socket; a redial stayed on the wrap-up
    pad. The tests had injected `agent_state` frames the server never sends; they no longer do.
    Also: the pending notes save is sent before Redial, the wrap-up clock stops once the redial
    is placed, a 10 s bound on waiting for it, honest copy when no answer came back.
  - Console: a redial that fails before ringing keeps the notes draft and the contact panel
    (`useRedialCarry`); the clock stops once the redial is placed; a disabled Redial says why;
    Redial is off on a campaign that is not dialing and after a final refusal; the system code
    `redialed` reads "Redialled" everywhere and is refused in the catalog editor.
  - Proven further by `wrapup-redial-flow.test.ts` (every path after the wrap-up is taken),
    `wrapup-redial-repository.test.ts`, `campaign-stats-redials.test.ts` and
    `contact-park-for-write-up.test.ts` (real Postgres), and `wrapup-redial-e2e.test.ts` now
    covering reconnect-then-redial, the refusals while a redial rings and a mid-call write-up.
  - Left open: a redial that never reached the carrier still uses one of the two; a campaign
    whose catalog already held the code `redialed` before 0008 keeps it (BASELINE open question
    6); after the app's 10 s bound, Save can meet a 409 if the redial was in fact placed.
- Run of 2026-11-03 after the review fixes, on `028b2ab`, one suite at a time from inside each
  package (`pnpm lint` clean in 8 packages; `pnpm test:release` 10 and `pnpm test:grafana` 32
  pass): server 7720 unit + 42 skipped; server integration, all files in one run, 1613 passed +
  9 expected fail + 4 failed, the 4 being every case of `cluster/mobile-stations.test.ts`; that
  file passes 4/4 alone and in its CI lane (`INTEGRATION_LANE=wall-clock`, 3 files, 15 passed),
  so the rest lane is 1602 + 9 expected fail. It had also timed out once in the run before the
  fixes; the cause of the failure when it runs after the whole rest lane is not found.
  *Found 2026-11-10* (it also failed once in its own CI lane): the first case read the agent's
  state once after going available, and in `pool` mode each pacing tick briefly reserves every
  available agent before finding nothing due (about 0.7% of reads locally, more on a loaded
  box); that failure skipped its `leave()`, and the phone left available took the next case's
  calls, failing all four. The case now waits for `available`, and every case's phones leave
  (and its contacts still due are deferred) in an `afterEach`; with the first case forced to
  fail, the other three now pass.
  `packages/db` 427 / 519; console 5015; contracts 252; super-admin 436; web-ui 235; domain 61;
  observability 14; app `flutter test` 1316, `agency_wire` 341, `flutter analyze` clean,
  `contracts-literals --check` up to date. The new route shifted the seeded sample of
  `hostile-input-fuzz.test.ts` case 3 onto the uplink probe, whose per-user bucket the sweep had
  spent (429, not 413); it is excluded there, its 413 being pinned in its own suite. (The
  earlier run's server unit figure, 7691, was a run with 2 failures under load; the suite was
  green alone.)

### Review fixes on the scaling branch 2026-11-03

PR #29's review (8 comments) and the defects found while fixing it. Each fix has a test that
fails on the old code and goes red when the fix is reverted.

- **Review comments.** `/readyz?detail=1` behind `READYZ_DETAIL_TOKEN` and one readiness answer
  cached 1 s (D13); the loop sampler on a fixed 5 s window, read without reset; a snapshot keeps a
  lease admitted before its call registers (the bridge owns the lease set; synchronous IPC
  handlers answer in the same turn); a worker that crashes during shutdown is reaped and counted;
  the child-crash alert sees the first crash; `fetchCdr`'s 401 retry has its own timeout;
  releasing a recording budget lease cancels its pending grow; only an outcome-unknown
  unrecorded end is held 15 min.
- **The 15 min outcome-unknown hold, made whole.** The dial is settled once (the bridge's `ended`
  no longer settles it first); a hang-up or teardown racing a slow `add_lead` keeps the contact
  claimed until the dial's outcome is known; the hold is charged to the our-fault ledger, so its
  bound retires a contact whose `add_lead` keeps timing out; the soft phone holds the same way,
  including a call orphaned by a restart; a failed hold write no longer shortens it to the
  stranded sweep's 5 min.
- **Guarded contact writes.** The reaper's requeues (`requeueOrphaned`), the lapsed-wrap-up close
  (`closeLapsedWrapup`) and the disposition route (`releaseFromDisposition`) each write in one
  statement only while the contact is still the attempt's: no newer attempt, no soft-phone claim.
  `disposition-storm.test.ts` case 5 is now an `it`.
- **Dials that fail before the carrier.** A throw after the bridge session is registered (timer,
  socket, tokens, the carrier request's inputs) tears the call down with no `ended` and is not
  charged as a carrier refusal; the contact waits 60 s instead of redialling every tick. A
  failed `provider_call_id` write no longer ends a placed call.
- **Cache invalidation channel** scoped to the Redis db (`<prefix>cache:invalidate:db<N>`):
  deployments on one Redis no longer clear each other's local caches.

**Left open** (found during the fixes; not pinned):
- A campaign dial that fails before the carrier keeps `dialed_at`, so stats count it as placed
  (the same family as the capacity-refusal row above).
- The stranded-contact sweep, which runs only after a hold write failed, holds any sent and
  unanswered dial 15 min, a plain refusal included: the attempt row cannot tell them apart.
- A hang-up followed by a plain carrier refusal is charged as our-fault `canceled`, though the
  carrier never placed the call (unchanged behaviour).
- The soft phone's 201 can carry a `dialing` row when the dial rejects before the teardown's
  `ended` arrives; the contact is still held correctly.
- A skipped first write-up (a supervisor writing up a superseded call) answers the decision's
  `contact_state`, not the contact's.
- `load/pacing-skip.test.ts` failed once in a full integration run beside other worktrees' runs
  and passed alone; the cause is not found.

### Contact assignment 2026-11-03

A supervisor assigns roster contacts to agents, agents work their own queue, agents retry or call
the contacts they did not reach, and an outcome can grant a contact an override (phases 1 and 2 of
the ask; inbound routing out of scope). Behind `agency_contact_assignment_enabled` (default off);
decisions CA1–CA15 in [`decisions.md`](decisions.md) §4, "Contact assignment". Console and agent
app.

- Migrations `0009_contact_assignment.sql` (seven campaign settings, the contact's owner, retry
  rounds and override columns, the history table `agency_contact_assignment_events`, the
  attempt's `agent_manual` / `override_applied` / `override_note`; catalog changes only, its
  contact and attempt CHECKs added `NOT VALID`) and `0010_contact_assignment_index_and_checks.sql`
  (validates those CHECKs and builds `idx_agency_contacts_assignee` in its own transaction, outside
  0009's ACCESS EXCLUSIVE), inventoried in `packages/db/BASELINE.md` and tested down and up. Contracts:
  `agency/assignment.ts`, `api/agency/assignment.ts` (eight routes, both refusal unions), the
  `queue` station frame, the disposition `override`, the roster's `assigned_to` filter, the flag,
  the permission `agency.contacts.own`, agent fixtures and Dart literals.
- Campaign settings: `assignment_mode` (`pool` / `strict` / `preferred`, changed only while draft
  or paused), `on_unstaff`, the callback grace and fallback, agent retry on/off, rounds and
  cooldown; one validator for both write paths; a retry campaign can keep the owners.
- Supervisor: preview then commit (random split, count, filter, range, reassign, rebalance,
  unassign), with a token so the commit is exactly the preview (or, for 100+ moves, within 2% of
  its counts) or `409 preview_stale`; progress per agent with
  presence and the pool; a contact's owner history; the roster's owner column, filter and CSV
  columns. Console: assignment settings in the campaign form, the assignment dialog from the
  roster selection or the filter, progress on the campaign page.
- Pacing: `strict` / `preferred` pair by agent in one statement; an agent with nothing due is not
  reserved and is told why (`queue` frame, bootstrap, `ready`, the My contacts summary: one
  reading; in `preferred` a due pool contact reads due only for the agent pacing gives it to, and
  the frame is sent again after every `ready`); due callbacks whose owner is away past the grace
  fall back to the pool (leader sweep, run beside the tick, never awaited by it).
- Agent: My contacts on the console (a panel from the station header) and the app (a page from
  the campaign card and the waiting screen): counts, "Retry not reached (N)", the contacts in due
  order with bucket and number filters, and Call, which places the call on the campaign's normal
  path with `agent_manual` on the attempt.
- Outcomes: a catalog entry's `override` (extra attempts 1–5, retry delay, calling hours with a
  note) is granted when it is recorded and spent at exhaustion (extra attempts) or by the agent's
  call (the other two); a pooled callback goes to the agent who took it. DNC wins everywhere. The
  soft phone refuses another agent's contact on a `strict` campaign (`contact_assigned_elsewhere`).
- Unstaff on all three paths returns the agent's open contacts to the pool (or keeps them), audited;
  the pacing leader's owner sweep returns what was on a call then, once it settles.
- A fresh-context review in three parts (data and pacing, routes and wire, clients and docs) found
  and this branch fixed: the agent's per-contact call ignored the `agency_dialer_enabled` kill
  switch; agent retry reopened contacts on a completed campaign; contacts on a call at an unstaff
  were stranded with the former agent; `count` handed out closed contacts and `range` moved them;
  preview then commit almost never succeeded on a running campaign (now a bounded 2% drift for
  100+ moves); an unanswered callback stayed a callback; a retry campaign copied owners nobody
  staffed; a campaign that used the feature could not be saved, or set back, once the flag was
  turned off; the calling-hours note prompt never appeared on either client (it waited for a
  refusal the server does not send); and smaller client parity, focus and copy issues. Each fix
  has a test that was mutation-checked.
- Built in six parallel lanes over one foundation (migration, contracts, the shared bucket and
  eligibility SQL), then integrated: the agent's actions moved into the assignment route family,
  and the My contacts summary reads the pacing probe's queue so it cannot disagree with the
  station. Every lane's guard tests were mutation-checked (owner predicate, live skip, split seed,
  agent-dial 404, the queue reading).
- Scale, measured once on a throwaway 1M-contact roster: a random-split preview 5.4 s, progress
  0.8 s, an agent's summary 0.28 s and list 0.26 s; a commit moving all 1M contacts took about
  177 s (the bare UPDATE alone is 80 s on that disk). Batching very large commits is the next step
  if a roster that size is assigned in one operation.
- **Left open** (none blocks the flag staying off): unstaffing does not end the agent's open
  session (in `preferred` mode they can still take pool contacts until they leave; the owner
  sweep returns anything they are left holding); the pacing probe ignores the one-live-call per
  number rule (an agent can be reserved and then get nothing that tick, and is returned); in
  `strict` mode a callback that falls back waits for a supervisor (CA5); the summary has no next
  callback time; the console's per-contact history client is unused; and the three follow-ups
  below. Not verified on a real carrier or phone.
- **Follow-up: extra attempts on the soft phone and the lapsed wrap-up.** An outcome-granted
  extra attempt (CA8) is spent only where a paced or agent-dialled call settles
  (`agency/dialer/contact-settlement.ts` → `markExhaustedOrSpendExtraAttempt`). Two other writes
  can exhaust a contact for `max_attempts` and do not look at the grant: the soft phone's
  `settleFromManual` (`contact.repository.ts`) and the reaper's `sweepLapsedWrapups` →
  `closeLapsedWrapup` (an agent left wrap-up without saving an outcome). There the contact ends
  `exhausted` one attempt early with its grant unused. Nothing is dialled that should not be,
  nothing is stranded, DNC is unaffected, and the agent can still reopen it ("Retry not reached":
  exhausted contacts are eligible); a granted contact reaching its last attempt on either path
  is rare. Fix: route both through the same spend when the decision is `exhausted` for
  `max_attempts`, with the once-per-attempt guard. The soft phone needs care: a manual call is
  not an `agency_call_attempts` row, where `override_applied` (the guard) lives today, and its
  settlement has its own rulings (SP1–SP7). About a day with tests.
- **Follow-up: the roster has no bucket filter.** My contacts and the progress panel put each
  contact in one of seven buckets, computed by `contactBucketSql` from several columns (state,
  last outcome, last disposition, attempt count, the DNC mark). The roster's filters
  (`contactFilterConditions`, `query-builders.ts`) are raw columns only, so the progress panel's
  links (`CampaignAssignmentProgress.tsx`) map a bucket to roster states
  (`BUCKET_ROSTER_STATES`), and `pending`, `callback` and `not_reached` all map to state
  `pending`: "12 not reached" opens that agent's pending contacts, the 12 plus their callbacks and
  never-attempted ones. A superset, never a wrong row; the other four buckets map one to one, and
  the agent's own My contacts list filters by bucket exactly. Fix: an optional `bucket` roster
  filter built on `contactBucketSql` (so it cannot disagree with the counts) and the links
  pointed at it. It touches the shared filter (also the CSV export and the spine) and its
  contract; the retry selector must refuse it, as it refuses `assigned_to`.
- **Follow-up: the owner on roster replace (waits on B15).** Replace and clear are refused (B15:
  `supersedeRoster` throws `unsupported`, behind `AGENCY_ROSTER_REPLACE_ENABLED`, off; the
  console sends neither), so the ask's "superseded contacts lose their assignment" (CA11) has
  nothing to act on: uploaded rows always land unassigned, an append leaves owners alone, and
  owners carry over only into a retry campaign with `keep_assignments` (owners still staffed on
  the parent). When B15 is built, its replace must clear `assigned_user_id` /
  `assigned_at` / `assigned_by_user_id` on every contact it retires and write one
  `agency_contact_assignment_events` row each, in the replace transaction, under one batch id.
  That needs a new reason (e.g. `superseded`), which is a CHECK change
  (`ck_agency_assignment_event_reason`) in a new migration.
- **Cleanup pass 2026-11-04 (behaviour unchanged).**
  - **Shared SQL.** The "open contact", "number is live" and phone-digits terms are each
    defined once (`assignment-sql.ts`, `sql-fragments.ts`), and so are the agent-retry settings
    and their binding. Both owner sweeps share one return-to-pool statement, one audit and log
    helper, and one loop in the pacing engine.
  - **Server routes and reads.** One refusal-body helper (`api/routes/helpers/refusal.ts`).
    Reads that don't depend on each other now run together: agent scope, supervisor scope, the
    My contacts summary, the session bootstrap, station connect and start-call. The retry route
    reads the parent campaign once (`ownedCoreCampaignOnce`).
  - **Database work.** My contacts reads each page row's last attempt once. A `nothing_due`
    tick that saw an open contact skips the completion count.
  - **Contract.** The operation limits are exported from the contract and used by the server
    and the console. The assignment override-note limits are aliases of the soft phone's, and
    one note check serves both.
  - **Clients.** The console uses `useDialogFocus`, `formatCount`/`plural`, `errorBody` and
    `useAsyncResource`. It no longer re-reads the summary on a filter change or staffing after
    a commit. The mobile app shares the soft phone's note check, `EnIn.count` and
    `humaniseCode`.
- **Left as found by that pass (each would change behaviour or reach well past the feature):**
  - **DNC rows can be moved.** Reassign, unassign, the unstaff return and both owner sweeps move
    any `pending` contact, including a DNC-marked one. Count and range moves take open rows only.
    Whether a DNC row should keep or change its owner is undecided.
  - **Wrap-up redial and the kill switch.** Redial (`wrapup-redial-rules.ts`) checks only that
    the campaign is `running`, not `agency_dialer_enabled`. This predates this feature. The fix
    is one `campaignMayDial` rule shared with pacing and start-call.
  - **Where CA9 compares stored values.** The public layer reads the stored campaign to compare
    the request against it. The internal PATCH handler already has that row, so the compare and
    the mode-change audit belong there; that also removes a race against the write.
  - **CA7 call gate on the clients.** The console (`contactCallGate`) and the app
    (`canCallContact`) each re-derive the call gate from row fields. The server could send the
    call basis on each row instead.
  - **"Note required" has no code of its own.** The server signals it with
    `400 override_note_invalid`, and both clients detect it as that code plus no note sent. A
    separate `override_note_required` would be a wire change.
  - **Roster holder names.** The roster takes holder names from the full progress read. A
    lightweight holders read would be cheaper.
  - **Hero columns.** The server's hero-column rule (`heroColumns`) ignores case and spacing
    differences that the console's `resolveContextFields` handles. One rule in
    `packages/domain` would fix it.
  - **Idle pacing ticks.** A `nothing_due` tick never goes idle. The engine could sleep until
    the probe's earliest `next_due_at`, which is a change to the wake logic.
  - **Extra-attempt spend guards.** CA8's spend has two idempotency guards in
    `contact.repository.ts`: a SQL `NOT … = ANY` versus a pre-read with `FOR UPDATE`.
  - **`returnOnUnstaff` is unlike the sweeps.** It does not set `updated_at`; the sweeps do.

### Campaign insights 2026-11-04 (IN1–IN12, [`insights.md`](insights.md))

One Insights tab per campaign at `/agency/campaigns/:id/insights` (`agency.supervise`), replacing
Overview and Performance, whose URLs redirect to it: the campaign's whole health in every status,
and every number opens the Contacts or Call attempts list whose total is that number. ClickUp
"Campaign insights page"; the data mapping and IN1–IN8 signed off by Manas; IN9–IN12 are the
build's own calls, defaults pending Manas (`decisions.md` §4).

- Migrations: `0011_insights_foundation.sql` (`agent_reopened` on attempts, `dials_placed` on
  contacts kept by a trigger, the read indexes), `0012_insights_rollup.sql` (the rollup tables,
  dirty-bucket triggers, backfill), `0013_insights_pacing_history.sql` (pacing history per
  campaign per minute, the reopen marker), `0014_insights_rollup_first_dials_carrier_errors.sql`
  (the connect-rate measures, carrier errors). All inventoried in `packages/db/BASELINE.md` and
  tested down and up. Wire: `packages/contracts/src/api/agency/insights.ts`; the spine lists gain
  drill-down filters and an opt-in exact `total`. No mobile wire shape changed.
- Seven routes under `/proxy/agency/campaigns/:id/insights/`: `summary`, `readiness`, `allocation`,
  `uploads` (as of now, from `agency_contacts` through a covering index) and `activity`, `trends`,
  `health` (a range, from the rollup, the agent session events and the pacing history). Guards:
  session, `agency.supervise`, the dialer flag, a UUID id, the ownership probe; an in-process
  single-flight cache below them.
- The rollup: per campaign per 15-minute UTC bucket, recomputed from the attempts by a job in the
  main process every 15 s (`agency.insightsRollup`), never incremented; an oracle test holds every
  read to the attempts table. Pacing history: the pacing leader's per-minute counters, flushed
  every 15 s, best effort. Five warning alerts and four dashboard panels (`grafana/`), with
  runbooks in `operations.md`.
- Start-recording writes and the mapping's defects, fixed first (IN8): `/stats` `contacts_connected`;
  `created_by` from the actor; `agency_campaign.config_changed` and roster-upload audit rows; stale
  comments; one connect rate across the product, human connects ÷ placed first dials (IN10;
  `/stats`, the agent record and Insights pinned equal by `agency-connect-rate.test.ts`).
- Scale, 1M contacts or 1M attempts in one campaign: lifetime rollup reads 0.15–0.25 s; activity
  1.2 s and trends 1.0 s end to end over 30 days (the agent-state and callback reads are the slow
  part); a running campaign's summary 2.5–2.9 s, cached for four times its cost; drill-down totals
  0.1–0.3 s. The attempt triggers add ~85 µs per attempt write and the dial counter ~0.33 ms per
  placed dial.
- Built in parallel lanes (foundation, defects, rollup, pacing history, console, as-of-now API,
  drill-downs, range API), then a fresh-context review of the whole branch. It found no blocker;
  this branch fixed what it found: a flaky plan test; the connect rate counted three ways; IN4's
  closed-first rule; the account ownership guard untested; an unbounded lifetime range (now the
  last 92 days, IN12); four links untested and two whose lists did not match; the reaper's failed
  uploads unaudited; dead code; stale docs; no alerts on the new metrics. Every fix has a
  mutation-checked test.
- **One connect rate on every surface, per campaign too:** `by_campaign[]` rows on the agent
  record carry `human_connects`, `first_dials`, `connect_rate_pct` and `rates_reportable` (the
  roster's floor on first dials, decided by the server), and `/stats` serves
  `first_dials_placed`. The console's agent page and the agent app's Performance screen print each
  campaign's rate as served ("All campaigns" shows the overall rate in the headline and each
  campaign's in the breakdown; a picked campaign shows its own), withheld where the row is not
  reportable (neither client applies the threshold); the
  campaign Performance card prints "N people answered, of M first dials placed". The app's decoder
  takes rows without the counts (an older server) and shows a dash, never a derived rate.
- **Left open:** `health.analysis` is not served (no index-driven read of a range's analysed calls;
  needs a rollup facet or an index; a TODO in `insights/health.ts`); the mapping's "waiting for
  calling hours" bucket (needs `timezone` in the covering index, a concurrent rebuild over the
  roster; a TODO in `insights/roster.ts`); override notes in the Call attempts list (the attempt
  row is mobile wire; the list filter `override_applied` exists; accepted as is); Grafana rules
  applied with the rest of `grafana/` (never applied; Manas applies them by hand); the summary's
  cost on a 1M running campaign (2.5–2.9 s, cached) if the page is kept open on many campaigns at
  once; the console's analytics floor `RATE_MIN_ATTEMPTS` still floors `attempts_total`, not the connect
  rate's placed first dials (`/stats` now serves `first_dials_placed`, so moving it is a small
  change; not made here); and at a window edge a cell's
  `success_rate_reportable` can hold while `rates_reportable` does not (a redial's conversation in
  the window, its first dial before it), so a cell should gate on both.

### Abandonment ceiling in the console 2026-11-05 (AC1–AC3)

ClickUp "Campaign builder: let the supervisor set the abandonment ceiling by dragging a line
(default 3%)". On 3 Nov two staging campaigns paused at 3.1–6.1% (2 abandoned of 33–64 answered)
and the supervisor could not change the 3% ceiling: the server took `abandonment_ceiling_pct` on
create and PATCH, but the console only displayed it.

- The builder's "How agents work" step and the settings page's Behaviour section show an
  abandonment meter on a fixed 0–10% scale whose ceiling line is a slider (drag, or arrow, Page and
  Home/End keys), beside a "Pause above (%)" box. Default 3%, offered 0.5–10% in steps of 0.1,
  an amber note above 3%. Sent on every config save; in the builder summary and review. Insights
  draws the same meter with the rolling 24-hour rate as the fill (`AbandonmentMeter`,
  `utils/agency/abandonmentCeiling.ts`). `AgencyCampaign` gains the field.
- Review fixes, same day. A stored value outside the offered range (set through the API, e.g. 25
  or 7.25) is kept as stored and no longer disables Save for other edits; only a change must land
  in 0.5–10 with one decimal (AC1). The ceiling prints to two decimals wherever it is shown
  (`ceilingPctText`: field, meter, summary, Insights KPI, trend and settings panel); rates stay on
  `pct()`. Insights' read-only meter grows its scale to the next multiple of 5 when the ceiling or
  the 24-hour rate is above 10% (`insightsScaleMaxPct`); the editable one stays on 0–10%. The
  builder's create now carries the value when it is valid, so a draft created by an early roster
  upload keeps the moved line. The fill, and the Insights headline's "bad" tone, turn red only
  above the ceiling, as the guardrail pauses (`measured <= ceiling` continues); the headline's
  80% warning no longer misses a rate of exactly 80% of the ceiling to floating point. Users without `agency.campaigns.write` see the meter as a
  picture and the box disabled. Also: the slider's bounds take in an out-of-range stored value
  and a key away from the range leaves it alone; one pointer owns a drag (lost capture ends it); a
  server error on the field retires once the value changes; the amber note is in both controls'
  `aria-describedby`; the track has an inset edge (visible on the Insights tile) and only the end
  ticks are labelled on a narrow meter; `agency_campaign_config_saved` carries
  `abandonment_ceiling_pct`. A simplify pass then moved the 3% default into the contract
  (`AGENCY_DEFAULT_ABANDONMENT_CEILING_PCT` in `campaign-defaults.ts`, which the server's
  `DEFAULT_ABANDONMENT_CEILING_PCT` now re-exports), so the console keeps no copy of it; the
  health strip prints the ceiling to two decimals too; one `rateAboveCeiling` / `abandonmentTone`
  rule serves the meter and the headline.
- The only server change is `campaign-thresholds.ts` re-exporting the contract's default (same
  value). Server tests now pin create and PATCH through the public routes,
  refused values, the `config_changed` row (`{ from: 3, to: 4.5 }`), the 403 for agent, viewer and
  operator, and the guardrail pausing at a supervisor-set ceiling end to end
  (`agency-campaign-abandonment-ceiling.test.ts`).
- **Left open:** the public routes do not validate the field themselves; the internal handler's
  400 is forwarded unchanged (pinned in `campaign-config-route.test.ts`). The small-sample rule
  still pauses on 2 abandoned of 33 answered; a minimum-answered floor is a separate task if wanted.
  The retry dialog offers no ceiling override (a retry inherits its parent's; the server would take
  one in `config_overrides`).
- Counts, 2026-11-05: `apps/console` 5211 (272 files) after the review fixes and the simplify pass (5173 before), lint
  clean; `packages/contracts` 281, `contracts-literals --check` up to date; `apps/server` lint clean, the two changed unit files 119,
  rest lane 1937 passed + 9 expected fail + 1 skipped (199 files + 1 skipped). The wall-clock lane,
  the full server unit suite and the Dart tests were not run (no file of theirs changed; Dart is
  not installed on the build container).

### Several running campaigns per account 2026-11-05 (MC1–MC7)

ClickUp "Allow multiple running campaigns per account within the account's concurrency limit". An
account could run one campaign at a time (`uq_agency_campaign_running`; Start and Resume answered
409 `another_campaign_running`). Design and defaults: [`decisions.md`](decisions.md) §4, "Several
running campaigns per account". Built and documented; **not yet verified**: no test run of this
work is recorded (see the last bullet).

- Migration `0015` drops `uq_agency_campaign_running`; the `another_campaign_running` code is
  retired from `packages/contracts` (MC6). Agent exclusivity is unchanged: one live session per
  agent per tenant.
- The pacing round splits the account's `max_concurrent_calls` between its running campaigns,
  fewest live calls first, a campaign that cannot use its share leaving it to the others; before,
  the round's headroom went to whichever tick drew on it first (MC1, MC2). Every campaign a round
  starts joins its account's split (a stopping or not-running one without contending). The split
  runs once every member has reported, or 1 s after the account's first report without the slow
  ones, and stays open until every member has reported or withdrawn or its 5 s deadline closes it
  (with a warning); rounds start none of the account's campaigns while it is open. A member
  reporting while it is open after it ran gets `min(demand, leftover)`, first come first served,
  so a slow sibling is served rather than starved; one reporting after the close gets 0 and is
  served by the next split. A pending-dial ledger per account carries the dials a split granted
  and not yet inserted into every later live read, so overlapping rounds cannot grant the same
  headroom twice; a hold with no progress for 60 s stops counting, with a warning (MC2). A
  campaign held back by the share while the account had headroom keeps ticking every round, and
  one that claimed fewer contacts than it was granted has its demand capped at what it claimed
  (at least 1) until it fills a grant (MC5). With one running campaign the rule is unchanged.
  While two processes lead campaigns of one account (a leader failover or a deploy overlap) each
  can split the account's headroom, the concurrency guard refusing the excess; open with Manas
  (MC3, `decisions.md` §5).
- The one-live-call-per-number check spans the whole account, not one campaign (MC4): pacing's
  claim, the agent's own dial, and the soft phone's dials, tagged ones included (`in_flight` only,
  `softphone.md` §4.1). The races that remain are in `decisions.md` §5.
- Visibility (MC7): campaign stats carry `concurrency`, shown on the console's campaign cards and
  detail page (the equal share is left out when more campaigns run than the account has lines:
  "3 campaigns share 2 lines"). Metrics `agency_campaign_slots_in_use` and
  `agency_campaign_slots_allocated` (set only after a contended report to the split) and
  `agency_pacing_share_withheld_total` (contention); the dashboard's *Agency dialer* row gains two
  *Pacing Share* panels (slots in use against allocated per campaign, and slots withheld per
  campaign); a new warning, `agy-pacing-share-starved`, fires when a campaign with no live call has
  been withheld slots for 10 minutes (runbook in [`operations.md`](operations.md)). The new series
  carry only `campaign_id` (`grafana/README.md`, "Known metric gaps").
- Counts: pending the first green run. No unit, integration, lint or `pnpm test:grafana` run of
  this work is recorded, so the case counts beside its test files in [`modules.md`](modules.md)
  are read from the source, not from a run, and nothing here claims a pass.

### Customer history 2026-11-06 (CH1–CH13, [`customer-history.md`](customer-history.md))

ClickUp "Customer history: search one phone number and see every interaction across the tenant's
campaigns". Built on the server, the console and the agent app (`001c3b6`), then reviewed and fixed
the same day; Manas's decisions CH1–CH5 as asked, the build's own calls CH6–CH13.

- **Number rule** (CH4, CH5): `packages/domain/src/customer-search-number.ts`, run by the
  console's preview and the server's search, with a Dart port in `agency_wire`; one table
  (`fixtures/agent/customer-search-numbers.json`) holds all three. Full numbers only; validity is
  judged on length, not on a mobile prefix.
- **Server**: `POST /proxy/agency/customers/{search,timeline,export}` and
  `GET /proxy/agency/customers/options` (the picker's default calling code) in
  `proxy-agency-customers`, permission `agency.customer_history.read` (agent floor), every read
  bound to the caller's accounts in SQL and on an index (migration `0016` adds the soft-phone
  destination index, `0017` the roster index), a 30-minute search id so the number never reaches a URL, audit rows for every
  successful search and export, a per-user cap (30 a minute) whose 429 carries the friendly
  message. Each timeline page is one keyset query per source; the summary is built once from
  aggregates; the export is one page as large as its cap.
- **PR #50 review fixes**: the history covers a number's newest 2,000 roster rows everywhere
  (CH14, migration `0017`: a per-account index walk that stops at the cap, so a placeholder on
  200,000 rows no longer makes every search, page and export read all of them); a callback entry
  is paged on its call's `created_at`, so a re-booking between pages no longer skips or repeats it;
  the booker's name comes with the booking (one round trip fewer per search); the export's count is
  the search's own (`callStats` and the DNC reads), its separate count statement gone. Only accounts
  with the agency dialer on are read (the flag is a data boundary, CH2); a platform default calling
  code that is not one of the listed countries is its own picker entry and follows the roster
  ingest's rule (no longer India); the console re-reads the default after a failed read; the
  hero-field rule has one copy (`packages/domain/src/context-hero.ts`), the contact panel's
  differences expressed as options.
- **Review fixes** (same day): campaign DNC marks scoped through their campaign's account (an
  account-B viewer saw account A's mark before); hero fields by the contact panel's rule
  (`packages/domain/src/context-hero.ts`); the upload file of a tenant-level uploader found; only
  unspent overrides, with their follow-up; "Recording expired" only when a recording was asked for;
  queued attempts no longer live; real keyset paging; the roster-row cap reported
  (`contacts_truncated`); unknown countries and non-JSON bodies refused with the family's code; the
  console's and the app's behaviour as in `customer-history.md` §5.
- **Measured** (spec §6): on a 1,000,020-contact tenant with the number on 20 campaigns and 580
  calls, a search (summary and first page) takes 15.1 ms median / 17.6 ms p95 for a tenant-level
  owner and 6.3 / 10.2 ms for an account-scoped supervisor; a later page 4–5 ms; no full scan in
  any plan (`customer-history.md` §4, `apps/server/scripts/bench-customer-history.ts`).
- **Console**: a phone number typed into the console's search (top bar field or ⌘K, B28), and a
  "Search a number" entry in the agent navigation; the page at `/agency/customers` and `/dialer/customers`.
- **Agent app**: the search and the page from My calls, with every console filter (the channel and
  connected-only on the page, the rest in a sheet) and a copy button; no CSV export (CH13). First
  run under Dart and Flutter by the mobile CI job on PR #50 (`flutter analyze`, `flutter test`,
  `agency_wire` `dart test` 493, the Android build), green; the review fixes after it are checked by
  the job's next run.
- **Found, not fixed** (CH12 e): the roster ingest keeps a bracketed trunk `(0)` that the search
  and the soft phone drop, so `+44 (0)20 …` typed in a roster is not found; pinned `it.fails`.
- **Not shown** (CH12 a): DNC removals (a hard delete whose audit row carries no number).
- **Inferred, not stored** (CH12 b): the upload file a contact came from is the campaign's import
  whose run window covers the contact's creation; no column links them.
- **Never "Removed from roster"** (CH12 c): roster replace does not remove contacts (B15, no
  supersede), so the history never shows a row as removed.

### Dedicated caller ID per agent 2026-11-06 (DN1–DN10)

ClickUp "Dedicated caller ID per agent allocation". A supervisor dedicates one of a campaign's
caller IDs to an agent staffed on it, and every dial to a contact that agent owns on the campaign
goes out from that number. Design and defaults: [`decisions.md`](decisions.md) §4, "Dedicated
caller ID per agent". Server, db, contracts and console.

- Migration `0018_agent_caller_ids.sql`: `agency_campaign_agent_caller_ids`, one number per agent
  and one agent per number on a campaign (DN1). A row counts only while its agent is staffed on
  the campaign and was set since that staffing began (`EFFECTIVE_DEDICATION_SQL`, every read), so
  a row an unstaff left behind never dials, blocks or revives.
- One rule for every dial path, `resolveCallerId` (`agency/pacing/caller-id-pool.ts`): the
  contact owner's dedicated number while the campaign still has it, else the rotation (the usable
  numbers minus the dedicated ones, or all of them when every one is dedicated). Every dial path
  reads the campaign's dedications from one per-campaign cache (`DedicatedCallerIdCache`, 2 s TTL,
  invalidated by `dedications_changed`, which the PUT, the DELETE and every unstaff publish; read
  through in a media worker). Pacing reads them once per dialling batch, before it reserves an
  agent or claims a contact (a failed read dials nothing, records the idle reason
  `dedications_unavailable` and logs, throttled per campaign, once a minute while it keeps
  failing); the agent's own call and the wrap-up redial (WR7's "same number" kept only while it is
  in the rotation) ask its `callerIdForContact`, and the soft phone tagged to a campaign feeds its
  map to `selectCallerId` (DN2–DN4).
- The soft phone tagged to a campaign refuses a caller ID outside the campaign's set as before.
  An in-set request goes through the same rule as the redial's previous number: the matched
  contact owner's dedicated number whatever was requested, else the requested number while it is
  in the rotation, else the rotation's pick, so another agent's dedicated number never goes out
  for a contact that is not theirs (the mobile app sends the campaign's first caller ID by
  default; the console's tagged default is Automatic, sending none). The response's `caller_id`
  says which number was dialled.
- Supervisor routes `GET /campaigns/:id/agent-caller-ids`, `PUT` / `DELETE
  /campaigns/:id/agents/:userId/caller-id` beside the contact-assignment routes; audited
  `agency_campaign.agent_caller_id_set` / `_cleared` (DN5, DN10). Only the PUT is behind
  `agency_contact_assignment_enabled` (403 `assignment_disabled`); the list and the release work
  with the flag off, so a dedication made while it was on can be seen and released (DN9). The PUT
  checks the staffing and the campaign's caller IDs inside its transaction, under locks an
  unstaff and a campaign PATCH meet. The campaign PATCH refuses to drop a dedicated number
  (`caller_id_dedicated`, DN6), checked under the campaign row's lock.
- Unstaff releases the number on all three paths whatever `on_unstaff` says (DN7), except on a
  campaign the agent has been staffed on again by the time the release runs; it audits only a
  number that was effective on the staffing that closed, and deletes an older stale row silently.
- The agent's My contacts summary carries `caller_id` (null when the read fails, with a warning,
  rather than failing the summary). The console's campaign Agents tab sets and releases the
  numbers; the agent's My contacts panel names theirs.
- Counts (2026-11-06, from inside each package): `apps/server` unit 8207 passed + 42 skipped (410 files), rest lane
  2022 passed + 9 expected fail + 1 skipped (206 files + 1 skipped), wall-clock lane 15 (3 files); `packages/db` unit 428 (25 files), integration 573 (55 files);
  `packages/contracts` 301 (11 files), `contracts-literals --check` up to date; `apps/console`
  5434 (284 files); `apps/super-admin` 446, `packages/web-ui` 235, `packages/domain` 61,
  `packages/observability` 14; `pnpm lint` clean at the root; `pnpm test:grafana` 33 and
  `pnpm test:release` 10 pass; console and server builds clean. Under full-suite load a
  plan-shape assertion (`agency/insights-reads.test.ts`, `db/attempt-indexes-migration.test.ts`)
  and a media WebSocket load case (`load/voicelink-media-ws-load.test.ts`) have each failed once;
  all three pass alone (3 of 3) and in the full rerun these counts come from, and none touches
  this feature's code.
- Not run: the mobile app's `agency_wire` `dart test` (no Dart toolchain on the build machine;
  the summary fixture gained `caller_id`, which the Dart decoder ignores as an unknown key).
- Follow-ups ([`decisions.md`](decisions.md) §5): per-number concurrency (`phone_numbers.max_concurrent_calls`
  is enforced on no dial path, and a dedication concentrates traffic on one number); the mobile
  app omitting `caller_id` by default (its `caller_ids[0]` default is now kept only while it is in
  the rotation) and showing the agent's dedicated number.

### Automatic outcomes for unanswered calls 2026-11-07 (OD1–OD8)

For calls nobody answered, a campaign files an outcome chosen in advance (busy → "Retry later",
no answer → "Callback"), so agents and supervisors reading the call later know what to do with
it. Set in the campaign builder and settings ("Unanswered calls"). Design and defaults:
[`decisions.md`](decisions.md) §4, "Automatic outcomes for unanswered calls". OD1 (a label
only) is Manas's choice of 2026-11-07; OD2–OD8 are defaults pending ratification. Server, db,
domain, contracts and console.

- Migration `0022_outcome_dispositions.sql`: `agency_campaigns.outcome_dispositions` (JSONB
  object, `{}` maps nothing) and `agency_call_attempts.auto_disposition_code` (CHECK: only on
  `no_answer`, `busy`, `failed`, `invalid`, `abandoned`; added NOT VALID, every existing row
  being NULL).
- The dialer stamps the mapped code on the attempt when it settles on the customer's ledger
  (`settleContact`), beside the contact's charge, in one guarded statement; a failed stamp is
  logged and never holds up the contact. The contact is routed exactly as without a mapping:
  `disposition_code` and `last_disposition` stay what a person recorded, so no rate, count,
  filter or wrap-up rule changes (OD1, OD4, OD5). Not stamped: connected calls, wrap-up
  redials, our-fault outcomes, outcome-unknown dials, pre-carrier failures, the soft phone (OD7).
- One rule decides which catalog codes may be mapped (`packages/domain/src/auto-disposition.ts`:
  in the catalog, neither suppress nor terminal), run by the server's validator, the dialer's
  re-check and the console. The internal handler checks every create, PATCH and retry override
  against the stored campaign (or parent), so a catalog edit that would break a mapping is
  refused, keyed on the mapping (OD6); retry campaigns inherit the map (OD8).
- Reads: the attempt lists and their CSV (column `auto_disposition_code`), the supervisor's call page, the
  agent's calls, the station's prior attempts (and the soft phone's), and the customer-history
  timeline (its CSV export adds it to "Details"). The console tags it "(automatic)", secondary
  under a write-up; the builder's editor offers only eligible outcomes, keeps a stale mapping
  visible with its error, and follows a mapped code through every edit of its catalog row.
- VoiceLink reports a switched-off handset as Busy; a declined call arrives as Busy or No
  answer, depending on what the carrier reports (OD2). The console says so beside the editor.
- Reviewed with fresh context and by a four-angle clean-up pass; every finding fixed or
  recorded (§5 open questions: where else the label shows, the mobile app, the label on an
  exhausting or `invalid` attempt).
- Counts (2026-11-07, from inside each package, one green run): `apps/server` unit 8318 passed
  + 1 expected fail + 42 skipped (418 files), rest lane 2131 passed + 9 expected fail + 1
  skipped (211 files + 1 skipped), wall-clock lane 15 (3 files); `packages/db` unit 428 (25
  files), integration 586 (58 files); `packages/contracts` 334 (11 files),
  `contracts-literals --check` up to date; `packages/domain` 142 (9 files); `apps/console` 5644
  (293 files); `apps/super-admin` 446, `packages/web-ui` 235, `packages/observability` 14;
  `pnpm lint` clean at the root; `pnpm test:grafana` 33 and `pnpm test:release` 10 pass; builds
  clean. Earlier runs of the rest lane each had one load-sensitive failure that passed alone and
  touches none of this feature's code (`load/voicelink-media-ws-load.test.ts`,
  `cache/local-cache-invalidation.test.ts`); the run these counts come from had none.
- Not run: the mobile app's `agency_wire` `dart test` (no Dart toolchain on the build machine).
  The contract change adds only optional fields, which the Dart decoders, reading by name,
  never read.

### Reports 2026-11-08 (RP1–RP16, [`reports.md`](reports.md))

Agent performance reviews, campaign reports and account reports as a PDF and an Excel workbook,
built outside the dialer process, run ad hoc or delivered on a schedule, behind the flag
`agency_reports_enabled`. Designed and reviewed the same day (the design was revised after an
independent review), then built in parallel workstreams, integrated, reviewed again by three
independent reviewers (no blockers; every minor finding fixed with a test or stated) and re-run.

| Area | What was built |
|---|---|
| Contracts | `src/api/agency/reports.ts` (runs, subscriptions, the window rule `reportWindowProblem`, error codes) and `src/reports/` (the versioned `ReportDataset` per kind, reusing the screens' wire types; the render message, the signed callback, file names) |
| Database | `0023_reports.sql`: `report_runs`, `report_subscriptions`, and an agent-first sessions index; repositories with fenced claims (`claim_generation`, `render_attempt`), a per-tenant pending limit and subscription claims that create the run and advance `next_run_at` in one transaction |
| Datasets | Agent, campaign and account builders that read with the screens' own code; an oracle suite holds every figure to the screen's response for the same window; the `self` audience drops floor bands, call analysis and recording columns and masks phone numbers |
| Pipeline | The assembler (detail sheets streamed to S3, capped at 100,000 rows), SQS or in-process rendering, the signed and attempt-fenced callback `POST /webhooks/reports/rendered`, the reports tick (subscriptions with catch-up, reconcile of lost messages, the report-ready email, expiry), routes `/proxy/agency/reports*` and `/proxy/agency/report-subscriptions*`, audit, metrics |
| Renderer | `apps/report-renderer` (component `report-renderer`): React → HTML → headless Chromium for the PDF (fonts embedded, outside requests blocked), exceljs streaming for the workbook, a Lambda handler with its zip build |
| Console | Reports page (history, subscriptions), one run's page, the export dialog and its entry points (agent record, My performance, Insights, Analytics) |
| Infrastructure | `aws/terraform/reports.tf` behind `enable_reports` (queue, dead-letter queue, Lambda and alias, least-privilege role, lifecycle rules), three Grafana alert rules and a dashboard row |

**Not verified here:** a real AWS run (SQS, the Lambda with the `@sparticuz/chromium` layer, S3
lifecycle), `docker build` of either image, the mobile `agency_wire` Dart tests (Dart was not
installed; the only contract fixture change is a new flag in `platform.json`), and the Grafana
module's `terraform validate` (its provider download timed out; `fmt` passed). CI has not run on
this branch: every count below is a local run, so the renderer's PDF suite on GitHub's runner,
`build-lambda.mjs` in CI and the `mobile.yml` job are unproven until the branch is pushed.

### Inbound calls 2026-11-09 (IB1–IB8, [`inbound.md`](inbound.md))

Customers ringing back the Plivo numbers agency dials from, answered on our stream and turned into
follow-ups when nobody takes them. Designed and locked the same day (IB1–IB8). **P1 is built**: the
foundation below, then three slices on it (the super-admin's Application and number links with the
§8.2 cascade; the answer, hangup and fallback webhooks with what callers hear, the Missed row, the
inbound callback and the sweep; the console's routes and Missed list with Call back), then an
independent review's fixes (`inbound.md` §12): a `CallUUID` another tenant or credential holds is
refused; the live-index migration renumbered `0026`; IB5 counts admitted callers only; CA5's
code-less sweep reads an index of inbound callbacks; read-only carrier calls out of the operator
transactions; an answer past its budget leaves no follow-up; a second Re-point refused while the
first's token is still needed; a message with no recording is spoken by the carrier, never
silence. **P2 is built** (connecting agents, console stations, one process, IB8): parked callers on
a looped hold, the queue, sticky routing (loose and strict), the offer and the bind, the release
hook taking an agent from wrap-up, `inbound_waiting` holding pacing back, the in-flight clash (§5.4),
voicemail, the outcome routes and the console's panel, then an independent review's fixes
(`inbound.md` §12, P2 row), then a verification pass's two test fixes.
**The fix pass is done** (two rounds, decisions IQ25–IQ45 in [`decisions.md`](decisions.md) §4,
"Inbound fix pass"; the P2 plan's build rulings are IQ1–IQ24 there): independent engineering,
product and QA reviews of P1 and P2, then a review of the first round, each behaviour fix pinned by a
test and each guard mutation-checked (`inbound.md` §12). What changed for callers and agents: our seven standard
recordings in British English wherever a route has none, so no caller is put down in silence;
withheld and DNC callers never promised a callback; recordings uploaded and previewed in the route
editor; a caller nobody in the pool could take overflowed at once, decided at the answer, with a
15 s rejoin grace for a dropped station; a declined offer requeued; an agent on a break never
lifted back into the pool; the inbound wrap-up on the matched campaign's auto-return rule (120 s
for an unmatched caller) and a supervisor's "Close and make available"; the webhooks' nonce guard
failing closed; crash-swept calls `failed` and early hangups ended at once; the kill switch and a
credential disable that keeps its links; `MEDIA_WORKERS=0` a loud deployment invariant, the
Application health check on a timer, nine `agy-inbound-*` alert rules and a dashboard row; inbound
counted apart in usage with carrier and hold time; Missed rows closed when a person is reached,
Reopen, reassign and a nav badge; why a call was answered closed (`closed_cause`) and the inbound
summary. Migrations `0028`–`0030`.

| Area | What was built |
|---|---|
| Database | `0026_inbound_live_indexes.sql`: IB5's per-account live index, the inbound callbacks index, `callback_source` in the insights index. `0024_inbound.sql`: `agency_inbound_routes`, `agency_inbound_route_numbers` (one live route per number), the spine `agency_inbound_calls` (also the Missed row), `agency_calls.origin = 'inbound'` with `inbound_call_id`, contact `callback_source` / `callback_due_at`, `agency_campaigns.inbound_sticky_enabled`, the credential's inbound Application, URLs and token hash, numbers' `inbound_linked_at`; `0025_inbound_checks_validate.sql` validates the big tables' CHECKs (`packages/db/BASELINE.md`) |
| Contracts | `src/agency/inbound.ts` (vocabularies, route config, defaults, limits), `src/api/agency/inbound.ts` (route DTOs, the Missed list), `src/api/platform/super-admin-inbound.ts` (credential inbound state and health, number link, super-admin audit actions), error codes `errors.ts` §6, flag `agency_inbound_enabled` (default off), permissions `agency.inbound.read` (agent) and `agency.inbound.write` (account admin) |
| Domain | `inbound-schedule.ts` (open at an instant; the exact next opening across DST and holidays), `plivo-number.ts` (moved from the credential specs: one number rule for sync and webhooks), `zone-clock.ts` (the wall-clock primitives moved out of `calling-hours.ts`) |
| Server | `agency/inbound/route-config.ts` (the route body's zod schemas; a PATCH judged as the route it makes), `db/repositories/agency/inbound-route.repository.ts` and `inbound-call.repository.ts`, `telephony/plivo/inbound-token.ts`; the credential's inbound storage in `packages/db`; usage counts' third arm; the `'agency'` call scope takes inbound legs; audit vocabulary. Then the slices: `telephony/credentials/inbound-service.ts` and the super-admin inbound routes; `api/routes/webhooks/plivo-inbound.ts`, `seams/inbound-call-router.ts`, `agency/inbound/inbound-call-router.ts`, `identify-caller.ts`, `inbound-clips.ts`, the bridge's `acceptInboundCall` / `playClipSequenceThenHangUp`; the console routes `proxy-agency-inbound/` |
| Console, super-admin | Settings → Inbound calls (routes and the route editor), Missed calls (supervisors and agents) with Call back into the soft phone; the credential page's Inbound section, the numbers page's Link / Unlink |
| P2 database and contracts | `0027_inbound_connect.sql`; `AgencyInboundCall`, the `inbound_call` and `customer_waiting` station frames (console stations only), release reason `inbound_call`, the queue tile, `voicemail_url`, `inbound_waiting` on the pacing bus, the agent hash's `inbound` field |
| P2 server | The bridge's parked mode (`playInboundHold`, `stopInboundHold`, `recordInboundAudio`), `agency/inbound/inbound-connector.ts` with `inbound-queue.ts` and `eligibility.ts`, the release hook (`AgencyDialer.registerInboundTake`), `pacing/inbound-hold-back.ts`, the finish routes (`/inbound/calls/:id`, notes, hangup, disposition, dnc) and `GET /inbound/queue`, `inbound-voicemail.ts`, the in-flight clash in the dialer, the outcome-lapse sweep, the metrics |
| P2 console | `InboundCallView` in the station's geometry, the chime, the "Your customer is waiting" pill, the supervisor's queue tiles, the campaign's "Put callers through to their agent", voicemail playback on the Missed list |
| Fix pass database and contracts | `0028_inbound_missed_follow_up.sql` (`handled_reason`, the summary's index), `0029_inbound_reach_settles.sql` (`callback_reopened`, `carrier_seconds`), `0030_inbound_reached_on_outcome.sql` (the person-reached close, `closed_cause`); `AGENCY_INBOUND_STANDARD_WORDS` and the standard recordings' names, the queue tile's `no_agents_available`, route warnings, the recording upload and preview, Reopen, reassign, the badge's count, the summary |
| Fix pass server | `apps/server/assets/inbound/` (seven WAVs and their README) with `scripts/generate-inbound-clips.ts` and `inbound-standard-clips.ts`; `inbound-recordings.ts` and the clip routes; `inbound/start.ts` (sweeps, lapse timer, shutdown), `inbound-handover.ts`, `inbound-wrapup.ts`; `telephony/credentials/inbound-monitor.ts`; the summary (`inbound-report.repository.ts`) and the Missed work routes; the inbound usage columns; `grafana/` inbound rules and dashboard row |
| Fix pass console, super-admin | The route editor's recordings (upload, Play, delete), default hours and warnings; Missed calls' Reopen, Reassign, "Former member", the badge and the flag-off notice; the Inbound summary; the floor's "Close and make available"; super-admin's connect-unavailable copy, "Inbound · no route", unrouted Missed rows on a number, the Usage page's inbound columns |

**The mobile wire:** P2's foundation changed `agency_wire` itself (`enums.dart`, `softphone.dart`,
`station.dart` and the fixtures test); its `dart test` has now run on the merged branch: 510
passed (Dart 3.13.7). No inbound call has been placed: P0 (the live Plivo checks) needs an
account. Still to build: P3 (the mobile app's frames, pickups from break and the soft phone, the
media-worker handover, reports and Insights) and P4 (VoiceLink inbound); what else remains is
under "Not built". (P3's mobile app frames were built on 2026-11-10, below.)

### Reports infrastructure 2026-11-09

`aws/terraform` now owns everything reports need except the database (Supabase) and Redis
(compose): `enable_reports = true` is the only input.

| Area | What it does |
|---|---|
| Chromium layer | The plan reads the renderer's pin (`apps/report-renderer/chromium-layer.json`: the `@sparticuz/chromium` version and its x64 layer zip's SHA-256, kept equal to the dependency by `test/chromium-layer.test.ts`), fetches that zip from its GitHub release and refuses it unless the hash matches; the apply uploads it to `lambda-artifacts/` and publishes the layer. `report_renderer_chromium_layer_arn` still overrides |
| Renderer zip | Built at every plan (`scripts/build-report-renderer.mjs`); `source_code_hash` is the build output's, and the build is reproducible (`apps/report-renderer/test/build-lambda.test.ts`), so an unchanged checkout publishes no version. `report_renderer_zip` still overrides |
| Callback secret | `random_password` per generation (the current one and the one before), in SSM as SecureStrings; the apply puts the same value in the Lambda's env, `reports_callback_secret_env_command` prints a command that reads the server's line from SSM (and fails on an empty read), and `reports_callback_secret_signing_sha256` the hash of the signing secret, never the secret. Rotation is two applies with no refused callbacks: the server accepts `AGENCY_REPORTS_CALLBACK_SECRET_PREVIOUS` meanwhile (`aws/README.md`, "Rotating the callback secret") |
| Docs | The production database is Supabase everywhere (`DEPLOYMENT.md` 3.3: the session pooler on an IPv4 VM, never transaction mode; its CA as `DB_SSL_CA`; `uuid-ossp` in `extensions`) |

Evidence, local, 2026-11-09: `terraform test` 11 passed (the layer the renderer pins, zip hash,
secret, two rotations, overrides), each guard mutation-checked; the real build and layer fetch run
through Terraform with AWS mocked (paths relative, the checksum refusal included), and run again
directly after the cleanup (the hashes they answer match `sha256sum`); the secret
command against a stub AWS CLI (a failed or empty read exits 1 and prints nothing). Server unit
9,154 passed, 1 failed: the branding guard on an untracked local `.slacker.json`, not in the
repository. Renderer 81 passed, 11 skipped (no local Chrome). `pnpm test:grafana` 33,
`pnpm test:release` 10, `pnpm lint` clean.
**Not verified:** a real `terraform apply` on AWS, a real Supabase project (the pooler's
certificate chain and the `uuid_generate_v4()` search path are from Supabase's documentation),
and the server's integration lanes (no Postgres on this machine at the time).

### Inbound calls on the mobile app 2026-11-10 (IQ46, IQ47, [`inbound.md`](inbound.md) §6 "Mobile stations", [`mobile.md`](mobile.md) "Inbound calls", "Missed calls")

P3's mobile app frames, built on the server and in the agent app the same day and reviewed
independently twice, each round's findings fixed. Manas decided both rulings on 2026-11-10: IQ46
(the server side) and IQ47 (the app's defaults), `decisions.md` §4, "Inbound calls on the mobile
app". The rest of P3 is open (below, "Not built").

**The server.** A mobile station that declares `caps=inbound` on its upgrade
(`client=mobile&media=alaw8&caps=inbound`) is offered inbound callers exactly as a console is, and
every older app build stays excluded and is never sent the inbound frames. The capability is the
live socket's (`StationRegistry`'s `canTakeInbound`), and replaces every mobile exclusion
(eligibility, the release hook, the in-flight clash's hand-over, the could-take count and the
queue tile, the send filter: `AGENCY_STATION_INBOUND_EVENTS`, renamed from the console-only list).
A phone silent on a live inbound call is dropped as on a campaign call (M1); an older build
reattaching to a session holding an offer or a call is handled as a lost station; the device-away
break queues behind an inbound offer, call and wrap-up. `literals.json` gains
`station_capabilities` and the ten inbound vocabularies the Dart wire types check (62 in all). No
migration.

**The app.** The Dart wire types (`agency_wire`'s `inbound.dart`; `inbound_call` and
`customer_waiting` decoded; the inbound vocabularies and refusals; `fixtures/agent/inbound.json` and
the inbound frames in `station.json`). The station declares `caps=inbound` on every connect and
takes the console's flow with the app on screen: the offer with the chime once per offer (the
console's `inbound_ring`, made in the engine: a Dart reference, Kotlin and Swift written to shared
vectors), the call, the outcome pad once it ends, Mark DNC, "Your customer is waiting", why a call
left, the reconnect check against `GET /inbound/calls/:id`, the away rules (`device_away` queued
behind the call), CallKit told of an outgoing call as for a campaign call, and five telemetry
events. Missed calls is a third segment of My calls with the open count badged on it and on the
tab: the agent's own rows, To follow up / Handled, the reason filter, Mark handled and Reopen, a
voicemail to be heard on the console, and Call back, which fills the soft phone's pad with the
number and the matched campaign and never dials.

**Two review rounds, fixed.** On the app: it follows the server's own frame order (the `reserved`
before an offer lands shows a neutral "Incoming call · Connecting…" with nothing to press, and the
offer is announced when it lands); a copy the station let go of stays gone (a late answer never puts
a finished call back beside a campaign call); the reconnect check keeps the copy and asks again on
its backoff after any non-answer, a 401 or 403 included; notes restored after a restart are kept
over the server's older copy; a refused outcome re-sends the notes typed since the last save, on an
inbound call and on the soft phone, and leaving, 4404 and sign-out send them at once; the Missed
count is polled every 60 s in the foreground and read again when a call settles and when the
segment comes on screen, and the list asks for `assignee=me`; a waiting Call back lapses after 5
minutes and closes an override prompt it replaces; the inbound vocabularies are checked as
extracted. On the server: an offer is refused to a station that lost the capability before the
spine's write; pacing's hold-back for waiting callers holds back only stations that can take them;
an older build taking over a session holding an offer has it let go before its `ready`, which then
reports the agent back in the pool; the IQ46 guards tightened, and the code comments on the
capability and on which inbound routes the flag gates corrected.

Tests on the server's first commit (`4965a00`): `pnpm lint` clean; server unit 488 files, 9637
passed + 1 expected fail; server integration `INTEGRATION_LANE=rest` 250 files (+2 skipped), 2644
passed + 9 expected fail + 2 skipped, `wall-clock` 5 files, 21; contracts 13 files, 463;
`agency_wire` `dart test` 595; `contracts-literals --check` 62 vocabularies; `pnpm test:tooling`
16. New suites `inbound-mobile-e2e` 8 and `inbound-mobile-wall-clock` 2 (wall-clock lane); the
connector races +3 (25), the review fixes +2 (23), eligibility +1 (49), the registry +1 (31), the
upgrade +17 (30). Eleven guards mutation-checked (each red, then restored). Run on a UTF8 test
database: the machine's local databases were `SQL_ASCII`, on which `softphone-policy-routes`' emoji
case fails (`char_length` counts bytes there), whatever the branch.

**Not verified:** nothing has run on a real phone or a real carrier; the app's flow is tested with
the contract's sample frames and answers, the server's with a simulated phone station. iOS does not
compile yet, and the chime's Swift has never been compiled. The chime's Kotlin was compiled and
`ChimeTest.kt` passed offline on a JVM during review, but CI never runs the Android unit tests
(`ChimeTest.kt`, `RingbackTest.kt`). A phone that leaves the app while available is paused and
offered nothing on its station; ringing it while away came later (Mode B, 2026-11-12, below).

### Inbound calls on the mobile app: persona review 2026-11-11

A third independent review of the branch, by four reviewers with fresh context: a principal
engineer on the server and contracts, one on the app, a principal product manager and a principal
QA engineer (who also ran mutation probes and a compatibility matrix). No Critical findings; one
High on the app (the Missed row cut the caller's number short). Every engineering and QA finding
was fixed, with its guard mutation-checked; the product findings that are copy were fixed, the
ones that need a ruling are under "Open decisions and owners" (Inbound calls).

**The server.** An offer refused because the station cannot take inbound calls is its own result,
`station_incapable`: the agent is returned with no read of the call records, so a failed read can
no longer put an older build's agent on a break (it was `session_busy`, whose give-back fails
closed). An older build's `ready` now waits for every return of the session the connector has in
flight (the search's or the release hook's reservation through its offer or give-back, a
give-back, the bind's cancel when its timer fires during the attach), bounded at 3 s
(`inbound.md` §6). The post-offer requeue awaits the panel before the spine's write and logs a
requeue that moves nothing or throws. `PacingStations.get` states `canTakeInbound` (the media
workers' directory says `false`: IB8, IQ13); a filtered inbound frame is logged at debug;
`agency_inbound_offers_total` gains a `client` label. New tests: the silent-station sweep's
inbound arm (a phone dropped, a console left alone), the bind firing first, the search giving back
after its lock, the 3 s bound, a capable phone reconnecting inside the offer window, two
strict-sticky callers then an older-build takeover, a console handing a connected call to a phone
(A-law), an older build silent on a bound call; the re-offer timing bound loosened to 5 s so a
loaded runner cannot fail it.

**The app.** The Missed row wraps instead of cutting the number short (tested at 360 dp, 1× and
2× text, with the app's fonts). Inbound telemetry is tracked per offer, so a re-offer reports its
own funnel, and a copy the station lets go of reports its end (`retired: true`). An offer the
server no longer holds is retired at once by a `ready` that says the agent is not reserved, and
by a backstop 10 s past `connects_at`, so the microphone, CallKit and the notification no longer
hold a call that is not there while the reconnect check's reads fail. "A call is coming through"
replaces "Incoming call" for a `reserved` with no offer (a campaign reconnect showed inbound
words). A waiting Call back never erases the agent's own dial refusal, and the Missed feature reads
where the number stands from the soft phone (`callBackWaiting`). "Your customer is waiting" is a
live region. The inbound routes are made when the station is built (never first in teardown).
Notes give up on a 403 and retry a 401 on the backoff, on the inbound call and the soft phone.

**Copy, on both the console and the app.** A paused campaign says "no campaign calls for now" and
that customers who ring in can still reach the agent (the search never reads the campaign's
status, so they are still offered callers); the `last_from_number` reason says "you last called
them from this number"; "Your customer is waiting" no longer promises to put them through (a
teammate takes them after a loose wait); the console's strict-mode hint names only an older
version of the phone app. In the app: "Listen on the web console", the Missed subtitle (reaching a
customer closes the row on its own), "Switch to the soft phone", and "dialling", "dialled".

### Inbound pilot rulings 2026-11-11 (IQ48–IQ57, [`decisions.md`](decisions.md) §4, "Inbound pilot rulings")

Manas ruled on the persona review's product findings the same day; all ten are built on the server,
the console and the app, except IQ53 (in-app voicemail playback, the first follow-up after the
pilot). Two migrations: `0032_inbound_route_wrapup.sql`, `0033_inbound_answered_from_index.sql`.

- **Missed calls on duty (IQ48).** The app's waiting and wrap-up screens say "N customers to call
  back"; the Missed list opens on duty in a sheet over the station; Call back switches the campaign
  to the soft phone in one step (SP7) and puts the number on the pad, never dialling.
- **Callers nobody owns (IQ49).** An answered inbound call is a sticky signal (folded into
  `last_connected`). Agents see the account's unassigned Missed rows in a Team view, on the app and
  the console, and claim one (`POST /inbound/missed/:id/claim`, a compare-and-set, audited
  `agency_inbound_call.claimed`).
- **A phone that leaves the app (IQ50).** Back within 30 s, the agent is returned on their own; a
  `device_away` pause under 30 s old counts as could-take, so callers queue instead of overflowing;
  on return the app says how many customers rang (`count?since=`).
- **A cellular call while available (IQ51)** pauses the agent with the reserved break `phone_call`
  and returns them when it ends; detected without a runtime permission (Android's audio mode, iOS
  `CXCallObserver`). The console labels it "On a phone call".
- **The route's wrap-up window (IQ52):** 30 s by default, 10–600, set in the route editor, for
  every inbound call on the route, captured on the call when it arrives. It replaces IQ32's
  campaign rule and the 120 s unmatched default.
- **The caller's name on a Missed row (IQ54)** (`match_name`), on the app and the console.
- **Calling back a DNC caller (IQ55):** the row says a missed call isn't consent; the SP1 note and
  override apply.
- **Older app builds (IQ56):** the floor marks a phone that cannot take inbound calls "Update app",
  on accounts with inbound on (`agents[].can_take_inbound`). Still to do at the pilot's start:
  raise `MOBILE_MIN_SUPPORTED_VERSION` to the first release that declares `caps=inbound`.
- **The badge (IQ57):** the count takes the list's `assignee` and `since`; the app and an agent's
  console badge ask for `assignee=me`.
- **Contracts:** `match_name`, `wrapup_seconds` and `can_take_inbound` are required on their types;
  the `phone_call` break reason, `DEVICE_AWAY_RETURN_GRACE_MS`, `inbound_missed_call_claimed`, the
  Dart wire types and fixtures to match.

Every new guard was mutation-checked. **Not verified:** none of it has run on a phone; the
cellular-call detection's Android code (bar its pure tracker, compiled and run on a JVM) and all of
its Swift have never been compiled.

### One station per agent 2026-11-11 (OS1–OS8, [`decisions.md`](decisions.md) §4, "One station per agent")

Manas: an agent stays online at one station only, one console window or the app, and across
tenants. Before this, the server already allowed one live session per agent per tenant and closed
an older socket of the same session with 4409; what was missing was the tenant boundary and a way
to stop a device that had lost its socket (a laptop asleep, a phone out of signal) from
re-minting a token and silently taking the station back from the device the agent had moved to.

- **Across tenants (OS1, OS2, OS7, OS8).** `0035_one_station_per_agent.sql`:
  `uq_agency_agent_live_agent` is the new arbiter (duplicates ended when it runs); the per-tenant
  index is kept beside it so an image-only rollback still joins (OS8). The join and the soft-phone open
  answer `409 session_in_other_tenant`, naming the tenant only; the console and the app show the
  server's sentence. A session in another tenant with no station attached and nothing in flight is
  ended by the join instead (OS7), so a forgotten session cannot lock the agent out everywhere.
  This reverses the old pin that "the same agent id in another tenant is
  dialled independently" (`agency-double-reservation`, `agency-duplicate-dial` T-M6,
  `agency-session-tenant-unique`), each rewritten to the new rule.
- **One device holds the station (OS3–OS6).** `station_device_id` on the session; `device_id` and
  `take_over` on the join, the soft-phone open and the token mint (`AgencyStationDeviceFields`);
  `409 station_on_other_device` for any other device that does not take over. The console is one
  device per page load and takes over when its station or soft-phone page opens; its reconnects
  never do, a refused re-mint stops as a 4409 does, and "Use this window instead" takes over. The
  app is one device per install; "Go on duty", "Use this phone" and "Use it on this phone" take
  over, its own resumes and its reconnect ladder never do.
- **Review fixes (same day, a fresh-context review of the first commit).** The rollback index
  (OS8); the idle session in another tenant (OS7); the console's Switch no longer takes the other
  campaign's station to look it up; a page the browser reloaded by itself (a discarded tab) asks
  before taking the station; a take-over is spent by its one mint on both clients; a mint naming
  no device is refused while a device holds the station (OS6, stale console tabs); the app-wide
  soft-phone API names the device too; `BASELINE.md` and stale comments repaired.
- **Copy:** "Your station moved to another device" / "Moved to another device" (was "another
  window"), and the app's "Your station is open in the console…".

Every new guard was mutation-checked (the claim SQL, the arbiter, the migration's clean-up order,
the console's mint refusal and take-over, the idle-session rule, the discarded-tab join).
**Not verified:** none of it has run against a real browser, phone or carrier; `wasDiscarded` is
Chromium's, so another browser's restored tab still takes over as a page load; an older app that
sends no `device_id` can still take the station by going on duty until
`MOBILE_MIN_SUPPORTED_VERSION` is raised (OS6).

### Mode B: ringing an away phone 2026-11-12 (IQ58–IQ74, N1–N5, [`inbound.md`](inbound.md) §6.1, [`mobile.md`](mobile.md) "Ringing while away (Mode B)")

Before this, a phone that left the app while available was paused (`device_away`) and offered
nothing. Now an agent who opts in on their phone, on an account with `agency_inbound_ring_enabled`
on, leaves on the `away_ring` break instead, and their phone is rung by a data push for an inbound
caller; Answer puts the caller through to the app's station. Opt-in per account and per device;
off by default. IQ59, IQ62, IQ63, IQ65, IQ67 and IQ73 are **Decided** (Manas, 2026-11-13), IQ74 decided for now (to revisit); the other rulings are **default, pending Manas** (`decisions.md` §4, "Mode B").

- **Contracts and schema.** The reserved break `away_ring`; the call's `offer_channel`,
  `ring_expires_at`, `accepted_at`; the ring constants (20 s ring, 15 s grace, two misses), results
  and refusals; `agency/push-devices.ts`; the flag. `0036_inbound_ring.sql`: `agency_push_devices`,
  the ring columns on the inbound spine, `ring_misses` and `away_ring_since` on the session;
  `0037_away_ring_sessions_index.sql`, the partial index of the sessions on an away break (the ring
  search and the reconcile). The Dart wire types beside them.
- **Push senders (platform area).** The push seam (`seams/push-sender.ts`, `seams.md` §3.6) and
  FCM HTTP v1 and APNs VoIP senders behind it (`notifications/push/`), no new dependencies;
  `PUSH_*` config; a mock carrier for tests; `agency_push_sends_total`, `agency_push_send_seconds`.
- **`away_ring` (agency).** The Lua (enter, the return after a ring, the create-if-absent re-seed,
  the end, the station close's one-script decision), `AwayRingService` (refusals, ends, `ring_off`,
  audit), the reconcile at boot and every minute, the push-device routes, the take-over ending it,
  force-available refused, `AGENCY_AWAY_RING_MAX_MS`.
- **The ring (agency).** Ringable agents read in one statement per search and tried in IQ63's order;
  the ring as a push offer; the token-only `answering` and `decline` routes and the Bearer `accept`;
  the attach that binds an accepted ring (or accepts one mid-ring); every unanswered end back to
  `away_ring` with its result, `ring_cancel` and the miss count; IQ73's take-over on the call's chain;
  `agency_inbound_rings_total`, `agency_inbound_ring_answer_seconds`, the offers' `channel`; the
  alert `agy-inbound-ring-push-failed` and a dashboard row.
- **Android.** FCM natively (BoM 34.19.0), a self-managed Telecom call, the full-screen CallStyle
  notification, the lock-screen `RingActivity`, the token-only posts from native code, the away,
  missed and ring-off notifications, the checklist; the logic in a pure, JVM-tested state machine.
- **Flutter.** The ring channel, registration, the Me card with its checklist and test ring,
  `away_ring` on leaving the app with the `device_away` fallback, the parked socket, answering from
  a ring (a cold start included), the missed ring, why ringing stopped.
- **Review fixes** (three commits). Server: a failed push is never a miss (an unregistered token
  revokes and ends the absence; any other failure keeps the agent ringable, records `push_failed`
  and pauses all ringing for `INBOUND_PUSH_RETRY_MS`, 10 s); an agent at the maximum misses is not
  ringable and any later ring's end sends the owed `ring_missed`; an answered ring clears
  `away_ring_since` (`ringAnswered`); IQ73's take-over re-decided per candidate; `RENEW_SCRIPT`
  never renews `ring = 1`; `/leave` and OS7 send a parked phone `ring_off` (`taken_over`); a queued
  `away_ring` applies from `offline` and over no key; a requeue that throws still releases; 0037.
  App: the station held for the accept's URL during an answer (`_onShow` does not reconnect), and
  `already_accepted` for a call the station holds is success; our own ring is not "busy"
  (`PhoneSignals`, `OwnRing.live`); the ring's time left from FCM's `sentTime` (at most 22 s);
  decline inside 8 s; a silenced ring on `magick_agency_ring_quiet`; "Connecting the call…" with a
  full-screen intent only for a headset or car answer; a hang-up after Dart's accept hangs the
  call up through the station.

**Built in CI, not on a phone:** PR #80's Mobile workflow at `95a0db9` (2026-11-13) built the
debug APK under Gradle (`flutter build apk --debug --flavor dev`: the manifest, resources, the
Firebase BoM and the dart-defines written into string resources) and ran the Kotlin unit tests under
the Android Gradle plugin (`:app:testDevDebugUnitTest`, `:agent_audio:testDebugUnitTest`), green.
Locally the same Kotlin compiled with `kotlinc` against the framework jar and its 115 + 7 tests
passed on a JVM. **Not verified:** nothing has run on a phone, against FCM or APNs, or with a
real caller. The Play Console full-screen-intent declaration is not filed. iOS is a design only
(`mobile.md` "iOS: the design (Mode B)").

### Terraform state in S3 2026-11-13

Manas: the Terraform only applied from the one machine that held its local state. Now
`aws/terraform` and `grafana/terraform` keep their state in one S3 bucket,
`magick-agency-terraform-state` in `ap-south-1`, each under its own key (`aws/terraform.tfstate`,
with other workspaces under `env:/<workspace>/`, and `grafana/terraform.tfstate`), with the S3
backend's lock file, so any machine with AWS credentials can plan and apply. A new root module,
`aws/state`, makes the bucket once per account: versioned (old states kept 90 days), SSE-S3,
public access blocked, TLS only, `prevent_destroy`. Both modules now need Terraform 1.10+
(`use_lockfile`). How to apply from a new machine and how to move a local state up:
[`aws/README.md`](../aws/README.md), "State".

Evidence, local, 2026-11-13: `terraform validate` on `aws/state`, `aws/terraform` and
`grafana/terraform` (`init -backend=false`); `aws/terraform` `terraform test` 11 passed;
`pnpm test:grafana` 33 passed. On AWS, 2026-11-13: `aws/state` applied (the bucket exists) and
`aws/terraform`'s `default` workspace moved into it with `terraform init -migrate-state` from
Manas's machine. **Not verified:** a no-change plan from a second machine; the Grafana module has
never been applied, so its key is empty until its first apply.

### Mobile release APK 2026-11-13

Manas: after a mobile release, CI should publish an APK anyone can download and install. On each
`mobile-vX.Y.Z` release, `release-please.yml` now calls `mobile-release.yml`, which builds a
release-signed `staging` APK and attaches it, with its SHA-256, to the GitHub Release (and keeps it
as a 90-day workflow artifact); it also runs by hand for an existing tag. `versionCode` comes from
the version (`major × 1 000 000 + minor × 1 000 + patch`). The build config comes from the Actions
variable `MOBILE_ENV_STAGING` and signing from four `ANDROID_KEY*` secrets; the job refuses a
missing or placeholder config, an APK without Firebase, a keystore that does not open, and a
debug-signed APK. `mobile.yml` now also compiles that release build (R8, debug-signed) on `main`,
before a release is tagged. Detail: [`mobile.md`](mobile.md), "The release APK".

Evidence, local, 2026-11-13: `actionlint` clean on every workflow; `pnpm test:tooling` 16 and
`pnpm test:release` 10 pass; the job's scripts run against test cases (tags with leading zeros,
out-of-range and injected tags refused; each config rule; a keystore with a backslash, `:`, `=`,
`#` and `\u` in its password read back exactly through `java.util.Properties`; a wrong password,
alias, base64 or keystore refused). **Not verified:** any run on GitHub Actions, so no release
(R8-minified) build of the app has run anywhere yet, nor the signature check or the upload. Open:
set `MOBILE_ENV_STAGING` and the signing secrets ([`operations.md`](operations.md), "Repository
settings it needs"), then run "Mobile release APK" by hand for `mobile-v0.12.0`; add the key's
SHA-1 to a Firebase Android app for `com.magickagency.agent.staging`.

### Database hygiene, phase 1 2026-11-14 ([`db-hygiene.md`](../db-hygiene.md))

Manas: a review of the schema (tables, indexes, foreign keys) and how the server uses Postgres,
split in two phases; phase 1 is what is safe and measurable now, with no product decisions.
In code: `0038_table_storage_settings` (per-table autovacuum thresholds, `fillfactor` on agent
sessions and pacing minutes), `0039_retention_purge_indexes` (two partial indexes for the daily
purge; fails on an invalid pre-built one), `0040_drop_duplicate_indexes` (seven indexes a unique
index already covered); every pool connection named (`application_name`) and kept alive (TCP
keepalive); a connection Postgres ends under a checked-out client logged and discarded instead of
ending the process; opt-in session timeouts `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS`,
`DB_LOCK_TIMEOUT_MS`, `DB_STATEMENT_TIMEOUT_MS`, off by default, set as SQL on each connection
(the ones that are off RESET, so nothing a session pooler left behind is inherited), with the
report cursor's transaction bounded by the report's deadline instead (or a lower role or database
limit) and the migration step resetting all three on its own connection; the
campaign stats route's two campaign-wide reads shared between supervisors for
`AGENCY_CAMPAIGN_STATS_CACHE_MS` (2 s), dropped by the campaign's row writes, a force-available
and a completed roster upload (the last two over the cache-invalidation channel, which reaches the
primary from a media worker as `cache.invalidate`; the pacing bus carries only what pacing reads),
and only marked stale by each roster chunk's `contacts_changed`, so an ingest never overlaps two
scans of one campaign; Home reads past it only for a still campaign it is about to keep from a
read another request began, and never drops it for others. The operator half (building
0039's indexes `CONCURRENTLY` on a large database, point-in-time recovery and a restore drill,
`pg_stat_statements` and slow and lock-wait logging, the timeouts one at a time) is the runbook,
`db-hygiene.md`; its section 7 is phase 2's list (retention windows, campaign stats from the
rollups, index clean-up, `fillfactor` on attempts and contacts, tenant-scoped foreign keys, an
erasure procedure, the inbound actions' lock held across Plivo calls, the statement timeout's
value).

A fresh-context review of the branch found, and the branch fixes: the idle-in-transaction timeout
would have ended the server process when it fired (no `'error'` listener on a checked-out
client); plain `created_at` indexes in 0039 that the analysis sweeps could have walked instead of
their own index (dropped; the row purge's comes with its window, as BRIN); the force-available
invalidation not reaching the primary with media workers; the pooler assumptions; and runbook SQL
that did not run.

**Not verified:** whether Supabase's session
pooler forwards `application_name` and clears session state between clients (the code no longer
depends on either; `db-hygiene.md` 4.1 has the post-deploy check); every operator step in
`db-hygiene.md` (they run against production).

### Hidden dials on the waiting screen 2026-11-15 (late binding)

Manas: under late binding (`FF_AGENCY_LATE_BINDING`) an idle agent is shown a dial only if the
customer answers, so their waiting screen looked the same whether a phone was ringing for them,
nothing was due, or the station was stuck, and agents took it for hung. Over-dialling (more than
one dial per idle agent) is a separate question, deferred by Manas; nothing here changes pacing.

- **Contract.** `dial_activity` (`AgencyDialActivity`: `ringing`, `unanswered_in_a_row`;
  `agency/station.ts`) and `ready.dial_activity`. It names no contact, number or attempt.
  Fixtures `dial_activity_ringing`, `dial_activity_unanswered`, `ready_dial_activity`; the Dart
  `DialActivityFrame` beside them.
- **Server.** The dialer sends `ringing: true` once the carrier has taken a hidden dial (never
  for one refused before or by the carrier, so a systemic refusal cannot hold "Dialling…" on
  screen) and `ringing: false` when it ends unseen: two frames at most per dial, to that agent's
  socket only. The count is process memory (`AgencyDialer`'s `unansweredInARow`, a `TtlCache`), no database or Redis
  work: counted only for a dial no customer answered (not one ended because the station stayed
  gone, or cancelled by the customer ringing in), reset by the next campaign call the agent is
  shown (`reserved`; an inbound or soft-phone call does not reset it), expired after 12 hours
  untouched. A reconnect mid-ring gets `ready` with `state: available` (it said `reserved`, which
  showed "Ringing — get ready" and "A call is coming through" for a call nobody had answered).
  Early binding and wrap-up redials never send it, so neither client needs the flag
  (`architecture.md`, "Dialer").
- **Console and app.** The waiting screen says "Dialling a customer…" ("You’ll be connected as
  soon as they answer.") while one rings, and "No answer from the last N numbers" once some went
  unanswered; the console's rail says "Dialling a customer…" too. A 4 s client-side hold covers the
  gap between one dial and the next, dropped at once on `reserved`, leaving available, a paused
  campaign or a lost socket. A ringing dial outranks "Nothing due now" (with nothing due and
  nothing ringing, both hide the count line); a paused campaign, a break, wrap-up and inbound
  calls are unchanged. Malformed dial activity is dropped (the app keeps the rest of a `ready`).
  The app's "Available for" timer no longer restarts at every hidden dial (each ends with
  `agent_state: available`; it restarts only after a call the agent was shown), its headline is a
  live region only while dialling, and its waiting hint no longer says the customer's details
  appear before they pick up (false under late binding).
- **Review (same day, three fresh-context reviewers).** Found and fixed: a mid-ring reconnect
  showed a call coming in on both clients (`ready` said `reserved`); a carrier refusal was counted
  as "No answer", and a dial refused before the carrier was announced; the contract and docs
  overstated when the count resets; tests that sent frames the server never sends; missing
  cases (the real inbound and carrier-refusal sequences, a dial answered or ended inside the dial
  call, a reconnect mid-ring, a queued break mid-ring). Accepted, not changed: the console's
  status rail re-announces "Dialling a customer…" once per dial when dials are more than 4 s
  apart (`useDialActivityDisplay.ts`).
- **Simplify pass (same day).** The tally class became the shared `TtlCache` (12 h TTL, LRU cap);
  the close of a hidden dial moved into `forgetAttempt`, the one way an attempt is dropped, and
  the count's reset into `sendReserved`, the one way a `reserved` is sent; the console hook's two
  states became one, and one `waitingHeadline` serves the idle panel and the rail; the app's slot
  rule is one `StationState.dialSlotOpen` for the view and the gap hold, and `DialActivity`
  refuses a negative count as the console does. Left as follow-ups: `agent_state.since` restarted
  by the release after every unanswered dial (the server-side fix would also mend the supervisor
  floor's time in state and let the app drop `callShownSinceStated`); the HTTP break and
  soft-phone responses still saying `reserved` during a hidden dial (no client shows it); the
  display rules and the 4 s hold kept by hand in both clients, with no shared fixture pinning them.

Every new guard was mutation-checked (the reset at the bind, the close not repeated after a
`reserved`, the uncounted ends, the early-binding gate, `ready`, the count's expiry; the clients'
clear on `reserved` and the gap hold). **Not verified:** none of it has run against a real
carrier, browser or phone.

### Manas's rulings on the feedback branch, 2026-11-15

- **Recordings with recording off (RC5):** got rid of. The retention purge clears the link of every
  call that did not ask for a recording, on every run.
- **VoiceLink (RC2):** whatever VoiceLink does with its recordings, we never honour a recording
  callback for a call with recording off; nothing is asked of VoiceLink.
- **Promise date (PT4):** at most 30 days ahead (was 180).
- **Promise follow-ups and Insights (PT2):** the split stands as built.
- **The open questions for Reshma** (which carrier each tenant dials on, where a DNC mark was made,
  existing "Promise to pay" entries that book a callback): closed with the defaults, starting
  fresh. No data was migrated or purged for them; Do Not Call entries are compliance records and
  were left as they are.

### Navigation group labels 2026-11-15 (NV1, NV2)

Reshma: the Settings hub's group headings and the campaign bar's Monitor, Data and Set up looked
too much like the entries beside them. Console styling only; no label, id, route, gate or event
changed.

- **One label.** `components/common/NavSectionLabel` renders every navigation group label (the
  Settings hub, the campaign bar, the search's result groups): small, uppercase, muted, a
  hairline to the end of its group, not interactive, and the name of its group
  (`aria-labelledby`).
- **Items.** Tabs (campaign bar and section bars, one shared `TabBar` style) are in
  `--text-secondary`, no longer the label's grey; Settings entries carry a chevron and an inset
  focus ring. The campaign bar's labels sit above their tabs and stay on a phone (NV2, amends IN14).
- **Tests.** `navSectionLabel.test.ts` (the CSS rules), new cases in `SettingsHub.test.tsx`,
  `CampaignTabs.test.tsx` and `GlobalSearch.test.tsx` (groups named by their labels, labels not
  links or tab stops, keyboard order the items alone); each mutation-checked. **Not verified:**
  seen only in an isolated render harness (dark, light, phone width, reduced motion), not in a
  signed-in console against a backend.

### Recording honours "recording off" 2026-11-15 (RC1–RC6, [`decisions.md`](decisions.md) "Rulings of 2026-11-15: recording honours")

From an ops report on two tenants: one's calls were recorded with recording off, the other's
recordings often would not play ("We could not reach the service that stores this recording").

- **Recorded with recording off (RC1, RC2).** VoiceLink is never told whether to record (its
  `add_lead` has no such field; none was invented), records on its account default and posts a
  `recordingUrl`, which we stored and served whatever the call asked; the call read gated only on
  the account's `agency.recording`. Now `recording_requested` is the one source of truth: the
  bridge discards such a URL at every door (warn once per call, never the URL;
  `recording_discarded_unrequested_total{provider}`), the call repository stores a
  `recording_url` only on a row that asked, and every reader goes through one predicate
  (`packages/db/src/utils/recording-request.ts`): call detail and playback (campaign, soft phone,
  signed), customer history, Insights, the agent workbook's Recorded column, the analysis queue
  and runner. Rows from before read as not recorded; `0043_recording_honours_request.sql` has
  Insights recount their buckets, and the retention purge clears their links on every run (RC5,
  Manas: get rid of them). We discard a recording a call did not ask for whatever the carrier
  does with it (RC2, Manas); nothing is asked of VoiceLink.
- **Will not play (RC3, RC4).** Every recording, VoiceLink's included, reaches the console through
  our proxy, and any answer but 403/404 reads "could not reach". Each such answer now logs a
  bounded `reason` with call id, provider and hosts (never a URL) and counts in
  `recording_fetch_failures_total{provider,surface,reason}`; the proxy gives up after 20 s without
  headers (504) instead of hanging. `PLIVO_RECORDING_REDIRECT_HOSTS` (empty by default, validated
  at load) lets an operator allow a Plivo redirect target named in the logs; the credential never
  follows a redirect. Which reason the second tenant hits is to be read from production logs.
- **Not changed (RC6).** A tagged soft-phone call takes the campaign's `record_calls` (SP rulings);
  retry campaigns inherit it; a campaign dial reads the campaign's flag at dial time. The
  station's "Recording" badge comes from the join and can be stale after a mid-session toggle
  (follow-up).

Every new guard was mutation-checked (each bridge door, the repository's write guard, the row
and SQL predicates against the analysis queue, customer history, the report oracle and the
Insights oracle, the proxy's 404, reasons, timeout and redirect hosts, the config refusals, the
migration's filter). **Not verified:** nothing has run against a real VoiceLink or Plivo account.

**Fix round after review (migrations and recording):**
- `0041_promise_to_pay` no longer builds `idx_agency_contacts_promise` under its ACCESS EXCLUSIVE;
  `0045_promise_contacts_index` builds it in its own transaction under SHARE (an empty index on
  the release: every promise is new). A SQL migration cannot use `CONCURRENTLY` (node-pg-migrate
  wraps each file in a transaction), and this index cannot be pre-built (its column is 0041's).
- RC5's purge step reads `idx_agency_calls_recording_unrequested`
  (`0046_unrequested_recordings_index`, pre-buildable `CONCURRENTLY`), picks each batch with
  `WITH picked AS MATERIALIZED (… FOR UPDATE SKIP LOCKED)` on an id keyset, and fails on its own:
  the transcript and voicemail steps still run (`unrequested_recordings_error`, Slack "one step
  failed").
- A soft-phone call's `recording_requested` takes the account's `allow_recording` at the dial (the
  "Recording" badge, customer history's "Recording expired"); an inbound call turned away for
  capacity (`no_capacity`) records nothing on its live session either, so a URL the carrier still
  sends is discarded at the bridge's door and counted.
- The analysis runner counts `access_error` on `surface="analysis"`; the dashboard has a
  Recordings row for the two RC counters.

### Do Not Call scope 2026-11-15 (DS1–DS8)

Reshma: marking a contact DNC applied across the whole tenant; she asked for one campaign beside
a separate every-campaign option. The station, the soft phone and inbound already wrote one
campaign (or the call's account) unless someone chose wider; the Do Not Call page's Add numbers
always wrote every campaign, with no choice. Now:

- **Page.** Add numbers asks where (every campaign, this account, one campaign), with nothing
  preselected, and says what each blocks; the summary splits out numbers a wider entry already
  blocks ("4 already blocked in every campaign"). The list names each entry's scope ("Every
  campaign", "North account", "Campaign: Q4 Renewals"), filters by scope or campaign, and a
  removal says who may dial again and which other entries still block the number.
- **Server.** `POST /dnc` takes a stated `scope`; a campaign must be the tenant's and in an
  account the caller manages (else one 404); every campaign needs a membership of the whole
  organisation, on the page and on the station's escalation (DS3). An account admin lists and
  removes their campaigns' entries too (DS6). No migration.
- **Words.** The same scope words on customer history and the soft phone, console and mobile.
- **Fixed (DS8).** A station `suppress` outcome (web, mobile, a supervisor's) wrote no list entry
  while the mobile wrap-up said it did. The disposition route now writes the campaign entry with
  its audit row and sweeps the campaign's other rows on the number, as the soft phone and inbound
  do; a number the list cannot hold is told to the agent after saving (`dnc_recorded: false` on
  the disposition answer) (`test/integration/api/station-suppress-dnc.test.ts`, mutation-checked).
- **Review fixes.** A removal says a number stays blocked only by entries that reach where the
  removed one did, and names the rest as blocking it elsewhere (DS5); the agent report's DNC count
  no longer takes other accounts' campaign marks; the DNC route discards a failed transaction's
  connection; campaign settings and the app's customer history say a suppress outcome and an
  unknown scope as they are. DS6 carries the reviewer's open question for Manas.

### Soft-phone calls in campaign results 2026-11-15 (SR1–SR10, [`decisions.md`](decisions.md))

Reshma: soft-phone calls in the campaign results, the exported CSV, the connect rate and the
analytics. Built beside the dialler's figures, never blended into its connect rate (SR1).

- **One definition** (`softphone-campaign-sql.ts`, SR2): a call tagged to the campaign in its
  tenant is placed (`dialed_at` set), connected (outcome `connected`), reached a person (bridged,
  coded neither voicemail nor `no_disposition`); `created_at` in `[from, to)`. Served as Insights'
  `calls.softphone` and `/stats` `softphone` (lifetime); the agent report's count uses the same
  placed rule.
- **Console.** The Calls tab shows Soft-phone calls (placed, connected, connect rate) and All calls
  beside the dialler's figures; the Overview's connect rate and each Analytics card say "Dialler
  connect rate" and add the soft phone's and all calls' rates. Shown while the soft phone is on or
  when there are any (SR5). Call log's Export CSV says the file holds them.
- **Export** (SR6). `attempts.csv` drains the campaign call log: attempts and tagged soft-phone
  calls newest first on one keyset; a new column `source` (`dialler` | `soft_phone`) after `auto_disposition_code`, the promise columns after it; the
  attempt filters mapped onto the soft-phone call; `?source=dialler|soft_phone`. Existing columns
  unchanged.
- **Campaign report** (SR8): when the window holds a soft-phone call, Soft-phone calls and All
  calls rows on the Summary and lines in the PDF's Calls section, and the dialler's rate labelled
  "Dialler connect rate" in both (one gate, `campaignSoftphoneFigures`); the account report is a
  follow-up.
- **Fix round after review:** the report follows SR1 (above); Call log's export tip and title show
  when the campaign holds soft-phone calls with the flag off; the soft phone's and All calls'
  withheld rates say "Not enough calls"; the export's preamble names what a soft-phone row leaves
  out (call details, override notes).
- **Left as the dialler's** (SR7): Agents tab, Trends, Health, the Insights CSV tables, Home, the
  agent record. No index needed (SR9, measured on 2M soft-phone calls). The mobile app is
  unaffected (it reads none of these payloads).

Mutation-checked: blending the soft phone into `/stats`' or Insights' dialler rate, dropping the
tenant check, the voicemail exclusion, the soft-phone branch's keyset, the export's tenant scope
and the attempt-only filters, and blending in the console's Calls and Overview rates each go red;
so do the report's gate, its "Dialler connect rate" label and its All calls denominator, the export
tip's stats half and the withheld readout's noun.

### Promise to pay 2026-11-15 (PT1–PT14, [`decisions.md`](decisions.md), "Rulings of 2026-11-15: promise to pay")

Reshma (collections): when an agent files a promise to pay, record the promised payment date (and
optionally the amount), show it, and let supervisors follow promises up.

- **Catalogue.** An entry opts in with `requires_promise`; `promise_follow_up_days` (1–14, off by
  default) books a call that many days after the promised date through the callback path (window,
  CA4 ownership, CA5 fallback). A promise alone never books a call (PT3). Combinations that cannot
  mean anything are refused on both validators with the field named (PT10); the soft phone's and
  inbound routes' own catalogues cannot ask for one; a promise entry cannot be an automatic outcome.
- **Capture.** The station (paced dials, the agent's own call, redials), a tagged soft-phone call and
  a matched inbound call take `promise_date` (a real date, not before the customer's today, at most
  30 days ahead) and an optional exact `promise_amount`; four refusal codes whose messages name
  the fix for an app that predates them (PT8). Console: the shared outcome pad. App: the station's
  wrap-up and inbound pads and the soft phone's.
- **Storage.** Migration `0041_promise_to_pay.sql`: the promise on each call table, the contact's
  latest promise (with the promised day's bounds in the customer's zone and a follow-up mark) and a
  partial index (PT6).
- **Display.** The Contacts tab's "Promised for" column and "Promise to pay" filter (upcoming, due
  today, missed, followed up; "missed" means no later outcome, not unpaid); the contact page, the
  attempt tables, the call pages, the customer history, the agent's panel and prior attempts (console
  and app). Exports: `promise_date`, `promise_amount` appended to the attempts CSV and
  `promise_date`, `promise_amount`, `promise_state` to the contacts CSV (PT12).

Mutation-checked: the follow-up booked whatever the entry says (the PT3 cases go red), the
past-date refusal (the server's "yesterday in Kolkata" case and the domain cases), the contact
write's "later call wins" guard, the console's date window. **Pending Manas:** the 1–14 follow-up
range, no currency (PT5), the `followed_up` state, Insights not counting follow-ups as booked
callbacks (the 30-day bound is decided, PT4). **Not verified:** no browser or phone run.

**Review fix round (2026-11-15).** A replay of the promise's own call that keeps its date keeps a
later call's follow-up mark (PT7); a same-code replay may send its stored date after the day has
passed, on all three paths, and an inbound replay with a corrected date moves the follow-up (PT1);
a promise outcome on a soft-phone call that claimed no roster contact is refused
`promise_needs_contact` and hidden from both pads, and Mark DNC refuses a promise code (PT13); the
app shows each promise refusal in the console's words on the soft phone and inbound, its date
picker reaches today + 31, and a test holds its two constants to the contract (PT8). PT2 now says
CA4 ownership is the station's only. Each fix mutation-checked (the test named in its commit goes
red without it).

### Live call listening, phase 1: the foundation 2026-11-16 (LS1–LS14, [`listening.md`](listening.md))

Supervisors will see an account's calls in progress and listen in silently from the console (the
locked design: `listening.md`, `decisions.md` "Rulings of 2026-11-16"). Phase 1 lays what the
later phases build on, with no runtime behaviour yet:

- **Contracts.** Permission `agency.calls.listen` (floor `account_admin`); flags
  `agency_live_listen_enabled` (default off, client-exposed: the consent gate) and
  `agency_live_listen_unrecorded` (default on); the listener socket's contract
  (`agency/listen.ts`: call origins, leg tags, wire sizes, frames, end reasons, close codes and
  each reason's code); the console wire (`api/agency/live-calls.ts`: the live row, the number
  reveal, the grant, a call's listen sessions); the listen refusal codes (`errors.ts` §7).
- **Data.** `0047_listen_sessions.sql`, `agency_listen_sessions` (CHECKs pinned to the contract's lists, a
  backstop against listening to one's own call, a Down that refuses while rows exist), its
  repository with real-Postgres tests, and its rows deleted at the audit log's horizon by the audit
  maintenance (LS12).
- **Audit.** `agency_call.listen_started` / `_ended`, resource type `agency_call`, on the Audit Log
  and the campaign's History.
- **Config, metrics, alerts.** `agency.listen` (the caps, the re-check, the token, the fault
  budget); `agency_listen_*`, `webrtc_relay_dwell_seconds{direction}`, the `listener` socket and
  `listen` handoff labels; the `agy-listen-*` alert group and the dashboard's *Live call listening*
  row.

Not built yet at phase 1: the tap and the bridge seam (phase 2, since built: below), the registry,
socket, routes and revocation (phase 3), the console (phase 4), the agent's standing line (phase 5), the inbound notice's words
(phase 6). Mutation-checked (each red, then restored): the permission's floor at `operator`; the
listen codes' order against their snapshot; the unrecorded flag exposed to clients or defaulted
off; a close code moved; an end reason dropped from the contract (its close map fails `tsc`) or
from the metric labels (the server's type pin fails `tsc`); the live flag left unregistered; a
listen action dropped from the campaign History or from the audit catalog; `agency.listen`'s
per-call cap widened to 6; the retention sweep's listen delete skipped; the repository's
once-only close, its tenant scope on the open calls' read, its account scope on a call's sessions,
the `NOT` in the boot reap, and its never-before-the-start end; the end-reason, origin and
own-call CHECKs; the Down's refusal.

### Live call listening, phase 2: the tap in the bridge 2026-11-16 (LS8, LS15, [`listening.md`](listening.md) §5)

The voice side, with no route or socket yet (phase 3): `core/bridge/listen-tap.ts` fans a bridged
call's two legs out to supervisors' sinks as one tag byte and 160 bytes of A-law, fed after the
relay's write in a guarded tail at the three hot-path sites (one field read with nobody listening),
on its own codecs and framers, every entry guarded, a per-leg fault budget ending its sinks
`tap_error`, one bad sink ended alone (`listener_disconnected`, `send_backlog`). The seam member
`WebRtcBridgeManager.openListenTap(callId, sink)` (refusals `not_found`, `not_bridged`, `ending`)
with `docs/seams.md` §3.1 and the seam contract tests; `LISTENER_LIMITS` and
`sendToListenerSocket` for phase 3's socket; `webrtc_relay_dwell_seconds` sampled one frame in 50
from `recordRelayFrame`. The calls the design left open are LS15.

Mutation-checked (each red, then restored with `git checkout`): the tap fed before the relay (the
dwell would include it); the tap sharing the session's codec; the session keeping the field after
the last sink; the budget off by one; no reset on a good frame; one run for both legs; a throwing
sink ending every sink; the sink's send unguarded; the soft limit widened; the hard cap treated as
a drop; a closed sink kept; `destroy` leaving the tap open; the re-attach ending it; the tail
skipped when the agent's leg is gated; "bridged" read as "answered" (a parked inbound caller
listenable); `ending` not refused; the dwell sampled every frame; the customer feed's catch
removed; `sendToListenerSocket`'s catch removed; the fault log not rate-limited; a widened
`ListenTapRefusal` (the seam contract fails `tsc`).

### Live call listening, phase 3: the server side 2026-11-16 (LS5, LS7, LS9, LS10, LS13, LS16, [`listening.md`](listening.md) §4 "As built")

The routes, the listener socket and the runtime behind them. `GET /proxy/agency/live-calls`
(`agency.supervise`, the consent flag, numbers masked, names, `listenable` computed for the caller),
`GET …/:callId/number`, `POST …/:callId/listen` (`agency.calls.listen`; the call in scope, live and
bridged, LS4, the own-call rule, then `callCore` to the owning process's grant handler, internal
`POST /listen-grants`, owner `body_session`), and the socket `/proxy/agency/listen/:sessionId/:listenId`
(`wsOwner` by the agent's session, labelled `listen`; the station rate-limit bucket): token, caps,
row (awaited), tap, `ready`, the audit pair, every end once with its close code, row counters and
metrics. `ListenRegistry` (the three caps, supersede, `revokeUser` and the 30 s re-check from the
database, shutdown), `ListenTokenStore`, revocation from the role-change and removal routes, IPC
`listen.revoke` (revocation primary → workers, supersede worker → primary → workers), the boot
and worker-reap sweeps (`server_restarted`), shutdown (`server_shutdown`). The call details answer
`listen_sessions`. Contracts (additive, for the console): `AgencyLiveCall.correlation_id` and
`aht_seconds`. The calls the design left open are LS16.

Mutation-checked (each red, then restored with `git checkout`): the per-call, per-process and
reservation counts; supersede; a supervisor's own listen counted against the cap; `revokeUser`
ending nothing, or every supervisor's; an outage treated as a revocation; the re-check timer; the
shutdown; the access check's floor, flag and LS4; the token's single use, listen id, and both
fail-closed paths; the socket's session check, row-before-tap (no row, no audio), cap at the
upgrade, idle bound, close code per reason, end-once, strict frame keys, the error handler, the tap's
counters on the row; the grant's own-call and LS4 refusals, the flag gate, the masking, the
`agency.calls.listen` floor, the UUID check; the grant handler's bridge check; the station bucket,
the `ws-limits` entry, the owner-table entry, the handoff label; `listen.revoke`'s shape check, the
worker's handler and its shutdown order, the primary's revoke broadcast and supersede relay (the
cluster suite); the revocation hook's catch and the remote supersede's own-replica filter; the role
change's and the removal's revocation (end to end); the boot sweep; the account scope of the live
list (both of its layers together: each alone stays green, by design); the call detail's
`listen_sessions`; the listener route's `preClose`.

### Live call listening, phases 4 and 5: the console and the agent's line 2026-11-16 (LS2, LS6, LS9, LS13, [`listening.md`](listening.md) §9)

Built against the contracts while the server's routes (phase 3) are not there yet, so nothing is
live until they are. **Live calls** at `/agency/live` (Campaigns, beside Soft-phone calls) and a
campaign's Calls tab "Summary | Live" (`…/calls/live`), behind `agency.supervise` and
`agency_live_listen_enabled`, Listen behind `agency.calls.listen`; the navigation, search, campaign
tab and route-gate tables with their guards. `LiveCallsTable` (every column, sort, filters, row
states, the number's Show/Hide on demand, the 5 s poll, the server clock), the shell's one listen
(`ListenProvider` in `ConsoleLayout`, ended by leaving the shell or the account; the first-use
confirmation; the refused grant's toast), `ListenBar` (every state, the LS6 notice always, Esc,
mutes, remembered volume, phone width), the session as a pure reducer with its controller (grant,
socket, ping every 10 s, a fresh grant per reconnect for 15 s) and the playback (one context, per
leg a decoder, a 120 ms queue, a meter and a mute; no microphone). "Listened to by" on the dialler
and soft-phone call pages. The agent's standing line (LS2) behind an info button in the station
header and on the campaign screen they join from, and in the mobile app's station info sheet
behind the client flag (copy only). The two gaps this phase left (amber on the campaign view only,
"Open call" to the live view) are closed by the follow-up below.

Mutation-checked (each red, then restored with `git checkout`): the Live calls tab or the campaign
Live screen without the flag (`navRouteGates`); a close from an older attempt applied; the
reconnect window renewed by every drop; a refused first grant opening the bar instead of a toast;
the three-failure bound raised or its check removed (raising it first stayed green: the test
counted with the constant, now fixed); no ping; Stop without the `stop` frame; audio played before
`ready`; no stop on unmount (leaving the shell, switching account); Esc not stopping; the LS6
notice dropped once ended; the first-use confirmation skipped; Hide not masking again; the Action
column without `agency.calls.listen`; a microphone API named in a listening module; mute leaving the
leg audible; no cushion on an underrun; an unknown leg tag accepted; the listener token not
redacted at the analytics boundary; the station's line shown with the flag off; and on the mobile
app the info button shown with the flag off and a wrong flag key.

### Live call listening, the console against the server 2026-11-16 ([`listening.md`](listening.md) §9)

The console reads what phase 3 added to the live row. **"Open call"**, in each table row and in the
listening bar, opens the call's own page from `correlation_id`: a dialler call's attempt, a
soft-phone call's page; an inbound call has no call page in the console, so its row has no link
and the bar opens its live view. **Amber** past twice the AHT reads the row's own `aht_seconds` on
the account page and the campaign view alike (the campaign view's stats workaround is gone).
Checked field by field and message by message against the server (the routes, the grant's `ws_url`
and `token`, `ready` / `ended` / `pong`, `ping` / `stop`, every close code and reason, the refusal
statuses, the call details' `listen_sessions`): it matches, except that the server's error mask
strips the grant's own 503 bodies (`listen_limit_server`, `listen_unavailable`), so the console now
reads a 503 without a listen code as `listen_unavailable`. A shutdown's close with no `ended`
frame (1005, LS16 g) is pinned as a reconnect. The route-path guard
(`apps/server/test/unit/api/agency-route-table.test.ts`, `console-paths.json`) has the four paths
and passes (9).

Counts: `apps/console` 7274 (386 files), lint clean; `pnpm test:tooling` 20. Mutation-checked
(each red, then restored with `git checkout`): a soft-phone call opening an attempt path; an inbound
call given a page; amber ignoring the row's AHT; the bar back to the live view for every call; a
503 without a code not read as unavailable; a close with no code (1005) taken as the call's end;
"Open call" dropped from a row fading as ended.

### Live call listening, phase 6: the notice's monitoring words 2026-11-16 (LS1, [`listening.md`](listening.md) §10)

An inbound caller told the call is recorded is now told it may be monitored too: the standard
recording notice (`AGENCY_INBOUND_STANDARD_WORDS.recording_notice`) is "This call may be recorded
or monitored for quality and training purposes.", and `apps/server/assets/inbound/recording-notice.wav`
is regenerated from those words with `scripts/generate-inbound-clips.ts --only recording_notice` and
the pinned voice (8 kHz mono PCM16, a plain 44-byte header, 5.0 s, peak −3 dB); the other six
recordings are byte for byte as before. A route's own notice recording is the account's to re-record.
The words are quoted in `assets/inbound/README.md`, `inbound.md` §3.4 and the route editor (from the
contract). Mutation-checked (each red, then restored with `git checkout`): the old sentence in the
contract (the contracts pin and the route editor's test), and a 16 kHz WAV with a metadata chunk in
place of the notice (`inbound-standard-clips.test.ts`).

### Live call listening, the console and mobile review fixes 2026-11-16 ([`listening.md`](listening.md) §9)

A review of the console and mobile side found twelve faults, all fixed. The listening
bar's audio no longer piles up against a stopped clock: while the browser will not run the
context (autoplay, an interruption) frames are dropped and the queue stopped, only a gesture
resumes it, and "Turn sound on" plays from now rather than in a heap; a burst past 600 ms stops
the leg's queue before re-basing, so the call never talks over itself; a listen that ends
silences at once and suspends the context; a browser that cannot play sound is refused before
any grant. Server failures are counted across `ready`s (a tap failing after every `ready` ends
in "Connection lost" instead of looping), and the first attach has its own 15 s. Overlapping
live-list reads land in order. The table and the bar are `ph-no-capture` (CH6). Focus moves to
the bar on Listen and back to the row's Listen; the ended reason is announced; "The call ended
before you joined." on a first-attach 4404. "Agent is silent" replaces "Agent reconnecting…" (a
muted console agent sends nothing). The per-call limit's words name no count. The grant's 503s
are read by their code (the server route now marks them reviewed). `ConsoleLayout`'s listen
wiring and teardown are pinned. On mobile the flag key is `agency_wire`'s
`FeatureFlags.liveListenEnabled`, pinned against the contract's fixture.

Mutation-checked (each red, then restored with `git checkout`), 22 in all: playback without the
drop while not running, without the flush on `statechange`, without the flush before re-basing,
`release` without suspending, an unguarded context factory; the failure count reset by `ready`,
and never reset; no first-attach deadline in the reducer, and none in the controller's timer;
the live list without its sequence; the table's and the bar's `ph-no-capture`; the provider not
releasing, not refusing a browser without sound, Try again not resuming; focus not moved to the
bar, not returned to the row, returned even when moved elsewhere; the ended reason outside the
live region; "you listened for 00:00" back; `ListenProvider` not keyed by the account; the bar
inside `<main>`.

### Live call listening, the console and mobile persona-review fixes 2026-11-16 ([`listening.md`](listening.md) §9)

The product review's console and mobile items (its two major findings, its minor ones and the polish list). The
agent: the standing line is on the standalone soft phone (`/dialer/phone`) and both mobile
soft-phone surfaces too, behind an info button renamed "Monitoring and recording", and the first
time an agent opens the station or a soft phone for an account while listening is on, a notice
under the header says it until Got it (per agent and account; browser storage on the console, the
app's key-value store on mobile). The supervisor: the first-use confirmation says the times "are
recorded and can be seen by your account’s admins"; the table keeps a chosen agent or campaign on
offer after its calls end and offers Clear filters, hides "0 in progress", says "Updated just now",
"No name" for a dialled number, counts a full call's listeners ("2 supervisors are already
listening") and "+N" past three avatars, and offers Stop beside Connecting and Reconnecting; the
bar's ended line is "Priya S. with ****4321 · you listened for 02:10" under "Call ended",
"Connection lost" says the call is not affected and offers Try again and Close, an inbound call
has no Open call, a supersede names another tab or window, and the flag or the permission going
away here ends the listen with "Listening has been turned off for this account." or "You no
longer have access to listen to calls." (a re-grant refused `feature_disabled` says turned off)
instead of the bar vanishing. The protocol-ping liveness (LS22 d) needs nothing on the client: a browser answers the server's
protocol pings itself, and the JSON `ping` stays. Left for later (they need contract changes from
the server side): withheld numbers, `access_unverified`, the history page, the Settings line.

Mutation-checked (each red, then restored with `git checkout`), 16 in all: the provider stopping
instead of withdrawing; no `turned_off` for a `feature_disabled` re-grant; a withdrawal ignoring
"Connection lost"; the chosen agent not kept; Got it not remembered; the soft phone header without
the info button; the row's Stop doing nothing; the bar offering a fallback link for inbound; no
"+N"; on mobile, Got it not stored, a stored dismissal ignored, the flag not gating the notice, the
soft phone's info button and notice and the call layout's notice each removed, and the soft phone
title not flexible at 200% text.

### Live call listening, the load check 2026-11-16 ([`listening.md`](listening.md) §10 "Load check")

`apps/server/test/integration/load/listen-media-load.test.ts` (wall-clock lane, about 3 minutes):
100 bridged calls at 50 frames a second each way (mock VoiceLink carrier, real agent sockets, half
`alaw8`, half `pcm16`) with nobody listening, then 6 listeners (the expected peak) and 20 (the
process cap, a 21st refused `503 listen_limit_server`), one stalled each time, through the real
grant and upgrade, the listeners in a child process (`listen-load-clients.ts`). Zero frames lost on
either leg in every run; against the same floor's quiet window, 20 listeners cost at most about
+0.07 of loop utilisation and nothing measurable in loop delay p99 or frame latency (the bounds and
the numbers are in `listening.md`); every reading listener gets 50 messages a second per leg; the
stalled one is dropped at its soft limit, then ended by the 30 s idle bound with its call untouched
(since the voice review, `send_backlog` after 10 s of drops, LS17 b; re-run green on `a13635b`).
The proof is the loop and the latency, not the relay dwell, which excludes the tap by construction.
Found and fixed: the grant's 503 refusals were masked by the app-wide error mask (`7b1c92a`), so
the console could not say why a Listen was refused. Found: on loopback a stalled listener is ended
by the idle bound before the soft limit is reached (the kernel absorbs about 4 MB); the suite corks
the stalled listener's server end to model a real path.

The media load suite's start-negotiation flake (`load/voicelink-media-ws-load.test.ts`, the
`media_before_bad_start` case ending `provider_start_timeout`, seen in phase 3's counts below and
before it): not the listen tap (with nobody listening the tap is one null read, and nothing it does
runs before a leg is attached). The case sent 25 media frames then its bad `start`; when Redis
answered the provider-token check late, all of them landed inside the check, past the 16 frames the
bridge holds meanwhile (`PSTN_EARLY_FRAME_CAP`, pinned by its unit test), so the `start` was dropped
by design and the call timed out instead of failing `unsupported_media_format`. Reproduced 3 of 3
by pausing Redis clients 25 ms in every 75; the case now sends one frame fewer than the cap
(`626404c`) and passes 3 of 3 under the same pauses. A real carrier sends `start` first, so the cap
is not changed.

Mutation-checked (each red, then restored with `git checkout`): a 1 ms busy wait in the tap (every
primary bound red; the dwell unchanged); the listener's soft limit removed (the stalled listener
closed `send_backlog`); a listened call's relay dropping one frame in 500 (zero-loss red); the error
mask on the grant's 503 (the route test red before the fix). The tap fed before the relay is not
caught by the load suite (the dwell moves within noise) and is pinned by
`webrtc-bridge-listen-tap.test.ts`, which goes red for it.

### Live call listening, the voice review fixes 2026-11-16 (LS15 f–g, LS17, [`listening.md`](listening.md) §2, §5, §8)

A review of the bridge tap found seven faults, all fixed in `618108f`. A listener heard the
agent's microphone after a hangup of ours while VoiceLink's confirmation wait ran (up to 45 s), and
both legs briefly inside `endCall`'s awaits: the tap now ends `call_ended` as the call enters
`ending` and at the top of `endCall` (LS15 f). The relay-dwell alert could not see the tap (fed
after the write): `agy-listen-loop-delay` (event-loop delay p99 above 40 ms for 10 min while listens
are open) replaces it, with the metric's comment and the runbook (LS17 d). Plivo's μ-law customer
reaches listeners through a 256-entry μ-law → A-law table (`wireFormat: 'mulaw8'`), bit for bit the
per-sample conversion, and transcoded legs are primed to a whole first frame so they run carry-free
(LS17 a: a deviation from the locked codec-pair path). A listener with every frame dropped at the
soft limit for 10 s is ended `send_backlog` (LS17 b; the alert's comment now says 256 KiB ≈ 16 s). A
failed message counts its 20 ms frames (LS17 c). The re-attach's reset and the Plivo leg's audio
through the real module are pinned. The load check's stalled listener now expects `send_backlog`;
`listen-media-load.test.ts` is updated and not yet re-run (re-run green since, on `a13635b`: the
load check entry above).

Mutation-checked (each red, then restored with `git checkout`), 14: no tap end at `ending`; none at
the top of `endCall`; `resetAgentLeg` emptied, keeping the encoder, the framer's tail, the priming;
μ-law through the codec path; no priming; no 10 s bound; a sent frame not restarting the clock; the
timed close not counted dropped; a failed message counted as one frame; an undeclared metric in the
new alert (`pnpm test:grafana` red).

### Live call listening, the server review fixes 2026-11-16 (LS16 c–d, n–v, [`listening.md`](listening.md) §4, §6)

A review of the agency and API side found nine faults (S1, S3–S10; S2, the masked 503s, was already
fixed in `7b1c92a`), fixed in `9f32bc5`. The upgrade never re-checked access, so a supervisor
demoted (or a tenant turning the flag off) after a grant could attach within its 60 s and listen
until the next pass: it now asks the database before the row (4403, or 1011 when it cannot say), and
a per-supervisor revocation generation, bumped by every `revokeUser`, goes from the grant's token
into the reservation, so a revocation between grant and admission refuses it. The immediate path
fails closed; the periodic pass fails open but ends a session not verified for 4 × the re-check
interval (LS16 c, d). The flags fell back to registry defaults on a flag-store outage (every listen
ended; LS4 opened): they are read through `FeatureFlagService.strictSnapshot`, an outage being
"cannot check" (the grant 503 `listen_unavailable`). The super-admin role change and removal now
revoke. A failed row close was dropped (a phantom listener): it is retried on the re-check tick,
and a live process sweeps its own rows it no longer holds. The handoff logged an unspent token's URL
raw. Two listens admitted at once in two workers could end each other (only older rows now). A
stopping process answered the server's limit (now `listen_unavailable`). The "at once" revocation
suites could pass on the periodic pass (it is held off to 5 min there). Nits: retention on the
partitions' month boundary, the AHT cache bounded, the dialler spine on
`idx_agency_attempts_account_live` (plan test), `maxPerUser` per tenant documented. The load check's
expectations now allow its stalled listener to end during the window (`e0bf526`).

Mutation-checked (each red, then restored with `git checkout`), 25: no access check at the upgrade;
admission ignoring the generation; the reservation ignoring the grant's; the immediate path failing
open; no staleness cap; a good check not refreshing it; `strictSnapshot` degrading like `snapshot`;
an unreadable flag read as passed; a failed close not queued; the sweep forgetting closes in flight;
the tick's held ids without reservations; a supersede of newer rows; stopping as the server's limit;
the handoff's raw URL; the super-admin role change's and removal's revocation; the grant's flag
outage as 403; the AHT cache unpruned; the grant's generation not recorded; the old campaign-join
spine and the `reserved_agent_id` predicate (the plan test); the sweep's keep list and its age floor
(real Postgres); retention at the exact cutoff; the immediate path off in one process (end to end)
and in a media worker (the cluster suite).

### Live call listening, the server persona-review fixes 2026-11-16 (LS21, LS22, [`listening.md`](listening.md) "LS22 in full")

The principal reviews' server, database and contract items (the engineering review's, the QA
review's and the product review's last two minor ones, the nits and doc drift), in `b3114f9`. Manas's decision 4 (LS21): an access
re-check that cannot be made ends a listen after 2 × the re-check (60 s, was 2 min) as
`access_unverified`, close 4503, not `permission_revoked` (`0048_listen_sessions_unverified.sql` extends the CHECK; the
contract, the metric label). The rest are LS22: `live_at` (0048) so "Listened to by" shows only
sessions that went live; protocol pings with the pong as liveness (a hidden tab's throttled timers
no longer end it every minute); a per-socket message rate (1008); refusals with no `ended` frame (a
tap that ended under the attach 4404, one that threw 1011); a token store outage 1011, not 4401;
every listener close then terminated after 5 s (as the station's backlog close); the upkeep reading
its held ids at the sweep (a slow retry could sweep a session admitted meanwhile) and a hung tick not
stacked on; the tap's fault budget through the seam (`openListenTap`'s options; the voice area reads
no agency config); withheld numbers said so (`customer_phone_withheld`, `404
live_call_number_withheld`); an invite or its claim re-checking listens; `selectMembership` moved
to `rbac/` and shared; `listOpenInAccount` and `ListenRegistry.all` removed; the live SQL ordered by
name; the audit logger's `flush` for the e2e's reads. New coverage: the soft-phone and inbound
spines' plans and the AHT read's (the inbound spine needs many tenants' rows to choose its account
index: with two accounts the planner scanned every tenant's open inbound calls), a media worker
killed mid-listen, the agent's own hangup, a grant whose call ended before its upgrade, the agent's
own soft-phone read, a super-admin's session. The load check asserts its timing bounds only with 4
or more CPUs or when asked. Not done here: wiring `full-ci` to `LISTEN_LOAD_BOUNDS=on` (a CI
change), and the console's use of the new end reason, close code and withheld flag (the console
pass after this one).

Mutation-checked (each red, then restored with `git checkout`), 27: the staleness cap back to 4; its
reason `permission_revoked`; the immediate path's unchecked as `permission_revoked`; the tick guard
off; the held ids snapshotted at the tick; a tap ended under the attach admitted; the pong not
counted; the message rate off; a plain close; a throwing tap as the call's end; a token store outage
as 4401; the token store answering null; no live stamp; every close marked live; the bridge reading
the budget from config; the socket not passing it; the claim's and the invite's revocation; the
withheld rule; the token query's type guard; the logger's flush stopping it; the membership pick
reversed; "Listened to by" without `live_at`; 0048's CHECK without the reason; its Down's refusal;
the worker reap closing every open row; the worker reap closing none.

### Live call listening, the persona review: history and guard rails 2026-11-16 (LS18–LS20, [`listening.md`](listening.md) §12)

The product owner's decisions on the persona review, server side (the console's pages are a later
step). **The listening history (LS19):** `GET /proxy/agency/listen-history` and `.csv`
(`agency.supervise` and the consent flag), through the internal `GET /api/v1/agency/listen-history`;
a supervisor's sessions on one call merged on the server into one entry (30 s gap, or while one is
open; overlaps counted once); the CSV masked and audited `agency_listen_sessions.exported`;
contracts `api/agency/listen-history.ts`. A campaign's listen History rows name the agent
(`detail.agent_name`, at the read). **Guard rails (LS20):** `agency_live_listen_enabled` has a
handling policy in the super-admin flag routes (`feature-flags/flag-policies.ts`: a reason to turn
it on, no bulk rollout, no global On); the super-admin registry says why a global On is refused;
`agency_live_listen_unrecorded` is client-exposed for the Settings line; the enablement checklist
is in [`operations.md`](operations.md), with LS18's inbound item. **The live list and the number**
answer a flag store outage `503 listen_unavailable`, not the `403 feature_disabled` the console
stops polling on. Mutation-checked: the history's merge gap, its open-session merge, its time
counted once, its account scope and its cursor's id tiebreak (`listen-history.test.ts`); the
public layer's masking, its export audit row and its outage answer
(`proxy-agency-listen-history.routes.test.ts`); the listen row's agent name
(`agency-activity-service.test.ts`); the live list's and number's outage 403 and an unmasked 503
(`proxy-agency-live-calls.routes.test.ts`); the policy's override check, bulk check, global
refusal and blank reason (`super-admin-feature-flags.test.ts`); the registry's global-On guard
(`SAFeatureFlagsPage.test.tsx`).

### Live call listening, the two persona-review branches merged 2026-11-16 (LS18–LS22)

The history and guard rails branch (LS18–LS20) merged into the server persona-review fixes (LS21,
LS22) in `74eaeaa`; the docs keep both sides (rulings LS18–LS22 in order, the pending rows
together). The live list's flag gate answers an outage `503 listen_unavailable` on every route
(LS20's branch) with the withheld-number changes (LS22 i) kept. Integration fixes in the commit after the merge:
`AGENCY_LISTEN_END_REASON_LABELS` has words for `access_unverified` ("Access could not be
checked"); `LISTEN_HISTORY_SQL` reads only sessions that went live (`live_at IS NOT NULL`, as
"Listened to by"), so a row refused at the upgrade neither shows in the history nor bridges two
visits (the history test seeds `live_at`); the history's withheld flag uses the live list's rule
(`isWithheldNumber`, no digit at all; a null number is still a purged call row). Two lines of the
LS21 docs named the migration by the word and its number, which the self-containment guard
(`no-external-references.test.ts`) reads as another repository's migration number: they name the
file instead. Mutation-checked (each red, then restored with `git checkout`), 3: the label removed
(`listen-history.test.ts` in contracts, and the lint); `live_at IS NOT NULL` dropped (the history
integration test); withheld back to `''` only (`proxy-agency-listen-history.routes.test.ts`). The
console does not yet word `access_unverified` (its `terminalEndReason` falls to the close code):
the console pass after this one.

### Live call listening, the persona review's console 2026-11-16 (LS6, LS19–LS22, [`listening.md`](listening.md) §12 "The console")

The console side of the product owner's persona-review decisions. **The account's Listening
history** (`/agency/listening-history`, a Campaigns tab beside Live calls, `agency.supervise` and
the consent flag): supervisor, agent, call type, the masked customer or "Withheld", start, time
listened, how it ended in the contract's words, "Open call" where the call has a page; filters for
supervisor, agent and date range, keyset paging, Export CSV with the applied filters and its
truncation said; `403 feature_disabled` final, `503 listen_unavailable` read again after 5 s;
`ph-no-capture`. The two history routes moved from the route-table guard's server-only list into
`console-paths.json` with `api/listenHistory.ts`. **Settings → Live call listening**: "Live call
listening: On / Off", whether unrecorded calls are included, "Ask your account manager to change
this.", from the client flag map. **Readable History rows**: "Listened to Priya S.’s call for 2m
10s · ended: stopped by the supervisor", the call linked by the row's origin. **Merging**
(`mergeListenVisits`, the server's 30 s rule) on the History and in "Listened to by".
**`access_unverified`** (4503 or the `ended` frame): "Listening stopped because your access could
not be checked. Try again." with Try again, no reconnect loop. **Withheld numbers**: "Withheld", no
Show, the reveal's 404 handled. **The confirmation** now says the listen is "recorded in the
account’s Listening history." **The live list** keeps its rows and polls on through a 503. No
server source or contract change (the contract's `customer_phone_withheld` stays optional). The
self-containment guard's one hit at `78d58a7` (this file naming a migration by the word and its
number) is reworded. Mutation-checked (each red, then restored with `git checkout`), 26: 4503's
close outcome; Try again from an `unverified` end; a withheld row's flag, the reveal's 404, the
bar's target; the live list's 503 read as final; the merge's gap at its edge and its overlap;
"Listened to by" unmerged; the History unmerged and its summary dropped; the history page's 503
retry, its `feature_disabled`, its truncation toast, its `ph-no-capture`, its cursor, its export
with the draft filters; the util's purged-call link, its exclusive `to`, its "Withheld"; the
client's truncation header and its filters; the Settings line's loading state and its unrecorded
line; the nav entry's flag; the route inventory without the CSV path.

### Live call listening, the final review fixes 2026-11-17 (LS17 a, LS22 l, n–u, [`listening.md`](listening.md) §10)

A last review of the whole feature (server, data, clients, completeness), fixed in `756f997` to
`3653072` (server, contracts, database), `afb49dd` (console) and `044427d` (mobile). Server: the
super-admin's `POST /super-admin/tenants/:id/users` re-checks the user's listens, and the tenant
context reads `X-Tenant-Id` and `X-Account-Id` lower-cased, so an upper-case header cannot miss an
account seat (LS22 l); the live-call routes and the history's page answer `Cache-Control: no-store`
(LS22 n); the upgrade's access check and row insert are each bounded to 10 s, refusing 1011
`listen_unavailable` (LS22 o); `FF_AGENCY_LIVE_LISTEN=true` is documented dev and staging only and
warned at boot (LS22 p); a tap that throws as it opens is counted `stage="open"`, and the
tap-errors alert names the log component the code writes (LS22 q); a failed close of a dead
process's rows is retried on the primary's re-check tick (LS22 r); a cross-process supersede reaches
a listen still in its upgrade (LS22 s); the history reads one page's visits on an index of its own,
`0049_listen_history_index.sql` (LS22 t); the μ-law table is pinned against G.711's own table
written out as literals (LS17 a reworded: it differs on 44 codes by one A-law step, a scale
convention, and is kept); the listener route's own refusals close then terminate; the in-process
token store forgets lapsed grants; the session purge waits for a failed audit partition purge;
`listen_sessions` is declared on the call detail contracts; code comments cite LS letters rather
than review ids. Console: at phone width the bar says its state in words in a live region and its
rows wrap; an ended reason wraps at every width; "turned off" is read only from a loaded flag map;
the confirmation checks again; Try again leaves the stopped time out of "you listened for"; a late
resume after the end suspends; soft-phone call links follow `agency_softphone_enabled`; the
history's new filters drop the old cursor, a failed read clears the rows, only this account's
people are offered as filters. Mobile: on a call the first-time notice says the line can be read
again between calls, as the call's band has no button (LS22 u, which also records the one-time
notice as a build call). Manas ratified every remaining LS build call on 2026-11-17. The
`full-ci` wiring of `LISTEN_LOAD_BOUNDS` and the real-world checks are next steps (below).

### Live call listening, the history without the flag and the legal check 2026-11-17 (LS1, LS19, [`listening.md`](listening.md) §12)

Two decisions by Manas on 2026-11-17 close the feature's open questions. **The Listening history
is gated by `agency.supervise` alone** (LS19 amended): turning listening off stops new listens, not
the record of past ones. `GET /proxy/agency/listen-history` and `.csv` no longer read
`agency_live_listen_enabled` (no `403 feature_disabled`, no `503` on a flag store outage); account
scoping, masking, the CSV's audit row and its limits are unchanged. In the console the Campaigns
section's "Listening history" tab, its search entry and its route (no `RequireFlag`) are offered
for `agency.supervise` whatever the flag; with Live calls hidden the bar is Campaigns and Listening
history (every supervisor has Campaigns, so the tab never stands alone). The page drops its "turned
off" state and its flag-outage retry: a 401 or 403 says the history is for supervisors, anything
else (a 503 included) offers Try again. Checked and unchanged, as never flag-gated: a call's
"Listened to by" (`listen_sessions` on the attempt and soft-phone call details, `ListenedToBy`),
the campaign History's listen rows (the activity service and page) and Settings → Live call
listening (shown whether listening is on or off, LS20 c). **The consent and notice wording's legal
check is done** (LS1, LS2, LS18), recorded on LS1; the open-questions row in `decisions.md` §5 and
here is gone, nothing being left in it. Code in `1afa43e` and `4858093` (two navigation tests that
counted the Campaigns bar with listening off). Mutation-checked (each red, then
restored with `git checkout`), 5: the server's flag gate re-added
(`proxy-agency-listen-history.routes.test.ts`, 9 red); the nav entry's flag re-added
(`consoleNav.test.ts`, `consoleSearch.test.ts`, 3 red); `RequireFlag` back on the route
(`ListenHistoryPage.test.tsx`); a 503 read as final; the page reading the flag itself (21 red).

### Analysis: why the AI vendor refuses, and an alert when it does not stop 2026-11-18

Staging's post-call analysis worker was rate-limited (HTTP 429) by Gemini from 21:10 IST on
2026-11-17, one second after a boot, and stayed refused all night: two WARN lines every 12-18
minutes with no reason in them, and the job row's `error_message` a fixed "transcriber
rate-limited" text. A short per-minute limit and an exhausted daily quota or billing stop looked
the same. Now: the AI clients keep what the vendor said on a `rate_limited` `AiError` (Gemini's
status, exceeded quota ids and retry delay, parsed from the SDK's JSON body; OpenAI's code and
`retry-after`/`retry-after-ms`); a `RATE_LIMITED` `TranscriptionError` carries the same detail
(Gemini's mapped from its `AiError`, Sarvam's from its own 429 body and `retry-after`), and the
runner turns either into one flat set of log fields that it and the worker both write, with the
refused `stage` (`transcribe` or `analyze`) and `refusingSince`; the job row keeps it in
`error_message`. From the 8th consecutive pause (~45 minutes, no job completed;
`PERSISTENT_RATE_LIMIT_PAUSES`) the worker logs ERROR, and each process logs its recovery at INFO.
New gauge `dialer_analysis_rate_limit_consecutive_pauses`, a dashboard panel (*Dialer Analysis
Vendor Refusals*) and the warning alert `agy-analysis-vendor-refusing`, filtered to deployments
still pausing (each analysis process holds its own gauge until a job of its own completes); the
validator pins its threshold to the worker's constant. Runbook: [`operations.md`](operations.md),
"Alert runbooks". Reviewed by a fresh-context reviewer; its findings (the stale gauge across
processes, the untested worker hop, the runbook's keys and per-minute remedy, the doc counts, the
dashboard) are fixed in the same commit, and a cleanup pass (reuse, simplification, efficiency,
altitude) flattened the cause into one shape and moved it off the breaker. Mutation-checked (each red, then restored with
`git checkout`), 16 in all, among them: the worker dropping the cause, the runner dropping the
stage or the row's reason, the transcriber dropping the cause, the escalation threshold off by
one, `since` reset on every opening, the close never announced, the parsers' edge cases, the
repository ignoring the reason (real Postgres), the constant drifting from the alert, the alert
losing its filter, Sarvam's 429 losing its detail. Not changed, and why: campaigns are not paused outside calling hours or with no
agents (pacing already dials nothing and resumes by itself, `pacing-engine.ts` "`to_dial == 0` IS
the paused state"); the analysis worker keeps working overnight, which is when it should catch up.

### Plivo's regional recording media hosts, and re-queueing what they failed 2026-11-18 (B21, PL6, RC4 amended)

Staging refused every Plivo recording stored on the account's regional media host: from
2026-11-17 01:11 UTC the analysis worker logged "Recording URL is not on the recording-host
allow-list; refusing to fetch" (`host=aps1.media.plivo.com`, `reason=host_not_allowed`, hop 0)
33 times, each a job failed for good (`TRANSCRIPTION_FAILED`, not retryable), and the console's
player 502'd 4 calls (8 "refusing to proxy" lines). Plivo gives the regional host as the
recording URL itself, so `PLIVO_RECORDING_REDIRECT_HOSTS` could not help: Plivo's access matched
`media.plivo.com` exactly. Now (Manas asked for it; B21, PL6 and RC4 amended in
[`decisions.md`](decisions.md)) Plivo's access matches `media.plivo.com` and any subdomain of it on
a dot boundary (it no longer sets `exactHosts`, `telephony/recording-access.ts`), on the first URL
and every redirect hop, for both consumers (the playback proxy and the analysis fetch), with Basic
auth on the first request only as before. Accepted: `media.plivo.com`, `aps1.media.plivo.com`,
`usw1.media.plivo.com` (any case, a trailing dot). Refused, with tests: `api.plivo.com`,
`plivo.com`, `www.plivo.com`, `evilmedia.plivo.com`, `media.plivo.com.evil.com`,
`aps1.media.plivo.com.evil.com`, `media-plivo.com`, the host as userinfo (also with a port), after
a backslash, in the path, query or fragment, http, and (new, for every carrier) a host with an
empty label (`.media.plivo.com`, `aps1..media.plivo.com`), which `recordingHostname` now refuses
rather than leave to DNS. VoiceLink's rule is unchanged. Tests that pinned the old exact-only rule,
updated: `recording-proxy.test.ts` (a Plivo URL on `evil.media.plivo.com` was a 502; it is now a
media host, replaced by `evilmedia.plivo.com` and the cases above), `recording-access.test.ts` and
`dialer-analysis-runner.test.ts` (`exactHosts: true` on Plivo's access). The failed jobs: an
operator script (`requeue-recording-host-refusals`) re-queued them with the existing
`requeueForManualRetry`; it was removed once staging's had run (next entry). Mutation-checked
(each red, then restored with `git checkout`): Plivo's access back to exact-only (10 unit and 1
integration red, the aps1 and usw1 accept cases among them); the subdomain match without its dot boundary (5 unit and 1 integration red,
`evilmedia.plivo.com` among them); the empty-label guard removed (3 red); the server's refusal
message reworded (the 2 pattern pins red); the selector widened, without its message match (1 red
in `packages/db`, 1 in the script's integration test) and without `status = 'failed'` (1 red); the
selector and the script are gone since.

### The recording-host re-queue script removed 2026-11-18

The operator script that re-queued the analysis jobs a recording-host refusal had failed
(`apps/server/scripts/requeue-recording-host-refusals.ts`, bundled as
`dist/requeue-recording-host-refusals.js`) has done its one job: staging's jobs on
`aps1.media.plivo.com` were re-queued after the fix deployed, and no other deployment had such
failures (Manas, 2026-11-18). Plivo's regional media hosts are accepted now, so that refusal cannot
recur. Removed with it: its unit and integration tests, the repository selector
`findRecordingHostRefusals` and its pattern `RECORDING_HOST_REFUSAL_MESSAGE` (and their tests in
`dialer-analysis-job.repository.test.ts`), the build entry, the `analysisAttemptLimitsSchema`
split in `config/blocks/analysis.ts` (the two ceilings are inline in `dialerAnalysis` again), and
the runbook in `operations.md`. The host-check fix and its tests stay. Should an allow-list fix
need failed jobs re-run again, the way back is a general retry of failed analyses over
`requeueForManualRetry`, which still has no caller.

### Live floor 2026-11-18 (LF1–LF10, B28b, [`decisions.md`](decisions.md) "Live floor (LF)")

Home (B28a) is rebuilt as the Live floor, the supervisor's landing page, at the same URL and gate.
**Phase 1** (console only, on Home's reads): the tiles (agents working, calls dialled since
midnight, customers reached "of dials answered", Will pay, late callbacks), Needs you now beside
the active campaigns (ranked by `HOME_RANKS`, LF9), grouped calling hours, the campaign filter, and
a Callbacks section in the sidebar (`/agency/callbacks`, an interim per-campaign list until the
account-wide one). **Phase 2** (B28b): one account-wide floor read, `GET /proxy/agency/floor`
(agents, states, the call each is on with its customer's name and whether it can be listened to,
"N of M assigned", dialler conversations today, cached 30 s per account), the promises summary
`GET /proxy/agency/promises/summary` across attempts, manual and inbound calls (migration
`0050_promise_summary_indexes.sql`, three partial indexes built `CONCURRENTLY` in production:
`db-hygiene.md`, `DEPLOYMENT.md`), and who paused or stopped a campaign on Home's board
(`status_changed`; a stop's time from `agency_campaigns.stopping_at`, which the transition into
`stopping` stamps, `0051_campaign_stopping_at.sql`). On the console: the agent card grid with state
chips (a new "On soft phone"), Listen from a card, break overruns past 30 minutes as Needs you now rows, Will pay per campaign,
"Paused by" on the campaign cards. **Coming soon** (focusable `aria-disabled` buttons with a
tooltip, `components/common/ComingSoon.tsx`, LF1): Need help on the console station, Talk to agent,
Send reminder, Give to free agents, Join call, and the Need help chip. Not on the agent app.
Phase 3 replaced all of them but Join call (below); Phase 4 (Join call, whisper, LF8) is under
"Not built".
Known limits: the dialler-conversations count reads the day's attempts deployment-wide before it
filters to the account (an account-first index would bound it); Will pay shows Successes for a
moment until the promises read answers.

### Live floor Phase 3 2026-11-19 (LF4–LF7 decided; LF11–LF39 built as defaults, pending Manas)

Phase 3 of the Live floor, as Manas decided LF4–LF7, on the console, the app and the server.
**Need help** (LF4, LF11–LF16, LF24, LF28, LF35): the agent raises it on their own live session, on
a call or in wrap-up, from the console station's action bar or the app's call and wrap-up screens
(`POST`/`DELETE /proxy/agency/sessions/:id/help`; the session row's `help_*` columns,
`0052_floor_assist.sql`). Every `agency.supervise` holder sees it on the floor read
(`AgencyFloorAgent.help`, polled every 5 s, no push): it tops Needs you now, the agent's card goes
red with a "Needs help" tag, and a chime sounds once per new request (on by default, muted per
browser, LF31). It clears exactly once: a supervisor's listen going live on the agent's call, their
message reaching the agent's station, the agent's cancel, 15 minutes (read on every read against
the database's clock; a 15 s sweep in the primary sends the frame and writes the row), or the
session ending; the station hears `help_answered` and `help_cleared`, each end is one audit row,
and an expiry warns (`agy-help-unanswered`). **Messages** (LF5, LF17, LF25, LF29, LF36): Talk to
agent and Send reminder (prefilled) are one dialog on the cards and break rows,
`POST /proxy/agency/sessions/:id/messages`, 1 to 500 characters of plain text, sent as
`supervisor_message` to the agent's console or app (a phone declares the `floor_assist` capability)
or refused `409 agent_not_live`; kept 90 days in `agency_supervisor_messages`, one audit row each.
Both sit behind `agency_floor_assist_enabled`, **off by default** (LF11). **Break limits** (LF6,
LF20, LF26, LF27, LF33, LF37): an optional `limit_minutes` per break reason (1–240), edited in
campaign Settings › Agents (now on every campaign), with built-ins Tea 15 and Lunch 30; the floor's
long-break risk uses the reason's limit (30 minutes without one), and the station and the app count
down. **Give late callbacks to free agents** (LF7, LF21, LF30): an assignment operation,
`late_callbacks_to_live_agents`, previewed then committed, moving overdue callbacks whose owner is
away to agents live on the campaign and not on a break, fewest due first; `strict` and `preferred`
only (`409 late_callbacks_pool_mode`). **The account's Callbacks page** (LF22, LF23, LF32):
`GET /proxy/agency/callbacks`, Overdue and Due later today across the account's active campaigns,
keyset pages, the customer's name never the number (`0053_account_callbacks_index.sql`: 38 ms for
the overdue page on 25 campaigns of 40,000 contacts, 3.4 s before it). Phase 4 (Join call, whisper,
LF8) stays Coming soon. Known limits: the campaign Agents tab still flags breaks at the fixed 30
minutes (its stats read carries no limit, LF33); Need help is not on the console's inbound and soft
phone views nor the app's soft phone screens (LF24, LF39; since done by the agent station redesign,
2026-11-20); the Callbacks page's campaign filter
lists the board's first 25 campaigns.

### Staging reports of 2026-11-17: a stuck summary, short recordings, inbound on the soft phone 2026-11-19 (AD1, AD2, TR1)

A tester reported on staging that call summaries stayed on "We're listening to the call and
writing the summary." and that inbound calls never rang on the soft phone. Grafana showed the
summaries' cause: from 2026-11-05 Gemini refused every transcription with HTTP 402
`RESOURCE_EXHAUSTED` ("Your prepayment credits are depleted"), a billing stop the server treats as
a rate limit, so 1,384 jobs waited, requeued without using an attempt. After the credits came back
(2026-11-18 17:07 UTC) the queue drained by 22:00 UTC, leaving 283 jobs failed `AUDIO_TOO_SHORT`
after about 2,700 paid transcriptions of recordings that were cut short. Inbound on the soft phone
is the design (`inbound.md` §4.3, §5.1; soft-phone pickup is P3). Changes:
- **Summary delayed** (AD1, AD2): the call reads carry `analysis_delay: 'vendor_unavailable'`
  beside `pending` while the AI vendor's newest answer is a refusal (the newest refusal of a queued
  job is newer than the newest completion of any job), so the console says "Summary delayed: the
  AI service is not available right now. It will be written automatically when it is back." on the
  attempt and soft-phone call pages and "Delayed" in the soft-phone list. Server-wide by design
  (the vendor keys are). Migrations `0054_analysis_vendor_answers.sql` (`vendor_refused_at`,
  `completed_at`) and `0055_analysis_vendor_answer_indexes.sql` (two partial indexes, one index
  probe each side). No vendor words reach the API; no Dart change (the app does not read it).
- **Short recordings** (TR1): the runner fingerprints each fetched recording (bytes and SHA-256)
  and transcribes identical audio at most twice, within an attempt and across attempts that each
  end `AUDIO_TOO_SHORT` (the count rides in the job's `error_message` tag under that code, so any
  other ending in between, a vendor 5xx or timeout, a re-fetch that throws, a rate limit or a manual
  retry, starts it afresh); new or longer audio is always transcribed. An unchanged cut-short
  recording costs 2 transcriptions per job when every attempt ends short (down from about 9), at
  worst 2 per attempt.
- **Alert text**: `agy-analysis-vendor-refusing` and its runbook cover Gemini's 402 prepaid-credit
  stop (no quota ids) as well as a 429. **Not applied:** the rule is still missing from Grafana
  Cloud (404 on 2026-11-19); it needs `terraform apply` in `grafana/`.
- **Soft phone**: a note under Call, while the inbound flag is on and the soft phone is idle, that
  inbound calls ring only on a campaign station. The agent app's Phone tab has the same gap
  (`softphone.md` §7).
Kept as it was: a refusing vendor is waited for indefinitely without using attempts (on staging
every requeued job completed once the vendor answered). Reviewed by a fresh-context reviewer; its
findings (one short transcript failing a complete recording for good, the delay staying on through
a drain, the scan behind it, a missing `modules.md` entry) are fixed with tests. Mutation-checked,
each red then restored. Not verified: a real Gemini transcription, the real UI in a browser, the
query plan on production-sized data.

### Every package's version in logs 2026-11-19

Each deployable now says which release of every package produced a line (`operations.md` "Where the
running version shows"). The server's bundled packages (`contracts`, `db`, `domain`,
`observability`: its `dependencies`, checked against what esbuild inlined at build time) are OTel
resource attributes, `magick_agency.package.<name>.version`, on every exported log, span and
metric, and the listening line logs them as `packages`. The console and super-admin send
`X-Client: <originator>/<version>` (web-ui's `clientHeaders`), which the server logs as
`clientApp` / `clientVersion` on every line of the request; the console's PostHog events carry
`$app_version`. The report renderer Lambda stamps `version` and its bundled `contracts` on every
CloudWatch line. Not covered: the console's station and listener WebSockets (a browser cannot set
the header), and the packages inside a web build, which the app's release tag gives.

### Agent station redesign, phases 0 to 2 2026-11-20 (AS1–AS18, [`agent-station.md`](agent-station.md))

The agent's working screen redesigned on the console and the app from mock-ups made with agents:
one state per screen, a coloured band, big numbers, picture tiles and one main button; light by
default everywhere (AS14); simple Indian English copy (AS15). Built in nine streams, then reviewed
by five fresh-context reviewers and fixed by four more streams on the same day; the plan, rulings
and per-stream status are in [`agent-station.md`](agent-station.md) §3, the test counts in the PR.

| Part | What |
|---|---|
| Wire | `0056_campaign_station_settings.sql` to `0061_session_event_break_limit_comment.sql`; contracts for my-day, the alerts read, facts, the script, tile icons, the number display and the `queue_pool` capability; the Dart mirror in `agency_wire` |
| Server | `GET /proxy/agency/my-day` (BE-1 to BE-3); daily target (AS6); call-later booker and the ringing call's tag (BE-3, BE-4); pool queue reasons, only to stations that declare `queue_pool` (BE-5, AS18); typed customer facts (BE-6); the script (BE-8); Need help in any state (BE-9, no throttle needed: LF41); `GET /proxy/agency/floor/alerts` for help, break over time and disconnected agents (AS16); station drop and reconnect metrics with the `agy-station-drops-burst` alert (BE-11); break overrun recorded, counted and in the agent report (AS12); tile icons (BE-13); `phone_display` on the bootstrap and on the agent's own call and contact rows (AS9) |
| Console station | Every screen of the spec, wired to the new fields; hold to end call, `E` `E` on a ringing call; the agent's work picker as big tiles; the inbound call, the soft phone (in the station and on `/dialer/phone`) and the join screens in the same look; station words keyed on codes, never a server sentence; the agent nav's "My work"; no ₹ on promised amounts (PT5 stands) |
| Console supervisor | Alerts banner and chime on every page; Live floor says what a help request was raised in, how long an agent has been disconnected, and answers "I'm coming"; campaign Settings for target, number display, script, customer facts and tile pictures; the Collections set in New campaign (AS4); super-admin light by default |
| App station | Every screen of the spec in Flutter, wired to the new fields; slide to end call; read aloud with the phone's own voice, never over a live call (AS13); the inbound call and the soft phone's What happened? in the station's look |

Every suite was green on the final run apart from the audio-decoder tests this build container
cannot run (`inbound-recordings.test.ts`, `inbound-clips-routes.test.ts`, areas the redesign did
not touch). Not built: supervisor inbound screens (the route editor, Missed calls) can still show a
server sentence for an unknown code; BE-3b, BE-7 step 2 and BE-14 to BE-17 (out of scope, AS17).
Not verified: nothing has run on a real phone, a real carrier or with real agents; read aloud has
not run on a device.

### Agent station, the card's chosen facts 2026-11-21 (AS19, [`agent-station.md`](agent-station.md))

Supervisors choose what the customer card shows: in campaign Settings → What agents see, the name,
the line under it and an ordered list of up to 4 facts (`context_display.facts`), each with its own
short name, a script key and an optional highlight; column types gain Number, Phone number and
Yes / No; the script's keys are per campaign, with an editor that offers them and fixes unknown
ones. The station's card shows exactly those facts on the console (a hover card for the full
value) and the app (press and hold), a phone fact follows the campaign's hidden-number setting
everywhere an agent sees it, and the name follows one rule in the domain on every surface. A
campaign not saved under the new model keeps its card and script as before. Built in four streams,
reviewed twice and fixed (rulings R1–R13 and S1–S16, with what was accepted and not built, in
[`agent-station.md`](agent-station.md) §1), then a third round; per-stream status in §3, the test
counts in the PR. Not verified: nothing has run on a real phone or with real agents.

### Agent station, More details 2026-11-24 (AS20, [`agent-station.md`](agent-station.md))

Every other column of the customer's row is shown to agents under the card as More details, on
Call coming and On call, on the console and the app: closed at first, opened four rows at a time
as the agent scrolls down, "Show all" and "Hide". The server sends them on the panel
(`facts.more`, one domain rule), in the file's column order; a supervisor turns columns off for
agents only in Settings → What agents see (`more_hidden`), and a phone-looking value is masked on
a campaign that hides numbers unless the supervisor gives the column a type. The console's station
footer stays at the bottom of the window. Not built: More details on the side views (inbound, the
soft phone). Not verified: nothing has run on a real phone or with real agents.

### Archived campaigns 2026-11-21 (AR1–AR7, [`decisions.md`](decisions.md) "Archived campaigns (AR)")

A supervisor archives a draft or a stopped campaign to take it off the Campaigns page; it is
listed on its own Archived campaigns screen (`/agency/campaigns/archived`) and can be restored.
Archiving is a flag beside the status (`archived_at`, `0063_campaign_archive.sql`), not a status, so reports,
Insights and pacing are unchanged. Built on the server, the contracts and the console the same
day, reviewed by three fresh-context reviewers (server, console, docs and repo rules) and fixed;
the test counts are in the PR.

| Part | What |
|---|---|
| Wire | `0063_campaign_archive.sql` (the three columns and the CHECK that only a draft or stopped campaign is archived); `archived_at` and `archived_by` on the campaign; `AGENCY_CAMPAIGN_ARCHIVABLE_STATUSES`; the archive codes in `errors.ts`, `campaign_archived` also a lifecycle code |
| Server | `POST /proxy/agency/campaigns/:id/archive` and `/unarchive` (`agency.campaigns.write`, the session's user as who archived it, audited); `GET /campaigns` leaves archived campaigns out unless `archived=true`; Start refused on an archived draft, in the route and in `transitionStatus` |
| Console | Archive (with a confirm) and Restore on every campaign screen's header and an archived notice; the Archived campaigns screen; its link under the Campaigns list, its breadcrumb and search entry; pickers keep an archived campaign they already hold, marked |

Not built: archiving a completed campaign (AR2: only what was asked for); the mobile app shows no
archived state (it lists no campaigns, and an agent's staffed archived draft reads as not started).
Not verified: the screens have not been looked at in a browser.

### Compare agents 2026-11-21 (CP1–CP18, [`compare-agents.md`](compare-agents.md))

A tab of Reports (`/agency/compare`) where a supervisor puts up to three agents of one campaign side
by side against the rest of the campaign's agents, on metrics chosen from a lens (Collections, Sales,
Verification) and any set of the campaign's outcome codes, and is told what stands out. Phase 1 is
built on the contracts, the domain, the database, the server and the console, behind the flag
`agency_compare_enabled` (off by default; global, tenant, account), run end to end on a seeded
database, reviewed by fresh-context reviewers and fixed; the test counts are in the PR.

| Part | What |
|---|---|
| Wire | `api/agency/compare.ts` (the metric catalog, lenses, metric ids, the query, options, response and saved views), the compare codes in `errors.ts`, the flag |
| Rules | `packages/domain/src/agent-compare/`: Wilson intervals, the roster's percentiles, metric resolution and values, lenses, findings |
| Database | `0064_compare_views.sql` (saved views), `0065_session_events_offline_index.sql` (a session's offline boundaries, for the trend's days), `0066_session_events_break_overrun_index.sql` (the events that ended a break over its limit, for breaks over their limit) |
| Server | `POST /proxy/agency/compare/query`, `GET /proxy/agency/compare/options`, the saved views' routes; the read in the primary in one read-only snapshot under a 3 s budget, two reads per tenant and a sixth of the pool per process, a 30 s cache; metrics `agency_compare_read_seconds`, `agency_compare_reads_refused_total` |
| Console | The tab: lenses, the metric picker, agent chips, Side by side, What stands out, the trend, Where their day went, The numbers, saved views, the state in the URL |

Not built: phase 2 (the New joiner lens) and phase 4 (analysis questions as metrics, the
`agent_compare` report kind and a weekly subscription to a saved view); phase 5 only if asked
(`compare-agents.md` §9). Turning it on and what to watch: [`operations.md`](operations.md),
"Compare agents".

### Campaign templates 2026-11-22 (CT1–CT23, [`campaign-templates.md`](campaign-templates.md))

Named campaign templates at the organisation and at each account; New campaign starts from the
account's default (else the organisation's, else the built-in settings), section by section, and
each campaign keeps its own copy and a record of where each section came from. A template can be
applied, on purpose, to draft campaigns, and the soft phone's untagged outcomes follow the
account's default when the soft phone sets none of its own. Built on the contracts, the domain, the
database, the server and the console behind `agency_campaign_templates_enabled` (off by default;
global, tenant), reviewed twice and fixed, then given a fresh-context review whose console fixes are
in and whose server fixes are in progress (`campaign-templates.md` §8); the test counts are in the
PR.

| Part | What |
|---|---|
| Wire | `agency/campaign-template-sections.ts` (the section map), `api/agency/campaign-templates.ts`, the template codes in `errors.ts`, the flag, `agency.campaign_templates.manage`, `outcomes_template` on the soft-phone settings |
| Rules | `packages/domain/src/campaign-templates.ts` |
| Database | `0067_campaign_templates.sql` (templates, versions, `agency_campaigns.template_source`) |
| Server | `/proxy/agency/campaign-templates/*` (12 routes), the create's fill-in (CT8), the record (CT9), apply to drafts (CT16), the soft phone following the template (CT11) |
| Console | Settings › Campaign templates (with "New campaigns in this account start from") and Organisation campaign templates, the editor with History and apply, New campaign's Start from, campaign Settings' Started from and Save as template, the soft phone's Follow / Set |

Not built: locked sections (CT12, not in phase 1); a separate outcome category field (CT23 reads
the task's categories as the behaviour flags). Not verified: not yet run in a real browser, against
real Firebase sign-in, or with the agent app's Dart tests (CI's mobile job runs them). Turning it
on, and what it changes beyond the pages: [`operations.md`](operations.md), "Enabling campaign
templates for a tenant".

### Sessions forgotten offline are ended 2026-11-21 (OS9, [`decisions.md`](decisions.md) "One station per agent")

Manas, on Live floor's red "Connection lost" cards whose clocks ran for days: sweep them and call
it an end. A session used to stay open until the agent pressed Leave; closing the laptop wrote it
`offline` and nothing ever ended it.

- **The sweep** (`apps/server/src/agency/idle-session-sweep.ts`, every 5 min in the primary): a
  session `offline` for 2 h, untouched as long, not on Mode B's away-ring, with no station anywhere
  and nothing in flight (OS7's rule) is ended as Leave ends it. `left_at` is when it went offline,
  so the floor says "Not signed in today" for yesterday's, and reports do not move.
- **The console** stops on a re-mint answered `session_ended` (or 404) as on a 4404, "Your work
  was closed", instead of "We are trying again" for ever: the laptop that slept overnight.
- **Review fixes (same day, a fresh-context review of the first commit):** the console's mint
  refusal; the `updated_at` guard against a restart whose `→ offline` events were not written;
  away-ring sessions left to their reconcile; each step after the end on its own; a wiring test
  for the bootstrap; the media-worker and reattach-race limits stated in OS9.

Every new guard was mutation-checked. **Not verified:** not run against a real browser or phone;
the 2 h cutoff is a default (open decisions, below).

### One call log per campaign, P1 2026-11-22 (CL1–CL12, [`call-log.md`](call-log.md))

Manas approved the proposal on 2026-11-22: a call's type and campaign are columns of one list,
built in six phases. P1 is built; P2 to P6 were not when this was written, and have all been built since (the entries below; [`call-log.md`](call-log.md) §2 and §9).

- **The campaign Call log is one list.** Its dialler attempts and the soft-phone calls logged to
  it, newest first, with type chips "All · Dialler · Soft phone" and their counts; columns When,
  Type, Customer, Agent, What happened, Outcome, Talk time, Call. A live campaign opens on today
  (an empty day offers the last seven days and every date); a finished or archived one on every
  date. The Soft-phone calls view is gone: `/manual-calls` redirects to
  `/attempts?type=soft_phone`, its query kept, and its Status filter is the Call log's
  Soft-phone status.
- **Review fixes (same day, an independent review of the first commit):** every Insights and
  Compare agents drill-down lands on the Dialler chip, so its count is the figure clicked (SR1),
  held by the drill-down parity test against the Call log's own count; the opening dates by the
  campaign's state; Show all dates; the Status filter restored; a page boundary across the two
  tables on one `created_at` pinned; the counts not asked for again when only the chip changed;
  the day taken again on Refresh.
- **The route.** `GET /proxy/agency/campaigns/:id/call-log` (`agency.supervise`), over the read
  the export has drained since SR6, with `type` and the chips' counts. No migration. The export,
  its columns and `source` are unchanged.
- **Decisions.** CL1–CL12 recorded, all default, pending Manas; SR6 and IN14 amended in place.

**Not verified:** not run in a real browser. The counts were not timed on a large campaign;
their plan's shape was read on the test database (sequential scans off): for a date window the
dialler's count is a range of `idx_agency_attempts_keyset` (the attempt list's existing
`include_total` count) and the soft phone's a range of `idx_agency_manual_calls_campaign`.

### One call log per campaign, P2: inbound in the log 2026-11-22 (CL13–CL16, [`call-log.md`](call-log.md) §4)

P2 of six is built; P3 to P6 were not when this was written, and have all been built since (below).

- **Inbound calls carry a campaign.** `0069_call_log_inbound_campaign.sql` adds
  `agency_inbound_calls.campaign_id` and `campaign_source` (the arrival files a matched call under
  its contact's campaign; existing matched calls backfilled, unmatched ones left unfiled, CL10)
  and `agency_manual_calls.callback_of_inbound_call_id`; `0070_call_log_inbound_indexes.sql` adds
  their two indexes.
- **The Call log lists them.** A third branch on the same keyset, an inbound call placed by when
  it arrived: ended, served calls filed under the campaign. Chips "All · Dialler · Soft phone ·
  Inbound · To follow up"; To follow up is the campaign's open Missed rows (the Missed list's own
  rule), whatever the dates, with Mark handled and Call back on each row. Every filter has a stated
  meaning on an inbound call or leaves inbound calls out (CL13); What happened gains Missed,
  Voicemail and Abandoned (hung up while waiting). Insights drill-downs still land on the Dialler
  chip; Compare agents' next steps still open every type.
- **A missed call and its call back point at each other.** A soft-phone call placed from a Missed
  row's Call back stays a Soft phone call and carries the missed call's id, kept only when it is
  that account's Missed row from the number dialled (CL15); the console and the app send it. A dial
  the customer's own call stopped reads "Stopped: customer rang us".
- **The inbound Call page** (`/agency/campaigns/:id/calls/inbound/:callId`, `agency.supervise`):
  the caller's path, the outcome or the follow-up, the voicemail, and the recording and summary
  under the account's settings.
- **The export** gains `inbound` rows and three columns at the end (`wait_seconds`,
  `missed_reason`, `callback_of`).

- **Review fixes (same day, an independent review of the two commits):** 0069 can follow a
  pre-deploy backfill on a large table (`ADD COLUMN IF NOT EXISTS`, the types checked, the CHECK
  validated in 0070), with the steps and the repair after a rollback in `DEPLOYMENT.md`; a
  malformed call-back link is dropped at the edge instead of refused; under To follow up the agent
  filter is the assignee, the date fields are switched off and the export's dates tip is hidden;
  every time on the Call log and the inbound Call page reads with AM / PM in capitals.

**Not verified:** not run in a real browser, on a phone or against a carrier. The inbound branch
is planned on 0070's index on the test database; nothing was timed on a large table. Until P3
files unknown callers, a missed call from a number on no roster is in no campaign's log (it is on
Inbound › Missed calls).

### One call log per campaign, P3: every call must belong to a campaign 2026-11-22 (CL17–CL24, [`call-log.md`](call-log.md) §5)

P3 of six is built; P4 to P6 are not (P4 since: below).

- **The setting.** An account admin can switch on **Every call must belong to a campaign**
  (Settings › Calls, `agency.calls.manage`; `0071_call_settings.sql`, its own table). Off by
  default. The server enforces it: a soft-phone dial with no campaign is refused
  (`campaign_required`, agents and supervisors alike), an inbound call's outcome is refused until
  the call is filed under one, an inbound route cannot be saved without a campaign for unknown
  callers, and the switch itself is refused, naming them, while a route has none.
- **Unknown callers are filed.** An inbound route has a **Campaign for unknown callers**
  (`default_campaign_id`). A caller on no list is filed under it when the call arrives, setting or
  no setting, missed calls included; the agent may move it at the end of the call ("Filed under …
  Change"), a supervisor on their behalf. A caller on a list keeps their own campaign.
- **Do Not Call keeps its reach.** A mark from a call that is only filed under a campaign (by the
  route, the agent or a supervisor; a soft-phone call logged to a campaign whose list does not
  hold the number) is written for the whole account (CL6).
- **A catch-all campaign stays usable.** A campaign a live route files unknown callers under may
  be started with nothing to dial and is not completed when its list runs out (CL8); stopping or
  archiving it asks first, naming the inbound numbers (CL21).
- **Nothing old is touched.** No call is given a campaign after the fact (CL10), and a call that
  began before the switch finishes as it is (CL19).
- **The clients.** The console's soft phone and the agent app ask for a campaign before Call and
  no longer offer "none"; an agent on no running campaign is told to ask their supervisor.
  Settings › Soft phone greys what no call uses any more.

**Not verified:** not run in a real browser, on a phone or against a carrier. The agent app's
inbound call screen has no Change (a call arrives filed, so it is not needed for the setting to
hold). The two counts on Settings › Calls are ranges of existing account indexes; neither was
timed on a large account.

### One call log per campaign, P4: reports and Insights by type 2026-11-22 (CL7, CL25–CL30, [`call-log.md`](call-log.md) §6)

P4 of six is built; P5 and P6 are not (P5 since: below).

- **A campaign's inbound calls are in its figures.** Insights' activity serves `calls.inbound`
  (received, answered, missed, the calls still to follow up, talk time, open-hours calls) and
  `/stats` serves `inbound`, counted by the Call log's own rule for an inbound row (filed under
  the campaign, ended, served, by when it arrived). Read live, like the soft phone's; no
  migration and no rollup column (CL25).
- **Calls by type.** The Overview and the Calls tab, and the campaign report's PDF and workbook,
  show Dialler · Soft phone · Inbound · All calls: counts, people reached and talk time add up.
  No rate is added: each type keeps its own (Dialler connect rate, Soft-phone connect rate,
  Answer rate, open hours). A column shows while its flag is on or the window holds such a call
  (inbound's also while calls are still to follow up); with only the dialler, the console's
  pages are what they were and the report gains only three definitions.
- **Outcomes by type**, on the Calls tab and the report.
- **"All calls connect rate" is "Outbound connect rate"** everywhere it showed; the formula is
  the same and an inbound call is in no connect rate (CL7).
- **The dialler's figures did not change:** its connect rate, abandonment, pacing, stalls,
  caller-ID health, carrier failures, best hours, retries, list progress and Trends.
- **The report dataset** stays version 1; the renderer reads a dataset from an older server.

- **Review fixes (same day, an independent review of the four commits):** the workbook's
  Summary keeps the dialler-plus-soft-phone pair as "Outbound calls placed / connected" and names
  the three-type sums "All call types: …", so no old row name changes meaning; the Inbound column
  stays while callers are owed a call back; a talk time an older server did not serve is a dash;
  `no_disposition` reads "No outcome chosen" in the by-type tables; the console draws the
  proposal's bar above the table; the calls still to follow up are read from the account's open
  Missed rows; the parity test's seed holds a wrap-up redial, a never-dialled attempt and calls
  at the window's end. CL30's departure from the proposal's words is stated as an open question.

**Not verified:** not run in a real browser. The PDF was rendered from the renderer's fixture
and looked at (the report stays four pages). The inbound statement's plan was read on the test
database (the window on `idx_agency_inbound_calls_campaign`); nothing was timed on a large
table. `/stats` now runs one more statement per read.

### One call log per campaign, P5: My calls and All calls 2026-11-22 (CL9, CL31–CL38, [`call-log.md`](call-log.md) §7)

P5 of six is built; P6 (inbound calls in customer history) is not (P6 since: below).

- **One read, three scopes.** The campaign Call log's read (`listCallLog`) also serves the
  account and one agent: the same branches, keyset, filters and inbound row rule (CL31).
- **My calls is one list** (console `/dialer/attempts`, the app's My calls tab): the agent's
  dials, soft-phone calls, the inbound calls they answered and their open missed calls, with
  chips, To follow up first. To follow up is their open missed calls, then the callbacks they
  booked that are due today or late ("Due 4:00 PM", "Late by 2 hours"); empty, "Nobody is
  waiting for a call from you." `GET /proxy/agency/my-calls` (`agency.station.connect`).
- **Numbers are masked by the server on My calls.** A number its campaign hides from agents
  (`phone_display: masked`) is never sent on that route, on any type of row, and the rows carry
  no media (CL32). Before this, My calls masked only in the console's browser, on dialler rows.
  The Missed list, the soft phone and the station still receive numbers, as AS9 says.
- **All calls** (`/agency/calls`, `GET /proxy/agency/calls`, `agency.supervise`) took the
  account's Soft-phone calls' place: the Call log's table over the whole account, with a
  Campaign column and a Campaign filter, "No campaign" among its choices. A call filed under
  none that is older than the account's switch-on of the rule reads "Before the rule" (CL35).
  `/agency/softphone` redirects there with the Soft phone chip on. Settings › Calls links its
  count of unfiled calls to them.
- **One index.** `0072_attempts_account_created_index.sql`: an account's dialler attempts by
  when they were created, measured before it was added (CL37). On a table of more than about a
  million attempts, build it `CONCURRENTLY` before the deploy (`DEPLOYMENT.md` 12).
- **Old URLs.** `?view=softphone` on My calls opens the Soft phone chip; `/dialer/missed` and
  its badge are unchanged.
- **The app.** The three segments are chips over one list of cards; the attempts list, the
  soft-phone calls list, their filters and detail sheets were removed (CL38). An older build
  keeps its segments on the old routes, which are still served, and still shows numbers in full.

- **After review, the same day.** The `/agency/calls` route was not declared in `App.tsx`, so
  every link to All calls opened "Page not found"; it is declared, and a test now checks every
  path the shell offers against the routes `App.tsx` declares. To follow up's callbacks follow
  the Campaign filter. My calls shows a number only where the campaign says exactly `full`, and
  masks an inbound call filed under no campaign by its matched contact's campaign. Call back
  reads its Missed row by id (`GET /proxy/agency/inbound/missed/:id`), not from the list's first
  100 rows. To follow up's badge follows the live Missed count. The console no longer reads
  `my-attempts`, which sends numbers in full.

**Not verified:** not run in a real browser or on a phone. The account read was timed on a
throwaway copy of the test database (2.2 million attempts, 200,000 soft-phone calls, 300,000
inbound calls), not on production data. Left as they were: the Missed list still sends numbers
in full to the agent a row is assigned to; My calls has no filter by outcome or by number, and
its soft-phone rows no longer show "DNC override" and "Hours override"; the app has no page for
one soft-phone call; All calls has no export, stats strip or Summary column ([`call-log.md`](call-log.md) §7 "What P5
left as it was").

### One call log per campaign, P6: inbound calls in customer history 2026-11-22 (CL39–CL42, [`call-log.md`](call-log.md) §8)

P6 of six is built: the work the proposal named is done. What waits for Manas, and what was
left out, is [`call-log.md`](call-log.md) §9.

- **A number's history holds the calls it made to us.** Customer history's timeline gains
  `inbound_call` entries: every call from the number, in the accounts the reader can see, that
  ended and that we served, **filed under a campaign or under none** (CL39). A rejected call, a
  withheld number and a call with no account are never rows; a live call is under Open now.
  Inbound's own flag hides nothing. The number is found however it is typed.
- **The row is the Call log's inbound row**, by the same SQL and the same words: answered or
  missed and why, the wait, who answered or who it is assigned to, the voicemail's length, To
  follow up, "Called back 3:31 PM", the number rung. Console and app.
- **Counted apart.** "Calls received 3 · 2 answered" beside Calls placed and Connected; the last
  contact is still the last call we placed (CL40). The Channel filter and the app's chips offer
  inbound calls; a callback booked on an inbound call is a callback entry; the export has a line
  per inbound call.
- **Who sees what did not widen** (CL42). Still `agency.customer_history.read` with the search's
  audit, whose count now includes the inbound entries. Notes go to `agency.campaigns.read` or
  the agent who answered; the Call page to `agency.supervise`, and only for a call filed under
  a campaign; no recording or voicemail link is sent to anyone.
- **One index.** `0073_inbound_calls_from_index.sql`: an account's inbound calls by caller,
  measured before it was added (CL41). On a table of more than about a million inbound calls,
  build it `CONCURRENTLY` before the deploy (`DEPLOYMENT.md` 12).
- **Still open for Manas:** CL30's question (a dial stopped because the customer rang us is two
  calls in the Calls row of Calls by type), and every CL ruling, each a default he has not
  ruled on. **Not built:** filing old calls with no campaign by hand, and "Customers reached".

**Not verified:** not run in a real browser or on a phone. The lookup was timed on a throwaway
copy of the test database (2 million inbound calls in 10 accounts), not on production data.
Left as they were: the last contact is the newest call we placed; the history has no Call back
or Mark handled, and no Missed, Voicemail or Abandoned in its outcome filter; an older app build
shows an inbound entry as one it cannot show yet ([`call-log.md`](call-log.md) §8 "What P6 left
as it was").

### Abandonment on 23 Nov: the 3 s grace, the Resume warning, answer-to-audio 2026-11-24 (AG1, AW1–AW3)

On 23 Nov two staging campaigns read about 10% abandoned and the guardrail paused them over and over.
Nine of the eleven abandoned calls were calls an agent took and talked through: VoiceLink's audio
stream connected 1.06–1.25 s (or about 5 s) after its answer event, outside the 1 s grace. Supervisors
pressed Resume 87 times, each paused again within a minute.

- **The grace is 3 s (AG1, decided by Manas).** `ABANDONMENT_BRIDGE_GRACE_MS` 1000 → 3000 (now `DEFAULT_ABANDONMENT_GRACE_MS`). Every
  figure read from the attempts changes with the deploy, history included; 0074 rebuilds the
  Insights rollup (`DEPLOYMENT.md` 12, "Deploying or going back past the 3 s abandonment grace").
- **The grace is a campaign setting (AG1 "configurable, but default to 3"; AG2–AG5 pending Manas).**
  Whole seconds 1–5 beside the abandonment limit in New campaign and Settings, 3 by default. Each
  attempt is stamped with its campaign's grace when it is created (`bridge_grace_ms`, 0075/0076) and
  judged by it, so a change applies to new calls only; retries inherit it, templates carry it in
  `safety`; the dashboard panel draws the default and says a campaign set otherwise is judged by its own.
- **Resume warns first (AW1–AW3, decided: defaults kept, Manas, 2026-11-24).** A campaign the guardrail paused, or any
  paused campaign whose rolling 24 h rate is over its ceiling, asks before Resume, with the numbers
  and that the dialler will pause it again within about a minute. Never a block; `/resume` is
  unchanged. The campaign header says why the guardrail paused it.
- **Answer → audio connected is measured.** `agency_answer_to_bridge_seconds` (by carrier) and its
  dashboard panel under Late Bind, with the 3 s line and the share past it.
- **The dashboard counts every abandoned call.** Plain `rate()` dropped each new series' first
  increment (7 of 11 shown on 23 Nov); Throughput and Abandonment Causes now add it, and
  `pnpm test:grafana` holds them to it. Grafana Cloud's created-timestamp zero ingestion would fix it
  for every query; it is off on the stack and only their support can turn it on.
- **Open:** station drops on a hidden Chrome tab (the 10 s heartbeat timer is throttled to once a
  minute after 5 minutes hidden, the 30 s grace closes the socket every 2 minutes), and a ringing
  dial ended as `agent_disconnected` on a tab that was still there (the pre-bind grace is not
  cleared by a late ping). Researched, not built: clear the grace on any ping, then have the server
  ask the console for its ping.

**Not verified:** the warning has not been seen in a real browser; the new panel has no live data
until the server is deployed.

## Not built

**Live floor** (LF8, open): Phase 4, Join call and whisper (reopens "listen only"), a Coming soon
control on the cards. Phase 3's follow-up: break limits on the campaign Agents tab (LF33). (Need
help on the inbound and soft-phone screens of both clients, LF24 and LF39, is done by the agent
station redesign.)

**Launch work** (phase 10):

- Importing existing tenants and their data from the previous platform: gate queries (no running
  campaigns, no live attempts, sessions left, wrap-ups closed, DNC changes drained) and copy
  scripts that keep ids, so users sign in unchanged.
- The rollback-window DNC mirror back to the previous platform. Only the `agency_dnc_outbox` table
  exists; nothing writes it.
- The link from the previous platform's UI to Magick Agency.
- Applying agency's alert rules and dashboard (`grafana/`, B6) to Grafana Cloud: written and
  validated, never applied. The first `terraform apply` is in `grafana/README.md`.

**Deployment pieces:**

- **Several processes on one host are built but have not run on a real host** behind nginx and the
  TLS terminator; whether VoiceLink ends a call when its media socket drops is unverified (it has
  no hangup endpoint). See "Several processes on one host 2026-11-02" above.
- **OpenTelemetry export is built but has not run against Grafana Cloud.** The SDK
  (`apps/server/src/instrumentation.ts`) pushes traces, metrics and logs over OTLP when
  `OTEL_ENABLED=true`, `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_SERVICE_NAME` are set; it was
  checked end to end against a local OTLP collector only.

**Reports, not yet run for real:** the SQS renderer and its Lambda have not run on AWS (the
Chromium layer, S3 lifecycle and the signed callback over the internet are tested only with
mocks and the in-process renderer); see "Reports 2026-11-08" above.

**Inbound calls** ([`inbound.md`](inbound.md) §12): P1 and P2 are built (answering, following up,
and connecting callers to agents on console stations), reviewed, and the fix pass is done (two
rounds, IQ25–IQ45); P3's mobile app frames are built and reviewed (2026-11-10, IQ46, IQ47: callers
put through to a phone whose station declares `caps=inbound`, the app's station and its Missed
calls; not yet run on a phone or a carrier). Remaining:

- **P0**, the live Plivo checks, with a Plivo account: until then the Application, number, Record
  API, hangup and answer-URL shapes (and the 4 s answer budget against Plivo's timeout) are the
  mock carrier's.
- **P3, the rest**: pickups from a catalog break and from an idle soft phone (the Take call
  prompt, IB1), the media-worker handover (IB8, after P0), "press 1 for a callback" if P0 shows
  DTMF works over the stream, the analysis of voicemails (IQ14); inbound in Insights, agent reports
  and customer history.
- **Mode B** (ringing an away agent's phone, 2026-11-12, above): built on the server and Android,
  not compiled under Gradle, not run on a phone, FCM or APNs; the Play Console full-screen-intent
  declaration; iOS (PushKit and CallKit, `mobile.md` "iOS: the design (Mode B)") after its first
  compile, with an Apple account and an APNs key.
- **P4**: VoiceLink inbound.
- **Sign-offs**: listening to the seven standard recordings in a call, and their licence (CC BY-SA
  4.0); the voicemail and spine retention for a UK pilot (`AGENCY_RETENTION_DAYS`, deletion on
  request) ([`decisions.md`](decisions.md) §5).
- **Follow-ups not built**: bulk Mark handled; grouping repeat callers on the Missed list; CSV
  export and a per-route split of the inbound summary; service level (answered within 20 s); a
  same-day "Closed now" override and holidays a supervisor can edit; bulk number link in
  super-admin; "Close and put on break" on the floor; a "Save outcome on behalf" screen (the API
  exists); keeping a pending contact's original due time after a reach (the reached call settles
  its booked inbound callback); a console surface for tenant-default Missed rows (super-admins see
  them per number).

**Sessions forgotten offline** (OS9, above): a session left in a working state with no station (a
join whose station never attached, a failed `offline` mirror write) is not `offline`, so the sweep
does not end it; it shows "Connection lost" until the next restart's `markAllOffline`.

**One station per agent** (OS1–OS8, above): `uq_agency_agent_live_tenant` stays beside
`uq_agency_agent_live_agent` only so an image-only rollback still joins (OS8). Once no deployable
image names it as its arbiter, a new migration drops it, and the same change deletes the upsert's
23505 catch on that index (`upsertLiveSession` in
`apps/server/src/db/repositories/agency/agent-session.repository.ts`).

**Live call listening** ([`listening.md`](listening.md) §10): built end to end behind the flag
`agency_live_listen_enabled` (off by default): the bridge tap, the registry, token store, socket,
routes, revocation and reaps, the console's Live calls and listening bar, the agent's standing
line, the inbound notice's words and the load check, with the review fixes; the listening
history and the consent gate's guard rails (LS19, LS20), server and console; the final review's
fixes (2026-11-17). Every LS ruling is decided (the build's calls ratified by Manas on
2026-11-17). The agent's live "Supervisor listening" indicator is not built (LS2). Not yet run in
a real browser, against a real carrier, on a phone or with the alerts applied (`listening.md` §10
"Not yet verified").

**Out of scope:** metering and billing; AI calling; bring-your-own SIP and carriers other than VoiceLink and Plivo (B18); a
separate identity layer.

## Open decisions and owners

The full list is [`decisions.md`](decisions.md), §5. In short, all with Manas:

| Item | What is needed |
|---|---|
| `supervisor_hold` | Declared, never produced. Keep, remove or build |
| Shutdown grace | Ratify `stop_grace_period: 45s`, now in `docker/docker-compose.prod.yml` (the completion-email drain is 30 s; Docker's default grace is 10 s), and the new wait for in-flight pacing ticks (5 s bound) |
| Tidy-up defaults | Ratify the **default, pending Manas** rows of the 2026-10-16/17 rulings, including the `en-IN` display locale and the rounding rule |
| Rate floors | Campaign rates withheld under 25 dials, agent rates under 20: one number or two? |
| Launch defaults | Ratify: re-issue invites; inbound calls play a message and hang up (superseded for Plivo numbers linked to inbound by IB1–IB8, `inbound.md`: P1, P2 and P3's mobile app frames built, answering, following up and connecting callers to console stations and to phones that declare `caps=inbound`); abandon clip upload-only; no API keys; super-admins created fresh |
| Launch open items | Existing numbers; launch style; domain, feature freeze, rollback window |
| Q3 contract choices | Ratify the five |
| B15 roster supersede | Build it, or leave replace and clear refused; when built, it also clears the owner of every contact it retires (CA11, "Contact assignment" above) |
| Scaling defaults (2026-11-02/03) | Ratify the **default, pending Manas** rows of the scaling rulings (`decisions.md` §4): frame bound, back-pressure, VoiceLink timeouts and the 15 min deferred redial (now charged to the our-fault ledger, so its bound retires a contact), a dial failed before the carrier (uncharged, redial after 60 s), Redis timeouts, ceilings and rate limits, analysis slots, pacing skips, the console's A-law default; and D13 (the `/readyz?detail=1` token, the 1 s readiness cache, the 5 s loop window) |
| Gated items | Vendor setup; Playwright happy path; parity check; dark pilot; real VoiceLink call and recording; a real Plivo call and recording (Plivo step 5, above; needs a Plivo account); launch |
| Load-suite defects | The 12 open defects pinned by `it.fails` ("Load and scenario suites 2026-10-23"): decide each fix; size `RATE_LIMIT_MAX` for a floor behind one NAT |
| Mobile app | Ratify the Q9 amendment (per-user and bearer IP rate-limit buckets). A cellular call while available now pauses the agent (IQ51): test it on Android and iOS devices. First iOS build on a Mac; a device test on Android and iOS against a VoiceLink sandbox (include a failed `startForeground` on Android 14+, and the App Link hosts once the domain is decided), the soft phone included (ringback and Mute ring, the owed outcome's hold, M1 mid-call, SP7 on a phone, iOS CallKit for soft-phone calls), and an inbound call on a phone (the offer and its chime, the call and the outcome, a reconnect mid-call, CallKit on iOS) with a Missed calls Call back; store accounts and signing |
| Idle sessions (OS9) | Ratify the 2 h cutoff for ending a session forgotten offline, and whether a session stuck in a working state with no station (not `offline`) should be ended too |
| Metric export | Grafana Cloud's OTLP gateway is the assumed destination; confirm it and issue the token |
| Duplicate column | Ratify the key rules and the one-live-call guard; decide whether the soft phone should refuse a number whose contact is `connected`. The combined key's rules and its phone-only default were ruled 2026-11-11 (`decisions.md` §4); "DNC row claims its key" was ruled then too, and IM4 (below) now proposes the opposite (a row refused for Do Not Call claims no key) |
| Contact assignment | Ratify CA2–CA10 and CA13–CA15 (`decisions.md` §4), in particular CA5: in `strict` mode a callback whose owner stays away falls back to an unassigned contact nobody dials until a supervisor assigns it; and decide when to turn on `agency_contact_assignment_enabled` |
| Wrap-up redial | Ratify the **default, pending Manas** rows WR1, WR3, WR4, WR7–WR13 (`decisions.md` §4), including the ask's open question: redials do not spend `max_attempts` (WR3) |
| Abandonment ceiling | Ratify AC1–AC3 (`decisions.md` §4): the console offers 0.5–10%; above 3% it warns but no extra role is needed |
| Abandonment follow-ups (2026-11-24) | Ask Grafana Cloud support to turn on created-timestamp zero ingestion (Manas agreed). Decide the hidden-tab heartbeat fix ("Abandonment on 23 Nov" above) |
| Several running campaigns | Ratify MC1–MC7 (`decisions.md` §4): equal fair share, fewest live calls first, decided in the pacing round; the busy-number check widened to the account, the soft phone's tagged dials included. Weights and a per-campaign cap were left for later. Decide MC3's two-process overlap (live attempt rows above the limit while two processes lead campaigns of one account, the concurrency guard refusing the excess calls): an account-level lease or a Redis slot reservation, or accept it |
| Customer history | Ratify CH6–CH11, CH12 b–d and CH13 (`decisions.md` §4), in particular the 30-a-minute cap, the 30-minute search id, the audit coverage (refusals and timeline pages are not audited) and the export being the console's only. Decide CH12 a, whether DNC removals must appear in a number's history (they would need the number kept on removal, today deliberately not recorded), and CH12 e, whether the roster ingest should drop a bracketed trunk `(0)` as the soft phone and the search do (it changes what existing rosters dedupe on). CH12 b (the upload file inferred from the import window) and CH12 c (no row is ever "Removed from roster" until B15's supersede) are what the schema allows today |
| Account creation | Ratify AA1–AA3, AA5, AA6 (`decisions.md` §4): tenant admins need a tenant-wide seat to create accounts; names unique in the tenant ignoring case; creates in one tenant serialised; accounts listed oldest first; no rename or delete yet. AA4 is decided: a tenant admin's new account has zero call capacity until a super admin sets it |
| Inbound calls | The persona review's product rulings are decided and built (IQ48–IQ57, above); at the pilot's start raise `MOBILE_MIN_SUPPORTED_VERSION` to the first release that declares `caps=inbound` (IQ56); in-app voicemail playback after the pilot (IQ53). Engineering follow-ups: split the inbound call slot out of the station controller and merge the campaign `NotesAutosave` into `CallAutosave`; the `agent_audio` Kotlin tests now run in CI (`mobile.yml`, after the Android build). A Plivo account for P0. Ratify the fix pass's defaults IQ25–IQ45 (`decisions.md` §4, "Inbound fix pass"): the 15 s rejoin grace, the 120 s unmatched wrap-up, the busy words for withheld and DNC callers, the kill switch's closed message, the upload limits, the alert thresholds. Sign off the standard recordings (listening and licence); decide the voicemail and spine retention for a UK pilot |
| Mode B (ringing an away phone) | Ratify the rest of Mode B (`decisions.md` §4, "Mode B"; IQ59, IQ62, IQ63, IQ65, IQ67, IQ73 decided 2026-11-13, IQ74 for now): IQ58, IQ60, IQ61, IQ64, IQ66, IQ68–IQ72 (incl. the token-only answer and decline), N1–N5, the second review round's IQ75 (a push failure is the device's or the service's; only the service's pauses ringing), IQ76 (one absence, one `since`; every `ring_off` names its absence) and IQ77 (the token-only ring routes limited per IP and ringing call), IQ78 (one ring rule: an agent at the maximum misses refused `away_ring` with `ring_not_allowed` until they go available, and ended `ring_missed` by the reconcile), the app's IQ79 ("Stop ringing" stops ringing for this absence through `device_away`, never an opt-out), IQ80 (a late `ring_off` dropped), IQ81 (the return banner only on a concrete reason; its 4 h must track `AGENCY_AWAY_RING_MAX_MS`), IQ82 (a 429 on the token-only ring routes retried once, natively) and IQ83 (`device_away` during a ring not yet answered declines it; an attach without `caps=inbound` during a ring ends the absence as `device_away`), and OS7 treating an `away_ring` session as idle; revisit IQ74 (away time as break in reports). A field test on Android phones (a locked phone, a headset or car answer, Android 14/15, battery killers, a force-stop), the FCM service account, the Play Console full-screen-intent declaration; iOS after its first compile (Apple account, APNs key) |
| Plivo on tenants' own accounts | Ratify PL1–PL16 (`decisions.md` §4, "Plivo on tenants' own accounts"): a 403 on dial read as a geo-permission refusal; the three automatic pauses (`carrier_auth`, `carrier_account_unavailable`, and `carrier_refusing_calls` after five refusals in a row, PL11); a carrier with no webhook base not offered or started (PL12); numbers of a credential that cannot dial not offered; synced numbers tenant-wide; recordings from `media.plivo.com` only; the calls-per-second default of 2 per account; the carrier choice shown only with more than one carrier account |
| Navigation labels (2026-11-15) | Ratify NV1, NV2 (`decisions.md`, "Rulings of 2026-11-15: navigation labels"): section names read as labels, not tabs; the campaign bar's labels sit above their groups and stay on a phone (amends IN14) |
| Recording (2026-11-15) | RC2 and RC5 are decided (a recording the call did not ask for is discarded on every carrier, and the retention purge clears the old links). Ratify RC3 (the recording proxy's 20 s covers the carrier only, not our own credential lookup) and RC4 (`PLIVO_RECORDING_REDIRECT_HOSTS`) |
| Do Not Call scope (2026-11-15) | Ratify DS1–DS8, in particular DS3 (an account-scoped admin's station mark is never tenant-wide) and DS8 (a suppress outcome lists the number for its campaign, audited, the campaign's roster swept). Decide DS6's open question: should an account admin see every-campaign entries, and should their add over a tenant-wide entry be written anyway, so it outlives that entry's removal? |
| Soft-phone results (2026-11-15) | Ratify SR1–SR3 and SR5–SR8: tagged soft-phone calls beside the dialler's figures, never in its connect rate; "Dialler connect rate" and "All calls" in the console and the campaign report; the export's `source` column; the workbook's Summary rows appear only when there were soft-phone calls (a parser keyed on "Connect rate" then reads "Dialler connect rate") |
| Contact import (2026-11-15) | Ratify IM1–IM7: check before import (24 h), a failed or stopped import lets its check go ("Import again"), skipped rows, the formula guard on the downloads (`+91…` gains a leading `'`, read back on re-import), one live import per campaign. Decide how long uploads are kept (IM2) |
| Promise to pay (2026-11-15) | PT2's split and PT4's 30 days are decided. Ratify the rest of PT1–PT14, and decide: the follow-up's 1–14 day range and Insights' counting (PT2), a currency setting (PT5), and PT13's refusal of a promise on a soft-phone call with no claimed contact (or record it without a follow-up) |
| Live floor (2026-11-18) | Decide LF2 (a currency for Will pay), LF3 (customer names on the agent cards) and LF8 (Join call, whisper); ratify LF1, LF9 and LF10, and Phase 3's defaults LF11–LF38 (LF21: no late callbacks to an agent on a break; LF27: Agents on every campaign's Settings); LF39 open. LF4–LF7 (Phase 3) decided 2026-11-19 and built (`decisions.md`, "Live floor (LF)") |
| Archived campaigns (2026-11-21) | Ratify AR1–AR7: a flag beside the status; draft and stopped only, not completed; archived campaigns out of every list, picker and search (a picker keeps one it holds); `agency.campaigns.write`; only Start refused on an archived campaign, the console offering no new work on it |
| Staging reports (2026-11-19) | Ratify AD1–AD2 (a summary reads "delayed" server-wide while the AI vendor's newest answer is a refusal) and TR1 (identical audio transcribed at most twice across attempts that end short, at worst 2 per attempt); run `terraform apply` in `grafana/` so `agy-analysis-vendor-refusing` exists; decide P3 soft-phone pickup, and a note on the agent app's Phone tab meanwhile |

## Deployment invariants

Properties the running system needs that the code cannot enforce on its own. Config details are
in [`operations.md`](operations.md).

1. **Redis keeps keys for their TTL.** Persistence on (AOF or RDB) and `maxmemory-policy
   noeviction` (or a `volatile-*` policy with nothing else competing). Call tokens are verified
   against Redis; a token lost early is refused, which cuts a live call's carrier leg (Q6).
2. **One host, one server container.** With media or analysis workers it is a primary and
   its forked children ([`scaling.md`](scaling.md)). The primary alone runs the reaper and the
   leader-only sweeps, and a Q6 token is minted and verified in the same worker. A second
   container would break both.
3. **Exactly `TRUST_PROXY_HOPS` proxies in front.** The server must not be reachable except
   through them, or `X-Forwarded-For` spoofing defeats the IP rate limits (Q9).
4. **Postgres TLS** is on only when `NODE_ENV=production`, and then the certificate is verified
   unless `DB_SSL_REJECT_UNAUTHORIZED=false` (Q1).
5. **Migrations run before the server starts.** The image's entrypoint does this on every start
   (`dist/migrate.js`, with the server's TLS settings); outside the image, `pnpm migrate:up`.
6. **Production requires** `FIREBASE_PROJECT_ID` (boot refuses without it) and the VoiceLink
   fields (config refuses without them).
7. **Stop grace at least 45 s**, or the shutdown's 30 s completion-mail drain is cut
   (`docker/docker-compose.prod.yml` sets it).
8. **`MEDIA_WORKERS=0` while any credential has inbound enabled** (IB8, IQ38). With media
   workers on, inbound callers are answered but nobody is put through to an agent; the server
   warns at boot and `agy-inbound-connect-unavailable` pages (`operations.md`, "Deployment
   invariants" 8).

The production image and compose file (`docker/`, see [`operations.md`](operations.md)
"Production packaging") write invariants 1–5 and 7 into their headers and enforce what they can:
the server publishes no port, Redis runs with AOF and `noeviction`, the image is
`NODE_ENV=production` and migrates on start, the grace is 45 s.

### Tenant/account-scoped console URLs 2026-11-05 (B26)

Console links did not name a tenant or account, so a link sent to a colleague opened whichever
account their browser last had open. Every signed-in console page is now served under
`/t/:tenantId/a/:accountId/…` ([`decisions.md`](decisions.md) B26).

- The prefix is the router's basename (`components/routing/ScopedRouter`, over the history
  `contexts/UrlScopeContext` owns), so no route, link or `navigate()` changed. `TenantContext`
  derives the active account from the URL whenever it names a listed account; `localStorage` is only
  the fallback. A tenant or account switch reloads the console at the new account's home (2026-11-06,
  below).
  `components/routing/ScopeGate` re-points an unscoped URL (an old `/dialer` bookmark) at the
  active account and refuses a link to a tenant or account the viewer cannot open ("You can’t
  open this organisation / account", with Go to my organisation and Sign out). Sign-in, invite and
  verification pages stay unscoped; a signed-out visitor keeps the scope through `?next=`.
- PostHog receives the prefix as `/t/:tenant/a/:account`, in paths, URLs, autocapture hrefs and
  the sign-in page's encoded `next`. The campaign-completion email links under the campaign's own
  scope (unscoped when its account does not resolve).
- A fresh-context review found four defects, all fixed and pinned by tests that fail on the
  pre-fix code: an account switch followed by `navigate()` in one handler (the soft phone's
  "Go to station" for a sibling account) hung on a spinner; Try again on a narrowed account list
  never opened the linked account; Retry after an outage opened the first account instead of the
  linked one; a cold load of a scoped sign-in URL rendered a blank page. Back/forward between
  accounts no longer remounts the page. `appRouteTable.test.ts` pins every signed-in route inside
  the gate.
- 2026-11-06: a tenant or account switch no longer keeps the page the user was on (a record page
  carried into an account it does not belong to showed its not-found state). Inside the app it is a
  full page load: an account switch at `/t/<tenant>/a/<account>`, a tenant switch at the new
  tenant's first account (`utils/pageLoad.ts`; refined in review, next bullet). The soft
  phone's two cross-account moves name their destination (the station, the soft phone); the invite
  claim, on an unscoped page, still only records the tenant it joined. The duplicate decision ID is
  gone: the invite-claims ruling keeps B25 and the API-on-its-own-host decision is B27.
- 2026-11-06, review of [sapieonic/magick-agency#48](https://github.com/sapieonic/magick-agency/pull/48),
  each fix pinned by a test that fails on the code before it:
  - Retry no longer re-points a refused link at the first account. It re-points only a URL
    whose account was open and has since gone, and lands at the replacement's home, not on the old record's page.
  - A link to a tenant or account the viewer cannot open falls back to the organisation this
    browser last had, not the session's first tenant, and is never saved. "Go to my organisation" is a full load of `/`.
  - A tenant switch resolves the new tenant's accounts first and loads its scope directly. It
    no longer writes `localStorage` before the browser commits the load, so cancelling the station's leave-page prompt changes nothing.
    A tenant with no account to open is switched to in place, at `/`.
  - The tenant adoption re-runs when the session's tenants change, so `ScopeGate`'s wait for
    it ends.
  - `TenantProvider` requires `UrlScopeProvider`, so no test drives a switch path production
    never takes.
  - The scope and location contexts are split, so a navigation re-renders only the router.
  - The URL prefix's shape moved to `packages/contracts` (`console-urls`) for the console and
    the server's email link alike.
  - PostHog redaction skips its scope passes for strings with no `/t/` or `%2Ft%2F`.
- **Left open:** signing out and in as a different user keeps the first user's scoped `next`, which the second user may
  be refused (the refusal offers a way out). The history comes from react-router's
  `UNSAFE_createBrowserHistory`; the routing tests exercise it, so an upgrade that breaks it goes red.
- Counts, 2026-11-06, after the review fixes:
  - `apps/console`: 5383 (282 files), lint clean, build clean. (5375 after reload-on-switch and a
    simplify pass; 5371, 281 files, on 2026-11-05.)
  - `packages/contracts`: 299 (10 files).
  - `apps/server`: lint clean; unit 8163 passed + 42 skipped (407 files).
  - Server integration as CI runs it:
    - `INTEGRATION_LANE=rest`: 1978 passed + 9 expected fail + 1 skipped (203 files + 1 skipped).
    - `INTEGRATION_LANE=wall-clock`: 15 (3 files).
  - Postgres 16 and Redis ran locally on 5436 and 6383. The test database must be UTF-8:
    on `SQL_ASCII`, `softphone-policy-routes.test.ts`'s emoji note fails the length check.
  - The Dart tests were not run (no Dart SDK here). The contract change adds a helper, not a wire
    type or literal, and `contracts-literals --check` is unchanged.

### Pre-deploy checklist

- [ ] A release with `0039_retention_purge_indexes`: on a database where `agency_calls` holds more
      than about a million rows, its two indexes built `CONCURRENTLY` first and checked valid
      ([`db-hygiene.md`](../db-hygiene.md) §2).
- [ ] A release with `0041_promise_to_pay`: 0041 is catalogue changes only (ACCESS EXCLUSIVE, no
      scan), `0044_promise_checks_validate` validates its CHECKs under SHARE UPDATE EXCLUSIVE, and
      `0045_promise_contacts_index` builds `idx_agency_contacts_promise` in its own transaction
      under SHARE: one read of `agency_contacts`, writing an empty index (every promise is new).
      Nothing to build beforehand: the column does not exist before 0041. Through the CLI, pass
      `--no-single-transaction` so each file commits on its own, as the image's runner does.
- [ ] A release with `0046_unrequested_recordings_index`: on a database where `agency_calls` holds
      more than about a million rows, build `idx_agency_calls_recording_unrequested` `CONCURRENTLY`
      first and check it valid ([`db-hygiene.md`](../db-hygiene.md) §2), as for 0039.

- [ ] `docker/.env` filled in from `docker/.env.example`, including the console's
      `VITE_FIREBASE_*` build values; values containing `$` or ` #` single-quoted.
- [ ] Redis: persistence on, `noeviction` (the compose file's `redis` does both; an external Redis
      must too). Its volume is backed up or at least survives a host restart.
- [ ] One server container only: never scale `server`. For more calls, set `MEDIA_WORKERS`
      (and `ANALYSIS_WORKERS`) on a host with the cores for them ([`scaling.md`](scaling.md)
      §8.1). The heap per media worker is `MEDIA_WORKER_HEAP_MB`; the primary keeps the
      entrypoint's 4 GB. Size the host's RAM for the sum.
- [ ] TLS terminator in front of nginx :8080; `TRUST_PROXY_HOPS=2` (terminator + nginx; one more
      per extra proxy in front); :8080 reachable only from the terminator (loopback by default);
      port 3021 not reachable at all (the compose file publishes none).
- [ ] Super-admin :8081: loopback by default (SSH or Session Manager tunnel, or a VPN). If it is
      published through the TLS terminator, on its own domain, IP-allow-listed where possible, and
      with strong passwords on every admin (`DEPLOYMENT.md` 8.4 lists the costs).
- [ ] Host memory: the server may grow to a 4 GB heap (`docker/entrypoint.sh`). On a 4 GB VM (the
      `aws/terraform` default) that is all of the RAM; lower the heap or size up before load.
- [ ] Postgres allows the pool: `DB_POOL_MAX` is 30 by default; lower it on a managed database
      with a small connection limit, and leave room for migrations and admin sessions.
- [ ] `NODE_ENV=production` (the image sets it); `DATABASE_URL` without TLS parameters; `DB_SSL_CA`
      if the database uses a private CA.
- [ ] First boot logs `migrations complete` before `magick-agency v<version> listening` (the entrypoint runs
      them; a failure stops the container).
- [ ] Firebase: agency's domain in the authorised domains, `FIREBASE_PROJECT_ID` set (no service
      account: tokens are verified against Google's public keys).
- [ ] API on its own host only (B27, `DEPLOYMENT.md` 7.3): `web` built with `CONSOLE_API_BASE_URL`,
      every origin the console is served from in `CORS_ALLOWED_ORIGINS`, the preflight `curl` in 7.3
      names the app's origin, and the mobile app's link host is the console's name.
- [ ] VoiceLink: account, numbers in the super-admin inventory, `VOICELINK_*` set,
      `VOICELINK_WEBHOOK_BASE_URL` reachable by the carrier.
- [ ] Plivo (only if a tenant dials on its own Plivo account): `TELEPHONY_CREDENTIAL_KEYS` and
      `TELEPHONY_CREDENTIAL_ACTIVE_KEY` set and backed up apart from the database;
      `PLIVO_WEBHOOK_BASE_URL` the public https origin plus `/api/v1/webhooks/plivo`
      (`operations.md`, "Enabling Plivo for a tenant").
- [ ] Inbound calls (only if a credential will have inbound enabled): `MEDIA_WORKERS=0` for as long as
      any credential has inbound enabled, and `PLIVO_INBOUND_FALLBACK_ANSWER_URL` set to the fallback
      XML hosted off this deployment (`DEPLOYMENT.md` 8.6); the Grafana inbound rules applied.
- [ ] `SUPER_ADMIN_JWT_SECRET` set; first super-admin created with `node dist/create-super-admin.js`
      inside the server container (`operations.md` "First super-admin").
- [ ] Mailjet sender verified (SPF/DKIM); `MAILJET_*` and `CONSOLE_BASE_URL` set.
- [ ] Terraform state bucket made (`aws/state`) and any local state moved into it
      (`aws/README.md`, "State").
- [ ] S3 bucket and keys (`S3_AUDIO_BUCKET`, `AWS_*`) for clips and CSV uploads, applied per
      environment from `aws/terraform` (`aws/README.md`). The same module can create the VM, its
      security group and Elastic IP (`create_server`).
- [ ] Analysis: `DIALER_ANALYSIS_ENABLED`, transcriber and LLM keys, `RECORDING_URL_SIGNING_SECRET`.
- [ ] Container stop grace at least 45 s (`stop_grace_period: 45s` in the compose file; set it
      too on any other runtime).
- [ ] A decision on metric export.

## Recommended next steps, in order

1. **Ratify the decisions** that need no vendors: launch defaults, Q3, `supervisor_hold`, the
   shutdown grace and in-flight tick wait, B15, the tidy-up defaults; settle the rate floors.
2. **Vendor setup**, because it has lead time: agency's VoiceLink account (ask about moving
   existing numbers and recording retention), Firebase authorised domain,
   Mailjet sender and domain, S3 bucket, Gemini / OpenAI keys, domain and TLS, PostHog.
3. **Deployment packaging:** done (`docker/`, see [`operations.md`](operations.md) "Production
   packaging") and the OpenTelemetry SDK. `aws/terraform` provisions the VM too (`create_server`):
   a staging VM exists (2026-10-11, Ubuntu 26.04, 2 vCPU / 4 GB, 20 GB) with Caddy holding a Let's
   Encrypt certificate for its domain. Left: the Grafana Cloud token, and running the stack there
   through `DEPLOYMENT.md` section 9 with the vendor accounts from step 2.
4. **Real-world checks:** one real VoiceLink sandbox call; one real recording analysed; the
   Playwright happy path against real Firebase; Plivo step 5 on a tenant's Plivo account (one
   call, one recording analysed, the checks listed in the Plivo table above).
5. **Parity check and dark pilot** on a staging copy and an internal tenant.
6. **Launch:** write and rehearse the import gate queries and copy scripts, the DNC mirror, the
   link from the previous platform and the dashboards, then go live environment by environment.
7. **Live call listening, before the first tenant** ([`listening.md`](listening.md) §10 "Not yet
   verified"; the consent wording's legal check is done, Manas, 2026-11-17): a listen in a
   real browser on staging (the autoplay policy and "Turn sound on", A-law playback, a 4503 and Try
   again, a hidden tab kept alive by the server's pings) against a real carrier call; the agent's
   notice on a phone; apply the `listen` alert group with the rest of `grafana/`; then the first
   tenant's enablement through the checklist ([`operations.md`](operations.md) "Enabling live call
   listening for a tenant"). In CI, set `LISTEN_LOAD_BOUNDS=on` for `full-ci` runs (a change to
   `.github/workflows/ci.yml`) so the load check's timing bounds are asserted there whatever the
   runner's CPUs; and add a mobile-station case to `live-listen-e2e.test.ts`.

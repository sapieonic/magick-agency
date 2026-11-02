# Status

Where Magick Agency stands, in detail: what each delivery phase built and the evidence for it,
the last test counts, what is not built, what is still open and with whom, the deployment
invariants, and what to do next. Read it before planning work on the repo, or before answering
"is it done". As of 2026-11-02.

## Summary

The application is built: phases 1 to 9 of the delivery plan
([`intent-and-plan.md`](intent-and-plan.md)) are complete on the code side, every suite is green,
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
| 2 Credential store | Done | Migration `0002_telephony_credentials.sql`; envelope sealer and env keyring; credential service and `getForCredentialId`; super-admin API and Telephony Credentials screen; unit tests and a real-Postgres repository suite, guards mutation-checked |
| 3 Plivo adapter | Not started | Dial (`request_uuid`), answer XML with `<Stream>`, μ-law media, cancel vs hangup by id, V3 webhook signatures checked against the pinned credential, `time_limit` on every dial, per-credential calls-per-second limit, recording fetch on per-provider hosts |
| 4 Dialler integration | Not started | Campaigns pin a credential; caller IDs limited to the credential's synced numbers; pause on carrier 401; `plivo` concurrency allocations; activate the `plivo` provider row (seeded inactive by 0002). Obligations the step-2 code leaves to this step: dial through `getForCredentialId(provider, id, 'dial', tenantId)`; insert the call row in a statement that re-checks the credential is `active` (revoke and shred lock the credential row, which waits out an insert in flight but cannot stop one that starts after them); pin a campaign only to an `active` credential; a metric and alert for missing keyring ids and failed sweeps (today they are ERROR/WARN logs); persist the dial's `providerRequestId` (Plivo `request_uuid`) to `provider_request_id` and the session, and give the hangup a way to cancel by it: `TelephonyProvider.endCall` takes only `providerCallId`, and `hangupProviderLeg` returns without a carrier call when that is empty, so a pre-answer teardown of a Plivo call does not reach the carrier today |
| 5 Live check | Not started | One real Plivo call and one recording analysed (needs a Plivo account) |

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
VoiceLink timeouts) were fixed on 2026-11-02 ("Scaling for 500 simultaneous calls"); their rows
stay for the record:

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
per-campaign call fields, "every call must be logged to a campaign", cancel while ringing (Plivo),
transfer and conference. Seen and left: light-theme `<select>` elements show no arrow app-wide
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

## Test counts

Latest run, 2026-11-02, after the second review's fixes, from inside each package (`pnpm lint`
clean in 8 packages; `pnpm build`, `pnpm test:grafana` 31 and `pnpm test:release` 10 pass;
super-admin, web-ui and domain unchanged since the row below, not re-run):

| Package | Unit | Integration |
|---|---|---|
| `apps/server` | 7569 passed + 42 skipped (380 files) | 1538 passed + 10 expected fail (166 files) |
| `packages/db` | 427 | 509 (46 files) |
| `apps/console` | 4921 (251 files) | — |
| `apps/super-admin` | 436 | — |
| `packages/contracts` | 249 | — |
| `packages/web-ui` | 235 | — |
| `packages/domain` | 61 | — |
| `packages/observability` | 14 | — |

Run of 2026-11-02, after the scaling phase A merges, from inside each package (`pnpm lint`
clean in 8 packages; `pnpm build`, `pnpm test:grafana` and `pnpm test:release` pass):

| Package | Unit | Integration |
|---|---|---|
| `apps/server` | 7430 passed + 42 skipped (360 files) | 1511 passed + 10 expected fail (161 files) |
| `packages/db` | 427 | 506 (46 files) |
| `apps/console` | 4917 (251 files) | — |
| `apps/super-admin` | 436 | — |
| `packages/contracts` | 249 | — |
| `packages/web-ui` | 235 | — |
| `packages/domain` | 61 | — |
| `packages/observability` | 14 | — |

The baseline before it, the same day: server 7334 unit + 4 expected fail + 42 skipped (352 files).
`flows/concurrency-guards.test.ts` ("costs exactly ONE Redis eval") counts evals with Redis's
server-wide `INFO commandstats`, so it fails when another suite shares the Redis instance; it
passes on a Redis of its own.

Run of 2026-10-31, after the soft phone's review fixes, from inside each package, on a UTF-8
test database (`pnpm lint` clean in 8 packages; `pnpm build`, `pnpm test:grafana` 31 and
`pnpm test:release` 10 pass):

| Package | Unit | Integration |
|---|---|---|
| `apps/server` | 7170 passed + 4 expected fail (340 files) | 1476 passed + 10 expected fail (154 files) |
| `packages/db` | 427 | 495 (44 files) |
| `apps/console` | 4808 (245 files) | — |
| `apps/super-admin` | 436 | — |
| `packages/contracts` | 94 | — |
| `packages/web-ui` | 235 | — |
| `packages/domain` | 55 | — |
| `packages/observability` | 14 | — |

Two load-suite files failed intermittently before the branch and passed in this run:
`load/agent-churn.test.ts` (see above) and `load/voicelink-media-ws-load.test.ts` ("start
negotiation failures", which once ended a call `provider_start_timeout` under a full run's load;
8 of 8 alone on this branch and on `c9fd548`).
The baseline before the soft phone, on `c9fd548`: server 6947 unit / 1301 integration, db 426 /
469, console 4560.

Latest run, 2026-10-23, after the load and scenario suites, `apps/server` only, from inside the
package: lint clean in 8 packages; unit 6755 passed + 4 expected fail + 42 skipped (332 files);
integration 1288 passed + 10 expected fail (141 files, about 9.5 min on 4 CPUs; the load files add about 5). Other packages are unchanged since the run below.

Run of 2026-10-23, after release-please and the version display (B24), unit suites from
inside each package (integration not re-run: neither change touches SQL):

| Package | Unit |
|---|---|
| `apps/server` | 6703 passed + 42 skipped |
| `packages/db` | 426 |
| `packages/domain` | 53 |
| `packages/contracts` | 77 |
| `packages/observability` | 14 |
| `packages/web-ui` | 235 |
| `apps/console` | 4416 |
| `apps/super-admin` | 423 |
| `grafana` (`pnpm test:grafana`) | 31 |
| `tooling` (`pnpm test:release`) | 10 |

`pnpm lint`: clean in 8 packages.

Run of 2026-10-17, after the tidy-up, from inside each package:

| Package | Unit | Integration |
|---|---|---|
| `apps/server` | 6703 passed + 42 skipped | 1211 |
| `packages/db` | 426 | 469 |
| `packages/domain` | 53 | — |
| `packages/contracts` | 77 | — |
| `packages/observability` | 14 | — |
| `packages/web-ui` | 231 | — |
| `apps/console` | 4410 | — |
| `apps/super-admin` | 421 | — |
| `grafana` (`pnpm test:grafana`) | 31 | — |

`pnpm lint`: clean in 8 packages.

Earlier runs follow, oldest first.

Final full run on 2026-10-09, after `pnpm install --frozen-lockfile`, from inside each package.

| Package | Lint | Unit | Integration | Build |
|---|---|---|---|---|
| `apps/server` | clean | 6412 (302 files)¹ | 1172 (105 files) | OK |
| `packages/db` | clean | 409 | 417 | — |
| `packages/domain` | clean | 50 | — | — |
| `packages/contracts` | clean | 73 | — | — |
| `packages/observability` | clean | 14 | — | — |
| `apps/console` | clean | 4367 (218 files) | — | OK |
| `apps/super-admin` | clean | 366 (24 files) | — | OK |

¹ 6350 in 298 files, plus the self-containment guard's 32
(`apps/server/test/unit/branding/no-external-references.test.ts`) and the production packaging's
30: 6 decoder-packaging tests (`apps/server/test/unit/audio/decoder-toolchain-packaging.test.ts`)
and 24 deployment tests (`apps/server/test/unit/deploy/`).

Unit re-run on 2026-10-10, after the AI client layer, audio analysis, the wizard's recording box
and the S3 Terraform: lint clean in 7 packages; `apps/server` 6507 (307 files); `apps/console` 4374
(218 files); `apps/super-admin` 366; `packages/db` 409; `packages/contracts` 73;
`packages/domain` 50; `packages/observability` 14. Integration and build were not re-run then,
apart from the pipeline and runtime-e2e integration files.

Re-run on 2026-10-11, after the brand logo and favicon (B17 amended): `apps/console` lint clean,
4389 unit (218 files), build OK; `apps/super-admin` lint clean, 374 unit (26 files), build OK.

Re-run on 2026-10-11, after the campaigns landing page redesign and reading the campaign list
past its first page (analytics): `apps/console` lint clean, 4433 unit (221 files), build OK.

Re-run on 2026-10-11, after the campaign list's `status` filter (the campaigns home reads every
active campaign, however old): `apps/console` lint clean, 4440 unit (221 files); `apps/server`
lint clean, 6512 of 6513 unit (308 files), the one failure being the branding guard reading an
uncommitted local file; integration re-run for `repository-sql-coverage.test.ts` only (12).

Re-run on 2026-10-11, after Plivo steps 1–2 and the credential review fixes (shred hold, verify
races, `peek`, uncached providers, keyboard-reachable credential rows): lint clean in 7 packages;
unit `apps/server` 6627 + 42 skipped (314 files), `packages/db` 410 (24 files),
`packages/contracts` 74, `apps/super-admin` 392 (27 files); integration `packages/db` 448
(39 files); `apps/server` integration lanes `rest` 1162 (103 files) and `wall-clock` 11 (2 files).
Two of three local `rest` runs failed 3 cases of `agency-double-reservation.test.ts` (two dials per
pacing tick instead of one); the file passes alone (10 of 10 runs) and the third full run passed,
so the failure depends on file order and is not yet explained.

CI (`.github/workflows/ci.yml`) runs lint, unit and build in one job, and the integration suites
in three parallel jobs (db, server, server wall-clock lane), each against its own Postgres 16 and
Redis 7 service containers on the same ports. Per-module test
files are listed in [`modules.md`](modules.md).

## Not built

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
| Launch defaults | Ratify: re-issue invites; inbound calls play a message and hang up; abandon clip upload-only; no API keys; super-admins created fresh |
| Launch open items | Existing numbers; launch style; domain, feature freeze, rollback window |
| Q3 contract choices | Ratify the five |
| B15 roster supersede | Build it, or leave replace and clear refused |
| Scaling defaults (2026-11-02) | Ratify the **default, pending Manas** rows of the scaling rulings (`decisions.md` §4): frame bound, back-pressure, VoiceLink timeouts and the 15 min deferred redial, Redis timeouts, ceilings and rate limits, analysis slots, pacing skips, the console's A-law default |
| Gated items | Vendor setup; Playwright happy path; parity check; dark pilot; real VoiceLink call and recording; launch |
| Load-suite defects | The 12 open defects pinned by `it.fails` ("Load and scenario suites 2026-10-23"): decide each fix; size `RATE_LIMIT_MAX` for a floor behind one NAT |
| Mobile app | Ratify the Q9 amendment (per-user and bearer IP rate-limit buckets). Decide whether a cellular call arriving while the agent is available pauses them (today it only shows the audio interruption, so the next reservation can land on someone on another call). First iOS build on a Mac; a device test on Android and iOS against a VoiceLink sandbox (include a failed `startForeground` on Android 14+, and the App Link hosts once the domain is decided), the soft phone included (ringback and Mute ring, the owed outcome's hold, M1 mid-call, SP7 on a phone, iOS CallKit for soft-phone calls); store accounts and signing |
| Metric export | Grafana Cloud's OTLP gateway is the assumed destination; confirm it and issue the token |

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

The production image and compose file (`docker/`, see [`operations.md`](operations.md)
"Production packaging") write invariants 1–5 and 7 into their headers and enforce what they can:
the server publishes no port, Redis runs with AOF and `noeviction`, the image is
`NODE_ENV=production` and migrates on start, the grace is 45 s.

### Pre-deploy checklist

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
- [ ] VoiceLink: account, numbers in the super-admin inventory, `VOICELINK_*` set,
      `VOICELINK_WEBHOOK_BASE_URL` reachable by the carrier.
- [ ] `SUPER_ADMIN_JWT_SECRET` set; first super-admin created with `node dist/create-super-admin.js`
      inside the server container (`operations.md` "First super-admin").
- [ ] Mailjet sender verified (SPF/DKIM); `MAILJET_*` and `CONSOLE_BASE_URL` set.
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
   Playwright happy path against real Firebase.
5. **Parity check and dark pilot** on a staging copy and an internal tenant.
6. **Launch:** write and rehearse the import gate queries and copy scripts, the DNC mirror, the
   link from the previous platform and the dashboards, then go live environment by environment.

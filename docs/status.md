# Status

Where Magick Agency stands, in detail: what each delivery phase built and the evidence for it,
the last test counts, what is not built, what is still open and with whom, the deployment
invariants, and what to do next. Read it before planning work on the repo, or before answering
"is it done". As of 2026-11-11.

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
| 2 Credential store | Done | Migration `0002_telephony_credentials.sql`; envelope sealer and env keyring; credential service and `getForCredentialId`; super-admin API and Telephony Credentials screen; unit tests and a real-Postgres repository suite, guards mutation-checked; keyring and sweep metrics with alerts `agy-credential-keyring-missing-keys` and `agy-credential-sweep-failing` (`voice-credential-housekeeping.test.ts`) |
| 3 Plivo adapter | Done | `feat(server): Plivo carrier module (adapter, μ-law media, callbacks, V3 signatures)` and `feat(server): fetch BYOC recordings on the tenant's credential (B21)`. Dial on the fixed API host returning the `request_uuid`, `time_limit` on every dial, cancel by request id and hang up by call id (an empty or malformed id refused before any URL is built), answer XML with a session `<Record>` and a bidirectional μ-law `<Stream>`, V3 signatures against the current and grace tokens, a per-account calls-per-second gate in Redis, `carrier_dial_refusals_total`; recordings through `telephony/recording-access.ts` (Plivo: `media.plivo.com` exactly, the credential on the first request only). Tests: `test/unit/telephony/plivo/` (`plivo.adapter`, `plivo-signature`, `plivo-dial-rate`, `plivo-config`, and `plivo-carrier.fixture.test.ts` over `plivo-carrier.fixture.json`), `audio-fir-mulaw.test.ts`, `carrier-errors.test.ts`, `recording-access.test.ts`, `recording-proxy.test.ts`, `recording-fetcher.test.ts` |
| 4 Dialler integration | Done | `feat(server,console,contracts,db,domain): pin campaigns to a tenant carrier credential and sync its numbers` (migration `0019_plivo_numbers_and_carrier_pause.sql`, numbered 0018 before main's `0018_agent_caller_ids.sql` was merged: the `plivo` provider row active, `phone_numbers.telephony_credential_id`, pause reason `carrier_auth`); `feat(server): dial Plivo on the campaign's credential through the bridge`; `feat(server): serve Plivo's answer, status and recording callbacks`; `feat(server): forward Plivo callbacks to the media worker that holds the call`; `feat(console,super-admin): choose the campaign's carrier and sync a credential's numbers`; `fix(db): offer no caller ID from a carrier credential that cannot dial`; `feat(server,console,contracts,db): pause a campaign whose carrier account is no longer active` (migration `0020_carrier_account_unavailable_pause.sql`). Every step-2 obligation is met: the bridge dials through `getForCredentialId(provider, id, 'dial', tenantId)`; the call row's INSERT re-checks the credential is `active` (`credential-call-insert.repository.test.ts`); a campaign pins only an `active` credential of its tenant; the dial's `request_uuid` is persisted to `provider_request_id` and a teardown before the answer cancels by it. Tests: `campaign-carrier-pinning.test.ts` (integration), `dialer-carrier-refusals.test.ts`, `webrtc-bridge-plivo.test.ts`, `plivo-webhooks.test.ts`, `plivo-callback-forwarding.test.ts`, `credential-number-sync.test.ts`, `proxy-agency-carriers.test.ts`, the db suites `plivo-numbers-migration`, `carrier-account-unavailable-migration` and `phone-number-sync.repository`, the console's `CampaignBuilderPage.carrier`, `AgencyCampaignSettingsPage.carrier` and `agencyCarriers`. End to end against the scriptable mock carrier (`apps/server/test/mocks/plivo/`, checked by `test/unit/load/mock-plivo-carrier.test.ts`, which runs the real `PlivoAdapter` against it): `test/integration/telephony/plivo-call-e2e.test.ts` (a full call; cancelled while ringing; unsigned, forged and other-tenant callbacks refused; a 401 pausing `carrier_auth`; a disabled credential pausing `carrier_account_unavailable`; the previous token accepted inside the rotation grace) and `plivo-cluster-forwarding.test.ts` (callbacks forwarded to a media worker and verified there), in the rest lane. An account on a per-carrier concurrency breakdown needs a `plivo` row, set in the super-admin console (`operations.md`, "Enabling Plivo for a tenant"); since the review fixes a campaign without one is refused at start (PL14) |
| Review fixes (2026-11-07) | Done | An independent review (principal engineer, product and QA) of steps 3 and 4 found no critical defect; every finding is fixed with a test that fails without it (mutation-checked). Dial path: a dial the adapter refuses before sending is unplaced and uncharged (`CarrierDialNotSentError`), and a contact number the carrier will never dial is suppressed `invalid`; `PLIVO_WEBHOOK_BASE_URL` validated at load; five carrier refusals in a row pause the campaign `carrier_refusing_calls` (migration `0021_carrier_refusing_calls_pause.sql`, PL11); a carrier that cannot dial is not offered and its campaigns do not start (PL12); a failed hangup gives back its one-hangup claim; a replayed signed callback is refused; an unanswered call ends soon after the carrier's ring timeout; the calls-per-second gate is a sliding window; tenants never see a carrier's raw error text. Campaigns: a retired caller ID no longer locks the settings and is no longer dialled (PL13); start is refused when the carrier has no concurrency allocation on a per-carrier breakdown (PL14); the health strip shows automatic carrier pauses and campaigns that cannot dial. Copy: "contact support" (PL15), super-admin names carriers "Alias (Vendor)" (PL16), no vendor name or UUID in the Activity trail, British spelling guarded in both web UIs. Agent app: the ringing warning only on a carrier that cannot cancel, `can_cancel_ringing` decoded in `agency_wire` |
| Merge with main (2026-11-07) | Done | `main`'s dedicated caller ID per agent (#51, DN1–DN10) and the Insights tabs (#53) merged in (a merge commit; the branch is published). `main`'s `0018_agent_caller_ids.sql` is released and kept; this branch's unreleased migrations moved up one, to `0019_plivo_numbers_and_carrier_pause.sql`, `0020_carrier_account_unavailable_pause.sql` and `0021_carrier_refusing_calls_pause.sql` (headers, tests, `BASELINE.md`, the down → up ledger). The two caller-ID rules are one: every dial path hands `resolveCallerId` (DN2) the campaign's DIALABLE caller IDs (PL13), so on a tenant's own carrier account a dedicated number retired or revoked there falls back to the rotation, and the rotation is the dialable pool minus the dedicated numbers; a service-account campaign behaves as on `main` (`decisions.md`, PL13's addendum). The supervisor's caller-ID list and PUT and the agent's My contacts see the same pool; removing a retired number still dedicated is refused `caller_id_dedicated`, naming it. Tests: `pacing-engine.test.ts` and `dedicated-caller-ids.test.ts` ("over the dialable pool"), `agency-agent-caller-ids.test.ts` (a pinned campaign end to end), each mutation-checked; counts under "Test counts" |
| 5 Live check | Not started | Needs a Plivo account. To check: one real call end to end (dial, answer XML, stream, hangup) and one recording analysed; the cause codes real hangup callbacks carry, added to `plivo-carrier.fixture.json`; the recording host and whether a recording fetch redirects (the fetch sends the credential to `media.plivo.com` only and never follows a redirect with it); the assumption that a 403 on create-call is a geo-permission refusal of the destination, not an auth failure; and the call detail record the ring deadline reads (`GET Call/{call_uuid}/`): the values of its `call_state` for a busy, unanswered, cancelled, failed and answered call (the SDK names the field, not its values; `plivo-carrier.fixture.json` `cdr` holds illustrative ones), its `hangup_cause_name` catalogue, and that it answers 404 while the call is live |

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
- Reads: the attempt lists and their CSV (a last column), the supervisor's call page, the
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
(`inbound.md` §12, P2 row), then a verification pass's two test fixes (below, "Test counts").
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
case fails (`char_length` counts bytes there), whatever the branch. The run on the finished branch
is under "Test counts".

**Not verified:** nothing has run on a real phone or a real carrier; the app's flow is tested with
the contract's sample frames and answers, the server's with a simulated phone station. iOS does not
compile yet, and the chime's Swift has never been compiled. The chime's Kotlin was compiled and
`ChimeTest.kt` passed offline on a JVM during review, but CI never runs the Android unit tests
(`ChimeTest.kt`, `RingbackTest.kt`). Ringing a phone whose app is in the background (push) is
parked, not started: a phone that leaves the app while available is paused and offered nothing.

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

### One station per agent 2026-11-11 (OS1–OS6, [`decisions.md`](decisions.md) §4, "One station per agent")

Manas: an agent stays online at one station only, one console window or the app, and across
tenants. Before this, the server already allowed one live session per agent per tenant and closed
an older socket of the same session with 4409; what was missing was the tenant boundary and a way
to stop a device that had lost its socket (a laptop asleep, a phone out of signal) from
re-minting a token and silently taking the station back from the device the agent had moved to.

- **Across tenants (OS1, OS2).** `0034_one_station_per_agent.sql`: `uq_agency_agent_live_agent`
  replaces the per-tenant index (duplicates ended when it runs). The join and the soft-phone open
  answer `409 session_in_other_tenant`, naming the tenant only; the console and the app show the
  server's sentence. This reverses the old pin that "the same agent id in another tenant is
  dialled independently" (`agency-double-reservation`, `agency-duplicate-dial` T-M6,
  `agency-session-tenant-unique`), each rewritten to the new rule.
- **One device holds the station (OS3–OS6).** `station_device_id` on the session; `device_id` and
  `take_over` on the join, the soft-phone open and the token mint (`AgencyStationDeviceFields`);
  `409 station_on_other_device` for any other device that does not take over. The console is one
  device per page load and takes over when its station or soft-phone page opens; its reconnects
  never do, a refused re-mint stops as a 4409 does, and "Use this window instead" takes over. The
  app is one device per install; "Go on duty", "Use this phone" and "Use it on this phone" take
  over, its own resumes and its reconnect ladder never do.
- **Copy:** "Your station moved to another device" / "Moved to another device" (was "another
  window"), and the app's "Your station is open in the console…".

Every new guard was mutation-checked (the claim SQL, the arbiter, the migration's clean-up order,
the console's mint refusal and take-over). **Not verified:** none of it has run against a real
browser, phone or carrier; older clients that send no `device_id` keep the newest-socket-wins
behaviour until `MOBILE_MIN_SUPPORTED_VERSION` is raised (OS6).

## Test counts

Latest run, 2026-11-12, the console navigation redesign (B28, B28a, IN14) with every round of
fixes: the QA run 20261112-110644, the three-persona review, and the automated review of PR #76
with its review comments (campaign Settings saves only what was changed and drops stale reads;
"Got it" per person, by the browser's day, back on a new pause; DNC search's `+` floor by calling
code and `00` numbers; Home's today figures keyed by the zone's day; invite scope; flag-gated agent
twins), on `feat/console-nav-redesign`:

Run on commit `ea9e894`, one package after another, integration with 2 workers per run
(`TEST_WORKERS=2`: this machine's Postgres still has `max_connections` 100) on the branch's own
test databases and Redis dbs. `pnpm lint` clean, `pnpm build` clean, `pnpm test:tooling` 16 and
`pnpm test:release` 10 pass, `contracts-literals --check` up to date. Run before this round, which
changed neither: `pnpm test:grafana` 33, `apps/mobile` `flutter analyze` no issues and `flutter
test` 1786 passed, `agency_wire` `dart test` 605 passed. **Not green, so no counts recorded for
them:** `apps/server` unit had 3 failures, all in `inbound-recordings.test.ts` (9727 passed + 1
expected fail): this machine has no audio decoder (`sox`, `ffmpeg`, `mpg123` absent), and the file
fails the same way on a branch with no server code change. `apps/server` integration: the
wall-clock lane is green (below); the rest lane had 16 failures (2705 passed + 9 expected fail + 2
skipped), all in `agency-reports-e2e.test.ts` (the in-process renderer answers `render_failed`) and
`inbound-clips-routes.test.ts` (no `mpg123` / `sndfile-programs`), the same 16 that fail on `main`
on this machine. Not run (untouched): `apps/super-admin`, `packages/web-ui`,
`apps/report-renderer`, `agent_audio`.

| Package | Unit | Integration |
|---|---|---|
| `apps/console` | 6856 (367 files) | — |
| `packages/domain` | 261 (13 files) | — |
| `packages/contracts` | 481 (15 files) | — |
| `packages/db` | 435 (26 files) | 746 (77 files) |
| `apps/server` | — (not green, above) | wall-clock lane 23 (5 files); rest lane not green (above) |

Previous run, 2026-11-12, on `main` (#74): integration files in parallel (one database and Redis db per worker,
the database copied afresh before each file, `tooling/test-env.ts`):

Run from inside each package, 4 workers on a 4-vCPU machine (Postgres 16 with `max_connections`
300 and Redis 7 on the agency ports), nothing else sharing them. `pnpm lint` clean; `pnpm
test:tooling` 16 and `pnpm test:release` 10 pass. `packages/db` unit 435 (26 files: the
worker-target tests are new) and integration 744 (76 files), green on ten runs in a row.
`apps/server` unit 9682 passed + 1 expected fail (488 files); rest lane 2678 passed + 9 expected
fail + 2 skipped (251 files + 2 skipped, with the new Redis range guard file), green on 3 of 4
runs: the fourth failed the inbound clash test, which read the agent's frames between the
connected row and the connected frame (fixed: it now waits for the frame, as the other inbound
files do; 3 of 3 green since). Wall-clock lane 23 (5 files). Postgres client connections peaked
at 95 across the four rest runs (they had reached 100, the old limit, before it was raised).
Wall time against a serial run (`TEST_WORKERS=1`) on the same machine the same day: rest lane
1139 s → 420–445 s; wall-clock lane 133 s (its files sum to 320 s run one after another);
`packages/db` integration 137 s → 48 s. Not run (untouched): the web UIs, `packages/contracts`,
`packages/domain`, `packages/observability`, `apps/report-renderer`, `apps/mobile`, `pnpm
test:grafana`.

Previous run, 2026-11-11, the inbound pilot rulings (IQ48–IQ57, above), after merging `main` (#69):

Run on the working tree of the commit that adds it, one after another from inside each package on a
local Postgres 16 test database and Redis db 1 with no other run sharing them. `pnpm lint` clean;
`pnpm test:tooling` 16, `pnpm test:release` 10 and `pnpm test:grafana` 33 pass;
`contracts-literals --check` up to date (62 vocabularies). `apps/mobile` (Flutter 3.47.9, one patch
above CI's pin): `flutter analyze` no issues, `flutter test` 1795 passed; `agency_wire` `dart test`
609 passed; `agent_audio` `flutter test` 139 passed (Dart; the Kotlin tests were not run). Not run
(untouched): `apps/super-admin`, `packages/web-ui`, `apps/report-renderer`. Two first runs were not
green and are not counted: a `packages/db` Plivo number-link test failed once and passed on the
re-run (unrelated to this change), and the server's first rest lane ran before `mpg123` /
`sndfile-programs` were installed and while fixtures still seeded one agent live in two tenants
(fixed, above).

| Package | Unit | Integration |
|---|---|---|
| `apps/server` | 9699 passed + 1 expected fail (488 files) | rest lane 2680 passed + 9 expected fail + 2 skipped (250 files + 2 skipped, the opt-in scale suites); wall-clock lane 23 (5 files) |
| `packages/db` | 428 (25 files) | 748 (77 files) |
| `apps/console` | 6170 | — |
| `packages/contracts` | 476 (14 files) | — |
| `packages/domain` | 254 (12 files) | — |
| `packages/observability` | 18 (4 files; not re-run, untouched) | — |
| `apps/mobile` | 1795 (`flutter test`); `agency_wire` 609 (`dart test`); `agent_audio` 139 (`flutter test`) | — |

Previous run, 2026-11-11, the inbound pilot rulings (IQ48–IQ57), on commit `c41091e`: server 9682
unit + 1 expected fail, rest lane 2673 + 9 expected fail + 2 skipped, wall-clock 23; db 428 / 744;
console 6161; contracts 476; domain 254; mobile 1781, `agency_wire` 605, `agent_audio` 139.

Previous run, 2026-11-11, inbound calls on the mobile app after the persona review:

Run on commit `e4e1451` (the docs commit after it changes no code), one after another from inside
each package on a UTF8 test database and Redis db 1 with no other run sharing them. `pnpm lint`
clean in 9 packages; `pnpm test:tooling` 16, `pnpm test:release` 10 and `pnpm test:grafana` 33
pass; `contracts-literals --check` up to date (62 vocabularies); `packages/observability` 18 (4
files). `apps/mobile`: `flutter analyze` no issues, `flutter test` 1705 passed; `agency_wire` `dart
test` 595 passed; `agent_audio` `flutter test` 136 passed (Dart; the Kotlin tests were not run).
The rest lane's first run failed one test, `agent-transition-ordering.test.ts`'s two concurrent
`setState` calls (the timing case already seen once, "Load and scenario suites" above; this branch
does not touch it), which passed three times alone; the whole lane was then rerun green, and those
are its counts. Not run (untouched by this change): `packages/db`, `apps/super-admin`,
`packages/web-ui`, `apps/report-renderer`. These counts are the branch's before `main`'s combined
duplicate key (#69, below) was merged into it; CI checks the merged result.

| Package | Unit | Integration |
|---|---|---|
| `apps/server` | 9643 passed + 1 expected fail (488 files) | rest lane 2654 passed + 9 expected fail + 2 skipped (250 files + 2 skipped, the opt-in scale suites); wall-clock lane 23 (5 files) |
| `apps/console` | 6114 (325 files) | — |
| `packages/contracts` | 463 (13 files) | — |
| `packages/domain` | 253 (12 files) | — |
| `apps/mobile` | 1705 (`flutter test`); `agency_wire` 595 (`dart test`); `agent_audio` 136 (`flutter test`) | — |

Previous run, 2026-11-10, inbound calls on the mobile app (IQ46, IQ47; `inbound.md` §12, P3 row),
after both review rounds:

Run on commit `cd6be77` (the docs commits after it change no code), one after another from inside
each package on a UTF8 test database and Redis db 1 with no other run sharing them; every step green
on its first run. `pnpm lint` clean in 9 packages; `pnpm test:tooling` 16 and `pnpm test:release`
10 pass; `contracts-literals --check` up to date (62 vocabularies). `apps/mobile`: `flutter analyze`
no issues, `flutter test` 1637 passed; `agency_wire` `dart test` 595 passed; `agent_audio`
`flutter test` 136 passed (Dart; the Kotlin tests were not run). Not run (untouched by this
change): `packages/db`, `apps/super-admin`, `packages/web-ui`, `apps/report-renderer`,
`packages/observability`, `pnpm test:grafana`.

| Package | Unit | Integration |
|---|---|---|
| `apps/server` | 9641 passed + 1 expected fail (488 files) | rest lane 2648 passed + 9 expected fail + 2 skipped (250 files + 2 skipped, the opt-in scale suites); wall-clock lane 21 (5 files) |
| `apps/console` | 6114 (325 files) | — |
| `packages/contracts` | 463 (13 files) | — |
| `packages/domain` | 253 (12 files) | — |
| `apps/mobile` | 1637 (`flutter test`); `agency_wire` 595 (`dart test`); `agent_audio` 136 (`flutter test`) | — |

Run of 2026-11-10 on `main`, the combined duplicate key and its review fixes (`29f66d7`), one after
another from inside each package on `magick_agency_test` and Redis db 1, nothing else sharing them.
`pnpm lint` clean; `pnpm build` green; `test:grafana`, `test:release` 10 and `test:tooling` 16 pass.
`agency_wire`'s `dart test` was not run (no Dart SDK on that machine); the change reaches no type it
models and no literal the extractor reads.

| Package | Unit | Integration |
|---|---|---|
| `apps/server` | 9636 passed + 2 expected fail (488 files) | rest lane: 1 failure, `load/voicelink-media-ws-load.test.ts` "start negotiation failures and garbage frames" (below); every other file passed. Wall-clock lane 19 (4 files) |
| `packages/db` | 428 (25 files) | 737 (74 files) |
| `apps/console` | 6136 (325 files) | — |
| `apps/super-admin` | 506 (37 files) | — |
| `packages/contracts` | 372 (13 files) | — |
| `packages/domain` | 253 (12 files) | — |
| `packages/web-ui` | 240 (20 files) | — |
| `apps/report-renderer` | 90 passed + 2 skipped (12 files + 1 skipped) | — |
| `packages/observability` | 18 (4 files) | — |

The console's first full run in this sequence failed `AgencyCampaignRosterAssignment.test.tsx`
("Escape closes the dialog, but not while a preview is in flight"), which passed alone three times
and in the full rerun counted above.

**Open defect, found in this run: a carrier `start` lost behind early media.** The VoiceLink load
case `media_before_bad_start` failed in both full rest-lane runs of this branch (plans 24 and 17,
seed 24301: `provider_start_timeout` where `unsupported_media_format` is expected) and passes alone
(3 of 3); the parent commit `cc40c1d`'s rest lane passed once. This branch does not touch the voice
path. Cause: `PSTN_EARLY_FRAME_CAP` (16, `src/core/webrtc-bridge-manager.ts`) bounds the frames held
while the provider token is checked, and this case sends a burst of media before its `start`; under
a full lane's load the check outlasts the burst, the `start` lands past the cap and is dropped, and
the call times out. A fix holds a `start` frame whatever the cap (dropping only media past it).
Not changed here; it needs a ruling on the seam.

Run of 2026-11-09, inbound calls after the fix pass (both rounds, IQ25–IQ45; `inbound.md`
§12), on the merged branch:

Run one after another from inside each package on the default test database
(`magick_agency_test`) and Redis db 1 with no other run sharing them. The integration lanes, `pnpm
build`, `test:grafana`, `test:release`, lint and every unit suite ran again on `dbdbc72`, after
the behaviour-preserving cleanup pass (shared helpers, dead code removed, fewer reads on the answer
path; no contract or migration change). `pnpm lint` clean in 9 packages; `pnpm test:grafana` 33 and `pnpm
test:release` 10 pass; `pnpm build` green. `apps/mobile/packages/agency_wire` `dart test` 510 passed
and `dart analyze` clean (Dart 3.13.7 only, the package run outside the Flutter workspace with the
contract fixtures linked; `agent_audio` and the app need Flutter and were not run).

| Package | Unit | Integration |
|---|---|---|
| `apps/server` | 9614 passed + 1 expected fail (488 files) | rest lane 2631 passed + 9 expected fail + 2 skipped (249 files + 2 skipped, the opt-in scale suites); wall-clock lane 19 (4 files) |
| `packages/db` | 428 (25 files) | 731 (73 files) |
| `apps/console` | 6100 (323 files) | — |
| `apps/super-admin` | 506 (37 files) | — |
| `packages/contracts` | 372 (13 files) | — |
| `packages/domain` | 253 (12 files) | — |
| `packages/web-ui` | 240 (20 files) | — |
| `apps/report-renderer` | 88 passed + 2 skipped (11 files + 1 skipped) | — |
| `packages/observability` | 18 (4 files) | — |

One failure on the first unit run, fixed and not a product fault: `apps/super-admin`
`SAUsagePage` read a stat card's text while its count-up animation (`useCountUp`) was mid-frame
("0:02:02" for "2:02:02"), about one run in three; the cards' settled `aria-label` is read instead
(`044aab9`), green 10 runs in a row; the super-admin tests now run with reduced motion, so the cards
show their settled value and the test reads the visible text again. Known flakes the fix pass removed: the `packages/db` plan tests
that flipped with autovacuum's statistics (0003, 0004, 0005, 0011, 0015, 0017 and the usage read now
plan over rows of their own), `report-assembler-deadline`'s unhandled timer, and the audit drain's
threshold at `LOAD_SCALE=3`.

Previous run, 2026-11-09, inbound calls P1 and P2 complete (`inbound.md` §12, after the P2 review
fix pass and the verification pass's two test fixes), on commit `6840f9b`, run one after another
from inside each package on the default test database (`magick_agency_test`) and Redis db 1 with no
other run sharing them; every step green on its first run, no flake seen: `pnpm lint` clean in 9
packages; `pnpm test:grafana` 33 and `pnpm test:release` 10 pass. Not run: `pnpm build` and
`apps/mobile` (no Flutter or Dart here: P2's `agency_wire` changes are untested by `dart test`).

| Package | Unit | Integration |
|---|---|---|
| `apps/server` | 9467 passed + 1 expected fail + 42 skipped (478 files) | rest lane 2520 passed + 9 expected fail + 2 skipped (239 files + 2 skipped, the opt-in scale suites); wall-clock lane 19 (4 files) |
| `packages/db` | 428 (25 files) | 696 (68 files) |
| `apps/console` | 6016 (316 files) | — |
| `apps/super-admin` | 500 (37 files) | — |
| `packages/contracts` | 367 (13 files) | — |
| `packages/domain` | 253 (12 files) | — |
| `packages/web-ui` | 240 (20 files) | — |
| `apps/report-renderer` | 88 passed + 2 skipped (11 files + 1 skipped) | — |
| `packages/observability` | 14 (3 files) | — |

The previous full run (on `2f68f55`) failed three tests, each a test that read a state before the
code under test had settled it, not a product fault (commits `be46605`, `6840f9b`):

- `packages/db` `attempt-indexes-migration` (`idx_agency_contacts_connected`) and
  `contacts-in-flight-index-migration` (`idx_agency_contacts_in_flight`): their EXPLAIN plans ran
  over whatever earlier files left. In the failing file order `agency_contacts` was analyzed empty
  (reltuples 0, no column statistics), both partial indexes were bloated by earlier files' dead
  rows (5 pages) and `idx_agency_contacts_insights` was 1 page, rebuilt by the last down → up
  across `0026` (which rebuilds it); priced by pages, the planner served both sweeps from the
  insights index with `state` on its second column. Reproduced red in that order and on a scratch
  database in that state. Over a campaign-shaped roster with fresh statistics both sweeps use their
  partial indexes, with or without `0026`, so this is not a production regression; it is the same
  latent fragility the busy-probe test had, exposed by the inbound work (`0026`'s rebuild on every
  down → up across it, more rolled-back rosters). Both tests now insert and ANALYZE a roster and
  its attempts inside their rolled-back transaction (`insertPlanRoster`, `test/integration/fixtures.ts`).
  Mutation-checked: each partial predicate widened to take `pending`, and each made one the query
  does not imply, turns the plan assertion red. A rolled-back ANALYZE still leaves the table's and
  indexes' `reltuples` / `relpages` (written in place) and the rows' index entries behind, so a
  plan test that seeds nothing can still follow what an earlier file did.
- `apps/server` `inbound-connect-e2e` 2b (the sticky wait lapses, the team takes the caller): it
  read B's `inbound_call` frame and A's last `customer_waiting` at the instant the spine row read
  `offered`, which the connector commits before it sends the frames (and A's socket carries the
  first call's audio ahead of the notice). Under CPU load the old test failed 1 run in 9 (on B's
  frame); the full lane failed it on A's. The connector's order is right (one resolved panel
  promise, frames in call order; an offered caller is out of every search). The test now waits for
  both frames and pins A's notices for the call as exactly [waiting, cleared]: 28 of 28 runs under
  CPU load green; mutation-checked (re-notifying on every search, and not clearing on the offer,
  each red).

Previous run, 2026-11-09, inbound calls P1 (the foundation, the three slices and the review's fixes,
`inbound.md` §12), from inside each package, on this worktree's own test database and Redis db with
no other run sharing them: `pnpm lint` clean in 9 packages; `pnpm test:grafana` 33 and
`pnpm test:release` 10 pass; `contracts-literals --check` up to date (51 vocabularies). Not rerun
(untouched by the fix pass): `apps/report-renderer`, `packages/web-ui`, `packages/domain`,
`pnpm build`, and `apps/mobile` (no Flutter or Dart here; the only contract change since the
slices is a super-admin error code, which the app does not decode).

| Package | Unit | Integration |
|---|---|---|
| `apps/server` | 9305 passed + 1 expected fail + 42 skipped (468 files) | rest lane 2416 passed + 9 expected fail + 2 skipped (231 files + 2 skipped, the opt-in scale suites); wall-clock lane 15 (3 files) |
| `packages/db` | 428 (25 files) | 684 (67 files) |
| `apps/console` | 5913 (309 files) | — |
| `apps/super-admin` | 500 (37 files) | — |
| `packages/contracts` | 361 (12 files) | — |
| `packages/observability` | 14 (3 files) | — |

Inbound's own files within those counts: server unit `plivo-inbound-webhooks` 17,
`inbound-service` 17, `plivo-inbound-adapter` 12, `agency/inbound/*` 25, `webrtc-bridge-inbound`
12; server integration `inbound-call-router` 15, `inbound-call-repository` 20, `inbound-follow-up`
17, `inbound-route-repository` 18, `api/inbound-routes` 13, `plivo-inbound-e2e` 18,
`plivo-inbound-admin` 22; db integration `inbound-migration` 31, `inbound-live-indexes-migration` 6,
`phone-number-inbound.repository` 7. `multiple-running-campaigns-migration`'s busy-probe plan test,
which failed once in a full `packages/db` run and passed alone, now seeds and analyzes its own
roster inside its rolled-back transaction: its plan had followed the statistics and index sizes
earlier files left on `agency_contacts`. Reproduced red on the old test (and green on the new) with
the live-number index bloated by earlier inserts and `idx_agency_contacts_customer_history` rebuilt
small, as another file's down → up leaves it: the planner then served the probe from that index.
Not caused by the inbound indexes or a widened probe (`numberLiveSql` is unchanged).

Previous run, 2026-11-08, the reports feature (RP1–RP16) after the final review's fixes (the flag
gate on schedules and emails, `subject_changed`, the restart reclaim, final callback refusals) and
the simplification pass (shared helpers, one definition-key list in the contracts, the workbook's
Definition cells filled, the console's outcome words in the workbook, lighter dataset reads,
report polling paused in a hidden tab and backed off) and the PR review's fixes (a bounded
pipeline shutdown, subscription runs counted after commit, the per-user rate counted in the
insert, lower-cased header ids, re-enable resolving the subject, one build deadline over detail
streaming, superseded renders dropped, the renderer out of the production image), from inside each package, with no other run sharing this worktree's database: `pnpm lint` clean in
9 packages; `pnpm test:grafana` 33 and `pnpm test:release` 10 pass; `pnpm build` clean;
`contracts-literals --check` up to date (51 vocabularies); `aws/terraform` `terraform test` 9 pass and
`validate` clean. `apps/mobile` was not run (no Flutter or Dart in this environment).

| Package | Unit | Integration |
|---|---|---|
| `apps/server` | 9152 passed + 1 expected fail + 42 skipped (457 files) | rest lane 2293 passed + 9 expected fail + 2 skipped (224 files + 2 skipped, the opt-in scale suites); wall-clock lane 15 (3 files) |
| `packages/db` | 428 (25 files) | 632 (64 files) |
| `apps/console` | 5876 (305 files) | — |
| `apps/super-admin` | 471 (35 files) | — |
| `apps/report-renderer` | 88 passed + 2 skipped (11 files + 1 skipped: the opt-in preview and a CI-only browser check) | — |
| `packages/contracts` | 352 (12 files) | — |
| `packages/web-ui` | 240 (20 files) | — |
| `packages/domain` | 142 (9 files) | — |
| `packages/observability` | 14 (3 files) | — |

Previous run, 2026-11-07, the eight PR #56 review fixes on top of `8423bae` (the PL11 breaker counts
4xx only, a sync takes over a revoked same-account credential's numbers, the dialable caller-ID
cache's in-flight race and its media-worker invalidation, an unsent dial no longer resets the
streak, a keyring fault is a bridge failure, the Plivo CDR's `call_state`, the breaker's `DEL`
memo), from inside each package, with no other run sharing this worktree's database: `pnpm lint`
clean in 8 packages; `pnpm test:grafana` 33 and `pnpm test:release` 10 pass; `pnpm build` clean;
`contracts-literals --check` up to date (51 vocabularies). `apps/mobile` with Flutter 3.47.7:
`flutter test` 1466, `agency_wire` `dart test` 510 (a platform contract type changed).

| Package | Unit | Integration |
|---|---|---|
| `apps/server` | 8883 passed + 1 expected fail + 42 skipped (443 files) | rest lane 2151 passed + 9 expected fail + 1 skipped (213 files + 1 skipped); wall-clock lane 15 (3 files) |
| `packages/db` | 428 (25 files) | 614 (62 files) |
| `apps/console` | 5685 (294 files) | — |
| `apps/super-admin` | 471 (35 files) | — |
| `packages/contracts` | 335 (11 files) | — |
| `packages/web-ui` | 237 (20 files) | — |
| `packages/domain` | 137 (8 files) | — |
| `packages/observability` | 14 (3 files) | — |

Previous run, 2026-11-07, the Plivo branch after merging `main` (#51 dedicated caller IDs, #53
Insights tabs) and integrating the two caller-ID rules, from inside each package, with no other
run sharing this worktree's database: `pnpm lint` clean in 8 packages; `pnpm test:grafana` 33 and
`pnpm test:release` 10 pass; `pnpm build` clean; `contracts-literals --check` up to date (51
vocabularies). `apps/mobile` with Flutter 3.47.7: `flutter test` 1466, `agency_wire` `dart test` 510.

| Package | Unit | Integration |
|---|---|---|
| `apps/server` | 8837 passed + 1 expected fail + 42 skipped (443 files) | rest lane 2150 passed + 9 expected fail + 1 skipped (213 files + 1 skipped); wall-clock lane 15 (3 files) |
| `packages/db` | 428 (25 files) | 612 (62 files) |
| `apps/console` | 5685 (294 files) | — |
| `apps/super-admin` | 471 (35 files) | — |
| `packages/contracts` | 335 (11 files) | — |
| `packages/web-ui` | 237 (20 files) | — |
| `packages/domain` | 137 (8 files) | — |
| `packages/observability` | 14 (3 files) | — |

The first server unit run of the merge failed one case, the repository guard against another
repository's migration numbers (`no-external-references.test.ts`): `decisions.md` said "migration
0020" in prose, which the guard reads as a three-digit number; it now names the file. The counts
above are from the full rerun after that fix.

Run of 2026-11-07, the Plivo review fixes on `f7f06dc`, from inside each package, with no
other run sharing Postgres or Redis: `pnpm lint` clean in 8 packages; `pnpm test:grafana` 33 and
`pnpm test:release` 10 pass; `pnpm build` clean. `apps/mobile` with Flutter 3.47.7 (Dart 3.13.5):
`flutter analyze` clean.

| Package | Unit | Integration |
|---|---|---|
| `apps/server` | 8741 passed + 1 expected fail + 42 skipped | rest lane 2100 passed + 9 expected fail + 1 skipped; wall-clock lane 15 (3 files) |
| `packages/db` | 428 (25 files) | 607 (61 files), see below |
| `apps/console` | 5596 | — |
| `apps/super-admin` | 469 | — |
| `packages/contracts` | 333 | — |
| `packages/web-ui` | 235 | — |
| `packages/domain` | 137 | — |
| `packages/observability` | 14 | — |
| `apps/mobile` | `flutter test` 1466, `agency_wire` `dart test` 510 | — |

`packages/db` integration failed one plan case in that run (`insights-foundation-migration.test.ts`,
the 0011 roster bucket count: the planner chose `idx_agency_contacts_assignee` over the covering
index on the near-empty table); it passed 3 of 3 alone and in a full rerun (607). Earlier runs of
these fixes failed `usage-counts.repository.test.ts`'s plan case the same way, once each, and
`flows/concurrency-guards.test.ts`'s Redis eval count while other agents' suites shared the Redis
server (it counts every eval on the server). None touches code this work changed; the plan cases
look sensitive to background statistics (autovacuum) on near-empty tables. Open: make those plan
cases ANALYZE inside their own rolled-back transaction, as `insights-reads.test.ts` does.

Run of 2026-11-06, the customer-history branch after its PR #50 review fixes. The agent app's
Dart suites cannot run where it was built (no SDK), so there is no `apps/mobile` row for this run.
The mobile CI job on PR #50 ran them before the review fixes, green (`flutter analyze`,
`flutter test`, `agency_wire` `dart test` 493, `agent_audio` 124, the Android build); the review
fixes' Dart changes are checked by its next run.

From inside each package: `pnpm lint` clean in 8 packages; `pnpm test:grafana` 33 and
`pnpm test:release` 10 pass; `pnpm build` clean; `contracts-literals --check` up to date (51
vocabularies).

| Package | Unit | Integration |
|---|---|---|
| `apps/server` | 8231 passed + 1 expected fail + 42 skipped (412 files) | rest lane 2036 passed + 9 expected fail + 1 skipped (205 files + 1 opt-in scale file skipped); wall-clock lane 15 (3 files) |
| `packages/db` | 428 (25 files) | 574 (56 files) |
| `apps/console` | 5500 (287 files) | — |
| `apps/super-admin` | 446 (33 files) | — |
| `packages/contracts` | 332 (10 files) | — |
| `packages/web-ui` | 235 (20 files) | — |
| `packages/domain` | 137 (8 files) | — |
| `packages/observability` | 14 (3 files) | — |

Two earlier full rest-lane runs of this work failed `insights-reads.test.ts`'s pace plan case:
`customer-history.test.ts` ran a bare `ANALYZE` on its bulk seed, and the statistics outlived the
rows into the later file's plan. Its plans (and the 0016 migration test's) now ANALYZE inside the
plan's rolled-back transaction, as `insights-reads.test.ts` does; the run above is after that fix.
One of those runs also failed `load/voicelink-media-ws-load.test.ts` once (seed 24301, 1 of 2
alone; code this branch does not touch).

The counts above are after the `/simplify` cleanup (named SQL fragments, one callbacks
statement, a count-only export statement, the shared audit bounds and dialer gate). Its first rest
run failed `softphone-policy-routes.test.ts`'s emoji note case only because a stand-in local
Postgres had a `SQL_ASCII` database (byte lengths, not characters); recreated as UTF8, as the
Docker image is, the lane above is green.

The counts above are after the PR #50 review fixes. Two plan tests outside this feature tied on
the test database's near-empty tables and followed whatever rows earlier files left (the file
order changed with the new files): 0003's `countLive` plan (0005's `idx_agency_attempts_account_live`
carries the same predicate; the test now drops it inside its rolled-back transaction) and
`insights-reads.test.ts`'s pace (its contacts side now ANALYZEd inside the rolled-back
transaction too). The CH14 placeholder seeds (200,000 rows, rolled back) are followed by a
`VACUUM`, so their dead pages do not size a later file's tables. One run failed
`local-cache-invalidation.test.ts` and `agent-transition-ordering.test.ts` (Redis and timing;
green alone and in the full rerun) and one `load/voicelink-media-ws-load.test.ts` (seed 24301).

After the per-campaign connect rate (`by_campaign[]` connect counts and `rates_reportable`,
`/stats` `first_dials_placed`, the console and the agent app reading them): `pnpm lint` clean in 8
packages; unit as in the table (`apps/server` 8036 + 42 skipped, `packages/contracts` 281,
`contracts-literals --check` up to date); `apps/server` rest lane 1916 passed + 9 expected fail + 1
skipped, wall-clock lane 15; `packages/db` integration 562. One earlier rest-lane run on this work
failed `pacing-skip.test.ts` ("the skip path was never exercised"), the flake `main` fixed in #37,
not yet merged here; it passed 3 of 3 alone, before and after the change.

After 0009's row work moved to 0010 (CHECKs added `NOT VALID` in 0009, validated with the
assignee index in 0010): `packages/db` 427 unit, 536 integration (49 files); `apps/server` rest
lane 1743 passed + 9 expected fail + 1 failed (185 files), the one failure being the scale test
below timing out at 20 s (alone: 18 passed, that test in ~1.1 s); `pnpm lint` clean,
`pnpm test:release` 10 pass.

**Open: one scale test times out in some full runs.** `assignment-repository.test.ts` "splits
10,000 contacts across 5 agents" takes about 1.1 s alone, but in 2 of 4 full rest-lane runs on
the build container it passed the 20 s test timeout when it ran in the middle of the lane (each
time the lane was otherwise 1730 passed; the second run also had the known `agent-churn`
intermittent). It passed in the two runs where it ran first and last, and in the run above. Ruled out: lock waits (no
lock-timeout errors), stale planner statistics, rows left by earlier files, and CPU contention
alone (the second failure was on a quiet machine). Not ruled out: I/O stalls on that disk
(checkpoints ran through both windows, but through the passing ones too). Its timeout is
unchanged; if CI shows it, record per-phase timings before deciding between a fix and a longer
timeout for this one test. Seen on the way and pre-existing: `agency_contacts.source_contact_id`
(`ON DELETE SET NULL`) has no index, so deleting a contact checks the whole table for rows naming
it; the likely reason a 200 000-row `DELETE` in a scratch test ran for minutes.

Run of 2026-11-03, the wrap-up redial branch after its review fixes, on `028b2ab`, from inside
each package (`pnpm lint` clean in 8 packages; `pnpm test:grafana` 32 and `pnpm test:release` 10
pass; details and the one file that fails only in the combined run: "Wrap-up redial 2026-11-03"):

| Package | Unit | Integration |
|---|---|---|
| `apps/server` | 7720 passed + 42 skipped (386 files) | rest lane 1602 passed + 9 expected fail; wall-clock lane 15 (177 files) |
| `packages/db` | 427 | 519 (48 files) |
| `apps/console` | 5015 (256 files) | — |
| `apps/super-admin` | 446 | — |
| `packages/contracts` | 252 | — |
| `packages/web-ui` | 235 | — |
| `packages/domain` | 61 | — |
| `packages/observability` | 14 | — |
| `apps/mobile` | `flutter test` 1316, `agency_wire` 341 | — |

Since PR #29's run: one expected fail fewer there (`disposition-storm.test.ts` case 5 is now an `it`).

Run of 2026-11-03, after merging `main` (#27, #28) into the scaling branch, from inside each
package (`pnpm lint` clean in 8 packages; `pnpm build`, `pnpm test:grafana` 31 and
`pnpm test:release` 10 pass):

| Package | Unit | Integration |
|---|---|---|
| `apps/server` | 7590 passed + 42 skipped (380 files) | 1545 passed + 10 expected fail + 1 failed (167 files) |
| `packages/db` | 427 | 512 (47 files) |
| `apps/console` | 4944 (252 files) | — |
| `apps/super-admin` | 446 | — |
| `packages/contracts` | 249 | — |
| `packages/web-ui` | 235 | — |
| `packages/domain` | 61 | — |
| `packages/observability` | 14 | — |

The 1 failed is `load/agent-churn.test.ts`, the known intermittent (below: 2 of 8 on `c9fd548`):
its seed (24301) replayed green 3 of 3, and 6 more random seeds were green.

Run of 2026-11-02, after the scaling phase A merges, from inside each package (`pnpm lint`
clean in 8 packages; `pnpm build`, `pnpm test:grafana` and `pnpm test:release` pass):

| Package | Unit | Integration |
|---|---|---|
| `apps/server` | 7430 passed + 42 skipped (360 files) | 1511 passed + 10 expected fail (161 files) |
| `packages/db` | 427 | 506 (46 files) |
| `apps/console` | 4917 (251 files) | — |
| `apps/super-admin` | 446 | — |
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
| `apps/super-admin` | 446 | — |
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
| `tooling` (`pnpm test:tooling`) | 16 |

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
Redis 7 service containers on the same ports. On a pull request it runs only what the change
reaches (`tooling/ci-scope.mjs`; the `full-ci` label runs everything; [`operations.md`](operations.md),
"What CI runs"). Per-module test
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
  and customer history. Ringing a phone whose app is in the background (push) is parked, not
  started: an app build that declares `caps=inbound` takes callers only with the app on screen.
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
| Metric export | Grafana Cloud's OTLP gateway is the assumed destination; confirm it and issue the token |
| Duplicate column | Ratify the key rules and the one-live-call guard; decide whether the soft phone should refuse a number whose contact is `connected`. The combined key's rules, its phone-only default and "DNC row claims its key" were ruled 2026-11-11 (`decisions.md` §4) |
| Contact assignment | Ratify CA2–CA10 and CA13–CA15 (`decisions.md` §4), in particular CA5: in `strict` mode a callback whose owner stays away falls back to an unassigned contact nobody dials until a supervisor assigns it; and decide when to turn on `agency_contact_assignment_enabled` |
| Wrap-up redial | Ratify the **default, pending Manas** rows WR1, WR3, WR4, WR7–WR13 (`decisions.md` §4), including the ask's open question: redials do not spend `max_attempts` (WR3) |
| Abandonment ceiling | Ratify AC1–AC3 (`decisions.md` §4): the console offers 0.5–10%; above 3% it warns but no extra role is needed |
| Several running campaigns | Ratify MC1–MC7 (`decisions.md` §4): equal fair share, fewest live calls first, decided in the pacing round; the busy-number check widened to the account, the soft phone's tagged dials included. Weights and a per-campaign cap were left for later. Decide MC3's two-process overlap (live attempt rows above the limit while two processes lead campaigns of one account, the concurrency guard refusing the excess calls): an account-level lease or a Redis slot reservation, or accept it |
| Customer history | Ratify CH6–CH11, CH12 b–d and CH13 (`decisions.md` §4), in particular the 30-a-minute cap, the 30-minute search id, the audit coverage (refusals and timeline pages are not audited) and the export being the console's only. Decide CH12 a, whether DNC removals must appear in a number's history (they would need the number kept on removal, today deliberately not recorded), and CH12 e, whether the roster ingest should drop a bracketed trunk `(0)` as the soft phone and the search do (it changes what existing rosters dedupe on). CH12 b (the upload file inferred from the import window) and CH12 c (no row is ever "Removed from roster" until B15's supersede) are what the schema allows today |
| Account creation | Ratify AA1–AA3, AA5, AA6 (`decisions.md` §4): tenant admins need a tenant-wide seat to create accounts; names unique in the tenant ignoring case; creates in one tenant serialised; accounts listed oldest first; no rename or delete yet. AA4 is decided: a tenant admin's new account has zero call capacity until a super admin sets it |
| Inbound calls | The persona review's product rulings are decided and built (IQ48–IQ57, above); at the pilot's start raise `MOBILE_MIN_SUPPORTED_VERSION` to the first release that declares `caps=inbound` (IQ56); in-app voicemail playback after the pilot (IQ53). Engineering follow-ups: split the inbound call slot out of the station controller and merge the campaign `NotesAutosave` into `CallAutosave`; the `agent_audio` Kotlin tests now run in CI (`mobile.yml`, after the Android build). A Plivo account for P0. Ratify the fix pass's defaults IQ25–IQ45 (`decisions.md` §4, "Inbound fix pass"): the 15 s rejoin grace, the 120 s unmatched wrap-up, the busy words for withheld and DNC callers, the kill switch's closed message, the upload limits, the alert thresholds. Sign off the standard recordings (listening and licence); decide the voicemail and spine retention for a UK pilot |
| Plivo on tenants' own accounts | Ratify PL1–PL16 (`decisions.md` §4, "Plivo on tenants' own accounts"): a 403 on dial read as a geo-permission refusal; the three automatic pauses (`carrier_auth`, `carrier_account_unavailable`, and `carrier_refusing_calls` after five refusals in a row, PL11); a carrier with no webhook base not offered or started (PL12); numbers of a credential that cannot dial not offered; synced numbers tenant-wide; recordings from `media.plivo.com` only; the calls-per-second default of 2 per account; the carrier choice shown only with more than one carrier account |

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

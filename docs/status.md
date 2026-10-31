# Status

Where Magick Agency stands, in detail: what each delivery phase built and the evidence for it,
the last test counts, what is not built, what is still open and with whom, the deployment
invariants, and what to do next. Read it before planning work on the repo, or before answering
"is it done". As of 2026-10-31.

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
- Caching `getMaxConcurrentCalls`: it would defeat cross-replica invalidation.
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
need Manas or a deliberate change to a shared file:

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
behind one office NAT, so `RATE_LIMIT_MAX` needs sizing for such a deployment; with the
production ioredis defaults a Redis outage takes about 10 s to surface on `/readyz` and some
requests wait about 30 s (no command timeout); the PSTN socket refuses a bad token with a bare
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

## Test counts

Latest run, 2026-10-31, after the soft phone's review fixes, from inside each package, on a UTF-8
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
| Gated items | Vendor setup; Playwright happy path; parity check; dark pilot; real VoiceLink call and recording; launch |
| Load-suite defects | The 12 open defects pinned by `it.fails` ("Load and scenario suites 2026-10-23"): decide each fix; size `RATE_LIMIT_MAX` for a floor behind one NAT |
| Metric export | Grafana Cloud's OTLP gateway is the assumed destination; confirm it and issue the token |

## Deployment invariants

Properties the running system needs that the code cannot enforce on its own. Config details are
in [`operations.md`](operations.md).

1. **Redis keeps keys for their TTL.** Persistence on (AOF or RDB) and `maxmemory-policy
   noeviction` (or a `volatile-*` policy with nothing else competing). Call tokens are verified
   against Redis; a token lost early is refused, which cuts a live call's carrier leg (Q6).
2. **Single replica.** The unstored-token memo is in-process (Q6), the dialer runtime has one
   replica id, and several sweeps assume one process.
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
- [ ] One replica only: never scale `server`.
- [ ] TLS terminator in front of nginx :8080; `TRUST_PROXY_HOPS=2` (terminator + nginx; one more
      per extra proxy in front); :8080 reachable only from the terminator (loopback by default);
      port 3021 not reachable at all (the compose file publishes none).
- [ ] Super-admin :8081: loopback by default (SSH or Session Manager tunnel, or a VPN). If it is
      published through the TLS terminator, on its own domain, IP-allow-listed where possible, and
      with strong passwords on every admin (`DEPLOYMENT.md` 8.4 lists the costs).
- [ ] Host memory: the server may grow to a 4 GB heap (`docker/entrypoint.sh`). On a 4 GB VM (the
      `aws/terraform` default) that is all of the RAM; lower the heap or size up before load.
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

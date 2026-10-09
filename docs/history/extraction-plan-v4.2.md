> **Frozen copy.** Source: `MagickVoice-platform/docs/agency-extraction-plan.md` (an untracked file in the superproject working tree, so it has no commit SHA; copied 2026-10-09).
> Approved by Manas on 2026-10-08 as v4.2. This is the plan the build followed; it is not updated. Relative links in the body (`../agency.md`, `agency-dialer-design.md`) are as written for the superproject; the local copies are under [`../reference/`](../reference/README.md).
> Current state lives in [`../status.md`](../status.md); decisions taken since are in [`../decisions.md`](../decisions.md).

# Magick Agency extraction plan

**Status:** proposed, v4.2, 2026-10-08. Not started.
**Read against:** core `v1.123.2`, master `v3.24.0`, cusui `v2.96.0`, all at `origin/main`.
**Target repo:** `/Users/manasnilorout/Personal/Sapionic/magick-agency` (empty).
**Companions:** [`agency.md`](../agency.md) (domain and invariants),
[`agency-dialer-design.md`](agency-dialer-design.md) (D1–D11).

## Decided

| # | Decision | Source |
|---|---|---|
| 1 | Magick Agency becomes an **entirely separate, self-sufficient application** for the first cut, with **no runtime dependency on core or master**. | Manas, 2026-10-08 |
| 2 | It owns its **voice engine**: the bridge and the VoiceLink adapter. | Manas, 2026-10-08 |
| 3 | It owns its **carrier capacity**: its own VoiceLink account, numbers and concurrency limits. | Manas, 2026-10-08 |
| 4 | It owns **post-call analysis and transcripts**. | Manas, 2026-10-08 |
| 5 | It owns **identity data**: users, tenants, accounts, memberships, roles, invites. | Manas, 2026-10-08 |
| 6 | **Firebase stays the same project.** A separate identity layer with proper scopes may come later. | Manas, 2026-10-08 |
| 7 | **Super-admins create tenants and add users**, using master's super-admin approach (its own login, its own console). | Manas, 2026-10-08 |
| 8 | **No credits, billing or credit enforcement in v1.** Metering is an open item. | Manas, 2026-10-08 |
| 9 | AI calling from agency is out of scope. It may be bridged later. | Manas, 2026-10-08 |
| 10 | Removal from core, master and cusui is a later project. The old path stays intact as the rollback. | brief |

**Two consequences of these decisions:**

- **Agency usage is not charged from cutover until metering ships.** Master stops receiving agency settlements, and nothing else charges for the calls.
- **"No enforcement" covers credits only.** The concurrency guard stays, because it protects agency's carrier capacity, not a balance.

## History

- **v1–v2:** core as a voice gateway.
- **v3–v3.1:** agency owns its voice engine and carrier capacity.
- **v4–v4.1:** agency owns everything, including its own Firebase project and credits.
- **v4.2:**
  - Firebase stays shared, so there is no user import.
  - Super-admin onboarding is confirmed.
  - **Credits and billing are removed from v1.** That deletes the ledger port, the balance migration and most of v4.1's money cutover. Each of those had been a source of blocking review findings.

---

## 1. What "self-sufficient" means here

```
           agent / supervisor / super-admin browsers
                          │ one origin
                          ▼
   magick-agency ── its own Postgres, Redis, S3 bucket, Mailjet sender,
   │                Gemini/OpenAI keys, VoiceLink account
   │                (Firebase: same project as MagickVoice, its own service account)
   │
   ├── console        Vite + React: agent, supervisor, team/invites, settings
   ├── super-admin    Vite + React: tenants, users, numbers, limits, settings, usage counts
   └── server         Node 22 · Fastify · TypeScript
         identity · tenancy · RBAC · invites · super-admin auth
         campaigns · roster · DNC · ingest · retry · stats · audit · notifications
         voice engine (bridge + VoiceLink) · concurrency guard · pacing runtime
         analysis worker (transcribe → analyse) · retention
                          │
                          ▼
            VoiceLink, Firebase Auth, Gemini / OpenAI, Mailjet, S3   (vendors only)
```

**No MagickVoice service is on any path.** Firebase is a shared vendor project, not a
MagickVoice service: agency verifies its tokens directly. Core and master are read once, at
cutover, by migration scripts.

### What collapses because everything is in one database

| Today | After |
|---|---|
| master DNC → core DNC sync → Redis set, plus outbox and resync | one DNC table, one transactional write |
| master CSV parse → core roster chunks over S2S | in-process ingest |
| browser → master proxy + error mask → core | browser → agency |
| core settlement webhooks → master credits | **nothing in v1** (no billing) |
| master pushes concurrency allocations to core | agency is both system of record and enforcer |
| governance overrides + core flags + master capability check | one per-account settings row + agency's flags |
| 16 error codes copied in 4 places, a 6-seam S2S fixture | one union; the fixture retires |
| campaign as a master business object plus a core execution object | one campaign |

---

## 2. Scope, measured

| Area | Comes from | Source LOC (approx.) | Port or rebuild |
|---|---|---|---|
| Agency domain, routes, repos | core `src/agency`, routes, repo | 30.6k | port verbatim; drop the attempt batcher (billing only) |
| Agency domain, routes, DNC, ingest, staffing | master `src/agency`, `src/dnc`, proxy routes | 19.8k | port, with proxies collapsed into direct calls; drop the billing contract, settlement and `credits_low` overlay |
| Agency UI | cusui | 67k | port (same stack) |
| Voice engine | core bridge, VoiceLink adapter, guard, sweeps | ~6k (+~6.4k tests) | port verbatim; delete the VoBiz, SIP and softphone branches |
| Analysis | core dialer analysis jobs, worker, runner, transcribers, analysis service, profiles, retention slice, signed playback | ~4.2k | port, re-keyed onto `agency_calls`, with the settlement step removed |
| Identity | master session, Firebase verify, `/auth/session`, tenancy, membership/user/tenant repos, invites, mailer, agent template, RBAC | ~5.3k | port |
| Super-admin | master super-admin auth and routes (tenants, users, numbers, limits, settings, flags, usage counts) + cusui super-admin pages | ~2.5k routes + ~2.5k UI | port the subset |
| Notifications, audit | master Mailjet client, engine, preferences; audit logger, vocabulary, repo, partitions | ~3k | port the subset |
| Auth and team UI | cusui `AuthContext`, auth, team, settings pages | ~5k | port |

About **145k LOC of source** in total, plus tests. The platform layer on top of the agency
code is about 18k LOC.

**Not ported:**

- The credits ledger, rate cards, settlement, top-up and `credits_low`. Metering is deferred (§3.3).
- Call-quality scores. They are AI-call only today, and agency has none.
- TTS, API keys, SIP, bulk dispatch and every AI surface.

---

## 3. Platform layer agency now owns

### 3.1 Identity and tenancy
- **Same Firebase project.** Agency gets its own service account in that project and verifies ID tokens with `firebase-admin`. The agency domain is added to Firebase's authorised domains.
  - There are no custom claims; roles come from agency's DB.
  - A user who works in both products has one Firebase login and a user row in each product's database, linked by the same `firebase_uid`. Profile edits do not sync between them.
- **Port `POST /auth/session` paths 1–3:**
  1. existing uid;
  2. a verified email matching a `pending_` stub;
  3. a re-registered uid adopted by proven email.
- **Path 4, the brand-new user, refuses** with 403 `no_membership`. Agency has no self-serve sign-up. Today path 4 auto-creates a funded tenant and a pooled number (`auth.routes.ts:29`), which agency must not do.
- **Email verification, ported exactly:**
  - path 1 deliberately admits an already-linked unverified user (`session-email.ts:28`);
  - the invite claim deliberately binds an unverified token, because that is an agent's normal first sign-in (`invites.routes.ts:442`).

  The safety net is migration `073` (`users.email_unverified`), `findByProvenEmail` and the path-1 repair `clearEmailUnverifiedIfProven`. Port all three. The rule is: **no lookup by address ever binds an unverified address.**
- **Tables:** `users` (with `073`), `tenants`, `accounts`, `memberships` (per account, including revoked), and `membership_role` with the same six roles. `agent` stays at 5, below `viewer`.
- **Tenancy middleware:** `X-Tenant-Id` / `X-Account-Id`, with the membership checks unchanged.
- **Console bootstrap** (`TenantContext.tsx:37,111-126`):
  - `GET /accounts/mine`, which agents need because `agent` sits below `viewer`;
  - the session payload's settings map (replacing `governance`);
  - the feature-flags read.
- **Invites:** `membership_invites` (sha256 token hash, expiry, claim and revoke), issue, preview, claim and resend, and the agent invite email. Tenant owners and admins keep inviting their own team.
- **Offboarding:** revoking a membership closes the agent's campaign staffing in the same place (`user.routes.ts:772,869`).
- **RBAC:** `roles.ts` with only what agency uses. That is the 7 `agency.*` keys plus `user.invite`, `audit.read`, the account read behind `/accounts/mine`, and the contact-list and feature-flag reads renamed to agency names. `credit.read` goes.

### 3.2 Per-account settings instead of governance
These sources become one agency per-account settings row:

- governance `agency.recording` / `agency.analytics`, which today are pushed into core's `account_settings.allow_recording` / `analyze_calls`;
- core's separate `analyze_dialer_calls` (`059`, gated by `107`);
- `max_concurrent_calls`;
- the `webrtc_max_duration_seconds` flag.

The section-level `agency` gate is always on, because the app *is* agency. Cutover copies
**effective** values. Recording and analysis stay checked **per field** on campaign writes
(MAG-138).

The core flags `agency_dialer_enabled`, `agency_late_binding` and `agency_call_analysis`
become agency flags with the same scopes and defaults. Super-admins can override them per
tenant and account.

### 3.3 Metering: deferred
v1 has no credits, balances, rate cards, settlement, top-up, low-balance stall or credit
enforcement. Agency writes nothing to master's ledger.

**What v1 keeps so metering can be added later without a backfill gap:** the facts are already
recorded on rows agency owns:

- `agency_call_attempts`: every dial, with `dialed_at`, `answered_at`, `bridged_at`, outcome and talk seconds. The `(dialed_at, campaign_id)` index from `081` stays.
- `agency_calls`: connected-call duration and the recording.
- `dialer_analysis_jobs`: `analysis_audio_seconds` per job.

A super-admin **usage counts** view (dials, connected calls, talk minutes, analysis minutes,
per tenant and account) is read-only and charges nothing.

**`credits_low` is removed** from the stall-code union and from the console's health-strip copy.
Leaving it declared but unproducible is the pattern `agency.md` warns about. It comes back
with metering.

**Open item: metering design.** It needs:

- what to meter (dials, connected calls, minutes, analysis);
- prepaid or postpaid;
- whether to enforce, and how;
- whether it reports into master's credits or stands alone.

Not part of this plan.

### 3.4 Super-admin console
The same approach as master: a separate login (JWT signed with its own secret, plus a
`super_admins` table), not Firebase. It covers:

- **Tenants:** create (writes a `pending_` owner stub, as master does, but no pooled number), settings, accounts.
- **Users:** add a user to a tenant or account with a role. This creates a `pending_` stub plus membership, and sends an invite. The person signs in with Firebase and is matched by session path 2 (verified email) or by claiming the invite. Super-admins can also change roles and revoke memberships.
- **Phone numbers:** the inventory and assignments for agency's VoiceLink account. Campaign `caller_ids` are validated against it when a campaign is saved, replacing core's call to master (`master-client.ts:51,83`) and its cache invalidation.
- **Concurrency limits** per account; per-account settings (§3.2); feature-flag overrides.
- **Usage counts** (§3.3), the super-admin list, and the super-admin audit trail.

Left out: SIP, bulk dispatch, dispatch lanes, AI telephony credentials, everything credits.

### 3.5 Notifications and audit
- **Mailjet with agency's own sender:** the agent invite and campaign completion (audience: holders of `agency.supervise`), with `user_notification_preferences` and `notification_deliveries` for dedupe.
- **Audit:** `platform_audit_log`, partitioned monthly, with the agency action vocabulary. One writer from now on (today core and master both write agency rows).

---

## 4. Analysis and transcripts

Port core's dialer analysis pipeline. It is already separate from AI calling, apart from the
LLM analysis service.

- **Jobs:** `dialer_analysis_jobs` with its status machine, `claim_generation` fencing and attempt ceilings. The worker runs promote → expire → claim → recover, every 60s with concurrency 2. **The settle step and settlement columns are removed**; `analysis_audio_seconds` stays for metering.
- **Runner:**
  1. Load the call from `agency_calls`.
  2. Take the config from the job's profile snapshot.
  3. Resume from an existing transcript if there is one.
  4. Otherwise fetch the recording and transcribe it in windows.
  5. Persist `conversation_log` and `transcript_meta`.
  6. Run the LLM analysis.
  7. Complete in one transaction.
- **Transcription:**
  - Gemini (`gemini-3.5-flash`, diarised JSON in 600s windows, adaptive split, truncation retry below 0.8× duration);
  - Sarvam `saarika:v2` as the optional Indian-language path.
- **LLM analysis:** agency's own copy of `analysis.service` + `prompt-builder` (OpenAI, Azure OpenAI or Gemini; JSON schema output).
- **Profiles:** `call_analysis_profiles` CRUD, presets, the dimension validator and the campaign preflight.
- **Recordings:** VoiceLink recordings are public carrier-hosted MP3s. Port the HMAC signed playback URL.
  - **Rework the fetcher.** Today it resolves carrier credentials via `telephony_credential_id` (`recording-fetcher.ts:1,68`) and fails permanently when they do not resolve.
  - Replace that with a VoiceLink recording-host allow-list.
- **Dropped:** the `dialer.analysis.*` event-bus events (no listeners) and the `analysis.completed` webhook to master (automations only). **Kept:** PostHog and LLM observability events.
- **Retention:** `AGENCY_RETENTION_DAYS`, plus `AGENCY_TRANSCRIPT_RETENTION_DAYS`, which nulls the transcript early while the analysis survives to row expiry.

---

## 5. The voice engine

**Port:**

- the bridge manager and session, and `audio-fir`;
- the VoiceLink adapter, webhook normaliser and token manager;
- the browser and PSTN socket routes and the VoiceLink webhook route;
- `PacedAudioStreamer`, `WebhookUrlBuilder` and the Redis ws-token store;
- the `carrier_media` / `webhook` rate-limit buckets and `webrtc_max_duration_seconds`;
- clip decode (`ensure-pcm-clip`, `decode`; ffmpeg in the image, clips in agency's S3).

**Port the concurrency guard whole:** global, account and provider scopes, the self-heal
reconcile, and `sweepStaleWebrtcCalls`. These are extracted from `call-manager.ts`.

**Delete** the VoBiz, `credential-seam`, `resolveSipDial` and softphone branches, and the
bridge's settlement dispatch.

**Keeping the two VoiceLink copies honest:**

- Same file layout as core, so a fix ports with `git format-patch` / `git am`.
- A byte-identical `voicelink-carrier.fixture.json` in both repos.
- A port label on core commits that touch VoiceLink or the bridge.

**Why agency needs its own VoiceLink account:** VoiceLink queues dials over its channel count
(`queuesOutboundDials`, `types.ts:499`). Two counters on one account would let AI traffic
queue an agency dial while a human sits reserved.

---

## 6. Stack and layout

- **Server:** Node 22 · Fastify · TypeScript · raw `pg` · node-pg-migrate · Vitest. One process, single replica (D2).
- **Console and super-admin UIs:** Vite + React + CSS Modules (cusui's stack), served as static files.
- **Monorepo:** pnpm workspaces.

```
magick-agency/
  apps/server/       auth, tenancy, super-admin auth, API, station WS, carrier webhooks +
                     media WS, voice engine, guard, pacing, analysis worker, sweeps, retention
  apps/console/      agent, supervisor, team, invites, settings
  apps/super-admin/  tenants, users, numbers, limits, settings, flags, usage counts
  packages/contracts/  zod schemas and types shared by server and UIs; carrier fixture
  packages/domain/     pure rules (state machine, retry, classifier, calling hours, abandonment)
  packages/db/         pg pool, repositories, one squashed baseline migration
  packages/observability/  pino + OTel, metric names unchanged
```

**Port-fidelity rule.** Move verbatim: same SQL, constants, Lua and tests. The only changes
are the collapses in §1, re-keying analysis onto `agency_calls`, and removing billing. Each
gets an equivalence test or a deletion test.

---

## 7. Decisions still needed

1. **Outstanding invites.** Only token hashes are stored, so unclaimed invites cannot move. Re-issue them at cutover (recommended) or let them expire first.
2. **Existing agency numbers:** move them to the new VoiceLink account (if VoiceLink allows), or buy new ones. A new caller ID is visible to customers.
3. **Inbound calls to agency numbers in v1:** play a message and hang up (recommended), or route to an agent (new feature).
4. **Abandon clip:** uploaded file only (recommended), or port TTS (~1.3k LOC).
5. **Platform API keys:** drop for v1 (recommended), or port.
6. **Super-admins:** create agency super-admins fresh (recommended), or copy master's `super_admins` rows.
7. **Cutover style:** whole environment or per tenant. A tenant must sit wholly in one system.
8. **Domain**, **freeze vs port tax** for agency work in the old repos, and the **rollback window** (7 days proposed).
9. **Open item, not for v1: metering** (§3.3).

---

## 8. Phases

Nothing reaches customers until Phase 10. **No master or core code changes are needed for
coexistence.** At cutover, cusui's link flips and core's flag goes off. The rollback window
needs one master **config** change: add agency's token to `PLATFORM_S2S_TOKENS` so the DNC
mirror can reuse `POST /internal/agency/dnc`.

Phases 3, 4, 5 and 7 run as **parallel lanes** once Phase 2 has fixed `packages/contracts`
and the baseline schema. Each lane builds against both, and one end-to-end test owns the
seams between them.

### Phase 0 — Decisions, vendor lead time, baselines
- Ratify §7.
- **Start everything with outside lead time:**
  - the agency VoiceLink account (ask about moving DIDs and old-account recording retention);
  - an agency service account in the existing Firebase project, plus the new domain in its authorised domains;
  - the Mailjet sender and domain (SPF/DKIM);
  - the S3 bucket;
  - Gemini and OpenAI keys;
  - domain and TLS;
  - PostHog.
- **Measure each environment:** agency tenants; users and memberships by role; outstanding invites; campaigns, contacts, attempts, DNC rows, future callbacks and DIDs.
- Freeze or port tax. Add `magick-agency` as the 4th submodule (for the carrier fixture and Grafana).
- **Exit:** decisions recorded; vendors requested; measurements dated.

### Phase 1 — Scaffold
- Monorepo, CI (typecheck, unit, integration on Docker), dev infra on unused ports (proposed Postgres 5436, Redis 6383, server 3021, console 5175, super-admin 5176), `.env.example`, Zod config that exits on invalid config.
- **Grafana:** a `local.agency` selector in `grafana/terraform/alert-rules-*.tf`; agency rules and panels re-pointed (same metric names); the validators reading agency's declarations; the billing-only agency rules retired for agency's service.
- **Exit:** empty apps green in CI; validators green.

### Phase 2 — Contracts and baseline schema
- **One squashed baseline** covering:
  - agency tables: core's agency migrations within 072–138 and master's within 050–079, re-listed from the tree. Rate cards and `agency_attempt_settlements` are excluded;
  - `agency_calls` (core `047` + `076` shape, without the settlement columns);
  - guard tables (`022`, `070`);
  - analysis jobs (without settlement columns) and profiles (`059`);
  - a clip table;
  - identity (`users` with `073`, `tenants`, `accounts`, `memberships`, `membership_invites`, `super_admins`);
  - phone inventory and assignments;
  - notifications;
  - audit (partitioned).
- Keep every trigger from 072, 073, 074, 075, 083, 086 and 112. UUID tenant/account ids, with a pre-check that every core `VARCHAR` id parses.
- `packages/contracts`: API types for every lane. `credits_low` is removed from the stall union.
- **Exit:** baseline migrates on a throwaway Postgres; trigger test (`root_contact_id`) passes; contracts typecheck.

### Phase 3 — Lane A: platform
- Identity (§3.1), settings and flags (§3.2), super-admin auth and API (§3.4), notifications and audit (§3.5), usage counts.
- **Exit:**
  - session paths 1–3 and the path-4 refusal tested;
  - the `email_unverified` repair tested;
  - invite issue, claim (including an unverified claim), expiry and revoke tested;
  - a super-admin creates a tenant and adds a user, who then signs in;
  - `roles.agent` ported (an agent reaches only the agent surfaces plus `/auth/session`, `/accounts/mine` and notification preferences);
  - the per-field recording/analysis assert tested.

### Phase 4 — Lane B: domain and data
- The pure modules and core's 7k-line repository; DNC merged; ingest, staffing, activity.
- **Exit:** unit test counts equal the source suites, minus billing tests that are deliberately deleted (listed); repository tests on real Postgres.

### Phase 5 — Lane C: voice engine
- §5.
- **Exit:**
  - ported bridge and VoiceLink tests green;
  - the carrier fixture green in both repos;
  - the guard refuses at each scope;
  - the stale sweep frees a dead session's slot;
  - one real call on the agency VoiceLink sandbox.

### Phase 6 — Runtime (after lanes B and C)
- Pacing, dialer, station registry, reaper, wrap-up, breaks, SQL-derived gauges. No attempt batcher.
- **Exit:** all chaos suites green against the fake carrier, including `restart-mid-bridge`, abandonment counter-vs-table, predicate agreement, DNC fail-closed and `bridged` ordering.

### Phase 7 — Lane D: analysis
- §4.
- **Exit:**
  - the runner's skip, resume, truncation-retry and backoff tests ported;
  - one real recording transcribed and analysed on the pilot account;
  - `analysis_audio_seconds` recorded;
  - the transcript is nulled at the transcript retention day while the analysis survives.

### Phase 8 — API
- Core's and master's agency routes merged with the platform and super-admin routes into one surface.
- **Exit:** a route-table test enumerated from the router covers every console and super-admin path.

### Phase 9 — UIs, parity and dark pilot
- **UIs:** the console (agency tree plus auth, team, invites and settings) and super-admin. Port the ~75 agency vitest files plus the platform pages' tests.
- **A new Playwright happy path:** super-admin creates a tenant and adds an owner → owner invites an agent → agent claims the invite → campaign → call → disposition → analysis → usage counts move.
- **Parity:** load a production snapshot into staging and diff old against new for stats, agent stats and exports, on a normalised projection (excluding `credits_low` and live `connected`).
- **Dark pilot** on the agency VoiceLink account with an internal tenant: late binding on and off, clip, DNC, callback, retry campaign, reconnect, restart, concurrency at the limit, analysis round trip.
- **Exit:** zero unexplained diffs; bind latency inside the 1s grace; checklist signed.

### Phase 10 — Cutover (per environment: staging → dedicated → prod)
1. **Before the window:** VoiceLink account live; DIDs on it and in agency's inventory; inbound pointed at agency; limits set; the Firebase service account and authorised domain in place; the Mailjet sender verified.
2. **Tell tenants:** a new address, the same login, and **agency calls are no longer charged** from the cutover date.
3. Pause or stop every running campaign from the old UI.
4. **Gate by query:**
   - zero `running` campaigns;
   - zero attempts with `state <> 'ended'`;
   - every session `left_at` set;
   - wrap-ups closed;
   - zero live calls with a campaign;
   - DNC outbox drained (no core `agency_dnc_outbox` rows in `pending`, `sending` or `abandoned`) and every tenant's DNC published.

   **Close the old billing cleanly before switching:**
   - call `flushCampaign` for terminal campaigns;
   - check that core's hourly buckets minus master's `agency_attempt_settlements` is empty;
   - check that no `dialer_analysis_jobs` has `settlement_status = 'pending'`.

   That way the last pre-cutover hour is billed by the old system as usual. Master's balances and ledger are not touched.
5. **Copy with UUIDs preserved:**
   - **Identity:** users selected by the set of `firebase_uid`s holding agency memberships, **never by email** (`users.email` is not unique), with the same `firebase_uid`, so nobody signs in again; tenants; accounts; every per-account membership (including revoked); notification preferences; effective per-account settings.
   - **Agency data:** core `agency_*` tables and session events; `webrtc_calls` rows with `campaign_id` into `agency_calls`, with their analysis jobs and results; master DNC, ingest jobs and staffing; clips and their S3 objects.
   - **Operations:** phone numbers and assignments for agency's account; concurrency limits; audit rows for agency (from both repos).

   **Not copied:** Redis, credits, ledger, rate cards, settlements, outstanding invite tokens (re-issued per decision 1), master super-admins (per decision 6), API keys.
6. **Verify:** counts and checksums per table; DNC per tenant and scope; a sample of users signs in; the parity diff re-run.
7. Update caller IDs per campaign if numbers changed, with the supervisor's sign-off.
8. Enable agency. "Switch to Magick Agency" in cusui becomes an external link to the new app, placed outside `RequireFlag`.
9. Turn core's `agency_dialer_enabled` off last.
10. **Rollback window (7 days):** agency mirrors every DNC change to master (needs the `PLATFORM_S2S_TOKENS` entry). The reverse copy of campaign and attempt data is rehearsed in Phase 9. Rolling back resumes the old system's billing; the usage in the window stays uncharged unless decided otherwise. After the window: forward-only.

### Later (out of scope)
- Metering and billing.
- A separate identity layer with scopes.
- AI calling from agency.
- BYO SIP and other carriers.
- Removal from the old repos:
  - core: the agency module, bridge branches, analysis agency slice, usage split and flags;
  - master: agency routes, DNC, the settlement agency paths, governance keys, the agent role and invites;
  - cusui: the agency tree, and the agency login and join pages.

---

## 9. Invariants that must survive

Each needs a ported test that fails if it breaks:

- One live attempt per contact (unique index + `SKIP LOCKED`); one running campaign per account.
- An agent is reserved before the dial; the panel is on screen before audio, with no `await` in between.
- `answered_at` and `bridged_at` live on the attempt and are never back-filled; the abandonment predicate is unchanged.
- DNC fails closed; a `halt` aborts the whole claimed batch.
- `OUR_FAULT_REDIAL_BOUND` is a ceiling; the 3% auto-pause has its single-abandon sample floor and the matching console copy.
- `agent` at level 5 reaches only the agent surfaces plus session, `/accounts/mine` and preferences.
- Recording and analysis are gated per field on campaign writes.
- **Agency dials only on its own VoiceLink account**, and its guard is the only admitter there.
- **Agency never charges, blocks or writes to master's ledger** in v1. Usage facts are still recorded for metering later.
- No lookup by address binds an unverified email; session path 4 never creates a tenant; an invite token is single use and expires.

## 10. Risks

| Risk | Mitigation |
|---|---|
| Agency usage goes unbilled indefinitely | Metering is a named open item; usage facts recorded from day one; usage-counts view |
| The old system's last hour is billed twice or never | Close old billing in the Phase 10 gate before switching |
| Shared Firebase project: a change made for one product breaks the other | Separate service accounts; agency adds only its own authorised domain; the identity layer is a named "later" item |
| A user in both products sees two diverging profiles | Documented; linked by `firebase_uid` |
| VoiceLink mapping drifts between copies | Carrier fixture, same layout, port label |
| Two engines lead one account | Phase 10 gate query; core flag off last |
| Email from a new sender lands in spam | Domain warm-up; SPF/DKIM in Phase 0 |
| Lanes ship halves that do not compose | Contracts and schema fixed in Phase 2; one end-to-end test owns the seams |
| The platform layer turns into a second master | Port only §3's subset; anything else needs a decision |
| Historical recordings expire on the old VoiceLink account | Ask about retention in Phase 0; archive to agency S3 if short |
| Alerts go silent under a new `service_name` | `local.agency` selector in Phase 1 |

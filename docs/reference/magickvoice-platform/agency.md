> **Reference copy, verbatim below this box.** Origin: MagickVoice-platform (superproject) @ `e32a5db` (HEAD, 2026-10-05), path `agency.md`. Copied into Magick Agency on 2026-10-09; not kept in sync.
>
> **How this maps to Magick Agency:** The agency dialer as it ran inside MagickVoice: product shape, domain model, agent state machine, pacing, call lifecycle, contracts, gating, supervisor surface, billing, tests. The domain rules (§1–§5, §8, §10) are what Magick Agency ports verbatim. Not applicable here: the cross-repo contracts of §6 (one process; one error-code union in `packages/contracts`, 18 members not 16, decision Q2), governance in §7.2 (replaced by the per-account settings row), and billing in §9 (no billing in v1). File paths name MagickVoice repos; `PORTING.md` maps each to its agency path.
>
> Index of all copies: [`docs/reference/README.md`](../README.md).

# Agency dialer

What the agency dialer *is*, how the machinery works, and which cross-repo
contracts you will break if you edit one repo alone. This document owns the
agency **domain**; it is a companion to two others rather than a replacement for
either. For inter-service **transport** — headers, `/proxy/*` mechanics, S2S
tokens, webhook HMAC, and the station WebSocket's close codes and buffering —
read [`service-map.md`](service-map.md), especially §5.5. For **design intent and
rationale** — why the pacing loop lives in core, why AMD is out of scope, why
`agent` sits below `viewer` — read
[`docs/agency-dialer-design.md`](docs/agency-dialer-design.md), which is the
authoritative statement of the decisions (D1–D11) this document assumes.

Everything below was read out of the source tree at core `1.81.1` / master
`2.1.1` / cusui `2.49.0` (`2026-08-28`). Where the design or delivery documents
disagree with the tree, the tree wins and the disagreement is flagged in a **doc
drift** note rather than silently corrected. Citations are
`submodule-relative-path:line` from the superproject root.

---

## 1. What the offering is

A **human-agent outbound calling product** — contact-centre shaped — layered on
the existing platform. It is a different product from the AI voice calling the
platform already sells: no AI pipeline, no prompt, no realtime model. A live
human being talks to the customer, and the platform's job is to keep that human
continuously on the phone.

The customer-facing shape:

- **Campaigns.** A named, configured unit of outbound work: caller-ID pool,
  telephony provider (or a BYO SIP trunk), calling window and days, a disposition
  catalog, a retry policy, break reasons, and optional recording / call analysis.
  One campaign per account may be `running` at a time (§2).
- **Uploaded contact lists.** A CSV, mapped column-by-column in the UI: one phone
  column, an optional timezone column, and everything else retained verbatim as
  *context* the agent sees on screen.
- **A pool of human agents.** Each agent is an ordinary platform user holding the
  new `agent` role, who opens a long-lived **station** socket and toggles
  themselves `available`.
- **Pacing.** Strictly power dialing today: one agent is reserved *before* each
  dial, so an answered call always has somebody to hand it to. The predictive
  seam exists (§4) but is not built.
- **Supervisor oversight.** A live floor: campaign controls, a health strip,
  concurrency utilisation, abandonment rate, and an agent roster ranked by risk.
- **Do Not Call.** A tenant-owned suppression list, writable by an agent for the
  number in front of them, enforced in core at dial time.

### Explicitly out of scope, by decision

**AMD (answering-machine detection) is out of scope** — design D1. Two
consequences that change how every metric reads:

1. There is **no path to a `machine` outcome**. The union has the member
   (`magic-voice-core/src/agency/contracts.ts:90`) but the classifier can never
   produce it, and says so:
   `magic-voice-core/src/agency/outcome-classifier.ts:19-22`. A call picked up by
   voicemail is `connected`.
2. The *only* signal that a call reached a machine is the **agent's
   disposition**. `voicemail` is therefore a built-in, non-removable catalog code
   (`magic-voice-core/src/agency/disposition-policy.ts:71`), retry-on-voicemail is
   driven by that disposition rather than by a carrier signal, and the supervisor
   payload reports human connects and machine connects separately so AHT is not
   silently inflated by voicemail time.

Also out of scope in v1: predictive over-dialing (`overdial_ratio` does not exist
as a column anywhere), agent-preferred callbacks (D11 — a callback returns to the
pool and *any* available agent takes it, which is why agent-facing copy must say
"we'll call you back", never "I'll call you back"), jurisdiction-specific
compliance logic (D8 — calling hours, DNC and the abandonment ceiling ship as
generic operator-configured mechanisms with neutral defaults), and multi-replica
core (D2 — the ownership seam is written and read from day one but has exactly
one local implementation).

---

## 2. Domain model and vocabulary

| Term | Means |
|---|---|
| **Campaign** | The unit of outbound work. Exists twice: as a *business object* in master (RBAC, billing, CSV, DNC, who may start it) and as an *execution object* in core (roster, attempts, sessions, the pacing loop). |
| **Contact** | One accepted CSV row on one campaign's roster. Carries `context` — every non-phone column verbatim, original headers as keys — which is what the agent screen renders. |
| **Attempt** | One dial. The audit spine: one row per dial placed, whatever happened to it. |
| **Station** | An agent's live WebSocket to core, and the anchor of replica ownership. Presence *is* the heartbeat. |
| **Agent (session)** | A durable row per (campaign, agent) pairing; the agent's *live* state lives in Redis, not in that row. |
| **Outcome** | How the attempt ended, classified from carrier/bridge signals. Core's vocabulary. |
| **Disposition** | What the *agent* says happened. Overrides the outcome-keyed retry policy whenever one is recorded. |
| **Callback** | A disposition-scheduled future attempt (`callback_at`), returning to the general pool (D11). |
| **DNC** | Do Not Call. Written master-side (`dnc_entries`), enforced core-side at dial time from a Redis set, with a durable outbox for the master hop. |
| **Abandonment** | A call the *customer answered* and no agent reached. Under power dialing this is near-unreachable, which is why it is measured and guard-railed rather than assumed away. |

### Core tables (execution state)

Migrations `072`–`090`, all under `magic-voice-core/src/db/migrations/`.

| Table / change | Migration | Notes |
|---|---|---|
| `agency_campaigns` | `072` | Execution-side campaign config. `caller_ids TEXT[]` rotated round-robin, `calling_window_start/end`, `calling_days SMALLINT[]` (ISO-8601 — `1`=Mon…`7`=Sun; `0` is **rejected** rather than read as Sunday, `magic-voice-core/src/agency/calling-hours.ts:23-28`; default `{1,2,3,4,5}`), `default_timezone`, `wrapup_seconds`, `retry_policy JSONB`, `disposition_catalog JSONB`, `context_display JSONB`, `status`. **No `concurrency`, no `overdial_ratio`** (D9). |
| `agency_contacts` | `073` | The roster. `context JSONB` (`073:36`), `state`, `attempt_count`, `next_attempt_at`, `suppressed_reason`. |
| `agency_agent_sessions` | `074` | `agent_user_id` is *master's* user id, opaque to core (`074:31`). `owner_replica`, `last_heartbeat`, `left_at`. |
| `agency_call_attempts` | `075` | One row per dial. `webrtc_call_id`, `reserved_agent_id`, `state`, `outcome`, `disposition_code`, `notes`, `callback_at`, the five timestamps, `talk_seconds`. |
| `webrtc_calls.campaign_id`, `.agency_attempt_id` | `076` | Correlation, and the **billing discriminator** (`076:5`). No FK on `agency_attempt_id` — both sides purge independently. |
| `agency_ingest_chunks` | `077` | Roster-ingest idempotency markers, inserted in the same transaction as their contact rows. |
| attempt disposition actor | `079` | `dispositioned_by_user_id`, `dispositioned_at`, `dispositioned_on_behalf` + a partial index on on-behalf dispositions. |
| small additive changes | `078`, `084`, `085` | `agency_campaigns.break_reasons` (the campaign's break-reason catalog); `agency_ingest_chunks.rejected_duplicate_rows` + `duplicate_source_rows[]` (a capped 20-row sample, recorded so a chunk replay reports the same numbers — NULL means "not recorded", deliberately not `0`); `agency_contacts.csv_line_number` (provenance only — `source_row_number` is **legacy and no longer written**, `085:12`). |
| `agency_campaigns.abandon_announcement_id` | `080` | The apology clip. NULL = hang up silently; the attempt is `abandoned` either way. |
| `idx_agency_attempts_billing` | `081` | `(dialed_at, campaign_id) WHERE dialed_at IS NOT NULL`. `dialed_at` **must** lead — the sweep is a time range across all campaigns (`081:5`). |
| `agency_contacts.our_fault_attempts` | `082` | Redials caused by *our* faults, kept separate from `attempt_count` so our failures never spend the customer's retry allowance. Bounded by `OUR_FAULT_REDIAL_BOUND` (`magic-voice-core/src/agency/retry-policy.ts:125`) — a regulated repeat-dial limit no operator config can raise. |
| `agency_contacts.row_fingerprint` + `agency_contact_row_fingerprint()` | `083` | `md5(phone + context + timezone)`, with `uq_agency_contacts_row_fingerprint` on `(campaign_id, row_fingerprint)`. Replaces `(campaign_id, source_row_number)` as the replay guard so a *second* CSV can top up a live campaign while a re-upload of the *same* file still refuses landed rows. |
| `agency_dnc_outbox` | `086` | Durable outbox for the core→master DNC mark, with claim generation, heartbeat and backoff. |
| `agency_dnc_outbox.campaign_id` | `087` | The *scope*, as a value: an id = campaign-scoped, NULL = an explicit tenant-wide escalation. **Never backfill this column** (`087:4`). Also adds `idx_agency_contacts_campaign_phone_digits`, a deliberately looser digit projection used only as a prefilter. |
| wrap-up measurement | `088` | `wrapup_started_at`, `wrapup_ended_at`, `wrapup_resolution` (CHECK: `auto_return`, `disposition_submitted`, `agent_returned`, `forced`, `agent_left`, `campaign_stopped`) + a covering index. |
| abandonment ceiling | `089` | `abandonment_ceiling_pct DOUBLE PRECISION NOT NULL DEFAULT 3`, `pause_reason` (`supervisor` \| `abandonment_ceiling`), `paused_at`, `pause_abandonment_rate_pct` (frozen at auto-pause, never recomputed). |
| `idx_agency_attempts_agent_bridged` | `090` | Covering index for the supervisor roster's `calls_handled` roll-up (MAG-153). Matches `supervisorAgents()`'s join predicate exactly — `reserved_agent_id` filtered on `bridged_at IS NOT NULL`, no state filter — and is deliberately *not* a widening of `075`'s `idx_agency_attempts_agent`. |

#### The uniqueness constraints that carry the design

```
uq_agency_campaign_running        (tenant_id, account_id) WHERE status='running'   072:33
uq_agency_agent_live              (campaign_id, agent_user_id) WHERE left_at IS NULL 074:19
uq_agency_attempt_number          (contact_id, attempt_number)                     075:27
uq_agency_attempt_live            (contact_id) WHERE state <> 'ended'               075:29
uq_agency_contacts_row_fingerprint (campaign_id, row_fingerprint) WHERE NOT NULL    083
uq_agency_ingest_chunk            (campaign_id, idempotency_key)                    077
```

**`uq_agency_attempt_live` is the one live attempt per contact rule**, and it is
the *correctness* half of the duplicate-dial protection (§4) — not the leader
lease. `uq_agency_campaign_running` is how D9's "one running campaign per
account" is enforced; it is one index and is trivially lifted later.

> **Doc drift.** `docs/agency-dialer-design.md` §4.1 originally cited an index
> named `uq_agency_contact_in_flight`. It does not exist, and the design doc's own
> header now says so. The real backstop is `uq_agency_attempt_live`.

### Master tables (business state)

| Table / change | Migration | Notes |
|---|---|---|
| `dnc_entries` | `050` | `tenant_id`, nullable `account_id` and `campaign_id` (NULL = wider scope), `source` CHECK (`agent`\|`import`\|`api`\|`regulator`), `added_by`. `uq_dnc_scope` uses `COALESCE(..., '000…0'::uuid)` so scope tiers cannot collide. `idx_dnc_entries_tenant_phone` is the per-number lookup path (pinned by a test, MAG-102). |
| `membership_role` gains `agent` | `051` | `ALTER TYPE membership_role ADD VALUE 'agent'`. |
| agency rate cards + `agency_attempt_settlements` | `052` | Two rate rows and the attempt-batch ledger. See §9. |
| `agency_ingest_jobs` | `053` | The CSV ingest job: `s3_key`, `phone_column`, `timezone_column`, `ignore_columns[]`, `dedupe_phones`, `dry_run`, progress counters, `rejected_s3_key`, `headers[]`, `context_columns[]`. |
| `dnc_sync_state` | `054` | Per tenant: `version` and `published_version`, with `CHECK (published_version <= version)`. The watermark core's resync loop closes over (§6). |
| ingest rejection detail | `055`, `056`, `059` | Core-side rejections threaded back, plus a rejection-uncertainty flag and its backfill. |
| `agency_ingest_jobs.mode` | `057` | `append` (default) or `replace`, plus `replace_superseded_contacts`. Recorded per import because **only master holds the operator's intent** — core cannot tell a correction from a top-up. |
| replace uncertainty | `058` | |

---

## 3. The agent state machine

Six states, `magic-voice-core/src/agency/contracts.ts:50-56`, mirrored in the
`ck_agency_agent_state` CHECK (`074:16`).

```
                       ┌────────────────────────────────────────────┐
                       │                                            │
   (socket opens)      ▼                                            │
  ┌──────────┐   /available    ┌───────────┐   pacing tick     ┌────┴─────┐
  │ offline  │───────────────► │ available │──── CAS reserve ─►│ reserved │
  └──────────┘                 └───────────┘                   └────┬─────┘
       ▲                        ▲    ▲   ▲                          │
       │                        │    │   │                    carrier answers
  socket close /                │    │   │                    + media bridged
  /leave / lease lapse          │    │   │                          │
       │                        │    │   │                          ▼
       │              /break/cancel  │   │                    ┌──────────┐
       │              (queued break) │   │                    │ on_call  │
       │                        │    │   │                    └────┬─────┘
       │              ┌─────────┴──┐ │   │                         │ hangup
       │              │   break    │ │   │                         ▼
       └──────────────┤ (+reason)  │ │   │                   ┌──────────┐
                      └─────▲──────┘ │   └───────────────────┤  wrapup  │
                            │        │    disposition, or    └────┬─────┘
                        /break       │    auto-return             │
                     (immediate or   └────────────────────────────┘
                      after wrap-up)      wrapup lapse (reaper)
```

Reservation is **always strictly before the dial**
(`magic-voice-core/src/agency/agent-state-machine.ts:113-118`), which is what
makes "answered call with no agent" unreachable under D1 except through the agent
physically disappearing.

### Redis is the authority, the DB row is a mirror

`agency_agent_sessions` is a durable mirror written alongside the Redis hash and
is what a reconnecting agent is rehydrated *from* — but the pacing tick must
never count an agent as available because a DB row says so
(`agent-state-machine.ts:95-102`, and the read in `pacing-engine.ts:548-560`).
The hash is `agency:agent:{sessionId}:state` with fields `state`, `attempt`,
`since`.

Three Lua scripts, and the shapes matter:

- **CAS** (`agent-state-machine.ts:18`) — `HGET state ≠ expected ⇒ return 0`. No
  read-then-write, so there is no window in which two attempts hold one agent. A
  `0` is a *normal* outcome (another tick got there first), not an error.
- **SET** (`:31`) — unconditional, for transitions already authorised (a join, an
  agent clicking available, a forced release). Still writes a TTL, because an
  agent state with no lease is an agent nothing can detect the death of.
- **RENEW** (`:46`) — `EXISTS` first, **and** the state must still match. A renew
  that resurrected an expired key would bring a dead replica's agent back to life
  in whatever state they were last in, and the engine would dial into them.

`since` is written by CAS and SET and deliberately **not touched by renew**,
which is what makes it a usable idle clock: an agent sitting `available` for ten
minutes has their lease renewed every 10s while `since` stays put
(`:184-193`). The pacing tick's fairness ordering sorts on it.

### Lease TTLs — liveness detectors, never business timers

`AGENT_LEASE_MS`, `agent-state-machine.ts:68-82`:

| Key | ms | Renewed by |
|---|---|---|
| `reserved_predial` | 10 000 | **nothing** — the dial must be prompt |
| `reserved_dialing` | 15 000 | the owning replica, every 5s |
| `on_call` | 15 000 | the owning replica, every 5s, tied to the live session |
| `wrapup` | 15 000 | the station heartbeat, exactly as `available` is |
| `available` | 45 000 | the station socket heartbeat (10s ping, 3 misses) |
| `break` | 45 000 | the station socket heartbeat |
| `renew_interval` | 5 000 | — |

**`reserved` is split in two on purpose.** A single 20s lease covering the whole
dial expires mid-ring on a 25s call: the agent flips back to `available`, the
next tick reserves them elsewhere, and then the original contact answers with
nobody to bridge to — a structurally abandoned call produced by the mechanism
meant to prevent abandonment (`:62-66`).

The invariant (`magic-voice-core/src/agency/timers.ts:1-23`): **a Redis TTL only
ever expires when the thing renewing it is gone.** A TTL cannot distinguish "took
too long" from "the process died", and every value in the lease table reaches
`PEXPIRE` by construction — so a business duration that lands there silently
becomes a TTL, and the first symptom is a customer answering with no agent on the
line. Business durations live in `timers.ts` (an imports-nothing leaf module) plus
a column on the attempt row:

| Constant | Value | What it is |
|---|---|---|
| `DEFERRED_HANGUP_MS` | 8 000 | How long a live call is held open after the station socket drops, waiting for the *same* session to re-adopt it. Bounded by the customer's patience, not the agent's — they hear silence for the whole window (`timers.ts:25-39`). |
| `ABANDONMENT_REFRESH_MS` | 60 000 | Republish cadence for the rolling window — **not** the window, which is 24h and lives in SQL. |
| `ATTEMPT_BATCH_SWEEP_MS` | 60 000 | Billing sweep poll cadence, and also the redelivery interval. |
| `DNC_OUTBOX_SWEEP_MS` | 15 000 | Fastest sweep in the file, deliberately: every interval it waits is another interval some campaign can dial a customer who asked not to be. |
| `DNC_OUTBOX_STALE_CLAIM_MS` | 120 000 | When a `sending` outbox row is treated as stranded by a dead replica. ~24× the 5s forward timeout, chosen to be obviously safe rather than tuned. |

`test/unit/agency/agent-state-machine.test.ts` pins both halves — the lease
table's key set, *and* that no value from `timers.ts` appears in it.

### Station ownership, heartbeats and reaping

`magic-voice-core/src/agency/station-registry.ts`. The station socket is the
anchor of ownership: whatever replica accepts it writes
`agency:station:{sessionId}` with a **30s TTL** (`:9`) and renews it from the
socket's own `ping` (`:81-87`). Socket closes or heartbeat lapses ⇒ key expires ⇒
the agent is not available anywhere. Under D2 the key always resolves to us; it
is written and read anyway so "dial only on the owning replica" is exercised
continuously rather than rotting until someone needs it (`:29-35`).

Two subtleties worth knowing before you touch this file:

- `attach` supersedes a prior socket for the same session and closes it, and
  `detach` refuses to evict a socket that has already replaced it (`:52-75`) — a
  reconnect racing the old socket's close is the normal case.
- `ownerOf` maps a Redis fault to `null`, the same value it uses for "no key".
  That is correct for every dial-path guard (fail-safe) and *wrong* for the
  supervisor floor, so `connectedBySession` **throws** instead and the route maps
  that to `connected: null` = unknown (`:118-162`). Distinguishing the two is the
  whole point of the method (MAG-148).

**What reaps a stale station:** `magic-voice-core/src/agency/reaper.ts`, on a 60s
cadence (`SWEEP_INTERVAL_MS`, `:14`). It covers the crash-recovery cases the leases alone cannot — a lapsed
`reserved`/`on_call` lease with a live attempt row, an attempt stranded by a
replica restart, and lapsed wrap-up (which is deliberately
campaign-status-agnostic, `docs/agency-dialer-design.md:1108`). Note D2's
operational consequence: **a core restart drops every live bridge and every
station socket**, so sessions are rehydrated from `agency_agent_sessions` on
reconnect and agents land in `break`, not `available`, so the engine cannot dial
into a pool that has not actually re-attached.

---

## 4. The pacing engine

`magic-voice-core/src/agency/pacing-engine.ts` (1239 lines). One authoritative
leader per campaign.

```
TICK_INTERVAL_MS      250     leader evaluates a campaign 4×/second
SUPERVISE_INTERVAL_MS 2 000   a replica tries to take leadership of campaigns it does not lead
LEADER_LEASE_MS       15 000
LEADER_RENEW_MS        5 000   renewed at a third of its length
```
(`pacing-engine.ts:26-31`)

### Two independent safety mechanisms

Stated at `pacing-engine.ts:100-110`, and the distinction is load-bearing:

- The **Redis leader lease** is the *efficiency* mechanism. It stops N replicas
  doing the same work. `RENEW_LEASE` (`:36`) renews only if we still hold it —
  losing leadership and re-taking it by blind `SET` is how two leaders end up
  dialing one campaign.
- **`FOR UPDATE SKIP LOCKED` contact claiming plus `uq_agency_attempt_live`** is
  the *correctness* mechanism. Even during a split-brain window (GC pause,
  partition, clock skew) two leaders cannot dial the same contact.

**Never treat the lease as the thing that prevents double-dialing; it is not, and
it cannot be.** A third guard sits on top: `revoked` is a set of campaigns whose
leadership was given up while a tick may still be in flight, checked at every
await boundary a dial could follow (`:118-124`, `:529-531`), so a tick that
outlived its lease cannot place a call.

### The tick

```
idle     = agents in `available` on this campaign      (busy agents excluded)
occupied = ALL non-terminal attempts on the campaign   (a bridged call still holds a slot)
to_dial  = MAX(0, MIN(account.max_concurrent_calls − occupied, idle))
```
(`pacing-engine.ts:436-440`)

`to_dial == 0` **is** the paused state, and the same expression resumes it — so
there is no pause flag anywhere that can be left stale. Pause at zero available
agents is not a special case; it is `idle = 0`.

**The two terms bound different quantities and must not be subtracted from one
another.** `accountLimit` caps *total* concurrency, so `occupied` counts against
it; `candidates.length` caps *new* dials, because only an idle agent can take one.
The engine previously computed `MIN(accountLimit, idle) − occupied`, which charged
every busy agent twice and gave `1 − 1 = 0` for *every* value of `accountLimit`
with two agents and one on a call. The staging trace is preserved at `:582-621`.

Order of operations inside a tick (`tickOnce`, `:456`):

1. Load the campaign. If the status changed since the last tick, **announce it to
   the floor** — idle agents are outside every per-attempt frame's reach. The
   discriminator is `pause_reason`, not the status: `paused` by a supervisor and
   `paused` by the abandonment guardrail are the same status and very different
   messages to a human (`:466-486`).
2. **Refuse before reserving anything** if `usableCallerIds(campaign).length === 0`
   (`:509`). Discovering an empty pool inside `dialUpTo` produced a
   4-claims-per-second spin, restamped every agent's `availableSince` (collapsing
   the fairness ordering) and emitted ~345k unthrottled error lines a day. Note
   `usableCallerIds`, not `caller_ids.length` — a stored `['']` is length 1 and
   dials nothing.
3. `planTick` (`:548`): live sessions → locally-owned stations → Redis state →
   the `available` ones, **sorted longest-idle first** (ties on session id, so a
   tick is reproducible) → `to_dial`.
4. `dialUpTo` (`:626`): **reserve agents first, strictly before claiming any
   contact**, so a lost CAS costs one Redis call and touches nothing durable.
5. `claimDialable(campaign.id, reserved.length)` — exactly as many contacts as
   agents held; surplus agents go straight back to the pool.
6. **Pre-dial gates** (`pre-dial-gates.ts`), after the claim and *before the
   attempt row exists*, so suppressing costs nothing to unwind. A `halt`
   (e.g. `dnc_unavailable`) aborts the **whole claimed batch** — whatever stopped
   us answering for this number cannot answer for the others either, and dialing
   the rest is the fail-open-at-volume this gate exists to prevent.
7. Create the attempt, dispatch through `DialDispatcher`.

**Unclaim rules.** Every abort path returns the contact via
`agencyContactRepository.unclaim(contact.id, when)`: `gate.deferUntil` for a
calling-hours deferral (`:725`), `new Date()` for suppression, a missing station,
the duplicate-dial backstop, and dispatch failure (`:732`, `:778`, `:804`,
`:825`). The repository's own doc warns about the spin an unconditional
`unclaim(now())` produces — which is why the caller-ID check moved *above* the
reservation.

**Idle reasons are a closed metric label** (`:96`):
`no_agents` | `no_slots` | `no_contacts` | `no_reservations` | `no_caller_ids`.
The first four are benign states a healthy campaign spends most of its day in;
`no_caller_ids` is a misconfiguration that cannot clear without a human, and it
is a label rather than a log line precisely because "why is this campaign placing
no calls" is the question it answers.

**Reserved is deliberately not mirrored to the DB** (`:645-670`). Every release
path returns the agent through Redis alone, so a mirrored reservation would be
write-only: an idle agent on a campaign with nothing dialable would be reserved
and released every 250 ms while the supervisor's breakdown showed them stuck at
`reserved`. `setState` would also restamp `state_since`, the anchor the
supervisor's risk ordering sorts on. `on_call` *is* mirrored — the release path
mirrors the return.

### Where the concurrency knob lives, and who can edit it

`account_settings.max_concurrent_calls`, read per tick by
`accountSettingsRepository.getMaxConcurrentCalls`
(`magic-voice-core/src/db/repositories/account-settings.repository.ts:112`). The
telephony concurrency guard remains the *authority*; the tick target is an
optimisation that avoids burning reservations on calls the guard would refuse.
Because agency legs share that counter with AI calls, an account cannot exceed
its ceiling by running both.

**Verified: it is still super-admin only (D10 holds).** The only write path is
`magick-master/src/api/routes/super-admin.routes.ts:999-1040`, which proxies to
core's `PUT /internal/account-concurrency`. There is no `/proxy/account-settings`
route and no tenant-facing route was added — a repo-wide search for
`max_concurrent_calls` in master turns up the super-admin tree, the
`phone_numbers` per-number limit, and provider entitlements, and nothing under
`/proxy`. The supervisor console therefore renders the limit **read-only** with
live utilisation against it; raising it is a conversation with the platform
operator.

One guard worth knowing (MAG-146): a degraded concurrency read must never invent
saturation. `saturated()` requires `limit > 0`
(`magic-voice-core/src/agency/campaign-health.ts:127`), so a limit of `0` reads
as "no known ceiling", never as a full pipe. Pinned by
`test/unit/agency/campaign-health.test.ts:177` and
`test/unit/agency/campaign-stats-concurrency-guard-route.test.ts`.

---

## 5. Call lifecycle, end to end

```
 SUPERVISOR                MASTER                     CORE                          CARRIER / AGENT
 ──────────                ──────                     ────                          ───────────────
 POST /campaigns/:id/start ─┐
   (RBAC agency.supervise)  │
                            └─► /proxy/agency/campaigns/:id/start ──► POST /api/v1/agency-campaigns/:id/start
                                                                     status draft|paused → running
                                                                     (roster-gated)
                                                                            │
                                                     supervise pass (2s) ───┤ takes the leader lease
                                                                            │
                                                     TICK (250ms) ──────────┤ planTick: idle agents,
                                                                            │ occupied, to_dial
                                                                            │
                                                     reserve ───────────────┤ CAS available→reserved
                                                                            │ lease reserved_predial 10s
                                                                            │
                                                     claim ─────────────────┤ FOR UPDATE SKIP LOCKED
                                                                            │ contact → in_flight
                                                                            │
                                                     pre-dial gates ────────┤ DNC · calling hours ·
                                                                            │ suppression  (before the
                                                                            │  attempt row exists)
                                                                            │
                                                     attempt row created ───┤ state=queued
                                                                            │
                                                     ┌──────────────────────┤ AgencyDialer.executeDial
                                                     │ 1. re-check lease    │
                                                     │ 2. `reserved` FRAME  ├──────► agent screen:
                                                     │    SYNCHRONOUSLY,    │        full contact context
                                                     │    BEFORE the dial   │        + 3-2-1 countdown (D5)
                                                     │ 3. CAS reserved→     │
                                                     │    reserved, lease   │
                                                     │    reserved_dialing  │
                                                     │ 4. createBridgedCall ├──────► carrier dial
                                                     └──────────────────────┤
                                                                            │◄───── answered
                                                     answered_at stamped ───┤       (abandon DECISION is
                                                                            │        taken here, before
                                                                            │        any await)
                                                                            │◄───── media bridged
                                                     bridged_at stamped ────┤       agent on_call
                                                                            │       ══ TALK ══
                                                                            │◄───── hangup (either side)
                                                     classify outcome ──────┤
                                                     wrapup_started_at ─────┤       agent → wrapup
                                                                            │
                                                                            │◄───── POST /attempts/:id/disposition
                                                     disposition policy ────┤       (actor required)
                                                                            │
  ◄── settlement webhook ◄─ POST /webhooks/core/webrtc-completed ◄──────────┤
      (campaign_id present ⇒ flat agency rate)                              │
                                                     retry or terminal ─────┤ contact → pending
                                                                            │ (next_attempt_at) or
                                                                            │ completed/exhausted/suppressed
```

### The same lifecycle under `agency_late_binding`

The flag (§7.3) moves **where the agent joins**, and nothing else. The tick, the
reservation, the claim, the pre-dial gates, the attempt row and the settlement are
identical; the two DELTAS are:

```
   executeDial                        │ 1. re-check lease
                                      │ 2. build the panel — priors read AND ALL —
                                      │    but HOLD it. Nothing on the wire.
                                      │ 3. CAS reserved→reserved, reserved_dialing
                                      │ 4. createUnboundBridgedCall ──► carrier dial
                                      │        (no browser socket at all)
                                      │
   ══ the phone rings. The agent's console shows NOTHING. ══
                                      │
                                      │◄───── answered
   SYNCHRONOUSLY, before any await ───┤
     agent still there?               │
       no  → the abandoned path (§6.2, unchanged)
       yes → `reserved` FRAME ────────┼──────► agent screen: full contact context
             bindBorrowedBrowserLeg ──┤        then `bridged`, same turn
                                      │        ══ TALK ══
```

Consequences worth stating because each is a behaviour someone will look for:

- **A dial that rings out, is busy, fails or finds an unreachable handset names
  itself to the console nowhere** — no `reserved`, no `released`, no `bridged`, no
  `missed_release`, and no resumable `active_attempt`. The `ended` arm suppresses
  the `released` frame (and the missed-release record) when no panel was delivered:
  an agent who was never shown a call must not be told it ended. Nothing announces
  the reservation either — `agents.transition` sends no frame, and the pacing
  engine's only frame is the campaign-level `campaign_state` broadcast.

  **It is not literally silent, and the precise version matters.** Exactly one
  frame arrives: `agent_state` with `state: 'available'`, from `releaseAgent` at the
  end of the `ended` arm. That is deliberately not suppressed. It carries no
  `attempt_id`, it changes nothing on screen (the console has been showing
  "Available" throughout, because the reservation was never announced), and it is
  the **only** delivery path for a break the agent queued mid-ring — `releaseAgent`
  is the single place a queued break is applied and that frame is what carries
  `break_reason`. Suppressing it would silently drop the agent's own break request.
- **`reserved` and `bridged` arrive in that order, in one turn.** The bind emits
  `bridged` synchronously, so the `bridged` handler runs **re-entrantly inside** the
  `answered` arm and `live.state` is already `'bridged'` when control returns there.
  That is the design, not an accident of scheduling.
- **A station socket reconnecting mid-ring is offered nothing.**
  `reattachStation` returns `null` for an attempt that has not been bound, and the
  bridge's `reattachBorrowedBrowserLeg` independently refuses a leg that was never
  bound ("nothing to resume onto"). Without both, a reconnect would be joined to a
  ringing call and the console would render the very panel this flag removes. No
  resumption is needed: the `answered` arm reads `socketFor(sessionId)` fresh, so it
  binds to whatever socket the registry holds by then.
- **`POST /sessions/:id/leave` still refuses** while an unbound dial is in flight,
  with copy that admits the agent cannot see it. Allowing the leave would
  manufacture an abandoned call when the dial answers, and on a carrier that cannot
  cancel a ringing leg there is no way to prevent that; the wait is bounded by the
  ring timeout. Cancelling the dial and allowing the leave is the better answer, and
  it becomes available only once the carrier can cancel a ringing leg.

### The parts that are easy to get wrong

All five live in `magic-voice-core/src/agency/agency-dialer.ts`.

- **Context reaches the screen before the agent hears audio, synchronously — and
  the flag decides which moment that is.** With `agency_late_binding` off,
  `executeDial` re-checks the lease, writes the `reserved` frame straight to the
  socket, and only then dials; if the frame cannot be delivered the attempt is
  abandoned before the dial rather than placed. With it on, the same frame is built
  at dial time and written at the **answer**, immediately before the bind and in the
  same synchronous run. The guarantee does not weaken, it relocates: in both modes
  there is no `await` between the panel reaching the wire and the agent's audio path
  existing. Dialing first, or emitting `reserved` from a `.then()`, would still pass
  a naive test and still leave an agent looking at an unknown caller.
- **The lease is re-asserted immediately before `createBridgedCall`** — a CAS
  `reserved → reserved` that upgrades to `reserved_dialing`; `false` means the
  agent went away and the dial is abandoned (`:206-222`). Without it the dial "went
  out regardless", recreating exactly the failure the lease split prevents.
- **The lifecycle listener is registered before the dial**, because a carrier can
  answer inside `createBridgedCall` on a fast trunk (`:228-230`).
- **`answered_at` and `bridged_at` are stamped independently, never back-filled** —
  making them the same instant by construction makes the abandonment predicate
  vacuous (`:328-345`).
- **The abandon decision is taken synchronously, before any await** (`:349-356`),
  because `bridged` follows `answered` in the same turn on a fast carrier and
  lifecycle listeners are fire-and-forget.

### The abandoned path and the apology clip

An abandoned agency attempt is one the customer **answered** and no agent
reached. `agency_campaigns.abandon_announcement_id` (migration `080`) names the
clip; NULL means hang up silently, and the attempt is recorded `abandoned` either
way. The clip is resolved by
`magic-voice-core/src/agency/abandon-clip.ts`.

"Abandoned" is defined in a leaf module with no imports at all,
`magic-voice-core/src/agency/abandonment-predicate.ts`, so the SQL half and the
in-process half live beside each other. `ABANDONMENT_BRIDGE_GRACE_MS = 1000`
(`:19`), `ABANDONMENT_WINDOW_HOURS = 24` (`:22`), and
`ABANDONED_ATTEMPT_PREDICATE_SQL` (`:44`) is the single definition — exported so
the metric's numerator and any audit query are the *same* predicate. It adds
`state = 'ended'` to the test plan's written predicate (`:33-42`): without a
terminal filter, live traffic inflates the rate in real time and the auto-pause
fires on healthy campaigns at concurrency, so **QA's cross-check query must match
this** or the two disagree for a reason that is not a bug. The in-process twin
agrees only on the arms they share — `state = 'ended'` has no counterpart in
process (`:66-73`).

**Auto-pause**: `magic-voice-core/src/agency/abandonment-guardrail.ts` pauses a
campaign over `abandonment_ceiling_pct` (default 3), writing
`pause_reason = 'abandonment_ceiling'` and freezing
`pause_abandonment_rate_pct`. It pauses out-of-band from the abandonment refresh
and **announces nothing itself** — the pacing tick is the only thing that tells
the floor, which is why `pause_reason` and not a flag is the discriminator.

### Outcome classification

`magic-voice-core/src/agency/outcome-classifier.ts`. The union is
`connected | no_answer | busy | failed | machine | invalid | abandoned |
agent_disconnected | orphaned | canceled` (`contracts.ts`) — richer than the five
most docs list, and `machine` is unreachable (§1).

**`classifyAttemptOutcome` takes `answered` and `bridged` as two required
parameters, and until the 2026-09-08 pilot it took one.** It had a single `bridged`
flag and every caller fed it the carrier's `answered` — `agency-dialer.ts`'s `ended`
handler passed `bridged: ev.answered` verbatim. Those are different facts (the
abandonment definition is precisely the gap between them) and conflating them was
wrong in **both** directions at once, which is why that pilot's "33 bridged / 32%
bridge rate" is unreadable rather than merely imprecise:

- a ring an agent cancelled (`status: 'canceled'`, never answered) got
  `bridged: false` and fell to the `canceled` arm's `abandoned` — the phantom
  abandoned rows, dials no customer ever heard;
- a call the customer answered that reached no agent (`status: 'completed'`,
  answered, no bridge — traced on callId `064836f1-8915-49f8-9c5a-c741f3cdd2af`)
  got `bridged: true` and came out `connected`, and was billed as a conversation
  nobody had.

Both parameters are **required** deliberately: an optional `answered` would let
exactly the old call site keep compiling, and the compiler is the only thing that
can force a caller to say which fact it holds. `bridged` must come from the
bridge's own stamp (`live.bridgedAt !== null`), never re-derived from a status.

The classifier now **agrees with** `ABANDONED_ATTEMPT_PREDICATE_SQL` (answered and
not bridged) instead of contradicting it. That moves no metric: the compliance
numerator is keyed on `isAbandonedAttempt` — the predicate itself, never this
function's return — so `agency_abandoned_total` reads identically before and
after. What changes is the outcome *string*, and with it which retry rule the
contact gets and which sentence the agent is shown.

Order matters, and each early return is load-bearing:

| Signal | Outcome | Why it short-circuits |
|---|---|---|
| `outcome === 'agent_disconnected'` | `agent_disconnected` | Our fault, not the customer's; must not be retried as a bad number. |
| `outcome === 'orphaned'` | `orphaned` | |
| `outcome ∈ {service_shutdown, system_rebooted, stuck_active_call}` | `orphaned` | A teardown the SERVICE initiated is the reaper's `orphaned` fact arriving in the bridge's vocabulary. Without this arm all three fell through to the status switch and came out `failed` — i.e. the *customer's* ledger, 2 attempts, for our own restart. `releaseMessageFor('orphaned')` already read "The call was interrupted by a service restart"; the copy pre-dated the classifier being able to produce it. `max_duration_reached` is deliberately NOT here despite sharing the `system` analytics dimension: that call was answered, bridged and billed — cut short, not lost. |
| `outcome === 'abandoned'` | `abandoned` | **Load-bearing, not defensive.** The customer answered, so `bridged` is true and the `completed`/`canceled` arms would both say `connected` — reporting a call nobody spoke on as a successful conversation, landing it in the connect rate, and zeroing the abandonment numerator in the one direction nobody would notice. |
| carrier says invalid / unallocated / not in service / no_route | `invalid` | Permanently bad; the retry policy treats it as terminal (`max_attempts 0`). Deliberately conservative — anything ambiguous stays `failed`, because a false `invalid` permanently suppresses a real customer. |
| `status = no_answer` \| `busy` | same | |
| `status = completed` | bridged → `connected`; answered, unbridged → `abandoned`; neither → `no_answer` | The middle arm is the `064836f1` shape: a customer who spoke to nobody, ending `completed` with real talk time, so status and duration both read "connected" and only the missing `bridged_at` says otherwise. |
| `status = canceled` | bridged → `connected`; answered, unbridged → `abandoned`; neither → `canceled` | The third arm is what `canceled` was missing: a teardown that beat the pickup. Nobody was reached and nobody was inconvenienced, so it is neither `no_answer` (the ring never got its chance) nor `abandoned` (nothing was abandoned). |
| `status = failed` / default | `failed` | |

**`canceled` is charged to the our-fault ledger, not the customer's.** The `ended`
handler's gate is `(agent_disconnected | canceled) && bridged_at IS NULL`, so a
cancelled dial goes to `agency_contacts.our_fault_attempts` and
`resolveOurFaultRedial`, bounded by `OUR_FAULT_REDIAL_BOUND` — a ceiling an
operator can only lower. That is the *more* conservative option on both axes at
once: it does not retire a customer we never reached, and it bounds repeat-dialling
below anything a `retry_policy` could authorise. `DEFAULT_RETRY_POLICY.canceled`
exists but **no live path reads it** — `resolveOurFaultRedial` consults only the
campaign's own policy — so it is a fail-safe against the `no_policy_for_outcome`
branch (which marks a contact `completed`, retiring someone nobody spoke to) rather
than a rule. It is deliberately kept for that reason, and deliberately documented
as unread; contrast `machine`, whose absence is safe because it is unproducible.

`canceled` adds **no** `AgencyReleaseReason` member. Under `agency_late_binding`
there is no agent to explain a cancelled ring to — the `ended` arm suppresses the
whole `released` frame when no panel was delivered — and with the flag off the only
producer is the agent's own hangup, which `agent_hangup` already covers ("You ended
the call."). A new reason would be a fifth mirror (§6.2) bought for a frame that is
either not sent or already correct.

### The route surface, in one place

Registered in `magic-voice-core/src/index.ts:478-485`. Master's mirrors and the
transport details are in [`service-map.md`](service-map.md) §5.5; the *exact*
registered set on master's side is asserted executably by
`magick-master/test/unit/agency/proxy-agency-route-table.test.ts` (§6.4) — trust
that test, not a grep.

| Core prefix | Routes |
|---|---|
| `/api/v1/agency` | `GET /station/:sessionId` (WebSocket, registered **outside** the authenticated scope — core mints its own single-use token, `agency.routes.ts:71`) · `POST /sessions` · `POST /sessions/:id/station-token` · `/sessions/:id/{available,force-available,break,break/cancel,leave}` · `/attempts/:id/{hangup,disposition,dnc,notes}` |
| `/api/v1/agency-campaigns` | `POST /` · `GET /` · `GET /:id` · `PATCH /:id` · `GET /:id/stats` · `POST /:id/{start,pause,resume,stop}` |
| `/internal` | `POST /agency-campaigns/:id/contacts` (roster ingest) · `POST /agency/dnc-sync` · `GET /agency/dnc-sync/:tenantId` |

Two notes on the internal plugin. `agencyDncRoutes` is registered as a **sibling**
of `internalRoutes` under the same `/internal` prefix, and Fastify encapsulation
means a sibling inherits **none** of that plugin's hooks — which is how the roster
ingest route once shipped unauthenticated. The handler takes `tenantId`/`accountId`
**from the campaign row**, so a campaign UUID was the entire credential, and rows
written there are dialed: the reachable outcome was making another tenant place
real calls to attacker-chosen numbers from their caller ID, billed to them. Root
`CLAUDE.md` names this exact trap and it happened anyway, which is why
`test/unit/agency/agency-internal-auth.test.ts` asserts the unauthenticated request
is refused **and** that no row is written
(`magic-voice-core/src/api/routes/agency.routes.ts:1085-1107`).

Campaign control notes: `/start` is roster-gated and `/resume` deliberately is not
(a resume follows a pause the supervisor just issued, and a campaign that drained
while paused is finalized by the leader on its first tick). `/stop` returns `200`
meaning **"accepted and draining"**, not "stopped" — the leader finalizes to
`stopped` on its next idle tick, so clients must not assert terminal state from
that response. `/pause` and `/stop` are **ungated** by the feature flag: turning
the flag off must not take the off button away.

### Retry, disposition and terminality

- `DEFAULT_RETRY_POLICY` (`retry-policy.ts:51`) is keyed by **outcome**;
  `agency_campaigns.retry_policy` overrides it per key.
- A **disposition always overrides** the outcome-keyed policy; the outcome policy
  applies only when no disposition was recorded (`contracts.ts:110-114`).
- Three codes are built in and cannot be removed from a catalog
  (`disposition-policy.ts:71`, `:97`) — `voicemail` among them (§1).
- `OUR_FAULT_REDIAL_BOUND = 3` and
  `DEFAULT_OUR_FAULT_REDIAL_DELAY_MINUTES = 5` (`retry-policy.ts:125-128`) bound
  redials caused by *our* faults, tracked in `agency_contacts.our_fault_attempts`
  so they never spend the customer's retry allowance. The bound is a hard ceiling
  no campaign config can raise.
- **An empty disposition catalog used to park every contact in `connected`** —
  fixed in core `035e3d0`, and worth remembering as the shape of bug this area
  produces.

---

## 6. Cross-repo contracts — read this before editing one repo

This is the section that matters most. Every item here is a pin that the
compiler cannot see, and every one of them has already been broken at least once.

### 6.1 `agency-s2s-contract.fixture.json` — the contract as data

Committed **byte-identically** in both backends:

```
magic-voice-core/src/agency/agency-s2s-contract.fixture.json    350 lines
magick-master/src/agency/agency-s2s-contract.fixture.json       same bytes (md5 verified)
```

Each repo's `test/unit/agency/s2s-contract.test.ts` asserts two things:

1. **its own implementation against its own copy** — the value;
2. **that its copy matches the sibling's**, resolved four levels up from the test
   file (`magic-voice-core/test/unit/agency/s2s-contract.test.ts:52-57`), i.e.
   `<superproject>/magick-master/src/agency/…`.

Assertion (2) therefore only runs from **inside this superproject**, and
`describe.skipIf(!siblingAvailable)` skips it loudly in a standalone clone
(`:512-540`) — a missing sibling is a checkout shape, not a defect. Without (2), a
repo could edit its own copy to match a unilateral change and stay green, which is
the failure being prevented, one indirection out.

**Why a file rather than a better test** (the fixture says it at `:13-19`): every
defect it exists to catch was invisible to two green suites. Each service tested
against its own idea of the contract, both were internally correct, and *together*
they described a system that could not work. A shared artefact is the only thing
both sides can be wrong *about*. Core's suite cannot import master's module, so
this is data, not code.

**What it would have caught, per its own comments** (`:21-25`):

| Ticket | Defect |
|---|---|
| MAG-117 | master sent DNC `version` as a string, core validated `z.number()` — **no campaign could dial** |
| MAG-118 | master's session-create schema omitted `agent_user_id`, Zod stripped it, core 400'd — **no agent could join** |
| MAG-112 | master proxied hangup with **no body at all**, so core's "is the caller the reserved agent" rule could never run — any tenant member could end any live call |
| MAG-119 | master's zero-charge for an abandoned attempt was keyed on `status === 'abandoned'`, a value core's `webrtc_calls.status` CHECK cannot produce — every abandoned attempt billed the full 25mc |

Six seams are pinned. Each carries its own `$comment` explaining the trap; read
those before changing anything on that hop.

| Seam | Direction | Path | Notes worth knowing |
|---|---|---|---|
| `dncSync` | master → core | `POST /internal/agency/dnc-sync` | `version` is a decimal **string** in both directions. master returns `version::text` because the column is `BIGINT`; core bounds it to `Number.MAX_SAFE_INTEGER` because its ordering arithmetic runs in Redis' Lua 5.1 where every number is a double. A bare JSON number is **rejected**, not tolerated alongside the string. `.strict()` on both sides, so a typo'd field is a 400 rather than a silent no-op. |
| `dncResync` | core → master | `POST /internal/agency/dnc-resync` | The two hops **validate `tenant_id` differently** — master's is `z.string().uuid()`, core's `dnc-sync` is `z.string().min(1).max(100)`. Recorded rather than resolved, because the asymmetry runs in the direction that hides: core fires and forgets, so a refusal is a tenant that never dials again and logs one line. `202` even when throttled. |
| `dncMark` | core → master | `POST /internal/agency/dnc` | A campaign mark must carry `campaign_id` all the way to master's row, and master must echo the **written** scope. Core compares the echo with its outbox row, so a silent strip or a scope widening stays retryable rather than being reported to the agent as a successful suppression at the wrong scope. Omitting `campaign_id` is the *explicit* tenant-wide escalation. An `account_id` on this hop is **rejected** — it cannot enforce account scope at dial time, so it refuses rather than writing a misleading row. |
| `sessionCreate` | browser → master → core | `POST /proxy/agency/sessions` → `POST /agency/sessions` | `agent_user_id` is **master's fact**, from the authenticated session. A browser that could name the agent could go available as a colleague and take their calls. `on_behalf` is deliberately absent here: joining has no ownership question to answer. |
| `attemptActions` | browser → master → core | `/agency/attempts/:id/{hangup,disposition,dnc,notes}` | All four require the actor (`agent_user_id`, plus `on_behalf: true` only when master's caller holds `agency.supervise`). `on_behalf` is **omitted, not sent as `false`**. Asymmetry to keep straight: core refuses an unattributed *disposition* (`400 missing_actor`) but accepts an unattributed plain mark-DNC — suppressing a number has no ownership rule. Master sends the actor on every call regardless, which is what the fixture asserts. |
| `agencySettlement` | core → master | `POST /webhooks/core/webrtc-completed` | `campaign_id`'s **presence** selects the flat agency rate; `nonConnectedOutcomes: ['abandoned']`; `abandonedAttemptStatus: 'completed'`. See §9. |
| `actionErrorCodes` | — | — | The 16-member union, below. |

**Editing protocol.** Change the fixture and both implementations **in one
change set spanning both repos**, then run both suites from inside their
submodules (never from the superproject root — see §10). Editing one copy alone
reds a test *in the repo that edited it*, which is the design. The fixture's scope
is deliberately request/response **shapes** and the vocabularies both sides key on
— not behaviour: whether core applies a delta in order is core's test, whether
master advances its watermark is master's (`:27-29`).

> **Doc drift (inside the fixture).** `$invalidDncScopeComment` (`:319-330`) says
> `invalid_dnc_scope` "carries an OPEN obligation on master: it must be added to
> `AGENCY_ACTION_ERROR_CODES` there". **It has been.**
> `magick-master/src/agency/agency-action-errors.ts:72` lists it, and
> `magick-master/test/unit/agency/s2s-contract.test.ts:542` asserts it. The
> obligation is closed; the comment is stale.

### 6.2 The hand-mirrored error-code union — 16 members, four places

There is no compiler relationship between these four. All four must agree.

| Repo | File | Form |
|---|---|---|
| core | `magic-voice-core/src/agency/contracts.ts:1286` | `AgencyActionErrorCode` type union (the authority) |
| master | `magick-master/src/agency/agency-action-errors.ts:24` | mirrored union, plus `AGENCY_ACTION_ERROR_CODES` at `:68` |
| cusui | `magick-comms-cusui/src/types/agency.ts:210` | mirrored union, plus `AGENCY_ACTION_ERROR_CODES` at `:237` |
| master | `magick-master/src/api/middleware/error-mask.middleware.ts:171` | `...AGENCY_ACTION_ERROR_CODES` spread into the mask's allow-list |
| fixture | `agency-s2s-contract.fixture.json:331-348` | `actionErrorCodes.codes` — the cross-repo pin |

The 16 codes:

```
missing_actor              not_your_attempt          unknown_disposition_code   invalid_dnc_scope
note_required              datetime_required         invalid_callback_at        attempt_not_dispositionable
already_dispositioned      unknown_break_reason      break_already_applied      session_ended
no_station                 attempt_not_live          campaign_not_running       feature_disabled
```

**The failure mode of adding a code in one repo only.** Master's `errorMaskHook`
masks any core-forwarded 4xx carrying neither field-level `details` nor an
allow-listed `code`. `AgencyActionErrorResponse` is
`{ error, code, message, allowed_codes? }` — **no `details`** — so the mask's
structured-error rule does not rescue it. A code core emits that master has not
mirrored is rewritten into *"contact support and quote this request id"*: **the
status code stays correct and only the explanation is destroyed.** Nothing errors,
nothing goes red, no test fails. It also discards `allowed_codes`, the field whose
entire purpose is to let a console holding a stale catalog recover in one round
trip instead of re-bootstrapping mid-shift (`agency-action-errors.ts:11-18`).
**It happened three times during this build**, caught each time by someone
remembering (fixture `:313-317`).

How each copy is pinned:

- master and cusui both use the two-sided trick: `as const satisfies readonly
  AgencyActionErrorCode[]` proves every *listed* value is valid, and a
  `MissingCode = Exclude<Union, (typeof LIST)[number]>` assignment proves every
  *union member* is listed (`agency-action-errors.ts:87-94`,
  `magick-comms-cusui/src/types/agency.ts:256-271`). A code in the union and
  missing from the list is a `tsc --noEmit` failure.
- Nothing pins core's union to master's or cusui's except the fixture and §6.3.

> **MAG-154, worth internalising.** `invalid_dnc_scope` and `attempt_not_live`
> were missing from **cusui's** copy for a full cycle and everything worked
> anyway, because every consumer reads the code off `err.details.code` typed
> `unknown` rather than off the union. Inert — right up until someone builds a
> `Record<AgencyActionErrorCode, …>` copy map or an exhaustive `switch` on it
> (`magick-comms-cusui/src/types/agency.ts:196-208`).

### 6.3 The error-mask drift detector — a committed snapshot plus a freshness check

`magick-master/test/unit/api/middleware/error-mask.agency-contract.test.ts` turns
the allow-list from a discipline into a mechanism. It scrapes core's agency
surface for error codes and asserts each is either allow-listed or explicitly
exempt.

**How it runs (MAG-143), and why the shape changed:** it used to read the sibling
checkout under `describe.skipIf(!coreAvailable)`. Master's CI has no sibling
checkout, so **every assertion skipped on every PR** while the header claimed
otherwise — and on a laptop it read whatever branch core's working tree happened
to be on, which was observed changing a verdict mid-session. Now:

- Assertions run against `magick-master/test/fixtures/core-agency-error-codes.json`,
  a **committed scrape** of core's surface. These run everywhere.
- The sibling read survives as a **freshness check**: when core is present it
  re-scrapes **`origin/main`** (not the working tree) and asserts the snapshot is
  still current.
- Regenerate with `npm run snapshot:core-agency-codes` (master).

Practical consequence: **core adding an error code now shows up as a diff in a
master PR.** If you add a code in core, expect to regenerate master's snapshot.

### 6.4 Other cross-repo pins

| Pin | Where | Failure if broken |
|---|---|---|
| **Roster refusal codes** (3) — `campaign_dialing`, `attempts_live`, `contacts_total_mismatch` | `magick-master/src/agency/agency-roster-errors.ts:36-58`, spread into the mask | The clear route answers `409` with `code: err.coreCode` — a *variable*, so the call site names none of them. All three were being masked while the 409 stayed correct. Each is a refusal the operator fixes in seconds, so a support ticket helps with none of them. **Master holds this list rather than scraping core because core does not implement the supersede hop yet** — `AGENCY_ROSTER_REPLACE_ENABLED` is off for that reason (`magick-master/src/config/index.ts:160`), and the route is registered only when it is set (`proxy-agency-campaigns.routes.ts:763`). |
| **Campaign-lifecycle codes** — `another_campaign_running`, `invalid_campaign_transition`, `campaign_not_found`, `campaign_roster_empty`, `campaign_roster_exhausted`, `announcement_not_found`, `analysis_profile_not_found` | `error-mask.middleware.ts:106-160` (individually listed, deliberately *not* in `AGENCY_ACTION_ERROR_CODES` — they are not members of core's union) | `another_campaign_running` is D9's one-running-campaign rule surfacing as a 409; masked, a supervisor pressing Start gets a support message instead of "pause the other campaign first". `analysis_profile_not_found` was allow-listed **before core shipped it** (core merges first) and was inert until then. |
| **Station frame error codes** — `unauthorized`, `unknown_attempt`, `invalid_frame` (plus `not_your_attempt`, `campaign_not_running`, `session_ended` which come in via the action list) | core `contracts.ts:741` `AgencyStationErrorCode`; master `error-mask.middleware.ts:99-105` | Same masking failure, on a socket. |
| **Stall codes** (8) and their priority order | core `contracts.ts:1514-1541`, `AGENCY_CORE_STALL_CODES` | `credits_low` is declared in core's union but **core never produces it** — core holds no balance. Master inserts it at that priority when proxying (master `746d1cf`, MAG-141). `AGENCY_CORE_STALL_CODES` is the machine-checkable statement of that split. |
| **Attempt outcome vocabulary** (10) | core `AgencyAttemptOutcome` (`contracts.ts`), the classifier's return arms, `retry-policy.ts`, `retry-summary.ts`, `spine-filters.ts`'s inverted `Record`; cusui `src/types/agency.ts` + `agency-spine.ts`'s `satisfies Record<AgencyAttemptOutcome, string>` | `no_answer`, `busy`, `failed`, `abandoned`, `connected`, `agent_disconnected`, `orphaned`, `canceled`, `invalid`, `machine`. `machine` is declared but **unproducible** (D1: AMD is out of scope, so a voicemail answer is `connected`). Master needs no mirror — `agency-spine.ts` types `last_outcome` as `string \| null` with no enum on the filter keys, so the vocabulary is pass-through there; the retry-policy key above is the only master-side pin. The two `satisfies`/inverted-`Record` guards are what make `tsc` a real check on this union rather than a formality: adding a member without touching them does not compile. Added to this register 2026-09-10, after `canceled` was added and a `contracts.ts` comment pointed readers at a register row that did not exist. |
| **Retry policy outcome keys** (8) | core `DEFAULT_RETRY_POLICY` (`retry-policy.ts:51`); master `RETRY_POLICY_OUTCOMES` (`agency-campaign-config.ts:184-193`) | `no_answer`, `busy`, `failed`, `abandoned`, `connected`, `agent_disconnected`, `orphaned`, `canceled`. `canceled` joined 2026-09-10 with late binding; core's own entry is a documented fail-safe read by nothing (`resolveOurFaultRedial` consults only the campaign's policy) — see §5. Note `invalid` is **not** a key (MAG-103: it was accepted by both services and read by neither). `machine`/`voicemail`/`answering_machine` are named in a dedicated error (`SILENTLY_INERT_OUTCOMES`, `:165`) because they are the keys an operator reaches for and would never once fire. **Master must not add any path that circumvents `OUR_FAULT_REDIAL_BOUND`** — the ceiling lives below the policy, not in it. |
| **Billing names** | master `src/agency/agency-billing-contract.ts` | Four names, none checked by the compiler: one is a string core puts on the wire, three sit in Postgres rate-card rows. Pinned by `test/unit/agency/agency-billing-contract.test.ts`. See §9. |
| **The proxy route table** | `magick-master/test/unit/agency/proxy-agency-route-table.test.ts` | Asserts the exact registered set via Fastify's `onRoute` hook, **and** that every path cusui actually calls resolves (asserted as "not 404"). The client list is hand-maintained — master cannot import cusui. It exists because grepping `\.(get\|post)\(` misses `app.post<{ Params: … }>('…')`: the agent plugin reports **1 route** to that grep and registers **11**, and the wrong conclusion drawn from it nearly caused eleven live routes to be reimplemented over themselves. |
| **Capability keys** (3) | master `src/governance/catalog.ts:87-89`; cusui `RequireCapability.tsx:20-35` | The union hard-codes all three; DB overrides are keyed by the dotted string, so renaming one is a data migration. |
| **Abandon-reason vocabulary** (5) | core `AgencyAbandonReason` + `AGENCY_ABANDON_REASONS` (`contracts.ts`), the settle site's fallback and the answer arm in `agency-dialer.ts`, migration `119`'s column comment, `agency_abandoned_reason_total`'s label set and `agency_bind_total`'s `result`, root dashboard panels 81-82 | `station_lost`, `bind_failed`, `bridge_late`, `unattributed`, `no_agent_available`. **No master or cusui mirror**, verified rather than assumed: the fixture's own `masterReadsFromPayload` is `[campaign_id, outcome, status, talk_time_seconds]`, so the reason never rides the settlement webhook, and nothing renders it. Two-sided exhaustiveness (`satisfies` plus a `MissingAbandonReason` `Exclude`) makes `tsc` a real check — both directions were confirmed to fail the compiler. ⚠️ `no_agent_available` is **declared and unproducible**, the `machine` situation restated: pacing is strictly 1:1 and the dialer refuses to dial once the station is gone, so nothing can dial with nobody free. It shipped as the fallback for a day and therefore labelled every flag-off station loss as a pacing problem — the residual is now `unattributed`, and the lesson is that a fallback must not assert a cause nobody observed. |
| **The single-abandon sample floor** | core `abandonment-guardrail.ts` (`singleAbandonSampleFloor`, and the `abandoned <= 1` gate beside it); cusui `src/utils/agencyHealthStrip.ts` (`suppressedByTinySample`) | `ceil(100 / ceiling_pct)` plus a single-call numerator, **hand-computed in both repos from the same two payload fields, with no shared constant, no fixture entry and no agreement test.** Added to this register 2026-09-11 because it is the newest and least-pinned mirror on the list: core decides when the auto-pause fires, cusui decides whether to promise the agent that it will, and if core's floor moves cusui silently promises the wrong thing again — which is precisely the defect the cusui change exists to fix. It is deliberately NOT in the S2S fixture (this is not an S2S contract; cusui derives it from the campaign-stats payload), so the register row is currently the only pin. Give it a real one before either side's threshold is tuned. |
| **Role hierarchy** | master `src/rbac/roles.ts:20`; cusui `src/utils/permissions.ts:13` | `agent: 5` in both. cusui's `Permission` union mirrors master's seven `agency.*` permissions (`permissions.ts:73-85`). |

---

## 7. Gating — four layers, all of which must align

Enabling any one of these reaches nothing. This is the platform's standard
four-gate shape (root `CLAUDE.md`), and the agency feature touches all four.

### 7.1 RBAC — the `agent` role at level 5

`magick-master/src/rbac/roles.ts:20-27`:

```
agent: 5   viewer: 10   operator: 20   account_admin: 30   tenant_admin: 40   tenant_owner: 50
```

`PERMISSION_MATRIX` maps each permission to a **minimum** role, and the hierarchy
is linear — so a floor of `viewer` (10) is unreachable at 5. Every permission that
predates the agency feature floors at `viewer` or above, which means an `agent`
membership grants **exactly the four `agency.*` agent permissions and nothing else
on the platform**: no campaign list, no analytics, no contacts, no recordings, no
pre-existing `/proxy/*` route (`roles.ts:3-19`).

> **Do not raise `agent: 5` to "make something work."** Raising it silently grants
> an agent every viewer-floored read on the platform. `roles.ts:17-18` says so, and
> `magick-master/test/unit/rbac/roles.agent.test.ts` pins it.

| Permission | Floor | Notes |
|---|---|---|
| `agency.station.connect` | `agent` | Open a station socket, join a campaign |
| `agency.attempts.handle` | `agent` | Receive a bridged call, hang up |
| `agency.attempts.dispose` | `agent` | Disposition, notes, schedule a callback |
| `agency.dnc.write` | `agent` | Mark **the contact on the line** as DNC; core additionally verifies the caller is that attempt's reserved agent |
| `agency.supervise` | `account_admin` | Supervisory. **Different in kind, not just floor** — it authorises acting on an attempt reserved by somebody else, so master sets core's `on_behalf` from it (`src/agency/agency-actor.ts`). Also the floor on campaign start/pause/resume/stop since MAG-136. |
| `agency.dnc.read` | `viewer` | The list is every customer who asked not to be contacted; browsing it is a supervisory act |
| `agency.dnc.manage` | `account_admin` | Add (bulk/arbitrary) and **delete**. Delete is the compliance-dangerous direction: it makes a number dialable again. Adding over-blocks at worst; removing **under**-blocks, which is the regulatory event the feature exists to prevent |

Campaign **writes** (create / PATCH / roster) floor at
`proxy.contact_lists.write` = `account_admin`
(`roles.ts:110`); campaign **reads** at `proxy.contact_lists.read` = `viewer`
(`:109`). Campaign **control** floors at `agency.supervise`
(`magick-master/src/api/routes/proxy-agency-campaigns.routes.ts:419,444,469,507`).

> **Doc drift.** `docs/agency-dialer-fix-queue.md` §6 lists as an open decision
> that "an operator (20) can start/stop a campaign but not edit it". That is fixed:
> control now floors at `agency.supervise` (30), so an `operator` can reach neither.
> `roles.ts:139-145` also flags the *stale* side of the original backlog line —
> `AD-P2-M-01`'s acceptance (d) said "an `operator` can disposition on an agent's
> behalf", which an `operator` at 20 cannot hold. Flagged rather than built to,
> because lowering a supervisory floor is not a change to make silently.

### 7.2 Governance capabilities — three keys, closed set

`magick-master/src/governance/catalog.ts:87-89`. The catalog file is **FROZEN**;
each field below is pinned by `test/unit/governance/catalog.agency.test.ts`.

| Key | Parent | Default | Mandatory | Enforcement | Label |
|---|---|---|---|---|---|
| `agency` | `null` | `false` | `false` | `nav`, `api` | Agency Dialer |
| `agency.recording` | `agency` | `false` | `false` | `nav`, `behavioral` | Agency call recording |
| `agency.analytics` | `agency` | `false` | `false` | `nav`, `behavioral` | Agency call analysis |

- **Root, not a child of `calls`** — the dialer is its own product surface, and
  `calls` is `mandatory: true`, so parenting under it would give the tree an
  ancestor that can never gate it (`catalog.ts:74-77`).
- **`default: false` throughout, children included** — this dials real people at
  volume and spends credits (`:79-81`).
- **The key set is CLOSED AT THREE** (`:63-66`). Adding a key later is additive;
  renaming or splitting one is a data migration, because DB overrides are keyed by
  the dotted string and cusui's union hard-codes all three.
- **`agency.recording` gates HUMAN-to-human recording**, which carries
  two-party-consent exposure an AI-disclosed call does not. `default: false` is the
  safe direction but is **not a consent mechanism** — the announcement work is
  Phase 3, and this was put to the approver and ratified in that knowledge
  (`:68-72`). Do not read the capability's name as meaning more than it does.
- Enforcement: a section-level `requireCapability('agency')`
  (`proxy-agency-campaigns.routes.ts:232`, again on a sub-plugin at `:567`), **plus**
  per-field `assertCapability` on campaign writes for `agency.recording` (`:139`)
  and `agency.analytics` (`:144`) — MAG-138 found the section gate is not a
  substitute: with `agency.recording` off you could enable human↔human recording
  with one curl (`:78-121`).

### 7.3 Core feature flag

`agency_dialer_enabled`, `magic-voice-core/src/feature-flags/registry.ts:386-395`:
`default: false`, env `FF_AGENCY_DIALER`, scopes `global | tenant | account`,
`clientExposed: true` (cusui shows/hides the consoles from it).

**It is the deploy-ordering guard**, not just a kill switch (`:380-385`): master's
unified settlement endpoint rejects an unknown `call_type` with a 400, so enabling
it for a tenant before master's settlement branch and the two rate-card rows are
live would make every agency call fail to settle. It belongs in the rollout
checklist.

Two behaviours to know: the runtime always starts — its reaper, timers and
supervise pass run regardless — and what the flag gates is every campaign route
**and**, because the pacing engine re-reads it on each supervise pass, whether any
campaign is led at all (`magic-voice-core/src/index.ts:256-266`). Note the deliberate
asymmetry at `pacing-engine.ts:213`: turning the flag off must not take the
operator's **stop** button away, so the stop path is ungated
(`agency-campaigns.routes.ts`, `/:id/stop` and `/:id/pause` are `ungated: true`).

**`agency_late_binding`** is the second agency flag, added after the 2026-09-08
pilot: `default: false`, env `FF_AGENCY_LATE_BINDING`, scopes
`global | tenant | account`, and deliberately **not** `clientExposed` — the console
receives the same frames in the same order, just later, so there is nothing for
cusui to show or hide, and a flag the client can read is a flag the client will
eventually branch on.

On, the agent is bound to a campaign call **at the carrier answer** instead of
before the dial: the panel is built at dial time but held, the leg is placed with no
browser socket at all (`createUnboundBridgedCall`), and the panel and the socket are
delivered synchronously at the answer (`bindBorrowedBrowserLeg`). A dial that rings
out, is busy, fails or finds an unreachable handset therefore reaches the console as
**nothing** — no `reserved`, no `released`, and no `bridged`.

On `agent_state`, see §5, which states the guarantee precisely and then corrects
itself: the wire is **not literally silent**, because exactly one `agent_state` frame
(`state: 'available'`, from `releaseAgent`) does arrive, and suppressing it would
silently drop a break the agent queued mid-ring. Cross-referenced rather than restated
— an earlier version of this section restated it, drifted from §5's corrected wording,
and told a reader deciding whether to enable the flag that no `agent_state` arrives.

**Voicemail is NOT in that set, and the flag does not claim it.** A machine answers
like a human as far as the carrier is concerned, D1 puts AMD out of scope (§1), and
§7.3's own grace-budget argument rules out any *gating* detector — so a voicemail
answer is `connected`, reaches the agent, and is distinguishable only by the
agent's `voicemail` disposition. Late binding removes the ringing popup; the
greeting an agent sits through is a wrap-up cost (§11).

Two things it is not, because both are reasonable guesses:

1. **Not over-dialing.** The tick still places at most one dial per idle agent
   (§4), so fan-out is unchanged. Late binding fixes the idle *experience*; only
   over-dialing moves idle *time*.

   ⚠️ **This paragraph used to say the arithmetic "allows no extra dials at all"
   at two agents. That was wrong, and it was wrong in a way worth naming, because
   it is the same mistake §11's payoff table makes: it treats the over-dial ratio
   as an INTEGER.** You do not have to place a whole extra dial every tick — you
   place one on a fraction `q` of them, and a ratio of 1.14 is as implementable as
   2.0. Corrected 2026-09-11 with measured data (§8, "What over-dialing would
   actually buy"): at two free agents a 1.5% budget buys **≈+14% dials**, and at
   three it buys +33%. Modest, not nothing.

   What remains true is that the payoff is small here and large with more agents,
   and that the cancel-capable carrier is what turns one into the other. What
   turned out to bind first is neither: **a rate budget needs volume before it
   means anything**, and at the pilot's 33 answered calls a day there is not one
   abandoned call of headroom. See §8.
2. **Not provider-gated in code.** VoiceLink is the intended first cohort because
   that is where a cancelled ring kept ringing and answered into a dismissed
   console, but the gate is this flag plus the adapter capability
   (`ProviderCapabilities.cancelRinging`), never a branch on a provider name.

⚠️ **The bind runs inside the 1s `ABANDONMENT_BRIDGE_GRACE_MS` budget.** Everything
between the answer and the socket attach is time the compliance predicate counts as
a call that reached nobody. That is why the bind path is synchronous and why the
panel's contact context (including the lineage-scoped prior-attempts read) is
fetched at dial time. Anything added to it — an AMD dwell, a second round trip —
spends that budget. VoBiz's AMD is configured `machine_detection_time: 5000` and an
in-house first-utterance detector needs 2.5–3.5s, so **no gating AMD fits**; the
only admissible shape is bridge-at-answer with detection in parallel.

### 7.4 cusui route guards

`magick-comms-cusui/src/App.tsx:125-126` and `:143-144` wrap the agency subtree in
`<RequireCapability capability="agency">` **and** `<RequireFlag
flag="agency_dialer_enabled">`. `RequireCapability` fails **open** by design (see
root `CLAUDE.md`) because master's 403 is the real enforcement; `RequireFlag` fails
**closed**.

### 7.5 What the four layers mean in practice

To make the agency dialer reachable for a tenant you need, in this order:
core's `agency_dialer_enabled` on for that tenant/account · master's `agency`
capability enabled (plus `agency.recording` / `agency.analytics` if the campaign
uses them) · at least one `agent`-role membership per agent, scoped to the account
· an `account_admin`+ user to hold `agency.supervise` · a non-empty caller-ID pool
on the campaign · and a DNC baseline for the tenant (§8). A missing route in a
running service is usually an unset env var, not a bug.

---

## 8. Supervisor surface

The payload is `AgencyCampaignStats` (`magic-voice-core/src/agency/contracts.ts`,
field roster at `AGENCY_CAMPAIGN_STATS_FIELDS`, `contracts.ts:1862`). It has **two producers in
core**, and the split is itself a contract: `agencyCampaignRepository.stats()`
returns `Omit<AgencyCampaignStats, …AGENCY_STATS_ROUTE_FIELDS>` (pure SQL), while
the **route** composes `campaign_id`, `status`, `stall`, `other_stalls`,
`concurrency_limit`, `concurrency_in_use` (`contracts.ts:1859`) — those need Redis
(DNC sync state, the account concurrency counter) and a pure-TS rule (calling
hours) that a repository cannot reach.

The route annotates its literal `const payload: AgencyCampaignStats`, so a new
required field is a compile error at whichever producer fails to supply it. The
runtime field roster exists because two holes shipped that no type could see: a
producer returning `Record<string, number>` (an index signature satisfies every
field name), and a producer reading its own SQL by string key
(`row['answered_24h']` out of an untyped record yields a confident `0` and reports
a perfectly compliant campaign). It lives in `src/`, not beside its test, because
core's `tsconfig.json` excludes `test/`.

### Health strip and stalls

`magic-voice-core/src/agency/campaign-health.ts`. Eight stall codes, **priority
order, first match wins** (`contracts.ts:1514-1541`):

| # | Code | Produced by |
|---|---|---|
| 1 | `auto_paused_abandonment` | core — the guardrail |
| 2 | `dnc_unavailable` | core — dialing fails **closed** |
| 3 | `no_agents_available` | core |
| 4 | `concurrency_saturated` | core |
| 5 | `outside_calling_hours` | core |
| 6 | `list_exhausted_retries_pending` | core — needs `retries_pending > 0`, not just an empty list (MAG-146) |
| 7 | `credits_low` | **master only.** Core does no millicredit arithmetic and holds no balance; it learns about exhaustion as a 5xx on the hourly attempt-batch post, long after the fact. Master inserts it at this priority when proxying. |
| 8 | `elevated_failure_rate` | core |

`stall` is the first match; `other_stalls` carries the rest as **codes only** —
the console renders a count and a list of names, and carrying full evidence for
problems it is not showing would triple the payload for a disclosure most
supervisors never open.

### Concurrency read-out

`concurrency_limit` is the account's configured ceiling and is a **read-out, never
a control** (D10, §4). `concurrency_in_use` is **account-wide, not campaign-wide**
— the same Redis counter AI calls use, so "4 of 5" is real headroom including
traffic this campaign knows nothing about — and is `null` rather than a substituted
local count when Redis is degraded, because "4 of 5" and "we don't know" are
different answers and the strip's diagnosis must not fire on a guess.

**`calls_active_current` is not the dialer's concurrency and cannot be made into
it.** That gauge is fed only from `CallManager`'s AI `activeSessions` map
(`magic-voice-core/src/core/call-manager.ts`), and an agency leg is a WebRTC bridge
session that never enters it — so the one platform-wide "how many calls are up"
number read **flat 0 for the dialer** throughout the 2026-09-08 pilot. It is not
fixable by widening: adding a `call_type` label to a live series terminates it, and
a second writer into a map-derived value would race the AI path.

`agency_live_attempts_current{tenant_id, campaign_id, state}` is the replacement —
attempts that have not reached `ended`, split by state, exported over OTLP (Grafana
Cloud is fed by OTLP; when this was written core also ran a parallel prom-client
registry, removed 2026-09-30 in core #404 — there is now one OTel instrument per
metric). Derived by one grouped SQL aggregate over
`agency_call_attempts` on a 15s timer, with a 90s staleness TTL applied at
collection so a failing query makes the series **absent** rather than keep
exporting a reassuring number. Three properties are deliberate:

- **`state <> 'ended'` is written as a literal, not a bound parameter**, so it
  matches `uq_agency_attempt_live`'s partial-index predicate byte for byte and the
  read costs live concurrency rather than history. It is also the same predicate
  `AgencyAttemptRepository.countLive` uses for the tick's `occupied` term, so the
  gauge and the tick cannot disagree about what is in flight.
- **15s, not the abandonment window's 60s.** An attempt lives in `dialing`/`ringing`
  for ~5–25s, so a 60s poll does not give a late reading of dials in flight — it
  aliases them away, and the series would read 0 through most of a busy shift.
- **`state` is narrowed once, in the publisher, against
  `AGENCY_ATTEMPT_LIVE_STATES`** — never typed off the column's CHECK constraint. A
  Prometheus label vocabulary must be bounded by source code; a migration could
  widen that constraint in a commit touching no TypeScript.

This is what "dials in flight" vs "conversations in progress" is read from, and it
is the number any future over-dialing work is paced against.

### Abandonment

`abandoned_24h`, `answered_24h`, `abandonment_rate_24h_pct`, `abandonment_ceiling_pct`.
Derived from the **SQL/table-derived** window (`ABANDONED_ATTEMPT_PREDICATE_SQL`),
not from the in-process counter — that was MAG-120: the three fields were declared
required and had no producer at all, and `undefined > threshold` is `false`, so
MAG-66's guardrail looked present and would never have fired. There is a chaos
test asserting the counter and the table agree
(`test/integration/agency/chaos/abandonment-counter-vs-table.test.ts`) and another
asserting the SQL and in-process predicates agree
(`…/abandonment-predicate-agreement.test.ts`).

### ⚠️ The next two subsections are OPERATOR telemetry, not part of the supervisor payload

§8 above is about `AgencyCampaignStats` — the JSON a supervisor's browser receives. The two
subsections below are Prometheus/Grafana series and the arithmetic that justifies them: nothing
here reaches cusui, no field of theirs is in `AGENCY_CAMPAIGN_STATS_FIELDS`, and a supervisor
never sees any of it. They live under §8 because that is where the concurrency read-out already
put the fleet gauges and because every cross-reference in this repo, in `docs/`, and in three PR
descriptions points at "§8" — moving them would break those for a structural nicety. Read the
section heading as *"what the platform reports about a campaign"* rather than *"what the
supervisor UI shows"*, and treat the boundary as this line.

### What over-dialing would actually buy, measured (2026-09-11)

The first sizing of this off real data rather than an assumed answer rate. Source:
104 settled attempts on dedicated, read from the `'Agency attempt ended'` lines in
Loki, cross-checked against `agency_abandonment_window_answered_24h` in Prometheus.
It is one pilot, and it is all the agency data there is.

**The answer rate.** 33 of 104 dials answered. 19 of the remainder were rings the
agent cancelled mid-flight (the ring-cancel defect), so they are **censored** rather
than failed: excluding them gives 33/85. So `p` is **0.32-0.39**, point estimate
**≈0.35** — which happens to validate the figure §11 and the pacing recommendation
had been carrying as a guess. `answered_24h` peaked at **33**; the abandonment
numerator was **0** and the rate **0%**, because those 19 rows had `answered_at IS
NULL` and the predicate correctly declined to count dials nobody picked up.

**The ratio is continuous, not integral**, and the earlier framing ("+0 extra dials
at m=2") missed that. Placing one extra dial on a fraction `q` of tick
opportunities costs `q·pᵐ/(m+q)` in abandonment, so for a budget `B`:
`q = B·m/(pᵐ − B)`.

| free agents | one whole extra dial costs | 1.5% budget buys |
|---|---|---|
| 1 | 17.5% | +4% dials |
| 2 | 4.1% | **+11% to +17%** |
| 3 | 1.07% | +33% (a whole extra dial fits) |
| 4 | 0.30% | +25%, with room to spare |
| 5 | 0.09% | a whole extra dial is essentially free |

So the honest number at the two-agent floor is **≈+14% dials for a 1.5%
abandonment rate**, not the ×2 (40% talk share) the payoff table quotes — that
needs a cancel-capable carrier, which cuts the abandonment cost of the same pace by
roughly 6-7×. Marginal without the carrier, transformative with it.

⚠️ **A rate budget needs volume before it means anything, and this is the binding
constraint today.** At a 3% ceiling one abandoned call only comes in under the
ceiling from **34** answered calls upward — the same `ceil(100/ceiling_pct)` as the
guardrail's own `singleAbandonSampleFloor`, and not a coincidence: both ask when a
single call stops dominating the rate. The pilot peaked at 33 answered in 24h, i.e.
a budget of **0.99 abandoned calls per day**. One short.

**Therefore a pacing controller needs a volume gate as well as a rate budget**, and
it is the same threshold: do not place a surplus dial until `answered_24h ≥
singleAbandonSampleFloor(ceiling_pct)`. Below it the campaign cannot absorb a single
surplus abandonment, so the correct behaviour is to decline — and a controller
without that gate would spend its whole budget on its first extra dial of the day.

### Seat time — where the hours actually go (added 2026-09-10)

Seven per-replica series, and they exist because every pacing number the platform
had came from hand-decomposing one 39-minute pilot. Two independent analyses of
"how do we dial faster" then disagreed on the single largest term — whether an
unanswered dial holds an agent for ~31s or ~55s — and **neither could settle it,
because nothing measured how long an agent is held per attempt.**

| series | answers |
|---|---|
| `agency_attempt_hold_seconds{outcome}` | Where seat time goes. **The pivotal one.** |
| `agency_answer_latency_seconds` | What ring timeout to set, and how tightly answers cluster. |
| `agency_bind_latency_seconds` | Is the late bind inside its 1000ms budget (§7.3's abort criterion). |
| `agency_bind_total{result}` | The denominator the histogram cannot supply. |
| `agency_abandoned_reason_total{reason}` | When we abandon, *why* (migration 119). |
| `agency_wrapup_seconds{resolution}` | How fast agents actually file, vs the window configured. |
| `agency_our_fault_retirement_total{outcome}` | Contacts we retired by failing to reach them. |

Three properties are deliberate, and each is the inverse of a rule that applies
one subsection up:

- **These take `sum(rate(...))`, never `max`.** They are per-replica counters and
  histograms whose increments are genuinely per-replica, unlike
  `agency_abandonment_rate_24h` and `agency_live_attempts_current`, which every
  replica derives from the same SQL and publishes identically. Both families now
  sit on the same dashboard and the wrong aggregator on either is silent.
- **The `outcome` split on hold time is load-bearing, not a convenience.** The
  pilot's largest single block of waiting was 32 busy signals at ~37s each, and a
  busy phone never rings — so no ring timeout can touch it. An aggregate "average
  wait" pointed every previous analysis at the wrong lever.
- **`agency_abandoned_reason_total` is a separate series, not a `reason` label on
  `agency_abandoned_total`.** Labelling the latter terminates it, and it is the
  compliance numerator that the §10 cross-check and the `AD-P4-C-02` guardrail
  both read. A diagnostic split does not earn that migration, so the two run
  alongside and `sum(rate(...))` of each should track; a persistent gap means an
  abandon path reaching the compliance counter without declaring a reason.

Bind latency is measured from the **carrier's** answer instant, so it includes
webhook transit. That is the honest measure rather than a flattering one:
`ABANDONMENT_BRIDGE_GRACE_MS` counts that time too, so a latency measured from our
own receipt would clear a budget the compliance predicate says we blew.

Rendered as panels 78-84 of the cross-service dashboard, each carrying the lever a
reading implies rather than only the number.

### Agent liveness and the ranked-by-risk roster

`agents_by_state` is the breakdown; `agents` is the floor. Liveness comes from
`StationRegistry.connectedBySession` — one `MGET`, which **throws** on a Redis
fault so the route renders `connected: null` = unknown (§3). `state_since` is the
anchor the risk ordering sorts on, which is one of the two reasons `reserved` is
not mirrored to the DB (§4).

`calls_handled` per agent rolls up `agency_call_attempts` joined on
`reserved_agent_id` filtered by `bridged_at IS NOT NULL` with **no state filter**;
migration `090`'s `idx_agency_attempts_agent_bridged` matches that predicate
exactly (MAG-153).

### What is computed where

| Figure | Core repository | Core route | Master proxy | cusui |
|---|---|---|---|---|
| contact/attempt counts, connect split, AHT, wrap-up avg, abandonment window | ✔ | | | |
| `stall`, `other_stalls`, concurrency limit + in-use | | ✔ | | |
| `credits_low` insertion, `agent_name` resolution | | | ✔ (master `746d1cf`, MAG-141/148) | |
| per-tile derived figures, risk ranking, health-strip copy | | | | ✔ (`src/utils/agencyHealthStrip.ts`, `agencyAgentFloor.ts`, `agencyStatsConsumers.ts`, `agencyCampaignPerformance.ts`; cusui `b3fe577`, `5136084`) |

### Where cusui's agency code lives

`src/pages/agency/` (agent console, campaigns, DNC, settings, contacts) ·
`src/pages/campaigns/agency/` (the builder wizard) · `src/components/agency/` ·
`src/api/agency.ts` (the **agent-native** routes, which exist rather than reusing
the generic call API precisely so core can check the caller is the reserved agent)
· `src/api/agencyCampaigns.ts` · `src/types/agency.ts` and
`src/types/agency-campaign.ts` · `src/hooks/useAgencyStation.ts` (re-mints the
station token on every reconnect) · and 25 pure helpers under `src/utils/agency*.ts`.

`src/utils/agencyDispositionSubmit.ts` is worth reading before touching the
disposition path: it classifies a submit's outcome against core's frozen shape and
encodes the non-obvious rule that a **re-submitted same code is a 200** (with
`notes` / `callback_at` last-write-wins, so an honest "same outcome, better note"
correction works), while a **different code is a 409**, because silently rewriting
the record of a conversation is not a retry.

> **Doc drift.** `AgencyCampaignStats` deliberately carries **no hour-over-hour
> delta** (`contracts.ts:1802-1826`). A `previous_hour` block was built and removed:
> every field it would compare against is a campaign-**lifetime** aggregate, so a
> campaign on day three with 5,000 lifetime connects and 30 in the last hour reads
> as a permanent 99% collapse. The honest shape needs both windows. If a UX
> document promises a delta tile, that is the doc that is stale.

---

## 9. Billing and settlement

An agency attempt settles differently from a plain `webrtc_call`, and the
mechanism is deliberately **not** a new `call_type`.

### The discriminator

**`campaign_id`'s presence selects the flat agency rate.** It is mirrored onto the
settlement payload from `webrtc_calls.campaign_id` (migration `076`), and there is
no distinct `call_type` **because the unified endpoint 400s on an unknown one, and
that rejection is the deploy-order safety net**
(`agency-s2s-contract.fixture.json:300`). Adding an agency `call_type` would
require master to ship first or every agency call would 400; keeping `webrtc_call`
means core's feature flag alone controls the ordering.

Master branches on `payload.campaign_id` in **both** settlement handlers:
`/webrtc-completed` (`magick-master/src/api/routes/webhook-core.routes.ts:857-871`)
and the unified `/completed` (`:1338-1359`). Both are kept even though **core only
ever posts to `/webrtc-completed`** — `resolveSettlementUrl` derives the endpoint
from `call_type` by swapping the last path segment
(`magic-voice-core/src/webhooks/settlement-dispatcher.ts`), so core has no code
path that reaches `/completed` for any call type. A branch present on only one of
them would be "a silent 10×-on-a-minute overcharge"
(`webhook-core.routes.ts:825-827`).

> Two documented traps, both from `magic-voice-core/src/agency/contracts.ts:1897-1921`:
> there is no single `POST /webhooks/core/completed` core posts to, and the
> `call_type` core sends is **`webrtc_call`**, not `webrtc`. Master's `/completed`
> branch tests `callType === 'webrtc' || callType === 'webrtc_call'` — both
> spellings — precisely so a future caller keyed on the wrong one does not fall
> through to the 400 and lose a settlement silently.

### Two rate-card operations

Seeded by `magick-master/src/db/migrations/052_agency_rate_cards.sql`:

| Operation | Unit | Rate | When |
|---|---|---|---|
| `agency_connected_call` | `call` | **25** millicredits | An attempt reached an agent. Flat, duration-independent. Per-unit path (`calculateActualCostPerMessage`), **not** the per-minute path. |
| `agency_dial_attempt` | **`10_attempts`** | **2** millicredits | Every dial placed, connected or not — settled in **hourly batches**. |

> **Doc drift.** `docs/agency-dialer-design.md` D7 states the attempt rate as
> "`attempt` / 0.2 millicredits". `rate_millicredits` is `BIGINT`, so 0.2 is not
> representable; the shipped row is `unit = '10_attempts'`, `rate = 2`, consumed
> only through `rateCardService.calculateAttemptBatchCost`. The arithmetic is
> `attempts × 2 / 10` with the remainder carried, which is what
> `agency_attempt_settlements.remainder_tenths_before/after` (`CHECK BETWEEN 0 AND
> 9`) exist for. The design doc's *intent* is right; its unit is not what shipped.

### Zero-charge, and the abandoned-attempt status convention

`magick-master/src/credits/settlement.service.ts:425-480`. "Connected" means
**connected to an agent**. An attempt is zero-charge when any of:

1. `status` ∈ `NON_BILLABLE_STATUSES`;
2. `outcome` ∈ `AGENCY_NON_CONNECTED_OUTCOMES` = `{ 'abandoned' }` (`:56`);
3. `talk_time_seconds <= 0`.

**Arm 2 is MAG-119's, and the reason it is needed is the whole story.** An
abandoned agency attempt is one the customer **answered** and no agent reached:
the carrier connects, no live reserved station exists, the apology clip plays. So
it ends with several seconds of real talk time and, per core's ordinary teardown
(`answeredAt ? 'completed' : 'canceled'`, answered by definition),
**`status = 'completed'`** — pinned as `abandonedAttemptStatus` in the fixture
(`:304`). Every signal a status-or-duration check can see says "connected".

Master's zero-charge was keyed on `status === 'abandoned'` — a value from core's
**outcome** vocabulary. `webrtc_calls.status`'s CHECK (core migration `047`)
permits only `initiating|ringing|in_progress|completed|failed|no_answer|busy|canceled`,
so it **has never crossed the wire and cannot**. The branch could not fire and
every abandoned attempt billed the full 25mc. Master's comment named the outcome
while its code tested the status, and its test supplied `status: 'abandoned'`
itself — the value whose derivation was the bug (fixture `:286-294`). The set is
additive and conservative: **anything not listed bills**, so an outcome core adds
later fails towards charging rather than towards free calls.

### The cross-rate guard

Before charging, master checks for a prior `webrtc_call`-referenced consumption or
release on the same `call_id` and skips if found
(`settlement.service.ts:446-459`). A redelivery whose payload lost `campaign_id`,
or a core rollback mid-campaign, would otherwise bill one leg twice at two rates.
The inverse cannot happen — core derives the payload from the persisted
`webrtc_calls.campaign_id`.

### The attempt batcher

Core: `magic-voice-core/src/agency/attempt-batcher.ts` +
`attempt-batch-reference.ts`, swept every 60s (`ATTEMPT_BATCH_SWEEP_MS`) over
`idx_agency_attempts_billing` (migration `081`, `dialed_at` leading).
Master: `POST /webhooks/core/agency-attempts-completed`
(`webhook-core.routes.ts:930`) → `agency_attempt_settlements`, with
`uq_agency_attempt_settlement_batch (campaign_id, batch_reference)` as the
idempotency key.

Details that bite:

- **`batch_reference` is opaque to master — do not parse it.** The only properties
  master depends on are stability across redeliveries and uniqueness per campaign.
  Core's longest form is 26 characters (`h:` + a 24-char ISO timestamp), *measured*
  by core; three comments once claimed 28, 30 and 120.
- **There is deliberately no `final` reference.** Campaign end flushes the open
  hour under the same `h:<ISO hour>` the hourly sweep will repost, and the unique
  index no-ops the duplicate. A distinct `final` key would double-bill the partial
  hour.
- **The sweep cadence is also the redelivery interval** — a batch is recorded as
  posted only on a 2xx, so an hour master rejected is simply re-posted next tick
  (12 harmless reposts an hour, and no retry sweep to build; `timers.ts:55-69`).
- `AGENCY_MAX_ATTEMPTS_PER_BATCH = 2_147_483_647` is the `INTEGER` column's
  ceiling, enforced at the route with a `Number.isSafeInteger` check so
  `attempts × 2 / 10` cannot lose precision before the insert raises `22003`
  inside the settlement transaction.

### One operational trap

`dispatchSettlement` is a **no-op when `PLATFORM_SETTLEMENT_WEBHOOK_URL` is
unset** — deliberately not a throw, because a deployment that legitimately runs
without settlement must keep placing calls. It is no longer *silent*:
`warnIfSettlementUnconfigured()` logs a loud warning at boot
(`magic-voice-core/src/webhooks/settlement-dispatcher.ts:178-185`, called from
`src/index.ts`). The attempt-batch path throws on the same condition, so the two
halves of the revenue signal now behave differently on purpose.

---

## 10. Testing the agency feature

Deep detail lives in [`docs/agency-dialer-test-plan.md`](docs/agency-dialer-test-plan.md).
What matters operationally:

| Repo | Unit | Integration / e2e |
|---|---|---|
| core | `magic-voice-core/test/unit/agency/` — 48 files | `test/integration/agency/` — 19 files, plus `test/integration/agency/chaos/` — 9 scenarios + `harness.ts` |
| master | `magick-master/test/unit/agency/` — 22 files, plus `test/unit/api/middleware/error-mask.agency-contract.test.ts`, `test/unit/rbac/roles.agent.test.ts`, `test/unit/governance/catalog.agency.test.ts` | `test/integration/api/agency-action-error-mask.test.ts`, `test/integration/dnc/` |
| cusui | `src/__tests__/**` (`agencyColumnMapping`, `agencyAgentFloor`, `agentPermissions`, `CampaignBuilderPage`, …) | Playwright `npm run test:e2e` |

`npm run lint` is `tsc --noEmit` in all three repos — there is no ESLint
anywhere. Several agency pins are *type-level* (`satisfies` + the `MissingCode`
trick, `AGENCY_CAMPAIGN_STATS_FIELDS`), so **`npm run lint` is a real test here**,
not a formatting step.

**Needs Docker up first:** everything under `test/integration/`. Bring it up with
`npm run test:integration:up` in the repo you are testing.

> **The stack collision, restated because it eats agency work.** Core's
> integration stack binds **5433/6380 — master's *dev* Postgres and Redis** — and
> `magic-voice-core/test/integration/setup/test-utils.ts:130` calls `flushdb()`. One
> owner at a time; verify nothing else is running rather than assuming.

### The contract tests that only run from the superproject root

- `magic-voice-core/test/unit/agency/s2s-contract.test.ts` — the sibling-fixture
  comparison resolves `../../../../magick-master/src/agency/…`. From a standalone
  core clone it `skipIf`s (loudly) and only assertion (1) runs.
- `magick-master/test/unit/agency/s2s-contract.test.ts` — the mirror image.
- `magick-master/test/unit/api/middleware/error-mask.agency-contract.test.ts` —
  the *assertions* now run everywhere off the committed snapshot; only the
  **freshness check** needs the sibling, and it reads core's `origin/main`, not
  the working tree (§6.3).

### The DNC self-heal loop

`magic-voice-core/test/integration/agency/chaos/dnc-self-heal-loop.test.ts`
(MAG-108) is the one that proves the whole loop closes **without a human**. It is
the only chaos scenario with a *mutable* config mock: `masterService` is what
decides whether the self-heal has an arm to pull at all
(`dnc-resync.ts` returns early and logs when it is unset), the URL is not known
until the stand-in HTTP server binds a port, and `createDncResyncRequester` reads
`config.masterService` at **call** time rather than at construction. It also sets
`internalS2sToken`, because core's real `dnc-sync` route registers
`internalAuthMiddleware` as a `preHandler` and without it the return leg would be
proven only as far as a 501. Both hops are shaped from the committed fixture.

### Traps recorded from this build — read before trusting a green run

From `docs/agency-dialer-fix-queue.md` §4, all paid for once:

- **Run tests from inside the submodule, never the superproject root.** Bash cwd
  persists between calls and *both* repos have
  `test/unit/agency/s2s-contract.test.ts`; a "green falsification" was once the
  other repo's suite passing. The test **count** is the tell.
- **`process.exit(1)` in a unit run usually means the cwd, not the code.** Both
  backends `import 'dotenv/config'`, which resolves `.env` from `process.cwd()`, so
  `npm --prefix magick-master test` fails exactly the suites that reach
  `src/config/index.ts` without mocking it — which reads like a real defect.
- **`vitest --reporter=basic` does not exist in Vitest 4 and exits 0 having run
  nothing.** No counts ⇒ no run ⇒ no evidence.
- **An assertion that source *does* something must run over comment-stripped
  source** — a comment explaining a field satisfies a search for its name.
  `stripComments` is in core's `s2s-contract.test.ts`.
- **Enumerate routes from the router, never by grepping** (§6.4), and remember a
  status-only assertion is satisfied by absence (`404`, `null`, `[]`, `0`).
- **Check the default path.** The empty-config case is the ordinary one here.

---

## 11. Known gaps and open obligations

**Time-stamped `2026-08-28`, against core `1.81.1` / master `2.1.1` / cusui
`2.49.0`.** Everything below was re-checked against the tree; items from the fix
queue and gaps documents that are now closed have been dropped rather than
repeated.

**Addendum `2026-09-10`, against core `1.102.4` / master `3.8.2` / cusui `2.82.1`.**
The four rows dated `2026-09-10` in "Still open", and the whole of "Closed
`2026-09-10`", were added then; **the undated rows were not re-verified against
those versions** — core alone moved 21 minor releases in the interval, so treat an
undated row as a claim to re-check rather than a current fact.

**To re-derive this list**, in each submodule:

```bash
git -C magic-voice-core log --oneline -80 -i --grep=agency   # and master, cusui
grep -rn "MAG-1[0-9][0-9]" magic-voice-core/src magick-master/src magick-comms-cusui/src
grep -rn "OPEN\|TODO\|unresolved\|placeholder" magic-voice-core/src/agency
```
then diff against `docs/agency-dialer-fix-queue.md` §3.7/§6/§6b and
`docs/agency-dialer-happy-path-gaps.md` §1–§4.

### Still open

| Item | Where | State |
|---|---|---|
| **`OUR_FAULT_REDIAL_BOUND = 3` is an unresearched placeholder on a regulated repeat-dial limit** | `magic-voice-core/src/agency/retry-policy.ts:103-125` | Open, and the constant's own comment says so at length: "*This number is NOT derived from any regulation… Revisit before the pilot dials a real customer list.*" The two stated reasons are explicitly weak. **A bare number on a regulated limit becomes a fact by age** — the next reader assumes someone checked. Nobody has. |
| **Q-D — scale targets** | `docs/agency-dialer-design.md:1410` | Open, non-blocking. Assumed: 1M contacts/campaign, 50 agents/account, `max_concurrent_calls ≤ 50`. A single core replica carries every AI call, every existing dialer call and every agency bridge on one event loop, so this is also what tells us when multi-replica stops being optional. |
| **No cross-replica hangup channel** | `magic-voice-core/src/agency/dial-dispatcher.ts`, and the `attempt_not_live` doc at `contracts.ts:1327-1337` | Open by design under D2. `attempt_not_live` is the honest refusal when the bridging replica restarted. Revisit before scale-out. |
| **`AgencyHangupResponse.state` is an acknowledgement, not the terminal state** | documented on the type in `contracts.ts` | Open. The terminal write rides the bridge's `ended` lifecycle event and `emitLifecycle` does not await its listeners. A client needing the real terminal state synchronously would need sequencing machinery that does not exist. |
| **Roster supersede / `replace` mode is specified in master and not implemented in core** | `magick-master/src/agency/agency-roster-errors.ts:25`, `src/api/routes/proxy-agency-campaigns.routes.ts:763`, `src/config/index.ts:160` | Open. `AGENCY_ROSTER_REPLACE_ENABLED` is off, the two routes are registered only when it is set, and master holds the three refusal codes as a specification rather than a mirror because there is no `code:` literal in core to scrape. Migration `057`'s `mode` column and `058`'s replace-uncertainty flag are in place. |
| **MAG-104 — DNC publish failures are not alerted** | `magic-voice-core/src/utils/metrics.ts:1309` names MAG-104 as owning the counters on master's publish path | Open. Master has publish-outcome counters and publish-lag gauges (master `33b26ee`), but the alerting side is not built. |
| **`dispatchSettlement` is a no-op without `PLATFORM_SETTLEMENT_WEBHOOK_URL`** | `magic-voice-core/src/webhooks/settlement-dispatcher.ts:192-197` | Partly closed. A loud boot warning now exists (`warnIfSettlementUnconfigured`), and the attempt-batch path throws — but the per-call path is still deliberately a silent no-op at dispatch time. Treat the env var as a deployment prerequisite. |
| **The master ↔ cusui contract lane of the integration review never completed** | `docs/agency-dialer-fix-queue.md:501` | Open. That boundary is **unexamined, not clean.** Everything the fix queue reported came from the core↔master lane alone. Worth knowing before assuming a cusui/master mismatch would have been caught. |
| **MAG-99 — nothing enforces the agency `lint:test` zero line** | `docs/agency-dialer-fix-queue.md:390` | Unverified against the tree; no enforcing script was found. |
| **Over-dialing / predictive pacing is not built. Sized off real data 2026-09-11 — the gate is VOLUME, not the arithmetic** | §4, §7.3, §8 ("What over-dialing would actually buy") | Open **by decision**, added 2026-09-10, **substantially corrected 2026-09-11 once it was measured rather than modelled**. The tick still fans out one dial per idle agent and no more. Three corrections, each of which had been repeated as settled: **(1) The ratio is CONTINUOUS, not integral.** This row used to read "a 2% target allows 0, 0, +1, +2, +3 extra dials at m=1..5", which silently assumes you must place a *whole* extra dial every tick. You place one on a fraction `q` of ticks, so `q·pᵐ/(m+q)` is the cost and `q = B·m/(pᵐ − B)` the budget — and a ratio of 1.14 is as implementable as 2.0. At two free agents a 1.5% budget buys **≈+14% dials** (+11% to +17% across the measured `p` range), at three **+33%**. "Worthless at two agents" was an artefact of the integer framing. **(2) The agent floor is p-SENSITIVE, and higher answer rates make over-dialing WORSE** — more surplus dials connect. At p≈0.65-0.80 (the two earlier pilots' bridge rates) one extra dial at m=2 costs 14-21%, so the floor for a 3% ceiling is **5-7 agents, not 5**. Quote it as a range. **(3) `p` is no longer a guess.** 33 of 104 dials answered on the 2026-09-08 pilot, 19 of the remainder censored by the ring-cancel defect, so **p = 0.32-0.39, point ≈0.35** — which happens to validate the figure this row had been carrying. Read from the `'Agency attempt ended'` lines in Loki and cross-checked against `agency_abandonment_window_answered_24h`. ⚠️ **And the constraint that actually binds is neither gate.** A rate budget needs volume: at a 3% ceiling one abandoned call only comes in under the ceiling from **34** answered calls upward — the same `ceil(100/ceiling_pct)` as the guardrail's `singleAbandonSampleFloor`, and not a coincidence, since both ask when one call stops dominating the rate. The pilot peaked at **33** answered in 24h, i.e. a budget of **0.99 abandoned calls per day**. So a controller needs a **volume gate at that same threshold** alongside the rate budget, and at today's volume the correct behaviour is to decline to over-dial at all — without the gate it would spend the whole day's budget on its first extra dial. The carrier gate stands and is now the *efficiency* lever rather than a permission one: `cancelRinging` cuts the abandonment cost of the same pace by roughly 6-7×, which is what separates ≈+14% from the ×2 (40% talk share) the payoff table quotes. **Late binding does not substitute for any of it** — it fixes the idle *experience*, not the idle *time*. |
| **Master's agency zero-charge keys on the BRIDGE's outcome string, so an attempt core labels `abandoned` can still bill** | `magick-master/src/credits/settlement.service.ts` (`AGENCY_NON_CONNECTED_OUTCOMES`, and the guard at `:531`) | Open, narrow, added 2026-09-10. The settlement payload carries the bridge's outcome (`remote_hangup`, `agent_hangup`, …), never the agency attempt outcome, and only `abandoned` is listed. The genuine no-agent path is safe — `abandonAnsweredCall` stamps `abandoned` on the *bridge* outcome, so it zero-charges — and the `talk_time_seconds <= 0` arm catches pre-answer cancels. The residue is a leg answered and dropped before media negotiated (VoBiz, before its `<Stream>` connects) with talk time rounding to ≥1s: labelled `abandoned`, matching the SQL predicate, but billed the flat 25mc. Closing it properly means threading a `bridged` signal onto the settlement payload, which is a change to the byte-identical S2S fixture (§6.1) and belongs in its own change. **Found alongside it:** master's `NON_BILLABLE_STATUSES` (`:19`) holds `'cancelled'` — two Ls — while core's `WebRtcCallStatus` emits `'canceled'`, so that arm **can never fire for a core-originated cancel**. Harmless today, and structurally rather than luckily: every site that writes `canceled` does so as `session.answeredAt ? 'completed' : 'canceled'`, so `canceled` implies zero talk time and the `talk_time_seconds <= 0` arm catches it. It is a dead guard rather than a live overcharge, and the set is worth an audit — it mixes vocabularies from more than one producer (`'rejected'`, `'switched_off'` are in no `WebRtcCallStatus` either). |
| **Three adapters' `cancelRinging: true` is documentation-derived, not observed** | `magic-voice-core/src/telephony/{twilio,telnyx}/…`, and `exotel` is `false` for the same reason | Open as an evidence gap, added 2026-09-10. Twilio's `Status=completed` is documented as hanging up "even if it's already in progress" and Telnyx inherits the TeXML semantics, but neither has been observed cancelling a leg that was still ringing on this platform. Exotel publishes only "hangup a call in progress" and is therefore `false` — the helper fails closed, so an undeclared or unproven capability degrades to "we may not be able to recall this leg" rather than to a silent assumption. Confirm with a live capture before any predictive work leans on them. |
| **Two paths still leak the `reserved` state to a late-binding agent's console** | `agency.routes.ts` — the station socket's `ready` frame (`state: resumedState`) and `POST /sessions/:id/break/cancel` (echoes `live?.state`) | Open, added 2026-09-10, **and this row's first version was wrong on all three counts — corrected the same day after review.** (i) There were **three** such paths, not two: `POST /sessions/:id/break` echoed `live!.state` on both the response and the socket frame, and `breakMustWait` defers on `reserved`, so it was reachable by an agent simply pressing Break. (ii) The consequence is not "a bare Reserved chip": `StateRail.tsx` renders `reserved` as the **warning-toned banner "Ringing — get ready"**, with no panel and no presence button, for the 45–75s the carrier may take — so an agent who obeys it waits for a call that usually never arrives. That does not merely leave "residue of the ringing UI"; for the duration of the ring **it defeats late binding on that surface.** (iii) The fix was not blocked on the `AgencyAgentState` contract change this row claimed. `POST /break` is **closed**: the frame is now **suppressed** when `dialer.hasUnannouncedAttempt(sessionId)`. Suppression is strictly narrower than the rejected "report `available`" — it reports *nothing* rather than something false (`state` is authoritative by contract: "the console must not infer state"), and it offers no new affordance. Nothing is lost, because the pending break still reaches the agent by both its other paths: the HTTP response carries `pending_state`/`break_reason` (the only fields cusui's `requestBreak` reads), and `releaseAgent` sends the authoritative `agent_state` when the dial resolves — the one frame §5 documents as deliberately unsuppressed, for exactly this case. **Status of the three paths: `POST /break` and `POST /break/cancel` are both CLOSED** (the cancel route was missed on the first pass and caught by review — it would have handed the frame straight back to the agent who had just cancelled in silence). `break/cancel`'s suppression costs slightly more than the queue route's and the trade is recorded at the call site: cusui applies `stateBreakQueue(frame.pending_state, …)` unconditionally, so that frame's *omission* of the pending fields is what takes the queued-break pill down — withholding it therefore withholds a clearing signal. The response body clears the pill for the window that clicked and `ready` restates the empty queue on reconnect, so what is actually lost is a second concurrently-open console showing a stale pill until its next transition. **The `ready` frame remains OPEN** and is the only one of the three that genuinely needs the contract answer, because `ready.state` is a bootstrap that cannot simply be absent. |
| **Voicemail still reaches the agent under late binding, and the compensating fix was never scheduled** | §1 (D1, AMD out of scope), §7.3 (the 1s grace argument), `disposition-policy.ts` (`voicemail` is a built-in code) | Open, added 2026-09-10 after review found five sites claiming otherwise. Late binding removes the **ringing** popup; it does not and cannot remove voicemail. A machine answers exactly like a human as far as the carrier is concerned, D1 puts AMD out of scope, and §7.3's own grace-budget argument rules out any *gating* detector — so a voicemail answer is `connected`, bridges to the agent, and is distinguishable only by their `voicemail` disposition. Manas's original ask named voicemail explicitly, so **one third of that ask is unaddressed by this change.** The compensating design needs no carrier capability and no detection: a **zero-wrap-up voicemail hotkey** that hangs up and files `voicemail` in one keystroke, taking a voicemail from ~58s (40s of greeting plus 18.5s of wrap-up) to ~5s. Four of the pilot's 33 dispositions were voicemail. It was tagged `crit` and "ship independently" in the 2026-09-10 pacing recommendation and is the **only shipped-today lever on seat time**, over-dialing being blocked above — so "unrelated to parallelisation" is the wrong test for it. Recorded here so that whether it ships next is a decision someone makes, not one made by omission. |
| **`canceled` is now the third and most frequent producer on a shared 3-strike our-fault ledger, and nothing surfaces the retirements** | `magic-voice-core/src/agency/retry-policy.ts` (`resolveOurFaultRedial`, `OUR_FAULT_REDIAL_BOUND`) | Open, added 2026-09-10. Routing `canceled` to the our-fault ledger is the right call — it never spends the customer's allowance on a dial we stopped — but `our_fault_attempts` is a single per-contact lifetime counter shared with `agent_disconnected` and `orphaned`, hard-capped at 3 by `min(configured, OUR_FAULT_REDIAL_BOUND)` and unraisable by any operator. Three cancelled rings on one contact — or two cancels plus one dropped station socket — returns `contactState: 'exhausted'`: that contact is **never dialled again, was never spoken to, and its customer-side `attempt_count` allowance is left entirely unspent.** The pilot logged 26 agent cancels in 39 minutes on a two-agent floor, so if cancels cluster (a poor-quality list, an agent who reflexively skips) this erodes the roster silently. Two aggravating facts: the `OUR_FAULT_REDIAL_BOUND = 3` row above already flags that number as an unresearched placeholder on a regulated repeat-dial limit, and this change materially increases traffic through it without revisiting it; and no cusui surface presents the exhausted-by-our-fault cohort — `DEFAULT_RETRY_SELECTOR` is `['no_answer','busy','__none__']`, so the one-click Retry will not pick these contacts back up either. **Three things to decide:** re-derive the bound now that it is load-bearing; give the cohort a surface (a count on the campaign overview, or a companion retry preset); and consider a separate, higher bound for `canceled` than for the other two, since a cancel is a choice and a dropped socket is a fault. |
| **~~`sweepSilentStations` skips a session holding an unannounced dial~~ — CLOSED 2026-09-10 (second pass)** | `magic-voice-core/src/agency/runtime.ts` (the sweep's `if (this.dialer.hasLiveAttempt(entry.sessionId)) continue;`) | Open, added 2026-09-10, the residual half of closed item 9 below. The close-event path now arms a pre-bind grace, but a station socket that dies *silently* — no close frame, which is the ordinary shape of a dropped mobile connection — is only ever noticed by this sweep, and the sweep skips any session with a live attempt on the same false premise the close path had. So the abandonment window closed item 9 describes is narrowed, not eliminated. **Closed by review**: the sweep now arms the grace for such a session instead of skipping it, and `noteStationClosed` does not re-arm — so the second observer of one loss cannot slide the deadline forward. The rest of rule 1 still holds: the entry stays attached and the ownership key intact, because the reaper exclusion it provides must not be dropped from under an attempt that may still bind. |
| **Four carrier-webhook entry points still accept events for a call already claimed terminal** | `magic-voice-core/src/core/webrtc-bridge-manager.ts` — `handleVobizStatus`, `handleVoicelinkStatus` (both `!session` only); `handleProviderStart` and `handleVobizAnswer` are **closed** | Open (partly), added 2026-09-10. `endCall` sets `endHandled = true` roughly a hundred lines before `sessions.delete`, awaiting a carrier hangup and a repository write in between, so a session inside that window is still `sessions.get`-able. Every accept-side entry point must therefore test the terminal flags, not just `!session`. The two socket-accept sites and the two active ones are now guarded (see Closed, below). The two left are **lower risk rather than safe**: both route terminal events into `endCall`/`persistLateVoicelinkTerminal`, which are idempotent on `endHandled`. They were left because `handleVoicelinkStatus` **must** keep receiving `call.ended` during `ending` — that is the entire deferred-teardown mechanism — so the correct guard there is `endHandled` only, routing to the late-terminal path rather than returning, and that is a change to terminal-webhook routing whose blast radius exceeds its benefit in this change. |
| **`ready` / bootstrap still stamp `state: 'reserved'` for an unannounced dial** | `magic-voice-core/src/api/routes/agency.routes.ts` (the station socket's `ready` frame), `rehydrateAgent` → `AgencySessionBootstrap.state` | Open, added 2026-09-10, and the LAST of the three `reserved` doors. A mid-ring reconnect — the exact case the pre-bind grace exists for — repaints the warning banner "Ringing — get ready" for a call the agent was never shown. **The blast radius is now much smaller than when this was first recorded:** all three affordances an agent could act on it with are refused server-side — `/leave` 409s, `/break` queues silently, and `/available` now 409s too. So the residue is a misleading banner rather than a state an agent can act on wrongly. The fix §11 originally rejected — reporting `available` — is now *viable* for the same reason (the affordance argument it rested on is void), and is cheaper than the `AgencyAgentState` contract change: for an unannounced attempt the console would show an idle station, which is what the flag wants, and the real `reserved` still arrives at the bind. It was NOT taken here because `ready.state` is authoritative by contract and drives the whole rail, and changing what an authoritative field means is not a change to make at the end of a review pass. Decide it deliberately before the flag is enabled. |
| **`/available` refuses only an UNANNOUNCED live attempt, not an announced one** | `magic-voice-core/src/api/routes/agency.routes.ts` | Open, narrow, added 2026-09-10. `agents.set` is an unconditional Redis write rather than a CAS, so an `on_call` agent clicking Available also overwrites their own lease and can be reserved a second contact. That is pre-existing on a path late binding does not change — the wrap-up gate covers the case that matters in practice — so the new guard was deliberately scoped to the unannounced case it introduced. The general fix is a CAS in `AgentStateMachine.set`, or a `hasLiveAttempt` refusal here, and it wants its own change. |
| **`bridged_at` is written LAST in the `bridged` arm, and cannot simply be moved** | `magic-voice-core/src/agency/agency-dialer.ts` (the `bridged` arm), `agencyAgentSessionRepository.setState` | Open, added 2026-09-10 after the fix for it was tried and reverted. `bridged_at` is the sole discriminator between a conversation and an abandoned call, and its write sits behind a Redis write and the `on_call` mirror (a `SELECT … FOR UPDATE` + UPDATE + a `recordTransitions` INSERT, on a pool with no `statement_timeout`). Neither can *skip* it, but a process death in that window loses it permanently and nothing retries — the `bridged` phase fires once — so the attempt reads `bridged_at IS NULL` and the abandonment predicate counts a full conversation against the 3% ceiling. **The obvious fix does not work.** Moving that write first dispatches an `UPDATE agency_call_attempts` that takes a row lock and a pool connection AHEAD of the durable `on_call` mirror, delaying the mirror enough that it can land after a teardown has already written the agent away. Measured on the `AD-P2-X-01` chaos suite over three full serial runs each: `origin/main`'s ordering 3/3 green, reordered-and-awaited 3/3 failing, reordered-issue-then-awaited 3/3 failing — `restart-mid-bridge` ("agents never available") reporting `expected 'on_call' to be 'offline'`, i.e. an agent left durably on a finished call that the pacing tick will never reserve again. A reproducible stuck agent is worse than a rare lost timestamp, so the ordering stands and is now pinned by a test. **The real fix is to make the agent-session mirror order-safe** — that table has no `only_from` mechanism at all (see its own row above), so nothing stops a stale live-state write from overwriting a later terminal one. Solve that first; then the compliance write can move. |
| **~~The rollout's own abort criterion is not instrumented~~ — CLOSED 2026-09-10** | `magic-voice-core/src/utils/metrics.ts`, `agency-dialer.ts`, `wrapup-manager.ts`, `grafana/dashboards/magickvoice-platform-overview.json` (panels 78-84) | Closed 2026-09-10. §7.3 gated the week-long hold on "bind-latency p99 <150ms and zero bind failures" and neither half was measurable. **Now instrumented, on both pipelines** (at the time prom-client + OTLP, because Grafana Cloud is fed by OTLP and a prom-only metric is invisible exactly where an operator looks; since 2026-09-30 core #404 removed prom-client and each is a single OTel instrument): `agency_bind_latency_seconds` around the `reserved`-send/`bindBorrowedBrowserLeg` pair, measured from the **carrier's** answer instant so it includes webhook transit — the predicate counts that too — and `agency_bind_total{result}` beside it, because **a bind that never happened records no latency, so a rollout watching only the p99 sees it IMPROVE as binds start failing.** Four more series shipped with it, and the reason each exists is that a pacing argument had already been lost for want of it: `agency_attempt_hold_seconds{outcome}` (**the pivotal one** — two independent analyses disagreed on whether an unanswered dial holds an agent for ~31s or ~55s and neither could settle it; the `outcome` split is load-bearing because the pilot's largest waiting block was busy signals, which no ring timeout can touch), `agency_answer_latency_seconds` (prices a ring timeout and supplies the clustering term §11's flat `p` cannot), `agency_wrapup_seconds{resolution}` (the only measurement of the disposition-speed work), and `agency_our_fault_retirement_total` (see the row below). The `reason` label was **not** added to `agency_abandoned_total` — that terminates a live series which is the compliance numerator; `agency_abandoned_reason_total` rides alongside instead, and `sum(rate(...))` of the two should track. All of these are per-replica counters/histograms and take `sum(rate(...))`, the **opposite** of the SQL-derived gauges beside them on the same dashboard. |
| **~~The abandonment auto-pause has NO MINIMUM SAMPLE~~ — CLOSED 2026-09-11** | `magic-voice-core/src/agency/abandonment-guardrail.ts` (`breachedRows`, `singleAbandonSampleFloor`) | Closed 2026-09-11, and it was a **live defect** rather than a bug avoided. `breachedRows` read only `measured` and `ceiling_pct` and never either term of the fraction, so **one abandoned call out of one answered call read 100% and paused the campaign** — permanently, because refusal 3 means nothing ever un-pauses it. A single dropped station socket took a campaign off the air until a supervisor noticed. ⚠️ The protection was already described in the codebase as though it existed: the gauge block in `metrics.ts` justifies exporting the numerator and denominator separately with *"a rate alone cannot distinguish 1-abandoned-of-1 from 30-of-3000, and the auto-pause guardrail reads this"* — and the guard consumed neither. **Fixed as refusal 4**, scoped as narrowly as the pathology: a breach is suppressed only when its numerator is a SINGLE call *and* its denominator is below `singleAbandonSampleFloor(ceiling)` = `ceil(100/ceiling_pct)`, the point from which one abandon can clear the ceiling at all (34 at 3%). So `1 of 1` and `1 of 33` are suppressed; `2 of 2`, `20 of 25` and `4 of 100` all still pause, the last unchanged. ⚠️ **The two terms are not independent for a real ceiling** — added 2026-09-11 after a reviewer asked what the denominator term rejects that the numerator term does not, and for any *positive, finite* ceiling the answer is *nothing*: reaching the gate means `100/answered > ceiling`, so `answered < 100/ceiling ≤ ceil(100/ceiling)` always, verified exhaustively over ceilings 0.1-100 and samples 1-5000. ⚠️ **It is NOT redundant at `ceiling <= 0` or `NaN`, and there it is the only thing keeping the path correct** — the proof divides by the ceiling and says nothing at zero, the floor short-circuits to 0, so `answered < 0` is false and such a campaign pauses on its first abandoned call (fail-closed). Deleting the conjunct reds exactly ONE test, the non-positive-ceiling one — which is how a guardrail gets silently disabled by someone who has just read that a term is "implied", so the code comment now says DO NOT DELETE and both the implication and its exception are pinned. `Infinity` is the opposite case and is pinned separately: it exits at the ceiling comparison and never breaches at all, which is the right reading of "any rate is acceptable". Refusal 4 as it stands is exactly *"a single abandoned call never pauses a campaign"*, and `1 of 33` is suppressed because one call cannot breach 3% above 33 answered at all — not because 33 is under a separate floor. Both terms stay: the conjunct does real work the moment the numerator gate widens (at `abandoned <= 2` it separates `2 of 66` from `2 of 67`), and the floor must exist as a named export because cusui mirrors it. The implication is now pinned as a property test, so re-basing `abandonmentRatePct` onto a different denominator fails loudly instead of silently narrowing the guard. The floor is derived from the campaign's own ceiling because a constant is right for exactly one ceiling, and `ceiling_pct <= 0` short-circuits to 0 — `100/0` is `Infinity`, which would have left such a campaign impossible to auto-pause, a compliance guardrail silently disabled. That guard is **defensive, not a supported setting**: migration `089` CHECKs `abandonment_ceiling_pct > 0` and master's config rejects a zero ceiling outright (*"an operator who wants no dialing has `pause`"*), so no row can hold one — but `ceiling_pct` reaches the function through a LEFT JOIN typed nullable, and returning 0 fails closed. Worst case admitted: **one** abandoned customer before the guardrail can act, against the status quo's zero. Rejected alternatives, both of which look reasonable: a plain denominator floor lets `20 of 25` run; a Wilson 95% lower bound still fires on `1 of 1` (~21%) while **refusing** `4 of 100` (~1.6%) — loosening the guardrail on the only shape that matters. Pinned by 7 tests, each falsified four ways. **Cross-repo consequence, found by reading the surface rather than the diff**: cusui's health strip said *"The campaign pauses itself above it"* unconditionally, which this change made **false** in exactly the case a supervisor meets first — the first abandoned call of a fresh campaign. And it fails in the worst direction: that sentence beside a campaign still visibly dialing does not read as a small-sample nuance, it reads as a broken guardrail, and the next move is to stop it by hand. `abandonmentReadout` now derives the same `ceil(100/ceiling)` threshold from the two counts the payload already carries (no contract change) and says the campaign keeps dialing and why, falling back to the promise when the counts are absent — the pause is the norm and the suppression the exception. The band and the number are deliberately untouched: this changes what we PROMISE, never what we report. |
| **An `abandoned` attempt spends the CUSTOMER's retry allowance, so two calls we dropped retire the contact** | `magic-voice-core/src/agency/agency-dialer.ts` (`ourFaultBeforeBridge`), `retry-policy.ts` (`DEFAULT_RETRY_POLICY.abandoned`), pinned by `test/unit/agency/canceled-outcome-ledger.test.ts` | Open **as a decision**, added 2026-09-10 after the change was written and then reverted. `ourFaultBeforeBridge` lists `agent_disconnected` and `canceled` and not `abandoned`, so an abandoned attempt falls to `resolveRetryDecision` with `bump_attempt: true` against `abandoned: { max_attempts: 2 }` — **we hang up on a customer twice and then retire them `exhausted`.** The two readings are both defensible and both written down. FOR the status quo (on the pinning test): they picked up and were inconvenienced, so it is a real attempt against them and their own rule applies; the our-fault ledger is for calls that never reached anybody. AGAINST: `retry-policy.ts`'s own table says those caps "are the CUSTOMER's allowance and apply only to an attempt that actually reached them (a drop *after* bridging)", and an abandoned attempt has `bridged_at IS NULL` by definition. The tie-breaker is a **repeat-dial judgement**, because moving it RAISES the maximum number of times one person can be called (our-fault bound 3, and their own allowance left unspent) — so it was left alone rather than decided from inside a pacing task. Routing it would be safe mechanically: `resolveOurFaultRedial` falls back to `OUR_FAULT_REDIAL_BOUND` and the default delay rather than returning `no_policy_for_outcome`, which matters because master sends `retry_policy` on no campaign. **The evidence to decide it now ships**: `agency_abandoned_reason_total` splits the causes. Note the discriminator is NOT `no_agent_available` — that value is declared and unproducible until over-dialing exists (see §6.4) — it is `station_lost` and `unattributed`, i.e. abandonments caused by our own sockets and bridges rather than by the customer being unreachable. If those dominate, we are retiring people for our own failures and the answer is one clause. `bridge_late` must stay on the customer's side either way — that call did bridge. |
| **Wrap-up cannot be pre-dialled into, because in the ordinary configuration it has no end** | `magic-voice-core/src/agency/wrapup-manager.ts` (`endsAt`, `onExpiry`, `noteDisposition`) | Recorded 2026-09-10 as a **refuted lever**, so it is not re-proposed. "Dial for an agent while they are in wrap-up and bind at the answer" is the one cycle lever late binding appears to unlock, and it was recommended by an independent analysis. The code refutes it for the dominant shape: `requiresDisposition` is true for any `connected` outcome with a non-empty catalog and master injects `DEFAULT_DISPOSITION_CATALOG` on every campaign create, so nearly every wrap-up is **timerless** — `onExpiry` sets `endsAt = null` and `heldReason = 'disposition_required'`, and it ends only when the agent submits. There is no deadline to schedule a dial against. Truncating it to bind a new call is worse than it looks: `cancel()` deletes the entry and `persistEnd` writes the attempt `ended` with a `wrapup_ended_at`, so the lapsed-wrap-up sweep will not catch it either and the disposition is **silently lost** — exactly the structural data loss the timerless design exists to prevent. Wrap-up therefore yields only to being made SHORTER (a voicemail hotkey, a keyboard map — the pilot filed zero of 32 dispositions by keyboard), which is measurable for the first time via `agency_wrapup_seconds{resolution="disposition_submitted"}`. |
| **Three reported campaign numbers move under customers on the day this ships, with no annotation and no backfill** | `magic-voice-core/src/db/repositories/agency.repository.ts` (`attempts_connected`), the `by_last_outcome` breakdowns | Open as a communications gap, added 2026-09-10. The classifier fix moves no *compliance* metric — the numerator keys on `isAbandonedAttempt`, not the label — but it does move numbers people have already read. `attempts_connected` **falls** (the answered-never-bridged shape used to classify `connected` and now classifies `abandoned`); `abandoned` **falls** by the phantom rows the ring-cancel defect was manufacturing; and `canceled` **appears** as a new bucket in every outcome breakdown and filter. A supervisor comparing this week to last sees two drops and a new bucket with nothing on screen to explain them — three discontinuities that read as a performance regression. No backfill exists and none is proposed. **"We do not relabel history" is a perfectly good answer; it just has to be written down**, or the first person to notice assumes a bug. Related: the pilot's published 33 "bridged" / 32% bridge rate is now known to be an overstatement, and the debrief artifact still presents it as measured — decide whether to restate or mark superseded. |
| **The `dialing` state write is unguarded** | `magic-voice-core/src/agency/agency-dialer.ts` | Open, added 2026-09-10, judged safe. Not the `MAG-137` resurrection shape: it is awaited before `liveByAttempt` registration and before the dial, so no lifecycle event for the attempt can exist yet, and the only other writer is the reaper — whose sweep needs the row older than `LEAK_THRESHOLD_MS` **and** the agent's station key absent, neither true for a row the dispatcher just claimed for a live agent. `only_from: ['queued']` would be the same shape and equally safe; it was left as speculative churn on the hot dial path rather than declined. |
| **The agent-session state mirror has no `only_from` mechanism at all** | `agencyAgentSessionRepository.setState` | Open, added 2026-09-10. Different table from the attempt row, an unconditional UPDATE under `FOR UPDATE` plus a transition log, and an explicitly best-effort mirror of authoritative Redis. Two writers can race and the loser wins, which misreports the supervisor's agents-by-state breakdown and nothing else — no compliance or billing consequence. Not the `MAG-137` shape; a fix needs a different mechanism, so it is recorded rather than folded in. |
| **Master's error-mask drift snapshot is stale** | `magick-master/test/fixtures/core-agency-error-codes.json`, §6.3 | Open as a chore, measured 2026-09-10. The fixture records core `222dc25` against `origin/main` at `c3dc167`, so `error-mask.agency-contract.test.ts` is red. The three codes it is behind on (`retry_selection_empty`, `retry_selection_too_large`, `retry_generation_exceeded`) **are** correctly mirrored in master's allow-list and cusui's union, so nothing is masked — only the artifact is stale. Fix is `npm run snapshot:core-agency-codes`, and it belongs in its own commit: regenerating it silently absorbs any *real* un-mirrored code that landed in the same window, which is the one thing the detector exists to catch. |

### Closed 2026-09-10 — the four gating defects from the pilot

Each was found by tracing the 2026-09-08 pilot's own attempt rows against Loki, and
each gated the late-binding work rather than merely accompanying it.

1. **A cancelled ringing call kept ringing, and answered into a dismissed console.**
   All 26 `local hangup` lines in the pilot window carry `intent: "agent_hangup"`,
   `originator: "magickvoice-customer-ui"`. On VoiceLink `localHangup` tore the leg
   down by closing `session.pstnWs` — which does not exist until the carrier answers
   — and the adapter's `endCall` is a documented no-op. Traced on callId
   `064836f1-8915-49f8-9c5a-c741f3cdd2af`: dial 10:36:04.155 → ringing 05.126 →
   agent hangup 09.541 → PSTN leg connects and `call.answered` 12.44 → relay open
   12.454 → ended 27.968 `status: completed`, `talkTime: 16`, 769/668 frames,
   settlement dispatched. **Structural, not intermittent.** Fixed by finalizing an
   unanswered VoiceLink teardown immediately: the session leaves `this.sessions`, so
   the carrier's later `pstn-stream` connect hits `attachPstnLeg`'s unknown-call
   branch and the relay never opens. The consequence for the pilot's own numbers is
   that its "33 bridged / 32% bridge rate" **overstates** in both directions.
2. **The classifier read `answered` where it meant `bridged`** — see §5's outcome
   section for the full account.
3. **`CARRIER_END_CONFIRM_TIMEOUT_SECONDS` was 20s for every VoiceLink teardown**,
   including one where nothing had been answered, so a cancelled attempt held a
   concurrency slot in `ending` limbo for 20s with nothing to wait for. Now split:
   0 when unanswered, 45s when answered (VoiceLink reports terminal state at
   dial+45–75s).
4. **The dialer had no live concurrency signal at all** — see §8.

Two more closed alongside them: **`MAG-137`** (the `bridged` write had no `only_from`
guard, so a late write could resurrect an ended attempt and the reaper would then
overwrite its real outcome — and note the guard is `only_from: ['dialing',
'answered']`, where `'answered'` is load-bearing rather than defensive: under late
binding the `answered` write is issued first and normally wins the row, so mirroring
the `answered` write's `['dialing']` verbatim would leave every *connected*
late-binding attempt reading `answered` for the whole conversation. `only_from`
guards only the `state` column — every timestamp is an unconditional `COALESCE` —
so if anyone converts it to a `WHERE` clause, `bridged_at` stops landing and the
abandonment predicate starts counting genuinely-bridged calls as abandoned, which
feeds the auto-pause) and a `bridged` **double-emission** that late binding
would have introduced on VoiceLink — the bind is re-entrant inside `anchorAnswer`,
so `handleProviderStart` announced the bridge twice in one turn, rewriting
`bridged_at` with the later instant. `bridged` is now at-most-once per call
(`WebRtcBridgeSession.markBridged`), which is a deliberate **change** from the prior
behaviour where a mid-call PSTN re-connect re-emitted.

Also added, as groundwork rather than a fix: `ProviderCapabilities.cancelRinging`
(§11 "Still open" records which adapters answer it and how confidently), and a WARN
on any pre-answer teardown against a carrier that cannot recall a ringing leg —
that log line is what the pilot lacked, and it is the signal that should fall to
roughly zero once late binding is on.

### Closed 2026-09-10 (second pass) — found by an independent three-persona review

The review ran after the work above was declared finished, which is the point: three of
these four were invisible in the implementation reports and only showed up in the diff.

5. **`attachPstnLeg` and `attachBrowserLeg` accepted a leg for a call already claimed
   terminal.** `endCall` sets `endHandled = true` about a hundred lines before
   `sessions.delete`, awaiting a carrier hangup and a repository write in between, so
   `!session` alone is not a terminal check. Reproduced by holding the repository write
   open — ordinary loaded-Postgres latency, not an exotic stall. Inside that window the
   ring-cancel path **re-manufactured the very defect it exists to remove**: the relay
   opened onto a dismissed console, `answered` landed a phantom entry in the compliance
   DENOMINATOR, and the `ended` arm saw `bridged: true` and classified `connected` —
   which is `max_attempts: 0`, **permanently retiring a contact nobody had spoken to.**
   Under late binding the same window produced the mirror: a refused bind, an apology
   clip, and a phantom `abandoned` against the 3% ceiling. `attachPstnLeg` refuses on
   `endHandled || ending` (safe because the single writer of `ending` sits below the new
   pre-answer early return, so `ending ⇒ answeredAt !== null`, and the carrier's
   confirmation arrives on the webhook path, never here); `attachBrowserLeg` refuses on
   `endHandled` **only**, deliberately, because during `ending` a reconnecting console
   still needs to learn the call ended.
6. **`handleProviderStart` and `handleVobizAnswer` had the same gap one layer in.**
   `attachPstnLeg`'s guard refuses a *new* connect, but a leg attached before the
   terminal claim already holds its message handlers — so the media `start` frame
   reached `anchorAnswer` + `emitBridgedIfLive` on a settled call. `handleVobizAnswer`
   was the more active version: it does not merely accept a leg, it **returns the
   `<Stream>` answer XML that invites the carrier in**, so refusing the later media
   connect did not undo the phantom answer it had already anchored.
7. **The compliance write was third of three in the `bridged` arm.**
   `agencyAttemptRepository.setState(…, 'bridged', { bridged_at })` sat behind a Redis
   write and the `on_call` mirror (a `SELECT … FOR UPDATE` + UPDATE + a transition
   INSERT, on a pool with no `statement_timeout`). Neither can *skip* it, but both can
   block it unboundedly under row-lock contention — and with late binding `bridged_at`
   is the **sole discriminator** between a conversation and an abandoned call, so
   anything that ends the process in that window (a deploy's SIGTERM, an OOM, a starved
   event loop) records a fully-conversed call as `abandoned` against the regulatory
   ceiling and feeds the auto-pause. Nothing retries it: the `bridged` phase fires once.
   Now ordered **frame → compliance record → bookkeeping**. It depends only on `ev` and
   `bridgedAt`, and nothing below it depends on it. Note this **removed one of the two
   windows in which the MAG-137 race could be staged**, so that test now parks the
   attempt write itself rather than `agents.set` — a more direct staging of the race it
   was always about.
8. **`POST /sessions/:id/break` leaked `state: 'reserved'`** — see the corrected row
   above, which also records what the first version of that row got wrong.

9. **Nothing ended a ringing unbound dial when the agent's station socket dropped, so
   late binding was adding an abandonment source of its own.** `releaseStationOnClose`
   declines to act mid-attempt on a stated premise — "the deferred hangup now owns the
   outcome" — and `sweepSilentStations` skips the session for the same reason. **That
   premise holds only after the bind.** The hangup it names is `hangUpForBrowserClose`,
   installed by `registerBrowserLegHandlers` on the *browser* socket, and an unbound dial
   has none (`createUnboundBridgedCall` takes `Omit<…, 'browserSocket'>`).
   `browserCloseGraceMs` is carried on the unbound dial but the bridge only reads it back
   at the bind. So during the ring nothing at all was watching: the dial ran to the
   carrier's answer, `stations.send` failed on the closed socket, `bindFailed` was set, and
   `abandonAnsweredCall` played an apology to a real customer and wrote an **`abandoned`**
   attempt — matching `ABANDONED_ATTEMPT_PREDICATE_SQL`, charged against the **3%
   regulatory ceiling** and feeding the `AD-P4-C-02` auto-pause. The identical network blip
   under early binding produces a harmless `canceled`. Fixed with a pre-bind grace in the
   agency layer (`AgencyDialer.noteStationClosed`, armed from `releaseStationOnClose`),
   which gives the ring window the same `DEFERRED_HANGUP_MS` the post-bind window already
   had. **A timer rather than an immediate hangup, deliberately:** the `answered` arm reads
   `socketFor` fresh, so an agent whose socket blips and reconnects still gets the call, and
   an immediate hangup would have destroyed that self-healing. The dial is ended
   `agent_disconnected` — the outcome *both* dial paths already declare as
   `browserHangupOutcome`, so the two binding modes record the same fact, and on an
   unanswered call it maps to status `canceled`, which the classifier reads as attempt
   outcome `canceled`: our-fault ledgered, never `abandoned`.
   **Residual, not fixed:** a socket that dies *silently* (no close event) still arms
   nothing, because `sweepSilentStations` skips any session with a live attempt. That sweep
   needs the same `hasUnannouncedAttempt` exception, and it is recorded above rather than
   folded in here.

Also corrected in this pass, without code changes: five sites claiming late binding
suppresses **voicemail** (it cannot — see the new open item); `metrics.ts`'s claim that
`sum(agency_live_attempts_current)` reconciles with the pacing tick (it is a fleet-wide
gauge published by every replica, so the correct reduction is **`max`**, and `sum`
over-reports by the replica count — the same rule `agency_abandonment_rate_24h` already
follows on the platform dashboard); the `ringing` state named as a dials-in-flight label
when nothing in the codebase writes it; §6.4's retry-policy-keys row, stale at 7 keys
with a drifted line reference; and the Leave refusal's claim of a "campaign ring
timeout", **which does not exist** — `ringTimeoutSeconds` is populated from a DID on the
inbound path only, and what actually bounds the wait is the carrier's 45–75s terminal
report, which the agent-facing copy now discloses.

`agency_live_attempts_current` also gained its first consumer: a `max by (state)` panel
on the cross-service dashboard, which puts it under `scripts/validate-grafana-dashboard.test.mjs`
so a rename in `metrics.ts` now reds a test instead of silently emptying a panel.

### Closed since those documents were written

Listed so you do not chase them; each was checked in the tree, not inferred from a
commit subject. **B1** console audio · **B2** the disposition pad locking at
wrap-up (fixed on both sides — core emits `agent_state{wrapup}` at
`wrapup-manager.ts:295`, cusui unlocks from four signals at
`useAgencyConsole.ts:597-602`) · **B3** the `agent`-role infinite spinner
(`FeatureFlagsContext` is now terminal once account resolution has *settled*
without an account) · **B4** a never-touched DNC list blocking every dial
(self-heal + outbox) · **D1** silently discarded roster top-up (migration `083`) ·
**D2** the phantom `description` field · **D3** dead `default_country_code`
plumbing · **MAG-100**, **103**, **107**, **109**, **110**, **116**, **120**,
**136**, **138**, **143**, **146**, **148**, **151**, **153**, **154**, and the
fixture's `invalid_dnc_scope` obligation on master (§6.1).

> **Doc drift, summarised.** `docs/agency-dialer-delivery-plan.md` is a mid-build
> snapshot: it references `feat/agency-dialer` branches in all three repos (all
> merged to `main`), core `v1.72.0` / master `v1.51.1` / cusui `v2.41.0` (now
> `1.81.1` / `2.1.1` / `2.49.0`), and its ticket states are stale. Read it for the
> *shape* of the plan and the ticket vocabulary, not for status.
> `docs/agency-dialer-session-state.md` is a working log and is stale by
> construction. `docs/agency-dialer-design.md` is still the best statement of
> *intent*, and its own header already warns that "every remaining line-number
> citation here [is] a claim to verify, not a fact." Root `CLAUDE.md` no longer
> pins submodule versions at all — read them from `git submodule status`.

> **Reference copy, verbatim below this box.** Origin: MagickVoice-platform (superproject) @ `e32a5db` (HEAD, 2026-10-05), path `docs/agency-dialer-design.md`. Copied into Magick Agency on 2026-10-09; not kept in sync.
>
> **How this maps to Magick Agency:** The dialer's architecture (D1–D11, §7b scope isolation). The runtime design (leases, pacing, abandonment, wrap-up, reaping) is what agency's `apps/server/src/agency/` ports verbatim. The split of responsibilities between core and master, and every settlement section, do not apply: one process, no billing.
>
> Index of all copies: [`docs/reference/README.md`](../../README.md).

# Agency Dialer — Architecture & Delivery Plan

**Status:** Phase 0 built and merged to `feat/agency-dialer` in all three repos;
D1–D11 settled (§0.1); Q-D open but non-blocking (§10)
**Review:** an adversarial pass against the live tree found 2 blockers and 7
majors, all fixed — the reservation-lease lifecycle (§6.1), the
CSV ingestion reality check (§2.2.1), the borrowed-socket contract (§7), the agent
hang-up permission hole (§9), a vacuous uniqueness index (§2.1), missing crash
recovery (§6.2), and disposition-driven voicemail retry (§2.4).
**Build corrections:** implementing Phase 0 falsified four further claims made
here, all now fixed in place — §4.1 cited an index (`uq_agency_contact_in_flight`)
that does not and cannot exist; §5.1/§4.3 still specified the flat 20s lease that
§6.1 exists to delete; §6.1's own `wrapup` row used a business number as a TTL,
violating its stated invariant; and §7 claimed a re-attach grace window that the
bridge does not have (§7.1). Treat every remaining line-number citation here as a
claim to verify, not a fact.
**Companion documents:** `agency-dialer-delivery-plan.md` (71 tickets, 130 person-days),
`agency-dialer-test-plan.md` (quality gates per phase), `agency-dialer-ux-spec.md`
(+ clickable prototype under `docs/prototypes/`).
**Scope:** human-agent outbound power dialing for telephony agencies
**Repos touched:** `magic-voice-core`, `magick-master`, `magick-comms-cusui`

---

## 0. What already exists (and what that buys us)

Before proposing anything, here is what the platform already has that this feature
can stand on. Every claim below was verified against the tree at
core `v1.72.0` / master `v1.51.1` / cusui `v2.41.0`.

| Capability | Where | Reusable as-is? |
|---|---|---|
| Human↔PSTN media bridge (browser WS ⇄ core ⇄ carrier WS) | `magic-voice-core/src/core/webrtc-bridge-manager.ts` (1297 lines), `webrtc-bridge-session.ts` | **Media path yes, initiation flow no** — see §2.3 |
| Telephony provider abstraction incl. BYO SIP egress | `src/telephony/{vobiz,voicelink,twilio,plivo,telnyx,exotel,z99,generic-sip}`, `src/telephony/types.ts`, `resolveSipDial()` | **Yes, untouched** |
| Atomic Redis concurrency guards (Lua acquire/release, lock + counter + generation, drift reconcile) | `src/core/{concurrency-guard,account-concurrency-guard,provider-concurrency-guard}.ts` | **Pattern yes** — agent reservation is the same shape |
| Per-account call queue + dequeue-on-slot-free coordinator | `src/core/call-queue-coordinator.ts` (1015 lines) | **Pattern only** — it paces on *carrier* capacity, not *agent* capacity |
| CSV upload → S3 → parse → E.164 normalize, per-row error report | `magick-master/src/contact-lists/{csv-parser,contact-list.service}.ts`, migration `011_contact_lists.sql` | **Partially — needs real work, see §2.2.1.** `MAX_ROWS = 10_000` (`csv-parser.ts:4`), whole file buffered in memory, and the phone column must literally be named `phone` (`csv-parser.ts:76`) |
| Chunked bulk dispatch over SQS with completion tracking | `magick-master/src/queue/`, migrations `017`, `049` | **No** — fire-and-forget batches, not a feedback loop |
| Caller-ID pool inventory (`phone_numbers`, per-number `max_concurrent_calls`, `pool_eligible`) | `magick-master` migrations `010`, `037` | **Yes** |
| Post-call analysis (transcribe + summarize a dialer recording) | `src/core/dialer-analysis-*.ts`, flag `dialer_call_analysis` | **Yes, opt-in per campaign** |
| Four gating layers (RBAC / governance capability / core feature flag / route guard) | see root `CLAUDE.md` | **Must extend all four** |

**What does not exist:** any notion of an *agent* as a stateful, addressable
resource; any Do-Not-Call list (`grep` for `do_not_call|dnc` returns one unrelated
prompt template); any calling-hours enforcement; any pacing loop driven by human
availability.

### 0.1 Decisions taken

Recorded here because each one removes a branch from the design below.

**D1 — Pacing is strict power dialing. `overdial_ratio` is fixed at 1.00 for v1,
and AMD is out of scope.** An agent is reserved before every dial. Agents will
hear answering machines and disposition them by hand; that cost is accepted in
exchange for structurally-zero abandonment and no AMD dead air. The
There is **no `overdial_ratio` column** (D9 removes the whole concurrency-knob
surface). The v2 predictive-pacing seam is the tick expression in §4.2, not a
column — predictive pacing replaces `available_agents` with
`available_agents × f(answer rate)` and changes nothing else.

*Consequence:* the disposition catalog ships with a mandatory built-in `voicemail`
code, and retry-on-voicemail is driven by that **disposition**, not by a carrier
AMD signal. The supervisor dashboard reports *human connects* and *machine
connects* separately, derived from dispositions, so AHT is not silently inflated
by voicemail time.

**D2 — Core is single-replica today and stays that way for this feature.** The
ownership design in §3 ships as a **same-process registry with the cross-replica
seam in place**: the Redis ownership key is written and read, and dial dispatch
goes through a `DialDispatcher` interface whose only v1 implementation is a direct
local call. Redis pub/sub routing and per-replica advertised webhook hosts are
deliberately *not* built. What this buys: when core does go multi-replica, the
change is one implementation of one interface plus the `WebhookUrlBuilder` host
parameter — not a rewrite of the dial path.

*Consequence:* two things must be true operationally and are called out in §12 —
a core restart drops every live bridge **and** every agent station socket, so
agents must survive it. Station sessions are therefore rehydrated from
`agency_agent_sessions` on reconnect rather than recreated, and agents land in
`break` (not `available`) after a restart so the engine cannot dial into a pool
that has not actually re-attached. Campaigns auto-resume once agents return.

**D3 — Agents are full platform users.** An agent is a `memberships` row; identity,
Firebase auth, RBAC and audit attribution are all inherited with no new identity
model. `agency_agent_sessions.agent_user_id` holds master's user id, opaque to
core, as drafted in §2.1. **The role they hold is the new `agent` role defined in
D6** — not `operator`. D6 supersedes this paragraph on that point; there is exactly
one RBAC model in this design and it is D6's.

**D4 — Contact timezone: mapped column, else campaign default. Never inferred.**
The operator may map one CSV column as an IANA timezone (or a country column we
resolve to one); absent that, the campaign default applies. Area-code inference is
explicitly rejected — NANP area codes cross timezone boundaries and number
portability has decoupled prefix from location, so an inferred timezone that puts a
call outside legal hours is worse than an honest default.

**D5 — Auto-connect, with a countdown.** On `reserved`, the station socket emits a
3-2-1 countdown the agent hears locally; audio bridges automatically on answer.
No accept button — it would add 1–3s of dead air on the customer side for every
call, which at volume is the difference between a good and a bad connect rate.

**D6 — Tenant = the agency. Account = one agency client. New `agent` role.**
Eight clients means eight accounts under one tenant. An agent is a `memberships`
row scoped to an account, so an agent who works three clients holds three
memberships — explicit and auditable, which is the right trade for a compliance-
sensitive product.

The `agent` role slots into the existing linear hierarchy **below `viewer`**:

```ts
// magick-master/src/rbac/roles.ts — and mirrored in cusui src/utils/permissions.ts
export const ROLE_HIERARCHY = {
  agent: 5,            // NEW — dialing-only, sees nothing else
  viewer: 10, operator: 20, account_admin: 30, tenant_admin: 40, tenant_owner: 50,
};
```

This is exactly the "limited privileges" shape asked for, and it works *because*
the hierarchy is linear. `PERMISSION_MATRIX` maps each permission to a **minimum**
role, so:

- Every existing permission has a floor of `viewer` (10) or higher — verified
  against `roles.ts`. An `agent` at 5 therefore inherits **nothing**: no campaign
  list, no analytics, no contacts, no other agents' calls, no recordings.
- The four new agent permissions get a floor of `agent`, so supervisors and admins
  inherit them and can take calls themselves to cover or demo — which is desirable,
  not a leak.

```ts
'agency.station.connect' : 'agent',   // open a station socket, join a campaign
'agency.attempts.handle' : 'agent',   // receive a bridged call, hang up
'agency.attempts.dispose': 'agent',   // disposition, notes, schedule callback
'agency.dnc.write'       : 'agent',   // mark the contact on the line as DNC
```

*Two mechanical follow-ons:* `MembershipRole` is a string union in
`magick-master/src/db/models/membership.model.ts:1` and `Role` is its mirror in
cusui `src/types/auth` — both need the new member, and cusui's `ROLE_LEVELS` needs
`agent: 5`. Neither has a `viewer`-is-the-floor assumption to break.

**D7 — Billing: per connected call, with every dial attempt tracked and charged.**
Two new operations on the existing `credit_rate_cards` table, both per-unit (the
`calculateActualCostPerMessage` path, not the per-minute path):

| operation | unit | rate | when |
|---|---|---|---|
| `agency_connected_call` | `call` | **25 millicredits** | attempt reaches `bridged` |
| `agency_dial_attempt` | `attempt` | **0.2 millicredits** | every dial placed, connected or not |

Not billed by talk time, so `webrtc_call` (250mc/min) is **not** charged for agency
legs — the bridge's settlement call must pass the agency operation instead. That is
a real branch inside `dispatchSettlement`'s caller, and it is why `webrtc_calls`
carries `campaign_id` (§2.1): its presence selects the rate.

*One implementation wrinkle worth stating plainly:* `rate_millicredits` is a
`BIGINT` column (`002_credits.sql:77`) and the billing math is `BigInt` throughout,
so **0.2 millicredits per attempt is not directly representable**. Resolution: attempts are counted per campaign and
settled in **batches** — hourly and at campaign end — as `attempts × 2 / 10`, exact
for any multiple of 5 with the remainder carried into the next batch. This also
satisfies "track all the calls" with one settlement event per hour instead of one
per dial, which matters at volume. If you would rather avoid the accumulator, the
zero-new-code alternative is 1 millicredit per attempt — but that is 5× your number,
so I have kept your number and paid for it with the batcher.

**D8 — Primary market India, but no jurisdiction-specific logic in v1.** Calling
hours, the DNC list and the abandonment metric ship as **generic, operator-
configured** mechanisms with neutral defaults. No TRAI-specific ceilings, no
prescribed message text, no regulator-specific retention rules. The abandonment
rate is measured and displayed; the auto-pause ceiling ships as a plain
configurable number defaulted to 3%, not as a compliance claim. Localisation is a
later iteration and the mechanisms are already the right shape for it.

**D9 — Concurrency is the account's existing concurrency. No new knob.**
`agency_campaigns` therefore drops the `concurrency` and `overdial_ratio` columns
entirely. The tick target becomes:

```
to_dial = MAX(0, MIN(account_settings.max_concurrent_calls − occupied, idle_agents))
```

An account set to 5 runs at most 5 simultaneous attempts; if all 5 agents are
talking, `available_agents` is 0, `target` is 0, and dialing pauses — the same
single expression resumes it. `acquireTelephonyConcurrency` stays the *authority*
(the target is an optimisation that avoids burning reservations on calls the guard
would refuse), and because agency legs share that counter with AI calls, an account
cannot exceed its ceiling by running both.

*Consequences:*
- The supervisor's "adjust concurrency live" control edits the **account setting**
  — not a campaign field. See **D10**: that setting is not customer-editable, so
  the control is read-only in v1.
- **v1 permits one `running` campaign per account**, enforced by a partial unique
  index. Two campaigns sharing one account's slots would need fair-share arbitration
  between two independent leaders, which is real work for a case nobody has asked
  for. The constraint is one index and is trivially lifted later.

**D10 — Concurrency stays super-admin only. The supervisor sees it, cannot set it.**
An earlier draft of D9 described `account_settings.max_concurrent_calls` as
"already governed", implying a customer-reachable control. It is not: the value is
exposed only through master's super-admin tree (`super-admin.routes.ts` →
core's `PUT /internal/account-concurrency`). There is no `/proxy/account-settings`
route and none is being added. Concurrency is a commercial lever and stays one.

*Consequences:*
- The supervisor dashboard renders the current limit **read-only**, with the
  campaign's live utilisation against it. Raising it is a conversation with the
  platform operator, not a button.
- Requirement #8 ships **partially met by decision**, not by omission. Say so in
  the release notes rather than letting a supervisor hunt for a control.
- No new master route, no new UI, no new permission. This is the cheapest option
  and the only one that does not let an account raise its own carrier spend.

**D11 — Callbacks return to the pool in v1; revisit after the pilot.**
An agent who says "I'll call you back Tuesday" usually means *I*. v1 does not
honour that: a scheduled callback re-enters the roster as an ordinary `pending`
contact and whichever agent is `available` takes it.

*Consequences:*
- **Agent-facing copy must not promise otherwise** — "we'll call you back", never
  "I'll call you back". This is a UI-copy constraint, not a nicety; it is the
  entire mitigation.
- The seam is preserved: adding `agency_contacts.preferred_agent_user_id` plus a
  preference pass in the pacing tick is additive, so the decision can be revisited
  on pilot evidence rather than guessed at now.
- Watch for it in the pilot: if agents complain or contacts arrive confused,
  that is the signal to build it.

### 0.2 The one blocking constraint (deferred, not dismissed — see D2)

`WebRtcBridgeManager` holds live sessions in a **process-local `Map`**
(`webrtc-bridge-manager.ts:91`). The dial request, the browser WebSocket, the
carrier WebSocket, and the lifecycle webhook are four independent connections that
can each land on a different replica. Core's own review already flags this:

> *"Multi-replica ownership is not addressed … A provider or browser socket routed
> to a non-owning replica is rejected as an unknown call."*
> — `magic-voice-core/docs/VoiceLink-dialer-review.md:351`

Today's dialer half-hides this because the browser both *initiates* the call and
*then* connects its socket, so a sticky HTTP session mostly holds. **The agency
dialer inverts that**: the agent's socket is long-lived and opened *first*, and the
dial is initiated later by a background pacing loop on an arbitrary replica. The
existing coincidence stops working. §3 makes replica ownership explicit and, as a
side effect, retro-fixes the gap for the existing dialer.

---

## 1. Architecture at a glance

```
cusui  ── Agent Console (station WS + context panel)
       ── Supervisor Console (live dashboard, campaign controls)
          │  Firebase token + X-Tenant-Id / X-Account-Id
          ▼
magick-master  ── campaign CRUD · CSV ingest · DNC list · RBAC · governance
                  capability · billing · /proxy/agency/* · station WS proxy
          │  per-tenant core API key  ·  /internal/* S2S
          ▼
magic-voice-core ── src/agency/            ← NEW MODULE
                     ├── station-registry      (agent presence + replica ownership)
                     ├── agent-state-machine   (Redis CAS reservation)
                     ├── pacing-engine         (leader-elected loop per campaign)
                     ├── dial-dispatcher       (routes dial → owning replica)
                     └── campaign-repository   (contacts, attempts, dispositions)
                    reuses: WebRtcBridgeManager (media), TelephonyProviderRegistry,
                            resolveSipDial, concurrency guards, audit, settlement
          ▼
       carriers (VoBiz / VoiceLink / BYO SIP trunk)
```

### 1.1 Why the engine lives in core, not master

Master is the natural home for CRUD, RBAC and CSV — and it keeps those. But the
pacing loop must, on every tick, read agent availability, claim a contact, acquire
a telephony concurrency slot, and place a dial. Three of those four are core-owned
Redis/DB state. Running the loop in master would mean a cross-service round trip
per dial attempt, at hundreds of dials per minute, with master's fail-closed proxy
semantics in the path. **The loop goes where the state is.**

The split:

- **master owns** the campaign as a *business object*: name, config, caller-ID
  selection, disposition catalog, DNC list, calling-hours policy, who may start it,
  what it costs. It also owns CSV upload and parsing (reusing `csv-parser.ts`).
- **core owns** the campaign as an *execution object*: the contact roster, attempt
  rows, agent sessions, the pacing loop, and every telephony interaction.

Master pushes config down and reads status back. This mirrors how prompts,
schedules and bulk dispatch already work.

---

## 2. Data model

### 2.1 Core (`magic-voice-core`) — execution state

Six new tables. Migration numbers continue from `071`.

```sql
-- 072_agency_campaigns.sql
CREATE TABLE agency_campaigns (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             VARCHAR(100) NOT NULL,
  account_id            VARCHAR(100) NOT NULL DEFAULT 'default',
  name                  VARCHAR(255) NOT NULL,

  -- Dialing
  caller_ids            TEXT[] NOT NULL,          -- rotated round-robin; all one provider
  telephony_provider    VARCHAR(20) NOT NULL DEFAULT 'vobiz',
  sip_connection_id     UUID,                     -- BYO trunk egress; NULL = PSTN
  -- No concurrency column, by D9: the ceiling is the account's existing
  -- account_settings.max_concurrent_calls, shared with AI calls.

  -- Windows (IANA tz; contact tz overrides where derivable)
  calling_window_start  TIME NOT NULL DEFAULT '09:00',
  calling_window_end    TIME NOT NULL DEFAULT '20:00',
  calling_days          SMALLINT[] NOT NULL DEFAULT '{1,2,3,4,5}',
  default_timezone      VARCHAR(64) NOT NULL DEFAULT 'UTC',

  -- Behaviour
  wrapup_seconds        INTEGER NOT NULL DEFAULT 30,   -- 0 = no wrap-up
  wrapup_auto_return    BOOLEAN NOT NULL DEFAULT true,
  retry_policy          JSONB NOT NULL DEFAULT '{}',   -- see §2.4
  disposition_catalog   JSONB NOT NULL DEFAULT '[]',   -- [{code,label,is_success,requires_note}]
  record_calls          BOOLEAN NOT NULL DEFAULT false,
  analysis_profile_id   UUID,                          -- reuse dialer analysis

  -- draft → running → paused → stopping → completed | stopped
  status                VARCHAR(20) NOT NULL DEFAULT 'draft',
  contacts_total        INTEGER NOT NULL DEFAULT 0,
  created_by            VARCHAR(100),
  started_at            TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ck_agency_campaign_status CHECK (status IN
    ('draft','running','paused','stopping','completed','stopped'))
);

-- D9: one running campaign per account in v1. Removes any need for fair-share
-- arbitration between two independent pacing leaders over one concurrency pool.
CREATE UNIQUE INDEX uq_agency_campaign_running
  ON agency_campaigns (tenant_id, account_id)
  WHERE status = 'running';
```

```sql
-- 073_agency_contacts.sql — the execution roster. One row per CSV row.
CREATE TABLE agency_contacts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id       UUID NOT NULL REFERENCES agency_campaigns(id) ON DELETE CASCADE,
  tenant_id         VARCHAR(100) NOT NULL,
  account_id        VARCHAR(100) NOT NULL,

  phone_e164        VARCHAR(20) NOT NULL,
  -- Every non-phone CSV column, verbatim, original headers as keys. This is what
  -- the agent screen renders. Deliberately schemaless: arbitrary columns is a
  -- hard requirement and we will not migrate per customer.
  context           JSONB NOT NULL DEFAULT '{}',
  source_row_number INTEGER,
  timezone          VARCHAR(64),   -- derived at ingest; NULL ⇒ campaign default

  -- pending → in_flight → connected → completed | exhausted | suppressed
  state             VARCHAR(20) NOT NULL DEFAULT 'pending',
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  last_outcome      VARCHAR(30),
  last_disposition  VARCHAR(50),
  next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  suppressed_reason VARCHAR(40),   -- dnc | invalid | max_attempts | manual

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ck_agency_contact_state CHECK (state IN
    ('pending','in_flight','connected','completed','exhausted','suppressed'))
);

-- THE hot query: "next dialable contact for this campaign". Partial index keeps
-- it O(log n) as completed rows accumulate into the millions.
CREATE INDEX idx_agency_contacts_dialable
  ON agency_contacts (campaign_id, next_attempt_at)
  WHERE state = 'pending';

CREATE INDEX idx_agency_contacts_phone
  ON agency_contacts (tenant_id, phone_e164);
```

```sql
-- 074_agency_agents.sql — an agent's durable session on a campaign.
CREATE TABLE agency_agent_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       VARCHAR(100) NOT NULL,
  account_id      VARCHAR(100) NOT NULL,
  campaign_id     UUID NOT NULL REFERENCES agency_campaigns(id) ON DELETE CASCADE,
  agent_user_id   VARCHAR(100) NOT NULL,   -- master's user id, opaque to core

  -- offline → available → reserved → on_call → wrapup → available | break
  state           VARCHAR(20) NOT NULL DEFAULT 'offline',
  break_reason    VARCHAR(50),
  state_since     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Which core replica owns this agent's media socket (see §3).
  owner_replica   VARCHAR(100),
  last_heartbeat  TIMESTAMPTZ NOT NULL DEFAULT now(),

  joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ck_agency_agent_state CHECK (state IN
    ('offline','available','reserved','on_call','wrapup','break'))
);

-- One live session per agent per campaign.
CREATE UNIQUE INDEX uq_agency_agent_live
  ON agency_agent_sessions (campaign_id, agent_user_id)
  WHERE left_at IS NULL;
```

```sql
-- 075_agency_attempts.sql — one row per dial. The audit spine.
CREATE TABLE agency_call_attempts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id         UUID NOT NULL REFERENCES agency_campaigns(id) ON DELETE CASCADE,
  contact_id          UUID NOT NULL REFERENCES agency_contacts(id) ON DELETE CASCADE,
  tenant_id           VARCHAR(100) NOT NULL,
  account_id          VARCHAR(100) NOT NULL,
  attempt_number      INTEGER NOT NULL,

  -- The media leg. Reuses webrtc_calls verbatim — same bridge, same settlement,
  -- same recording/analysis pipeline. NULL until the dial is placed.
  webrtc_call_id      UUID,
  caller_id           VARCHAR(20) NOT NULL,
  reserved_agent_id   UUID REFERENCES agency_agent_sessions(id),

  -- queued → dialing → ringing → answered → bridged → ended
  state               VARCHAR(20) NOT NULL DEFAULT 'queued',
  outcome             VARCHAR(30),  -- connected|no_answer|busy|failed|machine|invalid|abandoned
  disposition_code    VARCHAR(50),
  notes               TEXT,
  callback_at         TIMESTAMPTZ,

  dialed_at           TIMESTAMPTZ,
  answered_at         TIMESTAMPTZ,
  bridged_at          TIMESTAMPTZ,
  ended_at            TIMESTAMPTZ,
  talk_seconds        INTEGER,
  wrapup_seconds      INTEGER,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_agency_attempt_number
  ON agency_call_attempts (contact_id, attempt_number);

-- THE duplicate-dial backstop: at most one non-terminal attempt per contact,
-- enforced by the database regardless of what any pacing loop believes.
CREATE UNIQUE INDEX uq_agency_attempt_live
  ON agency_call_attempts (contact_id)
  WHERE state <> 'ended';

CREATE INDEX idx_agency_attempts_live
  ON agency_call_attempts (campaign_id)
  WHERE state IN ('queued','dialing','ringing','answered','bridged');
CREATE INDEX idx_agency_attempts_reporting
  ON agency_call_attempts (campaign_id, created_at DESC);
-- Webhook/settlement → attempt correlation (phase 3/4 need this on every carrier event).
CREATE INDEX idx_agency_attempts_webrtc
  ON agency_call_attempts (webrtc_call_id) WHERE webrtc_call_id IS NOT NULL;
-- "what is this agent currently on" — the station reconnect + supervisor views.
CREATE INDEX idx_agency_attempts_agent
  ON agency_call_attempts (reserved_agent_id) WHERE state <> 'ended';
```

`webrtc_calls` gains two nullable columns (migration `076`) so the media leg
back-references its campaign without core's bridge needing to know about agency
concepts: `campaign_id UUID`, `agency_attempt_id UUID`.

### 2.2 Why a new roster table rather than reusing `contact_lists`

Master's `contact_lists` stores the **file** — S3 key, headers, and a handful of
sample rows (`011_contact_lists.sql:16-19`). There are no per-contact rows in any
database. The pacing engine needs to claim one contact atomically, hundreds of
times a minute, and track per-contact retry state. That is a row-level workload and
it belongs next to the engine.

**Ingestion path:** file → S3 → parse → E.164 normalization → accepted/rejected/
duplicate summary, then stream accepted rows to core in chunks of 500 via a new
S2S endpoint `POST /internal/agency-campaigns/:id/contacts`, reusing the
`chunked-dispatch.ts` pattern. Master remains the source of truth for the *file*;
core for the *roster*.

#### 2.2.1 The parser is not reusable as-is — this is real scoped work

An earlier draft of this document claimed the existing upload path was reusable
unchanged. It is not, and the gap is big enough to sink Phase 1 if it is not
planned. Three concrete blockers in `magick-master/src/contact-lists/csv-parser.ts`:

1. **`MAX_ROWS = 10_000`** (`csv-parser.ts:4`, enforced at `:96`). The design targets
   ~1M contacts per campaign. The cap must be raised or removed for the agency path.
2. **The whole file is buffered** — `parseCsv(buffer: Buffer)` with `parse(buffer)`
   from `csv-parse/sync`. A million-row CSV in memory on master is not viable.
3. **The phone column must literally be named `phone`** (`csv-parser.ts:76`). The
   requirement is explicitly "map *one* column as the phone number", operator's
   choice of header.

Additionally, duplicates today produce only a warning string — there is no
accepted/rejected/**duplicate** summary and no dedupe, which requirement 1 asks
for by name.

**Scoped as `agency-csv-ingest`, in Phase 1 (not free, ~4 days):** a streaming S3
read with a row callback (`csv-parse` non-sync, piped from the S3 body stream), a
`phone_column` parameter carried from the operator's column-mapping step, in-stream
dedupe on normalized E.164 with a counter, and a structured
`{accepted, rejected, duplicates, errors[]}` summary. It is written as a **new
`agency-csv-ingest.ts` alongside the existing parser, not a rewrite of it** — the
existing 10k-row synchronous path serves bulk dispatch correctly and has no reason
to change or absorb this risk.

One consequence worth stating: because `contact_lists` persists only file metadata
and `sample_rows` (`011_contact_lists.sql:17-19`), the roster stream re-reads the
object from S3. That is fine — it is a stream, not a load — but it is why the
ingest is its own job with its own progress, not a synchronous request.

### 2.3 Do Not Call

DNC is compliance state and belongs in master, where the audit and governance
surfaces already live.

```sql
-- magick-master migration 050_dnc.sql
CREATE TABLE dnc_entries (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id   UUID,          -- NULL ⇒ tenant-wide
  campaign_id  UUID,          -- NULL ⇒ applies to all campaigns
  phone_e164   VARCHAR(20) NOT NULL,
  source       VARCHAR(30) NOT NULL,   -- agent | import | api | regulator
  reason       TEXT,
  added_by     VARCHAR(100),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_dnc_scope
  ON dnc_entries (tenant_id, COALESCE(account_id,'00000000-0000-0000-0000-000000000000'::uuid),
                  COALESCE(campaign_id,'00000000-0000-0000-0000-000000000000'::uuid), phone_e164);
```

**Checked twice, at two different times, for two different reasons:**

1. **At ingest** (master, synchronous) — DNC rows are marked
   `state='suppressed', suppressed_reason='dnc'` and never enter the roster. This
   is the bulk check and it costs nothing at dial time.
2. **At dial** (core, from a Redis set) — master publishes DNC additions to core
   over the existing S2S channel; core maintains
   `dnc:{tenantId}` as a Redis SET and does an `SISMEMBER` immediately before
   `initiateCall`. A contact added to DNC by an agent at 10:00 must not be dialed by
   a retry at 10:05.

   **The Redis set is deliberately tenant-flat, and that is a documented
   simplification.** `dnc_entries` supports account- and campaign-scoped rows, but a
   flat `dnc:{tenantId}` set cannot express them: it would either over-block
   (a number suppressed for client A is skipped for client B — safe, but wrong) or
   under-block (scoped rows omitted — a compliance miss). For v1: **only tenant-wide
   entries enter the Redis set**; account- and campaign-scoped entries are enforced
   at ingest only, which is where they are actually created. Because the mid-campaign
   agent-initiated path (`mark DNC`) writes a *tenant-wide* row by default, the case
   that actually needs sub-second propagation is exactly the case the flat set
   covers. Revisit if per-client suppression becomes a real customer ask.

   Add a plain `(tenant_id, phone_e164)` index to `dnc_entries` — the `COALESCE`
   unique index cannot serve the per-number lookup the ingest sweep performs.

The Redis set **fails closed**: if Redis is unavailable, the pacing engine stops
dialing rather than dialing an unchecked number. This is the one place in the
system where unavailability must halt work — a wrongly-dialed DNC number is a
regulatory event, a paused campaign is an inconvenience.

### 2.4 Retry policy shape

```jsonc
{
  "no_answer": { "delay_minutes": 60,  "max_attempts": 3 },
  "busy":      { "delay_minutes": 15,  "max_attempts": 4 },
  "failed":    { "delay_minutes": 120, "max_attempts": 2 },
  "abandoned": { "delay_minutes": 5,   "max_attempts": 2 },
  "invalid":   { "max_attempts": 0 },   // never retried
  "connected": { "max_attempts": 0 }    // terminal unless the disposition says otherwise
}
```

There is deliberately **no `machine` key**: with AMD off (D1) the system can never
classify an outcome as `machine`. A call answered by voicemail is
`outcome='connected'` — the carrier cannot tell us otherwise — and the *only*
signal that it was a machine is the agent's disposition. So voicemail retry is
**disposition-driven**, and the disposition catalog must carry retry semantics
rather than being a flat label list:

```jsonc
// agency_campaigns.disposition_catalog
[
  { "code": "sale",      "label": "Sale",         "is_success": true,  "terminal": true },
  { "code": "callback",  "label": "Callback",     "requires_datetime": true },
  { "code": "voicemail", "label": "Voicemail",    "retry": { "delay_minutes": 240, "max_attempts": 2 } },
  { "code": "not_interested", "label": "Not interested", "terminal": true },
  { "code": "do_not_call",    "label": "Do not call",    "suppress": true }
]
```

**Precedence, stated once:** a disposition's `retry`/`terminal`/`suppress` always
overrides the outcome policy; the outcome policy applies only when no disposition
was recorded (every non-answered call, plus the reaper's `no_disposition`).
`callback` writes `agency_call_attempts.callback_at` and returns the contact to
`pending` with `next_attempt_at = callback_at`. `do_not_call` suppresses immediately
and writes a `dnc_entries` row via master.

Three codes are built in and cannot be removed from a catalog — `voicemail`,
`callback`, `do_not_call` — because the retry engine, the scheduler and the DNC
path each depend on one of them existing.

---

## 3. Replica ownership — the media-affinity design

This is the part that must be right from day one, because retrofitting it means
rewriting the dial path.

**Principle: the agent's station socket is the anchor of ownership.**

1. An agent opens **one long-lived station WebSocket** per session:
   `wss://…/api/v1/agency/station/:sessionId?token=…`. Whatever replica accepts
   that socket becomes the **owner** of that agent.
2. The owner writes `agency:station:{sessionId} → {replicaId, advertisedHost}` to
   Redis with a 30s TTL, renewed by the socket's own heartbeat. Socket closes or
   heartbeat lapses ⇒ key expires ⇒ agent is no longer available anywhere.
3. The **pacing engine leader** (any replica, §4.1) reserves an agent, then does
   **not** dial. It publishes a dial command to
   `agency:dial:{ownerReplicaId}` over Redis pub/sub, carrying the attempt id,
   contact, caller ID and reserved agent.
4. The **owning replica** consumes that command and calls into the bridge locally.
   The bridge session, the agent's station socket, and the carrier socket are now
   all in one process — exactly the invariant the current bridge already assumes.
5. Carrier callbacks are made replica-addressable: the owning replica builds
   `mediaStreamUrl` / `statusCallbackUrl` from its **own advertised host** rather
   than the shared ingress. `WebhookUrlBuilder` already constructs these per call
   (`webrtc-bridge-manager.ts:308-324`), so this is a parameter, not a rewrite.

**Failure handling.** If the owner dies between reservation and bridge, the
command is never consumed; the leader's reservation lease expires (5s) and the
agent returns to `available`, the attempt is marked `failed`, and the contact
returns to `pending`. No orphan call is placed, because the dial itself only ever
happens on the owning replica.

**Per D2, steps 3–5 are not built for v1.** Core is single-replica, so the
`DialDispatcher` interface has one implementation — `LocalDialDispatcher`, a direct
in-process call — and `WebhookUrlBuilder` keeps using the shared ingress host.
Steps 1 and 2 *are* built: the Redis ownership key is written and read on every
reservation, so the invariant "dial only on the owning replica" is enforced from
day one and is trivially satisfied when there is one replica. Going multi-replica
later means writing `PubSubDialDispatcher` and threading an advertised host into
`WebhookUrlBuilder` — an additive change to two seams, not a rewrite of the dial
path, and it closes the existing dialer's documented gap at the same time.

**Restart behaviour (single-replica consequence).** A core deploy tears down every
bridge and every station socket at once — and so does a **master** deploy, because
the station socket proxies through master (§8). Both services' restarts are
agent-visible; the recovery path below is the same for either. `gracefulShutdown()` already ends live
bridges cleanly with settlement (`webrtc-bridge-manager.ts:125`). For agents,
station sessions are **rehydrated from `agency_agent_sessions` on reconnect**, and
an agent whose socket returns after a restart lands in `break`, never
`available` — the engine must not dial into a pool that has not demonstrably
re-attached. The agent clicks once to go available; campaigns resume on their own
once capacity reappears.

---

## 4. The pacing engine

### 4.1 One authoritative loop per campaign

**Recommendation: Redis leader lease per campaign, plus DB-level row claiming.**
Two independent mechanisms, because either alone has a failure mode we cannot
accept.

*Leader lease* — each replica runs a supervisor that, every 2s, attempts
`SET agency:leader:{campaignId} {replicaId} NX PX 15000` for every `running`
campaign it does not already lead. The holder renews at 5s intervals and runs the
tick loop. On loss of renewal it stops within one tick. This is the same Redis-Lua
idiom as `ConcurrencyGuard` (`concurrency-guard.ts:79`), so the operational
knowledge transfers.

*Row claiming* — the tick's contact selection is:

```sql
UPDATE agency_contacts SET state = 'in_flight', updated_at = now()
WHERE id IN (
  SELECT id FROM agency_contacts
  WHERE campaign_id = $1 AND state = 'pending' AND next_attempt_at <= now()
  ORDER BY next_attempt_at
  FOR UPDATE SKIP LOCKED
  LIMIT $2
)
RETURNING *;
```

`SKIP LOCKED` plus the partial unique index `uq_agency_attempt_live` — on
`agency_call_attempts (contact_id) WHERE state <> 'ended'`, §2.1 — mean that
even during a split-brain window — GC pause, network partition, clock skew — **two
leaders cannot dial the same contact.** The lease is the efficiency mechanism; the
DB claim is the correctness mechanism.

*Rejected alternatives:*

- **Pure SQS consumer** (master's bulk-dispatch model). A queue is a fine way to
  fan work out, but pacing is a closed-loop controller — it must *stop* the moment
  agent capacity hits zero and *resume* the instant it returns. Draining a queue
  cannot express backpressure from a resource the queue does not know about. We
  would end up buffering dials that must not happen.
- **Advisory-lock-only, no Redis.** Workable, but it ties the loop's liveness to a
  long-lived Postgres session and gives no cheap way to observe leadership.

### 4.2 The tick

Every 250ms, the leader computes:

```
available   = COUNT(agency_agent_sessions WHERE campaign='X' AND state='available')
-- ALL non-terminal attempts, not just pre-answer ones: a bridged call still holds
-- an account concurrency slot, so excluding 'answered'/'bridged' would make the
-- engine reserve agents and claim contacts only to be refused by the guard, every
-- tick, forever, whenever agents outnumber the account limit.
occupied    = COUNT(agency_call_attempts  WHERE campaign='X' AND state <> 'ended')
to_dial     = MAX(0, MIN(account_settings.max_concurrent_calls − occupied, idle))   -- D9
```

**AMENDED 2026-08-13.** This read `target = MIN(account_limit, available)` /
`to_dial = MAX(0, target − occupied)`, and that formula is wrong — it was
implemented as written and shipped. `available`/`idle` counts only agents in
`available`; a busy agent has already been excluded from it. `occupied` is that
same busy agent's live attempt. Subtracting one from the other therefore charges
every busy agent **twice**, and dials `idle − busy` instead of `idle`: with two
agents and one on a call it is `1 − 1 = 0` for *any* `max_concurrent_calls`, so a
campaign could only dial when every agent was simultaneously idle. Measured on
staging 2026-08-13: a second agent went available with the first still ringing and
nothing dialled for 24 s.

The two terms bound different quantities and must not be subtracted from one
another — the account limit caps **total concurrency** (so `occupied` counts
against it), the idle count caps **new dials** (only an idle agent can take one).
See `magic-voice-core/src/agency/pacing-engine.ts` `planTick`.

`to_dial == 0` ⇒ the loop is paused. It is the same expression that resumes it; there
is no separate pause/resume state to get out of sync. In-flight attempts are never
cancelled by a pause — they complete normally.

Then, for each of `to_dial` slots: reserve an agent (§5), claim a contact,
check DNC + calling hours, pick the next caller ID round-robin, publish the dial
command to the agent's owning replica.

**Unclaiming must move the clock forward.** A claimed contact that fails its DNC or
calling-hours check is returned to `pending` — but if it is returned with
`next_attempt_at = now()` it is re-claimed on the very next tick, and a campaign
whose contacts are all outside their calling window spins at 4 claims/second all
night, burning agent reservations on calls it will never place. Unclaim rules:

- **outside calling hours** → `next_attempt_at =` next window-open instant in the
  contact's timezone (§D4), which also means the contact naturally wakes at the
  right local time without a scheduler.
- **DNC hit** → `state='suppressed'`, never returned to `pending`.
- **agent reservation lost between reserve and dial** → `next_attempt_at = now()`
  is correct here, because the condition genuinely has cleared.

A useful invariant falls out: the dialable predicate
(`state='pending' AND next_attempt_at <= now()`) is the *only* thing the hot index
serves, so anything that cannot be dialed right now must not satisfy it.

### 4.3 Concurrency semantics — the decision, stated

**The ceiling is the account's existing `max_concurrent_calls` (D9), and an agent
is reserved before every dial (D1).** There is no campaign-level concurrency knob
and no over-dial ratio in v1.

Both terms do real work, and they fail in opposite directions, which is why both
are needed — but they bound **different quantities**, and combining them by
subtraction is the bug amended above:

- `account_limit` bounds carrier capacity and spend, and is shared with AI calls
  through the same `acquireTelephonyConcurrency` counter — so an account cannot
  exceed its ceiling by running an agency campaign and an AI batch at once. This
  is the term `occupied` is subtracted from: a live attempt holds a slot, so the
  account's remaining headroom is `account_limit − occupied`.
- `idle_agents` bounds human capacity. It is **already net of busy agents** — a
  reserved or talking agent is not in `available` — so it must never have
  `occupied` subtracted from it as well. When it reaches 0 the target is 0 and
  dialing stops; when an agent finishes wrap-up it becomes positive and the next
  tick dials. **Pause and resume are the same expression evaluated twice**, so
  there is no pause flag to leave stale.

**Known scope mismatch — LATENT, not live. Direction decided 2026-08-13.**
`account_limit` is account-scoped while `occupied` is campaign-scoped, so two
campaigns on one account each compute headroom against only their own live calls
and can jointly exceed the ceiling. The over-dials are refused by
`AccountConcurrencyGuard`, but that path unclaims the contact immediately and
re-dials on the next 250 ms tick, so it spins rather than settling — roughly 4
attempt rows/second of churn plus phantom reserved/released frames on a real
agent's screen. Pre-existing; amplified about 3× by the amendment above.

**It is unreachable today**, and the reason is worth stating because it is the
whole basis of the decision: `uq_agency_campaign_running` is
`ON agency_campaigns (tenant_id, account_id) WHERE status = 'running'`
(migration `072`), so D9 permits exactly **one** running campaign per account and
two campaigns cannot both be ticking. The spin needs that index lifted first —
and that index's own comment says it is "trivially lifted later", which is
precisely how this ships: someone drops it to get fair-share arbitration, and the
pacing arithmetic is the last place they look.

**Decided: first-come-first-served.** When the index is lifted, `occupied`
becomes an account-scoped live count and whichever campaign's tick lands first
takes the available headroom. This maximises utilisation and matches the fact
that the ceiling exists to bound carrier capacity and spend, not to allocate
between campaigns. **The known cost, accepted:** a high-volume campaign can
starve a small one indefinitely, with no fairness floor. If that becomes a real
complaint the answer is a per-campaign floor added deliberately, not a silent
switch to proportional sharing — proportional sharing has the opposite failure
(a campaign with idle agents cannot borrow the other's unused headroom, so the
account under-dials against its own paid-for ceiling).

**What must be true before the index is lifted**, since the fix and the lift are
separable and the lift is the dangerous half: the headroom computation and the
one-running-campaign constraint are coupled, and nothing currently binds them.
Lifting the index without making `occupied` account-scoped ships the spin. That
coupling needs a test that fails when the index is dropped, so the lift cannot
land quietly.

**Tracked as `MAG-125` (M3).** Until that lands, the paragraph you are reading is
the *only* thing connecting the index to the arithmetic — which is the failure
mode this feature keeps repeating, so treat the ticket as load-bearing rather than
as tidy-up.

Reserve-before-dial is the strict definition of power dialing, and it makes
abandonment *structurally* near-zero: the only route to an abandoned call is a
reserved agent vanishing during the ring, which the per-state reservation lease of
§6.1 detects and which §6 handles.

**Where v2 predictive pacing attaches.** Predictive pacing is exactly this
expression with `available_agents` replaced by
`available_agents × f(live answer rate)`. Nothing else in the design changes — not
the reservation CAS, not the claim query, not the state machines. That is why the
abandoned-call path is built in Phase 2 even though D1 makes it nearly
unreachable: it is the safety net predictive pacing will need, and it is far
cheaper to build now than to retrofit onto a system that has never exercised it.

**What `f` should be, measured (added 2026-09-11).** `f` was sized off real data
for the first time on 2026-09-11 — the full working is in
[`agency.md`](../agency.md) §8, "What over-dialing would actually buy". Three
things a future implementer should take from it rather than re-derive:

- **`f` is continuous.** For a budget `B` and `m` free agents, place one extra
  dial on a fraction `q = B·m/(pᵐ − B)` of ticks; the abandonment cost is
  `q·pᵐ/(m+q)`. Earlier framings of this treated the ratio as an integer and
  concluded predictive pacing was worthless below five agents. It is not — it is
  worth ≈+14% dials at two agents and +33% at three, on a 1.5% budget.
- **`f` must be bounded by a VOLUME gate, not only a rate budget.** A rate cannot
  express a ceiling until the denominator is large enough for one call to clear
  it: at 3% that is 34 answered calls, the same `ceil(100/ceiling_pct)` the
  abandonment guardrail uses for its own sample floor. Below it a campaign cannot
  absorb one surplus abandonment, so `f` must return 1.00 — without that gate the
  controller spends a whole day's budget on its first extra dial.
- **`p` is 0.32-0.39 (point ≈0.35)** on the only data that exists, and it is
  *higher* answer rates that make over-dialing more dangerous, not lower. Read it
  live from `agency_answer_latency_seconds` and `agency_attempt_hold_seconds`
  rather than configuring it.

The `overdial_ratio` seam itself is unchanged and still the whole of it.

---

## 5. State machines

### 5.1 Agent

```
                    ┌──────────────────────────── (heartbeat lost / socket close)
                    ▼
   ┌──────────┐  join   ┌───────────┐  reserve   ┌──────────┐
   │ offline  │────────►│ available │───────────►│ reserved │
   └──────────┘         └───────────┘            └──────────┘
        ▲                 ▲   │  ▲                  │      │
        │                 │   │  │                  │      │ reservation expired /
        │        wrapup   │   │  │  break ended     │      │ call failed pre-answer
        │         done    │   │  │                  │      ▼
        │              ┌──────────┐             bridged   (back to available)
        │              │  wrapup  │                │
        │              └──────────┘                ▼
        │                    ▲                ┌──────────┐
        │                    │  call ended    │ on_call  │
        │                    └────────────────└──────────┘
        │                                          │
        │              ┌──────────┐  break         │
        └──────────────│  break   │◄───────────────┘ (agent requests break;
          leave/logout └──────────┘                   applied after wrap-up)
```

| Transition | Trigger | Guard |
|---|---|---|
| `offline → available` | agent joins campaign, station WS open | campaign `running`, agent has `agency.agent` capability |
| `available → reserved` | pacing engine CAS | atomic; loses ⇒ engine picks another agent |
| `reserved → on_call` | carrier `answer` + bridge established | — |
| `reserved → available` | reservation lease expiry **per the §6.1 TTL table** (never a flat 20s — see the worked failure there), or attempt ended pre-answer | releases without penalty |
| `on_call → wrapup` | either party hangs up | only if `wrapup_seconds > 0` |
| `on_call → available` | hangup | when `wrapup_seconds = 0` |
| `wrapup → available` | disposition submitted, or timer expires with `wrapup_auto_return` | disposition required ⇒ timer extends, supervisor can force |
| `* → break` | agent requests, with reason code | queued if `on_call`; applied at wrap-up end |
| `* → offline` | socket close, heartbeat lapse (>30s), logout, campaign stopped | any in-flight reservation is released. **A bridged call is hung up** — see below |

**Agent dies mid-call.** The station socket *is* the agent's media path, so there
is no "let the call finish" option — the customer would be sitting in dead air.
The existing bridge already does the right thing: `attachBrowserLeg`'s close
handler calls `localHangup(…, outcome:'browser_hangup')`
(`webrtc-bridge-manager.ts:393-401`). We keep that behaviour and only relabel it:

1. **There is no re-attach grace window today — an earlier draft of this document
   asserted one, and that was wrong.** `:379-384` is not a timer. It handles only
   the case where a *new* socket attaches while the prior one is still open: it
   closes the prior socket first so that its close handler, guarded by
   `session.browserWs !== ws`, cannot tear down the call. On a real network drop
   the old socket's `close` fires *first*, `localHangup(…, 'browser_hangup')` runs,
   and the call is already gone before any reconnect arrives.
2. Surviving a wifi blip is therefore **new Phase 2 work** — a deferred-hangup
   timer armed on browser close and disarmed by re-attach — not preserved
   behaviour. Phase 2 must be estimated with that in it, because §5.1 leans on it
   for presence resilience under network drop.
3. Timer absent or exhausted ⇒ hang up the carrier leg, attempt
   `outcome='agent_disconnected'`, contact re-queued per the `failed` retry
   policy, agent → `offline`.

**Presence resilience** is not a state; it is the heartbeat. The station WS sends a
ping every 10s. Three misses (30s) and the Redis ownership key expires, which is
what actually removes the agent from the `available` count — the DB row is updated
by a sweeper, not relied upon for liveness. Browser tab close, laptop lid, or a
dead replica all produce the same outcome through the same mechanism.

### 5.2 Call attempt

```
 queued ──► dialing ──► ringing ──► answered ──► bridged ──► ended
   │           │           │            │                      ▲
   │           │           │            └── no agent bridgeable ┤ (abandoned)
   │           │           └── no_answer / busy ────────────────┤
   │           └── carrier reject ─────────────────────────────┤ (failed)
   └── DNC hit / outside calling hours ────────────────────────┘ (suppressed, not an attempt)
```

`queued → dialing` happens on the owning replica, not the leader. `answered →
bridged` is the moment the carrier socket joins the agent's station socket; the
context panel is pushed on the station WS *before* this transition (§6).

### 5.3 Contact

```
 pending ──claim──► in_flight ──bridged──► connected ──ended──► ┐
    ▲                   │                                       │
    │                   └── non-answer outcome ─────────────────┤
    │                                                            ▼
    ├──── retry eligible (next_attempt_at set from policy) ── evaluate
    │                                                            │
    │                              ┌─────────────────────────────┤
 completed ◄── terminal disposition┘                             │
 exhausted ◄── attempts ≥ policy max ────────────────────────────┤
 suppressed ◄── DNC / invalid / manual ──────────────────────────┘
```

**Campaign finalization has an owner:** the pacing leader itself. At the end of any
tick where it dialed nothing, it evaluates the completion predicate and, if met,
transitions the campaign `running → completed` and releases its lease. `stopping →
stopped` is the same path: `stop` sets `stopping`, in-flight attempts drain, and the
leader's next idle tick finalizes. Nothing else may write these two transitions, so
there is exactly one writer and no race with the supervisor's controls.

A campaign is `completed` when
`COUNT(*) WHERE state IN ('pending','in_flight','connected') = 0`. Because
`next_attempt_at` can be hours out, "list exhausted" and "campaign complete" are
genuinely different — the supervisor dashboard shows both: *contacts remaining* and
*retries pending*.

---

## 6. Agent reservation and the race we must not lose

Two answered calls racing for one agent is the defining correctness problem. The
reservation is a **compare-and-swap in Redis, executed before the dial**, using the
same Lua-script discipline as the existing concurrency guards:

```lua
-- KEYS[1] = agency:agent:{sessionId}:state   (a HASH: state, attempt, since)
-- ARGV[1] = 'available'  ARGV[2] = 'reserved'  ARGV[3] = attemptId  ARGV[4] = leaseTtlMs
if redis.call('HGET', KEYS[1], 'state') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'state', ARGV[2], 'attempt', ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return 1
```

Returns 0 ⇒ another tick already took this agent; the engine moves to the next
candidate. There is no window in which two attempts hold the same agent, because
there is no read-then-write.

**Ordering guarantee.** Reservation happens *strictly before* `initiateCall`. The
agent is committed before the carrier is ever contacted. Under D1 this makes
"answered call with no agent" impossible except through agent disappearance.

### 6.1 Lease lifecycle — the part that must not be got wrong

The reservation TTL is not one number. **A single 20s lease covering the whole
dial is a bug**, and it is worth spelling out why, because it silently breaks D1's
central promise on the *happy path*, not an edge case:

> Carrier no-answer timeouts run 30–45s. Contact A rings 25s. At t=20s the lease
> expires, the agent flips back to `available`, the next tick reserves them for
> contact B — and then contact A answers at t=25s with no agent to bridge to. That
> is a structurally abandoned call, produced by the mechanism meant to prevent
> abandonment.

The TTL therefore tracks the **agent state**, not the reservation as a whole:

| Agent state | Key TTL | Renewed by | On expiry |
|---|---|---|---|
| `reserved`, dial not yet placed | 10s | — | release; attempt → `failed`, contact → `pending` |
| `reserved`, attempt `dialing`/`ringing` | 15s | **the owning replica, every 5s, while the attempt is non-terminal** | as above — means the replica died |
| `on_call` (bridged) | 15s | owning replica every 5s, tied to the live bridge session | end the bridge, disposition `agent_disconnected` |
| `wrapup` | 15s | the station socket heartbeat, exactly as in `available` | agent → `offline`, per §5.1 |
| `available` / `break` | 45s | the station socket heartbeat (10s ping, 3 misses) | agent → `offline`, per §5.1 |

The invariant: **a key TTL only ever expires when the thing renewing it is gone.**
It is a liveness detector, never a business timer. Business timers (ring timeout,
wrap-up length, max call duration) live in the attempt row and the existing
`setMaxDurationTimer` — never in a Redis TTL, because a Redis TTL cannot
distinguish "took too long" from "the process died".

The carrier ring timeout is bounded independently by the provider's own dial
timeout and by the attempt reaper in §6.2, so a lease that outlives a ring is
harmless; a lease that expires *during* one is not.

### 6.2 Crash recovery — the reaper

`gracefulShutdown()` handles SIGTERM (`webrtc-bridge-manager.ts:125`). It does not
handle SIGKILL, OOM, or a hard crash, and those strand rows in states that are
invisible to the pacing loop: contacts in `in_flight` (not `pending`, so never
re-claimed) and attempts in `queued`/`dialing`/`ringing` (counted against the tick's
`in_flight`, so they permanently shrink the dialing target). Left alone, a campaign
silently loses contacts and can never reach `completed`, which requires zero
`in_flight`.

**D2 makes this easy and it should be exploited:** with one replica, *any*
non-terminal attempt found at boot is dead by definition — there is no other
process that could own it.

- **At startup:** every attempt in a non-terminal state → `failed`
  (`outcome='orphaned'`); its contact → `pending` with `next_attempt_at` per the
  `failed` retry policy. Every agent session → `offline`. This is a single
  transaction and it runs before the pacing supervisor starts.
- **Periodically (60s):** attempts non-terminal for longer than
  `max_ring + max_call_duration` with no live bridge session get the same
  treatment — this catches an in-process leak rather than a crash.
- **Also periodically:** contacts stuck in `connected` whose attempt ended without
  a disposition, past the wrap-up window, are auto-dispositioned
  `no_disposition` and evaluated against the retry policy. Otherwise one agent
  closing their laptop at 5pm strands a contact forever.

When core goes multi-replica, only the startup rule changes — it narrows from "all
non-terminal" to "non-terminal and owned by a replica whose heartbeat is gone".

**The abandoned path** (only reachable at ratio > 1.00, or on reserved-agent loss):

1. Carrier reports `answer`; the owning replica finds no live reserved station.
2. It plays a short pre-recorded apology clip through the existing static-clip path
   (`src/services/static-clip-resolver.ts` + `src/audio/telephony-clip.ts` — already
   built for announcements), then hangs up.
3. The attempt is written `outcome='abandoned'`; the contact is re-queued per the
   `abandoned` retry policy.
4. `agency_abandoned_total` / `agency_answered_total` are exported as Prometheus
   counters and surfaced as a **rolling 24h abandonment rate**, because that is the
   window regulators measure over — not a session or a campaign.

A campaign whose rolling rate crosses a configurable ceiling **auto-pauses** and
alerts the supervisor. That is a hard guardrail, not a dashboard number.

#### `calling_days` is ISO-8601 weekday numbering — ratified 2026-08-11

**1 = Monday … 7 = Sunday. `0` is rejected, never read as Sunday.** All three repos: core's
gate, master's validator, cusui's picker.

This needs stating because **the ambiguity is undetectable by testing the default.**
`calling_days SMALLINT[] DEFAULT '{1,2,3,4,5}'` is Mon–Fri under Postgres `dow` (0=Sun)
*and* under `isodow` (1=Mon…7=Sun), so every test of the default passes under either
reading. It would have surfaced as an off-by-one on **Sundays**, months later, in a
compliance gate — i.e. as calls placed outside a customer's permitted window.

Rejecting `0` rather than coercing it matters for the same reason: a caller sending `0`
believes `dow`, so accepting it silently means we and they disagree about which days the
campaign runs, with no error anywhere.

#### Timezones: refuse bare abbreviations (§2.3 / D4)

**A bare timezone abbreviation must be refused in favour of the campaign default.** ICU
resolves `'EST'` to `America/Panama`, **which observes no DST** — so an `EST` column would
place every call an hour early **for half the year**, and test clean whenever anyone
checked. Only `Area/Location` form, or exactly `UTC`, is accepted.

#### The next window-open instant must be VERIFIED, not computed (§4.2)

**Verify the candidate against the window predicate and step forward to the transition.**
Across a spring-forward gap the offset algebra answers a local time an hour **before** the
window opens — and in the future, so it looks plausible — meaning a gate that trusts the
arithmetic **dials early**. Wrong, not merely imprecise, and in the one direction a
compliance gate must never fail.

Also ratified for the window: `start == end` is an **empty** window, not 24 hours; an empty
`calling_days` means **no** dialable day; an overnight window's `calling_days` gates the day
it **opens**; `24:00:00` is a legal end-of-day sentinel.

#### Integration fixtures must not inherit the migration's window default

Migration 072 defaults `calling_hours` to **09:00–20:00 Mon–Fri**. With the calling-hours
gate live, any dialling test that inherits that default **depends on what time and day the
suite runs** — green on a Tuesday afternoon, dialling nothing on a Saturday, with the symptom
"zero dials" rather than an error. It reads as a pacing bug and reproduces only outside
office hours. `insertAgencyCampaign` therefore defaults to an **all-day, every-day** window;
a test that cares about the window sets it explicitly.

#### The lapsed-wrap-up sweep is deliberately campaign-status-agnostic

**A supervisor pausing or stopping a campaign must not strand a contact mid-wrap-up** — the
agent may have closed their laptop *because* it stopped. So the sweep must NOT filter on
campaign status, and that is a requirement rather than an omission. Asserted across all four
non-running statuses, so a status filter added for any one of them reds.

This is the clause someone adds later believing it an obvious optimisation. It is not.

**Related latent trap:** `wrapup_seconds` is nullable with no default
(`075_agency_attempts.sql:33`), and `ended_at + NULL < now()` evaluates to **NULL, not
false** — so without the `COALESCE` the row is silently invisible to the sweep and its
contact parks in `connected` forever, with no error anywhere. That is `MAG-88`'s failure
re-entering through a column nobody sets. The `COALESCE` is present and now carries a
permanent differential control proving the uncoalesced form cannot see the row.

#### `callback_at` outside calling hours: accept, defer, and return the real instant

A callback booked outside the window is **accepted and deferred to the next window open** —
a hard reject would block a legitimate "call me Saturday" on a Mon–Fri campaign, and the
operator's window is the compliance boundary, not the customer's request.

**The disposition response must return the instant we will actually dial, not the requested
`callback_at`,** and the field must be named as a scheduled dial time rather than an echo of
the request. Otherwise the console promises a time we will not honour — and the agent says
it out loud to the customer. That is the substance of `AD-P3-C-03`, not the scheduling.

#### The definition, fixed — N and the terminal filter

The test plan's §10 asked for these and nobody wrote them down, so the constants lived
only inside an implementation file with no owner. Both are settled here.

**N = 1000ms** (`ABANDONMENT_BRIDGE_GRACE_MS`). An attempt is abandoned when
`answered_at` is set and no `bridged_at` is recorded within N ms of it, **or** the attempt
ends `outcome='abandoned'`.

**The predicate is restricted to terminal attempts — `state = 'ended'`.** §10's original
form had no terminal filter, which makes it wrong in a way that only shows up under the
concurrency Phase 2 introduces: its `bridged_at IS NULL` arm is true of an attempt that is
answered and **still being bridged**, and of one mid-apology. So live traffic inflates the
compliance rate *in real time*, and `AD-P4-C-02`'s auto-pause would fire on a healthy
campaign at concurrency — pausing calls that were seconds from connecting, in the name of a
guardrail. **Abandonment is a property of a call that is over.** Anything else measures
in-flight work as failure.

Two consequences to hold onto:

- **QA's §10 audit query and core's `ABANDONED_ATTEMPT_PREDICATE_SQL` must agree
  exactly.** They are the two halves of a cross-check; if they differ, the cross-check
  fails for a reason that is not a bug, which is the most expensive kind of red.
- **The cross-check is only worth running while the two sides derive independently.** The
  counters are process-local (prom-client when written; OTel instruments since 2026-09-30); the rolling 24h window must come from
  `agency_call_attempts` — a fresh process cannot rebuild 24 hours. That is not a style
  preference, it is what makes the audit an audit: `AD-P2-C-11` found this metric agreeing
  with itself and returning 0 for months.

---

## 7. Composing with the existing dialer without entangling it

The rule: **the agency module depends on the bridge; the bridge never depends on
the agency module.** No import from `src/core/webrtc-bridge-manager.ts` into
`src/agency/` in the reverse direction, enforceable by a lint-free convention and
obvious in review.

The one change needed inside the bridge is a genuine decoupling that improves it:

```ts
// today — the browser leg is minted per call and attaches after the dial
createCall(params): Promise<{ record, token }>   // dials immediately, mints WS token

// added — the media socket is supplied by the caller, already open
createBridgedCall(params & {
  browserSocket: WebSocket;      // the agent's live station socket
  campaignId: string;
  agencyAttemptId: string;
}): Promise<WebRtcCallRecord>
```

`createBridgedCall` shares the existing dial, concurrency, recording, settlement
and analysis path — both entry points call one private `placeOutboundLeg()`.

**But the socket is *borrowed*, not owned, and that inversion is the real work in
this refactor.** The bridge today assumes one socket per call and disposes of it
accordingly. Three specific collisions, all verified against the source:

1. **`session.destroy()` closes both WebSockets** (`webrtc-bridge-session.ts:206-219`).
   Handed a station socket, every completed call would kill the agent's session and
   mark them offline — the agent would be logged out after their first call.
2. **`attachBrowserLeg` adds `message`/`close`/`error` listeners per call**
   (`:390-403`). On a socket reused across an 8-hour shift these accumulate: inert
   at first, then `MaxListenersExceededWarning`, then genuinely ambiguous handling.
3. **The close-handler ownership guard** (`session.browserWs !== ws`, `:396`)
   encodes socket-per-call semantics that no longer hold.

So §7's contract is explicit: **a borrowed socket is attached and detached per
attempt and is never closed by the bridge.** Concretely — a `BorrowedSocket` wrapper
(or an `ownsSocket: boolean` on the session) that makes `destroy()` detach rather
than close, per-attempt listener registration with matching teardown on end, and a
small control/media multiplexing envelope on the station socket so `reserved`,
countdown, `bridged`, heartbeat and media frames coexist.

This is **not 60 lines**. Budget it as the substantial half of Phase 0. The
regression bar is "existing WebRTC suites stay green", and that is necessary but
not sufficient — add a test that runs **three sequential calls over one station
socket** and asserts the socket is still open, with exactly one live listener set,
after the third.

**What is reused unchanged:** `TelephonyProviderRegistry`, `resolveSipDial()`
(so BYO SIP trunks work in campaigns on day one with no new code),
`acquireTelephonyConcurrency` (agency calls and AI calls share the tenant's
concurrency ceiling — as they must, since they share carrier capacity),
`dispatchSettlement` (billing is identical to a dialer call), the recording proxy,
and the dialer analysis worker.

**What must stay separate:** the AI pipeline. No `CallSession`, no prompt, no TTS.
The bridge is already correctly split this way (`webrtc-bridge-session.ts:11-14`)
and the agency module inherits that separation for free.

---

## 8. Cross-service surface

Per root `CLAUDE.md`, merge order is **core → master → cusui** for additive change.

**One hard deploy-ordering rule.** Master's unified settlement endpoint rejects an
unknown `call_type` with a 400 (`webhook-core.routes.ts`), so if core ships agency
settlements before master's branch and rate-card rows are live, every agency call
fails to settle. The `agency_dialer_enabled` flag defaulting to `false` covers this
— but only if it is respected: **the flag must not be enabled for any tenant until
master's settlement branch and the two rate-card rows are deployed.** Put it in the
rollout checklist, not just in a doc.

The 0.2mc attempt batcher's ownership also needs naming, since core counts attempts
and master owns credits: **core** accumulates per-campaign attempt counts and posts
an hourly `agency_dial_attempt` settlement through the same
`dispatchSettlement` → `/webhooks/core/settlement` path as every other operation,
carrying the count as the unit quantity. No new transport, no new secret.

### magic-voice-core

| Route | Purpose |
|---|---|
| `POST/GET/PATCH /api/v1/agency-campaigns` | campaign CRUD |
| `POST /api/v1/agency-campaigns/:id/{start,pause,resume,stop}` | lifecycle |
| *(no concurrency route — D9 routes this to the account setting)* | |
| `GET /api/v1/agency-campaigns/:id/stats` | supervisor dashboard payload |
| `POST /api/v1/agency/sessions` | agent joins a campaign |
| `WS /api/v1/agency/station/:sessionId` | **the station socket** — control + media |
| `POST /api/v1/agency/sessions/:id/{break,available,leave}` | agent state |
| `POST /api/v1/agency/attempts/:id/disposition` | disposition + notes + callback |
| `POST /internal/agency-campaigns/:id/contacts` | S2S chunked roster ingest |
| `POST /internal/agency/dnc-sync` | S2S DNC delta from master |

New feature flags in `src/feature-flags/registry.ts`:
`agency_dialer_enabled` (bool, default false, `clientExposed: true`),
`agency_max_agents_per_campaign` (number, default 100),
`agency_abandonment_ceiling_pct` (number, default 3 — a plain configurable
guardrail, not a jurisdictional claim, per D8).
No `agency_max_concurrency` flag: D9 makes `account_settings.max_concurrent_calls`
the single ceiling.

### magick-master

- `proxy-agency-campaigns.routes.ts`, `proxy-agency-agent.routes.ts` — standard
  `/proxy/*` pass-through with tenant/account header translation.
- `proxy-agency-station.routes.ts` — WebSocket proxy for the station socket,
  modeled on `proxy-media-stream.routes.ts` but **with a token in the query string**
  (the existing media-stream proxy is deliberately unauthenticated; a long-lived
  agent socket cannot be).
- `dnc.routes.ts` + `dnc.service.ts` + migration `050_dnc.sql`.
- `agency-campaign.service.ts` — owns campaign config, calls core to create the
  execution object, streams the roster.
- **New `agent` role** in `src/rbac/roles.ts` at hierarchy level 5, the
  `MembershipRole` union in `src/db/models/membership.model.ts`, and the invite /
  role-assignment surfaces. Per D6, agent-scoped permissions
  (`agency.station.connect`, `agency.attempts.handle`, `agency.attempts.dispose`,
  `agency.dnc.write`) take `agent` as their minimum role; supervisory permissions
  (`agency.campaigns.read` → viewer, `agency.campaigns.write` → account_admin,
  `agency.campaigns.control` → operator, `agency.supervise` → account_admin) keep
  their existing-style floors, which an agent at level 5 cannot reach.
- New governance capability tree in `src/governance/catalog.ts`. `CapabilityNode`
  requires `mandatory` and `label` too (`catalog.ts:9-16`):
  ```ts
  { key: 'agency',           parent: null,     default: false, mandatory: false, enforcement: ['nav','api'],         label: 'Agency Dialer' },
  { key: 'agency.recording', parent: 'agency', default: false, mandatory: false, enforcement: ['nav','behavioral'],  label: 'Agency call recording' },
  { key: 'agency.analytics', parent: 'agency', default: false, mandatory: false, enforcement: ['nav','behavioral'],  label: 'Agency call analysis' },
  ```
  `default: false` throughout — this dials real people at volume and spends credits.
  **The catalog file is marked FROZEN** ("do not edit without a contract change",
  `catalog.ts:1-7`), so Phase 0 includes an explicit ratification step, exactly as
  the escalation feature did — see the precedent comment on the `escalation` node.
- Billing (D7): migration seeding `agency_connected_call` (`call`, 25mc) and
  `agency_dial_attempt` (`attempt`, batched at 0.2mc), matching fallbacks in
  `credits/rate-card.service.ts`'s `DEFAULT_RATES`, and an hourly attempt-batch
  settler. The settlement caller branches on `webrtc_calls.campaign_id` so agency
  legs are **not** charged the 250mc/min `webrtc_call` rate.

### magick-comms-cusui

- `src/pages/agency/AgentConsolePage.tsx` — the agent screen (§9).
- `src/pages/agency/SupervisorPage.tsx` — live dashboard + controls.
- `src/pages/agency/CampaignBuilderPage.tsx` — CSV upload, column mapping,
  disposition catalog, calling hours, retry policy.
- `src/hooks/useAgencyStation.ts` — station WS lifecycle, heartbeat, reconnect with
  exponential backoff, `beforeunload` graceful leave.
- Add `'agency'` and children to the hand-maintained `RequireCapability` union in
  `src/components/auth/RequireCapability.tsx`.
- Vite proxy entry for the station WS (`ws: true`), matching the existing two.

---

## 9. The agent screen

The requirement — *"panel must render before or simultaneously with audio
connect"* — is an ordering guarantee, and it is satisfied by pushing context down
the station socket at **reservation**, not at answer:

```
t=0     engine reserves agent
t=0+5ms station WS ← { event: 'reserved', contact: {...full CSV row...},
                       attempt: { number, campaign, prior_attempts: [...] } }
        → UI renders the panel immediately, in a "connecting" visual state
t≈3-15s carrier answers, media bridges
        station WS ← { event: 'bridged', attempt_id }
        → panel switches to live, timer starts
```

The agent sees the contact *while it is ringing*, which is strictly better than
simultaneous — they have several seconds to read it. If the call never connects,
the panel clears on the `released` event. **Context is never fetched over HTTP at
bridge time**; there is no request that could be slow enough to lose the race.

The panel renders `agency_contacts.context` as a two-column table using the
original CSV headers verbatim, with the dialed number and campaign name pinned
above it, and prior attempt history (outcome, disposition, date, notes) below.

Agent actions: **hang up**, **disposition** (from `campaign.disposition_catalog`),
**notes**, **schedule callback** (datetime → `callback_at`), **mark DNC** (writes
through master, suppresses the contact immediately and publishes to core's Redis
set).

**Hang-up cannot reuse the existing route.** `POST /proxy/webrtc-call/:id/end` is
gated at `requirePermission('proxy.calls.create')`, which floors at `operator` (20)
— `proxy-webrtc-call.routes.ts:248-249`. D6 deliberately places `agent` at level 5
*below every existing permission floor*, so an agent cannot call it. That is the
role working as designed, not a bug in D6, but it means every agent action needs an
agency-native surface:

`POST /proxy/agency/attempts/:id/{hangup,disposition,dnc}`, gated at
`agency.attempts.handle` / `agency.attempts.dispose` / `agency.dnc.write`.

This is strictly better than reusing the generic route anyway, because core can
verify the caller **is the reserved agent for that attempt** — an ownership check
`/webrtc-call/:id/end` has no way to express. Same for the station socket: a
`hangup` control frame is authenticated by the socket itself.

Sweep the same way for every other agent action before Phase 1 — the general rule
is that **no `/proxy/*` route predating this feature is reachable by an `agent`.**

---

## 10. Open questions — RESOLVED except Q-D

D1–D9 (§0.1) cover everything below except **Q-D (scale targets)**, which remains
open but does not block Phase 0 or Phase 1. The original text is retained for the
record.

<details>
<summary>Superseded question text (Q-A → D6, Q-B → D7, Q-C → D8)</summary>


D1–D5 (§0.1) are settled. Four items remain. **Q-A blocks the master schema; the
rest can be answered during Phase 1** — but Q-B gets expensive to change once
settlement events are flowing.

**Q-A — How does an agency model its clients: accounts under one tenant, or one
tenant each?** *(blocking)*
D3 made agents full platform users, and a platform user's membership binds them to
a tenant/account. An agency running campaigns for eight client brands therefore
faces a fork:
 (a) **one tenant, one account per client** — an agent needs a membership per
     account to be shareable across clients, campaigns are account-scoped, and the
     DNC list has to decide whether it is tenant-wide (safer, but leaks one
     client's suppression list into another's dialing) or per-account (cleaner
     isolation, but a person who opted out of the agency is still called by it).
 (b) **one tenant per client** — clean isolation and clean DNC, but agents cannot
     be shared at all without duplicate identities, which is the outcome D3 was
     meant to avoid.
I lean (a) with **tenant-wide DNC as the default and a per-account override**,
because regulators treat the *caller* as the entity that must honour a suppression
request. The `dnc_entries` schema in §2.3 already supports both scopes, so this is
a defaulting decision, not a schema one — but agent-to-account mapping *is* schema,
and it blocks the master side.

**Q-B — Billing model.** Talk-time-anchored per call, exactly like a WebRTC dialer
call (`035_webrtc_call_rate_card`, reusing `dispatchSettlement` verbatim), or per
agent seat, or per connected call? D3 makes seats visible and countable, so seat
pricing is now genuinely available as an option. Reusing the dialer rate card is
the zero-new-code path; anything else needs an agency-aware rate path in master's
`credits/rate-card.service.ts`. Cheap now, awkward once events flow.

**Q-C — Primary regulatory market.** The *mechanism* in §6 is jurisdiction-neutral;
the numbers and the mandatory abandoned-call message are not. US TSR is 3% per
30 days per campaign with prescribed message content; Ofcom is 3% per 24h; TRAI
differs again. Under D1 abandonment should be ~0 regardless, so this sets the
guardrail ceiling and the message text, not the architecture. I have defaulted to a
3% rolling-24h ceiling — tell me the market and I will seed the correct default and
message.

*(Q-C text ends here.)*

</details>

**Q-D — Scale targets.** *(still open; not blocking)*
Contacts per campaign, agents per account, and the largest
`max_concurrent_calls` you expect to sell. D2 and D9 together sharpen this: a
**single** core replica carries every AI call, every existing dialer call, and now
every agency bridge on one Node event loop, and D9 means the agency ceiling is
whatever number an account is provisioned. The shapes in §2 hold to roughly 1M
contacts/campaign, and ~50 agents on one account is comfortable — but Phase 5's
load test needs a real number to prove, and it is also what tells us when
multi-replica stops being optional. **Assumed for now: 1M contacts, 50 agents,
`max_concurrent_calls` ≤ 50 per account.** Correct me and I will re-check the
partitioning and tick-batching decisions before migration `073` ships.

---

## 11. Delivery plan

**Phase 0 — seams (≈1.5 weeks, revised up).** The bridge refactor is the borrowed-
socket inversion in §7, not a 60-line extraction — that re-estimate is the main
change from the first draft. Also add the `agent` role
to master's `ROLE_HIERARCHY` / `MembershipRole` / invite surfaces and cusui's
`ROLE_LEVELS` / `Role` (D6) — additive, no existing permission changes. Extract
`placeOutboundLeg()` from `createCall` and add `createBridgedCall()` to the bridge
with tests, changing no existing behaviour. Land migrations `072`-`076` and the
master DNC + rate-card migrations. Ship the feature flag `agency_dialer_enabled`
(default off) and the governance capability. *This phase is mergeable and
invisible to existing users.*

**Phase 1 — the vertical slice (≈2.5 weeks).** One campaign, one agent, one list, no
retries, no DNC, no supervisor UI, no wrap-up.
- Core: `station-registry`, station WS with heartbeat, `agent-state-machine`
  (offline/available/reserved/on_call only) with the §6.1 lease lifecycle, a
  single-campaign pacing loop with the leader lease and `SKIP LOCKED` claim, dial
  dispatch, bridge on answer, the §6.2 **startup reaper** (cheap, and without it a
  single crash during testing quietly poisons the roster), and **outcome
  classification** — `no_answer`/`busy`/`failed`/`invalid` from carrier events.
  Retries are excluded from Phase 1, but outcomes cannot be: without them a
  non-answered call never leaves `in_flight` and the campaign never completes.
- Master: the `agency-csv-ingest` streaming parser (§2.2.1, ~4 days), campaign
  create + roster ingest, station WS proxy, agent-native action routes (§9), RBAC.
- cusui: minimal Agent Console — go available, receive a bridged call, see the
  context table, hang up.
- **Exit criterion:** one agent logs in, the engine dials a 50-row list at
  concurrency 1, every answered call bridges with the panel already on screen, and
  the campaign completes cleanly. Abandonment is 0 by construction.

**Phase 2 — the pool (≈2 weeks).** Multiple agents, real reservation contention,
account concurrency > 1, the abandoned-call path with the apology clip and rolling metric
(reachable in v1 only via reserved-agent loss, per D1), wrap-up state and timers,
break/not-ready with reason codes, presence resilience under tab-close, network
drop and process restart. **This is the phase that earns the design** — it is
where the CAS, the lease, and the heartbeat get proven, so budget real chaos
testing here: restart core mid-bridge and verify settlement plus `break`-on-return
(D2), drop an agent's network during ring, and force two leaders to race the same
contact.

**Phase 3 — the campaign lifecycle (≈2 weeks).** Retry policy by outcome, callback
scheduling, list exhaustion and completion, disposition catalog, notes, calling
hours with timezone handling, DNC end to end (ingest suppression + Redis dial-time
check + agent mark-DNC), CSV column mapping UI, per-upload accepted/rejected/
duplicate summary.

**Phase 4 — supervision and compliance (≈1.5 weeks).** Live dashboard (contacts
remaining, in flight, agents by state, connect rate, rolling abandonment rate, AHT,
average wrap-up), start/pause/resume/stop, live concurrency adjustment via the
existing account setting (D9), the
auto-pause abandonment guardrail, full audit trail through the existing
`auditLogger`, recording + dialer-analysis opt-in per campaign.

**Phase 5 — hardening (≈1 week).** Load test at target scale, cross-replica
failover drills, Grafana dashboards and alerts on the new Prometheus series,
runbook, and the multi-replica story documented and verified for the *existing*
dialer as well.

**Deliberately deferred:** AMD (unless Q1 selects (b)), predictive pacing, inbound
and blended queues, agent-to-agent transfer, live supervisor barge/whisper, skills-
based routing. The `overdial_ratio` column is the entire seam predictive pacing
needs — and §4.3 now records what the ratio should be, measured, so that work
starts from data rather than from the arithmetic being re-derived a third time.

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| **Single replica is a single point of failure** (D2) — one restart drops every live call and every agent | `gracefulShutdown()` settles bridges; agents rehydrate and land in `break`; campaigns auto-resume. Deploys should be scheduled outside campaign hours until multi-replica lands |
| Multi-replica arrives later and the seam has rotted | ownership key is written/read from day one even with one replica, so the invariant is exercised continuously rather than being dead code |
| One event loop carries AI calls + dialer + agency bridges | shared `acquireTelephonyConcurrency` bounds total carrier legs; Phase 5 load test must establish the real ceiling — see Q-D |
| Regulatory abandonment breach | reserve-before-dial default; rolling 24h metric; hard auto-pause ceiling; every abandoned call audited |
| A DNC number gets dialed | two independent checks at different layers; the dial-time check fails **closed** |
| Agent presence false-positive ⇒ answered call with no human | liveness derives from the Redis heartbeat key, not the DB row; per-state lease TTLs renewed by the owner (§6.1) |
| **A lease TTL used as a business timer** — the failure mode §6.1 exists to prevent | invariant: a TTL expires only when its renewer is gone. Ring timeouts, wrap-up and max duration live in the attempt row and existing timers. Worth asserting in review of any future TTL added here |
| Crash strands contacts in `in_flight`, silently shrinking the list | startup + periodic reaper (§6.2); trivial under D2 since any non-terminal row at boot is dead by definition |
| CSV ingest underestimated — 10k row cap, in-memory parse, hardcoded `phone` header | scoped explicitly as `agency-csv-ingest` in Phase 1 (§2.2.1) as a **new** module beside the existing parser, so bulk dispatch's working path absorbs none of the risk |
| Campaign calls starve AI calls of carrier capacity | shared `acquireTelephonyConcurrency` (D9) — one ceiling per account, already the correct behaviour; an account that wants both raises its limit |
| New `agent` role silently widens or narrows an existing role | `agent` sits *below* `viewer` and every pre-existing permission floors at `viewer` or higher — verified against `roles.ts`; a regression test should assert an `agent` membership resolves to exactly the four `agency.*` permissions |
| Bridge refactor regresses the existing dialer | phase 0 extraction is behaviour-preserving with both paths through one `placeOutboundLeg()`; existing WebRTC test suites must stay green unchanged |
| Roster table growth | partial indexes on live states only; retention purge hooks into `src/maintenance/retention-purge.ts` |

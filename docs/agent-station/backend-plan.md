# Agent station redesign: backend proposal

Written 19 Nov 2026 against the code in this repo, after reading the design hand-off
([`design-spec.md`](design-spec.md)) and its mock-ups ([`mockups/preview.html`](mockups/preview.html)).

How to read it:

- **Exists** means I opened the file and saw it.
- **New** means nothing supplies it today.
- **To verify** means I did not confirm it in code. The builder must check before relying on it.
- Screen numbers (01 to 12) are the designer's.
- Nothing in this document has been built or run. No test counts are claimed.

---

## 1. Summary

1. **The redesign can ship on today's data.** Phase 0 needs no server change. It shows screen
   `04c` (last calls and a note) in place of the script and the AI, and leaves out the target,
   the "will pay" count and the call-later list on pool campaigns.
2. **One new read, "my day", feeds Ready, Start of day and Finish work.** It gives calls, talk
   time, will pay, the target and the agent's own call-later list, with the day cut at the
   campaign's own midnight (IST for our tenants).
3. **A call-later gets a recorded booker.** Two new columns on the contact say who booked it and
   when. That feeds the agent's list, the "You said you will call at 3:00 PM" tag, and (if the
   owner wants it) a sticky call-later on pool campaigns.
4. **Customer facts become typed, by a setting, not by a schema change.** The campaign maps
   roster columns to roles (name, place, amount due, due date). The server parses money and
   dates once and sends them beside the raw text. The roster stays schemaless.
5. **A per-campaign script is a new campaign field** sent on the session bootstrap. The current
   step is client state.
6. **Need help works in every state** with a small change to one check. The supervisor side
   stays a 5 second poll, but the poll and its chime move to every supervisor page, not only
   Live floor. There is no supervisor push channel today and I do not propose building one for
   this.
7. **AI comes in three steps.** No AI first. Then an AI pick after hang-up, which will take a
   few seconds, not 2, until we have a live transcript. Then the live line, which needs a
   streaming speech-to-text vendor we do not have yet. The agent's choice is always the one
   that is saved.
8. **Four things the designer marked NEW are client-only:** the reconnect countdown, the
   console's headset and internet checks, read-aloud, and (first version) speak-a-note.
9. **Old mobile builds keep working.** Every new field is optional. Every new frame is sent
   only to a station that declares a new capability, the way inbound and floor assist frames
   are today.
10. **Six designer claims need correcting** (section 9). The main ones: the "no calls" reasons
    exist only on campaigns that assign contacts, the agent already has a callbacks read on
    those campaigns, and a help chime already exists.

---

## 2. What already exists

| Need | Exists? | Where |
|---|---|---|
| Outcomes per campaign, with follow-up flags | Yes | `AgencyDisposition` in `packages/contracts/src/agency/session.ts`; `disposition_catalog` on `AgencySessionBootstrap`; validated in `apps/server/src/agency/campaign-config.ts` (`validateDispositionCatalog`, `dispositionPromiseIssues`) |
| Pay date and amount on save | Yes | `AgencyDispositionRequest` (`agency/actions.ts`); rules in `packages/domain/src/promise-to-pay.ts`; decisions PT1 to PT3 |
| Break reasons with `limit_minutes` | Yes | `AgencyBreakReason` (`agency/session.ts`), 1 to 240 minutes (`agency/breaks.ts`); `validateBreakReasons`; decisions LF6, LF20 |
| Break over-time on the supervisor's floor | Yes | `AgencyFloorAgent.break_limit_minutes` (`api/agency/floor.ts`); console risk `long_break` (LF33) |
| Need help on a call or in wrap-up | Yes | `apps/server/src/api/routes/agency/floor-assist.ts` (`onCallOrWrapup`, `409 help_not_on_call`); service `apps/server/src/agency/floor-assist.ts`; columns from `0052_floor_assist.sql`; flag `agency_floor_assist_enabled` |
| Need help reaches supervisors | Yes, by poll | `GET /proxy/agency/floor` (`AgencyFloorAgent.help`), `FLOOR_POLL_MS = 5_000` in `apps/console/src/hooks/useAgentFloor.ts` |
| A chime for a new help request | Yes, on Live floor only | `apps/console/src/hooks/useHelpChime.ts`, used by `pages/agency/HomePage.tsx` (LF31) |
| Supervisor message to an agent | Yes | `POST /proxy/agency/sessions/:id/messages`; frame `supervisor_message` |
| A push channel to supervisors | **No** | No SSE or supervisor socket in `apps/server/src` or `apps/console/src`. The listener socket carries audio for one listen only |
| Agent dropped, seen by the supervisor | Partly | `AgencyFloorAgent.connected` (`StationRegistry.connectedBySession`); the card has a `disconnected` risk (`apps/console/src/utils/agency/liveFloorAgents.ts`). No chime, no metric |
| Calls today, talk time | Yes | `GET /proxy/agency/my-stats` (`proxy-agency-performance/per-agent.ts`), `AgencyAgentStatsTotals.attempts / connected / talk_seconds` |
| Agent's own "will pay" count | **No** | `GET /promises/summary` is `agency.supervise` and per campaign (`api/agency/promises.ts`) |
| Daily target | **No** | No column, no contract field |
| Account-wide callbacks list | Yes, supervisors only | `GET /proxy/agency/callbacks`, `requirePermission('agency.supervise')` (`proxy-agency-callbacks.routes.ts`, LF22) |
| Agent's own callbacks | Partly | `GET /proxy/agency/my-contacts?bucket=callback` (`agency.contacts.own`), but only with `agency_contact_assignment_enabled` on and only for contacts assigned to the agent |
| Who booked a callback | Partly | On `strict` / `preferred` the booker becomes the owner (`agency_contacts.assigned_user_id`, CA4). On `pool` nothing records it on the contact; the attempt row has `dispositioned_by_user_id` |
| "This reserved call is a booked call-later" | **No** | `buildPanel` in `apps/server/src/agency/dialer/live-attempt.ts` sends no such field |
| Customer facts | Yes, untyped | `AgencyReservedAttempt.context` (raw roster columns); `context_display.hero` |
| A guess at which column is the name | Yes, two of them | `packages/domain/src/context-hero.ts` (heuristic buckets: name, amount, identifier, place); `apps/server/src/agency/inbound/match-name.ts` (`name`, `full_name`, `customer_name`, `first_name`) |
| Last call, last note, last promise | Yes | `AgencyReservedAttempt.prior_attempts`, `.promise` |
| Per-campaign script | **No** | |
| "No calls right now" reasons | Partly | `campaign_state` frame for every campaign; `queue` frame **only on `strict` and `preferred`** (`agency/station.ts`, `pacing-engine.ts`) |
| Reconnect ladder | Yes, client | `backoffFor` in `apps/console/src/utils/agencyStationLiveness.ts`; the delay is a local variable in `useAgencyStation.ts` |
| "Call is kept for N seconds" | Yes | `intervals.deferred_hangup_ms` on the bootstrap |
| Wrap-up held when no outcome | Yes | `WrapupManager.onExpiry` sets `held_reason = 'disposition_required'` (`apps/server/src/agency/wrapup-manager.ts`) |
| Live call audio inside our process | Yes | The bridge relay; the listen tap (`apps/server/src/core/bridge/listen-tap.ts`, seam member `openListenTap`) gives both legs as A-law 8 kHz, 20 ms frames |
| Post-call transcript and analysis | Yes | `core/dialer-analysis-worker.ts`, `core/dialer-analysis-runner.ts`, `transcription/` (Gemini, Sarvam, batch only), `analysis/`; flag `agency_call_analysis` |
| Live transcription | **No** | No streaming transcriber anywhere |
| An AI outcome code | **No** | The analysis schema is sentiment, topics, summary, custom dimensions (`analysis/prompt-builder.ts`) |
| Text to speech for agents | **No** | `apps/server/src/tts/tts-file-cache.ts` caches clips for callers |
| Phone mask | Server helper only | `maskPhone` in `packages/observability/src/crypto.ts` (used by live calls, listening history, reports). The station is sent `phone_e164` in full |
| Capability gating for mobile frames | Yes | `caps=` on the station upgrade; `CAPABILITY_FOR_EVENT` in `station-registry.ts`; the Dart decoder turns an unknown frame into `UnknownFrame`, never a crash (`agency_wire/lib/src/station.dart`) |

---

## 3. Work items

Sizes: **S** is a few days, **M** is one to two weeks, **L** is more than two weeks. Each
includes tests and docs.

Rules that apply to every item (root `CLAUDE.md`):

- A contract change ships with its server and client consumers, the Dart types in
  `apps/mobile/packages/agency_wire`, regenerated `fixtures/agent/literals.json`, and
  `src/api/agency/CONTRACT-DIFF.md`, in one commit.
- A migration is a new file (next is `0056`), with a `BASELINE.md` section and a pinning test.
  Never edit an applied one. A lock on a live table starts with `SET LOCAL lock_timeout = '10s'`.
- Public routes go through the public layer and reach the dialer by `callCore` (B16). New
  routes are added to the route-table and agent-reach guard tests.
- Server integration is verified as CI does: `INTEGRATION_LANE=rest` and
  `INTEGRATION_LANE=wall-clock`, as separate runs.
- A new metric is declared in `packages/observability/src/metrics/agency.ts`, with the fixture
  `agency-otlp-instruments.json` updated and `pnpm test:grafana` run.
- User-facing copy is British English. Wire codes are not respelled.

### Area A. Station data

#### BE-0. Phase 0 wiring check (no server change)

1. **Today.** Everything Phase 0 needs is served: the bootstrap, the station frames,
   `my-stats`, `my-contacts`, the help routes, break limits.
2. **Change.** None on the server. The clients read what exists:
   - My day: `GET /proxy/agency/my-stats` with `from` = local midnight. Show calls and talk time
     only. Hide the target bar and the will-pay row.
   - Call-later list: `GET /proxy/agency/my-contacts?bucket=callback` on `strict` / `preferred`
     campaigns when `agency_contact_assignment_enabled` is on. Hidden on pool campaigns.
   - Need help: shown only on screens 04 and 05, where the server accepts it. This fits the
     "hide, do not grey out" rule.
   - On-call right side: `04c` (last calls from `prior_attempts`, the note).
   - Outcome and break icons: worked out from the flags and the label, as the designer suggests.
   - Reconnect countdown, headset and internet pre-checks, one-press End call, light theme.
3. **Edge cases.** The station must use its own copy keyed on codes, not the server's English
   sentences. The codes are already on every frame.
4. **Tests.** Console and mobile suites only. Mobile drives the controller with real frame
   sequences (`apps/mobile/CLAUDE.md`).
5. **Size S** on the backend (review and fixtures only). **Risk low.**

#### BE-1. "My day" read

1. **Today.** `my-stats` gives `attempts`, `connected`, `talk_seconds`, `successes`. The window
   is whatever `from` / `to` the client sends, so a phone with a wrong clock gets a wrong day.
   There is no agent-scoped promise count. There is no target.
2. **Change.** One new read, public layer, SQL only, like the callbacks list.

   `GET /proxy/agency/my-day?campaign_id=<uuid>`. Permission `agency.station.connect`. Then the
   account scope, then the dialer flag. The agent must be staffed on the campaign or hold a
   live session on it (reuse `staffedCampaign` from `proxy-agency-assignment/my-contacts.ts`).
   `Cache-Control: no-store`.

   ```ts
   // packages/contracts/src/api/agency/my-day.ts
   export interface AgencyMyDay {
     campaign_id: string;
     /** The campaign's zone, and the day served: its local midnight to the next. */
     timezone: string;
     day_start: string;   // ISO-8601
     day_end: string;     // ISO-8601
     /** Conversations: attempts with bridged_at, a redialled one counted once. */
     calls: number;
     /** Every attempt dialled for this agent. For "No answer" context, not the bar. */
     dialled: number;
     talk_seconds: number;
     /** Outcomes that recorded a promise today. Null: this campaign has no promise outcome. */
     will_pay: number | null;
     /** Connected calls with an is_success outcome. Shown when will_pay is null. */
     successes: number;
     /** BE-2. Null: no target set. */
     target: { metric: 'calls'; value: number } | null;
     /** BE-3. */
     call_later: AgencyMyCallLater;
     as_of: string;
   }
   ```

   - `calls` uses the same rule as the floor's `calls_today` and the grouped stats' `connected`
     (`CONVERSATION_ATTEMPT_SQL` in `db/repositories/agency/sql-fragments.ts`), so the agent and
     the supervisor see the same number.
   - `will_pay` counts the agent's attempts with `promise_date IS NOT NULL` whose outcome was
     written in the window. `0050_promise_summary_indexes.sql` already indexes promises by when
     their outcome was written; check its plan for a per-agent filter before adding an index.
   - The day is cut by `localDayEnd(campaign.default_timezone, now)`
     (`apps/server/src/agency/calling-hours.ts`), as the callbacks list does.
   - The station reads it on join, on every `ready` frame, after each saved outcome, and every
     60 seconds while Ready. No new frame.
3. **Edge cases.**
   - Soft-phone and inbound calls are not counted, as on the floor. Say so in the contract.
   - An agent on two campaigns in a day gets a count per campaign. The target is per campaign.
   - A reconnect just reads it again.
   - Old mobile builds never call it.
   - With media workers the read runs in the primary. It needs no session owner.
4. **Tests.** Unit: query parsing, the day cut for `Asia/Kolkata` and for a zone behind UTC.
   Integration (`rest` lane, real Postgres): counts against seeded attempts, the redial rule,
   another agent's rows never counted, a promise corrected by a replay counted once. Route-table
   and agent-reach guards. Metric: none of its own; the HTTP histogram covers it.
5. **Size M. Risk low.**

#### BE-2. Daily target

1. **Today.** Nothing.
2. **Change.** Migration `0056`: `agency_campaigns.daily_target_calls INTEGER NULL`, CHECK
   1 to 2000. Campaign config: `daily_target_calls` accepted on create and PATCH
   (`campaign-config.ts`, the public twin `agency-campaign-config.ts`, the audit diff in
   `campaign-config-audit.ts`). Served on the campaign wire type and in `AgencyMyDay.target`.
   A per-agent override (`agency_campaign_agents.daily_target_calls`) is a later step, only if
   the owner asks (question 9).
3. **Edge cases.** The target is not on the bootstrap, because a supervisor may change it
   mid-shift and the bootstrap is fixed for a session. Null means no bar, not zero.
4. **Tests.** `agency-campaign-config.test.ts`, `campaign-config-route.test.ts`, migration
   pinning test, `baseline-down-up.test.ts`.
5. **Size S. Risk low.**

#### BE-3. The agent's own call-later list, and who booked a call-later

1. **Today.** A callback is not a table. It is a `pending` contact whose last outcome booked one
   (`isCallbackSql` in `db/repositories/agency/assignment-sql.ts`), due at
   `next_attempt_at`. On `strict` / `preferred` the booker owns it (CA4). On `pool` nobody is
   recorded on the contact.
2. **Change.**
   - Migration `0057`: `agency_contacts.callback_booked_by_user_id UUID NULL` and
     `callback_booked_at TIMESTAMPTZ NULL`. Both nullable with no default, so the change is
     metadata only on a large table. Start with `SET LOCAL lock_timeout = '10s'`.
   - Migration `0058`: `CREATE INDEX IF NOT EXISTS idx_agency_contacts_my_callbacks ON
     agency_contacts (campaign_id, callback_booked_by_user_id, next_attempt_at) WHERE state =
     'pending' AND callback_booked_by_user_id IS NOT NULL`. Built `CONCURRENTLY` before the
     deploy (`db-hygiene.md`).
   - The disposition write that books a callback stamps both columns with the agent who took
     the call (not a supervisor filing on behalf, the same rule as CA4). A promise follow-up
     (PT2) stamps them too. The contact's next settled call clears them. This is in the
     contact write path tested by `agency-disposition-contact-write.test.ts`.
   - The list rides on `my-day`:

   ```ts
   export interface AgencyMyCallLater {
     /** Due from now to the campaign's midnight, plus overdue ones. Oldest first, at most 20. */
     rows: Array<{
       contact_id: string;
       /** BE-6's name, else matchName(context). Never the number. */
       customer_name: string | null;
       due_at: string;
       overdue: boolean;
     }>;
     today: number;
     overdue: number;
     /** True: these come back to this agent (strict / preferred and owned, or BE-3b on).
      *  False: pool, another agent may get the call. Drives the designer's copy rule 6.6. */
     comes_to_me: boolean;
   }
   ```

   - The rows are the contacts with `callback_booked_by_user_id = me` **or** (on `strict` /
     `preferred`) `assigned_user_id = me` and `isCallbackSql`. The second half picks up
     callbacks a supervisor handed to this agent (LF7).
3. **Edge cases.**
   - Inbound callbacks (`callback_source`) have no booker. They appear only when assigned.
   - A callback that fell back to the pool (CA5) keeps its booker but `comes_to_me` is false
     for the list, so the copy stays true.
   - Contacts booked before the migration have no booker. On assigning campaigns the owner
     half covers them. On pool campaigns they are missing from the list until redialled. No
     backfill: `dispositioned_by_user_id` on the attempt could feed one, but it is a scan of a
     large table for a list that empties itself in days.
   - Names are PII. The route is `no-store` and never returns a number.
   - "Finish work" (screen 11) says "Another agent will make it". That is true only when
     `callback_fallback = 'pool'` or the campaign is `pool`. On `strict` with `wait` it is
     false. The client must read `comes_to_me` and the fallback. Add
     `left_today_goes_to: 'pool' | 'waits_for_me'` to the object if the designer keeps the line.
4. **Tests.** Integration: the stamp on first disposition, not on a supervisor's on-behalf
   file, cleared on the next settled call, kept across a not-answered redial; plan test for the
   index (pattern `callbacks-list.test.ts`, `test/helpers/rerun-plan.ts`). Migration pinning.
5. **Size M. Risk medium** (touches the contact write on the hot disposition path).

#### BE-3b. Sticky call-later on pool campaigns (only if the owner says yes to question 11)

1. **Today.** Pool pacing ignores owners. A callback goes to whoever is free.
2. **Change.** A campaign setting `callback_to_booker: boolean` (default false). When on, the
   pacing claim for a pool campaign holds a due callback for its booker for the existing
   `callback_owner_grace_minutes`, then releases it. This reuses CA5's idea, not its code path:
   pool claims go through `claimDialable` in `contact.repository.ts`.
3. **Edge cases.** The booker is on a break, on a call, or off shift: the call waits up to the
   grace, so a customer promised 3:00 PM may be called at 3:30 PM. The booker left the company:
   the grace still ends it. Calling hours still apply.
4. **Tests.** Unit and integration on the claim, with `rerun-plan.ts`; a load scenario for
   pacing fairness.
5. **Size M to L. Risk high** (changes who pacing dials on the default mode). I recommend not
   building it now. See question 11.

#### BE-4. "This is your booked call-later" on the reserved call

1. **Today.** `buildPanel` (`agency/dialer/live-attempt.ts`) sends context, prior attempts, the
   promise and redial info. Nothing says the dial is a callback.
2. **Change.**

   ```ts
   // on AgencyReservedAttempt (agency/station.ts); AgencyActiveAttempt inherits it
   callback?: {
     /** The time that was booked. */
     due_at: string;
     booked_by_me: boolean;
     /** 'outcome': an agent booked it. 'promise': a pay-date follow-up. 'inbound': the customer rang in. */
     source: 'outcome' | 'promise' | 'inbound';
   };
   ```

   Filled from the contact record on the `DialCommand`: it is a callback when
   `callback_source` is set, or the last disposition is in `callbackCodes(catalog)` and the last
   outcome is `connected`. `booked_by_me` compares BE-3's column with the session's agent.
   **To verify:** that `cmd.contact.next_attempt_at` still holds the booked time when the panel
   is built. If the claim rewrites it, capture it in the claim's RETURNING.
3. **Edge cases.** Late binding builds the panel at dial time, so the field is there when the
   answer delivers it. A wrap-up redial carries no `callback`. A resumed call after a reconnect
   carries it through `ready.active_attempt`. Old mobile builds ignore an unknown key
   (**to verify** with `fixtures_test.dart`; the Dart decoders read named keys).
4. **Tests.** `agency-dialer.test.ts` (panel shape), the contract fixture `station.json` and
   `agency_wire` `station_test.dart`. The bridge-seam tests are not touched.
5. **Size S. Risk low.**

#### BE-5. "No calls right now" reasons on pool campaigns

1. **Today.** The designer says all four reasons exist. They do not for pool campaigns, which
   is the default mode. The `queue` frame is "sent only on `strict` and `preferred` campaigns"
   (`agency/station.ts`). A pool agent gets only `campaign_state` (`dialing`, and reasons such
   as `paused_by_supervisor`, `list_exhausted`). So on pool, "outside calling hours", "nothing
   due" and "next call at 3:00 PM" cannot be shown.
2. **Change.** The pacing leader already knows, per campaign, whether anything is due and why.
   Send the same `queue` state to pool agents, computed once per campaign per tick and sent
   only on a change (`pacing/agent-queue.ts`, `pacing-engine.ts`). Carry it on the bootstrap's
   `queue` and on `ready.queue` for pool too. No new type.
3. **Edge cases.** Old mobile builds on a pool campaign will start to receive `queue` frames
   and will show their existing "Nothing due" card. That is correct, but it is a visible change
   for old builds, so gate the pool frames behind a capability `queue_pool` for mobile if QA
   finds a problem. Cost: one cheap aggregate per pool campaign, cached with the pacing read
   cache; it must not add a query per agent.
4. **Tests.** `pacing-engine` unit tests, an integration test per reason, and the load suite's
   pacing-cost check.
5. **Size M. Risk medium** (pacing tick).

### Area B. Customer facts

#### BE-6. Typed customer fields

1. **Today.** `context` is the raw roster row. `context_display.hero` names up to 4 columns
   (`MAX_HERO_FIELDS`). Values are text as uploaded: "12500", "12,500.00", "20/11/2026". Two
   guesses at the name exist (`context-hero.ts`, `match-name.ts`).
2. **Change.**
   - Extend `AgencyContextDisplay` (stored in the existing JSONB column, no migration):

   ```ts
   export interface AgencyContextDisplay {
     hero?: string[]; order?: string[]; hidden?: string[];
     /** Which column plays each role. Column names as in the roster's header. */
     roles?: { name?: string; place?: string; amount_due?: string; due_date?: string };
     /** How to read a column. Absent: text. */
     types?: Record<string, 'text' | 'money' | 'date'>;
   }
   ```

   - A pure leaf, `packages/domain/src/context-facts.ts`, parses a value by type. Money: strip
     the rupee sign, spaces and grouping commas (Indian and western), return a decimal string.
     Date: ISO first, then day-first forms (`20/11/2026`, `20-11-26`, `20 Nov 2026`), return
     `YYYY-MM-DD`. Anything it cannot read returns null. It never guesses month-first.
   - The server adds the parsed facts to the panel:

   ```ts
   // on AgencyReservedAttempt
   facts?: {
     name?: string;
     place?: string;
     /** The tiles, in hero order, at most MAX_HERO_FIELDS. */
     tiles: Array<{
       column: string;
       role?: 'amount_due' | 'due_date';
       type: 'text' | 'money' | 'date';
       /** As uploaded. Always present. */
       raw: string;
       /** Parsed: a decimal string for money, YYYY-MM-DD for a date. Null: show `raw`. */
       value: string | null;
     }>;
   };
   ```

   - With no `roles` set, the server falls back to the heuristics in `context-hero.ts` for the
     name and place, and sends tiles as `text`. So today's campaigns work unchanged.
   - Campaign Settings gets role and type pickers. The roster import's column-mapping pass
     (`agency-column-analysis.ts`) suggests them from sample values; the supervisor confirms.
   - `matchName` callers (the callbacks list, the floor, inbound) take the role's column first.
3. **Why the server parses.** Otherwise the console (TypeScript) and the app (Dart) each write a
   money and date parser and they drift. The repo already carries one mirrored rule in Dart and
   its own CI trigger for it; one is enough.
4. **Edge cases.**
   - Formatting (₹12,500, "20 Nov") stays on the client: it is locale and theme work.
   - Currency: there is no currency setting, and decision LF2 (the currency) is still open. Until
     it is decided, the type is `money` and the client shows the tenant's default sign.
   - `hidden` wins over everything: a hidden column is never a role.
   - A role naming a column the roster does not have is refused at the write, with the list of
     the roster's columns (`agency_ingest_jobs.context_columns`) when there is one.
   - A date is a calendar day, not an instant. No zone conversion.
   - The frame is latency-guarded. Parsing 4 values is microseconds; do it in `buildPanel`.
5. **Tests.** Domain unit tests with a table of real-world values. Config validation tests.
   Panel tests. Contract fixture and Dart decode. The "Full / Half" amount chips need
   `tiles[role=amount_due].value`; test the null case hides them.
6. **Size M. Risk low to medium** (bad parsing shows a wrong amount to a collections agent, so
   the rule is: when in doubt return null and show the raw text).

#### BE-7. Phone mask

1. **Today.** `attempt.phone_e164` is sent in full. Agents can also see full numbers in
   `my-attempts`, `my-contacts`, customer history and the soft phone.
2. **Change, step 1 (Phase 0, client only).** The station shows a masked number. This is a
   display choice, not a privacy control: the number is still on the wire.
3. **Change, step 2 (only if the owner wants numbers hidden from agents).** A campaign setting
   `hide_numbers_from_agents`. Then every agent read must mask: the panel, `my-attempts`,
   `my-contacts`, customer history (which searches by number), and the soft phone cannot be
   offered at all on that account. `phone_e164` is a required field in the Dart types, so old
   builds need a value: send the masked text in a new `phone_display` and keep `phone_e164`
   only for stations without a `masked_phone` capability, or refuse old builds on such
   campaigns.
4. **Size S** for step 1 (no backend). **Size M to L, risk high** for step 2: it cuts across
   five read surfaces and breaks "read the number back" and manual dialling. I recommend step 1
   only. See question 6.

### Area C. Script

#### BE-8. Per-campaign script

1. **Today.** Nothing.
2. **Change.**
   - Migration `0059`: `agency_campaigns.agent_script JSONB NOT NULL DEFAULT '{}'`, CHECK it is
     an object.
   - Contract, on the bootstrap (campaign-constant, like `retry_context`):

   ```ts
   export interface AgencyAgentScript {
     /** "First, say this" on screen 03. */
     opening?: string;
     /** "What to say" on screen 04. 1 to 12 steps, each 1 to 200 characters. */
     steps: Array<{ text: string }>;
   }
   // AgencySessionBootstrap.script?: AgencyAgentScript
   ```

   - Placeholders in the text: `{name}`, `{place}`, `{amount_due}`, `{due_date}`,
     `{agent_name}`, `{campaign_name}`. The client fills them from `attempt.facts` (BE-6) with
     its own formatting. An unknown placeholder is refused at the write. A placeholder with no
     value for this customer is replaced by nothing and the step still shows.
   - Config validation and audit as for any campaign field. Campaign Settings gets an editor
     with a preview against a sample roster row.
3. **Edge cases.** A script edit reaches an agent on their next join, like every bootstrap
   field. An empty script means screen `04c`. The script may be in any language the supervisor
   types; it is plain text, never markup. Retry campaigns copy the parent's script
   (`campaign-retry.ts`). Old mobile builds ignore the field.
4. **Dependency.** Placeholders need BE-6. A script with no placeholders does not.
5. **Tests.** Config unit and route tests, bootstrap fixture (`session.json`), Dart
   `session_test.dart`, migration pinning.
6. **Size M. Risk low.**

### Area D. Need help

#### BE-9. Need help in every state

1. **Today.** `POST /proxy/agency/sessions/:id/help` refuses `409 help_not_on_call` unless the
   agent is on a call, in wrap-up, on a soft-phone call or a connected inbound call (LF13).
2. **Change.**
   - Replace `onCallOrWrapup` with "the session is live": joined and not left. That covers
     `offline` after joining, `available`, `reserved`, `on_call`, `wrapup` and `break`.
   - Add the state to the open request so the floor can say what the agent was doing:

   ```ts
   export interface AgencySessionHelp {
     raised_at: string;
     call_id: string | null;
     /** The agent's state when they raised it. Absent from an older server. */
     state_at_raise?: AgencyAgentState;
   }
   ```

     Migration `0060`: `agency_agent_sessions.help_state VARCHAR(20) NULL`.
   - What "answered" means with no call: a supervisor's message, which already answers a
     request (LF14). "I am coming to your desk" is a prefilled message in the console, the way
     Send reminder is. No new answer kind, so no new literal for old apps to trip on.
   - Listen still answers when the agent is on a call. A request raised while Ready and still
     open when a call connects can be listened to from the floor card's own `call`.
   - Keep `help_not_on_call` in the error union. Old servers send it and the mobile literals
     hold it. The new server no longer sends it.
   - Update decision LF13 in `docs/decisions.md`.
3. **Edge cases.**
   - Offline with no socket: cannot be sent. BE-11 covers it.
   - Spam: raise is idempotent while open, but raise, cancel, raise chimes each time. Add a
     server rule: at most one new request per session per 30 seconds, else
     `429 help_too_soon` (a new code: union, list and snapshot in `errors.ts`). To decide.
   - Mobile on `device_away`: the app is in the background and cannot press it. Fine.
   - Media workers: the route is session-owned (`api/core-owners.ts`), unchanged.
   - Old mobile builds show Need help only on call and wrap-up. They keep working.
   - Still behind `agency_floor_assist_enabled`.
4. **Tests.** `proxy-agency-floor-assist.routes.test.ts`, `floor-assist.test.ts`,
   `floor-assist-e2e.test.ts` (each state), `floor-assist-repository.test.ts`,
   `station_floor_assist_test.dart`. Metric: add a `state` label to
   `agency_help_requests_raised_total` (a relabel: update `grafana/` in the same commit).
5. **Size S. Risk low.**

#### BE-10. Help reaches a supervisor on any page

1. **Today.** The floor is polled every 5 seconds and chimes, but only while the supervisor is
   on Live floor (`HomePage.tsx`). On any other page a help request is silent. The designer's
   "pushed to the floor" suggests a push channel. None exists.
2. **Change.**
   - A light read: `GET /proxy/agency/floor/help` (`agency.supervise`, account scope, dialer
     flag, floor assist flag). It returns only the open requests:
     `{ requests: Array<{ session_id, agent_user_id, agent_name, campaign_name, raised_at,
     state_at_raise, call_id }>, as_of }`. It reads from `idx_agency_agent_sessions_help_open`,
     which exists. It is far cheaper than the full floor read.
   - The console polls it every 5 seconds from the shell (`ConsoleLayout`) for supervise
     holders, plays the existing chime, and shows a banner that opens Live floor.
   - No server push. Worst case a supervisor hears it 5 seconds late, 2.5 on average. That is
     fine for a human who then has to walk or click.
3. **Edge cases.** Two supervisors both hear it; the first answer clears it for all (exists).
   A tab in the background throttles timers; the chime can be late. Supervisors on the mobile
   app are out of scope (LS3).
4. **If the owner wants true push later.** Build one supervisor event stream (SSE) for the
   whole Live floor, not for help alone. With media workers, events come from workers to the
   primary over IPC. That is an L item and belongs with the Live floor, not this redesign.
5. **Tests.** Route unit tests, integration against the index, console `navRouteGates`-style
   gating tests.
6. **Size S** (server) plus console work. **Risk low.**

#### BE-11. An agent dropped while working

1. **Today.** The floor row has `connected`, and the card has a `disconnected` risk. There is
   no chime, no "Needs you now" row (**to verify** in `liveFloor.ts`), and no metric.
2. **Change.**
   - Add `disconnected_since: string | null` to `AgencyFloorAgent`, from the station registry's
     detach time. It is in memory, so it is null after a restart; say so in the contract.
   - Include agents down for more than 20 seconds in BE-10's light read as a second list, so
     the shell can alert. 20 seconds avoids alerting on every wifi blip (the reconnect ladder
     usually wins inside that).
   - Metric `agency_station_disconnects_total{client_kind, state}` and a histogram of time to
     reconnect. Alert when many agents of one account drop together: that is our outage, not
     their wifi.
3. **Edge cases.** A mobile agent who leaves the app is `device_away`, not dropped; do not
   alert. An agent on a call who drops is already covered by the deferred hang-up.
4. **Size S to M. Risk low.**

### Area E. Breaks and tiles

#### BE-12. Break over time: record it

1. **Today.** The agent and the floor both see it. Nothing is recorded as an event and no
   report counts it.
2. **Change.** When a break ends, compare its length with the reason's limit (the pure rule is
   in `packages/domain/src/break-manager.ts`). If over, write a session event with the minutes
   over (`agency_agent_session_events`), and count
   `agency_break_overruns_total{tenant_id}`. Add "breaks over limit" and "minutes over" to the
   agent report dataset (`apps/server/src/agency/reports/datasets/agent.ts`). No auto-return,
   no message to the supervisor: the floor already shows it.
3. **Edge cases.** Reserved breaks (`device_away`, `phone_call`, `soft_phone`, `away_ring`)
   never count. A break that ends because the session ended is measured to the end. A server
   restart puts agents on a break with no reason: not counted.
4. **Tests.** Domain unit tests, an integration test on the event, the report dataset test.
5. **Size S to M. Risk low.**

#### BE-13. Optional icons on outcomes and break reasons

1. **Today.** No field. Note: `validateDispositionCatalog` and `validateBreakReasons` do not
   refuse unknown keys, so a stray `icon` could already be stored in some catalog. The read
   must not trust it.
2. **Change.** A closed list in contracts, about 24 keys:

   ```ts
   export const AGENCY_TILE_ICONS = ['rupee', 'clock', 'stop', 'thumbs_up', 'thumbs_down',
     'phone_missed', 'voicemail', 'wrong_number', 'question', 'tea', 'lunch', 'washroom',
     'meeting', 'training', 'prayer', 'dot', /* … */] as const;
   // AgencyDisposition.icon?: AgencyTileIcon;  AgencyBreakReason.icon?: AgencyTileIcon;
   ```

   The write refuses a value not in the list. The read drops one (as `resolveBreakReasons`
   drops a bad limit). Absent: the client uses the designer's flag rule.
3. **Edge cases.** The list is a vocabulary the app switches on, so it goes into
   `literals.json`. An app older than a newly added icon must fall back to the flag rule, never
   fail the bootstrap: the Dart decoder must read an unknown icon as "none". Test that.
4. **Size S. Risk low.**

### Area F. AI

#### Where call audio is today

- **Live:** only inside the bridge, in the process that owns the call. The listen tap already
  fans out both legs, normalised to A-law 8 kHz in 20 ms frames, to any `ListenSink`
  (`core/bridge/bridge-types.ts`). It is built so a sink can never slow or break the call.
- **After the call:** the carrier's recording, fetched by URL when the carrier says it is ready.
  The runner already handles carriers that serve a file before it is finished. So the
  recording is seconds to minutes late. It cannot feed anything "within 2 seconds of hang-up".
- **Analysis:** a queue worker, batch transcription (Gemini or Sarvam), then one LLM call. It
  returns sentiment, topics and a summary. It is designed to run late and retry.

So anything fast must use the tap. That is the key architectural fact.

#### BE-14. AI assist plumbing

1. **Change.**
   - Flag `agency_station_ai_enabled` in `packages/contracts/src/flags.ts`, registered in
     `apps/server/src/feature-flags/registry.ts`. Default off, scopes global, tenant, account,
     client-exposed. Same reasoning as `agency_call_analysis`: it costs money and touches
     consent, so it is turned on by an override row.
   - Per campaign: `ai_assist: { suggest_outcome: boolean; live_line: boolean; language?:
     string }` in a new JSONB column (migration `0061`).
   - A station capability `ai_assist` (`AGENCY_STATION_CAPABILITIES`). A console has every
     capability. A phone gets the AI frames only if it declares it.
   - A second tap consumer type. The listen caps (LS5: 2 per call, 20 per process) and the
     consent flag `agency_live_listen_enabled` are about humans listening. The AI sink must not
     use up a supervisor's slot or be blocked by that flag. Add a separate, single AI sink per
     call with its own cap and its own counter. This changes the bridge seam
     (`openListenTap` options), so it ships with the seam's pinning tests
     (`webrtc-bridge-seam-contract.test.ts`, `webrtc-bridge-manager.seams.test.ts`).
   - `AiPurpose` in `apps/server/src/ai/types.ts` gains `station_suggestion`. Config keys go in
     `src/config/blocks/analysis.ts` (provider, model, timeout, concurrency), kept disjoint.
   - A table for what was suggested and what the agent then saved (migration `0062`):
     `agency_outcome_suggestions (attempt_id PK, tenant_id, account_id, campaign_id,
     disposition_code, promise_date, promise_amount, callback_at, note, source, latency_ms,
     delivered, created_at, saved_code, saved_at)`. Purged with transcripts.
2. **Consent.** The agent screen says "AI is listening". The customer has only the recording
   notice. Whether that covers live AI processing is a legal question for Manas, as the listen
   notice was (LS1, LS2). Do not turn the flag on for a tenant before that answer.
3. **Size M. Risk medium** (a seam change).

#### BE-15. AI pick after hang-up (outcome, date, amount, note)

1. **Change.**
   - While the call is live, the AI sink keeps the audio it is given in memory, capped at the
     last 5 minutes per call. A-law at 8 kHz is 8,000 bytes a second per leg: 4.8 MB for 5
     minutes of both legs. At 100 calls at once that is up to 480 MB, so it needs a byte budget
     of its own, like `core/recording-byte-budget.ts`. When the budget is full, a call simply
     gets no suggestion.
   - When the bridge finalises the call, the sink hands the audio to one request: audio plus
     the campaign's outcome list in, strict JSON out. The outcome list sent to the model is
     only codes an agent may pick: no `suppress` outcomes (Don't call again must be a human
     choice), no automatic outcomes.
   - The server checks the answer against the catalogue with the same rules as a real save
     (`validateDispositionFields`): unknown code, a date in the past or more than 30 days out,
     a call time outside calling hours. A field that fails is dropped. A bad code drops the
     whole suggestion.
   - It is delivered as a frame, and on `ready` for a reconnect:

   ```ts
   export interface AgencyStationOutcomeSuggestionFrame {
     event: 'outcome_suggestion';
     attempt_id: string;
     suggestion: {
       disposition_code: string;
       promise_date?: string;     // YYYY-MM-DD
       promise_amount?: string;   // decimal string
       callback_at?: string;      // ISO-8601
       note?: string;             // at most 500 characters, plain text
     };
   }
   // AgencyStationReadyFrame.outcome_suggestion?: the same, when a wrap-up is active
   ```

2. **Latency, honestly.** The design asks for about 2 seconds. With a one-shot audio request I
   expect 3 to 8 seconds for a typical call. I have not measured it and nobody should promise a
   number before a spike on real recordings. So the screen must not wait:
   - The tiles show at once, with nothing picked.
   - If the suggestion arrives before the agent has touched a tile, the tile gets "AI chose".
   - If the agent has already picked, the suggestion is dropped on the client and never moves
     their choice.
   - After a hard deadline (config, default 8 seconds) the server sends nothing.
   Two seconds becomes realistic only with a live transcript (BE-16): then hang-up needs one
   short text request.
3. **The agent's choice is authoritative.**
   - A suggestion is never saved by the server. Only `POST` disposition saves.
   - The wrap-up timer running out never files a suggestion. `WrapupManager.onExpiry` already
     holds the agent with `disposition_required`; that stays.
   - The designer notes that today a picked outcome is saved when the timer ends. I did not
     find that in the code (**to verify**; the server only holds the agent). Whatever the
     client does, an AI-picked tile the agent has not touched must not count as "picked" for
     it.
   - The server records what was suggested and what was saved, so we can report agreement
     without the client sending anything new.
4. **Failure modes.**
   - AI off, late, over budget, vendor down or rate-limited: no frame. The screen is the no-AI
     screen. Reuse the vendor breaker idea (`core/vendor-rate-limit-breaker.ts`).
   - Very short calls (under 10 seconds of talk): do not ask. Nothing to hear.
   - Wrap-up redial: a suggestion belongs to an attempt id; a redial is a new attempt.
   - The call dropped (`agent_disconnected`): still suggest, the audio up to the drop is there.
   - Media workers: the sink, the request and the frame all live in the worker that owns the
     call. No audio crosses IPC.
   - Server restart mid-call: the buffer is gone, no suggestion. Acceptable.
   - Notes are free text about a customer. They go through the same retention as agent notes.
     Prompts and audio are not logged.
   - Languages: calls are in Hindi, Telugu and English, often mixed. Accuracy must be measured
     per language before a tenant gets it.
5. **Cost.** One audio request per connected call. It scales with talk minutes, the same driver
   as post-call analysis. If a tenant has both on, the same audio is paid for twice, so a later
   step should let the analysis runner reuse this transcript.
6. **Tests.** Unit: the validator against catalogue rules, the deadline, the budget.
   Integration with a fake AI client: frame order (`released`, `wrapup`, then
   `outcome_suggestion`), reconnect, no frame to a station without the capability. A load
   scenario for the memory budget. Metrics:
   `agency_outcome_suggestion_seconds` (histogram, hang-up to frame),
   `agency_outcome_suggestions_total{result}` (sent, late, invalid, budget, vendor_error),
   `agency_outcome_suggestion_agreement_total{match}`. Alert on a high late or error share.
7. **Size L. Risk high** (latency, accuracy, cost, consent).

#### BE-16. Live transcript and the "AI is listening" line

1. **Change.**
   - A streaming speech-to-text client behind an interface, beside the batch `Transcriber`s in
     `apps/server/src/transcription/`. The repo has none. The vendor must take 8 kHz telephone
     audio and handle Hindi, Telugu and Indian English. Choosing it is a spike with real
     recordings, and a decision for Manas.
   - The AI sink streams both legs to it and receives partial and final text.
   - Every few seconds, or on a final customer sentence, a small text request turns the recent
     transcript into one short line. Rate: at most one frame every 3 seconds per call.

   ```ts
   export interface AgencyStationAiLineFrame {
     event: 'ai_line';
     attempt_id: string;
     /** One line, at most 120 characters, plain text. */
     text: string;
     /** Counts up per attempt; a client ignores a lower one. */
     seq: number;
   }
   ```

   - At hang-up the transcript is already there, so BE-15's request becomes text-only and the
     2 second target is reachable.
2. **Edge cases.** The line must never tell the agent what to say about money or law; it only
   restates what the customer said. A wrong line is worse than none, so below a confidence
   threshold send nothing. The vendor socket dropping mid-call ends the line for that call and
   falls back to BE-15's audio path at hang-up. A reconnecting station gets the latest line on
   `ready`. The frames ride the same socket as audio, so they are small and rate-limited.
3. **Cost.** Streaming is billed per audio minute for every minute of every call, both legs.
   For a floor of 100 agents talking 4.5 hours each, that is about 27,000 call minutes a day.
   Put the vendor's price against that number before deciding.
4. **Tests.** A fake streaming vendor in `test/mocks/`, soak tests for socket churn, the tap's
   existing fault tests extended to the AI sink.
5. **Size L. Risk high.** Build only after BE-15 has been in use and its accuracy is known.

#### BE-17. Read aloud and Speak a note

1. **Read aloud.** Use the browser's and the phone's own speech. No server work. Server-made
   clips per label would need a TTS vendor, a cache and a purge for labels supervisors edit
   freely; not worth it for a helper icon. Size: none on the backend.
2. **Speak a note, step 1.** The device's own speech-to-text into the note box. No server work.
   Quality varies by device and language.
3. **Speak a note, step 2 (only if step 1 is not good enough).**
   `POST /proxy/agency/sessions/:id/note-clips` (`agency.attempts.dispose`, behind
   `agency_station_ai_enabled`): a clip of at most 30 seconds and 512 KB, transcribed
   synchronously through `transcription/` with an 8 second timeout, answering `{ text }`. The
   audio is never stored. Rate limit per session. The text goes into the box for the agent to
   edit; it is saved only by the normal note save.
4. **Size S to M** for step 2. **Risk medium** (a synchronous vendor call on an agent's wrap-up
   time).

### Area G. Things that need no backend

| Need | Why no backend | Note |
|---|---|---|
| Reconnect countdown (09, 10) | The delay is computed in `useAgencyStation.ts`; expose it | The mobile controller needs the same |
| "Call is kept for 0:12" | `intervals.deferred_hangup_ms` exists | The count starts when the socket closes on the client; the server's timer started at about the same moment |
| Headset check (01) | `enumerateDevices` after mic permission | A guess from the device label; never block Start work on it |
| Internet check (01) | The station socket's first `pong` | The socket opens at join, before Start work, so one round trip is a fair check. No new endpoint |
| Save & take break | Two existing calls | Queue the break first, then save: if the save fails the break can be cancelled (`POST …/break/cancel`) |
| Chip sets, light theme, keys | Client | |

---

## 4. Phased delivery

| Phase | Goal | Items | Depends on |
|---|---|---|---|
| **0. Redesign on today's data** | Every screen ships. `04c` on the call. No AI, no target, no will-pay. Need help on 04 and 05 only | BE-0 | Nothing |
| **1. The station's own data** | My day with target and will-pay, the call-later list and tag, no-calls reasons on pool, Need help everywhere, alerts for supervisors, break over-time recorded, icons | BE-1, BE-2, BE-3, BE-4, BE-5, BE-9, BE-10, BE-11, BE-12, BE-13 | BE-1 carries BE-2 and BE-3. BE-4 needs BE-3's columns. BE-10 reads BE-9's `state_at_raise` |
| **2. Typed facts and the script** | ₹ and date tiles that are reliable, Full / Half chips, "First, say this", numbered steps | BE-6, BE-8 | BE-8's placeholders need BE-6 |
| **3. AI pick after hang-up** | "AI chose" on a tile a few seconds after hang-up, with date, amount and note | BE-14, BE-15, BE-17 (step 2, optional) | Legal answer on consent. A spike on latency and accuracy. BE-6 helps the model with the amount due |
| **4. The live line** | "AI is listening" during the call; the pick inside 2 seconds | BE-16 | BE-14, BE-15, a streaming vendor |
| **Not recommended now** | | BE-3b (sticky call-later on pool), BE-7 step 2 (hide numbers on the server) | Owner's decisions 11 and 6 |

Phase 1 can be split into two releases if needed: (BE-1, BE-2, BE-9, BE-13) first, they are
small and safe; then (BE-3, BE-4, BE-5, BE-10, BE-11, BE-12).

---

## 5. Contract and migration list

**Migrations** (numbers are the next free ones today; take the real next number at build time):

| # | What | Table size concern |
|---|---|---|
| 0056 | `agency_campaigns.daily_target_calls` | Small table |
| 0057 | `agency_contacts.callback_booked_by_user_id`, `callback_booked_at` | Large table. Nullable, no default: metadata only. `lock_timeout` |
| 0058 | Index `idx_agency_contacts_my_callbacks` (partial) | `CREATE INDEX IF NOT EXISTS`; build `CONCURRENTLY` before the deploy |
| 0059 | `agency_campaigns.agent_script` JSONB | Small table |
| 0060 | `agency_agent_sessions.help_state` | `lock_timeout` |
| 0061 | `agency_campaigns.ai_assist` JSONB | Small table |
| 0062 | `agency_outcome_suggestions` | New table; add to the retention purge |

`context_display.roles` / `.types` and the `icon` fields live in existing JSONB columns: no
migration.

**Contract changes** (`packages/contracts`):

| File | Change | Kind |
|---|---|---|
| `src/api/agency/my-day.ts` (new) | `AgencyMyDay`, `AgencyMyCallLater` | New read |
| `src/api/agency/floor.ts` | `AgencyFloorAgent.disconnected_since`; the light help read's types | Optional field, new read |
| `src/agency/station.ts` | `AgencyReservedAttempt.callback`, `.facts`; capabilities `ai_assist` (and `queue_pool` if needed); frames `outcome_suggestion`, `ai_line`; `ready.outcome_suggestion` | Optional fields, new frames behind a capability |
| `src/agency/session.ts` | `AgencyContextDisplay.roles`, `.types`; `AgencySessionBootstrap.script`; `AgencyDisposition.icon`; `AgencyBreakReason.icon`; `AGENCY_TILE_ICONS` | Optional fields, one new closed list |
| `src/agency/floor-assist.ts` | `AgencySessionHelp.state_at_raise` | Optional field |
| `src/errors.ts` | `help_too_soon` (if adopted) | Union, list and snapshot |
| `src/flags.ts` | `agency_station_ai_enabled` | New flag, plus the server registry |
| `src/api/agency/agency-campaign.ts` | `daily_target_calls`, `agent_script`, `ai_assist` on the campaign wire types | Optional fields |
| `fixtures/agent/*.json` | `session.json`, `station.json`, `floor-assist.json`, `reads.json`, `literals.json` | Regenerate with `tooling/contracts-literals.mjs` |
| `src/api/agency/CONTRACT-DIFF.md` | Every difference between the dialer and console types | Update |

Nothing is removed or renamed. No existing field changes type.

**New routes:**

| Method and path | Permission | Flag |
|---|---|---|
| `GET /proxy/agency/my-day` | `agency.station.connect` | dialer |
| `GET /proxy/agency/floor/help` | `agency.supervise` | dialer, floor assist |
| `POST /proxy/agency/sessions/:id/note-clips` (optional) | `agency.attempts.dispose` | station AI |

No new permission is needed. The `agent` role keeps its current set.

---

## 6. Rollout and flags

| Flag | State | Gates |
|---|---|---|
| `agency_floor_assist_enabled` | Exists, off by default | Need help (all states after BE-9), messages, the light help read |
| `agency_contact_assignment_enabled` | Exists | Phase 0's call-later list (through `my-contacts`). Not needed once BE-3 lands |
| `agency_late_binding` | Exists | Not changed. `callback` and `facts` are built at dial time and delivered at the answer |
| `agency_station_ai_enabled` | **New**, off by default | BE-15, BE-16, the note-clip route. Per tenant or account, by a super-admin override |
| `agency_live_listen_enabled` | Exists | Not reused for AI. The AI sink has its own gate |

Per-campaign settings (script, roles, target, icons, AI switches) default to "off / empty", so
no campaign changes behaviour on deploy.

Super-admin: the new flag appears in the flag catalogue automatically from the registry. If AI
cost needs to be seen per tenant, add suggestion counts to
`super-admin-usage-counts.routes.ts` (S, not listed as its own item).

**Old mobile builds.**

- New optional fields on existing shapes are ignored (to verify once with the fixtures test).
- New frames go only to stations that declare the capability. An old build never receives
  `outcome_suggestion` or `ai_line`. Even if it did, the Dart decoder makes an unknown frame an
  `UnknownFrame`.
- New closed vocabularies (`AGENCY_TILE_ICONS`) must decode an unknown value as "none".
- BE-5 sends an existing frame (`queue`) to more agents. Old builds already render it. Check it
  on a pool campaign before release, and gate it by capability if it misbehaves.
- BE-9 loosens a refusal. Old builds still show the button only where they did.
- The server cannot force an app update today. If a later item truly needs a minimum build,
  that is new work (a minimum version on the bootstrap). Nothing here needs it.

**Order of deploy.** Migrations and server first, then the console, then the app. Every item
above is safe in that order because the server only adds.

---

## 7. Risks

1. **AI latency.** Two seconds after hang-up is not reachable without a live transcript. If the
   screen is built to wait for AI, agents will wait on every call. The screen must work with no
   suggestion and accept a late one.
2. **AI accuracy on mixed Hindi, Telugu and English at 8 kHz.** Unknown. A wrong pre-picked
   "Will pay" with a wrong date, confirmed by a tired agent, books a wrong follow-up. Measure
   agreement per language and per campaign before turning it on, and never let a timer save it.
3. **Consent for live AI.** The customer hears a recording notice. Whether that covers live
   machine processing needs a legal answer, as listening did.
4. **Memory for buffered audio (BE-15).** Up to about 5 MB a call. It needs its own budget and
   a clean failure, or a busy hour pushes the media process into swap and hurts call audio.
5. **The bridge seam.** BE-14 adds a second kind of tap consumer. The tap is designed never to
   touch the call; the change must keep every guard and its pinning tests.
6. **The pacing tick (BE-5, BE-3b).** Any extra query per agent per tick costs at 400 to 500
   calls. BE-5 must be one aggregate per campaign.
7. **The contact write (BE-3).** The disposition path is hot and has many rules (CA4, PT2,
   replays). The stamp must be in the same statement as the existing write.
8. **Wrong amounts (BE-6).** A parser that guesses shows a wrong ₹ figure. The rule is null and
   raw text when unsure.
9. **"These calls will come to you" being false.** On pool campaigns, and on assigning
   campaigns after a fallback, it is not true. The server sends `comes_to_me`; the client must
   use it.
10. **Help noise.** Help in every state plus an alert on every page can train supervisors to
    ignore the chime. Watch `agency_help_requests_raised_total` by state after release.
11. **Not yet proven in the field.** The docs say nothing has run against a real carrier, on a
    real phone, or with alerts applied. Every estimate here assumes the base works as its tests
    say.

---

## 8. Answers to the open questions (backend side)

1. **AI before or after?** After. Ship Phase 0 with `04c`. The script (BE-8) is ordinary work
   and can come in Phase 2. The AI pick is Phase 3 and the live line Phase 4.
2. **End call in one press.** The server does not care: `hangup` is one frame either way. One
   server note: a hang-up cannot be undone and the customer may not answer a redial. I would
   keep a short hold on the phone.
3. **Hiding instead of disabling.** No backend side. One caution: the server stays the judge.
   A hidden button is not a permission; every action is still refused by the server when it is
   not allowed, and the client must handle that refusal.
4. **The six tiles.** Keep them free and recommend six. A fixed set would fight the catalogue
   rules that exist (three built-in codes, per-outcome retry, promise and override flags) and
   every existing campaign. Offer a "collections" starter catalogue as a template at campaign
   creation instead (S, console plus a constant in `campaign-defaults.ts`).
5. **Need help with no internet.** Yes. Build BE-11: an alert for supervisors when a working
   agent has been disconnected for more than 20 seconds. The screen's "call your supervisor to
   your desk" is right.
6. **Hide part of the phone number?** Mask on the screen only (client). Do not mask on the
   server now: agents with the soft phone or customer history see full numbers anyway, and
   doing it properly touches five read surfaces (BE-7 step 2).
7. **Booking a break during a call.** Already supported by the server (`pending_state`,
   `pending_break_reason`, cancel). The `B` key plus Save & take break is enough. No change.
8. **Stopping a call while it is ringing.** The server accepts a hang-up on a reserved call
   today. Leaving the button off is safe. With late binding the agent never sees ringing at
   all, so this matters only on early-binding accounts. Keep the `E` key working there, since a
   wrong customer on screen is a reason to stop.
9. **Daily target.** One number per campaign, counted in connected calls ("conversations"),
   the same number the supervisor's floor shows for the agent. Dialled calls measure the list,
   not the agent. A per-agent override can follow.
10. **What counts as "Will pay"?** Outcomes that recorded a pay date. That matches the
    supervisor's "Will pay" (the promises summary). On a campaign with no promise outcome the
    server sends `will_pay: null` and the screen shows successes under the campaign's own word.
11. **Call-later on pool campaigns.** Do not make it sticky now. On a pool the promise to the
    customer is "we will call at 3:00 PM", and a free agent keeps that promise better than a
    busy one. Record the booker (BE-3) so the list and the tag work, and tell the truth in the
    copy. If stickiness matters to a tenant, the product already has it: `preferred` mode.
12. **Over-time breaks.** Record it and report it (BE-12). No automatic message: the floor
    already flags it, and a message per late break is noise.
13. **Read aloud and Speak a note.** Use the device's own speech in both directions first, in
    whatever languages the device has. A server path (BE-17 step 2) only if that proves too
    poor, and then Sarvam is the transcriber already in the repo that targets Indian languages.
14. **Light theme.** No backend side. If the choice should follow the agent across devices it
    needs a user preference field; today I would keep it in the browser and the app.

---

## 9. Designer claims checked

| Claim | Verdict |
|---|---|
| Outcomes are per campaign with follow-up flags | **Correct.** |
| Break reasons have `limit_minutes` | **Correct.** |
| Need help only on a call or in wrap-up, behind the flag, floor polled every 5 s | **Correct**, with one addition: a soft-phone call and a connected inbound call also count. |
| "`useHelpChime.ts` exists; check what it covers" | It chimes once per new request, on Live floor only. So "raises an alert" exists there. What is missing is an alert on other pages (BE-10). |
| Auto-reconnect ladder does not expose the next retry | **Correct.** Client only. |
| Customer facts are untyped, picked by `context_display.hero` | **Correct but incomplete.** `packages/domain/src/context-hero.ts` already guesses a name, an amount, an identifier and a place when no hero is set, and `match-name.ts` guesses the name for the floor and callbacks. BE-6 builds on them. |
| `GET /proxy/agency/callbacks` is supervisor-only | **Correct.** |
| "My callbacks are not available to an agent"; `my-contacts` is "not a callback list" | **Partly wrong.** `GET /proxy/agency/my-contacts` takes `bucket=callback` and returns the agent's own callbacks with `next_attempt_at`, on assigning campaigns with the flag on. It returns the phone number and hero fields, not a name. It does not cover pool campaigns. |
| `getMyStats` gives calls today and talk time | **Correct.** The window is client-supplied. |
| AI analysis is post-call only and returns no outcome code | **Correct.** |
| "No calls right now": "all four reasons exist today" | **Wrong for pool campaigns.** The `queue` frame and its four reasons are sent only on `strict` and `preferred`. On pool the station gets only `campaign_state` (BE-5). |
| "If they had already picked and the timer ends, it saves (today's behaviour)" | **Not found on the server.** The server returns the agent only when an outcome was submitted; otherwise it holds them (`disposition_required`). If the console saves a picked tile at expiry, that is client code I did not find. To verify before the AI pick is built. |
| "Finish work: another agent will make it" | **True only** on pool campaigns or with `callback_fallback = 'pool'`. With `wait` the call waits for the same agent. |
| Agent dropped: "an alert on the floor is NEW" | **Partly exists.** The card already has a `disconnected` risk. The chime and the off-page alert are new. |

---

## F. Foundation: the wire for phases 1–2

Built on branch `station/f` (stream F, 2026-11-20). Every name below is exactly as it is in the
code; the server, console and app streams code against these and do not change them. Every new
field on an existing shape is optional (AS18); nothing was renamed or removed. Where this list and
§3 differ, this list is what was built.

### Migrations (`packages/db/migrations`)

| File | Table | What |
|---|---|---|
| `0056_campaign_station_settings.sql` | `agency_campaigns` | `daily_target_calls INTEGER NULL` (CHECK 1–2000, `ck_agency_campaign_daily_target_calls`); `agent_script JSONB NOT NULL DEFAULT '{}'` (CHECK an object, `ck_agency_campaign_agent_script`); `phone_display VARCHAR(10) NOT NULL DEFAULT 'full'` (CHECK `full` / `masked`, `ck_agency_campaign_phone_display`) |
| `0057_contact_callback_booker.sql` | `agency_contacts` | `callback_booked_by_user_id UUID NULL`, `callback_booked_at TIMESTAMPTZ NULL` (no default; `ck_agency_contact_callback_booked`: both set or both NULL) |
| `0058_contact_callback_booker_index.sql` | `agency_contacts` | `idx_agency_contacts_my_callbacks (campaign_id, callback_booked_by_user_id, next_attempt_at) WHERE state = 'pending' AND callback_booked_by_user_id IS NOT NULL`; validates 0057's CHECK. A read that wants the index repeats that predicate byte for byte |
| `0059_session_help_state.sql` | `agency_agent_sessions` | `help_state VARCHAR(20) NULL` (`ck_agency_agent_sessions_help_state`, NOT VALID: one of the six agent states, and only while `help_raised_at` is set, so **clear it in every statement that clears `help_raised_at`**) |
| `0060_session_event_break_overrun.sql` | `agency_agent_session_events` | `break_limit_minutes SMALLINT NULL`, `break_overrun_seconds INTEGER NULL` on the transition out of `break` that ended a break past its limit (`ck_agency_session_event_break_overrun`, NOT VALID: set together, `from_state = 'break'`, limit 1–240, overrun > 0) |

No column was added to the server's row models (`apps/server/src/db/models/agency.model.ts`): the
stream that first reads or writes a column adds it there. `context_display.roles` / `.types` and the
`icon` fields live in existing JSONB columns.

### Dialer contract (`packages/contracts/src/agency/`, also re-exported in `AgencyApi`)

- `tile-icons.ts` (BE-13): `AGENCY_TILE_ICONS` (24 keys: `rupee`, `clock`, `calendar`, `stop`,
  `thumbs_up`, `thumbs_down`, `check`, `cross`, `phone_missed`, `phone_busy`, `voicemail`,
  `wrong_number`, `language`, `question`, `tea`, `lunch`, `washroom`, `meeting`, `training`,
  `prayer`, `headset`, `walk`, `person`, `dot`), `AgencyTileIcon`, `isAgencyTileIcon(value)` (the
  write's rule), `agencyTileIconOrNone(value)` (the read's: unknown is `undefined`).
  `AgencyDisposition.icon?: AgencyTileIcon`, `AgencyBreakReason.icon?: AgencyTileIcon`.
- `customer-facts.ts` (BE-6): `AgencyContextRole` / `AGENCY_CONTEXT_ROLES` (`name`, `place`,
  `amount_due`, `due_date`), `AgencyContextFieldType` / `AGENCY_CONTEXT_FIELD_TYPES` (`text`,
  `money`, `date`), `AgencyContextRoles { name?, place?, amount_due?, due_date? }`,
  `AgencyFactTileRole` / `AGENCY_FACT_TILE_ROLES` (`amount_due`, `due_date`),
  `AgencyFactTile { column, role?, type, raw, value: string | null }`,
  `AgencyCustomerFacts { name?, place?, tiles }`.
- `session.ts`: `AgencyContextDisplay.roles?: AgencyContextRoles`,
  `AgencyContextDisplay.types?: Record<string, AgencyContextFieldType>` (BE-6);
  `AgencyPhoneDisplay` / `AGENCY_PHONE_DISPLAYS` (`full`, `masked`), `AGENCY_PHONE_DISPLAY_DEFAULT`
  (`full`) (AS9); `AgencySessionBootstrap.script?: AgencyAgentScript` (absent when the campaign has
  none) and `AgencySessionBootstrap.phone_display?: AgencyPhoneDisplay` (BE-8, AS9).
- `agent-script.ts` (BE-8): `AgencyAgentScript { opening?, steps?: AgencyAgentScriptStep[] }`,
  `AgencyAgentScriptStep { text }`, `AgencyScriptPlaceholder` / `AGENCY_SCRIPT_PLACEHOLDERS`
  (`name`, `place`, `amount_due`, `due_date`, `agent_name`, `campaign_name`),
  `AGENCY_SCRIPT_STEPS_MAX` (12), `AGENCY_SCRIPT_STEP_MAX_CHARS` (200),
  `AGENCY_SCRIPT_OPENING_MAX_CHARS` (300).
- `station.ts` (BE-4, BE-6): `AgencyReservedAttempt.callback?: AgencyAttemptCallback`,
  `AgencyAttemptCallback { due_at, booked_by_me, source }`, `AgencyAttemptCallbackSource` /
  `AGENCY_ATTEMPT_CALLBACK_SOURCES` (`outcome`, `promise`, `inbound`);
  `AgencyReservedAttempt.facts?: AgencyCustomerFacts`. `AgencyActiveAttempt` inherits both. BE-5:
  the `queue` frame, the bootstrap's `queue` and `ready.queue` are now documented for `pool`
  campaigns too (no type change, no capability).
- `floor-assist.ts` (BE-9): `AgencySessionHelp.state_at_raise?: AgencyAgentState`. The error code
  `help_not_on_call` stays in the union.

### Console wire types (`packages/contracts/src/api/agency/`)

- `agency-campaign.ts`: `AgencyCampaign.daily_target_calls?: number | null`,
  `AgencyCampaign.agent_script?: AgencyAgentScript`, `AgencyCampaign.phone_display?: AgencyPhoneDisplay`;
  `AGENCY_DAILY_TARGET_CALLS_MIN` (1), `AGENCY_DAILY_TARGET_CALLS_MAX` (2000).
- `my-day.ts` (new; BE-1 to BE-3): `AgencyMyDayQuery { campaign_id }`, `AgencyMyDay { campaign_id,
  timezone, day_start, day_end, calls, dialed, talk_seconds, will_pay: number | null, successes,
  target: AgencyMyDayTarget | null, call_later: AgencyMyCallLater, as_of }`,
  `AgencyMyDayTarget { metric: 'calls', value }`, `AgencyMyDayTargetMetric` /
  `AGENCY_MY_DAY_TARGET_METRICS`, `AgencyMyCallLater { rows, today, overdue, comes_to_me,
  left_today_goes_to }`, `AgencyMyCallLaterRow { contact_id, customer_name, due_at, overdue }`,
  `AgencyMyCallLaterLeftGoesTo` / `AGENCY_MY_CALL_LATER_LEFT_GOES_TO` (`pool`, `waits_for_me`),
  `AGENCY_MY_CALL_LATER_ROWS_MAX` (20), `AGENCY_MY_DAY_QUERY_ERROR_CODE`
  (`invalid_my_day_query`). Note the field is `dialed` (wire spelling, as `dialed_at`), not
  `dialled`.
- `floor.ts` (AS16, BE-11): `AgencyFloorAgent.disconnected_since?: string | null`;
  `AgencyFloorAlertKind` / `AGENCY_FLOOR_ALERT_KINDS` (`help`, `break_over`, `disconnected`),
  `AGENCY_FLOOR_DISCONNECTED_ALERT_AFTER_MS` (20 000), `AgencyFloorAlertBase { id, kind, session_id,
  agent_user_id, agent_name, campaign_id, campaign_name, since }`, `AgencyFloorHelpAlert { kind:
  'help', help: AgencySessionHelp }`, `AgencyFloorBreakOverAlert { kind: 'break_over', break_reason,
  break_label, limit_minutes, break_started_at }`, `AgencyFloorDisconnectedAlert { kind:
  'disconnected', state, client_kind, call_id }`, `AgencyFloorAlert` (their union),
  `AgencyFloorAlertsResponse { alerts, as_of }`. The `id` recipe (`<kind>:<session id>:<instant the
  condition began>`) is in the type's comment: the console chimes once per id.
- `../reports/agent.ts` (BE-12): `AgentReviewPresence.break_overruns?: AgentReviewBreakOverruns`,
  `AgentReviewBreakOverruns { breaks, seconds_over }`.

### Routes the servers must add (not served yet)

| Method and path | Permission | Response | Stream |
|---|---|---|---|
| `GET /proxy/agency/my-day?campaign_id=<uuid>` | `agency.station.connect` | `AgencyMyDay` | S1 |
| `GET /proxy/agency/floor/alerts` | `agency.supervise` | `AgencyFloorAlertsResponse` | S2 |

The contracts keep no route table. The server's route-table tests list what is registered
(`apps/server/test/unit/api/agency-route-table.test.ts` reads `test/fixtures/console-paths.json`;
`agency-agent-reach.test.ts` holds the agent's reachable set): the stream that serves a route adds
it there in the same commit (my-day joins the agent's reachable set; the alerts read does not).
Neither test fails before then, because nothing registers the paths yet.

### Vocabularies for the app (`fixtures/agent/literals.json`)

`tile_icons`, `phone_displays`, `attempt_callback_sources`, `context_roles`,
`context_field_types`, `fact_tile_roles`, `script_placeholders`, `my_day_target_metrics`,
`my_call_later_left_goes_to` (84 vocabularies in all). New samples: `session.json`
`bootstrap_agent_station`; `station.json` `reserved_call_later`, `ready_help_open_ready`;
`floor-assist.json` `help_response_raised_on_break`; `reads.json` `my_day`, `my_day_pool_no_target`.

### Dart (`apps/mobile/packages/agency_wire`)

`lib/src/agent_station.dart`: `TileIcon` (`TileIcon.tryFromWire`: unknown is null),
`PhoneDisplay`, `AttemptCallbackSource`, `AttemptCallback`, `ContextRole`, `ContextFieldType`,
`FactTileRole`, `ContextRoles`, `contextFieldTypesFromJson`, `FactTile`, `CustomerFacts`
(`amountDue`, `dueDate`, `tileFor`), `ScriptPlaceholder`, `fillScriptPlaceholders`,
`AgentScriptStep`, `AgentScript`, `MyDayTargetMetric`, `CallLaterLeftGoesTo`, `MyDayQuery`,
`MyDayTarget`, `MyCallLaterRow`, `MyCallLater`, `MyDay`. Wired into `Disposition.icon`,
`BreakReason.icon`, `ContextDisplay.roles` / `.types`, `SessionBootstrap.script` /
`.phoneDisplay` / `.phoneDisplayRaw` / `.masksPhone`, `ReservedAttempt.callback` / `.facts` (and
`ActiveAttempt`), `SessionHelp.stateAtRaise` / `.stateAtRaiseRaw`. Every new field is read
leniently: a value the build cannot read is absent, never a failed bootstrap or frame.
`SessionHelp`'s constructor is no longer `const`.


## S3. Customer facts, script and the starter set: as built

Built on branch `station/sc` (stream S3, 2026-11-20). Where this list and §3 differ, this list is
what was built.

- **BE-6 parse rule** (`packages/domain/src/context-facts.ts`): `parseMoneyFact` (rupee sign or
  word, `/-`, `only`, spaces; Indian or western grouping; at most two decimals; a minus sign,
  brackets, a decimal comma or words are `null`), `parseDateFact` (year first, day first, a month
  name either side; a time of day after the date is ignored, a time with a zone is `null`; never
  month first with numbers), `parseContextFact`.
- **BE-6 facts** (`apps/server/src/agency/customer-facts.ts`, `customerFacts`, called in
  `buildPanel`, so the `reserved` frame and every resume of it carry `attempt.facts`): `name` and
  `place` by their roles, else a guess from name columns (the inbound match's list) and place
  columns (`city`, `town`, `place`, `location`, `district`, `village`) only, matched ignoring case,
  spaces and underscores, at most 100 characters. `tiles`: the hero columns (the contact panel's
  reading: no "first columns" fallback), minus the name and place columns, then the `amount_due`
  and `due_date` role columns when the heroes leave them out; at most four, the role tiles kept
  when the cap bites. Hidden columns are never a role, a guess or a tile. `context` is still sent
  raw.
- **BE-6 write**: `contextDisplayIssues` (both campaign-config validators) refuses an unknown role,
  a column name that is blank or over 200 characters, a hidden column as a role, one column in two
  roles, and a type other than `text` / `money` / `date`. The internal PATCH then checks every role
  and type against the campaign's imported columns (`agency_ingest_jobs.context_columns` of its real
  imports, never a check; a retry campaign's lineage root's too), ignoring case, and the 400 lists
  them. A campaign with no import yet is not checked against a roster. A create is shape-checked
  only. The `matchName` callers (callbacks list, floor, inbound) do not read the `name` role yet.
- **BE-8** (`apps/server/src/agency/agent-script.ts`): `agent_script` is patchable (JSONB) and
  audited by name only (`agency_campaign.config_changed`). Refused: not an object, a key other than
  `opening` / `steps`, a step other than `{ text }`, an opening over 300 or a step over 200 code
  points after trimming (or empty), more than 12 steps, and any `{word}` (letters, digits and
  underscores in braces, spaces allowed inside) that is not exactly one of the six placeholders, so
  `{Name}` and `{ name }` are refused; braces round anything else are plain text. Stored trimmed.
  `{}` clears it. The bootstrap's `script` is absent when there is no opening and no step; a
  malformed stored part is left out, never a failed join. A create does not store `agent_script`
  (`CAMPAIGN_INSERT_COLUMNS_SQL` is shared with the retry create): New campaign sets it with a
  PATCH after the create. *(Superseded by S1: a create now stores it, trimmed, see below.)*
- **AS4** (`packages/contracts/src/agency/campaign-defaults.ts`, re-exported on the console wire):
  `AGENCY_COLLECTIONS_STARTER_CATALOG`: `will_pay` "Will pay" (`requires_promise`, `is_success`,
  `rupee`; no follow-up call, PT2's default), `callback` "Call later" (`requires_datetime`,
  `clock`), `no_one_spoke` "No one spoke" (the voicemail retry rule, `phone_missed`), `refused`
  "Refused" (`requires_note`, `thumbs_down`), `wrong_number` "Wrong number" (`terminal`,
  `wrong_number`), `do_not_call` "Don't call again" (`suppress`, `stop`). New campaign sends it as
  the create's `disposition_catalog`.

## S1. Station data: as built

Built on branch `station/sa` (stream S1, 2026-11-20). Where this list and §3 differ, this list is
what was built.

- **BE-1 / BE-2 / BE-3 read**: `GET /proxy/agency/my-day?campaign_id=` (`api/routes/proxy-agency-my-day.routes.ts`,
  rules `agency/my-day.ts`, SQL `db/repositories/agency/my-day.repository.ts`), `agency.station.connect`,
  the caller as the subject, `400 account_scope_required`, the dialer flag (`403 feature_disabled`),
  `400 invalid_my_day_query` (only `campaign_id`, a UUID; any other key is refused, never ignored),
  then `403 not_staffed` unless the campaign is in the caller's account and the caller is staffed
  on it or holds a live session on it (not the contact-assignment flag). `no-store`. No metric of
  its own. The day: the campaign's `default_timezone`, local midnight to the next, server clock
  (`localDayStart` added to `calling-hours.ts`); an unreadable zone is served as `UTC`.
  - `dialed`, `calls`, `successes`, `talk_seconds`: the agent record's own frozen
    `AGENCY_ATTEMPT_METRICS_SQL` (`my-stats`' numbers), over the attempts of the agent's sessions on
    the campaign (sessions open during the day first), `dialed_at` in the day. `calls` is
    `CONVERSATION_ATTEMPT_SQL` (a redialled conversation once); talk time is every bridged leg.
  - `will_pay`: attempts of those sessions with `promise_date` whose `dispositioned_at` is in the
    day (a corrected promise re-stamps the same row, so it counts once). Null when the campaign's
    catalog (the default one when empty) has no `requires_promise` entry. Soft-phone and inbound
    promises are not counted, as the contract says.
  - `target`: `daily_target_calls`, null without one.
  - `call_later`: the booked half (`callback_booked_by_user_id` = the caller, on
    `idx_agency_contacts_my_callbacks`, its predicate repeated byte for byte as
    `MY_CALLBACKS_INDEX_PREDICATE_SQL`) union, on `strict` / `preferred`, the assigned half
    (`assigned_user_id` = the caller, on `idx_agency_contacts_assignee`); each pending, not DNC, a
    call-later by `isCallbackSql`, due before the day's end; oldest first, at most 20 rows; `today`
    and `overdue` uncapped. `customer_name`: the campaign's `name` role column, else `matchName`.
    `comes_to_me`: `strict` / `preferred`. `left_today_goes_to`: `waits_for_me` only on
    `strict` / `preferred` with `callback_fallback = 'wait'`, else `pool`.
- **BE-2 write**: `daily_target_calls` on PATCH (patchable at any status, `null` clears) and on
  create; `validateDailyTargetCalls` in both campaign-config validators (a whole number 1 to 2000 or
  null). Audited like every setting (`agency_campaign.config_changed` with `{ from, to }`). A create
  also stores `phone_display` (S2's `phoneDisplayIssues`, `full` / `masked`) and `agent_script` (S3's `agentScriptIssues`,
  stored through `normalizeAgentScript`), outside `CAMPAIGN_INSERT_COLUMNS_SQL` so the retry create's
  positions do not move. A retry copies all three from the parent (not `config_overrides` keys).
- **BE-3 booker**: `callbackBookerOf` (`agency/call-later.ts`) in the disposition route: the agent's
  own call-later (`requires_datetime`) or promise follow-up (PT2) stamps the reserved agent and
  now; a supervisor's on-behalf save stamps nothing, and on a replay keeps the agent's booker only
  while the due time does not move (cleared when the supervisor moves it); anything else clears.
  Written by `releaseFromDisposition`'s guarded UPDATE (`$13`, `$14`), never on a contact left
  anything but `pending` nor a DNC-suppressed one. Cleared, as `callback_source` is, by
  `chargeAttempt` (the next placed dialler call), `settleFromManual` (a placed soft-phone call that
  held the contact) and `settleFromInbound` (the customer reached inbound). An `unclaim` and an
  our-fault redial keep it. `bookInboundCallback` leaves it.
- **BE-4**: `attemptCallbackOf`, called in `buildPanel`: `inbound` (never `booked_by_me`) when
  `callback_source` is set; else `outcome` / `promise` when the last outcome connected and its code
  is a callback code of the campaign's catalog; `due_at` is the claimed contact's
  `next_attempt_at` (the claims do not rewrite it); none on a wrap-up redial. `booked_by_me` compares
  the booker with `DialCommand.agentUserId` (new, optional; set by pacing from its reservation and by
  the agent's own dial). **No capability gate**: it is an optional key on existing frames (the
  `reserved` frame and `ready.active_attempt`), the console ignores unknown keys and the Dart
  decoder reads named keys only (`ReservedAttempt.callback` is read leniently, F).
- **BE-5**: `readPoolQueueState` (`pacing/agent-queue.ts`) over `probeCampaignQueue` (the campaign's
  earliest open contact, and whether any open one is not a call-later; owners ignored), through
  `queueStateFrom`, so the four reasons mean what they do on `strict` / `preferred`. The pacing
  engine sends it to every available agent of a pool campaign on a change
  (`sendPoolQueueFrames`), read once per campaign through a TTL cache (`PACING_CACHE_TTL_MS`,
  invalidated by `campaign_changed` and `contacts_changed`; a forced tick reads through); a failed
  probe sends nothing and never changes the tick. Who is dialled is unchanged. `readAgentQueueState`
  answers it for `pool`, so the bootstrap, `ready` (the campaign read now happens for every campaign
  session) and the My contacts summary carry it; `station_ready` is published for pool sessions too.
  No capability: every build already decodes `queue`.



## C2. Console supervisor side: as built

Built on branch `station/cs` (stream C2, 2026-11-20). Console and super-admin only; no server,
contract or migration change beyond the route table's reason text.

- **AS16 alerts** (`apps/console/src/components/layout/SupervisorAlerts.tsx`, in `ConsoleLayout`
  between the top bar and the page): `getAgencyFloorAlerts` (`api/agencyFloor.ts`) polled by
  `useFloorAlerts` every 5 s while the tab is visible, one read in flight, only for a reader
  `HOME_GATE` passes (`agency.supervise`, the `agency` capability, the dialer flag); a 403 stops it
  quietly, and failing reads drop the banner after two periods. The words are
  `utils/agency/floorAlerts.ts` ("<name> needs help", "<name>’s break is over by 6 min", "<name> is
  disconnected"), counted to the read's `as_of`; each row links to Live floor; three are listed and
  the rest counted. The chime is `useHelpChime` keyed on the alert ids, muted from the banner (the
  same per-browser setting as Live floor's: every mounted chime follows a toggle). On Live floor the
  banner is not shown and Need help is not chimed by the shell (the page's own chime plays for it);
  the other kinds still chime there.
- **Campaign Settings** (`AgencyCampaignSettingsPage.tsx`): two sections after Agents, `#agent-screen`
  "What agents see" (daily target, number display with its `98••• ••321` preview, customer facts) and
  `#script` "Script". Rules in `utils/agency/stationSettings.ts`; each setting is sent only when it
  changed (`daily_target_calls: null` clears; `context_display` is sent whole, the stored hero, order
  and hidden kept); live findings hold Save; refusals land on `daily_target_calls`, `phone_display`,
  `agent_script.opening`, `agent_script.steps[<i>].text`, `context_display.roles.<role>`,
  `context_display.types.<column>`. The facts' columns come from the campaign's newest three
  completed imports (`useCampaignColumns`: the uploads read, then each job's `context_columns`).
- **Tile pictures** (BE-13): `packages/web-ui/src/components/TileIcon.tsx` is the one map from
  `AGENCY_TILE_ICONS` to lucide icons and names (`TILE_ICONS`, `TILE_ICON_LABELS`, `<TileIcon>`);
  the console's `TileIconPicker` offers it on outcomes (`DispositionCatalogEditor icons`) and break
  reasons (`BreakLimitsEditor icons`). The console station (C1) should draw from the same map.
- **AS4**: New campaign's behaviour step offers "Start with the Collections set"
  (`utils/agency/collectionsStarter.ts`); the config save sends it as `disposition_catalog`.
- **AS14 super-admin**: `apps/super-admin/src/theme.ts`, light unless the operator chose dark
  (stored under its own key, only when chosen), a Dark theme switch in the sidebar.

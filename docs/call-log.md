# One call log per campaign

A campaign's calls used to be listed in several places, by what placed them: the Call log's
Dialler calls, its Soft-phone calls view, the account's Soft-phone calls, Missed calls, and
answered inbound calls nowhere at all. This work makes them one list. Manas approved the
proposal on 2026-11-22 ("go ahead and build this end-to-end"); it is built in six phases, each
shippable alone. **P1, P2, P3, P4 and P5 are built (2026-11-22). P6 is not.**

The decisions are CL1–CL38 in [`decisions.md`](decisions.md) ("One call log per campaign (CL)"),
all **default, pending Manas**: he accepted CL1–CL12 with the proposal as a whole, not one by one,
CL13–CL16 are P2's build rulings, CL17–CL24 are P3's, CL25–CL30 are P4's and CL31–CL38 are P5's.

## 1. The model

A call is a call. Its **type** is a column, its **campaign** is a column, and every list of
calls is the same combined read with different filters fixed.

| Type (UI) | Wire value | What it is | Table |
|---|---|---|---|
| Dialler | `dialler` | A paced dial of the campaign. Always has a campaign | `agency_call_attempts` |
| Soft phone | `soft_phone` | A call an agent placed by hand and logged to a campaign | `agency_manual_calls` |
| Inbound | `inbound` | A customer rang us, and the call is filed under a campaign (§4) | `agency_inbound_calls` |

The words are the ones Live calls uses (`AGENCY_CALL_ORIGIN_LABELS`); the wire values are the
ones the export's `source` column already uses (SR6).

Calls keep their own three tables. `agency_calls.campaign_id` stays NULL on soft-phone and
inbound legs: the dialler's pacing and abandonment reads count legs by that column, so a manual
or inbound leg must never carry it (SR1).

Missed calls is not a separate kind of call. It is the **To follow up** view of the same list: a
campaign's missed inbound calls that are still open (§4).

| Someone asks | They go to |
|---|---|
| What happened on my campaign today? | Campaign › Call log. Today is the opening range |
| Who is still owed a call back? | The same page, To follow up. Across campaigns: Inbound › Missed calls |
| Is anything not filed under a campaign? | Campaigns › All calls › Campaign: No campaign (§7) |
| Who did I talk to? Who do I owe a call? | My calls, To follow up first (§7) |
| Are we keeping every call on a campaign? | Settings › Calls (§5) |

## 2. Phases

| Phase | What | Status |
|---|---|---|
| P1 | One campaign Call log for dialler and soft-phone calls. No migration | **Built 2026-11-22** (§3) |
| P2 | Inbound in the log: a campaign on inbound calls, the third type, To follow up, the missed call and its call back linked, the inbound call page, the export's inbound rows | **Built 2026-11-22** (§4) |
| P3 | The setting "Every call must belong to a campaign": per account, a default campaign per inbound route, enforcement on the soft phone and inbound wrap-up, Settings › Calls, the app | **Built 2026-11-22** (§5) |
| P4 | Reports and Insights by type: inbound figures, the Calls by type table, outcomes by type, "Outbound connect rate" | **Built 2026-11-22** (§6) |
| P5 | The agent's My calls as one list (console and app), and the account's All calls in place of Soft-phone calls | **Built 2026-11-22** (§7) |
| P6 | Inbound calls in customer history | Not built |

Not in any phase (needs Manas): filing old calls with no campaign under one by hand, and a
"Customers reached" figure.

## 3. P1: the campaign Call log (built)

The Call log tab (`/agency/campaigns/:id/attempts`, `agency.supervise`) is one list of the
campaign's dialler attempts and the soft-phone calls logged to it, newest first.

### The read

`listCallLogForCampaign` (`apps/server/src/db/repositories/agency/attempt.repository.ts`) is the
read the campaign call export has drained since SR6: both tables on ONE keyset
(`created_at DESC, id DESC`), each branch its own index range with its own `LIMIT n + 1`, so a
page boundary neither drops nor repeats a row of either type. The attempt list's filters mean
the same on a soft-phone call (`softphoneLogFilterConditions`). P1 adds no SQL shape to it, only
three columns a soft-phone row carries for the list (overrides, settled) and a count:

- `countCallLogForCampaign` counts each type for the chosen filters (the soft-phone status
  among them) in one statement, with the list's own WHERE terms and no keyset, limit or type. **Dialler** counts every attempt the list
  shows. **Soft phone** counts the calls whose dial was sent (`dialed_at` set, SR2's definition
  of a soft-phone call); a row that failed before it dialled is listed, greyed, and counted
  nowhere. **All** is their sum.

### The routes

| Route | Floor | What |
|---|---|---|
| `GET /proxy/agency/campaigns/:id/call-log` | `agency.supervise` | The Call log's JSON: the attempt list's filters and paging (`cursor`, `limit`), `type=all\|dialler\|soft_phone`, `status`, `include_counts=1` |
| `GET /proxy/agency/campaigns/:id/attempts.csv` | `agency.supervise` | The export. Same read, same columns, `source=dialler\|soft_phone`; it takes `status` too, so the file can be the list on screen. Without `status` it is as it was |
| internal `GET /agency-campaigns/:id/call-log` | (behind `callCore`) | What both read. Takes `source` and `status`; `include_counts=1` adds `counts` |

**The soft-phone status filter.** `status=live|awaiting_outcome|settled` is the Status filter
the campaign's old Soft-phone calls view had ("On a call now", "Waiting for an outcome",
"Done"), with the account list's own SQL (`softphoneStatusSql`): not ended; ended and not
settled; settled. A dialler attempt has no such status. The rule is the simplest honest one:
**with a status chosen, only soft-phone calls match.** The dialler branch is left out of the
read, the Dialler count is 0, and the Dialler chip lists nothing. The counts follow it like
every other filter.

The public JSON route (`apps/server/src/api/routes/proxy-agency-campaigns/spine.ts`) validates
`type`, forwards it as the internal `source`, names the agents, and serves the contract's rows
(`toCallLogWireRow`, `apps/server/src/agency/campaign-call-log.ts`). An unknown query key is a
400, as on the attempt list. It is not behind the soft phone's flag: a campaign keeps the
soft-phone calls it holds when the flag goes off (SR5), as the export does.

The floor is the attempt list's and the old Soft-phone calls view's: `agency.supervise`. Nothing
was widened. An agent is refused; another tenant's campaign is a 404.

### The contract

`packages/contracts/src/api/agency/call-log.ts`:

- `AgencyCallLogRow` is a union on `type`. `AgencyCallLogDiallerRow` is the attempt list's row
  (`AgencyAttempt`) marked `dialler`. `AgencyCallLogSoftphoneRow` uses the dialler row's names
  for the fields the two share (`id`, `created_at`, `phone_e164`, `contact_id`,
  `agent_user_id`, `agent_name`, `outcome`, `disposition_code`, `talk_seconds`,
  `webrtc_call_id`), so a list column reads either, and carries the soft phone's own
  (`dnc_overridden`, `hours_overridden`, `requires_disposition`, `settled_at`).
- `AgencyCallLogCounts` is `{ all, dialler, soft_phone }`. The `type` filter is not applied to
  it: each chip says what choosing it would list.
- `AgencyCallLogStatus` (`live`, `awaiting_outcome`, `settled`) is the soft-phone status filter.
- `AgencyCallLogPage` is a keyset page with `counts` only when asked for.

P2 added the third member of the union, `inbound` in `AGENCY_CALL_LOG_TYPES`, its count, and To
follow up as one more count and one more `type` value (§4); nothing was reshaped.

The mobile app does not read this route, so its Dart wire types are unchanged
(`tooling/contracts-literals.mjs --check` is clean).

### The page

`apps/console/src/pages/agency/AgencyCampaignAttemptsPage.tsx`, with its rules in
`apps/console/src/utils/agency/callLog.ts`.

- **Chips:** "All · Dialler · Soft phone", each with its count for the chosen filters. A type
  that is switched off and has no call under those filters gets no chip (SR5's rule): the Soft
  phone chip is hidden with `agency_softphone_enabled` off and no soft-phone call in the range.
  The chip that is on is always shown. With one type left there is nothing to choose, so no
  chips. The chip is in the URL (`?type=soft_phone`).
- **Columns:** When · Type · Customer · Agent · What happened · Outcome · Talk time · Call. Type
  replaced the Try column; each type's own facts are on the second line. Dialler: "Try 2", and
  "redial" for a wrap-up redial; an automatic outcome is tagged "(automatic)" in Outcome, as it
  was. Soft phone: the "DNC override" and "Hours override" badges, "not on the list" under a
  number that matched no roster contact, "No outcome yet" for a call that owes one, "On a call
  now" for one still on.
- **A row opens the detail page of its type:** the attempt detail
  (`/agency/campaigns/:id/attempts/:attemptId`) or the soft-phone call detail
  (`/agency/softphone/calls/:callId`). The soft-phone detail is behind the soft phone's flag, so
  with the flag off a soft-phone row has no link.
- **A soft-phone row that never dialled** (`dialed_at` NULL and ended, SR2) is greyed and says
  "Not dialled". It is in no chip's count.
- **What it opens on** (`callLogOpening`). With no filter in the URL:
  - a campaign that is dialling or could again (draft, running, paused, stopping) opens on
    **today**, the reader's calendar day, and the date fields show it;
  - a **finished** campaign (stopped or completed) or an **archived** one opens on **every
    date**. Its calls are all in the past, and "what did this campaign do" is the question the
    page is opened with.

  The list waits for the campaign before reading its opening view, so it is never read twice
  for a guess; if the campaign cannot be read it opens on today. Any filter in the URL (an
  Insights number, one contact, a status) means exactly what it says and is never narrowed to
  today. Emptying the dates writes `?dates=all`, so the list does not spring back; Clear returns
  to the opening view. Refresh takes the day again, so a list left open past midnight moves on.
- **Empty states:** "No calls on this campaign for these dates." with **Show last 7 days** and
  **Show all dates** when only the dates narrow the list (the words name the chip's type when
  one is on); "Nothing matches those filters" with **Clear** otherwise; "No calls were placed"
  only with every date and no filter.
- **Filters:** every filter the attempt list had (what happened, phone, agent, dates, and the
  ones only a link sets: state, outcome code, caller ID, the dialled window, the redial and
  override flags, one contact), and the old Soft-phone calls view's Status as **Soft-phone
  status**, with "Soft-phone calls only. A dialler call has no status." under it. It is offered
  while the soft phone is on, while the filters match soft-phone calls, or while one is applied.
- **Export CSV** downloads what the list shows: its filters, **its dates** (a tip says so: the
  file of a live campaign's opening view is today's calls), its status, and with a chip on that
  type (`source`).
- **Drill-downs land on the Dialler chip.** Every Insights figure that opens this page counts the
  dialler's dials alone (SR1), so `attemptsLink` (`utils/agency/insights/links.ts`) sets
  `type=dialler`. Without it the list would also hold the soft-phone calls that match the same
  filters, and its count would not be the number clicked. Compare agents' next steps ("Listen to
  Priya's calls ending in will pay") are not counts, and its metrics take soft-phone calls too
  (CP2), so they pass `type: 'all'` and open on every call type. A contact's "all calls" link sets
  no type: that list is every call to the contact.
- **The counts are asked for when they could have changed** (a filter, a status, Refresh), not
  when only the chip did: they are of every type whatever chip is on.
- `/agency/campaigns/:id/manual-calls` redirects (replace) to `/attempts?type=soft_phone`. The
  segmented "Dialler calls | Soft-phone calls" control and `CALL_LOG_VIEWS` are gone. Search
  still finds a campaign's "Soft-phone calls" (the `manual` row of `CAMPAIGN_TABS`, now that
  chip's URL), and `agency_campaign_tab_viewed` keeps its name.

### What P1 left as it was

- The account's **Soft-phone calls** list (`/agency/softphone`) and the agent's My calls were
  left for P5, which replaced both (§7). The campaign's old Soft-phone calls view had two things
  the Call log does not: the stats strip over the rows on screen, and the Summary column. All
  calls has neither either; Insights carries the campaign's soft-phone figures.
- The mockup's "placed by … (supervisor)" line is not shown: a soft-phone call is placed by its
  own agent, and nothing records a second person placing it. An outcome saved by someone else
  shows "on behalf", as on a dialler row.
- The mockup's subtitle says "dialled, made from the soft phone and received"; P1 said "dialled
  by the dialler and made from the soft phone" until P2 put inbound calls in the list.

### Tests

- `apps/server/test/integration/api/agency-softphone-campaign-results.test.ts` (real Postgres):
  both types once each across page boundaries in the export's order, a page boundary between an
  attempt and a soft-phone call created at the same instant, each type's fields, the overrides
  and the outcome still owed, `type`, the status filter on rows, counts and the export, the
  counts by the filters and never by the chip or the page, the floor and the tenant boundary.
- `apps/server/test/integration/api/agency-insights-drilldowns.test.ts`: every Insights dials
  figure equals the count the Call log shows for its link (`test/fixtures/insights-drilldowns.json`,
  which the console holds `attemptsLink` to), with soft-phone calls seeded inside the range so a
  link without `type=dialler` goes red.
- `apps/server/test/unit/agency/proxy-agency-call-log.routes.test.ts`: `type` to `source`, the
  row projection, the refusals, the counts passed through.
- `packages/contracts/test/call-log.test.ts`: the vocabulary and its words.
- `apps/console/src/__tests__/utils/callLog.test.ts` and
  `apps/console/src/__tests__/pages/AgencyCampaignAttemptsPage.test.tsx`: the chips, the opening
  day, the empty states, a row of each type, the redirect.

## 4. P2: inbound calls in the log (built)

An inbound call filed under a campaign is a row of that campaign's Call log, with the dialler's
attempts and the soft-phone calls, and the campaign's missed calls that are still open are its
**To follow up** view.

### The schema (`0067_call_log_inbound_campaign.sql`, `0068_call_log_inbound_indexes.sql`)

- **`agency_inbound_calls.campaign_id`** (nullable, no FK) is the campaign a call is **filed
  under**, and the column the Call log reads. **`campaign_source`** says how the call came by it:
  `contact` (its number is on the campaign's list), `route`, `agent`, `supervisor`
  (`AGENCY_INBOUND_CAMPAIGN_SOURCES`); a CHECK sets them together. P2 writes `contact` alone: the
  arrival files a matched call under its contact's campaign (`insertArrival`), exactly what
  `matched_campaign_id` holds. It is its own column because P3 files unknown callers too (the
  route's default, the agent's choice), and a filed campaign is not a match: the sticky agent, the
  contact's callback and the outcome catalog keep reading `matched_campaign_id`.
- **Backfill:** every existing call with a matched campaign is filed under it (`contact`),
  `updated_at` untouched; an unmatched call stays unfiled (CL10). It runs inside 0067, as 0027's
  and 0032's backfills of this table did: one row per inbound call, and only the matched rows are
  written. `db-hygiene.md` §6 asks for a batched script on a large table, so 0067 is written to
  find that work done: a deployment whose table has grown past about a million rows adds the two
  columns and files the matched calls in batches **before** the deploy, the trigger disabled in
  each batch so `updated_at` is kept (the steps are in 0067's header and `DEPLOYMENT.md` 12, and
  the migration test runs them). 0067 then adds nothing that exists (`ADD COLUMN IF NOT EXISTS`,
  the types checked) and files only what arrived since. Its CHECK is added `NOT VALID` and
  validated by 0068.
- **After a rollback:** an older image does not file the calls that arrive while it runs. The
  same batch, run after rolling forward, files them (`DEPLOYMENT.md` 12).
- **`agency_manual_calls.callback_of_inbound_call_id`** (nullable, no FK): the Missed inbound call
  a soft-phone call was placed from (CL1, below).
- **Indexes**, in their own file out of 0067's lock: `idx_agency_inbound_calls_campaign`
  `(campaign_id, arrived_at DESC, id DESC) WHERE campaign_id IS NOT NULL` (the inbound branch's
  keyset range) and `idx_agency_manual_calls_callback_of` (a page's call backs). Both are
  `CREATE INDEX IF NOT EXISTS` and refuse an invalid index left by a failed concurrent build.
  Neither can be built before the release that adds 0067 (the columns are new); on that release
  the call-backs index is empty and the inbound one holds the calls 0067 filed.

### The read

`listCallLogForCampaign` has a third branch, on the same keyset. An inbound call's place in the
list is when it **arrived** (`arrived_at`, served as the row's `created_at`), so the three types
interleave by when each call began. An inbound call is a row only once it has **ended**, so a
long call appears, when it ends, at the time it arrived: above rows already on screen or already
paged past. Refresh picks it up; nothing is dropped or repeated within one read. Each branch is still its own index range with its own
`LIMIT n + 1`; the plan of the inbound branch's own statement is pinned on 0068's index.

- **What is a row:** an **ended** call, filed under the campaign, in the tenant, that we served.
  A live call is on Live calls and has no outcome to list. A `rejected` call (we turned it away
  unserved) is never a row. A call filed under no campaign is in no campaign's log.
- **`countCallLogForCampaign`** adds `inbound` (every inbound row listed) and `to_follow_up`.
  `all` is dialler + soft phone + inbound: a call still to follow up is an inbound call, so it is
  not added a second time.
- **To follow up** (`type=to_follow_up`, internal `source=to_follow_up`) is the campaign's **open
  Missed rows**: the inbound rows with `follow_up_status = 'open'`. The rule is the Missed list's
  own, in one spelling (`inboundMissedOpenSql`, which the Missed list's badge count uses too), so
  the two cannot disagree about who is still owed a call. **It ignores the dates** (CL14): every
  other filter narrows it, `from` and `to` do not. A caller owed a call back two days ago is
  still owed one today, and the Call log opens on today. The page says so under the chips, and
  while the chip is on the date fields are switched off with the reason, the dates' chip is not
  shown, and the tip that the export follows the dates is hidden (the export of this view does
  not). The dates stay in the URL for the next chip. **Its agent filter is the assignee**: a
  missed call has no answerer, and "what does Arjun still owe" is what the view is asked, so
  under To follow up (rows and its count) the agent filter matches
  `follow_up_assignee_user_id`, the Missed list's own assignee.
- **`findInboundForCampaign`** is one row of the same SELECT under the same rule, for the Call
  page: a call the list would not show (live, rejected, another campaign's or tenant's) is a 404.

### How a filter reads on each type

The rule P1 set for the soft-phone status, now for every filter (CL13): **a filter means on
each type what that type's own column says, and a filter with no meaning on a type leaves that
type out**, rows and counts alike. It never silently lets a type through unfiltered.

| Filter | Dialler | Soft phone | Inbound |
|---|---|---|---|
| Agent | the agent of the reserved session | who placed it | who **answered** (`answered_by_user_id`). A missed call has no agent, so with an agent chosen no missed call is under Inbound or All. Under **To follow up** it is who the call is **assigned to** |
| Outcome code | the write-up | the outcome saved | the outcome the agent saved |
| What happened: an attempt outcome | its own | its own | `connected` is a call an agent answered; every other attempt outcome matches no inbound call |
| What happened: **Missed**, **Voicemail**, **Abandoned** | none | none | `missed`: any call with a Missed row. `voicemail`: the caller left one. `abandoned_in_queue`: the caller hung up while waiting |
| State | its own | its own | every row is `ended` |
| Contact | the attempt's | the matched contact | the matched contact |
| Phone | the contact's number | the number dialled | the **caller's** number (none when withheld) |
| Caller ID | the number dialled from | the number dialled from | the number they rang |
| Dates (`from`, `to`) | `created_at` | `created_at` | `arrived_at` (not To follow up) |
| Redial, agent's own dial, reopened dial, override (`=1`) | its own | none | none |
| Placed, the dialled window | its own | `dialed_at` | none: an inbound call is not a dial |
| Soft-phone status | none | its own | none |

The What happened values are one OR-ed set across two vocabularies in one `outcome=` param
(`AGENCY_CALL_LOG_INBOUND_OUTCOME_FILTERS` beside the attempt outcomes; the internal route splits
them, `splitCallLogOutcomes`). With only inbound happenings chosen, no dialler or soft-phone call
matches. The inbound "Abandoned" is worded "Abandoned (hung up while waiting)", apart from the
dialler's "Abandoned (no agent free)", which is our doing.

**Drill-downs are unchanged.** Every Insights figure still lands on the Dialler chip
(`type=dialler`, SR1), so its count is still the number clicked; Compare agents' next steps still
open every type (`type: 'all'`), which now includes the inbound calls an agent answered, as
Compare's own metrics do.

### The routes

| Route | Floor | What |
|---|---|---|
| `GET /proxy/agency/campaigns/:id/call-log` | `agency.supervise` | `type` also takes `inbound` and `to_follow_up`; `outcome` also takes `missed`, `voicemail`, `abandoned_in_queue`; `counts` gains `inbound` and `to_follow_up`. A missed row names its assignee |
| `GET /proxy/agency/campaigns/:id/attempts.csv` | `agency.supervise` | `source` gains `inbound` (and `to_follow_up`, whose rows are `inbound`); three columns at the END: `wait_seconds`, `missed_reason`, `callback_of` |
| `GET /proxy/agency/campaigns/:id/call-log/inbound/:callId` | `agency.supervise` | One inbound call for its Call page: the Call log's row, `journey`, who saved the outcome, `voicemail_url`, and the media leg (`call`, `call_availability`) |
| `GET /proxy/agency/campaigns/:id/call-log/inbound/:callId/recording` | `agency.supervise` and the account's recording setting | The recording's bytes |
| `POST /proxy/agency/softphone/calls` | as before | accepts `callback_of_inbound_call_id` |

Nothing is behind inbound's flag: a campaign keeps the inbound calls it holds when the flag goes
off, as it keeps its soft-phone calls (SR5). No floor was widened: the Call log, the Call page
and the recording are `agency.supervise`, an agent is refused all three, and the media leg is
stripped by the account's recording and analysis settings exactly as an attempt's is
(`shapeMediaCall`). Mark handled and the voicemail are the Missed list's own routes, under their
own rules.

### A missed call and its call back (CL1, CL15)

A soft-phone call placed from a Missed row's **Call back** stays a **Soft phone** call. What it
gains is the link: `callback_of_inbound_call_id`.

- The prefill carries the Missed row's id beside the number (`utils/softphone/prefill.ts`; the
  app's `SoftphoneActions.callBack`), and the dial sends it **only while the pad still holds that
  number**, once.
- The server keeps it only when it names a **Missed row of the caller's account whose caller is
  the number dialled** (`isMissedCallFrom`, digits compared). Anything else (another account's
  row, an answered call, a different number, an id that names nothing, a string that is not an id
  at all) is **dropped, and the call is placed all the same**: the link is a marker, never a
  reason to refuse an agent ringing a customer. The edge bounds the string's length and refuses
  nothing for what it holds.
- The Call log shows both ways: the soft-phone row says "Call back · to the 3:12 PM missed call"
  (`callback_of`), the missed row "Called back 3:31 PM" (`called_back`: the latest soft-phone call
  **dialled** from its Call back, whatever campaign that call was logged to). A call back that
  never dialled is not "called back". The two rows are tinted, and hovering one lights the other.
- They are two calls, counted once each. A call back does not close the Missed row: the customer
  being reached does (the existing triggers), or Mark handled.

A dialler row whose dial the customer's own call stopped (`clash_attempt_id`'s attempt:
`canceled` with the system code `inbound_call`, `docs/inbound.md` §5.4) reads **"Stopped:
customer rang us"**. No new column: the attempt already says it.

### The page

- **Chips:** "All · Dialler · Soft phone · Inbound · To follow up". Inbound is hidden with
  `agency_inbound_enabled` off and no inbound call under the filters. **To follow up** is in the
  warning colour, hidden at 0, and shown beside All even when Dialler is the only type (an old
  missed call is still owed when today holds no inbound call).
- **An inbound row:** Type "Inbound · rang us". Customer: the caller's number (a link when it is
  on the roster, "not on the list" when it is not, "Number withheld"). Agent: who answered; for a
  missed call a dash with "assigned to …" under it. What happened: **Answered** with "waited 0:18
  · came through their agent" (the sticky agent answered), or **Missed** with why in the Missed
  list's own words and the wait when the caller queued ("nobody free to answer · waited 1:40",
  "hung up while waiting · 0:52", "out of hours"). Outcome: the saved outcome; for a missed call,
  where its follow-up stands ("Called back 3:31 PM", **To follow up** with **Call back** and
  **Mark handled**, "Handled", "Customer reached"). Call: "Open call", or "Voicemail 0:22".
- **Mark handled** is the Missed list's action (`POST /inbound/missed/:id/handled`), offered with
  `agency.inbound.read`; the list and the counts are read again. **Call back** opens the soft
  phone with the number, this campaign as "Log to" and the row's id; it is offered where the
  viewer may dial from the soft phone and the caller gave a number. Nothing is dialled.
- **What happened** offers Missed, Voicemail and Abandoned while inbound is on, the filters match
  inbound calls, an inbound view is on, or one is applied.

### The inbound Call page

`/agency/campaigns/:id/calls/inbound/:callId` (`AgencyInboundCallPage.tsx`), the page an inbound
row opens; inbound calls had none. Breadcrumb Campaign › Call log › Call. Who rang and why the
call is in this log ("filed under this campaign because the number is on its list"), then **the
caller's path**, a line per step from the server's `journey` (`inboundJourney`: rang, our
greeting, the wait, who answered or that nobody did, a voicemail, the end and the talk time),
the voicemail's player when one was left, and the shared call view every call page has
(`CallDetailView`: agent, what happened, outcome, notes, recording, summary, transcript). A
missed call shows its **Follow-up** card in place of an outcome. With no media leg the page says
why from `call_availability` and shows the record alone.

### What P2 left as it was

- **Customer history** does not show inbound calls yet (P6); its read keeps
  `matched_campaign_id`. The agent's My calls and the account's All calls list them since P5 (§7). Insights and the campaign report
  do since P4 (§6), counted by `campaign_id`.
- **Filing an unknown caller** under a campaign was P3's (§5): since it, a call from an unknown
  number is filed under its route's campaign for unknown callers when the route has one, and is
  then in that campaign's log and, when missed, its To follow up. A route with none still files
  such a call under no campaign.
- The mockup's "Customer history" button on the Call page is "Open contact" (the roster contact,
  when the caller matched one): customer history is a number search with its own audit (CH6).
- The mockup's "placed by … (supervisor)" stays out, as in P1.
- **Times read with AM / PM in capitals** ("3:31 PM", "22 Nov 2026, 03:42 PM"), the house style
  and the mockup's, everywhere on the Call log (the When column, the pair's times, the dialled
  window's chip) and on the inbound Call page (the headline, the path, the cards, the shared call
  card's instants, who listened): `upperDayPeriod` / `formatCallTimestamp`. The console's shared
  formatters still write "pm", so its other surfaces (the attempt and soft-phone call pages, the
  Missed list, the roster, My contacts, Listening history, the campaign header above the Call
  log) are unchanged and still read in lower case.
- **`wait_seconds` on a missed call runs to the end of the call**, so where the caller left a
  voicemail it includes the prompt and the voicemail. No column records when the wait gave way
  to the voicemail (`queued_at`, `offered_at` and `ended_at` are all there is), so it is left;
  the row shows the voicemail's own length beside it.

### Tests

- `packages/db/test/integration/db/call-log-inbound-migration.test.ts`: the columns, the CHECK
  from every side, the backfill with `updated_at` kept, the pre-deploy path for a large table
  (columns added and a batch run, then the migration), the wrong-type refusal, the CHECK's
  validation in 0068, both indexes, the invalid-index refusal, down then up.
- `apps/server/test/integration/api/agency-call-log-inbound.test.ts` (real Postgres, the real
  app): the three types on one keyset across page boundaries and a tie between an inbound call
  and a soft-phone call; what is and is not a row; an inbound row's facts; the pair; the counts;
  To follow up and the dates, and that it follows Mark handled and Reopen; every filter on an
  inbound call; the export's rows and columns; the Call page's read, its 404s and its floor; that
  the arrival files a matched call; `isMissedCallFrom`; the inbound branch planned on 0068's index.
- `apps/server/test/integration/api/softphone-routes.test.ts` ("CL1"): a call back placed over
  HTTP keeps the link, and every link that does not hold is dropped with the call still placed.
- `apps/server/test/unit/agency/proxy-agency-call-log.routes.test.ts`,
  `proxy-agency-calls.routes.test.ts`, `proxy-agency-spine.routes.test.ts`,
  `spine-read-routes.test.ts`: the wire rows, the names, the outcome split, the path, the Call
  page's floor, media strip and recording gate, the export's columns.
- `packages/contracts/test/call-log.test.ts`: the vocabulary.
- Console: `utils/callLog.test.ts`, `utils/inboundCallPage.test.ts`,
  `pages/AgencyCampaignAttemptsPage.test.tsx`, `pages/AgencyInboundCallPage.test.tsx`,
  `components/SoftphoneScreen.test.tsx` (the dial's link). App:
  `test/core/softphone/softphone_controller_test.dart`, `agency_wire`'s `softphone_test.dart`.

## 5. P3: every call must belong to a campaign (built)

An account can ask that every call it makes or takes is filed under a campaign. The setting is
off by default. Switching it on changes nothing that already happened: no old call is given a
campaign (CL10), and a call in progress finishes as it is (CL19).

### The schema (`0069_call_settings.sql`)

- **`agency_call_settings`**: one optional row per (tenant, account); no row is the setting off.
  `require_campaign` is the switch (the wire's name too), `require_campaign_since` when it was
  last switched on (a CHECK sets it exactly while the switch is on), `updated_by` who last wrote
  it.
- **`agency_inbound_routes.default_campaign_id`** (nullable, no FK): the route's **Campaign for
  unknown callers**. `idx_agency_inbound_routes_default_campaign` answers "which live routes
  file callers under this campaign".

**Where the setting lives (CL17).** In a table of its own. Not in `agency_softphone_settings`:
the rule governs inbound calls as much as the soft phone, and an account can have inbound on
with the soft phone off. Not in `account_settings`: that row is the operator's (limits and
toggles a super admin sets), is read through a 60-second cache and is written with a
concurrency version, and this is an account admin's own switch that every dial reads fresh.
The repository is `AgencyCallSettingsRepository`
(`apps/server/src/db/repositories/agency/call-settings.repository.ts`).

**Who may change it.** A new permission, `agency.calls.manage`, floored at `account_admin`, the
seat `agency.softphone.manage` and `agency.inbound.write` are. No floor was widened. The routes
are behind neither the soft phone's flag nor inbound's.

### Where a call's campaign comes from

| Call | Its campaign | `campaign_source` |
|---|---|---|
| Dialler | the campaign that dialled it. Always | (none: the attempt's own campaign) |
| Soft phone | the campaign chosen in "Log to" before Call. With the setting on, one must be chosen | (none: `agency_manual_calls.campaign_id`) |
| Inbound, the caller is on a campaign's list | that campaign. Fixed | `contact` |
| Inbound, the caller is on no list | the route's campaign for unknown callers, at arrival, **whether or not the setting is on** | `route` |
| the same call, at the end of the call | a campaign the agent chooses instead | `agent` |
| the same call, chosen by a supervisor on the agent's behalf | | `supervisor` |

A caller on no list, on a route with no campaign for unknown callers, is filed under none. With
the setting on there is no such route (below), so there is no such call.

### What the setting enforces, and where

The server enforces it on every path. The screens only keep the agent from asking.

| Path | With the setting on | Enforced in |
|---|---|---|
| A soft-phone dial, by an agent or a supervisor (CL5) | Refused `409 campaign_required` with no `campaign_id`, before the call details are judged (`fields_invalid`). Nothing is written | `SoftphoneService.placeCall` |
| The outcome of an inbound call | Refused `409 campaign_required` while the call is filed under none. The request may name the campaign (`campaign_id`), filed in the same transaction | `InboundCallService.submitDisposition` |
| An inbound route, created or changed | Refused `422 default_campaign_required` when the route as saved has no campaign for unknown callers | `api/routes/agency/inbound.ts` (`defaultCampaignRequired`) |
| Switching the setting on | Refused `422 default_campaign_required`, naming them, while a live route of the account has none (CL3, CL18) | `proxy-agency-call-settings.routes.ts` |

`campaign_required` is one of the soft phone's refusal codes (`AGENCY_SOFTPHONE_ERROR_CODES`);
the inbound outcome answers the same code, as the session routes answer inbound's
`inbound_call_live`. Its message is what an app that does not know the code shows: "Choose a
campaign before you dial. Every call in this account must belong to a campaign."

**The switch and a route's save cannot pass each other.** Both take one transaction advisory
lock on the account (`AgencyCallSettingsRepository.lockAccount`) before they check: the switch
reads the routes under it, a route write reads the setting under it.

**Which routes stand in the way (CL18).** Every live route of the account with no usable
campaign for unknown callers: none chosen, or one that was archived since (or is no longer the
account's). A stopped or completed campaign still counts as chosen. **While inbound is off for
the account (`agency_inbound_enabled`) no route is counted**: the route editor is closed then,
so a leftover route could not be fixed. The outcome-time `campaign_required` still covers a
call that arrives under no campaign, and with inbound on again the page names the route and its
next save needs a campaign.

**Calls that began before the switch (CL19).** An inbound call that arrived before
`require_campaign_since` takes its outcome with no campaign. A soft-phone call is checked once,
at the dial, so one placed with no campaign before the switch is written up as any other. The
lapse of an owed outcome is never held back.

### An unknown caller's call

- **At arrival** (`insertArrival`, from `AgencyInboundCallRouter`): `campaign_id` is the matched
  contact's campaign, else the route's `default_campaign_id`. A missed call is filed too, so the
  Missed list names its campaign, and Call back logs the soft-phone call to it when the agent
  may (`AgencyInboundMissedCall.campaign_id`, `campaign_name`).
- **Its outcomes (CL12, CL20)** are the filed campaign's, without the ones that ask for a promise
  to pay (there is no contact to keep a promise on). The route's own outcome list is used only
  for a call filed under no campaign (`resolveInboundCatalog`). The outcome is stored with
  `disposition_source = 'route'`: that column says `campaign` exactly when the caller matched a
  campaign's list (0027's CHECK, kept as it is so an older image stays valid after a rollback).
- **Everything about the customer stays with the match**: the sticky agent, the contact's
  settlement and callback, a promise, and Do Not Call (below) read `matched_campaign_id`.
- **At the end of the call (CL4, CL23)** the panel says where the call is filed and offers
  **Change**. `GET /inbound/calls/:id/campaigns` lists the campaigns the actor may log to (the
  soft phone's rule: running or paused, and one the agent is staffed on; any such campaign for a
  supervisor). `POST /inbound/calls/:id/campaign` files it and answers the call with the new
  campaign's outcomes; the same can go with the outcome (`campaign_id`). A matched caller's
  campaign is refused (`inbound_campaign_fixed`), a campaign the actor may not log to is refused
  (`inbound_campaign_not_allowed`), and a call still on the line is not at wrap-up
  (`inbound_call_not_dispositionable`).
- **A Change under a Save.** An outcome is judged against the campaign the call was under when
  it was read, and saved only while the call is still under it (`saveDisposition`'s
  `expectedCampaignId`). If a Change landed in between, nothing is written and the code is
  judged once more against the campaign the call is under now: saved, or refused
  `inbound_disposition_invalid` with that campaign's codes. A code of one campaign's catalog is
  never left on a call under another.

### Do Not Call from a call that is only filed under a campaign (CL6)

"Don't call" from a call tied to a campaign stops that campaign alone. If filing every call
under a campaign made that true of calls from unknown numbers, the setting would make Do Not
Call smaller. So: **when the campaign is only where the call was filed, the entry is written
for the whole account**, as a call with no campaign always did.

- Inbound: the mark's scope is the **match's** (`matched_campaign_id`), never `campaign_id`. A
  call filed by its route, the agent or a supervisor writes the account's entry.
- Soft phone: the campaign's scope only when the number is on that campaign's list (the call
  matched a roster contact); a call logged to a campaign whose list does not hold the number
  writes the account's entry (`manualDncScope`). This holds with the setting off too.

The answers and the audit rows say `account`.

### A catch-all campaign (CL8)

A campaign that exists to receive unknown callers ("General enquiries") is an ordinary
campaign. Two things would have stopped it working, and one rule answers both: **while a live
inbound route files its unknown callers under a campaign, that campaign may be started with
nothing to dial, and the pacing leader does not complete it when its list runs out.** It stays
running until a supervisor stops it. Without the rule, Start refused an empty roster, and a
running campaign with nothing outstanding completed itself within a tick; a completed campaign
cannot be chosen on the soft phone.

**The same holds for a real dialling campaign chosen as a route's default:** it stays running
after its last contact is dialled, until a supervisor stops it or the route names another
campaign. The route editor says so under the field. It does not cost pacing anything while it
waits: a drained campaign held open this way is quiescent (skipped between safety ticks), and
is woken by contacts arriving or reopened, a change to the campaign, or a route taking or
dropping it as its default (`PacingEngine.runTick`, `wakeDefaultCampaigns`).

**Stopping or archiving it asks first (CL21).** The Stop and Archive confirmations name the
inbound numbers that file callers under the campaign and say to choose another campaign for
them first. They do not refuse: Stop is the off switch, and a call goes on being filed under the
campaign whatever its status. A route whose campaign was archived counts as having none
(Settings › Calls lists it, and the switch is refused while it stands), and it is refused the
next time the route is saved, whatever the change, until another campaign is chosen.

### The routes

| Route | Floor | What |
|---|---|---|
| `GET /proxy/agency/call-settings` | `agency.calls.manage` | The setting, the live routes with no campaign for unknown callers, the agents on no running campaign, and the calls of the last 30 days filed under none (CL24) |
| `PUT /proxy/agency/call-settings` | `agency.calls.manage` | `{ require_campaign }`. Audited `agency_call_settings.updated` when the switch changed |
| `GET /proxy/agency/campaigns/:id/inbound-default-routes` | `agency.supervise` | The live routes that file unknown callers under the campaign, for the Stop and Archive warnings |
| `GET /proxy/agency/inbound/calls/:id/campaigns` | `agency.inbound.read` | The campaigns the caller may file the call under |
| `POST /proxy/agency/inbound/calls/:id/campaign` | `agency.inbound.read` | File an unknown caller's call under a campaign. Audited `agency_inbound_call.campaign_changed` |
| `POST /proxy/agency/inbound/calls/:id/disposition` | as before | accepts `campaign_id` |
| `POST` / `PATCH /proxy/agency/inbound/routes` | as before | accept `default_campaign_id`; the list says `campaign_required` |
| `GET /proxy/agency/softphone/bootstrap`, `GET …/softphone/settings` | as before | say `campaign_required` |

The two inbound call routes are finish routes: the agent who took the call, or a supervisor on
their behalf, and never behind inbound's flag.

### The screens

- **Settings › Calls** (`/settings/calls`, `CallsSettingsPage.tsx`; in the Settings hub under
  This account). The switch, the proposal's help text, and what it needs: the soft phone (always
  ready), the inbound numbers with no campaign for unknown callers (each a link to its route;
  while there is one the switch is off and says why; with inbound off for the account it says
  the inbound numbers are not checked), and the agents on no running campaign (members with
  the agent role, CL24; for information). Switching on asks first ("Switch on for Acme Collections? From now, no call can
  be made or saved without a campaign."); switching off does not. Under it: "In the last 30
  days, 41 calls were not filed under a campaign."
- **The soft phone (console station and `/dialer/phone`).** With the setting on the box reads
  "Save this call to (required)", "Not in any work" is not a choice, and Call stays off with
  "Choose the work to save this call to." until one is chosen. A redial of a call saved to none
  leaves the box empty and says "This call was not saved to any work. Choose one to call again.",
  and so does a Missed call's Call back whose campaign cannot be chosen. With nothing to save a
  call to, the pad gives way to "You are not in any work that is running, so you cannot dial.
  Ask your supervisor to add you to one."; a supervisor reads "No work is running in this
  account, so no call can be made."
  An agent in no running work sees, in place of the pad, "You are not in any work that is
  running, so you cannot dial. Ask your supervisor to add you to one." The station's words are
  AS15's ("work", never "campaign"): CL22.
- **The agent app.** The same, in the app's own words, which are the proposal's: "Log to
  (required)", "Choose a campaign", "Choose a campaign to log this call to.", and the two lines
  above with "campaign". An older build still offers "Not logged to a campaign" and gets the
  server's refusal, whose message it shows.
- **The end of an inbound call (console station).** For a caller on no list: "Filed under:
  General enquiries (this number is not on any list)" with **Change**; choosing another loads
  its choices and says "What you can choose changed to match Gold Loan Renewals." A call filed
  under none, where one is needed, keeps Save off with "Choose the work to file this call under,
  then save." The app shows no Change: with the setting on a call always arrives filed.
- **The route editor.** **Campaign for unknown callers**, "(required)" while the setting is on,
  with "Callers whose number is not on any list are filed under this campaign and use its
  outcomes." With one chosen, the route's own outcomes say they are not used.
- **Settings › Soft phone.** With the setting on, the settings of a call logged to no campaign
  (recording, summary profile, caller ID, outcomes) are greyed with "Not used while every call
  must belong to a campaign." The call details still apply to every call.
- **Inbound › Missed calls.** The Campaign column names the campaign the call is filed under.

### What P3 left as it was

- **"See them in All calls"** under the count on Settings › Calls waited for All calls: P5 added
  the link (§7).
- **The agent app's inbound call screen** does not offer Change. It is not needed for the
  setting to hold (a call arrives filed), and the app refuses nothing the server allows. A call
  that did arrive under no campaign while the setting is on (inbound was off when the route
  was last saved, CL18) cannot be given one from the app: its outcome is refused
  (`campaign_required`) and the call closes with none when its window ends, unless a
  supervisor files it from the console first.
- **A missed call from an unknown caller** cannot be moved to another campaign; its route files
  it.
- **Reports and Insights** had no inbound figures for a campaign; P4 added them (§6), counted
  by `campaign_id`, never by `disposition_source`. That column says `campaign` only when the
  caller matched a campaign's list; a call filed by its route, an agent or a supervisor stores
  `route` there while its outcome is from the campaign's catalog (CL20). Compare agents, My day
  and the promise summary still read `matched_campaign_id`: they are about the customer on the
  list, not about where a call is filed.
- **A call to a number on no route** has no account, so no campaign. It is an operator
  exception, as the proposal says.

### Tests

- `packages/db/test/integration/db/call-settings-migration.test.ts`: the table, one row per
  account, the CHECK both ways, the trigger, the route's column, the index and a statement that
  uses it, the lock timeout, down then up.
- `apps/server/test/integration/api/call-settings.test.ts` (real Postgres, the real app): the
  settings routes and their floor; the switch refused while a route has no default, then
  switched, audited once; the readiness lists and the count; the route's default (the account's,
  not archived) and that it is required on a create and a change while the setting is on; where
  an arriving call is filed; the inbound outcome refused with no campaign, for agent and
  supervisor, and saved once the request names one; only a campaign the actor may log to; a
  matched caller's campaign fixed; a call that arrived before the switch; Change, the new
  outcomes and the audit row; Do Not Call at the account's scope from a call filed by route,
  agent and supervisor; the Missed list's campaign. After the review: the permission each
  settings route asks for, by name; a route whose campaign was archived counted as missing and
  not saved again; routes not counted while inbound is off, and counted again once it is on;
  the account's lock held on a second connection (a route create, a route change and the
  switch-on each wait, and are refused once the other side commits); `fileUnderCampaign`
  refusing a matched and a settled call; `saveDisposition`'s `campaign_changed`; a Change
  landing under a Save (refused with the new campaign's codes, or saved under it).
- `apps/server/test/unit/agency/pacing-skip.test.ts`: a drained campaign held open as a route's
  default is skipped with no reads, and woken by contacts arriving.
- `apps/server/test/integration/api/softphone-routes.test.ts` ("every call must belong to a
  campaign"): through HTTP with a real station, an untagged dial refused for an agent and a
  supervisor, before the fields; the bootstrap's flag; a call owing its outcome when the setting
  comes on finishes; a filed-only campaign's Do Not Call is the account's and a roster number's
  is the campaign's; off again, an untagged dial is placed.
- `apps/server/test/integration/agency/inbound-call-router.test.ts`: the router files an unknown
  caller under the route's campaign, a missed call included, and a matched caller under their own.
- Server units: `call-settings.test.ts` (who is an agent on no campaign; `manualDncScope`),
  `inbound-settlement.test.ts` (`resolveInboundCatalog` for a filed call, `campaignRequiredFor`,
  the panel's `campaign` fields), `inbound/route-config.test.ts`, `pacing-engine.test.ts` and
  `campaign-start-roster-route.test.ts` (the catch-all rule), `proxy-agency-inbound.test.ts`
  (the refusal bodies), the route tables and the agent-reach sweep.
- Contracts: `errors.test.ts` (the three new codes and `campaign_required`), `rbac.test.ts`
  (`agency.calls.manage`), the agent fixtures (`softphone.json`, `inbound.json`).
- Console: `pages/CallsSettingsPage.test.tsx`, `components/SoftphoneScreen.test.tsx` ("every
  call must be saved to a work"), `hooks/useInboundCall.test.ts` and
  `pages/AgentConsolePage.inbound.test.tsx` ("Filed under"), `pages/InboundRoutes.test.tsx` and
  `utils/inboundRouteForm.test.ts` (the route's field), `pages/SoftphoneSettingsPage.test.tsx`,
  `pages/CampaignWorkspace.test.tsx` and `hooks/useCampaignArchive.test.tsx` (the warnings),
  `pages/MissedCallsPage.test.tsx`, `api/callSettings.test.ts`, `api/inboundCalls.test.ts`,
  `utils/navRouteGates.test.ts`.
- App: `test/core/softphone/softphone_controller_test.dart` and
  `test/features/softphone/softphone_panel_test.dart` ("every call must belong to a campaign"),
  `agency_wire`'s `softphone_test.dart` and `inbound_test.dart`.

## 6. P4: reports and Insights by type (built)

A campaign's calls are counted by type wherever the campaign shows its figures: the dialler's
as they always were, the soft phone's beside them (SR1–SR8), and since P4 the inbound calls
filed under it. **Counts add up across the types. Rates never do.**

### Calls by type

| | Dialler | Soft phone | Inbound | All calls |
|---|---|---|---|---|
| Calls | dials, wrap-up redials included ("1,240 dialled") | calls placed and logged to the campaign ("86 dialled") | calls received ("57 received") | the three added |
| Connected | Connected (outcome `connected`, not a wrap-up redial) | outcome `connected` | answered ("44 answered") | added |
| Reached a person | people reached (the connect rate's numerator) | the same rule on a soft-phone call (SR2) | answered: nobody rings us by machine (CL26) | added |
| Talk time | the dials' talk time | the placed calls' | the answered calls' | added |
| Missed by us | — | — | calls that left a Missed row, and "(N to follow up)" | the inbound figure |
| Rate | **Dialler connect rate**: people reached ÷ first dials | **Soft-phone connect rate**: people reached ÷ placed | **Answer rate, open hours**: answered ÷ calls that arrived in open hours | **not added** |

Under it, the proposal's footnote, naming the types shown (`agencyCallsByTypeFootnote`): "All
calls adds the three types. Each call is counted once, under the type it was. Rates are not
added together: the dialler's measures the list and the pacing, the soft phone's the numbers
agents chose, and inbound's how many callers we answered."

**Outbound connect rate (CL7).** The dialler and the soft phone together (people reached ÷
first dials and soft-phone calls placed, SR3's formula) used to be called "All calls connect
rate". It is the **Outbound connect rate** everywhere it shows: under the table on the Calls
tab, "outbound" on the Overview's connect-rate tile, the Performance card's readout, the
report's PDF and its workbook Summary. An inbound call always connects from the customer's end,
so it is in no connect rate, and "All calls" has no rate at all. The label is one constant
(`AGENCY_OUTBOUND_CONNECT_RATE_LABEL`); nothing on the wire was renamed, because no rate is
served on the wire.

**When a column shows (CL29).** The soft phone's while `agency_softphone_enabled` is on or the
range holds a soft-phone call (SR5); inbound's while `agency_inbound_enabled` is on or the range
holds an inbound call, **or while the campaign has missed calls still to follow up** (a quiet
week must not hide callers owed a call back; CL27). With only the dialler to show there is no
table, and the console's pages are what they were. The report has no flag to read, so there
each column shows when the window holds such a call (SR8), and inbound's also while calls are
still to follow up. A dialler-only report prints the figures it always did; its Definitions
page gains three entries (`outbound_connect_rate`, `inbound_calls`, `calls_by_type`), which the
server writes for every campaign report. The dialler's rate is named "Dialler connect rate"
whenever another type shows beside it.

**The bar above the table.** On the console, the proposal's stacked bar: a segment per type
that has calls, in the Call log's own type colours, and the counts beside the types' names
(the figures are text; the colours carry nothing on their own). **The report's PDF has the
table without the bar** (a deviation from the mockup: the page is full, and the table says the
same).

**An older server.** A type's talk time that was not served is a dash, and All calls adds the
talk time of the types that are known, never a made-up 0.

### The inbound figures (`calls.inbound`, `/stats` `inbound`)

`{ received, answered, missed, open_follow_ups, talk_seconds, open_hours }`
(`AgencyInboundCampaignCounts`), one statement (`inbound-campaign-sql.ts`):

- **What is counted is what the Call log lists** (CL16): filed under the campaign
  (`campaign_id`; never `matched_campaign_id`, never `disposition_source`), in its tenant,
  ended, and served (no `rejected` call). The window is half-open on `arrived_at`. The SQL is
  the Call log's own fragments (`inboundCampaignRowConditions`, `inboundAnsweredSql`,
  `inboundMissedSql` in `sql-fragments.ts`), so a figure and the list it counts cannot spell a
  row apart.
- **`open_follow_ups` is the To follow up chip** (CL27): the campaign's open Missed rows by
  CL14's rule (`inboundMissedOpenSql`), as of now and **not cut by the window**. It can be more
  than the window's missed calls; the note under the table says so, and the figure links to the
  chip (`toFollowUpLink`).
- **`open_hours`** (CL26, added to the spec's five) is the answer rate's denominator: the calls
  that arrived while the line was open, the inbound summary's own definition
  (`inboundOpenHoursSql`, shared with `inbound-report.repository.ts`).
- **Read live, no migration** (CL25). The Insights rollup is a pure function of
  `agency_call_attempts` and holds the dialler's figures alone, so the inbound counts are read
  from `agency_inbound_calls` when asked, as the soft phone's are from `agency_manual_calls`.
  The window's counts are a range of `idx_agency_inbound_calls_campaign` (0068).
  `open_follow_ups`, asked on every read whatever the range, is read from the account's open
  Missed rows (`idx_agency_inbound_calls_missed`, by naming the campaign's own account), not
  from every call the campaign ever had; a call is always filed under a campaign of its own
  account, so this removes no row.
- `/stats` serves them over the campaign's life, whatever inbound's flag says.

The soft phone's counts gained `talk_seconds` (the placed calls' talk time) for the Talk time
row.

### Outcomes by type (`outcomes_by_type`, CL28)

One outcome list for the campaign, so one table: Outcome · Dialler · Soft phone · Inbound ·
Total. Dialler is the campaign's conversations by outcome (the `outcomes` rows, unchanged);
Soft phone the placed calls that were put through; Inbound the answered calls; each by the
outcome saved, labelled from the campaign's current catalog. `no_disposition` (the outcome
window ran out) reads "No outcome chosen", its own row, apart from a call with no code at all.
A table prints the types it shows, and Total adds the columns printed. `outcomes` stays the dialler's alone: every figure that
links to the Call log's Dialler chip is.

### One row, one call, one type (CL30)

**Open question for Manas.** The proposal says a dial stopped because the customer rang us
"counts once, as Inbound". As built that holds for Connected, Reached a person, Talk time and
the outcomes, and **not for the Calls row**, where the stopped dial is a Dialler call and the
customer's call an Inbound one. The reason is in the third bullet; CL30 has the alternatives.

- A **missed call and its call back** are two calls: an Inbound row and a Soft phone row. At
  most one person was reached between them. A call back that never dialled is not a call (SR2).
- **Marking a Missed row handled** is a status, not a call: no count moves but the calls to
  follow up.
- A **dial stopped because the customer rang us** is a dial we placed that reached nobody: it
  stays in the dialler's Dials (the standing rule, `docs/insights.md` "System dispositions"),
  and is no connect, no conversation, no person reached and no outcome. The customer's
  conversation is counted once, under Inbound. The Call log lists the same two rows.
- **The Dialler column is the Dials figure** (placed dials, by when they were dialled), so it
  equals the Call log's Dialler chip under the figure's own link (`placed=1`, the dialled
  window). Under plain dates that chip also lists attempts that were never dialled, which no
  figure counts.

**Where a figure and the Call log's count differ, on purpose** (each has a row on both sides of
it in the parity test's seed):

| | The figure | The Call log |
|---|---|---|
| The window | half-open `[from, to)` | `from` and `to` inclusive: a call at exactly `to` is in the log's count alone |
| Dialler · Calls | placed dials, by `dialed_at` | under plain dates, every attempt by `created_at`, never-dialled ones included; equal under the figure's link |
| Dialler · Connected | outcome `connected`, wrap-up redials left out | `outcome=connected` lists a connected redial as its own row; equal with `redial=0` |
| Soft phone, Inbound, To follow up | | the same rows, by the same SQL |

### Where it shows

| Surface | What |
|---|---|
| Insights › Overview | A **Calls by type** panel under the headline figures; the connect-rate tile adds "soft phone …", "outbound …" and "inbound answered …" |
| Insights › Calls | The bar and the table in place of the Soft-phone calls and All calls tiles, the Outbound connect rate under it, and **Outcomes by type** |
| Analytics › a campaign's Performance card | "Outbound connect rate" (renamed), and an **Answer rate, open hours** readout from `/stats` |
| Campaign report, PDF | A **Calls by type** section on page 1, and the Outcomes table with the types' columns (headed with the conversations across the types, and whose the share is) |
| Campaign report, workbook | The same figures as Summary rows: the soft phone's; **Outbound calls placed**, **Outbound calls connected** and **Outbound connect rate** (the dialler and the soft phone together: the numbers "All calls placed / connected / connect rate" were); inbound's; and **All call types: calls / connected / people reached / talk time** for the sums. No "All calls …" name is reused, so an old lookup finds nothing rather than a different number. The Outcomes sheet gains the types' columns, the dialler's headed "Dialler" and "Share of dialler" |

**Dialler-only, unchanged:** the dialler's connect rate, abandonment and its 24-hour limit,
pacing, stalls, best hours, retries, caller-ID health, carrier failures, list progress, Trends,
the Agents tab, the Insights CSV buttons, Home and the agent record (SR7). The account report
sums the counts in its dataset and prints none of them yet. The mobile app reads none of this.

**The report dataset** (`packages/contracts/src/reports`) stays version 1: `calls.inbound`,
`calls.softphone.talk_seconds` and `outcomes_by_type` arrive with the activity it embeds, and
the renderer reads a dataset from a server that predates them (no Inbound column, no outcome
columns). Three definitions were added: `outbound_connect_rate`, `inbound_calls`,
`calls_by_type`.

### Files

- Contracts: `agency/campaign-stats.ts` (`AgencyInboundCampaignCounts`, the soft phone's
  `talk_seconds`, `/stats` `inbound`), `api/agency/insights.ts` (`calls.inbound`,
  `outcomes_by_type`), `api/agency/call-log.ts` (the table's words: the rate labels, "not
  added", "Outbound connect rate", the footnote), `reports/dataset.ts` (the definition keys).
- Server: `db/repositories/agency/inbound-campaign-sql.ts`, `sql-fragments.ts` (the shared row
  rule), `insights-reads.repository.ts` (`inboundCalls`, `outcomesByType`),
  `agency/insights/activity.ts`, `db/repositories/agency/campaign-stats.ts`,
  `agency/reports/datasets/definitions.ts`.
- Console: `utils/agency/insights/rates.ts` (`callsByType`, `showInboundFigures`,
  `inboundAnswerRate`, `outboundConnectRate`),
  `pages/agency/campaign-detail/insights/CallsByType.tsx`, `ActivitySections.tsx`,
  `OverviewSection.tsx`, `utils/agencyCampaignPerformance.ts`,
  `components/agency/CampaignPerformance.tsx`.
- Renderer: `src/rates.ts` (`campaignCallsByType`, the one gate), `src/pdf/templates/campaign.tsx`,
  `src/xlsx/workbook.ts`.

### Tests

- `apps/server/test/integration/api/agency-calls-by-type.test.ts` (real Postgres, the real app):
  one seed with every type; the figures beside the Call log's chip counts for the same campaign
  and window, and over its life; a missed call and its call back; a call back that never
  dialled; Mark handled; the dial the customer's call stopped; a call counted under the
  campaign it is filed under; the dialler's figures untouched; the report's dataset and the
  table the renderer draws from it; the statement's plan.
- `apps/server/test/unit/agency/insights-outcomes-by-type.test.ts`: the outcome merge, and the
  statement held to the Call log's fragments.
- `apps/server/test/integration/api/agency-insights-drilldowns.test.ts`: the activity's wire
  shape (`test/fixtures/insights-responses.json`, rewritten from a real run).
- `apps/report-renderer/test/templates.test.ts` and `workbook.test.ts`: the table, the gate for
  each type, the floors, the Outbound rate with and without inbound calls, an older dataset.
- Console: `components/InsightsSections.test.tsx` (the table, the gate, the link, the
  outcomes), `components/CampaignPerformance.test.tsx`.
- `packages/contracts/test/call-log.test.ts`: the words.

### What P4 left as it was

- **The account report** prints no soft-phone or inbound figures (SR8, CL29).
- **Per-agent rows** (the Agents tab, the agent report) do not count inbound calls answered by
  type; Compare agents has its own inbound metrics (CP rulings).
- **Inbound-only measures** on a campaign (abandon rate, time to answer, calls that came
  through their own agent, voicemails) stay on the account's Inbound summary.
- **The Insights CSV buttons** export the dialler's tables; the Calls by type table has no CSV.
- **The dialler's own outcome tables** (Conversations by disposition, the report's dialler-only
  Outcomes table) still print `no_disposition` as its code where the catalog has no label; only
  the by-type tables read "No outcome chosen".

## 7. P5: My calls and All calls (built)

The campaign Call log's read at two more scopes: one agent's own calls, and the whole account's.
Nothing about what a row is, how the types interleave or how a filter reads on each type is
restated: it is §3 and §4's, because it is the same statement.

### The read (CL31)

`AgencyAttemptRepository.listCallLog` and `countCallLog` take a **scope**
(`CallLogScope`), and `listCallLogForCampaign` / `countCallLogForCampaign` are that read with the
campaign's scope. The three branches, the one keyset, the filters and the inbound row rule are
shared; only the term that says whose calls differs.

| Scope | Dialler | Soft phone | Inbound | To follow up |
|---|---|---|---|---|
| A campaign | its attempts | the calls logged to it | the ended, served calls filed under it | its open Missed rows |
| The account | every attempt of the account | every soft-phone call of the account | every ended, served call of the account | the account's open Missed rows |
| An agent | the attempts of their sessions in the account | the calls they placed | the calls they **answered**, and their **open Missed rows** | their open Missed rows |

- **An agent's inbound rows are two branches**, never the same row twice (a missed call has
  no answerer): `answered_by_user_id = me` (the account's range, filtered), and
  `follow_up_assignee_user_id = me` while the row is open (the Missed list's own index). "Mine" for a Missed row is the Missed list's own rule for an agent: assigned to them.
  A row assigned to the account (the Team view) is nobody's until it is claimed. Once a Missed
  row is handled it is no longer one of the agent's calls: they did not take it.
- **"No campaign"** (`campaign: 'none'`) keeps the soft-phone calls logged to none and the
  inbound calls filed under none. A dialler call always has a campaign, so none matches.
- **One campaign at the account's scope is the campaign's own scope**: the route checks the
  campaign is the account's and reads the campaign Call log's statement, on its own indexes.
- **Somebody who never dialled** costs nothing: an agent's attempts are bounded below by their
  first session in the account, so with no session the range is empty.

### The index (`0070_attempts_account_created_index.sql`, CL37)

`idx_agency_attempts_account_created (tenant_id, account_id, created_at DESC, id DESC)` on
`agency_call_attempts`: the dialler branch's keyset range within an account, as
`idx_agency_attempts_keyset` is within a campaign. The other two tables already had theirs.
It was measured before it was added (the numbers are in the migration's header); it is one more
index written on every dial, and `db-hygiene.md` §2 has the statement to build it
`CONCURRENTLY` before the deploy on a large table. Nothing else was added: "No campaign" on the
soft-phone and inbound branches, and an agent's answered calls, are a filter over the account's
existing range. Two reads therefore grow with the account's history rather than the page: the
inbound calls answered by somebody who has answered few (the account's inbound range is walked to
find them), and the attempts of somebody who dials rarely (the account's range since their first
session). Both are no slower than the list My calls had (`my-attempts` reads the whole attempts
table); an index by answerer on inbound calls, and one by session and time on attempts, are the
fixes if they come to matter.

### My calls (CL9, CL32, CL33, CL36)

`GET /proxy/agency/my-calls` (`agency.station.connect`): the caller's own calls, newest first.
The subject is the session's user. Nothing in the query can name another agent: `agent_user_id`
is not a parameter the route takes (a 400).

- **The number is masked by the server (CL32).** A row carries `phone` and `phone_masked`: the
  number in full when the row's campaign shows numbers to agents or the call has no campaign,
  and the masked text (`98••• ••210`, the domain's `maskFactPhone`) when the campaign's
  `phone_display` is `masked`. This holds on every type of row. It fails closed: the number is in
  full only when every campaign the row names says exactly `full`, so a campaign the read did not
  return, and a stored setting the code does not know, are masked too. An inbound row filed under
  no campaign whose caller matched a campaign's contact (`matched_campaign_id` with no
  `campaign_id`: a row written while an older server ran) is masked by that campaign's setting;
  the row still says it has no campaign. The setting is read when the list is read, so a campaign
  that starts hiding numbers hides them on the calls already made.
- **The row carries no media**: no leg id, no recording, no summary, no other agent's name
  (`toMyCallRow` builds it field by field, never by spreading the read's row).
- **To follow up (CL33)** (`type=to_follow_up`) is the caller's open Missed rows, whatever the
  dates (CL14), then `callbacks_due` on the first page: the callbacks they booked that are due
  today or already late, soonest first. The callbacks are My day's call-later read
  (`myCallLaterStatement`, with its rule for whose a callback is under each assignment mode) on
  every campaign of the account the caller is actively on, to the end of each campaign's own
  day; an archived campaign is left out. With `campaign_id` the callbacks are that campaign's
  alone, and none under `none` (a callback is booked on a campaign's contact), as the missed
  calls above them are narrowed.
- **`counts`** (`include_counts=1`) is what the agent still owes: `to_follow_up` (the open Missed
  rows and the callbacks due), `missed_open` (the Missed calls badge's own count) and
  `callbacks_due`. The other chips carry no number. No filter narrows them: the badge says
  everything owed, whichever campaign is chosen.
- **Filters:** `type`, `campaign_id` (a campaign or `none`), `from`, `to`. A campaign that is
  not the account's is a 404: with a campaign named, the dialler branch is the campaign Call
  log's own agent filter and the answered inbound calls are read on the campaign's index, so the
  campaign is checked first. There is no search by number: on a campaign that hides numbers it would let the hidden digits be found a few at a
  time (CL36).

**Call back from a hidden number.** The number is not in My calls' payload, so the row's Call
back reads that one Missed row by its id (`GET /inbound/missed/:id`: the Missed list's
permission, `agency.inbound.read`, and its rule for whose row it is: the caller's own, an open
one nobody has, or any of the account's for a supervisor; anything else is the 404 of a row that
is not there) at the moment it is pressed, and hands the number to the soft phone with the
missed call's id (CL1). By id, so it works however many rows the agent has open (it read the
list's first 100 open rows until 2026-11-22). The pad shows the number, as the pad shows any
number the agent dials (AS19 S3(b)).

**The two badges agree.** To follow up's badge and the Missed calls badge (the agent's nav, the
app's My calls tab) count the same open Missed rows, and the Missed badge polls. When it says a
number the list did not read, the console and the app read what is owed again: the list itself
under To follow up, the counts alone (a one-row read) under another chip, so the rows and pages
on screen stay. Asked once for each number the badge shows. A supervisor's Missed badge in the
console counts the account's rows, not their own, and is not followed.

**What was true before P5** (the check the proposal asked for): the server sent every number in
full with the campaign's `phone_display` beside it (AS9). The console's My calls masked from that
on its Campaign calls tab only; its Soft-phone calls tab, the Missed list and the app's My calls
showed every number in full. **What is still true:** the Missed list (`/dialer/missed`, the
app's Missed calls list), the soft phone's own reads and the station's frames still carry the
number, as AS9 says (hiding it there is BE-7 step 2, not built).

#### The console (`/dialer/attempts`)

`AgentAttemptsPage.tsx` with `components/agency/MyCallsList.tsx` and `utils/agency/myCalls.ts`.

- **Chips:** "To follow up N · All · Dialler · Soft phone · Inbound". To follow up is first, in
  the warning colour, with what the agent still owes. The page opens on All. Soft phone shows
  where the agent may dial from the soft phone, Inbound and To follow up where Missed calls show
  for them, To follow up also whenever something is owed, and any chip while it is on.
- **Columns:** When · Type · Customer · Campaign · What happened · Outcome · Talk time. Type
  carries what only that type has ("Dialler · Try 2", "Soft phone · Call back" with "to the 3:12
  PM missed call" under it, "Inbound · missed"). Customer is the name with the number under it.
  Outcome is the saved outcome in the campaign's own words with its day ("Will pay · 25 Nov"),
  and the agent's notes. No Call column and no link to a call's page.
- **To follow up:** the missed calls with **Call back** and **Mark handled** (the Missed list's
  own action), then **Callbacks due**: the customer, "Due 4:00 PM" or "Late by 2 hours", and
  "Diwali EMI Collections · you booked it for 1:45 PM". Empty: "Nobody is waiting for a call
  from you."; with a campaign chosen that leaves nobody, "Nobody matches that campaign".
- **Old URLs:** `?view=softphone` (the Soft-phone calls tab) opens the Soft phone chip.
  `/dialer/missed` and the Missed calls entry of the agent's nav are unchanged, with their badge:
  the Team view, claiming, voicemails and the handled rows are there.
- The page says "campaign", as it always did: it is the agent's history, not the station (AS15's
  "work" is the station's word, CL22).

#### The app (My calls tab)

`features/calls/calls_screen.dart`, `my_calls_controller.dart`, `my_calls_copy.dart`,
`widgets/my_call_card.dart`; the wire types are `agency_wire`'s `my_calls.dart`.

- The three segments are **chips** in the same order, wrapped so all five are on screen. To
  follow up carries what the agent owes as a badge.
- A **card** per call: the type in its colour and the time ("3:42 PM"), who the call was with,
  then "campaign · outcome · day · talk time". A missed call to follow up is a warning card with
  **Call back** and **Mark handled**; a callback is "Callback due" with "Late by 2 hours".
- Under To follow up, **Missed calls list** opens the list the Missed segment was (the team's
  calls to claim, voicemails, handled rows).
- The attempts list, the soft-phone calls list, their filter bars and their detail sheets went
  with the segments (CL38).

### All calls (CL34, CL35)

`GET /proxy/agency/calls` (`agency.supervise`): the campaign Call log at the account's scope.
Its query is the Call log's (`type`, the attempt list's filters, `status`, `include_counts`,
`cursor`, `limit`) and `campaign_id` (a campaign, or `none`). Each row names its campaign
(`campaign_name`); a soft-phone or inbound row filed under none has `campaign_id: null`. The
page carries `rule`: the account's "Every call must belong to a campaign" setting and when it
was switched on.

- **The floor is the Soft-phone calls list's**: that list was the account's only for
  `agency.supervise`. An agent is refused. Behind the dialler's flag and no call type's.
- **The route is declared in `App.tsx`** in the `/agency` subtree, with no flag of its own. It
  was missing from the first build of P5 (every link opened "Page not found" while the tests,
  which built their own route tables, passed); `navRouteGates.test.ts` now checks every path the
  shell offers against the routes `App.tsx` really declares, and `appAllCallsRoute.test.tsx`
  renders App's own `<Routes>`.
- **The page** (`/agency/calls`, `AllCallsPage.tsx`) is the Call log's own list component
  (`CallLogList` in `AgencyCampaignAttemptsPage.tsx`) with `scope: 'account'`: the same chips,
  filters, rows and paging, plus a **Campaign** column and a **Campaign** filter ("All
  campaigns", "No campaign", each campaign). It opens on today. A row opens its own page: the
  attempt in its campaign, the soft-phone call, the inbound call in its campaign; an inbound call
  filed under none has no Call page.
- **"No campaign" and "Before the rule" (CL35).** A call filed under none reads "No campaign".
  While the setting is on, one that began before it was switched on reads **"Before the rule"**:
  it was allowed when it was made, and is never given a campaign afterwards (CL10). The filter
  says "No campaign" either way.
- **In the sidebar** it took Soft-phone calls' place under Campaigns. `/agency/softphone`
  redirects to `/agency/calls?type=soft_phone` with its query kept. A soft-phone call's page kept
  its URL and is All calls' sub-page; its "Back to All calls" and a roster contact's "All calls"
  link open All calls with the Soft phone chip on.
- **Settings › Calls** links its count of unfiled calls to All calls on those calls
  (`unfiledCallsPath`: no campaign, the same 30 days).
- **No export**: a campaign's file is its Call log's.

### The routes

| Route | Floor | What |
|---|---|---|
| `GET /proxy/agency/calls` | `agency.supervise` | The account's calls: the Call log's query and `campaign_id` (a campaign or `none`); `counts` with `include_counts=1`; `rule` |
| `GET /proxy/agency/my-calls` | `agency.station.connect` | The caller's own calls: `type`, `campaign_id`, `from`, `to`, `cursor`, `limit`, `include_counts`; numbers masked where the campaign hides them; `callbacks_due` with To follow up |
| `GET /proxy/agency/inbound/missed/:id` | `agency.inbound.read` | One Missed row (the list's row shape) under the list's rules; My calls' Call back reads the number from it |

The first two read the repositories from the public route (`proxy-agency-call-lists.routes.ts`),
as My day does: neither touches per-session runtime state. The third is the Missed list's own
(`proxy-agency-inbound/missed.ts` over the internal handler in `routes/agency/inbound.ts`).

### What P5 left as it was

- **The Missed list still carries numbers in full** to the agent it is assigned to, on the
  console and in the app (above). Masking it needs a Call back that does not need the number.
- **All calls has no stats strip and no Summary column**, which the Soft-phone calls list had.
- **My calls has no filter by what happened, by outcome or by number**, which the Campaign calls
  tab had (CL36), and the app's My calls has no filters and no detail sheet (CL38).
- **A soft-phone row on My calls no longer shows "DNC override" and "Hours override"**, the
  badges the console's Soft-phone calls tab put on a call placed over a refusal (CL36). The row
  the agent reads does not carry the two flags; a supervisor still sees them on the call's page
  and in All calls.
- **The app has no read-only page for one soft-phone call** (the detail sheet the soft-phone
  list opened: the call fields, the override note, who saved the outcome). A card carries the
  outcome and the notes (CL38).
- **The supervisor's per-agent calls** (Analytics, `agents/:userId/attempts`) are still the
  dialler's alone.
- **`GET /proxy/agency/my-attempts` and `GET /softphone/calls`** are still served. A roster
  contact's soft-phone calls and the soft phone's recent calls read the second; older app builds
  read both. `my-attempts` still sends numbers in full with `phone_display` (AS9), and since
  2026-11-22 nothing in the console reads it: `getMyAttempts` and the `{ kind: 'me' }` subject of
  the attempts panel are removed, and the panel is the supervisor's per-agent view alone
  (`agents/:userId/attempts`).

### Tests

- `packages/db/test/integration/db/attempts-account-index-migration.test.ts`: the index, an
  account's keyset page planned on it with no sort, the invalid-index refusal, down then up.
- `apps/server/test/integration/api/agency-all-calls.test.ts` (real Postgres, the real app): All
  calls across campaigns and types on one keyset at several page sizes; the campaign names; what
  is never a row; the type, campaign, "none" and agent filters; the counts; the rule; the floor
  and the tenant boundary. My calls: only the caller's rows; the filters; **no hidden number in
  any response body, for every type, chip and page size**; a campaign that starts hiding numbers;
  no media key on any row; the names; To follow up and the callbacks due, and the callbacks under
  a Campaign filter; an inbound call filed under no campaign masked by its matched campaign; one
  Missed row by its id (the caller's own, an unassigned one, never a colleague's); Mark handled;
  a supervisor's own; the refusals. The dialler branch at the account's scope planned on 0070.
- `apps/server/test/unit/agency/call-lists.test.ts`: `agentPhone` (masked, full, fail closed on
  a campaign not returned and on a setting it does not know, any masked campaign of two, no
  campaign, withheld), `toMyCallRow` for each type and what it never carries, the matched
  campaign's mask, the labels, the callbacks' merge, `parseCallLogQuery`.
- `packages/contracts/test/call-log.test.ts`: the chips' order and words, "No campaign" and
  "Before the rule", "Due …" and "Late by …". `agent-fixtures.test.ts`: the `my_calls` samples.
- Console: `pages/AgentAttemptsPage.test.tsx`, `pages/AllCallsPage.test.tsx`,
  `utils/myCalls.test.ts`, `utils/callLog.test.ts` ("All calls"), `pages/CallsSettingsPage.test.tsx`
  (the link), the nav and search tests. `components/AgentAttemptsPanel.test.tsx` holds the
  attempts panel the supervisor's view still uses. The route itself:
  `routing/appAllCallsRoute.test.tsx` (App's own `<Routes>` at `/agency/calls` and at the old
  `/agency/softphone`), `utils/navRouteGates.test.ts` (every path the sidebar, tab bars, Settings
  and search offer is a route `App.tsx` declares, read with `routing/appRoutes.ts`) and
  `components/softphoneVisibility.test.tsx` (the route renders `AllCallsPage`, behind no flag).
- App: `test/features/calls/calls_screen_test.dart`, `my_calls_controller_test.dart`,
  `my_calls_copy_test.dart`; `agency_wire`'s `my_calls_test.dart`.

## 8. Decisions

CL1–CL38, in full in [`decisions.md`](decisions.md). All default, pending Manas.

| ID | In short | Phase |
|---|---|---|
| CL1 | A call back to a missed call stays type Soft phone, with a "Call back" marker linked to the missed call | **P2, built** |
| CL2 | The setting is per account, with a default campaign per inbound route | **P3, built** |
| CL3 | Default off; switching on is blocked until every inbound route has a default campaign | **P3, built** |
| CL4 | Unknown caller: the route's default at arrival, the agent may change it at wrap-up; a matched caller's campaign is fixed | **P3, built** |
| CL5 | Supervisors are not exempt | **P3, built** |
| CL6 | Do Not Call from a filing-only campaign is written for the whole account | **P3, built** |
| CL7 | "All calls connect rate" becomes "Outbound connect rate"; inbound is never blended into a rate | **P4, built** |
| CL8 | A catch-all campaign is an ordinary campaign. An empty campaign does complete itself, so a campaign a live route files unknown callers under may start with nothing to dial and is not completed when its list runs out; drained, it is quiescent in pacing | **P3, built** |
| CL9 | The agent's My calls tabs merge into one list with chips | **P5, built** |
| CL10 | No backfill of old calls with no campaign; they show as "No campaign" | **P3 and P5, built** |
| CL11 | The campaign Call log's JSON view is one combined source (amends SR6 and IN14) | **P1, built** |
| CL12 | An inbound route's own outcome catalog stays for calls with no campaign | **P3, built** |
| CL13 | A filter means on each type what that type's own column says; one with no meaning on a type leaves that type out. Agent on an inbound call is who answered | **P2, built** |
| CL14 | To follow up is the campaign's open Missed rows by the Missed list's own rule; the dates do not narrow it; its agent filter is the assignee; it is not added to All a second time | **P2, built** |
| CL15 | A call back's link is kept only for a Missed row of the account from the number dialled; any other is dropped and the call still placed | **P2, built** |
| CL16 | An inbound row is an ended, served call filed under the campaign (`campaign_id`), ordered by when it arrived; matched calls were backfilled, in the migration | **P2, built** |
| CL17 | The setting has its own table (`agency_call_settings`) and its own permission (`agency.calls.manage`, account admin); behind neither the soft phone's flag nor inbound's | **P3, built** |
| CL18 | Every live inbound route of the account stands in the way of switching on, numbers or none; the switch and a route's save share one lock; a route's campaign for unknown callers is any campaign of the account that is not archived (one archived since counts as none); routes are not counted while inbound is off for the account | **P3, built** |
| CL19 | Calls that began before the switch finish as they are (`require_campaign_since`) | **P3, built** |
| CL20 | A call filed under a campaign its caller is not on uses that campaign's outcomes, without the promise ones; everything about the customer stays with the match; stored `disposition_source = 'route'` | **P3, built** |
| CL21 | Stopping or archiving a campaign that receives unknown callers asks first, and does not refuse | **P3, built** |
| CL22 | The console's agent station says "work" (AS15); the app and the admin pages use the proposal's words; "Open Team" is Open campaigns, "See them in All calls" waits for P5 | **P3, built** |
| CL23 | An unknown caller's call can be moved at the end of the call only, by its agent to a campaign they may log to, or by a supervisor to any running or paused one; a missed call is filed by its route alone | **P3, built** |
| CL24 | What Settings › Calls counts: the members with the agent role on no running campaign, and the last 30 days' calls filed under none | **P3, built** |

| CL25 | A campaign's inbound figures are read live from `agency_inbound_calls` by the Call log's own row rule; the rollup holds the dialler alone; no migration, no index | **P4, built** |
| CL26 | The inbound counts: received, answered, missed (left a Missed row), talk time, and `open_hours` for the answer rate (the inbound summary's definition); an answered caller is a person reached | **P4, built** |
| CL27 | `open_follow_ups` is the To follow up chip: as of now, not cut by the window | **P4, built** |
| CL28 | Outcomes by type: the dialler's conversations, the soft phone's calls put through and inbound's answered calls, by outcome; `outcomes` stays the dialler's | **P4, built** |
| CL29 | Where Calls by type shows and when each column does; no table for the dialler alone; the report gates on the window's calls; the dataset stays version 1 | **P4, built** |
| CL30 | One row, one call, one type in figures: a stopped dial stays a dial that reached nobody and the conversation counts once under Inbound; the Dialler column is the Dials figure | **P4, built** |

| CL31 | One read, three scopes (a campaign, the account, an agent). An agent's inbound rows are the calls they answered and their open Missed rows, never anyone else's | **P5, built** |
| CL32 | My calls masks on the server: a number its campaign hides from agents is never sent, on any type of row; no media on the row; only exactly `full` shows a number, and a matched campaign masks a call filed under none; Call back reads its Missed row by id when pressed | **P5, built** |
| CL33 | To follow up for an agent: their open Missed rows, then the callbacks due today or late by My day's own rule; its badge is the two added, the Missed badge stays the Missed rows | **P5, built** |
| CL34 | All calls takes the account's Soft-phone calls' place: `agency.supervise`, behind no call type's flag, opens on today, no export; the old URL redirects with the Soft phone chip | **P5, built** |
| CL35 | A call filed under none reads "No campaign", or "Before the rule" when it began before the setting was switched on; the filter says "No campaign" | **P5, built** |
| CL36 | My calls opens on All with To follow up first; filters by campaign and dates only, and never by number; the Missed calls page and its badge stay | **P5, built** |
| CL37 | One index for the account's dialler attempts (0070), measured first; nothing added for the other branches | **P5, built** |
| CL38 | The app's My calls is one list of cards; the attempts and soft-phone lists, their filters and detail sheets are removed; the Missed calls list is one tap from To follow up | **P5, built** |

Checked while building P3: the console's agent station never said "Log to" (its label is "Save
this call to", with "Not in any work": CL22); and a campaign with no contacts does complete
itself (CL8). Checked while building P5: agents did not see masked numbers in My calls, except
on the console's Campaign calls tab, which masked in the browser from a number the server had
sent in full (§7, CL32).

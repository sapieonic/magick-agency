# One call log per campaign

A campaign's calls used to be listed in several places, by what placed them: the Call log's
Dialler calls, its Soft-phone calls view, the account's Soft-phone calls, Missed calls, and
answered inbound calls nowhere at all. This work makes them one list. Manas approved the
proposal on 2026-11-22 ("go ahead and build this end-to-end"); it is built in six phases, each
shippable alone. **P1 and P2 are built (2026-11-22). P3 to P6 are not.**

The decisions are CL1–CL16 in [`decisions.md`](decisions.md) ("One call log per campaign (CL)"),
all **default, pending Manas**: he accepted CL1–CL12 with the proposal as a whole, not one by one,
and CL13–CL16 are P2's build rulings.

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
| Is anything not filed under a campaign? | Campaigns › All calls › Campaign: No campaign (P5) |
| Who did I talk to? Who do I owe a call? | My calls, To follow up first (P5) |
| Are we keeping every call on a campaign? | Settings › Calls (P3) |

## 2. Phases

| Phase | What | Status |
|---|---|---|
| P1 | One campaign Call log for dialler and soft-phone calls. No migration | **Built 2026-11-22** (§3) |
| P2 | Inbound in the log: a campaign on inbound calls, the third type, To follow up, the missed call and its call back linked, the inbound call page, the export's inbound rows | **Built 2026-11-22** (§4) |
| P3 | The setting "Every call must belong to a campaign": per account, a default campaign per inbound route, enforcement on the soft phone and inbound wrap-up, Settings › Calls, the app | Not built |
| P4 | Reports and Insights by type: inbound figures, the Calls by type table, outcomes by type, "Outbound connect rate" | Not built |
| P5 | The agent's My calls as one list (console and app), and the account's All calls in place of Soft-phone calls | Not built |
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

- The account's **Soft-phone calls** list (`/agency/softphone`) and the agent's My calls are
  unchanged until P5. The campaign's old Soft-phone calls view had two things the Call log does
  not: the stats strip over the rows on screen, and the Summary column. The account list still
  has both, and Insights carries the campaign's soft-phone figures.
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
  written. `db-hygiene.md` §6 asks for a batched script on a large table; 0067's header says how
  a deployment whose table has grown past about a million rows runs the same UPDATE in batches
  first (the migration's own then writes nothing).
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
interleave by when each call began. Each branch is still its own index range with its own
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
  still owed one today, and the Call log opens on today. The page says so under the chips.
- **`findInboundForCampaign`** is one row of the same SELECT under the same rule, for the Call
  page: a call the list would not show (live, rejected, another campaign's or tenant's) is a 404.

### How a filter reads on each type

The rule P1 set for the soft-phone status, now for every filter (CL13): **a filter means on
each type what that type's own column says, and a filter with no meaning on a type leaves that
type out**, rows and counts alike. It never silently lets a type through unfiltered.

| Filter | Dialler | Soft phone | Inbound |
|---|---|---|---|
| Agent | the agent of the reserved session | who placed it | who **answered** (`answered_by_user_id`). A missed call has no agent, so with an agent chosen no missed call matches (To follow up reads 0) |
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
  row, an answered call, a different number, an id that names nothing) is **dropped, and the call
  is placed all the same**: the link is a marker, never a reason to refuse an agent ringing a
  customer.
- The Call log shows both ways: the soft-phone row says "Call back · to the 3:12 pm missed call"
  (`callback_of`), the missed row "Called back 3:31 pm" (`called_back`: the latest soft-phone call
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
  where its follow-up stands ("Called back 3:31 pm", **To follow up** with **Call back** and
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

- **Customer history, the agent's My calls, the account's lists, Insights and the reports** do
  not show inbound calls by type yet (P4, P5, P6). Their reads keep `matched_campaign_id`.
- **Filing an unknown caller** under a campaign is P3: until then only a matched caller's call is
  in a campaign's log, so a missed call from an unknown number is on Inbound › Missed calls and
  in no campaign's To follow up.
- The mockup's "Customer history" button on the Call page is "Open contact" (the roster contact,
  when the caller matched one): customer history is a number search with its own audit (CH6).
- The mockup's "placed by … (supervisor)" stays out, as in P1.
- Times are in the console's display format ("3:31 pm"), as the When column is.

### Tests

- `packages/db/test/integration/db/call-log-inbound-migration.test.ts`: the columns, the CHECK
  from every side, the backfill with `updated_at` kept, both indexes, the invalid-index refusal,
  down then up.
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

## 5. Decisions

CL1–CL16, in full in [`decisions.md`](decisions.md). All default, pending Manas.

| ID | In short | Phase |
|---|---|---|
| CL1 | A call back to a missed call stays type Soft phone, with a "Call back" marker linked to the missed call | **P2, built** |
| CL2 | The setting is per account, with a default campaign per inbound route | P3 |
| CL3 | Default off; switching on is blocked until every inbound route has a default campaign | P3 |
| CL4 | Unknown caller: the route's default at arrival, the agent may change it at wrap-up; a matched caller's campaign is fixed | P3 |
| CL5 | Supervisors are not exempt | P3 |
| CL6 | Do Not Call from a filing-only campaign is written for the whole account | P3 |
| CL7 | "All calls connect rate" becomes "Outbound connect rate"; inbound is never blended into a rate | P4 |
| CL8 | A catch-all campaign is an ordinary campaign; check whether an empty campaign completes itself | P3 |
| CL9 | The agent's My calls tabs merge into one list with chips | P5 |
| CL10 | No backfill of old calls with no campaign; they show as "No campaign" | P3, P5 |
| CL11 | The campaign Call log's JSON view is one combined source (amends SR6 and IN14) | **P1, built** |
| CL12 | An inbound route's own outcome catalog stays for calls with no campaign | P3 |
| CL13 | A filter means on each type what that type's own column says; one with no meaning on a type leaves that type out. Agent on an inbound call is who answered | **P2, built** |
| CL14 | To follow up is the campaign's open Missed rows by the Missed list's own rule; the dates do not narrow it; it is not added to All a second time | **P2, built** |
| CL15 | A call back's link is kept only for a Missed row of the account from the number dialled; any other is dropped and the call still placed | **P2, built** |
| CL16 | An inbound row is an ended, served call filed under the campaign (`campaign_id`), ordered by when it arrived; matched calls were backfilled, in the migration | **P2, built** |

To check while building later phases: the console's literal "Log to" label (P3), whether agents
see masked numbers in My calls today (P5), and whether a campaign with no contacts completes
itself (CL8, P3).

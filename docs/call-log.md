# One call log per campaign

A campaign's calls used to be listed in several places, by what placed them: the Call log's
Dialler calls, its Soft-phone calls view, the account's Soft-phone calls, Missed calls, and
answered inbound calls nowhere at all. This work makes them one list. Manas approved the
proposal on 2026-11-22 ("go ahead and build this end-to-end"); it is built in six phases, each
shippable alone. **P1 is built (2026-11-22). P2 to P6 are not.**

The decisions are CL1–CL12 in [`decisions.md`](decisions.md) ("One call log per campaign (CL)"),
all **default, pending Manas**: he accepted them with the proposal as a whole, not one by one.

## 1. The model

A call is a call. Its **type** is a column, its **campaign** is a column, and every list of
calls is the same combined read with different filters fixed.

| Type (UI) | Wire value | What it is | Table |
|---|---|---|---|
| Dialler | `dialler` | A paced dial of the campaign. Always has a campaign | `agency_call_attempts` |
| Soft phone | `soft_phone` | A call an agent placed by hand and logged to a campaign | `agency_manual_calls` |
| Inbound | `inbound` | A customer rang us (P2) | `agency_inbound_calls` |

The words are the ones Live calls uses (`AGENCY_CALL_ORIGIN_LABELS`); the wire values are the
ones the export's `source` column already uses (SR6).

Calls keep their own three tables. `agency_calls.campaign_id` stays NULL on soft-phone and
inbound legs: the dialler's pacing and abandonment reads count legs by that column, so a manual
or inbound leg must never carry it (SR1).

Missed calls is not a separate kind of call. From P2 it is the **To follow up** view of the same
list: a campaign's missed inbound calls that are still open.

| Someone asks | They go to |
|---|---|
| What happened on my campaign today? | Campaign › Call log. Today is the opening range |
| Who is still owed a call back? | The same page, To follow up (P2). Across campaigns: Inbound › Missed calls |
| Is anything not filed under a campaign? | Campaigns › All calls › Campaign: No campaign (P5) |
| Who did I talk to? Who do I owe a call? | My calls, To follow up first (P5) |
| Are we keeping every call on a campaign? | Settings › Calls (P3) |

## 2. Phases

| Phase | What | Status |
|---|---|---|
| P1 | One campaign Call log for dialler and soft-phone calls. No migration | **Built 2026-11-22** (§3) |
| P2 | Inbound in the log: a campaign on inbound calls, the third type, To follow up, the missed call and its call back linked, the inbound call page, the export's inbound rows | Not built |
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

P2 adds a third member to the union, `inbound` to `AGENCY_CALL_LOG_TYPES`, and its count; the
route, the page and the chips are built on those lists, so nothing is reshaped. To follow up is
one more count and one more `type` value.

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
- **Drill-downs land on the Dialler chip.** Every Insights and Compare agents figure that opens
  this page counts the dialler's dials alone (SR1), so `attemptsLink`
  (`utils/agency/insights/links.ts`) always sets `type=dialler`. Without it the list would also
  hold the soft-phone calls that match the same filters, and its count would not be the number
  clicked. A contact's "all calls" link sets no type: that list is every call to the contact.
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
- The mockup's subtitle says "dialled, made from the soft phone and received"; P1 says "dialled
  by the dialler and made from the soft phone" until inbound calls are in the list (P2).

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

## 4. Decisions

CL1–CL12, in full in [`decisions.md`](decisions.md). All default, pending Manas.

| ID | In short | Phase |
|---|---|---|
| CL1 | A call back to a missed call stays type Soft phone, with a "Call back" marker linked to the missed call | P2 |
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

To check while building later phases: the console's literal "Log to" label (P3), whether agents
see masked numbers in My calls today (P5), and whether a campaign with no contacts completes
itself (CL8, P3).

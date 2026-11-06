# Customer history

Search one phone number and see every interaction with it across the tenant's campaigns and the
soft phone, in one place: who the number belongs to in each campaign, its DNC status, open
callbacks and overrides, a call live right now, and one timeline, newest first. Built 2026-11-06
from the ClickUp task "Customer history: search one phone number and see every interaction across
the tenant's campaigns", then reviewed and fixed the same day; Manas's five decisions are CH1–CH5
below, the build's own calls CH6–CH13.

Wire: `packages/contracts/src/api/agency/customer-history.ts`. Number rule:
`packages/domain/src/customer-search-number.ts` (Dart port in `apps/mobile/packages/agency_wire`),
held to one table, `packages/contracts/fixtures/agent/customer-search-numbers.json`. Hero fields:
`packages/domain/src/context-hero.ts`. Migration `0016_customer_history_indexes.sql`. Permission
`agency.customer_history.read`.

## 1. Decisions

Status words as in [`decisions.md`](decisions.md): **Decided** (Manas ruled it), **default,
pending Manas** (built with the recommended option, not yet ratified), **open** (needs Manas).

| ID | Decision | Status |
|---|---|---|
| CH1 | **Everyone can search**: agents, supervisors, account owners, tenant owners. New permission `agency.customer_history.read` floored at `agent`, its own permission so its floor can be raised later without touching the routes. | **Decided** (Manas) |
| CH2 | **Scoped by account, inside the query.** The visible accounts are every account of the tenant (not `deleted`) for a caller with a tenant-level membership (`account_id IS NULL`), else the accounts of the caller's active account memberships in the tenant. Every read binds `account_id = ANY($visible)`; rows of other accounts are left out entirely, never counted as hidden. Two kinds of row are scoped through what they name: a DNC mark on a campaign is stored with no account (`account_id NULL`, `campaign_id` set, as the dialer's mark writes it), so it belongs to its campaign's account, resolved through `agency_campaigns`; a roster import belongs to its campaign's account (the ingest job's own `account_id` is the uploader's membership, NULL for a tenant-level uploader). Only a DNC entry with neither an account nor a campaign is tenant-wide. The caller's role in an account is the higher of their tenant-level role and their role in that account. | **Decided** (Manas) |
| CH3 | **v1 searches by phone only; the API and page allow other keys.** The request is `{ by, value }` with `by: 'phone'`; a key-column search is designed in §6, not built. Nothing in the answer assumes the key is a phone number (each contact row carries its own `phone_e164`). | **Decided** (Manas) |
| CH4 | **Full number only.** A number shorter than the country's national length is refused `invalid_number` / `too_short` ("Enter the full number. Searching by the last few digits isn't supported."). Every read is an exact match on E.164; nothing searches by a number's ending. "Not a valid number" is judged on length (and a leading 0) only: there is no check of a mobile prefix, so a 10-digit Indian number starting `1` is searched. | **Decided** (Manas) |
| CH5 | **The box explains how to enter a number**: a country picker, always-visible helper text, a live preview ("We'll search for +91 98765 43210"), and refusals that say what to do. The picker starts on the platform default: both clients read it from `GET /proxy/agency/customers/options` (the server's `DEFAULT_PHONE_COUNTRY_CODE`, `+91` unless configured) and use +91 while it loads or when it cannot be read; it never replaces a country the user picked. The preview and the server run ONE rule (`parseSearchNumber`), held to one shared test table; the app's Dart port runs the same table. The server's answer is final and echoed ("Results for +91 98765 43210"). | **Decided** (Manas) |
| CH6 | **The number never travels in a URL or a log.** The search is `POST /proxy/agency/customers/search` with the raw text in the body. It answers a `search_id` (`chs_` + 32 hex, 30 minutes, bound to the tenant and the user, held in Redis); the timeline pages and the export name the search by that id. An unknown, expired or other user's id, or one replayed under another tenant, is `404 search_expired`. The console's page is `/agency/customers` for the agency screens and `/dialer/customers` for agents (no number in either URL); the last answer is held in memory, and a reload shows the empty search. Request bodies are never logged: Fastify's own request log is off (`docs/architecture.md` "Observability"), and the error handler logs the URL only. | **default, pending Manas** |
| CH7 | **A retry chain is one row.** Contacts are grouped by `root_contact_id` (a retry copy and its parent are one person in one campaign chain); the campaign filter takes root campaigns and includes their retries. Several roster rows carrying the number in one campaign (a household line) stay separate rows. | **default, pending Manas** |
| CH8 | **Visibility follows the screens the caller can already open**, per account: notes, override notes (a campaign dial's, a soft-phone call's DNC and hours overrides) and soft-phone call fields need `agency.campaigns.read` there, or the call is the caller's own (withheld otherwise, with `notes_hidden: true` when any of them existed); the call page (recording, transcript, analysis) needs `agency.supervise` there (`call_page: null` otherwise). Who added a DNC entry and why (`added_by`, `reason`) need `agency.dnc.read` in the account the entry belongs to (a campaign mark: its campaign's account); for a tenant-wide entry, in the caller's highest role in the tenant, as the DNC registry reads it. An agent never sees them. | **default, pending Manas** |
| CH9 | **Every read uses an index.** Contacts by `idx_agency_contacts_phone (tenant_id, phone_e164)`; attempts by `contact_id` (`uq_agency_attempt_number`); soft-phone calls by the new `idx_agency_manual_calls_destination (tenant_id, account_id, destination_e164, created_at DESC, id DESC)` (migration 0016: an untagged call has no contact), walked once per visible account in keyset order, and by `idx_agency_manual_calls_contact_history`; DNC by `idx_dnc_entries_tenant_phone`; imports by `idx_agency_ingest_jobs_campaign`; campaigns, sessions and media legs by primary key. The server's integration suite EXPLAINs every statement exactly as the repository runs it, on bulk-seeded, analysed tables with no plan type disabled; the migration's own test asserts the soft-phone keyset probe is an index scan directly under the `Limit`, the cursor in the index condition, with no sort. Measured at the spec's scale in §4. | **default, pending Manas** |
| CH10 | **Every successful search and export is audited** (`platform_audit_log`): `agency_customer_history.searched` and `agency_customer_history.exported`, resource type `customer_history`, `resource_id` the search id, the tenant, the account context (`account_id`, when the request named one), the actor, and `details { by, value (the E.164 searched), result_count (timeline entries visible, unfiltered), accounts (the visible account ids), role (the caller's highest) }`; an export adds `rows`, `filters` (bounded by `boundedSelector`, `api/routes/helpers/audit-bounds.ts`, as the retry routes' audit rows: up to 50 values per list and 200 characters per value, a cut marked `…[N more truncated]`) and `truncated`. A search with zero results is audited. Not audited: refusals (400, 403, 404 `search_expired`, 429), timeline pages, the options read. Best-effort, as every platform audit row: buffered and written in the background, so the answer never waits on it. Not a campaign action, so it is outside the campaign activity filter. | **default, pending Manas** |
| CH11 | **Rate limit per user**: `AGENCY_CUSTOMER_SEARCH_PER_MINUTE` (default 30) searches and exports a minute per user, its own bucket (`chs:<user id>`) besides the general per-user one. Its 429 carries `retryAfter` and the message "You've searched a lot of numbers in a short time. Try again in N seconds." (the server's own words; the console and the app show the same). Timeline pages and the options read are not charged to it. | **default, pending Manas** |
| CH12 | **What the schema cannot show, and what is shown instead.** (a) A DNC removal is a hard `DELETE` whose audit row deliberately carries no number, so the timeline shows DNC marks (current entries) only, not removals. (b) No column links a contact to its upload; `upload_file_name` is the campaign's non-dry-run import whose run window covers the contact's `created_at`, else null. (c) Roster replace does not remove contacts (B15: there is no supersede), so no row is ever "Removed from roster"; when supersede lands it marks the row and the history keeps it. (d) Callbacks are `callback_at` on the call that booked them; kept / late / missed is judged by the next call placed to the number (§4). (e) The roster ingest keeps a bracketed trunk `0` (`+44 (0)20 7946 0018` is stored `+4402079460018`) where the search and the soft phone drop it, so such a row is not found; pinned `it.fails` in `search-number-agreement.test.ts`. Fixing the ingest changes what existing rosters dedupe on. Every Indian form agrees. | (b)–(d) **default, pending Manas**; (a) and (e) **open** |
| CH13 | **The CSV export is the console's only in v1.** The agent app has the search and the page but no export: it has no file-sharing plugin, and adding one is a dependency change that was not made while the app could not be built (no Flutter SDK where it was written). An agent who needs the file uses the console. | **default, pending Manas** |

## 2. API

| Route | Body | Answer |
|---|---|---|
| `POST /proxy/agency/customers/search` | `CustomerSearchRequest { by: 'phone', value, country? }` | `CustomerSearchResponse { search_id, expires_at, key, summary, timeline }` |
| `POST /proxy/agency/customers/timeline` | `CustomerTimelineRequest { search_id, filters?, cursor?, limit? }` | `CustomerTimelinePage { entries, next_cursor }` |
| `POST /proxy/agency/customers/export` | `CustomerExportRequest { search_id, filters? }` | `text/csv` attachment `customer-history-YYYY-MM-DD.csv` (never the number), every entry the filters keep, newest first (cap 10,000 rows; `X-Export-Rows`, and `X-Export-Truncated: true` past the cap) |
| `GET /proxy/agency/customers/options` | — | `CustomerSearchOptionsResponse { default_country_code }` (`+91` unless `DEFAULT_PHONE_COUNTRY_CODE` says otherwise): what the box needs before the first search. No number in it; not charged to the search cap, not audited |

Guards, in order: session, tenant context, `agency.customer_history.read`, the dialer flag
(`agency_dialer_enabled` for the request's tenant and account, `403 feature_disabled`), the
per-user search cap (search and export only), then the body (`400 invalid_search_request`), then,
for a search, the country and the number (`400 invalid_search_request`, `400 invalid_number` with
`number_error`), for a page or an export the search id (`404 search_expired`), and for a page
the cursor (`400 invalid_cursor`). The options read stops after the dialer flag.

Refusal body: `{ error, code, message, number_error? }` (`CustomerHistoryErrorResponse`). What is
refused, and how:

- **A body that is not JSON** is `400 invalid_search_request` "The request body is not valid
  JSON." on every `POST` of the family: the family parses JSON itself (`useFamilyJsonParser`,
  scoped to these routes; the app-wide parser is untouched).
- **A malformed body** is `400 invalid_search_request` naming the first problem by path. Each list
  filter takes at most 100 values (`CUSTOMER_FILTER_LIST_MAX`), each disposition code 1 to 50
  characters (`CUSTOMER_FILTER_CODE_MAX`), `limit` 1 to 100, and `from` must be before `to`. The
  clients show their own words for this code, not the validator's.
- **A country the picker does not list** is `400 invalid_search_request` "country: not a country
  the search offers", never searched as a number of the default country.
- **A number the rule refuses** is `400 invalid_number` with the rule's own message and its
  `number_error` (`empty`, `invalid_characters`, `spreadsheet_number`, `too_short`,
  `invalid_for_country`).
- An unknown, expired, malformed or other user's search id is one answer, `404 search_expired`.
- **429**: a search or an export over the cap answers "You've searched a lot of numbers in a short
  time. Try again in N seconds." (CH11). A timeline page is refused only by the general per-user
  limit, whose body reads "Rate limit exceeded. Try again in N seconds."; the clients show "Too many
  requests in a short time. Try again in N seconds." for it, never blaming searching.

Every successful search, timeline page and export is `Cache-Control: no-store`; refusals and the
options answer carry no customer data and set no cache header.

## 3. The summary

Read once, at search time, from the roster rows and SQL aggregates over the number's calls: no
call row is shipped to build it (`loadCustomerSummary`).

- **contacts**: one row per retry chain (CH7) carrying the number, in the visible accounts:
  the chain's newest campaign and every campaign of the chain, the contact's state there and
  suppressed reason, attempts placed across the chain, the row's hero fields, the owning agent,
  when it entered the roster and the upload file (CH12 b). Newest first. At most the newest 2,000
  roster rows are listed (`CUSTOMER_HISTORY_MAX_CONTACT_ROWS`, a guard against a placeholder number
  pasted down a roster); past that the answer carries `contacts_truncated: true` and the clients
  say "Showing the 2,000 most recent roster rows for this number. The timeline still includes
  every call." The timeline pages through every row whatever the cap.
- **Hero fields** follow the contact panel's rule (`heroColumnsFor`,
  `packages/domain/src/context-hero.ts`): the campaign's `context_display.hero` columns, matched
  case-insensitively, at most four; else one column per heuristic group (a name, an amount, an
  identifier, a place); else the first four columns with a value. A column in
  `context_display.hidden` is never chosen. "First" is the order of the columns in the newest
  import of the row's campaign, else of its chain root (`agency_ingest_jobs.context_columns`), not
  the JSONB object's key order. Columns with no value are left out.
- **totals**: calls placed (campaign attempts with `dialed_at`, soft-phone calls with
  `dialed_at`), connected (`outcome = 'connected'`), and the last contact: the newest placed call
  with when, by whom, its channel, outcome and code.
- **dnc**: every entry covering the number at any level the caller may see (tenant-wide; an
  account they can see; a campaign mark of a campaign in one, CH2), each with `account_id` the
  account it belongs to (a campaign mark: its campaign's account; NULL only for a tenant-wide
  entry), and who and why under CH8.
- **open**:
  - callbacks: a contact waiting on one (state `pending`, its last call connected, its
    `last_disposition` a callback code of the campaign's catalog), due at `next_attempt_at`, with
    its owner and who booked it;
  - overrides: a grant that still grants something (`isOverrideUnspent`, the dialer's own rule:
    `override_disposition` set and extra attempts left or a waiver on), with `follow_up_at`, the
    contact's `next_attempt_at` while it is `pending`, else null ("Follow-up <time>" or "No
    follow-up scheduled");
  - live calls: an attempt or a soft-phone call that is `dialing`, `ringing`, `answered` or
    `bridged`, with its campaign and agent. A `queued` attempt was never dialled and is not live.
- **filter_options**: root campaigns, agents, outcomes and codes seen in the history.

## 4. The timeline

One list, newest first, ordered `at DESC, key DESC` (`key` is `<kind>:<id>`, unique across
kinds). This is the spec's `created_at DESC, id DESC` carried across sources: `at` is each kind's
own instant (a callback's is its booking time, not the call's `created_at`). Kinds:

| Kind | Source | `at` |
|---|---|---|
| `campaign_call` | `agency_call_attempts` of the number's contacts; wrap-up redials carry `redial_of_attempt_id`, their place in the chain (`redial_number`) and the chain's first attempt (`chain_attempt_id`). Campaign attempts have no call fields (only soft-phone calls carry `fields`) | `created_at` |
| `softphone_call` | `agency_manual_calls` to the number (`destination_e164`), tagged or not, plus those logged to the number's contacts | `created_at` |
| `callback` | a call with `callback_at` (campaign or soft phone) | when booked: `dispositioned_at`, else the call's `ended_at`, else `created_at` |
| `dnc_mark` | `dnc_entries` covering the number that the caller may see (CH2) | `created_at` |
| `roster_entry` | each contact row (a retry copy included, so the chain's campaigns show) | the row's `created_at` |

**Callback status** (the insights page's 15-minute window): the next call placed to the number
(either channel) after the booking. Placed by `due_at + 15 min` → `kept`; placed later →
`late`; none yet: `upcoming` before `due_at`, `due` within 15 minutes after it, `missed` past
that.

**Recording state**: `no_call` (no media leg: `webrtc_call_id` null); a leg that still exists is
`available` with a `recording_url`, else `not_recorded`; a leg retention purged (the `agency_calls`
row is gone) is `expired` only when the call asked for a recording (the campaign's `record_calls`
for a campaign call, the call's own `recording_requested` for a soft-phone call), else
`not_recorded`, because retention purges every old leg, recorded or not. Caveat: `record_calls` is
the campaign's CURRENT setting, so a campaign that turned recording on or off later is judged by
today's value for its older calls.

**Filters** (`CustomerTimelineFilters`): `campaign_ids` (root campaigns, retries included; under
it, tenant- and account-wide DNC marks and untagged soft-phone calls drop out, and only
campaign DNC marks of those campaigns stay), `from` / `to` (half-open, on `at`), and the call-only
filters `outcomes`, `disposition_codes`, `agent_user_ids`, `connected_only`, `channel`; any
call-only filter keeps only call entries, and `channel` only its own source.

**Paging**: keyset, never offset (`loadTimelinePage`). `next_cursor` is an opaque base64url of
`{ at, key }` with `at` at microsecond precision (`keysetAtSql`,
`packages/domain/src/keyset-cursor.ts`). Each page runs one keyset statement per source
(`CUSTOMER_HISTORY_SQL.pageAttempts`, `pageManualCalls`, `pageCallbacks` (both channels' callbacks,
each arm its own top `n`), `pageDnc`, `pageContacts`), each taking the cursor, every filter it can
apply in SQL and `LIMIT n + 1`; a source a filter rules out is not read. The service merges the
heads, keeps the top `n` (`limit`, default 50, at most 100), then enriches only those by primary
key (campaigns, media legs, names, the upload file) and judges the page's callbacks
(`callbackNext`). At the cursor's own instant, each source resumes after the cursor's id when it is
of the cursor's kind, else takes every row of a kind that sorts before the cursor's and none of a
kind after it (`sourceBound`), so a page never skips or repeats an entry. A page reads O(page) rows
per source, plus the index entries of the number's own rows where a source has no index in
timeline order (campaign attempts: a top-N sort over the number's attempts, found by contact).
Entries' `at` is sent at millisecond precision; the cursor keeps the microseconds.

**The export** is one keyset page as large as the cap (`AGENCY_CUSTOMER_EXPORT_MAX_ROWS`, default
10,000): each source reads at most cap + 1 rows, and a further entry sets `X-Export-Truncated:
true`. Its `result_count` for the audit counts what the search's aggregates count, in one
count-only statement (`countCustomerEntries`, `CUSTOMER_HISTORY_SQL.entryCount`). CSV columns are British English; a wrap-up redial's "Details" cell reads
"Wrap-up redial N"; every cell goes through the spreadsheet-formula guard.

**Measured at the spec's scale** (spec §6: a number with 500+ calls across 20 campaigns, first page
under 1 s on a 1M-contact tenant), 2026-11-06, through the real service and repository on a local
Postgres 16: 1,000,020 contacts, about 750,000 attempts and 200,000 soft-phone calls in 10 accounts
and 20 campaigns; the searched number on 20 roster rows (one per campaign) with 580 calls (520
attempts with callbacks, wrap-up redials and overrides among them, 60 soft-phone calls, half of
them untagged), a tenant-wide DNC entry and three campaign marks. 30 timed runs per caller:

| Caller | Search: viewer, summary and first page of 50 (median / p95) | A later page, entries 251–300 (median / p95) |
|---|---|---|
| Tenant-level owner (10 accounts: the soft-phone read walks 10 account slices) | 15.1 / 17.6 ms | 5.0 / 6.4 ms |
| Account-scoped supervisor (1 account) | 6.3 / 10.2 ms | 4.0 / 4.7 ms |

`EXPLAIN (ANALYZE, BUFFERS)` of every statement on that data, with nothing disabled: no full scan
of any table; the slowest statements were `callStats` and `uploads` (1.5 ms each) and `lastPlaced`
(1.0 ms), the rest under 0.7 ms. No index beyond migration 0016 was needed.

The measurement is `apps/server/scripts/bench-customer-history.ts`: opt-in, never run by CI, on its
own database, which it refuses unless it is `localhost:5436/magick_agency_test_bench` (it drops
that database's schema when it seeds). Create the database once, then run it from `apps/server`:

```bash
psql -h localhost -p 5436 -U magick_agency -d magick_agency -c "create database magick_agency_test_bench owner magick_agency"
pnpm tsx scripts/bench-customer-history.ts                  # migrate, seed, time, EXPLAIN
BENCH_RESEED=0 pnpm tsx scripts/bench-customer-history.ts   # time the data already seeded
```

`BENCH_SEED_URL` must be a superuser connection (the seed runs with triggers off); its default is the
dev stack's superuser, `magick_agency` (`docker/docker-compose.dev.yml`). `BENCH_DB_URL` is the app's connection (default: the dev stack's
`magick_agency` user), `BENCH_CONTACTS` the tenant's size (default 1,000,000), `BENCH_RUNS` the
timed runs per caller (default 20), `BENCH_PLANS_FILE` where the full plans go (default the OS
temporary directory).

## 5. Clients

- **Console**: a "Search a number" box with a country picker in the agency top bar
  (`CustomerSearchPopover` in `AgencyLayout`), and for agents a "Search a number" entry in
  `AgentNav` that opens `/dialer/customers`; both open the Customer history page
  (`/agency/customers`, and `/dialer/customers` for agents). The country picker starts on the
  answer of `GET /proxy/agency/customers/options`, read once per page load
  (`hooks/useCustomerSearchDefaultCallingCode.ts`). The box shows the helper text and the live
  preview as you type; a refusal that more digits cannot cure (letters, a number Excel shortened,
  too long for the country) shows as typed, while the empty box and "Enter the full number…" show
  only after Search, Enter or leaving the field (`aria-invalid` only then). A search still in
  flight when the box goes away is cancelled, and a late answer never navigates. The box keeps the
  last five numbers searched on this device (`localStorage`), one list shared by every box on the
  page and across tabs, cleared by "Clear recent searches" and on sign-out. In the top-bar panel,
  Tab stays inside the panel while it is open. The page puts focus on its "Results for …" heading,
  and shows a "Copy number" button, the summary, the filters, the timeline with "Load more", and
  "Export CSV". A filter change clears the rows and the cursor at once; a failed page shows the
  error with "Try again" and no rows. A reversed date range is refused on the page ("The end date
  must be on or after the start date.", the pickers bound each other, Export is disabled meanwhile).
  "Search again" after the search expired keeps the filters. Wrap-up redials sit indented under
  their first call: "Wrap-up redial N of the call at <time>" (or "of an earlier call" when that call
  is on another page), and the first call says "Redialled in wrap-up once" or "N times". The empty
  state "No calls to this number in the accounts you can see" shows only when the answer has no
  timeline entry of any kind, no live call and no contact; the DNC status shows either way, and
  otherwise the summary, the timeline and Export show (a number with only DNC marks or an untagged
  soft-phone call ringing is not empty). The box, the top-bar panel and the results are
  `ph-no-capture`, so product analytics never record the number, names or loan numbers. A call
  entry opens the existing call page, switching account scope when the call is in another account.
- **Agent app** (`apps/mobile`): the search from the Calls tab with the console's input help
  (country picker starting on the options read's default, +91 while it loads or when it fails; a
  failed read is read again when the search box next opens; helper text, preview, refusals), and
  the page with the console's content: a copy button in the app bar ("Number copied"), the summary
  (contacts with their campaign status, DNC status always, "Not on any do-not-call list" included,
  open items with the follow-up, the truncated-roster note), the filters and the timeline with
  "Load more" (soft-phone call fields, redial chains in the console's words). The channel and
  "Connected calls only" are chips on the page; campaign, from and to days (calendar days on the
  phone, `to` sent as the next midnight), outcome, outcome code and agent are in a "Filters (N)"
  sheet with "Clear filters", which drops values no longer in `filter_options` when it opens and
  refuses a reversed range with the console's words. The empty state follows the console's rule.
  Unlike the console, the empty box and "too short" refusals show only when Search is pressed (a
  phone has no "leaving the field"); the others show as typed. Recent searches (last five) stay on
  the device until Clear or any route to the signed-out state: sign-out, a refused session, or
  start-up with nobody signed in. The app has no tap autocapture (PostHog lifecycle events only,
  no session replay). **Not the same page in two ways:** there is no CSV export (CH13), and
  agents never get a call page (CH8). None of the Dart code has run yet (`docs/mobile.md`, "Not
  verified yet").

## 6. v2: search by a key column (designed, not built)

The request becomes `{ by: 'column', column: 'Loan No', value: 'LN-0042' }`. Roster rows keep
every non-phone column in `agency_contacts.context` (JSONB) and the ingest already knows each
upload's key column (`agency_ingest_jobs.dedupe_column`, migration 0007). A per-campaign scan of
`context->>column` does not serve a tenant-wide search, so v2 adds a key-value index filled at
ingest:

```sql
CREATE TABLE agency_contact_keys (
  tenant_id   UUID NOT NULL,
  account_id  UUID NOT NULL,
  column_key  TEXT NOT NULL,   -- the normalised column name: lower-case, trimmed
  value_norm  TEXT NOT NULL,   -- the normalised value: trimmed, case-folded
  contact_id  UUID NOT NULL REFERENCES agency_contacts(id) ON DELETE CASCADE,
  PRIMARY KEY (tenant_id, column_key, value_norm, contact_id)
);
```

- **Filled at ingest** for the upload's `dedupe_column` (and any column the tenant marks as a
  key in settings), in the same transaction as the contact rows; a backfill job fills existing
  campaigns once.
- **Search**: `(tenant_id, column_key, value_norm)` → contact ids → `account_id = ANY($visible)`
  → their `phone_e164`s → the v1 reads per number, merged. A person with several numbers shows
  one summary with each number's contacts, and the timeline across them.
- **The page** already lists contacts with their own `phone_e164`, and the key echo is
  `{ by, value, display }`, so only the box (a "Search by" picker) changes.
- Audit and rate limit unchanged; `details.value` is the key value.

## 7. Tests

- Number rule: `packages/domain/test/unit/agency/customer-search-number.test.ts` and the Dart
  port's test run the shared table; the server's unit test checks the roster normaliser agrees.
  Hero fields: `packages/domain/test/unit/agency/context-hero.test.ts`.
- Contract: `packages/contracts/test/errors.test.ts` pins the family's error codes and the other
  customer-history literal lists with a hand-written snapshot and a two-way type guard;
  `agent-fixtures.test.ts` holds `fixtures/agent/customer-history.json` (the options answer
  included) to the contract.
- Server: route guards and agent reach (`test/unit/api/agency-route-table.test.ts`,
  `agency-agent-reach.test.ts`, every route of the family including `GET …/customers/options`),
  the family's own unit tests (`test/unit/agency/customer-history/`), and the integration suite on
  real Postgres (`test/integration/api/customer-history.test.ts`): two accounts sharing a number
  (an account-scoped user sees one, a tenant-level user both), campaign DNC marks scoped through
  their campaign, one test per read with a deliberately inconsistent row, every timeline kind in
  one order, keyset paging at microsecond precision, the roster-row cap, the hero and upload-file
  rules, refusals (a search id replayed under another tenant, a malformed body, an unknown
  country), audit rows with their account context, the rate limit and its message, every route
  checking `agency.customer_history.read`, and an `EXPLAIN` of every statement on analysed bulk
  data with nothing disabled.
- Migration: `packages/db/test/integration/db/customer-history-indexes-migration.test.ts`.
- Scale: `apps/server/scripts/bench-customer-history.ts` (§4; opt-in, not a test).

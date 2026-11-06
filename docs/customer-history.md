# Customer history

Search one phone number and see every interaction with it across the tenant's campaigns and the
soft phone, in one place: who the number belongs to in each campaign, its DNC status, open
callbacks and overrides, a call live right now, and one timeline, newest first. Built 2026-11-06
from the ClickUp task "Customer history: search one phone number and see every interaction across
the tenant's campaigns"; Manas's five decisions are CH1–CH5 below, the build's own calls CH6–CH12.

Wire: `packages/contracts/src/api/agency/customer-history.ts`. Number rule:
`packages/domain/src/customer-search-number.ts` (Dart port in `apps/mobile/packages/agency_wire`),
held to one table, `packages/contracts/fixtures/agent/customer-search-numbers.json`. Migration
`0016_customer_history_indexes.sql`. Permission `agency.customer_history.read`.

## 1. Decisions

| ID | Decision | Status |
|---|---|---|
| CH1 | **Everyone can search**: agents, supervisors, account owners, tenant owners. New permission `agency.customer_history.read` floored at `agent`, its own permission so its floor can be raised later without touching the routes. | **Decided** (Manas) |
| CH2 | **Scoped by account, inside the query.** The visible accounts are every account of the tenant (not `deleted`) for a caller with a tenant-level membership (`account_id IS NULL`), else the accounts of the caller's active account memberships in the tenant. Every read binds `account_id = ANY($visible)`; rows of other accounts are left out entirely, never counted as hidden. The caller's role in an account is the higher of their tenant-level role and their role in that account. | **Decided** (Manas) |
| CH3 | **v1 searches by phone only; the API and page allow other keys.** The request is `{ by, value }` with `by: 'phone'`; a key-column search is designed in §6, not built. Nothing in the answer assumes the key is a phone number (each contact row carries its own `phone_e164`). | **Decided** (Manas) |
| CH4 | **Full number only.** A number shorter than the country's national length is refused `invalid_number` / `too_short` ("Enter the full number. Searching by the last few digits isn't supported."). Every read is an exact match on E.164; nothing searches by a number's ending. | **Decided** (Manas) |
| CH5 | **The box explains how to enter a number**: a country picker (default: the platform's `DEFAULT_PHONE_COUNTRY_CODE`, +91), always-visible helper text, a live preview ("We'll search for +91 98765 43210"), and refusals that say what to do. The preview and the server run ONE rule (`parseSearchNumber`), held to one shared test table; the app's Dart port runs the same table. The server's answer is final and echoed ("Results for +91 98765 43210"). | **Decided** (Manas) |
| CH6 | **The number never travels in a URL or a log.** The search is `POST /proxy/agency/customers/search` with the raw text in the body. It answers a `search_id` (`chs_` + 32 hex, 30 minutes, bound to the tenant and the user, held in Redis); the timeline pages and the export name the search by that id. An unknown, expired or other user's id is `404 search_expired`. The console's page is `/agency/customers` (no number in its URL); the last answer is held in memory, and a reload shows the empty search. Request bodies are never logged (Fastify's request log is off; `docs/architecture.md` "Observability"). | Built |
| CH7 | **A retry chain is one row.** Contacts are grouped by `root_contact_id` (a retry copy and its parent are one person in one campaign chain); the campaign filter takes root campaigns and includes their retries. Several roster rows carrying the number in one campaign (a household line) stay separate rows. | Built |
| CH8 | **Visibility follows the screens the caller can already open**, per account: notes, override notes (a campaign dial's, a soft-phone call's DNC and hours overrides) and soft-phone call fields need `agency.campaigns.read` there, or the call is the caller's own (withheld otherwise, with `notes_hidden: true` when any of them existed); the call page (recording, transcript, analysis) needs `agency.supervise` there (`call_page: null` otherwise); who added a DNC entry and why need `agency.dnc.read` (an entry's account, or for a tenant-wide entry the caller's highest role). | Built |
| CH9 | **Every read uses an index.** Contacts by `idx_agency_contacts_phone (tenant_id, phone_e164)`; attempts by `contact_id` (`uq_agency_attempt_number`); soft-phone calls by the new `idx_agency_manual_calls_destination (tenant_id, account_id, destination_e164, created_at DESC, id DESC)` (migration 0016: an untagged call has no contact) and by `idx_agency_manual_calls_contact_history`; DNC by `idx_dnc_entries_tenant_phone`. The integration suite asserts each plan with `EXPLAIN`. | Built |
| CH10 | **Every search and export is audited** (`platform_audit_log`): `agency_customer_history.searched` and `agency_customer_history.exported`, resource type `customer_history`, `resource_id` the search id, `details { by, value (the E.164 searched), result_count (timeline entries visible, unfiltered), accounts (the visible account ids), role (the caller's highest) }` (an export adds `rows`, `filters`, `truncated`). Written on success, zero results included. Not a campaign action, so it is outside the campaign activity filter. | Built |
| CH11 | **Rate limit per user**: `AGENCY_CUSTOMER_SEARCH_PER_MINUTE` (default 30) searches and exports a minute per user, its own bucket (`chs:<user id>`) besides the general per-user one. A 429 carries `retryAfter`; the console and the app say "You've searched a lot of numbers in a short time. Try again in N seconds." | Built |
| CH12 | **What the schema cannot show, and what is shown instead.** (a) A DNC removal is a hard `DELETE` whose audit row deliberately carries no number, so the timeline shows DNC marks (current entries) only, not removals. (b) No column links a contact to its upload; `upload_file_name` is the campaign's non-dry-run import whose run window covers the contact's `created_at`, else null. (c) Roster replace does not remove contacts (B15: there is no supersede), so no row is ever "Removed from roster"; when supersede lands it marks the row and the history keeps it. (d) Callbacks are `callback_at` on the call that booked them; kept / late / missed is judged by the next call placed to the number (§4). (e) The roster ingest keeps a bracketed trunk `0` (`+44 (0)20 7946 0018` is stored `+4402079460018`) where the search and the soft phone drop it, so such a row is not found; pinned `it.fails` in `search-number-agreement.test.ts`. Fixing the ingest changes what existing rosters dedupe on. Every Indian form agrees. | Built; (a) and (e) need Manas |

## 2. API

| Route | Body | Answer |
|---|---|---|
| `POST /proxy/agency/customers/search` | `CustomerSearchRequest { by: 'phone', value, country? }` | `CustomerSearchResponse { search_id, expires_at, key, summary, timeline }` |
| `POST /proxy/agency/customers/timeline` | `CustomerTimelineRequest { search_id, filters?, cursor?, limit? }` | `CustomerTimelinePage { entries, next_cursor }` |
| `POST /proxy/agency/customers/export` | `CustomerExportRequest { search_id, filters? }` | `text/csv` attachment `customer-history-YYYY-MM-DD.csv` (never the number), every entry the filters keep, newest first (cap 10,000 rows; `X-Export-Rows`, and `X-Export-Truncated: true` past the cap) |

Guards, in order: session, tenant context, `agency.customer_history.read`, the dialer flag
(`agency_dialer_enabled` for the request's tenant and account, `403 feature_disabled`), the
per-user search cap (search and export; timeline pages are not charged to it), then the body (`400 invalid_search_request`), then the
number (`400 invalid_number` with `number_error`) or the search id (`404 search_expired`) and the
cursor (`400 invalid_cursor`).

Refusal body: `{ error, code, message, number_error? }` (`CustomerHistoryErrorResponse`). An
unknown, expired, malformed or other user's search id is one answer. Every answer is
`Cache-Control: no-store`.

## 3. The summary

- **contacts**: one row per retry chain (CH7) carrying the number, in the visible accounts:
  the chain's newest campaign and every campaign of the chain, the contact's state there and
  suppressed reason, attempts placed across the chain, the row's hero fields (the campaign's
  `context_display.hero`, else the first four columns of the row's `context`), the owning agent,
  when it entered the roster and the upload file (CH12 b). Newest first.
- **totals**: calls placed (campaign attempts with `dialed_at`, soft-phone calls with
  `dialed_at`), connected (`outcome = 'connected'`), and the last contact: the newest placed call
  with when, by whom, its channel, outcome and code.
- **dnc**: every entry covering the number at any level (tenant; an account the caller can see;
  a campaign of one), with who and why under CH8.
- **open**: callbacks booked and not yet dialled (the contact is waiting on one: its
  `last_disposition` is a callback code of the campaign's catalog and it is not live; due at
  `next_attempt_at`, routed to its owner); overrides granted and not spent (`override_disposition`
  set); live calls (an attempt not `ended`, a soft-phone call not `ended`).
- **filter_options**: root campaigns, agents, outcomes and codes seen in the history.

## 4. The timeline

One list, newest first, ordered `at DESC, key DESC` (`key` is `<kind>:<id>`, unique across
kinds). Kinds:

| Kind | Source | `at` |
|---|---|---|
| `campaign_call` | `agency_call_attempts` of the chains' contacts; wrap-up redials carry `redial_of_attempt_id` and the chain's first attempt (`chain_attempt_id`) | `created_at` |
| `softphone_call` | `agency_manual_calls` to the number (`destination_e164`), tagged or not, plus those linked to the chains' contacts | `created_at` |
| `callback` | a call with `callback_at` (campaign or soft phone) | when booked: `dispositioned_at`, else the call's `ended_at`, else `created_at` |
| `dnc_mark` | `dnc_entries` covering the number | `created_at` |
| `roster_entry` | each contact row (a retry copy included, so the chain's campaigns show) | the row's `created_at` |

**Callback status** (the insights page's 15-minute window): the next call placed to the number
(either channel) after the booking. Placed by `due_at + 15 min` → `kept`; placed later →
`late`; none yet: `upcoming` before `due_at`, `due` within 15 minutes after it, `missed` past
that.

**Recording state**: `no_call` (no media leg: `webrtc_call_id` null), `expired` (the leg was
purged by retention: the `agency_calls` row is gone), `available` (the leg has a
`recording_url`), else `not_recorded`.

**Filters** (`CustomerTimelineFilters`): `campaign_ids` (root campaigns, retries included; under
it, tenant- and account-wide DNC marks and untagged soft-phone calls drop out, and only
campaign-scoped DNC marks of those campaigns stay),
`from` / `to` (half-open, on `at`), and the call-only filters `outcomes`, `disposition_codes`,
`agent_user_ids`, `connected_only`, `channel`; any call-only filter keeps only call entries.

**Paging**: keyset, never offset. `next_cursor` is an opaque base64url of `{ at, key }` with `at`
at microsecond precision (`keysetAtSql`, `packages/domain/src/keyset-cursor.ts`); a page is every
entry strictly after the cursor in the order above, at most `limit` (default 50, at most 100).
Each source is read whole for the one number (every read an exact-match index probe), then merged,
filtered and cut at the cursor in memory: callback status, a redial chain's first attempt and the
summary need rows outside any one page, and one in-memory order serves every filter. Roster rows
are capped at 2,000 per search (`CUSTOMER_HISTORY_MAX_CONTACT_ROWS`, newest first), a guard
against a placeholder number repeated down a roster. Entries' `at` is sent at millisecond
precision; the cursor keeps the microseconds.

## 5. Clients

- **Console**: a "Search a number" box with a country picker in the agency header
  (`AgencyLayout`) and on the agent surfaces, opening the Customer history page
  (`/agency/customers`). The box shows the helper text, the live preview and the refusals; it
  keeps the last five numbers searched on this device (`localStorage`, cleared by "Clear" and on
  sign-out). The page shows the summary, the filters, the timeline with "Load more", and "Export
  CSV". A call entry opens the existing call page, switching account scope when the call is in
  another account.
- **Agent app** (`apps/mobile`): the same search (country picker, helper text, preview, refusals,
  recent searches) from the Calls tab, and the same page; agents never get a call page (CH8).

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
- Server: route guards and agent reach (`test/unit/api/agency-route-table.test.ts`,
  `agency-agent-reach.test.ts`), the family's own unit tests, and the integration suite on real
  Postgres: two accounts sharing a number (an account-scoped user sees one, a tenant-level user
  both), every timeline kind in one order, keyset paging, audit rows, the rate limit, and an
  `EXPLAIN` per read (`test/integration/api/customer-history*.test.ts`).
- Migration: `packages/db/test/integration/db/customer-history-indexes-migration.test.ts`.

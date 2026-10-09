> **Reference copy, verbatim below this box.** Origin: MagickVoice-platform (superproject) @ `e32a5db` (HEAD, 2026-10-05), path `docs/agency-campaign-retry-wire-contract.md`. Copied into Magick Agency on 2026-10-09; not kept in sync.
>
> **How this maps to Magick Agency:** The frozen request/response shapes for retry campaigns. The shapes survive in `packages/contracts/src/agency.ts` and the bounds in `packages/domain/src/retry-campaign-bounds.ts`; the parts about which of core or master owns what are now one process.
>
> Index of all copies: [`docs/reference/README.md`](../../README.md).

# Retry campaigns — the frozen wire contract

Companion to [`agency-campaign-retry-design.md`](agency-campaign-retry-design.md),
which carries the reasoning. **This file is the contract**: three repos implement
against it independently, so anything ambiguous here becomes a defect nobody's
suite catches. Read `../agency.md` §6 before changing a line of it.

Merge order is the platform's standard additive one: **core → master → cusui**.

---

## 1. The selector

One encoding, used identically as a query string (preview) and as a JSON object
(create body). Core parses both through **one** function, `parseRetrySelector`,
built on the existing `multiParam` / `validateEnum` helpers in
`magic-voice-core/src/agency/spine-filters.ts`.

| Key | Form | Vocabulary |
|---|---|---|
| `state` | repeated, comma-joined, or JSON array | `RETRY_SELECTABLE_STATES` — `CONTACT_STATES` **minus `in_flight`** |
| `last_outcome` | same | `ATTEMPT_OUTCOMES` |
| `last_disposition` | same | the **parent campaign's** `disposition_catalog` codes ∪ `BUILT_IN_DISPOSITION_CODES` |
| `suppressed_reason` | same | `max_attempts`, `manual` only |
| `never_attempted` | `true` / `false` (string or boolean) | — |
| `attempt_count_gte` | integer ≥ 0 | — |
| `attempt_count_lte` | integer ≥ 0 | — |

**Algebra: AND across keys, OR within one key.** An absent key constrains
nothing. This is exactly `AgencyContactRepository.listForCampaign`'s existing
behaviour and must be implemented by extending that builder, not by writing a
second one.

Any surface that puts the selector into words owes the reader that algebra:
separate dimensions read as "and", values inside one read as "or". Rendering
everything with "or" describes a strictly wider cohort than the one that will be
seeded, and the supervisor discovers the difference as a matched count that
looks broken.

**Two exclusions are unconditional and are not dimensions.** No selector can
reach either, including a selector that names no state at all:

* `suppressed_reason ∈ {dnc, invalid}` — DR-4, a compliance rule.
* `state = 'in_flight'` — the contact is on a call **right now**.
  `claimDialable` flips the state at dial and `chargeAttempt` writes the outcome
  only at settle, so a first attempt that is ringing has `last_outcome IS NULL`
  and `attempt_count = 0` — satisfying both `__none__` and `never_attempted`,
  neither of which names a state. Seeding it and starting the child dials a
  number the parent has an open call on;
  `uq_agency_campaign_running` does not prevent it, because a paused parent is
  not running and pausing does not cancel attempts already in flight.

### Refusals — all `400` with field-level `details` (so the error mask passes them through untouched)

| Condition | `details` key | Message shape |
|---|---|---|
| No key present at all | `selector` | `name at least one dimension — to retry the whole roster, select every contact state` |
| `suppressed_reason` contains `dnc` or `invalid` | `suppressed_reason` | `dnc and invalid suppressions are never retried — see the campaign's DNC list` |
| `state` contains `in_flight` | `state` | `in_flight contacts are on a call right now and are never seeded into a retry — retry them once their attempt settles` |
| `last_disposition` not in the parent's catalog ∪ built-ins | `last_disposition` | `unknown last_disposition: X — expected one of <catalog>` (echo the catalog, as `allowed_codes` does) |
| Unknown key (`phone`, `from`, `to`, anything else) | the key | `X is not a retry selector dimension` |
| `never_attempted: true` with `attempt_count_gte >= 1` | `never_attempted` | `never_attempted cannot be combined with attempt_count_gte` |
| `attempt_count_gte > attempt_count_lte` | `attempt_count_gte` | `must not exceed attempt_count_lte` |

`phone`, `from` and `to` are deliberately **not** selector dimensions. A phone
filter is a lookup, not a cohort; `created_at` is when the row was *ingested*,
which reads as "dialled between" and is not. cusui strips them before calling.

The three refused **values** — `dnc`, `invalid`, `in_flight` — are all offered
as chips on the Contacts tab, so a supervisor can reach them by ordinary
filtering. cusui strips them as values (keeping the rest of the dimension, and
omitting a dimension the strip empties rather than sending `[]`) and names them
on screen. A dimension core refuses is a `400` on the whole request, so
forwarding one turns a narrowed cohort into a dead preview about a field the
operator did type.

---

## 2. Core routes — `/api/v1/agency-campaigns`

All three register **inside the authenticated scope** (`src/index.ts:560`), like
every other campaign route. Core's auth middleware is per-route-plugin;
forgetting it ships an unauthenticated endpoint that writes a dialable roster.

### `GET /:id/retry/preview`

Query string = §1. Writes nothing.

```jsonc
// 200
{
  "matched": 812,
  "by_last_outcome":     { "no_answer": 500, "busy": 112, "connected": 200 },
  "by_last_disposition": { "voicemail": 180, "callback": 20, "__none__": 612 },
  "excluded": { "dnc": 14, "invalid": 3 },
  "parent_contacts_total": 4000,
  "retry_generation": 1,
  "max_seed_rows": 100000
}
```

`__none__` is the literal bucket key for a NULL `last_disposition` — and for a
NULL `last_outcome` on the other map. It is a **bucket key, not a value any
vocabulary contains**, so no surface may render it raw; every console that shows
either breakdown owes it words ("Never written up", "Never dialed").

`excluded` counts rows the selector matched that DR-4 removed — a supervisor who
selects "everything suppressed" and gets 40 instead of 300 must be told why. The
unconditional `in_flight` exclusion is deliberately **not** counted here: it is
transient rather than a compliance fact, and a row that is ringing right now
will be retryable in seconds.

**`matched` counts distinct `row_fingerprint`s, not rows** — it is a promise
about what the commit will write, and the seeding `INSERT` deduplicates. The
buckets are computed over the same deduplicated set, so they still sum to
`matched`. A plain `COUNT(*)` here breaks the promise in both directions: the
supervisor is shown a number larger than the roster they get, and the create's
own cap refuses a selection that would have fitted (100,040 duplicated rows
refusing a retry that seeds 50,020).

### `POST /:id/retry`

```jsonc
// request
{
  "selector": { "last_outcome": ["no_answer","busy"], "never_attempted": true },
  "name": "Q3 Winback — Retry 1",            // optional; default `<parent> — Retry <n>`
  "config_overrides": { "caller_ids": ["+1..."] },  // optional, any create-route config key
  "agent_user_id": "usr_123",                 // the actor, from master's session
  "actor_name": "Priya S",                    // optional display name, ≤255 chars, truncated
  "idempotency_key": "b3f1c0de-…"             // optional; see below. Minted by the BROWSER.
}

// 201 — this request created the campaign
{ "campaign": { /* full formatAgencyCampaignResponse of the CHILD */ },
  "idempotent_replay": false,
  "contacts_seeded": 812,
  "duplicates_collapsed": 0,
  "excluded": { "dnc": 14, "invalid": 3 } }

// 200 — this key already created a campaign; NOTHING was created now
{ "campaign": { /* the ORIGINAL child, as it stands */ },
  "idempotent_replay": true,
  "contacts_seeded": null,
  "excluded": null }
```

These two are a **discriminated union on `idempotent_replay`**, not two loosely
related shapes, and every consumer must be typed against both. A client that
treats `contacts_seeded` as a `number` throws on the replay — the one path this
whole mechanism exists to make safe.

`duplicates_collapsed` is the number of matched ROWS the fingerprint dedup
merged. Since `matched` already counts distinct fingerprints, this does not
explain a shortfall against the preview — there is none — it explains a roster
shorter than the parent's matching rows, which is what a supervisor sees when
they compare against the Contacts tab. Absent on a replay rather than `0`,
because no seeding statement ran. The seed's
`ON CONFLICT (campaign_id, row_fingerprint) DO NOTHING` exists because a parent
may hold two byte-identical roster rows — the fingerprint index is per-campaign,
so a CSV naming one number twice is legal — and the child collapses them to one;
the COUNT behind `matched` has no such clause. Both numbers come from one
snapshot (the transaction is `REPEATABLE READ`), so it is a real count and never
a race between two reads. It is reported rather than left to be noticed because a
supervisor shown 812 and handed 809 otherwise cannot tell a collapse from rows
lost to a bug, and the difference decides whether they escalate.

#### `idempotency_key` — at-most-once, because the side effect is phone calls

The one place in the agency schema where at-most-once matters more than anything
else the table protects. A request that commits server-side but whose **response
is lost** — a proxy timeout, a pod eviction, a reset connection — leaves the
supervisor looking at an error over a campaign that exists, is fully dialable,
and that **neither service has a delete route for**. The natural next act is to
press the button again, which produced a second complete retry over the same
cohort; start both and every customer in it is dialled twice.
`uq_agency_campaign_running` does not help — it bites at `/start`, for only one
of the two, and only while the other is actually running.

| | |
|---|---|
| Scope | `(tenant_id, account_id, key)` — migration 115's partial unique index |
| Shape | 16–64 chars, `[A-Za-z0-9_.:-]`, trimmed. A 400 with `details.idempotency_key` otherwise |
| Absent | Legal. No replay protection — core's API answers a tenant API key directly, without traversing master, and such a caller must still be able to create a retry |
| Replay | **200** with `idempotent_replay: true` and the ORIGINAL campaign |

Three rules, each of which the implementation depends on:

1. **The browser mints it, once per retry dialog opening, and master forwards it
   verbatim.** A key generated per request — by master, by core, by an
   interceptor — is a different value on the second attempt and protects
   nothing. That is the whole trap, and it is why master must never invent one
   when the field is absent.
2. **A minimum length is enforced**, because a short or constant key is a
   *collision between two supervisors of the same account*, and its failure mode
   is silent — the second is handed the first's campaign and told it is theirs.

   The scope includes `account_id` for the same reason it includes `tenant_id`,
   one level finer. Two accounts under one tenant are two customers' desks;
   without it, a key account A spent answers account B with A's campaign row —
   its name, caller IDs and frozen selector — and denies B a retry of their own.
   Every other agency resource is scoped by tenant **and** account, including
   `uq_agency_campaign_running`, and this is not the place to be the exception.

   The key itself is **never served**. It is an opaque replay token, not a
   campaign field: `formatAgencyCampaignResponse` strips it, so it appears on no
   payload in either service.
3. **`contacts_seeded` and `excluded` are `null` on a replay**, never the child's
   `contacts_total`. They describe what *this* request seeded and excluded, and
   this request seeded nothing; reporting the roster size in a field named
   "seeded" would be a fabricated fact about a transaction that never ran.

A **refusal does not spend the key** — `retry_selection_empty` /
`retry_selection_too_large` roll back before the campaign INSERT, so a supervisor
who widens the selection and presses again gets a campaign rather than a replay
of one that does not exist.

Two layers enforce it, and both are load-bearing: a pre-transaction lookup so the
ordinary retry-after-a-lost-response costs one indexed `SELECT`, and the unique
index itself for the two requests that race past it (the loser's `23505` is
caught **on the constraint name**, never on message text, and answered with the
winner's campaign). The transaction runs `REPEATABLE READ` so the count that
decides `empty`/`too_large` and the `INSERT … SELECT` that seeds see one snapshot
of a parent that may still be dialing.

One transaction: child row, contact seeding, `contacts_total`. A half-seeded
retry campaign looks startable and dials a subset nobody chose.

Child starts `status = 'draft'` (DR-9).

**Config inheritance (DR-10).** Copy from the parent: `caller_ids`,
`telephony_provider`, `sip_connection_id`, `calling_window_start`,
`calling_window_end`, `calling_days`, `default_timezone`, `wrapup_seconds`,
`wrapup_auto_return`, `retry_policy`, `disposition_catalog`, `context_display`,
`break_reasons`, `record_calls`, `analysis_profile_id`,
`abandon_announcement_id`, `abandonment_ceiling_pct`. Then apply
`config_overrides` on top, validated by the **existing** `configRejected` /
`CAMPAIGN_CONFIG_COLUMN_DEFAULTS` path.

**Explicitly NOT copied**, because they describe the parent's run:
`status`, `started_at`, `ended_at`, `completed_at`, `contacts_total`,
`last_transition_by_user_id`, `last_transition_by_name`, `pause_reason`,
`paused_at`, `pause_abandonment_rate_pct`.

#### `409` refusals — these carry only `code`, so master **must** allow-list all three

| `code` | When |
|---|---|
| `retry_selection_empty` | The selector matched zero seedable contacts. Nothing is created. |
| `retry_selection_too_large` | Matched > `RETRY_MAX_SEED_ROWS` (100 000). Message names the count and the cap. |
| `retry_generation_exceeded` | Parent's `retry_generation >= RETRY_MAX_GENERATION` (10). |

Body shape matches the existing lifecycle refusals
(`agency-campaigns.routes.ts:1116-1130`): `{ error, code, message }`.

`retry_selection_empty` exists because without it the supervisor gets a campaign
they cannot start (`/start` would answer `409 campaign_roster_empty`) and there
is no campaign delete route in either service.

### `GET /:id/lineage`

```jsonc
// 200 — the whole chain, root first, ordered by retry_generation then created_at
{ "root_campaign_id": "…",
  "campaigns": [
    { "id":"…","name":"Q3 Winback","status":"completed","retry_generation":0,
      "parent_campaign_id":null,"contacts_total":4000,"created_at":"…",
      "started_at":"…","ended_at":"…" },
    { "id":"…","name":"Q3 Winback — Retry 1","status":"draft","retry_generation":1,
      "parent_campaign_id":"…","contacts_total":812,"created_at":"…",
      "started_at":null,"ended_at":null }
  ] }
```

Tenant/account-scoped like every other campaign read. A campaign that is not part
of any chain answers with itself as the only entry — not a 404.

---

## 3. Campaign payload additions

`formatAgencyCampaignResponse` spreads the row, so these appear automatically
once the columns exist. Master's `AgencyCampaignWire` and cusui's campaign type
must declare them:

```ts
parent_campaign_id: string | null;
root_campaign_id: string | null;
retry_generation: number;        // 0 = not a retry
retry_selector: unknown | null;  // the frozen selector, a record (DR-5)
```

---

## 4. Station bootstrap addition

`AgencySessionBootstrap` (core `src/agency/contracts.ts:236`, mirrored in cusui
`src/types/agency.ts:128`) gains **one optional field**. Absent for every
non-retry campaign, so nothing changes for the 100% case.

```ts
retry_context?: {
  generation: number;             // 1 = first retry
  parent_campaign_name: string;
  /** Built core-side from the frozen selector, so copy and query cannot disagree. */
  selection_summary: string;      // "voicemail, callback, no answer, busy"
};
```

On the bootstrap, **not** the `reserved` frame: it is campaign-constant, and the
`reserved` frame is the one payload whose latency the design guards hardest.

`selection_summary` rendering rules, so all three repos read the same string:
join the selected `last_disposition` labels (from the parent catalog where a
label exists, else the raw code), then the `last_outcome` values rendered with
the console's existing outcome copy, then `never attempted` if set, in that
order, comma-separated. Empty selector cannot occur (§1 refuses it).

---

## 5. Prior attempts — lineage-scoped

`AgencyPriorAttempt` (core `src/agency/contracts.ts:625`) gains three fields.
Additive; an older console ignores them.

```ts
export interface AgencyPriorAttempt {
  attempt_number: number;
  outcome: AgencyAttemptOutcome | null;
  disposition_code: string | null;
  notes: string | null;
  ended_at: string | null;
  // ── new ──
  campaign_id: string;
  campaign_name: string;
  /** ISO-8601, or null if the attempt never dialled. */
  dialed_at: string | null;
}
```

The repository read becomes lineage-scoped and **re-orders**:

```sql
SELECT a.*, c.campaign_id, cam.name AS campaign_name
  FROM agency_call_attempts a
  JOIN agency_contacts  c   ON c.id  = a.contact_id
  JOIN agency_campaigns cam ON cam.id = c.campaign_id
 WHERE c.root_contact_id = $1 AND a.id <> $2
 ORDER BY a.ended_at DESC NULLS LAST, a.attempt_number DESC
 LIMIT 20
```

`ORDER BY` moves off `attempt_number` because it is per-contact and **resets in
every retry campaign** (DR-2) — ordering by it would interleave two passes into
nonsense. `NULLS LAST` keeps a never-ended attempt (reaped, orphaned) at the
bottom.

**Three things must not change**, and each has a test that must still pass
unmodified:

1. The `try/catch` around this read in `agency-dialer.ts:163-177` — history is
   nice-to-have and its absence must never cost the call.
2. The `reserved` frame is written **synchronously, before the dial, with no new
   `await` between the send and `createBridgedCall`**.
3. The `LIMIT 20` cap.

---

## 6. Master

### Routes and permissions

| Route | Permissions |
|---|---|
| `GET /proxy/agency/campaigns/:id/retry/preview` | `agency.supervise` |
| `POST /proxy/agency/campaigns/:id/retry` | `agency.supervise` **and** `proxy.contact_lists.write` |
| `GET /proxy/agency/campaigns/:id/lineage` | `proxy.contact_lists.read` |

Two permissions on the create because the act is *creating a campaign*
(`proxy.contact_lists.write`) **and** *acting on another campaign's call results*
(`agency.supervise`, which `agency.md` §7.1 notes is different in kind, not just
floor). They share a floor today; naming both keeps the route correct if either
moves.

### Master's four obligations on the create

1. **`assertCampaignBehavioralCapabilities`** — as `POST /campaigns` does
   (`proxy-agency-campaigns.routes.ts:578`). This is the subtle one: config is
   inherited from the parent, so a tenant that has since lost `agency.recording`
   or `agency.analytics` would have it re-enabled by a straight copy. Master must
   assert against the **effective merged config** (parent's values as reported by
   `GET /campaigns/:id`, with `config_overrides` applied), not against the
   request body alone — the body may name none of it.

   **An absent key on the parent payload fails CLOSED**, i.e. is read as
   enabling. "Absent means absent" passes the gate, on the argument that a core
   not reporting `record_calls` does not serve `/retry` either — which holds
   only for a core with neither, while the dependency is a core that *does*
   serve it. A slimmer GET DTO, a `{ campaign: … }` wrapper or a dropped column
   and master silently stops asserting while core copies recording off the
   parent row. A tenant holding the capability is unaffected either way; one
   that does not gets a 403 somebody reports rather than a consent gate nobody
   notices stopped running. Membership is `Object.hasOwn`, not `in`.
2. **`validateAgencyCampaignConfig`** on `config_overrides`, so an override
   cannot reach core in a shape `POST /campaigns` would have refused. The
   overrides alone, deliberately: core's copy of the parent's columns is not
   master's to re-litigate, and a parent whose stored config predates a rule must
   stay retryable — the retry dialog offers no affordance to fix it.

   **Exception: the calling-window pair, which is validated on the merged view.**
   `calling_window_start === calling_window_end` is *permanently closed* at core
   (`nextOpenAt` returns null), so the child is saveable and never dials — a
   support ticket whose cause is invisible on every screen. `POST /campaigns`
   cannot produce one, because both sides are in the same body. A retry can:
   `config_overrides: { calling_window_end: "09:00" }` against an `09:00–17:00`
   parent names only one side and the override-only pass has nothing to compare
   it to. That is not re-litigating the parent — the parent's window is valid,
   and the **override** is what makes the merged pair invalid. Merge the two
   window fields (override key-presence wins) and validate that; everything else
   stays override-only. Master's `400` here follows the parent read, which is
   safe: `errorMaskHook` rewrites a status only when a core call returned *that*
   status, and the parent read returned 200.
3. **Actor** — `agent_user_id` from the authenticated session, never from the
   body, exactly as `sessionCreate` does in the S2S fixture. `actor_name` from
   master's user directory, truncated to 255.
3a. **`idempotency_key` forwarded VERBATIM, and never invented.** The opposite
   rule to the actor's, and for the opposite reason: the actor must come from the
   session because the body cannot be trusted to say who is acting, while the key
   must come from the body because only the client holds the intent it
   identifies. A key minted by master is a fresh value on the retry and protects
   nothing — the field is absent when the caller sent none, and that is a legal
   unkeyed create. Master validates nothing about it beyond `string`; core owns
   the shape and answers the 400.

   **Forward on PRESENCE, never on truthiness.** `z.string().optional()` accepts
   `""`, and `""` is falsy — so a truthiness check drops it and core sees a legal
   *unkeyed* create. A client sending an empty key (an empty form field, a
   defaulted string, a retry of a failed parse) then gets no protection at all,
   and pressing the button twice builds a second campaign over the same cohort:
   the exact failure this field exists to prevent, wearing the shape of
   protection. `undefined` is the only absent value.
4. **Activity row** — `agency_campaign.retry_created`.

   > **Correction, made during implementation.** An earlier draft of this section
   > named a constant `AGENCY_ACTIVITY_ACTIONS`. **No such constant exists.**
   > `src/agency/agency-activity-actions.ts` holds two lists with different
   > meanings: `CORE_AGENCY_EVENT_TYPES` (`:108`) is what *core* writes, and
   > `CAMPAIGN_ACTIVITY_ACTIONS` (`:128`) is the console's filter vocabulary.
   > **Master** writes this row, not core, so it belongs in the audit catalog
   > (`src/audit/catalog.ts`) plus `CAMPAIGN_ACTIVITY_ACTIONS` plus
   > `src/audit/vocabulary.ts` — which is exhaustive against the catalog at
   > compile time. Putting it in `CORE_AGENCY_EVENT_TYPES` would assert that core
   > emits it, which is false.

   Filed against the **parent** campaign — an activity row carries one
   `campaign_id`, and the question this row answers ("what happened to Q3
   Winback?") is the parent's. `child_campaign_id` rides in the detail as the
   link across. Core already writes the child's own `agency_campaign.created`.

   `event_data`: `parent_campaign_id`, `child_campaign_id`, `contacts_seeded`,
   `duplicates_collapsed` (only when positive), `selector`.

   **`selector` is bounded before it is written.** It is open, caller-controlled
   and can hold a dumped roster or an arbitrarily long string; the row is written
   on every successful create, must outlive the child, and lives in partitions
   that drop only by age. Bound it the way the export path already bounds its
   filters (`AUDIT_FILTER_VALUE_MAX_CHARS`), marking truncations so a clipped
   list cannot be mistaken for the whole selection. An ordinary selector must
   come through byte-for-byte — the row exists to record the operator's intent.

   **No row on a replay.** Core answers `200` with `idempotent_replay: true`
   when nothing was created; filing a second `retry_created` for one campaign
   would make the audit read assert precisely the thing this feature guarantees
   did not happen.

### Error mask

The three `409` codes go in the **individually-listed campaign-lifecycle block**
of `src/api/middleware/error-mask.middleware.ts` (`:106-160`), beside
`campaign_roster_empty`.

> ⚠️ **Do NOT add them to `AGENCY_ACTION_ERROR_CODES`.** That union is
> attempt-action codes only; it is pinned in four places plus the S2S fixture,
> and widening it there is the three-times-during-this-build failure `agency.md`
> §6.2 records.

### Snapshot

`npm run snapshot:core-agency-codes` must be re-run and the diff landed
(`test/fixtures/core-agency-error-codes.json`). Point it at the local core
branch: `CORE_REF=<core branch> npm run snapshot:core-agency-codes`. The sibling
**freshness** check compares against core's `origin/main` and will red until core
merges — that is the documented core-merges-first sequencing (`agency.md` §6.3),
not a defect to work around.

### Route table

`test/unit/agency/proxy-agency-route-table.test.ts` asserts the exact registered
set **and** that every path cusui calls resolves. Three routes, three additions,
same change.

### No new S2S seam

All three routes are browser → master → core `/proxy/*`. The six seams in
`agency-s2s-contract.fixture.json` are untouched. **Do not edit the fixture.**
Confirm by running both `s2s-contract.test.ts` suites from inside their
submodules with the superproject checked out.

---

## 7. cusui

- `src/types/agency.ts` — the campaign additions (§3), `retry_context` on
  `AgencySessionBootstrap` (§4), the three `AgencyPriorAttempt` fields (§5), and
  an `AgencyRetrySelector` type matching §1.
- `src/api/agencyCampaigns.ts` — `retryPreview`, `createRetry`, `campaignLineage`.
- **Contacts tab** — a `last_disposition` filter (worth having regardless), and a
  **Retry these contacts** action carrying the active filters into the dialog.
  Strip `phone` / `from` / `to` before calling, and say so in the dialog. Strip
  the refused **values** too — `dnc`, `invalid`, `in_flight` — keeping the rest
  of their dimension, and name them with their own sentence: those are contacts
  nobody can ever retry, which is a different fact from a filter that does not
  translate.
- **Retry dialog** — preview count, the outcome/disposition breakdown (with
  `__none__` rendered as words on **both** maps), the DNC and invalid exclusion
  note, editable name, caller-ID and calling-window overrides. An empty caller-ID
  selection blocks confirmation with a stated reason: the override is omitted
  when empty, so sending anyway would silently inherit the parent's numbers while
  the picker shows none. Confirm with the existing `HoldToConfirmButton`, at
  `shortcutScope: 'self'` (a window-scoped `E` would fire from the name field in
  this very dialog) and `confirmation: 'caller'` (an awaited create must never
  time out into "nothing changed", which may be false and cannot be made true —
  there is no delete route). Modal focus lifecycle applies: focus in, Tab
  trapped, focus restored. When the parent is still
  `running`, say up front that the child cannot start until it is paused or
  stopped (`uq_agency_campaign_running`, D9).
- **Campaign header** — a lineage strip on parent and child, each entry a link.
  Header, not an eighth tab: `agencyCampaignTabs.ts`'s own reasoning is that the
  header holds what *changes* the campaign and each tab answers one question.
  Lineage is navigation.
- **Agent console** (`AgentConsolePage.tsx:1433`) — group prior attempts by
  campaign (this campaign first, then ancestors, newest first). Resolve
  disposition labels through the catalog **only for this campaign's group**:
  codes are campaign-local, so an ancestor's code resolved through the child's
  catalog prints this campaign's label as the historical write-up — a plausible
  sentence that is false, on the panel the agent reads to learn what happened
  last time. Ancestors take the raw-code fallback, which is also what a code the
  parent had and the child does not already gets — rendered unlabelled beside the
  campaign name. Do **not** ship the parent's catalog to the agent. Render the
  `retry_context` banner above the contact panel.
- The agent gets lineage and a banner. **Not** the parent's stats, connect rate,
  roster counts or agent roster. `agent` is level 5 with exactly four `agency.*`
  permissions; this feature must not become the reason someone raises it.

---

## 8. Constants, fixed here so three repos agree

```
RETRY_MAX_SEED_ROWS            100000   core; 409 retry_selection_too_large
RETRY_MAX_GENERATION               10   core; 409 retry_generation_exceeded
PRIOR_ATTEMPT_LIMIT                20   core; unchanged, now spans the lineage
RETRY_IDEMPOTENCY_KEY_MIN          16   core; 400 details.idempotency_key
RETRY_IDEMPOTENCY_KEY_MAX          64   core; the column width (migration 115)
```

Default selection offered by the retry dialog when opened from the campaign
header rather than a filtered contacts list: **one dimension**,
`last_outcome ∈ {no_answer, busy, __none__}` — the uncontroversial "we did not
reach them" set. Everything else is opt-in.

> **Correction, made during implementation.** An earlier draft of this line read
> `last_outcome ∈ {no_answer, busy}` **plus** `never_attempted: true`. That
> selector **matches nothing, on every campaign**: the selector algebra ANDs
> across dimensions, and a contact with no attempts has a NULL `last_outcome`, so
> the two conjuncts are mutually exclusive. Shipping it made the dialog's default
> answer `409 retry_selection_empty` and tell the supervisor to widen a selection
> that was already as wide as it goes. "We did not reach them" is a **union**, so
> it is expressed inside ONE dimension via the `__none__` member — the same
> literal §1 already uses as the NULL bucket key. `agency-retry-seeding.test.ts`
> keeps the old spelling as a regression case.

> **Corrections, made during review.** Five rules above were tightened after
> Copilot and Cursor reviewed the three implementation PRs. Each was a real
> defect rather than a wording change, and each is recorded at the point it
> applies:
>
> * **§1** — `in_flight` left the selectable state vocabulary and became an
>   unconditional exclusion. A first attempt that is ringing satisfies both
>   `__none__` and `never_attempted`, so pause-then-retry could seed the numbers
>   the parent still has open calls on.
> * **§1** — the algebra note now binds any surface that renders the selector in
>   words. Joining dimensions with "or" describes a wider cohort than the one
>   that will be seeded.
> * **§2** — `matched` counts distinct `row_fingerprint`s. Counting rows both
>   over-promised the roster and let the cap refuse a selection that would have
>   fitted.
> * **§2** — the idempotency scope gained `account_id`, and the key is never
>   served on any payload. Tenant-only, a key one account spent answered a
>   sibling account with the first account's campaign row.
> * **§6** — obligation 1 fails closed on an absent key, obligation 2 gained the
>   merged calling-window pair, obligation 3a forwards on presence rather than
>   truthiness, and obligation 4's `selector` is bounded before it is written.

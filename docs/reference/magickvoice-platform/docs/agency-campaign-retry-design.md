> **Reference copy, verbatim below this box.** Origin: MagickVoice-platform (superproject) @ `e32a5db` (HEAD, 2026-10-05), path `docs/agency-campaign-retry-design.md`. Copied into Magick Agency on 2026-10-09; not kept in sync.
>
> **How this maps to Magick Agency:** The design behind retry campaigns, companion to the wire contract above. Applies as written to the ported retry code, minus the core/master split.
>
> Index of all copies: [`docs/reference/README.md`](../../README.md).

# Retry campaigns — design proposal

**Status:** approved; implementation in progress across all three submodules on
`claude/campaign-retry-flexible-status-th8erc`. The frozen request/response shapes
live in [`agency-campaign-retry-wire-contract.md`](agency-campaign-retry-wire-contract.md).

**Ask.** A supervisor looking at a finished (or stopped) agency campaign wants to
re-run *part of it* — the contacts that hit voicemail, the ones nobody answered,
the ones an agent wrote up as "call back next week", whatever selection they care
about. The re-run must be a **new campaign**, linked to the one it came from, and
the agent taking those calls must be able to see what happened on the previous
pass.

Read against core `1.92.x` / master `2.x` / cusui `2.49+`, at the submodule
pointers this superproject carries. Citations are `submodule-relative-path:line`.
Companion reading: [`agency.md`](../agency.md) for the domain,
[`service-map.md`](../service-map.md) for transport,
[`agency-dialer-design.md`](agency-dialer-design.md) for D1–D11.

---

## 1. The shape of the thing

```
  Q3 Winback              (original, status=completed, 4,000 contacts)
      │
      │  supervisor selects: last_disposition ∈ {voicemail, callback}
      │                      OR last_outcome ∈ {no_answer, busy}
      │  → preview says 812 contacts
      │
      ▼
  Q3 Winback — Retry 1    (child, status=draft, 812 contacts,
                           parent_campaign_id = Q3 Winback,
                           retry_selector frozen on the row)
      │
      ▼
  agent's screen shows:   "Retry 1 of Q3 Winback — voicemail, callback,
                           no answer, busy"
                          and, per contact, the attempts from the PARENT
                          campaign alongside this campaign's own.
```

A retry campaign is an **ordinary campaign in every respect** — it has its own
roster, its own pacing leader, its own settlement, its own lifecycle. The only
things that make it a retry are three columns and where its contacts came from.
That is the central design commitment, and §3's alternatives are all rejected on
the grounds that they break it.

---

## 2. Decisions

Numbered `DR-n` so they can be cited the way D1–D11 are.

### DR-1 — A retry is a new campaign row, never a mutation of the parent

Rejected: "reset the exhausted contacts on the finished campaign and start it
again." It destroys the record of the first pass (`attempt_count`,
`last_outcome`, `state` are all overwritten), makes per-pass reporting impossible
after the fact, and mixes two passes' attempts under one `campaign_id` — which is
also the billing discriminator (`webrtc_calls.campaign_id`, migration `076:5`), so
the finance view loses the ability to say what the second pass cost.

### DR-2 — Contacts are **copied**, not shared

The child gets its own `agency_contacts` rows, carrying `phone_e164`, `context`
and `timezone` verbatim from the parent's row, with `state='pending'`,
`attempt_count=0`, `our_fault_attempts=0`.

Rejected: a join table letting two campaigns point at one contact row. Every
piece of per-campaign state lives *on* the contact row — `state`,
`attempt_count`, `next_attempt_at`, `last_outcome`, `suppressed_reason` — and the
pacing engine claims contacts with `FOR UPDATE SKIP LOCKED` keyed on
`campaign_id` (`pacing-engine.ts`, `claimDialable`). Sharing a row means two
campaigns' pacing leaders mutating one `state` column, and
`uq_agency_attempt_live (contact_id) WHERE state <> 'ended'` — the *correctness*
half of duplicate-dial protection (`agency.md` §2) — silently becomes a
cross-campaign lock. The copy is not redundancy; it is what keeps every existing
invariant true.

**The attempt counter resets deliberately.** A retry campaign is a fresh
allowance, which is the whole point of the supervisor authoring one. The
regulated ceiling that does *not* reset is discussed in §7.3.

### DR-3 — Selection runs in core, and reuses the contacts-list filter vocabulary

The selectable facts (`state`, `last_outcome`, `last_disposition`,
`suppressed_reason`, `attempt_count`) live only in core's `agency_contacts`.
Master holds no copy and must not grow one.

More importantly: core **already has this filter language**, in
`magic-voice-core/src/agency/spine-filters.ts` — `AgencyContactFilters`
(`:91-98`), the `Record<TUnion, true>` vocabularies at `:49-63`, and the SQL
builder in `AgencyContactRepository.listForCampaign`
(`agency.repository.ts:2438`), which ANDs across dimensions and `= ANY(...)`s
within one. That is exactly the algebra a retry selector needs.

**So the retry selector *is* an `AgencyContactFilters`.** No second filter
language, no second 400-vocabulary, no second parser. The supervisor narrows the
Contacts tab until it shows the rows they mean, presses **Retry these contacts**,
and the query string they were already looking at becomes the selector. This is
the single highest-leverage decision in the proposal: "full flexibility" is
answered by reusing a vocabulary that is already exhaustively pinned against the
type union, rather than by inventing a parallel one that will drift from it.

One field must be added to that vocabulary (§4.2): `last_disposition`, which the
contacts list does not filter on today and which is precisely the "statuses the
supervisor punched in" the ask names.

### DR-4 — `dnc` and `invalid` suppressions are structurally excluded

`suppressed_reason` has four values (`spine-filters.ts:66`): `dnc`, `invalid`,
`max_attempts`, `manual`.

- `dnc` — a customer's recorded request not to be contacted. Not an operator
  choice. Excluded by the query, not by an unchecked checkbox.
- `invalid` — "a bad number does not become good" is the settled rule
  (`retry-policy.ts`, `DEFAULT_RETRY_POLICY.invalid`), and `resolveRetryDecision`
  routes `invalid` to `suppressed` *before* it reads any policy. Seeding those
  numbers into a fresh campaign is exactly the config-circumvention that rule
  exists to prevent.
- `max_attempts` — the ordinary retry target. Selectable.
- `manual` — a supervisor's own suppression. Selectable, but only by explicitly
  naming it; it is not in the default selection.

The pre-dial DNC gate (`pre-dial-gates.ts`) would catch a DNC number at dial time
anyway, so this is not the *only* protection. It is the layer that stops the
platform from writing a roster row that says "we intend to call this person",
which is a different and worse artifact than a call that gets stopped.

**Consequence to state plainly:** the DNC list is checked at dial time, from
Redis, per attempt. A number suppressed *after* the retry roster was seeded is
still refused. The exclusion here is about intent, not enforcement.

### DR-5 — The selector is frozen on the child row

`agency_campaigns.retry_selector JSONB` stores the filter that produced the
roster, as sent. It is a **record**, never re-executed. Re-running it later would
produce a different set (the parent keeps moving if it is resumed) and would make
the child's roster non-reproducible from its own row.

This is the same reasoning as `agency_ingest_jobs.mode` (master migration `057`):
only the operator's intent explains the roster, and core cannot recover it from
the data.

### DR-6 — Contact lineage is a **denormalised root key**, not a recursive walk

Two columns on `agency_contacts`:

- `source_contact_id UUID` — the parent's contact row. Provenance, one hop.
- `root_contact_id UUID NOT NULL` — the first contact row in the chain, stamped
  at insert (`COALESCE(parent.root_contact_id, own id)`).

The agent's prior-attempt lookup then becomes one indexed equality join rather
than a recursive CTE. This matters because that lookup runs **synchronously
inside the dial tick, before the dial** (`agency-dialer.ts:167`, and the ordering
guarantee documented at `:139-150`). The pacing leader evaluates a campaign 4×/s;
a recursive CTE on that path is a latency budget nobody has measured being spent
where the whole design says not to spend it.

`root_contact_id` defaults to the row's own id for every non-retry contact, so
the existing single-campaign case stays exactly one indexed lookup and the query
has no branch. See §4.3 for the trigger that stamps it and §8.1 for the backfill.

**No foreign key on `root_contact_id`.** It is a grouping key, not a reference.
`agency_contacts.campaign_id` is `ON DELETE CASCADE` (migration `073`), so if a
parent campaign is ever deleted its contacts go with it; a FK here would either
cascade that deletion into a live child campaign or block the delete. A dangling
root key simply returns fewer history rows — "the history was deleted" — which is
the honest answer. `source_contact_id` does carry a FK, `ON DELETE SET NULL`, for
the same reason inverted: it is a pointer, and a pointer to a deleted row should
become NULL rather than lie.

### DR-7 — The agent sees lineage, not the parent's analytics

Two additions to what the agent already gets, and nothing else:

1. Per-contact prior attempts extended across the lineage (§5.1). The agent
   already receives `prior_attempts` on every `reserved` frame
   (`contracts.ts:604-628`); this only widens the set that populates it.
2. A one-line campaign banner from the session bootstrap (§5.2).

Not given to the agent: the parent's stats, connect rate, roster counts, or agent
roster. The `agent` role sits at level 5 and holds exactly four `agency.*`
permissions (`magick-master/src/rbac/roles.ts:20-27`, and `agency.md` §7.1). This
feature must not become the reason someone raises it. Every field added here is
either already on a payload the `agent` role receives, or is campaign-descriptive
copy about the campaign they are joined to.

### DR-8 — Preview before commit, and the preview is a separate read

`POST .../retry` creates a campaign and a roster in one transaction. A supervisor
must be able to see the count first. `GET .../retry/preview` answers "this
selector matches N contacts, broken down by `last_outcome` and
`last_disposition`" and writes nothing.

The two must share one selector parser and one predicate builder, or the preview
will eventually promise a count the commit does not deliver — the same class of
defect the `ABANDONED_ATTEMPT_PREDICATE_SQL` single-definition rule
(`abandonment-predicate.ts:44`) exists to prevent.

### DR-9 — The child starts in `draft`

Not `running`. Creation and starting stay separate verbs, so the supervisor can
review the roster, adjust caller IDs or the calling window, and press Start
deliberately. It also side-steps `uq_agency_campaign_running` (§7.1) at creation
time rather than making creation fail for a reason that has nothing to do with
the retry.

### DR-10 — Config is copied from the parent, then patched

The child inherits every config column from the parent — caller IDs, provider,
calling window and days, timezone, wrap-up, retry policy, disposition catalog,
context display, break reasons, recording, analysis profile, abandonment ceiling
— because "the same campaign again, for a subset" is the request. The create body
may override any of them with the same validated shape the create route already
accepts (`campaign-config.ts`, master's `agency-campaign-config.ts`).

`name` defaults to `<parent name> — Retry <n>` and is overridable. Nothing else
defaults differently.

---

## 3. Rejected alternatives, briefly

| Alternative | Why not |
|---|---|
| Reset contacts on the finished campaign and restart it | DR-1. Destroys the first pass and merges two passes' billing. |
| Export the selection to CSV, re-upload through the existing ingest | Works today, and is the honest fallback if this ships late — but it loses `context` fidelity through a CSV round-trip, loses lineage entirely (the agent sees no history), and requires the operator to hand-build the selection. It is the workaround, not the feature. |
| A `retry_of` tag with contacts shared between campaigns | DR-2. Breaks `uq_agency_attempt_live` and the `SKIP LOCKED` claim. |
| Let the retry campaign dial while the parent still runs | Blocked by `uq_agency_campaign_running (tenant_id, account_id) WHERE status='running'` (migration `072:77`, D9). Lifting that index is a separate decision with its own concurrency consequences — see §7.1. |
| Seed the roster from master by reading core's contacts list and POSTing chunks | Reuses the ingest path, but turns one transaction into N HTTP round trips with partial-failure states, and re-derives in master a set core can compute in one statement. The ingest chunk protocol exists because a CSV arrives at master; nothing here arrives at master. |
| Recursive-CTE lineage walk instead of `root_contact_id` | DR-6. It is on the dial hot path. |

---

## 4. Schema and core implementation

### 4.1 Migrations

Following the house convention that a lock-taking `ALTER` and a row-touching
backfill go in **separate files** (migrations `108`/`109`, and their headers'
reasoning about `ACCESS EXCLUSIVE` on `agency_campaigns` queueing the pacing
tick):

**`111_agency_campaign_retry_lineage.sql`** — catalog-only, no rewrite:

```sql
ALTER TABLE agency_campaigns
  ADD COLUMN IF NOT EXISTS parent_campaign_id UUID REFERENCES agency_campaigns(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS root_campaign_id   UUID,
  ADD COLUMN IF NOT EXISTS retry_generation   SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS retry_selector     JSONB;

CREATE INDEX IF NOT EXISTS idx_agency_campaigns_parent
  ON agency_campaigns (parent_campaign_id) WHERE parent_campaign_id IS NOT NULL;
```

`retry_generation = 0` means "not a retry" and is the default, so every existing
row is correct without being touched. A retry of a retry is generation 2 —
supported, and §7.5 says what bounds it.

`root_campaign_id` is the same denormalisation as `root_contact_id`, one level
up: it makes "show me every pass of this campaign" one indexed read instead of a
walk, which is what the supervisor's lineage strip (§6.2) needs.

**`112_agency_contacts_lineage.sql`** — the contact columns, the trigger, and the
index:

```sql
ALTER TABLE agency_contacts
  ADD COLUMN IF NOT EXISTS source_contact_id UUID REFERENCES agency_contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS root_contact_id   UUID;

CREATE OR REPLACE FUNCTION agency_contact_stamp_root() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.root_contact_id IS NULL THEN
    NEW.root_contact_id := NEW.id;   -- id is already assigned by the column DEFAULT
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_agency_contacts_root
  BEFORE INSERT ON agency_contacts
  FOR EACH ROW EXECUTE FUNCTION agency_contact_stamp_root();
```

A trigger rather than an expression default, because `root_contact_id` cannot
reference `id` in a column `DEFAULT`. The house already stamps a derived column
this way (`agency_contact_row_fingerprint`, migration `083`).

The seeding statement sets `root_contact_id` explicitly from the parent, so the
trigger only fires for ordinary ingest rows.

**`113_agency_contacts_lineage_backfill.sql`** — separate file, separate
transaction, `ROW EXCLUSIVE` only:

```sql
UPDATE agency_contacts SET root_contact_id = id WHERE root_contact_id IS NULL;
```

Re-run matches zero rows, so `trg_agency_contacts_updated_at` cannot restamp the
table on every container start — the same idempotency rule migration `109`'s
header states.

**`114_agency_contacts_root_index.sql`** — the index the dial path needs, created
after the backfill so it is built once over populated data:

```sql
CREATE INDEX IF NOT EXISTS idx_agency_contacts_root
  ON agency_contacts (root_contact_id);
```

> ⚠️ On a live database this wants `CREATE INDEX CONCURRENTLY`, which **cannot run
> inside a transaction** and therefore cannot be a plain `.sql` migration in this
> repo's runner. Options: accept the brief `SHARE` lock (the table is small today
> — kilobytes, per migration `109`'s own note), or ship it as a JS migration with
> `pgm.noTransaction()`. Flagged rather than decided; it depends on the roster
> size at deploy time, which is a fact about production, not about this design.

Whether `root_contact_id` should end up `NOT NULL` is deliberately deferred to a
follow-up migration once the backfill has run everywhere — the same
keep-it-nullable-then-tighten shape `085` used.

### 4.2 The one filter-vocabulary addition

`AgencyContactFilters` (`spine-filters.ts:91`) gains:

```ts
lastDispositions?: string[];
```

and `listForCampaign` gains the matching clause beside its siblings:

```sql
c.last_disposition = ANY($n::varchar[])
```

**Not** a `Record<TUnion, true>` vocabulary, because disposition codes are
operator-authored per campaign (`agency_campaigns.disposition_catalog`), not a
closed union. Validation is therefore *membership in the parent campaign's
catalog ∪ `BUILT_IN_DISPOSITION_CODES`* (`disposition-policy.ts:71`, `:97`) — and
the 400 must echo the campaign's catalog, exactly as
`AgencyActionErrorResponse.allowed_codes` does for a stale console
(`agency-action-errors.ts:11-18`).

This field is worth having on the contacts list regardless of retry campaigns —
"show me everyone marked voicemail" is a question the supervisor console cannot
answer today.

**Two additions to the selector that are not contact filters:**

- `never_attempted: true` → `attempt_count = 0`. A campaign stopped mid-run
  leaves `pending` contacts nobody dialled; retrying *those* is the single most
  obvious case and no combination of the existing dimensions expresses it.
- `attempt_count_lte` / `attempt_count_gte` — "the ones we only tried once".

Both go through the same parser and are recorded in `retry_selector`.

### 4.3 Seeding, in one statement

```sql
INSERT INTO agency_contacts
  (campaign_id, tenant_id, account_id, phone_e164, context, timezone,
   csv_line_number, row_fingerprint, source_contact_id, root_contact_id)
SELECT $newCampaignId, $tenantId, $accountId,
       c.phone_e164, c.context, c.timezone, c.csv_line_number,
       agency_contact_row_fingerprint(c.phone_e164, c.context, c.timezone),
       c.id,
       c.root_contact_id
  FROM agency_contacts c
 WHERE c.campaign_id = $parentId
   AND NOT (c.suppressed_reason = ANY ('{dnc,invalid}'))   -- DR-4, unconditional
   AND <selector predicates, built by the SHARED builder>
ON CONFLICT (campaign_id, row_fingerprint) WHERE row_fingerprint IS NOT NULL
  DO NOTHING;
```

Notes that matter:

- **`state`, `attempt_count`, `our_fault_attempts`, `next_attempt_at`,
  `last_outcome`, `last_disposition`, `suppressed_reason` are all omitted** and
  take their column defaults — `pending`, `0`, `0`, `now()`, NULL. DR-2.
- **The fingerprint is recomputed by the same SQL function** the ingest path uses
  (`applyIngestChunk`, `agency.repository.ts:2521`), so "the same roster row"
  has one definition across both seeding paths. `ON CONFLICT DO NOTHING` on the
  named index handles a parent that legitimately holds two byte-identical rows
  (possible: the fingerprint index is per-campaign and a top-up file could have
  landed one).
- `csv_line_number` is carried through as provenance. It is unindexed
  (migration `085`) and cannot reinstate the collision `085`'s header warns about.
- `source_row_number` is **not** written, for exactly the reason `085` gives.
- The whole insert plus the campaign row plus `contacts_total` is **one
  transaction**. A half-seeded retry campaign is the worst outcome available: it
  looks startable and dials a subset nobody chose.

Roster size: the same `MAX_EXPORT_ROWS`-class question the ingest path faced. A
single `INSERT … SELECT` of 500k rows in one transaction is fine for Postgres but
holds a long transaction; if parent rosters routinely exceed ~100k a chunked
variant with an idempotency marker (the `agency_ingest_chunks` shape) is the
follow-up. Not designed here — flagged in §9 as an open question, because the
answer is a production fact.

### 4.4 Refuse an empty selection **at creation**

If the selector matches zero contacts, `POST .../retry` returns `409` with a new
code `retry_selection_empty` and creates nothing.

Without this the supervisor gets a campaign they cannot start: `POST /:id/start`
would answer `409 campaign_roster_empty` (`agency-campaigns.routes.ts:1116-1130`)
and they would be holding a draft campaign that exists only to be deleted — and
there is no campaign delete route in either service today. The refusal has to
happen at the moment a human is present to be told, which is the same argument
`rosterRejected`'s own docstring makes.

---

## 5. The agent's screen

### 5.1 Prior attempts across the lineage

`AgencyAttemptRepository.findPriorForContact` (`agency.repository.ts:3341`)
currently reads:

```sql
SELECT * FROM agency_call_attempts
 WHERE contact_id = $1 AND id <> $2
 ORDER BY attempt_number DESC LIMIT 20
```

It becomes a lineage read:

```sql
SELECT a.*, c.campaign_id, cam.name AS campaign_name
  FROM agency_call_attempts a
  JOIN agency_contacts   c   ON c.id = a.contact_id
  JOIN agency_campaigns  cam ON cam.id = c.campaign_id
 WHERE c.root_contact_id = $rootContactId
   AND a.id <> $excludeAttemptId
 ORDER BY a.ended_at DESC NULLS LAST, a.attempt_number DESC
 LIMIT 20
```

Three things changed and each is load-bearing:

- **`ORDER BY` moves from `attempt_number` to `ended_at`.** `attempt_number` is
  per-contact and resets in each retry campaign (DR-2), so ordering by it would
  interleave two passes into nonsense. `NULLS LAST` keeps a never-ended attempt
  (reaped, orphaned) at the bottom rather than at the top.
- **`campaign_id`/`campaign_name` join the row**, because "attempt 2" means
  nothing to an agent once attempts come from two campaigns.
- **The `LIMIT 20` cap stays**, and now spans the lineage. A contact retried
  three times shows its most recent 20 attempts, newest first.

`AgencyPriorAttempt` (`contracts.ts:625`) gains three fields — all additive,
all optional-safe for an older console:

```ts
campaign_id: string;
campaign_name: string;
/** ISO-8601. Needed because attempt_number is no longer a global ordering. */
dialed_at: string | null;
```

The `catch` around this lookup (`agency-dialer.ts:163-177`) must stay exactly as
it is: **history is nice-to-have and its absence must never cost the call.** A
lineage query is a slightly bigger thing to fail, which makes that guard more
important, not less.

**cusui**: `AgentConsolePage.tsx:1433-1451` renders a flat "Prior attempts (n)"
list. It becomes grouped — this campaign's attempts, then a labelled group per
ancestor campaign — with the outcome and the note it already shows. The existing
`resolveDispositionLabel(prior.disposition_code, bootstrap)` call has a subtlety
worth catching now: it resolves against **this** campaign's catalog, so a
disposition code the parent had and the child does not will render unlabelled.
Fix by falling back to the raw code with the campaign name beside it, rather than
by shipping the parent's catalog to the agent.

### 5.2 The campaign banner

`AgencySessionBootstrap` (core `contracts.ts:236`, mirrored in cusui
`src/types/agency.ts:128`) gains one optional object:

```ts
retry_context?: {
  generation: number;              // 1 = first retry
  parent_campaign_name: string;
  /** Human-readable rendering of retry_selector, built core-side. */
  selection_summary: string;       // "voicemail, callback, no answer"
};
```

Absent on an ordinary campaign, so nothing changes for the 100% of campaigns that
are not retries. The console renders one line above the contact panel:

> **Retry 1 of "Q3 Winback"** — these contacts were previously voicemail,
> callback, no answer

Why the bootstrap and not the `reserved` frame: it is campaign-constant. Putting
it on every `reserved` frame repeats it once per dial for the whole shift, on the
one frame whose latency the design is most careful about (`contracts.ts`, `AgencyStationReservedFrame`'s docstring).

`selection_summary` is built in core, from the frozen `retry_selector`, so the
copy the agent reads and the query that built the roster cannot disagree. It is
the campaign's own fact, exactly as migration `108`'s header argues for the
lifecycle columns.

### 5.3 What deliberately does not change

The `reserved` frame's ordering guarantee. Everything in §5.1 is gathered in the
same place, before the same synchronous send, with no new `await` between the
send and the dial. If the lineage read is slow enough to matter, the answer is
the index in §4.1 or dropping the join — never moving the send.

---

## 6. API surface

### 6.1 Core

| Route | Notes |
|---|---|
| `GET  /api/v1/agency-campaigns/:id/retry/preview` | Query string = the selector. Returns `{ matched: n, by_last_outcome: {...}, by_last_disposition: {...}, excluded: { dnc: n, invalid: n } }`. Writes nothing. |
| `POST /api/v1/agency-campaigns/:id/retry` | Body: `{ selector, name?, config_overrides?, actor }`. Returns `201` with the new campaign row + `contacts_seeded`. One transaction. |
| `GET  /api/v1/agency-campaigns/:id/lineage` | The chain: root, every generation, each with status/contact counts. Serves the supervisor strip (§6.2). |

`excluded` on the preview is not decoration. A supervisor who selects "everything
suppressed" and gets 40 instead of 300 needs to be told the other 260 were DNC
and invalid, or they will report it as a bug.

Registered inside the authenticated scope in `src/index.ts:560`, like every
other campaign route. Core's auth middleware is per-route-plugin, and forgetting
it ships an unauthenticated endpoint that writes a dialable roster — the exact
trap `agency-internal-auth.test.ts` exists for (`agency.md` §5).

### 6.2 Master

| Route | Permission |
|---|---|
| `GET  /proxy/agency/campaigns/:id/retry/preview` | `agency.supervise` |
| `POST /proxy/agency/campaigns/:id/retry` | `agency.supervise` **and** `proxy.contact_lists.write` |
| `GET  /proxy/agency/campaigns/:id/lineage` | `proxy.contact_lists.read` |

Two permissions on the create, not one, and it is not belt-and-braces: the act is
*creating a campaign* (`proxy.contact_lists.write` = `account_admin`,
`roles.ts:110`) **and** *acting on another campaign's call results*
(`agency.supervise` = `account_admin`, which `agency.md` §7.1 notes is different
in kind, not just floor). They happen to share a floor today; naming both is what
keeps the route correct if either moves.

Master must also:

- run `assertCampaignBehavioralCapabilities` on the create, as
  `POST /campaigns` does (`proxy-agency-campaigns.routes.ts:578`) — a retry must
  not inherit `record_calls` or an analysis profile into a tenant whose
  `agency.recording` / `agency.analytics` capability has since been revoked
  (`magick-master/src/governance/catalog.ts:126-127`). **This is the subtle one:**
  config is copied from the parent (DR-10), so a capability that was on when the
  parent was authored can be off now, and a straight copy would re-enable it.
- validate `config_overrides` through the existing
  `validateAgencyCampaignConfig`, so an override cannot reach core in a shape the
  create route would have refused.
- write the activity row. `AGENCY_ACTIVITY_ACTIONS`
  (`agency-activity-actions.ts:109-137`) gains `agency_campaign.retry_created`,
  with `event_data` carrying `parent_campaign_id`, `contacts_seeded` and the
  selector. Same `{ value, label, group: 'Campaign' }` shape as its neighbours.

### 6.3 cusui

- **Contacts tab** (`AgencyCampaignContactsPage.tsx`) grows a `last_disposition`
  filter and a **Retry these contacts** action that carries the active filters
  into the retry dialog. This is where the feature is discovered — the supervisor
  is already looking at the set.
- **Retry dialog**: preview count with the outcome/disposition breakdown, the
  DNC/invalid exclusion note, editable name, and the config-override affordances
  that matter (caller IDs, calling window). Confirms with a
  `HoldToConfirmButton` — the component already exists
  (`src/components/agency/HoldToConfirmButton.tsx`) and is used for the other
  irreversible campaign actions.
- **Campaign header**: a lineage strip on both parent and child — "Retry 1 of Q3
  Winback" on the child, "2 retries" on the parent, each a link. Belongs in the
  header rather than as an eighth tab; `agencyCampaignTabs.ts`'s own header
  reasoning is that the header holds things that *change* the campaign and the
  tabs answer one question each. Lineage is navigation, not a question.
- **Agent console**: §5.1 and §5.2.

---

## 7. Where this collides with existing machinery

Every item here is a real interaction found by reading the code, not a
hypothetical.

### 7.1 One running campaign per account (D9)

`uq_agency_campaign_running (tenant_id, account_id) WHERE status='running'`
(migration `072:77`). A retry campaign **cannot dial while its parent is
running**. `POST /:id/start` on it answers `409 another_campaign_running`, which
master already allow-lists (`error-mask.middleware.ts:106-160`) — so the message
survives the mask and the supervisor is told to pause the other one.

This is correct behaviour, and it is also the most likely support ticket this
feature generates. The retry dialog should say it up front when the parent is
still `running`. Lifting the index is a separate decision: `agency.md` §2 notes
it is trivially lifted, but the account's `max_concurrent_calls` is shared, so
two live campaigns split one ceiling and the pacing engine's `to_dial`
computation (`pacing-engine.ts:436-440`) has no notion of fair-sharing between
them. Out of scope here.

### 7.2 DNC

Covered by DR-4 for seeding. At dial time the retry campaign is an ordinary
campaign and goes through `pre-dial-gates.ts` unchanged. Nothing to build.

One thing to *not* build: do not copy the parent's DNC state onto the child's
contacts. DNC is tenant-scoped and enforced from Redis at dial time; a copied
snapshot would be a second, stale source of truth for a compliance fact.

### 7.3 The our-fault redial bound

`agency_contacts.our_fault_attempts` resets to 0 on the copy (DR-2), and
`OUR_FAULT_REDIAL_BOUND = 3` (`retry-policy.ts:125`) is per-contact-row.

**So a retry campaign does reset the our-fault allowance**, and that constant's
own docstring says a limit an operator can raise is not a limit. This is worth
being honest about rather than quietly shipping:

- The bound exists to stop *one broken agent workstation* redialling one number
  without limit inside a single run. A supervisor deliberately authoring a second
  campaign is not that failure mode.
- But it is now technically reachable: three retry campaigns is nine our-fault
  redials on one number.

Recommendation: leave the per-campaign bound as-is and add the lineage-scoped
count to the *audit* surface, so it is visible and can be capped later against a
real regulation. That constant's docstring explicitly asks for the actual rule to
be established before a pilot dials real customers; this feature makes that ask
more urgent, and pretending otherwise in code would be worse than recording it
here. **Flagged for the compliance decision, not decided by this design.**

### 7.4 `attempts_retried` is already taken

`agency_campaigns` stats already serve `attempts_retried`
(`agency.repository.ts:850`), meaning *within-campaign* redials of a contact.
It has nothing to do with a retry campaign. Do not reuse the word: the new
fields are `retry_generation`, `parent_campaign_id`, `contacts_seeded`. A stats
panel that shows both needs distinct labels ("redials" vs "retry campaign").

### 7.5 Retry-of-a-retry

Supported, and `retry_generation` counts it. Two bounds worth having:

- A `retry_generation` ceiling (suggest 10) refused at the route, so a scripted
  loop cannot build an unbounded chain.
- The `LIMIT 20` on the lineage prior-attempts read is already the display bound.

The `root_campaign_id` / `root_contact_id` denormalisation is what keeps a deep
chain cheap to read; that is the reason it is worth two columns.

### 7.6 Billing

Nothing to do. Settlement keys on `campaign_id`'s presence on the webhook
(`agencySettlement` in the S2S fixture, `agency.md` §6.1), and a retry campaign
has a `campaign_id` like any other. Each pass bills separately, which is what
DR-1 preserves and what the finance view wants.

### 7.7 The abandonment ceiling

Copied from the parent with the rest of the config (DR-10). `pause_reason`,
`paused_at` and `pause_abandonment_rate_pct` (migration `089`) are **not**
copied — they describe a pause that happened to the parent. Explicit exclusion,
because "copy the config columns" applied naively would carry a stale auto-pause
record onto a campaign that has never dialled.

Likewise not copied: `status`, `started_at`, `ended_at`, `completed_at`,
`contacts_total`, `last_transition_by_*`.

---

## 8. Cross-repo contract impact

Read `agency.md` §6 before touching any of this. The pins here:

| Pin | Change |
|---|---|
| `agency-s2s-contract.fixture.json` | **No new seam.** All three routes are browser → master → core `/proxy/*` reads and writes, not S2S. The fixture's six seams are untouched. Confirm rather than assume by running both `s2s-contract.test.ts` suites *from inside this superproject* (`agency.md` §6.1). |
| Error-code union (16 members, 4 places) | `retry_selection_empty` is a **campaign-lifecycle code**, not a member of `AgencyActionErrorCode` — it is not an attempt action. It goes in `error-mask.middleware.ts`'s individually-listed lifecycle block (`:106-160`), beside `campaign_roster_empty`. **Do not add it to `AGENCY_ACTION_ERROR_CODES`.** Getting this wrong in the other direction is the three-times-during-this-build failure the fixture records. |
| Master's core-error snapshot | `magick-master/test/fixtures/core-agency-error-codes.json` must be regenerated (`npm run snapshot:core-agency-codes`) — core adding a code shows up as a diff in a master PR (`agency.md` §6.3). |
| Proxy route table test | `magick-master/test/unit/agency/proxy-agency-route-table.test.ts` asserts the exact registered set *and* that every path cusui calls resolves. Three new routes, three additions, in the same change. |
| Retry-policy outcome keys | Untouched. The retry *selector* is a different vocabulary from the retry *policy* and must not be conflated — the selector names `last_outcome` values including `invalid` (to exclude it); the policy refuses `invalid` as a key (MAG-103). |
| Governance capabilities | No new key. Gated by `agency`, plus the behavioral assertions in §6.2. |
| RBAC | No new permission. §6.2 composes two existing ones. |

**Merge order** is the standard additive one: core → master → cusui.

---

## 9. Delivery slices

Each slice is independently shippable and leaves the platform working.

**S1 — core: lineage columns + the seeding statement.** Migrations `111`–`114`,
`retryFromCampaign()` on the repository, `POST /retry` and
`GET /retry/preview`, the shared selector parser/predicate builder,
`retry_selection_empty`. Tests: the DNC/invalid exclusion is unconditional; a
zero-match selector creates nothing; the transaction is all-or-nothing; the
fingerprint dedupe holds; `root_contact_id` chains correctly to generation 3.

**S2 — core: `last_disposition` filter + lineage prior attempts.** The
`AgencyContactFilters` addition (useful on its own), then
`findPriorForContactLineage`, `AgencyPriorAttempt`'s three fields,
`retry_context` on the bootstrap. Tests: ordering by `ended_at` across two
campaigns; the `catch` still sends the panel when the lineage read throws; the
`reserved` frame is still written before the dial with no interleaved await
(the existing synchronous-answer test must still pass unmodified).

**S3 — master: proxy, permissions, capability assertion, activity.** Three
routes, both permissions on the create, `assertCampaignBehavioralCapabilities`,
`agency_campaign.retry_created`, error-mask entry, snapshot regeneration, route
table test.

**S4 — cusui: supervisor.** `last_disposition` filter, Retry action on the
contacts tab, the retry dialog with preview + exclusion note, lineage strip in
the campaign header.

**S5 — cusui: agent.** Grouped prior attempts with campaign labels, the
`retry_context` banner, the disposition-label fallback for codes the child's
catalog lacks.

S1+S2 can land together in one core PR; the cross-repo change is S3 before S4/S5.

### Tests that pin the decisions, not the implementation

- Selecting `suppressed_reason: ['dnc']` explicitly still seeds zero DNC
  contacts, and the preview reports them under `excluded`. (DR-4 is not an
  unchecked box.)
- A retry campaign's contact has `attempt_count = 0` and
  `our_fault_attempts = 0`. (DR-2, and it is what §7.3 flags.)
- `retry_selector` on the child is byte-equal to the request's selector after a
  parent contact changes state. (DR-5 — the selector is a record, not a query.)
- The agent console renders a parent-campaign disposition code it has no label
  for, without crashing and without leaking the parent's catalog. (§5.1.)
- `POST /retry` on a parent whose tenant has since lost `agency.recording`
  produces a child with `record_calls = false`. (§6.2, the capability-copy trap.)

---

## 10. Decisions taken on the open questions

Settled before implementation began; the frozen values live in
[`agency-campaign-retry-wire-contract.md`](agency-campaign-retry-wire-contract.md)
§8 so all three repos read them from one place.

1. **Roster size** — a single-transaction `INSERT … SELECT`, with a hard cap of
   `RETRY_MAX_SEED_ROWS = 100_000` refused as `409 retry_selection_too_large`
   naming the count and the cap. Chunking with idempotency markers is a real
   follow-up if a tenant ever needs it, but shipping an unbounded transaction and
   discovering the bound in production is the failure mode worth avoiding; an
   explicit refusal is honest and cheap. (§4.3.)
2. **`CREATE INDEX CONCURRENTLY`** — plain `CREATE INDEX`. This repo's runner
   wraps every `.sql` migration in one transaction, which `CONCURRENTLY` cannot
   run inside, and the tables are kilobytes today (migration `109`'s own note).
   Recorded in the migration header so a large-roster deployment revisits it
   rather than inheriting it silently. (§4.1.)
3. **The our-fault bound across a lineage** — stays per-campaign, and the lineage
   is made *visible* rather than capped. Capping it would be inventing a
   regulatory number on top of one whose docstring already admits nobody
   established it (`retry-policy.ts:125`). Two invented numbers are worse than
   one; the honest move is to surface the lineage so the real rule can be applied
   when someone establishes it. Still flagged for the compliance decision. (§7.3.)
4. **Default selection** — `last_outcome ∈ {no_answer, busy}` plus
   `never_attempted`, everything else opt-in. As proposed.
5. **Retry-of-retry ceiling** — `RETRY_MAX_GENERATION = 10`. High enough that no
   legitimate operator meets it, low enough that a scripted loop cannot build an
   unbounded chain. (§7.5.)
6. **Startable while the parent runs** — no, and that is accepted rather than
   worked around. `uq_agency_campaign_running` stays; the refusal already
   surfaces as `409 another_campaign_running` with its message intact through the
   error mask, and the retry dialog says so up front when the parent is still
   running. Lifting the index is a separate decision about sharing one account's
   `max_concurrent_calls` between two live campaigns, which the pacing engine has
   no notion of today. (§7.1.)

Two of these were corrected during implementation, and both corrections are
recorded where they were made rather than silently applied:

- **Decision 4's default selection cannot match a contact.** The selector algebra
  ANDs across dimensions and a contact with no attempts has a NULL
  `last_outcome`, so `{no_answer, busy}` **plus** `never_attempted` is the empty
  set on every campaign — the dialog's default answered `409
  retry_selection_empty` and told the supervisor to widen a selection that was
  already as wide as it goes. "We did not reach them" is a UNION and is now one
  dimension: `last_outcome ∈ {no_answer, busy, __none__}`. (Wire contract §8.)
- **The create is at-most-once.** Not in the original design at all, and the gap
  is the sharpest one here: `POST /:id/retry` commits a campaign and a dialable
  roster in one transaction and there is **no campaign delete route in either
  service**, so a lost response leaves a supervisor pressing the button again
  over a campaign that already exists. A browser-minted `idempotency_key`, unique
  per `(tenant, key)` (migration 115), makes the second press a replay rather
  than a second cohort of real customers dialled twice. (Wire contract §2.)

An additional decision taken while freezing the contract: **`phone`, `from` and
`to` are not retry-selector dimensions.** A phone filter is a lookup, not a
cohort, and `agency_contacts.created_at` is when the row was *ingested* — which
reads as "dialled between" and is not. Both are refused with a field-level 400,
and cusui strips them before calling. (Wire contract §1.)

## 11. Deploy window — read before `migrate:up` on a large deployment

Migrations 111–115 run in `docker/entrypoint.sh` **before the app boots**, so a
slow one is a deploy that stalls with zero logs and zero metrics (the
`service-down-after-deploy` skill's first symptom). Four of the five are catalog
writes measured in microseconds. Two are not, and both touch `agency_contacts` —
the one agency table sized for a million rows per campaign, and the table the
dial path reads and writes on every claim:

| | What it does | Lock, and who waits |
|---|---|---|
| **113** | `UPDATE agency_contacts SET root_contact_id = id WHERE root_contact_id IS NULL` — full-table on first run | Row locks on every row, one transaction. `claimDialable`'s `UPDATE`, `unclaim`, `markState` and the roster ingest all queue behind it |
| **114** | `CREATE INDEX idx_agency_contacts_root` — **not** `CONCURRENTLY`, which this repo's `.sql` runner cannot express (one unconditional transaction per file) | `SHARE` on `agency_contacts` for the whole build: readers proceed, **every writer waits** |

On a pilot roster both are microseconds and there is nothing to plan. The
relationship is not linear in a way anyone should extrapolate from that: on a
table holding millions of contacts the index build is seconds to minutes, and
every one of those seconds is a second in which **no campaign in the deployment
can claim a contact or record an attempt** — the dialer is stopped, mid-shift,
for the customer whose roster is large precisely because they dial a lot.

Check before deploying, not after:

```sql
SELECT count(*)                                   AS contacts,
       pg_size_pretty(pg_total_relation_size('agency_contacts')) AS size,
       count(*) FILTER (WHERE root_contact_id IS NULL) AS to_backfill
  FROM agency_contacts;
```

If `contacts` is in the millions, do both out of band **before** `migrate:up`,
then let the migrations no-op:

1. `CREATE INDEX CONCURRENTLY idx_agency_contacts_root ON agency_contacts (root_contact_id);`
   — 114 is `CREATE INDEX IF NOT EXISTS`, so it becomes a catalog read.
2. Backfill in chunks (`UPDATE … WHERE id IN (SELECT id FROM agency_contacts
   WHERE root_contact_id IS NULL LIMIT 10000)` in a loop, committing each) — 113
   is guarded on `IS NULL`, so it then matches zero rows. That guard also means
   the re-run on every subsequent container start is free and cannot restamp
   `updated_at` through 073's trigger, which would otherwise report every contact
   on the platform as freshly modified after each deploy.

Both migration headers carry the same argument in full; this section exists
because an operator planning a deploy reads the docs, not the SQL. Order matters
only in that the index should exist before the backfill finishes, so the read
path is never both un-indexed and live.

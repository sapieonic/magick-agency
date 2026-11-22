# Campaign templates

Reusable campaign settings, saved once at the organisation or at one account and used to fill in
every new campaign. Designed 2026-11-21 (ClickUp "Reusable Default Campaign Settings at Tenant or
Account Level"), Manas's answers to the design's five questions locked 2026-11-22. This doc is the
build spec: the rulings CT1–CT23, the data model, the contract, the routes, the console and the
build plan with its status. The task said "defaults"; Manas chose named templates (CT10), so the
feature is **Campaign templates** and "the default template" is what a new campaign starts from.

## 1. What it does

- An organisation admin keeps **organisation templates**, shared by every account. A supervisor
  keeps **account templates** for their own account. Each scope has at most one **default**
  template.
- **New campaign** opens on the account's default template (else the organisation's default, else
  the built-in settings) and fills every step from it. A "Start from" picker switches to any other
  template the account can see. Review labels each section with where it came from, and anything
  changed is "Changed for this campaign".
- A campaign stores its own copy of its settings at Create (CT1). Editing or archiving a template
  never changes a campaign that exists.
- The soft phone's outcomes for untagged calls follow the account's default template when the soft
  phone has not set its own (CT11).

## 2. Rulings

Every ruling is decided. CT13–CT21 were the build's and the review's own calls, accepted by Manas on 2026-11-22. CT22 and CT23 came out of the fresh-context review (§8 step 5), decided on 2026-11-22.

| ID | Topic | Rule | Status |
|---|---|---|---|
| CT1 | Copy, not link | A campaign stores a full copy of its settings at Create. Nothing at run time reads a template for a campaign. "Updating a template does not change existing campaigns" is true by construction. A campaign with an empty outcome list still reads the built-in catalog, as today | **Decided** (design, accepted 2026-11-22) |
| CT2 | Override by section | A template sets a section or leaves it unset. The chain for a section: the chosen template, then (for an account template) the organisation template it is based on, then built-in. The first that sets it wins, whole. No merging inside a section | **Decided** (Manas, 2026-11-22: "Section is better") |
| CT3 | Who | Organisation templates: `tenant_admin` and above with an organisation-wide seat (as AA1; 403 `tenant_wide_membership_required`). Account templates: `account_admin` (Supervisor) of that account and above. Permission `agency.campaign_templates.manage`, floored at `account_admin`. Listing templates and reading a filled-in template for New campaign: `agency.campaigns.write` | **Decided** (design, accepted) |
| CT4 | Checked as a campaign | A section is saved only if it passes the checks a campaign create runs (`validateAgencyCampaignConfig`, `configRejected` over `CAMPAIGN_CONFIG_COLUMN_DEFAULTS`), with the same error keys, so editors show errors where campaign Settings shows them | **Decided** (design, accepted) |
| CT5 | Account-only things | An organisation template never holds an account's things: the call summary profile (`analysis_profile_id`) and the numbers section. `record_calls: true` in an account that cannot record fills in as off, with a note. Sections behind a flag (assignment, inbound) fill in as built-in where the flag is off | **Decided** (design, accepted) |
| CT6 | Versions and two editors | Every save bumps `version` and writes the version row in the same transaction. A save sends `expected_version`; another save in between is refused 409 `campaign_template_changed` | **Decided** (design, accepted) |
| CT7 | Retry campaigns | A retry campaign copies its parent's settings, never a template | **Decided** (design, accepted) |
| CT8 | API creates | With the flag on, a create that leaves a section out gets it from the template named by `template_id`, else the account's default chain. A section sent is kept as sent, an empty outcome list included. With the flag off nothing changes | **Decided** (Manas, 2026-11-22: "Yes.") |
| CT9 | The record | The campaign stores `template_source`: the template's id, name and version, the organisation template it was based on (id, name, version), the notes of the filling-in, and per section `account`, `organisation`, `builtin` or `campaign`. A section carries its filled-in source while it equals the named template version as filled in for the account, the notes' adjustments included, and `campaign` once it differs. The server recomputes the sources at the create, at every settings PATCH and at an apply (amended 2026-11-22 after review: the record was fixed at the create, which a roster upload makes before Hours and Agents). Each template write audits `campaign_template.created` / `.updated` / `.archived` / `.restored` / `.default_set` / `.default_cleared` / `.applied` with the sections changed and the versions | **Decided** (design, accepted; amended in review) |
| CT10 | Named templates | Several named templates per scope, one optionally the default. An account template may be based on one organisation template (`based_on_template_id`); unset, it follows the organisation's default template, whichever that is when a campaign is made | **Decided** (Manas, 2026-11-22: "Since we are creating the template table anyways, why not have named templates?") |
| CT11 | Soft phone | Untagged soft-phone calls use the soft phone's own outcome list when it has one; otherwise the outcomes of the account's default chain (account default, organisation default, built-in), read live at the call, since the soft phone is an account setting, not a campaign. The soft-phone settings page offers "Follow campaign template" or "Set for the soft phone". Tagged calls and inbound calls are unchanged | **Decided** (Manas, 2026-11-22: "It has to.") |
| CT12 | Locks | No locked sections: an account or a campaign may change anything a template sets | **Decided** (Manas, 2026-11-22: not in phase 1) |
| CT13 | Names | Trimmed, 1–80 characters, no control or invisible format characters (AA2's rule); unique among the scope's live templates ignoring case and repeated spaces, else 409 `campaign_template_name_taken`. An account template may share an organisation template's name; the picker groups them | **Decided** (Manas, 2026-11-22: "The route taken for open decision looks good to me.") |
| CT14 | Archive, not delete | A template is archived (kept with its versions, so a campaign's `template_source` still opens). Archiving the default clears the default. Archiving an organisation template that a live account template is based on is refused 409 `campaign_template_in_use`, naming them. An archived template can be restored | **Decided** (Manas, 2026-11-22: "The route taken for open decision looks good to me.") |
| CT15 | Numbers | The `numbers` section (`caller_ids`, `telephony_provider`, `telephony_credential_id`) exists on account templates only and, when set, names at least one caller ID (review: a carrier-only section was lost on a create, which always sends caller IDs). Filling in drops numbers that are no longer usable by the account or carrier (with a note), and the create path judges the carrier and numbers as it does today | **Decided** (Manas, 2026-11-22: "The route taken for open decision looks good to me.") |
| CT16 | Apply to drafts | A template can be applied, on purpose, to chosen **draft** campaigns of the same account: chosen sections are written through the campaign PATCH path (its checks and audit), and `template_source` is updated. A campaign that is not a draft is refused for that campaign only. Never automatic, never a running campaign | **Decided** (Manas, 2026-11-22: "The route taken for open decision looks good to me.") |
| CT17 | Flag | `agency_campaign_templates_enabled` (`global`, `tenant`), client-exposed, off by default. Off: every template route answers 403 `feature_disabled`, New campaign starts as before, CT8 and CT11 do not apply | **Decided** (Manas, 2026-11-22: "The route taken for open decision looks good to me.") |
| CT18 | Built-in time zone | The built-in `hours` section is New campaign's start, `Asia/Kolkata` (`AGENCY_NEW_CAMPAIGN_TIMEZONE`), not the column's `UTC`, so a supervisor with no template sees the New campaign of today. With the flag on, a create that leaves the hours out stores `Asia/Kolkata` (CT8); with it off, `UTC` as before. With the flag on, a create that sends hours but no `default_timezone` stores `Asia/Kolkata` too, since a sent section's absent field is built-in (§5; review item D6, confirmed 2026-11-22): `operations.md` warns before the flag is turned on | **Decided** (Manas, 2026-11-22: "The route taken for open decision looks good to me.") |
| CT19 | Checked as stored | A section field whose campaign column is NOT NULL may not be `null` (`AGENCY_CAMPAIGN_TEMPLATE_NULLABLE_FIELDS` lists the others, pinned to the schema); sections are stored normalised by the campaign writes' own normalisers (the script, the caller IDs); a template's sections are at most 256 KiB serialised (`AGENCY_CAMPAIGN_TEMPLATE_SECTIONS_MAX_BYTES`) | **Decided** (Manas, 2026-11-22: "The route taken for open decision looks good to me.") |
| CT20 | Overrides without assignment | Outcome entries' agent overrides need contact assignment: where it is off, filling in, apply and the soft phone leave the overrides out (note `outcome_overrides_off`), so no path refuses a field its caller never sent | **Decided** (Manas, 2026-11-22: "The route taken for open decision looks good to me.") |
| CT21 | What the soft phone follows | The catalog the soft phone follows (CT11) is passed through the soft phone's own catalog rules: attributes it does not take (agent overrides, a promise) are left off and the outcome kept. The settings answer always says what Follow gives while templates are on, whether or not the soft phone sets its own list | **Decided** (Manas, 2026-11-22: "The route taken for open decision looks good to me.") |
| CT22 | No card facts in a template | A template never holds roster-card fact keys: its script may use only the keys a script with no card takes, the legacy six (`{name}`, `{place}`, `{amount_due}`, `{due_date}`, `{agent_name}`, `{campaign_name}`; `scriptPlaceholdersFor(null)`). Copying from a campaign (Save as template, Copy from a campaign, New template › A copy of a campaign) keeps What agents see but leaves out a script that uses the card's facts, and says so. New campaign checks a template's script against the roster's card later, and holds back one the card cannot fill until it is fixed on Review (§7) | **Decided** (2026-11-22, fresh-context review U1, U2) |
| CT23 | Outcome categories | The task's "categories" are the outcome's behaviour, which the outcome editor already sets per outcome: Success (`is_success`), Call back (`requires_datetime`), Ends the contact (`terminal`) and Do Not Call (`suppress`). There is no separate category field; a template's outcomes carry these as a campaign's do. A real category field would be a contract, catalog and editor change across the station, the app and reports, and a follow-up of its own | **Decided** (2026-11-22, fresh-context review L5) |

## 3. Sections

One declaration in `packages/contracts/src/agency/campaign-template-sections.ts` says which
campaign fields belong to which section. Nothing else lists them.

| Section key | Fields | Organisation | Account | Notes |
|---|---|---|---|---|
| `outcomes` | `disposition_catalog`, `outcome_dispositions` | yes | yes | Together: automatic outcomes name catalog codes |
| `retries` | `retry_policy` | yes | yes | The our-fault bound stays a platform rule |
| `hours` | `calling_window_start`, `calling_window_end`, `calling_days`, `default_timezone` | yes | yes | Start and end checked together |
| `wrapup` | `wrapup_seconds`, `wrapup_auto_return`, `allow_wrapup_redial` | yes | yes | |
| `breaks` | `break_reasons` | yes | yes | The create path learns `break_reasons` |
| `recording` | `record_calls`, `analysis_profile_id` | `record_calls` only | yes | CT5 |
| `agent_screen` | `agent_script`, `phone_display`, `daily_target_calls` | yes | yes | |
| `safety` | `abandonment_ceiling_pct` | yes | yes | AC2's note above 3% |
| `assignment` | `assignment_mode`, `on_unstaff`, `callback_owner_grace_minutes`, `callback_fallback`, `allow_agent_retry`, `agent_retry_rounds`, `agent_retry_cooldown_minutes` | yes | yes | Only where contact assignment is on |
| `inbound` | `inbound_sticky_enabled` | yes | yes | Only where inbound is on |
| `numbers` | `caller_ids`, `telephony_provider`, `telephony_credential_id` | no | yes | CT15 |

Not in any section: `name`, the roster, `context_display` (it names CSV columns), lifecycle and
retry-lineage columns.

## 4. Data model

Migration `0067_campaign_templates.sql`. No foreign key to tenants or accounts (as
`account_settings` and `agency_softphone_settings`; `BASELINE.md` open question 2).

```sql
CREATE TABLE agency_campaign_templates (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL,
  account_id            UUID,                 -- NULL = organisation template
  name                  VARCHAR(80) NOT NULL,
  description           VARCHAR(280),
  based_on_template_id  UUID REFERENCES agency_campaign_templates(id),  -- account templates only
  sections              JSONB NOT NULL DEFAULT '{}'::jsonb,              -- absent key = not set
  is_default            BOOLEAN NOT NULL DEFAULT false,
  version               INTEGER NOT NULL DEFAULT 1,
  created_by            UUID, updated_by UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at           TIMESTAMPTZ, archived_by UUID,
  CONSTRAINT ck_agency_campaign_templates_sections CHECK (jsonb_typeof(sections) = 'object'),
  CONSTRAINT ck_agency_campaign_templates_based_on CHECK (account_id IS NOT NULL OR based_on_template_id IS NULL)
);
-- One live default per scope; scope lookups.
CREATE UNIQUE INDEX uq_agency_campaign_templates_default
  ON agency_campaign_templates (tenant_id, account_id) NULLS NOT DISTINCT
  WHERE is_default AND archived_at IS NULL;
CREATE INDEX idx_agency_campaign_templates_scope
  ON agency_campaign_templates (tenant_id, account_id) WHERE archived_at IS NULL;

CREATE TABLE agency_campaign_template_versions (
  template_id           UUID NOT NULL REFERENCES agency_campaign_templates(id) ON DELETE CASCADE,
  version               INTEGER NOT NULL,
  name                  VARCHAR(80) NOT NULL,
  based_on_template_id  UUID,
  sections              JSONB NOT NULL,
  saved_by              UUID,
  saved_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (template_id, version)
);

ALTER TABLE agency_campaigns ADD COLUMN template_source JSONB;  -- NULL: made without a template
```

Name uniqueness (CT13) is checked in the write's transaction, which locks the scope's rows (as
AA3 locks the tenant row), not by an index, because the rule folds case and spaces.

Build notes (step 1): the scope lock is a transaction advisory lock on (tenant, account or
`organisation`), since an organisation scope has no row to lock; names compare by the account-name
rule (`apps/server/src/utils/name-key.ts`). A write naming a `based_on_template_id` reads that row
`FOR SHARE` and archive locks it `FOR UPDATE` before counting its live followers, so the two
serialise. `updated_at` / `updated_by` move with a content save only, not with a default or archive
change. Archiving an archived template, or restoring a live one, changes nothing; restoring checks
the name and that its based-on is still live. A retry campaign's `template_source` is NULL (CT7).

Migration `0068_campaign_templates_archived_index.sql` (fresh-context review D8) adds
`idx_agency_campaign_templates_archived` on `(tenant_id, account_id) WHERE archived_at IS NOT NULL`,
the twin of the live scope index, so the Archived list (`?archived=true`) no longer scans every
tenant's templates. The repository's list writes `archived_at IS NULL` or `IS NOT NULL` into its
statement rather than binding it, so the planner proves which partial index applies
(`campaign-template-list-index.test.ts` plans that statement on real Postgres).

## 5. The pure rules (`packages/domain/src/campaign-templates.ts`)

A leaf module: imports only `@magick-agency/contracts`.

- `resolveTemplateSections({ chosen, basedOn, builtin, can })` → `{ config, sources, notes }`.
  `chosen` is the template the campaign starts from (or `null`: built-in), `basedOn` its
  organisation template when `chosen` is an account template. `can` is
  `{ record, assignment, inbound }`. Applies CT2, CT5 and CT20. `builtin` comes from
  `builtinTemplateSections()`, built from the contract's `AGENCY_DEFAULT_*` constants and the
  campaign column defaults; the server passes the same object, never its own copy.
- `sectionsFromCampaign(campaign, scope)` → sections, for "Save as template" and "Copy from a
  campaign"; drops account-only sections for an organisation template.
- `diffSections(a, b)` → the changed section keys and, per section, the changed fields, for
  version comparison, "What's different" and the apply preview.
- `sectionSourcesForCreate(sent, resolved)` → per section `campaign` when what was sent differs
  from the filled-in section, else that section's source (CT9). Field order and absent-vs-default
  are normalised first, so an untouched section never reads as changed.

Build notes (step 1, the calls the rulings left open):

- Inside a set section a field that is absent is its **built-in** value, never the next level's
  (CT2's "whole"), exactly as a create that omits a field stores the column default. So a sent
  section's absent fields are built-in too (CT8's "kept as sent").
- The built-in settings are the column defaults (`AGENCY_CAMPAIGN_COLUMN_DEFAULTS` and its
  neighbours, pinned to the DEFAULTs by the repository's integration test), with the seeded
  catalog, except the time zone: the hours are 09:00–20:00, Monday to Friday, in `Asia/Kolkata`,
  New campaign's start, not the column's `UTC` (CT18). `retries` built-in is `{}`, "no rule stored":
  the retry engine applies `DEFAULT_RETRY_POLICY` per outcome at run time, so it is not copied.
  `numbers` built-in is an empty pool on the service's own carrier.
- Comparison: times as `HH:MM:SS`, days sorted once, object keys in any order, and inside an
  object value a key that is `undefined`, `null` or `false` is the same as absent; array order
  counts (a catalog's order is the station's).
- `section_flag_off` is noted only when a template had set the section; `recording_not_allowed`
  only when `record_calls` was on; `outcome_overrides_off` only when the outcomes carried an agent
  override and contact assignment is off, the overrides then left out and the outcomes kept (CT20:
  filling in, apply and the soft phone all go through this, so none refuses a field its caller
  never sent). The server adds `analysis_profile_unavailable`,
  `numbers_unavailable` and `carrier_unavailable`.
- Extra helpers: `normaliseSection`, `sameTemplateValue`, `accountOnlyPartsIn` (what an
  organisation template may not hold, for the scope refusal) and `sectionKeysSet`.

## 6. Routes (console, under `/proxy/agency`)

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/campaign-templates` | `agency.campaigns.write` | The account's live templates and the organisation's, each with name, scope, default, version, updated by and when, based-on, the section keys it sets; `?archived=true` lists archived ones |
| GET | `/campaign-templates/:id` | as list | One template with its sections and, for an account template, the organisation template it follows |
| POST | `/campaign-templates` | manage (CT3; `scope: 'organisation'` sent without `X-Account-Id`) | Create `{ scope, name, description?, based_on_template_id?, sections, make_default? }` |
| PUT | `/campaign-templates/:id` | manage | Replace `{ name, description, based_on_template_id, sections, expected_version }`; 409 on a stale version |
| POST | `/campaign-templates/:id/default` | manage | Make it the scope's default (clears the old one in the same transaction) |
| DELETE | `/campaign-templates/:id/default` | manage | The scope has no default |
| POST | `/campaign-templates/:id/archive`, `/restore` | manage | CT14 |
| GET | `/campaign-templates/:id/versions`, `/versions/:n` | as list | History and one version |
| GET | `/campaign-templates/effective` | `agency.campaigns.write` | `?template_id=` or the default chain: `{ template, based_on, config, sources, notes }` for New campaign |
| POST | `/campaign-templates/:id/apply` | manage and `agency.campaigns.write` | CT16: `{ campaign_ids, sections }` → per campaign `applied` or the refusal |
| POST | `/campaigns` (changed) | as today | Optional `template_id`; fills omitted sections (CT8); stores `template_source` |

Errors are typed codes in `packages/contracts/src/errors.ts`: `campaign_template_not_found`,
`campaign_template_changed`, `campaign_template_name_taken`, `campaign_template_in_use`,
`campaign_template_scope_invalid`, `campaign_template_section_invalid` (with the campaign's
field details), `campaign_template_archived`, and (added in step 1) `campaign_template_invalid`
for a bad name, description or body.

Build notes (step 2): every route answers 403 `feature_disabled` with the flag off. Organisation
writes need `tenant_admin` with an organisation-wide seat (AA1's `tenant_wide_membership_required`,
one helper shared with `POST /accounts`); a supervisor writes their account's. A template the
caller cannot see, or a malformed id, is 404. `effective` and apply need `X-Account-Id`
(`400 account_scope_required`). A create's
`template_id`: an id is that template, `null` the built-in settings alone, absent the default
chain; an unknown one 404 and an archived one 409 (the contract's statuses). A section sent keeps
its absent fields built-in, and `template_source` is always the server's (a client's is dropped).
With the flag off a create is as before, except that `break_reasons` sent on a create is now
stored (it used to be dropped). Apply writes drafts through the campaign PATCH path
(`helpers/campaign-patch.ts`, its checks and its `config_changed` audit), with `template_source`
in the same transaction (below), and refusals per campaign; a campaign started between the status
read and the write is still written (an accepted race). The soft-phone settings answer `outcomes_template`
(CT11). Audit: `campaign_template.created|updated|archived|restored|default_set|default_cleared|applied`,
resource `campaign_template`. A template's own rows (created, updated, default set and cleared,
archived, restored) are filed under the template's account, an organisation template's under the
tenant alone (no account); an apply is filed under the request's account, whose drafts it changed,
whichever template it applies (`auditTemplate` in `proxy-agency-campaign-templates/shared.ts`). A PUT checks its body, the size cap included, before it reads the template.
Smaller calls: `analysis_profile_unavailable` is noted when the profile fails its check or the account
does not analyse calls; a description is trimmed, blank is null.

Build notes (fresh-context review, server fixes, 2026-11-22; the IDs are in §8 step 5):

- **Apply's numbers** (D2). Choosing `numbers` from a template that sets none (an organisation
  template always; an account template that leaves numbers built-in), or none of whose numbers the
  account can use now, is refused up front, `400 campaign_template_invalid` with
  `details['sections.numbers']`, before any campaign is touched. Through the PATCH it would refuse
  every campaign, and none would get its other sections.
- **Apply in one transaction** (D5). The templates applied ride the internal PATCH as `callCore`'s
  typed `templateApply` (sent as `x-mgkvc-template-apply`, set from the typed field alone,
  `seams.md`), so `writeCampaignPatch` stores a campaign's settings and its `template_source`
  together or not at all; the separate record pass is gone. A campaign whose write fails outright
  (a throw, not a refusal) is answered `campaign_rejected` with status 500 and the loop goes on.
  The `campaign_template.applied` row is written whatever happened in the loop.
- **The record on a settings PATCH** (D1). A PATCH recomputes `template_source` only when its body
  names a section field, and best effort: a template read that fails is logged and the record
  kept, never a 500 for the PATCH (a calling window fix on a running campaign included; the record
  is never read at run time, CT1). Under the row lock the comparison is pure: a record that by
  then names other versions is left as it is, with no read inside the lock. The record write moves
  `updated_at`, as every settings write does (D15).
- **The soft phone's save** (D3). `PUT /softphone/settings` reads what Follow gives after the save
  best effort: a failure is logged and `outcomes_template` is left out of the answer (the console
  reads its absence as not known); the save is answered and audited.
- **History is paged, live templates capped** (D4). `GET /campaign-templates/:id/versions` answers
  one page, newest first: `AGENCY_CAMPAIGN_TEMPLATE_VERSIONS_PAGE` (50) by default, `limit` up to
  `AGENCY_CAMPAIGN_TEMPLATE_VERSIONS_PAGE_MAX` (100), `before` a version for older ones
  (`AgencyCampaignTemplateVersionsQuery`; a malformed value is `400 campaign_template_invalid`).
  Each row's `sections_set` is read in SQL (`jsonb_object_keys`), not from the sections. A scope
  keeps at most `AGENCY_CAMPAIGN_TEMPLATE_LIVE_MAX` (200) live templates: a create or a restore past
  it is refused `400 campaign_template_invalid` with `details.templates`, checked under the scope
  lock. Archived templates do not count.
- **A malformed profile id** (D9). A non-id `analysis_profile_id` in a template is
  `campaign_template_section_invalid` keyed on the field, not the generic 400; one already stored
  fills in as unavailable (`analysis_profile_unavailable`).
- **Archive and deleted accounts** (L17). The in-use check (CT14) counts the live account templates
  of accounts not marked `deleted` only, so a follower that no screen can reach never blocks
  archiving its organisation template.
- **CT1, held structurally.** `apps/server/test/unit/agency/campaign-templates-runtime-reach.test.ts`
  lets only the template modules name the template tables, the template repository or a template
  module (`agency/campaign-templates/*`): the repository and its barrel, `agency/campaign-templates/`,
  the soft phone's `untagged-outcomes.ts` (CT11), the create's fill-in and the PATCH's record (the
  two campaign `crud.ts`) and the template routes. Any other reader, such as pacing or the station
  overlaying a template on a campaign, turns it red; each entry must still name something.
  `campaign-templates-create.test.ts` pins the behaviour on real Postgres.

## 7. Console

- **Settings › Campaign templates**: listed in the account group and the organisation group of
  `SETTINGS_ENTRIES`, gated by the flag and the permission. A list (name, default badge, based
  on, sections set, updated by and when, Make default, Archive) and an editor page that composes
  the existing campaign editors per section, each with "Use <based-on or built-in>" or "Set in
  this template". "Copy from a campaign", the Collections set (AS4) on the outcomes editor,
  History with a side-by-side comparison, and "Apply to draft campaigns" (CT16) with a preview.
- **New campaign**: "Start from" picker above the steps; the form is filled from
  `/campaign-templates/effective`; Review rows carry the source chip and a per-section Reset; the
  create sends `template_id`. When the read fails or the flag is off, the builder starts as today.
- **Campaign Settings**: "Started from <template>, version n" with "What's different from the
  template now" and "Save as template…" (new, or replace an existing one's sections).
- **Soft phone settings**: the outcome list offers "Follow campaign template (<name>)" or "Set
  for the soft phone" (CT11).
- Copy is Indian English with British spelling, "organisation" never "tenant" (AA7).

Build notes (step 3): `/settings/campaign-templates` and `/settings/organisation-campaign-templates`
(the second only for tenant admins and owners on an organisation-wide seat: `Gate.organisationSeat`,
`TenantContext.organisationRole`). One wire↔form mapping, `utils/agency/campaignTemplates/templateForm.ts`,
reads through the existing campaign readers; comparisons are the domain's. New campaign sends
`template_id` (`null` for the built-in settings) with the sections as on the form, so their
sources are recorded at the create; the picker is locked once a roster upload has made the draft.
Breaks and the agent screen, which New campaign has no step for, show on Review as read-only rows
with their chip. The script editor in a template offers the keys a script with no customer card
takes, the legacy six (a template has no card; corrected in the fresh-context review, U1, CT22). With the flag off or the read failing, New campaign is unchanged.

Build notes (review fixes, 2026-11-22): in New campaign, numbers the template leaves on built-in
are the operator's: kept across a switch or a Reset, with no chip (the record calls them
`campaign`). A start that sets numbers replaces them, asking first only when the operator picked
others; Reset never empties the pool. The chosen template is read before "Replace your changes?".
A default-chain read that lands after the operator started typing fills only untouched sections,
still shows the picker and still names the template. A template script using keys the roster's
card lacks is held back from the draft (empty script); Review explains it with the AS19 message,
offers the script editor, and Save campaign waits for the fix. Lists and the picker say "Account
default" / "Organisation default"; Templates / Archived is an `aria-pressed` filter. Copies set
only the sections the editor shows (`templateSectionKeys`); an unset section reads "Use
<template>", "Use the organisation's default" or "Use built-in settings". Apply and Save as
template recover from a 409 with "Reload the latest version", the dialog kept open; apply names
the account on the organisation page. Campaign Settings reads "Started from <template>, version
n · created <d Mon>" with the record's notes as sentences; an archived template "has since been
archived" with no comparison; a campaign with no record offers only "Save as template…". The soft
phone reads `outcomes_template` as what Follow gives; Follow or Set comes from its own list.

Build notes (fresh-context review, 2026-11-22; the review's item IDs are in §8 step 5):

- **The script** (U1, CT22). A template's script editor takes what the server takes for a script
  with no card: the legacy six keys (`scriptPlaceholdersFor(null)`), so a template holding
  `{amount_due}` or `{due_date}` saves again. A key outside them is told "which a template cannot
  fill in. Use only …", never to add a fact to a card a template does not have.
- **Copying from a campaign** (U2, CT22). Save as template, Copy from a campaign and New template ›
  A copy of a campaign leave out a script that uses the card's facts and keep the rest of What
  agents see (`templateSectionsFromCampaign`); the dialog, or the editor's top, says "This
  campaign's script uses facts from its roster card, which a template cannot hold, so the template
  leaves the script out."
- **Apply** (U3, U10, U12). The sections start as those the template sets, none when it sets none;
  Numbers is offered only when the template sets numbers (unset, it has none to give and the
  campaign PATCH refuses an empty pool). A refused campaign, and a refusal of the whole apply, show
  the refusal's details as sentences under "Not changed". An answer that lands after the dialog
  closed is dropped; the preview reads six drafts at a time; the results are announced and take the
  focus.
- **The editor's layout** (U4, U6, U8, U9, U13, N9). An "About this template" card at the top holds
  the name, the description and Based on; only a slim bar with Discard and Save, and a short note
  beside them, sticks to the bottom (one button high on a phone). Long names wrap. A section with a
  field to fix carries a danger border and "Needs a fix", and the bar's "Fix the marked settings to
  save." takes the focus to the field. Unset numbers read "Pick them in each campaign", never an
  organisation template. When the template it follows cannot be read, the editor says so with
  Retry rather than showing built-in values under that template's name. A name the server refuses
  for its characters shows under Name.
- **A read-only View** (L4a, N7). On an account's page the organisation's templates have View,
  which opens the editor read-only: the name and description as text, each section's summary and
  where it comes from, no choices and no bar; an organisation admin gets a link to its own editor.
  An organisation template reached by an account editor's URL opens the same way.
- **"New campaigns in this account start from"** (L4b, `EffectiveStartCard`). The account's
  Settings › Campaign templates opens on what a new campaign of the account starts from now:
  `GET /campaign-templates/effective` without `template_id` (the default chain), the template's
  name or "Built-in settings", each shown section in one line with its source chip, and the notes as
  sentences. Read again after a default is made or cleared, an archive or a restore. Not on the
  organisation's page. Templates / Archived show rows only once their own list is read (U5).
- **Start from** (U12). Choosing in New campaign's list does nothing by itself; "Use this
  template" starts from the one chosen (an arrow key on a closed list changed it at once in
  Chromium, a read per press). Review's script problem is a status, not an alert re-read at each
  key, and its Unanswered calls row carries the Outcomes chip, Reset on Outcomes putting both back
  (N8).
- **History** (U11, N1, N2, N4). Comparing two versions lists a change of name or Based on beside
  the sections' ("Set only in Version 3 (now)"); a template with one version says it has nothing to
  compare yet. A stamp from another year carries the year ("18 Nov 2025, 4:12 PM"). It reads the
  server's first page only, so it lists the 50 newest versions (D4; §9).
- **Campaign Settings** (U7). "What's different from the template now" leaves out numbers the
  template leaves on built-in (each campaign's own, as New campaign treats them) and compares the
  campaign as it is now, so a save shows at once.
- **Words** (N2, N5, L21). The hours summary says "India time (IST)" for `Asia/Kolkata`. The soft
  phone's Follow reads "Calls not logged to a campaign use …", the page's own words, not "Untagged
  calls". New template › A copy of a campaign says the campaigns could not be read, with Retry.
  The console's search finds both template pages by "default outcomes", "default dispositions",
  "outcome defaults" and the calling hours defaults.

## 8. Build plan and status

The fresh-context review's items keep the IDs its reviewers gave them, local to this doc and
cited in the console's tests and commits: L1–L23 (the loose-ends audit), D1–D17 (server, db,
contract and domain; not `decisions.md`'s D-series), U1–U13 and N1–N9 (the console). The first
review's (step 4) are CTS1–CTS14 (server, db, contract and domain) and CTC1–CTC12 (the console),
defined in the table below the steps. Its reviewers wrote S and C, which clash with
`decisions.md`'s S1–S8 and AS19's review rulings S1–S16, so code and tests cite the CT-prefixed IDs.

| Step | What | State |
|---|---|---|
| 1 Foundation | Contract (sections, wire types, errors, flag, permission), `0067_campaign_templates.sql` and `BASELINE.md`, the domain rules with their table tests, the repository on real Postgres | Built (2026-11-22): `campaign-template-sections.ts`, `api/agency/campaign-templates.ts`, `packages/domain/src/campaign-templates.ts`, `campaign-template.repository.ts`; their tests green, the repository's and the migration's on real Postgres |
| 2 Server | Routes, effective fill-in, create path (CT8, CT9), soft phone (CT11), numbers (CT15), apply (CT16), audit, route-table guards, integration in both lanes | Built (2026-11-22): the route family, `agency/campaign-templates/`, `agency/softphone/untagged-outcomes.ts`, the shared PATCH and seat helpers; unit and integration green in both lanes |
| 3 Console | Settings pages, New campaign, campaign Settings, soft phone settings, analytics events, tests | Built (2026-11-22): Settings list and editor (history, copy from a campaign, apply to drafts), New campaign's Start from with Review chips and Reset, campaign Settings' Started from, comparison and Save as template, the soft phone's Follow/Set; console tests green |
| 4 Review | Independent review of the whole diff, fixes with tests that fail without them | Done (2026-11-22): two independent reviews (server 14 findings, console 12), no blocker; every finding fixed with a test that fails without it, except apply's two race windows (CTS10, CTS11), guarded by the code's shape; rulings CT9 (amended), CT15 and CT19–CT21 came out of it. Not yet run in a real browser, against real Firebase sign-in, or with the agent app's Dart tests |
| 5 Fresh-context review | Three reviewers with no part in the build: a loose-ends audit against the task, the rulings and the repo's rules (L1–L23), the server, db, contract and domain (D1–D17), the console (U1–U13, nits N1–N9). No blocker | Console fixed (2026-11-22), each with a test: U1–U13, N1–N9, L1 (the route-gate sweep's size), L4 (the read-only View and "New campaigns in this account start from"), L21 (search words), and every section round-tripped through the editor's form. Docs fixed (2026-11-22): L2 (`operations.md`, "Enabling campaign templates for a tenant", with D6), L3 (`softphone.md`), L5 (CT23), L7 (`status.md`), L8 (`seams.md`), L9's console, contract, domain and db rows (`modules.md`), L11, L12, L22's doc line (`architecture.md`), L23, D17 (`db-hygiene.md`), and CT22 from U1 and U2. Server fixed (2026-11-22), each with a test that fails without it: D1, D2, D3, D4, D5, D8 (0068), D9, D15, L14 (the three criteria without a direct test) and L17, with D6's case pinned and CT1 held structurally (§6); D12, D14, L10, L13, L15 and L16 are tidy-ups of comments, the contract and dead code. Done (2026-11-22): L6 (the first review's IDs named CTS1–CTS14 and CTC1–CTC12, table below), L9's server rows (`modules.md`), L22's console line (`teamRoles.ts`). Not done: D13 (one rule written in three places) and D16 (every `SELECT *` of a campaign carries the record), nits left as they are. L18 (the agent app's Dart tests) is CI's mobile job. Accepted as they stand: §9 |

**The first review's findings** (step 4, 2026-11-22), as code, tests and commits cite them:

| ID | Finding | Fix |
|---|---|---|
| CTS1 | A template's outcome overrides reached a create, an apply or the soft phone where contact assignment is off, refused 403 on a field the caller never sent | Left out, note `outcome_overrides_off` (CT20) |
| CTS2 | After an apply of another template, the record credited the sections not chosen to the template applied | One computation of the record against the versions it names (CT9 as amended) |
| CTS3 | Sections the fill-in changed (recording not allowed, a profile or numbers unavailable) kept the template's source, and the notes were lost | The record keeps the fill-in's notes (CT9 as amended) |
| CTS4 | `null` taken on section fields whose campaign column is NOT NULL | Refused, keyed by the field (CT19, `AGENCY_CAMPAIGN_TEMPLATE_NULLABLE_FIELDS`) |
| CTS5 | Sections stored as sent, not as a campaign write stores them | Stored by the campaign writes' normalisers (CT19, `campaign-stored-values.ts`) |
| CTS6 | No size bound on a template's sections, copied into every version | 256 KiB, checked with the body first (CT19) |
| CTS7 | An organisation template's apply was audited under the tenant, not the account whose drafts changed | Filed under the request's account (§6) |
| CTS8 | The catalog the soft phone follows skipped the soft phone's own catalog rules | Passed through them (CT21) |
| CTS9 | An account template's carrier-only numbers section (no caller IDs) was lost on a create or an apply | A set numbers section names a caller ID (CT15) |
| CTS10 | Apply checked `expected_version` on another read than the one it applied, and the based-on was not pinned | Both read once and pinned for every campaign; a race, held by the code's shape, no test |
| CTS11 | Apply's answer claimed a `template_source` it had not stored | The answer carries the record as stored (since D5, written with the settings); a race, held by the code's shape, no test |
| CTS12 | A default, an archive or a restore sent twice at once was audited twice | Audited only when the write changed something |
| CTS13 | Apply's duplicate check was case-sensitive, so one draft named in two cases was written twice | Ids lower-cased before the check: `400 campaign_template_invalid` |
| CTS14 | Stale comments and docs: old ruling ranges, the built-in hours said to be UTC | Comments name the rulings and CT18's built-in zone |
| CTC1 | New campaign stored the record at the draft a roster upload makes, before Hours and Agents, so "Changed for this campaign" was almost never stored | The record recomputed at the settings PATCH (CT9 as amended); the draft's later edits ride Save campaign's PATCH |
| CTC2 | Numbers left on built-in read as changed, Reset emptied the pool, and a Start from switch wiped the numbers picked on Basics | Numbers a start leaves built-in are the operator's: kept, no chip (§7) |
| CTC3 | Soft phone settings said "Follow the built-in outcomes" whenever the soft phone had its own list, even with a default template | `outcomes_template` sent whenever templates are on, read as what Follow gives (CT21) |
| CTC4 | Two "Default for new campaigns" badges on an account's page and two "(default)" entries in the picker | "Account default" and "Organisation default" |
| CTC5 | Template refusals swapped the server's sentences for generic ones that named the wrong template | The server's sentence kept |
| CTC6 | A copy of a campaign set sections the editor hides, saved and impossible to unset | Copies set only the sections the editor shows (`templateSectionKeys`) |
| CTC7 | Apply to drafts read a failed list as "no drafts", kept stale sections, and promised a reload on a 409 that was not there | Retry, the template's sections at each open, "Reload the latest version"; Save as template the same |
| CTC8 | A default chain read landing after the operator started never showed Start from | Fills only untouched sections, keeps the picker, names the template |
| CTC9 | Templates / Archived was a tab list with no panels and no arrow keys | An `aria-pressed` filter |
| CTC10 | A template script using `{amount_due}` or `{due_date}` could fail New campaign's roster import | Held back from the draft; Review explains and offers the script editor (later CT22) |
| CTC11 | Template logic inline in two oversized components, New campaign and the editor page | `useBuilderTemplate`; `useTemplateEditorData`, `useTemplateEditor` and `TemplateEditorForm` |
| CTC12 | Copy and labels: the unset choice's words, History listing the current version twice, an unlabelled numbers picker, a banner on every campaign with no record, dialogs keeping their choice when closed | "Use <template>" and its kin, one current version, a named group, no banner, dialogs reset |

## 9. Accepted limits

Found by the fresh-context review and kept as they are, each for the reason given.

- **D7, the soft phone's pad and its settlement.** An untagged call's outcomes are shown from the
  bootstrap, but the outcome is settled against the chain read live at submit (CT11). A save of the
  followed template between the two can refuse a removed code (`disposition_invalid` until the
  client reads the bootstrap again) or settle a code whose behaviour changed. The rules themselves
  are one function for both (`untagged-outcomes.ts`); the gap is timing only, as it was before
  templates for a soft-phone settings save, and a template save is rare and deliberate.
- **D10, agents see the template's name.** The soft-phone settings answer (`agency.softphone.dial`)
  carries `outcomes_template.template` (id, name, version, scope), which `GET /campaign-templates`
  would not show an agent. It is not sensitive: agents see the catalog it gives anyway.
- **D11 and L19, the dialer contract imports console wire types.** `agency/softphone.ts` imports the
  template ref and scope from `api/agency/campaign-templates.ts`, and
  `agency/campaign-template-sections.ts` imports `AgencyCampaign` from `api/agency/agency-campaign.ts`.
  Type-only, so nothing breaks; the direction is noted, not reversed.
- **L20, a create's `break_reasons` is stored either way.** CT8 and CT17 say nothing changes with the
  flag off, but a `break_reasons` sent on a create is now stored whatever the flag (it used to be
  dropped, §6): a fix, kept.
- **History lists the 50 newest versions** (D4). The server pages a template's history
  (`before`, `limit`), but the console's History reads the first page only, so a template saved
  more than 50 times shows its 50 newest versions and compares among those. A template is rarely
  saved that often; paging History is a console change of its own when one is.
- **The start-from card is long on a phone.** "New campaigns in this account start from" lists
  every shown section in one line each, so on a phone it takes a few screens before the list. It
  is the clear view the task asked for, and the list follows it.

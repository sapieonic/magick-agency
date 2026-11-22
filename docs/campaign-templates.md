# Campaign templates

Reusable campaign settings, saved once at the organisation or at one account and used to fill in
every new campaign. Designed 2026-11-21 (ClickUp "Reusable Default Campaign Settings at Tenant or
Account Level"), Manas's answers to the design's five questions locked 2026-11-22. This doc is the
build spec: the rulings, the data model, the contract, the routes, the console and the build
plan with its status. The task said "defaults"; Manas chose named templates (CT10), so the
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

`default` rows are the build's own calls, pending Manas; the rest are decided.

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
| CT9 | The record | The campaign stores `template_source`: the template's id, name and version, the organisation template it was based on (id, name, version) and, per section, `account`, `organisation`, `builtin` or `campaign` (changed in New campaign). Each template write audits `campaign_template.created` / `.updated` / `.archived` / `.restored` / `.default_set` / `.applied` with the sections changed and the versions | **Decided** (design, accepted) |
| CT10 | Named templates | Several named templates per scope, one optionally the default. An account template may be based on one organisation template (`based_on_template_id`); unset, it follows the organisation's default template, whichever that is when a campaign is made | **Decided** (Manas, 2026-11-22: "Since we are creating the template table anyways, why not have named templates?") |
| CT11 | Soft phone | Untagged soft-phone calls use the soft phone's own outcome list when it has one; otherwise the outcomes of the account's default chain (account default, organisation default, built-in), read live at the call, since the soft phone is an account setting, not a campaign. The soft-phone settings page offers "Follow campaign template" or "Set for the soft phone". Tagged calls and inbound calls are unchanged | **Decided** (Manas, 2026-11-22: "It has to.") |
| CT12 | Locks | No locked sections: an account or a campaign may change anything a template sets | **Decided** (Manas, 2026-11-22: not in phase 1) |
| CT13 | Names | Trimmed, 1–80 characters, no control or invisible format characters (AA2's rule); unique among the scope's live templates ignoring case and repeated spaces, else 409 `campaign_template_name_taken`. An account template may share an organisation template's name; the picker groups them | default |
| CT14 | Archive, not delete | A template is archived (kept with its versions, so a campaign's `template_source` still opens). Archiving the default clears the default. Archiving an organisation template that a live account template is based on is refused 409 `campaign_template_in_use`, naming them. An archived template can be restored | default |
| CT15 | Numbers | The `numbers` section (`caller_ids`, `telephony_provider`, `telephony_credential_id`) exists on account templates only. Filling in drops numbers that are no longer usable by the account or carrier (with a note), and the create path judges the carrier and numbers as it does today | default |
| CT16 | Apply to drafts | A template can be applied, on purpose, to chosen **draft** campaigns of the same account: chosen sections are written through the campaign PATCH path (its checks and audit), and `template_source` is updated. A campaign that is not a draft is refused for that campaign only. Never automatic, never a running campaign | default |
| CT17 | Flag | `agency_campaign_templates_enabled` (`global`, `tenant`), client-exposed, off by default. Off: every template route answers 403 `feature_disabled`, New campaign starts as before, CT8 and CT11 do not apply | default |
| CT18 | Built-in time zone | The built-in `hours` section is New campaign's start, `Asia/Kolkata` (`AGENCY_NEW_CAMPAIGN_TIMEZONE`), not the column's `UTC`, so a supervisor with no template sees the New campaign of today. With the flag on, a create that leaves the hours out stores `Asia/Kolkata` (CT8); with it off, `UTC` as before | default |

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

## 5. The pure rules (`packages/domain/src/campaign-templates.ts`)

A leaf module: imports only `@magick-agency/contracts`.

- `resolveTemplateSections({ chosen, basedOn, builtin, can })` → `{ config, sources, notes }`.
  `chosen` is the template the campaign starts from (or `null`: built-in), `basedOn` its
  organisation template when `chosen` is an account template. `can` is
  `{ record, assignment, inbound }`. Applies CT2 and CT5. `builtin` comes from
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
  catalog: so the hours are 09:00–20:00, Monday to Friday, in **UTC** (the column default; New
  campaign's own form starts at Asia/Kolkata today). `retries` built-in is `{}`, "no rule stored":
  the retry engine applies `DEFAULT_RETRY_POLICY` per outcome at run time, so it is not copied.
  `numbers` built-in is an empty pool on the service's own carrier.
- Comparison: times as `HH:MM:SS`, days sorted once, object keys in any order, and inside an
  object value a key that is `undefined`, `null` or `false` is the same as absent; array order
  counts (a catalog's order is the station's).
- `section_flag_off` is noted only when a template had set the section; `recording_not_allowed`
  only when `record_calls` was on. The server adds `analysis_profile_unavailable`,
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
caller cannot see, or a malformed id, is 404. `effective` needs `X-Account-Id`. A create's
`template_id`: an id is that template, `null` the built-in settings alone, absent the default
chain; an unknown one 404 and an archived one 409 (the contract's statuses). A section sent keeps
its absent fields built-in, and `template_source` is always the server's (a client's is dropped).
With the flag off a create is as before, except that `break_reasons` sent on a create is now
stored (it used to be dropped). Apply writes drafts through the campaign PATCH path
(`helpers/campaign-patch.ts`, its checks and its `config_changed` audit) and then
`template_source`, with refusals per campaign; a campaign started between the status read and
the write is still written (an accepted race). The soft-phone settings answer `outcomes_template`
(CT11). Audit: `campaign_template.created|updated|archived|restored|default_set|default_cleared|applied`,
resource `campaign_template`. Smaller calls: an empty `numbers.caller_ids` sets the carrier
only; `analysis_profile_unavailable` is noted when the profile fails its check or the account
does not analyse calls; a description is trimmed, blank is null.

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
with their chip. The script editor in a template offers the fixed placeholders only (a template
has no customer card). With the flag off or the read failing, New campaign is unchanged.

## 8. Build plan and status

| Step | What | State |
|---|---|---|
| 1 Foundation | Contract (sections, wire types, errors, flag, permission), `0067_campaign_templates.sql` and `BASELINE.md`, the domain rules with their table tests, the repository on real Postgres | Built (2026-11-22): `campaign-template-sections.ts`, `api/agency/campaign-templates.ts`, `packages/domain/src/campaign-templates.ts`, `campaign-template.repository.ts`; their tests green, the repository's and the migration's on real Postgres |
| 2 Server | Routes, effective fill-in, create path (CT8, CT9), soft phone (CT11), numbers (CT15), apply (CT16), audit, route-table guards, integration in both lanes | Built (2026-11-22): the route family, `agency/campaign-templates/`, `agency/softphone/untagged-outcomes.ts`, the shared PATCH and seat helpers; unit and integration green in both lanes |
| 3 Console | Settings pages, New campaign, campaign Settings, soft phone settings, analytics events, tests | Built (2026-11-22): Settings list and editor (history, copy from a campaign, apply to drafts), New campaign's Start from with Review chips and Reset, campaign Settings' Started from, comparison and Save as template, the soft phone's Follow/Set; console tests green |
| 4 Review | Independent review of the whole diff, fixes with tests that fail without them | Not started |

> **Reference copy, verbatim below this box.** Origin: MagickVoice-platform (superproject) @ `1b41674` (branch `origin/claude/session-setup-vdwl2i` only; not on the superproject's `main` or in its HEAD), path `docs/agency-isolation-handoff.md`. Copied into Magick Agency on 2026-10-09; not kept in sync.
>
> **How this maps to Magick Agency:** Implementation handoff for isolating the agency product from the AI product inside one MagickVoice app. Magick Agency has no AI product, so the isolation problem is gone; the three-zone model it records is why the console's `/app` platform zone stays (decision B17). Cited by a console test for its Q2.
>
> Index of all copies: [`docs/reference/README.md`](../../README.md).

# Agency ⇄ Primary App Scope Isolation — Implementation Handoff

**Status:** ready to implement. All product decisions resolved 24 Aug 2026.
**Audience:** a fresh Claude Code session with no prior context. This document is self-contained.
**Audited at:** `magic-voice-core@0f6396e` · `magick-master@ce92ccb` · `magick-comms-cusui@04f59fd`

> Every `file:line` in this document was verified against source during the audit and re-verified
> after an independent architectural review. Line numbers may drift as you work — treat them as
> starting points, not gospel, and re-locate by symbol if a line looks wrong.

---

## 0. How to work on this

**Use subagents. This scope is explicitly designed to fan out.** Section 8 gives the orchestration
plan — read it before you start implementing, not after. The short version:

- Run **read-only recon agents in parallel** to map exact call sites before editing anything.
- Within each phase, run **independent workstreams as parallel subagents**, with a barrier before
  the dependent ones.
- Run an **adversarial review subagent** over each phase's diff before pushing.
- Do **not** spawn a subagent per trivial edit. Fan out on workstreams, not on lines.

---

## 1. Context

The MagickVoice platform is a superproject with three git submodules. **The two backends do not
share a database.** All coupling is HTTP plus a shared PostHog project.

| Repo | Role | Ports |
|---|---|---|
| `magic-voice-core` | Voice AI orchestrator: telephony, AI pipelines, IVR, messaging, knowledge bases | 3000, PG 5432, Redis 6379 |
| `magick-master` | Platform service: auth, RBAC, billing/credits, governance capabilities, scheduling. Proxies to core via `/proxy/*` | 3010, PG 5433, Redis 6380 |
| `magick-comms-cusui` | Customer React SPA. Talks only to master | Vite 5174 |

```
browser ──► cusui ──► master ──► core ──► carriers / AI providers
```

**Merge order for additive change is core → master → cusui.** Master fails closed on core calls and
the SPA is compiled against master's routes. Every phase below respects this. Do not reorder.

### Getting the code

The superproject's submodules are declared but may not be checked out:

```bash
git submodule update --init --recursive
```

If that fails on SSH auth in a sandboxed session, clone the three repos individually over HTTPS
from `github.com/sapieonic/{magic-voice-core,magick-master,magick-comms-cusui}` and work from those
paths instead. The submodule layout is not required for this work.

### The two products

The company sells **two products off one platform**:

- **Primary application** — AI voice agents, plus a single-user browser softphone.
- **Agency offering** — human-agent outbound power dialing: campaigns, agent stations, pacing engine.

They currently share a read path. **Your job is to separate them** so agency calls are only visible,
controllable and billable through agency surfaces, and primary-app calls only through primary-app
surfaces.

### Four independent gating layers

A feature needs all four aligned to be reachable. Know which one you are touching:

1. **RBAC** — `agent(5) → viewer(10) → operator(20) → account_admin(30) → tenant_admin(40) → tenant_owner(50)`, in master's `src/rbac/roles.ts`, mirrored in cusui's `src/utils/permissions.ts`.
2. **Governance capabilities** — frozen catalog in master's `src/governance/catalog.ts` with sparse DB overrides. Served at `GET /governance/effective`.
3. **Core feature flags** — via `GET /proxy/feature-flags`, defined in core's `src/feature-flags/registry.ts`.
4. **Route guards** — `RequireAuth` / `RequireCapability` / `RequireFlag` in cusui.

---

## 2. The problem

### Reported symptom

Clicking a specific call inside the agency workspace navigates the user out into the primary AI
application's call-history section. They lose the agency chrome, the campaign context, and the list
they were reading.

### Root cause chain

1. Two agency pages link an attempt's call to `/app/calls/dialer/history/:id`:
   - `cusui/src/pages/agency/AgencyCampaignAttemptsPage.tsx:519`
   - `cusui/src/pages/agency/AgencyContactDetailPage.tsx:388`
2. That route is mounted under `/app` inside `AppLayout` and gated on `calls.dialer` — a capability
   in the *primary app's* tree — at `cusui/src/App.tsx:365`.
3. The destination page hardcodes its breadcrumb back to the AI app's history:
   `cusui/src/pages/calls/WebRtcCallDetailPage.tsx:105-107`.
4. That history endpoint applies no scope filter, so it lists agency calls too — which is why "back"
   lands somewhere that looks almost right.

### The deeper cause

**There is no agency-native call-detail surface anywhere in the stack.** Core's agency attempt routes
are all writes (`disposition`, `notes`, `dnc`, `hangup`). Master's agency proxy has campaigns,
sessions, attempts, stats, staffing, ingest and DNC — and no call read at all. The link points into
`/app` because `/app` is the only place that endpoint exists.

The team already diagnosed this once and worked around it rather than fixing it — see the comment at
`cusui/src/components/agency/AgentAttemptsPanel.tsx:95-105`, which describes the exact trap.

### The shape of the leak

Separation was designed bottom-up and stops halfway.

| Layer | State |
|---|---|
| Shells (`AppLayout` / `AgencyLayout`) | ✅ Separate |
| Routes | ❌ Agency links cross into `/app` |
| Capabilities | ❌ Agency media gated by `calls.dialer` |
| Master proxy | ❌ No agency call-read surface |
| Core API | ❌ No scope filter on any `webrtc_call` route |
| Usage reporting | ❌ Agency folded into `webrtc_calls` |
| Billing / settlement | ✅ Correctly split |
| Data model | ✅ One table, by design |

**The fix is a read-path predicate, not a schema change.**

---

## 3. Resolved decisions

These were settled by the product lead. **Follow them as given. Do not reopen them.**

### Q1 — Agency owns the vocabulary, both nouns

"Dialer" and "campaign" both belong to the agency offering. The primary application gives up both.

- `/app/calls/dialer` → **Softphone**
- `/app/campaigns` → **Broadcasts** — the surface is a composer for unattended blasts to a contact
  list, with three kinds already labelled "AI call", "IVR Flow" and "Voice message". None is a
  campaign in the sense agency means; all three are broadcasts.

**Mechanism: display layer only.** Catalog labels, nav strings, page titles, and route paths with
redirects. **The capability keys `calls.dialer`, `calls.dialer.analytics` and `campaigns` stay
frozen.** Renaming them is a governance-override data migration across three repos that would still
leave `dialer_call_analysis`, `dialer_analysis_jobs`, `dialer_call.*` audit events and `webrtc_*`
telemetry unrenamed — you would pay a migration for partial consistency.

**A third collision to sweep:** "Dialer" is also used as a *carrier* label in the composer at
`cusui/src/pages/campaigns/registry/static.tsx:459` — `{ label: 'Dialer', value: VOICELINK_ALIAS }`.
Relabel it to something carrier-flavoured in the same pass.

### Q2 — DNC is agency-only

The primary application has no bearing on the concept. **This overrides the audit's recommendation**,
which argued for tenant-level compliance. The decision is deliberate.

No enforcement work in AI dispatch. But it carries a **mandatory copy obligation**: the DNC surface
currently presents itself as tenant-wide compliance and must stop. Narrow the page copy and the
global-search keywords to say agency dialing, and make the `source: 'regulator'` entry value read as
agency-scoped wherever it is surfaced.

This is the one item where the code is already correct and only the words are wrong.

### Q3 — Analysis profiles stay a shared primitive

Ship the OR-gate now: the profile list accepts `calls.dialer.analytics` **or** `agency.analytics`.
Do not promote to a neutral capability until a third consumer appears. Add a reference check so a
primary-app admin cannot silently delete a profile a live agency campaign depends on.

### Q4 — Usage splits from a dated boundary

No restatement. Historical figures on already-issued reports stay exactly as customers saw them.

Rows created **before** the boundary keep reporting under `webrtc_calls` regardless of `campaign_id`.
Rows created **on or after** it split into `webrtc_calls` and `agency_calls`. Implement the boundary
as a single configured date constant, not a hardcoded literal, and set it to the date Phase 1b
deploys. Settlement is untouched — it was always priced correctly.

---

## 4. The three-zone model

**Write this into `docs/agency-dialer-design.md` as §7b before any code moves.** Without it,
"everything of dialer stays in dialer" is not implementable — because `/app` is not one thing.

| Zone | Contains | Rule |
|---|---|---|
| **AI product** | AI voice agents, prompts, IVR, softphone + its history, broadcasts, static calls, knowledge bases, messaging | Reads only `campaign_id IS NULL` calls. Gated under the `calls` tree. |
| **Agency product** | Campaigns, rosters, contacts, agent stations, the dialer, attempts, dispositions, activity, agency analytics | Reads only `campaign_id IS NOT NULL` calls. Gated under the `agency` tree. |
| **Platform — shared by design** | Team & membership (including inviting agents), credits/billing/invoices, tenant audit log, API keys, settings, onboarding, tenant/account switching | Serves both products. **Not** a boundary violation. Do not duplicate into the agency shell. |

The third zone is the one that gets misread. `AgencyLayout` deliberately holds no credits, team or
settings and links back to `/app` for them; **that back-link is correct and must survive**. A
pure-agency supervisor legitimately administers in `/app` and operates in `/agency`.

Also record in §7b: the `scope` enum's *meaning* is product ownership; `campaign_id` is an
implementation detail. The day agency grows an off-campaign dial mode (preview dialing, agent
callbacks), the fix is one predicate change, not a hunt through call sites.

---

## 5. Findings

Grouped by the layer that owns the fix. **A** = cusui, **B** = core, **C** = master, **D** =
cross-cutting, **E** = surfaced by architectural review.

### A — Presentation & routing (`magick-comms-cusui`)

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| A1 | High | Agency attempt rows link into the AI app's shell. *(Symptom of A2/C1 — cannot be fixed alone.)* | `src/pages/agency/AgencyCampaignAttemptsPage.tsx:519`, `src/pages/agency/AgencyContactDetailPage.tsx:388` |
| A2 | **Critical** | No agency-native call detail page exists | `src/App.tsx:257-341` — the `/agency` subtree has no call route |
| A3 | High | Call detail page hardcodes an AI-app breadcrumb | `src/pages/calls/WebRtcCallDetailPage.tsx:105-107` |
| A4 | Medium | "Dialer" names two products; "campaign" names two products | `src/App.tsx:167` vs `:363`; `/app/campaigns` vs `/agency/campaigns` |
| A5 | Medium | AI nav advertises a history containing agency calls | `src/components/layout/Sidebar.tsx:95-97` — resolves itself once B1 lands. **Agency entries already exist in global search at `GlobalSearch.tsx:48-50`; do not add duplicates.** |
| A6 | Low | Shared detail components carry primary-app defaults | `src/components/calls/CallDetailSections.tsx` |

### B — Data access & API scope (`magic-voice-core`)

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| B1 | **Critical** | Dialer history lists every agency campaign call — no `campaign_id` filter | `src/db/repositories/webrtc-call.repository.ts:104-143` |
| B2 | **Critical** | Agency recordings/transcripts readable at `viewer` level | `…repository.ts:95-102`; master `proxy-webrtc-call.routes.ts:139,225`; `roles.ts:83` (`proxy.calls.read` = `viewer`) |
| B3 | **Critical** | An `operator` can hang up a live agency call | core `src/api/routes/webrtc-call.routes.ts:310-330`; master `proxy-webrtc-call.routes.ts:258-275`; `roles.ts:82` (`proxy.calls.create` = `operator`) vs `agency.supervise` = `account_admin` |
| B4 | High | retry-analysis and DSAR erasure unscoped | `src/api/routes/webrtc-call.routes.ts:335, 400` |
| B5 | High | Recording stream and signed URL unscoped | `…webrtc-call.routes.ts:273, 287-308` |
| B6 | High | Usage reporting folds agency into the softphone line | `src/api/validators/usage.validator.ts:11`; `src/db/repositories/usage.repository.ts:234-239`; `src/api/exports/usage-export.ts:88` |
| B7 | Medium | Agency analysis rides the primary app's feature flag | `src/core/webrtc-bridge-manager.ts:1694-1725`; `src/feature-flags/registry.ts:374` |
| B8 | Medium | One retention window covers both products | `src/maintenance/retention-purge.ts:87-96, 333-365` |

> Note: `WEBRTC_LIST_COLUMNS` (`…repository.ts:36-50`) does not even *select* `campaign_id`, so the
> list cannot label a foreign row. Add it — it costs nothing.

### C — Gating & proxy surface (`magick-master`)

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| C1 | **Critical** | Agency proxy has no call-read surface | `src/api/routes/proxy-agency-{campaigns,agent,station,staffing,performance}.routes.ts` |
| C2 | **Critical** | Consent capability gates *enabling* recording, not hearing it | `proxy-agency-campaigns.routes.ts:318` vs `proxy-webrtc-call.routes.ts:139` |
| C3 | Medium | Profiles read/written under different capabilities | `proxy-call-analysis-profiles.routes.ts:26`; workaround documented at cusui `AgencyCampaignSettingsPage.tsx:87-96` |
| C4 | Low | `AGENT_ATTEMPT_QUERY_PARAMS` drops `phone` silently | documented at cusui `AgentAttemptsPanel.tsx:83-93` |

### D — Cross-cutting

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| D1 | High | Design contract covers the engine, not the read path | `docs/agency-dialer-design.md:1166-1228` (§7), `:1229-1320` (§8) |
| D2 | Medium | Nothing stops the next cross-shell link | only enforcement is a reviewer's prose comment |
| D3 | Medium | Agency depends on an object the primary app owns | cusui `App.tsx:366`; core `agency-campaigns.routes.ts:487` |

### E — Surfaced by architectural review

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| E1 | High | DNC presented as tenant-wide compliance, enforced agency-only | core `src/agency/pre-dial-gates.ts`, `dnc-registry.ts` are the only consumers; master `src/dispatch/run-dispatch.ts` has zero DNC references |
| E2 | Medium | "Campaign" as overloaded as "dialer" | `/app/campaigns` composer vs `/agency/campaigns` |
| E3 | Medium | `/app` is the platform console, not just the AI product | `TeamPage.tsx`, `/app/credits`, `/app/audit-log`, settings, onboarding all under `AppLayout` |
| E4 | Medium | Pure-agency tenant lands on an AI dashboard; onboarding has zero agency awareness | `src/pages/onboarding/OnboardingPage.tsx` — no agency references at all |
| E5 | Medium | Super-admin usage blind to the whole WebRTC family | `src/pages/super-admin/SAUsagePage.tsx:51-56` — only ai/ivr/static/messages |
| E6 | Medium | Credits UI shows raw settlement vocabulary | `src/components/credits/TransactionList.tsx:99-100` renders `reference_type` verbatim |
| E7 | High | Purged-call empty state is a hard requirement of A2 | rationale at `core/src/db/migrations/076_webrtc_agency_columns.sql`; comment at `AgencyCampaignAttemptsPage.tsx:512-517` |
| E8 | Medium | Telemetry has no product dimension | `src/analytics/events.ts:298-330` — flat event names, one shared PostHog project |
| E9 | Low | Audit taxonomy leans AI-ward | core `agency-campaigns.routes.ts:406` logs agency under category `'call'` |
| E10 | Low | No agency campaign-completion notification | master `src/notifications/job-completion.ts` covers bulk dispatch only |

---

## 6. The work

**One pull request per repo per phase.** Branch naming per repo convention.

### Phase 0 — Write the boundary down · `docs/` · ready

No code.

- [ ] Add §7b to `docs/agency-dialer-design.md` (after §7, ~line 1228): the read path is scoped by
      `campaign_id` at the repository, and each product reads its own calls through its own
      capability and its own shell.
- [ ] Record the three-zone model verbatim (§4 above), naming the platform zone as shared by design.
- [ ] State that the `scope` enum's meaning is product ownership and `campaign_id` is an
      implementation detail.
- [ ] Record the resolved Q1–Q4 decisions and their consequences.

**Done when:** a reader who has never seen this scope can tell, from the doc alone, which zone any
given surface belongs to.

---

### Phase 1a — Security patch · `magic-voice-core` · ship immediately

Small, reviewable in an afternoon, independent of everything else. Closes two live holes. **Do not
bundle this with the refactor.**

- [ ] Add a `campaign_id IS NULL` predicate to `findByIdScoped` and `listByTenant`. Inline for now —
      no signature change yet. `src/db/repositories/webrtc-call.repository.ts:95-143`
- [ ] Add `campaign_id` to `WEBRTC_LIST_COLUMNS`. `…repository.ts:36-50`
- [ ] Confirm all seven `/webrtc-call/*` handlers now refuse agency rows: list, detail, recording,
      recording-url, end, retry-analysis, erasure.
      `src/api/routes/webrtc-call.routes.ts:252, 260, 273, 291, 315, 338, 400`
- [ ] Tests: a row with `campaign_id` set 404s on every one of the seven; a row without one is
      unaffected on all seven.

**Done when:** an agency call is invisible and untouchable through `/api/v1/webrtc-call/*`, and the
existing WebRTC suites are green.
**Closes:** B1 B2 B3 B4 B5

---

### Phase 1b — Isolation refactor · `magic-voice-core` · after 1a + Phase 0

- [ ] Replace the inline predicate with a **required** `scope: 'dialer' | 'agency'` parameter on both
      repository reads. **No default value** — the compile errors are the audit checklist.
- [ ] Resolve every resulting `tsc --noEmit` error by pinning the correct scope at each call site.
- [ ] Add the agency-scoped read: `GET /api/v1/agency-campaigns/:id/attempts/:attemptId`, verifying
      campaign ownership. **Register auth middleware explicitly on the route plugin** — see trap 3.
- [ ] That read must return the attempt shell with a "call no longer available" marker when the call
      has been purged, **not a 404**. The link is deliberately un-FK'd and both sides purge
      independently (`src/db/migrations/076_webrtc_agency_columns.sql`).
- [ ] Usage: add an `agency_calls` offering; redefine `webrtc_calls` as `campaign_id IS NULL` **for
      rows created on or after the boundary date only** (Q4). Boundary is a configured date constant
      set to this phase's deploy date. `src/api/validators/usage.validator.ts:11`,
      `src/db/repositories/usage.repository.ts:234`, `src/api/exports/usage-export.ts:88`
- [ ] Retention: split the purge population by `campaign_id`; add a separate configurable agency
      window. `src/maintenance/retention-purge.ts:87-96, 333-365`
- [ ] Analysis gating: branch the enqueue gate on `campaign_id`; add an `agency_call_analysis` flag.
      `src/core/webrtc-bridge-manager.ts:1694-1725`, `src/feature-flags/registry.ts:374`

**Done when:** `npm run lint` passes with no defaulted scope anywhere, the new agency read returns a
purged-call shell correctly, and usage reports agency separately from the boundary date.
**Closes:** B6 B7 B8 · hardens B1–B5

---

### Phase 2 — Agency proxy surface · `magick-master` · after core ships

- [ ] Add `GET /proxy/agency/calls/:id` plus `/recording` and `/recording-url`, under
      `requireCapability('agency')`, with `agency.recording` gating media and `agency.analytics`
      gating transcript and summary, permission floor `agency.supervise`.
- [ ] Profile list: accept `calls.dialer.analytics` **or** `agency.analytics` (Q3).
      `src/api/routes/proxy-call-analysis-profiles.routes.ts:26`
- [ ] Add `phone` to `AGENT_ATTEMPT_QUERY_PARAMS`; make `forwardQuery` **reject** unknown keys rather
      than dropping them silently — the silent drop is the actual defect.
- [ ] Catalog **label** changes only (Q1): `'Dialer (WebRTC)'` → `'Softphone'`, campaigns label →
      `'Broadcasts'`. Keys stay `calls.dialer`, `calls.dialer.analytics`, `campaigns`.
      `src/governance/catalog.ts:23`
- [ ] Super-admin usage: expose `webrtc_calls` and `agency_calls` offerings — both missing today.
      `src/api/routes/super-admin-usage.routes.ts`

**Done when:** an agency call's recording is reachable only through an `agency`-gated route, and
support can answer an agency usage question.
**Closes:** C1 C2 C3 C4 · part of E5

---

### Phase 3 — Close the loop in the UI · `magick-comms-cusui` · after master ships

Only now does the reported bug get fixed.

- [ ] Extract a shared `CallDetailView` from `WebRtcCallDetailPage`. Breadcrumbs, vocabulary and role
      labels become **required** props so a new consumer cannot inherit AI wording by omission.
- [ ] Add `/agency/campaigns/:id/attempts/:attemptId` inside `AgencyLayout`, rendering the shared
      view against the new agency endpoint. `src/App.tsx` ~line 314.
- [ ] Render the purged-call state as a first-class empty state, not an error.
- [ ] Repoint the two cross-shell links. `AgencyCampaignAttemptsPage.tsx:519`,
      `AgencyContactDetailPage.tsx:388`
- [ ] Restore the recording link on `AgentAttemptsPanel` and the phone filter — both were removed as
      workarounds and are now safe. `src/components/agency/AgentAttemptsPanel.tsx:83-105`
- [ ] Add a `<WorkspaceExit/>` component as the **only** sanctioned `/app` reference in agency code,
      then a **Vitest** guard asserting no other `/app/` literal appears under `src/pages/agency/`,
      `src/components/agency/` **or `src/pages/campaigns/agency/`**. All three roots.
- [ ] Apply the Q1 renames: `/app/calls/dialer` → Softphone, `/app/campaigns` → Broadcasts, across
      routes (with redirects), nav, page titles and global search. Relabel the carrier-sense "Dialer"
      at `src/pages/campaigns/registry/static.tsx:459`. No capability-key changes.
- [ ] Super-admin usage page: add the two new offerings.
      `src/pages/super-admin/SAUsagePage.tsx:51-56`, `src/types/usage.ts`

**Done when:** clicking a call anywhere in the agency workspace keeps the reader inside
`AgencyLayout`, with a back-link to the campaign they came from — and the guard test fails if anyone
reintroduces a cross-shell link.
**Closes:** A1 A2 A3 A4 A5 A6 D2 E7 · rest of E5

---

### Phase 4 — Follow-through · all three · schedule separately

Real gaps, none blocking. Track them so nobody fixes one badly later.

- [ ] **DNC copy narrowing** (Q2: agency-only) — no enforcement work. Narrow page copy and search
      keywords so the surface stops presenting itself as tenant-wide compliance; make the
      `regulator` source value read as agency-scoped. `src/pages/agency/DncPage.tsx`,
      `src/components/common/GlobalSearch.tsx:50`
- [ ] **Landing by entitlement** — a pure-agency tenant logs in to an AI-centric dashboard, and
      onboarding has no agency awareness. Route the default shell on entitlement.
- [ ] **Credits presentation** — customers see `agency_connected_call: <uuid>`. Add product labels
      and a per-product rollup. `src/components/credits/TransactionList.tsx:99-100`
- [ ] **Agency campaign-completion notification** — none exists. When built, do **not** reuse the
      bulk-dispatch mailer's `/app` deep link. `master/src/notifications/job-completion.ts`
- [ ] **Telemetry product dimension** — add a `product: 'ai' | 'agency'` super-property set by shell.
      `src/analytics/events.ts:298-330`
- [ ] **Audit taxonomy** — reserve a product axis before anyone wants to filter by it.
- [ ] **Profile reference check** — the Q3 consequence.

---

## 7. Do not touch

These look like the disease this cleanup treats. They are not. Each was decided deliberately with
reasoning recorded in source. **Changing any of them is a regression.**

- **`webrtc_calls` stays one table.** No split, no foreign keys, ever. Both sides purge independently
  and a cascade in either direction would destroy the other's audit trail.
  → `core/src/db/migrations/076_webrtc_agency_columns.sql` — the comment is the contract.
- **`agency` stays a root capability.** Not a child of `calls`, which is `mandatory:true` and could
  never gate it. → `master/src/governance/catalog.ts:97-112`
- **The `agent` role stays at level 5.** Below `viewer`, deliberately. When an agent needs a read the
  floor blocks, add an agency-native route — never raise the level.
  → `master/src/rbac/roles.ts:6-26`
- **The billing split is already correct.** `agency_connected_call` at 25mc flat vs `webrtc_call` at
  250mc/min, with a cross-rate guard. Only the *reporting* is wrong.
  → `master/src/credits/settlement.service.ts:390-460`
- **The deliberate exits stay.** "Back to MagickVoice" and the agent landing exit are the platform
  zone working as designed. → `cusui/src/components/layout/AgencyLayout.tsx:52`,
  `cusui/src/pages/agency/AgentHomePage.tsx:358`
- **`RequireCapability` fails open on purpose.** Master's 403 is the real enforcement. Do not
  "harden" it. → `cusui/src/components/auth/RequireCapability.tsx`
- **Two shells, not one.** `AgencyLayout` and `AppLayout` stay separate, and the agency shell does
  not grow its own credits, team or settings.

---

## 8. Subagent orchestration

**Use subagents throughout.** This scope has clean seams and a lot of independent verification work.

### Ground rules

- **Recon before edit.** Read-only agents mapping call sites in parallel is nearly free and prevents
  the most common failure mode: editing one of three places.
- **Fan out on workstreams, not on lines.** A subagent per file edit is waste.
- **Isolate parallel writers.** If two agents will edit the same repo simultaneously, give each its
  own git worktree (`isolation: "worktree"` on the Agent tool). Otherwise they will collide.
- **Every implementing agent runs `npm run lint` (which is `tsc --noEmit`) before reporting done.**
- **Review before push.** One adversarial agent per phase, given §7 (Do not touch) and §9 (Traps) as
  its checklist.

### Phase-by-phase plan

**Phase 0** — single agent. Nothing to parallelize; it is one document.

**Phase 1a** — one implementing agent, one verification agent in parallel.
- *Implementer*: the predicate + column + tests.
- *Verifier* (read-only, spawned at the same time): independently enumerate every reader of
  `webrtc_calls` across core and report any path the implementer's seven routes miss. Cross-check
  its list against the implementer's diff before pushing.

**Phase 1b** — fan out five workstreams. W1 is a barrier; W3/W4/W5 are fully independent and can run
concurrently with it. W2 depends on W1.

| | Workstream | Depends on |
|---|---|---|
| W1 | Required `scope` param + fix all call sites | — |
| W2 | New agency-scoped attempt/call read endpoint | W1 |
| W3 | Usage offering split + dated boundary | — |
| W4 | Retention window split | — |
| W5 | Analysis flag branch + `agency_call_analysis` | — |

Run W1, W3, W4, W5 in parallel (worktrees), barrier, then W2, then a review agent over the combined
diff.

**Phase 2** — fan out four; only the first depends on core's W2 being merged.

| | Workstream | Depends on |
|---|---|---|
| M1 | `/proxy/agency/calls/*` routes + capability gating | core W2 |
| M2 | Profile list OR-gate | — |
| M3 | `phone` param + `forwardQuery` strictness | — |
| M4 | Catalog labels + super-admin usage offerings | core W3 |

**Phase 3** — C1 is foundational; the rest fan out after it.

| | Workstream | Depends on |
|---|---|---|
| C1 | Extract `CallDetailView` with required props | — |
| C2 | New agency route + page + purged-call state | C1, master M1 |
| C3 | Repoint links + restore panel affordances | C2 |
| C4 | `<WorkspaceExit/>` + Vitest guard | — |
| C5 | Q1 renames across routes/nav/search/composer | — |
| C6 | Super-admin usage page offerings | master M4 |

Run C1, C4, C5 in parallel; barrier; then C2; then C3 and C6.

### Review agent prompt (reuse each phase)

> You are reviewing a diff for the agency scope-isolation work. Read `docs/agency-isolation-handoff.md`
> sections 7 (Do not touch) and 9 (Traps). For the diff at hand, report: (a) any violation of the
> do-not-touch list, (b) any trap the implementer fell into, (c) any read of `webrtc_calls` left
> unscoped, (d) any capability key renamed. Verify claims against source; do not take the diff's
> comments on trust. Report findings with `file:line`, most severe first.

---

## 9. Ten traps this scope invites

Stated because each is a known, likely failure mode — not hypotheticals.

1. **Splitting the table or adding foreign keys**, because the shared table looks like the problem.
   → `webrtc_calls` stays one table. Migration 076's comment is the contract. No FKs, ever.
2. **Giving `scope` a default value**, because that type-checks everywhere immediately — and silently
   un-audits every call site. → Required parameter, no default. The compile errors are the checklist.
3. **Shipping the new core route unauthenticated.** Core's auth middleware is registered
   per-route-plugin, not globally, so omitting it fails silently. **This exact mistake already shipped
   once** on the roster-ingest route (fixed in `6978183`, memorialized in the header comment of
   `core/src/api/routes/agency-dnc.routes.ts` — read it before writing the new plugin).
4. **Repointing the cusui links first**, because that is where the visible bug is — producing 404s
   worse than the current mis-navigation. → The `/app` links stay until Phase 3.
5. **Over-applying "everything separate"** — purging agency events from the tenant audit log, cloning
   team/credits/settings into the agency shell, deleting the deliberate exit links, or "fixing"
   `RequireCapability`'s fail-open behaviour. → Read §4 and §7 before removing anything.
6. **Renaming capability keys.** → Labels and routes rename. `calls.dialer`,
   `calls.dialer.analytics` and `campaigns` are frozen.
7. **Raising the `agent` role level** the first time a level-5 floor blocks a wanted read. This is the
   single most tempting shortcut in the scope. → Never. Add an agency-native route instead.
8. **Missing `src/pages/campaigns/agency/`** when applying any "agency code" rule, because the path
   says campaigns. → Agency code roots are `src/pages/agency/`, `src/components/agency/`, **and**
   `src/pages/campaigns/agency/`.
9. **Re-deciding Q1–Q4.** They are settled (§3). Implement what was chosen.
10. **Adding an ESLint rule for the Phase 3 guard.** There is no ESLint anywhere in the platform.
    → `npm run lint` is `tsc --noEmit`. The guard must be a Vitest test.

---

## 10. Environment notes

- **A missing `.env` fails unit tests**, not just `npm run dev`. Both backends validate config with
  Zod at import and the schema is pulled in transitively by many test files. Copy `.env.example` in
  each repo first.
- **Core's integration-test Postgres is on 5433, which collides with master's *dev* Postgres.** Do
  not run core integration tests and master's dev stack at the same time.
- **`npm run lint` is `tsc --noEmit`** in all three repos. No ESLint, no Prettier anywhere.
- **Core's dev server is port 3000**, not 3005. Several READMEs and CLAUDE.md files still say 3005
  and are stale.
- **`npm test` runs unit tests only.** Integration and smoke suites are excluded and need Docker up
  first (`npm run test:integration:up`).
- **Commits belong in the submodule, not the superproject.** A cross-service change is one PR per
  affected repo.
- Both backends `process.exit(1)` on invalid config at startup, so a config mistake surfaces as an
  immediate exit rather than a runtime error.
- Single test: `npx vitest run test/unit/<path>` · `npx vitest run -t "<name>"` ·
  `npx vitest run -c vitest.config.integration.ts test/integration/<file>`

---

## 11. Start here

1. Read §1–§4. They are the whole context.
2. Do Phase 0 — it is one document and it unblocks the vocabulary for everything else.
3. Start Phase 1a immediately and in parallel; it depends on nothing.
4. Read §8 before beginning Phase 1b, and fan out from there.

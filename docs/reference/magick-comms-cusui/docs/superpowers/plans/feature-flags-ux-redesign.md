> **Reference copy, verbatim below this box.** Origin: magick-comms-cusui @ `ee5beb44` (v2.96.0), path `docs/superpowers/plans/feature-flags-ux-redesign.md`. Copied into Magick Agency on 2026-10-09; not kept in sync.
>
> **How this maps to Magick Agency:** The UX design behind the feature-flags pages, ported into agency's super-admin app (`SAFeatureFlagsPage`, `TenantFeatureFlags`).
>
> Index of all copies: [`docs/reference/README.md`](../../../../README.md).

# Feature Flags — Super Admin UX Redesign

_Status: in progress · Owner: platform UI · Branch: `claude/feature-flags-ui-redesign-78erm6`_

## Why

Feature-flag administration today is capable but lives behind the wrong door. The
full flag table is buried as the 6th section of a long, single-scroll tenant
detail page (Credits → Phone Numbers → Service Config → Concurrency → **Flags** →
Members). Two consequences:

1. **No flag-centric home.** To answer "what flags exist on the platform, and
   what are their defaults?" an admin must open a random tenant. The registry
   catalog (`owner`, `type`, `client_exposed`, `description`, `default`,
   `env_default`, `global_override`) is invisible at the platform level.
2. **The global default is read-only in the UI.** The data model supports a
   `global` scope and `global_override`, but the only surface was a dead chip
   ("Global default — managed platform-wide"). The most powerful lever required
   editing env/DB.
3. **Wrong altitude.** "Roll this flag out to N tenants" was a modal nested
   inside _one_ tenant's page — mental-model-backwards.

## The two jobs

| | Job A — _flag owner_ | Job B — _account manager / support_ |
|---|---|---|
| Question | "What is this capability, what's its default, where is it live?" | "What's on for **this** customer, and flip it for them." |
| Model | **Flag-first** | **Tenant-first** |
| Surface | Global **Feature Flags** tab (new) | Feature Flags **tab** inside tenant detail |

## Information architecture (new)

```
Super Admin
├── Tenants
│   └── Tenant detail            ← now TABBED
│        ├── Overview  (status, credits, phone numbers)
│        ├── Service   (pipelines/providers + per-account concurrency)
│        ├── Feature Flags ◀── Job B: per-tenant / per-account tri-state only
│        └── Members
├── …
├── Feature Flags ◀── NEW sidebar tab — Job A: the registry
│        • catalog table (owner, type, client-exposed, description)
│        • inline GLOBAL DEFAULT tri-state (reason + optional expiry, audited)
│        • per-flag "Roll out…" → bulk enable/disable across tenants
└── Usage / Audit Log
```

## What shipped in this pass (Phases 1–2)

- **New `Feature Flags` sidebar tab + route** (`/super-admin/feature-flags`) →
  `SAFeatureFlagsPage`. The registry catalog is now a first-class, searchable,
  filterable page (by owner / type / client-exposed / search).
- **Editable global default.** Each boolean flag exposes an inline
  Inherit / On / Off control writing `scope_type: 'global'`. "Inherit" means the
  env or registry default; the sub-line attributes which. Every explicit write
  captures a required reason + optional expiry and is audited server-side
  (`updated_by`). Turning **off** a globally-on capability routes through a
  confirm gate (destructive, platform-wide).
- **Bulk rollout relocated** out of the tenant page to the registry, where it is
  flag-first: pick targets (tenant IDs), enable/disable, reason, audited.
- **Tenant detail is tabbed.** Feature Flags is its own tab; the cross-tenant
  bulk button is gone from here (it belongs to the registry). The per-tenant /
  per-account tri-state, source attribution, and confirm gate are unchanged.
- **Shared primitives** (`src/components/super-admin/feature-flags/`):
  `TriStateControl`, `OverrideReasonDialog`, `ConfirmDialog`, `BulkRolloutModal`,
  and pure `flagUtils` (`humanize`, `relativeExpiry`, `toTriState`). Both the
  tenant and global surfaces consume these — one control, two contexts, no
  duplication.

## Review hardening (post multi-persona review)

A four-persona review (engineering / product / QA / UX) drove a second pass:

- **Correctness:** the cross-tenant bulk flow now only offers **boolean + tenant-scopable** flags (the header button, the dropdown, and the row action all agree), so a `true/false` value can't be pushed to a number/string/json flag. Bulk tenant IDs are **de-duplicated**, per-tenant **failures are listed** (id + reason), and the submit button is **re-armed on edit** to prevent accidental double-applies.
- **Accessibility:** the Inherit/On/Off control implements the real WAI-ARIA radiogroup contract (single tab stop, Arrow/Home/End, roving `tabindex`), the active segment now has a **hue-independent** selected cue (ring + weight, not color alone), and the attribution sub-line is `aria-hidden` so the radio's name stays clean. All dialogs share one `FlagDialog` shell providing `role=dialog/alertdialog`, `aria-modal`, labelled title, **Escape-to-close, focus trap, and focus restore**.
- **Quality:** `humanize` now renders brand/acronym tokens correctly (`WhatsApp`, `IVR`, `TTS`, `API`, …); the registry uses the shared `ErrorAlert` (friendly copy + retry); the tenant tab is **deep-linkable** via a `?tab=` URL param; duplicated/dead CSS was removed; `relativeExpiry` never shows "in 0h".
- **Tests:** coverage grew from 15 → 34 flag-specific tests — `flagUtils` units, the global confirm→turn-off write, expiry-ISO conversion, load-error states, account-scope writes, bulk Disable/required-reason/dedupe/failure surfacing, and a tenant-detail tab-switch mount test.

> Note: the new registry page is intentionally **not** added to `GlobalSearch` — that index is scoped to the `/app` surface and rendered in the app TopBar, not the super-admin layout.

## Deferred — needs backend support (Phase 3)

These were intentionally left out because no endpoint backs them yet; building
them client-side would mean N-per-tenant fan-out or fabricated data:

- **Rollout footprint** on the registry ("On for 12 tenants / 3 accounts") —
  needs an aggregate override-count endpoint
  (e.g. `GET /super-admin/feature-flags/{key}/overrides`).
- **Flag detail page** with the full cross-tenant overrides table (value / reason
  / who / when / expiry) and a precedence ladder (Default → Env → Global →
  Tenant → Account). Same dependency.
- **Lifecycle nudges** — "fully rolled out → safe to retire", "N overrides expire
  within 7 days". Depends on the aggregate listing above.

Also deferred (product scope, not blocking v1):

- **Bulk "reset to inherited"** — there is no bulk DELETE endpoint, only bulk
  upsert; reverting a rollout in one action needs one. Today bulk Disable writes
  explicit `Off` overrides (not the same as inherit); per-tenant reset is
  available on each tenant's tab.
- **Tenant picker for rollout** (name resolution / validation) instead of pasted
  IDs, and an **effective-state column** on the registry — both quality-of-life,
  post-GA.
- **Non-boolean flag editing** — number/string/json flags stay read-only
  ("Set via API"); only boolean capability gates are editable in the UI.

When the aggregate endpoint lands, the registry row links into the flag detail
page and the footprint column fills in; nothing here needs to be undone.

## Data / API reference

- Catalog: `GET /super-admin/feature-flags` → `FeatureFlagCatalogEntry[]`
  (carries `global_override`, `default`, `env_default`, `scopes`, `owner`,
  `client_exposed`, `description`).
- Resolve (per tenant/account): `GET /super-admin/feature-flags/resolve`.
- Upsert override: `PUT /super-admin/feature-flags/{key}/overrides`
  (`scope_type: 'global' | 'tenant' | 'account'`).
- Delete override (→ inherit): `DELETE …/{key}/overrides`.
- Bulk: `POST …/{key}/overrides/bulk`.

Resolution precedence (first match wins):
`account → tenant → global → env → registry default`.

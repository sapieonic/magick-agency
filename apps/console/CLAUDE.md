# apps/console

Vite + React SPA for agents, supervisors and admins: the agent station, the soft phone
(`src/components/softphone`, `src/utils/softphone`), campaigns, roster, activity, DNC, analysis
profiles, team, invites and settings. Detail: `docs/architecture.md` "UIs", `docs/softphone.md` §7.

- Dev: `pnpm dev` on :5175. Firebase web config goes in `.env.local` (copy `.env.example`; Vite
  does not read the example). Use the same Firebase project as the server.
- Vite proxies every API prefix to :3021 (`API_PREFIXES` in `vite.config.ts`; `ws: true` on
  `/proxy` carries the station socket). A new top-level API segment must be added there, or the
  SPA fallback answers it with `index.html`. `src/__tests__/devProxyPrefixes.test.ts` guards it.
- Wire types come from `@magick-agency/contracts` (`src/api/`), permissions from its `rbac.ts`.
  Components, hooks and helpers that super-admin also needs go in `packages/web-ui`, not here.
- Sign-in has no self sign-up: `/agency/join/:token` (agents) and `/join/:token` (other roles)
  claim invites, and each redirects an invite whose role belongs on the other page.
- Signed-in URLs are `/t/:tenantId/a/:accountId/…` (B26): the prefix is the router's basename
  (`components/routing/ScopedRouter`, over `contexts/UrlScopeContext`'s history), so write routes
  and links WITHOUT it; `components/routing/ScopeGate` scopes or refuses everything signed-in.
  `/login`, `/agency/login`, `/join/:token`, `/agency/join/:token` and `/verify-email` stay
  unscoped (`isUnscopedPagePath`). Move between scopes only with `useUrlScope().go` or the
  `TenantContext` setters (a switch is a full page load at the new account's home, or at a
  `path` the caller names); react-router cannot leave its basename. `/t` and `/a`, not `/tenants`
  and `/accounts`: those are API prefixes in nginx and the Vite proxy.
- One shell (B28): every signed-in page except `/station` and `/dialer/*` renders in
  `components/layout/ConsoleLayout` (via `ConsoleShell`). Sidebar entries, section tab bars,
  breadcrumbs and Settings entries, each with its gate, are tables in `utils/consoleNav.ts`; add a
  page there, gated as its route is, and add its route to `navRouteGates.test.ts`, which checks
  every offer (sidebar, tabs, Settings, search) against the route it opens for every role and
  flag. A Settings entry carries `SETTINGS_GATE` (`AgentLanding` sends a dedicated agent away).
  Pages leave their own breadcrumbs out: on a phone the top bar's back arrow goes up one crumb.
  Settings pages live under `/settings/*`; `/app/<page>` only redirects there
  (`LegacyAppRedirect`), so never link to `/app/...` (`agencyShellBoundary.test.ts`).
  A page names what the URL cannot (a campaign's name) in the top bar's breadcrumb with
  `usePageCrumbs` (`components/layout/PageCrumbs.tsx`; campaign pages via `useCampaignCrumbs`,
  which takes the campaign in state and names it only when its id is the URL's). That is the
  only breadcrumb: a page does not render web-ui's `<Breadcrumbs>` as well.
- The router is a plain `<Router>`, not a data router, so react-router's `useBlocker` does not
  work. A form that must not be left with unsaved edits uses `hooks/useUnsavedChangesGuard`
  (campaign Settings and New campaign, with `UnsavedChangesBar` and its `LeaveUnsavedDialog`). It
  adds a blocker to the navigator's one stack (`utils/navigationBlockers.ts`, wrapped once by
  `UrlScopeProvider`); never patch the history's `push`/`replace`/`go` from a page. Back and
  Forward are held in `UrlScopeContext`'s one history listener, which asks the same stack: in
  Chromium a window `popstate` listener added later runs later, capture phase or not. A redirect
  that must happen whatever is unsaved goes through `useUrlScope().go(…, { force: true })`.
- One search (B28): the top bar's field and ⌘K open `components/common/GlobalSearch`, whose results
  come from `utils/consoleSearch.ts`. Pages are read from `consoleNav.ts`, so a new tab is found by
  its label with no extra step (add words to `PAGE_KEYWORDS` if people would type others, and keep
  a renamed page's old name there); a new Settings entry needs a `SETTINGS_SEARCH` row and a new
  campaign screen a `CAMPAIGN_TAB_KEYWORDS` row (`consoleSearch.test.ts` fails without either),
  naming only settings its page really has. Campaign Settings sections come from
  `campaignSettingsSectionsFor`, the rule the page itself shows them by. The same words drive the
  hub's "Find a setting" filter. A phone number runs `hooks/useCustomerSearchRun.ts`, shared with
  `CustomerSearchBox`.
- The campaign bar (`utils/agencyCampaignTabs.ts`, IN13/IN14) is grouped but flat: one tab per
  question. Campaign Settings sections are `utils/campaignSettingsSections.ts`; their ids are
  link anchors (`…/settings#<id>`), so rename a label, never an id.
- PostHog analytics in `src/analytics/`: anything carrying a token or PII in a URL is redacted in
  `redact.ts`, which also turns the URL scope into `/t/:tenant/a/:account`. The mobile app sends
  the same event names, so rename events on both sides.
- Brand pack in `brands/magick-agency/` (B17). The branding guard
  (`src/__tests__/branding/noParentBrand.test.ts`) must stay green.

## Tests

`pnpm test` from this directory. Two Vitest projects split by file name: `*.timezone.test.ts(x)`
(files that must leave UTC) and the rest. A file must match exactly one, or counts double. TZ is
pinned to UTC and the locale to en-US in `vite.config.ts` for the whole run, with `pool: 'forks'`
so the pins reach the workers. Do not move those pins into `test.env` or a setup file; they would
not take effect.

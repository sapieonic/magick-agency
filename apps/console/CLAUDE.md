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

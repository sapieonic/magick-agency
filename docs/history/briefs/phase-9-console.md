# Phase 9a: the console UI

You are the console agent of the Magick Agency build. You port cusui's agency surfaces into `apps/console`:
- the agent station and the supervisor views (the agency tree);
- auth, team and invites, and settings;
- the tenant/account context they sit in.

`apps/console` is a Vite + React scaffold today, with one smoke test.

**Read `docs/history/briefs/ground-rules.md` first. It is binding.** The rules on SQL and Postgres apply only where you touch the server, which you should not.

**Worktree:** `/Users/manasnilorout/Personal/Sapionic/magick-agency-ui-console`, branch `phase-9/console` (off `main`).

## Plan
- §1: one origin, so the browser talks to agency.
- §3.1:
  - the console bootstrap: `GET /accounts/mine`, the session payload's settings map replacing `governance`, and the feature-flags read;
  - path 4 of `/auth/session` refuses with `no_membership`, and the console must show that, not a sign-up;
  - invites.
- §3.2: per-account settings replace governance capabilities. `RequireCapability` reads the settings map, and the section-level `agency` gate is always on.
- §3.3: `credits_low` is removed from the health strip copy.
- §6: Vite + React + CSS Modules, cusui's stack.
- §8 Phase 9: "UIs: the console (agency tree plus auth, team, invites and settings) and super-admin. Port the ~75 agency vitest files plus the platform pages' tests."

## Source: cusui `magick-comms-cusui@ee5beb44`
- **Port:**
  - `src/pages/agency/**` and `src/components/agency/**`;
  - the agency hooks, utils and `src/types/agency*`, which the console should take from `@magick-agency/contracts/api/agency` where those already mirror them; see `packages/contracts/src/api/agency/CONTRACT-DIFF.md`;
  - the auth pages and `AuthContext` (Firebase, same project);
  - `TenantContext`;
  - team/members and invite pages, invite-claim;
  - the settings pages that apply to agency;
  - the layout and sidebar restricted to agency's sections;
  - `components/common` as needed;
  - the API client (`apiFetch`).
- **Do not port:** IVR, prompts, automations, bulk jobs and dispatch, campaigns (the AI ones, not agency campaigns), messaging, documents, schedules, escalation, dashboard (AI), calls (AI), billing and credits, phone-number BYOC, API keys, super-admin (another agent), and every AI surface.
- **API paths (decision B16):** the server serves cusui's existing paths (`/proxy/agency/...` etc.). Keep the paths and change only the API base and origin handling. Tenancy headers stay `X-Tenant-Id` / `X-Account-Id` with the Firebase bearer token.
- **Governance → settings:** cusui's `RequireCapability` and the `/governance/effective` read become reads of the session payload's settings map (`@magick-agency/contracts/api/platform/settings.ts`, lane A's `session-payload.ts`).
  - Keep the per-field recording and analysis checks in the campaign builder.
  - Feature flags come from `GET /feature-flags` (lane A).
- **Deviations:** remove `credits_low` copy and everything credits. The console-wire types gain the CONTRACT-DIFF fields the Phase 8 agent adds: `supervisor_hold` wrap-up hold, `callback_requested_at`, `deferred_hangup_ms`. Render them as master would have if it had them. If you're unsure, list the case and render the minimum.

## Tests
- Port cusui's vitest files for every module you port: the ~75 agency files plus the platform pages'. Same counts minus listed deletions.
- In `PORTING.md`, add a `## Phase 9 — console` section with a row per file: source `it(` count → ported count.
- Tests mock the API at the client boundary, as cusui's do.
- `pnpm lint` (tsc) and `pnpm test` in `apps/console` must pass, and `pnpm build` must produce `dist/`.
- **Not yours:** the Playwright happy path, the parity diff and the dark pilot. They need real Firebase sign-in, production data or vendor accounts, which the lead takes to Manas.

## Dependencies
Add cusui's runtime dependencies for what you port (`firebase`, the router and charting libraries, and so on), at cusui's major versions, in `apps/console/package.json`.

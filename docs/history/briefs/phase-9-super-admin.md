# Phase 9b: the super-admin UI

You are the super-admin UI agent of the Magick Agency build. You port cusui's super-admin console into `apps/super-admin`, a Vite + React scaffold today with one smoke test. It covers:
- login;
- tenants: create, detail and accounts;
- users: add to a tenant or account with a role, change role, revoke;
- phone-number inventory and assignments;
- per-account concurrency limits and settings;
- feature-flag overrides;
- usage counts;
- the super-admin list and its audit trail.

**Read `docs/history/briefs/ground-rules.md` first. It is binding.** The SQL and Postgres rules apply only if you touch the server, which you should not.

**Worktree:** `/Users/manasnilorout/Personal/Sapionic/magick-agency-ui-sa`, branch `phase-9/super-admin` (off `main`).

## Plan
- §3.4 is the feature list. Left out: SIP, bulk dispatch, dispatch lanes, AI telephony credentials and BYOC, and everything credits (top-up, deduct, reconcile, rate cards).
- §3.2: settings replace governance.
- §6.
- §8 Phase 9.

## Source: cusui `magick-comms-cusui@ee5beb44`
- **Port:**
  - `src/pages/super-admin/**` and `src/components/super-admin/**`;
  - `src/components/layout/SuperAdmin{Layout,Sidebar}*`;
  - `components/auth/RequireSuperAdmin.tsx`;
  - `SuperAdminContext`;
  - `src/api/super-admin.ts`, `superAdminUsage.ts` and `superAdminTelephony.ts` (the inventory parts only);
  - the super-admin hooks (`useSuperAdminTenant`, `useSuperAdminFleet`, `useSuperAdminUsage`);
  - the `components/common` pieces they use.
- **Delete:** `superAdminAlerts`, `superAdminReconcileCredits`, `ByocPhoneNumbersPanel`, telephony-provider CRUD (lane A deleted those routes), credits panels, and every AI and SIP surface. Delete them with their tests, and list each one.
- **The server side is done.** Lane A's routes are on main under `/super-admin/*`; read `apps/server/src/api/routes/super-admin*.ts` and their PORTING rows. Agency adds what master lacked:
  - the per-account settings endpoint (`super-admin-account-settings.routes.ts`: recording, analysis, `webrtc_max_duration_seconds`);
  - the usage-counts read (`super-admin-usage-counts.routes.ts`, window capped at 400 days).

  Build pages for both in cusui's style, with tests. Everything else ports from cusui. The UI uses `saFetch` with its own JWT in `sessionStorage`, as in cusui, never Firebase.
- Types come from `@magick-agency/contracts/api/platform/super-admin*.ts` where they mirror cusui's.

## Tests
- Port cusui's tests for every module you port, at the same counts minus listed deletions.
- In `PORTING.md`, add a `## Phase 9 — super-admin UI` section with per-file rows.
- `pnpm lint`, `pnpm test` and `pnpm build` must pass in `apps/super-admin`.
- Check every `saFetch` path your UI calls against the routes registered on main. Grep `apps/server/src/api/routes/super-admin*.ts` for the path, or better, add a small test that imports a path list. List any path the UI calls that the server lacks, and **report it rather than adding server code**.

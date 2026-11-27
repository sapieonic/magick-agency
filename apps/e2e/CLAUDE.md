# apps/e2e

The golden end-to-end suite: Playwright over the real server and the built UIs, with the carrier,
Firebase sign-in, mail, S3, AI and recordings simulated. Design, coverage and how to add a spec:
`docs/e2e.md`. On demand only: never wire it into `ci.yml`.

```bash
pnpm e2e                    # from the repo root: fresh DB, UI builds, stack, every spec
pnpm e2e --grep "<title>"   # Playwright args pass through; --skip-build reuses the last UI build
pnpm e2e:stack              # stack up and kept up; then from here:
E2E_STACK=up pnpm exec playwright test specs/05-core-call.spec.ts [--ui|--headed]
pnpm test                   # the simulator's own unit tests (no stack; these run in CI)
pnpm lint
```

- **No service code changes.** Vendors are redirected by the server's own settings (`src/env.ts`
  is its whole environment; `apps/server/.env` is never loaded) or by `src/server-preload.mjs`
  for hosts fixed in code. If a feature needs a vendor the simulator lacks, add it to `src/sim/`
  and point the server at it the same way; a seam change in the server is the last resort.
- **Customer behaviour comes from the number's last two digits** (`src/sim/voicelink.ts`,
  `PERSONA_BY_SUFFIX`; `phoneWithPersona()` in the fixtures). Keep the table in `docs/e2e.md` §2
  in step.
- **Seed through APIs, never SQL**; drive in the UI only what the spec is about. Every test gets
  its own tenant (`world`); specs must not depend on each other or on order.
- **No fixed sleeps** to wait for something to happen: wait on the UI or on `sim.*`. A sleep is
  only for proving something does not happen.
- `/super-admin/login` allows 5 a minute per IP: `src/run.ts` signs in once and hands the token
  over (E2E_SUPER_ADMIN_TOKEN, `.run/stack.json`); keep UI super-admin sign-ins to the specs about
  them.
- After each test every simulated call still live is hung up (`endLiveCalls` in
  `fixtures/test.ts`); still, end and file the calls a spec starts, as an agent would.
- The carrier is the server's test mock (`apps/server/test/mocks/voicelink`), imported, so a
  change there reaches this package's lint (CI runs it with the server's scope).
- Ports 3031 / 5185 / 5186 / 3041, database `magick_agency_e2e`, Redis db 15; `assertSafeTargets`
  refuses anything else, and a run holds a lock on its database (a second one refuses to start).
- Output: `playwright-report/` (HTML), `test-results/` (traces, videos, `results.json`),
  `.run/server.log`. All git-ignored.

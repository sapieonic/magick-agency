# Ground rules for every build agent (binding)

Read this before your brief. Your brief names your worktree, branch, test database and scope; everything here applies on top.

**Where you work.** Only your own git worktree of `/Users/manasnilorout/Personal/Sapionic/magick-agency`, at the path and branch your brief gives. Never touch the main checkout or another agent's worktree. Commit on your branch only, with scoped adds (`git add <paths>`). Never use `git add -A`, `git add .` or `git stash`. Commit after each coherent step. Commit messages: a conventional-commit subject, a blank line, then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` as the last line. Do not push, open PRs, touch GitHub, use any vendor console or account, or send email.

**Sources are read-only.** They are the git submodules of `/Users/manasnilorout/Personal/Sapionic/MagickVoice-platform`:
- `magic-voice-core` (v1.123.2, `4850d1d9`)
- `magick-master` (v3.24.0, `a1f0756a`)
- `magick-comms-cusui` (v2.96.0, `ee5beb44`)

Read them only via `git -C <submodule> show <sha>:<path>` (and `git -C <submodule> ls-tree -r --name-only <sha> <dir>`). Never modify, check out, stash or run tests in them; their tests would hit other stacks' databases.

**Read first, in this order:**
1. `docs/seams.md`: the path rule, lane-owned files and seams.
2. `CLAUDE.md`.
3. `docs/decisions.md`.
4. `packages/db/BASELINE.md`.
5. The lead's handoff log §8, the build log so far (now condensed into `docs/history/build-log.md`).
6. The plan, `/Users/manasnilorout/Personal/Sapionic/MagickVoice-platform/docs/agency-extraction-plan.md` v4.2, at the sections your brief names.
7. `/Users/manasnilorout/Personal/Sapionic/MagickVoice-platform/agency.md`, for domain invariants.
8. The existing lanes' sections of `PORTING.md`: what is already ported, and every "Phase 6" / "Phase 8" / "Phase 9" carry-forward they recorded for you. **Those carry-forwards are part of your scope.**

**Port verbatim.** Keep the same SQL, constants, comments (especially comments that give a reason) and tests. The only allowed changes are the plan's:
- hop collapses (S2S or proxy calls become in-process calls);
- re-keying onto `agency_calls`;
- removing billing, settlement and credits;
- deleting the VoBiz, SIP, softphone, BYOC and API-key paths;
- import paths forced by the path rule;
- whatever your brief explicitly authorises.

Every changed or deleted file, function or test gets a row in your section of `PORTING.md`: `source path@sha` → destination, `verbatim | modified | deleted`, and the reason. Every modification gets an equivalence test, and every deletion is listed.

**Fixed things.** These are lead-owned:
- `packages/contracts/**`
- `packages/db/migrations/**`
- `apps/server/src/seams/**`
- `apps/server/src/{app.ts,app-context.ts,index.ts}`
- `apps/server/src/config/{index,load,schema,env}.ts` and `config/blocks/base.ts`
- the shared infrastructure in `docs/seams.md` §4
- root config and CI

Edit them only where your brief explicitly authorises it. If something can't be met as written, or you need a column, method, type or config key that isn't there, **stop that item and report it**. Report what, why, and the exact source line that needs it. Don't adapt the contract, don't add a migration, don't work around it, and carry on with your other items. The lead answers through SendMessage.

**Tests are the evidence.**
- Port the source's tests for everything you port. Your evidence is the count Vitest prints, compared file by file with the source suite. Count the source's `it(`/`test(` cases yourself, including `it.each` rows.
- Run tests from inside the package directory (`cd apps/server && pnpm test`), never from the repo root.
- Never use `--reporter=basic`. It doesn't exist in Vitest 4, and it exits 0 having run nothing. A run with no printed counts is not a run.
- Repository, SQL and runtime tests run on the REAL Postgres: agency's test DB on port **5436**, and Redis on **6383**. Never point anything at 5432/5433/5434/6379/6380/6381; those belong to other stacks.
- Integration globalSetup **drops and re-migrates your database** on every run. Never run two integration runs at once in your worktree, and never leave a background run going.
- `pnpm lint` in each package you touch must pass. It typechecks tests too.
- Every plan §9 invariant you touch gets a test that fails if the invariant breaks. Where you claim a test guards something, mutation-check it: break the code, watch the test go red, then restore.

**Known traps.**
- Zod `.refine` runs on a dirty result after a failed `.regex`, so guard `BigInt`/`JSON.parse`/`Date.parse` inside refinements, or a 400 becomes a 500.
- Enumerate routes from Fastify's `onRoute` hook, never by grep.
- A parameter used in two SQL contexts must be typed at each use, or you get `42P08`. Only real Postgres catches this.
- An optional create-input field plus an explicit INSERT column list typechecks but silently drops the value.
- Wrapping a call changes its arity: forwarding an optional argument as `undefined` breaks `toHaveBeenCalledWith`.
- `src/config/index.ts` exits the process on invalid config. Tests get a complete env from `test/setup/unit-env.ts`.
- A non-UUID string reaching a `$1::uuid` or `uuid[]` cast is a `22P02`. Validate ids at the edge.
- Fire-and-forget DB writes in a test race the next test's `truncateAll`. Drain them; see `apps/server/test/helpers/drain-super-admin-audit.ts`.

**Your test database.** Your worktree has an untracked `.test-env.local.json` pointing integration suites at your own database and Redis db. Do not delete or commit it.

**Dependencies.** `pnpm install` has been run. Add a dependency only if a ported module needs one the source used, at the same major version as the source's package.json, in the right package.json. Say so in your report.

**Mid-flight.** The lead may message you: "phase 6 merged" or "phase 8 merged". When that happens, merge `main` into your branch (resolve conflicts, `pnpm install`), re-run your suites, and continue. If a merge conflicts in a lead-owned file, take main's side and tell the lead.

**Report back** under ~900 words. Include:
- the branch and final commit SHA;
- the exact test commands and their printed counts per package, beside the source suites' counts;
- every PORTING.md deletion and deviation;
- anything you stopped on, with source lines;
- anything you're unsure of.

Don't claim green without printed counts. "Green" from you is not evidence. The lead re-runs everything and runs an independent review of your exact head SHA before merging.

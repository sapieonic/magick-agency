> **Reference copy, verbatim below this box.** Origin: MagickVoice-platform (superproject) working tree: an untracked file, so no commit SHA; read on 2026-10-09, path `docs/agency-extraction-build-handoff.md`. Copied into Magick Agency on 2026-10-09; not kept in sync.
>
> **How this maps to Magick Agency:** The entry point the build session was given on 2026-10-08. Superseded by `docs/history/` (how the build was run) and `docs/status.md`. The plan it points to is frozen at `docs/history/extraction-plan-v4.2.md`.
>
> Index of all copies: [`docs/reference/README.md`](../../README.md).

# Magick Agency build: handoff

Written 2026-10-08, at the end of the planning session, to survive a context compaction.
It is the entry point for the session that builds `magick-agency`. **Read it top to bottom
before acting.**

## Read order

1. **This file.**
2. [`agency-extraction-plan.md`](agency-extraction-plan.md) **v4.2**, approved by Manas on 2026-10-08. It is the spec. §8 holds the phases and their exit gates.
3. [`../agency.md`](../agency.md) for the domain invariants; §3–§7 at least before touching the runtime or voice engine.
4. Visual guide (same content, for orientation): https://claude.ai/artifact/QGYFEW5dKP4mXgjyseWaQk

## Settled (do not relitigate)

- **Self-sufficient app,** with no runtime dependency on core or master.
- **Owns:** its voice engine (bridge + VoiceLink), its own VoiceLink capacity, analysis and transcripts, and identity data.
- **Same Firebase project.**
- **Super-admins** create tenants and add users.
- **No credits, billing or credit enforcement in v1;** metering is an open item.
- **AI calling** is out of scope.
- **Stack:** Node 22 + Fastify + TypeScript + raw `pg` + node-pg-migrate + Vitest; Vite + React for the console and super-admin UIs; pnpm workspaces.

## Open decisions: build with these defaults

Use the plan's recommended option and record each in `magick-agency/docs/decisions.md` as
"default, pending Manas". None of them blocks Phases 1–8.

| # | Default |
|---|---|
| 1 | Re-issue outstanding invites at cutover |
| 3 | Inbound to agency numbers: message + hang up |
| 4 | Abandon clip: uploaded file only, no TTS |
| 5 | No platform API keys |
| 6 | Create super-admins fresh |
| 2, 7, 8 | Numbers, cutover style, domain, freeze, rollback window: cutover concerns, leave open |

## Repo facts at handoff

- `/Users/manasnilorout/Personal/Sapionic/magick-agency`: remote `origin` = `https://github.com/sapieonic/magick-agency.git`, branch `main`, **no commits yet**.
- Local toolchain: Node 24.18, pnpm 10.30. Set `engines.node >=22`. Docker was **not running**; start it before integration tests.
- **Sources are read-only:**
  - `magic-voice-core` `v1.123.2`
  - `magick-master` `v3.24.0`
  - `magick-comms-cusui` `v2.96.0`

  All three are submodules of this superproject at `origin/main`. **Never modify them.** Read them at those SHAs, and re-check `git -C <sub> rev-parse HEAD` before trusting a line citation.

## How to run the build

### Order
1. **Lead does Phases 1 and 2 directly, or with one agent:** scaffold, CI, dev infra, the Grafana selector, `packages/contracts`, and the squashed baseline schema. These fix the wire contract and schema every lane builds against, so they **must land on `main` (a local commit) before any lane starts.**
2. **Lanes A–D in parallel** (plan Phases 3, 4, 5, 7). Each runs in its **own git worktree** of `magick-agency`, on its own branch, off the Phase 2 commit.
3. **Phase 6 (runtime)** after lanes B and C merge. **Phase 8 (API)** and **Phase 9 (UIs, parity, pilot)** follow.
4. Phase 10 (cutover) is not part of the build. Do not run any migration against a real environment.

### Lanes

| Lane | Plan phase | Scope | Model |
|---|---|---|---|
| A · platform | 3 | identity, tenancy, invites, RBAC, settings/flags, super-admin auth + API, notifications, audit, usage counts | Opus (security-sensitive) |
| B · domain + data | 4 | `packages/domain` pure modules; core's `agency.repository.ts`; DNC merged; ingest; staffing; activity | Sonnet (mechanical port), Opus reviewer |
| C · voice engine | 5 | bridge, VoiceLink adapter, audio, clips, token store, rate limits, the concurrency guard with reconcile + stale sweep | Opus |
| D · analysis | 7 | jobs, worker, runner, transcribers, LLM analysis, profiles, retention, signed playback | Sonnet, Opus reviewer |
| Review | each lane | adversarial review of the lane's diff against the plan and the source, before merge | Fable |

### Each lane brief must include

- The plan sections it implements.
- The exact source files (path@SHA).
- The `packages/contracts` types it must build against.
- Its exit gate, copied from plan §8.
- "Stop and report if the contract can't be met as specified; do not adapt it."
- The rules below.

## Quality rules (each was paid for once on this project)

1. **Port verbatim.** Same SQL, constants, Lua, comments and tests. Keep a `PORTING.md` ledger: one row per file, giving source `path@sha` → destination, `verbatim | modified | deleted`, and the reason. The only allowed changes are those the plan names (hop collapses, re-keying onto `agency_calls`, billing removal, VoBiz/SIP/softphone deletion). Each change gets an equivalence test or a recorded deletion.
2. **Test counts are the evidence.** A ported suite must report the same count as its source, minus deliberately deleted tests listed in `PORTING.md`. A run with no counts is no run. `vitest --reporter=basic` doesn't exist in Vitest 4 and exits 0 having run nothing.
3. **Run tests from inside the package directory.** `dotenv` resolves from cwd, and a wrong cwd fakes a `process.exit(1)` failure.
4. **Real Postgres for repository tests.** A mocked pool hides SQL drift. Agency's own ports are Postgres **5436** and Redis **6383**. **Never** point at 5432/5433/5434/6379/6380/6381; core's test suite once `flushdb`'d master's dev Redis.
5. **Typecheck the tests too.** Decide early: one `tsconfig` that includes tests, or a `tsconfig.test.json` that CI runs. `lint` must catch a broken test file.
6. **Wire contract first.** Lanes build only against `packages/contracts` and the baseline schema. A lane that needs a contract change asks the lead; it never edits contracts on its branch. Three individually correct lanes that didn't compose cost a full cycle on this project before.
7. **Scoped git only.** No `git add -A`, no `git stash` in a shared tree. Each lane commits only its own paths, in its own worktree.
8. **Verify, don't trust.** The lead checks each lane's diff and re-runs its tests before merging. A lane saying "green" is not evidence. Check the reviewed SHA against the branch head.
9. **Zod `.refine` runs on a dirty result.** Guard `BigInt` / `JSON.parse` inside refinements, or a 400 becomes a 500.
10. **Enumerate routes from the router** (the `onRoute` hook), never by grep.
11. **Invariants in plan §9 each get a test that fails if they break.** Port the existing ones; write the missing ones.
12. **Nothing leaves the machine without asking Manas:** no `git push`, no PRs, no GitHub settings, no vendor accounts, no messages. Commit locally.

## Definition of done for the first build session

- Phases 1 and 2 committed on `magick-agency` `main` (local), with CI config present and passing locally.
- Lanes A–D each:
  - merged to `main` after a Fable review with its blocking findings fixed;
  - with its plan §8 exit gate met and evidenced by test counts;
  - with its `PORTING.md` rows complete.
- A short status note in `magick-agency/docs/build-status.md`: phases done, test counts per package, deviations, open questions for Manas.
- A one-screen summary to Manas. Then stop before Phase 6 unless Manas says continue.

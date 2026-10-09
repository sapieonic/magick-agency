# Build history

**Historical.** This folder is the record of how Magick Agency was built: the frozen plan, the
build log and the briefs each agent was given. Nothing here is current guidance. Read it when
you need to know why something was done a certain way, or to audit a phase. For the current
state read [`../status.md`](../status.md); for the design read
[`../architecture.md`](../architecture.md).

## How the build was run

- **A lead session plus parallel lane agents.** The lead did Phases 1, 2 and 2b (scaffold,
  contracts, baseline schema, shared infrastructure) itself, because they fix the wire contract
  and schema every lane builds against. Then lanes ran in parallel: A platform, B1 domain + data
  from core, B2 domain + data from master, C voice engine, D analysis. After those merged:
  Phase 6 runtime, Phase 8 API, Phase 9a console and 9b super-admin. Last, two fix lanes:
  Manas's open-question rulings and B17 branding.
- **One git worktree per agent**, on its own branch, with its own test database and Redis db
  (`.test-env.local.json`), so no two agents ever shared a checkout or a database.
- **Fixed seams.** Lanes built only against `packages/contracts`, the baseline migration and the
  seam files ([`../seams.md`](../seams.md)). A lane that could not meet a seam stopped and
  reported; it did not adapt it.
- **Port verbatim.** Same SQL, constants, Lua, comments and tests as core v1.123.2 / master
  v3.24.0 / cusui v2.96.0. The only allowed changes were the plan's (hop collapses, re-keying onto
  `agency_calls`, billing removal, VoBiz/SIP/softphone deletion) and recorded decisions. Every
  ported file has a row in `PORTING.md`; every change has an equivalence or deletion test.
- **Merge gate**, for every lane: the lane reports; the lead checks the diff touches no lead-owned
  file; main is merged into the lane; an independent adversarial review of the exact head SHA
  (findings ranked blocking / non-blocking with `file:line` in port and source); blocking
  findings fixed and re-reviewed; the lead re-runs lint, unit and integration from inside each
  package and compares per-file counts with the source suites and the PORTING ledger; then
  `git merge --no-ff` into main.

## Commit SHAs

SHAs in these files, in `PORTING.md` and in `../decisions.md` refer to the full 252-commit build
history. That history is only in the local branch `main-full-history` (`17ac1b6`) on Manas's
machine. GitHub's `main` begins with one squashed commit, `e5be0c2`, whose tree is identical to
the build's final state, so those SHAs do not resolve on GitHub.

## Index

| File | What it is |
|---|---|
| [`extraction-plan-v4.2.md`](extraction-plan-v4.2.md) | The plan the build followed, verbatim, approved 2026-10-08 |
| [`build-log.md`](build-log.md) | Phase by phase: what merged, review outcome, lead re-run counts, notable fixes, process lessons |
| [`briefs/ground-rules.md`](briefs/ground-rules.md) | Shared binding rules for the session-3 agents (Phases 6, 8, 9) |
| [`briefs/common-rules.md`](briefs/common-rules.md) | The shared rules appended to the lane A–D briefs |
| [`briefs/final-lane-a.md`](briefs/final-lane-a.md), [`-b1`](briefs/final-lane-b1.md), [`-b2`](briefs/final-lane-b2.md), [`-c`](briefs/final-lane-c.md), [`-d`](briefs/final-lane-d.md) | The lane briefs as sent |
| [`briefs/lane-a.md`](briefs/lane-a.md), [`-b1`](briefs/lane-b1.md), [`-c`](briefs/lane-c.md), [`-d`](briefs/lane-d.md) | Earlier short versions of the lane briefs |
| [`briefs/phase-6-runtime.md`](briefs/phase-6-runtime.md), [`phase-8-api.md`](briefs/phase-8-api.md), [`phase-9-console.md`](briefs/phase-9-console.md), [`phase-9-super-admin.md`](briefs/phase-9-super-admin.md) | The session-3 briefs |

The briefs are kept as sent, with two kinds of edit made on 2026-10-09: paths to other briefs and
to the removed `docs/lead-handoff.md` / `docs/build-status.md` were repointed to this folder, and
paths to documents outside this repo were repointed to their copies under
[`../reference/`](../reference/README.md). Worktree paths and test database names in them
(`magick-agency-lane-a`, `magick_agency_test_p8`, ...) are as they were during the build and no
longer exist.

# Build log

**Historical.** This is the record of how the build went, phase by phase, condensed from the
lead's `docs/build-status.md` and `docs/lead-handoff.md` (both removed when this file was
written, 2026-10-09; read them in git history if you need the minute-by-minute log). Read it
to understand why the tree looks the way it does, or to audit a phase. For where the project
is now, read [`../status.md`](../status.md).

**Commit SHAs.** Every SHA below refers to the full build history, which lives only in the
local branch `main-full-history` (`17ac1b6`) on Manas's machine. GitHub's `main` starts from
one squashed commit (`e5be0c2`) whose tree equals the build's final state, so these SHAs do
not resolve on GitHub.

**Counts** are the numbers Vitest printed, run by the lead from inside each package directory.

## Sessions

The build ran over four lead sessions on 2026-10-08 and 2026-10-09. Sessions 1 and 3 ended
when credits ran out; every agent in them was killed. The next session confirmed no process
was still writing to any worktree before re-spawning agents fresh with their brief plus a
"you are resuming" addendum.

| Session | Work |
|---|---|
| 1 (2026-10-08) | Phases 1, 2, 2b by the lead; lanes A, B1, C, D launched in parallel |
| 2 (2026-10-08) | Lanes restarted after the kill; B2 written and launched; A, B1, B2, C, D reviewed and merged. Stopped for Manas as instructed |
| 3 (2026-10-08/09) | Manas: "Go ahead and start building the rest properly using sub agents". Phases 6, 8, 9a, 9b launched; 9b merged |
| 4 (2026-10-09) | Phases 6, 8, 9a merged; shutdown-order fix; final run |
| 4b (2026-10-09) | Manas ruled on the open questions; two fix lanes (open questions, branding) merged; final run |

## Phase by phase

| Phase | Merged | Review | Lead re-run at the merged head |
|---|---|---|---|
| 1 Scaffold | `8e91b04` (lead) | — | lint + unit + build green in every package |
| 2 Contracts + baseline | `4ce14bc`, `59d3a97` (lead) | — | contracts 69 unit; db baseline 58 integration (incl. Down→Up, trigger firing) |
| 2b Shared infrastructure | `5b2bbbf` (lead) | — | db 241 unit / 219 integration; server 152 unit / 9 integration |
| 7 Lane D analysis | `4f6f9e4` | `fab9a82`: no blocking; lead fixes `adfac49` | server 556 unit (+4 skipped) / 38 integration; db 281 / 250 |
| 4 Lane B1 domain + data (core) | merged (lead re-run on `aa734b2`, main with D merged in) | `35b3a17`: 1 blocking (no test for the `markDnc`/`insertMany` caller-client path), fixed `a24dc14` | domain 32; server 1420 unit (+4 skipped) / 350 integration; db 281 / 250 |
| 3 Lane A platform | `d17dfe3` (`--no-ff` of `b4383c6`) | `53400e6`: no blocking; 7 fixes | server 2516 unit (+4 skipped) / 679 integration; db 392 / 351; PORTING A.3 93/93 rows match |
| 5 Lane C voice engine | `d7a23f8` (`--no-ff` of `69c0d0a`) | `17ec275` and delta `17ec275..69c0d0a`: no blocking | server 3713 unit (+4 skipped) / 741 integration; db 404 / 417; PORTING lane C 72/72 |
| 4 Lane B2 domain + data (master) | `4d7e738` | `4badd19`: no blocking; 4 non-blocking fixed | server 4108 unit (+4 skipped) / 814 integration; db 404 / 417; B2 ledger 18/18 |
| 9b Super-admin UI | `5c8651a` (head `7737c2b`) | `cf68a94`: no blocking; 4 fixed | 23 files / 361 tests; build OK |
| 6 Runtime | `6baec61` (`--no-ff` of `7057910`) | `a6fe781` (source + tests) and delta to `7057910`: no blocking | server 4628 unit / 921 integration (89 files, 9 chaos suites); domain 50; observability 14; contracts 71; PORTING §6.4 50/50 |
| 8 API | `4be8de7` (`--no-ff` of `784c35c`) | `5d407a9`: 1 blocking (see below), fixed; deltas `5d407a9..0696e46` and `0696e46..784c35c`: no blocking | server 6275 unit / 1162 integration (104 files); contracts 73; lint ×7; server build OK; PORTING §8.5 82/82 |
| 9a Console UI | `41fbf7c` (`--no-ff` of `6f71dbe`) | `3290852` full, then two deltas to `6f71dbe`: no blocking | 215 files / 4363 tests; build OK; PORTING 232 rows sum to 4363 |
| Fix B17 Branding | `4946eac` (`--no-ff` of `38ef90f`) | `0f53d4b` and delta to `38ef90f`: no blocking; 5 non-blocking fixed | console 218 files / 4367; super-admin 24 / 366; server 295 files / 6281 |
| Fix OQ Open-question rulings | `45c4fd4` (`--no-ff` of `024202d`) | `cfdd22b` and delta to `024202d`: no blocking; `sslnegotiation` lead fix `85e0d4c` | server 6349 / 1172; db 409 / 417 |

Earlier milestone runs on main: `011420b` (end of session 2, lanes A–D) server 4108 / 814, db
404 / 417, domain 32, contracts 69, observability 6. `4e075a2` (end of session 4) server
6275 / 1162, db 404 / 417, domain 50, contracts 73, observability 14, console 216 files / 4364,
super-admin 23 / 361.

**Final full run on main `85e0d4c`** (lead, session 4b, `pnpm install --frozen-lockfile`): lint
clean (7 packages); server 6350 unit (298 files) / 1172 integration (105 files); db 409 / 417;
domain 50; contracts 73; observability 14; console 218 files / 4367; super-admin 24 / 366;
builds OK (server, console, super-admin). That tree is GitHub's `e5be0c2`.

## Notable findings and fixes, by phase

**Lane D.** Two security fixes over core: a per-hop redirect allow-list on the recording
fetcher (SSRF), and a tenant/account-scoped `findActiveSuccessor` (core's version is a
cross-tenant read; a later core PR should fix it). Lead fix: the retention purge also runs once
60 s after boot, because a nightly redeploy restarts the process more often than the daily
interval.

**Lane B1.** The DNC check scope was made a required argument (`accountId` / `campaignId`), so
it cannot fail open. Two source-verbatim flakes were seen once each and passed on repeat:
`agency-dnc-resurrection` T-RES-I7 (host `new Date()` against Postgres `now()`) and
`agent-transition-ordering` (µs timestamps compared at ms precision).

**Lane A.** Escalation audit of invites (issue/resend above own role, claim role from the stored
row only, wrong email, cross-tenant headers, single use and expiry): no real escalation; a
45-case real-Postgres suite. A one-off red was root-caused from the Postgres log to a deadlock
between a test's `truncateAll()` and the previous test's fire-and-forget audit INSERT; fixed with
a retry on `40P01` and an audit drain in the affected suites. Partition creation moved under
`SET LOCAL TIME ZONE 'UTC'`. Usage-count windows capped at 400 days (new behaviour, not master's).

**Lane C.** At merge the lead folded lane D's analytics stand-in into lane C's PostHog client
and added an integration test that a super-admin concurrency PUT reaches the guard through the
seam (dropping the wiring makes it 500).

**Lane B2.** Master's `supersedeRoster` called a core endpoint that never existed; the port keeps
refusing (decision B15).

**Phase 6.** `app.listen` moved after the bootstraps (core's order); completion notices drained on
`pacing.stop()` with a 30 s budget; voice now starts before agency.

**Phase 8.** The one blocking finding of the whole build: core's app-wide limiter keyed a
`tenant` bucket on an unauthenticated `x-api-key` header, so a random header per request
bypassed every per-route limit, including super-admin login (5/min). Agency has no API keys, so
the branch was dropped and a rotating-header test added. Also found: both audit loggers were
never started or flushed (rows waited for 100 to accumulate and were lost on stop); now started
and flushed in `bootstrap/platform.ts`. The session-ownership gap (Q8) was confirmed as a source
gap and pinned as current behaviour until Manas ruled.

**Lead fix after Phase 8** (`6cf3b1f`): shutdown closes HTTP before the lane stops, and the
SIGTERM/SIGINT handlers install before the bootstraps; both pinned in `runtime-boot-order`.

**Console.** The dev proxy lacked `/phone-numbers` (caller-ID picker empty under `pnpm dev`);
fixed with `devProxyPrefixes.test.ts`, which fails for any unproxied API segment.

**Fix lanes.** See [`../decisions.md`](../decisions.md) Q1, Q5–Q9, B17 and the other 2026-10-09
rulings, and `PORTING.md` "Open-question fixes" and §8.9 / §9.5 / §9.6.

## Process lessons the build paid for

- **A lane saying "green" is not evidence.** The lead re-ran every suite at the exact merge head
  and compared per-file counts against the PORTING ledger.
- **Review the exact head.** Once, lane A was merged on a review of `53400e6` plus the lead's own
  reading of the fix diff; the delta review came after the merge. Recorded as a slip.
- **Never two integration runs on one database.** Integration global setup drops and re-migrates
  the schema. A lead run collided with a reviewer's run on the same worktree DB and produced
  confident, wrong reds. Each worktree gets its own DB and Redis db (`.test-env.local.json`).
- **Commit before mutation checks.** Twice the lead restored a mutation with `git checkout
  <file>` while the real change was still uncommitted, and lost the change. Rule: commit, mutate,
  check red, `git checkout` back to `HEAD`.
- **Resumed agents remember nothing.** Every instruction given to a lane mid-flight had to be
  re-sent to its replacement; the handoff file listed them per lane for that reason.
- **Read sources at a pinned SHA** (`git -C <submodule> show <sha>:<path>`), never from a
  working tree that may have moved.

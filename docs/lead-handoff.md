# Lead handoff — resuming the build in a new session

Lead-owned. Rewritten by the lead whenever the state moves, so a fresh session can take over.
**Last updated:** 2026-10-08 18:20 IST, session 2 (resumed after session 1 ran out of credits
and every agent in it was killed). Main at `d38d3f6` plus the commit that adds this update.

## 1. What the user asked for (binding)

Manas's kickoff instruction, in substance:

- Build Magick Agency here. Read, in order: `MagickVoice-platform/docs/agency-extraction-build-handoff.md`,
  then `MagickVoice-platform/docs/agency-extraction-plan.md` (v4.2), then `MagickVoice-platform/agency.md` §3–§7.
- Phases 1 and 2 are done by the lead, committed locally on main.
- Lanes A (platform), B (domain + data), C (voice engine) and D (analysis) run as parallel subagents.
  - Each runs in its own git worktree and branch, on the model the handoff names: A Opus, B Sonnet, C Opus, D Sonnet. Reviews use Fable.
  - Each gets a self-contained brief and is told to **stop and report if the contract can't be met, not adapt it**.
- **Before merging any lane:**
  - get an adversarial **Fable** review of its diff against the plan and the source;
  - fix the blocking findings;
  - **re-run its tests yourself** and check the counts against the source suites and PORTING.md.
  - "A lane saying 'green' is not evidence."
- Keep `PORTING.md`, `docs/decisions.md` and `docs/build-status.md` up to date.
- **Rules:**
  - port verbatim;
  - real Postgres for repository tests;
  - never use other stacks' ports;
  - scoped `git add` only;
  - **no git push, PRs, GitHub changes or vendor accounts without asking Manas**;
  - start Docker if integration tests need it, and tell Manas if it won't start.
- **Stop after lanes A–D are merged.**
  - Then give Manas a one-screen summary: what's done, test counts per package, deviations from the plan, and questions.
  - **Do not start Phase 6 until Manas says so.**
- Commit footer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Sources are read-only. Read them with `git -C <repo> show <sha>:<path>`, never from the working tree:
  - core `magic-voice-core` v1.123.2 @ `4850d1d9`;
  - master `magick-master` v3.24.0 @ `a1f0756a`;
  - cusui `magick-comms-cusui` v2.96.0 @ `ee5beb44`.
  - All three are under `/Users/manasnilorout/Personal/Sapionic/MagickVoice-platform/`.

## 2. Where things are

| Thing | Location |
|---|---|
| Trunk | `/Users/manasnilorout/Personal/Sapionic/magick-agency`, branch `main` |
| Lane worktrees | `/Users/manasnilorout/Personal/Sapionic/magick-agency-lane-{a,b1,c,d}` |
| Lane branches | `lane-a/platform`, `lane-b1/domain-data`, `lane-c/voice-engine`, `lane-d/analysis` |
| Lane briefs (as sent) | `docs/briefs/final-lane-{a,b1,c,d}.md`; the short versions are `docs/briefs/lane-*.md` and `common-rules.md` |
| Seams, path rule, lane-owned files | `docs/seams.md` |
| Decisions and open questions | `docs/decisions.md` (B1–B12, Q1–Q7) |
| Port ledger | `PORTING.md` (one section per lane) |
| Infra | Docker compose project `magick-agency`: Postgres **5436**, Redis **6383**. Start it with `pnpm infra:up` from the trunk |
| Per-worktree test DBs | `.test-env.local.json` (gitignored) in each worktree. Postgres DBs: A `magick_agency_test_lane_a`, B1 `_lane_b1`, C `_lane_c`, D `_lane_d`. Redis dbs: A 2, B1 3, C 4, D 5. The trunk uses `magick_agency_test` / Redis db 1 |

## 3. State per lane (at the time of writing)

Session 1's agents were killed. Their last writes were at 18:12:27; session 2 confirmed at
18:15–18:20 that no file in any worktree had moved since and no vitest/node process ran there.

| Lane | Head | Agent state | Uncommitted in worktree |
|---|---|---|---|
| A platform | `5babd51` (20 commits; main **not** merged since `35e51ef`) | killed mid-work (with its helpers W1 identity, W2 invites, W4 super-admin); **session 2 restarts it** | `invites.routes.ts`, `user.routes.ts` (fail-closed hardening), `telephony-provider.repository.ts`, `account-settings.repository.ts`, `phone-number.repository.ts`; new `super-admin{,-account-settings,-feature-flags,-phone,-usage-counts}.routes.ts`, three validators, `usage-counts.repository.ts`, `invite-security-audit.test.ts`, `platform-onboarding.e2e.test.ts`, `test/unit/validators/` |
| B1 domain + data (core half) | `35b3a17` (= `55ff545` + main merged by Manas) | **finished** | none |
| C voice engine | `a55da18` (15 commits; main **not** merged since `7e511e1`) | killed mid-work; **session 2 restarts it** | none (the five `test/unit/core/` files, the scenarios file and the PORTING ledger were committed as `b31ef1c`/`a55da18` before the kill) |
| D analysis | `fab9a82` (lead merged main into it) | **finished** | none |
| B2 domain + data (master half) | not started | brief **not yet written** | — |

Session 1 left these half-done (redo them, don't trust any partial result): lead re-run of B1,
Fable reviews of B1 and D.

### Lane B1 — finished; lead re-run and review pending

- Reported counts: `packages/domain` 32 unit; `apps/server` 1015 unit and 318 integration.
- Follow-ups from its report, to record and check in review:
  - Phase 6: `pre-dial-gates.ts:182` must pass the DNC scope (`accountId`/`campaignId`).
  - Phase 8: UUID validation before the `uuid[]` casts; `markDnc` transaction composition; the deferred formatter cases.
- Classifications it was unsure about (the review must rule on each):
  - `agency-analysis-flag-backfill` deleted;
  - `station-reconnect-frame` split;
  - the optional `insertMany` client argument.

### Lane A — still owed (session 2 addendum)

Invites escalation tests (a)–(f) below; audit partition maintenance (create **and** drop, citing
the source test cases); the three D10 concurrency source guards; the `webrtc_max_duration_seconds`
writer; notifications; super-admin; usage counts; the full exit gate.

### Lane C — still owed (session 2 addendum)

Merge main (`a9e79a2` brings `utils/concurrency.ts`; lane C's own copy must go); implement
`getAccountCount` / `getDistributedAccountCount`; pin the five `verifyWsToken` outcomes (Q6);
the trustProxy PORT NOTE (present at `rate-limit.middleware.ts:254`, confirm); finish the carrier
fixture; meet the full exit gate.

### Lane D — finished; verified by the lead; review pending

- Lead re-run on `fab9a82`, from inside each package. All green:

  | Package | Suite | Result |
  |---|---|---|
  | `apps/server` | lint | 0 |
  | `apps/server` | unit | 44 files, 554 passed, 4 skipped |
  | `apps/server` | integration | 5 files, 38 passed |
  | `packages/db` | lint | 0 |
  | `packages/db` | unit | 15 files, 281 passed |
  | `packages/db` | integration | 22 files, 250 passed |

  - The 4 skips are the dimension-presets byte-identity cases. They read `apps/console`, which arrives in Phase 9.
- The lead counted the source test files: the core `it(`/`it.each` counts match the "source" column of PORTING.md's Lane D test table.
- **Pending:** the Fable adversarial review. One was launched in the old session; its result can't be carried over. Re-run it (§5, step 2).
- Security fixes already in: per-hop redirect allow-list (SSRF), scoped `findActiveSuccessor` (cross-tenant IDOR; core has the same bug at `call-analysis-profiles.routes.ts:393` and wants a later core fix).
- Waiting on Manas: the retention defaults (`AGENCY_RETENTION_DAYS` and `AGENCY_TRANSCRIPT_RETENTION_DAYS` are unset by default, so that half doesn't run), and `VOICELINK_RECORDING_HOSTS` (empty by default, so every recording fetch is refused).
- At lane C's merge, fold `apps/server/src/analytics/analysis-events.ts` (`trackDialerCallAnalyzed` and the LLM events, with a no-op client stand-in) into lane C's `analytics/{client,posthog}.ts`. Lane D did not add `posthog-node`.
- Phase 8 must pass the real auth (`profileAuth`) and `profileDependents` into `analysisPlugin`. The default refuses every request with 401.

### Instructions already given to the running lanes

A resumed lane agent does not remember these, so a new session must re-send them.

**Lane A**
- **Owns `apps/server/src/utils/concurrency.ts`.** It holds master's helpers plus core's `runWithConcurrency`, and is already on main as `a9e79a2`; dedupe the PORTING row at merge.
- **Owns audit partition maintenance:** both creating and dropping partitions, in `apps/server/src/audit/audit-partition-maintenance.ts`. For the drop half, cite the core `retention-purge.ts:489-540` and master `:349-400` test cases it ported, so they reconcile with lane D's "moved" rows.
- **Behavioural assert fix (done, `512fbb7`).** `assertBehavioralCapabilitiesForConfig(request, reply, config, target)` judges the campaign's account, and `config` must be the parsed object. The test suite has 52 cases. **B2 must import it**, not re-port it.
- **Invites hardening (in progress, uncommitted).**
  - Drop the `request.membership &&` short-circuit before `canManageRole` / `canManage…` in `invites.routes.ts` and `user.routes.ts`, so a missing membership fails closed with 403.
  - Audit and add a named test for every escalation path:
    - (a) issuing an invite for a role at or above the caller's;
    - (b) resending for a role at or above the caller's;
    - (c) the claim takes its role only from the stored row;
    - (d) a claim for a different email;
    - (e) a token used while the request headers name another tenant or account;
    - (f) single use and expiry.
  - Check the hook order (session → tenant context → requirePermission). The unauthenticated claim lookup must not reveal anything beyond what master's does.
  - Fix any real escalation and report it.
- **Still due from the brief:**
  - restore master's "audited call sites" guard at lane A's floor (`5a2c342` looks like it) and the three D10 concurrency source guards;
  - the `webrtc_max_duration_seconds` writer in `account-settings.repository.ts` (authorised, that column only, bounds 60..14400).

**Lane B1**
- The DNC check scope is **required** (`accountId` / `campaignId` `string | null`), so it can't fail open. It must show, with real-Postgres tests, that account- and campaign-scoped entries block a dial (done in `a35c7f0`; confirm).
- Audit every scoping and agent-ownership predicate in the repository against core's SQL.

**Lane C**
- `runWithConcurrency` is on main (`a9e79a2`). Merge main, delete the temporary resolver, and commit the importing files with no known reds.
- Implement `ConcurrencyControl.getAccountCount` and `getDistributedAccountCount` (seam §3.3; added by `0cd1ae8`).
- Keep `verifyWsToken` verbatim (Q6), and pin its outcomes in tests:
  - no Redis → accept;
  - stored token null → accept;
  - Redis error → accept;
  - wrong token → reject;
  - length mismatch → reject.
- `rate-limit.middleware.ts:249-251` wrongly says "the app sets `trustProxy: true`". Add a PORT NOTE that agency's `app.ts` doesn't set it (Q7).
- Don't create `apps/server/src/utils/concurrency.ts`; lane A owns it.
- Config keys claimed: `telephony`, `concurrency`, `rateLimit`, `s3`, `audio`, `staticCallTts`, `analytics`.

## 4. Before resuming: make sure the old session's agents are gone

Lane agents are subagents of the old session and don't carry over. If that session is still alive,
its agents may still be writing to the worktrees, and two agents in one worktree corrupt each other's
work. Check first:

```bash
ps -ax -o pid,command | grep -E "magick-agency-lane-" | grep -v grep
```

Also check each worktree's last commit time (`git -C <wt> log -1 --format=%cr`) and its file
mtimes. If anything is moving, stop and ask Manas to end the old session.

## 5. Next steps (in order)

1. **Re-establish each running lane.** For A, B1 and C, read the worktree's `git log main..HEAD`,
   `git status`, and its PORTING.md section, to see how far it got. Spawn a fresh agent on the
   lane's model, in that worktree. Its prompt is the full text of `docs/briefs/final-lane-<x>.md`,
   plus this addendum:
   - "You are resuming. Continue from the branch head."
   - The uncommitted files are yours from a previous run: review them, then finish or discard them.
   - The §3 instructions for that lane.
   - "Merge main first."
2. **Lane D:**
   - run the Fable adversarial review of `git diff main...lane-d/analysis` (prompt shape: §6);
   - fix the blocking findings: send them to a fresh Sonnet agent in the lane D worktree, or fix them yourself if small;
   - re-run the four suites and lint (§2 commands), compare with the counts above, and merge.
3. **For every other lane, use the same merge procedure:**
   1. The lane reports.
   2. Check `git diff --name-only main...HEAD` for lead-owned files (`docs/seams.md` §2). Only `pnpm-lock.yaml` and the lane's own files are acceptable.
   3. Merge main into the lane.
   4. Run the Fable review on the exact head SHA.
   5. Fix the blocking findings.
   6. Confirm the reviewed SHA is still the head; re-review if the fixes are large.
   7. Re-run lint, unit and integration from inside `apps/server` and `packages/db`, and any other touched package.
   8. Count the source tests (`git show <sha>:<test> | grep -cE "^\s*(it|test)\("`, plus `it.each` rows).
   9. Check the counts against PORTING.md.
   10. `git merge --no-ff` into main.
   11. Update `docs/build-status.md`.
4. **Merge order:**
   - D at any time.
   - A before C: not strictly needed now that `concurrency.ts` is on main, but C's PORTING row cites it.
   - At C's merge: the analytics fold, and confirm the bridge analysis-hook call sites.
   - B1 before B2.
5. **Write and launch lane B2** after B1 merges: master's agency half, model Sonnet.
   - Scope: ingest, staffing service, activity, agent identity, spine, campaign config/wire, stats enrichment.
   - It must import lane A's `assertBehavioralCapabilitiesForConfig` and `resolveInheritedBehavioralConfig`; no second copy.
   - It restores `CAMPAIGN_ACTIVITY_ACTIONS` and the two vocabulary assertions.
   - CSV uploads read `config.s3` (lane C's key). No new top-level config key without asking the lead.
   - It goes through the same review and merge procedure as the other lanes.
6. **After A, B1, B2, C and D are merged:**
   - run the full suite on main;
   - write the one-screen summary for Manas (§7);
   - **stop. Phase 6 waits for Manas.**

## 6. Fable review prompt (shape)

Use `model: "fable"`, general-purpose, read-only. Give it:

- the worktree, branch, head SHA, and the diff to review (`main...<sha>`);
- the plan sections, the lane brief path, `docs/seams.md`, `docs/decisions.md`, and the lane's PORTING.md section;
- the source repos and SHAs, read via `git show`;
- the port-verbatim rule and the list of allowed deviations for that lane;
- what to hunt:
  - logic or SQL drift from the source;
  - seam conformance;
  - security: scoping, auth defaults, SSRF, fail-open paths;
  - test counts and weakened tests;
  - real-Postgres coverage of the exit gate;
  - edits to lead-owned files;
  - config-key collisions;
  - runtime-only breakage.

Ask for findings ranked BLOCKING or NON-BLOCKING, each with `file:line` in the port and the source, a failure scenario and a fix, plus a "checked and fine" list.

## 7. Questions to put to Manas in the final summary

- **Q1:** Postgres TLS `rejectUnauthorized: false`, kept verbatim from core.
- **Q2:** there are 18 action error codes, not the 16 `agency.md` states.
- **Q4:** platform audit rows with `actor_type = 'api_key'` at cutover.
- **Q5:** cache invalidation is swallowed when Redis is down (verbatim from master).
- **Q6:** bridge and webhook tokens fail open (verbatim from core).
- **Q7:** `trustProxy` setting at deploy.
- **B7:** both audit tables kept.
- **B12:** the agency repository stays at core's path.
- **Lane D:** retention defaults; `VOICELINK_RECORDING_HOSTS`.
- **Core bugs found during the port, for later core PRs** (core is read-only during the build):
  - the unscoped `findActiveSuccessor`;
  - the core half of the carrier fixture.
- **Vendor-dependent exit gates not attempted:** a real VoiceLink call, and a real recording analysed (`docs/seams.md` §5).
- **Deferred:** the Grafana selector (B6).
- **Follow-up:** the pre-dial-gates call site must pass the DNC scope (Phase 6).
- **Audit retention on by default:** lane A ports master/core's policy verbatim: `auditPartitions.enabled: true`, `retentionDays: 85`, so a fresh deploy drops `audit_logs`/`platform_audit_log` partitions older than 85 days with no operator decision. Keep it, or turn the drop half off until you set the number (lane D's analysis retention is unset by default)?
- **Super-admin audit writes are fire-and-forget** (master's, verbatim): a failed INSERT loses the audit row silently. Await them later?
- **B15:** roster replace/clear keeps refusing (core never had the supersede endpoint). Build it later, or leave the console without replace/clear?
- **B13:** guard host counts live bridged calls (self-heal stays armed during calls). Lead decision; overrule if wanted.
- **Lane D review:** core nulls agency transcripts at 30 days by default; agency keeps them for ever while both retention vars are unset. Reviewer recommends core's 30.

## 8. Session 2 log

Newest last. Each line is a milestone committed on main with this file.

- 18:20 — handoff rewritten with the real state after session 1's kill (§3). Next: restart A and C;
  Fable reviews of D (`fab9a82`) and B1 (`35b3a17`).
- 18:35 — B1 re-run by the lead on `35b3a17`: lint clean in domain/db/contracts/server; domain 32 unit; server 1040 unit (main alone has 178, so B1 adds 862; the lane's 1015 was before main's +25) and 318 integration; db 243 unit and 219 integration (unchanged from main: B1's repository is in `apps/server`). All 60 ported-count rows in B1's PORTING tables match Vitest's per-file counts. No lead-owned files in the diff. Fable review running.
- 18:35 — decisions B13 (guard host counts live WebRTC calls) and B14 (one S3 module; B2 appends master's two functions) recorded. B2 brief written (`docs/briefs/final-lane-b2.md`): B2 depends on A (user repository, behavioural settings) and C (S3) as well as B1, so it starts with the A/C-independent modules and merges main as A and C land. Master's `supersedeRoster` calls a core endpoint that doesn't exist at `4850d1d9` (`agency.routes.ts:1827` calls it "future"); B2 must stop and report on it.
- Lane C helper reviewers (spawned by lane C) found weakened/wrongly-deleted cases in `webrtc-scenarios`, `webrtc-bridge-late-binding`, `webrtc-bridge-manager.bridged` and the guard-host tests; lane C has them. **Check they're fixed in C's Fable review.**
- 19:00 — **B1 Fable review of `35b3a17`: 1 blocking** (no test for the `markDnc`/`insertMany` caller-client path), fixed by the lead as `a24dc14` (2 unit + 2 real-Postgres cases, mutation-checked: dropping the `if (own)` COMMIT guard reds both) plus real-Postgres coverage of `countForCampaign`/`findByRetryIdempotencyKey`. Rulings and Phase 6/8/10 carry-forwards are in B1's PORTING section ("Lead review notes"). Re-run on `a24dc14`: lint clean; domain 32; server 1042 unit / 321 integration; db 243 / 219. Known flake: `agency-dnc-resurrection` T-RES-I7 (and one other, not captured) failed once in a full run and passed on 4 isolated + 2 full re-runs. Likely host-vs-Docker clock skew (`next_attempt_at = new Date()` against Postgres `now()`). Verbatim test; not blocking.
- Lane D Fable review of `fab9a82`: no blocking findings; non-blocking list being completed (the reply was truncated).
- Lane A helper findings (sent to lane A; **check them in A's review**): `super-admin-account-settings.routes.ts:94-102` read-then-write race against a concurrency PUT; `super-admin.routes.ts:1389-1391` no failed-audit row on a 500 (master `:1522-1527` writes one); `telephony-provider.model.ts` declares `live_transfer_enabled`, which the baseline lacks.
- 19:15 — **Lane D merged** (`4f6f9e4`). Review of `fab9a82`: no blocking findings. Lead fixes `adfac49`: the retention purge also runs once 60 s after boot; followed redirect hops are drained. Carried forward in D's PORTING section: transcript-retention default (question for Manas), `signRecordingUrl` default path and the unscoped profile read (Phase 8). Lane D's config keys added to seams §2.
- 19:15 — **Lane C finished** at `17ec275` (lane: server 1375 unit / 69 integration; db 255 / 285; observability 6). Fable review `review-c` running. Lane C's open points: the rate limiter is plugin-scoped (core's was global; Phase 8); `EXEMPT_PATHS` `/health`,`/ready` vs agency's `/healthz`,`/readyz`; 6 decoder-packaging tests wait for a Dockerfile. Analytics fold: lane D's events call `capture`/`isPostHogEnabled` from `analytics/client.ts`; trackers append to `analytics/posthog.ts`.
- 19:25 — **Lane B1 merged.** Lead re-run on `aa734b2` (main with D merged in): domain 32; server 1420 unit (+4 skipped) / 350 integration; db 281 / 250; lint clean. Known source-verbatim flakes (not port defects, seen once each in full runs, green on repeat): `agency-dnc-resurrection` T-RES-I7 (host `new Date()` against Postgres `now()`); `agent-transition-ordering` "strictly increasing `at`" (compares µs `clock_timestamp()` values at ms precision via `Date.getTime()`; core's assertion is identical). Next: write the B2 worktree and launch B2.
- 19:30 — **Lane B2 launched** (Sonnet) in `/Users/manasnilorout/Personal/Sapionic/magick-agency-lane-b2`, branch `lane-b2/domain-master` off `5a07a45`; test DB `magick_agency_test_lane_b2` created, Redis db 6. It does the A/C-independent modules first; **the lead must message it "lane A merged" / "lane C merged"** after each merge so it merges main and continues. A resumed session must re-send those if they were missed.
- 19:40 — **Lane C Fable review of `17ec275`: no blocking findings.** Bridge diff is only the allowed changes; guard host verbatim against all eight cited ranges; Q6's five outcomes pinned; §3.1/§3.2/§3.3 conform; fixture covers every parser case and classifier arm. Doc nits and Phase 8 carry-forwards (limiter `EXEMPT_PATHS` vs `/healthz`,`/readyz`; non-voice routes unlimited until the limiter is hoisted; hoist `@fastify/websocket`; Q7) sent to lane C to record. C waits for A's merge; at C's merge the lead re-runs its suites and does the analytics fold.
- 19:50 — Lane C nits fixed, head `8e1847e` (1375 unit). Lane B2 step 1 done at `f0dc693` (server unit 1741 + 4 skipped; 3 new real-Postgres suites). Supersede gap → decision B15 (keep refusing). B2 waits for the lead's "lane A merged" / "lane C merged".
- 20:05 — **Lane A finished** at `63f9b13` (lane: server 1269 unit / 336 integration; db 351 / 315; audited call-site floor 4, B2 to raise to 22). The lead merged main into it as `5fb0ba6` (package.json conflict: kept `jsonwebtoken` and `openai`; main's lockfile + `pnpm install`). Lane A is fixing its helpers' findings on top: failed-audit row on a 500, `live_transfer_enabled` model trim, and the settings read-then-write race (authorised: a toggles-only writer in `account-settings.repository.ts`). Next: Fable review of A's final SHA, lead re-run, merge A; then message B2 "lane A merged"; then C (with the analytics fold) and message B2 "lane C merged".
- 20:25 — **Lane A final at `53400e6`** (on the lead's main merge `5fb0ba6`): the 500 failed-audit row, the telephony-provider model trim, and the settings toggles race fixed with a toggles-only writer (`setRecordingAnalysisToggles`, real-Postgres race repro). Escalation audit (a)–(f): no real escalation; 45-case real-Postgres suite. Lead re-run: lint clean in all five packages; server 2512 unit (+4 skipped) = main 1420 + lane A 1092, 677 integration; db 389 = main 281 + A 108, 351 integration. One unexplained one-off failure (`super-admin.routes` "REFUSES a flagged owner_email"; green 3/3 alone and in 2 more full runs; a new test, not verbatim) is being root-caused by lane A, read-only. Fable review `review-a` of `53400e6` running.
- 20:40 — Lane A's one-off failure root-caused (Postgres log): a deadlock between the next test's `truncateAll()` TRUNCATE and the previous test's fire-and-forget super-admin audit INSERT (its FK check takes RowShareLock on `super_admins`). Test isolation only. Lead fix on main: `truncateAll` retries up to 3× on `40P01` (+3 unit cases; db unit now 284). Lane A to add an `afterEach` drain of pending audit writes in its 3 affected suites, folded in with review-a's findings. Optional hardening for Manas/Phase 8: master's super-admin audit writes are fire-and-forget (a failed INSERT loses the row silently); verbatim.
- 20:55 — **Lane A Fable review of `53400e6`: no blocking findings** (plus two helper sub-reviews: test counts match master for every security suite; notifications and partitions fine). Fix list sent to lane A: partition attach bound in UTC + separate create/purge try per table + afterAll cleanup; audit-write drain in 3 suites (the deadlock); usage-count span cap 400 days; agent-reach prefixes derived from the plugin; live-chain resend escalation case; dead `applyExplicitAudiencePreferences` note; PORTING A.1/A.3 nits. **Phase 8 / C-merge items:** `POST /auth/session` has no rate limit in the merged app (master's global limiter covered it; lane C's limiter is plugin-scoped); the concurrency seam is unwired until C merges, so a super-admin settings/concurrency PUT would 500 after committing. Assert the wiring at C's merge.

- 21:10 — **Lane A merged** (`d17dfe3`, `--no-ff` of `b4383c6`; main was an ancestor so the merged tree is `b4383c6`'s). Review fixes landed: partition create under `SET LOCAL TIME ZONE 'UTC'` with instant bounds (Kolkata real-Postgres case fails on the old code), create/purge in separate try blocks; super-admin audit drain in 3 suites (0 deadlocks in the Postgres log over two full runs); usage-counts window capped at 400 days (**new behaviour, not master's** — a deviation to report); route set derived from `PLATFORM_ROUTE_PREFIXES`; live-chain resend refusal case. Reviewer's "dead `applyExplicitAudiencePreferences`" was wrong (dynamic import in `suppressUnsubscribed`); note clarified. Lead re-run at `b4383c6`: lint clean; server 2516 unit (+4 skipped) / 679 integration; db 392 / 351; domain 32; contracts 69; observability 6. PORTING A.3: 93/93 rows match Vitest per-file counts. B2 told "lane A merged". Next: lane C (merge main, analytics fold, assert `setConcurrencyControl` wired in `bootstrap/voice.ts`, re-run, merge), then "lane C merged" to B2.
- 21:45 — **Lane C merged** (`d7a23f8`, `--no-ff` of `69c0d0a`). Lead at merge: main merged into C (`9fed1ad`; `package.json` union of `posthog-node`/`ws` and `uuid`, lockfile regenerated); **analytics fold** (`f7dbb13`): `trackDialerCallAnalyzed` → `analytics/posthog.ts`, `trackDialerTranscription`/`trackDialerLlmAnalysis`/`llmEnabled` → new `analytics/llm-observability.ts`, bodies byte-verbatim vs core; lane D's stand-in `analysis-events.ts` deleted; its test runs over the real client (`test/unit/analytics/dialer-events.test.ts`, 7). **Seam wiring asserted** (`e182842`, `integration/app/concurrency-seam-wiring.test.ts`): through `buildApp` with a real ctx, a super-admin concurrency PUT answers 200; dropping `setConcurrencyControl` makes it 500. Fable `review-delta`: no blocking on A's `53400e6..b4383c6` (reviewed after A's merge — the lead had merged A on the `53400e6` review plus own reading of the fix diff; recorded as a process slip) nor on C's `17ec275..69c0d0a`. Lead re-run at `69c0d0a`: lint clean; server 3713 unit (+4 skipped) / 741 integration; db 404 / 417; domain 32; contracts 69; observability 6; PORTING lane C 72/72. A first integration run collided with the reviewer's runs on the same worktree DB (global setup drops the schema) — **never let two agents run integration on one worktree DB at once.** Phase 8 carry-forwards from the review: hoist `initAnalytics()` above `app.listen` (core initialised PostHog before listen); partitions created by the old bare-date code under a non-UTC session keep their shifted bound (`existingPartitions` matches by name). The audited-call-site floor of 22 is Phase 8's (agency routes), not B2's — PORTING corrected (`52f231b`). B2 told "lane C merged". Next: B2's ingest service, then its Fable review, re-run, merge; then the final summary.
- 22:10 — **Lane B2 merged** (`4d7e738`). Fable review of `4badd19`: no blocking. Fixed: reason-carrying comments restored in `agency-activity.service.ts`, stale credits text in stats enrichment, S3 metric calls pinned (mutation-checked), Phase 6/8 carry-forwards in B2's PORTING section. Lead re-run at `4badd19`: lint clean; server 4105 unit / 814 integration; db 404 / 417; domain 32; contracts 69; observability 6; console 1; super-admin 1. At `4d7e738` (comment + unit test only, verified no non-comment source lines): server 4108 unit, lint clean. **All five lanes (A, B1, B2, C, D) are merged.** Phase 6 not started.
- 22:30 — **Build complete (A, B1, B2, C, D merged).** B2 ledger: 18/18 B2 rows match Vitest per-file counts. Final full run on main `011420b`: lint clean in all 7 packages; server 4108 unit (+4 skipped) / 814 integration; db 404 / 417; domain 32; contracts 69; observability 6; console 1; super-admin 1; `apps/server` build OK. §7 summary given to Manas. Stopped; Phase 6 waits for Manas.

## 9. Session 3 — Phases 6, 8, 9 (authorised by Manas: "Go ahead and start building the rest properly using sub agents")

- Briefs: `docs/briefs/ground-rules.md` (shared, binding), `phase-6-runtime.md`, `phase-8-api.md`, `phase-9-console.md`, `phase-9-super-admin.md`. Decision B16: the API serves the console's existing paths, with each core hop collapsed in-process.
- Split: Phase 6 owns the runtime plus the station socket handler; Phase 8 owns every HTTP route (non-runtime routes now, runtime routes after "phase 6 merged"); 9a console and 9b super-admin UIs port cusui. Merge order: P6 → P8 → UIs.
- Lead on main before launch: `@fastify/websocket` hoisted into `app.ts` (removed from `voice.plugin.ts`); voice-routes 7 + seam-wiring 2 + unit api 573 green.
- Agents (by name for SendMessage): `phase-6` (Opus), `phase-8` (Opus), `ui-console` (Opus), `ui-super-admin` (Sonnet). Worktrees `magick-agency-{p6,p8,ui-console,ui-sa}`, test DBs `magick_agency_test_{p6,p8,ui_console,ui_sa}`, Redis db 7/8/9/10.
- Not doable by agents (Manas): the Playwright happy path (real Firebase sign-in), the parity diff (a production snapshot), the dark pilot and real VoiceLink/recording exit gates (vendor accounts), Phase 10.
- Lead fixes on main during session 3: `7dc28e3` start voice before agency (core's order, asked by phase-6); `35b9c57` `initFeatureFlagService` in `buildApp` (flag reads were skipping the Redis snapshot cache; mutation-checked test); `979c8b5` master's read-only `GET /super-admin/telephony-providers` kept (POST phone-numbers needs `provider_id`); `4cb3e51` lane D's 4 unrunnable dimension-presets cases deleted (cusui's copy is AI-only). Rulings: phase-8's in-process `callCore` design approved with a static resolution test, context-only tenancy and per-family real-PG effects; master's errorHandler + 5xx mask app-wide; profiles re-prefixed to `/proxy/call-analysis-profiles`; flags stay at `/feature-flags`; `GET /phone-numbers` goes to phase-8.
- **Phase 9b super-admin UI merged** (`5c8651a`, branch head `7737c2b`). Fable review of `cf68a94`: no blocking. Lead re-run: lint clean, 23 files / 361 tests, build OK.

### Session 3 — state at pause (2026-10-09, credits ran out)

**Main:** `bb1e581` + this commit. Merged this session: Phase 9b super-admin UI (`5c8651a`). Lead commits on main: websocket hoist (`86520b9`), voice-before-agency order (`7dc28e3`), feature-flag service init in `buildApp` (`35b9c57`), read-only `GET /super-admin/telephony-providers` (`979c8b5`), lane D's 4 unrunnable dimension-presets cases deleted (`4cb3e51`), `agency.phone_numbers.read` in contracts (`bb1e581`).

**Every agent in session 3 is killed when the session ends.** Resume each with a FRESH agent: give it `docs/briefs/ground-rules.md` + its brief, plus "You are resuming a killed run. Review uncommitted files first (keep/finish/discard), read your PORTING section's resume notes, merge main first", plus the rulings below.

| Agent | Worktree / branch | Head at pause | State |
|---|---|---|---|
| phase-6 (runtime) | `magick-agency-p6` / `phase-6/runtime` | `03f4bd7` + 1 uncommitted file at pause (was interrupted mid-edit; main `979c8b5` merged as `033e2bd`; suites NOT re-run since) | **Lane reports DONE** incl. `runtime-e2e` (real app, station WS, real bridge, fake carrier: session→ready→reserved→bridged, disposition, wrap-up, analysis job via §3.2, attempt ends, campaign completes + completion notice). Lane counts: server unit 4625 (+4 skipped), integration 87 files / 916; domain 50; observability 14; 9 chaos suites (48 cases) green. Its branch predates main's `7dc28e3` (voice before agency) and `35b9c57` (flag-service init) — both already done on main; resumed agent must merge main again (now past `979c8b5`), re-run everything, and write the boot/stop-order test (plan in its PORTING resume notes: startVoice then startAgency without importing index.ts; runtime.start() after `runSelfHealSweep('startup')`; no pacing tick once agency stop begins, which finishes before `bridge.gracefulShutdown()`; mutation-check both). Collapse/notifier unit tests and reaper scrape are in (`6268844`); DNC fail-closed rewrite row + mutation check in PORTING. For phase-8: `getAgencyRuntime()`, `runtime.stations.connectedBySession`, `registerStationSocket` exported. New: `campaign-completion-notice.ts` (master's webhook body in-process, calls lane A's notifier; counts not sent). Then: Fable review of exact SHA, lead re-run + PORTING §6.4 ledger, merge, tell phase-8 "phase 6 merged". |
| phase-8 (API) | `magick-agency-p8` / `phase-8/api` | `8aeb10d` + **9 uncommitted files** at pause (never committed its WIP) | Non-runtime families in: DNC, campaigns (CRUD/config/stats/series/activity/spine/retry/ingest/lineage), staffing, performance, call read, core campaign/agent route suites; server unit 5344 (+4), integration 960 (75 files); limiter hoisted app-wide (EXEMPT `/healthz`,`/readyz`), lane A's duplicate limiter removed, `initAnalytics` before listen, `@fastify/multipart@^9.4.0`. Left: `GET /phone-numbers` (master `phone-number.routes.ts:64-160` GET only, BYOC half deleted, `agency.phone_numbers.read`, isolation test); errorHandler + 22P02→400 + errorMask 5xx branch app-wide (test: pg SQL text never in a body); profiles re-prefixed to `/proxy/call-analysis-profiles` with lane A auth; route-table test from `onRoute`; console-path coverage test; `callCore` static resolution test + spoofed-tenant test; test that login/invite per-route limits still apply; after phase 6 merges: runtime routes (sessions, ready/break/wrap-up/disposition, notes, station DNC, supervisor, start/pause/stop), station WS mount at the console path, `agency-agent-state-cycle`; audited-call-site floor 4 → 22; carry-forwards (B1/B2 UUID validation, ownership-before-activity-read, `from >= to`, ingest `account_id` from proven owner, identity consumer count 0 → 2, D's `signRecordingUrl`/profile read). |
| ui-console (9a) | `magick-agency-ui-console` / `phase-9/console` | `6b16cfc`, clean | Done except merge-time work. lint clean; 214 files / 4359 tests (bare `npx vitest run`, locale pinned in `vite.config.ts`, pool `forks`); build OK. 4633 source cases → 4320 kept, 313 deleted, + new. CONTRACT-DIFF fields rendered against a local copy `src/types/agency.ts` (revert to a re-export after Phase 8 merges, once Phase 8 adds the fields to contracts). **Fable review of `3290852` arrived: NO blocking** (480 unmodified files byte-identical to cusui; every modified diff matches its PORTING row). Next session: a delta review `3290852..6b16cfc` (locale pin in config + forks pool, the 3 CONTRACT-DIFF fields, mutation checks), then fixes. Non-blocking fixes to send the console agent: (1) delete the dead `VerifyEmailPage.tsx:87` `is_new ? '/onboarding'` ternary + PORTING row; (2) PORTING §9.1 "Test locale" must describe the config pin, not the script; (3) dead `DOCS_SLUGS` entries, unused `ENDPOINTS.tenants.base/get`/`accounts.get`, `Sidebar.tsx:259-265` `/app/calls` special cases. Branding (Manas decides before the pilot): add `brands/magick-agency/` as default `VITE_BRAND`; make "Back to MagickVoice" (`AgencyLayout.tsx:59`, `WorkspaceExit.tsx:87`, `AgentHomePage.tsx:371`) brand-derived; `ORIGINATOR` follows `brand.id` and the server ignores it. `agents_peak` has no producer (Phase 8: leave unserved, as master). The reviewer's list of every console path Phase 8 must serve: `/proxy/agency/*` (sessions, attempts, campaigns incl. csv exports/start/pause/resume/stop/retry/lineage/agents, ingest incl. multipart upload, my-*, agents stats, station WS `/proxy/agency/station/:sessionId`), `GET|POST /dnc`, `DELETE /dnc/:id`, `GET /phone-numbers` → `{ phone_numbers }` (floor now `agency.phone_numbers.read`, viewer), `/proxy/call-analysis-profiles` CRUD. Then review the delta, lead re-run, merge after Phase 8. Map `proxy.phone_numbers.read` → `agency.phone_numbers.read` at the caller-ID picker after merging main. |
| ui-super-admin (9b) | `magick-agency-ui-sa` | `7737c2b` | **Merged.** |

**Rulings given this session (binding on the resumed agents):**
- B16: the API serves cusui's paths; core route files become in-process handler modules behind phase-8's `callCore` (approved: static resolution test; tenancy from lane A's context only, never client headers; per-family real-PG effects). Master's unit suites may mock `callCore` where they mocked `proxyToCore`.
- Port master's errorHandler + errorMask 5xx branch app-wide; drop the core-4xx branch.
- Feature flags stay at lane A's `GET /feature-flags` (no `/proxy/feature-flags`); profiles move to `/proxy/call-analysis-profiles`; ask before re-prefixing more of lane A.
- Console: no `/api` prefix; dev proxy → :3021; permission renames per `rbac.ts`; `/app` index → Team/Notifications/DialerUnavailable (not `/agency`); `AgencyLoginPage`, no sign-up/onboarding; `no_membership` screen.
- Super-admin UI: routes at the root; credits/fleet pages deleted; usage-counts page; provider picked from `GET /super-admin/telephony-providers`.
- Never two integration runs on one worktree DB at once (global setup drops the schema) — including reviewers.

**New items for Manas's final summary:** `VOICELINK_RECORDING_HOSTS` empty by default = every recording play is a 502 (core noted its egress was firewalled from that host); the console keeps "Back to MagickVoice" copy, the `magickvoice` brand pack and `ORIGINATOR = magickvoice-customer-ui` (rebrand?); Playwright happy path, parity diff, dark pilot, real VoiceLink/recording gates and Phase 10 need Manas.

**Merge order still to do:** phase-6 → phase-8 → console. Each: Fable review of exact SHA, blocking fixed, lead re-run with printed counts, PORTING ledger vs Vitest JSON, `git merge --no-ff`, update `build-status.md` + this log.

## 10. Session 4 log (resumed 2026-10-09 00:10 IST after session 3 ran out of credits)

Newest last. Same rules and merge order as §9. Agents by name: `phase-6` (Opus), `phase-8` (Opus), `review-console-delta` (Fable). A new session must re-spawn them fresh (§9 resume recipe).

- 00:15 — Confirmed the old session is gone: no vitest/node process on any worktree, no file written after 00:09:16. Heads: p6 `03f4bd7` + untracked `runtime-boot-order.test.ts`; p8 `8aeb10d` + 4 modified / 4 untracked files and **no `## Phase 8 — API` section in PORTING.md at all** (told to write it); console `6b16cfc`, clean. Spawned fresh `phase-6` (merge main, finish the boot/stop-order assertion, re-run, per-file JSON) and `phase-8` (finish WIP, write its PORTING section, non-runtime leftovers incl. the three CONTRACT-DIFF fields into contracts, then wait for "phase 6 merged"). Fable delta review of the console `3290852..6b16cfc` running.
- 00:20 — **Console delta review `3290852..6b16cfc`: no blocking.** Lint clean; 214 files / 4359 tests (reviewer's run). Override differs from contracts only in the three CONTRACT-DIFF fields; `supervisor_hold` has no producer in core (contract-only); `confirmationCopy` relies on exact-instant echo. Fresh `ui-console` (Opus) spawned for the non-blocking fixes (VerifyEmail ternary, dead DOCS_SLUGS/ENDPOINTS/Sidebar cases, PORTING §9.1/§9.4 wording, `phone_numbers.read` mapping); it reports, then waits for "phase 8 merged" to revert the override to a re-export. Its fix commits need a delta review before merge.
- 00:55 — Console fixes done at `3a6d617` (on main `e569eb7`): 215 files / 4363 tests, PORTING 232 rows = per-file JSON. No permission gate added on the caller-ID picker (cusui never gated it); the rename lives in `agentPermissions.test.ts`. Waits for "phase 8 merged" (override → re-export), then one Fable delta review `6b16cfc..final`.
- 01:20 — **Phase 6 at `a6fe781`: Fable source + tests reviews, no blocking** (51 ledger rows vs core vs JSON, 0 mismatches; every runtime module verbatim modulo the listed collapses; DNC scope call exact). Lead re-run at `a6fe781`: lint 0 ×5; server 4626 unit / 89 files 920 integration; db 404 / 417; domain 50; observability 14; contracts 71. Non-blocking fixes sent to `phase-6` before merge: `app.listen` after the bootstraps (core :981 before :984; lead-authorised index.ts edit), completion notice drained on stop, e2e asserts the notifier and boots `startAnalysis`, deterministic M2, test hygiene/renames.
- 01:45 — **Phase 6 merged** (`6baec61`, `--no-ff` of `7057910`; merged tree = `7057910` + lead docs only). Fixes since `a6fe781`: `app.listen` after the bootstraps (core :977-984), completion notices drained on `pacing.stop()` (30 s, core's `WEBHOOK_FANOUT_DRAIN_TIMEOUT_MS`), e2e asserts the notifier and boots `startVoice → startAgency → startAnalysis`, deterministic M2, async `resetAgencyRuntimeForTests`. Delta review: no blocking. Follow-ups (non-blocking, core-shaped): a tick parked past the `stopped` guard can finalize after the drain (core has the same shape; fix = await in-flight ticks in `stop()`); 30 s drain vs an undefined container stop grace period (deploy concern); SIGTERM handlers install after the bootstraps (core :974-975 installed them before `agencyRuntime.start()`; lead-owned, for later). Lead re-run at `7057910`: lint 0 ×5; server 4628 / 921; db 404 / 417; domain 50; obs 14; contracts 71; §6.4 50/50 vs lead JSON. `phase-8` told "phase 6 merged" with rulings: `markDnc` one transaction (B8, B1's caller-client path); `supervisor_hold` contract-only; master's `from > to` rule; `support@magickvoice.com` and `agency.analytics` on all five profile routes listed for Manas.
- 01:45 — Phase 8 non-runtime half at `5d407a9` (server 5416 unit / 995 integration; contracts 73; PORTING §8.0–8.7 written). Three Fable reviews of `5d407a9` running (routes, app wiring, tests/ledger), read via `git show` so the agent's new commits don't move under them.
- 02:20 — **Phase 8 `5d407a9` reviews (routes, app wiring, tests/ledger): 1 BLOCKING** — the app-wide limiter keyed a `tenant` bucket on an unauthenticated `x-api-key` (core verbatim, but agency has no API keys), so a random header per request bypassed every per-route limit incl. `POST /super-admin/login` 5/min (master keyed on IP; its comment records this exact bug). Lead verified; fix sent (drop the API-key branch; 6-attempts-with-rotating-headers test). Non-blocking sent: lazy `connectedBySession`, master's `genReqId` (authorised `app.ts` edit), missing `X-Account-Id` → core's 400 not 403, PATCH-assert PORT NOTE, stale DNC comments, ledger fixes (ingest/upload row, `internal-agency.routes` 32 unaccounted, error-mask reason, 59→60), real `callCore` in my-campaigns, isolation cases for ingest-job reads / recording / CSV exports. Routes reviewer: every route file verbatim modulo the hop collapse; RBAC counts equal master's; audit sites 6/2/2. Tests reviewer: 60 rows vs JSON, 0 mismatches. For Manas: Q7 now bites every route (one shared IP bucket behind a load balancer; master used `trustProxyHops`); profiles widening (`agency.analytics` on all five routes).
- 03:05 — **Phase 8 at `0696e46`** (runtime routes, station socket at `/proxy/agency/station/:sessionId`, `markDnc` in one transaction, all `5d407a9` findings incl. the limiter blocking). Delta reviews (source, tests): **no blocking**. Session-ownership gap confirmed a **source gap, verbatim**: master sends no actor on station-token/available/break/break-cancel/leave and core's `requireOwnedSession` (:1340-1355) checks tenant/account/`left_at` only, so agent A holding B's session id can mint B's station token, supersede B's socket and receive B's next call's media. Pinned as "CURRENT BEHAVIOR"; top question for Manas (fix: owner check unless `agency.supervise`). Lead re-run at `0696e46`: lint 0 ×7; server 6273 unit / 1159 integration (103 files); db 404 / 417; domain 50; obs 14; contracts 73; build OK; §8.5 80/80 vs lead JSON. Last fix round sent (sibling-account recording isolation test, `suppressByPhone` client pin, audit buffer flush on stop, DNC-mark comment/log, public `maxParamLength: 200`).
- 03:50 — **Phase 8 merged** (`4be8de7`, `--no-ff` of `784c35c`; merged tree = `784c35c` + lead docs). Final round: sibling-account recording isolation leg real; `suppressByPhone` client pinned; **both audit loggers were never started or flushed** (rows waited for 100 to accumulate, lost on stop) — now started/flushed in `bootstrap/platform.ts` (master :320/:697, core :579/:903); public `maxParamLength: 200`; session-gap blast radius pinned (A's token opens B's station and receives B's `ready`). Final delta review: no blocking (latent: buffer `start()` not idempotent, no `unref`; inherited `forceFlush` microtask spin if a flush is in flight). Lead re-run at `784c35c`: lint 0 ×7; server 6275 / 1162 (104 files); db 404; domain 50; obs 14; contracts 73; build OK; §8.5 82/82 vs lead JSON. `ui-console` told "phase 8 merged" (override → re-export).
- 03:55 — Lead fix on main `6cf3b1f`: shutdown closes HTTP before the lane stops (core `http-close` :837 before `audit-flush` :903; master `app.close()` :689 before `auditLogger.shutdown()` :697), and SIGTERM/SIGINT handlers install before the bootstraps (core :974-975). Pinned in `runtime-boot-order`'s scrape; both mutations red.
- 04:40 — **Console merged** (`41fbf7c`, `--no-ff` of `6f71dbe`). Final delta review `6b16cfc..6f71dbe`: no blocking (override diff vs contracts comments-only; Sidebar `end` removal changes no highlighting; PORTING Phase 8 section byte-identical after the merge). Lead fix `4e075a2`: dev proxy lacked `/phone-numbers` (caller-ID picker empty under `pnpm dev`); added, with `devProxyPrefixes.test.ts` that fails for any unproxied `${API_BASE}/<segment>` (mutation red). Non-blocking left: `Sidebar.activeState` nested-path case uses an unrouted path; `isSectionActive`'s dead `/app` arm.
- 04:55 — **Session 4 done: Phases 6, 8 and 9a merged; full run on main `4e075a2` green** (clean checkout, frozen install): lint 0 ×7; server 6275 unit / 1162 integration; db 404 / 417; domain 50; contracts 73; observability 14; console 216 / 4364; super-admin 23 / 361; three builds OK. Q8 (session-ownership source gap) and Q9 (trustProxy app-wide) added to `decisions.md`. Process slip recorded: twice the lead ran `git checkout <file>` to restore a mutation while the real change was still uncommitted, losing it; both re-applied, committed, then mutation-checked against `HEAD`. Rule: commit before mutating. Remaining work needs Manas: Phase 10, Playwright happy path, parity diff, dark pilot, real VoiceLink/recording gates, the §7/§9/§10 questions.

## 11. Session 4b — Manas's rulings on the open questions (2026-10-09)

Rulings (numbered as in the session-4 final summary):
1. Q8 session takeover: seal with an identity check (owner, or `agency.supervise`).
2. Q9/Q7: port master's `TRUST_PROXY_HOPS` (default 1, min 1) into `trustProxy`.
3. `VOICELINK_RECORDING_HOSTS`: default `recording.app.voicelink.co.in` (real URL shape `https://recording.app.voicelink.co.in/client_1150/<date>/<uuid>.mp3`).
4. Branding: no MagickVoice linking anywhere user-visible.
5. `supervisor_hold`: Manas will revisit.
6. Shutdown drain vs grace period: lead gives a recommendation (not implemented).
7. §7 items: safe recommended defaults — Q1 verify TLS (`DB_SSL_CA`, explicit opt-out), Q5 revocations fail 503 after bounded retries where idempotent, Q6 refuse a missing token when Redis answered, transcript retention = core's default, super-admin audit failures logged; Q2/Q4/B6/B7/B12/B13/B15/85-day partitions kept as decided.
8. Gated items: Manas will revisit.

In flight: `fix/open-questions` (worktree `magick-agency-fix-sec`, DB `magick_agency_test_sec`, Redis 9) and `fix/branding` (worktree `magick-agency-fix-brand`, DB `magick_agency_test_brand`, Redis 10), both from `d383f11`. Same merge gate as before: Fable review of the exact head, lead re-run, `--no-ff`, build-status updated. Merge order: open-questions, then branding (merge main first).

- `fix/branding` merged at `4946eac` (head `38ef90f`, B17). `fix/open-questions` still running; it must merge main before its final run.
- `fix/open-questions` merged at `45c4fd4` (head `024202d`); lead fix `85e0d4c` (`sslnegotiation` refused in `DATABASE_URL`). Final full run on main `85e0d4c` green (see build-status). Still with Manas: #5 `supervisor_hold`, #6 (stop grace 45s in prod compose; whether to await the in-flight pacing tick), #8 gated items, Q3 contracts follow-ups. Note for master: Fastify ≥5.12 ignores a numeric `trustProxy` (master pins 5.8.4).

# Build status

Updated by the lead as phases land. To resume in a new session, start from `docs/lead-handoff.md`. Test counts are the numbers Vitest printed, run by the
lead from inside each package directory.

| Phase | State | Evidence |
|---|---|---|
| 1 Scaffold | done (`8e91b04`) | lint + unit + build green in every package |
| 2 Contracts + baseline | done (`4ce14bc`, `59d3a97`) | contracts 69 unit; db baseline 58 integration (incl. Down→Up, trigger firing) |
| 2b Shared infrastructure | done (`5b2bbbf`) | db 241 unit / 219 integration; server 152 unit / 9 integration |
| 3 Lane A platform | **merged** (`d17dfe3`); Fable-reviewed at `53400e6` (no blocking; 7 fixes to `b4383c6`); lead re-run at `b4383c6` | server 2516 unit (+4 skipped) / 679 integration; db 392 / 351; domain 32; contracts 69; observability 6; lint clean; PORTING A.3 93/93 rows match |
| 4 Lane B1 domain + data (core) | **merged**; Fable-reviewed at `35b3a17` (1 blocking, fixed `a24dc14`); lead re-run on `aa734b2` | domain 32 unit; server 1420 unit (+4 skipped) / 350 integration (incl. D); db 281 / 250; lint clean |
| 4 Lane B2 domain + data (master) | **merged** (`4d7e738`); Fable-reviewed at `4badd19` (no blocking; 4 non-blocking fixed) | server 4108 unit (+4 skipped) / 814 integration; db 404 / 417; domain 32; contracts 69; observability 6; lint clean |
| 5 Lane C voice engine | **merged** (`d7a23f8`); Fable-reviewed at `17ec275` and delta `17ec275..69c0d0a` (no blocking); lead at merge: analytics fold, seam-wiring suite; lead re-run at `69c0d0a` | server 3713 unit (+4 skipped) / 741 integration; db 404 / 417; domain 32; contracts 69; observability 6; lint clean; PORTING lane C 72/72 rows match |
| 7 Lane D analysis | **merged** (`4f6f9e4`); Fable-reviewed at `fab9a82` (no blocking), lead fixes `adfac49` | server 556 unit (+4 skipped) / 38 integration; db 281 unit / 250 integration; lint clean |
| 6 Runtime | **merged** (`6baec61`, `--no-ff` of `7057910`); Fable-reviewed at `a6fe781` (source + tests, no blocking) and delta `a6fe781..7057910` (no blocking) | lead re-run at `7057910`: server 4628 unit / 921 integration (89 files, 9 chaos suites); db 404 / 417; domain 50; observability 14; contracts 71; lint clean ×5; PORTING §6.4 50/50 rows match per-file JSON |
| 8 API | **merged** (`4be8de7`, `--no-ff` of `784c35c`); Fable-reviewed at `5d407a9` (routes, app wiring, tests: 1 blocking — limiter `x-api-key` bucket rotation — fixed), delta `5d407a9..0696e46` (source + tests, no blocking), delta `0696e46..784c35c` (no blocking) | lead re-run at `784c35c`: server 6275 unit / 1162 integration (104 files); db 404; domain 50; observability 14; contracts 73; lint clean ×7; server build OK; PORTING §8.5 82/82 rows match per-file JSON |
| 9a Console UI | **merged** (`41fbf7c`, `--no-ff` of `6f71dbe`); Fable-reviewed at `3290852` (full), `3290852..6b16cfc` and `6b16cfc..6f71dbe` (no blocking); local CONTRACT-DIFF override reverted to a re-export; lead fix `4e075a2` (dev proxy `/phone-numbers` + guard test) | lead re-run at `6f71dbe`: lint clean, 215 files / 4363 tests, build OK; PORTING 232 rows sum 4363 |
| 9b Super-admin UI | **merged** (`5c8651a`); Fable-reviewed at `cf68a94` (no blocking; 4 fixed in `7737c2b`) | apps/super-admin lint clean, 23 files / 361 tests, build OK |
| Fix B17 Branding | **merged** (`4946eac`, `--no-ff` of `38ef90f`); Fable-reviewed at `0f53d4b` (no blocking; 5 non-blocking fixed) and delta `0f53d4b..38ef90f` (no blocking) | lead re-run: at `0f53d4b` server 6280 unit / 1162 integration, console 4360, super-admin 365, lint ×7, builds OK; at `38ef90f` (tests/html/config only) console 218 files / 4367, super-admin 24 / 366, server 295 / 6281, contracts 73, lint clean, builds OK |
| Fix OQ Open-question rulings | **merged** (`45c4fd4`, `--no-ff` of `024202d`); Fable-reviewed at `cfdd22b` (no blocking; 5 non-blocking fixed) and delta `cfdd22b..024202d` (no blocking; `sslnegotiation` lead fix `85e0d4c`) | lead re-run: at `cfdd22b` server 6341 / 1172, db 409 / 417, lint ×7, build OK; at `024202d` server 6349 / 1172, lint, build OK |
| 10 Cutover | not part of the build | |

**Final full run on main `85e0d4c`** (lead, session 4b, `pnpm install --frozen-lockfile`): lint clean (7 packages); server 6350 unit (298 files) / 1172 integration (105 files); db 409 / 417; domain 50; contracts 73; observability 14; console 218 files / 4367; super-admin 24 / 366; builds OK (server, console, super-admin).

Previous: Final full run on main `4e075a2` (lead, session 4, clean checkout, `pnpm install --frozen-lockfile`): lint clean (7 packages); server 6275 unit / 1162 integration (104 files); db 404 / 417; domain 50; contracts 73; observability 14; console 216 files / 4364; super-admin 23 / 361; builds OK (server, console, super-admin).

Previous milestone run on main `011420b` (session 2, lanes A–D): server 4108 / 814; db 404 / 417; domain 32; contracts 69; observability 6.

## Deviations from the plan so far

See `docs/decisions.md` B6 (Grafana selector deferred), B7 (both audit tables kept), B8 (DNC
collapse design), B9 (lane B split), B12 (agency repository stays at core's path). Vendor-dependent
exit-gate items (real VoiceLink call, real recording analysed) are not attempted: `docs/seams.md` §5.

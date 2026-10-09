# Status

Where Magick Agency stands, in detail: what each plan phase reached and the evidence for it,
the last test counts, what is on GitHub versus only on Manas's machine, what is not built,
what is still open and with whom, and what to do next. Read it before planning any work on the
repo, or before talking to Manas about "is it done". As of 2026-10-09.

## Summary

The code side of the plan is built: phases 1 to 9 of
[the v4.2 plan](history/extraction-plan-v4.2.md) are merged, every suite is green, and Manas's
rulings on the open questions are implemented. Nothing has run against a real carrier, a real
Firebase sign-in, production data or a real environment. Phase 10 (cutover) was never part of
the build, and the gated exit-gate items need Manas (vendor accounts, real data).

## Phases

| Plan phase | State | Evidence |
|---|---|---|
| 0 Decisions, vendor lead time, baselines | **Not done** (needs Manas) | No vendor accounts were requested; §7 decisions built with defaults (see [decisions §2](decisions.md#2-plan-7-decisions)); no environment measured |
| 1 Scaffold | Done, except the Grafana selector | Monorepo, CI, dev infra on 5436/6383/3021/5175/5176, Zod config that exits on invalid input. The Grafana `local.agency` selector is deferred to the superproject (B6) |
| 2 Contracts + baseline schema | Done | `packages/contracts`; `packages/db/migrations/0001_baseline.sql` with its inventory in `packages/db/BASELINE.md`; baseline integration suite incl. Down→Up and trigger firing |
| 3 Lane A platform | Done | Session paths 1–3 and the path-4 `no_membership` refusal, invites, RBAC, settings, flags, super-admin, notifications, audit, usage counts; 45-case invite escalation suite |
| 4 Lane B domain + data | Done (B1 core, B2 master) | Ported counts match the source suites minus listed deletions (`PORTING.md` lane B tables); repository tests on real Postgres |
| 5 Lane C voice engine | Done on the agency side | Bridge, VoiceLink, guard, sweeps. Not done: the carrier fixture's core half (a core PR), and one real call on a VoiceLink sandbox (needs the account) |
| 6 Runtime | Done | 9 chaos suites under `apps/server/test/integration/agency/chaos/`; `runtime-e2e` (real app, station socket, real bridge, fake carrier); `runtime-boot-order` |
| 7 Lane D analysis | Done, except the real-recording gate | Runner skip/resume/truncation/backoff tests; transcript nulling at the retention day. Not done: one real recording analysed (needs vendor keys) |
| 8 API | Done | Route-table tests enumerated from Fastify's `onRoute` hook (`apps/server/test/unit/api/route-table.test.ts` and siblings) cover every console and super-admin path |
| 9 UIs, parity, dark pilot | UIs done; the rest needs Manas | Console and super-admin ported with tests. Not done: Playwright happy path (real Firebase), production parity diff, dark pilot |
| Fix lanes (OQ, B17) | Done | Open-question rulings and branding, each mutation-checked (`PORTING.md` "Open-question fixes", §8.9, §9.5, §9.6) |
| 10 Cutover | **Not part of the build** | Nothing built; see "Not built" below |

Phase-by-phase merge SHAs, review outcomes and intermediate counts are in
[`history/build-log.md`](history/build-log.md).

## Test counts

Final full run by the lead on 2026-10-09, on the tree that is now GitHub's first commit, after
`pnpm install --frozen-lockfile`. Counts are what Vitest printed, run from inside each package.

| Package | Lint | Unit | Integration | Build |
|---|---|---|---|---|
| `apps/server` | clean | 6380 (301 files)¹ | 1172 (105 files) | OK |
| `packages/db` | clean | 409 | 417 | — |
| `packages/domain` | clean | 50 | — | — |
| `packages/contracts` | clean | 73 | — | — |
| `packages/observability` | clean | 14 | — | — |
| `apps/console` | clean | 4367 (218 files) | — | OK |
| `apps/super-admin` | clean | 366 (24 files) | — | OK |

¹ Re-run on the deployment-packaging branch: 6350 at the first commit, plus the 6 restored
decoder-packaging tests and 24 new deployment tests (`PORTING.md` "Deployment packaging").

CI (`.github/workflows/ci.yml`) runs lint, unit and build in one job and the integration suites
against Postgres 16 and Redis 7 service containers on the same ports in another.

## What is on GitHub, and what is only local

- **GitHub `sapieonic/magick-agency`** (private). `main` began as one squashed commit,
  "Initial commit: Magick Agency" (`e5be0c2`), whose tree is identical to the build's final state.
  Then PR #1 (`dfd514c`: CI installs `mpg123` and `sndfile-programs` for the audio decode tests)
  and PR #2 (`4924a09`: dev setup in `README.md`, expanded `CLAUDE.md`).
- **Local only.** The full 252-commit build history — per-lane merges, review notes, the lead's
  fixes — is in the branch `main-full-history` (`17ac1b6`) on Manas's machine. **Every commit SHA
  cited in `PORTING.md`, `decisions.md` and `history/` refers to that history and does not
  resolve on GitHub.** If that branch is lost, the SHAs become unverifiable labels; the tree
  itself is safe on GitHub.

## Not built

**Phase 10 work** (not part of the build by design):

- Cutover gate queries (zero running campaigns, zero live attempts, sessions left, wrap-ups
  closed, DNC outbox drained) and the UUID-preserving copy scripts from core and master.
- The rollback-window DNC mirror to master. Only the `agency_dnc_outbox` table exists; nothing
  writes it.
- The "Switch to Magick Agency" link in cusui.
- The Grafana `local.agency` selector and re-pointed alert rules in the superproject (B6).

**Deployment pieces this repo does not have yet** (found while writing this doc):

- No OpenTelemetry SDK is started. Nothing in `apps/server/src` creates a meter provider, a trace
  exporter or a `/metrics` endpoint, so the declared metrics and `@Traced` spans go to the OTel
  API's no-op implementation. Logs can be shipped over OTLP by `pino-opentelemetry-transport` when
  `OTEL_ENABLED=true` and `OTEL_EXPORTER_OTLP_ENDPOINT` are set (`packages/observability/src/logger.ts`).
  Core's `:9090` scrape was not ported (`PORTING.md` Phase 6 tests). Whether and how to export
  metrics is undecided.

**Out of scope by plan:** metering and billing; AI calling; BYO SIP and other carriers; a separate
identity layer; removing agency from core, master and cusui.

## Open decisions and owners

The full list, with context, is [decisions §5](decisions.md#5-still-open). In short, all with
Manas unless stated:

| Item | What is needed |
|---|---|
| `supervisor_hold` | Declared in the contract, never produced (same as core). Keep, remove or build |
| Shutdown grace | `stop_grace_period: 45s` is now in `docker/docker-compose.prod.yml` (the completion-email drain is 30 s, Docker's default grace is 10 s); ratify. And: should shutdown await an in-flight pacing tick? |
| Plan §7 defaults | Ratify: re-issue invites at cutover; inbound calls play a message and hang up; abandon clip upload-only; no API keys; super-admins created fresh |
| Plan §7 open | Existing numbers; cutover style; domain, freeze vs port tax, rollback window |
| Q3 contracts follow-ups | Ratify the lead's five contract choices |
| B15 roster supersede | Build it, or leave replace/clear refused |
| Gated items | Phase 0 vendor setup; Playwright happy path; parity diff; dark pilot; real VoiceLink and recording gates; Phase 10 |
| Metric export | Not raised before; see "Not built" |

## Deployment invariants

Each of these is a property the running system needs and the code cannot enforce on its own.
Details and the config behind each are in [`operations.md`](operations.md).

1. **Redis keeps keys for their TTL.** Persistence on (AOF or RDB) and `maxmemory-policy
   noeviction` (or a `volatile-*` policy with nothing else competing). Call tokens are verified
   against Redis; a token lost early is refused, which cuts a live call's carrier leg (Q6).
2. **Single replica** (plan D2). The unstored-token memo is in-process (Q6), the agency runtime
   has one replica id, and several sweeps assume one process.
3. **Exactly `TRUST_PROXY_HOPS` proxies in front.** The server must not be reachable except
   through them, or `X-Forwarded-For` spoofing defeats the IP rate limits (Q9).
4. **Postgres TLS** is on only when `NODE_ENV=production`, and then the certificate is verified
   unless `DB_SSL_REJECT_UNAUTHORIZED=false` (Q1).
5. **Migrations run before the server starts.** The image's entrypoint does this on every start
   (`dist/migrate.js`, with the server's TLS settings); outside the image, `pnpm migrate:up`.
6. **Production requires** `FIREBASE_PROJECT_ID` (boot refuses without it) and the VoiceLink
   fields (config refuses without them).
7. **Stop grace at least 45 s**, or the shutdown's 30 s completion-mail drain is cut
   (`docker/docker-compose.prod.yml` sets it).

The production image and compose file (`docker/`, see [`operations.md`](operations.md)
"Production packaging") write invariants 1–5 and 7 into their headers and enforce what they can:
the server publishes no port, Redis runs with AOF and `noeviction`, the image is
`NODE_ENV=production` and migrates on start, the grace is 45 s.

### Pre-deploy checklist

- [ ] `docker/.env` filled in from `docker/.env.example`, including the console's
      `VITE_FIREBASE_*` build values; values containing `$` or ` #` single-quoted.
- [ ] Redis: persistence on, `noeviction` (the compose file's `redis` does both; an external Redis
      must too). Its volume is backed up or at least survives a host restart.
- [ ] One replica only: never scale `server`.
- [ ] TLS terminator in front of nginx :8080; `TRUST_PROXY_HOPS=2` (terminator + nginx; one more
      per extra proxy in front); :8080 reachable only from the terminator (loopback by default);
      port 3021 not reachable at all (the compose file publishes none).
- [ ] Super-admin :8081 not public (loopback by default; SSH tunnel or VPN).
- [ ] `NODE_ENV=production` (the image sets it); `DATABASE_URL` without TLS parameters; `DB_SSL_CA`
      if the database uses a private CA.
- [ ] First boot logs `migrations complete` before `magick-agency listening` (the entrypoint runs
      them; a failure stops the container).
- [ ] Firebase: agency service account in the shared project, agency domain in authorised domains,
      `FIREBASE_PROJECT_ID` + key or path set.
- [ ] VoiceLink: account, numbers in the super-admin inventory, `VOICELINK_*` set,
      `VOICELINK_WEBHOOK_BASE_URL` reachable by the carrier.
- [ ] `SUPER_ADMIN_JWT_SECRET` set; first super-admin created with `node dist/create-super-admin.js`
      inside the server container (`operations.md` "First super-admin").
- [ ] Mailjet sender verified (SPF/DKIM); `MAILJET_*` and `CONSOLE_BASE_URL` set.
- [ ] S3 bucket and keys (`S3_AUDIO_BUCKET`, `AWS_*`) for clips and CSV uploads.
- [ ] Analysis: `DIALER_ANALYSIS_ENABLED`, transcriber and LLM keys, `RECORDING_URL_SIGNING_SECRET`.
- [ ] Container stop grace at least 45 s (`stop_grace_period: 45s` in the compose file; set it
      too on any other runtime).
- [ ] A decision on metrics export (see "Not built").

## Recommended next steps, in order

1. **Ratify the decisions** that do not need vendors: plan §7 defaults, Q3, `supervisor_hold`,
   the shutdown grace (and the in-flight tick question), B15.
2. **Phase 0 vendor setup**, because it has lead time: agency VoiceLink account (ask about moving
   DIDs and recording retention), Firebase service account and authorised domain, Mailjet sender
   and domain, S3 bucket, Gemini/OpenAI keys, domain and TLS, PostHog.
3. **Deployment packaging:** done (`docker/`, see [`operations.md`](operations.md) "Production
   packaging"); the six decoder-packaging tests are restored. Left: decide metric export, and stand
   the stack up once on a real host with the vendor accounts from step 2.
4. **The real-world gates:** one real VoiceLink sandbox call; one real recording analysed; the
   Playwright happy path against real Firebase.
5. **Parity and dark pilot** (plan Phase 9) on a staging copy and an internal tenant.
6. **Phase 10:** write and rehearse the gate queries and copy scripts, the DNC mirror, the cusui
   link and the Grafana selector, then cut over per environment.
7. **Keep `main-full-history` safe** until nobody needs the SHAs in the ledger.

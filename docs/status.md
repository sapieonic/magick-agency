# Status

Where Magick Agency stands, in detail: what each delivery phase built and the evidence for it,
the last test counts, what is not built, what is still open and with whom, the deployment
invariants, and what to do next. Read it before planning work on the repo, or before answering
"is it done". As of 2026-10-09.

## Summary

The application is built: phases 1 to 9 of the delivery plan
([`intent-and-plan.md`](intent-and-plan.md)) are complete on the code side, every suite is green,
and Manas's rulings on the open questions are implemented. Nothing has yet run against a real
carrier, a real Firebase sign-in, production data or a deployed environment. The launch (phase
10) and the gated checks that need vendor accounts or real data are still to do.

## Phases

| Phase | State | Evidence |
|---|---|---|
| 0 Vendor setup and decisions | **Not done** (needs Manas) | No vendor accounts requested; launch decisions built with defaults ([`decisions.md`](decisions.md), §2) |
| 1 Scaffold | Done | Monorepo, CI, dev infra on 5436 / 6383 / 3021 / 5175 / 5176, Zod config that exits on invalid input. Dashboards and alerts deferred (B6) |
| 2 Contracts and schema | Done | `packages/contracts`; the baseline migration `packages/db/migrations/0001_baseline.sql`, inventoried in `packages/db/BASELINE.md`; baseline integration suite including down→up and trigger firing |
| 3 Platform layer | Done | Session sign-in paths and the `no_membership` refusal, invites, RBAC, settings, flags, super-admin, notifications, audit, usage counts; a 45-case invite escalation suite |
| 4 Dialer domain and data | Done | Pure rules in `packages/domain`; the agency repository and campaign management; repository tests on real Postgres |
| 5 Voice engine | Done, except the live-carrier check | Bridge, VoiceLink adapter, concurrency guard, sweeps, the carrier fixture test. Not done: one real call on a VoiceLink sandbox (needs the account) |
| 6 Dialer runtime | Done | 9 chaos suites (`apps/server/test/integration/agency/chaos/`); `runtime-e2e` (real app, station socket, real bridge, fake carrier); `runtime-boot-order` |
| 7 Call analysis | Done, except the real-recording check | Runner skip / resume / truncation / backoff tests; transcripts nulled at the retention day. Not done: one real recording analysed (needs vendor keys) |
| 8 Public API | Done | Route-table tests enumerated from Fastify's `onRoute` hook cover every console and super-admin path |
| 9 UIs, parity and dark pilot | UIs done; the rest needs Manas | Console and super-admin console with tests. Not done: Playwright happy path (real Firebase), parity check against production data, dark pilot |
| Rulings | Done | Open-question rulings and branding (`decisions.md` Q1–Q9, B17), each mutation-checked |
| 10 Launch | **Not started** | See "Not built" |

## Test counts

Final full run on 2026-10-09, after `pnpm install --frozen-lockfile`, from inside each package.

| Package | Lint | Unit | Integration | Build |
|---|---|---|---|---|
| `apps/server` | clean | 6350 (298 files) | 1172 (105 files) | OK |
| `packages/db` | clean | 409 | 417 | — |
| `packages/domain` | clean | 50 | — | — |
| `packages/contracts` | clean | 73 | — | — |
| `packages/observability` | clean | 14 | — | — |
| `apps/console` | clean | 4367 (218 files) | — | OK |
| `apps/super-admin` | clean | 366 (24 files) | — | OK |

CI (`.github/workflows/ci.yml`) runs lint, unit and build in one job, and the integration suites
against Postgres 16 and Redis 7 service containers on the same ports in another. Per-module test
files are listed in [`modules.md`](modules.md).

## Not built

**Launch work** (phase 10):

- Importing existing tenants and their data from the previous platform: gate queries (no running
  campaigns, no live attempts, sessions left, wrap-ups closed, DNC changes drained) and copy
  scripts that keep ids, so users sign in unchanged.
- The rollback-window DNC mirror back to the previous platform. Only the `agency_dnc_outbox` table
  exists; nothing writes it.
- The link from the previous platform's UI to Magick Agency.
- Dashboards and alert rules (B6).

**Deployment pieces:**

- **No production Dockerfile or compose file.** `docker/` holds only the dev compose. The image
  needs Node 22 and the audio decoders, and the recommended `stop_grace_period: 45s` has no file to
  live in yet. Six decoder-packaging tests that would read `docker/Dockerfile` do not exist until
  it does.
- **No OpenTelemetry SDK is started.** Nothing in `apps/server/src` creates a meter provider, a
  trace exporter or a `/metrics` endpoint, so the declared metrics and `@Traced` spans go to the
  OTel API's no-op implementation. Logs can be shipped over OTLP by `pino-opentelemetry-transport`
  when `OTEL_ENABLED=true` and `OTEL_EXPORTER_OTLP_ENDPOINT` are set
  (`packages/observability/src/logger.ts`).

**Out of scope:** metering and billing; AI calling; bring-your-own SIP and other carriers; a
separate identity layer.

## Open decisions and owners

The full list is [`decisions.md`](decisions.md), §5. In short, all with Manas:

| Item | What is needed |
|---|---|
| `supervisor_hold` | Declared, never produced. Keep, remove or build |
| Shutdown grace | Recommendation: `stop_grace_period: 45s` (the completion-email drain is 30 s; Docker's default grace is 10 s). And: should shutdown await an in-flight pacing tick? |
| Launch defaults | Ratify: re-issue invites; inbound calls play a message and hang up; abandon clip upload-only; no API keys; super-admins created fresh |
| Launch open items | Existing numbers; launch style; domain, feature freeze, rollback window |
| Q3 contract choices | Ratify the five |
| B15 roster supersede | Build it, or leave replace and clear refused |
| Gated items | Vendor setup; Playwright happy path; parity check; dark pilot; real VoiceLink call and recording; launch |
| Metric export | Build the OpenTelemetry SDK wiring and decide where metrics go |

## Deployment invariants

Properties the running system needs that the code cannot enforce on its own. Config details are
in [`operations.md`](operations.md).

1. **Redis keeps keys for their TTL.** Persistence on (AOF or RDB) and `maxmemory-policy
   noeviction` (or a `volatile-*` policy with nothing else competing). Call tokens are verified
   against Redis; a token lost early is refused, which cuts a live call's carrier leg (Q6).
2. **Single replica.** The unstored-token memo is in-process (Q6), the dialer runtime has one
   replica id, and several sweeps assume one process.
3. **Exactly `TRUST_PROXY_HOPS` proxies in front.** The server must not be reachable except
   through them, or `X-Forwarded-For` spoofing defeats the IP rate limits (Q9).
4. **Postgres TLS** is on only when `NODE_ENV=production`, and then the certificate is verified
   unless `DB_SSL_REJECT_UNAUTHORIZED=false` (Q1).
5. **Migrations run before the server starts.** `pnpm migrate:up` is manual; nothing in this repo
   runs it on deploy.
6. **Production requires** `FIREBASE_PROJECT_ID` (boot refuses without it) and the VoiceLink
   fields (config refuses without them).

### Pre-deploy checklist

- [ ] Redis: persistence on, `noeviction`; `REDIS_URL` points at it.
- [ ] One replica only.
- [ ] Proxy count known; `TRUST_PROXY_HOPS` set to it; port 3021 not reachable directly.
- [ ] `NODE_ENV=production`; `DATABASE_URL` without TLS parameters; `DB_SSL_CA` if the database
      uses a private CA.
- [ ] `pnpm migrate:up` run against the target database.
- [ ] Firebase: agency's service account in the project, agency's domain in the authorised
      domains, `FIREBASE_PROJECT_ID` plus a key or key path set.
- [ ] VoiceLink: account, numbers in the super-admin inventory, `VOICELINK_*` set,
      `VOICELINK_WEBHOOK_BASE_URL` reachable by the carrier.
- [ ] `SUPER_ADMIN_JWT_SECRET` set; first super-admin created with `scripts/create-super-admin.ts`.
- [ ] Mailjet sender verified (SPF/DKIM); `MAILJET_*` and `CONSOLE_BASE_URL` set.
- [ ] S3 bucket and keys (`S3_AUDIO_BUCKET`, `AWS_*`) for clips and CSV uploads.
- [ ] Analysis: `DIALER_ANALYSIS_ENABLED`, transcriber and LLM keys, `RECORDING_URL_SIGNING_SECRET`.
- [ ] Container stop grace at least 45 s.
- [ ] A decision on metric export.

## Recommended next steps, in order

1. **Ratify the decisions** that need no vendors: launch defaults, Q3, `supervisor_hold`, the
   shutdown grace and in-flight tick question, B15.
2. **Vendor setup**, because it has lead time: agency's VoiceLink account (ask about moving
   existing numbers and recording retention), Firebase service account and authorised domain,
   Mailjet sender and domain, S3 bucket, Gemini / OpenAI keys, domain and TLS, PostHog.
3. **Deployment packaging:** a production Dockerfile (Node 22, `mpg123`, `sndfile-programs`) and
   compose file with `stop_grace_period`, Redis persistence and `noeviction`; decoder-packaging
   tests against it; the OpenTelemetry SDK and a metric destination.
4. **Real-world checks:** one real VoiceLink sandbox call; one real recording analysed; the
   Playwright happy path against real Firebase.
5. **Parity check and dark pilot** on a staging copy and an internal tenant.
6. **Launch:** write and rehearse the import gate queries and copy scripts, the DNC mirror, the
   link from the previous platform and the dashboards, then go live environment by environment.

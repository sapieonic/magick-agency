# Intent and plan

Why Magick Agency exists as its own application, what was decided before a line was written,
what the extraction moved and what it left behind, and the shape of the plan the build
followed. Read it first if you are new to the project or need to explain it to someone; read
[`architecture.md`](architecture.md) next for how it is built. The full plan is frozen at
[`history/extraction-plan-v4.2.md`](history/extraction-plan-v4.2.md); this doc summarises it and
adds what the plan does not say.

## Why extract the agency dialer

Inside MagickVoice, the agency dialer (human agents, outbound power dialing) was spread across
three services: core ran the dialer engine and the WebRTC bridge, master ran identity, billing,
governance, DNC and campaigns as business objects, and cusui had the agent and supervisor UI.
The domain reference for that system is copied at
[`reference/magickvoice-platform/agency.md`](reference/magickvoice-platform/agency.md).

Manas wanted a clean product separation. Agency is human-to-human calling, which is a different
product from MagickVoice's AI voice engine: it needs a reserved human, a screen in front of that
human before the customer's audio arrives, a regulatory abandonment ceiling and DNC that halts on
doubt. None of it needs the AI pipeline.

**Why not keep core as a voice gateway.** Plans v1–v2 kept core as a voice gateway that agency
would call. That design was rejected (recorded by the lead from the planning session; the plan
itself only lists the version). The reason is the answer-time decision: when the carrier reports
an answer, the dialer must decide in the same synchronous run whether a reserved agent is still
there to bridge to, write the agent's panel, and bind the audio, or else take the abandoned path.
[`agency.md`](reference/magickvoice-platform/agency.md) §5 ("The parts that are easy to get wrong") spells out why there must be no `await`
between those steps; a fast carrier delivers `bridged` right after `answered`. A network hop
between the dialer and the bridge puts an `await` exactly there. So agency owns its bridge and its
carrier account.

## Settled decisions (S1–S8)

Approved by Manas on 2026-10-08. Not reopened. (The plan's table has ten rows; the build handoff
condensed them to these eight.)

| # | Decision |
|---|---|
| S1 | Entirely separate, self-sufficient application; no runtime dependency on core or master |
| S2 | Owns its voice engine (bridge + VoiceLink adapter) and its own VoiceLink capacity (account, numbers, concurrency limits) |
| S3 | Owns post-call analysis and transcripts, and identity data (users, tenants, accounts, memberships, roles, invites) |
| S4 | Same Firebase project as MagickVoice; agency has its own service account. A separate identity layer may come later |
| S5 | Super-admins create tenants and add users, with master's approach (own login, own console) |
| S6 | No credits, billing or credit enforcement in v1; metering is an open item |
| S7 | AI calling from agency is out of scope |
| S8 | Node 22, Fastify, TypeScript, raw `pg`, node-pg-migrate, Vitest; Vite + React UIs; pnpm workspaces |

Two consequences the plan states: agency usage is not charged from cutover until metering ships;
and "no enforcement" covers credits only, so the concurrency guard stays (it protects carrier
capacity, not a balance). Removal from core, master and cusui is a later project; the old path
stays intact as the rollback.

### How the plan got here

| Version | Shape |
|---|---|
| v1–v2 | Core as a voice gateway (rejected, above) |
| v3–v3.1 | Agency owns its voice engine and carrier capacity |
| v4–v4.1 | Agency owns everything, including its own Firebase project and credits |
| v4.2 | Firebase stays shared (no user import); super-admin onboarding confirmed; credits and billing removed from v1, which deleted the ledger port, the balance migration and most of the money cutover |

## What collapses in one process

Plan §1, the table that explains most of the porting changes:

| In MagickVoice | In Magick Agency |
|---|---|
| master DNC → core DNC sync → Redis set, plus outbox and resync | one DNC table, one transactional write (B8) |
| master CSV parse → core roster chunks over S2S | in-process ingest |
| browser → master proxy + error mask → core | browser → agency (B16) |
| core settlement webhooks → master credits | nothing in v1 |
| master pushes concurrency allocations to core | agency is system of record and enforcer |
| governance overrides + core flags + master capability check | one per-account settings row + agency's flags |
| error codes copied in four places, a 6-seam S2S fixture | one union in `packages/contracts`; the fixture retires |
| campaign as a master business object plus a core execution object | one campaign |

The plan says 16 error codes; there are 18 (Q2).

## Scope, measured (plan §2)

| Area | From | Source LOC (approx.) | Port or rebuild |
|---|---|---|---|
| Agency domain, routes, repos | core `src/agency`, routes, repo | 30.6k | port verbatim; drop the attempt batcher (billing only) |
| Agency domain, routes, DNC, ingest, staffing | master `src/agency`, `src/dnc`, proxy routes | 19.8k | port, proxies collapsed into direct calls; drop the billing contract, settlement, `credits_low` |
| Agency UI | cusui | 67k | port |
| Voice engine | core bridge, VoiceLink adapter, guard, sweeps | ~6k (+~6.4k tests) | port verbatim; delete VoBiz, SIP and softphone branches |
| Analysis | core dialer analysis jobs, worker, runner, transcribers, analysis service, profiles, retention slice, signed playback | ~4.2k | port, re-keyed onto `agency_calls`, settlement step removed |
| Identity | master session, Firebase verify, `/auth/session`, tenancy, repos, invites, mailer, RBAC | ~5.3k | port |
| Super-admin | master super-admin auth and routes + cusui super-admin pages | ~2.5k + ~2.5k UI | port the subset |
| Notifications, audit | master Mailjet client, engine, preferences; audit logger, vocabulary, repo, partitions | ~3k | port the subset |
| Auth and team UI | cusui `AuthContext`, auth, team, settings pages | ~5k | port |

About 145k LOC of source plus tests; the platform layer on top of the agency code is about 18k.
Not ported: credits, rate cards, settlement, top-up, `credits_low`; call-quality scores (AI only);
TTS, API keys, SIP, bulk dispatch and every AI surface.

## The platform layer agency now owns (plan §3)

- **Identity and tenancy.** Same Firebase project, verified with `firebase-admin`; no custom
  claims, roles come from agency's DB. `POST /auth/session` paths 1–3 are ported (existing uid; a
  verified email matching a `pending_` stub; a re-registered uid adopted by proven email). Path 4,
  a brand-new user, refuses with 403 `no_membership`: no self-serve sign-up. The rule "no lookup by
  address ever binds an unverified address" is kept with `users.email_unverified`,
  `findByProvenEmail` and the path-1 repair. Tenancy headers `X-Tenant-Id` / `X-Account-Id`,
  memberships per account, the same six roles with `agent` at 5, below `viewer`. Invites with
  sha256 token hashes, expiry, claim and revoke. Revoking a membership closes the agent's campaign
  staffing.
- **Per-account settings instead of governance.** Governance `agency.recording` /
  `agency.analytics`, core's `analyze_dialer_calls`, `max_concurrent_calls` and the
  `webrtc_max_duration_seconds` flag become one settings row. Recording and analysis stay checked
  per field on campaign writes. Core's three agency flags become agency flags, overridable by
  super-admins per tenant and account.
- **Metering: deferred.** The facts stay on rows agency owns (`agency_call_attempts`,
  `agency_calls`, `dialer_analysis_jobs.analysis_audio_seconds`), and a read-only super-admin
  usage-counts view shows them. `credits_low` is removed.
- **Super-admin console.** Own login (JWT with its own secret, `super_admins` table). Tenants,
  users, phone numbers (validated against campaign caller IDs), concurrency limits, settings, flag
  overrides, usage counts, the super-admin list and audit trail.
- **Notifications and audit.** Mailjet with agency's own sender: the agent invite and campaign
  completion. Audit: the plan wanted one table; the build kept both (B7).

Analysis (plan §4) and the voice engine (plan §5) are described as built in
[`architecture.md`](architecture.md).

## Phases (plan §8)

Phases 3, 4, 5 and 7 ran as parallel lanes once Phase 2 fixed the contracts and schema. Where
each phase stands now is in [`status.md`](status.md).

| Phase | What | Exit gate (abridged) |
|---|---|---|
| 0 | Ratify §7; start vendors with lead time (VoiceLink, Firebase service account, Mailjet, S3, LLM keys, domain/TLS, PostHog); measure each environment | decisions recorded, vendors requested, measurements dated |
| 1 | Scaffold: monorepo, CI, dev infra on unused ports, Zod config; Grafana `local.agency` selector | empty apps green; validators green |
| 2 | One squashed baseline schema; `packages/contracts` | baseline migrates; trigger test passes; contracts typecheck |
| 3 | Lane A: identity, settings and flags, super-admin, notifications, audit, usage counts | session paths, invites, super-admin onboarding, `agent` reach, per-field assert tested |
| 4 | Lane B: pure modules, core's repository, DNC merged, ingest, staffing, activity | counts equal source minus listed deletions; repository tests on real Postgres |
| 5 | Lane C: voice engine | bridge/VoiceLink tests; carrier fixture in both repos; guard refuses per scope; stale sweep; one real sandbox call |
| 6 | Runtime: pacing, dialer, stations, reaper, wrap-up, breaks; no attempt batcher | all chaos suites green against the fake carrier |
| 7 | Lane D: analysis | runner tests; one real recording analysed; `analysis_audio_seconds`; transcript nulled at retention |
| 8 | API: one route surface | route-table test from the router covers every console and super-admin path |
| 9 | UIs; Playwright happy path; production parity diff; dark pilot | zero unexplained diffs; bind latency inside the 1 s grace |
| 10 | Cutover per environment (staging → dedicated → prod): gate by query, close old billing, copy with UUIDs preserved, verify, flip cusui's link, core's flag off last, 7-day rollback window with a DNC mirror | — |

## Invariants that must survive (plan §9)

One live attempt per contact and one running campaign per account; an agent reserved before the
dial and the panel on screen before audio with no `await` between; `answered_at` / `bridged_at`
never back-filled; DNC fails closed and a `halt` aborts the claimed batch;
`OUR_FAULT_REDIAL_BOUND` is a ceiling and the 3% auto-pause keeps its sample floor; `agent` at
level 5 reaches only its surfaces; recording and analysis gated per field; agency dials only on
its own VoiceLink account; agency never charges or writes to master's ledger; no lookup by address
binds an unverified email, path 4 never creates a tenant, an invite token is single use and
expires. The build rule was that each gets a ported or new test that fails if it breaks; this doc
did not re-audit that per invariant.

## Out of scope

Metering and billing; AI calling from agency; BYO SIP and other carriers; a separate identity
layer with scopes; removing agency from core, master and cusui.

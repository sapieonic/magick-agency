# Intent and plan

What Magick Agency is for, the product decisions it rests on, the reasons behind its main design
choices, and the delivery phases it was built in. Read it first if you are new to the project or
need to explain it to someone; read [`architecture.md`](architecture.md) next for how it is
built, and [`status.md`](status.md) for where each phase stands.

## What it is for

Magick Agency runs outbound calling campaigns staffed by human agents: power dialing. A
supervisor loads a campaign (a roster of contacts, caller IDs, calling hours, dispositions, retry
rules), agents sign in to a browser station, and the dialer places calls at the rate the available
agents can answer. When a customer picks up, the call is bridged to a reserved agent's browser over
WebRTC, with the contact's details already on the agent's screen. The agent talks, records a
disposition, wraps up, and becomes available again. Afterwards the recording can be transcribed and
analysed.

It is human-to-human calling, so what matters is different from automated voice:

- a reserved human must be there for every call that connects;
- the agent's screen must show who is calling before the customer's audio arrives;
- a call the customer answers but no agent reaches is an *abandoned* call, which regulators cap;
  the dialer must measure it and stop a campaign that dials faster than its agents can answer;
- Do Not Call must halt dialling when in doubt.

## Settled product decisions

Approved by Manas on 2026-10-08 and not reopened. The table is [`decisions.md`](decisions.md), §1
(S1–S8). In short: a self-contained application with its own server, database, Redis, storage and
VoiceLink account (S1, S2); it owns analysis, transcripts and its identity data (S3); sign-in with
Firebase Authentication, verified against agency's own Firebase project id with no service account (S4); super-admins onboard tenants
and users (S5); no credits or billing in v1 (S6); no AI calling (S7); Node 22, Fastify,
TypeScript, raw `pg`, Vite + React (S8).

Two consequences: calls are not charged until metering ships, though every fact metering would need
is already recorded; and the concurrency guard stays, because it protects carrier capacity, not a
balance.

## Why it is built this way

**The dialer and the voice engine live in one process.** When the carrier reports an answer, the
dialer must decide in the same synchronous run whether the reserved agent is still there, put the
agent's panel on the wire, and bind the audio, or else take the abandoned path. A fast carrier
reports `bridged` immediately after `answered`, so there can be no `await` between those steps. Any
network hop between the dialer and the bridge would put one there. Hence one process, which owns
its bridge and its carrier account (S1, S2).

**Its own VoiceLink account.** VoiceLink queues dials over an account's channel count. Sharing an
account with other traffic would let that traffic queue an agency dial while a human sits reserved
waiting for it.

**One database, one transaction.** DNC is one table written in the same transaction as the attempt
it ends (B8), so there is no moment in which a marked number can still be dialled. Campaigns,
rosters, attempts and calls live in the same Postgres, so ingest, stats and the activity trail are
direct queries.

**A public API layer over internal handlers.** The console's routes authenticate, check tenancy
and RBAC, validate and enrich in the public API layer, then run the dialer's handlers in-process
through `callCore` on a private Fastify instance that never listens (B16). The dialer handlers stay
small and the security checks stay in one layer.

**Redis is the authority for live presence; Postgres for everything durable.** Agent states are
Redis leases that lapse when an agent's process or browser goes away; the database row is a mirror.
Contact claiming uses `FOR UPDATE SKIP LOCKED` in Postgres, so even two leaders could not dial the
same contact.

**Per-account settings, not a permissions catalogue.** Recording, analysis, the concurrency limit
and the maximum call duration are one settings row per account, set by super-admins. Recording and
analysis are checked per field when a campaign is saved.

**Single replica.** One process makes the in-process token memo, the leader leases and the sweeps
simple and correct. Scaling out is possible but needs those revisited.

## Delivery phases

Phases 3, 4, 5 and 7 were built in parallel once phase 2 had fixed the contracts and schema. Where
each stands is in [`status.md`](status.md).

| Phase | What it builds | Exit check |
|---|---|---|
| 0 Vendor setup and decisions | Ratify the launch decisions; request the VoiceLink account, Firebase project and authorised domain, Mailjet sender (SPF/DKIM), S3 bucket, Gemini / OpenAI keys, domain and TLS, PostHog; measure the data to import | Decisions recorded, vendors requested, measurements dated |
| 1 Scaffold | Monorepo, CI (typecheck, unit, integration on Docker), dev infra on dedicated ports, Zod config that exits on invalid input | Empty apps green in CI |
| 2 Contracts and schema | `packages/contracts` (wire types, error codes, flags, RBAC); one baseline migration covering identity, phone inventory, notifications, audit (partitioned), DNC, campaigns, contacts, sessions, attempts, calls, analysis jobs and profiles, guard tables | Baseline migrates on a fresh Postgres; trigger test passes; contracts typecheck |
| 3 Platform layer | Identity and tenancy, per-account settings and flags, super-admin auth and API, notifications, audit, usage counts | Sign-in paths and the `no_membership` refusal; invite issue, claim, expiry, revoke; a super-admin creates a tenant and adds a user who then signs in; the `agent` role's reach; the per-field recording/analysis check |
| 4 Dialer domain and data | Pure rules, the agency repository, DNC, ingest, staffing, activity | Repository tests on real Postgres |
| 5 Voice engine | WebRTC bridge, VoiceLink adapter, webhooks, media socket, clip decode, the concurrency guard with reconcile and stale sweep | Bridge and VoiceLink tests; the guard refuses at each scope; the stale sweep frees a dead session's slot; one real sandbox call |
| 6 Dialer runtime | Pacing, dialer, station registry, reaper, wrap-up, breaks, abandonment guardrail, SQL-derived gauges | Chaos suites green against a fake carrier: restart mid-bridge, abandonment counter vs table, predicate agreement, DNC fail-closed, bridged ordering |
| 7 Call analysis | Analysis jobs, worker, runner, transcribers, LLM analysis, profiles, retention, signed playback | Runner tests; one real recording analysed; `analysis_audio_seconds` recorded; transcript nulled at the retention day while the analysis survives |
| 8 Public API | One route surface for the console and super-admin console | A route-table test enumerated from the router covers every console and super-admin path |
| 9 UIs, parity, dark pilot | The console and super-admin console; a Playwright happy path (super-admin creates a tenant → owner invites an agent → agent claims → campaign → call → disposition → analysis → usage counts move); a parity check against production data; a dark pilot on an internal tenant | No unexplained differences; bind latency inside the 1 s grace |
| 10 Launch | Per environment (staging, then dedicated, then production): gate by query, import existing tenants and data from the previous platform with ids preserved, verify, switch users over, keep a 7-day rollback window with a DNC mirror | — |

## Invariants that must hold

The build rule is that each of these has a test that fails if it breaks:

- One live attempt per contact (unique index plus `SKIP LOCKED`); one running campaign per account.
- An agent is reserved before the dial; the panel is on screen before audio, with no `await` between.
- `answered_at` and `bridged_at` live on the attempt and are never back-filled; the abandonment
  predicate is shared by SQL and code.
- DNC fails closed; a `halt` aborts the whole claimed batch.
- `OUR_FAULT_REDIAL_BOUND` is a ceiling; the 3% auto-pause has its single-abandon sample floor and
  matching console copy.
- `agent` (level 5) reaches only the agent surfaces plus session, `/accounts/mine` and notification
  preferences.
- Recording and analysis are gated per field on campaign writes.
- Agency dials only on its own VoiceLink account, and its guard is the only admitter there.
- No lookup by email address binds an unverified address; a new user without a membership never
  gets a tenant; an invite token is single use and expires.

This list was not re-audited test by test when it was written.

## Out of scope

Metering and billing; AI calling; bring-your-own SIP and other carriers; a separate identity layer
with scopes.

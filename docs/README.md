# Magick Agency docs: start here

The entry point to the project's documentation: what Magick Agency is, where it stands on one
screen, a map of every doc, and what to read first depending on why you are here. Status claims
are as of 2026-11-07.

## What Magick Agency is

Magick Agency is an outbound power dialer for human agents. Supervisors load campaigns, the dialer
paces calls to the number of available agents, and each answered call is bridged to an agent's
browser over WebRTC and VoiceLink, with the contact's details already on screen. It is one
self-contained application: a Fastify server, a Postgres database, Redis, an agent and supervisor
console, and a super-admin console, depending only on vendors (VoiceLink, Firebase Authentication,
Mailjet, S3, Gemini / OpenAI, PostHog).

## Status on one screen

**Done.** Delivery phases 1–9 on the code side: scaffold, contracts and schema, the platform layer
(identity, tenancy, RBAC, invites, settings, super-admin, notifications, audit), the dialer domain
and data, the voice engine, the dialer runtime, call analysis, the public API, the console and the
super-admin console. Manas's 2026-10-09 rulings on the open questions and branding are implemented.
Last full run (2026-10-09): lint clean in 7 packages; server 6412 unit / 1172 integration;
console 4367; super-admin 366; builds OK. Unit re-run 2026-10-10: server 6507, console 4374;
2026-10-11 (brand logo): console 4389, super-admin 374. After the 2026-10-16/17 tidy-up (shared
`packages/web-ui`, migrations 0003 and 0004, split modules, a batch-claim over-claim bug fixed): server 6703
unit + 42 skipped / 1211 integration; db 426 / 469; console 4410; super-admin 421; web-ui 231
(`status.md`). The 2026-10-23 load and scenario suites (a full floor over real sockets, a mock
VoiceLink carrier and agent fleet) fixed 11 defects and pinned 12 more as `it.fails` for decision:
server 6755 unit + 4 expected fail / 1288 integration + 10 expected fail. The 2026-11-02 scaling
work for 400–500 simultaneous calls on one host (phase A: a faster bridge transcoder, the console
on binary A-law, WebSocket and carrier bounds, sized ceilings, a continuous analysis worker,
cheaper pacing) leaves server 7430 unit / 1511 integration + 10 expected fail; phase B (media and
analysis worker processes over IPC) is next. Contact assignment (2026-11-03, behind a flag: supervisors
assign contacts, agents work their own queue, agent retry and outcome overrides, decisions
CA1–CA15) leaves server 7876 unit / 1732 integration + 9 expected fail; console 5136; app 1392. Customer history
(2026-11-06: one number searched across the tenant's campaigns, CH1–CH13, reviewed and fixed the
same day; a search measured at 15 ms median on a 1M-contact tenant) is built on the server, the
console and the app; its test counts are in `status.md`, and the app's Dart side has not run yet.
A dedicated caller ID per agent (2026-11-06, behind the contact-assignment flag: a supervisor gives
a staffed agent one of the campaign's caller IDs and every dial to a contact they own goes out from
it, decisions DN1–DN10) leaves server 8207 unit / 2037 integration + 9 expected fail; db 428 / 573;
console 5434.
Automatic outcomes for unanswered calls (2026-11-07: a campaign maps no answer, busy, failed,
invalid number and abandoned to one of its outcomes, filed on the call as a label only, OD1–OD8)
leaves server 8318 unit / 2146 integration + 9 expected fail; db 428 / 586; console 5644.

**Not done.** The launch (importing existing tenants and data, the DNC rollback mirror, dashboards).
Agency's alert rules and dashboard are written (`grafana/`) but not applied to Grafana yet. The production image and compose file exist (`docker/`)
but have not been verified end to end on a real host. `aws/terraform` provisions the S3 bucket and
IAM user per environment and, optionally, the VM with its security group and Elastic IP, applied
from a local machine; a staging VM exists (`status.md`, next steps). Nothing has run against a real carrier, a real Firebase sign-in or
production data.

**Needs Manas.** Ratify the launch defaults and Q3; `supervisor_hold`; shutdown grace (45 s,
now in the production compose file) and the 5 s wait for in-flight pacing ticks; the tidy-up
defaults (including the `en-IN` display locale) and the 25 vs 20 rate floors; B15 roster supersede; vendor setup; the gated checks (real
VoiceLink call, real recording analysed, Playwright happy path, parity check, dark pilot); launch
decisions.

Details and next steps: [`status.md`](status.md).

## Map

| Doc | What it holds |
|---|---|
| [`status.md`](status.md) | Where it is: phase table with evidence, test counts, what is not built, open decisions and owners, deployment invariants, pre-deploy checklist, next steps |
| [`intent-and-plan.md`](intent-and-plan.md) | What it is for, the settled product decisions, why it is built this way, the delivery phases, invariants, out of scope |
| [`architecture.md`](architecture.md) | How it is built: packages, server composition and start/stop order, the public API layer and internal handler instance, identity, dialer runtime, voice engine, analysis, DNC, audit, UIs, observability, tests, CI |
| [`modules.md`](modules.md) | Every module and file group, what it does, and which test files cover it |
| [`decisions.md`](decisions.md) | Every decision by ID: settled S1–S8, launch decisions, build decisions B1–B27, rulings Q1–Q9 and later rulings, still open with owner |
| [`seams.md`](seams.md) | Where files go, module-area files and config keys, the cross-module seams, shared infrastructure |
| [`mobile.md`](mobile.md) | The agent mobile app (`apps/mobile`, Flutter): V1 scope, the foreground rule and `device_away`, how it talks to the server and the station socket (`client=mobile`, `media=alaw8`), the app's structure, builds and releases, what is not verified |
| [`softphone.md`](softphone.md) | The soft phone: manual calls outside pacing, the campaign tag, roster settlement, DNC and hours overrides, the switch from a campaign; Manas's rulings SP1–SP7 |
| [`customer-history.md`](customer-history.md) | Customer history: one phone number searched across the tenant's campaigns and the soft phone; decisions CH1–CH13, the number rule shared by console, server and app, the API (the number only in `POST` bodies, a short-lived search id), the summary and the timeline, visibility, audit and rate limit, the v2 key-column design |
| [`insights.md`](insights.md) | The campaign's analytic tabs (Overview, Calls, Agents, Callbacks, Health): decisions IN1–IN13, the shape (as-of-now reads, the 15-minute rollup recomputed from attempts, pacing history per minute), the API routes and their guards, the drill-downs whose list totals equal the numbers, costs at 1M |
| [`scaling.md`](scaling.md) | Several processes on one host (`MEDIA_WORKERS`, `ANALYSIS_WORKERS`; built 2026-11-02, off by default): a primary that accepts every request and hands WebSocket upgrades to media workers over `child_process` IPC, analysis worker processes, the call's life across processes, the IPC protocol, failure and shutdown, config, tests, build plan, and where the build departed from the design |
| [`operations.md`](operations.md) | Config essentials and defaults, deployment invariants, shutdown, migrations, recordings, TLS, proxy count, releases and per-component versioning |
| [`../DEPLOYMENT.md`](../DEPLOYMENT.md) | Deploying to the cloud step by step: VM, managed Postgres, S3, DNS and TLS for your domain, vendor wiring, verification, day-2 work, troubleshooting |
| [`../README.md`](../README.md) | Dev setup: prerequisites, infra, env, migration, first super-admin, running everything |
| [`../CLAUDE.md`](../CLAUDE.md) | Rules for agents working in this repo; each app and package has its own `CLAUDE.md` with its area's rules |
| `../packages/db/BASELINE.md` | The baseline schema inventory |
| `../packages/contracts/src/api/agency/CONTRACT-DIFF.md` | Where the dialer contract and the console wire types differ |

## Reading order

**A new engineer:** this page → [`intent-and-plan.md`](intent-and-plan.md) →
[`architecture.md`](architecture.md) → the root [`README.md`](../README.md) to get it running →
[`seams.md`](seams.md) before moving files or adding config → [`modules.md`](modules.md) to find a
module and its tests → [`decisions.md`](decisions.md) when a comment cites an ID.

**A reviewer:** [`status.md`](status.md) → [`decisions.md`](decisions.md) (especially B7, B8, B15,
B16, Q1, Q6, Q8, Q9) → [`architecture.md`](architecture.md) → [`modules.md`](modules.md) for the
files under review.

**Whoever runs the launch:** [`status.md`](status.md) (not built, invariants, checklist) →
[`operations.md`](operations.md) → [`../DEPLOYMENT.md`](../DEPLOYMENT.md) → phase 10 in [`intent-and-plan.md`](intent-and-plan.md) →
[`decisions.md`](decisions.md) §2 and §5 (launch decisions still open; Q4 maps imported `api_key`
audit rows to `system`).

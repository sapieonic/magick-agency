# Magick Agency docs: start here

The entry point to the project's documentation: what Magick Agency is, where it stands on one
screen, a map of every doc, and what to read first depending on why you are here. Status claims
are as of 2026-10-09.

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
Last full run: lint clean in 7 packages; server 6457 unit / 1172 integration; console 4367;
super-admin 366; builds OK.

**Not done.** The launch (importing existing tenants and data, the DNC rollback mirror, dashboards).
Agency's dashboards and alert rules. The production image and compose file exist (`docker/`)
but have not run on a real host. Nothing has run against a real carrier, a real Firebase sign-in or
production data.

**Needs Manas.** Ratify the launch defaults and Q3; `supervisor_hold`; shutdown grace (45 s,
now in the production compose file) and in-flight pacing ticks; B15 roster supersede; vendor setup; the gated checks (real
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
| [`decisions.md`](decisions.md) | Every decision by ID: settled S1–S8, launch decisions, build decisions B1–B17, rulings Q1–Q9, still open with owner |
| [`seams.md`](seams.md) | Where files go, module-area files and config keys, the cross-module seams, shared infrastructure |
| [`operations.md`](operations.md) | Config essentials and defaults, deployment invariants, shutdown, migrations, recordings, TLS, proxy count |
| [`../README.md`](../README.md) | Dev setup: prerequisites, infra, env, migration, first super-admin, running everything |
| [`../CLAUDE.md`](../CLAUDE.md) | Rules for agents working in this repo |
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
[`operations.md`](operations.md) → phase 10 in [`intent-and-plan.md`](intent-and-plan.md) →
[`decisions.md`](decisions.md) §2 and §5 (launch decisions still open; Q4 maps imported `api_key`
audit rows to `system`).

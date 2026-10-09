# Magick Agency docs: start here

This is the entry point to the project's documentation: what Magick Agency is, where it stands
on one screen, a map of every doc, and what to read first depending on why you are here. Status
claims are as of 2026-10-09.

## What Magick Agency is

Magick Agency is a human-agent outbound power dialer: supervisors load campaigns, the dialer
paces calls to the number of available agents, and each answered call is bridged to an agent's
browser over WebRTC and VoiceLink. It was extracted from the MagickVoice platform (core, master
and cusui) into one self-sufficient application with its own server, database, carrier account
and identity data, sharing only the Firebase project. The code was ported verbatim from
MagickVoice wherever possible, with every change recorded in `PORTING.md`.

## Status on one screen

**Done.** Plan phases 1–9 on the code side: scaffold, contracts and baseline schema, platform
(identity, tenancy, RBAC, invites, settings, super-admin, notifications, audit), domain and data,
voice engine, runtime, analysis, the merged API, the console and super-admin UIs. Manas's
2026-10-09 rulings on the open questions and branding are implemented. Final run: lint clean in 7
packages; server 6380 unit / 1172 integration; console 4367; super-admin 366; builds OK. On GitHub
as `sapieonic/magick-agency` (private).

**Not done.** Phase 10 cutover (gate queries, copy scripts, DNC mirror, cusui link, Grafana
selector). No OpenTelemetry metrics or trace export. The production image and compose file exist
(`docker/`) but have not run on a real host.
Nothing has run against a real carrier, real Firebase sign-in or production data.

**Needs Manas.** Ratify the plan §7 defaults and Q3; `supervisor_hold`; shutdown grace (45 s,
now in the production compose file) and in-flight pacing ticks; B15 roster supersede; Phase 0 vendor setup; the gated
items (real VoiceLink call, real recording analysed, Playwright happy path, parity diff, dark
pilot); cutover decisions.

Details and next steps: [`status.md`](status.md).

## Map

| Doc | What it holds |
|---|---|
| [`status.md`](status.md) | Where it is: phase table with evidence, test counts, GitHub vs local history, what is not built, open decisions and owners, deployment invariants, pre-deploy checklist, next steps |
| [`intent-and-plan.md`](intent-and-plan.md) | Why the extraction, why not a voice gateway, settled decisions S1–S8, scope, what the platform layer now owns, phases 0–10, invariants, out of scope |
| [`architecture.md`](architecture.md) | How it is built: packages, server composition and start/stop order, the hop collapse, identity, runtime, voice engine, analysis, DNC, audit, UIs, observability, tests, CI |
| [`decisions.md`](decisions.md) | Every decision by ID: settled S1–S8, plan §7, build B1–B17, rulings Q1–Q9, still open with owner |
| [`seams.md`](seams.md) | The path rule, lane-owned files, config keys per block, and the cross-lane seams; still the module boundaries |
| [`operations.md`](operations.md) | Config essentials and defaults, deployment invariants, shutdown, migrations, recordings, TLS, proxy count |
| [`history/`](history/README.md) | The build record: how it was run, the frozen v4.2 plan, the build log, the agents' briefs |
| [`reference/`](reference/README.md) | Verbatim copies of the MagickVoice design docs and agent guides that code comments cite (`agency.md`, `service-map.md`, the dialer design, the source repos' `CLAUDE.md`), each with its origin commit and how it maps here |
| [`../README.md`](../README.md) | Dev setup (prerequisites, infra, env, migration, first super-admin, running everything) |
| [`../CLAUDE.md`](../CLAUDE.md) | Rules for agents working in this repo |
| [`../PORTING.md`](../PORTING.md) | The port ledger: one row per ported file, source → destination, verbatim / modified / deleted, and per-file test counts |
| `../packages/db/BASELINE.md` | The baseline schema inventory and every source migration folded into it |

## Reading order

**A new engineer:** this page → [`intent-and-plan.md`](intent-and-plan.md) →
[`architecture.md`](architecture.md) → the root [`README.md`](../README.md) to get it running →
[`seams.md`](seams.md) before moving files or adding config → [`decisions.md`](decisions.md) when
a comment cites an ID → [`reference/`](reference/README.md) when a comment cites a MagickVoice doc.

**A reviewer:** [`status.md`](status.md) → [`decisions.md`](decisions.md) (especially B7, B8, B15,
B16, Q1, Q6, Q8, Q9) → [`architecture.md`](architecture.md) → `PORTING.md` for the files under
review → [`history/build-log.md`](history/build-log.md) for how each phase was reviewed.

**Whoever does cutover:** [`status.md`](status.md) (not built, invariants, checklist) →
[`operations.md`](operations.md) → the plan's Phase 10 in
[`history/extraction-plan-v4.2.md`](history/extraction-plan-v4.2.md) →
[`decisions.md`](decisions.md) §2 and §5 (cutover decisions still open; Q4 maps copied
`api_key` audit rows to `system`).

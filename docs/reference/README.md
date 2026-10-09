# Reference copies of MagickVoice documents

Verbatim copies of the MagickVoice design documents and agent guides that Magick Agency's code,
comments and docs cite, so that nothing in this repo points at a document outside it. Read one
when a comment cites it ("`agency.md` §6.2", "master CLAUDE.md RBAC rule 1"), or when you need the
reasoning behind a ported behaviour. Copied on 2026-10-09 and **not kept in sync**: they describe
MagickVoice at the pinned commits, not Magick Agency. Each file opens with a box giving its origin
(repo, path, commit) and how it maps to Magick Agency; the body below the box is unchanged.

The layout mirrors each origin repo, so relative links between copies (for example from
`magickvoice-platform/docs/agency-dialer-delivery-plan.md` to `agency-dialer-design.md`) still
resolve. Links to documents that were not copied do not.

**Contains internal links (org-private):** private GitHub repo URLs, a ClickUp ticket link, a
Grafana Cloud host and a private claude.ai artifact link. They are kept as written; the repo is
private to the same organisation.

The extraction plan the build followed is not here; its one copy is
[`../history/extraction-plan-v4.2.md`](../history/extraction-plan-v4.2.md).

## Origins

| Folder | Origin | Commit |
|---|---|---|
| `magickvoice-platform/` | The MagickVoice superproject | `e32a5db` (its HEAD on 2026-10-09), except where noted |
| `magic-voice-core/` | core | `4850d1d9` (v1.123.2), the port's source |
| `magick-master/` | master | `a1f0756a` (v3.24.0), the port's source |
| `magick-comms-cusui/` | cusui | `ee5beb44` (v2.96.0), the port's source |

## Index

| Copy | What it is |
|---|---|
| [`magickvoice-platform/agency.md`](magickvoice-platform/agency.md) | The agency dialer as it ran in MagickVoice: domain, state machine, pacing, lifecycle, contracts, gating, billing, tests. The main domain reference |
| [`magickvoice-platform/service-map.md`](magickvoice-platform/service-map.md) | How core, master and cusui communicate (mostly collapsed in agency) |
| [`magickvoice-platform/CLAUDE.md`](magickvoice-platform/CLAUDE.md) | The superproject's agent guide |
| [`magickvoice-platform/docs/agency-dialer-design.md`](magickvoice-platform/docs/agency-dialer-design.md) | Dialer architecture, D1–D11 and §7b |
| [`magickvoice-platform/docs/agency-dialer-delivery-plan.md`](magickvoice-platform/docs/agency-dialer-delivery-plan.md) | The dialer's ticketed delivery plan inside MagickVoice |
| [`magickvoice-platform/docs/agency-campaign-retry-wire-contract.md`](magickvoice-platform/docs/agency-campaign-retry-wire-contract.md) | Retry campaigns: frozen wire shapes |
| [`magickvoice-platform/docs/agency-campaign-retry-design.md`](magickvoice-platform/docs/agency-campaign-retry-design.md) | Retry campaigns: design |
| [`magickvoice-platform/docs/agency-isolation-handoff.md`](magickvoice-platform/docs/agency-isolation-handoff.md) | Agency vs AI-product scope isolation handoff (from branch `origin/claude/session-setup-vdwl2i` @ `1b41674`; never on the superproject's main) |
| [`magickvoice-platform/docs/agency-extraction-build-handoff.md`](magickvoice-platform/docs/agency-extraction-build-handoff.md) | The handoff the build session started from (untracked in the superproject, no SHA) |
| [`magic-voice-core/CLAUDE.md`](magic-voice-core/CLAUDE.md) | Core's agent guide |
| [`magic-voice-core/docs/webrtc-human-calling-design.md`](magic-voice-core/docs/webrtc-human-calling-design.md) | The WebRTC human-calling bridge design |
| [`magic-voice-core/docs/voicelink-telephony-implementation-plan.md`](magic-voice-core/docs/voicelink-telephony-implementation-plan.md) | The VoiceLink adapter plan |
| [`magic-voice-core/docs/voicelink-audio-file-announcements-contract.md`](magic-voice-core/docs/voicelink-audio-file-announcements-contract.md) | Audio-file decode contract (abandon clips) |
| [`magic-voice-core/docs/escalate-to-human-transfer-design.md`](magic-voice-core/docs/escalate-to-human-transfer-design.md) | AI-call transfer design; cited only for a concurrency-slot rule |
| [`magic-voice-core/docs/superpowers/plans/feature-flags-tech-plan.md`](magic-voice-core/docs/superpowers/plans/feature-flags-tech-plan.md) | Feature-flag service and overrides |
| [`magick-master/CLAUDE.md`](magick-master/CLAUDE.md) | Master's agent guide (RBAC rules 1–3 that many ported comments cite) |
| [`magick-comms-cusui/CLAUDE.md`](magick-comms-cusui/CLAUDE.md) | cusui's agent guide |
| [`magick-comms-cusui/docs/superpowers/plans/feature-flags-ux-redesign.md`](magick-comms-cusui/docs/superpowers/plans/feature-flags-ux-redesign.md) | Feature-flags UX (super-admin pages) |
| [`magick-comms-cusui/docs/core-ui-redesign/02-design-spec.md`](magick-comms-cusui/docs/core-ui-redesign/02-design-spec.md) | Console copy dictionary |

## Cited but not copyable

- **core `experiment/FINDINGS.md`**, cited by `apps/server/src/telephony/voicelink/voicelink.types.ts`.
  It was never committed to core (no commit on any branch touches `experiment/`), so there is
  nothing to copy; the comment now says so.

## Not covered here

Comments that cite source **code** ("core `src/agency/x.ts:120`@4850d1d9", "ported from master
`src/index.ts`") are port provenance, not design references. They are read in the MagickVoice
repos at the pinned commits; [`PORTING.md`](../../PORTING.md) maps every ported file.

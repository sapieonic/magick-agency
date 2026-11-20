# Agent station redesign

The agent's working screen, redesigned for the web console and the Flutter app from mock-ups
made with the agents who use the station every day: one state per screen, a full-width coloured
band that says where the agent is, big numbers, picture tiles and one main button. Decided
2026-11-20; the build of phases 0 to 2 started the same day.

- **Design:** [`agent-station/design-spec.md`](agent-station/design-spec.md) (the state machine, every
  screen with its exact copy, the data each screen needs, behaviour rules, accessibility) and the
  mock-ups [`agent-station/mockups/preview.html`](agent-station/mockups/preview.html) (open in a
  browser; [`tokens.css`](agent-station/mockups/tokens.css) holds the state colours).
- **Backend:** [`agent-station/backend-plan.md`](agent-station/backend-plan.md), work items BE-0 to
  BE-17, checked against the code on 2026-11-19. Its section 8 answers are replaced by the rulings
  below where they differ.
- **This file:** the rulings (AS1–AS18), the scope, the build plan and its status.

Where the design spec, the backend plan and this file disagree, this file wins.

## 1. Rulings

Manas's comments on the proposal (2026-11-20) settle the spec's open questions. Where he left a
recommendation without a comment it stands as recommended.

| ID | Ruling | Status |
|---|---|---|
| AS1 | **One state per screen.** The station shows one screen per agent state (the spec's §2 state machine, no new server state), a full-width band in that state's colour with its icon, title and subtitle, and one main button in a fixed corner (bottom right on the console, bottom full width on the phone). Controls that do not belong to the state are **hidden, not disabled**; the one exception is Save on What happened? before a tile is picked (spec §6.1). This replaces the station's "nothing ever moves" rule with "the main button never moves, and nothing moves while a state is on screen". The server stays the judge: a hidden button is not a permission, and every refusal is still handled | **Decided** (Manas, 2026-11-20) |
| AS2 | **AI comes last.** Phases 3 (AI pick after hang-up) and 4 (the live line) are not in this build. Until then the On call screen shows the script when the campaign has one, else the last calls and a note (the spec's `04c`); nothing on screen says "AI" | **Decided** (Manas, 2026-11-20) |
| AS3 | **End call keeps today's protection**, made visible. Console: press and hold, with the button filling as it is held and the words "Hold to end call"; `E` then `E` still works. Phone: a slide-to-end control ("Slide to end call"). A customer's own hang-up moves the screen on by itself, as today | **Decided** (Manas, 2026-11-20): keep today's behaviour, make it clear to the agent |
| AS4 | **Outcomes stay per campaign** (`disposition_catalog`, any number). The tiles follow the spec's §6.2 layout rules; we recommend six. New campaigns can start from a "Collections" set of six (Will pay, Call later, No one spoke, Refused, Wrong number, Don't call again) offered in New campaign | **Decided** (as recommended) |
| AS5 | **Need help on every working screen** (BE-9): a raise is accepted in any state of a live session, not only on a call or in wrap-up; a supervisor's message answers it when there is no call. With no internet the screen says "Call your supervisor to your desk" and supervisors are alerted by themselves when a working agent has been disconnected for more than 20 seconds (BE-11) | **Decided** (as recommended) |
| AS6 | **Daily target** is one number per campaign (`daily_target_calls`), counted in connected calls (conversations), set in campaign Settings. Per-agent targets follow later | **Decided** (Manas, 2026-11-20) |
| AS7 | **"Will pay"** in My day counts the agent's outcomes today that recorded a pay date. On a campaign whose outcomes record none it is `null` and the tile is not shown | **Decided** (as recommended) |
| AS8 | **Call-later routing is unchanged.** The campaign's routing (pool, preferred, strict) decides who gets a due call-later, as today; no sticky call-later on pool (BE-3b is dropped). The booker is recorded (BE-3) only to list the agent's own call-laters and to tag "You said you will call at 3:00 PM"; the copy follows the server's `comes_to_me` ("These calls will come to you on time." or "We will call them on time. Another agent may get the call.") | **Decided** (Manas, 2026-11-20) |
| AS9 | **Phone number display is a campaign setting** the supervisor chooses: `phone_display: 'full' \| 'masked'`, default `'full'` (today's behaviour). Masked shows `98••• ••321` on every station screen, console and app. The server still sends the number (the soft phone and customer history need it); hiding it on the server is later work (BE-7 step 2) | **Decided** (Manas, 2026-11-20): supervisor sets mask or full |
| AS10 | **A break during a call** is booked with `B` or with Save & take break on What happened?; no visible break button on the call screen. The server already supports a pending break | **Decided** (as recommended) |
| AS11 | **No stop button on Call coming.** `E` still stops a call while it rings on early-binding accounts | **Decided** (as recommended) |
| AS12 | **Break over time is recorded and supervisors get an alert.** When a break passes its reason's `limit_minutes`, supervisors in the account are alerted on every console page (the alerts read and chime of AS16), once per break; when the break ends, a session event records the minutes over, counted by a metric and shown in the agent report (BE-12) | **Decided** (Manas, 2026-11-20): "have the message" |
| AS13 | **Read aloud and Speak a note use the device's own speech**, no server. Console: the browser's speech synthesis reads a tile aloud (an `en-IN` voice when present) and speech recognition fills the note where the browser has it (the button is hidden where it does not). App: read aloud through the platform's text-to-speech; Speak a note opens the keyboard on the note, whose own microphone dictates | **Decided** (as recommended) |
| AS14 | **Light by default, dark on offer, everywhere.** The console, the super-admin console and the app open in light unless the user chose dark; the existing theme choice stays and every station screen works alike in both | **Decided** (Manas, 2026-11-20) |
| AS15 | **Copy is simple Indian English**: short sentences, everyday words, British spelling (cancelled, colour, dialled), ₹ with Indian grouping (₹1,25,000), dates "20 Nov", times "3:00 PM". Station screens never show the spec's §6.6 jargon list. The station shows its own words keyed on a code, never a server sentence | **Decided** (Manas, 2026-11-19) |
| AS16 | **Supervisor alerts on every page.** One light read, `GET /proxy/agency/floor/alerts` (`agency.supervise`), polled every 5 s from the console shell, lists the account's open alerts: Need help, break over time, agent disconnected. A chime (the existing `useHelpChime`, mutable per browser) and a banner on every supervisor page; Live floor keeps its cards. No push channel (backend plan BE-10, BE-11 and AS12 merged into one read) | **Decided** (the build's call, 2026-11-20) |
| AS17 | **Scope of this build: phases 0 to 2.** P0 the new screens on today's data; P1 BE-1 to BE-5, BE-9 to BE-13, AS9, AS12, AS16; P2 BE-6 (typed customer facts) and BE-8 (the script), AS4's starter set, AS13. Not built: BE-3b, BE-7 step 2, BE-14 to BE-17 | **Decided** (Manas, 2026-11-20) |
| AS18 | **Old app builds keep working.** Every new contract field is optional, nothing is renamed or removed, new frames go only to a station that declares the capability, and the Dart decoder ignores what it does not know | **Decided** (the build's call, 2026-11-20) |

## 2. Build plan

Work is split into streams with one owner each, built on their own branches and git worktrees
and merged into the build branch by the lead. Shared files (`packages/contracts`, the
migrations, the server's seams and app wiring) change only in the stream that owns them.

| Stream | Owns | Items | Needs |
|---|---|---|---|
| **F. Foundation** | `packages/contracts` (+ fixtures, literals, `CONTRACT-DIFF.md`), `packages/db/migrations`, `apps/mobile/packages/agency_wire` | Every P1/P2 wire type and column: my-day, call-later booker columns, `attempt.callback`, `attempt.facts`, `context_display.roles/.types`, the script, `daily_target_calls`, `phone_display`, tile icons, help `state_at_raise`, the alerts read, `disconnected_since`, break overrun | Nothing |
| **C1. Console station** | `apps/console` station pages and components, `packages/web-ui` tokens | P0 screens on today's data (AS1, AS3, AS10, AS11, AS13 read-aloud and speak-a-note, AS14, AS15); then P1/P2 wiring | F for the wiring |
| **M1. App station** | `apps/mobile/lib` | The same in Flutter (AS3 slide-to-end, AS13, AS14) | F for the wiring |
| **S1. Station data** | `apps/server` agency station reads, dialer panel, pacing queue frame | BE-1 my-day, BE-2 target, BE-3 booker, BE-4 call-later tag, BE-5 pool no-calls reasons | F |
| **S2. Help and alerts** | `apps/server` floor assist, floor reads, breaks, campaign config | BE-9, AS16 alerts read (BE-10, BE-11, AS12 alert), BE-12, BE-13 icons, AS9 `phone_display` | F |
| **S3. Facts and script** | `apps/server` campaign config, dialer panel facts, bootstrap | BE-6, BE-8, AS4 starter set | F |
| **C2. Console supervisor** | `apps/console` campaign Settings, New campaign, the shell's alerts, super-admin theme default | Editors for target, script, column roles and types, icons, phone display; AS16 banner and chime on every page; AS4 in New campaign; AS14 in super-admin | S1–S3 routes |

Merge order: F, then S1/S2/S3 (any order), then C2 and the C1/M1 wiring. Every merge is followed
by the lead's run of lint and the touched packages' suites.

## 3. Status

| Stream | Status | Evidence |
|---|---|---|
| F | Merged 2026-11-20 | `0056_campaign_station_settings.sql` to `0060_session_event_break_overrun.sql`; contracts 616 passed; db unit 457, integration 877; `agency_wire` 761; app `flutter test` 2041; lint clean |
| C1 | In progress | |
| M1 | Phase 0 merged 2026-11-20; wiring in progress | `flutter analyze` clean; `flutter test` 2121 passed on the merged branch |
| S1 | In progress | |
| S2 | Merged 2026-11-20 | Server unit 10,617 passed on the merged branch (3 failures in `inbound-recordings.test.ts`: no audio decoders in the build container); domain 364; grafana 34; renderer 94; integration rest 266, wall-clock 5 (relevant files); lint clean |
| S3 | Merged 2026-11-20 | Domain 360 passed; contracts 617; server unit 10,590 passed (3 failures in `inbound-recordings.test.ts`: no audio decoders in the build container); integration rest 213, wall-clock 4 (relevant files); lint clean |
| C2 | Not started | |

Nothing here has run on a real phone, a real carrier or with real agents.

# The golden end-to-end suite

`apps/e2e` drives the whole product in a real browser (Playwright, Chromium) against the real
server, the built console and super-admin, Postgres and Redis. Everything outside the repository
is simulated: the carrier, Firebase sign-in, mail, S3, the AI providers and the recording host.
No vendor account and no service-code change is needed. It is the golden set: before a feature
merges, the suite shows it works end to end and that nothing else broke.

It runs **on demand only**, never in regular CI:

```bash
pnpm e2e                               # everything: fresh database, UI builds, stack, all specs
pnpm e2e --grep "Do not call"          # specs whose title matches
pnpm e2e --skip-build                  # reuse the last e2e build of the two UIs
pnpm e2e:stack                         # bring the stack up and keep it up (Ctrl-C ends it)
```

On GitHub, run the **E2E (golden)** workflow (`.github/workflows/e2e.yml`) from the Actions tab
(Run workflow, pick the branch; optional `grep` and `repeat_each`), or
`gh workflow run e2e.yml --ref <branch> -f grep="..."`. The HTML report, the traces and videos of
failed specs and the server log are uploaded as an artifact; the run's summary has the counts.

A full run takes about 2½ minutes on a laptop-class machine (the specs about 2 minutes). Ports:
server 3031, console 5185, super-admin 5186, simulator 3041 (each movable with
`E2E_<NAME>_PORT`), on the project's Postgres (5436, database `magick_agency_e2e`) and Redis
(6383, db 15). The dev stack (3021, 5175, 5176) can stay up beside it.

## 1. How it fits together

```
 Playwright (Chromium, fake microphone)
   │  console :5185, super-admin :5186           identitytoolkit / securetoken.googleapis.com
   ▼                                              └─ routed by Playwright to the simulator
 edge (src/edge.ts) ─ static dist/ + the API prefixes, as nginx does in production
   │
   ▼
 server :3031 (apps/server/src/index.ts, unchanged)  ── node --import server-preload.mjs
   │  env from src/env.ts                              (fixed vendor hosts → simulator,
   │                                                    any other outside host refused)
   ├─ VOICELINK_BASE_URL ───────────────► simulator: VoiceLink (the server's own test mock)
   │         ◄── webhooks + media WebSocket, dialled back to :3031
   ├─ FIREBASE_AUTH_EMULATOR_HOST ───────► simulator: fake Firebase Auth (token lookups)
   ├─ AWS_ENDPOINT_URL_S3 ───────────────► simulator: S3
   ├─ api.mailjet.com (preload) ──────────► simulator: mailbox
   ├─ POST_CALL_ANALYSIS_BASE_URL, GOOGLE_GEMINI_BASE_URL ► simulator: AI
   └─ recording.e2e.invalid (preload) ────► simulator: recordings
```

- **The server is not modified.** Every vendor is redirected either by a setting the server
  already has (`src/env.ts` sets the whole environment; the developer's `apps/server/.env` is
  never read) or, for the three hosts fixed in its code (Plivo's API, Mailjet, the recording
  host), by `src/server-preload.mjs`, which wraps `fetch` in the server process only. The preload
  also refuses every request to a host that is not loopback, so a run can never reach a real
  vendor.
- **The console is not modified.** It signs in with the Firebase JS SDK as in production;
  Playwright routes the SDK's two Google hosts to the fake (`fixtures/test.ts`). The server runs
  with `FIREBASE_AUTH_EMULATOR_HOST`, which puts `firebase-admin` in emulator mode: it accepts the
  fake's unsigned tokens and looks each user up on the simulator. That variable is set in the
  e2e environment only.
- **The production bundles are tested.** `src/run.ts` builds both UIs (into `apps/e2e/.run/`,
  never over a developer's `dist/`) with the fake Firebase settings, and the edge serves them on
  one origin with the API, as `docker/nginx.conf` does.

## 2. The simulated customer

The carrier is the server's own VoiceLink mock (`apps/server/test/mocks/voicelink`), so it speaks
exactly the protocol the adapter and the bridge expect: the REST API, webhooks posted back, and
the media WebSocket dialled back to the server with paced A-law audio. `src/sim/voicelink.ts`
drives each call by a **persona**, chosen by the last two digits of the dialled number, so a spec
knows every outcome from the CSV it loads:

| Ends in | Persona | What the customer does |
|---|---|---|
| `01` (and anything not below) | `answer` | rings ~0.8 s, answers, talks until the agent hangs up (or a spec hangs up for them) |
| `02` | `busy` | rings, then busy |
| `03` | `no_answer` | rings, never answers |
| `04` | `failed` | the carrier fails the call |
| `05` | `answer_then_hangup` | answers, talks ~4 s, hangs up |
| `06` | `silent` | answers and sends silence |

`phoneWithPersona('01')` (fixtures) makes a unique number with that ending. A spec can also
override one number (`sim.setPersona(number, 'busy', { ringMs })`) or hang up for the customer
(`sim.hangup(number)`). The simulator records each call: its state, who ended it, and how many
frames the agent's side sent and how many carried sound (Chromium's fake microphone beeps), so a
spec checks that audio really flowed both ways.

The control API is `http://127.0.0.1:3041/_sim/*` (`src/sim/index.ts`); specs use it through
`src/fixtures/sim-client.ts`.

## 3. Seeding

Each test gets a fresh tenant (`world` fixture, `src/fixtures/world.ts`) made through the product's
own APIs, never SQL: the super-admin REST API creates the tenant, a supervisor, two agents and two
caller IDs, and each user is registered with the fake Firebase. Their first console sign-in
activates the membership, exactly as a real first sign-in does. `supervisorApi.createCampaign()`
(`src/fixtures/console-api.ts`) then makes a running campaign in seconds with the calls New
campaign makes (upload, check, import, staff, start), dialling all day every day so a run at any
hour dials. Specs that are about those steps (onboarding, the invite, New campaign) drive them in
the UI instead.

Specs are independent and run one at a time (`workers: 1`): one server, one station per agent and
wall-clock dialler timers. Any spec runs alone.

## 4. What the golden set covers

| Spec | Checks |
|---|---|
| `01-smoke` | the super-admin, a supervisor and an agent each reach their landing page through the real sign-in; a wrong password is refused |
| `02-tenant-onboarding` | the super-admin adds a tenant in their console; its owner receives the invitation, sets a password on the join page and lands in the organisation |
| `03-invite-agent` | a supervisor invites an agent from Team; the agent joins from the mail; Team shows them joined |
| `04-new-campaign-wizard` | New campaign's four steps in the UI (CSV through the simulated S3), Start, the contacts listed, and the staffed agent's first call |
| `05-core-call` | dial, answer, the call put through with the customer's card, audio both ways, the caller ID and number on the carrier request, the agent hangs up and files an outcome, the Call log row |
| `06-customer-hangs-up` | the customer hangs up first (persona and on cue): the station goes to wrap-up by itself |
| `07-unanswered-calls` | busy, no answer and failed calls never reach the agent and are logged with what happened |
| `08-pause-resume` | a paused campaign dials nothing with an agent waiting; Resume dials |
| `09-do-not-call` | an agent files Do not call (with its confirmation); the number is on the Do Not Call list |
| `10-soft-phone` | a manual call from the soft phone, answered, ended, filed and in My calls |
| `11-customer-history` | the called number in the agent's and the supervisor's customer history, with campaign and outcome |
| `12-access` | an agent is kept to their screens (UI and API); a supervisor cannot open another organisation (UI and API) |
| `13-live-floor` | the supervisor's Live floor follows the agent: on a call, choosing an outcome, on break |
| `14-two-agents` | two agents get different customers at the same time, each with their own audio |

**Not covered yet** (the simulator has the pieces for some): inbound calls and Plivo (the preload
already sends `api.plivo.com` to the simulator; it needs the server's Plivo mock mounted on it and
`POST /_sim/inbound`), live call listening, reports (the in-process renderer and the fake S3 are in
place), campaign templates, Insights and Compare agents, call analysis (the fake AI endpoints
answer, but their answers are not yet checked against the analysis worker's parsing), and the
mobile app. Add them as specs in the same style.

## 5. Adding a spec

1. A file `specs/NN-<what>.spec.ts`, importing `test` and `expect` from `src/fixtures/test.ts`.
2. Seed what the spec is not about through `world` and `supervisorApi`; drive what it is about in
   the UI. Pick each contact's behaviour by its number's ending.
3. Wait on what the product shows or the simulator records (`expect(...)`, `expect.poll`,
   `toPass`), never a fixed sleep, except to show that something does *not* happen (pause).
4. Prefer roles and labels (`getByRole`, `getByLabel`) to classes. Page helpers live in
   `src/pages/` (`Station`, `CampaignPages`, the super-admin sign-in).
5. Run it alone against a stack that stays up: `pnpm e2e:stack` in one terminal, then
   `E2E_STACK=up pnpm --filter @magick-agency/e2e exec playwright test specs/NN-*.spec.ts`
   (add `--ui` or `--headed` to watch it). Then run the whole set with `pnpm e2e`.

A change that alters a flow a spec drives (a renamed button, a new step) updates the spec in the
same pull request; the suite is the agreed description of how the product behaves.

## 6. Where CI stands

Regular CI never runs the browser suite. Because `apps/e2e` imports the server's carrier mock, a
change to the server (or a package it depends on) lints the e2e package and runs its unit tests
(`apps/e2e/test/`: the fake Firebase against `firebase-admin`'s emulator mode, the fake S3 through
the AWS SDK, the personas, the preload's redirects and refusal, the target guards), which takes
seconds and keeps the suite compiling (`tooling/ci-scope.test.mjs` pins this).

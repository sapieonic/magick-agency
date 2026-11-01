# The agent mobile app

The agent-only app in `apps/mobile`: one Flutter project that builds the Android and the iOS app.
Agents sign in, go on duty on a campaign, take power-dialled calls, write up each call and see
their own numbers. Supervisors and admins stay on the web consoles. This doc covers what V1 does
and leaves out, how it talks to the server, the rules that keep a customer from reaching an
absent phone, and how it is built and tested. Running it locally: `apps/mobile/README.md`.
As of 2026-11-01.

## Scope

**In V1**:

- sign-in (email and Google) and the invite flow;
- account choice and the campaign list;
- the pre-flight checks;
- the station: go on duty, take calls, notes, dispositions, DNC, breaks and leave;
- My performance and My calls;
- the Me tab: account switch, email preferences, sound and vibration, diagnostics, sign out.

**Out of scope**, kept on the web console:

- supervising, the floor, coaching;
- campaign set-up and rosters;
- recordings and transcripts, which are supervisor-only reads;
- the soft phone (manual dialling);
- team and invite management.

The app is a second client of the same server as the console: the public API (`/auth`,
`/accounts`, `/proxy/agency/*`) and the station WebSocket. It has no API of its own.

## The rule that shapes everything

**Waiting for a call requires the app on screen.** A phone in a pocket with the app in the
background cannot be trusted to ring: the OS may freeze the process, and the dialer would bridge a
customer to nobody. So:

- **Leaving the app while `available`** sends `POST /proxy/agency/sessions/:id/break
  {reason: 'device_away'}` at once. The server applies it by CAS (`api/routes/agency/device-away.ts`).
  The app also stops its app-level pings, so if the request never lands the server's mobile grace
  closes the station anyway. A local notification says "You're paused. Open the app to take calls
  again."
- **Leaving during `reserved`, `on_call` or `wrapup`**: the call keeps going (the audio session,
  CallKit on iOS and the on-duty foreground service on Android keep the process alive), and
  `device_away` is QUEUED behind it, so the agent is paused after the call rather than made
  available while away. In wrap-up, a notification carries the save-by time.
- **Coming back**: the app cancels those notifications, resumes pings, reconnects if needed and
  trusts the `ready` snapshot; the station shows a "Paused · you left the app" card from
  `onBreak.isDeviceAway`. The return is the ordinary `/available`.
- **While on duty and in the foreground**, the screen is kept awake (`wakelock_plus`).

`device_away` is a reserved break code (`packages/contracts/src/agency/breaks.ts`), like
`soft_phone`: no campaign may list it, and the console floor labels it "Away (app in background)".

## Talking to the server

| Concern | How |
|---|---|
| Identity | Firebase ID token as `Authorization: Bearer`, refreshed when older than 50 min and retried once on a 401 (`lib/core/api/api_client.dart`) |
| Scope | `X-Tenant-Id` / `X-Account-Id` from `RequestScope`, set by the app gate after account choice |
| Client | `X-Client: magick-agency-mobile/<semver>+<build> (<ios\|android> <osver>; <model>)`. It labels logs (`utils/client-header.ts`) and picks the mobile station intervals. It is never a rate-limit key or a security input |
| Rate limits | Per verified user (`RATE_LIMIT_USER_MAX`, 300/min), plus a bearer IP bucket (3000/min) so a call-centre NAT does not pool agents into one 200/min bucket ([`architecture.md`](architecture.md), decision Q9 amendment) |
| Joining | `POST /proxy/agency/sessions`: needs an active staffing row on the campaign, else `403 not_staffed`. A live session on another campaign or on the soft phone is a 409 the pre-flight screen resolves (leave it, or close the soft phone) |
| Version gate | `GET /client-config` (public): `mobile.min_supported`, `latest`, `store_urls`. Below the minimum, the app blocks on "Update required". A failed read never blocks start-up |
| Upload check | `POST /client-config/uplink-probe` (authenticated, 64 KB cap, 6/min per user): pre-flight times a 32 KB upload and refuses "Go on duty" below 64 kbps |
| Invite links | `https://<console host>/agency/join/<token>` opens the app through App Links / Universal Links; the web image serves `assetlinks.json` and `apple-app-site-association` (`docker/mobile-app-links.sh`, [`operations.md`](operations.md)) |

## The station socket

`/proxy/agency/station/:sessionId?token=…&client=mobile&media=alaw8`. `station_ws_url` is a path
relative to the API origin; the app resolves it against `API_ORIGIN` (`Env.resolveStationUrl`).

- **`client=mobile`** tunes liveness and is written to `agency_agent_sessions.client_kind` (0006)
  on every attach. The server pings a mobile station every 3 s (`MOBILE_STATION_PROBE_MS`); a
  protocol pong or an app ping renews it in memory. It closes a silent mobile station 10–15 s
  after its last sign of life (`MOBILE_STATION_HEARTBEAT_GRACE_MS` 10 s, swept every 5 s); a
  console gets 30 s. A silent phone on a call the agent can see is dropped too (decision M1),
  with `terminate` so the bridge's 8 s deferred hangup starts at once: back in time, the call
  resumes; otherwise it ends. A dial still ringing before the bind keeps its pre-bind grace,
  and a console with a live call is never closed.
- **`media=alaw8`**: audio travels as binary frames of raw G.711 A-law, 8 kHz mono, 160 bytes per
  20 ms, both ways. Text frames stay JSON control. With VoiceLink, whose wire audio is already
  A-law, the server relays the bytes untouched: no transcoding, no base64, no JSON per frame.
  Other carriers are transcoded. An unknown `client=` or `media=` is refused 1008 before the
  single-use token is spent (`parseStationUpgradeQuery`).
- **Reconnects** follow the console's ladder (0.5, 1, 2, 5, 10, 15 s; reset on pong, not on open).
  Every attempt mints a new token (a mint replaces the previous one, so the app never pre-mints a
  spare). An OS network change reconnects at once. Mid-call, the server ends the call if the
  socket is not back within `deferred_hangup_ms` (8 s); the station shows that deadline.
- **Close codes**:
  - 4401 / 4408: re-mint and retry.
  - 4404: the session is gone.
  - 4409: superseded by another device; "Use this phone" takes it back.

## Inside the app

```
lib/
  app/        router (gate-driven redirects), tabbed shell, theme tokens mirrored from packages/web-ui
  core/
    api/        ApiClient: bearer, scope headers, X-Client, request ids, typed errors
    auth/       the app gate: client-config → Firebase user → session → accounts → ready
    session/    account choice and local preferences
    station/    reducer (a port of the console's), server clock, socket, controller, view mapper
    audio/      orchestration of packages/agent_audio by phase
    lifecycle/  foreground rules (device_away), wake lock, local notifications
  features/   auth, join, accounts, campaigns, preflight, station, performance, calls, settings
packages/
  agency_wire/  hand-written Dart types for the API and station frames
  agent_audio/  the native voice engine (Kotlin, Swift)
```

- **The station seam.** `lib/core/station/station_view.dart` is the only thing the station
  screens read (`StationView`, `StationActions`, `StationLauncher`); the core derives the view with
  memoisation so an unchanged slice keeps its identity and widgets `select` narrowly.
  `station_signals.dart` gives the shell its three facts (on duty, call active, campaign).
- **The app gate** (`lib/core/auth/app_gate.dart`) decides every top-level screen. An expired
  sign-in (a 401 anywhere) signs out, but never during a call or wrap-up: it waits for them to
  end, and leaves the station before signing out.
- **Audio** (`packages/agent_audio`):
  - The engine is pre-warmed when the station opens and at `available`.
  - The microphone is armed at `reserved` (with CallKit `startCall` on iOS).
  - Uplink starts at `bridged`.
  - It stops at `released`.
  - Capture uses the platform's voice processing (echo cancellation).
  - Playout goes through an adaptive jitter buffer, specified by the Dart model and ported to Kotlin and Swift, checked by a shared replay trace.
  - Audio never moves to the loudspeaker on its own.
  - One plugin instance serves the station and the pre-flight loopback.
- **Pre-flight**:
  - Checks the microphone permission, a loopback sound check ("Say hello"), the audio route, the network (round trip and measured upload), the battery and Android battery optimisation.
  - Only the microphone and the network block "Go on duty"; the rest is advice.
  - Grading lives in pure functions (`preflight_checks.dart`), separate from the measurements (`device_preflight_checks.dart`).
- **Wire types.** `agency_wire` is written by hand against `packages/contracts`. Drift is caught from both sides:
  - `packages/contracts/fixtures/agent/*.json` samples are type-checked against the TS contract (`agent-fixtures.test.ts`) and decoded by the Dart tests.
  - `tooling/contracts-literals.mjs` regenerates `literals.json`, the literal unions the app switches on. `--check` fails when it is stale, and so does `pnpm test` in contracts.
  - Every Dart enum has an `unknown` member, and the raw wire string is kept beside it, so a newer server never crashes an older app.

## Performance and UX rules the code keeps

- No per-frame JSON or copies on the 50 fps media path. One platform message per 20 ms frame, downlink handled off the main thread. A pooled uplink on Android.
- Timers that show a ticking clock use a 1 Hz timer aligned to its start, not a frame ticker.
- Lists use `ListView.builder` with fixed-height rows. My calls prefetches the next page about 20 rows early and debounces the number search by 400 ms.
- Stale-while-revalidate for Performance: the last result shows at once and refreshes behind it.
- 48 dp touch targets, reduced-motion respected, layouts tested at 200% text on a 360×640 phone.
- Live-region announcements for station phases ("Ringing", "On call", "Wrap-up", "Outcome saved").
- Copy follows the console's words wherever the console has them.

## Builds and releases

- **Toolchain:** Flutter 3.47.7, pinned in `.github/workflows/mobile.yml`.
- **CI:**
  - Contract literal drift, `flutter analyze`, the app's tests, `agency_wire` and `agent_audio` tests.
  - A debug Android build on every pull request touching the app or the contracts.
  - An unsigned iOS build on `main`.
- **Android:**
  - minSdk 28, compileSdk 37 (`permission_handler_android` requires it), targetSdk Flutter's default.
  - Flavours `dev`, `staging` and `prod` install side by side (`com.magickagency.agent[.dev|.staging]`).
  - AGP 9.1 looks for platform 37 as `android-37` while the SDK installs `android-37.0`; CI links the two.
- **iOS:**
  - Deployment target 16.0, background mode `audio`, CallKit for the system call UI.
  - Google sign-in needs the reversed iOS client id as a URL scheme in `Info.plist`, added once that client id exists.
- **Versions:** `pubspec.yaml` `version:` belongs to release-please (component `mobile`, `release-type: dart`). Store build numbers come from CI (`--build-number`).

## Not verified yet

- **iOS has never been compiled.** There is no Xcode in the build environment, so the Swift engine and CallKit code was reviewed against the SDK headers only.
- **No real device or carrier.** Nothing has run on a real phone, a real carrier call, or a real Firebase or Google sign-in.
- **Untested behaviour:** echo cancellation on low-end Android phones on speaker, and Bluetooth rate switches on iOS, need field testing.

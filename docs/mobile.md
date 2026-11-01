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
- the Me tab: account switch, email preferences, the dark theme switch, sound and vibration,
  diagnostics, sign out.

**The tab rule.** On duty and not on a break, the agent stays on the station: the other tabs are
disabled (a long press says why), and every route, an invite link included, leads back to the
station. A call takes the screen from wherever the agent is. On a break, or after leaving the
station, they move freely.

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
  It stops its app-level pings, but that alone does not take the agent out of the pool while the
  process lives: the OS keeps answering the server's protocol pings, so the station stays open and
  the agent stays dialable until the 45 s `available` lease lapses. So a pause that fails
  (`409 state_changing`, 429, 5xx, no network) is asked for again (1, 2, then every 3 s), and if it
  has not landed within 10 s, or is refused outright, while the agent is still `available`, the app
  closes the station socket itself: the server's close handler (`releaseStationOnClose`) writes the
  agent `offline` at once, and the app reconnects on return (the agent then goes available by
  hand). A local notification says "You're paused. Open the app to take calls again."
- **Leaving during `reserved`, `on_call` or `wrapup`**: the call keeps going (the audio session,
  CallKit on iOS and the on-duty foreground service on Android keep the process alive), and
  `device_away` is QUEUED behind it, so the agent is paused after the call rather than made
  available while away. In wrap-up, a notification carries the save-by time. If Android stops
  the on-duty service mid-shift anyway, the app hears it (an `OnDutyServiceStopped` event, shown
  as `MicProblem.serviceStopped`) and restarts the service on resume.
- **Coming back**: the app cancels those notifications, resumes pings, reconnects if needed and
  trusts the `ready` snapshot. `ready` (and the join's answer) carry `break_reason`, so a
  `device_away` break shows the "Paused · you left the app" card even after Android killed the
  app; any other reason shows that break's label. The app's own memory of asking is only the
  fallback for a server that sends no reason. The return is the ordinary `/available`. A pause
  queued behind a call is cancelled on return, however it was queued (asked as a queue, or asked
  at once and queued by the server because a call came in) and even when its answer lands after
  the return. A pause asked for and never confirmed, on a socket still open, is followed on return
  by `/available`, so a lease that lapsed while away is renewed and the agent really rings.
- **While on duty and in the foreground**, the screen is kept awake (`wakelock_plus`).

`device_away` is a reserved break code (`packages/contracts/src/agency/breaks.ts`), like
`soft_phone`: no campaign may list it, and the console floor labels it "Away (app in background)".

## Talking to the server

| Concern | How |
|---|---|
| Identity | Firebase ID token as `Authorization: Bearer`, from Firebase's own cache (it refreshes the token itself), forced fresh once on a 401 (`lib/core/api/api_client.dart`). The station refreshes a token older than 50 min before it mints a station token. A token Firebase cannot mint offline is a network error, never a sign-out |
| Scope | `X-Tenant-Id` / `X-Account-Id` from `RequestScope`, set by the app gate after account choice |
| Client | `X-Client: magick-agency-mobile/<semver>+<build> (<ios\|android> <osver>; <model>)`. It labels logs (`utils/client-header.ts`) and picks the mobile station intervals. It is never a rate-limit key or a security input |
| Rate limits | Per verified user (`RATE_LIMIT_USER_MAX`, 300/min), plus a bearer IP bucket (3000/min) so a call-centre NAT does not pool agents into one 200/min bucket ([`architecture.md`](architecture.md), decision Q9 amendment) |
| Joining | `POST /proxy/agency/sessions`: needs an active staffing row on the campaign, else `403 not_staffed`. A live session on another campaign or on the soft phone is a 409 the pre-flight screen resolves (leave it, or close the soft phone). The 409 names the session and its account; the app leaves it in that account. A server that names neither gets "leave it where it's open" rather than a rejoin in the wrong account |
| Version gate | `GET /client-config` (public): `mobile.min_supported`, `latest`, `store_urls`. Below the minimum, the app blocks on "Update required". A failed read never blocks start-up |
| Upload check | `POST /client-config/uplink-probe` (authenticated, 64 KB cap, 6/min per user): pre-flight times a 32 KB upload and refuses "Go on duty" below 64 kbps |
| Invite links | `https://<console host>/agency/join/<token>` opens the app through App Links / Universal Links; the web image serves `assetlinks.json` and `apple-app-site-association` (`docker/mobile-app-links.sh`, [`operations.md`](operations.md)) |

## The station socket

`/proxy/agency/station/:sessionId?token=…&client=mobile&media=alaw8`. `station_ws_url` is a path
relative to the API origin; the app resolves it against `API_ORIGIN` (`Env.resolveStationUrl`).

- **`client=mobile`** tunes liveness and is written to `agency_agent_sessions.client_kind` (0006)
  on every attach. The server pings a mobile station every 3 s (`MOBILE_STATION_PROBE_MS`); a
  protocol pong or an app ping renews it in memory. It drops a silent phone 10–15 s after its
  last sign of life (`MOBILE_STATION_HEARTBEAT_GRACE_MS` 10 s, swept every 5 s), on a call or
  not, with `terminate` rather than a close: a close handshake on a dead transport would hold
  the agent dialable for 30 s. The app sees an abnormal close (1006, not 4408) and reconnects
  either way; a console gets 30 s. On a call the agent can see (decision M1), the terminate
  starts the bridge's 8 s deferred hangup at once: back in time, the call resumes; otherwise it
  ends. A dial still ringing before the bind keeps its pre-bind grace, and a console with a live
  call is never closed.
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
  - 4401 / 4408, or a drop: re-mint and retry.
  - 4404: the session is gone. The station closes on this phone at once (socket, on-duty service,
    audio, wake lock, listeners; held notes are sent) and the screen says why until the agent
    goes back to the campaigns.
  - 4409: superseded by another device. The on-duty service and the audio stop at once, and the
    notification loses Mute / Hang up: the call moved, and nothing on this phone may end it (a
    notification hang-up carries no call id, so it is ignored when this phone holds no call).
    "Use this phone" starts them again and takes the session back; going back to the campaigns
    forgets the station here.
  - 1008: the server refused the upgrade (`invalid_client` / `invalid_media`): terminal, never
    retried. The station says to update the app, leaves the session (best effort) and closes here.
  - 1011: the server could not run the station: retried on the ladder, but three in a row with no
    `pong` between give up like a flapping socket (held while a call is live).
  - A give-up (silence, flapping, 1011) is the agent's to undo with Reconnect; returning to the app
    retries only a silence give-up.

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
  `station_signals.dart` gives the router and the shell their facts (on duty, call active, on a
  break, campaign).
- **The app gate** (`lib/core/auth/app_gate.dart`) decides every top-level screen. An expired
  sign-in (a 401 anywhere) signs out, but never during a call or wrap-up: it waits for them to
  end, and leaves the station before signing out. A sign-out held for a call the app never saw
  (an unannounced dial the leave was refused for) looks again every 15 s, and a 401 during the
  hold still signs out, with its notice, once nothing is live. Being offline never signs out:
  start-up shows the splash's offline notice and retries.
- **Leaving with no network**: Leave is always offered. When the server cannot be reached and no
  call is live, the station closes on this phone anyway and the agent is told plainly; the socket
  is gone, so the server's silence grace takes the agent off duty and the session is reaped or
  picked up again as for any lost phone. With a call live, the station stays.
- **Notes** save as the agent types (2 s debounce, a replace on the server). Unsent text is kept
  in the keystore until the server has it; the last saved text is kept too (until the 24 h
  sweep), so a call that comes back on screen (a `released` with no disposition owed, then its
  `wrapup`; or a restart rejoined into `active_wrapup`) shows what the server holds, never an
  empty field whose next keystroke would wipe it.
- **Routing** (`lib/app/router.dart`): one redirect, the gate's first and then, once ready, the
  station's (`stationRedirect`, the tab rule above). It re-runs whenever the gate or the station
  signals change, so it holds on every route and is a state, not a transition.
- **Per-workspace data** (the campaign list, email preferences, My calls, My performance) is
  keyed by `agentWorkspaceProvider` (`user:tenant:account`): another account or another agent on
  the same phone starts empty, never from the previous one's data.
- **Logs** stay on the phone (a 2,000-line ring the Me tab copies for support). Phone numbers in
  the usual written forms and email addresses are masked in messages and in every field value;
  invite tokens are cut from request paths.
- **Audio** (`packages/agent_audio`):
  - The engine is pre-warmed when the station opens and at `available`.
  - The microphone is armed at `reserved` (with CallKit `startCall` on iOS).
  - Uplink starts at `bridged`.
  - It stops at `released`.
  - Capture uses the platform's voice processing (echo cancellation).
  - Playout goes through an adaptive jitter buffer, specified by the Dart model and ported to Kotlin and Swift, checked by a shared replay trace.
  - Audio never moves to the loudspeaker on its own, and a route chosen during a call lasts for that call only.
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
  - Google sign-in needs the reversed iOS client id as a URL scheme. It is in `ios/Runner/Info.plist`, hard-coded for this repo's Firebase project; another project replaces it (`apps/mobile/dev-setup.md`).
- **Versions:** `pubspec.yaml` `version:` belongs to release-please (component `mobile`, `release-type: dart`). Store build numbers come from CI (`--build-number`).

## Not verified yet

- **iOS has never been compiled.** There is no Xcode in the build environment, so the Swift engine and CallKit code was reviewed against the SDK headers only.
- **No real device or carrier.** Nothing has run on a real phone, a real carrier call, or a real Firebase or Google sign-in.
- **Untested behaviour:** echo cancellation on low-end Android phones on speaker, and Bluetooth rate switches on iOS, need field testing.

# The agent mobile app

The agent-only app in `apps/mobile`: one Flutter project that builds the Android and the iOS app.
Agents sign in, go on duty on a campaign, take power-dialled calls, dial numbers themselves on the
soft phone, write up each call and see their own numbers. Supervisors and admins stay on the web
consoles. This doc covers what V1 does and leaves out, how it talks to the server, the rules that
keep a customer from reaching an absent phone, and how it is built and tested. Running it
locally: `apps/mobile/README.md`. As of 2026-11-01.

## Scope

**In V1**:

- sign-in (email and Google) and the invite flow;
- account choice and the campaign list;
- the pre-flight checks;
- the station: go on duty, take calls, notes, dispositions, DNC, breaks and leave;
- the soft phone (manual dialling, decision M2): the Phone tab, and in place on the station after
  "Switch to soft phone" (SP7). See "The soft phone" below;
- My performance and My calls (campaign calls and soft-phone calls);
- the Me tab: account switch, email preferences, the dark theme switch, sound and vibration,
  diagnostics, sign out.

**The tabs**: Station, Phone, Performance, My calls, Me. The Phone tab shows only where the soft
phone is available to the agent (decision M3); without it the bar has four tabs.

**The tab rule** (decision M4):

- On duty on a campaign and not on a break, the agent stays on the station: the other tabs are
  disabled (a long press says why), and every route, an invite link included, leads back to the
  station.
- A call takes the screen from wherever the agent is and hides the bar: a campaign call, or a
  soft-phone call on the line (dialing, ringing, on the call).
- A soft-phone call that ended and owes its outcome holds the agent on its screen too (the Phone
  tab, or the station for a campaign switched to the soft phone), but the bar stays: every other
  tab is disabled with "Save this call's outcome to open this", and a sign-out waits.
- An idle soft phone holds nothing. On a break, or after leaving the station, the agent moves
  freely.
- With a soft-phone session open, the Station tab opens the campaign list with "Your soft phone
  is open". A campaign switched to the soft phone is reached from the Phone tab too.

**Out of scope**, kept on the web console:

- supervising, the floor, coaching;
- campaign set-up and rosters;
- recordings and transcripts, which are supervisor-only reads (soft-phone calls included);
- the soft phone's supervisor side: the account's soft-phone calls and Settings → Soft phone;
- team and invite management.

DTMF is not built on either client ([`softphone.md`](softphone.md) §8).

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
- **A soft-phone session** is never `available`: it is always on the `soft_phone` break, so it can
  never be handed a customer. The app sends no `device_away` for it (the server would change
  nothing anyway, `decideDeviceAway`). Idle in the background, it stops its app pings and
  reconnects on return, like a break. A soft-phone call counts as a call: while it is live or owes
  its outcome, the app keeps its pings and reconnects at once in the background, the audio session
  and the on-duty service keep the process alive, and with the outcome owed the notification
  carries the save-by time ("Save the outcome by 11:28").
- **While on duty and in the foreground**, the screen is kept awake (`wakelock_plus`). On a
  soft-phone session only while a call is live or owes its outcome: nothing arrives at an idle
  soft phone unasked.

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
  either way; a console gets 30 s. On a campaign call the agent can see (decision M1), the
  terminate starts the bridge's 8 s deferred hangup at once: back in time, the call resumes;
  otherwise it ends. On a live soft-phone call (M1 as amended) it meets the bridge's rule for a
  manual leg: before the answer the call is hung up at once, after it the same 8 s decide. A
  campaign dial still ringing before the bind keeps its pre-bind grace, and a console with a live
  call of either kind is never closed.
- **`media=alaw8`**: audio travels as binary frames of raw G.711 A-law, 8 kHz mono, 160 bytes per
  20 ms, both ways. Text frames stay JSON control. With VoiceLink, whose wire audio is already
  A-law, the server relays the bytes untouched: no transcoding, no base64, no JSON per frame.
  Other carriers are transcoded. An unknown `client=` or `media=` is refused 1008 before the
  single-use token is spent (`parseStationUpgradeQuery`).
- **Reconnects** follow the console's ladder (0.5, 1, 2, 5, 10, 15 s; reset on pong, not on open).
  Every attempt mints a new token (a mint replaces the previous one, so the app never pre-mints a
  spare). An OS network change reconnects at once. Mid-call, the server ends the call if the
  socket is not back within `deferred_hangup_ms` (8 s); the station shows that deadline. A
  soft-phone call shows it only once answered: a ringing one is ended by the server at once.
- **Close codes**:
  - 4401 / 4408, or a drop: re-mint and retry.
  - 4404: the session is gone. The station closes on this phone at once (socket, on-duty service,
    audio, wake lock, listeners; held notes are sent) and the screen says why until the agent
    goes back to the campaigns. On a soft-phone session, Reconnect opens the soft phone again
    (the server rehydrates a session that is still live).
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

## The soft phone

The console's soft phone ([`softphone.md`](softphone.md)) on the phone: dial a typed number
outside pacing, optionally logged to a campaign, and save its outcome. It uses the console's
routes and the `manual_call` station frame; the app adds no server route. Agent-only (M2).

- **One session host.** The server allows one live session per agent per tenant, so the station
  core (`StationController`) hosts either kind as a `HostedSession`
  (`lib/core/station/hosted_session.dart`): a campaign station from the join, or a soft-phone
  session from `POST /softphone/sessions`. One socket, one audio engine, one on-duty service,
  whichever it is. The core publishes the shell's signals and the soft phone's host view through
  `stationHostProvider`, so the campaign `StationView` is unchanged, and implements
  `SoftphoneHostActions` (open, close, switch, cancel the switch, return, adopt and retire a
  call, ring mute, system hang-up). A soft-phone open whose URL carries no token mints one first.
- **The call domain.** `SoftphoneController` (`lib/core/softphone/`) is a port of the console's
  `useSoftphone`. It never touches the socket or the audio: it reads the host view and asks the
  host. It is built per workspace and never auto-disposed. The screens read only
  `softphone_view.dart` (`SoftphoneView`, `SoftphoneActions`), the same pattern as the station's
  seam. The console's rules are kept, each with a test:
  - one dial in flight, never retried; a timeout re-reads the bootstrap and says the call may
    have been placed;
  - redial fills the pad and focuses Call, it never dials;
  - Log to and Call from lock once a call is placed;
  - call fields are never sent before the field set has loaded, and autosave 700 ms after the
    last edit; unsent notes are kept on the phone under `manual:<id>`;
  - notes the agent cleared go with the outcome as `''`, notes never touched are left out;
  - the DNC and calling-hours overrides (SP1, SP2) need a note of 10–500 characters, and a
    second refusal of the other kind keeps the first note;
  - "Without one, it closes in m:ss" counts down to `outcome_due_at`, on the server's clock.
- **The frames are the authority.** The station core reduces `manual_call` frames
  (`newerCall`; the frame wins a tie) and adopts HTTP answers into the same copy. On a reconnect
  the soft phone re-reads the bootstrap, and a `call: null` there retires the copy held when it
  asked, by its version key (`id@updated_at`), so a newer frame survives. The router's hold and
  the audio never depend on the soft-phone controller.
- **Where the Phone tab shows (M3).** The bootstrap (`GET /softphone/bootstrap`) answered 200 and
  the flag is on, or there is a session or call to finish here; or this phone hosts a soft-phone
  session or a campaign switched to the soft phone. A 403 (no `agency.softphone.dial`) or no
  answer yet hides it: the app keeps no role matrix. The bootstrap is re-read on a workspace
  change, on return to the app at most every 5 min, after the hosted session closes, after a
  reconnect and after a `softphone_disabled` refusal.
- **Opening.** An explicit "Open the soft phone" on the Phone screen asks for the microphone and
  notifications first, in the foreground (Android 14 refuses a microphone foreground service
  started from the background), then opens. The on-duty service runs for the session's whole
  life, titled "Soft phone" ("Ready to dial", "Calling…", "On a call", "Outcome needed"), with
  Mute and Hang up while a call is on the line. "Close soft phone" leaves the session, never
  while its call is live or owes its outcome.
- **Auto-resume.** At the bootstrap's first read in a workspace, in the foreground: a soft-phone
  session in this account is opened again (the server rehydrates it even with the flag off), and
  a campaign session here on the soft phone with an unsettled call has its station started. In
  the background the resume waits for the return.
- **Finish mode.** With `softphone_enabled` off (the bootstrap says so, or a dial was refused
  `softphone_disabled`), typing, paste, redial and Call do nothing. The call, hang-up, the
  outcome, the notes and Close or Return still work: the server keeps the routes that finish work
  open. The Phone tab stays while there is something to finish.
- **Conflicts.** The Phone screen says why there is no soft phone and offers the way to one:
  - live on a campaign in this account: "Switch to soft phone", then that campaign's station on
    this phone, which shows the soft phone in place;
  - live on a campaign or with the soft phone open in another account: it names the account and
    offers the account switch when the agent has that account (no in-place cross-account switch);
  - the soft phone open in another account: "Close it and open the soft phone here", refused while
    its call is live or owes its outcome;
  - off, with a session stranded in another account: close it there; a supervisor can save an
    owed outcome.

  Joining a campaign with the soft phone open: the pre-flight's "Close the soft phone and join"
  reads the soft-phone bootstrap in the session's own account first and closes nothing while a
  call there is live or owes its outcome (`close_softphone.dart`, a port of the console's
  `closeSoftphoneSession`; the soft phone's own Close runs the same). `leave` refuses only a live
  call, so without this an owed outcome would lapse.
- **On the station (SP7).** "Switch to soft phone" is in the waiting and break views and in the
  break sheet, shown only while new calls may start. While reserved, on a call or in wrap-up it is
  queued: the pill reads "Switching after this call" and its ✕ cancels. On `break/soft_phone` the
  station renders the same `SoftphonePanel` in place (surface `station`), with Return to campaign
  in its header, disabled with the reason while a call is live or owes its outcome; End break and
  the break menu are suspended. The station's campaign is preselected as the tag once the
  bootstrap confirms it is taggable.
- **Audio.** A soft-phone call arms the microphone when placed and opens the uplink only from
  `bridged_at`. While it rings the engine plays ringback (M5). Mute while ringing is "Mute ring"
  (the ringback only, reset for each call); otherwise it is the microphone, and answering with the
  microphone muted is announced assertively. A campaign attempt always wins the audio. CallKit and
  the notification's Hang up end a soft-phone call at once; in the app hang-up is
  hold-to-confirm, with the SP3 warning while ringing.
- **My calls.** A "Soft-phone calls" segment shows where the Phone tab shows, or when a `limit=1`
  read finds any of the agent's soft-phone calls: keyset pages, number and status filters, rows
  with "Logged to <campaign>" or "Not logged". The detail shows the record, the outcome and who
  saved it, the call details labelled by the field set, the agent's override notes and the roster
  contact. `media` is never rendered. An unsettled row opens the Phone tab.
- **What differs from the console.** No keyboard shortcuts. The calling-hours prompt shows the
  window as the server states it and the next opening as time from now plus the phone's own clock
  (the app has no IANA time-zone database). Conflicts with another account are settled by
  switching account. The copy says the ringback "plays on your phone".

## Inside the app

```
lib/
  app/        router (gate-driven redirects), tabbed shell, theme tokens mirrored from packages/web-ui
  core/
    api/        ApiClient: bearer, scope headers, X-Client, request ids, typed errors
    auth/       the app gate: client-config → Firebase user → session → accounts → ready
    session/    account choice and local preferences
    station/    reducer (a port of the console's), server clock, socket, controller, view mapper;
                the hosted session (campaign or soft phone) and the soft phone's close
    softphone/  the soft phone's API client, controller, call rules and its UI seam
    audio/      orchestration of packages/agent_audio by phase
    lifecycle/  foreground rules (device_away), wake lock, local notifications
  features/   auth, join, accounts, campaigns, preflight, station, softphone (the Phone tab and
              the panel), performance, calls (with calls/softphone), settings
packages/
  agency_wire/  hand-written Dart types for the API and station frames
  agent_audio/  the native voice engine (Kotlin, Swift)
```

- **The station seam.** `lib/core/station/station_view.dart` is the only thing the station
  screens read (`StationView`, `StationActions`, `StationLauncher`); the core derives the view with
  memoisation so an unchanged slice keeps its identity and widgets `select` narrowly.
  `station_signals.dart` gives the router and the shell their facts (on duty, call active, on a
  break, campaign, the session's kind, an owed soft-phone outcome, a campaign on the soft phone,
  and where the session's screen is). The soft phone has its own seam,
  `lib/core/softphone/softphone_view.dart`.
- **The app gate** (`lib/core/auth/app_gate.dart`) decides every top-level screen. An expired
  sign-in (a 401 anywhere) signs out, but never during a call or wrap-up, or while a soft-phone
  call is live or owes its outcome: it waits for them to end, and leaves the station before
  signing out. A sign-out held for a call the app never saw
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
  station's (`stationRedirect`, the tab rule above). It sends the agent to the session's screen
  (`StationSignals.home`: the campaign's station, or `/phone` for a soft-phone session) while a
  call is active, a soft-phone outcome is owed, or a campaign station holds; the pre-flight
  exception applies to a campaign only. `/phone` goes home when the Phone tab is hidden. The
  redirect re-runs whenever the gate, the station signals or the soft phone's availability
  change, so it holds on every route and is a state, not a transition.
- **Per-workspace data** (the campaign list, email preferences, My calls, My performance, the soft
  phone's bootstrap, drafts and recent calls) is
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
  - One plugin instance serves the station, the soft phone and the pre-flight loopback.
  - Ringback for a soft-phone call is made in the engine (`AgentAudio.setRingback`, M5): the
    console's tone (400 + 450 Hz, 0.4 / 0.2 / 0.4 / 2.0 s, peak 0.12 of full scale), mixed into
    each 20 ms playout frame after the jitter buffer, so any early media is still heard. A Dart
    reference and shared golden vectors pin the Kotlin and Swift copies
    (`packages/agent_audio/README.md`, "Ringback").
- **Pre-flight**:
  - Checks the microphone permission, a loopback sound check ("Say hello"), the audio route, the network (round trip and measured upload), the battery and Android battery optimisation.
  - Only the microphone and the network block "Go on duty"; the rest is advice.
  - Grading lives in pure functions (`preflight_checks.dart`), separate from the measurements (`device_preflight_checks.dart`).
- **Wire types.** `agency_wire` is written by hand against `packages/contracts`. Drift is caught from both sides:
  - `packages/contracts/fixtures/agent/*.json` samples are type-checked against the TS contract (`agent-fixtures.test.ts`) and decoded by the Dart tests.
  - `tooling/contracts-literals.mjs` regenerates `literals.json`, the literal unions the app switches on (38, the soft phone's included). `--check` fails when it is stale, and so does `pnpm test` in contracts.
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

- **iOS has never been compiled.** There is no Xcode in the build environment, so the Swift engine and CallKit code was reviewed against the SDK headers only. That includes the Swift ringback (written to the shared vectors, never run) and CallKit for soft-phone calls.
- **No real device or carrier.** Nothing has run on a real phone, a real carrier call, or a real Firebase or Google sign-in. Without a carrier a soft-phone dial ends `failed` and unplaced, which tests only that path; ringing, the answer and A-law media need the VoiceLink sandbox.
- **A network change while a soft-phone call rings ends it** (no grace before the answer), and with SP3 the customer's phone may keep ringing. More likely on a phone than in a browser; accepted, not changed.
- **Untested behaviour:** echo cancellation on low-end Android phones on speaker, and Bluetooth rate switches on iOS, need field testing.

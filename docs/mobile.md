# The agent mobile app

The agent-only app in `apps/mobile`: one Flutter project that builds the Android and the iOS app.
Agents sign in, go on duty on a campaign, take power-dialled calls and customers who ring in, dial
numbers themselves on the soft phone, write up each call and see their own numbers. Supervisors and admins stay on the web
consoles. This doc covers what V1 does and leaves out, how it talks to the server, the rules that
keep a customer from reaching an absent phone, and how it is built and tested. Running it
locally: `apps/mobile/README.md`. As of 2026-11-10.

## Scope

**In V1**:

- sign-in (email and Google) and the invite flow;
- account choice and the campaign list;
- the pre-flight checks;
- the station: go on duty, take calls, notes, dispositions, DNC, breaks and leave;
- inbound calls on the station (customers who ring one of the account's numbers, put through to
  an agent on duty with the app on screen): the offer with its chime, the call and its outcome, as
  on the console (IQ46, IQ47). See "Inbound calls" below;
- Mode B on Android: an agent who opts in has the phone rung for an inbound caller while they are
  away from the app (IQ58–IQ74). See "Ringing while away (Mode B)" below; iOS is designed only;
- the soft phone (manual dialling, decision M2): the Phone tab, and in place on the station after
  "Switch to soft phone" (SP7). See "The soft phone" below;
- My performance and My calls (campaign calls and soft-phone calls);
- customer history: search one full number (the search icon on My calls) and see its contacts,
  DNC status, open items and timeline across the accounts the agent belongs to, with the console's
  number rule (country picker, helper text, preview, refusals). See [`customer-history.md`](customer-history.md) §5.
  The picker starts on the platform default (`GET /proxy/agency/customers/options`, +91 while it
  loads or when it cannot be read). The page has the console's content: a copy button, every
  console filter (the channel and "Connected calls only" on the page, campaign, days, outcome,
  outcome code and agent in a "Filters (N)" sheet), redial chains, the follow-up of an open
  override, and the console's empty-state rule. Two differences: no CSV export (the console's only,
  CH13), and the app never opens a call page (CH8). The empty box and "too short" refusals show
  when Search is pressed, the others as typed. Recent searches (last five) stay on the device
  until Clear or any route to the signed-out state (sign-out, a refused session, start-up with
  nobody signed in);
- Missed calls (inbound calls that reached nobody, assigned to the agent): a segment of My calls
  with the open count as a badge on the tab, Call back into the soft phone, Mark handled and
  Reopen. See "Missed calls" below;
- the Me tab: account switch, email preferences, the dark theme switch, sound and vibration,
  diagnostics, sign out.

**The tabs**: Station, Phone, Performance, My calls, Me. The Phone tab shows only where the soft
phone is available to the agent (decision M3); without it the bar has four tabs. Missed calls is
not a tab: it is a segment of My calls, whose tab carries its badge.

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
- **A short absence returns on its own (IQ50).** Back in the app with the app's own `device_away`
  pause applied (not queued behind a call) and begun less than `deviceAwayReturnGrace` (30 s,
  contracts `DEVICE_AWAY_RETURN_GRACE_MS`) before, by the server's `since` (the phone's clock as
  the fallback), the agent is returned with the ordinary `/available`, decided once the socket is
  open and no pause request is in flight. A longer absence, another break taken meanwhile, or a
  refused return keeps the away card and its tap. Meanwhile the server counts the paused agent as
  one who could take a caller (`inbound.md` §5.1), so callers queue for them. On every return from a
  `device_away` pause (and when a `phone_call` pause ends) the station publishes the pause's start
  (`away_return.dart`), and the Missed feature (`rang_while_away.dart`) asks once,
  `GET /inbound/missed/count?assignee=me&since=…`: "N customers rang while you were away" (or "…on
  your phone call"), politely announced, with "See missed calls" and Dismiss, until dismissed or
  opened, a call reaches the agent, or they leave the station. Nothing for 0 or a failed read.
- **A cellular call while available (IQ51)** pauses the agent with the reserved break `phone_call`
  ("Phone call"; the server's rules are `device_away`'s, `inbound.md` §6) for the length of the
  call, and returns them when it ends, only while they are still on that pause (a break taken
  meanwhile, or a supervisor's change, is kept). A pause the server queued behind a reservation is
  withdrawn when the cellular call ends; a failed pause is retried on the away delays, then the
  agent is told "We couldn’t pause you for your phone call. Take a break, or a customer may be put
  through while you’re on it." A call that ends while the app is away returns them only if they
  come back within 30 s. During a station call nothing changes (the audio interruption). Detection
  is `agent_audio`'s `PhoneCallChanged`, asked for only while it can matter, with no runtime
  permission: Android reads the audio mode (ringtone, in call, call screening, call redirect; the
  app's own `MODE_IN_COMMUNICATION` is not a phone call; `OnModeChangedListener` on API 31+, a
  1 s read below), iOS CallKit's `CXCallObserver` without the app's own calls
  (`packages/agent_audio/README.md`). Not run on a phone; the Swift has never been compiled.
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

**The one exception (Mode B).** An agent who opted in on this phone, on an account with ringing on,
leaves the app on `away_ring` ("Away · this phone rings for inbound calls" in the app; the console floor labels it "Away · rings for inbound") instead: still paused and offered nothing
on screen, but their phone is rung for an inbound caller. See "Ringing while away (Mode B)".

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

## One station per agent

An agent is live in one place at a time (decisions OS1–OS8): one live session across every
tenant, and its station on one device. This install is one device: it sends a `device_id` (32 hex
characters, made once and kept in the preferences store, `lib/core/station/station_device.dart`)
on the join, the soft-phone open and every station-token mint. The server keeps which device holds
the station and refuses the others `409 station_on_other_device` unless they ask to take it over.

- **Takes the station over** (`take_over: true`): "Go on duty" (and the pre-flight's leave-and-join
  remedies), "Use this phone instead" after 4409, "Use it on this phone", and any soft-phone open
  the agent asks for.
- **Never takes it over**: the reconnect ladder's mints, the soft-phone session this phone resumes
  on its own, and the campaign station on the soft phone it resumes on its own. A refused resume
  shows "open on another device" with "Use it on this phone"; a refused mint stops as 4409 does.
- **Live in another organisation** (`409 session_in_other_tenant`): the join is refused with the
  server's sentence, which names the workspace. The server ends that session by itself first when
  nothing is there (no station attached, nothing in flight, OS7); a working one is left alone.
- **A take-over is spent** by the one mint it arms, whatever that mint answers: a "Use this phone"
  whose mint fails does not carry into a later automatic reconnect.

## The station socket

`/proxy/agency/station/:sessionId?token=…&client=mobile&media=alaw8&caps=inbound`. `station_ws_url`
is a path relative to the API origin; the app resolves it against `API_ORIGIN`
(`Env.resolveStationUrl`). `caps=inbound` (see "Inbound calls") is sent on every connect, a re-minted
one included.

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
- **The phase follows the call**, not `agent_state` alone. The server sends no `agent_state` for
  `reserved` or `on_call` on the dial path, so a paced call or a wrap-up redial arrives as
  `reserved`, `bridged` and `released` frames. A live attempt decides the phase (bridged: on call,
  else ringing), then a call still owing its outcome or a wrap-up anchor (wrap-up), then
  `agent_state`, as the console's rail does (`StationState.effectiveState`). The screen, the
  shell's signals (`callActive`), the away rules (a call queues `device_away` and never closes the
  socket; a call that ends with nothing owed asks for the pause at once), the notification, the
  notes route and the soft phone's host view all read it.
- **Close codes**:
  - 4401 / 4408, or a drop: re-mint and retry.
  - 4404: the session is gone. The station closes on this phone at once (socket, on-duty service,
    audio, wake lock, listeners; held notes are sent) and the screen says why until the agent
    goes back to the campaigns. On a soft-phone session, Reconnect opens the soft phone again
    (the server rehydrates a session that is still live).
  - 4409: superseded by another device. The on-duty service and the audio stop at once, and the
    notification loses Mute / Hang up: the call moved, and nothing on this phone may end it (a
    notification hang-up carries no call id, so it is ignored when this phone holds no call).
    "Use this phone" starts them again and takes the session back (its mint carries
    `take_over`); going back to the campaigns forgets the station here.
  - A re-mint refused `409 station_on_other_device` (the agent moved the station to the console or
    another phone while this one's socket was down): handled exactly as 4409, never retried.
  - 1008: the server refused the upgrade (`invalid_client` / `invalid_media`): terminal, never
    retried. The station says to update the app, leaves the session (best effort; not while a
    soft-phone call owes its outcome, which would lapse) and closes here.
  - 1011: the server could not run the station: retried on the ladder, but three in a row with no
    `pong` between give up like a flapping socket (held while a call is live).
  - A give-up (silence, flapping, 1011) is the agent's to undo with Reconnect; returning to the app
    retries only a silence give-up.

## Wrap-up redial

On a campaign with `allow_wrapup_redial` (decisions WR1–WR13), the wrap-up view shows **Redial**
beside **Save outcome** while an outcome is owed: "N redials left", disabled at "No redials left"
(at most 2 per call). The `wrapup` frame's `redial_remaining` decides; the bootstrap's
`allow_wrapup_redial` is decoded but not used to gate it. Pressing it sends
`POST /proxy/agency/sessions/:id/redial` `{ attempt_id }`. The redial then runs on the station
socket like any call (`reserved` with `attempt.redial`, shown as "Redial 1 of 2", `bridged`,
`released`), and ends in a new wrap-up on the redial attempt, whether or not it connected. The
pad, Save and Redial are locked from the press. Notes typed in the last 2 s are saved to the call
first (bounded at 2 s), because the server copies the call's saved notes onto the redial. Once
the server answers that it placed the redial, the wrap-up's clock and its save-by notice are
hidden (the server stopped it). The lock lasts until the new call reaches the station, or 10 s,
after which the pad comes back with "The redial hasn't reached your station yet." A refusal
(six `redial_*` / `disposition_already_submitted` codes, with copy for each) unlocks them and the
agent can still save the outcome; a wrap-up frame that arrived meanwhile keeps its own redial
count. No usable answer (no network, a timeout, a 5xx) says the redial may still go through. The
notes draft follows the call onto the redial attempt, even when the redial's own wrap-up arrives
before the answer naming it, and text not yet on the server is saved to the redial.
Telemetry: `agency_redial_requested` / `agency_redial_refused`, as on the console;
`agency_redial_refused` is sent for every failure, with no `code` when none came back, so pressed
minus refused is not the number placed.

## My contacts (contact assignment)

Behind `agency_contact_assignment_enabled` (decisions CA1–CA15), which the app reads per
workspace from `GET /feature-flags` (`lib/core/flags/feature_flags.dart`; every flag reads off
until that answer arrives; a map that was read stays for the workspace, and a failed read is read
again on the next return to the app or a pull to refresh of the campaign list). **My contacts**
(`lib/features/contacts/`, route `/home/contacts/:campaignId`) is offered on the console's rule:
the flag on, and the join bootstrap saying the campaign assigns contacts (`assignment_mode` not
`pool`) or lets agents retry (`allow_agent_retry`) (`StationView.myContactsOffered`). So it opens
from the station's waiting screen and from the card of the campaign the agent is on duty on; off
duty there is no bootstrap, and no entry. It shows the agent's counts per bucket
(`GET /proxy/agency/my-contacts/summary`), **Retry not reached (N)**
(`POST /proxy/agency/my-contacts/retry`, offered only while the campaign allows it, nothing is due
now and N > 0; picking rows for **Retry selected** follows the same rule), and their contacts in
due order, filtered by bucket and by number (digits only), paged (`GET /proxy/agency/my-contacts`).
**Call** is offered while the agent is on duty on the campaign, the campaign is dialling (the
`campaign_state` frame; a paused campaign refuses `campaign_not_running`) and the agent is
available, on a contact they may call now (retry-eligible, due, or holding a retry-delay override),
and sends `POST /proxy/agency/my-contacts/:contactId/call`; the call then arrives on the station
like any other. A calling-hours note is asked for when the call, sent without one, is refused
`400 override_note_invalid`: the server's answer outside the window for a contact holding an
unspent calling-hours override (without one it answers `409 outside_calling_hours`, said as a
refusal). The same refusal with a note sent is said as an error, not asked again. While the agent
is on duty on that campaign the router keeps My contacts open (it is the station's own page) until
a call takes the screen.

On a `strict` or `preferred` campaign the waiting screen shows why nothing is coming when the
`queue` state says so ("No contacts are waiting for you. Your supervisor can assign more.",
outside calling hours, callbacks later, waiting for retry, with the next due time). The state
comes from the bootstrap, `ready` (an absent `queue` clears it) and the `queue` frame. The
`agency_wire` types are in `packages/agency_wire/lib/src/assignment.dart`; a disposition's
`override` decodes as `Disposition.overrideGrant`, and a bootstrap without `assignment_mode` reads
`pool`. Telemetry: `agency_my_contacts_viewed`, `agency_agent_retry_requested`,
`agency_my_contact_call_requested`, the same names and property sets as the console's
`EventCatalog`. The console sends `code: null` (placed, reopened, or a failure with no refusal
body); the app's telemetry layer sends no null properties, so there the property is absent, which
PostHog reads the same way.

## The soft phone

The console's soft phone ([`softphone.md`](softphone.md)) on the phone: dial a typed number
outside pacing, optionally logged to a campaign, and save its outcome. It uses the console's
routes and the `manual_call` station frame; the app adds no server route. Agent-only (M2).

- **One session host.** The server allows one live session per agent, across tenants (OS1), so the station
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
  - a refused outcome carried nothing, so the notes' save is armed again and text typed since the
    last save goes by the notes' own route (the status never sits at saving);
  - the DNC and calling-hours overrides (SP1, SP2) need a note of 10–500 characters, and a
    second refusal of the other kind keeps the first note;
  - "Without one, it closes in m:ss" counts down to `outcome_due_at`, on the server's clock.
- **The frames are the authority.** The station core reduces `manual_call` frames
  (`newerCall`; the frame wins a tie) and adopts HTTP answers into the same copy. On a reconnect
  the soft phone re-reads the bootstrap, and a `call: null` there retires the copy held when it
  asked, by its version key (`id@updated_at`), so a newer frame survives. The station core checks
  too: after a reconnect `ready` with an unsettled call held and no `manual_call` frame within 2 s
  (the server re-sends one only for a call still unsettled), it reads the bootstrap itself,
  retrying after 4, 8, 16, then every 30 s while the socket is open, and lets go of a
  call the server no longer holds. So the router's hold and the audio never depend on the
  soft-phone controller.
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
- **Auto-resume, only for this phone's own session.** The phone remembers, per workspace, the
  session it hosts (`hosted_here.dart`), and forgets it when the session ends or another device
  takes it over (4409). At the bootstrap's first read in a workspace, in the foreground, the
  session it remembers is opened again (the server rehydrates it even with the flag off), and a
  campaign session it remembers, on the soft phone with an unsettled call, has its station
  started. A resume put off in the background asks the server again on return rather than
  trusting the earlier answer. A session this phone did not host (the web console mid-call, or
  another phone) is never taken silently: the Phone screen says "Your soft phone is open on
  another device" and offers "Use it on this phone", which moves it and any call on it here, and
  "Close it" when nothing there is unfinished.
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
  hold-to-confirm. While the call rings the SP3 warning (which names no carrier) sits above it, and
  is the screen reader's confirm text, only when the call's `can_cancel_ringing` is not `true`, as
  on the console (`softphone.md` §1); on a carrier that cancels a ringing call, hanging up while it
  rings just cancels it. A system hang-up the server refused shows on
  the soft phone, and a call CallKit already ended on its side is reported to it again. CallKit
  names the call by the matched contact, else the number.
- **My calls.** A "Soft-phone calls" segment shows where the Phone tab shows, or when a `limit=1`
  read finds any of the agent's soft-phone calls: keyset pages, number and status filters, rows
  with "Logged to <campaign>" or "Not logged". The detail shows the record, the outcome and who
  saved it, the call details labelled by the field set, the agent's override notes and the roster
  contact. `media` is never rendered. An unsettled row opens the Phone tab.
- **What differs from the console.** No keyboard shortcuts. The calling-hours prompt shows the
  window as the server states it and the next opening as time from now plus the phone's own clock
  (the app has no IANA time-zone database). Conflicts with another account are settled by
  switching account. The copy says the ringback "plays on your phone".

## Missed calls

The console's Missed calls page ([`inbound.md`](inbound.md) §7, §8.4) in an agent's view (M2): the
inbound calls that reached nobody and were assigned to this agent. The routes are the console's
(`/proxy/agency/inbound/missed`, `…/:id/handled`, `…/:id/reopen`, `…/count`); the app adds none.
Code: `lib/features/missed/`.

- **Where it is.** A third segment of My calls ("Missed calls", or "Missed" beside two others),
  with the open count as a badge on the segment and on the My calls tab ("100+" past the server's
  cap, `InboundMissedCountResponse.badge`). Not a sixth tab: five already leave about 72 dp each
  on a 360 dp phone, and Material's bar holds three to five. On duty on a campaign the tab opens
  only the Missed list (IQ48; the other segments stay off duty only, M4), in a sheet over the
  station (`missed_on_duty.dart`) that changes nothing on it (no pause, no switch) and closes when
  another call reaches the agent. The station's waiting, campaign wrap-up and inbound outcome
  screens show "N customers to call back" (the agent's own open rows; hidden at 0, unknown or
  forbidden), a 48 dp row that opens the same sheet.
- **When it shows** (the console's `useMissedCallsAccess`, with the server's answer in place of a
  role check, as for the Phone tab): `GET /inbound/missed/count` answered 200 (the agent holds
  `agency.inbound.read`), and `agency_inbound_enabled` is on or the agent has rows (`has_rows`).
  A 403 (or a 404 from a server without the route) hides it; no answer yet, or only failed reads,
  hides it too, and a failed re-read keeps the last answer. With the flag off and rows there, the
  list shows under the console's notice (callers hear the closed message and are still listed). The
  shell and My calls read a seam (`missed_access.dart`, hidden by default) that `main.dart` plugs
  the count into.
- **Kept fresh mid-shift.** Agents keep the app open all shift, and rows change under it: a Call
  back that reaches the customer, or the customer ringing in and being put through, closes their
  rows as reached, and new rows are assigned. So:
  - the count is polled every 60 s while `agency_inbound_enabled` is on and the app is in the
    foreground (the console's poll; never in the background, and not after a 403);
  - the count is read when a workspace starts, on return to the app when the last answer is older
    than the poll (older than 5 min with inbound off; at once after a failed read), after a Mark
    handled or a Reopen, and on a pull to refresh;
  - the count is read again when a call settles on this phone: the station's signals
    (`callActive || outcomeOwed`) going from true to false, which covers a campaign call, an
    inbound call put through and a soft-phone call on either host (`missedCallsSettledProvider`);
  - the list and the count are read again when the Missed segment comes on screen (picked, or the
    My calls tab back in front: the shell's indexed stack turns its tickers back on) and the rows
    are a minute old or a call has settled since; the rows stay on screen until the new page lands.
  An answer from a previous workspace never touches this one's (a generation guards the read in
  flight).
- **The list.** "Mine" and "Team" (IQ49). Mine is the agent's rows: every page asks for
  `assignee=me` (the server forces it without `agency.supervise`, and without it would widen a
  supervisor's list to the whole account), and there is no Reassign; the count asks for
  `assignee=me` too (IQ57), so the badge counts what the list shows, a supervisor's included. Team
  is the account's open rows nobody owns (`assignee=unassigned`: callers who were not matched or
  withheld their number), with Claim as the only action (`POST /inbound/missed/:id/claim`, one at a
  time): a claimed row leaves Team, the badge is re-read and the claim announced; a refusal
  (someone else took it, handled, gone) is said on the row and its Claim switched off until the
  next read drops it; no answer leaves Claim on. Team has no badge. In Mine, "To follow up" / "Handled" and the reason
  filter (the console's dates are not offered), newest first, keyset pages of 50, the next page
  fetched ten rows before the end, pull to refresh. Rows are cards of varying height (the
  actions), not the fixed-height rows of the other lists. Each row: the matched contact's name
  (`match_name`, IQ54) when there is one, above the caller's number (the name is cut short, the
  number never), or "Number withheld"; a DNC badge, why it was missed in the console's
  words ("Out of hours", or the closed cause: "Inbound switched off", "Number not on a route",
  "Phone line not active"; "Hung up while waiting", "Nobody free to answer", "All lines busy",
  "Couldn't be answered"), when, the number rung and the route, the matched campaign and any
  callback the call booked (the number is never cut short: the number and the DNC badge, then the
  reason, wrap onto a second line when they do not fit, at any text size); on a handled row who handled it ("You", "Customer reached by …") and
  the reached note.
- **Call back on duty (IQ48).** On duty on a campaign that is not on the soft phone, Call back
  hands the number to the soft phone, goes to the station and switches the campaign to the soft
  phone (SP7's `switchToSoftphone`, unconfirmed as the station's own switch is): applied, the number
  lands on the pad; queued behind a call or wrap-up, it waits as `afterCall` (the 5-minute wait
  starts when the switch applies: "Switching to the soft phone after this call…"); refused, the
  reason is said and the number keeps waiting for a switch. It never dials. A DNC row's Call back
  says that a missed call isn't consent and that the agent will be asked why the call has to go
  ahead (IQ55): the soft phone's SP1 note and override, as for a typed number.
- **Call back** (shown where the soft phone may start a call: the Phone tab shows and the soft
  phone is not in finish mode; otherwise the console's note says to call another way and mark the
  call handled). It hands the number and the matched campaign to the soft phone
  (`SoftphoneActions.callBack`) and goes to the pad: the Phone tab, or the station for a campaign
  switched to the soft phone (SP7). Like redial it fills the pad, sets "Log to" to the matched
  campaign when the agent may log to it (else leaves it), and focuses Call; it never dials, so the
  DNC check and its note (SP1) and the calling hours apply as to a typed number; an open override
  prompt goes (it was for another number, and "Call anyway" redials that one), as it does on a
  redial. It waits while the soft phone cannot take it (not open here yet, its bootstrap not read,
  a call on screen, finish mode) and fills the pad when it can, and the agent is told why it
  waits: with the soft phone not open, that the number will be on the pad if the agent switches
  to the soft phone within 5 minutes; with a call on the soft phone (on the Phone tab or the
  station's), that the number goes on the pad once the call is finished; with the soft phone open
  here and its setup still being read, nothing (it lands in a moment). The feature reads where the
  number stands from the soft phone itself (`SoftphoneView.callBackWaiting`: `none`, `afterCall`,
  `onceOpen`, `setup`, `notKept`), never from its own reading of the screen. A dial already placed
  when Call back is pressed keeps its own answer: the number waits until that call is on screen
  and settles, and a refusal (or an override prompt) of that dial stays on the pad until a call
  settles or the agent dismisses it; Call back never erases it. A waiting number lapses after 5 minutes (time behind
  a call on screen does not count: the wait starts again when the call settles), on any session
  change but the first session to open after it (so it never fills a later session's pad or sets
  its "Log to"), when another device takes the session, and on a workspace change. With the soft
  phone open on another device or in another account nothing here can take it: the number is not
  kept and the agent is told to bring the soft phone to this phone and press Call back again. A
  withheld caller's Call back is disabled with the reason. The number never goes in a route.
- **Mark handled / Reopen.** One of each at a time, still one across a reload of the list (only
  the action that set the row's flag clears it). The row leaves the view it no longer matches
  (or takes the server's copy), the badge is re-read, and the result is announced. A refusal is
  said on the row: `inbound_missed_call_not_found` in the console's words, a code it has no words
  for in the server's sentence, no answer in the app's.
- **Voicemail.** `voicemail_url` is served by `GET /proxy/agency/inbound/missed/:id/voicemail`
  (`audio/wav`, bearer token and scope headers required, `Cache-Control: private, no-store`); the
  console fetches it into a blob URL. The app has no player that can send those headers (the
  `agent_audio` engine plays 8 kHz A-law station frames, not a 16 kHz WAV file), and adding a pub
  dependency for playback is left for later (iOS does not build yet). A row with a voicemail says
  "Left a voicemail · Listen on the web console". The wire row carries no voicemail length, so none is
  shown.
- **Telemetry.** The console sends no event of its own for the Missed list, so neither does the
  app. A call placed after Call back carries `entry: 'inbound_callback'` on
  `agency_softphone_call_placed`, which now has the console's `entry` (`typed`, `pasted`, `redial`,
  `inbound_callback`) and `surface` (`softphone_page`, `station`). No number is sent.

## Inbound calls

The console's inbound flow ([`inbound.md`](inbound.md) §6, "The console (built, WP-D)") on the
phone, with the app on screen: an agent on duty on a campaign is offered a caller who rang one of
the account's numbers, sees and hears them, talks, and saves the outcome. The server's side is
IQ46, the app's defaults IQ47 (both decided, `decisions.md` §4, "Inbound calls on the mobile app");
the server's paths for a phone are `inbound.md` §6 "Mobile stations". The foreground rule above
stands: a phone that leaves the app while `available` is paused and offered nothing on its station,
unless the agent opted in to having it rung ("Ringing while away (Mode B)" below). The calls that reach nobody are the
agent's Missed calls (above).

- **The gate.** The station socket declares `caps=inbound` on every upgrade
  (`StationSocket.capabilities`, `StationCapability.withQuery`). Only a station that declares it is
  sent `inbound_call` and `customer_waiting` frames and is searched for callers; an older build
  that does not is never offered one.
- **One row, replaced whole.** Every `inbound_call` frame carries the whole call; the station
  reducer keeps the newest copy from any source (`newerInboundCall` in
  `lib/core/inbound/inbound_call_rules.dart`, a port of the console's: a later offer wins, then
  settled over unsettled, then progress within one offer; the frame wins a tie). HTTP answers are
  adopted into the same copy. A frame for another session, or one that does not read, is ignored.
  A copy the station let go of (retired by the reconnect check, or dropped by a campaign
  `reserved`) is remembered, as the console's `staleKeys`: a frame of that snapshot is ignored,
  and an HTTP answer no further along (a late hang-up, `PATCH` or `GET` answer) is never adopted.
  A live campaign attempt is always the call on screen (`StationState.inboundOnScreen`): the
  phase, the screen and where notes, the outcome, Mark DNC and Hang up go read the same call.
- **The phase follows the call** (`StationState.effectiveState`), as for a campaign call: offered
  reads `reserved`, connected `on_call`, ended owing its outcome `wrapup`. The server sends
  `agent_state` around the call's frames (`reserved` just before the offer, `on_call` before the
  connected call, `wrapup` before the ended one, `available` before the settled one); the call
  still decides. Reserved with no call on the station (before the offer lands, or for the moment
  between an offer leaving and the agent being returned, or a campaign reconnect before its dial
  is restated) shows a neutral "A call is coming through · Connecting…" screen (not the campaign's
  ringing pop, no Hang up), said once politely by the live region; "Incoming call" is only for a
  held inbound offer, which is announced ("Incoming call from …") when it lands, though the phase did not change. Everything
  that reads the phase treats a live inbound call as a call: the shell's `callActive` (the call
  takes the screen, the bar hides), the away rules (leaving the app during an offer, the call or an owed outcome
  QUEUES `device_away`, never closes the socket, and the pause is cancelled on return; while the
  outcome is owed the notification carries its save-by time, `outcome_due_at`), the wake lock, the
  heartbeat's hold on a stalled socket, the mid-call reconnect countdown (8 s, for a connected call
  only: the server cancels an offer whose socket is gone at `connects_at`), and the on-duty
  notification ("Incoming call", "On a call", "Outcome needed"; Mute and Hang up once connected,
  never while only offered). A new offer clears what a campaign call left on screen; a campaign
  `reserved` drops an inbound copy still held.
- **Audio.** The microphone arms on the offer (CallKit `startCall` on iOS, named by the matched
  contact, else the number, else "Number withheld") and the uplink opens only at `bridged_at`.
  CallKit is told of an outgoing call, as for a campaign call; its own incoming-call screen is not
  used (IQ47: the offer is the station's, with the app on screen). The
  call's end reaches CallKit as `local` when this phone hung it up, else as ended by the other
  side, also when the copy is retired (never an earlier campaign call's release reason).
- **The chime** is the console's `inbound_ring` cue, made in the engine
  (`AgentAudio.playChime`, `packages/agent_audio/README.md` "Inbound chime"): mixed into playout,
  never sent to the caller, played once per offer (the call id and `offered_at`), from the frame
  handler right after the arm, so it sounds before the caller's audio binds at `connects_at`. A
  restatement after a reconnect is silent, a re-offer after a requeue rings again, and a call
  already connected (or a held copy already past its offer) never chimes. Me → Sounds off silences it (the screen and the haptic still
  say a call arrived).
- **The screens** (`lib/features/station/parts/inbound_views.dart`, reading only
  `StationView.inbound`): the offer (the caller's name, else number, else "Number withheld"; "Your
  customer" and why, or whose customer they usually are; Recording; the DNC badge and why they are
  still taken; the number they rang, the route, how long they waited, the matched campaign and the
  contact as the campaign pop shows it, prior attempts included; "Connecting…" in the band, and
  "Connecting you to the caller…" where Hang up is, which is not offered yet); on the call (talk
  timer from `bridged_at`, notes, Mute, Audio, Details, Mark DNC, hold-to-confirm Hang up); the
  outcome (the pad from the call's `disposition_catalog`, with where it comes from, the callback
  picker when the code needs a date, notes, Mark DNC, Save outcome, and "Without one, it closes in
  m:ss" in the band, counted to `outcome_due_at` on the server's clock). They reuse the campaign
  call's band, layout, notes field, pad, callback picker and hang-up bar.
- **Actions** go through the same `StationActions` the campaign call uses, routed to the inbound
  call while one is on the station (`lib/core/inbound/inbound_call_api.dart`: `GET`, `PATCH`,
  `hangup`, `disposition`, `dnc` under `/proxy/agency/inbound/calls/:id`, every refusal a typed
  `InboundRefusal`). Hang up only once connected (a CallKit or notification hang-up while offered is
  ignored and the call reported to CallKit again); a refused hang-up says so and keeps the call.
  Notes autosave 700 ms after the last keystroke (the soft phone's `CallAutosave`: a 403 or a call
  gone gives up, a 401 is retried after 4, 8, 16, then every 30 s through the token refresh, and
  a save that goes through resets it), are kept on the
  phone under `inbound:<id>` until the server has them, reach a field the agent has not typed in
  when the server comes to hold others (text restored from the phone after a restart, which no
  save has carried yet, is never replaced by the server's older copy), and go with the outcome:
  cleared notes as `''`, untouched ones left out. A refused outcome carried nothing, so text typed
  since the last save goes by the notes' own route again. Leaving the station, 4404 and signing
  out send unsent notes at once (bounded at 2 s), not only store them. An
  `inbound_disposition_invalid` refusal with `allowed_codes` rebuilds the pad; each refusal is
  said in the console's words. Mark DNC confirms the number and its scope (the matched campaign,
  else the account), and is not offered for a withheld number. An outcome that stops calling the
  number confirms first, naming the list the server writes: the matched campaign's, else the
  account's; for a withheld caller nothing is added, so it saves without asking.
- **Reconnect.** `ready` keeps the call (it does not carry it). The server restates a call it still
  holds for this session right after; when no `inbound_call` frame comes within 2 s the station
  asks `GET /inbound/calls/:id`, and on any other failure asks again after 4, 8, 16, then every
  30 s while the socket is open, until a frame or an answer settles it. That includes a 401 (the
  API client has forced one token refresh, and each retry refreshes again) and a 403: retiring on
  a guess could take a connected call or an owed outcome off the screen. An answer for this
  session is adopted; one for another session, or `inbound_call_not_found`, retires the copy held
  when it asked (a newer frame survives). An OFFER is not left waiting on that read: the server
  states `reserved` for as long as it holds an offer for the station (IQ46), so a `ready` that says
  `available`, `break` or `offline` retires a held offer at once, as a requeue (a `ready` that
  says `on_call` or `wrapup` leaves it to the read: the offer may have connected). As a backstop
  an offer still on offer 10 s past its `connects_at` on the server's clock, and at least 10 s
  after it reached the phone, with no frame having replaced it, is retired as a requeue, so the
  microphone, CallKit, the notification and the away rules stop holding a call that is not
  there. A connected call or an owed outcome is never retired without the server's answer.
- **Why a call left.** When a call leaves the station without the agent's outcome the station
  says why for 30 s, or until the next call of any kind (campaign or inbound): the caller hung up before they were connected; it
  went back to the queue (also when a reconnect finds an offer no longer this station's); the time
  to save the outcome ran out; a supervisor closed it.
- **"Your customer is waiting"** (`customer_waiting`): a banner first in every station layout's
  content, naming the caller (or their number). Cleared by the server's `cleared: true` for that
  caller, and as a backstop by an offer, a `ready` (re-sent while they wait) and the station
  leaving reserved / on a call / wrap-up.
- **Telemetry.** The console sends no inbound call events, so the app's follow the soft phone's
  names: `agency_inbound_call_offered` (once per chimed offer), `_connected`, `_ended` (with the
  call's audio counts, and `retired: true` when the station let go of the copy without the call's
  own end: a reconnect check, a campaign `reserved`, a newer offer), `agency_inbound_outcome_saved`
  and `_refused`. Each offer is tracked on its own (the call id and `offered_at`), so a re-offer
  after a requeue reports its own whole funnel. Ids, codes and flags only:
  never the number, a name or the notes.

## Ringing while away (Mode B)

Built 2026-11-12 for Android; iOS is designed only ("iOS: the design (Mode B)" below). An agent on
duty in a campaign session who opted in on this phone, on an account with
`agency_inbound_ring_enabled` on, is not just paused when they leave the app: the phone is rung like
a phone call for an inbound caller, and Answer puts the caller through to the app's station. It is
the one exception to the foreground rule above. The server's side is [`inbound.md`](inbound.md)
§6.1; the rulings are IQ58–IQ74 and N1–N5 ([`decisions.md`](decisions.md) §4, "Mode B"): Manas
decided IQ59, IQ62, IQ63, IQ65, IQ67 and IQ73 on 2026-11-13, and IQ74 for now (to revisit); the
others (IQ58, IQ60, IQ61, IQ64, IQ66, IQ68–IQ72, N1–N5) are still **default, pending Manas**. The
channel between Dart and native code is the next section. Nothing of it has run on a phone ("Not
verified yet").

- **The card** (Me, "Inbound calls"; `features/settings/ring_settings_card.dart`), shown where the
  device status says `account_allows_ring`. It opens with a headline: "Ready: this phone rings when
  you leave the app", or "Won't ring: …" with the first thing in the way (`ringBlockerOf`: the
  server's push credentials, the opt-in, the push token, the device's registration, then
  notifications, phone calling permission, the microphone). A toggle, "Ring this phone for inbound
  calls" (off by default; `PATCH /push-devices/:deviceId {ring_enabled}`), with "When you leave the
  app while available, inbound callers ring this phone like a normal call. Answer to take the call
  in the app. You won't get campaign calls while you're away."; the checklist "What this phone
  needs", six items each Ready or with a Fix button that opens the system screen (native
  `openSettings`): Notifications (allowed, and the ring channel not blocked), Full-screen calls
  (Android 14+'s `canUseFullScreenIntent`), Battery optimisation (off for the app; its Fix is
  agent_audio's prompt, `BatteryExemption`, with the list screen where an OEM removed it), Microphone,
  Phone calling permission (the app's self-managed Telecom account enabled) and Do Not Disturb
  (lets calls through, or the ring channel bypasses it); the miss rule ("If you miss two inbound
  calls, this phone stops ringing until you open the app again…"; a decline does not reset the
  count); and "Send a test ring" (below). When the server has no push credentials or the phone has
  no push token the toggle is off-limits: the headline says which (no push token ranks before
  "turned off", since turning it on would not help) and a note under the toggle says what follows,
  one sentence per fact ("Ask your administrator to set it up.", "Ringing can't be turned on
  here."). While its first load is on
  its way it shows "Loading this phone's ringing settings…"; a failed first load shows "Couldn't
  load this phone's ringing settings." with Try again. On an iPhone the status is read (never
  registered, `ringStatusOnlyProvider`) and, where the account rings phones, the card says "Ringing
  for inbound calls isn't available on this phone yet."
- **Registration** (`lib/core/ring/ring_registration.dart`): `PUT /push-devices/:deviceId` (the
  station device id, the FCM token, the app build) once the gate is ready, on a new token and on
  a return to the app, reading the checklist on every return (a return within 6 h of the last PUT,
  with the token, the app build and the opt-in unchanged, sends none and keeps its status);
  `DELETE` at sign-out, before Firebase
  signs out (bounded at 3 s), so the next person signed in on the phone is never rung for the last
  one's callers.
- **Leaving the app** asks `away_ring` instead of `device_away` when `ringAvailable` holds (no
  `ringBlockerOf`): the account allows it and the server can push, opted in, a token, a live device
  row, and the three essentials (notifications, phone calling permission, the microphone). A 409
  away-ring refusal asks `device_away` at once; a pause queued in wrap-up queues `away_ring`
  (IQ72). When ringing is on for this phone but `device_away` is asked (a blocker, or the 409), the
  paused notification says so: "You're paused, and this phone won't ring for inbound calls:
  notifications are off. Open the app to take calls again." (the refusal's reason, else the
  blocker), and the away card on return has the same line; not opted in, it is the plain "You're
  paused". Once `away_ring` applies with nothing on the line, the station socket is parked, the
  on-duty service stops (no microphone service while away) and native shows the ongoing "Away ·
  this phone rings for inbound calls" notification ("Open the app to take calls on screen again.",
  with "Back to calls" and "Stop ringing"), naming the absence it is for (its session and its start,
  the break's `since`); "You're paused" is not shown for it. The station's away card reads "Away ·
  this phone rings for inbound calls" (one label for it everywhere in the app; the supervisor
  floor's is the console's).
- **Coming back** (back from a parked `away_ring`) first asks native whether the launch was the
  notification's "Stop ringing" (below); if not, it reopens the socket and drops the notification.
  The server ends `away_ring` as `device_away` on the attach (no `ring_off`), sending `agent_state`
  break/`device_away` with the absence's start kept as `since`, then `ready` on the same break
  (the contract's `agent_state_after_away_ring_return` and `ready_after_away_ring_return`). So the
  return itself says nothing about whether the phone stopped ringing meanwhile, and IQ50's 30 s
  return reads the absence from its start: back within 30 s returns to calls, longer waits for the
  tap. The away card still says the phone was ringing for inbound calls (the app asked `away_ring`
  itself), and the Missed summary counts from the absence's start. A banner above the tab bar says
  "Your phone stopped ringing for inbound calls: …" (for `left`, "…: you left the session.") only
  on a concrete reason (`ringOffReasonOnReturn`): the `ring_off` native took for this absence
  (`takeRingOff`, matched to the session and the absence's start), else two misses heard while
  away, the device status read then (revoked, or a last push failure the server revokes on:
  `unregistered` or `invalid`; opted out, the flag off, no push), or an absence of 4 hours (the
  server's default maximum age). No reason, no banner.
- **The ring** (Android, `android/app/src/main/kotlin/com/magickagency/agent/ring/`). FCM without a
  Flutter plugin: `firebase-messaging` in the app module (Firebase BoM 34.19.0, the one
  `firebase_core` 4.15.2 builds against), and Firebase's default app built natively at process start
  from string resources Gradle writes from the build's dart-defines (`google_app_id`,
  `google_api_key`, `project_id`, `gcm_defaultSenderId`; [`apps/mobile/dev-setup.md`](../apps/mobile/dev-setup.md)),
  so a ring push wakes the app with no Flutter running. `RingMessagingService` hands each data push
  to `RingCoordinator`, which feeds the pure `RingStateMachine` (`Idle → Ringing → Answering →
  Answered`, or `→ Ended(reason)`; one ring at a time; a duplicate, late or expired ring, and a
  cancel for another call, change nothing) and carries out its effects. A ring on a phone on a
  cellular call (the audio mode is in call, call screening or call redirect, read with
  `agent_audio`'s own `callModeKindOf`; or, with no ring of ours ringing, Telecom does not permit
  an incoming call or the mode is ringtone, which our own ring can cause), or while the phone is
  answering or on a call from an earlier ring, is declined at once `busy_on_phone` (IQ70). The
  calling account is registered once per process on a ring's path (the checklist refreshes it). A
  new ring replaces one of ours still ringing (rung by its notification alone if Telecom refuses it
  meanwhile). Otherwise the phone rings for what the server left, on the server's clock as far as
  the phone knows it (`RingTiming`): with the server clock offset the station measured on its
  socket (`setServerClock`, handed over each time the station parks for `away_ring`, trusted for
  24 h), `ring_expires_at − (now + offset)` (never reading the server's present as before the
  push's send time), so a push delivered late rings no longer than the server offers the call and a
  phone clock running fast or slow changes nothing; without one, `ring_expires_at` less the push's
  FCM send time (both server-side clocks) less the delivery delay `now − sent` clamped to 0–3 s, so
  a phone clock running fast shortens a ring by 3 s at most and never drops it, one running slow
  takes nothing off, and a push delivered late rings a little long (an Answer after the expiry is
  refused); with neither, the phone's clock. The rule is continuous in the phone's clock (no
  boundary where it jumps). At most 20 s plus 2 s of slack, timed from arrival: a self-managed
  Telecom call (`MANAGE_OWN_CALLS`, the account "Magick Agency"), whose `onShowIncomingCallUi`
  posts a `CallStyle.forIncomingCall` notification, "Inbound call · Magick Agency" (never a name or
  a number, IQ61), on the high-importance channel `magick_agency_ring` with the ringtone looped
  (`FLAG_INSISTENT`), Answer and Decline, and a full-screen intent. Without Telecom (refused, or no
  UI asked for in time) the notification rings alone. Silenced (a volume key), it is cancelled and
  posted again on the soundless channel `magick_agency_ring_quiet`. No foreground service while it
  rings, so no `FOREGROUND_SERVICE_PHONE_CALL`. While our ring is live (`OwnRing.live` in
  `agent_audio`, set by the ring coordinator), `agent_audio` does not read the ringtone mode as a
  cellular call (only in call, call screening and call redirect are), so our own ring, a test ring
  included, is neither a `phone_call` pause nor an audio interruption.
- **The lock-screen ring** (`RingActivity`) is the full-screen intent, shown over the lock screen
  with the screen turned on. It is its own small native activity, not `MainActivity`, because it
  must not start Flutter: opening the app attaches the station, and the server takes an attach with
  `caps=inbound` during a ring as an answer (N5). Answer there starts `MainActivity` while the ring
  activity is still in front (an activity start from the foreground), then answers; Decline posts
  the decline. It closes itself when the ring ends. Its buttons are bold 20sp white on `#15803D`
  (Answer, 5.0:1) and `#DC2626` (Decline, 4.8:1), WCAG AA; TalkBack reads "Inbound call.
  Double-tap Answer." as it opens. `MainActivity` shows over the lock screen
  (`setShowWhenLocked`, `setTurnScreenOn`, `requestDismissKeyguard`) while a ring the agent
  answered is live, and then while Dart holds it (`holdOverLockScreen`: from the call reaching the
  station until its outcome is saved or it leaves), so the outcome screen does not fall behind a
  secure lock screen; a stale tap does not keep it there.
- **Answer** (the notification's Answer is a `PendingIntent.getActivity` to `MainActivity`, never a
  broadcast or a service): native posts `…/ring/answering` at once (`RingApi`: `HttpURLConnection` to
  the build's `API_ORIGIN`, the offer token only), marks the Telecom call active, replaces the
  ringing notification with "Connecting the call…" (with Hang up, on the soundless channel), saves
  the answer (`pendingAnswer`, in app-private preferences) and tells Dart (`ringAnswered`); the
  grace timer is the server's 15 s plus a 3 s margin. An answer from a headset or a car (Telecom's
  `onAnswer`) does the same and tries to bring the app up; only then is "Connecting the call…" an
  ongoing CallStyle with a full-screen intent, which covers the rest (a field-test item).
- **Cold start on Answer.** Flutter starts from `MainActivity`; once the gate is ready the coordinator
  reads `pendingAnswer` (cleared on read; dropped once the grace has lapsed) and accepts
  (`POST …/ring/accept` with the station device id). `StationController.resumeForRing` opens the
  station on the accept's URL (a parked station reopened, or one opened from the accept alone,
  `HostedSession.ring`), adopts the inbound frame and starts the on-duty service from the
  foreground; the server binds, the app tells native (`reportBound`) and the call notification gives
  way to the on-duty one. From there it is the "Inbound calls" flow above. From the answer until the
  accept answers, the accept's URL is the station's only attach: an app brought to the front by the
  answer does not reopen its parked socket on a mint of its own (that attach would answer the ring
  first, N5): while the accept is in flight the station's `_onShow` does not reconnect and a
  reconnect never mints for itself. A return already asking native whether its launch was "Stop
  ringing" when the answer arrives (the lock screen's Answer on a warm parked app brings it to the
  front before `RingCoordinator.answer` reaches Dart) ends without reconnecting and takes the "Stop
  ringing" as moot (no `device_away`), and "Stop ringing"'s `device_away` applying during an accept
  does not reopen the socket either: the accept's URL does, or, if the accept fails, the keep-alive
  once the hold is released. A socket already open when the accept answers is kept. A
  failure that says nothing about the call is retried once after 1 s; then "This call
  stopped ringing or someone else took it." and `reportEnded(accept_failed)`. `already_accepted` for
  a call the station holds (or receives within 5 s) is this phone's own attach having won, not a
  failure. Answers are deduped by call id; a second answer held before the gate is ready reports
  the one it replaces ended (`accept_failed`).
- **Decline** (the notification's Decline, the lock-screen Decline, or Telecom's reject) posts
  `…/ring/decline {reason: declined}` natively, at once, inside an 8 s budget; the notification's
  receiver finishes by 9 s whatever happens (and a request that throws still finishes it), so it
  never holds past Android's limit; not a miss. A ring route answered 429 is sent once more, after
  the server's `Retry-After` when it fits (inside the decline's budget; at most 5 s for
  `…/ring/answering`), else not. Hang up on the "Connecting the call…" notification
  (or a headset's or car's) declines too, which the server accepts only until Dart's accept (N4);
  for a call Dart has answered, its `ringEnded` `declined` makes the station hang the call up once
  it connects, and an accept refused after that hang-up is not reported as a failure.
- **A missed ring** (it rang out, or `ring_cancel` said `expired`) posts "Missed inbound call"
  ("You didn't answer an inbound call. It went back to the queue."; no name, no number): Dart asks
  native for it (`showMissedRing`) on `ringEnded` `expired` or `accept_lapsed` for a call it did not
  take, and native posts it itself when no Dart handler heard the `ringEnded`. Two misses and the
  server ends `away_ring` (IQ62).
- **`ring_cancel`** stops the ring with the server's reason (an answered ring keeps going if the
  reason is `answered`, the server having bound it first); **`ring_off`** for the absence the
  phone shows drops the away notification, ends a ring still ringing, posts "Your phone stopped
  ringing for inbound calls" with the reason ("You missed two inbound calls. Open the app to turn it
  back on.", "It stops after 4 hours away.", "Your station was opened on another device." for
  `taken_over`, "You left the session." for `left`, the agent's own Leave or the idle session's
  end, and so on; nothing for `opted_out`) and keeps it for
  Dart's return (`takeRingOff`). A `ring_off` delivered late is dropped (`RingStateMachine
  .acceptsRingOff`): another session's, one whose `away_since` starts more than 2 s before the
  shown absence, or one arriving once the agent is back (the notification taken down). Without
  `away_since` (an older server) the push's send time decides: sent before the shown absence began
  (less 2 s), dropped. A phone that knows of no absence takes it, as before. Native handles both
  pushes; Dart hears only the `ringEnded` that follows, and reads the `ring_off` on return.
- **"Stop ringing"** on the away notification is for this absence only (the permanent switch is
  the Me card's toggle). It opens the app with an extra; native declines a ring ringing at the tap,
  and one arriving in the next ring window (an app attaching during a ring would answer it, N5),
  keeping that window across a process start, and keeps the tap for Dart (`peekStopRinging`), which
  clears it (`clearStopRinging`) only once `device_away` applied; native drops a tap older than one
  ring window plus the accept grace (35 s) unread, so it never pauses a later absence. The
  returning station keeps its socket parked and asks `device_away` over HTTP (the server's switch
  from `away_ring`); while a ring is in flight the answer may say `reserved` (the pause queued
  behind the ring's offer) or still `away_ring`, and it is asked again each second, up to 10 s.
  Coming back again meanwhile (the agent left during the wait) does not reopen the socket. Once it
  applied: the socket reopens with `caps=inbound` as usual, the banner "Ringing stopped. You're
  paused.", no IQ50 return, and the app's task goes back (`moveTaskToBack`). Not applied by then
  (still `reserved` or `away_ring`, or a failure not worth retrying): the socket reopens **without**
  `caps=inbound` (`StationSocket.declareInbound`), which ends an un-answered ring rather than
  answering it (N5 needs the capability), and every connect stays that way until a frame says the
  agent is on a pause other than `away_ring`, or available; then the station attaches afresh with
  `caps=inbound`, and, paused, the banner and the move to the back follow. No such frame within
  another 10 s: "Couldn't stop ringing. Open your station to pause.", and the app stays in front.
  Hidden again in that absence, the app asks `device_away`, not `away_ring`, until the agent is
  back in the pool, and the paused notification reads "Ringing stopped. You're paused. Open the app
  to take calls again." On a cold start (no station in memory) the answer coordinator does the same
  for the session the absence was in, once the gate is ready: applied, the banner, the move to the
  back and the tap cleared; not, "Couldn't stop ringing. Open your station to pause.", the app in
  front, and the tap kept for the next start inside its 35 s.
- **The test ring.** "Send a test ring" posts `POST /push-devices/:deviceId/test-ring` (202; one per
  10 s, "You just sent one. Wait a few seconds, then try again."); the server sends a `test_ring`
  push and the phone rings locally through Telecom ("Test ring · Magick Agency", "This is how an
  inbound call rings while you're away."), with no call and no server round trip behind it; Answer
  or Decline just dismisses it. Native tells Dart once the ringing notification is up
  (`testRingReceived {shown: true}`): "Your phone rang. Ringing works on this phone."; a push that
  arrived but whose notification could not be posted (or that ended before it was) says "The test
  ring reached this phone, but it couldn't show the call. Check notifications." Nothing within 30
  s: "No test ring arrived. Check the list above, then try again." A phone on a cellular call drops
  a test ring.
- **Telemetry** (ids and codes only): `agency_inbound_ring_received`, `_answered` (`cold_start`),
  `_declined`, `_expired` (with `accept_failed` and the refusal code), `agency_ring_optin_changed`.
- **Tests:** `test/core/ring/` (the rules, registration, the answer coordinator, the channel's
  native → Dart side, over a fake channel), `test/core/station/station_away_ring_test.dart` (the
  return driven by the contract's frames, "Stop ringing", the lock-screen hold), the card and the
  banner widgets; Android's `src/test/kotlin/.../ring/` (the state machine, the push parser, the
  request builders, the copy and the lock-screen ring's contrast; JVM, run in CI as
  `./gradlew :app:testDevDebugUnitTest`).

## The ring channel (Mode B)

**The contract the Android native code and Flutter are built against** (2026-11-12, Mode B,
decisions IQ58–IQ74; the wire types are `agency_wire`'s `push_devices.dart` and the ring fields of
`InboundCall`). Built on Android (both sides, "Ringing while away (Mode B)" above); iOS opens
nothing on it yet. Change it only deliberately, on both sides at once, and update this section in
the same commit. Changed 2026-11-13 (the review fixes): `showAwayNotification` names its absence,
`testRingReceived` says whether the call was shown, and `takeRingOff`, `takeStopRinging`,
`moveTaskToBack` and `holdOverLockScreen` were added; `stopRingingTapped` was removed (Dart takes
the tap instead). Changed again 2026-11-13: `takeStopRinging` became `peekStopRinging` (not
cleared on read) with `clearStopRinging`, and `setServerClock` was added. Changed 2026-11-13
(cleanup): `peekStopRinging` answers `{session_id}` only; its `since` (the absence's start) was
never read by Dart, so native no longer keeps it with the tap. A tap is dropped by its own age (the
tap time native keeps), as before.

One `MethodChannel` named **`magick_agency/ring`**, standard codec, used in both directions. Every
argument and result is a map with string keys (or `null`, a string, a bool); ids and tokens are
strings exactly as the server sent them; instants are ISO 8601 in UTC. The offer token is never
logged on either side.

**Dart → native** (`invokeMethod`):

| Method | Arguments | Result |
|---|---|---|
| `getToken` | none | `String?`: the FCM registration token; `null` when push is unavailable (no Firebase defines, no Play services) |
| `pendingAnswer` | none | `{call_id, offer_token, session_id}` or `null`: the ring the agent answered while Flutter was not running (a cold start from the full-screen intent). **Cleared on read**: a second call answers `null` |
| `checklist` | none | `{notifications, full_screen, battery_exempt, microphone, phone_account, dnd_allows_calls}`, each a `bool`: whether that permission or setting lets the phone ring |
| `openSettings` | `{item}`: one of the `checklist` keys | `null`: opens the system screen that fixes it |
| `reportBound` | `{call_id}` | `null`: the station has bound the call's audio; native marks the Telecom connection active and stops the grace |
| `reportEnded` | `{call_id, reason}`: `ended` (the call ended after it bound), `accept_failed` (accept or the attach failed inside the grace, after one retry), `cancelled` (the server says the ring is over, or another agent took the caller) | `null`: native disconnects the Telecom connection and drops the call notification |
| `showAwayNotification` | `{on, since?, session_id?}`: `since` the absence's start (the break's `since`), both optional | `null`: shows or removes the ongoing "Away · this phone rings for inbound calls" notification (actions "Back to calls", "Stop ringing"). On: native keeps the absence (across a process start) to drop a late `ring_off` for an earlier one, and drops a `ring_off` or "Stop ringing" never taken |
| `showMissedRing` | none | `null`: posts the local "Missed inbound call" notification (no name, no number) |
| `takeRingOff` | none | `{session_id, away_since, reason}` (each may be `null`) or `null`: the `ring_off` native took for the absence it showed. **Cleared on read** |
| `peekStopRinging` | none | `{session_id}` (`session_id` may be `null`) or `null`: the away notification's "Stop ringing" Dart has not cleared, with the session of the absence it was tapped in. **Not cleared on read**: Dart clears it once `device_away` applied, so a process that dies first reads it again. Native drops one tapped more than 35 s ago (one ring window plus the accept grace), or when a new absence shows, and answers `null` for it |
| `clearStopRinging` | none | `null`: the "Stop ringing" `peekStopRinging` read is done with (`device_away` applied, or nothing to pause) |
| `setServerClock` | `{offset_ms, measured_at}`: `offset_ms` an int, how far the server's clock reads ahead of the phone's (negative: behind); `measured_at` when the station measured it (the phone's clock, ISO 8601 UTC) | `null`: native keeps it (across a process start) and times a ring on the server's clock with it while it is no more than 24 h old |
| `moveTaskToBack` | none | `bool`: the app's task went to the back |
| `holdOverLockScreen` | `{on}`: `bool` | `null`: while on, `MainActivity` stays over the lock screen after the ring's Answered state ends (a call answered from a ring, until its outcome is saved or it leaves) |

**Native → Dart** (native calls `invokeMethod` on the same channel; Dart's handler answers `null`,
or a `PlatformException` `no_listener` when nothing in Dart listens yet, which native reads as not
taken):

| Method | Arguments | When |
|---|---|---|
| `token` | `{token}` | FCM issued a new token (`onNewToken`); Dart registers it (`PUT /push-devices/:deviceId`). A token native already holds is not sent again (`onNewToken`/`onRegistered` with the same token send nothing) |
| `ringAnswered` | `{call_id, offer_token, session_id}` | The agent answered with Flutter running; native has already posted `…/ring/answering`. Dart accepts (`…/ring/accept`) and attaches the station |
| `ringEnded` | `{call_id, reason}`: an `InboundRingResult` wire value (`declined`, `busy_on_phone`, `expired`, `accept_lapsed`, `cancelled`, or a `ring_cancel` push's reason) | A ring ended on the phone without being bound |
| `testRingReceived` | `{shown}`: `bool` (absent reads `true`) | A `test_ring` push rang locally: `shown` once its notification was posted, `false` when it could not be (or the ring ended first) |

A push reaches native only (`RingMessagingService`, payload `AgencyRingPush`); Dart never handles a
push itself. Native posts `…/ring/answering` and `…/ring/decline` (the offer token only, IQ71) at
the tap without starting Flutter; `…/ring/accept` (Firebase Bearer and the station device id) is
always Dart's.

**Native's side, as built** (`android/app/src/main/kotlin/com/magickagency/agent/ring/`; WP3).
`RingChannel` is registered on `MainActivity`'s Flutter engine (it holds the activity weakly, for
`moveTaskToBack`). Where the build goes beyond the tables above:

- **`ringEnded` reasons** are also `accept_lapsed` (Answer was tapped but `reportBound` did not come
  within the grace: the server's 15 s plus a 3 s margin) and `cancelled` (a newer ring replaced this
  one, or a `ring_off` arrived while it rang). A test ring never sends `ringEnded`.
- **No `ring_off` event.** Native handles the `ring_off` push itself (drops the away notification,
  ends a ringing ring, posts why) when it is for the absence shown, and keeps it for `takeRingOff`.
- **Duplicates and order.** The state machine drops a ring for a call already ringing, one that
  ended here (the last calls are remembered, so a ring that arrives after its cancel is dropped), one
  past its expiry, a cancel for another call, and a `ring_off` for another absence. Answers reach
  Dart twice by design (`ringAnswered`, and `pendingAnswer` on a cold start); Dart dedupes them by
  call id.
- **What Dart has not heard is kept.** Each native → Dart call reports whether Dart's handler took
  it: an answer stays in `pendingAnswer` (app-private preferences, across a process start; cleared on
  read, on bind and on any end, and dropped once the grace has lapsed), and an unheard `expired`
  posts the missed notification natively. An accepted `ring_off` waits in the store for Dart to
  take it; a "Stop ringing" tap waits for Dart to clear it, for 35 s at most.
- **"Stop ringing"** (`MainActivity`, before Flutter hears of the launch) declines a ring ringing
  then, and any ring arriving in the next ring window (`RingWire.STOP_RINGING_HOLD_MS`), as
  `declined` (not a miss). The tap and the window's end go to the store in one `commit` (the
  launch may be a cold start in a new process, and a process restarted inside the window must
  still decline); a restored window is kept only while it has at most one ring window left (a
  phone clock set back never holds rings off for longer). The tap is dropped unread once older
  than `RingWire.STOP_RINGING_KEEP_MS` (35 s); Dart's clear is an `apply` (a lost one only leaves
  a tap that lapses).
- **The ring's time left** (`RingTiming.remainingMs`) reads the offset from `setServerClock`
  (`ServerClockOffset`, fresh for `RingWire.SERVER_CLOCK_MAX_AGE_MS`, 24 h; stored with `apply`,
  as Dart says it again at every park), else the push's send time less at most
  `RingWire.DELIVERY_CAP_MS` (3 s) of delivery, as "The ring" above says.
- **`reportBound` during a ring** (the agent opened the app by its icon and the attach answered it,
  N5) marks the call answered and active without an answer post.
- **The full-screen intent opens `RingActivity`**, not `MainActivity` with an extra, so the lock
  screen never starts Flutter (above).

**Dart's side** (`lib/core/ring/`, the station controller; WP4):

- **Registration** (`ring_registration.dart`): `PUT /push-devices/:deviceId` (the station device
  id) once the gate is ready, on `token` and on a return to the app, reading `checklist` on every
  return (leaving the app reads it synchronously, so it must be current). The PUT is skipped on a
  return within 6 h of the last one when the token, the app build and the opt-in are unchanged
  (`registerFreshFor`); another agent, sign-out, or a status saying the server holds no live
  registration sends it again. The station's status read on a return from `away_ring`
  (`readStatus`) reuses the status the return's own register asked for, in flight or answered,
  and reads it only when none was asked. `getToken`, `checklist` and the device id are read in
  parallel. Opt-in is `PATCH` (the Me card only); sign-out sends `DELETE` through the gate's
  `pushDeviceTeardownProvider`, before Firebase signs out. Android only (`ringPlatformProvider`); iOS
  registers nothing (IQ64) and reads the status for the card's note.
- **Leaving the app** asks `away_ring` when `ringAvailable` (no `ringBlockerOf`), else
  `device_away`; a 409 away-ring refusal asks `device_away` at once; either way, with ringing on
  for this phone, the paused notification and the away card say why it won't ring. A pause queued
  in wrap-up queues `away_ring`. Once `away_ring` applies with nothing on the line, the station
  socket is parked, the on-duty service stops and `showAwayNotification(true, since, session_id)`;
  the station's own "You're paused" notification is not shown for it.
- **Coming back** from a parked `away_ring` asks `peekStopRinging` first ("Stop ringing", above),
  else reopens the socket (`showAwayNotification(false)`); a tap for another session is cleared.
  A ring answered meanwhile (`holdForRingAnswer`) wins: the return and "Stop ringing" leave the
  parked socket to the accept's URL (`resumeForRing`).
  "Stop ringing" clears the tap once `device_away` applied (or once the station's frames say the
  agent is paused, after an attach without `caps=inbound`). Parking for `away_ring` hands native
  the server clock offset measured on the socket (`setServerClock`), when a pong has measured it. IQ50's 30 s return waits for the
  reopened socket's `ready`, and reads the absence from the return's `since`. The ring-off banner
  needs a concrete reason (`ringOffReasonOnReturn`): `takeRingOff` for this absence
  (`ringOffEndsAbsence`), two `ringEnded` misses while away, the device status read then, or 4 h
  away.
- **Answering** (`ring_answer_coordinator.dart`): `ringAnswered`, or `pendingAnswer` once the gate
  is ready after a cold start, deduped by call id; `…/ring/accept`, one retry on a failure that
  says nothing about the call, then "This call stopped ringing or someone else took it." and
  `reportEnded(accept_failed)`. `StationController.resumeForRing` reopens a parked station on the
  accept's URL (no second mint), or opens one from the accept alone on a cold start
  (`HostedSession.ring`), which a rehydrating join (`take_over: false`) fills in once the call has
  left the station. `reportBound` when the push offer connects, `reportEnded(ended)` when it ends,
  `cancelled` when it leaves before binding; `holdOverLockScreen(true)` while it is on the station,
  `false` once it leaves (its outcome saved). A push offer does not chime, and the offer backstop
  keeps it until 10 s past `accepted_at` + the accept grace (`inboundOfferStaleAt`). On a cold start
  with no pending answer, the coordinator reads a "Stop ringing" (`peekStopRinging`) and pauses that
  session (`StationController.stopRingingWithoutStation`, which clears it once `device_away`
  applied); a tap with no session is cleared.
- `ringEnded` `expired` or `accept_lapsed` posts `showMissedRing`, except for a call the agent
  answered.

## iOS: the design (Mode B)

Not built (IQ64): the app has never compiled for iOS, and Swift that has never been compiled would
be the first thing to break it. The server already has the APNs VoIP sender (`PUSH_APNS_*`,
[`seams.md`](seams.md) §3.6) and the contract carries `platform: 'ios'` and `voip_token`; the app
registers nothing on iOS (`ringPlatformProvider`) and the card says ringing is not available on the
phone. When iOS compiles, the design is:

- **PushKit** `.voIP` registration; the VoIP token goes in `PUT /push-devices/:deviceId`
  (`platform: 'ios'`, `voip_token`).
- **`reportNewIncomingCall` inside the push handler, every time.** iOS ends an app that receives a
  VoIP push without reporting a call to CallKit, so even a ring whose offer is already gone is
  reported, then ended at once (`.answeredElsewhere`). The server sends iOS `ring` and `test_ring`
  only.
- **CallKit incoming call.** `CallKitController` (in `agent_audio`, today the outgoing-call side of
  campaign and soft-phone calls) gains the incoming answer and end actions, carried over the same
  `magick_agency/ring` channel: Answer posts `…/ring/answering` and hands the call to Dart for
  `…/ring/accept` and the station, as on Android; End before accept posts the decline.
- **Capabilities:** the `voip` background mode beside today's `audio`, and the `aps-environment`
  entitlement. `PUSH_APNS_ENV` on the server must match the build: `sandbox` for a debug build's
  tokens, `production` for TestFlight and the App Store (a mismatch is refused `BadDeviceToken` and
  revokes the device).
- **No `ring_cancel` or `ring_off` over VoIP** (every VoIP push must be a call): the APNs sender
  answers them `ok` unsent. The app checks the call instead (`GET /inbound/calls/:id`) when CallKit
  answers or the app opens, and re-reads the device status on every open.
- **Blocked on** the first iOS compile, an Apple developer account and an APNs auth key.

## Inside the app

```
lib/
  app/        router (gate-driven redirects), tabbed shell, theme tokens mirrored from packages/web-ui
  core/
    api/        ApiClient: bearer, scope headers, X-Client, request ids, typed errors
    auth/       the app gate: client-config → Firebase user → session → accounts → ready
    session/    account choice and local preferences
    station/    reducer (a port of the console's), server clock, socket, controller, view mapper;
                the hosted session (campaign or soft phone) and the soft phone's close; the
                inbound call held beside a campaign call; CallAutosave (notes of a soft-phone or
                inbound call)
    softphone/  the soft phone's API client, controller, call rules and its UI seam
    inbound/    the inbound call's API client (typed refusals), its rules (newerInboundCall) and copy
    audio/      orchestration of packages/agent_audio by phase
    lifecycle/  foreground rules (device_away), wake lock, local notifications
  features/   auth, join, accounts, campaigns, preflight, station, softphone (the Phone tab and
              the panel), performance, calls (with calls/softphone), missed (My calls' Missed
              segment), settings
packages/
  agency_wire/  hand-written Dart types for the API and station frames
  agent_audio/  the native voice engine (Kotlin, Swift), the soft phone's ringback, the inbound chime
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
  empty field whose next keystroke would wipe it. Before a wrap-up redial the pending save is
  sent and waited for (2 s bound).
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
- **Telemetry** (`lib/core/telemetry/`) goes to PostHog when the build has `POSTHOG_KEY`, so a
  tester's failure can be read without their logs. Nothing leaves without a key.
  - Every warning and error the log keeps is sent, masked the same way: one logged with an
    exception as a PostHog exception (its real type, its stack, its text masked), the rest as
    `agency_app_warning` / `agency_app_error` with the line's tag, message and fields. Each message
    is capped at 5 a minute and all of them at 60, and the next line admitted says how many were
    dropped. Info and debug lines stay on the phone.
  - Call events, named and shaped as the console's where it has them, so one dashboard reads both:
    `agency_attempt_bridged` and `agency_attempt_released` for campaign calls,
    `agency_softphone_call_placed` / `_refused` (as the console's), `_bridged`, `_ended` and
    `agency_softphone_dial_failed` for the soft phone. Each call's end carries what the phone saw of
    its audio: A-law frames received, JSON `pcm16` frames received (on the app's `alaw8` socket,
    the sign of a server that ignored the format: the caller is heard as noise), microphone frames
    sent and refused by a closed socket.
  - Who: the user's server id; the tenant and account ids and names and PostHog groups, as the
    console tags them; `product: agency`, `client: mobile`, `environment` (the flavour) and
    `api_host` on every event. Never a person's name, email or a phone number. Sign-out starts a
    new anonymous identity.
  - Native exceptions (the Kotlin and Swift engine) are captured by the SDK. Its Dart error hooks
    stay off: `main.dart`'s handlers log the error and the log sends it masked. No session replay,
    surveys or feature flags. The SDK starts from Dart (`AUTO_INIT` off in the manifest and
    `Info.plist`) and never holds the launch screen.
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
  - The inbound chime is made the same way (`AgentAudio.playChime`, the console's `inbound_ring`
    cue), once per offer ("Inbound calls" above; `packages/agent_audio/README.md`, "Inbound
    chime").
- **Pre-flight**:
  - Checks the microphone permission, a loopback sound check ("Say hello"), the audio route, the network (round trip and measured upload), the battery and Android battery optimisation.
  - Only the microphone and the network block "Go on duty"; the rest is advice.
  - Grading lives in pure functions (`preflight_checks.dart`), separate from the measurements (`device_preflight_checks.dart`).
- **Wire types.** `agency_wire` is written by hand against `packages/contracts`. Drift is caught from both sides:
  - `packages/contracts/fixtures/agent/*.json` samples are type-checked against the TS contract (`agent-fixtures.test.ts`) and decoded by the Dart tests.
  - `tooling/contracts-literals.mjs` regenerates `literals.json`, the literal unions the app switches on (62: the soft phone's, customer history's and inbound calls' included, with `station_capabilities`). `--check` fails when it is stale, and so does `pnpm test` in contracts.
  - The same script writes `labels.json`, the contract's label maps the app shows word for word (`ATTEMPT_STATE_LABELS`, `ATTEMPT_OUTCOME_LABELS`); `attempt_copy_test.dart` holds the call list's labels to it, so the app cannot say "Dialing" while the console says "Dialling".
  - Every Dart enum has an `unknown` member, and the raw wire string is kept beside it, so a newer server never crashes an older app.
  - Customer history's types are `customer_history.dart` (the number rule's port is `customer_search_number.dart`); the review round of 2026-11-06 added three shapes, each decoded from the shared fixture: `CustomerHistoryOpenOverride.followUpAt` (`follow_up_at`, nullable), `CustomerHistorySummary.contactsTruncated` (`contacts_truncated`, false when absent) and `CustomerSearchOptionsResponse` (`default_country_code`, the options read). Not yet run ("Not verified yet").

## Performance and UX rules the code keeps

- No per-frame JSON or copies on the 50 fps media path. One platform message per 20 ms frame, downlink handled off the main thread. A pooled uplink on Android.
- Timers that show a ticking clock use a 1 Hz timer aligned to its start, not a frame ticker.
- Lists use `ListView.builder` with fixed-height rows. My calls prefetches the next page about 20 rows early and debounces the number search by 400 ms.
- Stale-while-revalidate for Performance: the last result shows at once and refreshes behind it.
- 48 dp touch targets, reduced-motion respected, layouts tested at 200% text on a 360×640 phone.
- A tab label that would wrap (five tabs on a 360 dp phone leave about 72 dp each) takes its short
  name: "Performance" → "Stats", "My calls" → "Calls". Measured at the bar's own 1.3× text cap.
- Live-region announcements for station phases ("Ringing", "On call", "Wrap-up", "Outcome saved").
- Copy follows the console's words wherever the console has them.

## Builds and releases

- **Toolchain:** Flutter 3.47.7, pinned in `.github/workflows/mobile.yml`.
- **CI:**
  - Contract literal drift, `flutter analyze`, the app's tests, `agency_wire` and `agent_audio` tests (Dart).
  - A debug Android build on every pull request touching the app or the contracts, then `agent_audio`'s Kotlin unit tests (`./gradlew :agent_audio:testDebugUnitTest` from `apps/mobile/android`) and the app's own (Mode B's ring logic, `./gradlew :app:testDevDebugUnitTest`).
  - An unsigned iOS build on `main`.
- **Android:**
  - minSdk 28, compileSdk 37 (`permission_handler_android` requires it), targetSdk Flutter's default.
  - Flavours `dev`, `staging` and `prod` install side by side (`com.magickagency.agent[.dev|.staging]`).
  - AGP 9.1 looks for platform 37 as `android-37` while the SDK installs `android-37.0`; CI links the two.
  - Mode B: `firebase-messaging` from the Firebase BoM 34.19.0 in the app module only (the BoM `firebase_core` 4.15.2 builds against: bump them together), `androidx.core` 1.17.0 for `CallStyle`, and `USE_FULL_SCREEN_INTENT` and `MANAGE_OWN_CALLS` in the manifest. Gradle decodes the build's dart-defines (`-Pdart-defines`) and writes `API_ORIGIN` (`magick_api_origin`) and the Firebase client config (`google_app_id`, `google_api_key`, `project_id`, `gcm_defaultSenderId`) into string resources; without the Firebase ones push is unavailable (`getToken` answers `null`) and the build still works. A Play release needs the full-screen-intent declaration for a calling app (Play Console, App content).
- **iOS:**
  - Deployment target 16.0, background mode `audio`, CallKit for the system call UI.
  - Google sign-in needs the reversed iOS client id as a URL scheme. It is in `ios/Runner/Info.plist`, hard-coded for this repo's Firebase project; another project replaces it (`apps/mobile/dev-setup.md`).
  - **iOS dependency pin.** Firebase is held on the iOS SDK 12 line: `firebase_core` ^4.15.2 and `firebase_auth` ^6.7.1 (SDK 12.19.3). SDK 13 (`firebase_core` 5, `firebase_auth` 7) needs `gtm-session-fetcher` >=4, while `google_sign_in_ios` 6.3.8, the latest release (`google_sign_in` ^7.2.0), pins GoogleSignIn-iOS 9, which needs `gtm-session-fetcher` <4, so the Swift packages cannot resolve. On SDK 12 they resolve to `gtm-session-fetcher` 3.5.0 with GoogleSignIn-iOS 9.2.0. Move Firebase up again, both plugins together, when a `google_sign_in_ios` release depends on GoogleSignIn-iOS 10.1 or later: 10.0 accepts `gtm-session-fetcher` 4 but still caps `app-check` below 12, which SDK 13 needs. The app's Dart calls are the same on both lines. Android follows the same pin: Firebase BoM 34.19.0, down from the BoM 35.1.0 and `firebase_auth` 7.0.1 that ran on the first Android phone, so Android sign-in on a phone needs a fresh check. SDK 12.19.3 needs Xcode 16.3 or newer.
- **Versions:** `pubspec.yaml` `version:` belongs to release-please (component `mobile`, `release-type: dart`). Store build numbers come from CI (`--build-number`).

## Not verified yet

- **iOS has not compiled yet.** CI's first iOS build (on `main`, 2026-11-01) stopped at package resolution: `firebase_core` 5.1.0 needs `gtm-session-fetcher` 4–6 and `google_sign_in_ios` 6.3.8 needs 3.x. The Firebase pin ("Builds and releases", iOS) fixes the resolution: SwiftPM reproduced the conflict with the plugins' constraints and resolved them with the pin. That check ran on Linux, so no Swift or Objective-C was compiled. The next `main` build is the first compile, and the Swift engine and CallKit code (the Swift ringback written to the shared vectors and CallKit for soft-phone calls included) is reviewed against the SDK headers only until it passes.
- **Customer history (2026-11-06) has not run under Dart or Flutter.** The wire types, the number-rule port, the controller and the two screens were written, reviewed and then fixed (the filters sheet, the copy button, the options read, the three wire additions) in an environment without the SDK; no `dart test`, `flutter test` or `flutter analyze` ran. A Python transcription of the port passed every row of the shared table. The mobile CI job (run on changes to `apps/mobile`, `packages/contracts` and `packages/domain/src/customer-search-number.ts`) is the first run.
- **No real device or carrier.** Nothing has run on a real phone, a real carrier call, or a real Firebase or Google sign-in. Without a carrier a soft-phone dial ends `failed` and unplaced, which tests only that path; ringing, the answer and A-law media need the VoiceLink sandbox.
- **Inbound calls (2026-11-10) have run only against the fixtures.** The app's flow is tested
  with the contract's sample frames and answers, played in the server's own frame order, not
  against a running server offering a real call to a station that declares `caps=inbound` (the
  server's side is tested on its own, with a simulated phone station: `inbound-mobile-e2e` and
  `inbound-mobile-wall-clock`), nor on a phone or a carrier. Of the chime, the Dart reference and
  its vectors run in CI (`flutter test` in `agent_audio`). Its Kotlin (`Chime.kt`, the `EngineSlot`
  and `VoiceEngine` changes) was compiled and `ChimeTest.kt` passed offline on a JVM during review;
  CI compiles it again in the debug Android build and, since 2026-11-11, runs the Kotlin unit
  tests after it (`./gradlew :agent_audio:testDebugUnitTest`; all 44 passed on a JVM with Gradle
  9.3.1 and Kotlin 2.4.0 when the step was added, outside AGP: the step's first CI run is its first
  run under the Android Gradle plugin). Its Swift (`Chime.swift`, the `Playout` and `VoiceEngine`
  changes) has never been compiled, like the rest of the iOS engine (iOS does not compile yet,
  above).
- **Mode B (2026-11-12) has not run on a phone.** CI built it under Gradle for the first time on
  2026-11-13 (PR #80's Mobile workflow at `95a0db9`: the debug APK, so the manifest, the resources
  and the Gradle changes were processed, and `:app:testDevDebugUnitTest` and
  `:agent_audio:testDebugUnitTest` under the Android Gradle plugin, all green). Before that, every Kotlin file of the app module (the Telecom, notification, activity, channel and FCM
  adapters included) and `agent_audio`'s `PhoneCalls.kt` compiled with `kotlinc` outside Gradle
  against the AOSP framework jar (Robolectric's android-all, API 37), Flutter's embedding jar,
  androidx.core 1.17.0 and firebase-messaging 25.1.3 with its Firebase and GMS dependencies, and a
  stub `R` class (105 classes, no errors, on the branch's final run of 2026-11-13, after the cleanup pass); the manifest, the resources
  and the Gradle changes (the Firebase BoM and `firebase-messaging`, the dart-defines written into
  string resources) were first processed by that CI build.
  Their pure logic (`RingStateMachine`, the push parser, the request builders, the copy and
  checklist rules, the lock-screen ring's contrast: 115 tests, on that same run) passed on a JVM with `kotlinc` and JUnit, outside Gradle; CI runs them
  under the Android Gradle plugin (`./gradlew :app:testDevDebugUnitTest`) from its first run. The
  Dart side ran under `flutter test` with a fake channel; the server's against a mock push carrier.
  Not done at all: a real FCM push (no service account was used), the native Firebase app built from
  the resources, a ring on a locked phone, the lock-screen `RingActivity`, an answer from a headset
  or a car and whether Android 14/15 lets the app come up from it, battery killers and a force-stop
  (which drops FCM), the full-screen-intent permission on Android 14+ (Play Console's declaration
  for a calling app is not filed, so a Play build may get it withheld; the checklist reports it), and
  the self-managed calling account (its `CAPABILITY_SELF_MANAGED` is deprecated as of API 37, the
  compile SDK). Also unverified: whether our own self-managed ring sets the ringtone audio mode
  (assumed it can), the Telecom call's audio route against `agent_audio`'s routing once the station
  binds, and a headset's hang-up after the bind. Nor, from the 2026-11-13 fixes: "Stop ringing"
  launching the app (warm or cold) and `moveTaskToBack` sending it back, the ring declined at that
  tap reaching the server before the station attaches, the window held over a secure lock screen
  through the outcome, a test ring's notification refused with notifications off, a late `ring_off`
  from a real carrier, and `Retry-After` on a real 429. iOS: designed only; never compiled, no APNs
  key or Apple account.
- **A network change while a soft-phone call rings ends it** (no grace before the answer), and on a carrier that cannot cancel a ringing call (SP3) the customer's phone may keep ringing. More likely on a phone than in a browser; accepted, not changed.
- **Untested behaviour:** echo cancellation on low-end Android phones on speaker, and Bluetooth rate switches on iOS, need field testing.

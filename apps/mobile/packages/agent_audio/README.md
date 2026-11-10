# agent_audio

The agent app's voice engine and call-system integration, as a Flutter plugin (Android +
iOS): voice-processing capture (echo cancellation), adaptive playout, G.711 A-law / PCM16
framing for the station socket's media, audio routes, interruptions, CallKit (iOS) and the
on-duty foreground service (Android).

The app's `AudioEngine` facade owns one `AgentAudio` for the app's lifetime. Media never
crosses the method channel: uplink and downlink frames travel on two `BinaryCodec` message
channels, one platform message per 20 ms frame, no encoding.

## Dart API

```dart
final audio = AgentAudio();

// available: configure the session for voice, pre-warm it (no mic yet)
await audio.prepare(format: AgentAudioFormat.alaw8);

// reserved: tell the system about the call, then arm the mic
await audio.startCall(callId: attemptId, displayName: 'Priya Sharma', handle: '+91 98•• •••• 21');
await audio.armMicrophone();          // capture + playback run, uplink discarded
audio.events.listen(onAudioEvent);    // routes, interruptions, errors, levels, jitter stats, call actions

// bridged: open the uplink
await audio.startUplink();
await audio.reportConnected(attemptId);
final sub = audio.uplink.listen(socket.add);   // Uint8List, 160 B A-law (or 640 B PCM16LE) per 20 ms
socketBinaryFrames.listen(audio.playFrame);    // any chunking; native re-frames

// call ended
await audio.endCall(attemptId, reason: CallEndReason.remoteEnded);
await audio.stop();                   // releases the mic, keeps the session warm

// off duty
await audio.release();
```

| Agent state | Calls                                   | `AgentAudioPhase` after |
|-------------|-----------------------------------------|-------------------------|
| available   | `prepare`                               | prepared                |
| reserved    | `startCall`, `armMicrophone`            | armed                   |
| bridged     | `startUplink`, `reportConnected`        | streaming               |
| call ended  | `endCall`, `stop()`                     | prepared                |
| off duty    | `release()` (= `stop(keepWarm: false)`) | idle                    |

Lifecycle calls are serialised in call order and checked against `AgentAudioPhase.after`
(a pure function with an exhaustive table test) before they reach the platform; the native
sides enforce the same table. `stop` is safe in any phase and repeatable. Every platform
failure is an `AgentAudioException` with an `AgentAudioErrorCode`.

Also: `setRingback` (the ringback tone on a ringing soft-phone call; see below), `playChime`
(the inbound chime, once, when an inbound caller is offered; see below), `setMuted`
(uplink keeps flowing as encoded silence, so the far end keeps its timing),
`routes` / `currentRoute` / `setRoute`, `setInputLevelMetering` (≈10 `InputLevel` events/s),
`loopbackTest` (pre-flight), `configureCallSystem(useCallKit:)`, `startOnDutyService` /
`updateOnDutyService` / `stopOnDutyService`, `isIgnoringBatteryOptimizations` /
`requestIgnoreBatteryOptimizations`. Platform-specific calls are no-ops on the other
platform (battery calls return `true` on iOS).

`package:agent_audio/reference.dart` exports the pure-Dart reference DSP (A-law, half-band
resampler, jitter buffer, ringback tone). It is the specification the native code mirrors and is what the
cross-language tests are generated from; the app does not need it on the media path.

## Frame flow

```
                  ┌──────────────────────── Android ────────────────────────┐
 uplink   mic ──▶ AudioRecord VOICE_COMMUNICATION 16 kHz (+AEC/NS/AGC)
                  └─▶ capture thread: 20 ms read → [half-band 16→8 kHz → A-law] | [PCM16LE]
                      └─▶ pooled direct ByteBuffer → main Handler → BinaryMessenger.send ─▶ Dart `uplink`
 downlink Dart `playFrame` ─▶ background TaskQueue: re-frame → decode → JitterBuffer.push
                  playback thread: JitterBuffer.pop (20 ms) → [+ ringback] → AudioTrack.write
                  (blocking, 8/16 kHz, USAGE_VOICE_COMMUNICATION) ─▶ earpiece / speaker / headset
                  └──────────────────────────────────────────────────────────┘

                  ┌────────────────────────── iOS ───────────────────────────┐
 uplink   mic ──▶ AVAudioEngine inputNode (voice processing = VPIO echo cancellation, 48 kHz)
                  └─▶ AVAudioSinkNode (render thread) → FloatRing
                      └─▶ I/O queue, 10 ms timer: AVAudioConverter → 8/16 kHz Int16 → 20 ms frames
                          → A-law | PCM16LE → main → sendOnChannel ─▶ Dart `uplink`
 downlink Dart `playFrame` ─▶ background task queue: re-frame → decode → Playout (jitter buffer)
                  AVAudioSourceNode at 8/16 kHz (render thread pulls Playout: pop → [+ ringback])
                  → mainMixer (resamples)
                  → outputNode ─▶ receiver / speaker / headset
                  └──────────────────────────────────────────────────────────┘
```

## Threading model

**Android.** Method calls, events and route/focus handling run on the main thread. Capture
and playback each have a dedicated thread at `THREAD_PRIORITY_URGENT_AUDIO`; the playback
loop is paced by `AudioTrack.write` blocking on the output clock. Downlink messages arrive on
a background `TaskQueue` (never the main thread) and are copied out before the callback
returns (Flutter frees the buffer after). The jitter buffer is the only shared structure and
sits behind one monitor held for a frame copy. `BinaryMessenger.send` must run on the main
thread with a direct buffer whose `position()` is the length, so eight pooled direct buffers,
each with its own `Runnable`, cycle between the capture thread and the main thread: no
allocation per frame; if the main thread falls 160 ms behind, frames are dropped and counted
(`JitterStats.uplinkDrops`) instead of queueing. Teardown (`stop`) stops the threads, joins
them (500 ms bound) and only then releases `AudioRecord`, `AudioTrack` and the effects, on
the main thread. A device that dies mid-call (`ERROR_DEAD_OBJECT`, audio server restart) is
rebuilt up to 3 times a minute with the uplink state kept, reported as an `AudioErrorEvent`
with `recovered`.

**iOS.** Method calls, CallKit (delegate queue = main), session notifications (re-dispatched
to main) and events run on main. The two render threads (sink and source nodes) only copy
samples under an `os_unfair_lock` (no allocation, no Objective-C messaging). A serial
user-interactive I/O queue with a 10 ms timer drains the capture ring, converts, frames,
meters and encodes; uplink `Data` and events hop to main (one small allocation per frame,
which `sendOnChannel` copies anyway). At most 8 uplink frames (160 ms) wait for main; beyond
that frames are dropped and counted (`JitterStats.uplinkDrops`), as on Android. Downlink messages arrive on Flutter's background task
queue. Stopping cancels the timer and fences the queue (`ioQueue.sync {}`) before anything is
torn down. Engine configuration changes (e.g. a Bluetooth HFP route switching the hardware to
16 kHz) reconnect the graph with the new format and a new converter; a media-services reset
rebuilds the session and engine from scratch.

## Jitter buffer

Specification: `lib/src/jitter/jitter_buffer.dart` (algorithm documented there), ported line
for line to `JitterBuffer.kt` and `JitterBuffer.swift`. Frames come over TCP, so there is no
reordering, only stalls and bursts:

- target depth 80–240 ms, starting at 100 ms; prefill to target before playing;
- underrun → +40 ms target and refill; meanwhile the last frame repeats with a linear fade to
  zero over 60 ms, then silence; the first real frame afterwards fades in over 5 ms;
- overflow (more than 320 ms queued) drops the oldest frame;
- depth above target + 40 ms for 0.5 s drops one frame (latency a burst added drains away);
- 10 s without an underrun shrinks the target by 20 ms.

All arithmetic is integer and truncates toward zero, so the ports are bit-identical:
`test/fixtures/jitter_trace.txt` (≈6 600 ops: stalls, bursts, overflow, random traffic,
growth to the maximum and shrink to the minimum) is generated from the Dart model and replayed
by `JitterBufferTraceTest.kt`. Regenerate it with
`UPDATE_JITTER_TRACE=1 flutter test test/jitter_buffer_test.dart`.

## Ringback

While the customer's phone rings on a soft-phone call, the carrier sends nothing on the
agent's leg, so the tone is generated on the device. The app calls `setRingback(true)` when
the call rings (and the agent has not muted the ring) and `setRingback(false)` when it is
answered or ends.

- The tone matches the console's: 400 + 450 Hz, 0.4 s on, 0.2 s off, 0.4 s on, 2.0 s off,
  12 ms linear edges. `(sin 400 Hz + sin 450 Hz) / 2` peaks at 0.12 of full scale (the
  console's `RINGBACK_PEAK`; the console sums the two sines without halving them and scales by
  the agent's cue volume, which the phone, played at the call volume, does not have).
- Specification: `lib/src/tone/ringback.dart`. Each sample is a pure function of its index
  since the tone started; the phase comes from the integer index, and rounding is spelled out
  as floor(x + 0.5), so Dart, Kotlin (`Ringback.kt`) and Swift (`Ringback.swift`) give the same
  samples. Golden vectors (`test/support/ringback_vectors.dart`: samples at the edges, gaps
  and cycle wrap, a first-cycle checksum and the energy of each cadence segment, at 8 and
  16 kHz) are asserted by `test/ringback_test.dart` and by `RingbackTest.kt`. The only
  platform input is `sin`, which differs by at most an ulp between maths libraries, too
  little to move a rounded sample.
- It is mixed into each 20 ms frame right after the jitter-buffer pop, at the wire rate, with
  a saturating add (Kotlin `VoiceEngine.playbackLoop`, Swift `Playout.render`), so any early
  media the carrier does send is still heard and loud downlink clips instead of wrapping.
- The request is kept natively: made before `armMicrophone`, it starts with the engine; it
  survives an engine restart after a device error or an interruption; `stop` clears it; the
  loopback test never rings. `setRingback` is queued behind pending lifecycle calls (it does
  not change the phase), so a `stop` still in flight cannot clear a newer request. Turning it
  off and on again starts a fresh ring, at the top of the cadence; turning it off mid-burst
  cuts at the frame boundary.
- Testing the request on Android: the plugin starts and stops every engine through
  `EngineSlot` (`Ringback.kt`), which applies the request at each engine start and clears it on
  a stop that ends the call. `RingbackTest.kt` drives the slot with a fake engine: a request
  made before arm reaches the engine started at arm, changes reach the running engine, the
  request survives a restart and a failed start, `stop` clears it (also with no engine
  running), and a loopback engine never rings. What it cannot see is the plugin's choice at
  each call site: `stop` and detaching pass `keepRingback = false`, a restart and the end of a
  loopback test pass `true`. The plugin needs Flutter and Android, which these JVM tests do
  not load. The Swift engine follows the same rules (`ringbackWanted` in `VoiceEngine.swift`)
  with no test here.

## Inbound chime

When an inbound caller is offered to the agent (the station's `inbound_call` frame, `offered`),
the app calls `playChime()` once, right after arming the microphone for the call, so the agent
hears the offer before the caller's audio binds at `connects_at` (about 1.5 s later).

- It is the console's `inbound_ring` cue (`CUE_SPECS.inbound_ring`): 784, 587, 784, 587 Hz,
  each with an 8 ms linear attack, 120 ms hold and 25 ms linear release, gaps of 30, 160 and
  30 ms, after a 5 ms lead, peaking at 0.12 of full scale; about 0.84 s, then silence.
- Specification: `lib/src/tone/chime.dart`, written like the ringback's (each tone's phase from
  the integer index within the tone, floor(x + 0.5)). Golden vectors
  (`test/support/chime_vectors.dart`: the lead, the edges, a gap, the end, a checksum and the
  energy, at 8 and 16 kHz) are asserted by `test/chime_test.dart` and by `ChimeTest.kt`;
  `Chime.swift` is written to them.
- Mixed into each 20 ms playout frame after the ringback, at the wire rate, with a saturating
  add (Kotlin `VoiceEngine.playbackLoop`, Swift `Playout.render`), so it is heard only on the
  phone, never sent to the caller.
- One-shot: a request made before the engine runs (iOS starts it when CallKit activates the
  session, after `armMicrophone` returns) plays when it starts; `stop` drops one not yet played
  and silences one playing; a restart after a device error does not replay it; a loopback test
  never chimes. On Android the request goes through `EngineSlot` (`chimePending`), checked by
  `ChimeTest.kt` with a fake engine; Swift keeps `chimePending` in `VoiceEngine.swift`.
- The app decides when (once per offer: the call id and `offered_at`) and whether (the Sounds
  setting); this package only plays it.

## Codec and resampling

- G.711 A-law, table-based (4096-entry encode on the 13-bit magnitude, 256-entry decode),
  checked against the G.711 reference for all 65 536 inputs in Dart and Kotlin, with shared
  checksums pinning Dart, Kotlin (and the documented Swift values) together.
- Android captures at 16 kHz for both formats (reliable for `VOICE_COMMUNICATION`); the A-law
  uplink goes through a 51-tap half-band low-pass decimator (flat to 3.4 kHz, ≥ 59 dB down
  from 4.6 kHz, integer Q15, bit-identical to the Dart reference). Playback opens `AudioTrack`
  at the wire rate and lets AudioFlinger resample.
- iOS runs the hardware at 48 kHz (voice processing) and converts with `AVAudioConverter`;
  playback runs the source node at the wire rate and the mixer converts.

## Event channel schema

Each event is a map with `type`; `AudioEvent.decode` turns it into a sealed class and drops
types it does not know.

| `type`         | Fields                                                                                              |
|----------------|-----------------------------------------------------------------------------------------------------|
| `route`        | `current` (`{kind, id, name}` or null), `available` (list), `reason`: newDevice / deviceRemoved / requested / other |
| `interruption` | `phase`: began / ended, `reason`: phoneCall / focusLoss / microphoneSilenced / system / other, `shouldResume` |
| `noisy`        | —                                                                                                   |
| `error`        | `code` (error wire name), `message`, `recovered`                                                    |
| `level`        | `dbfs`                                                                                              |
| `jitter`       | `depth`, `target`, `underruns`, `concealed`, `silent`, `overflowDrops`, `latencyDrops`, `received`, `played`, `uplinkDrops` |
| `callAction`   | `action`: end / mute, `callId`, `muted`, `source`: callKit / notification                           |
| `session`      | `active` (iOS: CallKit activated / deactivated the audio session)                                   |
| `callReset`    | — (iOS: CallKit provider reset)                                                                     |
| `service`      | `running`: false (Android: the on-duty service stopped without `stopOnDutyService`)                 |

Route `name` is the headset's product name; built-in earpiece and speaker have an empty name
(the app labels them by `kind`). Audio never moves to the loudspeaker on its own: when the
headset in use goes, it falls back to a wired headset, then the earpiece. A route chosen
during a call (the speaker above all) lasts for that call only: `stop` after a call puts the
session back on the default route (Bluetooth, then wired, then the earpiece). The proximity
screen-off is held only for a call on the earpiece, never during the loopback test.

## Interruptions

- **Android**, no `READ_PHONE_STATE`: audio-focus loss (a ringing or active cellular call,
  another VoIP app, an alarm); on API 31+ the audio mode switching to RINGTONE / IN_CALL /
  CALL_SCREENING, which is how a cellular call shows without telephony permissions and which
  classifies the interruption as `phoneCall`; on API 29+ the capture policy silencing the
  recorder. The three are folded into one began/ended pair (`InterruptionTracker`). Android
  resets the mode to NORMAL after a cellular call, so the end of an interruption re-asserts
  `MODE_IN_COMMUNICATION` and the chosen route.
- **iOS**: `AVAudioSession.interruptionNotification` (reason `phoneCall` when CallKit's call
  observer shows another call, `microphoneSilenced` for `builtInMicMuted`). With CallKit, a
  cellular call arriving mid-call shows the system's "End & Accept"; ending ours that way
  arrives as `CallSystemAction(end)`. iOS does not promise an `.ended` for every `.began`, so
  an interruption still open when CallKit activates the session, or at `prepare` / `stop`, is
  closed with an `ended` event; a `.began` for a suspended app (`appWasSuspended`) is ignored.
- **Android**, a permanent focus loss gets no GAIN back: while a call runs the plugin asks for
  focus again (at once when a cellular call ends, otherwise after 1, 2, 5, then every 10 s).

## What the app must add

### Android

The plugin's manifest is merged into the app, so these need no app change: `RECORD_AUDIO`,
`MODIFY_AUDIO_SETTINGS`, `WAKE_LOCK` (proximity screen-off), `FOREGROUND_SERVICE`,
`FOREGROUND_SERVICE_MICROPHONE`, `POST_NOTIFICATIONS`, `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`,
`BLUETOOTH` (maxSdkVersion 30), `BLUETOOTH_CONNECT`, and the `OnDutyService` declaration
(`foregroundServiceType="microphone"`, `stopWithTask="true"`).

The app must:

- set `minSdk` ≥ 26 (the plugin's minimum);
- request at runtime, before "Go on duty": `RECORD_AUDIO`, and `POST_NOTIFICATIONS` on 33+
  (without it the service runs but its notification is hidden). `BLUETOOTH_CONNECT` (31+) is
  optional: routing works without it; ask for it only if headset names come back empty;
- call `startOnDutyService` at "Go on duty" while the app is on screen (Android 14 refuses a
  microphone foreground service from the background: `notInForeground`), `updateOnDutyService`
  when a call starts / mute changes / the call ends, and `stopOnDutyService` at "Go off duty";
- handle `CallSystemAction(source: notification)` (Mute / Hang up on the notification);
- handle `OnDutyServiceStopped` (Android stopped the service): tell the agent and call
  `startOnDutyService` again when the app is back on screen.

### iOS

Add to `ios/Runner/Info.plist`:

```xml
<key>NSMicrophoneUsageDescription</key>
<string>Magick Agency uses the microphone so you can talk to customers on calls.</string>
<key>UIBackgroundModes</key>
<array>
  <string>audio</string>
</array>
```

No `voip` background mode (there is no PushKit), no entitlement is needed for CallKit. The
deployment target must be ≥ 15.0. The app requests microphone permission (e.g. at pre-flight)
before `armMicrophone`; a denied permission fails with `permissionDenied`.

In apps distributed in mainland China call `configureCallSystem(useCallKit: false)`; the
plugin then activates the audio session itself (at `prepare`, as a pre-warm) and there are no
lock-screen call controls.

## Testing

```bash
cd apps/mobile/packages/agent_audio
flutter test                      # API layer (mocked channels), events, phases, A-law, resampler,
                                  # jitter buffer + trace fixture, ringback and chime vectors,
                                  # loopback analysis
flutter analyze .
```

Kotlin unit tests (`android/src/test`) cover A-law, the decimator (shared checksum), the
jitter buffer (replaying the Dart trace), the ringback tone (the Dart vectors, cadence,
mixing, the request kept across arm and cleared by stop), the inbound chime (the Dart vectors,
played once frame by frame, a request before the engine runs, dropped by stop), framing, the uplink encoder, the
level meter and the interruption tracker; they need no Android or Flutter classes. They run with the app's Gradle
build (`./gradlew :agent_audio:testDebugUnitTest` from `apps/mobile/android`), by hand: CI builds the
Android app but does not run them.

The Swift sources cannot be compiled on Linux. `ALaw.swift` documents the same checksums;
the trace format is documented in `test/support/jitter_trace.dart` for a Swift replay test,
`Ringback.swift` is written to the vectors in `test/support/ringback_vectors.dart`, and
`Chime.swift` to those in `test/support/chime_vectors.dart`.

## Known limits

- Packet-loss concealment repeats the last frame with a fade; there is no pitch-synchronous
  PLC or time-stretching, so a long stall sounds like a short fade then silence, and latency is
  trimmed by dropping whole 20 ms frames.
- iOS capture uses `AVAudioSinkNode`; if it delivers nothing within 600 ms the engine falls back
  to an input tap, which buffers ≥ 100 ms (higher mouth-to-ear delay) for the rest of that call.
- Android routes below API 31 use the deprecated speakerphone / SCO calls; SCO connection is
  asynchronous, so a Bluetooth switch is confirmed by a later `route` event.
- No ConnectionService on Android in v1: a cellular call during a dialer call is seen as an
  interruption only; Android does not stop the cellular call from ringing.
- Jitter-buffer state starts fresh on every call (it does not carry a learned target across
  calls).
- Echo cancellation quality depends on the device's platform AEC (Android) — budget phones on
  speakerphone are the case to field-test.

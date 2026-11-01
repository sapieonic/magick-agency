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

Also: `setMuted` (uplink keeps flowing as encoded silence, so the far end keeps its timing),
`routes` / `currentRoute` / `setRoute`, `setInputLevelMetering` (≈10 `InputLevel` events/s),
`loopbackTest` (pre-flight), `configureCallSystem(useCallKit:)`, `startOnDutyService` /
`updateOnDutyService` / `stopOnDutyService`, `isIgnoringBatteryOptimizations` /
`requestIgnoreBatteryOptimizations`. Platform-specific calls are no-ops on the other
platform (battery calls return `true` on iOS).

`package:agent_audio/reference.dart` exports the pure-Dart reference DSP (A-law, half-band
resampler, jitter buffer). It is the specification the native code mirrors and is what the
cross-language tests are generated from; the app does not need it on the media path.

## Frame flow

```
                  ┌──────────────────────── Android ────────────────────────┐
 uplink   mic ──▶ AudioRecord VOICE_COMMUNICATION 16 kHz (+AEC/NS/AGC)
                  └─▶ capture thread: 20 ms read → [half-band 16→8 kHz → A-law] | [PCM16LE]
                      └─▶ pooled direct ByteBuffer → main Handler → BinaryMessenger.send ─▶ Dart `uplink`
 downlink Dart `playFrame` ─▶ background TaskQueue: re-frame → decode → JitterBuffer.push
                  playback thread: JitterBuffer.pop (20 ms) → AudioTrack.write (blocking, 8/16 kHz,
                  USAGE_VOICE_COMMUNICATION) ─▶ earpiece / speaker / headset
                  └──────────────────────────────────────────────────────────┘

                  ┌────────────────────────── iOS ───────────────────────────┐
 uplink   mic ──▶ AVAudioEngine inputNode (voice processing = VPIO echo cancellation, 48 kHz)
                  └─▶ AVAudioSinkNode (render thread) → FloatRing
                      └─▶ I/O queue, 10 ms timer: AVAudioConverter → 8/16 kHz Int16 → 20 ms frames
                          → A-law | PCM16LE → main → sendOnChannel ─▶ Dart `uplink`
 downlink Dart `playFrame` ─▶ background task queue: re-frame → decode → Playout (jitter buffer)
                  AVAudioSourceNode at 8/16 kHz (render thread pulls Playout) → mainMixer (resamples)
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
which `sendOnChannel` copies anyway). Downlink messages arrive on Flutter's background task
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

Route `name` is the headset's product name; built-in earpiece and speaker have an empty name
(the app labels them by `kind`). Audio never moves to the loudspeaker on its own: when the
headset in use goes, it falls back to a wired headset, then the earpiece.

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
  arrives as `CallSystemAction(end)`.

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
- handle `CallSystemAction(source: notification)` (Mute / Hang up on the notification).

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
                                  # jitter buffer + trace fixture, loopback analysis
flutter analyze .
```

Kotlin unit tests (`android/src/test`) cover A-law, the decimator (shared checksum), the
jitter buffer (replaying the Dart trace), framing, the uplink encoder, the level meter and the
interruption tracker; they need no Android or Flutter classes. They run with the app's Gradle
build (`./gradlew :agent_audio:testDebugUnitTest` from `apps/mobile/android`).

The Swift sources cannot be compiled on Linux. `ALaw.swift` documents the same checksums;
the trace format is documented in `test/support/jitter_trace.dart` for a Swift replay test.

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

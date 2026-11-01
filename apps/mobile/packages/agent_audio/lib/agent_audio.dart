/// Native voice audio for the agent app: capture with echo cancellation, adaptive playout,
/// G.711 A-law / PCM16 framing, audio routes, interruptions, CallKit (iOS) and the on-duty
/// foreground service (Android). See README.md for the architecture and threading model.
library;

export 'src/agent_audio.dart' show AgentAudio;
export 'src/events.dart';
export 'src/loopback.dart';
export 'src/types.dart';

/// The station socket: server frames, client frames, close codes and intervals.
///
/// Contract: `packages/contracts/src/agency/station.ts` (and the console's
/// reading of it in `api/agency/agency.ts`).
///
/// One socket carries three multiplexed streams: agency control frames, the
/// heartbeat, and media. The bridge also writes its own `status` / `ended`
/// frames onto it, so a consumer's switch must not assume only agency frames
/// arrive; everything this build does not recognise is an [UnknownFrame].
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:meta/meta.dart';

import 'enums.dart';
import 'equality.dart';
import 'json.dart';
import 'softphone.dart';

/// The `event` discriminant of a server frame.
///
/// Contract: the members of `AgencyStationServerFrame`.
enum StationEvent implements WireEnum {
  ready('ready'),
  reserved('reserved'),
  countdown('countdown'),
  bridged('bridged'),
  released('released'),
  wrapup('wrapup'),
  agentState('agent_state'),
  campaignState('campaign_state'),
  pong('pong'),
  error('error'),
  status('status'),
  ended('ended'),
  media('media'),
  manualCall('manual_call'),
  unknown('');

  const StationEvent(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static StationEvent fromWire(String? raw) => _byWire[raw] ?? unknown;
}

// ─── Server frames ──────────────────────────────────────────────────────────

/// A frame the server sent on the station socket.
///
/// Contract: `AgencyStationServerFrame`.
@immutable
sealed class StationFrame {
  const StationFrame();

  StationEvent get event;

  /// Decodes one text frame. **Never throws**: an unknown `event`, a payload
  /// that is not JSON, or one missing a required field is an [UnknownFrame]
  /// carrying the reason.
  static StationFrame decode(String text) {
    final media = _mediaFastPath(text);
    if (media != null) return media;

    final Object? decoded;
    try {
      decoded = jsonDecode(text);
    } on FormatException catch (e) {
      return UnknownFrame(raw: text, reason: 'not JSON: ${e.message}');
    }
    if (decoded is! Map<String, Object?>) {
      return UnknownFrame(raw: text, reason: 'not a JSON object');
    }
    final event = decoded['event'];
    if (event is! String) {
      return UnknownFrame(raw: text, reason: 'no string `event`');
    }
    try {
      return switch (event) {
        'pong' => PongFrame.fromJson(decoded),
        'agent_state' => AgentStateFrame.fromJson(decoded),
        'media' => MediaFrame.fromJson(decoded),
        'ready' => ReadyFrame.fromJson(decoded),
        'reserved' => ReservedFrame.fromJson(decoded),
        'countdown' => CountdownFrame.fromJson(decoded),
        'bridged' => BridgedFrame.fromJson(decoded),
        'released' => ReleasedFrame.fromJson(decoded),
        'wrapup' => WrapupFrame.fromJson(decoded),
        'campaign_state' => CampaignStateFrame.fromJson(decoded),
        'error' => StationErrorFrame.fromJson(decoded),
        'status' => BridgeStatusFrame.fromJson(decoded),
        'ended' => BridgeEndedFrame.fromJson(decoded),
        'manual_call' => ManualCallFrame.fromJson(decoded),
        _ => UnknownFrame(raw: text, eventRaw: event, reason: 'unknown event'),
      };
      // Any failure, including a TypeError this package did not anticipate,
      // must not take the socket's listener down with it.
    } catch (e) {
      return UnknownFrame(raw: text, eventRaw: event, reason: e.toString());
    }
  }

  /// Wraps one binary frame: raw A-law media under `media=alaw8`. No JSON,
  /// and no copy when [bytes] is already a [Uint8List] (as `dart:io` delivers).
  static BinaryMediaFrame decodeBinary(List<int> bytes) =>
      BinaryMediaFrame(bytes is Uint8List ? bytes : Uint8List.fromList(bytes));

  /// The server serialises media as exactly this (`JSON.stringify` of
  /// `{event:'media', media:{payload}}`), 50 times a second under `pcm16`, so
  /// it is read by slicing rather than through a JSON tree. Anything that does
  /// not match byte for byte takes the general path.
  static const _mediaPrefix = '{"event":"media","media":{"payload":"';
  static const _mediaSuffix = '"}}';

  static MediaFrame? _mediaFastPath(String text) {
    if (!text.startsWith(_mediaPrefix) || !text.endsWith(_mediaSuffix)) return null;
    final end = text.length - _mediaSuffix.length;
    if (end < _mediaPrefix.length) return null;
    // Base64 has neither; either one means the general path must decide.
    final quote = text.indexOf('"', _mediaPrefix.length);
    if (quote != end) return null;
    if (text.indexOf(r'\', _mediaPrefix.length) != -1) return null;
    return MediaFrame(text.substring(_mediaPrefix.length, end));
  }
}

/// A frame this build could not read: an unknown `event`, or a known one
/// whose payload did not decode. The station ignores it; [reason] is for logs.
final class UnknownFrame extends StationFrame {
  const UnknownFrame({required this.raw, this.eventRaw, required this.reason});

  /// The frame's text, unchanged. May hold contact data: do not log it whole.
  final String raw;

  /// The frame's `event`, when it had a string one.
  final String? eventRaw;
  final String reason;

  @override
  StationEvent get event => StationEvent.fromWire(eventRaw);

  @override
  bool operator ==(Object other) =>
      other is UnknownFrame && other.raw == raw && other.eventRaw == eventRaw && other.reason == reason;

  @override
  int get hashCode => Object.hash(raw, eventRaw, reason);

  @override
  String toString() => 'UnknownFrame(event: $eventRaw, reason: $reason)';
}

/// Sent once, on socket open, after rehydration: how a reconnect is explained.
///
/// [activeAttempt] set ⇒ resumed onto a live attempt (the server does NOT
/// re-emit `bridged`; `activeAttempt.bridgedAt` is the authority).
/// [missedRelease] set ⇒ the attempt ended while the socket was away; it is
/// consumed on read server-side, so this is the only time it is offered.
///
/// Contract: `AgencyStationReadyFrame`.
final class ReadyFrame extends StationFrame {
  ReadyFrame({
    required this.sessionId,
    required this.state,
    String? stateRaw,
    this.breakReason,
    this.activeAttempt,
    this.activeWrapup,
    this.missedRelease,
    this.pendingState,
    String? pendingStateRaw,
    this.pendingBreakReason,
  }) : stateRaw = stateRaw ?? state.wire,
       pendingStateRaw = pendingStateRaw ?? pendingState?.wire;

  factory ReadyFrame.fromJson(Map<String, Object?> j) {
    final state = j.str('state');
    final pending = j.strOrNull('pending_state');
    final active = j.objOrNull('active_attempt');
    final wrapup = j.objOrNull('active_wrapup');
    final missed = j.objOrNull('missed_release');
    return ReadyFrame(
      sessionId: j.str('session_id'),
      state: AgentState.fromWire(state),
      stateRaw: state,
      breakReason: j.strOrNull('break_reason'),
      activeAttempt: active == null ? null : ActiveAttempt.fromJson(active),
      activeWrapup: wrapup == null ? null : WrapupState.fromJson(wrapup),
      missedRelease: missed == null ? null : MissedRelease.fromJson(missed),
      pendingState: pending == null ? null : AgentState.fromWire(pending),
      pendingStateRaw: pending,
      pendingBreakReason: j.strOrNull('pending_break_reason'),
    );
  }

  final String sessionId;
  final AgentState state;
  final String stateRaw;

  /// The break's code when [state] is `break` (e.g. `device_away`: the app was
  /// paused for leaving the foreground). Null when not on break, on a break
  /// with no recorded reason, or from a server older than the field.
  final String? breakReason;
  final ActiveAttempt? activeAttempt;
  final WrapupState? activeWrapup;
  final MissedRelease? missedRelease;

  /// A queued transition (a break asked for mid-call). Null clears any badge.
  final AgentState? pendingState;
  final String? pendingStateRaw;

  /// Present when [pendingState] is `break`.
  final String? pendingBreakReason;

  @override
  StationEvent get event => StationEvent.ready;

  @override
  bool operator ==(Object other) =>
      other is ReadyFrame &&
      other.sessionId == sessionId &&
      other.stateRaw == stateRaw &&
      other.breakReason == breakReason &&
      other.activeAttempt == activeAttempt &&
      other.activeWrapup == activeWrapup &&
      other.missedRelease == missedRelease &&
      other.pendingStateRaw == pendingStateRaw &&
      other.pendingBreakReason == pendingBreakReason;

  @override
  int get hashCode => Object.hash(
    sessionId,
    stateRaw,
    breakReason,
    activeAttempt,
    activeWrapup,
    missedRelease,
    pendingStateRaw,
    pendingBreakReason,
  );

  @override
  String toString() =>
      'ReadyFrame($stateRaw${breakReason == null ? '' : '/$breakReason'}, active: ${activeAttempt?.attemptId}, '
      'wrapup: ${activeWrapup != null}, missed: ${missedRelease?.attemptId}, pending: $pendingStateRaw)';
}

/// The context push: a contact is reserved for this agent and is about to be
/// dialled. Arrives before the carrier can answer; render the panel at once.
///
/// Contract: `AgencyStationReservedFrame`.
final class ReservedFrame extends StationFrame {
  const ReservedFrame(this.attempt);

  factory ReservedFrame.fromJson(Map<String, Object?> j) => ReservedFrame(ReservedAttempt.fromJson(j.obj('attempt')));

  final ReservedAttempt attempt;

  @override
  StationEvent get event => StationEvent.reserved;

  @override
  bool operator ==(Object other) => other is ReservedFrame && other.attempt == attempt;

  @override
  int get hashCode => attempt.hashCode;

  @override
  String toString() => 'ReservedFrame(${attempt.attemptId})';
}

/// The 3-2-1 auto-connect countdown, once per remaining second.
///
/// Contract: `AgencyStationCountdownFrame`.
final class CountdownFrame extends StationFrame {
  const CountdownFrame({required this.attemptId, required this.secondsRemaining});

  factory CountdownFrame.fromJson(Map<String, Object?> j) =>
      CountdownFrame(attemptId: j.str('attempt_id'), secondsRemaining: j.integer('seconds_remaining'));

  final String attemptId;
  final int secondsRemaining;

  @override
  StationEvent get event => StationEvent.countdown;

  @override
  bool operator ==(Object other) =>
      other is CountdownFrame && other.attemptId == attemptId && other.secondsRemaining == secondsRemaining;

  @override
  int get hashCode => Object.hash(attemptId, secondsRemaining);

  @override
  String toString() => 'CountdownFrame($attemptId, $secondsRemaining)';
}

/// Audio is live; the talk timer counts from [bridgedAt].
///
/// Contract: `AgencyStationBridgedFrame`.
final class BridgedFrame extends StationFrame {
  const BridgedFrame({required this.attemptId, required this.bridgedAt});

  factory BridgedFrame.fromJson(Map<String, Object?> j) =>
      BridgedFrame(attemptId: j.str('attempt_id'), bridgedAt: j.time('bridged_at'));

  final String attemptId;
  final DateTime bridgedAt;

  @override
  StationEvent get event => StationEvent.bridged;

  @override
  bool operator ==(Object other) =>
      other is BridgedFrame && other.attemptId == attemptId && other.bridgedAt == bridgedAt;

  @override
  int get hashCode => Object.hash(attemptId, bridgedAt);

  @override
  String toString() => 'BridgedFrame($attemptId, $bridgedAt)';
}

/// The attempt is over and the agent is free. Always carries a [reason];
/// for a reason this build does not know, show [message].
///
/// Contract: `AgencyStationReleasedFrame`.
final class ReleasedFrame extends StationFrame {
  ReleasedFrame({
    required this.attemptId,
    required this.reason,
    String? reasonRaw,
    required this.requiresDisposition,
    required this.message,
  }) : reasonRaw = reasonRaw ?? reason.wire;

  factory ReleasedFrame.fromJson(Map<String, Object?> j) {
    final reason = j.str('reason');
    return ReleasedFrame(
      attemptId: j.str('attempt_id'),
      reason: ReleaseReason.fromWire(reason),
      reasonRaw: reason,
      requiresDisposition: j.boolean('requires_disposition'),
      message: j.str('message'),
    );
  }

  final String attemptId;
  final ReleaseReason reason;
  final String reasonRaw;

  /// True only when the call reached the agent: keep the panel up and prompt.
  final bool requiresDisposition;

  /// The server's fallback sentence.
  final String message;

  @override
  StationEvent get event => StationEvent.released;

  @override
  bool operator ==(Object other) =>
      other is ReleasedFrame &&
      other.attemptId == attemptId &&
      other.reasonRaw == reasonRaw &&
      other.requiresDisposition == requiresDisposition &&
      other.message == message;

  @override
  int get hashCode => Object.hash(attemptId, reasonRaw, requiresDisposition, message);

  @override
  String toString() => 'ReleasedFrame($attemptId, $reasonRaw, requiresDisposition: $requiresDisposition)';
}

/// The agent entered wrap-up or their wrap-up changed. Idempotent: replace
/// the whole wrap-up state with [wrapup]. Wrap-up *ending* arrives as an
/// [AgentStateFrame], never here.
///
/// Contract: `AgencyStationWrapupFrame`.
final class WrapupFrame extends StationFrame {
  const WrapupFrame(this.wrapup);

  factory WrapupFrame.fromJson(Map<String, Object?> j) => WrapupFrame(WrapupState.fromJson(j.obj('wrapup')));

  final WrapupState wrapup;

  @override
  StationEvent get event => StationEvent.wrapup;

  @override
  bool operator ==(Object other) => other is WrapupFrame && other.wrapup == wrapup;

  @override
  int get hashCode => wrapup.hashCode;

  @override
  String toString() => 'WrapupFrame(${wrapup.attemptId}, ends: ${wrapup.endsAt}, held: ${wrapup.heldReasonRaw})';
}

/// The authoritative agent-state transition. The app must not infer state.
///
/// Contract: `AgencyStationAgentStateFrame`.
final class AgentStateFrame extends StationFrame {
  AgentStateFrame({
    required this.state,
    String? stateRaw,
    this.breakReason,
    required this.since,
    this.pendingState,
    String? pendingStateRaw,
    this.pendingBreakReason,
  }) : stateRaw = stateRaw ?? state.wire,
       pendingStateRaw = pendingStateRaw ?? pendingState?.wire;

  factory AgentStateFrame.fromJson(Map<String, Object?> j) {
    final state = j.str('state');
    final pending = j.strOrNull('pending_state');
    return AgentStateFrame(
      state: AgentState.fromWire(state),
      stateRaw: state,
      breakReason: j.strOrNull('break_reason'),
      since: j.time('since'),
      pendingState: pending == null ? null : AgentState.fromWire(pending),
      pendingStateRaw: pending,
      pendingBreakReason: j.strOrNull('pending_break_reason'),
    );
  }

  final AgentState state;
  final String stateRaw;

  /// Present when [state] is `break`.
  final String? breakReason;
  final DateTime since;

  /// A queued transition; null means nothing is queued (clear any badge).
  final AgentState? pendingState;
  final String? pendingStateRaw;

  /// Present when [pendingState] is `break`.
  final String? pendingBreakReason;

  @override
  StationEvent get event => StationEvent.agentState;

  @override
  bool operator ==(Object other) =>
      other is AgentStateFrame &&
      other.stateRaw == stateRaw &&
      other.breakReason == breakReason &&
      other.since == since &&
      other.pendingStateRaw == pendingStateRaw &&
      other.pendingBreakReason == pendingBreakReason;

  @override
  int get hashCode => Object.hash(stateRaw, breakReason, since, pendingStateRaw, pendingBreakReason);

  @override
  String toString() =>
      'AgentStateFrame($stateRaw${breakReason == null ? '' : '/$breakReason'}, since: $since, '
      'pending: $pendingStateRaw)';
}

/// The campaign this agent works changed state. Drive the idle screen from
/// [dialing], not from [status].
///
/// Contract: `AgencyStationCampaignStateFrame`.
final class CampaignStateFrame extends StationFrame {
  CampaignStateFrame({
    required this.campaignId,
    required this.status,
    String? statusRaw,
    required this.reason,
    String? reasonRaw,
    required this.dialing,
    required this.message,
  }) : statusRaw = statusRaw ?? status.wire,
       reasonRaw = reasonRaw ?? reason.wire;

  factory CampaignStateFrame.fromJson(Map<String, Object?> j) {
    final status = j.str('status');
    final reason = j.str('reason');
    return CampaignStateFrame(
      campaignId: j.str('campaign_id'),
      status: CampaignStatus.fromWire(status),
      statusRaw: status,
      reason: CampaignChangeReason.fromWire(reason),
      reasonRaw: reason,
      dialing: j.boolean('dialing'),
      message: j.str('message'),
    );
  }

  final String campaignId;
  final CampaignStatus status;
  final String statusRaw;
  final CampaignChangeReason reason;
  final String reasonRaw;

  /// Whether the engine will produce further calls for this agent.
  final bool dialing;

  /// Fallback copy for a reason this build does not recognise.
  final String message;

  @override
  StationEvent get event => StationEvent.campaignState;

  @override
  bool operator ==(Object other) =>
      other is CampaignStateFrame &&
      other.campaignId == campaignId &&
      other.statusRaw == statusRaw &&
      other.reasonRaw == reasonRaw &&
      other.dialing == dialing &&
      other.message == message;

  @override
  int get hashCode => Object.hash(campaignId, statusRaw, reasonRaw, dialing, message);

  @override
  String toString() => 'CampaignStateFrame($campaignId, $statusRaw, $reasonRaw, dialing: $dialing)';
}

/// The answer to a `ping`. Clock offset is `serverTs - (ts + rtt / 2)`;
/// [serverTs] is stamped when the ping arrived.
///
/// Contract: `AgencyStationPongFrame`.
final class PongFrame extends StationFrame {
  const PongFrame({this.ts, required this.serverTs});

  factory PongFrame.fromJson(Map<String, Object?> j) =>
      PongFrame(ts: j.epochMsOrNull('ts'), serverTs: j.epochMs('server_ts'));

  /// The client's `ping.ts`, echoed (epoch ms).
  final int? ts;

  /// Server clock at the ping's arrival (epoch ms).
  final int serverTs;

  @override
  StationEvent get event => StationEvent.pong;

  @override
  bool operator ==(Object other) => other is PongFrame && other.ts == ts && other.serverTs == serverTs;

  @override
  int get hashCode => Object.hash(ts, serverTs);

  @override
  String toString() => 'PongFrame(ts: $ts, serverTs: $serverTs)';
}

/// A control frame was rejected. Never fatal; the socket stays open.
///
/// Contract: `AgencyStationErrorFrame`.
final class StationErrorFrame extends StationFrame {
  StationErrorFrame({required this.code, String? codeRaw, required this.message}) : codeRaw = codeRaw ?? code.wire;

  factory StationErrorFrame.fromJson(Map<String, Object?> j) {
    final code = j.str('code');
    return StationErrorFrame(code: StationErrorCode.fromWire(code), codeRaw: code, message: j.str('message'));
  }

  final StationErrorCode code;
  final String codeRaw;
  final String message;

  @override
  StationEvent get event => StationEvent.error;

  @override
  bool operator ==(Object other) => other is StationErrorFrame && other.codeRaw == codeRaw && other.message == message;

  @override
  int get hashCode => Object.hash(codeRaw, message);

  @override
  String toString() => 'StationErrorFrame($codeRaw, $message)';
}

/// Bridge-originated media-leg status, relayed unchanged. **Diagnostic only**:
/// `bridged` / `released` are the authoritative agency signals.
///
/// Contract: `AgencyStationBridgeStatusFrame`.
final class BridgeStatusFrame extends StationFrame {
  BridgeStatusFrame({required this.status, String? statusRaw}) : statusRaw = statusRaw ?? status.wire;

  factory BridgeStatusFrame.fromJson(Map<String, Object?> j) {
    final status = j.str('status');
    return BridgeStatusFrame(status: BridgeStatus.fromWire(status), statusRaw: status);
  }

  final BridgeStatus status;
  final String statusRaw;

  @override
  StationEvent get event => StationEvent.status;

  @override
  bool operator ==(Object other) => other is BridgeStatusFrame && other.statusRaw == statusRaw;

  @override
  int get hashCode => statusRaw.hashCode;

  @override
  String toString() => 'BridgeStatusFrame($statusRaw)';
}

/// Bridge-originated media teardown. Diagnostic only, like [BridgeStatusFrame].
///
/// Contract: `AgencyStationBridgeEndedFrame`.
final class BridgeEndedFrame extends StationFrame {
  const BridgeEndedFrame(this.reason);

  factory BridgeEndedFrame.fromJson(Map<String, Object?> j) => BridgeEndedFrame(j.str('reason'));

  /// Free text from the bridge.
  final String reason;

  @override
  StationEvent get event => StationEvent.ended;

  @override
  bool operator ==(Object other) => other is BridgeEndedFrame && other.reason == reason;

  @override
  int get hashCode => reason.hashCode;

  @override
  String toString() => 'BridgeEndedFrame($reason)';
}

/// Inbound audio under `media=pcm16`: base64 PCM16LE at 16 kHz.
///
/// Contract: `AgencyStationMediaFrame`.
final class MediaFrame extends StationFrame {
  const MediaFrame(this.payload);

  factory MediaFrame.fromJson(Map<String, Object?> j) => MediaFrame(j.obj('media').str('payload'));

  /// Base64. Decode with [decodePayload] only where the bytes are consumed.
  final String payload;

  Uint8List decodePayload() => base64.decode(payload);

  @override
  StationEvent get event => StationEvent.media;

  @override
  bool operator ==(Object other) => other is MediaFrame && other.payload == payload;

  @override
  int get hashCode => payload.hashCode;

  @override
  String toString() => 'MediaFrame(${payload.length} chars)';
}

/// Inbound audio under `media=alaw8`: one binary frame of raw G.711 A-law,
/// 8 kHz mono (160 bytes per 20 ms). Never JSON.
///
/// A hot audio path may skip this wrapper and hand the socket's bytes
/// straight to the player; it exists so a consumer's switch over
/// [StationFrame] can be exhaustive.
final class BinaryMediaFrame extends StationFrame {
  const BinaryMediaFrame(this.bytes);

  final Uint8List bytes;

  @override
  StationEvent get event => StationEvent.media;

  // Identity equality on purpose: comparing audio byte by byte is never what
  // a caller wants on this path.
  @override
  bool operator ==(Object other) => other is BinaryMediaFrame && identical(other.bytes, bytes);

  @override
  int get hashCode => identityHashCode(bytes);

  @override
  String toString() => 'BinaryMediaFrame(${bytes.length} bytes)';
}

/// A soft-phone call's state change: the whole `AgencyManualCall` row, sent on
/// every change and once more after a reconnect re-attaches an unsettled call.
///
/// The row is kept raw in [call] and decoded once, **tolerantly**, into
/// [manualCall]: a row this build cannot read gives a frame with a null
/// [manualCall] (which the station ignores), never an [UnknownFrame], so one
/// server-side field change cannot silence the soft phone's frames. The
/// lenient getters below read [call] directly for logs.
///
/// Contract: `AgencyStationManualCallFrame` (`agency/softphone.ts`).
final class ManualCallFrame extends StationFrame {
  ManualCallFrame(Map<String, Object?> call) : call = frozenMap(call), manualCall = ManualCall.tryFromJson(call);

  factory ManualCallFrame.fromJson(Map<String, Object?> j) => ManualCallFrame(j.obj('call'));

  /// The `AgencyManualCall` row, unchanged and unmodifiable.
  final Map<String, Object?> call;

  /// [call] decoded, or null when it does not read as a manual call.
  final ManualCall? manualCall;

  String? get id => _string('id');
  String? get sessionId => _string('session_id');
  String? get destinationE164 => _string('destination_e164');
  AttemptState get state => AttemptState.fromWire(_string('state'));
  bool get requiresDisposition => call['requires_disposition'] == true;
  DateTime? get bridgedAt {
    final v = _string('bridged_at');
    return v == null ? null : DateTime.tryParse(v)?.toUtc();
  }

  String? _string(String k) {
    final v = call[k];
    return v is String ? v : null;
  }

  @override
  StationEvent get event => StationEvent.manualCall;

  @override
  bool operator ==(Object other) => other is ManualCallFrame && jsonEquals(other.call, call);

  @override
  int get hashCode => jsonHash(call);

  @override
  String toString() => 'ManualCallFrame($id, ${call['state']})';
}

// ─── Payload types ──────────────────────────────────────────────────────────

/// The contact handed to the agent at reservation.
///
/// Contract: `AgencyReservedAttempt`.
@immutable
class ReservedAttempt {
  ReservedAttempt({
    required this.attemptId,
    required this.campaignId,
    required this.campaignName,
    required this.contactId,
    required this.phoneE164,
    required this.callerId,
    required this.attemptNumber,
    required Map<String, Object?> context,
    required List<PriorAttempt> priorAttempts,
    this.redial,
  }) : context = frozenMap(context),
       priorAttempts = List.unmodifiable(priorAttempts);

  factory ReservedAttempt.fromJson(Map<String, Object?> j) => ReservedAttempt(
    attemptId: j.str('attempt_id'),
    campaignId: j.str('campaign_id'),
    campaignName: j.str('campaign_name'),
    contactId: j.str('contact_id'),
    phoneE164: j.str('phone_e164'),
    callerId: j.str('caller_id'),
    attemptNumber: j.integer('attempt_number'),
    context: j.obj('context'),
    priorAttempts: j.list('prior_attempts', PriorAttempt.fromJson),
    redial: RedialInfo.tryFromJson(j['redial']),
  );

  final String attemptId;
  final String campaignId;
  final String campaignName;
  final String contactId;

  /// E.164, as dialled.
  final String phoneE164;

  /// The caller ID this attempt dials from.
  final String callerId;

  /// 1-based, per roster row; resets in every retry campaign.
  final int attemptNumber;

  /// Every non-phone CSV column, original headers as keys, in CSV order.
  /// Untrusted display text; render through `ContextDisplay.resolve`.
  final Map<String, Object?> context;

  /// Earlier dials of this person across the retry lineage, newest first.
  final List<PriorAttempt> priorAttempts;

  /// Set when this call is a wrap-up redial (`POST /sessions/:id/redial`);
  /// null on a call the pacing engine placed.
  final RedialInfo? redial;

  @override
  bool operator ==(Object other) =>
      other is ReservedAttempt &&
      other.runtimeType == runtimeType &&
      other.attemptId == attemptId &&
      other.campaignId == campaignId &&
      other.campaignName == campaignName &&
      other.contactId == contactId &&
      other.phoneE164 == phoneE164 &&
      other.callerId == callerId &&
      other.attemptNumber == attemptNumber &&
      jsonEquals(other.context, context) &&
      listEquals(other.priorAttempts, priorAttempts) &&
      other.redial == redial;

  @override
  int get hashCode => Object.hash(
    attemptId,
    campaignId,
    campaignName,
    contactId,
    phoneE164,
    callerId,
    attemptNumber,
    jsonHash(context),
    listHash(priorAttempts),
    redial,
  );
}

/// A wrap-up redial, as the reserved (or active) attempt carries it: the
/// attempt it redials, which redial this is, and how many are left after it.
///
/// Contract: `AgencyRedialInfo`.
@immutable
final class RedialInfo {
  const RedialInfo({required this.ofAttemptId, required this.number, required this.remaining});

  factory RedialInfo.fromJson(Map<String, Object?> j) =>
      RedialInfo(ofAttemptId: j.str('of_attempt_id'), number: j.integer('number'), remaining: j.integer('remaining'));

  /// [value] as a redial, or null when absent or unreadable. An optional
  /// add-on to the attempt: one this build cannot read must never cost the
  /// agent the call it rides on (the frame would be an [UnknownFrame]).
  static RedialInfo? tryFromJson(Object? value) {
    if (value is! Map<String, Object?>) return null;
    try {
      return RedialInfo.fromJson(value);
    } on FormatException {
      return null;
    }
  }

  /// The attempt this call redials (closed with the system code `redialed`).
  final String ofAttemptId;

  /// 1 for the first redial of a call, 2 for the second.
  final int number;

  /// Redials left after this one.
  final int remaining;

  /// How many redials the call allows in all: this one, those before it and
  /// those left ("Redial 1 of 2").
  int get limit => number + remaining;

  @override
  bool operator ==(Object other) =>
      other is RedialInfo && other.ofAttemptId == ofAttemptId && other.number == number && other.remaining == remaining;

  @override
  int get hashCode => Object.hash(ofAttemptId, number, remaining);

  @override
  String toString() => 'RedialInfo($number of ${number + remaining}, of: $ofAttemptId)';
}

/// An attempt a reconnecting socket found still live.
///
/// Contract: `AgencyActiveAttempt`.
final class ActiveAttempt extends ReservedAttempt {
  ActiveAttempt({
    required super.attemptId,
    required super.campaignId,
    required super.campaignName,
    required super.contactId,
    required super.phoneE164,
    required super.callerId,
    required super.attemptNumber,
    required super.context,
    required super.priorAttempts,
    super.redial,
    required this.bridgedAt,
    required this.state,
    String? stateRaw,
  }) : stateRaw = stateRaw ?? state.wire;

  factory ActiveAttempt.fromJson(Map<String, Object?> j) {
    final base = ReservedAttempt.fromJson(j);
    final state = j.str('state');
    return ActiveAttempt(
      attemptId: base.attemptId,
      campaignId: base.campaignId,
      campaignName: base.campaignName,
      contactId: base.contactId,
      phoneE164: base.phoneE164,
      callerId: base.callerId,
      attemptNumber: base.attemptNumber,
      context: base.context,
      priorAttempts: base.priorAttempts,
      redial: base.redial,
      bridgedAt: j.timeOrNull('bridged_at'),
      state: AttemptState.fromWire(state),
      stateRaw: state,
    );
  }

  /// Null while still pre-answer; set ⇒ the customer may already be speaking.
  final DateTime? bridgedAt;
  final AttemptState state;
  final String stateRaw;

  bool get isLive => bridgedAt != null;

  @override
  bool operator ==(Object other) =>
      super == other && other is ActiveAttempt && other.bridgedAt == bridgedAt && other.stateRaw == stateRaw;

  @override
  int get hashCode => Object.hash(super.hashCode, bridgedAt, stateRaw);
}

/// One earlier dial of the same person.
///
/// Contract: `AgencyPriorAttempt`. `dispositionCode` may come from a parent
/// campaign's catalog: fall back to the raw code beside [campaignName].
@immutable
final class PriorAttempt {
  PriorAttempt({
    required this.attemptNumber,
    this.outcome,
    String? outcomeRaw,
    this.dispositionCode,
    this.notes,
    this.endedAt,
    required this.campaignId,
    required this.campaignName,
    this.dialedAt,
  }) : outcomeRaw = outcomeRaw ?? outcome?.wire;

  factory PriorAttempt.fromJson(Map<String, Object?> j) {
    final outcome = j.strOrNull('outcome');
    return PriorAttempt(
      attemptNumber: j.integer('attempt_number'),
      outcome: outcome == null ? null : AttemptOutcome.fromWire(outcome),
      outcomeRaw: outcome,
      dispositionCode: j.strOrNull('disposition_code'),
      notes: j.strOrNull('notes'),
      endedAt: j.timeOrNull('ended_at'),
      campaignId: j.str('campaign_id'),
      campaignName: j.str('campaign_name'),
      dialedAt: j.timeOrNull('dialed_at'),
    );
  }

  final int attemptNumber;
  final AttemptOutcome? outcome;
  final String? outcomeRaw;
  final String? dispositionCode;
  final String? notes;
  final DateTime? endedAt;
  final String campaignId;
  final String campaignName;
  final DateTime? dialedAt;

  @override
  bool operator ==(Object other) =>
      other is PriorAttempt &&
      other.attemptNumber == attemptNumber &&
      other.outcomeRaw == outcomeRaw &&
      other.dispositionCode == dispositionCode &&
      other.notes == notes &&
      other.endedAt == endedAt &&
      other.campaignId == campaignId &&
      other.campaignName == campaignName &&
      other.dialedAt == dialedAt;

  @override
  int get hashCode =>
      Object.hash(attemptNumber, outcomeRaw, dispositionCode, notes, endedAt, campaignId, campaignName, dialedAt);
}

/// A `released` the socket was away for. History, not a live transition: do
/// not feed it through the live `released` handler.
///
/// Contract: `AgencyMissedRelease`.
@immutable
final class MissedRelease {
  MissedRelease({
    required this.attemptId,
    required this.reason,
    String? reasonRaw,
    required this.requiresDisposition,
    required this.message,
    required this.endedAt,
  }) : reasonRaw = reasonRaw ?? reason.wire;

  factory MissedRelease.fromJson(Map<String, Object?> j) {
    final reason = j.str('reason');
    return MissedRelease(
      attemptId: j.str('attempt_id'),
      reason: ReleaseReason.fromWire(reason),
      reasonRaw: reason,
      requiresDisposition: j.boolean('requires_disposition'),
      message: j.str('message'),
      endedAt: j.time('ended_at'),
    );
  }

  final String attemptId;
  final ReleaseReason reason;
  final String reasonRaw;
  final bool requiresDisposition;
  final String message;
  final DateTime endedAt;

  @override
  bool operator ==(Object other) =>
      other is MissedRelease &&
      other.attemptId == attemptId &&
      other.reasonRaw == reasonRaw &&
      other.requiresDisposition == requiresDisposition &&
      other.message == message &&
      other.endedAt == endedAt;

  @override
  int get hashCode => Object.hash(attemptId, reasonRaw, requiresDisposition, message, endedAt);
}

/// The whole of a wrap-up, as one value. The countdown is `endsAt - now`,
/// re-synced on every `wrapup` frame.
///
/// Contract: `AgencyWrapupState`.
@immutable
final class WrapupState {
  WrapupState({
    required this.attemptId,
    this.endsAt,
    required this.secondsTotal,
    required this.autoReturn,
    required this.requiresDisposition,
    required this.dispositionSubmitted,
    this.heldReason,
    String? heldReasonRaw,
    this.redialRemaining,
  }) : heldReasonRaw = heldReasonRaw ?? heldReason?.wire;

  factory WrapupState.fromJson(Map<String, Object?> j) {
    final held = j.strOrNull('held_reason');
    return WrapupState(
      attemptId: j.str('attempt_id'),
      endsAt: j.timeOrNull('ends_at'),
      secondsTotal: j.integer('seconds_total'),
      autoReturn: j.boolean('auto_return'),
      requiresDisposition: j.boolean('requires_disposition'),
      dispositionSubmitted: j.boolean('disposition_submitted'),
      heldReason: held == null ? null : WrapupHoldReason.fromWire(held),
      heldReasonRaw: held,
      redialRemaining: _redialRemaining(j),
    );
  }

  final String attemptId;

  /// When wrap-up returns the agent to the pool. **Null means no deadline**
  /// (auto-return off, or held): it ends when the agent acts. Never "expired".
  final DateTime? endsAt;

  /// The campaign's `wrapup_seconds`. Zero means no timer, not no wrap-up.
  final int secondsTotal;
  final bool autoReturn;
  final bool requiresDisposition;
  final bool dispositionSubmitted;

  /// Why an expired (or timerless) wrap-up did not return the agent. Null
  /// while it is simply running.
  final WrapupHoldReason? heldReason;
  final String? heldReasonRaw;

  /// Lenient, as [RedialInfo.tryFromJson]: an unreadable count reads as "not
  /// offered" rather than costing the agent the wrap-up frame.
  static int? _redialRemaining(Map<String, Object?> j) {
    try {
      final n = j.integerOrNull('redial_remaining');
      return n == null || n < 0 ? null : n;
    } on FormatException {
      return null;
    }
  }

  /// Wrap-up redial: how many more times the agent may redial this customer
  /// from this wrap-up. **Null: redial is not offered** (hide it); `0`: the
  /// limit is used up (show it disabled); more: offer it.
  final int? redialRemaining;

  @override
  bool operator ==(Object other) =>
      other is WrapupState &&
      other.attemptId == attemptId &&
      other.endsAt == endsAt &&
      other.secondsTotal == secondsTotal &&
      other.autoReturn == autoReturn &&
      other.requiresDisposition == requiresDisposition &&
      other.dispositionSubmitted == dispositionSubmitted &&
      other.heldReasonRaw == heldReasonRaw &&
      other.redialRemaining == redialRemaining;

  @override
  int get hashCode => Object.hash(
    attemptId,
    endsAt,
    secondsTotal,
    autoReturn,
    requiresDisposition,
    dispositionSubmitted,
    heldReasonRaw,
    redialRemaining,
  );
}

/// Timing the client must obey rather than hardcode.
///
/// Contract: `AgencyStationIntervals` (`agency/session.ts`; milliseconds on the
/// wire). [deferredHangup] is optional as in the console's reading
/// (`api/agency/agency.ts`), so a payload without it degrades to a default.
@immutable
final class StationIntervals {
  const StationIntervals({
    required this.heartbeat,
    required this.heartbeatGrace,
    required this.reservationLease,
    required this.countdown,
    this.deferredHangup,
  });

  factory StationIntervals.fromJson(Map<String, Object?> j) {
    final deferred = j.integerOrNull('deferred_hangup_ms');
    return StationIntervals(
      heartbeat: Duration(milliseconds: j.integer('heartbeat_ms')),
      heartbeatGrace: Duration(milliseconds: j.integer('heartbeat_grace_ms')),
      reservationLease: Duration(milliseconds: j.integer('reservation_lease_ms')),
      countdown: Duration(milliseconds: j.integer('countdown_ms')),
      deferredHangup: deferred == null ? null : Duration(milliseconds: deferred),
    );
  }

  /// How often to send `ping` (design: 10 s).
  final Duration heartbeat;

  /// Silence after which the server closes with 4408.
  final Duration heartbeatGrace;

  /// The `reserved` → dial lease. Informational.
  final Duration reservationLease;

  /// The auto-connect countdown before audio bridges.
  final Duration countdown;

  /// How long a live call is held for this session to reconnect.
  final Duration? deferredHangup;

  Map<String, Object?> toJson() {
    final json = <String, Object?>{
      'heartbeat_ms': heartbeat.inMilliseconds,
      'heartbeat_grace_ms': heartbeatGrace.inMilliseconds,
      'reservation_lease_ms': reservationLease.inMilliseconds,
      'countdown_ms': countdown.inMilliseconds,
    };
    putIfSet(json, 'deferred_hangup_ms', deferredHangup?.inMilliseconds);
    return json;
  }

  @override
  bool operator ==(Object other) =>
      other is StationIntervals &&
      other.heartbeat == heartbeat &&
      other.heartbeatGrace == heartbeatGrace &&
      other.reservationLease == reservationLease &&
      other.countdown == countdown &&
      other.deferredHangup == deferredHangup;

  @override
  int get hashCode => Object.hash(heartbeat, heartbeatGrace, reservationLease, countdown, deferredHangup);
}

// ─── Close codes ────────────────────────────────────────────────────────────

/// What the station socket's close code tells the client to do.
///
/// Contract: `AGENCY_STATION_CLOSE`. A code not listed here (or none) is an
/// ordinary drop: retry with a fresh token.
///
/// Three outcomes: [isTerminal] (stop: no retry on this socket's session or
/// upgrade), [boundsRetries] (retry, but give up after a few in a row), and
/// otherwise retry like any drop.
enum StationCloseCode {
  /// Token missing, expired, used or wrong. Re-mint and retry.
  tokenRejected(4401),

  /// Session unknown or left. Terminal: re-bootstrap, never retry this session.
  sessionGone(4404),

  /// No `ping` within the grace window. Re-mint and retry.
  heartbeatTimeout(4408),

  /// Another socket took over this session. Terminal: do not retry.
  superseded(4409),

  /// 1008: the upgrade itself was refused (an unknown `client=` or `media=`,
  /// or a bad session id; the close reason says which). Terminal: the same
  /// upgrade is refused again and a fresh token does not change it. This
  /// build sends something this server does not speak.
  invalidUpgrade(1008),

  /// 1011: the server could not run the station handler. Retryable, but
  /// [boundsRetries]: a server that is up and broken, not a network drop.
  internalError(1011);

  const StationCloseCode(this.code);
  final int code;

  static StationCloseCode? fromCode(int? code) => switch (code) {
    4401 => tokenRejected,
    4404 => sessionGone,
    4408 => heartbeatTimeout,
    4409 => superseded,
    1008 => invalidUpgrade,
    1011 => internalError,
    _ => null,
  };

  /// Whether to stop: no retry on this socket's session or upgrade.
  bool get isTerminal => this == sessionGone || this == superseded || this == invalidUpgrade;

  /// Whether a retry is in order but must be capped: give up after a few of
  /// these in a row rather than retrying forever.
  bool get boundsRetries => this == internalError;
}

// ─── Client frames ──────────────────────────────────────────────────────────

/// A frame the app sends on the station socket. Only `ping` and `media` are
/// read by the server (`hangup` is withdrawn: use the HTTP route).
///
/// Contract: `AgencyStationClientFrame`.
@immutable
sealed class StationClientFrame {
  const StationClientFrame();

  /// The frame's JSON text.
  String encode();

  Map<String, Object?> toJson();

  /// Reads a client frame back (tests, and logs of what was sent). Null when
  /// [text] is not a `ping` or `media` frame.
  static StationClientFrame? decode(String text) {
    try {
      final j = jsonDecode(text);
      if (j is! Map<String, Object?>) return null;
      return switch (j['event']) {
        'ping' => PingFrame(ts: j.epochMsOrNull('ts')),
        'media' => MediaClientFrame(j.obj('media').str('payload')),
        _ => null,
      };
    } on FormatException {
      return null;
    }
  }
}

/// Liveness: renews the agent's lease; the server echoes [ts] in `pong`.
///
/// Contract: `AgencyStationPingFrame`.
final class PingFrame extends StationClientFrame {
  const PingFrame({this.ts});

  /// Client clock, epoch ms.
  final int? ts;

  /// The ping's text without building a frame object or a map.
  static String encodeTs(int? ts) => ts == null ? '{"event":"ping"}' : '{"event":"ping","ts":$ts}';

  @override
  String encode() => encodeTs(ts);

  @override
  Map<String, Object?> toJson() => <String, Object?>{'event': 'ping', if (ts != null) 'ts': ts};

  @override
  bool operator ==(Object other) => other is PingFrame && other.ts == ts;

  @override
  int get hashCode => ts.hashCode;
}

/// Outbound audio under `media=pcm16`: base64 PCM16LE at 16 kHz. Under
/// `media=alaw8` audio goes as binary frames instead and never as this.
///
/// Contract: `AgencyStationMediaFrame`.
final class MediaClientFrame extends StationClientFrame {
  const MediaClientFrame(this.payload);

  /// Base64 of one PCM16LE frame.
  final String payload;

  /// The frame's text from an already-encoded payload: one string, no map.
  /// Base64 needs no JSON escaping, so it is interpolated as is.
  static String encodePayload(String base64Payload) => '{"event":"media","media":{"payload":"$base64Payload"}}';

  /// The frame's text from raw PCM16LE bytes.
  static String encodePcm(Uint8List pcm) => encodePayload(base64.encode(pcm));

  @override
  String encode() => encodePayload(payload);

  @override
  Map<String, Object?> toJson() => <String, Object?>{
    'event': 'media',
    'media': <String, Object?>{'payload': payload},
  };

  @override
  bool operator ==(Object other) => other is MediaClientFrame && other.payload == payload;

  @override
  int get hashCode => payload.hashCode;
}

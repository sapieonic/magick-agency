import 'package:agency_wire/agency_wire.dart';

import '../station/contact_context.dart';
import '../station/server_clock.dart';
import '../station/station_view.dart' show StationLink;
import 'call_labels.dart';
import 'softphone_view.dart';

/// The soft phone's call, as the screens read it (a port of the console's
/// `utils/softphone/callState.ts`).
///
/// ── One row, replaced whole ──────────────────────────────────────────────────
/// Every state change of a manual call arrives as a `manual_call` frame carrying
/// the WHOLE row, and the HTTP answers to `POST /calls`, `PATCH`, the hang-up and
/// the outcome carry the same row. So there is nothing to patch: the app holds the
/// newest copy it has seen from any source, and [newerCall] is the one rule for
/// "newest". The frame is the authority (on a tie it wins), because the HTTP
/// answer to a hang-up is read the instant the hang-up is issued and may still
/// say `ringing`.
///
/// Used by the session host (the merge, the audio target, the signals) and by
/// the soft-phone controller (the phase, the rail), so both read a call alike.

/// Whether [call] still holds the session: live, or ended and owing its outcome.
bool isCallUnsettled(ManualCall? call) => call != null && call.isUnsettled;

/// Whether [call] is still on the line (not settled, not `ended`).
bool isCallLive(ManualCall? call) => call != null && call.isLive;

/// Which of the rail's five states [call] puts the soft phone in.
///
/// `answered` reads as On call: the customer picked up, and the agent's leg
/// was up before the customer was dialled, so audio follows within a beat. The
/// talk timer still waits for `bridged_at`. A state this build does not know
/// reads as On call while unsettled: the call is on the line in some form, and
/// showing the pad would invite a second dial the server refuses anyway.
SoftphonePhase softphonePhase(ManualCall? call) {
  if (call == null || call.settledAt != null) return SoftphonePhase.ready;
  return switch (call.state) {
    AttemptState.queued || AttemptState.dialing => SoftphonePhase.dialing,
    AttemptState.ringing => SoftphonePhase.ringing,
    AttemptState.answered || AttemptState.bridged => SoftphonePhase.onCall,
    AttemptState.ended => call.requiresDisposition ? SoftphonePhase.outcome : SoftphonePhase.ready,
    AttemptState.unknown => SoftphonePhase.onCall,
  };
}

/// The newer of two copies of "the session's call".
///
/// Different calls: the later `created_at` (a new dial always wins over the one
/// before it; on a tie [a] stays). The same call: the later `updated_at`; on a
/// tie [a] wins, so pass the frame's copy first. A settled copy also beats an
/// unsettled one of the same call with an equal stamp: settling is the one
/// transition that never reverses.
ManualCall? newerCall(ManualCall? a, ManualCall? b) {
  if (a == null) return b;
  if (b == null) return a;
  if (a.id != b.id) return b.createdAt.isAfter(a.createdAt) ? b : a;
  if (b.updatedAt.isAfter(a.updatedAt)) return b;
  if (b.updatedAt == a.updatedAt && b.settledAt != null && a.settledAt == null) return b;
  return a;
}

/// The end of a call, said plainly: the station's release copy is about the
/// pool, this is about one dial (the console's `MANUAL_END_REASON_COPY`).
const Map<ManualCallEndReason, String> manualEndReasonCopy = {
  ManualCallEndReason.completed: 'The call ended.',
  ManualCallEndReason.noAnswer: 'No answer.',
  ManualCallEndReason.busy: 'The line was busy.',
  ManualCallEndReason.failed: 'The call didn’t go through.',
  ManualCallEndReason.invalid: 'That number can’t be called.',
  ManualCallEndReason.agentDisconnected: 'Your connection dropped and the call ended.',
  ManualCallEndReason.agentHangup: 'You hung up.',
  ManualCallEndReason.remoteHangup: 'The customer hung up.',
  ManualCallEndReason.supervisorReleased: 'A supervisor ended the call.',
  ManualCallEndReason.orphaned: 'Something went wrong on our side and the call was cleaned up.',
};

/// One line for how a call finished: the end reason when known, else the
/// telephony outcome.
String callEndSummary(ManualCall call) {
  final reason = call.endReason;
  if (reason != null) return manualEndReasonCopy[reason] ?? manualLineOutcomeLabel(call);
  return call.outcomeRaw != null ? '${manualLineOutcomeLabel(call)}.' : 'The call ended.';
}

final _nameLike = RegExp(r'(^|[\s_-])(full[\s_-]?)?name$|^name$|customer|contact[\s_-]?name', caseSensitive: false);

/// The matched contact's name, for "On call with Rahul Verma": read through
/// the tag's `context_display` and the same hero resolution the station's
/// contact panel uses, then the first non-empty hero (or field) whose header
/// looks like a name. Never the first column of an arbitrary roster, which is
/// as likely to be a loan number as a person.
String? contactName(ManualCall? call, ContextDisplay? display) {
  final context = call?.contact?.context;
  if (context == null) return null;
  final resolved = resolveContextFields(context, display);
  for (final field in [...resolved.hero, ...resolved.fields]) {
    if (!field.isEmpty && _nameLike.hasMatch(field.label)) return field.value;
  }
  return null;
}

/// The soft phone's rail, as a pure function of the connection and the call
/// (the console's `describeSoftphoneRail`, with "plays in your browser" as
/// "plays on your phone" and the reload / window sentences in the app's terms).
///
/// Connection failures outrank the call: an agent whose socket is gone must
/// not be told they are ready to dial, and an agent mid-call must be told
/// whether the customer can hear them. [offsetMs] maps the call's server
/// instants onto this device's clock for [SoftphoneRail.timerFrom].
SoftphoneRail describeSoftphoneRail({
  required StationLink link,
  required ManualCall? call,
  ManualCall? lastCall,
  bool fromCampaign = false,
  String? contactName,
  int offsetMs = 0,
}) {
  final phase = softphonePhase(call);
  final live = phase == SoftphonePhase.dialing || phase == SoftphonePhase.ringing || phase == SoftphonePhase.onCall;

  switch (link) {
    case StationLink.superseded:
      return const SoftphoneRail(
        tone: SoftphoneRailTone.danger,
        label: 'Your soft phone moved to another device',
        detail: 'You opened it somewhere else. Only one place can make calls.',
      );
    case StationLink.sessionGone:
      return const SoftphoneRail(
        tone: SoftphoneRailTone.danger,
        label: 'Session ended',
        detail: 'Open the soft phone again to make calls.',
      );
    case StationLink.disconnected:
      return live
          ? const SoftphoneRail(
              tone: SoftphoneRailTone.danger,
              label: 'Connection lost',
              detail: 'The customer can’t hear you right now. Reconnect to get back on the call.',
            )
          : const SoftphoneRail(tone: SoftphoneRailTone.danger, label: 'Disconnected', detail: 'Reconnect to make calls.');
    case StationLink.reconnecting:
      return SoftphoneRail(
        tone: SoftphoneRailTone.warning,
        label: 'Reconnecting',
        detail: live ? 'Stay on the line — we’re reconnecting you.' : 'Calls are paused until your phone reconnects.',
      );
    case StationLink.connecting:
    case StationLink.open:
      break;
  }

  final number = call == null ? '' : formatDialNumber(call.destinationE164);
  final from = call == null ? '' : 'from ${formatDialNumber(call.callerId)}';
  DateTime? device(DateTime? serverInstant) => correctedInstant(serverInstant, offsetMs);

  switch (phase) {
    case SoftphonePhase.dialing:
      return SoftphoneRail(
        tone: SoftphoneRailTone.warning,
        label: 'Dialing $number',
        detail: '${_capitalise(from)} · connecting your line first',
        timerFrom: device(call?.dialedAt),
      );
    case SoftphonePhase.ringing:
      return SoftphoneRail(
        tone: SoftphoneRailTone.warning,
        label: 'Ringing $number',
        detail: '${_capitalise(from)} · the ringback tone plays on your phone',
        timerFrom: device(call?.dialedAt),
      );
    case SoftphonePhase.onCall:
      final bridged = call?.bridgedAt;
      return SoftphoneRail(
        tone: SoftphoneRailTone.success,
        label: contactName != null ? 'On call with $contactName' : 'On call',
        detail: bridged != null ? '$number · $from' : '$number · connecting audio…',
        timerFrom: device(bridged),
      );
    case SoftphonePhase.outcome:
      return SoftphoneRail(
        tone: SoftphoneRailTone.warning,
        label: 'Outcome needed',
        detail:
            '${call == null ? 'The call ended.' : callEndSummary(call)} Pick an outcome and save it — the next call unlocks when you do.',
        timerFrom: device(call?.endedAt),
      );
    case SoftphonePhase.ready:
      if (link != StationLink.open) return SoftphoneRail.connecting;
      final last = lastCall != null && lastCall.id != call?.id ? lastCall : call;
      final lastLine = last != null && last.state == AttemptState.ended && !last.requiresDisposition
          ? 'Last call to ${formatDialNumber(last.destinationE164)}: ${callEndSummary(last)} '
          : '';
      return SoftphoneRail(
        tone: SoftphoneRailTone.info,
        label: 'Ready to dial',
        detail: fromCampaign
            ? '${lastLine}Type a number or redial a recent call. Soft-phone calls are not paced, and the campaign\'s dialer does not reserve you here.'
            : '${lastLine}Type a number or redial a recent call.',
      );
  }
}

String _capitalise(String text) => text.isEmpty ? text : text[0].toUpperCase() + text.substring(1);

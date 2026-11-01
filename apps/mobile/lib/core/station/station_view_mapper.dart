import 'package:agency_wire/agency_wire.dart' as wire;

import 'contact_context.dart';
import 'server_clock.dart';
import 'station_copy.dart';
import 'station_signals.dart';
import 'station_state.dart';
import 'station_view.dart';

/// Derives the [StationView] the screens render from the core's state.
///
/// Memoised slice by slice: a slice whose inputs are the same objects as last
/// time is returned as the SAME instance, so `select` on it never rebuilds a
/// widget, and the `==` that filters provider updates short-circuits. The
/// contact panel in particular (regex heuristics over every roster column) is
/// built once per call, not once per heartbeat.
///
/// Every server time is mapped to this device's clock. The offset is applied
/// with a little hysteresis ([offsetStep]): the median moves by a few ms on
/// most pongs, and re-anchoring every timer on screen for that is churn.
class StationViewMapper {
  static const offsetStep = 200;

  int _offset = 0;

  // call
  Object? _callAttempt;
  DateTime? _callBridgedAt;
  int? _callCountdown;
  int _callOffset = 0;
  List<wire.Disposition>? _callCatalog;
  wire.ContextDisplay? _callDisplay;
  bool _callRecording = false;
  CallView? _call;

  // lists
  List<wire.BreakReason>? _breakSource;
  List<BreakOption> _breakOptions = const [];
  List<wire.Disposition>? _dispositionSource;
  List<DispositionOption> _dispositions = const [];

  // release / missed / wrapup
  wire.ReleasedFrame? _releaseSource;
  ReleaseView? _release;
  wire.MissedRelease? _missedSource;
  MissedReleaseView? _missed;
  WrapupAnchor? _wrapupSource;
  bool _wrapupSaved = false;
  WrapupView? _wrapup;

  /// The offset the view applies now.
  int get appliedOffsetMs => _offset;

  StationView map({
    required String campaignId,
    required String campaignName,
    required String? sessionId,
    required StationState s,
    required wire.SessionBootstrap? bootstrap,
    required List<wire.Disposition> catalog,
    required List<wire.BreakReason> breakReasons,
    required String? pendingBreakCode,
    required AudioView audio,
    required NotesView notes,
    required StationBusy busy,
    required String? actionError,
    required String? fatal,
    required String? dispositionSavedCode,
    required ({String attemptId, int seconds})? countdown,
    required DateTime? reconnectDeadline,
    required Duration? reconnectWindow,
    required String? dncOutcome,
    required bool missedReleaseDismissed,
    required bool awayPauseRequested,
  }) {
    if ((s.clockOffsetMs - _offset).abs() >= offsetStep) _offset = s.clockOffsetMs;
    final phase = phaseOf(s.agentState);
    final link = linkOf(s.connection);
    final phaseSince = correctedInstant(s.agentStateSince, _offset);

    BreakInfo? onBreak;
    if (phase == AgentPhase.onBreak) {
      // `ready` cannot say why the agent is on break; a pause this app asked
      // for while away is the honest reading until a frame says otherwise.
      final code = s.breakReasonCode ?? (awayPauseRequested ? wire.ReservedBreakCode.deviceAway.wire : '');
      onBreak = BreakInfo(code: code, label: breakLabel(code, breakReasons), since: phaseSince);
    }
    final queued = pendingBreakCode == null
        ? null
        : BreakInfo(code: pendingBreakCode, label: breakLabel(pendingBreakCode, breakReasons));

    return StationView(
      campaignId: campaignId,
      campaignName: bootstrap?.campaignName ?? campaignName,
      sessionId: sessionId,
      link: link,
      phase: phase,
      phaseSince: phaseSince,
      campaignDialing: s.dialing,
      campaignMessage: s.campaignMessage,
      onBreak: onBreak,
      queuedBreak: queued,
      breakOptions: _breakOptionsFor(breakReasons),
      call: _callFor(s, bootstrap, catalog, countdown),
      release: _releaseFor(s.release),
      wrapup: _wrapupFor(s.wrapup, dispositionSavedCode != null),
      dispositions: _dispositionsFor(catalog),
      dispositionSaved: dispositionSavedCode,
      notes: notes,
      audio: audio,
      missedRelease: missedReleaseDismissed ? null : _missedFor(s.missedRelease),
      reconnectDeadline: reconnectDeadline,
      reconnectWindow: reconnectDeadline == null ? null : reconnectWindow,
      dncOutcome: dncOutcome,
      weakConnection: link == StationLink.open && s.missedPings >= 2,
      busy: busy,
      actionError: actionError,
      fatal: fatal,
    );
  }

  static AgentPhase phaseOf(wire.AgentState state) => switch (state) {
        wire.AgentState.available => AgentPhase.available,
        wire.AgentState.reserved => AgentPhase.reserved,
        wire.AgentState.onCall => AgentPhase.onCall,
        wire.AgentState.wrapup => AgentPhase.wrapup,
        wire.AgentState.onBreak => AgentPhase.onBreak,
        wire.AgentState.offline || wire.AgentState.unknown => AgentPhase.offline,
      };

  static StationLink linkOf(StationConnection c) => switch (c) {
        StationConnection.idle || StationConnection.connecting => StationLink.connecting,
        StationConnection.open => StationLink.open,
        StationConnection.reconnecting => StationLink.reconnecting,
        StationConnection.disconnected => StationLink.disconnected,
        StationConnection.superseded => StationLink.superseded,
        StationConnection.sessionGone => StationLink.sessionGone,
      };

  /// Words for a break code: the campaign's label, the reserved codes' own,
  /// readable words for a code the catalog lost, never the raw code.
  static String breakLabel(String code, List<wire.BreakReason> reasons) {
    if (code == wire.ReservedBreakCode.deviceAway.wire) return deviceAwayBreakLabel;
    if (code == wire.ReservedBreakCode.softPhone.wire) return softPhoneBreakLabel;
    if (code.isEmpty) return agentStateLabels[wire.AgentState.onBreak]!;
    for (final r in reasons) {
      if (r.code == code) return r.label;
    }
    return humaniseCode(code);
  }

  List<BreakOption> _breakOptionsFor(List<wire.BreakReason> reasons) {
    if (identical(reasons, _breakSource)) return _breakOptions;
    _breakSource = reasons;
    return _breakOptions = List.unmodifiable(reasons.map((r) => BreakOption(code: r.code, label: r.label)));
  }

  List<DispositionOption> _dispositionsFor(List<wire.Disposition> catalog) {
    if (identical(catalog, _dispositionSource)) return _dispositions;
    _dispositionSource = catalog;
    return _dispositions = List.unmodifiable(catalog.map(
      (d) => DispositionOption(
        code: d.code,
        label: d.label,
        requiresNote: d.noteRequired,
        requiresCallbackTime: d.datetimeRequired,
        isSuccess: d.isSuccess ?? false,
        suppresses: d.suppress ?? false,
      ),
    ));
  }

  CallView? _callFor(
    StationState s,
    wire.SessionBootstrap? bootstrap,
    List<wire.Disposition> catalog,
    ({String attemptId, int seconds})? countdown,
  ) {
    final wire.ReservedAttempt? attempt = s.live?.attempt ?? s.retainedAttempt;
    if (attempt == null) {
      _callAttempt = null;
      return _call = null;
    }
    final bridgedAt = s.live?.bridgedAt;
    final seconds = countdown != null && countdown.attemptId == attempt.attemptId && bridgedAt == null
        ? countdown.seconds
        : null;
    final display = bootstrap?.contextDisplay;
    final recording = bootstrap?.recordCalls ?? false;
    if (_call != null &&
        identical(attempt, _callAttempt) &&
        bridgedAt == _callBridgedAt &&
        seconds == _callCountdown &&
        _offset == _callOffset &&
        identical(catalog, _callCatalog) &&
        identical(display, _callDisplay) &&
        recording == _callRecording) {
      return _call;
    }
    final sameAttempt = identical(attempt, _callAttempt) && identical(display, _callDisplay) && _call != null;
    _callAttempt = attempt;
    _callBridgedAt = bridgedAt;
    _callCountdown = seconds;
    _callCatalog = catalog;
    _callDisplay = display;
    _callRecording = recording;

    // Only the timer-ish fields moved: keep the resolved contact as it is.
    final previous = _call;
    if (sameAttempt && previous != null && _offset == _callOffset) {
      return _call = CallView(
        attemptId: previous.attemptId,
        phoneE164: previous.phoneE164,
        attemptNumber: previous.attemptNumber,
        callerId: previous.callerId,
        campaignName: previous.campaignName,
        displayName: previous.displayName,
        heroFields: previous.heroFields,
        heroesConfigured: previous.heroesConfigured,
        otherFields: previous.otherFields,
        priorAttempts: previous.priorAttempts,
        countdownSeconds: seconds,
        bridgedAt: correctedInstant(bridgedAt, _offset),
        recording: recording,
      );
    }
    _callOffset = _offset;

    final resolved = resolveContextFields(attempt.context, display);
    ContactField field(ResolvedField f) => ContactField(key: f.label, label: f.label, value: f.isEmpty ? '' : f.value);
    return _call = CallView(
      attemptId: attempt.attemptId,
      phoneE164: attempt.phoneE164,
      attemptNumber: attempt.attemptNumber,
      callerId: attempt.callerId,
      campaignName: attempt.campaignName,
      displayName: displayNameFor(attempt.context, display, heroKeys: [for (final h in resolved.hero) h.label]),
      heroFields: List.unmodifiable(resolved.hero.map(field)),
      heroesConfigured: heroesWereConfigured(display),
      otherFields: List.unmodifiable([...resolved.fields.map(field), ...resolved.empty.map(field)]),
      priorAttempts: priorAttemptsFor(
        attempt.priorAttempts,
        campaignId: bootstrap?.campaignId ?? attempt.campaignId,
        catalog: catalog,
        offsetMs: _offset,
      ),
      countdownSeconds: seconds,
      bridgedAt: correctedInstant(bridgedAt, _offset),
      recording: recording,
    );
  }

  ReleaseView? _releaseFor(wire.ReleasedFrame? frame) {
    if (identical(frame, _releaseSource)) return _release;
    _releaseSource = frame;
    if (frame == null) return _release = null;
    final copy = releaseCopy(frame.reason, frame.message);
    return _release = ReleaseView(
      headline: copy.headline,
      detail: copy.subtext,
      tone: copy.tone,
      requiresDisposition: frame.requiresDisposition,
    );
  }

  MissedReleaseView? _missedFor(wire.MissedRelease? missed) {
    if (identical(missed, _missedSource)) return _missed;
    _missedSource = missed;
    if (missed == null) return _missed = null;
    final copy = releaseCopy(missed.reason, missed.message);
    return _missed = MissedReleaseView(headline: '$missedReleasePrefix: ${copy.headline}', detail: copy.subtext);
  }

  WrapupView? _wrapupFor(WrapupAnchor? anchor, bool savedHere) {
    if (identical(anchor, _wrapupSource) && savedHere == _wrapupSaved) return _wrapup;
    _wrapupSource = anchor;
    _wrapupSaved = savedHere;
    if (anchor == null) return _wrapup = null;
    return _wrapup = WrapupView(
      endsAt: anchor.deadline,
      secondsTotal: anchor.secondsTotal,
      hold: switch (anchor.heldReason) {
        wire.WrapupHoldReason.supervisorHold => WrapupHold.supervisor,
        wire.WrapupHoldReason.dispositionRequired => WrapupHold.dispositionRequired,
        _ => WrapupHold.none,
      },
      dispositionSubmitted: anchor.dispositionSubmitted || savedHere,
      autoReturn: anchor.autoReturn,
    );
  }
}

/// The shell's facts, from the view. A session the server ended (4404) or
/// another device took (4409) holds nothing here: no duty and no call, even
/// when the last phase seen was mid-call (the call moved with the session).
/// The station screen still shows why; the tab bar, sign-out and account
/// switch are free again.
StationSignals signalsOf(StationView? view) {
  if (view == null || view.link == StationLink.sessionGone || view.link == StationLink.superseded) {
    return const StationSignals();
  }
  return StationSignals(
    onDuty: true,
    callActive: view.callActive,
    onBreak: view.phase == AgentPhase.onBreak,
    campaignId: view.campaignId,
  );
}

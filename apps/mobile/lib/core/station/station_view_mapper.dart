import 'package:agency_wire/agency_wire.dart' as wire;

import '../inbound/inbound_call_rules.dart';
import '../inbound/inbound_copy.dart';
import '../lifecycle/lifecycle_policy.dart' show isCallPhase;

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
  ({int? remaining})? _wrapupRedial;
  bool _wrapupRedialPlaced = false;
  WrapupView? _wrapup;

  // inbound
  wire.InboundCall? _inboundSource;
  int _inboundOffset = 0;
  String? _inboundFailure;
  InboundCallView? _inbound;
  wire.CustomerWaitingFrame? _waitingSource;
  int _waitingOffset = 0;
  CustomerWaitingView? _waiting;

  // queue
  wire.QueueState? _queueSource;
  int _queueOffset = 0;
  QueueView? _queue;

  /// The offset the view applies now.
  int get appliedOffsetMs => _offset;

  /// Moves the applied offset to [offsetMs] when it has moved by
  /// [offsetStep] or more, and returns the offset applied. [map] does this
  /// itself; a soft-phone session, which has no campaign view, calls it alone
  /// so its timers get the same hysteresis.
  int applyOffset(int offsetMs) {
    if ((offsetMs - _offset).abs() >= offsetStep) _offset = offsetMs;
    return _offset;
  }

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
    ({int? remaining})? redialOverride,
    bool redialPlaced = false,
    String? inboundHangupFailure,
    String? inboundNotice,
    bool awayRang = false,
    String? awayNoRing,
  }) {
    applyOffset(s.clockOffsetMs);
    // The call decides ahead of `agent_state` (`StationState.effectiveState`).
    final shown = s.effectiveState;
    final phase = phaseOf(shown);
    final link = linkOf(s.connection);
    // `since` dates the state `agent_state` stated, not one the call implies.
    final phaseSince = shown == s.agentState ? correctedInstant(s.agentStateSince, _offset) : null;

    BreakInfo? onBreak;
    if (phase == AgentPhase.onBreak) {
      // The server's reason first (it survives the app being killed). Only
      // when it sent none (a server older than the field) is a pause this app
      // asked for while away the honest reading.
      final code = s.breakReasonCode ?? (awayPauseRequested ? wire.ReservedBreakCode.deviceAway.wire : '');
      // Back from the app's own `away_ring`: the server reports `device_away`, but the phone was
      // ringing for inbound calls while the agent was away, and the card says so.
      final rang = awayRang && code == wire.ReservedBreakCode.deviceAway.wire;
      onBreak = BreakInfo(
        code: code,
        label: rang ? awayRingBreakLabel : breakLabel(code, breakReasons),
        since: phaseSince,
        rang: rang,
        // Paused rather than rung, though ringing is on for this phone: why it won't ring.
        noRing: !rang && code == wire.ReservedBreakCode.deviceAway.wire ? awayNoRing : null,
      );
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
      wrapup: _wrapupFor(s.wrapup, dispositionSavedCode != null, redialOverride, redialPlaced),
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
      queue: _queueFor(s.queue),
      myContactsOffered: myContactsOfferedBy(bootstrap),
      inbound: _inboundFor(s.inboundOnScreen, inboundHangupFailure),
      customerWaiting: _waitingFor(s.customerWaiting),
      inboundNotice: inboundNotice,
    );
  }

  /// The inbound caller on the station, read once per copy of the call (a frame is a new copy;
  /// a pong is not).
  InboundCallView? _inboundFor(wire.InboundCall? call, String? hangupFailure) {
    if (identical(call, _inboundSource) && _offset == _inboundOffset && hangupFailure == _inboundFailure) {
      return _inbound;
    }
    // The offset the copy on screen was mapped with.
    final previousOffset = _inboundOffset;
    _inboundSource = call;
    _inboundOffset = _offset;
    _inboundFailure = hangupFailure;
    if (call == null) return _inbound = null;
    final stage = switch (inboundPhase(call)) {
      InboundPhase.offered => InboundStage.offered,
      InboundPhase.connected => InboundStage.connected,
      InboundPhase.outcome || null => InboundStage.outcome,
    };
    final match = call.match;
    final display = match?.contextDisplay;
    final resolved = match == null ? null : resolveContextFields(match.context, display);
    ContactField field(ResolvedField f) => ContactField(key: f.label, label: f.label, value: f.isEmpty ? '' : f.value);
    final previous = _inbound;
    // The contact is resolved once per call: later frames of the same call move only its state.
    final same = previous != null && previous.callId == call.id && match != null && previous.matched;
    // The prior attempts' times are mapped with the clock offset: a new offset maps them again.
    final sameTimes = same && previousOffset == _offset;
    return _inbound = InboundCallView(
      callId: call.id,
      stage: stage,
      fromE164: call.fromE164,
      toE164: call.toE164,
      routeName: call.route?.name,
      displayName: same
          ? previous.displayName
          : (match == null
              ? null
              : displayNameFor(match.context, display, heroKeys: [for (final h in resolved!.hero) h.label])),
      sticky: switch (call.sticky?.reason) {
        null => null,
        wire.InboundStickyReason.owner => InboundSticky.owner,
        wire.InboundStickyReason.lastFromNumber => InboundSticky.lastFromNumber,
        wire.InboundStickyReason.lastConnected => InboundSticky.lastConnected,
        wire.InboundStickyReason.lastDialled => InboundSticky.lastDialled,
        wire.InboundStickyReason.unknown => InboundSticky.other,
      },
      stickyIsYou: call.sticky?.isYou ?? false,
      callerDnc: call.callerDnc,
      recording: call.recording,
      waitedSeconds: call.waitedSeconds,
      campaignName: match?.campaignName,
      contactState: match == null ? null : (inboundContactStateLabels[match.contactState] ?? humaniseCode(match.contactStateRaw)),
      heroFields: same ? previous.heroFields : (resolved == null ? const [] : List.unmodifiable(resolved.hero.map(field))),
      heroesConfigured: heroesWereConfigured(display),
      otherFields: same
          ? previous.otherFields
          : (resolved == null ? const [] : List.unmodifiable([...resolved.fields.map(field), ...resolved.empty.map(field)])),
      priorAttempts: sameTimes
          ? previous.priorAttempts
          : (match == null
              ? const []
              : priorAttemptsFor(
                  match.priorAttempts,
                  campaignId: match.campaignId,
                  catalog: call.catalogSource == wire.InboundCatalogSource.campaign ? call.dispositionCatalog : const [],
                  offsetMs: _offset,
                )),
      catalogKind: switch (call.catalogSource) {
        wire.InboundCatalogSource.campaign => InboundCatalogKind.campaign,
        wire.InboundCatalogSource.route => InboundCatalogKind.route,
        wire.InboundCatalogSource.builtin || wire.InboundCatalogSource.unknown => InboundCatalogKind.standard,
      },
      connectsAt: stage == InboundStage.offered ? correctedInstant(call.connectsAt, _offset) : null,
      bridgedAt: correctedInstant(call.bridgedAt, _offset),
      outcomeDueAt: stage == InboundStage.outcome ? correctedInstant(call.outcomeDueAt, _offset) : null,
      hangupFailure: stage == InboundStage.connected ? hangupFailure : null,
    );
  }

  CustomerWaitingView? _waitingFor(wire.CustomerWaitingFrame? frame) {
    if (identical(frame, _waitingSource) && _offset == _waitingOffset) return _waiting;
    _waitingSource = frame;
    _waitingOffset = _offset;
    if (frame == null) return _waiting = null;
    final name = frame.matchName?.trim();
    return _waiting = CustomerWaitingView(
      callId: frame.inboundCallId,
      since: correctedInstant(frame.waitingSince, _offset)!,
      name: name == null || name.isEmpty ? null : name,
      fromE164: frame.fromE164,
    );
  }

  /// The console's rule (`AgentConsolePage`): a mode that is not `pool` (an
  /// unknown one included; an absent one reads `pool`), or agent retry on.
  static bool myContactsOfferedBy(wire.SessionBootstrap? bootstrap) =>
      bootstrap != null &&
      (bootstrap.assignmentModeRaw != wire.AssignmentMode.pool.wire || bootstrap.allowAgentRetry);

  /// The agent's own queue, its next time on this device's clock.
  QueueView? _queueFor(wire.QueueState? queue) {
    if (identical(queue, _queueSource) && _offset == _queueOffset) return _queue;
    _queueSource = queue;
    _queueOffset = _offset;
    if (queue == null) return _queue = null;
    return _queue = QueueView(
      due: queue.due,
      reason: queue.due ? null : queueIdleOf(queue.reason),
      nextDueAt: correctedInstant(queue.nextDueAt, _offset),
    );
  }

  /// The view's words for a wire reason; a reason this build does not know
  /// (or none, while nothing is due) is [QueueIdle.other].
  static QueueIdle queueIdleOf(wire.QueueIdleReason? reason) => switch (reason) {
        wire.QueueIdleReason.queueEmpty => QueueIdle.queueEmpty,
        wire.QueueIdleReason.waitingForRetry => QueueIdle.waitingForRetry,
        wire.QueueIdleReason.callbacksLater => QueueIdle.callbacksLater,
        wire.QueueIdleReason.outsideCallingHours => QueueIdle.outsideCallingHours,
        wire.QueueIdleReason.unknown || null => QueueIdle.other,
      };

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
    if (code == wire.ReservedBreakCode.awayRing.wire) return awayRingBreakLabel;
    if (code == wire.ReservedBreakCode.softPhone.wire) return softPhoneBreakLabel;
    if (code == wire.ReservedBreakCode.phoneCall.wire) return phoneCallBreakLabel;
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
        redialNumber: previous.redialNumber,
        redialLimit: previous.redialLimit,
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
      redialNumber: attempt.redial?.number,
      redialLimit: attempt.redial?.limit,
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

  /// [redial]: what a refused redial taught the core about this wrap-up's
  /// redials (used up, or not offered after all), until the next frame states
  /// them. Null: the anchor's own count.
  ///
  /// [redialPlaced]: a redial was placed from this wrap-up and its call is on
  /// its way. The server stopped the wrap-up's clock when it took it, so none
  /// is shown (no digits, no bar, no holding line), never one draining to 0.
  WrapupView? _wrapupFor(WrapupAnchor? anchor, bool savedHere, ({int? remaining})? redial, bool redialPlaced) {
    if (identical(anchor, _wrapupSource) &&
        savedHere == _wrapupSaved &&
        redial == _wrapupRedial &&
        redialPlaced == _wrapupRedialPlaced) {
      return _wrapup;
    }
    _wrapupSource = anchor;
    _wrapupSaved = savedHere;
    _wrapupRedial = redial;
    _wrapupRedialPlaced = redialPlaced;
    if (anchor == null) return _wrapup = null;
    return _wrapup = WrapupView(
      endsAt: redialPlaced ? null : anchor.deadline,
      secondsTotal: anchor.secondsTotal,
      hold: redialPlaced
          ? WrapupHold.none
          : switch (anchor.heldReason) {
              wire.WrapupHoldReason.supervisorHold => WrapupHold.supervisor,
              wire.WrapupHoldReason.dispositionRequired => WrapupHold.dispositionRequired,
              _ => WrapupHold.none,
            },
      dispositionSubmitted: anchor.dispositionSubmitted || savedHere,
      autoReturn: anchor.autoReturn,
      redialRemaining: redial != null ? redial.remaining : anchor.redialRemaining,
    );
  }
}

/// The shell's facts, from the view. A session the server ended (4404),
/// another device took (4409) or that cannot open here ([StationView.fatal])
/// holds nothing: no duty and no call, even when the last phase seen was
/// mid-call (the call moved with the session). The station screen still shows
/// why; the tab bar, sign-out and account switch are free again.
StationSignals signalsOf(StationView? view) {
  if (view == null ||
      view.link == StationLink.sessionGone ||
      view.link == StationLink.superseded ||
      view.fatal != null) {
    return const StationSignals();
  }
  return StationSignals(
    onDuty: true,
    callActive: view.callActive,
    onBreak: view.phase == AgentPhase.onBreak,
    campaignId: view.campaignId,
  );
}

/// The shell's facts for the hosted session of either kind, from the station
/// state rather than the campaign view (a soft-phone session has none).
///
/// For a campaign station this is exactly [signalsOf] of its view, plus the
/// soft-phone facts. [over] is the session as this phone no longer holds it: the
/// server ended it (4404), another device took it (4409), or it cannot open
/// here (a fatal message); it holds nothing, as in [signalsOf].
///
/// * [StationSignals.callActive]: a campaign call (reserved, on a call, wrap-up,
///   read off the call itself first: `StationState.effectiveState`) or a
///   soft-phone call on the line (dialing, ringing, on the call).
/// * [StationSignals.outcomeOwed]: the soft-phone call ended and owes its outcome.
/// * [StationSignals.onSoftphone]: a campaign station on the `soft_phone` break.
StationSignals hostSignalsOf({
  required StationSessionKind kind,
  required String? campaignId,
  required StationState state,
  required bool over,
}) {
  if (over) return const StationSignals();
  final call = state.manualCall;
  final shown = state.effectiveState;
  final onBreak = shown == wire.AgentState.onBreak;
  return StationSignals(
    onDuty: true,
    callActive: isCallPhase(shown) || (call?.isLive ?? false),
    onBreak: onBreak,
    campaignId: campaignId,
    sessionKind: kind,
    outcomeOwed: call?.owesOutcome ?? false,
    onSoftphone: kind == StationSessionKind.campaign && onBreak && state.breakReasonCode == wire.softphoneBreakReason,
  );
}

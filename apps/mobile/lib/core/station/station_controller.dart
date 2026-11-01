import 'dart:async';
import 'dart:typed_data';

import 'package:agency_wire/agency_wire.dart';
import 'package:agent_audio/agent_audio.dart' as audio;
import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;

import '../../app/providers.dart';
import '../api/api_client.dart';
import '../api/api_error.dart';
import '../audio/audio_orchestrator.dart';
import '../lifecycle/app_lifecycle.dart';
import '../lifecycle/lifecycle_policy.dart';
import '../telemetry/log.dart';
import 'contact_context.dart';
import 'disposition_rules.dart';
import 'notes_autosave.dart';
import 'server_clock.dart';
import 'station_api.dart';
import 'station_copy.dart';
import 'station_deps.dart';
import 'station_signals.dart';
import 'station_socket.dart';
import 'station_state.dart';
import 'station_view.dart';
import 'station_view_mapper.dart';

/// The live station: socket, reducer, actions, audio and app lifecycle, behind
/// [StationView] / [StationActions] / [StationLauncher].
final stationControllerProvider = NotifierProvider<StationController, StationView?>(StationController.new);

/// What `main.dart` adds to its `ProviderScope` overrides to plug the station
/// core into the seams the screens read.
final List<Override> stationOverrides = [
  stationViewProvider.overrideWith((ref) => ref.watch(stationControllerProvider)),
  stationActionsProvider.overrideWith((ref) => ref.watch(stationControllerProvider.notifier)),
  stationLauncherProvider.overrideWith((ref) => ref.watch(stationControllerProvider.notifier)),
  // `select`: the shell rebuilds only when one of its three facts changes.
  stationSignalsProvider.overrideWith((ref) => ref.watch(stationControllerProvider.select(signalsOf))),
];

final class _Session {
  _Session(this.bootstrap, this.campaignName);

  final SessionBootstrap bootstrap;
  final String campaignName;
  late final StationSocket socket;
  late final AudioOrchestrator audio;
  late final NotesAutosave notes;
  StreamSubscription<List<ConnectivityResult>>? network;
  AppLifecycleSource? lifecycle;

  String get id => bootstrap.sessionId;

  void stopListening() {
    lifecycle?.detach();
    unawaited(network?.cancel());
    network = null;
  }
}

class StationController extends Notifier<StationView?> implements StationActions, StationLauncher {
  static final _log = Log('station');

  _Session? _s;
  StationState _station = StationState.initial;
  ClockOffsetEstimator _estimator = ClockOffsetEstimator.empty;
  List<Disposition> _catalog = const [];
  List<BreakReason> _breakReasons = const [];
  ({String? code, int atStatement})? _breakOverride;
  final Set<StationBusy> _inFlight = {};
  String? _actionError;
  String? _fatal;
  ({String attemptId, String code})? _saved;
  ({String attemptId, int seconds})? _countdown;
  DateTime? _reconnectDeadline;
  Duration? _reconnectWindow;
  ({String attemptId, String text})? _dncOutcome;
  MissedRelease? _dismissedMissed;
  ReleasedFrame? _lastRelease;
  ({String attemptId, String? name})? _nameCache;
  StationViewMapper _mapper = StationViewMapper();

  // Lifecycle.
  bool _foreground = true;
  SessionStateResponse? _lastStateResponse;
  String? _awayKey;
  bool _awayInFlight = false;
  bool _awayPauseRequested = false;
  String? _awayQueuedFor;
  AwayNotice _notice = AwayNotice.none;
  DateTime? _noticeDeadline;
  bool? _wakeLockOn;

  late final StationApi _api = StationApi(
    ref.read(apiClientProvider),
    scopedTo: _scopedClient,
    onUnauthorized: _reportUnauthorized,
  );

  void _reportUnauthorized(ApiUnauthorized error) {
    if (!ref.mounted) return;
    try {
      ref.read(stationUnauthorizedSinkProvider)(error);
    } catch (e) {
      _log.warn('could not report an expired sign-in', {'error': e.runtimeType.toString()});
    }
  }

  // Read once in build: teardown runs inside `onDispose`, where `ref` is off limits.
  late DateTime Function() _now;
  late WakeLock _wakeLock;
  late StationNotifier _notifier;

  @override
  StationView? build() {
    _now = ref.read(stationNowProvider);
    _wakeLock = ref.read(wakeLockProvider);
    _notifier = ref.read(stationNotifierProvider);
    ref.onDispose(() => unawaited(_closeSession(disposing: true)));
    return null;
  }

  ApiClient _scopedClient(String accountId) {
    final base = ref.read(apiClientProvider);
    return ApiClient(
      http: ref.read(httpClientProvider),
      env: ref.read(envProvider),
      tokens: ref.read(idTokenSourceProvider),
      identity: ref.read(clientIdentityProvider),
      scope: RequestScope()
        ..tenantId = base.scope.tenantId
        ..accountId = accountId,
    );
  }

  /// The reducer's state (tests and diagnostics).
  StationState get stationState => _station;

  // ─── Launching ──────────────────────────────────────────────────────────

  @override
  Future<StationStart> start(String campaignId, {required String campaignName}) async {
    final current = _s;
    if (current != null &&
        current.bootstrap.campaignId == campaignId &&
        _station.connection != StationConnection.sessionGone) {
      return const StationStarted();
    }
    final SessionBootstrap bootstrap;
    try {
      bootstrap = await _api.join(campaignId);
    } on ApiError catch (e) {
      return _joinRefusal(e);
    }
    await _open(bootstrap, campaignName);
    return const StationStarted();
  }

  @override
  Future<StationStart> leaveOtherAndStart(StationElsewhere other, String campaignId, {required String campaignName}) async {
    if (!other.canLeave) {
      return StationRefused(
        joinConflictRemedy(other.campaignName, AgentState.onCall),
        code: AgencyErrorCode.sessionOnOtherCampaign.wire,
      );
    }
    final own = _s;
    var sessionId = own != null && own.bootstrap.campaignId == other.campaignId ? own.id : other.sessionId;
    if (sessionId.isEmpty) {
      // The conflict names the campaign, not the session: rejoining it is how
      // the console finds the id, and it re-reads the state on the way.
      try {
        final there = await _api.join(other.campaignId, accountId: other.accountId);
        if (conflictIsMidCall(there.state)) {
          return StationElsewhere(
            sessionId: there.sessionId,
            campaignId: other.campaignId,
            campaignName: other.campaignName,
            stateLabel: agentStateLabel(there.state, there.stateRaw),
            canLeave: false,
            accountId: other.accountId,
            accountName: other.accountName,
          );
        }
        sessionId = there.sessionId;
      } on ApiError catch (e) {
        return StationRefused(switchFailureCopy(SwitchStage.resume, other.campaignName, errorDetail(e)));
      }
    }
    try {
      await _api.leave(sessionId, accountId: other.accountId);
    } on ApiError catch (e) {
      if (!_alreadyLeft(e)) return StationRefused(switchFailureCopy(SwitchStage.leave, other.campaignName, errorDetail(e)));
    }
    if (own != null && own.id == sessionId) await _closeSession();
    final result = await start(campaignId, campaignName: campaignName);
    if (result is StationRefused) {
      return StationRefused(switchFailureCopy(SwitchStage.rejoin, other.campaignName, result.message), code: result.code);
    }
    return result;
  }

  /// Closes a soft-phone session that has no unsettled call (in its own
  /// account), then starts.
  @override
  Future<StationStart> closeSoftphoneAndStart(StationOnSoftphone softphone, String campaignId, {required String campaignName}) async {
    try {
      await _api.leave(softphone.sessionId, accountId: softphone.accountId);
    } on ApiError catch (e) {
      final code = e is ApiHttpError ? e.code : null;
      if (code == AgencyErrorCode.agentOnLiveCall.wire || code == 'manual_call_live') {
        return const StationRefused(softphoneCallPendingCopy, code: 'call_pending');
      }
      if (!_alreadyLeft(e)) return StationRefused(softphoneStillOpenCopy(errorDetail(e)));
    }
    final result = await start(campaignId, campaignName: campaignName);
    if (result is StationRefused) return StationRefused(softphoneJoinFailedCopy(result.message), code: result.code);
    return result;
  }

  static bool _alreadyLeft(ApiError e) =>
      e is ApiHttpError && (e.status == 404 || e.code == AgencyErrorCode.sessionEnded.wire);

  StationStart _joinRefusal(ApiError e) {
    if (e is! ApiHttpError) return StationRefused(e.userMessage);
    final body = ErrorBody.fromJson(e.body);
    final message = body.message.trim();
    switch (body.code) {
      case AgencyErrorCode.sessionOnOtherCampaign:
        final c = body.campaignConflict;
        if (c == null) return StationRefused(message.isEmpty ? joinFailedCopy : message, code: body.codeRaw);
        final own = _s;
        final rawSession = body.raw['session_id'];
        final rawAccount = body.raw['account_id'];
        final rawAccountName = body.raw['account_name'];
        return StationElsewhere(
          sessionId: rawSession is String
              ? rawSession
              : (own != null && own.bootstrap.campaignId == c.campaignId ? own.id : ''),
          campaignId: c.campaignId,
          campaignName: c.campaignName,
          stateLabel: agentStateLabel(c.state, c.stateRaw),
          canLeave: !conflictIsMidCall(c.state),
          accountId: rawAccount is String && rawAccount.isNotEmpty ? rawAccount : null,
          accountName: rawAccountName is String && rawAccountName.isNotEmpty ? rawAccountName : null,
        );
      case AgencyErrorCode.sessionOnSoftphone:
        final sp = body.softphoneConflict;
        if (sp == null) return StationRefused(message.isEmpty ? joinFailedCopy : message, code: body.codeRaw);
        return StationOnSoftphone(sessionId: sp.sessionId, accountId: sp.accountId, accountName: sp.accountName);
      case AgencyErrorCode.notStaffed:
        return StationRefused(message.isEmpty ? notStaffedCopy : message, code: body.codeRaw);
      case AgencyErrorCode.featureDisabled:
        return StationRefused(message.isEmpty ? featureDisabledCopy : message, code: body.codeRaw);
      default:
        return StationRefused(e.userMessage, code: body.codeRaw);
    }
  }

  Future<void> _open(SessionBootstrap bootstrap, String campaignName) async {
    await _closeSession();
    _station = bootstrap.campaignStatus == CampaignStatus.running
        ? StationState.initial
        : stationReducer(StationState.initial, const CampaignStateAction(dialing: false));
    _catalog = bootstrap.dispositionCatalog;
    _breakReasons = bootstrap.breakReasons;

    final s = _Session(bootstrap, campaignName);
    _s = s;
    s.audio = AudioOrchestrator(
      engine: ref.read(audioEngineProvider),
      sendUplink: _sendUplink,
      onChanged: _emit,
      onSystemHangUp: () => unawaited(hangUp()),
    );
    s.notes = NotesAutosave(
      save: _api.saveNotes,
      store: ref.read(notesStoreProvider),
      onChanged: _emit,
      now: _now,
    );
    final tokens = ref.read(idTokenSourceProvider);
    s.socket = StationSocket(
      connector: ref.read(stationConnectorProvider),
      resolveUrl: ref.read(envProvider).resolveStationUrl,
      mintToken: () async => (await _api.mintStationToken(bootstrap.sessionId)).stationWsUrl,
      refreshIdToken: () async {
        await tokens.idToken(forceRefresh: true);
      },
      initialUrl: bootstrap.stationWsUrl,
      initialUrlExpiresAt: bootstrap.stationTokenExpiresAt,
      heartbeat: bootstrap.intervals.heartbeat,
      clientHeader: ref.read(clientIdentityProvider).header,
      onFrame: _onFrame,
      onPong: _onPong,
      onBinary: s.audio.playFrame,
      onConnection: _onConnection,
      onMissedPings: (n) => _dispatch(MissedPingsAction(n)),
      callLive: () => _station.live != null || isCallPhase(_station.agentState),
      now: _now,
      decode: ref.read(stationFrameDecoderProvider),
    );

    final lifecycle = ref.read(appLifecycleSourceProvider);
    s.lifecycle = lifecycle;
    _foreground = lifecycle.isForeground;
    lifecycle.attach(onHide: _onHide, onShow: _onShow);
    s.network = ref.read(networkMonitorProvider).changes().listen(s.socket.networkChanged, onError: (Object _) {});

    // While the app is on screen: Android starts the on-duty service only from the foreground.
    s.audio.open(_onDutyNotification());
    unawaited(_warmIdToken(s, tokens));
    unawaited(_sweepNotes());
    s.socket.start();
    _afterChange();
  }

  Future<void> _warmIdToken(_Session s, IdTokenSource tokens) async {
    try {
      await tokens.idToken(forceRefresh: true);
      if (identical(_s, s)) s.socket.markIdTokenFresh();
    } catch (e) {
      _log.warn('id token warm-up failed', {'error': e.runtimeType.toString()});
    }
  }

  Future<void> _sweepNotes() async {
    try {
      await ref.read(notesStoreProvider).sweep(_now());
    } catch (_) {}
  }

  /// Local teardown: socket, audio, listeners, notifications, wake lock. No HTTP.
  Future<void> _closeSession({bool disposing = false}) async {
    final s = _s;
    if (s == null) return;
    _s = null;
    s.socket.dispose();
    s.stopListening();
    await s.notes.persistNow();
    s.notes.dispose();
    _resetSessionState();
    if (!disposing && ref.mounted) state = null;
    _setWakeLock(false);
    _setNotice(AwayNotice.none, null);
    await s.audio.close();
  }

  void _resetSessionState() {
    _station = StationState.initial;
    _estimator = ClockOffsetEstimator.empty;
    _breakOverride = null;
    _inFlight.clear();
    _actionError = null;
    _fatal = null;
    _saved = null;
    _countdown = null;
    _reconnectDeadline = null;
    _reconnectWindow = null;
    _dncOutcome = null;
    _dismissedMissed = null;
    _lastRelease = null;
    _nameCache = null;
    _lastStateResponse = null;
    _awayKey = null;
    _awayInFlight = false;
    _awayPauseRequested = false;
    _awayQueuedFor = null;
    _mapper = StationViewMapper();
  }

  // ─── Frames ─────────────────────────────────────────────────────────────

  void _onFrame(StationFrame frame) {
    switch (frame) {
      case MediaFrame():
        // `media=pcm16` fallback only; `alaw8` media arrives as binary frames.
        _s?.audio.playFrame(frame.decodePayload());
      case BinaryMediaFrame(:final bytes):
        _s?.audio.playFrame(bytes);
      case ReadyFrame(:final activeWrapup):
        _reconnectDeadline = null;
        _reconnectWindow = null;
        _dispatch(ReadyAction(
          frame,
          wrapup: activeWrapup == null ? null : openWrapup(activeWrapup, _station.clockOffsetMs, _now()),
        ));
      case AgentStateFrame():
        // The authority: an HTTP answer held for reconciliation is now stale.
        _lastStateResponse = null;
        if (frame.state == AgentState.onBreak) _breakOverride = null;
        // Available again: whatever pause was asked for is over (and is asked
        // for afresh below if the app is still away).
        if (frame.state == AgentState.available) _awayPauseRequested = false;
        _dispatch(AgentStateAction(frame));
      case WrapupFrame(:final wrapup):
        // Captured once, here, on the frame: never per repaint.
        _dispatch(WrapupAction(openWrapup(wrapup, _station.clockOffsetMs, _now())));
      case ReservedFrame(:final attempt):
        _countdown = null;
        _dispatch(ReservedAction(attempt));
      case CountdownFrame(:final attemptId, :final secondsRemaining):
        if (_station.live?.attemptId == attemptId) {
          _countdown = (attemptId: attemptId, seconds: secondsRemaining);
          _emit();
        }
      case BridgedFrame(:final attemptId, :final bridgedAt):
        _countdown = null;
        _dispatch(BridgedAction(attemptId, bridgedAt));
      case ReleasedFrame():
        _countdown = null;
        _lastRelease = frame;
        if (!isKnownReleaseReason(frame.reason)) _log.warn('unknown release reason', {'reason': frame.reasonRaw});
        _dispatch(ReleasedAction(frame, at: _now(), retain: _station.live?.attempt));
      case CampaignStateFrame(:final dialing, :final message):
        _dispatch(CampaignStateAction(dialing: dialing, message: message));
      case StationErrorFrame():
        _log.warn('station error frame', {'code': frame.codeRaw});
        _dispatch(ErrorAction(frame));
      case ManualCallFrame():
        _dispatch(ManualCallAction(frame));
      case PongFrame():
        _onPong(frame, _now().millisecondsSinceEpoch);
      case BridgeStatusFrame(:final statusRaw):
        // The media leg, not the attempt: diagnostic only.
        _log.debug('bridge status', {'status': statusRaw});
      case BridgeEndedFrame():
        _log.debug('bridge ended');
      case UnknownFrame(:final eventRaw, :final reason):
        // Expected after a server deploy; never logged whole (it can hold contact data).
        _log.debug('unknown frame', {'event': eventRaw ?? '', 'reason': reason});
    }
  }

  void _onPong(PongFrame frame, int receivedAtMs) {
    int? offset;
    final ts = frame.ts;
    if (ts != null) {
      _estimator = _estimator.push(ts: ts, serverTs: frame.serverTs, receivedAt: receivedAtMs);
      offset = _estimator.offsetMs;
    }
    _dispatch(PongAction(offset));
  }

  void _onConnection(StationConnection connection, {int? closeCode}) {
    final wasOpen = _station.connection == StationConnection.open;
    if (connection == StationConnection.reconnecting && wasOpen && _station.live != null) {
      // The server holds a live call this long for the same session to come back.
      final hold = _s?.bootstrap.intervals.deferredHangup ?? const Duration(seconds: 8);
      _reconnectDeadline = _now().add(hold);
      _reconnectWindow = hold;
    } else if (connection != StationConnection.reconnecting) {
      _reconnectDeadline = null;
      _reconnectWindow = null;
    }
    _dispatch(ConnectionAction(connection));
  }

  void _sendUplink(Uint8List frame) => _s?.socket.sendBinary(frame);

  // ─── State plumbing ─────────────────────────────────────────────────────

  void _dispatch(StationAction action) {
    final next = stationReducer(_station, action);
    if (identical(next, _station)) return;
    _station = next;
    _afterChange();
  }

  String? get _pendingBreakCode {
    final o = _breakOverride;
    return o != null && o.atStatement == _station.pendingBreakStatements ? o.code : _station.pendingBreakCode;
  }

  /// The HTTP answer's view of the queue, until the next frame states it.
  void _writeQueue(String? code) => _breakOverride = (code: code, atStatement: _station.pendingBreakStatements);

  bool get _terminal =>
      _station.connection == StationConnection.sessionGone || _station.connection == StationConnection.superseded;

  void _afterChange() {
    final s = _s;
    if (s == null) return;
    final held = _lastStateResponse;
    if (held != null && _station.agentStateSince == null && held.state == _station.agentState) {
      _station = stationReducer(_station, SessionStateAction(held));
    }
    if (_saved != null && _saved!.attemptId != _station.currentAttemptId) _saved = null;
    if (_dncOutcome != null && _dncOutcome!.attemptId != _station.currentAttemptId) _dncOutcome = null;

    s.audio.sync(_audioTarget());
    s.notes.attemptChanged(
      _station.currentAttemptId,
      accepting: _station.currentAttemptId != null && isCallPhase(_station.agentState),
    );
    _applyLifecycle(s);
    _emit();
  }

  void _emit() {
    if (!ref.mounted) return;
    final s = _s;
    if (s == null) {
      state = null;
      return;
    }
    s.audio.updateNotification(_onDutyNotification());
    final missed = _station.missedRelease;
    state = _mapper.map(
      campaignId: s.bootstrap.campaignId,
      campaignName: s.campaignName,
      sessionId: s.id,
      s: _station,
      bootstrap: s.bootstrap,
      catalog: _catalog,
      breakReasons: _breakReasons,
      pendingBreakCode: _pendingBreakCode,
      audio: s.audio.view,
      notes: s.notes.view,
      busy: _inFlight.isEmpty ? StationBusy.none : _inFlight.last,
      actionError: _actionError,
      fatal: _fatal,
      dispositionSavedCode: _saved != null && _saved!.attemptId == _station.currentAttemptId ? _saved!.code : null,
      countdown: _countdown,
      reconnectDeadline: _reconnectDeadline,
      reconnectWindow: _reconnectWindow,
      dncOutcome: _dncOutcome != null && _dncOutcome!.attemptId == _station.currentAttemptId ? _dncOutcome!.text : null,
      missedReleaseDismissed: missed != null && identical(missed, _dismissedMissed),
      awayPauseRequested: _awayPauseRequested,
    );
  }

  AudioTarget _audioTarget() {
    final endReason = _endReasonFor(_lastRelease);
    final live = _station.live;
    // Superseded: the call moved with the session to the other device.
    if (live == null || _terminal) return AudioTarget(endReason: endReason);
    final cached = _nameCache;
    final String? name;
    if (cached != null && cached.attemptId == live.attemptId) {
      name = cached.name;
    } else {
      name = displayNameFor(live.attempt.context, _s?.bootstrap.contextDisplay);
      _nameCache = (attemptId: live.attemptId, name: name);
    }
    return AudioTarget(
      attemptId: live.attemptId,
      bridged: live.bridgedAt != null,
      displayName: name ?? live.attempt.phoneE164,
      handle: live.attempt.phoneE164,
      endReason: endReason,
    );
  }

  static audio.CallEndReason _endReasonFor(ReleasedFrame? frame) => switch (frame?.reason) {
        ReleaseReason.agentHangup => audio.CallEndReason.local,
        ReleaseReason.noAnswer => audio.CallEndReason.unanswered,
        ReleaseReason.busy ||
        ReleaseReason.failed ||
        ReleaseReason.invalid ||
        ReleaseReason.abandoned ||
        ReleaseReason.agentDisconnected =>
          audio.CallEndReason.failed,
        _ => audio.CallEndReason.remoteEnded,
      };

  audio.OnDutyNotification _onDutyNotification() {
    final s = _s;
    final state = _station.agentState;
    final away = state == AgentState.onBreak &&
        (_station.breakReasonCode ?? (_awayPauseRequested ? ReservedBreakCode.deviceAway.wire : null)) ==
            ReservedBreakCode.deviceAway.wire;
    final text = switch (state) {
      AgentState.available => 'Waiting for calls',
      AgentState.reserved => 'Connecting a call',
      AgentState.onCall => 'On a call',
      AgentState.wrapup => 'Wrapping up',
      AgentState.onBreak => away ? 'Paused · open the app to take calls' : 'On a break',
      AgentState.offline || AgentState.unknown => 'On duty',
    };
    final live = _station.live;
    return audio.OnDutyNotification(
      title: s == null ? 'On duty' : 'On duty · ${s.campaignName}',
      text: text,
      channelName: 'On duty',
      call: live == null
          ? null
          : audio.OnDutyCall(
              muted: s?.audio.view.muted ?? false,
              muteLabel: 'Mute',
              unmuteLabel: 'Unmute',
              hangUpLabel: 'Hang up',
              connectedAt: correctedInstant(live.bridgedAt, _station.clockOffsetMs),
            ),
    );
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  void _onHide() {
    _foreground = false;
    // First, before anything else: the pause must leave while the OS still lets it.
    _maybeSendAway();
    final s = _s;
    if (s == null) return;
    unawaited(s.notes.persistNow());
    _afterChange();
  }

  void _onShow() {
    _foreground = true;
    final s = _s;
    if (s == null) return;
    final queuedFor = _awayQueuedFor;
    _awayQueuedFor = null;
    _awayKey = null;
    if (queuedFor != null &&
        _pendingBreakCode == ReservedBreakCode.deviceAway.wire &&
        isCallPhase(_station.agentState)) {
      // Back before the call ended: the pause queued for after it is not wanted.
      _awayPauseRequested = false;
      unawaited(_api.cancelBreak(s.id).then((r) {
        if (!identical(_s, s)) return;
        _writeQueue(r?.pendingState != null ? r?.breakReason : null);
        _afterChange();
      }, onError: (Object e) => _log.warn('cancelling the away pause failed', {'error': e.runtimeType.toString()})));
    }
    final c = _station.connection;
    if (c == StationConnection.reconnecting || c == StationConnection.disconnected) s.socket.reconnect();
    _afterChange();
  }

  void _applyLifecycle(_Session s) {
    final st = _station.agentState;
    s.socket.setAppPings(appPingsWanted(foreground: _foreground, state: st) && !_terminal);
    s.socket.setKeepAlive(keepAliveWanted(foreground: _foreground, state: st));
    if (!_foreground) _maybeSendAway();
    _setWakeLock(wakeLockWanted(onDuty: !_terminal, foreground: _foreground));
    final notice = awayNoticeFor(
      st,
      foreground: _foreground,
      breakCode: _station.breakReasonCode ??
          (st == AgentState.onBreak && _awayPauseRequested ? ReservedBreakCode.deviceAway.wire : null),
      pauseRequested: _awayPauseRequested,
      wrapupDeadline: _station.wrapup?.deadline,
    );
    _setNotice(notice, notice == AwayNotice.wrapupDeadline ? _station.wrapup?.deadline : null);
  }

  void _maybeSendAway() {
    final s = _s;
    if (s == null || _foreground || _awayInFlight || _terminal) return;
    final st = _station.agentState;
    final action = awayActionFor(st, pendingBreakCode: _pendingBreakCode);
    if (action == AwayAction.none) return;
    // One queued pause per away period: the call it was queued behind may end
    // (no attempt on screen) before the state moves on.
    if (action == AwayAction.queuePause && _awayQueuedFor != null) return;
    final key = action == AwayAction.pauseNow
        ? 'now:${st.wire}:${_station.agentStateSince?.millisecondsSinceEpoch}'
        : 'queue:${_station.currentAttemptId}';
    if (key == _awayKey) return;
    _awayKey = key;
    _awayInFlight = true;
    if (action == AwayAction.pauseNow) {
      _awayPauseRequested = true;
    } else {
      _awayQueuedFor = _station.currentAttemptId ?? '';
    }
    _log.info('left the app: pausing', {'state': st.wire, 'queued': action == AwayAction.queuePause});
    unawaited(_api
        .takeBreak(s.id, ReservedBreakCode.deviceAway.wire, timeout: const Duration(seconds: 5))
        .then((response) {
      _awayInFlight = false;
      if (!identical(_s, s)) return;
      if (response != null) {
        if (response.pendingState != null) _writeQueue(response.breakReason ?? ReservedBreakCode.deviceAway.wire);
        _lastStateResponse = response;
      }
      _afterChange();
    }, onError: (Object e) {
      _awayInFlight = false;
      if (!identical(_s, s)) return;
      // The server's mobile grace still pauses the agent: app pings have stopped.
      _awayKey = null;
      _log.warn('device_away pause failed', {'error': e.runtimeType.toString()});
    }));
  }

  void _setWakeLock(bool on) {
    if (on == _wakeLockOn) return;
    _wakeLockOn = on;
    unawaited(_wakeLock.set(on).catchError((Object e) {
      _log.warn('wake lock failed', {'error': e.runtimeType.toString()});
    }));
  }

  void _setNotice(AwayNotice notice, DateTime? deadline) {
    if (notice == _notice && deadline == _noticeDeadline) return;
    _notice = notice;
    _noticeDeadline = deadline;
    unawaited(switch (notice) {
      AwayNotice.none => _notifier.cancel(),
      AwayNotice.paused => _notifier.showPaused(),
      AwayNotice.wrapupDeadline => _notifier.showWrapupDeadline(deadline!),
    });
  }

  // ─── Actions ────────────────────────────────────────────────────────────

  /// Single-flight per action: a second press of the same action while the
  /// first is in flight does nothing, and nothing runs while leaving. Hang-up
  /// is never held up behind another action (a CallKit end must always go).
  Future<void> _run(StationBusy kind, Future<void> Function(_Session s) body) async {
    final s = _s;
    if (s == null || _inFlight.contains(kind) || _inFlight.contains(StationBusy.leaving)) return;
    _inFlight.add(kind);
    _actionError = null;
    _emit();
    try {
      await body(s);
    } catch (e, st) {
      _log.error('station action failed', {'action': kind.name}, e, st);
    } finally {
      if (identical(_s, s)) {
        _inFlight.remove(kind);
        _emit();
      }
    }
  }

  static String? _serverSentence(Object e) => e is ApiHttpError && e.message.trim().isNotEmpty ? e.message.trim() : null;

  void _reconcile(SessionStateResponse? response) {
    if (response == null) return;
    _lastStateResponse = response;
    _afterChange();
  }

  @override
  Future<void> goAvailable() => _run(StationBusy.goingAvailable, (s) async {
        // Pre-warm on the agent's own "ready", so a late-bound call has audio inside its budget.
        s.audio.prewarm();
        try {
          _reconcile(await _api.available(s.id));
        } on ApiError catch (e) {
          // Shown as received: "Submit a disposition for your last call before going available."
          _actionError = _serverSentence(e) ?? presenceFailedCopy;
        }
      });

  @override
  Future<void> endBreak() => _run(StationBusy.endingBreak, (s) async {
        try {
          _reconcile(await _api.available(s.id));
        } on ApiError catch (e) {
          _actionError = _serverSentence(e) ?? presenceFailedCopy;
        }
      });

  @override
  Future<void> takeBreak(String code) => _run(StationBusy.takingBreak, (s) async {
        try {
          final r = await _api.takeBreak(s.id, code);
          _writeQueue(r?.pendingState != null ? (r?.breakReason ?? code) : null);
          _reconcile(r);
        } on ApiError catch (e) {
          final body = errorBodyOf(e);
          final allowed = body?.allowedCodes;
          if (body?.code == AgencyErrorCode.unknownBreakReason && allowed != null) {
            _breakReasons = resyncBreakReasons(_breakReasons, allowed);
            _actionError = breakRejectedCopy;
          } else {
            _actionError = _serverSentence(e) ?? breakFailedCopy;
          }
        }
      });

  @override
  Future<void> cancelQueuedBreak() => _run(StationBusy.cancellingBreak, (s) async {
        try {
          final r = await _api.cancelBreak(s.id);
          _writeQueue(r?.pendingState != null ? r?.breakReason : null);
          _reconcile(r);
        } on ApiError catch (e) {
          if (errorCodeOf(e) == AgencyErrorCode.breakAlreadyApplied) {
            _writeQueue(null);
            _actionError = breakAlreadyStartedCopy;
          } else {
            _actionError = cancelBreakFailedCopy;
          }
        }
      });

  @override
  Future<void> hangUp() async {
    final attemptId = _station.live?.attemptId;
    if (attemptId == null) return;
    await _run(StationBusy.hangingUp, (s) async {
      try {
        await _api.hangup(attemptId);
      } on ApiError catch (e) {
        if (_station.live?.attemptId == attemptId) _actionError = hangupFailureCopy(e);
      }
    });
  }

  @override
  Future<void> setMuted(bool muted) async => _s?.audio.setMuted(muted);

  @override
  Future<void> setRoute(AudioRouteOption route) async => _s?.audio.setRoute(route);

  @override
  void updateNotes(String text) => _s?.notes.edit(text);

  @override
  Future<void> submitDisposition(String code, {String? notes, DateTime? callbackAt}) async {
    final s = _s;
    if (s == null) return;
    final attemptId = _station.currentAttemptId;
    if (attemptId == null) {
      _actionError = noCallForDispositionCopy;
      _emit();
      return;
    }
    if (_saved?.attemptId == attemptId) return;
    final text = notes ?? s.notes.text;
    final now = _now();
    final block = dispositionBlock(_catalog, code: code, notes: text, callbackAt: callbackAt, now: now);
    if (block != null) {
      _actionError = dispositionBlockCopy[block];
      _emit();
      return;
    }
    final request = buildDispositionRequest(_catalog, code: code, notes: text, callbackAt: callbackAt, now: now)!;
    await _run(StationBusy.savingDisposition, (s) async {
      try {
        final r = await _api.disposition(attemptId, request);
        s.notes.savedWithDisposition(attemptId);
        final current = _station.currentAttemptId;
        if (r.attemptId != attemptId || (current != null && current != attemptId)) {
          // Saved, but for a call no longer on screen: nothing to show about it.
          _log.info('disposition answer for an earlier call discarded');
          return;
        }
        _saved = (attemptId: attemptId, code: code);
      } on ApiError catch (e) {
        final current = _station.currentAttemptId;
        if (current != null && current != attemptId) {
          _actionError = dispositionLostCopy;
          return;
        }
        final body = errorBodyOf(e);
        final allowed = body?.allowedCodes;
        if (e is ApiHttpError && (e.status == 409 || body?.code == AgencyErrorCode.alreadyDispositioned)) {
          final recorded = body?.raw['disposition_code'];
          _actionError = alreadyRecordedCopy(
            recorded is String ? (findDisposition(_catalog, recorded)?.label ?? humaniseCode(recorded)) : null,
          );
        } else if (body?.code == AgencyErrorCode.unknownDispositionCode && allowed != null) {
          _catalog = resyncDispositions(_catalog, allowed);
          _actionError = catalogChangedCopy;
        } else if (body != null) {
          _actionError = body.message.trim().isNotEmpty ? body.message.trim() : dispositionFailedCopy;
        } else {
          _actionError = e.userMessage;
        }
      }
    });
  }

  @override
  Future<void> markDnc({String? reason}) async {
    if (_s == null) return;
    final attemptId = _station.live?.attemptId;
    if (attemptId == null) {
      _actionError = dncNeedsCallCopy;
      _emit();
      return;
    }
    _dncOutcome = null;
    await _run(StationBusy.markingDnc, (s) async {
      try {
        final r = await _api.markDnc(attemptId, DncRequest(reason: reason));
        _log.info('marked do not call', {'recorded': r.dncRecorded});
        if (_station.currentAttemptId == attemptId) _dncOutcome = (attemptId: attemptId, text: dncOutcomeCopy(r));
      } on ApiError catch (e) {
        if (_station.live?.attemptId == attemptId) _actionError = dncFailureCopy(e);
      }
    });
  }

  @override
  Future<void> leave() => _run(StationBusy.leaving, (s) async {
        try {
          await _api.leave(s.id);
        } on ApiError catch (e) {
          if (!_alreadyLeft(e)) {
            _actionError = _serverSentence(e) ?? e.userMessage;
            return;
          }
        }
        await _closeSession();
      });

  @override
  Future<void> reconnect() async {
    final s = _s;
    if (s == null) return;
    if (_station.connection != StationConnection.sessionGone) {
      s.socket.reconnect();
      return;
    }
    // The session is over server-side: join again (a fresh session).
    final result = await start(s.bootstrap.campaignId, campaignName: s.campaignName);
    _fatal = switch (result) {
      StationStarted() => null,
      StationRefused(:final message) => message,
      StationElsewhere(:final campaignName) => joinConflictRemedy(campaignName, AgentState.available),
      StationOnSoftphone() => softphoneCallPendingCopy,
    };
    _emit();
  }

  @override
  Future<void> useThisDevice() async => _s?.socket.reconnect();

  @override
  void dismissActionError() {
    if (_actionError == null) return;
    _actionError = null;
    _emit();
  }

  @override
  void dismissMissedRelease() {
    _dismissedMissed = _station.missedRelease;
    _emit();
  }
}

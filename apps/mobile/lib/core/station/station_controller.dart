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
import '../softphone/call_state.dart';
import '../softphone/refusal_copy.dart' show refusalBodyOf, softphoneErrorCopy;
import '../softphone/softphone_api.dart';
import '../softphone/softphone_copy.dart' show softphoneHangupFailedCopy;
import '../softphone/softphone_host.dart';
import '../softphone/softphone_view.dart' show SoftphonePhase;
import '../telemetry/call_telemetry.dart';
import '../telemetry/log.dart';
import 'close_softphone.dart';
import 'contact_context.dart';
import 'disposition_rules.dart';
import 'hosted_session.dart';
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

/// The session host: the live session of either kind (a campaign station or a
/// soft-phone session) on one socket, one audio engine and one on-duty
/// service, with its reducer, actions and app lifecycle. A campaign station is
/// read through [StationView] / [StationActions] / [StationLauncher]; the soft
/// phone through [SoftphoneHostView] / [SoftphoneHostActions]; the shell
/// through [StationSignals] (published in [stationHostProvider]).
final stationControllerProvider = NotifierProvider<StationController, StationView?>(StationController.new);

/// What `main.dart` adds to its `ProviderScope` overrides to plug the station
/// core into the seams the screens and the soft phone read.
final List<Override> stationOverrides = [
  stationViewProvider.overrideWith((ref) => ref.watch(stationControllerProvider)),
  stationActionsProvider.overrideWith((ref) => ref.watch(stationControllerProvider.notifier)),
  stationLauncherProvider.overrideWith((ref) => ref.watch(stationControllerProvider.notifier)),
  // `select`: the shell rebuilds only when one of its facts changes.
  stationSignalsProvider.overrideWith((ref) => ref.watch(stationHostProvider.select((h) => h.signals))),
  stationTeardownProvider.overrideWith((ref) => ref.watch(stationControllerProvider.notifier).leaveForSignOut),
  softphoneHostViewProvider.overrideWith((ref) => ref.watch(stationHostProvider.select((h) => h.softphone))),
  softphoneHostActionsProvider.overrideWith((ref) => ref.watch(stationControllerProvider.notifier)),
];

final class _Session {
  _Session(this.hosted);

  final HostedSession hosted;
  late final StationSocket socket;
  late final AudioOrchestrator audio;
  late final NotesAutosave notes;
  StreamSubscription<List<ConnectivityResult>>? network;
  AppLifecycleSource? lifecycle;

  String get id => hosted.sessionId;

  void stopListening() {
    lifecycle?.detach();
    unawaited(network?.cancel());
    network = null;
  }
}

class StationController extends Notifier<StationView?>
    implements StationActions, StationLauncher, SoftphoneHostActions {
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

  // The soft-phone call's local facts (the call itself is in the reducer).
  /// The ring is muted for [_ringCallId]; any other call rings.
  bool _ringMuted = false;
  String? _ringCallId;

  /// A system hang-up of the soft-phone call [callId] that failed, in the
  /// soft phone's words ([SoftphoneHostView.hangupFailure]).
  ({String callId, String text})? _manualHangupFailure;

  /// The read that checks a held soft-phone call after a reconnect
  /// ([_checkHeldCall]), how many in a row have failed, and which check a
  /// read in flight belongs to (a cancelled check's answer schedules nothing).
  Timer? _heldCallTimer;
  int _heldCallFailures = 0;
  int _heldCallCheck = 0;

  /// The call the audio was last told about, so the end reason handed to
  /// CallKit is that call's: a campaign release's, or a soft-phone call's.
  String? _lastTargetId;

  /// The socket has opened at least once in this session.
  bool _everOpened = false;

  /// The server refused the socket's upgrade (1008): nothing here can work.
  bool _upgradeRefused = false;

  /// The first `ready` of this session has been seen (the bootstrap's break
  /// reason stands in for a `ready` that states none only once).
  bool _readySeen = false;

  // Lifecycle.
  bool _foreground = true;
  SessionStateResponse? _lastStateResponse;
  String? _awayKey;
  bool _awayInFlight = false;
  bool _awayPauseRequested = false;
  String? _awayQueuedFor;
  bool _awayQueueFailed = false;

  /// The pause asked for at once has been answered by the server.
  bool _awayLanded = false;

  /// The pause never landed, so the station socket was closed (parked) instead.
  bool _awayClosed = false;
  int _awayRetries = 0;
  Timer? _awayRetry;
  Timer? _awayDeadline;
  AwayNotice _notice = AwayNotice.none;
  DateTime? _noticeDeadline;
  bool _noticeSoftphone = false;
  bool? _wakeLockOn;

  late final StationApi _api = StationApi(
    ref.read(apiClientProvider),
    scopedTo: _scopedClient,
    onUnauthorized: _reportUnauthorized,
  );

  late final SoftphoneApi _softphoneApi = SoftphoneApi(
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
        !current.hosted.isSoftphone &&
        current.hosted.campaignId == campaignId &&
        _station.connection != StationConnection.sessionGone) {
      return const StationStarted();
    }
    final accountId = _api.accountId;
    final SessionBootstrap bootstrap;
    try {
      bootstrap = await _api.join(campaignId);
    } on ApiError catch (e) {
      return _joinRefusal(e);
    }
    await _open(HostedSession.campaign(bootstrap, campaignName: campaignName, accountId: accountId));
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
    final sessionId = other.sessionId;
    if (sessionId.isEmpty) {
      // A server older than the conflict's `session_id` / `account_id` names
      // the campaign only. Rejoining it to find the id would join in THIS
      // account, which may not be the one that session is in: say so instead.
      return StationRefused(leaveOtherUnknownCopy(other.campaignName), code: AgencyErrorCode.sessionOnOtherCampaign.wire);
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

  /// Closes the agent's soft-phone session (in its own account) unless its
  /// call is live or owes its outcome ([closeSoftphone]: the bootstrap is read
  /// first, since `leave` refuses only a live call and an owed outcome would
  /// lapse), then starts. The session closed is torn down here too when it is
  /// the one this phone hosts.
  @override
  Future<StationStart> closeSoftphoneAndStart(StationOnSoftphone softphone, String campaignId, {required String campaignName}) async {
    final closed = await closeSoftphone(sessionId: softphone.sessionId, accountId: softphone.accountId);
    switch (closed) {
      case SoftphoneCloseCallPending():
        return const StationRefused(softphoneCallPendingCopy, code: 'call_pending');
      case SoftphoneCloseFailed(:final message):
        return StationRefused(message);
      case SoftphoneClosed() || SoftphoneCloseNoSession():
        break;
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
        // The session to leave and the account it is in come together, or
        // not at all (a server older than the fields). Without them only this
        // phone's own open station can be left from here, in its own account.
        final ownThere = own != null && !own.hosted.isSoftphone && own.hosted.campaignId == c.campaignId;
        return StationElsewhere(
          sessionId: c.canLeave ? c.sessionId! : (ownThere ? own.id : ''),
          campaignId: c.campaignId,
          campaignName: c.campaignName,
          stateLabel: agentStateLabel(c.state, c.stateRaw),
          canLeave: !conflictIsMidCall(c.state),
          accountId: c.canLeave ? c.accountId : null,
          accountName: c.accountName,
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

  Future<void> _open(HostedSession hosted) async {
    await _closeSession();
    final bootstrap = hosted.bootstrap;
    _station = bootstrap == null || bootstrap.campaignStatus == CampaignStatus.running
        ? StationState.initial
        : stationReducer(StationState.initial, const CampaignStateAction(dialing: false));
    _catalog = hosted.catalog;
    _breakReasons = hosted.breakReasons;

    final s = _Session(hosted);
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
      mintToken: () async => (await _api.mintStationToken(hosted.sessionId)).stationWsUrl,
      refreshIdToken: () async {
        await tokens.idToken(forceRefresh: true);
      },
      initialUrl: hosted.stationWsUrl,
      initialUrlExpiresAt: hosted.stationTokenExpiresAt,
      heartbeat: hosted.intervals.heartbeat,
      clientHeader: ref.read(clientIdentityProvider).header,
      onFrame: _onFrame,
      onPong: _onPong,
      onBinary: (bytes) {
        _calls.media.binaryIn++;
        s.audio.playFrame(bytes);
      },
      onConnection: _onConnection,
      onMissedPings: (n) => _dispatch(MissedPingsAction(n)),
      // A soft-phone call on the line holds the socket as a campaign call does.
      callLive: () => _station.live != null || isCallPhase(_station.agentState) || isCallLive(_station.manualCall),
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

  /// Local teardown: socket, audio, listeners, notifications, wake lock. The
  /// only HTTP is the notes the autosave was still holding (bounded).
  Future<void> _closeSession({bool disposing = false}) async {
    final s = _s;
    if (s == null) return;
    _s = null;
    s.socket.dispose();
    s.stopListening();
    await s.notes.persistNow();
    // The last seconds of typing are sent, not dropped with the debounce.
    final notesSent = s.notes.flushNow(timeout: notesFlushTimeout);
    _resetSessionState();
    if (!disposing && ref.mounted) {
      state = null;
      _publishHost();
    }
    _setWakeLock(false);
    _setNotice(AwayNotice.none, null);
    await Future.wait([s.audio.close(), notesSent]);
    s.notes.dispose();
  }

  /// How long closing the station waits for the last notes to be sent.
  static const notesFlushTimeout = Duration(seconds: 2);

  /// How long signing out waits for the server to take the agent off duty.
  static const signOutLeaveTimeout = Duration(seconds: 4);

  /// Signing out: off duty whatever happens, so no customer is ever bridged
  /// to a phone showing the sign-in screen. Leaves the session (skipped when
  /// the server already ended it or another device holds it), then closes the
  /// socket, the on-duty service and the audio. A failed leave is logged, not
  /// a reason to stay: closing the socket is what the server sees next.
  ///
  /// Returns false, and changes nothing, only when the server refuses because
  /// a call went live in the meantime: the sign-out waits for it to end.
  Future<bool> leaveForSignOut() async {
    final s = _s;
    if (s == null) return true;
    if (!_terminal) {
      _inFlight.add(StationBusy.leaving);
      _emit();
      try {
        await _api.leave(s.id, timeout: signOutLeaveTimeout);
      } on ApiError catch (e) {
        final code = e is ApiHttpError ? e.code : null;
        if (code == AgencyErrorCode.agentOnLiveCall.wire || code == 'manual_call_live') {
          _log.warn('sign-out held: a call went live before the station was left');
          if (identical(_s, s)) {
            _inFlight.remove(StationBusy.leaving);
            _emit();
          }
          return false;
        }
        if (!_alreadyLeft(e)) _log.warn('leaving for sign-out failed; closing anyway', {'error': e.runtimeType.toString()});
      } catch (e) {
        _log.warn('leaving for sign-out failed; closing anyway', {'error': e.runtimeType.toString()});
      }
    }
    if (identical(_s, s)) await _closeSession();
    return true;
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
    _awayQueueFailed = false;
    _awayLanded = false;
    _awayClosed = false;
    _cancelAwayTimers();
    _upgradeRefused = false;
    _readySeen = false;
    _mapper = StationViewMapper();
    _ringMuted = false;
    _ringCallId = null;
    _manualHangupFailure = null;
    _cancelHeldCallCheck();
    _lastTargetId = null;
    _everOpened = false;
  }

  // ─── Frames ─────────────────────────────────────────────────────────────

  void _onFrame(StationFrame frame) {
    switch (frame) {
      case MediaFrame():
        // `media=pcm16` fallback only; `alaw8` media arrives as binary frames.
        _calls.media.jsonIn++;
        _s?.audio.playFrame(frame.decodePayload());
      case BinaryMediaFrame(:final bytes):
        _calls.media.binaryIn++;
        _s?.audio.playFrame(bytes);
      case ReadyFrame(:final activeWrapup):
        _reconnectDeadline = null;
        _reconnectWindow = null;
        final first = !_readySeen;
        _readySeen = true;
        final hosted = _s?.hosted;
        _dispatch(ReadyAction(
          frame,
          wrapup: activeWrapup == null ? null : openWrapup(activeWrapup, _station.clockOffsetMs, _now()),
          // The opening answer said the same thing moments ago, when the frame states nothing.
          breakReason: frame.breakReason ??
              (first && hosted != null && hosted.initialState == AgentState.onBreak ? hosted.initialBreakReason : null),
        ));
        // Back after a drop with a soft-phone call held: the server sends its
        // copy right after `ready` only while the call is unsettled, so one
        // that settled meanwhile sends nothing and would stay "live" here.
        if (!first && isCallUnsettled(_station.manualCall)) _startHeldCallCheck();
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
        _calls.campaignReserved(attempt);
        _dispatch(ReservedAction(attempt));
      case CountdownFrame(:final attemptId, :final secondsRemaining):
        if (_station.live?.attemptId == attemptId) {
          _countdown = (attemptId: attemptId, seconds: secondsRemaining);
          _emit();
        }
      case BridgedFrame(:final attemptId, :final bridgedAt):
        _countdown = null;
        _calls.campaignBridged(attemptId);
        _dispatch(BridgedAction(attemptId, bridgedAt));
      case ReleasedFrame():
        _countdown = null;
        _lastRelease = frame;
        if (!isKnownReleaseReason(frame.reason)) _log.warn('unknown release reason', {'reason': frame.reasonRaw});
        _calls.campaignReleased(frame);
        _dispatch(ReleasedAction(frame, at: _now(), retain: _station.live?.attempt));
      case CampaignStateFrame(:final dialing, :final message):
        _dispatch(CampaignStateAction(dialing: dialing, message: message));
      case StationErrorFrame():
        _log.warn('station error frame', {'code': frame.codeRaw});
        _dispatch(ErrorAction(frame));
      case ManualCallFrame(:final manualCall):
        if (manualCall == null) {
          // A row this build cannot read: never fatal, never logged whole (it can hold contact data).
          _log.warn('unreadable manual_call frame', {'id': frame.id ?? ''});
          break;
        }
        // The server's own word on the call: nothing left to check.
        _cancelHeldCallCheck();
        _dispatch(ManualCallAction(manualCall));
      case PongFrame():
        // The socket hands pongs to [_onPong] itself; none arrive here.
        break;
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
    final s = _s;
    final refusedNow = s != null && closeCode == StationCloseCode.invalidUpgrade.code && !_upgradeRefused;
    if (refusedNow) {
      _upgradeRefused = true;
      _fatal = upgradeRefusedCopy;
      // Not left to linger as a joined agent who cannot connect: best effort.
      // Never while a soft-phone call is live or owes its outcome: the server
      // refuses the first, and leaving would let the outcome lapse (the agent
      // can still save it from another device, where the session rehydrates).
      if (!isCallUnsettled(_station.manualCall)) {
        unawaited(_api.leave(s.id).catchError((Object e) {
          _log.warn('leaving after a refused upgrade failed', {'error': e.runtimeType.toString()});
        }));
      }
    }
    final wasOpen = _station.connection == StationConnection.open;
    if (connection == StationConnection.open) _everOpened = true;
    if (connection == StationConnection.reconnecting && wasOpen && (_station.live != null || _manualAnswered)) {
      // The server holds a live call this long for the same session to come
      // back. A soft-phone call only once answered: one still ringing is
      // ended by the server at once, so there is nothing to count down to.
      final hold = _s?.hosted.intervals.deferredHangup ?? const Duration(seconds: 8);
      _reconnectDeadline = _now().add(hold);
      _reconnectWindow = hold;
    } else if (connection != StationConnection.reconnecting) {
      _reconnectDeadline = null;
      _reconnectWindow = null;
    }
    _dispatch(ConnectionAction(connection));
    if (refusedNow) _afterChange();
    if (s != null && identical(_s, s) && _terminal) _letGo(s, keepSocket: connection == StationConnection.superseded);
  }

  /// The station is over on this phone (see [_terminal]): the on-duty
  /// service, the audio, the wake lock and the notices go at once, so the
  /// notification never says "Waiting for calls" for a station this phone no
  /// longer holds. The view stays, so the screen can say why. After 4409 the
  /// socket is kept for "Use this phone" ([useThisDevice] starts the audio
  /// again); otherwise the socket and the listeners go too and the notes held
  /// are sent. [dismiss] or the next start closes the rest.
  void _letGo(_Session s, {required bool keepSocket}) {
    _cancelAwayTimers();
    _cancelHeldCallCheck();
    _setWakeLock(false);
    _setNotice(AwayNotice.none, null);
    unawaited(s.audio.close());
    if (keepSocket) return;
    s.socket.dispose(reason: 'over');
    s.stopListening();
    unawaited(s.notes.persistNow().then((_) => s.notes.flushNow(timeout: notesFlushTimeout)));
  }

  void _sendUplink(Uint8List frame) {
    if (_s?.socket.sendBinary(frame) ?? false) {
      _calls.media.sent++;
    } else {
      _calls.media.unsent++;
    }
  }

  /// The call events and their audio counts (`call_telemetry.dart`).
  CallTelemetry get _calls => CallTelemetry.instance;

  // ─── State plumbing ─────────────────────────────────────────────────────

  void _dispatch(StationAction action) {
    final next = stationReducer(_station, action);
    if (identical(next, _station)) return;
    final manualBefore = _station.manualCall;
    _station = next;
    if (!identical(next.manualCall, manualBefore)) _calls.manualChanged(next.manualCall);
    _afterChange();
  }

  String? get _pendingBreakCode {
    final o = _breakOverride;
    return o != null && o.atStatement == _station.pendingBreakStatements ? o.code : _station.pendingBreakCode;
  }

  /// The HTTP answer's view of the queue, until the next frame states it.
  void _writeQueue(String? code) => _breakOverride = (code: code, atStatement: _station.pendingBreakStatements);

  /// The station is over on this phone: the server ended the session (4404),
  /// another device took it (4409), or the server refuses this app's socket
  /// (1008). Nothing here may act on a call any more.
  bool get _terminal =>
      _station.connection == StationConnection.sessionGone ||
      _station.connection == StationConnection.superseded ||
      _upgradeRefused;

  void _afterChange() {
    final s = _s;
    if (s == null) return;
    final held = _lastStateResponse;
    if (held != null && _station.agentStateSince == null && held.state == _station.agentState) {
      _station = stationReducer(_station, SessionStateAction(held));
    }
    if (_saved != null && _saved!.attemptId != _station.currentAttemptId) _saved = null;
    if (_dncOutcome != null && _dncOutcome!.attemptId != _station.currentAttemptId) _dncOutcome = null;
    // The ring's mute belongs to one call: the next one rings again.
    final callId = _station.manualCall?.id;
    if (callId != _ringCallId) {
      _ringCallId = callId;
      _ringMuted = false;
    }

    final target = _audioTarget();
    _lastTargetId = target.attemptId;
    s.audio.sync(target);
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
      _publishHost();
      return;
    }
    if (s.hosted.isSoftphone) {
      // No campaign view: the soft phone reads the host view. The offset still
      // moves with the view's hysteresis, for the notification's call timer.
      _mapper.applyOffset(_station.clockOffsetMs);
      s.audio.updateNotification(_onDutyNotification());
      state = null;
      _publishHost();
      return;
    }
    final missed = _station.missedRelease;
    final view = _mapper.map(
      campaignId: s.hosted.campaignId!,
      campaignName: s.hosted.campaignName ?? '',
      sessionId: s.id,
      s: _station,
      bootstrap: s.hosted.bootstrap,
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
    // After the mapper, so the notification's call timer uses the offset the
    // view settled on (with its hysteresis), not every pong's raw estimate.
    s.audio.updateNotification(_onDutyNotification());
    state = view;
    _publishHost();
  }

  /// Writes the shell's signals and the soft phone's view of the session.
  void _publishHost() {
    if (!ref.mounted) return;
    final s = _s;
    ref.read(stationHostProvider.notifier).set(
          s == null
              ? StationHost.none
              : StationHost(
                  signals: hostSignalsOf(
                    kind: s.hosted.signalKind,
                    campaignId: s.hosted.campaignId,
                    state: _station,
                    // Ended (4404), taken by another device (4409), or unable to open
                    // here: the call moved with the session, so nothing is held.
                    over: _terminal || _fatal != null,
                  ),
                  softphone: _softphoneView(s),
                ),
        );
  }

  SoftphoneHostView _softphoneView(_Session s) {
    final call = _station.manualCall;
    return SoftphoneHostView(
      sessionId: s.id,
      kind: s.hosted.kind,
      accountId: s.hosted.accountId,
      campaignId: s.hosted.campaignId,
      campaignName: s.hosted.bootstrap?.campaignName ?? s.hosted.campaignName,
      link: StationViewMapper.linkOf(_station.connection),
      everOpened: _everOpened,
      phase: StationViewMapper.phaseOf(_station.agentState),
      onSoftphone: _onSoftphoneBreak,
      switchQueued: _pendingBreakCode == softphoneBreakReason,
      call: call,
      clockOffsetMs: _mapper.appliedOffsetMs,
      audio: s.audio.view,
      ringMuted: _ringMuted,
      reconnectDeadline: isCallLive(call) ? _reconnectDeadline : null,
      hangupFailure: _hangupFailureFor(call),
    );
  }

  /// The failed system hang-up, while the call it was for is still on the line.
  String? _hangupFailureFor(ManualCall? call) {
    final failure = _manualHangupFailure;
    if (failure == null || call == null || call.id != failure.callId || !call.isLive) return null;
    return failure.text;
  }

  /// On the `soft_phone` break: always, for a soft-phone session once its
  /// socket says so; for a campaign station, once the switch applied.
  bool get _onSoftphoneBreak =>
      _station.agentState == AgentState.onBreak && _station.breakReasonCode == softphoneBreakReason;

  /// A soft-phone call is on the line and the customer has answered: the
  /// server holds it [StationIntervals.deferredHangup] for a dropped socket.
  bool get _manualAnswered {
    final call = _station.manualCall;
    if (call == null || !call.isLive) return false;
    return call.answeredAt != null ||
        call.bridgedAt != null ||
        call.state == AttemptState.answered ||
        call.state == AttemptState.bridged;
  }

  /// The audio's call: a campaign attempt wins (the two cannot both be live on
  /// one session, so a held manual copy beside an attempt is stale), else a
  /// soft-phone call on the line (a port of the console's `audioTarget`).
  AudioTarget _audioTarget() {
    final manual = _station.manualCall;
    // How the call the audio last held ended, in that call's own terms.
    final previous = _lastTargetId;
    final endReason = previous != null && manual != null && previous == manual.id && !manual.isLive
        ? _manualEndReasonFor(manual.endReason)
        : _endReasonFor(_lastRelease);
    // Superseded: the call moved with the session to the other device.
    if (_terminal) return AudioTarget(endReason: endReason);
    final live = _station.live;
    if (live == null) {
      if (manual == null || !manual.isLive) return AudioTarget(endReason: endReason);
      final name = _cachedName(manual.id, () => contactName(manual, _contextDisplayFor(manual)));
      return AudioTarget(
        attemptId: manual.id,
        // Only `bridged_at` opens the uplink: audio is live both ways from there.
        bridged: manual.bridgedAt != null,
        displayName: name ?? manual.destinationE164,
        handle: manual.destinationE164,
        endReason: endReason,
        ringback: manual.state == AttemptState.ringing && manual.bridgedAt == null && !_ringMuted,
      );
    }
    final name = _cachedName(live.attemptId, () => displayNameFor(live.attempt.context, _s?.hosted.contextDisplay));
    return AudioTarget(
      attemptId: live.attemptId,
      bridged: live.bridgedAt != null,
      displayName: name ?? live.attempt.phoneE164,
      handle: live.attempt.phoneE164,
      endReason: endReason,
    );
  }

  /// The contact's name for CallKit, worked out once per call (a campaign
  /// attempt's id or a soft-phone call's), not on every frame and pong.
  String? _cachedName(String callId, String? Function() derive) {
    final cached = _nameCache;
    if (cached != null && cached.attemptId == callId) return cached.name;
    final name = derive();
    _nameCache = (attemptId: callId, name: name);
    return name;
  }

  /// The column settings a soft-phone call's contact is read through: the
  /// hosted campaign's, for a call tagged to it. Otherwise none is held here
  /// (the soft phone's bootstrap has them), and the row's own column names
  /// are read as they are: the settings only hide and order columns, and the
  /// name must be known before CallKit is first told about the call, which
  /// cannot rename it afterwards.
  ContextDisplay? _contextDisplayFor(ManualCall call) {
    final hosted = _s?.hosted;
    final tag = call.tag;
    if (hosted == null || tag == null || tag.campaignId != hosted.campaignId) return null;
    return hosted.contextDisplay;
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

  static audio.CallEndReason _manualEndReasonFor(ManualCallEndReason? reason) => switch (reason) {
        ManualCallEndReason.agentHangup => audio.CallEndReason.local,
        ManualCallEndReason.noAnswer => audio.CallEndReason.unanswered,
        ManualCallEndReason.busy ||
        ManualCallEndReason.failed ||
        ManualCallEndReason.invalid ||
        ManualCallEndReason.agentDisconnected ||
        ManualCallEndReason.orphaned =>
          audio.CallEndReason.failed,
        _ => audio.CallEndReason.remoteEnded,
      };

  audio.OnDutyNotification _onDutyNotification() {
    final s = _s;
    if (s != null && (s.hosted.isSoftphone || _onSoftphoneBreak)) return _softphoneNotification(s);
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
    // After 4404/4409 the call is not this phone's: no Mute or Hang up for it.
    final live = _terminal ? null : _station.live;
    return audio.OnDutyNotification(
      title: s == null ? 'On duty' : 'On duty · ${s.hosted.campaignName}',
      text: text,
      channelName: 'On duty',
      call: live == null ? null : _notificationCall(s, live.bridgedAt),
    );
  }

  /// The soft phone's notification: "Soft phone" for a soft-phone session
  /// (the service runs for the session's whole life), the station's title for
  /// a campaign station on the soft phone. Mute and Hang up while a call is on
  /// the line; Hang up there acts at once ([hangUp]).
  audio.OnDutyNotification _softphoneNotification(_Session s) {
    final call = _terminal ? null : _station.manualCall;
    final text = switch (softphonePhase(call)) {
      SoftphonePhase.ready => softphoneReadyNotificationText,
      SoftphonePhase.dialing || SoftphonePhase.ringing => softphoneCallingNotificationText,
      SoftphonePhase.onCall => softphoneOnCallNotificationText,
      SoftphonePhase.outcome => softphoneOutcomeNotificationText,
    };
    return audio.OnDutyNotification(
      title: s.hosted.isSoftphone ? softphoneNotificationTitle : 'On duty · ${s.hosted.campaignName}',
      text: text,
      channelName: 'On duty',
      call: call != null && call.isLive ? _notificationCall(s, call.bridgedAt) : null,
    );
  }

  audio.OnDutyCall _notificationCall(_Session? s, DateTime? bridgedAt) => audio.OnDutyCall(
        muted: s?.audio.view.muted ?? false,
        muteLabel: 'Mute',
        unmuteLabel: 'Unmute',
        hangUpLabel: 'Hang up',
        connectedAt: correctedInstant(bridgedAt, _mapper.appliedOffsetMs),
      );


  // ─── Lifecycle ──────────────────────────────────────────────────────────

  /// How long the app keeps asking for the away pause before it closes the
  /// station socket instead (see [_maybeSendAway]).
  static const awayPauseBound = Duration(seconds: 10);

  /// The waits between asks for the away pause (the last one repeats) until
  /// [awayPauseBound].
  static const awayRetryDelays = [Duration(seconds: 1), Duration(seconds: 2), Duration(seconds: 3)];

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
    _cancelAwayTimers();
    final queuedFor = _awayQueuedFor;
    // Asked for, never confirmed, and the socket was not closed for it: the
    // server may still say `available` with the lease long lapsed (app pings
    // stop while away), which never rings. Said again below.
    final unconfirmed = _awayPauseRequested && !_awayLanded && !_awayInFlight && !_awayClosed;
    _awayQueuedFor = null;
    _awayQueueFailed = false;
    _awayKey = null;
    _awayClosed = false;
    _awayRetries = 0;
    if (queuedFor != null &&
        _pendingBreakCode == ReservedBreakCode.deviceAway.wire &&
        isCallPhase(_station.agentState)) {
      // Back before the call ended: the pause queued for after it is not wanted.
      _cancelAwayQueue(s);
    }
    // Android starts the on-duty service only from the foreground: one that
    // failed (the join finished after the agent switched apps) starts now.
    s.audio.resumed();
    final c = _station.connection;
    // A give-up is the agent's to undo (Reconnect), except a silent one:
    // that is worth one clean try, as when the network comes back.
    if (c == StationConnection.reconnecting ||
        (c == StationConnection.disconnected && s.socket.gaveUpCause == 'heartbeat')) {
      s.socket.reconnect();
    } else if (unconfirmed &&
        c == StationConnection.open &&
        !_terminal &&
        _station.agentState == AgentState.available) {
      _log.info('back: the away pause never landed, so available is said again');
      unawaited(_api.available(s.id).then((r) {
        if (identical(_s, s)) _reconcile(r);
      }, onError: (Object e) => _log.warn('re-asserting available failed', {'error': e.runtimeType.toString()})));
    }
    _afterChange();
  }

  void _cancelAwayQueue(_Session s) {
    _awayQueuedFor = null;
    _awayPauseRequested = false;
    unawaited(_api.cancelBreak(s.id).then((r) {
      if (!identical(_s, s)) return;
      _writeQueue(r?.pendingState != null ? r?.breakReason : null);
      _afterChange();
    }, onError: (Object e) => _log.warn('cancelling the away pause failed', {'error': e.runtimeType.toString()})));
  }

  void _cancelAwayTimers() {
    _awayRetry?.cancel();
    _awayRetry = null;
    _awayDeadline?.cancel();
    _awayDeadline = null;
  }

  void _applyLifecycle(_Session s) {
    final st = _station.agentState;
    // A soft-phone call live or owing its outcome keeps the socket wanted in
    // the background, as a call or wrap-up does (the agent state stays `break`).
    final manual = _terminal ? null : _station.manualCall;
    final manualHeld = isCallUnsettled(manual);
    s.socket.setAppPings(appPingsWanted(foreground: _foreground, state: st, manualCall: manualHeld) && !_terminal);
    s.socket.setKeepAlive(keepAliveWanted(foreground: _foreground, state: st, manualCall: manualHeld));
    if (!_foreground) _maybeSendAway();
    _setWakeLock(wakeLockWanted(
      onDuty: !_terminal,
      foreground: _foreground,
      idleSoftphone: s.hosted.isSoftphone && !manualHeld,
    ));
    final outcomeDue = manual != null && manual.owesOutcome
        ? correctedInstant(manual.outcomeDueAt, _mapper.appliedOffsetMs)
        : null;
    final notice = _terminal
        ? AwayNotice.none
        : awayNoticeFor(
            st,
            foreground: _foreground,
            breakCode: _station.breakReasonCode ??
                (st == AgentState.onBreak && _awayPauseRequested ? ReservedBreakCode.deviceAway.wire : null),
            pauseRequested: _awayPauseRequested,
            wrapupDeadline: _station.wrapup?.deadline,
            outcomeDueAt: outcomeDue,
          );
    // Not in wrap-up, the deadline is the soft-phone call's outcome.
    final wrapup = st == AgentState.wrapup;
    _setNotice(
      notice,
      notice == AwayNotice.wrapupDeadline ? (wrapup ? _station.wrapup?.deadline : outcomeDue) : null,
      softphoneOutcome: notice == AwayNotice.wrapupDeadline && !wrapup,
    );
  }

  /// While away, asks for the `device_away` pause (now, or queued behind a
  /// call). A pause asked for at once that fails (`state_changing`, 429, 5xx,
  /// no network) is asked for again on [awayRetryDelays]: with app pings off
  /// and nothing changing, nothing else would ask, and the station socket
  /// stays open on protocol pings alone, so the agent would stay dialable. If
  /// it has not landed within [awayPauseBound] (or is refused outright) while
  /// the agent is still `available`, the socket is closed instead: the
  /// server's close handler takes the agent out of the pool at once, and the
  /// app reconnects on return. A queued pause that fails is asked for again
  /// on the next change (the call keeps the app pinging meanwhile).
  void _maybeSendAway() {
    final s = _s;
    if (s == null || _foreground || _awayInFlight || _terminal || _awayClosed || _awayRetry != null) return;
    final st = _station.agentState;
    // A soft-phone session is never in the pool: nothing to pause.
    final action = awayActionFor(st, pendingBreakCode: _pendingBreakCode, softphoneSession: s.hosted.isSoftphone);
    if (action == AwayAction.none) return;
    // One queued pause per away period: the call it was queued behind may end
    // (no attempt on screen) before the state moves on.
    if (action == AwayAction.queuePause && _awayQueuedFor != null && !_awayQueueFailed) return;
    final key = action == AwayAction.pauseNow
        ? 'now:${st.wire}:${_station.agentStateSince?.millisecondsSinceEpoch}'
        : 'queue:${_station.currentAttemptId}';
    if (key == _awayKey) return;
    _awayKey = key;
    _awayInFlight = true;
    if (action == AwayAction.pauseNow) {
      if (!_awayPauseRequested || _awayLanded) {
        // A new pause to deliver: the bound starts now.
        _awayRetries = 0;
        _awayDeadline?.cancel();
        _awayDeadline = Timer(awayPauseBound, () => _awayOverdue(s));
      }
      _awayPauseRequested = true;
      _awayLanded = false;
    } else {
      _awayQueuedFor = _station.currentAttemptId ?? '';
      _awayQueueFailed = false;
    }
    _log.info('left the app: pausing', {'state': st.wire, 'queued': action == AwayAction.queuePause});
    unawaited(_api
        .takeBreak(s.id, ReservedBreakCode.deviceAway.wire, timeout: const Duration(seconds: 5))
        .then((response) {
      _awayInFlight = false;
      if (!identical(_s, s)) return;
      if (action == AwayAction.pauseNow) {
        _awayLanded = true;
        _cancelAwayTimers();
      }
      if (response != null) {
        if (response.pendingState != null) {
          _writeQueue(response.breakReason ?? ReservedBreakCode.deviceAway.wire);
          // Queued, whichever ask it was (a pause asked for at once lands
          // queued when a call was reserved meanwhile): coming back cancels it.
          _awayQueuedFor = _station.currentAttemptId ?? '';
          _awayQueueFailed = false;
        }
        _lastStateResponse = response;
      }
      if (_foreground && _awayQueuedFor != null && response?.pendingState != null && isCallPhase(_station.agentState)) {
        // The agent came back while this was in flight: the queued pause is not wanted.
        _cancelAwayQueue(s);
      }
      _afterChange();
    }, onError: (Object e) {
      _awayInFlight = false;
      if (!identical(_s, s)) return;
      _log.warn('device_away pause failed', {'error': e.runtimeType.toString(), 'queued': action == AwayAction.queuePause});
      if (action == AwayAction.queuePause) {
        // Asked for again on the next change. Its marker stays: a request
        // that timed out may still have landed, and coming back must cancel it.
        _awayKey = null;
        _awayQueueFailed = true;
        return;
      }
      if (_foreground) {
        _awayKey = null;
        return;
      }
      if (!_awayRetryable(e)) {
        _awayOverdue(s);
        return;
      }
      // Until it lands or [awayPauseBound] runs out (the deadline closes the socket).
      final delay = awayRetryDelays[_awayRetries < awayRetryDelays.length ? _awayRetries : awayRetryDelays.length - 1];
      _awayRetries++;
      _awayRetry = Timer(delay, () {
        _awayRetry = null;
        if (!identical(_s, s)) return;
        _awayKey = null;
        _maybeSendAway();
      });
    }));
  }

  static bool _awayRetryable(Object e) =>
      e is ApiNetworkError ||
      (e is ApiHttpError &&
          (e.isServerError || e.status == 429 || e.code == AgencyErrorCode.stateChanging.wire));

  /// The away pause did not land in time (or was refused): when the agent is
  /// still dialable, close the station socket so the server takes them out
  /// of the pool now rather than when the `available` lease lapses.
  void _awayOverdue(_Session s) {
    _cancelAwayTimers();
    if (!identical(_s, s) || _foreground || _terminal || _awayLanded || _awayClosed) return;
    // Only a socket that is open still holds the agent in the pool: one that
    // already dropped (or gave up) was released by the server's close handler.
    if (_station.agentState != AgentState.available || _station.connection != StationConnection.open) return;
    _awayClosed = true;
    _log.warn('device_away pause never landed: closing the station until the app is back');
    s.socket.park();
  }

  void _setWakeLock(bool on) {
    if (on == _wakeLockOn) return;
    _wakeLockOn = on;
    unawaited(_wakeLock.set(on).catchError((Object e) {
      _log.warn('wake lock failed', {'error': e.runtimeType.toString()});
    }));
  }

  void _setNotice(AwayNotice notice, DateTime? deadline, {bool softphoneOutcome = false}) {
    if (notice == _notice && deadline == _noticeDeadline && softphoneOutcome == _noticeSoftphone) return;
    _notice = notice;
    _noticeDeadline = deadline;
    _noticeSoftphone = softphoneOutcome;
    unawaited(switch (notice) {
      AwayNotice.none => _notifier.cancel(),
      AwayNotice.paused => _notifier.showPaused(),
      AwayNotice.wrapupDeadline when softphoneOutcome => _notifier.showSoftphoneOutcomeDeadline(deadline!),
      AwayNotice.wrapupDeadline => _notifier.showWrapupDeadline(deadline!),
    });
  }

  // ─── Actions ────────────────────────────────────────────────────────────

  /// Single-flight per action: a second press of the same action while the
  /// first is in flight does nothing, and nothing runs while leaving. Hang-up
  /// is never held up behind another action (a CallKit end must always go).
  ///
  /// A body writes nothing after an await once [_s] is no longer its session
  /// ([_live]): a late answer must never land in the next station.
  Future<void> _run(StationBusy kind, Future<void> Function(_Session s) body) async {
    final s = _s;
    if (s == null || _inFlight.contains(kind) || _inFlight.contains(StationBusy.leaving)) return;
    _inFlight.add(kind);
    _actionError = null;
    _emit();
    try {
      await body(s);
    } catch (e, st) {
      // Nothing failed silently: an error the action did not foresee still
      // tells the agent it did not go through (an outcome left unsaved must
      // never look saved).
      _log.error('station action failed', {'action': kind.name}, e, st);
      if (identical(_s, s)) _actionError = e is ApiError ? e.userMessage : actionFailedCopy;
    } finally {
      if (identical(_s, s)) {
        _inFlight.remove(kind);
        _emit();
      }
    }
  }

  static String? _serverSentence(Object e) => e is ApiHttpError && e.message.trim().isNotEmpty ? e.message.trim() : null;

  /// Whether [s] is still the station on screen.
  bool _live(_Session s) => identical(_s, s);

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
          final r = await _api.available(s.id);
          if (_live(s)) _reconcile(r);
        } on ApiError catch (e) {
          // Shown as received: "Submit a disposition for your last call before going available."
          if (_live(s)) _actionError = _serverSentence(e) ?? presenceFailedCopy;
        }
      });

  @override
  Future<void> endBreak() => _run(StationBusy.endingBreak, (s) async {
        try {
          final r = await _api.available(s.id);
          if (_live(s)) _reconcile(r);
        } on ApiError catch (e) {
          if (_live(s)) _actionError = _serverSentence(e) ?? presenceFailedCopy;
        }
      });

  @override
  Future<void> takeBreak(String code) => _run(StationBusy.takingBreak, (s) async {
        try {
          final r = await _api.takeBreak(s.id, code);
          if (!_live(s)) return;
          _writeQueue(r?.pendingState != null ? (r?.breakReason ?? code) : null);
          _reconcile(r);
        } on ApiError catch (e) {
          if (!_live(s)) return;
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
          if (!_live(s)) return;
          _writeQueue(r?.pendingState != null ? r?.breakReason : null);
          _reconcile(r);
        } on ApiError catch (e) {
          if (!_live(s)) return;
          if (errorCodeOf(e) == AgencyErrorCode.breakAlreadyApplied) {
            _writeQueue(null);
            _actionError = breakAlreadyStartedCopy;
          } else {
            _actionError = cancelBreakFailedCopy;
          }
        }
      });

  /// The station's hang-up, and the system's (CallKit, the notification): a
  /// campaign attempt, or with none a soft-phone call on the line, which the
  /// system controls end at once ([hangUpManual]).
  @override
  Future<void> hangUp() async {
    // After 4404/4409 the call (if any) is another device's or already gone:
    // a stale notification or CallKit button must never end it from here.
    if (_terminal) return;
    final attemptId = _station.live?.attemptId;
    if (attemptId == null) {
      if (isCallLive(_station.manualCall)) await hangUpManual();
      return;
    }
    await _run(StationBusy.hangingUp, (s) async {
      try {
        await _api.hangup(attemptId);
      } on ApiError catch (e) {
        if (_live(s) && _station.live?.attemptId == attemptId) _actionError = hangupFailureCopy(e);
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
        // The text the outcome was built from: anything typed since is newer.
        s.notes.savedWithDisposition(attemptId, text);
        if (!_live(s)) return;
        final current = _station.currentAttemptId;
        if (r.attemptId != attemptId || (current != null && current != attemptId)) {
          // Saved, but for a call no longer on screen: nothing to show about it.
          _log.info('disposition answer for an earlier call discarded');
          return;
        }
        _saved = (attemptId: attemptId, code: code);
      } on ApiError catch (e) {
        if (!_live(s)) return;
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
  Future<void> markDnc({String? reason, String? attemptId}) async {
    if (_s == null) return;
    final live = _terminal ? null : _station.live?.attemptId;
    if (live == null || (attemptId != null && attemptId != live)) {
      // No call, or not the one the agent confirmed for: the next customer is
      // never marked for the last one's answer.
      _actionError = attemptId != null && live != null ? dncCallChangedCopy : dncNeedsCallCopy;
      _emit();
      return;
    }
    _dncOutcome = null;
    await _run(StationBusy.markingDnc, (s) async {
      try {
        final r = await _api.markDnc(live, DncRequest(reason: reason));
        _log.info('marked do not call', {'recorded': r.dncRecorded});
        if (_live(s) && _station.currentAttemptId == live) _dncOutcome = (attemptId: live, text: dncOutcomeCopy(r));
      } on ApiError catch (e) {
        if (_live(s) && _station.live?.attemptId == live) _actionError = dncFailureCopy(e);
      }
    });
  }

  @override
  Future<LeaveOutcome> leave() async {
    var outcome = LeaveOutcome.stayed;
    await _run(StationBusy.leaving, (s) async {
      try {
        await _api.leave(s.id);
      } on ApiNetworkError catch (e) {
        if (!_live(s)) return;
        if (_station.live != null || isCallPhase(_station.agentState)) {
          // Never with a call on: closing here would drop the customer.
          _actionError = e.userMessage;
          return;
        }
        // Offline, with no call: off the station here anyway. The socket
        // closing (or the server's silence grace) takes the agent off duty;
        // the session is reaped or picked up again as on any lost phone.
        _log.warn('leaving offline: closing the station on this phone only');
        outcome = LeaveOutcome.leftOffline;
        await _closeSession();
        return;
      } on ApiError catch (e) {
        if (!_live(s)) return;
        if (!_alreadyLeft(e)) {
          _actionError = _serverSentence(e) ?? e.userMessage;
          return;
        }
      }
      if (!_live(s)) return;
      outcome = LeaveOutcome.left;
      await _closeSession();
    });
    return outcome;
  }

  @override
  Future<void> reconnect() async {
    final s = _s;
    if (s == null) return;
    if (_station.connection != StationConnection.sessionGone) {
      s.socket.reconnect();
      return;
    }
    if (s.hosted.isSoftphone) {
      // The soft-phone session is over server-side: open it again (the server
      // rehydrates one that is still live, even with the flag off).
      final result = await openSoftphone();
      _fatal = switch (result) {
        SoftphoneOpened() => null,
        SoftphoneOpenRefused(:final message) => message,
        SoftphoneOpenDisabled() => softphoneDisabledCopy,
        SoftphoneOpenOnCampaign() => softphoneOnCampaignCopy,
        SoftphoneOpenElsewhere() => softphoneElsewhereCopy,
      };
      _emit();
      return;
    }
    // The session is over server-side: join again (a fresh session).
    final result = await start(s.hosted.campaignId!, campaignName: s.hosted.campaignName ?? '');
    _fatal = switch (result) {
      StationStarted() => null,
      StationRefused(:final message) => message,
      StationElsewhere(:final campaignName) => joinConflictRemedy(campaignName, AgentState.available),
      StationOnSoftphone() => softphoneCallPendingCopy,
    };
    _emit();
  }

  // ─── The soft phone (SoftphoneHostActions) ──────────────────────────────

  Future<SoftphoneOpenResult>? _openingSoftphone;

  /// Opens (or rehydrates) the soft-phone session in the current account and
  /// hosts it: the on-duty service ("Soft phone", for the session's whole
  /// life), the audio pre-warm and the socket. One open at a time: a second
  /// call while one is in flight gets the same answer.
  @override
  Future<SoftphoneOpenResult> openSoftphone() {
    final current = _s;
    if (current != null && current.hosted.isSoftphone && !_terminal && _fatal == null) {
      return Future.value(SoftphoneOpened(sessionId: current.id, created: false));
    }
    return _openingSoftphone ??= _openSoftphone().whenComplete(() => _openingSoftphone = null);
  }

  Future<SoftphoneOpenResult> _openSoftphone() async {
    final accountId = _softphoneApi.accountId;
    final SoftphoneSessionResponse response;
    try {
      response = await _softphoneApi.openSession();
    } on ApiError catch (e) {
      return _openRefusal(e);
    }
    if (!ref.mounted) return SoftphoneOpened(sessionId: response.sessionId, created: false);
    await _open(HostedSession.softphone(response, accountId: accountId));
    // The answer's status (201 / 200) does not reach here: "could not tell".
    return SoftphoneOpened(sessionId: response.sessionId, created: false);
  }

  static SoftphoneOpenResult _openRefusal(ApiError e) {
    if (e is! ApiHttpError) return SoftphoneOpenRefused(e.userMessage);
    final body = ErrorBody.fromJson(e.body);
    final onCampaign = body.sessionOnCampaign;
    if (onCampaign != null) return SoftphoneOpenOnCampaign(onCampaign);
    final elsewhere = body.softphoneConflict;
    if (elsewhere != null) return SoftphoneOpenElsewhere(elsewhere);
    if (body.softphoneCode == SoftphoneErrorCode.softphoneDisabled) return const SoftphoneOpenDisabled();
    final message = body.message.trim();
    return SoftphoneOpenRefused(
      message.isEmpty ? e.userMessage : message,
      code: body.softphoneCode == SoftphoneErrorCode.unknown ? null : body.softphoneCode,
      retryable: e.isServerError || e.status == 429,
    );
  }

  /// A port of the console's `closeSoftphoneSession` (`close_softphone.dart`):
  /// the bootstrap is read in the session's own account first, and nothing is
  /// closed while its call is live or owes its outcome. When the session
  /// closed is the one hosted here, it is torn down here too.
  @override
  Future<SoftphoneCloseResult> closeSoftphone({String? sessionId, String? accountId}) async {
    final own = _s;
    final id = sessionId ?? (own != null && own.hosted.isSoftphone ? own.id : null);
    // The hosted session is closed in the account it was opened in.
    final account = accountId ?? (own != null && id != null && own.id == id ? own.hosted.accountId : null);
    final outcome = await closeSoftphoneSession(
      readBootstrap: (a) => _softphoneApi.bootstrap(accountId: a),
      leave: (sessionId, a) => _api.leave(sessionId, accountId: a),
      currentAccountId: _softphoneApi.accountId,
      sessionId: id,
      sessionAccountId: account,
      heldCall: (sessionId) => _s?.id == sessionId ? _station.manualCall : null,
    );
    final result = outcome.result;
    if (result is SoftphoneCloseCallPending) {
      final call = result.call;
      if (call != null) adoptManualCall(call);
    }
    final closedId = outcome.closedId;
    final current = _s;
    if (closedId != null && current != null && current.id == closedId) await _closeSession();
    return result;
  }

  @override
  Future<SoftphoneSwitchResult> switchToSoftphone() => _switchAction(StationBusy.takingBreak, (s) async {
        final r = await _softphoneApi.switchToSoftphone(s.id, accountId: s.hosted.accountId);
        final queued = r.pendingState != null;
        if (_live(s)) {
          // Queued behind a call or wrap-up until the `agent_state` frame applies it.
          _writeQueue(queued ? (r.breakReason ?? softphoneBreakReason) : null);
          _reconcile(r);
        }
        return queued ? const SoftphoneSwitchQueued() : const SoftphoneSwitchApplied();
      });

  @override
  Future<SoftphoneSwitchResult> cancelSwitch() => _switchAction(StationBusy.cancellingBreak, (s) async {
        try {
          final r = await _api.cancelBreak(s.id);
          if (_live(s)) {
            _writeQueue(r?.pendingState != null ? r?.breakReason : null);
            _reconcile(r);
          }
          return const SoftphoneSwitchApplied();
        } on ApiError catch (e) {
          if (errorCodeOf(e) != AgencyErrorCode.breakAlreadyApplied) rethrow;
          if (_live(s)) _writeQueue(null);
          return const SoftphoneSwitchRefused(softphoneSwitchAlreadyAppliedCopy);
        }
      });

  @override
  Future<SoftphoneSwitchResult> returnToCampaign() => _switchAction(StationBusy.endingBreak, (s) async {
        final r = await _softphoneApi.returnToCampaign(s.id, accountId: s.hosted.accountId);
        if (_live(s)) {
          _writeQueue(r.pendingState != null ? r.breakReason : null);
          _reconcile(r);
        }
        return const SoftphoneSwitchApplied();
      });

  /// The SP7 actions on a campaign station: single-flight like the station's
  /// own, and every refusal in words (`dial_failed` there is the agent's
  /// status not changing, not a call failing to go out).
  Future<SoftphoneSwitchResult> _switchAction(
    StationBusy busy,
    Future<SoftphoneSwitchResult> Function(_Session s) body,
  ) async {
    final s = _s;
    if (s == null || s.hosted.isSoftphone || _terminal) return const SoftphoneSwitchRefused(softphoneNoStationCopy);
    SoftphoneSwitchResult? result;
    await _run(busy, (s) async {
      try {
        result = await body(s);
      } on ApiError catch (e) {
        result = _switchRefusal(e, s);
      }
    });
    return result ?? const SoftphoneSwitchRefused(actionFailedCopy);
  }

  SoftphoneSwitchResult _switchRefusal(ApiError e, _Session s) {
    if (e is! ApiHttpError) return SoftphoneSwitchRefused(e.userMessage);
    final body = ErrorBody.fromJson(e.body);
    // `manual_call_live` names the call that blocks the return: held here, so
    // the soft phone shows it rather than an error.
    final pending = body.callPending;
    if (pending != null && _live(s)) adoptManualCall(pending.call);
    final code = body.softphoneCode;
    return SoftphoneSwitchRefused(
      softphoneStatusRefusalCopy(code, _serverSentence(e)),
      code: code == SoftphoneErrorCode.unknown ? null : code,
      call: pending?.call,
    );
  }

  /// An HTTP answer's copy of this session's call, merged with what is held
  /// (`newerCall`, a frame winning a tie). A call of another session is not
  /// this host's to hold.
  @override
  void adoptManualCall(ManualCall call) {
    final s = _s;
    if (s == null || call.sessionId != s.id) return;
    _dispatch(ManualCallAdoptAction(call));
  }

  @override
  void retireManualCall(String versionKey) {
    if (_s == null) return;
    _dispatch(ManualCallRetireAction(versionKey));
  }

  /// The ring's mute, for the call on the line now; the next call rings again.
  @override
  void setRingMuted(bool muted) {
    if (_s == null || muted == _ringMuted) return;
    _ringMuted = muted;
    _ringCallId = _station.manualCall?.id;
    _afterChange();
  }

  /// A no-op: the host names the call itself, from the row, before CallKit
  /// is first told about it ([_contextDisplayFor]). The soft phone learns of a
  /// call only after the host has reported it, and CallKit (the engine has no
  /// update for a reported call) and the on-duty notification (which shows no
  /// name) have nothing to take a later name.
  @override
  void setCallDisplayName(String callId, String? name) {}

  /// Hangs up the soft-phone call on the line at once (the system controls:
  /// CallKit, the notification). The in-app button holds to confirm and goes
  /// through the soft phone instead.
  @override
  Future<void> hangUpManual() async {
    if (_terminal) return;
    final call = _station.manualCall;
    if (call == null || !call.isLive) return;
    if (_inFlight.contains(StationBusy.hangingUp)) return;
    _manualHangupFailure = null;
    await _run(StationBusy.hangingUp, (s) async {
      try {
        final r = await _softphoneApi.hangup(call.id, accountId: s.hosted.accountId);
        if (_live(s)) adoptManualCall(r);
      } on ApiError catch (e) {
        _log.warn('soft-phone hang-up failed', {'error': e.runtimeType.toString()});
        if (!_live(s) || _station.manualCall?.id != call.id || !isCallLive(_station.manualCall)) return;
        final code = refusalBodyOf(e)?.softphoneCode;
        if (code == SoftphoneErrorCode.callSettled || code == SoftphoneErrorCode.callNotFound) {
          // Over already, and no frame said so: the bootstrap says how it stands.
          _startHeldCallCheck(now: true);
          return;
        }
        // The soft phone's panel shows this (a soft-phone session has no
        // station view); a campaign station keeps its own banner too.
        _manualHangupFailure = (callId: call.id, text: softphoneHangupFailedCopy(softphoneErrorCopy(e)));
        _actionError = hangupFailureCopy(e);
        // CallKit ended the call on its side already: the call goes on, so
        // its controls and audio session must come back.
        s.audio.reportCallAgain();
      }
    });
  }

  // ─── A held soft-phone call after a reconnect ──────────────────────────

  /// The waits before each read that checks a held soft-phone call ([_checkHeldCall]);
  /// the last repeats while reads fail. The first is the grace for the
  /// `manual_call` frame the server sends right after `ready` for a call it still holds.
  static const heldCallCheckDelays = [
    Duration(seconds: 2),
    Duration(seconds: 4),
    Duration(seconds: 8),
    Duration(seconds: 16),
    Duration(seconds: 30),
  ];

  void _startHeldCallCheck({bool now = false}) {
    _cancelHeldCallCheck();
    final s = _s;
    if (now && s != null) {
      unawaited(_checkHeldCall(s));
    } else {
      _scheduleHeldCallCheck(heldCallCheckDelays.first);
    }
  }

  void _scheduleHeldCallCheck(Duration wait) {
    final s = _s;
    if (s == null) return;
    _heldCallTimer = Timer(wait, () => unawaited(_checkHeldCall(s)));
  }

  void _cancelHeldCallCheck() {
    _heldCallTimer?.cancel();
    _heldCallTimer = null;
    _heldCallFailures = 0;
    _heldCallCheck++;
  }

  /// Asks the bootstrap (in the session's own account) about the soft-phone
  /// call held here, so the ringback, CallKit, the microphone and the
  /// router's hold never wait on the soft-phone controller being alive. The
  /// server's copy is adopted; a held copy the server no longer has is
  /// retired by its version, so a frame that arrived meanwhile stands.
  /// Stops once answered, once the held copy settles, when the socket is not
  /// open (the next `ready` starts again) and when the session ends; a failed
  /// read is retried after [heldCallCheckDelays].
  Future<void> _checkHeldCall(_Session s) async {
    _heldCallTimer = null;
    if (!_live(s) || !ref.mounted || _terminal || _station.connection != StationConnection.open) return;
    final held = _station.manualCall;
    if (held == null || !held.isUnsettled) return;
    final check = _heldCallCheck;
    final SoftphoneBootstrap b;
    try {
      b = await _softphoneApi.bootstrap(accountId: s.hosted.accountId);
    } on ApiError catch (e) {
      if (!_live(s) || check != _heldCallCheck) return;
      _log.warn('checking the soft-phone call after a reconnect failed', {'error': e.runtimeType.toString()});
      final retry = e is! ApiHttpError || e.isServerError || e.status == 429;
      if (!retry) return;
      _heldCallFailures++;
      _scheduleHeldCallCheck(heldCallCheckDelays[_heldCallFailures.clamp(0, heldCallCheckDelays.length - 1)]);
      return;
    }
    if (!_live(s)) return;
    _heldCallFailures = 0;
    // Another session named: this one is not the server's live session, and
    // the socket's own close says so; nothing here to judge the call by.
    final session = b.session;
    if (session != null && session.sessionId != s.id) return;
    final call = b.call;
    if (call == null || call.id != held.id) retireManualCall(held.versionKey);
    if (call != null) adoptManualCall(call);
  }

  @override
  Future<void> useThisDevice() async {
    final s = _s;
    if (s == null || _station.connection != StationConnection.superseded) return;
    // The audio and the on-duty service were let go at 4409; the agent's tap
    // has the app on screen, where Android allows the service to start.
    s.audio.open(_onDutyNotification());
    s.socket.reconnect();
  }

  @override
  Future<void> dismiss() async {
    if (_s == null || !(_terminal || _fatal != null)) return;
    await _closeSession();
  }

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

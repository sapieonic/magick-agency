import 'dart:async';
import 'dart:convert';

import 'package:agency_wire/agency_wire.dart';
import 'package:fake_async/fake_async.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:magick_agency_agent/app/providers.dart';
import 'package:magick_agency_agent/core/api/api_client.dart';
import 'package:magick_agency_agent/core/auth/app_gate.dart';
import 'package:magick_agency_agent/core/session/account_choice.dart';
import 'package:magick_agency_agent/core/softphone/call_state.dart';
import 'package:magick_agency_agent/core/softphone/softphone_controller.dart';
import 'package:magick_agency_agent/core/softphone/softphone_host.dart';
import 'package:magick_agency_agent/core/softphone/softphone_view.dart';
import 'package:magick_agency_agent/core/station/station_deps.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';
import 'package:magick_agency_agent/features/performance/logic/stats_windows.dart';
import 'package:magick_agency_agent/features/preflight/preflight_checks.dart';

import '../station/controller_harness.dart' show FakeLifecycle, FakeTokens, json, testEnv;
import '../station/memory_notes_store.dart';
import 'manual_calls.dart';

/// The soft-phone core in a container, against a fake session host: the host's
/// view is a slot the test sets, and the host's actions are recorded (and, for
/// the ones that change the session, applied to the slot the way the station
/// controller applies them: the merge by `newerCall`, retirement by version
/// key, the ring mute and the microphone mute).

/// A soft-phone host view with test defaults (a connected soft-phone session in `a1`).
SoftphoneHostView hostView({
  String sessionId = 'sess-sp',
  SessionKind kind = SessionKind.softphone,
  String? accountId = 'a1',
  String? campaignId,
  String? campaignName,
  StationLink link = StationLink.open,
  bool everOpened = true,
  AgentPhase phase = AgentPhase.onBreak,
  bool onSoftphone = true,
  bool switchQueued = false,
  ManualCall? call,
  int clockOffsetMs = 0,
  AudioView audio = const AudioView(),
  bool ringMuted = false,
  DateTime? reconnectDeadline,
}) => SoftphoneHostView(
  sessionId: sessionId,
  kind: kind,
  accountId: accountId,
  campaignId: campaignId,
  campaignName: campaignName,
  link: link,
  everOpened: everOpened,
  phase: phase,
  onSoftphone: onSoftphone,
  switchQueued: switchQueued,
  call: call,
  clockOffsetMs: clockOffsetMs,
  audio: audio,
  ringMuted: ringMuted,
  reconnectDeadline: reconnectDeadline,
);

/// A campaign station on this phone (SP7), switched to the soft phone unless told otherwise.
SoftphoneHostView campaignHost({bool onSoftphone = true, String campaignId = 'camp-1', ManualCall? call}) => hostView(
  sessionId: 'sess-1',
  kind: SessionKind.campaign,
  campaignId: campaignId,
  campaignName: 'Home Loan Renewals',
  onSoftphone: onSoftphone,
  phase: onSoftphone ? AgentPhase.onBreak : AgentPhase.available,
  call: call,
);

/// [v] with some fields replaced (`clearCall` drops the call).
SoftphoneHostView copyHost(
  SoftphoneHostView v, {
  StationLink? link,
  bool? everOpened,
  ManualCall? call,
  bool clearCall = false,
  int? clockOffsetMs,
  AudioView? audio,
  bool? ringMuted,
  bool? switchQueued,
}) => SoftphoneHostView(
  sessionId: v.sessionId,
  kind: v.kind,
  accountId: v.accountId,
  campaignId: v.campaignId,
  campaignName: v.campaignName,
  link: link ?? v.link,
  everOpened: everOpened ?? v.everOpened,
  phase: v.phase,
  onSoftphone: v.onSoftphone,
  switchQueued: switchQueued ?? v.switchQueued,
  call: clearCall ? null : (call ?? v.call),
  clockOffsetMs: clockOffsetMs ?? v.clockOffsetMs,
  audio: audio ?? v.audio,
  ringMuted: ringMuted ?? v.ringMuted,
  reconnectDeadline: v.reconnectDeadline,
);

class _HostSlot extends Notifier<SoftphoneHostView?> {
  @override
  SoftphoneHostView? build() => null;
  void set(SoftphoneHostView? v) => state = v;
}

final _hostSlotProvider = NotifierProvider<_HostSlot, SoftphoneHostView?>(_HostSlot.new);

/// The session host, recorded.
class FakeSoftphoneHost implements SoftphoneHostActions {
  late void Function(SoftphoneHostView?) _publish;
  late SoftphoneHostView? Function() _read;

  final List<String> log = [];
  final List<ManualCall> adopted = [];
  final List<String> retired = [];
  final Map<String, String?> displayNames = {};

  /// What the next open answers; [SoftphoneOpened] also publishes [openedView].
  SoftphoneOpenResult openResult = const SoftphoneOpened(sessionId: 'sess-sp', created: true);
  SoftphoneHostView openedView = hostView();
  SoftphoneCloseResult closeResult = const SoftphoneClosed();
  SoftphoneSwitchResult switchResult = const SoftphoneSwitchApplied();
  SoftphoneSwitchResult returnResult = const SoftphoneSwitchApplied();
  SoftphoneSwitchResult cancelResult = const SoftphoneSwitchApplied();
  ({String? sessionId, String? accountId})? lastClose;

  SoftphoneHostView? get view => _read();
  set view(SoftphoneHostView? v) => _publish(v);

  /// A `manual_call` frame: merged with the frame's copy first, so it wins a tie.
  void frame(ManualCall call) {
    final v = view!;
    view = copyHost(v, call: newerCall(call, v.call));
  }

  int count(String name) => log.where((l) => l == name).length;

  @override
  Future<SoftphoneOpenResult> openSoftphone() async {
    log.add('open');
    final r = openResult;
    if (r is SoftphoneOpened) view = openedView;
    return r;
  }

  @override
  Future<SoftphoneCloseResult> closeSoftphone({String? sessionId, String? accountId}) async {
    log.add('close');
    lastClose = (sessionId: sessionId, accountId: accountId);
    final r = closeResult;
    if (r is SoftphoneClosed && sessionId == null) view = null;
    return r;
  }

  @override
  Future<SoftphoneSwitchResult> switchToSoftphone() async {
    log.add('switch');
    return switchResult;
  }

  @override
  Future<SoftphoneSwitchResult> cancelSwitch() async {
    log.add('cancelSwitch');
    return cancelResult;
  }

  @override
  Future<SoftphoneSwitchResult> returnToCampaign() async {
    log.add('return');
    return returnResult;
  }

  @override
  void adoptManualCall(ManualCall call) {
    adopted.add(call);
    final v = view;
    if (v == null) return;
    view = copyHost(v, call: newerCall(v.call, call));
  }

  @override
  void retireManualCall(String versionKey) {
    retired.add(versionKey);
    final v = view;
    if (v != null && v.call?.versionKey == versionKey) view = copyHost(v, clearCall: true);
  }

  @override
  void setRingMuted(bool muted) {
    log.add('ringMuted:$muted');
    final v = view;
    if (v != null) view = copyHost(v, ringMuted: muted);
  }

  @override
  void setCallDisplayName(String callId, String? name) => displayNames[callId] = name;

  @override
  Future<void> hangUpManual() async => log.add('hangUpManual');

  @override
  Future<void> setMuted(bool muted) async {
    log.add('micMuted:$muted');
    final v = view;
    if (v != null) {
      final a = v.audio;
      view = copyHost(
        v,
        audio: AudioView(muted: muted, route: a.route, routes: a.routes, micProblem: a.micProblem, interruption: a.interruption),
      );
    }
  }

  @override
  Future<void> setRoute(AudioRouteOption route) async => log.add('route:${route.id}');

  @override
  Future<void> reconnect() async => log.add('reconnect');

  @override
  Future<void> useThisDevice() async => log.add('useThisDevice');

  @override
  Future<void> dismiss() async => log.add('dismiss');
}

/// Starts a campaign station; recorded.
class FakeLauncher implements StationLauncher {
  final List<String> started = [];
  StationStart result = const StationStarted();

  @override
  Future<StationStart> start(String campaignId, {required String campaignName}) async {
    started.add(campaignId);
    return result;
  }

  @override
  Future<StationStart> leaveOtherAndStart(StationElsewhere other, String campaignId, {required String campaignName}) =>
      throw UnimplementedError();

  @override
  Future<StationStart> closeSoftphoneAndStart(
    StationOnSoftphone softphone,
    String campaignId, {
    required String campaignName,
  }) => throw UnimplementedError();
}

const chennai = AccountChoice(tenantId: 't1', tenantName: 'Acme', accountId: 'a1', accountName: 'Chennai');
const pune = AccountChoice(tenantId: 't1', tenantName: 'Acme', accountId: 'a2', accountName: 'Pune');

GateReady readyIn(AccountChoice account, {String userId = 'u-1', List<AccountChoice> accounts = const [chennai, pune]}) =>
    GateReady(
      userId: userId,
      displayName: 'Meera K',
      email: null,
      tenantId: account.tenantId,
      accountId: account.accountId,
      accountName: account.accountName,
      tenantName: account.tenantName,
      accounts: accounts,
    );

/// The gate, ready in one account; the account switch is the gate's own entry point, recorded.
class FakeGate extends AppGateNotifier {
  FakeGate(this.initial);
  final GateReady initial;
  final List<AccountChoice> switches = [];

  @override
  AppGate build() => initial;

  @override
  Future<void> switchAccount(AccountChoice choice) async {
    switches.add(choice);
    ref.read(requestScopeProvider).accountId = choice.accountId;
    final s = state as GateReady;
    state = readyIn(choice, userId: s.userId, accounts: s.accounts);
  }

  void set(AppGate gate) => state = gate;
}

/// The pre-flight's checks, reduced to the microphone's state.
class FakeMicChecks implements PreflightChecks {
  MicPermission mic = MicPermission.granted;
  int reads = 0;

  @override
  Future<MicPermission> microphone() async {
    reads++;
    return mic;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

/// Mumbai's fixed offset, so the hours prompt reads the same in any zone the suite runs in.
const ist = FixedOffsetCalendar(Duration(hours: 5, minutes: 30), 'IST');

/// One recorded HTTP request.
class Sent {
  Sent(this.method, this.path, this.query, this.headers, this.body);
  final String method;
  final String path;
  final Map<String, String> query;
  final Map<String, String> headers;

  /// The account the request was scoped to.
  String? get account => headers['x-account-id'];

  /// The decoded JSON body, or null.
  final Object? body;

  Map<String, Object?> get json => body! as Map<String, Object?>;

  @override
  String toString() => '$method $path';
}

typedef Reply = FutureOr<http.Response> Function(Sent request);

/// The soft-phone core with its outside world faked, on a fake clock.
class SoftphoneHarness {
  SoftphoneHarness(this.async, {GateReady? gate, SoftphoneHostView? host, bool foreground = true}) {
    final clock = async.getClock(DateTime.utc(2026, 10, 30, 10, 0, 30));
    now = clock.now;
    lifecycle.foreground = foreground;
    scope
      ..tenantId = 't1'
      ..accountId = (gate ?? readyIn(chennai)).accountId;
    container = ProviderContainer(
      overrides: [
        envProvider.overrideWithValue(testEnv),
        idTokenSourceProvider.overrideWithValue(tokens),
        httpClientProvider.overrideWithValue(MockClient(_handle)),
        requestScopeProvider.overrideWithValue(scope),
        stationUnauthorizedSinkProvider.overrideWithValue(unauthorized.add),
        notesStoreProvider.overrideWithValue(store),
        stationNowProvider.overrideWithValue(clock.now),
        softphoneLifecycleSourceProvider.overrideWithValue(lifecycle),
        softphoneCalendarProvider.overrideWithValue(ist),
        softphoneHostViewProvider.overrideWith((ref) => ref.watch(_hostSlotProvider)),
        softphoneHostActionsProvider.overrideWithValue(this.host),
        stationLauncherProvider.overrideWithValue(launcher),
        preflightChecksProvider.overrideWithValue(mic),
        appGateProvider.overrideWith(() => FakeGate(gate ?? readyIn(chennai))),
        ...softphoneOverrides,
      ],
    );
    this.host._publish = (v) => container.read(_hostSlotProvider.notifier).set(v);
    this.host._read = () => container.read(_hostSlotProvider);
    if (host != null) this.host.view = host;
    routes['GET /proxy/agency/softphone/bootstrap'] = (_) => json(200, bootstrapJson());
    routes['GET /proxy/agency/softphone/calls'] = (_) => json(200, {'rows': <Object?>[], 'next_cursor': null, 'limit': 8});
    // Listened, as the shell listens in the app: an unlistened provider's subscriptions are paused.
    container.listen<SoftphoneAvailability>(softphoneAvailabilityProvider, (_, a) => availabilities.add(a));
    container.listen<SoftphoneView>(softphoneViewProvider, (_, v) => views.add(v));
  }

  final FakeAsync async;
  late final DateTime Function() now;
  late final ProviderContainer container;
  final scope = RequestScope();
  final tokens = FakeTokens();
  final store = MemoryNotesStore();
  final lifecycle = FakeLifecycle();
  final host = FakeSoftphoneHost();
  final launcher = FakeLauncher();
  final mic = FakeMicChecks();
  final List<Object> unauthorized = [];
  final List<Sent> sent = [];
  final Map<String, Reply> routes = {};
  final List<SoftphoneAvailability> availabilities = [];
  final List<SoftphoneView> views = [];

  SoftphoneController get controller => container.read(softphoneControllerProvider.notifier);
  SoftphoneActions get actions => container.read(softphoneActionsProvider);
  SoftphoneView get view => container.read(softphoneViewProvider);
  SoftphoneAvailability get availability => container.read(softphoneAvailabilityProvider);
  FakeGate get gate => container.read(appGateProvider.notifier) as FakeGate;

  List<Sent> requests(String method, String path) => sent.where((r) => r.method == method && r.path == path).toList();
  List<Sent> get bootstraps => requests('GET', '/proxy/agency/softphone/bootstrap');
  List<Sent> get dials => requests('POST', '/proxy/agency/softphone/calls');
  List<Sent> patches(String callId) => requests('PATCH', '/proxy/agency/softphone/calls/$callId');

  /// Answers [path] (`METHOD /path`) with [body] at [status].
  void reply(String route, Object body, {int status = 200}) => routes[route] = (_) => json(status, body);

  /// Answers [route] with a soft-phone refusal.
  void refuse(String route, String code, {int status = 409, Map<String, Object?> extra = const {}}) =>
      reply(route, {'error': 'Conflict', 'code': code, 'message': 'Refused: $code', ...extra}, status: status);

  Future<http.Response> _handle(http.Request request) async {
    final body = request.body.isEmpty ? null : jsonDecode(request.body);
    final s = Sent(request.method, request.url.path, request.url.queryParameters, request.headers, body);
    sent.add(s);
    final reply = routes['${request.method} ${request.url.path}'];
    if (reply == null) return json(404, {'error': 'Not Found', 'message': 'no route ${request.url.path}'});
    return reply(s);
  }

  /// Lets every queued future and zero-delay timer run.
  void pump() {
    for (var i = 0; i < 10; i++) {
      async.flushMicrotasks();
      async.elapse(Duration.zero);
    }
  }

  /// Builds the controller (as the shell does by watching the tab's visibility) and lets the bootstrap land.
  void start() {
    container.read(softphoneAvailabilityProvider);
    pump();
  }

  /// Runs [future] to completion on the fake clock.
  T run<T>(Future<T> future) {
    T? out;
    Object? error;
    var done = false;
    future.then(
      (v) {
        out = v;
        done = true;
      },
      onError: (Object e) {
        error = e;
        done = true;
      },
    );
    pump();
    if (error != null) throw error!;
    if (!done) fail('future did not complete');
    return out as T;
  }

  /// A connected soft-phone session with [call] on it, and a number typed.
  void openWith({ManualCall? call, String number = '9820461733'}) {
    host.view = hostView(call: call);
    pump();
    if (call == null) actions.setNumber(number);
  }

  void dispose() {
    container.dispose();
    async.flushMicrotasks();
  }
}

/// Runs [body] on a fake clock with a started harness.
void softphoneTest(
  String description,
  void Function(SoftphoneHarness h) body, {
  GateReady? gate,
  SoftphoneHostView? host,
  bool start = true,
  bool foreground = true,
  void Function(SoftphoneHarness h)? before,
}) {
  test(description, () {
    fakeAsync((async) {
      final h = SoftphoneHarness(async, gate: gate, host: host, foreground: foreground);
      before?.call(h);
      if (start) h.start();
      try {
        body(h);
      } finally {
        h.dispose();
      }
    });
  });
}

/// A call one step on, as the next frame carries it.
ManualCall advance(ManualCall call, int seconds, Map<String, Object?> over) => step(call, seconds, over);

/// A copy of the [call] JSON as the server would answer it.
Map<String, Object?> callBody(ManualCall call, [Map<String, Object?> over = const {}]) => {
  ...manualCallJson({
    'id': call.id,
    'session_id': call.sessionId,
    'destination_e164': call.destinationE164,
    'caller_id': call.callerId,
    'state': call.stateRaw,
    'created_at': call.createdAt.toIso8601String(),
    'updated_at': call.updatedAt.toIso8601String(),
  }),
  ...over,
};

/// Silences the unawaited-future lint for a fire-and-forget action in a test.
void fire(Future<void> f) => unawaited(f);

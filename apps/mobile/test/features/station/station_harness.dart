import 'package:agency_wire/agency_wire.dart' show ManualCall;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:magick_agency_agent/app/routes.dart';
import 'package:magick_agency_agent/app/theme/app_theme.dart';
import 'package:magick_agency_agent/app/theme/tokens.dart';
import 'package:magick_agency_agent/core/flags/feature_flags.dart';
import 'package:magick_agency_agent/core/softphone/softphone_host.dart';
import 'package:magick_agency_agent/core/softphone/softphone_view.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';
import 'package:magick_agency_agent/features/station/station_providers.dart';
import 'package:magick_agency_agent/features/station/station_screen.dart';

import '../softphone/softphone_harness.dart' show FakeSoftphoneActions, ShellScaffold, setPhoneInsets;

/// Test doubles and a pump helper for the station screen.

/// Records every call. Each action can be held open with [hold] so a test
/// can look at the in-flight state.
class FakeStationActions implements StationActions {
  final calls = <String>[];
  final args = <String, List<Object?>>{};

  /// When set, actions call it with their name (to change the view, say).
  void Function(String name)? onCall;

  /// What [leave] does after [onCall], as the real runtime does it: drop the
  /// station (the view goes null, so the screen swaps its body and the button
  /// that asked is gone), then finish closing it a moment later (audio, notes).
  /// [pumpStation] wires it; a refusal set by [onCall] (an `actionError`) keeps
  /// the station, as the real one does, and answers [LeaveOutcome.stayed].
  Future<LeaveOutcome> Function()? afterLeave;

  /// How a leave that went through ended ([LeaveOutcome.leftOffline]: no network).
  LeaveOutcome leaveOutcome = LeaveOutcome.left;

  Future<void> _rec(String name, [List<Object?> a = const []]) async {
    calls.add(name);
    args[name] = a;
    onCall?.call(name);
  }

  int count(String name) => calls.where((c) => c == name).length;

  @override
  Future<void> goAvailable() => _rec('goAvailable');
  @override
  Future<void> takeBreak(String code) => _rec('takeBreak', [code]);
  @override
  Future<void> cancelQueuedBreak() => _rec('cancelQueuedBreak');
  @override
  Future<void> endBreak() => _rec('endBreak');
  @override
  Future<void> hangUp() => _rec('hangUp');
  @override
  Future<void> setMuted(bool muted) => _rec('setMuted', [muted]);
  @override
  Future<void> setRoute(AudioRouteOption route) => _rec('setRoute', [route]);
  @override
  void updateNotes(String text) => _rec('updateNotes', [text]);
  @override
  Future<void> submitDisposition(String code, {String? notes, DateTime? callbackAt}) =>
      _rec('submitDisposition', [code, notes, callbackAt]);
  @override
  Future<void> redial({String? attemptId}) => _rec('redial', [attemptId]);
  @override
  Future<void> markDnc({String? reason, String? attemptId}) => _rec('markDnc', [reason, attemptId]);
  @override
  Future<LeaveOutcome> leave() async {
    await _rec('leave');
    return await afterLeave?.call() ?? leaveOutcome;
  }

  @override
  Future<void> reconnect() => _rec('reconnect');
  @override
  Future<void> useThisDevice() => _rec('useThisDevice');
  @override
  Future<void> dismiss() => _rec('dismiss');
  @override
  void dismissActionError() => _rec('dismissActionError');
  @override
  void dismissMissedRelease() => _rec('dismissMissedRelease');
}

/// The session host's soft-phone actions the station calls (SP7: switch to the
/// soft phone, withdraw a queued switch). Records each, and answers with the
/// result the test set.
class FakeSoftphoneHost implements SoftphoneHostActions {
  final calls = <String>[];
  SoftphoneSwitchResult switchResult = const SoftphoneSwitchApplied();
  SoftphoneSwitchResult cancelResult = const SoftphoneSwitchApplied();

  int count(String name) => calls.where((c) => c == name).length;

  @override
  Future<SoftphoneSwitchResult> switchToSoftphone() async {
    calls.add('switchToSoftphone');
    return switchResult;
  }

  @override
  Future<SoftphoneSwitchResult> cancelSwitch() async {
    calls.add('cancelSwitch');
    return cancelResult;
  }

  @override
  Future<SoftphoneSwitchResult> returnToCampaign() async {
    calls.add('returnToCampaign');
    return const SoftphoneSwitchApplied();
  }

  @override
  Future<SoftphoneOpenResult> openSoftphone({bool takeOver = true}) => throw UnimplementedError();
  @override
  Future<SoftphoneCloseResult> closeSoftphone({String? sessionId, String? accountId}) => throw UnimplementedError();
  @override
  void adoptManualCall(ManualCall call) => calls.add('adoptManualCall');
  @override
  void retireManualCall(String versionKey) => calls.add('retireManualCall');
  @override
  void setRingMuted(bool muted) => calls.add('setRingMuted');
  @override
  void setCallDisplayName(String callId, String? name) => calls.add('setCallDisplayName');
  @override
  Future<void> hangUpManual() async => calls.add('hangUpManual');
  @override
  Future<void> setMuted(bool muted) async => calls.add('setMuted');
  @override
  Future<void> setRoute(AudioRouteOption route) async => calls.add('setRoute');
  @override
  Future<void> reconnect() async => calls.add('reconnect');
  @override
  Future<void> useThisDevice() async => calls.add('useThisDevice');
  @override
  Future<void> dismiss() async => calls.add('dismiss');
}

class SoftphoneHolder extends Notifier<SoftphoneView> {
  SoftphoneHolder(this.initial);
  final SoftphoneView initial;

  @override
  SoftphoneView build() => initial;

  void set(SoftphoneView v) => state = v;
}

class AvailabilityHolder extends Notifier<SoftphoneAvailability> {
  AvailabilityHolder(this.initial);
  final SoftphoneAvailability initial;

  @override
  SoftphoneAvailability build() => initial;

  void set(SoftphoneAvailability a) => state = a;
}

/// The soft phone may start calls here.
const softphoneOn = SoftphoneAvailability(visible: true, startAllowed: true, loaded: true);

class ViewHolder extends Notifier<StationView?> {
  ViewHolder(this.initial);
  final StationView? initial;

  @override
  StationView? build() => initial;

  void set(StationView? v) => state = v;
}

class TestClock {
  TestClock(this.now);
  DateTime now;
  DateTime call() => now;
}

/// 11:20 on a Saturday, local time.
final t0 = DateTime(2026, 10, 31, 11, 20);

class StationHarness {
  StationHarness(this.tester, this.container, this.holder, this.actions, this.clock, this.platformCalls, this.announcements);

  /// The soft phone's seams: the host's actions, the panel's actions, its view
  /// and its availability.
  final host = FakeSoftphoneHost();
  final softphoneActions = FakeSoftphoneActions();
  late final NotifierProvider<SoftphoneHolder, SoftphoneView> softphone;
  late final NotifierProvider<AvailabilityHolder, SoftphoneAvailability> availability;

  Future<void> setSoftphone(SoftphoneView v) async {
    container.read(softphone.notifier).set(v);
    await settle(tester);
  }

  final WidgetTester tester;
  final ProviderContainer container;
  final NotifierProvider<ViewHolder, StationView?> holder;
  final FakeStationActions actions;
  final TestClock clock;
  final List<MethodCall> platformCalls;
  final List<Object?> announcements;
  int settingsOpened = 0;

  StationView? get view => container.read(holder);

  Future<void> setView(StationView? v) async {
    container.read(holder.notifier).set(v);
    await settle(tester);
  }

  /// The call on screen ends, as the server says it: the stage moves to
  /// wrap-up for the same call (the on-call widgets are gone after this).
  Future<void> endCall() async {
    final v = view!;
    await setView(
      station(
        link: v.link,
        phase: AgentPhase.wrapup,
        call: v.call,
        release: hungUpRelease,
        wrapup: wrapup(),
        queuedBreak: v.queuedBreak,
        audio: v.audio,
      ),
    );
    // A dialog over the old screen closes itself on the frame after the switch.
    await settle(tester);
  }

  /// Moves the test clock and fake time together.
  Future<void> advance(Duration d) async {
    var left = d;
    const step = Duration(milliseconds: 250);
    while (left > Duration.zero) {
      final s = left < step ? left : step;
      clock.now = clock.now.add(s);
      await tester.pump(s);
      left -= s;
    }
  }

  List<String> get haptics => [
    for (final c in platformCalls)
      if (c.method == 'HapticFeedback.vibrate') '${c.arguments}',
  ];
}

/// Lets a pushed route (sheet, dialog) or a stage switch finish animating:
/// one frame to start the animation, one to finish it.
Future<void> settle(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 500));
}

/// [statusBar], [keyboard] and [shell] put the phone's own chrome around the
/// station: see `setPhoneInsets` and `ShellScaffold` in the soft-phone harness.
Future<StationHarness> pumpStation(
  WidgetTester tester,
  StationView? view, {
  DateTime? now,
  double textScale = 1,
  Size size = const Size(390, 844),
  double statusBar = 0,
  double keyboard = 0,
  bool shell = false,
  bool disableAnimations = false,
  bool supportsAnnounce = false,
  String campaignId = 'c1',
  Brightness brightness = Brightness.dark,
  SoftphoneAvailability availability = SoftphoneAvailability.hidden,
  SoftphoneView softphone = const SoftphoneView(),
  bool contactAssignment = false,
  List<Override> extra = const [],
}) async {
  tester.view.devicePixelRatio = 3;
  tester.view.physicalSize = size * 3;
  setPhoneInsets(tester, statusBar: statusBar, keyboard: keyboard);
  addTearDown(tester.view.reset);

  final platformCalls = <MethodCall>[];
  tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
    platformCalls.add(call);
    return null;
  });
  addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));
  final announcements = <Object?>[];
  tester.binding.defaultBinaryMessenger.setMockDecodedMessageHandler<Object?>(SystemChannels.accessibility, (msg) async {
    announcements.add(msg);
    return null;
  });
  addTearDown(() => tester.binding.defaultBinaryMessenger.setMockDecodedMessageHandler<Object?>(SystemChannels.accessibility, null));

  final holder = NotifierProvider<ViewHolder, StationView?>(() => ViewHolder(view));
  final softphoneHolder = NotifierProvider<SoftphoneHolder, SoftphoneView>(() => SoftphoneHolder(softphone));
  final availabilityHolder = NotifierProvider<AvailabilityHolder, SoftphoneAvailability>(() => AvailabilityHolder(availability));
  final actions = FakeStationActions();
  final clock = TestClock(now ?? t0);
  late final StationHarness h;
  final container = ProviderContainer(
    overrides: [
      stationViewProvider.overrideWith((ref) => ref.watch(holder)),
      stationActionsProvider.overrideWithValue(actions),
      stationClockProvider.overrideWithValue(clock.call),
      stationOpenSettingsProvider.overrideWithValue(() async => h.settingsOpened++),
      softphoneHostActionsProvider.overrideWith((ref) => h.host),
      softphoneActionsProvider.overrideWith((ref) => h.softphoneActions),
      softphoneViewProvider.overrideWith((ref) => ref.watch(softphoneHolder)),
      softphoneAvailabilityProvider.overrideWith((ref) => ref.watch(availabilityHolder)),
      contactAssignmentEnabledProvider.overrideWithValue(contactAssignment),
      ...extra,
    ],
  );
  addTearDown(container.dispose);
  h = StationHarness(tester, container, holder, actions, clock, platformCalls, announcements)
    ..softphone = softphoneHolder
    ..availability = availabilityHolder;
  actions.afterLeave = () async {
    if (container.read(holder)?.actionError != null) return LeaveOutcome.stayed;
    container.read(holder.notifier).set(null);
    // The audio close and the notes flush (up to 2 s): the screen has rebuilt,
    // and finished its switch, before leave() returns.
    await Future<void>.delayed(const Duration(milliseconds: 400));
    return actions.leaveOutcome;
  };

  final routes = <RouteBase>[
    GoRoute(
      path: Routes.home,
      builder: (_, _) => const Scaffold(body: Text('campaigns-home')),
      routes: [
        GoRoute(
          path: 'station/:campaignId',
          builder: (_, s) => StationScreen(campaignId: s.pathParameters['campaignId']!),
        ),
        GoRoute(
          path: 'contacts/:campaignId',
          builder: (_, s) => Scaffold(body: Text('my-contacts ${s.pathParameters['campaignId']}')),
        ),
      ],
    ),
  ];
  final router = GoRouter(
    initialLocation: Routes.station(campaignId),
    routes: shell ? [ShellRoute(builder: (_, _, child) => ShellScaffold(selected: 0, child: child), routes: routes)] : routes,
  );
  addTearDown(router.dispose);

  final tokens = brightness == Brightness.dark ? AppTokens.dark : AppTokens.light;
  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp.router(
        theme: buildTheme(tokens, brightness),
        routerConfig: router,
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: TextScaler.linear(textScale), disableAnimations: disableAnimations, supportsAnnounce: supportsAnnounce),
          child: child!,
        ),
      ),
    ),
  );
  await tester.pump();
  return h;
}

// ── Fixtures ──────────────────────────────────────────────────────────

const breaks = [BreakOption(code: 'lunch', label: 'Lunch'), BreakOption(code: 'tea', label: 'Tea break')];

const dispositions = [
  DispositionOption(code: 'interested', label: 'Interested', isSuccess: true),
  DispositionOption(code: 'not_interested', label: 'Not interested'),
  DispositionOption(code: 'callback', label: 'Callback', requiresCallbackTime: true),
  DispositionOption(code: 'voicemail', label: 'Voicemail'),
  DispositionOption(code: 'wrong', label: 'Wrong number', requiresNote: true),
  DispositionOption(code: 'dnc', label: 'Do not call', suppresses: true),
];

CallView call({
  DateTime? bridgedAt,
  int? countdown,
  bool recording = false,
  String? name = 'Priya Raman',
  int otherFields = 6,
  String attemptId = 'a1',
  String phone = '+919840012345',
  int? redialNumber,
  int? redialLimit,
}) => CallView(
  attemptId: attemptId,
  phoneE164: phone,
  attemptNumber: 2,
  callerId: '+918047182200',
  campaignName: 'Q4 Card Renewals',
  displayName: name,
  heroFields: const [
    ContactField(key: 'city', label: 'City', value: 'Chennai'),
    ContactField(key: 'card', label: 'Card', value: 'Platinum'),
    ContactField(key: 'due', label: 'Amount due', value: '₹12,400'),
    ContactField(key: 'renewal', label: 'Renewal', value: '15 Nov'),
  ],
  heroesConfigured: true,
  otherFields: [
    for (var i = 0; i < otherFields; i++) ContactField(key: 'f$i', label: 'Field $i', value: i == 3 ? 'Policy 7781' : 'Value $i'),
  ],
  priorAttempts: [
    PriorAttempt(at: DateTime(2026, 10, 20, 9, 30), outcomeLabel: 'Busy', sameCampaign: false, campaignName: 'Diwali Offers'),
    PriorAttempt(at: DateTime(2026, 10, 28, 18, 5), outcomeLabel: 'No answer'),
  ],
  countdownSeconds: countdown,
  bridgedAt: bridgedAt,
  recording: recording,
  redialNumber: redialNumber,
  redialLimit: redialLimit,
);

StationView station({
  StationLink link = StationLink.open,
  AgentPhase phase = AgentPhase.available,
  DateTime? phaseSince,
  bool dialing = true,
  BreakInfo? onBreak,
  BreakInfo? queuedBreak,
  CallView? call,
  ReleaseView? release,
  WrapupView? wrapup,
  String? dispositionSaved,
  NotesView notes = const NotesView(),
  AudioView audio = const AudioView(),
  MissedReleaseView? missedRelease,
  DateTime? reconnectDeadline,
  Duration? reconnectWindow,
  bool weak = false,
  StationBusy busy = StationBusy.none,
  String? actionError,
  String? fatal,
  String campaignId = 'c1',
  QueueView? queue,
  bool myContactsOffered = false,
}) => StationView(
  campaignId: campaignId,
  campaignName: 'Q4 Card Renewals',
  sessionId: 's1',
  link: link,
  phase: phase,
  phaseSince: phaseSince,
  campaignDialing: dialing,
  onBreak: onBreak,
  queuedBreak: queuedBreak,
  breakOptions: breaks,
  call: call,
  release: release,
  wrapup: wrapup,
  dispositions: dispositions,
  dispositionSaved: dispositionSaved,
  notes: notes,
  audio: audio,
  missedRelease: missedRelease,
  reconnectDeadline: reconnectDeadline,
  reconnectWindow: reconnectWindow,
  weakConnection: weak,
  busy: busy,
  actionError: actionError,
  fatal: fatal,
  queue: queue,
  myContactsOffered: myContactsOffered,
);

const hungUpRelease = ReleaseView(
  headline: 'Wrap-up',
  detail: 'The customer hung up.',
  tone: ReleaseTone.neutral,
  requiresDisposition: true,
);

/// A Wrap-up that started at [t0] and lasts 30 s.
WrapupView wrapup({WrapupHold hold = WrapupHold.none, bool submitted = false, DateTime? endsAt, bool noTimer = false}) => WrapupView(
  endsAt: noTimer ? null : (endsAt ?? t0.add(const Duration(seconds: 30))),
  secondsTotal: 30,
  hold: hold,
  dispositionSubmitted: submitted,
  autoReturn: true,
);

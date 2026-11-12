import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:magick_agency_agent/app/theme/app_theme.dart';
import 'package:magick_agency_agent/app/theme/tokens.dart';
import 'package:magick_agency_agent/core/softphone/softphone_view.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';
import 'package:magick_agency_agent/features/preflight/preflight_checks.dart';
import 'package:magick_agency_agent/features/softphone/phone_screen.dart';
import 'package:magick_agency_agent/features/softphone/softphone_panel.dart';
import 'package:magick_agency_agent/features/station/station_providers.dart';

/// Test doubles and a pump helper for the Phone screen and the soft-phone panel.

/// Records every call, with its arguments. [dialGate] holds `dial()` open, so
/// a test can press Call again while the first dial is in flight.
class FakeSoftphoneActions implements SoftphoneActions {
  final calls = <String>[];
  final args = <String, List<Object?>>{};

  /// When set, actions call it with their name (to change the view, say).
  void Function(String name)? onCall;

  /// When set, `dial()` waits for it.
  Completer<void>? dialGate;

  /// What [switchToSoftphone] answers.
  bool switchResult = true;

  void _rec(String name, [List<Object?> a = const []]) {
    calls.add(name);
    args[name] = a;
    onCall?.call(name);
  }

  Future<void> _recAsync(String name, [List<Object?> a = const []]) async => _rec(name, a);

  int count(String name) => calls.where((c) => c == name).length;

  @override
  Future<void> open() => _recAsync('open');
  @override
  Future<void> retry() => _recAsync('retry');
  @override
  Future<void> close() => _recAsync('close');
  @override
  Future<void> closeElsewhereAndOpen() => _recAsync('closeElsewhereAndOpen');
  @override
  Future<void> closeStranded() => _recAsync('closeStranded');
  @override
  Future<bool> switchToSoftphone() async {
    _rec('switchToSoftphone');
    return switchResult;
  }

  @override
  Future<void> requestAccountSwitch(String accountId) => _recAsync('requestAccountSwitch', [accountId]);
  @override
  Future<void> returnToCampaign() => _recAsync('returnToCampaign');
  @override
  Future<void> cancelSwitch() => _recAsync('cancelSwitch');
  @override
  void setNumber(String raw) => _rec('setNumber', [raw]);
  @override
  void pressKey(String key) => _rec('pressKey', [key]);
  @override
  void backspace() => _rec('backspace');
  @override
  void clearNumber() => _rec('clearNumber');
  @override
  void pasteNumber(String raw) => _rec('pasteNumber', [raw]);
  @override
  Future<void> dial() async {
    _rec('dial');
    await dialGate?.future;
  }

  @override
  void redial(String recentCallId) => _rec('redial', [recentCallId]);
  @override
  void callBack(String number, {String? campaignId}) => _rec('callBack', [number, campaignId]);
  @override
  void setTag(String? campaignId) => _rec('setTag', [campaignId]);
  @override
  void setCallerId(String callerId) => _rec('setCallerId', [callerId]);
  @override
  void setFieldValue(String key, Object? value) => _rec('setFieldValue', [key, value]);
  @override
  void setNotes(String text) => _rec('setNotes', [text]);
  @override
  void selectOutcome(String code) => _rec('selectOutcome', [code]);
  @override
  void setCallback(DateTime? at) => _rec('setCallback', [at]);
  @override
  Future<void> saveOutcome() => _recAsync('saveOutcome');
  @override
  Future<void> hangUp() => _recAsync('hangUp');
  @override
  Future<void> toggleMute() => _recAsync('toggleMute');
  @override
  Future<void> setRoute(AudioRouteOption route) => _recAsync('setRoute', [route]);
  @override
  Future<void> markDnc({String? reason, required String callId}) => _recAsync('markDnc', [reason, callId]);
  @override
  Future<void> confirmOverride(String note) => _recAsync('confirmOverride', [note]);
  @override
  void cancelOverride() => _rec('cancelOverride');
  @override
  Future<void> reconnect() => _recAsync('reconnect');
  @override
  Future<void> useThisDevice() => _recAsync('useThisDevice');
  @override
  Future<void> reloadRecent() => _recAsync('reloadRecent');
  @override
  void dismissDialError() => _rec('dismissDialError');
  @override
  void dismissSessionError() => _rec('dismissSessionError');
}

class FakePermissions implements SoftphonePermissions {
  MicPermission mic = MicPermission.granted;
  int micAsked = 0;
  int notificationsAsked = 0;

  @override
  Future<MicPermission> requestMicrophone() async {
    micAsked++;
    return mic;
  }

  @override
  Future<void> requestNotifications() async => notificationsAsked++;
}

class ViewHolder extends Notifier<SoftphoneView> {
  ViewHolder(this.initial);
  final SoftphoneView initial;

  @override
  SoftphoneView build() => initial;

  void set(SoftphoneView v) => state = v;
}

class TestClock {
  TestClock(this.now);
  DateTime now;
  DateTime call() => now;
}

/// 11:20 on a Saturday, local time.
final t0 = DateTime(2026, 10, 31, 11, 20);

class SoftphoneHarness {
  SoftphoneHarness(
    this.tester,
    this.container,
    this.holder,
    this.actions,
    this.permissions,
    this.clock,
    this.platformCalls,
    this.announcements,
  );

  final WidgetTester tester;
  final ProviderContainer container;
  final NotifierProvider<ViewHolder, SoftphoneView> holder;
  final FakeSoftphoneActions actions;
  final FakePermissions permissions;
  final TestClock clock;
  final List<MethodCall> platformCalls;
  final List<Object?> announcements;
  int settingsOpened = 0;
  late final GoRouter router;

  SoftphoneView get view => container.read(holder);

  Future<void> setView(SoftphoneView v) async {
    container.read(holder.notifier).set(v);
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

/// Lets a pushed route (sheet, dialog) finish animating.
Future<void> settle(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 500));
}

/// Pumps the Phone screen ([phoneScreen]) or the panel alone on [surface].
///
/// [statusBar], [keyboard] and [shell] put the phone's own chrome around it:
/// see [setPhoneInsets] and [ShellScaffold].
Future<SoftphoneHarness> pumpSoftphone(
  WidgetTester tester,
  SoftphoneView view, {
  bool phoneScreen = false,
  SoftphoneSurface surface = SoftphoneSurface.phone,
  DateTime? now,
  double textScale = 1,
  Size size = const Size(390, 844),
  double statusBar = 0,
  double keyboard = 0,
  bool shell = false,
  bool disableAnimations = false,
  bool supportsAnnounce = false,
  Brightness brightness = Brightness.dark,
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

  final holder = NotifierProvider<ViewHolder, SoftphoneView>(() => ViewHolder(view));
  final actions = FakeSoftphoneActions();
  final permissions = FakePermissions();
  final clock = TestClock(now ?? t0);
  late final SoftphoneHarness h;
  final container = ProviderContainer(
    overrides: [
      softphoneViewProvider.overrideWith((ref) => ref.watch(holder)),
      softphoneActionsProvider.overrideWithValue(actions),
      softphonePermissionsProvider.overrideWithValue(permissions),
      stationClockProvider.overrideWithValue(clock.call),
      stationOpenSettingsProvider.overrideWithValue(() async => h.settingsOpened++),
    ],
  );
  addTearDown(container.dispose);
  h = SoftphoneHarness(tester, container, holder, actions, permissions, clock, platformCalls, announcements);

  final routes = <RouteBase>[
    GoRoute(
      path: '/phone',
      builder: (_, _) => phoneScreen
          ? const PhoneScreen()
          : Scaffold(
              body: SafeArea(child: SoftphonePanel(surface: surface)),
            ),
    ),
    GoRoute(path: '/home/station/:campaignId', builder: (_, s) => Text('station-${s.pathParameters['campaignId']}')),
  ];
  final router = GoRouter(
    initialLocation: '/phone',
    routes: shell ? [ShellRoute(builder: (_, _, child) => ShellScaffold(selected: 1, child: child), routes: routes)] : routes,
  );
  addTearDown(router.dispose);
  h.router = router;

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

// ── A real phone ──────────────────────────────────────────────────────

/// A status bar of [statusBar] dp (the top inset SafeArea takes away) and a
/// soft keyboard of [keyboard] dp over the bottom of the screen.
void setPhoneInsets(WidgetTester tester, {double statusBar = 0, double keyboard = 0}) {
  final ratio = tester.view.devicePixelRatio;
  tester.view.padding = FakeViewPadding(top: statusBar * ratio);
  tester.view.viewInsets = FakeViewPadding(bottom: keyboard * ratio);
}

/// The app shell as it nests a tab: a Scaffold with the five-tab
/// NavigationBar, around the branch's own navigator ([child]). The real shell
/// hides the bar during a live call; this one always shows it, the tighter case.
class ShellScaffold extends StatelessWidget {
  const ShellScaffold({super.key, required this.selected, required this.child});

  final int selected;
  final Widget child;

  @override
  Widget build(BuildContext context) => Scaffold(
    body: child,
    bottomNavigationBar: NavigationBar(
      selectedIndex: selected,
      destinations: const [
        NavigationDestination(icon: Icon(Icons.call_outlined), label: 'Station'),
        NavigationDestination(icon: Icon(Icons.dialpad_outlined), label: 'Phone'),
        NavigationDestination(icon: Icon(Icons.bar_chart_outlined), label: 'Performance'),
        NavigationDestination(icon: Icon(Icons.list_alt_outlined), label: 'My calls'),
        NavigationDestination(icon: Icon(Icons.person_outline), label: 'Me'),
      ],
    ),
  );
}

/// The text scales the real-phone sweep runs at.
const sweepTextScales = [1.0, 1.15, 1.3, 1.5, 1.75, 2.0];

/// Every phase of the panel: its view, its one action, and the field an agent
/// types into in it.
List<({String name, SoftphoneView view, String action, String field})> everyPanelPhase() => [
  (name: 'ready', view: readyView(), action: 'dial-call', field: 'dial-number'),
  (
    name: 'ready, the dial refused',
    view: readyView(dialError: 'Q4 Renewals is calling this customer right now. Try again once that call has ended.'),
    action: 'dial-call',
    field: 'dial-number',
  ),
  (name: 'dialing', view: callView(SoftphonePhase.dialing), action: 'softphone-hang-up', field: 'softphone-notes-field'),
  (name: 'ringing', view: callView(SoftphonePhase.ringing), action: 'softphone-hang-up', field: 'softphone-notes-field'),
  (
    name: 'on call',
    view: callView(SoftphonePhase.onCall, outcomeCode: 'callback', callbackAt: t0.add(const Duration(hours: 1))),
    action: 'softphone-hang-up',
    field: 'softphone-notes-field',
  ),
  (
    name: 'outcome',
    view: callView(
      SoftphonePhase.outcome,
      outcomeCode: 'wrong',
      outcomeDueAt: t0.add(const Duration(minutes: 2)),
      requiredFieldsMissing: true,
    ),
    action: 'softphone-save',
    field: 'softphone-notes-field',
  ),
];

/// Runs [everyPanelPhase] through [setView] on the panel as it is mounted on a
/// [size] screen with [statusBar] and [keyboard] (see [setPhoneInsets]). In
/// each phase: nothing overflows; with the phase's field focused, its caret is
/// inside the part of the scrolling column the agent can see; and the phase's
/// action is wholly on screen, between the status bar and the keyboard (or
/// the shell's bar).
Future<void> expectEveryPanelPhaseFits(
  WidgetTester tester,
  Future<void> Function(SoftphoneView view) setView, {
  required Size size,
  required double statusBar,
  required double keyboard,
}) async {
  for (final c in everyPanelPhase()) {
    await setView(c.view);
    await expectNoOverflow(tester);

    final bar = find.byType(NavigationBar);
    final bottom = keyboard > 0 ? size.height - keyboard : (bar.evaluate().isEmpty ? size.height : tester.getRect(bar).top);
    final visible = Rect.fromLTRB(0, statusBar, size.width, bottom);

    final field = find.byKey(Key(c.field));
    // As a tap does (tester.showKeyboard skips a field it focused before).
    tester.state<EditableTextState>(find.descendant(of: field, matching: find.byType(EditableText))).requestKeyboard();
    // The caret is revealed in a post-frame callback, then animated there.
    await settle(tester);
    await settle(tester);
    await expectNoOverflow(tester);
    final viewport = tester.getRect(find.byKey(const Key('softphone-scroll'))).intersect(visible);
    final caret = caretRect(tester, field);
    expect(
      viewport.height > 0 && caret.top >= viewport.top - 0.5 && caret.bottom <= viewport.bottom + 0.5,
      isTrue,
      reason: '${c.name}: the caret at $caret is outside the visible column $viewport',
    );

    final action = tester.getRect(find.byKey(Key(c.action)));
    expect(
      action.top >= visible.top - 0.5 && action.bottom <= visible.bottom + 0.5,
      isTrue,
      reason: '${c.name}: ${c.action} at $action is not wholly inside $visible',
    );

    FocusManager.instance.primaryFocus?.unfocus();
    await settle(tester);
  }
}

/// Where the caret of the text field under [field] is drawn, in screen coordinates.
Rect caretRect(WidgetTester tester, Finder field) {
  final editable = tester.state<EditableTextState>(find.descendant(of: field, matching: find.byType(EditableText)));
  final box = editable.renderEditable;
  final local = box.getLocalRectForCaret(box.selection!.extent);
  return MatrixUtils.transformRect(box.getTransformTo(null), local);
}

// ── Fixtures ──────────────────────────────────────────────────────────

const outcomes = [
  DispositionOption(code: 'interested', label: 'Interested', isSuccess: true),
  DispositionOption(code: 'not_interested', label: 'Not interested'),
  DispositionOption(code: 'callback', label: 'Callback', requiresCallbackTime: true),
  DispositionOption(code: 'wrong', label: 'Wrong number', requiresNote: true),
];

const campaigns = [
  SoftphoneTagOption(campaignId: 'c1', name: 'Q4 Renewals', recording: true),
  SoftphoneTagOption(
    campaignId: 'c2',
    name: 'Diwali Offers',
    windowOpen: false,
    windowNote: '9:00 am–6:00 pm (campaign time) · may need a reason',
  ),
];

const callerIds = [
  SoftphoneChoice(value: '+912071234567', label: '+91 20712 34567'),
  SoftphoneChoice(value: '+912071234568', label: '+91 20712 34568'),
];

const fields = [
  SoftphoneFieldView(key: 'policy', label: 'Policy number', type: SoftphoneFieldType.text, required: true),
  SoftphoneFieldView(key: 'amount', label: 'Amount', type: SoftphoneFieldType.number),
  SoftphoneFieldView(key: 'plan', label: 'Plan', type: SoftphoneFieldType.choice, options: ['Gold', 'Silver']),
  SoftphoneFieldView(key: 'consent', label: 'Consent given', type: SoftphoneFieldType.boolean),
  SoftphoneFieldView(key: 'renewal', label: 'Renewal date', type: SoftphoneFieldType.date, value: '2026-11-15'),
];

final recent = [
  SoftphoneRecentCall(
    id: 'm1',
    numberE164: '+919812345678',
    numberDisplay: '+91 98123 45678',
    at: t0.subtract(const Duration(hours: 2)),
    whenLabel: 'Today, 09:20 am',
    outcomeLabel: 'Interested',
    outcomeKind: SoftphoneOutcomeKind.saved,
    loggedTo: 'Logged to Q4 Renewals',
    tagged: true,
  ),
  SoftphoneRecentCall(
    id: 'm2',
    numberE164: '+919876543210',
    numberDisplay: '+91 98765 43210',
    at: t0.subtract(const Duration(days: 1)),
    whenLabel: 'Yesterday, 06:40 pm',
    outcomeLabel: 'No answer',
    outcomeKind: SoftphoneOutcomeKind.line,
    loggedTo: 'Not logged to a campaign',
  ),
];

const contact = SoftphoneContactView(
  displayName: 'Rahul Verma',
  heroFields: [
    ContactField(key: 'city', label: 'City', value: 'Pune'),
    ContactField(key: 'plan', label: 'Plan', value: 'Gold'),
  ],
  heroesConfigured: true,
  otherFields: [ContactField(key: 'branch', label: 'Branch', value: 'Kothrud')],
  claimed: true,
  campaignName: 'Q4 Renewals',
);

const routes = [
  AudioRouteOption(id: 'e', kind: AudioRouteKind.earpiece, name: 'Phone'),
  AudioRouteOption(id: 's', kind: AudioRouteKind.speaker, name: 'Speaker'),
];

/// Ready to dial, connected, with a number typed. As the core builds it, the
/// number, the pad and Log to / Call from are locked in finish mode and while
/// a dial is in flight ([placing]): a refusal then names the number sent.
SoftphoneView readyView({
  String number = '9812345678',
  bool canDial = true,
  bool placing = false,
  bool finishOnly = false,
  String? tag,
  int focusCallToken = 0,
  String? dialError,
  String? dialBlockReason,
  List<SoftphoneRecentCall>? recentCalls,
  SoftphoneOverridePrompt? overridePrompt,
  String announcement = '',
  int announcementSeq = 0,
  String? bootstrapError,
  StationLink link = StationLink.open,
  SoftphoneRail rail = const SoftphoneRail(tone: SoftphoneRailTone.neutral, label: 'Ready to dial'),
}) => SoftphoneView(
  screen: const SoftphoneScreenActive(),
  link: link,
  rail: rail,
  finishOnly: finishOnly,
  startAllowed: !finishOnly,
  campaigns: campaigns,
  tagCampaignId: tag,
  callerIds: callerIds,
  callerId: callerIds.first.value,
  setupEditable: !finishOnly && !placing,
  number: number,
  numberDisplay: number.isEmpty ? '' : '98123 45678',
  dialPadEnabled: !finishOnly && !placing,
  canDial: canDial && !finishOnly,
  placing: placing,
  dialError: dialError,
  dialBlockReason: dialBlockReason,
  focusCallToken: focusCallToken,
  fields: fields,
  recent: [
    for (final r in recentCalls ?? recent)
      SoftphoneRecentCall(
        id: r.id,
        numberE164: r.numberE164,
        numberDisplay: r.numberDisplay,
        at: r.at,
        whenLabel: r.whenLabel,
        outcomeLabel: r.outcomeLabel,
        outcomeKind: r.outcomeKind,
        loggedTo: r.loggedTo,
        tagged: r.tagged,
        canRedial: !finishOnly,
      ),
  ],
  overridePrompt: overridePrompt,
  announcement: announcement,
  announcementSeq: announcementSeq,
  bootstrapError: bootstrapError,
);

/// A call on screen in [phase].
SoftphoneView callView(
  SoftphonePhase phase, {
  bool muted = false,
  bool micMuted = false,
  String? outcomeCode,
  DateTime? callbackAt,
  DateTime? outcomeDueAt,
  bool requiredFieldsMissing = false,
  bool finishOnly = false,
  bool hangingUp = false,
  // Null: the carrier cannot cancel a ringing call, so the warning shows while ringing.
  bool? warnRingingHangUp,
  NotesView notes = const NotesView(),
  bool dncEnabled = true,
  String? dncOutcome,
  bool saving = false,
  StationLink link = StationLink.open,
  List<SoftphoneFieldView> fieldViews = fields,
  SoftphoneContactView? contactView = contact,
  String announcement = '',
  int announcementSeq = 0,
  AudioView audio = const AudioView(
    route: AudioRouteOption(id: 'e', kind: AudioRouteKind.earpiece, name: 'Phone'),
    routes: routes,
  ),
}) {
  final live = phase == SoftphonePhase.dialing || phase == SoftphonePhase.ringing || phase == SoftphonePhase.onCall;
  final answered = phase == SoftphonePhase.onCall || phase == SoftphonePhase.outcome;
  final rail = switch (phase) {
    SoftphonePhase.dialing => const SoftphoneRail(tone: SoftphoneRailTone.info, label: 'Dialling +91 98123 45678'),
    SoftphonePhase.ringing => const SoftphoneRail(tone: SoftphoneRailTone.info, label: 'Ringing +91 98123 45678'),
    SoftphonePhase.onCall => SoftphoneRail(tone: SoftphoneRailTone.success, label: 'On call with Rahul Verma', timerFrom: t0),
    SoftphonePhase.outcome => const SoftphoneRail(tone: SoftphoneRailTone.warning, label: 'Outcome needed'),
    SoftphonePhase.ready => const SoftphoneRail(tone: SoftphoneRailTone.neutral, label: 'Ready to dial'),
  };
  return SoftphoneView(
    screen: const SoftphoneScreenActive(),
    link: link,
    phase: phase,
    rail: rail,
    callId: 'call-1',
    finishOnly: finishOnly,
    startAllowed: !finishOnly,
    campaigns: campaigns,
    tagCampaignId: 'c1',
    callerIds: callerIds,
    callerId: callerIds.first.value,
    setupEditable: false,
    recording: true,
    number: '+919812345678',
    numberDisplay: '+91 98123 45678',
    dialPadEnabled: false,
    contact: contactView,
    fields: fieldViews,
    requiredFieldsMissing: requiredFieldsMissing,
    notes: notes,
    notesEnabled: true,
    outcomes: outcomes,
    outcomeCode: outcomeCode,
    callbackAt: callbackAt,
    padEnabled: answered,
    padDisabledReason: answered ? null : 'Outcomes open when the customer answers.',
    saving: saving,
    outcomeDueAt: outcomeDueAt,
    muteTarget: phase == SoftphonePhase.ringing ? SoftphoneMuteTarget.ring : SoftphoneMuteTarget.mic,
    muted: muted,
    micMuted: micMuted,
    muteEnabled: live,
    audio: audio,
    canHangUp: live,
    warnRingingHangUp: warnRingingHangUp ?? phase == SoftphonePhase.ringing,
    hangingUp: hangingUp,
    dncEnabled: dncEnabled,
    dncScopeLabel: 'for Q4 Renewals',
    dncOutcome: dncOutcome,
    canClose: false,
    closeBlockedReason: 'Finish this call and save its outcome first — leaving now would cut the customer off.',
    canReturn: false,
    returnBlockedReason: 'Finish this call and save its outcome first.',
    announcement: announcement,
    announcementSeq: announcementSeq,
  );
}

const dncPrompt = SoftphoneOverridePrompt(
  kind: SoftphoneOverrideKind.dnc,
  title: 'This number is on the Do Not Call list',
  facts: [
    SoftphoneFact(label: 'Listed for', value: 'Q4 Renewals'),
    SoftphoneFact(label: 'Reason', value: 'Customer asked'),
    SoftphoneFact(label: 'Since', value: '12 Oct 2026'),
  ],
  consequence: 'If you call anyway, the call is logged with your name and your reason.',
  noteLabel: 'Why does this call have to go ahead?',
  confirmLabel: 'Call anyway',
);

const hoursPrompt = SoftphoneOverridePrompt(
  kind: SoftphoneOverrideKind.hours,
  title: 'Outside calling hours',
  facts: [
    SoftphoneFact(label: 'Window', value: '09:00–18:00 Mon–Sat Asia/Kolkata'),
    SoftphoneFact(label: 'Opens', value: 'in 14 hours (09:00 your time)'),
  ],
  consequence: 'If you call anyway, the call is logged with your name and your reason.',
  noteLabel: 'Why does this call have to go ahead?',
  confirmLabel: 'Call anyway',
);

/// Throws a test failure for any layout overflow since the last pump.
Future<void> expectNoOverflow(WidgetTester tester) async {
  final errors = <FlutterErrorDetails>[];
  final old = FlutterError.onError;
  FlutterError.onError = errors.add;
  await tester.pump();
  FlutterError.onError = old;
  expect(errors, isEmpty, reason: errors.map((e) => e.exceptionAsString()).join('\n'));
  expect(tester.takeException(), isNull);
}

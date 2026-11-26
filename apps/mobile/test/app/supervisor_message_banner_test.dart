import 'dart:ui' show Tristate;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show SemanticsAction, SemanticsNode;
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/app/routes.dart';
import 'package:magick_agency_agent/app/theme/app_theme.dart';
import 'package:magick_agency_agent/app/theme/tokens.dart';
import 'package:magick_agency_agent/core/station/station_signals.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';
import 'package:magick_agency_agent/features/station/supervisor_message_banner.dart';

import '../core/auth/support/harness.dart';
import '../features/station/station_harness.dart' show call, station;
import '../features/station/station_inbound_test.dart' show caller, inboundStation;
import 'shell_harness.dart';

/// A supervisor's message (floor assist, LF5; the app's LF36): the shell shows it at the top of
/// every tab and over a call, never as a dialog; several queue; Dismiss takes the one shown away;
/// each is announced to a screen reader once, and nothing else is (no live region).

class _Messages extends Notifier<List<SupervisorMessageView>> {
  @override
  List<SupervisorMessageView> build() => const [];
  void set(List<SupervisorMessageView> m) => state = m;
}

final _messages = NotifierProvider<_Messages, List<SupervisorMessageView>>(_Messages.new);

/// The station's view, as the station screens' harness sets it: a call on screen is a view with it.
class _View extends Notifier<StationView?> {
  @override
  StationView? build() => null;
  void set(StationView? v) => state = v;
}

final _view = NotifierProvider<_View, StationView?>(_View.new);

SupervisorMessageView msg(String id, {String text = 'Offer the 3-month plan, the waiver is approved.', String from = 'Anitha N'}) =>
    SupervisorMessageView(id: id, text: text, from: from, sentAt: DateTime(2026, 11, 19, 10, 5));

/// The text of every live region on screen.
List<String> liveRegions(WidgetTester tester) {
  final out = <String>[];
  void walk(SemanticsNode n) {
    if (n.getSemanticsData().flagsCollection.isLiveRegion) out.add(n.label);
    n.visitChildren((c) {
      walk(c);
      return true;
    });
  }

  walk(tester.binding.renderViews.first.owner!.semanticsOwner!.rootSemanticsNode!);
  return out;
}

void main() {
  late List<String> dismissed;
  late ProviderContainer c;

  setUp(() {
    dismissed = [];
    c = shellContainer(extra: [
      supervisorMessagesProvider.overrideWith((ref) => ref.watch(_messages)),
      dismissSupervisorMessageProvider.overrideWithValue(dismissed.add),
      // The seam's own default reads the call arriving off the view.
      stationViewProvider.overrideWith((ref) => ref.watch(_view)),
    ]);
  });
  tearDown(() => c.dispose());

  group('in the shell', () {
    testWidgets('none: no banner', (tester) async {
      await pumpShell(tester, c);
      expect(find.byKey(const Key('supervisor-message')), findsNothing);
    });

    testWidgets('shown above the tab, with who sent it and when; the first of several, and how many more', (tester) async {
      await pumpShell(tester, c);
      c.read(_messages.notifier).set([msg('m1'), msg('m2', text: 'Wrap up this call', from: 'Your supervisor'), msg('m3')]);
      await tester.pumpAndSettle();
      expect(find.text('Anitha N · 10:05'), findsOneWidget);
      expect(find.text('Offer the 3-month plan, the waiver is approved.'), findsOneWidget);
      expect(find.text('Show 2 more messages'), findsOneWidget);
      // Above the tab's content, not over it.
      final banner = tester.getRect(find.byKey(const Key('supervisor-message')));
      final page = tester.getRect(find.textContaining('at /home'));
      expect(banner.bottom, lessThanOrEqualTo(page.top));
      await tester.tap(find.byKey(const Key('dismiss-supervisor-message')));
      expect(dismissed, ['m1']);
      c.read(_messages.notifier).set([msg('m2', text: 'Wrap up this call', from: 'Your supervisor'), msg('m3')]);
      await tester.pumpAndSettle();
      expect(find.text('Your supervisor · 10:05'), findsOneWidget);
      expect(find.text('Show 1 more message'), findsOneWidget);
    });

    testWidgets('on every tab, and over a call (the tab bar hidden): never a dialog, nothing held up', (tester) async {
      final router = await pumpShell(tester, c);
      c.read(_messages.notifier).set([msg('m1')]);
      await tester.pumpAndSettle();
      for (final path in [Routes.performance, Routes.calls, Routes.me]) {
        router.go(path);
        await tester.pumpAndSettle();
        expect(find.byKey(const Key('supervisor-message')), findsOneWidget, reason: path);
      }
      c.read(testSignalsProvider.notifier).set(const StationSignals(onDuty: true, callActive: true, campaignId: 'c1'));
      router.go(Routes.station('c1'));
      await tester.pumpAndSettle();
      expect(find.byType(NavigationBar), findsNothing);
      expect(find.byKey(const Key('supervisor-message')), findsOneWidget);
      expect(find.byType(Dialog), findsNothing);
      expect(find.byType(AlertDialog), findsNothing);
    });
  });

  group('the banner', () {
    Future<List<Object?>> pumpBanner(WidgetTester tester, {double textScale = 1, Size size = const Size(390, 844)}) async {
      tester.view.devicePixelRatio = 3;
      tester.view.physicalSize = size * 3;
      addTearDown(tester.view.reset);
      final announcements = <Object?>[];
      tester.binding.defaultBinaryMessenger.setMockDecodedMessageHandler<Object?>(SystemChannels.accessibility, (m) async {
        announcements.add(m);
        return null;
      });
      addTearDown(() => tester.binding.defaultBinaryMessenger.setMockDecodedMessageHandler<Object?>(SystemChannels.accessibility, null));
      await tester.pumpWidget(UncontrolledProviderScope(
        container: c,
        child: MaterialApp(
          theme: buildTheme(AppTokens.light, Brightness.light),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context).copyWith(supportsAnnounce: true, textScaler: TextScaler.linear(textScale)),
            child: child!,
          ),
          home: const Scaffold(body: Column(children: [SupervisorMessageBanner()])),
        ),
      ));
      return announcements;
    }

    testWidgets('each message is announced once as it arrives, politely; a dismissal says nothing again', (tester) async {
      // With semantics on, so a live region (which a screen reader re-reads whenever its text
      // changes, beside the announcement) would be seen.
      final semantics = tester.ensureSemantics();
      final announcements = await pumpBanner(tester);
      c.read(_messages.notifier).set([msg('m1')]);
      await tester.pump();
      await tester.pump();
      expect(announcements.map(said), ['Message from Anitha N: Offer the 3-month plan, the waiver is approved.']);
      expect(((announcements.single! as Map)['data'] as Map)['assertiveness'], isNot(1));
      expect(liveRegions(tester), isEmpty, reason: 'the announcement says it; a live region would say it twice');
      c.read(_messages.notifier).set([msg('m1'), msg('m2', text: 'Wrap up this call', from: 'Ravi')]);
      await tester.pump();
      await tester.pump();
      expect(announcements.map(said).last, 'Message from Ravi: Wrap up this call');
      expect(liveRegions(tester), isEmpty, reason: '"Show 1 more message" appearing is not a new message to read out');
      c.read(_messages.notifier).set([msg('m2', text: 'Wrap up this call', from: 'Ravi')]);
      await tester.pump();
      await tester.pump();
      expect(announcements, hasLength(2));
      expect(liveRegions(tester), isEmpty, reason: 'a dismissal says nothing (LF36)');
      semantics.dispose();
    });

    testWidgets('a message already queued when it mounts is announced too', (tester) async {
      c.read(_messages.notifier).set([msg('m1')]);
      final announcements = await pumpBanner(tester);
      await tester.pump();
      expect(announcements.map(said), ['Message from Anitha N: Offer the 3-month plan, the waiver is approved.']);
    });

    testWidgets('no live region, plain text, a labelled dismiss of 48 dp', (tester) async {
      final semantics = tester.ensureSemantics();
      c.read(_messages.notifier).set([msg('m1', text: '<b>Not bold</b> https://example.test')]);
      await pumpBanner(tester);
      expect(find.text('<b>Not bold</b> https://example.test'), findsOneWidget);
      expect(liveRegions(tester), isEmpty);
      expect(find.byTooltip('Dismiss the message from Anitha N'), findsOneWidget);
      expect(tester.getSize(find.byKey(const Key('dismiss-supervisor-message'))).height, greaterThanOrEqualTo(48));
      semantics.dispose();
    });

    testWidgets('a 500-character message at 200% text on 360×640: no overflow, it scrolls inside the banner', (tester) async {
      c.read(_messages.notifier).set([msg('m1', text: 'x ' * 250), msg('m2')]);
      await pumpBanner(tester, textScale: 2, size: const Size(360, 640));
      expect(tester.takeException(), isNull);
      expect(tester.getSize(find.byKey(const Key('supervisor-message'))).height, lessThan(640 * 0.6));
    });
  });

  group('several messages: every one readable without guessing (LF36, addendum 2026-11-26)', () {
    final burst = [
      msg('m1', text: 'hlo', from: 'Reshma Mohammad'),
      msg('m2', text: 'Offer the 3-month plan', from: 'Reshma Mohammad'),
      msg('m3', text: 'Call me after this one', from: 'Ravi'),
    ];
    final list = find.byKey(const Key('supervisor-message-list'));
    final more = find.byKey(const Key('supervisor-message-toggle'));

    Future<List<Object?>> pumpBanner(WidgetTester tester, {double textScale = 1, Size size = const Size(360, 800)}) async {
      tester.view.devicePixelRatio = 3;
      tester.view.physicalSize = size * 3;
      addTearDown(tester.view.reset);
      final announcements = <Object?>[];
      // Announcements only: a tap's semantics event rides the same channel.
      tester.binding.defaultBinaryMessenger.setMockDecodedMessageHandler<Object?>(SystemChannels.accessibility, (m) async {
        if ((m! as Map)['type'] == 'announce') announcements.add(m);
        return null;
      });
      addTearDown(() => tester.binding.defaultBinaryMessenger.setMockDecodedMessageHandler<Object?>(SystemChannels.accessibility, null));
      await tester.pumpWidget(UncontrolledProviderScope(
        container: c,
        child: MaterialApp(
          theme: buildTheme(AppTokens.light, Brightness.light),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context).copyWith(supportsAnnounce: true, textScaler: TextScaler.linear(textScale)),
            child: child!,
          ),
          home: const Scaffold(
            body: Column(children: [SupervisorMessageBanner(), TextField(key: Key('notes')), Expanded(child: Placeholder(key: Key('the-call')))]),
          ),
        ),
      ));
      return announcements;
    }

    testWidgets('one shown, and a 48 dp button saying how many more; pressing it shows every text, oldest first', (tester) async {
      final semantics = tester.ensureSemantics();
      c.read(_messages.notifier).set(burst);
      await pumpBanner(tester);
      expect(find.text('hlo'), findsOneWidget);
      expect(find.text('Offer the 3-month plan'), findsNothing);
      expect(find.text('Show 2 more messages'), findsOneWidget);
      expect(tester.getSize(more).height, greaterThanOrEqualTo(48));
      expect(tester.getSemantics(more).getSemanticsData().flagsCollection.isButton, isTrue, reason: 'a screen reader says it can be pressed');
      expect(list, findsNothing);

      await tester.tap(more);
      await tester.pumpAndSettle();
      expect(list, findsOneWidget);
      for (final m in burst) {
        expect(find.text(m.text), findsOneWidget, reason: m.id);
      }
      expect(find.text('Reshma Mohammad · 10:05'), findsNWidgets(2));
      expect(find.text('Ravi · 10:05'), findsOneWidget);
      expect(find.text('3 messages'), findsOneWidget);
      final ys = [for (final m in burst) tester.getTopLeft(find.text(m.text)).dy];
      expect(ys, orderedEquals([...ys]..sort()), reason: 'oldest first');
      expect(find.descendant(of: more, matching: find.text('Show less')), findsOneWidget, reason: 'the same button closes it');
      expect(dismissed, isEmpty, reason: 'opening the list dismisses nothing');
      semantics.dispose();
    });

    testWidgets('open: each Dismiss takes only its own; a new message joins the list; one left, it closes', (tester) async {
      c.read(_messages.notifier).set(burst);
      await pumpBanner(tester);
      await tester.tap(more);
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('dismiss-supervisor-message-m2')));
      expect(dismissed, ['m2']);
      c.read(_messages.notifier).set([burst[0], burst[2]]);
      await tester.pumpAndSettle();
      expect(list, findsOneWidget, reason: 'still open with two left');
      expect(find.text('hlo'), findsOneWidget);
      expect(find.text('Call me after this one'), findsOneWidget);
      expect(find.text('Offer the 3-month plan'), findsNothing);

      c.read(_messages.notifier).set([burst[0], burst[2], msg('m4', text: 'Good work today')]);
      await tester.pumpAndSettle();
      expect(find.text('Good work today'), findsOneWidget, reason: 'a message arriving while open shows in the list');
      expect(find.text('3 messages'), findsOneWidget);

      c.read(_messages.notifier).set([burst[2]]);
      await tester.pumpAndSettle();
      expect(list, findsNothing, reason: 'one left: back to the single banner');
      expect(find.byKey(const Key('dismiss-all-supervisor-messages')), findsNothing);
      expect(find.text('Call me after this one'), findsOneWidget);
      expect(find.byKey(const Key('dismiss-supervisor-message')), findsOneWidget);

      // The next burst starts with one shown again.
      c.read(_messages.notifier).set([burst[2], msg('m5', text: 'One more thing')]);
      await tester.pumpAndSettle();
      expect(list, findsNothing);
      expect(find.text('Show 1 more message'), findsOneWidget);
    });

    testWidgets('Dismiss all clears the burst in one press; Show less closes the list', (tester) async {
      final semantics = tester.ensureSemantics();
      c.read(_messages.notifier).set(burst);
      await pumpBanner(tester);
      await tester.tap(more);
      await tester.pumpAndSettle();
      await tester.tap(more);
      await tester.pumpAndSettle();
      expect(list, findsNothing);
      expect(find.text('Show 2 more messages'), findsOneWidget);
      expect(dismissed, isEmpty);

      await tester.tap(more);
      await tester.pumpAndSettle();
      final all = find.byKey(const Key('dismiss-all-supervisor-messages'));
      expect(tester.getSize(all).height, greaterThanOrEqualTo(48));
      final allSaid = tester.getSemantics(all).getSemanticsData();
      expect(allSaid.label, 'Dismiss all messages');
      expect(allSaid.flagsCollection.isButton, isTrue);
      expect(allSaid.flagsCollection.isEnabled.toBoolOrNull(), isTrue, reason: 'the button\'s own flags, not a label laid over them');
      expect(allSaid.flagsCollection.isFocused, isNot(Tristate.none), reason: 'it can take focus');
      expect(allSaid.hasAction(SemanticsAction.tap), isTrue);
      await tester.tap(all);
      await tester.pump();
      for (final m in burst) {
        expect(find.text(m.text), findsNothing, reason: '${m.id} leaves the banner at once');
      }
      expect(dismissed, isEmpty, reason: 'not yet: Undo can still bring them back');
      await tester.pump(SupervisorMessageBanner.undoWindow);
      expect(dismissed, ['m1', 'm2', 'm3'], reason: 'the window over, each dismissed by id, oldest first');
      c.read(_messages.notifier).set(const []);
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('supervisor-message')), findsNothing);
      semantics.dispose();
    });

    testWidgets('twenty held, open on 360×800 with no bound given: at most a third of the window, the list scrolling inside; the call stays on screen',
        (tester) async {
      c.read(_messages.notifier).set([for (var i = 1; i <= 20; i++) msg('m$i', text: 'Message number $i, a line or two long so it wraps.')]);
      await pumpBanner(tester);
      await tester.tap(more);
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(tester.getSize(find.byKey(const Key('supervisor-message'))).height, lessThanOrEqualTo(800 / 3 + 0.5));
      final call = tester.getRect(find.byKey(const Key('the-call')));
      expect(call.height, greaterThan(800 * 0.5), reason: 'the call under the banner keeps most of the screen');
      // The last one is reached by scrolling inside the list.
      final last = find.text('Message number 20, a line or two long so it wraps.');
      await tester.dragUntilVisible(last, find.descendant(of: list, matching: find.byType(SingleChildScrollView)), const Offset(0, -200));
      await tester.pumpAndSettle();
      expect(tester.getRect(last).bottom, lessThanOrEqualTo(tester.getRect(list).bottom + 0.5));
      expect(tester.getRect(find.byKey(const Key('the-call'))), call, reason: 'scrolling inside the list moves nothing under it');
    });

    testWidgets('open at 200% text on 360×640: no overflow, still bounded', (tester) async {
      c.read(_messages.notifier).set([for (var i = 1; i <= 5; i++) msg('m$i', text: 'x ' * 120)]);
      await pumpBanner(tester, textScale: 2, size: const Size(360, 640));
      await tester.tap(more);
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(tester.getSize(find.byKey(const Key('supervisor-message'))).height, lessThanOrEqualTo(640 / 3 + 0.5));
    });

    testWidgets('opening, closing and dismissing say nothing again: each id announced once, no live region', (tester) async {
      final semantics = tester.ensureSemantics();
      final announcements = await pumpBanner(tester);
      c.read(_messages.notifier).set(burst.sublist(0, 2));
      await tester.pump();
      await tester.pump();
      expect(announcements, hasLength(2));
      await tester.tap(more);
      await tester.pumpAndSettle();
      expect(announcements, hasLength(2), reason: 'opening the list is not a new message');
      expect(liveRegions(tester), isEmpty);
      c.read(_messages.notifier).set(burst);
      await tester.pump();
      await tester.pump();
      expect(announcements.map(said).skip(2), ['Message from Ravi: Call me after this one']);
      c.read(_messages.notifier).set([burst[2]]);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('dismiss-supervisor-message')));
      await tester.pumpAndSettle();
      expect(announcements, hasLength(3));
      expect(liveRegions(tester), isEmpty);
      semantics.dispose();
    });
  });

  group('focus and what a screen reader is told (LF36, addendum 2026-11-26)', () {
    final toggle = find.byKey(const Key('supervisor-message-toggle'));
    final list = find.byKey(const Key('supervisor-message-list'));
    Finder dismissOf(String id) => find.byKey(ValueKey('dismiss-supervisor-message-$id'));
    final single = find.byKey(const Key('dismiss-supervisor-message'));

    Future<void> pumpBanner(WidgetTester tester) async {
      tester.view.devicePixelRatio = 3;
      tester.view.physicalSize = const Size(360, 800) * 3;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(UncontrolledProviderScope(
        container: c,
        child: MaterialApp(
          theme: buildTheme(AppTokens.light, Brightness.light),
          home: const Scaffold(
            body: Column(children: [SupervisorMessageBanner(), TextField(key: Key('notes')), Expanded(child: Placeholder())]),
          ),
        ),
      ));
    }

    /// The focus node of the control [f] finds (the one it was built with).
    FocusNode focusOf(WidgetTester tester, Finder f) =>
        Focus.of(tester.element(find.descendant(of: f, matching: find.byWidgetPredicate((w) => w is Text || w is Icon)).first));

    FocusNode? focused() => FocusManager.instance.primaryFocus;

    bool? expanded(WidgetTester tester) => tester.getSemantics(toggle).getSemanticsData().flagsCollection.isExpanded.toBoolOrNull();

    testWidgets('Show more and Show less are one button: it keeps focus both ways and says whether the list is open', (tester) async {
      final semantics = tester.ensureSemantics();
      c.read(_messages.notifier).set([msg('m1'), msg('m2'), msg('m3')]);
      await pumpBanner(tester);
      expect(expanded(tester), isFalse);
      final node = focusOf(tester, toggle)..requestFocus();
      await tester.pump();

      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(list, findsOneWidget);
      expect(focused(), same(node), reason: 'the button pressed still has focus');
      expect(focusOf(tester, toggle), same(node));
      expect(expanded(tester), isTrue);
      expect(tester.getSemantics(toggle).getSemanticsData().label, 'Show less');

      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(list, findsNothing);
      expect(focused(), same(node));
      expect(expanded(tester), isFalse);
      expect(tester.getSemantics(toggle).getSemanticsData().label, 'Show 2 more messages');
      expect(dismissed, isEmpty);
      semantics.dispose();
    });

    testWidgets('a focused Dismiss whose message goes hands focus to the next message\'s Dismiss, else the one before', (tester) async {
      c.read(_messages.notifier).set([msg('m1'), msg('m2'), msg('m3'), msg('m4')]);
      await pumpBanner(tester);
      await tester.tap(toggle);
      await tester.pumpAndSettle();

      focusOf(tester, dismissOf('m2')).requestFocus();
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      expect(dismissed, ['m2']);
      c.read(_messages.notifier).set([msg('m1'), msg('m3'), msg('m4')]);
      await tester.pumpAndSettle();
      expect(focused(), same(focusOf(tester, dismissOf('m3'))), reason: 'the next one');

      focusOf(tester, dismissOf('m4')).requestFocus();
      await tester.pump();
      c.read(_messages.notifier).set([msg('m1'), msg('m3')]);
      await tester.pumpAndSettle();
      expect(focused(), same(focusOf(tester, dismissOf('m3'))), reason: 'the last one went: the one before it');
    });

    testWidgets('the list closing by itself keeps focus in the banner: on the Dismiss left, or the one it was on', (tester) async {
      c.read(_messages.notifier).set([msg('m1'), msg('m2')]);
      await pumpBanner(tester);
      await tester.tap(toggle);
      await tester.pumpAndSettle();
      focusOf(tester, toggle).requestFocus();
      await tester.pump();
      // The other one dismissed (by Dismiss all elsewhere, or another of the agent's devices): one left.
      c.read(_messages.notifier).set([msg('m2')]);
      await tester.pumpAndSettle();
      expect(list, findsNothing);
      expect(toggle, findsNothing);
      expect(focused(), same(focusOf(tester, single)), reason: 'the button went with the list: the Dismiss left');

      c.read(_messages.notifier).set([msg('m2'), msg('m3')]);
      await tester.pumpAndSettle();
      await tester.tap(toggle);
      await tester.pumpAndSettle();
      final m3 = focusOf(tester, dismissOf('m3'))..requestFocus();
      await tester.pump();
      c.read(_messages.notifier).set([msg('m3')]);
      await tester.pumpAndSettle();
      expect(list, findsNothing);
      expect(focused(), same(m3), reason: 'its own Dismiss, now the only one');

      // Closed, the first one's Dismiss: dismissed, the next one moving up takes focus.
      c.read(_messages.notifier).set([msg('m3'), msg('m4')]);
      await tester.pumpAndSettle();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      expect(dismissed, ['m3']);
      c.read(_messages.notifier).set([msg('m4')]);
      await tester.pumpAndSettle();
      expect(focused(), same(focusOf(tester, single)));
      expect(focused(), isNot(same(m3)));
    });

    testWidgets('nothing in the banner had focus: nothing takes it, as messages arrive, open, go and close', (tester) async {
      await pumpBanner(tester);
      final notes = tester.widget<EditableText>(find.descendant(of: find.byKey(const Key('notes')), matching: find.byType(EditableText))).focusNode;
      notes.requestFocus();
      await tester.pump();
      c.read(_messages.notifier).set([msg('m1')]);
      await tester.pumpAndSettle();
      expect(focused(), same(notes), reason: 'nothing takes focus on arrival (LF36)');
      c.read(_messages.notifier).set([msg('m1'), msg('m2'), msg('m3')]);
      await tester.pumpAndSettle();
      // Opened with a screen reader's tap, which moves no input focus.
      tester.widget<ButtonStyleButton>(toggle).onPressed!();
      await tester.pumpAndSettle();
      expect(list, findsOneWidget);
      c.read(_messages.notifier).set([msg('m1'), msg('m3')]);
      await tester.pumpAndSettle();
      c.read(_messages.notifier).set([msg('m3')]);
      await tester.pumpAndSettle();
      expect(list, findsNothing);
      c.read(_messages.notifier).set(const []);
      await tester.pumpAndSettle();
      expect(focused(), same(notes));
    });

    testWidgets('each Dismiss says whose message it takes away', (tester) async {
      final semantics = tester.ensureSemantics();
      c.read(_messages.notifier).set([msg('m1', from: 'Reshma Mohammad'), msg('m2', from: 'Your supervisor'), msg('m3', from: 'Ravi')]);
      await pumpBanner(tester);
      // What a screen reader says for the button (its tooltip, on the button's own node).
      String says(Finder button) => tester.getSemantics(find.descendant(of: button, matching: find.byType(Icon))).getSemanticsData().tooltip;
      expect(says(single), 'Dismiss the message from Reshma Mohammad');
      await tester.tap(toggle);
      await tester.pumpAndSettle();
      expect(says(dismissOf('m1')), 'Dismiss the message from Reshma Mohammad');
      expect(says(dismissOf('m2')), 'Dismiss the message from Your supervisor');
      expect(says(dismissOf('m3')), 'Dismiss the message from Ravi');
      for (final id in ['m1', 'm2', 'm3']) {
        expect(tester.getSize(dismissOf(id)).height, greaterThanOrEqualTo(48), reason: id);
      }
      semantics.dispose();
    });
  });

  // ── LF36, decided 2026-11-26 ──

  final burst3 = [
    msg('m1', text: 'hlo', from: 'Reshma Mohammad'),
    msg('m2', text: 'Offer the 3-month plan', from: 'Reshma Mohammad'),
    msg('m3', text: 'Call me after this one', from: 'Ravi'),
  ];
  final list = find.byKey(const Key('supervisor-message-list'));
  final toggle = find.byKey(const Key('supervisor-message-toggle'));
  final all = find.byKey(const Key('dismiss-all-supervisor-messages'));
  final undo = find.byKey(const Key('undo-dismiss-all-supervisor-messages'));
  final undoLine = find.byKey(const Key('supervisor-message-undo-line'));
  final seeAll = find.byKey(const Key('supervisor-message-see-all'));
  final bannerBox = find.byKey(const Key('supervisor-message'));

  /// The banner over a note field and the call, on a 360×800 phone; the announcements it sends.
  Future<List<Object?>> pumpOver(WidgetTester tester, {bool disableAnimations = false, bool screenReader = false}) async {
    tester.view.devicePixelRatio = 3;
    tester.view.physicalSize = const Size(360, 800) * 3;
    addTearDown(tester.view.reset);
    final announcements = <Object?>[];
    tester.binding.defaultBinaryMessenger.setMockDecodedMessageHandler<Object?>(SystemChannels.accessibility, (m) async {
      if ((m! as Map)['type'] == 'announce') announcements.add(m);
      return null;
    });
    addTearDown(() => tester.binding.defaultBinaryMessenger.setMockDecodedMessageHandler<Object?>(SystemChannels.accessibility, null));
    await tester.pumpWidget(UncontrolledProviderScope(
      container: c,
      child: MaterialApp(
        theme: buildTheme(AppTokens.light, Brightness.light),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(supportsAnnounce: true, disableAnimations: disableAnimations, accessibleNavigation: screenReader),
          child: child!,
        ),
        home: const Scaffold(
          body: Column(children: [SupervisorMessageBanner(), TextField(key: Key('notes')), Expanded(child: Placeholder(key: Key('the-call')))]),
        ),
      ),
    ));
    return announcements;
  }

  FocusNode focusOf(WidgetTester tester, Finder f) =>
      Focus.of(tester.element(find.descendant(of: f, matching: find.byWidgetPredicate((w) => w is Text || w is Icon)).first));
  FocusNode notesFocus(WidgetTester tester) =>
      tester.widget<EditableText>(find.descendant(of: find.byKey(const Key('notes')), matching: find.byType(EditableText))).focusNode;
  FocusNode? focused() => FocusManager.instance.primaryFocus;

  /// The texts on screen in the order they are laid out, of [ids].
  List<String> order(WidgetTester tester, List<SupervisorMessageView> ms) {
    final ys = {for (final m in ms) m.id: tester.getTopLeft(find.text(m.text)).dy};
    return [...ys.keys]..sort((a, b) => ys[a]!.compareTo(ys[b]!));
  }

  Future<void> openList(WidgetTester tester) async {
    tester.widget<ButtonStyleButton>(toggle).onPressed!();
    await tester.pumpAndSettle();
    expect(list, findsOneWidget);
  }

  group('Dismiss all can be undone (LF36, decided 2026-11-26)', () {
    testWidgets('"3 messages dismissed" and a 48 dp Undo hold the banner\'s place, said once, politely; Undo brings them back in order, said to no one again, dismissed never',
        (tester) async {
      final semantics = tester.ensureSemantics();
      final announcements = await pumpOver(tester);
      c.read(_messages.notifier).set(burst3);
      await tester.pump();
      await tester.pump();
      expect(announcements, hasLength(3));
      await openList(tester);
      await tester.tap(all);
      await tester.pump();
      await tester.pump();
      expect(bannerBox, findsOneWidget, reason: 'the banner stays, for Undo');
      expect(find.text('3 messages dismissed'), findsOneWidget);
      for (final m in burst3) {
        expect(find.text(m.text), findsNothing, reason: m.id);
      }
      expect(tester.getSize(undo).height, greaterThanOrEqualTo(48));
      final undoSaid = tester.getSemantics(undo).getSemanticsData();
      expect(undoSaid.label, 'Undo: bring the 3 messages back');
      expect(undoSaid.flagsCollection.isButton, isTrue);
      expect(announcements.map(said).skip(3), ['3 messages dismissed. Press Undo to bring them back.']);
      expect(((announcements.last! as Map)['data'] as Map)['assertiveness'], isNot(1), reason: 'politely');
      expect(liveRegions(tester), isEmpty, reason: 'said once, by the announcement');
      expect(tester.getSize(bannerBox).height, lessThanOrEqualTo(64.5), reason: 'one row');

      await tester.pump(const Duration(seconds: 3));
      await tester.tap(undo);
      await tester.pumpAndSettle();
      expect(undoLine, findsNothing);
      expect(find.text('hlo'), findsOneWidget, reason: 'the first back in its place');
      expect(find.text('Show 2 more messages'), findsOneWidget);
      await openList(tester);
      expect(order(tester, burst3), ['m1', 'm2', 'm3'], reason: 'oldest first, as they were');
      expect(announcements, hasLength(4), reason: 'nothing is said again: they never left');
      await tester.pump(SupervisorMessageBanner.undoWindowScreenReader * 2);
      expect(dismissed, isEmpty, reason: 'undone: never dismissed');
      semantics.dispose();
    });

    testWidgets('no Undo: dismissed through the seam, each by id, when the window ends and not before', (tester) async {
      await pumpOver(tester);
      c.read(_messages.notifier).set(burst3);
      await tester.pumpAndSettle();
      await openList(tester);
      await tester.tap(all);
      await tester.pump(SupervisorMessageBanner.undoWindow - const Duration(milliseconds: 100));
      expect(dismissed, isEmpty);
      expect(undo, findsOneWidget);
      await tester.pump(const Duration(milliseconds: 200));
      expect(dismissed, ['m1', 'm2', 'm3']);
      c.read(_messages.notifier).set(const []);
      await tester.pumpAndSettle();
      expect(bannerBox, findsNothing);
    });

    testWidgets('with a screen reader on, the window is longer', (tester) async {
      await pumpOver(tester, screenReader: true);
      c.read(_messages.notifier).set(burst3);
      await tester.pumpAndSettle();
      await openList(tester);
      await tester.tap(all);
      await tester.pump(SupervisorMessageBanner.undoWindow + const Duration(seconds: 1));
      expect(dismissed, isEmpty, reason: 'time to hear the line and find Undo');
      await tester.pump(SupervisorMessageBanner.undoWindowScreenReader - SupervisorMessageBanner.undoWindow);
      expect(dismissed, ['m1', 'm2', 'm3']);
    });

    testWidgets('a message arriving in the window shows, with Undo under it; Undo puts the others back before it, oldest first', (tester) async {
      final announcements = await pumpOver(tester);
      c.read(_messages.notifier).set(burst3);
      await tester.pumpAndSettle();
      await openList(tester);
      await tester.tap(all);
      await tester.pump();
      c.read(_messages.notifier).set([...burst3, msg('m4', text: 'Good work today')]);
      await tester.pump();
      await tester.pump();
      expect(find.text('Good work today'), findsOneWidget, reason: 'the new one shows');
      expect(find.text('hlo'), findsNothing);
      expect(find.text('3 messages dismissed'), findsOneWidget, reason: 'Undo still offered, under it');
      expect(tester.getRect(undoLine).top, greaterThanOrEqualTo(tester.getRect(find.text('Good work today')).bottom));
      expect(announcements.map(said).where((a) => a.contains('Good work today')), hasLength(1));
      expect(tester.takeException(), isNull);

      await tester.tap(undo);
      await tester.pumpAndSettle();
      expect(find.text('hlo'), findsOneWidget);
      expect(find.text('Show 3 more messages'), findsOneWidget);
      await openList(tester);
      expect(order(tester, [...burst3, msg('m4', text: 'Good work today')]), ['m1', 'm2', 'm3', 'm4']);
      expect(announcements.map(said).where((a) => a.startsWith('Message from')), hasLength(4), reason: 'each id once');
      await tester.pump(SupervisorMessageBanner.undoWindowScreenReader);
      expect(dismissed, isEmpty);
    });

    testWidgets('a message arriving in the window, no Undo: only the others are dismissed; it stays', (tester) async {
      await pumpOver(tester);
      c.read(_messages.notifier).set(burst3);
      await tester.pumpAndSettle();
      await openList(tester);
      await tester.tap(all);
      await tester.pump();
      c.read(_messages.notifier).set([...burst3, msg('m4', text: 'Good work today')]);
      await tester.pump(SupervisorMessageBanner.undoWindow);
      expect(dismissed, ['m1', 'm2', 'm3']);
      c.read(_messages.notifier).set([msg('m4', text: 'Good work today')]);
      await tester.pumpAndSettle();
      expect(find.text('Good work today'), findsOneWidget);
      expect(undoLine, findsNothing);
    });

    testWidgets('a second Dismiss all sends the first at once; the banner going sends one still pending', (tester) async {
      await pumpOver(tester);
      c.read(_messages.notifier).set(burst3);
      await tester.pumpAndSettle();
      await openList(tester);
      await tester.tap(all);
      await tester.pump();
      c.read(_messages.notifier).set([...burst3, msg('m4', text: 'One'), msg('m5', text: 'Two')]);
      await tester.pumpAndSettle();
      await openList(tester);
      await tester.tap(all);
      await tester.pump();
      expect(dismissed, ['m1', 'm2', 'm3'], reason: 'the first one, replaced');
      expect(find.text('2 messages dismissed'), findsOneWidget);
      c.read(_messages.notifier).set([msg('m4', text: 'One'), msg('m5', text: 'Two')]);
      await tester.pump();
      // The banner goes (the station closing, the shell leaving): what it held is sent.
      await tester.pumpWidget(const SizedBox());
      await tester.pump();
      expect(dismissed, ['m1', 'm2', 'm3', 'm4', 'm5']);
    });

    testWidgets('focus: Dismiss all from the keyboard moves it to Undo, Undo to the button; pressed with a tap, nothing takes it', (tester) async {
      await pumpOver(tester);
      c.read(_messages.notifier).set(burst3);
      await tester.pumpAndSettle();
      focusOf(tester, toggle).requestFocus();
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      focusOf(tester, all).requestFocus();
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(focused(), same(focusOf(tester, undo)), reason: 'Undo, the one thing left to press');
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(find.text('hlo'), findsOneWidget);
      expect(focused(), same(focusOf(tester, toggle)), reason: 'the button that opens them again');

      final notes = notesFocus(tester)..requestFocus();
      await tester.pump();
      await openList(tester);
      tester.widget<ButtonStyleButton>(all).onPressed!();
      await tester.pumpAndSettle();
      tester.widget<ButtonStyleButton>(undo).onPressed!();
      await tester.pumpAndSettle();
      expect(focused(), same(notes), reason: 'a screen reader\'s press moves no input focus');
    });
  });

  group('the keyboard up: See all hides it (LF36, decided 2026-11-26)', () {
    void keyboard(WidgetTester tester, double dp) => tester.view.viewInsets = FakeViewPadding(bottom: dp * 3);

    testWidgets('the note lets go of focus, the keyboard is told to hide, and the list opens once it is down', (tester) async {
      final semantics = tester.ensureSemantics();
      await pumpOver(tester);
      c.read(_messages.notifier).set(burst3);
      await tester.pumpAndSettle();
      await tester.showKeyboard(find.byKey(const Key('notes')));
      keyboard(tester, 300);
      await tester.pumpAndSettle();
      expect(tester.testTextInput.isVisible, isTrue);
      expect(tester.getSize(bannerBox).height, lessThanOrEqualTo(64.5), reason: 'one row');
      expect(find.descendant(of: seeAll, matching: find.text('See all 3')), findsOneWidget);
      expect(tester.getSize(seeAll).height, greaterThanOrEqualTo(48));
      final said = tester.getSemantics(seeAll).getSemanticsData();
      expect(said.label, 'Hide the keyboard to see all 3 messages');
      expect(said.flagsCollection.isButton, isTrue);
      expect(toggle, findsNothing);

      tester.testTextInput.log.clear();
      await tester.tap(seeAll);
      await tester.pump();
      expect(notesFocus(tester).hasFocus, isFalse, reason: 'the note lets go of focus');
      expect(tester.testTextInput.isVisible, isFalse, reason: 'the keyboard is hidden');
      expect(tester.testTextInput.log.map((m) => m.method), contains('TextInput.hide'));
      expect(dismissed, isEmpty);

      keyboard(tester, 0);
      await tester.pumpAndSettle();
      expect(list, findsOneWidget, reason: 'asked to see all: the list opens');
      expect(find.descendant(of: toggle, matching: find.text('Show less')), findsOneWidget);
      expect(order(tester, burst3), ['m1', 'm2', 'm3']);
      semantics.dispose();
    });

    testWidgets('pressed from a hardware keyboard: once there is room, focus is on the list\'s button', (tester) async {
      await pumpOver(tester);
      c.read(_messages.notifier).set(burst3);
      await tester.pumpAndSettle();
      keyboard(tester, 300);
      await tester.pumpAndSettle();
      focusOf(tester, seeAll).requestFocus();
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      keyboard(tester, 0);
      await tester.pumpAndSettle();
      expect(list, findsOneWidget);
      expect(focused(), same(focusOf(tester, toggle)));
    });

    testWidgets('Undo\'s line with the keyboard up: one row, its 48 dp Undo', (tester) async {
      await pumpOver(tester);
      c.read(_messages.notifier).set(burst3);
      await tester.pumpAndSettle();
      await openList(tester);
      await tester.tap(all);
      await tester.pump();
      keyboard(tester, 300);
      await tester.pump();
      await tester.pump();
      expect(tester.takeException(), isNull);
      expect(tester.getSize(bannerBox).height, lessThanOrEqualTo(64.5));
      expect(undo.hitTestable(), findsOneWidget);
      expect(tester.getSize(undo).height, greaterThanOrEqualTo(48));
    });
  });

  group('a call arriving closes the open list (LF36, decided 2026-11-26)', () {
    testWidgets('a campaign call as it comes and as it connects, each time; waiting and wrap-up leave it; nothing dismissed', (tester) async {
      await pumpOver(tester);
      c.read(_view.notifier).set(station());
      c.read(_messages.notifier).set(burst3);
      await tester.pumpAndSettle();
      await openList(tester);

      c.read(_view.notifier).set(station(phase: AgentPhase.reserved, call: call()));
      await tester.pumpAndSettle();
      expect(list, findsNothing, reason: 'Call coming: the call has the screen');
      expect(find.text('hlo'), findsOneWidget, reason: 'the banner stays, closed');
      expect(find.text('Show 2 more messages'), findsOneWidget);

      await openList(tester);
      c.read(_view.notifier).set(station(phase: AgentPhase.onCall, call: call(bridgedAt: DateTime(2026, 11, 19, 10, 6))));
      await tester.pumpAndSettle();
      expect(list, findsNothing, reason: 'it connected');

      await openList(tester);
      c.read(_view.notifier).set(station(phase: AgentPhase.wrapup, call: call(bridgedAt: DateTime(2026, 11, 19, 10, 6))));
      await tester.pumpAndSettle();
      expect(list, findsOneWidget, reason: 'wrap-up: nothing arrived');
      c.read(_view.notifier).set(station());
      await tester.pumpAndSettle();
      expect(list, findsOneWidget, reason: 'waiting again');

      c.read(_view.notifier).set(station(phase: AgentPhase.reserved, call: call(attemptId: 'a2')));
      await tester.pumpAndSettle();
      expect(list, findsNothing, reason: 'the next call');
      expect(dismissed, isEmpty, reason: 'closing dismisses nothing');
    });

    testWidgets('an inbound call offered closes it', (tester) async {
      await pumpOver(tester);
      c.read(_view.notifier).set(station());
      c.read(_messages.notifier).set(burst3);
      await tester.pumpAndSettle();
      await openList(tester);
      c.read(_view.notifier).set(inboundStation(inbound: caller()));
      await tester.pumpAndSettle();
      expect(list, findsNothing);
      expect(dismissed, isEmpty);
    });

    testWidgets('focus in the list goes to the button that opens it; focus anywhere else is not taken', (tester) async {
      await pumpOver(tester);
      c.read(_view.notifier).set(station());
      c.read(_messages.notifier).set(burst3);
      await tester.pumpAndSettle();
      await openList(tester);
      focusOf(tester, find.byKey(const ValueKey('dismiss-supervisor-message-m3'))).requestFocus();
      await tester.pump();
      c.read(_view.notifier).set(station(phase: AgentPhase.reserved, call: call()));
      await tester.pumpAndSettle();
      expect(list, findsNothing);
      expect(focused(), same(focusOf(tester, toggle)), reason: 'kept in the banner');

      c.read(_view.notifier).set(station());
      await tester.pumpAndSettle();
      final notes = notesFocus(tester)..requestFocus();
      await tester.pump();
      await openList(tester);
      c.read(_view.notifier).set(station(phase: AgentPhase.reserved, call: call(attemptId: 'a2')));
      await tester.pumpAndSettle();
      expect(list, findsNothing);
      expect(focused(), same(notes), reason: 'never taken from elsewhere');
    });

    testWidgets('open, then the keyboard up, then a call: the list does not open again as the keyboard goes', (tester) async {
      await pumpOver(tester);
      c.read(_view.notifier).set(station());
      c.read(_messages.notifier).set(burst3);
      await tester.pumpAndSettle();
      await openList(tester);
      tester.view.viewInsets = const FakeViewPadding(bottom: 900);
      await tester.pumpAndSettle();
      expect(list, findsNothing);
      c.read(_view.notifier).set(station(phase: AgentPhase.reserved, call: call()));
      await tester.pumpAndSettle();
      tester.view.viewInsets = FakeViewPadding.zero;
      await tester.pumpAndSettle();
      expect(list, findsNothing);
      expect(find.text('Show 2 more messages'), findsOneWidget);
    });
  });

  group('a message arriving while the list is open scrolls into view (LF36, decided 2026-11-26)', () {
    final eight = [for (var i = 1; i <= 8; i++) msg('m$i', text: 'Message $i')];
    final ninth = msg('m9', text: 'Message 9, the newest');
    ScrollPosition position(WidgetTester tester) =>
        tester.widget<SingleChildScrollView>(find.descendant(of: list, matching: find.byType(SingleChildScrollView))).controller!.position;
    bool inList(WidgetTester tester, Finder f) {
      final r = tester.getRect(f);
      final l = tester.getRect(list);
      return r.top >= l.top - 0.5 && r.bottom <= l.bottom + 0.5;
    }

    testWidgets('the list scrolls to the newest; focus stays where it was; said once', (tester) async {
      final announcements = await pumpOver(tester);
      c.read(_messages.notifier).set(eight);
      await tester.pumpAndSettle();
      final notes = notesFocus(tester)..requestFocus();
      await tester.pump();
      await openList(tester);
      expect(position(tester).pixels, 0, reason: 'at the top, the oldest');
      expect(position(tester).maxScrollExtent, greaterThan(0), reason: 'more than the list shows');
      c.read(_messages.notifier).set([...eight, ninth]);
      await tester.pumpAndSettle();
      expect(inList(tester, find.text(ninth.text)), isTrue, reason: 'the newest in view');
      expect(position(tester).pixels, position(tester).maxScrollExtent);
      expect(focused(), same(notes), reason: 'no focus moves');
      expect(announcements.map(said).where((a) => a.contains('the newest')), hasLength(1));
    });

    testWidgets('it animates there', (tester) async {
      await pumpOver(tester);
      c.read(_messages.notifier).set(eight);
      await tester.pumpAndSettle();
      await openList(tester);
      c.read(_messages.notifier).set([...eight, ninth]);
      await tester.pump();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 80));
      final p = position(tester);
      expect(p.pixels, allOf(greaterThan(0), lessThan(p.maxScrollExtent)), reason: 'on its way');
      await tester.pumpAndSettle();
      expect(position(tester).pixels, position(tester).maxScrollExtent);
    });

    testWidgets('with reduced motion it moves at once', (tester) async {
      await pumpOver(tester, disableAnimations: true);
      c.read(_messages.notifier).set(eight);
      await tester.pumpAndSettle();
      await openList(tester);
      c.read(_messages.notifier).set([...eight, ninth]);
      await tester.pump();
      await tester.pump();
      expect(position(tester).pixels, position(tester).maxScrollExtent, reason: 'no animation');
    });

    testWidgets('the agent\'s finger on the list: it is not moved', (tester) async {
      await pumpOver(tester);
      c.read(_messages.notifier).set(eight);
      await tester.pumpAndSettle();
      await openList(tester);
      final gesture = await tester.startGesture(tester.getCenter(list));
      await gesture.moveBy(const Offset(0, -30));
      await tester.pump();
      await gesture.moveBy(const Offset(0, -10));
      await tester.pump();
      final held = position(tester).pixels;
      expect(held, greaterThan(0));
      c.read(_messages.notifier).set([...eight, ninth]);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(position(tester).pixels, held, reason: 'not yanked from under the finger');
      await gesture.up();
      await tester.pumpAndSettle();
      expect(position(tester).pixels, lessThan(position(tester).maxScrollExtent), reason: 'nor afterwards');
    });
  });
}

String said(Object? m) => ((m! as Map)['data'] as Map)['message'] as String;

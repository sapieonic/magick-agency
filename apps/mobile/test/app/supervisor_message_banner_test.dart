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
      expect(dismissed, ['m1', 'm2', 'm3']);
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
}

String said(Object? m) => ((m! as Map)['data'] as Map)['message'] as String;

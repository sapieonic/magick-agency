import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show SemanticsAction;
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';

import 'shell_harness.dart';

/// The supervisor's message banner in the real shell (LF36's addendum of 2026-11-26): it takes at
/// most about a third of the room the shell has under the status bar (the keyboard and the tab bar
/// already off it), never less than one message beside its Dismiss, and never overflows, so the tab
/// under it keeps the rest: at 200% text, and on a phone on its side. While the keyboard is up it
/// takes only that one row, whatever the phone, so the note being typed keeps its room. With no
/// room for the open list it shows the first message and says how to get the room (LF36, decided
/// 2026-11-26): with the keyboard up, a 48 dp "See all 3" that hides the keyboard, inside that one
/// row; on a phone on its side, "Turn your phone upright to see all 3 messages"; in a short window
/// standing up (split screen), how many more wait. It opens the list again once there is room. The
/// app's own fonts are loaded, so heights are the ones a phone lays out.

class _Messages extends Notifier<List<SupervisorMessageView>> {
  @override
  List<SupervisorMessageView> build() => const [];
  void set(List<SupervisorMessageView> m) => state = m;
}

final _messages = NotifierProvider<_Messages, List<SupervisorMessageView>>(_Messages.new);

SupervisorMessageView msg(String id, {String? text, String from = 'Reshma Mohammad'}) => SupervisorMessageView(
      id: id,
      text: text ?? 'Message number $id, a line or two long so that it wraps on a small phone.',
      from: from,
      sentAt: DateTime(2026, 11, 19, 10, 5),
    );

final banner = find.byKey(const Key('supervisor-message'));
final body = find.byKey(const ValueKey('shell-body'));
final list = find.byKey(const Key('supervisor-message-list'));
final toggle = find.byKey(const Key('supervisor-message-toggle'));
final seeAll = find.byKey(const Key('supervisor-message-see-all'));

void main() {
  setUpAll(() async {
    for (final (family, files) in [
      ('Inter', ['Inter-400', 'Inter-500', 'Inter-600', 'Inter-700']),
      ('PlusJakartaSans', ['PlusJakartaSans-600', 'PlusJakartaSans-700', 'PlusJakartaSans-800']),
    ]) {
      final loader = FontLoader(family);
      for (final f in files) {
        loader.addFont(Future.value(ByteData.sublistView(File('assets/fonts/$f.ttf').readAsBytesSync())));
      }
      await loader.load();
    }
  });

  late ProviderContainer c;
  setUp(() {
    c = shellContainer(extra: [
      supervisorMessagesProvider.overrideWith((ref) => ref.watch(_messages)),
      dismissSupervisorMessageProvider.overrideWithValue((_) {}),
    ]);
  });
  tearDown(() => c.dispose());

  /// A phone of [size] dp with a 24 dp status bar, [scale] text and a [keyboard] dp keyboard.
  Future<void> phone(WidgetTester tester, Size size, {double scale = 1, double keyboard = 0}) async {
    tester.view.devicePixelRatio = 3;
    tester.view.physicalSize = size * 3;
    tester.view.padding = const FakeViewPadding(top: 24 * 3);
    tester.view.viewInsets = FakeViewPadding(bottom: keyboard * 3);
    tester.platformDispatcher.textScaleFactorTestValue = scale;
    addTearDown(tester.view.reset);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await pumpShell(tester, c);
  }

  void keyboard(WidgetTester tester, double dp) => tester.view.viewInsets = FakeViewPadding(bottom: dp * 3);

  /// The banner's height and the tab's under it; their sum is the room under the status bar.
  ({double banner, double body}) heights(WidgetTester tester) =>
      (banner: tester.getSize(banner).height, body: tester.getSize(body).height);

  group('at most about a third of the room under the status bar, one row with the keyboard up, never an overflow', () {
    // (phone, text scale, keyboard, messages (a long first one), open asked, the list shown, the
    // least the tab under it keeps)
    final cases = <(String, Size, double, double, int, bool, bool, double)>[
      ('360×640, twenty, open', const Size(360, 640), 1, 0, 20, false, true, 360),
      ('360×640 at 200%, twenty, open', const Size(360, 640), 2, 0, 20, false, true, 360),
      ('360×640, keyboard 300, twenty, open asked', const Size(360, 640), 1, 300, 20, false, false, 252),
      ('360×640 at 200%, keyboard 300, twenty, open asked', const Size(360, 640), 2, 300, 20, false, false, 252),
      ('360×640 at 200%, keyboard 300, a 500-character first', const Size(360, 640), 2, 300, 2, true, false, 252),
      ('360×640 at 200%, keyboard 330, twenty, open asked', const Size(360, 640), 2, 330, 20, false, false, 222),
      ('360×800, keyboard 300, twenty, open asked', const Size(360, 800), 1, 300, 20, false, false, 412),
      ('360×800 at 200%, keyboard 300, twenty, open asked', const Size(360, 800), 2, 300, 20, false, false, 412),
      ('360×800 at 200%, keyboard 300, three', const Size(360, 800), 2, 300, 3, false, false, 412),
      ('360×640, keyboard 300, two', const Size(360, 640), 1, 300, 2, false, false, 252),
      ('411×917, twenty, open', const Size(411, 917), 1, 0, 20, false, true, 540),
      ('411×917, keyboard 330, twenty, open asked', const Size(411, 917), 1, 330, 20, false, false, 499),
      ('411×917 at 200%, keyboard 330, twenty, open asked', const Size(411, 917), 2, 330, 20, false, false, 499),
      ('800×360 on its side, twenty, open asked', const Size(800, 360), 1, 0, 20, false, false, 170),
      ('800×360 on its side at 200%, twenty, open asked', const Size(800, 360), 2, 0, 20, false, false, 170),
      ('800×360 on its side, keyboard 180, twenty, open asked', const Size(800, 360), 1, 180, 20, false, false, 90),
      ('800×360 on its side at 200%, keyboard 180, a 500-character first', const Size(800, 360), 2, 180, 2, true, false, 90),
    ];
    for (final (name, size, scale, kb, n, long, listShown, least) in cases) {
      testWidgets(name, (tester) async {
        await phone(tester, size, scale: scale);
        c.read(_messages.notifier).set([for (var i = 1; i <= n; i++) msg('m$i', text: long && i == 1 ? 'x ' * 250 : null)]);
        await tester.pumpAndSettle();
        // Opened before the keyboard comes up, as an agent would.
        if (toggle.evaluate().isNotEmpty) {
          await tester.tap(toggle);
          await tester.pumpAndSettle();
        }
        keyboard(tester, kb);
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull, reason: 'no overflow');
        final h = heights(tester);
        final room = h.banner + h.body;
        expect(h.banner, lessThanOrEqualTo((kb > 0 ? 64 : math.max(room / 3, 64)) + 0.5),
            reason: kb > 0 ? 'one row while the keyboard is up' : 'a third of $room, or one row');
        expect(h.body, greaterThanOrEqualTo(least), reason: 'the tab under it keeps $least dp');
        expect(list.evaluate().isNotEmpty, listShown);
        if (n > 1 && !listShown) {
          expect(toggle, findsNothing, reason: 'no room for the list: no button that would open nothing');
          if (kb > 0) {
            // The way to the room, inside the one row: whole, 48 dp, and it takes a press.
            expect(seeAll.hitTestable(), findsOneWidget, reason: 'See all $n, with the keyboard up');
            expect(find.descendant(of: seeAll, matching: find.textContaining('See all $n')), findsOneWidget);
            final b = tester.getRect(seeAll);
            expect(b.height, greaterThanOrEqualTo(48));
            final r = tester.getRect(banner);
            expect(b.top >= r.top - 0.5 && b.bottom <= r.bottom + 0.5 && b.right <= r.right + 0.5, isTrue, reason: '$b inside the banner $r');
            expect(tester.getSize(find.byKey(const Key('supervisor-message-text'))).width, greaterThan(60),
                reason: 'the message keeps a column of its own beside it');
          } else {
            expect(seeAll, findsNothing, reason: 'no keyboard to hide');
            expect(find.textContaining('Turn your phone upright to see all $n messages'), findsOneWidget, reason: 'a phone on its side');
          }
        }
      });
    }
  });

  testWidgets('the keyboard coming up closes the open list to the first message; going down opens it again', (tester) async {
    // The testers' phone: a third of the room under its keyboard would hold the list.
    await phone(tester, const Size(411, 917));
    c.read(_messages.notifier).set([msg('m1'), msg('m2'), msg('m3')]);
    await tester.pumpAndSettle();
    final shut = heights(tester);
    await tester.tap(toggle);
    await tester.pumpAndSettle();
    expect(list, findsOneWidget);

    keyboard(tester, 330);
    await tester.pumpAndSettle();
    expect(heights(tester).banner, 64, reason: 'one row while the keyboard is up');
    expect(list, findsNothing);
    expect(toggle, findsNothing, reason: 'no room for the list: no button that would open nothing');
    expect(find.text('Reshma Mohammad · 10:05'), findsOneWidget);
    expect(find.descendant(of: seeAll, matching: find.text('See all 3')), findsOneWidget, reason: 'the way to see the rest');
    expect(find.byKey(const Key('dismiss-supervisor-message')), findsOneWidget);

    keyboard(tester, 0);
    await tester.pumpAndSettle();
    expect(list, findsOneWidget, reason: 'it was open, so it opens again');
    expect(find.descendant(of: toggle, matching: find.text('Show less')), findsOneWidget);
    await tester.tap(toggle);
    await tester.pumpAndSettle();
    expect(heights(tester), shut, reason: 'closed again, as it was before it opened');
  });

  testWidgets('a phone on its side: the first message, "Turn your phone upright to see all 3 messages" (words, not a button); upright, the list', (tester) async {
    final semantics = tester.ensureSemantics();
    await phone(tester, const Size(800, 360));
    c.read(_messages.notifier).set([msg('m1'), msg('m2'), msg('m3')]);
    await tester.pumpAndSettle();
    final line = find.text('Reshma Mohammad · 10:05 · Turn your phone upright to see all 3 messages');
    expect(line, findsOneWidget);
    expect(toggle, findsNothing);
    expect(seeAll, findsNothing);
    final said = tester.getSemantics(line).getSemanticsData();
    expect(said.flagsCollection.isButton, isFalse, reason: 'a line to read, nothing to press');
    expect(said.hasAction(SemanticsAction.tap), isFalse);
    expect(heights(tester).banner, lessThanOrEqualTo(math.max((360 - 24 - 80) / 3, 64) + 0.5));

    // Turned upright: room for the list, and its button.
    tester.view.physicalSize = const Size(360, 800) * 3;
    await tester.pumpAndSettle();
    expect(line, findsNothing);
    expect(find.text('Show 2 more messages'), findsOneWidget);
    semantics.dispose();
  });

  for (final (size, kb) in const [(Size(360, 640), 300.0), (Size(360, 800), 300.0), (Size(411, 917), 330.0)]) {
    for (final scale in const [1.0, 2.0]) {
      testWidgets('Undo after Dismiss all, ${size.width.toInt()}×${size.height.toInt()} at ${(scale * 100).toInt()}%: within a third, then one row with the keyboard up; 48 dp Undo',
          (tester) async {
        await phone(tester, size, scale: scale);
        c.read(_messages.notifier).set([for (var i = 1; i <= 3; i++) msg('m$i')]);
        await tester.pumpAndSettle();
        await tester.tap(toggle);
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const Key('dismiss-all-supervisor-messages')));
        await tester.pump();
        final undo = find.byKey(const Key('undo-dismiss-all-supervisor-messages'));
        for (final k in [0.0, kb]) {
          keyboard(tester, k);
          await tester.pump();
          await tester.pump();
          expect(tester.takeException(), isNull, reason: 'no overflow');
          final h = heights(tester);
          final room = h.banner + h.body;
          expect(h.banner, lessThanOrEqualTo((k > 0 ? 64 : math.max(room / 3, 64)) + 0.5),
              reason: k > 0 ? 'one row while the keyboard is up' : 'a third of $room, or one row');
          expect(undo.hitTestable(), findsOneWidget);
          expect(tester.getSize(undo).height, greaterThanOrEqualTo(48));
        }
      });
    }
  }

  testWidgets('a short window standing up (split screen): how many more wait, not "turn your phone"', (tester) async {
    await phone(tester, const Size(400, 420));
    c.read(_messages.notifier).set([msg('m1'), msg('m2'), msg('m3')]);
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(find.text('Reshma Mohammad · 10:05 · 2 more messages'), findsOneWidget);
    expect(find.textContaining('upright'), findsNothing);
    expect(toggle, findsNothing);
  });

  testWidgets('one message on a phone with the keyboard up: its row and its 48 dp Dismiss, nothing more', (tester) async {
    await phone(tester, const Size(800, 360), scale: 2, keyboard: 180);
    c.read(_messages.notifier).set([msg('m1')]);
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(heights(tester).banner, 64);
    expect(tester.getSize(find.byKey(const Key('dismiss-supervisor-message'))).height, greaterThanOrEqualTo(48));
    expect(seeAll, findsNothing, reason: 'one message: nothing more to see');
  });
}

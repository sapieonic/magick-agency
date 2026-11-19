import 'package:flutter/material.dart';
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
/// each is announced to a screen reader once.

class _Messages extends Notifier<List<SupervisorMessageView>> {
  @override
  List<SupervisorMessageView> build() => const [];
  void set(List<SupervisorMessageView> m) => state = m;
}

final _messages = NotifierProvider<_Messages, List<SupervisorMessageView>>(_Messages.new);

SupervisorMessageView msg(String id, {String text = 'Offer the 3-month plan, the waiver is approved.', String from = 'Anitha N'}) =>
    SupervisorMessageView(id: id, text: text, from: from, sentAt: DateTime(2026, 11, 19, 10, 5));

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
      expect(find.text('2 more messages'), findsOneWidget);
      // Above the tab's content, not over it.
      final banner = tester.getRect(find.byKey(const Key('supervisor-message')));
      final page = tester.getRect(find.textContaining('at /home'));
      expect(banner.bottom, lessThanOrEqualTo(page.top));
      await tester.tap(find.byKey(const Key('dismiss-supervisor-message')));
      expect(dismissed, ['m1']);
      c.read(_messages.notifier).set([msg('m2', text: 'Wrap up this call', from: 'Your supervisor'), msg('m3')]);
      await tester.pumpAndSettle();
      expect(find.text('Your supervisor · 10:05'), findsOneWidget);
      expect(find.text('1 more message'), findsOneWidget);
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

    String said(Object? m) => ((m! as Map)['data'] as Map)['message'] as String;

    testWidgets('each message is announced once as it arrives, politely; a dismissal says nothing again', (tester) async {
      final announcements = await pumpBanner(tester);
      c.read(_messages.notifier).set([msg('m1')]);
      await tester.pump();
      await tester.pump();
      expect(announcements.map(said), ['Message from Anitha N: Offer the 3-month plan, the waiver is approved.']);
      expect(((announcements.single! as Map)['data'] as Map)['assertiveness'], isNot(1));
      c.read(_messages.notifier).set([msg('m1'), msg('m2', text: 'Wrap up this call', from: 'Ravi')]);
      await tester.pump();
      await tester.pump();
      expect(announcements.map(said).last, 'Message from Ravi: Wrap up this call');
      c.read(_messages.notifier).set([msg('m2', text: 'Wrap up this call', from: 'Ravi')]);
      await tester.pump();
      await tester.pump();
      expect(announcements, hasLength(2));
    });

    testWidgets('a message already queued when it mounts is announced too', (tester) async {
      c.read(_messages.notifier).set([msg('m1')]);
      final announcements = await pumpBanner(tester);
      await tester.pump();
      expect(announcements.map(said), ['Message from Anitha N: Offer the 3-month plan, the waiver is approved.']);
    });

    testWidgets('a live region, plain text, a labelled dismiss of 48 dp', (tester) async {
      final semantics = tester.ensureSemantics();
      c.read(_messages.notifier).set([msg('m1', text: '<b>Not bold</b> https://example.test')]);
      await pumpBanner(tester);
      expect(find.text('<b>Not bold</b> https://example.test'), findsOneWidget);
      expect(tester.getSemantics(find.byKey(const Key('supervisor-message-from'))).flagsCollection.isLiveRegion, isTrue);
      expect(find.byTooltip('Dismiss this message'), findsOneWidget);
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
}

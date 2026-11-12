import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/app/theme/app_theme.dart';
import 'package:magick_agency_agent/app/theme/tokens.dart';
import 'package:magick_agency_agent/core/ring/ring_copy.dart';
import 'package:magick_agency_agent/core/ring/station_ring.dart';
import 'package:magick_agency_agent/features/ring/ring_notice_banner.dart';

/// Mode B's notice: said until the agent dismisses it.
void main() {
  testWidgets('the notice is shown, announced politely, and goes on Dismiss', (tester) async {
    final container = ProviderContainer.test();
    container.read(ringNoticeProvider.notifier).show(RingCopy.acceptFailed);
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          theme: buildTheme(AppTokens.light, Brightness.light),
          home: Scaffold(
            body: Consumer(
              builder: (context, ref, _) {
                final notice = ref.watch(ringNoticeProvider);
                return notice == null ? const SizedBox.shrink() : RingNoticeBanner(text: notice);
              },
            ),
          ),
        ),
      ),
    );
    expect(find.text('This call stopped ringing or someone else took it.'), findsOneWidget);
    await tester.tap(find.text('Dismiss'));
    await tester.pump();
    expect(container.read(ringNoticeProvider), isNull);
    expect(find.byKey(const Key('ring-notice')), findsNothing);
  });
}

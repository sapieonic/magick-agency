import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme/tokens.dart';
import '../../core/ring/ring_copy.dart';
import '../../core/ring/station_ring.dart';

/// Mode B's notice ([ringNoticeProvider]): why this phone stopped ringing for inbound calls, or
/// that a call answered from a ring is gone. Shown by the shell above its tab bar on every tab,
/// announced politely, until the agent dismisses it or another replaces it.
class RingNoticeBanner extends ConsumerWidget {
  const RingNoticeBanner({super.key, required this.text});

  final String text;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.tokens;
    final style = Theme.of(context).textTheme.bodyMedium!.copyWith(color: t.textPrimary);
    return Material(
      key: const Key('ring-notice'),
      color: t.warningSubtle,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(Space.lg, Space.sm, Space.sm, Space.sm),
        child: Row(
          children: [
            Icon(Icons.phone_disabled_outlined, color: t.warning, size: 20),
            const SizedBox(width: Space.md),
            Expanded(
              child: Semantics(liveRegion: true, child: Text(text, style: style)),
            ),
            TextButton(
              onPressed: () => ref.read(ringNoticeProvider.notifier).dismiss(),
              child: const Text(RingCopy.dismiss),
            ),
          ],
        ),
      ),
    );
  }
}

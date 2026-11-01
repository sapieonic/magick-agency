import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/app_theme.dart';
import '../../../app/theme/tokens.dart';
import '../../../core/softphone/softphone_view.dart';
import '../../../ui/primitives.dart';
import '../softphone_copy.dart';

/// The agent's last few soft-phone calls, under the pad while idle.
///
/// Redial fills the pad (number, its tag while still taggable, its caller ID)
/// and moves focus to Call; it never dials, so a mis-tap never rings a
/// customer. Each row says its day ("Today", "Yesterday", a date): a time
/// alone reads as today for a call from last week.
class RecentCalls extends ConsumerWidget {
  const RecentCalls({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(softphoneViewProvider.select((v) => (recent: v.recent, loading: v.recentLoading, error: v.recentError)));
    final text = Theme.of(context).textTheme;
    final actions = ref.read(softphoneActionsProvider);

    Widget body;
    if (s.recent.isEmpty && s.loading) {
      body = Text(SoftphoneCopy.recentLoading, style: text.bodySmall);
    } else if (s.recent.isEmpty && s.error != null) {
      body = Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(SoftphoneCopy.recentError, key: const Key('recent-error'), style: text.bodySmall),
          TextButton(onPressed: actions.reloadRecent, child: const Text(SoftphoneCopy.tryAgain)),
        ],
      );
    } else if (s.recent.isEmpty) {
      body = Text(SoftphoneCopy.recentEmpty, key: const Key('recent-empty'), style: text.bodySmall);
    } else {
      body = Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [for (final c in s.recent) _RecentRow(call: c, onRedial: () => actions.redial(c.id))],
      );
    }

    return Column(
      key: const Key('recent-calls'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SectionLabel(SoftphoneCopy.recentCalls),
        Text(SoftphoneCopy.recentHint, style: text.labelSmall),
        const SizedBox(height: Space.sm),
        body,
      ],
    );
  }
}

class _RecentRow extends StatelessWidget {
  const _RecentRow({required this.call, required this.onRedial});

  final SoftphoneRecentCall call;
  final VoidCallback onRedial;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final outcomeColor = switch (call.outcomeKind) {
      SoftphoneOutcomeKind.awaiting => t.warning,
      SoftphoneOutcomeKind.live => t.ember,
      _ => t.textSecondary,
    };
    return Padding(
      key: Key('recent-${call.id}'),
      padding: const EdgeInsets.only(bottom: Space.sm),
      child: AppCard(
        padding: const EdgeInsetsDirectional.fromSTEB(Space.md, Space.sm, Space.xs, Space.sm),
        child: Row(
          children: [
            Expanded(
              child: MergeSemantics(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(call.numberDisplay, style: monoStyle(context, size: 16, color: t.textPrimary)),
                    const SizedBox(height: 2),
                    Text(call.outcomeLabel, style: text.labelMedium!.copyWith(color: outcomeColor)),
                    Text('${call.loggedTo} · ${call.whenLabel}', style: text.bodySmall),
                  ],
                ),
              ),
            ),
            // Merged, so the hint is read with the button: redial fills, it does not dial.
            MergeSemantics(
              child: Semantics(
                hint: SoftphoneCopy.redialHint,
                child: IconButton(
                  key: Key('redial-${call.id}'),
                  tooltip: SoftphoneCopy.redial(call.numberDisplay),
                  onPressed: call.canRedial ? onRedial : null,
                  icon: const Icon(Icons.replay),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

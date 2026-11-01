import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/tokens.dart';
import '../../../core/softphone/softphone_view.dart';
import '../../../ui/primitives.dart';

/// Finish mode: the soft phone was turned off for the account while the agent
/// had it. What still works (the call on screen, hang-up, its outcome) and
/// what does not (new calls), in the surface's words: the way out is Close on
/// the Phone tab, Return to campaign on the station.
///
/// A status, not an alert: it appears when the server says so, possibly
/// mid-call, and should be heard once without interrupting the agent.
class FinishNotice extends ConsumerWidget {
  const FinishNotice({super.key, required this.surface});

  final SoftphoneSurface surface;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final notice = ref.watch(softphoneViewProvider.select((v) => v.finishNotice(surface)));
    if (notice == null) return const SizedBox.shrink();
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    return Semantics(
      liveRegion: true,
      container: true,
      child: AppCard(
        key: const Key('softphone-finish-notice'),
        color: t.warningSubtle,
        borderColor: t.warning.withValues(alpha: 0.4),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(Icons.phone_disabled_outlined, color: t.warning, size: 20),
            const SizedBox(width: Space.sm),
            Expanded(child: Text(notice, style: text.bodyMedium)),
          ],
        ),
      ),
    );
  }
}

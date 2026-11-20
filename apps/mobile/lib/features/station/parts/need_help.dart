import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/tokens.dart';
import '../../../core/station/station_view.dart';
import '../../../ui/primitives.dart';
import '../station_copy.dart';
import '../station_providers.dart';

/// How the agent's last Need help ended, or why a raise or a cancel did not go through (floor
/// assist, LF4; the app's LF35): one line under the band, on any station screen, until the agent
/// puts it away or asks again ("Anitha N is listening to your call."). The raise, the open request
/// and its cancel are the top bar's `NeedHelpButton`.
///
/// Behind the account's `agency_floor_assist_enabled` ([stationNeedHelpProvider]): off, nothing
/// shows.
class NeedHelpCard extends ConsumerWidget {
  const NeedHelpCard({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (!ref.watch(stationNeedHelpProvider)) return const SizedBox.shrink();
    final help = ref.watch(stationViewProvider.select((v) => v?.help ?? const HelpView()));
    if (help.notice == null && help.error == null) return const SizedBox.shrink();
    final actions = ref.read(stationActionsProvider);
    final children = <Widget>[
      if (help.notice != null)
        _Line(
          key: const Key('help-notice'),
          text: help.notice!,
          tone: help.noticeTone == HelpNoticeTone.warning ? Tone.warn : Tone.ok,
          icon: help.noticeTone == HelpNoticeTone.warning ? Icons.schedule : Icons.headset_mic_outlined,
          onDismiss: actions.dismissHelpNotice,
        ),
      if (help.error != null)
        _Line(
          key: const Key('help-error'),
          text: help.error!,
          tone: Tone.danger,
          icon: Icons.error_outline,
          onDismiss: actions.dismissHelpNotice,
        ),
    ];
    return Padding(
      key: const Key('need-help-card'),
      padding: const EdgeInsets.only(bottom: Space.md),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final (i, c) in children.indexed) ...[if (i > 0) const SizedBox(height: Space.sm), c],
        ],
      ),
    );
  }
}

/// A notice or a refusal under the control, in its tone, with Dismiss. A polite live region.
class _Line extends StatelessWidget {
  const _Line({super.key, required this.text, required this.tone, required this.icon, required this.onDismiss});

  final String text;
  final Tone tone;
  final IconData icon;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final fg = tone.fg(t);
    final bg = tone.bg(t);
    return AppCard(
      color: bg,
      borderColor: fg.withValues(alpha: 0.4),
      padding: const EdgeInsets.fromLTRB(Space.md, Space.xs, Space.xs, Space.xs),
      child: Row(
        children: [
          Icon(icon, color: fg, size: 20),
          const SizedBox(width: Space.sm),
          Expanded(
            child: Semantics(
              container: true,
              liveRegion: true,
              child: Text(text, style: Theme.of(context).textTheme.bodyMedium!.copyWith(color: fg)),
            ),
          ),
          IconButton(
            tooltip: StationCopy.dismissHelp,
            icon: Icon(Icons.close, color: fg),
            onPressed: onDismiss,
          ),
        ],
      ),
    );
  }
}

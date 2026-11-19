import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/tokens.dart';
import '../../../core/station/station_view.dart';
import '../../../ui/primitives.dart';
import '../logic/format.dart';
import '../station_copy.dart';
import '../station_providers.dart';
import '../widgets/ticking.dart';

/// Need help (floor assist, LF4; the app's LF35): on a call or in wrap-up the agent asks every
/// supervisor of the account for help, and can cancel it; how it ended ("Anitha N is listening to
/// your call.") stays until they put it away.
///
/// Behind the account's `agency_floor_assist_enabled` ([stationNeedHelpProvider]): off, nothing
/// shows. The button is offered only on a call or in wrap-up (the server's own rule, LF13); an
/// open request, a notice or a refusal shows on any station screen ([idle]: between calls), so a
/// request raised in wrap-up can still be seen and cancelled after the outcome is saved.
///
/// Its own stage ([HelpView.stage]), never the station's busy state: asking for help never holds
/// up hanging up or saving the outcome.
class NeedHelpCard extends ConsumerWidget {
  const NeedHelpCard({super.key, this.idle = false});

  /// On a screen between calls: the button is not offered, only what is already open or to say.
  final bool idle;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (!ref.watch(stationNeedHelpProvider)) return const SizedBox.shrink();
    final help = ref.watch(stationViewProvider.select((v) => v?.help ?? const HelpView()));
    final phase = ref.watch(stationViewProvider.select((v) => v?.phase));
    final offered = !idle && (phase == AgentPhase.onCall || phase == AgentPhase.wrapup);
    if (!offered && !help.hasNews) return const SizedBox.shrink();

    final actions = ref.read(stationActionsProvider);
    final children = <Widget>[
      if (help.isOpen)
        _OpenRequest(help: help, onCancel: help.stage == HelpStage.open ? actions.cancelHelp : null)
      else if (offered)
        _AskButton(
          raising: help.stage == HelpStage.raising,
          onPressed: help.stage == HelpStage.none ? actions.raiseHelp : null,
        ),
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

class _AskButton extends StatelessWidget {
  const _AskButton({required this.raising, required this.onPressed});

  final bool raising;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    return MergeSemantics(
      child: Semantics(
        hint: StationCopy.needHelpHint,
        child: OutlinedButton.icon(
          key: const Key('need-help'),
          onPressed: onPressed,
          style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(48)),
          icon: raising
              ? const SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2))
              : const Icon(Icons.support_agent),
          label: Text(raising ? StationCopy.askingForHelp : StationCopy.needHelp),
        ),
      ),
    );
  }
}

/// "Help requested · your supervisors can see it", with Cancel.
class _OpenRequest extends ConsumerWidget {
  const _OpenRequest({required this.help, required this.onCancel});

  final HelpView help;
  final VoidCallback? onCancel;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final now = ref.watch(stationClockProvider);
    final raisedAt = help.raisedAt;
    final cancelling = help.stage == HelpStage.cancelling;
    return AppCard(
      key: const Key('help-requested'),
      color: t.warningSubtle,
      borderColor: t.warning.withValues(alpha: 0.4),
      padding: const EdgeInsets.fromLTRB(Space.md, Space.sm, Space.xs, Space.sm),
      child: Row(
        children: [
          Icon(Icons.support_agent, color: t.warning, size: 22),
          const SizedBox(width: Space.sm),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // Only the status is a live region, said once as the request opens. The ticking
                // "asked 0:42 ago" stays out of it: in one, a screen reader would repeat it every
                // second over the customer for as long as the request is open.
                Semantics(
                  key: const Key('help-requested-status'),
                  container: true,
                  liveRegion: true,
                  child: Text(StationCopy.helpRequested, style: text.titleSmall!.copyWith(color: t.warning)),
                ),
                if (raisedAt != null)
                  TickingBuilder(
                    now: now,
                    anchor: raisedAt,
                    builder: (context, at) => Text(
                      StationCopy.helpRequestedFor(formatClock(at.difference(raisedAt), padMinutes: false)),
                      key: const Key('help-requested-for'),
                      style: text.bodySmall!.copyWith(color: t.textPrimary),
                    ),
                  ),
              ],
            ),
          ),
          Semantics(
            button: true,
            enabled: onCancel != null,
            label: cancelling ? StationCopy.cancellingHelpLabel : StationCopy.cancelHelpLabel,
            excludeSemantics: true,
            onTap: onCancel,
            child: TextButton(
              key: const Key('cancel-help'),
              onPressed: onCancel,
              style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
              child: Text(cancelling ? StationCopy.cancellingHelp : StationCopy.cancelHelp),
            ),
          ),
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

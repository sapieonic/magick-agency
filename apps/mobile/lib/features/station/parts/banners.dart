import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/tokens.dart';
import '../../../core/station/station_view.dart';
import '../../../ui/primitives.dart';
import '../station_copy.dart';
import '../station_providers.dart';

/// The small, self-selecting pieces every station phase shares. Each watches
/// only its own slice of the station, so a notes keystroke or a timer never
/// rebuilds them.

/// Campaign name, Running/Paused and the weak-connection pill.
class StationHeader extends ConsumerWidget {
  const StationHeader({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final name = ref.watch(stationViewProvider.select((v) => v?.campaignName ?? ''));
    final dialing = ref.watch(stationViewProvider.select((v) => v?.campaignDialing ?? true));
    final weak = ref.watch(stationViewProvider.select((v) => v != null && v.weakConnection && v.link == StationLink.open));
    final text = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(Space.lg, Space.md, Space.lg, Space.sm),
      child: Row(
        children: [
          Expanded(
            child: Semantics(
              header: true,
              child: Text(name, style: text.titleLarge, maxLines: 2, overflow: TextOverflow.ellipsis),
            ),
          ),
          const SizedBox(width: Space.sm),
          Flexible(
            child: Wrap(
              alignment: WrapAlignment.end,
              spacing: Space.xs,
              runSpacing: Space.xs,
              children: [
                if (weak)
                  StatusPill(
                    StationCopy.weakConnection,
                    key: const Key('weak-connection'),
                    tone: Tone.warn,
                    leading: Icon(Icons.network_check, size: 14, color: context.tokens.warning),
                  ),
                StatusPill(dialing ? StationCopy.running : StationCopy.paused, tone: dialing ? Tone.ok : Tone.warn),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// Reconnecting / disconnected while no call is on screen: a slim banner
/// above the idle content (the call screens put this in their band instead).
class IdleLinkBanner extends ConsumerWidget {
  const IdleLinkBanner({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final link = ref.watch(stationViewProvider.select((v) => v?.link));
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    switch (link) {
      case StationLink.reconnecting:
        return _Banner(
          key: const Key('idle-reconnecting'),
          color: t.ember,
          background: t.emberSubtle,
          leading: const LiveDot(),
          title: StationCopy.reconnecting,
          body: StationCopy.reconnectingIdle,
        );
      case StationLink.disconnected:
        final busy = ref.watch(stationViewProvider.select((v) => v?.busy != StationBusy.none));
        return _Banner(
          key: const Key('idle-disconnected'),
          color: t.danger,
          background: t.dangerSubtle,
          leading: Icon(Icons.wifi_off, color: t.danger),
          title: StationCopy.disconnected,
          body: StationCopy.disconnectedDetail,
          action: FilledButton(
            onPressed: busy ? null : () => ref.read(stationActionsProvider).reconnect(),
            style: FilledButton.styleFrom(backgroundColor: t.dangerDeep, foregroundColor: t.onAccent),
            child: Text(StationCopy.reconnect, style: text.labelLarge!.copyWith(color: t.onAccent)),
          ),
        );
      default:
        return const SizedBox.shrink();
    }
  }
}

class _Banner extends StatelessWidget {
  const _Banner({super.key, required this.color, required this.background, required this.title, this.body, this.leading, this.action});

  final Color color;
  final Color background;
  final String title;
  final String? body;
  final Widget? leading;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: Space.md),
      child: AppCard(
        color: background,
        borderColor: color.withValues(alpha: 0.4),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (leading != null) ...[Padding(padding: const EdgeInsets.only(top: 2), child: leading), const SizedBox(width: Space.sm)],
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(title, style: text.titleSmall!.copyWith(color: color)),
                      if (body != null) ...[const SizedBox(height: 2), Text(body!, style: text.bodySmall)],
                    ],
                  ),
                ),
              ],
            ),
            if (action != null) ...[const SizedBox(height: Space.sm), Align(alignment: AlignmentDirectional.centerStart, child: action)],
          ],
        ),
      ),
    );
  }
}

/// "Your microphone is blocked — the customer cannot hear you." Silence is
/// the one failure that does not announce itself, so it says what is broken
/// and what to do, and offers Settings when that is the fix.
class MicProblemBanner extends ConsumerWidget {
  const MicProblemBanner({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final problem = ref.watch(stationViewProvider.select((v) => v?.audio.micProblem ?? MicProblem.none));
    if (problem == MicProblem.none) return const SizedBox.shrink();
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    return Semantics(
      liveRegion: true,
      child: _Banner(
        key: const Key('mic-problem'),
        color: t.danger,
        background: t.dangerSubtle,
        leading: Icon(Icons.mic_off, color: t.danger),
        title: StationCopy.micHeadline(problem),
        body: StationCopy.micRemedy(problem),
        action: problem == MicProblem.permissionDenied
            ? OutlinedButton(
                onPressed: () => ref.read(stationOpenSettingsProvider)(),
                child: Text(StationCopy.openSettings, style: text.labelLarge),
              )
            : null,
      ),
    );
  }
}

/// What ended while the agent's socket was away. The server hands it over
/// once, so it stays until the agent dismisses it.
class MissedReleaseCard extends ConsumerWidget {
  const MissedReleaseCard({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final missed = ref.watch(stationViewProvider.select((v) => v?.missedRelease));
    if (missed == null) return const SizedBox.shrink();
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: Space.md),
      child: AppCard(
        key: const Key('missed-release'),
        borderColor: t.warning.withValues(alpha: 0.4),
        padding: const EdgeInsets.fromLTRB(Space.md, Space.sm, Space.xs, Space.sm),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: Padding(
                padding: const EdgeInsets.only(top: Space.xs),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(StationCopy.whileAway(missed.headline), style: text.titleSmall),
                    const SizedBox(height: 2),
                    Text(missed.detail, style: text.bodySmall),
                  ],
                ),
              ),
            ),
            IconButton(
              tooltip: StationCopy.dismiss,
              icon: const Icon(Icons.close),
              onPressed: () => ref.read(stationActionsProvider).dismissMissedRelease(),
            ),
          ],
        ),
      ),
    );
  }
}

/// The last refused action, beside the buttons the agent just pressed. Never
/// a toast: an agent must not walk away believing something worked.
class ActionErrorLine extends ConsumerWidget {
  const ActionErrorLine({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final error = ref.watch(stationViewProvider.select((v) => v?.actionError));
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    return AnimatedSize(
      duration: MediaQuery.disableAnimationsOf(context) ? Duration.zero : const Duration(milliseconds: 180),
      alignment: Alignment.topCenter,
      child: error == null
          ? const SizedBox(width: double.infinity)
          : Padding(
              padding: const EdgeInsets.only(bottom: Space.sm),
              child: Semantics(
                liveRegion: true,
                container: true,
                child: AppCard(
                  key: const Key('action-error'),
                  color: t.dangerSubtle,
                  borderColor: t.danger.withValues(alpha: 0.4),
                  padding: const EdgeInsets.fromLTRB(Space.md, Space.xs, Space.xs, Space.xs),
                  child: Row(
                    children: [
                      Icon(Icons.error_outline, color: t.danger, size: 20),
                      const SizedBox(width: Space.sm),
                      Expanded(
                        child: Text(error, style: text.bodyMedium!.copyWith(color: t.danger)),
                      ),
                      IconButton(
                        tooltip: StationCopy.dismiss,
                        icon: Icon(Icons.close, color: t.danger),
                        onPressed: () => ref.read(stationActionsProvider).dismissActionError(),
                      ),
                    ],
                  ),
                ),
              ),
            ),
    );
  }
}

/// Dims and disables what cannot work while the socket is not open (the
/// mock's 45% control row). Content stays readable; only actions are gated.
class LinkGate extends ConsumerWidget {
  const LinkGate({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final open = ref.watch(stationViewProvider.select((v) => v?.link == StationLink.open));
    return IgnorePointer(
      ignoring: !open,
      child: AnimatedOpacity(
        opacity: open ? 1 : 0.45,
        duration: MediaQuery.disableAnimationsOf(context) ? Duration.zero : const Duration(milliseconds: 160),
        child: child,
      ),
    );
  }
}

/// A button label with a spinner while its action is in flight.
class BusyLabel extends StatelessWidget {
  const BusyLabel({super.key, required this.label, required this.busy, this.color});

  final String label;
  final bool busy;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    if (!busy) return Text(label);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        SizedBox.square(dimension: 16, child: CircularProgressIndicator(strokeWidth: 2, color: color)),
        const SizedBox(width: Space.sm),
        Flexible(child: Text(label)),
      ],
    );
  }
}

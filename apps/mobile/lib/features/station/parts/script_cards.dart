import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/tokens.dart';
import '../../../core/station/script_fill.dart';
import '../../../core/station/station_view.dart';
import '../station_copy.dart';
import '../station_providers.dart';
import 'ringing_view.dart' show factText, factTilesInOrder;

/// The campaign's script on the call screens (BE-8; AS2: no AI): "First, say this" on Call coming,
/// "What to say" on On call. Shown only when the campaign has one; without it On call shows the last
/// calls and the note (04c). Each line is filled for the customer on screen (`fillScript`, the
/// contract's rule): their name and place, the amount due and due date as the card shows them, the
/// agent's first name and the work's name; a placeholder with nothing to fill it is left out.

/// What the placeholders say for [call].
ScriptValues scriptValuesFor(CallView call, {required String? agentName, required String campaignName}) {
  final facts = call.facts;
  final tiles = facts == null ? const <FactTileView>[] : factTilesInOrder(facts);
  String? role(bool Function(FactTileView) f) {
    for (final t in tiles) {
      if (f(t)) return factText(t);
    }
    return null;
  }

  final name = (facts?.name ?? call.displayName)?.trim();
  return (
    name: name == null || name.isEmpty ? null : name,
    place: facts?.place,
    amountDue: role((t) => t.amountDue),
    dueDate: role((t) => t.dueDate),
    agentName: agentName == null ? null : StationCopy.firstName(agentName),
    campaignName: campaignName.trim().isEmpty ? null : campaignName,
  );
}

/// The placeholders' values for the call on screen, or null without one.
ScriptValues? _values(WidgetRef ref) {
  final call = ref.watch(stationViewProvider.select((v) => v?.call));
  if (call == null) return null;
  final agent = ref.watch(stationAgentNameProvider);
  final work = ref.watch(stationViewProvider.select((v) => v?.campaignName ?? ''));
  return scriptValuesFor(call, agentName: agent, campaignName: work);
}

/// "First, say this" (03): the script's opening line, big, for the call coming through.
class OpeningLineCard extends ConsumerWidget {
  const OpeningLineCard({super.key, this.trailing});

  /// Beside the heading (Read aloud).
  final Widget Function(String line)? trailing;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final opening = ref.watch(stationViewProvider.select((v) => v?.script?.opening));
    final values = _values(ref);
    if (opening == null || opening.isEmpty || values == null) return const SizedBox.shrink();
    final line = fillScript(opening, values);
    final c = context.stateTokens.coming;
    final text = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.only(top: Space.md),
      child: DecoratedBox(
        key: const Key('script-opening'),
        decoration: BoxDecoration(
          color: c.soft,
          borderRadius: BorderRadius.circular(Radii.lg),
          border: Border.all(color: c.deep, width: 1.5),
        ),
        child: Padding(
          padding: const EdgeInsets.all(Space.md),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Icon(Icons.chat_bubble_outline, size: 20, color: c.deep),
                  const SizedBox(width: Space.sm),
                  Expanded(
                    child: Semantics(header: true, child: Text(StationCopy.firstSayThis, style: text.titleSmall!.copyWith(color: c.deep))),
                  ),
                  if (trailing != null) trailing!(line),
                ],
              ),
              const SizedBox(height: Space.sm),
              Text('“$line”', key: const Key('script-opening-line'), style: text.headlineSmall),
            ],
          ),
        ),
      ),
    );
  }
}

/// "What to say" (04, the phone's form): the current step and the next two, with "1 of 4 done".
/// A tap on a step marks it, and every step before it, done; the current step is the first not
/// done. Where the agent is lives on this screen only (the server keeps none), and starts afresh
/// with each call ([callId]).
class ScriptStepsCard extends ConsumerStatefulWidget {
  const ScriptStepsCard({super.key, required this.callId, this.trailing});

  final String callId;

  /// Beside the current step (Read aloud).
  final Widget Function(String line)? trailing;

  @override
  ConsumerState<ScriptStepsCard> createState() => _ScriptStepsCardState();
}

class _ScriptStepsCardState extends ConsumerState<ScriptStepsCard> {
  int _done = 0;

  @override
  void didUpdateWidget(ScriptStepsCard old) {
    super.didUpdateWidget(old);
    if (old.callId != widget.callId) _done = 0;
  }

  @override
  Widget build(BuildContext context) {
    final steps = ref.watch(stationViewProvider.select((v) => v?.script?.steps ?? const <String>[]));
    final values = _values(ref);
    if (steps.isEmpty || values == null) return const SizedBox.shrink();
    final done = _done.clamp(0, steps.length);
    final s = context.stateTokens;
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final shown = [for (var i = done; i < steps.length && i < done + 3; i++) i];
    return Padding(
      padding: const EdgeInsets.only(bottom: Space.md),
      child: DecoratedBox(
        key: const Key('script-steps'),
        decoration: BoxDecoration(
          color: t.bgSecondary,
          borderRadius: BorderRadius.circular(Radii.lg),
          border: Border.all(color: t.border),
        ),
        child: Padding(
          padding: const EdgeInsets.all(Space.md),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Icon(Icons.format_list_numbered, size: 20, color: t.textSecondary),
                  const SizedBox(width: Space.sm),
                  Expanded(
                    child: Semantics(header: true, child: Text(StationCopy.whatToSay, style: text.titleSmall!.copyWith(color: t.textSecondary))),
                  ),
                  DecoratedBox(
                    decoration: BoxDecoration(color: s.ready.soft, borderRadius: BorderRadius.circular(Radii.pill)),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: Space.sm, vertical: 2),
                      child: Text(
                        StationCopy.stepsDone(done, steps.length),
                        key: const Key('script-progress'),
                        style: text.labelMedium!.copyWith(color: s.ready.deep, fontWeight: FontWeight.w700),
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: Space.sm),
              if (shown.isEmpty)
                Text(StationCopy.allStepsDone, key: const Key('script-all-done'), style: text.titleMedium!.copyWith(color: s.ready.deep))
              else
                for (final i in shown)
                  _Step(
                    key: Key('script-step-$i'),
                    number: i + 1,
                    line: fillScript(steps[i], values),
                    current: i == done,
                    onTap: () => setState(() => _done = i + 1),
                    trailing: i == done ? widget.trailing : null,
                  ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Step extends StatelessWidget {
  const _Step({super.key, required this.number, required this.line, required this.current, required this.onTap, this.trailing});

  final int number;
  final String line;
  final bool current;
  final VoidCallback onTap;
  final Widget Function(String line)? trailing;

  @override
  Widget build(BuildContext context) {
    final c = context.stateTokens.onCall;
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.only(top: Space.xs),
      child: Material(
        color: current ? c.soft : t.bgSecondary,
        borderRadius: BorderRadius.circular(Radii.md),
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(Radii.md),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: Space.sm, vertical: Space.sm),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                DecoratedBox(
                  decoration: BoxDecoration(color: current ? c.band : t.bgTertiary, shape: BoxShape.circle),
                  child: SizedBox.square(
                    dimension: 28,
                    child: Center(
                      child: Text('$number', style: text.titleSmall!.copyWith(color: current ? c.ink : t.textSecondary)),
                    ),
                  ),
                ),
                const SizedBox(width: Space.sm),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.only(top: 3),
                    child: Text(
                      line,
                      style: (current ? text.titleMedium : text.bodyLarge)!.copyWith(color: current ? t.textPrimary : t.textSecondary),
                    ),
                  ),
                ),
                if (trailing != null) trailing!(line),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

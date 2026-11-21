import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/tokens.dart';
import '../../../core/station/script_fill.dart';
import '../../../core/station/station_view.dart';
import '../logic/facts.dart';
import '../station_copy.dart';
import '../station_providers.dart';

/// The campaign's script on the call screens (BE-8; AS2: no AI): "First, say this" on Call coming,
/// "What to say" on On call. Shown only when the campaign has one; without it On call shows the last
/// calls and the note (04c). Each line is filled for the customer on screen ([fillScriptRuns], the
/// contract's reading of braces): their name and place, each fact by its key (AS19) as the card
/// shows it (a hidden number stays hidden), the agent's first name and the work's name. A key the
/// customer has no value for reads "`<name> not given`", muted, and is never read aloud.

/// What the keys say for [call]. [masked]: the campaign hides numbers (AS9). [now]: for a chosen
/// date fact's year (AS19).
ScriptValues scriptValuesFor(
  CallView call, {
  required String? agentName,
  required String campaignName,
  bool masked = false,
  DateTime? now,
  Map<String, String> factLabels = const {},
}) {
  final facts = call.facts;
  final byKey = <String, ScriptFact>{};
  if (facts != null && facts.chosen) {
    for (final t in facts.tiles) {
      final key = t.key;
      if (key == null || byKey.containsKey(key)) continue;
      byKey[key] = ScriptFact(label: t.label, value: factIsEmpty(t) ? null : factText(t, masked: masked, now: now));
    }
  } else if (facts != null) {
    // BE-6: the amount due and the due date come from the role tiles, as the card shows them.
    for (final t in factTilesInOrder(facts)) {
      final key = t.amountDue ? 'amount_due' : (t.dueDate ? 'due_date' : null);
      if (key == null || byKey.containsKey(key)) continue;
      byKey[key] = ScriptFact(label: t.label, value: factText(t, masked: masked));
    }
  }

  final name = (facts?.name ?? call.displayName)?.trim();
  return ScriptValues(
    name: name == null || name.isEmpty ? null : name,
    place: facts?.place,
    agentName: agentName == null ? null : StationCopy.firstName(agentName),
    campaignName: campaignName.trim().isEmpty ? null : campaignName,
    facts: byKey,
    factLabels: factLabels,
  );
}

/// A line filled for the call on screen.
typedef FilledLine = ({List<ScriptRun> runs, String spoken});

/// The line filler for the call on screen, or null without one.
FilledLine Function(String line)? _filler(WidgetRef ref) {
  final call = ref.watch(stationViewProvider.select((v) => v?.call));
  if (call == null) return null;
  final agent = ref.watch(stationAgentNameProvider);
  final work = ref.watch(stationViewProvider.select((v) => v?.campaignName ?? ''));
  final masked = ref.watch(stationViewProvider.select((v) => v?.maskPhone ?? false));
  final placeholders = ref.watch(stationViewProvider.select((v) => v?.script?.placeholders ?? legacyScriptPlaceholders));
  final labels = ref.watch(stationViewProvider.select((v) => v?.script?.factLabels ?? const <String, String>{}));
  final now = ref.watch(stationClockProvider)();
  final values = scriptValuesFor(call, agentName: agent, campaignName: work, masked: masked, now: now, factLabels: labels);
  return (line) {
    final runs = fillScriptRuns(line, placeholders, values);
    return (runs: runs, spoken: spokenScript(runs));
  };
}

/// [runs] as spans: "not given" in the muted style.
List<InlineSpan> scriptSpans(BuildContext context, List<ScriptRun> runs) {
  final muted = TextStyle(color: context.tokens.textMuted, fontStyle: FontStyle.italic);
  return [
    for (final r in runs)
      switch (r) {
        SaidRun() => TextSpan(text: r.text),
        NotGivenRun() => TextSpan(text: r.text, style: muted),
      },
  ];
}

/// "First, say this" (03): the script's opening line, big, for the call coming through.
class OpeningLineCard extends ConsumerWidget {
  const OpeningLineCard({super.key, this.trailing});

  /// Beside the heading (Read aloud), given the line as read aloud.
  final Widget Function(String spoken)? trailing;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final opening = ref.watch(stationViewProvider.select((v) => v?.script?.opening));
    final fill = _filler(ref);
    if (opening == null || opening.isEmpty || fill == null) return const SizedBox.shrink();
    final line = fill(opening);
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
                  if (trailing != null) trailing!(line.spoken),
                ],
              ),
              const SizedBox(height: Space.sm),
              Text.rich(
                TextSpan(children: [const TextSpan(text: '“'), ...scriptSpans(context, line.runs), const TextSpan(text: '”')]),
                key: const Key('script-opening-line'),
                style: text.headlineSmall,
              ),
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

  /// Beside the current step (Read aloud), given the step as read aloud.
  final Widget Function(String spoken)? trailing;

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
    final fill = _filler(ref);
    if (steps.isEmpty || fill == null) return const SizedBox.shrink();
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
                    line: fill(steps[i]),
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
  final FilledLine line;
  final bool current;
  final VoidCallback onTap;
  final Widget Function(String spoken)? trailing;

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
                    child: Text.rich(
                      TextSpan(children: scriptSpans(context, line.runs)),
                      style: (current ? text.titleMedium : text.bodyLarge)!.copyWith(color: current ? t.textPrimary : t.textSecondary),
                    ),
                  ),
                ),
                if (trailing != null) trailing!(line.spoken),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

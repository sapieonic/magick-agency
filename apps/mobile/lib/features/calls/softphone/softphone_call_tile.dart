import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/material.dart';

import '../../../app/theme/app_theme.dart';
import '../../../app/theme/tokens.dart';
import '../../../core/softphone/call_labels.dart';
import '../../../core/softphone/softphone_view.dart';
import '../../../ui/primitives.dart';
import '../../performance/logic/en_in_format.dart';
import '../logic/attempt_copy.dart' show outcomeTone;

/// One soft-phone call, in the words a row says (tested directly): the
/// number, the outcome, when and for how long, and where it was logged.
@immutable
class SoftphoneCallRowView {
  factory SoftphoneCallRowView(ManualCall call, {required List<Disposition>? catalog, required DateTime now}) {
    final outcome = manualCallOutcome(call, catalog);
    return SoftphoneCallRowView._(
      number: formatDialNumber(call.destinationE164),
      outcome: outcome.text,
      kind: outcome.kind,
      tone: _tone(call, outcome.kind),
      when: recentCallWhen(call.createdAt, now),
      talk: EnIn.talkTime(call.talkSeconds?.toDouble()),
      hasTalk: call.talkSeconds != null,
      tagged: call.tag != null,
      logged: call.tag == null ? loggedToLabel(call) : 'Logged to ${loggedToLabel(call)}',
      unsettled: call.isUnsettled,
      overrides: [if (call.dncOverridden) 'DNC override', if (call.hoursOverridden) 'Hours override'],
    );
  }

  const SoftphoneCallRowView._({
    required this.number,
    required this.outcome,
    required this.kind,
    required this.tone,
    required this.when,
    required this.talk,
    required this.hasTalk,
    required this.tagged,
    required this.logged,
    required this.unsettled,
    required this.overrides,
  });

  /// `+91 98204 61733`.
  final String number;

  /// The saved outcome's label, "No outcome yet", "On a call now", or what the line did.
  final String outcome;
  final SoftphoneOutcomeKind kind;
  final Tone tone;

  /// "Today, 09:05 am", "28 Oct, 11:12 am".
  final String when;

  /// `m:ss`, or an em dash when the call never bridged.
  final String talk;
  final bool hasTalk;

  final bool tagged;

  /// "Logged to Home Loan Renewals", or "Not logged to a campaign".
  final String logged;

  /// Live, or ended and owing its outcome: finished on the Phone screen, not here.
  final bool unsettled;

  /// The console's override badges, when the agent called through a refusal.
  final List<String> overrides;

  /// `Today, 09:05 am · 3:41` (talk only when it bridged).
  String get meta => [when, if (hasTalk) talk].join(' · ');

  /// The third line: where it was logged, then any override.
  String get detail => [logged, ...overrides].join(' · ');

  static Tone _tone(ManualCall call, SoftphoneOutcomeKind kind) => switch (kind) {
        SoftphoneOutcomeKind.saved => Tone.accent,
        SoftphoneOutcomeKind.awaiting => Tone.warn,
        SoftphoneOutcomeKind.live => Tone.live,
        SoftphoneOutcomeKind.line => outcomeTone(call.outcomeRaw == null ? null : call.outcome),
      };
}

/// What an unsettled row says instead of opening: the call is finished on the
/// Phone screen (live there, or its outcome owed there).
const softphoneFinishOnPhone = 'Finish it on the Phone screen';

/// One call in the soft-phone list. Always three lines, so every row has the
/// same height and the list lays out by a prototype (as `AttemptTile` does).
class SoftphoneCallTile extends StatelessWidget {
  const SoftphoneCallTile({super.key, required this.view, this.onTap});

  final SoftphoneCallRowView view;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final third = view.unsettled ? softphoneFinishOnPhone : view.detail;
    return Semantics(
      button: true,
      label: '${view.number}, ${view.outcome}, ${view.meta}, $third',
      excludeSemantics: true,
      child: InkWell(
        onTap: onTap,
        child: DecoratedBox(
          decoration: BoxDecoration(border: Border(bottom: BorderSide(color: t.border))),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: Space.lg, vertical: Space.md),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        view.number,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: monoStyle(context, size: 15, color: t.textPrimary),
                      ),
                    ),
                    const SizedBox(width: Space.sm),
                    ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 170),
                      child: StatusPill(view.outcome, tone: view.tone),
                    ),
                  ],
                ),
                const SizedBox(height: Space.xs),
                Text(view.meta, maxLines: 1, overflow: TextOverflow.ellipsis, style: text.bodySmall),
                const SizedBox(height: 2),
                Text(
                  third,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: text.bodySmall!.copyWith(
                    color: view.unsettled ? t.accentHover : (view.tagged ? t.textSecondary : t.textMuted),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

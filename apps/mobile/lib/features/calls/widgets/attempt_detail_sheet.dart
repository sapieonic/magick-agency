import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/material.dart';

import '../../../app/theme/app_theme.dart';
import '../../../app/theme/tokens.dart';
import '../../../ui/primitives.dart';
import '../../performance/logic/en_in_format.dart';
import '../logic/attempt_copy.dart';

/// Everything one row carries, in the console's column words. No recording
/// and no transcript: those are supervisor-only.
Future<void> showAttemptDetail(BuildContext context, {required AttemptRow row, required String campaign}) =>
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (context) => DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.7,
        minChildSize: 0.4,
        maxChildSize: 0.95,
        builder: (context, scroll) => AttemptDetail(row: row, campaign: campaign, controller: scroll),
      ),
    );

/// The rows of the detail sheet, as label/value pairs (tested directly).
List<(String, String)> attemptDetailFields(AttemptRow row, String campaign) {
  final v = AttemptRowView.of(row);
  String t(DateTime? d) => EnIn.timestamp(d);
  return [
    ('When', v.whenFull),
    ('Number', v.phone),
    ('Campaign', campaign),
    ('Try', '${row.attemptNumber}'),
    ('Where it got to', attemptStateLabel(row)),
    ('Outcome', v.outcome),
    ('Write-up', row.dispositionCode ?? 'Not written up'),
    if (row.dispositionedOnBehalf) ('Filed by', 'Someone other than the agent on the call'),
    ('Notes', (row.notes == null || row.notes!.trim().isEmpty) ? '—' : row.notes!),
    if (row.callbackAt != null) ('Callback', t(row.callbackAt)),
    ('Talk time', v.talk),
    ('Wrap-up', EnIn.talkTime(row.wrapupSeconds)),
    ('Dialled', t(row.dialedAt)),
    ('Answered', t(row.answeredAt)),
    ('Joined to you', t(row.bridgedAt)),
    ('Ended', t(row.endedAt)),
    ('Written up', t(row.dispositionedAt)),
    ('Called from', EnIn.phone(row.callerId)),
  ];
}

class AttemptDetail extends StatelessWidget {
  const AttemptDetail({super.key, required this.row, required this.campaign, this.controller});

  final AttemptRow row;
  final String campaign;
  final ScrollController? controller;

  @override
  Widget build(BuildContext context) {
    final tk = context.tokens;
    final text = Theme.of(context).textTheme;
    final v = AttemptRowView.of(row);
    final fields = attemptDetailFields(row, campaign);
    return ListView(
      key: const Key('attempt-detail'),
      controller: controller,
      padding: const EdgeInsets.fromLTRB(Space.lg, 0, Space.lg, Space.xxl),
      children: [
        Row(
          children: [
            Expanded(
              child: Semantics(
                header: true,
                child: Text(v.phone, style: monoStyle(context, size: 20, color: tk.textPrimary)),
              ),
            ),
            StatusPill(v.outcome, tone: v.tone),
          ],
        ),
        const SizedBox(height: Space.md),
        for (final (label, value) in fields)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: Space.xs + 2),
            child: MergeSemantics(
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(width: 120, child: Text(label, style: text.labelMedium)),
                  Expanded(
                    child: SelectableText(value, style: text.bodyMedium),
                  ),
                ],
              ),
            ),
          ),
      ],
    );
  }
}

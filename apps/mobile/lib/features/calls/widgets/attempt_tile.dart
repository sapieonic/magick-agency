import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/material.dart';

import '../../../app/theme/app_theme.dart';
import '../../../app/theme/tokens.dart';
import '../../../ui/primitives.dart';
import '../logic/attempt_copy.dart';

/// One call in the list: number and outcome, then when · campaign · try ·
/// talk time, then the write-up and notes preview.
///
/// Always three lines (the third reads "Not written up" when there is
/// nothing), so every row has the same height and the list can lay out by a
/// prototype instead of measuring each row: smooth at hundreds of rows and
/// still right at 200% text.
class AttemptTile extends StatelessWidget {
  const AttemptTile({super.key, required this.row, required this.campaign, required this.today, this.onTap});

  final AttemptRow row;
  final String campaign;

  /// Local "now", so calls from another day carry their date.
  final DateTime today;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final v = AttemptRowView.of(row);
    final meta = v.meta(campaign, row, today);
    return Semantics(
      button: true,
      label: '${v.phone}, ${v.outcome}, $meta, ${v.writeUp}',
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
                        v.phone,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: monoStyle(context, size: 15, color: t.textPrimary),
                      ),
                    ),
                    const SizedBox(width: Space.sm),
                    ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 170),
                      child: StatusPill(v.outcome, tone: v.tone),
                    ),
                  ],
                ),
                const SizedBox(height: Space.xs),
                Text(meta, maxLines: 1, overflow: TextOverflow.ellipsis, style: text.bodySmall),
                const SizedBox(height: 2),
                Text(
                  v.writeUp,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: text.bodySmall!.copyWith(color: row.dispositionCode == null ? t.textMuted : t.textSecondary),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

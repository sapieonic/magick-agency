import 'package:flutter/material.dart';

import '../../../app/theme/tokens.dart';

/// The full-width band at the top of a call screen: what is happening, in one
/// tinted strip ("Ringing — get ready", "On call 02:14", "Reconnecting…").
///
/// The tint, the title colour and the words together are the state, so
/// colour is never the only channel. Text wraps rather than truncates.
///
/// Its text scales up to 150%, not 200%: the band is pinned above the
/// scrolling content, and at 200% on a small phone it alone would fill the
/// screen and push the call's controls off it. Past 130% the trailing timer
/// moves under the title so the words keep the full width.
class StatusBand extends StatelessWidget {
  const StatusBand({
    super.key,
    required this.title,
    required this.color,
    required this.background,
    this.subtitle,
    this.leading,
    this.trailing,
    this.bottom,
  });

  final String title;
  final String? subtitle;

  /// The title's colour (the state's hue).
  final Color color;
  final Color background;
  final Widget? leading;
  final Widget? trailing;

  /// Under the text, full width (the wrap-up drain bar).
  final Widget? bottom;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final stacked = MediaQuery.textScalerOf(context).scale(10) > 13;
    final words = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Semantics(
          header: true,
          child: Text(title, style: text.titleMedium!.copyWith(color: color)),
        ),
        if (subtitle != null && subtitle!.isNotEmpty) ...[const SizedBox(height: 2), Text(subtitle!, style: text.bodySmall)],
      ],
    );
    final band = DecoratedBox(
      decoration: BoxDecoration(
        color: background,
        border: Border(bottom: BorderSide(color: color.withValues(alpha: 0.35))),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(Space.lg, Space.md, Space.lg, Space.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              children: [
                if (leading != null) ...[leading!, const SizedBox(width: Space.md)],
                Expanded(child: words),
                if (trailing != null && !stacked) ...[const SizedBox(width: Space.md), trailing!],
              ],
            ),
            if (trailing != null && stacked) ...[
              const SizedBox(height: Space.sm),
              Align(alignment: AlignmentDirectional.centerStart, child: trailing),
            ],
            if (bottom != null) ...[const SizedBox(height: Space.sm), bottom!],
          ],
        ),
      ),
    );
    return MediaQuery.withClampedTextScaling(maxScaleFactor: 1.5, child: band);
  }
}

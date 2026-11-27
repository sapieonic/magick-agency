import 'package:flutter/material.dart';

import '../../../app/theme/tokens.dart';

/// The full-width band that says where the agent is (AS1, design-spec §1): the state's colour,
/// its icon, two or three big words and a subtitle, with the state's own clock on the right
/// (waiting, talk time, time left, break time). Colour is never the only signal: every band has
/// its own icon and title.
///
/// The title is a header for screen readers; [trailing] reads as it is written (a ticking clock
/// excludes its own semantics where it would be said every second).
///
/// Under a [CompactBand] (the station page, while the keyboard is up on a shorter page) it is one
/// row: the state's colour, a small icon, the title and the clock, about 48 dp.
class StateBand extends StatelessWidget {
  const StateBand({
    super.key,
    required this.tone,
    required this.icon,
    required this.title,
    this.subtitle,
    this.trailing,
    this.bottom,
  });

  final StationTone tone;
  final IconData icon;
  final String title;
  final String? subtitle;

  /// The state's clock or ring, right of the words.
  final Widget? trailing;

  /// Under the words, full width (a bar).
  final Widget? bottom;

  @override
  Widget build(BuildContext context) {
    if (CompactBand.of(context)) return _compact(context);
    final c = context.stateTokens.of(tone);
    final text = Theme.of(context).textTheme;
    return DecoratedBox(
      key: ValueKey('band-tone-${tone.name}'),
      decoration: BoxDecoration(color: c.band),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(Space.lg, Space.md, Space.lg, Space.md),
        child: IconTheme.merge(
          data: IconThemeData(color: c.ink),
          child: DefaultTextStyle.merge(
            style: TextStyle(color: c.ink),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: [
                Row(
                  children: [
                    ExcludeSemantics(
                      child: DecoratedBox(
                        decoration: BoxDecoration(
                          color: c.ink.withValues(alpha: 0.16),
                          borderRadius: BorderRadius.circular(Radii.md),
                        ),
                        child: SizedBox.square(dimension: 48, child: Icon(icon, size: 26, color: c.ink)),
                      ),
                    ),
                    const SizedBox(width: Space.md),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Semantics(
                            header: true,
                            child: Text(
                              title,
                              key: const Key('band-title'),
                              style: text.headlineMedium!.copyWith(color: c.ink),
                            ),
                          ),
                          if (subtitle != null && subtitle!.isNotEmpty) ...[
                            const SizedBox(height: 2),
                            Text(
                              subtitle!,
                              key: const Key('band-subtitle'),
                              style: text.bodyMedium!.copyWith(color: c.ink, fontWeight: FontWeight.w500),
                            ),
                          ],
                        ],
                      ),
                    ),
                    if (trailing != null) ...[
                      const SizedBox(width: Space.sm),
                      // At large text the clock gives way to the words, never the screen's edge.
                      Flexible(
                        child: FittedBox(
                          fit: BoxFit.scaleDown,
                          alignment: AlignmentDirectional.centerEnd,
                          child: DefaultTextStyle.merge(style: TextStyle(color: c.ink), child: trailing!),
                        ),
                      ),
                    ],
                  ],
                ),
                if (bottom != null) ...[const SizedBox(height: Space.sm), bottom!],
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// One row: the icon, the title on one line, and the clock scaled to the row.
  Widget _compact(BuildContext context) {
    final c = context.stateTokens.of(tone);
    final text = Theme.of(context).textTheme;
    return DecoratedBox(
      key: ValueKey('band-tone-${tone.name}'),
      decoration: BoxDecoration(color: c.band),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(Space.lg, Space.xs, Space.lg, Space.xs),
        child: IconTheme.merge(
          data: IconThemeData(color: c.ink),
          child: DefaultTextStyle.merge(
            style: TextStyle(color: c.ink),
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: CompactBand.row),
              child: Row(
                children: [
                  ExcludeSemantics(child: Icon(icon, size: 22, color: c.ink)),
                  const SizedBox(width: Space.sm),
                  Expanded(
                    child: Semantics(
                      header: true,
                      child: Text(
                        title,
                        key: const Key('band-title'),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: text.titleMedium!.copyWith(color: c.ink, fontWeight: FontWeight.w700),
                      ),
                    ),
                  ),
                  if (trailing != null) ...[
                    const SizedBox(width: Space.sm),
                    Flexible(
                      child: ConstrainedBox(
                        constraints: const BoxConstraints(maxHeight: CompactBand.row),
                        child: FittedBox(
                          fit: BoxFit.scaleDown,
                          alignment: AlignmentDirectional.centerEnd,
                          child: DefaultTextStyle.merge(style: TextStyle(color: c.ink), child: trailing!),
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Puts the [StateBand]s under it in their one-row form: the station page, while the keyboard is
/// up on a page too short for the whole band, so the state and its clock stay in view.
class CompactBand extends InheritedWidget {
  const CompactBand({super.key, required super.child});

  /// The row's height, under its padding.
  static const double row = 40;

  /// Whether a [CompactBand] is above [context].
  static bool of(BuildContext context) => context.dependOnInheritedWidgetOfExactType<CompactBand>() != null;

  @override
  bool updateShouldNotify(CompactBand oldWidget) => false;
}

/// A big clock for the band ("0:25", "4:18"): the display font, tabular figures, in the band's ink.
class BandClock extends StatelessWidget {
  const BandClock(this.text, {super.key, this.semanticsLabel, this.caption});

  final String text;
  final String? semanticsLabel;

  /// A small line under the digits ("Recorded").
  final Widget? caption;

  @override
  Widget build(BuildContext context) {
    final style = DefaultTextStyle.of(context).style;
    final digits = Text(
      text,
      key: const Key('band-clock'),
      style: TextStyle(
        fontFamily: Fonts.display,
        fontSize: 30,
        fontWeight: FontWeight.w800,
        height: 1.1,
        color: style.color,
        fontFeatures: const [FontFeature.tabularFigures()],
      ),
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.end,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (semanticsLabel == null) digits else Semantics(label: semanticsLabel, excludeSemantics: true, child: digits),
        ?caption,
      ],
    );
  }
}

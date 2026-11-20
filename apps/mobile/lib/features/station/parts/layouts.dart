import 'package:flutter/material.dart';

import '../../../app/theme/tokens.dart';
import 'banners.dart';
import 'need_help.dart';
import 'top_bar.dart';

/// The one page shape every station screen uses (AS1, design-spec §1 and §4): the top bar, the
/// state's band, the screen's content (scrolling), and its actions pinned at the bottom, full
/// width, in thumb reach. At 200% text the content scrolls; the main action never moves off screen.
///
/// Under the band, in this order and at most one line each: the one-time listening notice, "your
/// customer is waiting", a slow internet line, the microphone, what ended while away, and how the
/// last Need help ended.
class StationPage extends StatelessWidget {
  const StationPage({
    super.key,
    required this.band,
    required this.body,
    this.actions,
    this.onCall = false,
    this.topBar = const StationTopBar(),
    this.banners = true,
  });

  final Widget band;
  final List<Widget> body;

  /// The pinned actions; null for a screen with nothing to press ("The call connects by itself").
  final Widget? actions;

  /// A call screen: the listening notice says where its button is between calls.
  final bool onCall;
  final Widget topBar;

  /// The shared lines under the band; off for the screens with no station to work at.
  final bool banners;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final content = [
      if (banners) ...[
        ListenFirstNoticeCard(onCall: onCall),
        const StationTopNotices(),
        const WeakConnectionLine(),
        const MicProblemBanner(),
        const MissedReleaseCard(),
        const NeedHelpCard(),
      ],
      ...body,
    ];
    // Large text on a small phone: the band scrolls with the content, so the content and the
    // pinned action always have room. Otherwise the band stays put.
    final tight = MediaQuery.textScalerOf(context).scale(16) / 16 > 1.3;
    return ColoredBox(
      color: t.bgPrimary,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ColoredBox(color: t.bgSecondary, child: topBar),
          if (!tight) band,
          Expanded(
            child: SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (tight) band,
                  Padding(
                    padding: const EdgeInsets.fromLTRB(Space.lg, Space.md, Space.lg, Space.lg),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: content),
                  ),
                ],
              ),
            ),
          ),
          if (actions != null) StationActionArea(child: actions!),
        ],
      ),
    );
  }
}

/// The pinned bottom of a station screen: the last refusal (bounded, so a long one at 200% text
/// scrolls inside itself), then the actions.
class StationActionArea extends StatelessWidget {
  const StationActionArea({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: t.bgSecondary,
        border: Border(top: BorderSide(color: t.border)),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(Space.lg, Space.md, Space.lg, Space.md),
        // Bounded, so at 200% text the actions scroll inside themselves rather than push the
        // content off the screen.
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.5),
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: [
                ConstrainedBox(
                  constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.22),
                  child: const SingleChildScrollView(child: ActionErrorLine()),
                ),
                child,
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Two buttons side by side, stacked when large text would squeeze them.
class ButtonPair extends StatelessWidget {
  const ButtonPair({super.key, required this.first, required this.second});

  final Widget first;
  final Widget second;

  @override
  Widget build(BuildContext context) {
    final scale = MediaQuery.textScalerOf(context).scale(16) / 16;
    if (scale > 1.35) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          first,
          const SizedBox(height: Space.sm),
          second,
        ],
      );
    }
    return Row(
      children: [
        Expanded(child: first),
        const SizedBox(width: Space.md),
        Expanded(child: second),
      ],
    );
  }
}

/// A white card with a small heading row (icon and words), as the mock-ups draw "My day",
/// "Last calls", "What to do".
class StationCard extends StatelessWidget {
  const StationCard({super.key, this.icon, this.title, required this.child, this.color, this.borderColor});

  final IconData? icon;
  final String? title;
  final Widget child;
  final Color? color;
  final Color? borderColor;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: color ?? t.bgSecondary,
        borderRadius: BorderRadius.circular(Radii.lg),
        border: Border.all(color: borderColor ?? t.border),
      ),
      child: Padding(
        padding: const EdgeInsets.all(Space.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            if (title != null) ...[
              Semantics(
                header: true,
                child: Row(
                  children: [
                    if (icon != null) ...[Icon(icon, size: 20, color: t.textSecondary), const SizedBox(width: Space.sm)],
                    Expanded(child: Text(title!, style: text.titleSmall!.copyWith(color: t.textSecondary))),
                  ],
                ),
              ),
              const SizedBox(height: Space.sm),
            ],
            child,
          ],
        ),
      ),
    );
  }
}

/// A number tile ("Calls today 42 / 120", "Amount due ₹12,500"): a small label over a big value.
class NumberTile extends StatelessWidget {
  const NumberTile({super.key, required this.label, required this.value, this.suffix, this.color});

  final String label;
  final String value;

  /// After the value, smaller ("/ 120").
  final String? suffix;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    return MergeSemantics(
      child: DecoratedBox(
        decoration: BoxDecoration(color: color ?? t.bgPrimary, borderRadius: BorderRadius.circular(Radii.md)),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: Space.sm, vertical: Space.sm),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(label, style: text.bodySmall, maxLines: 2),
              const SizedBox(height: 2),
              Text.rich(
                TextSpan(
                  text: value,
                  style: text.headlineSmall!.copyWith(fontWeight: FontWeight.w800, fontFeatures: const [FontFeature.tabularFigures()]),
                  children: [
                    if (suffix != null) TextSpan(text: ' $suffix', style: text.bodySmall),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Up to three tiles in a row; one under the other once large text would crush them.
class TileRow extends StatelessWidget {
  const TileRow({super.key, required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final scale = MediaQuery.textScalerOf(context).scale(16) / 16;
    if (scale > 1.4) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final (i, c) in children.indexed) ...[if (i > 0) const SizedBox(height: Space.sm), c],
        ],
      );
    }
    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final (i, c) in children.indexed) ...[if (i > 0) const SizedBox(width: Space.sm), Expanded(child: c)],
        ],
      ),
    );
  }
}

/// Numbered steps ("What to do"): 1, 2, 3, each a short sentence.
class StepsCard extends StatelessWidget {
  const StepsCard({super.key, required this.title, required this.steps, this.tone});

  final String title;
  final List<String> steps;
  final StationTone? tone;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final c = tone == null ? null : context.stateTokens.of(tone!);
    return StationCard(
      icon: Icons.checklist,
      title: title,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final (i, step) in steps.indexed)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: Space.xs),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  DecoratedBox(
                    decoration: BoxDecoration(color: c?.soft ?? t.bgTertiary, shape: BoxShape.circle),
                    child: SizedBox.square(
                      dimension: 28,
                      child: Center(child: Text('${i + 1}', style: text.titleSmall!.copyWith(color: c?.deep))),
                    ),
                  ),
                  const SizedBox(width: Space.md),
                  Expanded(child: Padding(padding: const EdgeInsets.only(top: 4), child: Text(step, style: text.bodyLarge))),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

import 'package:flutter/material.dart';

import '../app/theme/tokens.dart';

/// Small shared building blocks, so every screen draws pills, cards and live
/// indicators the same way. Feature-specific widgets live with their feature.

enum Tone { neutral, accent, live, ok, warn, danger }

extension ToneColors on Tone {
  Color fg(AppTokens t) => switch (this) {
        Tone.neutral => t.textSecondary,
        Tone.accent => t.accentHover,
        Tone.live => t.ember,
        Tone.ok => t.success,
        Tone.warn => t.warning,
        Tone.danger => t.danger,
      };

  Color bg(AppTokens t) => switch (this) {
        Tone.neutral => t.bgTertiary,
        Tone.accent => t.accentSubtle,
        Tone.live => t.emberSubtle,
        Tone.ok => t.successSubtle,
        Tone.warn => t.warningSubtle,
        Tone.danger => t.dangerSubtle,
      };
}

/// A compact status label (campaign status, outcome, "Recording").
class StatusPill extends StatelessWidget {
  const StatusPill(this.label, {super.key, this.tone = Tone.neutral, this.leading});

  final String label;
  final Tone tone;
  final Widget? leading;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return DecoratedBox(
      decoration: BoxDecoration(color: tone.bg(t), borderRadius: BorderRadius.circular(Radii.pill)),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (leading != null) ...[leading!, const SizedBox(width: 6)],
            Flexible(
              child: Text(
                label,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context).textTheme.labelSmall!.copyWith(color: tone.fg(t), fontWeight: FontWeight.w600),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The ember "live" dot. It pulses; under reduced motion it becomes a dot
/// inside a static ring, so it stays distinct from a plain warning dot
/// (the web console's `LiveDot` rule).
class LiveDot extends StatefulWidget {
  const LiveDot({super.key, this.size = 8, this.color});

  final double size;
  final Color? color;

  @override
  State<LiveDot> createState() => _LiveDotState();
}

class _LiveDotState extends State<LiveDot> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1600));

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (MediaQuery.disableAnimationsOf(context)) {
      _c.stop();
    } else if (!_c.isAnimating) {
      _c.repeat();
    }
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final color = widget.color ?? context.tokens.ember;
    final s = widget.size;
    final still = MediaQuery.disableAnimationsOf(context);
    return ExcludeSemantics(
      child: SizedBox.square(
        dimension: s * 2.4,
        child: RepaintBoundary(
          child: AnimatedBuilder(
            animation: _c,
            builder: (context, _) {
              final halo = still ? 1.0 : Curves.easeOut.transform(_c.value);
              return CustomPaint(painter: _LiveDotPainter(color, s, halo, still));
            },
          ),
        ),
      ),
    );
  }
}

class _LiveDotPainter extends CustomPainter {
  _LiveDotPainter(this.color, this.dot, this.halo, this.still);

  final Color color;
  final double dot;
  final double halo;
  final bool still;

  @override
  void paint(Canvas canvas, Size size) {
    final c = size.center(Offset.zero);
    if (still) {
      canvas.drawCircle(
        c,
        dot * 1.1,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1.5
          ..color = color.withValues(alpha: 0.6),
      );
    } else {
      canvas.drawCircle(c, dot / 2 + dot * 0.7 * halo, Paint()..color = color.withValues(alpha: 0.35 * (1 - halo)));
    }
    canvas.drawCircle(c, dot / 2, Paint()..color = color);
  }

  @override
  bool shouldRepaint(_LiveDotPainter old) => old.halo != halo || old.color != color || old.still != still;
}

/// A bordered surface for grouping content.
class AppCard extends StatelessWidget {
  const AppCard({super.key, required this.child, this.padding = const EdgeInsets.all(Space.md), this.borderColor, this.color});

  final Widget child;
  final EdgeInsetsGeometry padding;
  final Color? borderColor;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: color ?? t.bgSecondary,
        borderRadius: BorderRadius.circular(Radii.md),
        border: Border.all(color: borderColor ?? t.border),
      ),
      child: Padding(padding: padding, child: child),
    );
  }
}

/// The one ember-filled action per screen ("Go on duty", "Resume taking calls").
class EmberButton extends StatelessWidget {
  const EmberButton({super.key, required this.label, required this.onPressed, this.icon});

  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return FilledButton.icon(
      onPressed: onPressed,
      icon: icon == null ? const SizedBox.shrink() : Icon(icon, size: 20),
      label: Text(label),
      style: FilledButton.styleFrom(
        backgroundColor: t.emberDeep,
        foregroundColor: t.onAccent,
        disabledBackgroundColor: t.bgTertiary,
        minimumSize: const Size.fromHeight(52),
      ),
    );
  }
}

/// Uppercase small label over a group ("PRIOR ATTEMPTS").
class SectionLabel extends StatelessWidget {
  const SectionLabel(this.text, {super.key, this.trailing});

  final String text;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final style = Theme.of(context).textTheme.labelSmall!.copyWith(letterSpacing: 0.8, fontWeight: FontWeight.w600);
    return Semantics(
      header: true,
      child: Row(
        children: [
          Expanded(child: Text(text.toUpperCase(), style: style)),
          ?trailing,
        ],
      ),
    );
  }
}

/// Loading / error-with-retry wrapper for screens that read once.
class LoadErrorView extends StatelessWidget {
  const LoadErrorView({super.key, required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(Space.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(message, textAlign: TextAlign.center, style: Theme.of(context).textTheme.bodyMedium),
            const SizedBox(height: Space.lg),
            OutlinedButton(onPressed: onRetry, child: const Text('Try again')),
          ],
        ),
      ),
    );
  }
}

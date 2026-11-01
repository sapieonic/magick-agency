import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../../app/theme/app_theme.dart';

/// A number inside a draining ring ("3, 2, 1"; "6 seconds to reconnect").
///
/// The arc eases between whole-second values so it drains smoothly between
/// ticks; under reduced motion it steps. The digit is the accessible value;
/// the ring is decoration.
class CountdownRing extends StatelessWidget {
  const CountdownRing({super.key, required this.value, required this.fraction, required this.color, this.size = 56, this.semanticsLabel});

  final int value;

  /// 1 → 0. Clamped.
  final double fraction;
  final Color color;
  final double size;

  /// Read instead of the bare number ("6 seconds left").
  final String? semanticsLabel;

  @override
  Widget build(BuildContext context) {
    final still = MediaQuery.disableAnimationsOf(context);
    final target = fraction.clamp(0.0, 1.0).toDouble();
    return Semantics(
      label: semanticsLabel ?? '$value',
      excludeSemantics: true,
      child: SizedBox.square(
        dimension: size,
        child: RepaintBoundary(
          child: TweenAnimationBuilder<double>(
            tween: Tween<double>(end: target),
            duration: still ? Duration.zero : const Duration(milliseconds: 950),
            builder: (context, f, child) => CustomPaint(
              painter: _RingPainter(fraction: f, color: color, track: color.withValues(alpha: 0.2)),
              child: child,
            ),
            child: Center(
              child: FittedBox(
                child: Padding(
                  padding: const EdgeInsets.all(6),
                  child: Text(
                    '$value',
                    style: monoStyle(context, size: size * 0.4, weight: FontWeight.w500, color: color),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _RingPainter extends CustomPainter {
  _RingPainter({required this.fraction, required this.color, required this.track});

  final double fraction;
  final Color color;
  final Color track;

  @override
  void paint(Canvas canvas, Size size) {
    const stroke = 3.5;
    final rect = (Offset.zero & size).deflate(stroke / 2);
    canvas.drawArc(
      rect,
      0,
      math.pi * 2,
      false,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = stroke
        ..color = track,
    );
    if (fraction <= 0) return;
    canvas.drawArc(
      rect,
      -math.pi / 2,
      math.pi * 2 * fraction,
      false,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = stroke
        ..strokeCap = StrokeCap.round
        ..color = color,
    );
  }

  @override
  bool shouldRepaint(_RingPainter old) => old.fraction != fraction || old.color != color || old.track != track;
}

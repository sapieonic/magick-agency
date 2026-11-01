import 'package:flutter/material.dart';

/// A horizontal bar that drains from full to empty.
///
/// The parent hands it a new [fraction] once a second; the bar eases to it
/// over that second, so it moves continuously without a per-frame rebuild
/// anywhere above it. Painted, not laid out: a width animation would re-lay
/// out the band beside a live call's audio work. Under reduced motion it
/// steps once a second.
class DrainBar extends StatelessWidget {
  const DrainBar({
    super.key,
    required this.fraction,
    required this.color,
    required this.trackColor,
    this.height = 4,
    this.step = const Duration(seconds: 1),
  });

  final double fraction;
  final Color color;
  final Color trackColor;
  final double height;

  /// How long the bar takes to ease to a new value: the parent's tick period.
  final Duration step;

  @override
  Widget build(BuildContext context) {
    final still = MediaQuery.disableAnimationsOf(context);
    return ExcludeSemantics(
      child: RepaintBoundary(
        child: SizedBox(
          height: height,
          width: double.infinity,
          child: TweenAnimationBuilder<double>(
            tween: Tween<double>(end: fraction.clamp(0.0, 1.0).toDouble()),
            duration: still ? Duration.zero : step,
            builder: (context, f, _) => CustomPaint(painter: _BarPainter(f, color, trackColor, height)),
          ),
        ),
      ),
    );
  }
}

class _BarPainter extends CustomPainter {
  _BarPainter(this.fraction, this.color, this.track, this.height);

  final double fraction;
  final Color color;
  final Color track;
  final double height;

  @override
  void paint(Canvas canvas, Size size) {
    final r = Radius.circular(height / 2);
    canvas.drawRRect(RRect.fromRectAndRadius(Offset.zero & size, r), Paint()..color = track);
    if (fraction <= 0) return;
    canvas.drawRRect(RRect.fromRectAndRadius(Rect.fromLTWH(0, 0, size.width * fraction, size.height), r), Paint()..color = color);
  }

  @override
  bool shouldRepaint(_BarPainter old) => old.fraction != fraction || old.color != color || old.track != track;
}

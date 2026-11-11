import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../app/theme/tokens.dart';

/// A press-and-hold bar for an irreversible action (hang up).
///
/// Not a confirm dialog: a dialog costs a decision 200 times a shift and
/// agents learn to dismiss it reflexively. A hold is one continuous,
/// self-cancelling gesture that a pocket or a jogged thumb cannot complete.
///
/// * **500 ms, fixed** (the console's number): shorter is an ordinary tap,
///   longer reads as broken. An agent's muscle memory must not change.
/// * **Fires on the timer, with the finger still down.** Releasing afterwards
///   does nothing; "hold, then release" makes agents hold for two seconds to
///   be sure.
/// * **Fires once** per hold, and not again until the action has finished and
///   a new hold starts.
/// * **Haptic tick on start, a heavier one on fire**, so the agent feels the
///   moment it took without looking.
/// * Sliding the finger off the bar cancels.
/// * **Screen readers** cannot hold reliably (TalkBack's double-tap-and-hold
///   is a long press with its own timing), so the semantics tap opens a
///   confirm dialog via [confirmAccessibly] instead.
class HoldToConfirmBar extends StatefulWidget {
  const HoldToConfirmBar({
    super.key,
    required this.label,
    required this.holdingLabel,
    required this.busyLabel,
    required this.semanticLabel,
    required this.semanticHint,
    required this.onConfirmed,
    required this.confirmAccessibly,
    this.enabled = true,
    this.busy = false,
    this.holdDuration = const Duration(milliseconds: 500),
    this.icon = Icons.call_end,
  });

  final String label;
  final String holdingLabel;
  final String busyLabel;
  final String semanticLabel;
  final String semanticHint;

  /// The action. The bar shows [busyLabel] and refuses another hold until it
  /// completes.
  final Future<void> Function() onConfirmed;

  /// Asks a screen-reader user to confirm (a dialog); true fires the action.
  final Future<bool> Function(BuildContext context) confirmAccessibly;

  final bool enabled;

  /// The action is in flight elsewhere (the core's busy flag).
  final bool busy;
  final Duration holdDuration;
  final IconData icon;

  @override
  State<HoldToConfirmBar> createState() => _HoldToConfirmBarState();
}

class _HoldToConfirmBarState extends State<HoldToConfirmBar> with SingleTickerProviderStateMixin {
  late final AnimationController _fill = AnimationController(
    vsync: this,
    duration: widget.holdDuration,
    reverseDuration: const Duration(milliseconds: 160),
  )..addStatusListener(_onStatus);

  int? _pointer;
  bool _firing = false;

  bool get _armed => widget.enabled && !widget.busy && !_firing;

  @override
  void didUpdateWidget(HoldToConfirmBar old) {
    super.didUpdateWidget(old);
    if (old.holdDuration != widget.holdDuration) _fill.duration = widget.holdDuration;
    // No setState here: the rebuild that follows this call paints the change.
    if (!_armed && _pointer != null) {
      _pointer = null;
      if (!_firing) _fill.reverse();
    }
  }

  @override
  void dispose() {
    _fill.dispose();
    super.dispose();
  }

  void _onStatus(AnimationStatus status) {
    if (status == AnimationStatus.completed && _pointer != null) {
      _pointer = null;
      _fire();
    }
  }

  void _down(PointerDownEvent e) {
    if (!_armed || _pointer != null) return;
    _pointer = e.pointer;
    unawaited(HapticFeedback.selectionClick());
    _fill.forward(from: 0);
    setState(() {});
  }

  // A pointer keeps reporting to what it hit when it went down, even after that
  // has left the tree: the call ends mid-hold and the bar is replaced, then the
  // finger lifts. By then `_fill` is disposed and `context` is gone, so the
  // late move or lift is dropped here, before either is touched.
  void _up(PointerEvent e) {
    if (!mounted || e.pointer != _pointer) return;
    _cancel();
  }

  void _move(PointerMoveEvent e) {
    if (!mounted || e.pointer != _pointer) return;
    final size = context.size;
    if (size == null) return;
    // A little slack, so a thumb that rolls slightly does not cancel.
    if (!(Offset.zero & size).inflate(24).contains(e.localPosition)) _cancel();
  }

  void _cancel() {
    _pointer = null;
    if (!_firing) _fill.reverse();
    setState(() {});
  }

  Future<void> _fire() async {
    if (_firing) return;
    setState(() => _firing = true);
    unawaited(HapticFeedback.heavyImpact());
    try {
      await widget.onConfirmed();
    } finally {
      if (mounted) {
        _fill.value = 0;
        setState(() => _firing = false);
      }
    }
  }

  Future<void> _accessibleTap() async {
    if (!_armed) return;
    final ok = await widget.confirmAccessibly(context);
    if (ok && mounted && _armed) await _fire();
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final textTheme = Theme.of(context).textTheme;
    final active = widget.enabled;
    final showBusy = widget.busy || _firing;
    final label = showBusy ? widget.busyLabel : (_pointer != null ? widget.holdingLabel : widget.label);
    final fg = active ? t.danger : t.textMuted;

    return Semantics(
      button: true,
      enabled: _armed,
      label: widget.semanticLabel,
      hint: widget.semanticHint,
      value: showBusy ? widget.busyLabel : null,
      onTap: _armed ? _accessibleTap : null,
      excludeSemantics: true,
      child: Listener(
        behavior: HitTestBehavior.opaque,
        onPointerDown: _down,
        onPointerUp: _up,
        onPointerCancel: _up,
        onPointerMove: _move,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 60, minWidth: double.infinity),
          child: RepaintBoundary(
            child: AnimatedBuilder(
              animation: _fill,
              builder: (context, child) => CustomPaint(
                painter: _FillPainter(
                  progress: showBusy ? 1 : _fill.value,
                  track: active ? t.dangerSubtle : t.bgTertiary,
                  fill: t.danger.withValues(alpha: 0.32),
                  radius: Radii.md,
                ),
                child: child,
              ),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: Space.lg, vertical: Space.md),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    if (showBusy)
                      SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2, color: fg))
                    else
                      Icon(widget.icon, color: fg, size: 22),
                    const SizedBox(width: Space.sm),
                    Flexible(
                      child: Text(
                        label,
                        textAlign: TextAlign.center,
                        style: textTheme.labelLarge!.copyWith(color: fg, fontWeight: FontWeight.w700),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _FillPainter extends CustomPainter {
  _FillPainter({required this.progress, required this.track, required this.fill, required this.radius});

  final double progress;
  final Color track;
  final Color fill;
  final double radius;

  @override
  void paint(Canvas canvas, Size size) {
    final rrect = RRect.fromRectAndRadius(Offset.zero & size, Radius.circular(radius));
    canvas.drawRRect(rrect, Paint()..color = track);
    if (progress <= 0) return;
    canvas.save();
    canvas.clipRRect(rrect);
    canvas.drawRect(Rect.fromLTWH(0, 0, size.width * progress, size.height), Paint()..color = fill);
    canvas.restore();
  }

  @override
  bool shouldRepaint(_FillPainter old) => old.progress != progress || old.track != track || old.fill != fill;
}

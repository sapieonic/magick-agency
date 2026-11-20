import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../app/theme/tokens.dart';

/// "Slide to end call" (AS3): today's protection against cutting a customer off by a slip of the
/// thumb, made visible. The agent drags the knob across the red track; it ends the call only once
/// it reaches the far end, and springs back if let go before.
///
/// * **Fires at the end of the track, with the finger still down**, once per slide, and not again
///   until the action has finished and a new slide starts.
/// * **A tap does nothing**: only a drag of [threshold] of the track or more counts.
/// * **Haptic tick when the slide starts, a heavier one when it fires.**
/// * **Screen readers** cannot drag reliably, so the semantics tap opens [confirmAccessibly] (a
///   dialog) instead, as the hold it replaces did.
class SlideToConfirm extends StatefulWidget {
  const SlideToConfirm({
    super.key,
    required this.label,
    required this.busyLabel,
    required this.semanticLabel,
    required this.semanticHint,
    required this.onConfirmed,
    required this.confirmAccessibly,
    this.enabled = true,
    this.busy = false,
    this.icon = Icons.call_end,
    this.threshold = 0.85,
  });

  final String label;
  final String busyLabel;
  final String semanticLabel;
  final String semanticHint;
  final Future<void> Function() onConfirmed;
  final Future<bool> Function(BuildContext context) confirmAccessibly;
  final bool enabled;

  /// The action is in flight elsewhere (the core's busy flag).
  final bool busy;
  final IconData icon;

  /// How far along the track (0–1) the knob must be dragged.
  final double threshold;

  /// The knob's size, and the track's height.
  static const double height = 64;

  @override
  State<SlideToConfirm> createState() => _SlideToConfirmState();
}

class _SlideToConfirmState extends State<SlideToConfirm> with SingleTickerProviderStateMixin {
  late final AnimationController _pos = AnimationController(vsync: this, duration: const Duration(milliseconds: 200));
  bool _dragging = false;
  bool _firing = false;

  bool get _armed => widget.enabled && !widget.busy && !_firing;

  @override
  void didUpdateWidget(SlideToConfirm old) {
    super.didUpdateWidget(old);
    if (!_armed && _dragging) {
      _dragging = false;
      if (!_firing) _pos.animateBack(0);
    }
  }

  @override
  void dispose() {
    _pos.dispose();
    super.dispose();
  }

  double _travel(double width) => (width - SlideToConfirm.height).clamp(1, double.infinity);

  void _start(DragStartDetails _) {
    if (!_armed) return;
    _dragging = true;
    unawaited(HapticFeedback.selectionClick());
    setState(() {});
  }

  void _update(DragUpdateDetails d, double width) {
    if (!_dragging || !mounted) return;
    final v = (_pos.value + d.delta.dx / _travel(width)).clamp(0.0, 1.0);
    _pos.value = v;
    if (v >= widget.threshold) {
      _dragging = false;
      _pos.value = 1;
      unawaited(_fire());
    }
  }

  void _end([Object? _]) {
    if (!mounted || !_dragging) return;
    _dragging = false;
    if (!_firing) _pos.animateBack(0);
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
        _pos.value = 0;
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
    final s = context.stateTokens;
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final showBusy = widget.busy || _firing;
    final track = widget.enabled ? s.stop : t.bgTertiary;
    final ink = widget.enabled ? s.onAction : t.textMuted;
    return Semantics(
      button: true,
      enabled: _armed,
      label: widget.semanticLabel,
      hint: widget.semanticHint,
      value: showBusy ? widget.busyLabel : null,
      onTap: _armed ? _accessibleTap : null,
      excludeSemantics: true,
      child: LayoutBuilder(
        builder: (context, c) {
          final width = c.maxWidth;
          return GestureDetector(
            behavior: HitTestBehavior.opaque,
            onHorizontalDragStart: _start,
            onHorizontalDragUpdate: (d) => _update(d, width),
            onHorizontalDragEnd: _end,
            onHorizontalDragCancel: _end,
            child: SizedBox(
              height: SlideToConfirm.height,
              width: width,
              child: RepaintBoundary(
                child: AnimatedBuilder(
                  animation: _pos,
                  builder: (context, _) {
                    final x = _pos.value * _travel(width);
                    return Stack(
                      children: [
                        Positioned.fill(
                          child: DecoratedBox(
                            decoration: BoxDecoration(color: track, borderRadius: BorderRadius.circular(Radii.lg)),
                          ),
                        ),
                        // What the knob has covered, a shade darker.
                        Positioned(
                          left: 0,
                          top: 0,
                          bottom: 0,
                          width: x + SlideToConfirm.height,
                          child: DecoratedBox(
                            decoration: BoxDecoration(
                              color: widget.enabled ? s.stopEdge : t.bgTertiary,
                              borderRadius: BorderRadius.circular(Radii.lg),
                            ),
                          ),
                        ),
                        Positioned.fill(
                          left: SlideToConfirm.height,
                          child: Center(
                            child: Padding(
                              padding: const EdgeInsets.symmetric(horizontal: Space.sm),
                              child: Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  if (showBusy) ...[
                                    SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2, color: ink)),
                                    const SizedBox(width: Space.sm),
                                  ],
                                  Flexible(
                                    child: Text(
                                      showBusy ? widget.busyLabel : widget.label,
                                      key: const Key('slide-label'),
                                      textAlign: TextAlign.center,
                                      maxLines: 2,
                                      overflow: TextOverflow.ellipsis,
                                      style: text.titleMedium!.copyWith(color: ink, fontSize: 18),
                                    ),
                                  ),
                                  if (!showBusy) ...[
                                    const SizedBox(width: Space.xs),
                                    Icon(Icons.keyboard_double_arrow_right, color: ink.withValues(alpha: 0.8)),
                                  ],
                                ],
                              ),
                            ),
                          ),
                        ),
                        Positioned(
                          left: x,
                          top: 0,
                          bottom: 0,
                          width: SlideToConfirm.height,
                          child: Padding(
                            padding: const EdgeInsets.all(4),
                            child: DecoratedBox(
                              key: const Key('slide-knob'),
                              decoration: BoxDecoration(
                                color: widget.enabled ? s.onAction : t.bgSecondary,
                                borderRadius: BorderRadius.circular(Radii.md),
                              ),
                              child: Icon(widget.icon, color: widget.enabled ? s.stop : t.textMuted, size: 28),
                            ),
                          ),
                        ),
                      ],
                    );
                  },
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}

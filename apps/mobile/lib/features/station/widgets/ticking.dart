import 'dart:async';

import 'package:flutter/widgets.dart';

/// Rebuilds only its own subtree, once per [period], aligned to [anchor].
///
/// A one-shot [Timer] re-armed for the next boundary rather than a Flutter
/// `Ticker`: a ticker asks for a frame on every vsync, which would keep the
/// GPU busy at 60 fps for the hours an agent sits waiting, to move one digit
/// a second. Aligning to the anchor (the moment the timer counts from) means
/// the digit flips exactly when the elapsed second does, not up to a second
/// late.
///
/// Stops while its route is hidden (another tab, a covering route): it reads
/// [TickerMode] like an animation would.
class TickingBuilder extends StatefulWidget {
  const TickingBuilder({super.key, required this.now, required this.builder, this.anchor, this.period = const Duration(seconds: 1)});

  /// The clock. Read on every tick, never captured.
  final DateTime Function() now;

  /// Ticks land on `anchor + k * period`. Null aligns to the wall clock.
  final DateTime? anchor;
  final Duration period;
  final Widget Function(BuildContext context, DateTime now) builder;

  @override
  State<TickingBuilder> createState() => _TickingBuilderState();
}

class _TickingBuilderState extends State<TickingBuilder> {
  Timer? _timer;
  bool _enabled = true;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final enabled = TickerMode.valuesOf(context).enabled;
    if (enabled != _enabled || _timer == null) {
      _enabled = enabled;
      _schedule();
    }
  }

  @override
  void didUpdateWidget(TickingBuilder old) {
    super.didUpdateWidget(old);
    if (old.anchor != widget.anchor || old.period != widget.period) _schedule();
  }

  void _schedule() {
    _timer?.cancel();
    _timer = null;
    if (!_enabled) return;
    final period = widget.period.inMicroseconds;
    final anchor = widget.anchor ?? DateTime.fromMicrosecondsSinceEpoch(0);
    final since = widget.now().difference(anchor).inMicroseconds;
    // Dart's % is non-negative for a positive divisor, so an anchor in the
    // future still lands on its boundaries.
    final wait = period - (since % period) + 1000;
    _timer = Timer(Duration(microseconds: wait), () {
      if (!mounted) return;
      setState(() {});
      _schedule();
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.builder(context, widget.now());
}

import 'dart:async';

import 'package:flutter/widgets.dart';

/// Whether the on-screen keyboard is up.
///
/// Read from the window, not only from [MediaQuery]: a `Scaffold` that resizes for the keyboard
/// (the shell's and the station's both do) takes the keyboard out of its body's `MediaQuery`, so
/// `MediaQuery.viewInsetsOf` reads 0 under one while the keyboard covers half the screen.
bool keyboardOpenOf(BuildContext context) =>
    MediaQuery.viewInsetsOf(context).bottom > 0 || View.of(context).viewInsets.bottom > 0;

/// Builds [builder] with whether the on-screen keyboard is up ([keyboardOpenOf]), and again each
/// time it opens or closes. Nothing above a `Scaffold`'s body rebuilds it when the keyboard moves
/// (the keyboard is not in that body's `MediaQuery`), so this listens to the window's metrics.
class KeyboardOpenBuilder extends StatefulWidget {
  const KeyboardOpenBuilder({super.key, required this.builder});

  final Widget Function(BuildContext context, bool open) builder;

  @override
  State<KeyboardOpenBuilder> createState() => _KeyboardOpenBuilderState();
}

class _KeyboardOpenBuilderState extends State<KeyboardOpenBuilder> with WidgetsBindingObserver {
  bool? _open;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeMetrics() {
    if (!mounted) return;
    final open = keyboardOpenOf(context);
    if (open != _open) setState(() => _open = open);
  }

  @override
  Widget build(BuildContext context) {
    final open = keyboardOpenOf(context);
    _open = open;
    return widget.builder(context, open);
  }
}

/// While [focusNode] has focus, keeps the whole of [child] in view in its scrolling column: the
/// field's label and status line with the field, not only the line being typed.
///
/// The text field itself scrolls only its caret into view (with a little padding) when it gains
/// focus and as the keyboard opens; a label above the field is left under the band. Once the
/// keyboard has settled (no change in the window's size or insets for [settle]) and the field has
/// focus, this scrolls the least that shows all of [child]. When [child] is taller than the
/// column's view (large text, a small phone) it shows [child]'s top down to the end of the field
/// being typed in; when even that does not fit it does nothing, so the caret keeps the place the
/// field gave it.
class RevealWhileTyping extends StatefulWidget {
  const RevealWhileTyping({
    super.key,
    required this.focusNode,
    required this.child,
    this.settle = const Duration(milliseconds: 150),
  });

  final FocusNode focusNode;
  final Widget child;

  /// How long the window must be still before revealing (the keyboard animates in over a few
  /// hundred milliseconds, one metrics change a frame).
  final Duration settle;

  @override
  State<RevealWhileTyping> createState() => _RevealWhileTypingState();
}

class _RevealWhileTypingState extends State<RevealWhileTyping> with WidgetsBindingObserver {
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    widget.focusNode.addListener(_focusChanged);
  }

  @override
  void didUpdateWidget(RevealWhileTyping old) {
    super.didUpdateWidget(old);
    if (old.focusNode != widget.focusNode) {
      old.focusNode.removeListener(_focusChanged);
      widget.focusNode.addListener(_focusChanged);
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    widget.focusNode.removeListener(_focusChanged);
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  void _focusChanged() {
    if (widget.focusNode.hasFocus) {
      _schedule();
    } else {
      _timer?.cancel();
    }
  }

  @override
  void didChangeMetrics() {
    if (widget.focusNode.hasFocus) _schedule();
  }

  void _schedule() {
    _timer?.cancel();
    _timer = Timer(widget.settle, _reveal);
  }

  void _reveal() {
    if (!mounted || !widget.focusNode.hasFocus) return;
    final box = context.findRenderObject();
    final scrollable = Scrollable.maybeOf(context);
    if (box is! RenderBox || !box.attached || !box.hasSize || scrollable == null) return;
    final position = scrollable.position;
    if (!position.hasViewportDimension) return;
    final room = position.viewportDimension;
    // All of it; else (large text, a small phone) its top down to the end of the box being typed
    // in, leaving out the lines under it; else nothing, and the caret keeps its place.
    Rect? target = Offset.zero & box.size;
    if (target.height > room) {
      final field = widget.focusNode.context?.findRenderObject();
      target = null;
      if (field is RenderBox && field.attached && field.hasSize) {
        final end = MatrixUtils.transformRect(field.getTransformTo(box), Offset.zero & field.size).bottom;
        if (end <= room) target = Rect.fromLTRB(0, 0, box.size.width, end);
      }
    }
    if (target == null) return;
    final still = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    box.showOnScreen(
      rect: target,
      duration: still ? Duration.zero : const Duration(milliseconds: 150),
      curve: Curves.easeOutCubic,
    );
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

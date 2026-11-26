import 'dart:async';

import 'package:flutter/widgets.dart';

/// Less than this much of the window covered at the bottom (dp) is not the on-screen keyboard: a
/// hardware keyboard's suggestion strip, or an input method's floating bar.
const keyboardMinInset = 100.0;

/// Whether the on-screen keyboard is up: it covers more than [keyboardMinInset] of the window.
///
/// Read from the window, not only from [MediaQuery]: the shell's `Scaffold` ends its body at the
/// keyboard's top and takes the keyboard out of its body's `MediaQuery` (`ShellBody`), so under it,
/// in every tab, `MediaQuery.viewInsetsOf` reads 0 while the keyboard covers half the screen.
bool keyboardOpenOf(BuildContext context) =>
    MediaQuery.viewInsetsOf(context).bottom > keyboardMinInset ||
    View.of(context).viewInsets.bottom / View.of(context).devicePixelRatio > keyboardMinInset;

/// Builds [builder] with whether the on-screen keyboard is up ([keyboardOpenOf]), and again each
/// time it opens or closes. Under a `Scaffold`'s body nothing that depends on `MediaQuery`'s insets
/// rebuilds when the keyboard moves (it is not in that body's `MediaQuery`), so this listens to the
/// window's metrics.
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
/// focus and as the keyboard opens; a label above the field is left out of view. Once the keyboard
/// has settled (no change in the window's size or insets for [settle]) and the field has focus, and
/// again when the column's view gets shorter while it has ([KeepTypingInView]: a refusal appears
/// under it), this scrolls the least that shows the first of these that fits the view: all of
/// [child]; its top down to the end of the field being typed in; its top down to the line being
/// typed. When none fits (large text, a small phone) it does nothing, and the caret keeps the place
/// the field gave it.
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

  /// Brings the field that has focus, if it is in a [RevealWhileTyping], back into view, as once the
  /// keyboard settles.
  static void _revealFocused() {
    final focused = FocusManager.instance.primaryFocus;
    final state = focused?.context?.findAncestorStateOfType<_RevealWhileTypingState>();
    if (state != null && state.widget.focusNode.hasFocus) state._schedule();
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
    // in, leaving out the lines under it; else its top down to the line being typed; else nothing,
    // and the caret keeps its place.
    Rect? target = Offset.zero & box.size;
    if (target.height > room) {
      target = null;
      final focus = widget.focusNode.context;
      final field = focus?.findRenderObject();
      if (field is RenderBox && field.attached && field.hasSize) {
        final end = MatrixUtils.transformRect(field.getTransformTo(box), Offset.zero & field.size).bottom;
        if (end <= room) target = Rect.fromLTRB(0, 0, box.size.width, end);
      }
      final editable = focus?.findAncestorStateOfType<EditableTextState>()?.renderEditable;
      final selection = editable?.selection;
      if (target == null && editable != null && editable.attached && selection != null && selection.isValid) {
        final caret = editable.getLocalRectForCaret(selection.extent);
        final end = MatrixUtils.transformRect(editable.getTransformTo(box), caret).bottom + 8;
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

/// Put around a scrolling column that holds [RevealWhileTyping]s: when the column's view gets
/// shorter while a field in it is being typed in (a refusal, or a line, appears beside the column,
/// as the keyboard stays up), that field's [RevealWhileTyping] brings it back into view. A change
/// of the window (the keyboard itself) is [RevealWhileTyping]'s own.
class KeepTypingInView extends StatefulWidget {
  const KeepTypingInView({super.key, required this.child});

  final Widget child;

  @override
  State<KeepTypingInView> createState() => _KeepTypingInViewState();
}

class _KeepTypingInViewState extends State<KeepTypingInView> {
  double? _view;

  bool _onMetrics(ScrollMetricsNotification n) {
    if (n.depth != 0) return false;
    final view = n.metrics.viewportDimension;
    final shorter = _view != null && view < _view! - 0.5;
    _view = view;
    if (shorter) _RevealWhileTypingState._revealFocused();
    return false;
  }

  @override
  Widget build(BuildContext context) =>
      NotificationListener<ScrollMetricsNotification>(onNotification: _onMetrics, child: widget.child);
}

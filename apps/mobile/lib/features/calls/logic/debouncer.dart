import 'dart:async';

/// Runs the last action handed to it once [delay] has passed with no newer
/// one: the number search applies a query when the agent pauses typing, not
/// on every keystroke (one request and one list rebuild per pause).
class Debouncer {
  Debouncer(this.delay);

  final Duration delay;
  Timer? _timer;

  bool get pending => _timer?.isActive ?? false;

  void call(void Function() action) {
    _timer?.cancel();
    _timer = Timer(delay, action);
  }

  /// Run the pending action now (the keyboard's search key).
  void flush(void Function() action) {
    _timer?.cancel();
    _timer = null;
    action();
  }

  void cancel() {
    _timer?.cancel();
    _timer = null;
  }

  void dispose() => cancel();
}

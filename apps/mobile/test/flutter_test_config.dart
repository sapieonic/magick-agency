import 'dart:async';

import 'package:flutter/foundation.dart';

/// Runs before every test file (`flutter test` picks this up by name).
///
/// Prints go out at once. Flutter's default `debugPrint` throttles to 12 KB per second of *real*
/// time and, past that, sets a one-second `Timer` in whatever zone printed: inside `fakeAsync` that
/// is a fake timer that depends on how fast the machine ran (the station's own log lines are
/// printed in debug builds), so a test that checks for pending timers could fail under load. A
/// `testWidgets` test already prints synchronously (its binding sets it); a plain `test` that never
/// starts the binding did not.
Future<void> testExecutable(FutureOr<void> Function() testMain) async {
  debugPrint = debugPrintSynchronously;
  await testMain();
}

import 'dart:async';

import 'package:intl/date_symbol_data_local.dart';
import 'package:intl/intl.dart';

/// Number, duration and date renderings for the agent's own numbers, ported
/// from the console (`utils/format/number.ts`, `utils/format/duration.ts`,
/// `utils/format/date.ts`, `utils/agencySpineCopy.ts`, web-ui `format.ts`) so
/// the app and the console print one figure the same way: `en-IN` grouping,
/// one-decimal percentages with the trailing zero trimmed, rounded stopwatch
/// durations.
///
/// Every formatter here is cached: the call list formats three fields per row
/// and building an `intl` formatter per call is the expensive part.
abstract final class EnIn {
  static const locale = 'en_IN';

  static bool _datesReady = false;

  /// `intl` needs the en_IN date symbols loaded once. The app's localization
  /// delegates load them too, but unit tests and the first frame before the
  /// delegates settle must not depend on that. The call is synchronous in
  /// effect (it returns an already-completed future).
  static void _ensureDates() {
    if (_datesReady) return;
    // The returned future is already complete; nothing to wait for.
    unawaited(initializeDateFormatting(locale));
    _datesReady = true;
  }

  static final NumberFormat _count = NumberFormat.decimalPattern(locale);
  static DateFormat? _dayMonth;
  static DateFormat? _dayMonthYear;
  static DateFormat? _clock;
  static DateFormat? _stamp;

  /// `12,34,567`: Indian grouping (`formatCount`).
  static String count(num value) => _count.format(value);

  /// One decimal, trailing zero trimmed: `18%`, `18.5%` (`pct`). Same rounding
  /// as the console's `Number(value.toFixed(1))`: `toStringAsFixed` and JS
  /// `toFixed` both round the exact binary value.
  static String pct(double value) {
    var s = value.toStringAsFixed(1);
    if (s.endsWith('.0')) s = s.substring(0, s.length - 2);
    if (s == '-0') s = '0';
    return '$s%';
  }

  /// A duration as `m:ss`, rolling to `h:mm:ss`, ROUNDED to the second
  /// (`statClock`). Used for aggregates: a served 59.6 s reads `1:00`.
  static String statClock(double seconds) => _clock3(seconds.isFinite ? (seconds < 0 ? 0 : seconds.round()) : 0);

  /// A single call's talk time: `m:ss`, FLOORED, minutes unbounded, and an em
  /// dash for null (`formatTalkTime`). Null is "never bridged", not zero.
  static String talkTime(double? seconds) {
    if (seconds == null || !seconds.isFinite) return '—';
    final whole = seconds < 0 ? 0 : seconds.floor();
    return '${whole ~/ 60}:${(whole % 60).toString().padLeft(2, '0')}';
  }

  static String _clock3(int total) {
    final s = total % 60;
    final m = (total ~/ 60) % 60;
    final h = total ~/ 3600;
    final ss = s.toString().padLeft(2, '0');
    if (h == 0) return '$m:$ss';
    return '$h:${m.toString().padLeft(2, '0')}:$ss';
  }

  /// `16 Oct` on the reader's calendar (`formatDayMonth`).
  static String dayMonth(DateTime local) {
    _ensureDates();
    return (_dayMonth ??= DateFormat('d MMM', locale)).format(local);
  }

  /// `16 Oct 2026` (`formatDayMonthYear`).
  static String dayMonthYear(DateTime local) {
    _ensureDates();
    return (_dayMonthYear ??= DateFormat('d MMM y', locale)).format(local);
  }

  /// `09:05 am` (`formatClockTime`).
  static String clockTime(DateTime local) {
    _ensureDates();
    return (_clock ??= DateFormat('hh:mm a', locale)).format(local);
  }

  /// `16 Oct 2026, 09:05 am`: the console's attempt timestamp in en-IN
  /// (`formatSpineTimestamp`), and an em dash for null.
  static String timestamp(DateTime? t) {
    if (t == null) return '—';
    _ensureDates();
    return (_stamp ??= DateFormat('d MMM y, hh:mm a', locale)).format(t.toLocal());
  }

  /// `+91 98400 12345` for an Indian mobile number, anything else as sent
  /// (web-ui `formatPhone`).
  static String phone(String? e164) {
    if (e164 == null || e164.isEmpty) return '--';
    if (e164.startsWith('+91') && e164.length == 13) {
      return '+91 ${e164.substring(3, 8)} ${e164.substring(8)}';
    }
    return e164;
  }
}

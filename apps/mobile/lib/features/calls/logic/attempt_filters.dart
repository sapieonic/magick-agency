import 'package:agency_wire/agency_wire.dart';
import 'package:collection/collection.dart';
import 'package:meta/meta.dart';

import '../../performance/logic/en_in_format.dart';
import '../../performance/logic/stats_windows.dart';

/// The filters "My calls" applies, matching the console's
/// `agencyAttemptFilters.ts` and the filter card in `AgentAttemptsPanel`.
///
/// Immutable and applied as a whole: changing any of them starts a new
/// query from the first page (the cursor belongs to the old query).

/// Which days: any, today (re-resolved on every read, so the chip stays
/// right across midnight), or an inclusive range of days.
@immutable
sealed class DayFilter {
  const DayFilter();
}

final class AnyDay extends DayFilter {
  const AnyDay();

  @override
  bool operator ==(Object other) => other is AnyDay;

  @override
  int get hashCode => 0;
}

final class TodayOnly extends DayFilter {
  const TodayOnly();

  @override
  bool operator ==(Object other) => other is TodayOnly;

  @override
  int get hashCode => 1;
}

/// "First day" to "Last day", BOTH included (the console's wording).
final class DayRange extends DayFilter {
  const DayRange(this.first, this.last);

  final CalendarDate first;
  final CalendarDate last;

  @override
  bool operator ==(Object other) => other is DayRange && other.first == first && other.last == last;

  @override
  int get hashCode => Object.hash(first, last);
}

@immutable
class AttemptFilters {
  const AttemptFilters({this.days = const AnyDay(), this.outcomes = const {}, this.campaignId, this.phone});

  /// What a fresh "My calls" opens on: today's calls.
  static const initial = AttemptFilters(days: TodayOnly());

  final DayFilter days;
  final Set<AttemptOutcome> outcomes;
  final String? campaignId;

  /// Trimmed search term, or null. Only applied once it has a digit.
  final String? phone;

  AttemptFilters copyWith({
    DayFilter? days,
    Set<AttemptOutcome>? outcomes,
    String? campaignId,
    bool clearCampaign = false,
    String? phone,
    bool clearPhone = false,
  }) =>
      AttemptFilters(
        days: days ?? this.days,
        outcomes: outcomes ?? this.outcomes,
        campaignId: clearCampaign ? null : (campaignId ?? this.campaignId),
        phone: clearPhone ? null : (phone ?? this.phone),
      );

  /// Anything narrowing the list (`isAttemptFiltered`); `phone` counts.
  bool get isFiltered => outcomes.isNotEmpty || campaignId != null || phone != null || days is! AnyDay;

  /// How many filter groups apply (`attemptFilterGroupCount`).
  int get groupCount =>
      (outcomes.isNotEmpty ? 1 : 0) + (campaignId != null ? 1 : 0) + (phone != null ? 1 : 0) + (days is AnyDay ? 0 : 1);

  /// The request for one page. [now] and [calendar] resolve the days.
  AttemptsQuery toQuery({
    String? cursor,
    required int limit,
    required DateTime now,
    LocalCalendar calendar = const DeviceCalendar(),
  }) {
    final range = switch (days) {
      AnyDay() => null,
      TodayOnly() => () {
          final w = calendar.wall(now);
          final d = CalendarDate(w.year, w.month, w.day);
          return attemptDateRange(d, d, calendar: calendar);
        }(),
      DayRange(:final first, :final last) => attemptDateRange(first, last, calendar: calendar),
    };
    return AttemptsQuery(
      cursor: cursor,
      limit: limit,
      from: range?.from,
      to: range?.to,
      campaignId: campaignId,
      // Sorted so one filter set is one query string.
      outcomes: outcomes.sorted((a, b) => a.index - b.index),
      phone: phone,
    );
  }

  @override
  bool operator ==(Object other) =>
      other is AttemptFilters &&
      other.days == days &&
      const SetEquality<AttemptOutcome>().equals(other.outcomes, outcomes) &&
      other.campaignId == campaignId &&
      other.phone == phone;

  @override
  int get hashCode => Object.hash(days, const SetEquality<AttemptOutcome>().hash(outcomes), campaignId, phone);
}

/// Two days → `[start of first, end of last]`, INCLUSIVE of the last day,
/// on the reader's calendar (`attemptDateRange`: `to` is the next day's
/// midnight minus a millisecond, because this route's `to` is inclusive).
StatsRange attemptDateRange(CalendarDate first, CalendarDate last, {LocalCalendar calendar = const DeviceCalendar()}) {
  final from = calendar.midnight(first.year, first.month, first.day);
  final to = calendar.midnight(last.year, last.month, last.day + 1).subtract(const Duration(milliseconds: 1));
  return StatsRange(from, to);
}

/// The range's chip label: `Today`, `Any day`, `16 Oct`, `12 Oct – 18 Oct`.
String dayFilterLabel(DayFilter f) => switch (f) {
      AnyDay() => 'Any day',
      TodayOnly() => 'Today',
      DayRange(:final first, :final last) => first == last
          ? EnIn.dayMonth(DateTime.utc(first.year, first.month, first.day))
          : '${EnIn.dayMonth(DateTime.utc(first.year, first.month, first.day))} – '
              '${EnIn.dayMonth(DateTime.utc(last.year, last.month, last.day))}',
    };

/// A typed phone search, normalised: trimmed, and null when empty.
String? normalisePhone(String raw) {
  final t = raw.trim();
  return t.isEmpty ? null : t;
}

/// Why a typed search would be refused (the server answers 400 for a term
/// with no digit), or null when it is fine to send.
String? phoneSearchProblem(String raw) {
  final t = raw.trim();
  if (t.isEmpty) return null;
  return RegExp(r'\d').hasMatch(t) ? null : 'Type at least one digit — the whole number or its last few digits.';
}

/// Under the date filter (`ATTEMPT_RANGE_NOTE`).
const attemptRangeNote =
    'Both dates are included. The range covers when each call was created — so a call that '
    'never got dialled still shows up on the day it was queued.';

/// Placeholder of the number search (the console's).
const phoneSearchHint = 'Whole number, or the last few digits';

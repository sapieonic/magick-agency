import 'package:agency_wire/agency_wire.dart';
import 'package:meta/meta.dart';

import '../../../ui/primitives.dart';
import '../../performance/logic/en_in_format.dart';
import '../../performance/logic/readouts.dart';

/// The call list's words, from `packages/contracts/src/api/agency/agency-spine.ts`
/// (`ATTEMPT_OUTCOME_LABELS`, `ATTEMPT_STATE_LABELS`) and the console's
/// `AgentAttemptsPanel`, so an agent reads the same label on both clients.

const attemptOutcomeLabels = <AttemptOutcome, String>{
  AttemptOutcome.connected: 'Connected',
  AttemptOutcome.noAnswer: 'No answer',
  AttemptOutcome.busy: 'Busy',
  AttemptOutcome.failed: 'Failed',
  AttemptOutcome.machine: 'Answering machine',
  AttemptOutcome.invalid: 'Invalid number',
  AttemptOutcome.abandoned: 'Abandoned (no agent free)',
  AttemptOutcome.agentDisconnected: 'Agent disconnected',
  AttemptOutcome.orphaned: 'Interrupted by a system fault',
  AttemptOutcome.canceled: 'Stopped by us before answer',
};

const attemptStateLabels = <AttemptState, String>{
  AttemptState.queued: 'Queued',
  AttemptState.dialing: 'Dialling',
  AttemptState.ringing: 'Ringing',
  AttemptState.answered: 'Answered',
  AttemptState.bridged: 'On the call',
  AttemptState.ended: 'Ended',
};

/// Null is "Not classified" (never "Failed"); a value this build does not
/// know is shown as sent (`attemptOutcomeLabel`).
String attemptOutcomeLabel(AttemptRow row) {
  final raw = row.outcomeRaw;
  if (raw == null) return 'Not classified';
  return attemptOutcomeLabels[row.outcome] ?? raw;
}

String attemptStateLabel(AttemptRow row) => attemptStateLabels[row.state] ?? row.stateRaw;

/// The pill's tone: green for a conversation, amber where the dialer let the
/// customer down, red where the line or the system failed, neutral for the
/// ordinary misses.
Tone outcomeTone(AttemptOutcome? outcome) => switch (outcome) {
      AttemptOutcome.connected => Tone.ok,
      AttemptOutcome.abandoned || AttemptOutcome.agentDisconnected => Tone.warn,
      AttemptOutcome.failed || AttemptOutcome.invalid || AttemptOutcome.orphaned => Tone.danger,
      _ => Tone.neutral,
    };

/// One row, formatted once (rows are immutable, so the strings are cached
/// per row and a scroll never re-runs a date formatter).
@immutable
class AttemptRowView {
  AttemptRowView._(AttemptRow row)
      : phone = EnIn.phone(row.phoneE164),
        outcome = attemptOutcomeLabel(row),
        tone = outcomeTone(row.outcomeRaw == null ? null : row.outcome),
        when = EnIn.clockTime(row.createdAt.toLocal()),
        day = EnIn.dayMonth(row.createdAt.toLocal()),
        _localDay = _dayNumber(row.createdAt.toLocal()),
        whenFull = EnIn.timestamp(row.createdAt),
        tryLabel = 'try ${row.attemptNumber}',
        talk = EnIn.talkTime(row.talkSeconds),
        writeUp = _writeUp(row);

  static final _cache = Expando<AttemptRowView>('AttemptRowView');

  factory AttemptRowView.of(AttemptRow row) => _cache[row] ??= AttemptRowView._(row);

  final String phone;
  final String outcome;
  final Tone tone;

  /// `11:24 am`.
  final String when;

  /// `16 Oct`.
  final String day;
  final int _localDay;

  static int _dayNumber(DateTime l) => l.year * 10000 + l.month * 100 + l.day;

  /// The row's time, with the day in front unless it is [today] (local).
  String whenOn(DateTime today) => _dayNumber(today) == _localDay ? when : '$day, $when';

  /// `16 Oct 2026, 11:24 am`.
  final String whenFull;
  final String tryLabel;

  /// `m:ss`, or an em dash when the call never bridged.
  final String talk;

  /// The write-up code and the notes preview, or "Not written up".
  final String writeUp;

  static String _writeUp(AttemptRow row) {
    final code = row.dispositionCode;
    final notes = row.notes?.replaceAll(RegExp(r'\s+'), ' ').trim();
    final hasNotes = notes != null && notes.isNotEmpty;
    if (code == null) return hasNotes ? 'Not written up · $notes' : 'Not written up';
    return hasNotes ? '$code · $notes' : code;
  }

  /// `11:24 am · Q4 Card Renewals · try 2 · 3:41` (talk only when it
  /// bridged; the day in front when the call was not [today]).
  String meta(String campaign, AttemptRow row, DateTime today) =>
      [whenOn(today), campaign, tryLabel, if (row.talkSeconds != null) talk].join(' · ');
}

/// The campaign cell: the name, or a shortened id (never blank).
String attemptCampaign(AttemptRow row, Map<String, String?> names) => campaignLabel(row.campaignId, names);

/// "Showing 50 calls — there are more" (the console's live count line).
String attemptsCountLine(int shown, {required bool more}) =>
    'Showing ${EnIn.count(shown)} call${shown == 1 ? '' : 's'}${more ? ' — there are more' : ''}';

/// Empty-state copy (`AgentAttemptsPanel`'s `EmptyState`).
({String title, String body}) attemptsEmptyCopy({required bool filtered}) => filtered
    ? (
        title: 'No calls match those filters',
        body: 'Widen the days or clear the filters to see every call on record.',
      )
    : (
        title: 'You haven’t taken any calls yet',
        body: 'Calls appear here as you take them — including the ones that never connected.',
      );

/// Above the list (`AgentAttemptsPanel`'s privacy note for the agent's own).
const attemptsPrivacyNote = 'Phone numbers are shown in full. There is no export from this view.';

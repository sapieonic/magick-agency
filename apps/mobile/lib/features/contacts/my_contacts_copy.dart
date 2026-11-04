import 'package:agency_wire/agency_wire.dart';

import '../../core/api/api_error.dart';
import '../../core/station/station_copy.dart' show humaniseCode;
import '../station/logic/format.dart' show formatDueAt;

/// Every sentence My contacts says (contact assignment), in one place.
///
/// Each vocabulary the server can answer with has an exhaustive `switch`
/// here, so a member added to `agency_wire` without words is a compile error
/// rather than a raw code on an agent's phone. `unknown` (a literal from a
/// newer server) reads the server's own sentence where there is one.
abstract final class MyContactsCopy {
  static const title = 'My contacts';
  static const flagOff = 'My contacts isn’t turned on for this account.';
  static const loadFailed = 'We couldn’t load your contacts.';
  static const moreFailed = 'We couldn’t load any more contacts.';
  static const summaryFailed = 'We couldn’t load your counts.';
  static const emptyTitle = 'No contacts here';
  static const emptyBody = 'Nothing assigned to you matches. Your supervisor assigns contacts to you.';
  static const emptyFilteredBody = 'Nothing matches these filters. Clear them to see every contact.';
  static const clearFilters = 'Clear filters';
  static const searchLabel = 'Phone number';
  static const searchHint = 'Any digits of the number';
  static const searchProblem = 'Type at least one digit.';
  static const total = 'Assigned to you';
  static const dueNow = 'Due now';
  static const allBuckets = 'All';
  static const end = 'That’s every contact assigned to you here.';

  // ── Calling ──
  static const call = 'Call';
  static const calling = 'Calling…';
  static const callPlaced = 'Calling now. The station takes over when it rings.';
  static const callNeedsStation = 'Go on duty on this campaign and be available to call a contact yourself.';
  static const callNeedsAvailable = 'Be available on the station to call a contact yourself.';
  static const callNeedsRunning = 'The campaign isn’t running, so no call can be placed.';
  static const noteTitle = 'Call outside calling hours?';

  /// [disposition] is the grant's outcome, or null when the list has not
  /// caught up with it (the server said the contact holds one).
  static String noteBody(String? disposition) =>
      '${disposition == null ? 'An earlier outcome' : 'The outcome “$disposition”'} lets you call this customer '
      'outside the campaign’s calling hours, once. '
      'Say why ($overrideNoteMin to $overrideNoteMax characters); your supervisor sees it.';
  static const noteLabel = 'Why are you calling now?';
  static const noteTooShort = 'Write at least $overrideNoteMin characters.';
  static const noteTooLong = 'Keep it to $overrideNoteMax characters.';
  static const noteConfirm = 'Call now';
  static const cancel = 'Cancel';

  // ── Retry not reached ──
  static String retryAll(int n) => 'Retry not reached ($n)';
  static String retrySelected(int n) => 'Retry selected ($n)';
  static const retrying = 'Retrying…';
  static const retryTitle = 'Retry the contacts you didn’t reach?';
  static String retryBody(int n, {required bool selected}) =>
      '${selected ? 'The $n you picked go' : '$n ${n == 1 ? 'contact goes' : 'contacts go'}'} back into your queue '
      'now, and the station dials them in turn. Each retry uses one of the campaign’s retry rounds for that contact.';
  static const retryConfirm = 'Retry';
  static const selectHint = 'Tap a contact you didn’t reach to pick it.';
  static const clearSelection = 'Clear';

  static String retryDone(AgentRetryResponse r) {
    final reopened = r.reopened == 0
        ? 'Nothing was reopened.'
        : 'Reopened ${r.reopened} ${r.reopened == 1 ? 'contact' : 'contacts'}. They’ll be dialled in turn.';
    if (r.skippedTotal == 0) return reopened;
    return '$reopened ${r.skippedTotal} couldn’t be retried now.';
  }

  /// Short labels for the filter chips and the counts.
  static String bucketLabel(MyContactBucket bucket, {String? raw}) => switch (bucket) {
        MyContactBucket.pending => 'Pending',
        MyContactBucket.callback => 'Callbacks',
        MyContactBucket.notReached => 'Not reached',
        MyContactBucket.inProgress => 'On a call',
        MyContactBucket.reached => 'Reached',
        MyContactBucket.exhausted => 'Exhausted',
        MyContactBucket.suppressed => 'DNC',
        MyContactBucket.unknown => raw == null || raw.isEmpty ? 'Other' : humaniseCode(raw),
      };

  /// What a row says about when the contact is next due.
  static String? whenLine(MyContact c, DateTime now) {
    final at = formatDueAt(c.nextAttemptAt, now);
    return switch (c.bucket) {
      MyContactBucket.callback => 'Callback $at',
      MyContactBucket.pending || MyContactBucket.notReached =>
        c.nextAttemptAt.isAfter(now) ? 'Next try $at' : 'Due now',
      MyContactBucket.inProgress => 'On a call now',
      MyContactBucket.reached ||
      MyContactBucket.exhausted ||
      MyContactBucket.suppressed ||
      MyContactBucket.unknown =>
        c.lastAttemptAt == null ? null : 'Last call ${formatDueAt(c.lastAttemptAt!, now)}',
    };
  }

  /// The badge an unspent override shows on a row.
  static String overrideBadge(ContactOverride o) => [
        for (final k in o.kinds) overrideKindLabel(k, extraAttempts: o.extraAttempts),
      ].join(' · ');

  static String overrideKindLabel(OverrideKind kind, {int extraAttempts = 0}) => switch (kind) {
        OverrideKind.extraAttempts => '+$extraAttempts ${extraAttempts == 1 ? 'try' : 'tries'}',
        OverrideKind.retryDelay => 'Call early',
        OverrideKind.callingHours => 'Outside hours',
        OverrideKind.unknown => 'Override',
      };

  /// Why a contact cannot be retried now.
  static String retryBlock(AgentRetryBlock? block, {DateTime? availableAt, required DateTime now}) =>
      switch (block) {
        AgentRetryBlock.retryDisabled => 'This campaign doesn’t let agents retry contacts.',
        AgentRetryBlock.notRetryable => 'Only a contact you didn’t reach can be retried.',
        AgentRetryBlock.roundsUsed => 'You’ve retried this contact as many times as the campaign allows.',
        AgentRetryBlock.cooldown => availableAt == null
            ? 'It was called too recently to retry yet.'
            : 'It was called too recently. It can be retried at ${formatDueAt(availableAt, now)}.',
        AgentRetryBlock.suppressed => 'This number is on the Do Not Call list.',
        AgentRetryBlock.unknown || null => 'This contact can’t be retried now.',
      };

  /// The line for a refusal of an own-contact route, one per code.
  static String refusal(AgentRetryRefusal r, {required DateTime now}) => switch (r.code) {
        AgentRetryErrorCode.assignmentDisabled => flagOff,
        AgentRetryErrorCode.notStaffed => 'You’re not on this campaign’s team any more. Ask your supervisor.',
        AgentRetryErrorCode.agentRetryDisabled => 'This campaign doesn’t let agents retry contacts.',
        AgentRetryErrorCode.contactNotFound =>
          'This contact isn’t assigned to you any more. The list has been brought up to date.',
        AgentRetryErrorCode.contactNotRetryable =>
          'This contact can’t be called now. ${retryBlock(r.blocked, availableAt: r.availableAt, now: now)}',
        AgentRetryErrorCode.contactInFlight =>
          'This customer is on a call right now. Wait for it to finish, then try again.',
        AgentRetryErrorCode.campaignNotRunning => callNeedsRunning,
        AgentRetryErrorCode.agentNotAvailable => callNeedsAvailable,
        AgentRetryErrorCode.outsideCallingHours => r.nextOpenAt == null
            ? 'It’s outside this campaign’s calling hours.'
            : 'It’s outside this campaign’s calling hours. Calls resume at ${formatDueAt(r.nextOpenAt!, now)}.',
        AgentRetryErrorCode.overrideNoteInvalid => 'The note needs $overrideNoteMin to $overrideNoteMax characters.',
        AgentRetryErrorCode.dncListed => 'This number is on the Do Not Call list. It can’t be called.',
        AgentRetryErrorCode.dncUnavailable =>
          'We couldn’t check the Do Not Call list just now, so the call wasn’t placed. Try again in a moment.',
        AgentRetryErrorCode.noCallerId => 'This campaign has no number to call from. Tell your supervisor.',
        AgentRetryErrorCode.noStation =>
          'Your phone isn’t connected to the station yet. Wait until it says Connected, then try again.',
        AgentRetryErrorCode.dialFailed =>
          'The call couldn’t be placed just now, and nothing was dialled. Try again in a moment.',
        AgentRetryErrorCode.featureDisabled => 'Calling is turned off for this account. Ask your admin.',
        AgentRetryErrorCode.unknown => r.message.isNotEmpty ? r.message : _fallback,
      };

  /// Any failure of an own-contact request, in words: a refusal through
  /// [refusal], anything else as the API layer words it.
  static String error(Object error, {required DateTime now, String fallback = _fallback}) {
    if (error is ApiHttpError) {
      final refusal = ErrorBody.fromJson(error.body).agentRetryRefusal;
      if (refusal != null) return MyContactsCopy.refusal(refusal, now: now);
    }
    if (error is ApiError) return error.userMessage;
    return fallback;
  }

  static const _fallback = 'That didn’t work. Try again.';
}

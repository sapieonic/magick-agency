import 'package:agency_wire/agency_wire.dart';

import '../../core/api/api_error.dart';
import '../../core/dnc/dnc_scope_words.dart';
import '../../ui/primitives.dart';
import '../calls/my_calls_copy.dart';
import '../missed/missed_calls_copy.dart';
import '../performance/logic/en_in_format.dart';
import '../performance/performance_api.dart' show errorMessage;

/// Customer history's words, the console's where both show the same thing
/// (`docs/customer-history.md` §5), in British English. Wire codes are never
/// respelled; only what people read is.
abstract final class CustomerHistoryCopy {
  static const searchTitle = 'Customer history';
  static const openSearch = 'Search a number';
  static const numberLabel = 'Mobile number';
  static const search = 'Search';
  static const countryLabel = 'Country';
  static const pickCountry = 'Pick the country of the number';

  /// The helper text under the box, always shown. [callingCode] is the picked
  /// country's, so India reads "+91".
  static String helper(String callingCode) =>
      'Type the full mobile number. You can include or leave out +$callingCode, spaces, dashes or a leading 0.';
  static const helperOtherCountry =
      'For a number from another country, pick the country or start with + and the country code.';

  /// The live preview: the number the search will run on, as the rule read it.
  static String preview(String formatted) => "We'll search for $formatted";

  static const recent = 'Recent searches on this device';
  static const clearRecent = 'Clear';

  static String resultsFor(String display) => 'Results for $display';
  static const copyNumber = 'Copy the number';
  static const numberCopied = 'Number copied';
  static const noResult = 'Search a number to see its history.';
  static const searchAgain = 'Search again';
  static const tryAgain = 'Try again';
  static const empty = 'No calls to or from this number in the accounts you can see';
  static const emptyBody =
      'Nobody has called this number from a campaign or the soft phone, it has not rung us, and it is not on any roster you can see.';

  static const expired = 'This search has expired. Search the number again.';
  static const searchFailed = "We couldn't search this number. Try again.";
  static const timelineFailed = "We couldn't load this history.";
  static const moreFailed = "We couldn't load any more of this history.";

  // The summary.
  static const liveNow = 'Live now';
  static String totalsLine(int calls, int connected) =>
      '$calls call${calls == 1 ? '' : 's'} placed · $connected connected';
  static const neverContacted = 'Never contacted';

  /// No call was placed to the number, but it has rung us.
  static const notCalledYet = 'We have not called this number';

  /// The calls the number made to us, apart from the calls placed (CL7, CL42).
  static String inboundTotalsLine(int calls, int answered) =>
      '$calls call${calls == 1 ? '' : 's'} received · $answered answered';
  static const lastContacted = 'Last contacted';
  static const dnc = 'Do not call';
  static const notOnDnc = 'Not on any do-not-call list';
  static const open = 'Open now';
  static const contacts = 'Who this number belongs to';
  static const noFields = 'No details on this row';
  static const pool = 'Shared pool';
  static String assignedTo(String name) => 'Assigned to $name';
  static const contactsTruncated =
      'This number is on more than 2,000 roster rows. This history covers the 2,000 most recent.';
  static String followUp(String when) => 'Follow-up $when';
  static const noFollowUp = 'No follow-up scheduled';

  // The timeline.
  static const history = 'History';
  static const all = 'All';
  static const campaignCalls = 'Campaign calls';
  static const softphoneCalls = 'Soft-phone calls';
  static const inboundCalls = 'Inbound calls';
  static const connectedOnly = 'Connected calls only';
  static const loadMore = 'Load more';
  static const endOfHistory = 'That is the whole history you can see.';
  static const noEntriesFiltered = 'Nothing in this history matches these filters.';
  static const notesHidden = 'Notes hidden';
  static const recordingExpired = 'Recording expired';
  static const recorded = 'Recording available';
  static const notRecorded = 'Not recorded';
  static const untagged = 'Not logged to a campaign';

  // An inbound call (`docs/call-log.md` CL39), in the Call log's words.
  static const noCampaign = MyCallsCopy.noCampaign;
  static const answered = 'Answered';
  static const missed = 'Missed';
  static const toFollowUp = 'To follow up';
  static const handled = 'Handled';
  static const customerReached = 'Customer reached';
  static const nobodyAnswered = 'Nobody answered';
  static String answeredBy(String name) => 'Answered by $name';
  static String followUpAssignedTo(String name) => 'assigned to $name';
  static String rang(String line, String? route) => route == null ? 'Rang $line' : 'Rang $line ($route)';
  static String voicemail(double seconds) => 'Voicemail ${EnIn.talkTime(seconds)}';
  static const notClassified = 'Not classified';
  static const unknownEntry = "Something this version of the app can't show yet";
  static String attempt(int n) => 'Attempt $n';
  static String wrapUpRedialOf(int n, String? firstAt) =>
      'Wrap-up redial $n of ${firstAt == null ? 'an earlier call' : 'the call at $firstAt'}';
  static String redialledInWrapUp(int n) => 'Redialled in wrap-up ${n == 1 ? 'once' : '$n times'}';
  static String overrideUsed(String what) => 'Override used: $what';
  static String dncOverride(String note) => 'Called despite do-not-call: “$note”';
  static String hoursOverride(String note) => 'Called outside calling hours: “$note”';

  // The filters (the console's `CustomerTimelineFiltersBar`).
  static const filters = 'Filters';
  static String filtersSet(int n) => 'Filters ($n)';
  static const filtersTitle = 'Filter the timeline';
  static const clearFilters = 'Clear filters';
  static const apply = 'Apply';
  static const campaign = 'Campaign';
  static const allCampaigns = 'All campaigns';
  static const unnamedCampaign = 'A campaign';
  static const from = 'From';
  static const to = 'To';
  static const anyDay = 'Any day';
  static String clearDay(String which) => 'Clear the $which day';
  static const outcome = 'Outcome';
  static const allOutcomes = 'All outcomes';
  static const outcomeCode = 'Outcome code';
  static const allCodes = 'All codes';
  static const agent = 'Agent';
  static const allAgents = 'All agents';
  static const dateOrder = 'The end date must be on or after the start date.';

  /// 429 from a search: the per-user cap (CH11). [retryAfter] is the body's
  /// `retryAfter`, in seconds.
  static String rateLimited(Object? retryAfter) =>
      "You've searched a lot of numbers in a short time. ${_retryWait(retryAfter)}";

  /// 429 from a timeline page: not the search cap (pages are not charged to
  /// it), so it does not blame searching.
  static String tooManyRequests(Object? retryAfter) => 'Too many requests in a short time. ${_retryWait(retryAfter)}';

  static String _retryWait(Object? retryAfter) {
    if (retryAfter is num && retryAfter.isFinite && retryAfter > 0) {
      final seconds = retryAfter.ceil();
      return 'Try again in $seconds second${seconds == 1 ? '' : 's'}.';
    }
    return 'Try again in a minute.';
  }
}

/// What a failed search or timeline read says to the agent: the rate limit
/// (a [timeline] page's in its own words), the number refusal (the server's
/// own words, else the shared rule's), an expired search, [fallback] for the
/// family's other refusals (their message is a validator's, not the agent's),
/// else the API's own message or [fallback].
String customerHistoryFailure(
  Object error, {
  required String fallback,
  SearchCountry? country,
  bool timeline = false,
}) {
  if (error is ApiHttpError) {
    if (error.status == 429) {
      final wait = error.body['retryAfter'];
      return timeline ? CustomerHistoryCopy.tooManyRequests(wait) : CustomerHistoryCopy.rateLimited(wait);
    }
    final refusal = CustomerHistoryRefusal.fromJson(error.body);
    switch (refusal.code) {
      case CustomerHistoryErrorCode.invalidNumber:
        if (refusal.message.isNotEmpty) return refusal.message;
        final why = refusal.numberError;
        if (why != null && !why.isUnknown) return searchNumberErrorMessage(why, country);
      case CustomerHistoryErrorCode.searchExpired:
        return CustomerHistoryCopy.expired;
      case CustomerHistoryErrorCode.invalidSearchRequest:
      case CustomerHistoryErrorCode.invalidCursor:
        return fallback;
      case CustomerHistoryErrorCode.unknown:
        break;
    }
  }
  return errorMessage(error, fallback);
}

/// Whether [error] is the server saying the search id is gone (`404
/// search_expired`): the page offers to search again.
bool isSearchExpired(Object error) =>
    error is ApiHttpError && CustomerHistoryRefusal.fromJson(error.body).code == CustomerHistoryErrorCode.searchExpired;

const contactStateLabels = <ContactState, String>{
  ContactState.pending: 'Waiting to be called',
  ContactState.inFlight: 'On a call',
  ContactState.connected: 'Connected',
  ContactState.completed: 'Completed',
  ContactState.exhausted: 'Out of tries',
  ContactState.suppressed: 'Not called any more',
};

/// A contact's state in the agent's words; a state this build does not know
/// is shown as sent.
String contactStateLabel(CustomerHistoryContact c) => contactStateLabels[c.state] ?? c.stateRaw;

Tone contactStateTone(ContactState state) => switch (state) {
  ContactState.inFlight => Tone.live,
  ContactState.connected || ContactState.completed => Tone.ok,
  ContactState.suppressed => Tone.danger,
  ContactState.exhausted => Tone.warn,
  _ => Tone.neutral,
};

const suppressedReasonLabels = <String, String>{
  'dnc': 'On a do-not-call list',
  'invalid': 'Invalid number',
  'max_attempts': 'Out of tries',
  'manual': 'Taken off the list',
};

const callbackStatusLabels = <CustomerCallbackStatus, String>{
  CustomerCallbackStatus.kept: 'Kept',
  CustomerCallbackStatus.keptLate: 'Dialled late',
  CustomerCallbackStatus.missed: 'Missed',
  CustomerCallbackStatus.upcoming: 'Upcoming',
  CustomerCallbackStatus.due: 'Due now',
};

Tone callbackStatusTone(CustomerCallbackStatus status) => switch (status) {
  CustomerCallbackStatus.kept => Tone.ok,
  CustomerCallbackStatus.keptLate => Tone.warn,
  CustomerCallbackStatus.missed => Tone.danger,
  CustomerCallbackStatus.due => Tone.live,
  _ => Tone.neutral,
};

/// What a campaign call spent, in the console's words (`overrideAppliedLabel`).
const overrideKindLabels = <OverrideKind, String>{
  OverrideKind.extraAttempts: 'extra attempt',
  OverrideKind.retryDelay: 'retry delay waived',
  OverrideKind.callingHours: 'calling hours waived',
};

/// `extra attempt, retry delay waived`; a kind this build does not know as sent.
String overrideAppliedLabel(CustomerTimelineCampaignCall c) => [
  for (var i = 0; i < c.overrideApplied.length; i++)
    overrideKindLabels[c.overrideApplied[i]] ?? c.overrideAppliedRaw[i],
].join(', ');

/// What an unspent override grants (`overrideGrantLabel`): `2 extra attempts, retry delay waived`.
String overrideGrantLabel(CustomerHistoryOpenOverride o) {
  final parts = [
    if (o.extraAttempts > 0) '${o.extraAttempts} extra ${o.extraAttempts == 1 ? 'attempt' : 'attempts'}',
    if (o.retryDelay) 'retry delay waived',
    if (o.callingHours) 'calling hours waived',
  ];
  return parts.isEmpty ? 'no extra allowance' : parts.join(', ');
}

/// A campaign's status in the console's words (`AgencyCampaignStatusBadge`).
const campaignStatusLabels = <CampaignStatus, String>{
  CampaignStatus.draft: 'Draft',
  CampaignStatus.running: 'Running',
  CampaignStatus.paused: 'Paused',
  CampaignStatus.stopping: 'Stopping',
  CampaignStatus.stopped: 'Stopped',
  CampaignStatus.completed: 'Completed',
};

String campaignStatusLabel(CustomerHistoryCampaign c) => campaignStatusLabels[c.status] ?? c.statusRaw;

Tone campaignStatusTone(CampaignStatus status) => switch (status) {
  CampaignStatus.running => Tone.ok,
  CampaignStatus.paused || CampaignStatus.stopping => Tone.warn,
  _ => Tone.neutral,
};

/// A soft-phone call field's value (`fieldValueLabel`): `--` for none, Yes or No.
String fieldValueLabel(Object? value) => switch (value) {
  null => '--',
  true => 'Yes',
  false => 'No',
  final double d when d.isFinite && d == d.truncateToDouble() => d.toInt().toString(),
  _ => '$value',
};

/// Where a DNC entry applies, in the words every surface uses ([dncScopeWords], DS7):
/// `Every campaign`, `North account`, `Campaign: October dues (North)` (the history spans
/// accounts, so a campaign entry adds its account, and an account entry whose name is not
/// known is `An account`, not `This account`: it may be another of the caller's accounts).
/// An unknown scope (a newer server) is named as [dncScopeWords] names it, never by its code.
String dncScopeLabel(CustomerHistoryDncEntry e) => switch (e.scope) {
  DncEntryScope.account when (e.accountName?.trim() ?? '').isEmpty => 'An account',
  DncEntryScope.campaign => dncScopeWords(e.scope, campaignName: e.campaign?.name, unnamedCampaign: 'A campaign') +
      (e.accountName == null ? '' : ' (${e.accountName})'),
  _ => dncScopeWords(e.scope, accountName: e.accountName),
};

/// A person's name, "A former user" when the user row has no name, or [none] for no one.
String personName(CustomerHistoryUser? u, {String none = 'Nobody'}) =>
    u == null ? none : (u.name ?? 'A former user');

/// Why an inbound call was missed, in the Missed list's words, lower case to
/// sit after "Missed": the reason, or for a closed call the cause when it was
/// not the hours; then the wait when the caller queued ("nobody free to
/// answer · waited 1:40", "hung up while waiting · 0:52").
String inboundMissedWhy(CustomerTimelineInboundCall c) {
  final followUp = c.followUp;
  if (followUp == null) return '';
  final label = followUp.reason == InboundMissedReason.closed
      ? switch (followUp.closedCause) {
          InboundClosedCause.switchedOff => 'Inbound switched off',
          InboundClosedCause.noRoute => 'Number not on a route',
          InboundClosedCause.credentialInactive => 'Phone line not active',
          _ => MissedCopy.reasonLabel(followUp.reason, followUp.reasonRaw),
        }
      : MissedCopy.reasonLabel(followUp.reason, followUp.reasonRaw);
  final reason = label.isEmpty ? label : '${label[0].toLowerCase()}${label.substring(1)}';
  final waited = !c.queued
      ? null
      : followUp.reason == InboundMissedReason.abandonedInQueue
          ? EnIn.talkTime(c.waitSeconds.toDouble())
          : 'waited ${EnIn.talkTime(c.waitSeconds.toDouble())}';
  return [reason, ?waited].join(' · ');
}

/// What happened on an inbound call (the console's `inboundWhatHappened`):
/// "Answered · waited 0:18 · came through their agent", or "Missed · " and why.
String inboundHappenedLine(CustomerTimelineInboundCall c) {
  if (!c.missed) {
    return [
      CustomerHistoryCopy.answered,
      'waited ${EnIn.talkTime(c.waitSeconds.toDouble())}',
      if (c.viaStickyAgent) 'came through their agent',
    ].join(' · ');
  }
  final why = inboundMissedWhy(c);
  return why.isEmpty ? CustomerHistoryCopy.missed : '${CustomerHistoryCopy.missed} · $why';
}

/// Who answered, or that nobody did and who has the call.
String inboundAgentLine(CustomerTimelineInboundCall c) {
  if (c.agent != null) return CustomerHistoryCopy.answeredBy(personName(c.agent));
  final assignee = c.followUp?.assignee;
  return assignee == null
      ? CustomerHistoryCopy.nobodyAnswered
      : '${CustomerHistoryCopy.nobodyAnswered} · ${CustomerHistoryCopy.followUpAssignedTo(personName(assignee))}';
}

/// Where a missed call's follow-up stands (the console's `followUpWords`):
/// "Called back 3:31 PM" (the time alone on the call's own day), "To follow
/// up" while it is open, else how it was closed unless the call back says so.
String? inboundFollowUpLine(CustomerTimelineInboundCall c) {
  final back = c.calledBackAt;
  final calledBack = back == null ? null : 'Called back ${MyCallsCopy.when(back, c.at)}';
  final followUp = c.followUp;
  if (followUp == null) return calledBack;
  if (followUp.status == InboundFollowUpStatus.open) {
    return [CustomerHistoryCopy.toFollowUp, ?calledBack].join(' · ');
  }
  return calledBack ??
      (followUp.handledReason == InboundHandledReason.reached
          ? CustomerHistoryCopy.customerReached
          : CustomerHistoryCopy.handled);
}

/// Whether the call is still owed a call back.
bool inboundToFollowUp(CustomerTimelineInboundCall c) => c.followUp?.status == InboundFollowUpStatus.open;

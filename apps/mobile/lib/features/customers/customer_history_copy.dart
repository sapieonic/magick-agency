import 'package:agency_wire/agency_wire.dart';

import '../../core/api/api_error.dart';
import '../../ui/primitives.dart';
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

  static const recent = 'Recent searches';
  static const clearRecent = 'Clear';

  static String resultsFor(String display) => 'Results for $display';
  static const noResult = 'Search a number to see its history.';
  static const searchAgain = 'Search again';
  static const empty = 'No calls to this number in the accounts you can see';
  static const emptyBody = 'It is not in any campaign you can see, and nobody here has called it.';

  static const expired = 'This search has expired. Search the number again.';
  static const searchFailed = "We couldn't search this number. Try again.";
  static const timelineFailed = "We couldn't load this history.";
  static const moreFailed = "We couldn't load any more of this history.";

  // The summary.
  static const liveNow = 'On a call now';
  static const totals = 'Calls';
  static String totalsLine(int calls, int connected) =>
      '$calls call${calls == 1 ? '' : 's'} placed · $connected connected';
  static const neverContacted = 'Never contacted';
  static const lastContacted = 'Last contacted';
  static const dnc = 'Do not call';
  static const notOnDnc = 'Not on any do-not-call list';
  static const open = 'Open';
  static const contacts = 'In campaigns';
  static const noFields = 'No details on this row';
  static const pool = 'Shared pool';

  // The timeline.
  static const history = 'History';
  static const all = 'All';
  static const campaignCalls = 'Campaign calls';
  static const softphoneCalls = 'Soft-phone calls';
  static const connectedOnly = 'Connected only';
  static const loadMore = 'Load more';
  static const endOfHistory = 'That is the whole history you can see.';
  static const noEntriesFiltered = 'Nothing matches these filters.';
  static const notesHidden = 'Notes hidden';
  static const recordingExpired = 'Recording expired';
  static const recorded = 'Recorded';
  static const notRecorded = 'Not recorded';
  static const untagged = 'Not logged to a campaign';
  static const notClassified = 'Not classified';
  static const unknownEntry = "Something this version of the app can't show yet";

  /// 429 from the search: the per-user cap (CH11). [retryAfter] is the body's
  /// `retryAfter`, in seconds.
  static String rateLimited(Object? retryAfter) {
    const lead = "You've searched a lot of numbers in a short time.";
    if (retryAfter is num && retryAfter.isFinite && retryAfter > 0) {
      final seconds = retryAfter.ceil();
      return '$lead Try again in $seconds second${seconds == 1 ? '' : 's'}.';
    }
    return '$lead Try again in a minute.';
  }
}

/// What a failed search or timeline read says to the agent: the rate limit,
/// the number refusal (the server's own words, else the shared rule's), an
/// expired search, else the API's own message or [fallback].
String customerHistoryFailure(Object error, {required String fallback, SearchCountry? country}) {
  if (error is ApiHttpError) {
    if (error.status == 429) return CustomerHistoryCopy.rateLimited(error.body['retryAfter']);
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

const overrideKindLabels = <OverrideKind, String>{
  OverrideKind.extraAttempts: 'Extra tries',
  OverrideKind.retryDelay: 'Called early',
  OverrideKind.callingHours: 'Outside calling hours',
};

/// Where a DNC entry applies: `All accounts`, `Account: North`, `Campaign: October dues`.
String dncScopeLabel(CustomerHistoryDncEntry e) => switch (e.scope) {
  DncEntryScope.tenant => 'All accounts',
  DncEntryScope.account => 'Account: ${e.accountName ?? 'an account'}',
  DncEntryScope.campaign => 'Campaign: ${e.campaign?.name ?? 'a campaign'}',
  DncEntryScope.unknown => e.scopeRaw,
};

/// A person's name, "Someone" when the user row is gone, or [none] for no one.
String personName(CustomerHistoryUser? u, {String none = 'Nobody'}) => u == null ? none : (u.name ?? 'Someone');

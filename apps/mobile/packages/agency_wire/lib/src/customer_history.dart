/// Customer history: search one phone number and see every interaction with
/// it across the tenant's campaigns and the soft phone, in the accounts the
/// caller can see.
///
/// Contract: `packages/contracts/src/api/agency/customer-history.ts`
/// (`docs/customer-history.md`, decisions CH1–CH12).
///
/// | Route | Body | Answer |
/// |---|---|---|
/// | `POST /proxy/agency/customers/search` | [CustomerSearchRequest] | [CustomerSearchResponse] |
/// | `POST /proxy/agency/customers/timeline` | [CustomerTimelineRequest] | [CustomerTimelinePage] |
/// | `GET /proxy/agency/customers/options` | — | [CustomerSearchOptionsResponse] |
///
/// The number never travels in a URL: the search is a `POST` with the raw
/// text in the body, and the timeline pages name the search by the opaque
/// `search_id` it answers (CH6). The export is the console's only.
///
/// An agent never gets a call page (`call_page` is null, CH8), and may get a
/// call's notes hidden (`notes` null, `notes_hidden` true).
library;

import 'package:meta/meta.dart';

import 'enums.dart';
import 'equality.dart';
import 'json.dart';

/// `CUSTOMER_TIMELINE_PAGE_SIZE`: the server's default page.
const customerTimelinePageSize = 50;

/// `CUSTOMER_TIMELINE_PAGE_MAX`: the largest `limit` the server takes.
const customerTimelinePageMax = 100;

/// `CUSTOMER_SEARCH_VALUE_MAX`: the longest raw search text the server reads.
const customerSearchValueMax = 64;

// ─── The requests ───────────────────────────────────────────────────────────

/// `POST /proxy/agency/customers/search`. [value] is the raw text as typed
/// (`098765-43210`, `+91 98765 43210`); the server cleans it with the same
/// rule as the app's preview (`parseSearchNumber`).
///
/// Contract: `CustomerSearchRequest`.
@immutable
final class CustomerSearchRequest {
  const CustomerSearchRequest({this.by = CustomerSearchBy.phone, required this.value, this.country});

  final CustomerSearchBy by;
  final String value;

  /// ISO 3166-1 alpha-2 of the country picked next to the box; null = the
  /// platform default (the only way to name a default the picker does not
  /// list, which has no ISO entry).
  final String? country;

  Map<String, Object?> toJson() => <String, Object?>{
    'by': by.wire,
    'value': value,
    'country': ?country,
  };

  @override
  bool operator ==(Object other) =>
      other is CustomerSearchRequest && other.by == by && other.value == value && other.country == country;

  @override
  int get hashCode => Object.hash(by, value, country);

  /// Never prints [value]: it is a customer's number.
  @override
  String toString() => 'CustomerSearchRequest(${by.wire}, country: $country)';
}

/// The timeline's filters. [campaignIds] names ROOT campaigns (a retry
/// campaign is filtered with its parent, CH7). [from] / [to] are half-open on
/// the entry's time. The call-only filters ([outcomes], [dispositionCodes],
/// [agentUserIds], [connectedOnly], [channel]) keep only call entries.
///
/// Contract: `CustomerTimelineFilters`. A null field is left out of the body.
@immutable
final class CustomerTimelineFilters {
  CustomerTimelineFilters({
    List<String>? campaignIds,
    this.from,
    this.to,
    List<AttemptOutcome>? outcomes,
    List<String>? dispositionCodes,
    List<String>? agentUserIds,
    this.connectedOnly,
    this.channel,
  }) : campaignIds = campaignIds == null ? null : List.unmodifiable(campaignIds),
       outcomes = outcomes == null ? null : List.unmodifiable(outcomes),
       dispositionCodes = dispositionCodes == null ? null : List.unmodifiable(dispositionCodes),
       agentUserIds = agentUserIds == null ? null : List.unmodifiable(agentUserIds);

  /// No filter at all: the whole history.
  static final none = CustomerTimelineFilters();

  final List<String>? campaignIds;
  final DateTime? from;
  final DateTime? to;

  /// The app sends any [AttemptOutcome] but `unknown`.
  final List<AttemptOutcome>? outcomes;
  final List<String>? dispositionCodes;
  final List<String>? agentUserIds;
  final bool? connectedOnly;

  /// The app sends any [CustomerTimelineChannel] but `unknown`.
  final CustomerTimelineChannel? channel;

  /// Whether nothing is filtered.
  bool get isEmpty =>
      campaignIds == null &&
      from == null &&
      to == null &&
      outcomes == null &&
      dispositionCodes == null &&
      agentUserIds == null &&
      connectedOnly == null &&
      channel == null;

  Map<String, Object?> toJson() => <String, Object?>{
    'campaign_ids': ?campaignIds,
    if (from != null) 'from': isoUtc(from!),
    if (to != null) 'to': isoUtc(to!),
    if (outcomes != null) 'outcomes': [for (final o in outcomes!) o.wire],
    'disposition_codes': ?dispositionCodes,
    'agent_user_ids': ?agentUserIds,
    'connected_only': ?connectedOnly,
    if (channel != null) 'channel': channel!.wire,
  };

  @override
  bool operator ==(Object other) =>
      other is CustomerTimelineFilters &&
      listEquals(other.campaignIds, campaignIds) &&
      other.from == from &&
      other.to == to &&
      listEquals(other.outcomes, outcomes) &&
      listEquals(other.dispositionCodes, dispositionCodes) &&
      listEquals(other.agentUserIds, agentUserIds) &&
      other.connectedOnly == connectedOnly &&
      other.channel == channel;

  @override
  int get hashCode => Object.hash(
    listHash(campaignIds),
    from,
    to,
    listHash(outcomes),
    listHash(dispositionCodes),
    listHash(agentUserIds),
    connectedOnly,
    channel,
  );
}

/// `POST /proxy/agency/customers/timeline`: a later page, or the first page
/// under new filters.
///
/// Contract: `CustomerTimelineRequest`.
@immutable
final class CustomerTimelineRequest {
  const CustomerTimelineRequest({required this.searchId, this.filters, this.cursor, this.limit});

  final String searchId;
  final CustomerTimelineFilters? filters;

  /// The previous page's `next_cursor`; null for the first page.
  final String? cursor;

  /// 1..[customerTimelinePageMax]; null = [customerTimelinePageSize].
  final int? limit;

  Map<String, Object?> toJson() => <String, Object?>{
    'search_id': searchId,
    if (filters != null) 'filters': filters!.toJson(),
    'cursor': ?cursor,
    'limit': ?limit,
  };

  @override
  bool operator ==(Object other) =>
      other is CustomerTimelineRequest &&
      other.searchId == searchId &&
      other.filters == filters &&
      other.cursor == cursor &&
      other.limit == limit;

  @override
  int get hashCode => Object.hash(searchId, filters, cursor, limit);
}

// ─── Refusals ───────────────────────────────────────────────────────────────

/// The body of a customer-history refusal: `{error, code, message,
/// number_error?}`.
///
/// Contract: `CustomerHistoryErrorResponse`. [CustomerHistoryRefusal.fromJson]
/// **never throws**: it is read on the failure path.
@immutable
final class CustomerHistoryRefusal {
  CustomerHistoryRefusal({required this.error, this.codeRaw, required this.message, this.numberErrorRaw})
    : code = CustomerHistoryErrorCode.fromWire(codeRaw),
      numberError = numberErrorRaw == null ? null : CustomerSearchNumberError.fromWire(numberErrorRaw);

  factory CustomerHistoryRefusal.fromJson(Map<String, Object?> j) {
    String? text(String k) => j[k] is String ? j[k]! as String : null;
    return CustomerHistoryRefusal(
      error: text('error') ?? '',
      codeRaw: text('code'),
      message: text('message') ?? '',
      numberErrorRaw: text('number_error'),
    );
  }

  /// Short title, e.g. `Bad Request`. Empty when the body had none.
  final String error;

  /// [codeRaw] as a customer-history code; `unknown` when absent or another
  /// family's code (a rate limit, a permission refusal).
  final CustomerHistoryErrorCode code;
  final String? codeRaw;

  /// A sentence for people. Empty when the body had none.
  final String message;

  /// With `invalid_number` only.
  final CustomerSearchNumberError? numberError;
  final String? numberErrorRaw;

  @override
  bool operator ==(Object other) =>
      other is CustomerHistoryRefusal &&
      other.error == error &&
      other.codeRaw == codeRaw &&
      other.message == message &&
      other.numberErrorRaw == numberErrorRaw;

  @override
  int get hashCode => Object.hash(error, codeRaw, message, numberErrorRaw);

  @override
  String toString() => 'CustomerHistoryRefusal($codeRaw, $numberErrorRaw)';
}

// ─── Shared pieces ──────────────────────────────────────────────────────────

/// A person in the tenant (an agent, a contact's owner, who booked a callback).
///
/// Contract: `CustomerHistoryUser`.
@immutable
final class CustomerHistoryUser {
  const CustomerHistoryUser({required this.userId, this.name});

  factory CustomerHistoryUser.fromJson(Map<String, Object?> j) =>
      CustomerHistoryUser(userId: j.str('user_id'), name: j.strOrNull('name'));

  final String userId;

  /// Null when the user row is gone.
  final String? name;

  @override
  bool operator ==(Object other) => other is CustomerHistoryUser && other.userId == userId && other.name == name;

  @override
  int get hashCode => Object.hash(userId, name);
}

CustomerHistoryUser? _userOrNull(Map<String, Object?> j, String k) {
  final o = j.objOrNull(k);
  return o == null ? null : CustomerHistoryUser.fromJson(o);
}

/// A campaign as the history names it. A retry campaign carries its chain's
/// root.
///
/// Contract: `CustomerHistoryCampaign`.
@immutable
final class CustomerHistoryCampaign {
  CustomerHistoryCampaign({
    required this.id,
    required this.name,
    required this.status,
    String? statusRaw,
    required this.accountId,
    required this.rootId,
    required this.retryGeneration,
  }) : statusRaw = statusRaw ?? status.wire;

  factory CustomerHistoryCampaign.fromJson(Map<String, Object?> j) {
    final status = j.str('status');
    return CustomerHistoryCampaign(
      id: j.str('id'),
      name: j.str('name'),
      status: CampaignStatus.fromWire(status),
      statusRaw: status,
      accountId: j.str('account_id'),
      rootId: j.str('root_id'),
      retryGeneration: j.integer('retry_generation'),
    );
  }

  final String id;
  final String name;
  final CampaignStatus status;
  final String statusRaw;
  final String accountId;

  /// The first campaign of its retry chain (itself for an original campaign).
  final String rootId;

  /// 0 for an original campaign, 1 for its first retry, …
  final int retryGeneration;

  @override
  bool operator ==(Object other) =>
      other is CustomerHistoryCampaign &&
      other.id == id &&
      other.name == name &&
      other.statusRaw == statusRaw &&
      other.accountId == accountId &&
      other.rootId == rootId &&
      other.retryGeneration == retryGeneration;

  @override
  int get hashCode => Object.hash(id, name, statusRaw, accountId, rootId, retryGeneration);
}

CustomerHistoryCampaign? _campaignOrNull(Map<String, Object?> j, String k) {
  final o = j.objOrNull(k);
  return o == null ? null : CustomerHistoryCampaign.fromJson(o);
}

/// A campaign named by id and name only: a DNC entry's campaign (`name` null
/// when the row is gone) and a filter option.
///
/// Contract: `CustomerHistoryDncEntry['campaign']` and
/// `CustomerHistorySummary['filter_options']['campaigns'][number]`.
@immutable
final class CustomerHistoryCampaignName {
  const CustomerHistoryCampaignName({required this.id, this.name});

  factory CustomerHistoryCampaignName.fromJson(Map<String, Object?> j) =>
      CustomerHistoryCampaignName(id: j.str('id'), name: j.strOrNull('name'));

  final String id;
  final String? name;

  @override
  bool operator ==(Object other) => other is CustomerHistoryCampaignName && other.id == id && other.name == name;

  @override
  int get hashCode => Object.hash(id, name);
}

/// One column of a roster row, as the campaign displays it.
///
/// Contract: `CustomerHistoryField`.
@immutable
final class CustomerHistoryField {
  const CustomerHistoryField({required this.column, required this.value});

  factory CustomerHistoryField.fromJson(Map<String, Object?> j) =>
      CustomerHistoryField(column: j.str('column'), value: j.str('value'));

  final String column;
  final String value;

  @override
  bool operator ==(Object other) => other is CustomerHistoryField && other.column == column && other.value == value;

  @override
  int get hashCode => Object.hash(column, value);
}

// ─── The summary ────────────────────────────────────────────────────────────

/// One roster row carrying the number: who the number belongs to in that
/// campaign. Several people on one number are several rows; a contact and its
/// retry copies are ONE row (CH7).
///
/// Contract: `CustomerHistoryContact`.
@immutable
final class CustomerHistoryContact {
  CustomerHistoryContact({
    required this.contactId,
    required this.rootContactId,
    required this.accountId,
    this.accountName,
    required this.phoneE164,
    required this.campaign,
    required List<CustomerHistoryCampaign> campaigns,
    required this.state,
    String? stateRaw,
    this.suppressedReason,
    required this.attemptCount,
    required List<CustomerHistoryField> fields,
    this.assignedTo,
    required this.enteredAt,
    this.uploadFileName,
  }) : campaigns = List.unmodifiable(campaigns),
       fields = List.unmodifiable(fields),
       stateRaw = stateRaw ?? state.wire;

  factory CustomerHistoryContact.fromJson(Map<String, Object?> j) {
    final state = j.str('state');
    return CustomerHistoryContact(
      contactId: j.str('contact_id'),
      rootContactId: j.str('root_contact_id'),
      accountId: j.str('account_id'),
      accountName: j.strOrNull('account_name'),
      phoneE164: j.str('phone_e164'),
      campaign: CustomerHistoryCampaign.fromJson(j.obj('campaign')),
      campaigns: j.list('campaigns', CustomerHistoryCampaign.fromJson),
      state: ContactState.fromWire(state),
      stateRaw: state,
      suppressedReason: j.strOrNull('suppressed_reason'),
      attemptCount: j.integer('attempt_count'),
      fields: j.list('fields', CustomerHistoryField.fromJson),
      assignedTo: _userOrNull(j, 'assigned_to'),
      enteredAt: j.time('entered_at'),
      uploadFileName: j.strOrNull('upload_file_name'),
    );
  }

  /// The newest row of the chain.
  final String contactId;
  final String rootContactId;
  final String accountId;
  final String? accountName;
  final String phoneE164;

  /// The newest campaign of the chain the contact is in.
  final CustomerHistoryCampaign campaign;

  /// Every campaign of the chain the contact appears in, oldest first.
  final List<CustomerHistoryCampaign> campaigns;
  final ContactState state;
  final String stateRaw;

  /// `dnc | invalid | max_attempts | manual` when [state] is `suppressed`.
  final String? suppressedReason;

  /// Placed calls across the chain.
  final int attemptCount;

  /// The row's hero columns, else its first columns.
  final List<CustomerHistoryField> fields;

  /// The agent the contact is assigned to; null = the shared pool.
  final CustomerHistoryUser? assignedTo;

  /// When the number entered the chain's first campaign.
  final DateTime enteredAt;

  /// The roster upload the row most likely came from; null when none matches.
  final String? uploadFileName;

  @override
  bool operator ==(Object other) =>
      other is CustomerHistoryContact &&
      other.contactId == contactId &&
      other.rootContactId == rootContactId &&
      other.accountId == accountId &&
      other.accountName == accountName &&
      other.phoneE164 == phoneE164 &&
      other.campaign == campaign &&
      listEquals(other.campaigns, campaigns) &&
      other.stateRaw == stateRaw &&
      other.suppressedReason == suppressedReason &&
      other.attemptCount == attemptCount &&
      listEquals(other.fields, fields) &&
      other.assignedTo == assignedTo &&
      other.enteredAt == enteredAt &&
      other.uploadFileName == uploadFileName;

  @override
  int get hashCode => Object.hash(
    contactId,
    rootContactId,
    accountId,
    accountName,
    phoneE164,
    campaign,
    listHash(campaigns),
    stateRaw,
    suppressedReason,
    attemptCount,
    listHash(fields),
    assignedTo,
    enteredAt,
    uploadFileName,
  );
}

/// A DNC entry that covers the number, at its level. [source] is the
/// console's `DncSource` (`agent | import | api | ...`), kept as sent.
///
/// Contract: `CustomerHistoryDncEntry`.
@immutable
final class CustomerHistoryDncEntry {
  CustomerHistoryDncEntry({
    required this.id,
    required this.scope,
    String? scopeRaw,
    this.accountId,
    this.accountName,
    this.campaign,
    required this.source,
    this.reason,
    this.addedBy,
    required this.createdAt,
  }) : scopeRaw = scopeRaw ?? scope.wire;

  factory CustomerHistoryDncEntry.fromJson(Map<String, Object?> j) {
    final scope = j.str('scope');
    final campaign = j.objOrNull('campaign');
    return CustomerHistoryDncEntry(
      id: j.str('id'),
      scope: DncEntryScope.fromWire(scope),
      scopeRaw: scope,
      accountId: j.strOrNull('account_id'),
      accountName: j.strOrNull('account_name'),
      campaign: campaign == null ? null : CustomerHistoryCampaignName.fromJson(campaign),
      source: j.str('source'),
      reason: j.strOrNull('reason'),
      addedBy: j.strOrNull('added_by'),
      createdAt: j.time('created_at'),
    );
  }

  final String id;
  final DncEntryScope scope;
  final String scopeRaw;
  final String? accountId;
  final String? accountName;
  final CustomerHistoryCampaignName? campaign;
  final String source;

  /// Null when there was none, or the caller may not see it (CH8).
  final String? reason;

  /// Who added it; null when the caller may not see it (CH8).
  final String? addedBy;
  final DateTime createdAt;

  @override
  bool operator ==(Object other) =>
      other is CustomerHistoryDncEntry &&
      other.id == id &&
      other.scopeRaw == scopeRaw &&
      other.accountId == accountId &&
      other.accountName == accountName &&
      other.campaign == campaign &&
      other.source == source &&
      other.reason == reason &&
      other.addedBy == addedBy &&
      other.createdAt == createdAt;

  @override
  int get hashCode =>
      Object.hash(id, scopeRaw, accountId, accountName, campaign, source, reason, addedBy, createdAt);
}

/// A callback booked and not yet dialled.
///
/// Contract: `CustomerHistoryOpenCallback`.
@immutable
final class CustomerHistoryOpenCallback {
  const CustomerHistoryOpenCallback({
    required this.contactId,
    required this.campaign,
    required this.dueAt,
    this.owner,
    this.bookedBy,
    this.dispositionCode,
  });

  factory CustomerHistoryOpenCallback.fromJson(Map<String, Object?> j) => CustomerHistoryOpenCallback(
    contactId: j.str('contact_id'),
    campaign: CustomerHistoryCampaign.fromJson(j.obj('campaign')),
    dueAt: j.time('due_at'),
    owner: _userOrNull(j, 'owner'),
    bookedBy: _userOrNull(j, 'booked_by'),
    dispositionCode: j.strOrNull('disposition_code'),
  );

  final String contactId;
  final CustomerHistoryCampaign campaign;
  final DateTime dueAt;

  /// Who the callback is routed to first; null = the pool.
  final CustomerHistoryUser? owner;
  final CustomerHistoryUser? bookedBy;
  final String? dispositionCode;

  @override
  bool operator ==(Object other) =>
      other is CustomerHistoryOpenCallback &&
      other.contactId == contactId &&
      other.campaign == campaign &&
      other.dueAt == dueAt &&
      other.owner == owner &&
      other.bookedBy == bookedBy &&
      other.dispositionCode == dispositionCode;

  @override
  int get hashCode => Object.hash(contactId, campaign, dueAt, owner, bookedBy, dispositionCode);
}

/// An outcome that granted the contact an override (Promise To Pay and the
/// like), not yet spent.
///
/// Contract: `CustomerHistoryOpenOverride`.
@immutable
final class CustomerHistoryOpenOverride {
  const CustomerHistoryOpenOverride({
    required this.contactId,
    required this.campaign,
    required this.dispositionCode,
    required this.grantedAt,
    this.followUpAt,
    required this.extraAttempts,
    required this.retryDelay,
    required this.callingHours,
  });

  factory CustomerHistoryOpenOverride.fromJson(Map<String, Object?> j) => CustomerHistoryOpenOverride(
    contactId: j.str('contact_id'),
    campaign: CustomerHistoryCampaign.fromJson(j.obj('campaign')),
    dispositionCode: j.str('disposition_code'),
    grantedAt: j.time('granted_at'),
    followUpAt: j.timeOrNull('follow_up_at'),
    extraAttempts: j.integer('extra_attempts'),
    retryDelay: j.boolean('retry_delay'),
    callingHours: j.boolean('calling_hours'),
  );

  final String contactId;
  final CustomerHistoryCampaign campaign;
  final String dispositionCode;
  final DateTime grantedAt;

  /// The follow-up: when the contact is next due to be dialled
  /// (`next_attempt_at`); null when none is scheduled.
  final DateTime? followUpAt;
  final int extraAttempts;
  final bool retryDelay;
  final bool callingHours;

  @override
  bool operator ==(Object other) =>
      other is CustomerHistoryOpenOverride &&
      other.contactId == contactId &&
      other.campaign == campaign &&
      other.dispositionCode == dispositionCode &&
      other.grantedAt == grantedAt &&
      other.followUpAt == followUpAt &&
      other.extraAttempts == extraAttempts &&
      other.retryDelay == retryDelay &&
      other.callingHours == callingHours;

  @override
  int get hashCode =>
      Object.hash(contactId, campaign, dispositionCode, grantedAt, followUpAt, extraAttempts, retryDelay, callingHours);
}

/// A call to the number live right now.
///
/// Contract: `CustomerHistoryLiveCall`.
@immutable
final class CustomerHistoryLiveCall {
  CustomerHistoryLiveCall({
    required this.channel,
    String? channelRaw,
    this.campaign,
    this.agent,
    required this.startedAt,
  }) : channelRaw = channelRaw ?? channel.wire;

  factory CustomerHistoryLiveCall.fromJson(Map<String, Object?> j) {
    final channel = j.str('channel');
    return CustomerHistoryLiveCall(
      channel: CustomerTimelineChannel.fromWire(channel),
      channelRaw: channel,
      campaign: _campaignOrNull(j, 'campaign'),
      agent: _userOrNull(j, 'agent'),
      startedAt: j.time('started_at'),
    );
  }

  final CustomerTimelineChannel channel;
  final String channelRaw;
  final CustomerHistoryCampaign? campaign;
  final CustomerHistoryUser? agent;
  final DateTime startedAt;

  @override
  bool operator ==(Object other) =>
      other is CustomerHistoryLiveCall &&
      other.channelRaw == channelRaw &&
      other.campaign == campaign &&
      other.agent == agent &&
      other.startedAt == startedAt;

  @override
  int get hashCode => Object.hash(channelRaw, campaign, agent, startedAt);
}

/// The newest placed call to the number.
///
/// Contract: `CustomerHistoryTotals['last_contacted']`.
@immutable
final class CustomerHistoryLastContacted {
  CustomerHistoryLastContacted({
    required this.at,
    required this.channel,
    String? channelRaw,
    this.agent,
    this.outcome,
    String? outcomeRaw,
    this.dispositionCode,
  }) : channelRaw = channelRaw ?? channel.wire,
       outcomeRaw = outcomeRaw ?? outcome?.wire;

  factory CustomerHistoryLastContacted.fromJson(Map<String, Object?> j) {
    final channel = j.str('channel');
    final outcome = j.strOrNull('outcome');
    return CustomerHistoryLastContacted(
      at: j.time('at'),
      channel: CustomerTimelineChannel.fromWire(channel),
      channelRaw: channel,
      agent: _userOrNull(j, 'agent'),
      outcome: outcome == null ? null : AttemptOutcome.fromWire(outcome),
      outcomeRaw: outcome,
      dispositionCode: j.strOrNull('disposition_code'),
    );
  }

  final DateTime at;
  final CustomerTimelineChannel channel;
  final String channelRaw;
  final CustomerHistoryUser? agent;
  final AttemptOutcome? outcome;
  final String? outcomeRaw;
  final String? dispositionCode;

  @override
  bool operator ==(Object other) =>
      other is CustomerHistoryLastContacted &&
      other.at == at &&
      other.channelRaw == channelRaw &&
      other.agent == agent &&
      other.outcomeRaw == outcomeRaw &&
      other.dispositionCode == dispositionCode;

  @override
  int get hashCode => Object.hash(at, channelRaw, agent, outcomeRaw, dispositionCode);
}

/// Calls placed (campaign and soft phone), connected, and the last contact.
///
/// Contract: `CustomerHistoryTotals`.
@immutable
final class CustomerHistoryTotals {
  const CustomerHistoryTotals({required this.calls, required this.connected, this.lastContacted});

  factory CustomerHistoryTotals.fromJson(Map<String, Object?> j) {
    final last = j.objOrNull('last_contacted');
    return CustomerHistoryTotals(
      calls: j.integer('calls'),
      connected: j.integer('connected'),
      lastContacted: last == null ? null : CustomerHistoryLastContacted.fromJson(last),
    );
  }

  final int calls;
  final int connected;
  final CustomerHistoryLastContacted? lastContacted;

  @override
  bool operator ==(Object other) =>
      other is CustomerHistoryTotals &&
      other.calls == calls &&
      other.connected == connected &&
      other.lastContacted == lastContacted;

  @override
  int get hashCode => Object.hash(calls, connected, lastContacted);
}

/// What is open on the number right now.
///
/// Contract: `CustomerHistorySummary['open']`.
@immutable
final class CustomerHistoryOpen {
  CustomerHistoryOpen({
    required List<CustomerHistoryOpenCallback> callbacks,
    required List<CustomerHistoryOpenOverride> overrides,
    required List<CustomerHistoryLiveCall> liveCalls,
  }) : callbacks = List.unmodifiable(callbacks),
       overrides = List.unmodifiable(overrides),
       liveCalls = List.unmodifiable(liveCalls);

  factory CustomerHistoryOpen.fromJson(Map<String, Object?> j) => CustomerHistoryOpen(
    callbacks: j.list('callbacks', CustomerHistoryOpenCallback.fromJson),
    overrides: j.list('overrides', CustomerHistoryOpenOverride.fromJson),
    liveCalls: j.list('live_calls', CustomerHistoryLiveCall.fromJson),
  );

  final List<CustomerHistoryOpenCallback> callbacks;
  final List<CustomerHistoryOpenOverride> overrides;
  final List<CustomerHistoryLiveCall> liveCalls;

  bool get isEmpty => callbacks.isEmpty && overrides.isEmpty && liveCalls.isEmpty;

  @override
  bool operator ==(Object other) =>
      other is CustomerHistoryOpen &&
      listEquals(other.callbacks, callbacks) &&
      listEquals(other.overrides, overrides) &&
      listEquals(other.liveCalls, liveCalls);

  @override
  int get hashCode => Object.hash(listHash(callbacks), listHash(overrides), listHash(liveCalls));
}

/// What the filters can offer: root campaigns, agents, outcomes and codes
/// seen in the history.
///
/// Contract: `CustomerHistorySummary['filter_options']`.
@immutable
final class CustomerHistoryFilterOptions {
  CustomerHistoryFilterOptions({
    required List<CustomerHistoryCampaignName> campaigns,
    required List<CustomerHistoryUser> agents,
    required List<String> outcomesRaw,
    required List<String> dispositionCodes,
  }) : campaigns = List.unmodifiable(campaigns),
       agents = List.unmodifiable(agents),
       outcomesRaw = List.unmodifiable(outcomesRaw),
       outcomes = List.unmodifiable(outcomesRaw.map(AttemptOutcome.fromWire)),
       dispositionCodes = List.unmodifiable(dispositionCodes);

  factory CustomerHistoryFilterOptions.fromJson(Map<String, Object?> j) => CustomerHistoryFilterOptions(
    campaigns: j.list('campaigns', CustomerHistoryCampaignName.fromJson),
    agents: j.list('agents', CustomerHistoryUser.fromJson),
    outcomesRaw: j.strings('outcomes'),
    dispositionCodes: j.strings('disposition_codes'),
  );

  final List<CustomerHistoryCampaignName> campaigns;
  final List<CustomerHistoryUser> agents;

  /// [outcomesRaw] decoded; a value this build does not know is `unknown`.
  final List<AttemptOutcome> outcomes;
  final List<String> outcomesRaw;
  final List<String> dispositionCodes;

  @override
  bool operator ==(Object other) =>
      other is CustomerHistoryFilterOptions &&
      listEquals(other.campaigns, campaigns) &&
      listEquals(other.agents, agents) &&
      listEquals(other.outcomesRaw, outcomesRaw) &&
      listEquals(other.dispositionCodes, dispositionCodes);

  @override
  int get hashCode =>
      Object.hash(listHash(campaigns), listHash(agents), listHash(outcomesRaw), listHash(dispositionCodes));
}

/// Everything about the number at a glance.
///
/// Contract: `CustomerHistorySummary`.
@immutable
final class CustomerHistorySummary {
  CustomerHistorySummary({
    required List<CustomerHistoryContact> contacts,
    this.contactsTruncated = false,
    required this.totals,
    required List<CustomerHistoryDncEntry> dnc,
    required this.open,
    required this.filterOptions,
  }) : contacts = List.unmodifiable(contacts),
       dnc = List.unmodifiable(dnc);

  factory CustomerHistorySummary.fromJson(Map<String, Object?> j) => CustomerHistorySummary(
    contacts: j.list('contacts', CustomerHistoryContact.fromJson),
    contactsTruncated: j.boolOrNull('contacts_truncated') ?? false,
    totals: CustomerHistoryTotals.fromJson(j.obj('totals')),
    dnc: j.list('dnc', CustomerHistoryDncEntry.fromJson),
    open: CustomerHistoryOpen.fromJson(j.obj('open')),
    filterOptions: CustomerHistoryFilterOptions.fromJson(j.obj('filter_options')),
  );

  /// Newest first, at most 2,000 roster rows.
  final List<CustomerHistoryContact> contacts;

  /// The number is on more than 2,000 roster rows (`contacts_truncated`, sent only when true):
  /// this history (summary, totals, timeline) covers the 2,000 most recent of them.
  final bool contactsTruncated;
  final CustomerHistoryTotals totals;

  /// Every entry covering the number; empty = not on any do-not-call list.
  final List<CustomerHistoryDncEntry> dnc;
  final CustomerHistoryOpen open;
  final CustomerHistoryFilterOptions filterOptions;

  @override
  bool operator ==(Object other) =>
      other is CustomerHistorySummary &&
      listEquals(other.contacts, contacts) &&
      other.contactsTruncated == contactsTruncated &&
      other.totals == totals &&
      listEquals(other.dnc, dnc) &&
      other.open == open &&
      other.filterOptions == filterOptions;

  @override
  int get hashCode => Object.hash(listHash(contacts), contactsTruncated, totals, listHash(dnc), open, filterOptions);
}

// ─── The timeline ───────────────────────────────────────────────────────────

/// One timeline entry, newest first (`at DESC, key DESC`). Sealed by `kind`;
/// a kind this build does not know is a [CustomerTimelineUnknownEntry], never
/// an error, so a kind the server adds later does not break the page.
///
/// Contract: `CustomerTimelineEntry` (over `CustomerTimelineBase`).
@immutable
sealed class CustomerTimelineEntry {
  const CustomerTimelineEntry({required this.key, required this.kindRaw, required this.at, this.accountId});

  /// Decodes by `kind`. Throws [WireFormatException] when a known kind's
  /// fields (or any entry's `key`, `kind`, `at`) are malformed.
  factory CustomerTimelineEntry.fromJson(Map<String, Object?> j) {
    final kind = j.str('kind');
    return switch (CustomerTimelineKind.fromWire(kind)) {
      CustomerTimelineKind.campaignCall => CustomerTimelineCampaignCall.fromJson(j),
      CustomerTimelineKind.softphoneCall => CustomerTimelineSoftphoneCall.fromJson(j),
      CustomerTimelineKind.callback => CustomerTimelineCallback.fromJson(j),
      CustomerTimelineKind.dncMark => CustomerTimelineDncMark.fromJson(j),
      CustomerTimelineKind.rosterEntry => CustomerTimelineRosterEntry.fromJson(j),
      CustomerTimelineKind.unknown => CustomerTimelineUnknownEntry.fromJson(j),
    };
  }

  /// Unique across kinds: `<kind>:<id>`. The tie-break of the order.
  final String key;
  final String kindRaw;
  final DateTime at;
  final String? accountId;

  CustomerTimelineKind get kind => CustomerTimelineKind.fromWire(kindRaw);
}

/// The call page of a campaign call; agents never get one (CH8).
///
/// Contract: `CustomerTimelineCampaignCall['call_page']`.
@immutable
final class CustomerCampaignCallPage {
  const CustomerCampaignCallPage({required this.accountId, required this.campaignId, required this.attemptId});

  factory CustomerCampaignCallPage.fromJson(Map<String, Object?> j) => CustomerCampaignCallPage(
    accountId: j.str('account_id'),
    campaignId: j.str('campaign_id'),
    attemptId: j.str('attempt_id'),
  );

  final String accountId;
  final String campaignId;
  final String attemptId;

  @override
  bool operator ==(Object other) =>
      other is CustomerCampaignCallPage &&
      other.accountId == accountId &&
      other.campaignId == campaignId &&
      other.attemptId == attemptId;

  @override
  int get hashCode => Object.hash(accountId, campaignId, attemptId);
}

/// The call page of a soft-phone call; agents never get one (CH8).
///
/// Contract: `CustomerTimelineSoftphoneCall['call_page']`.
@immutable
final class CustomerSoftphoneCallPage {
  const CustomerSoftphoneCallPage({required this.accountId, required this.manualCallId});

  factory CustomerSoftphoneCallPage.fromJson(Map<String, Object?> j) =>
      CustomerSoftphoneCallPage(accountId: j.str('account_id'), manualCallId: j.str('manual_call_id'));

  final String accountId;
  final String manualCallId;

  @override
  bool operator ==(Object other) =>
      other is CustomerSoftphoneCallPage && other.accountId == accountId && other.manualCallId == manualCallId;

  @override
  int get hashCode => Object.hash(accountId, manualCallId);
}

/// A campaign call: a pacing dial, an agent's manual dial on a contact, a
/// wrap-up redial.
///
/// Contract: `CustomerTimelineCampaignCall`.
@immutable
final class CustomerTimelineCampaignCall extends CustomerTimelineEntry {
  CustomerTimelineCampaignCall({
    required super.key,
    required super.at,
    super.accountId,
    required this.attemptId,
    required this.contactId,
    required this.campaign,
    required this.attemptNumber,
    this.agent,
    this.outcome,
    String? outcomeRaw,
    this.dispositionCode,
    this.talkSeconds,
    this.notes,
    required this.notesHidden,
    this.callbackAt,
    this.redialOfAttemptId,
    required this.chainAttemptId,
    required this.redialNumber,
    required List<String> overrideAppliedRaw,
    this.overrideNote,
    required this.recording,
    String? recordingRaw,
    this.callPage,
  }) : outcomeRaw = outcomeRaw ?? outcome?.wire,
       overrideAppliedRaw = List.unmodifiable(overrideAppliedRaw),
       overrideApplied = List.unmodifiable(overrideAppliedRaw.map(OverrideKind.fromWire)),
       recordingRaw = recordingRaw ?? recording.wire,
       super(kindRaw: 'campaign_call');

  factory CustomerTimelineCampaignCall.fromJson(Map<String, Object?> j) {
    final outcome = j.strOrNull('outcome');
    final recording = j.str('recording');
    final page = j.objOrNull('call_page');
    return CustomerTimelineCampaignCall(
      key: j.str('key'),
      at: j.time('at'),
      accountId: j.strOrNull('account_id'),
      attemptId: j.str('attempt_id'),
      contactId: j.str('contact_id'),
      campaign: CustomerHistoryCampaign.fromJson(j.obj('campaign')),
      attemptNumber: j.integer('attempt_number'),
      agent: _userOrNull(j, 'agent'),
      outcome: outcome == null ? null : AttemptOutcome.fromWire(outcome),
      outcomeRaw: outcome,
      dispositionCode: j.strOrNull('disposition_code'),
      talkSeconds: j.numberOrNull('talk_seconds'),
      notes: j.strOrNull('notes'),
      notesHidden: j.boolean('notes_hidden'),
      callbackAt: j.timeOrNull('callback_at'),
      redialOfAttemptId: j.strOrNull('redial_of_attempt_id'),
      chainAttemptId: j.str('chain_attempt_id'),
      redialNumber: j.integer('redial_number'),
      overrideAppliedRaw: j.strings('override_applied'),
      overrideNote: j.strOrNull('override_note'),
      recording: CustomerRecordingState.fromWire(recording),
      recordingRaw: recording,
      callPage: page == null ? null : CustomerCampaignCallPage.fromJson(page),
    );
  }

  final String attemptId;
  final String contactId;
  final CustomerHistoryCampaign campaign;
  final int attemptNumber;
  final CustomerHistoryUser? agent;

  /// Null is "not classified", never `failed`.
  final AttemptOutcome? outcome;
  final String? outcomeRaw;
  final String? dispositionCode;
  final double? talkSeconds;

  /// Null when there are none, or they are hidden ([notesHidden]).
  final String? notes;

  /// The call had notes the caller may not read (CH8).
  final bool notesHidden;
  final DateTime? callbackAt;

  /// The wrap-up redial chain: the attempt this redialled, and the chain's first.
  final String? redialOfAttemptId;
  final String chainAttemptId;
  final int redialNumber;

  /// Overrides spent on this dial, decoded; see [overrideAppliedRaw].
  final List<OverrideKind> overrideApplied;
  final List<String> overrideAppliedRaw;
  final String? overrideNote;
  final CustomerRecordingState recording;
  final String recordingRaw;

  /// Null when the caller cannot open it (an agent, always).
  final CustomerCampaignCallPage? callPage;

  @override
  bool operator ==(Object other) =>
      other is CustomerTimelineCampaignCall &&
      other.key == key &&
      other.kindRaw == kindRaw &&
      other.at == at &&
      other.accountId == accountId &&
      other.attemptId == attemptId &&
      other.contactId == contactId &&
      other.campaign == campaign &&
      other.attemptNumber == attemptNumber &&
      other.agent == agent &&
      other.outcomeRaw == outcomeRaw &&
      other.dispositionCode == dispositionCode &&
      other.talkSeconds == talkSeconds &&
      other.notes == notes &&
      other.notesHidden == notesHidden &&
      other.callbackAt == callbackAt &&
      other.redialOfAttemptId == redialOfAttemptId &&
      other.chainAttemptId == chainAttemptId &&
      other.redialNumber == redialNumber &&
      listEquals(other.overrideAppliedRaw, overrideAppliedRaw) &&
      other.overrideNote == overrideNote &&
      other.recordingRaw == recordingRaw &&
      other.callPage == callPage;

  @override
  int get hashCode => Object.hashAll(<Object?>[
    key,
    kindRaw,
    at,
    accountId,
    attemptId,
    contactId,
    campaign,
    attemptNumber,
    agent,
    outcomeRaw,
    dispositionCode,
    talkSeconds,
    notes,
    notesHidden,
    callbackAt,
    redialOfAttemptId,
    chainAttemptId,
    redialNumber,
    listHash(overrideAppliedRaw),
    overrideNote,
    recordingRaw,
    callPage,
  ]);
}

/// A soft-phone call to the number, logged to a campaign or not.
///
/// Contract: `CustomerTimelineSoftphoneCall`.
@immutable
final class CustomerTimelineSoftphoneCall extends CustomerTimelineEntry {
  CustomerTimelineSoftphoneCall({
    required super.key,
    required super.at,
    super.accountId,
    required this.manualCallId,
    this.campaign,
    this.contactId,
    this.agent,
    this.outcome,
    String? outcomeRaw,
    this.dispositionCode,
    this.talkSeconds,
    this.notes,
    required this.notesHidden,
    Map<String, Object?>? fields,
    this.dncOverrideNote,
    this.hoursOverrideNote,
    this.callbackAt,
    required this.recording,
    String? recordingRaw,
    this.callPage,
  }) : outcomeRaw = outcomeRaw ?? outcome?.wire,
       fields = fields == null ? null : frozenMap(fields),
       recordingRaw = recordingRaw ?? recording.wire,
       super(kindRaw: 'softphone_call');

  factory CustomerTimelineSoftphoneCall.fromJson(Map<String, Object?> j) {
    final outcome = j.strOrNull('outcome');
    final recording = j.str('recording');
    final page = j.objOrNull('call_page');
    return CustomerTimelineSoftphoneCall(
      key: j.str('key'),
      at: j.time('at'),
      accountId: j.strOrNull('account_id'),
      manualCallId: j.str('manual_call_id'),
      campaign: _campaignOrNull(j, 'campaign'),
      contactId: j.strOrNull('contact_id'),
      agent: _userOrNull(j, 'agent'),
      outcome: outcome == null ? null : AttemptOutcome.fromWire(outcome),
      outcomeRaw: outcome,
      dispositionCode: j.strOrNull('disposition_code'),
      talkSeconds: j.numberOrNull('talk_seconds'),
      notes: j.strOrNull('notes'),
      notesHidden: j.boolean('notes_hidden'),
      fields: j.objOrNull('fields'),
      dncOverrideNote: j.strOrNull('dnc_override_note'),
      hoursOverrideNote: j.strOrNull('hours_override_note'),
      callbackAt: j.timeOrNull('callback_at'),
      recording: CustomerRecordingState.fromWire(recording),
      recordingRaw: recording,
      callPage: page == null ? null : CustomerSoftphoneCallPage.fromJson(page),
    );
  }

  final String manualCallId;

  /// The campaign it was logged to; null for an untagged call.
  final CustomerHistoryCampaign? campaign;
  final String? contactId;
  final CustomerHistoryUser? agent;
  final AttemptOutcome? outcome;
  final String? outcomeRaw;
  final String? dispositionCode;
  final double? talkSeconds;
  final String? notes;
  final bool notesHidden;

  /// The call details the agent entered, by key (string, number, boolean or
  /// null values); null when hidden.
  final Map<String, Object?>? fields;
  final String? dncOverrideNote;
  final String? hoursOverrideNote;
  final DateTime? callbackAt;
  final CustomerRecordingState recording;
  final String recordingRaw;

  /// Null when the caller cannot open it (an agent, always).
  final CustomerSoftphoneCallPage? callPage;

  @override
  bool operator ==(Object other) =>
      other is CustomerTimelineSoftphoneCall &&
      other.key == key &&
      other.kindRaw == kindRaw &&
      other.at == at &&
      other.accountId == accountId &&
      other.manualCallId == manualCallId &&
      other.campaign == campaign &&
      other.contactId == contactId &&
      other.agent == agent &&
      other.outcomeRaw == outcomeRaw &&
      other.dispositionCode == dispositionCode &&
      other.talkSeconds == talkSeconds &&
      other.notes == notes &&
      other.notesHidden == notesHidden &&
      jsonEquals(other.fields, fields) &&
      other.dncOverrideNote == dncOverrideNote &&
      other.hoursOverrideNote == hoursOverrideNote &&
      other.callbackAt == callbackAt &&
      other.recordingRaw == recordingRaw &&
      other.callPage == callPage;

  @override
  int get hashCode => Object.hashAll(<Object?>[
    key,
    kindRaw,
    at,
    accountId,
    manualCallId,
    campaign,
    contactId,
    agent,
    outcomeRaw,
    dispositionCode,
    talkSeconds,
    notes,
    notesHidden,
    jsonHash(fields),
    dncOverrideNote,
    hoursOverrideNote,
    callbackAt,
    recordingRaw,
    callPage,
  ]);
}

/// The call a callback was booked on.
///
/// Contract: `CustomerTimelineCallback['source']`.
@immutable
final class CustomerCallbackSource {
  CustomerCallbackSource({required this.channel, String? channelRaw, required this.id})
    : channelRaw = channelRaw ?? channel.wire;

  factory CustomerCallbackSource.fromJson(Map<String, Object?> j) {
    final channel = j.str('channel');
    return CustomerCallbackSource(
      channel: CustomerTimelineChannel.fromWire(channel),
      channelRaw: channel,
      id: j.str('id'),
    );
  }

  final CustomerTimelineChannel channel;
  final String channelRaw;

  /// The attempt id (`campaign`) or the manual call id (`softphone`).
  final String id;

  @override
  bool operator ==(Object other) => other is CustomerCallbackSource && other.channelRaw == channelRaw && other.id == id;

  @override
  int get hashCode => Object.hash(channelRaw, id);
}

/// A callback booked on a call. [at] is the start of the call it was booked on (re-booking
/// never moves it); [dueAt] is when the callback is due.
///
/// Contract: `CustomerTimelineCallback`.
@immutable
final class CustomerTimelineCallback extends CustomerTimelineEntry {
  CustomerTimelineCallback({
    required super.key,
    required super.at,
    super.accountId,
    required this.source,
    this.campaign,
    required this.dueAt,
    this.bookedBy,
    required this.status,
    String? statusRaw,
    this.dialledAt,
  }) : statusRaw = statusRaw ?? status.wire,
       super(kindRaw: 'callback');

  factory CustomerTimelineCallback.fromJson(Map<String, Object?> j) {
    final status = j.str('status');
    return CustomerTimelineCallback(
      key: j.str('key'),
      at: j.time('at'),
      accountId: j.strOrNull('account_id'),
      source: CustomerCallbackSource.fromJson(j.obj('source')),
      campaign: _campaignOrNull(j, 'campaign'),
      dueAt: j.time('due_at'),
      bookedBy: _userOrNull(j, 'booked_by'),
      status: CustomerCallbackStatus.fromWire(status),
      statusRaw: status,
      dialledAt: j.timeOrNull('dialled_at'),
    );
  }

  final CustomerCallbackSource source;
  final CustomerHistoryCampaign? campaign;
  final DateTime dueAt;
  final CustomerHistoryUser? bookedBy;
  final CustomerCallbackStatus status;
  final String statusRaw;

  /// When the next call to the number was placed, if any.
  final DateTime? dialledAt;

  @override
  bool operator ==(Object other) =>
      other is CustomerTimelineCallback &&
      other.key == key &&
      other.kindRaw == kindRaw &&
      other.at == at &&
      other.accountId == accountId &&
      other.source == source &&
      other.campaign == campaign &&
      other.dueAt == dueAt &&
      other.bookedBy == bookedBy &&
      other.statusRaw == statusRaw &&
      other.dialledAt == dialledAt;

  @override
  int get hashCode =>
      Object.hash(key, kindRaw, at, accountId, source, campaign, dueAt, bookedBy, statusRaw, dialledAt);
}

/// The number put on a DNC list.
///
/// Contract: `CustomerTimelineDncMark`.
@immutable
final class CustomerTimelineDncMark extends CustomerTimelineEntry {
  const CustomerTimelineDncMark({
    required super.key,
    required super.at,
    super.accountId,
    required this.entry,
  }) : super(kindRaw: 'dnc_mark');

  factory CustomerTimelineDncMark.fromJson(Map<String, Object?> j) => CustomerTimelineDncMark(
    key: j.str('key'),
    at: j.time('at'),
    accountId: j.strOrNull('account_id'),
    entry: CustomerHistoryDncEntry.fromJson(j.obj('entry')),
  );

  final CustomerHistoryDncEntry entry;

  @override
  bool operator ==(Object other) =>
      other is CustomerTimelineDncMark &&
      other.key == key &&
      other.kindRaw == kindRaw &&
      other.at == at &&
      other.accountId == accountId &&
      other.entry == entry;

  @override
  int get hashCode => Object.hash(key, kindRaw, at, accountId, entry);
}

/// The number entering a campaign's roster.
///
/// Contract: `CustomerTimelineRosterEntry`.
@immutable
final class CustomerTimelineRosterEntry extends CustomerTimelineEntry {
  const CustomerTimelineRosterEntry({
    required super.key,
    required super.at,
    super.accountId,
    required this.contactId,
    required this.campaign,
    this.uploadFileName,
  }) : super(kindRaw: 'roster_entry');

  factory CustomerTimelineRosterEntry.fromJson(Map<String, Object?> j) => CustomerTimelineRosterEntry(
    key: j.str('key'),
    at: j.time('at'),
    accountId: j.strOrNull('account_id'),
    contactId: j.str('contact_id'),
    campaign: CustomerHistoryCampaign.fromJson(j.obj('campaign')),
    uploadFileName: j.strOrNull('upload_file_name'),
  );

  final String contactId;
  final CustomerHistoryCampaign campaign;
  final String? uploadFileName;

  @override
  bool operator ==(Object other) =>
      other is CustomerTimelineRosterEntry &&
      other.key == key &&
      other.kindRaw == kindRaw &&
      other.at == at &&
      other.accountId == accountId &&
      other.contactId == contactId &&
      other.campaign == campaign &&
      other.uploadFileName == uploadFileName;

  @override
  int get hashCode => Object.hash(key, kindRaw, at, accountId, contactId, campaign, uploadFileName);
}

/// An entry of a kind this build does not know. Its common fields decoded,
/// the rest kept in [raw]; shown as a plain row, never dropped silently.
@immutable
final class CustomerTimelineUnknownEntry extends CustomerTimelineEntry {
  CustomerTimelineUnknownEntry({
    required super.key,
    required super.kindRaw,
    required super.at,
    super.accountId,
    Map<String, Object?> raw = const <String, Object?>{},
  }) : raw = frozenMap(raw);

  factory CustomerTimelineUnknownEntry.fromJson(Map<String, Object?> j) => CustomerTimelineUnknownEntry(
    key: j.str('key'),
    kindRaw: j.str('kind'),
    at: j.time('at'),
    accountId: j.strOrNull('account_id'),
    raw: j,
  );

  /// The whole entry as sent.
  final Map<String, Object?> raw;

  @override
  bool operator ==(Object other) =>
      other is CustomerTimelineUnknownEntry &&
      other.key == key &&
      other.kindRaw == kindRaw &&
      other.at == at &&
      other.accountId == accountId &&
      jsonEquals(other.raw, raw);

  @override
  int get hashCode => Object.hash(key, kindRaw, at, accountId, jsonHash(raw));
}

/// One page of the timeline. [nextCursor] is opaque: pass it back unchanged.
///
/// Contract: `CustomerTimelinePage`.
@immutable
final class CustomerTimelinePage {
  CustomerTimelinePage({required List<CustomerTimelineEntry> entries, this.nextCursor})
    : entries = List.unmodifiable(entries);

  factory CustomerTimelinePage.fromJson(Map<String, Object?> j) => CustomerTimelinePage(
    entries: j.list('entries', CustomerTimelineEntry.fromJson),
    nextCursor: j.strOrNull('next_cursor'),
  );

  final List<CustomerTimelineEntry> entries;

  /// Null on the last page.
  final String? nextCursor;

  bool get hasMore => nextCursor != null;

  @override
  bool operator ==(Object other) =>
      other is CustomerTimelinePage && listEquals(other.entries, entries) && other.nextCursor == nextCursor;

  @override
  int get hashCode => Object.hash(listHash(entries), nextCursor);
}

// ─── The search box's options ───────────────────────────────────────────────

/// `GET /proxy/agency/customers/options`: what the search box needs before
/// the first search. [defaultCountryCode] is the platform default in the soft
/// phone bootstrap's form (`+91`: `+` and digits); the country picker starts
/// on the listed country with that calling code, else on an entry of its own
/// named by the code (`resolveSearchCountry`).
///
/// Contract: `CustomerSearchOptionsResponse`.
@immutable
final class CustomerSearchOptionsResponse {
  const CustomerSearchOptionsResponse({required this.defaultCountryCode});

  factory CustomerSearchOptionsResponse.fromJson(Map<String, Object?> j) =>
      CustomerSearchOptionsResponse(defaultCountryCode: j.str('default_country_code'));

  final String defaultCountryCode;

  @override
  bool operator ==(Object other) =>
      other is CustomerSearchOptionsResponse && other.defaultCountryCode == defaultCountryCode;

  @override
  int get hashCode => defaultCountryCode.hashCode;
}

// ─── The answer ─────────────────────────────────────────────────────────────

/// What was searched, as the server read it.
///
/// Contract: `CustomerSearchKey`.
@immutable
final class CustomerSearchKey {
  CustomerSearchKey({required this.by, String? byRaw, required this.value, required this.display})
    : byRaw = byRaw ?? by.wire;

  factory CustomerSearchKey.fromJson(Map<String, Object?> j) {
    final by = j.str('by');
    return CustomerSearchKey(
      by: CustomerSearchBy.fromWire(by),
      byRaw: by,
      value: j.str('value'),
      display: j.str('display'),
    );
  }

  final CustomerSearchBy by;
  final String byRaw;

  /// The canonical value searched: the E.164 number.
  final String value;

  /// For display: `+91 98765 43210`.
  final String display;

  @override
  bool operator ==(Object other) =>
      other is CustomerSearchKey && other.byRaw == byRaw && other.value == value && other.display == display;

  @override
  int get hashCode => Object.hash(byRaw, value, display);
}

/// `POST /proxy/agency/customers/search`'s answer: the summary and the first
/// timeline page, unfiltered.
///
/// Contract: `CustomerSearchResponse`.
@immutable
final class CustomerSearchResponse {
  const CustomerSearchResponse({
    required this.searchId,
    required this.expiresAt,
    required this.key,
    required this.summary,
    required this.timeline,
  });

  factory CustomerSearchResponse.fromJson(Map<String, Object?> j) => CustomerSearchResponse(
    searchId: j.str('search_id'),
    expiresAt: j.time('expires_at'),
    key: CustomerSearchKey.fromJson(j.obj('key')),
    summary: CustomerHistorySummary.fromJson(j.obj('summary')),
    timeline: CustomerTimelinePage.fromJson(j.obj('timeline')),
  );

  /// Names this search for the timeline pages; bound to the caller.
  final String searchId;
  final DateTime expiresAt;
  final CustomerSearchKey key;
  final CustomerHistorySummary summary;
  final CustomerTimelinePage timeline;

  /// Nothing in the accounts the caller can see: no contact, no call, no DNC
  /// entry, no timeline entry.
  bool get isEmpty =>
      summary.contacts.isEmpty && summary.totals.calls == 0 && summary.dnc.isEmpty && timeline.entries.isEmpty;

  @override
  bool operator ==(Object other) =>
      other is CustomerSearchResponse &&
      other.searchId == searchId &&
      other.expiresAt == expiresAt &&
      other.key == key &&
      other.summary == summary &&
      other.timeline == timeline;

  @override
  int get hashCode => Object.hash(searchId, expiresAt, key, summary, timeline);
}

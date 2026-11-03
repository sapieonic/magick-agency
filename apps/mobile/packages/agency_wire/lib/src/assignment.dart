/// Contact assignment, the agent's side: their own contacts on a campaign
/// (counts and a keyset list), agent-led retry of the contacts they did not
/// reach, the per-contact call, and the refusals of those routes.
///
/// Contract: `packages/contracts/src/api/agency/assignment.ts` (the agent
/// routes: `GET /proxy/agency/my-contacts/summary`, `GET /my-contacts`,
/// `POST /my-contacts/retry`, `POST /my-contacts/:contactId/call`). The
/// queue state the station shows is in `station.dart` ([QueueState]); an
/// outcome's override grant is in `session.dart` ([DispositionOverride]).
/// The supervisor's assignment routes are not the app's.
library;

import 'package:meta/meta.dart';

import 'enums.dart';
import 'equality.dart';
import 'json.dart';
import 'reads.dart';
import 'station.dart';

/// Bounds of the agent's note on a calling-hours override (trimmed, in code points).
///
/// Contract: `AGENCY_OVERRIDE_NOTE_MIN` / `AGENCY_OVERRIDE_NOTE_MAX` (`agency/session.ts`).
const overrideNoteMin = 10;
const overrideNoteMax = 500;

/// At most this many ids in one retry request.
///
/// Contract: `AGENCY_ASSIGNMENT_RANGE_MAX`.
const agentRetryContactIdsMax = 500;

/// Why one of the agent's own-contact routes refused. Key copy off this;
/// show the body's `message` for [unknown].
///
/// Contract: `AgencyAgentRetryErrorCode` / `AGENCY_AGENT_RETRY_ERROR_CODES`.
enum AgentRetryErrorCode implements WireEnum {
  /// 403: the `agency_contact_assignment_enabled` flag is off.
  assignmentDisabled('assignment_disabled'),

  /// 403: not staffed on the campaign.
  notStaffed('not_staffed'),

  /// 403: the campaign does not allow agent retry.
  agentRetryDisabled('agent_retry_disabled'),

  /// 404: no such contact assigned to the caller on this campaign.
  contactNotFound('contact_not_found'),

  /// 409: cannot be dialled or retried now; see [AgentRetryRefusal.blocked].
  contactNotRetryable('contact_not_retryable'),

  /// 409: the contact, or another on its number, is on a call.
  contactInFlight('contact_in_flight'),

  /// 409: the campaign is not running.
  campaignNotRunning('campaign_not_running'),

  /// 409: the session is not the caller's live `available` session on this campaign.
  agentNotAvailable('agent_not_available'),

  /// 409: the calling window is closed and no calling-hours override applies.
  outsideCallingHours('outside_calling_hours'),

  /// 400: the override note is missing or not 10–500 characters.
  overrideNoteInvalid('override_note_invalid'),

  /// 409: the number is on the DNC list. Never overridable.
  dncListed('dnc_listed'),

  /// 503: the DNC registry could not answer; nothing was dialled.
  dncUnavailable('dnc_unavailable'),

  /// 409: the campaign has no usable caller ID.
  noCallerId('no_caller_id'),

  /// 503: the caller's station is not connected on this server.
  noStation('no_station'),

  /// 502: the dial could not be placed; the contact and the agent were returned.
  dialFailed('dial_failed'),
  unknown('');

  const AgentRetryErrorCode(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static AgentRetryErrorCode fromWire(String? raw) => _byWire[raw] ?? unknown;
}

// ─── Counts ─────────────────────────────────────────────────────────────────

/// Contacts per bucket. Keyed by the wire bucket, so a bucket this build does
/// not know is still counted in [total]; a bucket absent from the body is 0.
///
/// Contract: `AgencyContactBucketCounts`.
@immutable
final class ContactBucketCounts {
  ContactBucketCounts(Map<String, int> byBucket) : byBucket = Map.unmodifiable(byBucket);

  factory ContactBucketCounts.fromJson(Map<String, Object?> j) =>
      ContactBucketCounts(<String, int>{for (final k in j.keys) k: j.integer(k)});

  final Map<String, int> byBucket;

  int operator [](MyContactBucket bucket) => byBucket[bucket.wire] ?? 0;

  int get total => byBucket.values.fold(0, (a, b) => a + b);

  @override
  bool operator ==(Object other) => other is ContactBucketCounts && mapEquals(other.byBucket, byBucket);

  @override
  int get hashCode => mapHash(byBucket);
}

// ─── One contact ────────────────────────────────────────────────────────────

/// The override an outcome granted on a contact, and what is left of it.
///
/// Contract: `AgencyContactOverride`.
@immutable
final class ContactOverride {
  const ContactOverride({
    required this.disposition,
    required this.extraAttempts,
    required this.retryDelay,
    required this.callingHours,
    required this.grantedAt,
  });

  factory ContactOverride.fromJson(Map<String, Object?> j) => ContactOverride(
    disposition: j.str('disposition'),
    extraAttempts: j.integer('extra_attempts'),
    retryDelay: j.boolean('retry_delay'),
    callingHours: j.boolean('calling_hours'),
    grantedAt: j.time('granted_at'),
  );

  /// The outcome code that granted it.
  final String disposition;
  final int extraAttempts;
  final bool retryDelay;
  final bool callingHours;
  final DateTime grantedAt;

  /// The parts not yet spent, in the contract's order.
  List<OverrideKind> get kinds => [
    if (extraAttempts > 0) OverrideKind.extraAttempts,
    if (retryDelay) OverrideKind.retryDelay,
    if (callingHours) OverrideKind.callingHours,
  ];

  @override
  bool operator ==(Object other) =>
      other is ContactOverride &&
      other.disposition == disposition &&
      other.extraAttempts == extraAttempts &&
      other.retryDelay == retryDelay &&
      other.callingHours == callingHours &&
      other.grantedAt == grantedAt;

  @override
  int get hashCode => Object.hash(disposition, extraAttempts, retryDelay, callingHours, grantedAt);
}

/// One of the campaign's hero columns for a contact: what the agent
/// recognises a customer by.
///
/// Contract: `AgencyMyContact['hero'][number]`.
@immutable
final class HeroField {
  const HeroField({required this.name, required this.value});

  factory HeroField.fromJson(Map<String, Object?> j) => HeroField(name: j.str('name'), value: j.str('value'));

  final String name;
  final String value;

  @override
  bool operator ==(Object other) => other is HeroField && other.name == name && other.value == value;

  @override
  int get hashCode => Object.hash(name, value);
}

/// Whether a contact can be retried by its agent now, and why not.
///
/// Contract: `AgencyMyContact['retry']`.
@immutable
final class MyContactRetry {
  MyContactRetry({required this.eligible, this.blocked, String? blockedRaw, required this.roundsUsed, this.availableAt})
    : blockedRaw = blockedRaw ?? blocked?.wire;

  factory MyContactRetry.fromJson(Map<String, Object?> j) {
    final blocked = j.strOrNull('blocked');
    return MyContactRetry(
      eligible: j.boolean('eligible'),
      blocked: blocked == null ? null : AgentRetryBlock.fromWire(blocked),
      blockedRaw: blocked,
      roundsUsed: j.integer('rounds_used'),
      availableAt: j.timeOrNull('available_at'),
    );
  }

  /// Can be retried now, through pacing or by calling it.
  final bool eligible;

  /// Why not, when not [eligible].
  final AgentRetryBlock? blocked;
  final String? blockedRaw;
  final int roundsUsed;

  /// When the cooldown ends (`blocked: cooldown`); null otherwise.
  final DateTime? availableAt;

  @override
  bool operator ==(Object other) =>
      other is MyContactRetry &&
      other.eligible == eligible &&
      other.blockedRaw == blockedRaw &&
      other.roundsUsed == roundsUsed &&
      other.availableAt == availableAt;

  @override
  int get hashCode => Object.hash(eligible, blockedRaw, roundsUsed, availableAt);
}

/// One of the agent's own contacts on a campaign.
///
/// Contract: `AgencyMyContact`. `last_outcome` and `last_disposition` are
/// plain strings on the wire and kept as such.
@immutable
final class MyContact {
  MyContact({
    required this.id,
    required this.campaignId,
    required this.phoneE164,
    required this.bucket,
    String? bucketRaw,
    required this.state,
    String? stateRaw,
    required this.attemptCount,
    this.lastOutcome,
    this.lastDisposition,
    required this.nextAttemptAt,
    this.lastAttemptAt,
    required List<HeroField> hero,
    required this.retry,
    this.overrideGrant,
  }) : bucketRaw = bucketRaw ?? bucket.wire,
       stateRaw = stateRaw ?? state.wire,
       hero = List.unmodifiable(hero);

  factory MyContact.fromJson(Map<String, Object?> j) {
    final bucket = j.str('bucket');
    final state = j.str('state');
    final override = j.objOrNull('override');
    return MyContact(
      id: j.str('id'),
      campaignId: j.str('campaign_id'),
      phoneE164: j.str('phone_e164'),
      bucket: MyContactBucket.fromWire(bucket),
      bucketRaw: bucket,
      state: ContactState.fromWire(state),
      stateRaw: state,
      attemptCount: j.integer('attempt_count'),
      lastOutcome: j.strOrNull('last_outcome'),
      lastDisposition: j.strOrNull('last_disposition'),
      nextAttemptAt: j.time('next_attempt_at'),
      lastAttemptAt: j.timeOrNull('last_attempt_at'),
      hero: j.list('hero', HeroField.fromJson),
      retry: MyContactRetry.fromJson(j.obj('retry')),
      overrideGrant: override == null ? null : ContactOverride.fromJson(override),
    );
  }

  final String id;
  final String campaignId;

  /// PII: never log or send to telemetry.
  final String phoneE164;
  final MyContactBucket bucket;
  final String bucketRaw;
  final ContactState state;
  final String stateRaw;
  final int attemptCount;
  final String? lastOutcome;
  final String? lastDisposition;

  /// When it falls due (for a callback, the booked time).
  final DateTime nextAttemptAt;
  final DateTime? lastAttemptAt;

  /// The campaign's hero columns for this contact, in order, minus hidden ones.
  final List<HeroField> hero;
  final MyContactRetry retry;

  /// An override granted by an outcome and not yet spent, or null.
  final ContactOverride? overrideGrant;

  /// Open and due now, at [now] (the server's clock, when the caller has it).
  bool isDueAt(DateTime now) => state == ContactState.pending && !nextAttemptAt.isAfter(now);

  @override
  bool operator ==(Object other) =>
      other is MyContact &&
      other.id == id &&
      other.campaignId == campaignId &&
      other.phoneE164 == phoneE164 &&
      other.bucketRaw == bucketRaw &&
      other.stateRaw == stateRaw &&
      other.attemptCount == attemptCount &&
      other.lastOutcome == lastOutcome &&
      other.lastDisposition == lastDisposition &&
      other.nextAttemptAt == nextAttemptAt &&
      other.lastAttemptAt == lastAttemptAt &&
      listEquals(other.hero, hero) &&
      other.retry == retry &&
      other.overrideGrant == overrideGrant;

  @override
  int get hashCode => Object.hash(
    id,
    campaignId,
    phoneE164,
    bucketRaw,
    stateRaw,
    attemptCount,
    lastOutcome,
    lastDisposition,
    nextAttemptAt,
    lastAttemptAt,
    listHash(hero),
    retry,
    overrideGrant,
  );
}

/// `GET /proxy/agency/my-contacts`. Contract: `AgencyKeysetPage<AgencyMyContact>`.
typedef MyContactsPage = KeysetPage<MyContact>;

MyContactsPage decodeMyContactsPage(Map<String, Object?> json) => KeysetPage.fromJson(json, MyContact.fromJson);

/// The query of `GET /proxy/agency/my-contacts`. `campaign_id` is required.
///
/// Contract: `AgencyMyContactsQuery`.
@immutable
final class MyContactsQuery {
  MyContactsQuery({
    required this.campaignId,
    List<MyContactBucket> buckets = const [],
    this.phone,
    this.q,
    this.cursor,
    this.limit,
  }) : buckets = List.unmodifiable(buckets);

  final String campaignId;

  /// `bucket`: sent comma-joined, the form the server splits (one key).
  final List<MyContactBucket> buckets;

  /// Digits anywhere in the number. A term with no digit is left out.
  final String? phone;

  /// Text in any hero column.
  final String? q;
  final String? cursor;
  final int? limit;

  MyContactsQuery withCursor(String? cursor) =>
      MyContactsQuery(campaignId: campaignId, buckets: buckets, phone: phone, q: q, cursor: cursor, limit: limit);

  Map<String, String> toQuery() {
    final phoneDigits = phone?.replaceAll(RegExp(r'\D'), '') ?? '';
    final text = q?.trim() ?? '';
    final sent = [
      for (final b in buckets)
        if (!b.isUnknown) b.wire,
    ];
    return <String, String>{
      'campaign_id': campaignId,
      if (sent.isNotEmpty) 'bucket': sent.join(','),
      if (phoneDigits.isNotEmpty) 'phone': phoneDigits,
      if (text.isNotEmpty) 'q': text,
      'cursor': ?cursor,
      if (limit != null) 'limit': '$limit',
    };
  }

  @override
  bool operator ==(Object other) =>
      other is MyContactsQuery &&
      other.campaignId == campaignId &&
      listEquals(other.buckets, buckets) &&
      other.phone == phone &&
      other.q == q &&
      other.cursor == cursor &&
      other.limit == limit;

  @override
  int get hashCode => Object.hash(campaignId, listHash(buckets), phone, q, cursor, limit);
}

// ─── Summary ────────────────────────────────────────────────────────────────

/// What the campaign lets the agent retry, and how many they can now.
///
/// Contract: `AgencyMyContactsSummary['retry']`.
@immutable
final class MyContactsRetrySummary {
  const MyContactsRetrySummary({
    required this.allowed,
    required this.rounds,
    required this.cooldownMinutes,
    required this.eligible,
  });

  factory MyContactsRetrySummary.fromJson(Map<String, Object?> j) => MyContactsRetrySummary(
    allowed: j.boolean('allowed'),
    rounds: j.integer('rounds'),
    cooldownMinutes: j.integer('cooldown_minutes'),
    eligible: j.integer('eligible'),
  );

  final bool allowed;
  final int rounds;
  final int cooldownMinutes;

  /// Contacts the caller can retry now ("Retry not reached (N)").
  final int eligible;

  @override
  bool operator ==(Object other) =>
      other is MyContactsRetrySummary &&
      other.allowed == allowed &&
      other.rounds == rounds &&
      other.cooldownMinutes == cooldownMinutes &&
      other.eligible == eligible;

  @override
  int get hashCode => Object.hash(allowed, rounds, cooldownMinutes, eligible);
}

/// `GET /proxy/agency/my-contacts/summary?campaign_id=`: the caller's
/// contacts on one campaign, in counts.
///
/// Contract: `AgencyMyContactsSummary`.
@immutable
final class MyContactsSummary {
  MyContactsSummary({
    required this.campaignId,
    required this.assignmentMode,
    String? assignmentModeRaw,
    required this.total,
    required this.counts,
    required this.dueNow,
    required this.queue,
    required this.unassignedOpen,
    required this.retry,
  }) : assignmentModeRaw = assignmentModeRaw ?? assignmentMode.wire;

  factory MyContactsSummary.fromJson(Map<String, Object?> j) {
    final mode = j.str('assignment_mode');
    return MyContactsSummary(
      campaignId: j.str('campaign_id'),
      assignmentMode: AssignmentMode.fromWire(mode),
      assignmentModeRaw: mode,
      total: j.integer('total'),
      counts: ContactBucketCounts.fromJson(j.obj('counts')),
      dueNow: j.integer('due_now'),
      queue: QueueState.fromJson(j.obj('queue')),
      unassignedOpen: j.integer('unassigned_open'),
      retry: MyContactsRetrySummary.fromJson(j.obj('retry')),
    );
  }

  final String campaignId;
  final AssignmentMode assignmentMode;
  final String assignmentModeRaw;

  /// Contacts assigned to the caller.
  final int total;
  final ContactBucketCounts counts;

  /// Open contacts due now.
  final int dueNow;

  /// The caller's queue: due now, or nothing due and why.
  final QueueState queue;

  /// In strict mode, open contacts nobody owns.
  final int unassignedOpen;
  final MyContactsRetrySummary retry;

  /// "Retry not reached (N)" is offered: retry is allowed, something is
  /// eligible, and nothing is due now (pacing would dial that first).
  bool get offersRetry => retry.allowed && retry.eligible > 0 && dueNow == 0;

  @override
  bool operator ==(Object other) =>
      other is MyContactsSummary &&
      other.campaignId == campaignId &&
      other.assignmentModeRaw == assignmentModeRaw &&
      other.total == total &&
      other.counts == counts &&
      other.dueNow == dueNow &&
      other.queue == queue &&
      other.unassignedOpen == unassignedOpen &&
      other.retry == retry;

  @override
  int get hashCode => Object.hash(campaignId, assignmentModeRaw, total, counts, dueNow, queue, unassignedOpen, retry);
}

// ─── Retry not reached ──────────────────────────────────────────────────────

/// `POST /proxy/agency/my-contacts/retry`: reopen contacts the caller did not
/// reach into their own queue (pacing then dials them). Either [contactIds]
/// (1–[agentRetryContactIdsMax]) or [all].
///
/// Contract: `AgencyAgentRetryRequest`.
@immutable
final class AgentRetryRequest {
  AgentRetryRequest.selected({required this.campaignId, required List<String> contactIds})
    : contactIds = List.unmodifiable(contactIds),
      all = false {
    if (contactIds.isEmpty || contactIds.length > agentRetryContactIdsMax) {
      throw ArgumentError.value(contactIds.length, 'contactIds', 'must be 1..$agentRetryContactIdsMax ids');
    }
  }

  const AgentRetryRequest.all({required this.campaignId}) : contactIds = null, all = true;

  final String campaignId;
  final List<String>? contactIds;
  final bool all;

  Map<String, Object?> toJson() => <String, Object?>{
    'campaign_id': campaignId,
    if (contactIds != null) 'contact_ids': contactIds,
    if (all) 'all': true,
  };

  @override
  bool operator ==(Object other) =>
      other is AgentRetryRequest &&
      other.campaignId == campaignId &&
      listEquals(other.contactIds, contactIds) &&
      other.all == all;

  @override
  int get hashCode => Object.hash(campaignId, listHash(contactIds), all);
}

/// One contact a retry did not reopen, and why.
@immutable
final class AgentRetrySkip {
  AgentRetrySkip({required this.contactId, required this.blocked, String? blockedRaw})
    : blockedRaw = blockedRaw ?? blocked.wire;

  factory AgentRetrySkip.fromJson(Map<String, Object?> j) {
    final blocked = j.str('blocked');
    return AgentRetrySkip(
      contactId: j.str('contact_id'),
      blocked: AgentRetryBlock.fromWire(blocked),
      blockedRaw: blocked,
    );
  }

  final String contactId;
  final AgentRetryBlock blocked;
  final String blockedRaw;

  @override
  bool operator ==(Object other) =>
      other is AgentRetrySkip && other.contactId == contactId && other.blockedRaw == blockedRaw;

  @override
  int get hashCode => Object.hash(contactId, blockedRaw);
}

/// Contract: `AgencyAgentRetryResponse`.
@immutable
final class AgentRetryResponse {
  AgentRetryResponse({required this.reopened, required List<AgentRetrySkip> skipped, required this.skippedTotal})
    : skipped = List.unmodifiable(skipped);

  factory AgentRetryResponse.fromJson(Map<String, Object?> j) => AgentRetryResponse(
    reopened: j.integer('reopened'),
    skipped: j.list('skipped', AgentRetrySkip.fromJson),
    skippedTotal: j.integer('skipped_total'),
  );

  final int reopened;

  /// At most 50 listed; [skippedTotal] counts them all.
  final List<AgentRetrySkip> skipped;
  final int skippedTotal;

  @override
  bool operator ==(Object other) =>
      other is AgentRetryResponse &&
      other.reopened == reopened &&
      listEquals(other.skipped, skipped) &&
      other.skippedTotal == skippedTotal;

  @override
  int get hashCode => Object.hash(reopened, listHash(skipped), skippedTotal);
}

// ─── Call one contact ───────────────────────────────────────────────────────

/// `POST /proxy/agency/my-contacts/:contactId/call`: dial one of the caller's
/// contacts now, on the campaign's normal path, from their `available`
/// station session on that campaign.
///
/// Contract: `AgencyMyContactCallRequest`.
@immutable
final class MyContactCallRequest {
  const MyContactCallRequest({required this.campaignId, required this.sessionId, this.overrideNote});

  final String campaignId;
  final String sessionId;

  /// [overrideNoteMin]–[overrideNoteMax] characters; spends a calling-hours
  /// override outside the window. Sent trimmed.
  final String? overrideNote;

  Map<String, Object?> toJson() {
    final json = <String, Object?>{'campaign_id': campaignId, 'session_id': sessionId};
    final note = overrideNote?.trim();
    if (note != null && note.isNotEmpty) json['override_note'] = note;
    return json;
  }

  @override
  bool operator ==(Object other) =>
      other is MyContactCallRequest &&
      other.campaignId == campaignId &&
      other.sessionId == sessionId &&
      other.overrideNote == overrideNote;

  @override
  int get hashCode => Object.hash(campaignId, sessionId, overrideNote);
}

/// Contract: `AgencyMyContactCallResponse`.
@immutable
final class MyContactCallResponse {
  MyContactCallResponse({
    required this.attemptId,
    required this.contactId,
    required List<String> overrideAppliedRaw,
    required this.retryRoundSpent,
  }) : overrideAppliedRaw = List.unmodifiable(overrideAppliedRaw),
       overrideApplied = List.unmodifiable(overrideAppliedRaw.map(OverrideKind.fromWire));

  factory MyContactCallResponse.fromJson(Map<String, Object?> j) => MyContactCallResponse(
    attemptId: j.str('attempt_id'),
    contactId: j.str('contact_id'),
    overrideAppliedRaw: j.strings('override_applied'),
    retryRoundSpent: j.boolean('retry_round_spent'),
  );

  final String attemptId;
  final String contactId;

  /// Overrides this dial spent.
  final List<OverrideKind> overrideApplied;
  final List<String> overrideAppliedRaw;

  /// Whether the dial spent one of the contact's agent retry rounds.
  final bool retryRoundSpent;

  @override
  bool operator ==(Object other) =>
      other is MyContactCallResponse &&
      other.attemptId == attemptId &&
      other.contactId == contactId &&
      listEquals(other.overrideAppliedRaw, overrideAppliedRaw) &&
      other.retryRoundSpent == retryRoundSpent;

  @override
  int get hashCode => Object.hash(attemptId, contactId, listHash(overrideAppliedRaw), retryRoundSpent);
}

// ─── Refusals ───────────────────────────────────────────────────────────────

/// A refusal of the agent's own-contact routes, read from an error body.
/// Built by `ErrorBody.agentRetryRefusal`; reading it **never throws**: a
/// `details` value of the wrong type reads as absent.
///
/// Contract: `AgencyAgentRetryErrorResponse`. `details` is
/// `{ blocked, available_at? }` for `contact_not_retryable`, `{ next_open_at }`
/// for `outside_calling_hours` and `{ min, max }` for `override_note_invalid`.
@immutable
final class AgentRetryRefusal {
  AgentRetryRefusal({
    required this.code,
    String? codeRaw,
    required this.message,
    this.blocked,
    this.blockedRaw,
    this.availableAt,
    this.nextOpenAt,
    this.noteMin,
    this.noteMax,
  }) : codeRaw = codeRaw ?? code.wire;

  /// Reads [body] leniently: an unknown or missing code is [AgentRetryErrorCode.unknown].
  factory AgentRetryRefusal.fromBody(Map<String, Object?> body) {
    final codeRaw = body['code'] is String ? body['code']! as String : '';
    final details = body['details'] is Map<String, Object?> ? body['details']! as Map<String, Object?> : null;
    String? text(String k) => details?[k] is String ? details![k]! as String : null;
    int? whole(String k) => details?[k] is int ? details![k]! as int : null;
    DateTime? instant(String k) {
      final v = text(k);
      return v == null ? null : DateTime.tryParse(v)?.toUtc();
    }

    final blocked = text('blocked');
    return AgentRetryRefusal(
      code: AgentRetryErrorCode.fromWire(codeRaw),
      codeRaw: codeRaw,
      message: body['message'] is String ? body['message']! as String : '',
      blocked: blocked == null ? null : AgentRetryBlock.fromWire(blocked),
      blockedRaw: blocked,
      availableAt: instant('available_at'),
      nextOpenAt: instant('next_open_at'),
      noteMin: whole('min'),
      noteMax: whole('max'),
    );
  }

  final AgentRetryErrorCode code;
  final String codeRaw;

  /// The server's sentence; the fallback copy for an unknown [code].
  final String message;

  /// `contact_not_retryable`: why.
  final AgentRetryBlock? blocked;
  final String? blockedRaw;

  /// `contact_not_retryable` with `blocked: cooldown`: when it can be retried.
  final DateTime? availableAt;

  /// `outside_calling_hours`: when the window opens again.
  final DateTime? nextOpenAt;

  /// `override_note_invalid`: the note's bounds.
  final int? noteMin;
  final int? noteMax;

  @override
  bool operator ==(Object other) =>
      other is AgentRetryRefusal &&
      other.codeRaw == codeRaw &&
      other.message == message &&
      other.blockedRaw == blockedRaw &&
      other.availableAt == availableAt &&
      other.nextOpenAt == nextOpenAt &&
      other.noteMin == noteMin &&
      other.noteMax == noteMax;

  @override
  int get hashCode => Object.hash(codeRaw, message, blockedRaw, availableAt, nextOpenAt, noteMin, noteMax);

  @override
  String toString() => 'AgentRetryRefusal($codeRaw${blockedRaw == null ? '' : '/$blockedRaw'})';
}

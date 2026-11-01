/// The agent's own reads: assignments, staffing history, scorecard, call
/// history.
///
/// Contract: `packages/contracts/src/api/agency/agency-campaign.ts`
/// (`/my-assignments`), `api/agency/agency-stats.ts` (`/my-campaigns`,
/// `/my-stats`), `agency/performance.ts` and `agency/spine.ts`
/// (`/my-attempts`).
library;

import 'package:meta/meta.dart';

import 'enums.dart';
import 'equality.dart';
import 'json.dart';

// ─── /my-assignments, /my-campaigns ────────────────────────────────────────

/// One campaign this agent may work right now.
///
/// Contract: `AgencyAssignment`. `campaign_status` is a plain string on the
/// wire (forwarded unchanged), so an unknown status is kept and shown as is.
@immutable
final class Assignment {
  Assignment({required this.campaignId, this.campaignName, this.campaignStatusRaw, required this.assignedAt})
    : campaignStatus = campaignStatusRaw == null ? null : CampaignStatus.fromWire(campaignStatusRaw);

  factory Assignment.fromJson(Map<String, Object?> j) => Assignment(
    campaignId: j.str('campaign_id'),
    campaignName: j.strOrNull('campaign_name'),
    campaignStatusRaw: j.strOrNull('campaign_status'),
    assignedAt: j.time('assigned_at'),
  );

  final String campaignId;

  /// Best effort: null when the lookup failed. Guard every render.
  final String? campaignName;

  /// Null when the lookup failed.
  final CampaignStatus? campaignStatus;
  final String? campaignStatusRaw;
  final DateTime assignedAt;

  @override
  bool operator ==(Object other) =>
      other is Assignment &&
      other.campaignId == campaignId &&
      other.campaignName == campaignName &&
      other.campaignStatusRaw == campaignStatusRaw &&
      other.assignedAt == assignedAt;

  @override
  int get hashCode => Object.hash(campaignId, campaignName, campaignStatusRaw, assignedAt);
}

/// `GET /proxy/agency/my-assignments`. Empty ⇒ nobody has staffed them.
///
/// Contract: `AgencyMyAssignments`.
@immutable
final class MyAssignments {
  MyAssignments(List<Assignment> assignments) : assignments = List.unmodifiable(assignments);

  factory MyAssignments.fromJson(Map<String, Object?> j) => MyAssignments(j.list('assignments', Assignment.fromJson));

  final List<Assignment> assignments;

  @override
  bool operator ==(Object other) => other is MyAssignments && listEquals(other.assignments, assignments);

  @override
  int get hashCode => listHash(assignments);
}

/// One staffing, current or ended.
///
/// Contract: `AgencyStaffingHistoryEntry`.
@immutable
final class StaffingHistoryEntry {
  StaffingHistoryEntry({
    required this.campaignId,
    this.campaignName,
    this.campaignStatusRaw,
    required this.assignedAt,
    this.unassignedAt,
    required this.active,
  }) : campaignStatus = campaignStatusRaw == null ? null : CampaignStatus.fromWire(campaignStatusRaw);

  factory StaffingHistoryEntry.fromJson(Map<String, Object?> j) => StaffingHistoryEntry(
    campaignId: j.str('campaign_id'),
    campaignName: j.strOrNull('campaign_name'),
    campaignStatusRaw: j.strOrNull('campaign_status'),
    assignedAt: j.time('assigned_at'),
    unassignedAt: j.timeOrNull('unassigned_at'),
    active: j.boolean('active'),
  );

  final String campaignId;
  final String? campaignName;
  final CampaignStatus? campaignStatus;
  final String? campaignStatusRaw;
  final DateTime assignedAt;

  /// Null while the assignment is current.
  final DateTime? unassignedAt;

  /// The server's answer to "is this current"; read it, do not derive it.
  final bool active;

  @override
  bool operator ==(Object other) =>
      other is StaffingHistoryEntry &&
      other.campaignId == campaignId &&
      other.campaignName == campaignName &&
      other.campaignStatusRaw == campaignStatusRaw &&
      other.assignedAt == assignedAt &&
      other.unassignedAt == unassignedAt &&
      other.active == active;

  @override
  int get hashCode => Object.hash(campaignId, campaignName, campaignStatusRaw, assignedAt, unassignedAt, active);
}

/// `GET /proxy/agency/my-campaigns`. The key is `assignments`, not `campaigns`.
///
/// Contract: `AgencyStaffingHistory`.
@immutable
final class StaffingHistory {
  StaffingHistory(List<StaffingHistoryEntry> assignments) : assignments = List.unmodifiable(assignments);

  factory StaffingHistory.fromJson(Map<String, Object?> j) =>
      StaffingHistory(j.list('assignments', StaffingHistoryEntry.fromJson));

  final List<StaffingHistoryEntry> assignments;

  @override
  bool operator ==(Object other) => other is StaffingHistory && listEquals(other.assignments, assignments);

  @override
  int get hashCode => listHash(assignments);
}

// ─── /my-stats ──────────────────────────────────────────────────────────────

/// A calendar day with no time and no zone (`YYYY-MM-DD`). Bucket labels are
/// days in each campaign's own timezone; parsing one as an instant would put
/// a zone back on it and shift it a day for readers west of Greenwich.
@immutable
final class CalendarDate implements Comparable<CalendarDate> {
  const CalendarDate(this.year, this.month, this.day);

  factory CalendarDate.parse(String s) {
    final m = _pattern.firstMatch(s);
    if (m == null) throw WireFormatException('not a YYYY-MM-DD date: "$s"');
    return CalendarDate(int.parse(m[1]!), int.parse(m[2]!), int.parse(m[3]!));
  }

  static final _pattern = RegExp(r'^(\d{4})-(\d{2})-(\d{2})$');

  final int year;
  final int month;
  final int day;

  /// Midnight of this day on the reader's own calendar (local time).
  DateTime toLocalDateTime() => DateTime(year, month, day);

  @override
  int compareTo(CalendarDate other) =>
      year != other.year ? year - other.year : (month != other.month ? month - other.month : day - other.day);

  @override
  bool operator ==(Object other) =>
      other is CalendarDate && other.year == year && other.month == month && other.day == day;

  @override
  int get hashCode => Object.hash(year, month, day);

  @override
  String toString() =>
      '${year.toString().padLeft(4, '0')}-${month.toString().padLeft(2, '0')}-${day.toString().padLeft(2, '0')}';
}

/// Where the agent's time went, in seconds per state. All-zero means not
/// measured, never "did nothing".
///
/// Contract: `AgencyAgentOccupancy`.
@immutable
final class Occupancy {
  Occupancy({required this.shiftSeconds, required Map<String, double> byState}) : byState = Map.unmodifiable(byState);

  factory Occupancy.fromJson(Map<String, Object?> j) {
    final raw = j.obj('by_state');
    return Occupancy(
      shiftSeconds: j.number('shift_seconds'),
      byState: <String, double>{for (final k in raw.keys) k: raw.number(k)},
    );
  }

  /// Every logged-in second (all states but `offline`).
  final double shiftSeconds;

  /// Keyed by the wire state (`on_call`, `break`, ...), so a state this
  /// build does not know is still summed.
  final Map<String, double> byState;

  double secondsIn(AgentState state) => byState[state.wire] ?? 0;

  /// True when every state is zero: render "not measured", never a bar.
  bool get isUnmeasured => byState.values.every((v) => v == 0);

  @override
  bool operator ==(Object other) =>
      other is Occupancy && other.shiftSeconds == shiftSeconds && mapEquals(other.byState, byState);

  @override
  int get hashCode => Object.hash(shiftSeconds, mapHash(byState));
}

/// The window totals; every counter is the exact sum of the buckets.
/// **A null rate means not measured yet, never zero.**
///
/// Contract: `AgencyAgentStatsTotals` (console reading: `occupancy` optional).
@immutable
final class AgentStatsTotals {
  const AgentStatsTotals({
    required this.attempts,
    required this.connected,
    this.connectRatePct,
    required this.successes,
    this.successRatePct,
    required this.talkSeconds,
    required this.wrapupSeconds,
    this.ahtSeconds,
    required this.campaigns,
    this.occupancy,
  });

  factory AgentStatsTotals.fromJson(Map<String, Object?> j) {
    final occupancy = j.objOrNull('occupancy');
    return AgentStatsTotals(
      attempts: j.integer('attempts'),
      connected: j.integer('connected'),
      connectRatePct: j.numberOrNull('connect_rate_pct'),
      successes: j.integer('successes'),
      successRatePct: j.numberOrNull('success_rate_pct'),
      talkSeconds: j.number('talk_seconds'),
      wrapupSeconds: j.number('wrapup_seconds'),
      ahtSeconds: j.numberOrNull('aht_seconds'),
      campaigns: j.integer('campaigns'),
      occupancy: occupancy == null ? null : Occupancy.fromJson(occupancy),
    );
  }

  /// Dials the dialer placed and handed to this agent.
  final int attempts;

  /// Dials where media joined the agent to a person.
  final int connected;

  /// `connected / attempts` (percent), null when nothing was dialled.
  final double? connectRatePct;
  final int successes;

  /// `successes / connected` (percent), null when nothing connected.
  final double? successRatePct;
  final double talkSeconds;
  final double wrapupSeconds;

  /// `(talk + wrap-up) / connected`, null when nothing connected.
  final double? ahtSeconds;

  /// Distinct campaigns worked in the window (a count).
  final int campaigns;
  final Occupancy? occupancy;

  @override
  bool operator ==(Object other) =>
      other is AgentStatsTotals &&
      other.attempts == attempts &&
      other.connected == connected &&
      other.connectRatePct == connectRatePct &&
      other.successes == successes &&
      other.successRatePct == successRatePct &&
      other.talkSeconds == talkSeconds &&
      other.wrapupSeconds == wrapupSeconds &&
      other.ahtSeconds == ahtSeconds &&
      other.campaigns == campaigns &&
      other.occupancy == occupancy;

  @override
  int get hashCode => Object.hash(
    attempts,
    connected,
    connectRatePct,
    successes,
    successRatePct,
    talkSeconds,
    wrapupSeconds,
    ahtSeconds,
    campaigns,
    occupancy,
  );
}

/// One bucket of the series, labelled by [bucketStart] in the campaign's own
/// timezone.
///
/// Contract: `AgencyAgentStatsBucket` (console reading: `occupancy` optional).
@immutable
final class AgentStatsBucket {
  const AgentStatsBucket({
    required this.bucketStart,
    required this.attempts,
    required this.connected,
    required this.successes,
    required this.talkSeconds,
    required this.wrapupSeconds,
    this.occupancy,
  });

  factory AgentStatsBucket.fromJson(Map<String, Object?> j) {
    final occupancy = j.objOrNull('occupancy');
    return AgentStatsBucket(
      bucketStart: CalendarDate.parse(j.str('bucket_start')),
      attempts: j.integer('attempts'),
      connected: j.integer('connected'),
      successes: j.integer('successes'),
      talkSeconds: j.number('talk_seconds'),
      wrapupSeconds: j.number('wrapup_seconds'),
      occupancy: occupancy == null ? null : Occupancy.fromJson(occupancy),
    );
  }

  /// The day (for `week` the Monday, for `month` the 1st).
  final CalendarDate bucketStart;
  final int attempts;
  final int connected;
  final int successes;
  final double talkSeconds;
  final double wrapupSeconds;
  final Occupancy? occupancy;

  @override
  bool operator ==(Object other) =>
      other is AgentStatsBucket &&
      other.bucketStart == bucketStart &&
      other.attempts == attempts &&
      other.connected == connected &&
      other.successes == successes &&
      other.talkSeconds == talkSeconds &&
      other.wrapupSeconds == wrapupSeconds &&
      other.occupancy == occupancy;

  @override
  int get hashCode => Object.hash(bucketStart, attempts, connected, successes, talkSeconds, wrapupSeconds, occupancy);
}

/// The agent's work on one campaign over the window (ids only; resolve names
/// from the assignments).
///
/// Contract: `AgencyAgentCampaignRow`.
@immutable
final class AgentCampaignRow {
  const AgentCampaignRow({
    required this.campaignId,
    required this.attempts,
    required this.connected,
    required this.successes,
    required this.talkSeconds,
    required this.wrapupSeconds,
  });

  factory AgentCampaignRow.fromJson(Map<String, Object?> j) => AgentCampaignRow(
    campaignId: j.str('campaign_id'),
    attempts: j.integer('attempts'),
    connected: j.integer('connected'),
    successes: j.integer('successes'),
    talkSeconds: j.number('talk_seconds'),
    wrapupSeconds: j.number('wrapup_seconds'),
  );

  final String campaignId;
  final int attempts;
  final int connected;
  final int successes;
  final double talkSeconds;
  final double wrapupSeconds;

  @override
  bool operator ==(Object other) =>
      other is AgentCampaignRow &&
      other.campaignId == campaignId &&
      other.attempts == attempts &&
      other.connected == connected &&
      other.successes == successes &&
      other.talkSeconds == talkSeconds &&
      other.wrapupSeconds == wrapupSeconds;

  @override
  int get hashCode => Object.hash(campaignId, attempts, connected, successes, talkSeconds, wrapupSeconds);
}

/// The query of `GET /proxy/agency/my-stats`. The server takes only these
/// keys and answers 400 for any other.
@immutable
final class AgentStatsQuery {
  const AgentStatsQuery({required this.from, required this.to, this.bucket = StatsBucketUnit.day, this.campaignId});

  /// Inclusive.
  final DateTime from;

  /// Exclusive.
  final DateTime to;
  final StatsBucketUnit bucket;
  final String? campaignId;

  Map<String, String> toQuery() => <String, String>{
    'from': isoUtc(from),
    'to': isoUtc(to),
    'bucket': bucket.wire,
    'campaign_id': ?campaignId,
  };

  @override
  bool operator ==(Object other) =>
      other is AgentStatsQuery &&
      other.from == from &&
      other.to == to &&
      other.bucket == bucket &&
      other.campaignId == campaignId;

  @override
  int get hashCode => Object.hash(from, to, bucket, campaignId);
}

/// `GET /proxy/agency/my-stats`: the agent's own scorecard.
///
/// Contract: `AgencyAgentStats` (`api/agency/agency-stats.ts`).
@immutable
final class AgentStats {
  AgentStats({
    required this.agentUserId,
    required this.bucket,
    String? bucketRaw,
    required this.from,
    required this.to,
    required this.totals,
    required List<AgentStatsBucket> buckets,
    required List<AgentCampaignRow> byCampaign,
  }) : bucketRaw = bucketRaw ?? bucket.wire,
       buckets = List.unmodifiable(buckets),
       byCampaign = List.unmodifiable(byCampaign);

  factory AgentStats.fromJson(Map<String, Object?> j) {
    final bucket = j.str('bucket');
    return AgentStats(
      agentUserId: j.str('agent_user_id'),
      bucket: StatsBucketUnit.fromWire(bucket),
      bucketRaw: bucket,
      from: j.time('from'),
      to: j.time('to'),
      totals: AgentStatsTotals.fromJson(j.obj('totals')),
      buckets: j.list('buckets', AgentStatsBucket.fromJson),
      byCampaign: j.list('by_campaign', AgentCampaignRow.fromJson),
    );
  }

  final String agentUserId;
  final StatsBucketUnit bucket;
  final String bucketRaw;
  final DateTime from;
  final DateTime to;
  final AgentStatsTotals totals;

  /// Oldest first. Empty is a real answer: nothing happened in the window.
  final List<AgentStatsBucket> buckets;
  final List<AgentCampaignRow> byCampaign;

  /// Nothing in the window at all (distinct from a failed read).
  bool get isEmpty => totals.attempts == 0 && buckets.isEmpty;

  @override
  bool operator ==(Object other) =>
      other is AgentStats &&
      other.agentUserId == agentUserId &&
      other.bucketRaw == bucketRaw &&
      other.from == from &&
      other.to == to &&
      other.totals == totals &&
      listEquals(other.buckets, buckets) &&
      listEquals(other.byCampaign, byCampaign);

  @override
  int get hashCode => Object.hash(agentUserId, bucketRaw, from, to, totals, listHash(buckets), listHash(byCampaign));
}

// ─── /my-attempts ───────────────────────────────────────────────────────────

/// One dial the agent handled.
///
/// Contract: `AgencyAttemptRow` (`agency/spine.ts`), as `AgencyAttempt`
/// (`api/agency/agency-spine.ts`) with its optional `agent_name`.
@immutable
final class AttemptRow {
  AttemptRow({
    required this.id,
    required this.campaignId,
    required this.contactId,
    required this.attemptNumber,
    required this.phoneE164,
    required this.callerId,
    this.agentUserId,
    this.reservedAgentId,
    required this.state,
    String? stateRaw,
    this.outcome,
    String? outcomeRaw,
    this.dispositionCode,
    this.notes,
    this.callbackAt,
    this.dispositionedByUserId,
    this.dispositionedAt,
    required this.dispositionedOnBehalf,
    this.webrtcCallId,
    this.dialedAt,
    this.answeredAt,
    this.bridgedAt,
    this.endedAt,
    this.talkSeconds,
    this.wrapupSeconds,
    required this.createdAt,
    this.agentName,
  }) : stateRaw = stateRaw ?? state.wire,
       outcomeRaw = outcomeRaw ?? outcome?.wire;

  factory AttemptRow.fromJson(Map<String, Object?> j) {
    final state = j.str('state');
    final outcome = j.strOrNull('outcome');
    return AttemptRow(
      id: j.str('id'),
      campaignId: j.str('campaign_id'),
      contactId: j.str('contact_id'),
      attemptNumber: j.integer('attempt_number'),
      phoneE164: j.str('phone_e164'),
      callerId: j.str('caller_id'),
      agentUserId: j.strOrNull('agent_user_id'),
      reservedAgentId: j.strOrNull('reserved_agent_id'),
      state: AttemptState.fromWire(state),
      stateRaw: state,
      outcome: outcome == null ? null : AttemptOutcome.fromWire(outcome),
      outcomeRaw: outcome,
      dispositionCode: j.strOrNull('disposition_code'),
      notes: j.strOrNull('notes'),
      callbackAt: j.timeOrNull('callback_at'),
      dispositionedByUserId: j.strOrNull('dispositioned_by_user_id'),
      dispositionedAt: j.timeOrNull('dispositioned_at'),
      dispositionedOnBehalf: j.boolean('dispositioned_on_behalf'),
      webrtcCallId: j.strOrNull('webrtc_call_id'),
      dialedAt: j.timeOrNull('dialed_at'),
      answeredAt: j.timeOrNull('answered_at'),
      bridgedAt: j.timeOrNull('bridged_at'),
      endedAt: j.timeOrNull('ended_at'),
      talkSeconds: j.numberOrNull('talk_seconds'),
      wrapupSeconds: j.numberOrNull('wrapup_seconds'),
      createdAt: j.time('created_at'),
      agentName: j.strOrNull('agent_name'),
    );
  }

  final String id;
  final String campaignId;
  final String contactId;
  final int attemptNumber;
  final String phoneE164;
  final String callerId;
  final String? agentUserId;
  final String? reservedAgentId;
  final AttemptState state;
  final String stateRaw;

  /// Null is possible and is NOT `failed`: the attempt ended unclassified.
  final AttemptOutcome? outcome;
  final String? outcomeRaw;
  final String? dispositionCode;
  final String? notes;
  final DateTime? callbackAt;
  final String? dispositionedByUserId;
  final DateTime? dispositionedAt;
  final bool dispositionedOnBehalf;

  /// Not a promise the call row still exists.
  final String? webrtcCallId;
  final DateTime? dialedAt;
  final DateTime? answeredAt;
  final DateTime? bridgedAt;
  final DateTime? endedAt;
  final double? talkSeconds;
  final double? wrapupSeconds;
  final DateTime createdAt;

  /// Not sent on `/my-attempts` (every row is the caller's own).
  final String? agentName;

  @override
  bool operator ==(Object other) =>
      other is AttemptRow &&
      other.id == id &&
      other.campaignId == campaignId &&
      other.contactId == contactId &&
      other.attemptNumber == attemptNumber &&
      other.phoneE164 == phoneE164 &&
      other.callerId == callerId &&
      other.agentUserId == agentUserId &&
      other.reservedAgentId == reservedAgentId &&
      other.stateRaw == stateRaw &&
      other.outcomeRaw == outcomeRaw &&
      other.dispositionCode == dispositionCode &&
      other.notes == notes &&
      other.callbackAt == callbackAt &&
      other.dispositionedByUserId == dispositionedByUserId &&
      other.dispositionedAt == dispositionedAt &&
      other.dispositionedOnBehalf == dispositionedOnBehalf &&
      other.webrtcCallId == webrtcCallId &&
      other.dialedAt == dialedAt &&
      other.answeredAt == answeredAt &&
      other.bridgedAt == bridgedAt &&
      other.endedAt == endedAt &&
      other.talkSeconds == talkSeconds &&
      other.wrapupSeconds == wrapupSeconds &&
      other.createdAt == createdAt &&
      other.agentName == agentName;

  @override
  int get hashCode => Object.hashAll(<Object?>[
    id,
    campaignId,
    contactId,
    attemptNumber,
    phoneE164,
    callerId,
    agentUserId,
    reservedAgentId,
    stateRaw,
    outcomeRaw,
    dispositionCode,
    notes,
    callbackAt,
    dispositionedByUserId,
    dispositionedAt,
    dispositionedOnBehalf,
    webrtcCallId,
    dialedAt,
    answeredAt,
    bridgedAt,
    endedAt,
    talkSeconds,
    wrapupSeconds,
    createdAt,
    agentName,
  ]);
}

/// A keyset page. [nextCursor] is opaque: pass it back unchanged. There is
/// no total, and no page numbers to offer: "load more" is the control.
///
/// Contract: `AgencyKeysetPage<TRow>`.
@immutable
final class KeysetPage<T> {
  KeysetPage({required List<T> rows, this.nextCursor, required this.limit}) : rows = List.unmodifiable(rows);

  factory KeysetPage.fromJson(Map<String, Object?> j, T Function(Map<String, Object?> row) decodeRow) =>
      KeysetPage(rows: j.list('rows', decodeRow), nextCursor: j.strOrNull('next_cursor'), limit: j.integer('limit'));

  final List<T> rows;

  /// Null on the last page.
  final String? nextCursor;

  /// The page size the server applied.
  final int limit;

  bool get hasMore => nextCursor != null;

  @override
  bool operator ==(Object other) =>
      other is KeysetPage<T> && listEquals(other.rows, rows) && other.nextCursor == nextCursor && other.limit == limit;

  @override
  int get hashCode => Object.hash(listHash(rows), nextCursor, limit);
}

/// `GET /proxy/agency/my-attempts`. Contract: `AgencyAttemptsPage`.
typedef AttemptsPage = KeysetPage<AttemptRow>;

AttemptsPage decodeAttemptsPage(Map<String, Object?> json) => KeysetPage.fromJson(json, AttemptRow.fromJson);

/// The query of `GET /proxy/agency/my-attempts` (a subset of the server's
/// allow-list: paging plus a window and a campaign).
@immutable
final class AttemptsQuery {
  const AttemptsQuery({this.cursor, this.limit, this.from, this.to, this.campaignId});

  final String? cursor;
  final int? limit;
  final DateTime? from;
  final DateTime? to;
  final String? campaignId;

  Map<String, String> toQuery() => <String, String>{
    'cursor': ?cursor,
    if (limit != null) 'limit': '$limit',
    if (from != null) 'from': isoUtc(from!),
    if (to != null) 'to': isoUtc(to!),
    'campaign_id': ?campaignId,
  };

  @override
  bool operator ==(Object other) =>
      other is AttemptsQuery &&
      other.cursor == cursor &&
      other.limit == limit &&
      other.from == from &&
      other.to == to &&
      other.campaignId == campaignId;

  @override
  int get hashCode => Object.hash(cursor, limit, from, to, campaignId);
}

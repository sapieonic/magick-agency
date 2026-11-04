/// Joining a campaign, the station token, and the session-state routes.
///
/// Contract: `packages/contracts/src/agency/session.ts`,
/// `agency/actions.ts` (session state) and the console's reading in
/// `api/agency/agency.ts`.
library;

import 'package:meta/meta.dart';

import 'enums.dart';
import 'equality.dart';
import 'json.dart';
import 'station.dart';

/// `POST /proxy/agency/sessions`. The server supplies `agent_user_id` from the
/// signed-in user; the app never sends one.
///
/// Which app is joining is not in the body: the public API reads it from the
/// request's `X-Client` header (and strips any body field), and it picks the
/// `intervals` served (a phone's shorter heartbeat grace).
///
/// Contract: `AgencyCreateSessionRequest` (minus the server-injected actor,
/// `supervise` and `client_kind`).
@immutable
final class CreateSessionRequest {
  const CreateSessionRequest({required this.campaignId, this.sessionId});

  final String campaignId;

  /// Resume hint; the server rehydrates regardless.
  final String? sessionId;

  Map<String, Object?> toJson() {
    final json = <String, Object?>{'campaign_id': campaignId};
    putIfSet(json, 'session_id', sessionId);
    return json;
  }

  @override
  bool operator ==(Object other) =>
      other is CreateSessionRequest && other.campaignId == campaignId && other.sessionId == sessionId;

  @override
  int get hashCode => Object.hash(campaignId, sessionId);
}

/// One disposition the agent can choose. A disposition's `retry`/`terminal`/
/// `suppress` overrides the campaign's outcome policy.
///
/// Contract: `AgencyDisposition`.
@immutable
final class Disposition {
  const Disposition({
    required this.code,
    required this.label,
    this.isSuccess,
    this.requiresNote,
    this.requiresDatetime,
    this.terminal,
    this.suppress,
    this.retry,
    this.overrideGrant,
  });

  factory Disposition.fromJson(Map<String, Object?> j) {
    final retry = j.objOrNull('retry');
    final override = j.objOrNull('override');
    return Disposition(
      code: j.str('code'),
      label: j.str('label'),
      isSuccess: j.boolOrNull('is_success'),
      requiresNote: j.boolOrNull('requires_note'),
      requiresDatetime: j.boolOrNull('requires_datetime'),
      terminal: j.boolOrNull('terminal'),
      suppress: j.boolOrNull('suppress'),
      retry: retry == null ? null : DispositionRetry.fromJson(retry),
      overrideGrant: override == null ? null : DispositionOverride.fromJson(override),
    );
  }

  /// The three codes every catalog carries.
  static const voicemail = 'voicemail';
  static const callback = 'callback';
  static const doNotCall = 'do_not_call';

  final String code;
  final String label;
  final bool? isSuccess;

  /// Block submission until notes are non-empty.
  final bool? requiresNote;

  /// Collect a date-time; it becomes `callback_at`.
  final bool? requiresDatetime;
  final bool? terminal;
  final bool? suppress;
  final DispositionRetry? retry;

  /// What recording this outcome lets the agent override for this contact
  /// afterwards (contact assignment); null when it grants nothing.
  final DispositionOverride? overrideGrant;

  bool get noteRequired => requiresNote ?? false;
  bool get datetimeRequired => requiresDatetime ?? false;

  @override
  bool operator ==(Object other) =>
      other is Disposition &&
      other.code == code &&
      other.label == label &&
      other.isSuccess == isSuccess &&
      other.requiresNote == requiresNote &&
      other.requiresDatetime == requiresDatetime &&
      other.terminal == terminal &&
      other.suppress == suppress &&
      other.retry == retry &&
      other.overrideGrant == overrideGrant;

  @override
  int get hashCode =>
      Object.hash(code, label, isSuccess, requiresNote, requiresDatetime, terminal, suppress, retry, overrideGrant);
}

/// An outcome's override grant: what the agent may then do past the
/// campaign's rules for this one contact. At least one part is set. DNC is
/// never overridable (there is no field for it).
///
/// Contract: `AgencyDispositionOverride` (`agency/session.ts`).
@immutable
final class DispositionOverride {
  const DispositionOverride({this.extraAttempts, this.retryDelay, this.callingHours});

  factory DispositionOverride.fromJson(Map<String, Object?> j) => DispositionOverride(
    extraAttempts: j.integerOrNull('extra_attempts'),
    retryDelay: j.boolOrNull('retry_delay'),
    callingHours: j.boolOrNull('calling_hours'),
  );

  /// Contract: `AGENCY_OVERRIDE_EXTRA_ATTEMPTS_MAX`.
  static const extraAttemptsMax = 5;

  /// Dials allowed past `max_attempts` (1–[extraAttemptsMax]).
  final int? extraAttempts;

  /// One dial before the contact's next scheduled time.
  final bool? retryDelay;

  /// One dial outside the calling hours, with a note.
  final bool? callingHours;

  /// The parts this outcome grants, in the contract's order.
  List<OverrideKind> get kinds => [
    if ((extraAttempts ?? 0) > 0) OverrideKind.extraAttempts,
    if (retryDelay ?? false) OverrideKind.retryDelay,
    if (callingHours ?? false) OverrideKind.callingHours,
  ];

  @override
  bool operator ==(Object other) =>
      other is DispositionOverride &&
      other.extraAttempts == extraAttempts &&
      other.retryDelay == retryDelay &&
      other.callingHours == callingHours;

  @override
  int get hashCode => Object.hash(extraAttempts, retryDelay, callingHours);
}

/// Contract: `AgencyDisposition['retry']`.
@immutable
final class DispositionRetry {
  const DispositionRetry({this.delayMinutes, required this.maxAttempts});

  factory DispositionRetry.fromJson(Map<String, Object?> j) =>
      DispositionRetry(delayMinutes: j.integerOrNull('delay_minutes'), maxAttempts: j.integer('max_attempts'));

  final int? delayMinutes;
  final int maxAttempts;

  @override
  bool operator ==(Object other) =>
      other is DispositionRetry && other.delayMinutes == delayMinutes && other.maxAttempts == maxAttempts;

  @override
  int get hashCode => Object.hash(delayMinutes, maxAttempts);
}

/// Which of a contact's CSV columns matter, and in what order.
///
/// Contract: `AgencyContextDisplay`. [resolve] implements the resolution
/// rules the contract states, so the app and the console agree.
@immutable
final class ContextDisplay {
  ContextDisplay({List<String>? hero, List<String>? order, List<String>? hidden})
    : hero = hero == null ? null : List.unmodifiable(hero),
      order = order == null ? null : List.unmodifiable(order),
      hidden = hidden == null ? null : List.unmodifiable(hidden);

  factory ContextDisplay.fromJson(Map<String, Object?> j) =>
      ContextDisplay(hero: j.stringsOrNull('hero'), order: j.stringsOrNull('order'), hidden: j.stringsOrNull('hidden'));

  /// Pinned first, in order: what the agent reads while the phone rings.
  final List<String>? hero;

  /// Preferred order for the remaining columns.
  final List<String>? order;

  /// Never rendered, at any stage.
  final List<String>? hidden;

  /// Orders [context] (a reserved attempt's columns, in CSV order):
  /// 1. `hero` columns in array order; 2. then `order` columns; 3. then every
  /// remaining column in CSV order; minus `hidden` at every stage. A column
  /// named in `hero` but absent from [context] is skipped.
  ResolvedContext resolve(Map<String, Object?> context) {
    final hidden = this.hidden?.toSet() ?? const <String>{};
    final placed = <String>{...hidden};
    final heroOut = <MapEntry<String, Object?>>[];
    final rest = <MapEntry<String, Object?>>[];

    void take(Iterable<String>? keys, List<MapEntry<String, Object?>> into) {
      if (keys == null) return;
      for (final k in keys) {
        if (context.containsKey(k) && placed.add(k)) into.add(MapEntry(k, context[k]));
      }
    }

    take(hero, heroOut);
    take(order, rest);
    take(context.keys, rest);
    return ResolvedContext(hero: heroOut, rest: rest);
  }

  @override
  bool operator ==(Object other) =>
      other is ContextDisplay &&
      listEquals(other.hero, hero) &&
      listEquals(other.order, order) &&
      listEquals(other.hidden, hidden);

  @override
  int get hashCode => Object.hash(listHash(hero), listHash(order), listHash(hidden));
}

/// The output of [ContextDisplay.resolve].
@immutable
final class ResolvedContext {
  ResolvedContext({required List<MapEntry<String, Object?>> hero, required List<MapEntry<String, Object?>> rest})
    : hero = List.unmodifiable(hero),
      rest = List.unmodifiable(rest);

  final List<MapEntry<String, Object?>> hero;
  final List<MapEntry<String, Object?>> rest;

  static bool _same(List<MapEntry<String, Object?>> a, List<MapEntry<String, Object?>> b) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i].key != b[i].key || !jsonEquals(a[i].value, b[i].value)) return false;
    }
    return true;
  }

  static int _hash(List<MapEntry<String, Object?>> l) =>
      Object.hashAll(l.map((e) => Object.hash(e.key, jsonHash(e.value))));

  @override
  bool operator ==(Object other) => other is ResolvedContext && _same(other.hero, hero) && _same(other.rest, rest);

  @override
  int get hashCode => Object.hash(_hash(hero), _hash(rest));
}

/// A break reason the campaign offers. `POST /sessions/:id/break` accepts
/// only these codes (plus the reserved ones the server owns).
///
/// Contract: `AgencyBreakReason`.
@immutable
final class BreakReason {
  const BreakReason({required this.code, required this.label, this.isPaid});

  factory BreakReason.fromJson(Map<String, Object?> j) =>
      BreakReason(code: j.str('code'), label: j.str('label'), isPaid: j.boolOrNull('is_paid'));

  final String code;
  final String label;

  /// Advisory; stored and echoed, nothing branches on it.
  final bool? isPaid;

  @override
  bool operator ==(Object other) =>
      other is BreakReason && other.code == code && other.label == label && other.isPaid == isPaid;

  @override
  int get hashCode => Object.hash(code, label, isPaid);
}

/// The retry banner: *Retry 1 of "Q3 Winback" — these contacts were …*.
///
/// Contract: `AgencyRetryContext`.
@immutable
final class RetryContext {
  const RetryContext({required this.generation, required this.parentCampaignName, required this.selectionSummary});

  factory RetryContext.fromJson(Map<String, Object?> j) => RetryContext(
    generation: j.integer('generation'),
    parentCampaignName: j.str('parent_campaign_name'),
    selectionSummary: j.str('selection_summary'),
  );

  /// 1 = the first retry. Never 0 (the field is absent then).
  final int generation;
  final String parentCampaignName;

  /// Server-built copy; render unchanged.
  final String selectionSummary;

  @override
  bool operator ==(Object other) =>
      other is RetryContext &&
      other.generation == generation &&
      other.parentCampaignName == parentCampaignName &&
      other.selectionSummary == selectionSummary;

  @override
  int get hashCode => Object.hash(generation, parentCampaignName, selectionSummary);
}

/// Everything the station renders with, in one response to the join.
///
/// Contract: `AgencySessionBootstrap` (`agency/session.ts`), read as the
/// console reads it (`api/agency/agency.ts`): `station_token_expires_at` and
/// `intervals.deferred_hangup_ms` optional.
@immutable
final class SessionBootstrap {
  SessionBootstrap({
    required this.sessionId,
    required this.campaignId,
    required this.campaignName,
    required this.agentUserId,
    required this.state,
    String? stateRaw,
    this.breakReason,
    required this.campaignStatus,
    String? campaignStatusRaw,
    required this.stationWsUrl,
    this.stationTokenExpiresAt,
    required List<Disposition> dispositionCatalog,
    required this.wrapupSeconds,
    required this.wrapupAutoReturn,
    this.allowWrapupRedial = false,
    this.assignmentMode = AssignmentMode.pool,
    String? assignmentModeRaw,
    this.allowAgentRetry = false,
    this.queue,
    required this.recordCalls,
    required List<BreakReason> breakReasons,
    required this.contextDisplay,
    required this.intervals,
    this.retryContext,
  }) : stateRaw = stateRaw ?? state.wire,
       campaignStatusRaw = campaignStatusRaw ?? campaignStatus.wire,
       assignmentModeRaw = assignmentModeRaw ?? assignmentMode.wire,
       dispositionCatalog = List.unmodifiable(dispositionCatalog),
       breakReasons = List.unmodifiable(breakReasons);

  factory SessionBootstrap.fromJson(Map<String, Object?> j) {
    final state = j.str('state');
    final status = j.str('campaign_status');
    final retry = j.objOrNull('retry_context');
    final mode = j.strOrNull('assignment_mode');
    final queue = j.objOrNull('queue');
    return SessionBootstrap(
      sessionId: j.str('session_id'),
      campaignId: j.str('campaign_id'),
      campaignName: j.str('campaign_name'),
      agentUserId: j.str('agent_user_id'),
      state: AgentState.fromWire(state),
      stateRaw: state,
      breakReason: j.strOrNull('break_reason'),
      campaignStatus: CampaignStatus.fromWire(status),
      campaignStatusRaw: status,
      stationWsUrl: j.str('station_ws_url'),
      stationTokenExpiresAt: j.timeOrNull('station_token_expires_at'),
      dispositionCatalog: j.list('disposition_catalog', Disposition.fromJson),
      wrapupSeconds: j.integer('wrapup_seconds'),
      wrapupAutoReturn: j.boolean('wrapup_auto_return'),
      allowWrapupRedial: j.boolOrNull('allow_wrapup_redial') ?? false,
      assignmentMode: mode == null ? AssignmentMode.pool : AssignmentMode.fromWire(mode),
      assignmentModeRaw: mode ?? AssignmentMode.pool.wire,
      allowAgentRetry: j.boolOrNull('allow_agent_retry') ?? false,
      queue: queue == null ? null : QueueState.fromJson(queue),
      recordCalls: j.boolean('record_calls'),
      breakReasons: j.list('break_reasons', BreakReason.fromJson),
      contextDisplay: ContextDisplay.fromJson(j.obj('context_display')),
      intervals: StationIntervals.fromJson(j.obj('intervals')),
      retryContext: retry == null ? null : RetryContext.fromJson(retry),
    );
  }

  final String sessionId;
  final String campaignId;
  final String campaignName;
  final String agentUserId;

  /// `offline` on a first join; `break` after a restart (one click to go
  /// available).
  final AgentState state;
  final String stateRaw;

  /// The break's code when [state] is `break`: a `break_reasons` code or a
  /// [ReservedBreakCode] (`device_away` after the app was killed while
  /// paused). Null when not on break, on a break with no recorded reason, or
  /// from a server older than the field.
  final String? breakReason;
  final CampaignStatus campaignStatus;
  final String campaignStatusRaw;

  /// The station socket's URL with its token appended. A **relative** path
  /// behind the public API (`/proxy/agency/station/<session id>?token=…`):
  /// prefix the environment's `wss://` origin.
  final String stationWsUrl;

  /// When the embedded single-use token expires (~2 minutes).
  final DateTime? stationTokenExpiresAt;
  final List<Disposition> dispositionCatalog;

  /// Seconds of wrap-up; `0` means no timer (not no wrap-up).
  final int wrapupSeconds;
  final bool wrapupAutoReturn;

  /// Whether the campaign lets the agent redial the customer from wrap-up,
  /// as it stood at join. Absent (an older server) reads as false. The
  /// `wrapup` frame's `redial_remaining` is the live answer for one wrap-up.
  final bool allowWrapupRedial;

  /// How pacing pairs this campaign's contacts with agents. Absent (an older
  /// server) reads as [AssignmentMode.pool]; a mode this build does not know
  /// is [AssignmentMode.unknown] with the wire string in [assignmentModeRaw].
  final AssignmentMode assignmentMode;
  final String assignmentModeRaw;

  /// Whether the agent may retry the contacts they did not reach. Absent
  /// reads as false.
  final bool allowAgentRetry;

  /// This agent's queue at join, on a `strict` or `preferred` campaign; null
  /// in `pool` mode. The station's `queue` frame carries every later change.
  final QueueState? queue;

  /// Whether calls are recorded: the app must disclose it.
  final bool recordCalls;
  final List<BreakReason> breakReasons;
  final ContextDisplay contextDisplay;
  final StationIntervals intervals;

  /// Present only on a retry campaign.
  final RetryContext? retryContext;

  /// The catalog entry for [code], or null for a code this catalog lacks
  /// (a parent campaign's code on a prior attempt).
  Disposition? dispositionFor(String code) {
    for (final d in dispositionCatalog) {
      if (d.code == code) return d;
    }
    return null;
  }

  @override
  bool operator ==(Object other) =>
      other is SessionBootstrap &&
      other.sessionId == sessionId &&
      other.campaignId == campaignId &&
      other.campaignName == campaignName &&
      other.agentUserId == agentUserId &&
      other.stateRaw == stateRaw &&
      other.breakReason == breakReason &&
      other.campaignStatusRaw == campaignStatusRaw &&
      other.stationWsUrl == stationWsUrl &&
      other.stationTokenExpiresAt == stationTokenExpiresAt &&
      listEquals(other.dispositionCatalog, dispositionCatalog) &&
      other.wrapupSeconds == wrapupSeconds &&
      other.wrapupAutoReturn == wrapupAutoReturn &&
      other.allowWrapupRedial == allowWrapupRedial &&
      other.assignmentModeRaw == assignmentModeRaw &&
      other.allowAgentRetry == allowAgentRetry &&
      other.queue == queue &&
      other.recordCalls == recordCalls &&
      listEquals(other.breakReasons, breakReasons) &&
      other.contextDisplay == contextDisplay &&
      other.intervals == intervals &&
      other.retryContext == retryContext;

  @override
  int get hashCode => Object.hashAll(<Object?>[
    sessionId,
    campaignId,
    campaignName,
    agentUserId,
    stateRaw,
    breakReason,
    campaignStatusRaw,
    stationWsUrl,
    stationTokenExpiresAt,
    listHash(dispositionCatalog),
    wrapupSeconds,
    wrapupAutoReturn,
    allowWrapupRedial,
    assignmentModeRaw,
    allowAgentRetry,
    queue,
    recordCalls,
    listHash(breakReasons),
    contextDisplay,
    intervals,
    retryContext,
  ]);
}

/// `POST /proxy/agency/sessions/:id/station-token`: a fresh single-use
/// upgrade token. Mint one per connect attempt; a new mint replaces the old.
///
/// Contract: `AgencyStationTokenResponse`.
@immutable
final class StationTokenResponse {
  const StationTokenResponse({required this.sessionId, required this.stationWsUrl, required this.expiresAt});

  factory StationTokenResponse.fromJson(Map<String, Object?> j) => StationTokenResponse(
    sessionId: j.str('session_id'),
    stationWsUrl: j.str('station_ws_url'),
    expiresAt: j.time('expires_at'),
  );

  final String sessionId;

  /// Relative path with the token; prefix the `wss://` origin.
  final String stationWsUrl;
  final DateTime expiresAt;

  @override
  bool operator ==(Object other) =>
      other is StationTokenResponse &&
      other.sessionId == sessionId &&
      other.stationWsUrl == stationWsUrl &&
      other.expiresAt == expiresAt;

  @override
  int get hashCode => Object.hash(sessionId, stationWsUrl, expiresAt);
}

/// `POST /proxy/agency/sessions/:id/break`.
///
/// Contract: `AgencySessionBreakRequest`.
@immutable
final class SessionBreakRequest {
  const SessionBreakRequest(this.reason);

  /// The reserved break the app takes when it leaves the foreground while
  /// `available` (`DEVICE_AWAY_BREAK_REASON`).
  SessionBreakRequest.deviceAway() : reason = ReservedBreakCode.deviceAway.wire;

  /// A `code` from the bootstrap's `break_reasons`, or a reserved code.
  final String reason;

  Map<String, Object?> toJson() => <String, Object?>{'reason': reason};

  @override
  bool operator ==(Object other) => other is SessionBreakRequest && other.reason == reason;

  @override
  int get hashCode => reason.hashCode;
}

/// The answer to every session-state transition: `available`, `break`,
/// `break/cancel` and `leave` (all `POST`, no body except `break`).
///
/// Contract: `AgencySessionStateResponse`, read as the console reads it:
/// `pending_state` and `break_reason` may also be null.
@immutable
final class SessionStateResponse {
  SessionStateResponse({
    this.campaignId,
    required this.sessionId,
    required this.kind,
    String? kindRaw,
    required this.state,
    String? stateRaw,
    required this.since,
    this.pendingState,
    String? pendingStateRaw,
    this.breakReason,
  }) : kindRaw = kindRaw ?? kind.wire,
       stateRaw = stateRaw ?? state.wire,
       pendingStateRaw = pendingStateRaw ?? pendingState?.wire;

  factory SessionStateResponse.fromJson(Map<String, Object?> j) {
    final kind = j.str('kind');
    final state = j.str('state');
    final pending = j.strOrNull('pending_state');
    return SessionStateResponse(
      campaignId: j.strOrNull('campaign_id'),
      sessionId: j.str('session_id'),
      kind: SessionKind.fromWire(kind),
      kindRaw: kind,
      state: AgentState.fromWire(state),
      stateRaw: state,
      since: j.time('since'),
      pendingState: pending == null ? null : AgentState.fromWire(pending),
      pendingStateRaw: pending,
      breakReason: j.strOrNull('break_reason'),
    );
  }

  /// Null for a soft-phone session.
  final String? campaignId;
  final String sessionId;
  final SessionKind kind;
  final String kindRaw;

  /// Reconciliation only: the station's `agent_state` frames are the authority.
  final AgentState state;
  final String stateRaw;
  final DateTime since;

  /// Set when the transition was queued (a break asked for mid-call).
  final AgentState? pendingState;
  final String? pendingStateRaw;

  /// The break's code, for both "on break" and "break queued" (`pending_state`
  /// tells them apart). Not `pending_break_reason`: the HTTP body never has it.
  final String? breakReason;

  @override
  bool operator ==(Object other) =>
      other is SessionStateResponse &&
      other.campaignId == campaignId &&
      other.sessionId == sessionId &&
      other.kindRaw == kindRaw &&
      other.stateRaw == stateRaw &&
      other.since == since &&
      other.pendingStateRaw == pendingStateRaw &&
      other.breakReason == breakReason;

  @override
  int get hashCode => Object.hash(campaignId, sessionId, kindRaw, stateRaw, since, pendingStateRaw, breakReason);
}

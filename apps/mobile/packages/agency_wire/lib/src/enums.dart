/// The closed string vocabularies of the contract, as Dart enums.
///
/// Each enum has an `unknown` member for a value this build does not
/// recognise, so a literal the server adds later decodes instead of failing
/// the whole payload; the model keeps the raw string beside the enum
/// (`stateRaw`, `reasonRaw`, ...) for logs and fallback copy.
///
/// `test/literals_test.dart` checks every wire enum of this package (these, plus
/// `StationEvent`, `AgencyErrorCode`, `SoftphoneErrorCode`, `InboundErrorCode`,
/// `SessionRefusalCode` and the station close codes) against
/// `packages/contracts/fixtures/agent/literals.json`, which is extracted from the TypeScript sources: each TypeScript literal must be a
/// value here, and, where the enum mirrors its vocabulary one to one or the app
/// sends the value, each value here must still be a TypeScript literal.
library;

/// A member of a wire vocabulary. [wire] is the exact string on the wire;
/// it is empty only for `unknown`.
abstract interface class WireEnum {
  String get wire;
}

extension WireEnumUnknown on WireEnum {
  bool get isUnknown => wire.isEmpty;
}

/// Internal: the `wire → member` index each enum looks values up in.
Map<String, E> wireIndex<E extends WireEnum>(List<E> values) => Map<String, E>.unmodifiable(<String, E>{
  for (final v in values)
    if (v.wire.isNotEmpty) v.wire: v,
});

/// Contract: `AgencyAgentState` (`agency/enums.ts`).
enum AgentState implements WireEnum {
  offline('offline'),
  available('available'),
  reserved('reserved'),
  onCall('on_call'),
  wrapup('wrapup'),

  /// `break`, a reserved word in Dart.
  onBreak('break'),
  unknown('');

  const AgentState(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static AgentState fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// Contract: `AgencyAttemptState` (`agency/enums.ts`). `ended` is the single terminal state.
enum AttemptState implements WireEnum {
  queued('queued'),
  dialing('dialing'),
  ringing('ringing'),
  answered('answered'),
  bridged('bridged'),
  ended('ended'),
  unknown('');

  const AttemptState(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static AttemptState fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// Contract: `AgencyAttemptOutcome` (`agency/enums.ts`).
enum AttemptOutcome implements WireEnum {
  connected('connected'),
  noAnswer('no_answer'),
  busy('busy'),
  failed('failed'),
  machine('machine'),
  invalid('invalid'),
  abandoned('abandoned'),
  agentDisconnected('agent_disconnected'),
  orphaned('orphaned'),
  canceled('canceled'),
  unknown('');

  const AttemptOutcome(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static AttemptOutcome fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// Contract: `AgencyContactState` (`agency/enums.ts`).
enum ContactState implements WireEnum {
  pending('pending'),
  inFlight('in_flight'),
  connected('connected'),
  completed('completed'),
  exhausted('exhausted'),
  suppressed('suppressed'),
  unknown('');

  const ContactState(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static ContactState fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// Contract: `AgencyCampaignStatus` (`agency/enums.ts`).
enum CampaignStatus implements WireEnum {
  draft('draft'),
  running('running'),
  paused('paused'),
  stopping('stopping'),
  completed('completed'),
  stopped('stopped'),
  unknown('');

  const CampaignStatus(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static CampaignStatus fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// Contract: `AgencyReleaseReason` (`agency/station.ts`). An unknown reason
/// must fall back to the frame's `message`, never blank the panel.
enum ReleaseReason implements WireEnum {
  completed('completed'),
  noAnswer('no_answer'),
  busy('busy'),
  failed('failed'),
  invalid('invalid'),
  abandoned('abandoned'),
  agentDisconnected('agent_disconnected'),
  reservationExpired('reservation_expired'),
  agentHangup('agent_hangup'),
  remoteHangup('remote_hangup'),
  campaignPaused('campaign_paused'),
  campaignStopped('campaign_stopped'),
  supervisorReleased('supervisor_released'),
  orphaned('orphaned'),

  /// The customer rang in while the dial still rang them: the dial was cancelled. No disposition.
  inboundCall('inbound_call'),
  unknown('');

  const ReleaseReason(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static ReleaseReason fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// Contract: `AgencyCampaignChangeReason` (`agency/station.ts`).
enum CampaignChangeReason implements WireEnum {
  listExhausted('list_exhausted'),
  pausedBySupervisor('paused_by_supervisor'),
  stoppedBySupervisor('stopped_by_supervisor'),
  autoPaused('auto_paused'),
  resumed('resumed'),
  started('started'),
  unknown('');

  const CampaignChangeReason(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static CampaignChangeReason fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// Contract: `AgencyStationErrorCode` (`agency/station.ts`).
enum StationErrorCode implements WireEnum {
  unauthorized('unauthorized'),
  unknownAttempt('unknown_attempt'),
  notYourAttempt('not_your_attempt'),
  invalidFrame('invalid_frame'),
  campaignNotRunning('campaign_not_running'),
  unknown('');

  const StationErrorCode(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static StationErrorCode fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// Contract: `AgencyStationBridgeStatusFrame['status']` (`agency/station.ts`).
/// Describes the media leg, not the attempt: diagnostic only.
enum BridgeStatus implements WireEnum {
  initiating('initiating'),
  ringing('ringing'),
  inProgress('in_progress'),
  completed('completed'),
  failed('failed'),
  noAnswer('no_answer'),
  busy('busy'),
  canceled('canceled'),
  answered('answered'),
  ending('ending'),
  unknown('');

  const BridgeStatus(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static BridgeStatus fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// Contract: `AgencyWrapupHoldReason` (`agency/actions.ts`).
enum WrapupHoldReason implements WireEnum {
  dispositionRequired('disposition_required'),
  supervisorHold('supervisor_hold'),
  unknown('');

  const WrapupHoldReason(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static WrapupHoldReason fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// Contract: `AgencyDncScope` (`agency/actions.ts`). An agent only ever marks
/// `campaign`; `tenant` is the supervisor's escalation.
enum DncScope implements WireEnum {
  campaign('campaign'),
  tenant('tenant'),
  unknown('');

  const DncScope(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static DncScope fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// Contract: `AgencySessionKind` (`agency/softphone.ts`).
enum SessionKind implements WireEnum {
  campaign('campaign'),
  softphone('softphone'),
  unknown('');

  const SessionKind(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static SessionKind fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// Break codes the server reserves: entered through their own routes, never
/// offered in a campaign's `break_reasons`.
///
/// Contract: `RESERVED_BREAK_REASONS` (`agency/breaks.ts`): `soft_phone`
/// (`SOFTPHONE_BREAK_REASON`), `device_away` (`DEVICE_AWAY_BREAK_REASON`, the
/// break the app takes when it leaves the foreground while `available`) and
/// `phone_call` (`PHONE_CALL_BREAK_REASON`, IQ51: the break the app takes for
/// the length of a cellular call that starts while `available`) and `away_ring`
/// (`AWAY_RING_BREAK_REASON`, IQ58: Mode B's away break, whose phone rings for
/// inbound callers).
enum ReservedBreakCode implements WireEnum {
  softPhone('soft_phone'),
  deviceAway('device_away'),

  /// IQ51: on a cellular call. Asked like [deviceAway] (the server's same
  /// rules), lifted by the ordinary `/available` when the call ends; supervisors
  /// see "On a phone call".
  phoneCall('phone_call'),

  /// IQ58 (Mode B): asked instead of [deviceAway] when the agent opted in to
  /// having this phone rung for inbound calls. Refused 409 with an
  /// `AwayRingRefusalCode` (then the app falls back to [deviceAway]);
  /// supervisors see "Away · rings for inbound".
  awayRing('away_ring'),
  unknown('');

  const ReservedBreakCode(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);

  /// The reserved code [raw] names, or null for an ordinary campaign break reason.
  static ReservedBreakCode? tryFromWire(String? raw) => _byWire[raw];
}

/// Which client a session or socket belongs to.
///
/// Contract: `AgencyClientKind` / `AGENCY_CLIENT_KINDS` (`agency/station.ts`).
/// The app sends `mobile` as the station upgrade's `client=`.
enum ClientKind implements WireEnum {
  web('web'),
  mobile('mobile'),
  unknown('');

  const ClientKind(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static ClientKind fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// The station socket's media encoding, chosen by the upgrade's `media=` query
/// parameter.
///
/// Contract: `AgencyStationMediaFormat` / `AGENCY_STATION_MEDIA_FORMATS`
/// (`agency/station.ts`). The app sends `alaw8`.
enum MediaFormat implements WireEnum {
  /// JSON text frames `{event:'media', media:{payload}}`, base64 PCM16LE at 16 kHz.
  pcm16('pcm16', sampleRate: 16000, bytesPerFrame: 640),

  /// Binary frames of raw G.711 A-law at 8 kHz mono, no JSON.
  alaw8('alaw8', sampleRate: 8000, bytesPerFrame: 160),
  unknown('', sampleRate: 0, bytesPerFrame: 0);

  const MediaFormat(this.wire, {required this.sampleRate, required this.bytesPerFrame});
  @override
  final String wire;
  final int sampleRate;

  /// Bytes in one 20 ms frame, before any base64.
  final int bytesPerFrame;

  static const frameDuration = Duration(milliseconds: 20);

  static final _byWire = wireIndex(values);
  static MediaFormat fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// Contract: `StatsBucketUnit` / `STATS_BUCKET_UNITS` (`primitives.ts`).
enum StatsBucketUnit implements WireEnum {
  day('day'),
  week('week'),
  month('month'),
  unknown('');

  const StatsBucketUnit(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static StatsBucketUnit fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// Contract: `Role` (`rbac.ts`).
enum Role implements WireEnum {
  agent('agent'),
  viewer('viewer'),
  operator('operator'),
  accountAdmin('account_admin'),
  tenantAdmin('tenant_admin'),
  tenantOwner('tenant_owner'),
  unknown('');

  const Role(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static Role fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// Contract: `User['status']` (`api/platform/auth.ts`).
enum UserStatus implements WireEnum {
  active('active'),
  inactive('inactive'),
  deleted('deleted'),
  unknown('');

  const UserStatus(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static UserStatus fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// Contract: `Tenant['status']` (`api/platform/auth.ts`).
enum TenantStatus implements WireEnum {
  active('active'),
  suspended('suspended'),
  deleted('deleted'),
  unknown('');

  const TenantStatus(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static TenantStatus fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// Contract: `Membership['status']` (`api/platform/auth.ts`).
enum MembershipStatus implements WireEnum {
  active('active'),
  inactive('inactive'),
  revoked('revoked'),
  unknown('');

  const MembershipStatus(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static MembershipStatus fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// An invitation's status, as `GET /invites/:token` and the claim refusals
/// report it. Contract: `'pending'`, `InviteUnavailableStatus` and
/// `InviteClaimRefusalStatus` (`api/platform/invite.ts`).
enum InviteStatus implements WireEnum {
  pending('pending'),
  claimed('claimed'),
  expired('expired'),
  revoked('revoked'),
  notFound('not_found'),
  identityAlreadyBound('identity_already_bound'),

  /// A claim refusal about the signing-in account; the invitation stays usable.
  identityInUse('identity_in_use'),

  /// A claim refusal: this role must be claimed at the invited address.
  addressRequired('address_required'),
  unknown('');

  const InviteStatus(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static InviteStatus fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// Contract: `NotificationCadence` (`api/platform/notifications.ts`).
enum NotificationCadence implements WireEnum {
  immediate('immediate'),
  digest('digest'),
  unknown('');

  const NotificationCadence(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static NotificationCadence fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// Contract: `NotificationFrequency` (`api/platform/notifications.ts`).
enum NotificationFrequency implements WireEnum {
  daily('daily'),
  weekly('weekly'),
  unknown('');

  const NotificationFrequency(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static NotificationFrequency fromWire(String? raw) => _byWire[raw] ?? unknown;
}

// ─── The soft phone (`agency/softphone.ts`) ─────────────────────────────────
//
// A manual call's `state` and `outcome` are the attempt vocabularies unchanged
// (`AgencyManualCallState = AgencyAttemptState`), so they decode as
// [AttemptState] and [AttemptOutcome].

/// Why a manual call ended: the members of the station's release vocabulary a
/// call outside pacing can reach.
///
/// Contract: `AgencyManualCallEndReason` / `AGENCY_MANUAL_CALL_END_REASONS`.
enum ManualCallEndReason implements WireEnum {
  completed('completed'),
  noAnswer('no_answer'),
  busy('busy'),
  failed('failed'),
  invalid('invalid'),
  agentDisconnected('agent_disconnected'),
  agentHangup('agent_hangup'),
  remoteHangup('remote_hangup'),
  supervisorReleased('supervisor_released'),
  orphaned('orphaned'),
  unknown('');

  const ManualCallEndReason(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static ManualCallEndReason fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// Which catalog a manual call's outcome was saved against: the tagged
/// campaign's, or the soft phone's own (an untagged call).
///
/// Contract: `AgencyManualCallDispositionSource` / `AGENCY_MANUAL_CALL_DISPOSITION_SOURCES`.
enum DispositionSource implements WireEnum {
  campaign('campaign'),
  softphone('softphone'),
  unknown('');

  const DispositionSource(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static DispositionSource fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// The value type of a call field. A field of a type this build does not
/// know is shown read-only, never dropped (its value still travels).
///
/// Contract: `AgencyCallFieldType` / `AGENCY_CALL_FIELD_TYPES`.
enum CallFieldType implements WireEnum {
  text('text'),
  number('number'),
  choice('choice'),
  boolean('boolean'),

  /// An ISO calendar date, `YYYY-MM-DD`.
  date('date'),
  unknown('');

  const CallFieldType(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static CallFieldType fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// How far a DNC entry reaches: the whole tenant, one account, or one campaign.
/// Not [DncScope], which is what the STATION's mark accepts (`campaign|tenant`).
///
/// Contract: `AgencyDncEntryScope`.
enum DncEntryScope implements WireEnum {
  tenant('tenant'),
  account('account'),
  campaign('campaign'),
  unknown('');

  const DncEntryScope(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static DncEntryScope fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// The soft-phone call list's `status=` filter. The app sends these.
///
/// Contract: `AgencyManualCallListQuery['status']`.
enum ManualCallListStatus implements WireEnum {
  /// Not ended.
  live('live'),

  /// Ended, and its outcome is still owed.
  awaitingOutcome('awaiting_outcome'),
  settled('settled'),
  unknown('');

  const ManualCallListStatus(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static ManualCallListStatus fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// Whose timezone a calling-hours refusal was judged in: the matched
/// contact's, or the campaign's default.
///
/// Contract: `AgencySoftphoneOutsideHoursRefusal['timezone_source']`.
enum HoursTimezoneSource implements WireEnum {
  contact('contact'),
  campaignDefault('campaign_default'),
  unknown('');

  const HoursTimezoneSource(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static HoursTimezoneSource fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// Whether a call's media leg still exists, on a call detail.
///
/// Contract: `AgencyCallAvailability` (`api/agency/attempt-call.ts`).
enum CallAvailability implements WireEnum {
  available('available'),
  purged('purged'),

  /// Refused or failed before the media leg was created.
  neverPlaced('never_placed'),
  unknown('');

  const CallAvailability(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static CallAvailability fromWire(String? raw) => _byWire[raw] ?? unknown;
}

// ─── Contact assignment (`agency/assignment.ts`, `api/agency/assignment.ts`) ─

/// How pacing pairs a campaign's contacts with agents. An absent mode (a
/// server older than contact assignment) reads as [pool].
///
/// Contract: `AgencyAssignmentMode` / `AGENCY_ASSIGNMENT_MODES` (`agency/assignment.ts`).
enum AssignmentMode implements WireEnum {
  /// One shared queue; the owner is ignored.
  pool('pool'),

  /// The agent is dialled only the contacts assigned to them.
  strict('strict'),

  /// Their own due contacts first, then unassigned ones; never another agent's.
  preferred('preferred'),
  unknown('');

  const AssignmentMode(this.wire);
  @override
  final String wire;

  /// Whether the agent has a queue of their own (and so a queue state).
  bool get hasOwnQueue => this == strict || this == preferred;

  static final _byWire = wireIndex(values);
  static AssignmentMode fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// Why an agent on a `strict` or `preferred` campaign has nothing to dial now.
///
/// Contract: `AgencyQueueIdleReason` (`agency/station.ts`).
enum QueueIdleReason implements WireEnum {
  /// Nothing open is assigned to them (in `preferred`, nothing in the pool either).
  queueEmpty('queue_empty'),

  /// Their open contacts are all scheduled later by the retry policy.
  waitingForRetry('waiting_for_retry'),

  /// Their open contacts are all callbacks booked for later.
  callbacksLater('callbacks_later'),

  /// The campaign's calling window is closed now.
  outsideCallingHours('outside_calling_hours'),
  unknown('');

  const QueueIdleReason(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static QueueIdleReason fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// The parts of an outcome's override a dial can spend.
///
/// Contract: `AgencyOverrideKind` / `AGENCY_OVERRIDE_KINDS` (`agency/session.ts`).
enum OverrideKind implements WireEnum {
  /// Dials allowed past the retry policy's `max_attempts`.
  extraAttempts('extra_attempts'),

  /// One dial before the contact's next scheduled time.
  retryDelay('retry_delay'),

  /// One dial outside the calling hours, with a note.
  callingHours('calling_hours'),
  unknown('');

  const OverrideKind(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static OverrideKind fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// Where one of the agent's contacts stands. The app sends these as the
/// `bucket=` filter of `GET /my-contacts`.
///
/// Contract: `AgencyMyContactBucket` / `AGENCY_MY_CONTACT_BUCKETS` (`api/agency/assignment.ts`).
enum MyContactBucket implements WireEnum {
  /// Open, never attempted, not a callback.
  pending('pending'),

  /// Open; its last outcome booked a callback.
  callback('callback'),

  /// Open, attempted, scheduled for another try.
  notReached('not_reached'),

  /// On a call or awaiting its write-up.
  inProgress('in_progress'),

  /// Done.
  reached('reached'),

  /// The retry policy's attempts are spent.
  exhausted('exhausted'),

  /// DNC or otherwise suppressed; never dialled again.
  suppressed('suppressed'),
  unknown('');

  const MyContactBucket(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static MyContactBucket fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// Why a contact cannot be retried by its agent now.
///
/// Contract: `AgencyAgentRetryBlock` / `AGENCY_AGENT_RETRY_BLOCKS` (`api/agency/assignment.ts`).
enum AgentRetryBlock implements WireEnum {
  /// The campaign does not allow agent retry.
  retryDisabled('retry_disabled'),

  /// Not a contact that was not reached (pending, reached, on a call, ...).
  notRetryable('not_retryable'),

  /// Already reopened `agent_retry_rounds` times.
  roundsUsed('rounds_used'),

  /// Its last attempt is too recent; `available_at` says when.
  cooldown('cooldown'),

  /// DNC or suppressed; never.
  suppressed('suppressed'),
  unknown('');

  const AgentRetryBlock(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static AgentRetryBlock fromWire(String? raw) => _byWire[raw] ?? unknown;
}

// ─── Customer history (`api/agency/customer-history.ts`) ────────────────────

/// What a customer search is keyed by. v1: the phone number only (CH3). The
/// app sends `phone`.
///
/// Contract: `CustomerSearchBy` / `CUSTOMER_SEARCH_BYS`.
enum CustomerSearchBy implements WireEnum {
  phone('phone'),
  unknown('');

  const CustomerSearchBy(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static CustomerSearchBy fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// Which channel a call to the number came through. The app sends these as
/// the timeline's `channel` filter.
///
/// Contract: `CustomerTimelineChannel` / `CUSTOMER_TIMELINE_CHANNELS`.
enum CustomerTimelineChannel implements WireEnum {
  campaign('campaign'),
  softphone('softphone'),
  unknown('');

  const CustomerTimelineChannel(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static CustomerTimelineChannel fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// What one timeline entry is. An entry of a kind this build does not know
/// decodes as `CustomerTimelineUnknownEntry`, never an error.
///
/// Contract: `CustomerTimelineKind` / `CUSTOMER_TIMELINE_KINDS`.
enum CustomerTimelineKind implements WireEnum {
  campaignCall('campaign_call'),
  softphoneCall('softphone_call'),
  callback('callback'),
  dncMark('dnc_mark'),
  rosterEntry('roster_entry'),
  unknown('');

  const CustomerTimelineKind(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static CustomerTimelineKind fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// What a call's recording looks like from the history. `expired` is
/// "Recording expired" (deleted by retention), never a broken player.
///
/// Contract: `CustomerRecordingState` / `CUSTOMER_RECORDING_STATES`.
enum CustomerRecordingState implements WireEnum {
  available('available'),
  notRecorded('not_recorded'),
  expired('expired'),

  /// Nothing was placed (no media leg).
  noCall('no_call'),
  unknown('');

  const CustomerRecordingState(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static CustomerRecordingState fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// Whether a booked callback was kept: judged by the next call placed to the
/// number after it was booked, with a 15-minute window.
///
/// Contract: `CustomerCallbackStatus` / `CUSTOMER_CALLBACK_STATUSES`.
enum CustomerCallbackStatus implements WireEnum {
  /// Dialled within 15 minutes of its time.
  kept('kept'),

  /// `late`, a built-in identifier in Dart: dialled, but more than 15 minutes
  /// after its time.
  keptLate('late'),

  /// Not dialled, and more than 15 minutes past its time.
  missed('missed'),

  /// Not yet due.
  upcoming('upcoming'),

  /// Due now: within 15 minutes after its time.
  due('due'),
  unknown('');

  const CustomerCallbackStatus(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static CustomerCallbackStatus fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// Why a searched number was refused (`400 invalid_number`'s `number_error`,
/// and the app's own preview, `parseSearchNumber`).
///
/// Contract: `CustomerSearchNumberError` / `CUSTOMER_SEARCH_NUMBER_ERRORS`.
enum CustomerSearchNumberError implements WireEnum {
  empty('empty'),
  invalidCharacters('invalid_characters'),

  /// Excel's scientific notation (`9.18765E+11`).
  spreadsheetNumber('spreadsheet_number'),

  /// Shorter than the country's national number: full numbers only (CH4).
  tooShort('too_short'),
  invalidForCountry('invalid_for_country'),
  unknown('');

  const CustomerSearchNumberError(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static CustomerSearchNumberError fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// The customer-history routes' refusal codes (`400` unless noted).
///
/// Contract: `CustomerHistoryErrorCode` / `CUSTOMER_HISTORY_ERROR_CODES`.
enum CustomerHistoryErrorCode implements WireEnum {
  /// The number could not be read; `number_error` says why.
  invalidNumber('invalid_number'),

  /// A malformed body (an unknown `by`, a bad filter, a `limit` out of range).
  invalidSearchRequest('invalid_search_request'),

  /// A `cursor` this server did not mint.
  invalidCursor('invalid_cursor'),

  /// `404`: the `search_id` is unknown, expired, or another user's. Search again.
  searchExpired('search_expired'),
  unknown('');

  const CustomerHistoryErrorCode(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static CustomerHistoryErrorCode fromWire(String? raw) => _byWire[raw] ?? unknown;
}

// ─── Inbound calls (`agency/inbound.ts`, `api/agency/inbound.ts`) ──────────

/// Where an inbound call is. A station only ever sees `offered`, `connected`
/// and `ended` (a call reaches it once offered to it); the earlier states are
/// listed so the vocabulary mirrors the contract.
///
/// Contract: `AgencyInboundCallState` / `AGENCY_INBOUND_CALL_STATES`.
enum InboundCallState implements WireEnum {
  arrived('arrived'),
  greeting('greeting'),
  queued('queued'),

  /// The panel is up; audio binds at the call's `connects_at`.
  offered('offered'),

  /// Bridged: audio both ways.
  connected('connected'),

  /// Terminal.
  ended('ended'),
  unknown('');

  const InboundCallState(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static InboundCallState fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// How an inbound call ended (set exactly when `ended`). A call a station
/// held ends `answered`; the others are what a Missed row's call ended as.
///
/// Contract: `AgencyInboundCallOutcome` / `AGENCY_INBOUND_CALL_OUTCOMES`.
enum InboundCallOutcome implements WireEnum {
  answered('answered'),
  abandonedInQueue('abandoned_in_queue'),
  overflow('overflow'),
  overflowNoCapacity('overflow_no_capacity'),
  closed('closed'),
  voicemail('voicemail'),
  rejected('rejected'),
  failed('failed'),
  unknown('');

  const InboundCallOutcome(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static InboundCallOutcome fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// Which signal named the caller's sticky agent.
///
/// Contract: `AgencyInboundStickyReason` / `AGENCY_INBOUND_STICKY_REASONS`.
enum InboundStickyReason implements WireEnum {
  /// The matched contact is this agent's (contact assignment).
  owner('owner'),

  /// The agent's latest call to the number went out from the number rung.
  lastFromNumber('last_from_number'),

  /// The last agent who spoke to the customer.
  lastConnected('last_connected'),

  /// The last agent who dialled them, unanswered.
  lastDialled('last_dialled'),
  unknown('');

  const InboundStickyReason(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static InboundStickyReason fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// Which catalog an inbound call's outcome panel offers: the matched
/// campaign's, the route's own, or the built-in one (a route with none).
///
/// Contract: `AgencyInboundCatalogSource` / `AGENCY_INBOUND_CATALOG_SOURCES`.
enum InboundCatalogSource implements WireEnum {
  campaign('campaign'),
  route('route'),
  builtin('builtin'),
  unknown('');

  const InboundCatalogSource(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static InboundCatalogSource fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// Why a call on the Missed list reached nobody. The app also SENDS these as
/// the list's `reason=` filter.
///
/// Contract: `AgencyInboundMissedReason` / `AGENCY_INBOUND_MISSED_REASONS`.
enum InboundMissedReason implements WireEnum {
  /// Answered as closed: [InboundClosedCause] says why.
  closed('closed'),

  /// The caller hung up while waiting.
  abandonedInQueue('abandoned_in_queue'),

  /// Nobody free to answer (the wait or queue limit, or nobody in the pool).
  overflow('overflow'),

  /// All lines busy (over the route's or the account's call limits).
  overflowNoCapacity('overflow_no_capacity'),

  /// Our side could not serve the call.
  failed('failed'),
  unknown('');

  const InboundMissedReason(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static InboundMissedReason fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// A Missed row's status. The app also SENDS these as the list's `status=`
/// filter (the server's default is `open`).
///
/// Contract: `AgencyInboundFollowUpStatus` / `AGENCY_INBOUND_FOLLOW_UP_STATUSES`.
enum InboundFollowUpStatus implements WireEnum {
  open('open'),
  handled('handled'),
  unknown('');

  const InboundFollowUpStatus(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static InboundFollowUpStatus fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// How a Missed row was handled: `marked` by a person, or `reached` (the
/// customer was put through to an agent of the account afterwards).
///
/// Contract: `AgencyInboundHandledReason` / `AGENCY_INBOUND_HANDLED_REASONS`.
enum InboundHandledReason implements WireEnum {
  marked('marked'),
  reached('reached'),
  unknown('');

  const InboundHandledReason(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static InboundHandledReason fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// Why a `closed` Missed row's caller was answered as closed.
///
/// Contract: `AgencyInboundClosedCause` / `AGENCY_INBOUND_CLOSED_CAUSES`.
enum InboundClosedCause implements WireEnum {
  /// Outside the route's opening hours, or on a holiday.
  hours('hours'),

  /// The account's inbound flag is off.
  switchedOff('switched_off'),

  /// The number rung reaches no route.
  noRoute('no_route'),

  /// The carrier credential the call arrived on is not active.
  credentialInactive('credential_inactive'),
  unknown('');

  const InboundClosedCause(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static InboundClosedCause fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// Which rule refused an inbound call's outcome (`inbound_disposition_invalid`'s
/// `reason`): the soft phone's four.
///
/// Contract: `AgencyInboundErrorResponse['reason']` (`api/agency/inbound.ts`).
enum InboundDispositionRule implements WireEnum {
  /// The code is not in the call's catalog; `allowed_codes` lists the ones that are.
  unknownCode('unknown_code'),
  noteRequired('note_required'),
  datetimeRequired('datetime_required'),
  invalidCallbackAt('invalid_callback_at'),
  unknown('');

  const InboundDispositionRule(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static InboundDispositionRule fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// How an inbound call's offer reached its agent (IQ66): `station` (an open
/// station socket, Mode A) or `push` (the away agent's phone was rung; no
/// `connects_at`, it binds once accepted and attached).
///
/// Contract: `AgencyInboundOfferChannel` / `AGENCY_INBOUND_OFFER_CHANNELS`.
enum InboundOfferChannel implements WireEnum {
  station('station'),
  push('push'),
  unknown('');

  const InboundOfferChannel(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static InboundOfferChannel fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// How a ring (a push offer) ended; also a `ring_cancel` push's `reason`.
/// `expired` and `accept_lapsed` are misses (IQ62); a decline,
/// `busy_on_phone` and `answered_elsewhere` are not.
///
/// Contract: `AgencyInboundRingResult` / `AGENCY_INBOUND_RING_RESULTS`.
enum InboundRingResult implements WireEnum {
  answered('answered'),
  declined('declined'),
  expired('expired'),
  acceptLapsed('accept_lapsed'),
  busyOnPhone('busy_on_phone'),
  pushFailed('push_failed'),
  callerLeft('caller_left'),

  /// A station agent freed up and took the caller first (IQ73).
  answeredElsewhere('answered_elsewhere'),
  cancelled('cancelled'),
  unknown('');

  const InboundRingResult(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static InboundRingResult fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// Why the phone declined a ring. The app SENDS these
/// (`…/ring/decline`'s `reason`); neither is a miss.
///
/// Contract: `AgencyInboundRingDeclineReason` / `AGENCY_INBOUND_RING_DECLINE_REASONS`.
enum InboundRingDeclineReason implements WireEnum {
  /// The agent pressed Decline.
  declined('declined'),

  /// The phone is on a cellular call (IQ70): declined at once, without ringing.
  busyOnPhone('busy_on_phone'),
  unknown('');

  const InboundRingDeclineReason(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static InboundRingDeclineReason fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// What a station takes beyond its session's own work, declared on the
/// station upgrade as `caps=` (comma-separated). The app sends `caps=inbound`
/// so the server offers it inbound calls (`inbound_call`, `customer_waiting`).
///
/// Contract: `AGENCY_STATION_CAPABILITIES` (`agency/station.ts`).
enum StationCapability implements WireEnum {
  /// Inbound calls are offered to this station.
  inbound('inbound'),
  unknown('');

  const StationCapability(this.wire);
  @override
  final String wire;

  /// The station upgrade's query parameter.
  static const queryKey = 'caps';

  static final _byWire = wireIndex(values);
  static StationCapability fromWire(String? raw) => _byWire[raw] ?? unknown;

  /// The `caps=` value for [caps]: known members only, each once, in
  /// declaration order, comma-separated. Empty when none is left.
  static String queryValue(Iterable<StationCapability> caps) {
    final want = caps.toSet();
    return [
      for (final c in values)
        if (!c.isUnknown && want.contains(c)) c.wire,
    ].join(',');
  }

  /// [query] with `caps=` set for [caps], replacing any already there; left
  /// off (never sent empty) when [queryValue] is empty.
  static Map<String, String> withQuery(Map<String, String> query, Iterable<StationCapability> caps) {
    final value = queryValue(caps);
    return <String, String>{
      for (final e in query.entries)
        if (e.key != queryKey) e.key: e.value,
      if (value.isNotEmpty) queryKey: value,
    };
  }
}

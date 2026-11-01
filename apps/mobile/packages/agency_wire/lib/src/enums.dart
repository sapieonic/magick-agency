/// The closed string vocabularies of the contract, as Dart enums.
///
/// Each enum has an `unknown` member for a value this build does not
/// recognise, so a literal the server adds later decodes instead of failing
/// the whole payload; the model keeps the raw string beside the enum
/// (`stateRaw`, `reasonRaw`, ...) for logs and fallback copy.
///
/// `test/literals_test.dart` checks every wire enum of this package (these, plus
/// `StationEvent`, `AgencyErrorCode`, `SessionRefusalCode` and the station close
/// codes) against `packages/contracts/fixtures/agent/literals.json`, which is
/// extracted from the TypeScript sources: each TypeScript literal must be a
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
/// (`SOFTPHONE_BREAK_REASON`) and `device_away` (`DEVICE_AWAY_BREAK_REASON`, the
/// break the app takes when it leaves the foreground while `available`).
enum ReservedBreakCode implements WireEnum {
  softPhone('soft_phone'),
  deviceAway('device_away'),
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

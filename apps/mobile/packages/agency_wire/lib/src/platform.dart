/// Platform shapes the agent app signs in and configures itself with:
/// session, `me`, accounts, invites, feature flags, notification
/// preferences, and the client-config gate.
///
/// Contract: `packages/contracts/src/api/platform/*.ts`.
library;

import 'package:meta/meta.dart';

import 'enums.dart';
import 'equality.dart';
import 'json.dart';

// ─── Identity and tenancy ───────────────────────────────────────────────────

/// Contract: `User` (`api/platform/auth.ts`).
@immutable
final class User {
  User({
    required this.id,
    required this.firebaseUid,
    required this.email,
    this.displayName,
    this.avatarUrl,
    required this.status,
    String? statusRaw,
    required this.createdAt,
    required this.updatedAt,
  }) : statusRaw = statusRaw ?? status.wire;

  factory User.fromJson(Map<String, Object?> j) {
    final status = j.str('status');
    return User(
      id: j.str('id'),
      firebaseUid: j.str('firebase_uid'),
      email: j.str('email'),
      displayName: j.strOrNull('display_name'),
      avatarUrl: j.strOrNull('avatar_url'),
      status: UserStatus.fromWire(status),
      statusRaw: status,
      createdAt: j.time('created_at'),
      updatedAt: j.time('updated_at'),
    );
  }

  final String id;
  final String firebaseUid;
  final String email;
  final String? displayName;
  final String? avatarUrl;
  final UserStatus status;
  final String statusRaw;
  final DateTime createdAt;
  final DateTime updatedAt;

  @override
  bool operator ==(Object other) =>
      other is User &&
      other.id == id &&
      other.firebaseUid == firebaseUid &&
      other.email == email &&
      other.displayName == displayName &&
      other.avatarUrl == avatarUrl &&
      other.statusRaw == statusRaw &&
      other.createdAt == createdAt &&
      other.updatedAt == updatedAt;

  @override
  int get hashCode => Object.hash(id, firebaseUid, email, displayName, avatarUrl, statusRaw, createdAt, updatedAt);
}

/// Contract: `Tenant` (`api/platform/auth.ts`).
@immutable
final class Tenant {
  Tenant({
    required this.id,
    required this.name,
    required this.slug,
    required Map<String, Object?> settings,
    required this.status,
    String? statusRaw,
    required this.createdAt,
    required this.updatedAt,
  }) : settings = frozenMap(settings),
       statusRaw = statusRaw ?? status.wire;

  factory Tenant.fromJson(Map<String, Object?> j) {
    final status = j.str('status');
    return Tenant(
      id: j.str('id'),
      name: j.str('name'),
      slug: j.str('slug'),
      settings: j.obj('settings'),
      status: TenantStatus.fromWire(status),
      statusRaw: status,
      createdAt: j.time('created_at'),
      updatedAt: j.time('updated_at'),
    );
  }

  final String id;
  final String name;
  final String slug;
  final Map<String, Object?> settings;
  final TenantStatus status;
  final String statusRaw;
  final DateTime createdAt;
  final DateTime updatedAt;

  @override
  bool operator ==(Object other) =>
      other is Tenant &&
      other.id == id &&
      other.name == name &&
      other.slug == slug &&
      jsonEquals(other.settings, settings) &&
      other.statusRaw == statusRaw &&
      other.createdAt == createdAt &&
      other.updatedAt == updatedAt;

  @override
  int get hashCode => Object.hash(id, name, slug, jsonHash(settings), statusRaw, createdAt, updatedAt);
}

/// Contract: `Membership` (`api/platform/auth.ts`).
@immutable
final class Membership {
  Membership({
    required this.id,
    required this.userId,
    required this.tenantId,
    this.accountId,
    required this.role,
    String? roleRaw,
    required this.status,
    String? statusRaw,
    this.invitedBy,
    required this.createdAt,
    required this.updatedAt,
  }) : roleRaw = roleRaw ?? role.wire,
       statusRaw = statusRaw ?? status.wire;

  factory Membership.fromJson(Map<String, Object?> j) {
    final role = j.str('role');
    final status = j.str('status');
    return Membership(
      id: j.str('id'),
      userId: j.str('user_id'),
      tenantId: j.str('tenant_id'),
      accountId: j.strOrNull('account_id'),
      role: Role.fromWire(role),
      roleRaw: role,
      status: MembershipStatus.fromWire(status),
      statusRaw: status,
      invitedBy: j.strOrNull('invited_by'),
      createdAt: j.time('created_at'),
      updatedAt: j.time('updated_at'),
    );
  }

  final String id;
  final String userId;
  final String tenantId;

  /// Null for a tenant-wide membership.
  final String? accountId;
  final Role role;
  final String roleRaw;
  final MembershipStatus status;
  final String statusRaw;
  final String? invitedBy;
  final DateTime createdAt;
  final DateTime updatedAt;

  @override
  bool operator ==(Object other) =>
      other is Membership &&
      other.id == id &&
      other.userId == userId &&
      other.tenantId == tenantId &&
      other.accountId == accountId &&
      other.roleRaw == roleRaw &&
      other.statusRaw == statusRaw &&
      other.invitedBy == invitedBy &&
      other.createdAt == createdAt &&
      other.updatedAt == updatedAt;

  @override
  int get hashCode => Object.hash(id, userId, tenantId, accountId, roleRaw, statusRaw, invitedBy, createdAt, updatedAt);
}

/// Per-account settings (effective values; never null on the wire).
///
/// Contract: `AgencyAccountSettings` (`api/platform/settings.ts`).
@immutable
final class AccountSettings {
  const AccountSettings({
    required this.tenantId,
    required this.accountId,
    required this.allowRecording,
    required this.analyzeCalls,
    required this.maxConcurrentCalls,
    required this.webrtcMaxDurationSeconds,
    required this.updatedAt,
  });

  factory AccountSettings.fromJson(Map<String, Object?> j) => AccountSettings(
    tenantId: j.str('tenant_id'),
    accountId: j.str('account_id'),
    allowRecording: j.boolean('allow_recording'),
    analyzeCalls: j.boolean('analyze_calls'),
    maxConcurrentCalls: j.integer('max_concurrent_calls'),
    webrtcMaxDurationSeconds: j.integer('webrtc_max_duration_seconds'),
    updatedAt: j.time('updated_at'),
  );

  final String tenantId;
  final String accountId;
  final bool allowRecording;
  final bool analyzeCalls;
  final int maxConcurrentCalls;

  /// Hard cap on a bridged call before auto-hangup.
  final int webrtcMaxDurationSeconds;
  final DateTime updatedAt;

  @override
  bool operator ==(Object other) =>
      other is AccountSettings &&
      other.tenantId == tenantId &&
      other.accountId == accountId &&
      other.allowRecording == allowRecording &&
      other.analyzeCalls == analyzeCalls &&
      other.maxConcurrentCalls == maxConcurrentCalls &&
      other.webrtcMaxDurationSeconds == webrtcMaxDurationSeconds &&
      other.updatedAt == updatedAt;

  @override
  int get hashCode => Object.hash(
    tenantId,
    accountId,
    allowRecording,
    analyzeCalls,
    maxConcurrentCalls,
    webrtcMaxDurationSeconds,
    updatedAt,
  );
}

Map<String, AccountSettings> _settingsMap(Map<String, Object?> j) {
  final raw = j.obj('settings');
  return Map.unmodifiable(<String, AccountSettings>{
    for (final e in raw.entries) e.key: AccountSettings.fromJson(asJsonMap(e.value, 'settings.${e.key}')),
  });
}

/// `GET /auth/me`.
///
/// Contract: `MeResponse` (`api/platform/auth.ts`).
@immutable
class MeResponse {
  MeResponse({
    required this.user,
    required List<Tenant> tenants,
    required List<Membership> memberships,
    required Map<String, AccountSettings> settings,
  }) : tenants = List.unmodifiable(tenants),
       memberships = List.unmodifiable(memberships),
       settings = Map.unmodifiable(settings);

  factory MeResponse.fromJson(Map<String, Object?> j) => MeResponse(
    user: User.fromJson(j.obj('user')),
    tenants: j.list('tenants', Tenant.fromJson),
    memberships: j.list('memberships', Membership.fromJson),
    settings: _settingsMap(j),
  );

  final User user;
  final List<Tenant> tenants;
  final List<Membership> memberships;

  /// Keyed by account id: one entry per account the memberships reach.
  final Map<String, AccountSettings> settings;

  @override
  bool operator ==(Object other) =>
      other is MeResponse &&
      other.runtimeType == runtimeType &&
      other.user == user &&
      listEquals(other.tenants, tenants) &&
      listEquals(other.memberships, memberships) &&
      mapEquals(other.settings, settings);

  @override
  int get hashCode => Object.hash(user, listHash(tenants), listHash(memberships), mapHash(settings));
}

/// `POST /auth/session` and `POST /invites/:token/claim` (the same body).
///
/// Contract: `SessionResponse` (`api/platform/auth.ts`).
final class SessionResponse extends MeResponse {
  SessionResponse({
    required super.user,
    required super.tenants,
    required super.memberships,
    required super.settings,
    this.isNew = false,
  });

  factory SessionResponse.fromJson(Map<String, Object?> j) {
    final me = MeResponse.fromJson(j);
    return SessionResponse(
      user: me.user,
      tenants: me.tenants,
      memberships: me.memberships,
      settings: me.settings,
      isNew: j.boolean('is_new'),
    );
  }

  /// Always false: a brand-new identity is refused with `no_membership`.
  final bool isNew;

  @override
  bool operator ==(Object other) => super == other && other is SessionResponse && other.isNew == isNew;

  @override
  int get hashCode => Object.hash(super.hashCode, isNew);
}

/// `POST /auth/session` request. Contract: `SessionRequest`.
@immutable
final class SessionRequest {
  const SessionRequest({required this.idToken});

  /// A Firebase ID token.
  final String idToken;

  Map<String, Object?> toJson() => <String, Object?>{'id_token': idToken};

  @override
  bool operator ==(Object other) => other is SessionRequest && other.idToken == idToken;

  @override
  int get hashCode => idToken.hashCode;
}

/// An account as the account switcher knows it: the three fields an agent
/// may read. Contract: `MyAccountsResponse['accounts'][number]`.
@immutable
final class AccountSummary {
  const AccountSummary({required this.id, required this.name, required this.tenantId});

  factory AccountSummary.fromJson(Map<String, Object?> j) =>
      AccountSummary(id: j.str('id'), name: j.str('name'), tenantId: j.str('tenant_id'));

  final String id;
  final String name;
  final String tenantId;

  @override
  bool operator ==(Object other) =>
      other is AccountSummary && other.id == id && other.name == name && other.tenantId == tenantId;

  @override
  int get hashCode => Object.hash(id, name, tenantId);
}

/// `GET /accounts/mine`: what an agent (below `account.read`) bootstraps from.
///
/// Contract: `MyAccountsResponse`.
@immutable
final class MyAccountsResponse {
  MyAccountsResponse(List<AccountSummary> accounts) : accounts = List.unmodifiable(accounts);

  factory MyAccountsResponse.fromJson(Map<String, Object?> j) =>
      MyAccountsResponse(j.list('accounts', AccountSummary.fromJson));

  final List<AccountSummary> accounts;

  @override
  bool operator ==(Object other) => other is MyAccountsResponse && listEquals(other.accounts, accounts);

  @override
  int get hashCode => listHash(accounts);
}

// ─── Invites ────────────────────────────────────────────────────────────────

/// The invitation, as `GET /invites/:token` describes it.
///
/// Contract: `AgencyInvite` (`api/platform/invite.ts`).
@immutable
final class AgencyInvite {
  AgencyInvite({
    required this.email,
    required this.role,
    String? roleRaw,
    this.tenantName,
    this.inviterName,
    required this.productName,
    required this.expiresAt,
    required this.requiresMatchingAddress,
  }) : roleRaw = roleRaw ?? role.wire;

  factory AgencyInvite.fromJson(Map<String, Object?> j) {
    final role = j.str('role');
    return AgencyInvite(
      email: j.str('email'),
      role: Role.fromWire(role),
      roleRaw: role,
      tenantName: j.strOrNull('tenant_name'),
      inviterName: j.strOrNull('inviter_name'),
      productName: j.str('product_name'),
      expiresAt: j.time('expires_at'),
      // The contract reads a missing field (a server older than the rule) as
      // false and lets the claim's own refusal speak.
      requiresMatchingAddress: j.boolOrNull('requires_matching_address') ?? false,
    );
  }

  /// The invited address; shown read-only.
  final String email;
  final Role role;
  final String roleRaw;

  /// Null renders a thinner invitation, never a blank in a sentence.
  final String? tenantName;
  final String? inviterName;

  /// Whitelabel copy; render unchanged.
  final String productName;
  final DateTime expiresAt;
  final bool requiresMatchingAddress;

  @override
  bool operator ==(Object other) =>
      other is AgencyInvite &&
      other.email == email &&
      other.roleRaw == roleRaw &&
      other.tenantName == tenantName &&
      other.inviterName == inviterName &&
      other.productName == productName &&
      other.expiresAt == expiresAt &&
      other.requiresMatchingAddress == requiresMatchingAddress;

  @override
  int get hashCode =>
      Object.hash(email, roleRaw, tenantName, inviterName, productName, expiresAt, requiresMatchingAddress);
}

/// The answer to `GET /invites/:token` (200, or 404 `{status:'not_found'}`).
///
/// Contract: `InviteLookup`.
@immutable
sealed class InviteLookup {
  const InviteLookup();

  factory InviteLookup.fromJson(Map<String, Object?> j) {
    final status = j.str('status');
    if (status == InviteStatus.pending.wire) return InvitePending(AgencyInvite.fromJson(j.obj('invite')));
    return InviteUnavailable(status: InviteStatus.fromWire(status), statusRaw: status);
  }
}

final class InvitePending extends InviteLookup {
  const InvitePending(this.invite);

  final AgencyInvite invite;

  @override
  bool operator ==(Object other) => other is InvitePending && other.invite == invite;

  @override
  int get hashCode => invite.hashCode;
}

/// Claimed, expired, revoked, not found, or already bound: each has its own
/// next step.
final class InviteUnavailable extends InviteLookup {
  InviteUnavailable({required this.status, String? statusRaw}) : statusRaw = statusRaw ?? status.wire;

  final InviteStatus status;
  final String statusRaw;

  @override
  bool operator ==(Object other) => other is InviteUnavailable && other.statusRaw == statusRaw;

  @override
  int get hashCode => statusRaw.hashCode;
}

/// `POST /invites/:token/claim` request: the same `id_token` as the sign-in.
/// Answers [SessionResponse].
@immutable
final class ClaimInviteRequest {
  const ClaimInviteRequest({required this.idToken});

  final String idToken;

  Map<String, Object?> toJson() => <String, Object?>{'id_token': idToken};

  @override
  bool operator ==(Object other) => other is ClaimInviteRequest && other.idToken == idToken;

  @override
  int get hashCode => idToken.hashCode;
}

/// A 404/409 from the claim: `{error, message, status, email?}`.
///
/// Contract: `InviteUnavailableStatus` / `InviteClaimRefusalStatus` on the
/// body the claim route sends. `identity_in_use` and `address_required` leave
/// the invitation usable: keep the page (and its sign-out) up.
@immutable
final class InviteClaimRefusal {
  InviteClaimRefusal({required this.error, required this.message, required this.status, String? statusRaw, this.email})
    : statusRaw = statusRaw ?? status.wire;

  factory InviteClaimRefusal.fromJson(Map<String, Object?> j) {
    final status = j.str('status');
    return InviteClaimRefusal(
      error: j.strOrNull('error') ?? '',
      message: j.strOrNull('message') ?? '',
      status: InviteStatus.fromWire(status),
      statusRaw: status,
      email: j.strOrNull('email'),
    );
  }

  final String error;
  final String message;
  final InviteStatus status;
  final String statusRaw;

  /// The invited address, on `address_required`.
  final String? email;

  bool get invitationStillUsable => status == InviteStatus.identityInUse || status == InviteStatus.addressRequired;

  @override
  bool operator ==(Object other) =>
      other is InviteClaimRefusal &&
      other.error == error &&
      other.message == message &&
      other.statusRaw == statusRaw &&
      other.email == email;

  @override
  int get hashCode => Object.hash(error, message, statusRaw, email);
}

// ─── Feature flags ──────────────────────────────────────────────────────────

/// `GET /feature-flags` (account-scoped): client-exposed flags resolved for the caller.
///
/// Contract: `FeatureFlagMap` (`api/platform/feature-flags.ts`). A flag absent
/// from the map is off.
@immutable
final class FeatureFlags {
  FeatureFlags(Map<String, Object> values) : values = Map.unmodifiable(values);

  factory FeatureFlags.fromJson(Map<String, Object?> j) {
    final out = <String, Object>{};
    for (final e in j.entries) {
      final v = e.value;
      if (v is bool || v is num || v is String) {
        out[e.key] = v!;
      } else {
        throw WireFormatException('flag value must be boolean, number or string', e.key);
      }
    }
    return FeatureFlags(out);
  }

  /// Contract: `AgencyClientFlagMap` keys (`flags.ts`).
  static const dialerEnabled = 'agency_dialer_enabled';
  static const callAnalysis = 'agency_call_analysis';
  static const softphoneEnabled = 'agency_softphone_enabled';

  /// Contact assignment: the agent's My contacts, agent retry and the
  /// per-contact call. Gates the surface only: the station's queue state is
  /// shown whatever it says (the server's pacing reads the stored mode).
  static const contactAssignmentEnabled = 'agency_contact_assignment_enabled';

  final Map<String, Object> values;

  bool isOn(String key) => values[key] == true;

  @override
  bool operator ==(Object other) => other is FeatureFlags && mapEquals(other.values, values);

  @override
  int get hashCode => mapHash(values);
}

// ─── Notification preferences ───────────────────────────────────────────────

/// One event the caller can subscribe to, with their effective value. The
/// catalog is served; render whatever arrives.
///
/// Contract: `NotificationEventPreference` (`api/platform/notifications.ts`).
@immutable
final class NotificationEventPreference {
  NotificationEventPreference({
    required this.key,
    required this.label,
    required this.description,
    required this.category,
    required this.cadence,
    String? cadenceRaw,
    required this.channel,
    required this.enabled,
    this.frequency,
    String? frequencyRaw,
    required this.defaultEnabled,
    this.defaultFrequency,
    String? defaultFrequencyRaw,
    required this.isDefault,
  }) : cadenceRaw = cadenceRaw ?? cadence.wire,
       frequencyRaw = frequencyRaw ?? frequency?.wire,
       defaultFrequencyRaw = defaultFrequencyRaw ?? defaultFrequency?.wire;

  factory NotificationEventPreference.fromJson(Map<String, Object?> j) {
    final cadence = j.str('cadence');
    final frequency = j.strOrNull('frequency');
    final defaultFrequency = j.strOrNull('default_frequency');
    return NotificationEventPreference(
      key: j.str('key'),
      label: j.str('label'),
      description: j.str('description'),
      category: j.str('category'),
      cadence: NotificationCadence.fromWire(cadence),
      cadenceRaw: cadence,
      channel: j.str('channel'),
      enabled: j.boolean('enabled'),
      frequency: frequency == null ? null : NotificationFrequency.fromWire(frequency),
      frequencyRaw: frequency,
      defaultEnabled: j.boolean('default_enabled'),
      defaultFrequency: defaultFrequency == null ? null : NotificationFrequency.fromWire(defaultFrequency),
      defaultFrequencyRaw: defaultFrequency,
      isDefault: j.boolean('is_default'),
    );
  }

  final String key;
  final String label;
  final String description;
  final String category;
  final NotificationCadence cadence;
  final String cadenceRaw;
  final String channel;
  final bool enabled;
  final NotificationFrequency? frequency;
  final String? frequencyRaw;
  final bool defaultEnabled;
  final NotificationFrequency? defaultFrequency;
  final String? defaultFrequencyRaw;

  /// True when the value came from the catalog rather than a saved choice.
  final bool isDefault;

  @override
  bool operator ==(Object other) =>
      other is NotificationEventPreference &&
      other.key == key &&
      other.label == label &&
      other.description == description &&
      other.category == category &&
      other.cadenceRaw == cadenceRaw &&
      other.channel == channel &&
      other.enabled == enabled &&
      other.frequencyRaw == frequencyRaw &&
      other.defaultEnabled == defaultEnabled &&
      other.defaultFrequencyRaw == defaultFrequencyRaw &&
      other.isDefault == isDefault;

  @override
  int get hashCode => Object.hash(
    key,
    label,
    description,
    category,
    cadenceRaw,
    channel,
    enabled,
    frequencyRaw,
    defaultEnabled,
    defaultFrequencyRaw,
    isDefault,
  );
}

/// `GET /notifications/preferences`. Contract: `NotificationPreferencesResponse`.
@immutable
final class NotificationPreferencesResponse {
  NotificationPreferencesResponse(List<NotificationEventPreference> events) : events = List.unmodifiable(events);

  factory NotificationPreferencesResponse.fromJson(Map<String, Object?> j) =>
      NotificationPreferencesResponse(j.list('events', NotificationEventPreference.fromJson));

  final List<NotificationEventPreference> events;

  @override
  bool operator ==(Object other) => other is NotificationPreferencesResponse && listEquals(other.events, events);

  @override
  int get hashCode => listHash(events);
}

/// One entry of the `PUT /notifications/preferences` body (a PATCH: omitted
/// events keep their value). A null [frequency] is omitted, not cleared.
///
/// Contract: `NotificationPreferenceUpdate`.
@immutable
final class NotificationPreferenceUpdate {
  const NotificationPreferenceUpdate({required this.eventKey, this.channel, required this.enabled, this.frequency});

  final String eventKey;
  final String? channel;
  final bool enabled;
  final NotificationFrequency? frequency;

  Map<String, Object?> toJson() {
    final json = <String, Object?>{'event_key': eventKey, 'enabled': enabled};
    putIfSet(json, 'channel', channel);
    putIfSet(json, 'frequency', frequency?.wire);
    return json;
  }

  @override
  bool operator ==(Object other) =>
      other is NotificationPreferenceUpdate &&
      other.eventKey == eventKey &&
      other.channel == channel &&
      other.enabled == enabled &&
      other.frequency == frequency;

  @override
  int get hashCode => Object.hash(eventKey, channel, enabled, frequency);
}

// ─── Client config ─────────────────────────────────────────────────────────

/// `GET /client-config`: the app's update gate,
/// `{ mobile: { min_supported, latest, store_urls?: {ios?, android?} } }`.
///
/// Contract: `ClientConfigResponse` (`api/platform/client-config.ts`).
@immutable
final class ClientConfig {
  const ClientConfig({required this.mobile});

  factory ClientConfig.fromJson(Map<String, Object?> j) =>
      ClientConfig(mobile: MobileClientConfig.fromJson(j.obj('mobile')));

  final MobileClientConfig mobile;

  @override
  bool operator ==(Object other) => other is ClientConfig && other.mobile == mobile;

  @override
  int get hashCode => mobile.hashCode;
}

@immutable
final class MobileClientConfig {
  const MobileClientConfig({required this.minSupported, required this.latest, this.storeUrls});

  factory MobileClientConfig.fromJson(Map<String, Object?> j) {
    final urls = j.objOrNull('store_urls');
    return MobileClientConfig(
      minSupported: j.str('min_supported'),
      latest: j.str('latest'),
      storeUrls: urls == null ? null : StoreUrls.fromJson(urls),
    );
  }

  /// Oldest semver the server still supports.
  final String minSupported;
  final String latest;
  final StoreUrls? storeUrls;

  /// Whether [appVersion] is older than [minSupported] (must update).
  bool mustUpdate(String appVersion) => compareSemver(appVersion, minSupported) < 0;

  /// Whether [appVersion] is older than [latest] (may update).
  bool canUpdate(String appVersion) => compareSemver(appVersion, latest) < 0;

  @override
  bool operator ==(Object other) =>
      other is MobileClientConfig &&
      other.minSupported == minSupported &&
      other.latest == latest &&
      other.storeUrls == storeUrls;

  @override
  int get hashCode => Object.hash(minSupported, latest, storeUrls);
}

@immutable
final class StoreUrls {
  const StoreUrls({this.ios, this.android});

  factory StoreUrls.fromJson(Map<String, Object?> j) =>
      StoreUrls(ios: j.strOrNull('ios'), android: j.strOrNull('android'));

  final String? ios;
  final String? android;

  @override
  bool operator ==(Object other) => other is StoreUrls && other.ios == ios && other.android == android;

  @override
  int get hashCode => Object.hash(ios, android);
}

/// Compares `MAJOR.MINOR.PATCH` versions numerically. A `+build` suffix is
/// ignored; a `-prerelease` sorts before its release; a missing or
/// non-numeric part counts as 0.
int compareSemver(String a, String b) {
  (List<int>, bool) parse(String v) {
    final core = v.split('+').first;
    final dash = core.indexOf('-');
    final nums = (dash == -1 ? core : core.substring(0, dash)).split('.');
    return (List<int>.generate(3, (i) => i < nums.length ? int.tryParse(nums[i].trim()) ?? 0 : 0), dash != -1);
  }

  final (pa, preA) = parse(a);
  final (pb, preB) = parse(b);
  for (var i = 0; i < 3; i++) {
    if (pa[i] != pb[i]) return pa[i].compareTo(pb[i]);
  }
  if (preA != preB) return preA ? -1 : 1;
  return 0;
}

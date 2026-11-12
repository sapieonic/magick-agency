import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:meta/meta.dart';

import '../softphone/softphone_host.dart';
import 'station_signals.dart';

/// The one session the station core hosts: a campaign station (from the
/// join's [SessionBootstrap]) or a soft-phone session (from
/// `POST /softphone/sessions`).
///
/// The server allows one live session per agent, across tenants (OS1), so the app holds
/// one of these at a time, on one socket, one audio engine and one on-duty
/// service, whichever kind it is. Everything the socket needs is the same for
/// both kinds; what only a campaign has (its catalog, break reasons, roster
/// display) is empty for a soft-phone session, and [bootstrap] is null.
@immutable
final class HostedSession {
  const HostedSession._({
    required this.sessionId,
    required this.kind,
    required this.accountId,
    required this.campaignId,
    required this.campaignName,
    required this.bootstrap,
    required this.stationWsUrl,
    required this.stationTokenExpiresAt,
    required this.intervals,
    required this.initialState,
    required this.initialBreakReason,
  });

  /// A campaign station. [campaignName] is what the agent picked it by (the
  /// bootstrap's own name wins on screen); [accountId] the account it was joined in.
  factory HostedSession.campaign(SessionBootstrap bootstrap, {required String campaignName, String? accountId}) =>
      HostedSession._(
        sessionId: bootstrap.sessionId,
        kind: SessionKind.campaign,
        accountId: accountId,
        campaignId: bootstrap.campaignId,
        campaignName: campaignName,
        bootstrap: bootstrap,
        stationWsUrl: bootstrap.stationWsUrl,
        stationTokenExpiresAt: bootstrap.stationTokenExpiresAt,
        intervals: bootstrap.intervals,
        initialState: bootstrap.state,
        initialBreakReason: bootstrap.breakReason,
      );

  /// A soft-phone session, opened (or rehydrated) in [accountId]. Always on
  /// the `soft_phone` break; it has no campaign.
  factory HostedSession.softphone(SoftphoneSessionResponse response, {String? accountId}) => HostedSession._(
        sessionId: response.sessionId,
        kind: SessionKind.softphone,
        accountId: accountId,
        campaignId: null,
        campaignName: null,
        bootstrap: null,
        stationWsUrl: response.stationWsUrl,
        // A URL without its token cannot be used as it is: marking it lapsed
        // makes the socket mint one first (the console's `urlCarriesToken`).
        stationTokenExpiresAt: urlCarriesToken(response.stationWsUrl) ? response.stationTokenExpiresAt : _lapsed,
        intervals: response.intervals,
        initialState: response.state,
        initialBreakReason: response.breakReason.isEmpty ? softphoneBreakReason : response.breakReason,
      );

  static final _lapsed = DateTime.fromMillisecondsSinceEpoch(0, isUtc: true);

  final String sessionId;
  final SessionKind kind;

  /// The account the session was opened in: every soft-phone request about it
  /// goes with this account. Null when the client had no account scope.
  final String? accountId;

  /// A campaign station's campaign; null for a soft-phone session.
  final String? campaignId;
  final String? campaignName;

  /// The join's answer, for a campaign station only.
  final SessionBootstrap? bootstrap;

  final String stationWsUrl;

  /// When the URL's token lapses. Already in the past for a URL that carries
  /// no token, so the socket mints one before it connects.
  final DateTime? stationTokenExpiresAt;
  final StationIntervals intervals;

  /// What the opening answer said the agent is in, and why when on a break.
  /// Stands in once for a first `ready` that states no break reason.
  final AgentState initialState;
  final String? initialBreakReason;

  bool get isSoftphone => kind == SessionKind.softphone;

  StationSessionKind get signalKind => isSoftphone ? StationSessionKind.softphone : StationSessionKind.campaign;

  List<Disposition> get catalog => bootstrap?.dispositionCatalog ?? const [];
  List<BreakReason> get breakReasons => bootstrap?.breakReasons ?? const [];
  ContextDisplay? get contextDisplay => bootstrap?.contextDisplay;
}

/// Whether a station URL carries its upgrade token (`?token=…` or `&token=…`).
bool urlCarriesToken(String url) => RegExp(r'[?&]token=[^&]+').hasMatch(url);

/// What the shell and the soft phone read of the hosted session, published by
/// the station controller on every change: the shell's [signals] (derived from
/// the station state and the session, not from the campaign view, so a
/// soft-phone session that has no campaign view still holds the screen) and
/// the soft phone's [softphone] view. Kept apart from `StationView?` so the
/// campaign view's contract is unchanged.
@immutable
final class StationHost {
  const StationHost({this.signals = const StationSignals(), this.softphone});

  static const none = StationHost();

  final StationSignals signals;
  final SoftphoneHostView? softphone;

  @override
  bool operator ==(Object other) => other is StationHost && other.signals == signals && other.softphone == softphone;

  @override
  int get hashCode => Object.hash(signals, softphone);
}

/// The slot [StationHost] is written to. Only the station controller sets it.
class StationHostSlot extends Notifier<StationHost> {
  @override
  StationHost build() => StationHost.none;

  void set(StationHost host) {
    if (host != state) state = host;
  }
}

final stationHostProvider = NotifierProvider<StationHostSlot, StationHost>(StationHostSlot.new);

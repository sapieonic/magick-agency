import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/routes.dart';
import '../../core/softphone/softphone_view.dart';
import '../../core/station/station_signals.dart';
import 'missed_calls_copy.dart';

/// A Missed row's **Call back** (`docs/inbound.md` §7, the console's
/// `utils/softphone/prefill.ts`): the soft phone with the caller's number on
/// the pad and the matched campaign as "Log to" when the agent may log to it.
/// Nothing is dialled: Call takes focus and the agent presses it, so the soft
/// phone's own rules apply as to a typed number (the DNC check and its note,
/// the calling hours, one dial at a time). The number never goes in a route.

/// Call back is offered where the soft phone may start a call for this agent:
/// the Phone tab shows (the bootstrap answered, so the agent may dial) and the
/// soft phone is on (not finish mode). The console's `canCallBack`.
bool callBackOffered(SoftphoneAvailability availability) => availability.visible && availability.startAllowed;

/// Where the soft phone's pad is: the station, for a campaign session switched
/// to the soft phone (SP7, as the shell's Phone tab goes there), else the
/// Phone tab.
String callBackRoute(StationSignals signals) {
  final campaignId = signals.campaignId;
  final onStation = signals.sessionKind == StationSessionKind.campaign &&
      signals.onDuty &&
      signals.onSoftphone &&
      campaignId != null;
  return onStation ? Routes.station(campaignId) : Routes.phone;
}

/// Where a Call back's number lands, for what the agent is told.
enum CallBackLanding {
  /// On the pad at once: nothing is said.
  now,

  /// The soft phone is open here with a call on it: the number waits for that
  /// call to settle.
  afterCall,

  /// The soft phone is not open here yet: the number waits five minutes for it.
  onceOpen,

  /// The soft phone is open on another device or in another account: the
  /// number is not kept (the soft phone drops it), and nothing is promised.
  elsewhere,
}

/// Where the number lands, from the soft phone's view and the station's
/// signals (the seams; the soft phone decides the same from its own state).
CallBackLanding callBackLanding(StationSignals signals, SoftphoneView view) {
  if (callBackRoute(signals) == Routes.phone) {
    final screen = view.screen;
    if (screen is SoftphoneScreenOtherDevice ||
        screen is SoftphoneScreenElsewhere ||
        screen is SoftphoneScreenOffStranded ||
        screen is SoftphoneScreenOff) {
      return CallBackLanding.elsewhere;
    }
    if (screen is! SoftphoneScreenActive) return CallBackLanding.onceOpen;
  }
  return view.callId != null || view.placing ? CallBackLanding.afterCall : CallBackLanding.now;
}

/// Hands the number to the soft phone and goes to it, and says when the
/// number is not on the pad at once. A withheld caller has nothing to call
/// (the button is disabled; this does nothing).
void startCallBack(BuildContext context, WidgetRef ref, InboundMissedCall call) {
  final number = call.fromE164;
  if (number == null) return;
  final signals = ref.read(stationSignalsProvider);
  final landing = callBackLanding(signals, ref.read(softphoneViewProvider));
  ref.read(softphoneActionsProvider).callBack(number, campaignId: call.matchedCampaignId);
  final messenger = ScaffoldMessenger.maybeOf(context);
  context.go(callBackRoute(signals));
  final (key, text) = switch (landing) {
    CallBackLanding.now => (null, null),
    CallBackLanding.afterCall => ('missed-call-back-after-call', MissedCopy.callBackAfterCall),
    CallBackLanding.onceOpen => ('missed-call-back-waits', MissedCopy.callBackWaits),
    CallBackLanding.elsewhere => ('missed-call-back-elsewhere', MissedCopy.callBackElsewhere),
  };
  if (key != null && text != null) messenger?.showSnackBar(SnackBar(key: Key(key), content: Text(text)));
}

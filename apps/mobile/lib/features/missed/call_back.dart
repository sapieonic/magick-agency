import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/routes.dart';
import '../../core/softphone/softphone_host.dart';
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

/// What the agent is told after pressing Call back, from where the soft phone says the number
/// stands ([SoftphoneView.callBackWaiting], the soft phone's one decision): nothing when it is
/// on the pad or lands in a moment; why it waits otherwise; that it was not kept when the soft
/// phone is open elsewhere.
(String key, String text)? callBackNotice(CallBackWaiting waiting) => switch (waiting) {
      CallBackWaiting.none || CallBackWaiting.setup => null,
      CallBackWaiting.afterCall => ('missed-call-back-after-call', MissedCopy.callBackAfterCall),
      CallBackWaiting.onceOpen => ('missed-call-back-waits', MissedCopy.callBackWaits),
      CallBackWaiting.notKept => ('missed-call-back-elsewhere', MissedCopy.callBackElsewhere),
    };

/// On duty on a campaign station that is not on the soft phone (waiting, on a break, or in a
/// wrap-up), Call back switches the campaign to the soft phone (SP7) in the same step (IQ48),
/// so the number lands on the station's pad. A campaign already on the soft phone, a soft-phone
/// session and an agent off duty take the plain Call back.
bool callBackSwitchesStation(StationSignals signals) =>
    signals.sessionKind == StationSessionKind.campaign &&
    signals.onDuty &&
    !signals.onSoftphone &&
    signals.campaignId != null;

/// What the agent is told after an on-duty Call back's switch: nothing once it applied (the
/// station shows the soft phone with the number on its pad); that it waits for the call or
/// wrap-up when the switch was queued behind it; why it was refused, and that the number
/// still waits for a switch, otherwise.
(String key, String text)? switchCallBackNotice(SoftphoneSwitchResult result) => switch (result) {
      SoftphoneSwitchApplied() => null,
      SoftphoneSwitchQueued() => ('missed-call-back-switch-queued', MissedCopy.callBackSwitchQueued),
      SoftphoneSwitchRefused(:final message) => (
          'missed-call-back-switch-refused',
          MissedCopy.callBackSwitchRefused(message),
        ),
    };

/// Hands the number to the soft phone and goes to it, and says when the
/// number is not on the pad at once. A withheld caller has nothing to call
/// (the button is disabled; this does nothing). [onLeave] runs before the
/// app moves (the on-duty sheet closes itself with it).
///
/// On duty on a campaign ([callBackSwitchesStation]) it also switches the
/// campaign to the soft phone, as the station's own "Switch to soft phone"
/// does (no confirmation there either): at once while waiting or on a
/// break, queued behind a call or wrap-up, where the number waits for it
/// (the soft phone's `afterCall`). A refusal is said, and the number keeps
/// waiting for a switch within [callBackWaitsFor]. It never dials.
Future<void> startCallBack(BuildContext context, InboundMissedCall call, {VoidCallback? onLeave}) async {
  final number = call.fromE164;
  if (number == null) return;
  // Everything read now: the list (and its sheet) may be gone after the hand-off.
  final container = ProviderScope.containerOf(context, listen: false);
  final signals = container.read(stationSignalsProvider);
  final messenger = ScaffoldMessenger.maybeOf(context);
  final router = GoRouter.maybeOf(context);
  void say((String, String)? notice) {
    if (notice case (final key, final text)) messenger?.showSnackBar(SnackBar(key: Key(key), content: Text(text)));
  }

  container.read(softphoneActionsProvider).callBack(number, campaignId: call.matchedCampaignId);
  if (callBackSwitchesStation(signals)) {
    final host = container.read(softphoneHostActionsProvider);
    onLeave?.call();
    router?.go(Routes.station(signals.campaignId!));
    say(switchCallBackNotice(await host.switchToSoftphone()));
    return;
  }
  // Read after the hand-off: the soft phone has decided where the number stands.
  final notice = callBackNotice(container.read(softphoneViewProvider).callBackWaiting);
  onLeave?.call();
  router?.go(callBackRoute(signals));
  say(notice);
}

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

/// Hands the number to the soft phone and goes to it, and says when the
/// number is not on the pad at once. A withheld caller has nothing to call
/// (the button is disabled; this does nothing).
void startCallBack(BuildContext context, WidgetRef ref, InboundMissedCall call) {
  final number = call.fromE164;
  if (number == null) return;
  final signals = ref.read(stationSignalsProvider);
  ref.read(softphoneActionsProvider).callBack(number, campaignId: call.matchedCampaignId);
  // Read after the hand-off: the soft phone has decided where the number stands.
  final notice = callBackNotice(ref.read(softphoneViewProvider).callBackWaiting);
  final messenger = ScaffoldMessenger.maybeOf(context);
  context.go(callBackRoute(signals));
  if (notice case (final key, final text)) messenger?.showSnackBar(SnackBar(key: Key(key), content: Text(text)));
}

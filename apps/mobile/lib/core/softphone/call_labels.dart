import 'package:agency_wire/agency_wire.dart';

import '../../features/calls/logic/attempt_copy.dart' show attemptOutcomeLabels;
import '../../features/performance/logic/en_in_format.dart';
import 'softphone_view.dart';

/// Reading a manual call in a list (a port of the console's
/// `utils/softphone/callLabels.ts`): the outcome the agent saved, in the words
/// of the catalog it was saved against (the tagged campaign's, or the soft
/// phone's own, by `disposition_source`), and only otherwise what the line did;
/// where it was logged; when it was placed; and the number laid out for reading.
///
/// The outcome words are the call list's (`attemptOutcomeLabels`, the contract's
/// `ATTEMPT_OUTCOME_LABELS`) and the dates are `EnIn`'s, so a soft-phone call
/// reads like a campaign call on the same phone.

/// A number laid out for reading: `+91 98204 61733` for an Indian mobile,
/// `+1 415 555 0100` for a NANP number, `98204 61733` for ten national digits,
/// and anything else unchanged (spaces dropped). Display only: what is sent is
/// never re-spaced. A port of the console's `formatDialNumber`
/// (`utils/softphone/phoneInput.ts`); the soft phone's input rules
/// (`phone_input.dart`) use this one rather than a copy.
String formatDialNumber(String? value) {
  if (value == null || value.isEmpty) return '';
  final compact = value.replaceAll(RegExp(r'\s+'), '');
  final india = RegExp(r'^\+91(\d{10})$').firstMatch(compact);
  if (india != null) {
    final d = india.group(1)!;
    return '+91 ${d.substring(0, 5)} ${d.substring(5)}';
  }
  final nanp = RegExp(r'^\+1(\d{3})(\d{3})(\d{4})$').firstMatch(compact);
  if (nanp != null) return '+1 ${nanp.group(1)} ${nanp.group(2)} ${nanp.group(3)}';
  final national = RegExp(r'^(\d{5})(\d{5})$').firstMatch(compact);
  if (national != null) return '${national.group(1)} ${national.group(2)}';
  return compact;
}

/// The catalog a call's `disposition_code` belongs to, from the bootstrap the
/// screen already holds: the tagged campaign's (a taggable one, else
/// `call_campaign` when it describes this call's tag), else the untagged
/// catalog. Null without a bootstrap, or for a tagged call whose campaign the
/// bootstrap does not describe.
List<Disposition>? catalogForCall(ManualCall call, SoftphoneBootstrap? bootstrap) {
  if (bootstrap == null) return null;
  final source = call.dispositionSource;
  final fromCampaign = source == DispositionSource.campaign || (source == null && call.tag != null);
  final tag = call.tag;
  if (fromCampaign && tag != null) {
    final taggable = bootstrap.taggable(tag.campaignId);
    if (taggable != null) return taggable.dispositionCatalog;
    final callCampaign = bootstrap.callCampaign;
    return callCampaign?.campaignId == tag.campaignId ? callCampaign!.dispositionCatalog : null;
  }
  return bootstrap.untagged.dispositionCatalog;
}

/// [code]'s label in [catalog], else the code itself; null for no code.
String? dispositionLabel(String? code, List<Disposition>? catalog) {
  if (code == null || code.isEmpty) return null;
  for (final d in catalog ?? const <Disposition>[]) {
    if (d.code == code) return d.label;
  }
  return code;
}

/// What the line did, in the call list's words: "Not classified" for none, and a
/// value this build does not know as sent (the contract's `attemptOutcomeLabel`).
String manualLineOutcomeLabel(ManualCall call) {
  final raw = call.outcomeRaw;
  if (raw == null) return 'Not classified';
  return attemptOutcomeLabels[call.outcome] ?? raw;
}

/// A call's outcome line in a list, and which kind of line it is.
({String text, SoftphoneOutcomeKind kind}) manualCallOutcome(ManualCall call, List<Disposition>? catalog) {
  final code = call.dispositionCode;
  if (code != null && code.isNotEmpty) {
    return (text: dispositionLabel(code, catalog) ?? code, kind: SoftphoneOutcomeKind.saved);
  }
  if (call.settledAt == null && call.state == AttemptState.ended && call.requiresDisposition) {
    return (text: 'No outcome yet', kind: SoftphoneOutcomeKind.awaiting);
  }
  if (call.state != AttemptState.ended) return (text: 'On a call now', kind: SoftphoneOutcomeKind.live);
  return (text: manualLineOutcomeLabel(call), kind: SoftphoneOutcomeKind.line);
}

/// "Q4 Renewals — Pune", or the words for none.
String loggedToLabel(ManualCall call) => call.tag?.campaignName ?? 'Not logged to a campaign';

/// When a recent call was placed, with its day: "Today, 09:05 am",
/// "Yesterday, 06:40 pm", "28 Oct, 11:12 am" (and the year once it is not this
/// one). A time alone reads as today for a call from last week. Calendar days
/// are the reader's: both instants are taken in this device's zone.
String recentCallWhen(DateTime at, DateTime now) {
  final local = at.toLocal();
  final today = now.toLocal();
  final time = EnIn.clockTime(local);
  bool sameDay(DateTime a, DateTime b) => a.year == b.year && a.month == b.month && a.day == b.day;
  final yesterday = DateTime(today.year, today.month, today.day - 1);
  if (sameDay(local, today)) return 'Today, $time';
  if (sameDay(local, yesterday)) return 'Yesterday, $time';
  final date = local.year == today.year ? EnIn.dayMonth(local) : EnIn.dayMonthYear(local);
  return '$date, $time';
}

import 'package:agency_wire/agency_wire.dart';
import 'package:meta/meta.dart';

import 'en_in_format.dart';

/// The agent's own figures and readouts, ported from the console's
/// `agentReadouts.ts` and `agencyAgentPerformance.ts` with their wording.
///
/// The rule the module is built around: **a null rate is NOT MEASURED YET
/// and never renders as `0%`.** There are three absences and they read
/// differently: the payload did not arrive (an em dash, "didn't load"), the
/// server has nothing to measure (`null`: "Not measured yet" and a sentence),
/// and a real `0`, the only one that is a claim about the shift.

/// Below this many dials the console withholds a per-campaign connect rate
/// ("Not enough calls"): `AGENCY_ROSTER_MIN_RATE_DENOMINATOR`
/// (`packages/contracts/src/agency/performance.ts`). The headline tiles and
/// readouts are NOT floored on the agent's own page; the server's rate (or
/// its null) is shown as served, exactly as the console does.
const rosterMinRateDenominator = 20;

/// One headline figure (`HeadlineFigure`).
@immutable
class HeadlineFigure {
  const HeadlineFigure({required this.key, required this.label, required this.hint, required this.value, required this.known});

  final String key;
  final String label;

  /// What the label means; rendered in the "What these count" key.
  final String hint;
  final String value;

  /// False when [value] stands in for an absent measurement (rendered dimmed,
  /// never as a warning).
  final bool known;
}

/// Dials · connect rate · conversations, always all three, always in that
/// order (`headlineTrio`). Null [totals] is "did not load".
List<HeadlineFigure> headlineTrio(AgentStatsTotals? totals) {
  final rate = totals?.connectRatePct;
  return [
    HeadlineFigure(
      key: 'attempts',
      label: 'Dials',
      hint: 'Calls the dialer placed and handed to you, whether or not anyone picked up.',
      value: totals == null ? '—' : EnIn.count(totals.attempts),
      known: totals != null,
    ),
    HeadlineFigure(
      key: 'connect_rate',
      label: 'Connect rate',
      hint: 'How often a dial reached a person.',
      // Null is "nobody has been dialled yet", which is not a 0% connect rate.
      value: totals == null ? '—' : (rate == null ? 'Not measured yet' : EnIn.pct(rate)),
      known: rate != null,
    ),
    HeadlineFigure(
      key: 'connected',
      label: 'Conversations',
      hint: 'Dials where you actually spoke to someone.',
      value: totals == null ? '—' : EnIn.count(totals.connected),
      known: totals != null,
    ),
  ];
}

/// One derived readout (`PerformanceReadout`).
@immutable
class Readout {
  const Readout({required this.value, required this.detail, required this.known, this.secondary});

  final String value;
  final String detail;

  /// Beside the value: "12 counted", "2:53:10 on calls in total".
  final String? secondary;
  final bool known;

  @override
  bool operator ==(Object other) =>
      other is Readout && other.value == value && other.detail == detail && other.secondary == secondary && other.known == known;

  @override
  int get hashCode => Object.hash(value, detail, secondary, known);

  @override
  String toString() => 'Readout($value, $secondary, known=$known)';
}

/// The console's three-way ladder (`servedReadout`): absent payload → em
/// dash + [missing]; served null → "Not measured yet" + [unmeasured] (when the
/// readout has such a state); a number → formatted.
Readout _served({
  required bool loaded,
  required double? value,
  required String missing,
  String? unmeasured,
  required String measured,
  required String Function(double) format,
  String? secondary,
}) {
  if (loaded && value != null) return Readout(value: format(value), detail: measured, secondary: secondary, known: true);
  if (loaded && unmeasured != null) {
    return Readout(value: 'Not measured yet', detail: unmeasured, secondary: secondary, known: false);
  }
  return Readout(value: '—', detail: missing, secondary: secondary, known: false);
}

/// Conversion rate: successes over CONVERSATIONS, not over dials
/// (`agentConversionReadout`).
Readout conversionReadout(AgentStatsTotals? totals) => _served(
      loaded: totals != null,
      value: totals?.successRatePct,
      missing: 'Your conversion rate didn’t load.',
      unmeasured: 'You haven’t had a conversation to convert yet.',
      measured: 'Calls that counted as a win, out of the ones where you spoke to someone — not out of every dial.',
      format: EnIn.pct,
      secondary: totals == null ? null : '${EnIn.count(totals.successes)} counted',
    );

/// Average call (`agentHandleTimeReadout`): `(talk + wrap-up) / connected`
/// as served; null is "no call has finished", never a fast shift.
Readout handleTimeReadout(AgentStatsTotals? totals) => _served(
      loaded: totals != null,
      value: totals?.ahtSeconds,
      missing: 'Your average call length didn’t load.',
      unmeasured: 'No call of yours has finished in this period, so there is nothing to average.',
      measured: 'Your average time on a call, from the moment you and the customer were joined.',
      format: EnIn.statClock,
      secondary: totals == null ? null : '${EnIn.statClock(totals.talkSeconds)} on calls in total',
    );

/// Wrap-up (`agentWrapupReadout`): a SUM, not an average, and not measured
/// against a campaign's window (an agent on two campaigns has two windows).
Readout wrapupReadout(AgentStatsTotals? totals) => _served(
      loaded: totals != null,
      value: totals?.wrapupSeconds,
      missing: 'Your wrap-up time didn’t load.',
      measured: 'Time spent writing calls up after the customer hung up.',
      format: EnIn.statClock,
    );

/// A per-campaign connect rate, derived here only because `by_campaign[]`
/// carries no rates (`rowConnectRate`): no dials → em dash; under the
/// roster's floor → "Not enough calls"; else the rate.
String rowConnectRate(AgentCampaignRow row) {
  if (row.attempts <= 0) return '—';
  if (row.attempts < rosterMinRateDenominator) return 'Not enough calls';
  return EnIn.pct(row.connected / row.attempts * 100);
}

/// Nothing at all happened in the window (`isEmptyRange`).
bool isEmptyRange(AgentStats stats) => stats.totals.attempts == 0 && stats.buckets.isEmpty;

/// "No calls reached you this week." (the console's empty-range line).
String emptyRangeLine(String windowLabel) => 'No calls reached you ${windowLabel.toLowerCase()}.';

/// "We couldn’t load this week" (the console's failed-period title).
String failedWindowTitle(String windowLabel) => 'We couldn’t load ${windowLabel.toLowerCase()}';

/// "1 campaign" / "3 campaigns" (`campaigns-worked`).
String campaignsWorked(int n) => n == 1 ? '1 campaign' : '${EnIn.count(n)} campaigns';

/// A campaign's name, or a shortened id: never blank, never invented
/// (`campaignLabel`).
String campaignLabel(String campaignId, Map<String, String?> names) {
  final name = names[campaignId];
  if (name != null && name.isNotEmpty) return name;
  return 'Campaign ${campaignId.length > 8 ? campaignId.substring(0, 8) : campaignId}';
}

/// Id → name from the staffing history (`campaignNameMap`). A history repeats
/// campaigns by construction; the last non-null name wins.
Map<String, String?> campaignNameMap(Iterable<StaffingHistoryEntry> entries) {
  final map = <String, String?>{};
  for (final e in entries) {
    map[e.campaignId] = e.campaignName ?? map[e.campaignId];
  }
  return map;
}

/// The campaigns a scope menu may OFFER: named ones only, sorted by name.
List<MapEntry<String, String>> scopeOptions(Map<String, String?> names) {
  final out = <MapEntry<String, String>>[
    for (final e in names.entries)
      if (e.value != null && e.value!.isNotEmpty) MapEntry(e.key, e.value!),
  ]..sort((a, b) => a.value.toLowerCase().compareTo(b.value.toLowerCase()));
  return out;
}

/// Whether the campaign selector is on screen (`showScope`): a real choice
/// (more than one option), or a filter already in force (always clearable).
bool showScope(int optionCount, String? applied) => optionCount > 1 || applied != null;

/// Under the selector while a scope applies.
const campaignScopeNote = 'Every figure below counts this campaign only.';

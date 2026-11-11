import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme/tokens.dart';
import '../../core/auth/app_gate.dart';
import '../../core/station/away_return.dart';
import '../../core/station/station_signals.dart';
import '../../core/telemetry/log.dart';
import '../../ui/primitives.dart';
import 'missed_access.dart';
import 'missed_calls_api.dart';
import 'missed_calls_copy.dart';
import 'missed_on_duty.dart';

/// "3 customers rang while you were away" (IQ50), or "… while you were on
/// your phone call" (IQ51): when the agent comes back from a pause that kept
/// customers from reaching them, the station says how many of their own
/// Missed rows arrived since it began, with the way to the list.
///
/// Asked once per return ([awayReturnProvider]), with
/// `GET /inbound/missed/count?assignee=me&since=<the pause's start>`, and only
/// where the list shows for the agent (`missedCallsAccessProvider`). None, or a failed
/// read, says nothing. It lasts until the agent dismisses it, opens the list
/// from it, a call reaches them or they leave the station.
@immutable
class RangWhileAway {
  const RangWhileAway({required this.badge, required this.kind});

  /// The count as the badge says it ("3", or "100+" past the cap).
  final String badge;
  final AwayKind kind;

  @override
  bool operator ==(Object other) => other is RangWhileAway && other.badge == badge && other.kind == kind;

  @override
  int get hashCode => Object.hash(badge, kind);

  @override
  String toString() => 'RangWhileAway($badge, ${kind.name})';
}

class RangWhileAwayController extends Notifier<RangWhileAway?> {
  static final _log = Log('missed');

  int _epoch = 0;

  @override
  RangWhileAway? build() {
    // Per station, not per workspace: a workspace change leaves the station, which clears it.
    final epoch = ++_epoch;
    // A return seen before this was built is not news: only those from now on are asked about.
    ref.listen<AwayReturn?>(awayReturnProvider, (prev, next) {
      if (next != null && next != prev) unawaited(_read(next, epoch));
    });
    ref.listen<bool>(stationSignalsProvider.select((s) => s.callActive || !s.onDuty), (_, over) {
      if (over) state = null;
    });
    return null;
  }

  Future<void> _read(AwayReturn back, int epoch) async {
    // The agent does not read the list (or its count has not answered yet): nothing to say.
    if (!ref.read(missedCallsAccessProvider).visible) return;
    try {
      final count = await ref.read(missedCallsApiProvider).count(since: back.since);
      if (!ref.mounted || epoch != _epoch || ref.read(awayReturnProvider) != back) return;
      state = count.badge.isEmpty ? null : RangWhileAway(badge: count.badge, kind: back.kind);
    } on Exception catch (e) {
      if (!ref.mounted || epoch != _epoch) return;
      reportToGate(ref, e);
      _log.info('Reading who rang while away failed', {'error': e.runtimeType.toString()});
    }
  }

  void dismiss() => state = null;
}

final rangWhileAwayProvider = NotifierProvider<RangWhileAwayController, RangWhileAway?>(RangWhileAwayController.new);

/// The notice on the station (waiting, the away card, a break): the count in
/// words, "See missed calls" (the on-duty sheet) and a way to dismiss it.
/// Announced politely when it appears.
class RangWhileAwayNotice extends ConsumerWidget {
  const RangWhileAwayNotice({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final rang = ref.watch(rangWhileAwayProvider);
    if (rang == null) return const SizedBox.shrink();
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final words = MissedCopy.rangWhileAway(rang.badge, phoneCall: rang.kind == AwayKind.phoneCall);
    return Padding(
      padding: const EdgeInsets.only(bottom: Space.md),
      child: AppCard(
        key: const Key('rang-while-away'),
        padding: const EdgeInsets.fromLTRB(Space.md, Space.sm, Space.xs, Space.xs),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.only(top: Space.sm),
                  child: Icon(Icons.phone_missed_outlined, size: 18, color: t.textSecondary),
                ),
                const SizedBox(width: Space.sm),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.only(top: Space.sm),
                    child: Semantics(liveRegion: true, child: Text(words, style: text.bodyMedium)),
                  ),
                ),
                IconButton(
                  key: const Key('rang-while-away-dismiss'),
                  tooltip: MissedCopy.dismiss,
                  icon: const Icon(Icons.close, size: 18),
                  onPressed: () => ref.read(rangWhileAwayProvider.notifier).dismiss(),
                ),
              ],
            ),
            TextButton(
              key: const Key('rang-while-away-open'),
              onPressed: () {
                ref.read(rangWhileAwayProvider.notifier).dismiss();
                ref.read(missedOnDutyOpenerProvider)(context);
              },
              child: const Text(MissedCopy.seeMissedCalls),
            ),
          ],
        ),
      ),
    );
  }
}

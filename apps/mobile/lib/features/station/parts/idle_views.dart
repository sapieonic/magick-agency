import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/tokens.dart';
import '../../../core/softphone/softphone_view.dart' show softphoneAvailabilityProvider;
import '../../../core/station/station_copy.dart' show awayRingBreakLabel;
import '../../../core/station/station_view.dart';
import '../../../ui/primitives.dart';
import '../../missed/missed_on_duty.dart';
import '../../missed/rang_while_away.dart';
import '../logic/format.dart';
import '../station_copy.dart';
import '../station_providers.dart';
import '../station_reads.dart';
import '../widgets/action_buttons.dart';
import '../widgets/state_band.dart';
import '../widgets/ticking.dart';
import 'banners.dart';
import 'layouts.dart';
import 'sheets.dart';

/// The screens with no call on them (design-spec §3): Start of day (joined, not taking calls), Ready
/// and No calls right now (available), On break and Break over, and the pause the app takes when
/// the agent leaves it. One band, one main action, nothing that does not belong to the state.

// ─── 01 Start of day ────────────────────────────────────────────────────────

/// Joined, not taking calls yet (`offline`): "Namaste, Sunita", today's work, "How will you work?"
/// and Start work. The phone's checks ran on the step before (the pre-flight, which is the same
/// screen before the join); here the agent only chooses how to work and starts.
class StartOfDayView extends ConsumerStatefulWidget {
  const StartOfDayView({super.key});

  @override
  ConsumerState<StartOfDayView> createState() => _StartOfDayViewState();
}

class _StartOfDayViewState extends ConsumerState<StartOfDayView> {
  WorkMode _mode = WorkMode.callsComeToMe;
  bool _switching = false;

  Future<void> _start() async {
    if (_mode == WorkMode.iDial && ref.read(softphoneAvailabilityProvider).startAllowed) {
      setState(() => _switching = true);
      try {
        await switchStationToSoftphone(context);
      } finally {
        if (mounted) setState(() => _switching = false);
      }
      return;
    }
    await ref.read(stationActionsProvider).goAvailable();
  }

  @override
  Widget build(BuildContext context) {
    final name = ref.watch(stationAgentNameProvider);
    final busy = ref.watch(stationViewProvider.select((v) => v?.busy ?? StationBusy.none));
    final softphone = ref.watch(softphoneAvailabilityProvider.select((a) => a.startAllowed));
    final mode = softphone ? _mode : WorkMode.callsComeToMe;
    final starting = busy == StationBusy.goingAvailable || _switching;
    return StationPage(
      band: StateBand(
        key: const Key('band-start'),
        tone: StationTone.start,
        icon: Icons.headphones,
        title: StationCopy.namaste(name),
        subtitle: StationCopy.startSubtitle,
      ),
      body: [
        const RecentReleaseCard(),
        WorkCard(
          key: const Key('offline-card'),
          softphone: softphone,
          mode: mode,
          onMode: (m) => setState(() => _mode = m),
        ),
      ],
      actions: LinkGate(
        child: MainActionButton(
          key: const Key('go-available'),
          label: starting ? StationCopy.starting : StationCopy.startWork,
          icon: Icons.play_arrow_rounded,
          busy: starting,
          onPressed: busy == StationBusy.none ? _start : null,
        ),
      ),
    );
  }
}

/// Today's work, today's call-laters, and "How will you work?" (Start of day, here and on the
/// pre-flight). The second tile is shown only while the soft phone may start calls.
class WorkCard extends ConsumerWidget {
  const WorkCard({super.key, required this.softphone, required this.mode, required this.onMode, this.campaignName, this.callLater});

  final bool softphone;
  final WorkMode mode;
  final ValueChanged<WorkMode> onMode;

  /// Overrides the station's work name (the pre-flight runs before the station exists).
  final String? campaignName;

  /// Today's call-laters, when known (null: not shown).
  final int? callLater;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final String work = campaignName ?? ref.watch(stationViewProvider.select((v) => v?.campaignName)) ?? '';
    final listen = ref.watch(stationListenNoticeProvider);
    final key = ref.watch(stationViewProvider.select((v) => v == null ? null : (campaignId: v.campaignId, offered: v.myContactsOffered)));
    final later = callLater ?? (key == null ? null : ref.watch(stationCallLaterProvider(key)).value?.todayCount);
    final target = key == null ? null : ref.watch(stationMyDayProvider(key.campaignId)).value?.target;
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        StationCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              NumberTileText(label: StationCopy.todaysWork, value: work),
              if ((later != null && later > 0) || target != null) ...[
                const SizedBox(height: Space.sm),
                TileRow(
                  children: [
                    if (target != null) NumberTile(key: const Key('target-tile'), label: StationCopy.target, value: StationCopy.targetCalls(target)),
                    if (later != null && later > 0)
                      NumberTile(key: const Key('call-later-count'), label: StationCopy.callLater, value: StationCopy.callLaterToday(later)),
                  ],
                ),
              ],
            ],
          ),
        ),
        const SizedBox(height: Space.md),
        Semantics(
          header: true,
          child: Row(
            children: [
              Icon(Icons.call_outlined, size: 20, color: t.textSecondary),
              const SizedBox(width: Space.sm),
              Expanded(child: Text(StationCopy.howWillYouWork, style: text.titleSmall!.copyWith(color: t.textSecondary))),
            ],
          ),
        ),
        const SizedBox(height: Space.sm),
        TileRow(
          children: [
            ChoiceTile(
              key: const Key('mode-calls-come'),
              icon: Icons.phone_callback_outlined,
              label: StationCopy.callsComeToMe,
              selected: mode == WorkMode.callsComeToMe,
              onTap: () => onMode(WorkMode.callsComeToMe),
            ),
            if (softphone)
              ChoiceTile(
                key: const Key('mode-i-dial'),
                icon: Icons.dialpad,
                label: StationCopy.iDialTheNumber,
                selected: mode == WorkMode.iDial,
                onTap: () => onMode(WorkMode.iDial),
              ),
          ],
        ),
        if (listen) ...[
          const SizedBox(height: Space.md),
          Text(
            StationCopy.supervisorMayListen,
            key: const Key('listen-footer'),
            textAlign: TextAlign.center,
            style: text.bodySmall,
          ),
        ],
      ],
    );
  }
}

/// A label over a value in words ("Today's work · Sahyadri Finance").
class NumberTileText extends StatelessWidget {
  const NumberTileText({super.key, required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    return MergeSemantics(
      child: DecoratedBox(
        decoration: BoxDecoration(color: t.bgPrimary, borderRadius: BorderRadius.circular(Radii.md)),
        child: Padding(
          padding: const EdgeInsets.all(Space.sm),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(label, style: text.bodySmall),
              const SizedBox(height: 2),
              Text(value, style: text.titleLarge),
            ],
          ),
        ),
      ),
    );
  }
}

/// A picture tile to choose one of two or more (How will you work?, Which break?): a green border
/// and a tick when picked, never colour alone.
class ChoiceTile extends StatelessWidget {
  const ChoiceTile({super.key, required this.icon, required this.label, required this.selected, required this.onTap, this.detail});

  final IconData icon;
  final String label;
  final String? detail;
  final bool selected;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final s = context.stateTokens;
    final text = Theme.of(context).textTheme;
    return Semantics(
      button: true,
      selected: selected,
      enabled: onTap != null,
      label: detail == null ? label : '$label, $detail',
      excludeSemantics: true,
      onTap: onTap,
      child: Material(
        color: selected ? s.ready.soft : t.bgSecondary,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(Radii.lg),
          side: BorderSide(color: selected ? s.ready.deep : t.borderStrong, width: selected ? 2.5 : 1.5),
        ),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 78),
            child: Stack(
              children: [
                Padding(
                  padding: const EdgeInsets.all(Space.md),
                  child: Row(
                    children: [
                      DecoratedBox(
                        decoration: BoxDecoration(color: t.bgSecondary, borderRadius: BorderRadius.circular(Radii.md)),
                        child: SizedBox.square(dimension: 40, child: Icon(icon, color: selected ? s.ready.deep : t.textSecondary)),
                      ),
                      const SizedBox(width: Space.sm),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(label, style: text.titleMedium),
                            if (detail != null) Text(detail!, style: text.bodySmall),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
                if (selected)
                  Positioned(
                    top: 4,
                    right: 4,
                    child: Icon(Icons.check_circle, size: 22, color: s.ready.deep),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

// ─── 02 Ready, 02c No calls right now ───────────────────────────────────────

/// Available. Ready (green): the pulse, "Next call is coming…", how long they have waited, My day
/// and the call-later list. No calls right now (slate) when the campaign is not dialling or, on a
/// campaign that assigns contacts, nothing is due for the agent: "Calls will start again" and the
/// reason. Take break is the one action on both.
///
/// Late binding ([StationView.dialActivity]): while a hidden dial rings for the agent it says
/// "Dialling a customer…" ahead of nothing due (a call may be moments away), and after unanswered
/// dials, "No answer from the last 2 numbers." under the pulse. Its headline is a polite live region
/// while dialling only.
class WaitingView extends ConsumerStatefulWidget {
  const WaitingView({super.key});

  @override
  ConsumerState<WaitingView> createState() => _WaitingViewState();
}

class _WaitingViewState extends ConsumerState<WaitingView> {
  @override
  Widget build(BuildContext context) {
    final since = ref.watch(stationViewProvider.select((v) => v?.phaseSince));
    final dialing = ref.watch(stationViewProvider.select((v) => v?.campaignDialing ?? true));
    final stopped = ref.watch(stationViewProvider.select((v) => v?.callsStopped));
    final busy = ref.watch(stationViewProvider.select((v) => v?.busy ?? StationBusy.none));
    final queue = ref.watch(stationViewProvider.select((v) => v?.queue));
    final dial = ref.watch(stationViewProvider.select((v) => v?.dialActivity));
    final now = ref.watch(stationClockProvider);
    final dialling = dial?.dialling ?? false;
    final nothingDue = !dialling && dialing && queue != null && queue.nothingDue;
    final quiet = !dialing || nothingDue;
    final unanswered = dialing && !nothingDue && dial != null ? StationCopy.unansweredLine(dial.unansweredInARow) : null;

    final Widget band;
    final List<Widget> body;
    if (quiet) {
      final next = queue?.nextDueAt;
      final reason = !dialing
          ? StationCopy.callsStopped(stopped)
          : switch (queue?.reason ?? QueueIdle.other) {
              QueueIdle.queueEmpty => StationCopy.noCustomersWaiting,
              QueueIdle.callbacksLater => next == null ? StationCopy.callsStartLater : StationCopy.nextCallAt(formatTime12(next)),
              QueueIdle.outsideCallingHours => next == null ? StationCopy.callsStartLater : StationCopy.callsStartAt(formatTime12(next)),
              QueueIdle.waitingForRetry || QueueIdle.other => next == null ? StationCopy.callsStartLater : StationCopy.nextCallAt(formatTime12(next)),
            };
      band = StateBand(
        key: const Key('band-no-calls'),
        tone: StationTone.quiet,
        icon: Icons.pause,
        title: StationCopy.noCallsNow,
        subtitle: reason,
      );
      body = [
        const RangWhileAwayNotice(),
        const RecentReleaseCard(),
        StationCard(
          key: Key(nothingDue ? 'nothing-due-card' : 'waiting-card'),
          child: Column(
            children: [
              const SizedBox(height: Space.sm),
              Icon(Icons.hourglass_empty, size: 40, color: context.stateTokens.quiet.deep),
              const SizedBox(height: Space.sm),
              Semantics(
                key: const Key('state-headline'),
                header: true,
                child: Text(StationCopy.callsWillStart, textAlign: TextAlign.center, style: Theme.of(context).textTheme.headlineSmall),
              ),
              const SizedBox(height: Space.xs),
              Text(
                !dialing ? '${StationCopy.nothingToDo} ${StationCopy.customersWhoRingIn}' : StationCopy.nothingToDo,
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodyMedium,
              ),
              const SizedBox(height: Space.sm),
            ],
          ),
        ),
        const SizedBox(height: Space.md),
        const MyDayCard(),
        const CallLaterCard(),
        const MissedToCallBackLine(),
      ];
    } else {
      band = StateBand(
        key: const Key('band-ready'),
        tone: StationTone.ready,
        icon: Icons.headphones,
        title: StationCopy.ready,
        subtitle: StationCopy.readySubtitle,
        trailing: since == null
            ? null
            : TickingBuilder(
                now: now,
                anchor: since,
                builder: (context, at) => BandClock(
                  formatClock(at.difference(since), padMinutes: false),
                  semanticsLabel: StationCopy.waiting(formatClock(at.difference(since), padMinutes: false)),
                ),
              ),
      );
      body = [
        const RangWhileAwayNotice(),
        const RecentReleaseCard(),
        StationCard(
          key: Key(dialling ? 'dialling-card' : 'waiting-card'),
          child: _PulseAndWords(
            words: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Semantics(
                      key: const Key('state-headline'),
                      header: true,
                      container: dialling,
                      liveRegion: dialling,
                      child: Text(
                        dialling ? StationCopy.diallingHeadline : StationCopy.nextCallComing,
                        style: Theme.of(context).textTheme.titleLarge,
                      ),
                    ),
                    if (since != null)
                      TickingBuilder(
                        now: now,
                        anchor: since,
                        builder: (context, at) => Text(
                          StationCopy.waiting(formatClock(at.difference(since), padMinutes: false)),
                          key: const Key('available-for'),
                          style: Theme.of(context).textTheme.bodyMedium,
                        ),
                      ),
                    if (unanswered != null)
                      Text(unanswered, key: const Key('unanswered-line'), style: Theme.of(context).textTheme.bodyMedium),
                  ],
                ),
          ),
        ),
        const SizedBox(height: Space.md),
        const MyDayCard(),
        const CallLaterCard(),
        const MissedToCallBackLine(),
      ];
    }

    return StationPage(
      band: band,
      body: body,
      actions: LinkGate(
        child: MainActionButton(
          key: const Key('take-break'),
          label: StationCopy.takeABreak,
          icon: Icons.free_breakfast_outlined,
          kind: ActionKind.rest,
          busy: busy == StationBusy.takingBreak,
          onPressed: busy == StationBusy.none ? () => showBreakSheet(context, queued: false) : null,
        ),
      ),
    );
  }
}

/// The pulse beside the words.
class _PulseAndWords extends StatelessWidget {
  const _PulseAndWords({required this.words});

  final Widget words;

  @override
  Widget build(BuildContext context) {
    // At large text the words take the card's whole width, and the pulse (decoration) gives way.
    if (MediaQuery.textScalerOf(context).scale(16) / 16 > 1.3) return words;
    return Row(children: [const _Pulse(), const SizedBox(width: Space.md), Expanded(child: words)]);
  }
}

/// The waiting pulse: the one thing that moves on Ready. Still (the ring stays drawn) under
/// reduced motion.
class _Pulse extends StatelessWidget {
  const _Pulse();

  @override
  Widget build(BuildContext context) {
    final c = context.stateTokens.ready;
    return ExcludeSemantics(
      child: SizedBox.square(
        dimension: 72,
        child: Stack(
          alignment: Alignment.center,
          children: [
            LiveDot(size: 72, color: c.band.withValues(alpha: 0.35)),
            DecoratedBox(
              decoration: BoxDecoration(color: c.soft, shape: BoxShape.circle, border: Border.all(color: c.band, width: 2.5)),
              child: SizedBox.square(dimension: 56, child: Icon(Icons.call_outlined, color: c.deep, size: 28)),
            ),
          ],
        ),
      ),
    );
  }
}

/// My day: three number tiles from the agent's own numbers for today (design-spec §4: tiles on the
/// phone). Calls today (connected; "/ 120" and a bar once the campaign has a target), Talk time, and
/// Will pay once the server sends it, numbers dialled until then. Nothing while the first read is
/// out or when it fails: no tile shows a number it does not have.
class MyDayCard extends ConsumerWidget {
  const MyDayCard({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final id = ref.watch(stationViewProvider.select((v) => v?.campaignId));
    if (id == null) return const SizedBox.shrink();
    final day = ref.watch(stationMyDayProvider(id)).value;
    if (day == null) return const SizedBox.shrink();
    final target = day.target;
    final willPay = day.willPay;
    return Padding(
      padding: const EdgeInsets.only(bottom: Space.md),
      child: StationCard(
        key: const Key('my-day'),
        icon: Icons.track_changes,
        title: StationCopy.myDay,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            TileRow(
              children: [
                NumberTile(
                  key: const Key('my-day-calls'),
                  label: StationCopy.callsToday,
                  value: '${day.callsToday}',
                  suffix: target == null ? null : '/ $target',
                ),
                NumberTile(
                  key: const Key('my-day-talk'),
                  label: StationCopy.talkTime,
                  value: formatHoursMinutes(Duration(seconds: day.talkSeconds)),
                ),
                if (willPay != null)
                  NumberTile(key: const Key('my-day-will-pay'), label: StationCopy.willPay, value: '$willPay')
                else
                  NumberTile(key: const Key('my-day-dialled'), label: StationCopy.dialled, value: '${day.dialled}'),
              ],
            ),
            if (target != null && target > 0) ...[
              const SizedBox(height: Space.sm),
              ClipRRect(
                borderRadius: BorderRadius.circular(Radii.pill),
                child: LinearProgressIndicator(
                  key: const Key('my-day-bar'),
                  value: (day.callsToday / target).clamp(0, 1).toDouble(),
                  minHeight: 8,
                  color: context.stateTokens.ready.band,
                  backgroundColor: context.tokens.bgTertiary,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// My call-later list: time chip and name, soonest first, with the line that says who will make
/// them (AS8: true to the campaign's routing). One due within five minutes has a filled chip and
/// "in 2 min". Shown only where today's My contacts serves it ([stationCallLaterProvider]).
class CallLaterCard extends ConsumerWidget {
  const CallLaterCard({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final key = ref.watch(stationViewProvider.select((v) => v == null ? null : (campaignId: v.campaignId, offered: v.myContactsOffered)));
    if (key == null) return const SizedBox.shrink();
    final list = ref.watch(stationCallLaterProvider(key)).value ?? CallLaterList.none;
    final items = list.items;
    if (items.isEmpty) return const SizedBox.shrink();
    // The server's word when it says (AS8, `comes_to_me`); else a campaign that assigns contacts
    // keeps the agent's own call-laters theirs (strict, preferred), and a pool campaign may give one
    // to another agent.
    final own = watchComesToMe(ref);
    final now = ref.watch(stationClockProvider);
    final s = context.stateTokens;
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: Space.md),
      child: StationCard(
        key: const Key('call-later-list'),
        icon: Icons.event_outlined,
        title: StationCopy.myCallLaterList,
        child: TickingBuilder(
          now: now,
          period: const Duration(seconds: 30),
          builder: (context, at) => Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              for (final item in items.take(6))
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: Space.xs),
                  child: MergeSemantics(
                    child: Row(
                      children: [
                        _TimeChip(
                          time: formatTime12(item.at),
                          soon: item.at.difference(at) <= const Duration(minutes: 5) && item.at.isAfter(at.subtract(const Duration(minutes: 1))),
                        ),
                        const SizedBox(width: Space.md),
                        Expanded(
                          child: Text(
                            item.name.isEmpty ? StationCopy.customer : item.name,
                            style: text.titleSmall,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                        if (item.overdue)
                          Text(StationCopy.late, key: const Key('call-later-late'), style: text.labelMedium!.copyWith(color: s.problem.deep, fontWeight: FontWeight.w700)),
                        if (item.at.difference(at) <= const Duration(minutes: 5) && item.at.isAfter(at.subtract(const Duration(minutes: 1))))
                          Flexible(
                            child: Text(
                            StationCopy.inMinutes((item.at.difference(at).inSeconds / 60).ceil()),
                            style: text.labelMedium!.copyWith(color: s.coming.deep, fontWeight: FontWeight.w700),
                          ),
                          ),
                      ],
                    ),
                  ),
                ),
              const SizedBox(height: Space.xs),
              Row(
                children: [
                  Icon(Icons.notifications_none, size: 18, color: t.textMuted),
                  const SizedBox(width: Space.xs),
                  Expanded(
                    child: Text(
                      own ? StationCopy.callLaterComesToYou : StationCopy.callLaterPool,
                      key: const Key('call-later-line'),
                      style: text.bodySmall,
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _TimeChip extends StatelessWidget {
  const _TimeChip({required this.time, required this.soon});

  final String time;
  final bool soon;

  @override
  Widget build(BuildContext context) {
    final c = context.stateTokens.coming;
    final text = Theme.of(context).textTheme;
    return DecoratedBox(
      decoration: BoxDecoration(color: soon ? c.band : c.soft, borderRadius: BorderRadius.circular(Radii.sm)),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: Space.sm, vertical: Space.xs),
        child: Text(time, style: text.titleSmall!.copyWith(color: soon ? c.ink : c.deep)),
      ),
    );
  }
}

// ─── 07 On break, 08 Break over ─────────────────────────────────────────────

/// On a break the agent chose. Amber, "On break · Tea", the time used against the reason's limit
/// ("4:18 / 15:00", a bar, "10:42 left of your 15 minutes."). Past the limit the same screen turns
/// red-orange: "Break time is over", "You are 2:05 late. Start calls now." A reason with no limit
/// shows only the time used and never turns, and after 30 minutes says how long it has been.
/// Start calls again; a quiet Finish work for today.
class BreakView extends ConsumerWidget {
  const BreakView({super.key});

  /// Today's long-break rule for a reason with no limit (the floor's).
  static const longBreak = Duration(minutes: 30);

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final onBreak = ref.watch(stationViewProvider.select((v) => v?.onBreak));
    final since = ref.watch(stationViewProvider.select((v) => v?.onBreak?.since ?? v?.phaseSince));
    final busy = ref.watch(stationViewProvider.select((v) => v?.busy ?? StationBusy.none));
    final now = ref.watch(stationClockProvider);
    final ending = busy == StationBusy.endingBreak || busy == StationBusy.goingAvailable || busy == StationBusy.cancellingBreak;
    final limit = onBreak?.limitMinutes;

    Widget page(DateTime at) {
      final used = since == null ? Duration.zero : at.difference(since);
      final limitAt = since == null || limit == null ? null : since.add(Duration(minutes: limit));
      final over = limitAt != null && secondsLeft(limitAt, at) == 0;
      final band = over
          ? StateBand(
              key: const Key('band-break-over'),
              tone: StationTone.over,
              icon: Icons.warning_amber_rounded,
              title: StationCopy.breakTimeOver,
              subtitle: StationCopy.youAreLate(formatClock(at.difference(limitAt), padMinutes: false)),
              trailing: BandClock('+${formatClock(at.difference(limitAt), padMinutes: false)}'),
            )
          : StateBand(
              key: const Key('band-break'),
              tone: StationTone.onBreak,
              icon: Icons.free_breakfast_outlined,
              title: StationCopy.onBreakTitle(onBreak?.label),
              subtitle: StationCopy.noCallsWillCome,
              trailing: since == null ? null : BandClock(formatClock(used, padMinutes: false)),
            );
      return StationPage(
        band: band,
        body: [
          const RangWhileAwayNotice(),
          _BreakCard(label: onBreak?.label, used: since == null ? null : used, limitMinutes: limit, over: over, at: at, limitAt: limitAt),
        ],
        actions: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            LinkGate(
              child: MainActionButton(
                key: const Key('end-break'),
                label: ending ? StationCopy.endingBreak : StationCopy.startCallsAgain,
                icon: Icons.play_arrow_rounded,
                busy: ending,
                onPressed: busy == StationBusy.none ? () => ref.read(stationActionsProvider).endBreak() : null,
              ),
            ),
            const SizedBox(height: Space.xs),
            LeaveStationButton(busy: busy),
          ],
        ),
      );
    }

    if (since == null) return page(now());
    return TickingBuilder(now: now, anchor: since, builder: (context, at) => page(at));
  }
}

class _BreakCard extends StatelessWidget {
  const _BreakCard({required this.label, required this.used, required this.limitMinutes, required this.over, required this.at, this.limitAt});

  final String? label;
  final Duration? used;
  final int? limitMinutes;
  final bool over;
  final DateTime at;
  final DateTime? limitAt;

  @override
  Widget build(BuildContext context) {
    final s = context.stateTokens;
    final c = over ? s.over : s.onBreak;
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final used = this.used;
    final limit = limitMinutes;
    return StationCard(
      key: const Key('break-card'),
      child: Column(
        children: [
          const SizedBox(height: Space.sm),
          DecoratedBox(
            decoration: BoxDecoration(color: c.soft, shape: BoxShape.circle),
            child: SizedBox.square(
              dimension: 72,
              child: Icon(over ? Icons.schedule : Icons.free_breakfast_outlined, size: 36, color: c.deep),
            ),
          ),
          if (label != null && label!.trim().isNotEmpty) ...[
            const SizedBox(height: Space.sm),
            Text(label!, style: text.titleLarge),
          ],
          if (used != null) ...[
            const SizedBox(height: Space.xs),
            Semantics(
              label: StationCopy.breakFor(formatClock(used)),
              excludeSemantics: true,
              child: Text.rich(
                TextSpan(
                  text: formatClock(used, padMinutes: false),
                  style: text.displayLarge!.copyWith(
                    fontSize: 56,
                    color: over ? c.deep : t.textPrimary,
                    fontFeatures: const [FontFeature.tabularFigures()],
                  ),
                  children: [
                    if (limit != null)
                      TextSpan(text: ' / ${formatClock(Duration(minutes: limit), padMinutes: false)}', style: text.titleLarge!.copyWith(color: t.textMuted)),
                  ],
                ),
                key: const Key('break-for'),
              ),
            ),
          ],
          if (limit != null && used != null) ...[
            const SizedBox(height: Space.sm),
            ClipRRect(
              borderRadius: BorderRadius.circular(Radii.pill),
              child: LinearProgressIndicator(
                value: over ? 1 : (used.inMilliseconds / Duration(minutes: limit).inMilliseconds).clamp(0, 1).toDouble(),
                minHeight: 10,
                color: c.band,
                backgroundColor: t.bgTertiary,
              ),
            ),
            const SizedBox(height: Space.sm),
            if (over)
              Text(
                StationCopy.yourBreakWas(limit),
                key: const Key('break-over'),
                textAlign: TextAlign.center,
                style: text.titleSmall!.copyWith(color: c.deep),
              )
            else
              Text(
                // Left rounds up, as every countdown here does: "0:01 left" until the limit, never "0:00 left".
                StationCopy.leftOfYour(formatClock(Duration(seconds: secondsLeft(limitAt!, at)), padMinutes: false), limit),
                key: const Key('break-left'),
                textAlign: TextAlign.center,
                style: text.titleSmall,
              ),
          ] else if (used != null && used >= BreakView.longBreak) ...[
            const SizedBox(height: Space.sm),
            Text(
              StationCopy.longBreak(used.inMinutes),
              key: const Key('break-long'),
              textAlign: TextAlign.center,
              style: text.titleSmall,
            ),
          ],
          const SizedBox(height: Space.sm),
        ],
      ),
    );
  }
}

// ─── Paused, you left the app ───────────────────────────────────────────────

/// The `device_away` pause (design-spec §3, phone only): the app stepped the agent out because it
/// left the screen. The amber screen, "Paused", "You left the app. No calls came." Mode B's
/// `away_ring` says this phone rings for customers who call in. Start calls again ends the pause.
class AwayView extends ConsumerWidget {
  const AwayView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final since = ref.watch(stationViewProvider.select((v) => v?.onBreak?.since ?? v?.phaseSince));
    final busy = ref.watch(stationViewProvider.select((v) => v?.busy ?? StationBusy.none));
    final ringing = ref.watch(stationViewProvider.select((v) => v?.onBreak?.isAwayRing ?? false));
    final noRing = ref.watch(stationViewProvider.select((v) => v?.onBreak?.noRing));
    final now = ref.watch(stationClockProvider);
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final resuming = busy == StationBusy.endingBreak || busy == StationBusy.goingAvailable || busy == StationBusy.cancellingBreak;

    return StationPage(
      band: StateBand(
        key: const Key('band-paused'),
        tone: StationTone.onBreak,
        icon: Icons.pause_circle_outline,
        title: ringing ? awayRingBreakLabel : StationCopy.pausedTitle,
        subtitle: StationCopy.pausedSubtitle,
        trailing: since == null
            ? null
            : TickingBuilder(
                now: now,
                anchor: since,
                builder: (context, at) => BandClock(formatClock(at.difference(since), padMinutes: false), key: const Key('away-for')),
              ),
      ),
      body: [
        const RangWhileAwayNotice(),
        StationCard(
          key: const Key('away-card'),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (since != null) Text(StationCopy.pausedSince(formatTime12(since)), style: text.titleMedium),
              if (ringing) ...[const SizedBox(height: Space.sm), Text(StationCopy.pausedRinging, style: text.bodyMedium)],
              if (noRing != null) ...[
                const SizedBox(height: Space.sm),
                Text(StationCopy.awayNoRing(noRing), key: const Key('away-no-ring'), style: text.bodyMedium!.copyWith(color: t.warning)),
              ],
              const SizedBox(height: Space.sm),
              Text(StationCopy.awayAutoReturnHint, key: const Key('away-auto-return'), style: text.bodySmall),
            ],
          ),
        ),
      ],
      actions: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          LinkGate(
            child: MainActionButton(
              key: const Key('resume'),
              label: resuming ? StationCopy.starting : StationCopy.startCallsAgain,
              icon: Icons.play_arrow_rounded,
              busy: resuming,
              // The end of the away pause is `/available`.
              onPressed: busy == StationBusy.none ? () => ref.read(stationActionsProvider).endBreak() : null,
            ),
          ),
          const SizedBox(height: Space.xs),
          LinkGate(
            child: QuietActionButton(
              key: const Key('break-instead'),
              label: StationCopy.breakInstead,
              icon: Icons.free_breakfast_outlined,
              onPressed: busy == StationBusy.none ? () => showBreakSheet(context, queued: false) : null,
            ),
          ),
        ],
      ),
    );
  }
}

/// "Finish work for today" as a quiet link (On break, Break over, Connecting). Never behind
/// [LinkGate]: leaving is plain HTTP, and with the tabs held while on duty it is the agent's only
/// way off a station whose line is down. Only a leave already in flight holds it.
class LeaveStationButton extends ConsumerWidget {
  const LeaveStationButton({super.key, required this.busy});

  final StationBusy busy;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final leaving = busy == StationBusy.leaving;
    return QuietActionButton(
      key: const Key('leave'),
      label: leaving ? StationCopy.finishing : StationCopy.finishWork,
      icon: Icons.logout,
      busy: leaving,
      onPressed: leaving ? null : () => leaveStation(context),
    );
  }
}

/// "The last call did not connect. You do not need to do anything." (design-spec §3, 02b): a call
/// that ended without needing an outcome (no answer, a busy line, the customer cut before the
/// agent spoke). A banner, not a screen, for 6 seconds or until the next call.
class RecentReleaseCard extends ConsumerStatefulWidget {
  const RecentReleaseCard({super.key, this.visibleFor = const Duration(seconds: 6)});

  final Duration visibleFor;

  @override
  ConsumerState<RecentReleaseCard> createState() => _RecentReleaseCardState();
}

class _RecentReleaseCardState extends ConsumerState<RecentReleaseCard> {
  ReleaseView? _shown;
  Timer? _hide;

  @override
  void initState() {
    super.initState();
    ref.listenManual<ReleaseView?>(stationViewProvider.select((v) => v?.release), (prev, next) {
      _hide?.cancel();
      if (next == null || next.requiresDisposition) {
        if (_shown != null) setState(() => _shown = null);
        return;
      }
      setState(() => _shown = next);
      _hide = Timer(widget.visibleFor, () {
        if (mounted) setState(() => _shown = null);
      });
    }, fireImmediately: true);
  }

  @override
  void dispose() {
    _hide?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final r = _shown;
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    return AnimatedSwitcher(
      duration: MediaQuery.disableAnimationsOf(context) ? Duration.zero : const Duration(milliseconds: 250),
      child: r == null
          ? const SizedBox(width: double.infinity)
          : Padding(
              key: ValueKey(r),
              padding: const EdgeInsets.only(bottom: Space.md),
              child: Semantics(
                liveRegion: true,
                container: true,
                child: AppCard(
                  key: const Key('recent-release'),
                  color: t.bgSecondary,
                  borderColor: t.borderStrong,
                  padding: const EdgeInsets.symmetric(horizontal: Space.md, vertical: Space.sm),
                  child: Row(
                    children: [
                      Icon(Icons.phone_missed_outlined, color: t.textSecondary),
                      const SizedBox(width: Space.sm),
                      Expanded(child: Text(StationCopy.lastCallNotConnected, style: text.bodyMedium)),
                    ],
                  ),
                ),
              ),
            ),
    );
  }
}

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/routes.dart';
import '../../../app/theme/app_theme.dart';
import '../../../app/theme/tokens.dart';
import '../../../core/flags/feature_flags.dart' show contactAssignmentEnabledProvider;
import '../../../core/softphone/softphone_view.dart' show softphoneAvailabilityProvider;
import '../../../core/station/station_view.dart';
import '../../../ui/primitives.dart';
import '../../missed/missed_on_duty.dart';
import '../logic/format.dart';
import '../station_copy.dart';
import '../station_providers.dart';
import '../widgets/ticking.dart';
import 'banners.dart';
import 'layouts.dart';
import 'sheets.dart';

/// The phases with no call on screen: available, offline, on break, and the
/// pause the app takes when the agent leaves it.

/// Available: waiting for the next customer. On a `strict` or `preferred`
/// campaign with nothing due for the agent (contact assignment), it says so
/// and why ("Nothing due now") instead of the plain waiting words: no call is
/// on its way, and the agent should know it is not the line.
class WaitingView extends ConsumerWidget {
  const WaitingView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final since = ref.watch(stationViewProvider.select((v) => v?.phaseSince));
    final dialing = ref.watch(stationViewProvider.select((v) => v?.campaignDialing ?? true));
    final message = ref.watch(stationViewProvider.select((v) => v?.campaignMessage));
    final busy = ref.watch(stationViewProvider.select((v) => v?.busy ?? StationBusy.none));
    final queue = ref.watch(stationViewProvider.select((v) => v?.queue));
    final now = ref.watch(stationClockProvider);
    final t = context.tokens;
    // A paused campaign says so first: nothing is due because nothing is dialled.
    final nothingDue = dialing && queue != null && queue.nothingDue;
    final next = queue?.nextDueAt;

    return IdleLayout(
      body: [
        const RecentReleaseCard(),
        _StateCard(
          key: Key(nothingDue ? 'nothing-due-card' : 'waiting-card'),
          pill: const StatusPill(StationCopy.available, tone: Tone.live, leading: LiveDot()),
          headline: !dialing
              ? StationCopy.pausedHeadline
              : (nothingDue ? StationCopy.nothingDueHeadline : StationCopy.waitingHeadline),
          headlineColor: dialing ? null : t.warning,
          detail: !dialing
              ? (message != null && message.trim().isNotEmpty ? message : StationCopy.pausedHint)
              : nothingDue
                  ? '${StationCopy.nothingDueDetail(queue.reason ?? QueueIdle.other, next == null ? null : formatDueAt(next, now()))} '
                      '${StationCopy.nothingDueKeepOpen}'
                  : StationCopy.waitingHint,
          footer: since == null
              ? null
              : TickingBuilder(
                  now: now,
                  anchor: since,
                  builder: (context, at) => Text(
                    StationCopy.availableFor(formatClock(at.difference(since))),
                    key: const Key('available-for'),
                    style: monoStyle(context, size: 13),
                  ),
                ),
        ),
        // IQ48: the customers waiting to be called back, a tap from the list.
        const MissedToCallBackLine(),
      ],
      // Leave is plain HTTP: it stays offered while the socket is down.
      actions: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          const MyContactsButton(),
          SwitchToSoftphoneButton(busy: busy),
          ButtonPair(
            first: LinkGate(
              child: OutlinedButton(
                key: const Key('take-break'),
                onPressed: busy == StationBusy.none ? () => showBreakSheet(context, queued: false) : null,
                child: BusyLabel(label: StationCopy.takeBreak, busy: busy == StationBusy.takingBreak),
              ),
            ),
            second: LeaveStationButton(busy: busy),
          ),
        ],
      ),
    );
  }
}

/// "My contacts" (contact assignment) on the waiting screen, while the
/// surface is on for the agent's account and the campaign has one
/// ([StationView.myContactsOffered]: it assigns contacts or lets agents
/// retry): whom the agent holds on this campaign, and calling one of them
/// now. Nothing otherwise. Followed by a gap, so it sits above the screen's
/// other actions.
class MyContactsButton extends ConsumerWidget {
  const MyContactsButton({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final enabled = ref.watch(contactAssignmentEnabledProvider);
    final campaignId = ref.watch(stationViewProvider.select((v) => v?.campaignId));
    final offered = ref.watch(stationViewProvider.select((v) => v?.myContactsOffered ?? false));
    if (!enabled || !offered || campaignId == null) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: Space.sm),
      child: OutlinedButton.icon(
        key: const Key('my-contacts'),
        onPressed: () => GoRouter.maybeOf(context)?.go(Routes.myContacts(campaignId)),
        icon: const Icon(Icons.people_alt_outlined),
        label: const Text(StationCopy.myContacts),
      ),
    );
  }
}

/// "Switch to soft phone" (SP7) on the waiting and break screens, while the
/// soft phone may start calls; nothing otherwise. It applies at once here (no
/// call is on screen), and the station then shows the soft phone in place.
/// Followed by a gap, so it sits above the screen's other actions.
class SwitchToSoftphoneButton extends ConsumerStatefulWidget {
  const SwitchToSoftphoneButton({super.key, required this.busy});

  final StationBusy busy;

  @override
  ConsumerState<SwitchToSoftphoneButton> createState() => _SwitchToSoftphoneButtonState();
}

class _SwitchToSoftphoneButtonState extends ConsumerState<SwitchToSoftphoneButton> {
  bool _switching = false;

  Future<void> _switch() async {
    setState(() => _switching = true);
    try {
      await switchStationToSoftphone(context);
    } finally {
      if (mounted) setState(() => _switching = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final allowed = ref.watch(softphoneAvailabilityProvider.select((a) => a.startAllowed));
    if (!allowed) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: Space.sm),
      child: LinkGate(
        child: OutlinedButton.icon(
          key: const Key('switch-softphone'),
          onPressed: widget.busy == StationBusy.none && !_switching ? _switch : null,
          icon: const Icon(Icons.dialpad),
          label: BusyLabel(
            label: _switching ? StationCopy.switchingToSoftphone : StationCopy.switchToSoftphone,
            busy: _switching,
          ),
        ),
      ),
    );
  }
}

/// Joined but not taking calls yet.
class OfflineView extends ConsumerWidget {
  const OfflineView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final busy = ref.watch(stationViewProvider.select((v) => v?.busy ?? StationBusy.none));
    return IdleLayout(
      body: const [
        RecentReleaseCard(),
        _StateCard(
          key: Key('offline-card'),
          pill: StatusPill(StationCopy.offline),
          headline: StationCopy.offlineHeadline,
          detail: StationCopy.offlineHint,
        ),
      ],
      actions: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          LinkGate(
            child: FilledButton(
              key: const Key('go-available'),
              onPressed: busy == StationBusy.none ? () => ref.read(stationActionsProvider).goAvailable() : null,
              style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
              child: BusyLabel(
                label: busy == StationBusy.goingAvailable ? StationCopy.goingAvailable : StationCopy.goAvailable,
                busy: busy == StationBusy.goingAvailable,
              ),
            ),
          ),
          const SizedBox(height: Space.sm),
          LeaveStationButton(busy: busy),
        ],
      ),
    );
  }
}

/// On a break the agent chose.
class BreakView extends ConsumerWidget {
  const BreakView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final onBreak = ref.watch(stationViewProvider.select((v) => v?.onBreak));
    final since = ref.watch(stationViewProvider.select((v) => v?.onBreak?.since ?? v?.phaseSince));
    final busy = ref.watch(stationViewProvider.select((v) => v?.busy ?? StationBusy.none));
    final now = ref.watch(stationClockProvider);
    final ending = busy == StationBusy.endingBreak || busy == StationBusy.goingAvailable || busy == StationBusy.cancellingBreak;

    return IdleLayout(
      body: [
        _StateCard(
          key: const Key('break-card'),
          pill: StatusPill(
            StationCopy.onBreak,
            leading: Icon(Icons.free_breakfast_outlined, size: 14, color: context.tokens.textSecondary),
          ),
          headline: StationCopy.breakTitle(onBreak?.label),
          detail: StationCopy.breakHint,
          footer: since == null
              ? null
              : TickingBuilder(
                  now: now,
                  anchor: since,
                  builder: (context, at) => Text(
                    StationCopy.breakFor(formatClock(at.difference(since))),
                    key: const Key('break-for'),
                    style: monoStyle(context, size: 13),
                  ),
                ),
        ),
      ],
      actions: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          LinkGate(
            child: FilledButton(
              key: const Key('end-break'),
              onPressed: busy == StationBusy.none ? () => ref.read(stationActionsProvider).endBreak() : null,
              style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
              child: BusyLabel(label: ending ? StationCopy.endingBreak : StationCopy.endBreak, busy: ending),
            ),
          ),
          const SizedBox(height: Space.sm),
          SwitchToSoftphoneButton(busy: busy),
          LeaveStationButton(busy: busy),
        ],
      ),
    );
  }
}

/// The `device_away` pause: the app stepped the agent out of the pool because
/// it left the foreground. Not a break, and it says so.
class AwayView extends ConsumerWidget {
  const AwayView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final since = ref.watch(stationViewProvider.select((v) => v?.onBreak?.since ?? v?.phaseSince));
    final busy = ref.watch(stationViewProvider.select((v) => v?.busy ?? StationBusy.none));
    final now = ref.watch(stationClockProvider);
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final resuming = busy == StationBusy.endingBreak || busy == StationBusy.goingAvailable || busy == StationBusy.cancellingBreak;

    return IdleLayout(
      body: [
        AppCard(
          key: const Key('away-card'),
          borderColor: t.warning.withValues(alpha: 0.35),
          padding: const EdgeInsets.all(Space.lg),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const StatusPill(StationCopy.awayPill, tone: Tone.warn),
              const SizedBox(height: Space.md),
              Text(StationCopy.awayHeadline, style: text.headlineSmall),
              const SizedBox(height: Space.sm),
              Text(
                StationCopy.awayDetail(since == null ? null : formatTime(since)),
                style: text.bodyMedium!.copyWith(color: t.textSecondary),
              ),
              const SizedBox(height: Space.sm),
              Text(
                StationCopy.awayAutoReturnHint,
                key: const Key('away-auto-return'),
                style: text.bodySmall!.copyWith(color: t.textMuted),
              ),
            ],
          ),
        ),
        const SizedBox(height: Space.md),
        AppCard(
          child: Column(
            children: [
              if (since != null)
                _KeyValue(
                  label: StationCopy.awayFor,
                  value: TickingBuilder(
                    now: now,
                    anchor: since,
                    builder: (context, at) => Text(
                      formatClock(at.difference(since)),
                      key: const Key('away-for'),
                      style: monoStyle(context, size: 14, color: t.textPrimary),
                    ),
                  ),
                ),
              _KeyValue(
                label: StationCopy.awayCountsAs,
                value: Text(StationCopy.awayCountsAsValue, style: text.titleSmall),
              ),
            ],
          ),
        ),
      ],
      actions: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          LinkGate(
            child: EmberButton(
              key: const Key('resume'),
              label: resuming ? StationCopy.goingAvailable : StationCopy.resume,
              icon: Icons.play_arrow_rounded,
              // "Resume" is the end of the away break, which is `/available`.
              onPressed: busy == StationBusy.none ? () => ref.read(stationActionsProvider).endBreak() : null,
            ),
          ),
          const SizedBox(height: Space.sm),
          ButtonPair(
            first: LinkGate(
              child: OutlinedButton(
                key: const Key('break-instead'),
                onPressed: busy == StationBusy.none ? () => showBreakSheet(context, queued: false) : null,
                child: const Text(StationCopy.breakInstead, textAlign: TextAlign.center),
              ),
            ),
            second: LeaveStationButton(busy: busy),
          ),
        ],
      ),
    );
  }
}

class _KeyValue extends StatelessWidget {
  const _KeyValue({required this.label, required this.value});

  final String label;
  final Widget value;

  @override
  Widget build(BuildContext context) {
    return MergeSemantics(
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: Space.xs),
        child: Wrap(
          alignment: WrapAlignment.spaceBetween,
          crossAxisAlignment: WrapCrossAlignment.center,
          spacing: Space.md,
          children: [
            Text(label, style: Theme.of(context).textTheme.bodySmall),
            value,
          ],
        ),
      ),
    );
  }
}

class _StateCard extends StatelessWidget {
  const _StateCard({super.key, required this.pill, required this.headline, required this.detail, this.footer, this.headlineColor});

  final Widget pill;
  final String headline;
  final String detail;
  final Widget? footer;
  final Color? headlineColor;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return AppCard(
      padding: const EdgeInsets.symmetric(horizontal: Space.lg, vertical: Space.xl),
      child: Column(
        children: [
          pill,
          const SizedBox(height: Space.md),
          Semantics(
            header: true,
            child: Text(
              headline,
              textAlign: TextAlign.center,
              style: text.headlineSmall!.copyWith(color: headlineColor),
            ),
          ),
          const SizedBox(height: Space.sm),
          Text(
            detail,
            textAlign: TextAlign.center,
            style: text.bodyMedium!.copyWith(color: context.tokens.textSecondary),
          ),
          if (footer != null) ...[const SizedBox(height: Space.md), footer!],
        ],
      ),
    );
  }
}

/// "Leave". Never behind [LinkGate]: leaving is plain HTTP, and with the tabs
/// held while on duty it is the agent's only way off a station whose socket is
/// down. Only a leave already in flight disables it (another action in flight
/// does not: the core runs a leave alongside it).
class LeaveStationButton extends ConsumerWidget {
  const LeaveStationButton({super.key, required this.busy});

  final StationBusy busy;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final leaving = busy == StationBusy.leaving;
    return TextButton(
      key: const Key('leave'),
      onPressed: leaving ? null : () => leaveStation(context),
      child: BusyLabel(label: leaving ? StationCopy.leaving : StationCopy.leave, busy: leaving),
    );
  }
}

/// A call that ended without a wrap-up (no answer, busy line…), said briefly
/// in the waiting screen so the agent knows why the screen cleared.
class RecentReleaseCard extends ConsumerStatefulWidget {
  const RecentReleaseCard({super.key, this.visibleFor = const Duration(seconds: 8)});

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
    final color = switch (r?.tone) {
      ReleaseTone.danger => t.danger,
      ReleaseTone.warning => t.warning,
      _ => t.textSecondary,
    };
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
                  borderColor: color.withValues(alpha: 0.4),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(r.headline, style: text.titleSmall!.copyWith(color: color)),
                      const SizedBox(height: 2),
                      Text(r.detail, style: text.bodySmall),
                    ],
                  ),
                ),
              ),
            ),
    );
  }
}

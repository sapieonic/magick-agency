import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/routes.dart';
import '../../../app/theme/tokens.dart';
import '../../../core/softphone/softphone_host.dart';
import '../../../core/softphone/softphone_view.dart' show softphoneAvailabilityProvider;
import '../../../core/station/station_copy.dart' show leftOfflineCopy;
import '../../../core/station/station_view.dart';
import '../logic/format.dart';
import '../station_copy.dart';
import '../station_reads.dart';
import '../widgets/action_buttons.dart';
import '../widgets/tile_pictures.dart';
import 'contact_details.dart';
import 'layouts.dart' show ButtonPair, NumberTile, TileRow;

/// The station's dialogs and bottom sheets. Free functions so the phase views
/// stay small and every flow is one call. They take a [BuildContext] and no
/// [WidgetRef] on purpose: see below.
///
/// Every one of them sits on the root navigator, above the station, so each is
/// opened with a [StationModalScope] that says when it stops making sense (a
/// call arrived, the call it was about ended or was replaced) and closes itself
/// then ([StationModalGuard]). And each captures what it needs (the container,
/// the actions, the router) BEFORE it awaits: the widget that opened it is
/// often gone by the time the agent answers (the station switches its body on
/// every change of phase), and a [WidgetRef] used after its widget is gone
/// throws.

/// Whether a station dialog or sheet still belongs on screen, given the station
/// as it is now.
typedef StationModalScope = bool Function(StationView? view);

/// A question for a waiting agent: holds until a call is on screen (ringing,
/// on a call, wrap-up).
bool noCallOnScreen(StationView? view) => !(view?.callActive ?? false);

/// About one call in one phase: holds while [attemptId] is still the call on
/// screen (a campaign attempt or an inbound call, [StationView.callId]) and the
/// agent is still in one of [phases]. Another call, the end of this one or
/// leaving the station closes it.
StationModalScope sameCall(String? attemptId, Set<AgentPhase> phases) =>
    (v) => v != null && v.callId == attemptId && phases.contains(v.phase);

/// [sameCall] for the call and phase on screen right now.
StationModalScope thisCallNow(StationView? view) => sameCall(view?.callId, {if (view != null) view.phase});

/// "After this call": holds through the rest of this call (on call, wrap-up)
/// and the moments after it, and closes when another call reaches the agent or
/// the station closes.
StationModalScope untilNextCall(String? attemptId) =>
    (v) => v != null && (v.callId == null || v.callId == attemptId);

/// A yes/no dialog. [danger] paints the confirm action as destructive. With a
/// [scope] the dialog closes itself, answered "no", once the scope no longer
/// holds (see [StationModalGuard]).
Future<bool> confirmDialog(
  BuildContext context, {
  required String title,
  required String message,
  required String confirm,
  String cancel = StationCopy.cancel,
  bool danger = false,
  StationModalScope? scope,
}) async {
  final t = context.tokens;
  final ok = await showDialog<bool>(
    context: context,
    builder: (context) {
      final dialog = AlertDialog(
        title: Text(title),
        content: SingleChildScrollView(child: Text(message)),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: Text(cancel)),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            style: danger ? FilledButton.styleFrom(backgroundColor: t.dangerDeep, foregroundColor: t.onAccent) : null,
            child: Text(confirm),
          ),
        ],
      );
      return scope == null ? dialog : StationModalGuard(scope: scope, child: dialog);
    },
  );
  return ok ?? false;
}

/// Closes the dialog or sheet it sits in once [scope] stops holding. Those
/// routes sit on the root navigator, above the station, so without this
/// "Leave this station?" would cover a ringing call, and a dialog about one
/// call could be answered about the next. Closing answers nothing: the caller
/// gets null.
class StationModalGuard extends ConsumerStatefulWidget {
  const StationModalGuard({super.key, required this.scope, required this.child});

  final StationModalScope scope;
  final Widget child;

  @override
  ConsumerState<StationModalGuard> createState() => _StationModalGuardState();
}

class _StationModalGuardState extends ConsumerState<StationModalGuard> {
  bool _closing = false;

  @override
  void initState() {
    super.initState();
    // Immediately too: the station may have moved on while the route was opening.
    ref.listenManual<bool>(stationViewProvider.select(widget.scope), (_, holds) {
      if (!holds) _close();
    }, fireImmediately: true);
  }

  void _close() {
    if (_closing) return;
    _closing = true;
    // Not inside the build or notification that told us.
    Future.microtask(() {
      if (!mounted) return;
      final route = ModalRoute.of(context);
      if (route == null || !route.isActive) return;
      final navigator = Navigator.of(context);
      route.isCurrent ? navigator.pop() : navigator.removeRoute(route);
    });
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

/// [StationModalGuard] for a question asked while waiting: a call reaching the
/// agent closes it.
class CloseWhenCallArrives extends StatelessWidget {
  const CloseWhenCallArrives({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) => StationModalGuard(scope: noCallOnScreen, child: child);
}

/// The screen-reader path of Slide to end call (a slide cannot be done reliably with one). Closes
/// with the call (or the phase) it was asked about: the control that asked is gone by then.
Future<bool> confirmHangUp(BuildContext context) {
  final view = ProviderScope.containerOf(context, listen: false).read(stationViewProvider);
  return confirmDialog(
    context,
    title: StationCopy.hangUpConfirmTitle,
    message: StationCopy.hangUpConfirmBody,
    confirm: StationCopy.endCall,
    cancel: StationCopy.keepCall,
    danger: true,
    scope: thisCallNow(view),
  );
}

/// The break sheet's answer for "Switch to soft phone" (the soft phone's own
/// reserved break code, never one of the campaign's reasons).
const switchToSoftphoneChoice = 'soft_phone';

/// Break reasons. While a call is on screen the break is queued ("Break after
/// this call"); otherwise it starts now.
///
/// While the soft phone may start calls (`softphoneAvailabilityProvider`'s
/// `startAllowed`), the sheet also offers "Switch to soft phone" (SP7): queued
/// the same way while a call is on screen, at once otherwise.
///
/// "After this call" stays a valid answer after the call ends: the sheet stays
/// open through wrap-up, and a break picked there is still sent (the server
/// queues it behind the wrap-up, or starts it if the agent is already free).
/// Only another call reaching the agent closes it.
Future<void> showBreakSheet(BuildContext context, {required bool queued}) async {
  final container = ProviderScope.containerOf(context, listen: false);
  final actions = container.read(stationActionsProvider);
  final softphone = container.read(softphoneAvailabilityProvider).startAllowed;
  final host = softphone ? container.read(softphoneHostActionsProvider) : null;
  final messenger = ScaffoldMessenger.maybeOf(context);
  final code = await pickBreakReason(context, queued: queued);
  if (code == null) return;
  final now = container.read(stationViewProvider);
  if (now == null) return;
  // Picked in the same instant a call arrived: a break "now" is no longer what
  // the sheet offered. The call screen offers one after the call instead.
  if (!queued && now.callActive) return;
  if (code == switchToSoftphoneChoice) {
    // The server queues it behind the call or wrap-up exactly like a break.
    if (host != null) await _switchToSoftphone(host, messenger);
    return;
  }
  await actions.takeBreak(code);
}

/// Which break? (06): the campaign's reasons as picture tiles, and "Dial a number myself" while the
/// soft phone may start calls. The code picked ([switchToSoftphoneChoice] for the soft phone), or
/// null for Cancel or a sheet that closed itself (a call arrived; [queued]: another call).
Future<String?> pickBreakReason(BuildContext context, {required bool queued}) async {
  final container = ProviderScope.containerOf(context, listen: false);
  final view = container.read(stationViewProvider);
  final options = (view?.breakOptions ?? const <BreakOption>[])
      // The app's own pause and the soft phone are not breaks an agent picks
      // from the campaign's reasons.
      .where((o) => o.code != 'device_away' && o.code != switchToSoftphoneChoice)
      .toList(growable: false);
  final softphone = container.read(softphoneAvailabilityProvider).startAllowed;
  final scope = queued ? untilNextCall(view?.callId) : noCallOnScreen;
  final code = await showModalBottomSheet<String>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (context) {
      final text = Theme.of(context).textTheme;
      return StationModalGuard(
        scope: scope,
        child: SingleChildScrollView(
          key: const Key('break-sheet'),
          padding: const EdgeInsets.fromLTRB(Space.lg, 0, Space.lg, Space.lg),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Semantics(header: true, child: Text(StationCopy.whichBreak, style: text.headlineSmall)),
                  ),
                  TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text(StationCopy.cancel)),
                ],
              ),
              Text(queued ? StationCopy.whichBreakAfterCall : StationCopy.whichBreakNow, style: text.bodyMedium),
              const SizedBox(height: Space.md),
              if (options.isEmpty)
                Text(StationCopy.noBreakReasons, style: text.bodyMedium)
              else
                _TileGrid(
                  children: [
                    for (final o in options)
                      _BreakTile(
                        key: Key('break-${o.code}'),
                        option: o,
                        onTap: () => Navigator.of(context).pop(o.code),
                      ),
                  ],
                ),
              if (softphone) ...[
                const Divider(height: Space.xl),
                ListTile(
                  key: const Key('break-switch-softphone'),
                  minTileHeight: Space.touch + 8,
                  contentPadding: const EdgeInsets.symmetric(horizontal: Space.sm),
                  leading: const Icon(Icons.dialpad),
                  title: const Text(StationCopy.dialMyself),
                  subtitle: Text(queued ? StationCopy.switchAfterCallHint : StationCopy.switchHint),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => Navigator.of(context).pop(switchToSoftphoneChoice),
                ),
              ],
            ],
          ),
        ),
      );
    },
  );
  return code;
}

/// Switches this campaign station to the soft phone (SP7): at once while
/// waiting or on a break, queued behind a call or wrap-up (the pill then says
/// "Switching after this call"). A refusal is said in a snackbar; nothing
/// changed.
Future<void> switchStationToSoftphone(BuildContext context) => _switchToSoftphone(
      ProviderScope.containerOf(context, listen: false).read(softphoneHostActionsProvider),
      ScaffoldMessenger.maybeOf(context),
    );

Future<void> _switchToSoftphone(SoftphoneHostActions host, ScaffoldMessengerState? messenger) async {
  final result = await host.switchToSoftphone();
  if (result case SoftphoneSwitchRefused(:final message)) {
    messenger?.showSnackBar(SnackBar(key: const Key('switch-refused'), content: Text(message)));
  }
}

/// Withdraws a switch to the soft phone still queued behind this call (the
/// pill's ✕). A refusal (it already applied, say) is said in a snackbar.
Future<void> cancelSoftphoneSwitch(BuildContext context) async {
  final container = ProviderScope.containerOf(context, listen: false);
  final messenger = ScaffoldMessenger.maybeOf(context);
  final result = await container.read(softphoneHostActionsProvider).cancelSwitch();
  if (result case SoftphoneSwitchRefused(:final message)) {
    messenger?.showSnackBar(SnackBar(key: const Key('cancel-switch-refused'), content: Text(message)));
  }
}

/// Finish work for today (11): refused while a call is on screen; otherwise asked on the Finish
/// work sheet (the safe choice is the big one), and then back to the work list once the server
/// agreed.
///
/// Plain HTTP, so it is offered whatever the socket is doing.
Future<void> leaveStation(BuildContext context) async {
  // Captured now: leaving closes the station, which swaps this screen's body
  // (and the button that asked) before the leave itself has finished.
  final container = ProviderScope.containerOf(context, listen: false);
  final messenger = ScaffoldMessenger.of(context);
  final router = GoRouter.of(context);
  final actions = container.read(stationActionsProvider);
  final view = container.read(stationViewProvider);
  if (view != null && view.callActive) {
    messenger.showSnackBar(const SnackBar(content: Text(StationCopy.finishCallFirst)));
    return;
  }
  final ok = await showFinishWorkSheet(context);
  if (!ok) return;
  // Confirmed in the same instant a call arrived: the call comes first.
  if (container.read(stationViewProvider)?.callActive ?? false) {
    messenger.showSnackBar(const SnackBar(content: Text(StationCopy.finishCallFirst)));
    return;
  }
  actions.dismissActionError();
  final outcome = await actions.leave();
  // A refusal lands in actionError and keeps the agent here, where it shows.
  if (outcome == LeaveOutcome.stayed) return;
  if (outcome == LeaveOutcome.leftOffline) {
    messenger.showSnackBar(const SnackBar(key: Key('left-offline'), content: Text(leftOfflineCopy)));
  }
  router.go(Routes.home);
}

/// Where the call is heard: phone, speaker, a headset. Closes with the call.
Future<void> showAudioRouteSheet(BuildContext context) async {
  final container = ProviderScope.containerOf(context, listen: false);
  final actions = container.read(stationActionsProvider);
  final view = container.read(stationViewProvider);
  final audio = view?.audio ?? const AudioView();
  final scope = thisCallNow(view);
  final picked = await showModalBottomSheet<AudioRouteOption>(
    context: context,
    useSafeArea: true,
    isScrollControlled: true,
    builder: (context) {
      final text = Theme.of(context).textTheme;
      final t = context.tokens;
      return StationModalGuard(
        scope: scope,
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(Space.lg, 0, Space.lg, Space.lg),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Semantics(header: true, child: Text(StationCopy.audioSheetTitle, style: text.titleLarge)),
              const SizedBox(height: Space.sm),
              if (audio.routes.isEmpty) Text(StationCopy.noRoutes, style: text.bodyMedium),
              for (final r in audio.routes)
                ListTile(
                  key: Key('route-${r.id}'),
                  minTileHeight: Space.touch + 8,
                  leading: Icon(routeIcon(r.kind)),
                  title: Text(r.name),
                  selected: r == audio.route,
                  selectedColor: t.accentHover,
                  trailing: r == audio.route ? const Icon(Icons.check) : null,
                  onTap: () => Navigator.of(context).pop(r),
                ),
            ],
          ),
        ),
      );
    },
  );
  if (picked != null && picked != audio.route && scope(container.read(stationViewProvider))) await actions.setRoute(picked);
}

IconData routeIcon(AudioRouteKind? kind) => switch (kind) {
  AudioRouteKind.earpiece => Icons.phone_in_talk,
  AudioRouteKind.speaker => Icons.volume_up,
  AudioRouteKind.wired => Icons.headset,
  AudioRouteKind.bluetooth => Icons.bluetooth_audio,
  null => Icons.hearing,
};

/// Every contact field, the caller ID and the history: the on-call "Details".
/// About [call] only: it closes when that call ends or another one arrives,
/// so it never shows one customer's details over the next one's call.
Future<void> showDetailsSheet(BuildContext context, CallView call) {
  final view = ProviderScope.containerOf(context, listen: false).read(stationViewProvider);
  final scope = sameCall(call.attemptId, {if (view != null) view.phase});
  return showModalBottomSheet<void>(
    context: context,
    useSafeArea: true,
    isScrollControlled: true,
    builder: (context) => StationModalGuard(
      scope: scope,
      child: DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.75,
        minChildSize: 0.4,
        maxChildSize: 0.95,
        builder: (context, controller) {
          final text = Theme.of(context).textTheme;
          return ListView(
            key: const Key('details-sheet'),
            controller: controller,
            padding: const EdgeInsets.fromLTRB(Space.lg, 0, Space.lg, Space.xl),
            children: [
              Semantics(header: true, child: Text(StationCopy.detailsTitle, style: text.titleLarge)),
              const SizedBox(height: Space.xs),
              Text(
                '${call.displayName ?? formatPhone(call.phoneE164)} · ${StationCopy.attempt(call.attemptNumber)}',
                style: text.bodySmall,
              ),
              const SizedBox(height: Space.md),
              if (call.promise != null) ...[PromiseLine(promise: call.promise!), const SizedBox(height: Space.md)],
              HeroFieldsGrid(fields: call.heroFields, configured: call.heroesConfigured),
              const SizedBox(height: Space.md),
              ContactFieldList(fields: call.otherFields, alwaysFilter: call.otherFields.length > 8),
              const SizedBox(height: Space.md),
              FieldRow(label: StationCopy.callingFrom, value: formatPhone(call.callerId), mono: true),
              const SizedBox(height: Space.md),
              PriorAttemptsCard(attempts: call.priorAttempts),
            ],
          );
        },
      ),
    ),
  );
}

/// Mark DNC: the one mid-call action that does warrant a dialog. It is rare,
/// irreversible from the app and compliance-bearing, and the dialog states the
/// scope with the number in it before the agent commits.
///
/// The number in the dialog is the call it was opened on. The core marks the
/// live call, so the dialog closes when that call ends or another replaces it,
/// and a "yes" that lands after that marks nothing: the agent is told it was
/// not recorded, never left believing it was, and the next customer is never
/// marked for the last one's answer.
Future<void> markDnc(BuildContext context) async {
  final container = ProviderScope.containerOf(context, listen: false);
  final actions = container.read(stationActionsProvider);
  final messenger = ScaffoldMessenger.maybeOf(context);
  final view = container.read(stationViewProvider);
  final call = view?.call;
  if (view == null || call == null) return;
  final scope = sameCall(call.attemptId, {view.phase});
  final name = call.displayName?.trim();
  final phone = formatPhone(call.phoneE164);
  final ok = await confirmSheet(
    context,
    title: StationCopy.stopCallingTitle,
    detail: name == null || name.isEmpty ? phone : '$name · $phone',
    message: StationCopy.stopCallingBody,
    confirm: StationCopy.yesStopCalls,
    cancel: StationCopy.noGoBack,
    scope: scope,
  );
  if (scope(container.read(stationViewProvider))) {
    // The call the dialog named: the core refuses if another one is live by now.
    if (ok) await actions.markDnc(attemptId: call.attemptId);
    return;
  }
  // The call moved on while the dialog was open (it closed itself), or in the
  // instant the agent confirmed.
  messenger?.showSnackBar(const SnackBar(key: Key('dnc-not-marked'), content: Text(StationCopy.dncNotMarked)));
}

/// One tile per row on a narrow screen or at large text, else two across.
class _TileGrid extends StatelessWidget {
  const _TileGrid({required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, c) {
        final scale = MediaQuery.textScalerOf(context).scale(16) / 16;
        final columns = scale > 1.5 || c.maxWidth < 280 ? 1 : 2;
        final w = ((c.maxWidth - Space.sm * (columns - 1)) / columns).floorToDouble();
        return Wrap(
          spacing: Space.sm,
          runSpacing: Space.sm,
          children: [for (final child in children) SizedBox(width: w, child: child)],
        );
      },
    );
  }
}

/// A break reason as a picture tile (06): its icon (guessed from its code or words, a cup when
/// nothing fits, until reasons carry an icon of their own), its name, and its minutes when it has
/// a limit. One tap starts it.
class _BreakTile extends StatelessWidget {
  const _BreakTile({super.key, required this.option, required this.onTap});

  final BreakOption option;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final c = context.stateTokens.onBreak;
    final text = Theme.of(context).textTheme;
    final limit = option.limitMinutes;
    return Semantics(
      button: true,
      label: limit == null ? option.label : '${option.label}, ${StationCopy.minutes(limit)}',
      excludeSemantics: true,
      onTap: onTap,
      child: Material(
        color: t.bgSecondary,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(Radii.lg),
          side: BorderSide(color: t.borderStrong, width: 1.5),
        ),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 96),
            child: Padding(
              padding: const EdgeInsets.all(Space.md),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  DecoratedBox(
                    decoration: BoxDecoration(color: c.soft, shape: BoxShape.circle),
                    child: SizedBox.square(dimension: 44, child: Icon(breakIcon(option), color: c.deep)),
                  ),
                  const SizedBox(height: Space.xs),
                  Text(option.label, textAlign: TextAlign.center, style: text.titleMedium),
                  if (limit != null) Text(StationCopy.minutes(limit), style: text.bodySmall),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// A break reason's picture: the supervisor's (BE-13), else guessed from its code or name
/// (design-spec §5.5); a cup when nothing fits.
IconData breakIcon(BreakOption o) {
  final chosen = o.icon;
  if (chosen != null) return tilePictureIcon(chosen);
  final words = '${o.code} ${o.label}'.toLowerCase();
  if (words.contains('lunch') || words.contains('meal') || words.contains('dinner')) return Icons.restaurant_outlined;
  if (words.contains('wash') || words.contains('toilet') || words.contains('rest room') || words.contains('restroom')) return Icons.wc;
  if (words.contains('meet')) return Icons.groups_outlined;
  if (words.contains('train') || words.contains('coach')) return Icons.school_outlined;
  return Icons.free_breakfast_outlined;
}

/// Finish work for today? (11): a bottom sheet, the day's numbers, and the safe choice as the big
/// green button. True: finish.
Future<bool> showFinishWorkSheet(BuildContext context) async {
  final ok = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (context) => const CloseWhenCallArrives(child: _FinishWorkSheet()),
  );
  return ok ?? false;
}

class _FinishWorkSheet extends ConsumerWidget {
  const _FinishWorkSheet();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final text = Theme.of(context).textTheme;
    final s = context.stateTokens;
    final id = ref.watch(stationViewProvider.select((v) => v?.campaignId));
    final day = id == null ? null : ref.watch(stationMyDayProvider(id)).value;
    final offered = ref.watch(stationViewProvider.select((v) => v?.myContactsOffered ?? false));
    final later = id == null ? null : ref.watch(stationCallLaterProvider((campaignId: id, offered: offered))).value;
    return SingleChildScrollView(
      key: const Key('finish-sheet'),
      padding: const EdgeInsets.fromLTRB(Space.lg, 0, Space.lg, Space.lg),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              DecoratedBox(
                decoration: BoxDecoration(color: s.start.band, borderRadius: BorderRadius.circular(Radii.md)),
                child: SizedBox.square(dimension: 48, child: Icon(Icons.logout, color: s.start.ink)),
              ),
              const SizedBox(width: Space.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Semantics(header: true, child: Text(StationCopy.finishWorkTitle, style: text.headlineSmall)),
                    Text(StationCopy.finishWorkSubtitle, style: text.bodyMedium),
                  ],
                ),
              ),
            ],
          ),
          if (later != null && later.todayCount > 0 && later.items.isNotEmpty) ...[
            const SizedBox(height: Space.md),
            Text(
              StationCopy.leftForToday(later.todayCount, formatTime12(later.items.first.at), pool: later.leftGoesToPool),
              key: const Key('finish-left-today'),
              style: text.bodyLarge,
            ),
          ],
          if (day != null) ...[
            const SizedBox(height: Space.md),
            TileRow(
              children: [
                NumberTile(label: StationCopy.callsToday, value: '${day.callsToday}', suffix: day.target == null ? null : '/ ${day.target}'),
                NumberTile(label: StationCopy.talkTime, value: formatHoursMinutes(Duration(seconds: day.talkSeconds))),
                if (day.willPay != null)
                  NumberTile(label: StationCopy.willPay, value: '${day.willPay}')
                else
                  NumberTile(label: StationCopy.dialled, value: '${day.dialled}'),
              ],
            ),
          ],
          const SizedBox(height: Space.lg),
          MainActionButton(
            key: const Key('finish-no'),
            label: StationCopy.noKeepWorking,
            onPressed: () => Navigator.of(context).pop(false),
          ),
          const SizedBox(height: Space.sm),
          SecondaryActionButton(
            key: const Key('finish-yes'),
            label: StationCopy.yesFinishWork,
            icon: Icons.logout,
            danger: true,
            onPressed: () => Navigator.of(context).pop(true),
          ),
        ],
      ),
    );
  }
}

/// A question that cannot be undone, as a bottom sheet (05c): [title], [message], the safe choice
/// first and the red one under it. With a [scope] it closes itself, answered "no", once the scope
/// no longer holds.
Future<bool> confirmSheet(
  BuildContext context, {
  required String title,
  required String message,
  required String confirm,
  required String cancel,
  String? detail,
  StationModalScope? scope,
}) async {
  final ok = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (context) {
      final text = Theme.of(context).textTheme;
      final s = context.stateTokens;
      final sheet = SingleChildScrollView(
        key: const Key('confirm-sheet'),
        padding: const EdgeInsets.fromLTRB(Space.lg, 0, Space.lg, Space.lg),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              children: [
                DecoratedBox(
                  decoration: BoxDecoration(color: s.problem.soft, shape: BoxShape.circle),
                  child: SizedBox.square(dimension: 48, child: Icon(Icons.block, color: s.problem.deep)),
                ),
                const SizedBox(width: Space.md),
                Expanded(child: Semantics(header: true, child: Text(title, style: text.headlineSmall))),
              ],
            ),
            if (detail != null) ...[const SizedBox(height: Space.sm), Text(detail, style: text.titleMedium)],
            const SizedBox(height: Space.sm),
            Text(message, style: text.bodyLarge),
            const SizedBox(height: Space.lg),
            ButtonPair(
              first: SecondaryActionButton(key: const Key('confirm-no'), label: cancel, onPressed: () => Navigator.of(context).pop(false)),
              second: MainActionButton(
                key: const Key('confirm-yes'),
                label: confirm,
                kind: ActionKind.stop,
                onPressed: () => Navigator.of(context).pop(true),
              ),
            ),
          ],
        ),
      );
      return scope == null ? sheet : StationModalGuard(scope: scope, child: sheet);
    },
  );
  return ok ?? false;
}

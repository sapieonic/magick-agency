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
import 'contact_details.dart';

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
/// screen and the agent is still in one of [phases]. Another call, the end of
/// this one or leaving the station closes it.
StationModalScope sameCall(String? attemptId, Set<AgentPhase> phases) =>
    (v) => v != null && v.call?.attemptId == attemptId && phases.contains(v.phase);

/// [sameCall] for the call and phase on screen right now.
StationModalScope thisCallNow(StationView? view) => sameCall(view?.call?.attemptId, {if (view != null) view.phase});

/// "After this call": holds through the rest of this call (on call, wrap-up)
/// and the moments after it, and closes when another call reaches the agent or
/// the station closes.
StationModalScope untilNextCall(String? attemptId) =>
    (v) => v != null && (v.call == null || v.call!.attemptId == attemptId);

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

/// The screen-reader path of hold-to-hang-up. Closes with the call (or the
/// phase) it was asked about: the bar that asked is gone by then.
Future<bool> confirmHangUp(BuildContext context, {required bool ringing}) {
  final view = ProviderScope.containerOf(context, listen: false).read(stationViewProvider);
  return confirmDialog(
    context,
    title: StationCopy.hangUpConfirmTitle,
    message: ringing ? StationCopy.hangUpConfirmRinging : StationCopy.hangUpConfirmBody,
    confirm: StationCopy.hangUp,
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
  final view = container.read(stationViewProvider);
  final options = (view?.breakOptions ?? const <BreakOption>[])
      // The app's own pause and the soft phone are not breaks an agent picks
      // from the campaign's reasons.
      .where((o) => o.code != 'device_away' && o.code != switchToSoftphoneChoice)
      .toList(growable: false);
  final softphone = container.read(softphoneAvailabilityProvider).startAllowed;
  final host = softphone ? container.read(softphoneHostActionsProvider) : null;
  final messenger = ScaffoldMessenger.maybeOf(context);
  final scope = queued ? untilNextCall(view?.call?.attemptId) : noCallOnScreen;
  final code = await showModalBottomSheet<String>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (context) {
      final text = Theme.of(context).textTheme;
      return StationModalGuard(
        scope: scope,
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(Space.lg, 0, Space.lg, Space.lg),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Semantics(header: true, child: Text(StationCopy.breakSheetTitle, style: text.titleLarge)),
                  ),
                  TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text(StationCopy.cancel)),
                ],
              ),
              Text(queued ? StationCopy.breakSheetQueued : StationCopy.breakSheetNow, style: text.bodySmall),
              const SizedBox(height: Space.md),
              if (options.isEmpty)
                Text(StationCopy.breakUnconfigured, style: text.bodyMedium)
              else
                for (final o in options)
                  ListTile(
                    key: Key('break-${o.code}'),
                    minTileHeight: Space.touch + 8,
                    contentPadding: const EdgeInsets.symmetric(horizontal: Space.sm),
                    title: Text(o.label),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: () => Navigator.of(context).pop(o.code),
                  ),
              if (softphone) ...[
                const Divider(height: Space.lg),
                ListTile(
                  key: const Key('break-switch-softphone'),
                  minTileHeight: Space.touch + 8,
                  contentPadding: const EdgeInsets.symmetric(horizontal: Space.sm),
                  leading: const Icon(Icons.dialpad),
                  title: const Text(StationCopy.switchToSoftphone),
                  subtitle: Text(queued ? StationCopy.switchAfterCallHint : StationCopy.switchHint),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => Navigator.of(context).pop(switchToSoftphoneChoice),
                ),
              ],
              if (!queued) ...[
                const SizedBox(height: Space.sm),
                Text(StationCopy.breakSheetOnCallNote, style: text.labelSmall, textAlign: TextAlign.center),
              ],
            ],
          ),
        ),
      );
    },
  );
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

/// Leave: refused while a call is on screen; otherwise confirmed, and then
/// back to the campaign list once the server agreed.
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
    messenger.showSnackBar(const SnackBar(content: Text(StationCopy.leaveBlocked)));
    return;
  }
  final ok = await confirmDialog(
    context,
    title: StationCopy.leaveTitle,
    message: StationCopy.leaveMessage,
    confirm: StationCopy.leaveAction,
    scope: noCallOnScreen,
  );
  if (!ok) return;
  // Confirmed in the same instant a call arrived: the call comes first.
  if (container.read(stationViewProvider)?.callActive ?? false) {
    messenger.showSnackBar(const SnackBar(content: Text(StationCopy.leaveBlocked)));
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
  final ok = await confirmDialog(
    context,
    title: StationCopy.dncTitle,
    message: StationCopy.dncMessage(formatPhone(call.phoneE164), call.campaignName),
    confirm: StationCopy.dncAction,
    danger: true,
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

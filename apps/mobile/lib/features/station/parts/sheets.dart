import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/routes.dart';
import '../../../app/theme/tokens.dart';
import '../../../core/station/station_view.dart';
import '../logic/format.dart';
import '../station_copy.dart';
import 'contact_details.dart';

/// The station's dialogs and bottom sheets. Free functions over a [WidgetRef]
/// so the phase views stay small and every flow is one call.

/// A yes/no dialog. [danger] paints the confirm action as destructive. With
/// [closeWhenCallArrives] (a question asked while waiting) a call reaching the
/// agent closes it, answered "no" (see [CloseWhenCallArrives]).
Future<bool> confirmDialog(
  BuildContext context, {
  required String title,
  required String message,
  required String confirm,
  String cancel = StationCopy.cancel,
  bool danger = false,
  bool closeWhenCallArrives = false,
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
            style: danger ? FilledButton.styleFrom(backgroundColor: t.danger, foregroundColor: t.onAccent) : null,
            child: Text(confirm),
          ),
        ],
      );
      return closeWhenCallArrives ? CloseWhenCallArrives(child: dialog) : dialog;
    },
  );
  return ok ?? false;
}

/// Closes the dialog or sheet it sits in once a call is on screen (ringing,
/// on a call, wrap-up). Those routes sit on the root navigator, above the
/// station, so without this "Leave this station?" or the break reasons would
/// cover the ringing call. Closing answers nothing: the caller gets null.
class CloseWhenCallArrives extends ConsumerStatefulWidget {
  const CloseWhenCallArrives({super.key, required this.child});

  final Widget child;

  @override
  ConsumerState<CloseWhenCallArrives> createState() => _CloseWhenCallArrivesState();
}

class _CloseWhenCallArrivesState extends ConsumerState<CloseWhenCallArrives> {
  bool _closing = false;

  @override
  void initState() {
    super.initState();
    // Immediately too: the call may have arrived while the route was opening.
    ref.listenManual<bool>(stationViewProvider.select((v) => v?.callActive ?? false), (_, active) {
      if (active) _close();
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

/// The screen-reader path of hold-to-hang-up.
Future<bool> confirmHangUp(BuildContext context, {required bool ringing}) => confirmDialog(
  context,
  title: StationCopy.hangUpConfirmTitle,
  message: ringing ? StationCopy.hangUpConfirmRinging : StationCopy.hangUpConfirmBody,
  confirm: StationCopy.hangUp,
  cancel: StationCopy.keepCall,
  danger: true,
);

/// Break reasons. While a call is on screen the break is queued ("Break after
/// this call"); otherwise it starts now.
Future<void> showBreakSheet(BuildContext context, WidgetRef ref, {required bool queued}) async {
  final options = (ref.read(stationViewProvider)?.breakOptions ?? const <BreakOption>[])
      // The app's own pause is not a break an agent picks.
      .where((o) => o.code != 'device_away')
      .toList(growable: false);
  final code = await showModalBottomSheet<String>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (context) {
      final text = Theme.of(context).textTheme;
      final sheet = SingleChildScrollView(
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
            if (!queued) ...[
              const SizedBox(height: Space.sm),
              Text(StationCopy.breakSheetOnCallNote, style: text.labelSmall, textAlign: TextAlign.center),
            ],
          ],
        ),
      );
      // A break that "starts now" is a question for a waiting agent; a call
      // reaching them closes it. ("After this call" is asked during the call.)
      return queued ? sheet : CloseWhenCallArrives(child: sheet);
    },
  );
  if (code == null) return;
  // Picked in the same instant a call arrived: a break "now" is no longer what
  // the sheet offered. The call screen offers one after the call instead.
  if (!queued && (ref.read(stationViewProvider)?.callActive ?? false)) return;
  await ref.read(stationActionsProvider).takeBreak(code);
}

/// Leave: refused while a call is on screen; otherwise confirmed, and then
/// back to the campaign list once the server agreed.
Future<void> leaveStation(BuildContext context, WidgetRef ref) async {
  final view = ref.read(stationViewProvider);
  if (view != null && view.callActive) {
    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text(StationCopy.leaveBlocked)));
    return;
  }
  final ok = await confirmDialog(
    context,
    title: StationCopy.leaveTitle,
    message: StationCopy.leaveMessage,
    confirm: StationCopy.leaveAction,
    closeWhenCallArrives: true,
  );
  if (!ok || !context.mounted) return;
  // Confirmed in the same instant a call arrived: the call comes first.
  if (ref.read(stationViewProvider)?.callActive ?? false) {
    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text(StationCopy.leaveBlocked)));
    return;
  }
  // Captured now: once the session closes, this view may already have been
  // replaced by the time the server answers.
  final router = GoRouter.of(context);
  final actions = ref.read(stationActionsProvider)..dismissActionError();
  await actions.leave();
  // A refusal lands in actionError and keeps the agent here, where it shows.
  if (ref.read(stationViewProvider)?.actionError == null) router.go(Routes.home);
}

/// Where the call is heard: phone, speaker, a headset.
Future<void> showAudioRouteSheet(BuildContext context, WidgetRef ref) async {
  final audio = ref.read(stationViewProvider)?.audio ?? const AudioView();
  final picked = await showModalBottomSheet<AudioRouteOption>(
    context: context,
    useSafeArea: true,
    isScrollControlled: true,
    builder: (context) {
      final text = Theme.of(context).textTheme;
      final t = context.tokens;
      return SingleChildScrollView(
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
      );
    },
  );
  if (picked != null && picked != audio.route) await ref.read(stationActionsProvider).setRoute(picked);
}

IconData routeIcon(AudioRouteKind? kind) => switch (kind) {
  AudioRouteKind.earpiece => Icons.phone_in_talk,
  AudioRouteKind.speaker => Icons.volume_up,
  AudioRouteKind.wired => Icons.headset,
  AudioRouteKind.bluetooth => Icons.bluetooth_audio,
  null => Icons.hearing,
};

/// Every contact field, the caller ID and the history: the on-call "Details".
Future<void> showDetailsSheet(BuildContext context, CallView call) => showModalBottomSheet<void>(
  context: context,
  useSafeArea: true,
  isScrollControlled: true,
  builder: (context) => DraggableScrollableSheet(
    expand: false,
    initialChildSize: 0.75,
    minChildSize: 0.4,
    maxChildSize: 0.95,
    builder: (context, controller) {
      final text = Theme.of(context).textTheme;
      return ListView(
        controller: controller,
        padding: const EdgeInsets.fromLTRB(Space.lg, 0, Space.lg, Space.xl),
        children: [
          Semantics(header: true, child: Text(StationCopy.detailsTitle, style: text.titleLarge)),
          const SizedBox(height: Space.xs),
          Text('${call.displayName ?? formatPhone(call.phoneE164)} · ${StationCopy.attempt(call.attemptNumber)}', style: text.bodySmall),
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
);

/// Mark DNC: the one mid-call action that does warrant a dialog. It is rare,
/// irreversible from the app and compliance-bearing, and the dialog states the
/// scope with the number in it before the agent commits.
Future<void> markDnc(BuildContext context, WidgetRef ref) async {
  final view = ref.read(stationViewProvider);
  final call = view?.call;
  if (call == null) return;
  final ok = await confirmDialog(
    context,
    title: StationCopy.dncTitle,
    message: StationCopy.dncMessage(formatPhone(call.phoneE164), call.campaignName),
    confirm: StationCopy.dncAction,
    danger: true,
  );
  if (ok) await ref.read(stationActionsProvider).markDnc();
}

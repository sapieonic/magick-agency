import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/routes.dart';
import '../../app/theme/tokens.dart';
import '../../core/station/station_view.dart';
import '../../ui/primitives.dart';
import 'preflight_checks.dart';
import 'preflight_copy.dart';

/// The pre-flight route with the campaign's name carried along.
///
/// The name rides as a `campaignName` query parameter rather than a route
/// `extra`: a query survives a cold start from a notification, state
/// restoration and a deep link, where an `extra` object is gone. The screen
/// also accepts a `String` extra, for callers that already pass one.
String preflightLocation(String campaignId, String campaignName) =>
    Uri(path: Routes.preflight(campaignId), queryParameters: {'campaignName': campaignName}).toString();

/// "Ready to take calls?": the phone checks itself before every shift, then
/// "Go on duty" joins the campaign.
///
/// Checks run in parallel and each row settles on its own. Only a missing
/// microphone or an unusable network blocks; everything else is advice.
class PreflightScreen extends ConsumerStatefulWidget {
  const PreflightScreen({super.key, required this.campaignId, this.campaignName});

  final String campaignId;

  /// Overrides the route's `campaignName` (tests, or a caller with the name in hand).
  final String? campaignName;

  /// How long one check may take before it counts as "couldn't check".
  static const checkTimeout = Duration(seconds: 12);

  @override
  ConsumerState<PreflightScreen> createState() => _PreflightScreenState();
}

class _PreflightScreenState extends ConsumerState<PreflightScreen> with WidgetsBindingObserver {
  final Map<PreflightCheck, CheckResult> _results = {};
  int _generation = 0;
  bool _starting = false;

  /// "Go on duty" was tapped while the sound check was still listening.
  bool _finishingSoundCheck = false;

  /// The current run's sound check, settled (graded or timed out).
  Future<void>? _soundCheck;
  StationStart? _outcome;
  bool _awaitingSettings = false;
  final Set<Timer> _deadlines = {};

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _runAll(initial: true);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    for (final t in _deadlines) {
      t.cancel();
    }
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Back from Settings: what the agent changed there is only visible to a
    // fresh check.
    if (state == AppLifecycleState.resumed && _awaitingSettings) {
      _awaitingSettings = false;
      _runAll();
    }
  }

  String get _campaignName {
    final given = widget.campaignName;
    if (given != null) return given;
    final state = GoRouter.maybeOf(context)?.state;
    final extra = state?.extra;
    if (extra is String) return extra;
    return state?.uri.queryParameters['campaignName'] ?? '';
  }

  PreflightChecks get _checks => ref.read(preflightChecksProvider);

  void _runAll({bool initial = false}) {
    // Not under a join: the station is taking the voice engine.
    if (_starting) return;
    final gen = ++_generation;
    void reset() => _results
      ..clear()
      ..addAll({
        PreflightCheck.microphone: const CheckResult.pending(PreflightCopy.mic),
        PreflightCheck.soundCheck: const CheckResult(
          status: CheckStatus.pending,
          title: PreflightCopy.sound,
          detail: PreflightCopy.soundListening,
        ),
        PreflightCheck.headset: const CheckResult.pending(PreflightCopy.headset),
        PreflightCheck.network: const CheckResult.pending(PreflightCopy.network),
        PreflightCheck.battery: const CheckResult.pending(PreflightCopy.battery),
        PreflightCheck.batterySaver: const CheckResult.pending(PreflightCopy.batterySaver),
      });
    // initState may not call setState; the first build reads the reset map.
    initial ? reset() : setState(reset);
    final checks = _checks;
    final mic = _measure(checks.microphone);
    _settle(gen, PreflightCheck.microphone, () async => gradeMicrophone(await mic));
    _soundCheck = _settle(gen, PreflightCheck.soundCheck, () async {
      final sample = await _measure(checks.soundCheck);
      final allowed = await mic.then((m) => m == MicPermission.granted, onError: (Object _) => false);
      return gradeSoundCheck(sample, micAllowed: allowed);
    });
    _settle(gen, PreflightCheck.headset, () async => gradeRoute(await _measure(checks.audioRoute)));
    _settle(gen, PreflightCheck.network, () async => gradeNetwork(await _measure(checks.network)));
    _settle(gen, PreflightCheck.battery, () async => gradeBattery(await _measure(checks.battery)));
    _settle(gen, PreflightCheck.batterySaver, () async => gradeBatteryOptimisation(await _measure(checks.batteryOptimisation)));
  }

  /// Runs one measurement with a deadline. Its own timer rather than
  /// `Future.timeout`, so leaving the screen cancels the deadlines too.
  Future<T> _measure<T>(Future<T> Function() f) {
    final done = Completer<T>();
    late final Timer deadline;
    deadline = Timer(PreflightScreen.checkTimeout, () {
      _deadlines.remove(deadline);
      if (!done.isCompleted) done.completeError(TimeoutException('preflight check', PreflightScreen.checkTimeout));
    });
    _deadlines.add(deadline);
    Future.sync(f)
        .then(
          (v) {
            if (!done.isCompleted) done.complete(v);
          },
          onError: (Object e, StackTrace st) {
            if (!done.isCompleted) done.completeError(e, st);
          },
        )
        .whenComplete(() {
          deadline.cancel();
          _deadlines.remove(deadline);
        });
    return done.future;
  }

  Future<void> _settle(int gen, PreflightCheck check, Future<CheckResult?> Function() grade) {
    final done = () async {
      CheckResult? result;
      try {
        result = await grade();
      } catch (_) {
        result = gradeUnavailable(check);
      }
      if (!mounted || gen != _generation) return;
      setState(() {
        if (result == null) {
          _results.remove(check);
        } else {
          _results[check] = result;
        }
      });
    }();
    unawaited(done);
    return done;
  }

  Future<void> _fix(PreflightCheck check, CheckFix fix) async {
    final checks = _checks;
    switch (fix) {
      case CheckFix.allowMicrophone:
        final p = await checks.requestMicrophone();
        if (!mounted) return;
        // A permanently denied mic cannot be asked for again; send them to Settings next.
        if (p == MicPermission.granted) {
          _runAll();
        } else {
          setState(() => _results[PreflightCheck.microphone] = gradeMicrophone(p));
        }
      case CheckFix.openSettings:
        _awaitingSettings = true;
        await checks.openAppSettings();
      case CheckFix.allowBackground:
        _awaitingSettings = true;
        await checks.requestBatteryExemption();
      case CheckFix.none:
        break;
    }
  }

  Future<void> _start(Future<StationStart> Function(StationLauncher l, String name) how) async {
    if (_starting) return;
    final sound = _soundCheck;
    final listening = _results[PreflightCheck.soundCheck]?.status == CheckStatus.pending;
    setState(() {
      _starting = true;
      _finishingSoundCheck = sound != null && listening;
      _outcome = null;
    });
    // The sound check borrows the voice engine and puts it back when it ends; the
    // station must not prepare it until then (about a second and a half), or the
    // put-back would undo the station's and its first call would be silent.
    if (sound != null && listening) {
      await sound;
      if (!mounted) return;
      setState(() => _finishingSoundCheck = false);
    }
    _checks.handOverAudio();
    StationStart result;
    try {
      result = await how(ref.read(stationLauncherProvider), _campaignName);
    } catch (_) {
      result = const StationRefused(PreflightCopy.startFailed);
    }
    if (!mounted) return;
    if (result is StationStarted) {
      setState(() => _starting = false);
      context.go(Routes.station(widget.campaignId));
      return;
    }
    setState(() {
      _starting = false;
      _outcome = result;
    });
  }

  void _goOnDuty() => _start((l, name) => l.start(widget.campaignId, campaignName: name));

  Future<void> _switchFrom(StationElsewhere other) async {
    final t = context.tokens;
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text(PreflightCopy.switchConfirmTitle),
        content: Text(PreflightCopy.switchConfirmMessage(other.campaignName)),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text(PreflightCopy.cancel)),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            style: FilledButton.styleFrom(backgroundColor: t.accent),
            child: const Text(PreflightCopy.switchConfirmAction),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    await _start((l, name) => l.leaveOtherAndStart(other, widget.campaignId, campaignName: name));
  }

  void _closeSoftphone(StationOnSoftphone s) =>
      _start((l, name) => l.closeSoftphoneAndStart(s, widget.campaignId, campaignName: name));

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final t = context.tokens;
    final name = _campaignName;
    final block = dutyBlock(_results);
    final outcome = _outcome;

    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(PreflightCopy.title),
            if (name.isNotEmpty) Text(name, style: text.bodySmall, maxLines: 1, overflow: TextOverflow.ellipsis),
          ],
        ),
      ),
      body: SafeArea(
        top: false,
        child: Align(
          alignment: Alignment.topCenter,
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 560),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Expanded(
                  child: ListView(
                    padding: const EdgeInsets.fromLTRB(Space.lg, Space.sm, Space.lg, Space.lg),
                    children: [
                      if (outcome != null) ...[
                        _OutcomePanel(
                          key: const Key('start-outcome'),
                          outcome: outcome,
                          busy: _starting,
                          onSwitch: _switchFrom,
                          onCloseSoftphone: _closeSoftphone,
                          onRetry: _goOnDuty,
                          onBack: () => context.go(Routes.home),
                        ),
                        const SizedBox(height: Space.lg),
                      ],
                      AppCard(
                        padding: const EdgeInsets.symmetric(horizontal: Space.md, vertical: Space.xs),
                        child: Column(
                          children: [
                            for (final c in PreflightCheck.values)
                              if (_results[c] != null)
                                _CheckRow(
                                  key: Key('check-${c.name}'),
                                  result: _results[c]!,
                                  last: c == _lastShown,
                                  onFix: (fix) => _fix(c, fix),
                                ),
                          ],
                        ),
                      ),
                      const SizedBox(height: Space.md),
                      Text(PreflightCopy.keepOpen, style: text.bodySmall, textAlign: TextAlign.center),
                      if (_results.values.any((r) => r.status == CheckStatus.warn || r.status == CheckStatus.fail))
                        Align(
                          child: TextButton.icon(
                            key: const Key('check-again'),
                            onPressed: _starting ? null : _runAll,
                            icon: const Icon(Icons.refresh),
                            label: const Text(PreflightCopy.checkAgain),
                          ),
                        ),
                    ],
                  ),
                ),
                if (outcome == null)
                  DecoratedBox(
                    decoration: BoxDecoration(
                      border: Border(top: BorderSide(color: t.border)),
                    ),
                    child: Padding(
                      padding: const EdgeInsets.fromLTRB(Space.lg, Space.md, Space.lg, Space.md),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          if (block != null) ...[
                            Text(
                              switch (block) {
                                DutyBlock.checking => PreflightCopy.blockedChecking,
                                DutyBlock.microphone => PreflightCopy.blockedMic,
                                DutyBlock.network => PreflightCopy.blockedNetwork,
                              },
                              key: const Key('duty-blocked'),
                              textAlign: TextAlign.center,
                              style: text.bodySmall!.copyWith(color: block == DutyBlock.checking ? t.textSecondary : t.danger),
                            ),
                            const SizedBox(height: Space.sm),
                          ],
                          EmberButton(
                            key: const Key('go-on-duty'),
                            label: _finishingSoundCheck
                                ? PreflightCopy.finishingSoundCheck
                                : _starting
                                    ? PreflightCopy.joining
                                    : PreflightCopy.goOnDuty,
                            icon: Icons.headset_mic,
                            onPressed: block == null && !_starting ? _goOnDuty : null,
                          ),
                        ],
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  PreflightCheck? get _lastShown {
    PreflightCheck? last;
    for (final c in PreflightCheck.values) {
      if (_results.containsKey(c)) last = c;
    }
    return last;
  }
}

class _CheckRow extends StatelessWidget {
  const _CheckRow({super.key, required this.result, required this.last, required this.onFix});

  final CheckResult result;
  final bool last;
  final ValueChanged<CheckFix> onFix;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final still = MediaQuery.disableAnimationsOf(context);
    final duration = still ? Duration.zero : const Duration(milliseconds: 240);
    final (Tone tone, String? pill, Widget icon) = switch (result.status) {
      CheckStatus.pending => (
        Tone.neutral,
        null,
        SizedBox.square(
          key: const ValueKey('pending'),
          dimension: 20,
          child: CircularProgressIndicator(strokeWidth: 2, color: t.textMuted),
        ),
      ),
      CheckStatus.ok => (
        Tone.ok,
        result.pill ?? PreflightCopy.pillOk,
        Icon(Icons.check_circle, key: const ValueKey('ok'), color: t.success),
      ),
      CheckStatus.warn => (
        Tone.warn,
        result.pill ?? PreflightCopy.pillCheck,
        Icon(Icons.error_outline, key: const ValueKey('warn'), color: t.warning),
      ),
      CheckStatus.fail => (
        Tone.danger,
        result.pill ?? PreflightCopy.pillFail,
        Icon(Icons.cancel, key: const ValueKey('fail'), color: t.danger),
      ),
    };
    final fixLabel = switch (result.fix) {
      CheckFix.allowMicrophone => PreflightCopy.allow,
      CheckFix.openSettings => PreflightCopy.openSettings,
      CheckFix.allowBackground => PreflightCopy.allowBackground,
      CheckFix.none => null,
    };

    return DecoratedBox(
      decoration: BoxDecoration(
        border: last ? null : Border(bottom: BorderSide(color: t.border)),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: Space.md),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            AnimatedSwitcher(
              duration: duration,
              transitionBuilder: (child, a) => ScaleTransition(
                scale: a,
                child: FadeTransition(opacity: a, child: child),
              ),
              child: icon,
            ),
            const SizedBox(width: Space.md),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  MergeSemantics(
                    child: Semantics(
                      liveRegion: result.status != CheckStatus.pending,
                      child: AnimatedSize(
                        duration: duration,
                        alignment: Alignment.topLeft,
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Wrap(
                              spacing: Space.sm,
                              runSpacing: Space.xs,
                              crossAxisAlignment: WrapCrossAlignment.center,
                              children: [
                                Text(result.title, style: text.titleSmall),
                                if (pill != null) StatusPill(pill, tone: tone),
                              ],
                            ),
                            const SizedBox(height: 2),
                            Text(result.detail, style: text.bodySmall),
                          ],
                        ),
                      ),
                    ),
                  ),
                  if (fixLabel != null)
                    Padding(
                      padding: const EdgeInsets.only(top: Space.xs),
                      child: OutlinedButton(onPressed: () => onFix(result.fix), child: Text(fixLabel)),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// What "Go on duty" ran into, with the way through it.
class _OutcomePanel extends StatelessWidget {
  const _OutcomePanel({
    super.key,
    required this.outcome,
    required this.busy,
    required this.onSwitch,
    required this.onCloseSoftphone,
    required this.onRetry,
    required this.onBack,
  });

  final StationStart outcome;
  final bool busy;
  final ValueChanged<StationElsewhere> onSwitch;
  final ValueChanged<StationOnSoftphone> onCloseSoftphone;
  final VoidCallback onRetry;
  final VoidCallback onBack;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final (String title, List<String> lines, List<Widget> actions) = switch (outcome) {
      StationElsewhere(:final campaignName, :final stateLabel, :final canLeave, :final accountName) => (
        PreflightCopy.elsewhereTitle,
        [
          PreflightCopy.elsewhereDetail(campaignName, stateLabel, accountName),
          canLeave ? PreflightCopy.elsewhereRemedy(campaignName) : PreflightCopy.elsewhereRemedyMidCall(campaignName),
        ],
        [
          // Only when it is safe: a live call there may only be ended there.
          if (canLeave)
            FilledButton(
              key: const Key('switch-station'),
              onPressed: busy ? null : () => onSwitch(outcome as StationElsewhere),
              child: Text(PreflightCopy.switchAction(campaignName), textAlign: TextAlign.center),
            ),
          OutlinedButton(onPressed: busy ? null : onRetry, child: const Text(PreflightCopy.tryAgain)),
        ],
      ),
      StationOnSoftphone() => (
        PreflightCopy.softphoneTitle,
        [PreflightCopy.softphoneDetail, PreflightCopy.softphoneRemedy],
        [
          FilledButton(
            key: const Key('close-softphone'),
            onPressed: busy ? null : () => onCloseSoftphone(outcome as StationOnSoftphone),
            child: const Text(PreflightCopy.softphoneCloseAndJoin),
          ),
          OutlinedButton(key: const Key('retry'), onPressed: busy ? null : onRetry, child: const Text(PreflightCopy.tryAgain)),
        ],
      ),
      StationRefused(:final message) => (
        PreflightCopy.refusedTitle,
        [message],
        [
          FilledButton(key: const Key('back-to-campaigns'), onPressed: onBack, child: const Text(PreflightCopy.backToCampaigns)),
          OutlinedButton(key: const Key('retry'), onPressed: busy ? null : onRetry, child: const Text(PreflightCopy.tryAgain)),
        ],
      ),
      StationStarted() => ('', const <String>[], const <Widget>[]),
    };

    return Semantics(
      liveRegion: true,
      container: true,
      child: AppCard(
        borderColor: t.warning.withValues(alpha: 0.4),
        padding: const EdgeInsets.all(Space.lg),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Semantics(header: true, child: Text(title, style: text.titleLarge)),
            for (final l in lines) ...[const SizedBox(height: Space.sm), Text(l, style: text.bodyMedium)],
            const SizedBox(height: Space.md),
            for (final a in actions) ...[a, const SizedBox(height: Space.sm)],
          ],
        ),
      ),
    );
  }
}

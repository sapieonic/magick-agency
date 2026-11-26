import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/routes.dart';
import '../../app/theme/tokens.dart';
import '../../core/softphone/softphone_view.dart' show softphoneAvailabilityProvider;
import '../../core/station/station_view.dart';
import '../../ui/primitives.dart';
import '../station/parts/idle_views.dart' show WorkCard;
import '../station/parts/layouts.dart';
import '../station/station_copy.dart';
import '../station/station_providers.dart';
import '../station/widgets/action_buttons.dart';
import '../station/widgets/state_band.dart';
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

/// Start of day (01, 01b): the phone checks itself before every shift, the agent sees today's
/// work and chooses how to work, then "Start work" joins and, once the station is open, starts.
/// A blocking check that fails turns the band red, says what to do, and puts its fix where Start
/// work was (hidden, not greyed: AS1).
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

  /// How will you work? (the choice on screen) and how the last Start work asked to.
  WorkMode _mode = WorkMode.callsComeToMe;
  WorkMode _intent = WorkMode.callsComeToMe;
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
      ref.read(startWorkIntentProvider.notifier).set(widget.campaignId, _intent);
      context.go(Routes.station(widget.campaignId));
      return;
    }
    setState(() {
      _starting = false;
      _outcome = result;
    });
  }

  /// Start work: join, and once the station is open go on in [mode] by itself
  /// ([startWorkIntentProvider]), so the agent presses once.
  void _goOnDuty([WorkMode mode = WorkMode.callsComeToMe]) {
    _intent = mode;
    _start((l, name) => l.start(widget.campaignId, campaignName: name));
  }

  Future<void> _switchFrom(StationElsewhere other) async {
    final t = context.tokens;
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(PreflightCopy.switchConfirmTitle(other.campaignName)),
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
    final agent = ref.watch(stationAgentNameProvider);
    final softphone = ref.watch(softphoneAvailabilityProvider.select((a) => a.startAllowed));
    final mode = softphone ? _mode : WorkMode.callsComeToMe;
    final failed = block == DutyBlock.microphone || block == DutyBlock.network;
    final mic = _results[PreflightCheck.microphone];
    // Large text on a small phone: the band scrolls with the checks, so they and Start work fit.
    final tight = MediaQuery.textScalerOf(context).scale(16) / 16 > 1.3;

    // 01b: a blocking check failed. The band turns red and says what; the main action is the fix.
    final StateBand band;
    if (block == DutyBlock.microphone) {
      band = const StateBand(
        key: Key('band-check-failed'),
        tone: StationTone.problem,
        icon: Icons.mic_off,
        title: PreflightCopy.micBlockedTitle,
        subtitle: PreflightCopy.micBlockedSubtitle,
      );
    } else if (block == DutyBlock.network) {
      band = const StateBand(
        key: Key('band-check-failed'),
        tone: StationTone.problem,
        icon: Icons.wifi_off,
        title: PreflightCopy.noInternetTitle,
        subtitle: PreflightCopy.noInternetSubtitle,
      );
    } else {
      band = StateBand(
        key: const Key('band-start-of-day'),
        tone: StationTone.start,
        icon: Icons.headphones,
        title: StationCopy.namaste(agent),
        subtitle: PreflightCopy.checkThese,
      );
    }

    final Widget action;
    if (block == DutyBlock.microphone) {
      final settings = mic?.fix == CheckFix.openSettings;
      action = MainActionButton(
        key: const Key('fix-check'),
        label: settings ? PreflightCopy.openSettings : PreflightCopy.allowMicrophone,
        icon: settings ? Icons.settings_outlined : Icons.mic,
        kind: ActionKind.stop,
        onPressed: _starting ? null : () => _fix(PreflightCheck.microphone, mic?.fix ?? CheckFix.allowMicrophone),
      );
    } else if (block == DutyBlock.network) {
      action = MainActionButton(
        key: const Key('check-again'),
        label: PreflightCopy.checkAgain,
        icon: Icons.refresh,
        kind: ActionKind.stop,
        onPressed: _starting ? null : _runAll,
      );
    } else {
      action = MainActionButton(
        key: const Key('go-on-duty'),
        label: _finishingSoundCheck
            ? PreflightCopy.finishingSoundCheck
            : _starting
            ? PreflightCopy.joining
            : block == DutyBlock.checking
            ? PreflightCopy.blockedChecking
            : PreflightCopy.goOnDuty,
        icon: Icons.play_arrow_rounded,
        busy: _starting,
        onPressed: block == null && !_starting ? () => _goOnDuty(mode) : null,
      );
    }

    // Not while joining: the join would finish unseen (on duty with nobody
    // looking at the station), or a conflict would have nowhere to show.
    return PopScope(
      canPop: !_starting,
      child: Scaffold(
        backgroundColor: t.bgPrimary,
        body: SafeArea(
          child: Align(
            alignment: Alignment.topCenter,
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 560),
              child: LayoutBuilder(
                builder: (context, page) => Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    ColoredBox(
                      color: t.bgSecondary,
                      child: Padding(
                        padding: const EdgeInsets.fromLTRB(Space.xs, Space.xs, Space.lg, Space.xs),
                        child: Row(
                          children: [
                            if (!_starting && (GoRouter.maybeOf(context)?.canPop() ?? false))
                              const BackButton()
                            else
                              const SizedBox(width: Space.md),
                            Expanded(
                              child: Semantics(
                                header: true,
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    if (agent != null) Text(agent, style: text.titleSmall, maxLines: 1, overflow: TextOverflow.ellipsis),
                                    if (name.isNotEmpty)
                                      Text(name, style: text.bodySmall, maxLines: 1, overflow: TextOverflow.ellipsis),
                                  ],
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                    if (!tight) band,
                    Expanded(
                      child: ListView(
                        padding: EdgeInsets.zero,
                        children: [
                          if (tight) band,
                          Padding(
                            padding: const EdgeInsets.fromLTRB(Space.lg, Space.md, Space.lg, Space.lg),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.stretch,
                              children: [
                          if (outcome != null) ...[
                            _OutcomePanel(
                              key: const Key('start-outcome'),
                              outcome: outcome,
                              busy: _starting,
                              onSwitch: _switchFrom,
                              onCloseSoftphone: _closeSoftphone,
                              onRetry: () => _goOnDuty(mode),
                              onBack: () => context.go(Routes.home),
                            ),
                            const SizedBox(height: Space.lg),
                          ],
                          _CheckGrid(results: _results, onFix: _fix),
                          if (failed) ...[
                            const SizedBox(height: Space.md),
                            StepsCard(
                              key: const Key('fix-steps'),
                              title: StationCopy.whatToDo,
                              tone: StationTone.problem,
                              steps: block == DutyBlock.microphone
                                  ? (mic?.fix == CheckFix.openSettings
                                        ? const [PreflightCopy.stepOpenSettings, PreflightCopy.stepTurnOnMic, PreflightCopy.stepComeBack]
                                        : const [PreflightCopy.stepPressAllow, PreflightCopy.stepAllowMic])
                                  : const [StationCopy.stepCheckInternet, PreflightCopy.stepCheckAgain],
                            ),
                          ] else ...[
                            const SizedBox(height: Space.md),
                            WorkCard(
                              campaignName: name,
                              softphone: softphone,
                              mode: mode,
                              onMode: (m) => setState(() => _mode = m),
                            ),
                          ],
                          if (_results.values.any((r) => r.status == CheckStatus.warn || r.status == CheckStatus.fail) && !failed)
                            Align(
                              child: TextButton.icon(
                                key: const Key('check-again'),
                                onPressed: _starting ? null : _runAll,
                                icon: const Icon(Icons.refresh),
                                label: const Text(PreflightCopy.checkAgain),
                              ),
                            ),
                          const SizedBox(height: Space.sm),
                          Text(PreflightCopy.keepOpen, style: text.bodySmall, textAlign: TextAlign.center),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                    if (outcome == null) StationActionArea(pageHeight: page.maxHeight, child: action),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// The checks as tiles, two across (design-spec §4, phone): Microphone, Headset, Internet and
/// Battery always; the sound check while it listens (the agent has to say hello) or when it found
/// a problem, and the battery saver only when it is in the way. Each says OK, Checking… or what is
/// wrong in a word, with a tick or a cross, never colour alone, and the fix when there is one.
class _CheckGrid extends StatelessWidget {
  const _CheckGrid({required this.results, required this.onFix});

  final Map<PreflightCheck, CheckResult> results;
  final void Function(PreflightCheck check, CheckFix fix) onFix;

  @override
  Widget build(BuildContext context) {
    final shown = [
      for (final c in PreflightCheck.values)
        if (results[c] case final r?)
          if (switch (c) {
            PreflightCheck.soundCheck => r.status != CheckStatus.ok,
            PreflightCheck.batterySaver => r.status == CheckStatus.warn || r.status == CheckStatus.fail,
            _ => true,
          })
            (c, r),
    ];
    return StationCard(
      child: LayoutBuilder(
        builder: (context, box) {
          final scale = MediaQuery.textScalerOf(context).scale(16) / 16;
          final columns = scale > 1.4 || box.maxWidth < 300 ? 1 : 2;
          final w = ((box.maxWidth - Space.sm * (columns - 1)) / columns).floorToDouble();
          return Wrap(
            spacing: Space.sm,
            runSpacing: Space.sm,
            children: [
              for (final (c, r) in shown)
                SizedBox(width: w, child: _CheckTile(key: Key('check-${c.name}'), check: c, result: r, onFix: (fix) => onFix(c, fix))),
            ],
          );
        },
      ),
    );
  }
}

class _CheckTile extends StatelessWidget {
  const _CheckTile({super.key, required this.check, required this.result, required this.onFix});

  final PreflightCheck check;
  final CheckResult result;
  final ValueChanged<CheckFix> onFix;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final s = context.stateTokens;
    final text = Theme.of(context).textTheme;
    final c = switch (result.status) {
      CheckStatus.ok => s.ready,
      CheckStatus.warn => s.onBreak,
      CheckStatus.fail => s.problem,
      CheckStatus.pending => null,
    };
    final icon = switch (check) {
      PreflightCheck.microphone => Icons.mic_none,
      PreflightCheck.soundCheck => Icons.record_voice_over_outlined,
      PreflightCheck.headset => Icons.headphones,
      PreflightCheck.network => Icons.wifi,
      PreflightCheck.battery => Icons.battery_std_outlined,
      PreflightCheck.batterySaver => Icons.battery_saver_outlined,
    };
    final word = switch (result.status) {
      CheckStatus.pending => null,
      CheckStatus.ok => result.pill ?? PreflightCopy.pillOk,
      CheckStatus.warn => result.pill ?? PreflightCopy.pillCheck,
      CheckStatus.fail => result.pill ?? PreflightCopy.pillFail,
    };
    final fixLabel = switch (result.fix) {
      CheckFix.allowMicrophone => PreflightCopy.allow,
      CheckFix.openSettings => PreflightCopy.openSettings,
      CheckFix.allowBackground => PreflightCopy.allowBackground,
      CheckFix.none => null,
    };
    return DecoratedBox(
      decoration: BoxDecoration(
        color: c?.soft ?? t.bgPrimary,
        borderRadius: BorderRadius.circular(Radii.md),
        border: Border.all(color: c?.deep.withValues(alpha: 0.35) ?? t.border, width: 1.5),
      ),
      child: Padding(
        padding: const EdgeInsets.all(Space.sm),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            MergeSemantics(
              child: Semantics(
                liveRegion: result.status != CheckStatus.pending,
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    DecoratedBox(
                      decoration: BoxDecoration(color: t.bgSecondary, borderRadius: BorderRadius.circular(Radii.sm)),
                      child: SizedBox.square(dimension: 36, child: Icon(icon, color: c?.deep ?? t.textSecondary)),
                    ),
                    const SizedBox(width: Space.sm),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(result.title, style: text.titleSmall),
                          if (result.status == CheckStatus.pending)
                            Row(
                              children: [
                                SizedBox.square(dimension: 12, child: CircularProgressIndicator(strokeWidth: 2, color: t.textMuted)),
                                const SizedBox(width: Space.xs),
                                Flexible(child: Text(result.detail, style: text.bodySmall)),
                              ],
                            )
                          else ...[
                            Row(
                              children: [
                                Icon(
                                  switch (result.status) {
                                    CheckStatus.ok => Icons.check,
                                    CheckStatus.warn => Icons.error_outline,
                                    _ => Icons.close,
                                  },
                                  size: 16,
                                  color: c!.deep,
                                ),
                                const SizedBox(width: 2),
                                Flexible(child: Text(word!, style: text.labelLarge!.copyWith(color: c.deep))),
                              ],
                            ),
                            if (result.status != CheckStatus.ok || check == PreflightCheck.battery || check == PreflightCheck.network)
                              Text(result.detail, style: text.bodySmall),
                          ],
                        ],
                      ),
                    ),
                  ],
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
          PreflightCopy.elsewhereSubtitle,
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

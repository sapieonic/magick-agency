import 'dart:async';

import 'package:collection/collection.dart';
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme/app_theme.dart';
import '../../app/theme/tokens.dart';
import '../../core/softphone/softphone_view.dart';
import '../../core/station/station_view.dart';
import '../../ui/primitives.dart';
import '../station/parts/banners.dart' show BusyLabel;
import '../station/station_copy.dart';
import '../station/station_providers.dart';
import 'parts/call_controls.dart';
import 'parts/call_fields_form.dart';
import 'parts/contact_section.dart';
import 'parts/dial_pad.dart';
import 'parts/finish_notice.dart';
import 'parts/modal_guard.dart';
import 'parts/notes_section.dart';
import 'parts/number_field.dart';
import 'parts/outcome_section.dart';
import 'parts/override_sheet.dart';
import 'parts/recent_calls.dart';
import 'parts/session_cards.dart' show SessionErrorNote;
import 'parts/setup_section.dart';
import 'parts/status_band.dart';
import 'softphone_copy.dart';

/// The soft phone: dial a number, talk, save the outcome. One panel for both
/// hosts: the Phone tab (a soft-phone session) and the campaign station
/// switched to the soft phone (SP7). Only the way out differs: Close soft phone
/// on the Phone tab, Return to campaign on the station.
///
/// One scrolling column built for a phone at 360×640 and 200% text: the rail
/// pinned above, the phase's one action pinned below (Call; Hold to hang up;
/// Save outcome), everything else in between, in reading order:
///
/// * **Ready**: the number, the pad, Log to and Call from, the call details,
///   recent calls. In finish mode the notice replaces the number and the pad.
/// * **Dialing, Ringing, On call**: who is being called and from where, the
///   controls, the roster contact, the outcome (opens at the answer), the
///   notes, the call details.
/// * **Outcome needed**: the same, with the countdown to the call closing
///   without one, and Save pinned.
///
/// It reads only [softphoneViewProvider] and calls [softphoneActionsProvider].
/// It owns three things the view cannot: the double-tap guard on Call (one
/// [SoftphoneActions.dial] per press, whatever the core is doing), focus (Call
/// takes it when a redial fills the pad), and the announcements (the core's
/// [SoftphoneView.announcement], spoken assertively; the rail is the polite
/// live region).
class SoftphonePanel extends ConsumerStatefulWidget {
  const SoftphonePanel({super.key, required this.surface});

  final SoftphoneSurface surface;

  @override
  ConsumerState<SoftphonePanel> createState() => _SoftphonePanelState();
}

class _SoftphonePanelState extends ConsumerState<SoftphonePanel> {
  final _scroll = ScrollController();
  final _callFocus = FocusNode(debugLabel: 'softphone-call');
  final _callKey = GlobalKey();

  /// Set before [SoftphoneActions.dial] is called and cleared when it returns:
  /// a second tap (or the keyboard's Go on top of a tap) in the frames before
  /// the view says `placing` must not place a second call.
  bool _dialing = false;
  bool _overrideOpen = false;

  @override
  void initState() {
    super.initState();
    // A prompt already waiting when the panel appears (a rebuild of the host).
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && ref.read(softphoneViewProvider).overridePrompt != null) unawaited(_openOverride());
    });
  }

  @override
  void dispose() {
    _scroll.dispose();
    _callFocus.dispose();
    super.dispose();
  }

  Future<void> _dial() async {
    if (_dialing) return;
    final view = ref.read(softphoneViewProvider);
    if (!view.canDial || view.placing || view.finishOnly) return;
    _dialing = true;
    unawaited(HapticFeedback.mediumImpact());
    try {
      await ref.read(softphoneActionsProvider).dial();
    } finally {
      _dialing = false;
    }
  }

  Future<void> _openOverride() async {
    if (_overrideOpen) return;
    _overrideOpen = true;
    try {
      await showOverrideSheet(context);
    } finally {
      _overrideOpen = false;
    }
  }

  void _focusCall() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _callFocus.requestFocus();
      final target = _callKey.currentContext;
      if (target != null) unawaited(Scrollable.ensureVisible(target, duration: Duration.zero));
    });
  }

  @override
  Widget build(BuildContext context) {
    final phase = ref.watch(softphoneViewProvider.select((v) => v.phase));
    final callId = ref.watch(softphoneViewProvider.select((v) => v.callId));
    final finishOnly = ref.watch(softphoneViewProvider.select((v) => v.finishOnly));
    ref.listen(softphoneViewProvider.select((v) => v.focusCallToken), (prev, next) {
      if (next != prev && next > 0) _focusCall();
    });
    ref.listen(softphoneViewProvider.select((v) => v.overridePrompt != null), (prev, open) {
      if (open && prev != true) unawaited(_openOverride());
    });
    // A new call starts at the top: who is being called, not the last call's notes.
    ref.listen(softphoneViewProvider.select((v) => v.callId), (prev, next) {
      if (next != prev && _scroll.hasClients) _scroll.jumpTo(0);
    });

    final ready = phase == SoftphonePhase.ready;
    final Widget bottom;
    if (ready) {
      bottom = finishOnly ? const SizedBox.shrink() : _CallArea(onDial: _dial, focusNode: _callFocus, buttonKey: _callKey);
    } else if (phase == SoftphonePhase.outcome) {
      bottom = const OutcomeSaveArea();
    } else {
      bottom = const SoftphoneHangUp();
    }

    // Keyed on the call: a new call starts with fresh notes, fields and callback.
    final callKey = callId ?? 'idle';
    final body = <Widget>[
      _Header(surface: widget.surface),
      const _BootstrapError(),
      const _MicProblem(),
      if (ready) ..._ready(finishOnly) else ..._onCall(phase, callKey),
    ];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(width: 1, height: 1, child: _Announcer()),
        const SoftphoneStatusBand(),
        Expanded(
          child: SingleChildScrollView(
            key: const Key('softphone-scroll'),
            controller: _scroll,
            padding: const EdgeInsets.fromLTRB(Space.lg, Space.sm, Space.lg, Space.lg),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: body),
          ),
        ),
        _ActionArea(child: bottom),
      ],
    );
  }

  List<Widget> _ready(bool finishOnly) => [
    if (finishOnly) ...[
      FinishNotice(surface: widget.surface),
      const SizedBox(height: Space.lg),
    ] else ...[
      const _DialHead(),
      const SizedBox(height: Space.sm),
      NumberField(onSubmit: _dial),
      const SizedBox(height: Space.md),
      const DialPad(),
      const SizedBox(height: Space.lg),
    ],
    const SetupSection(),
    const SizedBox(height: Space.lg),
    const CallFieldsForm(key: ValueKey('fields-idle')),
    const SizedBox(height: Space.lg),
    const RecentCalls(),
  ];

  List<Widget> _onCall(SoftphonePhase phase, String callKey) => [
    const _CallingTo(),
    const SizedBox(height: Space.md),
    FinishNotice(surface: widget.surface),
    const OutcomeCountdown(),
    const SizedBox(height: Space.md),
    const SoftphoneControlRow(),
    const DncResultLine(),
    const SizedBox(height: Space.lg),
    const ContactSection(),
    const SizedBox(height: Space.lg),
    OutcomeSection(key: ValueKey('outcome-$callKey'), includeSave: phase != SoftphonePhase.outcome),
    const SizedBox(height: Space.lg),
    NotesSection(key: ValueKey('notes-$callKey')),
    const SizedBox(height: Space.lg),
    CallFieldsForm(key: ValueKey('fields-$callKey')),
    const SizedBox(height: Space.lg),
    const SetupSection(),
  ];
}

/// "Dial" and "Paste works too" over the number.
class _DialHead extends StatelessWidget {
  const _DialHead();

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Wrap(
      alignment: WrapAlignment.spaceBetween,
      crossAxisAlignment: WrapCrossAlignment.center,
      spacing: Space.sm,
      children: [
        Semantics(header: true, child: Text(SoftphoneCopy.dial, style: text.titleMedium)),
        Text(SoftphoneCopy.pasteWorks, style: text.labelSmall),
      ],
    );
  }
}

/// The title, what is disclosed (recording, muted, where the call is logged),
/// and the way out: Close soft phone on the Phone tab, Return to campaign on
/// the station, each disabled with its reason while a call is live or owed.
class _Header extends ConsumerWidget {
  const _Header({required this.surface});

  final SoftphoneSurface surface;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(
      softphoneViewProvider.select(
        (v) => (
          recording: v.recording,
          micMuted: v.micMuted && v.callLive,
          tag: v.campaigns.firstWhereOrNull((c) => c.campaignId == v.tagCampaignId)?.name,
          canClose: v.canClose,
          closeReason: v.closeBlockedReason,
          canReturn: v.canReturn,
          returnReason: v.returnBlockedReason,
          busy: v.sessionBusy,
        ),
      ),
    );
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final phone = surface == SoftphoneSurface.phone;
    final allowed = phone ? s.canClose : s.canReturn;
    final reason = allowed ? null : (phone ? s.closeReason : s.returnReason);
    final busy = s.busy == (phone ? SoftphoneSessionBusy.closing : SoftphoneSessionBusy.returning);
    final label = phone
        ? (busy ? SoftphoneCopy.closing : SoftphoneCopy.closeSoftphone)
        : (busy ? SoftphoneCopy.returning : SoftphoneCopy.returnToCampaign);

    return Padding(
      padding: const EdgeInsets.only(bottom: Space.md),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Wrap(
            alignment: WrapAlignment.spaceBetween,
            crossAxisAlignment: WrapCrossAlignment.center,
            spacing: Space.sm,
            runSpacing: Space.xs,
            children: [
              Semantics(header: true, child: Text(SoftphoneCopy.title, style: text.titleLarge)),
              // Merged, so the reason is the button's own hint, read with it.
              MergeSemantics(
                child: Semantics(
                  hint: reason,
                  child: OutlinedButton(
                    key: Key(phone ? 'softphone-close' : 'softphone-return'),
                    onPressed: !allowed || s.busy != SoftphoneSessionBusy.none
                        ? null
                        : () => phone ? _close(context, ref) : ref.read(softphoneActionsProvider).returnToCampaign(),
                    child: BusyLabel(label: label, busy: busy),
                  ),
                ),
              ),
            ],
          ),
          if (reason != null) ...[
            const SizedBox(height: Space.xs),
            Text(reason, key: const Key('softphone-exit-reason'), style: text.bodySmall),
          ],
          const SizedBox(height: Space.sm),
          Wrap(
            spacing: Space.xs,
            runSpacing: Space.xs,
            children: [
              if (s.recording)
                StatusPill(
                  SoftphoneCopy.recording,
                  key: const Key('softphone-recording'),
                  tone: Tone.danger,
                  leading: Icon(Icons.fiber_manual_record, size: 12, color: t.danger),
                ),
              if (s.micMuted)
                StatusPill(
                  SoftphoneCopy.muted,
                  key: const Key('softphone-muted'),
                  tone: Tone.warn,
                  leading: Icon(Icons.mic_off, size: 14, color: t.warning),
                ),
              StatusPill(
                SoftphoneCopy.loggingTo(s.tag),
                key: const Key('softphone-logging-to'),
                tone: s.tag == null ? Tone.neutral : Tone.accent,
              ),
            ],
          ),
          const SizedBox(height: Space.sm),
          const SessionErrorNote(),
        ],
      ),
    );
  }

  Future<void> _close(BuildContext context, WidgetRef ref) async {
    final actions = ref.read(softphoneActionsProvider);
    final ok = await softphoneConfirm(
      context,
      title: SoftphoneCopy.closeConfirmTitle,
      message: SoftphoneCopy.closeConfirmMessage,
      confirm: SoftphoneCopy.closeSoftphone,
      // A call placed while it was open makes the question wrong.
      scope: (v) => v.canClose,
    );
    if (ok) await actions.close();
  }
}

/// The bootstrap could not be read: the panel still works from the frames,
/// but the campaigns, fields and catalog may be missing until it is.
class _BootstrapError extends ConsumerWidget {
  const _BootstrapError();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final error = ref.watch(softphoneViewProvider.select((v) => v.bootstrapError));
    if (error == null) return const SizedBox.shrink();
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: Space.md),
      child: AppCard(
        key: const Key('softphone-bootstrap-error'),
        color: t.dangerSubtle,
        borderColor: t.danger.withValues(alpha: 0.4),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(SoftphoneCopy.bootstrapError(error), style: text.bodyMedium!.copyWith(color: t.danger)),
            Align(
              alignment: AlignmentDirectional.centerStart,
              child: TextButton(onPressed: () => ref.read(softphoneActionsProvider).retry(), child: const Text(SoftphoneCopy.tryAgain)),
            ),
          ],
        ),
      ),
    );
  }
}

/// "Your microphone is blocked — the customer cannot hear you": the station's
/// words, with Settings when that is the fix.
class _MicProblem extends ConsumerWidget {
  const _MicProblem();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final problem = ref.watch(softphoneViewProvider.select((v) => v.audio.micProblem));
    if (problem == MicProblem.none) return const SizedBox.shrink();
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: Space.md),
      child: Semantics(
        liveRegion: true,
        container: true,
        child: AppCard(
          key: const Key('softphone-mic-problem'),
          color: t.dangerSubtle,
          borderColor: t.danger.withValues(alpha: 0.4),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(StationCopy.micHeadline(problem), style: text.titleSmall!.copyWith(color: t.danger)),
              const SizedBox(height: 2),
              Text(StationCopy.micRemedy(problem), style: text.bodySmall),
              if (problem == MicProblem.permissionDenied)
                Align(
                  alignment: AlignmentDirectional.centerStart,
                  child: TextButton(onPressed: () => ref.read(stationOpenSettingsProvider)(), child: const Text(StationCopy.openSettings)),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Who is being called, from where, and what the line is doing.
class _CallingTo extends ConsumerWidget {
  const _CallingTo();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(
      softphoneViewProvider.select(
        (v) => (
          number: v.numberDisplay.isEmpty ? v.number : v.numberDisplay,
          name: v.contact?.displayName,
          from: v.callerIds.firstWhereOrNull((c) => c.value == v.callerId)?.label ?? v.callerId,
          phase: v.phase,
        ),
      ),
    );
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final name = s.name?.trim();
    final hasName = name != null && name.isNotEmpty;
    final status = switch (s.phase) {
      SoftphonePhase.dialing => SoftphoneCopy.statusDialing,
      SoftphonePhase.ringing => SoftphoneCopy.statusRinging,
      SoftphonePhase.onCall => SoftphoneCopy.statusConnected,
      _ => SoftphoneCopy.statusEnded,
    };
    return MergeSemantics(
      child: Column(
        key: const Key('calling-to'),
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Semantics(
            header: true,
            child: Text(
              hasName ? name : s.number,
              style: hasName ? text.headlineMedium : monoStyle(context, size: 26, color: t.textPrimary),
            ),
          ),
          if (hasName) Text(s.number, style: monoStyle(context, size: 16)),
          const SizedBox(height: Space.xs),
          Wrap(
            spacing: Space.sm,
            runSpacing: Space.xs,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              StatusPill(status, key: const Key('call-status')),
              if (s.from != null && s.from!.isNotEmpty) Text(SoftphoneCopy.from(s.from!), style: text.bodySmall),
            ],
          ),
        ],
      ),
    );
  }
}

/// Call, and why it cannot be pressed when it cannot (a bare greyed button
/// reads as broken): the last refusal first, else what is missing.
class _CallArea extends ConsumerWidget {
  const _CallArea({required this.onDial, required this.focusNode, required this.buttonKey});

  final Future<void> Function() onDial;
  final FocusNode focusNode;
  final Key buttonKey;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(
      softphoneViewProvider.select(
        (v) => (
          canDial: v.canDial,
          placing: v.placing,
          error: v.dialError,
          unavailable: v.dialUnavailableReason,
          block: v.number.isEmpty ? null : v.dialBlockReason,
        ),
      ),
    );
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final reason = s.unavailable ?? s.block;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (s.error case final error?)
          Semantics(
            liveRegion: true,
            container: true,
            child: Padding(
              padding: const EdgeInsets.only(bottom: Space.sm),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      error,
                      key: const Key('dial-error'),
                      style: text.bodySmall!.copyWith(color: t.danger),
                    ),
                  ),
                  IconButton(
                    tooltip: SoftphoneCopy.dismiss,
                    icon: Icon(Icons.close, color: t.danger),
                    onPressed: () => ref.read(softphoneActionsProvider).dismissDialError(),
                  ),
                ],
              ),
            ),
          )
        else if (reason != null)
          Padding(
            padding: const EdgeInsets.only(bottom: Space.sm),
            child: Text(reason, key: const Key('dial-reason'), style: text.bodySmall),
          ),
        Semantics(
          key: const Key('dial-call'),
          hint: s.error == null ? reason : null,
          child: FilledButton.icon(
            key: buttonKey,
            focusNode: focusNode,
            onPressed: s.canDial && !s.placing ? onDial : null,
            icon: s.placing
                ? SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2, color: t.onAccent))
                : const Icon(Icons.call),
            label: Text(s.placing ? SoftphoneCopy.calling : SoftphoneCopy.call, key: const Key('dial-call-label')),
            style: FilledButton.styleFrom(
              backgroundColor: t.emberDeep,
              foregroundColor: t.onAccent,
              disabledBackgroundColor: t.bgTertiary,
              minimumSize: const Size.fromHeight(52),
            ),
          ),
        ),
      ],
    );
  }
}

/// The pinned area under the scrolling column. Bounded, so a long refusal at
/// 200% text scrolls inside itself instead of pushing the action off screen.
class _ActionArea extends StatelessWidget {
  const _ActionArea({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return DecoratedBox(
      decoration: BoxDecoration(
        border: Border(top: BorderSide(color: t.border)),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(Space.lg, Space.md, Space.lg, Space.md),
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.4),
          child: SingleChildScrollView(reverse: true, child: child),
        ),
      ),
    );
  }
}

/// The panel's assertive channel: the core's [SoftphoneView.announcement],
/// said once per [SoftphoneView.announcementSeq] (so the same sentence twice is
/// said twice), as an assertive announcement where the platform has one and
/// in a one-pixel live region where it does not.
class _Announcer extends ConsumerStatefulWidget {
  const _Announcer();

  @override
  ConsumerState<_Announcer> createState() => _AnnouncerState();
}

class _AnnouncerState extends ConsumerState<_Announcer> {
  String _said = '';

  @override
  Widget build(BuildContext context) {
    ref.listen(softphoneViewProvider.select((v) => (seq: v.announcementSeq, text: v.announcement)), (prev, next) {
      if (next.seq == prev?.seq || next.text.isEmpty) return;
      setState(() => _said = next.text);
      if (MediaQuery.supportsAnnounceOf(context)) {
        unawaited(
          SemanticsService.sendAnnouncement(
            View.of(context),
            next.text,
            Directionality.of(context),
            assertiveness: Assertiveness.assertive,
          ),
        );
      }
    });
    return Semantics(
      key: const Key('softphone-announcer'),
      container: true,
      liveRegion: true,
      label: _said,
      child: const SizedBox.expand(),
    );
  }
}

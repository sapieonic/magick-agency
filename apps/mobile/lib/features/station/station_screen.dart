import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/softphone/softphone_view.dart';
import '../../core/station/station_view.dart';
import '../missed/rang_while_away.dart';
import '../softphone/softphone_panel.dart';
import 'parts/idle_views.dart';
import 'parts/inbound_views.dart';
import 'parts/link_screens.dart';
import 'parts/on_call_view.dart';
import 'parts/ringing_view.dart';
import 'parts/wrapup_view.dart';
import 'station_copy.dart';

/// Which whole screen the station shows. Only a change of stage swaps the
/// body; everything inside a stage updates in place from its own slice.
///
/// [softphone] is the station switched to the soft phone (SP7, the
/// `soft_phone` break): the soft-phone panel in place, on the same socket and
/// microphone, with Return to campaign as its way back. The break's own End
/// break and break menu are not offered there.
enum StationStage {
  notHere,
  fatal,
  connecting,
  superseded,
  sessionGone,
  offline,
  available,
  onBreak,
  away,
  softphone,

  /// Reserved with no call on the station yet: the server reserves the agent for an inbound
  /// caller (`agent_state: reserved`) just before the `inbound_call` frame that names them, and
  /// a reconnect's `ready` can say `reserved` before the call (inbound, or a campaign dial) is
  /// restated. A neutral screen in words that fit either direction ("A call is coming
  /// through"), not the campaign's ringing pop: there is no contact to show and no call to
  /// hang up. "Incoming call" is said only once an inbound offer is held.
  incoming,
  reserved,
  onCall,
  wrapup,

  /// An inbound caller (`docs/inbound.md` §6): offered, on the call, owing the outcome. The
  /// phase reads reserved / on a call / wrap-up for them too; these stages pick the caller's
  /// screens over the campaign call's.
  inboundOffered,
  inboundOnCall,
  inboundOutcome,
}

/// The `soft_phone` break: the station is on the soft phone.
bool onSoftphoneBreak(StationView? v) => v?.phase == AgentPhase.onBreak && v?.onBreak?.code == softphoneBreakCode;

/// The reserved break code of the soft phone (`AgencyReservedBreakCode`).
const softphoneBreakCode = 'soft_phone';

/// Pure, so the precedence is testable: a session-level failure outranks the
/// agent's phase (an agent whose station moved must not be told they are
/// waiting for a call).
StationStage stationStageOf(StationView? v, String campaignId) {
  if (v == null || v.campaignId != campaignId) return StationStage.notHere;
  if (v.fatal != null) return StationStage.fatal;
  switch (v.link) {
    case StationLink.superseded:
      return StationStage.superseded;
    case StationLink.sessionGone:
      return StationStage.sessionGone;
    case StationLink.connecting when !v.callActive:
      return StationStage.connecting;
    default:
      break;
  }
  final inbound = v.inbound;
  if (inbound != null) {
    return switch (inbound.stage) {
      InboundStage.offered => StationStage.inboundOffered,
      InboundStage.connected => StationStage.inboundOnCall,
      InboundStage.outcome => StationStage.inboundOutcome,
    };
  }
  return switch (v.phase) {
    AgentPhase.offline => StationStage.offline,
    AgentPhase.available => StationStage.available,
    AgentPhase.onBreak when onSoftphoneBreak(v) => StationStage.softphone,
    AgentPhase.onBreak => (v.onBreak?.isDeviceAway ?? false) ? StationStage.away : StationStage.onBreak,
    // The campaign's ringing pop needs its call; reserved without one is a call on its way.
    AgentPhase.reserved when v.call == null => StationStage.incoming,
    AgentPhase.reserved => StationStage.reserved,
    AgentPhase.onCall => StationStage.onCall,
    AgentPhase.wrapup => StationStage.wrapup,
  };
}

/// The station: one screen that renders the agent's phase.
///
/// It reads only [stationViewProvider] and [stationActionsProvider]. It owns
/// two things the phases share: the notes controller for the call on screen
/// (so text, cursor and keyboard survive On call → Wrap-up), and the phase
/// announcements and haptics.
class StationScreen extends ConsumerStatefulWidget {
  const StationScreen({super.key, required this.campaignId});

  final String campaignId;

  @override
  ConsumerState<StationScreen> createState() => _StationScreenState();
}

class _StationScreenState extends ConsumerState<StationScreen> {
  String? _notesFor;
  TextEditingController? _notes;

  // The outgoing call's controller lives one switch longer: the old body is
  // still on screen while the switcher fades it out.
  TextEditingController? _retired;

  TextEditingController _notesController(String? attemptId) {
    if (_notes == null || attemptId != _notesFor) {
      _retired?.dispose();
      _retired = _notes;
      _notesFor = attemptId;
      _notes = TextEditingController(text: ref.read(stationViewProvider)?.notes.text ?? '');
    }
    return _notes!;
  }

  @override
  void dispose() {
    _notes?.dispose();
    _retired?.dispose();
    super.dispose();
  }

  void _onPhase(AgentPhase? prev, AgentPhase? next) {
    if (next == prev || next == null) return;
    // Feel the call arrive and connect without looking. The ring tone itself
    // is the core's.
    if (next == AgentPhase.reserved) unawaited(HapticFeedback.heavyImpact());
    if (next == AgentPhase.onCall) unawaited(HapticFeedback.mediumImpact());
  }

  @override
  Widget build(BuildContext context) {
    final stage = ref.watch(stationViewProvider.select((v) => stationStageOf(v, widget.campaignId)));
    // The call on screen, campaign or inbound: a new call gets a new notes controller.
    final attemptId = ref.watch(stationViewProvider.select((v) => v?.callId));
    ref.listen<AgentPhase?>(stationViewProvider.select((v) => v?.phase), _onPhase);
    // Built while the station is: a return from a pause is then asked about (IQ50).
    ref.listen(rangWhileAwayProvider, (_, _) {});

    final notes = _notesController(attemptId);
    final still = MediaQuery.disableAnimationsOf(context);

    final Widget body = switch (stage) {
      StationStage.notHere => const NotHereView(),
      StationStage.fatal => const FatalView(),
      StationStage.connecting => const ConnectingView(),
      StationStage.superseded => const SupersededView(),
      StationStage.sessionGone => const SessionEndedView(),
      StationStage.offline => const OfflineView(),
      StationStage.available => const WaitingView(),
      StationStage.onBreak => const BreakView(),
      StationStage.away => const AwayView(),
      // Its own header (Return to campaign), rail, announcer and pinned action;
      // it needs the bounded height the stage gives it.
      StationStage.softphone => const SoftphonePanel(surface: SoftphoneSurface.station),
      StationStage.incoming => const IncomingView(),
      StationStage.reserved => const RingingView(),
      StationStage.onCall => OnCallView(notes: notes),
      StationStage.wrapup => WrapupPhaseView(key: ValueKey('wrapup-$attemptId'), notes: notes),
      StationStage.inboundOffered => const InboundOfferView(),
      StationStage.inboundOnCall => InboundOnCallView(notes: notes),
      StationStage.inboundOutcome => InboundOutcomeView(key: ValueKey('inbound-outcome-$attemptId'), notes: notes),
    };

    final softphoneCall = ref.watch(softphoneViewProvider.select((v) => v.callOnScreen));
    final onCall = stage == StationStage.incoming ||
        stage == StationStage.reserved ||
        stage == StationStage.onCall ||
        stage == StationStage.wrapup ||
        stage == StationStage.inboundOffered ||
        stage == StationStage.inboundOnCall ||
        stage == StationStage.inboundOutcome ||
        (stage == StationStage.softphone && softphoneCall);
    // Mid-call the system back gesture must not take the call screen away;
    // the way off it is finishing the call (a soft-phone call included, until
    // its outcome is saved).
    return PopScope(
      canPop: !onCall,
      child: Scaffold(
        body: SafeArea(
          child: Stack(
            children: [
              const Positioned(left: 0, top: 0, width: 1, height: 1, child: PhaseAnnouncer()),
              Positioned.fill(
                child: Align(
                  alignment: Alignment.topCenter,
                  // Landscape and tablets: a readable column, not a 1000 px line.
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 560),
                    child: AnimatedSwitcher(
                      duration: still ? Duration.zero : const Duration(milliseconds: 220),
                      switchInCurve: Curves.easeOutCubic,
                      switchOutCurve: Curves.easeInCubic,
                      transitionBuilder: (child, animation) => _StageTransition(animation: animation, child: child),
                      layoutBuilder: (current, previous) => Stack(fit: StackFit.expand, children: [...previous, ?current]),
                      child: KeyedSubtree(key: ValueKey(stage), child: body),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// A fade with a short rise: enough to tell the agent the screen changed
/// meaning (a call arrived, it ended) without motion for its own sake.
class _StageTransition extends StatelessWidget {
  const _StageTransition({required this.animation, required this.child});

  final Animation<double> animation;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return FadeTransition(
      opacity: animation,
      child: SlideTransition(
        position: Tween<Offset>(begin: const Offset(0, 0.02), end: Offset.zero).animate(animation),
        child: child,
      ),
    );
  }
}

/// The station's live region: a one-pixel node whose label is the phase, so
/// TalkBack and VoiceOver say "Ringing", "On call", "Wrap-up" as they happen
/// (polite). Ringing is also sent as an assertive announcement where the
/// platform supports one, because it is time-critical.
///
/// An inbound offer is said when it lands, whatever the phase did before it: the server sends
/// `agent_state: reserved` just before the `inbound_call` frame, so the phase is already
/// reserved when the caller becomes known. Reserved with no call yet says "A call is coming
/// through" (politely, once): it fits an inbound caller and a campaign dial being restated
/// after a reconnect alike, where "Ringing" for a call with nobody on it would be the wrong
/// word. The call that follows is said in its own words.
class PhaseAnnouncer extends ConsumerStatefulWidget {
  const PhaseAnnouncer({super.key});

  @override
  ConsumerState<PhaseAnnouncer> createState() => _PhaseAnnouncerState();
}

class _PhaseAnnouncerState extends ConsumerState<PhaseAnnouncer> {
  String _said = '';

  void _announce(String message, {bool assertive = false}) {
    setState(() => _said = message);
    if (assertive && MediaQuery.supportsAnnounceOf(context)) {
      unawaited(
        SemanticsService.sendAnnouncement(View.of(context), message, Directionality.of(context), assertiveness: Assertiveness.assertive),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.listen(
      stationViewProvider.select(
        (v) => (
          phase: v?.phase,
          away: v?.onBreak?.isDeviceAway ?? false,
          softphone: onSoftphoneBreak(v),
          label: v?.onBreak?.label,
          inbound: v?.inbound == null ? null : InboundCopy.who(v!.inbound!),
          callless: v?.phase == AgentPhase.reserved && v?.call == null && v?.inbound == null,
        ),
      ),
      (prev, next) {
        final phase = next.phase;
        if (phase == null) return;
        if (next.callless) {
          if (!(prev?.callless ?? false)) _announce(StationCopy.callComingThrough);
          return;
        }
        // A break switched to the soft phone (or back) stays on break: still said. Coming out of
        // reserved-with-no-call is news even when the phase stays reserved: the caller is known.
        final samePhase = prev?.phase == phase &&
            prev?.away == next.away &&
            prev?.softphone == next.softphone &&
            !(prev?.callless ?? false);
        if (samePhase) return;
        final inbound = next.inbound;
        _announce(
          inbound != null && phase == AgentPhase.reserved
              ? InboundCopy.offerAnnouncement(inbound)
              : inbound != null && phase == AgentPhase.wrapup
                  ? InboundCopy.outcomeAnnouncement
                  : StationCopy.announce(phase, breakLabel: next.label, deviceAway: next.away, softphone: next.softphone),
          assertive: phase == AgentPhase.reserved,
        );
      },
    );
    ref.listen(stationViewProvider.select((v) => v?.dispositionSaved), (prev, next) {
      if (next != null && prev == null) _announce(StationCopy.outcomeSavedAnnouncement);
    });
    return Semantics(key: const Key('phase-live-region'), container: true, liveRegion: true, label: _said, child: const SizedBox.expand());
  }
}

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/app_theme.dart';
import '../../../app/theme/tokens.dart';
import '../../../core/station/station_view.dart';
import '../../../ui/primitives.dart';
import '../logic/format.dart';
import '../station_copy.dart';
import 'banners.dart' show StationHeader, StationTopNotices;
import 'contact_details.dart';
import 'hang_up.dart';
import 'layouts.dart';

/// Reserved with no call on the station yet ([StationStage.incoming]): the server's
/// `agent_state: reserved` for an inbound caller lands a moment before the frame that names
/// them. Nothing here acts on a call (there is none yet): no Hang up, no break, no leaving.
class IncomingView extends StatelessWidget {
  const IncomingView({super.key});

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Column(
      key: const Key('station-incoming'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const StationHeader(),
        // "Your customer is waiting" and why the last call left, as on every station screen.
        const Padding(
          padding: EdgeInsets.fromLTRB(Space.lg, Space.sm, Space.lg, 0),
          child: StationTopNotices(),
        ),
        Expanded(
          child: Center(
            child: Padding(
              padding: const EdgeInsets.all(Space.lg),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const LiveDot(size: 12),
                  const SizedBox(height: Space.md),
                  Text(InboundCopy.incomingCall, style: text.titleMedium, textAlign: TextAlign.center),
                  const SizedBox(height: Space.xs),
                  Text(InboundCopy.connecting, style: text.bodyMedium, textAlign: TextAlign.center),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}

/// Reserved: the screen pop. The agent has a few seconds to read who they are
/// about to speak to, so the name is the biggest thing on screen and the
/// detail is one tap away.
class RingingView extends ConsumerWidget {
  const RingingView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // The countdown ticks in the band; without it here the pop does not
    // rebuild every second while it rings.
    final call = ref.watch(stationViewProvider.select((v) => _contactOnly(v?.call)));
    return CallLayout(
      body: [
        if (call != null && call.isRedial) ...[
          Align(
            alignment: AlignmentDirectional.centerStart,
            child: RedialTag(number: call.redialNumber!, limit: call.redialLimit),
          ),
          const SizedBox(height: Space.sm),
        ],
        if (call != null) CallHeadline(call: call),
        if (call != null) ..._details(call),
      ],
      bottom: const HangUpBar(ringing: true),
    );
  }

  List<Widget> _details(CallView call) => [
    const SizedBox(height: Space.lg),
    HeroFieldsGrid(fields: call.heroFields, configured: call.heroesConfigured),
    if (call.priorAttempts.isNotEmpty) ...[const SizedBox(height: Space.lg), PriorAttemptsCard(attempts: call.priorAttempts, limit: 3)],
    if (call.otherFields.isNotEmpty) ...[
      const SizedBox(height: Space.md),
      MoreDetails(key: ValueKey(call.attemptId), fields: call.otherFields),
    ],
  ];
}

CallView? _contactOnly(CallView? c) => c == null || c.countdownSeconds == null
    ? c
    : CallView(
        attemptId: c.attemptId,
        phoneE164: c.phoneE164,
        attemptNumber: c.attemptNumber,
        callerId: c.callerId,
        campaignName: c.campaignName,
        displayName: c.displayName,
        heroFields: c.heroFields,
        heroesConfigured: c.heroesConfigured,
        otherFields: c.otherFields,
        priorAttempts: c.priorAttempts,
        bridgedAt: c.bridgedAt,
        recording: c.recording,
        redialNumber: c.redialNumber,
        redialLimit: c.redialLimit,
      );

/// "Redial 1 of 2": this call is a wrap-up redial, the agent calling back the
/// customer they just spoke to. Shown while it rings and once connected.
class RedialTag extends StatelessWidget {
  const RedialTag({super.key, required this.number, this.limit});

  /// [CallView.redialNumber] and [CallView.redialLimit].
  final int number;
  final int? limit;

  @override
  Widget build(BuildContext context) {
    return StatusPill(
      StationCopy.redialOf(number, limit),
      key: const Key('redial-label'),
      tone: Tone.accent,
      leading: Icon(Icons.replay, size: 14, color: Tone.accent.fg(context.tokens)),
    );
  }
}

/// "Priya Raman" over "+91 98400 12345 · Attempt 2"; the number leads when
/// there is no name.
class CallHeadline extends StatelessWidget {
  const CallHeadline({super.key, required this.call, this.subtitle});

  final CallView call;

  /// Replaces the number line ("On call · 05:40 · your mic is muted").
  final Widget? subtitle;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final name = call.displayName?.trim();
    final hasName = name != null && name.isNotEmpty;
    final phone = formatPhone(call.phoneE164);
    return MergeSemantics(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Semantics(
            header: true,
            child: Text(
              hasName ? name : phone,
              key: const Key('call-headline'),
              style: hasName
                  ? text.headlineLarge
                  : monoStyle(context, size: 26, weight: FontWeight.w500, color: context.tokens.textPrimary),
            ),
          ),
          const SizedBox(height: Space.xs),
          subtitle ??
              Text(
                hasName ? '$phone · ${StationCopy.attempt(call.attemptNumber)}' : StationCopy.attempt(call.attemptNumber),
                style: monoStyle(context, size: 14),
              ),
        ],
      ),
    );
  }
}
